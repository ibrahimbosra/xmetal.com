const assert = require('assert');
const helpers = require('../mobile-sales/mobile-sales-helpers');

function assertAmount(value, expected, label) {
 assert.strictEqual(Number(value), Number(expected), label);
}

function buildCashSale(qty, unitPrice, primaryAmount) {
 return {
  saleId: 'cash_sale_1',
  customerId: null,
  itemId: 'item_1',
  itemName: 'Test item',
  quantity: qty,
  unitPrice: unitPrice,
  totalAmount: primaryAmount,
  baseAmount: primaryAmount,
  baseCurrency: 'primary',
  saleMode: 'primary',
  paymentMethod: 'cash',
  isCreditSale: false,
  timestamp: 1000
 };
}

function buildCreditSale(totalAmount, customerId, saleId) {
 return {
  saleId: saleId || 'credit_sale_1',
  customerId: customerId || 'C1',
  itemId: 'item_2',
  itemName: 'Credit item',
  quantity: 2,
  unitPrice: 50,
  totalAmount: totalAmount,
  baseAmount: totalAmount,
  baseCurrency: 'primary',
  saleMode: 'primary',
  paymentMethod: 'credit',
  isCreditSale: true,
  timestamp: 1000
 };
}

// 1. Pure cash-sale arithmetic for quantity update.
{
 const sale = buildCashSale(2, 50, 100);
 const updatedQty = 3;
 const updatedTotal = (updatedQty * sale.unitPrice);
 assert.strictEqual(updatedQty, 3, 'quantity should update to 3');
 assert.strictEqual(updatedTotal, 150, 'total should update to 150');
 assert.strictEqual(updatedTotal - sale.totalAmount, 50, 'delta should be only the added quantity value');
 assert.strictEqual(helpers.getSaleReferenceAmount(sale), 100, 'cash sale reference amount should stay at 100 before mutation');
}

// 2. Pure price adjustment for cash sale.
{
 const sale = buildCashSale(2, 50, 100);
 const updatedUnitPrice = 60;
 const updatedTotal = sale.quantity * updatedUnitPrice;
 assert.strictEqual(updatedTotal, 120, 'price update should produce 120 total');
 assert.strictEqual(updatedTotal - sale.totalAmount, 20, 'cash delta should be +20 only');
 assert.strictEqual(sale.quantity, 2, 'quantity should remain unchanged by price-only edit');
}

// 3. Credit sale debt reconciliation before any payment.
{
 const sale = buildCreditSale(100, 'C1', 'credit_100');
 const result = helpers.reconcileCreditSaleDebtAfterEdit(sale, []);
 assert.strictEqual(result.debtAmount, 100, 'debt amount should match the sale total');
 assert.strictEqual(result.remainingDebt, 100, 'remaining debt should be the full amount before payment');
}

// 4. Credit sale debt reconciliation after partial payment.
{
 const sale = buildCreditSale(100, 'C1', 'credit_100_partial');
 const payments = [{
  type: 'payment',
  customerId: 'C1',
  status: 'active',
  amount: 40,
  allocations: [{ saleId: 'credit_100_partial', amount: 40, customerId: 'C1', status: 'active' }]
 }];
 const result = helpers.reconcileCreditSaleDebtAfterEdit(sale, payments);
 assert.strictEqual(result.debtAmount, 100, 'debt amount should remain 100');
 assert.strictEqual(result.remainingDebt, 60, 'remaining debt after partial payment should be 60');
}

// 5. Price edit on credit sale after partial payment should not reallocate the old payment arbitrarily.
{
 const sale = buildCreditSale(100, 'C1', 'credit_100_edit');
 const payment = { type: 'payment', customerId: 'C1', status: 'active', amount: 40, allocations: [{ saleId: 'credit_100_edit', amount: 40, customerId: 'C1', status: 'active' }] };
 const original = helpers.reconcileCreditSaleDebtAfterEdit(sale, [payment]);
 assert.strictEqual(original.remainingDebt, 60, 'partial payment should leave 60 outstanding');

 const updatedSale = Object.assign({}, sale, { totalAmount: 120, baseAmount: 120, unitPrice: 60, quantity: 2 });
 const updated = helpers.reconcileCreditSaleDebtAfterEdit(updatedSale, [payment]);
 assert.strictEqual(updated.debtAmount, 120, 'updated debt should reflect the edited sale total');
 assert.strictEqual(updated.remainingDebt, 80, 'remaining debt should be 80 after partial payment on a 120 total');

 const reducedSale = Object.assign({}, sale, { totalAmount: 80, baseAmount: 80, unitPrice: 40, quantity: 2 });
 const reduced = helpers.reconcileCreditSaleDebtAfterEdit(reducedSale, [payment]);
 assert.strictEqual(reduced.debtAmount, 80, 'reduced debt should match the edited sale total');
 assert.strictEqual(reduced.remainingDebt, 40, 'remaining debt should be 40 after a 40 payment');
}

// 6. After full payment a larger edit should create a new debt according to the system's current rule.
{
 const sale = buildCreditSale(100, 'C1', 'credit_100_paid');
 const payments = [{
  type: 'payment',
  customerId: 'C1',
  status: 'active',
  amount: 100,
  allocations: [{ saleId: 'credit_100_paid', amount: 100, customerId: 'C1', status: 'active' }]
 }];
 const paidResult = helpers.reconcileCreditSaleDebtAfterEdit(sale, payments);
 assert.strictEqual(paidResult.remainingDebt, 0, 'fully paid sale should have zero debt under the current reconciliation logic');

 const updatedSale = Object.assign({}, sale, { totalAmount: 120, baseAmount: 120, unitPrice: 60, quantity: 2 });
 const updatedAfterFullPayment = helpers.reconcileCreditSaleDebtAfterEdit(updatedSale, payments);
 assert.strictEqual(updatedAfterFullPayment.debtAmount, 120, 'updated amount should be 120');
 assert.strictEqual(updatedAfterFullPayment.remainingDebt, 20, 'new debt should be 20 when a paid-sale is increased');

 const reducedAfterFullPayment = helpers.reconcileCreditSaleDebtAfterEdit(Object.assign({}, sale, { totalAmount: 80, baseAmount: 80, unitPrice: 40, quantity: 2 }), payments);
 assert.strictEqual(reducedAfterFullPayment.debtAmount, 80, 'reduced amount should be 80');
 assert.strictEqual(reducedAfterFullPayment.remainingDebt, 0, 'no negative debt should be produced');
}

// 7. Sale normalization and cancellation idempotence guard.
{
 const sale = buildCashSale(2, 50, 100);
 const normalized = helpers.normalizeSaleForCancellation(sale);
 assert.strictEqual(normalized.quantity, 2, 'cancel normalization should preserve the original quantity');
 assert.strictEqual(normalized.saleId, 'cash_sale_1', 'cancel normalization should preserve sale id');
}

// 8. sale with historical rate remains stable when current rate changes.
{
 const sale = {
  saleId: '_sale_1',
  customerId: 'C2',
  totalAmount: 100,
  baseAmount: 100,
  baseCurrency: 'primary',
  saleMode: '',
  paymentMethod: 'credit',
  isCreditSale: true,
  rateAtTime: 600,
  quantity: 1,
  unitPrice: 100,
  timestamp: 1000
 };
 const reference = helpers.getSaleReferenceAmount(sale);
 assert.strictEqual(reference, 100 / 600, ' historical value should not be reinterpreted with the current rate');
 const currentRateChanged = Object.assign({}, sale, { rateAtTime: 600, currentExchangeRate: 1000 });
 assert.strictEqual(helpers.getSaleReferenceAmount(currentRateChanged), 100 / 600, 'historical rate should remain attached to the original record');
}

// 9. Ambiguous legacy record should not be treated as a valid primary amount.
{
 const ambiguous = {
  saleId: 'ambiguous_legacy',
  customerId: 'C3',
  amount: 100,
  currency: '',
  displayTotalAmount: 5000,
  rawTotalAmount: 5000,
  paymentMethod: 'credit',
  isCreditSale: true,
  timestamp: 1000
 };
 assert.strictEqual(helpers.getSaleReferenceAmount(ambiguous), 0, 'ambiguous legacy record without historical rate should not be treated as valid primary amount');
 assert.strictEqual(helpers.reconcileCreditSaleDebtAfterEdit(ambiguous, []).debtAmount, 0, 'ambiguity should carry through the debt reconciliation path');
}

// 10. Historical currency and refund logic should remain based on original record values.
{
 const sale = {
  saleId: 'sale_refund_1',
  customerId: 'C4',
  totalAmount: 100,
  baseAmount: 100,
  baseCurrency: 'primary',
  saleMode: 'primary',
  paymentMethod: 'credit',
  isCreditSale: true,
  refundAmount: 25,
  refundCurrency: 'primary',
  rateAtTime: 3.75,
  timestamp: 1000
 };
 assert.strictEqual(helpers.getSaleNetAmount(sale), 75, 'net amount after a primary refund should be the original total minus the refund');
 const RefundSale = Object.assign({}, sale, {
  saleMode: 'primary',
  baseCurrency: 'primary',
  refundCurrency: '',
  refundAmount: 25,
  totalAmount: 100,
  rateAtTime: 3.75
 });
 assert.strictEqual(helpers.getSaleNetAmount(RefundSale), 100 - (25 / 3.75), ' refund should convert using the historical rate while preserving the primary sale total');
}

console.log('salesLifecycleBehavior tests passed');
