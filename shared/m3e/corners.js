// Animatable rounded corners for any actor (spec §6): St cannot animate `border-radius`, and a window
// has no CSS style.
//
//   RoundedCorners : Shell.GLSLEffect, GObject properties (all animatable through
//                    animate(actor, {'@effects.m3e-corners.<prop>': v})):
//     radius                     double, logical px;
//     left, top                  double, local logical px: corner of the clip area;
//     width, height              double, local logical px; < 0 (default -1): the whole actor;
//     compensate                 boolean (see below).
//   corners(actor) → RoundedCorners   (effect named "m3e-corners", added if missing)
//
// Every property change requests a repaint (queue_repaint), otherwise a timeline would advance
// without painting anything.
//
// Clip area: rounded rectangle, in the actor's local space, outside of which the actor is transparent.
// By default, the whole actor. The container transform animates it (mask of the deforming container,
// like maskEvaluator.clip in MDC) independently from the content scale.
// Windows: the actor of a window (MetaWindowActor or its surface) contains the shadows and margins of
// client-side decorations; the area must be the content rectangle, in logical px local to the actor
// carrying the effect:
//     const buffer = metaWindow.get_buffer_rect(), frame = metaWindow.get_frame_rect();
//     effect.left = frame.x - buffer.x;    effect.top = frame.y - buffer.y;
//     effect.width = frame.width;          effect.height = frame.height;
// (compositor logical px rectangles; update on the window's 'size-changed' / 'position-changed').
// Without this, the corners are cut into the shadow, not into the window.
//
// Clipping: the fragment is multiplied by the coverage of the rounded rectangle, computed in px of the
// off-screen texture with 1 px of smoothing, corners and straight edges (coverage = clamp(0.5 - signed
// distance, 0, 1)). Layout of that texture, read in mutter 18 (clutter-offscreen-effect.c, pre_paint)
// and reproduced here:
//  - LOCAL space of the actor (the actor's scale and translation do not change the texture: 803×603 px
//    for an 800×600 actor shrunk to 0.12);
//  - box = paint volume enlarged by _clutter_actor_box_enlarge_for_effects (rounded width,
//    x2 = ceil(x2 + 0.75), x1 = x2 - width - 3): the texture edge is at trunc(x1) local logical px
//    (-2 for a whole actor at 0,0), hence the uniform m3e_start; expectedTexture() derives the size from
//    it, which the bench compares with get_target_size() (scenario corners-texture);
//  - rendered at scale ceil(resource scale): 1 texture px = 1 physical px at an integer scale; at 1.5 the
//    texture is rendered at 2 then reduced, so the smoothing is then 0.75 physical px.
// Scale chosen: actor.get_resource_scale() (real scale of the monitor where the actor is painted, like
// mutter for this texture), not St.ThemeContext.scale_factor (integer UI factor, 1 under fractional
// scaling, unrelated to the texture).
//
// `compensate` (boolean, false by default): the radius is then expressed in logical px ON SCREEN despite
// the actor's own scale (scale_x / scale_y): local radius = radius / scale, per axis. The container
// transform uses it: the content is shrunk there, but the container keeps its visible radius.

import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

export const CORNERS_EFFECT_NAME = 'm3e-corners';

// GType name specific to this copy of the file: m3e/ is embedded in several extensions and two classes with
// the same name cannot be registered.
const typeName = base => `${base}_${import.meta.url.replace(/[^A-Za-z0-9]/g, '_')}`;

const DECLARATIONS = `
uniform vec2 m3e_texture;
uniform vec2 m3e_start;
uniform vec2 m3e_box;
uniform vec2 m3e_radius;
`;

// p: fragment position in texture px from the corner of the area; q: signed distance to the nearest
// edges (positive inside); in a corner, signed distance approximated to the ellipse (first order
// g / |∇g|, exact for a circle).
const CODE = `
vec2 p = cogl_tex_coord_in[0].xy * m3e_texture - m3e_start;
vec2 q = min(p, m3e_box - p);
vec2 r = m3e_radius;
float a = clamp(q.x + 0.5, 0.0, 1.0) * clamp(q.y + 0.5, 0.0, 1.0);
if (r.x > 0.0 && r.y > 0.0 && q.x < r.x && q.y < r.y) {
    vec2 d = (r - q) / r;
    float l = length(d);
    float dist = (l - 1.0) * l / max(length(d / r), 1e-6);
    a = clamp(0.5 - dist, 0.0, 1.0);
}
cogl_color_out *= a;
`;

// _clutter_actor_box_enlarge_for_effects (mutter 18, clutter-actor-box.c) on an interval [a, b]:
// returns [start, size] of the enlarged interval.
function enlarge(a, b) {
    const width = Math.round(b - a);
    const end = Math.ceil(b + 0.75);
    return [end - width - 3, width + 3];
}

// Box of the off-screen texture in local logical px, like ClutterOffscreenEffect:
// {x, y} = fbo_offset, {w, h} = size before scaling.
function textureBox(actor) {
    const volume = actor.get_paint_volume();
    if (volume) {
        const o = volume.get_origin();
        const w = volume.get_width(), h = volume.get_height();
        if (w * h === 0)
            return {x: Math.trunc(o.x), y: Math.trunc(o.y), w, h};
        const [x, tw] = enlarge(o.x, o.x + w), [y, th] = enlarge(o.y, o.y + h);
        return {x: Math.trunc(x), y: Math.trunc(y), w: tw, h: th};
    }
    const b = actor.get_allocation_box();
    const w = b.x2 - b.x1, h = b.y2 - b.y1;
    if (w * h === 0)
        return {x: 0, y: 0, w, h};
    const [x, tw] = enlarge(b.x1, b.x2), [y, th] = enlarge(b.y1, b.y2);
    return {x: Math.trunc(x - b.x1), y: Math.trunc(y - b.y1), w: tw, h: th};
}

// Size (px) that mutter will give the texture: ceil(size × ceil(scale)).
export function expectedTexture(actor) {
    const scale = Math.ceil(actor.get_resource_scale());
    const b = textureBox(actor);
    return [Math.ceil(b.w * scale), Math.ceil(b.h * scale)];
}

const double = (name, min, defaultValue) => GObject.ParamSpec.double(name, null, null,
    GObject.ParamFlags.READWRITE, min, Number.MAX_VALUE, defaultValue);

// JS property backed by a private field, which requests a repaint when it changes.
function property(klass, name, defaultValue) {
    const field = `_${name}`;
    Object.defineProperty(klass.prototype, name, {
        get() {
            return this[field] ?? defaultValue;
        },
        set(v) {
            if (this[field] === v)
                return;
            this[field] = v;
            this.queue_repaint();
            this.notify(name);
        },
        configurable: true,
    });
}

class RoundedCornersBase extends Shell.GLSLEffect {
    _init(params = {}) {
        super._init(params);
        this._textureLocation = this.get_uniform_location('m3e_texture');
        this._startLocation = this.get_uniform_location('m3e_start');
        this._boxLocation = this.get_uniform_location('m3e_box');
        this._radiusLocation = this.get_uniform_location('m3e_radius');
        this._lastPaint = null;
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, CODE, false);
    }

    // Effective clip area (local logical px).
    area() {
        const a = this.get_actor();
        const w = this.width < 0 ? a?.width ?? 0 : this.width;
        const h = this.height < 0 ? a?.height ?? 0 : this.height;
        return {x: this.width < 0 ? 0 : this.left, y: this.height < 0 ? 0 : this.top, w, h};
    }

    vfunc_paint_target(node, paintContext) {
        const actor = this.get_actor();
        if (actor) {
            const scale = Math.ceil(actor.get_resource_scale());
            const [, tw, th] = this.get_target_size();
            const box = textureBox(actor);
            const z = this.area();
            const r = Math.max(0, this.radius);
            let rx = r, ry = r;
            if (this.compensate) {
                rx = actor.scale_x > 0 ? r / actor.scale_x : z.w / 2;
                ry = actor.scale_y > 0 ? r / actor.scale_y : z.h / 2;
            }
            rx = Math.min(rx, Math.max(0, z.w) / 2);
            ry = Math.min(ry, Math.max(0, z.h) / 2);
            const start = [(z.x - box.x) * scale, (z.y - box.y) * scale];
            const size = [z.w * scale, z.h * scale];
            const radius = [rx * scale, ry * scale];
            this.set_uniform_float(this._textureLocation, 2, [tw, th]);
            this.set_uniform_float(this._startLocation, 2, start);
            this.set_uniform_float(this._boxLocation, 2, size);
            this.set_uniform_float(this._radiusLocation, 2, radius);
            // Cheap per-paint record for the bench (primitives and the small arrays above, already built).
            this._lastPaint = {frame: (this._lastPaint?.frame ?? 0) + 1, texture: [tw, th], start,
                box: size, textureRadius: radius, scale, radius: this.radius,
                actorScale: [actor.scale_x, actor.scale_y]};
        }
        super.vfunc_paint_target(node, paintContext);
    }

    // For the bench: uniforms of the last painted frame, plus the texture size mutter should have
    // chosen (computed on demand, not on every paint).
    _diagnostic() {
        const last = this._lastPaint;
        const actor = this.get_actor();
        return last && actor ? {...last, expectedTexture: expectedTexture(actor)} : last;
    }
}

// Properties before registration: registerClass sees the accessors.
property(RoundedCornersBase, 'radius', 0);
property(RoundedCornersBase, 'left', 0);
property(RoundedCornersBase, 'top', 0);
property(RoundedCornersBase, 'width', -1);
property(RoundedCornersBase, 'height', -1);
property(RoundedCornersBase, 'compensate', false);

export const RoundedCorners = GObject.registerClass({
    GTypeName: typeName('M3eRoundedCorners'),
    Properties: {
        // Negative allowed (spring overshoot toward 0): clamped to 0 at paint time.
        radius: double('radius', -Number.MAX_VALUE, 0),
        left: double('left', -Number.MAX_VALUE, 0),
        top: double('top', -Number.MAX_VALUE, 0),
        width: double('width', -Number.MAX_VALUE, -1),
        height: double('height', -Number.MAX_VALUE, -1),
        compensate: GObject.ParamSpec.boolean('compensate', null, null, GObject.ParamFlags.READWRITE,
            false),
    },
}, RoundedCornersBase);

export function corners(actor) {
    let effect = actor.get_effect(CORNERS_EFFECT_NAME);
    if (!effect) {
        effect = new RoundedCorners();
        actor.add_effect_with_name(CORNERS_EFFECT_NAME, effect);
    }
    return effect;
}
