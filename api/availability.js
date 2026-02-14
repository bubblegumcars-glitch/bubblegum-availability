// api/availability.js
// Bubblegum Cars staff availability (Booqable API v4)
//
// ENV (Vercel):
// - BOOQABLE_ACCESS_TOKEN
// - BOOQABLE_COMPANY_SLUG=bubblegum-cars
// - TIMEZONE_OFFSET_HOURS=10   <-- Brisbane (AEST)
// Optional:
// - EARLY_RETURN_CUTOFF_HOUR=6
// - MIN_RENTABLE_GAP_HOURS=4

function pad2(n) { return String(n).padStart(2, "0"); }
function addDays(dateObj, days) { const d = new Date(dateObj); d.setDate(d.getDate() + days); return d; }
function ymd(date) { return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`; }
function overlaps(aFrom, aTill, bFrom, bTill) { return aFrom < bTill && aTill > bFrom; }

const TZ_OFFSET_HOURS = Number(process.env.TIMEZONE_OFFSET_HOURS ?? 10); // Brisbane
const TZ_OFFSET_MS = TZ_OFFSET_HOURS * 60 * 60 * 1000;

const EARLY_CUTOFF_HOUR = Number(process.env.EARLY_RETURN_CUTOFF_HOUR ?? 6);
const MIN_GAP_HOURS = Number(process.env.MIN_RENTABLE_GAP_HOURS ?? 4);
const MIN_GAP_MS = MIN_GAP_HOURS * 60 * 60 * 1000;

// ✅ Robust: detect explicit timezone in ISO string
function hasExplicitTimezone(s) {
  // Handles:
  //  - 2026-02-14T09:00:00Z
  //  - 2026-02-14T09:00:00+10:00
  //  - 2026-02-14T09:00:00+1000
  //  - ...with optional milliseconds
  return /([zZ]|[+\-]\d{2}:\d{2}|[+\-]\d{4})$/.test(s);
}

// ✅ Robust: parse naive "local" timestamps ourselves as Brisbane local time
// Accepts:
//  - YYYY-MM-DDTHH:MM
//  - YYYY-MM-DDTHH:MM:SS
//  - YYYY-MM-DD HH:MM
//  - YYYY-MM-DD HH:MM:SS
function parseNaiveLocalAsAbs(isoLike) {
  const s = String(isoLike).trim().replace(" ", "T");
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/);
  if (!m) return null;

  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const hh = Number(m[4]);
  const mm = Number(m[5]);
  const ss = m[6] ? Number(m[6]) : 0;

  // This is Brisbane local time => convert to absolute UTC:
  // UTC = local - offset
  return Date.UTC(y, mo, d, hh, mm, ss) - TZ_OFFSET_MS;
}

// ✅ Main parser:
// - If explicit TZ present => Date.parse ok
// - If no TZ => parse as Brisbane local time via parseNaiveLocalAsAbs
function parseBooqableToAbs(isoLike) {
  if (!isoLike) return null;
  const s = String(isoLike).trim();

  if (hasExplicitTimezone(s)) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }

  // Naive local timestamp: treat as Brisbane local
  return parseNaiveLocalAsAbs(s);
}

// Convert absolute ms => Brisbane clock time HH:MM
function fmtTimeFromAbs(absMs) {
  const b = new Date(absMs + TZ_OFFSET_MS);
  return `${pad2(b.getUTCHours())}:${pad2(b.getUTCMinutes())}`;
}

function fmtTime(isoLike) {
  const t = parseBooqableToAbs(isoLike);
  if (t === null) return "";
  return fmtTimeFromAbs(t);
}

function hourInTz(isoLike) {
  const t = parseBooqableToAbs(isoLike);
  if (t === null) return 0;
  const b = new Date(t + TZ_OFFSET_MS);
  return b.getUTCHours();
}

function fmtDayLabelFromAbs(fromAbs) {
  const b = new Date(fromAbs + TZ_OFFSET_MS);
  const weekdays = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${weekdays[b.getUTCDay()]}, ${pad2(b.getUTCDate())} ${months[b.getUTCMonth()]}`;
}

function fmtDayTimeFromAbs(absMs) {
  const b = new Date(absMs + TZ_OFFSET_MS);
  const weekdays = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const day = `${weekdays[b.getUTCDay()]}, ${pad2(b.getUTCDate())} ${months[b.getUTCMonth()]}`;
  return `${day} ${pad2(b.getUTCHours())}:${pad2(b.getUTCMinutes())}`;
}

// Brisbane-midnight day windows in absolute time
function dayBoundsAbs(dateObjInDisplayTz) {
  const y = dateObjInDisplayTz.getFullYear();
  const m = dateObjInDisplayTz.getMonth();
  const d = dateObjInDisplayTz.getDate();
  const fromUTC = Date.UTC(y, m, d, 0, 0, 0) - TZ_OFFSET_MS;
  const tillUTC = Date.UTC(y, m, d + 1, 0, 0, 0) - TZ_OFFSET_MS;
  return { fromAbs: fromUTC, tillAbs: tillUTC };
}

function tzSuffix() {
  const sign = TZ_OFFSET_HOURS >= 0 ? "+" : "-";
  const off = Math.abs(TZ_OFFSET_HOURS);
  const hh = pad2(Math.floor(off));
  const mm = pad2(Math.round((off - Math.floor(off)) * 60));
  return `${sign}${hh}:${mm}`;
}

function toISOWithOffset(absMs) {
  const b = new Date(absMs + TZ_OFFSET_MS);
  const y = b.getUTCFullYear();
  const mo = pad2(b.getUTCMonth() + 1);
  const da = pad2(b.getUTCDate());
  const hh = pad2(b.getUTCHours());
  const mi = pad2(b.getUTCMinutes());
  const ss = pad2(b.getUTCSeconds());
  return `${y}-${mo}-${da}T${hh}:${mi}:${ss}${tzSuffix()}`;
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

function isBookedNow(plannings, nowAbs) {
  return plannings.some(p => {
    const s = parseBooqableToAbs(p.reserved_from);
    const e = parseBooqableToAbs(p.reserved_till);
    if (s === null || e === null) return false;
    return s <= nowAbs && nowAbs < e;
  });
}

function findNextBookingStartAbs(plannings, fromAbs) {
  let next = null;
  for (const p of plannings) {
    const s = parseBooqableToAbs(p.reserved_from);
    const e = parseBooqableToAbs(p.reserved_till);
    if (s === null || e === null) continue;
    if (e <= fromAbs) continue;
    if (s >= fromAbs && (next === null || s < next)) next = s;
  }
  return next;
}

// Find first rentable time >= fromAbs where the gap before the next booking is >= MIN_GAP_MS.
function computeRentableStartAbs(plannings, fromAbs) {
  const intervals = plannings
    .map(p => ({
      start: parseBooqableToAbs(p.reserved_from),
      end: parseBooqableToAbs(p.reserved_till),
    }))
    .filter(x => x.start !== null && x.end !== null && x.end > fromAbs)
    .sort((a, b) => a.start - b.start);

  if (!intervals.length) return fromAbs;

  const busy = [];
  for (const i of intervals) {
    if (!busy.length) busy.push({ start: i.start, end: i.end });
    else {
      const last = busy[busy.length - 1];
      if (i.start <= last.end) last.end = Math.max(last.end, i.end);
      else busy.push({ start: i.start, end: i.end });
    }
  }

  let candidate = fromAbs;

  for (const b of busy) {
    if (candidate >= b.start && candidate < b.end) {
      candidate = b.end;
      break;
    }
    if (candidate < b.start) break;
  }

  for (const b of busy) {
    if (candidate < b.start) {
      const gap = b.start - candidate;
      if (gap >= MIN_GAP_MS) return candidate;
      candidate = b.end;
    } else if (candidate >= b.start && candidate < b.end) {
      candidate = b.end;
    }
  }

  return candidate;
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

      const bookedNow = isBookedNow(plannings, nowAbs);
      const nextStartAbs = findNextBookingStartAbs(plannings, nowAbs);

      let nextAvailable;
      if (bookedNow) {
        const rentableAbs = computeRentableStartAbs(plannings, nowAbs);
        nextAvailable = fmtDayTimeFromAbs(rentableAbs);
      } else {
        const gapToNextStart = nextStartAbs === null ? Infinity : (nextStartAbs - nowAbs);
        if (gapToNextStart >= MIN_GAP_MS) {
          nextAvailable = "Available now";
        } else {
          const rentableAbs = computeRentableStartAbs(plannings, nowAbs);
          nextAvailable = fmtDayTimeFromAbs(rentableAbs);
        }
      }

      const dayStatuses = days.map(day => {
        const dayOverlaps = plannings.filter(p => {
          const aFrom = parseBooqableToAbs(p.reserved_from);
          const aTill = parseBooqableToAbs(p.reserved_till);
          if (aFrom === null || aTill === null) return false;
          return overlaps(aFrom, aTill, day.fromAbs, day.tillAbs);
        });

        if (!dayOverlaps.length) {
          return { date: day.date, label: day.label, status: "Available" };
        }

        // booking starts today
        const startsToday = dayOverlaps
          .filter(p => {
            const aFrom = parseBooqableToAbs(p.reserved_from);
            return aFrom !== null && aFrom >= day.fromAbs && aFrom < day.tillAbs;
          })
          .sort((a, b) => parseBooqableToAbs(a.reserved_from) - parseBooqableToAbs(b.reserved_from));

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

        // carry-over booking returning today
        const carryReturn = dayOverlaps
          .filter(p => {
            const aFrom = parseBooqableToAbs(p.reserved_from);
            const aTill = parseBooqableToAbs(p.reserved_till);
            return aFrom !== null && aTill !== null && aFrom < day.fromAbs && aTill <= day.tillAbs;
          })
          .sort((a, b) => parseBooqableToAbs(a.reserved_till) - parseBooqableToAbs(b.reserved_till));

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
