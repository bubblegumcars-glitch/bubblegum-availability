// api/availability.js
// Bubblegum Cars staff availability – business-logic aligned

function pad2(n) {
  return String(n).padStart(2, "0");
}

const BRISBANE_OFFSET_MS = 10 * 60 * 60 * 1000;
const EARLY_MORNING_CUTOFF_HOUR = 6; // Anything before 06:00 counts as previous day return

function fmtTime(iso) {
  const t = new Date(iso).getTime();
  const b = new Date(t + BRISBANE_OFFSET_MS);
  return `${pad2(b.getUTCHours())}:${pad2(b.getUTCMinutes())}`;
}

function fmtDayTime(iso) {
  const t = new Date(iso).getTime();
  const b = new Date(t + BRISBANE_OFFSET_MS);

  const weekdays = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  const day = `${weekdays[b.getUTCDay()]}, ${pad2(b.getUTCDate())} ${months[b.getUTCMonth()]}`;
  return `${day} ${fmtTime(iso)}`;
}

function brisbaneDayBoundsAbs(dateObj) {
  const y = dateObj.getFullYear();
  const m = dateObj.getMonth();
  const d = dateObj.getDate();

  const fromUTC = Date.UTC(y, m, d, 0, 0, 0) - BRISBANE_OFFSET_MS;
  const tillUTC = Date.UTC(y, m, d + 1, 0, 0, 0) - BRISBANE_OFFSET_MS;

  return { fromAbs: fromUTC, tillAbs: tillUTC };
}

function isEarlyMorningReturn(iso, dayAbs) {
  const t = new Date(iso).getTime();
  const b = new Date(t + BRISBANE_OFFSET_MS);

  const hour = b.getUTCHours();
  return hour < EARLY_MORNING_CUTOFF_HOUR;
}

export default async function handler(req, res) {
  try {
    const TOKEN = process.env.BOOQABLE_ACCESS_TOKEN;
    const COMPANY = process.env.BOOQABLE_COMPANY_SLUG;

    const base = `https://${COMPANY}.booqable.com/api/4`;

    const nowAbs = Date.now();
    const todayBrisbane = new Date(nowAbs + BRISBANE_OFFSET_MS);

    const days = [];
    for (let i = 0; i < 4; i++) {
      const d = new Date(todayBrisbane);
      d.setDate(d.getDate() + i);
      const bounds = brisbaneDayBoundsAbs(d);
      days.push({ dateObj: d, ...bounds });
    }

    const productsRes = await fetch(`${base}/products?per_page=200`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    const products = (await productsRes.json()).data;

    const cars = products.filter(p =>
      p.attributes.product_type === "rental" &&
      p.attributes.trackable === true &&
      p.attributes.show_in_store === true &&
      p.attributes.variation === false &&
      p.attributes.tracking_type === "trackable"
    );

    const carsOut = [];

    for (const car of cars) {

      const planningRes = await fetch(
        `${base}/plannings?per_page=200&filter[item_id]=${car.id}&filter[reserved]=true`,
        { headers: { Authorization: `Bearer ${TOKEN}` } }
      );

      const plannings = (await planningRes.json()).data.map(p => p.attributes);

      const carDays = [];

      for (const day of days) {

        const overlaps = plannings.filter(p => {
          const from = new Date(p.reserved_from).getTime();
          const till = new Date(p.reserved_till).getTime();
          return from < day.tillAbs && till > day.fromAbs;
        });

        if (!overlaps.length) {
          carDays.push({ status: "Available" });
          continue;
        }

        const endingToday = overlaps.filter(p => {
          const till = new Date(p.reserved_till).getTime();
          return till <= day.tillAbs;
        });

        if (endingToday.length) {

          const earliest = endingToday.sort((a,b) =>
            new Date(a.reserved_till) - new Date(b.reserved_till)
          )[0];

          if (isEarlyMorningReturn(earliest.reserved_till, day.fromAbs)) {
            carDays.push({ status: "Available" });
            continue;
          }

          carDays.push({
            status: "Heads-up",
            backTime: fmtTime(earliest.stops_at || earliest.reserved_till)
          });

        } else {
          carDays.push({ status: "Booked" });
        }
      }

      const activeNow = plannings.filter(p =>
        new Date(p.reserved_from).getTime() <= nowAbs &&
        new Date(p.reserved_till).getTime() > nowAbs
      );

      const nextAvailable = activeNow.length
        ? fmtDayTime(activeNow[0].reserved_till)
        : null;

      carsOut.push({
        name: car.attributes.name,
        photo_url: car.attributes.photo_url,
        nextAvailable,
        days: carDays
      });
    }

    res.status(200).json({ cars: carsOut });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
