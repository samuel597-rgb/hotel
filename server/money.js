// Money values are stored and calculated as integer minor units (KES cents).
export function toCents(value) {
  const text=String(value ?? '').trim();
  const match=/^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new TypeError('Enter a valid amount.');
  const fraction=(match[3] || '').padEnd(3,'0');
  const firstTwo=Number(fraction.slice(0,2));
  const roundUp=Number(fraction[2] || 0)>=5 ? 1 : 0;
  const cents=BigInt(match[2])*100n+BigInt(firstTwo+roundUp);
  const signed=match[1] ? -cents : cents;
  if (signed>BigInt(Number.MAX_SAFE_INTEGER)||signed<BigInt(Number.MIN_SAFE_INTEGER)) throw new RangeError('Amount is too large.');
  return Number(signed);
}

export const fromCents = cents => {
  const value=Number(cents);
  if (!Number.isSafeInteger(value)) throw new TypeError('Invalid cents value.');
  const sign=value<0?'-':'';
  const absolute=Math.abs(value);
  return `${sign}${Math.floor(absolute/100)}.${String(absolute%100).padStart(2,'0')}`;
};

export const formatKes = cents => `KES ${fromCents(cents)}`;
export const roundHalfUp = (numerator, denominator) => {
  const n = BigInt(numerator);
  const d = BigInt(denominator);
  if (d <= 0n) throw new RangeError('Denominator must be positive.');
  const rounded = (n * 2n + d) / (d * 2n);
  const value = Number(rounded);
  if (!Number.isSafeInteger(value)) throw new RangeError('Calculated amount is too large.');
  return value;
};

export function computeTotals({subtotalCents,taxRate=0,taxMode='included',tipCents=0,deliveryFeeCents=0}) {
  for(const [name,value] of Object.entries({subtotalCents,tipCents,deliveryFeeCents}))if(!Number.isSafeInteger(Number(value)))throw new TypeError(`${name} must be an integer.`);
  if(!Number.isFinite(Number(taxRate))||subtotalCents<0||tipCents<0||deliveryFeeCents<0||taxRate<0||taxRate>100)throw new RangeError('Order totals are outside the allowed range.');
  const rateBps=Math.round(taxRate*100);
  const taxCents=taxMode==='included'?roundHalfUp(BigInt(subtotalCents)*BigInt(rateBps),BigInt(10000+rateBps)):roundHalfUp(BigInt(subtotalCents)*BigInt(rateBps),10000n);
  const totalCents=subtotalCents+(taxMode==='excluded'?taxCents:0)+tipCents+deliveryFeeCents;
  if(!Number.isSafeInteger(totalCents))throw new RangeError('Order amount is too large.');
  return {subtotalCents,taxCents,tipCents,deliveryFeeCents,totalCents,taxMode:taxMode==='excluded'?'excluded':'included',taxRate};
}
