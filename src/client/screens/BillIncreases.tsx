import { useState } from 'react';
import { errorMessage, post } from '../api';
import { shortDate } from '../format';
import { useApp } from '../state';
import type { BillIncrease } from '../types';
import { Button, Card, Money } from '../ui';

/** Whole dollars when there are no cents: "$75", "$74.99". */
const Amount = ({ cents }: { cents: number }) => <Money cents={cents} whole={cents % 100 === 0} />;

/**
 * "Use $75 from now on" and "Dismiss" for a bill that went up. Dismissing keeps the usual amount; a bigger
 * charge later flags the bill again.
 */
export function IncreaseActions({ billId, name, latestCents, onDone }: { billId: number; name: string; latestCents: number; onDone: () => Promise<void> | void }) {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);

  async function answer(action: 'update' | 'dismiss') {
    setBusy(true);
    try {
      await post(`/bills/${billId}/increase`, { action });
      toast(action === 'update' ? `${name} updated` : `Okay. You’ll hear about ${name} again only if it goes up more`);
      await onDone();
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cluster">
      <Button small onClick={() => void answer('update')} disabled={busy}>
        {/* One span, so the button's icon gap doesn't open up around the amount. */}
        <span>
          Use <Amount cents={latestCents} /> from now on
        </span>
      </Button>
      <Button small variant="ghost" onClick={() => void answer('dismiss')} disabled={busy}>
        Dismiss
      </Button>
    </div>
  );
}

/** "Internet was $15 more than usual ($75 vs $60)", with the answer buttons. */
export function IncreaseText({ increase }: { increase: Pick<BillIncrease, 'name' | 'usualCents' | 'latestCents'> }) {
  return (
    <>
      {increase.name} was <Amount cents={increase.latestCents - increase.usualCents} /> more than usual (
      <Amount cents={increase.latestCents} /> vs <Amount cents={increase.usualCents} />)
    </>
  );
}

/** Home: one row per bill that went up. Nothing when none did. */
export function BillIncreasesCard({ items, onChanged }: { items: BillIncrease[] | undefined; onChanged: () => Promise<void> | void }) {
  if (!items?.length) return null;
  return (
    <Card>
      <h2>{items.length === 1 ? 'A bill went up' : 'Bills went up'}</h2>
      <div className="list">
        {items.map((i) => (
          <div key={i.billId} className="row increase-row">
            <div className="row-main">
              <div className="row-title">
                <IncreaseText increase={i} />
              </div>
              <div className="row-sub">Charged {shortDate(i.date)}</div>
            </div>
            <IncreaseActions billId={i.billId} name={i.name} latestCents={i.latestCents} onDone={onChanged} />
          </div>
        ))}
      </div>
    </Card>
  );
}
