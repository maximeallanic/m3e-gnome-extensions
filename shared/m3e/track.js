// Animation track: one property of one actor, one segment driven frame by frame (a Clutter.Timeline attached
// to the actor, `new-frame` → value written), by a spring (spring.js) or by a fixed-duration curve (curve.js).
// Split from animate.js (registry, Animation, API) when the Android curves were added.
//
// Property access: actor properties, `@effects.<name>.<prop>`, virtual properties `@v.<name>`
// (virtualProperty), colours (progress clamped to [0, 1] and blended between two Cogl.Color).
// Curve: starts from the displayed value, without velocity (like a resumed Android ValueAnimator); its
// instantaneous velocity is returned by state(), so a spring taking over a curve keeps the displayed velocity.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import St from 'gi://St';

import {state, duration} from './spring.js';
import {isCurve, curveState} from './curve.js';
import {THRESHOLDS} from './tokens.js';

const EFFECT = /^@effects\.([^.]+)\.(.+)$/;
const VIRTUAL = /^@v\.(.+)$/;
const COLOR = /(^|_)colou?r$/;

// '@…' paths (effects, virtual properties) are kept as they are.
export const normalize = prop => prop.startsWith('@') ? prop : prop.replace(/-/g, '_');
export const isColor = prop => !prop.startsWith('@') && COLOR.test(normalize(prop));

// Virtual properties: actor → Map<name, {read, write}>.
const virtuals = new WeakMap();

export function virtualProperty(actor, name, {read, write}) {
    if (typeof read !== 'function' || typeof write !== 'function')
        throw new Error('virtualProperty: read and write expected');
    let m = virtuals.get(actor);
    if (!m)
        virtuals.set(actor, m = new Map());
    m.set(name, {read, write});
    return `@v.${name}`;
}

// Removes the property; an animation still running on it keeps writing into the void (neutral
// access): stop it first if needed.
export function removeProperty(actor, name) {
    virtuals.get(actor)?.delete(name);
}

// Threshold of a property for an animation: the `threshold` option (number or table), else _thresholdFor().
export function thresholdOption(prop, threshold) {
    if (typeof threshold === 'number')
        return threshold;
    if (threshold && typeof threshold === 'object') {
        const t = threshold[prop] ?? threshold[normalize(prop)];
        if (typeof t === 'number')
            return t;
    }
    return _thresholdFor(prop);
}

// Visibility threshold of a property (in its own units).
export function _thresholdFor(prop) {
    const p = normalize(prop);
    if (EFFECT.test(p))
        return THRESHOLDS.px;
    if (p === 'opacity')
        return THRESHOLDS.unit * 255;
    if (/^scale_/.test(p))
        return THRESHOLDS.unit;
    if (/^rotation_angle_/.test(p))
        return THRESHOLDS.degree;
    if (isColor(p))
        return THRESHOLDS.unit; // normalised progress
    return THRESHOLDS.px;
}

// Pure planning: 'frame' driver if the spring has something to do (distance above the threshold or
// non-zero velocity), else 'none'.
export function _plan(current, velocity, target, spring, threshold) {
    const x0 = current - target;
    const v0 = velocity;
    if (!Number.isFinite(x0) || !Number.isFinite(v0))
        return {driver: 'none', x0: 0, v0: 0, durationMs: 0};
    const durationMs = duration(spring, x0, v0, threshold);
    if (!(durationMs > 0) || !Number.isFinite(durationMs))
        return {driver: 'none', x0, v0, durationMs: 0};
    return {driver: 'frame', x0, v0, durationMs};
}

// --- property access ----------------------------------------------------------

function accessors(actor, prop) {
    const virtual = VIRTUAL.exec(prop);
    if (virtual) {
        const name = virtual[1];
        const entry = () => virtuals.get(actor)?.get(name);
        return {
            read: () => entry()?.read() ?? 0,
            write: x => entry()?.write(x),
        };
    }
    const m = EFFECT.exec(prop);
    if (m) {
        const [, name, field] = m;
        return {
            read: () => actor.get_effect(name)?.[field] ?? 0,
            write: v => {
                const e = actor.get_effect(name);
                if (e)
                    e[field] = v;
            },
        };
    }
    const p = normalize(prop);
    if (p === 'opacity') {
        return {
            read: () => actor.opacity,
            write: v => { actor.opacity = Math.round(Math.min(255, Math.max(0, v))); },
        };
    }
    return {read: () => actor[p], write: v => { actor[p] = v; }};
}

function toColor(v) {
    if (typeof v === 'string') {
        const [ok, c] = Cogl.Color.from_string(v);
        if (!ok)
            throw new Error(`invalid colour: ${v}`);
        return c;
    }
    return v;
}

const components = c => [c.red, c.green, c.blue, c.alpha];

function blend(from, to, p) {
    const q = Math.min(1, Math.max(0, p));
    const target = components(to);
    const [r, g, b, a] = components(from).map((v, i) => Math.round(v + (target[i] - v) * q));
    return new Cogl.Color({red: r, green: g, blue: b, alpha: a});
}

function slowDownFactor() {
    const f = St.Settings.get().slow_down_factor;
    return f > 0 ? f : 1;
}

const animationsAllowed = actor =>
    St.Settings.get().enable_animations && actor.mapped;

// Motion of a track: spring (name or {stiffness, damping}) or curve ({curve, duration}).
function motionState(m, x0, v0, tMs) {
    return isCurve(m) ? curveState(m, x0, tMs) : state(m, x0, v0, tMs);
}

// Plan of a fixed-duration segment: nothing to do under the threshold (the start velocity is ignored, like
// a resumed Android ValueAnimator).
function planCurve(current, target, m, threshold) {
    const x0 = current - target;
    if (!Number.isFinite(x0) || Math.abs(x0) <= threshold || !(m.duration > 0))
        return {driver: 'none', x0: 0, v0: 0, durationMs: 0};
    return {driver: 'frame', x0, v0: 0, durationMs: m.duration};
}

// --- track: one property of an actor, one spring or curve segment --------------

export class Track {
    constructor(animation, actor, prop, spring, threshold) {
        this.animation = animation;
        this.actor = actor;
        this.prop = prop;
        this.spring = spring;
        this.threshold = thresholdOption(prop, threshold);
        this.isColor = isColor(prop);
        this.access = accessors(actor, prop);
        this.timeline = null;
        this.done = true;
        this.resume = null; // state taken over from another animation
        this.target = undefined;
        this.last = null;
        this.x0 = 0;
        this.v0 = 0;
        this.factor = 1;
    }

    // {value, velocity} at the last elapsed time of the timeline (or read from the actor).
    state() {
        if (this.resume) {
            const d = this.resume;
            this.resume = null;
            return d;
        }
        if (this.isColor)
            return {value: this.access.read(), velocity: 0};
        if (!this.timeline || this.done) {
            return {value: this.done && this.timeline === null && this.target !== undefined
                ? this.target : this.access.read(), velocity: 0};
        }
        const s = motionState(this.spring, this.x0, this.v0, this.timeline.get_elapsed_time() / this.factor);
        return {value: this.target + s.x, velocity: s.v};
    }

    // Starts a segment from {current, velocity} toward `target`. Returns false if there is nothing
    // to animate (final value written).
    start(current, velocity, target, delay) {
        this.stop();
        this.last = null;
        this.target = target;
        this.done = false;
        if (this.isColor)
            return this._startColor(current, toColor(target), delay);
        const plan = isCurve(this.spring) ? planCurve(current, target, this.spring, this.threshold)
            : _plan(current, velocity, target, this.spring, this.threshold);
        if (plan.driver === 'none' || !animationsAllowed(this.actor)) {
            this.finish();
            return false;
        }
        this.x0 = plan.x0;
        this.v0 = plan.v0;
        this.factor = slowDownFactor();
        this._begin(Math.max(1, Math.round(plan.durationMs * this.factor)), delay, elapsed => {
            const s = motionState(this.spring, this.x0, this.v0, elapsed / this.factor);
            this.access.write(this.target + s.x);
        });
        return true;
    }

    // Colour: progress clamped to [0, 1] of an Effects spring (x0 = -1) or of a curve.
    _startColor(from, to, delay) {
        this.target = to;
        const plan = isCurve(this.spring) ? planCurve(0, 1, this.spring, this.threshold)
            : _plan(0, 0, 1, this.spring, this.threshold);
        const same = components(from).every((v, i) => v === components(to)[i]);
        if (plan.driver === 'none' || !animationsAllowed(this.actor) || same) {
            this.finish();
            return false;
        }
        this.x0 = plan.x0;
        this.v0 = 0;
        this.factor = slowDownFactor();
        this._begin(Math.max(1, Math.round(plan.durationMs * this.factor)), delay, elapsed => {
            const p = 1 + motionState(this.spring, this.x0, 0, elapsed / this.factor).x;
            this.access.write(blend(from, to, p));
        });
        return true;
    }

    _begin(realDuration, delay, write) {
        const tl = new Clutter.Timeline({actor: this.actor, duration: realDuration,
            delay: Math.max(0, Math.round(delay ?? 0))});
        this.timeline = tl;
        tl.connect('new-frame', () => {
            if (this.timeline !== tl)
                return;
            const elapsed = tl.get_elapsed_time();
            if (elapsed >= tl.get_duration())
                this._writeTarget();
            else
                write(elapsed);
        });
        tl.connect('completed', () => {
            if (this.timeline !== tl)
                return;
            this.finish();
            this.animation._trackDone(this);
        });
        tl.start();
    }

    _writeTarget() {
        this.access.write(this.target);
    }

    // Exact value written, timeline released (the Compose estimate leaves up to ~0.51 px on critical
    // springs: we end on the target).
    finish() {
        const tl = this.timeline;
        if (tl)
            this.last = {elapsed: tl.get_elapsed_time(), duration: tl.get_duration()};
        this._writeTarget();
        this.done = true;
        this.timeline = null;
    }

    // Stops the timeline. Its handlers are neutralised by the `this.timeline === tl` test.
    stop() {
        const tl = this.timeline;
        this.timeline = null;
        if (tl)
            tl.stop();
    }

    // For the bench: real elapsed time of the timeline (or the last one), duration, end.
    timing() {
        if (!this.timeline)
            return {...this.last ?? {elapsed: 0, duration: 0}, done: true};
        return {elapsed: this.timeline.get_elapsed_time(), duration: this.timeline.get_duration(),
            done: this.done};
    }
}
