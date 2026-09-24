(function () {
  'use strict';

  var TIME_ZONE = 'Asia/Riyadh';
  function parts(timestamp) {
    var value = new Date(timestamp || Date.now());
    var tokens = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value);
    var result = {};
    tokens.forEach(function (token) { if (token.type !== 'literal') result[token.type] = token.value; });
    return result;
  }
  function today() {
    var value = parts(Date.now());
    return value.year + '-' + value.month + '-' + value.day;
  }
  function valid(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    var match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    var date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return date.getFullYear() === Number(match[1]) && date.getMonth() + 1 === Number(match[2]) && date.getDate() === Number(match[3]);
  }
  function setValue(input, value) {
    var text = String(value || '');
    var match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
    var wrapper = input._manualDateWrapper;
    if (!wrapper) return;
    wrapper.querySelector('[data-date-part="day"]').value = match ? match[3] : '';
    wrapper.querySelector('[data-date-part="month"]').value = match ? match[2] : '';
    wrapper.querySelector('[data-date-part="year"]').value = match ? match[1] : '';
    input._manualDateValue = valid(text.slice(0, 10)) ? text.slice(0, 10) : '';
    wrapper.classList.toggle('is-invalid', Boolean(text) && !input._manualDateValue);
  }
  function sync(input) {
    var wrapper = input._manualDateWrapper;
    var previous = input._manualDateValue || '';
    var day = wrapper.querySelector('[data-date-part="day"]').value;
    var month = wrapper.querySelector('[data-date-part="month"]').value;
    var year = wrapper.querySelector('[data-date-part="year"]').value;
    var value = year.length === 4 && month.length === 2 && day.length === 2 ? year + '-' + month + '-' + day : '';
    input._manualDateValue = valid(value) ? value : '';
    input._manualDateInvalid = Boolean(day || month || year) && !input._manualDateValue;
    wrapper.classList.toggle('is-invalid', input._manualDateInvalid);
    if (input._manualDateValue !== previous && input._manualDateValue) input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function transform(input) {
    if (!input || input._manualDateWrapper) return;
    if (input.type !== 'date' && /HH?:?MM/i.test(input.placeholder || '')) return;
    var initial = input.value;
    var wrapper = document.createElement('div');
    wrapper.className = 'manual-date-fields';
    wrapper.dir = 'ltr';
    wrapper.innerHTML = '<input type="text" data-date-part="day" inputmode="numeric" maxlength="2" placeholder="اليوم" aria-label="اليوم"><span>-</span><input type="text" data-date-part="month" inputmode="numeric" maxlength="2" placeholder="الشهر" aria-label="الشهر"><span>-</span><input type="text" data-date-part="year" inputmode="numeric" maxlength="4" placeholder="السنة" aria-label="السنة">';
    input.type = 'hidden';
    input._manualDateWrapper = wrapper;
    input._manualDateValue = '';
    var next = input.nextSibling;
    input.parentNode.insertBefore(wrapper, next);
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: function () { return input._manualDateValue || ''; },
      set: function (value) { setValue(input, value); }
    });
    setValue(input, initial);
    var fields = Array.prototype.slice.call(wrapper.querySelectorAll('[data-date-part]'));
    fields.forEach(function (field, index) {
      field.addEventListener('input', function () {
        field.value = field.value.replace(/\D/g, '').slice(0, index === 2 ? 4 : 2);
        if (index === 0 && field.value.length === 2 && Number(field.value) > 31) field.value = '';
        if (index === 1 && field.value.length === 2 && Number(field.value) > 12) field.value = '';
        sync(input);
        if (field.value.length === (index === 2 ? 4 : 2) && fields[index + 1]) fields[index + 1].focus();
      });
      field.addEventListener('keydown', function (event) {
        if (event.key === 'Backspace' && !field.value && fields[index - 1]) fields[index - 1].focus();
        if (event.key === 'ArrowLeft' && fields[index - 1]) fields[index - 1].focus();
        if (event.key === 'ArrowRight' && fields[index + 1]) fields[index + 1].focus();
      });
      field.addEventListener('blur', function () { sync(input); });
    });
  }
  function scan(root) {
    (root || document).querySelectorAll('input[type="date"], input.date-input').forEach(transform);
  }
  window.XMetalDate = { timeZone: TIME_ZONE, today: today, isValid: valid, transform: transform, scan: scan };
  scan(document);
  new MutationObserver(function (records) { records.forEach(function (record) { Array.prototype.forEach.call(record.addedNodes, function (node) { if (node.nodeType === 1) scan(node); }); }); }).observe(document.documentElement, { childList: true, subtree: true });
}());
