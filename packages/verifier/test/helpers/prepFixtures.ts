// The real preparation table (the data file of task 2.15), loaded once for the tests. Neutral values only.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadPreparationTable, type PrepTable } from "../../src/index.js";

export const TABLE_PATH = fileURLToPath(new URL("../../data/preparation-table.json", import.meta.url));
export const rawTable = (): Record<string, unknown> => JSON.parse(readFileSync(TABLE_PATH, "utf8")) as Record<string, unknown>;

export function loadedTable(): PrepTable {
  const r = loadPreparationTable(rawTable());
  if (!r.ok) throw new Error(`the preparation table does not load: ${r.error.join("; ")}`);
  return r.value;
}

/** A step with `k` lines. */
export function stepOf(kind = "order_exists", k = 1, extra: Record<string, unknown> = {}, bind?: string): { kind: string; bind?: string; params: Record<string, unknown> } {
  const params: Record<string, unknown> = { customer_id: 1, ...extra };
  for (let n = 1; n <= k; n += 1) {
    params[`product_${n}`] = n;
    params[`quantity_${n}`] = n + 1;
  }
  return { kind, ...(bind !== undefined ? { bind } : {}), params };
}