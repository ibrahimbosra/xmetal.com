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

console.log('pricing helpers tests passed');
