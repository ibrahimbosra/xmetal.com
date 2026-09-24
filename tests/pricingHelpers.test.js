const assert = require('assert');
const helpers = require('../js/pricingHelpers');

const item = {
 purchasePrice: 1,
 salePrice: 2,
 mechanicPrice: 1.5
};

assert.strictEqual(helpers.getMechanicDisplayPrice(item), 1.5);
assert.strictEqual(helpers.getMechanicDisplayPrice({ purchasePrice: 2, salePrice: 4 }), 4);
assert.strictEqual(helpers.getProfitPercent(1, 1.5), '50%');
assert.strictEqual(helpers.getProfitPercent(2, 3), '50%');
assert.strictEqual(helpers.getProfitPercent(0, 5), '--');

var primaryFromSecondary = helpers.toPrimaryAmount(5000, 13000, '');
assert.ok(Math.abs(primaryFromSecondary - (5000 / 13000)) < 1e-12, 'should preserve precision when converting to primary');
assert.strictEqual(helpers.toSecondaryAmount(primaryFromSecondary, 13000, 'primary'), 5000);
assert.strictEqual(helpers.toPrimaryAmount(100, 10, 'primary'), 100);
assert.strictEqual(helpers.toSecondaryAmount(100, 10, 'primary'), 1000);

console.log('pricing helpers tests passed');
