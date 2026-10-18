/**
 * What ticking "Also file N other … charges this way" does. Right after a pick in this sheet, it files
 * the others now (the pick plus alsoSimilar). Before any pick, it only rides along with the next pick,
 * so opening a charge and ticking the box never re-files charges by surprise.
 */
export function alsoFileOnTick({
  checked,
  pickedThisSession,
  categoryId,
}: {
  checked: boolean;
  pickedThisSession: boolean;
  categoryId: number | null;
}): 'learn-now' | 'with-next-pick' | 'off' {
  if (!checked) return 'off';
  return pickedThisSession && categoryId !== null ? 'learn-now' : 'with-next-pick';
}
