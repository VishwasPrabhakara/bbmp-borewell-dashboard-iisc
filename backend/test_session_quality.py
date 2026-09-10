import datetime as dt
import json
from pathlib import Path
import random
import subprocess
import unittest
from session_quality import build_sessions, summarize


def series(water, yields=None, minutes=None):
    n = len(water)
    start = dt.datetime(2026, 9, 1)
    return {'times': [(start + dt.timedelta(minutes=m)).isoformat()
                      for m in (minutes if minutes is not None else range(0, n * 5, 5))],
            'water_ft': water, 'yield_kl': list(range(n)) if yields is None else yields,
            'flow_lpm': [10] * n}


def build(s):
    return build_sessions([dt.datetime.fromisoformat(t) for t in s['times']],
                          s['water_ft'], s['flow_lpm'], s['yield_kl'])


class QualityTests(unittest.TestCase):
    def test_single_reading_retained(self):
        s = build(series([10]))
        self.assertEqual(len(s), 1)
        self.assertEqual(s[0]['status'], 'excluded')

    def test_jump_does_not_discard_volume(self):
        s = build(series([10, 40, 45]))[0]
        self.assertEqual(s['status'], 'flagged')
        self.assertTrue(s['eligible_volume'])
        self.assertFalse(s['eligible_drawdown'])
        self.assertEqual(s['jump_count'], 1)

    def test_flat_is_not_rise(self):
        s = build(series([10, 10, 10]))[0]
        self.assertEqual(s['status'], 'ok')
        self.assertFalse(s['eligible_specific_capacity'])

    def test_rise_flag(self):
        s = build(series([10, 9, 8]))[0]
        self.assertEqual(s['reasons'], ['net_level_rise'])
        self.assertTrue(s['eligible_volume'])

    def test_missing_endpoint_retained(self):
        s = build(series([None, 11, 12]))[0]
        self.assertEqual(s['status'], 'excluded')
        self.assertIsNone(s['drawdown_ft'])
        self.assertTrue(s['eligible_volume'])

    def test_missing_yield_is_not_zero(self):
        s = build(series([10, 11, 12], [None, 1, 2]))[0]
        self.assertIn('missing_yield', s['reasons'])
        self.assertNotIn('no_volume', s['reasons'])

    def test_thresholds(self):
        self.assertEqual(len(build(series([10, 11, 12], minutes=[0, 30, 61]))), 2)
        self.assertEqual(len(build(series([10, 11], [1, .999]))), 2)
        self.assertNotIn('sensor_relock_jump', build(series([10, 30, 31]))[0]['reasons'])

    def test_backend_browser_parity(self):
        cases = [series([]), series([10]), series([10, 40, 45]),
                 series([None, 10, 11]), series([10, 10, 10])]
        rng = random.Random(8)
        for _ in range(60):
            n = rng.randrange(1, 30)
            cases.append(series([rng.choice([None, 0, 10, 20, 45]) for _ in range(n)],
                                [rng.choice([None, 0, 1, 2, 3]) for _ in range(n)]))
        script = "const q=require('./js/session-quality.js');let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(JSON.stringify(JSON.parse(s).map(q.build))));"
        result = subprocess.run(['node', '-e', script], input=json.dumps(cases),
            text=True, capture_output=True, check=True, cwd=Path(__file__).resolve().parents[1])
        self.assertEqual(json.loads(result.stdout), [build(s) for s in cases])
        for case in cases:
            sessions = build(case)
            self.assertEqual(sum(s['n'] for s in sessions), len(case['times']))
            counts = summarize(sessions)
            self.assertEqual(counts['total'], sum(counts[k] for k in ('ok','flagged','excluded')))


if __name__ == '__main__':
    unittest.main()
