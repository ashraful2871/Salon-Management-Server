import { Response } from "express";
import { maskEmail, maskPhone } from "../modules/Admin/admin.service";
import { toTaka } from "./money";

/**
 * Streaming CSV for the admin exports - the one kind of response that does
 * not go through `sendResponse`.
 *
 * - Rows are fetched and written in batches of 1,000, so an export never holds
 *   the whole table in memory; 50,000 rows is the hard cap.
 * - A UTF-8 BOM goes first, or Excel reads "৳" and Bangla names as mojibake.
 * - Text that starts with = + - @ (or a tab/CR) gets a leading `'`, so a
 *   customer called `=HYPERLINK(...)` is text, not a formula. Numbers are
 *   never escaped: money must stay a number in the sheet.
 * - Money columns hold poisha and are written as taka with two decimals.
 * - PII columns are masked unless the caller holds `users.view_pii`.
 */
export const CSV_BATCH = 1000;
export const CSV_MAX_ROWS = 50_000;

export type CsvColumn<T> = {
  header: string;
  value: (row: T) => unknown;
  /** The value is poisha: write it as taka, `150.00`. */
  money?: boolean;
  /** "email" | "phone" | "text": masked without users.view_pii. */
  pii?: "email" | "phone" | "text";
};

const FORMULA_START = /^[=+\-@\t\r]/;

const maskText = (text: string) => (text ? `${text.slice(0, 1)}***` : text);

const cell = <T>(column: CsvColumn<T>, row: T, showPii: boolean): string => {
  const raw = column.value(row);
  if (raw === null || raw === undefined) return "";

  if (column.money && typeof raw === "number") return toTaka(raw).toFixed(2);
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);

  let text = raw instanceof Date ? raw.toISOString() : String(raw);
  if (column.pii && !showPii) {
    text =
      (column.pii === "email" ? maskEmail(text) : column.pii === "phone" ? maskPhone(text) : maskText(text)) ?? "";
  }
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text;
};

/**
 * Streams `fetchBatch` pages to `res` until a short page or the cap. Each call
 * gets the last row of the previous page (keyset paging), or undefined first.
 * Returns how many rows were written and whether the cap cut it short.
 */
export const streamCsv = async <T>(
  res: Response,
  opts: {
    filename: string;
    columns: CsvColumn<T>[];
    showPii: boolean;
    fetchBatch: (after: T | undefined, take: number) => Promise<T[]>;
  },
): Promise<{ rows: number; truncated: boolean }> => {
  res.status(200);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${opts.filename}"`);
  res.setHeader("Cache-Control", "no-store");

  res.write("\uFEFF");
  res.write(`${opts.columns.map((c) => cell({ header: "", value: () => c.header }, null, true)).join(",")}\r\n`);

  let rows = 0;
  let after: T | undefined;
  let truncated = false;

  try {
    for (;;) {
      const take = Math.min(CSV_BATCH, CSV_MAX_ROWS - rows);
      if (take <= 0) {
        // One more probe tells "exactly at the cap" from "cut short".
        truncated = (await opts.fetchBatch(after, 1)).length > 0;
        break;
      }
      const batch = await opts.fetchBatch(after, take);
      if (batch.length) {
        res.write(
          batch
            .map((row) => opts.columns.map((column) => cell(column, row, opts.showPii)).join(","))
            .join("\r\n") + "\r\n",
        );
        rows += batch.length;
        after = batch[batch.length - 1];
      }
      if (batch.length < take) break;
    }
  } catch (error) {
    // The headers are gone already, so the error handler cannot answer. End
    // the file with a marker a person will notice, and let the caller audit.
    console.error(`[csv] ${opts.filename} failed after ${rows} rows`, error);
    res.write("EXPORT FAILED - this file is incomplete\r\n");
    res.end();
    return { rows, truncated: true };
  }

  res.end();
  return { rows, truncated };
};
