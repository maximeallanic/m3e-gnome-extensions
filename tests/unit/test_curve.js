// Tests of curve.js (Android fixed-duration curves): endpoints, monotonicity, known points, continuity of
// the emphasized path, state of a motion (displacement and velocity) against a numerical derivative.
import {value, slope, curveState, isCurve} from '../../shared/m3e/curve.js';
import {CURVES} from '../../shared/m3e/tokens.js';
import {assert, readText, run} from './harness.js';

function test_endpoints_monotonic() {
    assert(Object.keys(CURVES).length >= 6, 'CURVES: at least 6 curves');
    for (const name of Object.keys(CURVES)) {
        assert(value(name, 0) === 0 && value(name, 1) === 1, `${name}: endpoints`);
        let previous = 0;
        for (let i = 1; i <= 200; i++) {
            const y = value(name, i / 200);
            assert(y >= previous - 1e-9, `${name}: not monotonic at ${i / 200}`);
            previous = y;
        }
    }
}

// Reference points: cubic-bezier(0.4, 0, 0.2, 1) at x = 0.5 is 0.7756 (browser / Android value);
// emphasized: (0.166666, 0.4) is the joint of the two segments of the path.
function test_known_points() {
    assert(Math.abs(value('FastOutSlowIn', 0.5) - 0.7756) < 1e-3, `FOSI(0.5) = ${value('FastOutSlowIn', 0.5)}`);
    assert(Math.abs(value('Emphasized', 0.166666) - 0.4) < 1e-6, `emphasized at the joint = ${value('Emphasized', 0.166666)}`);
    assert(Math.abs(value('Linear', 0.3) - 0.3) < 1e-6, 'linear');
    const before = value('Emphasized', 0.166666 - 1e-6), after = value('Emphasized', 0.166666 + 1e-6);
    assert(Math.abs(after - before) < 1e-4, `emphasized continuous at the joint: ${before} / ${after}`);
    // AccelerateDecelerate fitted on cos((x + 1)π)/2 + 0.5.
    for (let i = 0; i <= 20; i++) {
        const x = i / 20;
        const ref = Math.cos((x + 1) * Math.PI) / 2 + 0.5;
        assert(Math.abs(value('AccelerateDecelerate', x) - ref) < 2e-3, `AccelerateDecelerate(${x})`);
    }
}

function test_motion_state() {
    const m = {curve: 'FastOutSlowIn', duration: 400};
    assert(curveState(m, -100, 0).x === -100, 'start');
    assert(curveState(m, -100, 400).x === 0 && curveState(m, -100, 500).v === 0, 'at rest after the duration');
    for (const t of [10, 100, 200, 350]) {
        const h = 0.01;
        const numeric = (curveState(m, -100, t + h).x - curveState(m, -100, t - h).x) / (2 * h) * 1000;
        const v = curveState(m, -100, t).v;
        assert(Math.abs(numeric - v) <= 1e-3 * Math.max(1, Math.abs(v)), `velocity at ${t} ms: ${v} != ${numeric}`);
    }
    assert(Math.abs(slope('Linear', 0.5) - 1) < 1e-6, 'linear slope');
    assert(isCurve(m) && !isCurve({stiffness: 1, damping: 1}) && !isCurve('DefaultSpatial'), 'isCurve');
}

function test_inline_segments_and_errors() {
    assert(Math.abs(value({segments: [[0, 0, 0.333333, 0.333333, 0.666667, 0.666667, 1, 1]]}, 0.5) - 0.5) < 1e-4,
        'inline segments');
    let threw = false;
    try {
        value('NoSuchCurve', 0.5);
    } catch {
        threw = true;
    }
    assert(threw, 'unknown curve name must throw');
}

function test_no_gi_import() {
    assert(!readText('../../shared/m3e/curve.js').includes('gi://'), 'curve.js must not import gi://');
}

run({test_endpoints_monotonic, test_known_points, test_motion_state, test_inline_segments_and_errors,
    test_no_gi_import});
