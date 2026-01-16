
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('airport_data.json', 'utf8'));
const html = data.parse.text['*'];

const index = html.indexOf('Airlines and destinations');
if (index !== -1) {
    console.log('Found header at index:', index);
    // Print 5000 characters starting from a bit before the header
    console.log(html.substring(index - 100, index + 5000));
} else {
    console.log('Header not found');
}
