// api/availability.js
// Bubblegum Cars staff availability (Booqable API v4)
//
// Fixes:
/// ✅ inventory_levels requires filter[from], filter[till] (your error)
/// ✅ builds query strings via URLSearchParams so filters cannot be dropped
/// ✅ correct v4 pagination: page[size], page[number]
/// ✅ uses /settings/current timezone + timezone_offset for offset-less datetimes
/// ✅ "Available now" is false if ANY planning overlaps now
/// ✅ "Next available" respects MIN_RENTABLE_GAP_HOURS (default 4h)
//
// Notes:
/// - Brisbane has no DST, so timezone_offset minutes is stable.

const RANGE_DAYS = 4;
const MIN_RENTABLE_GAP_HOURS = 4;

const PAGE_SIZE = 100;

// caps to avoid runaway + 429 storms
const MAX_PRODUCTS_PAGES = 10;
const MAX_LEVELS_PAGES = 20;
const MAX_ITEMS_PAGES = 20;
const MAX_PLANNINGS_PAGES = 20;

// tiny cache to reduce 429s
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

// Parse Booqable datetime strings:
// - If has offset/Z -> Date(str)
// - If no offset -> treat as "company local", convert to UTC using timezone_offset minutes
function parseBooqableDate(str, accountOffsetMinutes) {
  if (!str) return null;

  if (hasOffset(str)) {
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
  }

  // Interpret naive string as local time -> convert to UTC by subtracting offset
  const assumedUtc = new Date(str + "Z");
  if (isNaN(assumedUtc.getTime())) return null;
  return new Date(assumedUtc.getTime() - accountOffsetMinutes * 60 * 1000);
}

function overlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// Build UTC ms for "local midnight" using a fixed offset (minutes).
function localMidnightUtcMs(baseUtcMs, offsetMinutes, addDays) {
  const offMs = offsetMinutes * 60 * 1000;
  const localMs = baseUtcMs + offMs;

  const local = new Date(localMs);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate() + addDays;

  const localMidnightMs = Date.UTC(y, m, d, 0, 0, 0, 0);
  return localMidnightMs - offMs;
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

function buildPath(pathname, paramsObj) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(paramsObj || {})) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  const qs = sp.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

function addPaging(pathWithMaybeQuery, pageNumber) {
  const join = pathWithMaybeQuery.includes("?") ? "&" : "?";
  return `${pathWithMaybeQuery}${join}page[size]=${PAGE_SIZE}&page[number]=${pageNumber}`;
}

export default async function handler(req, res) {
  try {
    // cache
    const now = Date.now();
    if (_cache.payload && now - _cache.at < CACHE_MS) {
      return sendJson(res, 200, _cache.payload, 10);
    }

    const company = process.env.BOOQABLE_COMPANY_SLUG;
    const token = process.env.BOOQABLE_ACCESS_TOKEN;

    if (!company || !token) {
      return sendJson(res, 500, {
        error: "Missing BOOQABLE_COMPANY_SLUG or BOOQABLE_ACCESS_TOKEN",
      });
    }

    async function booqable(path, attempt = 0) {
      const url = `https://${company}.booqable.com/api/4${path}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

      if (r.status === 429 && attempt < 6) {
        const wait = 500 * Math.pow(2, attempt);
        await sleep(wait);
        return booqable(path, attempt + 1);
      }

      if (!r.ok) {
        const t = await r.text();
        // IMPORTANT: include exact path here so we can see if filters are missing
        throw new Error(`Booqable error ${r.status} for ${path} :: ${t}`);
      }

      return r.json();
    }

    const debug = {
      timezone: null,
      timezone_offset_minutes: null,
      window_from_utc: null,
      window_till_utc: null,
      inventory_levels_path_example: null,
      fetchedProducts: 0,
      carProducts: 0,
      fetchedInventoryLevels: 0,
      fetchedItems: 0,
      fetchedPlannings: 0,
      planningsMappedToCars: 0,
      planningsDroppedNoRel: 0,
      planningsDroppedUnknownCar: 0,
    };

    // 1) Settings
    const settings = await booqable("/settings/current");
    const timezone = settings?.data?.attributes?.defaults?.timezone || "UTC";
    const offsetMinutes = settings?.data?.attributes?.defaults?.timezone_offset || 0;

    debug.timezone = timezone;
    debug.timezone_offset_minutes = offsetMinutes;

    // 2) Build a padded window so cross-day bookings are included
    const baseUtcMs = Date.now();
    const windowStartUtcMs = localMidnightUtcMs(baseUtcMs, offsetMinutes, 0) - 2 * 86400000;
    const windowEndUtcMs = localMidnightUtcMs(baseUtcMs, offsetMinutes, RANGE_DAYS + 2);

    const fromISO = new Date(windowStartUtcMs).toISOString();
    const tillISO = new Date(windowEndUtcMs).toISOString();

    debug.window_from_utc = fromISO;
    debug.window_till_utc = tillISO;

    // 3) Products
    const products = [];
    for (let page = 1; page <= MAX_PRODUCTS_PAGES; page++) {
      const path = addPaging("/products", page);
      const out = await booqable(path);
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
          a.show_in_store === true
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

    // 4) Day tiles
    const days = [];
    for (let i = 0; i < RANGE_DAYS; i++) {
      const startUtcMs = localMidnightUtcMs(baseUtcMs, offsetMinutes, i);
      const endUtcMs = startUtcMs + 86400000;
      days.push({
        startUtcMs,
        endUtcMs,
        label: fmtDayLabel(new Date(startUtcMs), timezone),
        date: new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date(startUtcMs)),
      });
    }

    // 5) inventory_levels (MUST include filter[from], filter[till])
    const invToProduct = new Map();

    const invBase = buildPath("/inventory_levels", {
      "filter[from]": fromISO,
      "filter[till]": tillISO,
    });

    // store an example so you can see it in /api/availability output
    debug.inventory_levels_path_example = addPaging(invBase, 1);

    for (let page = 1; page <= MAX_LEVELS_PAGES; page++) {
      const path = addPaging(invBase, page);
      const out = await booqable(path);
      const rows = out?.data || [];
      debug.fetchedInventoryLevels += rows.length;

      for (const lvl of rows) {
        const invId = lvl.id;
        const productId = lvl?.relationships?.product?.data?.id;
        if (invId && productId) invToProduct.set(invId, productId);
      }

      if (rows.length < PAGE_SIZE) break;
    }

    // 6) items (item_id -> product_id)
    const itemToProduct = new Map();
    for (let page = 1; page <= MAX_ITEMS_PAGES; page++) {
      const path = addPaging("/items", page);
      const out = await booqable(path);
      const rows = out?.data || [];
      debug.fetchedItems += rows.length;

      for (const it of rows) {
        const itemId = it.id;
        const productId = it?.relationships?.product?.data?.id;
        if (itemId && productId) itemToProduct.set(itemId, productId);
      }

      if (rows.length < PAGE_SIZE) break;
    }

    // 7) plannings -> intervals per car
    const intervalsByProduct = new Map();
    for (const c of cars) intervalsByProduct.set(c.id, []);

    for (let page = 1; page <= MAX_PLANNINGS_PAGES; page++) {
      const path = addPaging("/plannings?include=inventory_level,item", page);
      const out = await booqable(path);
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

        const starts = parseBooqableDate(pl?.attributes?.starts_at, offsetMinutes);
        const stops = parseBooqableDate(pl?.attributes?.stops_at, offsetMinutes);
        if (!starts || !stops) continue;

        let startMs = starts.getTime();
        let endMs = stops.getTime();

        // restrict to our padded window
        if (!overlap(startMs, endMs, windowStartUtcMs, windowEndUtcMs)) continue;

        const car = carById.get(productId);
        startMs -= (car.buffer_before_s || 0) * 1000;
        endMs += (car.buffer_after_s || 0) * 1000;

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

    for (const arr of intervalsByProduct.values()) arr.sort((a, b) => a.startMs - b.startMs);

    // 8) output
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

            // only “rentable” gap counts
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
        const overlapsForDay = ivals.filter((iv) => overlap(iv.startMs, iv.endMs, d.startUtcMs, d.endUtcMs));
        if (overlapsForDay.length === 0) return { date: d.date, label: d.label, status: "Available" };

        const first = overlapsForDay[0];
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
      days: days.map((d) => ({ date: d.date, label: d.label })),
      cars: outCars,
      debug,
      note:
        "If you still see the inventory_levels filter error, check debug.inventory_levels_path_example in /api/availability output — it must contain filter[from] and filter[till].",
    };

    _cache = { at: Date.now(), payload };
    return sendJson(res, 200, payload, 10);
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
}
