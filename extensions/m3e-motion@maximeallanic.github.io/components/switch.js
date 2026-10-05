// Switch (PopupMenu.Switch) like Android's MaterialSwitch with icons, with the motion of Material Components:
//   - 24 px handle in both states, an X when off and a check mark when on (16 px icon), 28 px while pressed;
//   - press and release: size change in 100 ms on the standard curve (0.2, 0, 0, 1);
//   - state change: the handle slides in 250 ms (SwitchCompat, AccelerateDecelerate) while its shape goes through the
//     32 x 22 "morphing" pill: off -> on 150 ms then 100 ms, on -> off 100 ms then 150 ms, emphasized path; the icon
//     changes at once (like on the phone).
// The handle size is set as an inline style (width, height, margin: the centre always at 16 px from the edge, as in
// the stylesheet): the Shell stylesheet of the theme still draws an off handle of 16 px without an icon.
// The icon colour is read from the switch's theme node: background of the off track (surface_container_highest) or
// the on content colour (on_primary_container), like GTK. The slide is a translation towards the final place (set
// at once); everything restarts from the displayed size and position.
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {animate, virtualProperty, removeProperty} from '../m3e/animate.js';
import {ANDROID} from '../m3e/tokens.js';
import {Replacements, animationsAllowed} from '../motion/utils.js';

export const NAME = 'switch';

const S = ANDROID.switch;
const HANDLE = S.thumbDp;
const PRESSED = S.thumbPressedDp;
const ICONS = {true: 'object-select-symbolic', false: 'window-close-symbolic'};
const VIRTUAL_WIDTH = 'm3e-thumb-width';
const VIRTUAL_HEIGHT = 'm3e-thumb-height';

const proto = PopupMenu.Switch.prototype;
const replacements = new Replacements();
let originalStateDescriptor = null;
const wired = new Set();

// --- handle size ------------------------------------------------------------------------------------------------

function applySize(sw) {
    const e = sw._m3e;
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const track = sw.height > 0 ? sw.height / scale : HANDLE + 8;
    const marginV = (track - e.h) / 2, marginH = (track - e.w) / 2;
    sw._handle.set_style(`width: ${e.w.toFixed(2)}px; height: ${e.h.toFixed(2)}px; ` +
        `margin: ${marginV.toFixed(2)}px ${marginH.toFixed(2)}px;`);
}

function updateIconColor(sw) {
    const e = sw._m3e;
    // Outside the stage there is no theme node: style-changed calls back on entering the stage.
    if (!sw.get_stage())
        return;
    const node = sw.get_theme_node();
    const c = sw._state ? node.get_foreground_color() : node.get_background_color();
    e.icon.set_style(`color: rgba(${c.red}, ${c.green}, ${c.blue}, ${(c.alpha / 255).toFixed(4)});`);
}

const motion = (curve, duration) => ({curve, duration});

// Size towards (w, h): one phase, or two chained (morphing shape then resting size).
function goToSize(sw, phases) {
    const e = sw._m3e;
    const [first, ...rest] = phases;
    if (!first)
        return;
    e.sizeAnimation = animate(sw._handle, {[e.widthPath]: first.w, [e.heightPath]: first.h}, {
        spring: motion(first.curve, first.duration),
        threshold: 0.25,
        onDone: () => goToSize(sw, rest),
    });
}

function restingSize(sw) {
    return sw._m3e.pressed ? PRESSED : HANDLE;
}

// --- press ------------------------------------------------------------------------------------------------------

function onPress(sw, pressed) {
    const e = sw._m3e;
    if (e.pressed === pressed)
        return;
    e.pressed = pressed;
    const size = restingSize(sw);
    if (!animationsAllowed() || !sw.mapped) {
        e.sizeAnimation?.stop();
        e.w = e.h = size;
        applySize(sw);
        return;
    }
    goToSize(sw, [{w: size, h: size, curve: S.pressCurve, duration: S.pressMs}]);
}

// Menu item carrying the switch: its :active state (pressed click gesture) is the press.
function followPress(sw) {
    const e = sw._m3e;
    if (e.carrier)
        return;
    let p = sw.get_parent();
    while (p && !(p instanceof PopupMenu.PopupBaseMenuItem))
        p = p.get_parent();
    e.carrier = p ?? sw;
    e.pressId = e.carrier.connect('notify::pseudo-class',
        () => onPress(sw, e.carrier.has_style_pseudo_class('active')));
}

// --- wiring of one switch ---------------------------------------------------------------------------------------

function wire(sw) {
    if (sw._m3e)
        return;
    const handle = sw._handle;
    const e = {w: HANDLE, h: HANDLE, pressed: false, carrier: null, pressId: 0, sizeAnimation: null,
        slideAnimation: null, allocationId: 0, originalLayout: handle.layout_manager};
    sw._m3e = e;
    e.icon = new St.Icon({icon_name: ICONS[sw._state], icon_size: S.iconDp,
        x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, x_expand: true, y_expand: true});
    handle.layout_manager = new Clutter.BinLayout();
    handle.add_child(e.icon);
    e.widthPath = virtualProperty(handle, VIRTUAL_WIDTH, {read: () => e.w, write: v => {
        e.w = v;
        applySize(sw);
    }});
    e.heightPath = virtualProperty(handle, VIRTUAL_HEIGHT, {read: () => e.h, write: v => {
        e.h = v;
        applySize(sw);
    }});
    applySize(sw);
    updateIconColor(sw);
    e.ids = [
        sw.connect('style-changed', () => updateIconColor(sw)),
        sw.connect('notify::height', () => applySize(sw)),
        sw.connect('notify::mapped', () => sw.mapped && followPress(sw)),
        sw.connect('destroy', () => wired.delete(sw)),
    ];
    if (sw.mapped)
        followPress(sw);
    wired.add(sw);
}

function unwire(sw) {
    const e = sw._m3e;
    if (!e)
        return;
    e.sizeAnimation?.stop();
    e.slideAnimation?.stop();
    const handle = sw._handle;
    if (e.allocationId)
        handle.disconnect(e.allocationId);
    for (const id of e.ids)
        sw.disconnect(id);
    if (e.pressId)
        e.carrier.disconnect(e.pressId);
    e.icon.destroy();
    handle.layout_manager = e.originalLayout;
    removeProperty(handle, VIRTUAL_WIDTH);
    removeProperty(handle, VIRTUAL_HEIGHT);
    handle.set_style(null);
    handle.translation_x = 0;
    delete sw._m3e;
}

// Displayed centre of the handle in the switch's coordinates.
function displayedCenter(handle) {
    const b = handle.get_allocation_box();
    return b.x1 + b.get_width() / 2 + handle.translation_x;
}

function setState(state) {
    wire(this);
    const e = this._m3e;
    const handle = this._handle;
    const changed = this._state !== state;
    const animated = changed && handle.mapped && handle.has_allocation() && animationsAllowed();
    const before = animated ? displayedCenter(handle) : 0;

    if (state)
        this.add_style_pseudo_class('checked');
    else
        this.remove_style_pseudo_class('checked');
    // Final place at once (the Shell animated it over 100 ms): the slide only concerns the display.
    handle.remove_transition('@constraints.align.factor');
    this._handleAlignConstraint.set_factor(state ? 1.0 : 0.0);
    e.icon.icon_name = ICONS[state];

    if (changed) {
        this._state = state;
        updateIconColor(this);
        this.notify('state');
    }
    if (!animated) {
        e.sizeAnimation?.stop();
        e.slideAnimation?.stop();
        if (e.allocationId)
            handle.disconnect(e.allocationId);
        e.allocationId = 0;
        e.w = e.h = restingSize(this);
        applySize(this);
        handle.translation_x = 0;
        return;
    }
    // Slide: once the handle is allocated at its final place it is brought visually back to its previous displayed
    // centre (the centre does not depend on the size: margin = (track - size) / 2), then the translation goes to 0.
    e.slideAnimation?.stop();
    if (e.allocationId)
        handle.disconnect(e.allocationId);
    e.allocationId = handle.connect('notify::allocation', () => {
        handle.disconnect(e.allocationId);
        e.allocationId = 0;
        handle.translation_x = 0;
        handle.translation_x = before - displayedCenter(handle);
        e.slideAnimation = animate(handle, {translation_x: 0}, {spring: motion(S.slideCurve, S.slideMs)});
    });
    const size = restingSize(this);
    const morph = {w: S.morphWidthDp, h: S.morphHeightDp, curve: S.morphCurve};
    const [d1, d2] = state ? [S.morphLongMs, S.morphShortMs] : [S.morphShortMs, S.morphLongMs];
    goToSize(this, [{...morph, duration: d1}, {w: size, h: size, curve: S.morphCurve, duration: d2}]);
}

function findSwitches(actor, result) {
    if (actor instanceof PopupMenu.Switch)
        result.push(actor);
    for (const child of actor.get_children())
        findSwitches(child, result);
    return result;
}

export function enable() {
    originalStateDescriptor = Object.getOwnPropertyDescriptor(proto, 'state');
    if (!originalStateDescriptor)
        throw new Error('PopupMenu.Switch.prototype has no own "state" accessor: Shell internals changed');
    Object.defineProperty(proto, 'state', {
        configurable: true,
        enumerable: originalStateDescriptor.enumerable,
        get: originalStateDescriptor.get,
        set: setState,
    });
    replacements.replace(proto, '_init', original => function (...args) {
        original.apply(this, args);
        wire(this);
    });
    for (const sw of findSwitches(Main.layoutManager.uiGroup, []))
        wire(sw);
}

export function disable() {
    if (originalStateDescriptor)
        Object.defineProperty(proto, 'state', originalStateDescriptor);
    originalStateDescriptor = null;
    replacements.restore();
    for (const sw of [...wired])
        unwire(sw);
    wired.clear();
}

// Test seam for the bench: press the switch without real input (never uinput).
export function _press(sw, pressed) {
    wire(sw);
    onPress(sw, pressed);
}
