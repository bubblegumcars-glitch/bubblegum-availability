// Bubblegum Cars — Availability API (Vercel Serverless)
//
// Output format expected by your tab UI:
//   { days: [{date,label,from,till}], cars: [{id,name,statuses:{[date]:{status,detail}}}] }
//
// Rules:
// - Today + next 3 days
// - Australia/Brisbane timezone
// - Day = midnight-to-midnight
// - 15-minute re-rent buffer policy (staff view)
// - Cars only (exclude add-ons like Accident Excess, Additional Driver(s), Charging Cable, etc)
//
// Fixes:
// - Correctly parse Booqable numeric availability (available: 0/1/...)
// - Strong caching + retry/backoff to reduce Booqable 429s
//
// Debug mode (optional):
//   /api/availability?debug=1

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
  return `${y}-${m}-${d}`; // YYYY-MM-DD
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

// ---- Add-on filtering (cars only) ----
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

// Booqable v1 fetch: https://{company_slug}.booqable.com/api/1/... ?api_key=...
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

// ---- Availability interpretation (handles your payload) ----
// Your payload example:
//   { stock_count: 1, available: 1, plannable: 1, planned: 1, needed: 0 }
//
// Rules:
// - If available is a NUMBER:
//     available > 0  => Available
//     available === 0 => Booked
function extractOverallAvailable(availJson) {
  const root = availJson?.data ?? availJson;

  // numeric availability (your account)
  if (typeof root?.available === "number") return root.available > 0;
  if (typeof availJson?.available === "number") return availJson.available > 0;

  // boolean availability (some accounts)
  if (typeof root?.available === "boolean") return root.available;
  if (typeof availJson?.available === "boolean") return availJson.available;

  // alternate keys
  if (typeof root?.is_available === "boolean") return root.is_available;
  if (typeof root?.is_available === "number") return root.is_available > 0;

  // fallback by status string
  if (typeof root?.status === "string") {
    const s = root.status.toLowerCase();
    if (s === "available") return true;
    if (s === "unavailable" || s === "booked") return false;
  }

  return null;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

    const debug = String(req.query?.debug || "") === "1";

    // Edge caching (major 429 reduction)
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");

    const todayISO = brisbaneTodayISO();
    const tomorrowISO = addDaysISO(todayISO, 1);

    const days = [0, 1, 2, 3].map((i) => {
      const iso = addDaysISO(todayISO, i);
      return { date: iso, label: labelForISO(iso), from: toDMY(iso), till: toDMY(iso) };
    });

    // Cache product list for 10 minutes
    const productsResp = await booqableFetch("/products", { cacheKey: "products", cacheTtlMs: 10 * 60 * 1000 });
    let products = normalizeProductsResponse(productsResp);

    // Fallback
    if (!products || products.length === 0) {
      const pgsResp = await booqableFetch("/product_groups", { cacheKey: "product_groups", cacheTtlMs: 10 * 60 * 1000 });
      products = normalizeProductsResponse(pgsResp);
    }

    // Cars only
    const cars = (products || [])
      .filter((p) => !looksLikeAddon(p?.name || p?.title || p?.product_group_name || ""))
      .map((p) => ({ id: p.id, name: p.name || p.title || p.product_group_name || "Unnamed" }))
      .filter((c) => c.id);

    // Debug mode: show raw for first car/day
    if (debug) {
      if (!cars.length) return res.status(200).json({ debug: true, message: "No cars found after filtering." });
      const car = cars[0];
      const day = days[0];
      const path = `/products/${encodeURIComponent(car.id)}/availability?from=${encodeURIComponent(day.from)}&till=${encodeURIComponent(day.till)}`;
      const raw = await booqableFetch(path, { cacheKey: `debug:${car.id}:${day.date}`, cacheTtlMs: 30 * 1000 });
      return res.status(200).json({ debug: true, car, day, requestPath: path, raw });
    }

    // Cache full computed payload for 60s (big reduction)
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
            detail: "Availability returned in an unsupported format (unexpected payload).",
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
