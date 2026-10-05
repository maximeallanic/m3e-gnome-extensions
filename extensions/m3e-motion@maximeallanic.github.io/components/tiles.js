// Quick settings tiles like Android's (SystemUI qs/panels/ui/compose/infinitegrid/Tile.kt):
//   - morph of shape and colour on activation: radius (pill <-> 19 px), background and content colour led by
//     Compose's default spring() (damping 1, stiffness 1500: animateDpAsState, animateColorAsState), instead of St's
//     150 ms fade. Simple tile: the tile itself; tile with a menu (two targets): the icon chip (circle <-> 12 px),
//     the tile background not changing;
//   - press bounce (Bounceable.kt): the pressed tile widens by bounceDp x 56/72 (about 6 px) and its row neighbour
//     shrinks as much (default spring()); on release the return waits until the bounce has reached 75 % of its
//     amplitude (1 s at most).
//
// Method (St does not interpolate border-radius: its transition cross-fades the old rendering into the new one):
// on every frame the interpolated radius, background and colour are set as an inline style (set_style) with
// transition-duration: 0ms, which also removes the transition St has just created on the :checked change; at the end
// the inline style is removed and the stylesheet takes over again on identical values. Start and end values are
// read from the theme node (theme stylesheet, no colour hardcoded here), colours are blended in Oklab like Compose's
// ColorVectorConverter. The radius is animated in px (its velocity is kept on a reversal), colours by a progress.
// Cost: one style recomputation per frame and per animated tile while a morph runs (a few hundred ms per toggle).
// Bounce: width shown by a horizontal scale around the fixed edge, children counter-scaled and anchored at the start
// edge (the content is not stretched); the grid layout is not touched.
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {animate, virtualProperty, removeProperty} from '../m3e/animate.js';
import {ANDROID} from '../m3e/tokens.js';
import {animationsAllowed} from '../motion/utils.js';
import {blendOklab} from './oklab.js';

export const NAME = 'tiles';

const T = ANDROID.tile;
const BOUNCE_PX = T.bounceDp * ANDROID.density;
const RADIUS_PROPERTY = 'm3e-tile-radius';
const PROGRESS_PROPERTY = 'm3e-tile-progress';
const BOUNCE_LEFT = 'm3e-bounce-left';
const BOUNCE_RIGHT = 'm3e-bounce-right';

let grid = null;
let addedId = 0;
const tracked = new Map(); // grid item -> [[object, id]...]
const morphs = new Set(); // actors whose inline style is set by the morph

const scaleFactor = () => St.ThemeContext.get_for_stage(global.stage).scale_factor;

// --- morph ------------------------------------------------------------------------------------------------------

// Values of the current theme node: radius from the stylesheet (logical px, 999 for a pill), background, content.
function readNode(actor) {
    const n = actor.get_theme_node();
    return {radius: n.get_border_radius(St.Corner.TOPLEFT) / scaleFactor(), background: n.get_background_color(),
        foreground: n.get_foreground_color()};
}

// Displayed radius: limited to half the height (St draws a pill for a larger radius), size read at the start of the
// morph (the actor may not be allocated when the rest is noted).
function clampRadius(actor, r) {
    const half = Math.min(actor.width, actor.height) / scaleFactor() / 2;
    return half > 0 ? Math.min(r, half) : r;
}

const rgba = c => `rgba(${c.red}, ${c.green}, ${c.blue}, ${(c.alpha / 255).toFixed(4)})`;

function writeStyle(m) {
    const background = blendOklab(m.from.background, m.to.background, m.p);
    const foreground = blendOklab(m.from.foreground, m.to.foreground, m.p);
    m.writing = true;
    m.actor.set_style(`border-radius: ${Math.max(0, m.radius).toFixed(3)}px; background-color: ${rgba(background)}; ` +
        `color: ${rgba(foreground)}; transition-duration: 0ms;`);
    m.writing = false;
}

function finishMorph(m) {
    m.running = false;
    m.writing = true;
    m.actor.set_style(null);
    m.writing = false;
    morphs.delete(m.actor);
    m.rest = {state: m.button.checked, values: readNode(m.actor)};
}

// Theme node change of `actor`. If the checked state of `button` changed since the last rest, the morph starts from
// the displayed values (noted rest, or interpolated values of a running morph) towards those of the new node.
function onStyle(m) {
    if (m.writing)
        return;
    // Off screen (closed menu): no morph, and the noted rest is no longer reliable (read again on next display).
    if (!m.actor.mapped) {
        if (!m.running)
            m.rest = null;
        return;
    }
    const checked = m.button.checked;
    if (!m.running) {
        if (!m.rest || m.rest.state === checked || !animationsAllowed()) {
            m.rest = {state: checked, values: readNode(m.actor)};
            return;
        }
    } else if (checked === m.targetState) {
        return; // other style change during the morph (hover): the inline style stays
    }
    const from = m.running
        ? {radius: m.radius, background: blendOklab(m.from.background, m.to.background, m.p),
            foreground: blendOklab(m.from.foreground, m.to.foreground, m.p)}
        : {...m.rest.values, radius: clampRadius(m.actor, m.rest.values.radius)};
    // Arrival: the node without our inline style.
    m.writing = true;
    m.actor.set_style(null);
    m.writing = false;
    const read = readNode(m.actor);
    const to = {...read, radius: clampRadius(m.actor, read.radius)};
    m.from = from;
    m.to = to;
    m.targetState = checked;
    // The colour progress restarts from 0 (start = displayed colour): the old animation is stopped, otherwise the new
    // one would take over its value.
    m.colorAnimation?.stop();
    m.p = 0;
    if (!m.running)
        m.radius = from.radius;
    m.running = true;
    morphs.add(m.actor);
    writeStyle(m);
    let remaining = 2;
    const onDone = () => {
        if (--remaining === 0)
            finishMorph(m);
    };
    // Radius in px (velocity kept if a morph is taken over), colours by a 0 -> 1 progress.
    m.radiusAnimation = animate(m.actor, {[m.radiusPath]: to.radius}, {spring: T.spring, threshold: 0.5, onDone});
    m.colorAnimation = animate(m.actor, {[m.progressPath]: 1}, {spring: T.spring, threshold: 0.01, onDone});
}

function wireMorph(actor, button) {
    const m = {actor, button, running: false, writing: false, rest: null, p: 0, radius: 0, from: null, to: null,
        targetState: null};
    m.radiusPath = virtualProperty(actor, RADIUS_PROPERTY, {
        read: () => m.radius,
        write: v => {
            m.radius = v;
            if (m.running)
                writeStyle(m);
        },
    });
    m.progressPath = virtualProperty(actor, PROGRESS_PROPERTY, {
        read: () => (m.running ? m.p : 1),
        write: v => {
            m.p = Math.min(1, Math.max(0, v));
            if (m.running)
                writeStyle(m);
        },
    });
    if (actor.mapped)
        m.rest = {state: button.checked, values: readNode(actor)};
    actor._m3eMorph = m;
    return [
        [actor, actor.connect('style-changed', () => onStyle(m))],
        [actor, actor.connect('notify::mapped', () => {
            if (actor.mapped && !m.running)
                m.rest = {state: button.checked, values: readNode(actor)};
        })],
    ];
}

function unwireMorph(actor) {
    const m = actor._m3eMorph;
    if (!m)
        return;
    m.radiusAnimation?.stop();
    m.colorAnimation?.stop();
    if (m.running) {
        m.writing = true;
        actor.set_style(null);
        m.writing = false;
    }
    morphs.delete(actor);
    removeProperty(actor, RADIUS_PROPERTY);
    removeProperty(actor, PROGRESS_PROPERTY);
    delete actor._m3eMorph;
}

// --- bounce -----------------------------------------------------------------------------------------------------

// Displayed width of `item` widened by l px on the left and r px on the right (negative: narrowed), content not stretched.
function applyWidth(item) {
    const {left, right} = item._m3eBounce;
    const w = item.width;
    if (!(w > 0))
        return;
    const s = (w + left + right) / w;
    item.set_pivot_point(0, 0.5);
    item.set({scale_x: s, translation_x: -left});
    for (const c of item.get_children()) {
        const a = c.x;
        c.set_pivot_point(0, 0.5);
        c.set({scale_x: 1 / s, translation_x: a / s - a});
    }
}

function bounceState(item) {
    if (!item._m3eBounce) {
        const b = {left: 0, right: 0};
        item._m3eBounce = b;
        b.leftPath = virtualProperty(item, BOUNCE_LEFT, {read: () => b.left, write: v => {
            b.left = v;
            applyWidth(item);
            b.onValue?.();
        }});
        b.rightPath = virtualProperty(item, BOUNCE_RIGHT, {read: () => b.right, write: v => {
            b.right = v;
            applyWidth(item);
            b.onValue?.();
        }});
    }
    return item._m3eBounce;
}

const isTile = item => item instanceof QuickSettings.QuickToggle || item instanceof QuickSettings.QuickMenuToggle;

// Immediate neighbours of `item` on its row (same allocation top): {left, right}.
function neighbours(item) {
    const box = item.get_allocation_box();
    let left = null, right = null;
    for (const other of item.get_parent()?.get_children() ?? []) {
        if (other === item || !other.visible || !isTile(other))
            continue;
        const c = other.get_allocation_box();
        if (Math.abs(c.y1 - box.y1) > 1)
            continue;
        if (c.x2 <= box.x1 + 1 && (!left || c.x2 > left.get_allocation_box().x2))
            left = other;
        else if (c.x1 >= box.x2 - 1 && (!right || c.x1 < right.get_allocation_box().x1))
            right = other;
    }
    return {left, right};
}

function goToBounce(item, left, right) {
    const b = bounceState(item);
    b.animation = animate(item, {[b.leftPath]: left, [b.rightPath]: right}, {spring: T.bounceSpring, threshold: 0.5});
}

function press(item) {
    if (!animationsAllowed() || !item.mapped)
        return;
    const {left, right} = neighbours(item);
    if (!left && !right)
        return;
    const share = left && right ? BOUNCE_PX / 2 : BOUNCE_PX;
    const touched = [item];
    goToBounce(item, left ? share : 0, right ? share : 0);
    if (left) {
        goToBounce(left, bounceState(left).left, -share);
        touched.push(left);
    }
    if (right) {
        goToBounce(right, -share, bounceState(right).right);
        touched.push(right);
    }
    item._m3eTouched = touched;
}

// Release: back to 0 as soon as the bounce has reached 75 % of its amplitude (1 s at most), like Bounceable.
function releasePress(item) {
    const touched = item._m3eTouched;
    if (!touched)
        return;
    item._m3eTouched = null;
    const b = bounceState(item);
    const threshold = T.bounceMinRatio * BOUNCE_PX;
    let done = false;
    const back = () => {
        // The tile may have been unwired (disable()) while the return was pending.
        if (done || item._m3eBounce !== b)
            return;
        done = true;
        b.onValue = null;
        if (b.wait)
            GLib.source_remove(b.wait);
        b.wait = 0;
        if (b.idle)
            GLib.source_remove(b.idle);
        b.idle = 0;
        for (const t of touched)
            goToBounce(t, 0, 0);
    };
    const amplitude = () => Math.abs(b.left) + Math.abs(b.right);
    if (amplitude() >= threshold) {
        back();
        return;
    }
    b.onValue = () => {
        if (amplitude() >= threshold && !b.idle) {
            b.idle = GLib.idle_add(GLib.PRIORITY_HIGH, () => {
                b.idle = 0;
                back();
                return GLib.SOURCE_REMOVE;
            });
        }
    };
    b.wait = GLib.timeout_add(GLib.PRIORITY_DEFAULT, T.bounceMaxWaitMs, () => {
        b.wait = 0;
        back();
        return GLib.SOURCE_REMOVE;
    });
}

function restBounce(item) {
    const b = item._m3eBounce;
    if (!b)
        return;
    b.animation?.stop();
    if (b.wait)
        GLib.source_remove(b.wait);
    if (b.idle)
        GLib.source_remove(b.idle);
    b.onValue = null;
    item.set({scale_x: 1, translation_x: 0});
    for (const c of item.get_children())
        c.set({scale_x: 1, translation_x: 0});
    removeProperty(item, BOUNCE_LEFT);
    removeProperty(item, BOUNCE_RIGHT);
    delete item._m3eBounce;
    item._m3eTouched = null;
}

// --- wiring -----------------------------------------------------------------------------------------------------

function track(item) {
    if (tracked.has(item) || !isTile(item))
        return;
    const ids = [];
    const pressHandler = button => [button, button.connect('notify::pressed', () => {
        if (button.pressed)
            press(item);
        else
            releasePress(item);
    })];
    if (item instanceof QuickSettings.QuickMenuToggle) {
        const contents = item._box.get_first_child();
        ids.push(...wireMorph(contents._icon, contents), pressHandler(contents), pressHandler(item._menuButton));
    } else {
        ids.push(...wireMorph(item, item), pressHandler(item));
    }
    ids.push([item, item.connect('destroy', () => forget(item))]);
    tracked.set(item, ids);
}

function forget(item) {
    const ids = tracked.get(item);
    if (!ids)
        return;
    tracked.delete(item);
    for (const [object, id] of ids)
        object.disconnect(id);
    if (item instanceof QuickSettings.QuickMenuToggle)
        unwireMorph(item._box.get_first_child()._icon);
    else
        unwireMorph(item);
    restBounce(item);
}

export function enable() {
    grid = Main.panel.statusArea.quickSettings.menu._grid;
    for (const item of grid.get_children())
        track(item);
    addedId = grid.connect('child-added', (g, item) => track(item));
}

export function disable() {
    if (grid && addedId)
        grid.disconnect(addedId);
    addedId = 0;
    for (const item of [...tracked.keys()])
        forget(item);
    // Neighbours narrowed by a press (not tracked if they are not tiles: impossible, but the state stays clean).
    for (const item of grid?.get_children() ?? [])
        restBounce(item);
    grid = null;
}

// Test seam for the bench.
export function _diagnostic() {
    return {tracked: tracked.size, morphs: morphs.size};
}

// Test seams for the bench: press and release without real input (never uinput).
export const _press = press;
export const _release = releasePress;
