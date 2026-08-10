"""Health pipeline config — env-first so it runs on GitHub Actions,
falling back to the dashboard's .env.local for local runs."""
import json
import os
from pathlib import Path

ROOT = Path(__file__).parent
CACHE_DIR = ROOT / "data" / "cache"
OUT_DIR = ROOT / "out"
CACHE_DIR.mkdir(parents=True, exist_ok=True)
OUT_DIR.mkdir(parents=True, exist_ok=True)

_ENV_FILE = ROOT.parent / ".env.local"


def _file_env() -> dict:
    if not _ENV_FILE.exists():
        return {}
    env = {}
    for line in _ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        env[k.strip()] = v.strip()
    return env


_f = _file_env()


def _get(*names: str) -> str:
    for n in names:
        v = os.environ.get(n) or _f.get(n)
        if v:
            return v
    raise KeyError(f"none of {names} set in env or .env.local")


API_KEY = _get("ANEDYA_API_KEY", "NEXT_PUBLIC_ANEDYA_API_KEY")
NODES = {
    int(k.replace("node_", "")): v
    for k, v in json.loads(_get("NEXT_PUBLIC_NODES_ID")).items()
}
SUPABASE_URL = _get("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_SERVICE_KEY = _get("SUPABASE_SERVICE_ROLE_KEY")

RAW_VARS = {
    "TECdutycycle": "duty",
    "FlaskTopTemp": "flask",
    "HeatSinkTemp": "hs",
    "ColdSinkTemp": "cs",
    "PCBTemp": "pcb",
    "BATTERYCURRENT": "ibatt",
    "BATTVOLT": "vbatt",
    "SOC": "soc",
}
DISCOVERY_VARS = ["TECdutycycle", "PCBTemp", "BATTERYCURRENT", "FlaskTopTemp"]

BOUNDS = {
    "duty": (0, 4095),
    "flask": (-30, 80),
    "hs": (-30, 100),
    "cs": (-30, 80),
    "pcb": (-30, 80),
    "ibatt": (-15, 15),
    "vbatt": (7.0, 13.0),
    "soc": (0, 100),
}

DUTY_ON = 2000
RESAMPLE = "30s"
MIN_SEG_MIN = 8.0
MAX_GAP_S = 120
