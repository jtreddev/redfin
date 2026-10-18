import { useState } from 'react';
import { GROUP_ORDER, type GroupKey } from '../../shared/trends';
import { Icon } from '../icons';
import { Button } from '../ui';

/** Each group's chart color: dataviz categorical slots 1–5, in the groups' fixed order. */
export const GROUP_COLOR: Record<GroupKey, string> = Object.fromEntries(GROUP_ORDER.map((g, i) => [g.key, `--series-${i + 1}`])) as Record<
  GroupKey,
  string
>;

/** A "Table" toggle for a chart card (the table is the accessible twin); pressed shows the table. */
export function useTableToggle(title: string) {
  const [table, setTable] = useState(false);
  const toggle = (
    <Button small variant="ghost" pressed={table} className="table-toggle" onClick={() => setTable((v) => !v)}>
      <Icon name="table" />
      Table
      <span className="sr-only"> view of {title}</span>
    </Button>
  );
  return [table, toggle] as const;
}
