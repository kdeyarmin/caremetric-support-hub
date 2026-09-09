import type { SupportCase } from "../domain";

export function reconcileCaseSelection(
  rows: readonly Pick<SupportCase, "id">[],
  currentId: string | null,
  preferredId?: string,
): string | null {
  if (preferredId && rows.some((row) => row.id === preferredId)) return preferredId;
  if (currentId && rows.some((row) => row.id === currentId)) return currentId;
  return rows[0]?.id ?? null;
}
