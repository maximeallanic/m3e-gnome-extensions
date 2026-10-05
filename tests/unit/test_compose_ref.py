"""Tests of the reference Python port of the Compose springs (SpringSimulation / SpringEstimation)."""
import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))

import compose_ref as cr  # noqa: E402


class TestState(unittest.TestCase):
    def test_t0(self):
        self.assertEqual(cr.state(380, 0.8, 40, 0, 0), (40, 0))

    def test_critical_known_form(self):
        t = 0.05
        x, _ = cr.state(1600, 1.0, 1, 0, t * 1000)
        self.assertAlmostEqual(x, (1 + 40 * t) * math.exp(-40 * t), delta=1e-9)

    def test_underdamped_known_form(self):
        z, k, t = 0.8, 380.0, 0.05
        w = math.sqrt(k)
        wd = w * math.sqrt(1 - z * z)
        expected = math.exp(-z * w * t) * (math.cos(wd * t) + z * w / wd * math.sin(wd * t))
        x, _ = cr.state(k, z, 1, 0, t * 1000)
        self.assertAlmostEqual(x, expected, delta=1e-9)

    def test_velocity_is_derivative(self):
        h = 1e-4
        for k, z in [(380, 0.8), (1600, 1.0), (800, 0.6), (3800, 1.0), (2000, 1.5)]:
            for t in (0.02, 0.05, 0.1):
                _, v = cr.state(k, z, 40, 300, t * 1000)
                xp, _ = cr.state(k, z, 40, 300, (t + h) * 1000)
                xm, _ = cr.state(k, z, 40, 300, (t - h) * 1000)
                numeric = (xp - xm) / (2 * h)
                self.assertAlmostEqual(v, numeric, delta=1e-4 * max(1.0, abs(v)))


class TestDuration(unittest.TestCase):
    def test_duration_grows_with_distance(self):
        self.assertLess(cr.duration_ms(380, 0.8, 0, 40, 0.5), cr.duration_ms(380, 0.8, 0, 2000, 0.5))

    def test_duration_settles(self):
        threshold = 0.5
        for name, (k, z) in cr.read_springs().items():
            d = cr.duration_ms(k, z, 0, 400, threshold)
            x, _ = cr.state(k, z, 400, 0, d)
            # Critical springs (Effects): the Compose estimator stops Newton at 1 ms on t, hence up to
            # ~4.5 % above the threshold at t = duration (faithful port).
            tolerance = 1.05 if z == 1.0 else 1.01
            self.assertLessEqual(abs(x), threshold * tolerance, name)
            for t in range(d, 2 * d + 1):
                x, _ = cr.state(k, z, 400, 0, t)
                self.assertLessEqual(abs(x), threshold * 1.5, f"{name} t={t}")

    def test_springs_come_from_tokens_json(self):
        springs = cr.read_springs()
        self.assertEqual(set(springs), set(cr.SPRING_NAMES))
        self.assertEqual(springs["FastSpatial"], (800.0, 0.6))


if __name__ == "__main__":
    unittest.main()
