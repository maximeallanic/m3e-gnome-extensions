// Core engine scenarios: spring curves, retargeting, gestures, bursts, slow-down, colours and effect paths.
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {SPRINGS} from '../m3e/tokens.js';
import {wait} from '../tools.js';
import {engine, newActor, segment, segmentState, measure, summary, finishAndFrame, doneSignal, simpleCurve,
    withSetting} from './engine-model.js';

// The 6 springs x 3 distances: Spatial on translation_x (from -d to 0, actor d + 50 px wide to stay visible),
// Effects on opacity (0 -> 255, d ignored).
const springScenarios = {};
for (const name of Object.keys(SPRINGS).filter(n => /^(Default|Fast|Slow)(Spatial|Effects)$/.test(n))) {
    for (const d of [40, 400, 2000]) {
        springScenarios[`spring-${name}-${d}`] = name.endsWith('Spatial')
            ? scene => simpleCurve(scene, {prop: 'translation_x', from: -d, target: 0, spring: name, width: d + 50})
            : scene => simpleCurve(scene, {prop: 'opacity', from: 0, target: 255, spring: name});
    }
}

// Retarget: DefaultSpatial 0 -> 400, then target 0 at p % of the duration.
async function interruption(scene, p) {
    const {animate} = await engine();
    const spring = 'DefaultSpatial', prop = 'translation_x';
    const actor = newActor(scene, {width: 450});
    await scene.waitFrames(1);
    const ctx = {anim: null, segs: [segment(spring, 0, 0, 400, 0.5, 1)]};
    const done = doneSignal();
    ctx.anim = animate(actor, {[prop]: 400}, {spring, onDone: done.callback});
    const thresholdT = p / 100 * ctx.segs[0].durationMs;
    let retarget = null;
    const {series, badDurations} = await measure(scene, actor, prop, ctx, finishAndFrame(scene, actor, done.promise, 5000), {
        before: () => {
            if (retarget !== null)
                return;
            const s = ctx.anim.timing(prop);
            if (s.elapsed < thresholdT)
                return;
            const e = segmentState(ctx.segs[0], s.elapsed);
            retarget = {elapsed: s.elapsed, value: e.value, velocity: e.velocity};
            ctx.segs.push(segment(spring, e.value, e.velocity, 0, 0.5, 1));
            ctx.anim.retarget({[prop]: 0});
        },
    });
    actor.destroy();
    const b = summary(series);
    const last = series[series.length - 1];
    return {
        type: 'curve', unit: 'px', singleActor: true,
        ok: done.calls === 1 && retarget !== null && !b.nan && Math.abs(last.value) < 1e-3 && badDurations.length === 0,
        detail: {...b, doneCalls: done.calls, retarget, durationMs: ctx.segs[0].durationMs, badDurations},
        series: {[prop]: series},
    };
}

// Minimal effect with a GObject property `radius` (like corners.js).
const RadiusEffect = GObject.registerClass({
    Properties: {
        radius: GObject.ParamSpec.double('radius', null, null, GObject.ParamFlags.READWRITE, 0, 1e4, 0),
    },
}, class M3eBenchRadiusEffect extends Clutter.Effect {});

// Animates until `targets`; records the values seen on every frame.
async function followToEnd(scene, actor, targets, read) {
    const {animate} = await engine();
    const done = doneSignal();
    const seen = [];
    const off = scene.onEveryFrame(() => seen.push(read()));
    try {
        animate(actor, targets, {spring: 'Default', onDone: done.callback});
        await finishAndFrame(scene, actor, done.promise, 3000);
    } finally {
        off();
    }
    return {doneCalls: done.calls, seen};
}

export const engineSpringScenarios = {
    ...springScenarios,

    // Witness: same travel as spring-DefaultSpatial-400 with the Shell's ease() (Clutter alone, no animate.js),
    // to tell frames lost by the nested Shell from those lost by the engine. expected = value (no model).
    'ease-witness': async scene => {
        const actor = newActor(scene, {width: 450});
        actor.translation_x = -400;
        await scene.waitFrames(1);
        let resolve;
        const done = new Promise(r => { resolve = r; });
        actor.ease({translation_x: 0, duration: 461, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => resolve()});
        const samples = await scene.sample(actor, ['translation_x'],
            {elapsed: () => null, until: finishAndFrame(scene, actor, done, 3000)});
        actor.destroy();
        const series = samples.map(r => ({t_ms: r.t_ms, elapsed_ms: null,
            value: r.values.translation_x, expected: r.values.translation_x}));
        return {type: 'curve', unit: 'px', singleActor: true, ok: true,
            detail: summary(series), series: {translation_x: series}};
    },

    // Effect path `@effects.<name>.<prop>` (used by corners.js).
    'effect-path': async scene => {
        const actor = newActor(scene, {width: 80});
        const effect = new RadiusEffect();
        actor.add_effect_with_name('probe', effect);
        // Like corners.js: a radius change asks for a new frame.
        effect.connect('notify::radius', () => effect.queue_repaint());
        await scene.waitFrames(1);
        const {doneCalls, seen} = await followToEnd(scene, actor, {'@effects.probe.radius': 24}, () => effect.radius);
        const final = effect.radius;
        actor.destroy();
        const intermediate = seen.filter(v => v > 0 && v < 24).length;
        return {type: 'state', ok: doneCalls === 1 && final === 24 && intermediate > 3,
            detail: {doneCalls, final, intermediate, seen: seen.slice(0, 8)}};
    },

    // Colour: Effects spring, bounded progress, exact final colour.
    color: async scene => {
        const actor = newActor(scene, {width: 80});
        actor.background_color = new Cogl.Color({red: 0, green: 0, blue: 255, alpha: 255});
        await scene.waitFrames(1);
        const read = () => {
            const c = actor.background_color;
            return [c.red, c.green, c.blue, c.alpha];
        };
        const {doneCalls, seen} = await followToEnd(scene, actor, {background_color: '#ff0000'}, read);
        const final = read();
        actor.destroy();
        const bounded = seen.every(([r, , b]) => r >= 0 && r <= 255 && b >= 0 && b <= 255 && r + b <= 256);
        const intermediate = seen.filter(([r]) => r > 0 && r < 255).length;
        return {type: 'state', ok: doneCalls === 1 && final.join() === '255,0,0,255' && bounded && intermediate > 3,
            detail: {doneCalls, final, intermediate, bounded, seen: seen.slice(0, 8)}};
    },

    'interrupt-25': scene => interruption(scene, 25),
    'interrupt-50': scene => interruption(scene, 50),
    'interrupt-75': scene => interruption(scene, 75),

    // End of gesture: released at 200 px with 3000 px/s, target 0.
    gesture: scene => simpleCurve(scene, {prop: 'translation_x', from: 200, target: 0,
        spring: 'DefaultSpatial', velocity: 3000, width: 60, x: 100, gesture: true}),

    // slow-down-factor = 2: measured duration = 2 x duration() +- 1 frame.
    'slow-down': async scene => {
        const st = St.Settings.get();
        const before = st.slow_down_factor;
        return withSetting(
            () => { st.slow_down_factor = 2; },
            () => {
                st.slow_down_factor = before;
                return st.slow_down_factor === before;
            },
            async () => {
                const r = await simpleCurve(scene, {prop: 'translation_x', from: 0, target: 400,
                    spring: 'DefaultSpatial', width: 450, factor: 2});
                const series = r.series.translation_x;
                const expected = 2 * r.detail.durationMs;
                // Wall-clock duration: from the first frame (elapsed 0) to the first finished frame. A frame
                // lost just before the end lengthens it by one period, so we also check that the timeline clock
                // follows real time (difference <= 1 period on every frame) and stops at 2 x duration()
                // (rounded to the ms).
                const start = series.find(e => e.elapsed_ms === 0);
                const endFrame = series.find(e => e.elapsed_ms >= expected - 0.5);
                const measured = start && endFrame ? endFrame.t_ms - start.t_ms : null;
                const drift = start ? Math.max(...series.filter(e => e.elapsed_ms < expected - 0.5)
                    .map(e => Math.abs(e.t_ms - start.t_ms - e.elapsed_ms))) : null;
                const finalElapsed = Math.max(...series.map(e => e.elapsed_ms));
                const period = r.detail.periodMs;
                r.detail.factorBefore = before;
                r.detail.expectedDurationMs = expected;
                r.detail.measuredDurationMs = measured;
                r.detail.finalElapsedMs = finalElapsed;
                r.detail.maxDriftMs = drift;
                // The "wall clock" part is kept apart (the report does not judge it: it depends on the load
                // of the nested Shell); `okOutsideClock` = engine durations, final values, onDone and the
                // restored setting.
                r.okOutsideClock = r.ok && finalElapsed === Math.round(expected);
                r.okClock = measured !== null && drift <= period + 2 &&
                    measured >= expected - period - 2 && measured <= expected + 2 * period + 2;
                r.ok = r.okOutsideClock && r.okClock;
                return r;
            });
    },

    // 20 retargets in 200 ms: no NaN, no jump, final value = last target.
    burst: async scene => {
        const {animate} = await engine();
        const spring = 'DefaultSpatial', prop = 'translation_x';
        const actor = newActor(scene, {width: 450});
        await scene.waitFrames(1);
        // Never the start position (0): a retarget before the first frame to the current value, with no velocity,
        // would finish the animation (correct, but no longer a burst).
        const targets = Array.from({length: 20}, (_, i) => i === 19 ? 300 : (i % 2 ? 100 : 400));
        const ctx = {anim: null, segs: [segment(spring, 0, 0, targets[0], 0.5, 1)]};
        const done = doneSignal();
        ctx.anim = animate(actor, {[prop]: targets[0]}, {spring, onDone: done.callback});
        const t0 = GLib.get_monotonic_time() / 1000;
        const retargetAll = async () => {
            for (let i = 1; i < targets.length; i++) {
                await wait(10);
                const s = ctx.anim.timing(prop);
                const seg = ctx.segs[ctx.segs.length - 1];
                const e = segmentState(seg, s.elapsed);
                ctx.segs.push(segment(spring, e.value, e.velocity, targets[i], 0.5, 1));
                ctx.anim.retarget({[prop]: targets[i]});
            }
            return GLib.get_monotonic_time() / 1000 - t0;
        };
        const measurement = measure(scene, actor, prop, ctx, finishAndFrame(scene, actor, done.promise, 8000));
        const burstMs = await retargetAll();
        const {series, badDurations} = await measurement;
        actor.destroy();
        const b = summary(series);
        // Jump: change between two frames beyond what the physics allows (max segment velocity x interval, with margin).
        const vmax = Math.max(...ctx.segs.map(s => Math.abs(s.v0)), 1) + 400 * Math.sqrt(380);
        let jump = 0;
        for (let i = 1; i < series.length; i++)
            jump = Math.max(jump, Math.abs(series[i].value - series[i - 1].value) /
                Math.max(1, series[i].t_ms - series[i - 1].t_ms) * 1000);
        const last = series[series.length - 1];
        return {
            type: 'curve', unit: 'px', singleActor: true,
            ok: done.calls === 1 && !b.nan && Math.abs(last.value - 300) < 1e-3 && jump <= vmax &&
                badDurations.length === 0,
            detail: {...b, doneCalls: done.calls, retargets: targets.length - 1, badDurations,
                burstMs, maxVelocitySeen: jump, maxVelocityAllowed: vmax},
            series: {[prop]: series},
        };
    },
};
