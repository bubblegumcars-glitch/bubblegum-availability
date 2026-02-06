// api/availability.js
// Bubblegum Cars — Staff Availability (Vercel Serverless)
// Uses Booqable API v1 minute availability to derive OUT/BACK times.
// Rules: Brisbane timezone, Today + next 3 days, midnight-to-midnight days, 15-min buffer, cars only.

const TZ = "Australia/Brisbane";
const DAYS_TO_SHOW = 4; // Today + next 3 days
const BUFFER_MINUTES = 15;

function json(res, status, obj, headers = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  // Option A: anyone with link can view (public)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(obj));
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// Returns YYYY-MM-DD for Brisbane local date
function brisbaneYMD(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const y = parts.find(p => p.type === "year").value;
  const m = parts.find(p => p.type === "month").value;
  const d = parts.find(p => p.type === "day").value;
  return `${y}-${m}-${d}`;
}

// Returns DD-MM-YYYY for Brisbane local date
function brisbaneDMY(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-AU", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const y = parts.find(p => p.type === "year").value;
  const m = parts.find(p => p.type === "month").value;
  const d = parts.find(p => p.type === "day").value;
  return `${d}-${m}-${y}`;
}

// Adds N days to a YYYY-MM-DD string (Brisbane calendar days)
function addDaysYMD(ymd, n) {
  // Create a Date at UTC midnight and adjust by days; then re-format in Brisbane.
  // This is stable for Brisbane because there’s no DST.
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return brisbaneYMD(dt);
}

// Label like "Thu 05 Feb"
function labelForYMD(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: TZ,
    weekday: "short",
    day: "2-digit",
    month: "short"
  }).format(dt);
}

function minutesToHHMM(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

// Parse a date-time to Brisbane minutes-from-midnight + day YMD
function brisbaneDayAndMinute(isoOrDateString) {
  const dt = new Date(isoOrDateString);
  // Get Brisbane parts
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(dt);

  const y = parts.find(p => p.type === "year").value;
  const mo = parts.find(p => p.type === "month").value;
  const da = parts.find(p => p.type === "day").value;
  const hh = Number(parts.find(p => p.type === "hour").value);
  const mm = Number(parts.find(p => p.type === "minute").value);

  return { ymd: `${y}-${mo}-${da}`, minuteOfDay: hh * 60 + mm };
}

// --- fetch helpers with retry (429-safe) ---
async function fetchWithRetry(url, options = {}, tries = 4) {
  let attempt = 0;
  let lastErr;
  while (attempt < tries) {
    try {
      const res = await fetch(url, options);
      if (res.status === 429) {
        // exponential backoff: 400ms, 900ms, 1800ms...
        const wait = Math.round(400 * Math.pow(2, attempt) + Math.random() * 200);
        await new Promise(r => setTimeout(r, wait));
        attempt++;
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      const wait = Math.round(300 * Math.pow(2, attempt) + Math.random() * 200);
      await new Promise(r => setTimeout(r, wait));
      attempt++;
    }
  }
  throw lastErr || new Error("fetch failed");
}

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable: ${name}`);
  return v;
}

// --- in-memory caches (helps rate limits on Vercel warm instances) ---
const MEMORY = {
  products: { value: null, expiresAt: 0 }, // 10 min
  minutesByProduct: new Map() // key: `${productId}|${fromDMY}|${tillDMY}` -> {value, expiresAt}
};

function cacheGetProducts() {
  if (MEMORY.products.value && Date.now() < MEMORY.products.expiresAt) return MEMORY.products.value;
  return null;
}
function cacheSetProducts(value, ttlMs) {
  MEMORY.products.value = value;
  MEMORY.products.expiresAt = Date.now() + ttlMs;
}
function cacheGetMinutes(key) {
  const hit = MEMORY.minutesByProduct.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    MEMORY.minutesByProduct.delete(key);
    return null;
  }
  return hit.value;
}
function cacheSetMinutes(key, value, ttlMs) {
  MEMORY.minutesByProduct.set(key, { value, expiresAt: Date.now() + ttlMs });
}

// --- business filtering: cars only ---
function isCarProduct(p) {
  // Booqable v1 product objects vary by account settings, so we use a defensive filter.
  // We keep rental + trackable + show_in_store and exclude obvious add-ons by name.
  const name = (p.name || "").toLowerCase();
  const addOnHints = ["add on", "add-on", "addon", "excess", "charging cable", "additional driver", "accident"];
  const looksLikeAddOn = addOnHints.some(h => name.includes(h));

  const rental = p.rental === true;
  const trackable = p.trackable === true;
  const showInStore = p.show_in_store === true || p.show_in_storefront === true;

  return rental && trackable && showInStore && !looksLikeAddOn;
}

async function listCarProducts(base, apiKey) {
  const cached = cacheGetProducts();
  if (cached) return cached;

  // V1 docs show pagination via page/per; many accounts fit in one page but we’ll paginate safely.
  // Endpoint is usually /products (even though the docs nav is under Product Groups).
  const per = 200;
  let page = 1;
  let all = [];

  while (true) {
    const url = `${base}/products?page=${page}&per=${per}&api_key=${encodeURIComponent(apiKey)}`;
    const res = await fetchWithRetry(url, { method: "GET" });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Booqable error (${res.status}) on /products: ${text || res.statusText}`);
    }
    const data = await res.json();
    const products = data.products || [];
    all = all.concat(products);
    const meta = data.meta && data.meta.total_count ? data.meta.total_count : null;
    if (meta && all.length >= meta) break;
    if (products.length < per) break;
    page++;
    if (page > 20) break; // hard stop safety
  }

  const cars = all.filter(isCarProduct).map(p => ({
    id: p.id,
    name: (p.name || "").trim()
  }));

  // Cache for 10 minutes
  cacheSetProducts(cars, 10 * 60 * 1000);
  return cars;
}

// Fetch minute availability for a product for a whole range
async function fetchMinuteAvailability(base, apiKey, productId, fromDMY, tillDMY) {
  const key = `${productId}|${fromDMY}|${tillDMY}`;
  const cached = cacheGetMinutes(key);
  if (cached) return cached;

  const url =
    `${base}/products/${encodeURIComponent(productId)}/availability` +
    `?interval=minute&from=${encodeURIComponent(fromDMY)}&till=${encodeURIComponent(tillDMY)}` +
    `&api_key=${encodeURIComponent(apiKey)}`;

  const res = await fetchWithRetry(url, { method: "GET" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Booqable error (${res.status}) on /products/:id/availability: ${text || res.statusText}`);
  }
  const json = await res.json();

  // Cache minutes for 60 seconds (enough for refresh spam without hammering Booqable)
  cacheSetMinutes(key, json, 60 * 1000);
  return json;
}

// Convert minute availability payload into per-day busy segments (minutes)
// Busy is defined as available === 0.
function deriveDayWindows(minutePayload, daysSet) {
  // minutePayload is an object keyed by timestamps. Each value has fields like available/reserved/concept etc.  [oai_citation:1‡developers.booqable.com](https://developers.booqable.com/v1.html)
  // We only care about "available".
  const busyByDay = new Map(); // ymd -> [minuteOfDay busy...]
  for (const ymd of daysSet) busyByDay.set(ymd, []);

  for (const [k, v] of Object.entries(minutePayload || {})) {
    const available = (v && typeof v.available === "number") ? v.available : null;
    const dateField = v && v.date ? v.date : null;
    const source = dateField || k;
    if (available === null) continue;

    const { ymd, minuteOfDay } = brisbaneDayAndMinute(source);
    if (!busyByDay.has(ymd)) continue;

    if (available === 0) {
      busyByDay.get(ymd).push(minuteOfDay);
    }
  }

  // For each day, compute out/back windows based on min/max busy minute.
  // Apply 15-min buffer by extending the busy end time by +15 minutes (staff re-rent buffer).
  const outBackByDay = {};
  for (const [ymd, mins] of busyByDay.entries()) {
    if (!mins.length) {
      outBackByDay[ymd] = { status: "Available", times: "" };
      continue;
    }
    mins.sort((a, b) => a - b);
    const first = mins[0];
    const last = mins[mins.length - 1];

    // If busy covers essentially whole day, call it Booked.
    // "Whole day" = busy spans from 00:00 to 23:59.
    const spansWholeDay = first <= 0 && last >= 1439;

    if (spansWholeDay) {
      outBackByDay[ymd] = { status: "Booked", times: "Out all day" };
      continue;
    }

    const out = clamp(first, 0, 1439);
    const back = clamp(last + 1 + BUFFER_MINUTES, 0, 1440 + BUFFER_MINUTES); // last busy minute + next minute + buffer

    // Back can go past midnight; show "+1 day" if needed
    let backStr = minutesToHHMM(clamp(back, 0, 1439));
    let suffix = "";
    if (back >= 1440) {
      backStr = minutesToHHMM(back - 1440);
      suffix = " (+1 day)";
    }

    // Heads-up = partially unavailable within the day
    outBackByDay[ymd] = {
      status: "Heads-up",
      times: `Out ${minutesToHHMM(out)} → Back ${backStr}${suffix}`
    };
  }

  return outBackByDay;
}

module.exports = async (req, res) => {
  try {
    if (req.method === "OPTIONS") return json(res, 204, {});
    if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });

    const COMPANY_SLUG = env("BOOQABLE_COMPANY_SLUG"); // e.g. "bubblegum-cars"
    const API_KEY = env("BOOQABLE_API_KEY");
    const base = `https://${COMPANY_SLUG}.booqable.com/api/1`;

    // Days we want: Today + next 3 days (Brisbane)
    const todayYMD = brisbaneYMD(new Date());
    const days = [];
    for (let i = 0; i < DAYS_TO_SHOW; i++) {
      const ymd = addDaysYMD(todayYMD, i);
      days.push({
        date: ymd,
        label: labelForYMD(ymd),
        from: (() => {
          const [y, m, d] = ymd.split("-");
          return `${d}-${m}-${y}`;
        })(),
        till: (() => {
          const [y, m, d] = ymd.split("-");
          return `${d}-${m}-${y}`;
        })()
      });
    }

    const fromDMY = days[0].from;
    const tillDMY = days[days.length - 1].till;
    const daySet = new Set(days.map(d => d.date));

    const cars = await listCarProducts(base, API_KEY);

    // For each car: fetch minute availability once for the whole 4-day range
    const results = [];
    for (const car of cars) {
      let minutePayload;
      try {
        minutePayload = await fetchMinuteAvailability(base, API_KEY, car.id, fromDMY, tillDMY);
      } catch (e) {
        // If minute endpoint fails, still return something useful
        const statuses = {};
        for (const d of days) {
          statuses[d.date] = { status: "Unknown", detail: "Could not read minute-by-minute availability for this range." };
        }
        results.push({ id: car.id, name: car.name, statuses });
        continue;
      }

      const derived = deriveDayWindows(minutePayload, daySet);

      const statuses = {};
      for (const d of days) {
        const info = derived[d.date] || { status: "Unknown", times: "" };
        statuses[d.date] = {
          status: info.status,
          detail: info.times || ""
        };
      }

      results.push({ id: car.id, name: car.name, statuses });
    }

    return json(res, 200, {
      timezone: TZ,
      rangeDays: DAYS_TO_SHOW,
      bufferMinutes: BUFFER_MINUTES,
      note: "Times derived from minute availability. Back time includes 15-minute re-rent buffer.",
      days,
      cars: results
    });
  } catch (e) {
    return json(res, 500, { error: String(e.message || e) });
  }
};
