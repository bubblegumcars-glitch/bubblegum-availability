// api/availability.js
// Bubblegum Cars staff availability (Booqable API v4)
// Correctly maps plannings -> inventory_levels -> products
// Uses /settings/current timezone + timezone_offset to interpret offset-less datetimes

const RANGE_DAYS = 4;
const MIN_RENTABLE_GAP_HOURS = 4;

const MAX_PRODUCTS_PAGES = 5;
const MAX_LEVELS_PAGES = 10;
const MAX_PLANNINGS_PAGES = 10;

const PER_PAGE = 100;

// Light cache to reduce 429s (Vercel serverless may reuse runtime briefly)
let _cache = { at: 0, payload: null };
const CACHE_MS = 20_000;

function sendJson(res, status, body, cacheSeconds = 0) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  if (cacheSeconds > 0) {
    res.setHeader("Cache-Control", `s-maxage=${cacheSeconds}, stale-while-revalidate=60`);
  } else {
    res.setHeader("Cache-Control", "no-store");
  }
  res.end(JSON.stringify(body));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function hasOffset(str) {
  return /([zZ]|[+\-]\d{2}:\d{2})$/.test(str);
}

// Parse Booqable datetimes:
// - if has offset/Z -> normal Date()
// - if no offset -> interpret as "company local time", using timezone_offset (minutes)
function parseBooqableDate(str, accountOffsetMinutes) {
  if (!str) return null;

  if (hasOffset(str)) {
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
  }

  // Treat naive string as local time in account timezone.
  // Convert to UTC by subtracting the offset.
  const assumedUtc = new Date(str + "Z");
  if (isNaN(assumedUtc.getTime())) return null;

  return new Date(assumedUtc.getTime() - accountOffsetMinutes * 60 * 1000);
}

function overlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// Build UTC ms for "local midnight" using fixed offset (timezone_offset minutes).
// Brisbane has no DST, so this is safe for you.
function localMidnightUtcMs(baseUtcMs, offsetMinutes, addDays) {
  const offMs = offsetMinutes * 60 * 1000;
  const localMs = baseUtcMs + offMs;

  const local = new Date(localMs);
  // Use UTC getters because we've shifted into "local" already
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate() + addDays;

  const localMidnightMs = Date.UTC(y, m, d, 0, 0, 0, 0);
  return localMidnightMs - offMs; // convert back to UTC
}

function fmtDayLabel(dateObj, timezone) {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: timezone,
    weekday: "short",
    day: "2-digit",
    month: "short",
  }).format(dateObj);
}

function fmtTime(dateObj, timezone) {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(dateObj);
}

function fmtNextAvailable(dateObj, timezone) {
  return `${fmtDayLabel(dateObj, timezone)} ${fmtTime(dateObj, timezone)}`;
}

export default async function handler(req, res) {
  try {
    // Cache to reduce 429 from refresh spamming
    const now = Date.now();
    if (_cache.payload && now - _cache.at < CACHE_MS) {
      return sendJson(res, 200, _cache.payload, 15);
    }

    const company = process.env.BOOQABLE_COMPANY_SLUG;
    const token = process.env.BOOQABLE_ACCESS_TOKEN;
    if (!company || !token) {
      return sendJson(res, 500, { error: "Missing BOOQABLE_COMPANY_SLUG or BOOQABLE_ACCESS_TOKEN" });
    }

    async function booqable(path, attempt = 0) {
      const url = `https://${company}.booqable.com/api/4${path}`;
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (r.status === 429 && attempt < 4) {
        // Exponential backoff
        const wait = 400 * Math.pow(2, attempt);
        await sleep(wait);
        return booqable(path, attempt + 1);
      }

      if (!r.ok) {
        const t = await r.text();
        throw new Error(`Booqable error ${r.status} for ${path} :: ${t}`);
      }
      return r.json();
    }

    // 1) Settings (timezone truth)
    const settings = await booqable("/settings/current");
    const timezone = settings?.data?.attributes?.defaults?.timezone || "UTC";
    const offsetMinutes = settings?.data?.attributes?.defaults?.timezone_offset || 0;

    // 2) Products (cars only)
    const products = [];
    for (let page = 1; page <= MAX_PRODUCTS_PAGES; page++) {
      const out = await booqable(`/products?per_page=${PER_PAGE}&page=${page}`);
      const rows = out?.data || [];
      products.push(...rows);
      if (rows.length < PER_PAGE) break;
    }

    const cars = products
      .filter(p => {
        const a = p.attributes || {};
        return (
          a.product_type === "rental" &&
          a.trackable === true &&
          a.show_in_store === true &&
          a.has_variations === false &&
          a.variation === false
        );
      })
      .map(p => ({
        id: p.id,
        name: (p.attributes?.name || "").trim(),
        slug: p.attributes?.slug,
        photo_url: p.attributes?.photo_url,
        buffer_before_s: p.attributes?.buffer_time_before || 0,
        buffer_after_s: p.attributes?.buffer_time_after || 0,
      }));

    const carById = new Map(cars.map(c => [c.id, c]));

    // 3) Inventory levels: map inventory_level_id -> product_id
    const invToProduct = new Map();
    for (let page = 1; page <= MAX_LEVELS_PAGES; page++) {
      const out = await booqable(`/inventory_levels?per_page=${PER_PAGE}&page=${page}`);
      const rows = out?.data || [];
      for (const lvl of rows) {
        const invId = lvl.id;
        const productId = lvl?.relationships?.product?.data?.id;
        if (invId && productId && carById.has(productId)) {
          invToProduct.set(invId, productId);
        }
      }
      if (rows.length < PER_PAGE) break;
    }

    // 4) Plannings: build booked intervals per product via inventory_level relationship
    const intervalsByProduct = new Map();
    for (const c of cars) intervalsByProduct.set(c.id, []);

    // optional: tighten to roughly the displayed window (+2 days buffer each side)
    const baseUtcMs = Date.now();
    const windowStartUtcMs = localMidnightUtcMs(baseUtcMs, offsetMinutes, 0) - 2 * 86400000;
    const windowEndUtcMs = localMidnightUtcMs(baseUtcMs, offsetMinutes, RANGE_DAYS + 2);

    for (let page = 1; page <= MAX_PLANNINGS_PAGES; page++) {
      const out = await booqable(`/plannings?per_page=${PER_PAGE}&page=${page}`);
      const rows = out?.data || [];

      for (const pl of rows) {
        const invId = pl?.relationships?.inventory_level?.data?.id;
        if (!invId) continue;

        const productId = invToProduct.get(invId);
        if (!productId) continue;

        const startsRaw = pl?.attributes?.starts_at;
        const stopsRaw = pl?.attributes?.stops_at;

        const starts = parseBooqableDate(startsRaw, offsetMinutes);
        const stops = parseBooqableDate(stopsRaw, offsetMinutes);
        if (!starts || !stops) continue;

        let startMs = starts.getTime();
        let endMs = stops.getTime();

        // Skip plannings far outside our window (helps performance)
        if (!overlap(startMs, endMs, windowStartUtcMs, windowEndUtcMs)) continue;

        const car = carById.get(productId);
        const bufBeforeMs = (car.buffer_before_s || 0) * 1000;
        const bufAfterMs = (car.buffer_after_s || 0) * 1000;

        startMs -= bufBeforeMs;
        endMs += bufAfterMs;

        intervalsByProduct.get(productId).push({
          startMs,
          endMs,
          startsRaw: starts, // for display
          stopsRaw: stops,
        });
      }

      if (rows.length < PER_PAGE) break;
    }

    // sort intervals
    for (const arr of intervalsByProduct.values()) {
      arr.sort((a, b) => a.startMs - b.startMs);
    }

    // 5) Build the days array (local midnights)
    const days = [];
    for (let i = 0; i < RANGE_DAYS; i++) {
      const startUtcMs = localMidnightUtcMs(baseUtcMs, offsetMinutes, i);
      const endUtcMs = startUtcMs + 86400000;
      days.push({
        startUtcMs,
        endUtcMs,
        label: fmtDayLabel(new Date(startUtcMs), timezone),
      });
    }

    // 6) Calculate per-car tiles + nextAvailable
    const nowMs = Date.now();
    const outCars = [];

    for (const car of cars) {
      const ivals = intervalsByProduct.get(car.id) || [];

      const bookedNow = ivals.some(iv => nowMs >= iv.startMs && nowMs < iv.endMs);

      // Next available (respect 4-hour minimum rentable gap)
      let nextAvailable = "Available now";
      if (bookedNow) {
        nextAvailable = null;

        for (let i = 0; i < ivals.length; i++) {
          const iv = ivals[i];
          if (nowMs < iv.endMs) {
            const nextStart = ivals[i + 1]?.startMs ?? null;
            const gapMs = nextStart ? (nextStart - iv.endMs) : null;

            if (gapMs === null || gapMs >= MIN_RENTABLE_GAP_HOURS * 3600000) {
              nextAvailable = fmtNextAvailable(new Date(iv.endMs), timezone);
              break;
            }
          }
        }

        if (!nextAvailable) {
          // fallback: last interval end
          const last = ivals[ivals.length - 1];
          nextAvailable = last ? fmtNextAvailable(new Date(last.endMs), timezone) : "Unknown";
        }
      }

      const tiles = days.map(d => {
        const overlaps = ivals.filter(iv => overlap(iv.startMs, iv.endMs, d.startUtcMs, d.endUtcMs));

        if (overlaps.length === 0) {
          return { label: d.label, status: "Available" };
        }

        // If there are multiple overlaps in a day, we show the first for now (simple).
        const first = overlaps[0];

        return {
          label: d.label,
          status: "Booked",
          bookedFrom: fmtTime(first.startsRaw, timezone),
          bookedUntil: fmtTime(first.stopsRaw, timezone),
        };
      });

      outCars.push({
        id: car.id,
        name: car.name,
        slug: car.slug,
        photo_url: car.photo_url,
        nextAvailable,
        days: tiles,
      });
    }

    const payload = {
      company,
      timezone,
      timezone_offset_minutes: offsetMinutes,
      rangeDays: RANGE_DAYS,
      minRentableGapHours: MIN_RENTABLE_GAP_HOURS,
      cars: outCars,
      note: "Uses /settings/current + /inventory_levels + /plannings. No manual offset guessing.",
    };

    _cache = { at: Date.now(), payload };

    return sendJson(res, 200, payload, 15);
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
}
