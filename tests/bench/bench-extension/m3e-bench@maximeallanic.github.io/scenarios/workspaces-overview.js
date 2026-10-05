// Scenarios: workspace switch, overview, app grid.
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as WindowPreview from 'resource:///org/gnome/shell/ui/windowPreview.js';

import {SLOWDOWN, Checks, checksResult, round3, setSlowdown, wait, waitUntil} from '../tools.js';
import {motion} from './under-test.js';
import {settledWindow, checkWindowAtRest} from './window-tools.js';

const traceExtra = r => ({trace: r.trace, files: r.files, lost: r.lost, duration_ms: r.duration_ms});

async function twoWorkspaces(scene) {
    const a = await settledWindow(scene, 'Workspace 1');
    const b = await settledWindow(scene, 'Workspace 2');
    b.w.change_workspace_by_index(1, false);
    await waitUntil(() => global.workspace_manager.get_n_workspaces() >= 2, 3000);
    await wait(300);
    return {a, b};
}

const overviewState = () => Main.overview._overview.controls._stateAdjustment;

async function workspaces(scene) {
    const c = new Checks();
    const workspacesModule = await motion('motion/workspaces.js');
    await twoWorkspaces(scene);
    setSlowdown(SLOWDOWN);
    const read = () => {
        const sd = Main.wm._workspaceAnimation._switchData;
        return {active: !!sd, ...workspacesModule._diagnostic().groups};
    };
    const p = scene.trace(read, 3500, {300: 'workspaces-300', 700: 'workspaces-700'});
    global.workspace_manager.get_workspace_by_index(1).activate(global.get_current_time());
    const r = await p;
    setSlowdown(1);
    const t = r.trace.filter(e => e.active && e.incoming);
    c.ok('switch animated by m3e-motion', t.length > 5, `${t.length} frames`);
    if (t.length > 0) {
        const e0 = t[0];
        c.ok('incoming starts shifted by about 30 px', Math.abs(Math.abs(e0.incoming.tx) - 30) <= 4,
            `${e0.incoming.tx}`);
        c.ok('outgoing fades before the incoming passes 50 %',
            t.filter(e => e.incoming.o > 128).every(e => e.outgoing.o < 20));
        const last = t[t.length - 1];
        c.ok('incoming arrived (translation ~ 0, opacity ~ 255)', Math.abs(last.incoming.tx) < 1 &&
            last.incoming.o > 240, JSON.stringify(last.incoming));
    }
    c.ok('workspace 1 active', global.workspace_manager.get_active_workspace_index() === 1);
    c.ok('switch finished (groups destroyed, mutter told)', !Main.wm._workspaceAnimation._switchData &&
        !Main.wm._switchInProgress);
    return checksResult(c, traceExtra(r));
}

async function workspacesReversal(scene) {
    const c = new Checks();
    const workspacesModule = await motion('motion/workspaces.js');
    await twoWorkspaces(scene);
    setSlowdown(SLOWDOWN);
    const p = scene.trace(() => {
        const sd = Main.wm._workspaceAnimation._switchData;
        return {active: !!sd, ...workspacesModule._diagnostic().groups};
    }, 4500);
    global.workspace_manager.get_workspace_by_index(1).activate(global.get_current_time());
    await wait(450);
    const before = workspacesModule._diagnostic().groups;
    global.workspace_manager.get_workspace_by_index(0).activate(global.get_current_time());
    const after = workspacesModule._diagnostic().groups;
    const r = await p;
    setSlowdown(1);
    c.ok('first switch running at the time of the reversal', !!before?.incoming, JSON.stringify(before));
    c.ok('second switch started', !!after?.outgoing, JSON.stringify(after));
    if (before?.incoming && after?.outgoing) {
        c.ok('restarts from the displayed position (<= 2 px)', Math.abs(after.outgoing.tx - before.incoming.tx) <= 2,
            `${before.incoming.tx} -> ${after.outgoing.tx}`);
        c.ok('restarts from the displayed opacity (<= 8)', Math.abs(after.outgoing.o - before.incoming.o) <= 8,
            `${before.incoming.o} -> ${after.outgoing.o}`);
    }
    c.ok('workspace 0 active', global.workspace_manager.get_active_workspace_index() === 0);
    c.ok('switch finished', !Main.wm._workspaceAnimation._switchData && !Main.wm._switchInProgress);
    return checksResult(c, {trace: r.trace, lost: r.lost, duration_ms: r.duration_ms});
}

async function workspacesGesture(scene) {
    const c = new Checks();
    const gestures = await motion('motion/gestures.js');
    await twoWorkspaces(scene);
    const ctrl = Main.wm._workspaceAnimation;
    const fake = {orientation: 0, confirmSwipe() {}};
    ctrl._switchWorkspaceBegin(fake, Main.layoutManager.primaryIndex);
    ctrl._switchWorkspaceUpdate(fake, 0.3);
    const mg = ctrl._switchData.monitors[0];
    const snapPoints = mg.getSnapPoints();
    let mgDestroyed = false;
    mg.connect('destroy', () => {
        mgDestroyed = true;
    });
    const VELOCITY = 0.004; // progress per ms (4 workspaces/s)
    gestures._noteGesture(null, VELOCITY);
    const p = scene.trace(() => ({prog: mgDestroyed ? null : round3(mg.progress)}), 2000);
    ctrl._switchWorkspaceEnd(fake, 250, 1);
    const r = await p;
    const t = r.trace.filter(e => e.prog !== null);
    c.ok('end of gesture on a spring', t.length > 5, `${t.length} frames`);
    if (t.length > 2) {
        const d = (t[1].prog - t[0].prog) / Math.max(1e-3, (t[1].t - t[0].t) / 1000);
        c.ok('starts with the finger velocity (about 4 workspaces/s, +-40 %)', d > 2.4 && d < 5.6, `${round3(d)}/s`);
        const max = Math.max(...t.map(e => e.prog));
        // Spatial overshoot of the spring between two workspaces (DefaultSpatial, zeta = 0.8: a few %), clamped only at
        // the extreme workspaces.
        c.ok('slight overshoot, within bounds', max <= 1.05 && max <= Math.max(...snapPoints) + 1e-6,
            `${max} (bounds ${snapPoints})`);
        c.ok('settled on workspace 1', Math.abs(t[t.length - 1].prog - 1) < 1e-3, `${t[t.length - 1].prog}`);
    }
    await waitUntil(() => !ctrl._switchData, 3000);
    c.ok('workspace 1 active', global.workspace_manager.get_active_workspace_index() === 1);
    c.ok('gesture finished (groups destroyed)', !ctrl._switchData);
    return checksResult(c, {trace: r.trace, lost: r.lost, duration_ms: r.duration_ms});
}

async function overview(scene) {
    const c = new Checks();
    await settledWindow(scene, 'Overview');
    setSlowdown(SLOWDOWN);
    const read = () => ({state: round3(overviewState().value)});
    let p = scene.trace(read, 3000, {400: 'overview-enter-400'});
    Main.overview.show();
    let r = await p;
    const enter = r;
    const t = r.trace;
    c.ok('overview shown', Main.overview._shownState === 'SHOWN', Main.overview._shownState);
    c.ok('state clamped (<= 1: the grid does not enter)', Math.max(...t.map(e => e.state)) <= 1 + 1e-6);
    c.ok('state monotonic on entry', t.every((e, i) => i === 0 || e.state >= t[i - 1].state - 1e-6));
    c.ok('movement driven by the spring (more than 10 intermediate frames)',
        t.filter(e => e.state > 0.01 && e.state < 0.99).length > 10);
    p = scene.trace(read, 3000);
    Main.overview.hide();
    r = await p;
    setSlowdown(1);
    c.ok('overview hidden', Main.overview._shownState === 'HIDDEN' && !Main.overview.visible);
    c.ok('state back to 0', overviewState().value === 0);
    return checksResult(c, {trace: enter.trace, exitTrace: r.trace, files: enter.files,
        lost: enter.lost + r.lost, duration_ms: enter.duration_ms + r.duration_ms});
}

async function overviewReversal(scene) {
    const c = new Checks();
    await settledWindow(scene, 'Overview, reversal');
    setSlowdown(SLOWDOWN);
    const p = scene.trace(() => ({state: round3(overviewState().value)}), 5000);
    Main.overview.show();
    await wait(350);
    const middle = overviewState().value;
    Main.overview.hide();
    await wait(500);
    const back = overviewState().value;
    Main.overview.show();
    const r = await p;
    setSlowdown(1);
    const t = r.trace;
    let jump = 0;
    for (let i = 1; i < t.length; i++)
        jump = Math.max(jump, Math.abs(t[i].state - t[i - 1].state));
    c.ok('exit requested during the entry (intermediate state)', middle > 0.05 && middle < 0.95, `${middle}`);
    c.ok('reversed without waiting for the end (state < value at reversal + overshoot)', back < middle + 0.15,
        `${middle} -> ${back}`);
    c.ok('continuous (state jump <= 0.08 per frame, slow-down x 4)', jump <= 0.08, `${round3(jump)}`);
    c.ok('overview finally shown', Main.overview._shownState === 'SHOWN', Main.overview._shownState);
    c.ok('final state 1', Math.abs(overviewState().value - 1) < 1e-6, `${overviewState().value}`);
    return checksResult(c, {trace: t, lost: r.lost, duration_ms: r.duration_ms});
}

async function appGrid(scene) {
    const c = new Checks();
    Main.overview.show();
    await waitUntil(() => Main.overview._shownState === 'SHOWN', 5000);
    const controls = Main.overview._overview.controls;
    const ad = controls._appDisplay;
    setSlowdown(SLOWDOWN);
    const read = () => ({state: round3(overviewState().value), y: round3(ad.get_transformed_position()[1]),
        o: ad.opacity, vis: ad.visible});
    const p = scene.trace(read, 3000, {500: 'app-grid-500'});
    controls._toggleAppsPage();
    const r = await p;
    setSlowdown(1);
    const t = r.trace.filter(e => e.vis);
    c.ok('grid shown', Math.abs(overviewState().value - 2) < 1e-6);
    if (t.length > 3) {
        const yEnd = t[t.length - 1].y;
        const dy = Math.max(...t.map(e => e.y)) - yEnd;
        c.ok('enters by a slide of about 30 px (shared axis Y)', dy >= 20 && dy <= 40, `${round3(dy)} px`);
        c.ok('transparent before 35 % of the progress', t.filter(e => e.state < 1.3).every(e => e.o <= 5));
        c.ok('opaque at the end', t[t.length - 1].o === 255);
    } else {
        c.ok('grid visible during the transition', false, `${t.length} frames`);
    }
    const p2 = scene.trace(read, 3000);
    controls._toggleAppsPage();
    const r2 = await p2;
    c.ok('back to the windows', Math.abs(overviewState().value - 1) < 1e-6);
    const t2 = r2.trace.filter(e => e.vis);
    c.ok('on the way back the grid fades early (transparent below 1.6)', t2.filter(e => e.state < 1.6).every(e => e.o <= 5));
    Main.overview.hide();
    await waitUntil(() => !Main.overview.visible, 5000);
    return checksResult(c, {trace: r.trace, backTrace: r2.trace, files: r.files,
        lost: r.lost + r2.lost, duration_ms: r.duration_ms + r2.duration_ms});
}

// A window closed during the opening, then during the closing of the overview (preview destroyed while the spring
// advances the layout). The log check of report.py catches any destroyed object touched or Clutter assertion.
async function overviewCloseWindow(scene) {
    const c = new Checks();
    const a = await settledWindow(scene, 'Overview, close A');
    const b = await settledWindow(scene, 'Overview, close B');
    const cc = await settledWindow(scene, 'Overview, close C');
    setSlowdown(SLOWDOWN);
    Main.overview.show();
    await wait(250);
    const middle = overviewState().value;
    b.w.delete(global.get_current_time());
    await waitUntil(() => Main.overview._shownState === 'SHOWN', 8000);
    await wait(300);
    Main.overview.hide();
    await wait(250);
    const middleExit = overviewState().value;
    cc.w.delete(global.get_current_time());
    await waitUntil(() => !Main.overview.visible, 8000);
    setSlowdown(1);
    c.ok('close during the entry (intermediate state)', middle > 0.02 && middle < 0.98, `${middle}`);
    c.ok('close during the exit (intermediate state)', middleExit > 0.02 && middleExit < 0.98, `${middleExit}`);
    c.ok('overview hidden at the end', Main.overview._shownState === 'HIDDEN' && !Main.overview.visible,
        Main.overview._shownState);
    await wait(500);
    await checkWindowAtRest(c, a.w, 'remaining window');

    // Exact path of a real-world log: a hovered or focused preview (title shown) whose "below" preview in the stack
    // (_stackAbove) disappears, then the overview closes: overlayEnabled -> hideOverlay(false) -> _restack.
    await settledWindow(scene, 'Overview, close D');
    Main.overview.show();
    await waitUntil(() => Main.overview._shownState === 'SHOWN', 8000);
    await wait(400);
    const previews = [];
    const collect = actor => {
        if (actor instanceof WindowPreview.WindowPreview)
            previews.push(actor);
        actor.get_children().forEach(collect);
    };
    collect(Main.layoutManager.overviewGroup);
    const p = previews.find(x => x._stackAbove instanceof WindowPreview.WindowPreview);
    c.ok('preview with a preview below it found', !!p, `${previews.length} previews`);
    if (p) {
        p.showOverlay(false);
        const below = p._stackAbove;
        setSlowdown(SLOWDOWN);
        below.metaWindow.delete(global.get_current_time());
        await waitUntil(() => below._destroyed, 3000);
        // The Shell normally re-orders the stack after the removal; the state seen in the real log (preview below
        // destroyed but still referenced) is put back as it was to replay the path deterministically.
        p._stackAbove = below;
        Main.overview.hide();
        await waitUntil(() => !Main.overview.visible, 8000);
        setSlowdown(1);
        c.ok('overview hidden after closing under a hovered preview', !Main.overview.visible);
    }
    return checksResult(c);
}

export const workspaceOverviewScenarios = {
    workspaces,
    'workspaces-reversal': workspacesReversal,
    'workspaces-gesture': workspacesGesture,
    overview,
    'overview-reversal': overviewReversal,
    'app-grid': appGrid,
    'overview-close-window': overviewCloseWindow,
};
