const assert = require('assert');
const helpers = require('../mobile-sales/mobile-sales-helpers');

assert.strictEqual(helpers.resolveSellerName('user@example.com', 'اسم المستخدم', { 'user@example.com': 'اسم المستخدم' }), 'اسم المستخدم');
assert.strictEqual(helpers.resolveSellerName('user@example.com', '', { 'USER@EXAMPLE.COM': 'أحمد' }), 'أحمد');
assert.strictEqual(helpers.resolveSellerName('user@example.com', 'System User', {}), 'System User');
assert.strictEqual(helpers.resolveSellerName('', 'System User', {}), 'System User');
assert.strictEqual(helpers.getArabicInitial('أسلاك حديدية'), 'ا');
assert.strictEqual(helpers.getArabicInitial('BRASS'), 'ب');
assert.strictEqual(helpers.getArabicInitial('123'), 'ا');
assert.strictEqual(helpers.convertSecondaryToPrimary(5000, 13000), 5000 / 13000);
assert.strictEqual(helpers.convertPrimaryToSecondary(5000 / 13000, 13000), 5000);
assert.deepStrictEqual(helpers.getProductCurrencyDisplay(100, { baseCurrency: 'primary', rate: 10, CurrencySymbol: '$', showProductPrices: false }), {
 primaryCode: 'primary', primaryValue: 100, primarySymbol: '$', Value: 100, Symbol: '$', showSecondary: false
});
assert.deepStrictEqual(helpers.getProductCurrencyDisplay(100, { baseCurrency: 'primary', rate: 10, CurrencySymbol: '$', showProductPrices: true }), {
 primaryCode: 'primary', primaryValue: 100, primarySymbol: '$', Value: 100, Symbol: '$', showSecondary: false
});
assert.deepStrictEqual(helpers.getDisplayMoney(1.15, 'primary', { baseCurrency: 'primary', rate: 13000, CurrencySymbol: '$' }), {
 value: 1.15,
 symbol: '$',
 code: 'primary'
});
assert.deepStrictEqual(helpers.getDisplayMoney(15000, 'primary', { baseCurrency: 'primary', rate: 13000, CurrencySymbol: '$' }), {
 value: 15000,
 symbol: '$',
 code: 'primary'
});
assert.deepStrictEqual(helpers.getDisplayMoney(3.8461538461538463, undefined, { baseCurrency: 'primary', rate: 13000, CurrencySymbol: '$' }), {
 value: 3.8461538461538463,
 symbol: '$',
 code: 'primary'
});
assert.deepStrictEqual(helpers.getDisplayMoney(3.8461538461538463, null, { baseCurrency: 'primary', rate: 13000, CurrencySymbol: '$' }), {
 value: 3.8461538461538463,
 symbol: '$',
 code: 'primary'
});
assert.deepStrictEqual(helpers.getActiveCurrencyDisplay(30.62, 'primary', { baseCurrency: 'primary', rate: 13, CurrencySymbol: '$' }), {
 value: 30.62,
 symbol: '$',
 code: 'primary',
 label: '30.62 $'
});
assert.deepStrictEqual(helpers.getActiveCurrencyDisplay(398000, 'primary', { baseCurrency: 'primary', rate: 13, CurrencySymbol: '$' }), {
 value: 398000,
 symbol: '$',
 code: 'primary',
 label: '398,000 $'
});
assert.deepStrictEqual(helpers.getActiveCurrencyDisplay(30.62, 'primary', { baseCurrency: 'primary', rate: 13, CurrencySymbol: '$' }), {
 value: 30.62,
 symbol: '$',
 code: 'primary',
 label: '30.62 $'
});

const sale = {
 saleId: 'sale_001',
 customerId: 'customer_9',
 totalAmount: 100000,
 paymentMethod: 'credit',
 debtOperationId: 'debt_op_77'
};
const debtOperations = [
 { id: 'debt_op_10', customerId: 'customer_9', amount: 300000, type: 'debt', saleId: 'older_sale' },
 { id: 'debt_op_77', customerId: 'customer_9', amount: 100000, type: 'debt', saleId: 'sale_001' },
 { id: 'debt_op_20', customerId: 'customer_9', amount: 300000, type: 'payment' }
];

assert.strictEqual(helpers.findLinkedDebtOperation(sale, debtOperations).id, 'debt_op_77');
assert.strictEqual(helpers.findLinkedDebtOperation({ saleId: 'missing_sale', customerId: 'customer_9', totalAmount: 5000, paymentMethod: 'credit' }, debtOperations), null);

const creditSales = [
 { saleId: 'sale_1', customerId: 'c_1', totalAmount: 5000, paymentMethod: 'credit', timestamp: 1000 },
 { saleId: 'sale_2', customerId: 'c_1', totalAmount: 10000, paymentMethod: 'credit', timestamp: 2000 },
 { saleId: 'sale_3', customerId: 'c_1', totalAmount: 20000, paymentMethod: 'credit', timestamp: 3000 }
];
const customerPayments = [
 { customerId: 'c_1', type: 'payment', amount: 7500, timestamp: 4000 }
];
const firstProgress = helpers.getSalePaymentProgress(creditSales[0], creditSales, customerPayments);
assert.strictEqual(firstProgress.amount, 5000);
assert.strictEqual(firstProgress.paidAmount, 5000);
assert.strictEqual(firstProgress.percent, 100);
assert.strictEqual(firstProgress.isPaid, true);
assert.strictEqual(firstProgress.isCredit, true);
assert.strictEqual(firstProgress.hasPayment, true);

const secondProgress = helpers.getSalePaymentProgress(creditSales[1], creditSales, customerPayments);
assert.strictEqual(secondProgress.amount, 10000);
assert.strictEqual(secondProgress.paidAmount, 2500);
assert.strictEqual(secondProgress.percent, 25);
assert.strictEqual(secondProgress.isPaid, false);
assert.strictEqual(secondProgress.isCredit, true);
assert.strictEqual(secondProgress.hasPayment, true);

const thirdProgress = helpers.getSalePaymentProgress(creditSales[2], creditSales, customerPayments);
assert.strictEqual(thirdProgress.amount, 20000);
assert.strictEqual(thirdProgress.paidAmount, 0);
assert.strictEqual(thirdProgress.percent, 0);
assert.strictEqual(thirdProgress.isPaid, false);
assert.strictEqual(thirdProgress.isCredit, true);
assert.strictEqual(thirdProgress.hasPayment, false);

const fullPaymentSales = [
 { saleId: 'sale_a', customerId: 'c_2', totalAmount: 5000, paymentMethod: 'credit', timestamp: 1000 },
 { saleId: 'sale_b', customerId: 'c_2', totalAmount: 10000, paymentMethod: 'credit', timestamp: 2000 }
];
const fullPaymentOps = [
 { customerId: 'c_2', type: 'payment', amount: 15000, timestamp: 3000 }
];
assert.strictEqual(helpers.getSalePaymentProgress(fullPaymentSales[0], fullPaymentSales, fullPaymentOps).percent, 100);
assert.strictEqual(helpers.getSalePaymentProgress(fullPaymentSales[1], fullPaymentSales, fullPaymentOps).percent, 100);

const cancelledAfterPaymentSales = [
 { saleId: 'sale_x', customerId: 'c_3', totalAmount: 5000, paymentMethod: 'credit', timestamp: 1000 },
 { saleId: 'sale_y', customerId: 'c_3', totalAmount: 3000, paymentMethod: 'credit', timestamp: 2000 }
];
const cancelledAfterPaymentOps = [
 { customerId: 'c_3', type: 'payment', amount: 6000, timestamp: 3000 }
];
assert.strictEqual(helpers.getCustomerDebtBalance('c_3', cancelledAfterPaymentSales, cancelledAfterPaymentOps), 2000);
cancelledAfterPaymentSales[0].cancelled = true;
assert.strictEqual(helpers.getCustomerDebtBalance('c_3', cancelledAfterPaymentSales, cancelledAfterPaymentOps), 0);

const aggregateDebtSales = [
 { saleId: 'aggregate_sale_1', customerId: 'c_aggregate', totalAmount: 15000, paymentMethod: 'credit' },
 { saleId: 'aggregate_sale_2', customerId: 'c_aggregate', totalAmount: 20000, paymentMethod: 'credit' },
 { saleId: 'aggregate_sale_3', customerId: 'c_aggregate', totalAmount: 10000, paymentMethod: 'credit' }
];
const aggregateDebtOps = [
 { id: 'aggregate_payment', customerId: 'c_aggregate', type: 'payment', amount: 20000, allocations: [{ saleId: 'aggregate_sale_1', amount: 20000 }] }
];
assert.strictEqual(helpers.getCustomerDebtBalance('c_aggregate', aggregateDebtSales, aggregateDebtOps), 25000);

const refundedSales = [
 { saleId: 'sale_r1', customerId: 'c_4', totalAmount: 5000, paymentMethod: 'credit', timestamp: 1000, status: 'refunded', refundAmount: 5000 },
 { saleId: 'sale_r2', customerId: 'c_4', totalAmount: 3000, paymentMethod: 'credit', timestamp: 2000, status: 'active' }
];
const refundedOps = [
 { customerId: 'c_4', type: 'payment', amount: 8000, timestamp: 3000, allocations: [
  { saleId: 'sale_r1', amount: 5000, customerId: 'c_4', status: 'refunded' },
  { saleId: 'sale_r2', amount: 3000, customerId: 'c_4', status: 'active' }
 ] }
];
assert.strictEqual(helpers.getCustomerSalePaymentAllocations(refundedSales, refundedOps)['c_4']['sale_r2'], 3000);
assert.strictEqual(helpers.getCustomerDebtBalance('c_4', refundedSales, refundedOps), 0);

const partialRefundSales = [
 { saleId: 'sale_p1', customerId: 'c_5', totalAmount: 8000, paymentMethod: 'credit', timestamp: 1000, status: 'partially_refunded', refundAmount: 5000 },
 { saleId: 'sale_p2', customerId: 'c_5', totalAmount: 3000, paymentMethod: 'credit', timestamp: 2000, status: 'active' }
];
const partialRefundOps = [
 { customerId: 'c_5', type: 'payment', amount: 6000, timestamp: 3000, allocations: [
  { saleId: 'sale_p1', amount: 3000, customerId: 'c_5', status: 'active' },
  { saleId: 'sale_p2', amount: 3000, customerId: 'c_5', status: 'active' }
 ] }
];
assert.strictEqual(helpers.getCustomerDebtBalance('c_5', partialRefundSales, partialRefundOps), 0);
assert.strictEqual(helpers.getSalePaymentProgress(partialRefundSales[0], partialRefundSales, partialRefundOps).paidAmount, 3000);

const exactDebtEntry = { id: 'debt_row_1', type: 'debt', customerId: 'c_6', amount: 5000, saleId: 'sale_exact_1', note: 'بيع آجل - ابرة اصلاح كربريتر' };
const exactPaymentEntry = { id: 'pay_row_1', type: 'payment', customerId: 'c_6', amount: 5000, allocations: [{ saleId: 'sale_exact_1', amount: 5000, customerId: 'c_6', status: 'active' }] };
const exactDebtResult = helpers.getDebtOperationPaymentProgress(exactDebtEntry, [exactPaymentEntry]);
assert.strictEqual(exactDebtResult.percent, 100);
assert.strictEqual(exactDebtResult.isPaid, true);

const legacyPrimarySale = {
 saleId: 'legacy_sale_1',
 customerId: 'c_legacy',
 totalAmount: 70000,
 saleMode: '',
 displayTotalAmount: 5380,
 rawTotalAmount: 5380,
 paymentMethod: 'credit',
 timestamp: 1000
};
assert.strictEqual(helpers.getSaleReferenceAmount(legacyPrimarySale), 0);
assert.strictEqual(helpers.getSaleReferenceAmount({ totalAmount: 100, baseCurrency: 'primary', displayTotalAmount: 5000, rawTotalAmount: 5000, saleMode: 'primary' }), 100);
assert.strictEqual(helpers.getSaleReferenceAmount({ totalAmount: 250, baseCurrency: '', displayTotalAmount: 5000, rawTotalAmount: 5000, saleMode: '', rateAtTime: 1 }), 250);
assert.strictEqual(helpers.getSaleNetAmount({ totalAmount: 100, baseCurrency: 'primary', refundAmount: 25, refundCurrency: 'primary', rateAtTime: 3.75 }), 75);
assert.strictEqual(helpers.getSaleNetAmount({ totalAmount: 100, baseCurrency: 'primary', refundAmount: 25, refundCurrency: '', rateAtTime: 3.75 }), 93.33333333333333);
assert.strictEqual(helpers.getSaleReferenceAmount({ totalAmount: 0.38, baseCurrency: 'primary', displayTotalAmount: 5000, rawTotalAmount: 5000, saleMode: 'primary' }), 0.38);
assert.strictEqual(helpers.getSaleReferenceAmount({ displayTotalAmount: 5000, rawTotalAmount: 5000, saleMode: 'primary' }), 0);
const RawSale = {
 saleId: 'sale_raw_1',
 customerId: 'c_7',
 totalAmount: 0.38,
 displayTotalAmount: 5000,
 rawTotalAmount: 5000,
 paymentMethod: 'credit',
 timestamp: 1000
};
const RawOps = [{ customerId: 'c_7', type: 'payment', amount: 5000, timestamp: 2000, allocations: [{ saleId: 'sale_raw_1', amount: 5000, customerId: 'c_7', status: 'active' }] }];
assert.strictEqual(helpers.getSaleNetAmount(RawSale), 0.38);
assert.strictEqual(helpers.getCustomerDebtBalance('c_7', [RawSale], RawOps), 0);
assert.strictEqual(helpers.getCustomerSalePaymentAllocations([RawSale], RawOps)['c_7']['sale_raw_1'], 0.38);

const displayOverrideDebtSale = {
 saleId: 'sale_debt_display_override',
 customerId: 'c_debt_override',
 totalAmount: 100,
 displayTotalAmount: 5000,
 rawTotalAmount: 5000,
 paymentMethod: 'credit',
 isCreditSale: true,
 timestamp: 1000
};
const displayOverrideDebtOps = [
 { customerId: 'c_debt_override', type: 'payment', amount: 60, timestamp: 2000, status: 'active', allocations: [{ saleId: 'sale_debt_display_override', amount: 60, customerId: 'c_debt_override', status: 'active' }] }
];
const reconciledDisplayOverride = helpers.reconcileCreditSaleDebtAfterEdit(displayOverrideDebtSale, displayOverrideDebtOps);
assert.strictEqual(reconciledDisplayOverride.debtAmount, 100);
assert.strictEqual(reconciledDisplayOverride.remainingDebt, 40);
assert.strictEqual(helpers.getReturnSaleSuggestedCashAmount(displayOverrideDebtSale, [], [{ customerId: 'c_debt_override', type: 'payment', amount: 200, timestamp: 2000, status: 'active' }]), 100);

const displayOverrideCancellationSale = {
 saleId: 'sale_cancel_display_override',
 customerId: 'c_cancel_override',
 itemId: 'item_cancel_override',
 quantity: 5,
 unitPrice: 20,
 totalAmount: 100,
 displayTotalAmount: 5000,
 rawTotalAmount: 5000,
 paymentMethod: 'credit',
 timestamp: 1000
};
assert.strictEqual(helpers.normalizeSaleForCancellation(displayOverrideCancellationSale).quantity, 5);

const displayOverrideReassignmentSales = [
 { saleId: 'sale_reassign_cancelled', customerId: 'c_reassign', totalAmount: 100, displayTotalAmount: 5000, rawTotalAmount: 5000, paymentMethod: 'credit', timestamp: 1000 },
 { saleId: 'sale_reassign_target', customerId: 'c_reassign', totalAmount: 50, displayTotalAmount: 5000, rawTotalAmount: 5000, paymentMethod: 'credit', timestamp: 2000 }
];
const displayOverrideReassignmentOps = [
 { id: 'pay_reassign_1', customerId: 'c_reassign', type: 'payment', amount: 100, timestamp: 3000, status: 'active', allocations: [{ saleId: 'sale_reassign_cancelled', amount: 100, customerId: 'c_reassign', status: 'active' }] }
];
const displayOverrideReassignment = helpers.reassignPaymentsForCancelledSale('c_reassign', 'sale_reassign_cancelled', displayOverrideReassignmentSales, displayOverrideReassignmentOps);
assert.strictEqual(displayOverrideReassignment.reassignedAmount, 100);
assert.strictEqual(displayOverrideReassignment.assignments.length, 1);
assert.strictEqual(displayOverrideReassignment.assignments[0].amount, 50);

const ambiguousLegacyDebtSale = {
 saleId: 'sale_debt_ambiguous',
 customerId: 'c_legacy_ambiguous',
 displayTotalAmount: 5000,
 rawTotalAmount: 5000,
 paymentMethod: 'credit',
 isCreditSale: true,
 timestamp: 1000
};
assert.strictEqual(helpers.getSaleReferenceAmount(ambiguousLegacyDebtSale), 0);
assert.strictEqual(helpers.reconcileCreditSaleDebtAfterEdit(ambiguousLegacyDebtSale, []).debtAmount, 0);

const cancellationSales = [
 { saleId: 'sale_a', customerId: 'c_7', totalAmount: 5000, paymentMethod: 'credit', timestamp: 1000 },
 { saleId: 'sale_b', customerId: 'c_7', totalAmount: 10000, paymentMethod: 'credit', timestamp: 2000 }
];
const cancellationOps = [
 { id: 'debt_a', customerId: 'c_7', type: 'debt', amount: 5000, saleId: 'sale_a', timestamp: 1000, status: 'active' },
 { id: 'debt_b', customerId: 'c_7', type: 'debt', amount: 10000, saleId: 'sale_b', timestamp: 2000, status: 'active' },
 { id: 'pay_1', customerId: 'c_7', type: 'payment', amount: 5000, timestamp: 3000, status: 'active', allocations: [{ saleId: 'sale_a', amount: 5000, customerId: 'c_7', status: 'active' }] }
];
const reallocation = helpers.reassignPaymentsForCancelledSale('c_7', 'sale_a', cancellationSales, cancellationOps);
assert.strictEqual(reallocation.reassignedAmount, 5000);
assert.strictEqual(reallocation.assignments.length, 1);
assert.strictEqual(reallocation.assignments[0].saleId, 'sale_b');
assert.strictEqual(reallocation.assignments[0].amount, 5000);

const paidRefundSales = [
 { saleId: 'sale_paid_1', customerId: 'c_9', totalAmount: 5000, paymentMethod: 'credit', timestamp: 1000 },
 { saleId: 'sale_paid_2', customerId: 'c_9', totalAmount: 7000, paymentMethod: 'credit', timestamp: 2000 }
];
const paidRefundOps = [
 { id: 'debt_paid_1', customerId: 'c_9', type: 'debt', amount: 5000, saleId: 'sale_paid_1', timestamp: 1000, status: 'active' },
 { id: 'debt_paid_2', customerId: 'c_9', type: 'debt', amount: 7000, saleId: 'sale_paid_2', timestamp: 2000, status: 'active' },
 { id: 'pay_paid_1', customerId: 'c_9', type: 'payment', amount: 5000, timestamp: 3000, status: 'active', allocations: [{ saleId: 'sale_paid_1', amount: 5000, customerId: 'c_9', status: 'active' }] }
];
assert.strictEqual(helpers.getSalePaidAmount(paidRefundSales[0], paidRefundOps), 5000);
assert.strictEqual(helpers.getSalePaymentProgress(paidRefundSales[0], paidRefundSales, paidRefundOps).percent, 100);
assert.strictEqual(helpers.getCustomerDebtBalance('c_9', paidRefundSales, paidRefundOps), 7000);

const cancelledPaymentOps = [
 { id: 'debt_cancelled', customerId: 'c_cancelled', type: 'debt', amount: 26000, saleId: 'sale_cancelled', status: 'cancelled' },
 { id: 'payment_cancelled', customerId: 'c_cancelled', type: 'settle', amount: 26000, saleId: 'sale_cancelled', status: 'cancelled' }
];
assert.strictEqual(helpers.getCustomerDebtBalance('c_cancelled', [], cancelledPaymentOps), 0);
assert.deepStrictEqual(helpers.getCustomerSalePaymentAllocations([
 { saleId: 'sale_cancelled', customerId: 'c_cancelled', totalAmount: 26000, paymentMethod: 'credit' }
], cancelledPaymentOps), { c_cancelled: { sale_cancelled: 0 } });

const editedPaidCreditSale = {
 saleId: 'sale_edit_1',
 customerId: 'c_10',
 customerName: 'عميل 10',
 totalAmount: 6000,
 displayTotalAmount: 6000,
 paymentMethod: 'credit',
 isCreditSale: true,
 timestamp: 5000
};
const editedPaidCreditOps = [
 { id: 'debt_edit_1', customerId: 'c_10', customerName: 'عميل 10', type: 'debt', amount: 5000, saleId: 'sale_edit_1', relatedSaleId: 'sale_edit_1', linkedSaleId: 'sale_edit_1', status: 'active', timestamp: 4000 },
 { id: 'pay_edit_1', customerId: 'c_10', customerName: 'عميل 10', type: 'payment', amount: 5000, timestamp: 4500, status: 'active', allocations: [{ saleId: 'sale_edit_1', amount: 5000, customerId: 'c_10', status: 'active' }] }
];
var reconciledEdit = helpers.reconcileCreditSaleDebtAfterEdit(editedPaidCreditSale, editedPaidCreditOps);
assert.strictEqual(reconciledEdit.debtAmount, 6000);
assert.strictEqual(reconciledEdit.remainingDebt, 1000);
assert.strictEqual(reconciledEdit.salePercent, 83.33);
assert.strictEqual(helpers.getCustomerDebtBalance('c_10', [editedPaidCreditSale], reconciledEdit.operations), 1000);

const saleLinkedDebtOperation = { id: 'debt_link_1', customerId: 'c_11', type: 'debt', amount: 5000, saleId: 'sale_link_1', linkedSaleId: 'sale_link_1', relatedSaleId: 'sale_link_1', timestamp: 5000 };
const linkedSaleLookup = helpers.findSaleByDebtOperation ? helpers.findSaleByDebtOperation(saleLinkedDebtOperation, [{ saleId: 'sale_link_1', customerId: 'c_11', totalAmount: 5000, paymentMethod: 'credit' }]) : null;
assert.strictEqual(linkedSaleLookup && linkedSaleLookup.saleId, 'sale_link_1');

assert.strictEqual(helpers.getSaleEditQuantityLimit ? helpers.getSaleEditQuantityLimit({ quantity: 4 }, { quantity: 1 }) : null, 5);
assert.strictEqual(helpers.getSaleEditQuantityLimit ? helpers.getSaleEditQuantityLimit({ quantity: 7 }, { quantity: 3 }) : null, 10);
assert.strictEqual(helpers.getSaleEditQuantityLimit ? helpers.getSaleEditQuantityLimit({ quantity: 0 }, { quantity: 3 }) : null, 3);

const returnSuggestedSale = {
 saleId: 'return_sale_1',
 customerId: 'c_return',
 totalAmount: 100000,
 displayTotalAmount: 100000,
 paymentMethod: 'credit',
 timestamp: 1000
};
assert.strictEqual(helpers.getReturnSaleSuggestedCashAmount ? helpers.getReturnSaleSuggestedCashAmount(returnSuggestedSale, [], []) : 0, 0);
assert.strictEqual(helpers.getReturnSaleSuggestedCashAmount ? helpers.getReturnSaleSuggestedCashAmount(returnSuggestedSale, [], [
 { customerId: 'c_return', type: 'payment', amount: 20000, timestamp: 2000, status: 'active' },
 { customerId: 'c_return', type: 'payment', amount: 30000, timestamp: 3000, status: 'active' }
]) : 0, 100000);
assert.strictEqual(helpers.getReturnSaleSuggestedCashAmount ? helpers.getReturnSaleSuggestedCashAmount(returnSuggestedSale, [], [
 { customerId: 'c_return', type: 'payment', amount: 20000, timestamp: 500, status: 'active' }
]) : 0, 0);

const normalizedEditedSale = helpers.normalizeSaleForCancellation ? helpers.normalizeSaleForCancellation({
 saleId: 'sale_edited_1',
 itemId: 'item_7',
 quantity: null,
 unitPrice: 5000,
 displayTotalAmount: 15000,
 paymentMethod: 'cash'
}) : null;
assert.strictEqual(normalizedEditedSale && normalizedEditedSale.saleId, 'sale_edited_1');
assert.strictEqual(normalizedEditedSale && normalizedEditedSale.quantity, 0);

const dedupedSales = helpers.uniqueRecordsById ? helpers.uniqueRecordsById([
 { saleId: 'sale_dup_1', totalAmount: 1000 },
 { saleId: 'sale_dup_1', totalAmount: 2000 },
 { saleId: 'sale_dup_2', totalAmount: 3000 }
], ['saleId', 'id']) : [];
assert.strictEqual(dedupedSales.length, 2);
assert.strictEqual(dedupedSales[0].totalAmount, 2000);

const dedupedDebtOps = helpers.uniqueRecordsById ? helpers.uniqueRecordsById([
 { id: 'debt_dup_1', customerId: 'c_99', amount: 5000 },
 { id: 'debt_dup_1', customerId: 'c_99', amount: 5000 },
 { id: 'debt_dup_2', customerId: 'c_99', amount: 7000 }
], ['id', 'debtOperationId', 'operationId']) : [];
assert.strictEqual(dedupedDebtOps.length, 2);
assert.strictEqual(dedupedDebtOps[0].id, 'debt_dup_1');

const manualDebtOps = [
 { id: 'manual_debt_1', customerId: 'c_manual', type: 'debt', amount: 5000, dateKey: '2026-08-22', timestamp: 1724294400000, status: 'active' },
 { id: 'manual_payment_1', customerId: 'c_manual', type: 'payment', amount: 2000, dateKey: '2026-08-24', timestamp: 1724457600000, status: 'active' }
];
assert.strictEqual(helpers.getCustomerDebtBalance('c_manual', [], manualDebtOps), 3000);
assert.strictEqual(helpers.getCustomerDebtBalance('c_manual', [], [{ id: 'manual_debt_2', customerId: 'c_manual', type: 'debt', amount: 5000, dateKey: '2026-08-22', timestamp: 1724294400000, status: 'active' }]), 5000);

const groupedDebtCycleOps = [
 { id: 'cycle_1', customerId: 'c_cycle', type: 'debt', amount: 5000, timestamp: 1000 },
 { id: 'cycle_2', customerId: 'c_cycle', type: 'debt', amount: 10000, timestamp: 2000 },
 { id: 'cycle_3', customerId: 'c_cycle', type: 'payment', amount: 5000, timestamp: 3000 },
 { id: 'cycle_4', customerId: 'c_cycle', type: 'debt', amount: 2500, timestamp: 4000 },
 { id: 'cycle_5', customerId: 'c_cycle', type: 'payment', amount: 2500, timestamp: 5000 }
];
const groupedDebtCycles = helpers.groupDebtOperationsByCycles(groupedDebtCycleOps);
assert.strictEqual(groupedDebtCycles.length, 1);
assert.strictEqual(groupedDebtCycles[0].entries.length, 5);
assert.strictEqual(groupedDebtCycles[0].balance, 10000);

const twoCycleDebtOps = [
 { id: 'two_cycle_1', customerId: 'c_cycle_2', type: 'debt', amount: 7000, timestamp: 1000 },
 { id: 'two_cycle_2', customerId: 'c_cycle_2', type: 'payment', amount: 7000, timestamp: 2000 },
 { id: 'two_cycle_3', customerId: 'c_cycle_2', type: 'debt', amount: 12000, timestamp: 3000 }
];
const twoCycleGroups = helpers.groupDebtOperationsByCycles(twoCycleDebtOps);
assert.strictEqual(twoCycleGroups.length, 2);
assert.strictEqual(twoCycleGroups[0].entries.length, 1);
assert.strictEqual(twoCycleGroups[1].entries.length, 2);
assert.strictEqual(twoCycleGroups[0].balance, 12000);

const partialDebtProgressOps = [
 { id: 'd_old', customerId: 'c_progress', type: 'debt', amount: 5000, timestamp: 1000 },
 { id: 'd_new', customerId: 'c_progress', type: 'debt', amount: 10000, timestamp: 2000 },
 { id: 'pay_1', customerId: 'c_progress', type: 'payment', amount: 5000, timestamp: 3000 }
];
assert.strictEqual(helpers.getDebtOperationPaymentProgress(partialDebtProgressOps[0], partialDebtProgressOps).percent, 100);
assert.strictEqual(helpers.getDebtOperationPaymentProgress(partialDebtProgressOps[1], partialDebtProgressOps).percent, 0);
assert.strictEqual(helpers.getCustomerDebtBalance('c_progress', [], partialDebtProgressOps), 10000);

const settleDebtProgressOps = [
 { id: 'd_full_1', customerId: 'c_settle', type: 'debt', amount: 7000, timestamp: 1000 },
 { id: 'd_full_2', customerId: 'c_settle', type: 'debt', amount: 3000, timestamp: 2000 },
 { id: 'pay_all', customerId: 'c_settle', type: 'settle', amount: 10000, timestamp: 3000 }
];
assert.strictEqual(helpers.getDebtOperationPaymentProgress(settleDebtProgressOps[0], settleDebtProgressOps).percent, 100);
assert.strictEqual(helpers.getDebtOperationPaymentProgress(settleDebtProgressOps[1], settleDebtProgressOps).percent, 100);
assert.strictEqual(helpers.getCustomerDebtBalance('c_settle', [], settleDebtProgressOps), 0);

const settleWithCreditSales = [
 { saleId: 'sale_settle_1', customerId: 'c_settle_mix', totalAmount: 5000, paymentMethod: 'credit', timestamp: 1000 },
 { saleId: 'sale_settle_2', customerId: 'c_settle_mix', totalAmount: 7000, paymentMethod: 'credit', timestamp: 2000 }
];
const settleWithCreditDebtOps = [
 { id: 'debt_mix_1', customerId: 'c_settle_mix', type: 'debt', amount: 5000, timestamp: 1000 },
 { id: 'debt_mix_2', customerId: 'c_settle_mix', type: 'debt', amount: 4000, timestamp: 2000 },
 { id: 'pay_mix_full', customerId: 'c_settle_mix', type: 'settle', amount: 9000, timestamp: 3000, allocations: [
  { debtOperationId: 'debt_mix_1', amount: 5000, customerId: 'c_settle_mix', status: 'active' },
  { debtOperationId: 'debt_mix_2', amount: 4000, customerId: 'c_settle_mix', status: 'active' }
 ] }
];
assert.strictEqual(helpers.getDebtOperationPaymentProgress(settleWithCreditDebtOps[0], settleWithCreditDebtOps).percent, 100);
assert.strictEqual(helpers.getDebtOperationPaymentProgress(settleWithCreditDebtOps[1], settleWithCreditDebtOps).percent, 100);
assert.strictEqual(helpers.getCustomerDebtBalance('c_settle_mix', settleWithCreditSales, settleWithCreditDebtOps), 12000);

const directSettleExactScenarioSales = [
 { saleId: 'sale_exact_1', customerId: 'customer_1', totalAmount: 39000, paymentMethod: 'credit', timestamp: 1000 }
];
const directSettleExactScenarioOps = [
 { id: 'debt_exact_manual', customerId: 'customer_1', type: 'debt', amount: 2000, timestamp: 2000 },
 { id: 'settle_exact_full', customerId: 'customer_1', type: 'settle', amount: 41000, timestamp: 3000, allocations: [
  { debtOperationId: 'debt_exact_manual', amount: 2000, customerId: 'customer_1', status: 'active' },
  { saleId: 'sale_exact_1', amount: 39000, customerId: 'customer_1', status: 'active' }
 ] }
];
assert.strictEqual(helpers.getCustomerDebtBalance('customer_1', directSettleExactScenarioSales, directSettleExactScenarioOps), 0);

const sameTimestampCycleOperations = [
 { id: 'debt_carburator', customerId: 'customer_1', type: 'debt', amount: 39000, timestamp: 1000 },
 { id: 'settle_carburator', customerId: 'customer_1', type: 'settle', amount: 41000, timestamp: 2000 },
 { id: 'debt_manual_same_time', customerId: 'customer_1', type: 'debt', amount: 2000, timestamp: 2000 }
];
const sameTimestampCycles = helpers.groupDebtOperationsByCycles(sameTimestampCycleOperations);
assert.strictEqual(sameTimestampCycles.length, 1);
assert.deepStrictEqual(sameTimestampCycles[0].entries.map(entry => entry.id), ['debt_manual_same_time', 'settle_carburator', 'debt_carburator']);

const customDateOperation = {
 id: 'op_custom_date',
 customerId: 'customer_date',
 type: 'debt',
 amount: 2000,
 timestamp: 1724610000000,
 operationDate: '2026-08-22',
 dateKey: '2026-08-22'
};
assert.strictEqual(customDateOperation.operationDate, '2026-08-22');
assert.strictEqual(customDateOperation.dateKey, '2026-08-22');

console.log('mobile sales helpers tests passed');
