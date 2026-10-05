// Helpers shared by the motion modules: method replacement (restored on disable()), blocking a Shell signal handler,
// animation settings, actor radius, and the Driver: a number led by a toolkit spring with the contract of ease()
// (onComplete, onStopped), for quantities that are not actor properties (value of a St.Adjustment, progress of a
// workspace group).
import St from 'gi://St';
import GObject from 'gi://GObject';

import {animate, release, virtualProperty, removeProperty} from '../m3e/animate.js';

export const animationsAllowed = () => St.Settings.get().enable_animations;

// Log an error with a message and its stack, the one logging style of this extension.
export function logFailure(message, error) {
    console.error(`m3e-motion: ${message}: ${error?.message ?? error}\n${error?.stack ?? ''}`);
}

// --- method replacements -----------------------------------------------------------------------------------------

// Registry of the replacements of one module: replace(object, name, factory) installs factory(original) in place of
// object[name]; restore() puts the originals back in reverse order. For an own instance property that shadowed the
// prototype, the original is "absent": restore() deletes the instance property.
export class Replacements {
    constructor() {
        this._list = [];
    }

    replace(object, name, factory) {
        // Read first: GJS defines introspected methods on first access (lazy resolution).
        const original = object[name];
        const own = Object.prototype.hasOwnProperty.call(object, name);
        this._list.push({object, name, own, original});
        object[name] = factory(original);
        return original;
    }

    restore() {
        for (const {object, name, own, original} of this._list.reverse()) {
            try {
                if (own)
                    object[name] = original;
                else
                    delete object[name];
            } catch (e) {
                logFailure(`restoring ${name}`, e);
            }
        }
        this._list = [];
    }
}

// --- Shell signal handlers ---------------------------------------------------------------------------------------

// Blocks the first handler of `signal` on `object`: the Shell's own, connected at construction (before any
// extension). Returns a function that unblocks it. Throws when no handler is found.
export function blockFirst(object, signal) {
    const id = GObject.signal_handler_find(object, {signalId: signal});
    if (!id)
        throw new Error(`no Shell handler for '${signal}'`);
    GObject.signal_handler_block(object, id);
    return () => GObject.signal_handler_unblock(object, id);
}

// --- geometry ----------------------------------------------------------------------------------------------------

// Corner radius of an St actor (top-left corner of the theme node, logical px), else that of the first descendant
// that has one (an app tile carries its background on a child), else 0.
export function radiusOf(actor, depth = 3) {
    if (actor instanceof St.Widget) {
        try {
            const r = actor.get_theme_node().get_border_radius(St.Corner.TOPLEFT);
            if (r > 0)
                return r / St.ThemeContext.get_for_stage(global.stage).scale_factor;
        } catch {
            // theme node unavailable (actor not styled yet): fall through to the children
        }
    }
    if (depth <= 0)
        return 0;
    for (const child of actor.get_children()) {
        const r = radiusOf(child, depth - 1);
        if (r > 0)
            return r;
    }
    return 0;
}

// Bounds of an actor on screen (scene logical px): {x, y, width, height}.
export function bounds(actor) {
    const b = actor.get_transformed_extents();
    return {x: b.origin.x, y: b.origin.y, width: b.size.width, height: b.size.height};
}

// --- Driver ------------------------------------------------------------------------------------------------------

let counter = 0;

// Number led by a toolkit spring on the clock of `clock` (a mapped actor that carries the timeline).
//   const d = new Driver(clock, {read, write, spring, threshold});
//   d.goTo(target, {velocity, bounds: [a, b], spring, onComplete, onStopped});   // retargets keeping value and velocity
//   d.stop();                                                                     // stops in place, onStopped(false)
//   d.running, d.from, d.to
// `velocity` (units per second): imposed start velocity (end of a gesture); otherwise that of the current motion.
// `bounds`: written values are clamped to [a, b] (overview state: an overshoot makes no sense).
// Contract of ease(): a segment taken over by goTo() or stopped by stop() receives onStopped(false); a finished
// segment receives onStopped(true) then onComplete().
export class Driver {
    constructor(clock, {read, write, spring = 'DefaultSpatial', threshold}) {
        this._clock = clock;
        this._read = read;
        this._write = write;
        this._spring = spring;
        this._threshold = threshold;
        this._name = `m3e-driver-${++counter}`;
        this._bounds = null;
        this._path = virtualProperty(clock, this._name, {
            read: () => this._read(),
            write: v => {
                const b = this._bounds;
                this._write(b ? Math.min(b[1], Math.max(b[0], v)) : v);
            },
        });
        this._segment = null;
    }

    get running() {
        return this._segment !== null;
    }

    get from() {
        return this._segment?.from ?? this._read();
    }

    get to() {
        return this._segment?.to ?? this._read();
    }

    goTo(target, {velocity = null, bounds: limits = null, spring = null, onComplete = null, onStopped = null} = {}) {
        const previous = this._segment;
        const from = this._read();
        const segment = {from, to: target, onComplete, onStopped, anim: null};
        this._segment = segment;
        this._bounds = limits;
        const onDone = () => {
            if (this._segment !== segment)
                return;
            this._segment = null;
            this._bounds = null;
            segment.onStopped?.(true);
            segment.onComplete?.();
        };
        const s = spring ?? this._spring;
        const options = {spring: s, threshold: this._threshold, onDone};
        // The new animation takes over the track of the old one (value and velocity); the old segment is told.
        segment.anim = velocity === null
            ? animate(this._clock, {[this._path]: target}, options)
            : release(this._clock, this._path, target, velocity, s, options);
        if (previous)
            previous.onStopped?.(false);
        return this;
    }

    // Value set immediately (zero duration): current segment stopped, callbacks of the new one called at once.
    setNow(target, {onComplete = null, onStopped = null} = {}) {
        this.stop();
        this._write(target);
        onStopped?.(true);
        onComplete?.();
    }

    // The running segment goes on but no longer notifies anybody (reversal of a choreography whose caller takes
    // over: its old callbacks must not fire).
    forgetCallbacks() {
        if (this._segment) {
            this._segment.onComplete = null;
            this._segment.onStopped = null;
        }
    }

    stop() {
        const segment = this._segment;
        this._segment = null;
        this._bounds = null;
        if (segment) {
            segment.anim?.stop();
            segment.onStopped?.(false);
        }
    }

    // Jumps to the target of the running segment and calls its callbacks (disable(): the caller waits for its end).
    finish() {
        const segment = this._segment;
        if (!segment)
            return;
        this._segment = null;
        this._bounds = null;
        segment.anim?.stop();
        this._write(segment.to);
        segment.onStopped?.(true);
        segment.onComplete?.();
    }

    destroy() {
        const segment = this._segment;
        this._segment = null;
        segment?.anim?.stop();
        removeProperty(this._clock, this._name);
    }
}
