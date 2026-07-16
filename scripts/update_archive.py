#!/usr/bin/env python3
"""Archive Ontario AQHI observations from the ECCC GeoMet API.

The realtime API only retains ~3 days of hourly observations. This script
merges the current window into data/archive/observations.json and prunes
anything older than RETENTION_DAYS, so the dashboard can show up to a week
of history once the scheduled job has been running that long.

Stdlib only — safe to run in a bare GitHub Actions runner.
"""

import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

API = (
    "https://api.weather.gc.ca/collections/aqhi-observations-realtime/items"
    "?f=json&bbox=-96,41,-73.9,57&limit=9000"
    "&properties=location_id,observation_datetime,aqhi"
)
ARCHIVE = os.path.join(
    os.path.dirname(__file__), "..", "data", "archive", "observations.json"
)
RETENTION_DAYS = 9


def main() -> int:
    req = urllib.request.Request(API, headers={"User-Agent": "aqhi-dashboard-archiver"})
    with urllib.request.urlopen(req, timeout=60) as res:
        data = json.load(res)

    archive = {"obs": {}}
    if os.path.exists(ARCHIVE):
        with open(ARCHIVE) as f:
            archive = json.load(f)
    obs = archive.setdefault("obs", {})

    added = 0
    for feature in data.get("features", []):
        p = feature["properties"]
        t, v = p.get("observation_datetime"), p.get("aqhi")
        if not t or v is None:
            continue
        station = obs.setdefault(p["location_id"], {})
        if t not in station:
            added += 1
        station[t] = v

    cutoff = (
        datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS)
    ).strftime("%Y-%m-%dT%H:%M:%SZ")
    pruned = 0
    for station in obs.values():
        stale = [t for t in station if t < cutoff]
        for t in stale:
            del station[t]
            pruned += 1

    archive["updated"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    os.makedirs(os.path.dirname(ARCHIVE), exist_ok=True)
    with open(ARCHIVE, "w") as f:
        json.dump(archive, f, separators=(",", ":"), sort_keys=True)

    total = sum(len(s) for s in obs.values())
    print(f"added {added}, pruned {pruned}, total {total} observations")
    return 0


if __name__ == "__main__":
    sys.exit(main())
