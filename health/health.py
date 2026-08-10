"""Device-health model v1: physics-anchored indicators + drift detection.

No labeled failures exist for this fleet (~16 units with history), so this is
deliberately NOT a supervised classifier. Instead:

  Layer 1  daily Health Indicators (HIs) per unit — each one a physical
           parameter whose drift IS a failure mode developing
  Layer 2  three detectors per HI series: EWMA control chart (slow drift),
           robust fleet z-score (outlier today), Theil-Sen trend →
           days-to-threshold "runway"
  Layer 3  composite 0-100 health score (clipped-z RMS, always reported
           with the contributing indicator)

Backtest: run over all Anedya history; check flags against known ground
truth (u28/u21 insulation, u13 missing flask sensor, u14 futile-burn era,
dark units fading before death).

Usage:
  python3 health.py backtest
  python3 health.py unit 21
"""
import json
import sys
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd

from analyze import GRID_S, active_days, overnight_kc, segments
from anedya import fetch_raw_day
from config import BOUNDS, OUT_DIR, RAW_VARS
from extract import build_frame

HEALTH_DIR = OUT_DIR / "health"

RUNWAY = {
    "tau_hr":        {"thr": 2.5,  "dir": -1},   # insulation
    "hs_rise":       {"thr": 12.0, "dir": +1},   # hot side
    "r_int":         {"thr": 0.30, "dir": +1},   # battery ohms
    "duty_per_dT":   {"thr": 0.035,"dir": +1},   # cooling efficiency
    "coverage":      {"thr": 0.10, "dir": -1},   # comms
}
KEY_HIS = ["tau_hr", "hs_rise", "r_int", "duty_per_dT", "coverage",
           "sensor_bad_frac", "excursion_min"]


# ─── Layer 1: daily HI extraction ────────────────────────────────────────────

def _sensor_sanity(unit: int, day: str) -> dict:
    """Per-variable raw sanity, computed on UNfiltered cache data."""
    out = {"sensor_bad_frac": 0.0, "missing_vars": []}
    fracs = []
    counts = {}
    for ident, short in RAW_VARS.items():
        df = fetch_raw_day(unit, ident, day)
        counts[short] = len(df)
        if df.empty:
            continue
        lo, hi = BOUNDS[short]
        vals = pd.to_numeric(df["value"], errors="coerce")
        oob = float(((vals < lo) | (vals > hi) | vals.isna()).mean())
        stuck = float(len(vals) > 200 and vals.std() == 0)
        fracs.append(max(oob, stuck))
    alive = max(counts.get("duty", 0), counts.get("vbatt", 0))
    if alive > 500:
        out["missing_vars"] = [s for s, n in counts.items() if n == 0]
    out["sensor_bad_frac"] = round(float(np.mean(fracs)), 4) if fracs else 0.0
    return out


def _battery_r_int(df: pd.DataFrame) -> float | None:
    """Internal resistance from TEC ON-edge voltage sag — every bang-bang
    edge is a free ~5A load-step test (~70/day on active units)."""
    if not {"duty", "vbatt", "ibatt"}.issubset(df.columns):
        return None
    on = df["duty"].fillna(0) > 2000
    edges = df.index[on & ~on.shift(1, fill_value=False)]
    rints = []
    for t in edges:
        pre = df.loc[t - pd.Timedelta(seconds=90): t - pd.Timedelta(seconds=30)]
        post = df.loc[t + pd.Timedelta(seconds=30): t + pd.Timedelta(seconds=120)]
        if len(pre) < 2 or len(post) < 2:
            continue
        dV = float(pre["vbatt"].mean() - post["vbatt"].mean())
        dI = float((-post["ibatt"].mean()) - (-pre["ibatt"].mean()))
        if dI > 2.0 and 0 < dV < 2.0:
            rints.append(dV / dI)
    return round(float(np.median(rints)), 4) if len(rints) >= 3 else None


def day_his(unit: int, day: str) -> dict:
    hi: dict = {"unit": unit, "day": day}
    df = build_frame(unit, [day], progress=lambda s: None)
    if df.empty:
        hi["coverage"] = 0.0
        return hi

    hi["coverage"] = round(len(df) * GRID_S / 86400, 3)
    gaps = df.index.to_series().diff().dt.total_seconds()
    hi["max_gap_hr"] = round(float(gaps.max()) / 3600, 2) if len(gaps) > 1 else None

    seg = segments(df)
    if not seg.empty:
        hold = seg[(seg["mode"] == "HOLD") & (seg.duty_frac < 0.98) & (seg.amb_delta > 5)]
        if len(hold) >= 2:
            hi["duty_per_dT"] = round(float((hold.duty_frac / hold.amb_delta).median()), 4)
        act = seg[seg["mode"].isin(["HOLD", "PULLDOWN", "FUTILE"])]
        if len(act):
            hi["hs_rise"] = round(float((act.hs - act.pcb).median()), 2)
        active_min = float(act.dur_min.sum()) if len(act) else 0
        if active_min > 60 and "flask" in df:
            fl = df["flask"].dropna()
            if len(fl) and fl.median() > 10:
                hi["ineffective_cooling"] = True

    hi["r_int"] = _battery_r_int(df)

    if "flask" in df and df["flask"].notna().any() and "duty" in df:
        duty_active = (df["duty"].fillna(0) > 2000).mean() > 0.05
        if duty_active:
            hi["excursion_min"] = round(float((df["flask"] > 8).sum()) * GRID_S / 60, 0)
            hi["freeze_min"] = round(float((df["flask"] < 2).sum()) * GRID_S / 60, 0)

    hi.update(_sensor_sanity(unit, day))
    return hi


def overnight_tau(unit: int, days: list[str]) -> pd.DataFrame:
    df = build_frame(unit, days, progress=lambda s: None)
    rows = []
    for n in overnight_kc(df):
        rows.append({"day": n["start"][:10], "tau_hr": round(1 / n["KC_per_hr"], 2)})
    return pd.DataFrame(rows)


# ─── Layer 2: detectors ──────────────────────────────────────────────────────

def ewma_drift(s: pd.Series, lam: float = 0.3, L: float = 3.0) -> dict:
    x = s.dropna()
    if len(x) < 6:
        return {"state": "insufficient", "n": int(len(x))}
    k = max(5, len(x) // 3)
    base = x.iloc[:k]
    med = float(base.median())
    mad = float((base - base.median()).abs().median()) or 1e-9
    limit = L * 1.4826 * mad * np.sqrt(lam / (2 - lam))
    e, first = med, None
    baseline_days = set(x.index[:k])
    for day, v in x.items():
        e = lam * v + (1 - lam) * e
        if abs(e - med) > limit and first is None and day not in baseline_days:
            first = day
    return {
        "state": "drift" if first is not None else "stable",
        "first_flag": str(first) if first is not None else None,
        "baseline": round(med, 4), "current_ewma": round(float(e), 4),
        "n": int(len(x)),
    }


MAD_FLOOR = {  # absolute floors so a near-degenerate fleet spread can't
    "sensor_bad_frac": 0.01,   # explode z-scores (backtest v1 hit +6e7 sigma)
    "excursion_min": 30.0,
    "coverage": 0.05,
    "tau_hr": 0.5,
    "hs_rise": 0.5,
    "r_int": 0.02,
    "duty_per_dT": 0.002,
}

def fleet_z(latest: pd.DataFrame, col: str) -> pd.Series:
    v = latest[col].dropna()
    if len(v) < 4:
        return pd.Series(dtype=float)
    med = float(v.median())
    mad = max(float((v - med).abs().median()), MAD_FLOOR.get(col, 1e-9))
    return ((v - med) / (1.4826 * mad)).round(2)


def runway(s: pd.Series, hi_name: str) -> dict | None:
    spec = RUNWAY.get(hi_name)
    x = s.dropna().tail(21)
    if spec is None or len(x) < 6:
        return None
    days = np.array([(pd.Timestamp(d) - pd.Timestamp(x.index[0])).days for d in x.index])
    vals = x.to_numpy(dtype=float)
    slopes = [
        (vals[j] - vals[i]) / (days[j] - days[i])
        for i in range(len(x)) for j in range(i + 1, len(x)) if days[j] > days[i]
    ]
    if not slopes:
        return None
    slope = float(np.median(slopes))
    cur = float(vals[-1])
    thr, direction = spec["thr"], spec["dir"]
    if direction * slope <= 0:
        return None
    gap = (thr - cur) * direction
    if gap <= 0:
        return {"days_to_threshold": 0, "slope_per_day": round(slope, 5)}
    return {
        "days_to_threshold": int(gap / (direction * slope)),
        "slope_per_day": round(slope, 5),
    }


def composite_score(zrow: dict) -> int:
    zs = [min(abs(z), 4.0) for z in zrow.values() if z == z]
    if not zs:
        return 100
    return int(round(100 - (np.sqrt(np.mean(np.square(zs))) / 4.0) * 100))


# ─── Orchestration ───────────────────────────────────────────────────────────

def unit_history(unit: int) -> pd.DataFrame:
    # min_duty_hours=0: sensor & comms indicators must see every reporting
    # day, not only TEC-active ones (v1 missed u13's vanished flask sensor
    # because its recent days had no cooling activity).
    days = active_days(unit, min_duty_hours=0)
    if not days:
        return pd.DataFrame()
    rows = [day_his(unit, d) for d in days]
    hi = pd.DataFrame(rows).set_index("day")
    tau = overnight_tau(unit, days)
    if not tau.empty:
        hi = hi.join(tau.groupby("day").tau_hr.median(), how="left")
    return hi


def backtest():
    HEALTH_DIR.mkdir(exist_ok=True, parents=True)
    disc = json.loads((OUT_DIR / "discovery.json").read_text())
    units = sorted(int(u) for u, v in disc.items()
                   if isinstance(v, dict) and v.get("active_days", 0) >= 2)

    latest_rows, report = [], {}
    for u in units:
        try:
            hi = unit_history(u)
        except Exception as e:  # noqa: BLE001
            print(f"unit {u}: ERROR {e}", flush=True)
            continue
        if hi.empty:
            continue
        hi.to_csv(HEALTH_DIR / f"his_u{u}.csv")
        drift = {c: ewma_drift(hi[c]) for c in KEY_HIS if c in hi}
        runways = {c: runway(hi[c], c) for c in KEY_HIS if c in hi}
        runways = {k: v for k, v in runways.items() if v}
        recent = hi.tail(7)
        SLOW = {"tau_hr", "r_int", "duty_per_dT"}  # sparse estimates — use
        latest = {}                                 # full history, not last-7
        for c in KEY_HIS:
            src = hi if c in SLOW else recent
            latest[c] = float(src[c].median()) if c in src and src[c].notna().any() else np.nan
        missing = set()
        if "missing_vars" in hi:
            for mv in hi["missing_vars"].dropna():
                missing.update(mv if isinstance(mv, list) else [])
        report[u] = {
            "active_days": int(len(hi)),
            "last_day": str(hi.index.max()),
            "drift": {k: v for k, v in drift.items() if v.get("state") == "drift"},
            "runways": runways,
            "always_missing_vars": sorted(missing),
            "ineffective_cooling_days": int(hi["ineffective_cooling"].fillna(False).sum())
            if "ineffective_cooling" in hi else 0,
        }
        latest_rows.append({"unit": u, **latest})
        print(f"unit {u}: {len(hi)} days, drift={list(report[u]['drift'])}, "
              f"runways={list(runways)}", flush=True)

    latest = pd.DataFrame(latest_rows).set_index("unit")
    zcols = {}
    for c in KEY_HIS:
        if c in latest:
            zcols[c] = fleet_z(latest, c)
    z = pd.DataFrame(zcols)
    for u in report:
        zrow = z.loc[u].to_dict() if u in z.index else {}
        report[u]["fleet_z"] = {k: v for k, v in zrow.items() if v == v}
        report[u]["health_score"] = composite_score(zrow)

    (HEALTH_DIR / "backtest_report.json").write_text(json.dumps(report, indent=1, default=str))
    latest.to_csv(HEALTH_DIR / "fleet_latest.csv")
    print("\nwrote out/health/backtest_report.json + fleet_latest.csv + his_u*.csv")




# ─── Layer 3: publish to Supabase (unit_health, 29 rows) ─────────────────────

FRIENDLY = {
    "tau_hr": ("Insulation holding time", "h", -1),
    "hs_rise": ("Heatsink rise over ambient", "°C", +1),
    "r_int": ("Battery internal resistance", "Ω", +1),
    "duty_per_dT": ("Cooling effort per °C of lift", "", +1),
    "coverage": ("Telemetry coverage", "", -1),
    "sensor_bad_frac": ("Bad/stuck sensor readings", "", +1),
    "excursion_min": ("Daily minutes above 8°C while cooling", "min", +1),
}
VAR_FRIENDLY = {"flask": "flask temperature", "ibatt": "battery current",
                "hs": "heatsink temperature", "cs": "cold-sink temperature",
                "pcb": "ambient temperature", "vbatt": "battery voltage",
                "soc": "battery SoC", "duty": "TEC duty"}


def _concerns(d: dict) -> list:
    out = []
    for hi, rw in (d.get("runways") or {}).items():
        days = rw.get("days_to_threshold")
        if days is not None and days <= 120:
            label = FRIENDLY.get(hi, (hi,))[0]
            sev = "high" if days <= 30 else "medium"
            out.append({"severity": sev,
                        "text": f"{label} trending toward its alarm level — about {days} days at the current rate"})
    for hi, z in (d.get("fleet_z") or {}).items():
        label, _, bad_dir = FRIENDLY.get(hi, (hi, "", +1))
        if z * bad_dir >= 2:
            sev = "high" if abs(z) >= 3 else "medium"
            side = "worst" if True else ""
            out.append({"severity": sev,
                        "text": f"{label} is {abs(z):.1f}σ on the bad side of the fleet norm"})
    for hi, dr in (d.get("drift") or {}).items():
        label = FRIENDLY.get(hi, (hi,))[0]
        out.append({"severity": "low",
                    "text": f"{label} has drifted from this unit's own baseline (since {dr.get('first_flag')})"})
    for v in d.get("always_missing_vars") or []:
        out.append({"severity": "high",
                    "text": f"Sensor not reporting at all: {VAR_FRIENDLY.get(v, v)}"})
    fut = d.get("ineffective_cooling_days") or 0
    if fut >= 2:
        out.append({"severity": "medium",
                    "text": f"{fut} day(s) spent cooling with no measurable effect (battery burned, flask never cooled)"})
    rank = {"high": 0, "medium": 1, "low": 2}
    out.sort(key=lambda c: rank[c["severity"]])
    return out[:6]


def _status(score, concerns) -> str:
    if score is None:
        return "no_data"
    if any(c["severity"] == "high" for c in concerns) or score < 50:
        return "action"
    if score < 70:
        return "degraded"
    if score < 85 or concerns:
        return "watch"
    return "ok"


def publish():
    """Refresh the model, then upsert one row per fleet unit to Supabase."""
    import requests as rq
    from config import NODES, SUPABASE_SERVICE_KEY, SUPABASE_URL

    # Reuse a fresh report (re-dispatch friendly); recompute past 12h.
    rep = HEALTH_DIR / "backtest_report.json"
    stale = True
    if rep.exists():
        age_h = (datetime.now(timezone.utc).timestamp() - rep.stat().st_mtime) / 3600
        stale = age_h > 12
    if stale:
        backtest()
    r = json.loads(rep.read_text())
    latest = pd.read_csv(HEALTH_DIR / "fleet_latest.csv").set_index("unit")

    rows = []
    now = datetime.now(timezone.utc).isoformat()
    for unit in sorted(NODES):
        d = r.get(str(unit))
        if not d:
            rows.append({"unit_number": unit, "health_score": None,
                         "status": "no_data", "computed_at": now,
                         "concerns": [{"severity": "high",
                                       "text": "No telemetry in the analysis window"}],
                         "indicators": {}})
            continue
        concerns = _concerns(d)
        score = d.get("health_score")
        ind = {}
        if unit in latest.index:
            for k, v in latest.loc[unit].items():
                if v == v:
                    ind[k] = round(float(v), 4)
        ind["fleet_z"] = d.get("fleet_z", {})
        ind["runways"] = d.get("runways", {})
        rows.append({
            "unit_number": unit,
            "health_score": score,
            "status": _status(score, concerns),
            "computed_at": now,
            "last_data_day": d.get("last_day"),
            "active_days": d.get("active_days"),
            "concerns": concerns,
            "indicators": ind,
        })

    resp = rq.post(
        f"{SUPABASE_URL}/rest/v1/unit_health",
        headers={
            "apikey": SUPABASE_SERVICE_KEY,
            "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates",
        },
        json=rows, timeout=30,
    )
    resp.raise_for_status()
    print(f"published {len(rows)} unit_health rows "
          f"({sum(1 for x in rows if x['status'] != 'no_data')} scored)")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "backtest":
        backtest()
    elif len(sys.argv) > 1 and sys.argv[1] == "publish":
        publish()
    elif len(sys.argv) > 2 and sys.argv[1] == "unit":
        print(unit_history(int(sys.argv[2])).to_string())
    else:
        print(__doc__)
