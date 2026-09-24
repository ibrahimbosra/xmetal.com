(function (global) {
  'use strict';

  var DEFAULT_SETTINGS = {
    baseCurrency: 'primary'
  };

  function normalizeCurrencyCode(code, fallback) {
    return 'primary';
  }

  function normalizeSettings(settings) {
    var base = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    base.baseCurrency = 'primary';
    return base;
  }

  function toSecondary(amount, rate) {
    var numeric = Number(amount) || 0;
    return Number.isFinite(numeric) ? numeric : 0;
  }

  function toPrimary(amount, rate) {
    var numeric = Number(amount) || 0;
    return Number.isFinite(numeric) ? numeric : 0;
  }

  function toPrimaryValue(amount) {
    return toPrimary(amount, 1);
  }

  function createFinancialRecord(amount, currency) {
    var sourceAmount = Number(amount) || 0;
    return {
      amount: sourceAmount,
      currency: 'primary'
    };
  }

  function getOriginalAmount(record) {
    if (!record || typeof record !== 'object') return 0;
    var keys = ['amount', 'totalAmount', 'baseAmount', 'value', 'netAmount', 'paidAmount', 'principalAmount', 'originalAmount'];
    for (var i = 0; i < keys.length; i += 1) {
      if (record[keys[i]] != null) {
        return Number(record[keys[i]]) || 0;
      }
    }
    return 0;
  }

  function getOriginalCurrency(record, settings) {
    return 'primary';
  }

  function resolveAmountForCalculation(record, settings) {
    if (!record || typeof record !== 'object') return 0;
    var direct = Number(record.amount != null ? record.amount : record.totalAmount != null ? record.totalAmount : record.baseAmount != null ? record.baseAmount : record.value != null ? record.value : 0) || 0;
    var currencyLabel = String(record.currency || record.baseCurrency || record.displayCurrency || 'primary').trim().toLowerCase();
    if (currencyLabel === '' && (record.rateAtTime != null || (settings && settings.rate != null))) {
      var rate = Number(record.rateAtTime != null ? record.rateAtTime : settings.rate) || 1;
      if (rate > 0 && direct > 0) {
        return direct / rate;
      }
    }
    return direct;
  }

  function resolveCurrencyForCalculation(record, settings) {
    return 'primary';
  }

  function resolveExchangeRateAtTime(record, settings) {
    if (!record || typeof record !== 'object') return 1;
    var candidate = Number(record.rateAtTime != null ? record.rateAtTime : (settings && settings.rate != null ? settings.rate : 1)) || 1;
    return candidate > 0 ? candidate : 1;
  }

  function resolveHistoricalValue(record, settings) {
    return {
      amount: resolveAmountForCalculation(record, settings),
      currency: resolveCurrencyForCalculation(record, settings),
      rateAtTime: resolveExchangeRateAtTime(record, settings)
    };
  }

  function isAmbiguousFinancialRecord(record, settings) {
    if (!record || typeof record !== 'object') return false;
    var currencyCode = String(record.currency || record.baseCurrency || record.displayCurrency || '').trim();
    if (currencyCode && currencyCode !== 'primary') return false;
    var hasDisplayAmounts = record.displayAmount != null || record.displayTotalAmount != null || record.rawAmount != null || record.rawTotalAmount != null;
    if (!hasDisplayAmounts) return false;
    return !record.rateAtTime && String(currencyCode).trim() === '';
  }

  function resolveFinancialAmount(record, settings) {
    if (!record || typeof record !== 'object') return 0;
    if (isAmbiguousFinancialRecord(record, settings)) return 0;
    return resolveAmountForCalculation(record, settings);
  }

  function resolveTreasuryValue(record, settings) {
    return resolveFinancialAmount(record, settings);
  }

  function resolveExpenseValue(record, settings) {
    return resolveFinancialAmount(record, settings);
  }

  var api = {
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    normalizeCurrencyCode: normalizeCurrencyCode,
    normalizeSettings: normalizeSettings,
    toSecondary: toSecondary,
    toPrimary: toPrimary,
    toPrimaryValue: toPrimaryValue,
    createFinancialRecord: createFinancialRecord,
    getOriginalAmount: getOriginalAmount,
    getOriginalCurrency: getOriginalCurrency,
    resolveAmountForCalculation: resolveAmountForCalculation,
    resolveCurrencyForCalculation: resolveCurrencyForCalculation,
    resolveExchangeRateAtTime: resolveExchangeRateAtTime,
    resolveHistoricalValue: resolveHistoricalValue,
    isAmbiguousFinancialRecord: isAmbiguousFinancialRecord,
    resolveFinancialAmount: resolveFinancialAmount,
    resolveTreasuryValue: resolveTreasuryValue,
    resolveExpenseValue: resolveExpenseValue
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  global.CurrencyModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
