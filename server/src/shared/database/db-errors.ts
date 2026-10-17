/** MySQL's duplicate-key error, which the create-or-find gates rely on. */
export const isDuplicateKeyError = (error: unknown): boolean =>
  (error as { code?: string; driverError?: { code?: string } })?.code === 'ER_DUP_ENTRY' ||
  (error as { driverError?: { code?: string } })?.driverError?.code === 'ER_DUP_ENTRY';

export const affectedRows = (result: { affected?: number | null }): number => result.affected ?? 0;
