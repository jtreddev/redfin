import { diffDays, type ISODate } from './dates';
import type { Cents } from './money';

/**
 * Money moving between your own accounts (Chime → Capital One card payment,
 * Chime ↔ Fidelity) isn't spending or income. Pair an outflow with an equal inflow
 * on another linked account within a few days, but only when one side looks like a
 * transfer, so a $50 ATM withdrawal and an unrelated $50 deposit don't pair up.
 */
export interface TransferCandidate {
  id: number;
  accountId: number;
  date: ISODate;
  amountCents: Cents;
  name: string;
  /** Plaid personal_finance_category.primary, e.g. TRANSFER_OUT or LOAN_PAYMENTS. */
  plaidCategory?: string | null;
}

export interface TransferPair {
  outId: number;
  inId: number;
}

const TRANSFER_HINT =
  /\b(PAYMENT|PYMT|PMT|TRANSFER|XFER|TRNSFR|AUTOPAY|AUTO PAY|ACH|CHIME|FIDELITY|CAPITAL ONE|CAPITALONE|CRCARDPMT|EPAY|DIRECTPAY|CARDMEMBER|MOVED|SAVINGS|SPOTME|ROUND UP|ZELLE TO SELF)\b/i;

export function looksLikeTransfer(candidate: TransferCandidate): boolean {
  return (
    TRANSFER_HINT.test(candidate.name) ||
    /^(TRANSFER_IN|TRANSFER_OUT|LOAN_PAYMENTS)/.test(candidate.plaidCategory ?? '')
  );
}

export function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export function findTransferPairs(
  candidates: readonly TransferCandidate[],
  { windowDays = 3, unlinked = new Set<string>() }: { windowDays?: number; unlinked?: ReadonlySet<string> } = {},
): TransferPair[] {
  const inflowsByAmount = new Map<Cents, TransferCandidate[]>();
  for (const c of candidates) {
    if (c.amountCents <= 0) continue;
    const list = inflowsByAmount.get(c.amountCents) ?? [];
    list.push(c);
    inflowsByAmount.set(c.amountCents, list);
  }

  const options: { out: TransferCandidate; in: TransferCandidate; gap: number }[] = [];
  for (const out of candidates) {
    if (out.amountCents >= 0) continue;
    for (const inflow of inflowsByAmount.get(-out.amountCents) ?? []) {
      if (inflow.accountId === out.accountId) continue;
      const gap = Math.abs(diffDays(inflow.date, out.date));
      if (gap > windowDays) continue;
      if (!looksLikeTransfer(out) && !looksLikeTransfer(inflow)) continue;
      if (unlinked.has(pairKey(out.id, inflow.id))) continue;
      options.push({ out, in: inflow, gap });
    }
  }

  options.sort(
    (a, b) => a.gap - b.gap || Math.min(a.out.id, a.in.id) - Math.min(b.out.id, b.in.id) || a.in.id - b.in.id,
  );
  const used = new Set<number>();
  const pairs: TransferPair[] = [];
  for (const option of options) {
    if (used.has(option.out.id) || used.has(option.in.id)) continue;
    used.add(option.out.id);
    used.add(option.in.id);
    pairs.push({ outId: option.out.id, inId: option.in.id });
  }
  return pairs;
}
