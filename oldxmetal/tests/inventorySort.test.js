const assert = require('assert');
const helpers = require('../js/pricingHelpers');

const items = [
  { id: 'a', name: 'أول', purchasePrice: 50, salePrice: 80, quantity: 2 },
  { id: 'b', name: 'ثاني', purchasePrice: 80, salePrice: 60, quantity: 10 },
  { id: 'c', name: 'ثالث', purchasePrice: 30, salePrice: 100, quantity: 5 }
];

const byPurchase = helpers.sortInventoryProducts(items.slice(), 'purchase');
assert.deepStrictEqual(byPurchase.map(item => item.id), ['b', 'a', 'c']);

const bySale = helpers.sortInventoryProducts(items.slice(), 'sale');
assert.deepStrictEqual(bySale.map(item => item.id), ['c', 'a', 'b']);

const byQuantity = helpers.sortInventoryProducts(items.slice(), 'quantity');
assert.deepStrictEqual(byQuantity.map(item => item.id), ['b', 'c', 'a']);

console.log('inventory sort tests passed');
