"""Rebuild session annotations from the existing lossless JSON series.

Run after changing the policy. Never changes raw arrays or sensor metadata.
"""
import datetime as dt
import hashlib
import json
from pathlib import Path
from session_quality import build_sessions, summarize, POLICY_VERSION


def raw_hash(series):
    return hashlib.sha256(json.dumps({k: v for k, v in series.items()
        if k not in ('sessions', 'quality_summary', 'quality_policy_version')},
        sort_keys=True).encode()).hexdigest()


def main():
    data = Path(__file__).resolve().parents[1] / 'data'
    totals = summarize([])
    files = sorted((data / 'sensor_series').glob('*.json'))
    for path in files:
        series = json.loads(path.read_text(encoding='utf-8'))
        before = raw_hash(series)
        times = [dt.datetime.fromisoformat(t) for t in series['times']]
        sessions = build_sessions(times, series['water_ft'], series['flow_lpm'], series['yield_kl'])
        assert sum(s['n'] for s in sessions) == len(times), path.name
        series.update(sessions=sessions, quality_policy_version=POLICY_VERSION,
                      quality_summary=summarize(sessions))
        assert raw_hash(series) == before, path.name
        temp = path.with_suffix('.json.tmp')
        temp.write_text(json.dumps(series, separators=(',', ':'), allow_nan=False), encoding='utf-8')
        check = json.loads(temp.read_text(encoding='utf-8'))
        assert raw_hash(check) == before, path.name
        temp.replace(path)
        for key, value in series['quality_summary'].items():
            if key == 'by_reason':
                for reason, count in value.items():
                    totals[key][reason] = totals[key].get(reason, 0) + count
            else:
                totals[key] += value
    report = {'policy_version': POLICY_VERSION, 'sensor_files': len(files),
              'raw_arrays_preserved': True, **totals}
    (data / 'session_quality_summary.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
