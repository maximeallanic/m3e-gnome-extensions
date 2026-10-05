// Colour blending in Oklab, like Compose's ColorVectorConverter (animateColorAsState): sRGB -> linear -> Oklab,
// linear interpolation of the components and of the alpha (not premultiplied), back to clamped sRGB.
// Formulas by Björn Ottosson (https://bottosson.github.io/posts/oklab/), the ones used by Compose (ColorSpaces.Oklab).
// Pure module (no GI import): colours are any objects with 0-255 `red`, `green`, `blue`, `alpha` fields
// (Clutter.Color / Cogl.Color from a theme node), and the result is a plain object with the same fields.

const toLinear = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = c => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function toOklab({red, green, blue}) {
    const [r, g, b] = [red, green, blue].map(v => toLinear(v / 255));
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ];
}

function fromOklab([L, A, B]) {
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const s = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3;
    return [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    ].map(v => Math.round(255 * Math.min(1, Math.max(0, toSrgb(Math.max(0, v))))));
}

// Colour at progress p (0: `from`, 1: `to`; clamped to [0, 1]). Both ends are returned as is.
export function blendOklab(from, to, p) {
    const q = Math.min(1, Math.max(0, p));
    if (q === 0)
        return from;
    if (q === 1)
        return to;
    const a = toOklab(from), b = toOklab(to);
    const [red, green, blue] = fromOklab(a.map((v, i) => v + (b[i] - v) * q));
    const alpha = Math.round(from.alpha + (to.alpha - from.alpha) * q);
    return {red, green, blue, alpha};
}
