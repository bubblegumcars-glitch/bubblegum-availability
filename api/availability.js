// Bubblegum Cars — Availability API (Vercel Serverless)
// Fixes:
// - Uses Booqable API v1 company subdomain + api_key param
// - Adds caching to prevent rate limits
// - Adds polite retry/backoff for HTTP 429
// - Brisbane timezone, Today + next 3 days, midnight-to-midnight
// - 15-minute re-rent buffer
// - Excludes add-ons like Accident Excess by name

// -------------------- Small in-memory cache (works when function stays warm) --------------------
const MEMORY_CACHE = {
  // key -> { expiresAt: number, value: any }
  map: new Map(),
};

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

// -------------------- Helpers --------------------
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
  const yy = dt.getUTCFullYear();
  const mm = pad2(dt.getUTCMonth() + 1);
  const dd = pad2(dt.getUTCDate());
  return `${yy}-${mm}-${dd}`;
}

function toDMY(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return `${pad2(d)}-${pad2(m)}-${y}`; // DD-MM-YYYY
}

function labelForISO(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const weekday = dt.toLocaleDateString("en-AU", {
    weekday: "short",
    timeZone: "Australia/Brisbane",
  });
  const day = dt.toLocaleDateString("en-AU", {
    day: "2-digit",
    month: "short",
    timeZone: "Australia/Brisbane",
  });
  return `${weekday} ${day}`;
}

function minutesToHHMM(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

function looksLikeAddon(name) {
  const n = String(name || "").toLowerCase();
  const banned = [
    "accident excess",
    "excess",
    "insurance",
    "deposit",
    "gps",
    "child seat",
    "baby seat",
    "booster",
    "add-on",
    "addon",
  ];
  return banned.some((k) => n.includes(k));
}

// -------------------- Availability parsing --------------------
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
    if (isBooked && !inBooked) {
      inBooked = true;
      start = i;
    } else if (!isBooked && inBooked) {
      inBooked = false;
      ranges.push([start, i - 1]);
    }
  }
  if (inBooked) ranges.push([start, availFlags.length - 1]);

  return ranges;
}

function applyBufferToRanges(ranges, bufferMinutes, totalLength) {
  if (!ranges || ranges.length === 0) return [];
  const expanded = ranges.map(([s, e]) => {
    const ns = Math.max(0, s - bufferMinutes);
    const ne = Math.min(totalLength - 1, e + bufferMinutes);
    return [ns, ne];
  });

  expanded.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of expanded) {
    if (merged.length === 0) merged.push(r);
    else {
      const last = merged[merged.length - 1];
      if (r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
      else merged.push(r);
    }
  }
  return merged;
}

function bookedDetail(bufferedRanges) {
  if (!bufferedRanges || bufferedRanges.length === 0) return "";
  const parts = bufferedRanges
    .slice(0, 3)
    .map(([s, e]) => `${minutesToHHMM(s)}–${minutesToHHMM(e)}`);
  const more = bufferedRanges.length > 3 ? ` (+${bufferedRanges.length - 3} more)` : "";
  return `Booked windows (incl. buffer): ${parts.join(", ")}${more}`;
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

// -------------------- Booqable fetch with caching + retry --------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function booqableFetch(pathWithLeadingSlash, { cacheKey = null, cacheTtlMs = 0 } = {}) {
  const apiKey = requireEnv("BOOQABLE_API_KEY");
  const companySlug = requireEnv("BOOQABLE_COMPANY_SLUG");
  const base = `https://${companySlug}.booqable.com/api/1`;

  const joiner = pathWithLeadingSlash.includes("?") ? "&" : "?";
  const url = `${base}${pathWithLeadingSlash}${joiner}api_key=${encodeURIComponent(apiKey)}`;

  // Memory cache (helps reduce repeated calls)
  if (cacheKey && cacheTtlMs > 0) {
    const cached = memGet(cacheKey);
    if (cached) return cached;
  }

  // Retry/backoff for 429
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
      // Respect Retry-After if present, otherwise backoff: 0.8s, 1.6s, 3.2s...
      const ra = res.headers.get("retry-after");
      const waitMs = ra ? Math.min(8000, Number(ra) * 1000) : Math.min(8000, 800 * Math.pow(2, attempt - 1));
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      const msg = json?.error?.message || json?.message || text || `HTTP ${res.status}`;
      throw new Error(`Booqable error (${res.status}) on ${pathWithLeadingSlash}: ${msg}`);
    }

    // Save to memory cache
    if (cacheKey && cacheTtlMs > 0) memSet(cacheKey, json, cacheTtlMs);
    return json;
  }

  throw new Error("Unexpected error fetching from Booqable");
}

// -------------------- Main handler --------------------
export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    // IMPORTANT: cache the serverless response at Vercel edge to prevent hammering Booqable
    // - s-maxage=60: cache 60 seconds
    // - stale-while-revalidate=300: serve stale up to 5 mins while refreshing in background
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");

    const todayISO = brisbaneTodayISO();
    const days = [0, 1, 2, 3].map((i) => {
      const iso = addDaysISO(todayISO, i);
      return {
        date: iso,
        label: labelForISO(iso),
        from: toDMY(iso),
        till: toDMY(iso),
      };
    });

    // Cache products for 5 minutes (reduces /products calls a lot)
    const productsResp = await booqableFetch("/products", {
      cacheKey: "products",
      cacheTtlMs: 5 * 60 * 1000,
    });

    let products = normalizeProductsResponse(productsResp);

    // If /products empty, try product_groups (also cached)
    if (!products || products.length === 0) {
      const pgsResp = await booqableFetch("/product_groups", {
        cacheKey: "product_groups",
        cacheTtlMs: 5 * 60 * 1000,
      });
      products = normalizeProductsResponse(pgsResp);
    }

    // “Cars only” (practical): exclude add-ons by name.
    // (If you want the strict rental/trackable/show_in_store filter again, tell me what fields your /products returns.)
    const cars = (products || [])
      .filter((p) => !looksLikeAddon(p?.name || p?.title || p?.product_group_name || ""))
      .map((p) => ({
        id: p.id,
        name: p.name || p.title || p.product_group_name || "Unnamed",
      }))
      .filter((c) => c.id);

    const BUFFER_MINUTES = 15;

    // Cache the final computed response for 60 seconds (biggest rate-limit protection)
    const finalCacheKey = `final:${todayISO}`;
    const cachedFinal = memGet(finalCacheKey);
    if (cachedFinal) {
      res.status(200).json(cachedFinal);
      return;
    }

    for (const car of cars) {
      car.statuses = {};

      for (const day of days) {
        const path = `/products/${encodeURIComponent(car.id)}/availability?interval=minute&from=${encodeURIComponent(
          day.from
        )}&till=${encodeURIComponent(day.till)}`;

        let availJson;
        try {
          // Cache each car/day availability briefly (60s) to reduce refresh hammering
          availJson = await booqableFetch(path, {
            cacheKey: `avail:${car.id}:${day.date}`,
            cacheTtlMs: 60 * 1000,
          });
        } catch (e) {
          car.statuses[day.date] = { status: "Unknown", detail: String(e.message || e) };
          continue;
        }

        const ranges = extractBookedMinuteRanges(availJson);
        if (!ranges) {
          car.statuses[day.date] = {
            status: "Unknown",
            detail: "Could not parse availability format from Booqable for this product/day.",
          };
          continue;
        }

        const root = availJson?.data ?? availJson;
        const minutesArr =
          root?.minutes ||
          root?.availability ||
          (Array.isArray(root) ? root : root?.data);
        const totalMinutes = Array.isArray(minutesArr) ? minutesArr.length : 1440;

        const buffered = applyBufferToRanges(ranges, BUFFER_MINUTES, totalMinutes);
        const booked = buffered.length > 0;

        const isToday = day.date === todayISO;
        if (booked) {
          car.statuses[day.date] = {
            status: isToday ? "Heads-up" : "Booked",
            detail: bookedDetail(buffered),
          };
        } else {
          car.statuses[day.date] = { status: "Available", detail: "" };
        }

        // Heads-up: tomorrow too
        const tomorrowISO = addDaysISO(todayISO, 1);
        if (booked && day.date === tomorrowISO) {
          car.statuses[day.date].status = "Heads-up";
        }
      }
    }

    const payload = { days, cars };

    // Save computed payload in memory for 60 seconds
    memSet(finalCacheKey, payload, 60 * 1000);

    res.status(200).json(payload);
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(500).json({ error: e?.message || String(e) });
  }
}
