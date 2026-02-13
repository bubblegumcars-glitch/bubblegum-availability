// api/availability.js
// Bubblegum Cars staff availability (Booqable API v4)
//
// Requirements implemented:
// - Exclude add-ons (Additional Driver(s), Excess, Polaroid, Speaker, etc.)
// - Green = Available (no reservation overlaps that day)
// - Red = Booked (reserved during day and NOT returning from previous day within that day)
// - Orange = booked from previous day, returning today; show "Back HH:MM"
// - Card header: show "Next available Day HH:MM" if currently booked, else "Available now"
// - Brisbane time formatting is done manually (UTC +10) to avoid Vercel/ICU drift.

function pad2(n) {
  return String(n).padStart(2, "0");
}

function ymd(date) {
  const y = date.getFullYear();
  const m = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  return `${y}-${m}-${d}`;
}

function addDays(dateObj, days) {
  const d = new Date(dateObj);
  d.setDate(d.getDate() + days);
  return d;
}

// Brisbane is UTC+10 (no DST)
const BRISBANE_OFFSET_MS = 10 * 60 * 60 * 1000;

function fmtTime(iso) {
  const t = new Date(iso).getTime();          // absolute time
  const b = new Date(t + BRISBANE_OFFSET_MS); // Brisbane wall clock in UTC fields
  const hh = pad2(b.getUTCHours());
  const mm = pad2(b.getUTCMinutes());
  return `${hh}:${mm}`;
}

function fmtDayTime(iso) {
  const t = new Date(iso).getTime();
  const b = new Date(t + BRISBANE_OFFSET_MS);

  const weekdays = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  const day = `${weekdays[b.getUTCDay()]}, ${pad2(b.getUTCDate())} ${months[b.getUTCMonth()]}`;
  return `${day} ${fmtTime(iso)}`;
}

// Brisbane midnight boundary as absolute timestamps
function brisbaneDayBoundsAbs(dateObj) {
  // Build Brisbane midnight by taking the local date parts and mapping to UTC time minus offset
  // i.e. Brisbane 00:00 == UTC 14:00 previous day (because +10)
  const y = dateObj.getFullYear();
  const m = dateObj.getMonth();   // 0-based
  const d = dateObj.getDate();

  // Brisbane 00:00 -> UTC time = Date.UTC(y,m,d,0,0,0) - offset
  const fromUTC = Date.UTC(y, m, d, 0, 0, 0) - BRISBANE_OFFSET_MS;
  const tillUTC = Date.UTC(y, m, d + 1, 0, 0, 0) - BRISBANE_OFFSET_MS;

  return { fromAbs: fromUTC, tillAbs: tillUTC };
}

// These ISO strings are only used for API filters
function toISOWithPlus10(absMs) {
  // absMs is UTC ms. Convert to Brisbane wall clock for string, then append +10:00.
  const b = new Date(absMs + BRISBANE_OFFSET_MS);
  const y = b.getUTCFullYear();
  const mo = pad2(b.getUTCMonth() + 1);
  const da = pad2(b.getUTCDate());
  const hh = pad2(b.getUTCHours());
  const mi = pad2(b.getUTCMinutes());
  const ss = pad2(b.getUTCSeconds());
  return `${y}-${mo}-${da}T${hh}:${mi}:${ss}+10:00`;
}

function overlaps(aFrom, aTill, bFrom, bTill) {
  return aFrom < bTill && aTill > bFrom;
}

function isAddonProduct(p) {
  const a = p?.attributes || {};
  const name = (a.name || "").toLowerCase().trim();
  const group = (a.group_name || "").toLowerCase().trim();
  const slug = (a.slug || "").toLowerCase().trim();

  const hay = `${name} ${group} ${slug}`;

  // Strong exclusions
  const badTokens = [
    "add on",
    "add-on",
    "additional driver",
    "driver",
    "accident excess",
    "excess",
    "speaker",
    "polaroid",
    "camera",
    "charging cable",
    "cable",
  ];

  if (badTokens.some(t => hay.includes(t))) return true;

  // Exclude variations / multi items (these are typically add-ons)
  if (a.variation === true || a.has_variations === true) return true;

  // Exclude non-trackable inventory (bulk add-ons)
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
    if (!TOKEN) return res.status(500).json({ error: "Missing BOOQABLE_ACCESS_TOKEN env var" });

    const baseUrl = `https://${COMPANY_SLUG}.booqable.com/api/4`;
    const rangeDays = Number(req.query.days || 4);

    // Build Brisbane day windows
    const nowAbs = Date.now();
    const today = new Date(nowAbs + BRISBANE_OFFSET_MS); // Brisbane “today” for date parts
    const days = Array.from({ length: rangeDays }, (_, i) => {
      const d = addDays(today, i);
      const { fromAbs, tillAbs } = brisbaneDayBoundsAbs(d);
      return {
        date: ymd(d),
        label: fmtDayTime(toISOWithPlus10(fromAbs)).split(" ").slice(0, 3).join(" "), // "Fri, 13 Feb"
        from: toISOWithPlus10(fromAbs),
        till: toISOWithPlus10(tillAbs),
        fromAbs,
        tillAbs
      };
    });

    const rangeFrom = days[0].from;
    const rangeTill = days[days.length - 1].till;

    // Products -> cars only
    const productsJson = await booqableFetch(baseUrl, TOKEN, `/products?per_page=200`);
    const products = (productsJson.data || []).map(p => ({ id: p.id, attributes: p.attributes || {} }));
    const cars = sortCarsByYourOrder(products.filter(p => isRealCar(p)));

    const carsOut = [];

    for (const car of cars) {
      // Pull all reservations overlapping the overall range
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

      const plannings = (planningsJson.data || []).map(p => {
        const a = p.attributes || {};
        return {
          reserved_from: a.reserved_from || a.starts_at,
          reserved_till: a.reserved_till || a.stops_at,
          starts_at: a.starts_at,
          stops_at: a.stops_at,
        };
      }).filter(p => p.reserved_from && p.reserved_till);

      // Is it booked RIGHT NOW? (use reserved window, which includes buffer)
      const activeNow = plannings
        .filter(p => new Date(p.reserved_from).getTime() <= nowAbs && new Date(p.reserved_till).getTime() > nowAbs)
        .sort((a, b) => new Date(a.reserved_till) - new Date(b.reserved_till));

      const nextAvailable = activeNow.length ? fmtDayTime(activeNow[0].reserved_till) : null;

      const dayStatuses = days.map(day => {
        const overlapsDay = plannings.filter(p => {
          const aFrom = new Date(p.reserved_from).getTime();
          const aTill = new Date(p.reserved_till).getTime();
          return overlaps(aFrom, aTill, day.fromAbs, day.tillAbs);
        });

        if (overlapsDay.length === 0) {
          return { date: day.date, label: day.label, status: "Available" };
        }

        // Orange: started before day start, ends during this day
        const returnsToday = overlapsDay
          .filter(p => new Date(p.reserved_from).getTime() < day.fromAbs && new Date(p.reserved_till).getTime() <= day.tillAbs)
          .sort((a, b) => new Date(a.reserved_till) - new Date(b.reserved_till));

        if (returnsToday.length) {
          // "Back" should mean truly available (includes buffer)
          const returnIso = returnsToday[0].reserved_till;
          return {
            date: day.date,
            label: day.label,
            status: "Heads-up",
            returnTime: fmtTime(returnIso),
          };
        }

        return { date: day.date, label: day.label, status: "Booked" };
      });

      carsOut.push({
        id: car.id,
        name: (car.attributes.name || "").trim(),
        slug: car.attributes.slug,
        photo_url: car.attributes.photo_url,
        nextAvailable,
        days: dayStatuses,
      });
    }

    return res.status(200).json({
      company: COMPANY_SLUG,
      rangeDays,
      days: days.map(d => ({ date: d.date, label: d.label })), // front-end only needs date+label
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
