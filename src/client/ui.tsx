import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { addMonths } from '../shared/dates';
import { centsToInput, inputToCents, money, monthLabel } from './format';
import { Icon } from './icons';
import { useApp } from './state';
import type { Category } from './types';

export function Money({
  cents,
  whole = false,
  signed = false,
  tone,
  className = '',
}: {
  cents: number;
  whole?: boolean;
  signed?: boolean;
  tone?: 'auto' | 'good' | 'bad' | 'warn' | 'muted';
  className?: string;
}) {
  const resolved = tone === 'auto' ? (cents < 0 ? 'bad' : cents > 0 ? 'good' : 'muted') : tone;
  return <span className={`money ${resolved ? `tone-${resolved}` : ''} ${className}`}>{money(cents, { whole, signed })}</span>;
}

/**
 * A quiet section of a screen: a hairline above and space around. `boxed` is for things that are genuinely
 * separate (a bank connection, a kid). With `onClick` the whole section is a button, so it must not
 * contain headings: use <strong className="h2"> for its title.
 */
export function Card({
  children,
  className = '',
  onClick,
  boxed = false,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  boxed?: boolean;
}) {
  const classes = `card ${boxed ? 'card-boxed' : ''} ${className}`;
  if (onClick) {
    return (
      <button type="button" className={`${classes} card-button`} onClick={onClick}>
        {children}
      </button>
    );
  }
  return <section className={classes}>{children}</section>;
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {action}
    </header>
  );
}

export function Button({
  children,
  onClick,
  variant = 'secondary',
  type = 'button',
  disabled,
  small,
  className = '',
  pressed,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  type?: 'button' | 'submit';
  disabled?: boolean;
  small?: boolean;
  className?: string;
  /** Makes it a toggle button (aria-pressed). */
  pressed?: boolean;
}) {
  return (
    <button
      type={type}
      className={`btn btn-${variant} ${small ? 'btn-small' : ''} ${className}`}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
    >
      {children}
    </button>
  );
}

/** A bottom sheet on a phone, a centred dialog on a computer. Focus moves in on open and back on close. */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.classList.add('no-scroll');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('no-scroll');
    };
  }, [open, onClose]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    // An autoFocus field inside wins; otherwise the dialog itself takes focus.
    if (!dialog.current?.contains(document.activeElement)) dialog.current?.focus();
    return () => previous?.focus?.();
  }, [open]);
  if (!open) return null;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        ref={dialog}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  const id = useId();
  return (
    <div className="toggle-row">
      <label htmlFor={id}>
        <span>{label}</span>
        {hint && <span className="field-hint">{hint}</span>}
      </label>
      <input id={id} type="checkbox" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={o.value === value} className={o.value === value ? 'active' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Progress({ value, max, tone }: { value: number; max: number; tone?: 'good' | 'warn' | 'bad' }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : value > 0 ? 100 : 0;
  const auto = tone ?? (max > 0 && value > max ? 'bad' : pct > 90 ? 'warn' : 'good');
  return (
    <div className="progress" aria-hidden="true">
      <div className={`progress-fill tone-bg-${auto}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <div className="muted">{children}</div>}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <div className="loading">{label}</div>;
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="banner banner-bad">
      <span>{message}</span>
      {onRetry && (
        <Button small onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function MonthPicker({ month, onChange }: { month: string; onChange: (m: string) => void }) {
  return (
    <div className="month-picker">
      <button type="button" className="icon-btn" onClick={() => onChange(addMonths(month, -1))} aria-label="Previous month">
        <Icon name="back" />
      </button>
      <strong aria-live="polite">{monthLabel(month)}</strong>
      <button type="button" className="icon-btn" onClick={() => onChange(addMonths(month, 1))} aria-label="Next month">
        <Icon name="forward" />
      </button>
    </div>
  );
}

/** Dollar input that reports cents (null when empty or invalid). */
export function AmountInput({
  cents,
  onChange,
  placeholder = '0.00',
  allowNegative = false,
  autoFocus,
}: {
  cents: number | null;
  onChange: (cents: number | null) => void;
  placeholder?: string;
  allowNegative?: boolean;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState(centsToInput(cents));
  useEffect(() => {
    if (inputToCents(text) !== cents) setText(centsToInput(cents));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cents]);
  return (
    <div className="amount-input">
      <span>$</span>
      <input
        inputMode="decimal"
        value={text}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => {
          const next = allowNegative ? e.target.value : e.target.value.replace('-', '');
          setText(next);
          onChange(next.trim() === '' ? null : inputToCents(next));
        }}
      />
    </div>
  );
}

/** Category dropdown grouped by section. Hides your partner's fun money and archived categories. */
export function CategorySelect({
  value,
  onChange,
  noneLabel = 'Uncategorized',
  filter,
}: {
  value: number | null;
  onChange: (id: number | null) => void;
  noneLabel?: string;
  filter?: (c: Category) => boolean;
}) {
  const { categories, me } = useApp();
  const visible = categories.filter(
    (c) => (!c.archived || c.id === value) && (c.funMemberId === null || c.funMemberId === me.viewer.memberId) && (!filter || filter(c)),
  );
  const sections = [...new Set(visible.map((c) => c.sectionName))];
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">{noneLabel}</option>
      {sections.map((section) => (
        <optgroup key={section} label={section}>
          {visible
            .filter((c) => c.sectionName === section)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  );
}

export function KidSelect({ value, onChange }: { value: number | null; onChange: (id: number | null) => void }) {
  const { me } = useApp();
  if (!me.kids.length) return null;
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">No kid</option>
      {me.kids.map((k) => (
        <option key={k.id} value={k.id}>
          {k.name}
        </option>
      ))}
    </select>
  );
}

const STATUS_WORD = { ok: 'On track', low: 'Below your cushion', negative: 'Short' } as const;

export function StatusDot({ status }: { status: 'ok' | 'low' | 'negative' }) {
  return <span className={`dot dot-${status}`} role="img" aria-label={STATUS_WORD[status]} title={STATUS_WORD[status]} />;
}

export function Row({ children, onClick, className = '' }: { children: ReactNode; onClick?: () => void; className?: string }) {
  if (onClick) {
    return (
      <button type="button" className={`row row-button ${className}`} onClick={onClick}>
        {children}
      </button>
    );
  }
  return <div className={`row ${className}`}>{children}</div>;
}
