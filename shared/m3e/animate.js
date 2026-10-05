// M3E spring animations for the Shell.
//
// Single "frame" driver: under GJS 1.88 the return value of Timeline.set_progress_func is lost, so a
// PropertyTransition cannot follow a spring. Every animated property has its own Clutter.Timeline
// attached to the actor (hence to the clock of its monitor); on each frame, `new-frame` writes
// target + state(spring, x0, v0, t).x.
//
//   animate(actor, {prop: value}, {spring, delay, onDone, threshold}) → Animation
//   release(actor, prop, target, velocity, spring)                    → Animation
//   currentState(actor, prop)                                         → {value, velocity} | null
//   stopAll()                                                         → stops everything (disable())
//   virtualProperty(actor, name, {read, write})                       → '@v.<name>'
//   removeProperty(actor, name)
//
// Virtual property: a quantity that is not an actor property (value of a St.Adjustment, progress of a
// state…), read and written by two functions, animated on the clock of `actor` like an ordinary property:
//   animate(actor, {[virtualProperty(actor, 'state', {read, write})]: 1}).
// `threshold` option of animate() / release(): visibility threshold in the units of the property (number,
// or {prop: threshold}); by default the one of _thresholdFor() (0.5 px for an unknown or virtual property).
//
// Velocities are in property units per second of spring time (real time / slow-down-factor; identical to
// real time when the factor is 1). A property belongs to one animation only: a new animate() on the same
// property of the same actor takes it over (retargeting, without onDone for the old animation).
//
// Curves: `spring` may also be {curve, duration} (curve = name of CURVES in tokens.js, duration in ms of
// animation time, slow-down applied): same API, same take-over; a resumed curve restarts from the displayed
// value, a spring taking over a curve keeps its displayed velocity.

// Tracks (one property, one spring or curve segment) are in track.js.

import GLib from 'gi://GLib';

import {Track, normalize, isColor} from './track.js';
import {isCurve} from './curve.js';
import {SPRINGS} from './tokens.js';

export {virtualProperty, removeProperty, _thresholdFor, _plan} from './track.js';

// Spring of a property: full name, per-property name, or family 'Default'|'Fast'|'Slow' completed to
// Spatial/Effects depending on the property. Colours take an Effects spring of the family; a name outside
// the families (Android springs: ComposeSpringDefault…) and a fixed-duration curve ({curve, duration},
// curve.js) apply to any property.
const isTable = r => r && typeof r === 'object' && !('stiffness' in r) && !isCurve(r);
const outsideFamily = r => r in SPRINGS && !/(Spatial|Effects)$/.test(r);

export function _springFor(prop, spring) {
    let r = spring;
    if (isTable(r))
        r = r[prop] ?? r[normalize(prop)] ?? 'Default';
    if (typeof r !== 'string')
        return r;
    if (outsideFamily(r))
        return r;
    const family = r.replace(/(Spatial|Effects)$/, '');
    if (isColor(prop))
        return `${family}Effects` in SPRINGS ? `${family}Effects` : 'DefaultEffects';
    if (r in SPRINGS)
        return r;
    // Spatial: x, y, sizes, translations, scales, rotations, radius, effects; Effects: opacity
    // (colours are handled above).
    const name = `${family}${normalize(prop) === 'opacity' ? 'Effects' : 'Spatial'}`;
    if (!(name in SPRINGS))
        throw new Error(`unknown spring: ${spring}`);
    return name;
}

// --- registry: actor → {tracks: Map<prop, Track>, destroyId} -----------------

const registry = new Map();

// Animations whose onDone waits for an idle (values written without a timeline): actor → Set<Animation>.
// A property taken over by another animation cancels this onDone (like a running track).
const pendingDone = new Map();

function entry(actor, create) {
    let e = registry.get(actor);
    if (!e && create) {
        e = {tracks: new Map(), destroyId: 0};
        e.destroyId = actor.connect('destroy', () => destroyed(actor));
        registry.set(actor, e);
    }
    return e;
}

function forget(actor, prop, track) {
    const e = registry.get(actor);
    if (!e || e.tracks.get(prop) !== track)
        return;
    e.tracks.delete(prop);
    if (e.tracks.size === 0) {
        actor.disconnect(e.destroyId);
        registry.delete(actor);
    }
}

// Actor destroyed: timelines stopped, state removed, no onDone.
function destroyed(actor) {
    const e = registry.get(actor);
    registry.delete(actor);
    for (const track of e?.tracks.values() ?? []) {
        track.stop();
        track.animation._lost(track, true);
    }
}

// --- Animation ---------------------------------------------------------------

class Animation {
    constructor(actor, options = {}) {
        this._actor = actor;
        this._spring = options.spring ?? 'Default';
        this._delay = options.delay ?? 0;
        this._onDone = options.onDone ?? null;
        this._threshold = options.threshold ?? null;
        this._tracks = new Map();
        this._destroyed = false;
        this._pendingIdle = 0;
        this._destroyIdWhilePending = 0;
        this._lastTimings = new Map(); // last timing of removed tracks (bench)
        this._settledProps = new Set(); // props written immediately whose onDone waits for the idle
    }

    get running() {
        for (const t of this._tracks.values()) {
            if (!t.done)
                return true;
        }
        return false;
    }

    // Retargets (or adds) properties keeping position and velocity.
    retarget(targets, delay = 0) {
        if (this._destroyed)
            return this;
        for (const [prop, value] of Object.entries(targets)) {
            const track = this._take(prop);
            const {value: current, velocity} = track.state();
            track.start(current, velocity, value, delay);
        }
        this._afterStart();
        return this;
    }

    // Stops in place, without onDone.
    stop() {
        for (const t of this._tracks.values()) {
            t.stop();
            t.done = true;
            forget(this._actor, t.prop, t);
        }
        this._tracks.clear();
        this._cancelPending();
    }

    // Jumps to the end and calls onDone.
    finish() {
        if (this._destroyed)
            return;
        // Running tracks, or an onDone already due (values written, idle pending).
        const had = this._tracks.size > 0 || this._pendingIdle !== 0;
        for (const t of this._tracks.values()) {
            t.stop();
            t.finish();
            forget(this._actor, t.prop, t);
        }
        this._tracks.clear();
        this._cancelPending();
        if (had)
            this._callOnDone();
    }

    // Timing of the timeline driving `prop`: {elapsed, duration, done}, in real ms (slow-down
    // included); after the end, the last timing; {0, 0, true} if nothing.
    timing(prop) {
        const p = normalize(prop);
        return this._tracks.get(p)?.timing() ?? this._lastTimings.get(p) ?? {elapsed: 0, duration: 0, done: true};
    }

    // Track of `prop` for this animation; takes over the one of another animation (its state is the
    // starting point, no onDone for the old one).
    _take(rawProp) {
        const prop = normalize(rawProp);
        // Another animation wrote this property and waits for its idle: its onDone will not happen,
        // the property changes hands.
        for (const other of [...pendingDone.get(this._actor) ?? []]) {
            if (other !== this && other._settledProps.has(prop))
                other._cancelPending();
        }
        let track = this._tracks.get(prop);
        if (track)
            return track;
        const e = entry(this._actor, true);
        const previous = e.tracks.get(prop);
        track = new Track(this, this._actor, prop, _springFor(prop, this._spring), this._threshold);
        if (previous) {
            const s = previous.state();
            previous.stop();
            previous.animation._lost(previous, false);
            // Start from the state of the previous track.
            track.resume = s;
        }
        e.tracks.set(prop, track);
        this._tracks.set(prop, track);
        return track;
    }

    // Track removed from outside: taken over by another animation, or actor destroyed.
    _lost(track, actorDestroyed) {
        if (this._tracks.get(track.prop) === track)
            this._tracks.delete(track.prop);
        if (actorDestroyed) {
            this._destroyed = true;
            for (const t of this._tracks.values())
                t.stop();
            this._tracks.clear();
            this._cancelPending();
        }
    }

    // After a (re)start: tracks written immediately are removed; if nothing is left running, onDone
    // goes out in an idle (like ease()).
    _afterStart() {
        for (const t of [...this._tracks.values()]) {
            if (t.done) {
                forget(this._actor, t.prop, t);
                this._tracks.delete(t.prop);
                this._settledProps.add(t.prop);
            }
        }
        if (this._tracks.size > 0)
            this._cancelPending();
        else
            this._doneLater();
    }

    _trackDone(track) {
        this._lastTimings.set(track.prop, track.timing());
        forget(this._actor, track.prop, track);
        this._tracks.delete(track.prop);
        if (this._tracks.size === 0)
            this._callOnDone();
    }

    // Asynchronous end (idle). The actor is no longer followed by the registry: a dedicated 'destroy'
    // handler prevents onDone on a dead actor.
    _doneLater() {
        if (this._pendingIdle)
            return;
        let waiting = pendingDone.get(this._actor);
        if (!waiting)
            pendingDone.set(this._actor, waiting = new Set());
        waiting.add(this);
        this._destroyIdWhilePending = this._actor.connect('destroy', () => {
            this._destroyIdWhilePending = 0; // already disconnected by the destruction
            this._destroyed = true;
            this._cancelPending();
        });
        this._pendingIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._pendingIdle = 0;
            this._leavePending();
            if (!this._destroyed && this._tracks.size === 0)
                this._callOnDone();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Leaving the idle wait: 'destroy' handler and registration removed.
    _leavePending() {
        if (this._destroyIdWhilePending)
            this._actor.disconnect(this._destroyIdWhilePending);
        this._destroyIdWhilePending = 0;
        this._settledProps.clear();
        const waiting = pendingDone.get(this._actor);
        if (waiting?.delete(this) && waiting.size === 0)
            pendingDone.delete(this._actor);
    }

    _cancelPending() {
        if (this._pendingIdle)
            GLib.source_remove(this._pendingIdle);
        this._pendingIdle = 0;
        this._leavePending();
    }

    _callOnDone() {
        if (this._destroyed)
            return;
        try {
            this._onDone?.();
        } catch (e) {
            console.error(`m3e animate: onDone() failed: ${e.message}\n${e.stack}`);
        }
    }
}

// --- API -----------------------------------------------------------------------

export function animate(actor, targets, options = {}) {
    const anim = new Animation(actor, options);
    return anim.retarget(targets, anim._delay);
}

// End of a gesture: starts from the current position with the finger velocity.
// `options` (optional): {threshold, onDone}, like animate().
export function release(actor, prop, target, velocity, spring, options = {}) {
    const anim = new Animation(actor, {...options, spring});
    const track = anim._take(prop);
    track.start(track.state().value, velocity, target, 0);
    anim._afterStart();
    return anim;
}

export function currentState(actor, prop) {
    const track = registry.get(actor)?.tracks.get(normalize(prop));
    if (!track || track.done)
        return null;
    return track.state();
}

// Stops registered by other toolkit modules (pattern.js), played first by stopAll(): a pattern releases
// its resources (hidden source, effects, clone).
const stops = new Set();

export function _registerStop(callback) {
    stops.add(callback);
}

// Single entry point for an extension's disable() (or a screen lock): stops ALL patterns (if
// pattern.js is loaded) then all animations of the toolkit, pending onDone included, without calling any
// onDone. Values stay where they are; the registries are empty afterwards.
// Scope: the copy of m3e/ embedded in the extension that calls it (each extension has its own).
export function stopAll() {
    for (const callback of stops) {
        try {
            callback();
        } catch (e) {
            console.error(`m3e animate: stopAll() callback failed: ${e.message}\n${e.stack}`);
        }
    }
    const animations = new Set();
    for (const e of registry.values()) {
        for (const track of e.tracks.values())
            animations.add(track.animation);
    }
    for (const waiting of pendingDone.values()) {
        for (const anim of waiting)
            animations.add(anim);
    }
    for (const anim of animations)
        anim.stop();
}

// Diagnostics for the bench: followed actors and tracks.
export function _diagnostic() {
    let tracks = 0;
    for (const e of registry.values())
        tracks += e.tracks.size;
    let pending = 0;
    for (const a of pendingDone.values())
        pending += a.size;
    return {actors: registry.size, tracks, pendingDone: pending};
}
