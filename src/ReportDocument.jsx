import React from 'react';
import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';

const C = {
  ink:    '#0f172a',
  body:   '#1e293b',
  muted:  '#64748b',
  faint:  '#94a3b8',
  line:   '#e2e8f0',
  track:  '#eef2f7',
  accent: '#6366f1',
  good:   '#10b981',
  bad:    '#ef4444',
  headBg: '#f1f5f9',
};

const styles = StyleSheet.create({
  page: { paddingTop: 40, paddingBottom: 48, paddingHorizontal: 40, fontSize: 10, fontFamily: 'Helvetica', color: C.body },

  header:   { marginBottom: 20, borderBottomWidth: 2, borderBottomColor: C.accent, paddingBottom: 10 },
  title:    { fontSize: 20, fontFamily: 'Helvetica-Bold', color: C.ink },
  subtitle: { fontSize: 9, color: C.muted, marginTop: 4 },

  section:      { marginBottom: 18 },
  sectionTitle: { fontSize: 10, fontFamily: 'Helvetica-Bold', color: '#334155', marginBottom: 8, letterSpacing: 1 },

  statsRow:   { flexDirection: 'row' },
  statCard:   { width: '25%', paddingRight: 10 },
  statLabel:  { fontSize: 7, color: C.faint, letterSpacing: 0.5 },
  statValue:  { fontSize: 15, fontFamily: 'Helvetica-Bold', marginTop: 3, color: C.ink },
  statSub:    { fontSize: 7, color: C.muted, marginTop: 2 },

  tableHead:  { flexDirection: 'row', backgroundColor: C.headBg, paddingVertical: 5, paddingHorizontal: 4, borderRadius: 2 },
  row:        { flexDirection: 'row', paddingVertical: 5, paddingHorizontal: 4, borderBottomWidth: 0.5, borderBottomColor: C.line, alignItems: 'center' },
  th:         { fontSize: 7, fontFamily: 'Helvetica-Bold', color: '#475569', letterSpacing: 0.5 },
  td:         { fontSize: 9, color: C.body },
  tdBold:     { fontSize: 9, fontFamily: 'Helvetica-Bold', color: C.ink },
  num:        { textAlign: 'right' },

  barTrack: { height: 4, backgroundColor: C.track, borderRadius: 2, marginTop: 3 },
  barFill:  { height: 4, borderRadius: 2 },

  footer: {
    position: 'absolute', bottom: 22, left: 40, right: 40,
    flexDirection: 'row', justifyContent: 'space-between',
    fontSize: 7, color: C.faint, borderTopWidth: 0.5, borderTopColor: C.line, paddingTop: 6,
  },
});

const money = (sym, n) => `${sym}${Number(n || 0).toFixed(2)}`;

// Category table column widths
const COL = { name: '30%', budget: '16%', actual: '16%', variance: '16%', pct: '22%' };

function StatCard({ label, value, sub }) {
  return (
    <View style={styles.statCard}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
      {sub ? <Text style={styles.statSub}>{sub}</Text> : null}
    </View>
  );
}

export function ReportDocument({
  monthName = '',
  income = 0,
  expenses = [],
  transactions = [],
  currencySymbol = '$',
  generatedDate = new Date().toLocaleDateString(),
}) {
  const totalActual = expenses.reduce((s, e) => s + (e.actual || 0), 0);
  const totalBudget = expenses.reduce((s, e) => s + (e.budget || 0), 0);
  const variance    = totalBudget - totalActual;
  const savingsRate = income > 0 ? ((income - totalActual) / income) * 100 : 0;

  return (
    <Document title={`Fundient ${monthName} Report`} author="Fundient">
      <Page size="A4" style={styles.page} wrap>

        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>Fundient</Text>
          <Text style={styles.subtitle}>
            {monthName ? `${monthName} · ` : ''}Budget Report · Generated {generatedDate}
          </Text>
        </View>

        {/* Stats */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>SUMMARY</Text>
          <View style={styles.statsRow}>
            <StatCard label="INCOME"      value={money(currencySymbol, income)} />
            <StatCard label="TOTAL SPENT" value={money(currencySymbol, totalActual)} sub={`of ${money(currencySymbol, totalBudget)} budget`} />
            <StatCard label="VARIANCE"    value={money(currencySymbol, variance)} sub={variance >= 0 ? 'Under budget' : 'Over budget'} />
            <StatCard label="SAVINGS RATE" value={`${savingsRate.toFixed(1)}%`} sub={`${money(currencySymbol, income - totalActual)} kept`} />
          </View>
        </View>

        {/* Category breakdown */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>CATEGORIES</Text>
          <View style={styles.tableHead}>
            <Text style={[styles.th, { width: COL.name }]}>CATEGORY</Text>
            <Text style={[styles.th, styles.num, { width: COL.budget }]}>BUDGET</Text>
            <Text style={[styles.th, styles.num, { width: COL.actual }]}>ACTUAL</Text>
            <Text style={[styles.th, styles.num, { width: COL.variance }]}>VARIANCE</Text>
            <Text style={[styles.th, { width: COL.pct, paddingLeft: 8 }]}>USED</Text>
          </View>
          {expenses.map((e, i) => {
            const pct  = e.budget > 0 ? (e.actual / e.budget) * 100 : (e.actual > 0 ? 100 : 0);
            const over = e.remaining < 0;
            return (
              <View key={i} style={styles.row} wrap={false}>
                <Text style={[styles.td, { width: COL.name }]}>{e.name}</Text>
                <Text style={[styles.td, styles.num, { width: COL.budget }]}>{money(currencySymbol, e.budget)}</Text>
                <Text style={[styles.td, styles.num, { width: COL.actual }]}>{money(currencySymbol, e.actual)}</Text>
                <Text style={[styles.td, styles.num, { width: COL.variance, color: over ? C.bad : C.good }]}>
                  {money(currencySymbol, e.remaining)}
                </Text>
                <View style={{ width: COL.pct, paddingLeft: 8 }}>
                  <Text style={styles.td}>{pct.toFixed(0)}%</Text>
                  <View style={styles.barTrack}>
                    <View style={[styles.barFill, { width: `${Math.min(pct, 100)}%`, backgroundColor: over ? C.bad : C.good }]} />
                  </View>
                </View>
              </View>
            );
          })}
          {/* Totals row */}
          <View style={[styles.row, { borderBottomWidth: 0, marginTop: 2 }]} wrap={false}>
            <Text style={[styles.tdBold, { width: COL.name }]}>TOTAL</Text>
            <Text style={[styles.tdBold, styles.num, { width: COL.budget }]}>{money(currencySymbol, totalBudget)}</Text>
            <Text style={[styles.tdBold, styles.num, { width: COL.actual }]}>{money(currencySymbol, totalActual)}</Text>
            <Text style={[styles.tdBold, styles.num, { width: COL.variance, color: variance < 0 ? C.bad : C.good }]}>
              {money(currencySymbol, variance)}
            </Text>
            <Text style={[styles.tdBold, { width: COL.pct, paddingLeft: 8 }]} />
          </View>
        </View>

        {/* Transaction log */}
        {transactions.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>TRANSACTIONS ({transactions.length})</Text>
            <View style={styles.tableHead}>
              <Text style={[styles.th, { width: '18%' }]}>DATE</Text>
              <Text style={[styles.th, { width: '40%' }]}>VENDOR</Text>
              <Text style={[styles.th, { width: '24%' }]}>CATEGORY</Text>
              <Text style={[styles.th, styles.num, { width: '18%' }]}>AMOUNT</Text>
            </View>
            {transactions.map((t, i) => (
              <View key={i} style={styles.row} wrap={false}>
                <Text style={[styles.td, { width: '18%' }]}>{t.date || '—'}</Text>
                <Text style={[styles.td, { width: '40%' }]}>{t.vendor || '—'}</Text>
                <Text style={[styles.td, { width: '24%' }]}>{t.category || '—'}</Text>
                <Text style={[styles.td, styles.num, { width: '18%' }]}>{money(currencySymbol, t.amount)}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Footer with page numbers */}
        <View style={styles.footer} fixed>
          <Text>Fundient Budget Report</Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
