const https = require('https');

async function run() {
    const title = "Wellington International Airport";
    console.log(`Fetching HTML for ${title}...`);

    const parseUrl = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(title)}&prop=text&format=json&origin=*&redirects=1`;

    https.get(parseUrl, { headers: { 'User-Agent': 'WikiFlightsTest/1.0' } }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
            try {
                const json = JSON.parse(data);
                if (!json.parse || !json.parse.text) {
                    console.log("No text found");
                    return;
                }
                const html = json.parse.text['*'];

                // Find the header
                const headerIndex = html.indexOf('Airlines_and_destinations');
                if (headerIndex === -1) {
                    console.log("Could not find 'Airlines_and_destinations' ID in HTML");
                    // specific check for text content if ID missing
                    const textIndex = html.indexOf('Airlines and destinations');
                    console.log("'Airlines and destinations' text found at:", textIndex);
                } else {
                    console.log("Found 'Airlines_and_destinations' at index:", headerIndex);
                    // Dump the next 3000 chars to see the table structure
                    console.log("--- HTML SNIPPET ---");
                    console.log(html.substring(headerIndex, headerIndex + 3000));
                    console.log("--------------------");
                }

            } catch (e) {
                console.error(e);
            }
        });
    }).on('error', console.error);
}

run();
