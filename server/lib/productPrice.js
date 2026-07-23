const PRODUCT_PRICE_PATTERN = /^\d+(?:\.\d{1,2})?$/;
const MAX_PRODUCT_PRICE_INTEGER_DIGITS = 14;

export class ProductPriceValidationError extends Error {
  constructor(message = 'Price must be a non-negative amount with up to 2 decimal places') {
    super(message);
    this.name = 'ProductPriceValidationError';
  }
}

export function normalizeProductPrice(value) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return null;
  }

  const raw = String(value).trim();
  if (!PRODUCT_PRICE_PATTERN.test(raw)) {
    throw new ProductPriceValidationError();
  }

  const [rawInteger, rawFraction = ''] = raw.split('.');
  const integer = rawInteger.replace(/^0+(?=\d)/, '');
  if (integer.length > MAX_PRODUCT_PRICE_INTEGER_DIGITS) {
    throw new ProductPriceValidationError('Price exceeds the supported maximum amount');
  }

  return `${integer}.${rawFraction.padEnd(2, '0')}`;
}
