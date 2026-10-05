#!/usr/bin/env python3
"""Fit a CSS cubic-bezier to the normalised curve of a spring.

Standard library only. Deterministic: fixed starting points, fixed iteration caps.
"""
STARTS = (
    (0.2, 0.0, 0.0, 1.0),
    (0.3, 1.5, 0.4, 1.0),
    (0.4, 1.0, 0.2, 1.0),
    (0.1, 1.2, 0.3, 1.0),
    (0.25, 0.1, 0.25, 1.0),
)
MAX_ITERATIONS = 400
FIT_STRIDE = 4  # the optimisation uses one point out of 4; the final error uses all of them


def _coord(a, b, t):
    u = 1.0 - t
    return 3 * u * u * t * a + 3 * u * t * t * b + t ** 3


def value(x1, y1, x2, y2, x):
    """y of the Bezier (0,0)(x1,y1)(x2,y2)(1,1) at abscissa x (Newton + bisection)."""
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    low, high, t = 0.0, 1.0, x
    for _ in range(40):
        f = _coord(x1, x2, t) - x
        if abs(f) < 1e-12:
            break
        if f > 0:
            high = t
        else:
            low = t
        u = 1.0 - t
        d = 3 * u * u * x1 + 6 * u * t * (x2 - x1) + 3 * t * t * (1.0 - x2)
        following = t - f / d if d > 1e-9 else -1.0
        t = following if low < following < high else (low + high) / 2
    return _coord(y1, y2, t)


def _error(p, curve, stride=1):
    points = curve[::stride]
    if curve[-1] not in points:
        points = points + [curve[-1]]
    return max(abs(value(*p, x) - y) for x, y in points)


def _clamp(p):
    return (min(1.0, max(0.0, p[0])), p[1], min(1.0, max(0.0, p[2])), p[3])


def _nelder_mead(f, start, step=0.15):
    n = len(start)
    pts = [list(start)]
    for i in range(n):
        q = list(start)
        q[i] += step
        pts.append(q)
    vals = [f(q) for q in pts]
    for _ in range(MAX_ITERATIONS):
        order = sorted(range(n + 1), key=lambda i: vals[i])
        pts = [pts[i] for i in order]
        vals = [vals[i] for i in order]
        if vals[-1] - vals[0] < 1e-9:
            break
        c = [sum(q[j] for q in pts[:-1]) / n for j in range(n)]

        def pt(coef):
            return [c[j] + coef * (pts[-1][j] - c[j]) for j in range(n)]
        r = pt(-1.0)
        fr = f(r)
        if fr < vals[0]:
            e = pt(-2.0)
            fe = f(e)
            pts[-1], vals[-1] = (e, fe) if fe < fr else (r, fr)
        elif fr < vals[-2]:
            pts[-1], vals[-1] = r, fr
        else:
            k = pt(-0.5) if fr < vals[-1] else pt(0.5)
            fk = f(k)
            if fk < min(fr, vals[-1]):
                pts[-1], vals[-1] = k, fk
            else:
                for i in range(1, n + 1):
                    pts[i] = [pts[0][j] + 0.5 * (pts[i][j] - pts[0][j]) for j in range(n)]
                    vals[i] = f(pts[i])
    i = min(range(n + 1), key=lambda i: vals[i])
    return pts[i]


def fit(curve):
    """curve: [(tau, p)], tau increasing from 0 to 1.
    Returns ((x1, y1, x2, y2), max error as a fraction of the travel)."""
    curve = list(curve)

    def objective(p):
        q = _clamp(p)
        penalty = sum(abs(a - b) for a, b in zip(p, q))
        return _error(q, curve, FIT_STRIDE) + penalty

    best = None
    for s in STARTS:
        p = _clamp(_nelder_mead(objective, list(s)))
        e = _error(p, curve)
        if best is None or e < best[1]:
            best = (p, e)
    p, e = best
    return tuple(round(v, 4) for v in p), _error(tuple(round(v, 4) for v in p), curve)
