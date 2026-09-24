const test = require('node:test');
const assert = require('node:assert/strict');
const AnalyticsHelpers = require('../js/analyticsHelpers');

function buildRangeFromSales(sales, start, end) {
  return sales.reduce(function(result, sale) {
    var ts = Number(sale && sale.timestamp) || 0;
    if (ts >= start && ts < end) {
      result.salesCount += 1;
      result.totalSales += Number(sale.totalAmount) || 0;
      result.totalCost += Number(sale.purchasePriceAtTime || 0) * Number(sale.quantity || 0);
      result.totalProfit += Number(sale.profit) || 0;
      result.totalQuantity += Number(sale.quantity) || 0;
    }
    return result;
  }, {
    salesCount: 0,
    totalSales: 0,
    totalCost: 0,
    totalProfit: 0,
    totalQuantity: 0
  });
}

function buildDailySummaries(sales) {
  return sales.reduce(function(map, sale) {
    var ts = Number(sale && sale.timestamp) || 0;
    if (!ts) return map;
    var date = new Date(ts);
    var dayKey = date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
    var existing = map[dayKey] || { totalSales: 0, totalCost: 0, totalProfit: 0, salesCount: 0, totalQuantity: 0 };
    existing.totalSales += Number(sale.totalAmount) || 0;
    existing.totalCost += (Number(sale.purchasePriceAtTime || 0) * Number(sale.quantity || 0));
    existing.totalProfit += Number(sale.profit) || 0;
    existing.salesCount += 1;
    existing.totalQuantity += Number(sale.quantity) || 0;
    map[dayKey] = existing;
    return map;
  }, {});
}

function buildMonthlySummaries(sales) {
  return sales.reduce(function(map, sale) {
    var ts = Number(sale && sale.timestamp) || 0;
    if (!ts) return map;
    var date = new Date(ts);
    var monthKey = date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
    var existing = map[monthKey] || { totalSales: 0, totalCost: 0, totalProfit: 0, salesCount: 0, totalQuantity: 0, expenses: 0 };
    existing.totalSales += Number(sale.totalAmount) || 0;
    existing.totalCost += (Number(sale.purchasePriceAtTime || 0) * Number(sale.quantity || 0));
    existing.totalProfit += Number(sale.profit) || 0;
    existing.salesCount += 1;
    existing.totalQuantity += Number(sale.quantity) || 0;
    map[monthKey] = existing;
    return map;
  }, {});
}

function buildExpenseRange(expenses, start, end) {
  return (expenses || []).reduce(function(total, expense) {
    var ts = Number(expense && expense.date) || 0;
    if (ts >= start && ts < end) {
      total += Number(expense.amount) || 0;
    }
    return total;
  }, 0);
}

const sales = [
  { timestamp: new Date('2024-08-01T09:00:00Z').getTime(), totalAmount: 100, purchasePriceAtTime: 60, quantity: 1, profit: 40 },
  { timestamp: new Date('2024-08-15T12:00:00Z').getTime(), totalAmount: 240, purchasePriceAtTime: 70, quantity: 2, profit: 100 },
  { timestamp: new Date('2024-08-31T12:00:00Z').getTime(), totalAmount: 180, purchasePriceAtTime: 65, quantity: 2, profit: 50 },
  { timestamp: new Date('2024-09-05T15:00:00Z').getTime(), totalAmount: 300, purchasePriceAtTime: 80, quantity: 3, profit: 60 },
  { timestamp: new Date('2024-09-20T17:00:00Z').getTime(), totalAmount: 120, purchasePriceAtTime: 50, quantity: 1, profit: 70 },
  { timestamp: new Date('2024-10-03T08:00:00Z').getTime(), totalAmount: 200, purchasePriceAtTime: 75, quantity: 2, profit: 50 },
  { timestamp: new Date('2024-10-09T10:00:00Z').getTime(), totalAmount: 110, purchasePriceAtTime: 45, quantity: 1, profit: 65 },
  { timestamp: new Date('2024-10-15T10:00:00Z').getTime(), totalAmount: 330, purchasePriceAtTime: 90, quantity: 3, profit: 60 },
  { timestamp: new Date('2025-01-02T10:00:00Z').getTime(), totalAmount: 500, purchasePriceAtTime: 200, quantity: 2, profit: 100 }
];

const expenses = [
  { date: new Date('2024-08-02T00:00:00Z').getTime(), amount: 25 },
  { date: new Date('2024-08-20T00:00:00Z').getTime(), amount: 30 },
  { date: new Date('2024-09-07T00:00:00Z').getTime(), amount: 40 },
  { date: new Date('2024-09-21T00:00:00Z').getTime(), amount: 15 },
  { date: new Date('2024-10-04T00:00:00Z').getTime(), amount: 20 },
  { date: new Date('2025-01-04T00:00:00Z').getTime(), amount: 90 }
];

const dailySummaries = buildDailySummaries(sales);
const monthlySummaries = buildMonthlySummaries(sales);

test('builds lazy profit summary from the first to the last sale', () => {
 const salesList = [
  { timestamp: 1704067200000, totalAmount: 100, profit: 20, quantity: 1 },
  { timestamp: 1704153600000, totalAmount: 150, profit: 30, quantity: 2 },
  { timestamp: 1704240000000, totalAmount: 200, profit: 40, quantity: 1 }
 ];
 const expensesList = [
  { date: 1704067200000, amount: 10 },
  { date: 1704240000000, amount: 5 }
 ];

 const summary = AnalyticsHelpers.buildLazyProfitSummary(salesList, expensesList);

 assert.equal(summary.salesCount, 3);
 assert.equal(summary.grossProfit, 90);
 assert.equal(summary.netProfit, 75);
 assert.equal(summary.firstSaleTimestamp, 1704067200000);
 assert.equal(summary.lastSaleTimestamp, 1704240000000);
});

test('builds month stats for the actual activity window inside the month', () => {
 const salesList = [
  { timestamp: 1704067200000, totalAmount: 100, profit: 20, quantity: 1 },
  { timestamp: 1704153600000, totalAmount: 150, profit: 30, quantity: 2 },
  { timestamp: 1706745600000, totalAmount: 300, profit: 60, quantity: 3 }
 ];

 const monthStats = AnalyticsHelpers.buildMonthStats(salesList, '2024-01', []);

 assert.equal(monthStats.salesCount, 2);
 assert.equal(monthStats.grossProfit, 50);
 assert.equal(monthStats.revenue, 250);
});

test('getSalesSummaryForRange matches one-day window to allSales data', () => {
  const start = new Date('2024-08-15T00:00:00Z').getTime();
  const end = new Date('2024-08-16T00:00:00Z').getTime();
  const expected = buildRangeFromSales(sales, start, end);
  const actual = AnalyticsHelpers.getSalesSummaryForRange(start, end, { dailySummaries, monthlySummaries });

  assert.deepEqual(actual, expected);
});

test('getSalesSummaryForRange matches a single-week range inside one month', () => {
  const start = new Date('2024-08-14T00:00:00Z').getTime();
  const end = new Date('2024-08-21T00:00:00Z').getTime();
  const expected = buildRangeFromSales(sales, start, end);
  const actual = AnalyticsHelpers.getSalesSummaryForRange(start, end, { dailySummaries, monthlySummaries });

  assert.deepEqual(actual, expected);
});

test('getSalesSummaryForRange matches a week crossing two months', () => {
  const start = new Date('2024-08-30T00:00:00Z').getTime();
  const end = new Date('2024-09-06T00:00:00Z').getTime();
  const expected = buildRangeFromSales(sales, start, end);
  const actual = AnalyticsHelpers.getSalesSummaryForRange(start, end, { dailySummaries, monthlySummaries });

  assert.deepEqual(actual, expected);
});

test('getSalesSummaryForRange matches a full month', () => {
  const start = new Date('2024-09-01T00:00:00Z').getTime();
  const end = new Date('2024-10-01T00:00:00Z').getTime();
  const expected = buildRangeFromSales(sales, start, end);
  const actual = AnalyticsHelpers.getSalesSummaryForRange(start, end, { dailySummaries, monthlySummaries });

  assert.deepEqual(actual, expected);
});

test('getSalesSummaryForRange matches a partial current month', () => {
  const start = new Date('2024-10-01T00:00:00Z').getTime();
  const end = new Date('2024-10-11T00:00:00Z').getTime();
  const expected = buildRangeFromSales(sales, start, end);
  const actual = AnalyticsHelpers.getSalesSummaryForRange(start, end, { dailySummaries, monthlySummaries });

  assert.deepEqual(actual, expected);
});

test('getSalesSummaryForRange matches a full year', () => {
  const start = new Date('2024-01-01T00:00:00Z').getTime();
  const end = new Date('2025-01-01T00:00:00Z').getTime();
  const expected = buildRangeFromSales(sales, start, end);
  const actual = AnalyticsHelpers.getSalesSummaryForRange(start, end, { dailySummaries, monthlySummaries });

  assert.deepEqual(actual, expected);
});

test('getSalesSummaryForRange matches a manual range inside one month', () => {
  const start = new Date('2024-08-10T00:00:00Z').getTime();
  const end = new Date('2024-08-20T00:00:00Z').getTime();
  const expected = buildRangeFromSales(sales, start, end);
  const actual = AnalyticsHelpers.getSalesSummaryForRange(start, end, { dailySummaries, monthlySummaries });

  assert.deepEqual(actual, expected);
});

test('getSalesSummaryForRange matches a mixed range using daily + monthly + daily', () => {
  const start = new Date('2024-08-15T00:00:00Z').getTime();
  const end = new Date('2024-10-10T00:00:00Z').getTime();
  const expected = buildRangeFromSales(sales, start, end);
  const actual = AnalyticsHelpers.getSalesSummaryForRange(start, end, { dailySummaries, monthlySummaries });

  assert.deepEqual(actual, expected);
});

test('getSalesSummaryForRange respects day and month boundary semantics', () => {
  const start = new Date('2024-09-05T00:00:00Z').getTime();
  const end = new Date('2024-09-06T00:00:00Z').getTime();
  const expected = buildRangeFromSales(sales, start, end);
  const actual = AnalyticsHelpers.getSalesSummaryForRange(start, end, { dailySummaries, monthlySummaries });

  assert.deepEqual(actual, expected);
});

test('getExpensesSum matches the same date-range semantics as the app', () => {
  const start = new Date('2024-08-01T00:00:00Z').getTime();
  const end = new Date('2024-10-10T00:00:00Z').getTime();
  const expected = buildExpenseRange(expenses, start, end);
  const actual = AnalyticsHelpers.getExpensesSum(start, end, expenses);

  assert.equal(actual, expected);
});

test('collectSummaryReadPlan splits mixed ranges into full month documents and partial-day documents', () => {
  const start = new Date('2024-08-15T00:00:00Z').getTime();
  const end = new Date('2024-10-10T00:00:00Z').getTime();
  const plan = AnalyticsHelpers.collectSummaryReadPlan(start, end);

  assert.deepEqual(plan.monthlyKeys, ['2024-09']);
  assert.ok(plan.dailyKeys.includes('2024-08-15'));
  assert.ok(plan.dailyKeys.includes('2024-10-09'));
  assert.ok(plan.dailyKeys.includes('2024-10-10') === false);
  assert.ok(plan.totalReads > 0);
});

test('readSalesSummaryForRange records missing summary docs instead of silently treating them as zero', async () => {
  const db = {
    collection: function(name) {
      return {
        doc: function(id) {
          const map = {
            '2024-09': null,
            '2024-08-15': { date: '2024-08-15', totalSales: 0, totalCost: 0, totalProfit: 0, salesCount: 0, totalQuantity: 0 },
            '2024-08-16': { date: '2024-08-16', totalSales: 0, totalCost: 0, totalProfit: 0, salesCount: 0, totalQuantity: 0 }
          };
          return {
            get: async function() {
              return { exists: !!map[id], data: function() { return map[id]; } };
            }
          };
        }
      };
    }
  };

  const result = await AnalyticsHelpers.readSalesSummaryForRange(
    new Date('2024-08-15T00:00:00Z').getTime(),
    new Date('2024-10-10T00:00:00Z').getTime(),
    db
  );

  assert.deepEqual(result.missingMonthKeys.includes('2024-09'), true);
  assert.equal(result.summary.totalSales, 0);
  assert.ok(Array.isArray(result.missingDailyKeys));
});

test('readExpensesForRange respects bounds with start inclusive and end exclusive', async () => {
  const db = {
    collection: function(name) {
      if (name !== 'expenses') return null;
      return {
        where: function(field, operator, value) {
          return {
            where: function(nextField, nextOperator, nextValue) {
              return {
                get: async function() {
                  const rows = [
                    { id: 'a', amount: 10, date: new Date('2024-08-01T00:00:00Z').getTime() },
                    { id: 'b', amount: 20, date: new Date('2024-08-15T00:00:00Z').getTime() },
                    { id: 'c', amount: 30, date: new Date('2024-10-10T00:00:00Z').getTime() }
                  ];
                  return {
                    docs: rows.filter(function(item) {
                      return item.date >= value && item.date < nextValue;
                    }).map(function(item) {
                      return { id: item.id, data: function() { return item; } };
                    })
                  };
                }
              };
            }
          };
        }
      };
    }
  };

  const range = await AnalyticsHelpers.readExpensesForRange(
    new Date('2024-08-01T00:00:00Z').getTime(),
    new Date('2024-10-10T00:00:00Z').getTime(),
    db
  );

  assert.equal(range.total, 30);
  assert.equal(range.expenses.length, 2);
});
