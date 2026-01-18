# wiki-flights
This is a HTML page which shows a map of flights from any airport with a list of destinations. It uses the Wikipedia page for the airport to get the list of destinations.

This version of the site was summoned into being by Gemini 3 Pro using the Antigravity IDE.

## How to use

1. Open the HTML page in a web browser.
2. Enter the airport name or IATA/ICAO code in the input field.
3. Click the "Show flights" button.

## Specification

This is a HTML page which shows a map of all passenger flights from any airport with a list of destinations (typically under the 'Airlines and destinations' header). The page should be self-contained and not require any external libraries, though it can use an external CDN to get map data and/or coordinates of airports. It should resemble the site https://tguernier.github.io/wiki-flights/, but fully generalised over all airports with a valid Wikpedia article.

When first opened the page should display an input field for the airport name or code. Once the airport name or code has been entered, the page should display a zoomable and scrollable world map with the flights overlaid on it. Mousing over a flight arc or a destination airport should show the name and IATA/ICAO codes of the destination airport and the airline or airlines that operate flights to that destination.

Be very careful to ensure that the code to parse flights and destinations from the Wikipedia page is robust and returns all flights from all passenger airlines. Make sure this is working before starting work on the frontend display.
