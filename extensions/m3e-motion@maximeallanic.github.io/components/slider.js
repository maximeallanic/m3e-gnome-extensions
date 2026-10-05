// M3E slider (Slider) and OSD level (BarLevel). The Shell draws them in JS (barLevel.js, slider.js): a full track and
// a round handle that CSS cannot change. We redraw on top, on the "repaint" signal (after the Shell's drawing, which
// is erased): the vfuncs of an already registered GJS class cannot be replaced.
//
// Slider (Android BrightnessSlider, lengths x 56/72: desktop density): track of -barlevel-height (40 dp -> 31 px),
// outer corners of 12 dp (9 px), inner corners of 2 dp; bar handle of 4 x 52 dp (4 x 40 px), 2 wide while pressed
// (FastSpatial spring); gap of 6 dp (5 px) on each side of the handle; stop indicator of 4 dp at 6 dp from the end
// of the inactive track (Slider tokens).
// Theme colours: -barlevel-active-background-color (active track, dot), -barlevel-background-color (inactive
// track), color (handle), -barlevel-overdrive-color (volume beyond 100 %).
// Level (OSD, same track as the slider in the theme) = linear progress indicator: active and inactive parts with the
// same outer corners as the slider, gap of 4 dp, same stop indicator as the slider.
import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import * as BarLevel from 'resource:///org/gnome/shell/ui/barLevel.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';

import {animate, virtualProperty, removeProperty} from '../m3e/animate.js';
import {Replacements, logFailure} from '../motion/utils.js';

export const NAME = 'slider';

const OUTER_CORNER = 9; // M3E-visual: outer corners of the track, BrightnessSlider 12 dp x 56/72 (pill if the track is lower than 18 px)
const INNER_CORNER = 2; // M3E-visual: inner corners of the split track, BrightnessSlider 2 dp (Compose SliderDefaults: TrackInsideCornerSize)
const HANDLE_GAP = 5; // M3E-visual: handle / track gap, BrightnessSlider 6 dp x 56/72
const HANDLE_WIDTH = 4; // Slider.HandleWidth (BrightnessSlider: 4 dp, kept at 4 px to stay visible)
const HANDLE_WIDTH_PRESSED = 2; // Slider.PressedHandleWidth (BrightnessSlider: width halved while pressed)
const HANDLE_HEIGHT = 40; // M3E-visual: BrightnessSlider handle 52 dp x 56/72
const STOP_INDICATOR = 4; // Slider.StopIndicatorSize
const STOP_INDICATOR_MARGIN = 6; // Slider.StopIndicatorTrailingSpace
const LEVEL_GAP = 4; // LinearProgressIndicator.TrackActiveSpace
const TAU = Math.PI * 2;
const PRESS_PROPERTY = 'm3e-press';

const barProto = BarLevel.BarLevel.prototype;
const sliderProto = Slider.Slider.prototype;
const replacements = new Replacements();
const bars = new Set();

// Rectangle with left corner `cornerLeft` and right corner `cornerRight` (corners limited to half the height and to the width).
function rectangle(cr, x, y, w, h, cornerLeft, cornerRight) {
    if (w <= 0)
        return;
    cornerLeft = Math.min(cornerLeft, h / 2);
    cornerRight = Math.min(cornerRight, h / 2);
    if (cornerLeft + cornerRight > w) {
        const f = w / (cornerLeft + cornerRight);
        cornerLeft *= f;
        cornerRight *= f;
    }
    cr.newSubPath();
    cr.arc(x + w - cornerRight, y + cornerRight, cornerRight, -TAU / 4, 0);
    cr.arc(x + w - cornerRight, y + h - cornerRight, cornerRight, 0, TAU / 4);
    cr.arc(x + cornerLeft, y + h - cornerLeft, cornerLeft, TAU / 4, TAU / 2);
    cr.arc(x + cornerLeft, y + cornerLeft, cornerLeft, TAU / 2, TAU * 3 / 4);
    cr.closePath();
    cr.fill();
}

function dot(cr, cx, cy) {
    cr.arc(cx, cy, STOP_INDICATOR / 2, 0, TAU);
    cr.fill();
}

// Stop indicator at the end of the inactive track (from `start` to `w`), if it fits.
function stopIndicator(bar, cr, start, w, h) {
    const cx = w - STOP_INDICATOR_MARGIN - STOP_INDICATOR / 2;
    if (cx - STOP_INDICATOR / 2 > start) {
        cr.setSourceColor(bar._barLevelActiveColor);
        dot(cr, cx, h / 2);
    }
}

// Active track from 0 to `end`, cut by the overdrive threshold gap if it lies inside.
function activeTrack(bar, cr, y, h, end, endCorner) {
    const r = OUTER_CORNER;
    const overdrive = bar._overdriveStart !== bar._maxValue;
    const [w] = bar.get_surface_size();
    const xs = overdrive ? bar._m3eX(bar._overdriveStart / bar._maxValue, w) : Infinity;
    cr.setSourceColor(bar._barLevelActiveColor);
    if (end <= xs) {
        rectangle(cr, 0, y, end, h, r, endCorner);
        return;
    }
    const half = Math.max(1, bar._overdriveSeparatorWidth / 2);
    rectangle(cr, 0, y, xs - half, h, r, INNER_CORNER);
    cr.setSourceColor(bar._barLevelOverdriveColor);
    rectangle(cr, xs + half, y, end - xs - half, h, INNER_CORNER, endCorner);
}

function drawSlider(bar, cr, w, h) {
    const trackHeight = bar._barLevelHeight;
    const y = (h - trackHeight) / 2;
    const r = OUTER_CORNER;
    const p = bar._maxValue > 0 ? bar._value / bar._maxValue : 0;
    const cx = bar._m3eX(p, w);
    const pressed = bar._m3ePress ?? 0;
    const half = (HANDLE_WIDTH + (HANDLE_WIDTH_PRESSED - HANDLE_WIDTH) * pressed) / 2;

    activeTrack(bar, cr, y, trackHeight, cx - half - HANDLE_GAP, INNER_CORNER);

    const start = cx + half + HANDLE_GAP;
    cr.setSourceColor(bar._barLevelColor);
    rectangle(cr, start, y, w - start, trackHeight, INNER_CORNER, r);
    stopIndicator(bar, cr, start, w, h);
    // Overdrive threshold still ahead of the handle: a dot on the inactive track.
    if (bar._overdriveStart !== bar._maxValue && bar._value < bar._overdriveStart) {
        const xs = bar._m3eX(bar._overdriveStart / bar._maxValue, w);
        if (xs - STOP_INDICATOR / 2 > start) {
            cr.setSourceColor(bar._barLevelActiveColor);
            dot(cr, xs, h / 2);
        }
    }

    const handleHeight = Math.min(HANDLE_HEIGHT, h);
    cr.setSourceColor(bar.get_theme_node().get_foreground_color());
    rectangle(cr, cx - half, (h - handleHeight) / 2, 2 * half, handleHeight, half, half);
}

function drawLevel(bar, cr, w, h) {
    const trackHeight = Math.min(bar._barLevelHeight, h);
    const y = (h - trackHeight) / 2;
    const r = OUTER_CORNER;
    const p = bar._maxValue > 0 ? bar._value / bar._maxValue : 0;
    const end = w * p;
    if (p > 0)
        activeTrack(bar, cr, y, trackHeight, end, r);
    if (p >= 1)
        return;
    const start = p > 0 ? end + LEVEL_GAP : 0;
    cr.setSourceColor(bar._barLevelColor);
    rectangle(cr, start, y, w - start, trackHeight, r, r);
    stopIndicator(bar, cr, start, w, h);
}

function redraw(bar) {
    if (!bar._barLevelColor || !bar._barLevelActiveColor)
        return;
    const cr = bar.get_context();
    try {
        const [w, h] = bar.get_surface_size();
        // The Shell's drawing is erased.
        cr.save();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.restore();
        if (bar.get_text_direction() === Clutter.TextDirection.RTL) {
            cr.translate(w, 0);
            cr.scale(-1, 1);
        }
        if (bar instanceof Slider.Slider)
            drawSlider(bar, cr, w, h);
        else
            drawLevel(bar, cr, w, h);
    } finally {
        cr.$dispose();
    }
}

function wire(bar) {
    if (bar._m3eRepaintId)
        return;
    bars.add(bar);
    // Handle centre for progress p: same mapping as Slider._moveHandle (handle radius from the theme,
    // -slider-handle-radius = half the width of the bar handle).
    bar._m3eX = (p, w) => {
        const radius = bar._handleRadius ?? 0;
        return radius + (w - 2 * radius) * Math.min(1, Math.max(0, p));
    };
    bar._m3eRepaintId = bar.connect_after('repaint', () => {
        try {
            redraw(bar);
        } catch (e) {
            logFailure('slider repaint', e);
        }
    });
    bar._m3eDestroyId = bar.connect('destroy', () => bars.delete(bar));
    if (bar instanceof Slider.Slider) {
        // Press progress 0 -> 1 (handle from 4 to 2 dp), led by the spring; each value repaints.
        let press = 0;
        Object.defineProperty(bar, '_m3ePress', {
            configurable: true,
            get: () => press,
            set: v => {
                press = v;
                bar.queue_repaint();
            },
        });
        // Virtual property: it is a progress, so it settles at the 0.01 unit threshold, not 0.5 px.
        bar._m3ePressPath = virtualProperty(bar, PRESS_PROPERTY, {
            read: () => bar._m3ePress,
            write: v => {
                bar._m3ePress = v;
            },
        });
        bar._m3eDragIds = [
            bar.connect('drag-begin', () => animate(bar, {[bar._m3ePressPath]: 1}, {spring: 'FastSpatial', threshold: 0.01})),
            bar.connect('drag-end', () => animate(bar, {[bar._m3ePressPath]: 0}, {spring: 'FastSpatial', threshold: 0.01})),
        ];
    }
    bar.queue_relayout();
    bar.queue_repaint();
}

function unwire(bar) {
    if (!bar._m3eRepaintId)
        return;
    bar.disconnect(bar._m3eRepaintId);
    bar.disconnect(bar._m3eDestroyId);
    for (const id of bar._m3eDragIds ?? [])
        bar.disconnect(id);
    if (bar._m3ePressPath)
        removeProperty(bar, PRESS_PROPERTY);
    delete bar._m3eRepaintId;
    delete bar._m3eDestroyId;
    delete bar._m3eDragIds;
    delete bar._m3ePress;
    delete bar._m3ePressPath;
    delete bar._m3eX;
    bar.queue_relayout();
    bar.queue_repaint();
}

function walk(actor, callback) {
    if (actor instanceof BarLevel.BarLevel)
        callback(actor);
    for (const child of actor.get_children())
        walk(child, callback);
}

export function enable() {
    replacements.replace(barProto, '_init', original => function (...args) {
        original.apply(this, args);
        wire(this);
    });
    // Height: room for the bar handle (HANDLE_HEIGHT) instead of the diameter of the round handle.
    replacements.replace(sliderProto, '_getPreferredHeight', original => function () {
        const h = original.call(this);
        return this._m3eRepaintId ? Math.max(h, HANDLE_HEIGHT) : h;
    });
    walk(global.stage, wire);
}

export function disable() {
    replacements.restore();
    for (const bar of [...bars])
        unwire(bar);
    bars.clear();
}
