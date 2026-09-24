(function () {
  var db = window.firebaseDb || window.firebaseDbInstance || null;
  var SYSTEM_TIME_ZONE = 'Asia/Riyadh';

  function operationId(value) {
    var text = String(value || 'daily-sales-operation');
    var hash = 2166136261;
    for (var i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return 'op_' + (hash >>> 0).toString(16);
  }

  function saleId(sale) {
    return sale && (sale.saleId || sale.id) || 'unknown-sale';
  }

  function saleSignature(sale) {
    if (!sale) return 'none';
    return [saleId(sale), sale.timestamp, sale.quantity, sale.totalAmount, sale.amount, sale.profit, sale.purchasePriceAtTime].join('|');
  }

  function saleRevision(sale) {
    var value = Number(sale && sale.saleRevision);
    return Number.isFinite(value) && value > 0 ? value : 1;
  }

  function saleOperationId(sale, operationType) {
    return String(saleId(sale)) + ':' + saleRevision(sale) + ':' + String(operationType || 'update');
  }

  function saleStateRef(dayKey, id) {
    return db.collection('dailySales').doc(dayKey).collection('saleStates').doc(String(id));
  }

  function markerRef(dayKey, operation) {
    return db.collection('dailySales').doc(dayKey).collection('appliedOperations').doc(operation);
  }

  function readPendingOperations() {
    try {
      var raw = localStorage.getItem('xmetal_pending_daily_sales_v1');
      var parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  function writePendingOperations(operations) {
    try { localStorage.setItem('xmetal_pending_daily_sales_v1', JSON.stringify(operations)); } catch (error) {}
  }

  function queuePendingOperation(payload) {
    var operations = readPendingOperations();
    var existingIndex = operations.findIndex(function (entry) { return entry.operation === payload.operation; });
    if (existingIndex >= 0) operations[existingIndex] = payload;
    else operations.push(payload);
    writePendingOperations(operations);
  }

  function toDayKey(value) {
    if (value === null || value === undefined || value === '') return '';
    var timestamp = Number(value);
    if (!Number.isFinite(timestamp)) {
      timestamp = Date.parse(value);
    }
    if (!Number.isFinite(timestamp)) return '';
    var parts = new Intl.DateTimeFormat('en-CA', { timeZone: SYSTEM_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(timestamp));
    var values = {};
    parts.forEach(function (part) { if (part.type !== 'literal') values[part.type] = part.value; });
    return values.year + '-' + values.month + '-' + values.day;
  }

  function getDefaultSummary(dayKey) {
    return {
      date: dayKey || '',
      totalSales: 0,
      totalCost: 0,
      totalProfit: 0,
      salesCount: 0,
      totalQuantity: 0,
      updatedAt: Date.now()
    };
  }

  function normalizeSummary(data, dayKey) {
    var raw = data || {};
    return {
      date: dayKey || raw.date || '',
      totalSales: Number(raw.totalSales) || 0,
      totalCost: Number(raw.totalCost) || 0,
      totalProfit: Number(raw.totalProfit) || 0,
      salesCount: Number(raw.salesCount) || 0,
      totalQuantity: Number(raw.totalQuantity) || 0,
      updatedAt: Number(raw.updatedAt) || Date.now()
    };
  }

  function getSaleTotals(sale) {
    if (!sale || typeof sale !== 'object') {
      return { totalSales: 0, totalCost: 0, totalProfit: 0, salesCount: 0, totalQuantity: 0 };
    }
    var quantity = Number(sale.quantity || 0) || 0;
    var purchasePriceAtTime = Number(sale.purchasePriceAtTime || 0) || 0;
    return {
      totalSales: Number(sale.totalAmount || sale.amount || 0) || 0,
      totalCost: purchasePriceAtTime * quantity,
      totalProfit: Number(sale.profit || 0) || 0,
      salesCount: 1,
      totalQuantity: quantity
    };
  }

  function isSaleActive(sale, statusOverride) {
    var status = arguments.length > 1 ? statusOverride : sale && sale.status;
    return status !== 'cancelled' && status !== 'returned' && status !== 'refunded' && !(sale && sale.cancelled) && !(sale && sale.isCancelled) && !(sale && sale.returned);
  }

  function projectionState(sale, dayKey, status) {
    var totals = getSaleTotals(sale);
    var active = isSaleActive(sale, status);
    return {
      saleId: saleId(sale),
      saleRevision: saleRevision(sale),
      dayKey: dayKey,
      totalSales: active ? totals.totalSales : 0,
      totalCost: active ? totals.totalCost : 0,
      totalProfit: active ? totals.totalProfit : 0,
      salesCount: active ? totals.salesCount : 0,
      totalQuantity: active ? totals.totalQuantity : 0,
      status: active ? 'active' : (status || 'cancelled'),
      updatedAt: Date.now()
    };
  }

  function applyProjectionDelta(tx, summaryRef, stateRef, marker, currentSummary, previousState, nextState) {
    var oldState = previousState || { totalSales: 0, totalCost: 0, totalProfit: 0, salesCount: 0, totalQuantity: 0 };
    var next = nextState || { totalSales: 0, totalCost: 0, totalProfit: 0, salesCount: 0, totalQuantity: 0 };
    tx.set(summaryRef, {
      date: next.dayKey || currentSummary.date,
      totalSales: Number(currentSummary.totalSales || 0) - Number(oldState.totalSales || 0) + Number(next.totalSales || 0),
      totalCost: Number(currentSummary.totalCost || 0) - Number(oldState.totalCost || 0) + Number(next.totalCost || 0),
      totalProfit: Number(currentSummary.totalProfit || 0) - Number(oldState.totalProfit || 0) + Number(next.totalProfit || 0),
      salesCount: Number(currentSummary.salesCount || 0) - Number(oldState.salesCount || 0) + Number(next.salesCount || 0),
      totalQuantity: Number(currentSummary.totalQuantity || 0) - Number(oldState.totalQuantity || 0) + Number(next.totalQuantity || 0),
      updatedAt: Date.now()
    }, { merge: true });
    if (stateRef) tx.set(stateRef, next, { merge: true });
    tx.set(marker, { operation: marker.id, saleId: next.saleId, saleRevision: next.saleRevision, appliedAt: Date.now() }, { merge: true });
  }

  async function applySaleMutationInTransaction(tx, beforeSale, afterSale, operationType) {
    var currentSale = beforeSale || afterSale;
    var oldDayKey = toDayKey(beforeSale && beforeSale.timestamp);
    var nextDayKey = toDayKey(afterSale && afterSale.timestamp);
    var dayKey = nextDayKey || oldDayKey;
    if (!dayKey) return { status: 'ignored' };
    var id = saleId(currentSale);
    var revision = saleRevision(afterSale || beforeSale);
    var op = id + ':' + revision + ':' + String(operationType || 'update');
    var targetStateRef = saleStateRef(dayKey, id);
    var marker = markerRef(dayKey, op);
    var summaryRef = db.collection('dailySales').doc(dayKey);
    var reads = [tx.get(summaryRef), tx.get(targetStateRef), tx.get(marker)];
    if (oldDayKey && oldDayKey !== dayKey) reads.push(tx.get(db.collection('dailySales').doc(oldDayKey)), tx.get(saleStateRef(oldDayKey, id)));
    return Promise.all(reads).then(function (snapshots) {
      var summarySnapshot = snapshots[0];
      var stateSnapshot = snapshots[1];
      var markerSnapshot = snapshots[2];
      var currentSummary = summarySnapshot && summarySnapshot.exists ? normalizeSummary(summarySnapshot.data(), dayKey) : getDefaultSummary(dayKey);
      if (markerSnapshot && markerSnapshot.exists) return { status: 'duplicate', revision: revision };
      var previousState = stateSnapshot && stateSnapshot.exists ? stateSnapshot.data() : null;
      if (previousState && Number(previousState.saleRevision || 0) > revision) return { status: 'stale', revision: revision };
      var nextState = afterSale ? projectionState(afterSale, dayKey, afterSale.status) : projectionState(beforeSale, dayKey, 'cancelled');
      var profitState = previousState;
      if (oldDayKey && oldDayKey !== dayKey) {
        var oldSummarySnapshot = snapshots[3];
        var oldStateSnapshot = snapshots[4];
        var oldSummary = oldSummarySnapshot && oldSummarySnapshot.exists ? normalizeSummary(oldSummarySnapshot.data(), oldDayKey) : getDefaultSummary(oldDayKey);
        var oldState = oldStateSnapshot && oldStateSnapshot.exists ? oldStateSnapshot.data() : null;
        profitState = oldState || profitState;
        tx.set(db.collection('dailySales').doc(oldDayKey), {
          totalSales: Number(oldSummary.totalSales || 0) - Number(oldState && oldState.totalSales || 0),
          totalCost: Number(oldSummary.totalCost || 0) - Number(oldState && oldState.totalCost || 0),
          totalProfit: Number(oldSummary.totalProfit || 0) - Number(oldState && oldState.totalProfit || 0),
          salesCount: Number(oldSummary.salesCount || 0) - Number(oldState && oldState.salesCount || 0),
          totalQuantity: Number(oldSummary.totalQuantity || 0) - Number(oldState && oldState.totalQuantity || 0),
          updatedAt: Date.now()
        }, { merge: true });
        tx.delete(saleStateRef(oldDayKey, id));
      }
      applyProjectionDelta(tx, summaryRef, targetStateRef, marker, currentSummary, previousState, nextState);
      var oldProfit = Number(profitState && profitState.totalProfit) || 0;
      var newProfit = Number(nextState && nextState.totalProfit) || 0;
      var profitDelta = newProfit - oldProfit;
      if (profitDelta !== 0) {
        tx.set(db.collection('stats').doc('totals'), {
          allTimeProfit: window.firebase.firestore.FieldValue.increment(profitDelta),
          updatedAt: Date.now()
        }, { merge: true });
      }
      return { status: 'applied', revision: revision };
    });
  }

  async function readSummary(dayKey) {
    if (!dayKey || !db || !db.collection) return getDefaultSummary(dayKey);
    try {
      var snapshot = await db.collection('dailySales').doc(dayKey).get();
      if (!snapshot || !snapshot.exists) return getDefaultSummary(dayKey);
      return normalizeSummary(snapshot.data(), dayKey);
    } catch (error) {
      return getDefaultSummary(dayKey);
    }
  }

  async function applySummaryDelta(dayKey, deltaSales, deltaCost, deltaProfit, deltaCount, deltaQuantity, operation) {
    if (!dayKey || !db || !db.collection) return null;
    var normalizedDeltaSales = Number(deltaSales) || 0;
    var normalizedDeltaCost = Number(deltaCost) || 0;
    var normalizedDeltaProfit = Number(deltaProfit) || 0;
    var normalizedDeltaCount = Number(deltaCount) || 0;
    var normalizedDeltaQuantity = Number(deltaQuantity) || 0;
    if (normalizedDeltaSales === 0 && normalizedDeltaCost === 0 && normalizedDeltaProfit === 0 && normalizedDeltaCount === 0 && normalizedDeltaQuantity === 0) {
      return null;
    }

    var ref = db.collection('dailySales').doc(dayKey);
    var markerRef = ref.collection('appliedOperations').doc(operationId(operation));
    try {
      var result = null;
      await db.runTransaction(function (tx) {
        return Promise.all([tx.get(ref), tx.get(markerRef)]).then(function (snapshots) {
          var summarySnapshot = snapshots[0];
          var markerSnapshot = snapshots[1];
          if (markerSnapshot && markerSnapshot.exists) {
            result = normalizeSummary(summarySnapshot && summarySnapshot.exists ? summarySnapshot.data() : {}, dayKey);
            return;
          }
          var current = summarySnapshot && summarySnapshot.exists ? normalizeSummary(summarySnapshot.data(), dayKey) : getDefaultSummary(dayKey);
          result = {
            date: dayKey,
            totalSales: Number(current.totalSales) + normalizedDeltaSales,
            totalCost: Number(current.totalCost) + normalizedDeltaCost,
            totalProfit: Number(current.totalProfit) + normalizedDeltaProfit,
            salesCount: Number(current.salesCount) + normalizedDeltaCount,
            totalQuantity: Number(current.totalQuantity) + normalizedDeltaQuantity,
            updatedAt: Date.now()
          };
          tx.set(ref, result, { merge: true });
          tx.set(markerRef, { operation: operation || '', appliedAt: Date.now() });
        });
      });
      return result;
    } catch (error) {
      console.warn('dailySales summary update failed', error);
      queuePendingOperation({
        dayKey: dayKey,
        deltaSales: normalizedDeltaSales,
        deltaCost: normalizedDeltaCost,
        deltaProfit: normalizedDeltaProfit,
        deltaCount: normalizedDeltaCount,
        deltaQuantity: normalizedDeltaQuantity,
        operation: operation || 'anonymous'
      });
      throw error;
    }
  }

  async function flushPendingOperations() {
    var pending = readPendingOperations();
    var remaining = [];
    for (var i = 0; i < pending.length; i += 1) {
      var entry = pending[i];
      try {
        await applySummaryDelta(entry.dayKey, entry.deltaSales, entry.deltaCost, entry.deltaProfit, entry.deltaCount, entry.deltaQuantity, entry.operation);
      } catch (error) {
        remaining.push(entry);
      }
    }
    writePendingOperations(remaining);
    return remaining.length === 0;
  }

  async function applySaleCreate(sale) {
    var dayKey = toDayKey(sale && sale.timestamp);
    if (!dayKey) return null;
    var totals = getSaleTotals(sale);
    return applySummaryDelta(dayKey, totals.totalSales, totals.totalCost, totals.totalProfit, totals.salesCount, totals.totalQuantity, 'create:' + saleSignature(sale));
  }

  async function applySaleDelete(sale) {
    var dayKey = toDayKey(sale && sale.timestamp);
    if (!dayKey) return null;
    var totals = getSaleTotals(sale);
    return applySummaryDelta(dayKey, -totals.totalSales, -totals.totalCost, -totals.totalProfit, -totals.salesCount, -totals.totalQuantity, 'delete:' + saleSignature(sale));
  }

  async function applySaleUpdate(previousSale, nextSale) {
    if (!previousSale && !nextSale) return null;
    var previousDayKey = toDayKey(previousSale && previousSale.timestamp);
    var nextDayKey = toDayKey(nextSale && nextSale.timestamp);
    var previousTotals = getSaleTotals(previousSale);
    var nextTotals = getSaleTotals(nextSale);

    if (previousDayKey && nextDayKey && previousDayKey !== nextDayKey) {
      await applySummaryDelta(previousDayKey, -previousTotals.totalSales, -previousTotals.totalCost, -previousTotals.totalProfit, -previousTotals.salesCount, -previousTotals.totalQuantity, 'update-delete:' + saleSignature(previousSale) + '->' + saleSignature(nextSale));
      await applySummaryDelta(nextDayKey, nextTotals.totalSales, nextTotals.totalCost, nextTotals.totalProfit, nextTotals.salesCount, nextTotals.totalQuantity, 'update-create:' + saleSignature(previousSale) + '->' + saleSignature(nextSale));
      return true;
    }

    var targetDayKey = previousDayKey || nextDayKey;
    if (!targetDayKey) return null;

    var deltaSales = nextTotals.totalSales - previousTotals.totalSales;
    var deltaCost = nextTotals.totalCost - previousTotals.totalCost;
    var deltaProfit = nextTotals.totalProfit - previousTotals.totalProfit;
    var deltaQuantity = nextTotals.totalQuantity - previousTotals.totalQuantity;

    return applySummaryDelta(targetDayKey, deltaSales, deltaCost, deltaProfit, 0, deltaQuantity, 'update:' + saleSignature(previousSale) + '->' + saleSignature(nextSale));
  }

  function getTodaySummary() {
    var todayKey = toDayKey(Date.now());
    return {
      date: todayKey,
      totalSales: 0,
      totalCost: 0,
      totalProfit: 0,
      salesCount: 0,
      totalQuantity: 0,
      updatedAt: Date.now()
    };
  }

  window.DailySalesSummary = {
    toDayKey: toDayKey,
    saleRevision: saleRevision,
    isSaleActive: isSaleActive,
    applySaleMutationInTransaction: applySaleMutationInTransaction,
    getDefaultSummary: getDefaultSummary,
    normalizeSummary: normalizeSummary,
    readSummary: readSummary,
    applySummaryDelta: applySummaryDelta,
    applySaleCreate: applySaleCreate,
    applySaleDelete: applySaleDelete,
    applySaleUpdate: applySaleUpdate,
    flushPendingOperations: flushPendingOperations,
    getTodaySummary: getTodaySummary
  };

  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('online', function () { flushPendingOperations(); });
    flushPendingOperations();
  }
})();
