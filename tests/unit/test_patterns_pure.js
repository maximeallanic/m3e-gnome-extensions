// Pure tests of patterns.js (C, 2026-10-04): windowProgress, the curve of the fade and mask windows
// (rule 2 of pattern.js), without any Clutter scene. Same typelib paths as test_animate_pure.js.
import {duration, progress} from '../../shared/m3e/spring.js';
import {THRESHOLDS} from '../../shared/m3e/tokens.js';
import {addShellTypelibPaths, assert, run} from './harness.js';

addShellTypelibPaths();
const {windowProgress} = await import('../../shared/m3e/patterns.js');

const F = {start: 0.35, end: 1};

function test_bounds() {
    for (const r of [null, 'DefaultEffects', 'FastEffects']) {
        assert(windowProgress(0, F, r) === 0, `${r}: p = 0`);
        assert(windowProgress(0.35, F, r) === 0, `${r}: p = start`);
        assert(windowProgress(1, F, r) === 1, `${r}: p = end`);
        assert(windowProgress(1.2, F, r) === 1, `${r}: p > 1 clamped`);
        assert(windowProgress(-0.3, F, r) === 0, `${r}: p < 0 clamped`);
    }
}

function test_linear_without_spring() {
    const v = windowProgress(0.675, F, null);
    assert(Math.abs(v - 0.5) < 1e-12, `linear middle ${v}`);
}

function test_monotonic() {
    let previous = -1;
    for (let i = 0; i <= 200; i++) {
        const v = windowProgress(i / 200, F, 'DefaultEffects');
        assert(v >= previous - 1e-12, `not monotonic at ${i / 200}`);
        previous = v;
    }
}

// Rule 2: c(q) = 1 + state(R, -1, 0, q·T).x, T = duration(R, -1, 0, THRESHOLDS.unit).
function test_spec_rule() {
    const R = 'DefaultEffects';
    const T = duration(R, -1, 0, THRESHOLDS.unit);
    for (const p of [0.4, 0.5, 0.8, 0.95]) {
        const q = (p - F.start) / (F.end - F.start);
        const expected = progress(R, -1, 0, q * T);
        const v = windowProgress(p, F, R);
        assert(Math.abs(v - expected) < 1e-12, `p = ${p}: ${v} != ${expected}`);
    }
}

run({test_bounds, test_linear_without_spring, test_monotonic, test_spec_rule});
