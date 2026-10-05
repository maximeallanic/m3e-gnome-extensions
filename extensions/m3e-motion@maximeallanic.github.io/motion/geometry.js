// Pure arithmetic of the motion modules (no GI import, unit-tested headless).

export const mix = (a, b, u) => a + (b - a) * u;

export const clamp01 = v => Math.min(1, Math.max(0, v));

// Fraction of [a, b] covered by p, clamped to [0, 1] (a window of a progress).
export const windowFraction = (p, a, b) => clamp01((p - a) / (b - a));

// Fraction of the way from `from` to `to` covered by `v`, clamped to [0, 1]; 1 when the travel is under half a pixel
// (nothing to wait for).
export const travelProgress = (v, from, to) => (Math.abs(to - from) < 0.5 ? 1 : clamp01((v - from) / (to - from)));

// Content scale and clip rectangle (local to the actor, logical px) of a window shrinking toward an icon.
//   frame {x, y, w, h}: content frame of the window (its zone, local px);
//   icon {w, h}: icon size; s: shrink progress 0 (window) .. 1 (icon).
// The content covers the rectangle (scale = max of the two axis ratios), then is cropped to it, centered.
export function shrinkFrame(frame, icon, s) {
    const w = mix(frame.w, icon.w, s), h = mix(frame.h, icon.h, s);
    const k = Math.max(w / frame.w, h / frame.h);
    return {
        scale: k,
        left: frame.x + frame.w / 2 - w / k / 2,
        top: frame.y + frame.h / 2 - h / k / 2,
        width: w / k,
        height: h / k,
    };
}

// Initial shrink progress of a window displayed with width `shownWidth`, so that a window already partly shrunk
// resumes where it is (0 when the icon is not narrower than the window).
export function initialShrink(frameWidth, iconWidth, shownWidth) {
    return frameWidth > iconWidth ? clamp01((frameWidth - shownWidth) / (frameWidth - iconWidth)) : 0;
}
