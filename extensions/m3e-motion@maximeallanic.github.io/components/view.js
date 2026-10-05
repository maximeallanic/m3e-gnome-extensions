// Top bar and dock backgrounds while the overview enters and leaves. Their background is translucent (the theme's
// surface_container at 85 %, no blur): on the first instant of the overview the desktop shrinks and the wallpaper seen
// through them is replaced at once by the overview background, so the transparency "vanishes" without a transition.
// Here the bar and dock backgrounds follow the overview progress (the Shell's state adjustment, so the three-finger
// gesture and its return too): from their resting theme opacity to transparent in the overview (a floating bar over
// the overview background, like Android's status bar on the home screen), and back on exit. No duration of its own:
// the motion is the overview's.
//   bar  : inline style on #panel (theme colour read at rest, without St's transition);
//   dock : opacity of Dash to Dock's background actor (.dash-background, its colour is !important in the theme).
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export const NAME = 'view';

const DOCK_CONTAINER_NAME = 'dashtodockContainer';
const DOCK_BACKGROUND_CLASS = 'dash-background';

let adjustment = null;
let valueId = 0;
let barColor = null; // theme colour at rest, read again when the progress leaves 0
let dockBackgrounds = new Map(); // actor -> {opacity, destroyId}

function collect(actor, predicate, result = []) {
    if (predicate(actor))
        result.push(actor);
    for (const child of actor.get_children())
        collect(child, predicate, result);
    return result;
}

function trackDockBackgrounds() {
    const docks = collect(Main.layoutManager.uiGroup, a => a.name === DOCK_CONTAINER_NAME);
    for (const actor of docks.flatMap(d => collect(d, a => a.has_style_class_name?.(DOCK_BACKGROUND_CLASS)))) {
        // Dash to Dock may recreate its docks while the overview is open: forget destroyed backgrounds.
        const destroyId = actor.connect('destroy', () => dockBackgrounds.delete(actor));
        dockBackgrounds.set(actor, {opacity: actor.opacity, destroyId});
    }
}

function toRest() {
    Main.panel.set_style(null);
    for (const [actor, {opacity, destroyId}] of dockBackgrounds) {
        actor.disconnect(destroyId);
        actor.opacity = opacity;
    }
    barColor = null;
    dockBackgrounds = new Map();
}

function follow() {
    const p = Math.min(1, Math.max(0, adjustment.value));
    if (p === 0) {
        toRest();
        return;
    }
    if (!barColor) {
        Main.panel.set_style(null);
        barColor = Main.panel.get_theme_node().get_background_color();
        trackDockBackgrounds();
    }
    const {red, green, blue, alpha} = barColor;
    const a = (alpha / 255) * (1 - p);
    // transition-duration 0: otherwise St would fade every frame over 250 ms (#panel of the stock stylesheet).
    Main.panel.set_style(`background-color: rgba(${red}, ${green}, ${blue}, ${a.toFixed(3)}); transition-duration: 0ms;`);
    for (const [actor, {opacity}] of dockBackgrounds)
        actor.opacity = Math.round(opacity * (1 - p));
}

export function enable() {
    adjustment = Main.overview._overview.controls._stateAdjustment;
    valueId = adjustment.connect('notify::value', follow);
    follow();
}

export function disable() {
    if (adjustment && valueId)
        adjustment.disconnect(valueId);
    adjustment = null;
    valueId = 0;
    toRest();
}
