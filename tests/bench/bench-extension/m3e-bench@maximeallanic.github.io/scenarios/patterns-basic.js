// Pattern scenarios: container transform, shared axis, fade through, fade, morph corners.
import {PATTERNS} from '../m3e/tokens.js';
import {wait} from '../tools.js';
import {segment, segmentState, realDuration, doneSignal} from './engine-model.js';
import {patterns, cornersModule, windowModel, mixModel, pModel, boundsOf, boundsModel, displacementModel,
    patternActor, patternCurve, patternResult, containerModel} from './pattern-model.js';

// Container transform: St.Widget 48x48 -> 800x600, radius 24 -> 12, reversal at 50 %; clone of the source, source
// hidden then restored, corners effect removed at the end, texture radius = radius / scale, expected texture size.
async function containerScenario(scene) {
    const {containerTransform} = await patterns();
    const C = PATTERNS.containerTransform;
    const source = patternActor(scene, {x: 100, y: 100, w: 48, h: 48, color: '#6750a4'});
    const destination = patternActor(scene, {x: 40, y: 60, w: 800, h: 600, color: '#eaddff'});
    await scene.waitFrames(1);
    const r0 = boundsOf(source);
    const [ox, oy] = destination.get_parent().get_transformed_position();
    const r1 = {x: ox + 40, y: oy + 60, w: 800, h: 600};
    const edges = r => [r.x, r.y, r.x + r.w, r.y + r.h];
    const gap = (a, b) => Math.max(...edges(a).map((v, i) => Math.abs(edges(b)[i] - v)));
    const L = Math.max(gap(r0, r1), gap(containerModel(r0, r1, 0, 0).A, containerModel(r0, r1, 1, 0).A));
    const S = C.springSpatial, E = C.springEffects;
    const RS = 24, RD = 12;
    const done = doneSignal();
    const ctx = {pattern: null, segs: [{
        master: segment(S, 0, 0, L, 0.5, 1), L, u0: 0, ut: 1,
        opacity: {from: 0, to: 255, w: C.fadeIn, spring: E},
        radius: {from: RS, to: RD, w: C.shapeMask, spring: S},
        mask: {from: 0, to: 1, w: C.scaleMask, spring: null},
    }]};
    const model = (e, el) => {
        const u = segmentState(e.master, el).value / L;
        const p = pModel(e, el);
        const w = windowModel(e.mask, p);
        return {...containerModel(r0, r1, u, w), w, opacity: windowModel(e.opacity, p),
            radius: windowModel(e.radius, p)};
    };
    const expected = (e, el) => {
        const m = model(e, el);
        return {x: m.A.x, y: m.A.y, w: m.A.w, h: m.A.h, zx: m.z.x, zy: m.z.y, zw: m.z.w, zh: m.z.h,
            dx: m.D.x, dy: m.D.y, dw: m.D.w, dh: m.D.h, opacity: m.opacity, radius: m.radius};
    };
    const sourceOpacityBefore = source.opacity;
    ctx.pattern = containerTransform(source, destination, {sourceRadius: RS, destinationRadius: RD, onDone: done.callback});
    const st = ctx.pattern._containerState;
    const effectD = destination.get_effect('m3e-corners');
    const cloneSeen = st.clone !== null;
    const verif = {sourceHidden: true, textureRadiusMax: 0, textureWrong: [], diags: 0};
    let reversal = null;
    const r = await patternCurve(scene, {ctx, driver: destination, done: done.promise, guardMs: 6000,
        units: {x: 'px', y: 'px', w: 'px', h: 'px', zx: 'px', zy: 'px', zw: 'px', zh: 'px',
            dx: 'px', dy: 'px', dw: 'px', dh: 'px', opacity: 'opacity', radius: 'px'},
        read: () => {
            const b = boundsOf(destination);
            const sx = destination.scale_x;
            const v = {x: b.x, y: b.y, w: b.w, h: b.h, opacity: destination.opacity, radius: effectD?.radius ?? null,
                zx: b.x + effectD.left * sx, zy: b.y + effectD.top * sx,
                zw: effectD.width * sx, zh: effectD.height * sx};
            const cl = st.clone;
            if (cl) {
                const d = boundsOf(cl);
                Object.assign(v, {dx: d.x, dy: d.y, dw: d.w, dh: d.h});
            }
            return v;
        },
        expected,
        before: () => {
            const s = ctx.pattern.timing();
            const e = ctx.segs.at(-1);
            if (ctx.pattern.running) {
                if (source.opacity !== 0)
                    verif.sourceHidden = false;
                // Texture radius = min(radius / scale, area / 2) x resource scale. Only a really painted frame
                // (opacity 0: actor not painted, diagnostic of an earlier frame).
                const dg = effectD._diagnostic();
                const fresh = dg && dg.frame !== verif.lastFrame;
                verif.lastFrame = dg?.frame;
                if (fresh) {
                    verif.diags++;
                    const m = model(e, s.elapsed);
                    const local = Math.min(Math.max(0, m.radius) / m.sa, m.z.w / m.sa / 2); // rx: bounded by the width
                    const exp = local * dg.scale;
                    const err = Math.abs(dg.textureRadius[0] - exp) / Math.max(1, exp);
                    if (err > verif.textureRadiusMax)
                        verif.worst = {err, measured: dg.textureRadius[0], expected: exp, radius: m.radius,
                            sa: m.sa, zw: m.z.w, elapsed: s.elapsed, diagRadius: dg.radius,
                            diagScale: dg.actorScale, opacity: destination.opacity};
                    verif.textureRadiusMax = Math.max(verif.textureRadiusMax, err);
                    if (dg.texture[0] !== dg.expectedTexture[0] || dg.texture[1] !== dg.expectedTexture[1])
                        verif.textureWrong.push({texture: dg.texture, expected: dg.expectedTexture});
                }
            }
            if (reversal !== null)
                return;
            const e0 = ctx.segs[0];
            if (s.elapsed < 0.5 * realDuration(e0.master))
                return;
            const stt = segmentState(e0.master, s.elapsed);
            const m = model(e0, s.elapsed);
            reversal = {elapsed: s.elapsed, travel: stt.value, velocity: stt.velocity};
            ctx.segs.push({
                master: segment(S, stt.value, stt.velocity, 0, 0.5, 1), L, u0: stt.value / L, ut: 0,
                opacity: {from: Math.round(m.opacity), to: 0, w: C.fadeReturn, spring: E},
                radius: {from: m.radius, to: RS, w: C.shapeMaskReturn, spring: S},
                mask: {from: m.w, to: 0, w: C.scaleMaskReturn, spring: null},
            });
            ctx.pattern.target('start');
        }});
    await wait(50);
    const after = {
        cornersRemoved: destination.get_effect('m3e-corners') === null,
        cloneDestroyed: st.clone === null,
        sourceRestored: source.opacity === sourceOpacityBefore,
    };
    const f = containerModel(r0, r1, 0, 0);
    source.destroy();
    destination.destroy();
    const res = patternResult(r, done, {x: f.A.x, y: f.A.y, w: f.A.w, h: f.A.h, zx: r0.x, zy: r0.y,
        zw: r0.w, zh: r0.h, opacity: 0, radius: RS},
    {L, reversal, fitByWidth: f.byWidth, segments: ctx.segs.map(e => e.master.durationMs),
        cloneSeen, verif, after});
    res.ok = res.ok && reversal !== null && cloneSeen && verif.sourceHidden && verif.diags > 3 &&
        verif.textureRadiusMax < 1e-3 && verif.textureWrong.length === 0 && Object.values(after).every(Boolean);
    return res;
}

// Shared axis X / Y / Z, direction 1, two 300x200 actors on top of each other.
async function sharedAxisScenario(scene, axis) {
    const {sharedAxis} = await patterns();
    const A = PATTERNS.sharedAxis;
    const pose = {x: 200, y: 150, w: 300, h: 200};
    const outgoing = patternActor(scene, {...pose, color: '#6750a4'});
    const incoming = patternActor(scene, {...pose, color: '#7d5260'});
    await scene.waitFrames(1);
    const [ox, oy] = outgoing.get_parent().get_transformed_position();
    const base = {...pose, x: pose.x + ox, y: pose.y + oy};
    const g = A.slidePx;
    // State 0 / 1 of each actor (u = 0 and u = 1).
    let s0, s1, e0, e1;
    if (axis === 'z') {
        const c = {px: 0.5, py: 0.5};
        s0 = {...c}; s1 = {...c, sx: A.scaleZ.outgoingEnd, sy: A.scaleZ.outgoingEnd};
        e0 = {...c, sx: A.scaleZ.incomingStart, sy: A.scaleZ.incomingStart}; e1 = {...c};
    } else {
        const t = axis === 'x' ? 'tx' : 'ty';
        s0 = {}; s1 = {[t]: -g}; e0 = {[t]: g}; e1 = {};
    }
    const L = Math.max(displacementModel(boundsModel(base, s0), boundsModel(base, s1)),
        displacementModel(boundsModel(base, e0), boundsModel(base, e1)));
    const mixState = (a, b, u) => Object.fromEntries(['tx', 'ty', 'sx', 'sy', 'px', 'py'].map(k => {
        const d = k[0] === 's' ? 1 : 0;
        return [k, mixModel(a[k] ?? d, b[k] ?? d, u)];
    }));
    const done = doneSignal();
    const ctx = {pattern: null, segs: [{
        master: segment(A.springSpatial, 0, 0, L, 0.5, 1), L, u0: 0, ut: 1,
        oo: {from: 255, to: 0, w: A.fadeOut, spring: A.springEffects},
        io: {from: 0, to: 255, w: A.fadeIn, spring: A.springEffects},
    }]};
    const expected = (e, el) => {
        const u = segmentState(e.master, el).value / L;
        const tau = pModel(e, el);
        const bs = boundsModel(base, mixState(s0, s1, u));
        const be = boundsModel(base, mixState(e0, e1, u));
        return {ox: bs.x, oy: bs.y, ow: bs.w, oh: bs.h, ix: be.x, iy: be.y, iw: be.w, ih: be.h,
            oo: windowModel(e.oo, tau), io: windowModel(e.io, tau)};
    };
    ctx.pattern = sharedAxis(outgoing, incoming, axis, 1, {onDone: done.callback});
    const read = () => {
        const bs = boundsOf(outgoing), be = boundsOf(incoming);
        return {ox: bs.x, oy: bs.y, ow: bs.w, oh: bs.h, ix: be.x, iy: be.y, iw: be.w, ih: be.h,
            oo: outgoing.opacity, io: incoming.opacity};
    };
    const r = await patternCurve(scene, {ctx, driver: incoming, done: done.promise, guardMs: 5000,
        units: {ox: 'px', oy: 'px', ow: 'px', oh: 'px', ix: 'px', iy: 'px', iw: 'px', ih: 'px',
            oo: 'opacity', io: 'opacity'}, read, expected});
    outgoing.destroy();
    incoming.destroy();
    const fs = boundsModel(base, s1), fe = boundsModel(base, e1);
    return patternResult(r, done, {ox: fs.x, oy: fs.y, ow: fs.w, oh: fs.h, ix: fe.x, iy: fe.y,
        iw: fe.w, ih: fe.h, oo: 0, io: 255}, {L, durationMs: ctx.segs[0].master.durationMs});
}

// Fade through: 400x300, the incoming actor grows from incomingScale (pivot at the centre).
async function fadeThroughScenario(scene) {
    const {fadeThrough} = await patterns();
    const F = PATTERNS.fadeThrough;
    const pose = {x: 200, y: 150, w: 400, h: 300};
    const outgoing = patternActor(scene, {...pose, color: '#6750a4'});
    const incoming = patternActor(scene, {...pose, color: '#7d5260'});
    await scene.waitFrames(1);
    const [ox, oy] = incoming.get_parent().get_transformed_position();
    const base = {...pose, x: pose.x + ox, y: pose.y + oy};
    const k = F.incomingScale;
    const e0 = {sx: k, sy: k, px: 0.5, py: 0.5}, e1 = {px: 0.5, py: 0.5};
    const L = displacementModel(boundsModel(base, e0), boundsModel(base, e1));
    const done = doneSignal();
    const ctx = {pattern: null, segs: [{
        master: segment(F.springSpatial, 0, 0, L, 0.5, 1), L, u0: 0, ut: 1,
        oo: {from: 255, to: 0, w: {start: 0, end: F.outgoingShare}, spring: F.springEffects},
        io: {from: 0, to: 255, w: {start: F.outgoingShare, end: 1}, spring: F.springEffects},
    }]};
    const expected = (e, el) => {
        const u = segmentState(e.master, el).value / L;
        const tau = pModel(e, el);
        const s = mixModel(k, 1, u);
        const be = boundsModel(base, {sx: s, sy: s, px: 0.5, py: 0.5});
        return {ix: be.x, iy: be.y, iw: be.w, ih: be.h, ow: base.w,
            oo: windowModel(e.oo, tau), io: windowModel(e.io, tau)};
    };
    ctx.pattern = fadeThrough(outgoing, incoming, {onDone: done.callback});
    const r = await patternCurve(scene, {ctx, driver: incoming, done: done.promise, guardMs: 5000,
        units: {ix: 'px', iy: 'px', iw: 'px', ih: 'px', ow: 'px', oo: 'opacity', io: 'opacity'},
        read: () => {
            const be = boundsOf(incoming);
            return {ix: be.x, iy: be.y, iw: be.w, ih: be.h, ow: boundsOf(outgoing).w,
                oo: outgoing.opacity, io: incoming.opacity};
        }, expected});
    outgoing.destroy();
    incoming.destroy();
    return patternResult(r, done, {ix: base.x, iy: base.y, iw: base.w, ih: base.h, oo: 0, io: 255},
        {L, durationMs: ctx.segs[0].master.durationMs});
}

// Fade in (scale from origin 0,0 + opacity window) or fade out (plain Effects spring on opacity, no scale).
async function fadeScenario(scene, entering) {
    const {fade} = await patterns();
    const F = PATTERNS.fade;
    const pose = {x: 200, y: 150, w: 300, h: 200};
    const actor = patternActor(scene, {...pose, color: '#6750a4'});
    await scene.waitFrames(1);
    const [ox, oy] = actor.get_parent().get_transformed_position();
    const base = {...pose, x: pose.x + ox, y: pose.y + oy};
    const done = doneSignal();
    let ctx, expected, L = null;
    if (entering) {
        const k = F.incomingScale;
        L = displacementModel(boundsModel(base, {sx: k, sy: k}), base);
        ctx = {pattern: null, segs: [{
            master: segment(F.springEnter, 0, 0, L, 0.5, 1), L, u0: 0, ut: 1,
            o: {from: 0, to: 255, w: {start: 0, end: F.fadeInEnd}, spring: F.springEnterEffects},
        }]};
        expected = (e, el) => {
            const s = mixModel(k, 1, segmentState(e.master, el).value / L);
            const b = boundsModel(base, {sx: s, sy: s});
            return {x: b.x, y: b.y, w: b.w, h: b.h, o: windowModel(e.o, pModel(e, el))};
        };
    } else {
        // Exit: no master; the "segment" is the opacity spring itself.
        ctx = {pattern: null, segs: [{master: segment(F.springExit, 255, 0, 0, 0.01 * 255, 1)}]};
        expected = (e, el) => ({...base, o: segmentState(e.master, el).value});
    }
    ctx.pattern = fade(actor, entering, {origin: {x: 0, y: 0}, onDone: done.callback});
    const r = await patternCurve(scene, {ctx, driver: actor, done: done.promise, guardMs: 5000,
        units: {x: 'px', y: 'px', w: 'px', h: 'px', o: 'opacity'},
        read: () => ({...boundsOf(actor), o: actor.opacity}), expected});
    actor.destroy();
    return patternResult(r, done, {...base, o: entering ? 255 : 0},
        {L, durationMs: ctx.segs[0].master.durationMs});
}

// Corner morph: radius `from` -> `to` (spring PATTERNS.morphCorners.spring).
async function morphScenario(scene, {from, to, pose, countOnly = false}) {
    const {morphCorners} = await patterns();
    const {corners} = await cornersModule();
    const R = PATTERNS.morphCorners.spring;
    const actor = patternActor(scene, {...pose, color: '#6750a4'});
    const effect = corners(actor);
    effect.radius = from;
    await scene.waitFrames(2);
    const done = doneSignal();
    const ctx = {pattern: null, segs: [{master: segment(R, from, 0, to, 0.5, 1)}]};
    ctx.pattern = morphCorners(actor, to, {onDone: done.callback});
    const r = await patternCurve(scene, {ctx, driver: actor, done: done.promise, guardMs: 5000,
        units: {radius: 'px'}, read: () => ({radius: actor.get_effect('m3e-corners')?.radius ?? null}),
        expected: (e, el) => ({radius: segmentState(e.master, el).value})});
    const targetTexture = effect._diagnostic?.() ?? null;
    actor.destroy();
    return patternResult(r, done, {radius: to}, {durationMs: ctx.segs[0].master.durationMs,
        targetTexture, costMeasured: countOnly});
}

export const patternBasicScenarios = {
    'pattern-container': scene => containerScenario(scene),
    'pattern-axis-x': scene => sharedAxisScenario(scene, 'x'),
    'pattern-axis-y': scene => sharedAxisScenario(scene, 'y'),
    'pattern-axis-z': scene => sharedAxisScenario(scene, 'z'),
    'pattern-fade-through': scene => fadeThroughScenario(scene),
    'pattern-fade-in': scene => fadeScenario(scene, true),
    'pattern-fade-out': scene => fadeScenario(scene, false),
    'pattern-morph': scene => morphScenario(scene, {from: 20, to: 8, pose: {x: 200, y: 150, w: 200, h: 120}}),
    // Cost of the corners shader on a 5120x1440 window: lost frames reported, not blocking; the radius curve must
    // stay right.
    'corners-large-window': scene => morphScenario(scene, {from: 0, to: 48,
        pose: {x: 0, y: 0, w: 5120, h: 1440}, countOnly: true}),
};
