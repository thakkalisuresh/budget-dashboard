import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToBuffer } from '@react-pdf/renderer';
import { ReportDocument } from '../ReportDocument.jsx';

const expenses = [
  { name: 'Grocery',    actual: 320, budget: 400, remaining: 80 },
  { name: 'Eating Out', actual: 210, budget: 150, remaining: -60 },
  { name: 'Rent',       actual: 1200, budget: 1200, remaining: 0 },
];

const transactions = [
  { date: 'May 3',  vendor: 'Whole Foods', category: 'Grocery',    amount: 84.21 },
  { date: 'May 5',  vendor: 'Chipotle',    category: 'Eating Out', amount: 12.50 },
];

describe('ReportDocument', () => {
  it('renders a valid PDF buffer', async () => {
    const buffer = await renderToBuffer(
      <ReportDocument
        monthName="May 2026"
        income={5000}
        expenses={expenses}
        transactions={transactions}
        currencySymbol="$"
        generatedDate="2026-05-28"
      />
    );
    // PDF files start with the "%PDF" magic bytes
    expect(buffer.slice(0, 4).toString()).toBe('%PDF');
    expect(buffer.length).toBeGreaterThan(1000);
  }, 20000);

  it('renders with empty data without throwing', async () => {
    const buffer = await renderToBuffer(
      <ReportDocument monthName="" income={0} expenses={[]} transactions={[]} />
    );
    expect(buffer.slice(0, 4).toString()).toBe('%PDF');
  }, 20000);
});
