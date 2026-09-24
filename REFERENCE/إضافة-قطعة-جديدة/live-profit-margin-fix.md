# 🔧 حل مشكلة: نسبة الربح لا تتحدث أثناء الكتابة

**تاريخ الحل:** 31 أغسطس 2026  
**الحالة:** ✅ تم الحل بنجاح

---

## 🔴 المشكلة الأصلية

عند فتح نموذج "إضافة قطعة جديدة"، عندما يكتب المستخدم في حقول السعر:
- سعر الشراء (`purchasePrice`)
- سعر البيع (`salePrice`)
- سعر الميكانيكي (`mechanicPrice`)

**لا تظهر نسبة الربح فوراً** ❌

النسبة تظهر فقط **بعد حفظ المنتج**، وليس أثناء الكتابة مباشرة.

---

## 🔍 السبب الحقيقي

الكود كان يستخدم حدث **`change` و `blur`** (عند ترك الحقل):
```javascript
purchasePriceInput.addEventListener('change', updateProductPriceDisplay);
salePriceInput.addEventListener('change', updateProductPriceDisplay);
```

لكن المستخدم يتوقع رؤية النسبة أثناء **`input`** (كل ضغطة على الكيبورد).

---

## ✅ الحل المطبق

### موقع الملف:
`js/app.js` (سطر 3696-3714)

### الخطوات:

#### 1️⃣ إضافة مستمع عام (Global Listener)
```javascript
document.addEventListener('input', function(event) {
  if (!event || !event.target || !event.target.id) return;
  if (event.target.id === 'purchasePrice' || event.target.id === 'salePrice' || event.target.id === 'mechanicPrice') {
    refreshPriceProfitLabels();
  }
});
```

**ماذا يفعل:**
- يراقب كل ضغطة على أي حقل في الصفحة
- إذا كان الحقل أحد الثلاثة أسعار، يستدعي `refreshPriceProfitLabels()` فوراً

#### 2️⃣ تأمين المستمعات الفردية
```javascript
if (purchasePriceInput) purchasePriceInput.addEventListener('input', updateProductPriceDisplay);
if (salePriceInput) salePriceInput.addEventListener('input', updateProductPriceDisplay);
if (mechanicPriceInput) mechanicPriceInput.addEventListener('input', updateProductPriceDisplay);
```

**ماذا يفعل:**
- تأكد أن الحقول موجودة قبل إضافة المستمع
- تجنب الأخطاء على الصفحات الأخرى

#### 3️⃣ التحديث الفوري للنسب
دالة `refreshPriceProfitLabels()` تقوم بـ:
```javascript
function refreshPriceProfitLabels() {
  var purchaseEl = document.getElementById('purchasePrice');
  var saleEl = document.getElementById('salePrice');
  var mechanicEl = document.getElementById('mechanicPrice');
  var saleLabel = document.getElementById('salePriceLabel');
  var mechanicLabel = document.getElementById('mechanicPriceLabel');

  // قراءة القيم الحالية (حتى لو لم تحفظ)
  var purchaseValue = parseInputNumber(purchaseEl ? purchaseEl.value : null);
  var saleValue = parseInputNumber(saleEl ? saleEl.value : null);
  var mechanicValue = parseInputNumber(mechanicEl ? mechanicEl.value : null);

  // تحديث التسميات مع النسب
  if (saleLabel) {
    saleLabel.innerHTML = buildProfitLabelMarkup('سعر البيع ($)', purchaseValue, saleValue);
  }
  if (mechanicLabel) {
    mechanicLabel.innerHTML = buildProfitLabelMarkup('سعر الميكانيكي ($)', purchaseValue, mechanicValue);
  }
}
```

---

## 📝 كيف تتم حساب النسبة

الدالة `buildProfitLabelMarkup()` تحسبها:
```javascript
var profitPercent = ((target - purchase) / purchase) * 100;
```

مثال:
- سعر الشراء: 100
- سعر البيع: 200
- النسبة: ((200 - 100) / 100) × 100 = **100%** ✅

---

## 🧪 كيفية التحقق من أن الحل يعمل

1. افتح الصفحة: `index.html`
2. انقر على زر "إضافة قطعة جديدة"
3. اكتب في حقول السعر:
   - سعر الشراء: `100`
   - سعر البيع: `200`
   - سعر الميكانيكي: `150`
4. **النتيجة المتوقعة:**
   - تسمية سعر البيع تصبح: **سعر البيع ($) نسبة الربح: 100%** ✅
   - تسمية سعر الميكانيكي تصبح: **سعر الميكانيكي ($) نسبة الربح: 50%** ✅

---

## 🔴 إذا حدثت المشكلة مرة أخرى

### السيناريو 1: النسب لا تظهر أثناء الكتابة
**التشخيص:**
```bash
# تحقق من وجود المستمع
grep "document.addEventListener('input'" js/app.js
```

**الحل:**
أعد إضافة المستمع العام (الخطوة 1️⃣ أعلاه) إلى `js/app.js` سطر ~3704

---

### السيناريو 2: النسب تظهر بقيمة خاطئة
**السبب:** دالة `parseInputNumber()` قد لا تقرأ القيمة بشكل صحيح

**التحقق:**
```javascript
// في أدوات المتصفح (Developer Tools)
parseInputNumber(document.getElementById('purchasePrice').value)
parseInputNumber(document.getElementById('salePrice').value)
```

**الحل:**
تأكد من أن `parseInputNumber()` في `app.js` (سطر 439) تحول الفواصل والرموز بشكل صحيح:
```javascript
s = s.replace(/,/g, '.');  // فاصلة → نقطة
s = s.replace(/[^0-9.\-]/g, '');  // إزالة الرموز
```

---

### السيناريو 3: النسب تختفي بعد الحفظ
**السبب:** دالة `prepareAddItemForm()` لم تستدعِ `updatePriceLabels()`

**التحقق:**
ابحث عن `prepareAddItemForm` في `app.js` وتأكد أنها تحتوي على:
```javascript
updatePriceLabels();
updateProductPriceDisplay();
```

**الحل:**
إذا لم تكن موجودة، أضفها يدويّاً:
```javascript
function prepareAddItemForm() {
  // ... الكود الآخر ...
  updatePriceLabels();           // ← أضف هذا
  updateProductPriceDisplay();   // ← وهذا
}
```

---

### السيناريو 4: حقل من الحقول لا يستجيب
**التشخيص:**
تأكد من أن `index.html` يحتوي على الحقول بالأسماء الصحيحة:
```html
<input type="number" id="purchasePrice" ...>
<input type="number" id="salePrice" ...>
<input type="number" id="mechanicPrice" ...>
```

**الحل:**
إذا كانت الأسماء مختلفة، عدّل المستمع العام:
```javascript
if (event.target.id === 'purchasePrice' || event.target.id === 'salePrice' || event.target.id === 'mechanicPrice') {
  // غيّر الأسماء هنا حسب `id` الفعلي للحقول
}
```

---

### السيناريو 5: خطأ "TypeError: cannot read property"
**السبب:** عنصر HTML غير موجود على الصفحة

**الحل:**
أضف فحوصات حماية (`null checks`):
```javascript
var purchasePriceInput = document.getElementById('purchasePrice');
if (purchasePriceInput) {
  purchasePriceInput.addEventListener('input', updateProductPriceDisplay);
}
```

---

## 📂 الملفات المتعلقة

| الملف | الدالة | الغرض |
|------|--------|-------|
| `js/app.js` | `refreshPriceProfitLabels()` | تحديث نسب الربح |
| `js/app.js` | `buildProfitLabelMarkup()` | رسم النسبة بصيغة HTML |
| `js/app.js` | `parseInputNumber()` | تحويل قيمة المستخدم إلى رقم |
| `js/pricingHelpers.js` | `getProfitPercent()` | حساب نسبة الربح بديل |
| `index.html` | أسطر 100-122 | حقول السعر والتسميات |

---

## ✅ الاختبارات

تأكد من أن المشروع يمر بـ:
```bash
node --test tests/*.test.js
node -c js/app.js
```

**النتيجة المتوقعة:**
- 13 اختبار pass ✅
- 0 اختبار fail ✅

---

## 📌 ملاحظات مهمة

1. ✅ النسبة تظهر **داخل** تسمية الحقل، وليس **تحته** (لا نص مكرر)
2. ✅ الألوان تتغير تلقائياً: أخضر للربح، أحمر للخسارة
3. ✅ لا حاجة لحفظ المنتج لرؤية النسبة - تظهر فوراً
4. ✅ العملية لا تؤثر على offline queue أو Firestore

---

## 🎯 الخلاصة

**المشكلة:** نسبة الربح لا تتحدث أثناء الكتابة  
**السبب:** حدث `change` بدلاً من `input`  
**الحل:** إضافة مستمع `input` عام + استدعاء `refreshPriceProfitLabels()`  
**النتيجة:** ✅ النسبة تتحدث فوراً  

اذا حدثت المشكلة مرة أخرى، عود إلى هذا الملف وتابع الخطوات في القسم "إذا حدثت المشكلة مرة أخرى".
