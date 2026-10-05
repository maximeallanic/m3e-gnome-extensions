// Android 16 style battery: a plain pill without outline, the charged part as a flat fill, the rest a track at 20 %
// of the text colour, the percentage in the middle; while charging, a bolt on the right overlaps the end of the
// pill, cut out around its edge. Replaces the icon and the percentage label of the Shell's system indicator, which
// keeps its UPower proxy (DisplayDevice).
// Colours and height come from the theme stylesheet (`.status-bar-battery`, see stylesheet.css and the m3e-gnome
// Shell theme); the digits use the theme font at its weight, formatted for the session language (Intl).
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import Rsvg from 'gi://Rsvg';
import St from 'gi://St';
import UPower from 'gi://UPowerGlib';
import cairo from 'cairo';

import {whenIndicator} from './quick-settings.js';

export const NAME = 'battery';

// Proportions measured on an Android phone (pill of 83 x 45 px, bolt of 30 px). All relative to the height.
const WIDTH = 1.84;                     // pill width
const RADIUS = 0.29;                    // corner radius
const DIGITS = 0.67;                    // ink height of the digits
const DIGITS_MARGIN = 0.7;              // max ink width of the digits / pill (stops before the bolt)
const TRACK = 0.2;                      // track opacity (share of the text colour)
const BOLT_SIZE = 0.67;                 // side of the bolt frame
const OVERLAP = 0.2;                    // part of the bolt laid over the pill
const CUTOUT = 0.045;                   // thickness of the cut-out around the bolt

// Filled "bolt" symbol, rounded style (Material Symbols, same revision as the m3e-gnome icon theme).
const BOLT = 'M360-360H236q-24 0-35.5-21.5T203-423l299-430q10-14 26-19.5t33 .5q17 6 25 21t6 32l-32 259h155q26 0 ' +
    '36.5 23t-6.5 43L416-100q-11 13-27 17t-31-3q-15-7-23.5-21.5T328-139l32-221Z';
const BOLT_VIEW = '0 -960 960 960';
const BOLT_BOX = {x: 194, y: -876, w: 562, h: 796};   // ink of the symbol in its grid

function boltSvg(stroke) {
    const style = stroke
        ? `fill="#000" stroke="#000" stroke-width="${stroke}" stroke-linejoin="round"`
        : 'fill="#000"';
    return Rsvg.Handle.new_from_data(new TextEncoder().encode(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${BOLT_VIEW}"><path ${style} d="${BOLT}"/></svg>`));
}

const Battery = GObject.registerClass(
class Battery extends St.DrawingArea {
    _init() {
        super._init({style_class: 'status-bar-battery', y_align: Clutter.ActorAlign.CENTER});
        this._percentage = 0;
        this._plugged = false;
        this._format = new Intl.NumberFormat();
        this.connect('style-changed', () => this.queue_relayout());
    }

    refresh(percentage, deviceState) {
        this._percentage = Math.round(Math.max(0, Math.min(100, percentage)));
        const plugged = [UPower.DeviceState.CHARGING, UPower.DeviceState.FULLY_CHARGED,
            UPower.DeviceState.PENDING_CHARGE].includes(deviceState);
        if (plugged !== this._plugged) {
            this._plugged = plugged;
            this.queue_relayout();
        }
        this.queue_repaint();
    }

    _height() {
        return this.get_theme_node().get_length('-status-bar-height');
    }

    vfunc_get_preferred_width(_forHeight) {
        const h = this._height();
        const w = Math.ceil(h * (WIDTH + (this._plugged ? BOLT_SIZE - OVERLAP : 0)));
        return [w, w];
    }

    vfunc_get_preferred_height(_forWidth) {
        const h = Math.ceil(this._height());
        return [h, h];
    }

    _color(name) {
        const [found, color] = this.get_theme_node().lookup_color(name, false);
        if (!found)
            throw new Error(`status-bar: ${name} is missing from the theme stylesheet (.status-bar-battery)`);
        return color;
    }

    vfunc_repaint() {
        const cr = this.get_context();
        try {
            this._draw(cr);
        } catch (e) {
            console.error(`status-bar: battery drawing failed: ${e.message}\n${e.stack}`);
        } finally {
            cr.$dispose();
        }
    }

    _draw(cr) {
        const [width, h] = this.get_surface_size();
        const w = h * WIDTH;
        const rtl = this.get_text_direction() === Clutter.TextDirection.RTL;
        const startX = rtl ? h * (BOLT_SIZE - OVERLAP) : 0;      // start of the pill
        const node = this.get_theme_node();
        const text = node.get_foreground_color();
        const low = this._percentage <= 20 && !this._plugged;
        const fill = this._plugged ? this._color('-status-bar-charging')
            : low ? this._color('-status-bar-low') : text;
        const rgba = (c, a = 1) => cr.setSourceRGBA(c.red / 255, c.green / 255, c.blue / 255, c.alpha / 255 * a);

        // Pill: track, then the charged part with a sharp edge (start side follows the reading direction).
        const pill = () => {
            const r = h * RADIUS;
            cr.newSubPath();
            cr.arc(startX + w - r, r, r, -Math.PI / 2, 0);
            cr.arc(startX + w - r, h - r, r, 0, Math.PI / 2);
            cr.arc(startX + r, h - r, r, Math.PI / 2, Math.PI);
            cr.arc(startX + r, r, r, Math.PI, 3 * Math.PI / 2);
            cr.closePath();
        };
        const chargedWidth = w * this._percentage / 100;
        const chargedX = rtl ? startX + w - chargedWidth : startX;
        cr.save();
        pill();
        cr.clip();
        rgba(text, TRACK);
        cr.paint();
        cr.rectangle(chargedX, 0, chargedWidth, h);
        rgba(fill);
        cr.fill();
        cr.restore();

        // Percentage centred on its measured ink height: over the charged part it is cut out (the bar background
        // shows through, contrast in every mode) or, while charging, drawn in the text colour of the green.
        const layout = PangoCairo.create_layout(cr);
        const font = node.get_font().copy();
        font.set_absolute_size(h * Pango.SCALE);
        layout.set_font_description(font);
        layout.set_text(this._format.format(this._percentage), -1);
        let [ink] = layout.get_pixel_extents();
        // Target ink height, without exceeding DIGITS_MARGIN of the pill in width ("100", wide digits).
        const fit = Math.min(h * DIGITS / ink.height, w * DIGITS_MARGIN / ink.width);
        font.set_absolute_size(h * Pango.SCALE * fit);
        layout.set_font_description(font);
        [ink] = layout.get_extents();
        const k = 1 / Pango.SCALE;
        const tx = startX + w / 2 - (ink.x + ink.width / 2) * k;
        const ty = h / 2 - (ink.y + ink.height / 2) * k;
        cr.save();
        cr.moveTo(tx, ty);
        PangoCairo.layout_path(cr, layout);
        cr.restore();
        const path = cr.copyPath();
        cr.newPath();
        // Outside the charged part: text colour.
        cr.save();
        cr.rectangle(rtl ? 0 : chargedX + chargedWidth, 0, rtl ? chargedX : width, h);
        cr.clip();
        cr.appendPath(path);
        rgba(text);
        cr.fill();
        cr.restore();
        // Over the charged part.
        cr.save();
        cr.rectangle(chargedX, 0, chargedWidth, h);
        cr.clip();
        cr.appendPath(path);
        if (this._plugged) {
            rgba(this._color('-status-bar-charging-text'));
        } else {
            cr.setOperator(cairo.Operator.DEST_OUT);
            cr.setSourceRGBA(0, 0, 0, 1);
        }
        cr.fill();
        cr.restore();

        if (!this._plugged)
            return;
        // Bolt: square frame of BOLT_SIZE x h overlapping the end of the pill, cut out by erasing.
        const c = h * BOLT_SIZE;
        const bx = rtl ? 0 : startX + w - h * OVERLAP;
        const by = (h - c) / 2;
        const scale = c / Math.max(BOLT_BOX.w, BOLT_BOX.h);
        const viewport = new Rsvg.Rectangle({
            x: bx + c / 2 - (BOLT_BOX.x + BOLT_BOX.w / 2) * scale,
            y: by + c / 2 - (BOLT_BOX.y + 960 + BOLT_BOX.h / 2) * scale,
            width: 960 * scale, height: 960 * scale,
        });
        cr.pushGroup();
        boltSvg(2 * h * CUTOUT / scale).render_document(cr, viewport);
        const cutout = cr.popGroup();
        cr.save();
        cr.setOperator(cairo.Operator.DEST_OUT);
        cr.setSourceRGBA(0, 0, 0, 1);
        cr.mask(cutout);
        cr.restore();
        cr.pushGroup();
        boltSvg(0).render_document(cr, viewport);
        const shape = cr.popGroup();
        rgba(text);
        cr.mask(shape);
    }
});

let cancelWait = null;
let state = null;

function apply() {
    const {system, battery} = state;
    const {powerToggle} = system._systemItem;
    const present = powerToggle.visible;
    const proxy = powerToggle._proxy;
    if (present)
        battery.refresh(proxy.Percentage, proxy.State);
    battery.visible = present;
    // Without a battery the Shell shows the power-off icon: we leave it to it.
    if (present && system._indicator.visible)
        system._indicator.hide();
    if (!present && !system._indicator.visible)
        system._indicator.show();
    if (system._percentageLabel.visible)
        system._percentageLabel.hide();
}

export function enable() {
    cancelWait = whenIndicator('_system', system => {
        const battery = new Battery();
        const {powerToggle} = system._systemItem;
        state = {system, battery};
        state.ids = [
            [powerToggle._proxy, powerToggle._proxy.connect('g-properties-changed', apply)],
            [powerToggle, powerToggle.connect('notify::visible', apply)],
            [system._indicator, system._indicator.connect('notify::visible', apply)],
            [system._percentageLabel, system._percentageLabel.connect('notify::visible', apply)],
            [battery, battery.connect('notify::visible', () => system._syncIndicatorsVisible())],
        ];
        system.add_child(battery);
        apply();
    });
}

export function disable() {
    cancelWait?.();
    cancelWait = null;
    if (!state)
        return;
    const {system, battery} = state;
    for (const [object, id] of state.ids)
        object.disconnect(id);
    battery.destroy();
    system._indicator.show();
    system._sync();                      // restores the percentage label according to the GNOME setting
    system._syncIndicatorsVisible();
    state = null;
}
