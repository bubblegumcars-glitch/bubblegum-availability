// /api/availability.js

const BOOQABLE_API = "https://api.booqable.com/v1";
const COMPANY_SLUG = "bubblegum-cars";
const TZ = "Australia/Brisbane";
const RE_RENT_BUFFER_MINUTES = 15;

// Convert Date → YYYY-MM-DD (Brisbane)
function toBrisbaneDateString(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

// Start of day (midnight Brisbane)
function startOfBrisbaneDay(date) {
  const d = new Date(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date)
  );
  return d;
}

// Add minutes to date
function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

export default async function handler(req, res) {
  try {
    const days = Number(req.query.days || 4);
    const token = process.env.BOOQABLE_API_KEY;

    if (!token) {
      return res.status(500).json({ error: "Missing BOOQABLE_API_KEY" });
    }

    // Window calculation
    const now = new Date();
    const windowStart = startOfBrisbaneDay(now);
    const windowEnd = addMinutes(
      startOfBrisbaneDay(addMinutes(now, days * 1440)),
      0
    );

    const from = toBrisbaneDateString(windowStart).split("-").reverse().join("-");
    const till = toBrisbaneDateString(windowEnd).split("-").reverse().join("-");

    // 1️⃣ Fetch all products
    const productsRes = await fetch(
      `${BOOQABLE_API}/products?per_page=100`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Booqable-Company": COMPANY_SLUG,
        },
      }
    );

    const productsData = await productsRes.json();

    // 2️⃣ Filter to ONLY cars
    const cars = productsData.products.filter((p) => {
      if (p.archived) return false;
      if (p.product_type !== "rental") return false;
      if (!p.trackable) return false;
      if (!p.show_in_store) return false;

      const name = (p.name || "").toLowerCase();

      // Explicit exclusions
      if (name.includes("excess")) return false;
      if (name.includes("add on")) return false;
      if (name.includes("speaker")) return false;
      if (name.includes("camera")) return false;
      if (name.includes("cable")) return false;

      return true;
    });

    // 3️⃣ Fetch availability per car
    const results = [];

    for (const car of cars) {
      const availabilityRes = await fetch(
        `${BOOQABLE_API}/products/${car.id}/availability?interval=minute&from=${from}&till=${till}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Booqable-Company": COMPANY_SLUG,
          },
        }
      );

      const availabilityData = await availabilityRes.json();
      const unavailable = [];

      let currentBlock = null;

      for (const slot of availabilityData.availability || []) {
        const slotTime = new Date(slot.from);
        const isAvailable = slot.available_quantity > 0;

        if (!isAvailable) {
          if (!currentBlock) {
            currentBlock = {
              from: slotTime,
              till: slotTime,
            };
          } else {
            currentBlock.till = slotTime;
          }
        } else if (currentBlock) {
          // Apply re-rent buffer
          currentBlock.till = addMinutes(
            currentBlock.till,
            RE_RENT_BUFFER_MINUTES
          );

          unavailable.push({
            from: currentBlock.from,
            till: currentBlock.till,
          });

          currentBlock = null;
        }
      }

      if (currentBlock) {
        currentBlock.till = addMinutes(
          currentBlock.till,
          RE_RENT_BUFFER_MINUTES
        );
        unavailable.push({
          from: currentBlock.from,
          till: currentBlock.till,
        });
      }

      results.push({
        id: car.id,
        name: car.name.trim(),
        unavailable,
      });
    }

    res.status(200).json({
      now,
      tz: TZ,
      window: {
        start: windowStart,
        end: windowEnd,
        days,
      },
      cars: results,
      debug: {
        total_products: productsData.products.length,
        cars_found: results.length,
        from_ddmmyyyy: from,
        till_ddmmyyyy: till,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error", details: String(err) });
  }
}
