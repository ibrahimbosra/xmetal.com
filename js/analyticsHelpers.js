(function(root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.AnalyticsHelpers = api;
})(typeof window !== 'undefined' ? window : globalThis, function() {
  function toNumber(value) {
    var n = Number(value);
    return isNaN(n) ? 0 : n;
  }

  function getSaleWindow(sales) {
    if (!Array.isArray(sales) || !sales.length) {
      return { firstSaleTimestamp: null, lastSaleTimestamp: null };
    }
    var timestamps = sales
      .map(function(sale) { return Number(sale && sale.timestamp) || 0; })
      .filter(function(timestamp) { return timestamp > 0; });
    if (!timestamps.length) {
      return { firstSaleTimestamp: null, lastSaleTimestamp: null };
    }
    return {
      firstSaleTimestamp: Math.min.apply(null, timestamps),
      lastSaleTimestamp: Math.max.apply(null, timestamps)
    };
  }

  function buildStatsFromSales(sales, expenses, startTimestamp, endTimestamp) {
    var salesWindow = Array.isArray(sales) ? sales.filter(function(sale) {
      var timestamp = Number(sale && sale.timestamp) || 0;
      var withinStart = startTimestamp === null || startTimestamp === undefined || timestamp >= startTimestamp;
      var withinEnd = endTimestamp === null || endTimestamp === undefined || timestamp <= endTimestamp;
      return withinStart && withinEnd;
    }) : [];

    var revenue = salesWindow.reduce(function(total, sale) {
      return total + toNumber(sale && sale.totalAmount);
    }, 0);
    var grossProfit = salesWindow.reduce(function(total, sale) {
      return total + toNumber(sale && sale.profit);
    }, 0);
    var qtySold = salesWindow.reduce(function(total, sale) {
      return total + toNumber(sale && sale.quantity);
    }, 0);
    var expensesValue = Array.isArray(expenses) ? expenses.reduce(function(total, expense) {
      var timestamp = Number(expense && expense.date) || 0;
      var withinStart = startTimestamp === null || startTimestamp === undefined || timestamp >= startTimestamp;
      var withinEnd = endTimestamp === null || endTimestamp === undefined || timestamp <= endTimestamp;
      return total + (withinStart && withinEnd ? toNumber(expense && expense.amount) : 0);
    }, 0) : 0;

    return {
      revenue: revenue,
      grossProfit: grossProfit,
      netProfit: grossProfit - expensesValue,
      expenses: expensesValue,
      salesCount: salesWindow.length,
      qtySold: qtySold,
      startTimestamp: startTimestamp,
      endTimestamp: endTimestamp
    };
  }

  function createZeroSummary() {
    return {
      salesCount: 0,
      totalSales: 0,
      totalCost: 0,
      totalProfit: 0,
      totalQuantity: 0
    };
  }

  function addSummaryValues(target, source) {
    if (!source) return target;
    target.salesCount += toNumber(source.salesCount);
    target.totalSales += toNumber(source.totalSales);
    target.totalCost += toNumber(source.totalCost);
    target.totalProfit += toNumber(source.totalProfit);
    target.totalQuantity += toNumber(source.totalQuantity);
    return target;
  }

  function getDayKeyFromTimestamp(timestamp) {
    var value = Number(timestamp) || 0;
    if (!value) return '';
    var date = new Date(value);
    var year = date.getFullYear();
    var month = String(date.getMonth() + 1).padStart(2, '0');
    var day = String(date.getDate()).padStart(2, '0');
    return year + '-' + month + '-' + day;
  }

  function getMonthKeyFromTimestamp(timestamp) {
    var value = Number(timestamp) || 0;
    if (!value) return '';
    var date = new Date(value);
    var year = date.getFullYear();
    var month = String(date.getMonth() + 1).padStart(2, '0');
    return year + '-' + month;
  }

  function getStartOfMonthTimestamp(timestamp) {
    var date = new Date(Number(timestamp) || 0);
    date.setHours(0, 0, 0, 0);
    date.setDate(1);
    return date.getTime();
  }

  function getNextMonthTimestamp(timestamp) {
    var date = new Date(Number(timestamp) || 0);
    date.setHours(0, 0, 0, 0);
    date.setDate(1);
    date.setMonth(date.getMonth() + 1);
    return date.getTime();
  }

  function normalizeSummaryMap(summaries) {
    var map = {};
    if (!summaries) return map;
    if (Array.isArray(summaries)) {
      summaries.forEach(function(item) {
        var key = item && item.date ? item.date : (item && item.monthKey ? item.monthKey : '');
        if (key) map[String(key)] = item;
      });
      return map;
    }
    Object.keys(summaries).forEach(function(key) {
      map[String(key)] = summaries[key];
    });
    return map;
  }

  function getSalesSummaryForRange(start, end, summarySources) {
    start = Number(start) || 0;
    end = Number(end) || 0;

    if (!start || !end || end <= start) {
      return createZeroSummary();
    }

    var sources = summarySources || {};
    var dailySummaries = normalizeSummaryMap(sources.dailySummaries);
    var monthlySummaries = normalizeSummaryMap(sources.monthlySummaries);
    var result = createZeroSummary();
    var fullMonthDays = {};

    var monthStart = getStartOfMonthTimestamp(start);
    var monthCursor = monthStart;
    while (monthCursor < end) {
      var monthKey = getMonthKeyFromTimestamp(monthCursor);
      var monthEnd = getNextMonthTimestamp(monthCursor);
      var monthIsFullyInside = monthCursor >= start && monthEnd <= end;
      if (monthIsFullyInside && monthlySummaries[monthKey]) {
        addSummaryValues(result, monthlySummaries[monthKey]);
        var monthDayCursor = new Date(monthCursor);
        monthDayCursor.setHours(0, 0, 0, 0);
        while (monthDayCursor.getTime() < monthEnd) {
          fullMonthDays[getDayKeyFromTimestamp(monthDayCursor.getTime())] = true;
          monthDayCursor.setDate(monthDayCursor.getDate() + 1);
        }
      }
      monthCursor = getNextMonthTimestamp(monthCursor);
    }

    var dayCursor = new Date(start);
    dayCursor.setHours(0, 0, 0, 0);
    var endCursor = new Date(end);
    endCursor.setHours(0, 0, 0, 0);
    while (dayCursor.getTime() < endCursor.getTime()) {
      var dayKey = getDayKeyFromTimestamp(dayCursor.getTime());
      if (!fullMonthDays[dayKey] && dailySummaries[dayKey]) {
        addSummaryValues(result, dailySummaries[dayKey]);
      }
      dayCursor.setDate(dayCursor.getDate() + 1);
    }

    return result;
  }

  function collectSummaryReadPlan(start, end) {
    start = Number(start) || 0;
    end = Number(end) || 0;
    if (!start || !end || end <= start) {
      return {
        monthlyKeys: [],
        dailyKeys: [],
        fullMonthDays: {},
        totalReads: 0
      };
    }

    var monthlyKeys = [];
    var dailyKeys = [];
    var fullMonthDays = {};
    var monthCursor = new Date(getStartOfMonthTimestamp(start));
    monthCursor.setHours(0, 0, 0, 0);
    while (monthCursor.getTime() < end) {
      var monthKey = getMonthKeyFromTimestamp(monthCursor.getTime());
      var monthEnd = getNextMonthTimestamp(monthCursor.getTime());
      var monthIsFullyInside = monthCursor.getTime() >= start && monthEnd <= end;
      if (monthIsFullyInside) {
        monthlyKeys.push(monthKey);
        var monthDayCursor = new Date(monthCursor);
        monthDayCursor.setHours(0, 0, 0, 0);
        while (monthDayCursor.getTime() < monthEnd) {
          fullMonthDays[getDayKeyFromTimestamp(monthDayCursor.getTime())] = true;
          monthDayCursor.setDate(monthDayCursor.getDate() + 1);
        }
      }
      monthCursor.setMonth(monthCursor.getMonth() + 1);
    }

    var dayCursor = new Date(start);
    dayCursor.setHours(0, 0, 0, 0);
    var endCursor = new Date(end);
    endCursor.setHours(0, 0, 0, 0);
    while (dayCursor.getTime() < endCursor.getTime()) {
      var dayKey = getDayKeyFromTimestamp(dayCursor.getTime());
      if (!fullMonthDays[dayKey]) {
        dailyKeys.push(dayKey);
      }
      dayCursor.setDate(dayCursor.getDate() + 1);
    }

    return {
      monthlyKeys: monthlyKeys,
      dailyKeys: dailyKeys,
      fullMonthDays: fullMonthDays,
      totalReads: monthlyKeys.length + dailyKeys.length
    };
  }

  async function readSalesSummaryForRange(start, end, db) {
    start = Number(start) || 0;
    end = Number(end) || 0;
    if (!db || !db.collection || !start || !end || end <= start) {
      return {
        summary: createZeroSummary(),
        dailySummaries: {},
        monthlySummaries: {},
        missingDailyKeys: [],
        missingMonthKeys: [],
        reads: 0,
        totalReads: 0
      };
    }

    var plan = collectSummaryReadPlan(start, end);
    var dailySummaries = {};
    var monthlySummaries = {};
    var missingDailyKeys = [];
    var missingMonthKeys = [];
    var reads = 0;

    var monthPromiseResults = await Promise.all(plan.monthlyKeys.map(function(monthKey) {
      return db.collection('monthlySalesSummary').doc(monthKey).get().then(function(doc) {
        reads += 1;
        if (!doc || !doc.exists) {
          missingMonthKeys.push(monthKey);
          return null;
        }
        var data = doc.data && doc.data();
        if (!data) {
          missingMonthKeys.push(monthKey);
          return null;
        }
        monthlySummaries[monthKey] = data;
        return data;
      });
    }));

    var dailyPromiseResults = await Promise.all(plan.dailyKeys.map(function(dayKey) {
      return db.collection('dailySales').doc(dayKey).get().then(function(doc) {
        reads += 1;
        if (!doc || !doc.exists) {
          missingDailyKeys.push(dayKey);
          return null;
        }
        var data = doc.data && doc.data();
        if (!data) {
          missingDailyKeys.push(dayKey);
          return null;
        }
        dailySummaries[dayKey] = data;
        return data;
      });
    }));

    var summary = getSalesSummaryForRange(start, end, {
      dailySummaries: dailySummaries,
      monthlySummaries: monthlySummaries
    });

    return {
      summary: summary,
      dailySummaries: dailySummaries,
      monthlySummaries: monthlySummaries,
      missingDailyKeys: missingDailyKeys,
      missingMonthKeys: missingMonthKeys,
      reads: reads,
      totalReads: reads,
      plan: plan
    };
  }

  async function readExpensesForRange(start, end, db) {
    start = Number(start) || 0;
    end = Number(end) || 0;
    if (!db || !db.collection || !start || !end || end <= start) {
      return {
        expenses: [],
        total: 0,
        reads: 0,
        totalReads: 0
      };
    }

    var snapshot = await db.collection('expenses').where('date', '>=', start).where('date', '<', end).get();
    var expenses = snapshot && Array.isArray(snapshot.docs) ? snapshot.docs.map(function(doc) {
      var data = doc && doc.data ? doc.data() : {};
      return Object.assign({ id: doc && doc.id ? doc.id : null }, data);
    }) : [];

    var total = expenses.reduce(function(sum, item) {
      return sum + toNumber(item && item.amount);
    }, 0);

    return {
      expenses: expenses,
      total: total,
      reads: 1,
      totalReads: 1
    };
  }

  function getExpensesSum(start, end, expenses) {
    var expenseList = Array.isArray(expenses) ? expenses : (Array.isArray(globalThis.allExpenses) ? globalThis.allExpenses : []);
    if (!Array.isArray(expenseList)) return 0;
    start = Number(start) || 0;
    end = Number(end) || 0;
    if (!start && !end) return 0;
    end = end || (Date.now() + 86400000);
    return expenseList.reduce(function(total, expense) {
      var timestamp = Number(expense && expense.date) || 0;
      if (timestamp >= start && timestamp < end) {
        total += toNumber(expense && expense.amount);
      }
      return total;
    }, 0);
  }

  function buildLazyProfitSummary(sales, expenses) {
    var range = getSaleWindow(sales);
    var stats = buildStatsFromSales(sales, expenses, range.firstSaleTimestamp, range.lastSaleTimestamp);
    return {
      salesCount: stats.salesCount,
      revenue: stats.revenue,
      grossProfit: stats.grossProfit,
      netProfit: stats.netProfit,
      expenses: stats.expenses,
      qtySold: stats.qtySold,
      firstSaleTimestamp: range.firstSaleTimestamp,
      lastSaleTimestamp: range.lastSaleTimestamp
    };
  }

  function buildMonthStats(sales, monthKey, expenses) {
    var parts = String(monthKey || '').split('-');
    if (parts.length < 2) {
      return buildStatsFromSales(sales, expenses, null, null);
    }
    var year = parseInt(parts[0], 10);
    var monthIndex = parseInt(parts[1], 10) - 1;
    var start = new Date(year, monthIndex, 1).getTime();
    var end = new Date(year, monthIndex + 1, 1).getTime();
    var monthSales = Array.isArray(sales) ? sales.filter(function(sale) {
      var timestamp = Number(sale && sale.timestamp) || 0;
      return timestamp >= start && timestamp < end;
    }) : [];
    var actualStart = monthSales.length ? monthSales.reduce(function(current, sale) {
      var timestamp = Number(sale && sale.timestamp) || 0;
      return current === null || timestamp < current ? timestamp : current;
    }, null) : null;
    var actualEnd = monthSales.length ? monthSales.reduce(function(current, sale) {
      var timestamp = Number(sale && sale.timestamp) || 0;
      return current === null || timestamp > current ? timestamp : current;
    }, null) : null;
    var stats = buildStatsFromSales(monthSales, expenses, actualStart, actualEnd);
    return {
      salesCount: stats.salesCount,
      revenue: stats.revenue,
      grossProfit: stats.grossProfit,
      netProfit: stats.netProfit,
      expenses: stats.expenses,
      qtySold: stats.qtySold,
      periodStart: actualStart,
      periodEnd: actualEnd,
      monthKey: monthKey
    };
  }

  return {
    buildLazyProfitSummary: buildLazyProfitSummary,
    buildMonthStats: buildMonthStats,
    buildStatsFromSales: buildStatsFromSales,
    getSalesSummaryForRange: getSalesSummaryForRange,
    getExpensesSum: getExpensesSum,
    collectSummaryReadPlan: collectSummaryReadPlan,
    readSalesSummaryForRange: readSalesSummaryForRange,
    readExpensesForRange: readExpensesForRange
  };
});
