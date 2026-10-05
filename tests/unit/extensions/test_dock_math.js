// gjs -m tests/unit/extensions/test_dock_math.js
import {dockSlide, overshootTranslation, dockPosition} from '../../../extensions/m3e-extensions@maximeallanic.github.io/math.js';
import {ok, near, done} from './tap.js';

ok(near(dockSlide(0, 80).slide, 0), 'hidden: slide 0');
ok(near(dockSlide(40, 80).slide, 0.5), 'half way: slide 0.5');
ok(near(dockSlide(80, 80).slide, 1) && dockSlide(80, 80).overshoot === 0, 'shown: slide 1, no overshoot');
ok(near(dockSlide(81.5, 80).slide, 1) && near(dockSlide(81.5, 80).overshoot, 1.5), 'overshoot: slide clamped, 1.5 px overshoot');
ok(near(dockSlide(-3, 80).slide, 0) && dockSlide(-3, 80).overshoot === 0, 'below 0: clamped');
ok(near(dockSlide(NaN, 80).slide, 0), 'NaN: hidden');
ok(near(dockSlide(10, 0).slide, 1), 'zero distance: no division by 0');
ok(overshootTranslation('bottom', 2).y === -2, 'bottom: upwards');
ok(overshootTranslation('top', 2).y === 2, 'top: downwards');
ok(overshootTranslation('left', 2).x === 2, 'left: to the right');
ok(overshootTranslation('right', 2).x === -2, 'right: to the left');
ok(overshootTranslation('nowhere', 2).x === 0, 'unknown side: no translation');
for (const p of [0, 12.5, 80, 81.25]) {
    const g = dockSlide(p, 80);
    ok(near(dockPosition(g.slide, g.overshoot, 80), p), `round trip position ${p}`);
}
done();
