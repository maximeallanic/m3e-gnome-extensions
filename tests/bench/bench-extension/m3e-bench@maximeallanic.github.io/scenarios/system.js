// Scenarios: system surfaces on SystemUI motions (OSD: volume dialog spring; modal dialogs: DialogTransitionAnimator
// springs; banners: 400 ms FAST_OUT_SLOW_IN / REVERSE).
import Gio from 'gi://Gio';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

import {ANDROID} from '../m3e/tokens.js';
import {value} from '../m3e/curve.js';
import {SLOWDOWN, Checks, checksResult, round3, setSlowdown, wait, waitUntil} from '../tools.js';
import {curveGap} from './window-tools.js';

const gapOf = (trace, y0, y1, curve, durationMs) =>
    curveGap(trace, y0, y1, curve, durationMs, SLOWDOWN, value).gap;
const traceExtra = r => ({trace: r.trace, files: r.files, lost: r.lost, duration_ms: r.duration_ms});

async function osd(scene) {
    const c = new Checks();
    setSlowdown(SLOWDOWN);
    const window_ = Main.osdWindowManager._osdWindows[Main.layoutManager.primaryIndex];
    const box = window_._hbox;
    const p = scene.trace(() => ({vis: window_.visible, o: box.opacity, ty: round3(box.translation_y),
        h: round3(box.height), s: round3(box.scale_x)}), 10000, {250: 'osd-250'});
    Main.osdWindowManager.showOne(Main.layoutManager.primaryIndex,
        Gio.ThemedIcon.new('audio-volume-high-symbolic'), 'Bench', 0.5, 1);
    const r = await p;
    setSlowdown(1);
    const t = r.trace.filter(e => e.vis);
    const first = t[0];
    c.ok('OSD shown', t.length > 3);
    c.ok('entry: from the bottom, by its height (VolumeDialogViewBinder: lerp(width, 0, fraction))',
        first && first.h > 0 && Math.abs(first.ty - first.h) <= 0.1 * first.h, JSON.stringify(first));
    c.ok('all-or-nothing opacity (255 on every displayed frame)', t.every(e => e.o === 255));
    c.ok('no scale', t.every(e => e.s === 1));
    const iRest = t.findIndex(e => e.ty === 0);
    const entry = t.slice(0, iRest + 1);
    c.ok('entry: 700 / 0.9 spring with no visible overshoot (>= -0.5 px)', iRest > 2 &&
        entry.every(e => e.ty >= -0.5), `${iRest} frames`);
    // 700 / 0.9 spring over ~60 px: rest (0.5 px) in ~240 ms; with slow-down x 4, about 1 s.
    const entryMs = iRest > 0 ? (t[iRest].t - first.t) / SLOWDOWN : null;
    c.ok('entry settled in 150 to 400 ms', entryMs > 150 && entryMs < 400, `${round3(entryMs)} ms`);
    const exit = t.slice(iRest).filter(e => e.ty > 0);
    c.ok('exit: goes back down', exit.length > 2 && exit[exit.length - 1].ty > 0.8 * first.h,
        JSON.stringify(exit[exit.length - 1]));
    c.ok('hidden afterwards (_reset)', !window_.visible);
    c.ok('box back at rest', box.opacity === 255 && box.translation_y === 0);
    return checksResult(c, traceExtra(r));
}

async function shellDialog(scene) {
    const c = new Checks();
    const dialog = new ModalDialog.ModalDialog({destroyOnClose: true});
    dialog.contentLayout.add_child(new St.Label({text: 'Bench dialog'}));
    dialog.addButton({label: 'Close', action: () => dialog.close()});
    let destroyed = false, opened = false;
    dialog.connect('destroy', () => {
        destroyed = true;
    });
    dialog.connect('opened', () => {
        opened = true;
    });
    const card = dialog.dialogLayout._dialog;
    setSlowdown(SLOWDOWN);
    const p = scene.trace(() => destroyed ? {} : ({o: dialog.opacity, s: round3(card.scale_x),
        c: dialog.contentLayout.opacity, state: dialog.state}), 4500, {300: 'shell-dialog-300'});
    dialog.open();
    await wait(2500);
    dialog.close();
    const r = await p;
    setSlowdown(1);
    const t = r.trace.filter(e => e.s !== undefined);
    const opening = t.filter(e => e.state === ModalDialog.State.OPENING);
    c.ok('opened signal emitted', opened);
    c.ok('opening: card from about 0.8 (no overshoot)', opening.length > 3 && Math.min(...opening.map(e => e.s)) <= 0.82 &&
        t.every(e => e.s <= 1.001), `min ${Math.min(...opening.map(e => e.s))}`);
    // Content: transparent while the progress is under 0.85 (scale < 0.8 + 0.2 x 0.85 = 0.97).
    c.ok('opening: content fades in at the end only (progress >= 0.85)',
        opening.filter(e => e.s < 0.965).every(e => e.c === 0) && opening.some(e => e.c > 0 && e.c < 255),
        JSON.stringify(opening.filter(e => e.c > 0).slice(0, 2)));
    const closing = t.filter(e => e.state === ModalDialog.State.CLOSING);
    c.ok('closing: content cleared before the card (window [0; 0.8])', closing.length > 2 &&
        closing.some(e => e.c === 0 && e.o > 0), JSON.stringify(closing.slice(0, 3)));
    c.ok('closing: card shrinks', closing.length > 2 && Math.min(...closing.map(e => e.s)) < 0.95);
    c.ok('closed and destroyed (_closeComplete)', destroyed);
    return checksResult(c, traceExtra(r));
}

async function notification(scene) {
    const c = new Checks();
    const B = ANDROID.banner;
    const source = new MessageTray.Source({title: 'Bench', iconName: 'dialog-information-symbolic'});
    Main.messageTray.add(source);
    const n = new MessageTray.Notification({source, title: 'Bench notification', body: 'Banner',
        isTransient: true});
    // Transient: the Shell destroys it itself once hidden.
    let destroyed = false;
    n.connect('destroy', () => {
        destroyed = true;
    });
    const tray = Main.messageTray;
    const bin = tray._bannerBin;
    const read = () => ({state: tray._notificationState, o: bin.opacity, y: round3(bin.translation_y),
        h: round3(bin.height), s: round3(bin.scale_x)});
    setSlowdown(SLOWDOWN);
    const p = scene.trace(read, 2600, {350: 'notification-350'});
    source.addNotification(n);
    const r = await p;
    const t = r.trace.filter(e => e.o > 0);
    c.ok('banner shown', t.length > 3 && tray._notificationState === MessageTray.State.SHOWN,
        `${tray._notificationState}`);
    c.ok('all-or-nothing opacity, no scale', t.every(e => e.o === 255 && e.s === 1));
    const anim = t.filter(e => e.y < 0);
    c.ok('entry: from the top, by its height', anim.length > 3 && anim[0].y <= -0.85 * anim[0].h,
        JSON.stringify(anim[0]));
    // Start: banner height, instant searched around the first animated frame.
    const gapEnter = anim.length ? gapOf(anim, -anim[0].h, 0, B.enter, B.durationMs) : Infinity;
    c.ok('entry: FAST_OUT_SLOW_IN in 400 ms (gap <= 4 % of the height)', gapEnter <= 0.04 * (anim[0]?.h ?? 0),
        `gap ${round3(gapEnter)} px`);
    // Animated exit: expiration (Escape, end of the delay), like the Shell; a destroyed notification leaves without animation.
    const p2 = scene.trace(read, 2600);
    tray._expireNotification();
    const r2 = await p2;
    setSlowdown(1);
    const s = r2.trace.filter(e => e.o > 0 && e.y < 0);
    c.ok('exit: goes back up by its height', s.length > 3 && s[s.length - 1].y <= -0.9 * s[0].h,
        JSON.stringify(s[s.length - 1]));
    const gapExit = s.length ? gapOf(s, 0, -s[0].h, B.exit, B.durationMs) : Infinity;
    c.ok('exit: FAST_OUT_SLOW_IN_REVERSE in 400 ms (gap <= 6 % of the height)', gapExit <= 0.06 * (s[0]?.h ?? 0),
        `gap ${round3(gapExit)} px`);
    c.ok('banner hidden', await waitUntil(() => tray._notificationState === MessageTray.State.HIDDEN, 2000),
        `${tray._notificationState}`);
    if (!destroyed)
        n.destroy();
    return checksResult(c, {trace: r.trace, exitTrace: r2.trace, files: r.files,
        lost: r.lost + r2.lost, duration_ms: r.duration_ms + r2.duration_ms});
}

export const systemScenarios = {
    osd,
    'shell-dialog': shellDialog,
    notification,
};
