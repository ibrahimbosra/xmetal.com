const assert = require('assert');
const currencyModel = require('../js/currencyModel');

assert.strictEqual(currencyModel.toSecondary(100, 3.75), 100);
assert.strictEqual(currencyModel.toPrimary(375, 3.75), 375);

const historicalOperation = {
 amount: 100,
 currency: 'primary',
 rateAtTime: 1,
 displayTotalAmount: 100,
 rawTotalAmount: 100
};

const currentSettings = { rate: 1 };
assert.strictEqual(currencyModel.resolveAmountForCalculation(historicalOperation, currentSettings), 100);
assert.strictEqual(currencyModel.resolveCurrencyForCalculation(historicalOperation, currentSettings), 'primary');
assert.strictEqual(currencyModel.resolveExchangeRateAtTime(historicalOperation, currentSettings), 1);
assert.strictEqual(currencyModel.resolveHistoricalValue(historicalOperation, currentSettings).amount, 100);
assert.strictEqual(currencyModel.resolveHistoricalValue(historicalOperation, currentSettings).currency, 'primary');

assert.strictEqual(currencyModel.resolveFinancialAmount({ amount: 100, currency: 'primary', displayAmount: 5000 }, { rate: 600 }), 100);
assert.strictEqual(currencyModel.resolveFinancialAmount({ amount: 100, currency: 'primary', rateAtTime: 500, displayAmount: 5000 }, { rate: 600 }), 100);
assert.strictEqual(currencyModel.resolveFinancialAmount({ amount: 5000, currency: 'primary', rateAtTime: 500 }, { rate: 600 }), 5000);
assert.strictEqual(currencyModel.isAmbiguousFinancialRecord({ amount: 100, currency: 'primary', displayAmount: 5000 }, { rate: 600 }), false);
assert.strictEqual(currencyModel.getOriginalCurrency({ amount: 100, currency: 'primary', displayCurrency: 'primary' }, { baseCurrency: 'primary' }), 'primary');
assert.strictEqual(currencyModel.getOriginalAmount({ amount: 100, displayTotalAmount: 9999, rawTotalAmount: 8888 }), 100);
console.log('currencyModel tests passed');
