"""
Scrape motor_hp + borewell_depth + pump_name for every UID from the
Krishihrudaya (KH) admin dashboard, and write the result to
../data/sensors_db.json in the exact shape prepare_data.py expects.

Distilled from bbmp-borewell-backend/sync_kh_device_metadata.py (which
updates the Neon Postgres sensors table instead). This standalone version
needs only the KH login and produces a JSON file — no DB dependency —
so it works from any Windows PowerShell without SQLAlchemy or Neon access.

Credentials
-----------
Reads KH_EMAIL and KH_PASSWORD from ../.env (same file that holds
DATABASE_URL). Never commit .env.

Endpoints used (undocumented, live on https://khprojects.in/reports)
--------------------------------------------------------------------
  GET  /admin/login                     -> HTML with hidden _token
  POST /login                           -> establishes session cookie
  GET  /admin/admin/reports/filter_uid  -> JSON {deviceInfo: {motor_hp, borewell_depth, pump_name, ...}}

Usage
-----
    cd backend
    python fetch_kh_metadata.py                  # scrape every UID in data/sensors.json
    python fetch_kh_metadata.py --limit 5        # test run: first 5 UIDs
    python fetch_kh_metadata.py --sleep 0.25     # be nicer to KH
"""
import argparse
import html.parser
import http.cookiejar
import json
import os
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
SENSORS_IN = REPO / "data" / "sensors.json"
OUT = REPO / "data" / "sensors_db.json"

BASE = "https://khprojects.in/reports"
LOGIN_PAGE = f"{BASE}/admin/login"
LOGIN_POST = f"{BASE}/login"
FILTER_UID = f"{BASE}/admin/admin/reports/filter_uid"


class HiddenInputParser(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.inputs = {}

    def handle_starttag(self, tag, attrs):
        if tag.lower() != "input":
            return
        data = dict(attrs)
        name = data.get("name")
        if name:
            self.inputs[name] = data.get("value", "")


def load_dotenv(path: Path):
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line or line.strip().startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def _request(opener, url, data=None, headers=None, timeout=120):
    hdr = {"User-Agent": "Mozilla/5.0 IISc-BWSSB dashboard KH metadata",
           "Accept": "text/html,application/json,*/*"}
    if headers:
        hdr.update(headers)
    body = None
    if data is not None:
        body = urllib.parse.urlencode(data).encode("utf-8")
        hdr["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=body, headers=hdr)
    return opener.open(req, timeout=timeout)


def _read(resp):
    return resp.read().decode(resp.headers.get_content_charset() or "utf-8", errors="replace")


def _parse_float(v):
    try:
        if v is None or str(v).strip() == "":
            return None
        return float(str(v).replace(",", "").strip())
    except Exception:
        return None


def login():
    email = os.getenv("KH_EMAIL")
    password = os.getenv("KH_PASSWORD")
    if not email or not password:
        raise SystemExit("Set KH_EMAIL and KH_PASSWORD in ../.env or environment.")
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
    )
    html_txt = _read(_request(opener, LOGIN_PAGE))
    p = HiddenInputParser(); p.feed(html_txt)
    token = p.inputs.get("_token")
    if not token:
        raise RuntimeError("Could not find KH login CSRF _token")
    resp = _request(
        opener, LOGIN_POST,
        {"_token": token, "email": email, "password": password},
        {"Origin": "https://khprojects.in", "Referer": LOGIN_PAGE},
    )
    body = _read(resp)
    if "/admin/login" in resp.geturl() or "Sign in with your login credentials" in body:
        raise RuntimeError("KH login failed - check KH_EMAIL / KH_PASSWORD")
    return opener


def fetch_device_info(opener, uid):
    q = urllib.parse.urlencode({"dateFrom": "", "dateTo": "", "uid": uid})
    resp = _request(opener, f"{FILTER_UID}?{q}",
                    headers={"Referer": f"{BASE}/admin/reports-uid?uid={uid}"})
    payload = json.loads(_read(resp))
    return payload.get("deviceInfo") or {}


def main():
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    ap.add_argument("--limit", type=int, default=0, help="Test run: stop after N UIDs.")
    ap.add_argument("--sleep", type=float, default=0.15, help="Seconds between requests.")
    args = ap.parse_args()

    load_dotenv(REPO / ".env")

    if not SENSORS_IN.exists():
        raise SystemExit(f"{SENSORS_IN} not found - run prepare_data.py first.")
    sensors = json.load(SENSORS_IN.open())
    uids = [str(s["uid"]) for s in sensors if s.get("uid")]
    if args.limit:
        uids = uids[: args.limit]
    print(f"KH metadata scrape: {len(uids)} UIDs from {SENSORS_IN.name}")

    opener = login()
    print("Logged into khprojects.in")

    records = []
    n_hits = 0
    n_fails = 0
    for i, uid in enumerate(uids, 1):
        try:
            info = fetch_device_info(opener, uid)
            hp = _parse_float(info.get("motor_hp"))
            bd = _parse_float(info.get("borewell_depth"))
            pn = info.get("pump_name")
            records.append({
                "uid": uid,
                "motor_hp": hp,
                "borewell_depth": bd,
                "pump_name": pn if pn else None,
            })
            if hp is not None or bd is not None or pn:
                n_hits += 1
        except Exception as e:
            n_fails += 1
            records.append({"uid": uid, "motor_hp": None,
                            "borewell_depth": None, "pump_name": None,
                            "_error": str(e)[:180]})
        if i % 50 == 0:
            print(f"  fetched {i}/{len(uids)} - metadata found: {n_hits}, failures: {n_fails}",
                  flush=True)
        if args.sleep:
            time.sleep(args.sleep)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8") as f:
        json.dump(records, f)
    print(f"\nWrote {OUT} ({len(records)} rows)")
    print(f"  metadata found: {n_hits}")
    print(f"  failures:       {n_fails}")


if __name__ == "__main__":
    main()
