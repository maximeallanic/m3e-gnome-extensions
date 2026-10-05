// Tiny TAP harness shared by the gjs unit tests (plain GJS, headless: no window, no Shell).
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GIRepository from 'gi://GIRepository?version=3.0';
import System from 'system';

const here = Gio.File.new_for_uri(import.meta.url).get_parent();

// Absolute path of a file relative to tests/unit/.
export const path = relative => here.resolve_relative_path(relative).get_path();

export const readText = relative =>
    new TextDecoder().decode(GLib.file_get_contents(path(relative))[1]);

// Most recent mutter-<n> directory (multiarch or not), then the Shell's own. Needed only by modules that
// import gi://Clutter or gi://St; no actor and no clock is ever created by these tests.
function mutterDirectory() {
    const found = [];
    for (const base of ['/usr/lib/x86_64-linux-gnu', '/usr/lib/aarch64-linux-gnu', '/usr/lib64', '/usr/lib']) {
        let enumerator;
        try {
            enumerator = Gio.File.new_for_path(base).enumerate_children('standard::name',
                Gio.FileQueryInfoFlags.NONE, null);
        } catch {
            continue;
        }
        let info;
        while ((info = enumerator.next_file(null))) {
            const m = /^mutter-(\d+)$/.exec(info.get_name());
            if (m)
                found.push({n: Number(m[1]), path: `${base}/${info.get_name()}`});
        }
        enumerator.close(null);
    }
    found.sort((a, b) => b.n - a.n);
    if (!found.length)
        throw new Error('no mutter-* directory found (install the mutter typelibs)');
    return found[0].path;
}

export function addShellTypelibPaths() {
    const repository = GIRepository.Repository.dup_default();
    for (const dir of [mutterDirectory(), '/usr/lib/gnome-shell']) {
        repository.prepend_search_path(dir);
        repository.prepend_library_path(dir);
    }
}

let failures = 0;
let count = 0;

export function assert(condition, message) {
    if (!condition) {
        failures++;
        print(`  FAIL: ${message}`);
    }
}

// Runs the named tests, prints TAP and exits non-zero on any failure.
export function run(tests) {
    for (const [name, fn] of Object.entries(tests)) {
        const before = failures;
        try {
            fn();
        } catch (e) {
            failures++;
            print(`  FAIL: ${name} threw ${e}`);
        }
        count++;
        print(`${failures === before ? 'ok' : 'not ok'} ${count} - ${name}`);
    }
    print(`1..${count}`);
    if (failures > 0) {
        print(`${failures} failure(s)`);
        System.exit(1);
    }
}
