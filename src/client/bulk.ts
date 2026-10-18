/** Most charges one bulk change takes (MAX_BULK in src/worker/routes/transactions.ts). */
export const MAX_BULK = 500;

/** "Select all": the first `limit` ids, and whether some were left out. */
export function capSelection(ids: readonly number[], limit = MAX_BULK): { ids: number[]; capped: boolean } {
  return { ids: ids.slice(0, limit), capped: ids.length > limit };
}
