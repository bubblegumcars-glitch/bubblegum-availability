/**
 * Bubblegum Cars Availability API
 * Vercel Serverless Function
 * 
 * Uses hybrid approach for maximum reliability:
 * - API v3 (shop API) for Betsy, Breezy, Bubbles
 * - API v1 for Bean and Blossom (v3 doesn't return their bookings correctly)
 * 
 * Returns availability data for the next 4 days in Brisbane timezone.
 */

// Helper: Get Brisbane midnight for a given date
function getBrisbaneMidnight(offsetDays = 0) {
    const now = new Date();
    
    // Get current time in Brisbane
    const brisbaneTime = new Date(now.toLocaleString('en-US', { timeZone: 'Australia/Brisbane' }));
    
    // Set to midnight
    brisbaneTime.setHours(0, 0, 0, 0);
    
    // Add offset days
    brisbaneTime.setDate(brisbaneTime.getDate() + offsetDays);
    
    // Convert back to UTC for API consistency
    const utcTime = new Date(brisbaneTime.toISOString());
    
    return utcTime;
}

// Helper: Format date as DD-MM-YYYY for Booqable API v1
function formatDateForAPI(date) {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    return `${day}-${month}-${year}`;
}

// Helper: Parse v1 availability data
function parseV1Availability(availabilityData, startDate, endDate) {
    if (!availabilityData || !availabilityData.data) {
        return [];
    }

    const unavailableBlocks = [];
    let currentBlock = null;

    const minutes = Object.entries(availabilityData.data).sort((a, b) => {
        return new Date(a[0]) - new Date(b[0]);
    });

    for (const [timestamp, count] of minutes) {
        const time = new Date(timestamp);
        const isUnavailable = count <= 0;

        if (isUnavailable) {
            if (!currentBlock) {
                currentBlock = {
                    start: new Date(time),
                    end: new Date(time)
                };
            } else {
                currentBlock.end = new Date(time);
            }
        } else {
            if (currentBlock) {
                const endWithBuffer = new Date(currentBlock.end);
                endWithBuffer.setMinutes(endWithBuffer.getMinutes() + 15);
                
                unavailableBlocks.push({
                    start: currentBlock.start.toISOString(),
                    end: endWithBuffer.toISOString()
                });
                
                currentBlock = null;
            }
        }
    }

    if (currentBlock) {
        const endWithBuffer = new Date(currentBlock.end);
        endWithBuffer.setMinutes(endWithBuffer.getMinutes() + 15);
        
        unavailableBlocks.push({
            start: currentBlock.start.toISOString(),
            end: endWithBuffer.toISOString()
        });
    }

    return unavailableBlocks;
}

// Helper: Filter to only rental cars (exclude accessories and add-ons)
function isRentalCar(product) {
    const name = (product.name || '').trim().toLowerCase();
    
    // Must be a rental product
    if (product.product_type !== 'rental') return false;
    
    // Must be trackable
    if (!product.trackable && product.tracking_type !== 'trackable') return false;
    
    // Must be shown in store
    if (!product.show_in_store) return false;
    
    // Exclude accessories and add-ons by name
    const excludeKeywords = [
        'add on',
        'add-on',
        'addon',
        'excess',
        'speaker',
        'camera',
        'insurance',
        'roadside',
        'gps',
        'child seat',
        'booster',
        'delivery',
        'collection'
    ];
    
    for (const keyword of excludeKeywords) {
        if (name.includes(keyword)) return false;
    }
    
    // Optional: Cars typically have higher daily rates (>= $100)
    // This helps filter out cheap accessories
    if (product.base_price_in_cents && product.base_price_in_cents < 10000) {
        return false;
    }
    
    return true;
}

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Booqable API credentials from environment variables
    const BOOQABLE_COMPANY = process.env.BOOQABLE_COMPANY;
    const BOOQABLE_API_KEY = process.env.BOOQABLE_API_KEY;

    if (!BOOQABLE_COMPANY || !BOOQABLE_API_KEY) {
        return res.status(500).json({ 
            error: 'Missing Booqable API configuration',
            message: 'Please set BOOQABLE_COMPANY and BOOQABLE_API_KEY environment variables'
        });
    }

    // Use the shop API (v3) - same as the booking website
    const shopURL = `https://${BOOQABLE_COMPANY}.booqableshop.com/api/3`;
    const apiURL = `https://${BOOQABLE_COMPANY}.booqable.com/api/1`;

    try {
        // Step 1: Calculate date window (Today + next 3 days = 4 days total)
        const startDate = getBrisbaneMidnight(0); // Today midnight Brisbane
        const endDate = getBrisbaneMidnight(4);   // +4 days midnight Brisbane

        // Generate array of day start times for frontend
        const days = [];
        for (let i = 0; i < 4; i++) {
            days.push(getBrisbaneMidnight(i).toISOString());
        }

        // Step 2: Fetch all products from Booqable API v1
        const productsResponse = await fetch(`${apiURL}/products`, {
            headers: {
                'Authorization': `Bearer ${BOOQABLE_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        if (!productsResponse.ok) {
            throw new Error(`Booqable products API error: ${productsResponse.status}`);
        }

        const productsData = await productsResponse.json();
        
        // Step 3: Filter to rental cars only
        const allProducts = productsData.data || productsData.products || [];
        const cars = allProducts.filter(isRentalCar);

        if (cars.length === 0) {
            return res.status(200).json({
                tz: 'Australia/Brisbane',
                window: {
                    start: startDate.toISOString(),
                    end: endDate.toISOString(),
                    days: 4
                },
                days: days,
                cars: []
            });
        }

        // Hardcoded item IDs (from the working product group IDs we found)
        const itemIdMap = {
            'Bean': '479afc49-6399-4395-add3-ccc9b9902f76',
            'Blossom': '7cea0ef0-8d27-4208-b997-c8b32e3d1fb3',
            'Betsy': 'd70ea3db-7973-451c-af33-c30e307720ef',
            'Breezy': '75cee8f1-9b60-484c-820e-380dd607c3f3',
            'Bubbles': 'c03a9629-816c-4010-bcf7-08e7780f5d4e'
        };

        // Step 4: Fetch availability for each car
        // Use hybrid approach: v1 for Bean/Blossom, v3 for others
        const carsWithAvailability = await Promise.all(
            cars.map(async (car) => {
                try {
                    const carName = car.name.trim();
                    const itemId = itemIdMap[carName] || car.product_group_id || car.id;

                    // Bean and Blossom seem to work better with API v1
                    if (carName === 'Bean' || carName === 'Blossom') {
                        // Use API v1 for these cars
                        const fromDate = formatDateForAPI(startDate);
                        const tillDate = formatDateForAPI(endDate);
                        const availURL = `${apiURL}/products/${itemId}/availability?interval=minute&from=${fromDate}&till=${tillDate}`;

                        const availResponse = await fetch(availURL, {
                            headers: {
                                'Authorization': `Bearer ${BOOQABLE_API_KEY}`,
                                'Content-Type': 'application/json'
                            }
                        });

                        if (!availResponse.ok) {
                            console.error(`API v1 failed for ${carName}:`, availResponse.status);
                            return {
                                name: carName,
                                unavailable: []
                            };
                        }

                        const availData = await availResponse.json();
                        const unavailableBlocks = parseV1Availability(availData, startDate, endDate);

                        return {
                            name: carName,
                            unavailable: unavailableBlocks
                        };
                    }

                    // For other cars, use API v3
                    const allUnavailable = [];

                    for (let dayOffset = 0; dayOffset < 4; dayOffset++) {
                        const dayDate = new Date(startDate);
                        dayDate.setDate(dayDate.getDate() + dayOffset);
                        
                        const year = dayDate.getFullYear();
                        const month = dayDate.getMonth() + 1;
                        const day = dayDate.getDate();

                        // Use API v3 item_availabilities endpoint (same as booking site)
                        // Note: Adding locale parameter to match customer booking site
                        const availURL = `${shopURL}/item_availabilities?filter[year]=${year}&filter[month]=${month}&filter[day]=${day}&filter[item_id]=${itemId}&filter[quantity]=1&locale=en`;

                        const availResponse = await fetch(availURL);

                        if (!availResponse.ok) {
                            console.error(`API v3 failed for ${carName} on ${year}-${month}-${day}:`, availResponse.status);
                            continue;
                        }

                        const availData = await availResponse.json();
                        const timeSlots = availData.data || [];

                        // Find unavailable blocks
                        let currentBlock = null;

                        for (const slot of timeSlots) {
                            const slotDate = slot.attributes.date;
                            const slotHour = slot.attributes.hour;
                            const slotMinute = slot.attributes.minute;
                            const isUnavailable = slot.attributes.status === 'unavailable';

                            if (isUnavailable) {
                                const slotTime = new Date(`${slotDate}T${slotHour.padStart(2, '0')}:${slotMinute.padStart(2, '0')}:00+10:00`);

                                if (!currentBlock) {
                                    currentBlock = {
                                        start: slotTime,
                                        end: new Date(slotTime.getTime() + 30 * 60 * 1000) // Add 30 min
                                    };
                                } else {
                                    // Extend current block
                                    currentBlock.end = new Date(slotTime.getTime() + 30 * 60 * 1000);
                                }
                            } else {
                                if (currentBlock) {
                                    // Add 15 minute buffer to end
                                    const endWithBuffer = new Date(currentBlock.end.getTime() + 15 * 60 * 1000);
                                    allUnavailable.push({
                                        start: currentBlock.start.toISOString(),
                                        end: endWithBuffer.toISOString()
                                    });
                                    currentBlock = null;
                                }
                            }
                        }

                        // Close any remaining block
                        if (currentBlock) {
                            const endWithBuffer = new Date(currentBlock.end.getTime() + 15 * 60 * 1000);
                            allUnavailable.push({
                                start: currentBlock.start.toISOString(),
                                end: endWithBuffer.toISOString()
                            });
                        }
                    }

                    return {
                        name: carName,
                        unavailable: allUnavailable
                    };
                } catch (error) {
                    console.error(`Error fetching availability for ${car.name}:`, error);
                    return {
                        name: car.name.trim(),
                        unavailable: [],
                        error: error.message
                    };
                }
            })
        );

        // Step 5: Return structured response
        return res.status(200).json({
            tz: 'Australia/Brisbane',
            window: {
                start: startDate.toISOString(),
                end: endDate.toISOString(),
                days: 4
            },
            days: days,
            cars: carsWithAvailability,
            metadata: {
                totalCars: carsWithAvailability.length,
                fetchedAt: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('API Handler Error:', error);
        return res.status(500).json({
            error: 'Internal server error',
            message: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
}
