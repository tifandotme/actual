import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { csvDateRange, parseActual, parseBcaCsv, reconcile } from "./reconcile-bca";

const skillDir = join(import.meta.dir, "..");
const csvPath = join(skillDir, "fixtures", "sample-mutasi.csv");
const actualPath = join(skillDir, "fixtures", "sample-actual.json");

describe("BCA reconciliation", () => {
  test("parses KlikBCA metadata, footer rows, decimal amounts, and embedded TGL dates", () => {
    const rows = parseBcaCsv(csvPath);

    expect(rows).toHaveLength(9);
    expect(rows[0]).toMatchObject({ postingDate: "2025-12-31", amount: 4200, direction: "CR" });
    expect(rows[1]).toMatchObject({ postingDate: "2026-01-01", amount: -100000, direction: "DB" });
    expect(rows[2]).toMatchObject({ postingDate: "2026-01-02", embeddedDate: "2026-01-01", amount: -50000 });
    expect(rows[3]).toMatchObject({ postingDate: "2026-01-01", embeddedDate: "2025-12-31", amount: -30000 });
    expect(rows[7]).toMatchObject({ postingDate: "2026-01-05", amount: 25050, direction: "CR" });
  });

  test("matches exact rows, embedded dates, duplicates, and review hints", () => {
    const result = reconcile(parseBcaCsv(csvPath), parseActual(actualPath), 3, 3);

    expect(result.summary).toMatchObject({
      csvTransactions: 9,
      actualTransactions: 8,
      matched: 7,
      missingCandidates: 2,
      reviewCandidates: 2,
      unmatchedActual: 1,
    });
    expect(result.summary.matchMethods).toEqual({
      embedded_tgl_amount: 2,
      posting_date_amount: 5,
    });
    expect(result.missingCandidates.map((row) => row.description)).toEqual([
      "MISSING WITH NEAR HINT",
      "DUPLICATE CREDIT B",
    ]);
  });

  test("derives the CSV date range and padded Actual query range", () => {
    expect(csvDateRange(parseBcaCsv(csvPath), 3)).toEqual({
      csvDateStart: "2025-12-31",
      csvDateEnd: "2026-01-06",
      suggestedActualStart: "2025-12-31",
      suggestedActualEnd: "2026-01-09",
    });
  });
});
