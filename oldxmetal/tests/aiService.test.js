const test = require('node:test');
const assert = require('node:assert/strict');

const { buildContextSummary } = require('../js/aiService.js');

test('buildContextSummary flags low stock and stale products', () => {
  const summary = buildContextSummary({
    items: [
      {
        id: 'item-1',
        name: 'فلتر هواء',
        quantity: 2,
        purchasePrice: 100,
        salePrice: 150,
        categoryId: 'cat-1'
      },
      {
        id: 'item-2',
        name: 'زيت محرك',
        quantity: 25,
        purchasePrice: 80,
        salePrice: 120,
        categoryId: 'cat-2'
      }
    ],
    sales: [
      {
        itemId: 'item-2',
        totalAmount: 240,
        profit: 40,
        timestamp: Date.now() - 2 * 24 * 60 * 60 * 1000
      }
    ],
    expenses: [
      { amount: 250, date: Date.now() - 24 * 60 * 60 * 1000 }
    ],
    debts: [],
    customers: [],
    purchases: [],
    categories: [{ id: 'cat-1', name: 'الزيوت' }],
    storeInfo: { name: 'X METAL' },
    currencySettings: { secondaryCurrencySymbol: '﷼' }
  });

  assert.equal(summary.lowStock.length, 1);
  assert.equal(summary.lowStock[0].id, 'item-1');
  assert.equal(summary.staleProducts.length, 1);
  assert.equal(summary.staleProducts[0].id, 'item-1');
  assert.equal(summary.summaryText.includes('فلتر هواء'), true);
});
