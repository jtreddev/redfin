import { describe, expect, it } from 'vitest';
import { TestD1 } from './helpers/d1';

describe('migration 0011', () => {
  it('estimates a $0 minimum left by the old debt form or a bank that gave none', () => {
    const db = new TestD1({ upTo: '0010' });
    db.exec("INSERT INTO debts (name, balance_cents, min_payment_cents) VALUES ('No minimum', 100000, 0), ('Typed', 100000, 4000), ('Paid off', 0, 0)");
    db.migrate('0011');
    expect(db.rows('SELECT name, min_estimated FROM debts ORDER BY id')).toEqual([
      { name: 'No minimum', min_estimated: 1 },
      { name: 'Typed', min_estimated: 0 },
      { name: 'Paid off', min_estimated: 0 },
    ]);
  });
});
