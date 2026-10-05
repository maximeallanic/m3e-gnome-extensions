// Independent model of the transition patterns (same convention as pattern.js, recomputed with spring.js and
// PATTERNS alone):
//  - a master "travel" in logical px, from 0 to L (L = largest displacement of an actor edge), driven by the
//    pattern's Spatial spring with the 0.5 px threshold; u = travel / L; every geometric property is
//    (1 - u) * start + u * end;
//  - p = spatial progress of the segment = clamp((u - u0) / (uTarget - u0), 0, 1) (1 if uTarget = u0), u0 = position
//    at the start of the segment;
//  - window [a, b] of p: q = (p - a) / (b - a) clamped to [0, 1], value = (1 - c(q)) * from + c(q) * to,
//    c(q) = 1 + state(R, -1, 0, q * T).x, T = duration(R, -1, 0, 0.01), c(0) = 0 and c(1) = 1 exactly; R = spring
//    of the window (Effects for opacity, Spatial for radius); without spring (scale mask), c(q) = q;
//  - opacity read as an integer (0-255): difference expressed against 255.
import St from 'gi://St';

import {state, duration} from '../m3e/spring.js';
import {THRESHOLDS} from '../m3e/tokens.js';
import {waitUntil} from '../tools.js';
import {realDuration, segmentState, summary, finishAndFrame} from './engine-model.js';

export const patterns = () => import('../m3e/patterns.js');
export const cornersModule = () => import('../m3e/corners.js');

export function curveModel(spring, q) {
    if (q <= 0)
        return 0;
    if (q >= 1)
        return 1;
    if (!spring)
        return q;
    return 1 + state(spring, -1, 0, q * duration(spring, -1, 0, THRESHOLDS.unit)).x;
}

export function windowModel(f, p) {
    const q = p >= f.w.end ? 1 : p <= f.w.start ? 0 : (p - f.w.start) / (f.w.end - f.w.start);
    const c = curveModel(f.spring, q);
    return (1 - c) * f.from + c * f.to;
}

export const mixModel = (a, b, u) => (1 - u) * a + u * b;

// Spatial progress of segment `e` ({master, L, u0, ut}) at time `elapsed`.
export function pModel(e, elapsed) {
    if (e.ut === e.u0)
        return 1;
    const u = segmentState(e.master, elapsed).value / e.L;
    return Math.min(1, Math.max(0, (u - e.u0) / (e.ut - e.u0)));
}

export function boundsOf(actor) {
    const r = actor.get_transformed_extents();
    return {x: r.origin.x, y: r.origin.y, w: r.size.width, h: r.size.height};
}

// Expected bounds (scene frame) of an actor placed at (x, y), size (w, h), with translation (tx, ty), scale (sx, sy)
// and normalised pivot (px, py).
export function boundsModel({x, y, w, h}, {tx = 0, ty = 0, sx = 1, sy = 1, px = 0, py = 0}) {
    return {x: x + tx + px * w * (1 - sx), y: y + ty + py * h * (1 - sy), w: w * sx, h: h * sy};
}

// Largest edge displacement between two bounds.
export function displacementModel(a, b) {
    return Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y),
        Math.abs(b.x + b.w - a.x - a.w), Math.abs(b.y + b.h - a.y - a.h));
}

export function patternActor(scene, {x, y, w, h, color}) {
    const a = new St.Widget({x, y, width: w, height: h, style: `background-color: ${color};`});
    scene.container.add_child(a);
    return a;
}

// Reads `read()` ({key: value}) on every frame; ctx = {pattern, segs: [{master, ...}]},
// expected(entry, elapsed) -> {key: value}. `units`: {key: 'px'|'opacity'}.
export async function patternCurve(scene, {ctx, driver, read, expected, units, done, guardMs, before = null}) {
    const marks = [];
    const proxy = {get v() { return read(); }};
    const promise = scene.sample(proxy, ['v'], {
        elapsed: () => {
            const s = ctx.pattern?.timing() ?? {elapsed: 0, duration: 0};
            marks.push({seg: ctx.segs.length - 1, engineDuration: s.duration});
            return s.elapsed;
        },
        until: finishAndFrame(scene, driver, done, guardMs),
    });
    const off = before ? scene.onEveryFrame(before) : null;
    let samples;
    try {
        samples = await promise;
    } finally {
        off?.();
    }
    const series = {}, badDurations = [];
    for (const k of Object.keys(units))
        series[k] = [];
    samples.forEach((r, i) => {
        const m = marks[i];
        const entry = ctx.segs[m.seg];
        const exp = realDuration(entry.master);
        if (m.engineDuration !== exp &&
            !badDurations.some(d => d.segment === m.seg && d.engine === m.engineDuration))
            badDurations.push({segment: m.seg, engine: m.engineDuration, expected: exp});
        const a = expected(entry, r.elapsed_ms);
        for (const k of Object.keys(units)) {
            // Missing value (auxiliary actor already destroyed): no sample.
            if (r.values.v[k] === undefined)
                continue;
            series[k].push({t_ms: r.t_ms, elapsed_ms: r.elapsed_ms, value: r.values.v[k],
                expected: a[k], segment: m.seg});
        }
    });
    const diffs = {};
    let ok = badDurations.length === 0, nan = false;
    for (const [k, u] of Object.entries(units)) {
        const b = summary(series[k], u === 'opacity' ? 255 : 1);
        diffs[k] = b.maxDiff;
        nan ||= b.nan;
        ok &&= !b.nan && b.maxDiff <= (u === 'opacity' ? 0.01 : 0.5);
    }
    const first = series[Object.keys(units)[0]];
    const b0 = summary(first);
    const last = Object.fromEntries(Object.keys(units).map(k => [k, series[k].at(-1)?.value]));
    return {ok: ok && samples.length > 3, series, detail: {diffs, nan, badDurations, frames: samples.length,
        periodMs: b0.periodMs, lostFrames: b0.lostFrames, last}};
}

// Final "curve" result of a pattern: ok if differences, durations, onDone and final values are right.
export function patternResult(r, done, expectedFinal, extra = {}) {
    const finalsOk = Object.entries(expectedFinal).every(([k, v]) => Math.abs(r.detail.last[k] - v) < 1e-3);
    return {type: 'curve', unit: 'px', singleActor: false,
        ok: r.ok && done.calls === 1 && finalsOk,
        detail: {...r.detail, doneCalls: done.calls, finalsOk, expectedFinal, ...extra},
        series: r.series};
}

// MDC container transform model (MaterialContainerTransform.updateProgress, AUTO fit, linear path), recomputed
// here: top-centre point from r0 to r1, fitted dimension linear in u, uniform-scale contents, container (clip
// area) = the other dimension mixed by w (scale mask).
export function containerModel(r0, r1, u, w) {
    const byWidth = r1.h * r0.w / r1.w >= r0.h;
    const cx = mixModel(r0.x + r0.w / 2, r1.x + r1.w / 2, u);
    const y = mixModel(r0.y, r1.y, u);
    const sa = byWidth ? mixModel(r0.w, r1.w, u) / r1.w : mixModel(r0.h, r1.h, u) / r1.h;
    const sd = byWidth ? mixModel(r0.w, r1.w, u) / r0.w : mixModel(r0.h, r1.h, u) / r0.h;
    const A = {x: cx - r1.w * sa / 2, y, w: r1.w * sa, h: r1.h * sa};
    const D = {x: cx - r0.w * sd / 2, y, w: r0.w * sd, h: r0.h * sd};
    const zw = byWidth ? A.w : mixModel(D.w, A.w, w);
    const zh = byWidth ? mixModel(D.h, A.h, w) : A.h;
    return {A, D, z: {x: cx - zw / 2, y, w: zw, h: zh}, sa, byWidth};
}

// Pilot effects ("m3e-pattern-*": travel drivers) still set on an actor.
export const driverEffects = actor => actor.get_effects()
    .map(e => e.get_name()).filter(n => n?.startsWith('m3e-pattern-'));

// Waits until a pattern has run `part` of its segment duration (bounded).
export const waitForPart = (pattern, part, ms = 3000) => waitUntil(() => {
    const s = pattern.timing();
    return s.duration > 0 && s.elapsed >= part * s.duration;
}, ms);
