// Static guards on shared/m3e (the embedded toolkit): size limit, logging style, no GI in the pure modules,
// no leftover French identifiers. Reads source text only.
import Gio from 'gi://Gio';
import {assert, path, readText, run} from './harness.js';

const dir = Gio.File.new_for_path(path('../../shared/m3e'));
const files = [];
const en = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
let info;
while ((info = en.next_file(null))) {
    if (info.get_name().endsWith('.js'))
        files.push(info.get_name());
}
en.close(null);

const source = name => readText(`../../shared/m3e/${name}`);

function test_files_found() {
    assert(files.length >= 9, `expected the 9 toolkit modules, found ${files.length}`);
}

function test_size_limit() {
    for (const f of files) {
        if (f === 'tokens.js')
            continue; // generated data is exempt
        const n = source(f).split('\n').length;
        assert(n <= 500, `${f}: ${n} lines (limit 500)`);
    }
}

function test_logging_style() {
    for (const f of files) {
        const text = source(f);
        assert(!/\blogError\(/.test(text), `${f}: use console.error, not logError`);
        assert(!/(^|[^.\w])print\(/m.test(text), `${f}: use console.*, not print`);
    }
}

function test_pure_modules_have_no_gi() {
    for (const f of ['spring.js', 'curve.js', 'tokens.js'])
        assert(!source(f).includes('gi://'), `${f} must not import gi://`);
}

function test_no_accented_text_or_french_names() {
    for (const f of files) {
        const text = source(f);
        // Typographic characters used in comments (— × · ∇ π …) are fine; Latin accents are not.
        assert(!/[àâäçéèêëîïôöùûüÿœ]/i.test(text), `${f}: accented (French) text left`);
        assert(!/\b(ressort|raideur|amortissement|acteur|courbe|fenetre|motif|piste)\b/i.test(text),
            `${f}: French identifier left`);
    }
}

function test_gtype_names_are_per_copy() {
    for (const f of ['corners.js', 'pattern.js']) {
        const text = source(f);
        assert(text.includes('import.meta.url'), `${f}: GType names must derive from import.meta.url`);
    }
}

run({test_files_found, test_size_limit, test_logging_style, test_pure_modules_have_no_gi,
    test_no_accented_text_or_french_names, test_gtype_names_are_per_copy});
