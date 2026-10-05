// Ink width of the status icons. An St.Icon is square: the visible gap between two icons depended on the shape of
// each glyph (Wi-Fi almost as wide as its frame, phone half as wide). On Android every icon has its real width and
// the gap is constant. The SVGs of the m3e-gnome Material-Symbols icon theme carry the share of their frame covered
// by ink (`data-ink-width`, written by the theme's icon build); the icon takes that width while its glyph keeps its
// size, centred (the original BinLayout would shrink it to the available room).
// An icon without this datum (another theme, an extension's icon) keeps its square frame.
//
// The SVG is read asynchronously, once per file, and cached: until the read completes the icon keeps its square
// frame, then it is laid out again.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {parseInkShare} from './ink-parse.js';

export const NAME = 'ink-width';

const InkWidthLayout = GObject.registerClass(
class InkWidthLayout extends Clutter.LayoutManager {
    _init(share) {
        super._init();
        this.share = share;
    }

    vfunc_get_preferred_width(container, forHeight) {
        const [, natural] = container.get_first_child()?.get_preferred_width(forHeight) ?? [0, 0];
        const width = Math.round(natural * this.share);
        return [width, width];
    }

    vfunc_get_preferred_height(container, _forWidth) {
        return container.get_first_child()?.get_preferred_height(-1) ?? [0, 0];
    }

    vfunc_allocate(container, box) {
        for (const child of container) {
            const [, w] = child.get_preferred_width(-1);
            const [, h] = child.get_preferred_height(-1);
            const x = box.x1 + Math.round((box.get_width() - w) / 2);
            const y = box.y1 + Math.round((box.get_height() - h) / 2);
            child.allocate(new Clutter.ActorBox({x1: x, y1: y, x2: x + w, y2: y + h}));
        }
    }
});

let iconTheme = null;
let cancellable = null;
const shares = new Map();      // SVG file path -> ink share (null: no datum)
const pending = new Set();     // SVG file paths being read
const icons = new Map();       // St.Icon -> {original, ids}
const containers = new Map();  // watched actor -> handler ids
let themeChangedId = 0;

// Ink share of an icon's SVG: a number, null (no datum) or undefined (not read yet; a read is started).
function shareOf(icon) {
    const gicon = icon.gicon ?? (icon.icon_name ? new Gio.ThemedIcon({name: icon.icon_name}) : null);
    if (!gicon)
        return null;
    const path = iconTheme.lookup_by_gicon(gicon, 16, 0)?.get_filename();
    if (!path)
        return null;
    if (shares.has(path))
        return shares.get(path);
    if (!pending.has(path))
        readShare(path);
    return undefined;
}

function readShare(path) {
    pending.add(path);
    Gio.File.new_for_path(path).load_contents_async(cancellable).then(([bytes]) => {
        pending.delete(path);
        shares.set(path, parseInkShare(new TextDecoder().decode(bytes)));
        for (const icon of icons.keys())
            update(icon);
    }).catch(e => {
        pending.delete(path);
        if (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            return;
        console.error(`status-bar: cannot read icon ${path}: ${e.message}`);
        shares.set(path, null);
    });
}

function update(icon) {
    const tracked = icons.get(icon);
    const share = shareOf(icon);
    if (share === undefined)
        return;
    if (share === null) {
        if (icon.layout_manager !== tracked.original)
            icon.layout_manager = tracked.original;
    } else if (icon.layout_manager instanceof InkWidthLayout) {
        icon.layout_manager.share = share;
        icon.layout_manager.layout_changed();
    } else {
        icon.layout_manager = new InkWidthLayout(share);
    }
}

function trackIcon(icon) {
    if (icons.has(icon))
        return;
    icons.set(icon, {
        original: icon.layout_manager,
        ids: [
            icon.connect('notify::gicon', () => update(icon)),
            icon.connect('destroy', () => icons.delete(icon)),
        ],
    });
    update(icon);
}

// Walks a subtree of the right side of the panel: status icons are tracked, containers are watched for indicators
// added later (asynchronous quick settings, extensions).
function walk(actor) {
    if (actor instanceof St.Icon) {
        if (actor.has_style_class_name('system-status-icon'))
            trackIcon(actor);
        return;
    }
    if (!containers.has(actor)) {
        containers.set(actor, [
            actor.connect('child-added', (_a, child) => walk(child)),
            actor.connect('destroy', () => containers.delete(actor)),
        ]);
    }
    for (const child of actor)
        walk(child);
}

function reapply() {
    iconTheme = new St.IconTheme();
    shares.clear();
    for (const icon of icons.keys())
        update(icon);
}

export function enable() {
    cancellable = new Gio.Cancellable();
    iconTheme = new St.IconTheme();
    themeChangedId = St.TextureCache.get_default().connect('icon-theme-changed', reapply);
    walk(Main.panel._rightBox);
}

export function disable() {
    cancellable?.cancel();
    cancellable = null;
    St.TextureCache.get_default().disconnect(themeChangedId);
    themeChangedId = 0;
    for (const [actor, ids] of containers)
        ids.forEach(id => actor.disconnect(id));
    containers.clear();
    for (const [icon, {original, ids}] of icons) {
        ids.forEach(id => icon.disconnect(id));
        icon.layout_manager = original;
    }
    icons.clear();
    shares.clear();
    pending.clear();
    iconTheme = null;
}
