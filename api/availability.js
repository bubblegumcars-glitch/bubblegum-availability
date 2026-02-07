// api/availability.js
export default async function handler(req, res) {
  // Parse incoming dates or set defaults
  const { from, to } = req.query;
  const now = new Date();
  const start = from ? new Date(from) : now;
  const end   = to   ? new Date(to)   : new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000); // default 4-day window

  // Format dates as ISO strings
  const startStr = start.toISOString();
  const endStr   = end.toISOString();

  // Booqable credentials from environment variables
  const booqableDomain = process.env.BOOQABLE_DOMAIN;
  const booqableApiKey = process.env.BOOQABLE_API_KEY;

  // Query the Booqable Products API for availability
  const url = `https://${booqableDomain}/api/products?search[available_between]=${startStr},${endStr}`;

  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${booqableApiKey}`,
    },
  });

  const data = await response.json();

  // Filter out non-car “products” (like the Accident Excess)
  const cars = data.products
    .filter((product) => {
      const groupName = product.product_group?.name ?? '';
      return groupName !== 'Accident Excess';
    })
    .map((product) => ({
      id: product.id,
      name: product.name.trim(),
      unavailable: [], // Will be filled if there are overlapping bookings
    }));

  // Return the formatted availability information
  res.status(200).json({
    now: new Date().toISOString(),
    window: { start: startStr, end: endStr, days: (end - start) / (24 * 60 * 60 * 1000) },
    cars,
  });
}
