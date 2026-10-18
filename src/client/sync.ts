import { post } from './api';
import type { SyncStepResult } from './types';

/** A bank another sync is already working on frees up within seconds. */
const waitIfBusy = (step: SyncStepResult) => (step.busy ? new Promise((resolve) => setTimeout(resolve, 2000)) : undefined);

export interface SyncSummary {
  added: number;
  /** Already-stored charges whose bank details were refreshed. */
  refreshed?: number;
  errors: string[];
  /** Heads-ups like "still preparing your transactions". */
  notes?: string[];
}

/** Repeats small sync steps until every bank has been synced once. */
export async function syncAllBanks(onStep?: (step: SyncStepResult) => void): Promise<SyncSummary> {
  const since = new Date().toISOString();
  const excludeIds: number[] = [];
  const errors: string[] = [];
  let added = 0;
  for (let i = 0; i < 300; i++) {
    const step = await post<SyncStepResult>('/sync/step', { since, excludeIds });
    onStep?.(step);
    added += step.added;
    if (step.status === 'idle' || step.itemId === null) break;
    await waitIfBusy(step);
    if (step.error) {
      errors.push(`${step.institutionName ?? 'A bank'}: ${step.error}`);
      excludeIds.push(step.itemId);
    }
  }
  return { added, errors };
}

/** Pulls everything available for one bank (used right after connecting). */
export async function syncOneBank(itemId: number, onStep?: (step: SyncStepResult) => void): Promise<SyncSummary> {
  let added = 0;
  let refreshed = 0;
  const notes: string[] = [];
  for (let i = 0; i < 300; i++) {
    const step = await post<SyncStepResult>('/sync/step', { itemId });
    onStep?.(step);
    added += step.added;
    refreshed += step.refreshed ?? 0;
    if (step.note) notes.push(step.note);
    if (step.error) return { added, refreshed, errors: [step.error], notes };
    if (step.done) break;
    await waitIfBusy(step);
  }
  return { added, refreshed, errors: [], notes };
}

/** Re-derives automatic categories for all history, 200 charges at a time. Returns how many changed. */
export async function recategorizeAll(onProgress?: (done: number) => void): Promise<number> {
  let afterId: number | undefined;
  let updated = 0;
  for (let i = 0; i < 10_000; i++) {
    const step = await post<{ updated: number; nextAfterId: number | null }>('/categorize/all', afterId === undefined ? {} : { afterId });
    updated += step.updated;
    onProgress?.(updated);
    if (step.nextAfterId === null) break;
    afterId = step.nextAfterId;
  }
  return updated;
}
