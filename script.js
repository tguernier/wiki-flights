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
                    // We hit a header of same or higher level (e.g. H2 or H1), so we are done with this section
                    break;
                }
                // If currentLevel > startLevel (e.g. H3 vs H2), we continue as it is a subsection
            }

            node = node.nextElementSibling;
        }

        if (!table) return [];

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

        // Fallback if headers are weird or missing
        if (destColIndex === -1) destColIndex = 1; // Default to 2nd column
        if (airlineColIndex === -1) airlineColIndex = 0; // Default to 1st column

        // Parse rows
        const flights = [];
        const rows = Array.from(table.querySelectorAll('tr'));

        let currentAirline = null;
        let airlineRowSpanLeft = 0;

        // Skip header row(s)
        // Heuristic: iterate from 0. If row has 'th', it's likely a header, skip.
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const cells = Array.from(row.querySelectorAll('td'));

            // If purely header row
            if (row.querySelector('th') && cells.length === 0) continue;
            if (cells.length === 0) continue;

            // Logic to grab Airline and Destination based on index
            // Note: If Airline is rowspanned, the indices shift for subsequent rows!
            // E.g.
            // Row 1: [Airline (rowspan=2)], [Terminal], [Destinations]  (3 cells)
            // Row 2: [Terminal], [Destinations]                          (2 cells)
            //
            // If we know Airline is Col 0 and Dest is Col 2.
            // In Row 2, the "real" Col 0 (Airline) is invisible. 
            // The first cell in DOM is "Terminal" which effectively becomes Col 1.
            // The second cell in DOM is "Destinations" which effectively becomes Col 2.

            // We need to map DOM cells to Logical columns.

            let domCellIndex = 0;
            let targetAirlineCell = null;
            let targetDestCell = null;

            // Simplified State Machine for columns
            // We only care about Airline (usually 0) and Dest (usually 1 or 2).
            // This is getting complicated to fully simulate table model.
            // Let's stick to the heuristic:
            // If Airline is rowspanned:
            //    We are looking for the 'Destinations' field in the remaining cells.
            //    If original scheme was Airline(0), Dest(1) -> Now cell 0 is Dest.
            //    If original scheme was Airline(0), Term(1), Dest(2) -> Now cell 1 is Dest.

            // Calculate effective index for Destinations
            // validDestIndex = destColIndex
            // if (airlineRowSpanLeft > 0 && destColIndex > airlineColIndex) validDestIndex--;


            if (airlineRowSpanLeft > 0) {
                // Airline is set from previous

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
                if (!targetAirlineCell) continue; // Should not happen if well-formed

                // Check for rowspan
                if (targetAirlineCell.hasAttribute('rowspan')) {
                    const spanVal = parseInt(targetAirlineCell.getAttribute('rowspan'));
                    if (!isNaN(spanVal) && spanVal > 1) {
                        airlineRowSpanLeft = spanVal - 1;
                    }
                }

                currentAirline = targetAirlineCell.textContent.trim().replace(/\[.*?\]/g, '');

                targetDestCell = cells[destColIndex];
                // Handle case where Dest index might be out of bounds (e.g. malformed row)
                if (!targetDestCell) targetDestCell = cells[cells.length - 1];
            }

            if (!targetDestCell || !currentAirline) continue;

            // Extract destinations
            const links = targetDestCell.querySelectorAll('a');
            links.forEach(link => {
                // Filter out citations and internal wiki meta links
                if (link.href.includes('#cite_note')) return;
                if (link.title.includes('Edit section')) return;
                // Exclude invalid matches if any
                if (link.closest('.reference')) return;

                const destName = link.textContent.trim();
                const destTitle = link.getAttribute('title');

                if (destName && destTitle) {
                    flights.push({
                        airline: currentAirline,
                        destination: destName,
                        destinationTitle: destTitle
                    });
                }
            });
        }

        return flights;
    },

    /**
     * Batch fetch coordinates for a list of Wikipedia page titles.
     * Wikipedia API limits to 50 titles per query.
     */
    async getCoordinates(titles) {
        const uniqueTitles = [...new Set(titles)];
        const batches = [];
        const BATCH_SIZE = 50;

        for (let i = 0; i < uniqueTitles.length; i += BATCH_SIZE) {
            batches.push(uniqueTitles.slice(i, i + BATCH_SIZE));
        }

        const results = {};

        for (const batch of batches) {
            const params = new URLSearchParams({
                action: 'query',
                prop: 'coordinates',
                titles: batch.join('|'),
                format: 'json',
                origin: '*'
            });

            try {
                const response = await fetch(`${WIKI_API_BASE}?${params}`);
                const data = await response.json();

                if (data.query && data.query.pages) {
                    Object.values(data.query.pages).forEach(page => {
                        if (page.coordinates) {
                            results[page.title] = page.coordinates[0];
                        }
                    });
                }
            } catch (e) {
                console.error('Error fetching batch coordinates', e);
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
        // For simple visualization, straight line on Mercator is fine.
        // For "arc" feel, we could use geodesic plugins but let's stick to simple first
        // as per instructions to be "self-contained" and not use external libraries 
        // (leaflet is allowed as CDN, but plugins might be extra).

        const line = L.polyline([[originLat, originLon], [destLat, destLon]], {
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

        // 5. Plot Flights
        let plottedCount = 0;
        flights.forEach(flight => {
            const destCoord = coordsMap[flight.destinationTitle];
            if (destCoord) {
                MapService.addFlightPath(
                    originLat, originLon,
                    destCoord.lat, destCoord.lon,
                    flight.airline,
                    flight.destination
                );
                // Optional: Add marker for destination? Maybe too crowded.
                // Let's add markers for destinations but without popups open by default
                // MapService.addMarker(destCoord.lat, destCoord.lon, flight.destination);
                plottedCount++;
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
