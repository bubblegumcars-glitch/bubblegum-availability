// Bubblegum Cars — Staff Availability API (Vercel Serverless)
// BOOKING/TIMES VERSION (Orders-based)
//
// What it does:
// - Finds cars via /products (filters to rental + trackable + show_in_store)
// - Finds bookings via /orders (starts_at / stops_at + stock_item_ids)
// - Shows Today + next 3 days in Australia/Brisbane (midnight-to-midnight)
// - Applies a 15-minute buffer to booking windows for staff re-rent policy
//
// Env vars required on Vercel:
// - BOOQABLE_COMPANY_SLUG   (e.g. "bubblegumcars")
// - BOOQABLE_API_KEY
//
// Optional:
// - CACHE_TTL_SECONDS (default 30)

const TZ = "Australia/Brisbane";
const DAYS = 4; // Today + next 3
const BUFFER_MINUTES = 15;
const DEFAULT_CACHE_TTL_SECONDS = 30;

// Simple in-memory cache (works per warm lambda)
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

function json(res, status, obj, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // Cache publicly for a short time to reduce Booqable load
  res.setHeader("Cache-Control", "s-maxage=20, stale-while-revalidate=60");
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end(JSON.stringify(obj));
}

function getEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable: ${name}`);
  return v;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// Brisbane is UTC+10 year-round (no DST). We can safely use a fixed offset.
const BRISBANE_OFFSET_MIN = 10 * 60;

function nowBrisbaneParts() {
  const nowUtc = new Date();
  const brisMs = nowUtc.getTime() + BRISBANE_OFFSET_MIN * 60 * 1000;
  const bris = new Date(brisMs);
  return { y: bris.getUTCFullYear(), m: bris.getUTCMonth() + 1, d: bris.getUTCDate() };
}

// Create a Date that represents Brisbane local time yyyy-mm-dd hh:mm, converted into real UTC Date.
function brisbaneLocalToUtcDate(y, m, d, hh = 0, mm = 0, ss = 0) {
  // Brisbane local time = UTC +10, so UTC = local -10h
  const utcMs = Date.UTC(y, m - 1, d, hh, mm, ss) - BRISBANE_OFFSET_MIN * 60 * 1000;
  return new Date(utcMs);
}

function formatDayLabel(dateUtc) {
  // Display in Brisbane timezone
  const dtf = new Intl.DateTimeFormat("en-AU", {
    timeZone: TZ,
    weekday: "short",
    day: "2-digit",
    month: "short",
  });
  return dtf.format(dateUtc); // e.g. "Thu 05 Feb"
}

function formatIsoDateBrisbane(dateUtc) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return dtf.format(dateUtc); // YYYY-MM-DD
}

function formatDDMMYYYY(dateUtc) {
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = dtf.format(dateUtc).split("/"); // DD/MM/YYYY
  return `${parts[0]}-${parts[1]}-${parts[2]}`;
}

function formatTimeBrisbane(dateUtc) {
  const dtf = new Intl.DateTimeFormat("en-AU", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return dtf.format(dateUtc); // "14:05"
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function clampInterval(start, end, clampStart, clampEnd) {
  const s = start < clampStart ? clampStart : start;
  const e = end > clampEnd ? clampEnd : end;
  if (s >= e) return null;
  return [s, e];
}

function mergeIntervals(intervals) {
  if (!intervals.length) return [];
  intervals.sort((a, b) => a[0] - b[0]);
  const merged = [intervals[0]];
  for (let i = 1; i < intervals.length; i++) {
    const [s, e] = intervals[i];
    const last = merged[merged.length - 1];
    if (s <= last[1]) {
      last[1] = new Date(Math.max(last[1].getTime(), e.getTime()));
    } else {
      merged.push([s, e]);
    }
  }
  return merged;
}

async function booqableFetch(path, { companySlug, apiKey, cacheKey, ttlMs }) {
  const cached = memGet(cacheKey);
  if (cached) return cached;

  const url = `https://${companySlug}.booqable.com/api/1${path}${path.includes("?") ? "&" : "?"}api_key=${encodeURIComponent(apiKey)}`;

  // Basic backoff for 429
  const maxAttempts = 3;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, {
      headers: { "Accept": "application/json" },
    });

    if (res.status === 429) {
      lastErr = new Error(`Booqable rate limit (429) on ${path}`);
      // Wait 400ms, 900ms, 1500ms
      const wait = attempt === 1 ? 400 : attempt === 2 ? 900 : 1500;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Booqable error (${res.status}) on ${path}: ${text || res.statusText}`);
    }

    const data = await res.json();
    memSet(cacheKey, data, ttlMs);
    return data;
  }

  throw lastErr || new Error(`Failed to fetch ${path}`);
}

async function listCars({ companySlug, apiKey, ttlMs }) {
  // Pull a lot in one go (adjust per if you have many)
  const data = await booqableFetch(`/products?per=200&page=1`, {
    companySlug,
    apiKey,
    cacheKey: `products:v1:per200:page1`,
    ttlMs,
  });

  const products = data.products || [];

  // Filter to cars only (excludes add-ons like Accident Excess):
  // - rental === true
  // - trackable === true
  // - show_in_store === true
  const cars = products
    .filter((p) => p && p.rental === true && p.trackable === true && p.show_in_store === true)
    .map((p) => ({
      id: p.id,
      name: (p.name || "").trim(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return cars;
}

async function listOrdersOverlappingWindow({ companySlug, apiKey, windowStartUtc, windowEndUtc, ttlMs }) {
  // Booqable v1 /orders supports paging, but not date filtering.
  // We page a limited amount and filter client-side.
  // If you have huge order volume, increase maxPages OR we can add a smarter strategy later.
  const per = 100;
  const maxPages = 6; // up to 600 orders per refresh
  const overlapping = [];

  for (let page = 1; page <= maxPages; page++) {
    const data = await booqableFetch(`/orders?per=${per}&page=${page}`, {
      companySlug,
      apiKey,
      cacheKey: `orders:v1:per${per}:page${page}`,
      ttlMs,
    });

    const orders = data.orders || [];
    if (!orders.length) break;

    for (const o of orders) {
      if (!o || !o.starts_at || !o.stops_at) continue;

      const start = new Date(o.starts_at);
      const end = new Date(o.stops_at);
      if (!isFinite(start) || !isFinite(end)) continue;

      if (intervalsOverlap(start, end, windowStartUtc, windowEndUtc)) {
        overlapping.push(o);
      }
    }

    // If this page had fewer than `per`, stop early
    if (orders.length < per) break;
  }

  return overlapping;
}

function orderIsActiveForBlocking(order) {
  // We treat these statuses as affecting availability:
  // concept, reserved, started, stopped (stopped is historical but still in list; overlap filter handles it)
  // Exclude canceled if present.
  const s = (order.status || "").toLowerCase();
  if (s === "canceled" || s === "cancelled") return false;
  return true;
}

function extractCarBookingsForDay({ orders, carId, dayStartUtc, dayEndUtc }) {
  // Returns booking intervals (with buffer) that overlap this day.
  // We try two linkages:
  // 1) order.stock_item_ids includes carId (common for trackable items)
  // 2) order.item_ids includes carId (fallback)
  const intervals = [];
  const sources = [];

  for (const o of orders) {
    if (!orderIsActiveForBlocking(o)) continue;

    const stockIds = Array.isArray(o.stock_item_ids) ? o.stock_item_ids : [];
    const itemIds = Array.isArray(o.item_ids) ? o.item_ids : [];
    const matches = stockIds.includes(carId) || itemIds.includes(carId);
    if (!matches) continue;

    const start = new Date(o.starts_at);
    const end = new Date(o.stops_at);

    // Apply staff buffer
    const startBuf = addMinutes(start, -BUFFER_MINUTES);
    const endBuf = addMinutes(end, BUFFER_MINUTES);

    const clamped = clampInterval(startBuf, endBuf, dayStartUtc, dayEndUtc);
    if (!clamped) continue;

    intervals.push(clamped);
    sources.push({
      order_id: o.id,
      order_number: o.number,
      status: o.status,
      starts_at: o.starts_at,
      stops_at: o.stops_at,
      starts_buf: startBuf.toISOString(),
      stops_buf: endBuf.toISOString(),
    });
  }

  const merged = mergeIntervals(intervals);

  return { mergedIntervals: merged, sources };
}

function statusForDay(mergedIntervals, dayStartUtc, dayEndUtc) {
  if (!mergedIntervals.length) return { status: "Available", detail: "" };

  const dayLen = dayEndUtc.getTime() - dayStartUtc.getTime();
  let covered = 0;
  for (const [s, e] of mergedIntervals) covered += (e.getTime() - s.getTime());

  // If bookings cover basically the whole day window, call it Booked
  // (allow 1 minute slack)
  if (covered >= dayLen - 60 * 1000) {
    return { status: "Booked", detail: "" };
  }

  // Otherwise it’s partially booked: Heads-up
  return { status: "Heads-up", detail: "" };
}

function intervalsToTimesNote(mergedIntervals) {
  if (!mergedIntervals.length) return "";

  // Convert merged UTC intervals into Brisbane times
  // Show as: "Out 09:30–13:15, 16:00–18:10"
  const parts = mergedIntervals.map(([s, e]) => `${formatTimeBrisbane(s)}–${formatTimeBrisbane(e)}`);
  return `Out ${parts.join(", ")} (includes 15-min buffer)`;
}

export default async function handler(req, res) {
  try {
    const companySlug = getEnv("BOOQABLE_COMPANY_SLUG");
    const apiKey = getEnv("BOOQABLE_API_KEY");

    const ttlSeconds = Number(process.env.CACHE_TTL_SECONDS || DEFAULT_CACHE_TTL_SECONDS);
    const ttlMs = Math.max(5, ttlSeconds) * 1000;

    // Build Brisbane day list (Today + next 3)
    const { y, m, d } = nowBrisbaneParts();

    const days = [];
    for (let i = 0; i < DAYS; i++) {
      const dayStartUtc = brisbaneLocalToUtcDate(y, m, d + i, 0, 0, 0);
      const dayEndUtc = brisbaneLocalToUtcDate(y, m, d + i + 1, 0, 0, 0);

      days.push({
        date: formatIsoDateBrisbane(dayStartUtc), // YYYY-MM-DD
        label: formatDayLabel(dayStartUtc),       // e.g. Thu 05 Feb
        from: formatDDMMYYYY(dayStartUtc),        // DD-MM-YYYY (Booqable examples use this)
        till: formatDDMMYYYY(dayStartUtc),        // same-day window
        _dayStartUtc: dayStartUtc,
        _dayEndUtc: dayEndUtc,
      });
    }

    // Whole window (include buffer just so we don’t miss edges)
    const windowStartUtc = addMinutes(days[0]._dayStartUtc, -BUFFER_MINUTES);
    const windowEndUtc = addMinutes(days[days.length - 1]._dayEndUtc, BUFFER_MINUTES);

    // Fetch cars + orders
    const cars = await listCars({ companySlug, apiKey, ttlMs });

    const orders = await listOrdersOverlappingWindow({
      companySlug,
      apiKey,
      windowStartUtc,
      windowEndUtc,
      ttlMs,
    });

    // Build statuses per car/day
    const carsOut = [];
    for (const car of cars) {
      const statuses = {};
      for (const day of days) {
        const { mergedIntervals } = extractCarBookingsForDay({
          orders,
          carId: car.id,
          dayStartUtc: day._dayStartUtc,
          dayEndUtc: day._dayEndUtc,
        });

        const base = statusForDay(mergedIntervals, day._dayStartUtc, day._dayEndUtc);

        // Attach times note if any booking that day
        const timesNote = intervalsToTimesNote(mergedIntervals);
        const detail = timesNote || base.detail || "";

        statuses[day.date] = { status: base.status, detail };
      }

      carsOut.push({
        id: car.id,
        name: car.name,
        statuses,
      });
    }

    // Strip internal fields
    const cleanDays = days.map(({ _dayStartUtc, _dayEndUtc, ...rest }) => rest);

    json(res, 200, {
      days: cleanDays,
      cars: carsOut,
      meta: {
        tz: TZ,
        range_days: DAYS,
        buffer_minutes: BUFFER_MINUTES,
        source: "orders",
      },
    });
  } catch (err) {
    json(res, 500, { error: String(err.message || err) });
  }
}
