// Static guards over the two extensions' sources (gjs -m tests/unit/extensions/test_static_guards.js).
// Source-level rules of the extensions.gnome.org review and of the repository (English-only code).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {ok, done} from './tap.js';

const ROOT = GLib.build_filenamev([GLib.path_get_dirname(import.meta.url.replace('file://', '')), '..', '..', '..']);
const UUIDS = ['status-bar@maximeallanic.github.io', 'm3e-extensions@maximeallanic.github.io'];
const decoder = new TextDecoder();

const read = path => decoder.decode(GLib.file_get_contents(path)[1]);

function listFiles(dir, suffix) {
    const found = [];
    const enumerator = Gio.File.new_for_path(dir).enumerate_children('standard::name,standard::type', 0, null);
    for (let info = enumerator.next_file(null); info; info = enumerator.next_file(null)) {
        const path = GLib.build_filenamev([dir, info.get_name()]);
        if (info.get_name() === 'm3e')
            continue; // embedded copy of shared/m3e, covered by its own tests
        if (info.get_file_type() === Gio.FileType.DIRECTORY)
            found.push(...listFiles(path, suffix));
        else if (info.get_name().endsWith(suffix))
            found.push(path);
    }
    return found;
}

for (const uuid of UUIDS) {
    const dir = GLib.build_filenamev([ROOT, 'extensions', uuid]);
    const files = listFiles(dir, '.js');
    const sources = files.map(f => [f, read(f)]);
    const name = f => f.slice(dir.length + 1);

    const meta = JSON.parse(read(GLib.build_filenamev([dir, 'metadata.json'])));
    ok(meta.uuid === uuid, `${uuid}: metadata uuid matches directory`);
    ok(meta.name && meta.description && meta.url?.startsWith('https://github.com/'), `${uuid}: name, description, url`);
    ok(JSON.stringify(meta['shell-version']) === '["50"]', `${uuid}: shell-version is ["50"]`);
    ok(!('session-modes' in meta), `${uuid}: session-modes omitted (user only)`);
    ok(Number.isInteger(meta.version) && meta['version-name'], `${uuid}: version and version-name`);

    const main = read(GLib.build_filenamev([dir, 'extension.js']));
    ok(/\benable\(\)/.test(main) && /\bdisable\(\)/.test(main), `${uuid}: extension.js has enable() and disable()`);

    for (const [f, text] of sources) {
        const n = `${uuid}/${name(f)}`;
        const hasEnable = /^export function enable\(/m.test(text);
        ok(!hasEnable || /^export function disable\(/m.test(text), `${n}: enable() has a matching disable()`);
        ok(!/\bprint(err)?\(/.test(text), `${n}: no print()`);
        ok(!/\blogError\(/.test(text), `${n}: no logError()`);
        ok(!/[àâçéèêëîïôùûüÿœÀÉÈÊ]/.test(text), `${n}: no accented (non-English) text`);
        ok(!/\/home\/|~\/|\bmallanic\b/.test(text.replace(/\/\/.*$/gm, '')), `${n}: no hardcoded home path or owner name`);
        ok(!/Mainloop|ByteArray|imports\./.test(text), `${n}: no deprecated modules`);
        ok(!/Gio\.Subprocess|GLib\.spawn/.test(text), `${n}: no subprocess`);
        ok(!/GLib\.file_get_contents/.test(text), `${n}: no synchronous file read`);
        ok(text.split('\n').length < 500, `${n}: under 500 lines`);
        ok(!/margin[-_a-z]*:\s*-\d/.test(text), `${n}: no negative margin`);
    }
}
done();
