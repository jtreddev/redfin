import { parseMoney } from '../shared/money';

export { describeBalance, formatCents as money } from '../shared/money';

const utc = (date: string) => new Date(`${date}T12:00:00Z`);

const short = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const monthName = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const monthShort = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

export const shortDate = (date: string) => short.format(utc(date));
export const weekdayDate = (date: string) => weekday.format(utc(date));
export const monthLabel = (month: string) => monthName.format(utc(`${month}-01`));
export const monthShortLabel = (month: string) => monthShort.format(utc(`${month}-01`));

/** "12.34" for editing an amount. */
export function centsToInput(cents: number | null | undefined): string {
  if (cents == null) return '';
  return (cents / 100).toFixed(2).replace(/\.00$/, '');
}

export function inputToCents(text: string): number | null {
  return parseMoney(text);
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} hr ago`;
  return `${Math.round(seconds / 86_400)} days ago`;
}

export function plural(n: number, word: string, pluralWord = `${word}s`) {
  return `${n} ${n === 1 ? word : pluralWord}`;
}
