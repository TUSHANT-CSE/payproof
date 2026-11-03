/** Money is integer paise everywhere inside PayProof. Parsing is explicit. */

export function parseRupeesToPaise(input: number | string): number | null {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input <= 0) return null;
    const exact = input * 100;
    // Rupee amounts have at most two decimals; refuse silent rounding.
    if (Math.abs(exact - Math.round(exact)) > 1e-6) return null;
    const paise = Math.round(exact);
    return Number.isSafeInteger(paise) ? paise : null;
  }
  const cleaned = input.replace(/[₹,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ''] = cleaned.split('.');
  const paise = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return Number.isSafeInteger(paise) && paise > 0 ? paise : null;
}

export function formatRupees(paise: number): string {
  return (paise / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export { formatRupees as fmtINR };
