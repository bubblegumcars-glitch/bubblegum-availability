export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  
  try {
    const COMPANY_SLUG = process.env.BOOQABLE_COMPANY_SLUG || "bubblegum-cars";
    const TOKEN = process.env.BOOQABLE_ACCESS_TOKEN;
    if (!TOKEN) return res.status(500).json({ error: "Missing token" });

    const baseUrl = `https://${COMPANY_SLUG}.booqable.com/api/4`;
    
    // Get current time in different formats for comparison
    const now = new Date();
    const nowISO = now.toISOString();
    
    // Fetch plannings without date filters to see ALL current bookings
    const planningPath = `/plannings?per_page=200&sort=reserved_from&filter[reserved]=true&filter[planning_type]=order`;
    
    const res2 = await fetch(`${baseUrl}${planningPath}`, {
      headers: { 
        Authorization: `Bearer ${TOKEN}`, 
        Accept: "application/json" 
      },
    });
    
    const planningsJson = await res2.json();
    
    return res.status(200).json({
      current_time: nowISO,
      brisbane_time: now.toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' }),
      total_plannings: planningsJson.data?.length || 0,
      plannings: planningsJson.data?.map(p => ({
        id: p.id,
        item_id: p.attributes?.item_id,
        status: p.attributes?.status,
        reserved_from: p.attributes?.reserved_from,
        reserved_till: p.attributes?.reserved_till,
        starts_at: p.attributes?.starts_at,
        stops_at: p.attributes?.stops_at,
      })) || []
    });
    
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
