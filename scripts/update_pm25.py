#!/usr/bin/env python3
"""Archive hourly PM2.5 concentrations from Air Quality Ontario (MECP).

Ontario's AQHI+ — the uncapped index the province adopted in May 2024 and
that media report during smoke events — is ceil(1-hour PM2.5 / 10). MECP
publishes no API and ECCC's feed caps AQHI at "10+" (encoded 11), so this
script scrapes the hourly pollutant-concentration summary page (which
accepts historical day/hour queries) and stores raw PM2.5 per station in
data/archive/pm25.json. The dashboard derives AQHI+ client-side.

Stdlib only — safe to run in a bare GitHub Actions runner.
Usage: update_pm25.py [--backfill HOURS]   (default 4, to catch late postings)
"""

import html
import json
import math
import os
import re
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

SUMMARY = "https://www.airqualityontario.com/history/summary.php"
ARCHIVE = os.path.join(
    os.path.dirname(__file__), "..", "data", "archive", "pm25.json"
)
RETENTION_DAYS = 9
TORONTO = ZoneInfo("America/Toronto")


def fetch_hour(local_dt):
    """PM2.5 by station name for one local (America/Toronto) hour, or {}."""
    url = (
        f"{SUMMARY}?start_day={local_dt.day:02d}&start_month={local_dt.month:02d}"
        f"&start_year={local_dt.year}&my_hour={local_dt.hour}&Submit=Update"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "aqhi-dashboard-archiver"})
    with urllib.request.urlopen(req, timeout=60) as res:
        page = res.read().decode("utf-8", "replace")

    out = {}
    header_seen = False
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", page, re.S):
        cells = [
            html.unescape(re.sub(r"<[^>]+>", "", c)).strip()
            for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row, re.S)
        ]
        if len(cells) < 3:
            continue
        if cells[0] == "Station":
            # Guard against MECP reordering columns.
            if not cells[2].startswith("PM2.5"):
                raise RuntimeError(f"unexpected summary columns: {cells}")
            header_seen = True
            continue
        try:
            out[cells[0]] = float(cells[2])
        except ValueError:
            continue  # '\xa0' / blank: station not reporting PM2.5
    if not header_seen:
        raise RuntimeError("summary table not found — page format changed?")
    return out


def main() -> int:
    backfill = 4
    if "--backfill" in sys.argv:
        backfill = int(sys.argv[sys.argv.index("--backfill") + 1])

    archive = {"pm25": {}}
    if os.path.exists(ARCHIVE):
        with open(ARCHIVE) as f:
            archive = json.load(f)
    pm25 = archive.setdefault("pm25", {})

    # Walk back from the most recent completed hour; the page lags ~1 h.
    now_utc = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    added = 0
    for back in range(1, backfill + 1):
        hour_utc = now_utc - timedelta(hours=back)
        iso = hour_utc.strftime("%Y-%m-%dT%H:%M:%SZ")
        try:
            readings = fetch_hour(hour_utc.astimezone(TORONTO))
        except Exception as err:  # noqa: BLE001 — a bad hour must not kill the run
            print(f"warn: {iso}: {err}", file=sys.stderr)
            continue
        for station, value in readings.items():
            series = pm25.setdefault(station, {})
            if iso not in series:
                added += 1
            series[iso] = value
        if back < backfill:
            time.sleep(0.5)  # be polite on long backfills

    cutoff = (
        datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS)
    ).strftime("%Y-%m-%dT%H:%M:%SZ")
    pruned = 0
    for series in pm25.values():
        stale = [t for t in series if t < cutoff]
        for t in stale:
            del series[t]
            pruned += 1

    archive["updated"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    os.makedirs(os.path.dirname(ARCHIVE), exist_ok=True)
    with open(ARCHIVE, "w") as f:
        json.dump(archive, f, separators=(",", ":"), sort_keys=True)

    total = sum(len(s) for s in pm25.values())
    peak = max(
        (v for s in pm25.values() for v in s.values()), default=0
    )
    print(
        f"added {added}, pruned {pruned}, total {total} readings; "
        f"max PM2.5 {peak} (AQHI+ {math.ceil(peak / 10) if peak else 0})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
