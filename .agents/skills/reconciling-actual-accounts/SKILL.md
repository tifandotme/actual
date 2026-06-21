---
name: reconciling-actual-accounts
description: Compares external bank, card, or wallet exports with Actual Budget accounts and reports source transactions missing from Actual. Use when reconciling Actual accounts, bank CSVs, wallet exports, KlikBCA Mutasi Rekening, BCA, or other financial exports.
---

# Reconciling Actual accounts

Find source transactions that are present in a bank, card, or wallet export but missing from the matching Actual Budget account.

Default to report-only. Adding transactions is a two-confirmation flow: user marks rows for approval, then confirms the final add command after seeing the count.

## Workflow

1. Identify the source export and target Actual account.
   - For BCA, use the Actual account named exactly `BCA`.
   - Treat the source export as the source of truth.
   - The main report answers: which source rows are not represented in Actual?

2. Use the `using-actual-cli` skill for account lookup and transaction queries.
   - Prefer `bunx @actual-app/cli@latest` for Actual CLI commands.
   - Query Actual for the source export's date range.
   - Keep account IDs, credentials, sync IDs, tokens, and passwords out of summaries.

3. Run the reconciliation script.

   ```bash
   bun run .agents/skills/reconciling-actual-accounts/scripts/reconcile-actual-account.ts \
     --csv exports/TIFANDWI3006_932618592.CSV \
     --print-date-range
   ```

   ```bash
   mkdir -p .reconcile/bca/latest
   bun run .agents/skills/reconciling-actual-accounts/scripts/reconcile-actual-account.ts \
     --csv exports/TIFANDWI3006_932618592.CSV \
     --actual-json .reconcile/bca/latest/actual-query.json \
     --out-dir .reconcile/bca/latest
   ```

4. If there are multiple source CSVs, reconcile each CSV independently.
   - Do not merge BCA CSV rows across files. Overlapping exports can make counts misleading, and BCA exports do not provide a stable transaction ID for safe dedupe.
   - Query Actual for each CSV's own suggested date range.
   - Use `--out-dir .reconcile/bca/by-csv/<csv-stem>`.

5. Read `.reconcile/bca/latest/report.md` or the per-CSV reports locally.
   - Summarize counts and point the user to `approval.md` when missing candidates exist.
   - Ask the user to mark approved row IDs in `approval.md` and tell you when ready.
   - Stop there until the user responds. Do not build `actual-add.json` yet.
   - Do not paste transaction descriptions, amounts, account numbers, or payee details unless the user explicitly asks.

## Jago PDF workflow

Use this when reconciling Jago exports from `exports/jago/` against Actual account `Jago (Utama+GoPay)`.

1. Require exactly two PDFs in `exports/jago/`: one `Kantong Utama`, one `GoPay Tabungan`.
2. Query all non-parent Actual transactions for `Jago (Utama+GoPay)`, including `cleared` and `reconciled`.

   ```bash
   mkdir -p .reconcile/jago/latest
   bunx @actual-app/cli@latest query run \
     --table transactions \
     --select 'id,date,amount,payee.name,notes,imported_id,cleared,reconciled' \
     --filter '{"account":"ACTUAL_JAGO_ACCOUNT_ID","is_parent":false}' \
     --order-by 'date:asc' \
     --format json \
     > .reconcile/jago/latest/actual-query.json
   ```

3. Run the reconciliation. The script derives:
   - reconciliation start date from the latest `reconciled: true` Actual transaction
   - Jago app balance from the two PDF `Saldo terbaru` values
   - Actual cleared balance from Actual rows where `cleared: true`
   - recommendation target delta from `bank balance - Actual cleared balance`

   ```bash
   bun run .agents/skills/reconciling-actual-accounts/scripts/reconcile-jago-pdfs.ts \
     --actual-json .reconcile/jago/latest/actual-query.json \
     --exports-dir exports/jago \
     --out-dir .reconcile/jago/latest
   ```

4. Review these script-generated files only:
   - `report.md`: counts and date range
   - `approval.md`: all missing candidates, unchecked
   - `recommended-balance-fix-candidates.md`: exact-sum candidate sets
   - `recommended-approval.md`: first recommended set pre-checked
   - `approval-candidates.json`: control file used to build Actual add JSON

Do not create recommendation markdown by hand.

## Approval and add workflow

Use this only after the user says they finished marking `approval.md`.

`approval.md` is a control file. The scripts deterministically read checked lines and map those IDs through `approval-candidates.json`.

1. Build the Actual CLI add file from checked rows only.

   ```bash
   bun run .agents/skills/reconciling-actual-accounts/scripts/reconcile-jago-pdfs.ts \
     --approval-json .reconcile/jago/latest/approval-candidates.json \
     --approval-md .reconcile/jago/latest/recommended-approval.md \
     --actual-add-out .reconcile/jago/latest/actual-add.json
   ```

2. Count the transactions in `actual-add.json`, summarize the count only, and ask for final confirmation to add them.
3. Run the mutation only after that final confirmation.

   ```bash
   bunx @actual-app/cli@latest transactions add \
     --account ACTUAL_JAGO_ACCOUNT_ID \
     --file .reconcile/jago/latest/actual-add.json
   ```

## Jago source rules

Use these rules for Jago PDF exports:

1. Treat `Kantong Utama` and `GoPay Tabungan` PDFs as one virtual source account because Actual has one merged account.
2. Exclude internal rows: `Pindah uang antar Kantong`, `Tambah Uang Kantong`, `Tarik Uang Kantong`, `auto sweep`, and `Pencairan Dana dari GoPay`.
3. Classify unknown rows for review. Do not infer internal/external from the GoPay 100000 IDR auto-fillup threshold.
4. Match external rows by exact date and exact signed amount only.
5. Use nearby same-amount Actual rows only as review hints.
6. Approved PDF backfills use `imported_id` as `jago-pdf:<Jago ID#>`. Approved rows without exactly one Jago ID must fail before add JSON is trusted.

## BCA source rules

Use these rules for KlikBCA Mutasi Rekening CSV exports:

1. Parse only transaction rows. Skip metadata, balances, and footer rows.
2. Convert dates from `DD/MM/YYYY` to `YYYY-MM-DD`.
3. Convert amounts to Actual's integer amount format by multiplying IDR by 100. Use `CR` as positive and `DB` as negative.
4. Match first by exact posting date and amount.
5. If the BCA description contains `TGL: MMDD`, also try that embedded transaction date with the same amount.
6. Do not use broad nearby-date matching as proof. Nearby same-amount rows are review hints only.
7. Ignore `imported_id` for matching. It identifies the n8n or Gmail import source, not the BCA CSV row.

## Duplicates and review hints

Same-date, same-amount duplicates are expected. Actual deduplicates n8n imports, so duplicate imports are unlikely.

For duplicate groups, compare counts by date and amount. If CSV and Actual have the same count, treat the group as reconciled. If counts differ, report the excess source rows as missing candidates and include nearby Actual rows as hints.

Use `review-candidates.json` for rows that have same-amount Actual rows nearby. These are not matches. They point to settlement lag or date parsing issues that need human review.

## Artifacts

Write reconciliation artifacts under `.reconcile/<source>/latest/`:

- `actual-query.json`: raw Actual query output
- `parsed-csv.json`: normalized source transactions
- `actual-transactions.json`: normalized Actual transactions
- `missing-candidates.json`: source rows with no Actual match
- `review-candidates.json`: missing candidates with nearby same-amount Actual hints
- `approval-candidates.json`: proposed Actual transactions for missing rows
- `approval.md`: checkbox review file for human approval
- `duplicate-groups.json`: date and amount groups where counts differ or duplicates exist
- `reconcile-result.json`: full result, including matches and unmatched Actual rows
- `report.md`: human-readable local report

For multiple CSVs, write each CSV's artifacts under `.reconcile/<source>/by-csv/<csv-stem>/`.

For Jago, `.reconcile/jago/latest/` contains only:

- `approval-candidates.json`
- `approval.md`
- `recommended-balance-fix-candidates.md`
- `recommended-approval.md`
- `report.md`

These files contain personal financial data. Keep `.reconcile/` gitignored.

## Tests

Run the fixture tests after editing the script. Use an absolute path because Bun may ignore tests under hidden directories when passed as a relative pattern.

```bash
bun test "$PWD/.agents/skills/reconciling-actual-accounts/scripts/reconcile-actual-account.test.ts"
bun test tests/reconcile-jago-pdfs.test.ts
```

## Safety

- Do not print secrets from `.env`, Actual credentials, session tokens, sync IDs, or encryption passwords.
- Treat bank exports, reconciliation artifacts, transaction descriptions, and amounts as private. Summarize counts unless the user asks for detailed rows.
- Ask before any Actual mutation. Report-only is the default.
- Do not use Actual CLI for Terraform, GCP, Cloud Run, bucket, IAM, or domain mapping changes.
