(function () {
    const firebaseConfig = {
        apiKey: "AIzaSyA02oo3j3IgHRceFVoArcPB6bcRTOI4tw4",
        authDomain: "x-metal-finance.firebaseapp.com",
        projectId: "x-metal-finance",
        storageBucket: "x-metal-finance.firebasestorage.app",
        messagingSenderId: "895302522066",
        appId: "1:895302522066:web:858357b0d671a3f489490b"
    };

    const firebaseApp = firebase.apps && firebase.apps.length ? firebase.apps[0] : firebase.initializeApp(firebaseConfig);
    const db = firebase.firestore(firebaseApp);
    const WORKER_ID = 'main-worker';
    const DEFAULT_SETTINGS = {
        workerName: 'اسم العامل',
        payType: 'daily',
        payValue: 0,
        startDate: toISODate(new Date()),
        currencyName: 'دولار',
        currencySymbol: '$',
        weekStartDay: 'saturday'
    };

    const state = {
        settings: Object.assign({}, DEFAULT_SETTINGS),
        periodMode: 'month',
        anchorDate: new Date(),
        dayStatusMap: new Map(),
        advanceMap: new Map(),
        pieceMap: new Map(),
        paymentMap: new Map(),
        activityList: [],
        historyVisibleWeeks: 1
    };

    const $ = function (id) { return document.getElementById(id); };

    function showToast(message) {
        const toast = $('toast');
        if (!toast) return;
        toast.textContent = message;
        toast.classList.add('show');
        clearTimeout(showToast.timeoutId);
        showToast.timeoutId = setTimeout(function () { toast.classList.remove('show'); }, 2200);
    }

    function openModal(id) {
        const modal = $(id);
        if (!modal) return;
        modal.hidden = false;
    }

    function closeModal(id) {
        const modal = $(id);
        if (!modal) return;
        modal.hidden = true;
    }

    function toISODate(date) {
        const local = new Date(date);
        const offset = local.getTimezoneOffset() * 60000;
        return new Date(local.getTime() - offset).toISOString().slice(0, 10);
    }

    function parseDateKey(value) {
        if (!value) return null;
        const d = new Date(value + 'T00:00:00');
        return Number.isNaN(d.getTime()) ? null : toISODate(d);
    }

    function formatDateLabel(dateValue) {
        const date = new Date(dateValue + 'T00:00:00');
        if (Number.isNaN(date.getTime())) return '—';
        return new Intl.DateTimeFormat('ar-EG', { day: 'numeric', month: 'numeric', year: 'numeric' }).format(date);
    }

    function formatMoney(value) {
        const amount = Number(value) || 0;
        const symbol = (state.settings && state.settings.currencySymbol ? state.settings.currencySymbol : '$').trim() || '$';
        return new Intl.NumberFormat('ar-EG', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(amount) + ' ' + symbol;
    }

    function getWeekStart(dateValue, startDayName) {
        const date = new Date(dateValue);
        date.setHours(0, 0, 0, 0);
        const map = { saturday: 6, sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5 };
        const target = map[String(startDayName || 'saturday')] ?? 6;
        const current = date.getDay();
        const diff = (current - target + 7) % 7;
        const start = new Date(date);
        start.setDate(date.getDate() - diff);
        return start;
    }

    function solidDate(dateValue) {
        const d = new Date(dateValue + 'T00:00:00');
        return d;
    }

    function getPeriodDates(anchorDate, mode) {
        const date = new Date(anchorDate);
        let days = [];

        if (mode === 'week' || mode === 'prev-week') {
            const start = new Date(date);
            const day = start.getDay();
            const diff = (day === 0 ? -6 : 1 - day);
            start.setDate(start.getDate() + diff);
            for (let i = 0; i < 7; i += 1) {
                const d = new Date(start);
                d.setDate(start.getDate() + i);
                days.push(d);
            }
            return days;
        }

        const year = date.getFullYear();
        const month = date.getMonth();
        const monthDays = new Date(year, month + 1, 0).getDate();
        for (let dayNumber = 1; dayNumber <= monthDays; dayNumber += 1) {
            const d = new Date(year, month, dayNumber);
            days.push(d);
        }
        return days;
    }

    function getWeekAgo(anchorDate) {
        const d = new Date(anchorDate);
        d.setDate(d.getDate() - 7);
        return d;
    }

    function getMonthAgo(anchorDate) {
        const d = new Date(anchorDate);
        d.setMonth(d.getMonth() - 1);
        return d;
    }

    function setPeriodStates() {
        const toolButtons = document.querySelectorAll('[data-period]');
        toolButtons.forEach(function (button) {
            const selected = button.dataset.period === state.periodMode;
            button.classList.toggle('active', selected);
            button.disabled = false;
        });

        const monthPicker = $('monthPicker');
        if (monthPicker) {
            monthPicker.value = toISODate(new Date(state.anchorDate.getFullYear(), state.anchorDate.getMonth(), 1)).slice(0, 7);
        }
    }

    function getStartDateKey() {
        const startDate = state.settings && state.settings.startDate ? parseDateKey(state.settings.startDate) : toISODate(new Date());
        return startDate || toISODate(new Date());
    }

    function isDateWithinWorkerWindow(dateKey) {
        const start = getStartDateKey();
        const today = toISODate(new Date());
        if (!dateKey) return false;
        if (dateKey < start) return false;
        if (dateKey > today) return false;
        return true;
    }

    function getStatusForDate(dateKey) {
        if (!dateKey || !isDateWithinWorkerWindow(dateKey)) return 'unrecorded';
        const entry = state.dayStatusMap.get(dateKey);
        if (!entry || !entry.status) return 'unrecorded';
        return entry.status;
    }

    function buildWeekDates(anchorDate, startDayName) {
        const start = getWeekStart(anchorDate, startDayName || 'saturday');
        const days = [];
        for (let i = 0; i < 7; i += 1) {
            const item = new Date(start);
            item.setDate(start.getDate() + i);
            days.push(item);
        }
        return days;
    }

    function getCurrentPeriodDates() {
        let baseDates = [];

        if (state.periodMode === 'prev-week') {
            baseDates = buildWeekDates(getWeekAgo(state.anchorDate), state.settings.weekStartDay || 'saturday');
        } else if (state.periodMode === 'prev-month') {
            baseDates = getPeriodDates(getMonthAgo(state.anchorDate), 'month');
        } else if (state.periodMode === 'week') {
            baseDates = buildWeekDates(state.anchorDate, state.settings.weekStartDay || 'saturday');
        } else {
            baseDates = getPeriodDates(state.anchorDate, state.periodMode);
        }

        const today = toISODate(new Date());
        return baseDates.filter(function (dateObj) {
            const key = toISODate(dateObj);
            return key <= today;
        });
    }

    function getHistoryVisibleWeeksCount() {
        const currentWeekStart = getWeekStart(new Date(), state.settings.weekStartDay || 'saturday');
        let cursor = new Date(currentWeekStart);
        let count = 0;

        while (count < 12) {
            count += 1;
            cursor = new Date(cursor);
            cursor.setDate(cursor.getDate() - 7);
            if (cursor.getTime() < new Date('2000-01-01').getTime()) break;
        }

        return Math.max(1, count);
    }

    function getSelectedRangeText() {
        const dates = getCurrentPeriodDates();
        if (!dates.length) return '';
        const start = dates[0];
        const end = dates[dates.length - 1];
        const formatter = new Intl.DateTimeFormat('ar-EG', { day: 'numeric', month: 'numeric', year: 'numeric' });
        return formatter.format(start) + ' - ' + formatter.format(end);
    }

    function getDayRate() {
        const payValue = Number(state.settings.payValue) || 0;
        const relevantDates = getCurrentPeriodDates();
        const relevantMonth = relevantDates.length ? relevantDates[0].getMonth() : new Date().getMonth();
        const relevantYear = relevantDates.length ? relevantDates[0].getFullYear() : new Date().getFullYear();
        const actualMonthDays = new Date(relevantYear, relevantMonth + 1, 0).getDate();

        if (state.settings.payType === 'daily') return payValue;
        if (state.settings.payType === 'weekly') return payValue / 7;
        if (state.settings.payType === 'monthly') return payValue / Math.max(actualMonthDays, 1);
        return 0;
    }

    function getSelectedSummary() {
        const periodDates = getCurrentPeriodDates();
        const dayRate = getDayRate();
        let workDays = 0;
        let offDays = 0;
        let unrecordedDays = 0;

        periodDates.forEach(function (dateObj) {
            const key = toISODate(dateObj);
            const status = getStatusForDate(key);
            if (status === 'work') workDays += 1;
            else if (status === 'off') offDays += 1;
            else unrecordedDays += 1;
        });

        const advances = getRecordsTotal(state.advanceMap);
        const pieces = getRecordsTotal(state.pieceMap);
        const payments = getRecordsTotal(state.paymentMap);
        const due = workDays * dayRate;
        const remaining = due - advances - pieces - payments;

        return {
            periodDates,
            dayRate,
            workDays,
            offDays,
            unrecordedDays,
            due,
            advances,
            pieces,
            payments,
            remaining
        };
    }

    function getRecordsTotal(map) {
        let total = 0;
        map.forEach(function (record) {
            total += Number(record.amount) || 0;
        });
        return total;
    }

    function calcBalanceText(value) {
        if (value > 0) return 'للعامل: ' + formatMoney(value);
        if (value === 0) return 'الحساب مسدد';
        return 'على العامل: ' + formatMoney(Math.abs(value));
    }

    function renderSummaryCards() {
        const summary = getSelectedSummary();
        const cards = [
            { label: 'أجر الفترة المستحق', value: formatMoney(summary.due), tone: 'positive' },
            { label: 'أيام الدوام', value: String(summary.workDays), tone: 'neutral' },
            { label: 'أيام العطل', value: String(summary.offDays), tone: 'negative' },
            { label: 'لم يسجل', value: String(summary.unrecordedDays), tone: 'warning' },
            { label: 'إجمالي السلف', value: formatMoney(summary.advances), tone: 'negative' },
            { label: 'قيمة القطع', value: formatMoney(summary.pieces), tone: 'negative' },
            { label: 'المبلغ المدفوع', value: formatMoney(summary.payments), tone: 'warning' },
            { label: 'المتبقي للعامل', value: calcBalanceText(summary.remaining), tone: summary.remaining > 0 ? 'positive' : summary.remaining < 0 ? 'negative' : 'neutral' }
        ];

        const grid = $('summaryGrid');
        if (!grid) return;
        grid.innerHTML = cards.map(function (card) {
            return '<article class="summary-card"><span class="label">' + card.label + '</span><span class="value ' + card.tone + '">' + card.value + '</span></article>';
        }).join('');
    }

    function renderTodayStatus() {
        const todayKey = toISODate(new Date());
        const label = $('todayStatusLabel');
        if (!label) return;

        const status = getStatusForDate(todayKey);
        const displayText = status === 'work' ? '🟢 داوم' : status === 'off' ? '🔴 عطلة' : 'لم يسجل';
        label.textContent = displayText;
        label.classList.toggle('work', status === 'work');
        label.classList.toggle('off', status === 'off');
    }

    function renderCalendar() {
        const grid = $('calendarGrid');
        const periodDates = getCurrentPeriodDates();
        if (!grid) return;

        const rangeLabel = $('periodRangeLabel');
        if (rangeLabel) rangeLabel.textContent = getSelectedRangeText();

        const weekdayNames = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
        const cells = [];

        if (periodDates.length) {
            const firstDate = periodDates[0];
            const offset = firstDate.getDay();
            for (let i = 0; i < offset; i += 1) {
                cells.push('<div class="day-cell empty" aria-hidden="true"></div>');
            }
        }

        periodDates.forEach(function (dateObj) {
            const key = toISODate(dateObj);
            const status = getStatusForDate(key);
            const classes = ['day-cell'];
            if (status === 'off') classes.push('off');
            else if (status === 'work') classes.push('work');
            else classes.push('unrecorded');

            const dayName = weekdayNames[dateObj.getDay()];
            const badgeText = status === 'off' ? 'عطلة' : status === 'work' ? 'دوام' : 'لم يسجل';
            const title = dateObj.getDate() + ' ' + dayName + ' - ' + badgeText;
            cells.push('<div class="' + classes.join(' ') + '" aria-label="' + title + '"><span class="day-name">' + dayName + '</span><span class="day-number">' + dateObj.getDate() + '</span><span class="day-status-badge">' + badgeText + '</span></div>');
        });

        grid.innerHTML = cells.join('');
    }

    function openDayStatusModal(dateKey) {
        if (!isDateWithinWorkerWindow(dateKey)) {
            showToast('لا يمكن تعديل يوم خارج فترة العمل');
            return;
        }
        const modal = $('dayStatusModal');
        const label = $('dayStatusDateLabel');
        if (!modal || !label) return;
        modal.dataset.dateKey = dateKey;
        label.textContent = formatDateLabel(dateKey);
        modal.hidden = false;
    }

    async function setDayStatus(dateKey, status) {
        if (!isDateWithinWorkerWindow(dateKey)) {
            showToast('لا يمكن تعديل يوم خارج فترة العمل');
            return;
        }

        const normalized = status === 'off' ? 'off' : 'work';
        const since = Date.now();
        const record = {
            status: normalized,
            dateKey: dateKey,
            workerId: WORKER_ID,
            updatedAt: since,
            changedBy: 'mobile-worker'
        };

        const ref = db.collection('workerDays').doc(WORKER_ID).collection('records').doc(dateKey);
        await ref.set(record, { merge: true });

        state.dayStatusMap.set(dateKey, record);

        if (normalized === 'work') {
            await addActivityRecord({
                type: 'work',
                title: 'دوام',
                details: 'تسجيل يوم دوام',
                amount: getDayRate(),
                effect: 'إضافة أجر اليوم',
                dateKey: dateKey,
                createdAt: since
            });
        } else {
            await addActivityRecord({
                type: 'off',
                title: 'عطلة',
                details: 'تسجيل عطلة',
                amount: 0,
                effect: 'لا يوجد أجر',
                dateKey: dateKey,
                createdAt: since
            });
        }

        renderCalendar();
        renderSummaryCards();
        renderActivityList();
        renderTodayStatus();
        closeModal('dayStatusModal');
        showToast(normalized === 'work' ? 'تم تسجيل دوام اليوم' : 'تم تسجيل عطلة اليوم');
    }

    async function addActivityRecord(activity) {
        const record = Object.assign({
            id: 'act_' + Date.now() + '_' + Math.random().toString(16).slice(2, 10),
            workerId: WORKER_ID,
            createdAt: Date.now(),
            amount: 0,
            effect: '',
            title: '',
            type: 'general',
            details: '',
            dateKey: toISODate(new Date())
        }, activity);

        await db.collection('workerLogs').doc(WORKER_ID).collection('records').doc(record.id).set(record, { merge: true });
        state.activityList = [record].concat(state.activityList.filter(function (item) { return item.id !== record.id; }));
    }

    async function loadSettings() {
        const doc = await db.collection('workerProfiles').doc(WORKER_ID).get();
        if (doc.exists) {
            state.settings = Object.assign({}, DEFAULT_SETTINGS, doc.data());
        } else {
            await db.collection('workerProfiles').doc(WORKER_ID).set(Object.assign({ workerId: WORKER_ID }, state.settings), { merge: true });
        }

        syncSettingsForm();
    }

    function syncSettingsForm() {
        $('workerNameInput').value = state.settings.workerName || '';
        $('payTypeInput').value = state.settings.payType || 'daily';
        $('payValueInput').value = Number(state.settings.payValue) || 0;
        $('startDateInput').value = state.settings.startDate || toISODate(new Date());
        $('currencyNameInput').value = state.settings.currencyName || 'دولار';
        $('currencySymbolInput').value = state.settings.currencySymbol || '$';
        $('weekStartDayInput').value = state.settings.weekStartDay || 'saturday';
    }

    async function loadDayStatusMap() {
        const snapshot = await db.collection('workerDays').doc(WORKER_ID).collection('records').get();
        state.dayStatusMap = new Map();
        snapshot.forEach(function (doc) {
            const data = doc.data();
            if (data && data.dateKey) state.dayStatusMap.set(data.dateKey, data);
        });
    }

    async function loadMovementData() {
        const [advances, pieces, payments, activity] = await Promise.all([
            db.collection('workerAdvances').doc(WORKER_ID).collection('records').get(),
            db.collection('workerPieces').doc(WORKER_ID).collection('records').get(),
            db.collection('workerPayments').doc(WORKER_ID).collection('records').get(),
            db.collection('workerLogs').doc(WORKER_ID).collection('records').orderBy('createdAt', 'desc').limit(120).get()
        ]);

        state.advanceMap = new Map();
        advances.forEach(function (doc) { const data = doc.data(); if (data) state.advanceMap.set(doc.id, data); });

        state.pieceMap = new Map();
        pieces.forEach(function (doc) { const data = doc.data(); if (data) state.pieceMap.set(doc.id, data); });

        state.paymentMap = new Map();
        payments.forEach(function (doc) { const data = doc.data(); if (data) state.paymentMap.set(doc.id, data); });

        state.activityList = [];
        activity.forEach(function (doc) { const data = doc.data(); if (data) state.activityList.push(data); });
    }

    function renderActivityList() {
        const list = $('activityList');
        if (!list) return;

        if (!state.activityList.length) {
            list.innerHTML = '<div class="empty-state">لا توجد حركات مسجلة في هذه الفترة.</div>';
            return;
        }

        list.innerHTML = state.activityList.map(function (item) {
            const amount = Number(item.amount) || 0;
            const typeClass = item.type || 'general';
            const dateText = item.dateKey ? formatDateLabel(item.dateKey) : formatDateLabel(toISODate(new Date(item.createdAt)));
            const amountText = amount > 0 ? '-' + formatMoney(amount) : formatMoney(amount);
            return '<article class="activity-item"><div class="activity-item-head"><span class="activity-type ' + typeClass + '">' + (item.title || 'حركة') + '</span><span class="activity-amount">' + amountText + '</span></div><div class="details">' + (item.details || '') + '</div><div class="meta">' + dateText + ' • ' + (item.effect || 'غير محدد') + '</div></article>';
        }).join('');
    }

    async function saveAdvance(event) {
        event.preventDefault();
        const form = event.currentTarget;
        const amount = Number($('advanceAmount').value) || 0;
        const dateKey = parseDateKey($('advanceDate').value) || toISODate(new Date());
        const note = $('advanceNote').value.trim();
        if (amount <= 0) return showToast('أدخل مبلغًا صحيحًا');

        const record = {
            id: 'advance_' + Date.now() + '_' + Math.random().toString(16).slice(2, 10),
            workerId: WORKER_ID,
            amount: amount,
            dateKey: dateKey,
            note: note,
            createdAt: Date.now(),
            type: 'advance',
            title: 'سلفة',
            details: note ? 'ملاحظة: ' + note : 'سلفة جديدة',
            effect: 'خصم من المستحق'
        };

        await db.collection('workerAdvances').doc(WORKER_ID).collection('records').doc(record.id).set(record, { merge: true });
        await addActivityRecord(record);
        form.reset();
        closeModal('advanceModal');
        await loadMovementData();
        renderSummaryCards();
        renderActivityList();
        showToast('تم حفظ السلفة');
    }

    async function savePiece(event) {
        event.preventDefault();
        const name = $('pieceName').value.trim();
        const price = Number($('piecePrice').value) || 0;
        const quantity = Number($('pieceQuantity').value) || 0;
        const dateKey = parseDateKey($('pieceDate').value) || toISODate(new Date());
        const note = $('pieceNote').value.trim();
        if (!name || price <= 0 || quantity <= 0) return showToast('أدخل بيانات القطعة بشكل صحيح');

        const total = price * quantity;
        const record = {
            id: 'piece_' + Date.now() + '_' + Math.random().toString(16).slice(2, 10),
            workerId: WORKER_ID,
            amount: total,
            dateKey: dateKey,
            note: note,
            title: 'قطعة',
            details: name + ' × ' + quantity + ' • ' + formatMoney(price),
            effect: 'خصم من المستحق',
            type: 'piece',
            createdAt: Date.now(),
            itemName: name,
            price: price,
            quantity: quantity
        };

        await db.collection('workerPieces').doc(WORKER_ID).collection('records').doc(record.id).set(record, { merge: true });
        await addActivityRecord(record);
        event.currentTarget.reset();
        closeModal('pieceModal');
        await loadMovementData();
        renderSummaryCards();
        renderActivityList();
        showToast('تم حفظ القطعة');
    }

    async function savePayment(event) {
        event.preventDefault();
        const amount = Number($('paymentAmount').value) || 0;
        const dateKey = parseDateKey($('paymentDate').value) || toISODate(new Date());
        const note = $('paymentNote').value.trim();
        if (amount <= 0) return showToast('أدخل مبلغًا صحيحًا');

        const record = {
            id: 'pay_' + Date.now() + '_' + Math.random().toString(16).slice(2, 10),
            workerId: WORKER_ID,
            amount: amount,
            dateKey: dateKey,
            note: note,
            title: 'دفع أجر',
            details: note ? 'ملاحظة: ' + note : 'دفعة أجر',
            effect: 'خصم من المستحق',
            type: 'payment',
            createdAt: Date.now()
        };

        await db.collection('workerPayments').doc(WORKER_ID).collection('records').doc(record.id).set(record, { merge: true });
        await addActivityRecord(record);
        event.currentTarget.reset();
        closeModal('paymentModal');
        await loadMovementData();
        renderSummaryCards();
        renderActivityList();
        showToast('تم تسجيل الدفع');
    }

    async function handleSettingsSubmit(event) {
        event.preventDefault();
        state.settings.workerName = $('workerNameInput').value.trim() || 'اسم العامل';
        state.settings.payType = $('payTypeInput').value || 'daily';
        state.settings.payValue = Number($('payValueInput').value) || 0;
        state.settings.startDate = $('startDateInput').value || toISODate(new Date());
        state.settings.currencyName = $('currencyNameInput').value.trim() || 'دولار';
        state.settings.currencySymbol = $('currencySymbolInput').value.trim() || '$';
        state.settings.weekStartDay = $('weekStartDayInput').value || 'saturday';

        await db.collection('workerProfiles').doc(WORKER_ID).set({ workerId: WORKER_ID, ...state.settings, updatedAt: Date.now() }, { merge: true });
        renderSummaryCards();
        renderCalendar();
        renderHistoryModal();
        closeModal('settingsModal');
        showToast('تم حفظ إعدادات العامل');
    }

    function getDayTotals(dateKey) {
        const advanceTotal = Array.from(state.advanceMap.values()).filter(function (record) {
            return (record.dateKey || toISODate(new Date(record.createdAt))) === dateKey;
        }).reduce(function (sum, record) { return sum + (Number(record.amount) || 0); }, 0);

        const pieceTotal = Array.from(state.pieceMap.values()).filter(function (record) {
            return (record.dateKey || toISODate(new Date(record.createdAt))) === dateKey;
        }).reduce(function (sum, record) { return sum + (Number(record.amount) || 0); }, 0);

        const paymentTotal = Array.from(state.paymentMap.values()).filter(function (record) {
            return (record.dateKey || toISODate(new Date(record.createdAt))) === dateKey;
        }).reduce(function (sum, record) { return sum + (Number(record.amount) || 0); }, 0);

        const status = getStatusForDate(dateKey);
        const salary = status === 'work' ? getDayRate() : 0;
        return { status, salary, advanceTotal, pieceTotal, paymentTotal, net: salary - advanceTotal - pieceTotal - paymentTotal };
    }

    function getDayRecordEntries(dateKey) {
        const entries = [];
        state.advanceMap.forEach(function (record, id) {
            if ((record.dateKey || toISODate(new Date(record.createdAt))) === dateKey) {
                entries.push({ id: id, type: 'advance', kind: 'سلفة', amount: Number(record.amount) || 0, note: record.note || '', dateKey: dateKey });
            }
        });
        state.pieceMap.forEach(function (record, id) {
            if ((record.dateKey || toISODate(new Date(record.createdAt))) === dateKey) {
                entries.push({ id: id, type: 'piece', kind: 'قطعة', amount: Number(record.amount) || 0, note: record.note || '', dateKey: dateKey });
            }
        });
        state.paymentMap.forEach(function (record, id) {
            if ((record.dateKey || toISODate(new Date(record.createdAt))) === dateKey) {
                entries.push({ id: id, type: 'payment', kind: 'دفع', amount: Number(record.amount) || 0, note: record.note || '', dateKey: dateKey });
            }
        });
        return entries;
    }

    function renderHistoryModal() {
        const list = $('historyList');
        const button = $('loadMoreHistoryButton');
        if (!list) return;

        const firstWorkingDay = getStartDateKey();
        const today = toISODate(new Date());
        const weeks = [];
        let cursor = new Date(today + 'T00:00:00');

        for (let weekIndex = 0; weekIndex < state.historyVisibleWeeks; weekIndex += 1) {
            const weekStart = getWeekStart(cursor, state.settings.weekStartDay || 'saturday');
            const days = [];

            for (let i = 0; i < 7; i += 1) {
                const d = new Date(weekStart);
                d.setDate(weekStart.getDate() + i);
                const key = toISODate(d);
                if (key < firstWorkingDay || key > today) continue;
                days.push({ key, date: d });
            }

            if (days.length) {
                weeks.push({ start: weekStart, days: days });
            }
            cursor.setDate(cursor.getDate() - 7);
        }

        if (!weeks.length) {
            list.innerHTML = '<div class="empty-state">لا توجد بيانات متاحة حتى الآن.</div>';
            if (button) button.hidden = true;
            return;
        }

        const html = weeks.map(function (week) {
            const weekLabel = week.days.length ? formatDateLabel(toISODate(week.days[0].date)) + ' - ' + formatDateLabel(toISODate(week.days[week.days.length - 1].date)) : 'الأسبوع';
            const cards = week.days.map(function (day) {
                const totals = getDayTotals(day.key);
                const status = getStatusForDate(day.key);
                const statusText = status === 'work' ? 'دوام' : status === 'off' ? 'عطلة' : 'لم يسجل';
                const statusClass = status === 'work' ? 'work' : status === 'off' ? 'off' : 'unrecorded';
                const nextStatus = status === 'work' ? 'off' : 'work';
                return '<article class="history-day-card"><div class="history-day-header"><strong>' + formatDateLabel(day.key) + '</strong><button type="button" class="history-day-status ' + statusClass + ' history-action toggle" data-history-toggle-date="' + day.key + '" data-history-next-status="' + nextStatus + '">' + statusText + '</button></div><div class="history-day-grid"><div>أجر اليوم<strong>' + formatMoney(totals.salary) + '</strong></div><div>سلفة<strong>' + formatMoney(totals.advanceTotal) + '</strong></div><div>قطع<strong>' + formatMoney(totals.pieceTotal) + '</strong></div><div>دفع<strong>' + formatMoney(totals.paymentTotal) + '</strong></div></div><div class="history-day-actions"><button type="button" class="history-action edit" data-record-edit-date="' + day.key + '">تعديل سجل</button></div></article>';
            }).join('');
            return '<section class="history-week"><div class="history-week-title">' + weekLabel + '</div>' + cards + '</section>';
        }).join('');

        list.innerHTML = html;
        list.querySelectorAll('[data-history-toggle-date]').forEach(function (button) {
            button.addEventListener('click', async function () {
                const dateKey = button.dataset.historyToggleDate;
                const nextStatus = button.dataset.historyNextStatus || 'work';
                const currentStatus = getStatusForDate(dateKey);
                const confirmMsg = currentStatus === 'work'
                    ? 'هل تريد تحويل هذا اليوم إلى عطلة؟'
                    : currentStatus === 'off'
                        ? 'هل تريد تحويل هذا اليوم إلى دوام؟'
                        : 'هل تريد تسجيل هذا اليوم كدوام؟';
                if (!window.confirm(confirmMsg)) return;
                await setDayStatus(dateKey, nextStatus);
                renderHistoryModal();
            });
        });

        list.querySelectorAll('[data-record-edit-date]').forEach(function (button) {
            button.addEventListener('click', function () {
                openRecordEditor(button.dataset.recordEditDate);
            });
        });
        if (button) button.hidden = false;
    }

    function openHistoryModal() {
        state.historyVisibleWeeks = getHistoryVisibleWeeksCount();
        renderHistoryModal();
        openModal('historyModal');
    }

    function syncRecordEditorFields() {
        const type = $('recordEditType').value;
        const pieceFields = $('recordEditPieceFields');
        const amountWrapper = $('recordEditAmountWrapper');
        const pieceName = $('recordEditItemName');
        const piecePrice = $('recordEditPrice');
        const pieceQuantity = $('recordEditQuantity');
        const amountInput = $('recordEditAmount');

        const isPiece = type === 'piece';
        if (pieceFields) pieceFields.hidden = !isPiece;
        if (amountWrapper) amountWrapper.hidden = isPiece;

        if (isPiece) {
            amountInput.required = false;
            if (pieceName) pieceName.required = true;
            if (piecePrice) piecePrice.required = true;
            if (pieceQuantity) pieceQuantity.required = true;
        } else {
            amountInput.required = true;
            if (pieceName) pieceName.required = false;
            if (piecePrice) piecePrice.required = false;
            if (pieceQuantity) pieceQuantity.required = false;
        }
    }

    function renderRecordEditor(dateKey) {
        const container = $('recordEditorList');
        if (!container) return;

        const entries = getDayRecordEntries(dateKey);
        if (!entries.length) {
            container.innerHTML = '<div class="empty-state">لا توجد سجلات لهذا اليوم.</div>';
            return;
        }

        container.innerHTML = entries.map(function (entry) {
            return '<div class="record-editor-item"><div><strong>' + entry.kind + '</strong><div class="meta">' + formatMoney(entry.amount) + ' • ' + formatDateLabel(dateKey) + '</div></div><button type="button" class="edit-link" data-record-edit-id="' + entry.id + '" data-record-edit-type="' + entry.type + '">تعديل</button></div>';
        }).join('');

        container.querySelectorAll('[data-record-edit-id]').forEach(function (button) {
            button.addEventListener('click', function () {
                const type = button.dataset.recordEditType;
                const recordId = button.dataset.recordEditId;
                let record = null;
                if (type === 'advance') record = state.advanceMap.get(recordId);
                else if (type === 'piece') record = state.pieceMap.get(recordId);
                else if (type === 'payment') record = state.paymentMap.get(recordId);
                if (!record) return;

                $('recordEditRecordId').value = recordId;
                $('recordEditType').value = type;
                syncRecordEditorFields();

                if (type === 'piece') {
                    $('recordEditItemName').value = record.itemName || '';
                    $('recordEditPrice').value = Number(record.price) || 0;
                    $('recordEditQuantity').value = Number(record.quantity) || 1;
                    $('recordEditAmount').value = Number(record.amount) || 0;
                } else {
                    $('recordEditAmount').value = Number(record.amount) || 0;
                }

                $('recordEditDate').value = record.dateKey || toISODate(new Date(record.createdAt));
                $('recordEditNote').value = record.note || '';
            });
        });
    }

    function openRecordEditor(dateKey) {
        renderRecordEditor(dateKey);
        $('recordEditDate').value = dateKey;
        $('recordEditAmount').value = 0;
        $('recordEditNote').value = '';
        $('recordEditRecordId').value = '';
        $('recordEditType').value = 'advance';
        $('recordEditItemName').value = '';
        $('recordEditPrice').value = 0;
        $('recordEditQuantity').value = 1;
        syncRecordEditorFields();
        openModal('recordEditModal');
    }

    async function handleRecordEditSubmit(event) {
        event.preventDefault();

        const recordId = $('recordEditRecordId').value;
        const type = $('recordEditType').value;
        const dateKey = $('recordEditDate').value || toISODate(new Date());
        const note = $('recordEditNote').value.trim();

        if (!recordId || !type) {
            showToast('يرجى اختيار سجل صحيح');
            return;
        }

        const targetMap = type === 'advance' ? state.advanceMap : type === 'piece' ? state.pieceMap : state.paymentMap;
        const source = targetMap.get(recordId);
        if (!source) {
            showToast('هذا السجل غير موجود.');
            return;
        }

        let updated = Object.assign({}, source, {
            dateKey: dateKey,
            note: note,
            updatedAt: Date.now()
        });

        if (type === 'piece') {
            const itemName = $('recordEditItemName').value.trim();
            const price = Number($('recordEditPrice').value) || 0;
            const quantity = Number($('recordEditQuantity').value) || 0;
            if (!itemName || price <= 0 || quantity <= 0) {
                showToast('يرجى إدخال اسم القطعة وسعرها والكمية بشكل صحيح');
                return;
            }
            const amount = price * quantity;
            updated = Object.assign({}, updated, {
                itemName: itemName,
                price: price,
                quantity: quantity,
                amount: amount,
                title: 'قطعة',
                details: itemName + ' × ' + quantity + ' • ' + formatMoney(price),
                effect: 'خصم من المستحق'
            });
        } else {
            const amount = Number($('recordEditAmount').value) || 0;
            if (amount <= 0) {
                showToast('يرجى كتابة مبلغ صحيح');
                return;
            }
            updated = Object.assign({}, updated, {
                amount: amount,
                details: type === 'advance'
                    ? (note ? 'ملاحظة: ' + note : 'سلفة جديدة')
                    : (note ? 'ملاحظة: ' + note : 'دفعة أجر'),
                effect: 'خصم من المستحق'
            });
        }

        const collectionName = type === 'advance' ? 'workerAdvances' : type === 'piece' ? 'workerPieces' : 'workerPayments';
        await db.collection(collectionName).doc(WORKER_ID).collection('records').doc(recordId).set(updated, { merge: true });
        await loadMovementData();
        renderSummaryCards();
        renderHistoryModal();
        closeModal('recordEditModal');
        showToast('تم تعديل السجل بنجاح');
    }

    async function closePeriod() {
        const summary = getSelectedSummary();
        const payload = {
            id: 'period_' + Date.now() + '_' + Math.random().toString(16).slice(2, 10),
            workerId: WORKER_ID,
            periodMode: state.periodMode,
            startDate: toISODate(getCurrentPeriodDates()[0]),
            endDate: toISODate(getCurrentPeriodDates()[getCurrentPeriodDates().length - 1]),
            finalDue: summary.due,
            workDays: summary.workDays,
            offDays: summary.offDays,
            advances: summary.advances,
            pieces: summary.pieces,
            payments: summary.payments,
            remaining: summary.remaining,
            status: 'closed',
            closedAt: Date.now()
        };

        await db.collection('workerPeriods').doc(WORKER_ID).collection('records').doc(payload.id).set(payload, { merge: true });
        showToast('تم إغلاق الفترة بنجاح');
    }

    function bindEvents() {
        document.querySelectorAll('[data-open-modal]').forEach(function (button) {
            button.addEventListener('click', function () {
                openModal(button.dataset.openModal);
            });
        });

        document.querySelectorAll('[data-close-modal]').forEach(function (button) {
            button.addEventListener('click', function () {
                closeModal(button.dataset.closeModal);
            });
        });

        $('openSettingsButton').addEventListener('click', function () {
            syncSettingsForm();
            openModal('settingsModal');
        });

        $('openHistoryButton').addEventListener('click', function () {
            openHistoryModal();
        });

        $('settingsForm').addEventListener('submit', handleSettingsSubmit);
        $('recordEditForm').addEventListener('submit', handleRecordEditSubmit);
        $('recordEditType').addEventListener('change', syncRecordEditorFields);
        $('advanceForm').addEventListener('submit', saveAdvance);
        $('pieceForm').addEventListener('submit', savePiece);
        $('paymentForm').addEventListener('submit', savePayment);
        $('loadMoreHistoryButton').addEventListener('click', function () {
            state.historyVisibleWeeks += 1;
            renderHistoryModal();
        });

        document.querySelectorAll('[data-day-status]').forEach(function (button) {
            button.addEventListener('click', function () {
                const status = button.dataset.dayStatus;
                const dateKey = $('dayStatusModal').dataset.dateKey;
                setDayStatus(dateKey, status);
            });
        });

        document.querySelectorAll('[data-period]').forEach(function (button) {
            button.addEventListener('click', function () {
                const value = button.dataset.period;
                if (value === 'week') {
                    state.periodMode = 'week';
                    state.anchorDate = new Date();
                } else if (value === 'prev-week') {
                    state.periodMode = 'prev-week';
                    state.anchorDate = getWeekAgo(new Date());
                } else if (value === 'month') {
                    state.periodMode = 'month';
                    state.anchorDate = new Date();
                } else if (value === 'prev-month') {
                    state.periodMode = 'prev-month';
                    state.anchorDate = getMonthAgo(new Date());
                }
                renderCalendar();
                renderSummaryCards();
                setPeriodStates();
            });
        });

        $('monthPicker').addEventListener('change', function () {
            if (!this.value) return;
            const parts = this.value.split('-');
            if (parts.length !== 2) return;
            state.anchorDate = new Date(Number(parts[0]), Number(parts[1]) - 1, 1);
            state.periodMode = 'month';
            renderCalendar();
            renderSummaryCards();
            setPeriodStates();
        });

        $('closePeriodButton').addEventListener('click', closePeriod);
    }

    async function init() {
        await loadSettings();
        await loadDayStatusMap();
        await loadMovementData();
        bindEvents();
        renderSummaryCards();
        renderTodayStatus();
        renderCalendar();
        renderActivityList();
        renderHistoryModal();
        setPeriodStates();
    }

    init().catch(function (error) {
        console.error('Worker account initialization failed:', error);
        showToast('تعذر تحميل حساب العامل');
    });
})();
