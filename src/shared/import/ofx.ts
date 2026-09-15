import { isISODate, type ISODate } from '../dates';
import { parseMoney, type Cents } from '../money';

export interface OfxTransaction {
  fitId: string;
  date: ISODate;
  amountCents: Cents;
  name: string;
  memo?: string;
  type?: string;
}

export interface OfxStatement {
  accountId?: string;
  /** Last 4 digits of the account id. */
  mask?: string;
  kind: 'bank' | 'credit';
  transactions: OfxTransaction[];
}

/** Reads one tag value; works for SGML (OFX 1.x, unclosed tags) and XML (OFX 2.x). */
function tag(block: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([^<\\r\\n]*)`, 'i').exec(block);
  const value = match?.[1]?.trim();
  return value ? decodeEntities(value) : undefined;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'");
}

function ofxDate(raw: string | undefined): ISODate | null {
  if (!raw || !/^\d{8}/.test(raw)) return null;
  const date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  return isISODate(date) ? date : null;
}

/** Parses OFX/QFX downloads (Quicken/Money formats) into statements. */
export function parseOfx(text: string): OfxStatement[] {
  const statementBlocks = text.split(/<(?=(?:CC)?STMTRS>)/i).slice(1);
  const blocks = statementBlocks.length ? statementBlocks : [text];

  return blocks.map((block) => {
    const kind: OfxStatement['kind'] = /^CCSTMTRS>|<CCACCTFROM>/i.test(block) ? 'credit' : 'bank';
    const accountId = tag(block, 'ACCTID');
    const transactions: OfxTransaction[] = [];
    const pieces = block.split(/<STMTTRN>/i).slice(1);
    for (const piece of pieces) {
      const body = piece.split(/<\/STMTTRN>|<\/BANKTRANLIST>/i)[0] ?? piece;
      const date = ofxDate(tag(body, 'DTPOSTED') ?? tag(body, 'DTUSER'));
      const amountCents = parseMoney(tag(body, 'TRNAMT'));
      if (!date || amountCents === null) continue;
      const name = tag(body, 'NAME') ?? tag(body, 'PAYEE') ?? tag(body, 'MEMO') ?? '(no description)';
      const memo = tag(body, 'MEMO');
      const fitId = tag(body, 'FITID') ?? `${date}|${amountCents}|${name}`;
      const type = tag(body, 'TRNTYPE');
      transactions.push({
        fitId,
        date,
        amountCents,
        name,
        ...(memo && memo !== name ? { memo } : {}),
        ...(type ? { type } : {}),
      });
    }
    return {
      ...(accountId ? { accountId, mask: accountId.replace(/\D/g, '').slice(-4) || accountId.slice(-4) } : {}),
      kind,
      transactions,
    };
  });
}
