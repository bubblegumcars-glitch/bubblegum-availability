// Bubblegum Cars — Availability API (Vercel Serverless)
// - Booqable API v1 company subdomain + api_key param
// - Brisbane timezone, Today + next 3 days, midnight-to-midnight
// - 15-minute re-rent buffer
// - Cars only: excludes add-ons like Accident Excess, Additional Driver(s), Charging Cable, etc.
// - Caching + 429 retry

const MEMORY_CACHE = { map: new Map() };
function memGet(key) {
  const hit = MEMORY_CACHE.map.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) { MEMORY_CACHE.map.delete(key); return null; }
  return hit.value;
}
function memSet(key, value, ttlMs) {
  MEMORY_CACHE.map.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable: ${name}`);
  return v;
}
function pad2(n) { return String(n).padStart(2, "0"); }

function brisbaneTodayISO() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Brisbane",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = parts.find((p) => p.type === "year").value;
  const m = parts.find((p) => p.type === "month").value;
  const d = parts.find((p) => p.type === "day").value;
  return `${y}-${m}-${d}`;
}
function addDaysISO(isoDate, days) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}
function toDMY(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return `${pad2(d)}-${pad2(m)}-${y}`;
}
function labelForISO(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const weekday = dt.toLocaleDateString("en-AU", { weekday: "short", timeZone: "Australia/Brisbane" });
  const day = dt.toLocaleDateString("en-AU", { day: "2-digit", month: "short", timeZone: "Australia/Brisbane" });
  return `${weekday} ${day}`;
}
function minutesToHHMM(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

function looksLikeAddon(name) {
  const n = String(name || "").toLowerCase();
  const bannedContains = [
    "add on", "add-on", "addon",
    "accident excess", "excess",
    "additional driver",
    "charging cable", "charger",
    "insurance", "deposit",
    "gps",
    "child seat", "baby seat", "booster",
  ];
  return bannedContains.some((k) => n.includes(k));
}

function extractBookedMinuteRanges(availabilityJson) {
  const root = availabilityJson?.data ?? availabilityJson;

  let minutes = root?.minutes;
  if (!minutes && Array.isArray(root)) minutes = root;
  if (!minutes && Array.isArray(root?.data)) minutes = root.data;
  if (!minutes && Array.isArray(root?.availability)) minutes = root.availability;

  if (!Array.isArray(minutes) || minutes.length === 0) return null;

  const availFlags = minutes.map((x) => {
    if (typeof x?.available === "boolean") return x.available;
    if (typeof x?.is_available === "boolean") return x.is_available;
    if (typeof x?.status === "string") return x.status.toLowerCase() === "available";
    if (typeof x === "boolean") return x;
    return null;
  });

  if (availFlags.every((v) => v === null)) return null;

  const ranges = [];
  let inBooked = false;
  let start = 0;

  for (let i = 0; i < availFlags.length; i++) {
    const isBooked = availFlags[i] === false;
    if (isBooked && !inBooked) { inBooked = true; start = i; }
    else if (!isBooked && inBooked) { inBooked = false; ranges.push([start, i - 1]); }
  }
  if (inBooked) ranges.push([start, availFlags.length - 1]);

  return ranges;
}

function applyBufferToRanges(ranges, bufferMinutes, totalLength) {
  if (!ranges || ranges.length === 0) return [];
  const expanded = ranges.map(([s, e]) => [Math.max(0, s - bufferMinutes), Math.min(totalLength - 1, e + bufferMinutes)]);
  expanded.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of expanded) {
    if (!merged.length) merged.push(r);
    else {
      const last = merged[merged.length - 1];
      if (r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
      else merged.push(r);
    }
  }
  return merged;
}

function bookedDetail(bufferedRanges) {
  if (!bufferedRanges || !bufferedRanges.length) return "";
  const parts = bufferedRanges.slice(0, 3).map(([s, e]) => `${minutesToHHMM(s)}–${minutesToHHMM(e)}`);
  const more = bufferedRanges.length > 3 ? ` (+${bufferedRanges.length - 3} more)` : "";
  return `Booked windows (incl. buffer): ${parts.join(", ")}${more}`;
}

function normalizeProductsResponse(json) {
  if (Array.isArray(json?.products)) return json.products;
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.product_groups)) {
    const out = [];
    for (const pg of json.product_groups) if (Array.isArray(pg?.products)) out.push(...pg.products);
    return out;
  }
  return [];
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function booqableFetch(pathWithLeadingSlash, { cacheKey = null, cacheTtlMs = 0 } = {}) {
  const apiKey = requireEnv("BOOQABLE_API_KEY");
  const companySlug = requireEnv("BOOQABLE_COMPANY_SLUG");
  const base = `https://${companySlug}.booqable.com/api/1`;
  const joiner = pathWithLeadingSlash.includes("?") ? "&" : "?";
  const url = `${base}${pathWithLeadingSlash}${joiner}api_key=${encodeURIComponent(apiKey)}`;

  if (cacheKey && cacheTtlMs > 0) {
    const cached = memGet(cacheKey);
    if (cached) return cached;
  }

  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, { method: "GET" });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }

    if (res.status === 429 && attempt < maxAttempts) {
      const ra = res.headers.get("retry-after");
      const waitMs = ra ? Math.min(8000, Number(ra) * 1000) : Math.min(8000, 800 * Math.pow(2, attempt - 1));
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      const msg = json?.error?.message || json?.message || text || `HTTP ${res.status}`;
      throw new Error(`Booqable error (${res.status}) on ${pathWithLeadingSlash}: ${msg}`);
    }

    if (cacheKey && cacheTtlMs > 0) memSet(cacheKey, json, cacheTtlMs);
    return json;
  }

  throw new Error("Unexpected error fetching from Booqable");
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

    // Edge caching (prevents hammering Booqable on every refresh)
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");

    const todayISO = brisbaneTodayISO();
    const days = [0, 1, 2, 3].map((i) => {
      const iso = addDaysISO(todayISO, i);
      return { date: iso, label: labelForISO(iso), from: toDMY(iso), till: toDMY(iso) };
    });

    const productsResp = await booqableFetch("/products", { cacheKey: "products", cacheTtlMs: 5 * 60 * 1000 });
    let products = normalizeProductsResponse(productsResp);

    if (!products.length) {
      const pgsResp = await booqableFetch("/product_groups", { cacheKey: "product_groups", cacheTtlMs: 5 * 60 * 1000 });
      products = normalizeProductsResponse(pgsResp);
    }

    // Cars only: exclude add-ons by name (and “Add On” labels)
    const cars = (products || [])
      .filter((p) => !looksLikeAddon(p?.name || p?.title || p?.product_group_name || ""))
      .map((p) => ({ id: p.id, name: p.name || p.title || p.product_group_name || "Unnamed" }))
      .filter((c) => c.id);

    const BUFFER_MINUTES = 15;

    for (const car of cars) {
      car.statuses = {};
      for (const day of days) {
        const path = `/products/${encodeURIComponent(car.id)}/availability?interval=minute&from=${encodeURIComponent(day.from)}&till=${encodeURIComponent(day.till)}`;

        let availJson;
        try {
          availJson = await booqableFetch(path, { cacheKey: `avail:${car.id}:${day.date}`, cacheTtlMs: 60 * 1000 });
        } catch (e) {
          car.statuses[day.date] = { status: "Unknown", detail: String(e.message || e) };
          continue;
        }

        const ranges = extractBookedMinuteRanges(availJson);
        if (!ranges) {
          car.statuses[day.date] = { status: "Unknown", detail: "Could not parse availability format from Booqable for this product/day." };
          continue;
        }

        const root = availJson?.data ?? availJson;
        const minutesArr = root?.minutes || root?.availability || (Array.isArray(root) ? root : root?.data);
        const totalMinutes = Array.isArray(minutesArr) ? minutesArr.length : 1440;

        const buffered = applyBufferToRanges(ranges, BUFFER_MINUTES, totalMinutes);
        const booked = buffered.length > 0;

        const isToday = day.date === todayISO;
        if (booked) {
          car.statuses[day.date] = { status: isToday ? "Heads-up" : "Booked", detail: bookedDetail(buffered) };
        } else {
          car.statuses[day.date] = { status: "Available", detail: "" };
        }

        const tomorrowISO = addDaysISO(todayISO, 1);
        if (booked && day.date === tomorrowISO) car.statuses[day.date].status = "Heads-up";
      }
    }

    return res.status(200).json({ days, cars });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
