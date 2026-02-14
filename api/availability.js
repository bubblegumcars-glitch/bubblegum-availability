// api/availability.js
// Bubblegum Cars staff availability (Booqable API v4)
//
// ✅ Correct v4 pagination: page[size]=.. & page[number]=.. (NOT per_page/page=1)
// ✅ Robust mapping: plannings -> (inventory_level OR item) -> product
// ✅ Uses /settings/current timezone + timezone_offset to interpret offset-less datetimes
// ✅ Adds debug counters to see why anything goes “all green”
// ✅ Adds "min rentable gap" logic for nextAvailable

const RANGE_DAYS = 4;
const MIN_RENTABLE_GAP_HOURS = 4;

// v4 uses page[size], page[number]
const PAGE_SIZE = 100;

// keep these conservative to reduce 429s
const MAX_PRODUCTS_PAGES = 10;
const MAX_LEVELS_PAGES = 20;
const MAX_ITEMS_PAGES = 20;
const MAX_PLANNINGS_PAGES = 20;

// Light cache to reduce 429s (Vercel serverless may reuse runtime briefly)
let _cache = { at: 0, payload: null };
const CACHE_MS = 15_000;

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
  return new Promise((r) => setTimeout(r, ms));
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
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate() + addDays;

  const localMidnightMs = Date.UTC(y, m, d, 0, 0, 0, 0);
  return localMidnightMs - offMs; // back to UTC
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
    const now = Date.now();
    if (_cache.payload && now - _cache.at < CACHE_MS) {
      return sendJson(res, 200, _cache.payload, 10);
    }

    const company = process.env.BOOQABLE_COMPANY_SLUG;
    const token = process.env.BOOQABLE_ACCESS_TOKEN;

    if (!company || !token) {
      return sendJson(res, 500, { error: "Missing BOOQABLE_COMPANY_SLUG or BOOQABLE_ACCESS_TOKEN" });
    }

    async function booqable(path, attempt = 0) {
      const url = `https://${company}.booqable.com/api/4${path}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

      if (r.status === 429 && attempt < 6) {
        const wait = 500 * Math.pow(2, attempt); // 0.5s, 1s, 2s, 4s...
        await sleep(wait);
        return booqable(path, attempt + 1);
      }

      if (!r.ok) {
        const t = await r.text();
        throw new Error(`Booqable error ${r.status} for ${path} :: ${t}`);
      }
      return r.json();
    }

    function pagedPath(basePath, pageNumber) {
      const join = basePath.includes("?") ? "&" : "?";
      return `${basePath}${join}page[size]=${PAGE_SIZE}&page[number]=${pageNumber}`;
    }

    const debug = {
      timezone: null,
      timezone_offset_minutes: null,

      fetchedProducts: 0,
      carProducts: 0,

      fetchedInventoryLevels: 0,
      mappedInvLevelsToCars: 0,

      fetchedItems: 0,
      mappedItemsToCars: 0,

      fetchedPlannings: 0,
      planningsMappedToCars: 0,
      planningsDroppedNoRel: 0,
      planningsDroppedUnknownCar: 0,

      intervalsTotal: 0,
    };

    // 1) Settings
    const settings = await booqable("/settings/current");
    const timezone = settings?.data?.attributes?.defaults?.timezone || "UTC";
    const offsetMinutes = settings?.data?.attributes?.defaults?.timezone_offset || 0;

    debug.timezone = timezone;
    debug.timezone_offset_minutes = offsetMinutes;

    // 2) Products (cars only)
    const products = [];
    for (let page = 1; page <= MAX_PRODUCTS_PAGES; page++) {
      const out = await booqable(pagedPath("/products", page));
      const rows = out?.data || [];
      products.push(...rows);
      if (rows.length < PAGE_SIZE) break;
    }
    debug.fetchedProducts = products.length;

    const cars = products
      .filter((p) => {
        const a = p.attributes || {};
        return (
          a.product_type === "rental" &&
          a.trackable === true &&
          a.show_in_store === true &&
          a.has_variations === false &&
          a.variation === false
        );
      })
      .map((p) => ({
        id: p.id,
        name: (p.attributes?.name || "").trim(),
        slug: p.attributes?.slug,
        photo_url: p.attributes?.photo_url,
        buffer_before_s: p.attributes?.buffer_time_before || 0,
        buffer_after_s: p.attributes?.buffer_time_after || 0,
      }));

    debug.carProducts = cars.length;

    const carById = new Map(cars.map((c) => [c.id, c]));

    // 3) Inventory levels: map inventory_level_id -> product_id
    const invToProduct = new Map();
    for (let page = 1; page <= MAX_LEVELS_PAGES; page++) {
      const out = await booqable(pagedPath("/inventory_levels", page));
      const rows = out?.data || [];
      debug.fetchedInventoryLevels += rows.length;

      for (const lvl of rows) {
        const invId = lvl.id;
        const productId = lvl?.relationships?.product?.data?.id;
        if (invId && productId) {
          invToProduct.set(invId, productId);
          if (carById.has(productId)) debug.mappedInvLevelsToCars++;
        }
      }

      if (rows.length < PAGE_SIZE) break;
    }

    // 4) Items: map item_id -> product_id
    const itemToProduct = new Map();
    for (let page = 1; page <= MAX_ITEMS_PAGES; page++) {
      const out = await booqable(pagedPath("/items", page));
      const rows = out?.data || [];
      debug.fetchedItems += rows.length;

      for (const it of rows) {
        const itemId = it.id;
        const productId = it?.relationships?.product?.data?.id;
        if (itemId && productId) {
          itemToProduct.set(itemId, productId);
          if (carById.has(productId)) debug.mappedItemsToCars++;
        }
      }

      if (rows.length < PAGE_SIZE) break;
    }

    // 5) Plannings: build booked intervals per product via inventory_level OR item relationship
    const intervalsByProduct = new Map();
    for (const c of cars) intervalsByProduct.set(c.id, []);

    const baseUtcMs = Date.now();
    const windowStartUtcMs = localMidnightUtcMs(baseUtcMs, offsetMinutes, 0) - 2 * 86400000;
    const windowEndUtcMs = localMidnightUtcMs(baseUtcMs, offsetMinutes, RANGE_DAYS + 2);

    for (let page = 1; page <= MAX_PLANNINGS_PAGES; page++) {
      // include is optional; fine if ignored
      const out = await booqable(pagedPath("/plannings?include=inventory_level,item", page));
      const rows = out?.data || [];
      debug.fetchedPlannings += rows.length;

      for (const pl of rows) {
        const rel = pl?.relationships || {};
        const invId = rel?.inventory_level?.data?.id || null;
        const itemId = rel?.item?.data?.id || null;

        let productId = null;
        if (invId && invToProduct.has(invId)) productId = invToProduct.get(invId);
        if (!productId && itemId && itemToProduct.has(itemId)) productId = itemToProduct.get(itemId);

        if (!productId) {
          debug.planningsDroppedNoRel++;
          continue;
        }
        if (!carById.has(productId)) {
          debug.planningsDroppedUnknownCar++;
          continue;
        }

        const startsRaw = pl?.attributes?.starts_at;
        const stopsRaw = pl?.attributes?.stops_at;

        const starts = parseBooqableDate(startsRaw, offsetMinutes);
        const stops = parseBooqableDate(stopsRaw, offsetMinutes);
        if (!starts || !stops) continue;

        let startMs = starts.getTime();
        let endMs = stops.getTime();

        if (!overlap(startMs, endMs, windowStartUtcMs, windowEndUtcMs)) continue;

        const car = carById.get(productId);
        const bufBeforeMs = (car.buffer_before_s || 0) * 1000;
        const bufAfterMs = (car.buffer_after_s || 0) * 1000;

        startMs -= bufBeforeMs;
        endMs += bufAfterMs;

        intervalsByProduct.get(productId).push({
          startMs,
          endMs,
          startsRaw: starts,
          stopsRaw: stops,
        });

        debug.planningsMappedToCars++;
      }

      if (rows.length < PAGE_SIZE) break;
    }

    for (const arr of intervalsByProduct.values()) {
      arr.sort((a, b) => a.startMs - b.startMs);
      debug.intervalsTotal += arr.length;
    }

    // 6) Days array (local midnights)
    const days = [];
    for (let i = 0; i < RANGE_DAYS; i++) {
      const startUtcMs = localMidnightUtcMs(baseUtcMs, offsetMinutes, i);
      const endUtcMs = startUtcMs + 86400000;
      days.push({
        startUtcMs,
        endUtcMs,
        label: fmtDayLabel(new Date(startUtcMs), timezone),
        date: new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date(startUtcMs)), // YYYY-MM-DD
      });
    }

    // 7) Build per-car tiles + nextAvailable
    const nowMs = Date.now();
    const outCars = [];

    for (const car of cars) {
      const ivals = intervalsByProduct.get(car.id) || [];

      const bookedNow = ivals.some((iv) => nowMs >= iv.startMs && nowMs < iv.endMs);

      let nextAvailable = "Available now";

      if (bookedNow) {
        nextAvailable = null;

        for (let i = 0; i < ivals.length; i++) {
          const iv = ivals[i];
          if (nowMs < iv.endMs) {
            const nextStart = ivals[i + 1]?.startMs ?? null;
            const gapMs = nextStart ? nextStart - iv.endMs : null;

            // If there’s another booking soon, only show "next available" if the gap is rentable.
            if (gapMs === null || gapMs >= MIN_RENTABLE_GAP_HOURS * 3600000) {
              nextAvailable = fmtNextAvailable(new Date(iv.endMs), timezone);
              break;
            }
          }
        }

        if (!nextAvailable) {
          const last = ivals[ivals.length - 1];
          nextAvailable = last ? fmtNextAvailable(new Date(last.endMs), timezone) : "Unknown";
        }
      }

      const tiles = days.map((d) => {
        const overlaps = ivals.filter((iv) => overlap(iv.startMs, iv.endMs, d.startUtcMs, d.endUtcMs));

        if (overlaps.length === 0) {
          return { date: d.date, label: d.label, status: "Available" };
        }

        // show first overlap for that day (simple)
        const first = overlaps[0];

        return {
          date: d.date,
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
      debug,
      note:
        "If everything is green, check debug.fetchedPlannings and debug.planningsMappedToCars. Mapping supports inventory_level OR item relationships.",
    };

    _cache = { at: Date.now(), payload };

    return sendJson(res, 200, payload, 10);
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
}
