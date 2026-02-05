function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable: ${name}`);
  return v;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function brisbaneTodayISO() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Brisbane",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const y = parts.find(p => p.type === "year").value;
  const m = parts.find(p => p.type === "month").value;
  const d = parts.find(p => p.type === "day").value;
  return `${y}-${m}-${d}`;
}

function addDaysISO(isoDate, days) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = pad2(dt.getUTCMonth() + 1);
  const dd = pad2(dt.getUTCDate());
  return `${yy}-${mm}-${dd}`;
}

function toDMY(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return `${pad2(d)}-${pad2(m)}-${y}`;
}

function labelForISO(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const weekday = dt.toLocaleDateString("en-AU", { weekday: "short", timeZone: "Australia/Brisbane" });
  const day = dt.toLocaleDateString("en-AU", { day: "2-digit", month: "short", timeZone: "Australia/Brisbane" });
  return `${weekday} ${day}`;
}

function minutesToHHMM(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

function extractBookedMinuteRanges(availabilityJson) {
  const root = availabilityJson?.data ?? availabilityJson;

  let minutes = root?.minutes;
  if (!minutes && Array.isArray(root)) minutes = root;
  if (!minutes && Array.isArray(root?.data)) minutes = root.data;

  if (!Array.isArray(minutes) || minutes.length === 0) return null;

  const availFlags = minutes.map((x) => {
    if (typeof x?.available === "boolean") return x.available;
    if (typeof x?.is_available === "boolean") return x.is_available;
    if (typeof x?.status === "string") return x.status.toLowerCase() === "available";
    return null;
  });

  if (availFlags.every(v => v === null)) return null;

  const ranges = [];
  let inBooked = false;
  let start = 0;

  for (let i = 0; i < availFlags.length; i++) {
    const isBooked = availFlags[i] === false;
    if (isBooked && !inBooked) {
      inBooked = true;
      start = i;
    } else if (!isBooked && inBooked) {
      inBooked = false;
      ranges.push([start, i - 1]);
    }
  }
  if (inBooked) ranges.push([start, availFlags.length - 1]);

  return ranges;
}

function applyBufferToRanges(ranges, bufferMinutes, totalLength) {
  if (!ranges || ranges.length === 0) return [];
  const expanded = ranges.map(([s, e]) => {
    const ns = Math.max(0, s - bufferMinutes);
    const ne = Math.min(totalLength - 1, e + bufferMinutes);
    return [ns, ne];
  });

  expanded.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of expanded) {
    if (merged.length === 0) merged.push(r);
    else {
      const last = merged[merged.length - 1];
      if (r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
      else merged.push(r);
    }
  }
  return merged;
}

function anyBookedInWindow(bufferedRanges) {
  return bufferedRanges && bufferedRanges.length > 0;
}

function bookedDetail(bufferedRanges) {
  if (!bufferedRanges || bufferedRanges.length === 0) return "";
  const parts = bufferedRanges.slice(0, 3).map(([s, e]) => `${minutesToHHMM(s)}–${minutesToHHMM(e)}`);
  const more = bufferedRanges.length > 3 ? ` (+${bufferedRanges.length - 3} more)` : "";
  return `Booked windows (incl. buffer): ${parts.join(", ")}${more}`;
}

async function booqableFetch(path) {
  const apiKey = requireEnv("BOOQABLE_API_KEY");
  const base = "https://api.booqable.com";
  const url = base + path;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  if (!res.ok) {
    const msg = json?.error?.message || json?.message || text || `HTTP ${res.status}`;
    throw new Error(`Booqable error (${res.status}) on ${path}: ${msg}`);
  }
  return json;
}

function looksLikeAddon(name) {
  const n = String(name || "").toLowerCase();
  const banned = [
    "accident excess",
    "excess",
    "insurance",
    "deposit",
    "gps",
    "child seat",
    "baby seat",
    "booster",
    "add-on",
    "addon",
  ];
  return banned.some((k) => n.includes(k));
}

function productIsCar(p) {
  const rental = !!(p?.rental);
  const trackable = !!(p?.trackable);
  const show = !!(p?.show_in_store);

  const name = p?.title || p?.name || "";
  if (looksLikeAddon(name)) return false;

  return rental && trackable && show;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const todayISO = brisbaneTodayISO();
    const days = [0, 1, 2, 3].map((i) => {
      const iso = addDaysISO(todayISO, i);
      return {
        date: iso,
        label: labelForISO(iso),
        from: toDMY(iso),
        till: toDMY(iso),
      };
    });

    const productsResp = await booqableFetch("/products");
    const list = productsResp?.data ?? productsResp?.products ?? productsResp ?? [];
    const products = Array.isArray(list) ? list : (list?.data ?? []);

    const cars = (products || [])
      .filter(productIsCar)
      .map((p) => ({
        id: p.id ?? p.uuid ?? p.slug ?? p.handle ?? p?.attributes?.id,
        name: p.title || p.name || p?.attributes?.title || "Unnamed",
      }))
      .filter((c) => c.id);

    const BUFFER_MINUTES = 15;

    for (const car of cars) {
      car.statuses = {};

      for (const day of days) {
        const path = `/products/${encodeURIComponent(car.id)}/availability?interval=minute&from=${encodeURIComponent(day.from)}&till=${encodeURIComponent(day.till)}`;

        let availJson;
        try {
          availJson = await booqableFetch(path);
        } catch (e) {
          car.statuses[day.date] = { status: "Unknown", detail: String(e.message || e) };
          continue;
        }

        const ranges = extractBookedMinuteRanges(availJson);
        if (!ranges) {
          car.statuses[day.date] = { status: "Unknown", detail: "Could not parse availability format from Booqable for this product/day." };
          continue;
        }

        const root = availJson?.data ?? availJson;
        const minutesArr = root?.minutes ?? (Array.isArray(root) ? root : root?.data);
        const totalMinutes = Array.isArray(minutesArr) ? minutesArr.length : 1440;

        const buffered = applyBufferToRanges(ranges, BUFFER_MINUTES, totalMinutes);
        const booked = anyBookedInWindow(buffered);

        const isToday = day.date === todayISO;
        if (booked) {
          car.statuses[day.date] = {
            status: isToday ? "Heads-up" : "Booked",
            detail: bookedDetail(buffered),
          };
        } else {
          car.statuses[day.date] = { status: "Available", detail: "" };
        }

        const tomorrowISO = addDaysISO(todayISO, 1);
        if (booked && day.date === tomorrowISO) {
          car.statuses[day.date].status = "Heads-up";
        }
      }
    }

    res.status(200).json({ days, cars });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
}
