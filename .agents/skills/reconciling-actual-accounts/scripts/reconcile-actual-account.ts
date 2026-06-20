#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface CsvTransaction {
  rowNumber: number;
  postingDate: string;
  embeddedDate: string | null;
  amount: number;
  direction: "CR" | "DB";
  description: string;
  branch: string | null;
  balance: string | null;
}

interface ActualTransaction {
  id: string;
  date: string;
  amount: number;
  payeeName: string | null;
  notes: string | null;
  importedId: string | null;
  cleared: boolean | null;
}

interface MatchRecord {
  csv: CsvTransaction;
  actual: ActualTransaction;
  method: "posting_date_amount" | "embedded_tgl_amount";
}

interface DuplicateGroup {
  date: string;
  amount: number;
  amountIdr: number;
  csvCount: number;
  actualCount: number;
  deltaCsvMinusActual: number;
}

interface MissingCandidate extends CsvTransaction {
  amountIdr: number;
  possibleNearActual: ActualTransaction[];
}

interface ReconcileResult {
  summary: {
    csvTransactions: number;
    actualTransactions: number;
    matched: number;
    missingCandidates: number;
    reviewCandidates: number;
    unmatchedActual: number;
    duplicateGroups: number;
    csvDateStart: string | null;
    csvDateEnd: string | null;
    suggestedActualStart: string | null;
    suggestedActualEnd: string | null;
    matchMethods: Record<string, number>;
  };
  missingCandidates: MissingCandidate[];
  reviewCandidates: MissingCandidate[];
  duplicateGroups: DuplicateGroup[];
  matched: MatchRecord[];
  unmatchedActual: ActualTransaction[];
}

interface CliOptions {
  csvPath?: string;
  actualJsonPath?: string;
  outDir: string;
  nearDays: number;
  actualEndPaddingDays: number;
  printDateRange: boolean;
  printActualQuery: boolean;
  accountId?: string;
}

const DATE_RE = /^\d{2}\/\d{2}\/\d{4}$/;
const EMBEDDED_TGL_RE = /\bTGL:\s*(\d{2})(\d{2})\b/i;

function cleanText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function parseDateParts(value: string): { day: number; month: number; year: number } {
  const [dayText, monthText, yearText] = value.replace(/^'/, "").trim().split("/");
  if (!dayText || !monthText || !yearText) throw new Error(`Invalid date: ${value}`);
  return { day: Number(dayText), month: Number(monthText), year: Number(yearText) };
}

function dateFromParts(year: number, month: number, day: number): Date | null {
  const result = new Date(Date.UTC(year, month - 1, day));
  if (
    result.getUTCFullYear() !== year ||
    result.getUTCMonth() !== month - 1 ||
    result.getUTCDate() !== day
  ) {
    return null;
  }
  return result;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parsePostingDate(value: string): Date {
  const { day, month, year } = parseDateParts(value);
  const parsed = dateFromParts(year, month, day);
  if (!parsed) throw new Error(`Invalid posting date: ${value}`);
  return parsed;
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return toIsoDate(date);
}

function dayDistance(leftIso: string, rightIso: string): number {
  const left = new Date(`${leftIso}T00:00:00.000Z`).getTime();
  const right = new Date(`${rightIso}T00:00:00.000Z`).getTime();
  return Math.round(Math.abs(left - right) / 86_400_000);
}

function parseIdrAmount(value: string): number {
  const normalized = cleanText(value).replaceAll(",", "");
  const match = normalized.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) throw new Error(`Invalid IDR amount: ${value}`);
  const rupiah = Number(match[1]);
  const cents = Number((match[2] ?? "").padEnd(2, "0"));
  return rupiah * 100 + cents;
}

function parseEmbeddedDate(description: string, posting: Date): string | null {
  const match = description.match(EMBEDDED_TGL_RE);
  if (!match) return null;

  const month = Number(match[1]);
  const day = Number(match[2]);
  const postingIso = toIsoDate(posting);
  const candidates = [posting.getUTCFullYear() - 1, posting.getUTCFullYear(), posting.getUTCFullYear() + 1]
    .map((year) => dateFromParts(year, month, day))
    .filter((value): value is Date => value !== null);

  if (candidates.length === 0) return null;
  candidates.sort((left, right) => dayDistance(postingIso, toIsoDate(left)) - dayDistance(postingIso, toIsoDate(right)));
  return toIsoDate(candidates[0]!);
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && inQuotes && next === '"') {
      field += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      fields.push(field);
      field = "";
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

function csvRows(text: string): { rowNumber: number; row: Record<string, string> }[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.startsWith("Tanggal,Keterangan,"));
  if (headerIndex === -1) throw new Error("Could not find KlikBCA transaction header");

  const headers = parseCsvLine(lines[headerIndex]!);
  const rows: { rowNumber: number; row: Record<string, string> }[] = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === "") continue;
    const values = parseCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((header, valueIndex) => {
      row[header] = values[valueIndex] ?? "";
    });
    rows.push({ rowNumber: index + 1, row });
  }
  return rows;
}

export function parseBcaCsv(path: string): CsvTransaction[] {
  const text = readFileSync(path, "utf8");
  return csvRows(text).flatMap(({ rowNumber, row }) => {
    const rawDate = cleanText(row.Tanggal).replace(/^'/, "");
    const direction = cleanText(row[""]);
    if (!DATE_RE.test(rawDate) || (direction !== "CR" && direction !== "DB")) return [];

    const posting = parsePostingDate(rawDate);
    const description = cleanText(row.Keterangan);
    const sign = direction === "CR" ? 1 : -1;
    return [
      {
        rowNumber,
        postingDate: toIsoDate(posting),
        embeddedDate: parseEmbeddedDate(description, posting),
        amount: sign * parseIdrAmount(row.Jumlah ?? ""),
        direction,
        description,
        branch: cleanText(row.Cabang) || null,
        balance: cleanText(row.Saldo) || null,
      },
    ];
  });
}

function unwrapActualRows(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const object = raw as Record<string, unknown>;
    for (const key of ["data", "rows", "results", "transactions"]) {
      if (Array.isArray(object[key])) return object[key];
    }
  }
  throw new Error("Actual query JSON must be a list or contain data/rows/results/transactions");
}

export function parseActual(path: string): ActualTransaction[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return unwrapActualRows(raw).map((row) => {
    const object = row as Record<string, unknown>;
    return {
      id: String(object.id ?? ""),
      date: String(object.date ?? ""),
      amount: Number(object.amount),
      payeeName: (object["payee.name"] ?? object.payee_name ?? null) as string | null,
      notes: (object.notes ?? null) as string | null,
      importedId: (object.imported_id ?? null) as string | null,
      cleared: (object.cleared ?? null) as boolean | null,
    };
  });
}

function keyFor(date: string, amount: number): string {
  return `${date}\t${amount}`;
}

function actualBuckets(actualRows: ActualTransaction[]): Map<string, ActualTransaction[]> {
  const buckets = new Map<string, ActualTransaction[]>();
  for (const transaction of actualRows) {
    const key = keyFor(transaction.date, transaction.amount);
    const bucket = buckets.get(key) ?? [];
    bucket.push(transaction);
    buckets.set(key, bucket);
  }
  return buckets;
}

function nearActual(row: CsvTransaction, actualRows: ActualTransaction[], days: number): ActualTransaction[] {
  return actualRows
    .filter((transaction) => transaction.amount === row.amount)
    .filter((transaction) => dayDistance(row.postingDate, transaction.date) <= days)
    .sort((left, right) => {
      const distance = dayDistance(row.postingDate, left.date) - dayDistance(row.postingDate, right.date);
      return distance === 0 ? left.date.localeCompare(right.date) : distance;
    });
}

function countByDateAmount(rows: { date: string; amount: number }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(keyFor(row.date, row.amount), (counts.get(keyFor(row.date, row.amount)) ?? 0) + 1);
  return counts;
}

function duplicateGroups(csvRows: CsvTransaction[], actualRows: ActualTransaction[]): DuplicateGroup[] {
  const csvCounts = countByDateAmount(csvRows.map((row) => ({ date: row.postingDate, amount: row.amount })));
  const actualCounts = countByDateAmount(actualRows);
  const keys = [...new Set([...csvCounts.keys(), ...actualCounts.keys()])].sort();

  return keys.flatMap((key) => {
    const csvCount = csvCounts.get(key) ?? 0;
    const actualCount = actualCounts.get(key) ?? 0;
    if (csvCount <= 1 && actualCount <= 1 && csvCount === actualCount) return [];
    const [date, amountText] = key.split("\t");
    const amount = Number(amountText);
    return [
      {
        date: date!,
        amount,
        amountIdr: amount / 100,
        csvCount,
        actualCount,
        deltaCsvMinusActual: csvCount - actualCount,
      },
    ];
  });
}

export function csvDateRange(csvRows: CsvTransaction[], actualEndPaddingDays: number) {
  if (csvRows.length === 0) {
    return { csvDateStart: null, csvDateEnd: null, suggestedActualStart: null, suggestedActualEnd: null };
  }
  const dates = csvRows.map((row) => row.postingDate).sort();
  const csvDateStart = dates[0]!;
  const csvDateEnd = dates.at(-1)!;
  return {
    csvDateStart,
    csvDateEnd,
    suggestedActualStart: csvDateStart,
    suggestedActualEnd: addDays(csvDateEnd, actualEndPaddingDays),
  };
}

export function reconcile(
  csvRows: CsvTransaction[],
  actualRows: ActualTransaction[],
  nearDays: number,
  actualEndPaddingDays: number,
): ReconcileResult {
  const buckets = actualBuckets(actualRows);
  const matched: MatchRecord[] = [];
  const remaining: CsvTransaction[] = [];

  for (const row of csvRows) {
    const bucket = buckets.get(keyFor(row.postingDate, row.amount)) ?? [];
    const actual = bucket.shift();
    if (actual) matched.push({ csv: row, actual, method: "posting_date_amount" });
    else remaining.push(row);
  }

  const missingCandidates: MissingCandidate[] = [];
  const reviewCandidates: MissingCandidate[] = [];

  for (const row of remaining) {
    const bucket = row.embeddedDate ? buckets.get(keyFor(row.embeddedDate, row.amount)) ?? [] : [];
    const embeddedMatch = bucket.shift();
    if (embeddedMatch) {
      matched.push({ csv: row, actual: embeddedMatch, method: "embedded_tgl_amount" });
      continue;
    }

    const possibleNearActual = nearActual(row, actualRows, nearDays);
    const candidate = { ...row, amountIdr: row.amount / 100, possibleNearActual };
    missingCandidates.push(candidate);
    if (possibleNearActual.length > 0) reviewCandidates.push(candidate);
  }

  const unmatchedActual = [...buckets.values()].flat();
  const groups = duplicateGroups(csvRows, actualRows);
  const matchMethods = matched.reduce<Record<string, number>>((counts, item) => {
    counts[item.method] = (counts[item.method] ?? 0) + 1;
    return counts;
  }, {});
  const range = csvDateRange(csvRows, actualEndPaddingDays);

  return {
    summary: {
      csvTransactions: csvRows.length,
      actualTransactions: actualRows.length,
      matched: matched.length,
      missingCandidates: missingCandidates.length,
      reviewCandidates: reviewCandidates.length,
      unmatchedActual: unmatchedActual.length,
      duplicateGroups: groups.length,
      ...range,
      matchMethods: Object.fromEntries(Object.entries(matchMethods).sort()),
    },
    missingCandidates,
    reviewCandidates,
    duplicateGroups: groups,
    matched,
    unmatchedActual,
  };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeReport(result: ReconcileResult, path: string): void {
  const { summary } = result;
  const lines = [
    "# Actual account reconciliation report",
    "",
    `CSV transactions: ${summary.csvTransactions}`,
    `Actual transactions: ${summary.actualTransactions}`,
    `Matched: ${summary.matched}`,
    `Missing candidates: ${summary.missingCandidates}`,
    `Review candidates: ${summary.reviewCandidates}`,
    `Unmatched Actual rows: ${summary.unmatchedActual}`,
    `Duplicate/date amount groups: ${summary.duplicateGroups}`,
    `CSV date range: ${summary.csvDateStart ?? "n/a"} to ${summary.csvDateEnd ?? "n/a"}`,
    `Suggested Actual query range: ${summary.suggestedActualStart ?? "n/a"} to ${summary.suggestedActualEnd ?? "n/a"}`,
    "",
    "## Missing candidates",
    "",
  ];

  if (result.missingCandidates.length === 0) {
    lines.push("No missing candidates found.");
  } else {
    lines.push("| date | amount | type | description | possible near Actual |");
    lines.push("| --- | ---: | --- | --- | --- |");
    for (const item of result.missingCandidates) {
      const nearText = item.possibleNearActual
        .slice(0, 3)
        .map((row) => `${row.date} ${row.payeeName ?? ""}`.trim())
        .join("; ");
      lines.push(
        `| ${item.postingDate} | ${item.amountIdr.toFixed(2)} | ${item.direction} | ${item.description.replaceAll("|", " ")} | ${nearText} |`,
      );
    }
  }

  if (result.duplicateGroups.length > 0) {
    lines.push("", "## Duplicate/date amount groups", "");
    lines.push("| date | amount | CSV count | Actual count | delta |");
    lines.push("| --- | ---: | ---: | ---: | ---: |");
    for (const item of result.duplicateGroups) {
      lines.push(`| ${item.date} | ${item.amountIdr.toFixed(2)} | ${item.csvCount} | ${item.actualCount} | ${item.deltaCsvMinusActual} |`);
    }
  }

  writeFileSync(path, `${lines.join("\n")}\n`);
}

function actualQueryCommand(range: ReturnType<typeof csvDateRange>, accountId: string): string {
  if (!range.suggestedActualStart || !range.suggestedActualEnd) throw new Error("CSV has no transaction date range");
  const filter = JSON.stringify({
    account: accountId,
    date: { $gte: range.suggestedActualStart, $lte: range.suggestedActualEnd },
    is_parent: false,
  });
  return [
    "mkdir -p .reconcile/bca/latest",
    "bunx @actual-app/cli@latest query run \\",
    "  --table transactions \\",
    "  --select 'id,date,amount,payee.name,notes,imported_id,cleared' \\",
    `  --filter '${filter}' \\`,
    "  --order-by 'date:asc' \\",
    "  --format json \\",
    "  > .reconcile/bca/latest/actual-query.json",
  ].join("\n");
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    outDir: ".reconcile/bca/latest",
    nearDays: 3,
    actualEndPaddingDays: 3,
    printDateRange: false,
    printActualQuery: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = () => {
      const value = argv[index + 1];
      if (!value) throw new Error(`Missing value for ${arg}`);
      index += 1;
      return value;
    };

    if (arg === "--csv") options.csvPath = next();
    else if (arg === "--actual-json") options.actualJsonPath = next();
    else if (arg === "--out-dir") options.outDir = next();
    else if (arg === "--near-days") options.nearDays = Number(next());
    else if (arg === "--actual-end-padding-days") options.actualEndPaddingDays = Number(next());
    else if (arg === "--print-date-range") options.printDateRange = true;
    else if (arg === "--print-actual-query") options.printActualQuery = true;
    else if (arg === "--account-id") options.accountId = next();
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp(): void {
  console.log(`Compare a KlikBCA Mutasi Rekening CSV with Actual BCA transactions.

Usage:
  bun run .agents/skills/reconciling-actual-accounts/scripts/reconcile-actual-account.ts --csv <file> --actual-json <file> [--out-dir <dir>]
  bun run .agents/skills/reconciling-actual-accounts/scripts/reconcile-actual-account.ts --csv <file> --print-date-range
  bun run .agents/skills/reconciling-actual-accounts/scripts/reconcile-actual-account.ts --csv <file> --print-actual-query --account-id <id>

Options:
  --near-days <days>                 Same-amount review hint window. Default: 3
  --actual-end-padding-days <days>   Extend suggested Actual end date. Default: 3
  --print-date-range                 Print CSV and suggested Actual query date range
  --print-actual-query               Print the Actual query command for the CSV date range
  --account-id <id>                  Actual BCA account ID for --print-actual-query
`);
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (!options.csvPath) throw new Error("Missing --csv");

  const csvRows = parseBcaCsv(options.csvPath);
  const range = csvDateRange(csvRows, options.actualEndPaddingDays);

  if (options.printDateRange) {
    console.log(JSON.stringify(range, null, 2));
    return;
  }

  if (options.printActualQuery) {
    if (!options.accountId) throw new Error("Missing --account-id for --print-actual-query");
    console.log(actualQueryCommand(range, options.accountId));
    return;
  }

  if (!options.actualJsonPath) throw new Error("Missing --actual-json");
  const actualRows = parseActual(options.actualJsonPath);
  const result = reconcile(csvRows, actualRows, options.nearDays, options.actualEndPaddingDays);

  mkdirSync(options.outDir, { recursive: true });
  writeJson(join(options.outDir, "parsed-csv.json"), csvRows);
  writeJson(join(options.outDir, "actual-transactions.json"), actualRows);
  writeJson(join(options.outDir, "missing-candidates.json"), result.missingCandidates);
  writeJson(join(options.outDir, "review-candidates.json"), result.reviewCandidates);
  writeJson(join(options.outDir, "duplicate-groups.json"), result.duplicateGroups);
  writeJson(join(options.outDir, "reconcile-result.json"), result);
  writeReport(result, join(options.outDir, "report.md"));
  console.log(JSON.stringify(result.summary, null, 2));
}

if (import.meta.path === Bun.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
