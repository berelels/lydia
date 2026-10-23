/**
 * The weather where the user is, for the Today tab and the clock on the bar.
 * Where: the city typed in Appearance, else an approximate place from the
 * internet address (ipwho.is). The weather itself: Open-Meteo (no key). Kept
 * for 20 minutes; nothing else is sent.
 */

const TTL = 20 * 60_000;
let cache = null; // { key, at, data }

const getJson = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
};

/** A city name -> { city, lat, lon } (Open-Meteo's geocoding, names in the user's language). */
async function geocode(name, lang) {
  const r = await getJson(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=${lang}&name=${encodeURIComponent(name)}`);
  const p = r.results?.[0];
  return p ? { city: p.name, lat: p.latitude, lon: p.longitude } : null;
}

async function locate(city, lang) {
  if (city) return geocode(city, lang);
  const ip = await getJson('https://ipwho.is/?fields=success,city,latitude,longitude');
  if (!ip.success) return null;
  // the address service writes names without accents ("Divinopolis"): the geocoder has the real one
  const named = await geocode(ip.city, lang).catch(() => null);
  const near = named && Math.abs(named.lat - ip.latitude) < 0.5 && Math.abs(named.lon - ip.longitude) < 0.5;
  return { city: near ? named.city : ip.city, lat: ip.latitude, lon: ip.longitude };
}

/** WMO weather code -> the kind of picture to draw. */
function kindOf(code, isDay) {
  if (code <= 1) return isDay ? 'sun' : 'moon';
  if (code <= 3) return 'cloud';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 95) return 'storm';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  return 'rain'; // drizzle, rain, showers
}

/** { city, temp, code, kind, at } or null (offline, no place). */
async function weather({ city = '', lang = 'pt', force = false } = {}) {
  const key = `${city}|${lang}`;
  if (!force && cache?.key === key && Date.now() - cache.at < TTL) return cache.data;
  try {
    const place = await locate(city.trim(), lang);
    if (!place) return null;
    const r = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}&current=temperature_2m,weather_code,is_day&timezone=auto`);
    const c = r.current;
    const data = { city: place.city, temp: Math.round(c.temperature_2m), code: c.weather_code, kind: kindOf(c.weather_code, c.is_day === 1), at: Date.now() };
    cache = { key, at: Date.now(), data };
    return data;
  } catch {
    return cache?.key === key ? cache.data : null; // offline: the last one, if any
  }
}

/** The city of the last weather fetched ('' before any). */
const lastCity = () => cache?.data?.city ?? '';

module.exports = { weather, kindOf, lastCity };
