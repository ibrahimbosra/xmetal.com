const test = require('node:test');
const assert = require('node:assert/strict');
const AnalyticsHelpers = require('../js/analyticsHelpers');

test('builds lazy profit summary from the first to the last sale', () => {
  const sales = [
    { timestamp: 1704067200000, totalAmount: 100, profit: 20, quantity: 1 },
    { timestamp: 1704153600000, totalAmount: 150, profit: 30, quantity: 2 },
    { timestamp: 1704240000000, totalAmount: 200, profit: 40, quantity: 1 }
  ];
  const expenses = [
    { date: 1704067200000, amount: 10 },
    { date: 1704240000000, amount: 5 }
  ];

  const summary = AnalyticsHelpers.buildLazyProfitSummary(sales, expenses);

  assert.equal(summary.salesCount, 3);
  assert.equal(summary.grossProfit, 90);
  assert.equal(summary.netProfit, 75);
  assert.equal(summary.firstSaleTimestamp, 1704067200000);
  assert.equal(summary.lastSaleTimestamp, 1704240000000);
});

test('builds month stats for the actual activity window inside the month', () => {
  const sales = [
    { timestamp: 1704067200000, totalAmount: 100, profit: 20, quantity: 1 },
    { timestamp: 1704153600000, totalAmount: 150, profit: 30, quantity: 2 },
    { timestamp: 1706745600000, totalAmount: 300, profit: 60, quantity: 3 }
  ];

  const monthStats = AnalyticsHelpers.buildMonthStats(sales, '2024-01', []);

  assert.equal(monthStats.salesCount, 2);
  assert.equal(monthStats.grossProfit, 50);
  assert.equal(monthStats.revenue, 250);
});
