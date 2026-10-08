// Overview search results shown as a list: the Shell wraps the matched terms of the description in <b>
// (misc/util.js, Highlighter). Pango markup wins over the stylesheet's `font-weight: normal`, so the theme's
// "no bold anywhere" rule did not apply there. The term stays highlighted, but by colour: the colour of the result
// title (on_surface), stronger than the description's (on_surface_variant), read from the theme on every render.
import * as Search from 'resource:///org/gnome/shell/ui/search.js';

export const NAME = 'search';

let original = null;

function hex(c) {
    return `#${[c.red, c.green, c.blue].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

// Matched terms in the title colour. The title only has its style once it is on the stage (before that its colour
// is the default, black): the markup is first set without a colour, then recoloured on every `style-changed` of the
// title (theme resolved, palette changed).
function colorize(result) {
    const title = result.label_actor;
    if (!original || !title.get_stage())
        return;
    const color = hex(title.get_theme_node().get_foreground_color());
    result._descriptionLabel.clutter_text.set_markup(result._m3eTerms.replaceAll('<b>',
        `<span weight="normal" foreground="${color}">`).replaceAll('</b>', '</span>'));
}

export function enable() {
    const proto = Search.ListSearchResult.prototype;
    original = proto._highlightTerms;
    // Same computation as the original (search.js, ListSearchResult._highlightTerms), with the <b> tag replaced.
    proto._highlightTerms = function () {
        this._m3eTerms = this._resultsView.highlightTerms(this.metaInfo['description'].split('\n')[0]);
        this._descriptionLabel.clutter_text.set_markup(this._m3eTerms.replaceAll('<b>', '<span weight="normal">')
            .replaceAll('</b>', '</span>'));
        this._m3eStyleId ??= this.label_actor.connect('style-changed', () => colorize(this));
        colorize(this);
    };
}

export function disable() {
    if (original)
        Search.ListSearchResult.prototype._highlightTerms = original;
    original = null;
}
