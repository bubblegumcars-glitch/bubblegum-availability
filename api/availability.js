// api/availability.js
export default async function handler(req, res) {
  try {
    const COMPANY = process.env.BOOQABLE_COMPANY || "bubblegum-cars";
    const TOKEN = process.env.BOOQABLE_ACCESS_TOKEN;
    if (!TOKEN) return res.status(500).json({ error: "Missing BOOQABLE_ACCESS_TOKEN env var" });

    const rangeDays = Number(req.query.days || 4);
    const tz = "Australia/Brisbane";

    // Helpers
    const pad2 = (n) => String(n).padStart(2, "0");
    const toISOWithOffset = (date, hour = 0, minute = 0) => {
      // Brisbane is +10:00 (no DST). We’ll output ISO with +10:00.
      const yyyy = date.getFullYear();
      const mm = pad2(date.getMonth() + 1);
      const dd = pad2(date.getDate());
      const hh = pad2(hour);
      const mi = pad2(minute);
      return `${yyyy}-${mm}-${dd}T${hh}:${mi}:00+10:00`;
    };
    const fmtTime = (iso) => {
      const d = new Date(iso);
      return new Intl.DateTimeFormat("en-AU", {
        timeZone: tz,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(d);
    };

    const apiFetch = async (path) => {
      const url = `https://${COMPANY}.booqable.com/api/4${path}`;
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      });
      const text = await r.text();
      let body = null;
      try { body = JSON.parse(text); } catch { body = { raw: text }; }
      if (!r.ok) {
        return { ok: false, status: r.status, body, url };
      }
      return { ok: true, status: r.status, body, url };
    };

    // 1) List products and keep only real cars
    const productsResp = await apiFetch(`/products.json?fields[products]=id,name,slug,product_type,trackable,show_in_store,archived,photo_url,buffer_time_after,buffer_time_before&per_page=200`);
    if (!productsResp.ok) {
      return res.status(500).json({ error: `Booqable error ${productsResp.status} for /products`, details: productsResp.body });
    }

    const cars = (productsResp.body.data || [])
      .filter(p =>
        !p.archived &&
        p.product_type === "rental" &&
        p.trackable === true &&
        p.show_in_store === true &&
        // exclude add-ons by rule of thumb: real cars usually have a SKU like BUBBLES/BEAN etc, but keep it simple:
        true
      )
      .map(p => ({
        id: p.id,
        name: (p.name || "").trim(),
        slug: p.slug,
        photo_url: p.photo_url || null,
        buffer_time_after: p.buffer_time_after || 0,
        buffer_time_before: p.buffer_time_before || 0,
      }));

    // 2) Build Brisbane day windows
    const today = new Date();
    const days = [];
    for (let i = 0; i < rangeDays; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);

      const from = toISOWithOffset(d, 0, 0);
      const till = toISOWithOffset(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1), 0, 0);

      const label = new Intl.DateTimeFormat("en-AU", {
        timeZone: tz,
        weekday: "short",
        day: "2-digit",
        month: "short",
      }).format(new Date(from));

      const yyyy = d.getFullYear();
      const mm = pad2(d.getMonth() + 1);
      const dd = pad2(d.getDate());
      days.push({ date: `${yyyy}-${mm}-${dd}`, label, from, till });
    }

    // 3) For each car/day: determine availability + booking windows
    // We’ll use Plannings to get time windows (pickup/return and reserved windows).  [oai_citation:1‡developers.booqable.com](https://developers.booqable.com/)
    const getBookedWindowsForDay = async (productId, dayFromISO, dayTillISO) => {
      // Overlap logic:
      // reserved_from < dayTill AND reserved_till > dayFrom
      const q =
        `/plannings.json` +
        `?fields[plannings]=id,item_id,reserved,starts_at,stops_at,reserved_from,reserved_till,status,planning_type` +
        `&filter[item_id]=${encodeURIComponent(productId)}` +
        `&filter[reserved]=true` +
        `&filter[planning_type]=order` +
        `&filter[reserved_from][lt]=${encodeURIComponent(dayTillISO)}` +
        `&filter[reserved_till][gt]=${encodeURIComponent(dayFromISO)}` +
        `&sort=reserved_from` +
        `&per_page=100`;

      const r = await apiFetch(q);
      if (!r.ok) return { error: true, status: r.status, body: r.body };

      const plannings = r.body.data || [];

      // Convert each planning into a window clipped to the day boundaries
      const dayFrom = new Date(dayFromISO).getTime();
      const dayTill = new Date(dayTillISO).getTime();

      const windows = plannings.map(p => {
        const rf = p.reserved_from || p.starts_at;
        const rt = p.reserved_till || p.stops_at;
        const a = Math.max(new Date(rf).getTime(), dayFrom);
        const b = Math.min(new Date(rt).getTime(), dayTill);
        if (b <= a) return null;

        return {
          // show both concepts so you can choose later:
          reserved_from: new Date(a).toISOString(),
          reserved_till: new Date(b).toISOString(),
          starts_at: p.starts_at,
          stops_at: p.stops_at,
        };
      }).filter(Boolean);

      return { windows };
    };

    // 4) Build response
    const outCars = [];
    for (const car of cars) {
      const carDays = [];

      for (const day of days) {
        const { windows, error } = await getBookedWindowsForDay(car.id, day.from, day.till);

        // If ANY overlap windows exist, the car is at least partially booked that day.
        // You already compute day-level availability elsewhere; for now:
        // - status "Booked" if any overlap
        // - otherwise "Available"
        // (If you want partial-day “Available until 10:30”, we can add that next.)
        const status = windows && windows.length ? "Booked" : "Available";

        const bookedWindows = (windows || []).map(w => ({
          from: fmtTime(w.starts_at || w.reserved_from),   // pickup time preferred if present
          till: fmtTime(w.stops_at || w.reserved_till),    // return time preferred if present
        }));

        carDays.push({
          date: day.date,
          status,
          bookedWindows, // <-- NEW
        });
      }

      outCars.push({
        id: car.id,
        name: car.name,
        slug: car.slug,
        photo_url: car.photo_url,
        days: carDays,
      });
    }

    return res.status(200).json({
      company: COMPANY,
      rangeDays,
      timezone: tz,
      days,
      cars: outCars,
      note:
        "Booking times come from /plannings (starts_at/stops_at). Unavailability incl. buffer is reserved_from/reserved_till.",
    });
  } catch (e) {
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
}
