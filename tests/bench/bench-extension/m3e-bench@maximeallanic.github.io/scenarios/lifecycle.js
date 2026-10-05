// Scenarios: disabling the extension in the middle of movements, and Shell animations turned off.
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as OsdWindow from 'resource:///org/gnome/shell/ui/osdWindow.js';
import * as WorkspaceAnimation from 'resource:///org/gnome/shell/ui/workspaceAnimation.js';
import Mtk from 'gi://Mtk';

import {SLOWDOWN, Checks, checksResult, setSlowdown, wait, waitUntil} from '../tools.js';
import {motion, underTest, extensionOf, MOTION} from './under-test.js';
import {settledWindow} from './window-tools.js';

const overviewState = () => Main.overview._overview.controls._stateAdjustment;

// Shell methods that the extension patches, read now (so, from whatever state the Shell is in).
function shellOriginals() {
    return {
        osdShow: OsdWindow.OsdWindow.prototype.show,
        dialogFadeOpen: ModalDialog.ModalDialog.prototype._fadeOpen,
        trayHide: MessageTray.MessageTray.prototype._hideNotification,
        folderIn: AppDisplay.AppFolderDialog.prototype._zoomAndFadeIn,
        appActivate: Shell.App.prototype.activate,
        ease: WorkspaceAnimation.MonitorGroup.prototype.ease_property,
    };
}

// disable() of the extension in the middle of movements. The extension object is the real one the Shell runs
// (stateObj): its own disable() and enable() are called, exactly what the Shell does.
async function disableMidMotion(scene) {
    const c = new Checks();
    const windows = await motion('motion/windows.js');
    const toolkit = await underTest(MOTION, 'm3e/animate.js');
    const ext = extensionOf(MOTION).stateObj;
    // Reference: the Shell's own methods, read while the extension is disabled.
    ext.disable();
    const originals = shellOriginals();
    await ext.enable();
    await wait(200);
    c.ok('patched methods differ from the originals while enabled', shellOriginals().osdShow !== originals.osdShow);
    const {w} = await settledWindow(scene, 'Disable');
    w.set_icon_geometry(new Mtk.Rectangle({x: 40, y: 1000, width: 48, height: 48}));
    setSlowdown(SLOWDOWN);
    w.minimize();
    Main.overview.show();
    await wait(250);
    // disable() of the extension, in the middle of the movements.
    ext.disable();
    setSlowdown(1);
    await wait(300);
    const now = shellOriginals();
    c.ok('prototypes restored', Object.keys(originals).every(k => now[k] === originals[k]),
        JSON.stringify(Object.keys(originals).filter(k => now[k] !== originals[k])));
    c.ok('instance properties removed', !Object.prototype.hasOwnProperty.call(Main.wm, '_shouldAnimateActor') &&
        !Object.prototype.hasOwnProperty.call(overviewState(), 'ease') &&
        !Object.prototype.hasOwnProperty.call(Main.wm._workspaceAnimation, 'animateSwitch'));
    c.ok('minimize declared finished (window minimized, actor hidden)', w.minimized &&
        !w.get_compositor_private().visible);
    c.ok('overview arrived (callbacks played)', Main.overview._shownState === 'SHOWN', Main.overview._shownState);
    c.ok('toolkit empty', toolkit._diagnostic().tracks === 0, JSON.stringify(toolkit._diagnostic()));
    Main.overview.hide();
    await waitUntil(() => !Main.overview.visible, 5000);
    // Shell handlers unblocked: a new window follows the Shell's own animation. Read at map time (after the
    // handlers): the Shell adds the actor to _mapping before its 150 ms animation.
    let atMap = null;
    const mapId = global.window_manager.connect_after('map', (m, a) => {
        atMap ??= {mapping: Main.wm._mapping.has(a), effects: windows._diagnostic().effects};
    });
    scene.launchClient('window', 'After disable');
    await waitUntil(() => atMap, 10000);
    global.window_manager.disconnect(mapId);
    c.ok('opening handed back to the Shell (its own animation)', atMap?.mapping && atMap.effects === 0,
        JSON.stringify(atMap));
    await wait(800);
    w.unminimize();
    await wait(800);
    await ext.enable();
    await wait(200);
    return checksResult(c);
}

// enable-animations = false: everything is set at once. The setting is written in the nested Shell's PRIVATE dconf.
async function motionNoAnimations(scene) {
    const c = new Checks();
    const windows = await motion('motion/windows.js');
    const settings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    settings.set_boolean('enable-animations', false);
    await waitUntil(() => !St.Settings.get().enable_animations, 3000);
    try {
        const client = scene.launchClient('window', 'No animations');
        const w = await waitUntil(() => client.windows[0]?.get_compositor_private() && client.windows[0], 10000);
        await wait(100);
        const a = w?.get_compositor_private();
        c.ok('window shown at once', a && a.opacity === 255 && a.scale_x === 1);
        c.ok('no effect running', windows._diagnostic().effects === 0);
        Main.overview.show();
        await wait(100);
        c.ok('overview set at once', Math.abs(overviewState().value - 1) < 1e-6 &&
            Main.overview._shownState === 'SHOWN', `${overviewState().value} ${Main.overview._shownState}`);
        Main.overview.hide();
        await wait(100);
        c.ok('overview hidden at once', !Main.overview.visible);
    } finally {
        settings.set_boolean('enable-animations', true);
        await waitUntil(() => St.Settings.get().enable_animations, 3000);
    }
    return checksResult(c);
}

export const lifecycleScenarios = {
    'disable-mid-motion': disableMidMotion,
    'motion-no-animations': motionNoAnimations,
};
