// Pure tests of animate.js: planning (_plan) and spring / threshold choice, without a Clutter scene.
// animate.js imports gi://Clutter and gi://St: only the typelib paths of mutter and the Shell are added
// (no actor, no clock is created here).
import {duration} from '../../shared/m3e/spring.js';
import {addShellTypelibPaths, assert, run} from './harness.js';

addShellTypelibPaths();
const {_plan, _springFor, _thresholdFor} = await import('../../shared/m3e/animate.js');

function test_zero_distance_no_velocity() {
    const p = _plan(100, 0, 100, 'DefaultSpatial', 0.5);
    assert(p.driver === 'none', `driver ${p.driver} != none`);
    assert(p.durationMs === 0, `duration ${p.durationMs} != 0`);
}

function test_zero_distance_with_velocity() {
    const p = _plan(100, 500, 100, 'DefaultSpatial', 0.5);
    assert(p.driver === 'frame', `driver ${p.driver} != frame`);
    assert(p.x0 === 0 && p.v0 === 500, `x0/v0 ${p.x0}/${p.v0}`);
    assert(p.durationMs > 0 && Number.isFinite(p.durationMs), `duration ${p.durationMs}`);
}

function test_distance_under_threshold() {
    const p = _plan(100.3, 0, 100, 'DefaultSpatial', 0.5);
    assert(p.driver === 'none', `driver ${p.driver} != none`);
}

function test_distance_100() {
    const p = _plan(0, 0, 100, 'DefaultSpatial', 0.5);
    assert(p.driver === 'frame', `driver ${p.driver} != frame`);
    assert(p.x0 === -100, `x0 ${p.x0} != -100`);
    assert(p.durationMs === duration('DefaultSpatial', -100, 0, 0.5), `duration ${p.durationMs}`);
}

function test_invalid_values() {
    const p = _plan(NaN, 0, 100, 'DefaultSpatial', 0.5);
    assert(p.driver === 'none', `NaN: driver ${p.driver} != none`);
}

function test_spring_per_property() {
    assert(_springFor('translation_x', 'Default') === 'DefaultSpatial', 'translation_x → DefaultSpatial');
    assert(_springFor('opacity', 'Fast') === 'FastEffects', 'opacity → FastEffects');
    assert(_springFor('scale_x', 'Slow') === 'SlowSpatial', 'scale_x → SlowSpatial');
    assert(_springFor('@effects.m3e-corners.radius', 'Default') === 'DefaultSpatial', 'effect radius → Spatial');
    assert(_springFor('background_color', 'Default') === 'DefaultEffects', 'colour → Effects');
    assert(_springFor('background_color', 'FastSpatial') === 'FastEffects', 'colour: Effects forced');
    assert(_springFor('opacity', {opacity: 'FastEffects'}) === 'FastEffects', 'per-property table');
    assert(_springFor('x', 'SlowSpatial') === 'SlowSpatial', 'full name');
    assert(_springFor('x', 'ComposeSpringDefault') === 'ComposeSpringDefault', 'Android spring outside the families');
    const curve = {curve: 'Emphasized', duration: 100};
    assert(_springFor('x', curve) === curve, 'fixed-duration motion kept as is');
}

function test_threshold_per_property() {
    assert(Math.abs(_thresholdFor('opacity') - 2.55) < 1e-9, `opacity ${_thresholdFor('opacity')}`);
    assert(_thresholdFor('scale_y') === 0.01, 'scale_y');
    assert(_thresholdFor('rotation_angle_z') === 0.1, 'rotation');
    assert(_thresholdFor('translation_y') === 0.5, 'translation_y');
    assert(_thresholdFor('@effects.m3e-corners.radius') === 0.5, 'effect');
}

// Virtual properties (C): '@v.<name>' path treated as a spatial quantity (Spatial spring, 0.5 threshold by
// default), never as a colour, name kept as is.
function test_virtual_property() {
    assert(_springFor('@v.state', 'Default') === 'DefaultSpatial', '@v.state → DefaultSpatial');
    assert(_springFor('@v.background-color', 'Default') === 'DefaultSpatial', '@v.*color is not a colour');
    assert(_thresholdFor('@v.state') === 0.5, `threshold @v.state ${_thresholdFor('@v.state')}`);
    assert(_springFor('@v.a-b', {'@v.a-b': 'FastSpatial'}) === 'FastSpatial', 'dashed name kept');
}

run({test_virtual_property, test_zero_distance_no_velocity, test_zero_distance_with_velocity,
    test_distance_under_threshold, test_distance_100, test_invalid_values,
    test_spring_per_property, test_threshold_per_property});
