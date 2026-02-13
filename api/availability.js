// api/availability.js
// Bubblegum Cars staff availability (Booqable API v4)
// - Excludes add-ons (incl. "Additional Driver(s) - Add On")
// - Green/Red/Orange day status
// - Orange = started before this day and returns during this day (shows return time)
// - Also returns nextAvailable (next free time if currently booked)

function pad2(n) {
  return String(n).padStart(2, "0");
}

function ymd(date) {
  const y = date.getFullYear();
  const m = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  return `${y}-${m}-${d}`;
}

// Brisbane is UTC+10 (no DST)
function toISOBrisbane(dateObj, hour = 0, minute = 0, second = 0) {
  const y = dateObj.getFullYear();
  const m = pad2(dateObj.getMonth() + 1);
  const d = pad2(dateObj.getDate());
  const hh = pad2(hour);
  const mm = pad2(minute);
  const ss = pad2(second);
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}+10:00`;
}

function addDays(dateObj, days) {
  const d = new Date(dateObj);
  d.setDate(d.getDate() + days);
  return d;
}

function overlaps(aFrom, aTill, bFrom, bTill) {
  // [aFrom, aTill) overlaps [bFrom, bTill) if:
  return aFrom < bTill && aTill > bFrom;
}

function fmtTime(iso) {
  // iso contains +10:00 already, but we’ll still format in Brisbane
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Brisbane",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

function fmtDayTime(iso) {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Brisbane",
    weekday: "short",
    day: "2-digit",
    month: "short",
  }).format(d);
  return `${day} ${fmtTime(iso)}`;
}

function isAddonProduct(p) {
  const a = p?.attributes || {};
  const name = (a.name || "").toLowerCase().trim();
  const group = (a.group_name || "").toLowerCase().trim();
  const slug = (a.slug || "").toLowerCase().trim();

  // Strong exclusions
  const badTokens = [
    "add on",
    "add-on",
    "additional driver",
    "driver",
    "speaker",
    "polaroid",
    "camera",
    "charging cable",
    "cable",
    "accident excess",
    "excess",
  ];

  const hay = `${name} ${group} ${slug}`;
  if (badTokens.some(t => hay.includes(t))) return true;

  // Also exclude variations (your add-ons tend to be variation=true)
  if (a.variation === true || a.has_variations === true) return true;

  // Exclude bulk/non-trackable “stuff”
  if (a.tracking_type && a.tracking_type !== "trackable") return true;

  return false;
}

function isRealCar(p) {
  const a = p?.attributes || {};
  return (
    a.archived === false &&
    a.product_type === "rental" &&
    a.trackable === true &&
    a.show_in_store === true &&
    a.tracking_type === "trackable" &&
    a.variation === false &&
    !isAddonProduct(p)
  );
}

function sortCarsByYourOrder(cars) {
  const order = ["Blossom", "Bubbles", "Bean", "Breezy", "Betsy"];
  const idx = (name) => {
    const clean = (name || "").trim();
    const i = order.indexOf(clean);
    return i === -1 ? 999 : i;
  };
  return cars.sort((x, y) => idx(x.attributes.name) - idx(y.attributes.name));
}

async function booqableFetch(baseUrl, token, path) {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`Booqable error ${res.status} for ${path}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const COMPANY_SLUG = process.env.BOOQABLE_COMPANY_SLUG || "bubblegum-cars";
    const TOKEN = process.env.BOOQABLE_ACCESS_TOKEN;
    if (!TOKEN) {
      return res.status(500).json({ error: "Missing BOOQABLE_ACCESS_TOKEN env var" });
    }

    const baseUrl = `https://${COMPANY_SLUG}.booqable.com/api/4`;
    const rangeDays = Number(req.query.days || 4);

    // Build day windows (Brisbane midnight -> midnight)
    const now = new Date();
    const today = new Date(now);
    const days = Array.from({ length: rangeDays }, (_, i) => {
      const d = addDays(today, i);
      const from = toISOBrisbane(d, 0, 0, 0);
      const next = addDays(d, 1);
      const till = toISOBrisbane(next, 0, 0, 0);

      const label = new Intl.DateTimeFormat("en-AU", {
        timeZone: "Australia/Brisbane",
        weekday: "short",
        day: "2-digit",
        month: "short",
      }).format(new Date(from));

      return { date: ymd(d), label, from, till };
    });

    const rangeFrom = days[0].from;
    const rangeTill = days[days.length - 1].till;

    // 1) Products -> filter to real cars only
    const productsJson = await booqableFetch(baseUrl, TOKEN, `/products?per_page=200`);
    const products = (productsJson.data || []).map(p => ({ id: p.id, attributes: p.attributes || {} }));

    const cars = sortCarsByYourOrder(
      products.filter(p => isRealCar({ attributes: p.attributes }))
    );

    // 2) For each car, get all plannings overlapping the whole range (for speed)
    // Use reserved_from/reserved_till (includes buffer), and starts_at/stops_at for human pickup/return.
    const carsOut = [];

    for (const car of cars) {
      const planningPath =
        `/plannings` +
        `?per_page=200` +
        `&sort=reserved_from` +
        `&filter[item_id]=${encodeURIComponent(car.id)}` +
        `&filter[reserved]=true` +
        `&filter[planning_type]=order` +
        `&filter[reserved_from][lt]=${encodeURIComponent(rangeTill)}` +
        `&filter[reserved_till][gt]=${encodeURIComponent(rangeFrom)}`;

      const planningsJson = await booqableFetch(baseUrl, TOKEN, planningPath);
      const plannings = (planningsJson.data || []).map(p => ({
        reserved_from: p.attributes?.reserved_from || p.attributes?.starts_at,
        reserved_till: p.attributes?.reserved_till || p.attributes?.stops_at,
        starts_at: p.attributes?.starts_at,
        stops_at: p.attributes?.stops_at,
      })).filter(p => p.reserved_from && p.reserved_till);

      // Determine if booked RIGHT NOW + next available time
      const nowIso = toISOBrisbane(now, now.getHours(), now.getMinutes(), now.getSeconds());
      const nowT = new Date(nowIso).getTime();

      const activeNow = plannings
        .filter(p => new Date(p.reserved_from).getTime() <= nowT && new Date(p.reserved_till).getTime() > nowT)
        .sort((a, b) => new Date(a.reserved_till) - new Date(b.reserved_till));

      const nextAvailableIso = activeNow.length ? activeNow[0].reserved_till : null;

      // Per-day status logic
      const dayStatuses = days.map(day => {
        const dayFromT = new Date(day.from).getTime();
        const dayTillT = new Date(day.till).getTime();

        const overlapsDay = plannings.filter(p => {
          const aFrom = new Date(p.reserved_from).getTime();
          const aTill = new Date(p.reserved_till).getTime();
          return overlaps(aFrom, aTill, dayFromT, dayTillT);
        });

        if (overlapsDay.length === 0) {
          return { date: day.date, label: day.label, status: "Available" };
        }

        // Orange rule:
        // booking started BEFORE day start, but ends DURING this day
        const returnsToday = overlapsDay
          .filter(p => new Date(p.reserved_from).getTime() < dayFromT && new Date(p.reserved_till).getTime() <= dayTillT)
          .sort((a, b) => new Date(a.reserved_till) - new Date(b.reserved_till));

        if (returnsToday.length) {
          // Show the return time (use stops_at if present, else reserved_till)
          const p = returnsToday[0];
          const returnIso = p.stops_at || p.reserved_till;
          return {
            date: day.date,
            label: day.label,
            status: "Heads-up",
            returnTime: fmtTime(returnIso),
          };
        }

        // Otherwise: booked (red)
        return { date: day.date, label: day.label, status: "Booked" };
      });

      carsOut.push({
        id: car.id,
        name: (car.attributes.name || "").trim(),
        slug: car.attributes.slug,
        photo_url: car.attributes.photo_url,
        nextAvailable: nextAvailableIso ? fmtDayTime(nextAvailableIso) : null,
        days: dayStatuses,
      });
    }

    return res.status(200).json({
      company: COMPANY_SLUG,
      rangeDays,
      days,
      cars: carsOut,
    });

  } catch (e) {
    return res.status(500).json({
      error: e.message || "Unknown error",
      status: e.status,
      body: e.body,
    });
  }
}
