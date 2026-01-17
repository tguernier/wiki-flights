
const https = require('https');

// Wait, if I cannot use jsdom, I have to rely on regex or string search in this debug script, 
// OR I just dump the HTML and inspect it manually.
// OR I assume existing `debug_html.js` was running in a context where it worked?
// `debug_html.js` uses `fs`. 

// Let's just fetch the HTML and save it, and then I will inspect stricture with Grep or just print snippets.
// I will also try to simulate the logic using string searches if I can't use DOMParser.

const fs = require('fs');

const url = 'https://en.wikipedia.org/w/api.php?action=parse&page=Auckland_Airport&prop=text&format=json&origin=*&redirects=1';

console.log('Fetching data...');
https.get(url, { headers: { 'User-Agent': 'WikiFlightsDebug/1.0' } }, (res) => {
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
        try {
            const json = JSON.parse(data);
            const html = json.parse.text['*'];
            fs.writeFileSync('auckland_full.html', html);
            console.log('Saved to auckland_full.html (' + html.length + ' bytes)');

            // Analyze the structure around Airlines and destinations
            const headerRegex = /<h[234][^>]*id="Airlines_and_destinations"[^>]*>.*?<\/h[234]>/g;
            const match = headerRegex.exec(html);
            let searchStart = 0;
            if (match) {
                console.log('Found Header by ID:', match[0]);
                searchStart = match.index;
            } else {
                console.log('Header ID NOT found. Searching text...');
                searchStart = html.indexOf('Airlines and destinations');
                console.log('Found Header by Text index:', searchStart);
            }

            if (searchStart !== -1) {
                // Look for tables after this point
                const snippet = html.substring(searchStart, searchStart + 10000);

                // Count tables
                const tableCount = (snippet.match(/<table class="wikitable/g) || []).length;
                console.log(`Found ${tableCount} wikitables in the first 10k chars after header.`);

                // Show the tags following the header to see if structure is unexpected
                // Simple tag stripper to show hierarchy
                // This is rough but helpful
                console.log('Snippet start:');
                console.log(snippet.substring(0, 500));
            }

        } catch (e) {
            console.error('Error parsing response:', e);
        }
    });
});
