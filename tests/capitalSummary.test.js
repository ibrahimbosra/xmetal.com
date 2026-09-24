const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync(require.resolve('../js/capitalSummary.js'), 'utf8');
const context = {
  window: {
    firebase: { firestore: { FieldValue: { increment: value => ({ increment: value }) } } },
    firebaseDb: { collection: () => ({ doc: () => ({}) }) }
  }
};
vm.runInNewContext(source, context);
const capital = context.window.XMetalCapitalSummary;

const noBatch = { id: 'no-batch', purchasePrice: 10, quantity: 3 };
const withBatches = {
  id: 'batches',
  purchasePrice: 999,
  quantity: 5,
  purchaseBatches: [
    { quantity: 2, unitCost: 4 },
    { quantity: 3, unitCost: 7 }
  ]
};

assert.strictEqual(capital.itemCapital(noBatch), 30);
assert.strictEqual(capital.itemCapital(withBatches), 29);
assert.strictEqual(capital.itemCapital({ purchasePrice: 10, quantity: 0 }), 0);
assert.strictEqual(capital.itemCapital({ purchasePrice: 10, quantity: -2 }), 0);
assert.strictEqual(capital.itemCount({ quantity: 0 }), 0);
assert.strictEqual(capital.itemCount({ quantity: 3 }), 1);
assert.strictEqual(capital.itemCount({ quantity: -1 }), 0);

capital.applyState({ totalCapital: 100, totalCapitalItemCount: 2, totalCapitalVersion: 1 });

function captureDelta(beforeItem, afterItem) {
  const writes = [];
  const tx = { set: (ref, payload, options) => writes.push({ ref, payload, options }) };
  const result = capital.applyDeltaInTransaction(tx, beforeItem, afterItem);
  return { result, write: writes[0] };
}

assert.strictEqual(captureDelta(null, { purchasePrice: 10, quantity: 3 }).result.capitalDelta, 30);
assert.strictEqual(captureDelta(null, { purchasePrice: 10, quantity: 3 }).result.itemCountDelta, 1);
assert.strictEqual(captureDelta({ purchasePrice: 10, quantity: 3 }, { purchasePrice: 10, quantity: 5 }).result.capitalDelta, 20);
assert.strictEqual(captureDelta({ purchasePrice: 10, quantity: 3 }, { purchasePrice: 10, quantity: 5 }).result.itemCountDelta, 0);
assert.strictEqual(captureDelta({ purchasePrice: 10, quantity: 5 }, { purchasePrice: 10, quantity: 2 }).result.capitalDelta, -30);
assert.strictEqual(captureDelta({ purchasePrice: 10, quantity: 5 }, { purchasePrice: 10, quantity: 2 }).result.itemCountDelta, 0);
assert.strictEqual(captureDelta({ purchasePrice: 10, quantity: 5 }, { purchasePrice: 12, quantity: 5 }).result.capitalDelta, 10);
assert.strictEqual(captureDelta({ purchasePrice: 10, quantity: 5 }, { purchasePrice: 12, quantity: 5 }).result.itemCountDelta, 0);
assert.strictEqual(captureDelta({ purchasePrice: 10, quantity: 5 }, withBatches).result.capitalDelta, -21);
assert.strictEqual(captureDelta({ purchasePrice: 10, quantity: 5 }, withBatches).result.itemCountDelta, 0);
assert.strictEqual(captureDelta(withBatches, { id: 'batches', purchasePrice: 999, quantity: 2, purchaseBatches: [{ quantity: 2, unitCost: 4 }] }).result.capitalDelta, -21);
assert.strictEqual(captureDelta({ purchasePrice: 10, quantity: 2 }, { purchasePrice: 10, quantity: 4 }).result.capitalDelta, 20);
assert.strictEqual(captureDelta({ purchasePrice: 10, quantity: 4 }, { purchasePrice: 10, quantity: 2 }).result.capitalDelta, -20);
assert.strictEqual(captureDelta({ purchasePrice: 10, quantity: 4 }, null).result.capitalDelta, -40);
assert.strictEqual(captureDelta({ purchasePrice: 10, quantity: 4 }, null).result.itemCountDelta, -1);
assert.strictEqual(captureDelta({ purchasePrice: 10, quantity: 0 }, { purchasePrice: 10, quantity: 4 }).result.itemCountDelta, 1);
assert.strictEqual(captureDelta({ purchasePrice: 10, quantity: 4 }, { purchasePrice: 10, quantity: 0 }).result.itemCountDelta, -1);
assert.strictEqual(captureDelta({ purchasePrice: 10, quantity: 0 }, { purchasePrice: 10, quantity: 4 }).result.capitalDelta, 40);

const batchWrite = captureDelta({ purchasePrice: 10, quantity: 0 }, { purchasePrice: 10, quantity: 2 });
assert.deepStrictEqual(batchWrite.write.payload.totalCapital, { increment: 20 });
assert.deepStrictEqual(batchWrite.write.payload.totalCapitalItemCount, { increment: 1 });
assert.deepStrictEqual(batchWrite.write.payload.totalCapitalVersion, { increment: 1 });

const deleteWrite = captureDelta({ purchasePrice: 10, quantity: 2 }, null);
assert.deepStrictEqual(deleteWrite.write.payload.totalCapital, { increment: -20 });
assert.deepStrictEqual(deleteWrite.write.payload.totalCapitalItemCount, { increment: -1 });

const appSource = fs.readFileSync(require.resolve('../js/app.js'), 'utf8');
const mobileSource = fs.readFileSync(require.resolve('../js/mobile-sales.js'), 'utf8');
assert.match(appSource, /XMetalCapitalSummary\.ensureInitialized\(db, allItems\)/);
assert.match(appSource, /XMetalCapitalSummary\.applyDeltaInTransaction\(tx, null, newItem\)/);
assert.match(appSource, /XMetalCapitalSummary\.applyDeltaInTransaction\(tx, previousItem, updatedItem\)/);
assert.match(appSource, /XMetalCapitalSummary\.applyDeltaInTransaction\(tx, beforeItem, null\)/);
assert.match(appSource, /var totalCapital = capitalSummary\.available \? capitalSummary\.totalCapital : null;/);
assert.match(mobileSource, /XMetalCapitalSummary\.ensureInitialized\(db, items\)/);
assert.ok((mobileSource.match(/XMetalCapitalSummary\.applyDeltaInTransaction/g) || []).length >= 5);
assert.match(mobileSource, /DailySalesSummary\.applySaleMutationInTransaction\(tx, null, sale, 'create'\)/);
assert.match(appSource, /summaryContext: summaryContext/);
assert.match(appSource, /DailySalesSummary\.applySaleMutationInTransaction\(tx, current, entry\.summaryContext\.nextSale/);

console.log('capital summary tests passed');
