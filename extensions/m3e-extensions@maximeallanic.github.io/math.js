// Pure calculations (no gi:// import), tested by tests/unit/extensions/test_dock_math.js.
//
// A "position" is a quantity in logical px driven by a spring of the m3e toolkit (visibility threshold 0.5 px):
//   0 = hidden, distance = shown; beyond the distance = overshoot of the Spatial spring.

// Dock (Dash to Dock): DashSlideContainer's slide-x is clamped to [0, 1] (GParamSpec); the overshoot becomes a
// translation towards the inside of the screen, along the slide axis.
export function dockSlide(position, distance) {
    const d = distance > 0 ? distance : 1;
    const p = Number.isFinite(position) ? position : 0;
    return {slide: Math.min(1, Math.max(0, p / d)), overshoot: Math.max(0, p - d)};
}

// Translation (x, y) carrying the overshoot towards the inside of the screen for a dock on `side`
// ('top' | 'bottom' | 'left' | 'right').
export function overshootTranslation(side, overshoot) {
    switch (side) {
    case 'bottom': return {x: 0, y: -overshoot};
    case 'top': return {x: 0, y: overshoot};
    case 'left': return {x: overshoot, y: 0};
    case 'right': return {x: -overshoot, y: 0};
    default: return {x: 0, y: 0};
    }
}

// Current position read back from the actor (inverse of dockSlide).
export function dockPosition(slide, overshoot, distance) {
    return slide * (distance > 0 ? distance : 1) + Math.max(0, overshoot);
}
