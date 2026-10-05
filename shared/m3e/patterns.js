// M3E transition patterns (spec §6), composed on animate().
//
//   containerTransform(source, destination, {sourceRadius, destinationRadius, hideSource, keepCorners,
//                      content, reverse, launch, onDone})
//   sharedAxis(outgoing, incoming, axis 'x'|'y'|'z', direction 1|-1, {onDone})
//   fadeThrough(outgoing, incoming, {onDone})
//   fade(actor, entering, {origin: {x, y}, pivot: {x, y}, onDone})
//   morphCorners(actor, radius, {spring, onDone})
//   windowProgress(p, {start, end}, spring) → [0, 1]   (pure function, rule 2 of pattern.js)
// Each one starts toward 'end' and returns a Pattern {target('start'|'end', {onDone}), stop(), finish(),
// timing(), running}. Global stop (disable()): stopAll() of animate.js.
// target(direction, {onDone}) (C, 2026-10-04): `onDone` replaces the pattern's end callback for this and
// the following segments (the same pattern serves to minimise then restore).
// Numeric parameters: PATTERNS (tokens.js) only.
// Common machinery (master travel, windows, take-over, actor ownership): pattern.js; container transform:
// container.js.

import {corners, CORNERS_EFFECT_NAME} from './corners.js';
import {PATTERNS} from './tokens.js';
import {CENTER, Pattern, _diagnosticPatterns, isMoving, opacityWindow, linear, setPivot} from './pattern.js';
import {_hiddenSources} from './container.js';

export {windowProgress} from './pattern.js';
export {containerTransform} from './container.js';

// Diagnostics for the bench: active patterns, owned actors, hidden sources.
export function _diagnostic() {
    return {..._diagnosticPatterns(), hiddenSources: _hiddenSources()};
}

// --- other patterns -------------------------------------------------------------------

// Shared axis (MaterialSharedAxis): X/Y slide of slidePx, Z scale (pivot at the centre); the outgoing
// fades on fadeOut, the incoming appears on fadeIn. direction 1 = forward (slide to the left / up, the
// incoming grows from incomingStart), -1 = back.
export function sharedAxis(outgoing, incoming, axis, direction, {onDone} = {}) {
    const A = PATTERNS.sharedAxis;
    if (direction !== 1 && direction !== -1)
        throw new Error(`unknown direction: ${direction}`);
    const alive = isMoving(incoming);
    let list;
    if (axis === 'z') {
        const {incomingStart, outgoingEnd} = A.scaleZ;
        const [inFrom, outTo] = direction > 0 ? [incomingStart, outgoingEnd] : [outgoingEnd, incomingStart];
        setPivot(outgoing, CENTER, CENTER);
        setPivot(incoming, CENTER, CENTER);
        list = [
            {actor: outgoing, to: {scale_x: outTo, scale_y: outTo}},
            {actor: incoming, from: {scale_x: inFrom, scale_y: inFrom}},
        ];
    } else if (axis === 'x' || axis === 'y') {
        const prop = `translation_${axis}`;
        const g = A.slidePx * direction;
        list = [{actor: outgoing, to: {[prop]: -g}}, {actor: incoming, from: {[prop]: g}}];
    } else {
        throw new Error(`unknown axis: ${axis}`);
    }
    const E = A.springEffects;
    const pattern = new Pattern({
        actors: [outgoing, incoming],
        driver: incoming,
        spring: A.springSpatial,
        geometry: linear(list),
        windows: {
            end: [
                opacityWindow(outgoing, 0, A.fadeOut, E),
                opacityWindow(incoming, 255, A.fadeIn, E),
            ],
            start: [
                opacityWindow(incoming, 0, A.fadeOut, E),
                opacityWindow(outgoing, 255, A.fadeIn, E),
            ],
        },
        onDone,
    });
    if (!alive)
        incoming.opacity = 0;
    return pattern.target('end');
}

// Fade through (MaterialFadeThrough): the outgoing fades on [0, outgoingShare], then the incoming
// appears on [outgoingShare, 1] growing from incomingScale.
export function fadeThrough(outgoing, incoming, {onDone} = {}) {
    const F = PATTERNS.fadeThrough;
    const before = {start: 0, end: F.outgoingShare}, after = {start: F.outgoingShare, end: 1};
    const E = F.springEffects;
    const alive = isMoving(incoming);
    setPivot(incoming, CENTER, CENTER);
    const pattern = new Pattern({
        actors: [outgoing, incoming],
        driver: incoming,
        spring: F.springSpatial,
        geometry: linear([
            {actor: outgoing},
            {actor: incoming, from: {scale_x: F.incomingScale, scale_y: F.incomingScale}},
        ]),
        windows: {
            end: [opacityWindow(outgoing, 0, before, E), opacityWindow(incoming, 255, after, E)],
            start: [opacityWindow(incoming, 0, before, E), opacityWindow(outgoing, 255, after, E)],
        },
        onDone,
    });
    if (!alive)
        incoming.opacity = 0;
    return pattern.target('end');
}

// Fade (MaterialFade). Enter: scale incomingScale → 1 from `origin` (local px, centre by default) and
// opacity on [0, fadeInEnd]; reversed, the opacity falls on the same window with the exit spring. Exit:
// opacity → 0 with springExit, without scale (exitWithoutScale); reversed, opacity → 255 with
// springEnterEffects.
// `pivot` (C, 2026-10-04): origin in normalised coordinates (0..1) of the actor, takes precedence over
// `origin`; useful when the size is not allocated yet.
export function fade(actor, entering, {origin, pivot, onDone} = {}) {
    const F = PATTERNS.fade;
    const w = actor.width, h = actor.height;
    const alive = isMoving(actor);
    if (pivot)
        setPivot(actor, pivot.x, pivot.y);
    else if (origin)
        setPivot(actor, w > 0 ? origin.x / w : 0, h > 0 ? origin.y / h : 0);
    else
        setPivot(actor, CENTER, CENTER);
    const fadeWindow = {start: 0, end: F.fadeInEnd};
    let pattern;
    if (entering) {
        pattern = new Pattern({
            actors: [actor],
            driver: actor,
            spring: F.springEnter,
            geometry: linear([{actor, from: {scale_x: F.incomingScale, scale_y: F.incomingScale}}]),
            windows: {
                end: [opacityWindow(actor, 255, fadeWindow, F.springEnterEffects)],
                start: [opacityWindow(actor, 0, fadeWindow, F.springExit)],
            },
            onDone,
        });
        if (!alive)
            actor.opacity = 0;
    } else {
        pattern = new Pattern({
            actors: [actor],
            driver: F.exitWithoutScale ? null : actor,
            spring: F.springEnter,
            geometry: F.exitWithoutScale ? null
                : linear([{actor, from: {scale_x: 1, scale_y: 1},
                    to: {scale_x: F.incomingScale, scale_y: F.incomingScale}}]),
            free: {
                end: [{actor, targets: {opacity: 0}, spring: F.springExit}],
                start: [{actor, targets: {opacity: 255}, spring: F.springEnterEffects}],
            },
            onDone,
        });
    }
    return pattern.target('end');
}

// Shape morphing: corner radius (RoundedCorners) toward `radius`, spring PATTERNS.morphCorners.spring by
// default; reversed, back to the starting radius. The corners effect (created if missing) STAYS on the
// actor after the pattern: the morphed radius is a lasting state owned by the caller (pressed button,
// active tile); it is up to the caller to remove it if wanted.
export function morphCorners(actor, radius, {spring, onDone} = {}) {
    const effect = corners(actor);
    const from = effect.radius;
    const path = `@effects.${CORNERS_EFFECT_NAME}.radius`;
    const r = spring ?? PATTERNS.morphCorners.spring;
    const pattern = new Pattern({
        actors: [actor],
        free: {
            end: [{actor, targets: {[path]: radius}, spring: r}],
            start: [{actor, targets: {[path]: from}, spring: r}],
        },
        onDone,
    });
    return pattern.target('end');
}
