// Bubblegum Cars — Availability API (Vercel Serverless)
// FINAL + WORKING minute parser for Booqable

const MEMORY_CACHE = { map: new Map() };

function memGet(key) {
  const hit = MEMORY_CACHE.map.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    MEMORY_CACHE.map.delete(key);
    return null;
  }
  return hit.value;
}
function memSet(key, value, ttlMs) {
  MEMORY_CACHE.map.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable: ${name}`);
  return v;
}

function pad2(n) { return String(n).padStart(2, "0"); }

function brisbaneTodayISO() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Brisbane",
    year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(now);
  return `${parts.find(p=>p.type==="year").value}-${parts.find(p=>p.type==="month").value}-${parts.find(p=>p.type==="day").value}`;
}

function addDaysISO(iso, d) {
  const dt = new Date(iso + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + d);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth()+1)}-${pad2(dt.getUTCDate())}`;
}
function toDMY(iso){ const [y,m,d]=iso.split("-"); return `${d}-${m}-${y}`; }

function labelForISO(iso) {
  const dt = new Date(iso + "T00:00:00Z");
  return dt.toLocaleDateString("en-AU",{weekday:"short",day:"2-digit",month:"short",timeZone:"Australia/Brisbane"});
}

function looksLikeAddon(name="") {
  const n = name.toLowerCase();
  return ["add","excess","insurance","driver","seat","charger","cable"].some(k=>n.includes(k));
}

async function booqableFetch(path,{cacheKey=null,ttl=0}={}) {
  const apiKey = requireEnv("BOOQABLE_API_KEY");
  const slug = requireEnv("BOOQABLE_COMPANY_SLUG");
  const url = `https://${slug}.booqable.com/api/1${path}${path.includes("?")?"&":"?"}api_key=${apiKey}`;

  if (cacheKey) {
    const c = memGet(cacheKey);
    if (c) return c;
  }

  const res = await fetch(url);
  const txt = await res.text();
  const json = JSON.parse(txt);

  if (!res.ok) throw new Error(json?.message || txt);

  if (cacheKey) memSet(cacheKey,json,ttl);
  return json;
}

function parseMinuteBlocks(minJson) {
  const arr = minJson?.data || [];
  if (!Array.isArray(arr) || arr.length === 0) return null;

  const blocks = [];
  let current = null;

  for (const m of arr) {
    const t = new Date(m.at);
    if (m.available === false) {
      if (!current) current = { start:t, end:t };
      current.end = t;
    } else if (current) {
      blocks.push(current);
      current = null;
    }
  }
  if (current) blocks.push(current);

  return blocks;
}

function formatRanges(ranges) {
  if (!ranges || ranges.length === 0) return "";
  return ranges.map(r=>{
    const out = r.start.toLocaleTimeString("en-AU",{hour:"2-digit",minute:"2-digit",hour12:false,timeZone:"Australia/Brisbane"});
    const back = new Date(r.end.getTime()+15*60000)
      .toLocaleTimeString("en-AU",{hour:"2-digit",minute:"2-digit",hour12:false,timeZone:"Australia/Brisbane"});
    return `Out ${out} → Back ${back}`;
  }).join(" • ");
}

export default async function handler(req,res){
  try{
    const today = brisbaneTodayISO();
    const days = [0,1,2,3].map(i=>{
      const d = addDaysISO(today,i);
      return { date:d,label:labelForISO(d),from:toDMY(d),till:toDMY(d) };
    });

    const products = (await booqableFetch("/products",{cacheKey:"products",ttl:600000})).products || [];
    const cars = products.filter(p=>!looksLikeAddon(p.name)).map(p=>({id:p.id,name:p.name}));

    const sel = req.query.date;
    if (!sel) return res.json({days,cars});

    const day = days.find(d=>d.date===sel);
    const outCars = [];

    for (const car of cars) {
      let status="Available", times="";

      const dayAvail = await booqableFetch(
        `/products/${car.id}/availability?from=${day.from}&till=${day.till}`,
        {cacheKey:`day:${car.id}:${day.date}`,ttl:60000}
      );

      if ((dayAvail.available ?? 1) === 0) status="Booked";

      if (status!=="Available") {
        const minuteAvail = await booqableFetch(
          `/products/${car.id}/availability?interval=minute&include_unavailable=true&from=${day.from}&till=${day.till}`,
          {cacheKey:`min:${car.id}:${day.date}`,ttl:60000}
        );
        const blocks = parseMinuteBlocks(minuteAvail);
        times = formatRanges(blocks);
        if (!times) status="Heads-up";
      }

      outCars.push({
        id:car.id,
        name:car.name,
        statuses:{ [day.date]:{status,times} }
      });
    }

    res.json({days,selectedDate:day.date,cars:outCars});
  }catch(e){
    res.status(500).json({error:e.message});
  }
}
