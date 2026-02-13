// api/availability.js (Vercel serverless)
// Uses Booqable API v4: https://{slug}.booqable.com/api/4

function ymd(date) {
  // YYYY-MM-DD
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function isLikelyAddon(p) {
  const name = (p?.attributes?.name || "").toLowerCase();
  const group = (p?.attributes?.group_name || "").toLowerCase();
  return (
    name.includes("add on") ||
    group.includes("add on") ||
    name.includes("excess") ||
    group.includes("excess") ||
    name.includes("driver") ||
    group.includes("driver")
  );
}

function isCarProduct(p) {
  const a = p?.attributes || {};
  return (
    a.product_type === "rental" &&
    a.trackable === true &&
    a.show_in_store === true &&
    a.tracking_type === "trackable" && // excludes bulk add-ons like speaker/polaroid
    a.variation === false &&            // excludes “Additional Driver(s)” variation add-on
    !isLikelyAddon(p)
  );
}

function sortCars(cars) {
  // Your preferred order (edit anytime)
  const order = ["Blossom", "Bubbles", "Bean", "Breezy", "Betsy"];
  const idx = (name) => {
    const i = order.indexOf(name);
    return i === -1 ? 999 : i;
  };
  return cars.sort((x, y) => idx(x.attributes.name) - idx(y.attributes.name));
}

// Try parsing availability intervals in a few common shapes.
// We only need: "is there ANY availability in that day?"
function extractIntervals(json) {
  // Common patterns:
  // 1) { data: [ { attributes: { starts_at, ends_at, available } } ... ] }
  // 2) { data: [ { from, till, available } ... ] }
  // 3) { availability: [ ... ] }
  const data = json?.data || json?.availability || json;
  if (!Array.isArray(data)) return [];

  return data
    .map((row) => {
      const a = row?.attributes || row;
      const from = a.starts_at || a.from || a.start || a.startsAt;
      const till = a.ends_at || a.till || a.end || a.endsAt;
      const available =
        a.available ??
        a.is_available ??
        a.isAvailable ??
        a.status === "available";

      return { from, till, available: Boolean(available) };
    })
    .filter((x) => x.from && x.till);
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
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const err = new Error(`Booqable error ${res.status} for ${path}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }

  return json;
}

module.exports = async (req, res) => {
  // CORS (so your index.html can call this endpoint)
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
    const today = new Date();

    // 1) Get products
    const productsJson = await booqableFetch(baseUrl, TOKEN, `/products?per_page=200`);
    const products = (productsJson.data || []).map((p) => ({
      id: p.id,
      attributes: p.attributes || {},
    }));

    // 2) Filter cars only
    const cars = sortCars(products.filter(isCarProduct));

    // 3) For each car, fetch day-by-day availability
    const days = Array.from({ length: rangeDays }, (_, i) => {
      const d = addDays(today, i);
      return {
        date: ymd(d),
        label: d.toLocaleDateString("en-AU", { weekday: "short", day: "2-digit", month: "short" }),
        from: ymd(d),
        till: ymd(d),
      };
    });

    const results = [];
    for (const car of cars) {
      const carDays = [];

      for (const day of days) {
        // This matches what Booqable hinted at: /availability?interval=minute&from=...&till=...
        // If Booqable expects a different date format, we’ll adjust — but start here.
        const path = `/products/${car.id}/availability?interval=minute&from=${encodeURIComponent(
          day.from
        )}&till=${encodeURIComponent(day.till)}`;

        const availJson = await booqableFetch(baseUrl, TOKEN, path);
        const intervals = extractIntervals(availJson);

        // Available if ANY interval is available=true
        const anyAvailable = intervals.some((x) => x.available === true);

        carDays.push({
          date: day.date,
          status: anyAvailable ? "Available" : "Booked",
        });
      }

      results.push({
        id: car.id,
        name: car.attributes.name,
        slug: car.attributes.slug,
        photo_url: car.attributes.photo_url,
        days: carDays,
      });
    }

    return res.status(200).json({
      company: COMPANY_SLUG,
      rangeDays,
      cars: results,
    });
  } catch (e) {
    return res.status(500).json({
      error: e.message || "Unknown error",
      status: e.status,
      body: e.body,
    });
  }
};
