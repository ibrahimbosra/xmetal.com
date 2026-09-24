const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadDailySalesSummaryModule(fakeDb) {
  const source = fs.readFileSync(path.join(__dirname, '../js/dailySalesSummary.js'), 'utf8');
  const context = {
    window: { firebaseDb: fakeDb || null, firebase: { firestore: { FieldValue: { increment: value => ({ increment: value }) } } }, console: console },
    console: console,
    Date: Date,
    Number: Number,
    Math: Math,
    Object: Object,
    Array: Array,
    JSON: JSON,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout
  };
  context.window.globalThis = context;
  vm.runInNewContext(source, context);
  return context.window.DailySalesSummary;
}

function createFakeDb(storage) {
  function makeDoc(name, id) {
    const key = name + ':' + id;
    return {
      key,
      async get() {
        return {
          exists: storage.has(key),
          data: function() {
            return storage.get(key) || null;
          }
        };
      },
      set(data) {
        storage.set(key, data);
        return Promise.resolve(data);
      },
      delete() {
        storage.delete(key);
        return Promise.resolve();
      },
      collection(childName) {
        return { doc: childId => makeDoc(name + ':' + id + ':' + childName, childId) };
      }
    };
  }
  return {
    collection: function(name) {
      return {
        doc: function(id) {
          return makeDoc(name, id);
        }
      };
    },
    async runTransaction(callback) {
      const writes = [];
      const tx = {
        get: ref => ref.get(),
        set: (ref, data, options) => writes.push(() => {
          const current = storage.get(ref.key) || {};
          const next = options && options.merge ? { ...current, ...data } : data;
          Object.keys(next).forEach(key => {
            if (next[key] && typeof next[key] === 'object' && Object.prototype.hasOwnProperty.call(next[key], 'increment')) {
              next[key] = Number(current[key] || 0) + Number(next[key].increment || 0);
            }
          });
          return ref.set(next);
        }),
        update: (ref, data) => writes.push(() => ref.set({ ...(storage.get(ref.key) || {}), ...data })),
        delete: ref => writes.push(() => ref.delete())
      };
      const result = await callback(tx);
      for (const write of writes) await write();
      return result;
    }
  };
}

test('daily sales summary tracks totalCost for create, same-day update, cross-day update, delete and restore', async () => {
  const storage = new Map();
  const DailySalesSummary = loadDailySalesSummaryModule(createFakeDb(storage));

  const firstSale = {
    id: 'sale-1',
    timestamp: new Date('2026-01-15T12:00:00Z').getTime(),
    quantity: 2,
    totalAmount: 200,
    purchasePriceAtTime: 80,
    profit: 40
  };

  await DailySalesSummary.applySaleCreate(firstSale);
  let summary = await DailySalesSummary.readSummary('2026-01-15');
  assert.equal(summary.totalSales, 200);
  assert.equal(summary.totalCost, 160);
  assert.equal(summary.totalProfit, 40);
  assert.equal(summary.salesCount, 1);
  assert.equal(summary.totalQuantity, 2);

  const updatedSameDay = {
    ...firstSale,
    quantity: 3,
    totalAmount: 300,
    purchasePriceAtTime: 90,
    profit: 60
  };

  await DailySalesSummary.applySaleUpdate(firstSale, updatedSameDay);
  summary = await DailySalesSummary.readSummary('2026-01-15');
  assert.equal(summary.totalSales, 300);
  assert.equal(summary.totalCost, 270);
  assert.equal(summary.totalProfit, 60);
  assert.equal(summary.salesCount, 1);
  assert.equal(summary.totalQuantity, 3);

  const movedToNextDay = {
    ...updatedSameDay,
    id: 'sale-2',
    timestamp: new Date('2026-01-16T12:00:00Z').getTime(),
    quantity: 1,
    totalAmount: 120,
    purchasePriceAtTime: 95,
    profit: 25
  };

  await DailySalesSummary.applySaleUpdate(updatedSameDay, movedToNextDay);
  summary = await DailySalesSummary.readSummary('2026-01-15');
  assert.equal(summary.totalSales, 0);
  assert.equal(summary.totalCost, 0);
  assert.equal(summary.totalProfit, 0);
  assert.equal(summary.salesCount, 0);
  assert.equal(summary.totalQuantity, 0);

  const nextDaySummary = await DailySalesSummary.readSummary('2026-01-16');
  assert.equal(nextDaySummary.totalSales, 120);
  assert.equal(nextDaySummary.totalCost, 95);
  assert.equal(nextDaySummary.totalProfit, 25);
  assert.equal(nextDaySummary.salesCount, 1);
  assert.equal(nextDaySummary.totalQuantity, 1);

  await DailySalesSummary.applySaleDelete(movedToNextDay);
  const afterDelete = await DailySalesSummary.readSummary('2026-01-16');
  assert.equal(afterDelete.totalSales, 0);
  assert.equal(afterDelete.totalCost, 0);
  assert.equal(afterDelete.totalProfit, 0);

  await DailySalesSummary.applySaleCreate(movedToNextDay);
  const afterRestore = await DailySalesSummary.readSummary('2026-01-16');
  assert.equal(afterRestore.totalSales, 120);
  assert.equal(afterRestore.totalCost, 95);
  assert.equal(afterRestore.totalProfit, 25);
});

test('daily sales summary is idempotent and uses Riyadh day boundaries', async () => {
  const storage = new Map();
  const DailySalesSummary = loadDailySalesSummaryModule(createFakeDb(storage));
  const sale = {
    saleId: 'retry-sale',
    timestamp: Date.parse('2026-01-15T20:59:00Z'),
    quantity: 1,
    totalAmount: 10,
    purchasePriceAtTime: 4,
    profit: 6
  };

  assert.equal(DailySalesSummary.toDayKey(Date.parse('2026-01-15T20:59:00Z')), '2026-01-15');
  assert.equal(DailySalesSummary.toDayKey(Date.parse('2026-01-15T21:00:00Z')), '2026-01-16');
  await DailySalesSummary.applySaleCreate(sale);
  await DailySalesSummary.applySaleCreate(sale);
  const summary = await DailySalesSummary.readSummary('2026-01-15');
  assert.equal(summary.totalSales, 10);
  assert.equal(summary.salesCount, 1);
});

test('revision-aware projection replaces a sale contribution and ignores stale revisions', async () => {
  const storage = new Map();
  const fakeDb = createFakeDb(storage);
  const DailySalesSummary = loadDailySalesSummaryModule(fakeDb);
  const day = '2026-01-15';
  const saleV1 = { saleId: 'revision-sale', timestamp: Date.parse('2026-01-15T12:00:00Z'), saleRevision: 1, quantity: 1, totalAmount: 10, purchasePriceAtTime: 4, profit: 6 };
  const saleV2 = { ...saleV1, saleRevision: 2, totalAmount: 17, profit: 13 };
  await fakeDb.runTransaction(async tx => {
    await DailySalesSummary.applySaleMutationInTransaction(tx, null, saleV1, 'create');
    tx.set(fakeDb.collection('sales').doc(saleV1.saleId), saleV1);
  });
  await fakeDb.runTransaction(async tx => {
    await DailySalesSummary.applySaleMutationInTransaction(tx, saleV1, saleV2, 'update');
    tx.set(fakeDb.collection('sales').doc(saleV1.saleId), saleV2);
  });
  await fakeDb.runTransaction(async tx => {
    const result = await DailySalesSummary.applySaleMutationInTransaction(tx, saleV1, saleV1, 'update');
    assert.equal(result.status, 'stale');
  });
  await fakeDb.runTransaction(async tx => {
    const result = await DailySalesSummary.applySaleMutationInTransaction(tx, saleV1, saleV2, 'update');
    assert.equal(result.status, 'duplicate');
  });
  const summary = await DailySalesSummary.readSummary(day);
  assert.equal(summary.totalSales, 17);
  assert.equal(summary.salesCount, 1);
  const state = storage.get('dailySales:' + day + ':saleStates:' + saleV1.saleId);
  assert.equal(state.saleRevision, 2);
  assert.equal(state.totalSales, 17);
  assert.equal(storage.get('stats:totals').allTimeProfit, 13);
});

test('active-sale helper matches projection and excludes inactive contributions', async () => {
  const storage = new Map();
  const fakeDb = createFakeDb(storage);
  const DailySalesSummary = loadDailySalesSummaryModule(fakeDb);
  const day = '2026-01-15';
  const activeSale = { saleId: 'inactive-sale', timestamp: Date.parse('2026-01-15T12:00:00Z'), saleRevision: 1, quantity: 1, totalAmount: 10, purchasePriceAtTime: 4, profit: 6 };
  const cancelledSale = { ...activeSale, saleRevision: 2, status: 'cancelled', cancelled: true, isCancelled: true };

  assert.equal(DailySalesSummary.isSaleActive(activeSale), true);
  assert.equal(DailySalesSummary.isSaleActive(cancelledSale), false);
  assert.equal(DailySalesSummary.isSaleActive({ ...activeSale, status: 'returned' }), false);
  assert.equal(DailySalesSummary.isSaleActive({ ...activeSale, status: 'refunded' }), false);

  await fakeDb.runTransaction(async tx => {
    await DailySalesSummary.applySaleMutationInTransaction(tx, null, activeSale, 'create');
  });
  await fakeDb.runTransaction(async tx => {
    await DailySalesSummary.applySaleMutationInTransaction(tx, activeSale, cancelledSale, 'cancel');
  });

  const summary = await DailySalesSummary.readSummary(day);
  assert.equal(summary.totalProfit, 0);
  assert.equal(summary.salesCount, 0);
  assert.equal(storage.get('stats:totals').allTimeProfit, 0);
  assert.equal(storage.get('dailySales:' + day + ':saleStates:' + activeSale.saleId).totalProfit, 0);
});
