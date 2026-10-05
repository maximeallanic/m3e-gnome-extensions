// Dash to Dock on M3E springs. No Dash to Dock file is modified: its prototypes are found at run time on an existing
// dock, wrapped, and restored as they were by disable().
//
// Slide (show / hide): DockedDash._animateIn/_animateOut call
// this._slider.ease_property('slide-x', 0|1, {duration, delay, mode, onComplete}). ease_property and
// remove_all_transitions are wrapped on the DashSlideContainer prototype; for 'slide-x' a spring of the toolkit
// drives the "position" (px) of the m3e-dock driver effect (0 = hidden, H = shown):
//   show: DefaultSpatial (the overshoot becomes a translation towards the inside, slide-x staying in [0, 1]);
//   hide: FastEffects, no overshoot (Compose's drawer closing, NavigationDrawer.kt: closeMotion).
// Interruption: _removeAnimations() (remove_all_transitions) followed by a new _animateIn/_animateOut in the same
// iteration: the spring restarts from the current position AND velocity. Without a new ease in the iteration it is
// stopped in place (like a removed transition). onComplete is only called when a segment really ends, never for a
// segment taken over or removed (like ease()); zero duration or animations off: value set and onComplete called at
// once (like ease_property).
//
// Tooltips (DockDashItemContainer): Compose's Plain tooltip (Tooltip.kt): scale 0.8 <-> 1 (FastSpatial) and opacity
// (FastEffects), pivot at the centre, on show and hide. The original showLabel is kept for the placement. Only the
// dock's own prototype is touched; the Shell Dash's (Dash.DashItemContainer) is handled by m3e-motion.
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Dash from 'resource:///org/gnome/shell/ui/dash.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

import {animate} from './m3e/animate.js';
import {DriverEffect} from './driver-effect.js';
import {dockSlide, dockPosition, overshootTranslation} from './math.js';

export const NAME = 'dock';
export const DTD = 'dash-to-dock@micxgx.gmail.com';
export const EFFECT_NAME = 'm3e-dock';
export const PROP = `@effects.${EFFECT_NAME}.position`;
const SPRING_SHOW = 'DefaultSpatial';
const SPRING_HIDE = 'FastEffects';
const TOOLTIP_SPRINGS = {opacity: 'FastEffects', scale_x: 'FastSpatial', scale_y: 'FastSpatial'};
const TOOLTIP_SCALE = 0.8;

let active = false;
let generation = 0;
let extensionStateId = 0;
let manager = null;
let readyId = 0;
const patches = [];          // [{object, name, had, value}]
const sliders = new Map();   // DashSlideContainer already driven -> 'destroy' handler id
const idleIds = new Set();   // pending idle sources (removed by disable)

// --- helpers --------------------------------------------------------------------------------------------------

function patch(object, name, value) {
    patches.push({object, name, had: Object.prototype.hasOwnProperty.call(object, name), value: object[name]});
    object[name] = value;
}

function restoreAll() {
    for (const {object, name, had, value} of patches.reverse()) {
        if (had)
            object[name] = value;
        else
            delete object[name];
    }
    patches.length = 0;
}

const SIDES = {[St.Side.TOP]: 'top', [St.Side.BOTTOM]: 'bottom', [St.Side.LEFT]: 'left', [St.Side.RIGHT]: 'right'};

// Slide distance (logical px): natural size of the content along the axis, minus the always-visible part.
function distance(slider) {
    const child = slider.get_child?.() ?? slider.child;
    if (!child)
        return 1;
    const vertical = slider.side === St.Side.TOP || slider.side === St.Side.BOTTOM;
    const [, natural] = vertical ? child.get_preferred_height(-1) : child.get_preferred_width(-1);
    return Math.max(1, natural - (slider._slideoutSize ?? 0));
}

function read(slider) {
    return dockPosition(slider.slide_x, slider._m3eOvershoot ?? 0, distance(slider));
}

function write(slider, position) {
    const {slide, overshoot} = dockSlide(position, distance(slider));
    const t = overshootTranslation(SIDES[slider.side], overshoot);
    slider._m3eOvershoot = overshoot;
    slider.slide_x = slide;
    slider.translation_x = t.x;
    slider.translation_y = t.y;
}

function driverEffect(slider) {
    let effect = slider.get_effect(EFFECT_NAME);
    if (!effect) {
        effect = new DriverEffect(() => read(slider), v => write(slider, v));
        slider.add_effect_with_name(EFFECT_NAME, effect);
        sliders.set(slider, slider.connect('destroy', () => sliders.delete(slider)));
    }
    return effect;
}

// --- slide ----------------------------------------------------------------------------------------------------

// Running segment: {target, onComplete, onStopped}. Toolkit animation: slider._m3eAnim.
function finish(slider, segment, completed) {
    if (slider._m3eSegment === segment)
        slider._m3eSegment = null;
    try {
        segment.onStopped?.(completed);
        if (completed)
            segment.onComplete?.();
    } catch (e) {
        console.error(`m3e-extensions: Dash to Dock callback failed: ${e.message}\n${e.stack}`);
    }
}

function slide(slider, target, params = {}) {
    const {duration = 0, delay = 0, onComplete = null, onStopped = null} = params;
    const effect = driverEffect(slider);
    // Previous segment replaced: like a removed transition, onStopped(false), never onComplete.
    const previous = slider._m3eSegment;
    if (previous)
        finish(slider, previous, false);
    const segment = {target, onComplete, onStopped};
    slider._m3eSegment = segment;
    const h = distance(slider);
    if (!duration || !St.Settings.get().enable_animations || !slider.mapped) {
        slider._m3eAnim?.stop();
        slider._m3eAnim = null;
        effect.position = target * h;
        finish(slider, segment, true);
        return Promise.resolve();
    }
    slider._m3eAnim = animate(slider, {[PROP]: target * h}, {
        spring: target >= 1 ? SPRING_SHOW : SPRING_HIDE,
        delay,
        onDone: () => {
            if (slider._m3eSegment !== segment)
                return;
            slider._m3eAnim = null;
            finish(slider, segment, true);
        },
    });
    return Promise.resolve();
}

// remove_all_transitions: the segment is removed (onStopped(false)); the spring keeps going until the end of the
// iteration, so that an immediate ease_property takes it over with its velocity; otherwise it stops in place.
function suspend(slider) {
    const segment = slider._m3eSegment;
    if (!segment)
        return;
    finish(slider, segment, false);
    const anim = slider._m3eAnim;
    if (!anim)
        return;
    const id = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        idleIds.delete(id);
        if (slider._m3eAnim === anim && !slider._m3eSegment) {
            anim.stop();
            slider._m3eAnim = null;
        }
        return GLib.SOURCE_REMOVE;
    });
    idleIds.add(id);
}

function patchSlide(proto) {
    if (proto._m3eSlide)
        return;
    const easeProperty = proto.ease_property;
    const removeAll = proto.remove_all_transitions;
    patch(proto, '_m3eSlide', true);
    patch(proto, 'ease_property', function (prop, target, params) {
        if (prop !== 'slide-x' && prop !== 'slide_x')
            return easeProperty.call(this, prop, target, params);
        return slide(this, target, params);
    });
    patch(proto, 'remove_all_transitions', function () {
        suspend(this);
        return removeAll.call(this);
    });
}

// --- tooltips -------------------------------------------------------------------------------------------------

function showTooltip(label, before) {
    label.remove_transition('opacity'); // original fade (ease 150 ms)
    label.set_pivot_point(0.5, 0.5);
    if (before.visible) {
        // Tooltip already there or on its way out: restart from where it is (scale intact, opacity restored).
        label.opacity = before.opacity;
    } else {
        label.opacity = 0;
        label.set_scale(TOOLTIP_SCALE, TOOLTIP_SCALE);
    }
    animate(label, {opacity: 255, scale_x: 1, scale_y: 1}, {spring: TOOLTIP_SPRINGS});
}

function hideTooltip(label) {
    label.remove_transition('opacity');
    label.set_pivot_point(0.5, 0.5);
    animate(label, {opacity: 0, scale_x: TOOLTIP_SCALE, scale_y: TOOLTIP_SCALE}, {
        spring: TOOLTIP_SPRINGS,
        onDone: () => label.hide(),
    });
}

function patchTooltips(proto) {
    if (proto._m3eTooltips || proto === Dash.DashItemContainer.prototype)
        return;
    const showLabel = proto.showLabel;
    patch(proto, '_m3eTooltips', true);
    patch(proto, 'showLabel', function (...args) {
        const label = this.label;
        const before = {visible: Boolean(label?.visible), opacity: label?.opacity ?? 0};
        const result = showLabel.apply(this, args);
        // The original showLabel returns early without text or stage: nothing to animate.
        if (label?.visible && label.get_stage())
            showTooltip(label, before);
        return result;
    });
    patch(proto, 'hideLabel', function () {
        if (this.label)
            hideTooltip(this.label);
    });
}

// Item container of the dock: instance whose direct prototype defines showLabel (DockDashItemContainer).
function findItem(actor) {
    if (!actor)
        return null;
    const proto = Object.getPrototypeOf(actor);
    if (Object.prototype.hasOwnProperty.call(proto, 'showLabel') && 'label' in actor)
        return actor;
    for (const child of actor.get_children?.() ?? []) {
        const found = findItem(child);
        if (found)
            return found;
    }
    return null;
}

// --- wiring ---------------------------------------------------------------------------------------------------

function patchDocks() {
    // `allDocks` is a STATIC accessor of DockManager (docking.js); the instance only has `_allDocks`.
    const docks = manager?._allDocks ?? [];
    for (const dock of docks) {
        if (dock._slider)
            patchSlide(Object.getPrototypeOf(dock._slider));
        const item = findItem(dock.dash);
        if (item)
            patchTooltips(Object.getPrototypeOf(item));
    }
}

async function connect() {
    const ext = Main.extensionManager.lookup(DTD);
    if (!active || !ext || ext.state !== ExtensionState.ACTIVE)
        return;
    const g = generation;
    let module;
    try {
        // Same URL as the one Dash to Dock loaded: same module, same classes.
        module = await import(ext.dir.get_child('docking.js').get_uri());
    } catch (e) {
        console.warn(`m3e-extensions: Dash to Dock docking.js unreadable (${e.message}); dock not animated`);
        return;
    }
    if (!active || g !== generation)
        return;
    const m = module.DockManager?.getDefault?.();
    if (!m)
        return;
    if (m !== manager) {
        if (manager && readyId)
            manager.disconnect(readyId);
        manager = m;
        readyId = m.connect('docks-ready', () => patchDocks());
    }
    patchDocks();
}

function connectLogged() {
    connect().catch(e => console.error(`m3e-extensions: dock wiring failed: ${e.message}\n${e.stack}`));
}

export function enable() {
    active = true;
    generation++;
    extensionStateId = Main.extensionManager.connect('extension-state-changed', (_m, ext) => {
        if (ext?.uuid === DTD)
            connectLogged();
    });
    connectLogged();
}

// For the bench.
export function state() {
    return {manager: Boolean(manager), patches: patches.map(p => p.name), sliders: sliders.size};
}

export function disable() {
    active = false;
    generation++;
    if (extensionStateId)
        Main.extensionManager.disconnect(extensionStateId);
    extensionStateId = 0;
    if (manager && readyId)
        manager.disconnect(readyId);
    manager = null;
    readyId = 0;
    for (const id of idleIds)
        GLib.source_remove(id);
    idleIds.clear();
    restoreAll();
    // Springs already stopped by stopAll(): each dock is set to the target of its segment, and Dash to Dock gets the
    // expected onComplete (otherwise it would stay in SHOWING/HIDING).
    for (const [slider, destroyId] of [...sliders]) {
        slider.disconnect(destroyId);
        const segment = slider._m3eSegment;
        slider._m3eAnim = null;
        slider.remove_effect_by_name(EFFECT_NAME);
        slider.translation_x = 0;
        slider.translation_y = 0;
        slider._m3eOvershoot = 0;
        if (segment) {
            slider.slide_x = segment.target;
            finish(slider, segment, true);
        }
    }
    sliders.clear();
    // Tooltips: put back at scale 1 and hidden (a tooltip frozen half-way would stay).
    for (const label of Main.layoutManager.uiGroup.get_children().filter(a => a.has_style_class_name?.('dash-label'))) {
        label.set_scale(1, 1);
        label.hide();
    }
}
