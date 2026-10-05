// Static checks of extensions/m3e-motion@.../motion/*.js (gjs -m tests/unit/motion/test_motion_static.js):
//   - every module of the module list exports NAME, enable() and disable();
//   - every named import from a relative module (motion/*, ../m3e/*) resolves to a real export;
//   - the source rules of the repository: English only, no print()/logError(), size limit, no hardcoded home path.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {ok, done} from './tap.js';

const ROOT = GLib.build_filenamev([GLib.path_get_dirname(import.meta.url.replace('file://', '')), '..', '..', '..']);
const EXT = GLib.build_filenamev([ROOT, 'extensions', 'm3e-motion@maximeallanic.github.io']);
const SHARED = GLib.build_filenamev([ROOT, 'shared', 'm3e']);
const decoder = new TextDecoder();
const read = path => decoder.decode(GLib.file_get_contents(path)[1]);

function jsFiles(dir) {
    const out = [];
    const e = Gio.File.new_for_path(dir).enumerate_children('standard::name', 0, null);
    for (let i = e.next_file(null); i; i = e.next_file(null)) {
        if (i.get_name().endsWith('.js'))
            out.push(GLib.build_filenamev([dir, i.get_name()]));
    }
    return out.sort();
}

// Names exported by a module's source: declarations, `export {a, b as c}` lists, re-exports.
function exportsOf(text) {
    const names = new Set();
    for (const m of text.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z0-9_$]+)/gm))
        names.add(m[1]);
    for (const m of text.matchAll(/^export\s*\{([^}]*)\}/gm)) {
        for (const part of m[1].split(','))
            names.add(part.trim().split(/\s+as\s+/).pop().trim());
    }
    return names;
}

const motionDir = GLib.build_filenamev([EXT, 'motion']);
const files = jsFiles(motionDir);
const cache = new Map();
const exportsFor = path => {
    if (!cache.has(path))
        cache.set(path, exportsOf(read(path)));
    return cache.get(path);
};

const MODULES = ['gestures', 'windows', 'workspaces', 'overview', 'surfaces', 'system', 'notifications'];
for (const name of MODULES) {
    const text = read(GLib.build_filenamev([motionDir, `${name}.js`]));
    ok(/^export const NAME = '/m.test(text), `${name}: exports NAME`);
    ok(/^export function enable\(\)/m.test(text), `${name}: exports enable()`);
    ok(/^export function disable\(\)/m.test(text), `${name}: exports disable()`);
}

for (const file of files) {
    const base = file.slice(motionDir.length + 1);
    const text = read(file);
    for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(\.{1,2}\/[^']+)'/g)) {
        const target = GLib.build_filenamev([motionDir, m[2]]);
        // Resolve ../m3e/x.js against the repo's shared toolkit (the extension's m3e/ is a build copy of it).
        const real = m[2].startsWith('../m3e/') ? GLib.build_filenamev([SHARED, m[2].slice('../m3e/'.length)]) : target;
        if (!GLib.file_test(real, GLib.FileTest.EXISTS)) {
            ok(false, `${base}: import ${m[2]} exists`);
            continue;
        }
        const available = exportsFor(real);
        for (const part of m[1].split(',')) {
            const name = part.trim().split(/\s+as\s+/)[0].trim();
            if (name)
                ok(available.has(name), `${base}: ${m[2]} exports ${name}`);
        }
    }
    ok(!/[àâçéèêëîïôùûüÿœÀÉÈÊ]/.test(text), `${base}: English only (no accented letters)`);
    ok(!/\bprint(err)?\(/.test(text) && !/\blogError\(/.test(text), `${base}: no print()/logError()`);
    ok(text.split('\n').length <= 500, `${base}: at most 500 lines`);
    ok(!/\/home\/|~\/\./.test(text), `${base}: no hardcoded home path`);
}
done();
