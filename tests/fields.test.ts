// Section 2A: every field format rule (FLD-01 … FLD-37) with its exact VAL message ID (NFR-13).
import { describe, expect, it } from 'vitest';
import * as F from '../src/lib/fields.js';
import { istToday, addDays, formatDate } from '../src/lib/clock.js';
import { verhoeffDigit } from '../src/lib/verhoeff.js';
import { render } from '../src/messages/messages.js';

const v = (r: F.RuleResult<unknown>) => (r.ok ? r.value : `ERR ${r.code}`);

describe('FLD rules', () => {
  it('FLD-01 mobile', () => {
    expect(v(F.mobile('98450 12345'))).toBe('+919845012345');
    expect(v(F.mobile('(984) 501-2345'))).toBe('+919845012345');
    expect(v(F.mobile('+91 98450 12345'))).toBe('+919845012345');
    expect(v(F.mobile('919845012345'))).toBe('+919845012345');
    expect(v(F.mobile('09845012345'))).toBe('+919845012345');
    expect(v(F.mobile('6000000000'))).toBe('+916000000000');
    expect(v(F.mobile('5845012345'))).toBe('ERR VAL-01');
    expect(v(F.mobile('984501234'))).toBe('ERR VAL-01');
    expect(v(F.mobile('98450123456'))).toBe('ERR VAL-01');
  });
  it('FLD-02 person name', () => {
    expect(v(F.personName('  Asha   Rao  '))).toBe('Asha Rao');
    expect(v(F.personName("D'Souza-Pai K."))).toBe("D'Souza-Pai K.");
    expect(v(F.personName('ಮಂಜುನಾಥ್'))).toBe('ಮಂಜುನಾಥ್');
    expect(v(F.personName('A'))).toBe('ERR VAL-02');
    expect(v(F.personName('.Asha'))).toBe('ERR VAL-02');
    expect(v(F.personName('Asha2'))).toBe('ERR VAL-02');
    expect(v(F.personName('Asha 😀'))).toBe('ERR VAL-02');
    expect(v(F.personName('A'.repeat(101)))).toBe('ERR VAL-02');
    expect(render('VAL-02')).toContain('2 to 100 characters');
  });
  it('FLD-03 email', () => {
    expect(v(F.email(' Asha@Example.COM '))).toBe('asha@example.com');
    expect(v(F.email('a@b.c'))).toBe('ERR VAL-03');
    expect(v(F.email('a b@x.com'))).toBe('ERR VAL-03');
    expect(v(F.email('a@@x.com'))).toBe('ERR VAL-03');
    expect(v(F.email(`${'a'.repeat(65)}@x.com`))).toBe('ERR VAL-03');
  });
  it('FLD-04 date', () => {
    expect(v(F.date('29-02-2024'))).toBe('2024-02-29');
    expect(v(F.date('2024-02-29'))).toBe('2024-02-29');
    expect(v(F.date('29-02-2023'))).toBe('ERR VAL-04');
    expect(v(F.date('2024/02/01'))).toBe('ERR VAL-04');
  });
  it('FLD-05 date of birth', () => {
    const today = istToday();
    expect(v(F.dateOfBirth(formatDate(addDays(today, 1))))).toBe('ERR VAL-05');
    expect(v(F.dateOfBirth('01-01-1890'))).toBe('ERR VAL-06');
    expect(v(F.dateOfBirth('15-08-1990'))).toBe('1990-08-15');
  });
  it('FLD-06 future date, FLD-32 past or today, FLD-07 range', () => {
    const today = istToday();
    expect(v(F.futureDate(today))).toBe(today);
    expect(v(F.futureDate(addDays(today, -1)))).toBe('ERR VAL-07');
    expect(v(F.pastOrToday(today))).toBe(today);
    expect(v(F.pastOrToday(addDays(today, 1)))).toBe('ERR VAL-35');
    expect(v(F.dateRange('2026-01-02', '2026-01-01'))).toBe('ERR VAL-08');
    expect(v(F.dateRange('2026-01-01', '2026-01-01'))).toBe(true);
  });
  it('FLD-08 amount (exact, Indian commas, > 0 unless allowed, ≤ CFG-16)', () => {
    expect(v(F.amount()('12,500.5'))).toBe('12500.50');
    expect(v(F.amount()('1,23,45,678.00'))).toBe('12345678.00');
    expect(v(F.amount()('12500'))).toBe('12500.00');
    expect(v(F.amount()('12,50,0'))).toBe('ERR VAL-09');
    expect(v(F.amount()('1.234'))).toBe('ERR VAL-09');
    expect(v(F.amount()('0'))).toBe('ERR VAL-10');
    expect(v(F.amount({ allowZero: true })('0'))).toBe('0.00');
    expect(v(F.amount()('10000000000.00'))).toBe('ERR VAL-10');
    expect(v(F.amount()('9999999999.99'))).toBe('9999999999.99');
    const r = F.amount()('0');
    expect(!r.ok && render(r.code, r.params)).toBe('Amount must be between ₹0.01 and ₹9,99,99,99,999.99.');
  });
  it('FLD-09 percentage, FLD-10 whole number', () => {
    expect(v(F.percentage('100'))).toBe('100.00');
    expect(v(F.percentage('12.5'))).toBe('12.50');
    expect(v(F.percentage('100.01'))).toBe('ERR VAL-11');
    expect(v(F.wholeNumber(18, 99)('30'))).toBe(30);
    expect(v(F.wholeNumber(18, 99)('17'))).toBe('ERR VAL-12');
    expect(v(F.wholeNumber(18, 99)('3.5'))).toBe('ERR VAL-12');
  });
  it('FLD-11 address, FLD-12 city, FLD-13 state, FLD-14 PIN', () => {
    expect(v(F.addressLine('#12, 3rd Cross (Near Park) / Lane-2'))).toBe('#12, 3rd Cross (Near Park) / Lane-2');
    expect(v(F.addressLine('ab'))).toBe('ERR VAL-13');
    expect(v(F.addressLine('Flat @ 5'))).toBe('ERR VAL-13');
    expect(v(F.city('Bengaluru'))).toBe('Bengaluru');
    expect(v(F.city('B1'))).toBe('ERR VAL-14');
    expect(v(F.indianState('Karnataka'))).toBe('Karnataka');
    expect(v(F.indianState('Bangalore'))).toBe('ERR VAL-22');
    expect(F.INDIAN_STATES).toHaveLength(36);
    expect(v(F.pinCode('577501'))).toBe('577501');
    expect(v(F.pinCode('077501'))).toBe('ERR VAL-15');
  });
  it('FLD-15 PAN (individual), FLD-16/17/19/25 numbers, FLD-28 code, FLD-31 UIN', () => {
    expect(v(F.pan('abcpe1234f'))).toBe('ABCPE1234F');
    expect(v(F.pan('ABCCE1234F'))).toBe('ERR VAL-16');
    expect(v(F.licenceNumber('posp/ka-123'))).toBe('POSP/KA-123');
    expect(v(F.licenceNumber('AB'))).toBe('ERR VAL-17');
    expect(v(F.agentCode('AG 12'))).toBe('ERR VAL-18');
    expect(v(F.policyNumber('12/3456/7890'))).toBe('12/3456/7890');
    expect(v(F.policyNumber('P#1'))).toBe('ERR VAL-20');
    expect(v(F.transactionRef('rcpt-0099'))).toBe('RCPT-0099');
    expect(v(F.transactionRef('R1'))).toBe('ERR VAL-30');
    expect(v(F.code('hdfc-ergo'))).toBe('HDFC-ERGO');
    expect(v(F.code('HDFC/ERGO'))).toBe('ERR VAL-33');
    expect(v(F.productUin('hdfhlip23001v022223'))).toBe('HDFHLIP23001V022223');
    expect(v(F.productUin('HDF HLI'))).toBe('ERR VAL-37');
  });
  it('FLD-18 OTP, FLD-21 notes, FLD-23 URL, FLD-26 referral code, FLD-27 time, FLD-29 short text', () => {
    expect(v(F.otp('012345'))).toBe('012345');
    expect(v(F.otp('12345a'))).toBe('ERR VAL-19');
    expect(v(F.notes('x'.repeat(1000)))).toHaveLength(1000);
    expect(v(F.notes('x'.repeat(1001)))).toBe('ERR VAL-21');
    expect(v(F.url('https://bimayantra.in/a?b=1'))).toBe('https://bimayantra.in/a?b=1');
    expect(v(F.url('http://bimayantra.in'))).toBe('ERR VAL-28');
    expect(v(F.url('https://a b.in'))).toBe('ERR VAL-28');
    expect(v(F.referralCode('k7mx4qpa'))).toBe('K7MX4QPA');
    expect(v(F.referralCode('K7MX4QP0'))).toBe('ERR VAL-31');
    expect(v(F.referralCode('K7MX4QPI'))).toBe('ERR VAL-31');
    expect(v(F.timeOfDay('10:30 am'))).toBe('10:30');
    expect(v(F.timeOfDay('12:05 AM'))).toBe('00:05');
    expect(v(F.timeOfDay('12:05 PM'))).toBe('12:05');
    expect(v(F.timeOfDay('22:30'))).toBe('22:30');
    expect(v(F.timeOfDay('13:00 PM'))).toBe('ERR VAL-32');
    expect(v(F.shortText('  Not   interested  '))).toBe('Not interested');
    expect(v(F.shortText('x'))).toBe('ERR VAL-34');
  });
  it('FLD-30 phone: toll-free, landline, mobile', () => {
    expect(v(F.phone('1800 123 4567'))).toBe('18001234567');
    expect(v(F.phone('080 2345 6789'))).toBe('08023456789');
    expect(v(F.phone('98450 12345'))).toBe('+919845012345');
    expect(v(F.phone('12345'))).toBe('ERR VAL-36');
  });
  it('FLD-33 Aadhaar, FLD-34 GSTIN, FLD-35 vehicle, FLD-36 cheque, FLD-37 document label', () => {
    const base = '49876543210';
    const good = base + String(verhoeffDigit(base));
    expect(v(F.aadhaar(`${good.slice(0, 4)} ${good.slice(4, 8)} ${good.slice(8)}`))).toBe(good);
    expect(v(F.aadhaar(base + String((verhoeffDigit(base) + 3) % 10)))).toBe('ERR VAL-38');
    expect(v(F.aadhaar('1' + good.slice(1)))).toBe('ERR VAL-38');
    expect(v(F.gstin('29abcde1234f1z5'))).toBe('29ABCDE1234F1Z5');
    expect(v(F.gstin('29ABCDE1234F1Y5'))).toBe('ERR VAL-39');
    expect(v(F.vehicleRegistration('ka-01 ab 1234'))).toBe('KA01AB1234');
    expect(v(F.vehicleRegistration('22 BH 1234 AA'))).toBe('22BH1234AA');
    expect(v(F.vehicleRegistration('KA01ABCD1234'))).toBe('ERR VAL-40');
    expect(v(F.chequeNumber('012345'))).toBe('012345');
    expect(v(F.chequeNumber('12345'))).toBe('ERR VAL-41');
    expect(v(F.documentLabel('Aadhaar (front) - 2026'))).toBe('Aadhaar (front) - 2026');
    expect(v(F.documentLabel('Bad <label>'))).toBe('ERR VAL-42');
  });
});

describe('parseFields (GR-01, GR-03, GR-06)', () => {
  it('collects every error at once; required → GEN-01 with the label; choices → VAL-22; checkbox → VAL-29', () => {
    try {
      F.parseFields({ name: ' ', state: 'Nowhere', agree: false }, {
        name: { label: 'Full name', required: true, rule: F.personName },
        state: { label: 'State', required: true, oneOf: F.INDIAN_STATES },
        agree: { label: 'Declaration', checkbox: true },
        gstin: { label: 'GSTIN', rule: F.gstin },
      });
      throw new Error('should fail');
    } catch (e) {
      const err = e as { status: number; code: string; fields: { field: string; code: string }[] };
      expect(err.status).toBe(422);
      expect(err.code).toBe('GEN-02');
      expect(err.fields.map((f) => `${f.field}:${f.code}`)).toEqual(['name:GEN-01', 'state:VAL-22', 'agree:VAL-29']);
    }
  });
  it('returns cleaned values; an empty optional field is undefined', () => {
    const out = F.parseFields({ name: '  asha   rao ', gstin: '' }, { name: { label: 'Full name', required: true, rule: F.personName }, gstin: { label: 'GSTIN', rule: F.gstin } });
    expect(out).toEqual({ name: 'asha rao', gstin: undefined });
  });
});
