// Scenarios: Shell surfaces (window switcher, tile preview, app folders, window preview hover).
import Mtk from 'gi://Mtk';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AltTab from 'resource:///org/gnome/shell/ui/altTab.js';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as WindowPreview from 'resource:///org/gnome/shell/ui/windowPreview.js';
import {ControlsState} from 'resource:///org/gnome/shell/ui/overviewControls.js';

import {SLOWDOWN, Checks, checksResult, round3, setSlowdown, wait, waitUntil} from '../tools.js';
import {settledWindow, frameOf} from './window-tools.js';

const traceExtra = r => ({trace: r.trace, files: r.files, lost: r.lost, duration_ms: r.duration_ms});

function findActor(actor, predicate) {
    if (predicate(actor))
        return actor;
    for (const child of actor.get_children()) {
        const found = findActor(child, predicate);
        if (found)
            return found;
    }
    return null;
}

async function switcher(scene) {
    const c = new Checks();
    await settledWindow(scene, 'Switcher 1');
    await settledWindow(scene, 'Switcher 2');
    const popup = new AltTab.WindowSwitcherPopup();
    let destroyed = false;
    popup.connect('destroy', () => {
        destroyed = true;
    });
    const p = scene.trace(() => destroyed ? {} : ({o: popup.opacity, lo: popup._switcherList?.opacity,
        s: round3(popup._switcherList?.scale_x ?? 1)}), 4000, {400: 'switcher-400'});
    const shown = popup.show(false, 'switch-windows', 0);
    const r = await p;
    c.ok('switcher shown', shown);
    const t = r.trace.filter(e => e.lo > 0 && e.o > 0);
    c.ok('list fades in (scale from about 0.8)', t.length > 0 && Math.min(...t.map(e => e.s)) <= 0.86);
    c.ok('closed and destroyed (fadeAndDestroy)', destroyed);
    return checksResult(c, traceExtra(r));
}

async function tilePreview(scene) {
    const c = new Checks();
    const {w} = await settledWindow(scene, 'Tile preview');
    const m = Main.layoutManager.primaryMonitor;
    const rect = new Mtk.Rectangle({x: m.x, y: m.y + 32, width: Math.floor(m.width / 2), height: m.height - 32});
    setSlowdown(SLOWDOWN);
    const read = () => {
        const tp = Main.wm._tilePreview;
        return tp ? {vis: tp.visible, x: round3(tp.x), w: round3(tp.width), o: tp.opacity} : {};
    };
    const p = scene.trace(read, 3000, {300: 'tile-preview-300'});
    Main.wm._showTilePreview(global.window_manager, w, rect, m.index);
    const r = await p;
    const t = r.trace.filter(e => e.vis);
    const f = frameOf(w);
    c.ok('preview starts from the window frame', t.length > 0 && Math.abs(t[0].w - f.w) < 0.35 * f.w,
        `${t[0]?.w} / ${f.w}`);
    c.ok('preview settled on the zone', t.length > 0 && Math.abs(t[t.length - 1].w - rect.width) <= 1 &&
        t[t.length - 1].o === 255);
    const p2 = scene.trace(read, 2000);
    Main.wm._hideTilePreview();
    const r2 = await p2;
    setSlowdown(1);
    c.ok('preview hidden', !Main.wm._tilePreview.visible);
    return checksResult(c, {trace: r.trace, exitTrace: r2.trace, files: r.files,
        lost: r.lost + r2.lost, duration_ms: r.duration_ms + r2.duration_ms});
}

async function folder(scene) {
    const c = new Checks();
    const ad = Main.overview._overview.controls._appDisplay;
    const folderIcon = ad._orderedItems?.find(i => i instanceof AppDisplay.FolderIcon);
    if (!folderIcon) {
        c.ok('no app folder in the nested Shell: scenario skipped', true);
        return checksResult(c, {skipped: true});
    }
    Main.overview.show(ControlsState.APP_GRID);
    await waitUntil(() => Main.overview._shownState === 'SHOWN', 5000);
    await wait(500);
    ad.goToPage(ad._grid.getItemPage(folderIcon), false);
    await wait(500);
    setSlowdown(SLOWDOWN);
    folderIcon.open?.() ?? folderIcon._ensureFolderDialog();
    const dlg = folderIcon._dialog;
    const read = () => ({vis: dlg.visible, o: dlg.child.opacity, s: round3(dlg.child.scale_x),
        icon: folderIcon.opacity});
    const p = scene.trace(read, 3500, {400: 'folder-400'});
    if (!dlg.visible)
        dlg.popup();
    const r = await p;
    c.ok('folder open', dlg.visible && dlg.child.opacity === 255 && dlg.child.scale_x === 1);
    c.ok('icon hidden during the opening', r.trace.filter(e => e.vis).every(e => e.icon === 0));
    const s0 = Math.min(...r.trace.filter(e => e.vis && e.o > 0).map(e => e.s));
    c.ok('starts from the icon size (scale < 0.5)', s0 < 0.5, `${s0}`);
    const p2 = scene.trace(read, 3500);
    dlg.popdown();
    const r2 = await p2;
    setSlowdown(1);
    c.ok('folder closed', !dlg.visible);
    c.ok('icon restored at the end', folderIcon.opacity === 255);
    c.ok('icon hidden during the return', r2.trace.filter(e => e.vis).every(e => e.icon === 0));
    Main.overview.hide();
    await waitUntil(() => !Main.overview.visible, 5000);
    return checksResult(c, {trace: r.trace, exitTrace: r2.trace, files: r.files,
        lost: r.lost + r2.lost, duration_ms: r.duration_ms + r2.duration_ms});
}

async function previewHover(scene) {
    const c = new Checks();
    await settledWindow(scene, 'Preview');
    Main.overview.show();
    await waitUntil(() => Main.overview._shownState === 'SHOWN', 5000);
    await wait(400);
    const preview = findActor(Main.layoutManager.overviewGroup, a => a instanceof WindowPreview.WindowPreview);
    if (!preview) {
        c.ok('window preview found', false);
        return checksResult(c);
    }
    setSlowdown(SLOWDOWN);
    const read = () => ({s: round3(preview.window_container.scale_x), o: preview._title.opacity});
    const p = scene.trace(read, 2000);
    preview.showOverlay(true);
    const r = await p;
    const sMax = Math.max(...r.trace.map(e => e.s));
    const sEnd = r.trace[r.trace.length - 1].s;
    c.ok('preview enlarged on hover (spring, visible overshoot)', sEnd > 1 && sMax >= sEnd, `${sMax} / ${sEnd}`);
    c.ok('title shown', preview._title.opacity === 255);
    const p2 = scene.trace(read, 2000);
    preview.hideOverlay(true);
    const r2 = await p2;
    setSlowdown(1);
    c.ok('preview back to 1', preview.window_container.scale_x === 1);
    c.ok('title hidden', !preview._title.visible);
    Main.overview.hide();
    await waitUntil(() => !Main.overview.visible, 5000);
    return checksResult(c, {trace: r.trace, exitTrace: r2.trace, lost: r.lost + r2.lost,
        duration_ms: r.duration_ms + r2.duration_ms});
}

export const surfaceScenarios = {
    switcher,
    'tile-preview': tilePreview,
    folder,
    'preview-hover': previewHover,
};
