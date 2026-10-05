// State of the window effects (windows.js): decision to take a window over, running effect per actor, completion
// declared to mutter (completed_*), return to rest, shadow revealed after a container transform.
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {animate} from '../m3e/animate.js';
import {CORNERS_EFFECT_NAME} from '../m3e/corners.js';
import {animationsAllowed, logFailure} from './utils.js';

// M3E-visual: radius of client-side decorated windows (GTK 4 `window.csd` of the theme); 0 when maximized or
// fullscreen (GTK draws square corners there).
export const WINDOW_RADIUS = 12;

export const T = Meta.WindowType;
export const TYPES = [T.NORMAL, T.DIALOG, T.MODAL_DIALOG];

// Windows being moved or resized with the pointer (grab-op): other extensions may translate their actor during the
// gesture, so their translation is never reset to 0 and their size changes are left to the Shell.
export const grabbed = new Set();
// Actors for which the Shell's _shouldAnimateActor answers "no" (map: side effects only).
export const neutralized = new Set();

// Running effect per actor: {kind: 'map'|'destroy'|'minimize'|'unminimize'|'size', due (completed_* still owed),
// pattern, iconMin (pattern = (un)minimize container transform), iconOrFrame (shadow to reveal at the end),
// snapshot (old content of a size change), frozen, waiting (overview handler), idle (pending start), zone,
// radiusAfter, start and radiusBefore (size change)}.
export const effects = new Map();

// --- window state ------------------------------------------------------------------------------------------------

export function windowRadius(w) {
    return w.is_fullscreen() || w.is_maximized() ? 0 : WINDOW_RADIUS;
}

// Frame of the window inside its buffer (logical px local to the actor): the content area without the CSD shadows.
export function frameZone(w) {
    const t = w.get_buffer_rect(), c = w.get_frame_rect();
    return {x: c.x - t.x, y: c.y - t.y, w: c.width, h: c.height};
}

// Windows left to the Shell: out of the task list without a parent (panels, wallpaper surfaces; a transient dialog is
// also out of the list but is animated), override-redirect, fullscreen.
export function isExcluded(w) {
    return w.skip_taskbar && !w.get_transient_for() || w.is_override_redirect() || w.is_fullscreen();
}

// Same decision as the Shell's _shouldAnimateActor, consuming nothing (skipNextEffect stays with the Shell if needed).
export function shouldTake(actor, types) {
    if (!animationsAllowed())
        return false;
    const wm = Main.wm;
    if (wm._skippedActors.has(actor) || !wm._shouldAnimate() || !actor.get_texture())
        return false;
    if (!types.includes(wm._getAnimationWindowType(actor)))
        return false;
    return !isExcluded(actor.meta_window);
}

// --- end of effects ----------------------------------------------------------------------------------------------

const COMPLETE = {
    map: (wm, a) => wm.completed_map(a),
    destroy: (wm, a) => wm.completed_destroy(a),
    minimize: (wm, a) => wm.completed_minimize(a),
    unminimize: (wm, a) => wm.completed_unminimize(a),
    size: (wm, a) => wm.completed_size_change(a),
};

// Declares the running effect finished to mutter (once).
export function complete(actor) {
    const e = effects.get(actor);
    if (!e || !e.due)
        return;
    e.due = false;
    if (e.frozen) {
        e.frozen = false;
        actor.thaw();
    }
    if (e.kind === 'destroy')
        actor.meta_window?.get_transient_for()?.disconnectObject(actor);
    try {
        COMPLETE[e.kind](global.window_manager, actor);
    } catch (err) {
        logFailure(`completed ${e.kind}`, err);
    }
}

// Actor put back at rest (like the Shell's *Done); the corners effect we added is removed. The translation of a
// grabbed window (move in progress) is left alone.
export function rest(actor) {
    actor.remove_all_transitions();
    actor.set({opacity: 255, scale_x: 1, scale_y: 1});
    if (!grabbed.has(actor.meta_window))
        actor.set({translation_x: 0, translation_y: 0});
    actor.set_pivot_point(0, 0);
    const c = actor.get_effect(CORNERS_EFFECT_NAME);
    if (c)
        actor.remove_effect(c);
}

// Like the Shell's ease() (_makeEasePrepareAndCleanup): no fullscreen unredirection and no render suspension during
// an effect. Taken once per effect, given back by cleanup().
function hold(e) {
    if (e.held)
        return;
    e.held = true;
    global.compositor.disable_unredirect();
    global.begin_work?.();
}

export function cleanup(e) {
    if (e.held) {
        e.held = false;
        global.compositor.enable_unredirect();
        global.end_work?.();
    }
    if (e.waiting) {
        Main.overview.disconnect(e.waiting);
        e.waiting = 0;
    }
    if (e.idle) {
        GLib.source_remove(e.idle);
        e.idle = 0;
    }
    e.snapshot?.destroy();
    e.snapshot = null;
}

// Normal end of an effect (pattern onDone): rest, completed_*, then the shadow revealed if the pattern kept its
// corners (container transform to a displayed window).
export function endEffect(actor, e) {
    if (effects.get(actor) !== e)
        return;
    cleanup(e);
    const shadow = ['map', 'unminimize', 'size'].includes(e.kind) && e.iconOrFrame &&
        actor.get_effect(CORNERS_EFFECT_NAME) !== null;
    if (shadow) {
        actor.set({opacity: 255, scale_x: 1, scale_y: 1});
        if (!grabbed.has(actor.meta_window))
            actor.set({translation_x: 0, translation_y: 0});
        actor.set_pivot_point(0, 0);
    } else {
        rest(actor);
    }
    complete(actor);
    effects.delete(actor);
    if (shadow)
        revealShadow(actor);
}

// Stops any running effect on the actor (rest, completed_*). Used to fall back to the Shell and by disable().
export function stopEffect(actor) {
    const e = effects.get(actor);
    if (!e)
        return;
    e.pattern?.stop();
    cleanup(e);
    rest(actor);
    complete(actor);
    effects.delete(actor);
}

// --- shadow ------------------------------------------------------------------------------------------------------

export const shadows = new Map(); // actor -> {anim (animation of the clip), id (destroy handler)}

export function revealShadow(actor) {
    const w = actor.meta_window;
    const effect = actor.get_effect(CORNERS_EFFECT_NAME);
    if (!effect || !w) {
        rest(actor);
        return;
    }
    const z = frameZone(w);
    const t = w.get_buffer_rect();
    const margin = Math.max(z.x, z.y, t.width - z.x - z.w, t.height - z.y - z.h, 0);
    const radius = windowRadius(w);
    if (margin <= 0) {
        actor.remove_effect(effect);
        return;
    }
    effect.compensate = false;
    effect.left = z.x;
    effect.top = z.y;
    effect.width = z.w;
    effect.height = z.h;
    effect.radius = radius;
    const p = n => `@effects.${CORNERS_EFFECT_NAME}.${n}`;
    forgetShadow(actor, true);
    const anim = animate(actor, {
        [p('left')]: 0, [p('top')]: 0, [p('width')]: t.width, [p('height')]: t.height,
        [p('radius')]: radius + margin,
    }, {
        spring: 'DefaultEffects',
        onDone: () => {
            forgetShadow(actor, false);
            const c = actor.get_effect(CORNERS_EFFECT_NAME);
            if (c)
                actor.remove_effect(c);
        },
    });
    // Actor destroyed on the way: animate() stops without onDone, the entry is forgotten here.
    const id = actor.connect('destroy', () => shadows.delete(actor));
    shadows.set(actor, {anim, id});
}

// Forgets the shadow animation of the actor (stopping it when `stop`); the corners effect stays in place.
// cutShadow() is the version that also removes the effect.
function forgetShadow(actor, stop) {
    const s = shadows.get(actor);
    if (!s)
        return;
    if (stop)
        s.anim.stop();
    shadows.delete(actor);
    actor.disconnect(s.id);
}

export function cutShadow(actor) {
    if (!shadows.has(actor))
        return;
    forgetShadow(actor, true);
    const c = actor.get_effect(CORNERS_EFFECT_NAME);
    if (c)
        actor.remove_effect(c);
}

// --- effects -----------------------------------------------------------------------------------------------------

// New effect on the actor. The pattern of the previous effect (if still moving) is handed over: the next effect takes
// it over (iconMin: (un)minimize container transform) or stops it.
export function newEffect(actor, kind) {
    const previous = effects.get(actor);
    const e = {kind, due: true, pattern: previous?.pattern ?? null, iconMin: previous?.iconMin ?? false,
        iconOrFrame: false, snapshot: null, frozen: false, waiting: 0, idle: 0, zone: null, radiusAfter: null,
        start: null, radiusBefore: 0};
    if (previous) {
        // Previous effect still moving (kill-window-effects may or may not have completed it): completed now, its
        // pattern is taken over by the new effect.
        complete(actor);
        cleanup(previous);
    }
    effects.set(actor, e);
    hold(e);
    cutShadow(actor);
    followDestruction(actor);
    return e;
}

// Actor destroyed during an effect already completed to mutter (map, after kill-window-effects): patterns stop
// without onDone; the entry is removed and the unredirection given back here. One handler per actor.
export const destroyHandlers = new Map(); // actor -> handler id

function followDestruction(actor) {
    if (destroyHandlers.has(actor))
        return;
    destroyHandlers.set(actor, actor.connect('destroy', () => {
        destroyHandlers.delete(actor);
        const e = effects.get(actor);
        if (e) {
            cleanup(e);
            effects.delete(actor);
        }
    }));
}

export const doneOf = (actor, e) => () => endEffect(actor, e);

export function frameCenter(w) {
    const z = frameZone(w);
    return {x: z.x + z.w / 2, y: z.y + z.h / 2};
}

// Pattern of the previous effect stopped (in place) if still moving; corners and clip of a container transform go
// with it.
export function stopPrevious(e) {
    e.pattern?.stop();
    e.pattern = null;
    e.iconMin = false;
}
