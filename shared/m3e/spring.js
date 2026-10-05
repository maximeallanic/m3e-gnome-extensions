// Pure spring engine (mass 1, final position 0), no GI import.
// Port of tools/compose_ref.py (Compose SpringSimulation and SpringEstimation, androidx, Apache-2.0),
// same formulas and same branches. JavaScript arithmetic already follows IEEE like Kotlin: division by
// zero, log(0) and overflowing exp give Infinity/NaN without throwing.
// Units: position in units, velocity in units per second, time in ms.

import {SPRINGS} from './tokens.js';

const MAX_LONG = 2 ** 63 - 1;
const MAX_LONG_MILLIS = Math.trunc(MAX_LONG / 1e6);

function resolve(spring) {
    if (typeof spring === 'string') {
        const r = SPRINGS[spring];
        if (!r)
            throw new Error(`unknown spring: ${spring}`);
        return r;
    }
    return spring;
}

// Kotlin Double.toLong(): NaN -> 0, saturation, truncation toward zero.
function toLong(x) {
    if (Number.isNaN(x))
        return 0;
    if (x >= MAX_LONG)
        return MAX_LONG;
    if (x <= -MAX_LONG)
        return -MAX_LONG;
    return Math.trunc(x);
}


// --- SpringSimulation.updateValues ------------------------------------------
export function state(spring, x0, v0, tMs) {
    const {stiffness, damping} = resolve(spring);
    const naturalFreq = Math.sqrt(stiffness);
    const dampingRatio = damping;
    const deltaT = tMs / 1000.0;
    const dampingRatioSquared = dampingRatio * dampingRatio;
    const r = -dampingRatio * naturalFreq;
    let displacement, velocity;

    if (dampingRatio > 1) { // overdamped
        const s = naturalFreq * Math.sqrt(dampingRatioSquared - 1);
        const gammaPlus = r + s;
        const gammaMinus = r - s;
        const coeffB = (gammaMinus * x0 - v0) / (gammaMinus - gammaPlus);
        const coeffA = x0 - coeffB;
        displacement = coeffA * Math.exp(gammaMinus * deltaT) + coeffB * Math.exp(gammaPlus * deltaT);
        velocity = coeffA * gammaMinus * Math.exp(gammaMinus * deltaT) +
            coeffB * gammaPlus * Math.exp(gammaPlus * deltaT);
    } else if (dampingRatio === 1.0) { // critical
        const coeffA = x0;
        const coeffB = v0 + naturalFreq * x0;
        const nFdT = -naturalFreq * deltaT;
        displacement = (coeffA + coeffB * deltaT) * Math.exp(nFdT);
        velocity = (coeffA + coeffB * deltaT) * Math.exp(nFdT) * (-naturalFreq) + coeffB * Math.exp(nFdT);
    } else { // underdamped
        const dampedFreq = naturalFreq * Math.sqrt(1 - dampingRatioSquared);
        const cosCoeff = x0;
        const sinCoeff = (1 / dampedFreq) * ((-r * x0) + v0);
        const dFdT = dampedFreq * deltaT;
        displacement = Math.exp(r * deltaT) * (cosCoeff * Math.cos(dFdT) + sinCoeff * Math.sin(dFdT));
        velocity = displacement * r + Math.exp(r * deltaT) *
            (-dampedFreq * cosCoeff * Math.sin(dFdT) + dampedFreq * sinCoeff * Math.cos(dFdT));
    }
    return {x: displacement, v: velocity};
}

// --- SpringEstimation -------------------------------------------------------
function newton(x, fn, fnPrime) {
    return x - fn(x) / fnPrime(x);
}

function estimateUnderdamped(firstRootReal, firstRootImaginary, p0, v0, delta) {
    const r = firstRootReal;
    const c1 = p0;
    const c2 = (v0 - r * c1) / firstRootImaginary;
    const c = Math.sqrt(c1 * c1 + c2 * c2);
    return Math.log(delta / c) / r;
}

function estimateCritical(firstRootReal, p0, v0, delta) {
    const r = firstRootReal;
    const c1 = p0;
    const c2 = v0 - r * c1;
    const t1 = Math.log(Math.abs(delta / c1)) / r;
    const guess = Math.log(Math.abs(delta / c2));
    let t = guess;
    for (let i = 0; i < 6; i++)
        t = guess - Math.log(Math.abs(t / r));
    const t2 = t / r;
    let tCurr;
    if (!Number.isFinite(t1))
        tCurr = t2;
    else if (!Number.isFinite(t2))
        tCurr = t1;
    else
        tCurr = Math.max(t1, t2);

    const tInflection = -((r * c1 + c2) / (r * c2));
    const xInflection = c1 * Math.exp(r * tInflection) + c2 * tInflection * Math.exp(r * tInflection);
    let signedDelta;
    if (Number.isNaN(tInflection) || tInflection <= 0.0) {
        signedDelta = -delta;
    } else if (tInflection > 0.0 && -xInflection < delta) {
        if (c2 < 0 && c1 > 0)
            tCurr = 0.0;
        signedDelta = -delta;
    } else {
        tCurr = -(2.0 / r) - c1 / c2;
        signedDelta = delta;
    }

    let tDelta = Infinity;
    let iterations = 0;
    while (tDelta > 0.001 && iterations < 100) {
        iterations++;
        const tLast = tCurr;
        tCurr = newton(tCurr,
            x => (c1 + c2 * x) * Math.exp(r * x) + signedDelta,
            x => (c2 * (r * x + 1) + c1 * r) * Math.exp(r * x));
        tDelta = Math.abs(tLast - tCurr);
    }
    return tCurr;
}

function estimateOverdamped(firstRootReal, secondRootReal, p0, v0, delta) {
    const r1 = firstRootReal;
    const r2 = secondRootReal;
    const c2 = (r1 * p0 - v0) / (r1 - r2);
    const c1 = p0 - c2;
    const t1 = Math.log(Math.abs(delta / c1)) / r1;
    const t2 = Math.log(Math.abs(delta / c2)) / r2;
    let tCurr;
    if (!Number.isFinite(t1))
        tCurr = t2;
    else if (!Number.isFinite(t2))
        tCurr = t1;
    else
        tCurr = Math.max(t1, t2);

    const tInflection = Math.log((c1 * r1) / (-c2 * r2)) / (r2 - r1);
    const xInflection = () => c1 * Math.exp(r1 * tInflection) + c2 * Math.exp(r2 * tInflection);
    let signedDelta;
    if (Number.isNaN(tInflection) || tInflection <= 0.0) {
        signedDelta = -delta;
    } else if (tInflection > 0.0 && -xInflection() < delta) {
        if (c2 > 0.0 && c1 < 0.0)
            tCurr = 0.0;
        signedDelta = -delta;
    } else {
        tCurr = Math.log(-(c2 * r2 * r2) / (c1 * r1 * r1)) / (r1 - r2);
        signedDelta = delta;
    }

    // Good initial guess: return directly.
    if (Math.abs(c1 * r1 * Math.exp(r1 * tCurr) + c2 * r2 * Math.exp(r2 * tCurr)) < 0.0001)
        return tCurr;
    let tDelta = Infinity;
    let iterations = 0;
    while (tDelta > 0.001 && iterations < 100) {
        iterations++;
        const tLast = tCurr;
        tCurr = newton(tCurr,
            t => c1 * Math.exp(r1 * t) + c2 * Math.exp(r2 * t) + signedDelta,
            t => c1 * r1 * Math.exp(r1 * t) + c2 * r2 * Math.exp(r2 * t));
        tDelta = Math.abs(tLast - tCurr);
    }
    return tCurr;
}

function estimateInternal(firstRootReal, firstRootImaginary, secondRootReal, dampingRatio,
    initialVelocity, initialPosition, delta) {
    if (initialPosition === 0.0 && initialVelocity === 0.0)
        return 0;
    const v0 = initialPosition < 0 ? -initialVelocity : initialVelocity;
    const p0 = Math.abs(initialPosition);
    let t;
    if (dampingRatio > 1.0)
        t = estimateOverdamped(firstRootReal, secondRootReal, p0, v0, delta);
    else if (dampingRatio < 1.0)
        t = estimateUnderdamped(firstRootReal, firstRootImaginary, p0, v0, delta);
    else
        t = estimateCritical(firstRootReal, p0, v0, delta);
    return toLong(t * 1000.0);
}

// Duration (integer ms) for |x| to stay under `threshold`. Compose estimation, with an explicit
// shortcut (decision R4): |x0| <= threshold without velocity -> 0, because Compose would return 0 or a
// negative duration. Any negative result is clamped to 0.
export function duration(spring, x0, v0, threshold) {
    const {stiffness, damping} = resolve(spring);
    if (Math.abs(x0) <= threshold && v0 === 0)
        return 0;
    if (damping === 0)
        return MAX_LONG_MILLIS;
    const dampingCoefficient = 2.0 * damping * Math.sqrt(stiffness);
    const partialRoot = dampingCoefficient * dampingCoefficient - 4.0 * stiffness;
    const partialRootReal = partialRoot < 0.0 ? 0.0 : Math.sqrt(partialRoot);
    const partialRootImaginary = partialRoot < 0.0 ? Math.sqrt(Math.abs(partialRoot)) : 0.0;
    const firstRootReal = (-dampingCoefficient + partialRootReal) * 0.5;
    const firstRootImaginary = partialRootImaginary * 0.5;
    const secondRootReal = (-dampingCoefficient - partialRootReal) * 0.5;
    const ms = estimateInternal(firstRootReal, firstRootImaginary, secondRootReal,
        damping, v0, x0, threshold);
    return Math.max(0, ms);
}

// Normalised progress p = 1 - x(t)/x0 (0 at start, 1 at rest).
// If x0 = 0 there is no travel to normalise: returns 1.
export function progress(spring, x0, v0, tMs) {
    if (x0 === 0)
        return 1;
    return 1 - state(spring, x0, v0, tMs).x / x0;
}
