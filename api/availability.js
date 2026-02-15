// api/availability.js
// Bubblegum Cars staff availability (Booqable API v4)
//
// Key change:
// ✅ STOP using /inventory_levels (it requires item_id or order_id -> your 422 error)
// ✅ Use /plannings as the source of truth for booked intervals (pickup/return times)
//
// Features:
// - Shows day tiles (Booked/Available/Heads-up) with From/Until times
// - "Available now" is only shown if NOW is not inside any planning interval
// - "Next available" ignores tiny gaps (< MIN_RENTABLE_GAP_HOURS, default 4h)
// - Uses /settings/current timezone + timezone_offset to correctly parse datetimes
// - Caches responses to reduce 429 rate limits

const RANGE_DAYS = 4;
const MIN_RENTABLE_GAP_HOURS = 4;

const PAGE_SIZE = 100;
const MAX_PRODUCTS_PAGES = 10;
const MAX_PLANNINGS_PAGES = 50; // can be higher if you have many plannings

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

  // Interpret naive string as local time, then convert to UTC by subtracting offset
  // Example: "2026-02-15T22:00:00" with +600 minutes should become 12:00Z.
  const assumedUtc = new Date(str + "Z");
  if (isNaN(assumedUtc.getTime())) return null;
  return new Date(assumedUtc.getTime() - accountOffsetMinutes * 60 * 1000);
}

function overlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// Build UTC ms for "local midnight" using fixed offset minutes.
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
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (r.status === 429 && attempt < 7) {
        const wait = 500 * Math.pow(2, attempt);
        await sleep(wait);
        return booqable(path, attempt + 1);
      }

      if (!r.ok) {
        const t = await r.text();
        throw new Error(`Booqable error ${r.status} for ${path} :: ${t}`);
      }

      return r.json();
    }

    const debug = {
      timezone: null,
      timezone_offset_minutes: null,
      fetchedProducts: 0,
      carProducts: 0,
      fetchedPlannings: 0,
      includedCounts: { inventory_levels: 0, items: 0, products: 0 },
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

    // 2) Cars (products)
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
    const intervalsByProduct = new Map(cars.map((c) => [c.id, []]));

    // 3) Build day tiles
    const baseUtcMs = Date.now();
    const days = [];
    for (let i = 0; i < RANGE_DAYS; i++) {
      const startUtcMs = localMidnightUtcMs(baseUtcMs, offsetMinutes, i);
      const endUtcMs = startUtcMs + 86400000;
      days.push({
        startUtcMs,
        endUtcMs,
        label: fmtDayLabel(new Date(startUtcMs), timezone),
        date: new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(
          new Date(startUtcMs)
        ),
      });
    }

    // 4) Plannings (source of truth)
    //
    // Include nested product relationships so we can map planning -> product without extra calls.
    // We will try: inventory_level.product and item.product
    //
    // NOTE: This endpoint can be large; we rely on cache + 429 backoff.
    const planningsPathBase = "/plannings?include=inventory_level,inventory_level.product,item,item.product";

    // Build lookup tables from "included"
    const includedInventoryLevelToProduct = new Map();
    const includedItemToProduct = new Map();

    function digestIncluded(included) {
      if (!Array.isArray(included)) return;
      for (const inc of included) {
        if (!inc || !inc.type) continue;

        if (inc.type === "inventory_level") {
          debug.includedCounts.inventory_levels++;
          const invId = inc.id;
          const prodId = inc?.relationships?.product?.data?.id;
          if (invId && prodId) includedInventoryLevelToProduct.set(invId, prodId);
        }

        if (inc.type === "item") {
          debug.includedCounts.items++;
          const itemId = inc.id;
          const prodId = inc?.relationships?.product?.data?.id;
          if (itemId && prodId) includedItemToProduct.set(itemId, prodId);
        }

        if (inc.type === "product") {
          debug.includedCounts.products++;
        }
      }
    }

    // Pull plannings pages
    for (let page = 1; page <= MAX_PLANNINGS_PAGES; page++) {
      const path = addPaging(planningsPathBase, page);
      const out = await booqable(path);

      const rows = out?.data || [];
      debug.fetchedPlannings += rows.length;

      digestIncluded(out?.included);

      for (const pl of rows) {
        const rel = pl?.relationships || {};
        const invId = rel?.inventory_level?.data?.id || null;
        const itemId = rel?.item?.data?.id || null;

        let productId = null;
        if (invId && includedInventoryLevelToProduct.has(invId)) {
          productId = includedInventoryLevelToProduct.get(invId);
        }
        if (!productId && itemId && includedItemToProduct.has(itemId)) {
          productId = includedItemToProduct.get(itemId);
        }

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

        const car = carById.get(productId);

        // apply buffers (in seconds)
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

    // sort intervals per car
    for (const arr of intervalsByProduct.values()) {
      arr.sort((a, b) => a.startMs - b.startMs);
    }

    // 5) Build output cars
    const nowMs = Date.now();
    const outCars = [];

    for (const car of cars) {
      const ivals = intervalsByProduct.get(car.id) || [];

      // BOOKED NOW if any interval overlaps "now"
      const bookedNow = ivals.some((iv) => nowMs >= iv.startMs && nowMs < iv.endMs);

      // Next available:
      // - if booked now: first rentable gap after the current blocking interval
      // - if not booked now: "Available now"
      let nextAvailable = "Available now";

      if (bookedNow) {
        nextAvailable = null;

        // find the interval that contains now (or the next ending interval after now)
        for (let i = 0; i < ivals.length; i++) {
          const iv = ivals[i];
          if (nowMs < iv.endMs) {
            const nextStart = ivals[i + 1]?.startMs ?? null;
            const gapMs = nextStart ? nextStart - iv.endMs : null;

            // if no next booking OR the gap is "rentable"
            if (gapMs === null || gapMs >= MIN_RENTABLE_GAP_HOURS * 3600000) {
              nextAvailable = fmtNextAvailable(new Date(iv.endMs), timezone);
              break;
            }
            // gap too small -> skip to next interval and keep searching
          }
        }

        if (!nextAvailable) {
          // fallback: end of last interval
          const last = ivals[ivals.length - 1];
          nextAvailable = last ? fmtNextAvailable(new Date(last.endMs), timezone) : "Unknown";
        }
      }

      // Day tiles:
      const tiles = days.map((d) => {
        // intervals that overlap this day
        const overlapsForDay = ivals.filter((iv) =>
          overlap(iv.startMs, iv.endMs, d.startUtcMs, d.endUtcMs)
        );

        if (overlapsForDay.length === 0) {
          return { date: d.date, label: d.label, status: "Available" };
        }

        // For the tile, use the first overlap as representative "From -> Until"
        const first = overlapsForDay[0];
        const bookedFrom = fmtTime(first.startsRaw, timezone);
        const bookedUntil = fmtTime(first.stopsRaw, timezone);

        // Heads-up: if day is booked, but it frees up before end-of-day, show as orange
        // (still "Booked", but visually Heads-up on the UI)
        const freesBeforeEndOfDay = first.endMs < d.endUtcMs;

        if (freesBeforeEndOfDay) {
          const backTime = fmtTime(first.stopsRaw, timezone);
          const freeTime = fmtTime(new Date(first.endMs), timezone); // includes buffer_after
          return {
            date: d.date,
            label: d.label,
            status: "Heads-up",
            bookedFrom,
            bookedUntil,
            backTime,
            freeTime,
          };
        }

        return {
          date: d.date,
          label: d.label,
          status: "Booked",
          bookedFrom,
          bookedUntil,
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
      rangeDays: RANGE_DAYS,
      minRentableGapHours: MIN_RENTABLE_GAP_HOURS,
      timezone,
      timezone_offset_minutes: offsetMinutes,
      days: days.map((d) => ({ date: d.date, label: d.label })),
      cars: outCars,
      debug,
      note:
        "Uses /plannings only. If 'Available now' is wrong, check debug.timezone/timezone_offset and confirm plannings.starts_at/stops_at match staff app times.",
    };

    _cache = { at: Date.now(), payload };
    return sendJson(res, 200, payload, 10);
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
}
