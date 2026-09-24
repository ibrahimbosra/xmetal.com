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
assert.strictEqual(helpers.getCustomerDebtBalance('c_3', cancelledAfterPaymentSales, cancelledAfterPaymentOps), 2000);

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

const secondaryRawSale = {
  saleId: 'sale_raw_1',
  customerId: 'c_7',
  totalAmount: 0.38,
  displayTotalAmount: 5000,
  rawTotalAmount: 5000,
  paymentMethod: 'credit',
  timestamp: 1000
};
const secondaryRawOps = [{ customerId: 'c_7', type: 'payment', amount: 5000, timestamp: 2000, allocations: [{ saleId: 'sale_raw_1', amount: 5000, customerId: 'c_7', status: 'active' }] }];
assert.strictEqual(helpers.getSaleNetAmount(secondaryRawSale), 5000);
assert.strictEqual(helpers.getCustomerDebtBalance('c_7', [secondaryRawSale], secondaryRawOps), 0);
assert.strictEqual(helpers.getCustomerSalePaymentAllocations([secondaryRawSale], secondaryRawOps)['c_7']['sale_raw_1'], 5000);

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

const normalizedEditedSale = helpers.normalizeSaleForCancellation ? helpers.normalizeSaleForCancellation({
  saleId: 'sale_edited_1',
  itemId: 'item_7',
  quantity: null,
  unitPrice: 5000,
  displayTotalAmount: 15000,
  paymentMethod: 'cash'
}) : null;
assert.strictEqual(normalizedEditedSale && normalizedEditedSale.saleId, 'sale_edited_1');
assert.strictEqual(normalizedEditedSale && normalizedEditedSale.quantity, 3);

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

console.log('mobile sales helpers tests passed');
