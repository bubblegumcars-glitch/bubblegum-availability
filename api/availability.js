// api/availability.js
// Bubblegum Cars staff dashboard
// Fully timezone-safe using Booqable account settings

const RANGE_DAYS = 4;
const MIN_RENTABLE_GAP_HOURS = 4;

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function hasOffset(str) {
  return /([zZ]|[+\-]\d{2}:\d{2})$/.test(str);
}

function parseDate(str, accountOffsetMinutes) {
  if (!str) return null;

  if (hasOffset(str)) {
    return new Date(str);
  }

  // No offset → interpret as account local time
  const d = new Date(str + "Z");
  return new Date(d.getTime() - accountOffsetMinutes * 60 * 1000);
}

function overlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function formatTime(date, timezone) {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatLabel(date, timezone) {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: timezone,
    weekday: "short",
    day: "2-digit",
    month: "short",
  }).format(date);
}

export default async function handler(req, res) {
  try {
    const company = process.env.BOOQABLE_COMPANY_SLUG;
    const token = process.env.BOOQABLE_ACCESS_TOKEN;

    if (!company || !token) {
      return json(res, 500, { error: "Missing Booqable env vars" });
    }

    async function booqable(path) {
      const r = await fetch(
        `https://${company}.booqable.com/api/4${path}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`Booqable ${r.status}: ${t}`);
      }
      return r.json();
    }

    // 1️⃣ Get account timezone settings
    const settings = await booqable("/settings/current");
    const timezone =
      settings?.data?.attributes?.defaults?.timezone || "UTC";
    const offsetMinutes =
      settings?.data?.attributes?.defaults?.timezone_offset || 0;

    const now = new Date();
    const nowMs = now.getTime();

    // 2️⃣ Get products
    const productsRes = await booqable("/products?per_page=100");
    const products = productsRes.data.filter(p => {
      const a = p.attributes;
      return (
        a.product_type === "rental" &&
        a.trackable === true &&
        a.show_in_store === true &&
        a.has_variations === false &&
        a.variation === false
      );
    });

    const productsById = new Map();
    for (const p of products) {
      productsById.set(p.id, p);
    }

    // 3️⃣ Get plannings
    const planningsRes = await booqable("/plannings?per_page=200");
    const plannings = planningsRes.data;

    const intervals = new Map();

    for (const p of plannings) {
      const rel = p.relationships || {};
      const productId =
        rel.product?.data?.id ||
        rel.item?.data?.id ||
        p.attributes?.product_id ||
        null;

      if (!productId || !productsById.has(productId)) continue;

      const startRaw = p.attributes.starts_at;
      const endRaw = p.attributes.stops_at;

      const startDate = parseDate(startRaw, offsetMinutes);
      const endDate = parseDate(endRaw, offsetMinutes);

      if (!startDate || !endDate) continue;

      const product = productsById.get(productId);
      const bufferBefore =
        (product.attributes.buffer_time_before || 0) * 1000;
      const bufferAfter =
        (product.attributes.buffer_time_after || 0) * 1000;

      const startMs = startDate.getTime() - bufferBefore;
      const endMs = endDate.getTime() + bufferAfter;

      if (!intervals.has(productId)) intervals.set(productId, []);
      intervals.get(productId).push({
        startMs,
        endMs,
        rawStart: startDate,
        rawEnd: endDate,
      });
    }

    for (const arr of intervals.values()) {
      arr.sort((a, b) => a.startMs - b.startMs);
    }

    // 4️⃣ Build days
    const days = [];
    for (let i = 0; i < RANGE_DAYS; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() + i);
      days.push(d);
    }

    const carsOut = [];

    for (const p of products) {
      const pid = p.id;
      const ivals = intervals.get(pid) || [];

      // Available now
      const bookedNow = ivals.some(
        iv => nowMs >= iv.startMs && nowMs < iv.endMs
      );

      let nextAvailable = null;

      if (!bookedNow) {
        nextAvailable = "Available now";
      } else {
        for (const iv of ivals) {
          if (nowMs < iv.endMs) {
            const gapMs =
              ivals.find(x => x.startMs > iv.endMs)?.startMs -
              iv.endMs;

            if (!gapMs || gapMs >= MIN_RENTABLE_GAP_HOURS * 3600000) {
              nextAvailable = formatLabel(
                new Date(iv.endMs),
                timezone
              ) + " " +
                formatTime(new Date(iv.endMs), timezone);
              break;
            }
          }
        }
      }

      const dayTiles = days.map(d => {
        const dayStart = new Date(
          formatLabel(d, timezone)
        );
        const startMs = new Date(
          d.toLocaleString("en-US", { timeZone: timezone })
        ).setHours(0, 0, 0, 0);
        const endMs = startMs + 86400000;

        const overlapsToday = ivals.filter(iv =>
          overlap(iv.startMs, iv.endMs, startMs, endMs)
        );

        if (!overlapsToday.length) {
          return {
            date: formatLabel(d, timezone),
            status: "Available",
          };
        }

        const first = overlapsToday[0];

        return {
          date: formatLabel(d, timezone),
          status: "Booked",
          bookedFrom: formatTime(first.rawStart, timezone),
          bookedUntil: formatTime(first.rawEnd, timezone),
        };
      });

      carsOut.push({
        id: pid,
        name: p.attributes.name.trim(),
        photo_url: p.attributes.photo_url,
        nextAvailable,
        days: dayTiles,
      });
    }

    return json(res, 200, {
      company,
      timezone,
      cars: carsOut,
    });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}
