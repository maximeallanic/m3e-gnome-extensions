// The `ctx` object every scenario receives: frame clock, sampling, tracing, screenshots, client windows.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {lostFrames, round3, setSlowdown, wait, waitUntil} from './tools.js';

export class Scene {
    constructor({container, outDir, extensionPath}) {
        this.stage = global.stage;
        this.container = container;
        this.outDir = outDir;
        this._extensionPath = extensionPath;
        this._handlers = new Set(); // live 'after-paint' handlers, all disconnected by dispose()
        this._clients = [];
    }

    dispose() {
        for (const id of this._handlers)
            this.stage.disconnect(id);
        this._handlers.clear();
        this.killClients();
    }

    // Calls `callback` on every painted frame; returns the function that disconnects it.
    onEveryFrame(callback) {
        const id = this.stage.connect('after-paint', callback);
        this._handlers.add(id);
        return () => {
            if (this._handlers.delete(id))
                this.stage.disconnect(id);
        };
    }

    // Resolves after n painted frames.
    waitFrames(n) {
        return new Promise((resolve, reject) => {
            let left = n;
            const off = this.onEveryFrame(() => {
                try {
                    if (--left <= 0) {
                        off();
                        resolve();
                    }
                } catch (e) {
                    off();
                    reject(e);
                }
            });
        });
    }

    // Samples t_ms, elapsed_ms (supplied by the scenario) and the requested actor properties on every painted
    // frame until `until` settles. Disconnected on every path: `until` resolved or rejected, exception while
    // sampling, or dispose().
    sample(actor, props, {elapsed, until}) {
        return new Promise((resolve, reject) => {
            const samples = [];
            let error = null;
            const off = this.onEveryFrame(() => {
                if (error)
                    return;
                try {
                    const values = {};
                    for (const p of props)
                        values[p] = actor[p];
                    samples.push({t_ms: GLib.get_monotonic_time() / 1000, elapsed_ms: elapsed ? elapsed() : null, values});
                } catch (e) {
                    error = e;
                    off();
                }
            });
            until.then(() => {
                off();
                if (error)
                    reject(error);
                else
                    resolve(samples);
            }, e => {
                off();
                reject(e);
            });
        });
    }

    screenshot(name) {
        const path = `${this.outDir}/${name}.png`;
        const shot = new Shell.Screenshot();
        const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.NONE, null);
        return new Promise((resolve, reject) => {
            shot.screenshot(false, stream, (o, res) => {
                try {
                    o.screenshot_finish(res);
                    stream.close(null);
                    resolve(`${name}.png`);
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    // Per-frame trace of read() for durationMs (real time), screenshots at the instants {ms: name}.
    async trace(read, durationMs, captures = {}) {
        const trace = [];
        const t0 = GLib.get_monotonic_time();
        const off = this.onEveryFrame(() => {
            let v;
            try {
                v = read();
            } catch (e) {
                v = {error: `${e}`};
            }
            trace.push({t: Math.round((GLib.get_monotonic_time() - t0) / 100) / 10, ...v});
            this.stage.queue_redraw();
        });
        this.stage.queue_redraw();
        const files = [];
        let elapsed = 0;
        for (const [ms, name] of Object.entries(captures).sort((a, b) => a[0] - b[0])) {
            await wait(Number(ms) - elapsed);
            files.push(await this.screenshot(name));
            elapsed = Math.round((GLib.get_monotonic_time() - t0) / 1000);
        }
        if (durationMs > elapsed)
            await wait(durationMs - elapsed);
        off();
        return {trace, files, lost: lostFrames(trace), duration_ms: durationMs};
    }

    // Puts the Shell back in a known state before a window scenario: no slow-down, overview closed, workspace 0.
    async prepare() {
        setSlowdown(1);
        if (Main.overview.visible) {
            Main.overview.hide();
            await waitUntil(() => !Main.overview.visible && !Main.overview._animationInProgress, 5000);
        }
        const ws0 = global.workspace_manager.get_workspace_by_index(0);
        if (!ws0.active) {
            ws0.activate(global.get_current_time());
            await waitUntil(() => !Main.wm._workspaceAnimation._switchData, 3000);
        }
        await wait(200);
    }

    _socket() {
        const run = GLib.getenv('XDG_RUNTIME_DIR');
        if (!run || run.startsWith('/run/user/'))
            throw new Error(`XDG_RUNTIME_DIR is not private: ${run}`);
        const enumerator = Gio.File.new_for_path(run).enumerate_children('standard::name', 0, null);
        let socket = null;
        for (let info; (info = enumerator.next_file(null));) {
            if (/^m3e-bench-\d+$/.test(info.get_name()))
                socket = info.get_name();
        }
        if (!socket)
            throw new Error('Wayland socket of the nested Shell not found');
        return {run, socket};
    }

    // Starts client-window.js (GTK 4) against the nested Shell only. Returns {windows: [MetaWindow...]
    // (filled as they are created), sub}.
    launchClient(mode, title) {
        const {run, socket} = this._socket();
        const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_SILENCE |
            Gio.SubprocessFlags.STDERR_SILENCE});
        launcher.setenv('XDG_RUNTIME_DIR', run, true);
        launcher.setenv('WAYLAND_DISPLAY', socket, true);
        launcher.setenv('GDK_BACKEND', 'wayland', true);
        launcher.setenv('GSK_RENDERER', 'cairo', true);
        launcher.setenv('GTK_A11Y', 'none', true);
        launcher.unsetenv('DISPLAY');
        const client = {windows: [], sub: null};
        const id = global.display.connect('window-created', (d, w) => {
            if (client.sub && `${w.get_pid()}` === client.sub.get_identifier())
                client.windows.push(w);
        });
        client.sub = launcher.spawnv(['gjs', `${this._extensionPath}/client-window.js`, mode, title]);
        client.disconnect = () => global.display.disconnect(id);
        this._clients.push(client);
        return client;
    }

    killClients() {
        for (const c of this._clients) {
            c.disconnect();
            // Only the client this bench started (by its subprocess handle), never anything else; a no-op when
            // it has already exited.
            c.sub.force_exit();
        }
        this._clients = [];
    }
}

export {round3};
