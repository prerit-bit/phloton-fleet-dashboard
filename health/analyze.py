"""Tier-1 analysis v2: regime-aware segmentation + per-unit parameter fits.

Lumped model:   C * dT_flask/dt = K * (T_amb - T_flask) - Q_c(t)

Segments are contiguous telemetry blocks split at gaps > MAX_GAP_S, then at
sustained on/off transitions of the smoothed duty signal. Runs shorter than
MIN_SEG_MIN are absorbed into CYCLING segments. Each segment is classified
PULLDOWN / HOLD / FUTILE / COAST. An overnight estimator brackets K/C across
unlogged dark periods via Newton's law between the endpoints.
"""
import json
import sys
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd

from config import DUTY_ON, MAX_GAP_S, MIN_SEG_MIN, OUT_DIR
from extract import build_frame

GRID_S = 30  # must match config.RESAMPLE


# ─── Segmentation ────────────────────────────────────────────────────────────

def _classify(state: str, duty_frac: float, f0: float, f1: float,
              slope: float) -> str:
    if state == "COAST" or duty_frac < 0.10:
        return "COAST"
    if f1 - f0 < -3.0:
        return "PULLDOWN"
    if f0 > 10 and slope > -1.0:
        return "FUTILE"
    return "HOLD"


def segments(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty or "duty" not in df:
        return pd.DataFrame()

    d = df.copy()
    for col in ("flask", "pcb", "hs", "cs"):
        if col in d:
            d[col] = d[col].interpolate(limit=4)
    d["duty"] = d["duty"].ffill(limit=4)

    alive = d["duty"].notna() | d.get("flask", pd.Series(index=d.index)).notna()
    gap_id = (~alive).cumsum()
    d = d[alive]
    if d.empty:
        return pd.DataFrame()

    on = (d["duty"].fillna(0).rolling(5, min_periods=1).mean() > DUTY_ON * 0.5)
    block = gap_id.loc[d.index]
    min_rows = int(MIN_SEG_MIN * 60 / GRID_S)

    rows = []
    for _, blk in d.groupby(block):
        if len(blk) < min_rows:
            continue
        blk_on = on.loc[blk.index]
        blk_run = (blk_on != blk_on.shift()).cumsum()
        runs = [
            ("COOL" if blk_on.loc[sub.index[0]] else "COAST", sub)
            for _, sub in blk.groupby(blk_run)
        ]
        i = 0
        while i < len(runs):
            st, sub = runs[i]
            if len(sub) >= min_rows:
                rows.append(_seg_features(st, sub))
                i += 1
            else:
                acc = []
                while i < len(runs) and len(runs[i][1]) < min_rows:
                    acc.append(runs[i][1])
                    i += 1
                cyc = pd.concat(acc)
                if len(cyc) >= min_rows:
                    rows.append(_seg_features("CYCLING", cyc))

    return pd.DataFrame([r for r in rows if r])


def _seg_features(state: str, seg: pd.DataFrame) -> dict | None:
    if "flask" not in seg:
        return None
    flask = seg["flask"].dropna()
    if len(flask) < 10:
        return None
    dur_min = len(seg) * GRID_S / 60
    t = (flask.index - flask.index[0]).total_seconds().to_numpy()
    slope = float(np.polyfit(t, flask.to_numpy(), 1)[0]) * 3600  # °C/hr

    def m(col):
        return float(seg[col].mean()) if col in seg and seg[col].notna().any() else np.nan

    duty_frac = float((seg["duty"].fillna(0) / 4090).mean())
    ibatt, vbatt = m("ibatt"), m("vbatt")
    p_w = vbatt * max(0.0, -ibatt) if ibatt == ibatt and vbatt == vbatt else np.nan
    f0, f1 = float(flask.iloc[0]), float(flask.iloc[-1])
    mode = _classify(state, duty_frac, f0, f1, slope)
    return {
        "mode": mode,
        "start": seg.index[0],
        "dur_min": round(dur_min, 1),
        "duty_frac": round(duty_frac, 3),
        "flask0": round(f0, 2), "flask1": round(f1, 2),
        "slope_C_hr": round(slope, 2),
        "pcb": round(m("pcb"), 2), "hs": round(m("hs"), 2), "cs": round(m("cs"), 2),
        "amb_delta": round(m("pcb") - float(flask.mean()), 2),
        "flask_cs_delta": round(float(flask.mean()) - m("cs"), 2),
        "vbatt": round(vbatt, 2) if vbatt == vbatt else np.nan,
        "ibatt": round(ibatt, 2) if ibatt == ibatt else np.nan,
        "p_w": round(p_w, 1) if p_w == p_w else np.nan,
        "on_batt": bool(vbatt < 12.45 and ibatt < -0.3) if vbatt == vbatt and ibatt == ibatt else False,
        "soc0": round(float(seg["soc"].dropna().iloc[0]), 1) if "soc" in seg and seg["soc"].notna().any() else np.nan,
    }


# ─── Overnight K/C from day-boundary endpoints ──────────────────────────────

def overnight_kc(df: pd.DataFrame) -> list[dict]:
    """Newton-law estimate across unlogged dark periods (unit off overnight)."""
    if df.empty or "flask" not in df:
        return []
    alive = df["flask"].notna()
    d = df[alive]
    if d.empty:
        return []
    gaps = d.index.to_series().diff().dt.total_seconds()
    out = []
    for i in np.where(gaps > 3 * 3600)[0]:
        t0, t1 = d.index[i - 1], d.index[i]
        T0, T1 = float(d["flask"].iloc[i - 1]), float(d["flask"].iloc[i])
        hrs = (t1 - t0).total_seconds() / 3600
        if not (3 <= hrs <= 18) or T1 - T0 < 5:
            continue
        Tamb = float(d["pcb"].iloc[i]) if "pcb" in d and d["pcb"].notna().iloc[i] else np.nan
        if Tamb != Tamb or Tamb - T1 < 1 or Tamb - T0 < 2:
            continue
        a = -np.log((Tamb - T1) / (Tamb - T0)) / hrs  # 1/hr
        if 0.005 < a < 2:
            out.append({"start": str(t0), "hours": round(hrs, 1),
                        "T0": T0, "T1": T1, "Tamb": Tamb,
                        "KC_per_hr": round(float(a), 4)})
    return out


# ─── Discovery helper ────────────────────────────────────────────────────────

def active_days(unit: int, min_duty_hours: int = 1, last_n: int | None = None) -> list[str]:
    disc = json.loads((OUT_DIR / "discovery.json").read_text())
    info = disc.get(str(unit), {})
    days = sorted(d for d, v in info.get("days", {}).items()
                  if isinstance(v, dict) and v.get("duty_hours", 0) >= min_duty_hours)
    return days[-last_n:] if last_n else days
