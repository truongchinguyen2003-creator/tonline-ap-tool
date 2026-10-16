const fs = require('fs');

const inputFile = process.argv[2] || 'input.txt';
const outputFile = process.argv[3] || 'errors_grouped.txt';

const lines = fs.readFileSync(inputFile, 'utf-8').split('\n').filter(Boolean);

const errorMap = new Map();

for (const line of lines) {
  const sep = line.indexOf('|');
  if (sep === -1) continue;
  const mail = line.slice(0, sep).trim();
  const error = line.slice(sep + 1).trim();
  if (!errorMap.has(error)) errorMap.set(error, []);
  errorMap.get(error).push(mail);
}

const result = [];
for (const [error, mails] of errorMap) {
  result.push(`=== ${error} (${mails.length}) ===`);
  mails.forEach(m => result.push(m));
  result.push('');
}

fs.writeFileSync(outputFile, result.join('\n'), 'utf-8');
console.log(`Done: ${errorMap.size} loại error, ${lines.length} dòng`);
