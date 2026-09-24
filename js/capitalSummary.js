(function (global) {
  'use strict';

  var state = {
    available: false,
    initialized: false,
    totalCapital: null,
    totalCapitalItemCount: null,
    totalCapitalUpdatedAt: null,
    totalCapitalVersion: null,
    inventoryVersion: null,
    lastItemMutationAt: null
  };

  function toNumber(value) {
    var number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function itemCapital(item) {
    if (!item || toNumber(item.quantity) <= 0) return 0;
    if (Array.isArray(item.purchaseBatches) && item.purchaseBatches.length) {
      return item.purchaseBatches.reduce(function (sum, batch) {
        return sum + toNumber(batch && batch.quantity) * toNumber(batch && batch.unitCost);
      }, 0);
    }
    return toNumber(item.purchasePrice) * Math.max(0, toNumber(item.quantity));
  }

  function itemCount(item) {
    return item && toNumber(item.quantity) > 0 ? 1 : 0;
  }

  function summaryIsComplete(data) {
    if (!data) return false;
    var hasRequiredTotals = Number.isFinite(Number(data.totalCapital)) && Number.isFinite(Number(data.totalCapitalItemCount)) && Number.isFinite(Number(data.totalCapitalVersion));
    var inventoryVersionIsPresent = data.inventoryVersion == null || Number.isFinite(Number(data.inventoryVersion));
    return hasRequiredTotals && inventoryVersionIsPresent;
  }

  function applyState(data) {
    state.available = summaryIsComplete(data);
    state.initialized = state.available;
    state.totalCapital = state.available ? Number(data.totalCapital) : null;
    state.totalCapitalItemCount = state.available ? Number(data.totalCapitalItemCount) : null;
    state.totalCapitalUpdatedAt = data && data.totalCapitalUpdatedAt != null ? data.totalCapitalUpdatedAt : null;
    state.totalCapitalVersion = data && data.totalCapitalVersion != null ? Number(data.totalCapitalVersion) : null;
    state.inventoryVersion = data && data.inventoryVersion != null ? Number(data.inventoryVersion) : null;
    state.lastItemMutationAt = data && data.lastItemMutationAt != null ? Number(data.lastItemMutationAt) : null;
    return getState();
  }

  function getState() {
    return Object.assign({}, state);
  }

  function firestoreIncrement(value) {
    return global.firebase.firestore.FieldValue.increment(Number(value) || 0);
  }

  function applyDeltaInTransaction(tx, beforeItem, afterItem) {
    if (!state.available) throw new Error('Capital summary is not initialized');
    var beforeCapital = itemCapital(beforeItem);
    var afterCapital = itemCapital(afterItem);
    var capitalDelta = afterCapital - beforeCapital;
    var itemCountDelta = itemCount(afterItem) - itemCount(beforeItem);
    if (capitalDelta === 0 && itemCountDelta === 0) return { capitalDelta: 0, itemCountDelta: 0 };
    var summaryRef = global.firebaseDb.collection('stats').doc('totals');
    var mutationTime = Date.now();
    tx.set(summaryRef, {
      totalCapital: firestoreIncrement(capitalDelta),
      totalCapitalItemCount: firestoreIncrement(itemCountDelta),
      totalCapitalUpdatedAt: mutationTime,
      totalCapitalVersion: firestoreIncrement(1),
      inventoryVersion: firestoreIncrement(1),
      lastItemMutationAt: mutationTime
    }, { merge: true });
    return { capitalDelta: capitalDelta, itemCountDelta: itemCountDelta };
  }

  function calculateItemsSummary(items) {
    return (Array.isArray(items) ? items : []).reduce(function (summary, item) {
      summary.totalCapital += itemCapital(item);
      summary.totalCapitalItemCount += itemCount(item);
      return summary;
    }, { totalCapital: 0, totalCapitalItemCount: 0 });
  }

  async function ensureInitialized(db, cachedItems) {
    if (state.available) return getState();
    if (!db || !db.collection) return getState();
    var summaryRef = db.collection('stats').doc('totals');
    var summarySnapshot;
    try {
      summarySnapshot = await summaryRef.get({ source: 'default' });
    } catch (error) {
      try { summarySnapshot = await summaryRef.get({ source: 'cache' }); } catch (cacheError) { return getState(); }
    }
    if (summarySnapshot && summarySnapshot.exists && summaryIsComplete(summarySnapshot.data())) {
      return applyState(summarySnapshot.data());
    }

    var itemsSnapshot;
    try {
      itemsSnapshot = await db.collection('items').get();
    } catch (error) {
      if (Array.isArray(cachedItems) && cachedItems.length) {
        var cachedSummary = calculateItemsSummary(cachedItems);
        itemsSnapshot = null;
        return initializeFromSummary(db, summaryRef, cachedSummary);
      }
      return getState();
    }
    var items = (itemsSnapshot.docs || []).map(function (doc) { return Object.assign({ id: doc.id }, doc.data()); });
    return initializeFromSummary(db, summaryRef, calculateItemsSummary(items));
  }

  async function initializeFromSummary(db, summaryRef, calculated) {
    var initializedData = null;
    await db.runTransaction(function (tx) {
      return tx.get(summaryRef).then(function (snapshot) {
        var existing = snapshot.exists ? snapshot.data() || {} : {};
        if (summaryIsComplete(existing)) {
          initializedData = existing;
          return;
        }
        var initializedAt = Date.now();
        initializedData = Object.assign({}, existing, {
          totalCapital: calculated.totalCapital,
          totalCapitalItemCount: calculated.totalCapitalItemCount,
          totalCapitalUpdatedAt: initializedAt,
          totalCapitalVersion: 1,
          inventoryVersion: existing.inventoryVersion != null ? Number(existing.inventoryVersion) : 0,
          lastItemMutationAt: initializedAt
        });
        tx.set(summaryRef, initializedData, { merge: true });
      });
    });
    return applyState(initializedData || {});
  }

  global.XMetalCapitalSummary = {
    itemCapital: itemCapital,
    itemCount: itemCount,
    calculateItemsSummary: calculateItemsSummary,
    applyDeltaInTransaction: applyDeltaInTransaction,
    ensureInitialized: ensureInitialized,
    applyState: applyState,
    getState: getState
  };
}(window));
