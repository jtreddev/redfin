import { useEffect, useId, useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { addMonths } from '../shared/dates';
import { amountContent, HideAmountsButton, useAmounts } from './amounts';
import { centsToInput, inputToCents, money, monthLabel } from './format';
import { categoryTree, pickerOptions } from './categoryTree';
import { Icon } from './icons';
import { KidFormSheet, NewCategorySheet } from './quickAdd';
import { NEW_VALUE, selectStep, type SelectEvent, type SelectState } from './selectCommit';
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
  const { hidden } = useAmounts();
  const resolved = tone === 'auto' ? (cents < 0 ? 'bad' : cents > 0 ? 'good' : 'muted') : tone;
  const text = money(cents, { whole, signed });
  return (
    <span className={`money ${resolved ? `tone-${resolved}` : ''} ${className}`}>{amountContent(text, hidden)}</span>
  );
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
      <div className="page-header-actions">
        {action}
        <HideAmountsButton className="header-eye" />
      </div>
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

/** Open sheets, innermost last: Escape closes only the top one, and the page scrolls again when none are open. */
const openSheets: symbol[] = [];

/** A bottom sheet on a phone, a centred dialog on a computer. Focus moves in on open and back on close. */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const me = Symbol('sheet');
    openSheets.push(me);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && openSheets[openSheets.length - 1] === me) {
        e.stopPropagation();
        closeRef.current();
      }
    };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('no-scroll');
    return () => {
      document.removeEventListener('keydown', onKey);
      openSheets.splice(openSheets.indexOf(me), 1);
      if (!openSheets.length) document.body.classList.remove('no-scroll');
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    // An autoFocus field inside wins; otherwise the dialog itself takes focus.
    if (!dialog.current?.contains(document.activeElement)) dialog.current?.focus();
    return () => previous?.focus?.();
  }, [open]);
  if (!open) return null;
  // In a portal, so a sheet opened from inside a <label> (a picker's "＋ New") isn't part of that label.
  return createPortal(
    // A form in a sheet opened from inside another form (a picker's "＋ New" in the bill editor) must not
    // submit that outer form: React bubbles events through the portal, so stop them here.
    <div className="sheet-backdrop" onClick={onClose} onSubmit={(e) => e.stopPropagation()}>
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
    </div>,
    document.body,
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

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
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

const NEW = NEW_VALUE;

/**
 * Handlers for a native select that saves on choice: a click or tap commits at once, arrow-key steps
 * wait for Enter or for focus to leave, and "＋ New" opens only on a real choice (see selectCommit.ts).
 * A commit of the value already shown does nothing.
 */
export function useCommitSelect(value: number | null, commit: (v: string) => void) {
  const state = useRef<SelectState>({ pending: null, keyNav: false });
  const [pending, setPending] = useState<string | null>(null);
  const current = value === null ? '' : String(value);
  const run = (event: SelectEvent) => {
    const r = selectStep(state.current, event);
    state.current = r.state;
    setPending(r.state.pending);
    if (r.commit !== null && r.commit !== current) commit(r.commit);
  };
  return {
    value: pending ?? current,
    onKeyDown: (e: ReactKeyboardEvent<HTMLSelectElement>) => run({ type: 'key', key: e.key }),
    onPointerDown: () => run({ type: 'pointer' }),
    onChange: (e: ChangeEvent<HTMLSelectElement>) => run({ type: 'change', value: e.target.value }),
    onBlur: () => run({ type: 'blur' }),
  };
}
/** A sub-category's option reads "Habits › Snacks" (an optgroup can't nest, and the closed select shows it whole). */
export function optionLabel(category: Category, categories: readonly Category[]): string {
  const parent = category.parentId === null ? undefined : categories.find((c) => c.id === category.parentId);
  return parent ? `${parent.name} › ${category.name}` : category.name;
}

/**
 * Category dropdown grouped by group, sub-categories nested under their parent. Hides your partner's
 * fun money and hidden categories. Ends with "＋ New category", which opens a small form and picks
 * the new category (off by default when `filter` narrows the list).
 */
export function CategorySelect({
  value,
  onChange,
  noneLabel = 'Uncategorized',
  filter,
  allowNew = !filter,
  id,
  selectRef,
  disabled,
}: {
  value: number | null;
  onChange: (id: number | null) => void;
  noneLabel?: string;
  filter?: (c: Category) => boolean;
  allowNew?: boolean;
  id?: string;
  selectRef?: Ref<HTMLSelectElement>;
  disabled?: boolean;
}) {
  const { categories, sections, me } = useApp();
  const [creating, setCreating] = useState(false);
  const select = useCommitSelect(value, (v) => (v === NEW ? setCreating(true) : onChange(v ? Number(v) : null)));
  const groups = pickerOptions(
    categoryTree(
      sections,
      categories,
      (c) => (!c.archived || c.id === value) && (c.funMemberId === null || c.funMemberId === me.viewer.memberId) && (!filter || filter(c)),
    ),
  );
  const current = categories.find((c) => c.id === value);
  return (
    <>
      <select
        id={id}
        ref={selectRef}
        disabled={disabled}
        {...select}
      >
        <option value="">{noneLabel}</option>
        {groups.map((g) => (
          <optgroup key={g.section} label={g.section}>
            {g.options.map(({ category }) => (
              <option key={category.id} value={category.id}>
                {optionLabel(category, categories)}
              </option>
            ))}
          </optgroup>
        ))}
        {allowNew && <option value={NEW}>＋ New category</option>}
      </select>
      {creating && (
        <NewCategorySheet
          defaultSectionId={current?.sectionId}
          defaultParentId={current ? (current.parentId ?? null) : null}
          onClose={() => setCreating(false)}
          onCreated={(newId) => {
            setCreating(false);
            onChange(newId);
          }}
        />
      )}
    </>
  );
}

/** Kid dropdown; "＋ Add a kid" opens the kid form and picks the new kid. Without kids (and adding), nothing. */
export function KidSelect({
  value,
  onChange,
  allowAdd = true,
  noneLabel = 'No kid',
  id,
}: {
  value: number | null;
  onChange: (id: number | null) => void;
  allowAdd?: boolean;
  noneLabel?: string;
  id?: string;
}) {
  const { me } = useApp();
  const [adding, setAdding] = useState(false);
  const select = useCommitSelect(value, (v) => (v === NEW ? setAdding(true) : onChange(v ? Number(v) : null)));
  if (!me.kids.length && !allowAdd) return null;
  return (
    <>
      <select
        id={id}
        {...select}
      >
        <option value="">{noneLabel}</option>
        {me.kids.map((k) => (
          <option key={k.id} value={k.id}>
            {k.name}
          </option>
        ))}
        {allowAdd && <option value={NEW}>＋ Add a kid</option>}
      </select>
      {adding && (
        <KidFormSheet
          kid={null}
          onClose={() => setAdding(false)}
          onSaved={(kidId) => {
            setAdding(false);
            if (kidId) onChange(kidId);
          }}
        />
      )}
    </>
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
