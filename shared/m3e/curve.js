// Fixed-duration easing curves (Android: PathInterpolator, cubic-bezier), no GI import.
// Counterpart of spring.js for the motions that Android tunes with a duration and a curve rather than a
// spring (heads-up banner, MDC switch, app launch…).
//
// A curve is a list of cubic segments from (0, 0) to (1, 1), each given by its four absolute points
// [x0, y0, x1, y1, x2, y2, x3, y3], x increasing from one segment to the next: a CSS cubic-bezier
// (x1, y1, x2, y2) is a single segment from (0, 0) to (1, 1); Material's "emphasized" path
// (PathInterpolator) has two.
//
//   value(curve, x)             → y        (x clamped to [0, 1])
//   slope(curve, x)             → dy/dx
//   curveState(motion, x0, t)   → {x, v}   remaining displacement and velocity, like state() in spring.js
//   motion = {curve, duration} (duration in ms); curve = name of CURVES (tokens.js) or {segments}.

import {CURVES} from './tokens.js';

export function resolveCurve(curve) {
    if (typeof curve === 'string') {
        const c = CURVES[curve];
        if (!c)
            throw new Error(`unknown curve: ${curve}`);
        return c;
    }
    if (!curve || !Array.isArray(curve.segments) || curve.segments.length === 0)
        throw new Error('curve: segments expected');
    return curve;
}

const coord = (a0, a1, a2, a3, t) => {
    const u = 1 - t;
    return u * u * u * a0 + 3 * u * u * t * a1 + 3 * u * t * t * a2 + t * t * t * a3;
};

const derivative = (a0, a1, a2, a3, t) => {
    const u = 1 - t;
    return 3 * u * u * (a1 - a0) + 6 * u * t * (a2 - a1) + 3 * t * t * (a3 - a2);
};

// Parameter t of the segment for abscissa x (Newton, bisection when Newton leaves the interval).
function parameter(s, x) {
    const [x0, , x1, , x2, , x3] = s;
    let low = 0, high = 1;
    let t = (x - x0) / (x3 - x0);
    for (let i = 0; i < 50; i++) {
        const f = coord(x0, x1, x2, x3, t) - x;
        if (Math.abs(f) < 1e-12)
            break;
        if (f > 0)
            high = t;
        else
            low = t;
        const d = derivative(x0, x1, x2, x3, t);
        const next = d !== 0 ? t - f / d : NaN;
        t = next > low && next < high ? next : (low + high) / 2;
    }
    return t;
}

function segmentOf(c, x) {
    for (const s of c.segments) {
        if (x <= s[6])
            return s;
    }
    return c.segments[c.segments.length - 1];
}

export function value(curve, x) {
    const c = resolveCurve(curve);
    if (x <= 0)
        return 0;
    if (x >= 1)
        return 1;
    const s = segmentOf(c, x);
    return coord(s[1], s[3], s[5], s[7], parameter(s, x));
}

export function slope(curve, x) {
    const c = resolveCurve(curve);
    const xc = Math.min(1, Math.max(0, x));
    const s = segmentOf(c, xc);
    const t = parameter(s, xc);
    const dx = derivative(s[0], s[2], s[4], s[6], t);
    const dy = derivative(s[1], s[3], s[5], s[7], t);
    if (dx === 0)
        return dy === 0 ? 0 : Infinity;
    return dy / dx;
}

// Fixed-duration motion started at x0 (distance to the target): x(t) = x0 · (1 − y(t / duration)),
// velocity in units per second. After the duration: at rest (x = 0, v = 0).
export function curveState({curve, duration}, x0, tMs) {
    if (!(duration > 0) || tMs >= duration)
        return {x: 0, v: 0};
    const f = Math.max(0, tMs) / duration;
    return {x: x0 * (1 - value(curve, f)), v: -x0 * slope(curve, f) * 1000 / duration};
}

// Is the motion fixed-duration ({curve, duration}) rather than a spring?
export const isCurve = m => !!m && typeof m === 'object' && 'curve' in m;
