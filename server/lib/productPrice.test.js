import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeProductPrice,
  ProductPriceValidationError,
} from './productPrice.js';

test('product price preserves two decimal places', () => {
  assert.equal(normalizeProductPrice('14.05'), '14.05');
  assert.equal(normalizeProductPrice('14.5'), '14.50');
  assert.equal(normalizeProductPrice(14), '14.00');
});

test('product price accepts empty values for quotation listings', () => {
  assert.equal(normalizeProductPrice(null), null);
  assert.equal(normalizeProductPrice(''), null);
  assert.equal(normalizeProductPrice('   '), null);
});

test('product price rejects negative, malformed, and over-precise values', () => {
  for (const value of ['-1', '14.005', '₹14.05', 'not-a-price']) {
    assert.throws(
      () => normalizeProductPrice(value),
      ProductPriceValidationError
    );
  }
});

test('product price enforces the DECIMAL(16,2) database range', () => {
  assert.equal(
    normalizeProductPrice('99999999999999.99'),
    '99999999999999.99'
  );
  assert.throws(
    () => normalizeProductPrice('100000000000000.00'),
    ProductPriceValidationError
  );
});
