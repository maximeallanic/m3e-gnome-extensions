// Window helpers of the bench: displayed frame of a window, jumps, curve fitting, settled client windows.
import {FRAME_MS, round3, wait, waitUntil} from '../tools.js';
import {motion} from './under-test.js';

// Rectangle of the window frame (without the CSD shadows) inside its buffer, in logical px local to the actor.
// Computed here from mutter's rectangles, independently of the extension under test.
export function frameZone(w) {
    const buffer = w.get_buffer_rect(), frame = w.get_frame_rect();
    return {x: frame.x - buffer.x, y: frame.y - buffer.y, w: frame.width, h: frame.height};
}

// Displayed rectangle of a window frame (without the shadows), in logical px of the scene.
export function readWindow(w, actor = null, zone = null) {
    const a = actor ?? w?.get_compositor_private?.();
    if (!a)
        return {present: false};
    let ext;
    try {
        ext = a.get_transformed_extents();
    } catch {
        return {present: false};
    }
    const z = zone ?? frameZone(w);
    const c = a.get_effect('m3e-corners');
    return {
        present: true, vis: a.visible, o: a.opacity, sx: round3(a.scale_x), sy: round3(a.scale_y),
        tx: round3(a.translation_x), ty: round3(a.translation_y),
        x: round3(ext.origin.x + z.x * a.scale_x), y: round3(ext.origin.y + z.y * a.scale_y),
        w: round3(z.w * a.scale_x), h: round3(z.h * a.scale_y),
        corners: c ? round3(c.radius) : null,
    };
}

export const center = r => ({x: r.x + r.w / 2, y: r.y + r.h / 2});
export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const frameOf = w => {
    const f = w.get_frame_rect();
    return {x: f.x, y: f.y, w: f.width, h: f.height};
};
export const rectGap = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.w - b.w),
    Math.abs(a.h - b.h));

// Largest jump between two consecutive visible frames (centre and width of the displayed rectangle), brought back to
// one display period (a lost frame doubles the displacement without being a jump).
export function biggestJump(trace) {
    let max = 0;
    let prev = null;
    for (const e of trace) {
        if (!e.present || !e.vis || !(e.o > 0) || e.w === undefined) {
            prev = null;
            continue;
        }
        const c = center(e);
        if (prev) {
            const frames = Math.max(1, Math.round((e.t - prev.t) / FRAME_MS));
            max = Math.max(max, Math.max(distance(c, prev), Math.abs(e.w - prev.w)) / frames);
        }
        prev = {...c, w: e.w, t: e.t};
    }
    return round3(max);
}

// Max difference (units of y) between a trace [{t, y}] (t in real ms) and a fixed-duration curve going from y0 to y1 in
// durationMs x slowdown, the start being searched within +-2 frames of the first frame of the trace (the movement
// starts between two frames; `framesBefore`: more frames before, when the first painted frame comes late).
// Returns {gap, offset}.
export function curveGap(trace, y0, y1, curve, durationMs, slowdown, curveValue, framesBefore = 2) {
    if (!trace.length)
        return {gap: Infinity, offset: 0};
    let best = {gap: Infinity, offset: 0};
    for (let d = -framesBefore * FRAME_MS; d <= 2 * FRAME_MS; d += 0.5) {
        const t0 = trace[0].t + d;
        let gap = 0;
        for (const e of trace) {
            const x = (e.t - t0) / (durationMs * slowdown);
            gap = Math.max(gap, Math.abs(e.y - (y0 + (y1 - y0) * curveValue(curve, Math.min(1, Math.max(0, x))))));
        }
        if (gap < best.gap)
            best = {gap, offset: d};
    }
    return best;
}

// Client started and window settled (opening animation finished): returns {w, client}.
export async function settledWindow(scene, title = 'Bench window', mode = 'window') {
    const windows = await motion('motion/windows.js');
    const client = scene.launchClient(mode, title);
    // Actor shown (map received, opening effect started), then effect finished.
    const w = await waitUntil(() => client.windows[0]?.get_compositor_private()?.mapped && client.windows[0], 10000);
    if (!w)
        throw new Error('client window did not appear');
    await wait(100);
    await waitUntil(() => windows._diagnostic().effects === 0 && windows._diagnostic().shadows === 0 &&
        w.get_compositor_private().scale_x === 1, 5000);
    await wait(300);
    return {w, client};
}

// A window actor at rest: opaque, unscaled, untranslated, no corners effect, no window effect running.
export async function checkWindowAtRest(checks, w, label) {
    const windows = await motion('motion/windows.js');
    const a = w.get_compositor_private();
    checks.ok(`${label}: actor at rest`, a && a.opacity === 255 && a.scale_x === 1 && a.scale_y === 1 &&
        a.translation_x === 0 && a.translation_y === 0,
    a ? `o=${a.opacity} s=${a.scale_x},${a.scale_y} t=${a.translation_x},${a.translation_y}` : 'missing');
    checks.ok(`${label}: no m3e-corners effect left`, a && !a.get_effect('m3e-corners'));
    const d = windows._diagnostic();
    checks.ok(`${label}: no window effect running`, d.effects === 0 && d.shadows === 0, JSON.stringify(d));
}
