// Source of an app launch, for the "icon -> window" container transform.
// Shell.App.activate / activate_full / open_new_window / launch / launch_action are wrapped (JS calls from the Shell
// and from extensions: app grid, dash, Dash to Dock, search results). At launch, the source actor is looked up by
// walking up from the actor under the pointer, then from the keyboard focus, to an actor whose `.app` is the launched
// app; its on-screen bounds and radius are noted with the time. windows.js consumes the note when a NORMAL window of
// that app opens (takeSource).
// The icon "zoom out" at launch (AppIcon.animateLaunch, GNOME's own launch feedback) is removed: the M3E launch
// feedback is the container transform itself.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';

import {Replacements, bounds, logFailure, radiusOf} from './utils.js';

export const NAME = 'launcher';

// M3E-visual: a heavy app (browser, office suite) may take several seconds to show its window.
const VALIDITY_US = 8 * 1000 * 1000;
const DEPTH = 20;

const replacements = new Replacements();
const notes = new Map(); // app -> {rect, radius, t}

function walkUp(actor, app) {
    for (let a = actor, n = 0; a && n < DEPTH; a = a.get_parent(), n++) {
        try {
            if (a.app === app)
                return a;
        } catch {
            // `app` accessor that throws on an actor without an app: not the one we look for, keep walking up
        }
    }
    return null;
}

function findSource(app) {
    const [x, y] = global.get_pointer();
    const underPointer = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
    const event = Clutter.get_current_event();
    const keyboard = event && [Clutter.EventType.KEY_PRESS, Clutter.EventType.KEY_RELEASE]
        .includes(event.type());
    const order = keyboard ? [global.stage.key_focus, underPointer] : [underPointer, global.stage.key_focus];
    for (const start of order) {
        const a = walkUp(start, app);
        if (a?.mapped)
            return a;
    }
    return null;
}

// Notes the launch of `app` from the source actor found (nothing if none).
export function noteLaunch(app) {
    if (!app)
        return;
    const source = findSource(app);
    if (!source) {
        notes.delete(app);
        return;
    }
    const rect = bounds(source);
    if (rect.width <= 0 || rect.height <= 0)
        return;
    notes.set(app, {rect, radius: radiusOf(source), t: GLib.get_monotonic_time()});
}

// For the bench: the next NORMAL window that opens (any app) starts from `rect`.
let next = null;
export function _noteNext(rect, radius) {
    next = {rect, radius, t: GLib.get_monotonic_time()};
}

// Source noted for the app of window `w`, consumed; null if none or expired.
export function takeSource(w) {
    if (next) {
        const n = next;
        next = null;
        return n;
    }
    const app = Shell.WindowTracker.get_default().get_window_app(w);
    const note = app ? notes.get(app) : null;
    if (!note)
        return null;
    notes.delete(app);
    if (GLib.get_monotonic_time() - note.t > VALIDITY_US)
        return null;
    return note;
}

// Radius of a dock icon (minimize): app actor at the center of the icon geometry, else a quarter of the short side
// (M3E-visual: medium tile shape).
export function iconRadius(rect, app = null) {
    const a = global.stage.get_actor_at_pos(Clutter.PickMode.ALL,
        Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2));
    for (let p = a, n = 0; p && n < DEPTH; p = p.get_parent(), n++) {
        let isIcon = false;
        try {
            isIcon = p.app !== undefined && (app === null || p.app === app);
        } catch {
            isIcon = false; // `app` accessor that throws: not an app icon
        }
        if (isIcon) {
            const r = radiusOf(p);
            if (r > 0)
                return r;
            break;
        }
    }
    return Math.min(rect.width, rect.height) / 4;
}

// An activate() on an already running app only shows its window: no launch to note.
const isLaunch = app => app.state !== Shell.AppState.RUNNING;

export function enable() {
    const proto = Shell.App.prototype;
    for (const [name, always] of [['activate', false], ['activate_full', false], ['open_new_window', true],
        ['launch', true], ['launch_action', true]]) {
        if (typeof proto[name] !== 'function')
            continue;
        replacements.replace(proto, name, original => function (...args) {
            try {
                if (always || isLaunch(this))
                    noteLaunch(this);
            } catch (e) {
                logFailure('launch source', e);
            }
            return original.apply(this, args);
        });
    }
    replacements.replace(AppDisplay.AppIcon.prototype, 'animateLaunch', () => function () {});
}

export function disable() {
    replacements.restore();
    notes.clear();
    next = null;
}
