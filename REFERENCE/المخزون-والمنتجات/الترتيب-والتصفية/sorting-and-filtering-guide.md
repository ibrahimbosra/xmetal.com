# 📊 نظام ترتيب وتصفية المنتجات

**تاريخ الإنشاء:** 31 أغسطس 2026  
**الحالة:** ✅ يعمل بكفاءة عالية

---

## 🎯 نظرة عامة

نظام الترتيب يوفر:
1. **ترتيب افتراضي** - أبجدي (حروف عربية)
2. **ترتيب بالسعر** - أعلى سعر شراء أو بيع
3. **ترتيب بالكمية** - أعلى كمية متوفرة
4. **ترتيب ذكي أثناء البحث** - يعطي أولوية للنتائج الأقرب

---

## 🔤 الترتيب الأبجدي الافتراضي

### المفهوم الأساسي

الترتيب الأبجدي يرتب المنتجات **حسب اسم المنتج بالعربية**، مع احترام القواعس اللغوية العربية.

### الدالة الأساسية

**الموقع:** [js/app.js#L3067](js/app.js#L3067)

```javascript
function arabicAlphabeticalComparator(a, b) { 
  return a.name.localeCompare(b.name, 'ar', { 
    sensitivity: 'variant',
    usage: 'sort' 
  }); 
}
```

### كيف يعمل؟

| المعامل | الغرض | الشرح |
|--------|-------|-------|
| `a.name` | الاسم الأول | اسم المنتج الأول للمقارنة |
| `b.name` | الاسم الثاني | اسم المنتج الثاني للمقارنة |
| `'ar'` | لغة العربية | يطبق قواعد اللغة العربية |
| `sensitivity: 'variant'` | حساسية الحروف | يميز بين الحروف الكبيرة والصغيرة والنقاط |
| `usage: 'sort'` | الاستخدام | مخصص للفرز/الترتيب |

### النتيجة

```javascript
return value:
  -1  →  a يأتي قبل b (في ترتيب أبجدي أقل)
   0  →  a و b متساويان
   1  →  b يأتي قبل a (في ترتيب أبجدي أقل)
```

### مثال عملي

**قائمة المنتجات الأصلية:**
```
- زيت محرك
- دراجة حمراء
- إطار سيارة
- بطارية سيارة
- أسلاك كهربائية
```

**بعد الترتيب الأبجدي:**
```
1. أسلاك كهربائية     (يبدأ بـ أ)
2. إطار سيارة         (يبدأ بـ إ)
3. بطارية سيارة       (يبدأ بـ ب)
4. دراجة حمراء         (يبدأ بـ د)
5. زيت محرك           (يبدأ بـ ز)
```

---

## 📈 أنواع الترتيب الأخرى

### 1️⃣ الترتيب بسعر الشراء

**الموقع:** [js/app.js#L3084](js/app.js#L3084)

```javascript
if (mode === 'purchase') {
  return (Number(b.purchasePrice) || 0) - (Number(a.purchasePrice) || 0) || arabicAlphabeticalComparator(a, b);
}
```

**المنطق:**
1. يقارن أسعار الشراء **بشكل نزولي** (أعلى سعر أولاً)
2. إذا تساوى السعران، يرتب **أبجدياً**

**مثال:**
```
المنتج A: سعر شراء 100
المنتج B: سعر شراء 200
المنتج C: سعر شراء 100

الترتيب:
1. المنتج B (200) - أعلى سعر
2. المنتج A (100) - ثم أبجدي
3. المنتج C (100) - ثم أبجدي
```

### 2️⃣ الترتيب بسعر البيع

**الموقع:** [js/app.js#L3087](js/app.js#L3087)

```javascript
if (mode === 'sale') {
  return (Number(b.salePrice) || 0) - (Number(a.salePrice) || 0) || arabicAlphabeticalComparator(a, b);
}
```

**المنطق:** نفس منطق سعر الشراء لكن **بسعر البيع**

### 3️⃣ الترتيب بالكمية

**الموقع:** [js/app.js#L3090](js/app.js#L3090)

```javascript
if (mode === 'quantity') {
  return (Number(b.quantity) || 0) - (Number(a.quantity) || 0) || arabicAlphabeticalComparator(a, b);
}
```

**المنطق:**
1. يقارن الكميات **بشكل نزولي** (أعلى كمية أولاً)
2. إذا تساوت الكميات، يرتب **أبجدياً**

**الفائدة:** تسهل تحديد المنتجات الموجودة بكثرة في المخزون

---

## 🔍 الترتيب الذكي أثناء البحث

### الفكرة الأساسية

عند البحث عن منتج، يجب أن تظهر **النتائج الأقرب أولاً**، وليس مجرد أي نتيجة توافق البحث.

### مستويات الأولوية (Search Priority)

**الموقع:** [js/app.js#L3110-L3128](js/app.js#L3110-L3128)

```javascript
function filterAndSortProducts(term, stockFilter) {
  var filtered = [...allItems];
  var hasSearch = term && term.trim() !== "";
  var sortMode = currentInventorySort || 'alphabetical';
  
  if (hasSearch) {
    var searchTerm = term.trim();
    // الخطوة 1: تصفية النتائج
    filtered = filtered.filter(function(p) { 
      return p.name.includes(searchTerm);  // ← اسم يحتوي على البحث
    });
    
    // الخطوة 2: تحديد الأولوية
    filtered.forEach(function(p) {
      var priority = 3;  // الأولوية الافتراضية
      
      // الأولوية 1: الاسم يبدأ بالبحث
      if (p.name.startsWith(searchTerm)) {
        priority = 1;
      } else {
        // الأولوية 2: كلمة في الاسم تبدأ بالبحث
        var words = p.name.split(/\s+/);
        for (var wi = 0; wi < words.length; wi++) {
          if (words[wi].startsWith(searchTerm)) {
            priority = 2;
            break;
          }
        }
      }
      p._searchPriority = priority;  // ← احفظ الأولوية
    });
  }
  
  // الخطوة 3: التصفية حسب المخزون
  if (stockFilter === 'available') {
    filtered = filtered.filter(function(i) { return i.quantity > 0; });
  } else if (stockFilter === 'outofstock') {
    filtered = filtered.filter(function(i) { return i.quantity === 0; });
  }
  
  // الخطوة 4: الترتيب
  if (hasSearch) {
    filtered.sort(function(a, b) {
      // ترتب حسب الأولوية أولاً
      if (a._searchPriority !== b._searchPriority) {
        return a._searchPriority - b._searchPriority;
      }
      // إذا تساوت الأولوية، ترتب حسب طريقة الترتيب المختارة
      return compareInventoryItems(a, b, sortMode);
    });
    filtered.forEach(function(p) { delete p._searchPriority; });
  } else {
    // بدون بحث، ترتب حسب طريقة الترتيب العادية
    filtered = sortInventoryList(filtered, sortMode);
  }
  
  return filtered;
}
```

### مثال توضيحي

**السيناريو:** المستخدم يبحث عن "دراجة"

**المنتجات المتاحة:**
```
- دراجة حمراء         (يبدأ بـ "دراجة")
- دراجة زرقاء         (يبدأ بـ "دراجة")
- إطار دراجة          (تحتوي على "دراجة" لكن لا تبدأ)
- دراجة بخارية        (يبدأ بـ "دراجة")
- قطع دراجة           (تحتوي على "دراجة" لكن لا تبدأ)
- دراجة أطفال         (يبدأ بـ "دراجة")
```

**نتائج البحث بالترتيب:**
```
الأولوية 1 (يبدأ بـ "دراجة"):
  1. دراجة حمراء         (ثم ترتيب أبجدي)
  2. دراجة أطفال         (ترتيب أبجدي)
  3. دراجة بخارية        (ترتيب أبجدي)
  4. دراجة زرقاء         (ترتيب أبجدي)

الأولوية 2 (كلمة تبدأ بـ "دراجة"):
  (لا توجد في هذا المثال)

الأولوية 3 (يحتوي على "دراجة"):
  5. إطار دراجة          (ترتيب أبجدي)
  6. قطع دراجة           (ترتيب أبجدي)
```

---

## 📊 مخطط آلية الترتيب

### بدون بحث

```
┌─────────────────────────────────────────┐
│         جميع المنتجات (allItems)        │
└────────────┬────────────────────────────┘
             │
      تصفية حسب المخزون
      (all/available/outofstock)
             │
             ↓
┌─────────────────────────────────────────┐
│       المنتجات المُصفاة (filtered)      │
└────────────┬────────────────────────────┘
             │
    ترتب حسب currentInventorySort:
    - alphabetical  (أبجدي)
    - purchase      (سعر الشراء)
    - sale          (سعر البيع)
    - quantity      (الكمية)
             │
             ↓
┌─────────────────────────────────────────┐
│      المنتجات المرتبة (sorted)          │
│      جاهزة للعرض على الشاشة            │
└─────────────────────────────────────────┘
```

### مع البحث

```
┌─────────────────────────────────────────┐
│         جميع المنتجات (allItems)        │
└────────────┬────────────────────────────┘
             │
    تصفية: name.includes(searchTerm)
             │
             ↓
┌─────────────────────────────────────────┐
│   المنتجات التي تحتوي على البحث        │
└────────────┬────────────────────────────┘
             │
  حساب مستوى الأولوية لكل منتج:
  1 = يبدأ الاسم بـ searchTerm
  2 = كلمة في الاسم تبدأ بـ searchTerm
  3 = الاسم يحتوي على searchTerm فقط
             │
             ↓
┌─────────────────────────────────────────┐
│   تصفية حسب المخزون (optional)          │
└────────────┬────────────────────────────┘
             │
  ترتب بناءً على:
  1️⃣ مستوى الأولوية (ascending: 1→3)
  2️⃣ ثم حسب طريقة الترتيب المختارة
  (alphabetical/purchase/sale/quantity)
             │
             ↓
┌─────────────────────────────────────────┐
│      المنتجات المرتبة (sorted)          │
│      حذف _searchPriority من الكائن      │
│      جاهزة للعرض على الشاشة            │
└─────────────────────────────────────────┘
```

---

## 🛠️ الدوال المتعلقة

| الدالة | الموقع | الغرض |
|--------|--------|-------|
| `arabicAlphabeticalComparator()` | [js/app.js#L3067](js/app.js#L3067) | مقارنة الأسماء بالعربية |
| `sortInventoryList()` | [js/app.js#L3076](js/app.js#L3076) | ترتيب قائمة المنتجات |
| `compareInventoryItems()` | [js/app.js#L3096](js/app.js#L3096) | مقارنة منتجين |
| `filterAndSortProducts()` | [js/app.js#L3110](js/app.js#L3110) | تصفية وترتيب مع البحث |
| `persistInventorySort()` | [js/app.js#L3070](js/app.js#L3070) | حفظ طريقة الترتيب |
| `renderInventory()` | [js/app.js#L3141](js/app.js#L3141) | عرض المنتجات المرتبة |

---

## ⚙️ إعدادات الترتيب

### المتغير العام

**الموقع:** [js/app.js#L396](js/app.js#L396)

```javascript
let currentInventorySort = (window.appState && appState.getState && 
  appState.getState('filters.inventorySort')) || 
  localStorage.getItem('xmetalInventorySort') || 
  'alphabetical';
```

**القيم الممكنة:**
- `'alphabetical'` - الترتيب الأبجدي (الافتراضي)
- `'purchase'` - أعلى سعر شراء
- `'sale'` - أعلى سعر بيع
- `'quantity'` - أعلى كمية

### تغيير طريقة الترتيب

```javascript
function persistInventorySort(sortMode) {
  currentInventorySort = sortMode || 'alphabetical';
  
  // حفظ في App State
  if (window.appState && appState.setState) {
    appState.setState('filters.inventorySort', currentInventorySort);
  }
  
  // حفظ في localStorage
  try { 
    localStorage.setItem('xmetalInventorySort', currentInventorySort); 
  } catch (e) {}
}
```

---

## 🎨 الواجهة (UI)

### قائمة الترتيب

**الموقع:** [index.html#L77-L83](index.html#L77-L83)

```html
<select id="inventorySortSelect">
  <option value="alphabetical">ترتيب أبجدي</option>
  <option value="purchase">أعلى سعر شراء</option>
  <option value="sale">أعلى سعر مبيع</option>
  <option value="quantity">أعلى كمية</option>
</select>
```

### المستمع

**الموقع:** [js/app.js#L3765-L3773](js/app.js#L3765-L3773)

```javascript
var inventorySortSelect = document.getElementById('inventorySortSelect');
if (inventorySortSelect) {
  inventorySortSelect.value = currentInventorySort || 'alphabetical';
  inventorySortSelect.addEventListener('change', function() {
    persistInventorySort(this.value);  // احفظ الاختيار
    renderInventory();                 // عدّل العرض
  });
}
```

---

## 📝 أمثلة عملية

### مثال 1: الترتيب الأبجدي

**المنتجات:**
```
- زيت موتور
- دراجة هوائية
- بطارية شاحنة
- أسلاك كهربائية
- إطار سيارة
```

**بعد الترتيب:**
```
1. أسلاك كهربائية
2. إطار سيارة
3. بطارية شاحنة
4. دراجة هوائية
5. زيت موتور
```

---

### مثال 2: البحث عن "أسلاك"

**المنتجات المتاحة:**
```
- أسلاك كهربائية عالية الجودة
- أسلاك سيارة
- وصلات وأسلاك
- أسلاك معدنية
```

**نتائج البحث:**
```
الأولوية 1 (يبدأ بـ "أسلاك"):
  1. أسلاك سيارة
  2. أسلاك كهربائية عالية الجودة
  3. أسلاك معدنية

الأولوية 3 (يحتوي على "أسلاك"):
  4. وصلات وأسلاك
```

---

### مثال 3: ترتيب حسب الكمية

**المنتجات:**
```
- دراجة (كمية: 5)
- بطارية (كمية: 12)
- إطار (كمية: 3)
- زيت (كمية: 12)
```

**الترتيب:**
```
1. بطارية (12) - أعلى كمية
2. زيت (12)    - أبجدي (بين المتساوية)
3. دراجة (5)   - ثاني أعلى
4. إطار (3)    - أقل كمية
```

---

## 🔴 الأخطاء الشائعة

### المشكلة 1: الترتيب لا يتغير عند تغيير الخيار

**السبب:** `renderInventory()` لم يتم استدعاؤه

**الحل:**
```javascript
inventorySortSelect.addEventListener('change', function() {
  persistInventorySort(this.value);
  renderInventory();  // ← تأكد من هذا السطر
});
```

---

### المشكلة 2: نتائج البحث غير منظمة

**السبب:** `_searchPriority` لم يتم حسابها بشكل صحيح

**الحل:**
```javascript
// تحقق من أن الكود يحسب الأولوية:
if (p.name.startsWith(searchTerm)) priority = 1;
else { 
  var words = p.name.split(/\s+/); 
  for (var wi = 0; wi < words.length; wi++) { 
    if (words[wi].startsWith(searchTerm)) { 
      priority = 2; 
      break; 
    } 
  } 
}
```

---

### المشكلة 3: الترتيب الأبجدي لا يحترم العربية

**السبب:** عدم استخدام `localeCompare` مع `'ar'`

**الحل:**
```javascript
// صحيح:
a.name.localeCompare(b.name, 'ar', { sensitivity: 'variant', usage: 'sort' })

// خطأ:
a.name.localeCompare(b.name)  // بدون 'ar' قد يكون غير صحيح
```

---

## ✅ الاختبار اليدوي

### خطوات الاختبار:

1. **الترتيب الأبجدي:**
   - افتح قسم المخزون
   - اختر "ترتيب أبجدي"
   - تحقق من أن المنتجات مرتبة بالعربية

2. **ترتيب سعر الشراء:**
   - اختر "أعلى سعر شراء"
   - تحقق من أن المنتجات مرتبة من أعلى سعر

3. **البحث المذكي:**
   - اكتب "دراجة"
   - تحقق من أن النتائج التي تبدأ بـ "دراجة" تأتي أولاً
   - ثم النتائج التي تحتوي على "دراجة"

4. **الترتيب مع البحث:**
   - ابحث عن "أسلاك"
   - غيّر طريقة الترتيب
   - تحقق من أن النتائج تُرتب حسب الأولوية ثم الترتيب المختار

---

## 📌 ملاحظات مهمة

1. ✅ الترتيب **حي** - يتغير فوراً عند تغيير الخيار
2. ✅ الترتيب **ذكي** - يحترم الأولويات أثناء البحث
3. ✅ الترتيب **محفوظ** - يُحفظ في `localStorage`
4. ✅ الترتيب **يعمل مع التصفية** - يجمع بينهما
5. ✅ الترتيب **يدعم العربية** - باستخدام `localeCompare`

---

## 🎯 الخلاصة

نظام الترتيب يوفر:
- 📊 ترتيب أبجدي ذكي بالعربية
- 💰 ترتيب حسب الأسعار والكميات
- 🔍 ترتيب ذكي أثناء البحث بمستويات أولوية
- 💾 حفظ تلقائي للاختيار

اذا حدثت مشكلة، عود إلى قسم "الأخطاء الشائعة" في هذا الملف.
