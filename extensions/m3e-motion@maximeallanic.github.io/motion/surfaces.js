// Shell surfaces in M3E. Each replacement keeps the contract of the original method (states, signals, callbacks,
// destruction) and falls back to it when animations are off.
//   Alt+Tab and similar : fade in of the list; fade out, then destruction;
//   workspace switcher  : opacity (DefaultEffects / FastEffects);
//   tile preview        : bounds on DefaultSpatial, opacity on DefaultEffects;
//   folders             : container transform folder icon <-> box, scrim on DefaultEffects;
//   window previews     : hover on FastSpatial (scale) and FastEffects (title, button);
//   dash tooltips       : scale 0.8 -> 1 (FastSpatial) from the bottom center and fade (FastEffects), like the
//                         tooltips m3e-extensions gives Dash to Dock; fade out on disappearance.
// OSD, modal dialogs and banners (Android motions): system.js.
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as Dash from 'resource:///org/gnome/shell/ui/dash.js';
import * as SwitcherPopup from 'resource:///org/gnome/shell/ui/switcherPopup.js';
import * as WindowManager from 'resource:///org/gnome/shell/ui/windowManager.js';
import * as WindowPreview from 'resource:///org/gnome/shell/ui/windowPreview.js';
import * as WorkspaceSwitcherPopup from 'resource:///org/gnome/shell/ui/workspaceSwitcherPopup.js';

import {animate} from '../m3e/animate.js';
import {containerTransform, fade} from '../m3e/patterns.js';
import {animationsAllowed, bounds, radiusOf} from './utils.js';
import {Tracker, restDisplayed} from './surfaces-common.js';

export const NAME = 'surfaces';

const tracker = new Tracker(NAME);

// --- switchers (Alt+Tab, Super+Tab, Ctrl+Alt+Tab...) -------------------------------------------------------------

function wireSwitchers() {
    const proto = SwitcherPopup.SwitcherPopup.prototype;
    tracker.replacements.replace(proto, '_showImmediately', original => function () {
        if (!animationsAllowed())
            return original.call(this);
        if (this._initialDelayTimeoutId === 0)
            return undefined;
        GLib.source_remove(this._initialDelayTimeoutId);
        this._initialDelayTimeoutId = 0;
        Main.osdWindowManager.hideAll();
        this._switcherList.opacity = 0;
        this.opacity = 255;
        fade(this._switcherList, true, {pivot: {x: 0.5, y: 0.5}});
        return undefined;
    });
    tracker.replacements.replace(proto, 'fadeAndDestroy', original => function () {
        if (!animationsAllowed())
            return original.call(this);
        this._popModal();
        if (this.opacity > 0 && this._switcherList.opacity > 0)
            fade(this._switcherList, false, {onDone: tracker.followEnd(this._switcherList, () => this.destroy())});
        else
            this.destroy();
        return undefined;
    });

    const workspaceProto = WorkspaceSwitcherPopup.WorkspaceSwitcherPopup.prototype;
    tracker.replacements.replace(workspaceProto, 'display', original => function (index) {
        if (!animationsAllowed())
            return original.call(this, index);
        // The Shell's own method arms the hide timeout, redisplays and starts its ease from opacity 0; its ease is
        // replaced by ours, starting from the opacity that was displayed (no flash when already visible).
        const shownOpacity = this.visible ? this.opacity : 0;
        original.call(this, index);
        this.remove_transition('opacity');
        this.opacity = shownOpacity;
        tracker.forgetEnd(this);
        animate(this, {opacity: 255}, {spring: 'DefaultEffects'});
        return undefined;
    });
    tracker.replacements.replace(workspaceProto, '_onTimeout', original => function () {
        if (!animationsAllowed())
            return original.call(this);
        this._timeoutId = 0;
        animate(this, {opacity: 0}, {spring: 'FastEffects', onDone: tracker.followEnd(this, () => this.destroy())});
        return undefined;
    });
}

// --- tile preview ------------------------------------------------------------------------------------------------

function wireTilePreview() {
    const proto = WindowManager.TilePreview.prototype;
    tracker.replacements.replace(proto, 'open', original => function (window, tileRect, monitorIndex) {
        if (!animationsAllowed())
            return original.call(this, window, tileRect, monitorIndex);
        const windowActor = window.get_compositor_private();
        if (!windowActor)
            return undefined;
        global.window_group.set_child_below_sibling(this, windowActor);
        if (this._rect && this._rect.equal(tileRect))
            return undefined;
        const changeMonitor = this._monitorIndex === -1 || this._monitorIndex !== monitorIndex;
        this._monitorIndex = monitorIndex;
        this._rect = tileRect;
        const monitor = Main.layoutManager.monitors[monitorIndex];
        this._updateStyle(monitor);
        if (!this._showing || changeMonitor) {
            // The container starts from the window frame (same start as the Shell).
            const f = window.get_frame_rect();
            const x = Math.max(f.x, monitor.x), y = Math.max(f.y, monitor.y);
            const w = Math.min(f.x + f.width, monitor.x + monitor.width) - x;
            const h = Math.min(f.y + f.height, monitor.y + monitor.height) - y;
            this.set_size(Math.max(0, w), Math.max(0, h));
            this.set_position(x, y);
            this.opacity = 0;
        }
        this._showing = true;
        this.show();
        tracker.touch(this, () => {});
        animate(this, {x: tileRect.x, y: tileRect.y, width: tileRect.width, height: tileRect.height},
            {spring: 'DefaultSpatial'});
        tracker.forgetEnd(this);
        animate(this, {opacity: 255}, {spring: 'DefaultEffects'});
        return undefined;
    });
    tracker.replacements.replace(proto, 'close', original => function () {
        if (!animationsAllowed())
            return original.call(this);
        if (!this._showing)
            return undefined;
        this._showing = false;
        animate(this, {opacity: 0}, {spring: 'FastEffects', onDone: tracker.followEnd(this, () => this._reset())});
        return undefined;
    });
}

// --- app folders -------------------------------------------------------------------------------------------------

const FOLDER_SHADE = new Cogl.Color({red: 0, green: 0, blue: 0, alpha: 204}); // appDisplay.js: DIALOG_SHADE_NORMAL
const NO_SHADE = new Cogl.Color({red: 0, green: 0, blue: 0, alpha: 0});

function wireFolders() {
    const proto = AppDisplay.AppFolderDialog.prototype;
    tracker.replacements.replace(proto, '_zoomAndFadeIn', original => function () {
        if (!animationsAllowed())
            return original.call(this);
        this._needsZoomAndFade = false;
        const source = this._source;
        // Icon hidden at once (MDC: the start view disappears at the start of the container transform); the Shell
        // faded it over 100 ms.
        source.remove_transition('opacity');
        source.opacity = 0;
        animate(this, {background_color: FOLDER_SHADE}, {spring: 'DefaultEffects'});
        const opened = () => {};
        tracker.forgetEnd(this.child);
        const m = this._m3ePattern;
        if (m && m.running) {
            m.target('end', {onDone: opened});
        } else {
            m?.stop();
            restDisplayed(this.child);
            this._m3ePattern = containerTransform(bounds(source), this.child, {
                sourceRadius: radiusOf(source), destinationRadius: radiusOf(this.child), onDone: opened,
            });
        }
        tracker.touch(this.child, restDisplayed);
        if (this._sourceMappedId === 0)
            this._sourceMappedId = source.connect('notify::mapped', this._zoomAndFadeOut.bind(this));
        return undefined;
    });
    tracker.replacements.replace(proto, '_zoomAndFadeOut', original => function () {
        if (!animationsAllowed() || !this._m3ePattern)
            return original.call(this);
        if (!this._isOpen)
            return undefined;
        if (!this._source.mapped) {
            this._m3ePattern.stop();
            this._m3ePattern = null;
            restDisplayed(this.child);
            this.hide();
            return undefined;
        }
        animate(this, {background_color: NO_SHADE}, {spring: 'DefaultEffects'});
        this._m3eReturning = true;
        this._m3ePattern.target('start', {
            onDone: tracker.followEnd(this.child, () => {
                this._m3eReturning = false;
                this._m3ePattern = null;
                restDisplayed(this.child);
                this.hide();
                // MDC: the start view reappears at the end of the return.
                this._source.remove_transition('opacity');
                this._source.opacity = 255;
                this._popdownCallbacks.forEach(func => func());
                this._popdownCallbacks = [];
            }),
        });
        this._needsZoomAndFade = false;
        return undefined;
    });
    // The Shell fades the icon back in after 100 ms (open-state-changed): during our return it stays hidden until the
    // end of the container transform.
    tracker.replacements.replace(proto, 'popdown', original => function (callback) {
        const r = original.call(this, callback);
        if (this._m3eReturning) {
            this._source.remove_transition('opacity');
            this._source.opacity = 0;
        }
        return r;
    });
}

// --- window previews (overview) ----------------------------------------------------------------------------------

const WINDOW_ACTIVE_SIZE_INC = 5; // windowPreview.js

function wirePreviews() {
    const proto = WindowPreview.WindowPreview.prototype;
    const stopPreview = p => tracker.stopGuarded(p.window_container, p._title, p._closeButton);
    // Destroyed preview (its window closed during an overview transition, which the spring makes last): nothing to
    // do. Preview it stacks above (_stackAbove) destroyed or detached: forgotten, otherwise the Shell's _restack
    // touches a destroyed object and set_child_above_sibling fails.
    const usable = p => {
        if (p._destroyed)
            return false;
        const above = p._stackAbove;
        if (above && (above._destroyed || above.get_parent() !== p.get_parent()))
            p._stackAbove = null;
        return true;
    };
    tracker.replacements.replace(proto, 'showOverlay', original => function (animateIt) {
        if (!usable(this))
            return undefined;
        if (!animateIt || !animationsAllowed()) {
            stopPreview(this);
            return original.call(this, animateIt);
        }
        if (!this._overlayEnabled || this._overlayShown)
            return undefined;
        this._overlayShown = true;
        this._restack();
        const toShow = this._windowCanClose() ? [this._title, this._closeButton] : [this._title];
        for (const a of toShow) {
            if (!a.visible) {
                a.opacity = 0;
                a.show();
            }
            a.remove_transition('opacity');
            tracker.stopGuarded(a);
            tracker.guard(a, animate(a, {opacity: 255}, {spring: 'FastEffects'}));
        }
        const [width, height] = this.window_container.get_size();
        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        const extra = WINDOW_ACTIVE_SIZE_INC * 2 * scaleFactor;
        const size = Math.max(width, height);
        const s = size > 0 ? (size + extra) / size : 1;
        this.window_container.remove_transition('scale-x');
        this.window_container.remove_transition('scale-y');
        tracker.stopGuarded(this.window_container);
        tracker.guard(this.window_container,
            animate(this.window_container, {scale_x: s, scale_y: s}, {spring: 'FastSpatial'}));
        this.emit('show-chrome');
        return undefined;
    });
    tracker.replacements.replace(proto, 'hideOverlay', original => function (animateIt) {
        if (!usable(this))
            return undefined;
        if (!animateIt || !animationsAllowed()) {
            stopPreview(this);
            return original.call(this, animateIt);
        }
        if (!this._overlayShown)
            return undefined;
        this._overlayShown = false;
        this._restack();
        for (const a of [this._title, this._closeButton]) {
            a.remove_transition('opacity');
            tracker.stopGuarded(a);
            tracker.guard(a, animate(a, {opacity: 0},
                {spring: 'FastEffects', onDone: tracker.followEnd(a, () => a.hide())}));
        }
        this.window_container.remove_transition('scale-x');
        this.window_container.remove_transition('scale-y');
        tracker.stopGuarded(this.window_container);
        tracker.guard(this.window_container,
            animate(this.window_container, {scale_x: 1, scale_y: 1}, {spring: 'FastSpatial'}));
        return undefined;
    });
}

// --- dash tooltips (the Shell's Dash.DashItemContainer; Dash to Dock's is handled by m3e-extensions) ---------------

const TOOLTIP_SCALE = 0.8; // M3E: same start as the m3e-extensions tooltips (Plain tooltip)

function wireTooltips() {
    const proto = Dash.DashItemContainer.prototype;
    tracker.replacements.replace(proto, 'showLabel', original => function () {
        if (!animationsAllowed() || !this._labelText)
            return original.call(this);
        const label = this.label;
        const resumed = label.visible && label.opacity > 0;
        const opacityBefore = label.opacity;
        // Placement by the Shell (above the item, centered), without its ease (it resets the opacity to 0).
        original.call(this);
        label.remove_transition('opacity');
        if (resumed)
            label.opacity = opacityBefore;
        tracker.forgetEnd(label);
        label.set_pivot_point(0.5, 1);
        if (!resumed) {
            label.opacity = 0;
            label.set_scale(TOOLTIP_SCALE, TOOLTIP_SCALE);
        }
        tracker.touch(label, restDisplayed);
        animate(label, {scale_x: 1, scale_y: 1}, {spring: 'FastSpatial'});
        animate(label, {opacity: 255}, {spring: 'FastEffects'});
        return undefined;
    });
    tracker.replacements.replace(proto, 'hideLabel', original => function () {
        if (!animationsAllowed())
            return original.call(this);
        const label = this.label;
        label.remove_transition('opacity');
        animate(label, {opacity: 0}, {spring: 'FastEffects', onDone: tracker.followEnd(label, () => {
            label.hide();
            label.set_scale(1, 1);
        })});
        return undefined;
    });
}

// --- wiring ------------------------------------------------------------------------------------------------------

const WIRINGS = [wireSwitchers, wireTilePreview, wireFolders, wirePreviews, wireTooltips];

export function enable() {
    tracker.enable(WIRINGS);
}

export function disable() {
    tracker.disable();
}
