(function () {
  var db = window.firebaseDb || window.firebaseDbInstance || null;

  function normalizeItemId(itemId) {
    if (itemId === null || itemId === undefined || itemId === '') return '';
    return String(itemId).trim();
  }

  function getDefaultSummary(itemId) {
    return {
      itemId: normalizeItemId(itemId),
      itemName: '',
      totalSales: 0,
      totalProfit: 0,
      salesCount: 0,
      totalQuantity: 0,
      updatedAt: Date.now()
    };
  }

  function normalizeSummary(data, itemId) {
    var raw = data || {};
    return {
      itemId: normalizeItemId(itemId || raw.itemId || ''),
      itemName: raw.itemName || '',
      totalSales: Number(raw.totalSales) || 0,
      totalProfit: Number(raw.totalProfit) || 0,
      salesCount: Number(raw.salesCount) || 0,
      totalQuantity: Number(raw.totalQuantity) || 0,
      updatedAt: Number(raw.updatedAt) || Date.now()
    };
  }

  function getSaleTotals(sale) {
    if (!sale || typeof sale !== 'object') {
      return { totalSales: 0, totalProfit: 0, salesCount: 0, totalQuantity: 0 };
    }
    return {
      totalSales: Number(sale.totalAmount || sale.amount || 0) || 0,
      totalProfit: Number(sale.profit || 0) || 0,
      salesCount: 1,
      totalQuantity: Number(sale.quantity || 0) || 0
    };
  }

  async function readSummary(itemId) {
    var normalizedItemId = normalizeItemId(itemId);
    if (!normalizedItemId || !db || !db.collection) return getDefaultSummary(normalizedItemId);
    try {
      var snapshot = await db.collection('productSalesSummary').doc(normalizedItemId).get();
      if (!snapshot || !snapshot.exists) return getDefaultSummary(normalizedItemId);
      return normalizeSummary(snapshot.data(), normalizedItemId);
    } catch (error) {
      return getDefaultSummary(normalizedItemId);
    }
  }

  async function readAllSummaries() {
    if (!db || !db.collection) return [];
    try {
      var snapshot = await db.collection('productSalesSummary').get();
      if (!snapshot || !snapshot.docs) return [];
      return snapshot.docs.map(function(doc) {
        return normalizeSummary(doc.data(), doc.id);
      });
    } catch (error) {
      console.warn('productSalesSummary readAllSummaries failed', error);
      return [];
    }
  }

  async function applySummaryDelta(itemId, deltaSales, deltaProfit, deltaCount, deltaQuantity, itemName) {
    var normalizedItemId = normalizeItemId(itemId);
    if (!normalizedItemId || !db || !db.collection) return null;

    var normalizedDeltaSales = Number(deltaSales) || 0;
    var normalizedDeltaProfit = Number(deltaProfit) || 0;
    var normalizedDeltaCount = Number(deltaCount) || 0;
    var normalizedDeltaQuantity = Number(deltaQuantity) || 0;

    if (normalizedDeltaSales === 0 && normalizedDeltaProfit === 0 && normalizedDeltaCount === 0 && normalizedDeltaQuantity === 0) {
      return null;
    }

    var ref = db.collection('productSalesSummary').doc(normalizedItemId);
    try {
      var snapshot = await ref.get();
      var current = snapshot && snapshot.exists ? normalizeSummary(snapshot.data(), normalizedItemId) : getDefaultSummary(normalizedItemId);
      var nextSummary = {
        itemId: normalizedItemId,
        itemName: itemName || current.itemName || '',
        totalSales: Number(current.totalSales) + normalizedDeltaSales,
        totalProfit: Number(current.totalProfit) + normalizedDeltaProfit,
        salesCount: Number(current.salesCount) + normalizedDeltaCount,
        totalQuantity: Number(current.totalQuantity) + normalizedDeltaQuantity,
        updatedAt: Date.now()
      };
      await ref.set(nextSummary, { merge: true });
      return nextSummary;
    } catch (error) {
      console.warn('productSalesSummary update failed', error);
      return null;
    }
  }

  async function applySaleCreate(sale) {
    var itemId = normalizeItemId(sale && sale.itemId);
    if (!itemId) return null;
    var totals = getSaleTotals(sale);
    return applySummaryDelta(itemId, totals.totalSales, totals.totalProfit, totals.salesCount, totals.totalQuantity, sale && sale.itemName || '');
  }

  async function applySaleDelete(sale) {
    var itemId = normalizeItemId(sale && sale.itemId);
    if (!itemId) return null;
    var totals = getSaleTotals(sale);
    return applySummaryDelta(itemId, -totals.totalSales, -totals.totalProfit, -totals.salesCount, -totals.totalQuantity, sale && sale.itemName || '');
  }

  async function applySaleUpdate(previousSale, nextSale) {
    if (!previousSale && !nextSale) return null;
    var previousItemId = normalizeItemId(previousSale && previousSale.itemId);
    var nextItemId = normalizeItemId(nextSale && nextSale.itemId);
    var previousTotals = getSaleTotals(previousSale);
    var nextTotals = getSaleTotals(nextSale);

    if (previousItemId && nextItemId && previousItemId !== nextItemId) {
      await applySaleDelete(previousSale);
      await applySaleCreate(nextSale);
      return true;
    }

    var targetItemId = previousItemId || nextItemId;
    if (!targetItemId) return null;

    var deltaSales = nextTotals.totalSales - previousTotals.totalSales;
    var deltaProfit = nextTotals.totalProfit - previousTotals.totalProfit;
    var deltaQuantity = nextTotals.totalQuantity - previousTotals.totalQuantity;

    return applySummaryDelta(targetItemId, deltaSales, deltaProfit, 0, deltaQuantity, nextSale && nextSale.itemName || previousSale && previousSale.itemName || '');
  }

  window.ProductSalesSummary = {
    normalizeSummary: normalizeSummary,
    getDefaultSummary: getDefaultSummary,
    readSummary: readSummary,
    readAllSummaries: readAllSummaries,
    applySummaryDelta: applySummaryDelta,
    applySaleCreate: applySaleCreate,
    applySaleDelete: applySaleDelete,
    applySaleUpdate: applySaleUpdate,
    getSaleTotals: getSaleTotals
  };
})();
