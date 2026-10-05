// Scenarios: quick settings tiles (morph and bounce), switch, notification list. No real input: presses go through the
// test seams of the modules (_press, _release).
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {ANDROID} from '../m3e/tokens.js';
import {state} from '../m3e/spring.js';
import {value} from '../m3e/curve.js';
import {SLOWDOWN, Checks, checksResult, round3, setSlowdown, wait, waitUntil} from '../tools.js';
import {motion, underTest, MOTION} from './under-test.js';
import {curveGap} from './window-tools.js';

const T = ANDROID.tile;
const S = ANDROID.switch;
const component = path => underTest(MOTION, path);

// Morph of a tile (actor carrying the style): radius, colour progress, radius spring time.
function readMorph(actor) {
    const m = actor._m3eMorph;
    const timing = m?.radiusAnimation?.timing(m.radiusPath);
    return {r: round3(m?.radius ?? -1), p: round3(m?.p ?? -1), running: !!m?.running, style: actor.get_style(),
        el: m?.running && timing && !timing.done ? timing.elapsed : null};
}

function themeRadius(actor) {
    const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const r = actor.get_theme_node().get_border_radius(St.Corner.TOPLEFT) / sf;
    return Math.min(r, Math.min(actor.width, actor.height) / sf / 2);
}

async function addedTiles(n) {
    const menu = Main.panel.statusArea.quickSettings.menu;
    const tiles = [];
    for (let i = 0; i < n; i++) {
        const t = i === n - 1 && n > 2
            ? new QuickSettings.QuickMenuToggle({title: `Bench ${i}`, iconName: 'emblem-ok-symbolic', toggleMode: true})
            : new QuickSettings.QuickToggle({title: `Bench ${i}`, iconName: 'emblem-ok-symbolic', toggleMode: true});
        menu.addItem(t);
        tiles.push(t);
    }
    menu.open(0);
    await wait(400);
    return {menu, tiles};
}

async function morph(scene, c, actor, button, name, from, to) {
    c.ok(`${name}: rest radius ${from} px`, Math.abs(themeRadius(actor) - from) < 0.6, `${themeRadius(actor)}`);
    let p = scene.trace(() => readMorph(actor), 900);
    button.checked = !button.checked;
    const r = await p;
    const anim = r.trace.filter(e => e.el !== null);
    let gap = 0;
    for (const e of anim)
        gap = Math.max(gap, Math.abs(e.r - (to + state(T.spring, from - to, 0, e.el).x)));
    c.ok(`${name}: radius ${from} -> ${to} on Compose spring() (1 / 1500), gap <= 0.05 px`, anim.length > 3 && gap <= 0.05,
        `gap ${round3(gap)} over ${anim.length} frames`);
    // Colour progress at 99 % (it stays at 1 after the morph ends).
    const start = r.trace.find(e => e.running);
    const pEnd = start ? r.trace.find(e => e.t >= start.t && e.p >= 0.99) : null;
    const tColour = pEnd ? round3(pEnd.t - start.t) : null;
    c.ok(`${name}: colour settled in ~150 ms (phone: 150-160 ms; 99 % between 80 and 220 ms)`,
        tColour !== null && tColour > 80 && tColour < 220, `${tColour} ms`);
    c.ok(`${name}: at rest, inline style removed, theme radius ${to} px`, actor.get_style() === null &&
        Math.abs(themeRadius(actor) - to) < 0.6, `${actor.get_style()} ${themeRadius(actor)}`);
    // Reversal halfway (slowed down): no radius jump, back to `from`.
    setSlowdown(SLOWDOWN);
    p = scene.trace(() => readMorph(actor), 2500);
    button.checked = !button.checked;
    await wait(200);
    button.checked = !button.checked;
    await wait(150);
    button.checked = !button.checked;
    const reversal = await p;
    setSlowdown(1);
    let jump = 0;
    const running = reversal.trace.filter(e => e.running);
    for (let i = 1; i < running.length; i++)
        jump = Math.max(jump, Math.abs(running[i].r - running[i - 1].r));
    c.ok(`${name}: reversals without a jump (<= 1 px per frame at slow-down x 4)`, jump <= 1, `${round3(jump)}`);
    c.ok(`${name}: after reversals, at rest on ${from} px`, actor.get_style() === null &&
        Math.abs(themeRadius(actor) - from) < 0.6, `${themeRadius(actor)}`);
    return r.trace;
}

async function tileMorph(scene) {
    const c = new Checks();
    const tiles = await component('components/tiles.js');
    const {menu, tiles: list} = await addedTiles(3);
    const single = list[0], double = list[2];
    const half = single.height / St.ThemeContext.get_for_stage(global.stage).scale_factor / 2;
    const traceSingle = await morph(scene, c, single, single, 'single tile', half, 19);
    const icon = double._box.get_first_child()._icon;
    const traceDouble = await morph(scene, c, icon, double, 'menu tile chip', 22, 12);
    menu.close(0);
    for (const t of list)
        t.destroy();
    c.ok('tile tracking released on destruction', tiles._diagnostic().morphs === 0, JSON.stringify(tiles._diagnostic()));
    return checksResult(c, {trace: traceSingle, doubleTrace: traceDouble});
}

async function tileBounce(scene) {
    const c = new Checks();
    const tiles = await component('components/tiles.js');
    const {menu, tiles: list} = await addedTiles(3);
    // Two tiles side by side.
    const y = t => t.get_allocation_box().y1;
    const pair = [[0, 1], [1, 2]].map(([a, b]) => [list[a], list[b]]).find(([a, b]) => Math.abs(y(a) - y(b)) < 1);
    c.ok('two tiles on a row', !!pair);
    if (!pair) {
        menu.close(0);
        list.forEach(t => t.destroy());
        return checksResult(c);
    }
    const [a, b] = pair;
    const [left, right] = a.get_allocation_box().x1 < b.get_allocation_box().x1 ? [a, b] : [b, a];
    const edges = t => {
        const e = t.get_transformed_extents();
        return {x1: round3(e.origin.x), x2: round3(e.origin.x + e.size.width)};
    };
    const before = {l: edges(left), r: edges(right)};
    const bounce = T.bounceDp * ANDROID.density;
    const read = () => ({l: edges(left), r: edges(right), cs: round3(left.get_first_child().scale_x * left.scale_x)});
    let p = scene.trace(read, 700);
    tiles._press(left);
    const press = await p;
    const last = press.trace[press.trace.length - 1];
    c.ok('press: the tile widens by 8 dp x 56/72 towards its neighbour', Math.abs(last.l.x2 - before.l.x2 - bounce) < 0.3 &&
        Math.abs(last.l.x1 - before.l.x1) < 0.3, JSON.stringify({before, last}));
    c.ok('press: the neighbour narrows by as much, outer edge fixed', Math.abs(last.r.x1 - before.r.x1 - bounce) < 0.3 &&
        Math.abs(last.r.x2 - before.r.x2) < 0.3, JSON.stringify(last.r));
    c.ok('content not stretched (composed scale = 1)', press.trace.every(e => Math.abs(e.cs - 1) < 0.002));
    p = scene.trace(read, 700);
    tiles._release(left);
    const release = await p;
    const end = release.trace[release.trace.length - 1];
    c.ok('release: back to the grid widths', Math.abs(end.l.x2 - before.l.x2) < 0.3 &&
        Math.abs(end.r.x1 - before.r.x1) < 0.3 && left.scale_x === 1 && right.scale_x === 1, JSON.stringify(end));
    // Very short press: the return waits for 75 % of the amplitude (Bounceable).
    p = scene.trace(read, 900);
    tiles._press(left);
    tiles._release(left);
    const brief = await p;
    const max = Math.max(...brief.trace.map(e => e.l.x2 - before.l.x2));
    c.ok('brief press: the bounce reaches at least 75 % of 8 dp before returning', max >= 0.75 * bounce - 0.05 &&
        Math.abs(brief.trace[brief.trace.length - 1].l.x2 - before.l.x2) < 0.3, `max ${round3(max)} px`);
    menu.close(0);
    list.forEach(t => t.destroy());
    return checksResult(c, {trace: press.trace, releaseTrace: release.trace, briefTrace: brief.trace});
}

async function switchScenario(scene) {
    const c = new Checks();
    const sws = await component('components/switch.js');
    const item = new PopupMenu.PopupSwitchMenuItem('Bench', false);
    Main.layoutManager.uiGroup.add_child(item);
    item.set_position(200, 200);
    await wait(300);
    const sw = item._switch;
    const e = sw._m3e;
    // Displayed centre of the handle (allocation + translation): the translation jumps when the final place changes.
    const read = () => {
        const b = sw._handle.get_allocation_box();
        return {w: round3(e.w), h: round3(e.h), tx: round3(sw._handle.translation_x),
            cx: round3(b.x1 + b.get_width() / 2 + sw._handle.translation_x), icon: e.icon.icon_name};
    };
    c.ok('off: 24 handle with a cross', e.w === S.thumbDp && e.h === S.thumbDp &&
        e.icon.icon_name === 'window-close-symbolic', JSON.stringify(read()));
    setSlowdown(SLOWDOWN);
    let p = scene.trace(read, 1600);
    sw.state = true;
    const r = await p;
    const first = r.trace[0];
    c.ok('check icon at once', first.icon === 'object-select-symbolic');
    const widest = r.trace.reduce((m, x) => (x.w > m.w ? x : m), r.trace[0]);
    const anim = r.trace.filter(x => x.tx !== 0);
    const t0 = anim[0]?.t ?? 0;
    c.ok('morphing shape 32 x 22 reached around 150 ms (off -> on)', widest.w > 31 && widest.h < 23 &&
        Math.abs((widest.t - t0) / SLOWDOWN - S.morphLongMs) <= 25,
    `${JSON.stringify(widest)} at ${round3((widest.t - t0) / SLOWDOWN)} ms`);
    const gap = curveGap(anim.map(x => ({t: x.t, y: x.tx})), anim[0]?.tx ?? 0, 0, S.slideCurve,
        S.slideMs, SLOWDOWN, value);
    c.ok('slide in 250 ms AccelerateDecelerate (gap <= 1 px)', anim.length > 3 && gap.gap <= 1,
        `gap ${round3(gap.gap)} px, start ${anim[0]?.tx}`);
    const last = r.trace[r.trace.length - 1];
    c.ok('on: 24 handle at rest', last.w === S.thumbDp && last.h === S.thumbDp && last.tx === 0, JSON.stringify(last));
    // Press: 28 in 100 ms (standard), release: 24.
    p = scene.trace(read, 900);
    sws._press(sw, true);
    const pressed = await p;
    c.ok('press: 28 handle', pressed.trace[pressed.trace.length - 1].w === S.thumbPressedDp,
        JSON.stringify(pressed.trace[pressed.trace.length - 1]));
    sws._press(sw, false);
    await wait(700);
    c.ok('release: 24 handle', e.w === S.thumbDp);
    // Reversal during the slide: restarts from the displayed place.
    p = scene.trace(read, 2000);
    sw.state = false;
    await wait(300);
    sw.state = true;
    const reversal = await p;
    setSlowdown(1);
    let jump = 0;
    for (let i = 1; i < reversal.trace.length; i++)
        jump = Math.max(jump, Math.abs(reversal.trace[i].cx - reversal.trace[i - 1].cx));
    c.ok('reversal without a jump of the displayed centre (<= 4 px per frame at slow-down x 4)', jump <= 4, `${jump}`);
    item.destroy();
    return checksResult(c, {trace: r.trace, reversalTrace: reversal.trace, lost: r.lost, duration_ms: r.duration_ms});
}

async function notificationList(scene) {
    const c = new Checks();
    const notifications = await motion('motion/notifications.js');
    const view = Main.panel.statusArea.dateMenu._messageList._messageView;
    const sources = [];
    const alive = new Set();
    const notify = (src, title) => {
        const n = new MessageTray.Notification({source: src, title, body: 'Bench list'});
        alive.add(n);
        n.connect('destroy', () => alive.delete(n));
        src.addNotification(n);
        return n;
    };
    for (const title of ['Bench list A', 'Bench list B']) {
        const s = new MessageTray.Source({title, iconName: 'dialog-information-symbolic'});
        Main.messageTray.add(s);
        sources.push(s);
    }
    const n1 = notify(sources[0], 'A1');
    const n2 = notify(sources[0], 'A2');
    const n3 = notify(sources[1], 'B1');
    const menu = Main.panel.statusArea.dateMenu.menu;
    menu.open(0);
    await waitUntil(() => view.messages.length >= 2, 3000);
    await wait(500);
    const marks = () => notifications.items(view).map(m =>
        `${m.has_style_pseudo_class(notifications.FIRST) ? 'F' : ''}${m.has_style_pseudo_class(notifications.LAST) ? 'L' : ''}`);
    const nonItems = () => {
        const els = new Set(notifications.items(view));
        const all = [];
        const walk = a => {
            if (a.has_style_class_name?.('message'))
                all.push(a);
            for (const ch of a.get_children())
                walk(ch);
        };
        walk(view);
        return all.filter(m => !els.has(m) && (m.has_style_pseudo_class(notifications.FIRST) ||
            m.has_style_pseudo_class(notifications.LAST))).length;
    };
    let e = marks();
    c.ok('list: first item m3e-first, last m3e-last, middle none', e.length >= 2 && e[0] === 'F' &&
        e[e.length - 1] === 'L' && e.slice(1, -1).every(x => x === ''), JSON.stringify(e));
    c.ok('stacked messages (not shown on top) have no pseudo-class', nonItems() === 0);
    // Expanding the two-message group.
    const group = view.messages.find(m => m.source === sources[0]);
    await group?.expand();
    await wait(400);
    e = marks();
    c.ok('expanded group: its messages are items', group && e.length === 3 && e[0] === 'F' && e[2] === 'L',
        JSON.stringify(e));
    await group?.collapse();
    await wait(400);
    // Removal: the list follows on the 380 / 0.68 spring (Y translation).
    const rows = view.get_children().filter(ch => ch.child);
    const destroyed = new Set();
    rows.forEach(i => i.connect('destroy', () => destroyed.add(i)));
    const read = () => ({ty: rows.filter(i => !destroyed.has(i)).map(i => round3(i.translation_y))});
    const p = scene.trace(read, 1500);
    // First item removed (whole group A, or B).
    for (const n of view.messages[0] === group ? [n1, n2] : [n3])
        n.destroy();
    const r = await p;
    const moved = r.trace.some(x => x.ty.some(t => Math.abs(t) > 1));
    c.ok('removal: the following items slide (Y translation)', moved);
    c.ok('removal: spring settled afterwards', r.trace[r.trace.length - 1].ty.every(t => t === 0),
        JSON.stringify(r.trace[r.trace.length - 1]));
    await wait(300);
    e = marks();
    c.ok('after removal: a lone item = m3e-first and m3e-last', e.length >= 1 && e[0].includes('F') &&
        e[e.length - 1].includes('L'), JSON.stringify(e));
    menu.close(0);
    for (const n of [...alive])
        n.destroy();
    return checksResult(c, {trace: r.trace});
}

export const componentScenarios = {
    'tile-morph': tileMorph,
    'tile-bounce': tileBounce,
    switch: switchScenario,
    'notification-list': notificationList,
};
