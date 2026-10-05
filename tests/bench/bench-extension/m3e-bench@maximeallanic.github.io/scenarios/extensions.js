// Scenarios of the m3e-extensions extension: stylesheet loading and reloading, Dash to Dock slide and tooltips.
// Dash to Dock is a third-party extension installed system-wide; nested.sh enables it in the nested Shell only.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {SLOWDOWN, Checks, checksResult, round3, setSlowdown, wait, waitUntil} from '../tools.js';
import {underTest, extensionOf, EXTENSIONS} from './under-test.js';

const DTD = 'dash-to-dock@micxgx.gmail.com';

// Trace of read() on every painted frame for durationMs, with actions [[ms, fn(frameIndex)]] run at given instants.
async function traceWith(scene, read, durationMs, actions = []) {
    const trace = [];
    const t0 = GLib.get_monotonic_time();
    const off = scene.onEveryFrame(() => {
        trace.push({t: Math.round((GLib.get_monotonic_time() - t0) / 1000), ...read()});
        scene.stage.queue_redraw();
    });
    scene.stage.queue_redraw();
    let elapsed = 0;
    for (const [ms, action] of actions) {
        await wait(ms - elapsed);
        elapsed = ms;
        action(trace.length);
    }
    if (durationMs > elapsed)
        await wait(durationMs - elapsed);
    off();
    return trace;
}

// Largest change of a quantity between two consecutive frames, and the change at index i.
function jumps(trace, f, i) {
    let max = 0;
    for (let k = 1; k < trace.length; k++)
        max = Math.max(max, Math.abs(f(trace[k]) - f(trace[k - 1])));
    const before = [];
    for (let k = Math.max(1, i - 3); k < i; k++)
        before.push(Math.abs(f(trace[k]) - f(trace[k - 1])));
    const here = i > 0 && i < trace.length ? Math.abs(f(trace[i]) - f(trace[i - 1])) : 0;
    return {max, here, before: Math.max(0, ...before)};
}

// The first Dash to Dock dock of the nested Shell, once the extension under test has patched it.
async function dockUnderTest() {
    const dtd = Main.extensionManager.lookup(DTD);
    if (!dtd || dtd.state !== 1)
        throw new Error(`Dash to Dock is not active in the nested Shell (state ${dtd?.state})`);
    const dockModule = await underTest(EXTENSIONS, 'dock.js');
    const docking = await import(dtd.dir.get_child('docking.js').get_uri());
    const dock = await waitUntil(() => docking.DockManager.getDefault()?._allDocks?.[0], 15000);
    if (!dock)
        throw new Error('no dock');
    await waitUntil(() => dockModule.state().sliders > 0 || dockModule.state().patches.length > 0, 5000);
    Main.overview.hide();
    await wait(1000);
    return {docking, dockModule, dock};
}

async function dockSlide(scene) {
    const c = new Checks();
    const {docking, dockModule, dock} = await dockUnderTest();
    const State = docking.State;
    const proto = Object.getPrototypeOf(dock._slider);
    c.ok('slide patch installed', Object.prototype.hasOwnProperty.call(proto, 'ease_property'));
    const slider = dock._slider;
    const H = () => {
        const [, natural] = slider.child.get_preferred_height(-1);
        return natural - (slider._slideoutSize ?? 0);
    };
    const read = () => ({s: round3(slider.slide_x), ty: round3(slider.translation_y), e: dock._dockState});
    const position = p => p.s * H() - p.ty; // overshoot: negative translation_y at the bottom
    dock._animateIn(0, 0);
    await wait(300);
    setSlowdown(SLOWDOWN);
    // 1. hide: FastEffects, no overshoot, onComplete -> HIDDEN
    dock._removeAnimations();
    dock._animateOut(0.2, 0);
    const out = await traceWith(scene, read, 1500);
    c.ok('hide: never a translation', out.every(p => p.ty === 0));
    c.ok('hide: slide decreasing', out.every((p, k) => k === 0 || p.s <= out[k - 1].s + 1e-6));
    c.ok('hide: ends at 0', Math.abs(out.at(-1).s) <= 0.001, out.at(-1).s);
    c.ok('hide: onComplete (HIDDEN)', out.at(-1).e === State.HIDDEN, out.at(-1).e);
    // 2. show: DefaultSpatial, overshoot as a translation, onComplete -> SHOWN
    dock._animateIn(0.2, 0);
    const enter = await traceWith(scene, read, 2500);
    const overshoot = Math.max(...enter.map(p => -p.ty));
    c.ok('show: overshoot (translation towards the screen)', overshoot > 0.05, overshoot);
    c.ok('show: overshoot bounded (< 3 % of H)', overshoot < 0.03 * H(), overshoot);
    c.ok('show: slide bounded to [0, 1]', enter.every(p => p.s >= 0 && p.s <= 1));
    c.ok('show: ends at 1', Math.abs(enter.at(-1).s - 1) <= 0.001, enter.at(-1).s);
    c.ok('show: final translation 0', Math.abs(enter.at(-1).ty) <= 0.01, enter.at(-1).ty);
    c.ok('show: onComplete (SHOWN)', enter.at(-1).e === State.SHOWN, enter.at(-1).e);
    // 3. take-over: a hide interrupted by _removeAnimations() + _animateIn() (like _show())
    dock._removeAnimations();
    dock._animateOut(0.2, 0);
    let switchIndex = 0;
    const takeover = await traceWith(scene, read, 2500, [[250, i => {
        switchIndex = i;
        dock._removeAnimations();
        dock._animateIn(0.2, 0);
    }]]);
    const j = jumps(takeover, position, switchIndex);
    c.ok('take-over: switch in the middle of the travel', takeover[switchIndex]?.s > 0.05 && takeover[switchIndex]?.s < 0.95,
        takeover[switchIndex]?.s);
    c.ok('take-over: no position jump (<= 1.5 x previous frame + 0.5 px)', j.here <= 1.5 * j.before + 0.5, JSON.stringify(j));
    c.ok('take-over: ends at 1', Math.abs(takeover.at(-1).s - 1) <= 0.001, takeover.at(-1).s);
    c.ok('take-over: onComplete (SHOWN)', takeover.at(-1).e === State.SHOWN, takeover.at(-1).e);
    // 4. _removeAnimations() alone: stops in place, no onComplete
    dock._animateOut(0.2, 0);
    await wait(300);
    dock._removeAnimations();
    const frozen = await traceWith(scene, read, 600);
    c.ok('stops in place after remove_all_transitions', frozen.length > 2 &&
        Math.abs(frozen.at(-1).s - frozen[2].s) < 1e-6 && frozen.at(-1).s > 0 && frozen.at(-1).s < 1,
    JSON.stringify([frozen[2]?.s, frozen.at(-1)?.s]));
    c.ok('stop: onComplete not called (HIDING)', frozen.at(-1).e === State.HIDING, frozen.at(-1).e);
    setSlowdown(1);
    // 5. zero duration: immediate, onComplete called
    dock._animateIn(0, 0);
    c.ok('zero duration: set and SHOWN', slider.slide_x === 1 && dock._dockState === State.SHOWN,
        JSON.stringify([slider.slide_x, dock._dockState]));
    // 6. disable() of the extension during an animation: consistent state, patches removed
    setSlowdown(SLOWDOWN);
    dock._animateOut(0.2, 0);
    await wait(200);
    const ext = extensionOf(EXTENSIONS).stateObj;
    ext.disable();
    setSlowdown(1);
    c.ok('disable: patches removed', !Object.prototype.hasOwnProperty.call(proto, 'ease_property') &&
        !Object.prototype.hasOwnProperty.call(proto, 'remove_all_transitions'));
    c.ok('disable: segment finished (HIDDEN, slide 0, no effect)', dock._dockState === State.HIDDEN &&
        slider.slide_x === 0 && !slider.get_effect('m3e-dock') && slider.translation_y === 0,
    JSON.stringify([dock._dockState, slider.slide_x]));
    dock._animateIn(0.2, 0); // original behaviour (Clutter ease_property)
    await wait(600);
    c.ok('after disable: Dash to Dock works alone', slider.slide_x === 1 && dock._dockState === State.SHOWN,
        JSON.stringify([slider.slide_x, dock._dockState]));
    await ext.enable();
    await waitUntil(() => dockModule.state().manager, 5000);
    return checksResult(c, {traces: {out, enter, takeover, frozen}});
}

function findItem(actor) {
    if (Object.prototype.hasOwnProperty.call(Object.getPrototypeOf(actor), 'showLabel') && 'label' in actor)
        return actor;
    for (const child of actor.get_children()) {
        const found = findItem(child);
        if (found)
            return found;
    }
    return null;
}

async function dockTooltip(scene) {
    const c = new Checks();
    const {dock} = await dockUnderTest();
    const item = findItem(dock.dash);
    if (!item)
        throw new Error('no dock item');
    c.ok('tooltip patch installed', Object.prototype.hasOwnProperty.call(Object.getPrototypeOf(item), 'hideLabel'));
    item.setLabelText('Bench');
    const label = item.label;
    const read = () => ({o: label.opacity, sx: round3(label.scale_x), v: label.visible});
    setSlowdown(SLOWDOWN);
    item.showLabel();
    const shown = await traceWith(scene, read, 1500);
    c.ok('tooltip: starts at 0.8', shown[0]?.sx <= 0.85, shown[0]?.sx);
    c.ok('tooltip: scale overshoot (FastSpatial)', Math.max(...shown.map(p => p.sx)) > 1.002,
        Math.max(...shown.map(p => p.sx)));
    c.ok('tooltip: arrives (scale 1, opaque)', shown.at(-1).sx === 1 && shown.at(-1).o === 255, JSON.stringify(shown.at(-1)));
    setSlowdown(1);
    const shot = await scene.screenshot('dock-tooltip');
    setSlowdown(SLOWDOWN);
    let iB = 0;
    item.hideLabel();
    const takeover = await traceWith(scene, read, 1800, [[120, i => {
        iB = i;
        item.showLabel();
    }]]);
    const j = jumps(takeover, p => p.sx, iB);
    c.ok('tooltip: take-over without a scale jump', j.here <= 1.5 * j.before + 0.01, JSON.stringify(j));
    c.ok('tooltip: take-over without opacity back to 0', takeover[iB]?.o > 0 || takeover[iB - 1]?.o === 0,
        JSON.stringify([takeover[iB - 1]?.o, takeover[iB]?.o]));
    item.hideLabel();
    const hidden = await traceWith(scene, read, 1500);
    c.ok('tooltip: hidden at the end', hidden.at(-1).v === false, JSON.stringify(hidden.at(-1)));
    setSlowdown(1);
    const ext = extensionOf(EXTENSIONS).stateObj;
    ext.disable();
    c.ok('tooltips: patch removed', !Object.prototype.hasOwnProperty.call(Object.getPrototypeOf(item), 'hideLabel'));
    await ext.enable();
    return checksResult(c, {files: [shot], traces: {shown, takeover, hidden}});
}

// The stylesheet loader: the file lives in the nested Shell's PRIVATE config directory; the extension watches it.
async function stylesheetReload() {
    const c = new Checks();
    const sheet = await underTest(EXTENSIONS, 'stylesheet.js');
    const file = Gio.File.new_for_path(sheet.path());
    // Hard guard before writing anything: the path must be inside the PRIVATE config directory of the bench.
    const realConfig = GLib.build_filenamev([GLib.get_home_dir(), '.config']);
    const privateConfig = GLib.getenv('XDG_CONFIG_HOME');
    if (!privateConfig || privateConfig === realConfig || !sheet.path().startsWith(`${privateConfig}/`))
        throw new Error(`refusing to write outside the bench's private config directory: ${sheet.path()}`);
    c.ok('stylesheet path is inside the private config directory', sheet.path().startsWith(GLib.get_user_config_dir()) &&
        GLib.get_user_config_dir().startsWith(GLib.getenv('XDG_CONFIG_HOME')), sheet.path());
    c.ok('missing file: not loaded', !file.query_exists(null) && !sheet.isLoaded());
    const probe = new St.Widget({style_class: 'm3e-bench-probe', width: 10, height: 10});
    Main.layoutManager.uiGroup.add_child(probe);
    const colour = () => probe.get_theme_node().get_background_color().to_string();
    const write = css => {
        GLib.mkdir_with_parents(GLib.path_get_dirname(sheet.path()), 0o755);
        file.replace_contents(new TextEncoder().encode(css), null, false, Gio.FileCreateFlags.NONE, null);
    };
    write('.m3e-bench-probe { background-color: #ff0000; }\n');
    // The directory did not exist when the extension started: GIO's inotify backend rescans for missing paths
    // every few seconds (inotify-missing.c), so the first creation can be noticed up to ~4 s late.
    c.ok('created: loaded by the monitor', !!await waitUntil(() => sheet.isLoaded(), 8000));
    await wait(100);
    c.ok('created: rule applied', colour().startsWith('#ff0000'), colour());
    write('.m3e-bench-probe { background-color: #00ff00; }\n');
    c.ok('rewritten: new content read (per-file cache emptied)', !!await waitUntil(() => colour().startsWith('#00ff00'), 3000),
        colour());
    file.delete(null);
    c.ok('deleted: unloaded', !!await waitUntil(() => !sheet.isLoaded(), 3000));
    probe.destroy();
    const ext = extensionOf(EXTENSIONS).stateObj;
    write('.m3e-bench-probe { background-color: #0000ff; }\n');
    await waitUntil(() => sheet.isLoaded(), 3000);
    ext.disable();
    const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
    c.ok('disable: stylesheet unloaded', !theme.get_custom_stylesheets().some(f => f.equal(file)));
    file.delete(null);
    await ext.enable();
    return checksResult(c);
}

export const extensionScenarios = {
    'dock-slide': dockSlide,
    'dock-tooltip': dockTooltip,
    'stylesheet-reload': stylesheetReload,
};
