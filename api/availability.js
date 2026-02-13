// api/availability.js
// Bubblegum Cars staff availability (Booqable API v4)
//
// Display rules implemented:
// - Exclude add-ons (Additional Driver(s), Excess, Polaroid, Speaker, etc.)
// - Green = Available
// - Red = Booked (not returning within the day)
// - Orange = booked from before the day start and returns during the day
//   - Show "Back HH:MM" = customer return time (stops_at) if available
//   - Show "Free HH:MM" = truly re-rentable time (reserved_till, includes buffer)
// - Card header: "Next available Day HH:MM" uses reserved_till if currently booked; else "Available now"
// - Brisbane formatting: manual UTC+10 to avoid Vercel Intl/ICU differences

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
  const b = new Date(t + BRISBANE_OFFSET_MS); // Brisbane wall clock via UTC fields
  return `${pad2(b.getUTCHours())}:${pad2(b.getUTCMinutes())}`;
}

function fmtDayTime(iso) {
  const t = new Date(iso).getTime();
  const b = new Date(t + BRISBANE_OFFSET_MS);
  const weekdays = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const day = `${weekdays[b.getUTCDay()]}, ${pad2(b.getUTCDate())} ${months[b.getUTCMonth()]}`;
  return `${day} ${fmtTime(iso)}`;
}

function brisbaneDayBoundsAbs(dateObj) {
  const y = dateObj.getFullYear();
  const m = dateObj.getMonth();
  const d = dateObj.getDate();

  // Brisbane 00:00 maps to UTC midnight minus +10 hours
  const fromUTC = Date.UTC(y, m, d, 0, 0, 0) - BRISBANE_OFFSET_MS;
  const tillUTC = Date.UTC(y, m, d + 1, 0, 0, 0) - BRISBANE_OFFSET_MS;

  return { fromAbs: fromUTC, tillAbs: tillUTC };
}

function toISOWithPlus10(absMs) {
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

  const badTokens = [
    "add on", "add-on", "additional driver", "driver",
    "accident excess", "excess",
    "speaker", "polaroid", "camera",
    "charging cable", "cable",
  ];
  if (badTokens.some(t => hay.includes(t))) return true;

  if (a.variation === true || a.has_variations === true) return true;
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
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
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

    const nowAbs = Date.now();
    const todayBrisbane = new Date(nowAbs + BRISBANE_OFFSET_MS);

    const days = Array.from({ length: rangeDays }, (_, i) => {
      const d = addDays(todayBrisbane, i);
      const { fromAbs, tillAbs } = brisbaneDayBoundsAbs(d);

      const b = new Date(fromAbs + BRISBANE_OFFSET_MS);
      const weekdays = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
      const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      const label = `${weekdays[b.getUTCDay()]}, ${pad2(b.getUTCDate())} ${months[b.getUTCMonth()]}`;

      return {
        date: ymd(d),
        label,
        fromAbs,
        tillAbs,
        from: toISOWithPlus10(fromAbs),
        till: toISOWithPlus10(tillAbs),
      };
    });

    const rangeFrom = days[0].from;
    const rangeTill = days[days.length - 1].till;

    const productsJson = await booqableFetch(baseUrl, TOKEN, `/products?per_page=200`);
    const products = (productsJson.data || []).map(p => ({ id: p.id, attributes: p.attributes || {} }));
    const cars = sortCarsByYourOrder(products.filter(p => isRealCar(p)));

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

      const plannings = (planningsJson.data || []).map(p => {
        const a = p.attributes || {};
        return {
          reserved_from: a.reserved_from || a.starts_at,
          reserved_till: a.reserved_till || a.stops_at,
          starts_at: a.starts_at,
          stops_at: a.stops_at,
        };
      }).filter(p => p.reserved_from && p.reserved_till);

      // Active right now?
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

        // Orange condition: started before day start, ends within day
        const returnsToday = overlapsDay
          .filter(p => new Date(p.reserved_from).getTime() < day.fromAbs && new Date(p.reserved_till).getTime() <= day.tillAbs)
          .sort((a, b) => new Date(a.reserved_till) - new Date(b.reserved_till));

        if (returnsToday.length) {
          const p = returnsToday[0];

          // Back = human return (stops_at) if available; else fall back to reserved_till
          const backIso = p.stops_at || p.reserved_till;

          const out = {
            date: day.date,
            label: day.label,
            status: "Heads-up",
            backTime: fmtTime(backIso),
            freeTime: fmtTime(p.reserved_till),
          };

          // If both times match, don’t clutter
          if (out.backTime === out.freeTime) {
            delete out.freeTime;
          }

          return out;
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
      days: days.map(d => ({ date: d.date, label: d.label })),
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
