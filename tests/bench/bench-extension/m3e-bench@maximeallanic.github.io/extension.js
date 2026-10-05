// Bench extension: exports io.github.maximeallanic.M3eBench on the session bus of the NESTED Shell and plays the
// scenarios of scenarios/. Each scenario receives a Scene (scene.js) and returns a result object:
//   {type: 'curve', unit, singleActor, ok, detail, series: {prop: [{t_ms, elapsed_ms, value, expected}]}}
//   {type: 'state', ok, detail}
//   {type: 'checks', ok, checks: [{name, ok, detail}], lost?, duration_ms?, trace?}
// An exception becomes {type: 'error', ok: false, message, stack}.
// It must never be enabled in a real session (it is only ever installed by tests/bench/nested.sh).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Scene} from './scene.js';
import {startLogindGuard, stopLogindGuard} from './logind-guard.js';
import {SCENARIOS, NEEDS_SETTLED_SHELL} from './scenarios/index.js';

const NAME = 'io.github.maximeallanic.M3eBench';
const PATH = '/io/github/maximeallanic/M3eBench';
const XML = `
<node>
  <interface name="${NAME}">
    <method name="Run"><arg type="s" direction="in" name="scenario"/></method>
    <method name="Result"><arg type="s" direction="in" name="scenario"/><arg type="s" direction="out" name="json"/></method>
    <method name="Ping"><arg type="s" direction="out" name="reply"/></method>
  </interface>
</node>`;

export default class M3eBench extends Extension {
    enable() {
        startLogindGuard().catch(e => console.error(`m3e-bench: logind guard: ${e.message}\n${e.stack}`));
        this._results = new Map();
        this._outDir = GLib.getenv('M3E_BENCH_OUT') ?? GLib.get_tmp_dir();
        this._container = new St.Widget({name: 'm3e-bench', reactive: false});
        // Above everything, whatever the state of the overview.
        Main.layoutManager.uiGroup.add_child(this._container);
        Main.layoutManager.uiGroup.set_child_above_sibling(this._container, null);
        this._scene = new Scene({container: this._container, outDir: this._outDir, extensionPath: this.path});
        const themeCss = GLib.getenv('M3E_BENCH_THEME_CSS');
        this._themeFile = null;
        if (themeCss) {
            this._themeFile = Gio.File.new_for_path(themeCss);
            St.ThemeContext.get_for_stage(global.stage).get_theme().load_stylesheet(this._themeFile);
        }
        this._exported = Gio.DBusExportedObject.wrapJSObject(XML, this);
        this._exported.export(Gio.DBus.session, PATH);
        // The name is only owned once the Shell has started and the scene is shown: before that the actors are
        // not mapped (transitions do not advance) and the start-up animation disturbs the measurements.
        const own = () => {
            if (this._ownerId || !this._exported)
                return;
            this._ownerId = Gio.bus_own_name_on_connection(Gio.DBus.session, NAME, Gio.BusNameOwnerFlags.NONE, null, null);
        };
        if (!Main.layoutManager._startingUp && global.stage.mapped)
            own();
        else
            this._startupId = Main.layoutManager.connect('startup-complete', own);
    }

    disable() {
        stopLogindGuard();
        if (this._startupId)
            Main.layoutManager.disconnect(this._startupId);
        this._startupId = 0;
        if (this._ownerId)
            Gio.bus_unown_name(this._ownerId);
        this._ownerId = 0;
        this._exported?.unexport();
        this._exported = null;
        this._scene?.dispose();
        this._scene = null;
        if (this._themeFile) {
            St.ThemeContext.get_for_stage(global.stage).get_theme().unload_stylesheet(this._themeFile);
            this._themeFile = null;
        }
        this._container?.destroy();
        this._container = null;
        this._results = null;
    }

    Ping() {
        return 'pong';
    }

    Run(name) {
        const scenario = SCENARIOS[name];
        if (!scenario) {
            this._results.set(name, JSON.stringify({type: 'error', ok: false, message: `unknown scenario: ${name}`}));
            return;
        }
        this._results.delete(name);
        const start = GLib.get_monotonic_time();
        const run = async () => {
            if (NEEDS_SETTLED_SHELL.has(name))
                await this._scene.prepare();
            return scenario(this._scene);
        };
        // After disable() (_results = null), a scenario that finishes does nothing.
        run().then(
            r => this._results?.set(name, JSON.stringify({
                ...r, scenario: name, duration_scenario_ms: Math.round((GLib.get_monotonic_time() - start) / 1000)})),
            e => this._results?.set(name, JSON.stringify({type: 'error', ok: false, message: `${e}`,
                stack: `${e?.stack ?? ''}`})))
            .finally(() => {
                St.Settings.get().slow_down_factor = 1;
                this._scene?.killClients();
            });
    }

    Result(name) {
        return this._results?.get(name) ?? '';
    }
}
