// Static guards for extensions/m3e-motion components and extension.js (gjs -m ...).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

const root = GLib.build_filenamev([GLib.path_get_dirname(import.meta.url.replace('file://', '')), '..', '..', '..',
    'extensions', 'm3e-motion@maximeallanic.github.io']);
let n = 0, failures = 0;
function ok(cond, name) {
    n++;
    if (cond) {
        print(`ok ${n} - ${name}`);
    } else {
        failures++;
        print(`not ok ${n} - ${name}`);
    }
}
const read = path => new TextDecoder().decode(GLib.file_get_contents(path)[1]);

const files = [GLib.build_filenamev([root, 'extension.js'])];
const dir = Gio.File.new_for_path(GLib.build_filenamev([root, 'components']));
for (const info of dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null))
    files.push(GLib.build_filenamev([root, 'components', info.get_name()]));

for (const file of files) {
    const text = read(file);
    const name = file.slice(root.length + 1);
    ok(text.split('\n').length < 500, `${name}: under 500 lines`);
    ok(!/[àâçéèêëîïôùûüÿœÀÉÈ]/.test(text.replace(/Björn/g, '')), `${name}: no accented Latin letters (English only)`);
    ok(!/\bprint\(|logError\(/.test(text), `${name}: logs through console.error`);
    ok(!/margin[a-z-]*\s*:\s*-/.test(text), `${name}: no negative margin in inline styles`);
    ok(!/\/home\/|mallanic|m3e-widgets/.test(text), `${name}: no personal path or retired extension`);
    ok(!/GLib\.file_get_contents|Gio\.Subprocess|GLib\.spawn/.test(text), `${name}: no sync IO or subprocess`);
    const enables = (text.match(/^export function enable\(/gm) ?? []).length;
    const disables = (text.match(/^export function disable\(/gm) ?? []).length;
    if (name.startsWith('components/') && !name.endsWith('oklab.js') && !name.endsWith('panel-shade.js'))
        ok(enables === 1 && disables === 1, `${name}: exports enable() and disable()`);
}

const meta = JSON.parse(read(GLib.build_filenamev([root, 'metadata.json'])));
ok(meta.uuid === 'm3e-motion@maximeallanic.github.io', 'metadata: uuid');
ok(JSON.stringify(meta['shell-version']) === '["50"]', 'metadata: shell-version');
ok(typeof meta.url === 'string' && meta.url.startsWith('https://github.com/'), 'metadata: url');
ok(meta['gettext-domain'] === 'm3e-motion', 'metadata: gettext-domain');
ok(!('session-modes' in meta) || !meta['session-modes'].includes('unlock-dialog'), 'metadata: no unlock-dialog');

print(`1..${n}`);
if (failures)
    System.exit(1);
