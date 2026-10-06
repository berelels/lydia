import json
import os
from pathlib import Path

DEFAULTS = {
    "ram_threshold_percent": 85,
    "check_interval_seconds": 5,
    "consecutive_checks": 2,
    "alert_cooldown_seconds": 300,
    "bubble_seconds": 9,
}


def config_path() -> Path:
    base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    return base / "lydia" / "config.json"


def load() -> dict:
    """Defaults, overridden by ~/.config/lydia/config.json (created on first run)."""
    path = config_path()
    cfg = dict(DEFAULTS)
    try:
        user = json.loads(path.read_text())
        for key, default in DEFAULTS.items():
            value = user.get(key, default)
            if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
                cfg[key] = value
    except FileNotFoundError:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(DEFAULTS, indent=2) + "\n")
        except OSError:
            pass
    except (OSError, ValueError):
        pass
    return cfg
