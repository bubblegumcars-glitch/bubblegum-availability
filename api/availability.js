export default async function handler(req, res) {
  try {
    const TZ = "Australia/Brisbane";
    const rangeDays = 4;

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

    // Build days array for UI
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

    const queryFrom = qFrom || days[0].from;
    const queryTill = qTill || days[0].till;

    // ✅ Car list (storefront item_ids)
    const CARS = [
      { name: "Bean", item_id: "479afc49-6399-4395-add3-ccc9b9902f76" },
      { name: "Betsy", item_id: "7cea0ef0-8d27-4208-b997-c8b32e3d1fb3" },
      { name: "Blossom", item_id: "c0a8d4a4-3d26-4c5a-8058-1cc6d4c50747" },
      { name: "Breezy", item_id: "c277cbec-8f37-4e36-80aa-af041a4eba4f" },
      { name: "Bubbles", item_id: "c940bdcc-7e6a-47cc-8642-5b66d3f4174a" },
    ];

    const itemIds = CARS.map((c) => c.item_id);

    const boomerangUrl =
      "https://bubblegum-cars.booqableshop.com/api/boomerang/availabilities";

    // We try a few request shapes because storefront APIs can differ by shop setup.
    const attempts = [
      {
        name: "A: {from,till}",
        body: { from: queryFrom, till: queryTill },
      },
      {
        name: "B: {from,till,item_ids}",
        body: { from: queryFrom, till: queryTill, item_ids: itemIds },
      },
      {
        name: "C: {from,till,items}",
        body: { from: queryFrom, till: queryTill, items: itemIds },
      },
    ];

    async function postBoomerang(bodyObj) {
      const resp = await fetch(boomerangUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // This header often matters for JSON:API style responses
          "Accept": "application/json, application/vnd.api+json",
        },
        body: JSON.stringify(bodyObj),
      });

      const text = await resp.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = { parse_error: true, raw_text: text.slice(0, 500) };
      }
      return { status: resp.status, json };
    }

    let boomerangBest = null;

    for (const a of attempts) {
      const r = await postBoomerang(a.body);

      const dataArr = Array.isArray(r.json?.data) ? r.json.data : [];
      // Consider it a “hit” if we get any data rows at all
      if (dataArr.length > 0) {
        boomerangBest = {
          attempt: a.name,
          requestBody: a.body,
          status: r.status,
          json: r.json,
        };
        break;
      }

      // Keep the last attempt for debugging
      boomerangBest = {
        attempt: a.name,
        requestBody: a.body,
        status: r.status,
        json: r.json,
      };
    }

    const dataArr = Array.isArray(boomerangBest?.json?.data)
      ? boomerangBest.json.data
      : [];

    // Build item_id -> availability map
    const map = new Map();
    for (const row of dataArr) {
      const attrs = row?.attributes;
      if (!attrs?.item_id) continue;
      map.set(attrs.item_id, {
        available: Number(attrs.available ?? 0),
        plannable: Number(attrs.plannable ?? 0),
      });
    }

    // ✅ Critical logic:
    // - If boomerang returned ZERO rows, we must NOT mark everything booked.
    //   Return Unknown so we can see it's a data-fetch issue, not real bookings.
    // - If boomerang returned SOME rows, missing item_id = Booked for that range.
    const boomerangReturnedAny = dataArr.length > 0;

    const cars = CARS.map((c) => {
      const av = map.get(c.item_id);

      if (!boomerangReturnedAny) {
        return {
          name: c.name,
          item_id: c.item_id,
          status: "Unknown",
          detail:
            "Storefront availability returned no rows (request shape/headers mismatch).",
        };
      }

      if (!av) {
        return {
          name: c.name,
          item_id: c.item_id,
          status: "Booked",
          detail: "Not available for this date range (not returned by API).",
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
      days,
      cars,
      debug: {
        requested: { from: queryFrom, till: queryTill },
        boomerang: {
          url: boomerangUrl,
          attemptUsed: boomerangBest?.attempt,
          status: boomerangBest?.status,
          rowsReturned: dataArr.length,
          // show the first few item_ids we got back (helps us align IDs fast)
          returnedItemIds: Array.from(map.keys()).slice(0, 20),
        },
      },
    });
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      detail: String(err?.message || err),
    });
  }
}
