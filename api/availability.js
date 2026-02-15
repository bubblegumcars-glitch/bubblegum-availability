// api/availability.js
//
// Bubblegum Cars staff availability (Booqable API v4)
//
// Fixes applied:
// - Use JSON:API Accept header (often required for include/relationships to be populated)
// - Filter /plannings by date range (reduces load + 429s)
// - Map plannings to products via multiple strategies:
//    A) planning -> order -> lines -> product
//    B) planning -> product
//    C) planning -> item -> product
//    D) planning -> inventory_level -> product
// - Exclude add-ons (e.g., Additional Driver(s)) by name/slug keywords
//
// Output:
// - Day tiles show Booked/Heads-up/Available
// - Booked tiles show From -> Until (pickup/return)
// - Heads-up tiles show Back/Free times (return + buffer)
// - Next available respects min rentable gap (default 4 hours)
//
// Env vars required on Vercel:
// - BOOQABLE_COMPANY_SLUG = bubblegum-cars
// - BOOQABLE_ACCESS_TOKEN = <token>

const RANGE_DAYS = 4;
const PAGE_SIZE = 100;
const MAX_PRODUCTS_PAGES = 10;
const MAX_PLANNINGS_PAGES = 40;

const CACHE_MS = 15_000; // reduce 429s
let _cache = { at: 0, payload: null };

const MIN_RENTABLE_GAP_HOURS_DEFAULT = 4;

// Hard-exclude add-ons by keywords (you can add to this list)
const EXCLUDE_KEYWORDS = [
  "additional driver",
  "add on",
  "addon",
  "accident excess",
  "excess",
  "insurance",
];

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

// Parse Booqable datetime strings.
// IMPORTANT: Booqable sends times with "+00:00" that are actually LOCAL times,
// not UTC times. We must treat ALL timestamps as naive local times.
function parseBooqableDate(str, accountOffsetMinutes) {
  if (!str) return null;

  // Strip any offset markers (+00:00, Z, etc) - Booqable times are always local
  const naive = str.replace(/([zZ]|[+\-]\d{2}:\d{2})$/, "");
  
  // Interpret as local time, then convert to UTC by subtracting offset
  const assumedUtc = new Date(naive + "Z");
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

function fmtISODate(dateObj, timezone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(dateObj);
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

// Round late evening/early morning returns to 9am
// If return is between 6pm and 8:45am, round to 9am
function roundToBusinessHours(utcMs, timezone, offsetMinutes) {
  // Convert UTC ms to local time for checking
  const localMs = utcMs + (offsetMinutes * 60 * 1000);
  const localDate = new Date(localMs);
  const hours = localDate.getUTCHours();
  const minutes = localDate.getUTCMinutes();
  
  // Check if between 18:00 (6pm) and 08:45 (8:45am)
  const isLateEvening = hours >= 18; // 6pm to midnight
  const isEarlyMorning = hours < 8 || (hours === 8 && minutes <= 45); // midnight to 8:45am
  
  if (isLateEvening || isEarlyMorning) {
    // Get the date in local timezone
    const year = localDate.getUTCFullYear();
    const month = localDate.getUTCMonth();
    const day = localDate.getUTCDate();
    
    // If it's late evening (6pm-midnight), move to next day at 9am
    // If it's early morning (midnight-8:45am), use same day at 9am
    const targetDay = isLateEvening ? day + 1 : day;
    
    // Create 9am local time on the target day
    const nineAmLocal = Date.UTC(year, month, targetDay, 9, 0, 0, 0);
    
    // Convert back to UTC
    return nineAmLocal - (offsetMinutes * 60 * 1000);
  }
  
  // Return as-is if during business hours
  return utcMs;
}

function addPaging(pathWithMaybeQuery, pageNumber) {
  const join = pathWithMaybeQuery.includes("?") ? "&" : "?";
  return `${pathWithMaybeQuery}${join}page[size]=${PAGE_SIZE}&page[number]=${pageNumber}`;
}

function containsExcludedKeyword(nameOrSlug) {
  const s = (nameOrSlug || "").toLowerCase();
  return EXCLUDE_KEYWORDS.some((k) => s.includes(k));
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
      return sendJson(res, 500, {
        error: "Missing BOOQABLE_COMPANY_SLUG or BOOQABLE_ACCESS_TOKEN",
      });
    }

    const minRentableGapHours =
      Number(req.query.minRentableGapHours || "") || MIN_RENTABLE_GAP_HOURS_DEFAULT;

    async function booqable(path, attempt = 0) {
      const url = `https://${company}.booqable.com/api/4${path}`;
      const r = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.api+json",
        },
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
      includedCounts: {},
      relationshipKeyStats: {},
      planningsMappedToCars: 0,
      planningsDroppedNoRel: 0,
      planningsDroppedUnknownCar: 0,
      planningsDateRange: null,
      sampleItemStructure: null,  // NEW: will capture first item's structure
      samplePlanningStructure: null,  // NEW: will capture first planning's structure
    };

    // 1) Settings (timezone + offset)
    const settings = await booqable("/settings/current");
    const timezone = settings?.data?.attributes?.defaults?.timezone || "UTC";
    const offsetMinutes = settings?.data?.attributes?.defaults?.timezone_offset || 0;
    debug.timezone = timezone;
    debug.timezone_offset_minutes = offsetMinutes;

    // 2) Compute day windows (local midnights)
    const baseUtcMs = Date.now();
    const days = [];
    for (let i = 0; i < RANGE_DAYS; i++) {
      const startUtcMs = localMidnightUtcMs(baseUtcMs, offsetMinutes, i);
      const endUtcMs = startUtcMs + 86400000;
      const dateObj = new Date(startUtcMs);
      days.push({
        startUtcMs,
        endUtcMs,
        label: fmtDayLabel(dateObj, timezone),
        date: fmtISODate(dateObj, timezone),
      });
    }

    const fromIso = new Date(days[0].startUtcMs).toISOString();
    const tillIso = new Date(days[days.length - 1].endUtcMs).toISOString();
    debug.planningsDateRange = { fromIso, tillIso };

    // 3) Products (cars)
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
        const name = (a.name || "").trim();
        const slug = a.slug || "";

        // core car filter
        const isCar =
          a.product_type === "rental" &&
          a.trackable === true &&
          a.show_in_store === true;

        // exclude add-ons by keywords in name/slug
        if (containsExcludedKeyword(name) || containsExcludedKeyword(slug)) return false;

        return isCar;
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

    // 4) Plannings
    //
    // IMPORTANT: include must be on the SAME request, and JSON:API Accept must be set,
    // otherwise "included" can come back empty and relationships might be sparse.
    //
    // We request multiple include paths, and then map plannings -> products using:
    // - planning.relationships.order -> included order -> order.relationships.lines -> included line -> line.relationships.product
    // - planning.relationships.product (if exists)
    // - planning.relationships.item -> included item -> item.relationships.product
    // - planning.relationships.inventory_level -> included inventory_level -> inventory_level.relationships.product
    //
    const includeParam = [
      "order",
      "order.lines",
      "order.lines.product",
      "product",
      "item",
      "item.product",
      "inventory_level",
      "inventory_level.product",
    ].join(",");

    const basePlanningsPath =
      `/plannings?filter[starts_at][lte]=${encodeURIComponent(tillIso)}` +
      `&filter[stops_at][gte]=${encodeURIComponent(fromIso)}` +
      `&include=${encodeURIComponent(includeParam)}`;

    // Store included by type:id
    const includedByKey = new Map();
    function indexIncluded(included) {
      if (!Array.isArray(included)) return;
      for (const inc of included) {
        if (!inc?.type || !inc?.id) continue;
        includedByKey.set(`${inc.type}:${inc.id}`, inc);
        debug.includedCounts[inc.type] = (debug.includedCounts[inc.type] || 0) + 1;
      }
    }

    function getIncluded(type, id) {
      return includedByKey.get(`${type}:${id}`) || null;
    }

    function statRelKeys(pl) {
      const rel = pl?.relationships || {};
      for (const k of Object.keys(rel)) {
        debug.relationshipKeyStats[k] = (debug.relationshipKeyStats[k] || 0) + 1;
      }
    }

    function getRelId(relObj) {
      const d = relObj?.data;
      if (!d) return null;
      if (Array.isArray(d)) return d[0]?.id || null;
      return d.id || null;
    }

    function getRelType(relObj) {
      const d = relObj?.data;
      if (!d) return null;
      if (Array.isArray(d)) return d[0]?.type || null;
      return d.type || null;
    }

    function resolveProductIdFromPlanning(pl) {
      const rel = pl?.relationships || {};
      const attrs = pl?.attributes || {};

      // CRITICAL: In Booqable v4, item_id in planning attributes IS the product ID
      // The "item" relationship just returns the product with type "products"
      if (attrs.item_id) return attrs.item_id;

      // A) Direct product relationship
      if (rel.product?.data?.id) return rel.product.data.id;

      // Some APIs use plural products
      if (Array.isArray(rel.products?.data) && rel.products.data[0]?.id) {
        return rel.products.data[0].id;
      }

      // B) inventory_level -> product
      if (rel.inventory_level?.data?.id) {
        const invType = getRelType(rel.inventory_level) || "inventory_level";
        const inv = getIncluded(invType, rel.inventory_level.data.id);
        const prodId = inv?.relationships?.product?.data?.id;
        if (prodId) return prodId;
      }

      // C) item -> product (check both relationship AND attributes)
      if (rel.item?.data?.id) {
        const itemType = getRelType(rel.item) || "item";
        const item = getIncluded(itemType, rel.item.data.id);
        
        // Try relationship first
        const prodIdFromRel = item?.relationships?.product?.data?.id;
        if (prodIdFromRel) return prodIdFromRel;
        
        // Try attributes.product_id as fallback
        const prodIdFromAttr = item?.attributes?.product_id;
        if (prodIdFromAttr) return prodIdFromAttr;
      }

      // D) order -> lines -> product
      if (rel.order?.data?.id) {
        const orderType = getRelType(rel.order) || "order";
        const order = getIncluded(orderType, rel.order.data.id);
        const lines = order?.relationships?.lines?.data;

        if (Array.isArray(lines)) {
          for (const lineRef of lines) {
            const line = getIncluded(lineRef.type, lineRef.id);
            const prodId = line?.relationships?.product?.data?.id;
            if (prodId && carById.has(prodId)) return prodId;
          }
        }
      }

      return null;
    }

    for (let page = 1; page <= MAX_PLANNINGS_PAGES; page++) {
      const path = addPaging(basePlanningsPath, page);
      const out = await booqable(path);

      const rows = out?.data || [];
      debug.fetchedPlannings += rows.length;

      indexIncluded(out?.included);

      for (const pl of rows) {
        statRelKeys(pl);
        
        // Capture first planning structure for debugging
        if (!debug.samplePlanningStructure) {
          debug.samplePlanningStructure = {
            id: pl.id,
            type: pl.type,
            attributes: pl.attributes,
            relationships: Object.keys(pl.relationships || {})
          };
        }
        
        // Capture first item structure if available
        if (!debug.sampleItemStructure && pl.relationships?.item?.data?.id) {
          const itemType = getRelType(pl.relationships.item) || "item";
          const item = getIncluded(itemType, pl.relationships.item.data.id);
          if (item) {
            debug.sampleItemStructure = {
              id: item.id,
              type: item.type,
              attributes: item.attributes,
              relationships: Object.keys(item.relationships || {})
            };
          }
        }

        const productId = resolveProductIdFromPlanning(pl);
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

        // apply buffers (seconds)
        startMs -= (car.buffer_before_s || 0) * 1000;
        endMs += (car.buffer_after_s || 0) * 1000;

        intervalsByProduct.get(productId).push({
          startMs,
          endMs,
          startsRaw: starts, // unbuffered start
          stopsRaw: stops,   // unbuffered stop
        });

        debug.planningsMappedToCars++;
      }

      if (rows.length < PAGE_SIZE) break;
    }

    // sort intervals per car
    for (const arr of intervalsByProduct.values()) {
      arr.sort((a, b) => a.startMs - b.startMs);
    }

    // 5) Build response per car
    const nowMs = Date.now();
    const outCars = [];

    for (const car of cars) {
      const ivals = intervalsByProduct.get(car.id) || [];

      // booked now if any interval contains now
      const bookedNow = ivals.some((iv) => nowMs >= iv.startMs && nowMs < iv.endMs);
      
      // Check if we're currently in business hours (9am - 6pm)
      const localNowMs = nowMs + (offsetMinutes * 60 * 1000);
      const localNow = new Date(localNowMs);
      const currentHour = localNow.getUTCHours();
      const isBusinessHours = currentHour >= 9 && currentHour < 18;

      // next available
      let nextAvailable = "Available now";
      
      // Only show "Available now" if not booked AND during business hours
      if (bookedNow || !isBusinessHours) {
        nextAvailable = null;

        // Find the next available slot
        let foundAvailableSlot = false;
        
        for (let i = 0; i < ivals.length; i++) {
          const iv = ivals[i];

          // Skip past bookings
          if (nowMs >= iv.endMs) continue;

          // Round this interval's end to business hours
          const roundedEndMs = roundToBusinessHours(iv.endMs, timezone, offsetMinutes);
          
          // Check if the next interval starts BEFORE our rounded available time
          const nextInterval = ivals[i + 1];
          
          if (!nextInterval) {
            // No more bookings after this one
            nextAvailable = fmtNextAvailable(new Date(roundedEndMs), timezone);
            foundAvailableSlot = true;
            break;
          }
          
          // Calculate the gap between this booking ending and next one starting
          const gapMs = nextInterval.startMs - roundedEndMs;
          
          // If gap is less than minimum rentable, show available time but warn about next booking
          if (gapMs > 0 && gapMs < minRentableGapHours * 3600000) {
            const availableTime = fmtNextAvailable(new Date(roundedEndMs), timezone);
            const nextBookingTime = fmtTime(new Date(nextInterval.startMs), timezone);
            nextAvailable = `${availableTime} (booked ${nextBookingTime})`;
            foundAvailableSlot = true;
            break;
          }
          
          // If next booking starts after our rounded time with sufficient gap, we have a rentable slot
          if (gapMs >= minRentableGapHours * 3600000) {
            nextAvailable = fmtNextAvailable(new Date(roundedEndMs), timezone);
            foundAvailableSlot = true;
            break;
          }
          
          // Otherwise, the rounded time conflicts with next booking, so continue to next interval
        }

        // If we're outside business hours, not currently booked, and have no future bookings
        if (!foundAvailableSlot && !bookedNow && ivals.length === 0) {
          // Round current time to next 9am
          const nextBusinessOpen = roundToBusinessHours(nowMs, timezone, offsetMinutes);
          nextAvailable = fmtNextAvailable(new Date(nextBusinessOpen), timezone);
        }
        
        // Fallback for edge cases
        if (!nextAvailable) {
          const last = ivals[ivals.length - 1];
          if (last) {
            const roundedEndMs = roundToBusinessHours(last.endMs, timezone, offsetMinutes);
            nextAvailable = fmtNextAvailable(new Date(roundedEndMs), timezone);
          } else {
            // No bookings at all, round current time to next business hours
            const nextBusinessOpen = roundToBusinessHours(nowMs, timezone, offsetMinutes);
            nextAvailable = fmtNextAvailable(new Date(nextBusinessOpen), timezone);
          }
        }
      }

      // tiles
      const tiles = days.map((d) => {
        const overlapsForDay = ivals.filter((iv) =>
          overlap(iv.startMs, iv.endMs, d.startUtcMs, d.endUtcMs)
        );

        if (overlapsForDay.length === 0) {
          return { date: d.date, label: d.label, status: "Available" };
        }

        const first = overlapsForDay[0];
        const bookedFrom = fmtTime(first.startsRaw, timezone);
        const bookedUntil = fmtTime(first.stopsRaw, timezone);

        const freesBeforeEndOfDay = first.endMs < d.endUtcMs;

        if (freesBeforeEndOfDay) {
          // Round the free time to business hours (9am if between 6pm-8:45am)
          const roundedEndMs = roundToBusinessHours(first.endMs, timezone, offsetMinutes);
          
          // Check if the rounded time falls on the SAME day or NEXT day
          // If it rounds to next day, this day should be RED (fully booked), not orange
          const endDayStart = d.startUtcMs;
          const endDayEnd = d.endUtcMs;
          
          // If rounded time is still within this day, show Heads-up (orange)
          if (roundedEndMs < endDayEnd) {
            return {
              date: d.date,
              label: d.label,
              status: "Heads-up",
              bookedFrom,
              bookedUntil,
              backTime: fmtTime(first.stopsRaw, timezone),
              freeTime: fmtTime(new Date(roundedEndMs), timezone),
            };
          }
          
          // Otherwise, rounded to next day = show as fully Booked (red)
          return {
            date: d.date,
            label: d.label,
            status: "Booked",
            bookedFrom,
            bookedUntil,
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

    // Optional: consistent ordering by name (puts add-ons last even if they sneak in)
    outCars.sort((a, b) => a.name.localeCompare(b.name, "en"));

    const payload = {
      company,
      rangeDays: RANGE_DAYS,
      minRentableGapHours,
      timezone,
      timezone_offset_minutes: offsetMinutes,
      days: days.map((d) => ({ date: d.date, label: d.label })),
      cars: outCars,
      debug,
      note:
        "If cars still show Available when booked: check debug.relationshipKeyStats to see what relationship keys plannings actually expose (order/item/inventory_level/product etc).",
    };

    _cache = { at: Date.now(), payload };
    return sendJson(res, 200, payload, 10);
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
}
