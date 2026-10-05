// Tests of spring.js: Compose reference values and edge cases.
import {state, duration, progress} from '../../shared/m3e/spring.js';
import {assert, readText, run} from './harness.js';

function test_compose_values() {
    const values = JSON.parse(readText('data/reference-values.json'));
    // An empty table would let the loops pass without comparing anything.
    assert(Array.isArray(values.states) && values.states.length > 0, 'reference-values.json: no reference state');
    for (const l of values.states) {
        const s = state({stiffness: l.stiffness, damping: l.damping}, l.x0, l.v0, l.tMs);
        const id = `${l.spring} x0=${l.x0} v0=${l.v0} t=${l.tMs}`;
        assert(Math.abs(s.x - l.x) <= 1e-6 * Math.max(1, Math.abs(l.x)), `x ${id}: ${s.x} != ${l.x}`);
        assert(Math.abs(s.v - l.v) <= 1e-6 * Math.max(1, Math.abs(l.v)), `v ${id}: ${s.v} != ${l.v}`);
    }
    let skipped = 0;
    for (const l of values.durations) {
        // Compose does not short-circuit |x0| <= threshold without velocity: it returns 0 or a negative
        // duration (-16, -51...). Decision R4: spring.js returns 0 in that case, so these lines are not
        // comparable with the reference.
        if (Math.abs(l.x0) <= l.threshold && l.v0 === 0) {
            skipped++;
            continue;
        }
        const d = duration({stiffness: l.stiffness, damping: l.damping}, l.x0, l.v0, l.threshold);
        assert(Math.abs(d - l.ms) <= 1, `duration ${l.spring} x0=${l.x0} v0=${l.v0} threshold=${l.threshold}: ${d} != ${l.ms}`);
    }
    assert(skipped > 0, 'no duration line skipped: the shortcut is no longer covered');
    assert(values.durations.length > skipped,
        `reference-values.json: no duration compared (${values.durations.length} lines, ${skipped} skipped)`);
}

function test_duration_under_threshold() {
    assert(duration('DefaultSpatial', 0.3, 0, 0.5) === 0, 'duration under the threshold must be 0');
    for (const n of ['FastSpatial', 'DefaultEffects', 'SlowEffects'])
        assert(duration(n, 0.3, 0, 0.5) === 0, `negative duration not clamped to 0 for ${n}`);
}

function test_large_distance() {
    const g = duration('DefaultSpatial', 5120, 0, 0.5);
    assert(Number.isFinite(g), `duration 5120 not finite: ${g}`);
    assert(g > duration('DefaultSpatial', 40, 0, 0.5), 'duration 5120 must exceed the one of 40');
    assert(g < 3000, `duration 5120 too long: ${g}`);
}

function test_extreme_velocity() {
    const d = duration('FastSpatial', 0, 20000, 0.5);
    assert(Number.isFinite(d) && d > 0, `extreme velocity duration: ${d}`);
    const omega = Math.sqrt(800);
    let max = 0;
    for (let t = 0; t <= d; t++) {
        const s = state('FastSpatial', 0, 20000, t);
        assert(!Number.isNaN(s.x) && !Number.isNaN(s.v), `NaN at t=${t}`);
        max = Math.max(max, Math.abs(s.x));
    }
    assert(max < 20000 / omega, `overshoot ${max} >= ${20000 / omega}`);
}

function test_progress_bounds() {
    for (const n of ['DefaultSpatial', 'FastSpatial', 'SlowSpatial', 'DefaultEffects', 'FastEffects', 'SlowEffects']) {
        assert(progress(n, 40, 0, 0) === 0, `progress(0) != 0 for ${n}`);
        const p = progress(n, 40, 0, duration(n, 40, 0, 0.5));
        // The Compose estimate of critical springs (Effects) stops at 1 ms of Newton precision and leaves
        // |x| ≈ 0.509 instead of 0.5: 10 % margin.
        assert(Math.abs(1 - p) <= 0.55 / 40, `final progress ${n}: ${p}`);
    }
}

function test_unknown_spring_throws() {
    let threw = false;
    try {
        state('NoSuchSpring', 1, 0, 10);
    } catch {
        threw = true;
    }
    assert(threw, 'unknown spring name must throw');
}

function test_no_gi_import() {
    assert(!readText('../../shared/m3e/spring.js').includes('gi://'), 'spring.js must not import gi://');
}

run({test_compose_values, test_duration_under_threshold, test_large_distance, test_extreme_velocity,
    test_progress_bounds, test_unknown_spring_throws, test_no_gi_import});
