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
        
        // Debug: Log first product structure
        if (allProducts.length > 0) {
            console.log('Sample product structure:', JSON.stringify(allProducts[0], null, 2));
        }
        
        const cars = allProducts.filter(isRentalCar);
        
        // Debug: Log filtered cars with their IDs
        console.log(`Filtered ${cars.length} cars from ${allProducts.length} products`);
        cars.forEach(car => {
            console.log(`Car: ${car.name}, id: ${car.id}, product_group_id: ${car.product_group_id}`);
        });

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
                    // Hardcoded IDs for Bean and Blossom (temporary fix)
                    const carName = car.name.trim();
                    const hardcodedIds = {
                        'Bean': '479afc49-6399-4395-add3-ccc9b9902f76',
                        'Blossom': '7cea0ef0-8d27-4208-b997-c8b32e3d1fb3'
                    };
                    
                    // Build list of IDs to try
                    let possibleIds = [];
                    
                    // If this car has a hardcoded ID, try that first
                    if (hardcodedIds[carName]) {
                        possibleIds.push(hardcodedIds[carName]);
                    }
                    
                    // Then try the IDs from the API
                    possibleIds = possibleIds.concat([
                        car.product_group_id,
                        car.id,
                        car.item_id,
                        car.slug
                    ].filter(id => id)); // Remove null/undefined values
                    
                    console.log(`${carName} - Trying IDs:`, possibleIds);
                    
                    // Try each ID until one works
                    let availabilityData = null;
                    let workingId = null;
                    
                    for (const productId of possibleIds) {
                        const availabilityURL = `${baseURL}/products/${productId}/availability?interval=minute&from=${fromDate}&till=${tillDate}`;
                        
                        console.log(`Trying ${carName} with ID: ${productId}`);
                        
                        const availabilityResponse = await fetch(availabilityURL, {
                            headers: {
                                'Authorization': `Bearer ${BOOQABLE_API_KEY}`,
                                'Content-Type': 'application/json'
                            }
                        });

                        if (availabilityResponse.ok) {
                            availabilityData = await availabilityResponse.json();
                            workingId = productId;
                            console.log(`SUCCESS: ${carName} works with ID: ${productId}`);
                            break;
                        } else {
                            console.log(`FAILED: ${carName} with ID ${productId} returned ${availabilityResponse.status}`);
                        }
                    }

                    if (!availabilityData) {
                        console.error(`All IDs failed for ${carName}`);
                        return {
                            name: carName,
                            unavailable: [],
                            error: 'All ID attempts failed'
                        };
                    }

                    const unavailableBlocks = parseAvailability(availabilityData, startDate, endDate);

                    return {
                        name: carName,
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
