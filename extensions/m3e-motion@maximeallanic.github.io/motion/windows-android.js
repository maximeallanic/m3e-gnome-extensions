// Android window motions (values: shared/data/android-source.json, ANDROID of tokens.js):
//   launchFromIcon: app launch of the Android launcher: the bounds go from the icon to the window frame in 500 ms on
//     the emphasized path, corners from the icon's to the window's; opacity goes from 0 to 1 in 50 ms after 25 ms
//     (on a phone the floating icon fades above the window during that time; the Shell has no floating icon, so the
//     window appears in the same interval);
//   openActivity: opening of a window without a source (activity_open_enter): horizontal slide of 96 dp x 56/72 to
//     its place in 450 ms emphasized (fast_out_extra_slow_in), opacity 0 -> 1 in 83 ms after 50 ms;
//   returnToIcon: closing of a window that has an icon in the dock, on the springs of the swipe-to-home return
//     (RectFSpringAnim: center X 450 / 0.965, center Y 400 / 0.95, size 500 / 0.99), from the displayed geometry; the
//     content covers the rectangle (cropped, like the launcher's thumbnail), corners toward the icon's, opacity on the
//     return window of the container transform (fadeReturn) applied to the least advanced of the three progresses.
// Each function returns an object {android, running, stop()} (or the toolkit pattern) that windows.js keeps in
// e.pattern.
import Graphene from 'gi://Graphene';

import {animate, virtualProperty, removeProperty} from '../m3e/animate.js';
import {corners, CORNERS_EFFECT_NAME} from '../m3e/corners.js';
import {ANDROID, PATTERNS} from '../m3e/tokens.js';
import {containerTransform, windowProgress} from '../m3e/patterns.js';
import {clamp01, initialShrink, mix, shrinkFrame, travelProgress} from './geometry.js';


// Several animations led together; onDone() when all have finished.
function group(start, onDone) {
    let remaining = 0;
    const part = () => {
        if (--remaining === 0)
            onDone?.();
    };
    const anims = start(() => {
        remaining++;
        return part;
    });
    return {
        android: true,
        anims,
        get running() {
            return anims.some(a => a.running);
        },
        stop() {
            for (const a of anims)
                a.stop();
        },
    };
}

export function launchFromIcon(actor, note, {destinationRadius, content, onDone}) {
    const L = ANDROID.launch;
    return containerTransform(note.rect, actor, {
        sourceRadius: note.radius, destinationRadius, content, keepCorners: true, onDone,
        launch: {
            motion: {curve: L.curve, duration: L.durationMs},
            opacity: {curve: 'Linear', duration: L.alphaDurationMs, delay: L.alphaDelayMs},
        },
    });
}

export function openActivity(actor, {onDone}) {
    const O = ANDROID.activityOpen;
    actor.opacity = 0;
    actor.translation_x = O.slideDp * ANDROID.density;
    return group(part => [
        animate(actor, {translation_x: 0}, {spring: {curve: O.curve, duration: O.durationMs}, onDone: part()}),
        animate(actor, {opacity: 255}, {spring: {curve: 'Linear', duration: O.alphaDurationMs},
            delay: O.alphaDelayMs, onDone: part()}),
    ], onDone);
}

// Displayed rectangle (scene px) of a local rectangle of the actor, transforms included.
function displayedRect(actor, r) {
    const a = actor.apply_transform_to_point(new Graphene.Point3D({x: r.x, y: r.y, z: 0}));
    const b = actor.apply_transform_to_point(new Graphene.Point3D({x: r.x + r.w, y: r.y + r.h, z: 0}));
    return {x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y)};
}

const PROP_NAMES = ['m3e-return-x', 'm3e-return-y', 'm3e-return-s'];

export function returnToIcon(actor, icon, {iconRadius, windowRadius, content: z, previous, onDone}) {
    const R = ANDROID.returnHome;
    // Start: what is displayed (clip of a running corners effect, else the frame), before stopping the previous one.
    const c = actor.get_effect(CORNERS_EFFECT_NAME);
    const local = c && c.width >= 0 ? {x: c.left, y: c.top, w: c.width, h: c.height} : z;
    const shown = displayedRect(actor, local);
    const shownRadius = c ? c.radius : windowRadius;
    previous?.stop();

    const [px, py] = actor.get_parent().get_transformed_position();
    const base = {x: px + actor.x, y: py + actor.y};
    const ic = {cx: icon.x + icon.width / 2, cy: icon.y + icon.height / 2, w: icon.width, h: icon.height};
    const s0 = initialShrink(z.w, ic.w, shown.w);
    const e = {cx: shown.x + shown.w / 2, cy: shown.y + shown.h / 2, s: s0};
    const radius0 = shownRadius;
    const cx0 = e.cx, cy0 = e.cy;
    const effect = corners(actor);
    effect.compensate = true;
    actor.set_pivot_point(0, 0);
    const fade = PATTERNS.containerTransform.fadeReturn;

    const write = () => {
        const f = shrinkFrame(z, ic, e.s);
        const k = f.scale;
        actor.set_scale(k, k);
        actor.translation_x = e.cx - base.x - (z.x + z.w / 2) * k;
        actor.translation_y = e.cy - base.y - (z.y + z.h / 2) * k;
        effect.left = f.left;
        effect.top = f.top;
        effect.width = f.width;
        effect.height = f.height;
        effect.radius = mix(radius0, iconRadius, clamp01((e.s - s0) / (1 - s0 || 1)));
        // Opacity on the least advanced of the three progresses (the window only fades as it arrives).
        actor.opacity = Math.round(255 * (1 - windowProgress(Math.min(travelProgress(e.s, s0, 1),
            travelProgress(e.cx, cx0, ic.cx), travelProgress(e.cy, cy0, ic.cy)), fade)));
    };
    const prop = (name, key) => virtualProperty(actor, name, {read: () => e[key], write: v => {
        e[key] = v;
        write();
    }});
    const paths = {cx: prop(PROP_NAMES[0], 'cx'), cy: prop(PROP_NAMES[1], 'cy'), s: prop(PROP_NAMES[2], 's')};
    write();
    const dropProps = () => {
        for (const n of PROP_NAMES)
            removeProperty(actor, n);
    };
    const g = group(part => [
        animate(actor, {[paths.cx]: ic.cx}, {spring: R.x, threshold: 0.5, onDone: part()}),
        animate(actor, {[paths.cy]: ic.cy}, {spring: R.y, threshold: 0.5, onDone: part()}),
        animate(actor, {[paths.s]: 1}, {spring: R.scale, threshold: 0.5 / Math.max(z.w, z.h, 1), onDone: part()}),
    ], () => {
        dropProps();
        onDone?.();
    });
    const stop = g.stop.bind(g);
    g.stop = () => {
        stop();
        dropProps();
    };
    return g;
}
