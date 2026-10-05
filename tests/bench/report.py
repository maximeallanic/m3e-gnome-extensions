#!/usr/bin/env python3
"""Report and verdict of the M3E motion bench.

Usage: report.py [--html FILE] [--expected FILE] PASS_DIR [PASS_DIR ...]
  --expected  list of the scenarios that were run (one per line): only those are judged, an expected scenario
              with no JSON in any pass fails, other *.json files are ignored (and noted).
  PASS_DIR    output directory of nested.sh (one <scenario>.json per scenario, plus shell.log).
  Writes report.html (default: in the first directory), prints failing scenarios on stdout, exit code 0 only if
  every verdict is OK.

Result types written by the bench extension:
  curve   {type, unit, singleActor, ok, series: {prop: [{t_ms, elapsed_ms, value, expected}]}}
  state   {type, ok, detail}
  checks  {type, ok, checks: [{name, ok, detail}], lost?, duration_ms?}
  error   {type, message}

Rules:
  - max difference <= 0.5 (px, radius); <= 0.01 for opacity normalised by 255 and for scale/progress units; a single
    pass over the limit fails (deterministic);
  - the scenario's `ok` must be true in every pass (for `slow-down`, `okOutsideClock`: the wall-clock measurement is
    only reported);
  - lost frame: interval between two `t_ms` above 1.5 x the median period; single-actor scenarios and checks
    scenarios with a duration: RATE (lost / duration in s); median of the passes <= 1.5 x the median rate of the witness
    `ease-witness` (a witness without loss: 1 per second tolerated); multi-actor patterns and corners: count reported,
    not blocking;
  - the Shell log of a pass must contain no destroyed-object access, assertion failure, JS error or GJS critical.
"""
import html
import json
import math
import os
import re
import statistics
import sys

WITNESS = 'ease-witness'
RATE_FACTOR = 1.5
RATE_ALLOWED_WITHOUT_WITNESS = 1.0  # per second, when the witness loses nothing
LIMIT_PX = 0.5
LIMIT_UNIT = 0.01
# Opacity properties (0-255) inside scenarios whose global unit is "px".
OPACITY_PROPS = {'opacity', 'o', 'oo', 'io'}
# A destroyed object touched, an assertion, a JS error or a GJS critical fails the pass.
LOG_PATTERN = re.compile(r"already disposed|assertion .* failed|JS ERROR|Gjs-CRITICAL")


def load(directory, name):
    try:
        with open(os.path.join(directory, name + '.json'), encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as e:
        return {'type': 'error', 'message': f'unreadable JSON: {e}'}


def scenario_names(passes):
    names = set()
    for d in passes:
        for f in os.listdir(d):
            if f.endswith('.json'):
                names.add(f[:-5])
    return sorted(names)


def property_unit(global_unit, prop):
    """('opacity'|'unit'|'px') for a property of a series."""
    if global_unit == 'opacity' or prop in OPACITY_PROPS:
        return 'opacity'
    if global_unit == 'unit':
        return 'unit'
    return 'px'


def property_diff(unit, series):
    """Normalised max difference (opacity / 255); None on NaN or missing value."""
    diff = 0.0
    for e in series:
        v, a = e.get('value'), e.get('expected')
        if not isinstance(v, (int, float)) or not isinstance(a, (int, float)) \
                or not math.isfinite(v) or not math.isfinite(a):
            return None
        d = abs(v - a)
        diff = max(diff, d / 255 if unit == 'opacity' else d)
    return diff


def lost_frames(series):
    """Intervals above 1.5 x the median period (same computation as the bench)."""
    if not series:
        return 0
    first = next(iter(series.values()))
    t = [e['t_ms'] for e in first]
    dt = sorted(b - a for a, b in zip(t, t[1:]))
    if not dt:
        return 0
    period = dt[len(dt) // 2]
    return sum(1 for d in dt if d > 1.5 * period)


def lost_rate(series):
    """Lost frames per second (duration: first to last t_ms)."""
    if not series:
        return 0.0
    t = [e['t_ms'] for e in next(iter(series.values()))]
    duration = (t[-1] - t[0]) / 1000 if len(t) > 1 else 0
    return lost_frames(series) / duration if duration > 0 else 0.0


def checks_rate(r):
    duration = r.get('duration_ms') or 0
    return (r.get('lost') or 0) / (duration / 1000) if duration > 0 else 0.0


def scenario_ok(r):
    """The scenario's `ok`; slow-down: without its wall-clock part."""
    return bool(r.get('okOutsideClock', r.get('ok', False)))


def analyse_curve(results, reasons, notes):
    """Fills reasons/notes; returns (diff, unit, lost, single_actor)."""
    worst = (0.0, 'px', -1.0)  # difference, unit, ratio to the limit
    lost, single = [], False
    for i, r in enumerate(results, 1):
        single = single or bool(r.get('singleActor'))
        if not r.get('series'):
            reasons.append(f'pass {i}: no series recorded')
            continue
        if not scenario_ok(r):
            reasons.append(f'pass {i}: scenario ok is false (durations, onDone, final values...)')
        for prop, serie in r['series'].items():
            u = property_unit(r.get('unit', 'px'), prop)
            diff = property_diff(u, serie)
            limit = LIMIT_PX if u == 'px' else LIMIT_UNIT
            if diff is None:
                reasons.append(f'pass {i}: {prop} contains NaN or a missing value')
                continue
            if diff / limit > worst[2]:
                worst = (diff, u, diff / limit)
            if diff > limit:
                reasons.append(f'pass {i}: difference {prop} = {diff:.4g} > {limit} ({u})')
        lost.append(lost_frames(r['series']))
        if 'okClock' in r:
            d = r.get('detail', {})
            notes.append(f"pass {i}: wall clock {'ok' if r['okClock'] else 'out of tolerance'}"
                         f" (measured {d.get('measuredDurationMs', '?')} ms,"
                         f" expected {d.get('expectedDurationMs', '?')} ms; reported only)")
    return worst[0], worst[1], lost, single


def ignored(passes, expected=None):
    """*.json present but not expected (empty without an expected list)."""
    if expected is None:
        return []
    return [n for n in scenario_names(passes) if n not in set(expected)]


def analyse(passes, expected=None):
    """One entry per scenario: name, type, ok, reasons, notes, diff, unit, lost, ..."""
    names = scenario_names(passes) if expected is None else sorted(set(expected))
    raw = {n: [load(d, n) for d in passes] for n in names}
    # Reference: lost frames of the witness (nested Shell without the engine).
    ref = [lost_rate(r['series']) for r in raw.get(WITNESS, []) if r and r.get('series')]
    witness_rate = statistics.median(ref) if ref else 0.0
    limit = RATE_FACTOR * witness_rate if witness_rate > 0 else RATE_ALLOWED_WITHOUT_WITNESS
    out = []
    for name in names:
        results = raw[name]
        reasons, notes = [], []
        entry = {'name': name, 'type': 'state', 'diff': None, 'unit': '', 'lost': [], 'rates': [],
                 'median_rate': None, 'rate_limit': limit, 'median_lost': None, 'blocking_lost': False,
                 'reasons': reasons, 'notes': notes, 'pass1': results[0]}
        for i, r in enumerate(results, 1):
            if r is None:
                reasons.append(f'pass {i}: result missing')
            elif r.get('type') == 'error':
                reasons.append(f"pass {i}: scenario error ({r.get('message', '?')})")
        if all(r is None for r in results):
            reasons[:] = ['missing from every pass']
        valid = [r for r in results if r and r.get('type') != 'error']
        if len(valid) == len(results):
            if all(r.get('type') == 'curve' for r in valid):
                entry['type'] = 'curve'
                diff, u, lost, single = analyse_curve(valid, reasons, notes)
                rates = [lost_rate(r['series']) for r in valid if r.get('series')]
                entry.update(diff=diff, unit=u, lost=lost, rates=rates,
                             median_lost=statistics.median(lost) if lost else None,
                             median_rate=statistics.median(rates) if rates else None)
                if single and name != WITNESS and rates:
                    entry['blocking_lost'] = True
                    if entry['median_rate'] > limit:
                        reasons.append(f"lost frames: median rate {entry['median_rate']:.3g}/s"
                                       f" > {limit:.3g}/s (witness {witness_rate:.3g}/s x {RATE_FACTOR:g}"
                                       f"{'' if witness_rate > 0 else ', witness without loss: 1/s'})")
            else:
                entry['type'] = 'checks' if all(r.get('type') == 'checks' for r in valid) else 'state'
                for i, r in enumerate(valid, 1):
                    if r.get('type') == 'checks':
                        bad = [c for c in r.get('checks', []) if not c.get('ok')]
                        reasons.extend(f"pass {i}: {c['name']} ({c.get('detail', '')})" for c in bad)
                        if not r.get('checks'):
                            reasons.append(f'pass {i}: no checks')
                        rate = checks_rate(r)
                        entry['lost'].append(r.get('lost') or 0)
                        entry['rates'].append(rate)
                        if r.get('duration_ms') and not r.get('witness') and rate > limit:
                            reasons.append(f"pass {i}: lost frames: {rate:.2f}/s > {limit:.2f}/s")
                    elif not r.get('ok'):
                        reasons.append(f'pass {i}: ok false ({json.dumps(r.get("detail", {}))[:160]})')
        entry['ok'] = not reasons
        out.append(entry)
    return out


def log_defects(directory):
    """Lines of shell.log that signal a defect (empty list when the log is absent)."""
    path = os.path.join(directory, 'shell.log')
    if not os.path.exists(path):
        return []
    with open(path, encoding='utf-8', errors='replace') as f:
        return [line.rstrip() for line in f if LOG_PATTERN.search(line)]


# --- HTML rendering ---

CSS = """
:root{--bg:#fef7ff;--text:#1d1b20;--soft:#79747e;--line:#cac4d0;--expected:#79747e;
--measured:#6750a4;--ok:#1b6d3a;--ko:#b3261e;--card:#f3edf7}
@media (prefers-color-scheme:dark){:root{--bg:#141218;--text:#e6e0e9;--soft:#938f99;
--line:#49454f;--expected:#938f99;--measured:#d0bcff;--ok:#7fd99a;--ko:#f2b8b5;--card:#211f26}}
body{background:var(--bg);color:var(--text);font:14px/1.45 system-ui,sans-serif;margin:0 auto;
max-width:1100px;padding:16px}
h1{font-size:22px}h2{font-size:15px;margin:0 0 6px}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid var(--line);padding:4px 8px;
text-align:left}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.ok{color:var(--ok);font-weight:600}.ko{color:var(--ko);font-weight:600}
.card{background:var(--card);border-radius:12px;padding:10px 12px;margin:12px 0}
.card svg{width:100%;height:auto;max-width:100%}
.note{color:var(--soft);font-size:12px}
svg text{fill:var(--soft);font-size:9px;font-family:system-ui,sans-serif}
"""


def _fmt(x):
    return '-' if x is None else f'{x:.4g}'


def svg_scenario(a, width=1040, columns=3):
    """Small multiples: one cell per property, expected (dashed) and measured (solid)."""
    result = a['pass1']
    if not result or result.get('type') != 'curve' or not result.get('series'):
        return ''
    series = result['series']
    props = list(series)
    cw, ch, margin = width // columns, 90, 14
    rows = math.ceil(len(props) / columns)
    parts = [f'<svg viewBox="0 0 {width} {rows * ch}" role="img" '
             f'aria-label="Expected and measured curves of {html.escape(a["name"])}">']
    for k, prop in enumerate(props):
        serie = [e for e in series[prop] if isinstance(e.get('value'), (int, float))
                 and isinstance(e.get('expected'), (int, float))]
        ox, oy = (k % columns) * cw, (k // columns) * ch
        parts.append(f'<text x="{ox + 4}" y="{oy + 10}">{html.escape(prop)}</text>')
        if len(serie) < 2:
            continue
        t0 = serie[0]['t_ms']
        ts = [e['t_ms'] - t0 for e in serie]
        vs = [e['value'] for e in serie] + [e['expected'] for e in serie]
        vmin, vmax = min(vs), max(vs)
        span_v = (vmax - vmin) or 1.0
        span_t = (ts[-1] - ts[0]) or 1.0

        def pt(t, v):
            x = ox + margin + (t / span_t) * (cw - 2 * margin)
            y = oy + ch - 12 - ((v - vmin) / span_v) * (ch - 30)
            return f'{x:.1f},{y:.1f}'
        exp = ' '.join(pt(t, e['expected']) for t, e in zip(ts, serie))
        mea = ' '.join(pt(t, e['value']) for t, e in zip(ts, serie))
        parts.append(f'<polyline points="{exp}" fill="none" stroke="var(--expected)" '
                     f'stroke-width="2.5" stroke-dasharray="5 3" opacity=".8"/>')
        parts.append(f'<polyline points="{mea}" fill="none" stroke="var(--measured)" stroke-width="1.2"/>')
        parts.append(f'<text x="{ox + margin}" y="{oy + ch - 1}">{vmin:.4g} ... {vmax:.4g} · '
                     f'{ts[-1]:.0f} ms</text>')
    parts.append('</svg>')
    return ''.join(parts)


def render_html(analyses, n_passes, ignored_=()):
    ko = [a for a in analyses if not a['ok']]
    out = ['<!doctype html><html lang="en"><head><meta charset="utf-8">',
           '<meta name="viewport" content="width=device-width,initial-scale=1">',
           f'<title>M3E motion bench</title><style>{CSS}</style></head><body>',
           '<h1>M3E motion bench</h1>',
           f'<p>{len(analyses) - len(ko)} scenarios OK out of {len(analyses)}; {n_passes} pass(es). '
           'Difference <= 0.5 (px, radius) or <= 0.01 (opacity / 255, scale); lost frames '
           '(interval &gt; 1.5 x median period): for single-actor scenarios, median rate (lost/s) '
           '<= 1.5 x the witness median rate (1/s if the witness loses nothing).</p>',
           '<table><thead><tr><th>Scenario</th><th class="n">Max difference</th><th>Unit</th>'
           '<th class="n">Lost frames (per pass)</th><th class="n">Median</th>'
           '<th class="n">Rate /s (per pass)</th><th class="n">Median rate</th><th>Verdict</th>'
           '</tr></thead><tbody>']
    for a in analyses:
        v = '<span class="ok">OK</span>' if a['ok'] else '<span class="ko">FAIL</span>'
        lost = ' / '.join(f'{p}' for p in a['lost']) or '-'
        flag = '' if a['type'] != 'curve' else ('' if a['blocking_lost'] else ' (not blocking)')
        out.append(f'<tr><td><a href="#{html.escape(a["name"])}">{html.escape(a["name"])}</a></td>'
                   f'<td class="n">{_fmt(a["diff"])}</td><td>{a["unit"] or "state"}</td>'
                   f'<td class="n">{lost}{flag}</td><td class="n">{_fmt(a["median_lost"])}</td>'
                   f'<td class="n">{" / ".join(f"{x:.3g}" for x in a["rates"]) or "-"}</td>'
                   f'<td class="n">{_fmt(a["median_rate"])}</td>'
                   f'<td>{v}</td></tr>')
    out.append('</tbody></table>')
    for a in analyses:
        out.append(f'<div class="card" id="{html.escape(a["name"])}"><h2>{html.escape(a["name"])} · '
                   + ('<span class="ok">OK</span>' if a['ok'] else '<span class="ko">FAIL</span>')
                   + '</h2>')
        out.append(svg_scenario(a))
        for t in a['reasons'] + a['notes']:
            out.append(f'<div class="note">{html.escape(t)}</div>')
        if a['type'] == 'state' and a['pass1']:
            detail = json.dumps(a['pass1'].get('detail', {}), ensure_ascii=False)
            out.append(f'<div class="note">{html.escape(detail[:400])}</div>')
        out.append('</div>')
    if ignored_:
        out.append('<p class="note">Ignored JSON files (not expected): ' + html.escape(', '.join(ignored_)) + '</p>')
    out.append('<p class="note">Dashed: expected value; solid: measured value (pass 1).</p>')
    out.append('</body></html>')
    return '\n'.join(out)


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    html_out, expected = None, None
    while argv[:1] in (['--html'], ['--expected']) and len(argv) >= 2:
        if argv[0] == '--html':
            html_out = argv[1]
        else:
            try:
                with open(argv[1], encoding='utf-8') as f:
                    expected = [line.strip() for line in f if line.strip()]
            except OSError as e:
                print(f'unreadable expected list: {e}', file=sys.stderr)
                return 2
        argv = argv[2:]
    if not argv:
        print(__doc__, file=sys.stderr)
        return 2
    for d in argv:
        if not os.path.isdir(d):
            print(f'directory not found: {d}', file=sys.stderr)
            return 2
    analyses = analyse(argv, expected)
    if not analyses:
        print('no result in the given directories', file=sys.stderr)
        return 2
    path = html_out or os.path.join(argv[0], 'report.html')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(render_html(analyses, len(argv), ignored(argv, expected)))
    ko = [a for a in analyses if not a['ok']]
    status = 0 if not ko else 1
    for a in ko:
        print(f"FAIL {a['name']}: {a['reasons'][0]}" +
              (f" (+{len(a['reasons']) - 1})" if len(a['reasons']) > 1 else ''))
    for i, d in enumerate(argv, 1):
        defects = log_defects(d)
        if defects:
            status = 1
            print(f'FAIL Shell log of pass {i}: {len(defects)} defect line(s)')
            for line in defects[:10]:
                print(f'       - {line[:200]}')
    print(f'{len(analyses) - len(ko)} OK / {len(analyses)} - {path}')
    return status


if __name__ == '__main__':
    sys.exit(main())
