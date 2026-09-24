/* Mobile-only sales surface. It intentionally renders no cost, profit, capital, or analytics fields. */
(function () {
  'use strict';

  var db = window.firebaseDb;
  var auth = window.firebaseAuth;
  var SOURCE = 'mobile-sales';
  var CANCEL_SALE_SUCCESS_MESSAGE = 'تم إلغاء البيع وإعادة الكمية للمخزون بنجاح';
  var RETURN_SALE_SUCCESS_MESSAGE = 'تم استرجاع البيع بنجاح وإعادة الكمية للمخزون.';
  var pendingReturnSaleId = null;
  var pendingCreditCustomerReturn = false;
  var items = [];
  var sales = [];
  var activeSaleCancellations = new Set();
  var defaultCurrencySettings = { CurrencyName: 'ريال سعودي', CurrencySymbol: '﷼', rate: 3.75, baseCurrency: 'primary', defaultInputMode: 'primary', defaultSaleMode: 'primary', showProductPrices: false };
  var currency = Object.assign({}, defaultCurrencySettings);
  var selectedItem = null;
  var editingSale = null;
  var toastTimer = null;
  var inventorySort = localStorage.getItem('xmetalInventorySort') || 'alphabetical';
  var dataLoaded = false;
  var listenersStarted = false;
  var lastSyncAt = 0;
  var productElements = new Map();
  var installPrompt = null;

  function deactivateLegacyMobileSalesServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

    if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
      navigator.serviceWorker.getRegistrations().then(function (registrations) {
        var legacyRegistrations = (registrations || []).filter(function (registration) {
          var scriptUrl = registration && registration.active && registration.active.scriptURL ? registration.active.scriptURL : (registration && registration.scriptURL ? registration.scriptURL : '');
          return scriptUrl && /mobile-sales[-_]?sw\.js/i.test(scriptUrl);
        });
        return Promise.all(legacyRegistrations.map(function (registration) {
          return registration.unregister().catch(function (error) {
            console.warn('Unable to unregister legacy mobile sales service worker', error);
          });
        }));
      }).catch(function (error) {
        console.warn('Unable to query mobile sales service worker registrations', error);
      });
    }

    if ('caches' in window) {
      caches.keys().then(function (cacheNames) {
        return Promise.all(cacheNames.filter(function (cacheName) {
          return /^xmetal-mobile-sales/i.test(cacheName);
        }).map(function (cacheName) {
          return caches.delete(cacheName);
        }));
      }).catch(function (error) {
        console.warn('Unable to clear legacy mobile sales cache entries', error);
      });
    }
  }

  window.addEventListener('load', deactivateLegacyMobileSalesServiceWorker);
  var historyVisibleCount = 25;
  var unusualPriceApproved = false;
  var salePriceManuallyEdited = false;
  var saleDefaultPrice = null;
  var userDisplayNameMap = {};
  var helpers = window.XMetalMobileSalesHelpers || {};
  var showEndedProducts = false;
  var allowDebtDateEditing = true;
  var productFilterMode = 'available';
  var debtCustomers = [];
  var debtOperations = [];
  var customerDetailHistoryCounts = {};
  var customerDetailCycleCounts = {};
  var activePage = 'products';
  var debtTableSort = { key: 'name', direction: 1 };
  var employees = [];
  var employeeOperations = [];
  var selectedEmployeeId = null;
  var selectedEmployeePurchaseProduct = null;
  var selectedEmployeeEditOperation = null;
  var employeeActionMode = 'purchase';
  var managerAccess = false;
  var employeeDays = [];
  var currentEmployee = null;
  var employeeAccess = false;
  var employeeHistoryPageSize = 25;
  var employeeHistoryLastDoc = null;
  var employeeHistoryHasMore = false;
  var employeeHistoryLoading = false;
  var employeeHistoryRecords = [];
  var employeeHistoryAllRecords = [];
  var cashboxEntries = [];
  var cashboxLoaded = false;
  var operationsRecords = [];
  var operationsLastDocument = null;
  var operationsHasMore = false;
  var operationsLoading = false;
  var operationsLoaded = false;
  var operationsError = '';

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); };
  var number = function (value) { var n = Number(value); return Number.isFinite(n) ? n : null; };
  var toSecondary = function (primary) {
    if (window && window.CurrencyModel && typeof window.CurrencyModel.toSecondary === 'function') {
      return window.CurrencyModel.toSecondary(primary, currency.rate);
    }
    return (Number(primary) || 0) * (Number(currency.rate) || 1);
  };
  var primary = function (Value) {
    if (window && window.CurrencyModel && typeof window.CurrencyModel.toPrimary === 'function') {
      return window.CurrencyModel.toPrimary(Value, currency.rate);
    }
    return (Number(Value) || 0) / (Number(currency.rate) || 1);
  };
  var baseCurrency = function () { return currency.baseCurrency === '' ? '' : 'primary'; };
  var activeSymbol = function () { return baseCurrency() === '' ? currency.CurrencySymbol : '$'; };
  var activeAmountFromPrimary = function (value) { return baseCurrency() === '' ? (value) : (Number(value) || 0); };
  var getDisplayMoney = function (value, sourceCurrency, settings) {
    var sourceSettings = settings || currency || {};
    if (helpers.getDisplayMoney) {
      return helpers.getDisplayMoney(value, sourceCurrency, sourceSettings);
    }
    var activeCode = sourceSettings.baseCurrency === '' ? '' : 'primary';
    var rate = Number(sourceSettings.rate) || 1;
    var numericValue = Number(value) || 0;
    var sourceCode = String(sourceCurrency == null ? 'primary' : sourceCurrency).trim().toLowerCase();
    if (sourceCode !== 'primary' && sourceCode !== '') sourceCode = 'primary';
    var convertedValue = numericValue;
    if (sourceCode === 'primary' && activeCode === '') convertedValue = numericValue * rate;
    else if (sourceCode === '' && activeCode === 'primary') convertedValue = numericValue / rate;
    if (Number.isFinite(convertedValue) && Math.abs(convertedValue - Math.round(convertedValue)) < 1e-9) {
      convertedValue = Math.round(convertedValue);
    }
    return { value: convertedValue, symbol: activeCode === '' ? (sourceSettings.CurrencySymbol || '') : '$', code: activeCode };
  };
  var formatDisplayMoney = function (value, sourceCurrency, settings) {
    var display = getDisplayMoney(value, sourceCurrency, settings);
    return money(display.value) + ' ' + display.symbol;
  };
  var getActiveCurrencyDisplay = function (value, sourceCurrency) {
    if (helpers.getActiveCurrencyDisplay) {
      return helpers.getActiveCurrencyDisplay(value, sourceCurrency || 'primary', currency);
    }
    return getDisplayMoney(value, sourceCurrency || 'primary', currency);
  };
  var productCurrencyDisplay = function (value, sourceCurrency) {
    var display = getDisplayMoney(value, sourceCurrency || 'primary', currency);
    var Value = getDisplayMoney(value, sourceCurrency || 'primary', Object.assign({}, currency, { baseCurrency: baseCurrency() === '' ? 'primary' : '' })).value;
    return {
      primaryCode: baseCurrency(),
      primaryValue: display.value,
      primarySymbol: display.symbol,
      Value: Value,
      Symbol: baseCurrency() === '' ? '$' : (currency.CurrencySymbol || ''),
      showSecondary: currency.showProductPrices === true
    };
  };
  var amountInActiveCurrency = function (value, code) {
    var sourceCode = code === '' ? '' : 'primary';
    return getDisplayMoney(value, sourceCode, currency).value;
  };
  var getLegacySaleBaseAmount = function (sale) {
    if (!sale || typeof sale !== 'object') return 0;
    var candidates = [
      sale.baseAmount,
      sale.totalAmount,
      sale.amount,
      sale.displayTotalAmount,
      sale.rawTotalAmount,
      sale.displayAmount,
      sale.rawAmount
    ];
    var bestValue = 0;
    for (var i = 0; i < candidates.length; i += 1) {
      var numeric = Number(candidates[i]);
      if (Number.isFinite(numeric)) {
        if (Math.abs(numeric) > Math.abs(bestValue)) bestValue = numeric;
      }
    }
    return bestValue;
  };
  var getLegacySaleSourceCurrency = function (sale) {
    if (!sale || typeof sale !== 'object') return 'primary';
    if (sale.baseCurrency === '') return '';
    return 'primary';
  };
  var saleDisplayTotal = function (sale) {
    var sourceCurrency = getLegacySaleSourceCurrency(sale);
    var baseAmount = getLegacySaleBaseAmount(sale);
    return getDisplayMoney(baseAmount, sourceCurrency, currency).value;
  };
  var saleDisplayUnit = function (sale) {
    var quantity = Number(sale && sale.quantity) || 0;
    var sourceCurrency = getLegacySaleSourceCurrency(sale);
    var baseUnit = Number(sale && (sale.baseUnitPrice != null ? sale.baseUnitPrice : sale.unitPrice != null ? sale.unitPrice : 0)) || 0;
    if (quantity <= 0) return 0;
    if (baseUnit !== 0) return getDisplayMoney(baseUnit, sourceCurrency, currency).value;
    return saleDisplayTotal(sale) / quantity;
  };
  var money = function (value) { return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(value) || 0); };
  var GMT3_TIME_ZONE = 'Asia/Riyadh';
  function timestampValue(timestamp) {
    if (timestamp && typeof timestamp.toMillis === 'function') return timestamp.toMillis();
    if (timestamp && Number.isFinite(Number(timestamp.seconds))) return Number(timestamp.seconds) * 1000 + (Number(timestamp.nanoseconds) || 0) / 1000000;
    if (timestamp instanceof Date) return timestamp.getTime();
    var numeric = Number(timestamp);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    var parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  function toRiyadhIso(dateValue) {
    var d = new Date(dateValue || Date.now());
    var riyadhTime = new Date(d.getTime() + (3 * 60 * 60 * 1000));
    return riyadhTime.toISOString().slice(0, 19) + '+03:00';
  }
  function formatInGmt3(timestamp, options) {
    var value = timestampValue(timestamp) || Date.now();
    return new Intl.DateTimeFormat('ar-SA-u-nu-latn', Object.assign({ timeZone: GMT3_TIME_ZONE }, options || {})).format(new Date(value));
  }
  var date = function (timestamp) { return formatInGmt3(timestamp, { dateStyle: 'medium', timeStyle: 'short' }); };
  var dayNames = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
  function dayKey(timestamp) {
    var value = timestampValue(timestamp) || Date.now();
    var dateValue = new Date(value);
    var parts = new Intl.DateTimeFormat('en-CA', { timeZone: GMT3_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(dateValue);
    var year = parts.find(function (part) { return part.type === 'year'; }).value;
    var month = parts.find(function (part) { return part.type === 'month'; }).value;
    var day = parts.find(function (part) { return part.type === 'day'; }).value;
    return year + '-' + month + '-' + day;
  }
  function dayLabel(timestamp) {
    var value = timestampValue(timestamp) || Date.now();
    var d = new Date(value);
    var parts = new Intl.DateTimeFormat('ar-SA-u-nu-latn', { timeZone: GMT3_TIME_ZONE, weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(d);
    var weekday = parts.find(function (part) { return part.type === 'weekday'; }).value;
    var day = parts.find(function (part) { return part.type === 'day'; }).value;
    var month = parts.find(function (part) { return part.type === 'month'; }).value;
    var year = parts.find(function (part) { return part.type === 'year'; }).value;
    return weekday + ' ' + day + '/' + month + '/' + year;
  }
  function formatDateTime(timestamp) {
    return formatInGmt3(timestamp, { dateStyle: 'medium', timeStyle: 'short' });
  }
  function getRiyadhDateTimeParts(dateValue) {
    var source = new Date(dateValue || Date.now());
    var parts = new Intl.DateTimeFormat('en-CA', { timeZone: GMT3_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(source);
    var values = {};
    parts.forEach(function (part) {
      if (part.type !== 'literal') values[part.type] = part.value;
    });
    return {
      dateKey: [values.year || '0000', values.month || '01', values.day || '01'].join('-'),
      timeValue: [values.hour || '00', values.minute || '00'].join(':')
    };
  }
  function buildDebtOperationTimestamp(dateValue, timeValue) {
    var safeDate = String(dateValue || getRiyadhDateTimeParts(Date.now()).dateKey || '').trim();
    var safeTime = String(timeValue || getRiyadhDateTimeParts(Date.now()).timeValue || '00:00').trim();
    var currentParts = getRiyadhDateTimeParts(Date.now());
    if (safeDate === currentParts.dateKey && safeTime === currentParts.timeValue) return Date.now();
    var parsed = Date.parse(safeDate + 'T' + safeTime + ':00+03:00');
    return Number.isFinite(parsed) ? parsed : Date.now();
  }
  var showError = function (id, message) { $(id).textContent = message || ''; };

  function ensureProductImageModal() {
    var modal = document.getElementById('productImageModal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'productImageModal';
    modal.className = 'product-image-modal';
    modal.hidden = true;
    modal.innerHTML = '<div class="product-image-modal-backdrop" data-close-product-image="true"></div><div class="product-image-modal-content" role="dialog" aria-modal="true"><button type="button" class="product-image-modal-close" aria-label="إغلاق الصورة">×</button><img alt="صورة المنتج" src=""></div>';
    document.body.appendChild(modal);
    modal.querySelector('.product-image-modal-close').addEventListener('click', function () { modal.hidden = true; });
    modal.addEventListener('click', function (event) {
      if (event.target.hasAttribute('data-close-product-image')) modal.hidden = true;
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !modal.hidden) modal.hidden = true;
    });
    return modal;
  }

  function notify(message) {
    var el = $('toast'); el.textContent = message; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2600);
  }

  function normalizeCurrencySettings(settings) {
    var sourceSettings = Object.assign({}, defaultCurrencySettings, currency, settings || {});
    if (window && window.CurrencyModel && typeof window.CurrencyModel.normalizeSettings === 'function') {
      return window.CurrencyModel.normalizeSettings(sourceSettings);
    }
    var nextSettings = Object.assign({}, defaultCurrencySettings, currency, settings || {});
    nextSettings.baseCurrency = nextSettings.baseCurrency === '' || nextSettings.baseCurrency === 'primary' ? nextSettings.baseCurrency : (nextSettings.defaultInputMode === '' || nextSettings.defaultSaleMode === '' ? '' : 'primary');
    nextSettings.defaultInputMode = nextSettings.baseCurrency;
    nextSettings.defaultSaleMode = nextSettings.baseCurrency;
    var rate = Number(nextSettings.rate);
    if (!Number.isFinite(rate) || rate <= 0) {
      nextSettings.rate = defaultCurrencySettings.rate;
    }
    if (!nextSettings.CurrencySymbol || !String(nextSettings.CurrencySymbol).trim()) {
      nextSettings.CurrencySymbol = defaultCurrencySettings.CurrencySymbol;
    }
    if (!nextSettings.CurrencyName || !String(nextSettings.CurrencyName).trim()) {
      nextSettings.CurrencyName = defaultCurrencySettings.CurrencyName;
    }
    return nextSettings;
  }

  function applyCurrencySettings(settings) {
    currency = normalizeCurrencySettings(settings);
    try {
      localStorage.setItem('xmetalMobileSalesCurrency', JSON.stringify(currency));
    } catch (error) {
      console.warn('Unable to cache mobile sales currency settings', error);
    }
    if (typeof renderProducts === 'function') renderProducts();
    if (typeof renderHistory === 'function') renderHistory();
    if (typeof renderDebtList === 'function') renderDebtList();
  }

  async function refreshCurrencySettings() {
    if (!db || !db.collection) return currency;
    try {
      var snapshot = await db.collection('currencySettings').doc('settings').get({ source: 'server' });
      if (snapshot && snapshot.exists && snapshot.data) {
        applyCurrencySettings(snapshot.data());
      }
    } catch (error) {
      try {
        var cachedSnapshot = await db.collection('currencySettings').doc('settings').get({ source: 'cache' });
        if (cachedSnapshot && cachedSnapshot.exists && cachedSnapshot.data) {
          applyCurrencySettings(cachedSnapshot.data());
        }
      } catch (cacheError) {
        console.warn('Unable to load mobile currency settings', cacheError);
      }
    }
    return currency;
  }

  function mergeDisplayNameMap(source) {
    if (!source || typeof source !== 'object') return {};
    var merged = {};
    if (helpers.flattenNameMap) {
      Object.assign(merged, helpers.flattenNameMap(source));
    } else if (source.emails && typeof source.emails === 'object') {
      Object.assign(merged, source.emails);
    }
    Object.keys(source).forEach(function (key) {
      var value = source[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (value.name || value.displayName || value.fullName || value.email || value.userEmail) {
          var nestedEmail = value.email || value.userEmail || key;
          if (nestedEmail && (value.name || value.displayName || value.fullName || value.label)) merged[String(nestedEmail).trim().toLowerCase()] = String(value.name || value.displayName || value.fullName || value.label).trim();
        }
      }
    });
    return merged;
  }

  async function refreshUserDisplayNameMap() {
    var docs = [
      db.collection('settings').doc('userDisplayNames'),
      db.collection('settings').doc('userNames'),
      db.collection('systemSettings').doc('userDisplayNames'),
      db.collection('systemSettings').doc('userNames'),
      db.collection('adminSettings').doc('userDisplayNames')
    ];
    var merged = {};
    for (var i = 0; i < docs.length; i += 1) {
      try {
        var doc = await docs[i].get();
        if (!doc || !doc.exists) continue;
        Object.assign(merged, mergeDisplayNameMap(doc.data()));
      } catch (error) { /* Ignore missing settings docs */ }
    }
    userDisplayNameMap = merged;
    return merged;
  }

  function getCurrentSellerInfo() {
    var currentUser = auth && auth.currentUser ? auth.currentUser : null;
    var email = currentUser && currentUser.email ? String(currentUser.email).trim() : '';
    var fallbackName = currentUser && currentUser.displayName ? String(currentUser.displayName).trim() : '';
    var name = helpers.resolveSellerName ? helpers.resolveSellerName(email, fallbackName, userDisplayNameMap) : (fallbackName || email);
    return { email: email, name: name };
  }

  function getCurrentUserOwnership() {
    var currentUser = auth && auth.currentUser ? auth.currentUser : null;
    var userId = currentUser && currentUser.uid ? String(currentUser.uid).trim() : '';
    var email = currentUser && currentUser.email ? String(currentUser.email).trim() : '';
    return {
      userId: userId,
      ownerId: userId,
      createdBy: email || userId,
      email: email,
      uid: userId
    };
  }

  async function getConfiguredMobileSalesAdminAccount() {
    if (!db || !db.collection) return { uid: '', email: '' };
    var candidates = [
      db.collection('settings').doc('mobileSales'),
      db.collection('systemSettings').doc('mobileSales'),
      db.collection('adminSettings').doc('mobileSales')
    ];

    for (var i = 0; i < candidates.length; i += 1) {
      try {
        var doc = await candidates[i].get({ source: 'server' });
        if (!doc || !doc.exists) continue;
        var data = doc.data() || {};
        var uid = String(data.mobileSalesAdminUid || (data.mobileSalesAdmin && data.mobileSalesAdmin.uid) || '').trim();
        var email = String(data.mobileSalesAdminEmail || (data.mobileSalesAdmin && data.mobileSalesAdmin.email) || '').trim().toLowerCase();
        if (uid || email) return { uid: uid, email: email };
      } catch (error) {
        continue;
      }
    }
    return { uid: '', email: '' };
  }

  async function loadMobileSettings() {
    if (!db || !db.collection) return;
    try {
      var snapshot = await db.collection('settings').doc('mobileSales').get({ source: 'server' });
      if (!snapshot.exists) return;
      var settings = snapshot.data() || {};
      showEndedProducts = settings.showEndedProducts === true;
      allowDebtDateEditing = settings.allowDebtDateEditing !== false;
      $('showEndedProductsToggle').checked = showEndedProducts;
      $('allowDebtDateEditingToggle').checked = allowDebtDateEditing;
    } catch (error) {
      console.warn('Unable to load mobile settings from Firestore', error);
    }

    var configuredAdmin = await getConfiguredMobileSalesAdminAccount();
    var statusValue = document.getElementById('mobileSalesAdminAccountStatusValue');
    if (statusValue) statusValue.textContent = configuredAdmin.email || configuredAdmin.uid || 'غير محدد';
  }

  async function saveMobileSettings(changes) {
    if (!db || !db.collection) throw new Error('قاعدة البيانات غير متاحة');
    var payload = Object.assign({}, changes || {}, {
      updatedAt: Date.now()
    });
    await db.collection('settings').doc('mobileSales').set(payload, { merge: true });
  }

  function getSellerLabel(sale) {
    var email = sale && (sale.sellerEmail || sale.user || sale.email || '');
    var fallbackName = sale && (sale.sellerName || sale.displayName || '');
    if (helpers.resolveSellerName) return helpers.resolveSellerName(email, fallbackName, userDisplayNameMap) || 'غير محدد';
    return fallbackName || email || 'غير محدد';
  }

  function updateCustomScrollbar() {
    var track = $('customScrollbar'), thumb = $('customScrollbarThumb');
    if (!track || !thumb) return;
    var cards = Array.from(document.querySelectorAll('.product-card'));
    if (!cards.length) { track.hidden = true; return; }
    var firstCard = cards[0];
    var lastCard = cards[cards.length - 1];
    var firstRect = firstCard.getBoundingClientRect();
    var lastRect = lastCard.getBoundingClientRect();
    var trackTop = Math.max(74, firstRect.top);
    var trackBottom = Math.min(window.innerHeight - 24, lastRect.bottom);
    var trackHeight = Math.max(58, trackBottom - trackTop);
    track.style.top = trackTop + 'px';
    track.style.height = trackHeight + 'px';
    track.hidden = false;

    var contentStart = firstRect.top + window.scrollY;
    var contentEnd = lastRect.bottom + window.scrollY;
    var contentHeight = Math.max(1, contentEnd - contentStart);
    var viewportHeight = Math.max(1, window.innerHeight - 24);
    if (contentHeight <= viewportHeight + 80) { thumb.style.height = '0px'; thumb.style.transform = 'translateY(0px)'; track.hidden = true; return; }

    var thumbHeight = Math.max(48, Math.min(trackHeight - 8, trackHeight * viewportHeight / contentHeight));
    var scrollRange = Math.max(1, contentHeight - viewportHeight);
    var thumbTop = Math.max(0, Math.min(trackHeight - thumbHeight, ((window.scrollY - contentStart + 24) / scrollRange) * (trackHeight - thumbHeight)));
    thumb.style.height = thumbHeight + 'px';
    thumb.style.transform = 'translateY(' + thumbTop + 'px)';
    track.setAttribute('aria-valuenow', String(Math.round(((window.scrollY - contentStart + 24) / scrollRange) * 100)));
  }

  function setupCustomScrollbar() {
    var track = $('customScrollbar'), thumb = $('customScrollbarThumb');
    if (!track || !thumb) return;
    var dragging = false, startY = 0, startTop = 0;
    thumb.addEventListener('pointerdown', function (event) {
      dragging = true; startY = event.clientY; startTop = thumb.getBoundingClientRect().top - track.getBoundingClientRect().top;
      thumb.setPointerCapture(event.pointerId); event.preventDefault();
    });
    thumb.addEventListener('pointermove', function (event) {
      if (!dragging) return;
      var trackHeight = track.offsetHeight, thumbHeight = thumb.offsetHeight, maxThumbTop = Math.max(0, trackHeight - thumbHeight), nextTop = Math.max(0, Math.min(maxThumbTop, startTop + event.clientY - startY));
      var cards = Array.from(document.querySelectorAll('.product-card'));
      if (!cards.length) return;
      var firstCard = cards[0];
      var lastCard = cards[cards.length - 1];
      var contentStart = firstCard.getBoundingClientRect().top + window.scrollY;
      var contentEnd = lastCard.getBoundingClientRect().bottom + window.scrollY;
      var contentHeight = Math.max(1, contentEnd - contentStart);
      var viewportHeight = Math.max(1, window.innerHeight - 24);
      var scrollRange = Math.max(1, contentHeight - viewportHeight);
      window.scrollTo(0, Math.max(0, contentStart + (nextTop / maxThumbTop) * scrollRange - 24));
    });
    thumb.addEventListener('pointerup', function () { dragging = false; });
    thumb.addEventListener('pointercancel', function () { dragging = false; });
    track.addEventListener('pointerdown', function (event) {
      if (event.target === thumb) return;
      var rect = track.getBoundingClientRect(), target = Math.max(0, Math.min(track.offsetHeight, event.clientY - rect.top)), cards = Array.from(document.querySelectorAll('.product-card'));
      if (!cards.length) return;
      var firstCard = cards[0];
      var lastCard = cards[cards.length - 1];
      var contentStart = firstCard.getBoundingClientRect().top + window.scrollY;
      var contentEnd = lastCard.getBoundingClientRect().bottom + window.scrollY;
      var contentHeight = Math.max(1, contentEnd - contentStart);
      var viewportHeight = Math.max(1, window.innerHeight - 24);
      var scrollRange = Math.max(1, contentHeight - viewportHeight);
      window.scrollTo({ top: Math.max(0, contentStart + (target / track.offsetHeight) * scrollRange - 24), behavior: 'smooth' });
    });
  }

  function openModal(id) { $(id).hidden = false; document.body.style.overflow = 'hidden'; }
  function closeModal(id) {
    var modal = $(id);
    if (modal) modal.hidden = true;
    var anyOpen = Array.prototype.some.call(document.querySelectorAll('.modal-backdrop'), function (entry) { return !entry.hidden; });
    if (!anyOpen) document.body.style.overflow = '';
    if (id === 'debtCustomerModal' && pendingCreditCustomerReturn) {
      pendingCreditCustomerReturn = false;
      renderCreditCustomerList();
      setTimeout(function () { openModal('creditCustomerModal'); }, 0);
    }
  }

  function mechanicPrice(item) {
    var value = number(item.mechanicPrice);
    return value !== null && value >= 0 ? value : (number(item.salePrice) || 0);
  }

  function compareArabic(a, b) {
    return String(a.name || '').localeCompare(String(b.name || ''), 'ar', { sensitivity: 'variant', usage: 'sort' });
  }

  function compareInventoryItems(a, b) {
    if (inventorySort === 'purchase') return (number(b.purchasePrice) || 0) - (number(a.purchasePrice) || 0) || compareArabic(a, b);
    if (inventorySort === 'sale') return (number(b.salePrice) || 0) - (number(a.salePrice) || 0) || compareArabic(a, b);
    if (inventorySort === 'quantity') return (number(b.quantity) || 0) - (number(a.quantity) || 0) || compareArabic(a, b);
    return compareArabic(a, b);
  }

  function getVisibleProductList() {
    var source = items.slice();
    if (!showEndedProducts) return source.filter(function (item) { return (number(item.quantity) || 0) > 0; });
    if (productFilterMode === 'all') return source;
    if (productFilterMode === 'ended') return source.filter(function (item) { return (number(item.quantity) || 0) <= 0; });
    return source.filter(function (item) { return (number(item.quantity) || 0) > 0; });
  }

  function filterAndSortProducts(term) {
    var searchTerm = String(term || '').trim();
    var source = getVisibleProductList();
    if (!searchTerm) return source.sort(compareInventoryItems);
    var filtered = source.filter(function (item) { return String(item.name || '').includes(searchTerm); });
    filtered.forEach(function (item) {
      item._searchPriority = 3;
      if (String(item.name || '').startsWith(searchTerm)) item._searchPriority = 1;
      else if (String(item.name || '').split(/\s+/).some(function (word) { return word.startsWith(searchTerm); })) item._searchPriority = 2;
    });
    filtered.sort(function (a, b) { return a._searchPriority - b._searchPriority || compareInventoryItems(a, b); });
    filtered.forEach(function (item) { delete item._searchPriority; });
    return filtered;
  }

  function renderProductTabs() {
    var tabs = $('productTabs');
    if (!tabs) return;
    tabs.hidden = !showEndedProducts;
    if (!showEndedProducts) return;
    Array.from(tabs.querySelectorAll('.product-tab')).forEach(function (button) {
      var active = button.dataset.productTab === productFilterMode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function renderProducts() {
    renderProductTabs();
    var searchTerm = String($('productSearch').value || '').trim();
    var visible = filterAndSortProducts(searchTerm);
    $('productCount').textContent = visible.length + ' منتج';
    $('productsEmpty').hidden = visible.length !== 0;
    $('productsEmpty').textContent = searchTerm ? 'لا توجد منتجات متاحة مطابقة للبحث' : 'لا توجد منتجات متاحة';
    var visibleIds = new Set(visible.map(function (item) { return item.id; }));
    productElements.forEach(function (element, id) { if (!visibleIds.has(id)) element.remove(); });
    visible.forEach(function (item) {
      var stock = number(item.quantity) || 0, signature = JSON.stringify([item.name, stock, item.salePrice, mechanicPrice(item), currency.baseCurrency, currency.showProductPrices, currency.CurrencySymbol, currency.rate, item.location, Array.isArray(item.images) ? item.images.map(function (img) { return img && img.url ? img.url : ''; }).join('|') : '']);
      var element = productElements.get(item.id);
      if (!element) { element = document.createElement('article'); element.className = 'product-card'; element.dataset.productId = item.id; productElements.set(item.id, element); }
      var isEnded = stock <= 0;
      element.classList.toggle('is-ended', isEnded);
      if (element.dataset.signature !== signature) {
        var productImages = Array.isArray(item.images) ? item.images.filter(function (img) { return img && typeof img.url === 'string' && img.url.trim(); }) : [];
        var primaryImage = productImages.find(function (img) { return img.isPrimary; }) || productImages[0] || null;
        var locationText = item.location && String(item.location).trim() ? 'موقع: ' + esc(item.location) : 'موقع: غير محدد';
        element.dataset.signature = signature;
        element.innerHTML =
        (primaryImage ? '<button class="product-thumb" type="button" data-image-view="' + esc(item.id) + '" aria-label="عرض صورة المنتج"><img src="' + esc(primaryImage.url) + '" alt="' + esc(item.name || 'صورة المنتج') + '"></button>' : '<div class="product-thumb placeholder" aria-hidden="true"><span>XM</span></div>') +
        '<h2 class="product-name">' + esc(item.name || 'منتج') + '</h2>' +
        '<p class="stock"><span><span class="stock-label"><i class="fas fa-cubes"></i></span> <strong>' + money(stock) + '</strong></span><span class="stock-divider">|</span><span><span class="location-label"><i class="fas fa-map-marker-alt"></i></span> ' + esc(item.location && String(item.location).trim() ? item.location : 'غير محدد') + '</span></p>' +
        '<div class="prices">' +
        (function () { var saleDisplay = productCurrencyDisplay(item.salePrice), mechanicDisplay = productCurrencyDisplay(mechanicPrice(item)); return '<button class="price-line price-action base-price" type="button" data-sell-item="' + esc(item.id) + '" data-sell-price="' + esc(item.salePrice) + '" data-sell-mode="base" ' + (stock <= 0 ? 'disabled' : '') + '><span>زبون</span><strong>' + money(saleDisplay.primaryValue) + ' ' + esc(saleDisplay.primarySymbol) + '</strong>' + (saleDisplay.showSecondary ? '<small>≈ ' + money(saleDisplay.Value) + ' ' + esc(saleDisplay.Symbol) + '</small>' : '') + '</button>' + '<button class="price-line price-action mechanic-price" type="button" data-sell-item="' + esc(item.id) + '" data-sell-price="' + esc(mechanicPrice(item)) + '" data-sell-mode="mechanic" ' + (stock <= 0 ? 'disabled' : '') + '><span>ميكانيكي</span><strong>' + money(mechanicDisplay.primaryValue) + ' ' + esc(mechanicDisplay.primarySymbol) + '</strong>' + (mechanicDisplay.showSecondary ? '<small>≈ ' + money(mechanicDisplay.Value) + ' ' + esc(mechanicDisplay.Symbol) + '</small>' : '') + '</button>'; })() +
        '</div>';
      }
      $('productsGrid').appendChild(element);
    });
  }

  function scrollToProductsTop() {
    requestAnimationFrame(function () {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  function resetSaleForm() {
    $('saleForm').reset(); $('saleError').textContent = ''; $('priceWarning').hidden = true; unusualPriceApproved = false; salePriceManuallyEdited = false;
    $('salePaymentMethod').value = 'cash'; $('saleSelectedCustomerId').value = '';
    $('cashSaleButton').textContent = 'بيع كاش'; $('cashSaleButton').hidden = false; $('creditSaleButton').hidden = false;
    $('saleQuantity').value = 1;
    updateSalePriceGuide();
  }

  function updateQuickQuantityState() {
    var quantity = number($('saleQuantity').value);
    document.querySelectorAll('[data-quick-quantity]').forEach(function (button) {
      var buttonValue = Number(button.dataset.quickQuantity);
      button.classList.toggle('selected', quantity !== null && Math.abs(quantity - buttonValue) < 0.0001);
    });
  }

  function updateQuickQuantityButtons() {
    var currentStock = selectedItem ? Number(selectedItem.quantity) || 0 : 0;
    var editLimit = editingSale && helpers.getSaleEditQuantityLimit ? helpers.getSaleEditQuantityLimit(selectedItem, editingSale) : currentStock;
    var availableForEdit = Math.max(0, editingSale ? editLimit : currentStock);
    var maxQuick = Math.min(10, availableForEdit || 0);
    document.querySelectorAll('[data-quick-quantity]').forEach(function (button) {
      var buttonValue = Number(button.dataset.quickQuantity);
      var visible = Number.isFinite(buttonValue) && buttonValue > 0 && buttonValue <= maxQuick;
      button.hidden = !visible;
      button.disabled = !visible;
      button.title = visible ? 'بيع بسرعة ' + buttonValue : 'غير متاح في المخزون الحالي';
      button.setAttribute('aria-disabled', visible ? 'false' : 'true');
      if (!visible) button.classList.remove('selected');
    });
  }

  function updateAvailableStock(item) {
    var available = item ? number(item.quantity) : null;
    $('availableStock').textContent = available === null ? '' : 'المتوفر في المخزون: ' + money(available);
    updateQuickQuantityButtons();
  }

  function updateQuantityWarning() {
    var quantity = number($('saleQuantity').value);
    var available = selectedItem ? number(selectedItem.quantity) : null;
    if (editingSale && available !== null) available += number(editingSale.quantity) || 0;
    var warning = $('quantityWarning');
    if (!warning || quantity === null || available === null || quantity <= available) {
      if (warning) { warning.hidden = true; warning.textContent = ''; }
      return;
    }
    warning.textContent = 'الكمية المطلوبة أكبر من المتوفر في المخزون (' + money(available) + ').';
    warning.hidden = false;
  }

  function updateSalePriceGuide(forceAutomatic) {
    var quantity = number($('saleQuantity').value) || 0;
    if (!salePriceManuallyEdited && selectedItem && quantity > 0) {
      var defaultPrice = saleDefaultPrice === null ? activeAmountFromPrimary(selectedItem.salePrice) : saleDefaultPrice;
      $('salePrice').value = Number((defaultPrice * quantity).toFixed(2));
    }
    var total = number($('salePrice').value) || 0;
    var unitPrice = saleDefaultPrice === null ? activeAmountFromPrimary((selectedItem && Number(selectedItem.salePrice)) || 0) : saleDefaultPrice;
    var unit = quantity > 0 ? unitPrice : 0;
    $('saleUnitPrice').value = money(unit) + ' ' + activeSymbol();
    $('calculatedTotal').textContent = 'الإجمالي: ' + money(total) + ' ' + activeSymbol();
    updateQuickQuantityState();
    updateQuantityWarning();
  }

  function getPriceWarning(unitPricePrimary, item) {
    var lowReference = mechanicPrice(item), highReference = Number(item.salePrice) || 0;
    if (unitPricePrimary < lowReference && lowReference > 0) {
      var lowPercent = ((lowReference - unitPricePrimary) / lowReference) * 100;
      if (lowPercent > 15) return { level: 'danger', percent: lowPercent, direction: 'أقل', type: 'mechanic', reference: lowReference };
    }
    if (unitPricePrimary > highReference && highReference > 0) {
      var highPercent = ((unitPricePrimary - highReference) / highReference) * 100;
      if (highPercent > 15) return { level: 'warning', percent: highPercent, direction: 'أعلى', type: 'sale', reference: highReference };
    }
    return { level: 'none', percent: 0, type: 'sale', reference: highReference };
  }

  function warningText(info) {
    var referenceName = info.type === 'mechanic' ? 'سعر الميكانيكي' : 'سعر الزبون';
    var referenceDisplay = getDisplayMoney(info.reference, info.referenceCurrency || 'primary', currency);
    return (info.level === 'danger' ? '⚠ ' : 'ⓘ ') + 'سعر القطعة المحسوب ' + info.direction + ' من ' + referenceName + ' بنسبة ' + money(info.percent) + '%.' + ' السعر المرجعي: ' + money(referenceDisplay.value) + ' ' + referenceDisplay.symbol;
  }

  function upsertSaleLocally(sale) {
    if (!sale || !sale.saleId) return;
    var saleKey = helpers.normalizeIdValue ? helpers.normalizeIdValue(sale.saleId || sale.id || '') : String(sale.saleId || sale.id || '').trim();
    if (!saleKey) return;
    var index = sales.findIndex(function (entry) { return String(entry && (entry.saleId || entry.id || '')) === saleKey; });
    if (index === -1) sales.push(sale);
    else sales[index] = Object.assign({}, sales[index], sale);
    sales = helpers.uniqueRecordsById ? helpers.uniqueRecordsById(sales, ['saleId', 'id']) : uniqueSales(sales);
  }

  function upsertDebtOperationLocally(operation) {
    if (!operation || typeof operation !== 'object') return;
    var operationKey = helpers.getRecordKey ? helpers.getRecordKey(operation, ['id', 'debtOperationId', 'operationId']) : String(operation.id || operation.debtOperationId || operation.operationId || '').trim();
    if (!operationKey) return;
    var index = debtOperations.findIndex(function (entry) { return String(entry && (entry.id || entry.debtOperationId || entry.operationId || '')) === operationKey; });
    if (index === -1) debtOperations.unshift(operation);
    else debtOperations[index] = Object.assign({}, debtOperations[index], operation);
    debtOperations = helpers.uniqueRecordsById ? helpers.uniqueRecordsById(debtOperations, ['id', 'debtOperationId', 'operationId']) : debtOperations.filter(function (entry, idx, arr) { return arr.findIndex(function (candidate) { return String(candidate && (candidate.id || candidate.debtOperationId || candidate.operationId || '')) === String(entry && (entry.id || entry.debtOperationId || entry.operationId || '')); }) === idx; });
    renderDebtList();
  }

  function makeMobileSaleId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return 'sale_' + window.crypto.randomUUID();
    return 'sale_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
  }

  function uniqueSales(list) {
    return helpers.uniqueRecordsById ? helpers.uniqueRecordsById(list, ['saleId', 'id']) : (() => {
      var byId = new Map();
      (Array.isArray(list) ? list : []).forEach(function (sale) { if (sale && sale.saleId) byId.set(sale.saleId, sale); });
      return Array.from(byId.values());
    })();
  }

  function sanitizeFirestoreData(value) {
    if (Array.isArray(value)) return value.map(sanitizeFirestoreData);
    if (value && typeof value === 'object') {
      var cleaned = {};
      Object.keys(value).forEach(function (key) {
        if (value[key] !== undefined) cleaned[key] = sanitizeFirestoreData(value[key]);
      });
      return cleaned;
    }
    return value;
  }

  function showPriceWarning(info) {
    var box = $('priceWarning');
    box.classList.toggle('warning', info.level === 'warning'); box.classList.toggle('danger', info.level === 'danger');
    $('priceWarningTitle').textContent = info.level === 'danger' ? '⚠ تنبيه خطر السعر' : 'ⓘ مراجعة السعر';
    $('priceWarningText').textContent = warningText(info);
    $('backFromWarning').hidden = false;
    $('confirmUnusualPrice').textContent = 'متابعة البيع';
    box.hidden = false;
  }

  function openNewSale(item, defaultPricePrimary, mode) {
    selectedItem = item; editingSale = null; var selectedPrice = number(defaultPricePrimary); saleDefaultPrice = activeAmountFromPrimary(selectedPrice === null ? item.salePrice : selectedPrice); resetSaleForm();
    $('saleModal').classList.remove('sale-edit-mode');
    $('saleModal').classList.toggle('base-price-mode', mode === 'base');
    $('saleModal').classList.toggle('mechanic-price-mode', mode === 'mechanic');
    $('saleModalTitle').textContent = mode === 'mechanic' ? 'بيع منتج وفق سعر الميكانيكي' : 'بيع منتج وفق سعر الزبون'; $('saleProductName').textContent = item.name || 'منتج';
    updateAvailableStock(item);
    $('saleQuantity').max = Number(item.quantity) || 0;
    $('saleModeLabel').textContent = '(' + activeSymbol() + ')';
    $('salePaymentMethod').value = 'cash';
    $('saleSelectedCustomerId').value = '';
    updateSalePriceGuide();
    openModal('saleModal');
  }

  function openEditSale(sale) {
    var item = items.find(function (entry) { return entry.id === sale.itemId; });
    if (!item) return notify('المنتج غير موجود');
    selectedItem = item; editingSale = sale; saleDefaultPrice = sale.saleMode === '' ? (Number(sale.unitPrice) || 0) : (Number(sale.unitPrice) || 0); resetSaleForm();
    $('saleModal').classList.remove('base-price-mode', 'mechanic-price-mode');
    $('saleModal').classList.add('sale-edit-mode');
    $('saleModalTitle').textContent = 'تعديل البيع'; $('saleProductName').textContent = sale.itemName || item.name || 'منتج';
    updateAvailableStock(item);
    $('saleQuantity').value = sale.quantity; $('saleQuantity').max = helpers.getSaleEditQuantityLimit ? helpers.getSaleEditQuantityLimit(item, sale) : (Number(item.quantity) || 0) + (Number(sale.quantity) || 0);
    $('salePrice').value = Number((saleDefaultPrice * (Number(sale.quantity) || 0)).toFixed(2));
    salePriceManuallyEdited = false;
    $('saleModeLabel').textContent = '(' + (sale.saleMode === '' ? currency.CurrencySymbol : '$') + ')';
    $('salePaymentMethod').value = sale.paymentMethod || 'cash';
    $('saleSelectedCustomerId').value = sale.customerId || '';
    $('cashSaleButton').textContent = 'حفظ التعديل';
    $('creditSaleButton').hidden = true;
    updateSalePriceGuide();
    openModal('saleModal');
  }

  function getDebtCustomerOperations(customerId) {
    return debtOperations.filter(function (op) {
      if (!op || String(op.customerId) !== String(customerId)) return false;
      return op.status !== 'cancelled';
    }).sort(function (a, b) { return getOperationDateValue(b) - getOperationDateValue(a); });
  }

  async function refreshDebtCustomerSnapshot(customerId) {
    if (!customerId || !db || !db.collection) return;
    var customerIdText = String(customerId).trim();
    if (!customerIdText) return;
    try {
      var customerSnap = await db.collection('debtCustomers').doc(customerIdText).get();
      if (customerSnap && customerSnap.exists) {
        var freshCustomer = Object.assign({ id: customerSnap.id }, customerSnap.data());
        debtCustomers = debtCustomers.filter(function (entry) { return String(entry.id) !== customerIdText; });
        debtCustomers.push(freshCustomer);
      }

      var operationSnap = await db.collection('debtOperations').where('customerId', '==', customerIdText).get();
      var refreshedCustomerOps = [];
      if (operationSnap && operationSnap.docs) {
        operationSnap.docs.forEach(function (doc) {
          refreshedCustomerOps.push(Object.assign({ id: doc.id }, doc.data()));
        });
      }
      debtOperations = debtOperations.filter(function (entry) {
        return String(entry.customerId || '') !== customerIdText;
      }).concat(refreshedCustomerOps);
      debtOperations = (helpers.uniqueRecordsById ? helpers.uniqueRecordsById(debtOperations, ['id', 'debtOperationId', 'operationId']) : debtOperations).sort(function (a, b) { return getOperationDateValue(b) - getOperationDateValue(a); });
    } catch (error) {
      console.warn('Unable to refresh customer debt snapshot from Firestore', error);
    }
  }

  function isSaleHiddenFromHistory(sale) {
    if (!sale || typeof sale !== 'object') return false;
    var status = String(sale.status || sale.saleStatus || '').trim().toLowerCase();
    return Boolean(sale.cancelled || sale.isCancelled || sale.refunded || sale.isRefunded || status === 'cancelled' || status === 'cancelled_sale' || status === 'refunded' || status === 'returned' || status === 'partially_refunded' || status === 'partially_returned');
  }

  function summarizePaymentAllocation(entry) {
    var allocations = Array.isArray(entry && entry.allocations) ? entry.allocations : [];
    var refundedAmount = 0;
    var activeAmount = 0;
    var totalAmount = Number(entry && entry.amount) || 0;
    if (!allocations.length) {
      return { refundedAmount: 0, activeAmount: totalAmount, refundedPercent: 0, activePercent: totalAmount > 0 ? 100 : 0, hasSplit: false, totalAmount: totalAmount };
    }
    allocations.forEach(function (allocation) {
      var amount = Number(allocation && allocation.amount) || 0;
      var status = String(allocation && allocation.status || 'active').trim().toLowerCase();
      var refundedShare = 0;
      if (status === 'refunded' || status === 'returned' || status === 'cancelled') {
        refundedShare = amount;
      } else if (status === 'partially_refunded' || status === 'partially_returned') {
        refundedShare = Math.min(amount, Number(allocation.refundedAmount || allocation.refundAmount || 0) || 0);
      }
      refundedAmount += refundedShare;
      activeAmount += Math.max(0, amount - refundedShare);
    });
    if (totalAmount <= 0) totalAmount = refundedAmount + activeAmount;
    var refundedPercent = totalAmount > 0 ? (refundedAmount / totalAmount) * 100 : 0;
    var activePercent = totalAmount > 0 ? (activeAmount / totalAmount) * 100 : 0;
    return { refundedAmount: refundedAmount, activeAmount: activeAmount, refundedPercent: refundedPercent, activePercent: activePercent, hasSplit: refundedAmount > 0 && activeAmount > 0, totalAmount: totalAmount };
  }

  function getDebtOperationPaymentProgress(entry, paymentEntries) {
    if (!entry || String(entry.type || '').trim().toLowerCase() !== 'debt') {
      return { paidAmount: 0, percent: 0, isPaid: false };
    }
    var debtAmount = Number(entry.amount) || 0;
    if (debtAmount <= 0) {
      return { paidAmount: 0, percent: 0, isPaid: false };
    }
    var debtId = String(entry.id || entry.debtOperationId || entry.operationId || '').trim();
    var saleId = String(entry.saleId || entry.relatedSaleId || entry.linkedSaleId || entry.objectId || entry.debtSaleId || '').trim();
    var paymentList = Array.isArray(paymentEntries) ? paymentEntries : [];
    var paidAmount = 0;
    paymentList.forEach(function (payment) {
      var type = String(payment && payment.type || '').trim().toLowerCase();
      if (!payment || (type !== 'payment' && type !== 'settle')) return;
      var paymentStatus = String(payment.status || '').trim().toLowerCase();
      if (paymentStatus === 'cancelled' || paymentStatus === 'deleted') return;
      var paymentAllocations = Array.isArray(payment.allocations) ? payment.allocations : [];
      if (paymentAllocations.length) {
        paymentAllocations.forEach(function (allocation) {
          if (!allocation) return;
          var allocationSaleId = String(allocation.saleId || allocation.relatedSaleId || allocation.linkedSaleId || allocation.debtOperationId || allocation.operationId || '').trim();
          var allocationDebtId = String(allocation.debtOperationId || allocation.linkedDebtOperationId || allocation.relatedDebtOperationId || '').trim();
          var matchesDebt = Boolean((debtId && (allocationDebtId === debtId || String(allocation.debtOperationId || '').trim() === debtId)) || (saleId && allocationSaleId === saleId) || (!saleId && debtId && String(allocation.debtOperationId || allocation.linkedDebtOperationId || allocation.relatedDebtOperationId || '').trim() === debtId));
          if (!matchesDebt) return;
          var status = String(allocation.status || payment.status || 'active').trim().toLowerCase();
          var allocationAmount = Number(allocation.amount) || 0;
          if (status === 'refunded' || status === 'returned' || status === 'cancelled') return;
          if (status === 'partially_refunded' || status === 'partially_returned') {
            allocationAmount = Math.max(0, allocationAmount - (Number(allocation.refundedAmount || allocation.refundAmount || 0) || 0));
          }
          paidAmount += allocationAmount;
        });
        return;
      }
      if (!saleId) return;
      if (String(payment.saleId || payment.relatedSaleId || payment.linkedSaleId || '') === saleId) {
        paidAmount += Number(payment.amount) || 0;
      }
    });
    var percent = debtAmount > 0 ? Math.min(100, (paidAmount / debtAmount) * 100) : 0;
    return { paidAmount: paidAmount, percent: percent, isPaid: percent >= 100 };
  }

  function getCustomerBalance(customerId) {
    if (helpers.getCustomerDebtBalance) {
      return helpers.getCustomerDebtBalance(customerId, sales, debtOperations);
    }
    var total = 0;
    getDebtCustomerOperations(customerId).forEach(function (op) {
      if (op.type === 'debt') total += Number(op.amount) || 0;
      if (op.type === 'payment' || op.type === 'settle') total -= Number(op.amount) || 0;
    });
    return total;
  }

  function getDebtCustomerSummary(customerId) {
    var operations = getDebtCustomerOperations(customerId);
    var balance = getCustomerBalance(customerId);
    var lastDebt = operations.filter(function (op) { return op.type === 'debt'; }).sort(function (a, b) { return getOperationDateValue(b) - getOperationDateValue(a); })[0] || null;
    var lastPayment = operations.filter(function (op) { return op.type === 'payment' || op.type === 'settle'; }).sort(function (a, b) { return getOperationDateValue(b) - getOperationDateValue(a); })[0] || null;
    var status = 'new';
    if (operations.length) {
      if (balance <= 0) status = 'settled';
      else if (lastPayment && Date.now() - (Number(lastPayment.timestamp) || Date.now()) > 30 * 24 * 60 * 60 * 1000) status = 'late';
      else status = 'active';
    }
    return {
      balance: balance,
      totalDebt: operations.filter(function (op) { return op.type === 'debt'; }).reduce(function (sum, op) { return sum + (Number(op.amount) || 0); }, 0),
      totalPayment: operations.filter(function (op) { return op.type === 'payment' || op.type === 'settle'; }).reduce(function (sum, op) { return sum + (Number(op.amount) || 0); }, 0),
      lastDebt: lastDebt,
      lastPayment: lastPayment,
      status: status,
      statusLabel: status === 'settled' ? 'مسدد' : status === 'late' ? 'متأخر' : status === 'active' ? 'نشط' : 'جديد'
    };
  }

  function renderDebtList() {
    var list = $('debtsList');
    if (!list) return;
    if (!debtCustomers.length) {
      list.innerHTML = '<div class="empty-state">لا يوجد عملاء مسجلين حتى الآن</div>';
      renderDebtPageList();
      return;
    }
    list.innerHTML = debtCustomers.map(function (customer) {
      var balance = getCustomerBalance(customer.id);
      var history = getDebtCustomerOperations(customer.id).slice(0, 5);
      var historyMarkup = history.length ? history.map(function (entry) {
        var label = entry.type === 'debt' ? 'دين' : entry.type === 'payment' ? 'سداد' : 'تسوية';
        var sign = entry.type === 'payment' ? '-' : '+';
        var display = getActiveCurrencyDisplay(Number(entry.amount) || 0, entry.currency || 'primary');
        return '<div class="debt-history-item ' + entry.type + '"><span>' + esc(label) + ' • ' + esc(entry.note || 'بدون ملاحظة') + '</span><strong>' + sign + ' ' + esc(money(display.value)) + ' ' + esc(display.symbol) + '</strong></div>';
      }).join('') : '<div class="debt-history-item debt"><span>لا توجد حركات مالية</span><strong>0</strong></div>';
      var isZeroBalance = balance <= 0;
      var displayBalance = formatDisplayMoney(Math.abs(balance), 'primary');
      return '<article class="debt-customer-card"><div class="debt-customer-head"><div><strong>' + esc(customer.name || 'عميل') + '</strong><div class="debt-customer-meta">' + esc(customer.phone || 'بدون هاتف') + '</div></div><div class="debt-balance ' + (balance > 0 ? 'due' : 'paid') + '">' + (balance > 0 ? 'مستحق: ' : 'مدفوع: ') + esc(displayBalance) + '</div></div><div class="debt-history">' + historyMarkup + '</div><div class="debt-action-row"><button type="button" class="positive-action" data-debt-action="debt" data-debt-customer-id="' + esc(customer.id) + '">إضافة دين</button><button type="button" data-debt-action="payment" data-debt-customer-id="' + esc(customer.id) + '" ' + (isZeroBalance ? 'disabled aria-disabled="true"' : '') + '>سداد</button><button type="button" class="danger-action" data-debt-action="settle" data-debt-customer-id="' + esc(customer.id) + '" ' + (isZeroBalance ? 'disabled aria-disabled="true"' : '') + '>سداد كامل</button></div></article>';
    }).join('');
    renderDebtPageList();
  }

  function formatShortDate(timestamp) {
    var value = timestampValue(timestamp) || Date.now();
    return new Intl.DateTimeFormat('en-GB', { timeZone: GMT3_TIME_ZONE, day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(value)).replace(/\//g, '-');
  }

  function getOperationDateValue(entry) {
    if (!entry || typeof entry !== 'object') return 0;
    var timestampMs = timestampValue(entry.timestamp);
    if (Number.isFinite(timestampMs) && timestampMs > 0) return timestampMs;
    var directDate = entry.operationDate || entry.operation_date || entry.dateKey || entry.date || entry.operationDateKey || '';
    if (typeof directDate === 'string' && directDate.trim()) {
      var trimmed = directDate.trim();
      var isoCandidate = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed + 'T12:00:00+03:00' : trimmed;
      var parsed = Date.parse(isoCandidate);
      if (Number.isFinite(parsed)) return parsed;
    }
    return 0;
  }

  function normalizeDebtNoteText(noteText) {
    var text = String(noteText == null ? '' : noteText).trim();
    if (!text) return 'بدون ملاحظات';
    if (/^بيع\s*آجل\s*-\s*/i.test(text)) return text.replace(/^بيع\s*آجل\s*-\s*/i, '').trim();
    return text;
  }

  function renderDebtPageList() {
    var list = $('debtPageList');
    if (!list) return;
    var totalDue = debtCustomers.reduce(function (sum, customer) {
      return sum + Math.max(0, Number(getCustomerBalance(customer.id)) || 0);
    }, 0);
    var totalDueElement = $('debtTotalDue');
    if (totalDueElement) totalDueElement.querySelector('strong').textContent = formatDisplayMoney(totalDue, 'primary');
    var searchInput = $('debtCustomerSearch');
    var query = searchInput ? String(searchInput.value || '').trim().toLowerCase() : '';
    var filteredCustomers = debtCustomers.filter(function (customer) {
      if (!query) return true;
      return String(customer.name || '').toLowerCase().indexOf(query) !== -1;
    });
    if (!filteredCustomers.length) {
      list.innerHTML = '<div class="empty-state">لا يوجد عملاء مطابقون للبحث</div>';
      return;
    }
    var summaries = new Map(filteredCustomers.map(function (customer) { return [String(customer.id), getDebtCustomerSummary(customer.id)]; }));
    var paymentOperationCounts = debtCustomers.map(function (customer) {
      return getDebtCustomerOperations(customer.id).filter(function (operation) { return operation.type === 'payment' || operation.type === 'settle'; }).length;
    });
    var maxPaymentOperations = Math.max.apply(Math, paymentOperationCounts.concat([0]));
    filteredCustomers.sort(function (a, b) {
      var aSummary = summaries.get(String(a.id));
      var bSummary = summaries.get(String(b.id));
      var aValue = debtTableSort.key === 'name' ? String(a.name || '') : debtTableSort.key === 'phone' ? String(a.phone || '') : debtTableSort.key === 'balance' ? Number(aSummary.balance) || 0 : debtTableSort.key === 'totalPayment' ? Number(aSummary.totalPayment) || 0 : debtTableSort.key === 'lastDebt' ? getOperationDateValue(aSummary.lastDebt) : debtTableSort.key === 'lastPayment' ? getOperationDateValue(aSummary.lastPayment) : debtTableSort.key === 'status' ? String(aSummary.statusLabel || '') : getDebtCustomerOperations(a.id).length;
      var bValue = debtTableSort.key === 'name' ? String(b.name || '') : debtTableSort.key === 'phone' ? String(b.phone || '') : debtTableSort.key === 'balance' ? Number(bSummary.balance) || 0 : debtTableSort.key === 'totalPayment' ? Number(bSummary.totalPayment) || 0 : debtTableSort.key === 'lastDebt' ? getOperationDateValue(bSummary.lastDebt) : debtTableSort.key === 'lastPayment' ? getOperationDateValue(bSummary.lastPayment) : debtTableSort.key === 'status' ? String(bSummary.statusLabel || '') : getDebtCustomerOperations(b.id).length;
      var comparison = typeof aValue === 'string' ? aValue.localeCompare(bValue, 'ar', { sensitivity: 'variant' }) : aValue - bValue;
      return comparison * debtTableSort.direction || compareArabic(a, b);
    });
    var rows = filteredCustomers.map(function (customer, index) {
      var summary = summaries.get(String(customer.id));
      var statusClass = summary.status === 'settled' ? 'debt-status-settled' : summary.status === 'late' ? 'debt-status-late' : summary.status === 'active' ? 'debt-status-active' : 'debt-status-new';
      var lastDebtDate = summary.lastDebt ? formatShortDate(getOperationDateValue(summary.lastDebt)) : '-';
      var lastPaymentDate = summary.lastPayment ? formatShortDate(getOperationDateValue(summary.lastPayment)) : '-';
      var paymentCount = getDebtCustomerOperations(customer.id).filter(function (operation) { return operation.type === 'payment' || operation.type === 'settle'; }).length;
      var rowClass = summary.status === 'late' ? ' debt-customer-row-late' : paymentCount > 0 && paymentCount === maxPaymentOperations ? ' debt-customer-row-top-payer' : '';
      var balanceDisplay = getActiveCurrencyDisplay(Math.abs(summary.balance), 'primary');
      var paymentDisplay = getActiveCurrencyDisplay(summary.totalPayment, 'primary');
      return '<tr class="' + rowClass.trim() + '" tabindex="0" data-debt-customer-id="' + esc(customer.id) + '"><td>' + esc(index + 1) + '</td><td class="debt-customer-row-name">' + esc(customer.name || 'عميل') + '</td><td class="debt-amount ' + (summary.balance > 0 ? 'due' : 'paid') + '">' + esc(money(balanceDisplay.value) + ' ' + balanceDisplay.symbol) + '</td><td class="debt-amount paid">' + esc(money(paymentDisplay.value) + ' ' + paymentDisplay.symbol) + '</td><td>' + esc(lastDebtDate) + '</td><td>' + esc(lastPaymentDate) + '</td><td><span class="debt-status-badge ' + statusClass + '">' + esc(summary.statusLabel) + '</span></td></tr>';
    }).join('');

    var headers = [{ key: 'index', label: '#' }, { key: 'name', label: 'الاسم' }, { key: 'balance', label: 'الدين المستحق' }, { key: 'totalPayment', label: 'الدين المسدد' }, { key: 'lastDebt', label: 'آخر دين' }, { key: 'lastPayment', label: 'آخر سداد' }, { key: 'status', label: 'الحالة' }];
    var headerMarkup = headers.map(function (header) {
      var arrow = debtTableSort.key === header.key ? (debtTableSort.direction === 1 ? '↑' : '↓') : '↕';
      return '<th scope="col"><button type="button" class="debt-sort-button" data-debt-sort="' + header.key + '" aria-label="ترتيب حسب ' + header.label + '">' + header.label + ' <span aria-hidden="true">' + arrow + '</span></button></th>';
    }).join('');
    list.innerHTML = '<div class="debt-table-wrap"><table class="debt-customers-table"><thead><tr>' + headerMarkup + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function getDebtCycleGroupEntries(operations) {
    var source = Array.isArray(operations) ? operations : [];
    if (helpers.groupDebtOperationsByCycles) {
      return helpers.groupDebtOperationsByCycles(source).map(function (cycle) {
        return { entries: Array.isArray(cycle && cycle.entries) ? cycle.entries : [] };
      });
    }
    var ordered = source.slice().sort(function (a, b) { return getOperationDateValue(a) - getOperationDateValue(b); });
    var cycles = [];
    var currentCycle = null;
    var runningBalance = 0;

    ordered.forEach(function (entry) {
      var type = String(entry && entry.type || '').trim().toLowerCase();
      var actionValue = Number(entry && entry.amount) || 0;
      if (type === 'cancel' || !entry) return;
      if (!currentCycle && (type === 'payment' || type === 'settle')) {
        return;
      }
      if (!currentCycle) {
        currentCycle = { entries: [] };
        cycles.push(currentCycle);
      }
      currentCycle.entries.push(entry);
      if (type === 'debt') {
        runningBalance += actionValue;
      } else if (type === 'payment' || type === 'settle') {
        runningBalance -= actionValue;
      }
      if (runningBalance <= 0) {
        currentCycle = null;
        runningBalance = 0;
      }
    });

    return cycles.reverse();
  }

  function renderDebtCycleMarkup(operationsOrCycles) {
    var cycleGroups = Array.isArray(operationsOrCycles) && operationsOrCycles.length && Array.isArray(operationsOrCycles[0].entries)
      ? operationsOrCycles
      : getDebtCycleGroupEntries(operationsOrCycles);
    if (!cycleGroups.length) {
      return '<div class="empty-state">لا توجد عمليات لهذا العميل.</div>';
    }
    return '<div class="customer-detail-day-groups">' + cycleGroups.map(function (cycle, cycleIndex) {
      var groupedByDay = {};
      cycle.entries.forEach(function (entry) {
        var day = dayKey(getOperationDateValue(entry));
        if (!groupedByDay[day]) groupedByDay[day] = [];
        groupedByDay[day].push(entry);
      });
      var dayKeys = Object.keys(groupedByDay).sort(function (a, b) {
        return new Date(b + 'T00:00:00').getTime() - new Date(a + 'T00:00:00').getTime();
      });
      var dayMarkup = dayKeys.length ? dayKeys.map(function (day) {
        var dayEntries = groupedByDay[day].slice().sort(function (a, b) { return getOperationDateValue(b) - getOperationDateValue(a); });
        var rowsMarkup = dayEntries.map(function (entry) {
          var label = entry.type === 'debt' ? 'دين' : entry.type === 'payment' ? 'سداد' : entry.type === 'settle' ? 'تسوية' : entry.type === 'return' ? 'استرجاع' : 'إلغاء';
          var rowClass = entry.type === 'debt' ? 'debt' : entry.type === 'payment' ? 'payment' : entry.type === 'settle' ? 'settle' : entry.type === 'return' ? 'return' : 'cancel';
          var amountValue = Number(entry.amount) || 0;
          var noteText = entry.type === 'debt' ? normalizeDebtNoteText(entry.note) : String(entry.note || 'بدون ملاحظات');
          var isReturned = String(entry.status || '').toLowerCase() === 'returned';
          var saleId = entry.saleId || entry.relatedSaleId || entry.linkedSaleId || '';
          var amountCell = '<div class="amount-cell ' + (isReturned ? 'is-returned' : '') + '">' + esc(formatDisplayMoney(isReturned ? 0 : amountValue, entry.currency || 'primary')) + '</div>';
          var returnAction = entry.type === 'debt' && saleId && !isReturned ? '<button type="button" class="return-sale-button" data-return-sale="' + esc(saleId) + '">استرجاع</button>' : '';
          return '<tr class="' + rowClass + (isReturned ? ' is-returned' : '') + ' debt-operation-row" data-debt-operation-id="' + esc(entry.id) + '" title="اضغط للتعديل أو الحذف"><td>' + esc(isReturned ? 'مسترجع' : label) + '</td><td class="amount-cell-wrap">' + amountCell + '</td><td>' + esc(formatDateTime(getOperationDateValue(entry))) + '</td><td>' + esc(noteText) + returnAction + '</td></tr>';
        }).join('');
        return '<div class="customer-detail-day-group"><div class="customer-detail-day-header">' + esc(dayLabel(new Date(day + 'T00:00:00').getTime())) + '</div><table class="customer-detail-operations-table"><thead><tr><th>النوع</th><th>المبلغ</th><th>التاريخ والوقت</th><th>ملاحظات</th></tr></thead><tbody>' + rowsMarkup + '</tbody></table></div>';
      }).join('') : '<div class="empty-state">لا توجد عمليات في هذه الدورة.</div>';
      var separator = cycleIndex < cycleGroups.length - 1 ? '<div class="customer-detail-cycle-separator" aria-hidden="true"></div>' : '';
      return '<div class="customer-detail-cycle-block">' + dayMarkup + '</div>' + separator;
    }).join('') + '</div>';
  }

  async function openDebtCustomerDetail(customerId) {
    if (!customerId || !db || !db.collection) {
      return;
    }
    await refreshDebtCustomerSnapshot(customerId);
    var container = $('customerDetailContent');
    var modal = $('customerDetailModal');
    if (!container || !modal) return;
    var customer = debtCustomers.find(function (entry) { return String(entry.id) === String(customerId); });
    if (!customer) return;
    var summary = getDebtCustomerSummary(customerId);
    var allOperations = getDebtCustomerOperations(customerId).slice();
    var allCycles = getDebtCycleGroupEntries(allOperations);
    var currentBalance = getCustomerBalance(customer.id);
    var defaultVisibleCycleCount = currentBalance > 0 ? 1 : 0;
    var visibleCycleCount = Number(customerDetailCycleCounts[String(customerId)] || defaultVisibleCycleCount);
    if (!Number.isFinite(visibleCycleCount) || visibleCycleCount < defaultVisibleCycleCount) visibleCycleCount = defaultVisibleCycleCount;
    if (allCycles.length && visibleCycleCount > allCycles.length) visibleCycleCount = allCycles.length;
    customerDetailCycleCounts[String(customerId)] = visibleCycleCount;
    var visibleCycleGroups = allCycles.slice(0, visibleCycleCount);
    var operationsMarkup = renderDebtCycleMarkup(visibleCycleGroups);
    var additionalHistoryAction = allCycles.length > visibleCycleGroups.length ? '<div class="customer-detail-history-actions"><button type="button" class="primary-button" data-debt-show-more="' + esc(customer.id) + '">عرض السجلات الأقدم</button></div>' : '';
    var balance = getCustomerBalance(customer.id);
    var isZeroBalance = balance <= 0;

    var currentBalanceDisplay = getActiveCurrencyDisplay(Math.abs(summary.balance), 'primary');
    var paymentTotalDisplay = getActiveCurrencyDisplay(summary.totalPayment, 'primary');
    container.innerHTML = '<div class="customer-detail-summary"><div class="customer-detail-head"><h3>' + esc(customer.name || 'عميل') + '</h3><span class="debt-status-badge ' + (summary.status === 'settled' ? 'debt-status-settled' : summary.status === 'late' ? 'debt-status-late' : summary.status === 'active' ? 'debt-status-active' : 'debt-status-new') + '">' + esc(summary.statusLabel) + '</span></div><table class="customer-detail-summary-table"><thead><tr><th>الاسم</th><th>الهاتف</th><th>الدين الحالي</th><th>المسدد سابقاً</th><th>آخر دين</th><th>آخر سداد</th></tr></thead><tbody><tr><td>' + esc(customer.name || 'عميل') + '</td><td>' + esc(customer.phone || 'غير محدد') + '</td><td class="debt-amount ' + (summary.balance > 0 ? 'due' : 'paid') + '">' + esc(money(currentBalanceDisplay.value) + ' ' + currentBalanceDisplay.symbol) + '</td><td>' + esc(money(paymentTotalDisplay.value) + ' ' + paymentTotalDisplay.symbol) + '</td><td>' + esc(summary.lastDebt ? formatShortDate(getOperationDateValue(summary.lastDebt)) : '-') + '</td><td>' + esc(summary.lastPayment ? formatShortDate(getOperationDateValue(summary.lastPayment)) : '-') + '</td></tr></tbody></table><div class="customer-detail-notes"><span>الملاحظات</span><p>' + esc(customer.notes || 'لا توجد ملاحظات') + '</p></div></div><div class="customer-detail-actions"><button type="button" class="debt-add" data-debt-detail-action="debt" data-debt-detail-customer-id="' + esc(customer.id) + '">إضافة دين</button><button type="button" class="debt-pay" data-debt-detail-action="payment" data-debt-detail-customer-id="' + esc(customer.id) + '" ' + (isZeroBalance ? 'disabled aria-disabled="true"' : '') + '>سداد جزئي</button><button type="button" class="debt-settle" data-debt-detail-action="settle" data-debt-detail-customer-id="' + esc(customer.id) + '" ' + (isZeroBalance ? 'disabled aria-disabled="true"' : '') + '>سداد كامل</button></div><div class="customer-detail-operations"><h3>سجل العمليات</h3>' + (visibleCycleGroups.length ? operationsMarkup : '<div class="empty-state">لا توجد دورات دين لعرضها الآن.</div>') + additionalHistoryAction + '</div>';
    openModal('customerDetailModal');
  }

  function showDebtPage() {
    if (!$('appShell') || !$('debtPage')) return;
    activePage = 'debts';
    $('appShell').hidden = true;
    $('debtPage').hidden = false;
    $('employeePage').hidden = true;
    $('historyPage').hidden = true;
    $('cashboxPage').hidden = true;
    $('settingsPage').hidden = true;
    $('operationsPage').hidden = true;
    renderDebtPageList();
    updateMobileNavigation('debts');
  }

  function showProductsPage() {
    if (!$('appShell') || !$('debtPage')) return;
    activePage = 'products';
    $('debtPage').hidden = true;
    $('employeePage').hidden = true;
    $('historyPage').hidden = true;
    $('cashboxPage').hidden = true;
    $('settingsPage').hidden = true;
    $('operationsPage').hidden = true;
    $('appShell').hidden = false;
    updateMobileNavigation('home');
  }

  function updateMobileNavigation(route) {
    document.querySelectorAll('[data-mobile-route]').forEach(function (button) {
      var buttonRoute = button.dataset.mobileRoute;
      button.classList.toggle('is-active', buttonRoute === route);
    });
  }

  function showEmployeePage() {
    if (!employeeAccess || !currentEmployee) { notify('هذا الحساب غير مرتبط بموظف'); return; }
    activePage = 'employees';
    $('appShell').hidden = true; $('debtPage').hidden = true; $('employeePage').hidden = false;
    $('historyPage').hidden = true; $('cashboxPage').hidden = true; $('settingsPage').hidden = true; $('operationsPage').hidden = true;
    selectedEmployeeId = currentEmployee.id;
    renderEmployeeDetail(currentEmployee.id);
    ensureEmployeeDays().catch(function (error) { notify(error.message || 'تعذر تحديث أجور الموظفين'); });
    updateMobileNavigation('employee');
  }

  function showHistoryPage() {
    activePage = 'history';
    $('appShell').hidden = true; $('debtPage').hidden = true; $('employeePage').hidden = true;
    $('historyPage').hidden = false; $('cashboxPage').hidden = true; $('settingsPage').hidden = true; $('operationsPage').hidden = true;
    renderHistory();
    updateMobileNavigation('history');
  }

  function cashboxAmount(amount, code, rateAtTime) {
    var value = Number(amount) || 0;
    if (baseCurrency() === '') return code === '' ? value : (value);
    if (code !== '') return value;
    if (rateAtTime != null) return value / (Number(rateAtTime) || 1);
    return primary(value);
  }
  function cashboxEntry(id, type, label, amount, timestamp, code, note, rateAtTime) {
    return { id: String(id), type: type, label: label, amount: cashboxAmount(amount, code, rateAtTime), timestamp: timestampValue(timestamp), note: note || '' };
  }
  function cashboxIsCancelled(entry) {
    var status = String(entry && entry.status || '').toLowerCase();
    return Boolean(entry && (entry.cancelled || entry.isCancelled || status === 'cancelled' || status === 'refunded' || status === 'returned' || status === 'deleted'));
  }
  function buildCashboxEntries() {
    var entries = [];
    sales.filter(function (sale) { return sale && String(sale.paymentMethod || '').toLowerCase() === 'cash'; }).forEach(function (sale) {
      entries.push(cashboxEntry('sale_' + (sale.saleId || sale.id), 'sale', 'مبيعات نقدية', sale.saleMode === '' ? (sale.displayTotalAmount || sale.rawTotalAmount || sale.totalAmount) : sale.totalAmount, sale.timestamp, sale.saleMode, sale.itemName || ''));
    });
    debtOperations.filter(function (operation) { return operation && !cashboxIsCancelled(operation) && (operation.type === 'payment' || operation.type === 'settle'); }).forEach(function (operation) {
      var paymentAmount = Number(operation.amount) || 0;
      if (Array.isArray(operation.allocations) && operation.allocations.length) {
        paymentAmount = operation.allocations.reduce(function (sum, allocation) {
          var linkedSale = sales.find(function (sale) {
            return sale && String(sale.saleId || sale.id) === String(allocation.saleId || '');
          });
          var allocationCurrency = linkedSale ? (linkedSale.saleMode || linkedSale.currency || linkedSale.baseCurrency || 'primary') : (operation.currency || baseCurrency());
          var allocationRate = linkedSale ? linkedSale.rateAtTime : operation.rateAtTime;
          return sum + cashboxAmount(allocation.amount, allocationCurrency, allocationRate);
        }, 0);
        entries.push(cashboxEntry('debt_' + operation.id, 'customerPayment', 'تحصيل دين', paymentAmount, operation.timestamp, 'primary', operation.note));
        return;
      }
      entries.push(cashboxEntry('debt_' + operation.id, 'customerPayment', 'تحصيل دين', paymentAmount, operation.timestamp, operation.currency || baseCurrency(), operation.note, operation.rateAtTime));
    });
    employeeOperations.filter(function (operation) { return operation && !cashboxIsCancelled(operation) && operation.type === 'withdrawal'; }).forEach(function (operation) {
      entries.push(cashboxEntry('employee_' + operation.id, 'employeeWithdrawal', 'سلفة موظف', -Math.abs(operation.amount), operation.timestamp, operation.currency, operation.note));
    });
    if (Array.isArray(window.xmetalMobileExpenses)) window.xmetalMobileExpenses.forEach(function (expense) {
      if (!expense || cashboxIsCancelled(expense)) return;
      entries.push(cashboxEntry('expense_' + expense.id, 'expense', 'مصروف', -Math.abs(expense.amount), expense.date, expense.currency, expense.description || expense.note));
    });
    if (Array.isArray(window.xmetalTreasuryWithdrawals)) window.xmetalTreasuryWithdrawals.forEach(function (withdrawal) {
      if (!withdrawal || cashboxIsCancelled(withdrawal)) return;
      var isOpening = withdrawal.type === 'openingBalance';
      var isRefund = withdrawal.type === 'refund';
      entries.push(cashboxEntry('treasury_' + withdrawal.id, isRefund ? 'refund' : (isOpening ? 'openingBalance' : 'treasuryWithdrawal'), isRefund ? 'رد مبلغ للعميل' : (isOpening ? 'الرصيد الافتتاحي' : 'سحب من الخزينة'), isOpening ? Math.abs(withdrawal.amount) : -Math.abs(withdrawal.amount), withdrawal.timestamp, withdrawal.currency, withdrawal.note, isRefund ? withdrawal.rateAtTime : null));
    });
    var unique = helpers.uniqueRecordsById ? helpers.uniqueRecordsById(entries, ['id']) : entries;
    return unique.sort(function (a, b) { return b.timestamp - a.timestamp; });
  }
  function renderCashbox() {
    var entries = cashboxEntries.slice().sort(function (a, b) { return b.timestamp - a.timestamp; });
    var total = entries.reduce(function (sum, entry) { return sum + entry.amount; }, 0);
    $('cashboxCurrentBalance').textContent = money(total) + ' ' + activeSymbol();
    var totals = { sale: 0, customerPayment: 0, employeePayment: 0, employeeWithdrawal: 0, expense: 0, treasuryWithdrawal: 0, refund: 0 };
    entries.forEach(function (entry) { if (entry.type === 'employeePayment') totals.employeePayment += entry.amount; else if (totals[entry.type] !== undefined) totals[entry.type] += Math.abs(entry.amount); });
    $('cashboxStats').innerHTML = '<div><span>إجمالي المبيعات النقدية</span><strong>' + money(totals.sale) + '</strong></div><div><span>تحصيل ديون العملاء</span><strong>' + money(totals.customerPayment) + '</strong></div><div><span>تحصيل ديون الموظفين</span><strong>' + money(totals.employeePayment) + '</strong></div><div><span>السلف النقدية للموظفين</span><strong>' + money(totals.employeeWithdrawal) + '</strong></div><div><span>إجمالي المصروفات</span><strong>' + money(totals.expense) + '</strong></div><div><span>سحوبات الخزينة</span><strong>' + money(totals.treasuryWithdrawal) + '</strong></div><div><span>الرصيد الحالي المتوقع</span><strong>' + money(total) + ' ' + activeSymbol() + '</strong></div>';
    var lastWithdrawal = entries.find(function (entry) { return entry.type === 'treasuryWithdrawal'; });
    var sinceWithdrawal = lastWithdrawal ? entries.filter(function (entry) { return entry.timestamp > lastWithdrawal.timestamp; }).reduce(function (sum, entry) { return sum + entry.amount; }, 0) : total;
    $('cashboxLastWithdrawal').innerHTML = '<strong>آخر سحب من الخزينة</strong><span>' + (lastWithdrawal ? money(Math.abs(lastWithdrawal.amount)) + ' ' + activeSymbol() + '، ' + formatDateTime(lastWithdrawal.timestamp) : 'لا توجد سحوبات مسجلة') + '</span><span>المبلغ الداخل أو الخارج منذ آخر سحب: ' + money(sinceWithdrawal) + ' ' + activeSymbol() + '</span><span>الرصيد الحالي منذ آخر سحب: ' + money(total) + ' ' + activeSymbol() + '</span>';
    if (!entries.length) { $('cashboxHistory').innerHTML = '<div class="empty-state">لا توجد حركات نقدية حتى الآن</div>'; return; }
    var groups = {};
    entries.forEach(function (entry) { var day = dayKey(entry.timestamp); if (!groups[day]) groups[day] = []; groups[day].push(entry); });
    var running = total;
    $('cashboxHistory').innerHTML = Object.keys(groups).sort().reverse().map(function (day) {
      var dayEntries = groups[day].sort(function (a, b) { return b.timestamp - a.timestamp; });
      var markup = '<section class="cashbox-day"><header><strong>' + esc(dayLabel(Date.parse(day + 'T12:00:00+03:00'))) + '</strong></header>';
      markup += dayEntries.map(function (entry) { var balanceAfter = running; running -= entry.amount; return '<article><strong>' + esc(entry.label) + '</strong><span class="cashbox-amount ' + (entry.amount >= 0 ? 'positive' : 'negative') + '">' + (entry.amount >= 0 ? '+' : '-') + ' ' + money(Math.abs(entry.amount)) + ' ' + esc(activeSymbol()) + '</span><time>' + esc(formatDateTime(entry.timestamp)) + '</time><small>' + esc(entry.note || '') + '</small><span>الرصيد بعد العملية: ' + money(balanceAfter) + ' ' + esc(activeSymbol()) + '</span></article>'; }).join('') + '</section>';
      return markup;
    }).join('');
  }
  async function loadCashboxData() {
    if (!db || !db.collection) return;
    var results = await Promise.all([
      db.collection('expenses').get(),
      db.collection('treasuryOperations').get()
    ]);
    window.xmetalMobileExpenses = results[0].docs.map(function (doc) { return Object.assign({ id: doc.id }, doc.data()); });
    window.xmetalTreasuryWithdrawals = results[1].docs.map(function (doc) { return Object.assign({ id: doc.id }, doc.data()); });
    cashboxEntries = buildCashboxEntries();
    cashboxLoaded = true;
    renderCashbox();
  }

  function showCashboxPage() {
    activePage = 'cashbox';
    $('appShell').hidden = true; $('debtPage').hidden = true; $('employeePage').hidden = true;
    $('historyPage').hidden = true; $('cashboxPage').hidden = false; $('settingsPage').hidden = true; $('operationsPage').hidden = true;
    loadCashboxData().catch(function (error) { notify(error.message || 'تعذر تحميل سجل الخزينة'); });
    updateMobileNavigation('cashbox');
  }

  function operationActionLabel(action, record) {
    if (action === 'sell' && record) return record.paymentMethod === 'credit' ? 'بيع آجل' : 'بيع كاش';
    if ((action === 'payment' || action === 'settle') && record) return action === 'settle' || record.metadata && record.metadata.paymentType === 'settle' ? 'سداد كامل' : 'سداد جزئي';
    if (action === 'debt' && record) return 'إضافة دين';
    if (action === 'employee' && record && record.metadata && record.metadata.employeeOperationType === 'wage') return 'أجرة موظف';
    if (action === 'employee' && record && record.metadata && record.metadata.employeeOperationType === 'withdrawal') return 'سلفة موظف';
    if (action === 'update' && record && record.metadata && record.metadata.changes) {
      var changes = record.metadata.changes;
      if (changes.quantity && !changes.unitPrice) return 'تعديل كمية';
      if (changes.unitPrice && !changes.quantity) return 'تعديل سعر';
    }
    return { sell: 'بيع', update: 'تعديل', cancel: 'إلغاء بيع', cancelSale: 'إلغاء بيع', return: 'استرجاع', payment: 'سداد', settle: 'سداد كامل', debt: 'دين', treasury: 'خزينة', employee: 'موظف', inventory: 'مخزون', create: 'إضافة', delete: 'حذف' }[action] || action || 'عملية';
  }

  function operationEntityLabel(entity) {
    return { sale: 'بيع منتج', debt: 'دين', payment: 'سداد', customer: 'عميل', employee: 'موظف', treasury: 'خزينة', inventory: 'مخزون', item: 'منتج' }[entity] || entity || 'بيانات';
  }

  function operationMatches(record) {
    var search = String($('operationsSearch').value || '').trim().toLowerCase();
    var action = String($('operationsActionFilter').value || '').trim();
    var recordAction = String(record.actionType || '');
    if (action && recordAction !== action && !(action === 'cancel' && recordAction === 'cancelSale')) return false;
    if (!search) return true;
    return [record.details, record.itemName, record.userName, record.user, record.entity, record.entityId].some(function (value) { return String(value || '').toLowerCase().indexOf(search) >= 0; });
  }

  function recordDisplayCurrencyCode(record, fallbackCode) {
    var metadata = record && record.metadata ? record.metadata : {};
    var code = record && (record.currency || record.saleMode || record.displayCurrency || metadata.currency || metadata.saleMode || metadata.displayCurrency || fallbackCode);
    return code === '' ? '' : 'primary';
  }

  function formatRecordMoney(value, record, fallbackCode) {
    var numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return '0';
    var code = recordDisplayCurrencyCode(record, fallbackCode || 'primary');
    return money(amountInActiveCurrency(numericValue, code));
  }

  function getActualSaleUnitPrice(record) {
    var metadata = record && record.metadata ? record.metadata : {};
    var action = String(record && (record.actionType || record.action) || '');
    
    // For 'sell' actions, calculate unit price from total amount and quantity
    if (action === 'sell') {
      var totalAmount = record && (record.totalAmount !== undefined ? record.totalAmount : metadata.totalAmount !== undefined ? metadata.totalAmount : null);
      var quantity = Number(record && (record.quantity || metadata.quantity) || 0);
      
      if (totalAmount !== null && Number.isFinite(Number(totalAmount)) && quantity > 0) {
        return Number(totalAmount) / quantity;
      }
    }
    
    // For other actions, use the stored unit price
    return record && (record.unitPrice !== undefined ? record.unitPrice : metadata.unitPrice !== undefined ? metadata.unitPrice : null);
  }

  function operationDetailsText(record) {
    var action = String(record.actionType || record.action || '');
    if (action === 'sell' && (record.itemName || record.metadata && record.metadata.itemName)) {
      var total = record.totalAmount || record.metadata && record.metadata.totalAmount;
      return (record.itemName || record.metadata.itemName) + '، الكمية: ' + (record.quantity || record.metadata.quantity || 0) + (total !== undefined && total !== null ? '، ' + formatRecordMoney(total, record, 'primary') + ' ' + operationCurrencyLabel(record) : '');
    }
    var changes = record.metadata && record.metadata.changes;
    if (action === 'update' && changes && changes.quantity) return (record.itemName || record.metadata.itemName || 'بيع') + '، الكمية: ' + changes.quantity.before + ' ← ' + changes.quantity.after;
    if (action === 'update' && changes && changes.unitPrice) return (record.itemName || record.metadata.itemName || 'بيع') + '، السعر: ' + formatRecordMoney(changes.unitPrice.before, record, 'primary') + ' ← ' + formatRecordMoney(changes.unitPrice.after, record, 'primary') + ' ' + operationCurrencyLabel(record);
    return String(record.details || '').replace(/،?\s*الربح:\s*[^،]+/g, '').trim();
  }

  function operationCurrencyLabel(record) {
    return baseCurrency() === '' ? (currency.CurrencySymbol || '') : '$';
  }

  function operationPriceTypeLabel(value) {
    return value === 'mechanic' ? 'سعر الميكانيكي' : value === 'customer' || value === 'sale' ? 'سعر الزبون' : value === 'base' ? 'السعر الأساسي' : value || '';
  }

  function renderOperationsLog() {
    var body = $('operationsLogBody');
    if (!body) return;
    var visible = operationsRecords.filter(operationMatches);
    body.innerHTML = visible.length ? visible.map(function (record, index) {
      var recordId = record.operationId || record.id;
      return '<tr><td>' + (index + 1) + '</td><td>' + esc(formatDateTime(timestampValue(record.timestamp))) + '</td><td>' + esc(operationActionLabel(record.actionType || record.action, record)) + '</td><td>' + esc(operationEntityLabel(record.entityType || record.entity)) + '</td><td>' + esc(operationDetailsText(record)) + '</td><td>' + esc(record.userName || record.sellerName || record.user || '--') + '</td><td><button class="operation-view-button" type="button" data-operation-id="' + esc(recordId) + '">عرض</button></td></tr>';
    }).join('') : '<tr><td colspan="7" class="operations-empty">لا توجد عمليات مسجلة</td></tr>';
    $('operationsStatus').textContent = operationsError || (operationsLoaded && !operationsLoading && !operationsHasMore ? 'تم عرض جميع العمليات' : '');
    $('operationsLoadMore').hidden = !operationsHasMore || operationsLoading;
  }

  function upsertMobileOperationRecord(record) {
    if (!record || !record.operationId) return;
    var recordKey = String(record.operationId);
    var existingIndex = operationsRecords.findIndex(function (entry) { return String(entry.operationId || entry.id || '') === recordKey; });
    if (existingIndex === -1) operationsRecords.unshift(record);
    else operationsRecords[existingIndex] = Object.assign({}, operationsRecords[existingIndex], record);
    operationsRecords.sort(function (a, b) { return timestampValue(b.timestamp) - timestampValue(a.timestamp); });
    if (operationsLoaded) renderOperationsLog();
  }

  async function loadOperationsPage(reset) {
    if (operationsLoading || !db || !db.collection) return;
    operationsLoading = true;
    if (reset) {
      operationsLastDocument = null;
      operationsHasMore = false;
      operationsLoaded = false;
    }
    renderOperationsLog();
    try {
      operationsError = '';
      var query = db.collection('activityLog').where('source', '==', SOURCE).orderBy('timestamp', 'desc').limit(26);
      if (operationsLastDocument) query = query.startAfter(operationsLastDocument);
      var snapshot;
      try {
        snapshot = await query.get();
      } catch (indexedQueryError) {
        console.warn('Falling back to source-only activity query', indexedQueryError);
        var fallbackQuery = db.collection('activityLog').where('source', '==', SOURCE).limit(26);
        if (operationsLastDocument) fallbackQuery = fallbackQuery.startAfter(operationsLastDocument);
        snapshot = await fallbackQuery.get();
      }
      var documents = snapshot.docs || [];
      documents.sort(function (a, b) { return timestampValue((b.data() || {}).timestamp) - timestampValue((a.data() || {}).timestamp); });
      operationsHasMore = documents.length > 25;
      if (operationsHasMore) documents = documents.slice(0, 25);
      operationsLastDocument = documents.length ? documents[documents.length - 1] : operationsLastDocument;
      var recordsById = new Map(operationsRecords.map(function (record) { return [String(record.operationId || record.id), record]; }));
      documents.forEach(function (doc) { var data = Object.assign({ id: doc.id, operationId: doc.id }, doc.data()); recordsById.set(String(data.operationId || data.id), data); });
      operationsRecords = Array.from(recordsById.values()).sort(function (a, b) { return timestampValue(b.timestamp) - timestampValue(a.timestamp); });
      operationsLoaded = true;
    } catch (error) {
      console.warn('Unable to load mobile operations log', error);
      operationsError = 'تعذر تحميل سجل العمليات: ' + (error.message || 'تحقق من اتصال البيانات');
    } finally {
      operationsLoading = false;
      renderOperationsLog();
    }
  }

  function renderOperationDetail(record) {
    var content = $('operationDetailContent');
    if (!content || !record) return;
    var metadata = record.metadata || {};
    var changes = metadata.changes || {};
    var action = String(record && (record.actionType || record.action) || '');
    var fields = [['الإجراء', operationActionLabel(record.actionType || record.action, record)], ['التاريخ والوقت', formatDateTime(timestampValue(record.timestamp))], ['المستخدم', record.userName || record.sellerName || record.user]];
    if (record.itemName || metadata.itemName) fields.push(['المنتج', record.itemName || metadata.itemName]);
    if (record.customerName || metadata.customerName) fields.push(['العميل', record.customerName || metadata.customerName]);
    if (record.employeeName || metadata.employeeName) fields.push(['الموظف', record.employeeName || metadata.employeeName]);
    if (metadata.quantity !== undefined && !changes.quantity) fields.push(['الكمية', metadata.quantity]);
    if (changes.quantity) fields.push(['الكمية', String(changes.quantity.before) + ' ← ' + String(changes.quantity.after)]);
    else if (metadata.oldQuantity !== undefined && metadata.newQuantity !== undefined) fields.push(['الكمية', String(metadata.oldQuantity) + ' ← ' + String(metadata.newQuantity)]);
    if (changes.unitPrice) fields.push(['السعر', formatRecordMoney(changes.unitPrice.before, record, 'primary') + ' ← ' + formatRecordMoney(changes.unitPrice.after, record, 'primary')]);
    var actualUnitPrice = getActualSaleUnitPrice(record);
    if (actualUnitPrice !== null && !changes.unitPrice) fields.push(['سعر الوحدة', formatRecordMoney(actualUnitPrice, record, 'primary') + ' ' + operationCurrencyLabel(record)]);
    if (metadata.totalAmount !== undefined || record.totalAmount !== undefined) fields.push(['إجمالي البيع', formatRecordMoney(metadata.totalAmount !== undefined ? metadata.totalAmount : record.totalAmount, record, 'primary') + ' ' + operationCurrencyLabel(record)]);
    if (metadata.amount !== undefined) fields.push(['المبلغ', formatRecordMoney(metadata.amount, record, 'primary') + ' ' + operationCurrencyLabel(record)]);
    if (metadata.refundAmount !== undefined) fields.push(['المبلغ المعاد', formatRecordMoney(metadata.refundAmount, record, 'primary') + ' ' + operationCurrencyLabel(record)]);
    if (metadata.cashboxAmount !== undefined && metadata.cashboxAmount !== null) fields.push(['المضاف إلى الخزينة', formatRecordMoney(metadata.cashboxAmount, record, 'primary') + ' ' + operationCurrencyLabel(record)]);
    if (metadata.debtBefore !== undefined && metadata.debtBefore !== null) fields.push(['الدين قبل العملية', formatRecordMoney(metadata.debtBefore, record, 'primary') + ' ' + operationCurrencyLabel(record)]);
    if (metadata.debtAfter !== undefined && metadata.debtAfter !== null) fields.push(['الدين بعد العملية', formatRecordMoney(metadata.debtAfter, record, 'primary') + ' ' + operationCurrencyLabel(record)]);
    if (metadata.cashboxBefore !== undefined && metadata.cashboxBefore !== null) fields.push(['الخزينة قبل العملية', formatRecordMoney(metadata.cashboxBefore, record, 'primary') + ' ' + operationCurrencyLabel(record)]);
    if (metadata.cashboxAfter !== undefined && metadata.cashboxAfter !== null) fields.push(['الخزينة بعد العملية', formatRecordMoney(metadata.cashboxAfter, record, 'primary') + ' ' + operationCurrencyLabel(record)]);
    if (record.paymentMethod || metadata.paymentMethod) fields.push(['نوع البيع', (record.paymentMethod || metadata.paymentMethod) === 'credit' ? 'آجل' : 'نقدي']);
    if (metadata.priceType || record.priceType) fields.push(['نوع السعر', operationPriceTypeLabel(metadata.priceType || record.priceType)]);
    if (record.details && !String(record.details).match(/الربح:/)) fields.push(['التفاصيل', record.details]);
    if (record.note || record.reason) fields.push(['ملاحظات', record.note || record.reason]);
    content.innerHTML = fields.filter(function (field) { return field[1] !== undefined && field[1] !== null && String(field[1]).trim() !== ''; }).map(function (field) { return '<div class="operation-detail-field"><span>' + esc(field[0]) + '</span><strong>' + esc(field[1]) + '</strong></div>'; }).join('');
    openModal('operationDetailModal');
  }

  function showOperationsPage() {
    activePage = 'operations';
    $('appShell').hidden = true; $('debtPage').hidden = true; $('employeePage').hidden = true; $('historyPage').hidden = true; $('cashboxPage').hidden = true; $('settingsPage').hidden = true; $('operationsPage').hidden = false;
    updateMobileNavigation('operations');
    if (!operationsLoaded) loadOperationsPage(true); else renderOperationsLog();
  }

  function showSettingsPage() {
    activePage = 'settings';
    $('appShell').hidden = true; $('debtPage').hidden = true; $('employeePage').hidden = true;
    $('historyPage').hidden = true; $('cashboxPage').hidden = true; $('settingsPage').hidden = false; $('operationsPage').hidden = true;
    $('showEndedProductsToggle').checked = showEndedProducts;
    $('allowDebtDateEditingToggle').checked = allowDebtDateEditing;
    updateMobileNavigation('settings');
  }

  function employeeDayId(employeeId, day) { return 'employee_day_' + String(employeeId) + '_' + String(day); }
  function employeeOperationId(employeeId, type) { return 'employee_op_' + String(employeeId) + '_' + type + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }
  function employeeDayTimestamp(day) { return Date.parse(String(day) + 'T10:00:00+03:00'); }
  function employeeCurrentDay() { return getRiyadhDateTimeParts(Date.now()).dateKey; }
  function employeeOperationIsActive(operation) {
    if (!operation || typeof operation !== 'object') return false;
    var status = String(operation.status || '').trim().toLowerCase();
    var cancelled = operation.cancelled === true || operation.isCancelled === true || status === 'cancelled' || status === 'deleted' || status === 'returned';
    return !cancelled;
  }
  function employeeDisplayAmount(operation) {
    if (!operation || typeof operation !== 'object') return { value: 0, code: baseCurrency(), symbol: activeSymbol() };
    if (helpers && typeof helpers.getHistoricalOperationDisplay === 'function') {
      return helpers.getHistoricalOperationDisplay(operation, currency);
    }
    var amount = Number(operation.amount) || 0;
    var sourceCurrency = String(operation.currency || 'primary').trim().toLowerCase();
    if (sourceCurrency !== 'primary' && sourceCurrency !== '') sourceCurrency = 'primary';
    var rate = Number(operation.rateAtTime != null ? operation.rateAtTime : (operation.rateAtTime != null ? operation.rateAtTime : currency.rate)) || Number(currency.rate) || 1;
    var display = getDisplayMoney(amount, sourceCurrency, Object.assign({}, currency, { rate: rate }));
    return {
      value: display.value,
      code: display.code,
      symbol: display.symbol
    };
  }
  function employeeOperationAmount(operation) {
    if (!operation || typeof operation !== 'object') return 0;
    var amount = Number(operation.amount) || 0;
    if (!Number.isFinite(amount)) return 0;
    return amount;
  }
  function updateEmployeeStoredBalance(employeeId, delta) {
    if (!employeeId || !db || !db.collection) return Promise.resolve(null);
    var employeeRef = db.collection('employees').doc(String(employeeId));
    return db.runTransaction(function (tx) {
      return tx.get(employeeRef).then(function (snapshot) {
        var existing = snapshot.exists ? snapshot.data() || {} : {};
        var currentValue = Number(existing.currentBalance);
        if (!Number.isFinite(currentValue)) {
          currentValue = employeeBalance(String(employeeId));
        }
        var nextValue = currentValue + (Number(delta) || 0);
        tx.set(employeeRef, { currentBalance: nextValue, updatedAt: Date.now() }, { merge: true });
        var employeeIndex = (employees || []).findIndex(function (entry) { return String(entry.id) === String(employeeId); });
        if (employeeIndex !== -1) {
          employees[employeeIndex] = Object.assign({}, employees[employeeIndex], { currentBalance: nextValue, updatedAt: Date.now() });
        }
        return nextValue;
      });
    }).catch(function (error) {
      console.warn('Unable to update employee stored balance', error);
      return null;
    });
  }
  function employeeBalance(employeeId) {
    var employeeRecord = (employees || []).find(function (entry) { return String(entry.id) === String(employeeId); }) || null;
    var storedBalance = employeeRecord && employeeRecord.currentBalance != null ? Number(employeeRecord.currentBalance) || 0 : null;
    var activeOperations = employeeOperations.filter(function (operation) { return operation && String(operation.employeeId) === String(employeeId) && employeeOperationIsActive(operation); });
    var derivedBalance = activeOperations.reduce(function (total, operation) {
      var amount = employeeOperationAmount(operation);
      var isCreditLike = operation.type === 'wage' || operation.type === 'addition' || operation.type === 'employee_withdrawal_return';
      return total + (isCreditLike ? amount : -amount);
    }, 0);
    if (activeOperations.length > 0) return derivedBalance;
    if (storedBalance !== null && Number.isFinite(storedBalance)) return storedBalance;
    return derivedBalance;
  }
  function employeeBalanceAfter(employeeId, operation) {
    var operationTime = timestampValue(operation && operation.timestamp);
    return employeeOperations.filter(function (entry) { return entry && String(entry.employeeId) === String(employeeId) && employeeOperationIsActive(entry) && timestampValue(entry.timestamp) <= operationTime; }).reduce(function (total, entry) { var amount = employeeOperationAmount(entry); var isCreditLike = entry.type === 'wage' || entry.type === 'addition' || entry.type === 'employee_withdrawal_return'; return total + (isCreditLike ? amount : -amount); }, 0);
  }
  function getEmployeePurchasePaidAmount(sale) {
    if (!sale || !sale.employeePurchase || sale.paymentMethod !== 'credit') return 0;
    var creditSales = sales.filter(function (entry) { return entry && entry.employeePurchase && entry.paymentMethod === 'credit' && String(entry.employeeId) === String(sale.employeeId); }).sort(function (a, b) { return timestampValue(a.timestamp) - timestampValue(b.timestamp); });
    var paidBySale = {};
    creditSales.forEach(function (entry) { paidBySale[entry.saleId] = 0; });
    employeeOperations.slice().sort(function (a, b) { return timestampValue(a.timestamp) - timestampValue(b.timestamp); }).forEach(function (operation) {
      if (String(operation.employeeId) !== String(sale.employeeId) || operation.status === 'cancelled' || (operation.type !== 'wage' && operation.type !== 'addition')) return;
      var available = Math.max(0, Number(operation.amount) || 0);
      creditSales.forEach(function (entry) {
        if (available <= 0 || timestampValue(entry.timestamp) >= timestampValue(operation.timestamp)) return;
        var total = Number(entry.displayTotalAmount || entry.rawTotalAmount || entry.totalAmount || 0) || 0;
        var applied = Math.min(available, Math.max(0, total - paidBySale[entry.saleId]));
        paidBySale[entry.saleId] += applied;
        available -= applied;
      });
    });
    return Math.min(Number(sale.displayTotalAmount || sale.rawTotalAmount || sale.totalAmount || 0) || 0, paidBySale[sale.saleId] || 0);
  }
  function getEmployeePurchasePaymentProgress(sale) {
    var amount = Number(sale && (sale.displayTotalAmount || sale.rawTotalAmount || sale.totalAmount)) || 0;
    var paid = Math.min(amount, getEmployeePurchasePaidAmount(sale));
    return { amount: amount, paidAmount: paid, percent: amount > 0 ? (paid / amount) * 100 : 0, isPaid: amount > 0 && paid >= amount };
  }
  function employeeSummary(employeeId) {
    var operations = employeeOperations.filter(function (operation) { return operation && String(operation.employeeId) === String(employeeId) && employeeOperationIsActive(operation); });
    var totalProductValue = operations.filter(function (entry) { return entry.type === 'productPurchase' || entry.type === 'employee_withdrawal' || entry.type === 'employee_withdrawal_return'; }).reduce(function (sum, entry) { return sum + employeeOperationAmount(entry); }, 0);
    var derivedBalance = employeeBalance(employeeId);
    return {
      balance: derivedBalance,
      wages: operations.filter(function (entry) { return entry.type === 'wage'; }).reduce(function (sum, entry) { return sum + employeeOperationAmount(entry); }, 0),
      withdrawals: operations.filter(function (entry) { return entry.type === 'withdrawal'; }).reduce(function (sum, entry) { return sum + employeeOperationAmount(entry); }, 0),
      purchases: totalProductValue,
      additions: operations.filter(function (entry) { return entry.type === 'addition'; }).reduce(function (sum, entry) { return sum + employeeOperationAmount(entry); }, 0)
    };
  }
  function employeeOperationCurrency() { return baseCurrency(); }
  function employeeOperationAmount(operation) {
    return employeeDisplayAmount(operation).value;
  }
  function employeeCurrency(value, currencyCode) {
    var code = String(currencyCode || employeeOperationCurrency()).trim().toLowerCase();
    if (code !== 'primary' && code !== '') code = 'primary';
    return money(value) + ' ' + (code === '' ? (currency.CurrencySymbol || '') : '$');
  }
  function updateEmployeeCurrencyLabels() {
    var label = employeeOperationCurrency() === '' ? (currency.CurrencySymbol || '') : '$';
    if ($('employeeWageCurrencyLabel')) $('employeeWageCurrencyLabel').textContent = '(' + label + ')';
    if ($('withdrawalCurrencyLabel')) $('withdrawalCurrencyLabel').textContent = '(' + label + ')';
  }
  function employeeOperationLabel(type) {
    var normalizedType = String(type || '').trim().toLowerCase();
    if (normalizedType === 'wage') return 'أجرة دوام';
    if (normalizedType === 'withdrawal') return 'سحب';
    if (normalizedType === 'productPurchase') return 'شراء منتج';
    if (normalizedType === 'employee_withdrawal') return 'سحب منتج';
    if (normalizedType === 'employee_withdrawal_return') return 'إرجاع بضاعة';
    if (normalizedType === 'addition') return 'إضافة';
    return 'عملية مالية';
  }
  function employeeOwnership() { return getCurrentUserOwnership(); }
  function employeeWageForDay(employee, day) {
    var history = Array.isArray(employee && employee.wageHistory) ? employee.wageHistory.slice().sort(function (a, b) { return String(b.effectiveFrom || '').localeCompare(String(a.effectiveFrom || '')); }) : [];
    var applicable = history.find(function (entry) { return entry && String(entry.effectiveFrom || '') <= String(day); });
    var source = applicable || employee || {};
    var primaryValue = Number(source.dailyWage != null ? source.dailyWage : (source.dailyWagePrimary != null ? source.dailyWagePrimary : 0)) || 0;
    if (String(source.dailyWageCurrency || 'primary').trim().toLowerCase() === '' && source.dailyWagePrimary != null) {
      primaryValue = Number(source.dailyWagePrimary) / (Number(currency.rate) || 1);
    }
    return primaryValue;
  }
  async function isCurrentUserAdmin(user) {
    var currentUser = user || (auth && auth.currentUser ? auth.currentUser : null);
    if (!currentUser) return false;

    var configuredAdminAccount = await getConfiguredMobileSalesAdminAccount();
    var currentEmail = String(currentUser.email || '').trim().toLowerCase();
    var currentUid = String(currentUser.uid || '').trim();

    if (configuredAdminAccount && ((configuredAdminAccount.uid && currentUid && configuredAdminAccount.uid === currentUid) || (configuredAdminAccount.email && currentEmail && configuredAdminAccount.email === currentEmail))) {
      return true;
    }

    if (currentUser.isAdmin === true || currentUser.admin === true) return true;

    if (typeof window !== 'undefined' && window.permissionManager && window.permissionManager.userRole) {
      var localRole = window.permissionManager.userRole;
      if (localRole === 'admin' || localRole === 'manager') return true;
    }

    if (typeof window !== 'undefined' && window.appState && window.appState.user && window.appState.user.role) {
      var stateRole = window.appState.user.role;
      if (stateRole === 'admin' || stateRole === 'manager') return true;
    }

    if (typeof currentUser.getIdTokenResult === 'function') {
      try {
        var token = await currentUser.getIdTokenResult();
        var claims = token && token.claims ? token.claims : {};
        if (claims.admin === true || claims.manager === true || claims.role === 'admin' || claims.role === 'manager') return true;
      } catch (error) {
        return false;
      }
    }

    return false;
  }

  async function applyAdminOnlyVisibility(user) {
    var isAdmin = await isCurrentUserAdmin(user);
    var adminOnlyNodes = document.querySelectorAll('.admin-only');
    adminOnlyNodes.forEach(function (node) {
      if (!node) return;
      if (isAdmin) {
        node.hidden = false;
        node.removeAttribute('hidden');
        node.style.display = '';
      } else {
        node.hidden = true;
      }
    });

    var configuredAdminStatus = document.getElementById('mobileSalesAdminAccountStatusValue');
    if (configuredAdminStatus) {
      var configuredAdmin = await getConfiguredMobileSalesAdminAccount();
      configuredAdminStatus.textContent = configuredAdmin.email || configuredAdmin.uid || 'غير محدد';
    }

    if (document.body) {
      document.body.classList.toggle('is-admin-user', isAdmin);
      document.body.classList.toggle('is-employee-user', !isAdmin);
    }
  }

  async function resolveEmployeeManagerAccess(user) {
    managerAccess = false;
    if (!user || typeof user.getIdTokenResult !== 'function') return false;
    try {
      var token = await user.getIdTokenResult();
      var claims = token && token.claims ? token.claims : {};
      managerAccess = claims.admin === true || claims.manager === true || claims.role === 'admin' || claims.role === 'manager';
    } catch (error) { managerAccess = false; }
    return managerAccess;
  }

  async function ensureEmployeeDay(employee, day) {
    if (!employee || employee.status !== 'active' || String(day) < String(employee.startDate || '')) return;
    var nowParts = getRiyadhDateTimeParts(Date.now());
    if (String(day) === nowParts.dateKey && nowParts.timeValue < '10:00') return;
    var dayRef = db.collection('employeeDays').doc(employeeDayId(employee.id, day));
    var wageRef = db.collection('employeeOperations').doc(employeeDayId(employee.id, day) + '_wage');
    await db.runTransaction(function (tx) {
      return tx.get(dayRef).then(function (daySnapshot) {
        if (daySnapshot.exists) return;
        var createdAt = Date.now();
        var wage = employeeWageForDay(employee, day);
        var ownership = employeeOwnership();
        tx.set(dayRef, { id: dayRef.id, employeeId: employee.id, employeeName: employee.name, dateKey: day, dayName: dayLabel(employeeDayTimestamp(day)).split(' ')[0], status: 'work', dailyWage: wage, createdAt: createdAt, createdBy: ownership.createdBy, ownerId: ownership.ownerId, source: SOURCE });
        var wageOperationAmount = baseCurrency() === '' ? (wage) : wage;
        tx.set(wageRef, { id: wageRef.id, employeeId: employee.id, employeeName: employee.name, type: 'wage', amount: wageOperationAmount, dailyWage: wage, currency: baseCurrency(), rateAtTime: Number(currency.rate) || 1, dateKey: day, timestamp: employeeDayTimestamp(day), createdAt: createdAt, note: 'أجرة دوام تلقائية', source: SOURCE, status: 'active', ownerId: ownership.ownerId, createdBy: ownership.createdBy });
      });
    });
  }
  async function ensureEmployeeDays() {
    var today = employeeCurrentDay();
    for (var i = 0; i < employees.length; i += 1) {
      var employee = employees[i];
      var start = String(employee.startDate || today);
      var cursor = new Date(start + 'T12:00:00+03:00');
      var end = new Date(today + 'T12:00:00+03:00');
      while (cursor <= end) {
        await ensureEmployeeDay(employee, cursor.toISOString().slice(0, 10));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
    }
    await loadEmployeeData();
  }
  async function loadEmployeeData() {
    if (!db || !db.collection) return;
    var currentUser = auth && auth.currentUser ? auth.currentUser : null;
    var email = currentUser && currentUser.email ? String(currentUser.email).trim().toLowerCase() : '';
    if (!email) { employees = []; currentEmployee = null; employeeAccess = false; updateEmployeeAccessUI(); return; }
    var employeeSnapshot = await db.collection('employees').where('email', '==', email).get();
    var matchedEmployees = employeeSnapshot.docs.map(function (doc) { return Object.assign({ id: doc.id }, doc.data()); });
    currentEmployee = matchedEmployees.find(function (employee) { return employee.status !== 'inactive'; }) || null;
    employees = currentEmployee ? [currentEmployee] : [];
    employeeAccess = Boolean(currentEmployee);
    if (!currentEmployee) {
      employeeOperations = [];
      employeeDays = [];
      updateEmployeeAccessUI();
      return;
    }
    var operationSnapshot = await db.collection('employeeOperations').where('employeeId', '==', currentEmployee.id).limit(25).get();
    employeeOperations = operationSnapshot.docs.map(function (doc) { return Object.assign({ id: doc.id }, doc.data()); }).sort(function (a, b) { return timestampValue(b.timestamp) - timestampValue(a.timestamp); });
    var daySnapshot = await db.collection('employeeDays').where('employeeId', '==', currentEmployee.id).get();
    employeeDays = daySnapshot.docs.map(function (doc) { return Object.assign({ id: doc.id }, doc.data()); });
    if (currentEmployee) {
      selectedEmployeeId = currentEmployee.id;
      renderEmployeeDetail(currentEmployee.id);
    }
  }
  function updateEmployeeAccessUI() {
    var employeeLinks = document.querySelectorAll('[data-menu-action="employees"]');
    employeeLinks.forEach(function (link) { link.hidden = !employeeAccess; });
  }
  function employeeBalanceImpactClass(operation) {
    var type = String(operation && operation.type || '').trim().toLowerCase();
    var positiveTypes = ['wage', 'addition', 'employee_withdrawal_return'];
    return positiveTypes.indexOf(type) !== -1 ? 'positive-impact' : 'negative-impact';
  }
  async function loadEmployeeHistoryPage(employeeId, reset) {
    if (!db || !db.collection || !employeeId) return;
    if (employeeHistoryLoading) return;
    employeeHistoryLoading = true;
    if (reset) {
      employeeHistoryLastDoc = null;
      employeeHistoryHasMore = false;
      employeeHistoryRecords = [];
      employeeHistoryAllRecords = [];
    }
    try {
      if (!employeeHistoryAllRecords.length || reset) {
        var snapshot = await db.collection('employeeOperations').where('employeeId', '==', String(employeeId)).get();
        employeeHistoryAllRecords = (snapshot.docs || []).map(function (doc) { return Object.assign({ id: doc.id }, doc.data()); }).sort(function (a, b) { return timestampValue(b.timestamp) - timestampValue(a.timestamp); });
      }
      var startIndex = reset ? 0 : employeeHistoryRecords.length;
      var nextChunk = employeeHistoryAllRecords.slice(startIndex, startIndex + employeeHistoryPageSize);
      if (reset) employeeHistoryRecords = nextChunk;
      else employeeHistoryRecords = employeeHistoryRecords.concat(nextChunk.filter(function (record) { return !employeeHistoryRecords.some(function (existing) { return String(existing.id) === String(record.id); }); }));
      employeeHistoryHasMore = employeeHistoryRecords.length < employeeHistoryAllRecords.length;
      if (!employeeHistoryAllRecords.length) employeeHistoryHasMore = false;
    } catch (error) {
      console.warn('Unable to load employee history page', error);
      employeeHistoryHasMore = false;
      employeeHistoryLastDoc = null;
    } finally {
      employeeHistoryLoading = false;
      renderEmployeeHistory(employeeId);
    }
  }
  function renderEmployeeHistory(employeeId) {
    var records = employeeHistoryRecords.slice().sort(function (a, b) { return timestampValue(b.timestamp) - timestampValue(a.timestamp); });
    if (!records.length) {
      $('employeeHistory').innerHTML = '<div class="empty-state">لا توجد عمليات لهذا الموظف</div>';
      return;
    }
    var moreButtonMarkup = employeeHistoryHasMore ? '<div class="history-load-more-wrap"><button type="button" class="load-more" id="employeeHistoryLoadMore" data-employee-history-more="' + esc(String(employeeId)) + '" ' + (employeeHistoryLoading ? 'disabled' : '') + '>' + (employeeHistoryLoading ? 'جارٍ تحميل المزيد...' : 'عرض المزيد') + '</button></div>' : '';
    var groups = {};
    records.forEach(function (entry) { var day = entry.dateKey || dayKey(entry.timestamp); if (!groups[day]) groups[day] = []; groups[day].push(entry); });
    var days = Object.keys(groups).sort().reverse();
    var html = days.map(function (day) { var dayOperations = groups[day].sort(function (a, b) { return timestampValue(b.timestamp) - timestampValue(a.timestamp); }); var dayRecord = employeeDays.find(function (entry) { return String(entry.employeeId) === String(employeeId) && entry.dateKey === day; }); var status = dayRecord && dayRecord.status === 'holiday' ? 'عطلة' : 'دوام'; return '<section class="employee-day-group"><header><strong>' + esc(dayLabel(Date.parse(day + 'T12:00:00+03:00'))) + '</strong><span>' + status + '</span></header><table><thead><tr><th>العملية</th><th>المبلغ</th><th>الوقت</th><th>ملاحظات</th><th>الرصيد</th></tr></thead><tbody>' + dayOperations.map(function (entry) { var signed = entry.type === 'wage' || entry.type === 'addition' || entry.type === 'employee_withdrawal_return' ? '+' : '-'; var display = employeeDisplayAmount(entry); var impactClass = employeeBalanceImpactClass(entry); return '<tr class="employee-operation-row ' + impactClass + '" data-employee-operation-id="' + esc(String(entry.id)) + '" style="cursor:pointer;" title="اضغط لعرض الخيارات"><td>' + esc(employeeOperationLabel(entry.type) + (entry.itemName ? ' - ' + entry.itemName : '')) + '</td><td>' + signed + ' ' + esc(employeeCurrency(display.value, display.code)) + '</td><td>' + esc(formatDateTime(entry.timestamp)) + '</td><td>' + esc(entry.note || 'بدون ملاحظات') + '</td><td>' + esc(employeeCurrency(employeeBalanceAfter(employeeId, entry), employeeOperationCurrency())) + '</td></tr>'; }).join('') + '</tbody></table></section>'; }).join('');
    if (employeeHistoryHasMore) html += moreButtonMarkup;
    $('employeeHistory').innerHTML = html;
  }
  function employeeHistoryMarkup(employeeId) {
    return '<div class="loading-state">جارٍ تحميل السجل...</div>';
  }
  function renderEmployeeDetail(employeeId) {
    var employee = employees.find(function (entry) { return String(entry.id) === String(employeeId); }); if (!employee) return;
    selectedEmployeeId = employee.id; var summary = employeeSummary(employee.id); var balanceClass = helpers && typeof helpers.getEmployeeBalanceColorClass === 'function' ? helpers.getEmployeeBalanceColorClass(summary.balance) : (summary.balance < 0 ? 'negative' : 'positive');
    $('employeeDetailTitle').textContent = employee.name; $('employeeDetailSummary').innerHTML = '<div><span>الرصيد الحالي</span><strong class="employee-balance-value ' + balanceClass + '">' + employeeCurrency(summary.balance) + '</strong></div><div><span>إجمالي الأجور</span><strong>' + employeeCurrency(summary.wages) + '</strong></div><div><span>إجمالي السلف</span><strong>' + employeeCurrency(summary.withdrawals) + '</strong></div><div><span>قيمة المنتجات</span><strong>' + employeeCurrency(summary.purchases) + '</strong></div>';
    employeeHistoryLastDoc = null; employeeHistoryRecords = []; employeeHistoryHasMore = false; loadEmployeeHistoryPage(employee.id, true); $('toggleEmployeeDayButton').hidden = true;
  }
  function employeeWithdrawalRemainingQuantity(operation) {
    if (!operation || String(operation.type || '').trim().toLowerCase() !== 'employee_withdrawal') return 0;
    var originalQuantity = Number(operation.quantity) || 0;
    if (originalQuantity <= 0) return 0;
    var alreadyReturned = (Array.isArray(employeeOperations) ? employeeOperations : []).filter(function (entry) {
      return entry && String(entry.type || '').trim().toLowerCase() === 'employee_withdrawal_return' && String(entry.originalOperationId || entry.originalOperation || '') === String(operation.id || '') && entry.status !== 'cancelled';
    }).reduce(function (sum, entry) { return sum + (Number(entry.quantity) || 0); }, 0);
    return Math.max(0, originalQuantity - alreadyReturned);
  }
  function employeeCanReturnGoods(operation) { return Boolean(operation && String(operation.type || '').trim().toLowerCase() === 'employee_withdrawal' && employeeWithdrawalRemainingQuantity(operation) > 0); }
  async function saveEmployee(event) {
    event.preventDefault();
    var id = String($('employeeId').value || '').trim() || 'employee_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    var existing = employees.find(function (entry) { return String(entry.id) === id; });
    var nextWageDisplay = Number($('employeeDailyWage').value) || 0;
    var nextWage = baseCurrency() === '' ? primary(nextWageDisplay) : nextWageDisplay;
    var wageHistory = existing && Array.isArray(existing.wageHistory) ? existing.wageHistory.slice() : [{ effectiveFrom: (existing && existing.startDate) || $('employeeStartDate').value, dailyWage: existing ? Number(existing.dailyWage) || 0 : nextWage }];
    if (!existing || Number(existing.dailyWage) !== nextWage) wageHistory.push({ effectiveFrom: employeeCurrentDay(), dailyWage: nextWage });
    var employee = { id: id, name: String($('employeeName').value || '').trim(), dailyWage: nextWage, wageHistory: wageHistory, startDate: $('employeeStartDate').value, status: $('employeeStatus').value || 'active', source: SOURCE, updatedAt: Date.now() };
    if (!employee.name || employee.dailyWage < 0 || !employee.startDate) return notify('يرجى إدخال بيانات الموظف كاملة');
    try { await db.collection('employees').doc(id).set(employee, { merge: true }); await logMobileAudit(existing ? 'update' : 'create', 'employee', id, (existing ? 'تعديل موظف: ' : 'إضافة موظف: ') + employee.name, { before: existing || null, after: employee }); await loadEmployeeData(); closeModal('employeeModal'); notify('تم حفظ الموظف'); } catch (error) { notify(error.message || 'تعذر حفظ الموظف'); }
  }
  async function toggleEmployeeDay() {
    if (!managerAccess || !selectedEmployeeId) return notify('لا تملك صلاحية تعديل حالة اليوم');
    var employee = employees.find(function (entry) { return String(entry.id) === String(selectedEmployeeId); }); if (!employee) return;
    var day = employeeCurrentDay(), dayRef = db.collection('employeeDays').doc(employeeDayId(employee.id, day)), wageRef = db.collection('employeeOperations').doc(employeeDayId(employee.id, day) + '_wage');
    try { await db.runTransaction(function (tx) {
      var employeeRef = db.collection('employees').doc(String(employee.id));
      return Promise.all([tx.get(dayRef), tx.get(employeeRef)]).then(function (snapshots) {
        var daySnapshot = snapshots[0];
        var employeeSnapshot = snapshots[1];
        var data = daySnapshot.exists ? daySnapshot.data() : null;
        var ownership = employeeOwnership();
        if (!data) {
          data = { id: dayRef.id, employeeId: employee.id, employeeName: employee.name, dateKey: day, dayName: dayLabel(Date.now()).split(' ')[0], status: 'work', dailyWage: Number(employee.dailyWage) || 0, createdAt: Date.now(), source: SOURCE };
        }
        var nextStatus = data.status === 'holiday' ? 'work' : 'holiday';
        tx.set(dayRef, Object.assign({}, data, { status: nextStatus, updatedAt: Date.now(), updatedBy: ownership.createdBy }), { merge: true });
        var employeeData = employeeSnapshot.exists ? employeeSnapshot.data() || {} : {};
        var currentBalance = Number(employeeData.currentBalance) || 0;
        var wageAmount = Number(data.dailyWage) || 0;
        if (nextStatus === 'holiday') {
          tx.delete(wageRef);
          tx.set(employeeRef, { currentBalance: currentBalance - wageAmount, updatedAt: Date.now() }, { merge: true });
          return;
        }
        tx.set(wageRef, { id: wageRef.id, employeeId: employee.id, employeeName: employee.name, type: 'wage', amount: wageAmount, dailyWage: wageAmount, dateKey: day, timestamp: employeeDayTimestamp(day), createdAt: Date.now(), note: 'أجرة دوام تلقائية', source: SOURCE, status: 'active', ownerId: ownership.ownerId, createdBy: ownership.createdBy });
        tx.set(employeeRef, { currentBalance: currentBalance + wageAmount, updatedAt: Date.now() }, { merge: true });
      });
    }); await logMobileAudit('employee', 'employee', employee.id, 'تعديل حالة دوام الموظف: ' + employee.name, { employeeId: employee.id, dateKey: day }); await loadEmployeeData(); notify('تم تعديل حالة اليوم'); } catch (error) { notify(error.message || 'تعذر تعديل حالة اليوم'); }
  }
  function openEmployeeForm(employee) {
    updateEmployeeCurrencyLabels(); $('employeeForm').reset(); $('employeeId').value = employee ? employee.id : ''; $('employeeTitle').textContent = employee ? 'تعديل موظف' : 'إضافة موظف'; $('employeeName').value = employee ? employee.name : ''; $('employeeDailyWage').value = employee ? employee.dailyWage : ''; $('employeeStartDate').value = employee ? employee.startDate : employeeCurrentDay(); $('employeeStatus').value = employee ? employee.status : 'active'; openModal('employeeModal');
  }
  function openEmployeeOperationDetail(operationId) {
    var operation = employeeOperations.find(function (entry) { return String(entry.id) === String(operationId); });
    if (!operation) return;
    var content = $('operationDetailContent');
    if (!content) return;
    var details = [
      ['الإجراء', employeeOperationLabel(operation.type)],
      ['المبلغ', employeeCurrency(employeeOperationAmount(operation), employeeOperationCurrency())],
      ['التاريخ', formatDateTime(operation.timestamp)],
      ['الملاحظات', operation.note || 'بدون ملاحظات']
    ];
    if (operation.itemName) details.push(['المنتج', operation.itemName]);
    if (Number(operation.quantity) > 0) details.push(['الكمية', String(operation.quantity)]);
    if (Number(operation.unitPrice) > 0) details.push(['سعر الوحدة', employeeCurrency(operation.unitPrice, employeeOperationCurrency())]);
    content.innerHTML = '<div class="operation-detail-field-list">' + details.map(function (field) { return '<div class="operation-detail-field"><span>' + esc(field[0]) + '</span><strong>' + esc(field[1]) + '</strong></div>'; }).join('') + '</div>';
    openModal('operationDetailModal');
  }
  function openEmployeeWithdrawal() {
    selectedEmployeeEditOperation = null; updateEmployeeCurrencyLabels(); var parts = getRiyadhDateTimeParts(Date.now()); $('employeeWithdrawalForm').reset(); $('withdrawalDate').value = parts.dateKey; $('confirmEmployeeWithdrawal').textContent = 'تأكيد السحب'; $('withdrawalTitle').textContent = 'سحب مال'; openModal('employeeWithdrawalModal');
  }
  function openEmployeeWithdrawalEditor(operationId) {
    var operation = employeeOperations.find(function (entry) { return String(entry.id) === String(operationId) && String(entry.type || '').trim().toLowerCase() === 'withdrawal'; });
    if (!operation) return notify('هذه العملية غير قابلة للتعديل');
    selectedEmployeeEditOperation = operation;
    $('employeeWithdrawalForm').reset();
    $('withdrawalAmount').value = Number(operation.amount) || 0;
    $('withdrawalDate').value = operation.dateKey || dayKey(operation.timestamp) || employeeCurrentDay();
    $('withdrawalNote').value = operation.note || '';
    $('withdrawalTitle').textContent = 'تعديل سحب مال';
    $('confirmEmployeeWithdrawal').textContent = 'حفظ التعديل';
    updateEmployeeCurrencyLabels();
    openModal('employeeWithdrawalModal');
  }
  async function cancelEmployeeWithdrawal(operationId) {
    var operation = employeeOperations.find(function (entry) { return String(entry.id) === String(operationId) && String(entry.type || '').trim().toLowerCase() === 'withdrawal'; });
    if (!operation) return notify('لا توجد عملية سحب قابلة للإلغاء');
    if (!confirm('هل تريد إلغاء هذا السحب؟')) return;
    var updatedOperation = Object.assign({}, operation, { status: 'cancelled', cancelled: true, isCancelled: true, cancelledAt: Date.now(), updatedAt: Date.now(), updatedBy: employeeOwnership().createdBy });
    try {
      await db.collection('employeeOperations').doc(operation.id).set(updatedOperation, { merge: true });
      await updateEmployeeStoredBalance(operation.employeeId, Number(operation.amount) || 0);
      await logMobileAudit('cancel', 'employee', operation.id, 'إلغاء سحب مال للموظف: ' + (currentEmployee && currentEmployee.name || ''), { before: operation, after: updatedOperation, employeeId: operation.employeeId, amount: operation.amount });
      await loadEmployeeData(); closeModal('operationDetailModal'); notify('تم إلغاء السحب');
    } catch (error) { notify(error.message || 'تعذر إلغاء السحب'); }
  }
  async function saveEmployeeWithdrawal(event) {
    event.preventDefault();
    if (!currentEmployee || currentEmployee.status === 'inactive' || String(currentEmployee.id) !== String(selectedEmployeeId)) return notify('هذا الموظف معطل ولا يمكنه تنفيذ العملية');
    var amountInput = $('withdrawalAmount');
    var dateInput = $('withdrawalDate');
    var amount = Number(String(amountInput.value || '').replace(/,/g, '')) || 0;
    var dateValue = String(dateInput.value || '').trim();
    if (!selectedEmployeeId || amount <= 0 || !dateValue) return notify('يرجى إدخال مبلغ صحيح وتاريخ السحب');
    if (!confirm('تأكد من صحة البيانات قبل الحفظ. بعد حفظ العملية لا يمكن تعديلها أو حذفها من هذه الصفحة.')) return;
    var submitButton = $('confirmEmployeeWithdrawal');
    if (submitButton) { submitButton.disabled = true; submitButton.textContent = 'جارٍ الحفظ...'; }
    try {
      var editTarget = selectedEmployeeEditOperation && String(selectedEmployeeEditOperation.type || '').trim().toLowerCase() === 'withdrawal' ? selectedEmployeeEditOperation : null;
      var operation = editTarget ? Object.assign({}, editTarget, {
        amount: amount,
        currency: editTarget.currency || employeeOperationCurrency(),
        rateAtTime: Number(editTarget.rateAtTime || currency.rate || 1) || 1,
        dateKey: dateValue,
        timestamp: buildDebtOperationTimestamp(dateValue, getRiyadhDateTimeParts(Date.now()).timeValue),
        note: String($('withdrawalNote').value || '').trim(),
        updatedAt: Date.now(),
        updatedBy: employeeOwnership().createdBy
      }) : { id: employeeOperationId(selectedEmployeeId, 'withdrawal'), employeeId: selectedEmployeeId, type: 'withdrawal', amount: amount, currency: employeeOperationCurrency(), rateAtTime: Number(currency.rate) || 1, dateKey: dateValue, timestamp: buildDebtOperationTimestamp(dateValue, getRiyadhDateTimeParts(Date.now()).timeValue), note: String($('withdrawalNote').value || '').trim(), status: 'active', source: SOURCE, createdAt: Date.now(), createdBy: employeeOwnership().createdBy };
      var balanceDelta = editTarget ? ((Number(editTarget.amount) || 0) - amount) : -amount;
      await db.collection('employeeOperations').doc(operation.id).set(operation, { merge: true });
      if (editTarget) {
        var employeeRef = db.collection('employees').doc(String(selectedEmployeeId));
        await db.runTransaction(function (tx) { return tx.get(employeeRef).then(function (snapshot) { var employeeDoc = snapshot.exists ? snapshot.data() || {} : {}; var currentBalance = Number(employeeDoc.currentBalance) || 0; tx.set(employeeRef, { currentBalance: currentBalance + balanceDelta, updatedAt: Date.now() }, { merge: true }); }); });
      } else {
        await updateEmployeeStoredBalance(selectedEmployeeId, balanceDelta);
      }
      await logMobileAudit('employee', 'employee', operation.id, (editTarget ? 'تعديل سحب مال: ' : 'سلفة موظف: ') + (currentEmployee.name || ''), { before: editTarget || null, after: operation, employeeId: operation.employeeId, amount: operation.amount });
      selectedEmployeeEditOperation = null;
      await loadEmployeeData(); closeModal('employeeWithdrawalModal'); notify(editTarget ? 'تم تعديل السحب' : 'تم تسجيل السحب');
    } catch (error) { notify(error.message || 'تعذر تسجيل السحب'); } finally { if (submitButton) { submitButton.disabled = false; submitButton.textContent = editTarget ? 'حفظ التعديل' : 'تأكيد السحب'; } }
  }
  function renderEmployeeProducts() {
    var query = String($('employeeProductSearch').value || '').trim().toLowerCase(); var available = items.filter(function (item) { return (Number(item.quantity) || 0) > 0 && (!query || String(item.name || '').toLowerCase().indexOf(query) !== -1); });
    $('employeeProductList').innerHTML = available.length ? available.map(function (item) { return '<button type="button" class="employee-product-option" data-employee-product-id="' + esc(item.id) + '"><strong>' + esc(item.name) + '</strong><span>' + money(item.quantity) + ' متوفر</span></button>'; }).join('') : '<div class="empty-state">لا توجد منتجات مطابقة</div>';
  }
  function selectEmployeeProduct(itemId) { var item = items.find(function (entry) { return String(entry.id) === String(itemId); }); if (!item) return; selectedEmployeePurchaseProduct = item; $('employeeSelectedProductName').textContent = item.name; $('employeeSelectedProductStock').textContent = 'المتوفر: ' + money(item.quantity); $('employeePurchaseQuantity').value = 1; $('employeePurchaseQuantity').max = item.quantity; $('employeePurchasePrice').value = Number(activeAmountFromPrimary(item.salePrice).toFixed(2)); $('employeePurchasePriceWarning').textContent = ''; $('employeeSelectedProduct').hidden = false; }
  function openEmployeePurchase() { employeeActionMode = 'purchase'; selectedEmployeePurchaseProduct = null; $('employeeProductSearch').value = ''; $('employeeSelectedProduct').hidden = true; $('employeePurchaseTitle').textContent = 'سحب منتج'; $('employeePurchaseModal').setAttribute('data-mode', employeeActionMode); renderEmployeeProducts(); openModal('employeePurchaseModal'); }
  function openEmployeeGoodsWithdrawal() { selectedEmployeeEditOperation = null; employeeActionMode = 'withdrawal'; selectedEmployeePurchaseProduct = null; $('employeeProductSearch').value = ''; $('employeeSelectedProduct').hidden = true; $('employeePurchaseTitle').textContent = 'سحب منتج'; $('employeePurchaseModal').setAttribute('data-mode', employeeActionMode); $('confirmEmployeePurchase').textContent = 'تأكيد سحب المنتج'; $('employeePurchaseNote').value = ''; renderEmployeeProducts(); openModal('employeePurchaseModal'); }
  function openEmployeeGoodsEdit(operationId) {
    var operation = employeeOperations.find(function (entry) { return String(entry.id) === String(operationId) && String(entry.type || '').trim().toLowerCase() === 'employee_withdrawal'; });
    if (!operation) return notify('هذه العملية غير قابلة للتعديل');
    selectedEmployeeEditOperation = operation;
    selectedEmployeePurchaseProduct = items.find(function (entry) { return String(entry.id) === String(operation.productId || operation.itemId); }) || null;
    if (!selectedEmployeePurchaseProduct) return notify('المنتج المرتبط بهذه العملية غير موجود');
    $('employeeProductSearch').value = ''; $('employeePurchaseTitle').textContent = 'تعديل سحب منتج'; $('confirmEmployeePurchase').textContent = 'حفظ التعديل'; $('employeePurchaseQuantity').value = Number(operation.quantity) || 0; $('employeePurchaseQuantity').max = Number(selectedEmployeePurchaseProduct.quantity) + (Number(operation.quantity) || 0); $('employeePurchasePrice').value = Number(operation.unitPrice || operation.amount / Math.max((Number(operation.quantity) || 1), 1)) || 0; $('employeePurchaseNote').value = operation.note || ''; $('employeeSelectedProductName').textContent = selectedEmployeePurchaseProduct.name; $('employeeSelectedProductStock').textContent = 'المتوفر: ' + money(Number(selectedEmployeePurchaseProduct.quantity) || 0); $('employeeSelectedProduct').hidden = false; openModal('employeePurchaseModal');
  }
  async function confirmEmployeeGoodsReturn(operationId) {
    if (!operationId) return;
    if (!confirm('تأكد من صحة البيانات قبل الحفظ. بعد حفظ الإرجاع لا يمكن تعديله أو حذفه من هذه الصفحة.')) return;
    var original = employeeOperations.find(function (entry) { return String(entry.id) === String(operationId) && String(entry.type || '').trim().toLowerCase() === 'employee_withdrawal'; });
    if (!original) return notify('لا توجد عملية سحب قابلة للإرجاع');
    var remaining = employeeWithdrawalRemainingQuantity(original);
    if (remaining <= 0) return notify('لا توجد كمية متبقية للإرجاع');
    var item = items.find(function (entry) { return String(entry.id) === String(original.productId || original.itemId); });
    if (!item) return notify('المنتج المرتبط بهذه العملية غير موجود');
    var returnQuantity = remaining;
    var returnAmount = (Number(original.amount) || 0) * (returnQuantity / (Number(original.quantity) || 1));
    var returnOperation = {
      id: employeeOperationId(selectedEmployeeId, 'employee_withdrawal_return'), employeeId: selectedEmployeeId,
      type: 'employee_withdrawal_return', originalOperationId: String(original.id), productId: item.id, itemId: item.id, itemName: item.name,
      quantity: returnQuantity, amount: returnAmount, currency: original.currency || 'primary', rateAtTime: Number(original.rateAtTime || currency.rate) || 1,
      dateKey: employeeCurrentDay(), timestamp: Date.now(), note: 'إرجاع بضاعة للموظف', status: 'returned', source: SOURCE, createdAt: Date.now(), createdBy: employeeOwnership().createdBy
    };
    var updatedOriginal = Object.assign({}, original, { status: 'returned', returned: true, returnedAt: Date.now(), updatedAt: Date.now(), updatedBy: employeeOwnership().createdBy });
    try {
      var itemRef = db.collection('items').doc(item.id);
      var operationRef = db.collection('employeeOperations').doc(returnOperation.id);
      var originalRef = db.collection('employeeOperations').doc(original.id);
      await db.runTransaction(function (tx) {
        var employeeRef = db.collection('employees').doc(String(selectedEmployeeId));
        return Promise.all([tx.get(itemRef), tx.get(employeeRef)]).then(function (snapshots) {
          var itemSnapshot = snapshots[0];
          var employeeSnapshot = snapshots[1];
          if (!itemSnapshot.exists) throw new Error('المنتج غير موجود');
          var data = itemSnapshot.data() || {};
          var beforeItem = Object.assign({ id: itemSnapshot.id }, data);
          var employeeData = employeeSnapshot.exists ? employeeSnapshot.data() || {} : {};
          var currentBalance = Number(employeeData.currentBalance) || 0;
          var afterItem = Object.assign({}, beforeItem, { quantity: (Number(data.quantity) || 0) + returnQuantity, updatedAt: Date.now() });
          tx.update(itemRef, { quantity: afterItem.quantity, updatedAt: afterItem.updatedAt });
          XMetalCapitalSummary.applyDeltaInTransaction(tx, beforeItem, afterItem);
          tx.set(operationRef, returnOperation);
          tx.set(originalRef, updatedOriginal, { merge: true });
          tx.set(employeeRef, { currentBalance: currentBalance + returnAmount, updatedAt: Date.now() }, { merge: true });
        });
      });
      await logMobileAudit('return', 'employee', original.id, 'إرجاع سحب منتج: ' + item.name, { before: original, after: updatedOriginal, returnOperation: returnOperation, employeeId: selectedEmployeeId, itemId: item.id, itemName: item.name, quantity: returnQuantity, amount: returnAmount });
      await loadEmployeeData(); closeModal('operationDetailModal'); notify('تم إرجاع البضاعة');
    } catch (error) { notify(error.message || 'تعذر إرجاع البضاعة'); }
  }
  async function confirmEmployeePurchase() {
    if (!currentEmployee || currentEmployee.status === 'inactive' || String(currentEmployee.id) !== String(selectedEmployeeId)) return notify('هذا الموظف معطل ولا يمكنه تنفيذ العملية');
    if (!confirm('تأكد من صحة البيانات قبل الحفظ. بعد حفظ العملية لا يمكن تعديلها أو حذفها من هذه الصفحة.')) return;
    var item = selectedEmployeePurchaseProduct;
    var quantity = Number($('employeePurchaseQuantity').value) || 0;
    var displayPrice = Number($('employeePurchasePrice').value) || 0;
    var saleMode = employeeOperationCurrency();
    var price = displayPrice;
    var purchasePriceInSaleCurrency = saleMode === '' ? (item && item.purchasePrice) : Number(item && item.purchasePrice) || 0;
    var noteText = String($('employeePurchaseNote').value || '').trim();
    if (!item || quantity <= 0) {
      $('employeePurchasePriceWarning').textContent = 'يرجى اختيار منتج وكمية صحيحة.';
      return;
    }
    if (selectedEmployeeEditOperation && String(selectedEmployeeEditOperation.type || '').trim().toLowerCase() === 'employee_withdrawal') {
      var existingOperation = selectedEmployeeEditOperation;
      var oldQuantity = Number(existingOperation.quantity) || 0;
      var quantityDelta = quantity - oldQuantity;
      var itemCurrentQuantity = Number(item.quantity) || 0;
      if (quantityDelta > itemCurrentQuantity) {
        $('employeePurchasePriceWarning').textContent = 'لا توجد كمية كافية في المخزون لتحديث هذه العملية.';
        return;
      }
      var updatedOperation = Object.assign({}, existingOperation, {
        productId: item.id,
        itemId: item.id,
        itemName: item.name,
        quantity: quantity,
        amount: quantity * price,
        unitPrice: price,
        currency: existingOperation.currency || saleMode,
        rateAtTime: Number(existingOperation.rateAtTime || currency.rate || 1) || 1,
        note: noteText || existingOperation.note || 'سحب بضاعة للموظف',
        updatedAt: Date.now(),
        updatedBy: employeeOwnership().createdBy
      });
      try {
        var editItemRef = db.collection('items').doc(item.id);
        await db.runTransaction(function (tx) {
          var employeeRef = db.collection('employees').doc(String(selectedEmployeeId));
          return Promise.all([tx.get(editItemRef), tx.get(employeeRef)]).then(function (snapshots) {
            var itemSnapshot = snapshots[0];
            var employeeSnapshot = snapshots[1];
            if (!itemSnapshot.exists) throw new Error('المنتج غير موجود');
            var data = itemSnapshot.data() || {};
            var beforeItem = Object.assign({ id: itemSnapshot.id }, data);
            var available = Number(data.quantity) || 0;
            if (quantityDelta > available) throw new Error('لا توجد كمية كافية في المخزون لتحديث هذه العملية.');
            var employeeData = employeeSnapshot.exists ? employeeSnapshot.data() || {} : {};
            var currentBalance = Number(employeeData.currentBalance) || 0;
            var oldAmount = Number(existingOperation.amount) || 0;
            var amountDelta = oldAmount - updatedOperation.amount;
            var afterItem = Object.assign({}, beforeItem, { quantity: available - quantityDelta, updatedAt: Date.now() });
            tx.update(editItemRef, { quantity: afterItem.quantity, updatedAt: afterItem.updatedAt });
            XMetalCapitalSummary.applyDeltaInTransaction(tx, beforeItem, afterItem);
            tx.set(db.collection('employeeOperations').doc(existingOperation.id), updatedOperation, { merge: true });
            tx.set(employeeRef, { currentBalance: currentBalance + amountDelta, updatedAt: Date.now() }, { merge: true });
          });
        });
        await logMobileAudit('employee', 'employee', existingOperation.id, 'تعديل سحب منتج: ' + item.name, { before: existingOperation, after: updatedOperation, employeeId: existingOperation.employeeId, itemId: item.id, itemName: item.name, quantity: quantity, amount: updatedOperation.amount });
        selectedEmployeeEditOperation = null;
        await loadEmployeeData();
        closeModal('employeePurchaseModal');
        notify('تم تعديل سحب المنتج');
        return;
      } catch (error) {
        $('employeePurchasePriceWarning').textContent = error.message || 'تعذر تعديل سحب المنتج';
        return;
      }
    }
    if (employeeActionMode === 'withdrawal') {
      var currentStock = Number(item.quantity) || 0;
      if (quantity > currentStock) {
        $('employeePurchasePriceWarning').textContent = 'الكمية المطلوبة أكبر من المخزون المتاح.';
        return;
      }
      var withdrawalUnitPrice = Number($('employeePurchasePrice').value || item.salePrice || 0) || 0;
      var withdrawalAmount = (Number(withdrawalUnitPrice) || 0) * (Number(quantity) || 0);
      var withdrawalOperation = {
        id: employeeOperationId(selectedEmployeeId, 'employee_withdrawal'), employeeId: selectedEmployeeId,
        type: 'employee_withdrawal', productId: item.id, itemId: item.id, itemName: item.name, quantity: quantity,
        amount: withdrawalAmount, unitPrice: withdrawalUnitPrice, currency: saleMode,
        rateAtTime: Number(currency.rate) || 1, dateKey: employeeCurrentDay(), timestamp: Date.now(), note: noteText || 'سحب بضاعة للموظف',
        status: 'active', source: SOURCE, createdAt: Date.now(), createdBy: employeeOwnership().createdBy
      };
      try {
        var withdrawalRef = db.collection('employeeOperations').doc(withdrawalOperation.id);
        var withdrawalItemRef = db.collection('items').doc(item.id);
        await db.runTransaction(function (tx) {
          var employeeRef = db.collection('employees').doc(String(selectedEmployeeId));
          return Promise.all([tx.get(withdrawalItemRef), tx.get(employeeRef)]).then(function (snapshots) {
            var itemSnapshot = snapshots[0];
            var employeeSnapshot = snapshots[1];
            if (!itemSnapshot.exists) throw new Error('المنتج غير موجود');
            var data = itemSnapshot.data() || {};
            var beforeItem = Object.assign({ id: itemSnapshot.id }, data);
            var available = Number(data.quantity) || 0;
            if (quantity > available) throw new Error('الكمية المتوفرة غير كافية');
            var employeeData = employeeSnapshot.exists ? employeeSnapshot.data() || {} : {};
            var currentBalance = Number(employeeData.currentBalance) || 0;
            var afterItem = Object.assign({}, beforeItem, { quantity: available - quantity, updatedAt: Date.now() });
            tx.update(withdrawalItemRef, { quantity: afterItem.quantity, updatedAt: afterItem.updatedAt });
            XMetalCapitalSummary.applyDeltaInTransaction(tx, beforeItem, afterItem);
            tx.set(withdrawalRef, withdrawalOperation);
            tx.set(employeeRef, { currentBalance: currentBalance - withdrawalAmount, updatedAt: Date.now() }, { merge: true });
          });
        });
        await logMobileAudit('employee', 'employee', withdrawalOperation.id, 'سحب بضاعة للموظف: ' + item.name, { employeeId: withdrawalOperation.employeeId, itemId: item.id, itemName: item.name, quantity: quantity, amount: withdrawalOperation.amount, after: withdrawalOperation });
        await loadEmployeeData();
        closeModal('employeePurchaseModal');
        notify('تم تسجيل سحب البضاعة');
        return;
      } catch (error) {
        $('employeePurchasePriceWarning').textContent = error.message || 'تعذر تسجيل سحب البضاعة';
        return;
      }
    }
    if (!item || quantity <= 0 || price < purchasePriceInSaleCurrency) {
      $('employeePurchasePriceWarning').textContent = 'لا يمكن بيع هذه القطعة بهذا السعر لأنه أقل من سعر الشراء الأساسي.';
      return;
    }
    var operation = {
      id: employeeOperationId(selectedEmployeeId, 'productPurchase'), employeeId: selectedEmployeeId,
      type: 'productPurchase', itemId: item.id, itemName: item.name, quantity: quantity,
      amount: price * quantity, unitPrice: price, currency: saleMode, rateAtTime: Number(currency.rate) || 1, purchasePriceAtTime: purchasePriceInSaleCurrency,
      dateKey: employeeCurrentDay(), timestamp: Date.now(), note: 'شراء منتج للموظف',
      status: 'active', source: SOURCE, createdAt: Date.now(), createdBy: employeeOwnership().createdBy
    };
    var employeePurchaseAmount = price * quantity;
    var employeeBalanceBeforePurchase = employeeBalance(selectedEmployeeId);
    var employeePaymentMethod = employeeBalanceBeforePurchase >= employeePurchaseAmount ? 'cash' : 'credit';
    var currentSeller = getCurrentSellerInfo();
    operation.paymentMethod = employeePaymentMethod;
    operation.balanceBefore = employeeBalanceBeforePurchase;
    operation.remainingAmount = employeePaymentMethod === 'cash' ? 0 : employeePurchaseAmount;
    var saleId = makeMobileSaleId();
    var saleUnitPricePrimary = saleMode === '' ? primary(price) : price;
    var sale = {
      saleId: saleId, itemId: item.id, itemName: item.name, quantity: quantity,
      unitPrice: saleUnitPricePrimary, totalAmount: saleUnitPricePrimary * quantity, baseAmount: saleUnitPricePrimary * quantity, baseCurrency: 'primary', saleRevision: 1,
      displayTotalAmount: price * quantity, rawTotalAmount: price * quantity,
      displayCurrency: saleMode,
      profit: (saleUnitPricePrimary - Number(item.purchasePrice || 0)) * quantity,
      purchasePriceAtTime: Number(item.purchasePrice || 0), timestamp: operation.timestamp,
      saleMode: saleMode, rateAtTime: saleMode === '' ? Number(currency.rate) || 1 : null, paymentMethod: employeePaymentMethod, source: SOURCE,
      employeePurchase: true, employeeId: selectedEmployeeId, employeeName: (employees.find(function (entry) { return String(entry.id) === String(selectedEmployeeId); }) || {}).name || '',
      sellerEmail: currentSeller.email, sellerName: currentSeller.name, user: currentSeller.email,
      employeeBalanceBefore: employeeBalanceBeforePurchase, employeeRemainingAmount: employeePaymentMethod === 'cash' ? 0 : employeePurchaseAmount
    };
    try {
      var itemRef = db.collection('items').doc(item.id);
      var employeeRef = db.collection('employees').doc(String(selectedEmployeeId));
      var operationRef = db.collection('employeeOperations').doc(operation.id);
      var saleRef = db.collection('sales').doc(saleId);
      await db.runTransaction(function (tx) {
        return Promise.all([tx.get(itemRef), tx.get(employeeRef)]).then(async function (snapshots) {
          var itemSnapshot = snapshots[0];
          var employeeSnapshot = snapshots[1];
          if (!itemSnapshot.exists) throw new Error('المنتج غير موجود');
          var data = itemSnapshot.data();
          var beforeItem = Object.assign({ id: itemSnapshot.id }, data);
          var available = Number(data.quantity) || 0;
          var transactionPurchasePrice = saleMode === '' ? (data.purchasePrice) : Number(data.purchasePrice) || 0;
          if (price < transactionPurchasePrice) throw new Error('لا يمكن بيع هذه القطعة بهذا السعر لأنه أقل من سعر الشراء الأساسي.');
          if (quantity > available) throw new Error('الكمية المتوفرة غير كافية');
          var batches = Array.isArray(data.purchaseBatches) ? data.purchaseBatches.filter(function (batch) { return batch && typeof batch === 'object'; }).slice() : [];
          var allocations = [];
          var left = quantity;
          batches.slice().sort(function (a, b) { return (a.timestamp || 0) - (b.timestamp || 0); }).forEach(function (batch) {
            if (left <= 0) return;
            var take = Math.min(Number(batch.quantity) || 0, left);
            if (take > 0) { allocations.push({ timestamp: batch.timestamp || null, unitCost: batch.unitCost || 0, quantity: take }); left -= take; }
          });
          if (batches.length && left > 0) throw new Error('الكمية المتوفرة غير كافية في دفعات الشراء');
          await window.DailySalesSummary.applySaleMutationInTransaction(tx, null, sale, 'create');
          if (batches.length) {
            allocations.forEach(function (allocation) {
              var remaining = allocation.quantity;
              batches.forEach(function (batch) {
                if (remaining > 0 && allocation.timestamp != null && batch.timestamp === allocation.timestamp) {
                  var take = Math.min(Number(batch.quantity) || 0, remaining);
                  batch.quantity = (Number(batch.quantity) || 0) - take;
                  remaining -= take;
                }
              });
            });
            var batchQuantity = batches.reduce(function (sum, batch) { return sum + (Number(batch.quantity) || 0); }, 0);
            var afterBatchItem = Object.assign({}, beforeItem, { purchaseBatches: batches, quantity: batchQuantity, updatedAt: Date.now() });
            tx.update(itemRef, { purchaseBatches: batches, quantity: batchQuantity, updatedAt: afterBatchItem.updatedAt });
            XMetalCapitalSummary.applyDeltaInTransaction(tx, beforeItem, afterBatchItem);
          } else {
            var afterSimpleItem = Object.assign({}, beforeItem, { quantity: available - quantity, updatedAt: Date.now() });
            tx.update(itemRef, { quantity: afterSimpleItem.quantity, updatedAt: afterSimpleItem.updatedAt });
            XMetalCapitalSummary.applyDeltaInTransaction(tx, beforeItem, afterSimpleItem);
          }
          var employeeData = employeeSnapshot.exists ? employeeSnapshot.data() || {} : {};
          var currentBalance = Number(employeeData.currentBalance) || 0;
          operation.purchaseBatchAllocations = allocations;
          sale.purchaseBatchAllocations = allocations;
          operation.saleId = saleId;
          tx.set(operationRef, operation);
          tx.set(saleRef, sale);
          tx.set(employeeRef, { currentBalance: currentBalance - operation.amount, updatedAt: Date.now() }, { merge: true });
        });
      });
      await logMobileActivity('sell', sale);
      await logMobileAudit('employee', 'employee', operation.id, 'شراء قطعة للموظف: ' + item.name, { employeeId: operation.employeeId, itemId: item.id, itemName: item.name, quantity: quantity, amount: operation.amount, after: operation });
      upsertSaleLocally(sale);
      renderHistory();
      await loadEmployeeData();
      closeModal('employeePurchaseModal');
      notify('تم تسجيل شراء المنتج');
    } catch (error) {
      $('employeePurchasePriceWarning').textContent = error.message || 'تعذر تسجيل شراء المنتج';
    }
  }

  function renderCreditCustomerList() {
    var list = $('creditCustomerList');
    if (!list) return;
    var addButton = '<button class="credit-customer-item credit-customer-add" type="button" data-credit-customer-add="true"><strong>+ إضافة عميل</strong></button>';
    if (!debtCustomers.length) {
      list.innerHTML = addButton;
      return;
    }
    list.innerHTML = addButton + debtCustomers.map(function (customer) {
      var summary = getDebtCustomerSummary(customer.id);
      var totalDebtDisplay = getActiveCurrencyDisplay(summary.totalDebt, 'primary');
      var totalPaymentDisplay = getActiveCurrencyDisplay(summary.totalPayment, 'primary');
      var phoneNumber = (customer.phone || '').replace(/[^0-9+]/g, '');
      var phoneMarkup = customer.phone ? '<a class="credit-customer-phone" href="tel:' + esc(phoneNumber) + '" target="_self">' + esc(customer.phone) + '</a>' : '<span class="credit-customer-phone is-empty">بدون هاتف</span>';
      return '<div class="credit-customer-item" role="button" tabindex="0" data-credit-customer-id="' + esc(customer.id) + '"><div class="credit-customer-main"><span class="credit-customer-name">' + esc(customer.name || 'عميل') + '</span><div class="credit-customer-meta">' + phoneMarkup + '<span class="credit-customer-separator">|</span><span class="credit-customer-due">الديون المستحقة: ' + esc(money(totalDebtDisplay.value) + ' ' + totalDebtDisplay.symbol) + '</span><span class="credit-customer-separator">|</span><span class="credit-customer-paid">الديون المسددة: ' + esc(money(totalPaymentDisplay.value) + ' ' + totalPaymentDisplay.symbol) + '</span></div></div></div>';
    }).join('');
  }

  function openCreditCustomerPicker() {
    renderCreditCustomerList();
    openModal('creditCustomerModal');
  }

  function openDebtsModal() {
    loadDebtData().then(function () { renderDebtList(); }).catch(function () { renderDebtList(); });
    openModal('debtsModal');
  }

  function openDebtActionModal(customerId, type) {
    var customer = debtCustomers.find(function (entry) { return String(entry.id) === String(customerId); });
    if (!customer) return notify('العميل غير موجود');
    var actionType = String(type || 'debt').trim();
    var balance = getCustomerBalance(customer.id);
    if ((actionType === 'payment' || actionType === 'settle') && balance <= 0) {
      notify('لا يوجد رصيد مستحق لهذا العميل');
      return;
    }
    $('debtCustomerId').value = customer.id;
    $('debtActionType').value = actionType;
    $('debtOperationId').value = '';
    $('debtOperationMode').value = 'create';
    if ($('debtActionTypeDisplay')) $('debtActionTypeDisplay').value = actionType;
    if ($('debtActionTypeDisplay')) $('debtActionTypeDisplay').disabled = false;
    $('debtAmount').value = '';
    $('debtAmount').required = actionType !== 'settle';
    $('debtAmount').disabled = actionType === 'settle';
    var nowParts = getRiyadhDateTimeParts(Date.now());
    $('debtActionDate').value = nowParts.dateKey;
    $('debtActionDate').disabled = !allowDebtDateEditing;
    var dateTimeRow = document.querySelector('#debtActionDate').closest('.debt-date-time-row');
    if (dateTimeRow) dateTimeRow.hidden = !allowDebtDateEditing;
    $('debtActionTime').value = nowParts.timeValue;
    $('debtActionNote').value = '';
    $('debtActionTitle').textContent = actionType === 'payment' ? 'سداد جزئي' : actionType === 'settle' ? 'تأكيد السداد الكامل' : 'إضافة دين';
    var typeRow = $('debtActionTypeRow');
    var amountRow = $('debtAmountRow');
    var confirmRow = $('debtConfirmRow');
    var currentBalanceRow = $('debtCurrentBalanceRow');
    var submitButton = $('debtActionSubmit');
    var deleteButton = $('deleteDebtOperationButton');
var currentBalanceText = 'الدين الحالي: ' + formatDisplayMoney(Math.abs(balance), 'primary');

    if (typeRow) typeRow.hidden = true;
    if (amountRow) amountRow.hidden = actionType === 'settle';
    if (confirmRow) confirmRow.hidden = actionType !== 'settle';
    if (currentBalanceRow) {
      currentBalanceRow.hidden = actionType === 'debt';
      currentBalanceRow.textContent = currentBalanceText;
    }
    if (submitButton) {
      submitButton.textContent = actionType === 'payment' ? 'تأكيد السداد' : actionType === 'settle' ? 'تأكيد السداد الكامل' : 'حفظ الدين';
    }
    if (deleteButton) deleteButton.hidden = true;
    if (actionType === 'settle') {
      var confirmBalance = $('debtConfirmBalance');
      if (confirmBalance) confirmBalance.textContent = currentBalanceText;
    }
    openModal('debtActionModal');
  }

  async function finalizePaidSaleRefund(saleId) {
    return finalizeSaleCancellation(saleId, 'refund');
    if (activeSaleCancellations.has(String(saleId))) return notify('جاري معالجة إلغاء هذه العملية');
    activeSaleCancellations.add(String(saleId));
    try {
    var sale = await resolveCurrentSaleRecord(saleId, true);
    if (!sale) return;
    if (String(sale.status || '').toLowerCase() === 'cancelled' || sale.cancelled || sale.isCancelled) {
      notify('تم إلغاء هذه العملية مسبقًا');
      return;
    }
    var paidAmount = helpers.getSalePaidAmount ? helpers.getSalePaidAmount(sale, debtOperations) : 0;
    var saleRef = db.collection('sales').doc(saleId);
    if (String(sale.status || '').toLowerCase() !== 'cancellationpending') {
      await saleRef.set(Object.assign({}, sale, { status: 'cancellationPending', cancellationStartedAt: Date.now() }), { merge: true });
    }
    var linkedDebtOperation = helpers.findLinkedDebtOperation ? helpers.findLinkedDebtOperation(sale, debtOperations) : null;
    var saleKey = helpers.normalizeIdValue ? helpers.normalizeIdValue(sale.saleId || sale.id || sale.relatedSaleId || sale.linkedSaleId || sale.debtOperationId || sale.relatedDebtOperationId || sale.linkedDebtOperationId || sale.saleDebtOperationId) : String(sale.saleId || '').trim();
    var customerId = sale.customerId || (linkedDebtOperation && linkedDebtOperation.customerId) || null;
    var item = (Array.isArray(items) ? items : []).find(function (entry) { return entry && entry.id === sale.itemId; });
    if (!item) {
      try {
        var itemDoc = await db.collection('items').doc(sale.itemId).get();
        if (itemDoc.exists) item = Object.assign({ id: itemDoc.id }, itemDoc.data());
      } catch (error) { notify('تعذر الوصول إلى المنتج المرتبط بالبيع'); return; }
    }
    if (!item || !item.id) { notify('المنتج المرتبط بعملية البيع غير موجود'); return; }

    var paymentEntries = debtOperations.filter(function (entry) {
      if (!entry || String(entry.customerId || '') !== String(customerId || '')) return false;
      if (entry.type !== 'payment' && entry.type !== 'settle') return false;
      if (Array.isArray(entry.allocations) && entry.allocations.length) {
        return entry.allocations.some(function (allocation) { return String(allocation.saleId || allocation.relatedSaleId || allocation.linkedSaleId || '') === String(saleKey); });
      }
      return String(entry.saleId || entry.relatedSaleId || entry.linkedSaleId || '') === String(saleKey);
    });

    for (var i = 0; i < paymentEntries.length; i += 1) {
      var paymentEntry = paymentEntries[i];
      if (Array.isArray(paymentEntry.allocations) && paymentEntry.allocations.length) {
        var keptAllocations = paymentEntry.allocations.filter(function (allocation) { return String(allocation.saleId || allocation.relatedSaleId || allocation.linkedSaleId || '') !== String(saleKey); });
        var nextPayment = Object.assign({}, paymentEntry, { allocations: keptAllocations.length ? keptAllocations : paymentEntry.allocations.map(function (allocation) { return Object.assign({}, allocation, { status: 'cancelled', cancelledSaleId: saleKey, cancelledAt: Date.now() }); }), amount: keptAllocations.reduce(function (sum, allocation) { return sum + (Number(allocation.amount) || 0); }, 0), status: keptAllocations.length ? 'active' : 'cancelled', refundedSaleId: saleKey, refundedAt: Date.now() });
        if (!keptAllocations.length) {
          await db.collection('debtOperations').doc(paymentEntry.id).set(nextPayment);
          debtOperations = debtOperations.map(function (entry) { return String(entry.id) === String(paymentEntry.id) ? nextPayment : entry; });
        } else {
          await db.collection('debtOperations').doc(paymentEntry.id).set(nextPayment, { merge: true });
          debtOperations = debtOperations.map(function (entry) { return String(entry.id) === String(paymentEntry.id) ? nextPayment : entry; });
        }
      } else {
        var cancelledPayment = Object.assign({}, paymentEntry, { status: 'cancelled', refundedSaleId: saleKey, refundedAt: Date.now() });
        await db.collection('debtOperations').doc(paymentEntry.id).set(cancelledPayment);
        debtOperations = debtOperations.map(function (entry) { return String(entry.id) === String(paymentEntry.id) ? cancelledPayment : entry; });
      }
    }

    if (linkedDebtOperation) {
      try {
        await db.collection('debtOperations').doc(linkedDebtOperation.id).delete();
        debtOperations = debtOperations.filter(function (entry) { return String(entry.id) !== String(linkedDebtOperation.id); });
      } catch (error) {
        throw error;
      }
    }

    var safeSaleAllocations = sanitizeBatchAllocations(sale.purchaseBatchAllocations);
    var restored = sale.inventoryRestored ? { quantity: item.quantity, purchaseBatches: item.purchaseBatches } : (safeSaleAllocations.length ? await restoreBatches(item.id, safeSaleAllocations) : await updateQuantity(item.id, sale.quantity));
    if (restored === null || restored === undefined || (typeof restored === 'object' && restored.quantity === undefined)) { notify('تعذر استرجاع كمية المنتج المرتبط'); return; }
    sale = Object.assign({}, sale, { status: 'cancellationPending', inventoryRestored: true, inventoryRestoredAt: Date.now() });
    await saleRef.set(sale, { merge: true });

    await saleRef.delete();
    await updateStats(-(Number(sale.profit) || 0));
    await logMobileActivity('return', sale, { before: sale, after: { status: 'returned', inventoryRestored: true }, refundAmount: paidAmount, customerId: sale.customerId || null, inventoryQuantity: sale.quantity });
    item.quantity = typeof restored === 'number' ? restored : restored.quantity;
    if (typeof restored === 'object' && restored.purchaseBatches) item.purchaseBatches = restored.purchaseBatches;
    var localItemIndex = items.findIndex(function (entry) { return entry && entry.id === item.id; });
    if (localItemIndex >= 0) items[localItemIndex] = item; else items.push(item);
    sales = sales.filter(function (entry) { return !entry || String(entry.saleId) !== String(saleId); });
    renderProducts(); renderHistory(); renderDebtList();
    notify(CANCEL_SALE_SUCCESS_MESSAGE);
    } finally {
      activeSaleCancellations.delete(String(saleId));
    }
  }

  async function finalizePaidSaleOldDebt(saleId) {
    return finalizeSaleCancellation(saleId, 'oldDebt');
    var sale = await resolveCurrentSaleRecord(saleId);
    if (!sale) return;
    var linkedDebtOperation = helpers.findLinkedDebtOperation ? helpers.findLinkedDebtOperation(sale, debtOperations) : null;
    var saleKey = helpers.normalizeIdValue ? helpers.normalizeIdValue(sale.saleId || sale.id || sale.relatedSaleId || sale.linkedSaleId || sale.debtOperationId || sale.relatedDebtOperationId || sale.linkedDebtOperationId || sale.saleDebtOperationId) : String(sale.saleId || '').trim();
    var customerId = sale.customerId || (linkedDebtOperation && linkedDebtOperation.customerId) || null;
    var item = (Array.isArray(items) ? items : []).find(function (entry) { return entry && entry.id === sale.itemId; });
    if (!item) {
      try {
        var itemDoc = await db.collection('items').doc(sale.itemId).get();
        if (itemDoc.exists) item = Object.assign({ id: itemDoc.id }, itemDoc.data());
      } catch (error) { notify('تعذر الوصول إلى المنتج المرتبط بالبيع'); return; }
    }
    if (!item || !item.id) { notify('المنتج المرتبط بعملية البيع غير موجود'); return; }

    if (!(paidAmount > 0)) { notify('لا توجد دفعات مرتبطة بهذه العملية'); return; }

    var paymentEntries = debtOperations.filter(function (entry) {
      if (!entry || String(entry.customerId || '') !== String(customerId || '')) return false;
      if (entry.type !== 'payment' && entry.type !== 'settle') return false;
      if (Array.isArray(entry.allocations) && entry.allocations.length) {
        return entry.allocations.some(function (allocation) { return String(allocation.saleId || allocation.relatedSaleId || allocation.linkedSaleId || '') === String(saleKey); });
      }
      return String(entry.saleId || entry.relatedSaleId || entry.linkedSaleId || '') === String(saleKey);
    });
    for (var i = 0; i < paymentEntries.length; i += 1) {
      var paymentEntry = paymentEntries[i];
      if (Array.isArray(paymentEntry.allocations) && paymentEntry.allocations.length) {
        var keptAllocations = paymentEntry.allocations.filter(function (allocation) { return String(allocation.saleId || allocation.relatedSaleId || allocation.linkedSaleId || '') !== String(saleKey); });
        var nextPayment = Object.assign({}, paymentEntry, { allocations: keptAllocations, amount: keptAllocations.reduce(function (sum, allocation) { return sum + (Number(allocation.amount) || 0); }, 0), status: 'active' });
        if (!keptAllocations.length) {
          await db.collection('debtOperations').doc(paymentEntry.id).delete();
          debtOperations = debtOperations.filter(function (entry) { return String(entry.id) !== String(paymentEntry.id); });
        } else {
          await db.collection('debtOperations').doc(paymentEntry.id).set(nextPayment, { merge: true });
          debtOperations = debtOperations.map(function (entry) { return String(entry.id) === String(paymentEntry.id) ? nextPayment : entry; });
        }
      } else {
        await db.collection('debtOperations').doc(paymentEntry.id).delete();
        debtOperations = debtOperations.filter(function (entry) { return String(entry.id) !== String(paymentEntry.id); });
      }
    }
    if (linkedDebtOperation) {
      try {
        var queuedCancelledDebt = Object.assign({}, linkedDebtOperation, { status: 'cancelled', cancelledSaleId: saleKey, cancelledAt: Date.now() });
        await db.collection('debtOperations').doc(linkedDebtOperation.id).set(queuedCancelledDebt);
        debtOperations = debtOperations.map(function (entry) { return String(entry.id) === String(linkedDebtOperation.id) ? queuedCancelledDebt : entry; });
      } catch (error) {
        throw error;
      }
    }

    var remainingSales = sales.filter(function (entry) { return entry && entry.saleId !== saleId && String(entry.customerId || '') === String(customerId || ''); });
    var remainingDebtBalance = customerId ? helpers.getCustomerDebtBalance(customerId, remainingSales, debtOperations) : 0;
    var paymentType = paidAmount >= Math.max(0, Number(remainingDebtBalance) || 0) ? 'settle' : 'payment';
    var nowParts = getRiyadhDateTimeParts(Date.now());
    var newPayment = {
      id: 'debt_op_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      customerId: customerId,
      customerName: sale.customerName || '',
      type: paymentType,
      amount: paidAmount,
      note: 'سداد عن ديون قديمة',
      dateKey: nowParts.dateKey,
      operationDate: nowParts.dateKey,
      operationTime: nowParts.timeValue,
      timestamp: Date.now(),
      source: SOURCE,
      saleId: null,
      relatedSaleId: null,
      linkedSaleId: null,
      userId: getCurrentUserOwnership().userId || null,
      ownerId: getCurrentUserOwnership().ownerId || null,
      createdBy: getCurrentUserOwnership().createdBy || null,
      uid: getCurrentUserOwnership().uid || null,
      status: 'active'
    };
    newPayment.allocations = createPaymentAllocations(customerId, paidAmount, newPayment.id, remainingSales);
    await db.collection('debtOperations').doc(newPayment.id).set(newPayment);
    upsertDebtOperationLocally(newPayment);

    var safeSaleAllocations = sanitizeBatchAllocations(sale.purchaseBatchAllocations);
    var restored = safeSaleAllocations.length ? await restoreBatches(item.id, safeSaleAllocations) : await updateQuantity(item.id, sale.quantity);
    if (restored === null || restored === undefined || (typeof restored === 'object' && restored.quantity === undefined)) { notify('تعذر استرجاع كمية المنتج المرتبط'); return; }

    var cancelledSale = Object.assign({}, sale, { status: 'cancelled', cancelled: true, isCancelled: true, cancelledAt: Date.now(), cancellationReason: 'استرجاع بيع آجل مسدد', refundedAmount: paidAmount || (helpers.getSaleReferenceAmount ? helpers.getSaleReferenceAmount(sale) : Number(sale.displayTotalAmount || sale.rawTotalAmount || sale.totalAmount || sale.amount) || 0) || 0 });
    await db.collection('sales').doc(saleId).set(cancelledSale);
    await updateStats(-(Number(sale.profit) || 0));
    await logMobileActivity('return', sale, { before: sale, after: cancelledSale, refundAmount: paidAmount, customerId: sale.customerId || null, inventoryQuantity: sale.quantity });
    item.quantity = typeof restored === 'number' ? restored : restored.quantity;
    if (typeof restored === 'object' && restored.purchaseBatches) item.purchaseBatches = restored.purchaseBatches;
    var localItemIndex = items.findIndex(function (entry) { return entry && entry.id === item.id; });
    if (localItemIndex >= 0) items[localItemIndex] = item; else items.push(item);
    upsertSaleLocally(cancelledSale);
    renderProducts(); renderHistory(); renderDebtList();
    notify(CANCEL_SALE_SUCCESS_MESSAGE);
  }

  function getPaymentEntriesForSale(saleKey, customerId, operationList) {
    return (Array.isArray(operationList) ? operationList : []).filter(function (entry) {
      if (!entry || String(entry.customerId || '') !== String(customerId || '') || (entry.type !== 'payment' && entry.type !== 'settle')) return false;
      if (Array.isArray(entry.allocations) && entry.allocations.length) {
        return entry.allocations.some(function (allocation) { return String(allocation.saleId || allocation.relatedSaleId || allocation.linkedSaleId || '') === String(saleKey); });
      }
      return String(entry.saleId || entry.relatedSaleId || entry.linkedSaleId || '') === String(saleKey);
    });
  }

  function getOldDebtBalanceForCancellation(sale, saleKey, customerId, paymentEntries, linkedDebtOperation) {
    if (!customerId || !helpers.getCustomerDebtBalance) return 0;
    var paymentIds = new Set(paymentEntries.map(function (entry) { return String(entry.id); }));
    var oldOperations = debtOperations.filter(function (entry) {
      if (!entry || paymentIds.has(String(entry.id))) return false;
      return !linkedDebtOperation || String(entry.id) !== String(linkedDebtOperation.id);
    });
    var oldSales = sales.filter(function (entry) { return entry && String(entry.saleId) !== String(saleKey); });
    return Math.max(0, Number(helpers.getCustomerDebtBalance(customerId, oldSales, oldOperations)) || 0);
  }

  function replaceSalePaymentAllocations(paymentEntries, saleKey, disposition, replacementAllocations) {
    var replacements = (replacementAllocations || []).map(function (allocation) { return Object.assign({}, allocation); });
    function takeReplacement(amount) {
      var left = Number(amount) || 0, result = [];
      while (left > 0.005 && replacements.length) {
        var next = replacements[0], available = Number(next.amount) || 0, take = Math.min(left, available);
        if (take > 0) result.push(Object.assign({}, next, { amount: take }));
        left -= take;
        next.amount = available - take;
        if (next.amount <= 0.005) replacements.shift();
      }
      if (left > 0.005) throw new Error('مبلغ السداد لا يغطي التخصيص المطلوب');
      return result;
    }
    return paymentEntries.map(function (paymentEntry) {
      var updated = Object.assign({}, paymentEntry);
      if (Array.isArray(paymentEntry.allocations) && paymentEntry.allocations.length) {
        updated.allocations = [];
        paymentEntry.allocations.forEach(function (allocation) {
          var matches = String(allocation.saleId || allocation.relatedSaleId || allocation.linkedSaleId || '') === String(saleKey);
          if (!matches) updated.allocations.push(Object.assign({}, allocation));
          else if (disposition === 'refund') updated.allocations.push(Object.assign({}, allocation, { status: 'refunded', refundedSaleId: saleKey, refundedAt: Date.now() }));
          else updated.allocations = updated.allocations.concat(takeReplacement(allocation.amount));
        });
      } else {
        var directAmount = Number(paymentEntry.amount) || 0;
        updated.allocations = disposition === 'refund' ? [{ saleId: saleKey, amount: directAmount, customerId: paymentEntry.customerId, paymentId: paymentEntry.id, status: 'refunded', refundedSaleId: saleKey, refundedAt: Date.now() }] : takeReplacement(directAmount);
      }
      updated.status = 'active';
      return updated;
    });
  }

  async function createSaleRefundTreasuryOperation(sale, amount) {
    if (!(amount > 0)) return;
    var id = 'refund_sale_' + sale.saleId;
    var operation = { id: id, type: 'refund', amount: amount, currency: sale.saleMode || baseCurrency(), rateAtTime: sale.rateAtTime != null ? sale.rateAtTime : null, saleId: sale.saleId, customerId: sale.customerId || null, timestamp: Date.now(), createdAt: Date.now(), source: SOURCE, status: 'active', note: 'رد مبلغ بيع ملغى' };
    await db.collection('treasuryOperations').doc(id).set(operation, { merge: true });
  }

  async function finalizeSaleCancellation(saleId, disposition, refundFromCash) {
    if (activeSaleCancellations.has(String(saleId))) return notify('جاري معالجة إلغاء هذه العملية');
    activeSaleCancellations.add(String(saleId));
    try {
      var sale = await resolveCurrentSaleRecord(saleId, true);
      sale = helpers.normalizeSaleForCancellation ? helpers.normalizeSaleForCancellation(sale) : sale;
      if (!sale) return;
      if (String(sale.status || '').toLowerCase() === 'cancelled' || sale.cancelled || sale.isCancelled) return notify('تم إلغاء هذه العملية مسبقًا');
      if (String(sale.status || '').toLowerCase() === 'returned' || sale.returned) return notify('تم استرجاع هذه العملية مسبقًا');
      if (String(sale.status || '').toLowerCase() === 'cancellationpending' && sale.inventoryRestored) return notify('جاري معالجة إلغاء هذه العملية');
      var saleKey = helpers.normalizeIdValue ? helpers.normalizeIdValue(sale.saleId || sale.id) : String(sale.saleId || sale.id || '').trim();
      var linkedDebtOperation = helpers.findLinkedDebtOperation ? helpers.findLinkedDebtOperation(sale, debtOperations) : null;
      var customerId = sale.customerId || (linkedDebtOperation && linkedDebtOperation.customerId) || null;
      var saleAmount = helpers.getSaleReferenceAmount ? helpers.getSaleReferenceAmount(sale) : Number(sale.displayTotalAmount || sale.rawTotalAmount || sale.totalAmount || sale.amount) || 0;
      var isCreditSale = String(sale.paymentMethod || '').toLowerCase() === 'credit' || sale.isCreditSale === true;
      var refundAmount = isCreditSale ? Number(refundFromCash) : saleAmount;
      if (!Number.isFinite(refundAmount) || refundAmount < 0 || refundAmount > saleAmount) throw new Error('يرجى إدخال مبلغ رد صحيح بين 0 وقيمة البيع');
      var item = items.find(function (entry) { return entry && entry.id === sale.itemId; });
      if (!item) { var itemDoc = await db.collection('items').doc(sale.itemId).get(); if (itemDoc.exists) item = Object.assign({ id: itemDoc.id }, itemDoc.data()); }
      if (!item || !item.id) throw new Error('المنتج المرتبط بعملية البيع غير موجود');
      var allocations = sanitizeBatchAllocations(sale.purchaseBatchAllocations);
      var restored = sale.inventoryRestored ? { quantity: item.quantity, purchaseBatches: item.purchaseBatches } : (allocations.length ? await restoreBatches(item.id, allocations) : { quantity: await updateQuantity(item.id, sale.quantity) });
      if (!restored || restored.quantity === undefined) throw new Error('تعذر استرجاع كمية المنتج المرتبط');
      var cancelledDebtOperation = linkedDebtOperation ? Object.assign({}, linkedDebtOperation, { amount: 0, originalAmount: Number(linkedDebtOperation.amount) || saleAmount, status: 'returned', returnedSaleId: saleKey, returnedAt: Date.now() }) : null;
      if (cancelledDebtOperation) await db.collection('debtOperations').doc(cancelledDebtOperation.id).set(cancelledDebtOperation, { merge: true });
      if (isCreditSale) {
        var returnOperation = { id: 'return_sale_' + saleKey, customerId: customerId, customerName: sale.customerName || '', type: 'return', amount: saleAmount, currency: sale.saleMode || baseCurrency(), saleId: saleKey, relatedSaleId: saleKey, status: 'active', timestamp: Date.now(), source: SOURCE, note: 'استرجاع بيع آجل' };
        await db.collection('debtOperations').doc(returnOperation.id).set(returnOperation, { merge: true });
        upsertDebtOperationLocally(returnOperation);
      }
      if (refundAmount > 0) await createSaleRefundTreasuryOperation(sale, refundAmount);
      var cancelledSale = Object.assign({}, sale, { saleRevision: (Number(sale.saleRevision) || 1) + 1, status: isCreditSale ? 'returned' : 'cancelled', cancelled: !isCreditSale, isCancelled: !isCreditSale, returned: isCreditSale, inventoryRestored: true, inventoryRestoredAt: Date.now(), cancellationReason: isCreditSale ? 'استرجاع بيع آجل' : 'إلغاء البيع' });
      if (isCreditSale) cancelledSale.returnedAt = Date.now();
      else cancelledSale.cancelledAt = Date.now();
      await db.runTransaction(function (tx) {
        var saleRef = db.collection('sales').doc(saleId);
        return tx.get(saleRef).then(function (snapshot) {
          if (!snapshot.exists) throw new Error('بيع غير موجود');
          var currentSale = Object.assign({ saleId: snapshot.id }, snapshot.data());
          if ((Number(currentSale.saleRevision) || 1) !== (Number(sale.saleRevision) || 1)) throw new Error('SALE_REVISION_CONFLICT');
          return window.DailySalesSummary.applySaleMutationInTransaction(tx, currentSale, cancelledSale, 'cancel').then(function () {
            tx.set(saleRef, cancelledSale, { merge: true });
          });
        });
      });
      if (window.ProductSalesSummary && window.ProductSalesSummary.applySaleDelete) {
        await window.ProductSalesSummary.applySaleDelete(sale);
      }
      if (window.MonthlySalesSummary && window.MonthlySalesSummary.applySaleDelete) {
        try {
          await window.MonthlySalesSummary.applySaleDelete(sale);
        } catch (summaryErr) {
          console.warn('MonthlySalesSummary mobile sale delete failed', summaryErr);
        }
      }
      await logMobileActivity(isCreditSale ? 'return' : 'cancel', sale, { before: sale, after: cancelledSale, refundAmount: refundAmount, customerId: customerId, debtBefore: linkedDebtOperation && linkedDebtOperation.amount || 0, debtAfter: isCreditSale ? 0 : null, inventoryQuantity: sale.quantity });
      item.quantity = restored.quantity; if (restored.purchaseBatches) item.purchaseBatches = restored.purchaseBatches;
      var itemIndex = items.findIndex(function (entry) { return entry && entry.id === item.id; });
      if (itemIndex >= 0) items[itemIndex] = item; else items.push(item);
      upsertSaleLocally(cancelledSale); if (cancelledDebtOperation) upsertDebtOperationLocally(cancelledDebtOperation);
      renderProducts(); renderHistory(); renderDebtList();
      if (cashboxLoaded) { cashboxEntries = buildCashboxEntries(); renderCashbox(); }
      notify(isCreditSale ? RETURN_SALE_SUCCESS_MESSAGE : CANCEL_SALE_SUCCESS_MESSAGE);
    } finally { activeSaleCancellations.delete(String(saleId)); }
  }

  async function returnSale(saleId) {
    try {
      if (!saleId) return;
      var sale = await resolveCurrentSaleRecord(saleId, true);
      if (!sale) return;
      var saleAmount = helpers.getSaleReferenceAmount ? helpers.getSaleReferenceAmount(sale) : Number(sale.displayTotalAmount || sale.rawTotalAmount || sale.totalAmount || sale.amount) || 0;
      var suggestedCashAmount = helpers.getReturnSaleSuggestedCashAmount ? helpers.getReturnSaleSuggestedCashAmount(sale, sales, debtOperations) : 0;
      pendingReturnSaleId = saleId;
      $('returnSaleCashAmount').value = String(Math.min(saleAmount, Number(suggestedCashAmount) || 0));
      $('returnSaleCashAmount').max = String(saleAmount);
      $('returnSaleError').textContent = '';
      var itemValue = $('returnSaleItemValue');
      if (itemValue) {
        var returnSaleDisplay = getActiveCurrencyDisplay(saleAmount, 'primary');
        itemValue.textContent = 'قيمة القطعة: ' + money(returnSaleDisplay.value) + ' ' + returnSaleDisplay.symbol;
      }
      var hint = $('returnSaleCashHint');
      if (hint) hint.textContent = 'المبلغ المقترح هو قيمة هذه العملية فقط ويمكن تعديله قبل تأكيد الاسترجاع.';
      openModal('returnSaleModal');
    } catch (error) { notify(error.message || 'تعذر فتح الاسترجاع'); }
  }

  function openDebtOperationEditor(operationId) {
    var operation = debtOperations.find(function (entry) { return String(entry.id) === String(operationId); });
    if (!operation) return notify('الحركة غير موجودة');
    var linkedSale = helpers.findSaleByDebtOperation ? helpers.findSaleByDebtOperation(operation, sales) : null;
    if (linkedSale) {
      closeModal('customerDetailModal');
      openEditSale(linkedSale);
      return;
    }
    var customer = debtCustomers.find(function (entry) { return String(entry.id) === String(operation.customerId || ''); });
    if (!customer) return notify('العميل غير موجود');
    $('debtCustomerId').value = customer.id;
    $('debtActionType').value = operation.type || 'debt';
    $('debtOperationId').value = operation.id;
    $('debtOperationMode').value = 'edit';
    if ($('debtActionTypeDisplay')) $('debtActionTypeDisplay').value = operation.type || 'debt';
    $('debtAmount').value = Number(operation.amount) || 0;
    $('debtAmount').required = true;
    $('debtAmount').disabled = false;
    var operationDateParts = getRiyadhDateTimeParts(Number(operation.timestamp) || Date.now());
    $('debtActionDate').value = operation.dateKey || operationDateParts.dateKey;
    $('debtActionDate').disabled = false;
    var dateTimeRow = document.querySelector('#debtActionDate').closest('.debt-date-time-row');
    if (dateTimeRow) dateTimeRow.hidden = false;
    $('debtActionTime').value = operation.operationTime || operationDateParts.timeValue;
    $('debtActionNote').value = operation.note || '';
    $('debtActionTitle').textContent = 'تعديل الحركة';

    var typeRow = $('debtActionTypeRow');
    var amountRow = $('debtAmountRow');
    var confirmRow = $('debtConfirmRow');
    var currentBalanceRow = $('debtCurrentBalanceRow');
    var submitButton = $('debtActionSubmit');
    var deleteButton = $('deleteDebtOperationButton');

    if (typeRow) typeRow.hidden = false;
    if ($('debtActionTypeDisplay')) $('debtActionTypeDisplay').disabled = true;
    if (amountRow) amountRow.hidden = false;
    if (confirmRow) confirmRow.hidden = true;
    if (currentBalanceRow) {
      currentBalanceRow.hidden = true;
      currentBalanceRow.textContent = '';
    }
    if (submitButton) submitButton.textContent = 'حفظ التعديلات';
    if (deleteButton) deleteButton.hidden = false;
    openModal('debtActionModal');
  }

  async function resolveCurrentSaleRecord(saleId, forceLive) {
    var normalizedId = helpers.normalizeIdValue ? helpers.normalizeIdValue(saleId) : String(saleId || '').trim();
    if (!normalizedId) return null;
    var localSales = Array.isArray(sales) ? sales : [];
    var localMatch = localSales.find(function (entry) { return entry && String(entry.saleId || entry.id || '') === normalizedId; });
    if (!forceLive && localMatch && localMatch.quantity !== null && localMatch.quantity !== undefined) {
      return Object.assign({}, localMatch, { saleId: normalizedId });
    }
    if (!db || !db.collection) return localMatch ? Object.assign({}, localMatch, { saleId: normalizedId }) : null;
    try {
      var snapshot = await db.collection('sales').doc(normalizedId).get();
      if (snapshot && snapshot.exists) {
        var fresh = Object.assign({ saleId: snapshot.id }, snapshot.data());
        upsertSaleLocally(fresh);
        return fresh;
      }
    } catch (error) {
      console.warn('Unable to resolve live sale record before cancel', error);
    }
    return localMatch ? Object.assign({}, localMatch, { saleId: normalizedId }) : null;
  }

  async function syncSalesFromFirestore() {
    if (!db || !db.collection) return;
    try {
      var snapshot = await db.collection('sales').where('source', '==', SOURCE).get();
      sales = snapshot.docs.map(function (doc) { return Object.assign({ saleId: doc.id }, doc.data()); });
      if (typeof renderHistory === 'function') renderHistory();
    } catch (error) {
      console.warn('Unable to sync sales from Firestore', error);
    }
  }

  async function loadDebtData() {
    try {
      var currentUser = auth && auth.currentUser ? auth.currentUser : null;
      if (!currentUser) {
        debtCustomers = [];
        debtOperations = [];
        renderDebtList();
        return;
      }

      var uid = currentUser.uid ? String(currentUser.uid).trim() : '';
      var email = currentUser.email ? String(currentUser.email).trim() : '';
      var collectionRefs = {
        customers: db.collection('debtCustomers'),
        operations: db.collection('debtOperations')
      };

      var customerRequests = [];
      if (uid) {
        customerRequests.push(collectionRefs.customers.where('userId', '==', uid).get());
        customerRequests.push(collectionRefs.customers.where('uid', '==', uid).get());
        customerRequests.push(collectionRefs.customers.where('ownerId', '==', uid).get());
      }
      if (email) {
        customerRequests.push(collectionRefs.customers.where('createdBy', '==', email).get());
        customerRequests.push(collectionRefs.customers.where('ownerEmail', '==', email).get());
      }
      if (!customerRequests.length) {
        customerRequests.push(collectionRefs.customers.get());
      }

      var operationRequests = [];
      if (uid) {
        operationRequests.push(collectionRefs.operations.where('userId', '==', uid).get());
        operationRequests.push(collectionRefs.operations.where('uid', '==', uid).get());
        operationRequests.push(collectionRefs.operations.where('ownerId', '==', uid).get());
      }
      if (email) {
        operationRequests.push(collectionRefs.operations.where('createdBy', '==', email).get());
        operationRequests.push(collectionRefs.operations.where('ownerEmail', '==', email).get());
      }
      if (!operationRequests.length) {
        operationRequests.push(collectionRefs.operations.orderBy('timestamp', 'desc').get());
      }

      var [customerResults, operationResults] = await Promise.all([
        Promise.all(customerRequests),
        Promise.all(operationRequests)
      ]);

      var customerMap = new Map();
      customerResults.forEach(function (querySnapshot) {
        if (!querySnapshot || !querySnapshot.docs) return;
        querySnapshot.docs.forEach(function (doc) {
          var data = Object.assign({ id: doc.id }, doc.data());
          if (!customerMap.has(data.id)) customerMap.set(data.id, data);
        });
      });

      var operationMap = new Map();
      operationResults.forEach(function (querySnapshot) {
        if (!querySnapshot || !querySnapshot.docs) return;
        querySnapshot.docs.forEach(function (doc) {
          var data = Object.assign({ id: doc.id }, doc.data());
          if (!operationMap.has(data.id)) operationMap.set(data.id, data);
        });
      });

      debtCustomers = Array.from(customerMap.values());
      debtOperations = Array.from(operationMap.values()).sort(function (a, b) { return timestampValue(b.timestamp) - timestampValue(a.timestamp); });
      renderDebtList();
    } catch (error) {
      debtCustomers = [];
      debtOperations = [];
      renderDebtList();
      console.warn('Debt customer load failed from Firestore', error);
    }
  }

  async function saveDebtCustomer(event) {
    event.preventDefault();
    var form = event.target;
    var nameInput = form && form.id === 'debtCustomerForm' ? $('debtCustomerName') : $('customerName');
    var phoneInput = form && form.id === 'debtCustomerForm' ? $('debtCustomerPhone') : $('customerPhone');
    var notesInput = form && form.id === 'debtCustomerForm' ? $('debtCustomerNotes') : $('customerNotes');
    var name = String(nameInput ? nameInput.value || '' : '').trim();
    var phone = String(phoneInput ? phoneInput.value || '' : '').trim();
    var notes = String(notesInput ? notesInput.value || '' : '').trim();
    if (!name) { notify('يرجى إدخال اسم العميل'); return; }
    var shouldResumeCreditPicker = form && form.id === 'debtCustomerForm' && pendingCreditCustomerReturn;
    if (shouldResumeCreditPicker) pendingCreditCustomerReturn = false;
    var ownership = getCurrentUserOwnership();
    var customer = {
      id: 'debt_customer_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      name: name,
      phone: phone,
      notes: notes,
      createdAt: Date.now(),
      source: SOURCE,
      userId: ownership.userId,
      ownerId: ownership.ownerId,
      createdBy: ownership.createdBy,
      uid: ownership.uid
    };
    try {
      await db.collection('debtCustomers').doc(customer.id).set(customer);
      await logMobileAudit('create', 'customer', customer.id, 'إضافة عميل: ' + customer.name, { customerId: customer.id, customerName: customer.name, after: customer });
      await loadDebtData();
      renderDebtList();
      if (form && form.id === 'debtCustomerForm') {
        form.reset();
        closeModal('debtCustomerModal');
        if (shouldResumeCreditPicker) {
          renderCreditCustomerList();
          openCreditCustomerPicker();
          notify('تم إضافة العميل بنجاح');
          return;
        }
        if ($('debtPage').hidden === false) {
          openDebtCustomerDetail(customer.id).catch(function () {});
        }
      } else {
        $('customerForm').reset();
      }
      notify('تم إضافة العميل بنجاح');
    } catch (error) {
      renderDebtList();
      if (form && form.id === 'debtCustomerForm') {
        form.reset();
        closeModal('debtCustomerModal');
        if (shouldResumeCreditPicker) {
          renderCreditCustomerList();
          openCreditCustomerPicker();
        }
      } else {
        $('customerForm').reset();
      }
      notify(error.message || 'تعذر حفظ العميل');
      throw error;
    }
  }

  function createPaymentAllocations(customerId, paymentAmount, paymentId, customSales, customDebtOperations) {
    var customerSales = (Array.isArray(customSales) ? customSales : (Array.isArray(sales) ? sales : [])).filter(function (sale) {
      if (!sale || String(sale.customerId) !== String(customerId)) return false;
      if (sale.cancelled || sale.status === 'cancelled' || sale.isCancelled) return false;
      if (helpers.isOriginalCreditSale) return helpers.isOriginalCreditSale(sale);
      return sale.paymentMethod === 'credit' || sale.isCreditSale;
    });
    var remaining = Number(paymentAmount) || 0;
    var allocations = [];
    var salesSource = Array.isArray(customSales) ? customSales : sales;
    var operationsSource = Array.isArray(customDebtOperations) ? customDebtOperations : debtOperations;
    var salePaymentMap = helpers.getCustomerSalePaymentAllocations ? helpers.getCustomerSalePaymentAllocations(salesSource, operationsSource)[String(customerId)] || {} : {};
    var obligations = customerSales.map(function (sale) {
      var saleId = helpers.normalizeIdValue ? helpers.normalizeIdValue(sale.saleId || sale.id || sale.debtOperationId || sale.relatedSaleId || sale.relatedDebtOperationId || sale.linkedSaleId || sale.linkedDebtOperationId || sale.saleDebtOperationId) : String(sale.saleId || sale.id || '').trim();
      return { kind: 'sale', id: saleId, date: timestampValue(sale.timestamp), amount: Number(sale.displayTotalAmount || sale.rawTotalAmount || sale.totalAmount || sale.amount || 0) || 0, paid: Number(salePaymentMap[saleId]) || 0 };
    }).filter(function (entry) { return entry.id && entry.amount > entry.paid; });
    var directDebtEntries = (Array.isArray(operationsSource) ? operationsSource : []).filter(function (entry) {
        if (!entry || String(entry.customerId || '') !== String(customerId)) return false;
        if (entry.status === 'cancelled' || entry.status === 'deleted') return false;
        var type = String(entry.type || '').trim().toLowerCase();
        if (type !== 'debt') return false;
        return !(entry.saleId || entry.relatedSaleId || entry.linkedSaleId || entry.debtSaleId || entry.objectId || '');
      }).map(function (entry) {
        var debtId = helpers.normalizeIdValue ? helpers.normalizeIdValue(entry.id || entry.debtOperationId || entry.operationId) : String(entry.id || entry.debtOperationId || entry.operationId || '').trim();
        var progress = helpers.getDebtOperationPaymentProgress ? helpers.getDebtOperationPaymentProgress(entry, operationsSource) : { paidAmount: 0 };
        return { kind: 'debt', id: debtId, date: getOperationDateValue(entry), amount: Number(entry.amount) || 0, paid: Number(progress && progress.paidAmount) || 0 };
      }).filter(function (entry) { return entry.id && entry.amount > entry.paid; });
    obligations = obligations.concat(directDebtEntries).sort(function (a, b) {
      return a.date - b.date || (a.kind === 'sale' ? -1 : 1);
    });
    obligations.forEach(function (obligation) {
      if (remaining <= 0) return;
      var available = Math.max(0, obligation.amount - obligation.paid);
      var amount = Math.min(remaining, available);
      if (amount <= 0) return;
      var allocation = { amount: amount, customerId: customerId, paymentId: paymentId, status: 'active' };
      if (obligation.kind === 'sale') allocation.saleId = obligation.id;
      else allocation.debtOperationId = obligation.id;
      allocations.push(allocation);
      remaining -= amount;
    });

    return allocations;
  }

  function rebuildCustomerDebtOperations(customerId, operationList) {
    var customerOperations = (Array.isArray(operationList) ? operationList : []).filter(function (entry) {
      return entry && String(entry.customerId || '') === String(customerId) && entry.status !== 'cancelled' && entry.status !== 'deleted';
    }).sort(function (a, b) {
      return getOperationDateValue(a) - getOperationDateValue(b);
    });
    var rebuilt = [];
    var runningBalance = 0;
    customerOperations.forEach(function (entry) {
      var updated = Object.assign({}, entry);
      var type = String(updated.type || '').trim().toLowerCase();
      if (type === 'debt') {
        runningBalance += Number(updated.amount) || 0;
      } else if (type === 'payment' || type === 'settle') {
        updated.type = runningBalance > 0 && Number(updated.amount) >= runningBalance ? 'settle' : 'payment';
        updated.note = updated.type === 'settle' ? (updated.note || 'سداد كامل') : (updated.note === 'سداد كامل' ? '' : updated.note);
        updated.allocations = createPaymentAllocations(customerId, Number(updated.amount) || 0, updated.id, sales, rebuilt);
        runningBalance = Math.max(0, runningBalance - (Number(updated.amount) || 0));
      }
      rebuilt.push(updated);
    });

    rebuilt.forEach(function (entry) {
      if (String(entry.type || '').trim().toLowerCase() !== 'debt') return;
      var progress = helpers.getDebtOperationPaymentProgress ? helpers.getDebtOperationPaymentProgress(entry, rebuilt) : null;
      entry.status = progress && progress.isPaid ? 'settled' : 'active';
    });
    return rebuilt;
  }

  async function persistRebuiltDebtOperations(customerId, operationList) {
    var rebuilt = rebuildCustomerDebtOperations(customerId, operationList);
    var rebuiltById = new Map(rebuilt.map(function (entry) { return [String(entry.id), entry]; }));
    var customerOperations = operationList.filter(function (entry) {
      return entry && String(entry.customerId || '') === String(customerId) && rebuiltById.has(String(entry.id));
    });
    await Promise.all(customerOperations.map(function (original) {
      var updated = rebuiltById.get(String(original.id));
      return db.collection('debtOperations').doc(updated.id).set(updated);
    }));
    return operationList.map(function (entry) {
      return rebuiltById.get(String(entry.id)) || entry;
    });
  }

  async function saveDebtOperation(event) {
    event.preventDefault();
    var customerId = $('debtCustomerId').value;
    var mode = String($('debtOperationMode').value || 'create').trim();
    var operationId = String($('debtOperationId').value || '').trim();
    var type = String($('debtActionType').value || ($('debtActionTypeDisplay') ? $('debtActionTypeDisplay').value : '') || 'debt').trim();
    var amount = Number($('debtAmount').value) || 0;
    var dateValue = $('debtActionDate').value || getRiyadhDateTimeParts(Date.now()).dateKey;
    var timeValue = $('debtActionTime').value || getRiyadhDateTimeParts(Date.now()).timeValue;
    var actualTimestamp = buildDebtOperationTimestamp(dateValue, timeValue);
    var note = String($('debtActionNote').value || '').trim();
    if (!customerId) { notify('العميل غير موجود'); return; }
    var customer = debtCustomers.find(function (entry) { return String(entry.id) === String(customerId); });
    if (!customer) { notify('العميل غير موجود'); return; }

    var existingOperation = mode === 'edit' && operationId ? debtOperations.find(function (entry) { return String(entry.id) === String(operationId); }) : null;
    var operationsWithoutEdited = existingOperation ? debtOperations.filter(function (entry) { return String(entry.id) !== String(operationId); }) : debtOperations;

    if (type === 'debt') {
      if (amount <= 0) { notify('يرجى إدخال مبلغ صحيح'); return; }
    } else if (type === 'payment') {
      if (amount <= 0) { notify('يرجى إدخال مبلغ السداد'); return; }
      var currentBalance = Math.max(0, Number(helpers.getCustomerDebtBalance(customerId, sales, operationsWithoutEdited)) || 0);
      if (currentBalance > 0 && Math.abs(amount - currentBalance) <= 0.005) {
        type = 'settle';
        amount = currentBalance;
        note = note || 'سداد كامل';
      }
    } else if (type === 'settle') {
      amount = mode === 'edit' && existingOperation ? amount : Math.max(0, Number(helpers.getCustomerDebtBalance(customerId, sales, operationsWithoutEdited)) || 0);
      if (amount <= 0) { notify('لا يوجد دين مستحق للسداد'); return; }
      note = note || 'سداد كامل';
    }

    var ownership = getCurrentUserOwnership();

    if (mode === 'edit' && operationId) {
      if (!existingOperation) { notify('الحركة المراد تعديلها غير موجودة'); return; }
      var updatedOperation = Object.assign({}, existingOperation, {
        customerId: customerId,
        type: type,
        amount: amount,
        currency: existingOperation.currency || baseCurrency(),
        note: note,
        dateKey: dateValue,
        operationDate: dateValue,
        operationTime: timeValue,
        timestamp: actualTimestamp,
        source: SOURCE,
        customerName: customer.name,
        userId: ownership.userId,
        ownerId: ownership.ownerId,
        createdBy: ownership.createdBy,
        uid: ownership.uid,
        status: 'active'
      });
      try {
        var candidateOperations = operationsWithoutEdited.concat([updatedOperation]);
        var rebuiltOperations = await persistRebuiltDebtOperations(customerId, candidateOperations);
        debtOperations = debtOperations.map(function (entry) {
          return rebuiltOperations.find(function (rebuiltEntry) { return String(rebuiltEntry.id) === String(entry.id); }) || entry;
        });
        await loadDebtData();
        renderDebtList();
        closeModal('debtActionModal');
        if (customerId) {
          openDebtCustomerDetail(customerId).catch(function () {});
        }
        notify('تم تعديل الحركة');
        await logMobileAudit('update', 'debt', updatedOperation.id, 'تعديل حركة دين للعميل: ' + customer.name, { customerId: customer.id, customerName: customer.name, before: existingOperation, after: updatedOperation, debtBefore: debtBeforeOperation, debtAfter: Math.max(0, Number(helpers.getCustomerDebtBalance(customerId, sales, debtOperations)) || 0), amount: amount });
      } catch (error) {
        throw error;
      }
      return;
    }

    var operation = {
      id: 'debt_op_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      customerId: customerId,
      type: type,
      amount: amount,
      currency: baseCurrency(),
      note: note,
      dateKey: dateValue,
      operationDate: dateValue,
      operationTime: timeValue,
      timestamp: actualTimestamp,
      source: SOURCE,
      customerName: customer.name,
      userId: ownership.userId,
      ownerId: ownership.ownerId,
      createdBy: ownership.createdBy,
      uid: ownership.uid,
      status: 'active'
    };
    if (type === 'payment' || type === 'settle') {
      operation.allocations = createPaymentAllocations(customerId, operation.amount, operation.id);
      if (operation.currency === '') {
        var historicalSale = operation.allocations.map(function (allocation) {
          return sales.find(function (sale) {
            return sale && String(sale.saleId || sale.id) === String(allocation.saleId || '');
          });
        }).find(function (sale) {
          return sale && Number(sale.rateAtTime) > 0;
        });
        if (historicalSale) operation.rateAtTime = Number(historicalSale.rateAtTime);
      }
    }
    try {
      await db.collection('debtOperations').doc(operation.id).set(operation);
      await loadDebtData();
      upsertDebtOperationLocally(operation);
      closeModal('debtActionModal');
      if (customerId) {
        openDebtCustomerDetail(customerId).catch(function () {});
      }
      notify(type === 'payment' ? 'تم تسجيل السداد' : type === 'settle' ? 'تم تسجيل السداد الكامل' : 'تم إضافة الدين');
      await logMobileAudit(type === 'payment' || type === 'settle' ? type : 'debt', 'debt', operation.id, (type === 'payment' || type === 'settle' ? 'سداد دين للعميل: ' : 'إضافة دين للعميل: ') + customer.name, { customerId: customer.id, customerName: customer.name, amount: operation.amount, paymentType: type, debtBefore: debtBeforeOperation, debtAfter: Math.max(0, debtBeforeOperation + (type === 'debt' ? amount : -amount)), cashboxAmount: type === 'payment' || type === 'settle' ? amount : null, cashboxBefore: cashboxBeforeOperation, cashboxAfter: type === 'payment' || type === 'settle' ? cashboxBeforeOperation + amount : null, after: operation });
    } catch (error) {
      throw error;
    }
  }

  async function deleteDebtOperation(operationId) {
    var operation = debtOperations.find(function (entry) { return String(entry.id) === String(operationId); });
    if (!operation) return notify('الحركة غير موجودة');
    try {
      var remainingOperations = debtOperations.filter(function (entry) { return String(entry.id) !== String(operation.id); });
      await db.collection('debtOperations').doc(operation.id).delete();
      await persistRebuiltDebtOperations(operation.customerId, remainingOperations);
      await loadDebtData();
      debtOperations = debtOperations.filter(function (entry) { return String(entry.id) !== String(operation.id); });
      renderDebtList();
      closeModal('debtActionModal');
      if (operation.customerId) {
        openDebtCustomerDetail(operation.customerId).catch(function () {});
      }
      await logMobileAudit('delete', 'debt', operation.id, 'حذف حركة دين للعميل: ' + (operation.customerName || operation.customerId || ''), { before: operation, customerId: operation.customerId, amount: operation.amount });
      notify('تم حذف الحركة');
    } catch (error) {
      throw error;
    }
  }

  function renderHistory() {
    try {
    Promise.resolve(refreshUserDisplayNameMap()).catch(function () {});
    var ordered = (Array.isArray(sales) ? sales : []).filter(function (sale) { return !isSaleHiddenFromHistory(sale); }).slice().sort(function (a, b) { return timestampValue(b.timestamp) - timestampValue(a.timestamp); });
    var shown = ordered.slice(0, historyVisibleCount), previousDay = null, dailyTotals = {}, html = '';
    shown.forEach(function (sale) {
      var saleDay = dayKey(sale.timestamp);
      dailyTotals[saleDay] = (dailyTotals[saleDay] || 0) + saleDisplayTotal(sale);
    });
    shown.forEach(function (sale, index) {
      var currentDay = dayKey(sale.timestamp);
      if (currentDay !== previousDay) {
        html += '<div class="history-day"><strong>' + esc(dayLabel(sale.timestamp)) + '</strong><span>إجمالي مبيعات اليوم: ' + money(dailyTotals[currentDay]) + ' ' + esc(activeSymbol()) + '</span></div>';
        previousDay = currentDay;
      }
      var warningBadge = sale.priceWarningLevel && sale.priceWarningLevel !== 'none' ? '<button type="button" class="warning-badge ' + esc(sale.priceWarningLevel) + '" data-warning-sale="' + esc(sale.saleId) + '" aria-label="عرض سبب التنبيه">!</button>' : '';
      var sellerLabel = getSellerLabel(sale);
      var isCreditSale = sale.paymentMethod === 'credit' || sale.isCreditSale === true;
      var paymentState = { isPaid: false };
      var saleTypeLabel = sale.employeePurchase ? (isCreditSale ? 'بيع آجل للموظف' : 'بيع كاش للموظف') : (isCreditSale ? 'آجل' : 'كاش');
      var statusKey = String(sale.status || '').trim().toLowerCase();
      var isCancelledSale = sale.cancelled || sale.isCancelled || statusKey === 'cancelled';
      var saleStatusLabel = isCancelledSale ? 'ملغاة / مسترجعة' : '';
      var customerText = sale.employeePurchase ? '<span>الموظف: ' + esc(sale.employeeName || 'موظف') + '</span>' : (sale.customerName ? '<span>العميل: ' + esc(sale.customerName) + '</span>' : '');
      var statusMarkup = isCreditSale ? (customerText || '<span>حالة: ' + esc(saleStatusLabel) + '</span>') : customerText;
      var settledClass = '';
      var actionLabel = isCreditSale ? 'استرجاع' : 'إلغاء البيع';
      var actionClass = isCreditSale ? 'return-sale-button' : 'cancel-sale';
      var sourceCurrencyCode = sale.baseCurrency || sale.saleMode || sale.displayCurrency || sale.currency || 'primary';
      var saleUnitDisplay = getDisplayMoney(sale.saleMode === '' || sourceCurrencyCode === '' ? saleDisplayUnit(sale) : (Number(sale.baseUnitPrice != null ? sale.baseUnitPrice : sale.unitPrice) || 0), sourceCurrencyCode, currency);
      var saleTotalDisplay = getDisplayMoney(saleDisplayTotal(sale), sourceCurrencyCode, currency);
      html += '<article class="sale-record' + settledClass + (isCreditSale ? ' credit-sale' : '') + (sale.employeePurchase && !isCreditSale ? ' employee-cash-sale' : '') + ' ' + (sale.priceWarningLevel && sale.priceWarningLevel !== 'none' ? 'has-price-warning ' + esc(sale.priceWarningLevel) : '') + '" data-sale-payment-state="' + esc(String(isCreditSale ? 'credit' : 'cash')) + '"><div class="sale-number" aria-label="رقم العملية">' + (index + 1) + '</div><h3>' + esc(sale.itemName || 'منتج') + warningBadge + '</h3>' +
        '<div class="sale-meta"><span>' + esc(date(sale.timestamp)) + '</span><span>البائع: ' + esc(sellerLabel) + '</span></div>' +
        '<div class="sale-meta"><span>نوع البيع: ' + esc(saleTypeLabel) + '</span>' + (statusMarkup || '') + '</div>' +
        '<p class="sale-total">سعر القطعة: <span class="sale-unit-value">' + money(saleUnitDisplay.value) + ' ' + esc(saleUnitDisplay.symbol) + '</span> × الكمية: <span class="sale-quantity-value">' + money(sale.quantity) + '</span> = الإجمالي: <span class="sale-grand-total">' + money(saleTotalDisplay.value) + ' ' + esc(saleTotalDisplay.symbol) + '</span></p>' +
        '<div class="record-actions"><button type="button" data-edit-sale="' + esc(sale.saleId) + '">تعديل الكمية/السعر</button>' +
        '<button type="button" class="' + actionClass + '" data-' + (isCreditSale ? 'return' : 'cancel') + '-sale="' + esc(sale.saleId) + '">' + actionLabel + '</button></div></article>';
    });
    if (!ordered.length) html = '<div class="empty-state">لا توجد عمليات بيع حتى الآن</div>';
    else if (shown.length < ordered.length) html += '<button class="load-more" id="loadMoreSales" type="button">عرض المزيد</button>';
    $('salesHistory').innerHTML = html;
    } catch (error) {
      console.warn('تعذر عرض سجل المبيعات:', error);
      var historyElement = $('salesHistory');
      if (historyElement) historyElement.innerHTML = '<div class="empty-state">تعذر عرض السجل حاليًا</div>';
    }
  }

  async function updateQuantity(itemId, delta) {
    var ref = db.collection('items').doc(itemId);
    return db.runTransaction(function (tx) { return tx.get(ref).then(function (doc) {
      if (!doc.exists) throw new Error('المنتج غير موجود');
      var beforeItem = Object.assign({ id: doc.id }, doc.data());
      var current = Number(beforeItem.quantity) || 0, next = current + Number(delta);
      if (next < 0) throw new Error('الكمية المتوفرة غير كافية');
      var afterItem = Object.assign({}, beforeItem, { quantity: next, updatedAt: Date.now() });
      tx.update(ref, { quantity: next, updatedAt: afterItem.updatedAt });
      XMetalCapitalSummary.applyDeltaInTransaction(tx, beforeItem, afterItem);
      return next;
    }); });
  }

  function sanitizeBatchAllocations(source) {
    if (!Array.isArray(source)) return [];
    return source.filter(function (entry) { return entry && typeof entry === 'object'; });
  }

  function computeAllocations(item, quantity) {
    var left = Number(quantity) || 0, result = [];
    if (!item || !Array.isArray(item.purchaseBatches)) return result;
    (item.purchaseBatches || []).slice().sort(function (a, b) { return (a.timestamp || 0) - (b.timestamp || 0); }).forEach(function (batch) {
      if (left <= 0) return;
      var available = Number(batch && batch.quantity) || 0, take = Math.min(available, left);
      if (take > 0) { result.push({ timestamp: batch.timestamp || null, unitCost: batch.unitCost || 0, quantity: take }); left -= take; }
    });
    return left > 0 ? [] : result;
  }

  async function consumeBatches(itemId, allocations) {
    var ref = db.collection('items').doc(itemId);
    return db.runTransaction(function (tx) { return tx.get(ref).then(function (doc) {
      if (!doc.exists) throw new Error('المنتج غير موجود');
      var data = doc.data(), beforeItem = Object.assign({ id: doc.id }, data), batches = Array.isArray(data.purchaseBatches) ? data.purchaseBatches.filter(function (batch) { return batch && typeof batch === 'object'; }).slice() : [];
      (Array.isArray(allocations) ? allocations : []).filter(function (allocation) { return allocation && typeof allocation === 'object'; }).forEach(function (allocation) {
        var left = Number(allocation.quantity) || 0;
        if (left <= 0) return;
        batches.forEach(function (batch) {
          if (left > 0 && allocation.timestamp != null && batch.timestamp === allocation.timestamp) {
            var take = Math.min(Number(batch.quantity) || 0, left); batch.quantity = (Number(batch.quantity) || 0) - take; left -= take;
          }
        });
        batches.forEach(function (batch) { if (left > 0) { var take = Math.min(Number(batch.quantity) || 0, left); batch.quantity = (Number(batch.quantity) || 0) - take; left -= take; } });
        if (left > 0) throw new Error('الكمية المتوفرة غير كافية');
      });
      var total = batches.reduce(function (sum, batch) { return sum + (Number(batch.quantity) || 0); }, 0);
      var afterItem = Object.assign({}, beforeItem, { purchaseBatches: batches, quantity: total, updatedAt: Date.now() });
      tx.update(ref, { purchaseBatches: batches, quantity: total, updatedAt: afterItem.updatedAt });
      XMetalCapitalSummary.applyDeltaInTransaction(tx, beforeItem, afterItem); return { purchaseBatches: batches, quantity: total };
    }); });
  }

  async function restoreBatches(itemId, allocations) {
    var ref = db.collection('items').doc(itemId);
    return db.runTransaction(function (tx) { return tx.get(ref).then(function (doc) {
      if (!doc.exists) throw new Error('المنتج غير موجود');
      var data = doc.data(), beforeItem = Object.assign({ id: doc.id }, data), batches = Array.isArray(data.purchaseBatches) ? data.purchaseBatches.filter(function (batch) { return batch && typeof batch === 'object'; }).slice() : [];
      var safeAllocations = sanitizeBatchAllocations(allocations);
      safeAllocations.forEach(function (allocation) {
        var remaining = Number(allocation.quantity) || 0;
        if (remaining <= 0) return;
        var found = batches.find(function (batch) { return allocation.timestamp != null && batch.timestamp === allocation.timestamp; });
        if (found) found.quantity = (Number(found.quantity) || 0) + remaining;
        else batches.push({ quantity: remaining, unitCost: allocation.unitCost || 0, supplier: allocation.supplier || '', note: allocation.note || '', timestamp: allocation.timestamp || Date.now() });
      });
      var total = batches.reduce(function (sum, batch) { return sum + (Number(batch.quantity) || 0); }, 0);
      var afterItem = Object.assign({}, beforeItem, { purchaseBatches: batches, quantity: total, updatedAt: Date.now() });
      tx.update(ref, { purchaseBatches: batches, quantity: total, updatedAt: afterItem.updatedAt });
      XMetalCapitalSummary.applyDeltaInTransaction(tx, beforeItem, afterItem); return { purchaseBatches: batches, quantity: total };
    }); });
  }

  async function changeStock(item, delta, allocations) {
    if (allocations && allocations.length && item.purchaseBatches && item.purchaseBatches.length) {
      return delta < 0 ? consumeBatches(item.id, allocations) : restoreBatches(item.id, allocations);
    }
    return { quantity: await updateQuantity(item.id, delta) };
  }

  async function submitSale(event) {
    event.preventDefault();
    var paymentMethod = ($('salePaymentMethod').value || 'cash').toString();
    var creditCustomerId = ($('saleSelectedCustomerId').value || '').toString();
    var qtyInput = $('saleQuantity').value;
    var qty = Number(qtyInput);
    var enteredPrice = number($('salePrice').value);
    var availableStock = Number(selectedItem ? selectedItem.quantity : 0) || 0;
    var oldQty = editingSale ? Number(editingSale.quantity) || 0 : 0;
    var maxAllowedQty = Math.max(0, availableStock + oldQty);
    var displayedPrice = enteredPrice === null || !Number.isFinite(qty) || qty <= 0 ? null : enteredPrice / qty;
    if (!selectedItem || selectedItem.id === undefined || selectedItem.id === null || String(selectedItem.id).trim() === '' || !Number.isFinite(qty) || qty <= 0 || qty > maxAllowedQty || enteredPrice === null || enteredPrice < 0 || displayedPrice === null || displayedPrice < 0) {
      showError('saleError', 'يرجى إدخال كمية صالحة في حدود المخزون المتاح');
      return;
    }
    if (qty > availableStock + oldQty) { showError('saleError', 'الكمية المتوفلة غير كافية'); return; }
    if (paymentMethod === 'credit') {
      if (!creditCustomerId) {
        showError('saleError', 'يرجى اختيار العميل قبل تسجيل البيع الآجل.');
        return;
      }
      var creditCustomer = debtCustomers.find(function (customer) { return String(customer.id) === String(creditCustomerId); });
      if (!creditCustomer) {
        showError('saleError', 'العميل المحدد غير موجود.');
        return;
      }
    }
    var warning = getPriceWarning(primary(displayedPrice), selectedItem);
    if (warning.level !== 'none' && !unusualPriceApproved) { showPriceWarning(warning); return; }
    $('priceWarning').hidden = true;
    var button = (paymentMethod === 'credit' ? $('creditSaleButton') : $('cashSaleButton')) || $('saleForm').querySelector('button[type="submit"]');
    if (button) button.disabled = true;
    showError('saleError', '');
    try {
      if (!editingSale) {
        var allocations = selectedItem.purchaseBatches && selectedItem.purchaseBatches.length ? computeAllocations(selectedItem, qty) : null;
        if (selectedItem.purchaseBatches && selectedItem.purchaseBatches.length && !allocations.length) throw new Error('الكمية المتوفرة غير كافية');
        var stockResult = await changeStock(selectedItem, -qty, allocations);
        var cost = Number(selectedItem.purchasePrice) || 0;
        var currentSeller = getCurrentSellerInfo();
        var debtBeforeSale = paymentMethod === 'credit' ? getCustomerBalance(creditCustomerId) : null;
        var cashboxBeforeSale = paymentMethod === 'cash' ? buildCashboxEntries().reduce(function (sum, entry) { return sum + (Number(entry.amount) || 0); }, 0) : null;
        var saleUnitPrimary = baseCurrency() === '' ? primary(displayedPrice) : displayedPrice;
        var saleTotalPrimary = baseCurrency() === '' ? primary(Number($('salePrice').value) || 0) : (Number($('salePrice').value) || 0);
        var saleDisplayTotal = Number($('salePrice').value) || 0;
        var saleModeCode = baseCurrency();
        var sale = { itemId: selectedItem.id, itemName: selectedItem.name, quantity: qty, unitPrice: saleUnitPrimary, totalAmount: saleTotalPrimary, baseAmount: saleTotalPrimary, baseCurrency: 'primary', displayTotalAmount: saleDisplayTotal, rawTotalAmount: saleDisplayTotal, displayCurrency: saleModeCode, profit: (saleUnitPrimary - cost) * qty, purchasePriceAtTime: cost, rateAtTime: saleModeCode === '' ? Number(currency.rate) || 1 : null, timestamp: Date.now(), saleRevision: 1, sellerEmail: currentSeller.email, sellerName: currentSeller.name, user: currentSeller.email, saleMode: saleModeCode, source: SOURCE, priceType: warning.type, priceWarningLevel: warning.level, priceWarningPercent: warning.percent, priceWarningDirection: warning.direction, priceWarningReference: warning.reference, paymentMethod: paymentMethod };
        if (paymentMethod === 'credit') {
          var selectedCreditCustomer = debtCustomers.find(function (customer) { return String(customer.id) === String(creditCustomerId); });
          sale.customerId = selectedCreditCustomer ? selectedCreditCustomer.id : creditCustomerId;
          sale.customerName = selectedCreditCustomer ? selectedCreditCustomer.name : '';
          sale.isCreditSale = true;
        }
        sale.saleId = makeMobileSaleId();
        if (allocations) sale.purchaseBatchAllocations = allocations;
        try {
          await db.runTransaction(function (tx) {
            var saleRef = db.collection('sales').doc(sale.saleId);
            return window.DailySalesSummary.applySaleMutationInTransaction(tx, null, sale, 'create').then(function () {
              tx.set(saleRef, sanitizeFirestoreData(sale));
            });
          });
          if (window.ProductSalesSummary && window.ProductSalesSummary.applySaleCreate) {
            await window.ProductSalesSummary.applySaleCreate(sale);
          }
          if (window.MonthlySalesSummary && window.MonthlySalesSummary.applySaleCreate) {
            try {
              await window.MonthlySalesSummary.applySaleCreate(sale);
            } catch (summaryErr) {
              console.warn('MonthlySalesSummary mobile sale create failed', summaryErr);
            }
          }
          if (paymentMethod === 'credit') {
            var debtOwner = getCurrentUserOwnership();
            var debtEntryTime = getRiyadhDateTimeParts(sale.timestamp);
            var debtEntry = {
              id: 'debt_op_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
              customerId: sale.customerId,
              customerName: sale.customerName,
              type: 'debt',
              amount: Number(sale.displayTotalAmount || sale.rawTotalAmount || sale.totalAmount || sale.amount || 0) || 0,
              note: sale.itemName || 'منتج',
              dateKey: debtEntryTime.dateKey,
              operationDate: debtEntryTime.dateKey,
              operationTime: debtEntryTime.timeValue,
              timestamp: sale.timestamp,
              source: SOURCE,
              currency: sale.saleMode,
              saleId: sale.saleId,
              relatedSaleId: sale.saleId,
              linkedSaleId: sale.saleId,
              userId: debtOwner.userId,
              ownerId: debtOwner.ownerId,
              createdBy: debtOwner.createdBy,
              uid: debtOwner.uid
            };
            sale.debtOperationId = debtEntry.id;
            sale.linkedDebtOperationId = debtEntry.id;
            sale.relatedDebtOperationId = debtEntry.id;
            sale.saleDebtOperationId = debtEntry.id;
            await db.collection('sales').doc(sale.saleId).set({ debtOperationId: debtEntry.id, linkedDebtOperationId: debtEntry.id, relatedDebtOperationId: debtEntry.id, saleDebtOperationId: debtEntry.id }, { merge: true });
            await db.collection('debtOperations').doc(debtEntry.id).set(sanitizeFirestoreData(debtEntry));
            upsertDebtOperationLocally(debtEntry);
          }
          await logMobileActivity('sell', sale, { debtBefore: debtBeforeSale, debtAfter: paymentMethod === 'credit' ? debtBeforeSale + saleDisplayTotal : null, cashboxBefore: cashboxBeforeSale, cashboxAfter: paymentMethod === 'cash' ? cashboxBeforeSale + saleDisplayTotal : null });
          selectedItem.quantity = stockResult.quantity; selectedItem.purchaseBatches = stockResult.purchaseBatches || selectedItem.purchaseBatches;
          upsertSaleLocally(sale); notify(paymentMethod === 'credit' ? 'تم تسجيل البيع الآجل بنجاح' : 'تم تسجيل البيع بنجاح');
        } catch (offlineCreateError) {
          throw offlineCreateError;
        }
      } else {
        var diff = qty - oldQty;
        var rawExistingAllocations = Array.isArray(editingSale.purchaseBatchAllocations) ? editingSale.purchaseBatchAllocations : [];
        var allocations = sanitizeBatchAllocations(rawExistingAllocations).slice();
        var extraAllocations = null;
        if (diff > 0 && selectedItem.purchaseBatches && selectedItem.purchaseBatches.length) extraAllocations = computeAllocations(selectedItem, diff);
        if (diff > 0 && selectedItem.purchaseBatches && selectedItem.purchaseBatches.length && (!extraAllocations || !extraAllocations.length)) throw new Error('الكمية المتوفرة غير كافية');
        if (diff !== 0) {
          if (diff > 0) {
            var stockResult2 = await changeStock(selectedItem, -diff, extraAllocations);
            selectedItem.quantity = stockResult2.quantity; selectedItem.purchaseBatches = stockResult2.purchaseBatches || selectedItem.purchaseBatches;
            allocations = allocations.concat(extraAllocations || []);
          } else {
            var toRestore = -diff;
            function extractRestore(existing, qty) {
              var cleanAllocations = sanitizeBatchAllocations(existing);
              var arr = cleanAllocations.slice();
              var restore = [];
              var remaining = qty;
              while (remaining > 0 && arr.length) {
                var last = arr[arr.length - 1];
                if (!last) {
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
            if (selectedItem.purchaseBatches && selectedItem.purchaseBatches.length && allocations.length) {
              var extracted = extractRestore(allocations, toRestore);
              var restoreAllocations = extracted.restoreAllocations;
              var restored = await restoreBatches(selectedItem.id, restoreAllocations);
              selectedItem.quantity = restored.quantity; selectedItem.purchaseBatches = restored.purchaseBatches || selectedItem.purchaseBatches;
              allocations = extracted.remainingAllocations;
            } else {
              var simpleRestore = await changeStock(selectedItem, -diff, null);
              selectedItem.quantity = simpleRestore.quantity;
            }
          }
        }
        var newPrice = baseCurrency() === '' ? primary(displayedPrice) : displayedPrice, newProfit = (newPrice - (Number(editingSale.purchasePriceAtTime) || 0)) * qty, profitDiff = newProfit - (Number(editingSale.profit) || 0);
        var updatedTotalPrimary = baseCurrency() === '' ? primary(Number($('salePrice').value) || 0) : (Number($('salePrice').value) || 0);
        var updatedDisplayTotal = Number($('salePrice').value) || 0;
        var seller = getCurrentSellerInfo();
        var updated = Object.assign({}, editingSale, { quantity: qty, unitPrice: newPrice, totalAmount: updatedTotalPrimary, baseAmount: updatedTotalPrimary, baseCurrency: 'primary', displayTotalAmount: updatedDisplayTotal, rawTotalAmount: updatedDisplayTotal, displayCurrency: baseCurrency(), profit: newProfit, sellerEmail: editingSale.sellerEmail || seller.email, sellerName: editingSale.sellerName || seller.name, user: editingSale.user || seller.email, saleMode: baseCurrency(), purchaseBatchAllocations: allocations, saleRevision: (Number(editingSale.saleRevision) || 1) + 1, updatedAt: Date.now(), source: SOURCE, priceType: warning.type, priceWarningLevel: warning.level, priceWarningPercent: warning.percent, priceWarningDirection: warning.direction, priceWarningReference: warning.reference, paymentMethod: paymentMethod });
        if (paymentMethod === 'credit') {
          var selectedCreditCustomerUpdate = debtCustomers.find(function (customer) { return String(customer.id) === String(creditCustomerId); });
          updated.customerId = selectedCreditCustomerUpdate ? selectedCreditCustomerUpdate.id : creditCustomerId;
          updated.customerName = selectedCreditCustomerUpdate ? selectedCreditCustomerUpdate.name : '';
          updated.isCreditSale = true;
          var creditReconciliation = helpers.reconcileCreditSaleDebtAfterEdit ? helpers.reconcileCreditSaleDebtAfterEdit(updated, debtOperations) : null;
          if (creditReconciliation && creditReconciliation.operations && creditReconciliation.operations.length) {
            var linkedDebtRecord = helpers.findLinkedDebtOperation ? helpers.findLinkedDebtOperation(updated, creditReconciliation.operations) : null;
            if (!linkedDebtRecord) {
              linkedDebtRecord = helpers.findLinkedDebtOperation ? helpers.findLinkedDebtOperation(updated, debtOperations) : null;
            }
            if (linkedDebtRecord) {
              updated.debtOperationId = linkedDebtRecord.id || updated.debtOperationId;
              updated.linkedDebtOperationId = linkedDebtRecord.id || updated.linkedDebtOperationId;
              updated.relatedDebtOperationId = linkedDebtRecord.id || updated.relatedDebtOperationId;
              updated.saleDebtOperationId = linkedDebtRecord.id || updated.saleDebtOperationId;
              var debtRecordUpdate = Object.assign({}, linkedDebtRecord, {
                amount: Number(creditReconciliation.debtAmount) || 0,
                customerId: updated.customerId || linkedDebtRecord.customerId,
                customerName: updated.customerName || linkedDebtRecord.customerName || '',
                saleId: updated.saleId,
                relatedSaleId: updated.saleId,
                linkedSaleId: updated.saleId,
                debtOperationId: linkedDebtRecord.id,
                status: creditReconciliation.remainingDebt <= 0 ? 'settled' : 'active'
              });
              debtOperations = debtOperations.map(function (entry) { return String(entry.id) === String(linkedDebtRecord.id) ? debtRecordUpdate : entry; });
              try {
                await db.collection('debtOperations').doc(linkedDebtRecord.id).set(sanitizeFirestoreData(debtRecordUpdate), { merge: true });
              } catch (debtSyncError) {
                throw debtSyncError;
              }
            }
          }
        }
        try {
          await db.runTransaction(function (tx) {
            var saleRef = db.collection('sales').doc(editingSale.saleId);
            return tx.get(saleRef).then(function (snapshot) {
              if (!snapshot.exists) throw new Error('بيع غير موجود');
              var currentSale = Object.assign({ saleId: snapshot.id }, snapshot.data());
              if ((Number(currentSale.saleRevision) || 1) !== (Number(editingSale.saleRevision) || 1)) throw new Error('SALE_REVISION_CONFLICT');
              return window.DailySalesSummary.applySaleMutationInTransaction(tx, currentSale, updated, 'update').then(function () {
                tx.set(saleRef, sanitizeFirestoreData(updated));
              });
            });
          });
          if (window.ProductSalesSummary && window.ProductSalesSummary.applySaleUpdate) {
            await window.ProductSalesSummary.applySaleUpdate(editingSale, updated);
          }
          if (window.MonthlySalesSummary && window.MonthlySalesSummary.applySaleUpdate) {
            try {
              await window.MonthlySalesSummary.applySaleUpdate(editingSale, updated);
            } catch (summaryErr) {
              console.warn('MonthlySalesSummary mobile sale update failed', summaryErr);
            }
          }
          await logMobileActivity('update', updated, { before: editingSale, after: updated, changes: { quantity: { before: oldQty, after: qty }, unitPrice: { before: editingSale.unitPrice, after: newPrice } } });
          upsertSaleLocally(updated);
          await syncSalesFromFirestore();
          await loadDebtData();
          renderDebtList();
          notify('تم تعديل البيع');
        } catch (offlineUpdateError) {
          throw offlineUpdateError;
        }
      }
      closeModal('saleModal'); renderProducts(); renderHistory();
    } catch (error) { showError('saleError', error.message || 'تعذر حفظ العملية'); }
    if (button) button.disabled = false;
  }

  async function updateStats(delta) { if (delta) await db.collection('stats').doc('totals').set({ allTimeProfit: firebase.firestore.FieldValue.increment(delta), updatedAt: Date.now() }, { merge: true }); }
  async function persistMobileActivityRecord(record) {
    upsertMobileOperationRecord(record);
    if (!db || !db.collection) throw new Error('activity log unavailable');
    await db.collection('activityLog').doc(record.operationId).set(sanitizeFirestoreData(record));
    return record;
  }

  async function logMobileAudit(action, entity, entityId, details, metadata) {
    var sellerInfo = getCurrentSellerInfo();
    var currentUser = auth && auth.currentUser;
    var auditMetadata = metadata || {};
    var saleAuditKey = entityId || auditMetadata.saleId || entity || Date.now();
    var saleAuditVersion = action === 'update' ? (auditMetadata.updatedAt || Date.now()) : action === 'delete' || action === 'cancel' || action === 'return' ? (auditMetadata.cancelledAt || Date.now()) : 'create';
    var operationId = 'activity_mobile_' + action + '_' + saleAuditKey + '_' + saleAuditVersion;
    return persistMobileActivityRecord({
      operationId: operationId, timestamp: Date.now(), actionType: action, entity: entity, entityId: entityId || null,
      details: details || '', user: sellerInfo.email || currentUser && currentUser.email || 'unknown', userId: currentUser && currentUser.uid || null,
      userName: sellerInfo.name || '', sellerEmail: sellerInfo.email || '', sellerName: sellerInfo.name || '', metadata: Object.assign({}, auditMetadata, { source: SOURCE }), source: SOURCE
    });
  }

  async function logMobileActivity(action, sale, changes) {
    var sellerInfo = getCurrentSellerInfo();
    var saleRecord = sale || {};
    var email = (saleRecord.user || saleRecord.sellerEmail || sellerInfo.email || (auth && auth.currentUser && auth.currentUser.email) || 'unknown');
    var qty = Number(saleRecord.quantity) || 0;
    var itemName = saleRecord.itemName || saleRecord.name || 'منتج';
    var profitValue = Number(saleRecord.profit) || 0;
    var details = '';
    if (action === 'sell') {
      details = 'بيع منتج: ' + itemName + '، الكمية: ' + qty;
    } else if (action === 'cancel' || action === 'return') {
      details = (action === 'return' ? 'استرجاع بيع: ' : 'إلغاء بيع: ') + itemName + '، الكمية: ' + qty;
    } else {
      details = 'تعديل بيع: ' + itemName + '، الكمية الجديدة: ' + qty + '، السعر: ' + (Number(saleRecord.unitPrice) || 0);
    }
    var currentUser = auth && auth.currentUser;
    var saleAuditKey = saleRecord.saleId || saleRecord.id || 'sale';
    var saleAuditVersion = action === 'update' ? (saleRecord.updatedAt || saleRecord.timestamp || '') : action === 'cancel' || action === 'return' ? (saleRecord.cancelledAt || saleRecord.returnedAt || saleRecord.timestamp || '') : 'create';
    var operationId = 'activity_mobile_' + action + '_' + saleAuditKey + '_' + saleAuditVersion;
    var metadata = Object.assign({
      saleId: saleRecord.saleId || null,
      itemId: saleRecord.itemId || null,
      itemName: itemName,
      quantity: qty,
      profit: profitValue,
      source: SOURCE
    }, changes || {});
    var record = {
      operationId: operationId,
      timestamp: Date.now(),
      actionType: action === 'sell' ? 'sell' : (action === 'cancel' ? 'cancelSale' : action === 'return' ? 'return' : 'update'),
      entity: 'sale',
      entityId: saleRecord.saleId || null,
      details: details,
      user: email,
      userId: currentUser && currentUser.uid || saleRecord.userId || null,
      userName: sellerInfo.name || saleRecord.sellerName || '',
      sellerEmail: email,
      sellerName: sellerInfo.name || saleRecord.sellerName || '',
      itemId: saleRecord.itemId || null,
      itemName: itemName,
      quantity: qty,
      paymentMethod: saleRecord.paymentMethod || null,
      unitPrice: saleRecord.unitPrice || null,
      totalAmount: saleRecord.displayTotalAmount || saleRecord.rawTotalAmount || saleRecord.totalAmount || null,
      saleMode: saleRecord.saleMode || saleRecord.displayCurrency || null,
      priceType: saleRecord.priceType || null,
      customerName: saleRecord.customerName || null,
      metadata: metadata,
      source: SOURCE
    };
    return persistMobileActivityRecord(record);
  }

  async function cancelSale(saleId, forcedMode) {
    var sale = await resolveCurrentSaleRecord(saleId, true);
    sale = helpers.normalizeSaleForCancellation ? helpers.normalizeSaleForCancellation(sale) : sale;
    if (!sale || sale.source !== SOURCE) return;
    if (String(sale.status || '').toLowerCase() === 'cancelled' || sale.cancelled || sale.isCancelled) {
      notify('تم إلغاء هذه العملية مسبقًا');
      return;
    }
    if (!window.confirm('إلغاء عملية البيع؟')) return;
    if (!sale.itemId) { notify('معرف المنتج غير موجود في سجل البيع'); return; }
    var paymentMethod = String(sale.paymentMethod || '').toLowerCase();
    if (paymentMethod === 'credit') {
      returnSale(saleId);
      return;
    }
    var disposition = 'refund';
    finalizeSaleCancellation(saleId, disposition).catch(function (error) { notify(error.message || 'تعذر إلغاء البيع'); });
    return;
    var item = (Array.isArray(items) ? items : []).find(function (entry) { return entry && entry.id === sale.itemId; });
    if (!item) {
      try {
        var itemDoc = await db.collection('items').doc(sale.itemId).get();
        if (itemDoc.exists) item = Object.assign({ id: itemDoc.id }, itemDoc.data());
      } catch (error) { notify('تعذر الوصول إلى المنتج المرتبط بالبيع'); return; }
    }
    if (!item || !item.id) { notify('المنتج المرتبط بعملية البيع غير موجود'); return; }
    var linkedDebtOperation = helpers.findLinkedDebtOperation ? helpers.findLinkedDebtOperation(sale, debtOperations) : null;
    var saleKey = helpers.normalizeIdValue ? helpers.normalizeIdValue(sale.saleId || sale.id || sale.relatedSaleId || sale.linkedSaleId || sale.debtOperationId || sale.relatedDebtOperationId || sale.linkedDebtOperationId || sale.saleDebtOperationId) : String(sale.saleId || sale.id || '').trim();
    var customerId = sale.customerId || (linkedDebtOperation && linkedDebtOperation.customerId) || null;
    try {
      var cleanPurchaseAllocations = sanitizeBatchAllocations(sale.purchaseBatchAllocations);
      var result = cleanPurchaseAllocations.length ? await restoreBatches(item.id, cleanPurchaseAllocations) : await updateQuantity(item.id, sale.quantity);
      if (result === null || result === undefined || (typeof result === 'object' && result.quantity === undefined)) { notify('تعذر استرجاع كمية المنتج المرتبط'); return; }
      try {
        var reallocationPlan = { reassignedAmount: 0, assignments: [] };
        if (customerId) {
          var affectedPaymentEntries = debtOperations.filter(function (entry) {
            if (!entry || String(entry.customerId) !== String(customerId) || (entry.type !== 'payment' && entry.type !== 'settle')) return false;
            if (Array.isArray(entry.allocations)) {
              return entry.allocations.some(function (allocation) { return String(allocation.saleId || allocation.relatedSaleId || allocation.linkedSaleId || '') === String(saleKey); });
            }
            return String(entry.saleId || entry.relatedSaleId || entry.linkedSaleId || '') === String(saleKey);
          });
          for (var i = 0; i < affectedPaymentEntries.length; i += 1) {
            var paymentEntry = affectedPaymentEntries[i];
            if (!paymentEntry) continue;
            if (Array.isArray(paymentEntry.allocations) && paymentEntry.allocations.length) {
              var keptAllocations = paymentEntry.allocations.filter(function (allocation) { return String(allocation.saleId || allocation.relatedSaleId || allocation.linkedSaleId || '') !== String(saleKey); });
              var nextPayment = Object.assign({}, paymentEntry, {
                allocations: keptAllocations,
                amount: keptAllocations.reduce(function (sum, allocation) { return sum + (Number(allocation.amount) || 0); }, 0),
                status: 'active',
                refundedSaleId: null,
                refundedAt: null
              });
              if (!keptAllocations.length) {
                await db.collection('debtOperations').doc(paymentEntry.id).delete();
                debtOperations = debtOperations.filter(function (entry) { return String(entry.id) !== String(paymentEntry.id); });
              } else {
                await db.collection('debtOperations').doc(paymentEntry.id).set(nextPayment, { merge: true });
                debtOperations = debtOperations.map(function (entry) { return String(entry.id) === String(paymentEntry.id) ? nextPayment : entry; });
              }
            } else {
              await db.collection('debtOperations').doc(paymentEntry.id).delete();
              debtOperations = debtOperations.filter(function (entry) { return String(entry.id) !== String(paymentEntry.id); });
            }
          }
        }
        if (linkedDebtOperation && ((helpers.isOriginalCreditSale ? helpers.isOriginalCreditSale(sale) : (sale.paymentMethod === 'credit' || sale.isCreditSale)) || (sale.customerId && sale.paymentMethod === 'credit'))) {
          try {
            await db.collection('debtOperations').doc(linkedDebtOperation.id).delete();
            debtOperations = debtOperations.filter(function (entry) { return String(entry.id) !== String(linkedDebtOperation.id); });
          } catch (debtDeleteError) {
            throw debtDeleteError;
          }
        }
        if (reallocationPlan.assignments && reallocationPlan.assignments.length) {
          var reallocationTotal = reallocationPlan.assignments.reduce(function (sum, assignment) { return sum + (Number(assignment.amount) || 0); }, 0);
          if (reallocationTotal > 0) {
            var reallocationNowParts = getRiyadhDateTimeParts(Date.now());
            var reallocationEntry = {
              id: 'debt_op_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
              customerId: customerId,
              customerName: sale.customerName || '',
              type: 'payment',
              amount: reallocationTotal,
              currency: baseCurrency(),
              note: 'إلغاء بيع',
              dateKey: reallocationNowParts.dateKey,
              operationDate: reallocationNowParts.dateKey,
              operationTime: reallocationNowParts.timeValue,
              timestamp: Date.now(),
              source: SOURCE,
              userId: getCurrentUserOwnership().userId || null,
              ownerId: getCurrentUserOwnership().ownerId || null,
              createdBy: getCurrentUserOwnership().createdBy || null,
              uid: getCurrentUserOwnership().uid || null,
              status: 'active',
              allocations: reallocationPlan.assignments.map(function (assignment) {
                return { saleId: assignment.saleId, amount: Number(assignment.amount) || 0, customerId: customerId, paymentId: null, status: 'active' };
              })
            };
            await db.collection('debtOperations').doc(reallocationEntry.id).set(reallocationEntry);
            upsertDebtOperationLocally(reallocationEntry);
          }
        }
        await db.collection('sales').doc(saleId).delete();
        await updateStats(-(Number(sale.profit) || 0)); await logMobileActivity('cancel', sale);
        item.quantity = typeof result === 'number' ? result : result.quantity;
        if (typeof result === 'object' && result.purchaseBatches) item.purchaseBatches = result.purchaseBatches;
        var localItemIndex = items.findIndex(function (entry) { return entry && entry.id === item.id; });
        if (localItemIndex >= 0) items[localItemIndex] = item;
        else items.push(item);
        sales = sales.filter(function (entry) { return !entry || entry.saleId !== saleId; });
        renderProducts(); renderHistory(); renderDebtList(); notify(CANCEL_SALE_SUCCESS_MESSAGE);
      } catch (syncCancelError) {
        throw syncCancelError;
      }
    } catch (error) { notify(error.message || 'تعذر إلغاء البيع'); }
  }

  async function loadData() {
    if (dataLoaded) return;
    dataLoaded = true;
    await refreshCurrencySettings();
    try { loadDebtData(); } catch (error) { console.warn('Unable to hydrate debt customers', error); }
    startLiveListeners();
    try {
      var cacheRead = Promise.all([
        db.collection('items').get({ source: 'cache' }),
        db.collection('sales').where('source', '==', SOURCE).get({ source: 'cache' }),
        db.collection('currencySettings').doc('settings').get({ source: 'cache' })
      ]).then(function (result) {
        items = result[0].docs.map(function (doc) { return Object.assign({ id: doc.id }, doc.data()); });
        sales = result[1].docs.map(function (doc) { return Object.assign({ saleId: doc.id }, doc.data()); });
        renderProducts(); renderHistory();
      });
      await Promise.race([cacheRead, new Promise(function (resolve) { setTimeout(resolve, 1200); })]);
      try { await XMetalCapitalSummary.ensureInitialized(db, items); } catch (error) { console.warn('Capital summary initialization failed', error); }
    } catch (error) { $('productCount').textContent = 'تعذر تحميل المنتجات'; notify('تعذر الاتصال بالنظام'); console.error(error); }
  }

  function startLiveListeners() {
    if (listenersStarted) return;
    listenersStarted = true;
    db.collection('items').onSnapshot(function (snap) {
      var nextItems = snap.docs.map(function (doc) { return Object.assign({ id: doc.id }, doc.data()); });
      var changed = nextItems.length !== items.length || nextItems.some(function (next) {
        var previous = items.find(function (item) { return item.id === next.id; });
        return !previous || JSON.stringify(previous) !== JSON.stringify(next);
      });
      if (changed) { items = nextItems; renderProducts(); }
      lastSyncAt = Date.now();
    });
    db.collection('sales').where('source', '==', SOURCE).onSnapshot(function (snap) {
      var nextSales = snap.docs.map(function (doc) { return Object.assign({ saleId: doc.id }, doc.data()); });
      nextSales = uniqueSales(nextSales);
      var mergedSales = helpers.uniqueRecordsById ? helpers.uniqueRecordsById(sales.concat(nextSales), ['saleId', 'id']) : uniqueSales(sales.concat(nextSales));
      if (JSON.stringify(mergedSales) !== JSON.stringify(uniqueSales(sales))) { sales = mergedSales; renderHistory(); renderDebtList(); if (cashboxLoaded) { cashboxEntries = buildCashboxEntries(); renderCashbox(); } }
      lastSyncAt = Date.now();
    });
    db.collection('debtOperations').onSnapshot(function (snap) {
      var nextDebtOperations = snap.docs.map(function (doc) { return Object.assign({ id: doc.id }, doc.data()); });
      nextDebtOperations = nextDebtOperations.filter(function (entry) { return entry && (entry.type === 'debt' || entry.type === 'payment' || entry.type === 'settle' || entry.type === 'return' || entry.type === 'cancel'); });
      nextDebtOperations = helpers.uniqueRecordsById ? helpers.uniqueRecordsById(nextDebtOperations, ['id', 'debtOperationId', 'operationId']) : nextDebtOperations;
      var mergedDebtOperations = helpers.uniqueRecordsById ? helpers.uniqueRecordsById(debtOperations.concat(nextDebtOperations), ['id', 'debtOperationId', 'operationId']) : debtOperations.concat(nextDebtOperations);
      if (JSON.stringify(mergedDebtOperations) !== JSON.stringify(debtOperations)) {
        debtOperations = mergedDebtOperations.sort(function (a, b) { return timestampValue(b.timestamp) - timestampValue(a.timestamp); });
        renderDebtList();
        if (cashboxLoaded) { cashboxEntries = buildCashboxEntries(); renderCashbox(); }
      }
      lastSyncAt = Date.now();
    });
    db.collection('currencySettings').doc('settings').onSnapshot(function (doc) {
      if (doc.exists) {
        var nextCurrency = normalizeCurrencySettings(doc.data());
        if (JSON.stringify(nextCurrency) !== JSON.stringify(currency)) {
          currency = nextCurrency;
          try { localStorage.setItem('xmetalMobileSalesCurrency', JSON.stringify(currency)); } catch (error) {}
          renderProducts(); renderHistory(); renderDebtList();
        }
      }
      lastSyncAt = Date.now();
    });
  }

  $('loginForm').addEventListener('submit', function (event) { event.preventDefault(); showError('loginError', ''); auth.signInWithEmailAndPassword($('email').value.trim(), $('password').value).catch(function () { showError('loginError', 'بيانات الدخول غير صحيحة'); }); });
  $('productSearch').addEventListener('input', function () {
    var hasSearchTerm = String($('productSearch').value || '').trim() !== '';
    if (hasSearchTerm && activePage !== 'products') showProductsPage();
    renderProducts();
    scrollToProductsTop();
  });
  $('productTabs').addEventListener('click', function (event) {
    var tab = event.target.closest('[data-product-tab]');
    if (!tab) return;
    productFilterMode = tab.dataset.productTab || 'available';
    renderProducts();
  });
  $('showEndedProductsToggle').addEventListener('change', async function () {
    var previousValue = showEndedProducts;
    showEndedProducts = $('showEndedProductsToggle').checked;
    if (!showEndedProducts) productFilterMode = 'available';
    renderProducts();
    try {
      await saveMobileSettings({ showEndedProducts: showEndedProducts });
    } catch (error) {
      showEndedProducts = previousValue;
      $('showEndedProductsToggle').checked = previousValue;
      renderProducts();
      notify('تعذر حفظ الإعداد في قاعدة البيانات');
    }
  });
  $('allowDebtDateEditingToggle').addEventListener('change', async function () {
    var previousValue = allowDebtDateEditing;
    allowDebtDateEditing = $('allowDebtDateEditingToggle').checked;
    try {
      await saveMobileSettings({ allowDebtDateEditing: allowDebtDateEditing });
    } catch (error) {
      allowDebtDateEditing = previousValue;
      $('allowDebtDateEditingToggle').checked = previousValue;
      notify('تعذر حفظ الإعداد في قاعدة البيانات');
    }
  });
  $('logoutButton').addEventListener('click', function () {
    if (auth && typeof auth.signOut === 'function') {
      auth.signOut();
      showProductsPage();
    }
  });
  $('customerForm').addEventListener('submit', saveDebtCustomer);
  $('debtCustomerForm').addEventListener('submit', saveDebtCustomer);
  if ($('debtActionTypeDisplay')) {
    $('debtActionTypeDisplay').addEventListener('change', function () {
      var visibleType = String($('debtActionTypeDisplay').value || 'debt').trim();
      $('debtActionType').value = visibleType;
    });
  }
  $('debtActionForm').addEventListener('submit', saveDebtOperation);
  $('confirmReturnSaleButton').addEventListener('click', function () {
    var amount = Number($('returnSaleCashAmount').value);
    var maximum = Number($('returnSaleCashAmount').max) || 0;
    if (!Number.isFinite(amount) || amount < 0 || amount > maximum) {
      $('returnSaleError').textContent = 'يرجى إدخال مبلغ بين 0 وقيمة البيع';
      return;
    }
    var saleId = pendingReturnSaleId;
    pendingReturnSaleId = null;
    closeModal('returnSaleModal');
    finalizeSaleCancellation(saleId, 'return', amount).catch(function (error) { notify(error.message || 'تعذر استرجاع البيع'); });
  });
  $('deleteDebtOperationButton').addEventListener('click', function () {
    var operationId = $('debtOperationId').value;
    if (!operationId) return notify('لا توجد حركة محددة للحذف');
    deleteDebtOperation(operationId);
  });
  $('cashSaleButton').addEventListener('click', function () {
    if (editingSale) {
      $('salePaymentMethod').value = editingSale.paymentMethod || 'cash';
      if (editingSale.customerId) $('saleSelectedCustomerId').value = editingSale.customerId;
      $('saleForm').requestSubmit();
      return;
    }
    $('salePaymentMethod').value = 'cash';
    $('saleSelectedCustomerId').value = '';
    $('saleForm').requestSubmit();
  });
  $('creditSaleButton').addEventListener('click', function () {
    if (editingSale) {
      $('salePaymentMethod').value = editingSale.paymentMethod || 'credit';
      if (editingSale.customerId) $('saleSelectedCustomerId').value = editingSale.customerId;
      $('saleForm').requestSubmit();
      return;
    }
    $('salePaymentMethod').value = 'credit';
    $('saleSelectedCustomerId').value = '';
    openCreditCustomerPicker();
  });
  document.addEventListener('click', function (event) {
    var addCustomerButton = event.target.closest('[data-credit-customer-add]');
    if (addCustomerButton) {
      pendingCreditCustomerReturn = true;
      closeModal('creditCustomerModal');
      $('debtCustomerForm').reset();
      openModal('debtCustomerModal');
      return;
    }
    if (event.target.closest('.credit-customer-phone')) {
      return;
    }
    var creditCustomer = event.target.closest('[data-credit-customer-id]');
    if (creditCustomer) {
      $('salePaymentMethod').value = 'credit';
      $('saleSelectedCustomerId').value = creditCustomer.dataset.creditCustomerId;
      closeModal('creditCustomerModal');
      $('saleForm').requestSubmit();
    }
  });
  document.addEventListener('keydown', function (event) {
    var phoneLink = event.target.closest('.credit-customer-phone');
    if (phoneLink) return;
    var creditCustomer = event.target.closest('[data-credit-customer-id]');
    if (!creditCustomer) return;
    if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
    event.preventDefault();
    $('salePaymentMethod').value = 'credit';
    $('saleSelectedCustomerId').value = creditCustomer.dataset.creditCustomerId;
    closeModal('creditCustomerModal');
    $('saleForm').requestSubmit();
  });
  $('debtsList').addEventListener('click', function (event) {
    var action = event.target.closest('[data-debt-action]');
    if (!action) return;
    openDebtActionModal(action.dataset.debtCustomerId, action.dataset.debtAction);
  });
  $('debtPageList').addEventListener('click', function (event) {
    var sortButton = event.target.closest('[data-debt-sort]');
    if (sortButton) {
      var sortKey = sortButton.dataset.debtSort;
      if (debtTableSort.key === sortKey) debtTableSort.direction *= -1;
      else {
        debtTableSort.key = sortKey;
        debtTableSort.direction = 1;
      }
      renderDebtPageList();
      return;
    }
    var row = event.target.closest('[data-debt-customer-id]');
    if (!row) return;
    openDebtCustomerDetail(row.dataset.debtCustomerId);
  });
  $('operationsLoadMore').addEventListener('click', function () { loadOperationsPage(false); });
  $('operationsSearch').addEventListener('input', renderOperationsLog);
  $('operationsActionFilter').addEventListener('change', renderOperationsLog);
  $('operationsLogBody').addEventListener('click', function (event) {
    var button = event.target.closest('[data-operation-id]');
    if (!button) return;
    var record = operationsRecords.find(function (entry) { return String(entry.operationId || entry.id) === String(button.dataset.operationId); });
    renderOperationDetail(record);
  });
  $('customerDetailContent').addEventListener('click', function (event) {
    var moreButton = event.target.closest('[data-debt-show-more]');
    if (moreButton) {
      var customerId = moreButton.dataset.debtShowMore;
      if (!customerId) return;
      var allOperations = getDebtCustomerOperations(customerId).slice();
      var allCycles = getDebtCycleGroupEntries(allOperations);
      var currentCount = Number(customerDetailCycleCounts[String(customerId)] || (getCustomerBalance(customerId) > 0 ? 1 : 0));
      var nextCount = Math.min((Number.isFinite(currentCount) ? currentCount : 0) + 1, Math.max(allCycles.length, 0));
      customerDetailCycleCounts[String(customerId)] = nextCount;
      openDebtCustomerDetail(customerId);
      return;
    }
    var returnButton = event.target.closest('[data-return-sale]');
    if (returnButton) {
      returnSale(returnButton.dataset.returnSale);
      return;
    }
    var operationRow = event.target.closest('[data-debt-operation-id]');
    if (operationRow) {
      openDebtOperationEditor(operationRow.dataset.debtOperationId);
      return;
    }
    var trigger = event.target.closest('[data-debt-detail-action]');
    if (trigger) {
      closeModal('customerDetailModal');
      openDebtActionModal(trigger.dataset.debtDetailCustomerId, trigger.dataset.debtDetailAction);
    }
  });
  $('addDebtCustomerButton').addEventListener('click', function () { $('debtCustomerForm').reset(); openModal('debtCustomerModal'); });
  $('cancelDebtCustomerButton').addEventListener('click', function () {
    pendingCreditCustomerReturn = false;
    $('debtCustomerForm').reset();
    closeModal('debtCustomerModal');
    renderCreditCustomerList();
    openModal('creditCustomerModal');
  });
  $('withdrawEmployeeButton').addEventListener('click', openEmployeeWithdrawal);
  $('employeeWithdrawalForm').addEventListener('submit', saveEmployeeWithdrawal);
  $('withdrawEmployeeGoodsButton').addEventListener('click', openEmployeeGoodsWithdrawal);
  $('employeeProductSearch').addEventListener('input', renderEmployeeProducts);
  $('employeeProductList').addEventListener('click', function (event) { var button = event.target.closest('[data-employee-product-id]'); if (button) selectEmployeeProduct(button.dataset.employeeProductId); });
  $('employeeHistory').addEventListener('click', function (event) {
    var row = event.target.closest('.employee-operation-row');
    if (row) {
      var opId = row.getAttribute('data-employee-operation-id');
      if (!opId) return;
      openEmployeeOperationDetail(opId);
      return;
    }
    var moreButton = event.target.closest('#employeeHistoryLoadMore');
    if (moreButton) {
      var employeeId = moreButton.dataset.employeeHistoryMore;
      if (employeeId && !employeeHistoryLoading) loadEmployeeHistoryPage(employeeId, false);
      return;
    }
  });
  $('confirmEmployeePurchase').addEventListener('click', confirmEmployeePurchase);
  $('toggleEmployeeDayButton').addEventListener('click', toggleEmployeeDay);
  function closeMobileMenu() {
    $('mobileMenuPanel').hidden = true;
    $('mobileMenuBackdrop').hidden = true;
  }
  $('bottomNavigation').addEventListener('click', function (event) {
    var button = event.target.closest('[data-mobile-route]');
    if (!button) return;
    var route = button.dataset.mobileRoute;
    if (route === 'home') showProductsPage();
    else if (route === 'debts') showDebtPage();
    else if (route === 'employee') showEmployeePage();
    else if (route === 'history') showHistoryPage();
    else if (route === 'operations') showOperationsPage();
    else if (route === 'settings') showSettingsPage();
  });
  $('toolbarSalesHistoryButton').addEventListener('click', function () {
    showHistoryPage();
  });
  $('toolbarCashboxButton').addEventListener('click', function () {
    showCashboxPage();
  });
  $('mobileMenuPanel').addEventListener('click', function (event) {
    var button = event.target.closest('[data-mobile-route]');
    if (!button) return;
    closeMobileMenu();
    if (button.dataset.mobileRoute === 'cashbox') showCashboxPage();
    if (button.dataset.mobileRoute === 'operations' && typeof showOperationsPage === 'function') showOperationsPage();
    if (button.dataset.mobileRoute === 'settings') showSettingsPage();
  });
  $('mobileMenuBackdrop').addEventListener('click', closeMobileMenu);
  $('debtCustomerSearch').addEventListener('input', function () {
    renderDebtPageList();
  });
  document.addEventListener('click', function (event) {
    if (!event.target.closest('#mobileMenuPanel') && !event.target.closest('[data-mobile-route="menu"]')) closeMobileMenu();
  });
  $('saleQuantity').addEventListener('input', function () {
    var quantity = number($('saleQuantity').value);
    var available = selectedItem ? Number(selectedItem.quantity) || 0 : 0;
    var maxAllowed = editingSale && helpers.getSaleEditQuantityLimit ? helpers.getSaleEditQuantityLimit(selectedItem, editingSale) : available;
    if (quantity !== null && maxAllowed > 0 && quantity > maxAllowed) {
      $('saleQuantity').value = maxAllowed;
    }
    if (quantity !== null && quantity <= 0) {
      $('saleQuantity').value = 0.01;
    }
    unusualPriceApproved = false; $('priceWarning').hidden = true; updateSalePriceGuide();
  });
  $('salePrice').addEventListener('input', function () { salePriceManuallyEdited = true; unusualPriceApproved = false; $('priceWarning').hidden = true; updateSalePriceGuide(); });
  $('resetSalePrice').addEventListener('click', function () { salePriceManuallyEdited = false; updateSalePriceGuide(true); });
  $('quickQuantityButtons').addEventListener('click', function (event) {
    var button = event.target.closest('[data-quick-quantity]');
    if (!button || button.disabled || button.hidden) return;
    var quickValue = Number(button.dataset.quickQuantity);
    var stock = selectedItem ? Number(selectedItem.quantity) || 0 : 0;
    var limit = editingSale && helpers.getSaleEditQuantityLimit ? helpers.getSaleEditQuantityLimit(selectedItem, editingSale) : stock;
    if (!Number.isFinite(quickValue) || quickValue <= 0 || quickValue > Math.min(10, limit) || quickValue > limit) return;
    $('saleQuantity').value = quickValue;
    $('saleQuantity').dispatchEvent(new Event('input', { bubbles: true }));
  });
  $('backFromWarning').addEventListener('click', function () { unusualPriceApproved = false; $('priceWarning').hidden = true; });
  $('confirmUnusualPrice').addEventListener('click', function () { unusualPriceApproved = true; $('priceWarning').hidden = true; $('saleForm').requestSubmit(); });
  window.addEventListener('scroll', function () {
    updateCustomScrollbar();
  }, { passive: true });
  $('productsGrid').addEventListener('click', function (event) {
    var button = event.target.closest('[data-sell-item]');
    if (button && !button.disabled) {
      var item = items.find(function (entry) { return entry.id === button.dataset.sellItem; });
      if (item) openNewSale(item, number(button.dataset.sellPrice), button.dataset.sellMode);
      return;
    }
    var imageButton = event.target.closest('[data-image-view]');
    if (imageButton) {
      var product = items.find(function (entry) { return entry.id === imageButton.dataset.imageView; });
      if (!product) return;
      var images = Array.isArray(product.images) ? product.images.filter(function (img) { return img && typeof img.url === 'string' && img.url.trim(); }) : [];
      var primaryImage = images.find(function (img) { return img.isPrimary; }) || images[0] || null;
      if (!primaryImage) return;
      var modal = ensureProductImageModal();
      var imageElement = modal.querySelector('img');
      imageElement.src = primaryImage.url;
      imageElement.alt = product.name || 'صورة المنتج';
      modal.hidden = false;
      return;
    }
  });
  $('salesHistory').addEventListener('click', function (event) { var edit = event.target.closest('[data-edit-sale]'), cancel = event.target.closest('[data-cancel-sale]'), returned = event.target.closest('[data-return-sale]'), warningButton = event.target.closest('[data-warning-sale]'); if (edit) { var sale = sales.find(function (entry) { return entry.saleId === edit.dataset.editSale; }); if (sale) { showProductsPage(); openEditSale(sale); } } if (cancel) cancelSale(cancel.dataset.cancelSale); if (returned) returnSale(returned.dataset.returnSale); if (warningButton) { var warningSale = sales.find(function (entry) { return entry.saleId === warningButton.dataset.warningSale; }); if (warningSale) window.alert('سبب التنبيه: سعر القطعة المحسوب ' + (warningSale.priceWarningDirection || '') + ' من ' + (warningSale.priceType === 'mechanic' ? 'سعر الميكانيكي' : 'سعر الزبون') + ' بنسبة ' + money(warningSale.priceWarningPercent || 0) + '%.'); } });
  $('salesHistory').addEventListener('click', function (event) { if (event.target.id === 'loadMoreSales') { historyVisibleCount += 25; renderHistory(); } });
  $('backToTop').addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });
  window.addEventListener('scroll', function () { $('backToTop').classList.toggle('show', window.scrollY > 220); }, { passive: true });
  window.addEventListener('resize', updateCustomScrollbar);
  setupCustomScrollbar();
  updateCustomScrollbar();
  $('saleForm').addEventListener('submit', submitSale);
  document.querySelectorAll('[data-close-modal]').forEach(function (button) { button.addEventListener('click', function () { closeModal(button.dataset.closeModal); }); });
  document.querySelectorAll('.modal-backdrop').forEach(function (backdrop) { backdrop.addEventListener('click', function (event) { if (event.target === backdrop) closeModal(backdrop.id); }); });

  function hideSplash() { setTimeout(function () { $('splashScreen').classList.add('ready'); }, 180); }
  var authStateObserved = false;
  var authStateResolved = false;

  async function applyAuthState(user) {
    var currentUser = user || (auth && auth.currentUser ? auth.currentUser : null);
    authStateResolved = true;
    applyAdminOnlyVisibility(currentUser);

    if (currentUser) {
      $('loginScreen').hidden = true;
      $('globalProductToolbar').hidden = false;
      $('appShell').hidden = false;
      $('bottomNavigation').hidden = false;
      updateMobileNavigation('home');
      await resolveEmployeeManagerAccess(currentUser);
      applyAdminOnlyVisibility(currentUser);
      await loadMobileSettings();
      await refreshUserDisplayNameMap();
      await loadData();
      try { await loadEmployeeData(); } catch (error) { console.warn('Employee data load failed', error); }
      try { await loadDebtData(); } catch (error) { console.warn('Debt data load failed', error); }
      applyAdminOnlyVisibility(currentUser);
    } else if (authStateObserved || authStateResolved) {
      $('loginScreen').hidden = false;
      $('globalProductToolbar').hidden = true;
      $('appShell').hidden = true;
      $('bottomNavigation').hidden = true;
      closeMobileMenu();
      applyAdminOnlyVisibility(null);
    }
    hideSplash();
  }

  function observeAuthState() {
    if (!auth) {
      authStateObserved = true;
      authStateResolved = true;
      applyAuthState(null);
      return;
    }

    auth.onAuthStateChanged(function (user) {
      authStateObserved = true;
      authStateResolved = true;
      applyAuthState(user);
    });

    if (auth.currentUser) {
      authStateObserved = true;
      authStateResolved = true;
      applyAuthState(auth.currentUser);
      return;
    }

    setTimeout(function () {
      if (!authStateObserved) {
        authStateObserved = true;
        authStateResolved = true;
        applyAuthState(auth.currentUser || null);
      }
    }, 3500);
  }

  $('showEndedProductsToggle').checked = showEndedProducts;
  $('allowDebtDateEditingToggle').checked = allowDebtDateEditing;
  Promise.race([
    Promise.resolve(window.firebaseAuthPersistenceReady),
    new Promise(function (resolve) { setTimeout(resolve, 1200); })
  ]).then(observeAuthState).catch(observeAuthState);

  window.addEventListener('pageshow', function () {
    if (auth && auth.currentUser) {
      authStateObserved = true;
      authStateResolved = true;
      applyAuthState(auth.currentUser);
      return;
    }
    if (!authStateObserved) {
      observeAuthState();
    }
  });

  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault(); installPrompt = event; $('installButton').style.display = 'block';
  });
  $('installButton').addEventListener('click', async function () {
    if (!installPrompt) return;
    installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; $('installButton').style.display = 'none';
  });
  window.addEventListener('appinstalled', function () { $('installButton').style.display = 'none'; });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      if (auth && auth.currentUser) {
        authStateObserved = true;
        authStateResolved = true;
        applyAuthState(auth.currentUser);
      }
      if (Date.now() - lastSyncAt > 5 * 60 * 1000 && dataLoaded) startLiveListeners();
    }
  });
}());
