// System surfaces of the Shell with Android SystemUI motions (values: shared/data/android-source.json). Each
// replacement keeps the contract of the original method (states, signals, callbacks, destruction) and falls back to it
// when animations are off.
//   OSD (volume, brightness...): the box slides by its own height from the bottom of the screen (nearest edge) on the
//     spring of the volume dialog (700 / 0.9; VolumeDialogViewBinder: translationX = lerp(width, 0, fraction)),
//     opacity all-or-nothing (ceil(fraction)); exit: same spring the other way round, then hidden;
//   modal dialogs: DialogTransitionAnimator springs, without a source view (the Shell gives none): the card grows from
//     0.8 (start of the theme's M3E fade) on the LAUNCH scale (700 / 1.3), scrim and card fade on the progress,
//     content fades over [0.85; 0.985] (TransitionAnimator.SPRING_TIMINGS); closing on the COLLAPSE scale
//     (380 / 0.9), content erased over [0; 0.8] of the closing progress;
//   banners: slide from the top in 400 ms FAST_OUT_SLOW_IN, exit upward in 400 ms FAST_OUT_SLOW_IN_REVERSE
//     (StackStateAnimator, heads-up), opacity all-or-nothing.
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as OsdWindow from 'resource:///org/gnome/shell/ui/osdWindow.js';

import {animate, virtualProperty} from '../m3e/animate.js';
import {ANDROID, PATTERNS} from '../m3e/tokens.js';
import {animationsAllowed} from './utils.js';
import {windowFraction} from './geometry.js';
import {Tracker, restDisplayed} from './surfaces-common.js';

export const NAME = 'system';

const tracker = new Tracker(NAME);
const A = ANDROID;

// --- OSD ---------------------------------------------------------------------------------------------------------

// Entry of the box: translation from its allocated height to 0. Box not allocated yet (first display): start set at
// the first allocation, before the first frame.
function enter(box) {
    if (box._m3eAllocId) {
        box.disconnect(box._m3eAllocId);
        box._m3eAllocId = 0;
    }
    const start = () => animate(box, {translation_y: 0}, {spring: A.osd.spring});
    if (box.has_allocation() && box.height > 0) {
        start();
        return;
    }
    box.opacity = 0;
    box._m3eAllocId = box.connect('notify::allocation', () => {
        if (!(box.height > 0))
            return;
        box.disconnect(box._m3eAllocId);
        box._m3eAllocId = 0;
        box.translation_y = box.height;
        box.opacity = 255;
        start();
    });
}

// Box put back at rest; a pending first-allocation handler (see enter()) is disconnected.
function restoreBox(box) {
    if (box._m3eAllocId) {
        box.disconnect(box._m3eAllocId);
        box._m3eAllocId = 0;
    }
    restDisplayed(box);
}

function wireOsd() {
    const proto = OsdWindow.OsdWindow.prototype;
    tracker.replacements.replace(proto, 'show', original => function () {
        if (!animationsAllowed())
            return original.call(this);
        if (!this._icon.gicon)
            return undefined;
        const box = this._hbox;
        const hidden = !this.visible;
        // The Shell's own show() arms the hide timeout, takes the unredirect and shows the window; its opacity ease
        // is replaced by our slide.
        original.call(this);
        tracker.touch(box, restoreBox);
        if (hidden || this._m3eExiting) {
            this.remove_transition('opacity');
            if (hidden)
                box.translation_y = box.height;
            tracker.forgetEnd(box);
            this._m3eExiting = false;
            this.opacity = 255;
            box.opacity = 255;
            this.get_parent().set_child_above_sibling(this, null);
            if (hidden)
                enter(box);
            else
                animate(box, {translation_y: 0}, {spring: A.osd.spring});
        }
        return undefined;
    });
    tracker.replacements.replace(proto, '_hide', original => function () {
        if (!animationsAllowed())
            return original.call(this);
        this._hideTimeoutId = 0;
        this._m3eExiting = true;
        const box = this._hbox;
        animate(box, {translation_y: box.height}, {
            spring: A.osd.spring,
            onDone: tracker.followEnd(box, () => {
                this._m3eExiting = false;
                this._reset();
                restDisplayed(box);
                global.compositor.enable_unredirect();
            }),
        });
        return undefined;
    });
}

// --- modal dialogs -----------------------------------------------------------------------------------------------

const D = A.dialog;
const START_SCALE = PATTERNS.fade.incomingScale;

// Dialog progress p (0: closed, 1: open), virtual property of the dialog actor: scale of the card, scrim and card
// fading, content on its window (opening or closing depending on the current direction).
function progressOf(dialog) {
    if (dialog._m3eProgress)
        return dialog._m3eProgress;
    const e = {p: 0, opening: true};
    const card = dialog.dialogLayout._dialog;
    const content = () => [dialog.contentLayout, dialog.buttonLayout];
    e.write = v => {
        e.p = v;
        const s = START_SCALE + (1 - START_SCALE) * v;
        card.set_pivot_point(0.5, 0.5);
        card.set_scale(s, s);
        dialog.opacity = Math.round(255 * Math.min(1, Math.max(0, v)));
        const c = e.opening ? windowFraction(v, D.contentEnterStart, D.contentEnterEnd)
            : 1 - windowFraction(1 - v, D.contentExitStart, D.contentExitEnd);
        for (const a of content())
            a.opacity = Math.round(255 * c);
    };
    e.path = virtualProperty(dialog, 'm3e-dialog', {read: () => e.p, write: e.write});
    e.settle = () => {
        card.set_scale(1, 1);
        for (const a of content())
            a.opacity = 255;
    };
    dialog._m3eProgress = e;
    return e;
}

function wireDialogs() {
    const S = ModalDialog.State;
    const proto = ModalDialog.ModalDialog.prototype;
    tracker.replacements.replace(proto, '_fadeOpen', original => function () {
        if (!animationsAllowed() || !this._shouldFadeIn)
            return original.call(this);
        this._monitorConstraint.index = global.display.get_current_monitor();
        this._setState(S.OPENING);
        if (this._lightbox)
            this._lightbox.lightOn();
        this.dialogLayout.opacity = 255;
        tracker.stopGuarded(this.dialogLayout);
        const e = progressOf(this);
        e.opening = true;
        if (!this.visible) {
            this.show();
            e.write(0);
        }
        tracker.touch(this, d => {
            d._m3eProgress?.settle();
            restDisplayed(d);
        });
        animate(this, {[e.path]: 1}, {
            spring: D.openScale,
            threshold: 0.002,
            onDone: tracker.followEnd(this, () => {
                e.settle();
                this._setState(S.OPENED);
                this.emit('opened');
            }),
        });
        return undefined;
    });
    tracker.replacements.replace(proto, 'close', original => function () {
        if (this.state === S.CLOSED || this.state === S.CLOSING)
            return undefined;
        if (!animationsAllowed() || !this._shouldFadeOut)
            return original.call(this);
        this._setState(S.CLOSING);
        this.popModal();
        this._savedKeyFocus = null;
        const e = progressOf(this);
        e.opening = false;
        animate(this, {[e.path]: 0}, {
            spring: D.closeScale,
            threshold: 0.002,
            onDone: tracker.followEnd(this, () => {
                e.settle();
                restDisplayed(this.dialogLayout);
                this._closeComplete();
            }),
        });
        return undefined;
    });
    tracker.replacements.replace(proto, '_fadeOutDialog', original => function () {
        if (!animationsAllowed())
            return original.call(this);
        if (this.state === S.CLOSED || this.state === S.CLOSING || this.state === S.FADED_OUT)
            return undefined;
        this.popModal();
        // Slow acknowledgement (the box leaves, the scrim stays): SlowEffects.
        tracker.guard(this.dialogLayout, animate(this.dialogLayout, {opacity: 0}, {
            spring: 'SlowEffects',
            onDone: tracker.followEnd(this.dialogLayout, () => this._setState(S.FADED_OUT)),
        }));
        return undefined;
    });
}

// --- notification banners ----------------------------------------------------------------------------------------

const B = A.banner;

function wireBanners() {
    const S = MessageTray.State;
    const proto = MessageTray.MessageTray.prototype;
    // Fallback to the original method: our slide is stopped first, otherwise its end would put the state back to
    // SHOWN after the Shell removed everything (no banner afterwards).
    const stopBanner = tray => {
        tray._m3eSlide?.stop();
        tray._m3eSlide = null;
        tracker.forgetEnd(tray._bannerBin);
        restDisplayed(tray._bannerBin);
    };
    tracker.replacements.replace(proto, '_updateShowingNotification', original => function () {
        if (!animationsAllowed()) {
            stopBanner(this);
            return original.call(this);
        }
        this._notification.acknowledged = true;
        this._notification.playSound();
        if (this._notification.urgency === MessageTray.Urgency.CRITICAL ||
            this._notification.source.policy.forceExpanded)
            this._expandBanner(true);
        this._notificationState = S.SHOWING;
        const bin = this._bannerBin;
        bin.remove_all_transitions();
        bin.y = 0;
        tracker.touch(bin, restDisplayed);
        const onDone = tracker.followEnd(bin, () => {
            if (this._notificationState !== S.SHOWING || !this._notification)
                return;
            this._notificationState = S.SHOWN;
            this._showNotificationCompleted();
            this._updateState();
        });
        // Notification updated while displayed: no new slide, only the end.
        if (bin.opacity === 255 && bin.translation_y === 0 && !this._m3eSlide?.running) {
            onDone();
            return undefined;
        }
        // Hidden banner (not an interrupted exit): start above the screen.
        if (!this._m3eSlide?.running)
            bin.translation_y = -bin.get_preferred_height(-1)[1];
        bin.opacity = 255;
        this._m3eSlide = animate(bin, {translation_y: 0}, {
            spring: {curve: B.enter, duration: B.durationMs},
            onDone,
        });
        return undefined;
    });
    tracker.replacements.replace(proto, '_hideNotification', original => function (animateIt) {
        if (!animationsAllowed() || !animateIt) {
            stopBanner(this);
            return original.call(this, animateIt);
        }
        this._notificationFocusGrabber.ungrabFocus();
        this._banner.disconnectObject(this);
        this._resetNotificationLeftTimeout();
        const bin = this._bannerBin;
        bin.remove_all_transitions();
        this._notificationState = S.HIDING;
        this._m3eSlide = animate(bin, {translation_y: -bin.height}, {
            spring: {curve: B.exit, duration: B.durationMs},
            onDone: tracker.followEnd(bin, () => {
                bin.opacity = 0;
                bin.translation_y = 0;
                if (this._notificationState !== S.HIDING || !this._notification)
                    return;
                this._notificationState = S.HIDDEN;
                this._hideNotificationCompleted();
                this._updateState();
            }),
        });
        return undefined;
    });
}

// --- wiring ------------------------------------------------------------------------------------------------------

export function enable() {
    tracker.enable([wireOsd, wireDialogs, wireBanners]);
}

export function disable() {
    tracker.disable();
}
