/* Mobile-only sales surface. It intentionally renders no cost, profit, capital, or analytics fields. */
(function () {
    'use strict';

    var db = window.firebaseDb;
    var auth = window.firebaseAuth;
    var SOURCE = 'mobile-sales';
    var items = [];
    var sales = [];
    var defaultCurrencySettings = { secondaryCurrencyName: 'ريال سعودي', secondaryCurrencySymbol: '﷼', exchangeRate: 3.75, defaultInputCurrency: 'primary', defaultSellCurrency: 'primary' };
    var currency = Object.assign({}, defaultCurrencySettings);
    var selectedItem = null;
    var editingSale = null;
    var toastTimer = null;
    var inventorySort = localStorage.getItem('xmetalInventorySort') || 'alphabetical';
    var dataLoaded = false;
    var listenersStarted = false;
    var lastSyncAt = 0;
    var productElements = new Map();
    var CACHE_KEY = 'xmetalMobileSalesCacheV1';
    var offlineSyncEnabled = false;
    var installPrompt = null;
    var historyVisibleCount = 25;
    var unusualPriceApproved = false;
    var salePriceManuallyEdited = false;
    var saleDefaultPrice = null;
    var userDisplayNameMap = {};
    var helpers = window.XMetalMobileSalesHelpers || {};
    var showEndedProducts = localStorage.getItem('xmetalMobileShowEndedProducts') === 'true';
    var productFilterMode = 'available';
    var debtCustomers = [];
    var debtOperations = [];
    var debtActionQueueKey = 'xmetal_mobile_debt_pending_v1';
    var customerDetailHistoryCounts = {};
    var customerDetailCycleCounts = {};

    var $ = function (id) { return document.getElementById(id); };
    var esc = function (value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); };
    var number = function (value) { var n = Number(value); return Number.isFinite(n) ? n : null; };
    var secondary = function (primary) { return (Number(primary) || 0) * (Number(currency.exchangeRate) || 1); };
    var primary = function (secondaryValue) { return (Number(secondaryValue) || 0) / (Number(currency.exchangeRate) || 1); };
    var money = function (value) { return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(value) || 0); };
    function timestampValue(timestamp) {
        if (timestamp && typeof timestamp.toMillis === 'function') return timestamp.toMillis();
        if (timestamp && Number.isFinite(Number(timestamp.seconds))) return Number(timestamp.seconds) * 1000 + (Number(timestamp.nanoseconds) || 0) / 1000000;
        if (timestamp instanceof Date) return timestamp.getTime();
        var numeric = Number(timestamp);
        if (Number.isFinite(numeric) && numeric > 0) return numeric;
        var parsed = Date.parse(timestamp);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    var date = function (timestamp) { return new Intl.DateTimeFormat('ar-SA-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestampValue(timestamp) || Date.now())); };
    var dayNames = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
    function dayKey(timestamp) { var d = new Date(timestampValue(timestamp) || Date.now()); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
    function dayLabel(timestamp) { var d = new Date(timestampValue(timestamp) || Date.now()); return dayNames[d.getDay()] + ' ' + String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear(); }
    function formatDateTime(timestamp) {
        var value = timestampValue(timestamp) || Date.now();
        return new Intl.DateTimeFormat('ar-SA-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
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
        var nextSettings = Object.assign({}, defaultCurrencySettings, currency, settings || {});
        var exchangeRate = Number(nextSettings.exchangeRate);
        if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) {
            nextSettings.exchangeRate = defaultCurrencySettings.exchangeRate;
        }
        if (!nextSettings.secondaryCurrencySymbol || !String(nextSettings.secondaryCurrencySymbol).trim()) {
            nextSettings.secondaryCurrencySymbol = defaultCurrencySettings.secondaryCurrencySymbol;
        }
        if (!nextSettings.secondaryCurrencyName || !String(nextSettings.secondaryCurrencyName).trim()) {
            nextSettings.secondaryCurrencyName = defaultCurrencySettings.secondaryCurrencyName;
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

    function saveCache() {
        if (navigator.onLine || !offlineSyncEnabled) {
            try {
                localStorage.removeItem(CACHE_KEY);
                localStorage.removeItem(CACHE_KEY + ':scrollY');
            } catch (error) {}
            return;
        }
        try {
            localStorage.setItem(CACHE_KEY, JSON.stringify({ items: items, sales: sales, currency: currency, scrollY: window.scrollY, savedAt: Date.now() }));
        } catch (error) { /* Cache is an optimization; the live listener remains authoritative. */ }
    }

    function restoreCache() {
        if (navigator.onLine || !offlineSyncEnabled) {
            try {
                localStorage.removeItem(CACHE_KEY);
                localStorage.removeItem(CACHE_KEY + ':scrollY');
            } catch (error) {}
            return false;
        }
        try {
            var cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
            if (!cached) return false;
            if (Array.isArray(cached.items)) items = cached.items;
            if (Array.isArray(cached.sales)) sales = uniqueSales(cached.sales);
            if (cached.currency) currency = Object.assign(currency, cached.currency);
            var savedScroll = Number(localStorage.getItem(CACHE_KEY + ':scrollY'));
            if (!Number.isFinite(savedScroll)) savedScroll = cached.scrollY;
            if (Number.isFinite(savedScroll)) setTimeout(function () { window.scrollTo(0, savedScroll); }, 0);
            return items.length > 0 || sales.length > 0;
        } catch (error) { return false; }
    }

    function openModal(id) { $(id).hidden = false; document.body.style.overflow = 'hidden'; }
    function closeModal(id) { $(id).hidden = true; var anyOpen = Array.prototype.some.call(document.querySelectorAll('.modal-backdrop'), function (modal) { return !modal.hidden; }); if (!anyOpen) document.body.style.overflow = ''; }

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
        var visible = filterAndSortProducts($('productSearch').value);
        $('productCount').textContent = visible.length + ' منتج';
        $('productsEmpty').hidden = visible.length !== 0;
        var visibleIds = new Set(visible.map(function (item) { return item.id; }));
        productElements.forEach(function (element, id) { if (!visibleIds.has(id)) element.remove(); });
        visible.forEach(function (item) {
            var stock = number(item.quantity) || 0, signature = JSON.stringify([item.name, stock, item.salePrice, mechanicPrice(item), currency.secondaryCurrencySymbol, currency.exchangeRate, item.location, Array.isArray(item.images) ? item.images.map(function (img) { return img && img.url ? img.url : ''; }).join('|') : '']);
            var element = productElements.get(item.id);
            if (!element) { element = document.createElement('article'); element.className = 'product-card'; element.dataset.productId = item.id; productElements.set(item.id, element); }
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
                '<button class="price-line price-action base-price" type="button" data-sell-item="' + esc(item.id) + '" data-sell-price="' + esc(item.salePrice) + '" data-sell-mode="base" ' + (stock <= 0 ? 'disabled' : '') + '><span>مبيع</span><strong>' + money(secondary(item.salePrice)) + ' ' + esc(currency.secondaryCurrencySymbol) + '</strong></button>' +
                '<button class="price-line price-action mechanic-price" type="button" data-sell-item="' + esc(item.id) + '" data-sell-price="' + esc(mechanicPrice(item)) + '" data-sell-mode="mechanic" ' + (stock <= 0 ? 'disabled' : '') + '><span>جملة</span><strong>' + money(secondary(mechanicPrice(item))) + ' ' + esc(currency.secondaryCurrencySymbol) + '</strong></button>' +
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
            var defaultPrice = saleDefaultPrice === null ? secondary(selectedItem.salePrice) : saleDefaultPrice;
            $('salePrice').value = Number((defaultPrice * quantity).toFixed(2));
        }
        var total = number($('salePrice').value) || 0;
        var unitPrice = saleDefaultPrice === null ? secondary((selectedItem && Number(selectedItem.salePrice)) || 0) : saleDefaultPrice;
        var unit = quantity > 0 ? unitPrice : 0;
        $('saleUnitPrice').value = money(unit) + ' ' + currency.secondaryCurrencySymbol;
        $('calculatedTotal').textContent = 'الإجمالي: ' + money(total) + ' ' + currency.secondaryCurrencySymbol;
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
        var referenceName = info.type === 'mechanic' ? 'سعر الجملة' : 'سعر البيع الأساسي';
        return (info.level === 'danger' ? '⚠ ' : 'ⓘ ') + 'سعر القطعة المحسوب ' + info.direction + ' من ' + referenceName + ' بنسبة ' + money(info.percent) + '%.' + ' السعر المرجعي: ' + money(secondary(info.reference)) + ' ' + currency.secondaryCurrencySymbol;
    }

    function upsertSaleLocally(sale) {
        if (!sale || !sale.saleId) return;
        var saleKey = helpers.normalizeIdValue ? helpers.normalizeIdValue(sale.saleId || sale.id || '') : String(sale.saleId || sale.id || '').trim();
        if (!saleKey) return;
        var index = sales.findIndex(function (entry) { return String(entry && (entry.saleId || entry.id || '')) === saleKey; });
        if (index === -1) sales.push(sale);
        else sales[index] = Object.assign({}, sales[index], sale);
        sales = helpers.uniqueRecordsById ? helpers.uniqueRecordsById(sales, ['saleId', 'id']) : uniqueSales(sales);
        saveCache();
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

    function readPendingSalesQueue() {
        try {
            var raw = localStorage.getItem('xmetal_mobile_sales_pending_v1');
            if (!raw) return [];
            var parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            return [];
        }
    }

    function writePendingSalesQueue(queue) {
        try {
            localStorage.setItem('xmetal_mobile_sales_pending_v1', JSON.stringify(queue));
        } catch (error) {
            console.warn('Unable to persist mobile-sales pending queue', error);
        }
    }

    function queueMobileSaleOperation(op, sale) {
        if (!offlineSyncEnabled || navigator.onLine || !sale || !sale.saleId) return;
        var queue = readPendingSalesQueue();
        var entry = { op: op, saleId: sale.saleId, payload: JSON.parse(JSON.stringify(sale)), queuedAt: Date.now(), status: 'pending' };
        var existingIndex = queue.findIndex(function (item) { return item.saleId === sale.saleId && item.op === op; });
        if (existingIndex >= 0) queue[existingIndex] = entry;
        else queue.push(entry);
        writePendingSalesQueue(queue);
    }

    async function flushPendingSalesQueue() {
        if (!offlineSyncEnabled || !db || !navigator.onLine) return;
        var queue = readPendingSalesQueue();
        if (!queue.length) return;
        var remaining = [];
        for (var i = 0; i < queue.length; i++) {
            var entry = queue[i];
            if (!entry || !entry.saleId || !entry.op) continue;
            try {
                if (entry.op === 'create') {
                    await db.collection('sales').doc(entry.saleId).set(sanitizeFirestoreData(entry.payload));
                    await logMobileActivity('sell', entry.payload || { saleId: entry.saleId });
                } else if (entry.op === 'update') {
                    await db.collection('sales').doc(entry.saleId).set(sanitizeFirestoreData(entry.payload), { merge: true });
                    await logMobileActivity('update', entry.payload || { saleId: entry.saleId });
                } else if (entry.op === 'delete') {
                    await db.collection('sales').doc(entry.saleId).delete();
                    await logMobileActivity('cancel', entry.payload || { saleId: entry.saleId });
                }
            } catch (error) {
                console.warn('Pending mobile sale redo failed', error);
                remaining.push(entry);
            }
        }
        writePendingSalesQueue(remaining);
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
        selectedItem = item; editingSale = null; var selectedPrice = number(defaultPricePrimary); saleDefaultPrice = secondary(selectedPrice === null ? item.salePrice : selectedPrice); resetSaleForm();
        $('saleModal').classList.remove('sale-edit-mode');
        $('saleModal').classList.toggle('base-price-mode', mode === 'base');
        $('saleModal').classList.toggle('mechanic-price-mode', mode === 'mechanic');
        $('saleModalTitle').textContent = mode === 'mechanic' ? 'بيع منتج وفق سعر الجملة' : 'بيع منتج وفق السعر الأساسي'; $('saleProductName').textContent = item.name || 'منتج';
        updateAvailableStock(item);
        $('saleQuantity').max = Number(item.quantity) || 0;
        $('saleCurrencyLabel').textContent = '(' + currency.secondaryCurrencySymbol + ')';
        $('salePaymentMethod').value = 'cash';
        $('saleSelectedCustomerId').value = '';
        updateSalePriceGuide();
        openModal('saleModal');
    }

    function openEditSale(sale) {
        var item = items.find(function (entry) { return entry.id === sale.itemId; });
        if (!item) return notify('المنتج غير موجود');
        selectedItem = item; editingSale = sale; saleDefaultPrice = secondary(Number(sale.unitPrice) || 0); resetSaleForm();
        $('saleModal').classList.remove('base-price-mode', 'mechanic-price-mode');
        $('saleModal').classList.add('sale-edit-mode');
        $('saleModalTitle').textContent = 'تعديل البيع'; $('saleProductName').textContent = sale.itemName || item.name || 'منتج';
        updateAvailableStock(item);
        $('saleQuantity').value = sale.quantity; $('saleQuantity').max = helpers.getSaleEditQuantityLimit ? helpers.getSaleEditQuantityLimit(item, sale) : (Number(item.quantity) || 0) + (Number(sale.quantity) || 0);
        $('salePrice').value = Number((saleDefaultPrice * (Number(sale.quantity) || 0)).toFixed(2));
        salePriceManuallyEdited = false;
        $('saleCurrencyLabel').textContent = '(' + currency.secondaryCurrencySymbol + ')';
        $('salePaymentMethod').value = sale.paymentMethod || 'cash';
        $('saleSelectedCustomerId').value = sale.customerId || '';
        $('cashSaleButton').textContent = 'حفظ التعديل';
        $('creditSaleButton').hidden = true;
        updateSalePriceGuide();
        openModal('saleModal');
    }

    function readPendingDebtQueue() {
        try {
            var raw = localStorage.getItem(debtActionQueueKey);
            if (!raw) return [];
            var parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            return [];
        }
    }

    function writePendingDebtQueue(queue) {
        try {
            localStorage.setItem(debtActionQueueKey, JSON.stringify(queue));
        } catch (error) {
            console.warn('Unable to persist debt queue', error);
        }
    }

    function getDebtCustomerOperations(customerId) {
        return debtOperations.filter(function (op) {
            if (!op || String(op.customerId) !== String(customerId)) return false;
            return op.status !== 'cancelled';
        }).sort(function (a, b) { return getOperationDateValue(b) - getOperationDateValue(a); });
    }

    function isSaleHiddenFromHistory(sale) {
        if (!sale || typeof sale !== 'object') return false;
        var status = String(sale.status || sale.saleStatus || '').trim().toLowerCase();
        return Boolean(sale.cancelled || sale.isCancelled || sale.refunded || sale.isRefunded || status === 'cancelled' || status === 'refunded' || status === 'returned' || status === 'partially_refunded' || status === 'partially_returned');
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
                return '<div class="debt-history-item ' + entry.type + '"><span>' + esc(label) + ' • ' + esc(entry.note || 'بدون ملاحظة') + '</span><strong>' + sign + ' ' + esc(money(Number(entry.amount) || 0)) + '</strong></div>';
            }).join('') : '<div class="debt-history-item debt"><span>لا توجد حركات مالية</span><strong>0</strong></div>';
            var isZeroBalance = balance <= 0;
            return '<article class="debt-customer-card"><div class="debt-customer-head"><div><strong>' + esc(customer.name || 'عميل') + '</strong><div class="debt-customer-meta">' + esc(customer.phone || 'بدون هاتف') + '</div></div><div class="debt-balance ' + (balance > 0 ? 'due' : 'paid') + '">' + (balance > 0 ? 'مستحق: ' : 'مدفوع: ') + esc(money(Math.abs(balance))) + ' ' + esc(currency.secondaryCurrencySymbol || '') + '</div></div><div class="debt-history">' + historyMarkup + '</div><div class="debt-action-row"><button type="button" class="positive-action" data-debt-action="debt" data-debt-customer-id="' + esc(customer.id) + '">إضافة دين</button><button type="button" data-debt-action="payment" data-debt-customer-id="' + esc(customer.id) + '" ' + (isZeroBalance ? 'disabled aria-disabled="true"' : '') + '>سداد</button><button type="button" class="danger-action" data-debt-action="settle" data-debt-customer-id="' + esc(customer.id) + '" ' + (isZeroBalance ? 'disabled aria-disabled="true"' : '') + '>سداد كامل</button></div></article>';
        }).join('');
        renderDebtPageList();
    }

    function formatShortDate(timestamp) {
        var value = timestampValue(timestamp) || Date.now();
        return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(value)).replace(/\//g, '-');
    }

    function getOperationDateValue(entry) {
        if (!entry || typeof entry !== 'object') return 0;
        var directDate = entry.operationDate || entry.operation_date || entry.dateKey || entry.date || entry.operationDateKey || '';
        if (typeof directDate === 'string' && directDate.trim()) {
            var trimmed = directDate.trim();
            var isoCandidate = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed + 'T12:00:00' : trimmed;
            var parsed = Date.parse(isoCandidate);
            if (Number.isFinite(parsed)) return parsed;
        }
        return timestampValue(entry.timestamp) || 0;
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
        var searchInput = $('debtProductSearch');
        var query = searchInput ? String(searchInput.value || '').trim().toLowerCase() : '';
        var filteredCustomers = debtCustomers.filter(function (customer) {
            if (!query) return true;
            var haystack = [customer.name || '', customer.phone || '', customer.notes || ''].join(' ').toLowerCase();
            return haystack.indexOf(query) !== -1;
        });
        if (!filteredCustomers.length) {
            list.innerHTML = '<div class="empty-state">لا يوجد عملاء مطابقون للبحث</div>';
            return;
        }
        var rows = filteredCustomers.map(function (customer, index) {
            var summary = getDebtCustomerSummary(customer.id);
            var statusClass = summary.status === 'settled' ? 'debt-status-settled' : summary.status === 'late' ? 'debt-status-late' : summary.status === 'active' ? 'debt-status-active' : 'debt-status-new';
            var lastDebtDate = summary.lastDebt ? formatShortDate(getOperationDateValue(summary.lastDebt)) : '-';
            var lastPaymentDate = summary.lastPayment ? formatShortDate(getOperationDateValue(summary.lastPayment)) : '-';
            return '<tr tabindex="0" data-debt-customer-id="' + esc(customer.id) + '"><td>' + esc(index + 1) + '</td><td class="debt-customer-row-name">' + esc(customer.name || 'عميل') + '</td><td class="debt-amount ' + (summary.balance > 0 ? 'due' : 'paid') + '">' + esc(money(Math.abs(summary.balance))) + ' ' + esc(currency.secondaryCurrencySymbol || '') + '</td><td class="debt-amount paid">' + esc(money(summary.totalPayment)) + ' ' + esc(currency.secondaryCurrencySymbol || '') + '</td><td>' + esc(lastDebtDate) + '</td><td>' + esc(lastPaymentDate) + '</td><td><span class="debt-status-badge ' + statusClass + '">' + esc(summary.statusLabel) + '</span></td></tr>';
        }).join('');

        list.innerHTML = '<div class="debt-table-wrap"><table class="debt-customers-table"><thead><tr><th>#</th><th>الاسم</th><th>الدين المستحق</th><th>الدين المسدد</th><th>آخر دين</th><th>آخر سداد</th><th>الحالة</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
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
                    var label = entry.type === 'debt' ? 'دين' : entry.type === 'payment' ? 'سداد' : entry.type === 'settle' ? 'تسوية' : 'إلغاء';
                    var rowClass = entry.type === 'debt' ? 'debt' : entry.type === 'payment' ? 'payment' : entry.type === 'settle' ? 'settle' : 'cancel';
                    var amountValue = Number(entry.amount) || 0;
                    var noteText = entry.type === 'debt' ? normalizeDebtNoteText(entry.note) : String(entry.note || 'بدون ملاحظات');
                    var allocationInfo = entry.type === 'payment' ? summarizePaymentAllocation(entry) : null;
                    var debtProgress = entry.type === 'debt' ? getDebtOperationPaymentProgress(entry, debtOperations) : null;
                    var isFullyPaidDebt = entry.type === 'debt' && Boolean(debtProgress && debtProgress.isPaid);
                    var rowPaidClass = isFullyPaidDebt ? ' is-paid' : '';
                    var splitMarkup = allocationInfo && allocationInfo.hasSplit ? '<div class="payment-allocation-bar"><span class="allocation-part refunded" style="width:' + Math.max(0, Math.min(100, allocationInfo.refundedPercent)) + '%"></span><span class="allocation-part active" style="width:' + Math.max(0, Math.min(100, allocationInfo.activePercent)) + '%"></span></div><div class="allocation-labels"><span>' + Math.round(allocationInfo.refundedPercent) + '% مسترد X</span><span>' + Math.round(allocationInfo.activePercent) + '% قائم</span></div>' : '';
                    var settledMarkup = isFullyPaidDebt ? '<span class="paid-strike-label">تم السداد</span>' : (entry.type === 'debt' && debtProgress && debtProgress.percent > 0 && debtProgress.percent < 100 ? '<span class="paid-partial-label">' + Math.round(debtProgress.percent) + '%</span>' : '');
                    var amountCell = '<div class="amount-cell ' + (isFullyPaidDebt ? 'is-paid' : '') + '">' + esc(money(amountValue)) + ' ' + esc(currency.secondaryCurrencySymbol || '') + (settledMarkup ? ' ' + settledMarkup : '') + '</div>' + splitMarkup;
                    return '<tr class="' + rowClass + rowPaidClass + ' debt-operation-row" data-debt-operation-id="' + esc(entry.id) + '" title="اضغط للتعديل أو الحذف"><td>' + esc(label) + '</td><td class="amount-cell-wrap">' + amountCell + '</td><td>' + esc(formatDateTime(getOperationDateValue(entry))) + '</td><td>' + esc(noteText) + '</td></tr>';
                }).join('');
                return '<div class="customer-detail-day-group"><div class="customer-detail-day-header">' + esc(dayLabel(new Date(day + 'T00:00:00').getTime())) + '</div><table class="customer-detail-operations-table"><thead><tr><th>النوع</th><th>المبلغ</th><th>التاريخ والوقت</th><th>ملاحظات</th></tr></thead><tbody>' + rowsMarkup + '</tbody></table></div>';
            }).join('') : '<div class="empty-state">لا توجد عمليات في هذه الدورة.</div>';
            var separator = cycleIndex < cycleGroups.length - 1 ? '<div class="customer-detail-cycle-separator" aria-hidden="true"></div>' : '';
            return '<div class="customer-detail-cycle-block">' + dayMarkup + '</div>' + separator;
        }).join('') + '</div>';
    }

    function openDebtCustomerDetail(customerId) {
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

        container.innerHTML = '<div class="customer-detail-summary"><div class="customer-detail-head"><h3>' + esc(customer.name || 'عميل') + '</h3><span class="debt-status-badge ' + (summary.status === 'settled' ? 'debt-status-settled' : summary.status === 'late' ? 'debt-status-late' : summary.status === 'active' ? 'debt-status-active' : 'debt-status-new') + '">' + esc(summary.statusLabel) + '</span></div><table class="customer-detail-summary-table"><thead><tr><th>الاسم</th><th>الهاتف</th><th>الدين الحالي</th><th>المسدد سابقاً</th><th>آخر دين</th><th>آخر سداد</th></tr></thead><tbody><tr><td>' + esc(customer.name || 'عميل') + '</td><td>' + esc(customer.phone || 'غير محدد') + '</td><td class="debt-amount ' + (summary.balance > 0 ? 'due' : 'paid') + '">' + esc(money(Math.abs(summary.balance))) + ' ' + esc(currency.secondaryCurrencySymbol || '') + '</td><td>' + esc(money(summary.totalPayment)) + ' ' + esc(currency.secondaryCurrencySymbol || '') + '</td><td>' + esc(summary.lastDebt ? formatShortDate(getOperationDateValue(summary.lastDebt)) : '-') + '</td><td>' + esc(summary.lastPayment ? formatShortDate(getOperationDateValue(summary.lastPayment)) : '-') + '</td></tr></tbody></table><div class="customer-detail-notes"><span>الملاحظات</span><p>' + esc(customer.notes || 'لا توجد ملاحظات') + '</p></div></div><div class="customer-detail-actions"><button type="button" class="debt-add" data-debt-detail-action="debt" data-debt-detail-customer-id="' + esc(customer.id) + '">إضافة دين</button><button type="button" class="debt-pay" data-debt-detail-action="payment" data-debt-detail-customer-id="' + esc(customer.id) + '" ' + (isZeroBalance ? 'disabled aria-disabled="true"' : '') + '>سداد جزئي</button><button type="button" class="debt-settle" data-debt-detail-action="settle" data-debt-detail-customer-id="' + esc(customer.id) + '" ' + (isZeroBalance ? 'disabled aria-disabled="true"' : '') + '>سداد كامل</button></div><div class="customer-detail-operations"><h3>سجل العمليات</h3>' + (visibleCycleGroups.length ? operationsMarkup : '<div class="empty-state">لا توجد دورات دين لعرضها الآن.</div>') + additionalHistoryAction + '</div>';
        openModal('customerDetailModal');
    }

    function showDebtPage() {
        if (!$('appShell') || !$('debtPage')) return;
        $('appShell').hidden = true;
        $('debtPage').hidden = false;
        renderDebtPageList();
    }

    function showProductsPage() {
        if (!$('appShell') || !$('debtPage')) return;
        $('debtPage').hidden = true;
        $('appShell').hidden = false;
    }

    function renderCreditCustomerList() {
        var list = $('creditCustomerList');
        if (!list) return;
        if (!debtCustomers.length) {
            list.innerHTML = '<div class="empty-state">لا توجد عملاء مسجلين. أضف عميلًا من قسم الديون أولاً.</div>';
            return;
        }
        list.innerHTML = debtCustomers.map(function (customer) {
            var balance = getCustomerBalance(customer.id);
            var statusLabel = balance > 0 ? 'مستحق: ' + money(balance) : 'مدفوع: ' + money(Math.abs(balance));
            return '<button class="credit-customer-item" type="button" data-credit-customer-id="' + esc(customer.id) + '"><strong>' + esc(customer.name || 'عميل') + '</strong><small>' + esc(customer.phone || 'بدون هاتف') + ' • ' + esc(statusLabel) + ' ' + esc(currency.secondaryCurrencySymbol || '') + '</small></button>';
        }).join('');
    }

    function openCreditCustomerPicker() {
        if (!debtCustomers.length) {
            showError('saleError', 'لا توجد عملاء مسجلين. انتقل إلى قسم الديون لإضافة عميل أولاً.');
            notify('لا توجد عملاء مسجلين. أضف عميلًا من قسم الديون أولاً.');
            return;
        }
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
        $('debtAmount').value = '';
        $('debtAmount').required = actionType !== 'settle';
        $('debtAmount').disabled = actionType === 'settle';
        $('debtActionDate').value = new Date().toISOString().slice(0, 10);
        $('debtActionNote').value = '';
        $('debtActionTitle').textContent = actionType === 'payment' ? 'سداد جزئي' : actionType === 'settle' ? 'تأكيد السداد الكامل' : 'إضافة دين';
        var typeRow = $('debtActionTypeRow');
        var amountRow = $('debtAmountRow');
        var confirmRow = $('debtConfirmRow');
        var currentBalanceRow = $('debtCurrentBalanceRow');
        var submitButton = $('debtActionSubmit');
        var deleteButton = $('deleteDebtOperationButton');
        var currentBalanceText = 'الدين الحالي: ' + money(Math.abs(balance)) + ' ' + (currency.secondaryCurrencySymbol || '');

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

    function openPaidSaleCancelModal(saleId) {
        if (!saleId) return;
        $('paidSaleCancelModal').dataset.pendingSaleId = saleId;
        openModal('paidSaleCancelModal');
    }

    async function finalizePaidSaleRefund(saleId) {
        var sale = await resolveCurrentSaleRecord(saleId);
        if (!sale) return;
        var linkedDebtOperation = helpers.findLinkedDebtOperation ? helpers.findLinkedDebtOperation(sale, debtOperations) : null;
        var saleKey = helpers.normalizeIdValue ? helpers.normalizeIdValue(sale.saleId || sale.id || sale.relatedSaleId || sale.linkedSaleId || sale.debtOperationId || sale.relatedDebtOperationId || sale.linkedDebtOperationId || sale.saleDebtOperationId) : String(sale.saleId || '').trim();
        var customerId = sale.customerId || (linkedDebtOperation && linkedDebtOperation.customerId) || null;
        var item = (Array.isArray(items) ? items : []).find(function (entry) { return entry && entry.id === sale.itemId; });
        if (!item) {
            try {
                var itemDoc = await db.collection('items').doc(sale.itemId).get({ source: navigator.onLine ? 'default' : 'cache' });
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
                var nextPayment = Object.assign({}, paymentEntry, { allocations: keptAllocations, amount: keptAllocations.reduce(function (sum, allocation) { return sum + (Number(allocation.amount) || 0); }, 0), status: 'active', refundedSaleId: null, refundedAt: null });
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
                await db.collection('debtOperations').doc(linkedDebtOperation.id).delete();
                debtOperations = debtOperations.filter(function (entry) { return String(entry.id) !== String(linkedDebtOperation.id); });
            } catch (error) {
                queueDebtOperation({ kind: 'delete-operation', payload: { id: linkedDebtOperation.id }, operationId: linkedDebtOperation.id });
                debtOperations = debtOperations.filter(function (entry) { return String(entry.id) !== String(linkedDebtOperation.id); });
                console.warn('Refunded sale debt removal queued', error);
            }
        }

        var safeSaleAllocations = sanitizeBatchAllocations(sale.purchaseBatchAllocations);
        var restored = safeSaleAllocations.length ? await restoreBatches(item.id, safeSaleAllocations) : await updateQuantity(item.id, sale.quantity);
        if (restored === null || restored === undefined || (typeof restored === 'object' && restored.quantity === undefined)) { notify('تعذر استرجاع كمية المنتج المرتبط'); return; }

        await db.collection('sales').doc(saleId).delete();
        await updateStats(-(Number(sale.profit) || 0));
        await logMobileActivity('cancel', sale);
        item.quantity = typeof restored === 'number' ? restored : restored.quantity;
        if (typeof restored === 'object' && restored.purchaseBatches) item.purchaseBatches = restored.purchaseBatches;
        var localItemIndex = items.findIndex(function (entry) { return entry && entry.id === item.id; });
        if (localItemIndex >= 0) items[localItemIndex] = item; else items.push(item);
        sales = sales.filter(function (entry) { return !entry || entry.saleId !== saleId; });
        saveCache();
        renderProducts(); renderHistory(); renderDebtList();
        notify('تم إلغاء البيع واسترداد المبلغ للعميل');
    }

    async function finalizePaidSaleOldDebt(saleId) {
        var sale = await resolveCurrentSaleRecord(saleId);
        if (!sale) return;
        var linkedDebtOperation = helpers.findLinkedDebtOperation ? helpers.findLinkedDebtOperation(sale, debtOperations) : null;
        var saleKey = helpers.normalizeIdValue ? helpers.normalizeIdValue(sale.saleId || sale.id || sale.relatedSaleId || sale.linkedSaleId || sale.debtOperationId || sale.relatedDebtOperationId || sale.linkedDebtOperationId || sale.saleDebtOperationId) : String(sale.saleId || '').trim();
        var customerId = sale.customerId || (linkedDebtOperation && linkedDebtOperation.customerId) || null;
        var item = (Array.isArray(items) ? items : []).find(function (entry) { return entry && entry.id === sale.itemId; });
        if (!item) {
            try {
                var itemDoc = await db.collection('items').doc(sale.itemId).get({ source: navigator.onLine ? 'default' : 'cache' });
                if (itemDoc.exists) item = Object.assign({ id: itemDoc.id }, itemDoc.data());
            } catch (error) { notify('تعذر الوصول إلى المنتج المرتبط بالبيع'); return; }
        }
        if (!item || !item.id) { notify('المنتج المرتبط بعملية البيع غير موجود'); return; }

        var paidAmount = helpers.getSalePaidAmount ? helpers.getSalePaidAmount(sale, debtOperations) : 0;
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
                await db.collection('debtOperations').doc(linkedDebtOperation.id).delete();
                debtOperations = debtOperations.filter(function (entry) { return String(entry.id) !== String(linkedDebtOperation.id); });
            } catch (error) {
                queueDebtOperation({ kind: 'delete-operation', payload: { id: linkedDebtOperation.id }, operationId: linkedDebtOperation.id });
                debtOperations = debtOperations.filter(function (entry) { return String(entry.id) !== String(linkedDebtOperation.id); });
                console.warn('Old-debt reallocation debt removal queued', error);
            }
        }

        var remainingSales = sales.filter(function (entry) { return entry && entry.saleId !== saleId && String(entry.customerId || '') === String(customerId || ''); });
        var remainingDebtBalance = customerId ? helpers.getCustomerDebtBalance(customerId, remainingSales, debtOperations) : 0;
        var paymentType = paidAmount >= Math.max(0, Number(remainingDebtBalance) || 0) ? 'settle' : 'payment';
        var newPayment = {
            id: 'debt_op_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            customerId: customerId,
            customerName: sale.customerName || '',
            type: paymentType,
            amount: paidAmount,
            note: 'سداد عن ديون قديمة',
            dateKey: new Date().toISOString().slice(0, 10),
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

        await db.collection('sales').doc(saleId).delete();
        await updateStats(-(Number(sale.profit) || 0));
        await logMobileActivity('cancel', sale);
        item.quantity = typeof restored === 'number' ? restored : restored.quantity;
        if (typeof restored === 'object' && restored.purchaseBatches) item.purchaseBatches = restored.purchaseBatches;
        var localItemIndex = items.findIndex(function (entry) { return entry && entry.id === item.id; });
        if (localItemIndex >= 0) items[localItemIndex] = item; else items.push(item);
        sales = sales.filter(function (entry) { return !entry || entry.saleId !== saleId; });
        saveCache();
        renderProducts(); renderHistory(); renderDebtList();
        notify('تم إلغاء البيع وحفظ المبلغ كسداد عن ديون قديمة');
    }

    function openPaidSaleCancelOption(saleId, choice) {
        if (!saleId) return;
        closeModal('paidSaleCancelModal');
        if (choice === 'refund') {
            finalizePaidSaleRefund(saleId).catch(function (error) { notify(error.message || 'تعذر استرداد المبلغ للعميل'); });
            return;
        }
        finalizePaidSaleOldDebt(saleId).catch(function (error) { notify(error.message || 'تعذر تحويل المبلغ إلى سداد على ديون قديمة'); });
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
        $('debtActionDate').value = operation.dateKey || new Date(Number(operation.timestamp) || Date.now()).toISOString().slice(0, 10);
        $('debtActionNote').value = operation.note || '';
        $('debtActionTitle').textContent = 'تعديل الحركة';

        var typeRow = $('debtActionTypeRow');
        var amountRow = $('debtAmountRow');
        var confirmRow = $('debtConfirmRow');
        var currentBalanceRow = $('debtCurrentBalanceRow');
        var submitButton = $('debtActionSubmit');
        var deleteButton = $('deleteDebtOperationButton');

        if (typeRow) typeRow.hidden = false;
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

    async function resolveCurrentSaleRecord(saleId) {
        var normalizedId = helpers.normalizeIdValue ? helpers.normalizeIdValue(saleId) : String(saleId || '').trim();
        if (!normalizedId) return null;
        var localSales = Array.isArray(sales) ? sales : [];
        var localMatch = localSales.find(function (entry) { return entry && String(entry.saleId || entry.id || '') === normalizedId; });
        if (localMatch && localMatch.quantity !== null && localMatch.quantity !== undefined) {
            return Object.assign({}, localMatch, { saleId: normalizedId });
        }
        if (!db || !db.collection) return localMatch ? Object.assign({}, localMatch, { saleId: normalizedId }) : null;
        try {
            var snapshot = await db.collection('sales').doc(normalizedId).get();
            if (snapshot && snapshot.exists) {
                var fresh = Object.assign({ saleId: snapshot.id }, snapshot.data());
                upsertSaleLocally(fresh);
                saveCache();
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
            saveCache();
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
            debtCustomers.push(customer);
            renderDebtList();
            if (form && form.id === 'debtCustomerForm') {
                form.reset();
                closeModal('debtCustomerModal');
                if ($('debtPage').hidden === false) openDebtCustomerDetail(customer.id);
            } else {
                $('customerForm').reset();
            }
            notify('تم إضافة العميل بنجاح');
        } catch (error) {
            debtCustomers.push(customer);
            renderDebtList();
            if (form && form.id === 'debtCustomerForm') {
                form.reset();
                closeModal('debtCustomerModal');
            } else {
                $('customerForm').reset();
            }
            notify('تم حفظ العميل محليًا وسيتم مزامنته عند عودة الإنترنت');
            queueDebtOperation({ kind: 'customer', payload: customer, operationId: 'customer_' + customer.id });
        }
    }

    function queueDebtOperation(entry) {
        if (!offlineSyncEnabled || navigator.onLine) return;
        var queue = readPendingDebtQueue();
        var existingIndex = queue.findIndex(function (item) { return String(item.operationId || item.payload && item.payload.id) === String(entry.operationId || (entry.payload && entry.payload.id)); });
        if (existingIndex >= 0) queue[existingIndex] = entry; else queue.push(entry);
        writePendingDebtQueue(queue);
    }

    async function flushPendingDebtQueue() {
        if (!offlineSyncEnabled || !db || !navigator.onLine) return;
        var queue = readPendingDebtQueue();
        if (!queue.length) return;
        var remaining = [];
        for (var i = 0; i < queue.length; i += 1) {
            var entry = queue[i];
            try {
                if (entry.kind === 'customer') {
                    await db.collection('debtCustomers').doc(entry.payload.id).set(entry.payload);
                } else if (entry.kind === 'operation') {
                    await db.collection('debtOperations').doc(entry.payload.id).set(entry.payload);
                } else if (entry.kind === 'delete-operation') {
                    if (entry.payload && entry.payload.id) {
                        await db.collection('debtOperations').doc(entry.payload.id).delete();
                    }
                }
            } catch (error) {
                remaining.push(entry);
            }
        }
        writePendingDebtQueue(remaining);
    }

    function createPaymentAllocations(customerId, paymentAmount, paymentId, customSales) {
        var customerSales = (Array.isArray(customSales) ? customSales : (Array.isArray(sales) ? sales : [])).filter(function (sale) {
            if (!sale || String(sale.customerId) !== String(customerId)) return false;
            if (sale.cancelled || sale.status === 'cancelled' || sale.isCancelled) return false;
            if (helpers.isOriginalCreditSale) return helpers.isOriginalCreditSale(sale);
            return sale.paymentMethod === 'credit' || sale.isCreditSale;
        }).sort(function (a, b) { return timestampValue(a.timestamp) - timestampValue(b.timestamp); });
        var remaining = Number(paymentAmount) || 0;
        var allocations = [];
        customerSales.forEach(function (sale) {
            if (remaining <= 0) return;
            var saleId = helpers.normalizeIdValue ? helpers.normalizeIdValue(sale.saleId || sale.id || sale.debtOperationId || sale.relatedSaleId || sale.relatedDebtOperationId || sale.linkedSaleId || sale.linkedDebtOperationId || sale.saleDebtOperationId) : String(sale.saleId || sale.id || '').trim();
            if (!saleId) return;
            var totalAmount = Number(sale.displayTotalAmount || sale.rawTotalAmount || sale.totalAmount || sale.amount || 0) || 0;
            var salesSource = Array.isArray(customSales) ? customSales : sales;
            var alreadyAllocated = Number((helpers.getCustomerSalePaymentAllocations ? helpers.getCustomerSalePaymentAllocations(salesSource, debtOperations)[String(customerId)] || {} : {})[saleId]) || 0;
            var available = Math.max(0, totalAmount - alreadyAllocated);
            if (available <= 0) return;
            var amount = Math.min(remaining, available);
            if (amount > 0) {
                allocations.push({ saleId: saleId, amount: amount, customerId: customerId, paymentId: paymentId, status: 'active' });
                remaining -= amount;
            }
        });
        return allocations;
    }

    async function saveDebtOperation(event) {
        event.preventDefault();
        var customerId = $('debtCustomerId').value;
        var mode = String($('debtOperationMode').value || 'create').trim();
        var operationId = String($('debtOperationId').value || '').trim();
        var type = String($('debtActionType').value || ($('debtActionTypeDisplay') ? $('debtActionTypeDisplay').value : '') || 'debt').trim();
        var amount = Number($('debtAmount').value) || 0;
        var dateValue = $('debtActionDate').value || new Date().toISOString().slice(0, 10);
        var note = String($('debtActionNote').value || '').trim();
        if (!customerId) { notify('العميل غير موجود'); return; }
        var customer = debtCustomers.find(function (entry) { return String(entry.id) === String(customerId); });
        if (!customer) { notify('العميل غير موجود'); return; }

        if (type === 'debt') {
            if (amount <= 0) { notify('يرجى إدخال مبلغ صحيح'); return; }
        } else if (type === 'payment') {
            if (amount <= 0) { notify('يرجى إدخال مبلغ السداد'); return; }
        } else if (type === 'settle') {
            amount = Math.max(0, getCustomerBalance(customerId));
            if (amount <= 0) { notify('لا يوجد دين مستحق للسداد'); return; }
            note = note || 'سداد كامل';
        }

        var ownership = getCurrentUserOwnership();

        if (mode === 'edit' && operationId) {
            var existingOperation = debtOperations.find(function (entry) { return String(entry.id) === String(operationId); });
            if (!existingOperation) { notify('الحركة المراد تعديلها غير موجودة'); return; }
            var updatedOperation = Object.assign({}, existingOperation, {
                customerId: customerId,
                type: type,
                amount: amount,
                note: note,
                dateKey: dateValue,
                operationDate: dateValue,
                timestamp: Number(existingOperation.timestamp) || Date.now(),
                source: SOURCE,
                customerName: customer.name,
                userId: ownership.userId,
                ownerId: ownership.ownerId,
                createdBy: ownership.createdBy,
                uid: ownership.uid,
                status: 'active'
            });
            if (type === 'payment' || type === 'settle') {
                updatedOperation.allocations = createPaymentAllocations(customerId, updatedOperation.amount, updatedOperation.id);
            } else {
                delete updatedOperation.allocations;
            }
            try {
                await db.collection('debtOperations').doc(updatedOperation.id).set(updatedOperation);
                debtOperations = debtOperations.map(function (entry) { return String(entry.id) === String(updatedOperation.id) ? updatedOperation : entry; });
                renderDebtList();
                closeModal('debtActionModal');
                notify('تم تعديل الحركة');
            } catch (error) {
                queueDebtOperation({ kind: 'operation', payload: updatedOperation, operationId: updatedOperation.id });
                debtOperations = debtOperations.map(function (entry) { return String(entry.id) === String(updatedOperation.id) ? updatedOperation : entry; });
                renderDebtList();
                closeModal('debtActionModal');
                notify('تم حفظ التعديل محليًا وسيتم مزامنته عند عودة الإنترنت');
            }
            return;
        }

        var operation = {
            id: 'debt_op_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            customerId: customerId,
            type: type,
            amount: amount,
            note: note,
            dateKey: dateValue,
            operationDate: dateValue,
            timestamp: Date.now(),
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
        }
        try {
            await db.collection('debtOperations').doc(operation.id).set(operation);
            upsertDebtOperationLocally(operation);
            closeModal('debtActionModal');
            notify(type === 'payment' ? 'تم تسجيل السداد' : type === 'settle' ? 'تم تسجيل السداد الكامل' : 'تم إضافة الدين');
        } catch (error) {
            queueDebtOperation({ kind: 'operation', payload: operation, operationId: operation.id });
            upsertDebtOperationLocally(operation);
            closeModal('debtActionModal');
            notify('تم حفظ الحركة محليًا وسيتم مزامنتها عند عودة الإنترنت');
        }
    }

    async function deleteDebtOperation(operationId) {
        var operation = debtOperations.find(function (entry) { return String(entry.id) === String(operationId); });
        if (!operation) return notify('الحركة غير موجودة');
        try {
            await db.collection('debtOperations').doc(operation.id).delete();
            debtOperations = debtOperations.filter(function (entry) { return String(entry.id) !== String(operation.id); });
            renderDebtList();
            closeModal('debtActionModal');
            notify('تم حذف الحركة');
        } catch (error) {
            queueDebtOperation({ kind: 'delete-operation', payload: operation, operationId: operation.id });
            debtOperations = debtOperations.filter(function (entry) { return String(entry.id) !== String(operation.id); });
            renderDebtList();
            closeModal('debtActionModal');
            notify('تم حذف الحركة محليًا وسيتم مزامنتها عند عودة الإنترنت');
        }
    }

    function renderHistory() {
        try {
        Promise.resolve(refreshUserDisplayNameMap()).catch(function () {});
        var ordered = (Array.isArray(sales) ? sales : []).filter(function (sale) { return !isSaleHiddenFromHistory(sale); }).slice().sort(function (a, b) { return timestampValue(b.timestamp) - timestampValue(a.timestamp); });
        var shown = ordered.slice(0, historyVisibleCount), previousDay = null, currentDayTotal = 0, html = '';
        shown.forEach(function (sale, index) {
            var currentDay = dayKey(sale.timestamp);
            if (currentDay !== previousDay) {
                if (previousDay !== null) html += '<div class="day-total">إجمالي مبيعات اليوم: ' + money(currentDayTotal) + ' ' + esc(currency.secondaryCurrencySymbol) + '</div>';
                html += '<div class="history-day"><strong>' + esc(dayLabel(sale.timestamp)) + '</strong></div>';
                previousDay = currentDay;
                currentDayTotal = 0;
            }
            currentDayTotal += secondary((Number(sale.unitPrice) || 0) * (Number(sale.quantity) || 0));
            var warningBadge = sale.priceWarningLevel && sale.priceWarningLevel !== 'none' ? '<button type="button" class="warning-badge ' + esc(sale.priceWarningLevel) + '" data-warning-sale="' + esc(sale.saleId) + '" aria-label="عرض سبب التنبيه">!</button>' : '';
            var sellerLabel = getSellerLabel(sale);
            var paymentState = helpers.getSalePaymentProgress ? helpers.getSalePaymentProgress(sale, sales, debtOperations) : { amount: Number(sale.totalAmount) || 0, paidAmount: 0, percent: 0, isPaid: false, isCredit: sale.paymentMethod === 'credit' || sale.isCreditSale, hasPayment: false, background: '#d83a4b' };
            var isCreditSale = Boolean(paymentState.isCredit);
            var saleTypeLabel = isCreditSale ? 'آجل' : 'كاش';
            var statusKey = String(sale.status || '').trim().toLowerCase();
            var saleStatusLabel = isCreditSale ? (statusKey === 'refunded' || statusKey === 'returned' || statusKey === 'cancelled' ? 'مستردة' : (statusKey === 'partially_refunded' || statusKey === 'partially_returned' ? 'مستردة جزئيًا' : (paymentState.isPaid ? 'تم السداد' : (paymentState.percent > 0 ? 'مسدد جزئيًا' : 'غير مسدد')))) : '';
            var customerText = sale.customerName ? '<span>العميل: ' + esc(sale.customerName) + '</span>' : '';
            var statusMarkup = isCreditSale ? (customerText || '<span>حالة: ' + esc(saleStatusLabel) + '</span>') : customerText;
            var paymentStatusText = isCreditSale ? (statusKey === 'refunded' || statusKey === 'returned' || statusKey === 'cancelled' ? 'مستردة' : (statusKey === 'partially_refunded' || statusKey === 'partially_returned' ? 'مستردة جزئيًا' : (paymentState.isPaid ? 'تم السداد' : Math.round(paymentState.percent) + '%'))) : '';
            var paymentProgressMarkup = isCreditSale ? '<div class="sale-payment-box"><div class="sale-payment-head"><span>نسبة السداد</span><strong>' + paymentStatusText + '</strong></div><div class="sale-payment-track"><div class="sale-payment-fill" style="width: ' + (statusKey === 'refunded' || statusKey === 'returned' || statusKey === 'cancelled' ? '0' : Math.max(0, Math.min(100, paymentState.percent))) + '%; background: ' + (statusKey === 'refunded' || statusKey === 'returned' || statusKey === 'cancelled' ? '#d83a4b' : (paymentState.isPaid ? 'linear-gradient(90deg, #159447 0%, #159447 100%)' : paymentState.background)) + ';"></div></div></div>' : '';
            var settledClass = paymentState.isPaid ? ' is-paid' : '';
            html += '<article class="sale-record' + settledClass + ' ' + (sale.priceWarningLevel && sale.priceWarningLevel !== 'none' ? 'has-price-warning ' + esc(sale.priceWarningLevel) : '') + '" data-sale-payment-state="' + esc(String(isCreditSale ? 'credit' : 'cash')) + '"><div class="sale-number" aria-label="رقم العملية">' + (index + 1) + '</div><h3>' + esc(sale.itemName || 'منتج') + warningBadge + '</h3>' +
                '<div class="sale-meta"><span>' + esc(date(sale.timestamp)) + '</span><span>البائع: ' + esc(sellerLabel) + '</span></div>' +
                '<div class="sale-meta"><span>نوع البيع: ' + esc(saleTypeLabel) + '</span>' + (statusMarkup || '') + '</div>' +
                '<p class="sale-total">سعر القطعة: <span class="sale-unit-value">' + money(secondary(sale.unitPrice)) + '</span> × الكمية: <span class="sale-quantity-value">' + money(sale.quantity) + '</span> = الإجمالي: <span class="sale-grand-total">' + money(secondary((Number(sale.unitPrice) || 0) * (Number(sale.quantity) || 0))) + ' ' + esc(currency.secondaryCurrencySymbol) + '</span></p>' +
                paymentProgressMarkup +
                '<div class="record-actions"><button type="button" data-edit-sale="' + esc(sale.saleId) + '">تعديل الكمية/السعر</button>' +
                '<button type="button" class="cancel-sale" data-cancel-sale="' + esc(sale.saleId) + '">إلغاء البيع</button></div></article>';
        });
        if (previousDay !== null) html += '<div class="day-total">إجمالي مبيعات اليوم: ' + money(currentDayTotal) + ' ' + esc(currency.secondaryCurrencySymbol) + '</div>';
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
            var current = Number(doc.data().quantity) || 0, next = current + Number(delta);
            if (next < 0) throw new Error('الكمية المتوفرة غير كافية');
            tx.update(ref, { quantity: next, updatedAt: Date.now() }); return next;
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
            var data = doc.data(), batches = Array.isArray(data.purchaseBatches) ? data.purchaseBatches.filter(function (batch) { return batch && typeof batch === 'object'; }).slice() : [];
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
            tx.update(ref, { purchaseBatches: batches, quantity: total, updatedAt: Date.now() }); return { purchaseBatches: batches, quantity: total };
        }); });
    }

    async function restoreBatches(itemId, allocations) {
        var ref = db.collection('items').doc(itemId);
        return db.runTransaction(function (tx) { return tx.get(ref).then(function (doc) {
            if (!doc.exists) throw new Error('المنتج غير موجود');
            var data = doc.data(), batches = Array.isArray(data.purchaseBatches) ? data.purchaseBatches.filter(function (batch) { return batch && typeof batch === 'object'; }).slice() : [];
            var safeAllocations = sanitizeBatchAllocations(allocations);
            safeAllocations.forEach(function (allocation) {
                var remaining = Number(allocation.quantity) || 0;
                if (remaining <= 0) return;
                var found = batches.find(function (batch) { return allocation.timestamp != null && batch.timestamp === allocation.timestamp; });
                if (found) found.quantity = (Number(found.quantity) || 0) + remaining;
                else batches.push({ quantity: remaining, unitCost: allocation.unitCost || 0, supplier: allocation.supplier || '', note: allocation.note || '', timestamp: allocation.timestamp || Date.now() });
            });
            var total = batches.reduce(function (sum, batch) { return sum + (Number(batch.quantity) || 0); }, 0);
            tx.update(ref, { purchaseBatches: batches, quantity: total, updatedAt: Date.now() }); return { purchaseBatches: batches, quantity: total };
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
                var saleUnitPrimary = primary(displayedPrice);
                var saleTotalPrimary = primary(Number($('salePrice').value) || 0);
                var saleDisplayTotal = Number($('salePrice').value) || 0;
                var sale = { itemId: selectedItem.id, itemName: selectedItem.name, quantity: qty, unitPrice: saleUnitPrimary, totalAmount: saleTotalPrimary, displayTotalAmount: saleDisplayTotal, rawTotalAmount: saleDisplayTotal, profit: (saleUnitPrimary - cost) * qty, purchasePriceAtTime: cost, timestamp: Date.now(), sellerEmail: currentSeller.email, sellerName: currentSeller.name, user: currentSeller.email, saleCurrency: 'secondary', source: SOURCE, priceType: warning.type, priceWarningLevel: warning.level, priceWarningPercent: warning.percent, priceWarningDirection: warning.direction, priceWarningReference: warning.reference, paymentMethod: paymentMethod };
                if (paymentMethod === 'credit') {
                    var selectedCreditCustomer = debtCustomers.find(function (customer) { return String(customer.id) === String(creditCustomerId); });
                    sale.customerId = selectedCreditCustomer ? selectedCreditCustomer.id : creditCustomerId;
                    sale.customerName = selectedCreditCustomer ? selectedCreditCustomer.name : '';
                    sale.isCreditSale = true;
                }
                sale.saleId = makeMobileSaleId();
                if (allocations) sale.purchaseBatchAllocations = allocations;
                try {
                    await db.collection('sales').doc(sale.saleId).set(sanitizeFirestoreData(sale));
                    if (paymentMethod === 'credit') {
                        var debtOwner = getCurrentUserOwnership();
                        var debtEntry = {
                            id: 'debt_op_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
                            customerId: sale.customerId,
                            customerName: sale.customerName,
                            type: 'debt',
                            amount: Number(sale.displayTotalAmount || sale.rawTotalAmount || sale.totalAmount || sale.amount || 0) || 0,
                            note: sale.itemName || 'منتج',
                            dateKey: new Date(sale.timestamp).toISOString().slice(0, 10),
                            timestamp: sale.timestamp,
                            source: SOURCE,
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
                        try {
                            await db.collection('sales').doc(sale.saleId).set({ debtOperationId: debtEntry.id, linkedDebtOperationId: debtEntry.id, relatedDebtOperationId: debtEntry.id, saleDebtOperationId: debtEntry.id }, { merge: true });
                            await db.collection('debtOperations').doc(debtEntry.id).set(sanitizeFirestoreData(debtEntry));
                            upsertDebtOperationLocally(debtEntry);
                        } catch (offlineDebtError) {
                            queueDebtOperation({ kind: 'operation', payload: debtEntry, operationId: debtEntry.id });
                            upsertDebtOperationLocally(debtEntry);
                            console.warn('Credit sale debt queue created', offlineDebtError);
                        }
                    }
                    await updateStats(sale.profit);
                    await logMobileActivity('sell', sale);
                    selectedItem.quantity = stockResult.quantity; selectedItem.purchaseBatches = stockResult.purchaseBatches || selectedItem.purchaseBatches;
                    upsertSaleLocally(sale); saveCache(); notify(paymentMethod === 'credit' ? 'تم تسجيل البيع الآجل بنجاح' : 'تم تسجيل البيع بنجاح');
                } catch (offlineCreateError) {
                    if (navigator.onLine || !offlineSyncEnabled) {
                        throw offlineCreateError;
                    }
                    sale.pending = 'pending'; sale.syncStatus = 'pending';
                    queueMobileSaleOperation('create', sale);
                    upsertSaleLocally(sale); saveCache(); notify('تم حفظ البيع محليًا وسيتم مزامنته عند عودة الإنترنت');
                    console.warn('Mobile sales offline create queued', offlineCreateError);
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
                var newPrice = primary(displayedPrice), newProfit = (newPrice - (Number(editingSale.purchasePriceAtTime) || 0)) * qty, profitDiff = newProfit - (Number(editingSale.profit) || 0);
                var updatedTotalPrimary = primary(Number($('salePrice').value) || 0);
                var updatedDisplayTotal = Number($('salePrice').value) || 0;
                var seller = getCurrentSellerInfo();
                var updated = Object.assign({}, editingSale, { quantity: qty, unitPrice: newPrice, totalAmount: updatedTotalPrimary, displayTotalAmount: updatedDisplayTotal, rawTotalAmount: updatedDisplayTotal, profit: newProfit, sellerEmail: editingSale.sellerEmail || seller.email, sellerName: editingSale.sellerName || seller.name, user: editingSale.user || seller.email, saleCurrency: 'secondary', purchaseBatchAllocations: allocations, updatedAt: Date.now(), source: SOURCE, priceType: warning.type, priceWarningLevel: warning.level, priceWarningPercent: warning.percent, priceWarningDirection: warning.direction, priceWarningReference: warning.reference, paymentMethod: paymentMethod });
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
                                queueDebtOperation({ kind: 'operation', payload: debtRecordUpdate, operationId: linkedDebtRecord.id });
                                console.warn('Credit sale debt update queued', debtSyncError);
                            }
                        }
                    }
                }
                try {
                    await db.collection('sales').doc(editingSale.saleId).set(sanitizeFirestoreData(updated));
                    await updateStats(profitDiff); await logMobileActivity('update', updated);
                    upsertSaleLocally(updated);
                    await syncSalesFromFirestore();
                    await loadDebtData();
                    renderDebtList();
                    notify('تم تعديل البيع');
                } catch (offlineUpdateError) {
                    if (navigator.onLine || !offlineSyncEnabled) {
                        throw offlineUpdateError;
                    }
                    updated.pending = 'pending'; updated.syncStatus = 'pending';
                    queueMobileSaleOperation('update', updated);
                    sales = sales.map(function (entry) { return entry.saleId === updated.saleId ? updated : entry; }); saveCache(); notify('تم حفظ التعديل محليًا وسيتم مزامنته عند عودة الإنترنت');
                    console.warn('Mobile sales offline update queued', offlineUpdateError);
                }
            }
            closeModal('saleModal'); renderProducts(); renderHistory();
        } catch (error) { showError('saleError', error.message || 'تعذر حفظ العملية'); }
        if (button) button.disabled = false;
    }

    async function updateStats(delta) { if (delta) await db.collection('stats').doc('totals').set({ allTimeProfit: firebase.firestore.FieldValue.increment(delta), updatedAt: Date.now() }, { merge: true }); }
    async function logMobileActivity(action, sale) {
        var sellerInfo = getCurrentSellerInfo();
        var saleRecord = sale || {};
        var email = (saleRecord.user || saleRecord.sellerEmail || sellerInfo.email || (auth && auth.currentUser && auth.currentUser.email) || 'unknown');
        var qty = Number(saleRecord.quantity) || 0;
        var itemName = saleRecord.itemName || saleRecord.name || 'منتج';
        var profitValue = Number(saleRecord.profit) || 0;
        var details = '';
        if (action === 'sell') {
            details = 'بيع منتج: ' + itemName + '، الكمية: ' + qty + '، الربح: ' + (profitValue || 0);
        } else if (action === 'cancel') {
            details = 'إلغاء بيع: ' + itemName + '، الكمية: ' + qty + '، الربح: ' + (profitValue || 0);
        } else {
            details = 'تعديل بيع: ' + itemName + '، الكمية الجديدة: ' + qty + '، السعر: ' + (Number(saleRecord.unitPrice) || 0);
        }
        var metadata = {
            saleId: saleRecord.saleId || null,
            itemId: saleRecord.itemId || null,
            itemName: itemName,
            quantity: qty,
            profit: profitValue,
            source: SOURCE
        };
        return db.collection('activityLog').add({
            timestamp: Date.now(),
            actionType: action === 'sell' ? 'sell' : (action === 'cancel' ? 'cancelSale' : 'update'),
            entity: 'sale',
            entityId: saleRecord.saleId || null,
            details: details,
            user: email,
            sellerEmail: email,
            sellerName: sellerInfo.name || saleRecord.sellerName || '',
            itemId: saleRecord.itemId || null,
            itemName: itemName,
            quantity: qty,
            metadata: metadata,
            source: SOURCE
        });
    }

    async function cancelSale(saleId, forcedMode) {
        var sale = await resolveCurrentSaleRecord(saleId);
        sale = helpers.normalizeSaleForCancellation ? helpers.normalizeSaleForCancellation(sale) : sale;
        if (!sale || sale.source !== SOURCE) return;
        if (forcedMode === 'refund' || forcedMode === 'old-debt') {
            if (forcedMode === 'refund') {
                finalizePaidSaleRefund(saleId).catch(function (error) { notify(error.message || 'تعذر استرداد المبلغ للعميل'); });
            } else {
                finalizePaidSaleOldDebt(saleId).catch(function (error) { notify(error.message || 'تعذر تحويل المبلغ إلى سداد عن ديون قديمة'); });
            }
            return;
        }
        var paymentState = helpers.getSalePaymentProgress ? helpers.getSalePaymentProgress(sale, sales, debtOperations) : { paidAmount: 0, percent: 0, isPaid: false, hasPayment: false };
        if (paymentState && paymentState.paidAmount > 0) {
            openPaidSaleCancelModal(saleId);
            return;
        }
        if (!window.confirm('إلغاء عملية البيع؟')) return;
        if (!sale.itemId) { notify('معرف المنتج غير موجود في سجل البيع'); return; }
        var item = (Array.isArray(items) ? items : []).find(function (entry) { return entry && entry.id === sale.itemId; });
        if (!item) {
            try {
                var itemDoc = await db.collection('items').doc(sale.itemId).get({ source: navigator.onLine ? 'default' : 'cache' });
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
                var reallocationPlan = helpers.reassignPaymentsForCancelledSale ? helpers.reassignPaymentsForCancelledSale(customerId, saleKey, sales, debtOperations) : { reassignedAmount: 0, assignments: [] };
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
                        queueDebtOperation({ kind: 'delete-operation', payload: { id: linkedDebtOperation.id }, operationId: linkedDebtOperation.id });
                        debtOperations = debtOperations.filter(function (entry) { return String(entry.id) !== String(linkedDebtOperation.id); });
                        console.warn('Credit sale debt removal queued', debtDeleteError);
                    }
                }
                if (reallocationPlan.assignments && reallocationPlan.assignments.length) {
                    var reallocationTotal = reallocationPlan.assignments.reduce(function (sum, assignment) { return sum + (Number(assignment.amount) || 0); }, 0);
                    if (reallocationTotal > 0) {
                        var reallocationEntry = {
                            id: 'debt_op_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
                            customerId: customerId,
                            customerName: sale.customerName || '',
                            type: 'payment',
                            amount: reallocationTotal,
                            note: 'إعادة توزيع سداد لبيع ملغى',
                            dateKey: new Date().toISOString().slice(0, 10),
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
                sales = sales.filter(function (entry) { return !entry || entry.saleId !== saleId; }); saveCache();
                renderProducts(); renderHistory(); renderDebtList(); notify('تم إلغاء البيع وإعادة تخصيص السداد للديون المتبقية');
            } catch (syncCancelError) {
                if (navigator.onLine || !offlineSyncEnabled) {
                    throw syncCancelError;
                }
                sale.pending = 'pending'; sale.syncStatus = 'pending';
                queueMobileSaleOperation('delete', sale);
                if (linkedDebtOperation && ((helpers.isOriginalCreditSale ? helpers.isOriginalCreditSale(sale) : (sale.paymentMethod === 'credit' || sale.isCreditSale)) || (sale.customerId && sale.paymentMethod === 'credit'))) {
                    queueDebtOperation({ kind: 'delete-operation', payload: { id: linkedDebtOperation.id }, operationId: linkedDebtOperation.id });
                    debtOperations = debtOperations.map(function (entry) { return String(entry.id) === String(linkedDebtOperation.id) ? Object.assign({}, entry, { status: 'cancelled', cancelledSaleId: saleKey, cancelledAt: Date.now() }) : entry; });
                }
                sales = sales.filter(function (entry) { return !entry || entry.saleId !== saleId; }); saveCache();
                renderProducts(); renderHistory(); renderDebtList(); notify('تم حفظ إلغاء البيع محليًا وسيتم مزامنته عند عودة الإنترنت');
                console.warn('Mobile sales cancel queued', syncCancelError);
            }
        } catch (error) { notify(error.message || 'تعذر إلغاء البيع'); }
    }

    async function loadData() {
        if (dataLoaded) return;
        dataLoaded = true;
        var savedCurrency = null;
        try {
            savedCurrency = JSON.parse(localStorage.getItem('xmetalMobileSalesCurrency') || 'null');
        } catch (error) {
            savedCurrency = null;
        }
        if (savedCurrency) applyCurrencySettings(savedCurrency);
        await refreshCurrencySettings();
        var hasCache = restoreCache();
        if (hasCache) { renderProducts(); renderHistory(); }
        if (offlineSyncEnabled) {
            try { flushPendingSalesQueue(); flushPendingDebtQueue(); } catch (error) { console.warn('Pending mobile sales flush setup failed', error); }
        }
        try { loadDebtData(); } catch (error) { console.warn('Unable to hydrate debt customers', error); }
        startLiveListeners();
        if (hasCache) return;
        try {
            var cacheRead = Promise.all([
                db.collection('items').get({ source: 'cache' }),
                db.collection('sales').where('source', '==', SOURCE).get({ source: 'cache' }),
                db.collection('currencySettings').doc('settings').get({ source: 'cache' })
            ]).then(function (result) {
                items = result[0].docs.map(function (doc) { return Object.assign({ id: doc.id }, doc.data()); });
                sales = result[1].docs.map(function (doc) { return Object.assign({ saleId: doc.id }, doc.data()); });
                if (result[2].exists) currency = Object.assign(currency, result[2].data());
                renderProducts(); renderHistory(); saveCache();
            });
            await Promise.race([cacheRead, new Promise(function (resolve) { setTimeout(resolve, 1200); })]);
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
            if (changed) { items = nextItems; renderProducts(); saveCache(); }
            lastSyncAt = Date.now();
        });
        db.collection('sales').where('source', '==', SOURCE).onSnapshot(function (snap) {
            var nextSales = snap.docs.map(function (doc) { return Object.assign({ saleId: doc.id }, doc.data()); });
            nextSales = uniqueSales(nextSales);
            var mergedSales = helpers.uniqueRecordsById ? helpers.uniqueRecordsById(sales.concat(nextSales), ['saleId', 'id']) : uniqueSales(sales.concat(nextSales));
            if (JSON.stringify(mergedSales) !== JSON.stringify(uniqueSales(sales))) { sales = mergedSales; renderHistory(); renderDebtList(); saveCache(); }
            lastSyncAt = Date.now();
        });
        db.collection('debtOperations').onSnapshot(function (snap) {
            var nextDebtOperations = snap.docs.map(function (doc) { return Object.assign({ id: doc.id }, doc.data()); });
            nextDebtOperations = nextDebtOperations.filter(function (entry) { return entry && (entry.type === 'debt' || entry.type === 'payment' || entry.type === 'settle' || entry.type === 'cancel'); });
            nextDebtOperations = helpers.uniqueRecordsById ? helpers.uniqueRecordsById(nextDebtOperations, ['id', 'debtOperationId', 'operationId']) : nextDebtOperations;
            var mergedDebtOperations = helpers.uniqueRecordsById ? helpers.uniqueRecordsById(debtOperations.concat(nextDebtOperations), ['id', 'debtOperationId', 'operationId']) : debtOperations.concat(nextDebtOperations);
            if (JSON.stringify(mergedDebtOperations) !== JSON.stringify(debtOperations)) {
                debtOperations = mergedDebtOperations.sort(function (a, b) { return timestampValue(b.timestamp) - timestampValue(a.timestamp); });
                renderDebtList();
            }
            lastSyncAt = Date.now();
        });
        db.collection('currencySettings').doc('settings').onSnapshot(function (doc) {
            if (doc.exists) {
                var nextCurrency = normalizeCurrencySettings(doc.data());
                if (JSON.stringify(nextCurrency) !== JSON.stringify(currency)) {
                    currency = nextCurrency;
                    try { localStorage.setItem('xmetalMobileSalesCurrency', JSON.stringify(currency)); } catch (error) {}
                    renderProducts(); renderHistory(); renderDebtList(); saveCache();
                }
            }
            lastSyncAt = Date.now();
        });
    }

    $('loginForm').addEventListener('submit', function (event) { event.preventDefault(); showError('loginError', ''); auth.signInWithEmailAndPassword($('email').value.trim(), $('password').value).catch(function () { showError('loginError', 'بيانات الدخول غير صحيحة'); }); });
    $('productSearch').addEventListener('input', function () { renderProducts(); scrollToProductsTop(); });
    $('productTabs').addEventListener('click', function (event) {
        var tab = event.target.closest('[data-product-tab]');
        if (!tab) return;
        productFilterMode = tab.dataset.productTab || 'available';
        localStorage.setItem('xmetalMobileShowEndedProducts', String(showEndedProducts));
        renderProducts();
    });
    $('showEndedProductsToggle').addEventListener('change', function () {
        showEndedProducts = $('showEndedProductsToggle').checked;
        localStorage.setItem('xmetalMobileShowEndedProducts', String(showEndedProducts));
        if (!showEndedProducts) productFilterMode = 'available';
        renderProducts();
    });
    $('logoutButton').addEventListener('click', function () {
        if (auth && typeof auth.signOut === 'function') {
            auth.signOut();
            closeModal('settingsModal');
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
        if (!debtCustomers.length) {
            showError('saleError', 'لا توجد عملاء مسجلين. انتقل إلى قسم الديون لإضافة عميل أولاً.');
            notify('لا توجد عملاء مسجلين. أضف عميلًا من قسم الديون أولاً.');
            return;
        }
        $('saleSelectedCustomerId').value = '';
        openCreditCustomerPicker();
    });
    document.addEventListener('click', function (event) {
        var creditCustomer = event.target.closest('[data-credit-customer-id]');
        if (creditCustomer) {
            $('salePaymentMethod').value = 'credit';
            $('saleSelectedCustomerId').value = creditCustomer.dataset.creditCustomerId;
            closeModal('creditCustomerModal');
            $('saleForm').requestSubmit();
        }
    });
    $('debtsList').addEventListener('click', function (event) {
        var action = event.target.closest('[data-debt-action]');
        if (!action) return;
        openDebtActionModal(action.dataset.debtCustomerId, action.dataset.debtAction);
    });
    $('debtPageList').addEventListener('click', function (event) {
        var row = event.target.closest('[data-debt-customer-id]');
        if (!row) return;
        openDebtCustomerDetail(row.dataset.debtCustomerId);
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
    var paidSaleCancelModal = $('paidSaleCancelModal');
    if (paidSaleCancelModal) {
        paidSaleCancelModal.addEventListener('click', function (event) {
            var button = event.target.closest('[data-paid-cancel-choice]');
            if (!button) return;
            var choice = button.dataset.paidCancelChoice;
            var saleId = paidSaleCancelModal.dataset.pendingSaleId || null;
            if (!saleId) return;
            openPaidSaleCancelOption(saleId, choice);
        });
    }
    $('mainMenu').addEventListener('click', function (event) {
        var actionTarget = event.target.closest('[data-menu-action]');
        if (!actionTarget) return;
        var action = actionTarget.dataset.menuAction;
        $('mainMenu').hidden = true;
        if (action === 'debts') { showDebtPage(); }
        else if (action === 'history') { renderHistory(); openModal('historyModal'); }
        else if (action === 'settings') { $('showEndedProductsToggle').checked = showEndedProducts; openModal('settingsModal'); }
    });
    $('backFromDebtPage').addEventListener('click', function () { showProductsPage(); });
    $('addDebtCustomerButton').addEventListener('click', function () { $('debtCustomerForm').reset(); openModal('debtCustomerModal'); });
    $('historyButton').addEventListener('click', function (event) {
        event.stopPropagation();
        var menu = $('mainMenu');
        menu.hidden = !menu.hidden;
    });
    $('debtMainMenu').addEventListener('click', function (event) {
        var actionTarget = event.target.closest('[data-menu-action]');
        if (!actionTarget) return;
        var action = actionTarget.dataset.menuAction;
        $('debtMainMenu').hidden = true;
        if (action === 'debts') { showDebtPage(); }
        else if (action === 'history') { renderHistory(); openModal('historyModal'); }
        else if (action === 'settings') { $('showEndedProductsToggle').checked = showEndedProducts; openModal('settingsModal'); }
    });
    $('debtHistoryButton').addEventListener('click', function (event) {
        event.stopPropagation();
        var menu = $('debtMainMenu');
        menu.hidden = !menu.hidden;
    });
    $('debtProductSearch').addEventListener('input', function () {
        renderDebtPageList();
    });
    document.addEventListener('click', function (event) {
        if (!event.target.closest('#historyButton') && !event.target.closest('#mainMenu')) {
            var menu = $('mainMenu');
            if (menu) menu.hidden = true;
        }
        if (!event.target.closest('#debtHistoryButton') && !event.target.closest('#debtMainMenu')) {
            var debtMenu = $('debtMainMenu');
            if (debtMenu) debtMenu.hidden = true;
        }
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
        try { localStorage.setItem(CACHE_KEY + ':scrollY', String(window.scrollY)); } catch (error) {}
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
    $('salesHistory').addEventListener('click', function (event) { var edit = event.target.closest('[data-edit-sale]'), cancel = event.target.closest('[data-cancel-sale]'), warningButton = event.target.closest('[data-warning-sale]'); if (edit) { var sale = sales.find(function (entry) { return entry.saleId === edit.dataset.editSale; }); if (sale) { closeModal('historyModal'); openEditSale(sale); } } if (cancel) cancelSale(cancel.dataset.cancelSale); if (warningButton) { var warningSale = sales.find(function (entry) { return entry.saleId === warningButton.dataset.warningSale; }); if (warningSale) window.alert('سبب التنبيه: سعر القطعة المحسوب ' + (warningSale.priceWarningDirection || '') + ' من ' + (warningSale.priceType === 'mechanic' ? 'سعر الجملة' : 'سعر البيع الأساسي') + ' بنسبة ' + money(warningSale.priceWarningPercent || 0) + '%.'); } });
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

        if (currentUser) {
            $('loginScreen').hidden = true;
            $('appShell').hidden = false;
            await refreshUserDisplayNameMap();
            await loadData();
            try { await loadDebtData(); } catch (error) { console.warn('Debt data load failed', error); }
            try { await flushPendingDebtQueue(); } catch (error) { console.warn('Pending debt flush failed', error); }
        } else if (authStateObserved || authStateResolved) {
            $('loginScreen').hidden = false;
            $('appShell').hidden = true;
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

    window.addEventListener('online', function () {
        try { flushPendingSalesQueue(); } catch (error) { console.warn('Retry mobile-sales flush failed', error); }
        try { flushPendingDebtQueue(); } catch (error) { console.warn('Retry debt flush failed', error); }
    });
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
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('mobile-sales-sw.js').catch(function () {});
}());
