// Quick settings and calendar: choreography of the Android quick-settings shade, measured frame by frame on an
// Android 17 device, with the GNOME structure kept (the panel stays a menu of the top bar).
//   - open : the panel appears and its content comes down by ANDROID.qsShade.openDp (x desktop density) to its place,
//     on the spring fitted on the recording (ShadeExpansionMeasured);
//   - close: same spring, the content goes up towards closeDp and the panel disappears once it has travelled cutoffDp;
//   - panel opacity tied to the displacement, the same in both directions: 1 - d / cutoff (the content only shows
//     from -cutoff and fades going up); a reversal therefore makes no jump;
//   - content clipped at its place inside the panel (it slides under the top edge of the card), the card and its
//     shadow are not clipped.
// Interruptible: one Driver (toolkit spring) per panel, retargeted with the displayed position and velocity.
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ANDROID} from '../m3e/tokens.js';
import {Driver} from '../motion/utils.js';

const SHADE = ANDROID.qsShade;
export const OPEN_PX = SHADE.openDp * ANDROID.density;
export const CLOSE_PX = SHADE.closeDp * ANDROID.density;
export const CUTOFF_PX = SHADE.cutoffDp * ANDROID.density;

// Top bar buttons whose menu follows the shade choreography (keys of Main.panel.statusArea).
const BUTTONS = ['quickSettings', 'dateMenu'];

const shades = new Set();

// Is the menu of `boxPointer` the quick settings or the calendar one?
export function isShade(boxPointer) {
    const area = Main.panel?.statusArea;
    return BUTTONS.some(name => area?.[name]?.menu?._boxPointer === boxPointer);
}

class Shade {
    constructor(box) {
        this._box = box;
        this.d = 0; // upward displacement of the content, px (0: in place)
        this._onClosed = null; // end of the closing (played at the cutoff)
        this._onOpened = null;
        this._mappedId = 0;
        this._cut = false;
        this._idle = 0;
        this._driver = new Driver(box, {
            read: () => this.d,
            write: v => this._write(v),
            spring: SHADE.spring,
        });
        this._destroyId = box.connect('destroy', () => this.destroy());
        shades.add(this);
    }

    get running() {
        return this._driver.running;
    }

    // Content: children of the card (menu.box), translated and clipped together.
    _content() {
        return this._box.bin.get_child()?.get_children() ?? [];
    }

    _write(d) {
        this.d = d;
        for (const child of this._content()) {
            child.translation_y = -d;
            if (d > 0)
                child.set_clip(0, d, child.width, child.height);
            else
                child.remove_clip();
        }
        this._box.opacity = Math.round(255 * Math.min(1, Math.max(0, 1 - d / CUTOFF_PX)));
        if (this._onClosed && !this._cut && d >= CUTOFF_PX) {
            // Cutoff: the panel is gone, the closing is done (the spring is not led to rest).
            this._cut = true;
            this._idle = GLib.idle_add(GLib.PRIORITY_HIGH, () => {
                this._idle = 0;
                const onClosed = this._onClosed;
                this._onClosed = null;
                this._driver.stop();
                onClosed?.();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _cancelCutoff() {
        if (this._mappedId)
            this._box.disconnect(this._mappedId);
        this._mappedId = 0;
        if (this._idle)
            GLib.source_remove(this._idle);
        this._idle = 0;
        this._cut = false;
        this._onClosed = null;
    }

    // Opening of a closed panel (not the take-over of a running close): start at the top, invisible. The box's
    // visibility does not tell (the quick settings box stays visible, its menu.actor is hidden instead).
    open(onDone) {
        const takeOver = this._driver.running || this._onClosed !== null;
        this._cancelCutoff();
        if (!takeOver) {
            this._driver.stop();
            this._write(OPEN_PX);
        }
        this._onOpened = onDone;
        // Panel not displayed yet (first opening: menu.actor was just shown, the stage has not mapped the box yet):
        // the spring starts at display time, otherwise animate() would set the final value at once.
        if (!this._box.mapped) {
            this._mappedId = this._box.connect('notify::mapped', () => {
                if (!this._box.mapped)
                    return;
                this._box.disconnect(this._mappedId);
                this._mappedId = 0;
                if (this._onOpened === onDone)
                    this._goOpen(onDone);
            });
            return;
        }
        this._goOpen(onDone);
    }

    _goOpen(onDone) {
        this._driver.goTo(0, {
            onComplete: () => {
                this._onOpened = null;
                this.rest();
                onDone?.();
            },
        });
    }

    close(onDone) {
        this._cancelCutoff();
        this._onOpened = null;
        this._onClosed = onDone;
        this._driver.forgetCallbacks();
        this._driver.goTo(CLOSE_PX);
        // Already beyond the cutoff (closing taken over near its end): _write() was not called.
        if (this.d >= CUTOFF_PX)
            this._write(this.d);
    }

    // Content in place, without clip; opacity left to the caller.
    rest() {
        for (const child of this._content()) {
            child.translation_y = 0;
            child.remove_clip();
        }
        this.d = 0;
    }

    halt() {
        this._cancelCutoff();
        this._driver.forgetCallbacks();
        this._driver.stop();
    }

    destroy() {
        this.halt();
        this._driver.destroy();
        if (this._destroyId)
            this._box.disconnect(this._destroyId);
        this._destroyId = 0;
        shades.delete(this);
        if (this._box._m3eShade === this)
            delete this._box._m3eShade;
    }
}

export const shadeOf = box => box._m3eShade ??= new Shade(box);

// disable(): panels put back at rest (content in place, opacity from visibility), pending end played (a panel that
// was closing closes, a panel that was opening is declared open), drivers removed.
export function restAll() {
    for (const shade of [...shades]) {
        const box = shade._box;
        const onDone = shade._onClosed ?? shade._onOpened;
        shade.halt();
        shade.rest();
        box.opacity = box.visible ? 255 : 0;
        shade.destroy();
        onDone?.();
    }
}
