#!/usr/bin/env bun
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

interface JagoRow {
  rowNumber: number;
  sourcePdf: string;
  sourceAccount: string;
  date: string;
  time: string | null;
  sourceTarget: string;
  detail: string;
  note: string;
  amount: number;
  balance: number | null;
  jagoIds: string[];
  rawText: string;
}

type Classification = "external" | "internal" | "unknown";

interface ClassifiedJagoRow extends JagoRow {
  classification: Classification;
  classificationReason: string;
}

interface ActualTransaction {
  id: string;
  date: string;
  amount: number;
  payeeName: string | null;
  cleared: boolean;
  reconciled: boolean;
}

interface ActualAddTransaction {
  date: string;
  amount: number;
  imported_payee: string;
  notes: string;
  imported_id: string;
  cleared: boolean;
}

interface MissingCandidate extends ClassifiedJagoRow {
  possibleNearActual: ActualTransaction[];
}

interface ApprovalCandidate {
  id: string;
  approved: boolean;
  rowNumber: number;
  sourcePdf: string;
  sourceAccount: string;
  date: string;
  amount: number;
  amountIdr: number;
  jagoId: string | null;
  sourceTarget: string;
  detail: string;
  note: string;
  riskTags: string[];
  possibleNearActual: Pick<ActualTransaction, "date" | "amount" | "payeeName">[];
  actualTransaction: ActualAddTransaction;
}

interface ReconcileResult {
  summary: {
    parsedRows: number;
    externalRows: number;
    internalRows: number;
    unknownRows: number;
    actualTransactions: number;
    matched: number;
    missingCandidates: number;
    reviewCandidates: number;
    unmatchedActual: number;
    idProblems: number;
    sourceDateStart: string | null;
    sourceDateEnd: string | null;
    suggestedActualStart: string | null;
    suggestedActualEnd: string | null;
  };
  matched: { source: ClassifiedJagoRow; actual: ActualTransaction }[];
  missingCandidates: MissingCandidate[];
  reviewCandidates: MissingCandidate[];
  unmatchedActual: ActualTransaction[];
}

interface CliOptions {
  actualJsonPath?: string;
  exportsDir: string;
  outDir: string;
  approvalJsonPath?: string;
  approvalMdPath?: string;
  actualAddOutPath?: string;
}

const MONTHS: Record<string, number> = {
  Jan: 1,
  Feb: 2,
  Mar: 3,
  Apr: 4,
  Mei: 5,
  Jun: 6,
  Jul: 7,
  Agu: 8,
  Sep: 9,
  Okt: 10,
  Nov: 11,
  Des: 12,
};

function cleanText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function compact(value: string): string {
  return cleanText(value).toLowerCase();
}

function toIsoDate(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`Invalid date: ${day} ${month} ${year}`);
  }
  return date.toISOString().slice(0, 10);
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dayDistance(leftIso: string, rightIso: string): number {
  const left = new Date(`${leftIso}T00:00:00.000Z`).getTime();
  const right = new Date(`${rightIso}T00:00:00.000Z`).getTime();
  return Math.round(Math.abs(left - right) / 86_400_000);
}

function parseIdr(value: string): number {
  const normalized = cleanText(value).replace(/^IDR\s*/i, "").replace(/\./g, "").replace(/,(\d{2})$/, ".$1");
  const match = normalized.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) throw new Error(`Invalid IDR amount: ${value}`);
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

function amountAndBalance(line: string): { sign: string; amountText: string; balanceText: string } | null {
  const match = line.match(/\s([+-])\s*([0-9][0-9.]*(?:,\d{2})?)\s+([0-9][0-9.]*(?:,\d{2})?|0)\s*$/);
  if (!match) return null;
  return { sign: match[1]!, amountText: match[2]!, balanceText: match[3]! };
}

function runPdfToText(path: string): string {
  const result = spawnSync("pdftotext", ["-layout", path, "-"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`pdftotext failed for ${path}: ${result.stderr}`);
  return result.stdout;
}

function sourceAccountFromText(text: string, path: string): string {
  const match = text.match(/^\s*(GoPay Tabungan|Kantong Utama)\s+\d+\s*$/m);
  if (!match) throw new Error(`Cannot determine Jago source account for ${path}`);
  return match[1]!;
}

export function latestBalanceFromText(text: string, path = "fixture.pdf"): { sourceAccount: string; balance: number } {
  const sourceAccount = sourceAccountFromText(text, path);
  const match = text.match(/Saldo terbaru\s+\d{2}\s+[A-Za-z]{3}\s+\d{4}\s*\n[^\n]*IDR\s+([0-9][0-9.]*(?:,\d{2})?)/);
  if (!match) throw new Error(`Cannot find latest balance in ${path}`);
  return { sourceAccount, balance: parseIdr(match[1]!) };
}

function headerPositions(text: string): { source: number; detail: number; note: number; amount: number } {
  const header = text.split(/\r?\n/).find((line) => line.includes("Tanggal & Waktu") && line.includes("Sumber/Tujuan"));
  if (!header) return { source: 18, detail: 48, note: 93, amount: 127 };
  return {
    source: header.indexOf("Sumber/Tujuan"),
    detail: header.indexOf("Rincian Transaksi"),
    note: header.indexOf("Catatan"),
    amount: header.indexOf("Jumlah"),
  };
}

function sliceColumn(line: string, start: number, end?: number): string {
  return line.length > start ? line.slice(start, end).trim() : "";
}

function isNoise(line: string): boolean {
  return /PT Bank Jago|Otoritas Jasa|Lembaga Penjamin|www\.jago\.com|Pockets Transactions History|Halaman \d+ dari|Menampilkan transaksi|Saldo terbaru|Tanggal & Waktu/.test(line);
}

export function parseJagoText(text: string, sourcePdf = "fixture.pdf"): JagoRow[] {
  const sourceAccount = sourceAccountFromText(text, sourcePdf);
  const pos = headerPositions(text);
  const lines = text.split(/\r?\n/);
  const startRe = /^\s*(\d{2})\s+([A-Za-z]{3})\s+(\d{4})\s+/;
  const starts = lines.flatMap((line, index) => (startRe.test(line) && amountAndBalance(line) ? [index] : []));
  const rows: JagoRow[] = [];

  for (let startIndex = 0; startIndex < starts.length; startIndex += 1) {
    const start = starts[startIndex]!;
    const end = starts[startIndex + 1] ?? lines.length;
    const block = lines.slice(start, end).filter((line) => line.trim() !== "" && !isNoise(line));
    const first = block[0] ?? "";
    const dateMatch = first.match(startRe);
    const amountMatch = amountAndBalance(first);
    if (!dateMatch || !amountMatch) continue;

    const month = MONTHS[dateMatch[2]!];
    if (!month) continue;
    const date = toIsoDate(Number(dateMatch[3]), month, Number(dateMatch[1]));
    const time = block.map((line) => line.match(/^\s*(\d{2}\.\d{2})\s+/)?.[1]).find(Boolean) ?? null;
    const amount = parseIdr(amountMatch.amountText) * (amountMatch.sign === "+" ? 1 : -1);
    const balance = parseIdr(amountMatch.balanceText);

    const sourceTarget = cleanText(block.map((line) => sliceColumn(line, pos.source, pos.detail)).join(" "));
    const detail = cleanText(block.map((line) => sliceColumn(line, pos.detail, pos.note)).join(" "));
    const note = cleanText(block.map((line) => sliceColumn(line, pos.note, pos.amount)).join(" "));
    const rawText = block.join("\n");
    const jagoIds = [...rawText.matchAll(/ID#\s*([A-Za-z0-9-]+)/g)].map((match) => match[1]!);

    rows.push({
      rowNumber: rows.length + 1,
      sourcePdf: basename(sourcePdf),
      sourceAccount,
      date,
      time,
      sourceTarget,
      detail,
      note,
      amount,
      balance,
      jagoIds,
      rawText,
    });
  }
  return rows;
}

export function classify(row: JagoRow): ClassifiedJagoRow {
  const text = compact(`${row.sourceTarget} ${row.detail} ${row.note}`);
  const internalRules: [string, string][] = [
    ["pindah uang antar kantong", "pocket transfer"],
    ["tambah uang kantong", "add pocket money"],
    ["tarik uang kantong", "withdraw pocket money"],
    ["auto sweep", "auto sweep"],
    ["pencairan dana dari gopay", "gopay sweep"],
  ];
  for (const [needle, reason] of internalRules) {
    if (text.includes(needle)) return { ...row, classification: "internal", classificationReason: reason };
  }

  const externalRules: [string, string][] = [
    ["pembayaran dengan jago pay", "jago pay payment"],
    ["pembayaran qris", "qris payment"],
    ["transaksi pos", "card payment"],
    ["transfer masuk", "incoming transfer"],
    ["transfer keluar", "outgoing transfer"],
    ["penarikan tunai", "cash withdrawal"],
    ["isi saldo dompet digital", "wallet top up"],
    ["pembayaran produk digital", "digital product payment"],
    ["pengembalian dana", "refund"],
    ["pencairan dana", "fund disbursement"],
    ["psd02-r", "qris/payment code"],
    ["qrd01-r", "qris/payment code"],
    ["biaya", "fee"],
    ["bunga", "interest"],
    ["cashback", "cashback"],
    ["refund", "refund"],
  ];
  for (const [needle, reason] of externalRules) {
    if (text.includes(needle)) return { ...row, classification: "external", classificationReason: reason };
  }
  return { ...row, classification: "unknown", classificationReason: "no deterministic rule" };
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

function parseActual(path: string): ActualTransaction[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return unwrapActualRows(raw).map((row) => {
    const object = row as Record<string, unknown>;
    return {
      id: String(object.id ?? ""),
      date: String(object.date ?? ""),
      amount: Number(object.amount),
      payeeName: (object["payee.name"] ?? object.payee_name ?? null) as string | null,
      cleared: Boolean(object.cleared),
      reconciled: Boolean(object.reconciled),
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

function nearActual(row: ClassifiedJagoRow, actualRows: ActualTransaction[], days: number): ActualTransaction[] {
  return actualRows
    .filter((transaction) => transaction.amount === row.amount)
    .filter((transaction) => dayDistance(row.date, transaction.date) <= days)
    .sort((left, right) => {
      const distance = dayDistance(row.date, left.date) - dayDistance(row.date, right.date);
      return distance === 0 ? left.date.localeCompare(right.date) : distance;
    });
}

export function dateRange(rows: { date: string }[], actualEndPaddingDays: number, startDate?: string) {
  if (rows.length === 0) return { sourceDateStart: null, sourceDateEnd: null, suggestedActualStart: null, suggestedActualEnd: null };
  const dates = rows.map((row) => row.date).sort();
  const sourceDateStart = dates[0]!;
  const sourceDateEnd = dates.at(-1)!;
  return { sourceDateStart, sourceDateEnd, suggestedActualStart: startDate ?? sourceDateStart, suggestedActualEnd: addDays(sourceDateEnd, actualEndPaddingDays) };
}

export function reconcile(sourceRows: ClassifiedJagoRow[], actualRows: ActualTransaction[], nearDays: number, actualEndPaddingDays: number, startDate?: string): ReconcileResult {
  const scopedRows = sourceRows.filter((row) => !startDate || row.date >= startDate);
  const externalRows = scopedRows.filter((row) => row.classification === "external");
  const buckets = actualBuckets(actualRows);
  const matched: { source: ClassifiedJagoRow; actual: ActualTransaction }[] = [];
  const missingCandidates: MissingCandidate[] = [];

  for (const row of externalRows) {
    const bucket = buckets.get(keyFor(row.date, row.amount)) ?? [];
    const actual = bucket.shift();
    if (actual) matched.push({ source: row, actual });
    else missingCandidates.push({ ...row, possibleNearActual: nearActual(row, actualRows, nearDays) });
  }

  const unmatchedActual = [...buckets.values()].flat();
  const reviewCandidates = missingCandidates.filter((row) => row.possibleNearActual.length > 0);
  const idProblems = externalRows.filter((row) => row.jagoIds.length !== 1).length;
  const range = dateRange(externalRows, actualEndPaddingDays, startDate);

  return {
    summary: {
      parsedRows: scopedRows.length,
      externalRows: externalRows.length,
      internalRows: scopedRows.filter((row) => row.classification === "internal").length,
      unknownRows: scopedRows.filter((row) => row.classification === "unknown").length,
      actualTransactions: actualRows.length,
      matched: matched.length,
      missingCandidates: missingCandidates.length,
      reviewCandidates: reviewCandidates.length,
      unmatchedActual: unmatchedActual.length,
      idProblems,
      ...range,
    },
    matched,
    missingCandidates,
    reviewCandidates,
    unmatchedActual,
  };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function rowHash(row: ApprovalCandidate): string {
  return createHash("sha256").update(`${row.sourceAccount}\t${row.date}\t${row.amount}\t${row.sourceTarget}\t${row.detail}\t${row.note}`).digest("hex").slice(0, 12);
}

export function candidateRiskTags(row: { sourceTarget: string; detail: string; note: string; jagoIds: string[]; possibleNearActual: unknown[] }): string[] {
  const text = compact(`${row.sourceTarget} ${row.detail} ${row.note}`);
  const tags: string[] = [];
  if (/\bgrab\*/i.test(row.sourceTarget) || text.includes("transaksi pos") || text.includes("google*")) tags.push("receipt-backed");
  if (row.possibleNearActual.length > 0) tags.push("nearby-actual");
  if (row.jagoIds.length !== 1) tags.push("id-problem");
  return tags;
}

export function approvalCandidates(result: ReconcileResult): ApprovalCandidate[] {
  return result.missingCandidates.map((row) => {
    const jagoId = row.jagoIds.length === 1 ? row.jagoIds[0]! : null;
    const candidate: ApprovalCandidate = {
      id: `${row.sourcePdf.replace(/\.pdf$/i, "")}:row-${row.rowNumber}`,
      approved: false,
      rowNumber: row.rowNumber,
      sourcePdf: row.sourcePdf,
      sourceAccount: row.sourceAccount,
      date: row.date,
      amount: row.amount,
      amountIdr: row.amount / 100,
      jagoId,
      sourceTarget: row.sourceTarget,
      detail: row.detail,
      note: row.note,
      riskTags: candidateRiskTags(row),
      possibleNearActual: row.possibleNearActual.slice(0, 3).map(({ date, amount, payeeName }) => ({ date, amount, payeeName })),
      actualTransaction: {
        date: row.date,
        amount: row.amount,
        imported_payee: cleanText(row.sourceTarget || row.detail),
        notes: cleanText(`${row.detail}${row.note ? `; ${row.note}` : ""}; ${row.sourceAccount}`),
        imported_id: jagoId ? `jago-pdf:${jagoId}` : "",
        cleared: true,
      },
    };
    if (!candidate.actualTransaction.imported_id) {
      candidate.actualTransaction.imported_id = `jago-pdf:${row.sourceAccount}:${row.date}:${row.amount}:${rowHash(candidate)}`;
    }
    return candidate;
  });
}

interface BalanceFixRecommendation {
  actualClearedBalanceRupiah: number;
  bankBalanceRupiah: number;
  targetDeltaRupiah: number;
  recommendationStartDate: string | null;
  selectionRule: string;
  solutions: {
    count: number;
    sumRupiah: number;
    nearbyCount: number;
    latestDate: string;
    candidates: (ApprovalCandidate & { amountRupiah: number; nearbyCount: number })[];
  }[];
}

export function recommendBalanceFixCandidates(
  candidates: ApprovalCandidate[],
  actualClearedBalanceRupiah: number,
  bankBalanceRupiah: number,
  recommendationStartDate: string | null = null,
): BalanceFixRecommendation {
  const targetDeltaRupiah = bankBalanceRupiah - actualClearedBalanceRupiah;
  const items = candidates
    .filter((candidate) => candidate.jagoId && (!recommendationStartDate || candidate.date >= recommendationStartDate))
    .map((candidate) => ({
      ...candidate,
      amountRupiah: Math.round(candidate.amount / 100),
      nearbyCount: candidate.possibleNearActual.length,
    }));
  const solutions: BalanceFixRecommendation["solutions"] = [];

  function search(start: number, selected: typeof items, sum: number, maxCount: number): void {
    if (selected.length > maxCount) return;
    if (sum === targetDeltaRupiah && selected.length > 0) {
      solutions.push({
        count: selected.length,
        sumRupiah: sum,
        nearbyCount: selected.reduce((total, item) => total + item.nearbyCount, 0),
        latestDate: selected.map((item) => item.date).sort().at(-1) ?? "",
        candidates: selected,
      });
      return;
    }
    if (selected.length === maxCount) return;
    for (let index = start; index < items.length; index += 1) {
      search(index + 1, [...selected, items[index]!], sum + items[index]!.amountRupiah, maxCount);
    }
  }

  const maxCount = recommendationStartDate ? Math.min(20, items.length) : 6;
  for (let count = 1; count <= maxCount && solutions.length === 0; count += 1) search(0, [], 0, count);
  solutions.sort((left, right) => left.count - right.count || left.nearbyCount - right.nearbyCount || left.latestDate.localeCompare(right.latestDate));
  return {
    actualClearedBalanceRupiah,
    bankBalanceRupiah,
    targetDeltaRupiah,
    recommendationStartDate,
    selectionRule: "smallest candidate count; exact target delta; prefer no nearby Actual hints; earliest latest date",
    solutions: solutions.slice(0, 10),
  };
}

function writeBalanceFixMarkdown(recommendation: BalanceFixRecommendation, path: string): void {
  const lines = [
    "# Recommended Jago balance-fix candidates",
    "",
    `These candidate sets exactly sum to ${recommendation.targetDeltaRupiah} IDR, the difference needed to move Actual cleared balance from ${recommendation.actualClearedBalanceRupiah} to ${recommendation.bankBalanceRupiah}.`,
    recommendation.recommendationStartDate ? `Only candidates on or after ${recommendation.recommendationStartDate} were considered.` : null,
    "They are recommendations only. Review `approval.md` before any add.",
    "",
  ];
  if (recommendation.solutions.length === 0) lines.push("No exact candidate set found.");
  for (const [index, solution] of recommendation.solutions.slice(0, 3).entries()) {
    lines.push(
      `## Option ${index + 1}`,
      "",
      `Rows: ${solution.count}`,
      `Sum: ${solution.sumRupiah} IDR`,
      `Nearby Actual hints: ${solution.nearbyCount}`,
      "",
      "| approval id | date | amount IDR | account | jago id | source/target | detail | note |",
      "| --- | --- | ---: | --- | --- | --- | --- | --- |",
    );
    for (const candidate of solution.candidates) {
      const esc = (value: unknown) => String(value ?? "").replaceAll("|", " ");
      lines.push(
        `| \`${candidate.id}\` | ${candidate.date} | ${candidate.amountRupiah} | ${esc(candidate.sourceAccount)} | ${esc(candidate.jagoId)} | ${esc(candidate.sourceTarget)} | ${esc(candidate.detail)} | ${esc(candidate.note)} |`,
      );
    }
    lines.push("");
  }
  writeFileSync(path, `${lines.join("\n")}\n`);
}

function writeRecommendedApprovalMarkdown(sourcePath: string, recommendation: BalanceFixRecommendation, targetPath: string): void {
  const ids = new Set(recommendation.solutions[0]?.candidates.map((candidate) => candidate.id) ?? []);
  const lines = checkedCopyLines(sourcePath, ids);
  writeFileSync(targetPath, `${lines.join("\n")}\n`);
}

function checkedCopyLines(sourcePath: string, checkedIds: Set<string>): string[] {
  return readFileSync(sourcePath, "utf8")
    .split(/\r?\n/)
    .map((line) => {
      if (!line.startsWith("- [ ]")) return line;
      const id = line.match(/`([^`]+)`/)?.[1];
      return id && checkedIds.has(id) ? line.replace("- [ ]", "- [x]") : line;
    });
}

function writeSafeBackfillApprovalMarkdown(candidates: ApprovalCandidate[], recommendation: BalanceFixRecommendation, targetPath: string): void {
  const safeCandidates = candidates.filter((candidate) => candidate.riskTags.length === 0);
  const safeSolution = recommendation.solutions.find((solution) => solution.candidates.every((candidate) => candidate.riskTags.length === 0));
  const checkedIds = new Set(safeSolution?.candidates.map((candidate) => candidate.id) ?? []);
  const lines = [
    "# Safe Jago PDF backfill approvals",
    "",
    "Only rows without receipt/id/nearby-Actual risk tags are listed here.",
    "Rows are pre-checked only when they exactly fix the balance.",
    "Use `ledger-requeue-candidates.md` first for receipt-backed rows.",
    "",
  ];
  if (safeCandidates.length === 0) lines.push("No safe PDF backfill candidates found.");
  for (const candidate of safeCandidates) lines.push(...approvalCandidateLines(candidate, checkedIds.has(candidate.id)));
  writeFileSync(targetPath, `${lines.join("\n")}\n`);
}

function writeLedgerRequeueMarkdown(candidates: ApprovalCandidate[], path: string): void {
  const receiptBacked = candidates.filter((candidate) => candidate.riskTags.includes("receipt-backed"));
  const lines = [
    "# Ledger requeue candidates",
    "",
    "These rows look receipt-backed. Search Gmail/Actual first, then mark matching `ToBudget/*` emails unread instead of PDF-backfilling when possible.",
    "",
  ];
  if (receiptBacked.length === 0) lines.push("No receipt-backed candidates found.");
  else {
    lines.push("| approval id | date | amount IDR | account | risk tags | source/target | detail |", "| --- | --- | ---: | --- | --- | --- | --- |");
    for (const candidate of receiptBacked) {
      const esc = (value: unknown) => String(value ?? "").replaceAll("|", " ");
      lines.push(`| \`${candidate.id}\` | ${candidate.date} | ${candidate.amountIdr} | ${esc(candidate.sourceAccount)} | ${candidate.riskTags.join(", ")} | ${esc(candidate.sourceTarget)} | ${esc(candidate.detail)} |`);
    }
  }
  writeFileSync(path, `${lines.join("\n")}\n`);
}

function approvalCandidateLines(candidate: ApprovalCandidate, checked = false): string[] {
  const hints = candidate.possibleNearActual.map((row) => `${row.date} ${(row.amount / 100).toFixed(2)} ${row.payeeName ?? ""}`.trim()).join("; ") || "none";
  return [
    `- [${checked ? "x" : " "}] \`${candidate.id}\` ${candidate.date} ${candidate.amountIdr.toFixed(2)} ${candidate.sourceAccount} ${candidate.sourceTarget} ${candidate.detail}`,
    `  - Jago ID: ${candidate.jagoId ?? "missing"}; source: ${candidate.sourcePdf}; row: ${candidate.rowNumber}`,
    `  - Risk tags: ${candidate.riskTags.join(", ") || "none"}`,
    `  - Note: ${candidate.note || "none"}`,
    `  - Nearby Actual: ${hints}`,
  ];
}

function writeApprovalMarkdown(candidates: ApprovalCandidate[], path: string): void {
  const lines = [
    "# Jago missing transaction approvals",
    "",
    "Check rows to approve, then tell the agent when ready. Wait for final confirmation before anything is added to Actual.",
    "Details live in approval-candidates.json and report.md.",
    "",
  ];
  for (const candidate of candidates) lines.push(...approvalCandidateLines(candidate));
  writeFileSync(path, `${lines.join("\n")}\n`);
}

function checkedApprovalIds(path: string): Set<string> {
  return new Set(
    readFileSync(path, "utf8")
      .split(/\r?\n/)
      .flatMap((line) => line.match(/^- \[[xX]\] `([^`]+)`/)?.[1] ?? []),
  );
}

export function approvedTransactions(path: string, markdownPath?: string): ActualAddTransaction[] {
  const candidates = JSON.parse(readFileSync(path, "utf8")) as ApprovalCandidate[];
  const approvedIds = markdownPath ? checkedApprovalIds(markdownPath) : null;
  const selected = candidates.filter((candidate) => (approvedIds ? approvedIds.has(candidate.id) : candidate.approved));
  if (selected.length === 0) throw new Error("No approved transactions found");
  const invalid = selected.filter((candidate) => !candidate.jagoId);
  if (invalid.length > 0) throw new Error(`Approved Jago rows missing exactly one Jago ID: ${invalid.map((row) => row.id).join(", ")}`);
  return selected.map((candidate) => candidate.actualTransaction);
}

function writeReport(result: ReconcileResult, path: string): void {
  const { summary } = result;
  const lines = [
    "# Jago Actual reconciliation report",
    "",
    `Parsed rows: ${summary.parsedRows}`,
    `External rows: ${summary.externalRows}`,
    `Internal rows: ${summary.internalRows}`,
    `Unknown rows: ${summary.unknownRows}`,
    `Actual transactions: ${summary.actualTransactions}`,
    `Matched: ${summary.matched}`,
    `Missing candidates: ${summary.missingCandidates}`,
    `Review candidates: ${summary.reviewCandidates}`,
    `Unmatched Actual rows: ${summary.unmatchedActual}`,
    `External ID problems: ${summary.idProblems}`,
    `Source date range: ${summary.sourceDateStart ?? "n/a"} to ${summary.sourceDateEnd ?? "n/a"}`,
    `Suggested Actual query range: ${summary.suggestedActualStart ?? "n/a"} to ${summary.suggestedActualEnd ?? "n/a"}`,
    "",
    "## Missing candidates",
    "",
  ];

  if (result.missingCandidates.length === 0) {
    lines.push("No missing candidates found.");
  } else {
    lines.push("| date | amount | account | source/target | detail | possible near Actual |");
    lines.push("| --- | ---: | --- | --- | --- | --- |");
    for (const item of result.missingCandidates) {
      const nearText = item.possibleNearActual.slice(0, 3).map((row) => `${row.date} ${row.payeeName ?? ""}`.trim()).join("; ");
      lines.push(
        `| ${item.date} | ${(item.amount / 100).toFixed(2)} | ${item.sourceAccount} | ${item.sourceTarget.replaceAll("|", " ")} | ${item.detail.replaceAll("|", " ")} | ${nearText} |`,
      );
    }
  }
  writeFileSync(path, `${lines.join("\n")}\n`);
}

function jagoPdfPaths(exportsDir: string): string[] {
  const pdfPaths = readdirSync(exportsDir).filter((name) => name.toLowerCase().endsWith(".pdf")).map((name) => join(exportsDir, name));
  if (pdfPaths.length !== 2) throw new Error(`Expected exactly 2 Jago PDFs, found ${pdfPaths.length}`);
  return pdfPaths.sort();
}

function lastReconciledDate(actualRows: ActualTransaction[]): string | null {
  return actualRows.filter((row) => row.reconciled).map((row) => row.date).sort().at(-1) ?? null;
}

function actualClearedBalanceRupiah(actualRows: ActualTransaction[]): number {
  return actualRows.filter((row) => row.cleared).reduce((total, row) => total + row.amount, 0) / 100;
}

function bankBalanceRupiah(parsedPdfs: { text: string; path: string }[]): number {
  const balances = parsedPdfs.map((pdf) => latestBalanceFromText(pdf.text, pdf.path));
  const accounts = balances.map((balance) => balance.sourceAccount).sort();
  if (accounts.join("|") !== "GoPay Tabungan|Kantong Utama") throw new Error(`Expected one GoPay Tabungan PDF and one Kantong Utama PDF, got ${accounts.join(", ")}`);
  return balances.reduce((total, balance) => total + balance.balance, 0) / 100;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { exportsDir: "exports/jago", outDir: ".reconcile/jago/latest" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = () => {
      const value = argv[index + 1];
      if (!value) throw new Error(`Missing value for ${arg}`);
      index += 1;
      return value;
    };
    if (arg === "--actual-json") options.actualJsonPath = next();
    else if (arg === "--exports-dir") options.exportsDir = next();
    else if (arg === "--out-dir") options.outDir = next();
    else if (arg === "--approval-json") options.approvalJsonPath = next();
    else if (arg === "--approval-md") options.approvalMdPath = next();
    else if (arg === "--actual-add-out") options.actualAddOutPath = next();
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp(): void {
  console.log(`Compare Jago PDF exports with Actual Jago transactions.

Usage:
  bun run .agents/skills/reconciling-actual-accounts/scripts/reconcile-jago-pdfs.ts --actual-json <file> [--exports-dir exports/jago] [--out-dir <dir>]
  bun run .agents/skills/reconciling-actual-accounts/scripts/reconcile-jago-pdfs.ts --approval-json <file> --approval-md <file> --actual-add-out <file>
`);
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (options.approvalJsonPath) {
    if (!options.actualAddOutPath) throw new Error("Missing --actual-add-out");
    writeJson(options.actualAddOutPath, approvedTransactions(options.approvalJsonPath, options.approvalMdPath));
    return;
  }
  if (!options.actualJsonPath) throw new Error("Missing --actual-json");

  const pdfPaths = jagoPdfPaths(options.exportsDir);
  const parsedPdfs = pdfPaths.map((path) => ({ path, text: runPdfToText(path) }));
  const parsedRows = parsedPdfs.flatMap((pdf) => parseJagoText(pdf.text, pdf.path));
  const classifiedRows = parsedRows.map(classify);
  const actualRows = parseActual(options.actualJsonPath);
  const reconciliationStartDate = lastReconciledDate(actualRows);
  if (!reconciliationStartDate) throw new Error("No reconciled Actual transaction found.");

  const actualEndPaddingDays = 3;
  const nearDays = 3;
  const externalRange = dateRange(classifiedRows.filter((row) => row.classification === "external"), actualEndPaddingDays, reconciliationStartDate);
  const actualRowsInRange = actualRows.filter((row) => row.date >= reconciliationStartDate && (!externalRange.suggestedActualEnd || row.date <= externalRange.suggestedActualEnd));
  const result = reconcile(classifiedRows, actualRowsInRange, nearDays, actualEndPaddingDays, reconciliationStartDate);
  const candidates = approvalCandidates(result);
  const actualBalance = actualClearedBalanceRupiah(actualRows);
  const bankBalance = bankBalanceRupiah(parsedPdfs);
  const recommendation = recommendBalanceFixCandidates(candidates, actualBalance, bankBalance, reconciliationStartDate);

  mkdirSync(options.outDir, { recursive: true });
  writeJson(join(options.outDir, "approval-candidates.json"), candidates);
  const approvalPath = join(options.outDir, "approval.md");
  writeApprovalMarkdown(candidates, approvalPath);
  writeBalanceFixMarkdown(recommendation, join(options.outDir, "recommended-balance-fix-candidates.md"));
  writeRecommendedApprovalMarkdown(approvalPath, recommendation, join(options.outDir, "recommended-approval.md"));
  writeSafeBackfillApprovalMarkdown(candidates, recommendation, join(options.outDir, "safe-pdf-backfill-approval.md"));
  writeLedgerRequeueMarkdown(candidates, join(options.outDir, "ledger-requeue-candidates.md"));
  writeReport(result, join(options.outDir, "report.md"));
  console.log(JSON.stringify({ ...result.summary, reconciliationStartDate, actualClearedBalanceRupiah: actualBalance, bankBalanceRupiah: bankBalance, targetDeltaRupiah: recommendation.targetDeltaRupiah, recommendedSets: recommendation.solutions.length }, null, 2));
}

if (import.meta.path === Bun.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
