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

  const result = Number(negative ? -cents : cents);

  // The arithmetic above is exact BigInt; this is where it stops being exact.
  // 90071992547409.93 is 9007199254740993 cents, which Number rounds to
  // 9007199254740992 — a different amount, silently. assertAmountCents does
  // reject it downstream, so nothing wrong is stored, but the caller gets a
  // money-layer error about an amount they did not send rather than a
  // straight answer about the one they did.
  //
  // decimalToPpm has carried this check since it was written. This is the
  // same hazard in the older half of the same file.
  if (!Number.isSafeInteger(result)) {
    throw new Error(
      `[money] ${text} is more cents than a JS number can hold exactly ` +
        `(${negative ? '-' : ''}${cents})`
    );
  }

  return result;
};

/** Cents back to a fixed 2-decimal string, for the columns still holding decimal. */
export const centsToDecimal = (cents) => {
  if (cents === null || cents === undefined) return null;
  const negative = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  return `${negative ? '-' : ''}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};

// FX rates are stored as parts per million: 130.25 KES per USD is 130_250_000.
// An integer for the same reason amounts are — the rate is multiplied by money,
// and a float rate puts rounding error into a ledger entry that has to balance.
const PPM_SCALE = 6;

/**
 * Exact decimal-string rate to parts per million.
 *
 * Digits are parsed rather than multiplied through a float, for the reason
 * decimalToCents documents: `parseFloat('130.25') * 1e6` is not reliably an
 * integer, and the error only shows on the one rate where it matters.
 *
 * Rates are positive by definition — fx_rates carries a CHECK to that effect —
 * so a leading minus is rejected rather than carried through.
 */
export const decimalToPpm = (value) => {
  if (value === null || value === undefined) return null;

  const text = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error(
      `[money] not a positive decimal rate: ${JSON.stringify(value)}`
    );
  }

  const [whole, fraction = ''] = text.split('.');
  // Pad one past the scale so the seventh decimal rounds rather than truncates.
  const padded = fraction.padEnd(PPM_SCALE + 1, '0');
  const ppm =
    BigInt(whole) * 1_000_000n +
    BigInt(padded.slice(0, PPM_SCALE)) +
    (Number(padded[PPM_SCALE]) >= 5 ? 1n : 0n);

  if (ppm <= 0n) {
    throw new Error(`[money] rate rounds to zero: ${JSON.stringify(value)}`);
  }

  const asNumber = Number(ppm);
  // rate_ppm is bigint in Postgres but mapped as a number, so a rate past the
  // safe-integer range would be stored already rounded and every conversion
  // using it would be quietly wrong. Refused at the boundary instead.
  if (!Number.isSafeInteger(asNumber)) {
    throw new Error(
      `[money] rate ${text} exceeds the safe integer range in parts per million`
    );
  }

  return asNumber;
};

/** Parts per million back to a trimmed decimal string, for display. */
export const ppmToDecimal = (ppm) => {
  if (ppm === null || ppm === undefined) return null;
  const whole = Math.trunc(ppm / 1_000_000);
  const fraction = String(Math.abs(ppm) % 1_000_000).padStart(PPM_SCALE, '0');
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}` : String(whole);
};
