import { describe, expect, it } from 'vitest';
import { parseCsv, toCsv } from '../src/shared/import/csv';
import { parseOfx } from '../src/shared/import/ofx';
import { applyMapping, detectPreset, parseDateFlexible } from '../src/shared/import/presets';
import { api } from './helpers/api';
import { TestD1 } from './helpers/d1';
import { testEnv } from './helpers/plaid';

describe('csv', () => {
  it('handles quotes, embedded commas and newlines, and a BOM', () => {
    const text = '﻿a,b,c\r\n"1,000","say ""hi""","line\nbreak"\r\n\r\n';
    expect(parseCsv(text)).toEqual([
      ['a', 'b', 'c'],
      ['1,000', 'say "hi"', 'line\nbreak'],
    ]);
  });

  it('round-trips through toCsv', () => {
    const rows = [['Date', 'Note'], ['2026-09-01', 'Kids, school "stuff"']];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });

  it('parses common date formats', () => {
    expect(parseDateFlexible('2026-09-04')).toBe('2026-09-04');
    expect(parseDateFlexible('09/04/2026')).toBe('2026-09-04');
    expect(parseDateFlexible('9/4/26')).toBe('2026-09-04');
    expect(parseDateFlexible('02/30/2026')).toBeNull();
    expect(parseDateFlexible('Total')).toBeNull();
  });
});

describe('bank presets', () => {
  it('reads a Capital One card export (debits are purchases)', () => {
    const rows = parseCsv(
      'Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit\n' +
        '2026-09-02,2026-09-03,1234,KROGER #512,Groceries,168.42,\n' +
        '2026-09-10,2026-09-10,1234,CAPITAL ONE MOBILE PYMT,Payment/Credit,,250.00\n',
    );
    const detected = detectPreset(rows);
    expect(detected?.preset.id).toBe('capital-one-card');
    const { rows: parsed, skipped } = applyMapping(rows, detected!.mapping);
    expect(skipped).toEqual([]);
    expect(parsed).toEqual([
      { date: '2026-09-02', name: 'KROGER #512', amountCents: -16842 },
      { date: '2026-09-10', name: 'CAPITAL ONE MOBILE PYMT', amountCents: 25000 },
    ]);
  });

  it('reads a Capital One 360 export (type column sets the sign)', () => {
    const rows = parseCsv(
      'Account Number,Transaction Description,Transaction Date,Transaction Type,Transaction Amount,Balance\n' +
        '3456,Withdrawal to Chime,09/03/26,Debit,100.00,900.00\n' +
        '3456,Interest Paid,09/30/26,Credit,0.41,900.41\n',
    );
    const detected = detectPreset(rows);
    expect(detected?.preset.id).toBe('capital-one-bank');
    expect(applyMapping(rows, detected!.mapping).rows.map((r) => r.amountCents)).toEqual([-10000, 41]);
  });

  it('reads a Fidelity history export with preamble and disclaimer', () => {
    const text = [
      '',
      'Brokerage',
      '',
      'Run Date,Action,Symbol,Description,Type,Quantity,Price ($),Commission ($),Fees ($),Accrued Interest ($),Amount ($),Settlement Date',
      '09/04/2026,"DIRECT DEPOSIT ACME PAYROLL (Cash)",,No Description,Cash,0.000,,,,,1935.00,',
      '09/05/2026,"REDEMPTION FROM CORE ACCOUNT FIDELITY GOVERNMENT MONEY MARKET (SPAXX) (Cash)",SPAXX,FIDELITY GOVERNMENT MONEY MARKET,Cash,-50,1,,,,50.00,',
      '09/05/2026,"DEBIT CARD PURCHASE SHELL OIL 57444 (Cash)",,No Description,Cash,0.000,,,,,-50.00,',
      '',
      '"The data and information in this spreadsheet is provided to you solely for your use."',
    ].join('\n');
    const rows = parseCsv(text);
    const detected = detectPreset(rows);
    expect(detected?.preset.id).toBe('fidelity');
    const parsed = applyMapping(rows, detected!.mapping).rows;
    expect(parsed.map((r) => [r.date, r.amountCents])).toEqual([
      ['2026-09-04', 193500],
      ['2026-09-05', 5000],
      ['2026-09-05', -5000],
    ]);
    expect(parsed[2]?.name).toBe('DEBIT CARD PURCHASE SHELL OIL 57444 (Cash)');
  });

  it('falls back to a generic Date/Description/Amount layout', () => {
    const rows = parseCsv('Date,Description,Amount\n09/01/2026,Target,-54.10\n');
    expect(detectPreset(rows)?.preset.id).toBe('generic');
  });
});

describe('ofx', () => {
  it('parses SGML OFX with unclosed tags', () => {
    const text = `OFXHEADER:100
DATA:OFXSGML
<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD
<BANKACCTFROM><BANKID>123<ACCTID>000123456789<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260902120000[-5:EST]<TRNAMT>-168.42<FITID>2026090201<NAME>KROGER #512<MEMO>POS PURCHASE
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260904<TRNAMT>1935.00<FITID>2026090401<NAME>ACME PAYROLL &amp; CO
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    const [statement] = parseOfx(text);
    expect(statement?.kind).toBe('bank');
    expect(statement?.mask).toBe('6789');
    expect(statement?.transactions).toEqual([
      { fitId: '2026090201', date: '2026-09-02', amountCents: -16842, name: 'KROGER #512', memo: 'POS PURCHASE', type: 'DEBIT' },
      { fitId: '2026090401', date: '2026-09-04', amountCents: 193500, name: 'ACME PAYROLL & CO', type: 'CREDIT' },
    ]);
  });

  it('detects credit card statements in XML OFX', () => {
    const text = `<?xml version="1.0"?><OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS>
<CCACCTFROM><ACCTID>4111111111111111</ACCTID></CCACCTFROM><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260901</DTPOSTED><TRNAMT>-20.00</TRNAMT><FITID>A1</FITID><NAME>SHELL</NAME></STMTTRN>
</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;
    const [statement] = parseOfx(text);
    expect(statement?.kind).toBe('credit');
    expect(statement?.mask).toBe('1111');
    expect(statement?.transactions[0]).toMatchObject({ fitId: 'A1', amountCents: -2000, name: 'SHELL' });
  });
});

describe('imported rows are categorized', () => {
  it('files a small Shell charge under Habits and a large one under Gas, with reasons', async () => {
    const db = new TestD1();
    const env = testEnv(db);
    db.exec(`INSERT INTO accounts (id, name, type) VALUES (1, 'Checking', 'checking')`);
    const post = async (path: string, body: unknown) => {
      const response = await api(env, 'POST', path, body);
      expect(response.status).toBeLessThan(300);
      return response.json() as Promise<Record<string, number>>;
    };
    const { id } = await post('/import/batches', { accountId: 1, format: 'csv' });
    await post(`/import/batches/${id}/rows`, {
      rows: [
        { date: '2026-10-01', amountCents: -641, name: 'SHELL OIL 57444' },
        { date: '2026-10-02', amountCents: -4800, name: 'SHELL OIL 57444' },
        { date: '2026-10-03', amountCents: -1200, name: 'SOMETHING ELSE' },
      ],
    });

    expect(
      db.rows(
        `SELECT t.amount_cents AS cents, s.name AS section, c.name AS category, t.category_source AS source, t.category_reason AS reason
           FROM transactions t LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN sections s ON s.id = c.section_id ORDER BY t.date`,
      ),
    ).toEqual([
      { cents: -641, section: 'Habits', category: 'Habits', source: 'auto', reason: 'Under $25 at a gas station' },
      { cents: -4800, section: 'Everyday', category: 'Gas', source: 'auto', reason: 'Gas station' },
      { cents: -1200, section: null, category: null, source: null, reason: null },
    ]);
  });
});
