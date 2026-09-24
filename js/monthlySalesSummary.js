(function () {
  var db = window.firebaseDb || window.firebaseDbInstance || null;

  function normalizeMonthKey(value) {
    if (value === null || value === undefined || value === '') return '';
    if (typeof value === 'string') {
      var trimmed = value.trim();
      if (/^\d{4}-\d{2}$/.test(trimmed)) return trimmed;
      var ts = Number(trimmed);
      if (Number.isFinite(ts)) {
        return toMonthKey(ts);
      }
      var parsed = Date.parse(trimmed);
      if (Number.isFinite(parsed)) return toMonthKey(parsed);
      return '';
    }
    var timestamp = Number(value);
    if (Number.isFinite(timestamp)) return toMonthKey(timestamp);
    return '';
  }

  function toMonthKey(value) {
    if (value === null || value === undefined || value === '') return '';
    var timestamp = Number(value);
    if (!Number.isFinite(timestamp)) {
      timestamp = Date.parse(value);
    }
    if (!Number.isFinite(timestamp)) return '';
    var date = new Date(timestamp);
    var year = date.getFullYear();
    var month = String(date.getMonth() + 1).padStart(2, '0');
    return year + '-' + month;
  }

  function getMonthMeta(monthKey) {
    var key = normalizeMonthKey(monthKey || '');
    if (!key || !/^\d{4}-\d{2}$/.test(key)) {
      return { monthKey: '', year: 0, month: 0 };
    }
    var parts = key.split('-');
    var year = Number(parts[0]) || 0;
    var month = Number(parts[1]) || 0;
    return { monthKey: key, year: year, month: month };
  }

  function getDefaultSummary(monthKey) {
    var meta = getMonthMeta(monthKey);
    return {
      monthKey: meta.monthKey,
      year: meta.year,
      month: meta.month,
      salesCount: 0,
      totalQuantity: 0,
      totalSales: 0,
      totalCost: 0,
      totalProfit: 0,
      expenses: 0,
      updatedAt: Date.now()
    };
  }

  function normalizeSummary(data, monthKey) {
    var raw = data || {};
    var meta = getMonthMeta(monthKey || raw.monthKey || '');
    return {
      monthKey: meta.monthKey || normalizeMonthKey(raw.monthKey || monthKey || ''),
      year: Number(raw.year || meta.year || 0) || 0,
      month: Number(raw.month || meta.month || 0) || 0,
      salesCount: Number(raw.salesCount) || 0,
      totalQuantity: Number(raw.totalQuantity) || 0,
      totalSales: Number(raw.totalSales) || 0,
      totalCost: Number(raw.totalCost) || 0,
      totalProfit: Number(raw.totalProfit) || 0,
      expenses: Number(raw.expenses) || 0,
      updatedAt: Number(raw.updatedAt) || Date.now()
    };
  }

  function getSaleTotals(sale) {
    if (!sale || typeof sale !== 'object') {
      return { totalSales: 0, totalCost: 0, totalProfit: 0, salesCount: 0, totalQuantity: 0 };
    }
    var quantity = Number(sale.quantity) || 0;
    var totalSales = Number(sale.totalAmount || sale.amount || 0) || 0;
    var purchasePriceAtTime = Number(sale.purchasePriceAtTime || 0) || 0;
    var cost = purchasePriceAtTime * quantity;
    var profit = Number(sale.profit || 0) || 0;
    return {
      totalSales: totalSales,
      totalCost: cost,
      totalProfit: profit,
      salesCount: 1,
      totalQuantity: quantity
    };
  }

  function getExpenseTotals(expense) {
    if (!expense || typeof expense !== 'object') {
      return { expenses: 0 };
    }
    var amount = Number(expense.amount != null ? expense.amount : (expense.totalAmount != null ? expense.totalAmount : (expense.baseAmount != null ? expense.baseAmount : 0))) || 0;
    return { expenses: amount };
  }

  async function readSummary(monthKey) {
    var normalizedMonthKey = normalizeMonthKey(monthKey);
    if (!normalizedMonthKey || !db || !db.collection) return getDefaultSummary(normalizedMonthKey);
    try {
      var snapshot = await db.collection('monthlySalesSummary').doc(normalizedMonthKey).get();
      if (!snapshot || !snapshot.exists) return getDefaultSummary(normalizedMonthKey);
      return normalizeSummary(snapshot.data(), normalizedMonthKey);
    } catch (error) {
      return getDefaultSummary(normalizedMonthKey);
    }
  }

  async function applySummaryDelta(monthKey, deltaSales, deltaCost, deltaProfit, deltaCount, deltaQuantity, deltaExpenses) {
    var normalizedMonthKey = normalizeMonthKey(monthKey);
    if (!normalizedMonthKey || !db || !db.collection) return null;

    var normalizedDeltaSales = Number(deltaSales) || 0;
    var normalizedDeltaCost = Number(deltaCost) || 0;
    var normalizedDeltaProfit = Number(deltaProfit) || 0;
    var normalizedDeltaCount = Number(deltaCount) || 0;
    var normalizedDeltaQuantity = Number(deltaQuantity) || 0;
    var normalizedDeltaExpenses = Number(deltaExpenses) || 0;

    if (normalizedDeltaSales === 0 && normalizedDeltaCost === 0 && normalizedDeltaProfit === 0 && normalizedDeltaCount === 0 && normalizedDeltaQuantity === 0 && normalizedDeltaExpenses === 0) {
      return null;
    }

    var ref = db.collection('monthlySalesSummary').doc(normalizedMonthKey);
    try {
      var snapshot = await ref.get();
      var current = snapshot && snapshot.exists ? normalizeSummary(snapshot.data(), normalizedMonthKey) : getDefaultSummary(normalizedMonthKey);
      var nextSummary = {
        monthKey: normalizedMonthKey,
        year: Number(current.year) || Number(normalizedMonthKey.split('-')[0]) || 0,
        month: Number(current.month) || Number(normalizedMonthKey.split('-')[1]) || 0,
        salesCount: Number(current.salesCount) + normalizedDeltaCount,
        totalQuantity: Number(current.totalQuantity) + normalizedDeltaQuantity,
        totalSales: Number(current.totalSales) + normalizedDeltaSales,
        totalCost: Number(current.totalCost) + normalizedDeltaCost,
        totalProfit: Number(current.totalProfit) + normalizedDeltaProfit,
        expenses: Number(current.expenses) + normalizedDeltaExpenses,
        updatedAt: Date.now()
      };
      await ref.set(nextSummary, { merge: true });
      return nextSummary;
    } catch (error) {
      console.warn('monthlySalesSummary update failed', error);
      return null;
    }
  }

  async function applySaleCreate(sale) {
    var monthKey = normalizeMonthKey(sale && sale.timestamp);
    if (!monthKey) return null;
    var totals = getSaleTotals(sale);
    return applySummaryDelta(monthKey, totals.totalSales, totals.totalCost, totals.totalProfit, totals.salesCount, totals.totalQuantity, 0);
  }

  async function applySaleDelete(sale) {
    var monthKey = normalizeMonthKey(sale && sale.timestamp);
    if (!monthKey) return null;
    var totals = getSaleTotals(sale);
    return applySummaryDelta(monthKey, -totals.totalSales, -totals.totalCost, -totals.totalProfit, -totals.salesCount, -totals.totalQuantity, 0);
  }

  async function applySaleRestore(sale) {
    return applySaleCreate(sale);
  }

  async function applySaleUpdate(previousSale, nextSale) {
    if (!previousSale && !nextSale) return null;
    var previousMonthKey = normalizeMonthKey(previousSale && previousSale.timestamp);
    var nextMonthKey = normalizeMonthKey(nextSale && nextSale.timestamp);
    var previousTotals = getSaleTotals(previousSale);
    var nextTotals = getSaleTotals(nextSale);

    if (previousMonthKey && nextMonthKey && previousMonthKey !== nextMonthKey) {
      await applySaleDelete(previousSale);
      await applySaleCreate(nextSale);
      return true;
    }

    var targetMonthKey = previousMonthKey || nextMonthKey;
    if (!targetMonthKey) return null;

    var deltaSales = nextTotals.totalSales - previousTotals.totalSales;
    var deltaCost = nextTotals.totalCost - previousTotals.totalCost;
    var deltaProfit = nextTotals.totalProfit - previousTotals.totalProfit;
    var deltaQuantity = nextTotals.totalQuantity - previousTotals.totalQuantity;

    return applySummaryDelta(targetMonthKey, deltaSales, deltaCost, deltaProfit, 0, deltaQuantity, 0);
  }

  async function applyExpenseCreate(expense) {
    var monthKey = normalizeMonthKey(expense && (expense.date || expense.timestamp));
    if (!monthKey) return null;
    var totals = getExpenseTotals(expense);
    return applySummaryDelta(monthKey, 0, 0, 0, 0, 0, totals.expenses);
  }

  async function applyExpenseDelete(expense) {
    var monthKey = normalizeMonthKey(expense && (expense.date || expense.timestamp));
    if (!monthKey) return null;
    var totals = getExpenseTotals(expense);
    return applySummaryDelta(monthKey, 0, 0, 0, 0, 0, -totals.expenses);
  }

  async function applyExpenseRestore(expense) {
    return applyExpenseCreate(expense);
  }

  async function applyExpenseUpdate(previousExpense, nextExpense) {
    if (!previousExpense && !nextExpense) return null;
    var previousMonthKey = normalizeMonthKey(previousExpense && (previousExpense.date || previousExpense.timestamp));
    var nextMonthKey = normalizeMonthKey(nextExpense && (nextExpense.date || nextExpense.timestamp));
    var previousTotals = getExpenseTotals(previousExpense);
    var nextTotals = getExpenseTotals(nextExpense);

    if (previousMonthKey && nextMonthKey && previousMonthKey !== nextMonthKey) {
      await applyExpenseDelete(previousExpense);
      await applyExpenseCreate(nextExpense);
      return true;
    }

    var targetMonthKey = previousMonthKey || nextMonthKey;
    if (!targetMonthKey) return null;

    var deltaExpenses = nextTotals.expenses - previousTotals.expenses;
    return applySummaryDelta(targetMonthKey, 0, 0, 0, 0, 0, deltaExpenses);
  }

  window.MonthlySalesSummary = {
    toMonthKey: toMonthKey,
    normalizeMonthKey: normalizeMonthKey,
    getDefaultSummary: getDefaultSummary,
    normalizeSummary: normalizeSummary,
    getSaleTotals: getSaleTotals,
    getExpenseTotals: getExpenseTotals,
    readSummary: readSummary,
    applySummaryDelta: applySummaryDelta,
    applySaleCreate: applySaleCreate,
    applySaleDelete: applySaleDelete,
    applySaleRestore: applySaleRestore,
    applySaleUpdate: applySaleUpdate,
    applyExpenseCreate: applyExpenseCreate,
    applyExpenseDelete: applyExpenseDelete,
    applyExpenseRestore: applyExpenseRestore,
    applyExpenseUpdate: applyExpenseUpdate
  };
})();
