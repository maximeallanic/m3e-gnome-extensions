// gjs -m tests/unit/motion/test_geometry.js
import {ok, near, done} from './tap.js';
import {mix, clamp01, windowFraction, travelProgress, shrinkFrame, initialShrink} from
    '../../../extensions/m3e-motion@maximeallanic.github.io/motion/geometry.js';

ok(mix(2, 10, 0) === 2 && mix(2, 10, 1) === 10 && near(mix(2, 10, 0.25), 4), 'mix endpoints and middle');
ok(clamp01(-1) === 0 && clamp01(2) === 1 && clamp01(0.3) === 0.3, 'clamp01');

ok(windowFraction(0.5, 0.35, 1) > 0 && windowFraction(0.5, 0.35, 1) < 1, 'windowFraction inside the window');
ok(windowFraction(0.2, 0.35, 1) === 0, 'windowFraction before the window');
ok(windowFraction(1.5, 0.35, 1) === 1, 'windowFraction after the window');
ok(near(windowFraction(0.675, 0.35, 1), 0.5), 'windowFraction middle of [0.35, 1]');

ok(travelProgress(5, 0, 10) === 0.5, 'travelProgress halfway');
ok(travelProgress(-3, 0, 10) === 0 && travelProgress(30, 0, 10) === 1, 'travelProgress clamped');
ok(travelProgress(0.2, 0, 0.3) === 1, 'travelProgress: travel under half a pixel counts as arrived');
ok(travelProgress(5, 10, 0) === 0.5, 'travelProgress works toward a smaller value');

const frame = {x: 10, y: 20, w: 400, h: 300};
const icon = {w: 40, h: 40};
let f = shrinkFrame(frame, icon, 0);
ok(f.scale === 1 && f.width === 400 && f.height === 300 && f.left === 10 && f.top === 20, 'shrinkFrame at 0 is the frame');
f = shrinkFrame(frame, icon, 1);
ok(near(f.width * f.scale, 40) && near(f.height * f.scale, 40), 'shrinkFrame at 1 has the icon size on screen');
ok(near(f.scale, Math.max(40 / 300, 40 / 400)), 'shrinkFrame covers the icon (max of the axis ratios)');
ok(near(f.left + f.width / 2, 10 + 200) && near(f.top + f.height / 2, 20 + 150), 'shrinkFrame stays centered on the frame');
f = shrinkFrame(frame, icon, 0.5);
ok(near(f.width * f.scale, 220) && near(f.height * f.scale, 170), 'shrinkFrame midway is the mix of sizes');

ok(initialShrink(400, 40, 400) === 0, 'initialShrink: full width means not shrunk');
ok(near(initialShrink(400, 40, 220), 0.5), 'initialShrink: half way');
ok(initialShrink(400, 40, 10) === 1, 'initialShrink clamped');
ok(initialShrink(30, 40, 30) === 0, 'initialShrink: icon wider than window gives 0');
done();
