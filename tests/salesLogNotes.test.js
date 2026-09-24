const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const appSource = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const stylesSource = fs.readFileSync(path.join(__dirname, '../css/styles.css'), 'utf8');
const salesLogSection = indexSource.match(/<div class="section-panel" id="section-salesLog">[\s\S]*?<\/div>\s*<\/div>/)?.[0] || '';

test('sales log notes keep payment, status, inactive labeling, and historical profit separate', () => {
  assert.match(appSource, /function getSalePaymentLabel\(sale\)/);
  assert.match(appSource, /function getSaleNotes\(sale, isActive\)/);
  assert.match(appSource, /statusLabel \+ ' • ' \+ paymentLabel/);
  assert.match(appSource, /!isActive \? ' • غير محتسبة' : ''/);
  assert.match(appSource, /formatMoney\(s\.profit \|\| 0\)/);
  assert.doesNotMatch(appSource, /formatMoney\(s\.profit \|\| 0\)[\s\S]{0,120}غير محتسب/);
  assert.match(salesLogSection, /<tbody id="salesLogBody"><\/tbody>/);
  assert.doesNotMatch(salesLogSection, /<thead><tr><th>#<\/th><th>التاريخ<\/th>/);
  assert.match(appSource, /function getSalesColumnHeaderRowHtml\(\)/);
  assert.match(appSource, /<th>نسبة الربح<\/th><th>الملاحظات<\/th>/);
  assert.match(stylesSource, /#salesLogBody \.sale-inactive td/);
});
