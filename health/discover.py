"""Fleet discovery: which units have data, when, and how much TEC activity.

Uses hourly aggregates (cheap) over a trailing window, builds an activity
calendar per unit, and writes out/discovery.json.
"active day" = any hour with mean duty > 50 (TEC did real work that day).
"""
import json
import sys
import time
from datetime import datetime, timedelta, timezone

import pandas as pd

from anedya import fetch_agg
from config import DISCOVERY_VARS, NODES, OUT_DIR


def discover_unit(unit: int, days_back: int) -> dict:
    now = datetime.now(timezone.utc)
    t_end = int(now.timestamp())
    t_start = int((now - timedelta(days=days_back)).timestamp())

    frames = {}
    for var in DISCOVERY_VARS:
        parts = []
        w0 = t_start
        while w0 < t_end:
            w1 = min(w0 + 30 * 86400, t_end)
            parts.append(fetch_agg(unit, var, w0, w1, 60))
            w0 = w1
        df = pd.concat(parts, ignore_index=True) if parts else pd.DataFrame()
        if not df.empty:
            df = df.drop_duplicates("ts").set_index("ts").sort_index()
        frames[var] = df

    duty = frames["TECdutycycle"]
    if duty.empty:
        return {"days": {}, "active_days": 0, "first": None, "last": None}

    cal = {}
    by_day = duty.groupby(duty.index.date)
    pcb = frames["PCBTemp"]
    ib = frames["BATTERYCURRENT"]
    for day, grp in by_day:
        d = str(day)
        sel_pcb = pcb[pcb.index.date == day]["value"] if not pcb.empty else pd.Series(dtype=float)
        sel_ib = ib[ib.index.date == day]["value"] if not ib.empty else pd.Series(dtype=float)
        cal[d] = {
            "hours": int(len(grp)),
            "duty_frac": round(float(grp["value"].mean()) / 4090, 3),
            "duty_hours": int((grp["value"] > 50).sum()),
            "pcb": round(float(sel_pcb.mean()), 1) if len(sel_pcb) else None,
            "ibatt": round(float(sel_ib.mean()), 2) if len(sel_ib) else None,
        }

    active = [d for d, v in cal.items() if v["duty_hours"] > 0]
    return {
        "days": cal,
        "active_days": len(active),
        "first": min(cal) if cal else None,
        "last": max(cal) if cal else None,
    }


def main(days_back: int = 180):
    result = {}
    t0 = time.time()
    for unit in sorted(NODES):
        try:
            info = discover_unit(unit, days_back)
        except Exception as e:  # noqa: BLE001 — keep sweeping other units
            print(f"unit {unit}: ERROR {e}", flush=True)
            result[str(unit)] = {"error": str(e)}
            continue
        result[str(unit)] = info
        print(
            f"unit {unit:>2}: {info['active_days']:>3} active days "
            f"({info['first']} → {info['last']})"
            if info["days"]
            else f"unit {unit:>2}: no data in window",
            flush=True,
        )

    OUT_DIR.mkdir(exist_ok=True, parents=True)
    (OUT_DIR / "discovery.json").write_text(json.dumps(result, indent=1))
    print(f"\nwrote out/discovery.json in {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 180)
