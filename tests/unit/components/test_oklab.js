// gjs -m tests/unit/components/test_oklab.js
import System from 'system';
import {blendOklab} from '../../../extensions/m3e-motion@maximeallanic.github.io/components/oklab.js';

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
const c = (red, green, blue, alpha = 255) => ({red, green, blue, alpha});
const same = (a, b) => a.red === b.red && a.green === b.green && a.blue === b.blue && a.alpha === b.alpha;

const black = c(0, 0, 0), white = c(255, 255, 255);
ok(blendOklab(black, white, 0) === black, 'p = 0 returns the start colour object');
ok(blendOklab(black, white, 1) === white, 'p = 1 returns the end colour object');
ok(blendOklab(black, white, -3) === black, 'p below 0 is clamped');
ok(blendOklab(black, white, 7) === white, 'p above 1 is clamped');

// Oklab lightness 0.5 with no chroma = linear 0.125 = sRGB 99 (differs from the sRGB midpoint 128).
const mid = blendOklab(black, white, 0.5);
ok(mid.red === 99 && mid.green === 99 && mid.blue === 99, `black-white midpoint is sRGB 99 (got ${mid.red})`);

ok(same(blendOklab(c(10, 200, 30, 40), c(10, 200, 30, 40), 0.37), c(10, 200, 30, 40)), 'identical colours stay identical');

const a = blendOklab(c(1, 2, 3, 0), c(1, 2, 3, 255), 0.5);
ok(a.alpha === 128, 'alpha is interpolated linearly, not premultiplied');

const red = c(255, 0, 0), blue = c(0, 0, 255);
let prev = -1, monotonic = true;
for (let i = 0; i <= 10; i++) {
    const v = blendOklab(red, blue, i / 10);
    if (v.blue < prev)
        monotonic = false;
    prev = v.blue;
}
ok(monotonic, 'blue channel is non-decreasing from red to blue');

const out = blendOklab(c(0, 255, 0), c(255, 0, 255), 0.5);
ok([out.red, out.green, out.blue].every(v => Number.isInteger(v) && v >= 0 && v <= 255), 'channels are integers in [0, 255]');

print(`1..${n}`);
if (failures)
    System.exit(1);
