// Windows (Android 17 motions):
//   opening from an icon        -> Android launcher launch: 500 ms emphasized from the icon bounds to the frame,
//                                  corners from the icon's to the window's, opacity in 50 ms after 25 ms; then the
//                                  shadow is revealed;
//   opening without a source    -> activity open: slide of 96 dp x 56/72 in 450 ms emphasized, opacity in 83 ms
//                                  after 50 ms;
//   dialog                      -> M3E fade in;
//   closing                     -> return to the dock icon (swipe-to-home springs: X 450 / 0.965, Y 400 / 0.95,
//                                  scale 500 / 0.99) when there is one, else fade out;
//   minimize / unminimize       -> container transform back / forth to the dock icon (else fade);
//   size change                 -> container transform old frame -> new frame (old content frozen underneath).
// The Shell's handlers (map, destroy, minimize, unminimize, size-change, size-changed), bound at its construction,
// are blocked; ours decide, and hand back to the Shell's own method for everything they do not take (ignored window,
// open overview, animations off, excluded window).
// An effect killed by mutter (kill-window-effects) is declared finished at once (completed_*) without stopping the
// motion: the next effect on the same window takes the running pattern over (unminimize during a minimize).
// Launch from an icon, opening without a source and closing to the icon: windows-android.js; effect state:
// windows-state.js.
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {containerTransform, fade} from '../m3e/patterns.js';
import {Replacements, blockFirst, logFailure} from './utils.js';
import * as Launcher from './launcher.js';
import {T, TYPES, WINDOW_RADIUS, cleanup, complete, cutShadow, destroyHandlers, doneOf, effects, frameCenter,
    frameZone, grabbed, isExcluded, neutralized, newEffect, shadows, shouldTake, rest, stopEffect, stopPrevious,
    windowRadius} from './windows-state.js';
import {launchFromIcon, openActivity, returnToIcon} from './windows-android.js';

export {WINDOW_RADIUS, windowRadius, frameZone} from './windows-state.js';

export const NAME = 'windows';

const replacements = new Replacements();
let unblock = [];
let ids = [];
let grabIds = [];
let originals = null;

function open(actor, e) {
    const w = actor.meta_window;
    const type = Main.wm._getAnimationWindowType(actor);
    const note = type === T.NORMAL ? Launcher.takeSource(w) : null;
    if (note) {
        e.iconOrFrame = true;
        e.pattern = launchFromIcon(actor, note, {destinationRadius: windowRadius(w), content: frameZone(w),
            onDone: doneOf(actor, e)});
    } else if (type === T.NORMAL) {
        e.pattern = openActivity(actor, {onDone: doneOf(actor, e)});
    } else {
        e.pattern = fade(actor, true, {origin: frameCenter(w), onDone: doneOf(actor, e)});
    }
}

// --- handlers ----------------------------------------------------------------------------------------------------

function onMap(shellwm, actor) {
    if (!shouldTake(actor, TYPES)) {
        stopEffect(actor);
        originals.map(shellwm, actor);
        return;
    }
    // Shell side effects (window-type / unmanaged connections, parent dimming), completed_map included.
    // The actor stays invisible until the pattern starts.
    actor.opacity = 0;
    neutralized.add(actor);
    try {
        originals.map(shellwm, actor);
    } finally {
        neutralized.delete(actor);
    }
    const e = newEffect(actor, 'map');
    e.due = false; // already completed by the Shell
    const start = () => {
        if (effects.get(actor) !== e)
            return;
        // Panel-like window moved out of the task list just after map (an extension's connect_after): left alone.
        if (isExcluded(actor.meta_window)) {
            cleanup(e);
            effects.delete(actor);
            rest(actor);
            return;
        }
        open(actor, e);
    };
    if (Main.overview.visible) {
        // Launch from the overview: the window appears once the overview is closed (like the Shell).
        e.waiting = Main.overview.connect('hidden', () => {
            Main.overview.disconnect(e.waiting);
            e.waiting = 0;
            start();
        });
    } else {
        e.idle = GLib.idle_add(GLib.PRIORITY_HIGH, () => {
            e.idle = 0;
            start();
            return GLib.SOURCE_REMOVE;
        });
    }
}

function onDestroy(shellwm, actor) {
    if (!shouldTake(actor, TYPES)) {
        stopEffect(actor);
        originals.destroy(shellwm, actor);
        return;
    }
    const w = actor.meta_window;
    // Shell side effects (_destroyWindow).
    w.disconnectObject(actor);
    if (w.is_attached_dialog()) {
        const parent = w.get_transient_for();
        Main.wm._checkDimming(parent);
        parent.connectObject('unmanaged', () => stopEffect(actor), actor);
    }
    const e = newEffect(actor, 'destroy');
    // Window with a (dock) icon: return to the icon on the Android swipe-to-home springs, from the displayed
    // geometry. Otherwise fade out: a running fade in is taken over (displayed opacity), a container transform or an
    // activity open is stopped in place first.
    const icon = Main.wm._getAnimationWindowType(actor) === T.NORMAL ? iconOf(w) : null;
    if (icon) {
        e.pattern = returnToIcon(actor, icon, {
            iconRadius: Launcher.iconRadius(icon), windowRadius: windowRadius(w), content: frameZone(w),
            previous: e.pattern, onDone: doneOf(actor, e),
        });
        e.iconMin = false;
        return;
    }
    if (e.iconMin || e.pattern?._containerState || e.pattern?.android)
        stopPrevious(e);
    e.pattern = fade(actor, false, {onDone: doneOf(actor, e)});
}

function iconOf(w) {
    const [ok, g] = w.get_icon_geometry();
    return ok && g.width > 0 && g.height > 0 ? {x: g.x, y: g.y, width: g.width, height: g.height} : null;
}

function onMinimize(shellwm, actor) {
    if (!shouldTake(actor, TYPES)) {
        stopEffect(actor);
        originals.minimize(shellwm, actor);
        return;
    }
    const w = actor.meta_window;
    const icon = iconOf(w);
    const e = newEffect(actor, 'minimize');
    const onDone = doneOf(actor, e);
    if (icon && e.iconMin && e.pattern?.running) {
        // Unminimize in progress: the same container transform goes back to the icon, from the displayed position
        // and velocity.
        e.pattern.target('start', {onDone});
        return;
    }
    stopPrevious(e);
    if (icon) {
        e.iconMin = true;
        e.pattern = containerTransform(icon, actor, {
            reverse: true, sourceRadius: Launcher.iconRadius(icon), destinationRadius: windowRadius(w),
            content: frameZone(w), keepCorners: true, onDone,
        });
    } else {
        e.pattern = fade(actor, false, {onDone});
    }
}

function onUnminimize(shellwm, actor) {
    if (!shouldTake(actor, TYPES)) {
        stopEffect(actor);
        originals.unminimize(shellwm, actor);
        return;
    }
    const w = actor.meta_window;
    const icon = iconOf(w);
    const e = newEffect(actor, 'unminimize');
    const onDone = doneOf(actor, e);
    actor.show();
    e.iconOrFrame = icon !== null;
    if (icon && e.iconMin && e.pattern?.running) {
        // Minimize in progress: the same container transform goes back to the window, velocity kept.
        e.pattern.target('end', {onDone});
        return;
    }
    stopPrevious(e);
    if (icon) {
        e.iconMin = true;
        e.pattern = containerTransform(icon, actor, {
            sourceRadius: Launcher.iconRadius(icon), destinationRadius: windowRadius(w), content: frameZone(w),
            keepCorners: true, onDone,
        });
    } else {
        e.pattern = fade(actor, true, {origin: frameCenter(w), onDone});
    }
}

function onSizeChange(shellwm, actor, change, oldFrame, oldBuffer) {
    if (!shouldTake(actor, [T.NORMAL]) || oldFrame.width <= 0 || oldFrame.height <= 0 ||
        grabbed.has(actor.meta_window)) {
        stopEffect(actor);
        originals.sizeChange(shellwm, actor, change, oldFrame, oldBuffer);
        return;
    }
    const running = effects.get(actor);
    // Start: the displayed frame if a size change is running (no jump), else the old frame.
    let start = {x: oldFrame.x, y: oldFrame.y, width: oldFrame.width, height: oldFrame.height};
    if (running?.kind === 'size' && running.pattern?.running && running.zone) {
        const ext = actor.get_transformed_extents();
        const z = running.zone, s = actor.scale_x;
        start = {x: ext.origin.x + z.x * s, y: ext.origin.y + z.y * s, width: z.w * s, height: z.h * s};
    }
    const radiusBefore = running?.kind === 'size' && running.radiusAfter !== null ? running.radiusAfter
        : change === Meta.SizeChange.UNMAXIMIZE || change === Meta.SizeChange.UNFULLSCREEN ? 0 : WINDOW_RADIUS;
    const e = newEffect(actor, 'size');
    stopPrevious(e);
    // Snapshot of the old content, taken before the freeze (like the Shell).
    const snapshot = new St.Widget({content: actor.paint_to_content(oldFrame)});
    snapshot.set_size(oldFrame.width, oldFrame.height);
    e.snapshot = snapshot;
    e.start = start;
    e.radiusBefore = radiusBefore;
    actor.freeze();
    e.frozen = true;
}

function onSizeChanged(shellwm, actor) {
    const e = effects.get(actor);
    if (!e || e.kind !== 'size' || !e.snapshot || e.pattern) {
        if (!e)
            originals.sizeChanged(shellwm, actor);
        return;
    }
    const w = actor.meta_window;
    e.frozen = false;
    actor.thaw();
    global.window_group.insert_child_below(e.snapshot, actor);
    e.snapshot.set_position(e.start.x, e.start.y);
    e.snapshot.set_size(e.start.width, e.start.height);
    e.zone = frameZone(w);
    e.radiusAfter = windowRadius(w);
    e.iconOrFrame = true; // shadow revealed at the end
    e.pattern = containerTransform(e.snapshot, actor, {
        sourceRadius: e.radiusBefore, destinationRadius: e.radiusAfter, content: e.zone, keepCorners: true,
        onDone: doneOf(actor, e),
    });
}

function onKill(shellwm, actor) {
    // The effect is declared finished at once; the motion goes on and will be taken over by the next effect.
    const e = effects.get(actor);
    if (!e)
        return;
    if (e.kind === 'size' && !e.pattern) {
        // Size change prepared but never started: snapshot dropped, actor thawed.
        stopEffect(actor);
        return;
    }
    complete(actor);
}

// --- wiring ------------------------------------------------------------------------------------------------------

export function enable() {
    const wm = Main.wm;
    const proto = Object.getPrototypeOf(wm);
    originals = {
        map: (s, a) => proto._mapWindow.call(wm, s, a),
        destroy: (s, a) => proto._destroyWindow.call(wm, s, a),
        minimize: (s, a) => proto._minimizeWindow.call(wm, s, a),
        unminimize: (s, a) => proto._unminimizeWindow.call(wm, s, a),
        sizeChange: (...args) => proto._sizeChangeWindow.call(wm, ...args),
        sizeChanged: (s, a) => proto._sizeChangedWindow.call(wm, s, a),
    };
    replacements.replace(wm, '_shouldAnimateActor', original => function (actor, types) {
        if (neutralized.has(actor))
            return false;
        return original.call(this, actor, types);
    });
    Launcher.enable();
    const shellwm = global.window_manager;
    const ours = {
        'map': onMap, 'destroy': onDestroy, 'minimize': onMinimize, 'unminimize': onUnminimize,
        'size-change': onSizeChange, 'size-changed': onSizeChanged,
    };
    for (const [signal, handler] of Object.entries(ours)) {
        unblock.push(blockFirst(shellwm, signal));
        ids.push(shellwm.connect(signal, (...args) => {
            try {
                handler(...args);
            } catch (err) {
                logFailure(`handler of ${signal}`, err);
                fallback(signal, args);
            }
        }));
    }
    ids.push(shellwm.connect('kill-window-effects', (s, a) => onKill(s, a)));
    grabIds = [
        global.display.connect('grab-op-begin', (d, w) => w && grabbed.add(w)),
        global.display.connect('grab-op-end', (d, w) => w && grabbed.delete(w)),
    ];
}

// Error in one of our handlers: the effect is given back to the Shell so that mutter receives its completed_*.
function fallback(signal, [shellwm, actor, ...rest_]) {
    try {
        const e = effects.get(actor);
        if (e) {
            e.pattern?.stop();
            cleanup(e);
            rest(actor);
            complete(actor);
            effects.delete(actor);
            return;
        }
        const f = {'map': originals.map, 'destroy': originals.destroy, 'minimize': originals.minimize,
            'unminimize': originals.unminimize, 'size-change': originals.sizeChange,
            'size-changed': originals.sizeChanged}[signal];
        f(shellwm, actor, ...rest_);
    } catch (e) {
        logFailure(`fallback of ${signal}`, e);
    }
}

export function disable() {
    for (const id of grabIds)
        global.display.disconnect(id);
    grabIds = [];
    grabbed.clear();
    const shellwm = global.window_manager;
    for (const id of ids)
        shellwm.disconnect(id);
    ids = [];
    for (const u of unblock)
        u();
    unblock = [];
    for (const actor of [...effects.keys()])
        stopEffect(actor);
    for (const actor of [...shadows.keys()])
        cutShadow(actor);
    effects.clear();
    for (const [actor, id] of destroyHandlers)
        actor.disconnect(id);
    destroyHandlers.clear();
    neutralized.clear();
    Launcher.disable();
    replacements.restore();
    originals = null;
}

// For the bench.
export function _diagnostic() {
    return {effects: effects.size, shadows: shadows.size,
        kinds: [...effects.values()].map(e => e.kind)};
}
