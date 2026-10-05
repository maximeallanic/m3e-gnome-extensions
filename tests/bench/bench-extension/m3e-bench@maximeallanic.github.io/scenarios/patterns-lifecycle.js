// Pattern scenarios about chaining, overlap, partial destruction, global stop and the corners texture.
import St from 'gi://St';

import {wait} from '../tools.js';
import {engine, newActor, doneSignal} from './engine-model.js';
import {patterns, cornersModule, boundsOf, patternActor, driverEffects, waitForPart} from './pattern-model.js';

// Pattern B started in the middle of pattern A on the same actors: no discontinuity. The jump between the last frame
// before B and the first after must stay within the movement of one frame: <= 2 x the largest step of the 3 previous
// frames + tolerance (0.5 px; 2/255 of opacity). B must finish (onDone once).
async function chain(scene, {actors, startA, startB, read, units, proportion = 0.4}) {
    const doneA = doneSignal(), doneB = doneSignal();
    let pattern = startA(doneA.callback);
    await scene.waitFrames(1);
    const reads = [];
    let iB = null, aRunning = false;
    const off = scene.onEveryFrame(() => {
        reads.push(read());
        if (iB !== null)
            return;
        // At least 5 frames of A before B (step history), A still running.
        const s = pattern.timing();
        if (reads.length >= 5 && s.duration > 0 && s.elapsed >= proportion * s.duration) {
            iB = reads.length; // first read after B
            aRunning = pattern.running;
            pattern = startB(doneB.callback);
        }
    });
    try {
        await Promise.race([doneB.promise, wait(5000)]);
        // The scene may be still: frames requested again, bounded wait.
        for (const a of actors)
            a.queue_redraw();
        await Promise.race([scene.waitFrames(2), wait(200)]);
    } finally {
        off();
    }
    const jumps = {};
    let ok = iB !== null && aRunning && reads.length > iB + 3 && doneB.calls === 1 && doneA.calls === 0;
    if (iB !== null) {
        for (const [k, u] of Object.entries(units)) {
            const v = reads.map(r => r[k]);
            const step = i => Math.abs(v[i] - v[i - 1]);
            const before = Math.max(step(iB - 1), step(iB - 2), step(iB - 3));
            const tol = u === 'opacity' ? 2 : 0.5;
            const allowed = 2 * before + tol;
            jumps[k] = {jump: step(iB), allowed, before: v[iB - 1], after: v[iB]};
            ok &&= Number.isFinite(v[iB]) && step(iB) <= allowed;
        }
    }
    for (const a of actors)
        a.destroy();
    return {type: 'state', ok, detail: {indexB: iB, aRunning, frames: reads.length, doneA: doneA.calls,
        doneB: doneB.calls, jumps, last: reads.at(-1)}};
}

async function chainAxis(scene) {
    const {sharedAxis} = await patterns();
    const pose = {x: 200, y: 150, w: 300, h: 200};
    const s = patternActor(scene, {...pose, color: '#6750a4'});
    const e = patternActor(scene, {...pose, color: '#7d5260'});
    await scene.waitFrames(1);
    const r = await chain(scene, {actors: [s, e],
        startA: f => sharedAxis(s, e, 'x', 1, {onDone: f}),
        // New navigation: the incoming actor becomes the outgoing one, and vice versa.
        startB: f => sharedAxis(e, s, 'x', 1, {onDone: f}),
        read: () => ({sx: boundsOf(s).x, ex: boundsOf(e).x, so: s.opacity, eo: e.opacity}),
        units: {sx: 'px', ex: 'px', so: 'opacity', eo: 'opacity'}});
    const d = r.detail.last;
    r.ok &&= Math.abs(d.sx - pose.x) < 1e-3 && d.so === 255 && d.eo === 0;
    return r;
}

async function chainFade(scene) {
    const {fade} = await patterns();
    const pose = {x: 200, y: 150, w: 300, h: 200};
    const a = patternActor(scene, {...pose, color: '#6750a4'});
    await scene.waitFrames(1);
    const read = () => {
        const b = boundsOf(a);
        return {x: b.x, y: b.y, w: b.w, h: b.h, o: a.opacity};
    };
    const r = await chain(scene, {actors: [a],
        startA: f => fade(a, true, {origin: {x: 0, y: 0}, onDone: f}),
        // Same entrance, other origin (bottom-right): pivot changed at full scale.
        startB: f => fade(a, true, {origin: {x: pose.w, y: pose.h}, onDone: f}),
        read, units: {x: 'px', y: 'px', w: 'px', h: 'px', o: 'opacity'}});
    const d = r.detail.last;
    r.ok &&= Math.abs(d.w - pose.w) < 1e-3 && d.o === 255;
    return r;
}

// Two container transforms from the SAME source (opacity 230), overlapping (B started at 30 % of A, distinct
// destinations). The source stays hidden while either runs, then gets 230 back; both clones are destroyed.
async function containerOverlapSource(scene) {
    const {containerTransform} = await patterns();
    const source = patternActor(scene, {x: 100, y: 100, w: 48, h: 48, color: '#6750a4'});
    source.opacity = 230;
    const d1 = patternActor(scene, {x: 40, y: 60, w: 400, h: 300, color: '#eaddff'});
    const d2 = patternActor(scene, {x: 460, y: 60, w: 400, h: 300, color: '#ffd8e4'});
    await scene.waitFrames(1);
    const f1 = doneSignal(), f2 = doneSignal();
    const opts = f => ({sourceRadius: 24, destinationRadius: 12, onDone: f.callback});
    const m1 = containerTransform(source, d1, opts(f1));
    let m2 = null;
    const verif = {frames: 0, visibleWhile: [], m1DoneBeforeM2: false};
    const off = scene.onEveryFrame(() => {
        verif.frames++;
        const r1 = m1.running, r2 = m2?.running ?? false;
        if ((r1 || r2) && source.opacity !== 0 && verif.visibleWhile.length < 5)
            verif.visibleWhile.push({opacity: source.opacity, m1: r1, m2: r2});
        if (m2 && !r1 && r2)
            verif.m1DoneBeforeM2 = true;
    });
    let error = null;
    try {
        const started = await waitForPart(m1, 0.3);
        m2 = containerTransform(source, d2, opts(f2));
        verif.bStartedDuringA = started && m1.running;
        await Promise.race([Promise.all([f1.promise, f2.promise]), wait(6000)]);
        source.queue_redraw();
        await Promise.race([scene.waitFrames(2), wait(200)]);
    } catch (e) {
        error = `${e}`;
    } finally {
        off();
    }
    const after = {
        sourceOpacity: source.opacity,
        clone1: m1._containerState.clone === null,
        clone2: m2?._containerState.clone === null,
        done1: f1.calls, done2: f2.calls,
    };
    for (const a of [source, d1, d2])
        a.destroy();
    const ok = error === null && verif.bStartedDuringA && verif.m1DoneBeforeM2 &&
        verif.visibleWhile.length === 0 && after.sourceOpacity === 230 && after.clone1 &&
        after.clone2 && after.done1 === 1 && after.done2 === 1;
    return {type: 'state', ok, detail: {...verif, after, error}};
}

// Container transform B restarted on a destination still driven by A (other source). B's corners effect is on the
// destination at every frame of B; at the last frame, radius and area = B's targets; at the end of B, effect removed
// (without keepCorners) or kept with B's radius and the whole area (keepCorners).
async function overlapDestination(scene, keepCorners) {
    const {containerTransform} = await patterns();
    const RB = 8;
    const s1 = patternActor(scene, {x: 100, y: 100, w: 48, h: 48, color: '#6750a4'});
    const s2 = patternActor(scene, {x: 700, y: 520, w: 56, h: 40, color: '#7d5260'});
    const destination = patternActor(scene, {x: 40, y: 60, w: 600, h: 400, color: '#eaddff'});
    await scene.waitFrames(1);
    const fA = doneSignal(), fB = doneSignal();
    const mA = containerTransform(s1, destination, {sourceRadius: 24, destinationRadius: 12, onDone: fA.callback});
    let mB = null;
    const verif = {framesB: 0, noEffect: 0, otherEffect: 0, last: null};
    const off = scene.onEveryFrame(() => {
        if (!mB?.running)
            return;
        verif.framesB++;
        const e = destination.get_effect('m3e-corners');
        if (!e) {
            verif.noEffect++;
            return;
        }
        if (e !== mB._containerState.effectD)
            verif.otherEffect++;
        verif.last = {radius: e.radius, left: e.left, top: e.top, width: e.width, height: e.height};
    });
    let error = null;
    try {
        verif.aRunning = await waitForPart(mA, 0.4) && mA.running;
        mB = containerTransform(s2, destination, {sourceRadius: 20, destinationRadius: RB, keepCorners, onDone: fB.callback});
        await Promise.race([fB.promise, wait(6000)]);
        await wait(50);
    } catch (e) {
        error = `${e}`;
    } finally {
        off();
    }
    const effect = destination.get_effect('m3e-corners');
    const d = verif.last;
    const close = (a, b) => d !== null && Math.abs(a - b) <= 1;
    const lastOk = d !== null && Math.abs(d.radius - RB) <= 0.5 && close(d.left, 0) &&
        close(d.top, 0) && close(d.width, 600) && close(d.height, 400);
    const after = {
        effectPresent: effect !== null,
        radius: effect?.radius ?? null,
        area: effect?.area() ?? null,
        compensate: effect?.compensate ?? null,
        drivers: driverEffects(destination),
        cloneA: mA._containerState.clone === null,
        cloneB: mB?._containerState.clone === null,
        sources: [s1.opacity, s2.opacity],
        doneA: fA.calls, doneB: fB.calls,
    };
    const endOk = keepCorners
        ? after.effectPresent && after.radius === RB && after.compensate === false &&
          after.area.x === 0 && after.area.y === 0 && after.area.w === 600 && after.area.h === 400
        : !after.effectPresent;
    for (const a of [s1, s2, destination])
        a.destroy();
    const ok = error === null && verif.aRunning && verif.framesB > 3 && verif.noEffect === 0 &&
        verif.otherEffect === 0 && lastOk && endOk && after.drivers.length === 0 &&
        after.cloneA && after.cloneB && after.sources[0] === 255 && after.sources[1] === 255 &&
        after.doneA === 0 && after.doneB === 1;
    return {ok, detail: {...verif, lastOk, endOk, after, error}};
}

async function containerOverlapDestination(scene) {
    const without = await overlapDestination(scene, false);
    const kept = await overlapDestination(scene, true);
    return {type: 'state', ok: without.ok && kept.ok, detail: {withoutKeep: without.detail, keep: kept.detail}};
}

// Shared axis X, the OUTGOING actor (not the driver) is destroyed at 40 %: driver effect removed from the incoming
// actor, incoming actor set to its final geometry and opacity, no onDone, no track left, API inert.
async function partialDestroy(scene) {
    const {sharedAxis} = await patterns();
    const {_diagnostic} = await engine();
    const pose = {x: 200, y: 150, w: 300, h: 200};
    const outgoing = patternActor(scene, {...pose, color: '#6750a4'});
    const incoming = patternActor(scene, {...pose, color: '#7d5260'});
    await scene.waitFrames(1);
    const f = doneSignal();
    const m = sharedAxis(outgoing, incoming, 'x', 1, {onDone: f.callback});
    const name = m._name;
    let error = null, apiError = null;
    const before = {};
    try {
        before.midway = await waitForPart(m, 0.4) && m.running;
        before.driver = incoming.get_effect(name) !== null;
        before.tx = incoming.translation_x;
        before.opacity = incoming.opacity;
        outgoing.destroy();
    } catch (e) {
        error = `${e}`;
    }
    const read = () => ({tx: incoming.translation_x, ty: incoming.translation_y, sx: incoming.scale_x,
        sy: incoming.scale_y, opacity: incoming.opacity});
    const just = {...read(), driverRemoved: incoming.get_effect(name) === null,
        drivers: driverEffects(incoming), running: m.running, diagnostic: _diagnostic()};
    await wait(400);
    const late = read();
    try {
        m.target('start');
        m.stop();
        m.finish();
    } catch (e) {
        apiError = `${e}`;
    }
    const afterApi = {...read(), drivers: driverEffects(incoming), diagnostic: _diagnostic()};
    incoming.destroy();
    const final = v => v.tx === 0 && v.ty === 0 && v.sx === 1 && v.sy === 1 && v.opacity === 255;
    const ok = error === null && apiError === null && before.midway && before.driver &&
        before.tx !== 0 && just.driverRemoved && just.drivers.length === 0 && !just.running &&
        final(just) && final(late) && final(afterApi) && afterApi.drivers.length === 0 &&
        just.diagnostic.tracks === 0 && afterApi.diagnostic.tracks === 0 && f.calls === 0;
    return {type: 'state', ok, detail: {before, just, late, afterApi, doneCalls: f.calls, error, apiError}};
}

// stopAll() (an extension's disable()): several patterns and animations running, plus an onDone waiting for idle;
// after the call, registries empty, container-transform source restored, pattern effects removed, nothing moves any
// more, no onDone.
async function stopAllScenario(scene) {
    const {animate, stopAll, _diagnostic} = await engine();
    const M = await patterns();
    const dones = {n: 0};
    const onDone = () => dones.n++;
    const source = patternActor(scene, {x: 100, y: 100, w: 48, h: 48, color: '#6750a4'});
    source.opacity = 230;
    const destination = patternActor(scene, {x: 40, y: 60, w: 400, h: 300, color: '#eaddff'});
    const s = patternActor(scene, {x: 460, y: 60, w: 300, h: 200, color: '#6750a4'});
    const e = patternActor(scene, {x: 460, y: 60, w: 300, h: 200, color: '#7d5260'});
    const menu = patternActor(scene, {x: 460, y: 300, w: 200, h: 150, color: '#ffd8e4'});
    const button = patternActor(scene, {x: 700, y: 300, w: 120, h: 48, color: '#625b71'});
    const free = newActor(scene, {width: 60});
    const hiddenParent = new St.Widget({visible: false});
    scene.container.add_child(hiddenParent);
    const hidden = newActor(scene, {parent: hiddenParent});
    await scene.waitFrames(1);
    let error = null;
    const res = {};
    try {
        const ct = M.containerTransform(source, destination, {sourceRadius: 24, destinationRadius: 12, onDone});
        M.sharedAxis(s, e, 'x', 1, {onDone});
        M.fade(menu, false, {onDone});
        M.morphCorners(button, 24, {onDone});
        animate(free, {translation_x: 400, opacity: 100}, {spring: 'Slow', onDone});
        await Promise.race([scene.waitFrames(6), wait(500)]);
        // Not shown: value set, onDone waiting for idle (started just before the stop).
        animate(hidden, {translation_x: 300}, {onDone});
        res.before = {animate: _diagnostic(), patterns: M._diagnostic(), source: source.opacity,
            ctRunning: ct.running, dones: dones.n};
        stopAll();
        const read = () => ({free: free.translation_x, e: e.translation_x, destination: destination.scale_x,
            menu: menu.opacity, button: button.get_effect('m3e-corners')?.radius ?? null});
        res.just = {animate: _diagnostic(), patterns: M._diagnostic(), source: source.opacity,
            cornersRemoved: destination.get_effect('m3e-corners') === null, clone: ct._containerState.clone === null,
            drivers: [destination, e, menu, button].flatMap(driverEffects), values: read(),
            running: ct.running};
        await wait(400);
        res.late = {values: read(), dones: dones.n, animate: _diagnostic(), patterns: M._diagnostic()};
    } catch (er) {
        error = `${er}`;
    }
    for (const a of [source, destination, s, e, menu, button, free, hiddenParent])
        a.destroy();
    const empty = d => d && Object.values(d).every(v => v === 0);
    const j = res.just, t = res.late;
    const ok = error === null && res.before.animate.tracks > 0 && res.before.animate.pendingDone > 0 &&
        res.before.patterns.patterns > 0 && res.before.source === 0 && res.before.ctRunning && res.before.dones === 0 &&
        empty(j.animate) && empty(j.patterns) && j.source === 230 && j.cornersRemoved && j.clone &&
        j.drivers.length === 0 && !j.running && empty(t.animate) && empty(t.patterns) && t.dones === 0 &&
        JSON.stringify(t.values) === JSON.stringify(j.values);
    return {type: 'state', ok, detail: {...res, error}};
}

// Observed off-screen texture size (get_target_size) = expected by corners.js, on fractional positions and sizes and
// a scaled actor.
async function cornersTexture(scene) {
    const {corners} = await cornersModule();
    const cases = [
        {x: 10.3, y: 5.7, w: 200, h: 120},
        {x: 0, y: 300, w: 199.6, h: 80.2},
        {x: 333.5, y: 12.25, w: 57.25, h: 31.75},
        {x: 420, y: 200, w: 640, h: 360, s: 0.37},
    ];
    const results = [];
    for (const c of cases) {
        const a = new St.Widget({x: c.x, y: c.y, width: c.w, height: c.h, style: 'background-color: #6750a4;'});
        scene.container.add_child(a);
        if (c.s)
            a.set_scale(c.s, c.s);
        corners(a).radius = 8;
        // Still scene: frames requested again, without waiting forever.
        for (let i = 0; i < 3; i++) {
            a.queue_redraw();
            await Promise.race([scene.waitFrames(1), wait(100)]);
        }
        const dg = corners(a)._diagnostic();
        results.push({...c, texture: dg?.texture, expected: dg?.expectedTexture, start: dg?.start});
        a.destroy();
    }
    const ok = results.every(r => r.texture && r.texture[0] === r.expected[0] && r.texture[1] === r.expected[1]);
    return {type: 'state', ok, detail: {results}};
}

export const patternLifecycleScenarios = {
    'pattern-chain-axis': scene => chainAxis(scene),
    'pattern-chain-fade': scene => chainFade(scene),
    'pattern-container-overlap-source': scene => containerOverlapSource(scene),
    'pattern-container-overlap-destination': scene => containerOverlapDestination(scene),
    'pattern-partial-destroy': scene => partialDestroy(scene),
    'stop-all': scene => stopAllScenario(scene),
    'corners-texture': scene => cornersTexture(scene),
};
