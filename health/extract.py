"""Raw extraction: per-unit aligned time-series frame on a common 30s grid."""
import pandas as pd

from anedya import fetch_raw_day
from config import BOUNDS, RAW_VARS, RESAMPLE


def build_frame(unit: int, days: list[str], progress=print) -> pd.DataFrame:
    """Fetch all RAW_VARS for the given UTC days; return one aligned frame.

    Columns are the short names from RAW_VARS; index is a 30s UTC grid.
    Values are bounds-filtered before resampling so a -273 artifact can't
    poison a grid cell.
    """
    cols = {}
    for ident, short in RAW_VARS.items():
        parts = []
        for day in sorted(days):
            df = fetch_raw_day(unit, ident, day)
            if not df.empty:
                parts.append(df)
        if not parts:
            continue
        s = pd.concat(parts, ignore_index=True)
        s["value"] = pd.to_numeric(s["value"], errors="coerce")
        lo, hi = BOUNDS[short]
        s = s[(s["value"] >= lo) & (s["value"] <= hi)]
        if s.empty:
            continue
        ser = (
            s.set_index("ts")["value"]
            .sort_index()
            .resample(RESAMPLE)
            .mean()
        )
        cols[short] = ser
        progress(f"  u{unit} {short}: {len(s)} pts")

    if not cols:
        return pd.DataFrame()
    return pd.DataFrame(cols).sort_index()
