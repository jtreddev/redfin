import { post } from './api';
import type { SyncStepResult } from './types';

export interface SyncSummary {
  added: number;
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
  const notes: string[] = [];
  for (let i = 0; i < 300; i++) {
    const step = await post<SyncStepResult>('/sync/step', { itemId });
    onStep?.(step);
    added += step.added;
    if (step.note) notes.push(step.note);
    if (step.error) return { added, errors: [step.error], notes };
    if (step.done) break;
  }
  return { added, errors: [], notes };
}
