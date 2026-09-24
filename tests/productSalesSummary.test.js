const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadProductSalesSummaryModule(fakeDb) {
  const source = fs.readFileSync(path.join(__dirname, '../js/productSalesSummary.js'), 'utf8');
  const context = {
    window: {
      firebaseDb: fakeDb || null,
      console: console,
      Date: Date,
      Number: Number,
      Math: Math,
      Object: Object,
      Array: Array,
      JSON: JSON,
      setTimeout: setTimeout,
      clearTimeout: clearTimeout
    },
    console: console,
    Date: Date,
    Number: Number,
    Math: Math,
    Object: Object,
    Array: Array,
    JSON: JSON,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    navigator: { onLine: true }
  };
  context.window.globalThis = context;
  vm.runInNewContext(source, context);
  return context.window.ProductSalesSummary;
}

test('productSalesSummary persists an item-level aggregate and adjusts it on updates', async () => {
  const storage = new Map();
  const fakeDb = {
    collection: function(name) {
      return {
        doc: function(id) {
          return {
            async get() {
              const key = name + ':' + id;
              return {
                exists: storage.has(key),
                data: function() {
                  return storage.get(key) || null;
                }
              };
            },
            async set(data) {
              const key = name + ':' + id;
              storage.set(key, data);
              return data;
            }
          };
        }
      };
    }
  };

  const ProductSalesSummary = loadProductSalesSummaryModule(fakeDb);
  assert.ok(ProductSalesSummary, 'ProductSalesSummary should be available');

  const sale = {
    itemId: 'item-1',
    itemName: 'Product 1',
    quantity: 2,
    totalAmount: 100,
    profit: 20,
    timestamp: 1720000000000
  };

  const created = await ProductSalesSummary.applySaleCreate(sale);
  assert.ok(created);
  assert.equal(created.totalSales, 100);
  assert.equal(created.totalProfit, 20);
  assert.equal(created.salesCount, 1);
  assert.equal(created.totalQuantity, 2);

  const updated = await ProductSalesSummary.applySaleUpdate(sale, {
    ...sale,
    quantity: 3,
    totalAmount: 150,
    profit: 30,
    timestamp: 1720000000000
  });

  assert.ok(updated);
  assert.equal(updated.totalSales, 150);
  assert.equal(updated.totalProfit, 30);
  assert.equal(updated.totalQuantity, 3);
  assert.equal(updated.salesCount, 1);
});

test('product sales summary is deferred until product analytics is entered', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');

  assert.doesNotMatch(appSource, /await\s+loadProductSalesSummary\(\)\s*;/);
  assert.match(appSource, /async function ensureProductSalesSummaryLoaded\s*\(/);
  assert.match(appSource, /currentSection\s*===\s*'productAnalytics'/);
});
