/**
 * Bubblegum Cars Availability API
 * Vercel Serverless Function
 * 
 * Fetches car availability from Booqable API v1 and returns structured data
 * for the next 4 days in Brisbane timezone.
 */

// Helper: Format date as DD-MM-YYYY for Booqable API
function formatDateForAPI(date) {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    return `${day}-${month}-${year}`;
}

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

// Helper: Parse Booqable availability data into unavailable blocks
function parseAvailability(availabilityData, startDate, endDate) {
    if (!availabilityData || !availabilityData.data) {
        return [];
    }

    const unavailableBlocks = [];
    let currentBlock = null;

    // Booqable returns minute-by-minute availability
    // We need to find continuous blocks where available <= 0
    const minutes = Object.entries(availabilityData.data).sort((a, b) => {
        return new Date(a[0]) - new Date(b[0]);
    });

    for (const [timestamp, count] of minutes) {
        const time = new Date(timestamp);
        const isUnavailable = count <= 0;

        if (isUnavailable) {
            if (!currentBlock) {
                // Start new unavailable block
                currentBlock = {
                    start: new Date(time),
                    end: new Date(time)
                };
            } else {
                // Extend current block
                currentBlock.end = new Date(time);
            }
        } else {
            if (currentBlock) {
                // End of unavailable block - add 15 minute buffer
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

    // Close any remaining block
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

    const baseURL = `https://${BOOQABLE_COMPANY}.booqable.com/api/1`;

    try {
        // Step 1: Calculate date window (Today + next 3 days = 4 days total)
        const startDate = getBrisbaneMidnight(0); // Today midnight Brisbane
        const endDate = getBrisbaneMidnight(4);   // +4 days midnight Brisbane
        
        const fromDate = formatDateForAPI(startDate);
        const tillDate = formatDateForAPI(endDate);

        // Generate array of day start times for frontend
        const days = [];
        for (let i = 0; i < 4; i++) {
            days.push(getBrisbaneMidnight(i).toISOString());
        }

        // Step 2: Fetch all products from Booqable
        const productsResponse = await fetch(`${baseURL}/products`, {
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
                cars: [],
                debug: {
                    totalProducts: allProducts.length,
                    message: 'No cars found after filtering. Check product configuration.'
                }
            });
        }

        // Step 4: Fetch availability for each car
        const carsWithAvailability = await Promise.all(
            cars.map(async (car) => {
                try {
                    // IMPORTANT: Use product_group_id if available, otherwise fall back to id
                    // Booqable sometimes requires the group ID for availability endpoint
                    const productId = car.product_group_id || car.id;
                    
                    const availabilityURL = `${baseURL}/products/${productId}/availability?interval=minute&from=${fromDate}&till=${tillDate}`;
                    
                    const availabilityResponse = await fetch(availabilityURL, {
                        headers: {
                            'Authorization': `Bearer ${BOOQABLE_API_KEY}`,
                            'Content-Type': 'application/json'
                        }
                    });

                    if (!availabilityResponse.ok) {
                        console.error(`Availability fetch failed for ${car.name}:`, availabilityResponse.status);
                        return {
                            name: car.name.trim(),
                            unavailable: [],
                            error: `API error: ${availabilityResponse.status}`
                        };
                    }

                    const availabilityData = await availabilityResponse.json();
                    const unavailableBlocks = parseAvailability(availabilityData, startDate, endDate);

                    return {
                        name: car.name.trim(),
                        unavailable: unavailableBlocks
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
                days: 4,
                from: fromDate,
                till: tillDate
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
