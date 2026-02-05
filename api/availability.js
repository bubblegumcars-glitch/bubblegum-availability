// Bubblegum Cars — Availability API (Vercel Serverless)
//
// Day view + Times view (minute availability parsing)
//
// - Today + next 3 days (Brisbane time)
// - Day = midnight-to-midnight
// - 15-minute re-rent buffer (we extend the "back" time by 15 minutes)
// - Cars only (exclude add-ons)
// - Rate limit friendly (caching + 429 backoff)

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

// Day-level: available is numeric in your account (0/1/etc)
function extractOverallAvailable(availJson) {
  const root = availJson?.data ?? availJson;
  const val = root?.available ?? availJson?.available;
  if (typeof val === "number") return val > 0;
  if (typeof val === "boolean") return val;
  return null;
}

function fmtBrisbaneTime(dateObj) {
  // 24h HH:mm in Brisbane time
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Brisbane",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(dateObj);
}

function parseMinuteSeries(minJson) {
  // We try several common shapes.
  const root = minJson?.data ?? minJson;

  // Shape A: array of points [{ at: "...", available: 0/1 }, ...]
  const arrCandidates = [
    root,
    root?.items,
    root?.availability,
    root?.minutes,
    root?.data,
  ].filter(Array.isArray);

  for (const arr of arrCandidates) {
    const points = [];
    for (const it of arr) {
      if (!it || typeof it !== "object") continue;
      const at = it.at || it.time || it.timestamp || it.starts_at || it.start || it.datetime;
      const av = it.available ?? it.availability ?? it.value ?? it.count;
      if (!at) continue;
      const dt = new Date(at);
      if (Number.isNaN(dt.getTime())) continue;
      // available might be boolean or number
      let available = null;
      if (typeof av === "number") available = av > 0;
      else if (typeof av === "boolean") available = av;
      // if no explicit available, skip
      if (available === null) continue;
      points.push({ t: dt, available });
    }
    if (points.length) return points.sort((a, b) => a.t - b.t);
  }

  // Shape B: object keyed by timestamp -> { available: 0/1 } OR number
  if (root && typeof root === "object") {
    const points = [];
    for (const [k, v] of Object.entries(root)) {
      // keys that are not timestamps: ignore
      if (!k || k.length < 10) continue;
      const dt = new Date(k);
      if (Number.isNaN(dt.getTime())) continue;

      let available = null;
      if (typeof v === "number") available = v > 0;
      else if (typeof v === "boolean") available = v;
      else if (v && typeof v === "object") {
        if (typeof v.available === "number") available = v.available > 0;
        else if (typeof v.available === "boolean") available = v.available;
      }
      if (available === null) continue;
      points.push({ t: dt, available });
    }
    if (points.length) return points.sort((a, b) => a.t - b.t);
  }

  return null;
}

function rangesFromMinutePoints(points) {
  // Convert minute points into blocked ranges (available=false)
  // Assumes points are sorted by time.
  const ranges = [];
  let cur = null;

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.available === false) {
      if (!cur) cur = { start: p.t, end: p.t };
      cur.end = p.t;
    } else {
      if (cur) {
        ranges.push(cur);
        cur = null;
      }
    }
  }
  if (cur) ranges.push(cur);

  // Expand each range end by 1 minute (since last point is inclusive-ish)
  for (const r of ranges) {
    r.end = new Date(r.end.getTime() + 60 * 1000);
  }

  return ranges;
}

function summarizeRanges(ranges, bufferMinutes) {
  if (!ranges || ranges.length === 0) return null;

  // Merge ranges that touch/overlap
  const merged = [];
  for (const r of ranges.sort((a, b) => a.start - b.start)) {
    if (merged.length === 0) {
      merged.push({ start: r.start, end: r.end });
      continue;
    }
    const last = merged[merged.length - 1];
    if (r.start.getTime() <= last.end.getTime()) {
      last.end = new Date(Math.max(last.end.getTime(), r.end.getTime()));
    } else {
      merged.push({ start: r.start, end: r.end });
    }
  }

  // Apply re-rent buffer on END time (return time + buffer)
  const buffered = merged.map((r) => ({
    start: r.start,
    end: new Date(r.end.getTime() + bufferMinutes * 60 * 1000),
  }));

  // Format up to 3 ranges
  const parts = buffered.slice(0, 3).map((r) => `Out ${fmtBrisbaneTime(r.start)} → Back ${fmtBrisbaneTime(r.end)}`);
  const more = buffered.length > 3 ? ` (+${buffered.length - 3} more)` : "";
  return parts.join(" • ") + more;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

    // Edge cache (reduces rate limits)
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=300");

    const todayISO = brisbaneTodayISO();
    const tomorrowISO = addDaysISO(todayISO, 1);
    const days = [0, 1, 2, 3].map((i) => {
      const iso = addDaysISO(todayISO, i);
      return { date: iso, label: labelForISO(iso), from: toDMY(iso), till: toDMY(iso) };
    });

    // UI calls with ?date=YYYY-MM-DD to get data for the selected tab only
    const dateParam = (req.query?.date || "").toString().trim();
    const selectedDay = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)
      ? days.find((d) => d.date === dateParam) || null
      : null;

    const includeTimes = (req.query?.times || "").toString() === "1"; // UI will use this

    // Products list cached 10 min
    const productsResp = await booqableFetch("/products", { cacheKey: "products", cacheTtlMs: 10 * 60 * 1000 });
    let products = normalizeProductsResponse(productsResp);

    if (!products || products.length === 0) {
      const pgsResp = await booqableFetch("/product_groups", { cacheKey: "product_groups", cacheTtlMs: 10 * 60 * 1000 });
      products = normalizeProductsResponse(pgsResp);
    }

    const cars = (products || [])
      .filter((p) => !looksLikeAddon(p?.name || p?.title || p?.product_group_name || ""))
      .map((p) => ({ id: p.id, name: (p.name || p.title || p.product_group_name || "Unnamed").trim() }))
      .filter((c) => c.id);

    const BUFFER_MINUTES = 15;

    // If no selected day, return the full 4-day grid (no times to protect rate limits)
    if (!selectedDay) {
      const cacheKey = `grid:${todayISO}`;
      const cached = memGet(cacheKey);
      if (cached) return res.status(200).json(cached);

      for (const car of cars) {
        car.statuses = {};
        for (const day of days) {
          const path = `/products/${encodeURIComponent(car.id)}/availability?from=${encodeURIComponent(day.from)}&till=${encodeURIComponent(day.till)}`;
          try {
            const availJson = await booqableFetch(path, { cacheKey: `day:${car.id}:${day.date}`, cacheTtlMs: 60 * 1000 });
            const overall = extractOverallAvailable(availJson);

            if (overall === true) car.statuses[day.date] = { status: "Available", detail: "", times: "" };
            else if (overall === false) {
              const isHeadsUp = day.date === todayISO || day.date === tomorrowISO;
              car.statuses[day.date] = {
                status: isHeadsUp ? "Heads-up" : "Booked",
                detail: "",
                times: "",
              };
            } else {
              car.statuses[day.date] = { status: "Unknown", detail: "Unexpected availability payload.", times: "" };
            }
          } catch (e) {
            car.statuses[day.date] = { status: "Unknown", detail: String(e.message || e), times: "" };
          }
        }
      }

      const payload = { days, cars };
      memSet(cacheKey, payload, 30 * 1000);
      return res.status(200).json(payload);
    }

    // Selected-day mode: return only ONE day, and (optionally) times.
    const day = selectedDay;
    const cacheKey = `dayview:${day.date}:times=${includeTimes ? "1" : "0"}`;
    const cached = memGet(cacheKey);
    if (cached) return res.status(200).json(cached);

    const outCars = [];

    for (const car of cars) {
      const statusObj = { status: "Unknown", detail: "", times: "" };

      // Day-level status first (cheap)
      try {
        const pathDay = `/products/${encodeURIComponent(car.id)}/availability?from=${encodeURIComponent(day.from)}&till=${encodeURIComponent(day.till)}`;
        const availJson = await booqableFetch(pathDay, { cacheKey: `day:${car.id}:${day.date}`, cacheTtlMs: 60 * 1000 });
        const overall = extractOverallAvailable(availJson);

        if (overall === true) statusObj.status = "Available";
        else if (overall === false) {
          const isHeadsUp = day.date === todayISO || day.date === tomorrowISO;
          statusObj.status = isHeadsUp ? "Heads-up" : "Booked";
        } else {
          statusObj.status = "Unknown";
          statusObj.detail = "Unexpected availability payload.";
        }
      } catch (e) {
        statusObj.status = "Unknown";
        statusObj.detail = String(e.message || e);
      }

      // Times (only when asked) + only when not Available (to reduce calls)
      if (includeTimes && (statusObj.status === "Booked" || statusObj.status === "Heads-up")) {
        try {
          const pathMin =
            `/products/${encodeURIComponent(car.id)}/availability` +
            `?interval=minute&from=${encodeURIComponent(day.from)}&till=${encodeURIComponent(day.till)}`;

          const minJson = await booqableFetch(pathMin, { cacheKey: `min:${car.id}:${day.date}`, cacheTtlMs: 60 * 1000 });

          const points = parseMinuteSeries(minJson);
          if (!points) {
            statusObj.times = "";
            statusObj.detail = "Could not read minute-by-minute availability from Booqable for this day.";
          } else {
            const ranges = rangesFromMinutePoints(points).filter((r) => r && r.start && r.end);
            const summary = summarizeRanges(ranges, BUFFER_MINUTES);
            statusObj.times = summary || "";
            // keep detail empty if we got a summary
            if (statusObj.times) statusObj.detail = "";
          }
        } catch (e) {
          statusObj.times = "";
          statusObj.detail = String(e.message || e);
        }
      }

      outCars.push({
        id: car.id,
        name: car.name,
        statuses: { [day.date]: statusObj },
      });
    }

    const payload = { days, selectedDate: day.date, cars: outCars };
    memSet(cacheKey, payload, 30 * 1000);
    return res.status(200).json(payload);
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
