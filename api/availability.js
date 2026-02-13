// api/availability.js
// Bubblegum Cars staff availability (Booqable API v4)
//
// Rules:
// - Only real cars (exclude add-ons)
// - Green = Available
// - Red = Booked (and if booking starts today, show From/Until)
// - Orange = booked from the day before but returning today AND no other booking later today
//   - Back = customer return time (stops_at if present else reserved_till)
//   - Free = reserved_till (true re-rentable time incl buffer)
// - Next available uses reserved_till of the currently active reservation

function pad2(n) { return String(n).padStart(2, "0"); }
function addDays(dateObj, days) { const d = new Date(dateObj); d.setDate(d.getDate() + days); return d; }
function ymd(date) { return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`; }
function overlaps(aFrom, aTill, bFrom, bTill) { return aFrom < bTill && aTill > bFrom; }

const BRISBANE_OFFSET_MS = 10 * 60 * 60 * 1000;

function fmtTime(iso) {
  const t = new Date(iso).getTime();
  const b = new Date(t + BRISBANE_OFFSET_MS);
  return `${pad2(b.getUTCHours())}:${pad2(b.getUTCMinutes())}`;
}

function fmtDayLabelFromAbs(fromAbs) {
  const b = new Date(fromAbs + BRISBANE_OFFSET_MS);
  const weekdays = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${weekdays[b.getUTCDay()]}, ${pad2(b.getUTCDate())} ${months[b.getUTCMonth()]}`;
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
function brisbaneDayBoundsAbs(dateObjBrisbane) {
  const y = dateObjBrisbane.getFullYear();
  const m = dateObjBrisbane.getMonth();
  const d = dateObjBrisbane.getDate();
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

// ---- Product filtering (exclude add-ons) ----
function isAddonProduct(p) {
  const a = p?.attributes || {};
  const name = (a.name || "").toLowerCase().trim();
  const group = (a.group_name || "").toLowerCase().trim();
  const slug = (a.slug || "").toLowerCase().trim();
  const hay = `${name} ${group} ${slug}`;

  const badTokens = [
    "add on","add-on","additional driver","driver",
    "accident excess","excess",
    "speaker","polaroid","camera",
    "charging cable","cable",
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
    const debug = String(req.query.debug || "") === "1";

    const nowAbs = Date.now();
    const todayBrisbane = new Date(nowAbs + BRISBANE_OFFSET_MS);

    const days = Array.from({ length: rangeDays }, (_, i) => {
      const d = addDays(todayBrisbane, i);
      const { fromAbs, tillAbs } = brisbaneDayBoundsAbs(d);
      return {
        date: ymd(d),
        label: fmtDayLabelFromAbs(fromAbs),
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
        `/plannings?per_page=200&sort=reserved_from` +
        `&filter[item_id]=${encodeURIComponent(car.id)}` +
        `&filter[reserved]=true` +
        `&filter[planning_type]=order` +
        `&filter[reserved_from][lt]=${encodeURIComponent(rangeTill)}` +
        `&filter[reserved_till][gt]=${encodeURIComponent(rangeFrom)}`;

      const planningsJson = await booqableFetch(baseUrl, TOKEN, planningPath);

      const plannings = (planningsJson.data || []).map(p => {
        const a = p.attributes || {};
        return {
          planning_id: p.id,
          reserved_from: a.reserved_from || a.starts_at,
          reserved_till: a.reserved_till || a.stops_at,
          starts_at: a.starts_at || null,
          stops_at: a.stops_at || null,
        };
      }).filter(p => p.reserved_from && p.reserved_till);

      const activeNow = plannings
        .filter(p => new Date(p.reserved_from).getTime() <= nowAbs && new Date(p.reserved_till).getTime() > nowAbs)
        .sort((a, b) => new Date(a.reserved_till) - new Date(b.reserved_till));

      const nextAvailable = activeNow.length ? fmtDayTime(activeNow[0].reserved_till) : null;

      const dayStatuses = days.map(day => {
        const dayOverlaps = plannings.filter(p => {
          const aFrom = new Date(p.reserved_from).getTime();
          const aTill = new Date(p.reserved_till).getTime();
          return overlaps(aFrom, aTill, day.fromAbs, day.tillAbs);
        });

        if (dayOverlaps.length === 0) {
          return { date: day.date, label: day.label, status: "Available" };
        }

        // 1) If ANY booking starts during this day, treat day as BOOKED and show From/Until
        const startsToday = dayOverlaps
          .filter(p => {
            const aFrom = new Date(p.reserved_from).getTime();
            return aFrom >= day.fromAbs && aFrom < day.tillAbs;
          })
          .sort((a, b) => new Date(a.reserved_from) - new Date(b.reserved_from));

        if (startsToday.length) {
          const p = startsToday[0];
          const fromIso = p.starts_at || p.reserved_from;
          const tillIso = p.stops_at || p.reserved_till;

          const out = {
            date: day.date,
            label: day.label,
            status: "Booked",
            bookedFrom: fmtTime(fromIso),
            bookedUntil: fmtTime(tillIso),
          };

          if (debug) {
            out.debug = {
              planning_id: p.planning_id,
              starts_at: p.starts_at,
              stops_at: p.stops_at,
              reserved_from: p.reserved_from,
              reserved_till: p.reserved_till,
            };
          }

          return out;
        }

        // 2) Otherwise, we can show ORANGE only if it returns today and then stays free (no later overlaps)
        const carryReturn = dayOverlaps
          .filter(p => {
            const aFrom = new Date(p.reserved_from).getTime();
            const aTill = new Date(p.reserved_till).getTime();
            return aFrom < day.fromAbs && aTill <= day.tillAbs;
          })
          .sort((a, b) => new Date(a.reserved_till) - new Date(b.reserved_till));

        if (carryReturn.length) {
          const p = carryReturn[0];

          const backIso = p.stops_at || p.reserved_till;
          const freeIso = p.reserved_till;

          const out = {
            date: day.date,
            label: day.label,
            status: "Heads-up",
            backTime: fmtTime(backIso),
            freeTime: fmtTime(freeIso),
          };

          if (out.backTime === out.freeTime) delete out.freeTime;

          if (debug) {
            out.debug = {
              planning_id: p.planning_id,
              starts_at: p.starts_at,
              stops_at: p.stops_at,
              reserved_from: p.reserved_from,
              reserved_till: p.reserved_till,
            };
          }

          return out;
        }

        // 3) Otherwise booked all day / returns after day end
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
