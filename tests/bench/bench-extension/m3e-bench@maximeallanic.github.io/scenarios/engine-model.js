// Independent model of the animation engine for the bench: a spring segment is computed with spring.js alone
// (the engine under test is animate.js), so a wrong duration or value in the engine shows up as a difference.
import GLib from 'gi://GLib';
import St from 'gi://St';

import {state, duration} from '../m3e/spring.js';
import {wait} from '../tools.js';

export const engine = () => import('../m3e/animate.js');

export function newActor(scene, {width = 40, x = 0, parent = null} = {}) {
    const a = new St.Widget({width, height: 40, x, y: 120, style: 'background-color: #6750a4;'});
    (parent ?? scene.container).add_child(a);
    return a;
}

export const THRESHOLD = {translation_x: 0.5, opacity: 0.01 * 255};

// Segment seen by a scenario: expected value at real time `elapsed` is target + state(x0, v0, elapsed / factor).x,
// and exactly the target once the duration (x factor) is reached.
export function segment(spring, current, velocity, target, threshold, factor) {
    const x0 = current - target;
    return {spring, target, x0, v0: velocity, factor, durationMs: duration(spring, x0, velocity, threshold)};
}

// Expected real duration (ms) of the segment's timeline, computed without the engine:
// 0 if nothing is to animate, otherwise max(1, round(duration() x factor)).
export const realDuration = seg => seg.durationMs > 0 ? Math.max(1, Math.round(seg.durationMs * seg.factor)) : 0;

// Expected state at real time `elapsed`; "done" is deduced from realDuration(seg), never from the engine
// (otherwise a duration that is too short in the engine would go unnoticed).
export function segmentState(seg, elapsed) {
    if (elapsed >= realDuration(seg))
        return {value: seg.target, velocity: 0};
    const s = state(seg.spring, seg.x0, seg.v0, elapsed / seg.factor);
    return {value: seg.target + s.x, velocity: s.v};
}

// Samples `prop` of the actor during the animation described by ctx ({anim, segs}); `ctx.segs` grows at every
// retarget. Resolves when `until` does, then returns {series: [{t_ms, elapsed_ms, value, expected, segment}],
// badDurations: [{segment, engine, expected}]}: engine timeline durations that differ from realDuration(segment).
export async function measure(scene, actor, prop, ctx, until, {before = null} = {}) {
    const marks = [];
    const promise = scene.sample(actor, [prop], {
        elapsed: () => {
            const s = ctx.anim?.timing(prop) ?? {elapsed: 0, duration: 0, done: true};
            marks.push({seg: ctx.segs.length - 1, engineDuration: s.duration});
            return s.elapsed;
        },
        until,
    });
    // Connected after the sampler: it sees the frame first.
    const off = before ? scene.onEveryFrame(before) : null;
    let samples;
    try {
        samples = await promise;
    } finally {
        off?.();
    }
    const badDurations = [];
    const series = samples.map((r, i) => {
        const m = marks[i];
        const seg = ctx.segs[m.seg];
        const expected = realDuration(seg);
        if (m.engineDuration !== expected &&
            !badDurations.some(d => d.segment === m.seg && d.engine === m.engineDuration))
            badDurations.push({segment: m.seg, engine: m.engineDuration, expected});
        return {t_ms: r.t_ms, elapsed_ms: r.elapsed_ms, value: r.values[prop],
            expected: segmentState(seg, r.elapsed_ms).value, segment: m.seg};
    });
    return {series, badDurations};
}

// Max difference and lost frames (interval above 1.5 x median period), for the detail.
export function summary(series, scale = 1) {
    let maxDiff = 0, nan = false;
    for (const e of series) {
        if (!Number.isFinite(e.value) || !Number.isFinite(e.expected))
            nan = true;
        maxDiff = Math.max(maxDiff, Math.abs(e.value - e.expected) / scale);
    }
    const dt = series.slice(1).map((e, i) => e.t_ms - series[i].t_ms).sort((a, b) => a - b);
    const period = dt.length ? dt[Math.floor(dt.length / 2)] : 0;
    const lost = dt.filter(d => d > 1.5 * period).length;
    return {maxDiff, frames: series.length, periodMs: period, lostFrames: lost, nan};
}

// End of animation plus one frame to read the final value, under a guard.
export function finishAndFrame(scene, actor, done, guardMs) {
    return Promise.race([
        done.then(async () => {
            actor.queue_redraw();
            await Promise.race([scene.waitFrames(1), wait(100)]);
        }),
        wait(guardMs),
    ]);
}

// A promise settled by a callback, plus a counter of calls.
export function doneSignal() {
    const f = {calls: 0};
    f.promise = new Promise(r => { f.resolve = r; });
    f.callback = () => { f.calls++; f.resolve(); };
    return f;
}

// Curve of a simple animation `from` -> `target` on `prop`.
export async function simpleCurve(scene, {prop, from, target, spring, velocity = 0, width = 40, x = 0,
    gesture = false, factor = 1}) {
    const {animate, release} = await engine();
    const actor = newActor(scene, {width, x});
    actor[prop] = from;
    await scene.waitFrames(1);
    const animationsEnabled = St.Settings.get().enable_animations;
    const ctx = {anim: null, segs: [segment(spring, actor[prop], velocity, target, THRESHOLD[prop], factor)]};
    const done = doneSignal();
    const t0 = GLib.get_monotonic_time() / 1000;
    ctx.anim = gesture
        ? release(actor, prop, target, velocity, spring, {onDone: done.callback})
        : animate(actor, {[prop]: target}, {spring, onDone: done.callback});
    let tEnd = null;
    done.promise.then(() => { tEnd = GLib.get_monotonic_time() / 1000; });
    const {series, badDurations} = await measure(scene, actor, prop, ctx,
        finishAndFrame(scene, actor, done.promise, 3000 + 2 * ctx.segs[0].durationMs * factor));
    actor.destroy();
    const b = summary(series, prop === 'opacity' ? 255 : 1);
    const last = series[series.length - 1];
    const ok = done.calls === 1 && !b.nan && last !== undefined &&
        Math.abs(last.value - target) < 1e-3 && badDurations.length === 0;
    return {
        type: 'curve', unit: prop === 'opacity' ? 'opacity' : 'px', singleActor: true, ok,
        detail: {...b, doneCalls: done.calls, durationMs: ctx.segs[0].durationMs, factor, badDurations,
            measuredDurationMs: tEnd === null ? null : tEnd - t0, animationsEnabled,
            stage: [global.stage.width, global.stage.height]},
        series: {[prop]: series},
    };
}

// Sets a Shell setting during `body`, then restores it (even on failure). `restore` returns true when the original
// state is back; recorded in detail.restored (a failed restore fails the scenario).
export async function withSetting(set, restore, body) {
    let r = null;
    try {
        await set();
        r = await body();
    } finally {
        const restored = await restore();
        if (r) {
            r.detail = {...r.detail, restored};
            r.ok = r.ok && restored;
        }
    }
    return r;
}
