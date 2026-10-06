import time
from collections import defaultdict

import psutil

GB = 1024 ** 3


class RamMonitor:
    """Polls memory use and says when Lydia should speak up."""

    def __init__(self, cfg: dict):
        self.threshold = float(cfg["ram_threshold_percent"])
        self.needed = int(cfg["consecutive_checks"])
        self.cooldown = float(cfg["alert_cooldown_seconds"])
        self._streak = 0
        self._alerted = False
        self._last_alert_at = 0.0
        self._last_alert_percent = 0.0

    def top_consumers(self, n: int = 3) -> list[tuple[str, float]]:
        """Biggest users by name (all of Firefox's processes count as one)."""
        totals: dict[str, int] = defaultdict(int)
        for proc in psutil.process_iter(["name", "memory_info"]):
            info = proc.info
            if info["memory_info"] is not None:
                totals[info["name"] or "?"] += info["memory_info"].rss
        ranked = sorted(totals.items(), key=lambda kv: kv[1], reverse=True)[:n]
        return [(name, size / GB) for name, size in ranked]

    def summary(self) -> str:
        mem = psutil.virtual_memory()
        top = ", ".join(f"{name} {gb:.1f} GB" for name, gb in self.top_consumers())
        return f"RAM em {mem.percent:.0f}% ({mem.used / GB:.1f} de {mem.total / GB:.1f} GB)\nMaiores: {top}"

    def poll(self) -> dict:
        """-> {"percent", "over", "event": None | "alert" | "recovered"}"""
        percent = psutil.virtual_memory().percent
        over = percent >= self.threshold
        now = time.monotonic()
        event = None

        self._streak = self._streak + 1 if over else 0
        if over and self._streak >= self.needed:
            first = not self._alerted and now - self._last_alert_at >= self.cooldown
            worse = self._alerted and percent >= self._last_alert_percent + 5 and now - self._last_alert_at >= 60
            if first or worse:
                event = "alert"
                self._alerted = True
                self._last_alert_at = now
                self._last_alert_percent = percent
        elif self._alerted and percent < self.threshold - 5:
            event = "recovered"
            self._alerted = False
        return {"percent": percent, "over": over, "event": event}
