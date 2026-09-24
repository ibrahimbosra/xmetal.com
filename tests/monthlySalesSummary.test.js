const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadMonthlySalesSummaryModule(fakeDb) {
  const source = fs.readFileSync(path.join(__dirname, '../js/monthlySalesSummary.js'), 'utf8');
  const context = {
    window: { firebaseDb: fakeDb || null, console: console },
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
  return context.window.MonthlySalesSummary;
}

function createFakeDb(storage) {
  return {
    collection: function(name) {
      return {
        doc: function(id) {
          const key = name + ':' + id;
          return {
            async get() {
              return {
                exists: storage.has(key),
                data: function() {
                  return storage.get(key) || null;
                }
              };
            },
            async set(data) {
              storage.set(key, data);
              return data;
            },
            async delete() {
              storage.delete(key);
            }
          };
        },
        async get() {
          const docs = [];
          for (const [key, value] of storage.entries()) {
            if (key.startsWith(name + ':')) {
              const id = key.slice(name.length + 1);
              docs.push({ id: id, data: function() { return value; }, exists: true });
            }
          }
          return { docs: docs };
        }
      };
    }
  };
}

test('monthly sales summary applies sale create, update, delete and month move deltas correctly', async () => {
  const storage = new Map();
  const MonthlySalesSummary = loadMonthlySalesSummaryModule(createFakeDb(storage));

  const janSale = {
    id: 'sale-jan',
    itemId: 'item-1',
    itemName: 'Brake Pad',
    timestamp: new Date('2026-01-15T00:00:00Z').getTime(),
    quantity: 2,
    totalAmount: 200,
    profit: 40,
    purchasePriceAtTime: 80
  };

  await MonthlySalesSummary.applySaleCreate(janSale);
  let janSummary = await MonthlySalesSummary.readSummary('2026-01');
  assert.equal(janSummary.salesCount, 1);
  assert.equal(janSummary.totalQuantity, 2);
  assert.equal(janSummary.totalSales, 200);
  assert.equal(janSummary.totalCost, 160);
  assert.equal(janSummary.totalProfit, 40);
  assert.equal(janSummary.expenses, 0);

  const updatedSameMonthSale = {
    ...janSale,
    quantity: 3,
    totalAmount: 300,
    profit: 60,
    purchasePriceAtTime: 90
  };
  await MonthlySalesSummary.applySaleUpdate(janSale, updatedSameMonthSale);
  janSummary = await MonthlySalesSummary.readSummary('2026-01');
  assert.equal(janSummary.salesCount, 1);
  assert.equal(janSummary.totalQuantity, 3);
  assert.equal(janSummary.totalSales, 300);
  assert.equal(janSummary.totalCost, 270);
  assert.equal(janSummary.totalProfit, 60);

  const movedSale = {
    ...updatedSameMonthSale,
    id: 'sale-moved',
    timestamp: new Date('2026-02-05T00:00:00Z').getTime(),
    quantity: 1,
    totalAmount: 120,
    profit: 25,
    purchasePriceAtTime: 95
  };
  await MonthlySalesSummary.applySaleUpdate(updatedSameMonthSale, movedSale);
  janSummary = await MonthlySalesSummary.readSummary('2026-01');
  assert.equal(janSummary.salesCount, 0);
  assert.equal(janSummary.totalQuantity, 0);
  assert.equal(janSummary.totalSales, 0);
  assert.equal(janSummary.totalCost, 0);
  assert.equal(janSummary.totalProfit, 0);

  const febSummary = await MonthlySalesSummary.readSummary('2026-02');
  assert.equal(febSummary.salesCount, 1);
  assert.equal(febSummary.totalQuantity, 1);
  assert.equal(febSummary.totalSales, 120);
  assert.equal(febSummary.totalCost, 95);
  assert.equal(febSummary.totalProfit, 25);

  await MonthlySalesSummary.applySaleDelete(movedSale);
  const febAfterDelete = await MonthlySalesSummary.readSummary('2026-02');
  assert.equal(febAfterDelete.salesCount, 0);
  assert.equal(febAfterDelete.totalQuantity, 0);
  assert.equal(febAfterDelete.totalSales, 0);
  assert.equal(febAfterDelete.totalCost, 0);
  assert.equal(febAfterDelete.totalProfit, 0);

  await MonthlySalesSummary.applySaleRestore(movedSale);
  const febAfterRestore = await MonthlySalesSummary.readSummary('2026-02');
  assert.equal(febAfterRestore.salesCount, 1);
  assert.equal(febAfterRestore.totalQuantity, 1);
  assert.equal(febAfterRestore.totalSales, 120);
  assert.equal(febAfterRestore.totalCost, 95);
  assert.equal(febAfterRestore.totalProfit, 25);
});

test('monthly sales summary applies expense create, update and delete deltas in the same month and across months', async () => {
  const storage = new Map();
  const MonthlySalesSummary = loadMonthlySalesSummaryModule(createFakeDb(storage));

  const janExpense = {
    id: 'exp-jan',
    amount: 120,
    date: new Date('2026-01-10T00:00:00Z').getTime(),
    description: 'Rent'
  };

  await MonthlySalesSummary.applyExpenseCreate(janExpense);
  let janSummary = await MonthlySalesSummary.readSummary('2026-01');
  assert.equal(janSummary.expenses, 120);

  const updatedJanExpense = {
    ...janExpense,
    amount: 170,
    date: new Date('2026-01-18T00:00:00Z').getTime(),
    description: 'Updated rent'
  };
  await MonthlySalesSummary.applyExpenseUpdate(janExpense, updatedJanExpense);
  janSummary = await MonthlySalesSummary.readSummary('2026-01');
  assert.equal(janSummary.expenses, 170);

  const movedExpense = {
    ...updatedJanExpense,
    id: 'exp-feb',
    amount: 90,
    date: new Date('2026-02-03T00:00:00Z').getTime(),
    description: 'February rent'
  };
  await MonthlySalesSummary.applyExpenseUpdate(updatedJanExpense, movedExpense);
  janSummary = await MonthlySalesSummary.readSummary('2026-01');
  assert.equal(janSummary.expenses, 0);

  const febSummary = await MonthlySalesSummary.readSummary('2026-02');
  assert.equal(febSummary.expenses, 90);

  await MonthlySalesSummary.applyExpenseDelete(movedExpense);
  const febAfterDelete = await MonthlySalesSummary.readSummary('2026-02');
  assert.equal(febAfterDelete.expenses, 0);

  await MonthlySalesSummary.applyExpenseRestore(movedExpense);
  const febAfterRestore = await MonthlySalesSummary.readSummary('2026-02');
  assert.equal(febAfterRestore.expenses, 90);
});
