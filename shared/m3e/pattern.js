// Mechanics of the M3E transition patterns (spec §6): master travel, fade windows, take-over, actor
// ownership, global stop. The patterns themselves are in patterns.js (catalogue) and container.js
// (container transform).
//
// Common mechanics
// ----------------
// 1. Master travel. All the geometry of a pattern follows ONE quantity, the travel, in logical px from 0
//    to L (L = largest displacement of a visible edge between the start and end states), animated by
//    animate() with the pattern's Spatial spring on `@effects.<m3e-pattern-n>.travel` (a small render-less
//    effect put on the driver actor): 0.5 px threshold (THRESHOLDS.px) applied to the edge that moves most;
//    slow-down, unmapped actor, destruction and retargeting with velocity are those of animate().
//    u = travel / L; the geometry is a function of u (linear mix start → end for the simple patterns,
//    exact at u = 0 and 1; see containerTransform for the other one). A scale therefore does not have
//    animate()'s 0.01 threshold (8 px of jump over 800 px).
// 2. Windows (fades, masks). The fractions [a, b] of PATTERNS are measured on the SPATIAL progress of the
//    segment (patterns-source.json, _convention; MDC: getAnimatedFraction drives motion and thresholds):
//      p = clamp((u - u0) / (u_target - u0), 0, 1)   (1 if u_target = u0),
//          u0 = position at the start of the segment (currentState of the travel);
//      q = (p - a) / (b - a), clamped to [0, 1];
//      c(q) = curve of the window's spring R stretched over [0, 1]:
//             1 + state(R, -1, 0, q·T).x, T = duration(R, -1, 0, THRESHOLDS.unit),
//             c(0) = 0, c(1) = 1; without R, c(q) = q (MDC's lerp);
//      value = (1 - c)·from + c·to, `from` = value read when the segment starts:
//             continuous on retargeting.
//    R = the pattern's Effects spring for opacity, Spatial for the radius; the container transform's
//    scale mask is a lerp (MDC geometry). Windows are written before the geometry, on each write of the
//    travel. Without travel (L = 0), they are set to p = 1 immediately.
// 3. Free springs: ordinary animate() animations (exit of the fade, morph), possibly delayed (`delay`,
//    real ms) or driven by a curve.
// 4. target(direction): new segment from the current state (travel: position and velocity; windows:
//    current value) toward u = 1 ('end') or u = 0 ('start'), with the windows of the requested direction
//    ("Return" thresholds of PATTERNS for the container transform; roles swapped for the shared axis and
//    the fade through). onDone() once, when every part of the segment has finished; a taken-over segment
//    (target(), another pattern on a shared actor) has no onDone().
// 5. An actor belongs to one pattern only. A pattern started on an actor already in a running pattern
//    starts from the CURRENT values of that actor (translations, scales, opacity) instead of the pattern's
//    canonical start state, then stops the old one (without onDone): no jump of position, scale or
//    opacity (the geometry's velocity restarts at 0; only properties taken over by a free spring through
//    animate() keep theirs). A resting actor starts from the canonical state (e.g. the incoming actor
//    of the X axis at +30 px, opacity 0). Changing the pivot of a scaled actor compensates the
//    translation (no visible shift). Exception: containerTransform always starts from the bounds of
//    `source` (for a return, use target('start') of the same pattern). A competing pattern that holds
//    resources (containerTransform: effect m3e-corners, clone, hidden source) is stopped BEFORE the new
//    one is activated, which therefore restarts from a clean corners effect (its own); the others are
//    stopped after the new animations have started (take-over with velocity).
//    A property has one owner: a separate animate() on a property driven by a pattern (opacity,
//    translation…) fights with it.
// 6. Destroyed actor: the pattern stops for good, without onDone or error. Surviving actors (other actor
//    of a shared axis or fade through) are set to the segment's target (windows at p = 1, geometry at
//    u_target, free animations finished), the driver effect is removed from the driver if it survives.
// 7. Hidden source (containerTransform, hideSource): counted per actor; the first pattern hides it and
//    notes its opacity, the last one restores it.
//
// Assumptions: the parent of the container transform destination has no scale (parent px = scene px).
// The pivot set by a pattern stays after it.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {animate, currentState, _registerStop} from './animate.js';
import {duration, progress} from './spring.js';
import {THRESHOLDS} from './tokens.js';

// Pivot at the centre (0.5 in Clutter's normalised coordinates): geometry of the actor, not a pattern
// parameter; the only constant outside PATTERNS (with 0, 1, 255).
export const CENTER = 0.5;

const typeName = base => `${base}_${import.meta.url.replace(/[^A-Za-z0-9]/g, '_')}`;

// Render-less effect carrying the master travel; every write notifies the pattern.
const PatternDriver = GObject.registerClass({GTypeName: typeName('M3ePatternDriver')},
class PatternDriver extends Clutter.Effect {
    get travel() {
        return this._travel ?? 0;
    }

    set travel(v) {
        this._travel = v;
        this.callback?.(v);
    }
});

// --- helpers -------------------------------------------------------------------------

export const mix = (a, b, u) => (1 - u) * a + u * b;

function windowCurve(spring, q) {
    if (q <= 0)
        return 0;
    if (q >= 1)
        return 1;
    if (!spring)
        return q;
    return progress(spring, -1, 0, q * duration(spring, -1, 0, THRESHOLDS.unit));
}

// Curve of a fade or mask window (rule 2) for a spatial progress p of a segment: 0 before `start`, 1 after
// `end`, the spring's curve (or linear without spring) in between. Exported for choreographies whose
// progress is driven elsewhere than in a pattern (overview, C).
export function windowProgress(p, {start, end}, spring = null) {
    const q = p >= end ? 1 : p <= start ? 0 : (p - start) / (end - start);
    return windowCurve(spring, q);
}

function windowValue(w, p) {
    const c = windowProgress(p, w.thresholds, w.spring);
    return (1 - c) * w.from + c * w.to;
}

function writeOpacity(actor, v) {
    actor.opacity = Math.round(Math.min(255, Math.max(0, v)));
}

// Opacity window.
export const opacityWindow = (actor, to, thresholds, spring) => ({
    actor, read: () => actor.opacity, write: v => writeOpacity(actor, v), to, thresholds, spring,
});

const owners = new Map(); // actor → Pattern
const active = new Set(); // active patterns (between _activate and _deactivate), for stopAll()

// Actor currently driven by a pattern: start from its current values.
export const isMoving = actor => owners.get(actor)?.running === true;

// Pivot changed without moving the actor on screen (translation compensated).
export function setPivot(actor, px, py) {
    const {x: ax, y: ay} = actor.pivot_point;
    if (ax === px && ay === py)
        return;
    actor.translation_x += (ax - px) * actor.width * (1 - actor.scale_x);
    actor.translation_y += (ay - py) * actor.height * (1 - actor.scale_y);
    actor.set_pivot_point(px, py);
}

const PROPS = ['translation_x', 'translation_y', 'scale_x', 'scale_y'];
const REST = {translation_x: 0, translation_y: 0, scale_x: 1, scale_y: 1};

// Edges [left, top, right, bottom] (parent space) of a state, actor pivot.
function edges(actor, s) {
    const {x: px, y: py} = actor.pivot_point;
    const w = actor.width, h = actor.height;
    const left = actor.x + s.translation_x + px * w * (1 - s.scale_x);
    const top = actor.y + s.translation_y + py * h * (1 - s.scale_y);
    return [left, top, left + w * s.scale_x, top + h * s.scale_y];
}

export const edgeGap = (a, b) => Math.max(...a.map((v, i) => Math.abs(b[i] - v)));

export const rectEdges = r => [r.x, r.y, r.x + r.w, r.y + r.h];

export const ORIGIN = Object.freeze({x: 0, y: 0});

// Linear geometry of actors: [{actor, from: {prop: v}, to: {prop: v}}]. Start: current value if the actor
// is moving or if `from` does not give the property, else the canonical value of `from`; end: `to`, else
// rest. Returns {write(u), length}.
export function linear(list) {
    const tracks = list.map(({actor, from = {}, to = {}}) => {
        const moving = isMoving(actor);
        const s0 = {}, s1 = {};
        for (const p of PROPS) {
            s0[p] = moving || !(p in from) ? actor[p] : from[p];
            s1[p] = to[p] ?? REST[p];
        }
        return {actor, s0, s1};
    });
    let length = 0;
    for (const {actor, s0, s1} of tracks)
        length = Math.max(length, edgeGap(edges(actor, s0), edges(actor, s1)));
    return {
        length,
        // `dead`: destroyed actors, left aside.
        write: (u, dead = null) => {
            for (const {actor, s0, s1} of tracks) {
                if (dead?.has(actor))
                    continue;
                for (const p of PROPS) {
                    if (s0[p] !== s1[p] || actor[p] !== s0[p])
                        actor[p] = mix(s0[p], s1[p], u);
                }
            }
        },
    };
}

// --- Pattern ---------------------------------------------------------------------

let counter = 0;

export class Pattern {
    constructor({actors, driver = null, spring = null, geometry = null, windows = {}, free = {},
        prepare = null, release = null, onDone = null}) {
        this._actors = [...new Set(actors)];
        this._geometry = geometry; // {write(u), length} or null
        this._length = geometry?.length ?? 0;
        this._driver = driver && this._length > 0 ? driver : null;
        this._spring = spring;
        this._windows = windows;
        this._free = free;
        this._prepare = prepare;
        this._release = release;
        this._onDone = onDone;
        this._name = `m3e-pattern-${++counter}`;
        this._path = `@effects.${this._name}.travel`;
        this._travel = 0;
        this._effect = null;
        this._segment = null;
        this._previous = null;
        this._active = false;
        this._dead = false;
        this._ids = [];
        this._idle = 0;
    }

    get running() {
        return !this._dead && this._segment !== null && !this._segment.done;
    }

    target(direction, {onDone} = {}) {
        if (direction !== 'end' && direction !== 'start')
            throw new Error(`unknown pattern target: ${direction}`);
        if (this._dead)
            return this;
        if (onDone !== undefined)
            this._onDone = onDone;
        const old = this._segment;
        const wasActive = this._active;
        // A competing pattern holding resources on a shared actor (containerTransform: m3e-corners
        // effect, clone, hidden source) is stopped BEFORE our activation: its release would otherwise
        // remove the effect our prepare just adopted. The other competitors are only stopped after our
        // animations started (take-over of their properties with velocity, below).
        if (!wasActive) {
            for (const a of this._actors) {
                const other = owners.get(a);
                if (other && other !== this && other._release)
                    other.stop();
            }
        }
        this._activate();
        // (Re)activation: geometry written right away at the current position (start state at the
        // first launch; clone recreated in the right place).
        if (!wasActive)
            this._geometry?.write(this._length > 0 ? this._travel / this._length : 0);
        const uTarget = direction === 'end' ? 1 : 0;
        // u0: current position of the travel (currentState if a track drives it).
        const current = this._driver ? currentState(this._driver, this._path) : null;
        const u0 = this._length > 0 ? (current?.value ?? this._travel) / this._length : uTarget;
        const seg = {direction, u0, uTarget, waiting: 0, master: null, free: [], done: false};
        this._segment = seg; // the old segment becomes mute
        this._cancelIdle();
        seg.windows = (this._windows[direction] ?? []).map(w => ({...w, from: w.read()}));
        if (this._driver) {
            seg.waiting++;
            seg.master = animate(this._driver, {[this._path]: uTarget * this._length},
                {spring: this._spring, onDone: () => this._partDone(seg)});
        } else {
            this._writeWindows(seg, 1);
        }
        for (const f of this._free[direction] ?? []) {
            seg.waiting++;
            const anim = animate(f.actor, f.targets,
                {spring: f.spring, delay: f.delay ?? 0, onDone: () => this._partDone(seg)});
            seg.free.push({anim, actor: f.actor, prop: Object.keys(f.targets)[0]});
        }
        // Taken-over properties have left the old animations: what remains of the old segment and of the
        // competing patterns can be stopped.
        if (old)
            this._stopSegment(old);
        for (const a of this._actors) {
            const other = owners.get(a);
            if (other && other !== this)
                other.stop();
            owners.set(a, this);
        }
        if (seg.waiting === 0) {
            this._idle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._idle = 0;
                this._endSegment(seg);
                return GLib.SOURCE_REMOVE;
            });
        }
        return this;
    }

    // Stops in place, without onDone.
    stop() {
        const seg = this._segment;
        this._segment = null;
        this._cancelIdle();
        if (seg) {
            this._previous = seg;
            this._stopSegment(seg);
        }
        this._deactivate(null);
    }

    // Jumps to the end of the current segment and calls onDone.
    finish() {
        const seg = this._segment;
        if (this._dead || !seg || seg.done)
            return;
        if (seg.waiting === 0) {
            this._cancelIdle();
            this._endSegment(seg);
            return;
        }
        seg.master?.finish();
        for (const f of seg.free)
            f.anim.finish();
    }

    // Timing of the timeline driving the segment (travel, else first free animation):
    // {elapsed, duration, done} in real ms (slow-down included), like Animation.timing; after the end or
    // the stop, the last timing; {0, 0, true} if nothing.
    timing() {
        const seg = this._segment ?? this._previous;
        if (seg?.master)
            return seg.master.timing(this._path);
        const f = seg?.free[0];
        return f ? f.anim.timing(f.prop) : {elapsed: 0, duration: 0, done: true};
    }

    // --- internal ---

    _activate() {
        if (this._active)
            return;
        this._active = true;
        active.add(this);
        for (const a of this._actors)
            this._ids.push([a, a.connect('destroy', () => this._destroyed(a))]);
        try {
            this._prepare?.();
            if (this._driver) {
                const effect = new PatternDriver();
                effect.travel = this._travel;
                effect.callback = v => this._frame(v);
                this._driver.add_effect_with_name(this._name, effect);
                this._effect = effect;
            }
        } catch (e) {
            // Half-activated: give back what was taken (signals, ownership) before reporting.
            this._deactivate(null);
            throw e;
        }
    }

    // `dead`: actor of the pattern being destroyed (null otherwise).
    _deactivate(dead) {
        if (!this._active)
            return;
        this._active = false;
        active.delete(this);
        for (const [a, id] of this._ids) {
            if (owners.get(a) === this)
                owners.delete(a);
            a.disconnect(id);
        }
        this._ids = [];
        if (this._effect) {
            this._effect.callback = null;
            // The driver effect leaves with the driver if it dies; otherwise we remove it.
            if (this._driver !== dead)
                this._driver.remove_effect(this._effect);
            this._effect = null;
        }
        this._release?.(dead !== null);
    }

    _stopSegment(seg) {
        seg.master?.stop();
        for (const f of seg.free)
            f.anim.stop();
    }

    _cancelIdle() {
        if (this._idle)
            GLib.source_remove(this._idle);
        this._idle = 0;
    }

    // An actor of the pattern is destroyed (`dead`). The pattern stops for good, without onDone (like
    // animate()). Surviving actors do not stay frozen half-way: windows set to p = 1 and geometry to the
    // segment's target (u_target), free animations of their properties finished (without the pattern's
    // onDone); the driver effect is removed from the driver if it survives.
    _destroyed(dead) {
        if (this._dead)
            return;
        this._dead = true;
        const seg = this._segment;
        this._segment = null;
        this._previous = seg;
        this._cancelIdle();
        if (seg) {
            const deadSet = new Set([dead]);
            seg.master?.stop();
            for (const f of seg.free) {
                if (f.actor === dead)
                    f.anim.stop();
                else
                    f.anim.finish(); // part's onDone ignored: mute segment
            }
            if (this._actors.some(a => a !== dead)) {
                this._writeWindows(seg, 1, deadSet);
                if (this._length > 0)
                    this._geometry.write(seg.uTarget, deadSet);
            }
        }
        this._deactivate(dead);
    }

    _writeWindows(seg, p, dead = null) {
        for (const w of seg.windows) {
            if (!dead?.has(w.actor))
                w.write(windowValue(w, p));
        }
    }

    // Travel written by animate() (once per frame, or value set).
    _frame(travel) {
        this._travel = travel;
        const seg = this._segment;
        if (!seg || seg.done || this._dead)
            return;
        const u = travel / this._length;
        const p = seg.uTarget === seg.u0 ? 1
            : Math.min(1, Math.max(0, (u - seg.u0) / (seg.uTarget - seg.u0)));
        this._writeWindows(seg, p);
        this._geometry.write(u);
    }

    _partDone(seg) {
        if (seg !== this._segment || seg.done || this._dead)
            return;
        if (--seg.waiting > 0)
            return;
        this._endSegment(seg);
    }

    _endSegment(seg) {
        if (seg !== this._segment || seg.done || this._dead)
            return;
        seg.done = true;
        this._writeWindows(seg, 1);
        if (this._length > 0)
            this._geometry.write(seg.uTarget);
        this._deactivate(null);
        try {
            this._onDone?.();
        } catch (e) {
            console.error(`m3e patterns: onDone() failed: ${e.message}\n${e.stack}`);
        }
    }
}

// stopAll() (animate.js) stops the patterns first: stop() without onDone, hidden sources restored,
// m3e-corners effects added by a container transform removed (except keepCorners: a kept effect stays,
// as at a normal end), driver effects removed, clones destroyed. Their animations are stopped with them.
_registerStop(() => {
    for (const p of [...active])
        p.stop();
});

// Diagnostics for the bench: active patterns, owned actors.
export function _diagnosticPatterns() {
    return {patterns: active.size, owners: owners.size};
}
