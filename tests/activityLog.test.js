const assert = require('assert');
const fs = require('fs');
const path = require('path');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(__dirname, '..', 'css', 'styles.css'), 'utf8');
const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

assert.ok(appSource.includes('function getActivityDateSeparatorRowHtml'), 'activity log should use a dedicated date-only separator row');
assert.ok(!appSource.includes('getDateSeparatorRowHtml(item.timestamp, 7)'), 'activity log should not reuse the sales summary separator row');
assert.ok(!appSource.includes('prodSearchInput'), 'product details section should not keep its own search box logic');
assert.ok(!indexSource.includes('prodSearchInput'), 'product details section should not render a search box');
assert.ok(cssSource.includes('overflow-wrap: break-word') && cssSource.includes('word-break: normal'), 'product names should wrap at word boundaries instead of breaking letters apart on mobile');
assert.ok(!indexSource.includes('chartDailyProfit') && !indexSource.includes('chartPieProfit') && !indexSource.includes('chartMonthlySales') && !indexSource.includes('chartTopProducts') && !indexSource.includes('chartTopCategories'), 'dashboard should not render the removed chart widgets');
assert.ok(cssSource.includes('aspect-ratio: 1 / 1') || cssSource.includes('aspect-ratio: 1/1'), 'dashboard stat cards should remain square on small screens');
assert.ok(appSource.includes('saveMainDebtCustomer') && appSource.includes('mainDebtCustomerModal'), 'debt section should include a new customer form and save action');
assert.ok(indexSource.includes('mainAddDebtCustomerBtn') && indexSource.includes('mainDebtCustomerForm'), 'debt section should render the add-customer button and form');

console.log('activity log separator checks passed');
