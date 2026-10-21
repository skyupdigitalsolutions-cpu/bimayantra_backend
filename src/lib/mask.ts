// GR-31 / GR-36 masking. Mobile 98XXXXXX21, PAN ABCXX1234X, Aadhaar XXXX XXXX 1234.

/** Accepts +91XXXXXXXXXX or 10 digits. */
export function maskMobile(mobile: string): string {
  const d = mobile.replace(/\D/g, '').slice(-10);
  if (d.length !== 10) return 'XXXXXXXXXX';
  return `${d.slice(0, 2)}XXXXXX${d.slice(-2)}`;
}

export function maskPan(pan: string): string {
  const p = pan.toUpperCase();
  if (p.length !== 10) return 'XXXXXXXXXX';
  return `${p.slice(0, 3)}XX${p.slice(5, 9)}${p.slice(9)}`;
}

export function maskAadhaar(aadhaar: string): string {
  const d = aadhaar.replace(/\D/g, '');
  return `XXXX XXXX ${d.slice(-4).padStart(4, 'X')}`;
}
