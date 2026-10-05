// Finger velocity at the end of a gesture. The Shell's SwipeTracker computes the end of a gesture in _endGesture() and
// emits 'end' with a duration, not a velocity: the velocity is noted just before the signal goes out; modules that
// finish the gesture on a spring read it with gestureVelocity().
import GLib from 'gi://GLib';
import * as SwipeTracker from 'resource:///org/gnome/shell/ui/swipeTracker.js';

import {Replacements} from './utils.js';

export const NAME = 'gestures';

// Maximum age of a noted velocity: the 'end' signal goes out within the same call as _endGesture.
const FRESHNESS_US = 100 * 1000;

const replacements = new Replacements();
let last = null; // {tracker, velocity (progress/ms), t (us)}

// Velocity of the last finished gesture (progress per ms), if it has just been noted (and `tracker` matches when
// given); null otherwise. Not consumed: several monitors finish the same gesture.
export function gestureVelocity(tracker = null) {
    const d = last;
    if (!d || GLib.get_monotonic_time() - d.t > FRESHNESS_US)
        return null;
    if (tracker && d.tracker !== tracker)
        return null;
    return d.velocity;
}

export function forgetGesture() {
    last = null;
}

// For the bench: simulates the end of a gesture.
export function _noteGesture(tracker, velocity) {
    last = {tracker, velocity, t: GLib.get_monotonic_time()};
}

export function enable() {
    replacements.replace(SwipeTracker.SwipeTracker.prototype, '_endGesture', original =>
        function (velocity, distance, isTouchpad) {
            last = distance > 0 && Number.isFinite(velocity)
                ? {tracker: this, velocity: velocity / distance, t: GLib.get_monotonic_time()}
                : null;
            return original.call(this, velocity, distance, isTouchpad);
        });
}

export function disable() {
    replacements.restore();
    last = null;
}
