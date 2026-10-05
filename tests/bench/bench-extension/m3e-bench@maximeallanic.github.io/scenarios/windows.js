// Window scenarios (extension m3e-motion): open, close, dialog, minimize, maximize.
import GLib from 'gi://GLib';
import Mtk from 'gi://Mtk';

import {ANDROID} from '../m3e/tokens.js';
import {value} from '../m3e/curve.js';
import {SLOWDOWN, Checks, checksResult, round3, setSlowdown, wait, waitUntil} from '../tools.js';
import {motion} from './under-test.js';
import {readWindow, center, distance, frameOf, rectGap, biggestJump, curveGap, settledWindow,
    checkWindowAtRest, frameZone} from './window-tools.js';

const traceExtra = r => ({trace: r.trace, files: r.files, lost: r.lost, duration_ms: r.duration_ms});

// Opening without a source: activity_open_enter (96 dp x 56/72 slide in 450 ms emphasized, opacity in 83 ms after 50 ms).
async function windowOpen(scene) {
    const c = new Checks();
    const O = ANDROID.activityOpen;
    const g = O.slideDp * ANDROID.density;
    setSlowdown(SLOWDOWN);
    const client = scene.launchClient('window', 'Open');
    const r = await scene.trace(() => readWindow(client.windows[0]), 3500,
        {400: 'window-open-400', 900: 'window-open-900'});
    setSlowdown(1);
    const w = client.windows[0];
    c.ok('window appeared', !!w);
    const vis = r.trace.filter(e => e.present && e.vis);
    const anim = vis.filter(e => e.tx > 0);
    c.ok('starts shifted by 96 dp x 56/72 to the right', anim.length > 3 && Math.abs(anim[0].tx - g) <= 3,
        `tx=${anim[0]?.tx} expected ${round3(g)}`);
    c.ok('no scale', vis.every(e => e.sx === 1 && e.sy === 1));
    // The first painted frame of the window can come after the movement started (client texture): the start is
    // searched up to 12 frames earlier, then serves as the origin for opacity.
    const gap = curveGap(anim.map(e => ({t: e.t, y: e.tx})), g, 0, O.curve, O.durationMs, SLOWDOWN, value, 12);
    c.ok('emphasized slide in 450 ms (gap <= 3 px)', gap.gap <= 3,
        `gap ${round3(gap.gap)} px, start ${round3(gap.offset)} ms before the 1st frame`);
    const t0 = (anim[0]?.t ?? 0) + gap.offset;
    // Delay in real ms (toolkit: not multiplied by the slow-down), duration slowed down.
    const transparent = vis.filter(e => e.t - t0 < O.alphaDelayMs - 5);
    c.ok('transparent during the first 50 ms', transparent.every(e => e.o === 0),
        JSON.stringify(transparent.filter(e => e.o > 0).slice(0, 1)));
    const full = vis.find(e => e.o === 255);
    const expected = O.alphaDelayMs + O.alphaDurationMs * SLOWDOWN;
    c.ok('opaque after 50 + 83 ms (+-1 frame)', full && Math.abs(full.t - t0 - expected) <= 2 * 1000 / 60,
        `${full ? round3(full.t - t0) : null} real ms, expected ${expected}`);
    if (w) {
        const end = frameOf(w), last = vis[vis.length - 1];
        c.ok('settled on its frame', last && rectGap(last, end) <= 1, JSON.stringify({last, end}));
        await checkWindowAtRest(c, w, 'end');
    }
    return checksResult(c, traceExtra(r));
}

// Android launch (Launcher3): 500 ms emphasized from the icon to the frame, corners, opacity in 50 ms after 25 ms.
async function windowOpenFromIcon(scene) {
    const c = new Checks();
    const L = ANDROID.launch;
    const launcher = await motion('motion/launcher.js');
    const icon = {x: 100, y: 900, width: 64, height: 64};
    launcher._noteNext(icon, 16);
    setSlowdown(SLOWDOWN);
    const client = scene.launchClient('window', 'Open from an icon');
    const r = await scene.trace(() => readWindow(client.windows[0]), 4000,
        {350: 'icon-open-350', 800: 'icon-open-800', 1600: 'icon-open-1600'});
    setSlowdown(1);
    const w = client.windows[0];
    c.ok('window appeared', !!w);
    const withCorners = r.trace.filter(e => e.present && e.vis && e.corners !== null);
    const vis = r.trace.filter(e => e.present && e.vis && e.o > 0);
    const first = withCorners[0];
    const ic = {x: icon.x + 32, y: icon.y + 32};
    c.ok('starts on the icon (centre within 40 px)', first && distance(center(first), ic) < 40,
        first ? JSON.stringify(first) : 'none');
    c.ok('corners during the movement', withCorners.some(e => e.corners > 0));
    c.ok('continuous (jump <= 80 px per frame, slow-down x 4)', biggestJump(r.trace) <= 80, `${biggestJump(r.trace)}`);
    const t0 = first?.t ?? 0;
    const full = vis.find(e => e.o === 255);
    const expected = L.alphaDelayMs + L.alphaDurationMs * SLOWDOWN; // delay in real ms (toolkit)
    c.ok('opaque after 25 + 50 ms (+-2 frames)', full && Math.abs(full.t - t0 - expected) <= 2 * 1000 / 60,
        `${full ? round3(full.t - t0) : null} real ms, expected ${expected}`);
    if (w && first) {
        const end = frameOf(w);
        // Fit by height (square icon, window wider than tall): displayed height = lerp(64, h, u).
        const gap = curveGap(withCorners.map(e => ({t: e.t, y: e.h})), icon.height, end.h, L.curve, L.durationMs,
            SLOWDOWN, value);
        c.ok('bounds on the 500 ms emphasized path (gap <= 2 % of the travel)',
            gap.gap <= 0.02 * (end.h - icon.height), `gap ${round3(gap.gap)} px`);
        const last = vis[vis.length - 1];
        c.ok('settled on its frame', last && rectGap(last, end) <= 1, JSON.stringify({last, end}));
        await checkWindowAtRest(c, w, 'end');
    }
    return checksResult(c, traceExtra(r));
}

async function windowClose(scene) {
    const c = new Checks();
    const windows = await motion('motion/windows.js');
    const {w} = await settledWindow(scene, 'Close');
    const a = w.get_compositor_private();
    let destroyed = null;
    const t0 = GLib.get_monotonic_time();
    a.connect('destroy', () => {
        destroyed = (GLib.get_monotonic_time() - t0) / 1000;
    });
    setSlowdown(SLOWDOWN);
    // After delete(), the window is no longer managed (get_compositor_private() is null): read the kept actor.
    const zone = frameZone(w);
    const p = scene.trace(() => destroyed === null ? readWindow(null, a, zone) : {present: false}, 2500,
        {150: 'window-close-150'});
    w.delete(global.get_current_time());
    const r = await p;
    setSlowdown(1);
    const vis = r.trace.filter(e => e.present && e.vis);
    c.ok('actor destroyed (completed_destroy received)', destroyed !== null, `${destroyed} ms`);
    c.ok('opacity decreasing to almost 0', vis.length > 2 && vis[vis.length - 1].o < 40,
        `last o=${vis[vis.length - 1]?.o}`);
    c.ok('no scale on exit', vis.every(e => e.sx === 1 && e.sy === 1));
    c.ok('short exit (FastEffects: destroyed before 600 ms, slow-down x 4)', destroyed !== null && destroyed < 600,
        `${destroyed}`);
    c.ok('no window effect running', windows._diagnostic().effects === 0);
    return checksResult(c, traceExtra(r));
}

// Closing a window that has an icon (dock): return to the icon on the springs of Android's return-to-home.
async function windowCloseToIcon(scene) {
    const c = new Checks();
    const windows = await motion('motion/windows.js');
    const {w} = await settledWindow(scene, 'Close to the icon');
    const icon = {x: 40, y: 1000, w: 48, h: 48};
    w.set_icon_geometry(new Mtk.Rectangle({x: icon.x, y: icon.y, width: icon.w, height: icon.h}));
    const a = w.get_compositor_private();
    let destroyed = null;
    const t0 = GLib.get_monotonic_time();
    a.connect('destroy', () => {
        destroyed = (GLib.get_monotonic_time() - t0) / 1000;
    });
    // Displayed rectangle: clip of the corners effect (zone of the return), read on the kept actor.
    const read = () => {
        if (destroyed !== null)
            return {present: false};
        const e = a.get_effect('m3e-corners');
        return readWindow(null, a, e && e.width >= 0 ? {x: e.left, y: e.top, w: e.width, h: e.height}
            : frameZone(w));
    };
    setSlowdown(SLOWDOWN);
    const p = scene.trace(read, 4000, {300: 'window-close-icon-300'});
    w.delete(global.get_current_time());
    const r = await p;
    setSlowdown(1);
    const present = r.trace.filter(e => e.present && e.vis);
    const vis = present.filter(e => e.o > 0);
    const last = present[present.length - 1];
    c.ok('actor destroyed (completed_destroy received)', destroyed !== null, `${destroyed} ms`);
    c.ok('arrives on the icon (centre within 2 px, icon size)', last &&
        distance(center(last), center(icon)) < 2 && Math.abs(last.w - icon.w) < 2, JSON.stringify(last));
    c.ok('corners during the return', vis.some(e => e.corners !== null && e.corners > 0));
    c.ok('continuous (jump <= 80 px per frame, slow-down x 4)', biggestJump(r.trace) <= 80, `${biggestJump(r.trace)}`);
    c.ok('fades out on arrival (opacity 255 until 60 % of the return, 0 on arrival)', vis.length > 3 &&
        vis[0].o === 255 && last.o === 0, `o=${last?.o}`);
    c.ok('no window effect running', windows._diagnostic().effects === 0);
    return checksResult(c, traceExtra(r));
}

async function windowDialog(scene) {
    const c = new Checks();
    setSlowdown(SLOWDOWN);
    const client = scene.launchClient('dialog', 'Dialog parent');
    await waitUntil(() => client.windows[0]?.get_compositor_private(), 10000);
    const r = await scene.trace(() => readWindow(client.windows[1]), 5000, {1400: 'window-dialog-1400'});
    setSlowdown(1);
    const d = client.windows[1];
    c.ok('dialog appeared', !!d);
    if (d) {
        c.ok('transient dialog', d.get_transient_for() === client.windows[0]);
        const vis = r.trace.filter(e => e.present && e.vis && e.o > 0);
        const sMin = Math.min(...vis.map(e => e.sx));
        c.ok('fade-in (scale from about 0.8)', sMin <= 0.86 && sMin >= 0.79, `min=${sMin}`);
        await checkWindowAtRest(c, d, 'dialog');
    }
    return checksResult(c, traceExtra(r));
}

async function windowMinimize(scene) {
    const c = new Checks();
    const {w} = await settledWindow(scene, 'Minimize');
    w.set_icon_geometry(new Mtk.Rectangle({x: 40, y: 1000, width: 48, height: 48}));
    const ci = {x: 64, y: 1024};
    setSlowdown(SLOWDOWN);
    let p = scene.trace(() => readWindow(w), 3500, {500: 'minimize-500'});
    w.minimize();
    let r = await p;
    // End geometry read even after the fade (MDC: the window fades on [0.6; 0.9] of the return).
    const vis = r.trace.filter(e => e.present && e.vis);
    const last = vis[vis.length - 1];
    c.ok('minimized', w.minimized);
    c.ok('actor hidden by mutter (completed_minimize received)', !w.get_compositor_private().visible);
    c.ok('arrives in the icon (centre within 12 px)', last && distance(center(last), ci) < 12, JSON.stringify(last));
    // MDC AUTO fit: the content keeps its proportions (fitted to the icon's short side), the container (clip) takes
    // the icon's bounds.
    c.ok('arrives at the icon size (short side <= 60 px)', last && Math.min(last.w, last.h) <= 60,
        `${last?.w}x${last?.h}`);
    const down = r;
    p = scene.trace(() => readWindow(w), 3500, {500: 'restore-500'});
    w.unminimize();
    r = await p;
    setSlowdown(1);
    const vis2 = r.trace.filter(e => e.present && e.vis && e.o > 0);
    const first = vis2[0];
    c.ok('restored', !w.minimized);
    c.ok('restore starts from the icon (centre within 80 px)', first && distance(center(first), ci) < 80,
        JSON.stringify(first));
    const end = frameOf(w), last2 = vis2[vis2.length - 1];
    c.ok('restore settled on the frame', last2 && rectGap(last2, end) <= 1, JSON.stringify({last2, end}));
    await wait(1200);
    await checkWindowAtRest(c, w, 'end');
    return checksResult(c, {trace: down.trace, restoreTrace: r.trace, files: [...down.files, ...r.files],
        lost: down.lost + r.lost, duration_ms: down.duration_ms + r.duration_ms});
}

async function windowMinimizeReversal(scene) {
    const c = new Checks();
    const {w} = await settledWindow(scene, 'Reversal');
    w.set_icon_geometry(new Mtk.Rectangle({x: 40, y: 1000, width: 48, height: 48}));
    setSlowdown(SLOWDOWN);
    const p = scene.trace(() => readWindow(w), 4500, {300: 'reversal-300'});
    w.minimize();
    await wait(500);
    w.unminimize();
    const r = await p;
    setSlowdown(1);
    c.ok('restored', !w.minimized);
    const jump = biggestJump(r.trace);
    c.ok('continuity at the reversal (jump <= 40 px per frame, slow-down x 4)', jump <= 40, `${jump}`);
    c.ok('never hidden during the reversal', r.trace.filter(e => e.present).every(e => e.vis));
    const vis = r.trace.filter(e => e.present && e.vis);
    const wMin = Math.min(...vis.map(e => e.w));
    c.ok('reversed before reaching the icon (min width > 60 px)', wMin > 60, `${wMin}`);
    const end = frameOf(w), last = vis[vis.length - 1];
    c.ok('settled on the frame', last && rectGap(last, end) <= 1, JSON.stringify({last, end}));
    await wait(1200);
    await checkWindowAtRest(c, w, 'end');
    return checksResult(c, traceExtra(r));
}

async function windowMaximize(scene) {
    const c = new Checks();
    const windows = await motion('motion/windows.js');
    const {w} = await settledWindow(scene, 'Maximize');
    const before = frameOf(w);
    const children = global.window_group.get_n_children();
    const signals = [];
    const ids = ['size-change', 'size-changed', 'kill-window-effects'].map(n =>
        global.window_manager.connect(n, (m, a, ...rest) => signals.push({n, t: GLib.get_monotonic_time(),
            what: rest[0] ?? null, effects: windows._diagnostic().kinds.join(',')})));
    setSlowdown(SLOWDOWN);
    let p = scene.trace(() => readWindow(w), 3500, {350: 'maximize-350'});
    w.maximize();
    let r = await p;
    ids.forEach(id => global.window_manager.disconnect(id));
    const vis = r.trace.filter(e => e.present && e.vis);
    const after = frameOf(w);
    c.ok('size-change signals received', signals.some(x => x.n === 'size-change'), JSON.stringify(signals));
    c.ok('maximized (frame enlarged)', after.w > before.w && after.h > before.h, JSON.stringify({before, after}));
    const first = vis[0];
    c.ok('starts from the previous frame (<= 40 px)', first && rectGap(first, before) <= 40, JSON.stringify(first));
    c.ok('settled on the new frame', rectGap(vis[vis.length - 1], after) <= 1);
    c.ok('continuous (jump <= 60 px per frame)', biggestJump(r.trace) <= 60, `${biggestJump(r.trace)}`);
    await wait(800);
    c.ok('snapshot removed', global.window_group.get_n_children() === children,
        `${global.window_group.get_n_children()} / ${children}`);
    await checkWindowAtRest(c, w, 'after maximize');
    const max = r;
    p = scene.trace(() => readWindow(w), 3500);
    w.unmaximize();
    r = await p;
    setSlowdown(1);
    await wait(1200);
    c.ok('restored to its size', rectGap(frameOf(w), before) <= 1, JSON.stringify(frameOf(w)));
    await checkWindowAtRest(c, w, 'after restore');
    return checksResult(c, {trace: max.trace, restoreTrace: r.trace, files: max.files,
        lost: max.lost + r.lost, duration_ms: max.duration_ms + r.duration_ms});
}

export const windowScenarios = {
    'window-open': windowOpen,
    'window-open-from-icon': windowOpenFromIcon,
    'window-close': windowClose,
    'window-close-to-icon': windowCloseToIcon,
    'window-dialog': windowDialog,
    minimize: windowMinimize,
    'minimize-reversal': windowMinimizeReversal,
    maximize: windowMaximize,
};
