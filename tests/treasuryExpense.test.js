const assert = require('assert');
const currencyModel = require('../js/currencyModel');

assert.strictEqual(currencyModel.resolveTreasuryValue({ amount: 100, currency: 'primary' }, { rate: 600 }), 100);
assert.strictEqual(currencyModel.resolveTreasuryValue({ amount: 100, currency: 'primary', rateAtTime: 500 }, { rate: 600 }), 100);
assert.strictEqual(currencyModel.resolveTreasuryValue({ amount: 100, currency: 'primary' }, { rate: 600 }), 100);

assert.strictEqual(currencyModel.resolveExpenseValue({ amount: 250, currency: 'primary' }, { rate: 6 }), 250);
assert.strictEqual(currencyModel.resolveExpenseValue({ amount: 250, currency: 'primary', rateAtTime: 5 }, { rate: 6 }), 250);
assert.strictEqual(currencyModel.resolveExpenseValue({ amount: 250, currency: 'primary' }, { rate: 6 }), 250);

assert.strictEqual(currencyModel.resolveTreasuryValue({ amount: 100, currency: 'primary', rateAtTime: 500 }, { rate: 600 }), currencyModel.resolveExpenseValue({ amount: 100, currency: 'primary', rateAtTime: 500 }, { rate: 600 }));
assert.strictEqual(currencyModel.resolveTreasuryValue({ amount: 100, currency: 'primary', displayTotalAmount: 1000, rawTotalAmount: 1000 }, { rate: 600 }), 100);
assert.strictEqual(currencyModel.resolveTreasuryValue({ amount: 100, currency: 'primary', rateAtTime: 500, displayTotalAmount: 5000 }, { rate: 600 }), 100);
assert.strictEqual(currencyModel.resolveTreasuryValue({ amount: 100, currency: 'primary', rateAtTime: 500 }, { rate: 600 }) === currencyModel.resolveTreasuryValue({ amount: 100, currency: 'primary', rateAtTime: 600 }, { rate: 600 }), true);

console.log('treasury and expense tests passed');
