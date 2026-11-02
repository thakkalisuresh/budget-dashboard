import { describe, it, expect } from 'vitest';
import { parsePct } from '../use503020.js';

describe('parsePct', () => {
  it('reads a % cell as out of 100, including values of 1% or less', () => {
    expect(parsePct('0.58%')).toBeCloseTo(0.0058);
    expect(parsePct('1.00%')).toBeCloseTo(0.01);
    expect(parsePct('38.41%')).toBeCloseTo(0.3841);
    expect(parsePct('0.00%')).toBe(0);
  });

  it('accepts a bare value stored as 50 or as 0.5', () => {
    expect(parsePct('50')).toBeCloseTo(0.5);
    expect(parsePct('0.5')).toBeCloseTo(0.5);
  });

  it('returns 0 for blank or non-numeric cells', () => {
    expect(parsePct(undefined)).toBe(0);
    expect(parsePct('')).toBe(0);
    expect(parsePct('#DIV/0!')).toBe(0);
  });
});
