const assert = require('assert');
const fs = require('fs');

const source = fs.readFileSync(require.resolve('../js/app.js'), 'utf8');

const initBlock = source.match(/async function initApp\(\) \{[\s\S]*?\n\}/);
assert.ok(initBlock, 'initApp should exist');
assert.doesNotMatch(initBlock[0], /fetchItemsSmart\(\)/, 'initApp must not fetch items from Firestore cache during global initialization');
assert.match(source, /function restoreItemsFromLocalCache\(\)/);
assert.match(source, /function ensureItemsRealtimeListener\(\)/);
assert.match(source, /db\.collection\('items'\)\.onSnapshot/);
assert.match(source, /realtimeListeners\.push\(unsubItems\)/);
assert.match(source, /function sectionNeedsFullItems\(section\)/);
assert.match(source, /\['inventory', 'addItem', 'salesLog', 'productAnalytics', 'insights', 'categories'\]/);
assert.match(source, /if \(sectionNeedsFullItems\(currentSection\)\)/);
assert.match(source, /if \(itemsListenerStarted\) return itemsListenerReadyPromise/);
assert.match(source, /itemsListenerStarted = false/);
assert.match(source, /commitItemUpdate\(newItem\)/);

console.log('items listener lifecycle tests passed');
