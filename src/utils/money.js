// src/utils/money.js
//
// Conversion between the decimal(10,2) columns the tour domain still uses and
// the integer cents the money layer speaks.
//
// This is bridge code. When bookings, tours and payments move to integer
// cents, decimalToCents survives only at the API boundary where clients still
// send "4200.00".

/**
 * Exact decimal-string to cents. Parses the digits rather than going through a
 * float: `parseFloat('1.15') * 100` is 114.99999999999999, and Math.round
 * hides that until the one value where it does not.
 *
 * Accepts a string, a number, or Drizzle's decimal (which comes back a string).
 */
export const decimalToCents = (value) => {
  if (value === null || value === undefined) return null;

  const text = String(value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new Error(`[money] not a decimal amount: ${JSON.stringify(value)}`);
  }

  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace('-', '').split('.');
  // Pad to 2 places, then round on the third rather than truncating, so a
  // stray third decimal does not silently lose a cent.
  const cents =
    BigInt(whole) * 100n +
    BigInt(fraction.padEnd(3, '0').slice(0, 2)) +
    (Number(fraction.padEnd(3, '0')[2]) >= 5 ? 1n : 0n);

  return Number(negative ? -cents : cents);
};

/** Cents back to a fixed 2-decimal string, for the columns still holding decimal. */
export const centsToDecimal = (cents) => {
  if (cents === null || cents === undefined) return null;
  const negative = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  return `${negative ? '-' : ''}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};
