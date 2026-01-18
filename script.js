/**
 * Wiki Flights - script.js
 */

const WIKI_API_BASE = 'https://en.wikipedia.org/w/api.php';

// --- Utils ---

function showError(msg) {
    const el = document.getElementById('status-message');
    el.textContent = msg;
    el.style.display = 'block';
    el.style.color = '#d32f2f';
    setTimeout(() => { el.style.display = 'none'; }, 5000);
}

function showStatus(msg) {
    const el = document.getElementById('status-message');
    el.textContent = msg;
    el.style.display = 'block';
    el.style.color = '#333';
}

function hideStatus() {
    document.getElementById('status-message').style.display = 'none';
}

// --- Wiki Service ---

const WikiService = {
    /**
     * Search for an airport page title by query.
     */
    async searchAirport(query) {
        const params = new URLSearchParams({
            action: 'opensearch',
            search: query,
            limit: 1,
            namespace: 0,
            format: 'json',
            origin: '*'
        });

        const response = await fetch(`${WIKI_API_BASE}?${params}`);
        const data = await response.json();
        // data format: [query, [titles], [descriptions], [urls]]
        if (data[1] && data[1].length > 0) {
            return data[1][0];
        }
        return null;
    },

    /**
     * Get the HTML content and coordinates of the airport page.
     */
    async getAirportData(title) {
        // Fetch HTML content via action=parse
        const parseParams = new URLSearchParams({
            action: 'parse',
            page: title,
            prop: 'text',
            disableeditsection: true,
            redirects: 1,
            format: 'json',
            origin: '*'
        });

        // Fetch Coordinates via action=query
        const queryParams = new URLSearchParams({
            action: 'query',
            titles: title,
            prop: 'coordinates',
            redirects: 1,
            format: 'json',
            origin: '*'
        });

        const [parseResp, queryResp] = await Promise.all([
            fetch(`${WIKI_API_BASE}?${parseParams}`),
            fetch(`${WIKI_API_BASE}?${queryParams}`)
        ]);

        const parseData = await parseResp.json();
        const queryData = await queryResp.json();

        if (!parseData.parse) return null;

        // Use the title from the parsed result (it might be the target of a redirect)
        const realTitle = parseData.parse.title;
        const html = parseData.parse.text['*'];

        let coords = null;
        if (queryData.query && queryData.query.pages) {
            const pages = Object.values(queryData.query.pages);
            // We need to find the page that matches realTitle or just take the first one found
            // Since we asked for one title (and redirects), there should be mostly one page resolved.
            // But if redirects happened, the query response might contain the mapped page.

            const page = pages.find(p => p.coordinates);
            if (page) {
                coords = page.coordinates[0];
            }
        }

        return { title: realTitle, html, coords };
    },

    /**
     * Parse the "Airlines and destinations" table from the HTML.
     */
    parseDestinations(html) {
        console.log("Starting parseDestinations...");
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        // Find the "Airlines and destinations" header
        const headers = Array.from(doc.querySelectorAll('h2, h3, h4'));
        let header = headers.find(h => h.textContent.includes('Airlines and destinations'));

        if (!header) {
            // Fallback: try looking for the span id
            const span = doc.getElementById('Airlines_and_destinations');
            if (span) header = span.closest('h2, h3, h4');
        }

        if (!header) {
            console.error('Could not find "Airlines and destinations" section');
            return [];
        }
        console.log("Found 'Airlines and destinations' header:", header.tagName);

        // Handle modern Wikipedia styling where headers are wrapped in .mw-heading
        let node = header;
        if (header.parentElement && header.parentElement.classList.contains('mw-heading')) {
            node = header.parentElement;
        }

        // Find the following table
        // We need to respect the hierarchy. If we started at H2, we stop at H2.
        // If we hit H3, it might be a subsection "Passenger" which contains the table.

        const startLevel = parseInt(header.tagName.substring(1)); // e.g. 2 for H2

        node = node.nextElementSibling;
        let table = null;
        while (node) {
            if (node.tagName === 'TABLE' && node.classList.contains('wikitable')) {
                table = node;
                console.log("Found destinations table.");
                break;
            }

            // Check for headers or wrapped headers
            let currentNodeTagName = node.tagName;
            if (node.classList.contains('mw-heading')) {
                const childHeader = node.querySelector('h2, h3, h4, h5, h6');
                if (childHeader) currentNodeTagName = childHeader.tagName;
            }

            if (/^H[1-6]$/.test(currentNodeTagName)) {
                const currentLevel = parseInt(currentNodeTagName.substring(1));
                if (currentLevel <= startLevel) {
                    console.log(`Hit header ${currentNodeTagName} (level ${currentLevel}) <= start level ${startLevel}. Stopping search.`);
                    break;
                }
                console.log(`Skipping subsection header ${currentNodeTagName} (level ${currentLevel}) > start level ${startLevel}.`);
            }

            node = node.nextElementSibling;
        }

        if (!table) {
            console.error("No table found after the header.");
            return [];
        }

        // Parse headers to find "Destinations" column index
        // Headers are usually in the first tr (or thead)
        let destColIndex = -1;
        let airlineColIndex = -1;

        const headerRow = table.querySelector('tr');
        if (headerRow) {
            const headerCells = Array.from(headerRow.querySelectorAll('th'));
            headerCells.forEach((th, index) => {
                const text = th.textContent.trim().toLowerCase();
                if (text.includes('destinations')) destColIndex = index;
                if (text.includes('airlines') || text.includes('airline')) airlineColIndex = index;
            });
        }

        console.log(`Column Indices: Airline=${airlineColIndex}, Dest=${destColIndex}`);

        // Fallback if headers are weird or missing
        if (destColIndex === -1) destColIndex = 1; // Default to 2nd column
        if (airlineColIndex === -1) airlineColIndex = 0; // Default to 1st column

        // Parse rows
        const flights = [];
        const rows = Array.from(table.querySelectorAll('tr'));
        console.log(`Processing ${rows.length} rows.`);

        let currentAirline = null;
        let airlineRowSpanLeft = 0;

        // Skip header row(s)
        // Heuristic: iterate from 0. If row has 'th', it's likely a header, skip.
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const cells = Array.from(row.querySelectorAll('td'));

            // If purely header row
            if (row.querySelector('th') && cells.length === 0) {
                console.log(`Row ${i}: Skipping header row.`);
                continue;
            }
            if (cells.length === 0) {
                console.log(`Row ${i}: Skipping empty row.`);
                continue;
            }

            // Logic to grab Airline and Destination based on index

            let targetAirlineCell = null;
            let targetDestCell = null;

            if (airlineRowSpanLeft > 0) {
                // Airline is set from previous
                console.log(`Row ${i}: using cached airline "${currentAirline}" (rowspan left: ${airlineRowSpanLeft})`);

                // Adjust index because Airline cell is missing
                let effectiveDestIndex = destColIndex;
                if (destColIndex > airlineColIndex) {
                    effectiveDestIndex = destColIndex - 1;
                }

                // Safety
                if (effectiveDestIndex < 0) effectiveDestIndex = 0;
                if (effectiveDestIndex >= cells.length) effectiveDestIndex = cells.length - 1;

                targetDestCell = cells[effectiveDestIndex];
                airlineRowSpanLeft--;

            } else {
                // New Airline
                targetAirlineCell = cells[airlineColIndex];
                if (!targetAirlineCell) {
                    console.log(`Row ${i}: No airline cell found at index ${airlineColIndex}. Skipping.`);
                    continue;
                }

                // Check for rowspan
                if (targetAirlineCell.hasAttribute('rowspan')) {
                    const spanVal = parseInt(targetAirlineCell.getAttribute('rowspan'));
                    if (!isNaN(spanVal) && spanVal > 1) {
                        airlineRowSpanLeft = spanVal - 1;
                    }
                }

                currentAirline = targetAirlineCell.textContent.trim().replace(/\[.*?\]/g, '');
                console.log(`Row ${i}: Found new airline "${currentAirline}".`);

                targetDestCell = cells[destColIndex];
                // Handle case where Dest index might be out of bounds (e.g. malformed row)
                if (!targetDestCell) {
                    console.log(`Row ${i}: No dest cell at index ${destColIndex}, using last cell.`);
                    targetDestCell = cells[cells.length - 1];
                }
            }

            if (!targetDestCell || !currentAirline) {
                console.log(`Row ${i}: Missing destCell or currentAirline. Skipping.`);
                continue;
            }

            // Extract destinations
            const links = targetDestCell.querySelectorAll('a');
            console.log(`Row ${i}: Found ${links.length} links in dest cell.`);

            links.forEach(link => {
                const destName = link.textContent.trim();
                const destTitle = link.getAttribute('title');

                // Filter out citations and internal wiki meta links
                if (link.href.includes('#cite_note')) {
                    console.log(`  - Ignoring citation link: ${destName}`);
                    return;
                }
                if (link.title && link.title.includes('Edit section')) return;
                // Exclude invalid matches if any
                if (link.closest('.reference')) return;

                if (!destName || !destTitle) {
                    console.log(`  - Ignoring empty name/title link.`);
                    return;
                }

                console.log(`  + Adding flight: ${currentAirline} -> ${destName}`);
                flights.push({
                    airline: currentAirline,
                    destination: destName,
                    destinationTitle: destTitle
                });
            });
        }

        return flights;
    },

    /**
     * Batch fetch coordinates for a list of Wikipedia page titles.
     * Uses Wikidata Item ID (Q-code) to fetch coordinates if Wikipedia prop=coordinates misses.
     */
    async getCoordinates(titles) {
        const uniqueTitles = [...new Set(titles)];
        const batches = [];
        const BATCH_SIZE = 50;
        for (let i = 0; i < uniqueTitles.length; i += BATCH_SIZE) {
            batches.push(uniqueTitles.slice(i, i + BATCH_SIZE));
        }

        const results = {};
        const missingButHaveQID = {}; // Map: QID -> [Original Titles]

        // 1. Fetch from Wikipedia (Attempt 1 + Get QIDs)
        for (const batch of batches) {
            const params = new URLSearchParams({
                action: 'query',
                prop: 'coordinates|pageprops',
                ppprop: 'wikibase_item',
                titles: batch.join('|'),
                redirects: 1,
                format: 'json',
                origin: '*'
            });

            try {
                const response = await fetch(`${WIKI_API_BASE}?${params}`);
                const data = await response.json();

                if (data.query) {
                    const redirectMap = {};
                    if (data.query.redirects) {
                        data.query.redirects.forEach(r => {
                            if (!redirectMap[r.to]) redirectMap[r.to] = [];
                            redirectMap[r.to].push(r.from);
                        });
                    }

                    if (data.query.pages) {
                        Object.values(data.query.pages).forEach(page => {
                            const titlesToUpdate = [page.title];
                            if (redirectMap[page.title]) {
                                titlesToUpdate.push(...redirectMap[page.title]);
                            }

                            if (page.coordinates) {
                                // Found directly in Wikipedia
                                titlesToUpdate.forEach(t => results[t] = page.coordinates[0]);
                            } else if (page.pageprops && page.pageprops.wikibase_item) {
                                // Missing coords, but has Wikidata Item ID
                                const qid = page.pageprops.wikibase_item;
                                if (!missingButHaveQID[qid]) missingButHaveQID[qid] = [];
                                missingButHaveQID[qid].push(...titlesToUpdate);
                            }
                        });
                    }
                }
            } catch (e) {
                console.error('Error fetching batch logic', e);
            }
        }

        // 2. Fetch missing coordinates from Wikidata
        const qidsToFetch = Object.keys(missingButHaveQID);
        if (qidsToFetch.length > 0) {
            console.log(`Fetching ${qidsToFetch.length} missing coordinates from Wikidata...`);
            const wikidataCoords = await this.fetchWikidataCoordinates(qidsToFetch);

            Object.keys(wikidataCoords).forEach(qid => {
                if (missingButHaveQID[qid]) {
                    missingButHaveQID[qid].forEach(title => {
                        if (!results[title]) {
                            results[title] = wikidataCoords[qid];
                            console.log(`+ Resolved via Wikidata: ${title} -> ${wikidataCoords[qid].lat}, ${wikidataCoords[qid].lon}`);
                        }
                    });
                }
            });
        }

        return results;
    },

    async fetchWikidataCoordinates(qids) {
        const results = {};
        const batches = [];
        for (let i = 0; i < qids.length; i += 50) {
            batches.push(qids.slice(i, i + 50));
        }

        for (const batch of batches) {
            const params = new URLSearchParams({
                action: 'wbgetentities',
                ids: batch.join('|'),
                props: 'claims',
                format: 'json',
                origin: '*'
            });

            try {
                const response = await fetch(`https://www.wikidata.org/w/api.php?${params}`);
                const data = await response.json();

                if (data.entities) {
                    Object.values(data.entities).forEach(entity => {
                        // P625 is "coordinate location"
                        if (entity.claims && entity.claims.P625 && entity.claims.P625.length > 0) {
                            const val = entity.claims.P625[0].mainsnak.datavalue.value;
                            results[entity.id] = {
                                lat: val.latitude,
                                lon: val.longitude
                            };
                        }
                    });
                }
            } catch (e) {
                console.error('Error fetching Wikidata', e);
            }
        }
        return results;
    }
};

// --- Map Service ---

const MapService = {
    map: null,
    markers: [],
    lines: [],

    init() {
        // Initialize map centered on 0,0
        this.map = L.map('map').setView([20, 0], 2);

        // Add OpenStreetMap tile layer
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '© OpenStreetMap contributors'
        }).addTo(this.map);
    },

    clear() {
        this.markers.forEach(m => this.map.removeLayer(m));
        this.lines.forEach(l => this.map.removeLayer(l));
        this.markers = [];
        this.lines = [];
    },

    setView(lat, lon, zoom = 4) {
        this.map.setView([lat, lon], zoom);
    },

    addMarker(lat, lon, title, isOrigin = false) {
        const marker = L.marker([lat, lon], {
            title: title,
            // Make origin marker distinct if needed, for now standard blue is fine
        }).addTo(this.map);

        if (isOrigin) {
            marker.bindPopup(`<b>${title}</b><br>Origin`).openPopup();
        } else {
            marker.bindPopup(`<b>${title}</b>`);
        }

        this.markers.push(marker);
        return marker;
    },

    addFlightPath(originLat, originLon, destLat, destLon, airline, destName) {
        // Create a polyline
        // Handle Date Line crossing
        // If difference in lon is > 180, we need to wrap around.
        // Leaflet will draw the line the "short" way if coordinates are continuous.
        // e.g. 170 to -170 (diff 340). We want 170 to 190.

        let adjustedDestLon = destLon;
        const diff = destLon - originLon;

        if (diff > 180) {
            adjustedDestLon -= 360;
        } else if (diff < -180) {
            adjustedDestLon += 360;
        }

        const line = L.polyline([[originLat, originLon], [destLat, adjustedDestLon]], {
            color: '#007bff',
            weight: 2,
            opacity: 0.6
        }).addTo(this.map);

        // Tooltip/Popup logic
        line.bindTooltip(`${airline}: ${destName}`, {
            sticky: true,
            className: 'flight-tooltip'
        });

        // Hover effects
        line.on('mouseover', function (e) {
            this.setStyle({ color: '#ff0000', weight: 3, opacity: 1 });
        });
        line.on('mouseout', function (e) {
            this.setStyle({ color: '#007bff', weight: 2, opacity: 0.6 });
        });

        this.lines.push(line);
    }
};

// --- App Logic ---

async function handleSearch() {
    const input = document.getElementById('airport-input');
    const query = input.value.trim();

    if (!query) return;

    // Reset UI
    MapService.clear();
    showStatus(`Searching for "${query}"...`);

    try {
        // 1. Find Airport Page
        const title = await WikiService.searchAirport(query);
        if (!title) {
            showError('Airport not found on Wikipedia.');
            return;
        }

        showStatus(`Found "${title}". fetching details...`);

        // 2. Get Details & Origin Coords
        const airportData = await WikiService.getAirportData(title);
        if (!airportData || !airportData.coords) {
            showError(`Could not find coordinates for "${title}".`);
            return;
        }

        const originLat = airportData.coords.lat;
        const originLon = airportData.coords.lon;

        // Center map
        MapService.setView(originLat, originLon, 5);
        MapService.addMarker(originLat, originLon, title, true);

        // 3. Parse Destinations
        showStatus('Parsing flights...');
        const flights = WikiService.parseDestinations(airportData.html);
        console.log(`Parsed ${flights.length} flights.`);

        if (flights.length === 0) {
            showError('No flights found (or could not parse "Airlines and destinations" table).');
            return;
        }

        // 4. Get Coordinates for Destinations
        showStatus(`Locating ${flights.length} destinations...`);

        // Extract unique titles to fetch
        const destTitles = flights.map(f => f.destinationTitle).filter(t => t);
        const coordsMap = await WikiService.getCoordinates(destTitles);

        // 5. Plot Flights (Grouped by Destination)
        const flightsByDest = {};

        flights.forEach(flight => {
            const key = flight.destinationTitle; // Use title as unique key
            if (!flightsByDest[key]) {
                flightsByDest[key] = {
                    destinationTitle: flight.destinationTitle,
                    destination: flight.destination,
                    airlines: new Set()
                };
            }
            flightsByDest[key].airlines.add(flight.airline);
        });

        let plottedCount = 0;

        Object.values(flightsByDest).forEach(group => {
            const destCoord = coordsMap[group.destinationTitle];

            if (destCoord) {
                // Combine airlines: "Air NZ, Jetstar"
                const combinedAirlines = Array.from(group.airlines).join(', ');

                MapService.addFlightPath(
                    originLat, originLon,
                    destCoord.lat, destCoord.lon,
                    combinedAirlines,
                    group.destination
                );

                plottedCount++;
            } else {
                console.warn(`Missing coordinates for destination: "${group.destination}" (Title: "${group.destinationTitle}")`);
            }
        });

        showStatus(`Displayed ${plottedCount} flights from ${title}.`);
        setTimeout(hideStatus, 3000);

    } catch (err) {
        console.error(err);
        showError('An error occurred during processing.');
    }
}

// Initialization
document.addEventListener('DOMContentLoaded', () => {
    MapService.init();

    const btn = document.getElementById('search-button');
    const input = document.getElementById('airport-input');

    btn.addEventListener('click', handleSearch);
    input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleSearch();
    });
});
