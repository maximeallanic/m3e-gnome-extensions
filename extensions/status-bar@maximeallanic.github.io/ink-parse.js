// Pure helper (no gi:// import, unit-tested): reads the share of the icon frame covered by ink from a symbolic
// SVG written by the m3e-gnome icon theme build (attribute `data-ink-width` on the root element, e.g. "0.458").
// Returns a number in (0, 1], or null when the file carries no such datum.
export function parseInkShare(svgText) {
    const match = /data-ink-width="([\d.]+)"/.exec(svgText);
    if (!match)
        return null;
    const share = parseFloat(match[1]);
    return share > 0 && share <= 1 ? share : null;
}
