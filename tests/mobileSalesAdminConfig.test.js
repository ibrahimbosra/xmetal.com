const assert = require('assert');
const fs = require('fs');
const path = require('path');

const mobileSalesSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'mobile-sales.js'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
const pageSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

assert.ok(mobileSalesSource.includes('settings').doc || mobileSalesSource.includes('mobileSalesAdmin'), 'mobile sales should read the configured admin account from existing settings');
assert.ok(mobileSalesSource.includes('admin-only') || mobileSalesSource.includes('.admin-only'), 'mobile sales should support admin-only visibility classes');
assert.ok(appSource.includes('mobileSalesAdmin') || appSource.includes('mobileSalesAdminAccount'), 'system settings should include the admin account selector');
assert.ok(pageSource.includes('mobileSalesAdminAccountSelect') || pageSource.includes('mobileSalesAdminAccountForm'), 'system settings page should expose the admin account selector UI');
assert.ok(pageSource.includes('userDisplayNamesForm') && pageSource.includes('userDisplayNamesText'), 'system settings page should expose the user display names panel');
assert.ok(!pageSource.includes('storeInfoForm') && !pageSource.includes('currencySettingsForm') && !pageSource.includes('CurrencyName') && !pageSource.includes('showProductPrices') && !pageSource.includes('enablePurchaseBatches'), 'system settings should not expose store info or currency configuration rows');
assert.ok(mobileSalesSource.includes('is-ended') || mobileSalesSource.includes('out-of-stock') || mobileSalesSource.includes('stock <= 0'), 'mobile sales should flag ended products with a visual state');

console.log('mobile sales admin config checks passed');
