const fs = require('fs');

const input = fs.readFileSync('input.txt', 'utf-8');
const emails = input
  .split('\n')
  .map(l => l.trim())
  .filter(l => l.includes('@'))
  .map(l => l.replace(/^\[.*?\].*?:/, '').trim())
  .filter(Boolean);

fs.writeFileSync('output.txt', emails.join('\n'), 'utf-8');
console.log(`Done: ${emails.length} emails saved to output.txt`);
