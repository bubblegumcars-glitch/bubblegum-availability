// api/availability.js (Vercel serverless)
// Booqable API v4: https://{slug}.booqable.com/api/4
// Availability in v4 is via inventory_levels (not /products/:id/availability)

function ymd(date) {
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

// Brisbane is UTC+10 (no DST)
function brisbaneFromTill(dateObj) {
  const start = new Date(dateObj);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const toISOWithOffset = (d) => {
    // Build YYYY-MM-DDTHH:mm:ss+10:00
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}+10:00`;
  };

  return { from: toISOWithOffset(start), till: toISOWithOffset(end) };
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
    a.tracking_type === "trackable" &&
    a.variation === false &&
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

    // 1) Products
    const productsJson = await booqableFetch(baseUrl, TOKEN, `/products?per_page=200`);
    const products = (productsJson.data || []).map((p) => ({
      id: p.id,
      attributes: p.attributes || {},
    }));

    const cars = sortCars(products.filter(isCarProduct));

    // 2) Build day windows (Brisbane midnight->midnight)
    const days = Array.from({ length: rangeDays }, (_, i) => {
      const d = addDays(today, i);
      const { from, till } = brisbaneFromTill(d);
      return {
        date: ymd(d),
        label: d.toLocaleDateString("en-AU", { weekday: "short", day: "2-digit", month: "short" }),
        from,
        till,
      };
    });

    // 3) Map each car -> item_id (trackable products have items)
    const productToItemId = {};
    for (const car of cars) {
      const itemsJson = await booqableFetch(
        baseUrl,
        TOKEN,
        `/items?filter[product_id]=${encodeURIComponent(car.id)}&per_page=10`
      );
      const firstItem = (itemsJson.data || [])[0];
      if (!firstItem?.id) {
        // If no item exists, treat as unknown/booked to avoid false “Available”
        productToItemId[car.id] = null;
      } else {
        productToItemId[car.id] = firstItem.id;
      }
    }

    // 4) Availability via inventory_levels
    const results = [];
    for (const car of cars) {
      const itemId = productToItemId[car.id];
      const carDays = [];

      for (const day of days) {
        if (!itemId) {
          carDays.push({ date: day.date, status: "Booked" });
          continue;
        }

        const path =
          `/inventory_levels` +
          `?filter[from]=${encodeURIComponent(day.from)}` +
          `&filter[till]=${encodeURIComponent(day.till)}` +
          `&filter[item_id]=${encodeURIComponent(itemId)}`;

        const invJson = await booqableFetch(baseUrl, TOKEN, path);
        const inv = (invJson.data || [])[0]?.attributes || {};

        // Use cluster_available as the “can it be booked at all” signal
        const availableQty =
          typeof inv.cluster_available === "number"
            ? inv.cluster_available
            : typeof inv.location_available === "number"
            ? inv.location_available
            : 0;

        carDays.push({
          date: day.date,
          status: availableQty > 0 ? "Available" : "Booked",
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
      note:
        "Availability derived from inventory_levels (API v4). Brisbane day windows. Buffer times are handled by Booqable product buffer settings.",
    });
  } catch (e) {
    return res.status(500).json({
      error: e.message || "Unknown error",
      status: e.status,
      body: e.body,
    });
  }
};
