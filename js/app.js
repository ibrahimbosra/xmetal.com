// Initialize Firebase (using firebase-config.js)
const auth = window.firebaseAuth;
const db = window.firebaseDb;

if (!auth) {
  console.error('Firebase auth is not initialized. Check js/firebase-config.js for a valid configuration.');
}

// Use unified appState instead of global variables
// All state is now in: window.appState (defined in appState.js)

// Legacy variable shims for backward compatibility
// These will be removed in future refactoring
let allSales = [];
let allItems = [];
let allCategories = [];
let allExpenses = [];
let allActivity = [];
let allActivityFullLoaded = false;
let dashboardDailySalesSummary = null;
let productSalesSummaryCache = [];

// Sync functions to keep legacy code working
function syncStateToLegacy() {
  allSales = appState.data.sales;
  allItems = appState.data.items;
  allCategories = appState.data.categories;
  allExpenses = appState.data.expenses;
}

function syncLegacyToState() {
  appState.data.sales = allSales;
  appState.data.items = allItems;
  appState.data.categories = allCategories;
  appState.data.expenses = allExpenses;
}

// Helpers to update legacy lists and reflect into appState + UI
function updateAllItems(items) {
  allItems = items || [];
  try { if (window.appState && appState.setState) appState.setState('data.items', allItems); } catch (e) {}
  try { if (document.getElementById('itemsList')) renderInventory(); } catch (e) {}
}

function updateAllSales(sales) {
  allSales = sales || [];
  try { if (window.appState && appState.setState) appState.setState('data.sales', allSales); } catch (e) {}
  try { renderSalesLog(); } catch (e) {}
}

function updateAllCategories(categories) {
  allCategories = categories || [];
  try { if (window.appState && appState.setState) appState.setState('data.categories', allCategories); } catch (e) {}
}

// Compute average unit purchase price for an item (total capital / total qty)
function computeAveragePurchasePrice(item) {
  var totalQty = 0;
  var totalCost = 0;
  if (item.purchaseBatches && Array.isArray(item.purchaseBatches) && item.purchaseBatches.length) {
    item.purchaseBatches.forEach(function(b) {
      var q = Number(b.quantity) || 0;
      var c = Number(b.unitCost) || 0;
      totalQty += q;
      totalCost += q * c;
    });
    return totalQty > 0 ? totalCost / totalQty : (Number(item.purchasePrice) || 0);
  }
  return Number(item.purchasePrice) || 0;
}

function getItemInventoryCapital(item) {
  if (item.purchaseBatches && Array.isArray(item.purchaseBatches) && item.purchaseBatches.length) {
    return item.purchaseBatches.reduce(function(acc, b) {
      return acc + ((Number(b.quantity) || 0) * (Number(b.unitCost) || 0));
    }, 0);
  }
  return (Number(item.purchasePrice) || 0) * (Number(item.quantity) || 0);
}

function commitItemUpdate(item) {
  var index = (Array.isArray(allItems) ? allItems : []).findIndex(function(i) { return i && i.id === item.id; });
  if (index === -1) allItems = (Array.isArray(allItems) ? allItems : []).concat(item);
  else allItems[index] = item;
  updateAllItems(allItems);
}

function addSaleLocally(sale) {
  allSales = [sale].concat(allSales);
  updateAllSales(allSales);
}

function replaceSaleLocally(saleId, sale) {
  allSales = allSales.map(function(s) { return s.saleId === saleId ? sale : s; });
  updateAllSales(allSales);
}

function removeSaleLocally(saleId) {
  allSales = allSales.filter(function(s) { return s.saleId !== saleId; });
  updateAllSales(allSales);
}

function makeStableSaleId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return 'sale_' + window.crypto.randomUUID();
  }
  return 'sale_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
}

function readOfflineSaleQueue() {
  try {
    var raw = localStorage.getItem('xmetal_pending_sales_v1');
    if (!raw) return [];
    var parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function writeOfflineSaleQueue(queue) {
  try {
    localStorage.setItem('xmetal_pending_sales_v1', JSON.stringify(queue));
  } catch (e) {
    console.warn('Unable to persist offline sales queue', e);
  }
}

function enqueueSaleOperation(operation, sale, summaryContext) {
  if (!sale || !sale.saleId) return;
  var queue = readOfflineSaleQueue();
  var entry = {
    op: operation,
    saleId: sale.saleId,
    payload: JSON.parse(JSON.stringify(sale)),
    summaryContext: summaryContext ? JSON.parse(JSON.stringify(summaryContext)) : null,
    expectedRevision: summaryContext && summaryContext.expectedRevision != null ? summaryContext.expectedRevision : Math.max(0, (Number(sale.saleRevision) || 1) - 1),
    nextRevision: summaryContext && summaryContext.nextRevision != null ? summaryContext.nextRevision : (Number(sale.saleRevision) || 1),
    queuedAt: Date.now(),
    status: 'pending'
  };
  var existingIndex = queue.findIndex(function(item) { return item.saleId === entry.saleId && item.op === entry.op; });
  if (existingIndex >= 0) queue[existingIndex] = entry;
  else queue.push(entry);
  writeOfflineSaleQueue(queue);
}

async function flushPendingSalesOutbox() {
  if (!db || !navigator.onLine) return;
  var queue = readOfflineSaleQueue();
  if (!queue.length) return;
  var remaining = [];
  for (var i = 0; i < queue.length; i++) {
    var entry = queue[i];
    if (!entry || !entry.saleId || !entry.op) { continue; }
    try {
      await db.runTransaction(function (tx) {
        var saleRef = db.collection('sales').doc(entry.saleId);
        return tx.get(saleRef).then(function (snapshot) {
          var current = snapshot.exists ? Object.assign({ saleId: snapshot.id }, snapshot.data()) : null;
          var currentRevision = current ? (Number(current.saleRevision) || 1) : 0;
          if (entry.op === 'create') {
            if (current) return;
            return window.DailySalesSummary.applySaleMutationInTransaction(tx, null, entry.payload, 'create').then(function () { tx.set(saleRef, entry.payload); });
          }
          if (entry.op === 'update') {
            if (currentRevision > Number(entry.nextRevision || 0)) throw new Error('SALE_REVISION_STALE');
            if (currentRevision === Number(entry.nextRevision || 0)) return;
            if (currentRevision !== Number(entry.expectedRevision || 0)) throw new Error('SALE_REVISION_CONFLICT');
            if (!entry.summaryContext || !entry.summaryContext.previousSale) throw new Error('Missing dailySales update context');
            return window.DailySalesSummary.applySaleMutationInTransaction(tx, current, entry.summaryContext.nextSale || entry.payload, 'update').then(function () { tx.set(saleRef, entry.payload, { merge: true }); });
          }
          if (entry.op === 'delete') {
            if (!current || currentRevision > Number(entry.nextRevision || 0)) return;
            if (currentRevision !== Number(entry.expectedRevision || 0)) throw new Error('SALE_REVISION_CONFLICT');
            var cancelled = Object.assign({}, current, { saleRevision: Number(entry.nextRevision || currentRevision + 1), status: 'cancelled', cancelled: true, isCancelled: true });
            return window.DailySalesSummary.applySaleMutationInTransaction(tx, current, cancelled, 'cancel').then(function () { tx.delete(saleRef); });
          }
        });
      });
      await logActivity('sync', 'sale', entry.saleId, 'مزامنة عملية بيع محلية', { source: 'offlineQueue' });
    } catch (err) {
      remaining.push(entry);
      console.warn('Pending sale sync failed', err);
    }
  }
  writeOfflineSaleQueue(remaining);
}

window.flushPendingSalesOutbox = flushPendingSalesOutbox;

window.addEventListener('online', function() {
  try { flushPendingSalesOutbox(); } catch (e) { console.warn('Online sync flush failed', e); }
});

function applyInventoryDelta(item, delta) {
  item.quantity = (Number(item.quantity) || 0) + Number(delta);
  return item;
}

// Basic sale calculators
function calculateSaleTotal(unitPrice, quantity) {
  return Number(unitPrice || 0) * Number(quantity || 0);
}

function calculateSaleProfit(unitPrice, purchasePriceAtTime, quantity) {
  return (Number(unitPrice || 0) - Number(purchasePriceAtTime || 0)) * Number(quantity || 0);
}

// Update item quantity using a Firestore transaction to avoid race conditions
async function updateItemQuantityTransaction(itemId, delta) {
  var ref = db.collection('items').doc(itemId);
  return db.runTransaction(async function(tx) {
    var doc = await tx.get(ref);
    if (!doc.exists) throw new Error('Item not found');
    var beforeItem = { id: doc.id, ...doc.data() };
    var current = Number(beforeItem.quantity) || 0;
    var newQty = current + Number(delta);
    if (newQty < 0) throw new Error('Insufficient stock');
    var afterItem = Object.assign({}, beforeItem, { quantity: newQty, updatedAt: Date.now() });
    tx.update(ref, { quantity: newQty, updatedAt: afterItem.updatedAt });
    XMetalCapitalSummary.applyDeltaInTransaction(tx, beforeItem, afterItem);
    return newQty;
  });
}

// Compute allocations from purchaseBatches (FIFO) without mutating originals
function computeBatchAllocations(item, qtyToConsume) {
  var remaining = Number(qtyToConsume) || 0;
  var allocations = [];
  if (!item.purchaseBatches || !Array.isArray(item.purchaseBatches) || item.purchaseBatches.length === 0) {
    return allocations;
  }
  // sort by timestamp ascending
  var sorted = item.purchaseBatches.slice().sort(function(a, b) { return (a.timestamp || 0) - (b.timestamp || 0); });
  for (var i = 0; i < sorted.length && remaining > 0; i++) {
    var b = sorted[i];
    var avail = Number(b.quantity) || 0;
    if (avail <= 0) continue;
    var take = Math.min(avail, remaining);
    allocations.push({ timestamp: b.timestamp || null, unitCost: b.unitCost || 0, quantity: take });
    remaining -= take;
  }
  if (remaining > 0) {
    // not enough in batches, allocations incomplete
    return [];
  }
  return allocations;
}

// Apply allocations (consume) in a transaction: subtract quantities from matching batches and update total quantity
async function applyBatchAllocationsTransaction(itemId, allocations) {
  var ref = db.collection('items').doc(itemId);
  return db.runTransaction(async function(tx) {
    var doc = await tx.get(ref);
    if (!doc.exists) throw new Error('Item not found');
    var data = doc.data();
    var beforeItem = { id: doc.id, ...data };
    var batches = Array.isArray(data.purchaseBatches) ? data.purchaseBatches.slice() : [];
    var requestedQty = allocations.reduce(function(acc, alloc) { return acc + (Number(alloc.quantity) || 0); }, 0);
    var batchQtyTotal = batches.reduce(function(acc, b) { return acc + (Number(b.quantity) || 0); }, 0);
    var topLevelQty = Number(data.quantity) || 0;
    if (requestedQty > 0 && batchQtyTotal < requestedQty && topLevelQty >= requestedQty) {
      var missingQty = requestedQty - batchQtyTotal;
      batches.push({ quantity: missingQty, unitCost: 0, supplier: '', note: 'repaired-from-stock', timestamp: Date.now() });
    }
    // create map by timestamp to allow matching
    for (var a = 0; a < allocations.length; a++) {
      var alloc = allocations[a];
      var remaining = Number(alloc.quantity) || 0;
      // try to match by timestamp first
      for (var i = 0; i < batches.length && remaining > 0; i++) {
        if (alloc.timestamp != null && batches[i].timestamp && batches[i].timestamp === alloc.timestamp) {
          var curr = Number(batches[i].quantity) || 0;
          if (curr < remaining) throw new Error('Insufficient batch quantity during transaction');
          batches[i].quantity = curr - remaining;
          remaining = 0;
        }
      }
      // if still remaining, consume FIFO from any available batches
      for (var j = 0; j < batches.length && remaining > 0; j++) {
        var curr2 = Number(batches[j].quantity) || 0;
        if (curr2 <= 0) continue;
        var take = Math.min(curr2, remaining);
        batches[j].quantity = curr2 - take;
        remaining -= take;
      }
      if (remaining > 0) throw new Error('Insufficient batch quantity during transaction');
    }
    // compute new total quantity
    var totalQty = batches.reduce(function(acc, b) { return acc + (Number(b.quantity) || 0); }, 0);
    var afterItem = Object.assign({}, beforeItem, { purchaseBatches: batches, quantity: totalQty, updatedAt: Date.now() });
    tx.update(ref, { purchaseBatches: batches, quantity: totalQty, updatedAt: afterItem.updatedAt });
    XMetalCapitalSummary.applyDeltaInTransaction(tx, beforeItem, afterItem);
    return { purchaseBatches: batches, quantity: totalQty };
  });
}

// Restore allocations (add back quantities) in a transaction
async function restoreBatchAllocationsTransaction(itemId, allocations) {
  var ref = db.collection('items').doc(itemId);
  return db.runTransaction(async function(tx) {
    var doc = await tx.get(ref);
    if (!doc.exists) throw new Error('Item not found');
    var data = doc.data();
    var beforeItem = { id: doc.id, ...data };
    var batches = Array.isArray(data.purchaseBatches) ? data.purchaseBatches.filter(function(batch) { return batch && typeof batch === 'object'; }).slice() : [];
    var safeAllocations = Array.isArray(allocations) ? allocations.filter(function(alloc) { return alloc && typeof alloc === 'object'; }) : [];
    for (var a = 0; a < safeAllocations.length; a++) {
      var alloc = safeAllocations[a];
      if (!alloc) {
        console.warn('[DEBUG] restoreBatchAllocationsTransaction found null allocation before reading quantity', { itemId: itemId, index: a, allocations: allocations });
        continue;
      }
      var remaining = Number(alloc.quantity) || 0;
      if (remaining <= 0) {
        console.warn('[DEBUG] restoreBatchAllocationsTransaction skipped zero/invalid allocation', { itemId: itemId, alloc: alloc });
        continue;
      }
      // try to match by timestamp to restore to the same batch
      var matched = false;
      for (var i = 0; i < batches.length && remaining > 0; i++) {
        if (alloc.timestamp != null && batches[i].timestamp && batches[i].timestamp === alloc.timestamp) {
          batches[i].quantity = (Number(batches[i].quantity) || 0) + remaining;
          remaining = 0; matched = true; break;
        }
      }
      if (!matched) {
        // if no matching batch, append a new batch with allocation details
        batches.push({ quantity: remaining, unitCost: alloc.unitCost || 0, supplier: alloc.supplier || '', note: alloc.note || '', timestamp: alloc.timestamp || Date.now() });
        remaining = 0;
      }
    }
    var totalQty = batches.reduce(function(acc, b) { return acc + (Number(b.quantity) || 0); }, 0);
    var afterItem = Object.assign({}, beforeItem, { purchaseBatches: batches, quantity: totalQty, updatedAt: Date.now() });
    tx.update(ref, { purchaseBatches: batches, quantity: totalQty, updatedAt: afterItem.updatedAt });
    XMetalCapitalSummary.applyDeltaInTransaction(tx, beforeItem, afterItem);
    return { purchaseBatches: batches, quantity: totalQty };
  });
}

function buildSaleObject(item, qty, price, currency, purchasePriceAtTime) {
  if (!item || item.id === undefined || item.id === null || String(item.id).trim() === '') throw new Error('معرف المنتج غير موجود');
  var costBasis = purchasePriceAtTime != null ? purchasePriceAtTime : item.purchasePrice;
  var totalAmount = calculateSaleTotal(price, qty);
  return {
    itemId: String(item.id),
    itemName: item.name,
    quantity: qty,
    unitPrice: price,
    totalAmount: totalAmount,
    baseAmount: totalAmount,
    baseCurrency: 'primary',
    displayTotalAmount: totalAmount,
    rawTotalAmount: totalAmount,
    displayCurrency: 'primary',
    profit: calculateSaleProfit(price, costBasis, qty),
    purchasePriceAtTime: costBasis,
    rateAtTime: null,
    timestamp: Date.now(),
    saleMode: 'primary'
  };
}

let allSalesFullLoaded = false;
let currencySettings = (window && window.CurrencyModel && typeof window.CurrencyModel.normalizeSettings === 'function') ? window.CurrencyModel.normalizeSettings({ baseCurrency: 'primary', defaultInputMode: 'primary', defaultSaleMode: 'primary', enablePurchaseBatches: false }) : { baseCurrency: 'primary', defaultInputMode: 'primary', defaultSaleMode: 'primary', enablePurchaseBatches: false };
function getSystemCurrency() {
  return currencySettings.baseCurrency === '' ? '' : 'primary';
}
function normalizeCurrencySettings(settings) {
  var source = Object.assign({}, currencySettings, settings || {});
  if (window && window.CurrencyModel && typeof window.CurrencyModel.normalizeSettings === 'function') {
    var normalized = window.CurrencyModel.normalizeSettings(source);
    currencySettings = normalized;
    return normalized;
  }
  var next = { ...currencySettings, ...(settings || {}) };
  next.baseCurrency = 'primary';
  next.defaultInputMode = 'primary';
  next.defaultSaleMode = 'primary';
  currencySettings = next;
  return next;
}
function applySystemCurrencyDefaults() {
  var baseCurrency = getSystemCurrency();
  currencySettings.defaultInputMode = baseCurrency;
  currencySettings.defaultSaleMode = baseCurrency;
  tempPurchaseMode = false;
  tempSaleCurrency = false;
  tempMechanicMode = false;
  tempSellMode = false;
}
let userDisplayNameSettings = {};
let storeInfoData = {};
let mainDebtCustomers = [];
let mainDebtOperations = [];
let mainDebtSelectedCustomerId = null;
let mobileSalesAdminAccount = { uid: '', email: '' };
let currentSection = 'dashboard';
let previousSection = 'dashboard';  // لتذكر القسم السابق قبل البحث
let isSearchActive = false;  // حالة البحث الحالية
let salesPage = 0,
  salesQueryCache = { lastDoc: null, hasMore: true, currentPageItems: [] };
let salesPageSize = 25;
let salesPageCursors = [null];
let salesPageItemsCache = {};
let salesFilterParams = { period: 'all', searchTerm: '', categoryId: '', productId: '', minQty: '', maxQty: '',
  minProfit: '', maxProfit: '', minProfitPct: '', maxProfitPct: '' };
let activityPage = 0,
  activityPageSize = 25,
  activityQueryCache = { lastDoc: null, hasMore: true, currentPageItems: [] };
let activityPageCursors = [null];
let activityPageItemsCache = {};
let activityFilterParams = { period: 'all', searchTerm: '', actionType: '', entity: '', user: '', customStart: null, customEnd: null };
let allCharts = {};
let darkMode = localStorage.getItem('xmetalDarkMode') === 'true';
let displayPrimaryCurrency = false;
let realtimeListeners = [];
let itemsListenerStarted = false;
let itemsListenerReadyPromise = null;
let itemsListenerReadyResolve = null;
let itemsListenerReadyReject = null;
let productSalesSummaryListenerStarted = false;
let productSalesSummaryListenerUnsub = null;
let productSalesSummaryLoadingPromise = null;
let searchDebounceTimer = null;
let itemVisibility = {};
let showMechanicPricesGlobally = false;
let currentItemId = null,
  isEditingItem = false;
let tempPurchaseMode = false,
  tempSaleCurrency = false,
  tempMechanicMode = false,
  tempSellMode = false,
  tempEditMode = false;
let currentThumbnails = [];
let currentInventoryFilter = 'all';
let currentInventorySort = (window.appState && appState.getState && appState.getState('filters.inventorySort')) || localStorage.getItem('xmetalInventorySort') || 'alphabetical';
let hasFetchedSales = false;
let comparisonManualRows = null;
window._cachedStats = { allTimeProfit: 0, allTimeProfitLoaded: false };
window._targetAlertShown = false;
const CACHE_TTL = 3600000;
const chartColors = ['#2b6cb0', '#27ae60', '#f97316', '#e55353', '#6b46c1', '#0987a0', '#d69e2e', '#3182ce',
  '#38a169', '#dd6b20', '#c53030', '#805ad5', '#00b5d8', '#b7791f'
];
const popularIcons = [
  "fa-solid fa-tag", "fa-solid fa-percent", "fa-solid fa-gift", "fa-solid fa-star",
  "fa-solid fa-fire", "fa-solid fa-bolt", "fa-solid fa-bell", "fa-solid fa-calendar",
  "fa-solid fa-clock", "fa-solid fa-truck", "fa-solid fa-phone", "fa-solid fa-envelope",
  "fa-solid fa-location-dot", "fa-solid fa-heart", "fa-solid fa-thumbs-up", "fa-solid fa-share",
  "fa-solid fa-circle-info", "fa-solid fa-triangle-exclamation", "fa-solid fa-circle-check",
  "fa-solid fa-circle-xmark", "fa-solid fa-snowflake", "fa-solid fa-sun", "fa-solid fa-moon",
  "fa-solid fa-crown", "fa-solid fa-medal", "fa-solid fa-trophy", "fa-solid fa-rocket",
  "fa-solid fa-paper-plane", "fa-solid fa-comment", "fa-solid fa-bullhorn", "fa-solid fa-megaphone",
  "fa-solid fa-hand-point-right", "fa-solid fa-arrow-right", "fa-solid fa-angles-right",
  "fa-solid fa-cart-shopping", "fa-solid fa-credit-card", "fa-solid fa-wallet",
  "fa-solid fa-coins", "fa-solid fa-sack-dollar", "fa-solid fa-hand-holding-dollar",
  "fa-brands fa-whatsapp", "fa-brands fa-facebook", "fa-brands fa-instagram",
  "fa-brands fa-tiktok", "fa-brands fa-youtube", "fa-solid fa-motorcycle",
  "fa-solid fa-burger", "fa-solid fa-pizza-slice", "fa-solid fa-mug-hot",
  "fa-solid fa-wrench", "fa-solid fa-gear", "fa-solid fa-shield-halved",
  "fa-solid fa-certificate", "fa-solid fa-award", "fa-solid fa-ranking-star"
];

function fmt(n) { return Number(n || 0).toFixed(2); }
function fmtMoney(n) {
  var num = Number(n || 0);
  if (isNaN(num)) return '0';
  if (Number.isInteger(num)) return String(num);
  var formatted = Number(num.toFixed(2));
  return String(formatted).replace(/(?:\.0+|(\.\d+?)0+)$/, '$1');
}
function fmtQty(n) {
  var num = Number(n || 0);
  if (isNaN(num)) return '0';
  if (Number.isInteger(num)) return String(num);
  return String(Number(num.toFixed(2))).replace(/(?:\.0+|(\.\d+?)0+)$/, '$1');
}
function fmtInt(n) { return parseInt(n || 0, 10); }
// Robust numeric parser for user input. Returns null for empty/invalid input.
function parseInputNumber(value) {
  if (value === null || value === undefined) return null;
  var s = String(value).trim();
  if (s === '') return null;
  // Accept both comma and dot decimals, strip currency symbols/spaces
  s = s.replace(/,/g, '.');
  s = s.replace(/[^0-9.\-]/g, '');
  if (s === '' || s === '.' || s === '-' ) return null;
  var n = parseFloat(s);
  return isNaN(n) ? null : n;
}
var SYSTEM_TIME_ZONE = 'Asia/Riyadh';
function systemDateParts(ts) {
  var d = new Date(ts);
  if (!ts || isNaN(d.getTime())) return null;
  var parts = new Intl.DateTimeFormat('en-CA', { timeZone: SYSTEM_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  var values = {};
  parts.forEach(function (part) { if (part.type !== 'literal') values[part.type] = part.value; });
  return values;
}
function formatDateString(ts, includeTime) {
  var values = systemDateParts(ts);
  if (!values) return '';
  var datePart = values.day + '/' + values.month + '/' + values.year;
  return includeTime ? datePart + ' ' + values.hour + ':' + values.minute : datePart;
}
function fmtDate(ts) { return formatDateString(ts, false); }
function fmtDateTime(ts) { return formatDateString(ts, true); }
function formatDateSeparatorLabel(ts) {
  var d = new Date(ts);
  if (!ts || isNaN(d.getTime())) return '';
  var weekday = d.toLocaleDateString('ar-EG', { weekday: 'long', timeZone: SYSTEM_TIME_ZONE });
  return weekday + ' ' + formatDateString(ts, false);
}
function getDayKey(ts) { var values = systemDateParts(ts); return values ? values.year + '-' + values.month + '-' + values.day : ''; }
function getMonthKey(ts) { var values = systemDateParts(ts); return values ? values.year + '-' + values.month : ''; }
function getYearKey(ts) { var values = systemDateParts(ts); return values ? String(values.year) : ''; }
function escHtml(s) { if (!s) return ''; return s.replace(/[&<>]/g, function(m) { if (m === '&') return '&amp;';
    if (m === '<') return '&lt;'; if (m === '>') return '&gt;'; return m; }); }
function escJsString(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
function getFirebaseErrorMessage(e) {
  if (!e) return 'حدث خطأ غير متوقع';
  var map = {
    'auth/invalid-email': 'البريد الإلكتروني غير صالح',
    'auth/user-disabled': 'تم تعطيل هذا الحساب',
    'auth/user-not-found': 'بيانات الدخول غير صحيحة',
    'auth/wrong-password': 'بيانات الدخول غير صحيحة',
    'auth/invalid-credential': 'بيانات الدخول غير صحيحة',
    'permission-denied': 'لا تملك صلاحية للوصول إلى البيانات',
    'failed-precondition': 'يلزم إنشاء فهرس في Firebase — راجع Console',
    'unavailable': 'الخدمة غير متاحة مؤقتاً، حاول لاحقاً'
  };
  return map[e.code] || e.message || 'حدث خطأ غير متوقع';
}
function parseDateString(value, endOfDay) {
  if (!value || !String(value).trim()) return null;
  var text = String(value).trim();
  var date = null;
  // Interpret date-only values in the system timezone.
  var ymdMatch = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (ymdMatch) {
    date = new Date(Date.parse(ymdMatch[1] + '-' + String(ymdMatch[2]).padStart(2, '0') + '-' + String(ymdMatch[3]).padStart(2, '0') + 'T00:00:00+03:00'));
  } else {
    date = new Date(text);
    if (isNaN(date.getTime())) {
      var parts = text.split(/[-\/\.\s:]+/).map(function(p) { return parseInt(p, 10); });
      if (parts.length >= 3 && parts[0] && parts[1] && parts[2]) {
        date = new Date(parts[0], parts[1] - 1, parts[2], parts[3] || 0, parts[4] || 0);
      }
    }
  }
  if (isNaN(date.getTime())) return null;
  if (ymdMatch) {
    var dateKey = ymdMatch[1] + '-' + String(ymdMatch[2]).padStart(2, '0') + '-' + String(ymdMatch[3]).padStart(2, '0');
    date = new Date(Date.parse(dateKey + (endOfDay ? 'T23:59:59.999+03:00' : 'T00:00:00+03:00')));
  } else if (endOfDay) { date.setHours(23, 59, 59, 999); }
  return date.getTime();
}
function showFirestoreError(e, context) {
  // Use unified error handler
  const error = errorHandler.handleFirebaseError(e, context);
  showErrorToast(error.message);
}
function convertToSecondary(a) {
  return Number(a) || 0;
}
function convertToPrimary(a) {
  return Number(a) || 0;
}
function getConversionDisplay(value, isInputSecondary, symbol) {
  return '$ ' + fmtMoney(Number(value) || 0);
}
function calcProfitMarginPct(purchasePrice, salePrice) {
  var p = Number(purchasePrice) || 0,
    s = Number(salePrice) || 0;
  if (p <= 0) return s > 0 ? '—' : '0.00';
  return (((s - p) / p) * 100).toFixed(2);
}
function getSalesRealtimeCutoff() {
  return Date.now() - 365 * 86400000;
}
function showToast(msg, type) {
  var t = document.createElement('div');
  t.className = 'toast' + (type === 'error' ? ' error' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(function() { t.remove(); }, type === 'error' ? 5000 : 3000);
}
function closeModalById(id) { document.getElementById(id).classList.remove('show'); }
function formatMoney(amount) {
  var num = Number(amount || 0);
  return '$' + fmtMoney(num);
}
function formatMoneyPlain(amount) {
  var num = Number(amount || 0);
  return fmtMoney(num);
}
function saleDisplayTotal(sale) {
  if (!sale) return 0;
  var baseAmount = Number(sale.baseAmount != null ? sale.baseAmount : sale.totalAmount) || 0;
  var explicitDisplay = Number(sale.displayTotalAmount != null ? sale.displayTotalAmount : sale.rawTotalAmount);
  if (Number.isFinite(explicitDisplay) && (sale.displayTotalAmount != null || sale.rawTotalAmount != null)) return explicitDisplay;
  return baseAmount;
}
function saleDisplayUnitPrice(sale) {
  var quantity = Number(sale && sale.quantity) || 0;
  return quantity > 0 ? saleDisplayTotal(sale) / quantity : 0;
}
function formatSaleMoney(sale, baseAmount) {
  var value = Number(baseAmount) || 0;
  return '$ ' + fmtMoney(value);
}
function formatSaleUnitMoney(sale) {
  var value = Number(sale && sale.unitPrice) || 0;
  return '$ ' + fmtMoney(value);
}

var cairoCairoRegularWoff2Base64 = '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';

function registerCairoPdfFont(doc) {
  if (!doc || typeof doc.addFileToVFS !== 'function' || typeof doc.addFont !== 'function') return;
  if (doc.internal && doc.internal.events && doc.internal.events['getFontList'] && doc.getFontList && doc.getFontList().Cairo) return;
  try {
    doc.addFileToVFS('Cairo-Regular.woff2', cairoCairoRegularWoff2Base64);
    doc.addFont('Cairo-Regular.woff2', 'Cairo', 'normal');
  } catch (e) {
    console.warn('Failed to register Cairo font for PDF export:', e);
  }
}

async function logActivity(actionType, entity, entityId, details, metadata) {
  try {
    var docRef = await db.collection('activityLog').add({
      timestamp: Date.now(),
      actionType: actionType || '',
      entity: entity || '',
      entityId: entityId || null,
      details: details || '',
      user: (auth.currentUser && auth.currentUser.email) ? auth.currentUser.email : 'unknown',
      metadata: metadata || {}
    });
    if (allActivityFullLoaded) {
      allActivity.unshift({
        id: docRef.id,
        timestamp: Date.now(),
        actionType: actionType || '',
        entity: entity || '',
        entityId: entityId || null,
        details: details || '',
        user: (auth.currentUser && auth.currentUser.email) ? auth.currentUser.email : 'unknown',
        metadata: metadata || {}
      });
    }
  } catch (e) {
    console.warn('Activity log failed:', e);
  }
}

function getActivityLabel(type) {
  var map = {
    create: 'إنشاء',
    update: 'تعديل',
    delete: 'حذف',
    sell: 'بيع',
    cancelSale: 'إلغاء بيع',
    archive: 'أرشفة',
    assign: 'تعيين',
    setting: 'تعديل إعداد',
    expenseAdd: 'إضافة مصروف',
    expenseDelete: 'حذف مصروف',
    currencyUpdate: 'تحديث العملة',
    storeUpdate: 'تحديث بيانات المتجر',
    targetUpdate: 'تحديث الهدف'
  };
  return map[type] || type || '--';
}

function getEntityLabel(entity) {
  var map = {
    item: 'منتج',
    sale: 'بيع',
    category: 'فئة',
    expense: 'مصروف',
    storeInfo: 'المتجر',
    currencySettings: 'إعدادات العملة',
    target: 'هدف',
    salesArchive: 'أرشيف المبيعات'
  };
  return map[entity] || entity || '--';
}

function formatActivityChangeValue(value, formatter) {
  if (formatter) return formatter(value);
  if (value === null || value === undefined) return '--';
  if (typeof value === 'boolean') return value ? 'نعم' : 'لا';
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'لا يوجد';
  if (typeof value === 'object') return JSON.stringify(value);
  return escHtml(String(value));
}

function buildItemChangeDetails(oldItem, newItem) {
  var fields = [
    { key: 'name', label: 'الاسم' },
    { key: 'location', label: 'مكان القطعة' },
    { key: 'purchasePrice', label: 'سعر الشراء', formatter: function(v) { return v === null || v === undefined ? '--' : fmt(v); } },
    { key: 'salePrice', label: 'سعر البيع', formatter: function(v) { return v === null || v === undefined ? '--' : fmt(v); } },
    { key: 'quantity', label: 'الكمية' },
    { key: 'categoryName', label: 'الفئة' },
  ];
  var changes = [];
  var metadata = {};
  function valuesDiffer(oldVal, newVal) {
    if (oldVal === newVal) return false;
    if (typeof oldVal === 'number' && typeof newVal === 'number' && isNaN(oldVal) && isNaN(newVal)) return false;
    if (typeof oldVal === 'object' || typeof newVal === 'object') {
      return JSON.stringify(oldVal) !== JSON.stringify(newVal);
    }
    return true;
  }
  fields.forEach(function(field) {
    var oldVal = oldItem[field.key];
    var newVal = newItem[field.key];
    if (valuesDiffer(oldVal, newVal)) {
      changes.push(field.label + ' من ' + formatActivityChangeValue(oldVal, field.formatter) + ' إلى ' + formatActivityChangeValue(newVal, field.formatter));
      metadata[field.key] = { from: oldVal, to: newVal };
    }
  });
  return { details: changes.join('، '), metadata: metadata, beforeSnapshot: oldItem, afterSnapshot: newItem };
}

function buildProductDetailsSummary(item) {
  var locationText = item.location ? '، مكان القطعة: ' + item.location : '';
  return 'سعر الشراء: ' + fmtMoney(item.purchasePrice) + '، سعر البيع: ' + fmtMoney(item.salePrice) + '، الكمية: ' + (item.quantity || 0) + '، الفئة: ' + (item.categoryName || 'بدون فئة') + locationText;
}

function buildCurrencyChangeDetails(oldSettings, newSettings) {
  var fields = [
    { key: 'CurrencyName', label: 'اسم العملة' },
    { key: 'CurrencySymbol', label: 'رمز العملة' },
    { key: 'rate', label: 'سعر الصرف', formatter: function(v) { return v === null || v === undefined ? '--' : fmt(v); } },
    { key: 'showProductPrices', label: 'عرض أسعار المنتجات بالعملتين في صفحة الهاتف', formatter: function(v) { return v ? 'مفعّل' : 'غير مفعّل'; } },
    { key: 'enablePurchaseBatches', label: 'تفعيل دفعات الشراء', formatter: function(v) { return v ? 'مفعل' : 'معطل'; } },
    { key: 'defaultInputMode', label: 'العملة الافتراضية للإدخال' },
    { key: 'defaultSaleMode', label: 'العملة الافتراضية للبيع' }
  ];
  var changes = [];
  var metadata = {};
  function valuesDiffer(oldVal, newVal) {
    if (oldVal === newVal) return false;
    if (typeof oldVal === 'number' && typeof newVal === 'number' && isNaN(oldVal) && isNaN(newVal)) return false;
    if (typeof oldVal === 'object' || typeof newVal === 'object') {
      return JSON.stringify(oldVal) !== JSON.stringify(newVal);
    }
    return true;
  }
  fields.forEach(function(field) {
    var oldVal = oldSettings[field.key];
    var newVal = newSettings[field.key];
    if (valuesDiffer(oldVal, newVal)) {
      changes.push(field.label + ' من ' + formatActivityChangeValue(oldVal, field.formatter) + ' إلى ' + formatActivityChangeValue(newVal, field.formatter));
      metadata[field.key] = { from: oldVal, to: newVal };
    }
  });
  return { details: changes.join('، '), metadata: { changes: metadata, before: oldSettings, after: newSettings } };
}

function normalizeActivityRecord(item) {
  if (!item || typeof item !== 'object') return item || {};
  var normalized = Object.assign({}, item);
  normalized.actionType = normalized.actionType || normalized.action || '';
  normalized.entity = normalized.entity || normalized.entityType || '';
  normalized.entityId = normalized.entityId || normalized.entityID || normalized.id || null;
  normalized.details = normalized.details || normalized.message || '';
  normalized.user = normalized.user || normalized.sellerEmail || normalized.email || normalized.actor || '';
  if (!normalized.id && normalized.docId) normalized.id = normalized.docId;
  return normalized;
}

function formatActivityDetails(details) {
  return escHtml(details || '');
}

function getActivityShortSummary(item) {
  if (item && item.shortSummary) return escHtml(item.shortSummary);
  switch (item && item.actionType) {
    case 'create': return 'إضافة منتج';
    case 'update': return 'تعديل منتج';
    case 'delete': return 'حذف';
    case 'sell': return 'بيع';
    case 'cancelSale': return 'إلغاء بيع';
    case 'archive': return 'أرشفة';
    case 'assign': return 'تعيين';
    case 'setting': return 'تعديل إعداد';
    case 'expenseAdd': return 'إضافة مصروف';
    case 'expenseDelete': return 'حذف مصروف';
    case 'currencyUpdate': return 'تعديل سعر الصرف';
    case 'storeUpdate': return 'تحديث بيانات المتجر';
    case 'targetUpdate': return 'تحديث الهدف';
    default: return item && item.details ? escHtml(item.details.split('،')[0]) : '--';
  }
}

function getActivityDisplayValue(value) {
  if (typeof value === 'string') return escHtml(value);
  return escHtml(JSON.stringify(value || '')); 
}

function getActivitySummaryCount(items, actionType) {
  return items.filter(function(item) { return item.actionType === actionType; }).length;
}

function getActivityPeriodLabel(period) {
  switch (period) {
    case 'today': return 'اليوم';
    case 'week': return 'هذا الأسبوع';
    case 'month': return 'هذا الشهر';
    case 'year': return 'هذه السنة';
    case 'custom': return 'مخصص';
    default: return 'الكل';
  }
}

function getActivityPeriodDates(period) {
  var now = Date.now();
  if (period === 'today') return { start: getStartOfDay(), end: now };
  if (period === 'week') return { start: getStartOfWeek(), end: now };
  if (period === 'month') return { start: getStartOfMonth(), end: now };
  if (period === 'year') return { start: getStartOfYear(), end: now };
  return { start: null, end: null };
}

function getActivityFilterPeriodTitle(period) {
  return getActivityPeriodLabel(period);
}

function getActivityTextSummary(items) {
  return items.length + ' سجل';
}

function getActivityTableRow(item, index) {
  return '<tr><td>' + (index + 1) + '</td><td>' + fmtDateTime(item.timestamp) + '</td><td>' + escHtml(getActivityLabel(item.actionType)) + '</td><td>' + escHtml(getEntityLabel(item.entity)) + '</td><td>' + getActivityShortSummary(item) + '</td><td>' + escHtml(item.user || '--') + '</td><td><button type="button" onclick="viewActivityLogDetail(\'' + escJsString(item.id) + '\')" style="background:var(--primary-light);color:var(--primary);border:none;border-radius:20px;padding:5px 12px;cursor:pointer;font-size:0.72rem;font-weight:600;">عرض</button></td></tr>';
          '<button onclick="editActivityLogDetail(\'' + escJsString(item.id) + '\')" style="background:var(--accent-light);color:var(--accent);border:none;border-radius:20px;padding:5px 12px;cursor:pointer;font-size:0.72rem;font-weight:600;margin-left:6px;">تعديل</button>' +
          '</td></tr>';
}

function buildActivitySummaryCards(items) {
  var total = items.length;
  return '<div class="stat-card"><div class="stat-label">العمليات في الصفحة</div><div class="stat-value">' + total + '</div></div>' +
    '<div class="stat-card"><div class="stat-label">إنشاء</div><div class="stat-value">' + getActivitySummaryCount(items, 'create') + '</div></div>' +
    '<div class="stat-card"><div class="stat-label">تعديل</div><div class="stat-value">' + getActivitySummaryCount(items, 'update') + '</div></div>' +
    '<div class="stat-card"><div class="stat-label">حذف</div><div class="stat-value">' + getActivitySummaryCount(items, 'delete') + '</div></div>';
}

function getCustomDateValue(ts) {
  return ts ? new Date(ts).toISOString().split('T')[0] : '';
}

function getActivityFilterInputDate(value, isEnd) {
  if (!value) return '';
  return new Date(value).toISOString().split('T')[0];
}

function getActivityFilterDateValue(ts) {
  if (!ts) return '';
  return new Date(ts).toISOString().split('T')[0];
}

function getActivityFilterDateString(ts) {
  return fmtDate(ts);
}

function getActivityRowCount(items) {
  return items.length;
}

function getActivityCardSubtitle(items) {
  return 'آخر تحديث: ' + fmtDateTime(Date.now());
}

function getFormattedActivityDetails(item) {
  var md = item.metadata || {};
  var metaText = '';
  for (var key in md) {
    if (md.hasOwnProperty(key)) {
      metaText += '<div><strong>' + escHtml(key) + ':</strong> ' + escHtml(JSON.stringify(md[key])) + '</div>';
    }
  }
  return '<div style="display:grid;gap:10px;">' +
    '<div><strong>الإجراء:</strong> ' + escHtml(getActivityLabel(item.actionType)) + '</div>' +
    '<div><strong>الكيان:</strong> ' + escHtml(getEntityLabel(item.entity)) + '</div>' +
    '<div><strong>التفاصيل:</strong> ' + formatActivityDetails(item.details) + '</div>' +
    '<div><strong>المستخدم:</strong> ' + escHtml(item.user || '--') + '</div>' +
    '<div><strong>الوقت:</strong> ' + fmtDateTime(item.timestamp) + '</div>' + metaText + '</div>';
}

function getActivityFilterValue(value) {
  return value || '';
}

function getActivityFilters() {
  return activityFilterParams;
}

function safeActivityInput(value) {
  return escHtml(value || '');
}

function formatActivityFilterPlaceholder(field) {
  switch (field) {
    case 'searchTerm': return 'بحث في التفاصيل أو المستخدم';
    default: return '';
  }
}

function getActivitySearchTerm(term) {
  return term || '';
}

function getActivityFilterOptions() {
  return {
    actionTypes: [
      { value: '', label: 'كل الإجراءات' },
      { value: 'create', label: 'إنشاء' },
      { value: 'update', label: 'تعديل' },
      { value: 'delete', label: 'حذف' },
      { value: 'sell', label: 'بيع' },
      { value: 'cancelSale', label: 'إلغاء بيع' },
      { value: 'archive', label: 'أرشفة' },
      { value: 'assign', label: 'تعيين' },
      { value: 'expenseAdd', label: 'إضافة مصروف' },
      { value: 'expenseDelete', label: 'حذف مصروف' },
      { value: 'currencyUpdate', label: 'تحديث العملة' },
      { value: 'storeUpdate', label: 'تحديث المتجر' },
      { value: 'targetUpdate', label: 'تحديث الهدف' }
    ],
    entities: [
      { value: '', label: 'كل الكيانات' },
      { value: 'item', label: 'منتج' },
      { value: 'sale', label: 'بيع' },
      { value: 'category', label: 'فئة' },
      { value: 'expense', label: 'مصروف' },
      { value: 'storeInfo', label: 'المتجر' },
      { value: 'currencySettings', label: 'إعدادات العملة' },
      { value: 'target', label: 'هدف' },
      { value: 'salesArchive', label: 'أرشيف المبيعات' }
    ]
  };
}

function buildActivityFilterSelect(options, selected) {
  return options.map(function(opt) { return '<option value="' + opt.value + '" ' + (selected === opt.value ? 'selected' : '') + '>' + escHtml(opt.label) + '</option>'; }).join('');
}

function getActivityFilterPeriodOptions() {
  return [
    { value: 'all', label: 'كل الفترات' },
    { value: 'today', label: 'اليوم' },
    { value: 'week', label: 'هذا الأسبوع' },
    { value: 'month', label: 'هذا الشهر' },
    { value: 'year', label: 'هذا السنة' },
    { value: 'custom', label: 'مخصص' }
  ];
}

function getExportActivityFilename() {
  return 'activity_log_' + new Date().toISOString().split('T')[0];
}

function formatActivityPdfTitle() {
  return 'تقرير سجل العمليات';
}

function getActivityTableHeaders() {
  return ['#', 'التاريخ', 'الإجراء', 'الكيان', 'التفاصيل', 'المستخدم'];
}

function buildActivityPdfRows(items) {
  return items.map(function(item, i) { return [i + 1, fmtDateTime(item.timestamp), getActivityLabel(item.actionType), getEntityLabel(item.entity), item.details || '', item.user || '']; });
}

function getActivitySearchPlaceholder() {
  return '🔍 بحث في السجل';
}

function getActivityFiltersRowHTML() {
  var options = getActivityFilterOptions();
  var sp = activityFilterParams;
  return '<select id="afPeriod" onchange="updateActivityFilter(\'period\',this.value)">' + buildActivityFilterSelect(getActivityFilterPeriodOptions(), sp.period) + '</select>' +
    '<select id="afActionType" onchange="updateActivityFilter(\'actionType\',this.value)">' + buildActivityFilterSelect(options.actionTypes, sp.actionType) + '</select>' +
    '<select id="afEntity" onchange="updateActivityFilter(\'entity\',this.value)">' + buildActivityFilterSelect(options.entities, sp.entity) + '</select>' +
    '<input type="text" id="afSearch" placeholder="' + getActivitySearchPlaceholder() + '" value="' + escHtml(sp.searchTerm) + '" oninput="debouncedActivitySearchUpdate(this.value)" style="max-width:220px;">' +
    '<input type="text" id="afUser" placeholder="المستخدم" value="' + escHtml(sp.user) + '" onchange="updateActivityFilter(\'user\',this.value)" style="max-width:150px;">' +
    (sp.period === 'custom' ? '<input type="text" class="date-input" readonly id="afCustomStart" placeholder="YYYY-MM-DD" value="' + (sp.customStart ? new Date(sp.customStart).toISOString().split('T')[0] : '') + '" onchange="updateActivityFilter(\'customStart\',parseDateString(this.value,false))" style="max-width:140px;margin-right:8px;">' +
      '<span style="font-weight:700;color:var(--text3);margin:0 8px;">إلى</span>' +
      '<input type="text" class="date-input" readonly id="afCustomEnd" placeholder="YYYY-MM-DD" value="' + (sp.customEnd ? new Date(sp.customEnd).toISOString().split('T')[0] : '') + '" onchange="updateActivityFilter(\'customEnd\',parseDateString(this.value,true))" style="max-width:140px;">' : '') +
    '<button class="btn-sm outline" onclick="resetActivityFilters()">مسح الفلاتر</button>';
}

function getActivityLabelForExport(type) {
  return getActivityLabel(type);
}

function getEntityLabelForExport(entity) {
  return getEntityLabel(entity);
}

function getActivityCsvRow(item, index) {
  return [index + 1, fmtDateTime(item.timestamp), getActivityLabelForExport(item.actionType), getEntityLabelForExport(item.entity), item.details || '', item.user || ''];
}

function getActivityPdfBody(items) {
  return buildActivityPdfRows(items);
}

function getActivityExportRows(items) {
  return items.map(getActivityCsvRow);
}

function getActivityExportHeaders() {
  return getActivityTableHeaders();
}

function getCurrentUserEmail() {
  return (auth.currentUser && auth.currentUser.email) ? auth.currentUser.email : 'unknown';
}

function updateActivityFilterField(key, value) {
  activityFilterParams[key] = value;
  activityPage = 0;
  activityPageCursors = [null];
  activityPageItemsCache = {};
  activityQueryCache = { lastDoc: null, hasMore: true, currentPageItems: [] };
  renderActivityLog();
}

function getActivitySearchPhrase(value) {
  return value || '';
}

function getActivityDetailsValue(value) {
  return value || '--';
}

function buildActivityQueryForFilter(query, params) {
  if (params.actionType) query = query.where('actionType', '==', params.actionType);
  if (params.entity) query = query.where('entity', '==', params.entity);
  if (params.user) query = query.where('user', '==', params.user);
  return query;
}

function activityMatchesSearch(item, term) {
  if (!term) return true;
  term = term.toLowerCase();
  return (item.details || '').toLowerCase().includes(term) || (item.user || '').toLowerCase().includes(term) || (item.entity || '').toLowerCase().includes(term) || (item.actionType || '').toLowerCase().includes(term);
}

function buildActivitySearchPlaceholder() {
  return 'بحث في النشاط';
}

function getActivityPageLabel() {
  return 'صفحة ' + (activityPage + 1);
}

function getActivityCurrentPageItems() {
  return activityQueryCache.currentPageItems || [];
}

function getActivityDetailFields(item) {
  return item || {};
}

function formatActivityMetadata(metadata) {
  function renderValue(value) {
    if (value === null || value === undefined) return '--';
    if (typeof value === 'boolean') return value ? 'نعم' : 'لا';
    if (Array.isArray(value)) return value.length ? value.map(renderValue).join(', ') : 'لا يوجد';
    if (typeof value === 'object') return null;
    return escHtml(String(value));
  }
  function renderObject(obj, depth) {
    var html = '<div style="margin-left:' + (depth * 12) + 'px;">';
    for (var key in obj) {
      if (obj.hasOwnProperty(key)) {
        var value = obj[key];
        var rendered = renderValue(value);
        if (rendered === null) {
          html += '<div><strong>' + escHtml(key) + ':</strong></div>' + renderObject(value, depth + 1);
        } else {
          html += '<div><strong>' + escHtml(key) + ':</strong> ' + rendered + '</div>';
        }
      }
    }
    html += '</div>';
    return html;
  }
  return renderObject(metadata, 0);
}

function writeActivityModalContent(item) {
  var record = normalizeActivityRecord(item || {});
  document.getElementById('activityDetailContent').innerHTML = '<div style="display:grid;gap:10px;">' +
    '<div><strong>التاريخ:</strong> ' + fmtDateTime(record.timestamp) + '</div>' +
    '<div><strong>الإجراء:</strong> ' + escHtml(getActivityLabel(record.actionType)) + '</div>' +
    '<div><strong>الكيان:</strong> ' + escHtml(getEntityLabel(record.entity)) + '</div>' +
    '<div><strong>المعرف:</strong> ' + escHtml(record.entityId || '--') + '</div>' +
    '<div><strong>المستخدم:</strong> ' + escHtml(record.user || '--') + '</div>' +
    '<div><strong>التفاصيل:</strong> ' + formatActivityDetails(record.details) + '</div>' +
    (record.metadata ? '<div><strong>البيانات الإضافية:</strong>' + formatActivityMetadata(record.metadata) + '</div>' : '') +
    '</div>';
}

function getFormattedActivityModalContent(item) {
  return item ? writeActivityModalContent(item) : '';
}

function getActivityFilterDateValueOrEmpty(ts) {
  return ts ? new Date(ts).toISOString().split('T')[0] : '';
}

function buildActivityFilterRow() {
  if (!document.getElementById('activityFilterRow')) return;
  document.getElementById('activityFilterRow').innerHTML = getActivityFiltersRowHTML();
}

// Wheel picker implementation for Day / Month / Year spinner
function initActivityWheelPickers(startTs, endTs) {
  try {
    var startContainer = document.getElementById('afCustomStartPicker');
    var endContainer = document.getElementById('afCustomEndPicker');
    var now = Date.now();
    createWheelPicker(startContainer, startTs || now, function(ts) { updateActivityFilter('customStart', ts); });
    createWheelPicker(endContainer, endTs || now, function(ts) { updateActivityFilter('customEnd', ts); }, true);
  } catch (e) {
    console.warn('Wheel picker init failed', e);
  }
}

// Initialize comparison section wheel pickers (4 pickers: start1,end1,start2,end2)
function initComparisonWheelPickers(s1, e1, s2, e2) {
  try {
    var c1 = document.getElementById('compStart1Picker');
    var c2 = document.getElementById('compEnd1Picker');
    var c3 = document.getElementById('compStart2Picker');
    var c4 = document.getElementById('compEnd2Picker');
    var now = Date.now();
    createWheelPicker(c1, s1 || (now - 7*24*3600*1000), function(ts) {}, false);
    createWheelPicker(c2, e1 || now, function(ts) {}, true);
    createWheelPicker(c3, s2 || (now - 14*24*3600*1000), function(ts) {}, false);
    createWheelPicker(c4, e2 || (now - 7*24*3600*1000), function(ts) {}, true);
  } catch (e) { console.warn('initComparisonWheelPickers error', e); }
}

function createWheelPicker(container, ts, onChange, endOfDay) {
  if (!container) return;
  container.innerHTML = '';
  var date = new Date(ts || Date.now());

  // Create display label (fixed) and hidden columns
  var display = document.createElement('div'); display.className = 'wheel-display';
  var displayText = document.createElement('span'); displayText.className = 'wheel-display-text';
  display.appendChild(displayText);
  var colsWrap = document.createElement('div'); colsWrap.className = 'wheel-columns'; colsWrap.style.display = 'none';

  var dayCol = document.createElement('div'); dayCol.className = 'wheel-column';
  var monthCol = document.createElement('div'); monthCol.className = 'wheel-column';
  var yearCol = document.createElement('div'); yearCol.className = 'wheel-column';

  // populate days
  for (var d = 1; d <= 31; d++) { var div = document.createElement('div'); div.className = 'wheel-item'; div.dataset.val = d; div.innerText = d; dayCol.appendChild(div); }
  // months (Arabic short names)
  var months = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  for (var m = 1; m <= 12; m++) { var md = document.createElement('div'); md.className = 'wheel-item'; md.dataset.val = m; md.innerText = months[m-1]; monthCol.appendChild(md); }
  // years range
  var curYear = date.getFullYear();
  var startYear = curYear - 10; var endYear = curYear + 5;
  for (var y = startYear; y <= endYear; y++) { var yd = document.createElement('div'); yd.className = 'wheel-item'; yd.dataset.val = y; yd.innerText = y; yearCol.appendChild(yd); }

  colsWrap.appendChild(dayCol); colsWrap.appendChild(monthCol); colsWrap.appendChild(yearCol);
  container.appendChild(display); container.appendChild(colsWrap);

  function updateDisplayText(dt) {
    var d = dt.getDate(); var m = dt.getMonth() + 1; var y = dt.getFullYear();
    displayText.innerText = d + '/' + m + '/' + y;
  }

  // helper to snap and detect selected value
  function snapToClosest(col) {
    var items = Array.from(col.querySelectorAll('.wheel-item'));
    var box = col.getBoundingClientRect();
    var center = box.top + box.height/2;
    var closest = items.reduce(function(prev, cur) {
      var r = cur.getBoundingClientRect(); var dist = Math.abs((r.top + r.height/2) - center);
      return (prev.dist === undefined || dist < prev.dist) ? { node: cur, dist: dist } : prev;
    }, {});
    if (closest && closest.node) {
      closest.node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  var debounceTimer;
  function onScrollHandler() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function() {
      snapToClosest(dayCol); snapToClosest(monthCol); snapToClosest(yearCol);
      var sel = getWheelSelectedDate(container, endOfDay);
      if (sel && onChange) onChange(sel);
      if (sel) updateDisplayText(new Date(sel));
    }, 120);
  }

  dayCol.addEventListener('scroll', onScrollHandler);
  monthCol.addEventListener('scroll', onScrollHandler);
  yearCol.addEventListener('scroll', onScrollHandler);

  // clicking the display toggles the columns
  display.addEventListener('click', function(e) {
    if (colsWrap.style.display === 'none') {
      colsWrap.style.display = 'flex';
      // ensure columns are centered on current date
      setWheelToDate(container, date);
    } else {
      colsWrap.style.display = 'none';
    }
  });

  // set initial scroll to given date and display text
  setWheelToDate(container, date);
  updateDisplayText(date);
}

function getWheelSelectedDate(container, endOfDay) {
  if (!container) return null;
  var dayCol = container.children[0]; var monthCol = container.children[1]; var yearCol = container.children[2];
  function selectedFromCol(col) {
    var items = Array.from(col.querySelectorAll('.wheel-item'));
    var box = col.getBoundingClientRect(); var center = box.top + box.height/2;
    var closest = items.reduce(function(prev, cur) {
      var r = cur.getBoundingClientRect(); var dist = Math.abs((r.top + r.height/2) - center);
      return (prev.dist === undefined || dist < prev.dist) ? { node: cur, dist: dist } : prev;
    }, {});
    return closest && closest.node ? parseInt(closest.node.dataset.val,10) : null;
  }
  var d = selectedFromCol(dayCol) || 1;
  var m = selectedFromCol(monthCol) || 1;
  var y = selectedFromCol(yearCol) || new Date().getFullYear();
  var dt = new Date(y, m-1, d);
  if (endOfDay) dt.setHours(23,59,59,999); else dt.setHours(0,0,0,0);
  return dt.getTime();
}

function setWheelToDate(container, date) {
  if (!container) return;
  var d = date.getDate(); var m = date.getMonth() + 1; var y = date.getFullYear();
  var cols = [container.children[0], container.children[1], container.children[2]];
  function scrollToValue(col, val) {
    var item = Array.from(col.querySelectorAll('.wheel-item')).find(function(it){ return String(it.dataset.val) === String(val); });
    if (item) item.scrollIntoView({ block: 'center' });
  }
  scrollToValue(cols[0], d); scrollToValue(cols[1], m); scrollToValue(cols[2], y);
}

var datePickerState = {
  activeInput: null,
  overlay: null,
  dayInput: null,
  monthInput: null,
  yearInput: null
};

function initDatePickerPopup() {
  var overlay = document.getElementById('datePickerOverlay');
  if (!overlay) return;
  datePickerState.overlay = overlay;
  datePickerState.dayInput = document.getElementById('datePickerDay');
  datePickerState.monthInput = document.getElementById('datePickerMonth');
  datePickerState.yearInput = document.getElementById('datePickerYear');

  // Auto-navigation and input sanitation for day/month/year fields
  function sanitizeDigits(el, maxLen) {
    if (!el) return;
    var v = String(el.value || '').replace(/[^0-9]/g, '');
    if (v.length > maxLen) v = v.slice(0, maxLen);
    if (el.value !== v) el.value = v;
  }

  if (datePickerState.dayInput) {
    datePickerState.dayInput.addEventListener('input', function() {
      sanitizeDigits(this, 2);
      if (this.value.length >= 2) {
        datePickerState.monthInput && datePickerState.monthInput.focus();
      }
    });
    datePickerState.dayInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        datePickerState.monthInput && datePickerState.monthInput.focus();
      }
    });
  }
  if (datePickerState.monthInput) {
    datePickerState.monthInput.addEventListener('input', function() {
      sanitizeDigits(this, 2);
      if (this.value.length >= 2) {
        datePickerState.yearInput && datePickerState.yearInput.focus();
      }
    });
    datePickerState.monthInput.addEventListener('keydown', function(e) {
      if (e.key === 'Backspace' && (!this.value || this.value.length === 0)) {
        datePickerState.dayInput && datePickerState.dayInput.focus();
      }
      if (e.key === 'Enter') {
        datePickerState.yearInput && datePickerState.yearInput.focus();
      }
    });
  }
  if (datePickerState.yearInput) {
    datePickerState.yearInput.addEventListener('input', function() {
      sanitizeDigits(this, 4);
      // auto-confirm when full year entered
      if (this.value.length >= 4) {
        var sel = getPickerDate();
        if (sel && datePickerState.activeInput) {
          datePickerState.activeInput.value = formatDateInputValue(sel);
          datePickerState.activeInput.dispatchEvent(new Event('change', { bubbles: true }));
          closeDatePicker();
        }
      }
    });
    datePickerState.yearInput.addEventListener('keydown', function(e) {
      if (e.key === 'Backspace' && (!this.value || this.value.length === 0)) {
        datePickerState.monthInput && datePickerState.monthInput.focus();
      }
      if (e.key === 'Enter') {
        var sel = getPickerDate();
        if (sel && datePickerState.activeInput) {
          datePickerState.activeInput.value = formatDateInputValue(sel);
          datePickerState.activeInput.dispatchEvent(new Event('change', { bubbles: true }));
          closeDatePicker();
        }
      }
    });
  }

  document.addEventListener('click', function(e) {
    var dateInput = e.target.closest('.date-input');
    if (!dateInput) return;
    if (datePickerState.overlay.contains(e.target)) return;
    e.preventDefault();
    openDatePicker(dateInput);
  });

  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) {
      closeDatePicker();
    }
  });

  var confirmBtn = document.getElementById('datePickerConfirmBtn');
  if (confirmBtn) {
    confirmBtn.addEventListener('click', function() {
      if (!datePickerState.activeInput) return;
      var selected = getPickerDate();
      if (!selected) {
        showToast('الرجاء إدخال تاريخ صالح', 'error');
        return;
      }
      datePickerState.activeInput.value = formatDateInputValue(selected);
      datePickerState.activeInput.dispatchEvent(new Event('change', { bubbles: true }));
      closeDatePicker();
    });
  }
}

function openDatePicker(input) {
  if (!datePickerState.overlay) return;
  datePickerState.activeInput = input;
  var parsed = parseDateString(input.value, false);
  if (parsed) {
    var date = new Date(parsed);
    datePickerState.dayInput.value = padNumber(date.getDate());
    datePickerState.monthInput.value = padNumber(date.getMonth() + 1);
    datePickerState.yearInput.value = date.getFullYear();
  } else {
    datePickerState.dayInput.value = '';
    datePickerState.monthInput.value = '';
    datePickerState.yearInput.value = '';
  }
  datePickerState.overlay.classList.remove('hidden');
  datePickerState.dayInput.focus();
}

function closeDatePicker() {
  if (!datePickerState.overlay) return;
  datePickerState.overlay.classList.add('hidden');
  datePickerState.activeInput = null;
}

function getPickerDate() {
  if (!datePickerState.dayInput || !datePickerState.monthInput || !datePickerState.yearInput) return null;
  var day = parseInt(datePickerState.dayInput.value, 10);
  var month = parseInt(datePickerState.monthInput.value, 10);
  var year = parseInt(datePickerState.yearInput.value, 10);
  if (!year || !month || !day) return null;
  if (month < 1 || month > 12) return null;
  var maxDay = new Date(year, month, 0).getDate();
  if (day < 1 || day > maxDay) return null;
  var selected = new Date(year, month - 1, day);
  if (isNaN(selected.getTime())) return null;
  selected.setHours(0, 0, 0, 0);
  return selected;
}

function padNumber(value) {
  return value < 10 ? '0' + value : String(value);
}

function formatDateInputValue(date) {
  var y = date.getFullYear();
  var m = String(date.getMonth() + 1).padStart(2, '0');
  var d = String(date.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}
function getSystemDateInputValue() {
  var values = systemDateParts(Date.now());
  return values ? values.year + '-' + values.month + '-' + values.day : '';
}
function isValidEmployeeDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  var timestamp = Date.parse(value + 'T00:00:00+03:00');
  var values = systemDateParts(timestamp);
  return Number.isFinite(timestamp) && values && value === values.year + '-' + values.month + '-' + values.day;
}
function setEmployeeStartDateFields(value) {
  var parts = String(value || '').split('-');
  document.getElementById('managedEmployeeStartYear').value = parts.length === 3 ? parts[0] : '';
  document.getElementById('managedEmployeeStartMonth').value = parts.length === 3 ? parts[1] : '';
  document.getElementById('managedEmployeeStartDay').value = parts.length === 3 ? parts[2] : '';
  document.getElementById('managedEmployeeStartDate').value = isValidEmployeeDate(value) ? value : '';
}
function updateEmployeeStartDateFields() {
  var day = document.getElementById('managedEmployeeStartDay').value;
  var month = document.getElementById('managedEmployeeStartMonth').value;
  var year = document.getElementById('managedEmployeeStartYear').value;
  var value = year.length === 4 && month.length === 2 && day.length === 2 ? year + '-' + month + '-' + day : '';
  document.getElementById('managedEmployeeStartDate').value = isValidEmployeeDate(value) ? value : '';
  return value;
}

function getActivityPageSummary(items) {
  return {
    total: items.length,
    create: getActivitySummaryCount(items, 'create'),
    update: getActivitySummaryCount(items, 'update'),
    delete: getActivitySummaryCount(items, 'delete')
  };
}

function getActivitySummaryHtml(items) {
  return buildActivitySummaryCards(items);
}

function getActivityFooter() {
  return '';
}

function getActivityPaginationButtons() {
  if (!activityQueryCache.currentPageItems.length && !activityQueryCache.hasMore) {
    return '';
  }
  var html = '';
  html += '<button ' + (activityPage === 0 ? 'disabled' : '') + ' onclick="goToActivityPage(' + (activityPage - 1) + ')">السابق</button>';
  html += '<button class="active">صفحة ' + (activityPage + 1) + '</button>';
  html += '<button ' + (!activityQueryCache.hasMore ? 'disabled' : '') + ' onclick="goToActivityPage(' + (activityPage + 1) + ')">التالي</button>';
  return html;
}

function getActivityDateSeparatorRowHtml(ts) {
  var dayLabel = escHtml(formatDateSeparatorLabel(ts));
  return '<tr style="background:var(--surface);font-weight:800;border-top:1px solid var(--border);border-bottom:1px solid var(--border);">' +
    '<td style="padding:14px 8px;color:var(--text3);text-align:center;">&nbsp;</td>' +
    '<td colspan="6" style="padding:14px 8px;color:var(--text3);text-align:center;white-space:nowrap;direction:rtl;">' + dayLabel + '</td>' +
    '</tr>';
}

function getActivityRowsHtml(items) {
  if (!items.length) return '<tr><td colspan="7" style="padding:30px;color:var(--text3);">لا توجد سجلات</td></tr>';
  var html = '';
  var lastDayKey = null;
  items.forEach(function(item, i) {
    var dayKey = getDayKey(item.timestamp);
    if (dayKey !== lastDayKey) {
      html += getActivityDateSeparatorRowHtml(item.timestamp);
      lastDayKey = dayKey;
    }
    html += getActivityTableRow(item, i);
  });
  return html;
}

function getActivitySectionElements() {
  return {
    summary: document.getElementById('activitySummaryGrid'),
    body: document.getElementById('activityLogBody'),
    pagination: document.getElementById('activityPagination')
  };
}

function updateActivitySectionUI(items) {
  var els = getActivitySectionElements();
  if (!els.body) return;
  if (els.summary) els.summary.innerHTML = getActivitySummaryHtml(items);
  els.body.innerHTML = getActivityRowsHtml(items);
  if (document.getElementById('activityLoadMoreRow')) renderActivityLoadMore();
}

function getActivityExportFilenameWithDate() {
  return getExportActivityFilename();
}

function getActivityPdfHeaderConfig() {
  return {
    head: [getActivityTableHeaders()],
    body: getActivityPdfBody(getCurrentActivityPageItems())
  };
}

function getCurrentActivityPageItems() {
  return activityQueryCache.currentPageItems || [];
}

function getActivityExportData() {
  return getCurrentActivityPageItems();
}

function buildActivityCsvData(rows) {
  return rows.map(function(r) { return r.map(function(c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(','); }).join('\n');
}

function getActivityCsvBlob(rows) {
  return new Blob(['\uFEFF' + buildActivityCsvData(rows)], { type: 'text/csv;charset=utf-8;' });
}

function getActivityExportAnchor(filename, blob) {
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function getActivityExportFileName(filename) {
  return filename + '.csv';
}

function getActivityPdfFileName(filename) {
  return filename + '.pdf';
}

async function fetchActivityPage() {
  if (activityQueryCache.loading || !activityQueryCache.hasMore) return;
  activityQueryCache.loading = true;
  updateActivityLoadMoreButton();

  var query = db.collection('activityLog').orderBy('timestamp', 'desc').limit(activityPageSize + 1);
  if (activityQueryCache.lastDoc) query = query.startAfter(activityQueryCache.lastDoc);
  try {
    var snap = await query.get();
    var rawItems = snap.docs.map(function(d) { return normalizeActivityRecord({ id: d.id, ...d.data() }); });
    var nextCursor = null;
    if (rawItems.length > activityPageSize) {
      nextCursor = snap.docs[activityPageSize - 1];
      rawItems = rawItems.slice(0, activityPageSize);
    }
    activityQueryCache.currentPageItems = (activityQueryCache.currentPageItems || []).concat(rawItems);
    activityQueryCache.lastDoc = nextCursor;
    activityQueryCache.hasMore = !!nextCursor;
  } catch (e) {
    activityQueryCache.hasMore = false;
    showFirestoreError(e, 'تعذّر تحميل سجل العمليات');
  } finally {
    activityQueryCache.loading = false;
    updateActivityLoadMoreButton();
  }
}

function renderActivityLog() {
  if (!activityQueryCache.currentPageItems.length) {
    renderActivityTable();
    fetchActivityPage().then(renderActivityTable);
  } else {
    renderActivityTable();
  }
}

function renderActivityTable() {
  var currentCount = (activityQueryCache.currentPageItems || []).length;
  var activityLabel = document.getElementById('activityCountLabel');
  if (activityLabel) {
    activityLabel.textContent = currentCount > 0 ? 'عرض ' + currentCount + ' من السجلات' : (activityQueryCache.loading ? 'جاري تحميل السجلات...' : 'لا توجد سجلات');
  }
  var body = document.getElementById('activityLogBody');
  if (body) body.innerHTML = getActivityRowsHtml((activityQueryCache.currentPageItems || []).map(normalizeActivityRecord));
  renderActivityLoadMore();
}

function renderActivityLoadMore() {
  var row = document.getElementById('activityLoadMoreRow');
  if (!row) return;
  if (!activityQueryCache.hasMore && (activityQueryCache.currentPageItems || []).length > 0) {
    row.style.display = 'none';
    return;
  }
  row.style.display = 'flex';
  updateActivityLoadMoreButton();
}

function updateActivityLoadMoreButton() {
  var btn = document.getElementById('activityLoadMoreBtn');
  var info = document.getElementById('activityLoadMoreInfo');
  if (!btn || !info) return;
  btn.disabled = !!activityQueryCache.loading || !activityQueryCache.hasMore;
  btn.textContent = activityQueryCache.loading ? 'جاري التحميل...' : 'تحميل المزيد';
  info.textContent = activityQueryCache.hasMore ? '' : ((activityQueryCache.currentPageItems || []).length ? 'تم تحميل جميع السجلات.' : 'لا توجد سجلات إضافية.');
}

function loadMoreActivity() {
  if (activityQueryCache.loading || !activityQueryCache.hasMore) return;
  fetchActivityPage().then(renderActivityTable);
}

function renderActivityPagination() {
  if (!document.getElementById('activityPagination')) return;
  document.getElementById('activityPagination').innerHTML = getActivityPaginationButtons();
}

function goToActivityPage(p) {
  activityPage = Math.max(0, p);
  renderActivityLog();
}

function debouncedActivitySearchUpdate(value) {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(function() { updateActivityFilter('searchTerm', value); }, 400);
}

function updateActivityFilter(key, value) {
  activityFilterParams[key] = value;
  activityPage = 0;
  activityPageCursors = [null];
  activityPageItemsCache = {};
  activityQueryCache = { lastDoc: null, hasMore: true, currentPageItems: [] };
  renderActivityLog();
}

function resetActivityFilters() {
  activityFilterParams = { period: 'all', searchTerm: '', actionType: '', entity: '', user: '', customStart: null, customEnd: null };
  activityPage = 0;
  activityPageCursors = [null];
  activityPageItemsCache = {};
  activityQueryCache = { lastDoc: null, hasMore: true, currentPageItems: [] };
  renderActivityLog();
}

function viewActivityLogDetail(recordId) {
  var item = (activityQueryCache.currentPageItems || []).map(normalizeActivityRecord).find(function(it) { return it.id === recordId; });
  if (!item) return;
  writeActivityModalContent(normalizeActivityRecord(item));
  document.getElementById('activityDetailModal').classList.add('show');
}

window.viewActivityLogDetail = viewActivityLogDetail;


function getCachedData(key) {
  try { var raw = localStorage.getItem('xmetal_cache_' + key); if (raw) { var p = JSON.parse(raw); if (Date.now() - p.ts < CACHE_TTL) return p.data; } } catch (e) {}
  return null;
}
function setCachedData(key, data) {
  try { localStorage.setItem('xmetal_cache_' + key, JSON.stringify({ data: data, ts: Date.now() })); } catch (
  e) {}
}
function clearAllCaches() {
  ['items', 'categories', 'expenses', 'sales_full'].forEach(function(k) { localStorage.removeItem(
      'xmetal_cache_' + k); });
}
function applyDarkMode() {
  if (darkMode) document.body.classList.add('dark-mode');
  else document.body.classList.remove('dark-mode');
  var darkToggle = document.getElementById('darkToggle');
  if (darkToggle) {
    darkToggle.classList.toggle('active', darkMode);
    darkToggle.setAttribute('aria-checked', darkMode ? 'true' : 'false');
  }
  localStorage.setItem('xmetalDarkMode', darkMode);
}
function getStartOfDay(d) { d = d || new Date(); var off = 3 * 3600000,
    g = d.getTime() + off; var y = new Date(g).getUTCFullYear(),
    m = new Date(g).getUTCMonth(), day = new Date(g).getUTCDate(); return Date.UTC(y, m, day, 0, 0, 0) -
  off; }
function getStartOfWeek(d) { d = d || new Date(); var s = getStartOfDay(d),
    off = 3 * 3600000,
    g = new Date(s + off); return s - (g.getUTCDay() * 86400000); }
function getStartOfMonth(d) { d = d || new Date(); var s = getStartOfDay(d),
    off = 3 * 3600000,
    g = new Date(s + off); return Date.UTC(g.getUTCFullYear(), g.getUTCMonth(), 1, 0, 0, 0) - off; }
function getStartOfYear(d) { d = d || new Date(); var s = getStartOfDay(d),
    off = 3 * 3600000,
    g = new Date(s + off); return Date.UTC(g.getUTCFullYear(), 0, 1, 0, 0, 0) - off; }
function getExpensesSum(start, end) {
  start = Number(start) || 0;
  end = Number(end) || (Date.now() + 86400000);
  if (window && window.AnalyticsHelpers && typeof window.AnalyticsHelpers.getExpensesSum === 'function') {
    return window.AnalyticsHelpers.getExpensesSum(start, end, allExpenses || []);
  }
  return (Array.isArray(allExpenses) ? allExpenses : []).filter(function(e) {
    return Number(e && e.date) >= start && Number(e && e.date) < end;
  }).reduce(function(a, e) { return a + (Number(e.amount) || 0); }, 0);
}
function convertToSecondary(a) {
  if (window && window.CurrencyModel && typeof window.CurrencyModel.toSecondary === 'function') {
    return window.CurrencyModel.toSecondary(a, currencySettings.rate);
  }
  return Number(a) * (Number(currencySettings.rate) || 1);
}
function convertToPrimary(a) {
  if (window && window.CurrencyModel && typeof window.CurrencyModel.toPrimary === 'function') {
    return window.CurrencyModel.toPrimary(a, currencySettings.rate);
  }
  return Number(a) / (Number(currencySettings.rate) || 1);
}
function updateInventoryGlobalEyeButton() {
  var btn = document.getElementById('toggleAllMechanicPricesBtn');
  if (!btn) return;
  btn.classList.toggle('active', showMechanicPricesGlobally);
  var icon = btn.querySelector('i');
  if (icon) icon.className = 'fas ' + (showMechanicPricesGlobally ? 'fa-eye' : 'fa-eye-slash');
}

function buildProfitLabelMarkup(baseLabel, purchaseValue, targetValue) {
  var purchase = parseInputNumber(purchaseValue);
  var target = parseInputNumber(targetValue);
  if (purchase === null || target === null || purchase <= 0 || target <= 0) {
    return baseLabel;
  }
  var profitPercent = ((target - purchase) / purchase) * 100;
  var percentText = window.PriceHelpers && typeof window.PriceHelpers.getProfitPercent === 'function' ?
    window.PriceHelpers.getProfitPercent(purchase, target) :
    (Number.isFinite(profitPercent) ? Math.round(profitPercent) + '%' : '--');
  var colorClass = profitPercent >= 0 ? 'profit-positive' : 'profit-negative';
  return baseLabel + ' <span class="profit-label-tag ' + colorClass + '">نسبة الربح: ' + percentText + '</span>';
}
function refreshPriceProfitLabels() {
  var purchaseEl = document.getElementById('purchasePrice');
  var saleEl = document.getElementById('salePrice');
  var mechanicEl = document.getElementById('mechanicPrice');
  var saleLabel = document.getElementById('salePriceLabel');
  var mechanicLabel = document.getElementById('mechanicPriceLabel');

  var purchaseValue = parseInputNumber(purchaseEl ? purchaseEl.value : null);
  var saleValue = parseInputNumber(saleEl ? saleEl.value : null);
  var mechanicValue = parseInputNumber(mechanicEl ? mechanicEl.value : null);
  purchaseValue = purchaseValue === null ? 0 : purchaseValue;
  saleValue = saleValue === null ? 0 : saleValue;
  var mechanicDisplayValue = mechanicValue === null ? saleValue : mechanicValue;

  if (saleLabel) {
    saleLabel.innerHTML = buildProfitLabelMarkup('سعر البيع ($)', purchaseValue, saleValue);
  }
  if (mechanicLabel) {
    mechanicLabel.innerHTML = buildProfitLabelMarkup('سعر الميكانيكي ($)', purchaseValue, mechanicDisplayValue);
  }

  var hintEl = document.getElementById('mechanicPriceHint');
  if (hintEl) {
    hintEl.innerText = '';
    hintEl.style.display = 'none';
  }

  var profitDisplay = document.getElementById('profitMarginDisplay');
  if (profitDisplay) {
    profitDisplay.innerText = '';
    profitDisplay.style.display = 'none';
  }
}
function updateProductPriceDisplay() {
  refreshPriceProfitLabels();
}
function updateSellPriceDisplay() {
  var v = parseFloat(document.getElementById('sellPrice') ? document.getElementById('sellPrice').value : 0) || 0;
  var qty = parseFloat(document.getElementById('sellQuantity') ? document.getElementById('sellQuantity').value : 0) || 0;
  var total = Number(v) * Number(qty);
  var el = document.getElementById('sellPriceSecondaryInfo');
  if (el) el.innerText = 'إجمالي البيع: $ ' + fmtMoney(total);
}
function updateEditSalePriceDisplay() {
  var v = parseFloat(document.getElementById('editPrice') ? document.getElementById('editPrice').value : 0) || 0;
  var el = document.getElementById('editPriceSecondaryInfo');
  if (el) el.innerText = '$ ' + fmtMoney(v);
}
function updatePriceLabels() {
  var pel = document.getElementById('purchasePriceLabel');
  var sel = document.getElementById('salePriceLabel');
  var mel = document.getElementById('mechanicPriceLabel');
  var spl = document.getElementById('sellPriceLabel');
  var epl = document.getElementById('editPriceLabel');
  var purchaseValue = parseInputNumber(document.getElementById('purchasePrice') ? document.getElementById('purchasePrice').value : null) || 0;
  var saleValue = parseInputNumber(document.getElementById('salePrice') ? document.getElementById('salePrice').value : null) || 0;
  var mechanicValue = parseInputNumber(document.getElementById('mechanicPrice') ? document.getElementById('mechanicPrice').value : null) || 0;
  if (pel) pel.innerHTML = 'سعر الشراء ($)';
  if (sel) sel.innerHTML = buildProfitLabelMarkup('سعر البيع ($)', purchaseValue, saleValue);
  if (mel) mel.innerHTML = buildProfitLabelMarkup('سعر الميكانيكي ($)', purchaseValue, mechanicValue > 0 ? mechanicValue : saleValue);
  if (spl) spl.innerHTML = 'السعر للقطعة ($)';
  if (epl) epl.innerHTML = 'السعر ($)';
  var profitDisplay = document.getElementById('profitMarginDisplay');
  if (profitDisplay) {
    profitDisplay.innerText = '';
    profitDisplay.style.display = 'none';
  }
}
function closeMobileSidebar() {
  var sidebar = document.getElementById('sidebar');
  var backdrop = document.getElementById('sidebarBackdrop');
  if (sidebar) sidebar.classList.remove('open');
  if (backdrop) backdrop.classList.remove('show');
  document.body.style.overflow = 'auto';
}

var mobileMenuBtn = document.getElementById('mobileMenuBtn');
var sidebar = document.getElementById('sidebar');
var sidebarBackdrop = document.getElementById('sidebarBackdrop');

if (mobileMenuBtn) {
  mobileMenuBtn.addEventListener('click', function(event) {
    event.stopPropagation();
    sidebar.classList.toggle('open');
    sidebarBackdrop.classList.toggle('show');
    document.body.style.overflow = sidebar.classList.contains('open') ? 'hidden' : 'auto';
  });
}

if (sidebarBackdrop) {
  sidebarBackdrop.addEventListener('click', closeMobileSidebar);
}

document.querySelectorAll('#sidebarNav button').forEach(function(btn) {
  btn.addEventListener('click', function(event) {
    event.stopPropagation();
    document.querySelectorAll('#sidebarNav button').forEach(function(b) {
      b.classList.remove('active');
    });
    btn.classList.add('active');
    currentSection = btn.dataset.section;
    salesPage = 0;
    salesQueryCache = { lastDoc: null, hasMore: true, currentPageItems: [] };
    destroyAllCharts();
    renderCurrentSection();
    var pageTitle = document.getElementById('pageTitle');
    if (pageTitle) pageTitle.textContent = btn.textContent.trim();
    closeMobileSidebar();
  });
});

document.addEventListener('click', function (event) {
  var debtActionButton = event.target.closest('[data-main-debt-action]');
  if (debtActionButton && currentSection === 'debts') {
    openMainDebtActionModal(debtActionButton.dataset.mainDebtAction, mainDebtSelectedCustomerId);
    return;
  }
  var customerItem = event.target.closest('[data-main-debt-customer-id]');
  if (!customerItem) return;
  mainDebtSelectedCustomerId = String(customerItem.dataset.mainDebtCustomerId || '');
  if (currentSection === 'debts') {
    renderDebtSection();
    var detailModal = document.getElementById('mainDebtCustomerDetailModal');
    if (detailModal) detailModal.classList.add('show');
  }
});

document.addEventListener('input', function (event) {
  if (event.target && event.target.id === 'mainDebtSearch' && currentSection === 'debts') {
    renderDebtSection();
  }
});

var mainDebtCustomerBtn = document.getElementById('mainAddDebtCustomerBtn');
if (mainDebtCustomerBtn) {
  mainDebtCustomerBtn.addEventListener('click', function () {
    var form = document.getElementById('mainDebtCustomerForm');
    if (form) form.reset();
    var modal = document.getElementById('mainDebtCustomerModal');
    if (modal) modal.classList.add('show');
  });
}

var mainDebtCustomerForm = document.getElementById('mainDebtCustomerForm');
if (mainDebtCustomerForm) {
  mainDebtCustomerForm.addEventListener('submit', saveMainDebtCustomer);
}

document.getElementById('addEmployeeBtn').addEventListener('click', function () { openManagedEmployeeForm(null); });
document.getElementById('employeeManagementForm').addEventListener('submit', saveManagedEmployee);
document.getElementById('employeeDayForm').addEventListener('submit', saveManagedEmployeeDay);
document.getElementById('managedEmployeeStatus').addEventListener('click', function () { setManagedEmployeeStatus(getManagedEmployeeStatus() === 'active' ? 'inactive' : 'active'); });
['managedEmployeeStartDay', 'managedEmployeeStartMonth', 'managedEmployeeStartYear'].forEach(function (id, index, fields) {
  document.getElementById(id).addEventListener('input', function (event) {
    var value = event.target.value.replace(/\D/g, '').slice(0, index === 2 ? 4 : 2);
    event.target.value = value;
    if (index === 0 && value.length === 2 && (Number(value) < 1 || Number(value) > 31)) event.target.value = '';
    if (index === 1 && value.length === 2 && (Number(value) < 1 || Number(value) > 12)) event.target.value = '';
    updateEmployeeStartDateFields();
    if (value.length === (index === 2 ? 4 : 2) && fields[index + 1]) document.getElementById(fields[index + 1]).focus();
    else if (index === 2 && value.length === 4) document.getElementById('managedEmployeeWage').focus();
  });
});
document.getElementById('toggleInactiveEmployeesBtn').addEventListener('click', async function () {
  includeInactiveEmployees = !includeInactiveEmployees;
  this.textContent = includeInactiveEmployees ? 'عرض النشطين' : 'عرض المعطلين';
  await renderEmployeesSection();
  renderManagedEmployees();
});
document.getElementById('treasuryWithdrawalForm').addEventListener('submit', saveTreasuryWithdrawal);
document.getElementById('treasuryOpeningForm').addEventListener('submit', saveTreasuryOpening);
document.getElementById('treasuryKeepAmount').addEventListener('input', updateTreasuryWithdrawalPreview);
document.getElementById('openTreasuryWithdrawalBtn').addEventListener('click', openTreasuryWithdrawal);
document.getElementById('openTreasuryOpeningBtn').addEventListener('click', openTreasuryOpening);
document.getElementById('employeesBody').addEventListener('click', function (event) {
  var editButton = event.target.closest('[data-edit-employee]');
  if (editButton) {
    var employee = (Array.isArray(managedEmployees) ? managedEmployees : []).find(function (entry) { return entry.id === editButton.dataset.editEmployee; });
    if (employee) openManagedEmployeeForm(employee);
  }
  var dayButton = event.target.closest('[data-manage-employee-day]');
  if (dayButton) {
    var dayEmployee = (Array.isArray(managedEmployees) ? managedEmployees : []).find(function (entry) { return entry.id === dayButton.dataset.manageEmployeeDay; });
    if (dayEmployee) openManagedEmployeeDay(dayEmployee);
  }
  var employeeHistoryButton = event.target.closest('[data-view-employee]');
  if (employeeHistoryButton) {
    var employeeHistory = (Array.isArray(managedEmployees) ? managedEmployees : []).find(function (entry) { return entry.id === employeeHistoryButton.dataset.viewEmployee; });
    if (employeeHistory) loadManagedEmployeeHistory(employeeHistory, true).catch(function (error) { showToast('تعذر تحميل سجل الموظف: ' + error.message, 'error'); });
  }
  var loadMoreEmployeeHistory = event.target.closest('[data-load-more-employee-history]');
  if (loadMoreEmployeeHistory) {
    var employeeToLoadMore = (Array.isArray(managedEmployees) ? managedEmployees : []).find(function (entry) { return entry.id === loadMoreEmployeeHistory.dataset.loadMoreEmployeeHistory; });
    if (employeeToLoadMore) loadManagedEmployeeHistory(employeeToLoadMore, false).catch(function (error) { showToast('تعذر تحميل المزيد من سجل الموظف: ' + error.message, 'error'); });
  }
});

document.addEventListener('click', function(event) {
  if (!sidebar.classList.contains('open')) return;
  if (event.target === mobileMenuBtn || mobileMenuBtn.contains(event.target)) return;
  if (sidebar.contains(event.target) || sidebarBackdrop.contains(event.target)) return;
  closeMobileSidebar();
});

var _sidebarLogoutBtn = document.getElementById('sidebarLogoutBtn'); if (_sidebarLogoutBtn) _sidebarLogoutBtn.addEventListener('click', function() { closeMobileSidebar(); auth.signOut(); });

var currencyToggleBtn = document.getElementById('currencyToggleBtn');
if (currencyToggleBtn) {
  currencyToggleBtn.addEventListener('click', function() {
    displayPrimaryCurrency = !displayPrimaryCurrency;
    localStorage.setItem('xmetalDisplaySecondary', displayPrimaryCurrency);
    var currencyLabel = document.getElementById('currencyLabel');
    if (currencyLabel) currencyLabel.textContent = '$';
    destroyAllCharts();
    renderCurrentSection();
  });
}
document.getElementById('doLoginBtn').addEventListener('click', function() {
  if (!auth) {
    document.getElementById('loginErrorMsg').style.display = 'block';
    document.getElementById('loginErrorMsg').textContent = 'خطأ في تهيئة المصادقة؛ تأكد من إعدادات Firebase.';
    return;
  }
  var em = document.getElementById('loginEmail').value.trim();
  var pw = document.getElementById('loginPassword').value.trim();
  if (!em || !pw) {
    document.getElementById('loginErrorMsg').style.display = 'block';
    document.getElementById('loginErrorMsg').textContent = 'يرجى إدخال البيانات';
    return;
  }
  document.getElementById('loginErrorMsg').style.display = 'none';
  auth.signInWithEmailAndPassword(em, pw).catch(function(e) {
    document.getElementById('loginErrorMsg').style.display = 'block';
    document.getElementById('loginErrorMsg').textContent = 'فشل: ' + e.message;
  });
});

auth.onAuthStateChanged(async function(user) {
  if (user) {
    document.getElementById('loginOverlay').classList.add('hidden');
    await initApp();
  } else {
    document.getElementById('loginOverlay').classList.remove('hidden');
    detachRealtimeListeners();
    productSalesSummaryCache = [];
    productSalesSummaryLoadingPromise = null;
    productSalesSummaryListenerStarted = false;
    if (productSalesSummaryListenerUnsub) {
      try { productSalesSummaryListenerUnsub(); } catch (e) {}
      productSalesSummaryListenerUnsub = null;
    }
  }
});

async function initApp() {
  detachRealtimeListeners();
  allSalesFullLoaded = false;
  hasFetchedSales = false;
  restoreItemsFromLocalCache();
  await Promise.all([fetchInitialSales(), fetchCategoriesSmart(),
    fetchCurrencySettings(), fetchStoreInfo(), fetchExpensesSmart()
  ]);
  try { await XMetalCapitalSummary.ensureInitialized(db, allItems); } catch (error) { console.warn('Capital summary initialization failed', error); }
  if (window.DailySalesSummary && window.DailySalesSummary.flushPendingOperations) {
    try { await window.DailySalesSummary.flushPendingOperations(); } catch (error) { console.warn('Pending dailySales updates failed', error); }
  }
  await loadDashboardDailySalesSummary();
  applyDarkMode();
  var currencyLabel = document.getElementById('currencyLabel');
  if (currencyLabel) currencyLabel.textContent = '$';
  renderCurrentSection();
  initDatePickerPopup();
  attachRealtimeListeners();
}

async function loadDashboardDailySalesSummary() {
  if (!window.DailySalesSummary || !db || !db.collection) return null;
  var todayKey = window.DailySalesSummary.toDayKey(Date.now());
  if (!todayKey) return null;
  dashboardDailySalesSummary = await window.DailySalesSummary.readSummary(todayKey);
  return dashboardDailySalesSummary;
}

async function loadProductSalesSummary() {
  if (!window.ProductSalesSummary || !window.ProductSalesSummary.readAllSummaries || !db || !db.collection) {
    productSalesSummaryCache = [];
    return [];
  }
  try {
    productSalesSummaryCache = await window.ProductSalesSummary.readAllSummaries();
    return productSalesSummaryCache;
  } catch (error) {
    productSalesSummaryCache = [];
    console.warn('Unable to load product sales summary cache', error);
    return [];
  }
}

function stopProductSalesSummaryListener() {
  if (productSalesSummaryListenerUnsub) {
    try { productSalesSummaryListenerUnsub(); } catch (e) {}
    productSalesSummaryListenerUnsub = null;
  }
  productSalesSummaryListenerStarted = false;
}

async function ensureProductSalesSummaryLoaded() {
  if (!window.ProductSalesSummary || !window.ProductSalesSummary.readAllSummaries || !db || !db.collection) {
    productSalesSummaryCache = [];
    return [];
  }
  if (productSalesSummaryLoadingPromise) return productSalesSummaryLoadingPromise;
  if (Array.isArray(productSalesSummaryCache) && productSalesSummaryCache.length) {
    return productSalesSummaryCache;
  }

  productSalesSummaryLoadingPromise = (async function() {
    try {
      productSalesSummaryCache = await window.ProductSalesSummary.readAllSummaries();
      return productSalesSummaryCache;
    } catch (error) {
      productSalesSummaryCache = [];
      console.warn('Unable to load product sales summary cache', error);
      return [];
    } finally {
      productSalesSummaryLoadingPromise = null;
    }
  })();
  return productSalesSummaryLoadingPromise;
}

function ensureProductSalesSummaryListener() {
  if (!db || !db.collection || !window.ProductSalesSummary || !window.ProductSalesSummary.readAllSummaries) return;
  if (productSalesSummaryListenerStarted) return;

  productSalesSummaryListenerStarted = true;
  productSalesSummaryListenerUnsub = db.collection('productSalesSummary').onSnapshot(function(snapshot) {
    try {
      productSalesSummaryCache = snapshot && snapshot.docs ? snapshot.docs.map(function(doc) {
        return window.ProductSalesSummary.normalizeSummary(doc.data(), doc.id);
      }) : [];
    } catch (error) {
      console.warn('Unable to sync product sales summary cache', error);
    }
  }, function(error) {
    console.warn('productSalesSummary listener failed', error);
    stopProductSalesSummaryListener();
  });
}

function detachRealtimeListeners() {
  realtimeListeners.forEach(function(unsub) { try { unsub(); } catch (e) {} });
  realtimeListeners = [];
  itemsListenerStarted = false;
  itemsListenerReadyPromise = null;
  itemsListenerReadyResolve = null;
  itemsListenerReadyReject = null;
  stopProductSalesSummaryListener();
}

function restoreItemsFromLocalCache() {
  var cached = getCachedData('items');
  if (Array.isArray(cached)) {
    allItems = cached;
    try { if (window.appState && appState.setState) appState.setState('data.items', allItems); } catch (e) {}
  }
}

function sectionNeedsFullItems(section) {
  return ['inventory', 'addItem', 'salesLog', 'productAnalytics', 'insights', 'categories'].indexOf(String(section || '')) !== -1;
}

function ensureItemsRealtimeListener() {
  if (itemsListenerStarted) return itemsListenerReadyPromise || Promise.resolve();
  itemsListenerStarted = true;
  itemsListenerReadyPromise = new Promise(function(resolve, reject) {
    itemsListenerReadyResolve = resolve;
    itemsListenerReadyReject = reject;
  });
  try {
    var unsubItems = db.collection('items').onSnapshot(function(snap) {
      try {
        var items = snap.docs.map(function(d) { return { id: d.id, ...d.data() }; });
        allItems = items;
        setCachedData('items', allItems);
        if (window.appState && appState.setState) appState.setState('data.items', allItems);
        if (document.getElementById('itemsList')) renderInventory();
        if (currentSection === 'dashboard' || currentSection === 'profitAnalysis' || currentSection === 'insights') renderCurrentSection();
        refreshOpenModals();
        if (itemsListenerReadyResolve) {
          itemsListenerReadyResolve();
          itemsListenerReadyResolve = null;
          itemsListenerReadyReject = null;
        }
      } catch (e) {
        if (itemsListenerReadyReject) itemsListenerReadyReject(e);
        console.warn('items onSnapshot handler error', e);
      }
    }, function(error) {
      if (itemsListenerReadyReject) itemsListenerReadyReject(error);
      console.warn('items listener error', error);
    });
    realtimeListeners.push(unsubItems);
  } catch (e) {
    itemsListenerStarted = false;
    if (itemsListenerReadyReject) itemsListenerReadyReject(e);
  }
  return itemsListenerReadyPromise;
}

function attachRealtimeListeners() {
  var todayStart = getStartOfDay();
  var todayKey = window.DailySalesSummary ? window.DailySalesSummary.toDayKey(Date.now()) : '';

  if (todayKey) {
    try {
      var unsubDailySales = db.collection('dailySales').doc(todayKey).onSnapshot(function(doc) {
        try {
          if (doc && doc.exists) {
            dashboardDailySalesSummary = window.DailySalesSummary.normalizeSummary(doc.data(), todayKey);
          } else {
            dashboardDailySalesSummary = window.DailySalesSummary ? window.DailySalesSummary.getDefaultSummary(todayKey) : null;
          }
          if (currentSection === 'dashboard') renderDashboard();
        } catch (e) {
          console.warn('dailySales listener error', e);
        }
      });
      realtimeListeners.push(unsubDailySales);
    } catch (e) {
      console.warn('failed to attach dailySales listener', e);
    }
  }

  var unsubSales = db.collection('sales').where('timestamp', '>=', todayStart).orderBy('timestamp', 'desc')
    .onSnapshot(function(snap) {
      var changed = false;
      snap.docChanges().forEach(function(change) {
        var data = { saleId: change.doc.id, ...change.doc.data() };
        if (change.type === 'added') {
          var exists = allSales.findIndex(function(s) { return s.saleId ===
            data.saleId; });
          if (exists === -1) { allSales.unshift(data);
            changed = true; }
        } else if (change.type === 'modified') {
          var idx = allSales.findIndex(function(s) { return s.saleId === data
              .saleId; });
          if (idx !== -1) { allSales[idx] = data;
            changed = true; }
        } else if (change.type === 'removed') {
          var before = allSales.length;
          allSales = allSales.filter(function(s) { return s.saleId !== data.saleId; });
          if (allSales.length !== before) changed = true;
        }
      });
      if (changed && (currentSection === 'dashboard' || currentSection === 'insights' ||
          currentSection === 'profitAnalysis')) { renderCurrentSection(); }
    });
  realtimeListeners.push(unsubSales);

  // currency settings realtime listener
  try {
    var unsubCurrency = db.collection('currencySettings').doc('settings').onSnapshot(function(doc) {
      try {
        if (doc.exists) {
          currencySettings = normalizeCurrencySettings(doc.data());
          setCachedData('currencySettings', currencySettings);
          applySystemCurrencyDefaults();
          updatePriceLabels();
          updateProductPriceDisplay();
          updateSellPriceDisplay();
          updateEditSalePriceDisplay();
          if (currentSection === 'inventory' || currentSection === 'dashboard') renderCurrentSection();
        }
      } catch (e) { console.warn('currency onSnapshot handler error', e); }
    });
    realtimeListeners.push(unsubCurrency);
  } catch (e) { console.warn('failed to attach currency listener', e); }

  // stats totals realtime listener
  try {
    var unsubStats = db.collection('stats').doc('totals').onSnapshot(function(doc) {
      try {
        if (doc.exists) {
          var statsData = doc.data() || {};
          var hasAllTimeProfit = Object.prototype.hasOwnProperty.call(statsData, 'allTimeProfit');
          window._cachedStats.allTimeProfitLoaded = hasAllTimeProfit && Number.isFinite(Number(statsData.allTimeProfit));
          window._cachedStats.allTimeProfit = window._cachedStats.allTimeProfitLoaded ? Number(statsData.allTimeProfit) : 0;
          if (XMetalCapitalSummary.applyState(statsData).available) {
            window._cachedStats.totalCapital = statsData.totalCapital;
            window._cachedStats.totalCapitalItemCount = statsData.totalCapitalItemCount;
          }
          if (currentSection === 'dashboard' || currentSection === 'profitAnalysis') renderCurrentSection();
        }
      } catch (e) { console.warn('stats onSnapshot handler error', e); }
    });
    realtimeListeners.push(unsubStats);
  } catch (e) { console.warn('failed to attach stats listener', e); }
}

// Update open modals (sell/edit) so their max values reflect authoritative quantities
function refreshOpenModals() {
  try {
    // sell modal
    var sellForm = document.getElementById('sellForm');
    if (sellForm && sellForm.dataset && sellForm.dataset.itemId) {
      var sid = sellForm.dataset.itemId;
      var sItem = allItems.find(function(i) { return i.id === sid; });
      if (sItem) {
        var el = document.getElementById('sellQuantity');
        if (el) el.max = sItem.quantity;
        var priceEl = document.getElementById('sellPrice');
        if (priceEl && sItem.salePrice != null) {
          priceEl.value = tempSellMode ? fmtMoney(convertToSecondary(sItem.salePrice)) : fmtMoney(sItem.salePrice);
          updateSellPriceDisplay();
        }
      }
    }
    // edit sale modal
    var editModal = document.getElementById('editSaleModal');
    if (editModal && editModal.classList.contains('show')) {
      var saleId = document.getElementById('editSaleId').value;
      var sale = allSales.find(function(s) { return s.saleId === saleId; });
      if (sale) {
        var prod = allItems.find(function(i) { return i.id === sale.itemId; });
        if (prod) {
          var eq = document.getElementById('editQuantity');
          if (eq) eq.max = (Number(prod.quantity) || 0) + (Number(sale.quantity) || 0);
          var priceEl2 = document.getElementById('editPrice');
          if (priceEl2 && sale.unitPrice != null) {
            priceEl2.value = tempEditMode ? fmtMoney(convertToSecondary(sale.unitPrice)) : fmtMoney(sale.unitPrice);
            updateEditSalePriceDisplay();
          }
        }
      }
    }
  } catch (e) { console.warn('refreshOpenModals error', e); }
}

async function fetchInitialSales() {
  var cachedSales = getCachedData('sales_full');
  if (Array.isArray(cachedSales) && cachedSales.length) {
    allSales = cachedSales;
  }
  try {
    var oneYearAgo = Date.now() - 365 * 86400000;
    var snap = await db.collection('sales').where('timestamp', '>=', oneYearAgo).orderBy('timestamp', 'desc').limit(1000).get({ source: 'cache' });
    allSales = snap.docs.map(function(d) { return { saleId: d.id, ...d.data() }; });
    allSalesFullLoaded = false;
    setCachedData('sales_full', allSales);
  } catch (e) {
    // Keep already restored cache intact. Do not clear it when Firestore is not reachable.
    if (!Array.isArray(allSales) || !allSales.length) {
      var fallbackSales = getCachedData('sales_full');
      if (Array.isArray(fallbackSales)) allSales = fallbackSales;
    }
  }
}

async function ensureFullSalesData() {
  if (allSalesFullLoaded) return;
  toggleLoading(true);
  try {
    var snap = await db.collection('sales').orderBy('timestamp', 'desc').get();
    var fullData = snap.docs.map(function(d) { return { saleId: d.id, ...d.data() }; });
    var existingIds = new Set(allSales.map(function(s) { return s.saleId; }));
    var newEntries = fullData.filter(function(s) { return !existingIds.has(s.saleId); });
    if (newEntries.length > 0 || fullData.length > allSales.length) { allSales = fullData; }
    allSalesFullLoaded = true;
    setCachedData('sales_full', allSales);
  } catch (e) {}
  toggleLoading(false);
}

function getPageRangeLabel(page, pageSize, currentCount, labelSuffix) {
  if (!currentCount) return 'لا توجد سجلات';
  var start = page * pageSize + 1;
  var end = start + currentCount - 1;
  return 'عرض ' + start + ' - ' + end + ' ' + labelSuffix;
}

function filterSalesItems(items) {
  var sp = salesFilterParams;
  var now = Date.now();
  return items.filter(function(s) {
    if (!s) return false;
    if (sp.period === 'today' && s.timestamp < getStartOfDay()) return false;
    if (sp.period === 'week' && s.timestamp < getStartOfWeek()) return false;
    if (sp.period === 'month' && s.timestamp < getStartOfMonth()) return false;
    if (sp.period === 'year' && s.timestamp < getStartOfYear()) return false;
    if (sp.period === '7days' && s.timestamp < now - 7 * 86400000) return false;
    if (sp.period === '30days' && s.timestamp < now - 30 * 86400000) return false;
    if (sp.period === '90days' && s.timestamp < now - 90 * 86400000) return false;
    if (sp.period === 'custom') {
      if (sp.customStart && s.timestamp < sp.customStart) return false;
      if (sp.customEnd && s.timestamp > sp.customEnd) return false;
    }
    if (sp.productId && s.itemId !== sp.productId) return false;
    if (sp.minProfit !== '' && (Number(s.profit) || 0) < parseFloat(sp.minProfit)) return false;
    if (sp.maxProfit !== '' && (Number(s.profit) || 0) > parseFloat(sp.maxProfit)) return false;
    if (sp.minQty !== '' && (Number(s.quantity) || 0) < parseFloat(sp.minQty)) return false;
    if (sp.maxQty !== '' && (Number(s.quantity) || 0) > parseFloat(sp.maxQty)) return false;
    if (sp.searchTerm) {
      var term = sp.searchTerm.toLowerCase();
      if (!((s.itemName || '').toLowerCase().includes(term))) return false;
    }
    if (sp.categoryId) {
      var catItems = allItems.filter(function(i) { return i.categoryId === sp.categoryId; }).map(function(i) { return i.id; });
      if (!catItems.includes(s.itemId)) return false;
    }
    if (sp.minProfitPct !== '' || sp.maxProfitPct !== '') {
      var cost = (Number(s.purchasePriceAtTime) || 0) * (Number(s.quantity) || 0);
      var pct = cost > 0 ? ((Number(s.profit) || 0) / cost * 100) : 0;
      if (sp.minProfitPct !== '' && pct < parseFloat(sp.minProfitPct)) return false;
      if (sp.maxProfitPct !== '' && pct > parseFloat(sp.maxProfitPct)) return false;
    }
    return true;
  });
}

function filterActivityItems(items) {
  var sp = activityFilterParams;
  return items.filter(function(item) {
    if (!item) return false;
    if (sp.period === 'today' && item.timestamp < getStartOfDay()) return false;
    if (sp.period === 'week' && item.timestamp < getStartOfWeek()) return false;
    if (sp.period === 'month' && item.timestamp < getStartOfMonth()) return false;
    if (sp.period === 'year' && item.timestamp < getStartOfYear()) return false;
    if (sp.period === 'custom') {
      if (sp.customStart && item.timestamp < sp.customStart) return false;
      if (sp.customEnd && item.timestamp > sp.customEnd) return false;
    }
    if (sp.actionType && item.actionType !== sp.actionType) return false;
    if (sp.entity && item.entity !== sp.entity) return false;
    if (sp.user && item.user !== sp.user) return false;
    if (sp.searchTerm && !activityMatchesSearch(item, sp.searchTerm.toLowerCase())) return false;
    return true;
  });
}

async function ensureFullActivityData() {
  if (allActivityFullLoaded) return;
  toggleLoading(true);
  try {
    var snap = await db.collection('activityLog').orderBy('timestamp', 'desc').get();
    allActivity = snap.docs.map(function(d) { return { id: d.id, ...d.data() }; });
    allActivityFullLoaded = true;
  } catch (e) {
    allActivity = [];
  }
  toggleLoading(false);
}

async function fetchItemsSmart() {
  var cached = getCachedData('items');
  if (cached) allItems = cached;
  try {
    var snap = await db.collection('items').get({ source: 'cache' });
    allItems = snap.docs.map(function(d) { return { id: d.id, ...d.data() }; });
    setCachedData('items', allItems);
  } catch (e) {
    if (!Array.isArray(allItems) || !allItems.length) {
      var storedItems = getCachedData('items');
      if (Array.isArray(storedItems)) allItems = storedItems;
    }
  }
}

async function fetchCategoriesSmart() {
  var cached = getCachedData('categories');
  if (cached) { allCategories = cached; }
  try {
    var snap = await db.collection('categories').get({ source: 'cache' });
    allCategories = snap.docs.map(function(d) { return { id: d.id, ...d.data() }; });
    setCachedData('categories', allCategories);
  } catch (e) {
    if (!Array.isArray(allCategories) || !allCategories.length) {
      var storedCategories = getCachedData('categories');
      if (Array.isArray(storedCategories)) allCategories = storedCategories;
    }
  }
}

async function fetchCurrencySettings() {
  try {
    var d = await db.collection('currencySettings').doc('settings').get({ source: 'cache' });
    if (d.exists) currencySettings = normalizeCurrencySettings(d.data());
  } catch (e) {}
  var CurrencyName = document.getElementById('CurrencyName');
  var CurrencySymbol = document.getElementById('CurrencySymbol');
  var rate = document.getElementById('rate');
  if (CurrencyName) CurrencyName.value = currencySettings.CurrencyName || 'ريال سعودي';
  if (CurrencySymbol) CurrencySymbol.value = currencySettings.CurrencySymbol || '﷼';
  if (rate) rate.value = currencySettings.rate || 1;
  var systemRadios = document.querySelectorAll('input[name="baseCurrency"]');
  systemRadios.forEach(function(r) { if (r.value === getSystemCurrency()) r.checked = true; });
  var dualPrices = document.getElementById('showProductPrices');
  if (dualPrices) dualPrices.checked = false;
  var enableBatches = document.getElementById('enablePurchaseBatches');
  if (enableBatches) enableBatches.checked = !!currencySettings.enablePurchaseBatches;
  applySystemCurrencyDefaults();
  tempEditMode = false;
  updatePriceLabels();
  updateProductPriceDisplay();
  updateSellPriceDisplay();
  updateEditSalePriceDisplay();
  updatePurchaseBatchesVisibility();
}

async function fetchStoreInfo() {
  try {
    var settingsDoc = await db.collection('settings').doc('storeInfo').get({ source: 'cache' });
    if (settingsDoc.exists && settingsDoc.data()) {
      storeInfoData = Object.assign({}, storeInfoData, settingsDoc.data());
      if (document.getElementById('storeNameSettingInput')) {
        document.getElementById('storeNameSettingInput').value = settingsDoc.data().name || settingsDoc.data().storeName || '';
      }
      return;
    }
    var d = await db.collection('storeInfo').doc('info').get({ source: 'cache' });
    if (d.exists) {
      storeInfoData = d.data();
      if (document.getElementById('storeNameSettingInput')) {
        document.getElementById('storeNameSettingInput').value = d.data().name || d.data().storeName || '';
      }
    }
  } catch (e) {}
}

function formatUserDisplayNamesForInput(data) {
  var map = data && typeof data === 'object' ? data : {};
  var rows = [];
  Object.keys(map).forEach(function(key) {
    var value = map[key];
    var email = key;
    var name = '';
    if (value && typeof value === 'object') {
      if (value.name || value.displayName || value.fullName) {
        email = value.email || value.userEmail || key;
        name = value.name || value.displayName || value.fullName;
      }
    } else if (typeof value === 'string') {
      name = value;
    }
    if (email && name) rows.push(String(email).trim() + ' | ' + String(name).trim());
  });
  return rows.join('\n');
}

function parseUserDisplayNamesFromInput(rawText) {
  var map = {};
  var lines = String(rawText || '').split(/\r?\n/);
  lines.forEach(function(line) {
    var trimmed = line.trim();
    if (!trimmed) return;
    var splitIndex = trimmed.indexOf('|');
    var email = splitIndex >= 0 ? trimmed.slice(0, splitIndex).trim() : trimmed;
    var name = splitIndex >= 0 ? trimmed.slice(splitIndex + 1).trim() : '';
    if (!email || !name) return;
    map[String(email).trim().toLowerCase()] = String(name).trim();
  });
  return map;
}

function syncUserDisplayNameRowsToInput() {
  var list = document.getElementById('userDisplayNamesList');
  var textArea = document.getElementById('userDisplayNamesText');
  if (!list || !textArea) return;
  var rows = Array.from(list.querySelectorAll('.user-display-name-row')).map(function(row) {
    var emailInput = row.querySelector('.user-display-email');
    var nameInput = row.querySelector('.user-display-name');
    var email = emailInput ? String(emailInput.value || '').trim() : '';
    var name = nameInput ? String(nameInput.value || '').trim() : '';
    return email && name ? email + ' | ' + name : '';
  }).filter(Boolean);
  textArea.value = rows.join('\n');
}

function addUserDisplayNameRow(email, name) {
  var list = document.getElementById('userDisplayNamesList');
  if (!list) return;
  var row = document.createElement('div');
  row.className = 'user-display-name-row';

  var nameField = document.createElement('div');
  nameField.className = 'user-display-name-field';
  nameField.innerHTML = '<input class="user-display-name" type="text" autocomplete="off" aria-label="اسم المستخدم" placeholder="الاسم الكامل">';

  var emailField = document.createElement('div');
  emailField.className = 'user-display-name-field';
  emailField.innerHTML = '<input class="user-display-email" type="email" autocomplete="off" aria-label="البريد الإلكتروني" placeholder="example@gmail.com">';

  row.appendChild(nameField);
  row.appendChild(emailField);
  row.appendChild(createUserDisplayNameAction(email || '', row, list));
  list.appendChild(row);
  emailField.querySelector('input').value = email || '';
  nameField.querySelector('input').value = name || '';
  emailField.querySelector('input').addEventListener('input', function() {
    syncUserDisplayNameRowsToInput();
    refreshUserDisplayNameAction(row, list);
  });
  nameField.querySelector('input').addEventListener('input', syncUserDisplayNameRowsToInput);
}

function refreshUserDisplayNameAction(row, list) {
  if (!row || !list) return;
  var emailInput = row.querySelector('.user-display-email');
  var oldAction = row.querySelector('.user-display-name-action');
  if (!emailInput || !oldAction) return;
  var nextAction = createUserDisplayNameAction(String(emailInput.value || '').trim(), row, list);
  row.replaceChild(nextAction, oldAction);
}

function createUserDisplayNameAction(email, row, list) {
  var action = document.createElement('div');
  action.className = 'user-display-name-action';
  if (email) {
    var isAdmin = String(mobileSalesAdminAccount.email || '').toLowerCase() === String(email).toLowerCase();
    if (isAdmin) {
      var activeButton = document.createElement('button');
      activeButton.type = 'button';
      activeButton.className = 'user-display-admin-btn is-active';
      activeButton.disabled = true;
      activeButton.setAttribute('aria-label', 'أدمن حالي');
      activeButton.title = 'أدمن حالي';
      activeButton.innerHTML = '<i class="fas fa-user-shield"></i>';
      action.appendChild(activeButton);
    } else {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'user-display-admin-btn is-inactive';
      button.setAttribute('aria-label', 'تحويل إلى أدمن');
      button.title = 'تحويل إلى أدمن';
      button.innerHTML = '<i class="fas fa-shield-halved"></i>';
      button.addEventListener('click', function() { promoteUserDisplayNameToAdmin(email); });
      action.appendChild(button);
    }
  }
  var removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'user-display-remove-btn';
  removeButton.setAttribute('aria-label', 'حذف المستخدم');
  removeButton.title = 'حذف المستخدم';
  removeButton.innerHTML = '<i class="fas fa-trash"></i>';
  removeButton.addEventListener('click', function() {
    row.remove();
    if (!list.querySelector('.user-display-name-row')) addUserDisplayNameRow('', '');
    syncUserDisplayNameRowsToInput();
  });
  action.appendChild(removeButton);
  return action;
}

async function promoteUserDisplayNameToAdmin(email) {
  var cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail) return;
  var configuredName = userDisplayNameSettings && userDisplayNameSettings[cleanEmail];
  var userName = typeof configuredName === 'string' ? configuredName.trim() : '';
  if (!userName) userName = cleanEmail;
  try {
    var payload = await saveMobileSalesAdminSelection({ uid: '', email: cleanEmail });
    if (payload) {
      await logActivity('mobileSalesAdminUpdate', 'settings', 'mobileSales', 'تحديث حساب الأدمن لصفحة المبيعات الهاتفية', payload);
      renderUserDisplayNameRows(userDisplayNameSettings);
      showToast('تم تحويل ' + userName + ' إلى أدمن');
    }
  } catch (error) {
    console.error('Unable to promote user to mobile sales admin', error);
    showToast('تعذر تحويل المستخدم إلى أدمن');
  }
}

function renderUserDisplayNameRows(settings) {
  var list = document.getElementById('userDisplayNamesList');
  if (!list) return;
  list.innerHTML = '';
  var entries = Object.keys(settings || {}).map(function(email) {
    return { email: email, name: settings[email] };
  }).filter(function(entry) { return entry.email && entry.name; });
  if (!entries.length) entries.push({ email: '', name: '' });
  entries.forEach(function(entry) { addUserDisplayNameRow(entry.email, entry.name); });
  syncUserDisplayNameRowsToInput();
}

async function fetchUserDisplayNameSettings() {
  try {
    var d = await db.collection('settings').doc('userDisplayNames').get({ source: 'cache' });
    if (d.exists && d.data()) userDisplayNameSettings = d.data();
  } catch (e) {}
  if (!userDisplayNameSettings || typeof userDisplayNameSettings !== 'object') userDisplayNameSettings = {};
  var textArea = document.getElementById('userDisplayNamesText');
  if (textArea) textArea.value = formatUserDisplayNamesForInput(userDisplayNameSettings);
  await loadMobileSalesAdminSelection();
  renderUserDisplayNameRows(userDisplayNameSettings);
}

async function getSystemMobileSalesAdminCandidates() {
  var candidates = [];
  var seen = {};
  function addCandidate(item) {
    if (!item || typeof item !== 'object') return;
    var email = String(item.email || item.userEmail || item.accountEmail || '').trim().toLowerCase();
    var name = String(item.name || item.displayName || item.fullName || item.label || email || '').trim();
    var uid = String(item.uid || item.userId || item.id || '').trim();
    if (!email && !uid) return;
    var key = email || uid;
    if (!seen[key]) {
      seen[key] = { uid: uid, email: email, name: name };
      candidates.push(seen[key]);
    }
  }

  try {
    var employeesSnapshot = await db.collection('employees').get();
    employeesSnapshot.docs.forEach(function(doc) { addCandidate(Object.assign({ id: doc.id }, doc.data())); });
  } catch (error) {}

  if (userDisplayNameSettings && typeof userDisplayNameSettings === 'object') {
    Object.keys(userDisplayNameSettings).forEach(function(key) {
      var value = userDisplayNameSettings[key];
      var email = String(key || '').trim().toLowerCase();
      var name = typeof value === 'string' ? value : (value && (value.name || value.displayName || value.fullName || value.label)) ? String(value.name || value.displayName || value.fullName || value.label).trim() : '';
      addCandidate({ email: email, name: name });
    });
  }

  if (auth && auth.currentUser && auth.currentUser.email) {
    addCandidate({ uid: auth.currentUser.uid || '', email: String(auth.currentUser.email).trim().toLowerCase(), name: auth.currentUser.displayName || auth.currentUser.email || '' });
  }

  return candidates;
}

async function loadMobileSalesAdminSelection() {
  var select = document.getElementById('mobileSalesAdminAccountSelect');
  if (select) select.innerHTML = '<option value="">-- لا يوجد حساب محدد --</option>';
  var candidates = await getSystemMobileSalesAdminCandidates();
  candidates.forEach(function(account) {
    if (!select) return;
    var option = document.createElement('option');
    option.value = account.uid || account.email || '';
    option.textContent = account.name ? (account.name + ' (' + (account.email || account.uid || 'غير محدد') + ')') : (account.email || account.uid || 'غير محدد');
    if (account.email) option.dataset.email = account.email;
    if (account.uid) option.dataset.uid = account.uid;
    select.appendChild(option);
  });

  var selectedAccount = { uid: '', email: '' };
  try {
    var doc = await db.collection('settings').doc('mobileSales').get();
    if (doc && doc.exists) {
      var data = doc.data() || {};
      selectedAccount.uid = String(data.mobileSalesAdminUid || data.mobileSalesAdmin && data.mobileSalesAdmin.uid || '').trim();
      selectedAccount.email = String(data.mobileSalesAdminEmail || data.mobileSalesAdmin && data.mobileSalesAdmin.email || '').trim().toLowerCase();
    }
  } catch (error) {}

  mobileSalesAdminAccount = selectedAccount;

  if (select && (selectedAccount.uid || selectedAccount.email)) {
    var matched = Array.from(select.options).find(function(option) {
      return (selectedAccount.uid && option.dataset.uid && option.dataset.uid === selectedAccount.uid) || (selectedAccount.email && option.dataset.email && option.dataset.email.toLowerCase() === selectedAccount.email.toLowerCase()) || option.value === selectedAccount.uid || option.value === selectedAccount.email;
    });
    if (matched) {
      select.value = matched.value;
    }
  }

  return selectedAccount;
}

async function saveMobileSalesAdminSelection(accountOverride) {
  if (!db || !db.collection) return null;
  var select = document.getElementById('mobileSalesAdminAccountSelect');
  var selectedValue = select ? String(select.value || '').trim() : '';
  var account = { uid: '', email: '' };
  if (accountOverride) {
    account.uid = String(accountOverride.uid || '').trim();
    account.email = String(accountOverride.email || '').trim().toLowerCase();
  }
  if (selectedValue && !accountOverride) {
    var selectedOption = select.selectedOptions && select.selectedOptions[0];
    account.uid = selectedOption && selectedOption.dataset.uid ? selectedOption.dataset.uid : selectedValue;
    account.email = selectedOption && selectedOption.dataset.email ? selectedOption.dataset.email : selectedValue;
  }
  var payload = {
    mobileSalesAdminUid: account.uid,
    mobileSalesAdminEmail: account.email,
    mobileSalesAdmin: { uid: account.uid, email: account.email },
    updatedAt: Date.now()
  };
  await db.collection('settings').doc('mobileSales').set(payload, { merge: true });
  mobileSalesAdminAccount = account;
  return payload;
}

function isPurchaseBatchesEnabled() {
  return !!currencySettings.enablePurchaseBatches;
}

function updatePurchaseBatchesVisibility() {
  var container = document.getElementById('purchaseBatchesContainer');
  if (container) container.style.display = isPurchaseBatchesEnabled() ? 'block' : 'none';
}

function renderCurrencySettingsForm() {
  var CurrencyName = document.getElementById('CurrencyName');
  var CurrencySymbol = document.getElementById('CurrencySymbol');
  var rate = document.getElementById('rate');
  if (CurrencyName) CurrencyName.value = currencySettings.CurrencyName || 'ريال سعودي';
  if (CurrencySymbol) CurrencySymbol.value = currencySettings.CurrencySymbol || '﷼';
  if (rate) rate.value = currencySettings.rate || 1;
  var systemRadios = document.querySelectorAll('input[name="baseCurrency"]');
  systemRadios.forEach(function(r) { r.checked = (r.value === getSystemCurrency()); });
  var dualPrices = document.getElementById('showProductPrices');
  if (dualPrices) dualPrices.checked = false;
  var enableBatches = document.getElementById('enablePurchaseBatches');
  if (enableBatches) enableBatches.checked = !!currencySettings.enablePurchaseBatches;
  updatePurchaseBatchesVisibility();
}

async function fetchExpensesSmart() {
  var cached = getCachedData('expenses');
  if (cached) { allExpenses = cached; }
  try {
    var snap = await db.collection('expenses').orderBy('date', 'desc').get({ source: 'cache' });
    allExpenses = snap.docs.map(function(d) { return { id: d.id, ...d.data() }; });
    setCachedData('expenses', allExpenses);
  } catch (e) {
    if (!Array.isArray(allExpenses) || !allExpenses.length) {
      var storedExpenses = getCachedData('expenses');
      if (Array.isArray(storedExpenses)) allExpenses = storedExpenses;
    }
  }
}

var managedEmployees = [];
var includeInactiveEmployees = false;
var employeeHistoryPagination = {};
var treasuryOperations = [];
var treasuryEntries = [];
function treasuryCashAmount(amount, code, rateAtTime) {
  var value = Number(amount) || 0;
  var currencyCode = String(code || 'primary').trim().toLowerCase();
  if (currencyCode !== 'primary' && currencyCode !== '') currencyCode = 'primary';
  if (currencyCode === 'primary') return value;
  var rate = Number(rateAtTime != null ? rateAtTime : null);
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  return value / rate;
}
function treasuryMoney(amount) {
  return fmtMoney(amount) + ' ' + (currencySettings.CurrencySymbol || '');
}
async function hasTreasuryManagementAccess() {
  var user = auth && auth.currentUser;
  if (!user) return false;
  if (typeof user.getIdTokenResult === 'function') {
    try {
      var token = await user.getIdTokenResult();
      var claims = token && token.claims ? token.claims : {};
      if (claims.admin === true || claims.manager === true || claims.role === 'admin' || claims.role === 'manager') return true;
    } catch (error) {}
  }
  var localRole = window.permissionManager && window.permissionManager.userRole;
  if (localRole === 'admin' || localRole === 'manager') return true;
  var stateRole = window.appState && window.appState.user ? window.appState.user.role : '';
  return stateRole === 'admin' || stateRole === 'manager';
}
function treasuryCancelled(entry) {
  var status = String(entry && entry.status || '').toLowerCase();
  return Boolean(entry && (entry.cancelled || entry.isCancelled || status === 'cancelled' || status === 'refunded' || status === 'returned' || status === 'deleted'));
}
function buildTreasuryEntries() {
  var entries = [];
  (Array.isArray(allSales) ? allSales : []).filter(function (sale) { return sale && !treasuryCancelled(sale) && String(sale.paymentMethod || '').toLowerCase() === 'cash'; }).forEach(function (sale) {
    var rawSaleAmount = Number(sale.baseAmount != null ? sale.baseAmount : (sale.totalAmount != null ? sale.totalAmount : (sale.amount != null ? sale.amount : 0))) || 0;
    var saleMode = String(sale.baseAmount != null ? (sale.baseCurrency || 'primary') : (sale.saleMode || sale.currency || sale.baseCurrency || 'primary')).trim().toLowerCase();
    entries.push({ id: 'sale_' + (sale.saleId || sale.id), label: 'مبيعات نقدية', amount: treasuryCashAmount(rawSaleAmount, saleMode, sale.rateAtTime), timestamp: Number(sale.timestamp) || 0, user: sale.sellerName || sale.sellerEmail || '', note: sale.itemName || '' });
  });
  treasuryDebtOperations.filter(function (operation) { return operation && !treasuryCancelled(operation) && (operation.type === 'payment' || operation.type === 'settle'); }).forEach(function (operation) {
    var debtAmount = Number(operation.amount) || 0;
    var debtCurrency = String(operation.currency || 'primary').trim().toLowerCase();
    entries.push({ id: 'debt_' + operation.id, label: operation.employeeId ? 'تحصيل دين موظف' : 'تحصيل دين عميل', amount: Math.abs(treasuryCashAmount(debtAmount, debtCurrency, operation.rateAtTime)), timestamp: Number(operation.timestamp) || 0, user: operation.createdBy || '', note: operation.note || '' });
  });
  treasuryEmployeeOperations.filter(function (operation) { return operation && !treasuryCancelled(operation) && operation.type === 'withdrawal'; }).forEach(function (operation) {
    var employeeAmount = Number(operation.amount) || 0;
    var employeeCurrency = String(operation.currency || 'primary').trim().toLowerCase();
    entries.push({ id: 'employee_' + operation.id, label: 'سلفة موظف', amount: -Math.abs(treasuryCashAmount(employeeAmount, employeeCurrency, operation.rateAtTime)), timestamp: Number(operation.timestamp) || 0, user: operation.createdBy || '', note: operation.note || '' });
  });
  (Array.isArray(allExpenses) ? allExpenses : []).filter(function (expense) { return expense && !treasuryCancelled(expense); }).forEach(function (expense) {
    var expenseAmount = Number(expense.amount != null ? expense.amount : (expense.totalAmount != null ? expense.totalAmount : (expense.baseAmount != null ? expense.baseAmount : 0))) || 0;
    var expenseCurrency = String(expense.currency || 'primary').trim().toLowerCase();
    entries.push({ id: 'expense_' + expense.id, label: 'مصروف', amount: -Math.abs(treasuryCashAmount(expenseAmount, expenseCurrency, expense.rateAtTime)), timestamp: Number(expense.date) || 0, user: expense.createdBy || '', note: expense.description || '' });
  });
  treasuryOperations.filter(function (operation) { return operation && !treasuryCancelled(operation); }).forEach(function (operation) {
    var isOpening = operation.type === 'openingBalance';
    var isRefund = operation.type === 'refund';
    var operationAmount = Number(operation.amount) || 0;
    var operationCurrency = String(operation.currency || 'primary').trim().toLowerCase();
    var normalizedAmount = treasuryCashAmount(operationAmount, operationCurrency, operation.rateAtTime);
    entries.push({ id: 'treasury_' + operation.id, label: isRefund ? 'رد مبلغ للعميل' : (isOpening ? 'الرصيد الافتتاحي' : 'سحب من الخزينة'), amount: isOpening ? Math.abs(normalizedAmount) : -Math.abs(normalizedAmount), timestamp: Number(operation.timestamp) || 0, user: operation.createdBy || '', note: operation.note || '' });
  });
  var seen = {};
  return entries.filter(function (entry) { if (seen[entry.id]) return false; seen[entry.id] = true; return true; }).sort(function (a, b) { return b.timestamp - a.timestamp; });
}
var treasuryDebtOperations = [];
var treasuryEmployeeOperations = [];
async function loadTreasuryData() {
  await ensureFullSalesData();
  var result = await Promise.all([db.collection('debtOperations').get(), db.collection('employeeOperations').get(), db.collection('treasuryOperations').get()]);
  treasuryDebtOperations = result[0].docs.map(function (doc) { return Object.assign({ id: doc.id }, doc.data()); });
  treasuryEmployeeOperations = result[1].docs.map(function (doc) { return Object.assign({ id: doc.id }, doc.data()); });
  treasuryOperations = result[2].docs.map(function (doc) { return Object.assign({ id: doc.id }, doc.data()); });
  treasuryEntries = buildTreasuryEntries();
  var canWithdraw = await hasTreasuryManagementAccess();
  document.getElementById('openTreasuryWithdrawalBtn').hidden = !canWithdraw;
  document.getElementById('openTreasuryOpeningBtn').hidden = !canWithdraw || Boolean(treasuryOperations.find(function (operation) { return operation && operation.type === 'openingBalance' && !treasuryCancelled(operation); }));
  renderTreasury();
}
function renderTreasury() {
  treasuryEntries = buildTreasuryEntries();
  var balance = treasuryEntries.reduce(function (sum, entry) { return sum + entry.amount; }, 0);
  var totals = { sales: 0, customerPayments: 0, employeePayments: 0, employeeAdvances: 0, expenses: 0, withdrawals: 0 };
  treasuryEntries.forEach(function (entry) {
    if (entry.label === 'مبيعات نقدية') totals.sales += entry.amount;
    else if (entry.label === 'تحصيل دين عميل') totals.customerPayments += entry.amount;
    else if (entry.label === 'تحصيل دين موظف') totals.employeePayments += entry.amount;
    else if (entry.label === 'سلفة موظف') totals.employeeAdvances += Math.abs(entry.amount);
    else if (entry.label === 'مصروف') totals.expenses += Math.abs(entry.amount);
    else if (entry.label === 'سحب من الخزينة') totals.withdrawals += Math.abs(entry.amount);
  });
  var openingEntry = treasuryEntries.find(function (entry) { return entry.label === 'الرصيد الافتتاحي'; });
  var openingOperation = treasuryOperations.find(function (operation) { return operation && operation.type === 'openingBalance' && !treasuryCancelled(operation); });
  var openingInfo = document.getElementById('treasuryOpeningInfo');
  if (openingInfo) openingInfo.innerHTML = openingOperation ? '<strong>الرصيد الافتتاحي المعتمد: ' + treasuryMoney(openingOperation.amount) + '</strong><span>تاريخ التسجيل: ' + escHtml(fmtDateTime(openingOperation.timestamp)) + '</span><span>سجله: ' + escHtml(openingOperation.createdBy || '') + '</span>' : '<span>لم يتم تسجيل رصيد افتتاحي بعد</span>';
  var summary = document.getElementById('treasurySummary');
  if (summary) summary.innerHTML = '<div class="stat-card"><h4>الخزينة الحالية</h4><strong>' + treasuryMoney(balance) + '</strong></div><div class="stat-card"><h4>الرصيد الافتتاحي</h4><strong>' + (openingEntry ? treasuryMoney(openingEntry.amount) : 'غير مسجل') + '</strong></div><div class="stat-card"><h4>المبيعات النقدية</h4><strong>' + treasuryMoney(totals.sales) + '</strong></div><div class="stat-card"><h4>تحصيل ديون العملاء</h4><strong>' + treasuryMoney(totals.customerPayments) + '</strong></div><div class="stat-card"><h4>تحصيل ديون الموظفين</h4><strong>' + treasuryMoney(totals.employeePayments) + '</strong></div><div class="stat-card"><h4>السلف والمصروفات</h4><strong>' + treasuryMoney(totals.employeeAdvances + totals.expenses) + '</strong></div><div class="stat-card"><h4>سحوبات الخزينة</h4><strong>' + treasuryMoney(totals.withdrawals) + '</strong></div>';
  var running = balance;
  var body = document.getElementById('treasuryBody');
  if (!body) return;
  body.innerHTML = treasuryEntries.map(function (entry) { var after = running; running -= entry.amount; return '<tr><td>' + escHtml(fmtDateTime(entry.timestamp)) + '</td><td>' + escHtml(entry.label) + '</td><td class="' + (entry.amount >= 0 ? 'text-success' : 'text-danger') + '">' + (entry.amount >= 0 ? '+' : '-') + ' ' + escHtml(treasuryMoney(Math.abs(entry.amount))) + '</td><td>' + escHtml(treasuryMoney(after)) + '</td><td>' + escHtml(entry.user || '') + '</td></tr>'; }).join('') || '<tr><td colspan="5">لا توجد حركات نقدية</td></tr>';
}
function openTreasuryWithdrawal() {
  var balance = treasuryEntries.reduce(function (sum, entry) { return sum + entry.amount; }, 0);
  document.getElementById('treasuryCurrentBalance').value = treasuryMoney(balance);
  document.getElementById('treasuryKeepAmount').value = 0;
  updateTreasuryWithdrawalPreview();
  document.getElementById('treasuryWithdrawalModal').classList.add('show');
}
async function openTreasuryOpening() {
  if (!await hasTreasuryManagementAccess()) return showToast('لا تملك صلاحية إضافة الرصيد الافتتاحي', 'error');
  var existing = treasuryOperations.find(function (operation) { return operation && operation.type === 'openingBalance' && !treasuryCancelled(operation); });
  if (existing) return showToast('يوجد رصيد افتتاحي معتمد للخزينة بالفعل', 'error');
  document.getElementById('treasuryOpeningAmount').value = '';
  document.getElementById('treasuryOpeningDate').value = getSystemDateInputValue();
  document.getElementById('treasuryOpeningNote').value = '';
  document.getElementById('treasuryOpeningModal').classList.add('show');
}
async function saveTreasuryOpening(event) {
  event.preventDefault();
  if (!await hasTreasuryManagementAccess()) return showToast('لا تملك صلاحية إضافة الرصيد الافتتاحي', 'error');
  var existing = treasuryOperations.find(function (operation) { return operation && operation.type === 'openingBalance' && !treasuryCancelled(operation); });
  if (existing) return showToast('يوجد رصيد افتتاحي معتمد للخزينة بالفعل', 'error');
  var amount = Number(document.getElementById('treasuryOpeningAmount').value) || 0;
  var dateValue = document.getElementById('treasuryOpeningDate').value;
  if (amount < 0 || !dateValue) return showToast('يرجى إدخال مبلغ وتاريخ صحيحين', 'error');
  var user = auth.currentUser;
  if (!user) return showToast('يجب تسجيل الدخول', 'error');
  var id = 'treasury_opening_balance';
  var currentTime = systemDateParts(Date.now());
  var timestamp = Date.parse(dateValue + 'T' + currentTime.hour + ':' + currentTime.minute + ':00+03:00');
  var openingRef = db.collection('treasuryOperations').doc(id);
  await db.runTransaction(function (transaction) {
    return transaction.get(openingRef).then(function (snapshot) {
      if (snapshot.exists && !treasuryCancelled(snapshot.data())) throw new Error('يوجد رصيد افتتاحي معتمد للخزينة بالفعل');
      transaction.set(openingRef, { id: id, type: 'openingBalance', amount: amount, currency: getSystemCurrency(), dateKey: dateValue, timestamp: timestamp, createdAt: Date.now(), createdBy: user.email || user.uid || '', note: document.getElementById('treasuryOpeningNote').value.trim(), status: 'active', source: 'admin' });
    });
  });
  await loadTreasuryData();
  closeModalById('treasuryOpeningModal');
  showToast('تم تسجيل الرصيد الافتتاحي');
}
function updateTreasuryWithdrawalPreview() {
  var balance = treasuryEntries.reduce(function (sum, entry) { return sum + entry.amount; }, 0);
  var keep = Math.max(0, Number(document.getElementById('treasuryKeepAmount').value) || 0);
  document.getElementById('treasuryWithdrawalAmount').value = treasuryMoney(Math.max(0, balance - keep));
  document.getElementById('treasuryRemainingBalance').value = treasuryMoney(Math.min(balance, keep));
}
async function saveTreasuryWithdrawal(event) {
  event.preventDefault();
  var balance = treasuryEntries.reduce(function (sum, entry) { return sum + entry.amount; }, 0);
  var keep = Math.max(0, Number(document.getElementById('treasuryKeepAmount').value) || 0);
  var amount = Math.max(0, balance - keep);
  if (amount <= 0) return showToast('لا يوجد مبلغ قابل للسحب', 'error');
  if (!await hasTreasuryManagementAccess()) return showToast('لا تملك صلاحية سحب الخزينة', 'error');
  var user = auth.currentUser;
  if (!user) return showToast('يجب تسجيل الدخول لتنفيذ السحب', 'error');
  var id = 'treasury_withdrawal_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  await db.collection('treasuryOperations').doc(id).set({ id: id, type: 'withdrawal', amount: amount, currency: getSystemCurrency(), balanceBefore: balance, balanceAfter: balance - amount, timestamp: Date.now(), createdAt: Date.now(), createdBy: user.email || user.uid || '', note: document.getElementById('treasuryWithdrawalNote').value.trim(), status: 'active', source: 'admin' });
  await loadTreasuryData();
  closeModalById('treasuryWithdrawalModal');
  showToast('تم سحب المبلغ من الخزينة');
}
function employeePrimaryOperations(employeeId) {
  return managedEmployees.employeeOperations && managedEmployees.employeeOperations[employeeId] ? managedEmployees.employeeOperations[employeeId] : [];
}
function calculateManagedEmployeeBalance(employeeId, operations) {
  var employee = (Array.isArray(managedEmployees) ? managedEmployees : []).find(function (entry) { return String(entry.id) === String(employeeId); });
  var storedBalance = employee && employee.currentBalance != null ? Number(employee.currentBalance) : null;
  if (storedBalance !== null && Number.isFinite(storedBalance)) return storedBalance;
  return (Array.isArray(operations) ? operations : []).filter(function (entry) { return entry && entry.status !== 'cancelled'; }).reduce(function (balance, entry) {
    var amount = Number(entry.amount) || 0;
    return balance + (entry.type === 'wage' || entry.type === 'addition' ? amount : -amount);
  }, 0);
}
async function loadManagedEmployees() {
  var employeeQuery = db.collection('employees');
  if (!includeInactiveEmployees) employeeQuery = employeeQuery.where('status', '==', 'active');
  var employeeSnapshot = await employeeQuery.get();
  managedEmployees = employeeSnapshot.docs.map(function (doc) { return Object.assign({ id: doc.id }, doc.data()); });
  managedEmployees.sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || '')); });
  managedEmployees.employeeOperations = {};
}
function getEmployeeWageDisplayValue(employee, targetCurrency) {
  var code = targetCurrency === '' ? '' : 'primary';
  var primaryValue = Number(employee && employee.dailyWagePrimary != null ? employee.dailyWagePrimary : (employee && employee.dailyWage != null ? employee.dailyWage : 0)) || 0;
  var Value = Number(employee && employee.dailyWagePrimary != null ? employee.dailyWagePrimary : convertToSecondary(primaryValue)) || 0;
  return code === '' ? Value : primaryValue;
}
function formatEmployeeWage(employee, targetCurrency) {
  var code = targetCurrency === '' ? '' : 'primary';
  var value = getEmployeeWageDisplayValue(employee, code);
  var symbol = code === '' ? currencySettings.CurrencySymbol : '$';
  return fmtMoney(value) + ' ' + symbol;
}
function updateManagedEmployeeWageDisplay() {
  var wageInput = document.getElementById('managedEmployeeWage');
  var wageCurrencyInput = document.getElementById('managedEmployeeWageCurrency');
  var wageDisplay = document.getElementById('managedEmployeeWageSecondary');
  var wageLabel = document.getElementById('managedEmployeeWageLabel');
  if (!wageInput || !wageCurrencyInput) return;
  var selectedCurrency = wageCurrencyInput.value === '' ? '' : 'primary';
  var value = parseInputNumber(wageInput.value);
  value = value === null ? 0 : value;
  if (wageLabel) {
    wageLabel.textContent = 'الأجرة اليومية (' + (selectedCurrency === '' ? currencySettings.CurrencySymbol : '$') + ')';
  }
  if (wageDisplay) {
    var equivalentValue = selectedCurrency === '' ? convertToPrimary(value) : convertToSecondary(value);
    var equivalentSymbol = selectedCurrency === '' ? '$' : currencySettings.CurrencySymbol;
    wageDisplay.innerText = 'ما يعادلها: ' + fmtMoney(equivalentValue) + ' ' + equivalentSymbol;
  }
}
function renderManagedEmployees() {
  var body = document.getElementById('employeesBody');
  if (!body) return;
  var list = Array.isArray(managedEmployees) ? managedEmployees : [];
  body.innerHTML = list.length ? list.map(function (employee) {
    var balance = calculateManagedEmployeeBalance(employee.id, employeePrimaryOperations(employee.id));
    return '<tr><td>' + escHtml(employee.name || '') + '</td><td>' + escHtml(employee.email || '') + '</td><td>' + escHtml(formatEmployeeWage(employee, getSystemCurrency())) + '</td><td>' + (employee.status === 'active' ? 'مفعل' : 'معطل') + '</td><td>' + escHtml(employee.startDate || '') + '</td><td>' + escHtml(fmtMoney(balance)) + '</td><td><button type="button" class="btn-sm outline" data-edit-employee="' + escHtml(employee.id) + '">تعديل</button><button type="button" class="btn-sm outline" data-manage-employee-day="' + escHtml(employee.id) + '">الأيام</button><button type="button" class="btn-sm outline" data-view-employee="' + escHtml(employee.id) + '">السجل</button></td></tr>';
  }).join('') : '<tr><td colspan="7">لا يوجد موظفون</td></tr>';
}
function openManagedEmployeeForm(employee) {
  employee = employee || null;
  var rawCurrency = 'primary';
  var storedPrimaryWage = Number(employee && employee.dailyWage != null ? employee.dailyWage : 0) || 0;
  if (employee && employee.dailyWageCurrency === '') {
    rawCurrency = '';
  }
  document.getElementById('managedEmployeeId').value = employee ? employee.id : '';
  document.getElementById('employeeModalTitle').textContent = employee ? 'تعديل موظف' : 'إضافة موظف';
  document.getElementById('managedEmployeeName').value = employee ? employee.name || '' : '';
  document.getElementById('managedEmployeeEmail').value = employee ? employee.email || '' : '';
  document.getElementById('managedEmployeeWageCurrency').value = rawCurrency;
  var displayValue = rawCurrency === '' ? convertToSecondary(storedPrimaryWage) : storedPrimaryWage;
  document.getElementById('managedEmployeeWage').value = employee ? displayValue : '';
  updateManagedEmployeeWageDisplay();
  var currentDate = systemDateParts(Date.now());
  setEmployeeStartDateFields(employee ? employee.startDate || '' : (currentDate ? currentDate.year + '-' + currentDate.month + '-' + currentDate.day : ''));
  setManagedEmployeeStatus(employee ? employee.status || 'active' : 'active');
  document.getElementById('employeeModal').classList.add('show');
}
function setManagedEmployeeStatus(status) {
  var button = document.getElementById('managedEmployeeStatus');
  var isActive = status !== 'inactive';
  button.dataset.status = isActive ? 'active' : 'inactive';
  button.setAttribute('aria-pressed', String(isActive));
  button.classList.toggle('is-inactive', !isActive);
  button.innerHTML = '<i class="fas ' + (isActive ? 'fa-circle-check' : 'fa-circle-xmark') + '" aria-hidden="true"></i><span>' + (isActive ? 'مفعل' : 'معطل') + '</span>';
}
function getManagedEmployeeStatus() {
  return document.getElementById('managedEmployeeStatus').dataset.status || 'active';
}
async function saveManagedEmployee(event) {
  event.preventDefault();
  var id = document.getElementById('managedEmployeeId').value.trim() || 'employee_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  var existing = (Array.isArray(managedEmployees) ? managedEmployees : []).find(function (entry) { return entry.id === id; });
  var wageInputCurrency = document.getElementById('managedEmployeeWageCurrency') ? (document.getElementById('managedEmployeeWageCurrency').value === '' ? '' : 'primary') : 'primary';
  var wageInputValue = Number(document.getElementById('managedEmployeeWage').value) || 0;
  var wagePrimary = wageInputCurrency === 'primary' ? wageInputValue : convertToPrimary(wageInputValue);
  var startDate = document.getElementById('managedEmployeeStartDate').value;
  var wageHistory = existing && Array.isArray(existing.wageHistory) ? existing.wageHistory.slice() : [{ effectiveFrom: startDate, dailyWage: wagePrimary }];
  if (existing && Number(existing.dailyWage || 0) !== wagePrimary) wageHistory.push({ effectiveFrom: getSystemDateInputValue(), dailyWage: wagePrimary });
  var employee = { id: id, name: document.getElementById('managedEmployeeName').value.trim(), email: document.getElementById('managedEmployeeEmail').value.trim().toLowerCase(), dailyWage: wagePrimary, wageHistory: wageHistory, startDate: startDate, status: getManagedEmployeeStatus(), updatedAt: Date.now() };
  if (!employee.name || !employee.email || !isValidEmployeeDate(startDate) || wageInputValue < 0) return showToast('بيانات الموظف غير صالحة');
  await db.collection('employees').doc(id).set(employee, { merge: true });
  await loadManagedEmployees(); renderManagedEmployees(); closeModalById('employeeModal'); showToast('تم حفظ الموظف');
}
async function renderEmployeesSection() {
  await loadManagedEmployees();
  renderManagedEmployees();
}
function openManagedEmployeeHistory(employee) {
  var pagination = employeeHistoryPagination[employee.id] || { loaded: [], hasMore: false, lastDoc: null };
  var operations = (pagination.loaded && pagination.loaded.length ? pagination.loaded : employeePrimaryOperations(employee.id)).slice().sort(function (a, b) { return (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0); });
  document.getElementById('employeeHistoryTitle').textContent = 'سجل الموظف: ' + (employee.name || '');
  var rows = operations.length ? operations.map(function (operation) {
    var label = operation.type === 'wage' ? 'أجرة دوام' : operation.type === 'withdrawal' ? 'سحب' : operation.type === 'productPurchase' ? 'شراء منتج' : operation.type || 'عملية';
    var sign = operation.type === 'wage' || operation.type === 'addition' ? '+' : '-';
    return '<tr><td>' + escHtml(label) + '</td><td>' + sign + ' ' + escHtml(fmtMoney(operation.amount || 0)) + '</td><td>' + escHtml(fmtDateTime(operation.timestamp)) + '</td><td>' + escHtml(operation.note || '') + '</td></tr>';
  }).join('') : '<tr><td colspan="4">لا توجد عمليات</td></tr>';
  var moreButton = pagination.hasMore ? '<tr><td colspan="4"><button type="button" class="btn-sm outline" data-load-more-employee-history="' + escHtml(employee.id) + '">عرض المزيد</button></td></tr>' : '';
  document.getElementById('employeeHistoryBody').innerHTML = rows + moreButton;
  document.getElementById('employeeHistoryModal').classList.add('show');
}
async function loadManagedEmployeeHistory(employee, reset) {
  var employeeId = employee && employee.id ? employee.id : null;
  if (!employeeId || !db || !db.collection) return;
  if (!employeeHistoryPagination[employeeId]) employeeHistoryPagination[employeeId] = { loaded: [], hasMore: false, lastDoc: null };
  if (reset) {
    employeeHistoryPagination[employeeId] = { loaded: [], hasMore: false, lastDoc: null };
  }
  var state = employeeHistoryPagination[employeeId];
  var query = db.collection('employeeOperations').where('employeeId', '==', employeeId).limit(26);
  var snapshot = await query.get();
  var docs = snapshot.docs || [];
  var nextRecords = docs.map(function (doc) { return Object.assign({ id: doc.id }, doc.data()); }).sort(function (a, b) { return (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0); });
  state.hasMore = nextRecords.length > 25;
  if (state.hasMore) nextRecords = nextRecords.slice(0, 25);
  state.loaded = reset ? nextRecords : state.loaded.concat(nextRecords.filter(function (record) { return !state.loaded.some(function (existing) { return String(existing.id) === String(record.id); }); }));
  managedEmployees.employeeOperations[employeeId] = state.loaded.slice();
  openManagedEmployeeHistory(employee);
}
function openManagedEmployeeDay(employee) {
  document.getElementById('employeeDayEmployeeId').value = employee.id;
  document.getElementById('employeeDayEmployeeName').value = employee.name || '';
  var currentDate = systemDateParts(Date.now());
  document.getElementById('employeeDayDate').value = currentDate ? currentDate.year + '-' + currentDate.month + '-' + currentDate.day : '';
  document.getElementById('employeeDayStatus').value = 'work';
  document.getElementById('employeeDayModal').classList.add('show');
}
async function saveManagedEmployeeDay(event) {
  event.preventDefault();
  if (!await hasTreasuryManagementAccess()) return showToast('لا تملك صلاحية تعديل حالة يوم الموظف');
  var employeeId = document.getElementById('employeeDayEmployeeId').value;
  var day = document.getElementById('employeeDayDate').value;
  var status = document.getElementById('employeeDayStatus').value;
  var employee = (Array.isArray(managedEmployees) ? managedEmployees : []).find(function (entry) { return entry.id === employeeId; });
  if (!employee || !day) return showToast('بيانات اليوم غير صالحة');
  if (employee.status === 'inactive') return showToast('لا يمكن تعديل دوام موظف معطل');
  var dayId = 'employee_day_' + employeeId + '_' + day;
  var wageId = dayId + '_wage';
  var dayRef = db.collection('employeeDays').doc(dayId);
  var wageRef = db.collection('employeeOperations').doc(wageId);
  var wage = Number(employee.dailyWage) || 0;
  var operationCurrency = getSystemCurrency();
  await db.runTransaction(function (tx) {
    return tx.get(dayRef).then(function (snapshot) {
      var existingDay = snapshot.exists ? snapshot.data() : {};
      tx.set(dayRef, Object.assign({}, existingDay, { id: dayId, employeeId: employee.id, employeeName: employee.name, dateKey: day, dayName: formatDateString(new Date(day + 'T12:00:00').getTime(), false), status: status, dailyWage: Number(existingDay.dailyWage) || wage, currency: existingDay.currency || operationCurrency, updatedAt: Date.now(), updatedBy: auth.currentUser && auth.currentUser.email || '' }), { merge: true });
      if (status === 'holiday') tx.delete(wageRef);
      else tx.set(wageRef, { id: wageId, employeeId: employee.id, employeeName: employee.name, type: 'wage', amount: Number(existingDay.dailyWage) || wage, dailyWage: Number(existingDay.dailyWage) || wage, currency: existingDay.currency || operationCurrency, dateKey: day, timestamp: Date.parse(day + 'T10:00:00+03:00'), createdAt: Date.now(), note: 'أجرة دوام تلقائية', status: 'active', source: 'mobile-sales', createdBy: auth.currentUser && auth.currentUser.email || '' });
    });
  });
  closeModalById('employeeDayModal'); showToast('تم حفظ حالة اليوم');
}

function renderCurrentSection() {
  toggleLoading(true);
  document.querySelectorAll('.section-panel').forEach(function(p) { p.classList.remove('active'); });
  var secId = 'section-' + currentSection;
  var sec = document.getElementById(secId);
  if (sec) sec.classList.add('active');
  setTimeout(async function() {
    if (sectionNeedsFullItems(currentSection)) {
      try { await ensureItemsRealtimeListener(); } catch (error) { console.warn('Unable to start items listener', error); }
    }
    if (currentSection === 'productAnalytics') {
      await ensureProductSalesSummaryLoaded();
      ensureProductSalesSummaryListener();
    }
    switch (currentSection) {
      case 'dashboard':
        renderDashboard();
        break;
      case 'inventory':
        renderInventory();
        break;
      case 'addItem':
        prepareAddItemForm();
        break;
      case 'salesLog':
        renderSalesLog();
        break;
      case 'activityLog':
        renderActivityLog();
        break;
      case 'productAnalytics':
        renderProductAnalytics();
        break;
      case 'profitAnalysis':
        renderProfitAnalysis();
        break;
      case 'comparison':
        renderComparison();
        break;
      case 'insights':
        renderInsights();
        break;
      case 'expenses':
        renderExpenses();
        break;
      case 'treasury':
        loadTreasuryData().catch(function (error) { showToast('تعذر تحميل الخزينة: ' + error.message, 'error'); });
        break;
      case 'debts':
        await loadMainDebtData();
        renderDebtSection();
        break;
      case 'employees':
        renderEmployeesSection();
        break;
      case 'categories':
        renderCategories();
        break;
      case 'settings':
        activateSettingsTab('users');
        fetchUserDisplayNameSettings();
        break;
      case 'currencySettings':
        break;
    }
    toggleLoading(false);
  }, 50);
}

function activateSettingsTab(tabName) {
  var requestedTab = String(tabName || 'users');
  var tabs = document.querySelectorAll('[data-settings-tab]');
  var panels = document.querySelectorAll('[data-settings-panel]');
  var matchingTab = document.querySelector('[data-settings-tab="' + requestedTab + '"]');
  if (!matchingTab) requestedTab = 'users';
  tabs.forEach(function(tab) {
    var isActive = tab.getAttribute('data-settings-tab') === requestedTab;
    tab.classList.toggle('is-active', isActive);
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    tab.tabIndex = isActive ? 0 : -1;
  });
  panels.forEach(function(panel) {
    var isActive = panel.getAttribute('data-settings-panel') === requestedTab;
    panel.classList.toggle('is-active', isActive);
    panel.hidden = !isActive;
  });
}

document.querySelectorAll('[data-settings-tab]').forEach(function(tab) {
  tab.addEventListener('click', function() {
    activateSettingsTab(tab.getAttribute('data-settings-tab'));
  });
});

function getMainDebtCustomerBalance(customerId) {
  var customerKey = String(customerId || '');
  var operations = Array.isArray(mainDebtOperations) ? mainDebtOperations.filter(function (operation) {
    if (!operation || String(operation.customerId || '') !== customerKey) return false;
    var status = String(operation.status || '').trim().toLowerCase();
    if (status === 'cancelled' || status === 'deleted') return false;
    return true;
  }) : [];
  var total = 0;
  operations.forEach(function (operation) {
    var type = String(operation.type || '').trim().toLowerCase();
    var amount = Number(operation.amount) || 0;
    if (type === 'debt') total += amount;
    else if (type === 'payment' || type === 'settle' || type === 'return') total -= amount;
  });
  return Math.max(0, total);
}

function formatDebtAmountText(value) {
  return formatMoney(value || 0);
}

async function loadMainDebtData() {
  if (!db || !db.collection) return [];
  var [customerSnapshot, operationSnapshot] = await Promise.all([
    db.collection('debtCustomers').get(),
    db.collection('debtOperations').get()
  ]);
  mainDebtCustomers = (customerSnapshot.docs || []).map(function (doc) {
    return Object.assign({ id: doc.id }, doc.data());
  }).sort(function (a, b) {
    return String(a.name || '').localeCompare(String(b.name || ''), 'ar');
  });
  mainDebtOperations = (operationSnapshot.docs || []).map(function (doc) {
    return Object.assign({ id: doc.id }, doc.data());
  }).sort(function (a, b) {
    return (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0);
  });
  return mainDebtCustomers;
}

async function saveMainDebtCustomer(event) {
  event.preventDefault();
  if (!db || !db.collection) {
    showToast('لا يوجد اتصال بقاعدة البيانات', 'error');
    return;
  }

  var form = event.target;
  var nameInput = document.getElementById('mainDebtCustomerName');
  var phoneInput = document.getElementById('mainDebtCustomerPhone');
  var notesInput = document.getElementById('mainDebtCustomerNotes');
  var name = String(nameInput ? nameInput.value || '' : '').trim();
  var phone = String(phoneInput ? phoneInput.value || '' : '').trim();
  var notes = String(notesInput ? notesInput.value || '' : '').trim();

  if (!name) {
    showToast('يرجى إدخال اسم العميل', 'error');
    return;
  }

  var customerId = 'debt_customer_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  var customer = {
    id: customerId,
    name: name,
    phone: phone,
    notes: notes,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'active'
  };

  try {
    await db.collection('debtCustomers').doc(customerId).set(customer);
    await loadMainDebtData();
    renderDebtSection();
    form.reset();
    closeModalById('mainDebtCustomerModal');
    showToast('تم حفظ العميل بنجاح');
  } catch (error) {
    console.error('Failed to save main debt customer', error);
    showToast(error && error.message ? error.message : 'تعذر حفظ العميل', 'error');
  }
}

function renderDebtSection() {
  var searchInput = document.getElementById('mainDebtSearch');
  var list = document.getElementById('mainDebtCustomerList');
  var detail = document.getElementById('mainDebtCustomerDetail');
  var summary = document.getElementById('mainDebtSummary');
  var paidSummary = document.getElementById('mainDebtPaidSummary');
  if (!list || !detail || !summary) return;

  var query = searchInput ? String(searchInput.value || '').trim().toLowerCase() : '';
  var filtered = mainDebtCustomers.filter(function (customer) {
    if (!query) return true;
    return String(customer.name || '').toLowerCase().indexOf(query) !== -1 || String(customer.phone || '').toLowerCase().indexOf(query) !== -1;
  });

  var totalDue = filtered.reduce(function (sum, customer) {
    return sum + (Number(getMainDebtCustomerBalance(customer.id)) || 0);
  }, 0);
  var totalPaid = filtered.reduce(function (sum, customer) {
    var customerOperations = mainDebtOperations.filter(function (operation) {
      return String(operation.customerId || '') === String(customer.id) && String(operation.status || '').trim().toLowerCase() !== 'cancelled' && String(operation.status || '').trim().toLowerCase() !== 'deleted';
    });
    var customerPaid = customerOperations.filter(function (operation) {
      var type = String(operation.type || '').trim().toLowerCase();
      return type === 'payment' || type === 'settle';
    }).reduce(function (amountSum, operation) {
      return amountSum + (Number(operation.amount) || 0);
    }, 0);
    return sum + customerPaid;
  }, 0);
  summary.textContent = 'إجمالي المستحق: ' + formatMoney(totalDue);
  if (paidSummary) {
    paidSummary.textContent = 'إجمالي المسدد: ' + formatMoney(totalPaid);
  }

  if (!filtered.length) {
    list.innerHTML = '<div class="main-debt-detail-empty">لا يوجد عملاء مطابقون للبحث.</div>';
    detail.innerHTML = '<div class="main-debt-detail-empty">اختر عميلًا لعرض تفاصيله.</div>';
    return;
  }

  var selectedId = String(mainDebtSelectedCustomerId || '');
  if (selectedId && !filtered.some(function (customer) { return String(customer.id) === selectedId; })) {
    selectedId = '';
    mainDebtSelectedCustomerId = null;
  }

  list.innerHTML = filtered.map(function (customer) {
    var balance = getMainDebtCustomerBalance(customer.id);
    var isSelected = String(customer.id) === selectedId;
    return '<button type="button" class="main-debt-customer-item ' + (isSelected ? 'is-selected' : '') + '" data-main-debt-customer-id="' + escHtml(String(customer.id)) + '"><div class="main-debt-customer-head"><span class="main-debt-customer-name">' + escHtml(customer.name || 'عميل') + '</span><span class="main-debt-customer-balance ' + (balance > 0 ? '' : 'paid') + '">' + (balance > 0 ? 'مستحق' : 'مسدد') + ' ' + escHtml(formatDebtAmountText(balance)) + '</span></div><div class="main-debt-customer-phone">' + escHtml(customer.phone || 'بدون هاتف') + '</div></button>';
  }).join('');

  var activeCustomer = selectedId ? filtered.find(function (customer) { return String(customer.id) === selectedId; }) : null;
  if (!activeCustomer) {
    detail.innerHTML = '<div class="main-debt-detail-empty">اضغط على اسم العميل لعرض جدول العمليات.</div>';
    return;
  }

  var customerOperations = mainDebtOperations.filter(function (operation) {
    return String(operation.customerId || '') === String(activeCustomer.id) && String(operation.status || '').trim().toLowerCase() !== 'cancelled' && String(operation.status || '').trim().toLowerCase() !== 'deleted';
  }).sort(function (a, b) {
    return (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0);
  });

  var balance = getMainDebtCustomerBalance(activeCustomer.id);
  var totalDebt = customerOperations.filter(function (operation) { return String(operation.type || '').trim().toLowerCase() === 'debt'; }).reduce(function (sum, op) { return sum + (Number(op.amount) || 0); }, 0);
  var totalPayment = customerOperations.filter(function (operation) { return String(operation.type || '').trim().toLowerCase() === 'payment' || String(operation.type || '').trim().toLowerCase() === 'settle'; }).reduce(function (sum, op) { return sum + (Number(op.amount) || 0); }, 0);
  var lastDebt = customerOperations.filter(function (ope) { return String(ope.type || '').trim().toLowerCase() === 'debt'; }).sort(function (a, b) { return (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0); })[0];
  var lastPayment = customerOperations.filter(function (ope) { return String(ope.type || '').trim().toLowerCase() === 'payment' || String(ope.type || '').trim().toLowerCase() === 'settle'; }).sort(function (a, b) { return (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0); })[0];

  var operationsMarkup = customerOperations.length ? customerOperations.map(function (operation) {
    var type = String(operation.type || '').trim().toLowerCase();
    var label = type === 'debt' ? 'دين' : type === 'payment' ? 'سداد' : type === 'settle' ? 'تسوية' : type === 'return' ? 'إرجاع' : 'إجراء';
    var sign = type === 'debt' ? '+' : '-';
    var className = type === 'debt' ? 'debt' : type === 'payment' || type === 'settle' ? 'payment' : 'debt';
    var amount = Number(operation.amount) || 0;
    var amountText = sign + ' ' + formatMoney(amount);
    return '<div class="main-debt-operation-item ' + className + '"><div class="row1"><span>' + escHtml(label) + '</span><strong class="' + (type === 'debt' ? 'due' : 'paid') + '">' + escHtml(amountText) + '</strong></div><div class="row2">' + escHtml((operation.note || 'بدون ملاحظات')) + '<br>' + escHtml(formatDateString(operation.timestamp, true)) + '</div></div>';
  }).join('') : '<div class="main-debt-detail-empty">لا توجد عمليات لهذا العميل.</div>';

  detail.innerHTML = '<div class="main-debt-detail-card"><div class="main-debt-detail-header"><h3>' + escHtml(activeCustomer.name || 'عميل') + '</h3><span class="main-debt-customer-balance ' + (balance > 0 ? '' : 'paid') + '">' + (balance > 0 ? 'مستحق' : 'مسدد') + ' ' + escHtml(formatDebtAmountText(balance)) + '</span></div><div class="main-debt-detail-meta"><div class="mini-box"><span>الهاتف</span><strong>' + escHtml(activeCustomer.phone || 'غير محدد') + '</strong></div><div class="mini-box"><span>إجمالي الدين</span><strong class="due">' + escHtml(formatMoney(totalDebt)) + '</strong></div><div class="mini-box"><span>إجمالي السداد</span><strong class="paid">' + escHtml(formatMoney(totalPayment)) + '</strong></div><div class="mini-box"><span>آخر دين</span><strong>' + escHtml(lastDebt ? formatDateString(lastDebt.timestamp, false) : '-') + '</strong></div><div class="mini-box"><span>آخر سداد</span><strong>' + escHtml(lastPayment ? formatDateString(lastPayment.timestamp, false) : '-') + '</strong></div></div><div class="main-debt-action-buttons"><button type="button" class="main-debt-action-btn debt" data-main-debt-action="debt">إضافة دين</button><button type="button" class="main-debt-action-btn payment" data-main-debt-action="payment">سداد جزئي</button><button type="button" class="main-debt-action-btn settle" data-main-debt-action="settle">سداد كامل</button></div><div class="main-debt-operation-list">' + operationsMarkup + '</div></div>';
}

function openMainDebtActionModal(type, customerId) {
  var customer = mainDebtCustomers.find(function (entry) { return String(entry.id) === String(customerId); });
  if (!customer) return showToast('اختر عميلًا أولًا', 'error');
  var actionType = String(type || 'debt');
  var balance = getMainDebtCustomerBalance(customer.id);
  if ((actionType === 'payment' || actionType === 'settle') && balance <= 0) return showToast('لا يوجد رصيد مستحق لهذا العميل', 'error');
  document.getElementById('mainDebtActionCustomerId').value = customer.id;
  document.getElementById('mainDebtActionType').value = actionType;
  document.getElementById('mainDebtActionTitle').textContent = actionType === 'payment' ? 'سداد جزئي' : actionType === 'settle' ? 'سداد كامل' : 'إضافة دين';
  var amount = document.getElementById('mainDebtActionAmount');
  amount.value = actionType === 'settle' ? balance : '';
  amount.disabled = actionType === 'settle';
  amount.required = actionType !== 'settle';
  document.getElementById('mainDebtActionDate').value = new Date().toISOString().slice(0, 10);
  document.getElementById('mainDebtActionNote').value = actionType === 'settle' ? 'سداد كامل' : '';
  document.getElementById('mainDebtActionModal').classList.add('show');
}

async function saveMainDebtAction(event) {
  event.preventDefault();
  var customerId = document.getElementById('mainDebtActionCustomerId').value;
  var type = document.getElementById('mainDebtActionType').value;
  var customer = mainDebtCustomers.find(function (entry) { return String(entry.id) === String(customerId); });
  if (!customer) return showToast('العميل غير موجود', 'error');
  var amount = Number(document.getElementById('mainDebtActionAmount').value) || 0;
  var balance = getMainDebtCustomerBalance(customerId);
  if (type === 'settle') amount = balance;
  if (amount <= 0) return showToast('يرجى إدخال مبلغ صحيح', 'error');
  if ((type === 'payment' || type === 'settle') && amount > balance + 0.005) return showToast('مبلغ السداد أكبر من الرصيد المستحق', 'error');
  var operationId = 'debt_op_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  var operation = { id: operationId, customerId: customerId, customerName: customer.name, type: type, amount: amount, currency: 'primary', note: String(document.getElementById('mainDebtActionNote').value || '').trim(), dateKey: document.getElementById('mainDebtActionDate').value, timestamp: Date.now(), status: 'active', source: 'main-debt' };
  try {
    await db.collection('debtOperations').doc(operationId).set(operation);
    await loadMainDebtData();
    renderDebtSection();
    closeModalById('mainDebtActionModal');
    showToast(type === 'debt' ? 'تمت إضافة الدين' : type === 'settle' ? 'تم السداد الكامل' : 'تم تسجيل السداد');
  } catch (error) {
    showToast(error && error.message ? error.message : 'تعذر حفظ الحركة', 'error');
  }
}

var mainDebtActionForm = document.getElementById('mainDebtActionForm');
if (mainDebtActionForm) mainDebtActionForm.addEventListener('submit', saveMainDebtAction);

async function ensureDebtSectionLoaded() {
  if (!mainDebtCustomers.length && !mainDebtOperations.length) {
    await loadMainDebtData();
  }
  if (currentSection === 'debts') renderDebtSection();
}

function clearSearchInput() {
  var searchInput = document.getElementById('searchItemsInput');
  if (searchInput) searchInput.value = '';
}

function toggleLoading(show) {
  document.getElementById('loadingSpinner').classList.toggle('show', show);
}

function destroyAllCharts() {
  Object.values(allCharts).forEach(function(c) { try { c.destroy(); } catch (e) {} });
  allCharts = {};
}

function createChart(canvasId, config) {
  var canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  if (allCharts[canvasId]) { try { allCharts[canvasId].destroy(); } catch (e) {} }
  var ctx = canvas.getContext('2d');
  var chart = new Chart(ctx, config);
  allCharts[canvasId] = chart;
  return chart;
}

function getArabicChartDefaults() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    font: { family: 'Cairo, sans-serif' },
    plugins: {
      legend: {
        labels: {
          font: { family: 'Cairo, sans-serif', size: 12 },
          color: darkMode ? '#a0aec0' : '#4a5568',
          usePointStyle: true,
          padding: 16
        }
      },
      tooltip: {
        titleFont: { family: 'Cairo, sans-serif', size: 13 },
        bodyFont: { family: 'Cairo, sans-serif', size: 12 },
        rtl: true,
        textDirection: 'rtl'
      }
    },
    scales: {
      x: {
        ticks: { font: { family: 'Cairo, sans-serif', size: 10 }, color: darkMode ? '#a0aec0' : '#718096' },
        grid: { color: darkMode ? '#2d3548' : '#edf2f7' }
      },
      y: {
        ticks: {
          font: { family: 'Cairo, sans-serif', size: 10 },
          color: darkMode ? '#a0aec0' : '#718096',
          callback: function(v) { return formatMoney(v); }
        },
        grid: { color: darkMode ? '#2d3548' : '#edf2f7' }
      }
    }
  };
}

function getProductSalesSummaryMap() {
  var map = {};

  allItems.forEach(function(item) {
    var itemId = item && item.id != null ? String(item.id) : '';
    if (!itemId) return;
    map[itemId] = {
      itemId: itemId,
      name: item && item.name ? item.name : 'منتج ' + itemId,
      categoryName: item && item.categoryName ? item.categoryName : '',
      saleCount: 0,
      totalQty: 0,
      totalRevenue: 0,
      totalProfit: 0,
      lastSale: 0
    };
  });

  if (Array.isArray(productSalesSummaryCache) && productSalesSummaryCache.length) {
    productSalesSummaryCache.forEach(function(summary) {
      var itemId = summary && summary.itemId != null ? String(summary.itemId) : '';
      if (!itemId) return;
      if (!map[itemId]) {
        map[itemId] = {
          itemId: itemId,
          name: summary.itemName || 'منتج ' + itemId,
          categoryName: '',
          saleCount: 0,
          totalQty: 0,
          totalRevenue: 0,
          totalProfit: 0,
          lastSale: 0
        };
      }
      map[itemId].name = summary.itemName || map[itemId].name;
      map[itemId].saleCount = Number(summary.salesCount) || 0;
      map[itemId].totalQty = Number(summary.totalQuantity) || 0;
      map[itemId].totalRevenue = Number(summary.totalSales) || 0;
      map[itemId].totalProfit = Number(summary.totalProfit) || 0;
      map[itemId].lastSale = Number(summary.updatedAt) || 0;
    });
    return Object.values(map);
  }

  allSales.forEach(function(s) {
    var itemId = s && s.itemId != null ? String(s.itemId) : '';
    if (!itemId) return;
    if (!map[itemId]) {
      map[itemId] = {
        itemId: itemId,
        name: s.itemName || 'منتج ' + itemId,
        categoryName: '',
        saleCount: 0,
        totalQty: 0,
        totalRevenue: 0,
        totalProfit: 0,
        lastSale: 0
      };
    }
    map[itemId].saleCount += 1;
    map[itemId].totalQty += Number(s.quantity) || 0;
    map[itemId].totalRevenue += Number(s.totalAmount) || 0;
    map[itemId].totalProfit += Number(s.profit) || 0;
    if (Number(s.timestamp) > map[itemId].lastSale) map[itemId].lastSale = Number(s.timestamp) || 0;
  });

  return Object.values(map);
}

function getTopProducts(n) { n = n || 8;
  var map = getProductSalesSummaryMap();
  return map.sort(function(a, b) { return b.totalQty - a.totalQty; }).slice(0, n);
}

function getTopCategories(n) { n = n || 8;
  var map = {};
  allSales.forEach(function(s) { var item = allItems.find(function(i) { return i.id === s.itemId; }); var catName =
      item ? item.categoryName || 'بدون فئة' : 'بدون فئة'; if (!map[catName]) map[catName] = { name: catName,
        totalProfit: 0, totalRevenue: 0 };
    map[catName].totalProfit += s.profit || 0;
    map[catName].totalRevenue += s.totalAmount || 0; });
  return Object.values(map).sort(function(a, b) { return b.totalProfit - a.totalProfit; }).slice(0, n);
}

function getTopProfitProducts(n) { n = n || 8;
  var map = getProductSalesSummaryMap();
  return map.sort(function(a, b) { return b.totalProfit - a.totalProfit; }).slice(0, n);
}

function getDailyProfitData(days) { days = days || 30;
  var labels = [],
    profits = [],
    revenues = [];
  for (var i = days - 1; i >= 0; i--) { var d = new Date();
    d.setDate(d.getDate() - i); var ds = getStartOfDay(d),
      de = ds + 86400000; var daySales = allSales.filter(function(s) { return s.timestamp >= ds && s.timestamp <
        de; });
    labels.push(formatDateString(ds, false));
    profits.push(daySales.reduce(function(a, s) { return a + (s.profit || 0); }, 0));
    revenues.push(daySales.reduce(function(a, s) { return a + (s.totalAmount || 0); }, 0)); }
  return { labels: labels, profits: profits, revenues: revenues };
}

function getMonthlySalesData() {
  var map = {};
  allSales.forEach(function(s) { var mk = getMonthKey(s.timestamp); if (!map[mk]) map[mk] = { revenue: 0,
      profit: 0 };
    map[mk].revenue += s.totalAmount || 0;
    map[mk].profit += s.profit || 0; });
  var keys = Object.keys(map).sort(); if (keys.length > 12) keys = keys.slice(-12);
  return { labels: keys, revenues: keys.map(function(k) { return map[k].revenue; }), profits: keys.map(function(
      k) { return map[k].profit; }) };
}

function renderDashboard() {
  var now = Date.now();
  var ds = getStartOfDay(),
    ms = getStartOfMonth();
  var todaySummary = dashboardDailySalesSummary || (window.DailySalesSummary ? window.DailySalesSummary.getTodaySummary() : null) || {
    totalSales: 0,
    totalProfit: 0,
    salesCount: 0,
    totalQuantity: 0
  };
  var todayRevenue = Number(todaySummary.totalSales) || 0;
  var todayProfit = Number(todaySummary.totalProfit) || 0;
  var todayOrders = Number(todaySummary.salesCount) || 0;
  var todayQty = Number(todaySummary.totalQuantity) || 0;
  var avgInvoice = todayOrders > 0 ? todayRevenue / todayOrders : 0;
  var avgProfitPerSale = todayOrders > 0 ? todayProfit / todayOrders : 0;
  var profitMargin = todayRevenue > 0 ? (todayProfit / todayRevenue * 100) : 0;
  var allTimeExpenses = getExpensesSum();
  var allTimeProfitLoaded = window._cachedStats && window._cachedStats.allTimeProfitLoaded === true;
  var allTimeGrossProfit = allTimeProfitLoaded ? Number(window._cachedStats.allTimeProfit) : null;
  var allTimeNetProfit = allTimeGrossProfit === null ? null : allTimeGrossProfit - allTimeExpenses;
  var capitalSummary = XMetalCapitalSummary.getState();
  var totalCapital = capitalSummary.available ? capitalSummary.totalCapital : null;
  var availableItemCount = capitalSummary.available ? capitalSummary.totalCapitalItemCount : null;
  var firstSaleDate = allSales.length > 0 ? fmtDate(Math.min.apply(null, allSales.map(function(s) { return s
      .timestamp; }))) : '--';
  var topProduct = getTopProducts(1)[0];
  var topCategory = getTopCategories(1)[0];
  var topProfitProduct = getTopProfitProducts(1)[0];
  document.getElementById('dashboardStats').innerHTML =
    '<div class="stat-card"><div class="stat-icon" style="background:var(--gradient-1);"><i class="fas fa-dollar-sign"></i></div><div class="stat-label">إجمالي المبيعات اليوم</div><div class="stat-value">' +
    formatMoney(todayRevenue) + '</div><div class="stat-sub">' + todayOrders + ' طلب</div></div>' +
    '<div class="stat-card"><div class="stat-icon" style="background:var(--gradient-2);"><i class="fas fa-chart-line"></i></div><div class="stat-label">الأرباح اليوم</div><div class="stat-value">' +
    formatMoney(todayProfit) + '</div><div class="stat-trend up">نسبة الربح: ' + fmt(profitMargin) +
    '%</div></div>' +
    '<div class="stat-card"><div class="stat-icon" style="background:var(--gradient-3);"><i class="fas fa-shopping-cart"></i></div><div class="stat-label">عدد الطلبات</div><div class="stat-value">' +
    todayOrders + '</div><div class="stat-sub">' + todayQty + ' قطعة</div></div>' +
    '<div class="stat-card"><div class="stat-icon" style="background:var(--gradient-4);"><i class="fas fa-cubes"></i></div><div class="stat-label">متوسط الفاتورة</div><div class="stat-value">' +
    formatMoney(avgInvoice) + '</div><div class="stat-sub">متوسط الربح: ' + formatMoney(avgProfitPerSale) +
    '</div></div>' +
    '<div class="stat-card"><div class="stat-icon" style="background:var(--gradient-5);"><i class="fas fa-trophy"></i></div><div class="stat-label">أكثر منتج مبيعاً</div><div class="stat-value stat-name-small">' +
    (topProduct ? escHtml(topProduct.name) : '--') + '</div><div class="stat-sub">' + (topProduct ? topProduct
      .totalQty + ' قطعة' : '--') + '</div></div>' +
    '<div class="stat-card"><div class="stat-icon" style="background:var(--gradient-6);"><i class="fas fa-tags"></i></div><div class="stat-label">أكثر فئة مبيعاً</div><div class="stat-value stat-name-small">' +
    (topCategory ? escHtml(topCategory.name) : '--') + '</div><div class="stat-sub">' + (topCategory ?
      formatMoney(topCategory.totalProfit) : '--') + '</div></div>' +
    '<div class="stat-card"><div class="stat-icon" style="background:var(--gradient-1);"><i class="fas fa-star"></i></div><div class="stat-label">المنتج الأعلى ربحاً</div><div class="stat-value stat-name-small">' +
    (topProfitProduct ? escHtml(topProfitProduct.name) : '--') + '</div><div class="stat-sub">' + (
      topProfitProduct ? formatMoney(topProfitProduct.totalProfit) : '--') + '</div></div>' +
    '<div class="stat-card"><div class="stat-icon" style="background:var(--gradient-2);"><i class="fas fa-coins"></i></div><div class="stat-label">إجمالي الأرباح الكلية</div><div class="stat-value">' +
      (allTimeProfitLoaded ? formatMoney(allTimeGrossProfit) : '—') + '</div><div class="stat-sub">' + (allTimeProfitLoaded ? ('الصافي بعد المصاريف: ' + formatMoney(allTimeNetProfit)) : 'جارٍ تحميل الأرباح الكلية...') + '</div></div>' +
    '<div class="stat-card"><div class="stat-icon" style="background:var(--gradient-3);"><i class="fas fa-warehouse"></i></div><div class="stat-label">رأس المال</div><div class="stat-value">' +
    (totalCapital === null ? '—' : formatMoney(totalCapital)) + '</div><div class="stat-sub">' + (availableItemCount === null ? 'غير متاح' : availableItemCount + ' صنف') + '</div></div>';
}

function arabicAlphabeticalComparator(a, b) { return a.name.localeCompare(b.name, 'ar', { sensitivity: 'variant',
    usage: 'sort' }); }

function persistInventorySort(sortMode) {
  currentInventorySort = sortMode || 'alphabetical';
  if (window.appState && appState.setState) appState.setState('filters.inventorySort', currentInventorySort);
  try { localStorage.setItem('xmetalInventorySort', currentInventorySort); } catch (e) {}
}

function sortInventoryList(items, sortMode) {
  if (!items || !items.length) return [];
  if (window.PriceHelpers && window.PriceHelpers.sortInventoryProducts) {
    return window.PriceHelpers.sortInventoryProducts(items, sortMode || currentInventorySort || 'alphabetical');
  }
  return items.slice().sort(function(a, b) {
    var mode = sortMode || currentInventorySort || 'alphabetical';
    if (mode === 'purchase') {
      return (Number(b.purchasePrice) || 0) - (Number(a.purchasePrice) || 0) || arabicAlphabeticalComparator(a, b);
    }
    if (mode === 'sale') {
      return (Number(b.salePrice) || 0) - (Number(a.salePrice) || 0) || arabicAlphabeticalComparator(a, b);
    }
    if (mode === 'quantity') {
      return (Number(b.quantity) || 0) - (Number(a.quantity) || 0) || arabicAlphabeticalComparator(a, b);
    }
    return arabicAlphabeticalComparator(a, b);
  });
}

function compareInventoryItems(a, b, sortMode) {
  var mode = sortMode || currentInventorySort || 'alphabetical';
  if (mode === 'purchase') {
    return (Number(b.purchasePrice) || 0) - (Number(a.purchasePrice) || 0) || arabicAlphabeticalComparator(a, b);
  }
  if (mode === 'sale') {
    return (Number(b.salePrice) || 0) - (Number(a.salePrice) || 0) || arabicAlphabeticalComparator(a, b);
  }
  if (mode === 'quantity') {
    return (Number(b.quantity) || 0) - (Number(a.quantity) || 0) || arabicAlphabeticalComparator(a, b);
  }
  return arabicAlphabeticalComparator(a, b);
}

function filterAndSortProducts(term, stockFilter) {
  var filtered = [...allItems];
  var hasSearch = term && term.trim() !== "";
  var sortMode = currentInventorySort || 'alphabetical';
  if (hasSearch) {
    var searchTerm = term.trim();
    filtered = filtered.filter(function(p) { return p.name.includes(searchTerm); });
    filtered.forEach(function(p) {
      var priority = 3;
      if (p.name.startsWith(searchTerm)) priority = 1;
      else { var words = p.name.split(/\s+/); for (var wi = 0; wi < words.length; wi++) { if (
            words[wi].startsWith(searchTerm)) { priority = 2; break; } } }
      p._searchPriority = priority;
    });
  }
  if (stockFilter === 'available') filtered = filtered.filter(function(i) { return i.quantity > 0; });
  else if (stockFilter === 'outofstock') filtered = filtered.filter(function(i) { return i.quantity === 0; });
  if (hasSearch) {
    filtered.sort(function(a, b) {
      if (a._searchPriority !== b._searchPriority) return a._searchPriority - b._searchPriority;
      return compareInventoryItems(a, b, sortMode);
    });
    filtered.forEach(function(p) { delete p._searchPriority; });
  } else {
    filtered = sortInventoryList(filtered, sortMode);
  }
  return filtered;
}

function renderInventory() {
  var term = document.getElementById('searchItemsInput') ? document.getElementById('searchItemsInput').value : '';
  var filteredSorted = filterAndSortProducts(term, currentInventoryFilter);
  var html = '';
  if (!filteredSorted.length) { document.getElementById('itemsList').innerHTML =
      '<div class="empty-state"><i class="fas fa-box-open"></i><h3>لا توجد منتجات</h3></div>'; return; }
  filteredSorted.forEach(function(item, idx) {
    var profit = ((item.salePrice - item.purchasePrice) / item.purchasePrice * 100).toFixed(2);
    var profitClass = profit >= 0 ? 'profit-positive' : 'profit-negative';
    var mechanicPrice = window.PriceHelpers && window.PriceHelpers.getMechanicDisplayPrice ? window.PriceHelpers.getMechanicDisplayPrice(item) : (item.mechanicPrice != null && item.mechanicPrice !== '' ? item.mechanicPrice : item.salePrice);
    var pSec = fmtMoney(convertToSecondary(item.purchasePrice)),
      sSec = fmtMoney(convertToSecondary(item.salePrice)),
      mSec = fmtMoney(convertToSecondary(mechanicPrice));
    var showItemDetails = !!itemVisibility[item.id];
    var showMechanicDetails = showMechanicPricesGlobally;
    var cardClass = item.quantity === 0 ? 'out-of-stock' : (item.quantity <= 2 ? 'low-stock' : '');
    var itemCapital = getItemInventoryCapital(item);
    html += '<div class="product-card ' + cardClass + '" data-id="' + item.id +
      '"><div class="product-index-outer">' + (idx + 1) + '</div>' +
      '<div class="card-header"><div class="product-title"><span class="product-name">' + escHtml(item
        .name) + '</span>' + (item.categoryName ? '<span class="product-category-tag">' + escHtml(item
        .categoryName) + '</span>' : '') + (item.location ? '<span class="product-location-tag"><i class="fas fa-map-marker-alt"></i> ' + escHtml(item.location) + '</span>' : '') + '</div>' +
      '<div class="product-meta-wrapper"><div class="product-meta"><span><i class="fas fa-cubes"></i> ' +
      item.quantity + '</span><span style="color:var(--text3);font-size:0.75rem;margin:0 6px;">|</span><span class="' + (showItemDetails ? '' : 'blur-price') + '" style="font-size:0.8rem;color:var(--text2);">إجمالي التكلفة: ' + formatMoney(itemCapital) + '</span><span style="color:var(--text3);font-size:0.75rem;margin:0 6px;">|</span><span class="profit-badge-small ' + profitClass + ' ' + (showItemDetails ? '' :
        'blur-price') + '">' + profit + '%</span></div>' +
      '<button class="eye-icon" data-id="' + item.id + '"><i class="fas ' + (showItemDetails ? 'fa-eye' :
        'fa-eye-slash') + '"></i></button></div></div>' +
      '<div class="price-row"><div class="price-col purchase-price"><div class="price-label">شراء</div><div class="primary-price ' +
      (showItemDetails ? '' : 'blur-price') + '">$' + fmtMoney(item.purchasePrice) +
      '</div><div class="-price ' + (showItemDetails ? '' : 'blur-price') + '">' + pSec + ' ' + currencySettings
      .CurrencySymbol + '</div></div>' +
      '<div class="price-col mechanic-price"><div class="price-label">ميكانيكي</div><div class="primary-price ' +
      (showMechanicDetails ? '' : 'blur-price') + '">$' + fmtMoney(mechanicPrice) +
      '</div><div class="-price ' + (showMechanicDetails ? '' : 'blur-price') + '">' + mSec + ' ' + currencySettings
      .CurrencySymbol + '</div></div>' +
      '<div class="price-col sale-price"><div class="price-label">مبيع</div><div class="primary-price">$' +
      fmtMoney(item.salePrice) + '</div><div class="-price">' + sSec + ' ' + currencySettings
      .CurrencySymbol + '</div></div></div>' +
      '<div class="action-buttons"><button class="action-btn sell" data-id="' + item.id + '" ' + (item
        .quantity === 0 ? 'disabled' : '') +
      '><i class="fas fa-shopping-cart"></i> بيع</button><button class="action-btn edit" data-id="' + item
      .id + '"><i class="fas fa-edit"></i> تعديل</button><button class="action-btn delete" data-id="' +
      item.id + '"><i class="fas fa-trash-alt"></i> حذف</button></div></div>';
  });
  document.getElementById('itemsList').innerHTML = html;
  document.querySelectorAll('.sell').forEach(function(b) { b.addEventListener('click', function(e) {
      openSellModal(e.currentTarget.dataset.id); }); });
  document.querySelectorAll('.edit').forEach(function(b) { b.addEventListener('click', function(e) { editItem(e
        .currentTarget.dataset.id); }); });
  document.querySelectorAll('.delete').forEach(function(b) { b.addEventListener('click', function(e) { if (
        confirm('حذف المنتج؟')) performDelete(e.currentTarget.dataset.id); }); });
  document.querySelectorAll('.eye-icon').forEach(function(btn) { btn.addEventListener('click', function(e) { var
      id = btn.dataset.id;
    itemVisibility[id] = !itemVisibility[id];
    renderInventory(); }); });
}

async function performDelete(itemId) {
  var item = allItems.find(function(i) { return i.id === itemId; });
  if (!item) return;
  var itemRef = db.collection('items').doc(itemId);
  await db.runTransaction(function(tx) {
    return tx.get(itemRef).then(function(snapshot) {
      if (!snapshot.exists) return;
      var beforeItem = Object.assign({ id: snapshot.id }, snapshot.data());
      tx.delete(itemRef);
      XMetalCapitalSummary.applyDeltaInTransaction(tx, beforeItem, null);
    });
  });
  await logActivity('delete', 'item', itemId, 'حذف منتج: ' + item.name, { name: item.name });
  allItems = allItems.filter(function(i) { return i.id !== itemId; });
  if (isSearchActive) {
    currentSection = previousSection;
    isSearchActive = false;
    clearSearchInput();
    renderCurrentSection();
  } else {
    renderInventory();
  }
  showToast('تم الحذف');
}

function prepareAddItemForm() {
  currentItemId = null;
  isEditingItem = false;
  document.getElementById('itemForm').reset();
  var el;
  el = document.getElementById('itemLocation'); if (el) el.value = '';
  el = document.getElementById('productImageUrl'); if (el) el.value = '';
  // initialize purchase batches UI
  window.currentPurchaseBatches = [];
  var pbList = document.getElementById('purchaseBatchesList');
  if (pbList) pbList.innerHTML = '';
  var purchaseEl = document.getElementById('purchasePrice'); if (purchaseEl) purchaseEl.value = '';
  var mechanicEl = document.getElementById('mechanicPrice'); if (mechanicEl) mechanicEl.value = '';
  applySystemCurrencyDefaults();
  document.getElementById('addItemTitle').innerText = 'إضافة قطعة جديدة';
  updatePriceLabels();
  updateProductPriceDisplay();
  populateCategorySelect();
  document.getElementById('productCategoryId').value = '';
  updatePurchaseBatchesVisibility();
  try { computeBatchesSummary(); } catch (e) {}
}

function editItem(id) {
  var item = allItems.find(function(i) { return i.id === id; });
  if (!item) return;
  currentItemId = id;
  isEditingItem = true;
  document.getElementById('itemName').value = item.name;
  var locationEl = document.getElementById('itemLocation'); if (locationEl) locationEl.value = item.location || '';
  applySystemCurrencyDefaults();
  document.getElementById('purchasePrice').value = tempPurchaseMode ? fmtMoney(convertToSecondary(item.purchasePrice)) :
    fmtMoney(item.purchasePrice);
  document.getElementById('salePrice').value = tempSaleCurrency ? fmtMoney(convertToSecondary(item.salePrice)) : fmtMoney(item
    .salePrice);
  var mechanicValue = item.mechanicPrice != null && item.mechanicPrice !== '' ? item.mechanicPrice : '';
  document.getElementById('mechanicPrice').value = mechanicValue === '' ? '' : (tempMechanicMode ? fmtMoney(convertToSecondary(mechanicValue)) : fmtMoney(mechanicValue));
  document.getElementById('quantity').value = item.quantity;
  var el;
  el = document.getElementById('productImageUrl'); if (el) el.value = item.productImageUrl || '';
  document.getElementById('productCategoryId').value = item.categoryId || '';
  // load purchase batches if present, otherwise create a batch derived from existing purchasePrice & quantity
  window.currentPurchaseBatches = [];
  var pbList = document.getElementById('purchaseBatchesList');
  if (pbList) pbList.innerHTML = '';
  updatePurchaseBatchesVisibility();
  if (isPurchaseBatchesEnabled()) {
    if (item.purchaseBatches && Array.isArray(item.purchaseBatches) && item.purchaseBatches.length) {
      item.purchaseBatches.forEach(function(b) { addPurchaseBatchRow(b); });
    } else {
      if ((item.quantity || 0) > 0) addPurchaseBatchRow({ quantity: item.quantity || 0, unitCost: item.purchasePrice || 0, supplier: '', note: '' });
      else addPurchaseBatchRow({ quantity: 0, unitCost: item.purchasePrice || 0, supplier: '', note: '' });
    }
  }
  computeBatchesSummary();
  document.getElementById('addItemTitle').innerText = 'تعديل القطعة';
  updatePriceLabels();
  updateProductPriceDisplay();
  currentSection = 'addItem';
  document.querySelectorAll('.section-panel').forEach(function(p) { p.classList.remove('active'); });
  document.getElementById('section-addItem').classList.add('active');
}

// Purchase batches support (multiple purchase lines with qty, unit cost, supplier, note)
window.currentPurchaseBatches = [];
function addPurchaseBatchRow(batch) {
  if (!isPurchaseBatchesEnabled()) return;
  batch = batch || { quantity: 0, unitCost: 0, supplier: '', note: '' };
  var list = document.getElementById('purchaseBatchesList');
  if (!list) return;
  var row = document.createElement('div');
  row.className = 'purchase-batch-row';
  row.style.display = 'flex';
  row.style.gap = '8px';
  row.style.alignItems = 'center';
  row.innerHTML =
    '<input type="number" class="batch-qty" min="0" step="0.01" value="' + (Number(batch.quantity) || 0) + '" style="width:90px;padding:8px;border-radius:10px;border:1px solid var(--border);">' +
    '<input type="number" class="batch-unit" min="0" step="0.01" value="' + (Number(batch.unitCost) || 0) + '" style="width:110px;padding:8px;border-radius:10px;border:1px solid var(--border);">' +
    '<input type="text" class="batch-supplier" placeholder="المورد" value="' + escHtml(batch.supplier || '') + '" style="flex:1;padding:8px;border-radius:10px;border:1px solid var(--border);">' +
    '<input type="text" class="batch-note" placeholder="ملاحظة" value="' + escHtml(batch.note || '') + '" style="flex:1;padding:8px;border-radius:10px;border:1px solid var(--border);">' +
    '<button type="button" class="remove-batch" title="حذف" style="background:transparent;border:none;color:var(--danger);font-weight:700;">✖</button>';
  list.appendChild(row);

  var qtyEl = row.querySelector('.batch-qty');
  var unitEl = row.querySelector('.batch-unit');
  var supEl = row.querySelector('.batch-supplier');
  var noteEl = row.querySelector('.batch-note');
  var delBtn = row.querySelector('.remove-batch');

  function onChange() { computeBatchesSummary(); }
  qtyEl.addEventListener('input', onChange);
  unitEl.addEventListener('input', onChange);
  supEl.addEventListener('input', onChange);
  noteEl.addEventListener('input', onChange);
  delBtn.addEventListener('click', function() { row.remove(); computeBatchesSummary(); });
  computeBatchesSummary();
}

function getPurchaseBatchesFromUI() {
  if (!isPurchaseBatchesEnabled()) return [];
  var rows = document.querySelectorAll('#purchaseBatchesList .purchase-batch-row');
  var batches = [];
  rows.forEach(function(r) {
    var q = parseFloat(r.querySelector('.batch-qty').value) || 0;
    var u = parseFloat(r.querySelector('.batch-unit').value) || 0;
    var s = r.querySelector('.batch-supplier').value || '';
    var n = r.querySelector('.batch-note').value || '';
    if (q > 0 && u >= 0) batches.push({ quantity: q, unitCost: Number(u), supplier: s, note: n, timestamp: Date.now() });
  });
  return batches;
}

function computeBatchesSummary() {
  if (!isPurchaseBatchesEnabled()) {
    window.currentPurchaseBatches = [];
    var purchaseEl = document.getElementById('purchasePrice');
    if (purchaseEl) {
      purchaseEl.readOnly = false;
      purchaseEl.title = '';
    }
    var qtyEl = document.getElementById('quantity');
    if (qtyEl) {
      qtyEl.readOnly = false;
      qtyEl.title = '';
    }
    var totalQtyEl = document.getElementById('batchesTotalQty');
    if (totalQtyEl) totalQtyEl.innerText = '0';
    var totalCostEl = document.getElementById('batchesTotalCost');
    if (totalCostEl) totalCostEl.innerText = '0';
    return;
  }
  var rows = document.querySelectorAll('#purchaseBatchesList .purchase-batch-row');
  var totalQty = 0, totalCost = 0;
  rows.forEach(function(r) {
    var q = parseFloat(r.querySelector('.batch-qty').value) || 0;
    var uDisplay = parseFloat(r.querySelector('.batch-unit').value) || 0;
    // convert displayed unit to primary currency for internal calc if needed
    var uPrimary = tempPurchaseMode ? convertToPrimary(uDisplay) : uDisplay;
    if (q > 0 && uPrimary >= 0) {
      totalQty += q;
      totalCost += q * uPrimary;
    }
  });
  var avgPrimary = totalQty > 0 ? (totalCost / totalQty) : 0;
  // update UI values according to display currency (show in current purchase input currency)
  document.getElementById('batchesTotalQty').innerText = totalQty;
  var totalCostDisplayed = tempPurchaseMode ? convertToSecondary(totalCost) : totalCost;
  document.getElementById('batchesTotalCost').innerText = fmtMoney(totalCostDisplayed);
  var purchaseEl = document.getElementById('purchasePrice');
  if (purchaseEl) {
    // Only update the purchase input when batches actually define a non-zero average.
    if (totalQty > 0) {
      var avgDisplayed = tempPurchaseMode ? convertToSecondary(avgPrimary) : avgPrimary;
      purchaseEl.value = Number((avgDisplayed || 0).toFixed(2));
      purchaseEl.readOnly = true;
      purchaseEl.title = 'سعر الشراء محسوب تلقائياً من دفعات الشراء';
    } else {
      // Do not overwrite manual input when there are no batches.
      purchaseEl.readOnly = false;
      purchaseEl.title = '';
    }
  }
  // If batches define a total quantity, reflect it on the main quantity input
  var qtyEl = document.getElementById('quantity');
  if (qtyEl) {
    if (totalQty > 0) {
      qtyEl.value = totalQty;
      qtyEl.readOnly = true;
      qtyEl.title = 'تم تعيين الكمية تلقائياً من دفعات الشراء';
    } else {
      // preserve manual quantity when no batches exist
      qtyEl.readOnly = false;
      qtyEl.title = '';
    }
  }
  window.currentPurchaseBatches = getPurchaseBatchesFromUI();
}

document.getElementById('addPurchaseBatchBtn').addEventListener('click', function() { addPurchaseBatchRow({ quantity: 1, unitCost: 0, supplier: '', note: '' }); });

function populateCategorySelect() {
  var select = document.getElementById('productCategoryId');
  if (select) {
    select.innerHTML = '<option value="">-- بدون فئة --</option>';
    allCategories.forEach(function(c) { var opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      select.appendChild(opt); });
  }
  var assignSel = document.getElementById('assignCategorySelect');
  if (assignSel) {
    assignSel.innerHTML = '<option value="">-- اختر فئة --</option>';
    allCategories.forEach(function(c) { var opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      assignSel.appendChild(opt); });
  }
}

document.getElementById('itemForm').addEventListener('submit', async function(e) {
  e.preventDefault();
  // ensure batches summary and quantity are up-to-date before collecting values
  try { computeBatchesSummary(); } catch (err) {}
  var name = document.getElementById('itemName').value.trim();
  var itemLocation = document.getElementById('itemLocation') ? document.getElementById('itemLocation').value.trim() : '';
  // determine purchase price from purchase batches (weighted average) if any, otherwise fallback to single field
  var uiBatches = getPurchaseBatchesFromUI();
  var purchase = 0;
  var storedBatches = [];
  var qtyEl = document.getElementById('quantity');
  var purchaseEl = document.getElementById('purchasePrice');
  var qtyRaw = qtyEl ? parseInputNumber(qtyEl.value) : null;
  var purchaseRaw = purchaseEl ? parseInputNumber(purchaseEl.value) : null;
  var qty = null;
  if (uiBatches && uiBatches.length) {
    var tQ = 0, tC = 0;
    uiBatches.forEach(function(b) {
      var unit = Number(b.unitCost) || 0;
      // convert displayed currency to primary for storage if needed
      if (tempPurchaseMode) unit = convertToPrimary(unit);
      tQ += Number(b.quantity) || 0;
      tC += unit * (Number(b.quantity) || 0);
      storedBatches.push({ quantity: Number(b.quantity) || 0, unitCost: Number(unit), supplier: b.supplier || '', note: b.note || '', timestamp: b.timestamp || Date.now() });
    });
    purchase = tQ > 0 ? (tC / tQ) : 0;
    qty = tQ; // quantity must match batch totals to avoid inconsistency
    if (qtyEl) qtyEl.value = qty;
  } else {
    // Prefer manual inputs when provided. If absent and editing, preserve existing values.
    var existingItem = isEditingItem ? allItems.find(function(i) { return i.id === currentItemId; }) : null;
    if (qtyRaw !== null) {
      qty = qtyRaw;
    } else if (existingItem) {
      qty = existingItem.quantity || 0;
    } else {
      qty = 0;
    }

    if (purchaseRaw !== null) {
      purchase = tempPurchaseMode ? convertToPrimary(purchaseRaw) : purchaseRaw;
    } else if (existingItem) {
      purchase = existingItem.purchasePrice || 0;
    } else {
      purchase = 0;
    }
  }
  purchase = Number(purchase || 0);
  var rawSale = parseInputNumber(document.getElementById('salePrice').value);
  var sale = rawSale === null ? 0 : (tempSaleCurrency ? convertToPrimary(rawSale) : rawSale);
  var mechanicRaw = parseInputNumber(document.getElementById('mechanicPrice') ? document.getElementById('mechanicPrice').value : null);
  var mechanicPrice = mechanicRaw === null ? null : (tempMechanicMode ? convertToPrimary(mechanicRaw) : mechanicRaw);
  if (!name || purchase < 0 || sale < 0 || (mechanicPrice != null && mechanicPrice < 0) || qty < 0) return alert('بيانات غير صالحة');
  var catId = document.getElementById('productCategoryId').value;
  var cat = allCategories.find(function(c) { return c.id === catId; });
  var categoryName = cat ? cat.name : '';
  var productImageUrl = document.getElementById('productImageUrl') ? document.getElementById('productImageUrl').value : '';

  var extra = {
    location: itemLocation || null,
    productImageUrl: productImageUrl,
    purchaseBatches: storedBatches,
    mechanicPrice: mechanicPrice,
    categoryId: catId || null,
    categoryName: categoryName
  };
  if (isEditingItem) {
    var item = allItems.find(function(i) { return i.id === currentItemId; });
    if (!item) return;
    var previousItem = null;
    var updatedItem = Object.assign({}, item, { name: name, purchasePrice: purchase, salePrice: sale, quantity: qty, ...extra,
      updatedAt: Date.now() });
    var itemRef = db.collection('items').doc(item.id);
    await db.runTransaction(function(tx) {
      return tx.get(itemRef).then(function(snapshot) {
        if (!snapshot.exists) throw new Error('المنتج غير موجود');
        previousItem = Object.assign({ id: snapshot.id }, snapshot.data());
        updatedItem = Object.assign({}, previousItem, { name: name, purchasePrice: purchase, salePrice: sale, quantity: qty, ...extra,
          updatedAt: Date.now() });
        tx.set(itemRef, updatedItem);
        XMetalCapitalSummary.applyDeltaInTransaction(tx, previousItem, updatedItem);
      });
    });
    Object.assign(item, updatedItem);
    var diff = buildItemChangeDetails(previousItem, updatedItem);
    var details = 'تعديل منتج: ' + name + (diff.details ? ' - ' + diff.details : '');
    await logActivity('update', 'item', item.id, details, { changes: diff.metadata, before: diff.beforeSnapshot, after: diff.afterSnapshot });
    showToast('تم التعديل');
  } else {
    var newId = 'item_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    var newItem = { id: newId, name: name, purchasePrice: purchase, salePrice: sale, quantity: qty, ...extra,
      createdAt: Date.now(), updatedAt: Date.now() };
    await db.runTransaction(function(tx) {
      var itemRef = db.collection('items').doc(newId);
      tx.set(itemRef, newItem);
      XMetalCapitalSummary.applyDeltaInTransaction(tx, null, newItem);
      return Promise.resolve();
    });
    await logActivity('create', 'item', newId, 'إضافة منتج: ' + name + ' - ' + buildProductDetailsSummary(newItem), { product: newItem });
    commitItemUpdate(newItem);
    showToast('تمت الإضافة');
    prepareAddItemForm();
    if (document.getElementById('section-addItem').scrollTo) {
      document.getElementById('section-addItem').scrollTo({ top: 0, behavior: 'smooth' });
    }
    if (document.getElementById('contentArea').scrollTo) {
      document.getElementById('contentArea').scrollTo({ top: 0, behavior: 'smooth' });
    }
    document.getElementById('itemName').focus();
    currentSection = 'addItem';
    document.getElementById('section-addItem').classList.add('active');
  }
  if (isEditingItem) {
    currentSection = 'inventory';
    renderCurrentSection();
  }
});

function openSellModal(itemId) {
  var item = allItems.find(function(i) { return i.id === itemId; });
  if (!item) {
    // attempt to fetch item from DB when not cached
    db.collection('items').doc(itemId).get().then(function(d) {
      if (!d.exists) return alert('المنتج غير موجود');
      item = { id: d.id, ...d.data() };
      // continue with UI population
      document.getElementById('sellProductName').innerText = item.name;
      document.getElementById('sellQuantity').value = 1;
      document.getElementById('sellQuantity').max = item.quantity;
      tempSellMode = getSystemCurrency() === '';
      document.getElementById('sellPriceRow').classList.remove('swapped');
      document.getElementById('sellPriceLabel').innerHTML = 'السعر للقطعة (' + (tempSellMode ? currencySettings.CurrencySymbol : '$') + ')';
      document.getElementById('sellPrice').value = tempSellMode ? fmtMoney(convertToSecondary(item.salePrice)) : fmtMoney(item.salePrice);
      updateSellPriceDisplay();
      document.getElementById('sellForm').dataset.itemId = itemId;
      document.getElementById('sellModal').classList.add('show');
    }).catch(function() { return alert('تعذر جلب بيانات المنتج'); });
    return;
  }
  document.getElementById('sellProductName').innerText = item.name;
  document.getElementById('sellQuantity').value = 1;
  document.getElementById('sellQuantity').max = item.quantity;
  tempSellMode = getSystemCurrency() === '';
  document.getElementById('sellPriceRow').classList.remove('swapped');
  document.getElementById('sellPriceLabel').innerHTML = 'السعر للقطعة (' + (tempSellMode ? currencySettings
    .CurrencySymbol : '$') + ')';
  document.getElementById('sellPrice').value = tempSellMode ? fmtMoney(convertToSecondary(item.salePrice)) : fmtMoney(item
    .salePrice);
  updateSellPriceDisplay();
  document.getElementById('sellForm').dataset.itemId = itemId;
  document.getElementById('sellModal').classList.add('show');
}

document.getElementById('sellForm').addEventListener('submit', async function(e) {
  e.preventDefault();
  var itemId = document.getElementById('sellForm').dataset.itemId;
  var item = allItems.find(function(i) { return i.id === itemId; });
  if (!item || item.id === undefined || item.id === null || String(item.id).trim() === '') return alert('المنتج غير جاهز للبيع');
  var qty = parseInputNumber(document.getElementById('sellQuantity').value);
  if (qty === null || qty <= 0 || qty > item.quantity) return alert('كمية غير صالحة');
  var rawPrice = parseInputNumber(document.getElementById('sellPrice').value);
  if (rawPrice === null) return alert('السعر غير صالح');
  var price = tempSellMode ? convertToPrimary(rawPrice) : rawPrice;
  var currency = tempSellMode ? '' : 'primary';
  var allocations = null;
  var purchasePriceAtTime = item.purchasePrice;
  var submitBtn = document.querySelector('#sellForm button[type="submit"]');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.dataset._origText = submitBtn.innerText; submitBtn.innerText = 'جارٍ...'; }
  try {
    // if item has purchaseBatches, compute allocations and apply them atomically
    if (item.purchaseBatches && Array.isArray(item.purchaseBatches) && item.purchaseBatches.length) {
      allocations = computeBatchAllocations(item, qty);
      if (!allocations || allocations.length === 0) return alert('كمية غير متوفرة في دفعات الشراء');
      // compute average purchase price before consuming batches
      var avgPurchasePrice = computeAveragePurchasePrice(item);
      var res = await applyBatchAllocationsTransaction(item.id, allocations);
      item.purchaseBatches = res.purchaseBatches;
      item.quantity = res.quantity;
      purchasePriceAtTime = avgPurchasePrice;
    } else {
      // fallback to simple quantity transaction
      var newQty = await updateItemQuantityTransaction(item.id, -qty);
      item.quantity = newQty;
    }
  } catch (err) {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = submitBtn.dataset._origText || 'تأكيد'; delete submitBtn.dataset._origText; }
    return alert('فشل البيع: ' + (err && err.message ? err.message : 'خطأ'));
  }
  var saleObj = buildSaleObject(item, qty, price, currency, purchasePriceAtTime);
  saleObj.saleId = saleObj.saleId || makeStableSaleId();
  saleObj.saleRevision = 1;
  if (allocations) saleObj.purchaseBatchAllocations = allocations;
  try {
    await db.runTransaction(function (tx) {
      var saleRef = db.collection('sales').doc(saleObj.saleId);
      return window.DailySalesSummary.applySaleMutationInTransaction(tx, null, saleObj, 'create').then(function () {
        tx.set(saleRef, saleObj);
      });
    });
    if (window.ProductSalesSummary && window.ProductSalesSummary.applySaleCreate) {
      await window.ProductSalesSummary.applySaleCreate(saleObj);
    }
    if (window.MonthlySalesSummary && window.MonthlySalesSummary.applySaleCreate) {
      try {
        await window.MonthlySalesSummary.applySaleCreate(saleObj);
      } catch (summaryErr) {
        console.warn('MonthlySalesSummary sale create update failed', summaryErr);
      }
    }
    commitItemUpdate(item);
    if (currentSection === 'addItem' && currentItemId === item.id) {
      var qtyInput = document.getElementById('quantity');
      if (qtyInput) qtyInput.value = item.quantity;
      try { computeBatchesSummary(); } catch (e) {}
    }
    addSaleLocally(saleObj);
    await logActivity('sell', 'sale', saleObj.saleId, 'بيع منتج: ' + item.name + '، الكمية: ' + qty + '، الربح: ' + fmt(saleObj.profit), { itemId: item.id, itemName: item.name, quantity: qty, profit: saleObj.profit });
    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = submitBtn.dataset._origText || 'تأكيد'; delete submitBtn.dataset._origText; }
    closeModalById('sellModal');
    showToast('تم البيع بنجاح');
    if (document.getElementById('itemsList')) renderInventory();
    if (currentSection === 'dashboard') renderDashboard();
  } catch (err) {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = submitBtn.dataset._origText || 'تأكيد'; delete submitBtn.dataset._origText; }
    // Offline write failed: keep the sale stable in the local queue and live list.
    saleObj.pending = 'pending';
    saleObj.syncStatus = 'pending';
    enqueueSaleOperation('create', saleObj);
    addSaleLocally(saleObj);
    commitItemUpdate(item);
    showToast('تم حفظ البيع محليًا وسيتم مزامنته عند عودة الإنترنت');
    closeModalById('sellModal');
    if (document.getElementById('itemsList')) renderInventory();
    if (currentSection === 'dashboard') renderDashboard();
    console.warn('Offline sale persisted to local queue:', err);
  }
});

var switchPurchaseCurrencyBtn = document.getElementById('switchPurchaseCurrency');
if (switchPurchaseCurrencyBtn) {
  switchPurchaseCurrencyBtn.addEventListener('click', function() {
    var inputEl = document.getElementById('purchasePrice');
    if (!inputEl) return;
    var v = parseInputNumber(inputEl.value);
    v = v === null ? 0 : v;
    var batchUnits = document.querySelectorAll('.batch-unit');
    batchUnits.forEach(function(b) {
      var val = parseFloat(b.value) || 0;
      b.value = fmtMoney(val);
    });
    inputEl.value = fmtMoney(v);
    updatePriceLabels();
    updateProductPriceDisplay();
    computeBatchesSummary();
  });
}
var managedEmployeeWageCurrencyBtn = document.getElementById('switchManagedEmployeeWageCurrency');
if (managedEmployeeWageCurrencyBtn) {
  managedEmployeeWageCurrencyBtn.addEventListener('click', function() {
    var inputEl = document.getElementById('managedEmployeeWage');
    var currencyInput = document.getElementById('managedEmployeeWageCurrency');
    if (!inputEl || !currencyInput) return;
    var v = parseInputNumber(inputEl.value);
    v = v === null ? 0 : v;
    var nextCurrency = currencyInput.value === '' ? 'primary' : '';
    currencyInput.value = nextCurrency;
    inputEl.value = nextCurrency === '' ? fmtMoney(convertToSecondary(v)) : fmtMoney(convertToPrimary(v));
    updateManagedEmployeeWageDisplay();
  });
}
var switchSaleCurrencyBtn = document.getElementById('switchSaleCurrency');
if (switchSaleCurrencyBtn) {
  switchSaleCurrencyBtn.addEventListener('click', function() {
    var inputEl = document.getElementById('salePrice');
    if (!inputEl) return;
    var v = parseInputNumber(inputEl.value);
    v = v === null ? 0 : v;
    inputEl.value = fmtMoney(v);
    updatePriceLabels();
    updateProductPriceDisplay();
  });
}
var switchMechanicCurrencyBtn = document.getElementById('switchMechanicCurrency');
if (switchMechanicCurrencyBtn) {
  switchMechanicCurrencyBtn.addEventListener('click', function() {
    var inputEl = document.getElementById('mechanicPrice');
    if (!inputEl) return;
    var v = parseInputNumber(inputEl.value);
    v = v === null ? 0 : v;
    inputEl.value = fmtMoney(v);
    updatePriceLabels();
    updateProductPriceDisplay();
  });
}
var switchSellCurrencyBtn = document.getElementById('switchSellCurrency');
if (switchSellCurrencyBtn) {
  switchSellCurrencyBtn.addEventListener('click', function() {
    var inputEl = document.getElementById('sellPrice');
    if (!inputEl) return;
    var v = parseInputNumber(inputEl.value);
    v = v === null ? 0 : v;
    tempSellMode = !tempSellMode;
    inputEl.value = tempSellMode ? fmtMoney(convertToSecondary(v)) : fmtMoney(convertToPrimary(v));
    var sellLabel = document.getElementById('sellPriceLabel');
    if (sellLabel) sellLabel.innerHTML = 'السعر للقطعة (' + (tempSellMode ? currencySettings.CurrencySymbol : '$') + ')';
    updateSellPriceDisplay();
  });
}
var switchEditCurrencyBtn = document.getElementById('switchEditCurrency');
if (switchEditCurrencyBtn) {
  switchEditCurrencyBtn.addEventListener('click', function() {
    var inputEl = document.getElementById('editPrice');
    if (!inputEl) return;
    var v = parseInputNumber(inputEl.value);
    v = v === null ? 0 : v;
    tempEditMode = !tempEditMode;
    inputEl.value = tempEditMode ? fmtMoney(convertToSecondary(v)) : fmtMoney(convertToPrimary(v));
    var editLabel = document.getElementById('editPriceLabel');
    if (editLabel) editLabel.innerHTML = 'السعر (' + (tempEditMode ? currencySettings.CurrencySymbol : '$') + ')';
    updateEditSalePriceDisplay();
  });
}
var purchasePriceInput = document.getElementById('purchasePrice');
if (purchasePriceInput) purchasePriceInput.addEventListener('input', updateProductPriceDisplay);
var salePriceInput = document.getElementById('salePrice');
if (salePriceInput) salePriceInput.addEventListener('input', updateProductPriceDisplay);
var mechanicPriceInput = document.getElementById('mechanicPrice');
if (mechanicPriceInput) mechanicPriceInput.addEventListener('input', updateProductPriceDisplay);
document.addEventListener('input', function(event) {
  if (!event || !event.target || !event.target.id) return;
  if (event.target.id === 'purchasePrice' || event.target.id === 'salePrice' || event.target.id === 'mechanicPrice') {
    refreshPriceProfitLabels();
  }
});
var sellPriceInput = document.getElementById('sellPrice');
if (sellPriceInput) sellPriceInput.addEventListener('input', updateSellPriceDisplay);
var sellQtyEl = document.getElementById('sellQuantity');
if (sellQtyEl) sellQtyEl.addEventListener('input', updateSellPriceDisplay);
setupSellQuantityPresets();
var editPriceInput = document.getElementById('editPrice');
if (editPriceInput) editPriceInput.addEventListener('input', updateEditSalePriceDisplay);
function setupSellQuantityPresets() {
  var buttons = document.querySelectorAll('.sell-quantity-preset');
  buttons.forEach(function(button) {
    button.addEventListener('click', function() {
      var qty = parseFloat(button.dataset.qty);
      var input = document.getElementById('sellQuantity');
      if (!input || isNaN(qty)) return;
      input.value = qty;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  });
}

document.getElementById('cancelItemBtn').addEventListener('click', function() { 
  currentSection = isSearchActive ? previousSection : 'inventory';
  isSearchActive = false;
  clearSearchInput();
  renderCurrentSection(); 
});
document.getElementById('searchItemsInput').addEventListener('input', function() {
  var searchValue = this.value.trim();
  if (searchValue.length > 0) {
    if (!isSearchActive) {
      previousSection = currentSection;
      isSearchActive = true;
    }
    currentSection = 'inventory';
  } else {
    isSearchActive = false;
    if (currentSection === 'inventory') {
      currentSection = previousSection;
    }
  }
  renderCurrentSection();
});
var inventorySortSelect = document.getElementById('inventorySortSelect');
if (inventorySortSelect) {
  inventorySortSelect.value = currentInventorySort || 'alphabetical';
  inventorySortSelect.addEventListener('change', function() {
    persistInventorySort(this.value);
    renderInventory();
  });
}
var globalMechanicToggleBtn = document.getElementById('toggleAllMechanicPricesBtn');
if (globalMechanicToggleBtn) {
  globalMechanicToggleBtn.addEventListener('click', function() {
    showMechanicPricesGlobally = !showMechanicPricesGlobally;
    updateInventoryGlobalEyeButton();
    renderInventory();
  });
}
updateInventoryGlobalEyeButton();
document.querySelectorAll('#inventoryFilterBar .filter-btn').forEach(function(btn) {
  btn.addEventListener('click', function() {
    document.querySelectorAll('#inventoryFilterBar .filter-btn').forEach(function(b) { b.classList
        .remove('active'); });
    btn.classList.add('active');
    currentInventoryFilter = btn.dataset.filter;
    renderInventory();
  });
});
var inventoryItemsList = document.getElementById('itemsList');
var inventoryScrollTopBtn = document.getElementById('inventoryScrollTopBtn');
if (inventoryItemsList && inventoryScrollTopBtn) {
  inventoryItemsList.addEventListener('scroll', function() {
    inventoryScrollTopBtn.classList.toggle('show', inventoryItemsList.scrollTop > 180);
  });
  inventoryScrollTopBtn.addEventListener('click', function() {
    inventoryItemsList.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

async function reloadSalesLog() {
  // Reset cache to initial state
  salesQueryCache = { lastDoc: null, hasMore: true, currentPageItems: [], pageEndsWithIncompleteDay: false };
  // Fetch fresh data from Firebase
  await fetchSalesPage();
  // Render the updated table
  renderSalesTable();
}

async function fetchSalesPage() {
  if (salesQueryCache.loading || !salesQueryCache.hasMore) return;
  salesQueryCache.loading = true;
  updateSalesLoadMoreButton();

  var query = db.collection('sales').orderBy('timestamp', 'desc').limit(salesPageSize + 1);
  if (salesQueryCache.lastDoc) query = query.startAfter(salesQueryCache.lastDoc);
  try {
    var snap = await query.get();
    var rawItems = snap.docs.map(function(d) { return { saleId: d.id, ...d.data() }; });
    var nextCursor = null;
    var pageEndsWithIncompleteDay = false;
    if (rawItems.length > salesPageSize) {
      nextCursor = snap.docs[salesPageSize - 1];
      var peekItem = rawItems[salesPageSize];
      rawItems = rawItems.slice(0, salesPageSize);
      if (rawItems.length && peekItem) {
        pageEndsWithIncompleteDay = getDayKey(rawItems[rawItems.length - 1].timestamp) === getDayKey(peekItem.timestamp);
      }
    }
    salesQueryCache.currentPageItems = (salesQueryCache.currentPageItems || []).concat(rawItems);
    salesQueryCache.lastDoc = nextCursor;
    salesQueryCache.hasMore = !!nextCursor;
    salesQueryCache.pageEndsWithIncompleteDay = pageEndsWithIncompleteDay;
  } catch (e) {
    salesQueryCache.hasMore = false;
    showFirestoreError(e, 'تعذّر تحميل سجلات المبيعات');
  } finally {
    salesQueryCache.loading = false;
    updateSalesLoadMoreButton();
  }
}

function renderSalesLog() {
  if (!salesQueryCache.currentPageItems.length) {
    renderSalesTable();
    fetchSalesPage().then(renderSalesTable);
  } else {
    renderSalesTable();
  }
}

function renderSalesTable() {
  var currentCount = (salesQueryCache.currentPageItems || []).length;
  var statusLabel = 'لا توجد عمليات';
  if (currentCount > 0) statusLabel = 'عرض ' + currentCount + ' من السجلات';
  else if (salesQueryCache.loading) statusLabel = 'جاري تحميل السجلات...';
  document.getElementById('salesCountLabel').textContent = statusLabel;
  var tbody = document.getElementById('salesLogBody');
  tbody.innerHTML = buildSalesRowsHtml(salesQueryCache.currentPageItems || []);
  renderSalesLoadMore();
}

function getSalePaymentLabel(sale) {
  return String(sale && sale.paymentMethod || '').toLowerCase() === 'credit' || sale && sale.isCreditSale ? 'آجل' : 'كاش';
}

function getSaleNotes(sale, isActive) {
  var status = String(sale && sale.status || '').toLowerCase();
  var paymentLabel = getSalePaymentLabel(sale);
  var statusLabel = '';
  if (!isActive) {
    statusLabel = status === 'returned' || sale && sale.returned ? 'مرتجعة' : status === 'refunded' ? 'مستردة' : 'ملغاة';
  } else if (Number(sale && sale.saleRevision) > 1) {
    statusLabel = 'معدلة';
  }
  return statusLabel ? statusLabel + ' • ' + paymentLabel + (!isActive ? ' • غير محتسبة' : '') : paymentLabel;
}

function buildSalesRowsHtml(items) {
  if (!items.length) {
    return '<tr><td colspan="10" style="padding:30px;color:var(--text3);">لا توجد عمليات</td></tr>';
  }
  var html = '';
  var daySummaries = {};
  items.forEach(function(s) {
    var dayKey = getDayKey(s.timestamp);
    if (!daySummaries[dayKey]) {
      daySummaries[dayKey] = { totalAmount: 0, costTotal: 0, profitTotal: 0 };
    }
    if (!window.DailySalesSummary.isSaleActive(s)) return;
    var cost = (s.purchasePriceAtTime || 0) * (s.quantity || 0);
    daySummaries[dayKey].totalAmount += s.totalAmount || 0;
    daySummaries[dayKey].costTotal += cost;
    daySummaries[dayKey].profitTotal += s.profit || 0;
  });

  var lastDayKey = null;
  var rowIndex = 0;
  items.forEach(function(s, i) {
    var dayKey = getDayKey(s.timestamp);
    if (dayKey !== lastDayKey) {
      html += getDateSeparatorRowHtml(s.timestamp, daySummaries[dayKey].totalAmount, daySummaries[dayKey].costTotal, daySummaries[dayKey].profitTotal, 10);
      html += getSalesColumnHeaderRowHtml();
      lastDayKey = dayKey;
    }
    var cost = (s.purchasePriceAtTime || 0) * (s.quantity || 0);
    var profitPct = cost > 0 ? ((s.profit || 0) / cost * 100) : 0;
    var isActive = window.DailySalesSummary.isSaleActive(s);
    html += '<tr class="' + (isActive ? '' : 'sale-inactive') + '" onclick="viewSaleDetail(\'' + s.saleId + '\')" style="cursor:pointer;" title="عرض تفاصيل العملية">' +
      '<td>' + (++rowIndex) + '</td><td>' + fmtDateTime(s.timestamp) + '</td><td>' +
      escHtml(s.itemName || '--') + '</td><td>' + (s.quantity || 0) + '</td><td>' +
      formatSaleUnitMoney(s) + '</td><td>' + formatSaleMoney(s, s.totalAmount || 0) +
      '</td><td>' + formatMoney(cost) +
      '</td><td class="' + ((s.profit || 0) >= 0 ? 'profit-positive' : 'profit-negative') + '">' + formatMoney(s.profit || 0) +
      '</td><td><span class="badge ' + (profitPct >= 20 ? 'badge-success' : profitPct >= 0 ?
        'badge-warning' : 'badge-danger') + '">' + fmt(profitPct) +
      '%</span></td><td>' + escHtml(getSaleNotes(s, isActive)) + '</td></tr>';
  });
  return html;
}

function getSalesColumnHeaderRowHtml() {
  return '<tr class="sales-column-header"><th>#</th><th>التاريخ</th><th>المنتج</th><th>الكمية</th><th>سعر الوحدة</th><th>الإجمالي</th><th>التكلفة</th><th>الربح</th><th>نسبة الربح</th><th>الملاحظات</th></tr>';
}

function getDailyTotalsRowHtml(totalAmount, costTotal, profitTotal, colspan) {
  return '<tr style="background:var(--surface);font-weight:800;border-top:1px solid var(--border);border-bottom:1px solid var(--border);">' +
    '<td colspan="10" style="padding:12px 10px;text-align:center;color:var(--text);">' +
    'إجمالي المبيعات ' + formatMoney(totalAmount) + ' | ' +
    'إجمالي التكاليف ' + formatMoney(costTotal) + ' | ' +
    'إجمالي الربح ' + formatMoney(profitTotal) +
    '</td></tr>';
}

function getDateSeparatorRowHtml(ts, totalAmount, costTotal, profitTotal, colspan) {
  var dayLabel = escHtml(formatDateSeparatorLabel(ts));
  var totalsLabel = 'إجمالي المبيعات ' + formatMoney(totalAmount) + ' | ' +
    'إجمالي التكاليف ' + formatMoney(costTotal) + ' | ' +
    'إجمالي الربح ' + formatMoney(profitTotal);
  return '<tr style="background:var(--surface);font-weight:800;border-top:1px solid var(--border);border-bottom:1px solid var(--border);">' +
    '<td style="padding:14px 8px;color:var(--text3);text-align:center;">&nbsp;</td>' +
    '<td style="padding:14px 8px;color:var(--text3);text-align:center;white-space:nowrap;direction:rtl;">' + dayLabel + '</td>' +
    '<td colspan="' + (colspan - 2) + '" style="padding:14px 8px;color:var(--text);text-align:center;white-space:normal;direction:rtl;">' + totalsLabel + '</td>' +
    '</tr>';
}

function renderSalesLoadMore() {
  var row = document.getElementById('salesLoadMoreRow');
  if (!row) return;
  if (!salesQueryCache.hasMore && (salesQueryCache.currentPageItems || []).length > 0) {
    row.style.display = 'none';
    return;
  }
  row.style.display = 'flex';
  updateSalesLoadMoreButton();
}

function updateSalesLoadMoreButton() {
  var btn = document.getElementById('salesLoadMoreBtn');
  var info = document.getElementById('salesLoadMoreInfo');
  if (!btn || !info) return;
  btn.disabled = !!salesQueryCache.loading || !salesQueryCache.hasMore;
  btn.textContent = salesQueryCache.loading ? 'جاري التحميل...' : 'تحميل المزيد';
  info.textContent = salesQueryCache.hasMore ? '' : ((salesQueryCache.currentPageItems || []).length ? 'تم تحميل جميع السجلات.' : 'لا توجد سجلات إضافية.');
}

function loadMoreSales() {
  if (salesQueryCache.loading || !salesQueryCache.hasMore) return;
  fetchSalesPage().then(renderSalesTable);
}

function renderSalesPagination() {
  if (!salesQueryCache.currentPageItems.length && !salesQueryCache.hasMore) {
    document.getElementById('salesPagination').innerHTML = '';
    return;
  }
  var html = '';
  html += '<button ' + (salesPage === 0 ? 'disabled' : '') + ' onclick="goToSalesPage(' + (salesPage - 1) + ')">السابق</button>';
  html += '<button class="active">صفحة ' + (salesPage + 1) + '</button>';
  html += '<button ' + (!salesQueryCache.hasMore ? 'disabled' : '') + ' onclick="goToSalesPage(' + (salesPage + 1) + ')">التالي</button>';
  document.getElementById('salesPagination').innerHTML = html;
}

function goToSalesPage(p) { salesPage = Math.max(0, p);
  renderSalesLog(); }

function renderSalesFilterRow() {
  var sp = salesFilterParams;
  var catOpts = '<option value="">كل الفئات</option>' + allCategories.map(function(c) { return '<option value="' + c.id + '" ' + (sp.categoryId === c.id ? 'selected' : '') + '>' + escHtml(c.name) + '</option>'; })
    .join('');
  var prodOpts = '<option value="">كل المنتجات</option>' + allItems.map(function(i) { return '<option value="' + i
      .id + '" ' + (sp.productId === i.id ? 'selected' : '') + '>' + escHtml(i.name) + '</option>'; })
    .join('');
  document.getElementById('salesFilterRow').innerHTML =
    '<select id="sfPeriod" onchange="updateSalesFilter(\'period\',this.value)"><option value="all" ' + (sp
      .period === 'all' ? 'selected' : '') + '>كل الفترات</option><option value="today" ' + (sp.period ===
      'today' ? 'selected' : '') + '>اليوم</option><option value="week" ' + (sp.period === 'week' ?
      'selected' : '') + '>الأسبوع</option><option value="month" ' + (sp.period === 'month' ? 'selected' : '') + '>الشهر</option><option value="year" ' + (sp.period === 'year' ? 'selected' : '') +
      '>السنة</option><option value="7days" ' + (sp.period === '7days' ? 'selected' : '') +
      '>آخر 7 أيام</option><option value="30days" ' + (sp.period === '30days' ? 'selected' : '') +
      '>آخر 30 يوم</option><option value="90days" ' + (sp.period === '90days' ? 'selected' : '') +
      '>آخر 90 يوم</option><option value="custom" ' + (sp.period === 'custom' ? 'selected' : '') +
      '>مخصص</option></select>' + (sp.period === 'custom' ? '<input type="text" class="date-input" readonly id="sfCustomStart" placeholder="YYYY-MM-DD" value="' + (sp
        .customStart ? new Date(sp.customStart).toISOString().split('T')[0] : '') +
      '" onchange="updateSalesFilter(\'customStart\',parseDateString(this.value,false))"><span>إلى</span><input type="text" class="date-input" readonly id="sfCustomEnd" placeholder="YYYY-MM-DD" value="' +
      (sp.customEnd ? new Date(sp.customEnd).toISOString().split('T')[0] : '') +
      '" onchange="updateSalesFilter(\'customEnd\',parseDateString(this.value,true))">' :
        '') +
    '<input type="text" id="sfSearch" placeholder="🔍 بحث باسم المنتج" value="' + escHtml(sp.searchTerm) +
    '" oninput="debouncedSearchUpdate(this.value)" style="max-width:200px;">' +
    '<select id="sfProduct" onchange="updateSalesFilter(\'productId\',this.value)">' + prodOpts +
    '</select>' +
    '<select id="sfCategory" onchange="updateSalesFilter(\'categoryId\',this.value)">' + catOpts +
    '</select>' +
    '<input type="number" id="sfMinQty" placeholder="أقل كمية" value="' + sp.minQty +
    '" step="0.01" onchange="updateSalesFilter(\'minQty\',this.value)" style="max-width:100px;">' +
    '<input type="number" id="sfMaxQty" placeholder="أعلى كمية" value="' + sp.maxQty +
    '" step="0.01" onchange="updateSalesFilter(\'maxQty\',this.value)" style="max-width:100px;">' +
    '<input type="number" id="sfMinProfit" placeholder="أقل ربح" value="' + sp.minProfit +
    '" onchange="updateSalesFilter(\'minProfit\',this.value)" style="max-width:100px;">' +
    '<input type="number" id="sfMaxProfit" placeholder="أعلى ربح" value="' + sp.maxProfit +
    '" onchange="updateSalesFilter(\'maxProfit\',this.value)" style="max-width:100px;">' +
    '<input type="number" id="sfMinProfitPct" placeholder="أقل نسبة%" value="' + sp.minProfitPct +
    '" onchange="updateSalesFilter(\'minProfitPct\',this.value)" style="max-width:110px;">' +
    '<input type="number" id="sfMaxProfitPct" placeholder="أعلى نسبة%" value="' + sp.maxProfitPct +
    '" onchange="updateSalesFilter(\'maxProfitPct\',this.value)" style="max-width:110px;">' +
    '<button class="btn-sm outline" onclick="resetSalesFilters()">مسح الفلاتر</button>';
}

function debouncedSearchUpdate(value) {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(function() { updateSalesFilter('searchTerm', value); }, 400);
}

function updateSalesFilter(key, value) {
  salesFilterParams[key] = value;
  salesPage = 0;
  salesPageCursors = [null];
  salesPageItemsCache = {};
  salesQueryCache = { lastDoc: null, hasMore: true, currentPageItems: [] };
  renderSalesLog();
}

function resetSalesFilters() {
  salesFilterParams = { period: 'all', searchTerm: '', categoryId: '', productId: '', minQty: '', maxQty: '',
    minProfit: '', maxProfit: '', minProfitPct: '', maxProfitPct: '' };
  salesPage = 0;
  salesPageCursors = [null];
  salesPageItemsCache = {};
  salesQueryCache = { lastDoc: null, hasMore: true, currentPageItems: [] };
  renderSalesLog();
}

function viewSaleDetail(saleId) {
  var s = allSales.find(function(x) { return x.saleId === saleId; });
  if (!s) { s = (salesQueryCache.currentPageItems || []).find(function(x) { return x.saleId === saleId; }); }
  if (!s) {
    db.collection('sales').doc(saleId).get().then(function(doc) {
      if (doc.exists) {
        var data = { saleId: doc.id, ...doc.data() };
        renderSaleDetailModal(data);
      }
    }).catch(function() {});
    return;
  }
  renderSaleDetailModal(s);
}

function renderSaleDetailModal(s) {
  var cost = (s.purchasePriceAtTime || 0) * (s.quantity || 0);
  var profitPct = cost > 0 ? ((s.profit || 0) / cost * 100) : 0;
  var item = allItems.find(function(i) { return i.id === s.itemId; });
  document.getElementById('saleDetailContent').innerHTML =
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px 16px;font-size:0.85rem;">' +
    '<div><strong>رقم الفاتورة:</strong> ' + escHtml(s.saleId) + '</div><div><strong>التاريخ:</strong> ' +
    fmtDateTime(s.timestamp) + '</div>' +
    '<div><strong>المنتج:</strong> ' + escHtml(s.itemName || '--') + '</div><div><strong>سعر الشراء:</strong> ' +
    formatMoney(s.purchasePriceAtTime || 0) + '</div>' +
    '<div><strong>الكمية:</strong> ' + (s.quantity || 0) + '</div><div><strong>سعر البيع:</strong> ' +
    formatSaleUnitMoney(s) + '</div>' +
    '<div><strong>الإجمالي:</strong> ' + formatSaleMoney(s, s.totalAmount || 0) + '</div><div><strong>كمية الربح:</strong> ' +
    '<span class="' + ((s.profit || 0) >= 0 ? 'profit-positive' : 'profit-negative') + '">' + formatMoney(s.profit || 0) + '</span></div>' +
    '<div><strong>نسبة الربح:</strong> ' + fmt(profitPct) + '%</div><div><strong>الفئة:</strong> ' +
    escHtml(item ? item.categoryName || '--' : '--') + '</div>' +
    '</div>' +
    '<div style="margin-top:16px;display:flex;gap:10px;justify-content:flex-end;">' +
    '<button onclick="closeModalById(\'saleDetailModal\')" style="background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:20px;padding:8px 16px;cursor:pointer;font-weight:700;">إغلاق</button>' +
    '<button onclick="closeModalById(\'saleDetailModal\'); editSale(\'' + s.saleId + '\')" style="background:var(--accent-light);color:var(--accent);border:none;border-radius:20px;padding:8px 16px;cursor:pointer;font-weight:700;">تعديل</button>' +
    '<button onclick="closeModalById(\'saleDetailModal\'); cancelSale(\'' + s.saleId + '\')" style="background:var(--danger-light);color:var(--danger);border:none;border-radius:20px;padding:8px 16px;cursor:pointer;font-weight:700;">إلغاء</button>' +
    '</div>';
  document.getElementById('saleDetailModal').classList.add('show');
}

window.viewSaleDetail = viewSaleDetail;

window.editSale = function(saleId) {
  var sale = allSales.find(function(s) { return s.saleId === saleId; });
  // If not cached locally, try to fetch from Firestore
  var saleDocFetch = null;
  if (!sale) {
    saleDocFetch = db.collection('sales').doc(saleId).get().then(function(d) {
      if (!d.exists) throw new Error('بيع غير موجود');
      return { saleId: d.id, ...d.data() };
    }).catch(function(err) { return null; });
  }
  Promise.resolve(saleDocFetch || sale).then(async function(res) {
    var theSale = res || sale;
    if (!theSale) return alert('سجل البيع غير متوفر حالياً');
    var prod = allItems.find(function(i) { return i.id === theSale.itemId; });
    if (!prod) {
      // try fetching product from DB
      try {
        var pd = await db.collection('items').doc(theSale.itemId).get();
        if (!pd.exists) return alert('المنتج غير موجود');
        prod = { id: pd.id, ...pd.data() };
      } catch (err) {
        return alert('المنتج غير موجود');
      }
    }
    var sale = theSale;
  document.getElementById('editSaleId').value = sale.saleId;
  document.getElementById('editOriginalItemId').value = sale.itemId;
  document.getElementById('editOriginalQuantity').value = sale.quantity;
  document.getElementById('editSaleCurrency').value = sale.saleMode || 'primary';
  document.getElementById('editProductName').innerText = sale.itemName;
  document.getElementById('editQuantity').value = sale.quantity;
  document.getElementById('editQuantity').max = prod.quantity + sale.quantity;
  tempEditMode = (sale.saleMode === '');
  document.getElementById('editPriceLabel').innerHTML = 'السعر (' + (tempEditMode ? currencySettings
    .CurrencySymbol : '$') + ')';
  var editHistoricalRate = Number(sale.rateAtTime) || Number(currencySettings.rate) || 1;
  document.getElementById('editPrice').value = tempEditMode ? fmtMoney(sale.unitPrice * editHistoricalRate) : fmtMoney(sale
  .unitPrice);
  updateEditSalePriceDisplay();
    document.getElementById('editSaleModal').classList.add('show');
  });
};

document.getElementById('editSaleForm').addEventListener('submit', async function(e) {
  e.preventDefault();
  var saleId = document.getElementById('editSaleId').value;
  var itemId = document.getElementById('editOriginalItemId').value;
  var oldQty = parseInputNumber(document.getElementById('editOriginalQuantity').value);
  oldQty = oldQty === null ? 0 : oldQty;
  var newQty = parseInputNumber(document.getElementById('editQuantity').value);
  newQty = newQty === null ? 0 : newQty;
  var rawPrice = parseInputNumber(document.getElementById('editPrice').value);
  var sale = allSales.find(function(s) { return s.saleId === saleId; });
  var prod = allItems.find(function(i) { return i.id === itemId; });
  if (!sale || !prod) return;
  var editHistoricalRate = Number(sale.rateAtTime) || Number(currencySettings.rate) || 1;
  var price = rawPrice === null ? 0 : (tempEditMode ? rawPrice / editHistoricalRate : rawPrice);
  var diff = newQty - oldQty;
  var newSaleAllocations = sale.purchaseBatchAllocations ? JSON.parse(JSON.stringify(sale.purchaseBatchAllocations)) : [];
  try {
    if (diff !== 0) {
      if (prod.purchaseBatches && Array.isArray(prod.purchaseBatches) && prod.purchaseBatches.length) {
        if (diff > 0) {
          // need to consume additional qty from batches
          var extraAlloc = computeBatchAllocations(prod, diff);
          if (!extraAlloc || extraAlloc.length === 0) return alert('كمية غير متوفرة');
          try {
            var res = await applyBatchAllocationsTransaction(prod.id, extraAlloc);
            prod.purchaseBatches = res.purchaseBatches;
            prod.quantity = res.quantity;
            newSaleAllocations = newSaleAllocations.concat(extraAlloc);
          } catch (batchErr) {
            var fallbackQty = await updateItemQuantityTransaction(prod.id, -diff);
            prod.purchaseBatches = prod.purchaseBatches || [];
            prod.quantity = fallbackQty;
            newSaleAllocations = sale.purchaseBatchAllocations ? JSON.parse(JSON.stringify(sale.purchaseBatchAllocations)) : [];
          }
        } else {
          var toRestore = -diff;
          function extractRestore(existing, qty) {
            var cleanAllocations = Array.isArray(existing) ? existing.filter(function(entry) { return entry && typeof entry === 'object'; }) : [];
            var arr = cleanAllocations.slice();
            var restore = [];
            var remaining = qty;
            while (remaining > 0 && arr.length) {
              var last = arr[arr.length - 1];
              if (!last) {
                console.warn('[DEBUG] extractRestore found null last entry before reading quantity', { existing: existing, index: arr.length - 1, qty: qty });
                arr.pop();
                continue;
              }
              if ((Number(last.quantity) || 0) <= remaining) {
                restore.push(last);
                remaining -= Number(last.quantity) || 0;
                arr.pop();
              } else {
                restore.push({ timestamp: last.timestamp || null, unitCost: last.unitCost || 0, quantity: remaining });
                last.quantity = (Number(last.quantity) || 0) - remaining;
                arr[arr.length - 1] = last;
                remaining = 0;
              }
            }
            if (remaining > 0) throw new Error('تعذر استعادة الكمية من تسجيل البيع');
            return { restoreAllocations: restore, remainingAllocations: arr };
          }
          var extracted = extractRestore(newSaleAllocations, toRestore);
          var restoreAlloc = extracted.restoreAllocations;
          var remainingAlloc = extracted.remainingAllocations;
          var res2 = await restoreBatchAllocationsTransaction(prod.id, restoreAlloc);
          prod.purchaseBatches = res2.purchaseBatches;
          prod.quantity = res2.quantity;
          newSaleAllocations = remainingAlloc;
        }
      } else {
        var nq = await updateItemQuantityTransaction(prod.id, -diff);
        prod.quantity = nq;
      }
    }
  } catch (err) {
    return alert('فشل تعديل الكمية: ' + (err && err.message ? err.message : 'خطأ'));
  }
  var oldProfit = sale.profit || 0;
  var costBasis = (sale.purchasePriceAtTime != null) ? sale.purchasePriceAtTime : computeAveragePurchasePrice(prod);
  var newTotal = calculateSaleTotal(price, newQty);
  var newProfit = calculateSaleProfit(price, costBasis, newQty);
  var profitDiff = newProfit - oldProfit;
  var updatedCurrency = tempEditMode ? '' : 'primary';
  var updatedDisplayTotal = updatedCurrency === '' ? convertToSecondary(newTotal) : newTotal;
  var upd = { ...sale, quantity: newQty, unitPrice: price, totalAmount: newTotal, profit: newProfit,
    baseAmount: newTotal, baseCurrency: 'primary', displayTotalAmount: updatedDisplayTotal, rawTotalAmount: updatedDisplayTotal, displayCurrency: updatedCurrency,
    saleRevision: (Number(sale.saleRevision) || 1) + 1, saleMode: updatedCurrency, purchaseBatchAllocations: newSaleAllocations, purchasePriceAtTime: costBasis };
  try {
    await db.runTransaction(function (tx) {
      var saleRef = db.collection('sales').doc(saleId);
      return tx.get(saleRef).then(function (snapshot) {
        if (!snapshot.exists) throw new Error('بيع غير موجود');
        var currentSale = Object.assign({ saleId: snapshot.id }, snapshot.data());
        if ((Number(currentSale.saleRevision) || 1) !== (Number(sale.saleRevision) || 1)) throw new Error('SALE_REVISION_CONFLICT');
        return window.DailySalesSummary.applySaleMutationInTransaction(tx, currentSale, upd, 'update').then(function () {
          tx.set(saleRef, upd);
        });
      });
    });
    if (window.ProductSalesSummary && window.ProductSalesSummary.applySaleUpdate) {
      await window.ProductSalesSummary.applySaleUpdate(sale, upd);
    }
    if (window.MonthlySalesSummary && window.MonthlySalesSummary.applySaleUpdate) {
      try {
        await window.MonthlySalesSummary.applySaleUpdate(sale, upd);
      } catch (summaryErr) {
        console.warn('MonthlySalesSummary sale update failed', summaryErr);
      }
    }
    await logActivity('update', 'sale', saleId, 'تعديل بيع: ' + sale.itemName + '، الكمية الجديدة: ' + newQty + '، السعر: ' + fmt(price), { oldQuantity: oldQty, newQuantity: newQty, oldProfit: oldProfit, newProfit: newProfit });
    commitItemUpdate(prod);
    replaceSaleLocally(saleId, upd);
    if (document.getElementById('itemsList')) renderInventory();
    closeModalById('editSaleModal');
    showToast('تم تعديل البيع');
    await reloadSalesLog();
    if (currentSection === 'dashboard') renderDashboard();
  } catch (err) {
    upd.pending = 'pending'; upd.syncStatus = 'pending';
    enqueueSaleOperation('update', upd, { previousSale: sale, nextSale: upd, expectedRevision: Number(sale.saleRevision) || 1, nextRevision: Number(upd.saleRevision) || 2 });
    replaceSaleLocally(saleId, upd);
    closeModalById('editSaleModal');
    showToast('تم حفظ التعديل محليًا وسيتم مزامنته عند عودة الإنترنت');
    console.warn('Offline sale edit queued', err);
  }
});

async function resolveSaleProduct(sale) {
  var itemId = sale && sale.itemId != null ? String(sale.itemId).trim() : '';
  if (!itemId) throw new Error('سجل البيع لا يحتوي على معرف المنتج');
  var localItem = (Array.isArray(allItems) ? allItems : []).find(function(item) {
    return item && item.id != null && String(item.id) === itemId;
  });
  if (localItem) return localItem;
  var itemDoc;
  try {
    itemDoc = await db.collection('items').doc(itemId).get({ source: navigator.onLine ? 'default' : 'cache' });
  } catch (firstError) {
    if (!navigator.onLine) throw new Error('بيانات المنتج غير موجودة في الكاش المحلي');
    try { itemDoc = await db.collection('items').doc(itemId).get({ source: 'cache' }); }
    catch (secondError) { throw new Error('تعذر تحميل المنتج المرتبط بالبيع'); }
  }
  if (!itemDoc || !itemDoc.exists) throw new Error('المنتج المرتبط بالبيع غير موجود: ' + itemId);
  return { id: itemDoc.id, ...itemDoc.data() };
}

window.cancelSale = async function(saleId) {
  if (!confirm('إلغاء البيع؟')) return;
  var sale = allSales.find(function(s) { return s.saleId === saleId; });
  if (!sale) {
    try {
      var sd = await db.collection('sales').doc(saleId).get();
      if (!sd.exists) return alert('سجل البيع غير موجود');
      sale = { saleId: sd.id, ...sd.data() };
    } catch (err) {
      return alert('تعذر جلب سجل البيع');
    }
  }
  var prod;
  try { prod = await resolveSaleProduct(sale); }
  catch (err) { return alert('تعذر العثور على المنتج المرتبط بالبيع: ' + (err && err.message ? err.message : 'خطأ غير معروف')); }
  // restore quantity using batch-aware transaction when possible
  try {
    if (sale.purchaseBatchAllocations && Array.isArray(sale.purchaseBatchAllocations) && sale.purchaseBatchAllocations.length) {
      var res = await restoreBatchAllocationsTransaction(prod.id, sale.purchaseBatchAllocations);
      if (!res || res.quantity === undefined || res.quantity === null) throw new Error('تعذر الحصول على الكمية المسترجعة');
      prod.purchaseBatches = res.purchaseBatches;
      prod.quantity = res.quantity;
    } else {
      var newQty = await updateItemQuantityTransaction(prod.id, sale.quantity);
      if (newQty === undefined || newQty === null) throw new Error('تعذر الحصول على الكمية المسترجعة');
      prod.quantity = newQty;
    }
  } catch (err) {
    return alert('فشل استرجاع الكمية: ' + (err && err.message ? err.message : 'خطأ غير معروف'));
  }
  try {
    await db.runTransaction(function (tx) {
      var saleRef = db.collection('sales').doc(saleId);
      return tx.get(saleRef).then(function (snapshot) {
        if (!snapshot.exists) throw new Error('بيع غير موجود');
        var currentSale = Object.assign({ saleId: snapshot.id }, snapshot.data());
        var cancelledSale = Object.assign({}, currentSale, { saleRevision: (Number(currentSale.saleRevision) || 1) + 1, status: 'cancelled', cancelled: true, isCancelled: true });
        return window.DailySalesSummary.applySaleMutationInTransaction(tx, currentSale, cancelledSale, 'cancel')
          .then(function () { tx.delete(saleRef); });
      });
    });
    if (window.ProductSalesSummary && window.ProductSalesSummary.applySaleDelete) {
      await window.ProductSalesSummary.applySaleDelete(sale);
    }
    if (window.MonthlySalesSummary && window.MonthlySalesSummary.applySaleDelete) {
      try {
        await window.MonthlySalesSummary.applySaleDelete(sale);
      } catch (summaryErr) {
        console.warn('MonthlySalesSummary sale delete failed', summaryErr);
      }
    }
    await logActivity('delete', 'sale', saleId, 'إلغاء بيع: ' + sale.itemName + '، الكمية: ' + sale.quantity + '، الربح: ' + fmt(sale.profit || 0), { itemId: sale.itemId, itemName: sale.itemName, quantity: sale.quantity, profit: sale.profit });
    commitItemUpdate(prod);
    removeSaleLocally(saleId);
    if (document.getElementById('itemsList')) renderInventory();
    showToast('تم إلغاء البيع');
    await reloadSalesLog();
    if (currentSection === 'dashboard') renderDashboard();
  } catch (err) {
    sale.pending = 'pending'; sale.syncStatus = 'pending';
    enqueueSaleOperation('delete', sale, { expectedRevision: Number(sale.saleRevision) || 1, nextRevision: (Number(sale.saleRevision) || 1) + 1, sale: sale });
    removeSaleLocally(saleId);
    showToast('تم حفظ إلغاء البيع محليًا وسيتم مزامنته عند عودة الإنترنت');
    console.warn('Offline cancel sale queued', err);
  }
};

function renderProductAnalytics() {
  var arr = getProductSalesSummaryMap();
  var totalAllProfit = arr.reduce(function(a, p) { return a + p.totalProfit; }, 0);
  arr.sort(function(a, b) { return b.totalProfit - a.totalProfit; });
  var html = '';
  arr.forEach(function(p) { var contrib = totalAllProfit > 0 ? (p.totalProfit / totalAllProfit * 100) : 0; var
      avgProfit = p.totalQty > 0 ? p.totalProfit / p.totalQty : 0;
    html += '<tr><td>' + escHtml(p.name) + '</td><td>' + escHtml(p.categoryName || '--') + '</td><td>' + p
      .saleCount + '</td><td>' + p.totalQty + '</td><td>' + formatMoney(p.totalRevenue) +
      '</td><td class="profit-positive">' + formatMoney(p.totalProfit) + '</td><td>' + fmt(contrib) +
      '%</td><td>' + (p.lastSale ? fmtDate(p.lastSale) : '--') + '</td><td>' + formatMoney(avgProfit) +
      '</td></tr>'; });
  if (!arr.length) html = '<tr><td colspan="9" style="padding:30px;color:var(--text3);">لا توجد بيانات</td></tr>';
  document.getElementById('productAnalyticsBody').innerHTML = html;
  var prodResultCount = document.getElementById('prodResultCount');
  if (prodResultCount) prodResultCount.textContent = 'النتائج: ' + arr.length;
}

async function getReadLayerSummaryRangeStats(start, end) {
  if (!window.AnalyticsHelpers || !window.AnalyticsHelpers.readSalesSummaryForRange || !window.AnalyticsHelpers.readExpensesForRange) {
    return {
      salesCount: 0,
      revenue: 0,
      cost: 0,
      profit: 0,
      quantity: 0,
      expenses: 0,
      netProfit: 0,
      avgProfit: 0,
      summary: { salesCount: 0, totalSales: 0, totalCost: 0, totalProfit: 0, totalQuantity: 0 }
    };
  }

  var summaryResult = await window.AnalyticsHelpers.readSalesSummaryForRange(start, end, db);
  var expensesResult = await window.AnalyticsHelpers.readExpensesForRange(start, end, db);
  var summary = summaryResult && summaryResult.summary ? summaryResult.summary : { salesCount: 0, totalSales: 0, totalCost: 0, totalProfit: 0, totalQuantity: 0 };
  var expenses = Number(expensesResult && expensesResult.total) || 0;
  var salesCount = Number(summary.salesCount) || 0;
  var totalSales = Number(summary.totalSales) || 0;
  var totalCost = Number(summary.totalCost) || 0;
  var totalProfit = Number(summary.totalProfit) || 0;
  var totalQuantity = Number(summary.totalQuantity) || 0;
  var netProfit = totalProfit - expenses;
  return {
    salesCount: salesCount,
    revenue: totalSales,
    cost: totalCost,
    profit: totalProfit,
    quantity: totalQuantity,
    expenses: expenses,
    netProfit: netProfit,
    avgProfit: salesCount > 0 ? netProfit / salesCount : 0,
    summary: summary,
    summaryResult: summaryResult,
    expensesResult: expensesResult
  };
}

async function getEarliestSummaryMonthStart() {
  var snapshot = await db.collection('monthlySalesSummary').orderBy('monthKey', 'asc').limit(1).get();
  if (!snapshot || !snapshot.docs || !snapshot.docs.length) return 0;
  var data = snapshot.docs[0].data ? snapshot.docs[0].data() : null;
  var monthKey = String(data && data.monthKey || snapshot.docs[0].id || '');
  var match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!match) return 0;
  var year = Number(match[1]);
  var month = Number(match[2]);
  if (month < 1 || month > 12) return 0;
  return new Date(year, month - 1, 1).getTime();
}

async function renderProfitAnalysis() {
  var now = Date.now();
  var ds = getStartOfDay(),
    ws = getStartOfWeek(),
    ms = getStartOfMonth(),
    ys = getStartOfYear();
  var allTimeStart = await getEarliestSummaryMonthStart();
  var periods = [
    { label: 'اليوم', start: ds, end: now + 86400000 },
    { label: 'الأسبوع', start: ws, end: now + 86400000 },
    { label: 'الشهر', start: ms, end: now + 86400000 },
    { label: 'السنة', start: ys, end: now + 86400000 },
    { label: 'الكلي', start: allTimeStart, end: now + 86400000 }
  ];

  var statsHtml = '';
  var tableHtml = '';
  var periodStats = await Promise.all(periods.map(async function(p) {
    var stats = await getReadLayerSummaryRangeStats(p.start, p.end);
    return { label: p.label, stats: stats };
  }));

  periodStats.forEach(function(entry) {
    var stats = entry.stats;
    statsHtml +=
      '<div class="stat-card"><div class="stat-label">' + entry.label +
      '</div><div class="stat-value">' + formatMoney(stats.profit) + '</div><div class="stat-sub">الصافي بعد المصاريف: ' + formatMoney(stats.netProfit) + '</div><div class="stat-sub">' + stats.salesCount + ' عملية | إيرادات: ' + formatMoney(stats.revenue) + ' | مصاريف: ' + formatMoney(stats.expenses) +
      '</div></div>';
    tableHtml += '<tr><td>' + entry.label + '</td><td>' + stats.salesCount + '</td><td>' + formatMoney(stats.revenue) +
      '</td><td>' + formatMoney(stats.cost) + '</td><td class="profit-positive">' + formatMoney(stats.netProfit) +
      '</td><td>' + formatMoney(stats.avgProfit) + '</td></tr>';
  });

  document.getElementById('profitStatsGrid').innerHTML = statsHtml;
  document.getElementById('profitPeriodBody').innerHTML = tableHtml;

  var sortedSales = [...allSales].sort(function(a, b) { return a.timestamp - b.timestamp; });
  var cumData = [],
    cum = 0;
  sortedSales.forEach(function(s) { cum += s.profit || 0;
    cumData.push({ x: s.timestamp, y: cum }); });
  createChart('chartCumulativeProfit', {
    type: 'line',
    data: { datasets: [{ label: 'الأرباح التراكمية', data: cumData, borderColor: '#27ae60',
        backgroundColor: 'rgba(39,174,96,0.1)', fill: true, tension: 0.3, pointRadius: 1,
        borderWidth: 2.5
      }] },
    options: {
      ...getArabicChartDefaults(),
      scales: { x: { type: 'time', time: { unit: 'month', tooltipFormat: 'yyyy-MM-dd' }, ticks: { font: {
              family: 'Cairo', size: 10 } } }, y: { ...getArabicChartDefaults().scales
          .y } }
    }
  });
}

var comparisonMonthStates = {};
var comparisonMonthStatsCache = {};

async function getComparisonMonthStats(monthKey) {
  if (comparisonMonthStatsCache[monthKey]) return comparisonMonthStatsCache[monthKey];
  var parts = String(monthKey).split('-');
  var year = parseInt(parts[0], 10);
  var monthIndex = parseInt(parts[1], 10) - 1;
  var start = new Date(year, monthIndex, 1).getTime();
  var end = new Date(year, monthIndex + 1, 1).getTime();
  var stats = await getReadLayerSummaryRangeStats(start, end);
  var normalized = {
    salesCount: stats.salesCount,
    revenue: stats.revenue,
    expenses: stats.expenses,
    netProfit: stats.netProfit,
    margin: stats.revenue !== 0 ? stats.netProfit / stats.revenue * 100 : 0,
    hasData: stats.salesCount > 0 || stats.revenue !== 0 || stats.expenses !== 0 || stats.netProfit !== 0
  };
  comparisonMonthStatsCache[monthKey] = normalized;
  return normalized;
}

async function renderComparison() {
  var currentDate = new Date();
  var currentYear = currentDate.getFullYear();
  var currentMonthIndex = currentDate.getMonth();
  var monthNames = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
  var months = [];

  var cursorYear = currentYear;
  var cursorMonth = currentMonthIndex;
  while (true) {
    var monthKey = cursorYear + '-' + (cursorMonth + 1);
    var isCurrentMonth = cursorYear === currentYear && cursorMonth === currentMonthIndex;
    var isExpanded = comparisonMonthStates[monthKey];
    if (typeof isExpanded !== 'boolean') isExpanded = isCurrentMonth;
    months.push({
      key: monthKey,
      year: cursorYear,
      monthIndex: cursorMonth,
      label: monthNames[cursorMonth] + ' ' + cursorYear,
      expanded: isExpanded,
      isCurrentMonth: isCurrentMonth
    });
    if (cursorYear === 1970 && cursorMonth === 0) break;
    cursorMonth -= 1;
    if (cursorMonth < 0) {
      cursorMonth = 11;
      cursorYear -= 1;
    }
  }

  var monthStatsByKey = await Promise.all(months.map(async function(month) {
    if (!(month.expanded || month.isCurrentMonth)) return { key: month.key, stats: null };
    var stats = await getComparisonMonthStats(month.key);
    return { key: month.key, stats: stats };
  }));
  var monthStatsMap = {};
  monthStatsByKey.forEach(function(entry) { monthStatsMap[entry.key] = entry.stats; });

  var rows = '';
  months.forEach(function(month) {
    var monthStats = month.expanded || month.isCurrentMonth ? monthStatsMap[month.key] : null;
    var rowClass = month.isCurrentMonth ? ' class="comparison-last-month"' : '';
    var displayValue = month.expanded || month.isCurrentMonth ? (monthStats ? monthStats.salesCount : '—') : '—';
    var displayRevenue = month.expanded || month.isCurrentMonth ? (monthStats ? formatMoney(monthStats.revenue) : '—') : '—';
    var displayExpenses = month.expanded || month.isCurrentMonth ? (monthStats ? formatMoney(monthStats.expenses) : '—') : '—';
    var displayProfit = month.expanded || month.isCurrentMonth ? (monthStats ? formatMoney(monthStats.netProfit) : '—') : '—';
    var displayMargin = month.expanded || month.isCurrentMonth ? (monthStats ? fmt(monthStats.margin) + '%' : '—') : '—';
    rows += '<tr' + rowClass + ' data-month-key="' + month.key + '">' +
      '<td><button type="button" class="btn-sm comparison-month-toggle" data-month-key="' + month.key + '">' + ((month.expanded || month.isCurrentMonth) ? 'إخفاء' : 'عرض') + '</button> ' + escHtml(month.label) + '</td>' +
      '<td>' + displayValue + '</td>' +
      '<td>' + displayRevenue + '</td>' +
      '<td>' + displayExpenses + '</td>' +
      '<td>' + displayProfit + '</td>' +
      '<td>' + displayMargin + '</td>' +
      '</tr>';
  });
  if (comparisonManualRows) {
    rows += '<tr class="comparison-manual-separator"><td colspan="6">المقارنة اليدوية</td></tr>';
    rows += '<tr class="comparison-manual-row"><td>الفترة الأولى</td><td>' + comparisonManualRows.first.count + '</td><td>' + formatMoney(comparisonManualRows.first.revenue) + '</td><td>' + formatMoney(comparisonManualRows.first.expenses) + '</td><td>' + formatMoney(comparisonManualRows.first.netProfit) + '</td><td>' + fmt(comparisonManualRows.first.margin) + '%</td></tr>';
    rows += '<tr class="comparison-manual-row"><td>الفترة الثانية</td><td>' + comparisonManualRows.second.count + '</td><td>' + formatMoney(comparisonManualRows.second.revenue) + '</td><td>' + formatMoney(comparisonManualRows.second.expenses) + '</td><td>' + formatMoney(comparisonManualRows.second.netProfit) + '</td><td>' + fmt(comparisonManualRows.second.margin) + '%</td></tr>';
  }
  document.getElementById('comparisonStats').innerHTML =
    '<div class="table-container"><div class="table-header"><h3>مقارنة من بداية المشروع حتى الشهر الحالي</h3></div>' +
    '<div class="table-scroll"><table>' +
    '<thead><tr><th>الشهر</th><th>عدد المبيعات</th><th>قيمة المبيعات</th><th>المصاريف</th><th>صافي الربح</th><th>نسبة الربح</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table></div></div>';
  document.getElementById('comparisonChartCard').style.display = 'none';

  document.querySelectorAll('.comparison-month-toggle').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var monthKey = this.getAttribute('data-month-key');
      comparisonMonthStates[monthKey] = !comparisonMonthStates[monthKey];
      renderComparison();
    });
  });
}
document.getElementById('compareBtn').addEventListener('click', async function() {
  var s1 = parseDateString(document.getElementById('compStart1Val').value, false);
  var e1 = parseDateString(document.getElementById('compEnd1Val').value, true);
  var s2 = parseDateString(document.getElementById('compStart2Val').value, false);
  var e2 = parseDateString(document.getElementById('compEnd2Val').value, true);
  if (!s1 || !e1 || !s2 || !e2) { showToast('يرجى إدخال تواريخ صحيحة للفترتين'); return; }

  var r1 = await getReadLayerSummaryRangeStats(s1, e1 + 86400000);
  var r2 = await getReadLayerSummaryRangeStats(s2, e2 + 86400000);
  var diff = function(a, b) { var d = a - b; return d >= 0 ? '<span class="profit-positive">+' + formatMoney(d) + '</span>' : '<span class="profit-negative">-' + formatMoney(Math.abs(d)) + '</span>'; };
  comparisonManualRows = {
    first: { count: r1.salesCount, revenue: r1.revenue, expenses: r1.expenses || 0, netProfit: r1.netProfit, margin: r1.revenue !== 0 ? r1.netProfit / r1.revenue * 100 : 0 },
    second: { count: r2.salesCount, revenue: r2.revenue, expenses: r2.expenses || 0, netProfit: r2.netProfit, margin: r2.revenue !== 0 ? r2.netProfit / r2.revenue * 100 : 0 }
  };
  renderComparison();
  return;

  document.getElementById('comparisonStats').innerHTML =
    '<div class="stat-card"><div class="stat-label">الفترة الأولى - الإيرادات</div><div class="stat-value">' + formatMoney(r1.revenue) + '</div></div>' +
    '<div class="stat-card"><div class="stat-label">الفترة الثانية - الإيرادات</div><div class="stat-value">' + formatMoney(r2.revenue) +
    '</div><div class="stat-sub">الفرق: ' + diff(r2.revenue, r1.revenue) + '</div></div>' +
    '<div class="stat-card"><div class="stat-label">الفترة الأولى - الأرباح</div><div class="stat-value">' + formatMoney(r1.profit) + '</div></div>' +
    '<div class="stat-card"><div class="stat-label">الفترة الثانية - الأرباح</div><div class="stat-value">' + formatMoney(r2.profit) +
    '</div><div class="stat-sub">الفرق: ' + diff(r2.profit, r1.profit) + '</div></div>' +
    '<div class="stat-card"><div class="stat-label">الفترة الأولى - العمليات</div><div class="stat-value">' + r1.salesCount + '</div></div>' +
    '<div class="stat-card"><div class="stat-label">الفترة الثانية - العمليات</div><div class="stat-value">' + r2.salesCount +
    '</div><div class="stat-sub">الفرق: ' + (r2.salesCount - r1.salesCount >= 0 ? '+' : '') + (r2.salesCount - r1.salesCount) +
    '</div></div>' +
    '<div class="stat-card"><div class="stat-label">الفترة الأولى - القطع المباعة</div><div class="stat-value">' + r1.quantity + '</div></div>' +
    '<div class="stat-card"><div class="stat-label">الفترة الثانية - القطع المباعة</div><div class="stat-value">' + r2.quantity +
    '</div><div class="stat-sub">الفرق: ' + (r2.quantity - r1.quantity >= 0 ? '+' : '') + (r2.quantity - r1.quantity) +
    '</div></div>';
  document.getElementById('comparisonChartCard').style.display = 'block';
  createChart('chartComparison', {
    type: 'bar',
    data: { labels: ['الإيرادات', 'الأرباح'], datasets: [{ label: 'الفترة الأولى', data: [r1.revenue, r1.profit],
        backgroundColor: '#2b6cb0' }, { label: 'الفترة الثانية', data: [r2.revenue, r2.profit],
        backgroundColor: '#27ae60'
      }] },
    options: getArabicChartDefaults()
  });
});

function renderInsights() {
  var now = Date.now();
  var ds = getStartOfDay(),
    ms = getStartOfMonth();
  var currentDate = new Date(now);
  var year = currentDate.getFullYear();
  var month = currentDate.getMonth();
  // Current month: 1st to today
  var monthStart = new Date(year, month, 1).getTime();
  var monthEnd = now;
  var todaySales = allSales.filter(function(s) { return s.timestamp >= ds; });
  var monthSales = allSales.filter(function(s) { return s.timestamp >= monthStart && s.timestamp < monthEnd; });
  var monthProfit = monthSales.reduce(function(a, s) { return a + (s.profit || 0); }, 0);
  var monthExpenses = getExpensesSum(monthStart, monthEnd);
  var monthNetProfit = monthProfit - monthExpenses;
  var dayMap = {};
  allSales.forEach(function(s) { var dk = getDayKey(s.timestamp); if (!dayMap[dk]) dayMap[dk] = { profit: 0,
      revenue: 0, count: 0 };
    dayMap[dk].profit += s.profit || 0;
    dayMap[dk].revenue += s.totalAmount || 0;
    dayMap[dk].count++; });
  var daysArr = Object.entries(dayMap).map(function(e) { return { day: e[0], ...e[1] }; }).sort(function(a, b) {
    return b.profit - a.profit; });
  var bestDay = daysArr[0],
    worstDay = daysArr[daysArr.length - 1];
  var hourMap = {};
  allSales.forEach(function(s) { var h = new Date(s.timestamp).getHours(); if (!hourMap[h]) hourMap[h] = 0;
    hourMap[h]++; });
  var peakHour = Object.entries(hourMap).sort(function(a, b) { return b[1] - a[1]; })[0];
  var soldIds = new Set(allSales.map(function(s) { return s.itemId; }));
  var slowMovers = allItems.filter(function(i) { return !soldIds.has(i.id) && i.quantity > 0; });
  var fastMovers = getTopProducts(5);
  // Previous month: actual month before current (1st to last day)
  var prevMonth = month - 1;
  var prevYear = year;
  if (prevMonth < 0) { prevMonth = 11; prevYear = year - 1; }
  var prevMonthStart = new Date(prevYear, prevMonth, 1).getTime();
  var prevMonthEnd = new Date(year, month, 1).getTime();
  var prevMonthSales = allSales.filter(function(s) { return s.timestamp >= prevMonthStart && s.timestamp < prevMonthEnd; });
  var prevMonthProfit = prevMonthSales.reduce(function(a, s) { return a + (s.profit || 0); }, 0);
  var prevMonthExpenses = getExpensesSum(prevMonthStart, prevMonthEnd);
  var prevMonthNetProfit = prevMonthProfit - prevMonthExpenses;
  var profitGrowth = prevMonthNetProfit > 0 ? ((monthNetProfit - prevMonthNetProfit) / prevMonthNetProfit * 100) : 0;
  document.getElementById('insightsGrid').innerHTML =
    '<div class="stat-card"><div class="stat-icon" style="background:var(--gradient-2);"><i class="fas fa-calendar-check"></i></div><div class="stat-label">أفضل يوم</div><div class="stat-value" style="font-size:1rem;">' +
    (bestDay ? bestDay.day : '--') + '</div><div class="stat-sub">ربح: ' + formatMoney(bestDay ? bestDay
      .profit : 0) + '</div></div>' +
    '<div class="stat-card"><div class="stat-icon" style="background:var(--gradient-3);"><i class="fas fa-calendar-times"></i></div><div class="stat-label">أسوأ يوم</div><div class="stat-value" style="font-size:1rem;">' +
    (worstDay ? worstDay.day : '--') + '</div><div class="stat-sub">ربح: ' + formatMoney(worstDay ? worstDay
      .profit : 0) + '</div></div>' +
    '<div class="stat-card"><div class="stat-icon" style="background:var(--gradient-4);"><i class="fas fa-clock"></i></div><div class="stat-label">ساعة الذروة</div><div class="stat-value">' +
    (peakHour ? peakHour[0] + ':00' : '--') + '</div><div class="stat-sub">' + (peakHour ? peakHour[1] +
      ' عملية' : '') + '</div></div>' +
    '<div class="stat-card"><div class="stat-icon" style="background:var(--gradient-5);"><i class="fas fa-percentage"></i></div><div class="stat-label">نمو الأرباح الشهرية الصافية</div><div class="stat-value ' +
    (profitGrowth >= 0 ? 'profit-positive' : 'profit-negative') + '">' + fmt(profitGrowth) +
    '%</div></div>';
  var insightsHtml = '';
  if (bestDay) insightsHtml +=
    '<div class="insight-card"><i class="fas fa-trophy" style="color:#f6ad55;"></i><span class="insight-text">أعلى ربح يومي</span><span class="insight-val profit-positive">' +
    formatMoney(bestDay.profit) + '</span></div>';
  if (fastMovers.length) insightsHtml +=
    '<div class="insight-card"><i class="fas fa-rocket" style="color:#2b6cb0;"></i><span class="insight-text">سريعة الدوران: ' +
    fastMovers.map(function(p) { return escHtml(p.name); }).join('، ') + '</span></div>';
  if (slowMovers.length) insightsHtml +=
    '<div class="insight-card"><i class="fas fa-pause-circle" style="color:#e55353;"></i><span class="insight-text">راكدة: ' +
    slowMovers.slice(0, 5).map(function(i) { return escHtml(i.name); }).join('، ') + '</span></div>';
  var allTimeProfit = allSales.reduce(function(a, s) { return a + (s.profit || 0); }, 0) - getExpensesSum();
  var totalDays = allSales.length > 0 ? Math.max(1, Math.ceil((now - Math.min.apply(null, allSales.map(function(
    s) { return s.timestamp; }))) / 86400000)) : 1;
  insightsHtml +=
    '<div class="insight-card"><i class="fas fa-calculator" style="color:#6b46c1;"></i><span class="insight-text">متوسط الربح اليومي</span><span class="insight-val">' +
    formatMoney(allTimeProfit / totalDays) + '</span></div>';
  insightsHtml +=
    '<div class="insight-card"><i class="fas fa-calendar-alt" style="color:#0987a0;"></i><span class="insight-text">متوسط الربح الشهري</span><span class="insight-val">' +
    formatMoney(allTimeProfit / (totalDays / 30.44)) + '</span></div>';
  document.getElementById('insightsList').innerHTML = insightsHtml;
}

function renderExpenses() {
  var filtered = [...allExpenses];
  var filterDate = document.getElementById('expenseFilterDate') ? document.getElementById('expenseFilterDate')
    .value : '';
  if (filterDate) { var start = new Date(filterDate + 'T00:00:00').getTime(); var end = start + 86400000;
    filtered = filtered.filter(function(e) { return e.date >= start && e.date < end; }); }
  var html = '';
  filtered.forEach(function(e) { html += '<tr><td>' + fmtDate(e.date) + '</td><td>' + formatMoney(e.amount) +
      '</td><td>' + escHtml(e.description || '') +
      '</td><td><button onclick="deleteExpense(\'' + e.id +
      '\')" style="color:var(--danger);background:none;border:none;cursor:pointer;"><i class="fas fa-trash"></i></button></td></tr>'; });
  if (!filtered.length) html =
    '<tr><td colspan="4" style="padding:30px;color:var(--text3);">لا توجد مصاريف</td></tr>';
  document.getElementById('expensesBody').innerHTML = html;
}
document.getElementById('addExpenseBtn').addEventListener('click', function() { document.getElementById(
  'expenseModal').classList.add('show'); });
document.getElementById('saveExpenseBtn').addEventListener('click', async function() {
  var date = document.getElementById('expenseDate').value;
  var amount = parseFloat(document.getElementById('expenseAmount').value);
  var desc = document.getElementById('expenseDesc').value.trim();
  if (!date || !amount) { showToast('يرجى ملء البيانات'); return; }
  var expenseCurrency = getSystemCurrency();
  var rateAtTime = expenseCurrency === '' ? (Number(currencySettings.rate) || 1) : null;
  var expenseRecord = {
    date: new Date(date + 'T00:00:00').getTime(),
    amount: amount,
    currency: expenseCurrency,
    rateAtTime: rateAtTime,
    description: desc,
    createdBy: auth && auth.currentUser ? (auth.currentUser.email || auth.currentUser.uid || '') : ''
  };
  var expRef = await db.collection('expenses').add(expenseRecord);
  if (window.MonthlySalesSummary && window.MonthlySalesSummary.applyExpenseCreate) {
    try {
      await window.MonthlySalesSummary.applyExpenseCreate({ id: expRef.id, ...expenseRecord });
    } catch (summaryErr) {
      console.warn('MonthlySalesSummary expense create failed', summaryErr);
    }
  }
  await logActivity('expenseAdd', 'expense', expRef.id, 'إضافة مصروف: ' + desc + '، المبلغ: ' + amount, {
    amount: amount,
    currency: expenseCurrency,
    rateAtTime: rateAtTime,
    description: desc
  });
  closeModalById('expenseModal');
  clearAllCaches();
  await fetchExpensesSmart();
  showToast('تمت الإضافة');
});
window.deleteExpense = async function(id) {
  if (confirm('حذف المصروف؟')) {
    var expenseDoc = await db.collection('expenses').doc(id).get();
    var expenseRecord = expenseDoc.exists ? { id: expenseDoc.id, ...expenseDoc.data() } : { id: id, amount: 0, date: Date.now() };
    await db.collection('expenses').doc(id).delete();
    if (window.MonthlySalesSummary && window.MonthlySalesSummary.applyExpenseDelete) {
      try {
        await window.MonthlySalesSummary.applyExpenseDelete(expenseRecord);
      } catch (summaryErr) {
        console.warn('MonthlySalesSummary expense delete failed', summaryErr);
      }
    }
    await logActivity('expenseDelete', 'expense', id, 'حذف مصروف', { id: id });
    clearAllCaches();
    await fetchExpensesSmart();
    renderExpenses();
    showToast('تم الحذف'); }
};
document.getElementById('applyExpenseFilter').addEventListener('click', renderExpenses);

function renderCategories() {
  populateCategorySelect();
  renderCategoriesListUI();
  renderProductsChecklistForCategory('');
}

function renderCategoriesListUI() {
  var container = document.getElementById('categoriesList');
  if (!container) return;
  if (!allCategories.length) { container.innerHTML = '<div>لا توجد فئات</div>'; return; }
  var html = '';
  allCategories.forEach(function(cat) {
    var count = allItems.filter(function(i) { return i.categoryId === cat.id; }).length;
    var iconHtml = cat.icon ? '<i class="' + cat.icon + '"></i>' : '<i class="fas fa-tag"></i>';
    html += '<div class="cat-list-item"><div class="cat-name-icon">' + iconHtml + ' <strong>' + escHtml(cat
      .name) + '</strong> (' + count + ' منتج)</div><div class="cat-actions"><button class="edit-cat-icon" data-id="' +
      cat.id + '" data-name="' + escHtml(cat.name) + '" data-icon="' + escHtml(cat.icon || '') +
      '"><i class="fas fa-pencil-alt"></i></button><button class="delete-cat-icon" data-id="' + cat.id +
      '"><i class="fas fa-times"></i></button></div></div>';
  });
  container.innerHTML = html;
  document.querySelectorAll('.edit-cat-icon').forEach(function(btn) { btn.addEventListener('click', function() {
      var newName = prompt('الاسم الجديد', btn.dataset.name); if (newName) { var newIcon =
        prompt('الأيقونة الجديدة', btn.dataset.icon);
        updateCategory(btn.dataset.id, newName, newIcon || ''); } }); });
  document.querySelectorAll('.delete-cat-icon').forEach(function(btn) { btn.addEventListener('click', function() {
      deleteCategory(btn.dataset.id); }); });
}

async function updateCategory(catId, newName, newIcon) {
  await db.collection('categories').doc(catId).update({ name: newName, icon: newIcon });
  await logActivity('update', 'category', catId, 'تعديل فئة: ' + newName, { name: newName, icon: newIcon });
  var cat = allCategories.find(function(c) { return c.id === catId; });
  if (cat) { cat.name = newName;
    cat.icon = newIcon; }
  allCategories.sort(function(a, b) { return a.name.localeCompare(b.name, 'ar', { sensitivity: 'base' }); });
  renderCategoriesListUI();
  populateCategorySelect();
  showToast('تم التحديث');
}

async function deleteCategory(catId) {
  if (!confirm('حذف الفئة؟')) return;
  await db.collection('categories').doc(catId).delete();
  await logActivity('delete', 'category', catId, 'حذف فئة', { categoryId: catId });
  allCategories = allCategories.filter(function(c) { return c.id !== catId; });
  for (var pi = 0; pi < allItems.length; pi++) { if (allItems[pi].categoryId === catId) { allItems[pi].categoryId =
        null;
      allItems[pi].categoryName = '';
      await db.collection('items').doc(allItems[pi].id).update({ categoryId: null, categoryName: '' }); } }
  renderCategoriesListUI();
  populateCategorySelect();
  showToast('تم الحذف');
}
document.getElementById('createCategoryBtn').addEventListener('click', async function() {
  var name = document.getElementById('newCategoryName').value.trim();
  var icon = document.getElementById('newCategoryIcon').value.trim();
  if (!name) return;
  var ref = await db.collection('categories').add({ name: name, icon: icon || '', createdAt: Date.now() });
  await logActivity('create', 'category', ref.id, 'إضافة فئة: ' + name, { name: name, icon: icon });
  allCategories.push({ id: ref.id, name: name, icon: icon || '' });
  allCategories.sort(function(a, b) { return a.name.localeCompare(b.name, 'ar', { sensitivity: 'base' }); });
  renderCategoriesListUI();
  populateCategorySelect();
  document.getElementById('newCategoryName').value = '';
  document.getElementById('newCategoryIcon').value = '';
  showToast('تمت الإضافة');
});

function renderProductsChecklistForCategory(categoryId) {
  var container = document.getElementById('productsChecklist');
  if (!container) return;
  var searchEl = document.getElementById('assignProductSearch');
  var search = searchEl ? searchEl.value.trim() : '';
  var filtered = allItems.filter(function(p) {
    var belongsToSelected = categoryId && p.categoryId === categoryId;
    var unassigned = !p.categoryId;
    if (categoryId) {
      if (!(belongsToSelected || unassigned)) return false;
    } else {
      if (!unassigned) return false;
    }
    if (!search) return true;
    return p.name.includes(search);
  });
  filtered.sort(arabicAlphabeticalComparator);
  if (!filtered.length) { container.innerHTML = 'لا توجد منتجات'; return; }
  var html = '';
  filtered.forEach(function(prod) {
    var checked = categoryId && prod.categoryId === categoryId;
    html += '<div class="product-check"><input type="checkbox" value="' + prod.id + '" id="prod_' + prod.id +
      '" ' + (checked ? 'checked' : '') + '> <label for="prod_' + prod.id + '">' + escHtml(prod.name) +
      '</label></div>';
  });
  container.innerHTML = html;
}
document.getElementById('assignCategorySelect').addEventListener('change', function(e) {
  renderProductsChecklistForCategory(e.target.value);
});
document.getElementById('assignProductSearch').addEventListener('input', function() {
  var catId = document.getElementById('assignCategorySelect').value;
  renderProductsChecklistForCategory(catId);
});
document.getElementById('assignProductsBtn').addEventListener('click', async function() {
  var catId = document.getElementById('assignCategorySelect').value;
  if (!catId) return alert('اختر فئة');
  var checks = document.querySelectorAll('#productsChecklist input:checked');
  var productIds = Array.from(checks).map(function(ch) { return ch.value; });
  var cat = allCategories.find(function(c) { return c.id === catId; });
  if (!cat) return;
  var currentCategoryItems = allItems.filter(function(i) { return i.categoryId === catId; });
  if (!productIds.length && !currentCategoryItems.length) return alert('اختر منتجات');
  var batch = db.batch();
  var updated = 0;
  currentCategoryItems.forEach(function(p) {
    if (productIds.indexOf(p.id) === -1) {
      p.categoryId = null;
      p.categoryName = '';
      batch.update(db.collection('items').doc(p.id), { categoryId: null, categoryName: '' });
      updated++;
    }
  });
  for (var pi = 0; pi < productIds.length; pi++) {
    var pid = productIds[pi];
    var p = allItems.find(function(i) { return i.id === pid; });
    if (p && p.categoryId !== catId) {
      p.categoryId = catId;
      p.categoryName = cat.name;
      batch.update(db.collection('items').doc(pid), { categoryId: catId, categoryName: cat.name });
      updated++;
    }
  }
  if (!updated) return alert('لم يتم تغيير أي منتج');
  await batch.commit();
  await logActivity('assign', 'item', null, 'تعيين منتجات للفئة: ' + cat.name, { categoryId: catId, categoryName: cat.name, products: productIds });
  showToast('تم التعيين');
  renderProductsChecklistForCategory(catId);
});

var storeNameSettingsForm = document.getElementById('storeNameSettingsForm');
if (storeNameSettingsForm) {
  storeNameSettingsForm.addEventListener('submit', function(e) {
    e.preventDefault();
    e.stopPropagation();
    return false;
  });
}

async function saveStoreNameSetting() {
  var storeNameInput = document.getElementById('storeNameSettingInput');
  var storeName = storeNameInput ? (storeNameInput.value || '') : '';
  var cleanedName = String(storeName).trim();
  var payload = {
    name: cleanedName,
    storeName: cleanedName,
    updatedAt: Date.now()
  };
  if (!cleanedName) {
    showToast('يرجى إدخال اسم المتجر');
    if (storeNameInput) storeNameInput.focus();
    return;
  }
  if (cleanedName) {
    storeInfoData = Object.assign({}, storeInfoData, payload);
  }
  try {
    await db.collection('settings').doc('storeInfo').set(payload, { merge: true });
    await db.collection('storeInfo').doc('info').set(Object.assign({}, storeInfoData, { name: cleanedName, storeName: cleanedName, updatedAt: Date.now() }), { merge: true });
    await logActivity('storeNameSettingsUpdate', 'settings', 'storeInfo', 'تحديث اسم المتجر', payload);
    showToast('تم حفظ اسم المتجر');
  } catch (error) {
    console.error('Unable to save store name settings', error);
    showToast('تعذر حفظ اسم المتجر');
  }
}

var userDisplayNamesForm = document.getElementById('userDisplayNamesForm');
var addUserDisplayNameBtn = document.getElementById('addUserDisplayNameBtn');
if (addUserDisplayNameBtn) {
  addUserDisplayNameBtn.addEventListener('click', function() {
    addUserDisplayNameRow('', '');
    syncUserDisplayNameRowsToInput();
    var rows = document.querySelectorAll('.user-display-name-row');
    var lastRow = rows[rows.length - 1];
    var emailInput = lastRow ? lastRow.querySelector('.user-display-email') : null;
    if (emailInput) emailInput.focus();
  });
}
if (userDisplayNamesForm) {
  userDisplayNamesForm.addEventListener('submit', async function(e) {
    e.preventDefault();
    syncUserDisplayNameRowsToInput();
    var text = document.getElementById('userDisplayNamesText').value || '';
    var map = parseUserDisplayNamesFromInput(text);
    userDisplayNameSettings = map;
    await db.collection('settings').doc('userDisplayNames').set(map);
    await logActivity('userDisplayNamesUpdate', 'settings', 'userDisplayNames', 'تحديث أسماء المستخدمين', map);
    showToast('تم حفظ أسماء المستخدمين');
  });
}

var mobileSalesAdminAccountForm = document.getElementById('mobileSalesAdminAccountForm');
if (mobileSalesAdminAccountForm) {
  mobileSalesAdminAccountForm.addEventListener('submit', async function(e) {
    e.preventDefault();
    try {
      var payload = await saveMobileSalesAdminSelection();
      if (payload) {
        await logActivity('mobileSalesAdminUpdate', 'settings', 'mobileSales', 'تحديث حساب الأدمن لصفحة المبيعات الهاتفية', payload);
        showToast('تم حفظ حساب الأدمن');
      }
    } catch (error) {
      console.error('Unable to save mobile sales admin account', error);
      showToast('تعذر حفظ حساب الأدمن');
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function() {
    if (document.getElementById('storeNameSettingInput')) {
      fetchStoreInfo();
    }
    if (document.getElementById('mobileSalesAdminAccountSelect')) {
      loadMobileSalesAdminSelection();
    }
  });
} else {
  if (document.getElementById('storeNameSettingInput')) {
    fetchStoreInfo();
  }
  if (document.getElementById('mobileSalesAdminAccountSelect')) {
    loadMobileSalesAdminSelection();
  }
}


var _darkToggle = document.getElementById('darkToggle'); if (_darkToggle) _darkToggle.addEventListener('click', function() { darkMode = !darkMode; applyDarkMode(); destroyAllCharts(); renderCurrentSection(); });
var _currencyToggleBtn = document.getElementById('currencyToggleBtn'); if (_currencyToggleBtn) _currencyToggleBtn.addEventListener('click', function() { displayPrimaryCurrency = !displayPrimaryCurrency; localStorage.setItem('xmetalDisplaySecondary', displayPrimaryCurrency); var label = document.getElementById('currencyLabel'); if (label) label.textContent = displayPrimaryCurrency ? currencySettings.CurrencySymbol : '$'; destroyAllCharts(); renderCurrentSection(); });

function applySalesFiltersClient() {
  var filtered = [...allSales];
  var sp = salesFilterParams;
  var now = Date.now();
  if (sp.period === 'today') { var ds = getStartOfDay();
    filtered = filtered.filter(function(s) { return s.timestamp >= ds; }); } else if (sp.period === 'week') { var ws =
      getStartOfWeek();
    filtered = filtered.filter(function(s) { return s.timestamp >= ws; }); } else if (sp.period === 'month') { var
      ms = getStartOfMonth();
    filtered = filtered.filter(function(s) { return s.timestamp >= ms; }); } else if (sp.period === 'year') { var ys =
      getStartOfYear();
    filtered = filtered.filter(function(s) { return s.timestamp >= ys; }); } else if (sp.period === '7days') { var
      d7 = now - 7 * 86400000;
    filtered = filtered.filter(function(s) { return s.timestamp >= d7; }); } else if (sp.period === '30days') { var
      d30 = now - 30 * 86400000;
    filtered = filtered.filter(function(s) { return s.timestamp >= d30; }); } else if (sp.period === '90days') { var
      d90 = now - 90 * 86400000;
    filtered = filtered.filter(function(s) { return s.timestamp >= d90; }); } else if (sp.period === 'custom' &&
    sp.customStart) { filtered = filtered.filter(function(s) { return s.timestamp >= sp.customStart; }); if (sp
      .customEnd) filtered = filtered.filter(function(s) { return s.timestamp <= sp.customEnd; }); }
  if (sp.searchTerm) { var t = sp.searchTerm.toLowerCase();
    filtered = filtered.filter(function(s) { return (s.itemName || '').toLowerCase().includes(t); }); }
  if (sp.productId) filtered = filtered.filter(function(s) { return s.itemId === sp.productId; });
  if (sp.categoryId) { var catItems = allItems.filter(function(i) { return i.categoryId === sp.categoryId; }).map(
      function(i) { return i.id; });
    filtered = filtered.filter(function(s) { return catItems.includes(s.itemId); }); }
  if (sp.minProfit !== '') filtered = filtered.filter(function(s) { return (s.profit || 0) >= parseFloat(sp
      .minProfit); });
  if (sp.maxProfit !== '') filtered = filtered.filter(function(s) { return (s.profit || 0) <= parseFloat(sp
      .maxProfit); });
  if (sp.minQty !== '') filtered = filtered.filter(function(s) { return (s.quantity || 0) >= parseFloat(sp.minQty); });
  if (sp.maxQty !== '') filtered = filtered.filter(function(s) { return (s.quantity || 0) <= parseFloat(sp.maxQty); });
  if (sp.minProfitPct !== '' || sp.maxProfitPct !== '') {
    filtered = filtered.filter(function(s) { var cost = (s.purchasePriceAtTime || 0) * (s.quantity || 0); var pct = cost > 0 ? ((s.profit || 0) / cost *
        100) : 0; if (sp.minProfitPct !== '' && pct < parseFloat(sp.minProfitPct)) return false; if (sp
        .maxProfitPct !== '' && pct > parseFloat(sp.maxProfitPct)) return false; return true; });
  }
  return filtered;
}

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    closeMobileSidebar();
    document.querySelectorAll('.modal-overlay.show').forEach(function(m) { m.classList.remove(
      'show'); });
  }
});
window.addEventListener('click', function(e) {
  if (e.target.classList.contains('modal-overlay') && e.target.classList.contains('show')) e.target
    .classList.remove('show');
});

applyDarkMode();
