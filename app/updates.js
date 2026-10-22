/**
 * Is there a newer Lydia? Once a day she asks GitHub for the latest release
 * (one request to api.github.com, nothing about the user is sent) and says so
 * once per version. The Flatpak is updated by the store, so it never asks.
 */

const REPO = 'berelels/lydia';
const PAGE = `https://github.com/${REPO}/releases/latest`;
const DAY = 24 * 3600_000;

/** "v1.2.0" / "1.2" -> [1, 2, 0] */
const parts = (v) => String(v).replace(/^v/i, '').split(/[.-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
/** a > b, as versions */
function newer(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

async function latest() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return null; // no release yet, or the repository is private
  const r = await res.json();
  return r.draft || r.prerelease ? null : { version: String(r.tag_name).replace(/^v/i, ''), url: r.html_url || PAGE };
}

/**
 * Checks now and then every day. onNew({ version, url }) only for a version
 * newer than `current` and not already told (seen() / tell(version) keep that).
 */
function watch({ current, seen, tell, onNew }) {
  if (process.env.FLATPAK_ID) return () => {};
  const check = async () => {
    try {
      const r = await latest();
      if (r && newer(r.version, current) && seen() !== r.version) {
        tell(r.version);
        onNew(r);
      }
    } catch {} // offline: next time
  };
  const first = setTimeout(check, 60_000); // not in the way of starting up
  const daily = setInterval(check, DAY);
  return () => (clearTimeout(first), clearInterval(daily));
}

module.exports = { watch, newer, PAGE };
