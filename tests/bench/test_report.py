"""Tests of report.py on fabricated JSON files (no Shell needed).

Run directly: python3 tests/bench/test_report.py   (never with `unittest discover` at the repository root).
"""
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import report  # noqa: E402


def series(values, expected=None, period=8.0, gaps=()):
    """Series {t_ms, elapsed_ms, value, expected}; `gaps` = indices whose interval triples."""
    expected = expected if expected is not None else values
    t, out = 1000.0, []
    for i, (v, a) in enumerate(zip(values, expected)):
        t += period * (3 if i in gaps else 1)
        out.append({'t_ms': t, 'elapsed_ms': i * 8, 'value': v, 'expected': a, 'segment': 0})
    return out


def curve(all_series, unit='px', single=True, ok=True, **extra):
    d = {'type': 'curve', 'unit': unit, 'singleActor': single, 'ok': ok, 'detail': {}, 'series': all_series}
    d.update(extra)
    return d


def linear(n=20, offset=0.0, **kw):
    expected = [float(i) for i in range(n)]
    return series([a + offset for a in expected], expected, **kw)


def state(ok=True):
    return {'type': 'state', 'ok': ok, 'detail': {}}


def checks(*oks, **extra):
    return {'type': 'checks', 'ok': all(oks), 'checks': [{'name': f'c{i}', 'ok': ok, 'detail': ''}
                                                         for i, ok in enumerate(oks)], **extra}


class Base(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = self._tmp.name

    def make_pass(self, results, n=1):
        d = os.path.join(self.root, f'pass-{n}')
        os.makedirs(d, exist_ok=True)
        for name, r in results.items():
            with open(os.path.join(d, name + '.json'), 'w') as f:
                json.dump(r, f)
        return d

    def verdicts(self, *passes):
        return {r['name']: r for r in report.analyse(list(passes))}


class TestCurves(Base):
    def test_ok(self):
        d = self.make_pass({'ease-witness': curve({'x': linear()}),
                            'spring-DefaultSpatial-40': curve({'translation_x': linear(offset=0.2)})})
        v = self.verdicts(d)
        self.assertTrue(v['spring-DefaultSpatial-40']['ok'])
        self.assertTrue(v['ease-witness']['ok'])

    def test_difference_too_large(self):
        d = self.make_pass({'ease-witness': curve({'x': linear()}),
                            'spring-DefaultSpatial-40': curve({'translation_x': linear(offset=0.6)})})
        v = self.verdicts(d)['spring-DefaultSpatial-40']
        self.assertFalse(v['ok'])
        self.assertIn('difference', v['reasons'][0])

    def test_opacity_unit(self):
        # 2 out of 255 = 0.0078: under 0.01; 3 out of 255 = 0.0118: over.
        d = self.make_pass({'ease-witness': curve({'x': linear()}),
                            'a': curve({'opacity': linear(offset=2.0)}, unit='opacity'),
                            'b': curve({'opacity': linear(offset=3.0)}, unit='opacity')})
        v = self.verdicts(d)
        self.assertTrue(v['a']['ok'])
        self.assertFalse(v['b']['ok'])
        self.assertAlmostEqual(v['a']['diff'], 2 / 255)

    def test_scale_unit(self):
        d = self.make_pass({'ease-witness': curve({'x': linear()}),
                            'e1': curve({'s': linear(offset=0.009)}, unit='unit'),
                            'e2': curve({'s': linear(offset=0.02)}, unit='unit')})
        v = self.verdicts(d)
        self.assertTrue(v['e1']['ok'])
        self.assertFalse(v['e2']['ok'])

    def test_opacity_property_in_a_px_pattern(self):
        # Opacity properties (oo/io/o/opacity) of a scenario whose unit is px: / 255.
        d = self.make_pass({'ease-witness': curve({'x': linear()}),
                            'pattern-x': curve({'ox': linear(), 'oo': linear(offset=2.0)}, single=False)})
        self.assertTrue(self.verdicts(d)['pattern-x']['ok'])

    def test_lost_frame_single_actor_fails(self):
        d = self.make_pass({'ease-witness': curve({'x': linear()}),
                            'gesture': curve({'translation_x': linear(gaps=(5, 9))})})
        v = self.verdicts(d)['gesture']
        self.assertFalse(v['ok'])
        self.assertEqual(v['lost'], [2])

    def test_long_scenario_same_rate_passes(self):
        # More lost frames in raw value (9 against 2) but the same rate as the witness.
        d = self.make_pass({'ease-witness': curve({'x': linear(20, gaps=(5, 10))}),
                            'slow-down': curve({'x': linear(100, gaps=tuple(range(10, 100, 10)))})})
        v = self.verdicts(d)['slow-down']
        self.assertEqual(v['lost'], [9])
        self.assertTrue(v['ok'], v['reasons'])

    def test_double_the_witness_rate_fails(self):
        d = self.make_pass({'ease-witness': curve({'x': linear(20, gaps=(5, 10))}),
                            'gesture': curve({'x': linear(20, gaps=(3, 6, 9, 12, 15))})})
        v = self.verdicts(d)['gesture']
        self.assertFalse(v['ok'])
        self.assertIn('rate', ' '.join(v['reasons']))

    def test_witness_without_loss_allows_one_per_second(self):
        d = self.make_pass({'ease-witness': curve({'x': linear(200)}),
                            'a': curve({'x': linear(200, gaps=(100,))}),      # ~0.6 /s
                            'b': curve({'x': linear(20, gaps=(10,))})})        # ~5 /s
        v = self.verdicts(d)
        self.assertTrue(v['a']['ok'], v['a']['reasons'])
        self.assertFalse(v['b']['ok'])

    def test_lost_frames_in_a_pattern_not_blocking(self):
        d = self.make_pass({'ease-witness': curve({'x': linear()}),
                            'pattern-axis-x': curve({'sx': linear(gaps=(3, 6, 9, 12))}, single=False),
                            'corners-large-window': curve({'radius': linear(gaps=(3, 6))}, single=False)})
        v = self.verdicts(d)
        self.assertTrue(v['pattern-axis-x']['ok'])
        self.assertEqual(v['pattern-axis-x']['lost'], [4])
        self.assertTrue(v['corners-large-window']['ok'])

    def test_median_over_several_passes(self):
        # Rate: median of the passes. One very bad pass out of three is not enough.
        def one_pass(n, gaps):
            return self.make_pass({'ease-witness': curve({'x': linear(20, gaps=(5, 10))}),
                                   'gesture': curve({'x': linear(20, gaps=gaps)})}, n)
        bad = (2, 4, 6, 8, 10, 12, 14)
        v = self.verdicts(one_pass(1, (5, 10)), one_pass(2, bad), one_pass(3, (7,)))
        self.assertTrue(v['gesture']['ok'], v['gesture']['reasons'])
        self.assertEqual(v['gesture']['lost'], [2, 7, 1])
        self.assertEqual(len(v['gesture']['rates']), 3)
        v = self.verdicts(one_pass(1, bad), one_pass(2, bad), one_pass(3, (7,)))
        self.assertFalse(v['gesture']['ok'])

    def test_difference_in_a_single_pass_fails(self):
        d1 = self.make_pass({'ease-witness': curve({'x': linear()}), 'gesture': curve({'x': linear()})}, 1)
        d2 = self.make_pass({'ease-witness': curve({'x': linear()}), 'gesture': curve({'x': linear(offset=1.0)})}, 2)
        self.assertFalse(self.verdicts(d1, d2)['gesture']['ok'])

    def test_scenario_ok_required(self):
        d = self.make_pass({'ease-witness': curve({'x': linear()}), 'gesture': curve({'x': linear()}, ok=False)})
        self.assertFalse(self.verdicts(d)['gesture']['ok'])

    def test_nan_fails(self):
        s = linear()
        s[3]['value'] = None  # NaN serialised as null by JSON.stringify
        d = self.make_pass({'ease-witness': curve({'x': linear()}), 'gesture': curve({'x': s})})
        self.assertFalse(self.verdicts(d)['gesture']['ok'])

    def test_slow_down_clock_not_blocking(self):
        r = curve({'x': linear()}, ok=False)
        r['okOutsideClock'] = True
        r['okClock'] = False
        d = self.make_pass({'ease-witness': curve({'x': linear()}), 'slow-down': r})
        v = self.verdicts(d)['slow-down']
        self.assertTrue(v['ok'])
        self.assertIn('clock', ' '.join(v['notes']))

    def test_slow_down_outside_clock_false_fails(self):
        r = curve({'x': linear()}, ok=False)
        r['okOutsideClock'] = False
        r['okClock'] = True
        d = self.make_pass({'ease-witness': curve({'x': linear()}), 'slow-down': r})
        self.assertFalse(self.verdicts(d)['slow-down']['ok'])


class TestStateAndChecks(Base):
    def test_state(self):
        d = self.make_pass({'not-mapped': state(True), 'destroy': state(False)})
        v = self.verdicts(d)
        self.assertTrue(v['not-mapped']['ok'])
        self.assertFalse(v['destroy']['ok'])

    def test_state_false_in_one_pass(self):
        d1 = self.make_pass({'glsl': state(True)}, 1)
        d2 = self.make_pass({'glsl': state(False)}, 2)
        self.assertFalse(self.verdicts(d1, d2)['glsl']['ok'])

    def test_scenario_error(self):
        d = self.make_pass({'glsl': {'type': 'error', 'message': 'boom'}})
        v = self.verdicts(d)['glsl']
        self.assertFalse(v['ok'])
        self.assertIn('boom', v['reasons'][0])

    def test_missing_from_a_pass(self):
        d1 = self.make_pass({'glsl': state(True)}, 1)
        d2 = self.make_pass({}, 2)
        self.assertFalse(self.verdicts(d1, d2)['glsl']['ok'])

    def test_checks_all_true(self):
        d = self.make_pass({'a': checks(True, True)})
        self.assertTrue(self.verdicts(d)['a']['ok'])

    def test_one_false_check(self):
        d = self.make_pass({'a': checks(True, False)})
        v = self.verdicts(d)['a']
        self.assertFalse(v['ok'])
        self.assertIn('c1', v['reasons'][0])

    def test_no_checks(self):
        d = self.make_pass({'a': {'type': 'checks', 'ok': False, 'checks': []}})
        self.assertFalse(self.verdicts(d)['a']['ok'])

    def test_checks_rate_against_witness(self):
        d = self.make_pass({'ease-witness': curve({'x': linear(20, gaps=(5, 10))}),
                            'a': checks(True, lost=1, duration_ms=1000),    # 1/s: under 1.5 x witness
                            'b': checks(True, lost=20, duration_ms=1000)})  # 20/s
        v = self.verdicts(d)
        self.assertTrue(v['a']['ok'], v['a']['reasons'])
        self.assertFalse(v['b']['ok'])
        self.assertIn('lost frames', ' '.join(v['b']['reasons']))


class TestExpected(Base):
    def expected_file(self, names):
        path = os.path.join(self.root, 'expected.txt')
        with open(path, 'w') as f:
            f.write('\n'.join(names) + '\n')
        return path

    def test_missing_from_every_pass_fails(self):
        d1 = self.make_pass({'glsl': state()}, 1)
        d2 = self.make_pass({'glsl': state()}, 2)
        r = {x['name']: x for x in report.analyse([d1, d2], expected=['glsl', 'burst'])}
        self.assertTrue(r['glsl']['ok'])
        self.assertFalse(r['burst']['ok'])
        self.assertIn('missing from every pass', r['burst']['reasons'][0])

    def test_extra_json_ignored_with_expected(self):
        d = self.make_pass({'glsl': state(), 'stray': state(False)})
        r = report.analyse([d], expected=['glsl'])
        self.assertEqual([x['name'] for x in r], ['glsl'])
        self.assertEqual(report.ignored([d], ['glsl']), ['stray'])

    def test_without_expected_unchanged(self):
        d = self.make_pass({'stray': state(False)})
        self.assertEqual([x['name'] for x in report.analyse([d])], ['stray'])

    def test_main_expected(self):
        d = self.make_pass({'glsl': state(), 'stray': state()})
        html_ = os.path.join(self.root, 'r.html')
        self.assertEqual(report.main(['--html', html_, '--expected', self.expected_file(['glsl', 'missing']), d]), 1)
        with open(html_, encoding='utf-8') as f:
            text = f.read()
        self.assertIn('missing from every pass', text)
        self.assertIn('Ignored', text)
        self.assertEqual(report.main(['--html', html_, '--expected', self.expected_file(['glsl']), d]), 0)


class TestShellLog(Base):
    def test_clean_and_defective_log(self):
        d = self.make_pass({'a': checks(True)})
        with open(os.path.join(d, 'shell.log'), 'w', encoding='utf-8') as f:
            f.write('all fine\n')
        html_ = os.path.join(self.root, 'r.html')
        self.assertEqual(report.main(['--html', html_, d]), 0)
        with open(os.path.join(d, 'shell.log'), 'a', encoding='utf-8') as f:
            f.write('Gjs-CRITICAL: Object Gjs_ui_windowPreview_WindowPreview has been already disposed\n')
        self.assertEqual(report.main(['--html', html_, d]), 1)
        self.assertEqual(report.log_defects(d)[0][:13], 'Gjs-CRITICAL:')


class TestOutput(Base):
    def test_standalone_html_and_exit_code(self):
        d = self.make_pass({'ease-witness': curve({'x': linear()}), 'gesture': curve({'x': linear()}),
                            'glsl': state()})
        out = os.path.join(self.root, 'report.html')
        self.assertEqual(report.main(['--html', out, d]), 0)
        with open(out, encoding='utf-8') as f:
            text = f.read()
        self.assertIn('<svg', text)
        self.assertIn('gesture', text)
        for forbidden in ('http:', 'https:', '<script', '<link', 'src=', 'url('):
            self.assertNotIn(forbidden, text)

    def test_nonzero_exit(self):
        d = self.make_pass({'ease-witness': curve({'x': linear()}), 'gesture': curve({'x': linear(offset=2.0)})})
        self.assertEqual(report.main(['--html', os.path.join(self.root, 'r.html'), d]), 1)


if __name__ == '__main__':
    unittest.main()
