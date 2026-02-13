// api/availability.js
// Bubblegum Cars staff availability (Booqable API v4)
//
// ENV (Vercel):
// - BOOQABLE_ACCESS_TOKEN
// - BOOQABLE_COMPANY_SLUG=bubblegum-cars
// - TIMEZONE_OFFSET_HOURS=0
// Optional:
// - EARLY_RETURN_CUTOFF_HOUR=6
// - MIN_RENTABLE_GAP_HOURS=4

function pad2(n) { return String(n).padStart(2, "0"); }
function addDays(dateObj, days) { const d = new Date(dateObj); d.setDate(d.getDate() + days); return d; }
function ymd(date) { return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`; }
function overlaps(aFrom, aTill, bFrom, bTill) { return aFrom < bTill && aTill > bFrom; }

const TZ_OFFSET_HOURS = Number(process.env.TIMEZONE_OFFSET_HOURS ?? 0);
const TZ_OFFSET_MS = TZ_OFFSET_HOURS * 60 * 60 * 1000;
const EARLY_CUTOFF_HOUR = Number(process.env.EARLY_RETURN_CUTOFF_HOUR ?? 6);
const MIN_GAP_HOURS = Number(process.env.MIN_RENTABLE_GAP_HOURS ?? 4);
const MIN_GAP_MS = MIN_GAP_HOURS * 60 * 60 * 1000;

function fmtTime(iso) {
  const t = new Date(iso).getTime();
  const b = new Date(t + TZ_OFFSET_MS);
  return `${pad2(b.getUTCHours())}:${pad2(b.getUTCMinutes())}`;
}

function hourInTz(iso) {
  const t = new Date(iso).getTime();
  const b = new Date(t + TZ_OFFSET_MS);
  return b.getUTCHours();
}

function fmtDayLabelFromAbs(fromAbs) {
  const b = new Date(fromAbs + TZ_OFFSET_MS);
  const weekdays = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${weekdays[b.getUTCDay()]}, ${pad2(b.getUTCDate())} ${months[b.getUTCMonth()]}`;
}

function fmtDayTime(iso) {
  const t = new Date(iso).getTime();
  const b = new Date(t + TZ_OFFSET_MS);
  const weekdays = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const day = `${weekdays[b.getUTCDay()]}, ${pad2(b.getUTCDate())} ${months[b.getUTCMonth()]}`;
  return `${day} ${fmtTime(iso)}`;
}

function dayBoundsAbs(dateObjInDisplayTz) {
  const y = dateObjInDisplayTz.getFullYear();
  const m = dateObjInDisplayTz.getMonth();
  const d = dateObjInDisplayTz.getDate();
  const fromUTC = Date.UTC(y, m, d, 0, 0, 0) - TZ_OFFSET_MS;
  const tillUTC = Date.UTC(y, m, d + 1, 0, 0, 0) - TZ_OFFSET_MS;
  return { fromAbs: fromUTC, tillAbs: tillUTC };
}

function toISOWithOffset(absMs) {
  const b = new Date(absMs + TZ_OFFSET_MS);
  const y = b.getUTCFullYear();
  const mo = pad2(b.getUTCMonth() + 1);
  const da = pad2(b.getUTCDate());
  const hh = pad2(b.getUTCHours());
  const mi = pad2(b.getUTCMinutes());
  const ss = pad2(b.getUTCSeconds());
  const sign = TZ_OFFSET_HOURS >= 0 ? "+" : "-";
  const off = Math.abs(TZ_OFFSET_HOURS);
  const offHH = pad2(Math.floor(off));
  return `${y}-${mo}-${da}T${hh}:${mi}:${ss}${sign}${offHH}:00`;
}

function isAddonProduct(p) {
  const a = p?.attributes || {};
  const hay = `${(a.name||"")} ${(a.group_name||"")} ${(a.slug||"")}`.toLowerCase();
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
  const res = await fetch(`${baseUrl}${path}`, {
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

// Find the first "free time" that has at least MIN_GAP_HOURS until the next booking starts
function computeRealisticNextAvailable(plannings, nowAbs) {
  // Future bookings sorted by start
  const future = plannings
    .map(p => ({
      startAbs: new Date(p.reserved_from).getTime(),
      endAbs: new Date(p.reserved_till).getTime(),
      reserved_till: p.reserved_till,
    }))
    .filter(p => p.endAbs > nowAbs)
    .sort((a, b) => a.startAbs - b.startAbs);

  if (!future.length) return null;

  // Build a merged "busy intervals" list
  const busy = [];
  for (const b of future) {
    if (!busy.length) busy.push({ start: b.startAbs, end: b.endAbs });
    else {
      const last = busy[busy.length - 1];
      if (b.startAbs <= last.end) last.end = Math.max(last.end, b.endAbs);
      else busy.push({ start: b.startAbs, end: b.endAbs });
    }
  }

  // If currently free: candidate = now. Otherwise candidate = end of active interval.
  let candidate = nowAbs;
  for (const interval of busy) {
    if (candidate >= interval.start && candidate < interval.end) {
      candidate = interval.end;
      break;
    }
    if (candidate < interval.start) break;
  }

  // Walk gaps and find a gap >= MIN_GAP_MS
  // (gap is from candidate to next interval start, or infinity after last)
  for (let i = 0; i < busy.length; i++) {
    const interval = busy[i];

    // if candidate is before this busy interval, we have a gap
    if (candidate < interval.start) {
      const gap = interval.start - candidate;
      if (gap >= MIN_GAP_MS) {
        // return candidate as the realistic next available time
        // (display uses reserved_till style; but candidate is abs)
        const iso = new Date(candidate).toISOString();
        return iso;
      }
      // gap too small, skip to end of this busy interval
      candidate = interval.end;
      continue;
    }

    // if candidate is inside this interval, jump to its end
    if (candidate >= interval.start && candidate < interval.end) {
      candidate = interval.end;
    }
  }

  // After last booking: it will be available, and gap is infinite, so return candidate
  const iso = new Date(candidate).toISOString();
  return iso;
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
    const todayInTz = new Date(nowAbs + TZ_OFFSET_MS);

    const days = Array.from({ length: rangeDays }, (_, i) => {
      const d = addDays(todayInTz, i);
      const { fromAbs, tillAbs } = dayBoundsAbs(d);
      return {
        date: ymd(d),
        label: fmtDayLabelFromAbs(fromAbs),
        fromAbs,
        tillAbs,
        from: toISOWithOffset(fromAbs),
        till: toISOWithOffset(tillAbs),
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
          reserved_from: a.reserved_from || a.starts_at,
          reserved_till: a.reserved_till || a.stops_at,
          starts_at: a.starts_at || null,
          stops_at: a.stops_at || null,
        };
      }).filter(p => p.reserved_from && p.reserved_till);

      // Realistic next available
      const realisticIso = computeRealisticNextAvailable(plannings, nowAbs);
      const nextAvailable = realisticIso ? fmtDayTime(realisticIso) : null;

      const dayStatuses = days.map(day => {
        const dayOverlaps = plannings.filter(p => {
          const aFrom = new Date(p.reserved_from).getTime();
          const aTill = new Date(p.reserved_till).getTime();
          return overlaps(aFrom, aTill, day.fromAbs, day.tillAbs);
        });

        if (!dayOverlaps.length) {
          return { date: day.date, label: day.label, status: "Available" };
        }

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

          return {
            date: day.date,
            label: day.label,
            status: "Booked",
            bookedFrom: fmtTime(fromIso),
            bookedUntil: fmtTime(tillIso),
          };
        }

        const carryReturn = dayOverlaps
          .filter(p => {
            const aFrom = new Date(p.reserved_from).getTime();
            const aTill = new Date(p.reserved_till).getTime();
            return aFrom < day.fromAbs && aTill <= day.tillAbs;
          })
          .sort((a, b) => new Date(a.reserved_till) - new Date(b.reserved_till));

        if (carryReturn.length) {
          const p = carryReturn[0];

          if (hourInTz(p.reserved_till) < EARLY_CUTOFF_HOUR) {
            return { date: day.date, label: day.label, status: "Available" };
          }

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
      timezoneOffsetHours: TZ_OFFSET_HOURS,
      earlyReturnCutoffHour: EARLY_CUTOFF_HOUR,
      minRentableGapHours: MIN_GAP_HOURS,
      days: days.map(d => ({ date: d.date, label: d.label })),
      cars: carsOut,
    });

  } catch (e) {
    return res.status(500).json({ error: e.message, status: e.status, body: e.body });
  }
}
