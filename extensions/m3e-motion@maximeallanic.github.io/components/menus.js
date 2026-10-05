// Menu opening in M3E. The Shell opens menus on fixed curves (EASE_OUT_QUAD / EASE_OUT_EXPO, 150 to 250 ms):
//   - menus (BoxPointer: top bar, quick settings, context menus): Compose's DropdownMenu, scale from 0.8 to 1 from
//     the anchor point (ClosedScaleTarget / ExpandedScaleTarget) and fade-in on opening; fade only on closing (the
//     scale only comes back once invisible). Here on springs: FastSpatial scale, FastEffects opacity;
//   - quick settings tile menus (QuickToggleMenu) and submenus (PopupSubMenu): the container unfolds (height,
//     DefaultSpatial) while the content appears (DefaultEffects); folding without bounce (DefaultEffects: a height
//     must not go below 0); submenu arrow on FastSpatial;
//   - quick settings and calendar: the Android shade (panel-shade.js): the panel appears, its content comes down on
//     the measured spring, closing is symmetric.
// Everything is interruptible: reopening during a closing restarts from the displayed size and velocity.
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {animate} from '../m3e/animate.js';
import {Replacements, animationsAllowed} from '../motion/utils.js';
import {isShade, restAll, shadeOf} from './panel-shade.js';

export const NAME = 'menus';

const {PopupAnimation} = BoxPointer;
const CLOSED_SCALE = 0.8; // Compose Menu.kt: ClosedScaleTarget
const CONTENT_DELAY_MS = 50; // M3E-visual: the content follows the unfolding (fade started a little after the height)

const replacements = new Replacements();

// Animations of this module running on an actor (stopped before a new start, or on disable()).
const running = new Map(); // actor -> {animations: Set, destroyId}

function track(actor, ...animations) {
    let entry = running.get(actor);
    if (!entry) {
        entry = {animations: new Set(), destroyId: 0};
        entry.destroyId = actor.connect('destroy', () => running.delete(actor));
        running.set(actor, entry);
    }
    for (const a of animations)
        entry.animations.add(a);
}

function stopTracked(actor) {
    const entry = running.get(actor);
    if (!entry)
        return;
    for (const a of entry.animations)
        a.stop();
    entry.animations.clear();
}

// --- BoxPointer -------------------------------------------------------------------------------------------------

function pivot(box) {
    const w = box.width, h = box.height;
    const o = box._arrowOrigin;
    const unit = (v, size) => (size > 0 && o ? Math.min(1, Math.max(0, v / size)) : 0.5);
    switch (box._arrowSide) {
    case St.Side.TOP:
        return [unit(o, w), 0];
    case St.Side.BOTTOM:
        return [unit(o, w), 1];
    case St.Side.LEFT:
        return [0, unit(o, h)];
    case St.Side.RIGHT:
        return [1, unit(o, h)];
    }
    return [0.5, 0.5];
}

// --- quick settings and calendar: the shade (panel-shade.js) ----------------------------------------------------

function openShade(box, onComplete) {
    box.remove_all_transitions();
    stopTracked(box);
    box._muteKeys = false;
    box.show();
    box.set({translation_x: 0, translation_y: 0, scale_x: 1, scale_y: 1});
    shadeOf(box).open(() => {
        box._muteInput = false;
        onComplete?.();
    });
}

function closeShade(box, onComplete) {
    box._muteInput = true;
    box._muteKeys = true;
    box.remove_all_transitions();
    stopTracked(box);
    const shade = shadeOf(box);
    shade.close(() => {
        box.hide();
        shade.rest();
        box.opacity = 0;
        onComplete?.();
    });
}

function openBox(original) {
    return function (flags, onComplete) {
        if (flags & PopupAnimation.FULL && animationsAllowed() && isShade(this)) {
            openShade(this, onComplete);
            return;
        }
        if (!(flags & PopupAnimation.FULL) || !animationsAllowed()) {
            this._m3eShade?.halt();
            this._m3eShade?.rest();
            stopTracked(this);
            this.set({scale_x: 1, scale_y: 1});
            original.call(this, flags, onComplete);
            return;
        }
        this.remove_all_transitions();
        stopTracked(this);
        this._muteKeys = false;
        // An interrupted closing restarts from the displayed opacity; otherwise start invisible and reduced.
        const takeOver = this.visible && this.opacity > 0;
        this.show();
        if (!takeOver) {
            this.opacity = flags & PopupAnimation.FADE ? 0 : 255;
            if (flags & PopupAnimation.SLIDE) {
                this.set_pivot_point(...pivot(this));
                this.set({scale_x: CLOSED_SCALE, scale_y: CLOSED_SCALE});
            }
        }
        this.set({translation_x: 0, translation_y: 0});
        const scale = animate(this, {scale_x: 1, scale_y: 1}, {spring: 'FastSpatial'});
        const fade = animate(this, {opacity: 255}, {
            spring: 'FastEffects',
            onDone: () => {
                this._muteInput = false;
                onComplete?.();
            },
        });
        track(this, scale, fade);
    };
}

function closeBox(original) {
    return function (flags, onComplete) {
        if (!this.visible)
            return;
        if (flags & PopupAnimation.FADE && animationsAllowed() && isShade(this)) {
            closeShade(this, onComplete);
            return;
        }
        if (!(flags & PopupAnimation.FADE) || !animationsAllowed()) {
            this._m3eShade?.halt();
            this._m3eShade?.rest();
            stopTracked(this);
            this.set({scale_x: 1, scale_y: 1});
            original.call(this, flags, onComplete);
            return;
        }
        this._muteInput = true;
        this._muteKeys = true;
        this.remove_all_transitions();
        // The scale of a running opening continues; only the opacity changes target.
        const fade = animate(this, {opacity: 0}, {
            spring: 'FastEffects',
            onDone: () => {
                stopTracked(this);
                this.hide();
                this.set({opacity: 0, translation_x: 0, translation_y: 0, scale_x: 1, scale_y: 1});
                onComplete?.();
            },
        });
        track(this, fade);
    };
}

// --- tile menus (QuickToggleMenu) -------------------------------------------------------------------------------

function naturalHeight(actor) {
    const before = actor.height;
    actor.height = -1;
    const [height] = actor.get_preferred_height(-1);
    actor.height = before;
    return height;
}

function openTile(original) {
    return function (flags) {
        if (this.isOpen)
            return;
        if (flags === PopupAnimation.NONE || !animationsAllowed()) {
            stopTracked(this.actor);
            stopTracked(this.box);
            original.call(this, flags);
            return;
        }
        // Folded menu (not an interrupted closing): the content starts invisible.
        if (!this.actor.visible || this.actor.height === 0)
            this.box.opacity = 0;
        this.actor.show();
        this.isOpen = true;
        this.actor.remove_all_transitions();
        this.box.remove_all_transitions();
        const target = naturalHeight(this.actor);
        // Content clipped to the unfolded height while it changes (it appears during the unfolding).
        this.actor.clip_to_allocation = true;
        const height = animate(this.actor, {height: target}, {
            spring: 'DefaultSpatial',
            onDone: () => {
                this.actor.height = -1;
                this.actor.clip_to_allocation = false;
            },
        });
        const fade = animate(this.box, {opacity: 255}, {spring: 'DefaultEffects', delay: CONTENT_DELAY_MS});
        track(this.actor, height);
        track(this.box, fade);
        this.emit('open-state-changed', true);
    };
}

function closeTile(original) {
    return function (flags) {
        if (!this.isOpen)
            return;
        if (flags === PopupAnimation.NONE || !animationsAllowed()) {
            stopTracked(this.actor);
            stopTracked(this.box);
            original.call(this, flags);
            return;
        }
        this.actor.remove_all_transitions();
        this.box.remove_all_transitions();
        // Start from the displayed height (fixed if the menu was at rest at its natural size).
        this.actor.set_height(this.actor.get_height());
        this.actor.clip_to_allocation = true;
        const fade = animate(this.box, {opacity: 0}, {spring: 'FastEffects'});
        const height = animate(this.actor, {height: 0}, {
            spring: 'DefaultEffects',
            onDone: () => {
                this.actor.hide();
                this.actor.clip_to_allocation = false;
                this.emit('menu-closed');
            },
        });
        track(this.actor, height);
        track(this.box, fade);
        this.isOpen = false;
        this.emit('open-state-changed', false);
    };
}

// --- submenus (PopupSubMenu) ------------------------------------------------------------------------------------

function openSubMenu(original) {
    return function (flags) {
        if (this.isOpen || this.isEmpty())
            return;
        if (!flags || !animationsAllowed() || this._needsScrollbar()) {
            stopTracked(this.actor);
            stopTracked(this._arrow);
            original.call(this, flags);
            return;
        }
        this.isOpen = true;
        this.emit('open-state-changed', true);
        const unfolded = this.actor.visible;
        this.actor.show();
        this.actor.vscrollbar_policy = St.PolicyType.NEVER;
        this.actor.remove_style_pseudo_class('scrolled');
        this.actor.remove_all_transitions();
        this._arrow.remove_all_transitions();
        const target = naturalHeight(this.actor);
        if (!unfolded)
            this.actor.height = 0;
        const angle = this.actor.text_direction === Clutter.TextDirection.RTL ? -90 : 90;
        const height = animate(this.actor, {height: target}, {
            spring: 'DefaultSpatial',
            onDone: () => this.actor.set_height(-1),
        });
        track(this.actor, height);
        track(this._arrow, animate(this._arrow, {rotation_angle_z: angle}, {spring: 'FastSpatial'}));
    };
}

function closeSubMenu(original) {
    return function (flags) {
        if (!this.isOpen)
            return;
        if (!flags || !animationsAllowed() || this._needsScrollbar()) {
            stopTracked(this.actor);
            stopTracked(this._arrow);
            original.call(this, flags);
            return;
        }
        this.isOpen = false;
        this.emit('open-state-changed', false);
        if (this._activeMenuItem)
            this._activeMenuItem.active = false;
        this.actor.remove_all_transitions();
        this._arrow.remove_all_transitions();
        this.actor.set_height(this.actor.get_height());
        const height = animate(this.actor, {height: 0}, {
            spring: 'DefaultEffects',
            onDone: () => {
                this.actor.hide();
                this.actor.set_height(-1);
            },
        });
        track(this.actor, height);
        track(this._arrow, animate(this._arrow, {rotation_angle_z: 0}, {spring: 'FastSpatial'}));
    };
}

// QuickToggleMenu is not exported: its prototype is taken from the menu of a temporary tile with a menu.
function tileMenuPrototype() {
    const tile = new QuickSettings.QuickMenuToggle();
    const proto = Object.getPrototypeOf(tile.menu);
    tile.destroy();
    return proto;
}

export function enable() {
    const box = BoxPointer.BoxPointer.prototype;
    replacements.replace(box, 'open', openBox);
    replacements.replace(box, 'close', closeBox);
    const tile = tileMenuPrototype();
    replacements.replace(tile, 'open', openTile);
    replacements.replace(tile, 'close', closeTile);
    const sub = PopupMenu.PopupSubMenu.prototype;
    replacements.replace(sub, 'open', openSubMenu);
    replacements.replace(sub, 'close', closeSubMenu);
}

export function disable() {
    replacements.restore();
    // Actors left mid-way by stopAll(): put back at their resting state.
    for (const [actor, {animations, destroyId}] of running) {
        for (const a of animations)
            a.stop();
        actor.disconnect(destroyId);
        if (actor instanceof BoxPointer.BoxPointer) {
            actor.set({scale_x: 1, scale_y: 1, translation_x: 0, translation_y: 0,
                opacity: actor.visible ? 255 : 0});
        } else {
            if (actor.height !== -1 && actor.visible)
                actor.set_height(-1);
            if (actor instanceof St.Widget && !(actor instanceof St.ScrollView))
                actor.clip_to_allocation = false;
        }
    }
    running.clear();
    restAll();
}
