# 📱 نظام البحث الشامل

**تاريخ الإنشاء:** 31 أغسطس 2026  
**الحالة:** ✅ مفعّل في جميع الأقسام

---

## 🎯 نظرة عامة

نظام البحث يسمح للمستخدم بـ:
1. البحث عن المنتجات بسرعة في قسم المخزون
2. الانتقال تلقائياً لنتائج البحث دون مغادرة القسم الأصلي
3. العودة للقسم السابق عند الحذف أو الإلغاء
4. مسح البحث بسهولة والعودة للقسم الأول

---

## 🔧 المكونات الرئيسية

### 1️⃣ شريط البحث (Search Input)

**الموقع:** [index.html](index.html#L59)

```html
<input type="text" id="searchItemsInput" placeholder="بحث عن منتج..." ...>
```

**الخصائص:**
- `id="searchItemsInput"` - معرف فريد
- `placeholder="بحث عن منتج..."` - نص إرشادي
- يظهر في شريط ثابت في أعلى الصفحة (`sticky-search-bar`)

---

### 2️⃣ متغيرات حالة البحث

**الموقع:** [js/app.js](js/app.js#L364)

```javascript
let currentSection = 'dashboard';      // القسم الحالي
let previousSection = 'dashboard';     // القسم السابق (قبل البحث)
let isSearchActive = false;            // هل البحث نشط الآن؟
```

| المتغير | الغرض | القيمة |
|--------|-------|--------|
| `currentSection` | القسم المعروض الآن | 'inventory', 'dashboard', إلخ |
| `previousSection` | القسم قبل تفعيل البحث | أي قسم كان فعال |
| `isSearchActive` | علم يشير إلى أن البحث نشط | `true` / `false` |

---

## 🔍 آلية البحث

### المرحلة 1️⃣: تفعيل البحث

عندما يكتب المستخدم في شريط البحث:

```javascript
document.getElementById('searchItemsInput').addEventListener('input', function() {
  var searchValue = this.value.trim();
  
  // إذا كُتب شيء، ابدأ البحث
  if (searchValue.length > 0) {
    if (!isSearchActive) {
      previousSection = currentSection;  // ←احفظ القسم السابق
      isSearchActive = true;             // ←فعّل البحث
    }
    currentSection = 'inventory';         // ← عرّض قسم المخزون (نتائج البحث)
  } else {
    // إذا تم حذف البحث، عود للقسم السابق
    isSearchActive = false;
    if (currentSection === 'inventory') {
      currentSection = previousSection;   // ← عود للقسم السابق
    }
  }
  renderCurrentSection();  // ← حدّث الشاشة
});
```

---

### المرحلة 2️⃣: عرض النتائج

دالة `renderInventory()` تقوم بـ:

```javascript
function renderInventory() {
  // اقرأ قيمة البحث من الحقل
  var term = document.getElementById('searchItemsInput') ? 
             document.getElementById('searchItemsInput').value : '';
  
  // اختر المنتجات المطابقة
  var filteredSorted = filterAndSortProducts(term, currentInventoryFilter);
  
  // عرّض النتائج
  // ...
}
```

**ماذا يحدث:**
1. قراءة النص المكتوب في شريط البحث
2. تصفية المنتجات بناءً على البحث
3. ترتيب النتائج حسب الإعدادات
4. عرض النتائج مباشرة

---

### المرحلة 3️⃣: الحذف والعودة

عند حذف منتج من نتائج البحث:

```javascript
async function performDelete(itemId) {
  var item = allItems.find(function(i) { return i.id === itemId; });
  if (!item) return;
  
  // احذف من قاعدة البيانات
  await db.collection('items').doc(itemId).delete();
  
  // إذا كان البحث نشطاً، عود للقسم السابق
  if (isSearchActive) {
    currentSection = previousSection;   // ← عود للقسم السابق
    isSearchActive = false;
    clearSearchInput();                 // ← امسح البحث
    renderCurrentSection();
  } else {
    renderInventory();
  }
}
```

---

## 🎮 تفاعلات المستخدم

### السيناريو 1️⃣: البحث البسيط

```
المستخدم في قسم: المخزون
   ↓
المستخدم يكتب: "دراجة"
   ↓
البحث يتفعل:
  - previousSection = 'inventory'
  - isSearchActive = true
  - currentSection = 'inventory'
   ↓
عرض النتائج التي تحتوي على "دراجة"
```

---

### السيناريو 2️⃣: البحث من قسم آخر

```
المستخدم في قسم: لوحة التحكم (Dashboard)
   ↓
المستخدم يكتب: "قطعة"
   ↓
البحث يتفعل:
  - previousSection = 'dashboard' ← احفظ القسم الأصلي
  - isSearchActive = true
  - currentSection = 'inventory' ← انتقل لعرض النتائج
   ↓
عرض نتائج البحث في قسم المخزون
```

---

### السيناريو 3️⃣: حذف من نتائج البحث

```
المستخدم في: نتائج البحث (isSearchActive = true)
   ↓
المستخدم يضغط: حذف
   ↓
performDelete() يعمل:
  - يحذف المنتج من قاعدة البيانات
  - يكتشف: isSearchActive = true
  - currentSection = previousSection (مثلاً 'dashboard')
  - isSearchActive = false
  - يمسح البحث
   ↓
يعود المستخدم للقسم الأصلي (Dashboard)
```

---

### السيناريو 4️⃣: مسح البحث يدويّاً

```
المستخدم يمسح: نص البحث
   ↓
حدث input يطلق:
  - searchValue.length = 0 (نص فارغ)
  - isSearchActive = false
  - currentSection = previousSection (إذا كان 'inventory')
   ↓
العودة للقسم السابق تلقائياً
```

---

## 📊 مخطط الحالات

```
┌─────────────────────────────────────────┐
│       أي قسم (Dashboard/etc)            │
│      previousSection = هذا القسم       │
└────────────────┬────────────────────────┘
                 │
        المستخدم يكتب في البحث
                 │
                 ↓
┌─────────────────────────────────────────┐
│    isSearchActive = true                │
│    currentSection = 'inventory'         │
│  عرض نتائج البحث في قسم المخزون        │
└────────────────┬────────────────────────┘
                 │
      ┌──────────┼──────────┐
      │          │          │
      ↓          ↓          ↓
   حذف       إلغاء      مسح البحث
      │          │          │
      └──────────┼──────────┘
                 │
                 ↓
    isSearchActive = false
    currentSection = previousSection
    العودة للقسم الأول
```

---

## 🛠️ الدوال المتعلقة

| الدالة | الملف | الغرض |
|--------|------|-------|
| `renderInventory()` | [js/app.js#L3132](js/app.js#L3132) | عرض نتائج البحث |
| `filterAndSortProducts()` | [js/app.js](js/app.js) | تصفية وترتيب النتائج |
| `performDelete()` | [js/app.js#L3182](js/app.js#L3182) | حذف مع العودة للقسم السابق |
| `clearSearchInput()` | [js/app.js](js/app.js) | مسح نص البحث |
| `renderCurrentSection()` | [js/app.js#L2748](js/app.js#L2748) | تحديث الشاشة |

---

## 🎨 التصميم

### المظهر في الحالات المختلفة:

**الحالة 1: البحث نشط**
```
┌─────────────────────────┐
│ 🔍 بحث عن منتج...      │ ← شريط البحث مرئي
├─────────────────────────┤
│ 🔵 دراجة حمراء          │
│ 🔵 دراجة زرقاء          │ ← نتائج البحث
│ 🔵 دراجة خضراء          │
└─────────────────────────┘
```

**الحالة 2: البحث فارغ**
```
┌─────────────────────────┐
│ 🔍 بحث عن منتج...      │ ← شريط البحث فارغ
├─────────────────────────┤
│ عرض جميع المنتجات      │ ← القسم الأصلي
└─────────────────────────┘
```

---

## ⚙️ إعدادات البحث

### المتغيرات المرتبطة:

```javascript
currentInventoryFilter  // التصفية (all/available/outofstock)
currentInventorySort    // الترتيب (alphabetical/purchase/sale/quantity)
```

**ملاحظة:** البحث يعمل **مع** التصفية والترتيب، لا يستبدلهما.

---

## 🔴 الأخطاء الشائعة وحلولها

### المشكلة 1: البحث لا يعمل

**السبب:** شريط البحث مخفي أو لم يتم ربط `addEventListener`

**الحل:**
```javascript
// تحقق من وجود شريط البحث
var searchInput = document.getElementById('searchItemsInput');
if (!searchInput) console.error('شريط البحث مفقود في HTML');

// تحقق من المستمع
console.log(searchInput.listeners); // تحقق الكود المرتبط به
```

---

### المشكلة 2: لا يعود للقسم السابق بعد الحذف

**السبب:** `previousSection` لم يتم حفظه بشكل صحيح

**الحل:**
```javascript
// تحقق من قيمة previousSection قبل الحذف
console.log('previousSection:', previousSection);
console.log('isSearchActive:', isSearchActive);

// تأكد من أن performDelete يحتوي على الكود الصحيح
```

---

### المشكلة 3: البحث يظهر نتائج خاطئة

**السبب:** دالة `filterAndSortProducts()` قد لا تعمل بشكل صحيح

**الحل:**
```javascript
// اختبر الدالة يدويّاً
var results = filterAndSortProducts("اسم المنتج");
console.log('النتائج:', results);
```

---

## 📝 التوثيق الدقيق للكود

### البحث (Input Listener):

```javascript
// الموقع: js/app.js، السطر ~3730
document.getElementById('searchItemsInput').addEventListener('input', function() {
  var searchValue = this.value.trim();  // اقرأ ما كُتب
  
  if (searchValue.length > 0) {         // هل كُتب شيء؟
    if (!isSearchActive) {               // هل هذا أول بحث؟
      previousSection = currentSection;  // احفظ القسم الأول
      isSearchActive = true;             // علّم أن البحث نشط
    }
    currentSection = 'inventory';        // اعرض المخزون (النتائج)
  } else {                               // لا، البحث فارغ
    isSearchActive = false;              // أوقف البحث
    if (currentSection === 'inventory') {// إذا كنا في نتائج البحث
      currentSection = previousSection;  // عود للقسم الأول
    }
  }
  renderCurrentSection();                // حدّث الشاشة
});
```

---

### الحذف مع العودة:

```javascript
// الموقع: js/app.js، السطر ~3182
async function performDelete(itemId) {
  var item = allItems.find(function(i) { return i.id === itemId; });
  if (!item) return;
  
  // احذف من قاعدة البيانات
  await db.collection('items').doc(itemId).delete();
  await logActivity('delete', 'item', itemId, 'حذف منتج: ' + item.name, { name: item.name });
  
  // حدّث القائمة
  allItems = allItems.filter(function(i) { return i.id !== itemId; });
  
  // إذا كان البحث نشطاً
  if (isSearchActive) {
    currentSection = previousSection;   // عود للقسم الأول
    isSearchActive = false;             // أوقف البحث
    clearSearchInput();                 // امسح نص البحث
    renderCurrentSection();             // حدّث الشاشة
  } else {
    renderInventory();                  // وإلا اعرض المخزون
  }
  
  showToast('تم الحذف');
}
```

---

## ✅ الاختبار اليدوي

### خطوات الاختبار:

1. **البحث من المخزون:**
   - افتح قسم المخزون
   - اكتب اسم منتج في البحث
   - تحقق من ظهور النتائج فقط
   - امسح البحث
   - يجب أن يظهر جميع المنتجات

2. **البحث من قسم آخر:**
   - افتح Dashboard
   - اكتب في البحث
   - يجب أن ينتقل لقسم المخزون تلقائياً
   - امسح البحث
   - يجب أن يعود ل Dashboard

3. **الحذف من نتائج البحث:**
   - ابحث عن منتج
   - احذفه
   - يجب أن يعود للقسم الأول تلقائياً

---

## 📌 ملاحظات مهمة

1. ✅ البحث **حي** (Live) - يحدّث النتائج أثناء الكتابة
2. ✅ البحث **ذكي** - يعود للقسم الأول تلقائياً
3. ✅ البحث **آمن** - لا يحذف البيانات، فقط يصفيها
4. ✅ البحث **سريع** - لا ينتظر حفظ البيانات

---

## 🎯 الخلاصة

نظام البحث الجديد يوفر:
- 🔍 بحث فوري في جميع الأقسام
- 🚀 عودة ذكية للقسم السابق
- ⚡ حذف مع الحفاظ على سياق المستخدم
- 🎨 واجهة سلسة وسهلة الاستخدام

اذا حدثت مشكلة، عود إلى قسم "الأخطاء الشائعة وحلولها" في هذا الملف.
