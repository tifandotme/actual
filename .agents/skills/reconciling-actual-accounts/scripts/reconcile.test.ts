import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ActualData, type ActualRow, buildPlan, fingerprint, loadShopeepay, dropReversals, isJagoInternal, jagoFrom, jagoLatestBalance, matchRows, parseBalance, parseBcaStatement, parseJagoText, parseKlikbcaCsv, type Source, type SourceRow } from "./reconcile";

const statement = `
        01/07         SALDO AWAL                                                                                                             100,000.00

        01/07         TRSF E-BANKING DB     TGL: 01/07                                              30,000.00 DB                        70,000.00
                                                  QR 014
                                                  WARUNG MAKAN

        02/07         KR OTOMATIS                                                                   1,000,000.00
                                                  SALARY

        03/07         BIAYA ADM                                                                         10,000.00 DB                   1,060,000.00

                                                               SALDO AKHIR             :         1,060,000.00
`;

test("parses a BCA Mobile statement and proves it against its balances", () => {
  const s = parseBcaStatement(statement, "0471353212_JUL_2026.pdf");
  expect(s).toMatchObject({ from: "2026-07-01", to: "2026-07-31" });
  expect(s.rows.map((r) => [r.date, r.amount])).toEqual([
    ["2026-07-01", -3_000_000],
    ["2026-07-02", 100_000_000],
    ["2026-07-03", -1_000_000],
  ]);
  expect(s.rows[0]!.description).toContain("WARUNG MAKAN");
});

test("rejects a statement whose rows do not reach SALDO AKHIR", () => {
  expect(() => parseBcaStatement(statement.replace(/SALDO AKHIR(\s+:\s+)1,060,000.00/, "SALDO AKHIR$11,050,000.00"), "0471353212_JUL_2026.pdf")).toThrow(/SALDO AKHIR/);
});

test("parses KlikBCA CSV rows, including a literal quote inside a description", () => {
  const csv = [
    "No. rekening : ,'0471353212",
    "Tanggal Transaksi,Keterangan,Cabang,Jumlah,,Saldo",
    "'01/10/2026,TRSF E-BANKING DB 0110/FTSCY/WS95051 QR 037 \"NUR AISYA,'0000,1000000.00,DB,500000.00",
    "'02/10/2026,BUNGA,'0000,1500.00,CR,501500.00",
    "Saldo Awal,,1500000.00",
  ].join("\n");
  const s = parseKlikbcaCsv(csv, "TIFANDWI3006_1.CSV");
  expect(s.rows.map((r) => [r.date, r.amount, r.balance])).toEqual([
    ["2026-10-01", -100_000_000, 50_000_000],
    ["2026-10-02", 150_000, 50_150_000],
  ]);
  expect(s.rows[0]!.description).toContain('"NUR AISYA');
});

const jago = `Pockets Transactions History Halaman 1 dari 1
TIFAN DWI AVIANTO
Kantong Utama 102104696066
Menampilkan transaksi IDR dari                                                                                                Saldo terbaru 21 Jun 2026
22 Sep 2024 - 21 Jun 2026                                                                                                                IDR 600.000

Tanggal & Waktu   Sumber/Tujuan                 Rincian Transaksi                            Catatan                           Jumlah              Saldo

22 Sep 2024       GoPay Tabungan                Tarik Uang Kantong                                                          +40.000             40.000
16.37             Pindah uang antar Kantong     ID# 1016304686

25 Sep 2024       TIFAN DWI AVIANTO             Transfer Masuk                                                           +500.000,00        540.000,00
21.12             BCA 0471353212                ID# 1023901669

01 Agt 2026       TIFAN DWI AVIANTO             Transfer Masuk           42150.00
                                                                         -          failed due to                +100.000,00             640.000,00
13.35             BCA 0471353212                ID# 261010-MWAA-XPZT3W

02 Agt 2026       Gopay                         Pembayaran dengan Jago Pay                   Gopay - Generic Jago            -40.000           600.000
11.25             0220240927042520ISeqdb3e      ID# 1027527941                               payment
`;

test("parses Jago PDF text, including Agt dates and wrapped amount lines", () => {
  const rows = parseJagoText(jago, "Jago_Kantong Utama_History_21062026.pdf");
  expect(rows.map((r) => [r.date, r.amount, r.balance])).toEqual([
    ["2024-09-22", 4_000_000, 4_000_000],
    ["2024-09-25", 50_000_000, 54_000_000],
    ["2026-08-01", 10_000_000, 64_000_000],
    ["2026-08-02", -4_000_000, 60_000_000],
  ]);
  expect(rows[2]!.importedId).toBe("jago-pdf:261010-MWAA-XPZT3W");
  expect(rows.map(isJagoInternal)).toEqual([true, false, false, false]);
  expect(jagoLatestBalance(jago)).toBe(60_000_000);
  expect(jagoFrom(jago)).toBe("2024-09-22");
});

test("drops a card charge and its PSD02-R reversal", () => {
  const row = (amount: number, detail: string) => ({ ref: detail, date: "2026-08-01", amount, balance: 0, pocket: "Kantong Utama", description: "", sourceTarget: "Grab* A- 9LGQ", detail, jagoIds: [] });
  const kept = row(-9_000_00, "Transaksi POS");
  expect(dropReversals([row(-43_750_00, "Transaksi POS"), row(43_750_00, "Refund PSD02-R"), kept])).toEqual([kept]);
});

const src = (date: string, amount: number): SourceRow => ({ ref: `${date} ${amount}`, date, amount, description: "", balance: null, pocket: "main" });
const act = (id: string, date: string, amount: number, reconciled = false, more: Partial<ActualRow> = {}): ActualRow => ({ id, date, amount, payeeName: null, notes: null, importedId: null, cleared: false, reconciled, transferId: null, ...more });

test("matches same-day before nearest, then splits, then far redates", () => {
  const m = matchRows(
    [src("2026-08-01", -100), src("2026-08-03", -100), src("2026-08-05", -5_100), src("2026-08-20", -999)],
    [act("near", "2026-08-02", -100), act("exact", "2026-08-03", -100), act("a", "2026-08-05", -5_000), act("fee", "2026-08-05", -100), act("late", "2026-09-10", -999), act("extra", "2026-08-10", -7)],
  );
  expect(m.pairs.map((p) => [p.src.date, p.kind, p.act.map((a) => a.id).join("+")])).toEqual([
    ["2026-08-03", "same-day", "exact"],
    ["2026-08-01", "shifted", "near"],
    ["2026-08-05", "split", "a+fee"],
    ["2026-08-20", "redate", "late"],
  ]);
  expect(m.extra.map((a) => a.id)).toEqual(["extra"]);
  expect(m.missing).toEqual([]);
});

test("never redates onto a locked row", () => {
  const m = matchRows([src("2026-08-20", -900)], [act("locked", "2026-08-10", -900, true)]);
  expect(m.missing).toHaveLength(1);
});

test("plans deletes, transfer links, export gaps and residuals", () => {
  const actual = {
    accounts: [
      { id: "bca", name: "BCA", last_reconciled: String(Date.parse("2026-08-01T05:00:00Z")) },
      { id: "sp", name: "ShopeePay", last_reconciled: String(Date.parse("2026-08-01T05:00:00Z")) },
    ],
    payees: [
      { id: "to-bca", name: "", transfer_acct: "bca" },
      { id: "to-sp", name: "", transfer_acct: "sp" },
    ],
    rowsByAccount: new Map([
      [
        "bca",
        [
          act("pln", "2026-08-05", -10_175_000, false, { importedId: "mail1" }),
          act("pln-fee", "2026-08-05", -175_000, false, { importedId: "mail1admin" }),
          act("topup", "2026-08-06", -5_000_000, false, { payeeName: "Shopee" }),
          act("big", "2026-08-07", -2_000_000, false, { importedId: "mail2" }),
          act("big-admin", "2026-08-07", -5_000_000, false, { importedId: "mail2admin" }),
        ],
      ],
      ["sp", []],
    ]),
    lastCategory: new Map(),
    schedules: [],
  } as unknown as ActualData;
  const sources = new Map<string, Source>([
    ["BCA", { rows: [{ ...src("2026-08-05", -10_175_000) }, { ...src("2026-08-06", -5_000_000), description: "TRSF E-BANKING DB SHOPEEPAY" }, src("2026-08-07", -2_000_000)], from: "2026-08-01", to: "2026-08-07", target: -22_175_000 + 3, label: "BCA Mobile" }],
    ["ShopeePay", { rows: [{ ...src("2026-08-06", 5_000_000), description: "Top Up BCA" }], from: "2026-08-10", to: "2026-08-06", target: 5_000_000, label: "ShopeePay" }],
  ]);
  const [bca, sp] = buildPlan(actual, sources, {}).plans;
  expect(bca!.deletes.map((d) => d.id)).toEqual(["pln-fee"]);
  expect(bca!.updates.filter((u) => u.id === "topup").map((u) => u.fields)).toEqual([{ cleared: true }, { payee: "to-sp" }]);
  expect(bca!.adds.map((a) => [a.kind, a.amount])).toEqual([["adjustment", 3]]);
  // A 50,000 "admin" row is too big to be a bank fee, so it is not deleted silently.
  expect(bca!.blockers).toEqual([expect.stringContaining("(id big-admin)")]);
  expect(sp!.adds).toEqual([]);
  expect(sp!.after).toBe(5_000_000);
  expect(sp!.blockers).toEqual([expect.stringContaining("exports start 2026-08-10")]);
});

test("links a missing transfer to a plain row in an account planned later", () => {
  const actual = {
    accounts: [
      { id: "bca", name: "BCA", last_reconciled: String(Date.parse("2026-08-01T05:00:00Z")) },
      { id: "sp", name: "ShopeePay", last_reconciled: String(Date.parse("2026-08-01T05:00:00Z")) },
    ],
    payees: [
      { id: "to-bca", name: "", transfer_acct: "bca" },
      { id: "to-sp", name: "", transfer_acct: "sp" },
    ],
    rowsByAccount: new Map([
      ["bca", []],
      ["sp", [act("sp-topup", "2026-08-06", 5_000_000, false, { payeeName: "Top up" })]],
    ]),
    lastCategory: new Map(),
    schedules: [],
  } as unknown as ActualData;
  const sources = new Map<string, Source>([
    ["BCA", { rows: [{ ...src("2026-08-06", -5_000_000), description: "TRSF E-BANKING DB SHOPEEPAY" }], from: "2026-08-01", to: "2026-08-06", target: -5_000_000, label: "BCA Mobile" }],
    ["ShopeePay", { rows: null, from: null, to: null, target: 5_000_000, label: "ShopeePay" }],
  ]);
  const [bca, sp] = buildPlan(actual, sources, {}).plans;
  expect(bca!.adds).toEqual([]);
  expect(bca!.after).toBe(-5_000_000);
  expect(sp!.updates.map((u) => [u.id, u.fields])).toEqual([["sp-topup", { payee: "to-bca" }]]);
  expect(sp!.adds).toEqual([]);
  expect(fingerprint(actual, [bca!, sp!])).toBe(fingerprint(actual, [bca!, sp!]));
  actual.rowsByAccount.get("sp")!.push(act("n8n", "2026-08-08", -1_000));
  expect(fingerprint(actual, [bca!, sp!])).not.toBe(fingerprint({ ...actual, rowsByAccount: new Map([["sp", []]]) }, [bca!, sp!]));
});

test("ShopeePay history needs its start date", () => {
  const dir = mkdtempSync(join(tmpdir(), "shopeepay-"));
  writeFileSync(join(dir, "history.csv"), "date,amount,description\n2026-10-20,-25000,Shopee Marketplace\n");
  expect(() => loadShopeepay(dir)).toThrow(/# from/);
  writeFileSync(join(dir, "history.csv"), "# from 2026-10-01\ndate,amount,description\n2026-10-20,-25000,Shopee Marketplace\n");
  expect(loadShopeepay(dir)).toMatchObject({ from: "2026-10-01", rows: [{ date: "2026-10-20", amount: -2_500_000 }] });
});

test("KlikBCA rows must follow their own running balance", () => {
  const csv = "'01/10/2026,A,'0000,100.00,DB,900.00\n'02/10/2026,B,'0000,50.00,DB,800.00";
  expect(() => parseKlikbcaCsv(csv, "x.CSV")).toThrow(/does not follow/);
});

test("reads typed balances in either separator style", () => {
  expect(parseBalance("3,386,211.95")).toBe(338_621_195);
  expect(parseBalance("3.386.211,95")).toBe(338_621_195);
  expect(parseBalance("Rp 61000")).toBe(6_100_000);
  expect(parseBalance("2.464")).toBe(246_400);
});
