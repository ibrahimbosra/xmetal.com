const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'mobile-sales.js'), 'utf8');

assert.ok(!source.includes('queueMobileSaleOperation'), 'mobile sales sales queueing must be removed');
assert.ok(!source.includes('queueDebtOperation'), 'debt queueing must be removed');
assert.ok(!source.includes('queueMobileActivity'), 'activity queueing must be removed');
assert.ok(!source.includes('flushPendingSalesQueue'), 'pending sales flush must be removed');
assert.ok(!source.includes('flushPendingDebtQueue'), 'pending debt flush must be removed');
assert.ok(!source.includes('flushPendingMobileActivityQueue'), 'pending activity flush must be removed');
assert.ok(!source.includes('xmetal_mobile_sales_pending_v1'), 'sales queue localStorage key must be removed');
assert.ok(!source.includes('xmetal_mobile_debt_pending_v1'), 'debt queue localStorage key must be removed');
assert.ok(!source.includes('xmetal_mobile_activity_pending_v1'), 'activity queue localStorage key must be removed');
assert.ok(!source.includes("window.addEventListener('online'"), 'online retry listeners must be removed');
assert.ok(!source.includes("navigator.serviceWorker.register('mobile-sales-sw.js')"), 'service worker registration must be removed for mobile sales');
assert.ok(!source.includes('saveCache()'), 'cache persistence must not be used for mobile sales state');
assert.ok(!source.includes('restoreCache()'), 'cache restore must not be used for mobile sales state');
