// Bubblegum Cars — Availability API (Vercel Serverless)
//
// FINAL PARSER FOR YOUR BOOQABLE SHAPE
// Your /availability response is numeric:
//   { stock_count: 1, available: 1, plannable: 1, planned: 1, needed: 0 }
// We treat: available > 0 => Available, available == 0 => Booked
//
// Rules:
// - Today + next 3 days (Brisbane time)
// - midnight-to-midnight days
// - 15-minute re-rent buffer policy (staff view note)
// - Cars only (exclude add-ons)
// - Caching + 429 backoff

const MEMORY_CACHE = { map: new Map() };

function memGet(key) {
  const hit = MEMORY_CACHE.map.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    MEMORY_CACHE.map.delete(key);
    return null;
  }
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

function pad2(n) {
  return String(n).padStart(2, "0");
}

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
  return `${pad2(d)}-${pad2(m)}-${y}`; // DD-MM-YYYY
}

function labelForISO(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const weekday = dt.toLocaleDateString("en-AU", { weekday: "short", timeZone: "Australia/Brisbane" });
  const day = dt.toLocaleDateString("en-AU", { day: "2-digit", month: "short", timeZone: "Australia/Brisbane" });
  return `${weekday} ${day}`;
}

// Cars-only filter (name-based)
function looksLikeAddon(name) {
  const n = String(name || "").toLowerCase();
  const bannedContains = [
    "add on",
    "add-on",
    "addon",
    "accident excess",
    "excess",
    "additional driver",
    "charging cable",
    "charger",
    "insurance",
    "deposit",
    "gps",
    "child seat",
    "baby seat",
    "booster",
  ];
  return bannedContains.some((k) => n.includes(k));
}

function normalizeProductsResponse(json) {
  if (Array.isArray(json?.products)) return json.products;
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json)) return json;

  if (Array.isArray(json?.product_groups)) {
    const out = [];
    for (const pg of json.product_groups) {
      if (Array.isArray(pg?.products)) out.push(...pg.products);
    }
    return out;
  }
  return [];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }

    if (res.status === 429 && attempt < maxAttempts) {
      const ra = res.headers.get("retry-after");
      const waitMs = ra ? Math.min(15000, Number(ra) * 1000) : Math.min(15000, 1200 * Math.pow(2, attempt - 1));
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

// ✅ Your account: available is a NUMBER (0/1/etc)
function extractOverallAvailable(availJson) {
  const root = availJson?.data ?? availJson;
  const val = root?.available ?? availJson?.available;

  if (typeof val === "number") return val > 0;
  if (typeof val === "boolean") return val;

  return null;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

    // Edge cache (reduces rate limits)
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");

    const todayISO = brisbaneTodayISO();
    const tomorrowISO = addDaysISO(todayISO, 1);

    const days = [0, 1, 2, 3].map((i) => {
      const iso = addDaysISO(todayISO, i);
      return { date: iso, label: labelForISO(iso), from: toDMY(iso), till: toDMY(iso) };
    });

    // Products list cached 10 min
    const productsResp = await booqableFetch("/products", { cacheKey: "products", cacheTtlMs: 10 * 60 * 1000 });
    let products = normalizeProductsResponse(productsResp);

    if (!products || products.length === 0) {
      const pgsResp = await booqableFetch("/product_groups", { cacheKey: "product_groups", cacheTtlMs: 10 * 60 * 1000 });
      products = normalizeProductsResponse(pgsResp);
    }

    const cars = (products || [])
      .filter((p) => !looksLikeAddon(p?.name || p?.title || p?.product_group_name || ""))
      .map((p) => ({ id: p.id, name: p.name || p.title || p.product_group_name || "Unnamed" }))
      .filter((c) => c.id);

    // Full response cache 60s
    const finalKey = `final:${todayISO}`;
    const cachedFinal = memGet(finalKey);
    if (cachedFinal) return res.status(200).json(cachedFinal);

    const BUFFER_MINUTES = 15;

    for (const car of cars) {
      car.statuses = {};

      for (const day of days) {
        const path = `/products/${encodeURIComponent(car.id)}/availability?from=${encodeURIComponent(day.from)}&till=${encodeURIComponent(day.till)}`;

        let availJson;
        try {
          // Per car/day cached 60s
          availJson = await booqableFetch(path, { cacheKey: `avail:${car.id}:${day.date}`, cacheTtlMs: 60 * 1000 });
        } catch (e) {
          car.statuses[day.date] = { status: "Unknown", detail: String(e.message || e) };
          continue;
        }

        const overall = extractOverallAvailable(availJson);

        if (overall === true) {
          car.statuses[day.date] = { status: "Available", detail: "" };
        } else if (overall === false) {
          const isHeadsUp = day.date === todayISO || day.date === tomorrowISO;
          car.statuses[day.date] = {
            status: isHeadsUp ? "Heads-up" : "Booked",
            detail: `Unavailable during day window (staff view includes ${BUFFER_MINUTES}-minute re-rent buffer policy).`,
          };
        } else {
          car.statuses[day.date] = {
            status: "Unknown",
            detail: "Unexpected availability payload (missing numeric 'available').",
          };
        }
      }
    }

    const payload = { days, cars };
    memSet(finalKey, payload, 60 * 1000);
    return res.status(200).json(payload);
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
// deploy nudge
