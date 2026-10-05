// gjs -m tests/unit/extensions/test_ink_parse.js
import {parseInkShare} from '../../../extensions/status-bar@maximeallanic.github.io/ink-parse.js';
import {ok, near, done} from './tap.js';

ok(near(parseInkShare('<svg data-ink-width="0.458"><path/></svg>'), 0.458), 'reads the attribute');
ok(near(parseInkShare('<svg\n  width="16" data-ink-width="1"></svg>'), 1), 'full frame');
ok(parseInkShare('<svg width="16"></svg>') === null, 'no datum: null');
ok(parseInkShare('<svg data-ink-width="0"></svg>') === null, 'zero rejected');
ok(parseInkShare('<svg data-ink-width="3.5"></svg>') === null, 'above 1 rejected');
ok(parseInkShare('<svg data-ink-width="."></svg>') === null, 'garbage rejected');
ok(parseInkShare('') === null, 'empty file');
done();
