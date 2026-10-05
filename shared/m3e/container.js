// M3E container transform (MDC's MaterialContainerTransform) on the machinery of pattern.js, and its Android
// app-launch variant (Launcher3: position in duration and curve, icon corners to window corners, opacity driven
// by time). Split from patterns.js on 2026-10-05.

import Clutter from 'gi://Clutter';

import {_registerStop} from './animate.js';
import {corners, CORNERS_EFFECT_NAME} from './corners.js';
import {PATTERNS} from './tokens.js';
import {CENTER, Pattern, ORIGIN, rectEdges, edgeGap, opacityWindow, mix} from './pattern.js';

// Sources hidden by containerTransform: actor → {n, originalOpacity, destroyId}.
// Several patterns can start from the same actor (icon relaunched during its own opening): the first
// one hides it and notes the original opacity, the last one restores it. Destroyed actor: entry forgotten.
const hiddenSources = new Map();

function hideSource(actor) {
    let e = hiddenSources.get(actor);
    if (!e) {
        e = {n: 0, originalOpacity: actor.opacity, destroyId: 0};
        e.destroyId = actor.connect('destroy', () => hiddenSources.delete(actor));
        hiddenSources.set(actor, e);
    }
    e.n++;
    actor.opacity = 0;
}

function restoreSource(actor) {
    const e = hiddenSources.get(actor);
    if (!e || --e.n > 0)
        return;
    hiddenSources.delete(actor);
    actor.disconnect(e.destroyId);
    actor.opacity = e.originalOpacity;
}

// Destruction of container-transform sources, followed for the whole life of the actor (one handler per
// actor): a pattern inactive between two segments thus knows its source is dead (no clone of a destroyed
// actor on the next target('start'); fix carried over from A). The handlers are disconnected by stopAll()
// so that nothing of a disabled extension stays connected to a Shell actor.
const trackedDeaths = new Map(); // actor → {dead, id}

function trackDeath(actor) {
    let e = trackedDeaths.get(actor);
    if (!e) {
        e = {dead: false, id: 0};
        e.id = actor.connect('destroy', () => {
            e.dead = true;
            e.id = 0;
            trackedDeaths.delete(actor);
        });
        trackedDeaths.set(actor, e);
    }
    return e;
}

_registerStop(() => {
    for (const [actor, e] of trackedDeaths) {
        if (e.id)
            actor.disconnect(e.id);
    }
    trackedDeaths.clear();
});

// --- container transform -----------------------------------------------------------

function rectangle(r) {
    if (r instanceof Clutter.Actor) {
        const b = r.get_transformed_extents();
        const e = {x: b.origin.x, y: b.origin.y, w: b.size.width, h: b.size.height};
        if ([e.x, e.y, e.w, e.h].every(Number.isFinite) && e.w > 0 && e.h > 0)
            return e;
        // Actor not allocated yet (just placed, e.g. window snapshot, C): fixed position and size, in
        // the (allocated) parent's space, without own scale.
        const [px, py] = r.get_parent()?.get_transformed_position() ?? [0, 0];
        return {x: px + r.x, y: py + r.y, w: r.width, h: r.height};
    }
    return {x: r.x, y: r.y, w: r.width, h: r.height};
}

// MDC geometry (MaterialContainerTransform.updateProgress, AUTO fit, linear path) as a function of u and
// w (scale mask, 0 → 1):
//  - path point: top-centre, from the one of the start r0 to the one of the end r1;
//  - AUTO fit (the end fitted in width to the start is at least as tall as it → by width, else by
//    height): the fitted dimension goes linearly from r0 to r1; each content keeps its proportions
//    (uniform scales sa, sd), horizontally centred, stuck to the top;
//  - container (union of the masked bounds): the other dimension goes from the start's to the end's
//    according to w; this is the clip area.
function containerFrames(r0, r1, byWidth, u, w) {
    const cx = mix(r0.x + CENTER * r0.w, r1.x + CENTER * r1.w, u);
    const top = mix(r0.y, r1.y, u);
    let sa, sd;
    if (byWidth) {
        const width = mix(r0.w, r1.w, u);
        sa = width / r1.w;
        sd = width / r0.w;
    } else {
        const height = mix(r0.h, r1.h, u);
        sa = height / r1.h;
        sd = height / r0.h;
    }
    const A = {w: r1.w * sa, h: r1.h * sa}, D = {w: r0.w * sd, h: r0.h * sd};
    A.x = cx - CENTER * A.w;
    D.x = cx - CENTER * D.w;
    A.y = D.y = top;
    const z = byWidth ? {w: A.w, h: mix(D.h, A.h, w)} : {w: mix(D.w, A.w, w), h: A.h};
    z.x = cx - CENTER * z.w;
    z.y = top;
    return {A, D, z, sa, sd};
}

// Places an actor (pivot 0,0, uniform scale s) so that its local point `offset` (content corner, local
// px) is at c (scene px), and its clip area z (scene px), inset by `inset` px.
function place(actor, effect, base, c, s, z, inset = 0, offset = ORIGIN) {
    actor.translation_x = c.x - offset.x * s - base.x;
    actor.translation_y = c.y - offset.y * s - base.y;
    actor.scale_x = s;
    actor.scale_y = s;
    if (s > 0) {
        effect.left = (z.x + inset - c.x) / s + offset.x;
        effect.top = (z.y + inset - c.y) / s + offset.y;
        effect.width = Math.max(0, z.w - inset - inset) / s;
        effect.height = Math.max(0, z.h - inset - inset) / s;
    }
}

// `destination` (already at its final place, in a parent) starts from the bounds of `source` according to
// PATTERNS.containerTransform (fade mode IN, AUTO fit):
//  - destination content at uniform scale, clipped by the container (RoundedCorners area) that deforms
//    from the source to the destination, radius from sourceRadius to destinationRadius (on-screen px);
//    destination opacity on fadeIn;
//  - if `source` is an actor: a Clutter.Clone of it, under the destination, follows the same u (same
//    bounds, fit scale, same clip) and stays opaque (mode IN); the original is hidden (opacity 0,
//    hideSource, like onTransitionStart of MDC) then restored at the end, at the stop or at the
//    destruction; the clone is then destroyed. Bounds only: no clone.
//  - the RoundedCorners effect added to the destination by the pattern is removed at the end (unless
//    keepCorners); an effect already present is kept, settings restored.
// Options added by C (2026-10-04):
//  - `content` {x, y, width, height}: rectangle of the content in the destination (local px), by default the
//    whole actor. Destination bounds and clip are those of the content (window: frame without CSD
//    shadows). What goes beyond the content is clipped during the pattern.
//  - `reverse`: the pattern starts at rest at the end (destination in place, opaque, destination radius)
//    and goes toward 'start' (minimise: window → icon). target('end') then brings it back (restore).
//  - `launch` (2026-10-05): Android app-launch variant (Launcher3): {motion, opacity}. `motion`
//    ({curve, duration}) drives the master travel instead of the Spatial spring; the radius and the scale
//    mask follow the progress linearly over the whole travel; the destination opacity is no longer a
//    progress window but a free animation driven by time (`opacity`: {curve, duration, delay}).
//    The return (target('start')) keeps MDC's windows.
export function containerTransform(source, destination, {sourceRadius, destinationRadius, hideSource: hide = true,
    keepCorners = false, content = null, reverse = false, launch = null, onDone} = {}) {
    const C = PATTERNS.containerTransform;
    if (C.mode !== 'IN')
        throw new Error(`unsupported fade mode: ${C.mode}`);
    if (C.fit !== 'AUTO')
        throw new Error(`unsupported fit: ${C.fit}`);
    const parent = destination.get_parent();
    if (!parent)
        throw new Error('containerTransform: the destination must have a parent');
    const isActor = source instanceof Clutter.Actor;
    const sourceDeath = isActor ? trackDeath(source) : null;
    const r0 = rectangle(source);
    const [ox, oy] = parent.get_transformed_position();
    const contentOrigin = content ? {x: content.x, y: content.y} : ORIGIN;
    const r1 = {x: ox + destination.x + contentOrigin.x, y: oy + destination.y + contentOrigin.y,
        w: content?.width ?? destination.width, h: content?.height ?? destination.height};
    const base = {x: ox + destination.x, y: oy + destination.y}, cloneBase = {x: ox, y: oy};
    // FIT_MODE_AUTO (enter): destination height fitted to the source width.
    const byWidth = r1.h * r0.w / r1.w >= r0.h;
    const existingCorners = destination.get_effect(CORNERS_EFFECT_NAME);
    const rS = sourceRadius ?? (typeof source.radius === 'number' ? source.radius : 0);
    const rD = destinationRadius ?? existingCorners?.radius ?? 0;
    const st = {w: 0, radius: rS, effectD: null, added: false, saved: null,
        clone: null, effectC: null, hidden: false, sourceAlive: true, sourceDestroyId: 0};

    const writeRadius = v => {
        st.radius = v;
        if (st.effectD)
            st.effectD.radius = v;
        if (st.effectC)
            st.effectC.radius = v;
    };
    const frames = u => containerFrames(r0, r1, byWidth, u, st.w);
    const geometry = {
        length: Math.max(edgeGap(rectEdges(r0), rectEdges(r1)),
            edgeGap(rectEdges(frames(0).A), rectEdges(frames(1).A))),
        write: (u, dead = null) => {
            if (dead?.has(destination))
                return;
            const {A, D, z, sa, sd} = frames(u);
            if (st.effectD)
                place(destination, st.effectD, base, A, sa, z, 0, contentOrigin);
            if (st.clone && st.effectC)
                // Clone clip inset by 1 px: its smoothed edge stays under the solid part of the
                // destination (otherwise two superimposed smoothed edges leave a fringe of the source
                // colour).
                place(st.clone, st.effectC, cloneBase, D, sd, z, 1);
        },
    };
    const readW = () => st.w, writeW = v => { st.w = v; };
    const WHOLE = {start: 0, end: 1};
    const endMdc = [
        opacityWindow(destination, 255, C.fadeIn, C.springEffects),
        {read: () => st.radius, write: writeRadius, to: rD, thresholds: C.shapeMask, spring: C.springSpatial},
        {read: readW, write: writeW, to: 1, thresholds: C.scaleMask},
    ];
    const endLaunch = () => [
        {read: () => st.radius, write: writeRadius, to: rD, thresholds: WHOLE},
        {read: readW, write: writeW, to: 1, thresholds: WHOLE},
    ];
    const o = launch?.opacity;
    const pattern = new Pattern({
        actors: [destination],
        driver: destination,
        spring: launch?.motion ?? C.springSpatial,
        geometry,
        free: launch ? {
            end: [{actor: destination, targets: {opacity: 255}, delay: o.delay ?? 0,
                spring: {curve: o.curve, duration: o.duration}}],
        } : {},
        windows: {
            end: launch ? endLaunch() : endMdc,
            start: [
                opacityWindow(destination, 0, C.fadeReturn, C.springEffects),
                {read: () => st.radius, write: writeRadius, to: rS, thresholds: C.shapeMaskReturn,
                    spring: C.springSpatial},
                {read: readW, write: writeW, to: 0, thresholds: C.scaleMaskReturn},
            ],
        },
        prepare: () => {
            st.added = !destination.get_effect(CORNERS_EFFECT_NAME);
            st.effectD = corners(destination);
            const e = st.effectD;
            st.saved = {compensate: e.compensate, left: e.left, top: e.top,
                width: e.width, height: e.height, radius: e.radius};
            e.compensate = true;
            e.radius = st.radius;
            destination.set_pivot_point(0, 0);
            // Source died while the pattern was inactive (between two segments).
            if (sourceDeath?.dead)
                st.sourceAlive = false;
            // Source destruction followed only while the pattern is active (disconnected by release).
            if (isActor && st.sourceAlive && !st.sourceDestroyId) {
                st.sourceDestroyId = source.connect('destroy', () => {
                    st.sourceDestroyId = 0; // disconnected by the destruction
                    st.sourceAlive = false;
                    st.hidden = false; // hiddenSources entry forgotten with the actor
                    st.clone?.destroy();
                });
            }
            if (isActor && st.sourceAlive) {
                const clone = new Clutter.Clone({source, x: 0, y: 0});
                clone.set_pivot_point(0, 0);
                parent.insert_child_below(clone, destination);
                st.clone = clone;
                st.effectC = corners(clone);
                st.effectC.compensate = true;
                st.effectC.radius = st.radius;
                clone.connect('destroy', () => {
                    st.clone = null;
                    st.effectC = null;
                });
                if (hide) {
                    hideSource(source);
                    st.hidden = true;
                }
            }
        },
        release: dead => {
            st.clone?.destroy();
            if (st.hidden && st.sourceAlive)
                restoreSource(source);
            st.hidden = false;
            if (st.sourceDestroyId)
                source.disconnect(st.sourceDestroyId);
            st.sourceDestroyId = 0;
            const e = st.effectD;
            st.effectD = null;
            // Destination destroyed: its effect leaves with it.
            if (!e || dead)
                return;
            if (st.added && !keepCorners) {
                destination.remove_effect(e);
            } else {
                const s = st.saved;
                e.compensate = s.compensate;
                e.left = s.left;
                e.top = s.top;
                e.width = s.width;
                e.height = s.height;
                if (st.added)
                    e.radius = st.radius;
            }
        },
        onDone,
    });
    pattern._containerState = st; // bench: clone, effects
    if (reverse) {
        // At rest at the end: destination in place (u = 1), container at its bounds, destination
        // radius; the current opacity is kept.
        st.w = 1;
        st.radius = rD;
        pattern._travel = geometry.length;
        return pattern.target('start');
    }
    destination.opacity = 0;
    return pattern.target('end');
}

// Diagnostics for the bench: hidden sources.
export const _hiddenSources = () => hiddenSources.size;
