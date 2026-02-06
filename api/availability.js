export default async function handler(req, res) {
  try {
    const TZ = "Australia/Brisbane";
    const rangeDays = 4;
    const bufferMinutes = 15; // staff note only (storefront API doesn't expose minute times)

    const qFrom = req.query.from;
    const qTill = req.query.till;

    function brisbaneTodayISO() {
      const now = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
      return now.toISOString().slice(0, 10);
    }

    function isoToDDMMYYYY(iso) {
      const [y, m, d] = iso.split("-");
      return `${d}-${m}-${y}`;
    }

    function addDaysISO(iso, add) {
      const [y, m, d] = iso.split("-").map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d));
      dt.setUTCDate(dt.getUTCDate() + add);
      return dt.toISOString().slice(0, 10);
    }

    // Build days array for the UI (always returned)
    const baseISO = brisbaneTodayISO();
    const days = [];
    for (let i = 0; i < rangeDays; i++) {
      const iso = addDaysISO(baseISO, i);
      const label = new Date(iso + "T00:00:00Z").toLocaleDateString("en-AU", {
        timeZone: TZ,
        weekday: "short",
        day: "2-digit",
        month: "short",
      });
      days.push({
        date: iso,
        label,
        from: isoToDDMMYYYY(iso),
        till: isoToDDMMYYYY(iso),
      });
    }

    // If caller passes from/till, use them. Otherwise default to "today".
    const queryFrom = qFrom || days[0].from;
    const queryTill = qTill || days[0].till;

    // ✅ HARD-CODED CAR LIST (name + booqable shop item_id)
    // Keep this updated when you add/remove cars.
    const CARS = [
      { name: "Bean", item_id: "479afc49-6399-4395-add3-ccc9b9902f76" },
      { name: "Betsy", item_id: "7cea0ef0-8d27-4208-b997-c8b32e3d1fb3" },
      { name: "Blossom", item_id: "c0a8d4a4-3d26-4c5a-8058-1cc6d4c50747" },
      { name: "Breezy", item_id: "c277cbec-8f37-4e36-80aa-af041a4eba4f" },
      { name: "Bubbles", item_id: "c940bdcc-7e6a-47cc-8642-5b66d3f4174a" },
    ];

    // Storefront availability endpoint (same as the customer booking site)
    const boomerangUrl =
      "https://bubblegum-cars.booqableshop.com/api/boomerang/availabilities";

    const boomerangResp = await fetch(boomerangUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: queryFrom, till: queryTill }),
    });

    const boomerangJson = await boomerangResp.json();

    // Map item_id -> { available, plannable }
    const map = new Map();
    const dataArr = Array.isArray(boomerangJson.data) ? boomerangJson.data : [];

    for (const row of dataArr) {
      const attrs = row && row.attributes ? row.attributes : null;
      if (!attrs || !attrs.item_id) continue;

      map.set(attrs.item_id, {
        available: Number(attrs.available ?? 0),
        plannable: Number(attrs.plannable ?? 0),
      });
    }

    // ✅ IMPORTANT FIX:
    // If an item_id is missing from the boomerang response, treat it as BOOKED (not Unknown).
    // The boomerang API often omits fully-unavailable items for the selected date range.
    const cars = CARS.map((c) => {
      const av = map.get(c.item_id);

      if (!av) {
        return {
          name: c.name,
          item_id: c.item_id,
          status: "Booked",
          available: 0,
          plannable: 0,
          detail: "Not returned by storefront availability for this date range.",
        };
      }

      const status = av.available > 0 ? "Available" : "Booked";
      return {
        name: c.name,
        item_id: c.item_id,
        status,
        available: av.available,
        plannable: av.plannable,
        detail: "",
      };
    });

    return res.status(200).json({
      timezone: TZ,
      rangeDays,
      bufferMinutes,
      note:
        "Uses Booqable storefront availability (same as customer site). Missing items are treated as Booked for the date range.",
      days,
      cars,
      debug: {
        requested: { from: queryFrom, till: queryTill },
        boomerangCount: dataArr.length,
        boomerangItemIds: dataArr
          .map((r) => r?.attributes?.item_id)
          .filter(Boolean),
      },
    });
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      detail: String(err && err.message ? err.message : err),
    });
  }
}
