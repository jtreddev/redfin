import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { money, splitAmounts } from './format';
import { Icon } from './icons';

/**
 * Hide amounts: a per-person switch (members.hide_amounts). While it's on, the `hide-amounts` class on <html>
 * blurs every `.money` and `.chart-amount` (styles.css), sheets included, since they're portalled to <body>.
 * Screen readers hear "hidden amount" instead (Money, useMoneyText). Inputs aren't blurred.
 */
export interface Amounts {
  hidden: boolean;
  /** Saves the switch for this person; the screen changes at once. */
  setHidden: (hidden: boolean) => void;
}

export const AmountsContext = createContext<Amounts>({ hidden: false, setHidden: () => undefined });

export const useAmounts = () => useContext(AmountsContext);

export const HIDDEN_AMOUNT = 'hidden amount';
/** How long a tapped amount stays readable. */
export const REVEAL_MS = 5000;

/** An amount's text: as is, or (while hidden) kept for the eye but read out as "hidden amount". */
export function amountContent(text: string, hidden: boolean): ReactNode {
  if (!hidden) return text;
  return (
    <>
      <span aria-hidden="true">{text}</span>
      <span className="sr-only">{HIDDEN_AMOUNT}</span>
    </>
  );
}

/**
 * A sentence built by a helper ("$412 a month set aside for 3 costs"), with each dollar amount in it shown
 * the way Money shows one, so it blurs too.
 */
export function WithAmounts({ text }: { text: string }) {
  const { hidden } = useAmounts();
  return (
    <>
      {splitAmounts(text).map((part, i) =>
        i % 2 ? (
          <span key={i} className="money">
            {amountContent(part, hidden)}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** `money()` for text that isn't on screen as an amount: aria-labels, live regions, option labels. */
export function useMoneyText() {
  const { hidden } = useAmounts();
  return (cents: number, options?: Parameters<typeof money>[1]) => (hidden ? HIDDEN_AMOUNT : money(cents, options));
}

/**
 * Puts the class on <html> and lets a tap or click on a blurred amount show it for 5 seconds. That first tap
 * only reveals: it doesn't also open the row or press the button the amount sits in. The reveal is a data
 * attribute React doesn't own, so a re-render doesn't undo it.
 */
export function useHideAmountsRoot(hidden: boolean) {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('hide-amounts', hidden);
    if (!hidden) return;
    const timers = new Set<number>();
    const onClick = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest?.('.money, .chart-amount');
      if (!el || el.hasAttribute('data-revealed')) return;
      e.preventDefault();
      e.stopPropagation();
      el.setAttribute('data-revealed', '');
      const timer = window.setTimeout(() => {
        el.removeAttribute('data-revealed');
        timers.delete(timer);
      }, REVEAL_MS);
      timers.add(timer);
    };
    document.addEventListener('click', onClick, true);
    return () => {
      document.removeEventListener('click', onClick, true);
      timers.forEach((t) => window.clearTimeout(t));
      document.querySelectorAll('[data-revealed]').forEach((el) => el.removeAttribute('data-revealed'));
    };
  }, [hidden]);
}

/** The eye button: in the page header on a phone, in the side menu on a computer. */
export function HideAmountsButton({ withLabel = false, className = '' }: { withLabel?: boolean; className?: string }) {
  const { hidden, setHidden } = useAmounts();
  const label = hidden ? 'Show amounts' : 'Hide amounts';
  return (
    <button
      type="button"
      className={`${withLabel ? 'side-action' : 'icon-btn'} ${className}`}
      aria-label={withLabel ? undefined : label}
      title={withLabel ? undefined : label}
      onClick={() => setHidden(!hidden)}
    >
      <Icon name={hidden ? 'eyeOff' : 'eye'} />
      {withLabel && <span>{label}</span>}
    </button>
  );
}
