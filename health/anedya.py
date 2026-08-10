"""Anedya API client with retry, truncation-guarded chunking, and disk cache.

Anedya /data/getData silently truncates somewhere past ~10k rows per request,
so raw pulls are chunked and any chunk that returns suspiciously many rows is
split recursively. Completed UTC days are cached as csv.gz; today is never
cached (still growing).
"""
import gzip
import time
from datetime import datetime, timedelta, timezone

import pandas as pd
import requests

from config import API_KEY, CACHE_DIR, NODES

BASE = "https://api.anedya.io/v1"
TRUNCATION_SUSPECT = 9000
REQUEST_DELAY = 0.15
_session = requests.Session()


def _post(endpoint: str, body: dict, tries: int = 4):
    for attempt in range(1, tries + 1):
        try:
            r = _session.post(
                f"{BASE}{endpoint}",
                json=body,
                headers={"Authorization": f"Bearer {API_KEY}"},
                timeout=30,
            )
            if r.status_code == 200:
                return r.json()
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(attempt * 2.0)
                continue
            raise RuntimeError(f"{endpoint} -> HTTP {r.status_code}: {r.text[:200]}")
        except requests.RequestException:
            if attempt == tries:
                raise
            time.sleep(attempt * 2.0)
    return None


def _fetch_raw_window(node_id: str, variable: str, t0: int, t1: int) -> list:
    """Raw points in [t0, t1); recursively splits windows that look truncated."""
    data = _post(
        "/data/getData",
        {"variable": variable, "nodes": [node_id], "from": t0, "to": t1,
         "order": "asc"},
    )
    time.sleep(REQUEST_DELAY)
    pts = (data or {}).get("data", {}).get(node_id, []) or []
    if len(pts) >= TRUNCATION_SUSPECT and (t1 - t0) > 900:
        mid = (t0 + t1) // 2
        return _fetch_raw_window(node_id, variable, t0, mid) + _fetch_raw_window(
            node_id, variable, mid, t1
        )
    return pts


def fetch_raw_day(unit: int, variable: str, day: str) -> pd.DataFrame:
    """One UTC day of raw data for (unit, variable). Cached once the day ends."""
    cache = CACHE_DIR / f"u{unit}_{variable}_{day}.csv.gz"
    if cache.exists():
        return pd.read_csv(cache, parse_dates=["ts"])

    d0 = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    t0, t1 = int(d0.timestamp()), int((d0 + timedelta(days=1)).timestamp())
    # Anedya rejects ranges touching the future; clamp today's window to now.
    t1 = min(t1, int(time.time()) - 30)
    if t0 >= t1:
        return pd.DataFrame(columns=["ts", "value"])
    pts = _fetch_raw_window(NODES[unit], variable, t0, t1)
    df = pd.DataFrame(pts)
    if not df.empty:
        df = df.drop_duplicates("timestamp").sort_values("timestamp")
        df["ts"] = pd.to_datetime(df["timestamp"], unit="s", utc=True)
        df = df[["ts", "value"]]
    else:
        df = pd.DataFrame(columns=["ts", "value"])

    day_is_complete = t1 >= int(d0.timestamp()) + 86400 - 60
    if day_is_complete:
        with gzip.open(cache, "wt") as f:
            df.to_csv(f, index=False)
    return df


def fetch_agg(unit: int, variable: str, t0: int, t1: int,
              interval_mins: int = 60) -> pd.DataFrame:
    """Aggregated (avg) buckets — cheap discovery over long ranges."""
    data = _post(
        "/aggregates/variable/byTime",
        {
            "variable": variable, "from": t0, "to": t1,
            "config": {
                "aggregation": {"compute": "avg", "forEachNode": True},
                "interval": {"measure": "minute", "interval": interval_mins},
                "responseOptions": {"timezone": "UTC"},
                "filter": {"nodes": [NODES[unit]], "type": "include"},
            },
        },
    )
    time.sleep(REQUEST_DELAY)
    rows = []
    for _, entries in ((data or {}).get("data") or {}).items():
        for e in entries:
            ts = e["timestamp"]
            ts = ts / 1000 if ts > 1e12 else ts
            # raw endpoint says "value"; aggregate endpoint says "aggregate"
            rows.append({"ts": ts, "value": e.get("aggregate", e.get("value"))})
    df = pd.DataFrame(rows)
    if not df.empty:
        df["ts"] = pd.to_datetime(df["ts"], unit="s", utc=True)
        df = df.drop_duplicates("ts").sort_values("ts").reset_index(drop=True)
    return df
