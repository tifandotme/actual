#!/usr/bin/env bun
// Reconciles Actual accounts against bank exports.
//   plan  : reads exports + Actual (read-only), writes <run>/PLAN.md and <run>/plan.json
//   apply : backs up, applies plan.json, verifies balances, locks the accounts
// Amounts are Actual integers (IDR x 100) throughout.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// ---------- configuration ----------

const BCA = "BCA";
const JAGO = "Jago (Utama+GoPay)";
const SHOPEEPAY = "ShopeePay";
const CASH = "Cash";
const MATCH_DAYS = 4;
const REDATE_DAYS = 31;
/** Largest bank fee (cents) an n8n "…admin" row can be; myBCA fees are a few thousand rupiah. */
const MAX_FEE = 1_000_000;

interface Rule {
  account: string;
  test: RegExp;
  transfer?: string;
  payee?: string;
  schedule?: string;
}

/** First matching rule decides how a missing bank row is booked. Unmatched rows keep the bank text as imported_payee. */
const RULES: Rule[] = [
  { account: BCA, test: /KR OTOMATIS.*Hadl/i, payee: "Hadl" },
  { account: BCA, test: /BI-FAST (DB|CR).*TRANSFER.*TIFAN DWI AVIANTO/i, transfer: JAGO },
  { account: BCA, test: /TARIKAN ATM/i, transfer: CASH },
  { account: BCA, test: /SHOPEEPAY/i, transfer: SHOPEEPAY },
  { account: BCA, test: /AIRPAY INTERNATION/i, payee: "Shopee Indonesia" },
  { account: BCA, test: /BIAYA TXN|BIAYA ADM|^BUNGA|KOREKSI BUNGA|PAJAK BUNGA/i, payee: "BCA" },
  { account: JAGO, test: /Pencairan Reksa Dana/i, transfer: "Dana Darurat" },
  { account: JAGO, test: /TIFAN DWI AVIANTO.*BCA/i, transfer: BCA },
  { account: JAGO, test: /^Grab\*/i, payee: "Grab" },
  { account: JAGO, test: /CLOUDFLARE/i, payee: "Cloudflare", schedule: "Cloudflare Domain (tifan.me)" },
  { account: JAGO, test: /ANTHROPIC/i, payee: "Anthropic, Pbc" },
  { account: JAGO, test: /^GoPay .*Pembayaran dengan Jago/i, payee: "Gopay" },
  { account: SHOPEEPAY, test: /Top ?Up.*BCA/i, transfer: BCA },
  { account: SHOPEEPAY, test: /Shopee (Marketplace|VIP)/i, payee: "Shopee Indonesia" },
];

// ---------- small helpers ----------

export interface SourceRow {
  ref: string;
  date: string;
  amount: number;
  description: string;
  /** Running balance after this row within its pocket, when the export prints one. */
  balance: number | null;
  pocket: string;
  importedId?: string;
  /** Moves money inside the merged account (Jago pocket moves, reversal pairs): counts for day-end balances only. */
  internal?: boolean;
}

const clean = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();
const days = (a: string, b: string) => Math.round(Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000);
const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);
const idr = (c: number) => (c / 100).toLocaleString("en-US", { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 });
const localDate = (ms: number) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" });

/** "3,386,211.95", "3.386.211,95", "61000" -> cents. The last separator followed by 1-2 digits is the decimal point. */
export function parseBalance(text: string): number {
  const t = text.trim().replace(/^Rp\s*/i, "");
  const m = t.match(/^(-?[\d.,]*?)(?:[.,](\d{1,2}))?$/);
  if (!m || !/\d/.test(t)) throw new Error(`Cannot read balance "${text}"`);
  return Number(m[1]!.replace(/[.,]/g, "") || 0) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

function pdfText(path: string): string {
  const r = spawnSync("pdftotext", ["-layout", path, "-"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`pdftotext failed for ${path}: ${r.stderr}`);
  return r.stdout;
}

const listFiles = (dir: string, ext: RegExp) => (existsSync(dir) ? readdirSync(dir).filter((f) => ext.test(f)).sort().map((f) => join(dir, f)) : []);

// ---------- BCA: BCA Mobile monthly statement PDF ----------

const ID_MONTHS: Record<string, number> = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MEI: 5, JUN: 6, JUL: 7, AGU: 8, AGT: 8, SEP: 9, OKT: 10, NOV: 11, DES: 12 };
const bcaCents = (s: string) => Math.round(Number(s.replace(/,/g, "")) * 100);

/** Parses one statement and proves it against its own running balances and SALDO AKHIR. */
export function parseBcaStatement(text: string, fileName: string) {
  const period = fileName.match(/_([A-Z]{3})_(\d{4})\.pdf$/i);
  const month = period && ID_MONTHS[period[1]!.toUpperCase()];
  if (!period || !month) throw new Error(`Statement name must end _<MON>_<YYYY>.pdf (BCA default): ${fileName}`);
  const year = Number(period[2]);
  const lines = text.split("\n");
  const start = /^\s{4,}(\d{2})\/(\d{2})\s{2,}(\S.*)$/;
  const money = /([\d,]+\.\d{2})(\s+DB)?(?:\s+([\d,]+\.\d{2}))?\s*$/;
  const rows: SourceRow[] = [];
  let bal: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i]!.match(start);
    if (!s) continue;
    const body = s[3]!;
    const m = body.match(money);
    if (/^SALDO AWAL/.test(body)) {
      bal = bcaCents(m![1]!);
      continue;
    }
    if (bal == null) throw new Error(`${fileName}: SALDO AWAL missing`);
    if (!m) throw new Error(`${fileName} line ${i + 1}: no amount in "${body}"`);
    const desc = [body.slice(0, body.length - m[0].length)];
    for (let j = i + 1; j < lines.length && lines[j]!.trim() !== "" && !start.test(lines[j]!); j++) desc.push(lines[j]!);
    bal += bcaCents(m[1]!) * (m[2] ? -1 : 1);
    if (m[3] && bcaCents(m[3]) !== bal) throw new Error(`${fileName} line ${i + 1}: running balance ${idr(bal)} but statement prints ${m[3]}`);
    if (Number(s[2]) !== month) throw new Error(`${fileName} line ${i + 1}: row month ${s[2]} outside statement period`);
    rows.push({ ref: `BCA statement ${period[1]!.toUpperCase()} ${year} line ${i + 1}`, date: `${year}-${s[2]}-${s[1]}`, amount: bcaCents(m[1]!) * (m[2] ? -1 : 1), description: clean(desc.join(" ")), balance: bal, pocket: "main" });
  }
  const closing = text.match(/SALDO AKHIR\s*:\s*([\d,]+\.\d{2})/);
  if (bal == null || !closing) throw new Error(`${fileName}: SALDO AWAL or SALDO AKHIR missing`);
  if (bal !== bcaCents(closing[1]!)) throw new Error(`${fileName}: rows end at ${idr(bal)} but SALDO AKHIR is ${closing[1]}`);
  const from = `${year}-${String(month).padStart(2, "0")}-01`;
  const to = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { from, to, rows };
}

// ---------- BCA: KlikBCA Mutasi Rekening CSV ----------

function csvFields(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && quoted && line[i + 1] === '"') {
      field += '"';
      i++;
    } else if (c === '"' && (quoted || field === "")) {
      // KlikBCA leaves fields unquoted, so a quote inside a description (`QR 037 "NUR AISYA`) is literal.
      quoted = !quoted;
    } else if (c === "," && !quoted) {
      out.push(field);
      field = "";
    } else field += c;
  }
  out.push(field);
  return out;
}

export function parseKlikbcaCsv(text: string, fileName: string) {
  const rows: SourceRow[] = [];
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  lines.forEach((line, i) => {
    const f = csvFields(line);
    const d = clean(f[0]).replace(/^'/, "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    const dir = clean(f[4]);
    if (!d || (dir !== "CR" && dir !== "DB")) return;
    rows.push({ ref: `BCA CSV ${basename(fileName)} row ${i + 1}`, date: `${d[3]}-${d[2]}-${d[1]}`, amount: bcaCents(clean(f[3])) * (dir === "CR" ? 1 : -1), description: clean(f[1]), balance: bcaCents(clean(f[5])), pocket: "main" });
  });
  if (!rows.length) throw new Error(`${fileName}: no transaction rows`);
  rows.forEach((r, i) => {
    if (i > 0 && rows[i - 1]!.balance! + r.amount !== r.balance) throw new Error(`${r.ref}: balance ${idr(r.balance!)} does not follow from the row before; a row was not parsed`);
  });
  return { from: rows[0]!.date, to: rows.at(-1)!.date, rows };
}

/** Statements win over CSVs; a later CSV wins over an earlier one. Segments must chain balance to balance. */
export function loadBca(dir: string): { rows: SourceRow[]; from: string; to: string } {
  const segs = [
    ...listFiles(join(dir, "statements"), /\.pdf$/i).map((p) => ({ rank: 0, ...parseBcaStatement(pdfText(p), basename(p)) })),
    ...listFiles(join(dir, "klikbca"), /\.csv$/i).map((p) => ({ rank: 1, ...parseKlikbcaCsv(readFileSync(p, "utf8"), p) })),
  ];
  if (!segs.length) throw new Error(`No BCA exports in ${dir}/statements or ${dir}/klikbca (see MANUAL.md)`);
  const covered: { from: string; to: string }[] = [];
  const taken: SourceRow[] = [];
  for (const s of [...segs].sort((a, b) => a.rank - b.rank || b.to.localeCompare(a.to))) {
    const fresh = s.rows.filter((r) => !covered.some((c) => r.date >= c.from && r.date <= c.to));
    taken.push(...fresh);
    if (fresh.length) covered.push(s.rank === 0 ? { from: s.from, to: s.to } : { from: fresh[0]!.date, to: fresh.at(-1)!.date });
  }
  taken.sort((a, b) => a.date.localeCompare(b.date));
  // Where one export hands over to the next, the balances must chain.
  let prev: SourceRow | null = null;
  for (const r of taken) {
    if (prev && r.balance! - r.amount !== prev.balance && prev.ref.replace(/ (line|row) \d+$/, "") !== r.ref.replace(/ (line|row) \d+$/, ""))
      throw new Error(`BCA exports do not chain: ${prev.ref} ends at ${idr(prev.balance!)}, ${r.ref} starts at ${idr(r.balance! - r.amount)}. An export is missing between ${prev.date} and ${r.date} (see MANUAL.md).`);
    prev = r;
  }
  return { rows: taken, from: covered.map((c) => c.from).sort()[0]!, to: taken.at(-1)!.date };
}

// ---------- Jago: Kantong Utama + GoPay Tabungan PDFs ----------

const jagoDate = (d: string, mon: string, y: string, path: string) => {
  const month = ID_MONTHS[mon.toUpperCase()];
  if (!month) throw new Error(`Unknown Jago month "${mon}" in ${path}`);
  return `${y}-${String(month).padStart(2, "0")}-${d}`;
};

function jagoIdr(value: string): number {
  const n = clean(value).replace(/^IDR\s*/i, "").replace(/\./g, "").replace(/,(\d{2})$/, ".$1");
  const m = n.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) throw new Error(`Invalid IDR amount: ${value}`);
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

function amountAndBalance(line: string) {
  const m = line.match(/\s([+-])\s*([0-9][0-9.]*(?:,\d{2})?)\s+([0-9][0-9.]*(?:,\d{2})?|0)\s*$/);
  return m ? { sign: m[1]!, amount: m[2]!, balance: m[3]! } : null;
}

export function jagoPocket(text: string, path = "fixture.pdf"): string {
  const m = text.match(/^\s*(GoPay Tabungan|Kantong Utama)\s+\d+\s*$/m);
  if (!m) throw new Error(`Cannot tell which Jago pocket ${path} is`);
  return m[1]!;
}

export function jagoLatestBalance(text: string, path = "fixture.pdf"): number {
  const m = text.match(/Saldo terbaru\s+\d{2}\s+[A-Za-z]{3}\s+\d{4}\s*\n[^\n]*IDR\s+([0-9][0-9.]*(?:,\d{2})?)/);
  if (!m) throw new Error(`Cannot find "Saldo terbaru" in ${path}`);
  return jagoIdr(m[1]!);
}

/** First day the export covers, from the "Menampilkan transaksi" range. */
export function jagoFrom(text: string, path = "fixture.pdf"): string {
  const m = text.match(/^\s*(\d{2}) ([A-Za-z]{3}) (\d{4}) - \d{2} [A-Za-z]{3} \d{4}/m);
  if (!m) throw new Error(`Cannot find the date range in ${path}`);
  return jagoDate(m[1]!, m[2]!, m[3]!, path);
}

export interface JagoRow extends SourceRow {
  sourceTarget: string;
  detail: string;
  jagoIds: string[];
}

export function parseJagoText(text: string, path = "fixture.pdf"): JagoRow[] {
  const pocket = jagoPocket(text, path);
  const header = text.split(/\r?\n/).find((l) => l.includes("Tanggal & Waktu") && l.includes("Sumber/Tujuan"));
  const pos = header
    ? { source: header.indexOf("Sumber/Tujuan"), detail: header.indexOf("Rincian Transaksi"), note: header.indexOf("Catatan") }
    : { source: 18, detail: 48, note: 93 }; // ponytail: column offsets from the 2026 PDF layout; a new layout needs new numbers
  const col = (l: string, a: number, b?: number) => (l.length > a ? l.slice(a, b).trim() : "");
  const noise = /PT Bank Jago|Otoritas Jasa|Lembaga Penjamin|www\.jago\.com|Pockets Transactions History|Halaman \d+ dari|Menampilkan transaksi|Saldo terbaru|Tanggal & Waktu/;
  const lines = text.split(/\r?\n/);
  const startRe = /^\s*(\d{2})\s+([A-Za-z]{3})\s+(\d{4})\s+/;
  // Wrapped rows (low-balance fees, BCA auto top-ups) print the amount on the line after the date.
  const amountLine = (i: number) => (amountAndBalance(lines[i]!) ? i : amountAndBalance(lines[i + 1] ?? "") ? i + 1 : -1);
  const starts = lines.flatMap((l, i) => (startRe.test(l) && amountLine(i) !== -1 ? [i] : []));
  return starts.map((start, k) => {
    const block = lines.slice(start, starts[k + 1] ?? lines.length).filter((l) => l.trim() !== "" && !noise.test(l));
    const d = block[0]!.match(startRe)!;
    const ab = amountAndBalance(lines[amountLine(start)]!)!;
    const raw = block.join("\n");
    const jagoIds = [...raw.matchAll(/ID#\s*([A-Za-z0-9-]+)/g)].map((m) => m[1]!);
    const sourceTarget = clean(block.map((l) => col(l, pos.source, pos.detail)).join(" "));
    const detail = clean(block.map((l) => col(l, pos.detail, pos.note)).join(" "));
    return {
      ref: `Jago ${pocket} ID# ${jagoIds[0] ?? `line ${start + 1}`}`,
      date: jagoDate(d[1]!, d[2]!, d[3]!, path),
      amount: jagoIdr(ab.amount) * (ab.sign === "+" ? 1 : -1),
      balance: jagoIdr(ab.balance),
      pocket,
      description: clean(`${sourceTarget} ${detail}`).replace(/ ID#.*$/, ""),
      importedId: jagoIds[0] ? `jago-pdf:${jagoIds[0]}` : undefined,
      sourceTarget,
      detail,
      jagoIds,
    };
  });
}

/** Internal rows move money between the two pockets of the merged account; they never reach Actual. */
export function isJagoInternal(r: JagoRow): boolean {
  const t = `${r.sourceTarget} ${r.detail}`.toLowerCase();
  if (t.includes("pencairan dana dari gopay")) return false; // GoPay wallet sweep: money entering the account
  return /pindah uang antar kantong|tambah uang kantong|tarik uang kantong|auto sweep/.test(t);
}

/** A card charge and its PSD02-R reversal net to zero; both legs drop out. */
export function dropReversals(rows: JagoRow[]): JagoRow[] {
  const gone = new Set<JagoRow>();
  for (const f of rows.filter((r) => /PSD02-R/.test(r.detail))) {
    const c = rows.find((r) => !gone.has(r) && r !== f && r.amount === -f.amount && days(r.date, f.date) <= 3 && r.sourceTarget.slice(0, 12) === f.sourceTarget.slice(0, 12));
    if (c) gone.add(c).add(f);
  }
  return rows.filter((r) => !gone.has(r));
}

/** `breaks` lists rows whose running balance does not follow from the row before: a row the parser missed. */
export function loadJago(dir: string): { rows: SourceRow[]; from: string; to: string; balance: number; breaks: SourceRow[] } {
  const files = listFiles(dir, /\.pdf$/i);
  const texts = files.map((p) => ({ p, t: pdfText(p) }));
  const pockets = texts.map(({ p, t }) => jagoPocket(t, p));
  if (pockets.sort().join() !== "GoPay Tabungan,Kantong Utama") throw new Error(`${dir} needs exactly one Kantong Utama and one GoPay Tabungan PDF (found: ${pockets.join(", ") || "none"})`);
  const rows: SourceRow[] = [];
  const breaks: SourceRow[] = [];
  let balance = 0;
  for (const { p, t } of texts) {
    const parsed = parseJagoText(t, p);
    breaks.push(...parsed.filter((b, i) => i > 0 && parsed[i - 1]!.balance! + b.amount !== b.balance));
    const latest = jagoLatestBalance(t, p);
    if (parsed.at(-1)?.balance !== latest) throw new Error(`${basename(p)}: last row ends at ${idr(parsed.at(-1)?.balance ?? 0)} but Saldo terbaru is ${idr(latest)}; a row was not parsed`);
    balance += latest;
    const external = new Set(dropReversals(parsed.filter((r) => !isJagoInternal(r))));
    // Internal rows and reversal pairs stay, in PDF order, for the day-end balance; matching skips them.
    rows.push(...parsed.map(({ sourceTarget: _s, detail: _d, jagoIds: _j, ...r }, i) => (external.has(parsed[i]!) ? r : { ...r, internal: true })));
  }
  rows.sort((a, b) => a.date.localeCompare(b.date)); // stable: keeps each pocket's PDF order within a day
  const from = texts.map(({ p, t }) => jagoFrom(t, p)).sort().at(-1)!; // the later pocket start bounds both
  return { rows, from, to: rows.at(-1)!.date, balance, breaks };
}

// ---------- ShopeePay: history.csv transcribed from screenshots ----------

/** `# from YYYY-MM-DD` on the first line is the oldest date the screenshots reach; every row from then on is listed. */
export function loadShopeepay(dir: string): { rows: SourceRow[]; from: string } | null {
  const path = join(dir, "history.csv");
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").trim().split(/\r?\n/);
  const from = lines[0]?.match(/^# from (\d{4}-\d{2}-\d{2})$/)?.[1];
  if (!from) throw new Error(`${path}: first line must be "# from YYYY-MM-DD", the oldest date the screenshots reach`);
  if (lines[1] !== "date,amount,description") throw new Error(`${path}: second line must be "date,amount,description"`);
  const rows = lines.slice(2).map((l, i) => {
    const [date, amount, ...rest] = l.split(",");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") || !/^-?\d+(\.\d{1,2})?$/.test(amount ?? "")) throw new Error(`${path} line ${i + 3}: expected YYYY-MM-DD,<signed IDR>,<text>`);
    if (date! < from) throw new Error(`${path} line ${i + 3}: ${date} is before "# from ${from}"`);
    return { ref: `ShopeePay history.csv line ${i + 3}`, date: date!, amount: Math.round(Number(amount) * 100), description: clean(rest.join(",")), balance: null, pocket: "main" };
  });
  return { rows, from };
}

// ---------- matching ----------

export interface ActualRow {
  id: string;
  date: string;
  amount: number;
  payeeName: string | null;
  notes: string | null;
  importedId: string | null;
  cleared: boolean;
  reconciled: boolean;
  transferId: string | null;
  planned?: boolean;
}

export interface MatchResult {
  pairs: { src: SourceRow; act: ActualRow[]; kind: "same-day" | "shifted" | "split" | "redate" }[];
  missing: SourceRow[];
  extra: ActualRow[];
}

/**
 * Exact date first, then nearest within MATCH_DAYS, then two Actual rows summing to one bank row, then a far same-amount row to redate.
 * ponytail: greedy and O(source x Actual) per pass; fine for a few hundred rows a month. If wrong pairs show up, switch to assignment by total date distance.
 */
export function matchRows(src: SourceRow[], act: ActualRow[]): MatchResult {
  const used = new Set<string>();
  const done = new Set<SourceRow>();
  const pairs: MatchResult["pairs"] = [];
  const sorted = [...src].sort((a, b) => a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref));
  const free = (s: SourceRow, maxDays: number) =>
    act.filter((a) => !used.has(a.id) && days(a.date, s.date) <= maxDays).sort((x, y) => days(x.date, s.date) - days(y.date, s.date) || x.id.localeCompare(y.id));
  for (const maxDays of [0, MATCH_DAYS]) {
    for (const s of sorted) {
      if (done.has(s)) continue;
      const c = free(s, maxDays).find((a) => a.amount === s.amount);
      if (c) {
        used.add(c.id);
        done.add(s);
        pairs.push({ src: s, act: [c], kind: maxDays === 0 ? "same-day" : "shifted" });
      }
    }
  }
  for (const s of sorted) {
    if (done.has(s)) continue;
    const near = free(s, 1);
    pair: for (let i = 0; i < near.length; i++)
      for (let j = i + 1; j < near.length; j++)
        if (near[i]!.amount + near[j]!.amount === s.amount && Math.sign(near[i]!.amount) === Math.sign(s.amount)) {
          used.add(near[i]!.id).add(near[j]!.id);
          done.add(s);
          pairs.push({ src: s, act: [near[i]!, near[j]!], kind: "split" });
          break pair;
        }
  }
  for (const s of sorted) {
    if (done.has(s)) continue;
    const c = free(s, REDATE_DAYS).find((a) => a.amount === s.amount && !a.reconciled && !a.planned);
    if (c) {
      used.add(c.id);
      done.add(s);
      pairs.push({ src: s, act: [c], kind: "redate" });
    }
  }
  return { pairs, missing: sorted.filter((s) => !done.has(s)), extra: act.filter((a) => !used.has(a.id)) };
}

// ---------- Actual session ----------

/** The global `actual` CLI bundles @actual-app/api; use that copy so CLI and script share one version. */
async function openActual() {
  const bin = Bun.which("actual");
  if (!bin) throw new Error("The `actual` CLI is not on PATH");
  const api: any = await import(join(dirname(realpathSync(bin)), "../../api/dist/index.js"));
  const { ACTUAL_SERVER_URL, ACTUAL_PASSWORD, ACTUAL_SYNC_ID } = process.env;
  if (!ACTUAL_SERVER_URL || !ACTUAL_PASSWORD || !ACTUAL_SYNC_ID) throw new Error("ACTUAL_SERVER_URL, ACTUAL_PASSWORD and ACTUAL_SYNC_ID must be set (.env)");
  const dataDir = JSON.parse(readFileSync("actual.config.json", "utf8")).dataDir ?? ".actual-cache";
  mkdirSync(dataDir, { recursive: true });
  // Cloud Run may be cold: warm it and retry the login a few times before failing.
  for (let attempt = 1; ; attempt++) {
    try {
      await fetch(`${ACTUAL_SERVER_URL}/info`).catch(() => {});
      await api.init({ dataDir, serverURL: ACTUAL_SERVER_URL, password: ACTUAL_PASSWORD });
      await api.downloadBudget(ACTUAL_SYNC_ID, process.env.ACTUAL_ENCRYPTION_PASSWORD ? { password: process.env.ACTUAL_ENCRYPTION_PASSWORD } : undefined);
      break;
    } catch (e) {
      await api.shutdown().catch(() => {});
      if (attempt === 4) throw e;
      await Bun.sleep(attempt * 3000);
    }
  }
  return { api, dataDir };
}

async function readActual(api: any) {
  const accounts: any[] = (await api.aqlQuery(api.q("accounts").filter({ tombstone: false }).select(["id", "name", "offbudget", "closed", "last_reconciled"]))).data;
  const payees: any[] = await api.getPayees();
  const payeeName = new Map(payees.map((p) => [p.id, p.name]));
  const txns: any[] = (
    await api.aqlQuery(
      api.q("transactions").filter({ is_parent: false }).select(["id", "account", "date", "amount", "payee", "category", "notes", "imported_id", "cleared", "reconciled", "transfer_id", "schedule"]).options({ splits: "inline" }),
    )
  ).data;
  const rowsByAccount = new Map<string, ActualRow[]>();
  for (const t of txns)
    (rowsByAccount.get(t.account) ?? rowsByAccount.set(t.account, []).get(t.account)!).push({
      id: t.id,
      date: t.date,
      amount: t.amount,
      payeeName: payeeName.get(t.payee) ?? null,
      notes: t.notes,
      importedId: t.imported_id,
      cleared: !!t.cleared,
      reconciled: !!t.reconciled,
      transferId: t.transfer_id,
    });
  // Latest category used with each payee, so new rows look like the ones n8n imports.
  const lastCategory = new Map<string, string>();
  for (const t of [...txns].sort((a, b) => a.date.localeCompare(b.date))) if (t.payee && t.category) lastCategory.set(t.payee, t.category);
  const schedules: any[] = await api.getSchedules();
  return { accounts, payees, rowsByAccount, lastCategory, schedules };
}

// ---------- plan ----------

export type ActualData = Awaited<ReturnType<typeof readActual>>;

interface Add {
  ref: string;
  date: string;
  amount: number;
  description: string;
  kind: "transfer" | "schedule" | "payee" | "unlabelled" | "adjustment";
  txn: Record<string, unknown>;
  transferTo?: string;
  schedule?: string;
}

export interface Decisions {
  skip?: string[];
  override?: Record<string, { transfer?: string; payee?: string; schedule?: string; date?: string }>;
  delete?: { id: string; reason: string }[];
  keep?: string[];
  update?: { id: string; fields: Record<string, unknown>; reason: string }[];
  adjust?: Record<string, string>;
  /** Account name -> why its day-end check gaps are expected. */
  dayEnd?: Record<string, string>;
}

export interface Source {
  rows: SourceRow[] | null;
  /** First day the exports cover; the run blocks when this is after the last reconcile. */
  from: string | null;
  to: string | null;
  target: number | null;
  label: string;
  breaks?: SourceRow[];
}

export interface AccountPlan {
  name: string;
  id: string;
  lockDate: string;
  now: number;
  target: number | null;
  targetLabel: string;
  after: number;
  adds: Add[];
  deletes: { id: string; date: string; amount: number; label: string; reason: string }[];
  updates: { id: string; date: string; amount: number; label: string; fields: Record<string, unknown>; reason: string }[];
  matched: Record<string, number>;
  blockers: string[];
  checks: string[];
}

/** Decides every change from Actual's rows and the exports. Reads and writes nothing, so tests can drive it. */
export function buildPlan(actual: ActualData, sources: Map<string, Source>, decisions: Decisions, since?: string) {
  const acctByName = new Map(actual.accounts.map((a) => [a.name, a]));
  const transferPayee = (account: string) => {
    const id = actual.payees.find((p) => p.transfer_acct === acctByName.get(account)?.id)?.id;
    if (!id) throw new Error(`No transfer payee for account "${account}"`);
    return id as string;
  };
  const payeeId = (name: string) => actual.payees.find((p) => p.name === name && !p.transfer_acct)?.id;
  const planned = new Map<string, ActualRow[]>(); // counterpart rows that planned transfers will create
  const addPlanned = (account: string, date: string, amount: number, from: string, ref: string) => {
    const row: ActualRow = { id: `planned:${ref}`, date, amount, payeeName: from, notes: `transfer from ${from}: ${ref}`, importedId: null, cleared: true, reconciled: false, transferId: "planned", planned: true };
    (planned.get(account) ?? planned.set(account, []).get(account)!).push(row);
    return row;
  };
  const plans: AccountPlan[] = [];
  const pendingUpdates = new Map<string, AccountPlan["updates"]>(); // payee links for accounts not planned yet
  const linkedTwins = new Set<string>();
  const skip = new Set(decisions.skip ?? []);
  const keep = new Set(decisions.keep ?? []);
  const today = localDate(Date.now());

  for (const [name, src] of sources) {
    const acct = acctByName.get(name);
    if (!acct) throw new Error(`No Actual account named "${name}"`);
    const all = [...(actual.rowsByAccount.get(acct.id) ?? []), ...(planned.get(name) ?? [])];
    const lockDate = since ?? (acct.last_reconciled ? localDate(Number(acct.last_reconciled)) : all.filter((r) => r.reconciled).map((r) => r.date).sort().at(-1));
    if (!lockDate) throw new Error(`${name} was never reconciled; pass --since YYYY-MM-DD`);
    const p: AccountPlan = { name, id: acct.id, lockDate, now: all.filter((r) => !r.planned).reduce((t, r) => t + r.amount, 0), target: src.target, targetLabel: src.label, after: 0, adds: [], deletes: [], updates: [], matched: {}, blockers: [], checks: [] };
    plans.push(p);
    p.updates.push(...(pendingUpdates.get(name) ?? []));
    if (src.from && src.from > lockDate) p.blockers.push(`${src.label} exports start ${src.from}, but the last reconcile is ${lockDate}. Add the missing export (see MANUAL.md); do not delete Actual rows for this gap.`);
    for (const b of src.breaks ?? []) if (b.date >= lockDate) p.blockers.push(`${b.ref} on ${b.date}: running balance does not follow from the row before; the parser missed a row.`);

    if (src.rows) {
      const inWindow = src.rows.filter((r) => r.date >= addDays(lockDate, -MATCH_DAYS) && !r.internal);
      const actWindow = all.filter((r) => r.date >= addDays(lockDate, -2 * MATCH_DAYS) && !(r.notes ?? "").startsWith("Reconciliation balance adjustment"));
      const m = matchRows(inWindow, actWindow);
      for (const pr of m.pairs) {
        p.matched[pr.kind] = (p.matched[pr.kind] ?? 0) + 1;
        const a = pr.act[0]!;
        if (pr.kind === "redate" && a.date !== pr.src.date)
          p.updates.push({ id: a.id, date: a.date, amount: a.amount, label: a.payeeName ?? a.notes ?? "", fields: { date: pr.src.date, cleared: true }, reason: `bank posted it on ${pr.src.date} (${pr.src.description})` });
        else for (const x of pr.act) if (!x.cleared && !x.planned) p.updates.push({ id: x.id, date: x.date, amount: x.amount, label: x.payeeName ?? "", fields: { cleared: true }, reason: `confirmed by ${pr.src.ref}` });
      }
      // n8n books a myBCA admin fee as its own "<email id>admin" row; the bank includes it in the payment.
      const matchedIds = new Set(m.pairs.flatMap((pr) => pr.act.map((a) => a.importedId)));
      for (const x of m.extra) {
        if (x.reconciled || x.planned || x.date < lockDate || (src.to && x.date > src.to) || keep.has(x.id)) continue;
        if (x.importedId?.endsWith("admin") && matchedIds.has(x.importedId.slice(0, -5)) && x.amount < 0 && x.amount >= -MAX_FEE)
          p.deletes.push({ id: x.id, date: x.date, amount: x.amount, label: x.payeeName ?? "", reason: "n8n fee row; the bank charged this fee inside the matched payment" });
        else if (!(decisions.delete ?? []).some((d) => d.id === x.id))
          p.blockers.push(`Actual row not in ${src.label}: ${x.date} ${idr(x.amount)} ${x.payeeName ?? x.notes ?? ""} (id ${x.id}). Decide: delete or keep.`);
      }
      for (const x of m.extra.filter((r) => r.planned)) p.blockers.push(`Planned transfer has no matching ${name} row: ${x.date} ${idr(x.amount)} (${x.notes}).`);
      for (const s of m.missing) {
        if (s.date < lockDate || skip.has(s.ref)) continue;
        const o = decisions.override?.[s.ref] ?? {};
        const rule = RULES.find((r) => r.account === name && r.test.test(s.description));
        const transfer = o.transfer ?? (o.payee ? undefined : rule?.transfer);
        // When the other account already has this movement as a plain row, turn that row into the transfer:
        // Actual then creates this side. A new transfer would duplicate the other side instead.
        const otherId = transfer ? acctByName.get(transfer)?.id : undefined;
        const twin = otherId
          ? (actual.rowsByAccount.get(otherId) ?? []).find((r) => !r.reconciled && !r.transferId && !linkedTwins.has(r.id) && r.amount === -s.amount && days(r.date, s.date) <= MATCH_DAYS)
          : undefined;
        if (transfer && twin) {
          linkedTwins.add(twin.id);
          const link = { id: twin.id, date: twin.date, amount: twin.amount, label: twin.payeeName ?? "", fields: { payee: transferPayee(name) }, reason: `transfer with ${name}; Actual creates the ${name} side (${s.ref})` };
          const other = plans.find((x) => x.name === transfer);
          if (other) other.updates.push(link);
          else (pendingUpdates.get(transfer) ?? pendingUpdates.set(transfer, []).get(transfer)!).push(link);
          all.push(addPlanned(name, twin.date, s.amount, transfer, s.ref));
          continue;
        }
        if (transfer && plans.some((x) => x.name === transfer && x !== p)) {
          p.blockers.push(`${s.ref} ${s.date} ${idr(s.amount)} is a transfer with ${transfer}, but ${transfer} has no unlinked ${idr(-s.amount)} row within ${MATCH_DAYS} days.`);
          continue;
        }
        const byAmount = transfer ? [] : actual.schedules.filter((x) => !x.completed && x.account === acct.id && x.amount === s.amount);
        const sched = actual.schedules.find((x) => x.name === (o.schedule ?? rule?.schedule)) ?? (byAmount.length === 1 ? byAmount[0] : undefined);
        const payee = transfer ? transferPayee(transfer) : ((o.payee && payeeId(o.payee)) ?? (sched?.payee as string | undefined) ?? (rule?.payee ? payeeId(rule.payee) : undefined));
        const date = o.date ?? s.date;
        const txn: Record<string, unknown> = { date, amount: s.amount, cleared: true, notes: `${s.ref}: ${s.description}`.slice(0, 250), imported_payee: s.description.slice(0, 100) };
        if (payee) txn.payee = payee;
        if (payee && !transfer && actual.lastCategory.get(payee)) txn.category = actual.lastCategory.get(payee);
        if (sched) txn.schedule = sched.id;
        if (s.importedId) txn.imported_id = s.importedId;
        p.adds.push({ ref: s.ref, date, amount: s.amount, description: s.description, kind: transfer ? "transfer" : sched ? "schedule" : payee ? "payee" : "unlabelled", txn, transferTo: transfer, schedule: sched?.name });
        if (transfer) addPlanned(transfer, date, -s.amount, name, s.ref);
      }
    }

    for (const d of decisions.delete ?? []) {
      const x = all.find((r) => r.id === d.id);
      if (x && !p.deletes.some((y) => y.id === x.id)) p.deletes.push({ id: x.id, date: x.date, amount: x.amount, label: x.payeeName ?? "", reason: d.reason });
    }
    for (const u of decisions.update ?? []) {
      const x = all.find((r) => r.id === u.id);
      if (x) p.updates.push({ id: x.id, date: x.date, amount: x.amount, label: x.payeeName ?? "", fields: u.fields, reason: u.reason });
    }

    const incoming = (planned.get(name) ?? []).reduce((t, r) => t + r.amount, 0);
    const delta = (u: AccountPlan["updates"][number]) => (typeof u.fields.amount === "number" ? u.fields.amount - u.amount : 0);
    p.after = p.now + incoming + p.adds.reduce((t, a) => t + a.amount, 0) - p.deletes.reduce((t, d) => t + d.amount, 0) + p.updates.reduce((t, u) => t + delta(u), 0);
    const residual = p.target == null ? 0 : p.target - p.after;
    if (residual !== 0) {
      const why = !src.rows ? `${src.label} balance; individual rows are not exported` : Math.abs(residual) < 100 ? "cents carried from earlier reconciles" : decisions.adjust?.[name];
      if (why) {
        p.adds.push({ ref: "adjustment", date: today, amount: residual, description: why, kind: "adjustment", txn: { date: today, amount: residual, cleared: true, notes: `Reconciliation balance adjustment: ${why}` } });
        p.after += residual;
      } else p.blockers.push(`After the plan ${name} is ${idr(p.after)} but ${src.label} says ${idr(p.target!)} (difference ${idr(residual)}). See the day-end check.`);
    }
    if (src.rows) p.checks = dayEndCheck(p, src.rows, all, lockDate);
    if (p.checks.length && !decisions.dayEnd?.[name]) p.blockers.push(`${name} drifts from ${src.label} for ${MATCH_DAYS}+ days (see Day-end check). Find the row, or record why in decisions.dayEnd.`);
  }

  const linked = [...new Set(plans.flatMap((p) => p.adds.flatMap((a) => (a.txn.schedule ? [a.txn.schedule as string] : []))))];
  return { plans, linkedSchedules: linked.map((id) => ({ id, name: actual.schedules.find((s) => s.id === id)?.name ?? id })) };
}

/** Changes whenever a row in a planned account is added, removed, or edited. */
export function fingerprint(actual: ActualData, plans: { id: string }[]): string {
  const rows = plans.map((p) => (actual.rowsByAccount.get(p.id) ?? []).map((r) => [r.id, r.date, r.amount, r.cleared, r.reconciled, r.transferId]).sort());
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

export async function plan(opts: { run: string; exports: string; balances: Map<string, number>; since?: string }) {
  for (const name of [BCA, SHOPEEPAY, CASH]) if (!opts.balances.has(name)) throw new Error(`Missing --balance "${name}=<amount>" (see MANUAL.md)`);
  const sources = new Map<string, Source>();
  const bca = loadBca(join(opts.exports, "bca"));
  sources.set(BCA, { rows: bca.rows, from: bca.from, to: bca.to, target: opts.balances.get(BCA)!, label: "BCA Mobile" });
  const jago = loadJago(join(opts.exports, "jago"));
  sources.set(JAGO, { rows: jago.rows, from: jago.from, to: jago.to, target: opts.balances.get(JAGO) ?? jago.balance, label: "Jago PDFs (Saldo terbaru)", breaks: jago.breaks });
  const sp = loadShopeepay(join(opts.exports, "shopeepay"));
  sources.set(SHOPEEPAY, { rows: sp?.rows ?? null, from: sp?.from ?? null, to: localDate(Date.now()), target: opts.balances.get(SHOPEEPAY)!, label: sp ? "ShopeePay app + history.csv" : "ShopeePay app (no history.csv)" });
  sources.set(CASH, { rows: null, from: null, to: null, target: opts.balances.get(CASH)!, label: "counted" });
  for (const [name, v] of opts.balances) if (!sources.has(name)) sources.set(name, { rows: null, from: null, to: null, target: v, label: "typed" });
  const decisionsPath = join(opts.run, "decisions.json");
  const decisions: Decisions = existsSync(decisionsPath) ? JSON.parse(readFileSync(decisionsPath, "utf8")) : {};

  const { api } = await openActual();
  let out: ReturnType<typeof buildPlan>;
  let actualState: string;
  try {
    const actual = await readActual(api);
    out = buildPlan(actual, sources, decisions, opts.since);
    actualState = fingerprint(actual, out.plans);
  } finally {
    await api.shutdown();
  }
  mkdirSync(opts.run, { recursive: true });
  // A new plan starts apply from step 1; old markers would make it skip steps this plan needs.
  for (const f of readdirSync(opts.run)) if (f.startsWith(".done-")) rmSync(join(opts.run, f));
  writeFileSync(join(opts.run, "plan.json"), JSON.stringify({ createdAt: new Date().toISOString(), actualState, ...out }, null, 2));
  writeFileSync(join(opts.run, "PLAN.md"), renderPlan(out.plans, out.linkedSchedules.map((s) => s.name)));
  return out.plans;
}

/** Day-end balance after the plan versus the export. A gap that opens and stays open marks rows still missing or wrong. */
function dayEndCheck(p: AccountPlan, src: SourceRow[], all: ActualRow[], lockDate: string): string[] {
  const eod = new Map<string, number>();
  const pockets = new Map<string, number>();
  for (const r of src) {
    if (r.balance == null) return [];
    pockets.set(r.pocket, r.balance);
    eod.set(r.date, [...pockets.values()].reduce((t, b) => t + b, 0));
  }
  const deleted = new Set(p.deletes.map((d) => d.id));
  const moved = new Map(p.updates.filter((u) => u.fields.date).map((u) => [u.id, u.fields.date as string]));
  const byDay = new Map<string, number>();
  for (const r of all) if (!deleted.has(r.id) && !r.planned) byDay.set(moved.get(r.id) ?? r.date, (byDay.get(moved.get(r.id) ?? r.date) ?? 0) + r.amount);
  for (const r of [...p.adds.filter((a) => a.kind !== "adjustment"), ...all.filter((r) => r.planned)]) byDay.set(r.date, (byDay.get(r.date) ?? 0) + r.amount);
  let bal = 0;
  const diffs: [string, number][] = [];
  for (const d of [...new Set([...byDay.keys(), ...eod.keys()])].sort()) {
    bal += byDay.get(d) ?? 0;
    if (eod.has(d) && d >= lockDate) diffs.push([d, bal - eod.get(d)!]);
  }
  if (!diffs.length) return [];
  // The usual offset is the baseline (BCA Mobile holds 10,000 the ledger still counts).
  // ponytail: the most common offset wins; if most days were wrong this flags the right ones. Upgrade: anchor on the typed balance.
  const freq = new Map<number, number>();
  for (const [, d] of diffs) freq.set(d, (freq.get(d) ?? 0) + 1);
  const base = [...freq].sort((a, b) => b[1] - a[1])[0]![0];
  const out: string[] = [];
  for (let i = 0; i < diffs.length; i++) {
    if (diffs[i]![1] === base) continue;
    let j = i;
    while (j + 1 < diffs.length && diffs[j + 1]![1] !== base) j++;
    if (days(diffs[i]![0], diffs[j]![0]) >= MATCH_DAYS) out.push(`${diffs[i]![0]} to ${diffs[j]![0]}: off by ${idr(diffs[i]![1] - base)} against the usual offset ${idr(base)}`);
    i = j;
  }
  return out;
}

function renderPlan(plans: AccountPlan[], schedules: string[]): string {
  const blocked = plans.some((p) => p.blockers.length);
  const L: string[] = [`# Reconciliation plan`, "", blocked ? "**Blocked.** Resolve the items under Blockers (agent: write decisions.json, then re-run `plan`)." : "Ready. Apply with `reconcile.ts apply`.", ""];
  L.push("| Account | From | Actual now | After plan | Bank | Bank says |", "| --- | --- | ---: | ---: | --- | ---: |");
  for (const p of plans) L.push(`| ${p.name} | ${p.lockDate} | ${idr(p.now)} | ${idr(p.after)} | ${p.targetLabel} | ${p.target == null ? "-" : idr(p.target)} |`);
  for (const p of plans) {
    const sum = (l: { amount: number }[]) => idr(l.reduce((t, x) => t + x.amount, 0));
    L.push("", `## ${p.name}`, "");
    if (Object.keys(p.matched).length) L.push(`Matched: ${Object.entries(p.matched).map(([k, v]) => `${v} ${k}`).join(", ")}.`, "");
    if (p.blockers.length) L.push("### Blockers", "", ...p.blockers.map((b) => `- ${b}`), "");
    for (const kind of ["transfer", "schedule", "payee", "unlabelled", "adjustment"] as const) {
      const g = p.adds.filter((a) => a.kind === kind);
      if (!g.length) continue;
      L.push(`### Add: ${kind} (${g.length}, ${sum(g)})`, "", ...g.map((a) => `- ${a.date} ${idr(a.amount)} ${a.transferTo ? `→ ${a.transferTo} ` : ""}${a.schedule ? `[${a.schedule}] ` : ""}${a.description}`), "");
    }
    if (p.deletes.length) L.push(`### Delete (${p.deletes.length})`, "", ...p.deletes.map((d) => `- ${d.date} ${idr(d.amount)} ${d.label}: ${d.reason}`), "");
    if (p.updates.length) L.push(`### Update (${p.updates.length})`, "", ...p.updates.map((u) => `- ${u.date} ${idr(u.amount)} ${u.label}: ${JSON.stringify(u.fields)} (${u.reason})`), "");
    if (p.checks.length) L.push("### Day-end check", "", ...p.checks.map((c) => `- ${c}`), "");
  }
  if (schedules.length) L.push("## Schedules advanced after apply", "", ...schedules.map((s) => `- ${s}`), "");
  return L.join("\n");
}

// ---------- apply ----------

export async function apply(run: string) {
  const out = JSON.parse(readFileSync(join(run, "plan.json"), "utf8"));
  const plans: AccountPlan[] = out.plans;
  if (plans.some((p) => p.blockers.length)) throw new Error("Plan is blocked; resolve PLAN.md blockers and re-run plan");
  const { api, dataDir } = await openActual();
  try {
    // A fresh apply must see Actual as the plan saw it: a row n8n imported since then would be added twice.
    // A resumed apply skips this, because its own earlier steps changed Actual.
    const started = readdirSync(run).some((f) => f.startsWith(".done-") && f !== ".done-1-backup");
    if (!started && fingerprint(await readActual(api), plans) !== out.actualState) throw new Error("Actual changed since plan.json was written; re-run plan and review it again");
    const step = async (n: string, label: string, fn: () => Promise<void>) => {
      const marker = join(run, `.done-${n}`);
      if (existsSync(marker)) return console.log(`${label}: already done`);
      console.log(label);
      await fn();
      await api.sync();
      writeFileSync(marker, new Date().toISOString());
    };
    await step("1-backup", "Back up the budget", async () => cpSync(dataDir, join(run, "backup"), { recursive: true }));
    await step("2-delete", "Delete rows", async () => {
      for (const p of plans) for (const d of p.deletes) await api.deleteTransaction(d.id);
    });
    await step("3-update", "Update rows", async () => {
      for (const p of plans) for (const u of p.updates) await api.updateTransaction(u.id, u.fields);
    });
    await step("4-add", "Add rows", async () => {
      // addTransactions does not deduplicate, so mark each account as soon as its rows are in the local budget;
      // a rerun after a failed sync skips it, and the next sync still sends the local rows.
      for (const p of plans) {
        const marker = join(run, `.done-4-add-${p.id}`);
        if (!p.adds.length || existsSync(marker)) continue;
        await api.addTransactions(p.id, p.adds.map((a) => a.txn), { runTransfers: true });
        writeFileSync(marker, new Date().toISOString());
      }
    });
    const balances = Object.fromEntries(await Promise.all(plans.map(async (p) => [p.name, await api.getAccountBalance(p.id)])));
    const wrong = plans.filter((p) => p.target != null && balances[p.name] !== p.target);
    for (const p of plans) console.log(`${p.name}: ${idr(balances[p.name])}${p.target == null ? "" : ` (bank ${idr(p.target)})`}`);
    if (wrong.length) throw new Error(`Not locking: ${wrong.map((p) => p.name).join(", ")} differ from the bank`);
    await step("5-schedules", "Advance linked schedules", async () => {
      // updateSchedule ignores resetNextDate unless a field changes; re-sending the name counts as a change.
      for (const s of out.linkedSchedules) await api.updateSchedule(s.id, { name: s.name }, true);
    });
    await step("6-lock", "Lock accounts", async () => {
      for (const p of plans.filter((x) => x.target != null)) {
        const rows: any[] = (await api.aqlQuery(api.q("transactions").filter({ account: p.id, reconciled: false }).select(["id", "cleared"]).options({ splits: "all" }))).data;
        const uncleared = rows.filter((r) => !r.cleared);
        if (uncleared.length) throw new Error(`${p.name}: ${uncleared.length} uncleared rows; not locking`);
        await api.batchBudgetUpdates(async () => {
          for (const r of rows) await api.updateTransaction(r.id, { reconciled: true });
          await api.updateAccount(p.id, { last_reconciled: String(Date.now()) });
        });
      }
    });
  } finally {
    await api.shutdown();
  }
}

// ---------- CLI ----------

if (import.meta.main) {
  const [cmd, ...argv] = process.argv.slice(2);
  const flag = (name: string) => argv.flatMap((a, i) => (a === `--${name}` ? [argv[i + 1]!] : []));
  const run = flag("run")[0] ?? join(".reconcile", localDate(Date.now()));
  if (cmd === "plan") {
    const balances = new Map(flag("balance").map((b) => {
      const i = b.lastIndexOf("=");
      return [b.slice(0, i), parseBalance(b.slice(i + 1))] as [string, number];
    }));
    const plans = await plan({ run, exports: flag("exports")[0] ?? "exports", balances, since: flag("since")[0] });
    for (const p of plans) console.log(`${p.name}: ${idr(p.now)} -> ${idr(p.after)}${p.target == null ? "" : ` (bank ${idr(p.target)})`}, +${p.adds.length} -${p.deletes.length} ~${p.updates.length}${p.blockers.length ? `, ${p.blockers.length} BLOCKERS` : ""}`);
    console.log(`Wrote ${join(run, "PLAN.md")}`);
  } else if (cmd === "apply") await apply(run);
  else {
    console.log(`Usage:
  bun reconcile.ts plan --balance "BCA=<BCA Mobile>" --balance "ShopeePay=<app>" --balance "Cash=<counted>" [--balance "<account>=<amount>"] [--since YYYY-MM-DD] [--run DIR] [--exports DIR]
  bun reconcile.ts apply [--run DIR]`);
    process.exit(cmd ? 1 : 0);
  }
}
