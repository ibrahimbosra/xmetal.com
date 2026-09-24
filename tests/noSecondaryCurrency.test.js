const assert = require('assert');
const fs = require('fs');
const path = require('path');

const searchRoots = [
 path.join(__dirname, '..', 'js'),
 path.join(__dirname, '..', 'mobile-sales'),
 path.join(__dirname, '..', 'tests')
];

const bannedFragments = [
 'dual currency',
 'alternative currency',
 'foreign currency conversion'
];

function walk(dir) {
 const entries = fs.readdirSync(dir, { withFileTypes: true });
 const files = [];
 for (const entry of entries) {
  const fullPath = path.join(dir, entry.name);
  if (entry.isDirectory()) files.push(...walk(fullPath));
  else if (entry.name.endsWith('.js') || entry.name.endsWith('.html')) files.push(fullPath);
 }
 return files;
}

const files = [...new Set(searchRoots.flatMap(walk))].filter(file => !file.endsWith(path.join('tests', 'noSecondaryCurrency.test.js')));
const offenders = [];

for (const file of files) {
 const text = fs.readFileSync(file, 'utf8');
 for (const fragment of bannedFragments) {
  if (text.toLowerCase().includes(fragment.toLowerCase())) {
   offenders.push(`${path.relative(process.cwd(), file)} contains ${fragment}`);
   break;
  }
 }
}

assert.deepStrictEqual(offenders, [], `legacy -currency references remain: ${offenders.join('; ')}`);
console.log(`single-currency cleanup check passed for ${files.length} files`);
