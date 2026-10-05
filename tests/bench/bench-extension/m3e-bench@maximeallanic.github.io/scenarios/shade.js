// Scenarios: quick settings and calendar panels ("shade" choreography of the Pixel): content slides down by
// 164 dp x 56/72 on a measured spring, closes by cutting off at 150 dp.
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ANDROID} from '../m3e/tokens.js';
import {state} from '../m3e/spring.js';
import {SLOWDOWN, Checks, checksResult, round3, setSlowdown, wait, waitUntil} from '../tools.js';

const V = ANDROID.qsShade;
// Distances recomputed from the tokens (independent of the extension under test).
const OPEN_PX = V.openDp * ANDROID.density;
const CLOSE_PX = V.closeDp * ANDROID.density;
const CUTOFF_PX = V.cutoffDp * ANDROID.density;
const ANIMATE_FULL = 1 | 2; // PopupAnimation.FULL

// Displayed displacement of the panel (px, upward): translation of the first child of the card; spring time.
function readShade(menu) {
    const b = menu._boxPointer;
    const child = b.bin.get_child()?.get_first_child();
    const driver = b._m3eShade?._driver;
    const timing = driver?._segment?.anim?.timing(driver._path) ?? null;
    return {vis: b.visible, o: b.opacity, d: child ? round3(-child.translation_y) : null,
        clip: child ? child.has_clip : null, sx: round3(b.scale_x),
        el: timing && !timing.done ? timing.elapsed : null};
}

async function shade(scene, buttonName) {
    const c = new Checks();
    const menu = Main.panel.statusArea[buttonName].menu;
    const b = menu._boxPointer;
    const read = () => readShade(menu);
    // Real-time curves (comparison with a phone recording is not part of this bench).
    let p = scene.trace(read, 1500);
    menu.open(ANIMATE_FULL);
    const realOpen = await p;
    p = scene.trace(read, 1000);
    menu.close(ANIMATE_FULL);
    const realClose = await p;
    await waitUntil(() => !b.visible, 3000);
    await wait(200);
    // Slowed-down opening: start, spring measured frame by frame.
    setSlowdown(SLOWDOWN);
    p = scene.trace(read, 4000, {300: `shade-${buttonName}-open-300`});
    menu.open(ANIMATE_FULL);
    const open = await p;
    const anim = open.trace.filter(e => e.vis && e.el !== null && e.d !== null);
    const first = anim[0];
    c.ok('opening: starts about 164 dp x 56/72 above its place', first && Math.abs(first.d - OPEN_PX) < 6,
        `d=${first?.d} expected ${round3(OPEN_PX)}`);
    c.ok('opening: invisible at the start (beyond the cutoff)', first && first.o === 0, `o=${first?.o}`);
    let gap = 0;
    for (const e of anim)
        gap = Math.max(gap, Math.abs(e.d - state(V.spring, OPEN_PX, 0, e.el / SLOWDOWN).x));
    c.ok('opening: measured spring (0.925 / 197) frame by frame, gap <= 0.5 px', anim.length > 10 && gap <= 0.5,
        `max gap ${round3(gap)} px over ${anim.length} frames`);
    c.ok('opening: opacity tied to the displacement (1 - d / cutoff)', anim.every(e =>
        Math.abs(e.o - Math.round(255 * Math.min(1, Math.max(0, 1 - e.d / CUTOFF_PX)))) <= 1));
    c.ok('opening: no visible overshoot (<= 0.5 px)', anim.every(e => e.d >= -0.5));
    c.ok('open: panel at rest (content in place, no clip, opacity 255, scale 1)', menu.isOpen &&
        b.opacity === 255 && b.scale_x === 1 && read().d === 0 && !read().clip, JSON.stringify(read()));
    // Closing: towards 177 dp, cut at 150 dp.
    p = scene.trace(read, 3000, {300: `shade-${buttonName}-close-300`});
    const t0 = GLib.get_monotonic_time();
    let closedMs = null;
    const id = menu.connect('menu-closed', () => {
        closedMs ??= (GLib.get_monotonic_time() - t0) / 1000 / SLOWDOWN;
    });
    menu.close(ANIMATE_FULL);
    const close = await p;
    menu.disconnect(id);
    const visible = close.trace.filter(e => e.vis && e.d !== null);
    c.ok('closing: content goes up and fades out', visible.length > 3 && visible[visible.length - 1].o <= 3,
        JSON.stringify(visible[visible.length - 1]));
    c.ok('closing: cut at about 150 dp x 56/72 (<= 5 px beyond)', visible.every(e => e.d <= CUTOFF_PX + 5),
        `max ${Math.max(...visible.map(e => e.d))}`);
    c.ok('closed: panel hidden, content back in place', !b.visible && !menu.isOpen && read().d === 0);
    c.ok('closing in about 270 ms like the phone (200 to 340 ms)', closedMs !== null && closedMs > 200 && closedMs < 340,
        `${closedMs} ms`);
    // Reversals: during the opening, then during the closing.
    p = scene.trace(read, 9000);
    menu.open(ANIMATE_FULL);
    await wait(400);
    menu.close(ANIMATE_FULL);
    const closed1 = !!await waitUntil(() => !b.visible, 5000);
    menu.open(ANIMATE_FULL);
    await waitUntil(() => !b._m3eShade?.running && read().d === 0, 5000);
    menu.close(ANIMATE_FULL);
    await wait(250);
    menu.open(ANIMATE_FULL);
    await waitUntil(() => !b._m3eShade?.running && read().d === 0, 5000);
    const reversal = await p;
    setSlowdown(1);
    // Jump brought back to one frame: <= the largest spring velocity over a period (slow-down x 4).
    let jump = 0;
    for (let i = 1; i < reversal.trace.length; i++) {
        const a = reversal.trace[i - 1], e = reversal.trace[i];
        if (a.vis && e.vis && a.d !== null && e.d !== null)
            jump = Math.max(jump, Math.abs(e.d - a.d) / Math.max(1, Math.round((e.t - a.t) / (1000 / 60))));
    }
    c.ok('continuous reversals (<= 12 px per frame at slow-down x 4)', jump <= 12, `${round3(jump)}`);
    c.ok('reversal during the opening: closed again', closed1);
    c.ok('reversal during the closing: reopened at rest', menu.isOpen && b.visible && b.opacity === 255 &&
        read().d === 0);
    menu.close(0);
    await wait(200);
    return checksResult(c, {trace: open.trace, closeTrace: close.trace, reversalTrace: reversal.trace,
        realOpenTrace: realOpen.trace, realCloseTrace: realClose.trace, closePx: CLOSE_PX,
        files: [...open.files, ...close.files], lost: open.lost + close.lost + reversal.lost,
        duration_ms: open.duration_ms + close.duration_ms + reversal.duration_ms});
}

export const shadeScenarios = {
    'shade-quick-settings': scene => shade(scene, 'quickSettings'),
    'shade-calendar': scene => shade(scene, 'dateMenu'),
};
