import { describe, it, expect } from 'vitest';
import { resolveMCC } from '../vendorMCC.js';

describe('resolveMCC — known vendor matches', () => {
  it('airlines → 4511', () => {
    expect(resolveMCC('Delta Airlines', 'Travel')).toBe('4511');
    expect(resolveMCC('United Airlines', 'Travel')).toBe('4511');
    expect(resolveMCC('Southwest', 'Travel')).toBe('4511');
    expect(resolveMCC('JetBlue', 'Travel')).toBe('4511');
  });

  it('hotels → 7011', () => {
    expect(resolveMCC('Marriott Hotel', 'Holiday')).toBe('7011');
    expect(resolveMCC('Hilton Garden Inn', 'Holiday')).toBe('7011');
    expect(resolveMCC('Airbnb', 'Travel')).toBe('7011');
  });

  it('Chase Travel portal → CHASE_PORTAL', () => {
    expect(resolveMCC('Chase Travel', 'Travel')).toBe('CHASE_PORTAL');
    expect(resolveMCC('Chase Travel Portal', 'Travel')).toBe('CHASE_PORTAL');
  });

  it('US supermarkets → 5411', () => {
    expect(resolveMCC('Safeway', 'Grocery')).toBe('5411');
    expect(resolveMCC("Trader Joe's", 'Grocery')).toBe('5411');
    expect(resolveMCC('Whole Foods Market', 'Grocery')).toBe('5411');
    expect(resolveMCC('Kroger', 'Grocery')).toBe('5411');
  });

  it('wholesale / superstores → 5300 / 5310 (Amex excluded)', () => {
    expect(resolveMCC('Costco Wholesale', 'Grocery')).toBe('5300');
    expect(resolveMCC("Sam's Club", 'Grocery')).toBe('5300');
    expect(resolveMCC('Walmart Supercenter', 'Grocery')).toBe('5310');
    expect(resolveMCC('Target', 'Grocery')).toBe('5310');
  });

  it('streaming services → 7372', () => {
    expect(resolveMCC('Netflix', 'Entertainment')).toBe('7372');
    expect(resolveMCC('Spotify', 'Wi-Fi')).toBe('7372');
    expect(resolveMCC('Hulu', 'Entertainment')).toBe('7372');
    expect(resolveMCC('Disney+', 'Entertainment')).toBe('7372');
    expect(resolveMCC('HBO Max', 'Entertainment')).toBe('7372');
    expect(resolveMCC('Amazon Prime Video', 'Entertainment')).toBe('7372');
  });

  it('gas stations → 5541', () => {
    expect(resolveMCC('Shell Gas Station', 'Travel')).toBe('5541');
    expect(resolveMCC('Chevron', 'Misc')).toBe('5541');
    expect(resolveMCC('BP', 'Misc')).toBe('5541');
  });

  it('Uber Eats → 5812 (food delivery, not rideshare)', () => {
    expect(resolveMCC('Uber Eats', 'Eating Out')).toBe('5812');
    expect(resolveMCC('DoorDash', 'Eating Out')).toBe('5812');
    expect(resolveMCC('Grubhub', 'Eating Out')).toBe('5812');
  });

  it('Uber ride → 4121 (rideshare, Amex 3%)', () => {
    expect(resolveMCC('Uber', 'Travel')).toBe('4121');
    expect(resolveMCC('Lyft', 'Travel')).toBe('4121');
  });

  it('pharmacies → 5912', () => {
    expect(resolveMCC('CVS Pharmacy', 'Health')).toBe('5912');
    expect(resolveMCC('Walgreens', 'Health')).toBe('5912');
  });

  it('restaurants → 5812 / 5814', () => {
    expect(resolveMCC('Starbucks', 'Eating Out')).toBe('5812');
    expect(resolveMCC('Chipotle Mexican Grill', 'Eating Out')).toBe('5812');
    expect(resolveMCC("McDonald's", 'Eating Out')).toBe('5814');
    expect(resolveMCC('Subway', 'Eating Out')).toBe('5814');
  });
});

describe('resolveMCC — category fallbacks for unknown vendors', () => {
  it('Eating Out → 5812', () => {
    expect(resolveMCC('', 'Eating Out')).toBe('5812');
    expect(resolveMCC('Random Restaurant', 'Eating Out')).toBe('5812');
  });

  it('Grocery → 5411 (unknown vendor defaults to supermarket)', () => {
    expect(resolveMCC('', 'Grocery')).toBe('5411');
    expect(resolveMCC('Local Grocer', 'Grocery')).toBe('5411');
  });

  it('Travel → 4511', () => {
    expect(resolveMCC('', 'Travel')).toBe('4511');
  });

  it('Holiday → 7011', () => {
    expect(resolveMCC('', 'Holiday')).toBe('7011');
  });

  it('Health → 5912', () => {
    expect(resolveMCC('', 'Health')).toBe('5912');
  });

  it('Entertainment → 7996 (NOT streaming)', () => {
    expect(resolveMCC('', 'Entertainment')).toBe('7996');
    expect(resolveMCC('Unknown Entertainment Co', 'Entertainment')).toBe('7996');
  });

  it('Wi-Fi → 4814 (telecom, NOT streaming)', () => {
    expect(resolveMCC('Comcast', 'Wi-Fi')).toBe('4814');
    expect(resolveMCC('', 'Wi-Fi')).toBe('4814');
  });

  it('Thakkali → 5999 (general personal spend)', () => {
    expect(resolveMCC('', 'Thakkali')).toBe('5999');
  });

  it('Rent → 6513', () => {
    expect(resolveMCC('', 'Rent')).toBe('6513');
  });

  it('unknown category → 5999', () => {
    expect(resolveMCC('', 'SomethingUnknown')).toBe('5999');
    expect(resolveMCC('', '')).toBe('5999');
  });
});
