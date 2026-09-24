const assert = require('assert');
const helpers = require('../mobile-sales/mobile-sales-helpers');

assert.strictEqual(helpers.getEmployeeDayId('emp_1', '2026-08-25'), 'employee_day_emp_1_2026-08-25');

const employee = {
 dailyWage: 40000,
 wageHistory: [
  { effectiveFrom: '2026-08-01', dailyWage: 40000 },
  { effectiveFrom: '2026-08-26', dailyWage: 50000 }
 ]
};
assert.strictEqual(helpers.getEmployeeWageForDay(employee, '2026-08-25'), 40000);
assert.strictEqual(helpers.getEmployeeWageForDay(employee, '2026-08-26'), 50000);

const operations = [];
for (let day = 0; day < 10; day += 1) operations.push({ type: 'wage', amount: 40000 });
operations.push({ type: 'withdrawal', amount: 50000 });
operations.push({ type: 'productPurchase', amount: 100000 });
operations.push({ type: 'withdrawal', amount: 300000 });
operations.push({ type: 'wage', amount: 40000 });
assert.strictEqual(helpers.calculateEmployeeBalance(operations), -10000);
assert.strictEqual(helpers.calculateEmployeeBalance(operations.concat([{ type: 'wage', amount: 40000, status: 'cancelled' }])), -10000);
assert.strictEqual(helpers.calculateEmployeeBalance([{ type: 'wage', amount: 100000 }, { type: 'withdrawal', amount: 40000, currency: 'primary' }]), 60000);
assert.strictEqual(helpers.calculateEmployeeBalance([
 { type: 'wage', amount: 100000 },
 { type: 'withdrawal', amount: 40000, status: 'returned' },
 { type: 'withdrawal', amount: 20000, status: 'cancelled' }
]), 100000);

const employeeGoodsFlow = [
 { type: 'employee_withdrawal', amount: 3000 },
 { type: 'employee_withdrawal_return', amount: 1000 },
 { type: 'wage', amount: 2000 }
];
assert.strictEqual(helpers.calculateEmployeeBalance(employeeGoodsFlow), 0);
assert.strictEqual(helpers.calculateEmployeeBalance([{ type: 'employee_withdrawal', amount: 4000 }, { type: 'employee_withdrawal_return', amount: 1500 }]), -2500);

assert.strictEqual(helpers.isEmployeeOperationActive({ type: 'withdrawal', status: 'active' }), true);
assert.strictEqual(helpers.isEmployeeOperationActive({ type: 'withdrawal', status: 'returned' }), false);
assert.strictEqual(helpers.isEmployeeOperationActive({ type: 'withdrawal', status: 'cancelled' }), false);
assert.strictEqual(helpers.isEmployeeOperationEditable({ type: 'withdrawal' }), false);
assert.strictEqual(helpers.isEmployeeOperationEditable({ type: 'employee_withdrawal' }), false);
assert.strictEqual(helpers.isEmployeeOperationEditable({ type: 'wage' }), false);
assert.strictEqual(helpers.isEmployeeOperationEditable({ type: 'employee_withdrawal_return' }), false);

const cashEditDelta = helpers.getEmployeeWithdrawalEditImpact({ amount: 50000 }, 40000);
assert.strictEqual(cashEditDelta.balanceDelta, -10000);
assert.strictEqual(cashEditDelta.newAmount, 40000);

const goodsEditDelta = helpers.getEmployeeGoodsEditImpact({ quantity: 2, amount: 50000 }, 3, 25000);
assert.strictEqual(goodsEditDelta.quantityDelta, 1);
assert.strictEqual(goodsEditDelta.amountDelta, 25000);
assert.strictEqual(goodsEditDelta.newAmount, 75000);

const goodsDecrease = helpers.getEmployeeGoodsEditImpact({ quantity: 3, amount: 75000 }, 1, 25000);
assert.strictEqual(goodsDecrease.quantityDelta, -2);
assert.strictEqual(goodsDecrease.amountDelta, -50000);
assert.strictEqual(goodsDecrease.newAmount, 25000);

const productValueSummary = helpers.getEmployeeProductValue([
 { type: 'wage', amount: 50000 },
 { type: 'employee_withdrawal', amount: 3000 },
 { type: 'productPurchase', amount: 2500 },
 { type: 'employee_withdrawal_return', amount: 1000 },
 { type: 'employee_withdrawal', amount: 7000 },
 { type: 'employee_withdrawal_return', amount: 500, status: 'cancelled' }
]);
assert.strictEqual(productValueSummary, 13500);
assert.strictEqual(helpers.getEmployeeBalanceColorClass(-250), 'negative');
assert.strictEqual(helpers.getEmployeeBalanceColorClass(0), 'positive');
assert.strictEqual(helpers.getEmployeeBalanceColorClass(1250), 'positive');

const employeeCurrencyWage = {
 dailyWagePrimary: 50000,
 dailyWagePrimary: 187500,
 dailyWageCurrency: 'primary',
 rate: 3.75
};
assert.deepStrictEqual(helpers.getEmployeeWageDisplay(employeeCurrencyWage, 'primary', { CurrencySymbol: '$', rate: 3.75 }), {
 value: 50000,
 symbol: '$',
 code: 'primary'
});
assert.deepStrictEqual(helpers.getEmployeeWageDisplay(employeeCurrencyWage, 'primary', { CurrencySymbol: '$', rate: 3.75 }), {
 value: 50000,
 symbol: '$',
 code: 'primary'
});
assert.strictEqual(helpers.getEmployeeWageForCurrency(employeeCurrencyWage, 'primary'), 50000);
assert.strictEqual(helpers.getEmployeeWageForCurrency(employeeCurrencyWage, 'primary'), 50000);

const storedBalanceEmployee = { currentBalance: 25000, name: 'Test Employee' };
assert.strictEqual(helpers.getEmployeeCurrentBalance(storedBalanceEmployee, [{ type: 'wage', amount: 10000 }]), 10000);
assert.strictEqual(helpers.getEmployeeCurrentBalance({ name: 'No stored value' }, [{ type: 'wage', amount: 60000 }, { type: 'withdrawal', amount: 20000 }]), 40000);
assert.strictEqual(helpers.calculateEmployeeBalance([{ type: 'wage', amount: 50000 }, { type: 'withdrawal', amount: 1000 }]), 49000);
assert.strictEqual(helpers.calculateEmployeeBalance([
 { type: 'wage', amount: 15000, currency: '', rateAtTime: 3.75 },
 { type: 'withdrawal', amount: 6000, currency: '', rateAtTime: 3.75 }
]), 9000);
assert.strictEqual(helpers.calculateEmployeeBalance([
 { type: 'wage', amount: 15000, currency: '', rateAtTime: 3.75 },
 { type: 'withdrawal', amount: 6000, currency: '', rateAtTime: 3.75 },
 { type: 'employee_withdrawal_return', amount: 1500, currency: '', rateAtTime: 3.75 }
]), 10500);

console.log('employee helper tests passed');
