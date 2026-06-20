---
name: reconciling-bca
description: Compares a KlikBCA Mutasi Rekening CSV export with the Actual Budget BCA account and reports bank transactions missing from Actual. Use when reconciling BCA, KlikBCA CSV files, Mutasi Rekening exports, or Actual BCA transactions.
---

# Reconciling BCA

Use this skill to find BCA bank transactions that are present in a KlikBCA Mutasi Rekening CSV export but missing from Actual Budget.

The workflow is report-only by default. Do not create or import Actual transactions unless the user explicitly asks in the same session.

## Source of truth

Treat the BCA CSV as the source of truth. The main report answers:

> Which BCA CSV transactions are not represented in Actual's `BCA` account?

Actual-only rows are secondary evidence. Report them as unmatched Actual rows when useful, but do not let them drive the missing list.

## Quick start

From the repo root, check the installed Actual CLI before choosing flags:

```bash
actual --help
actual accounts list --help
actual query run --help
actual accounts list --format json > .reconcile/bca/accounts.json
```

Find the Actual account named exactly `BCA`. There is only one BCA account in this budget. Use the existing project configuration for credentials. Do not print account IDs or secrets in summaries.

Use the script to derive the CSV date range. The suggested Actual end date includes a few extra days for card settlement or email lag.

```bash
bun run .agents/skills/reconciling-bca/scripts/reconcile-bca.ts \
  --csv exports/TIFANDWI3006_932618592.CSV \
  --print-date-range
```

Then query Actual for that date range.

```bash
mkdir -p .reconcile/bca/latest
actual query run \
  --table transactions \
  --select 'id,date,amount,payee.name,notes,imported_id,cleared' \
  --filter '{"account":"ACTUAL_BCA_ACCOUNT_ID","date":{"$gte":"YYYY-MM-DD","$lte":"YYYY-MM-DD"},"is_parent":false}' \
  --order-by 'date:asc' \
  --format json \
  > .reconcile/bca/latest/actual-query.json

bun run .agents/skills/reconciling-bca/scripts/reconcile-bca.ts \
  --csv exports/TIFANDWI3006_932618592.CSV \
  --actual-json .reconcile/bca/latest/actual-query.json \
  --out-dir .reconcile/bca/latest
```

Read `.reconcile/bca/latest/report.md` locally. Summarize counts and next actions for the user. Do not paste transaction descriptions, amounts, account numbers, or payee details unless the user explicitly asks.

## Matching rules

1. Parse only transaction rows from the KlikBCA CSV. Skip metadata, balances, and footer rows.
2. Convert dates from `DD/MM/YYYY` to `YYYY-MM-DD`.
3. Convert amounts to Actual's integer amount format by multiplying IDR by 100. Use `CR` as positive and `DB` as negative.
4. Match first by exact posting date and amount.
5. If the BCA description contains `TGL: MMDD`, also try that embedded transaction date with the same amount.
6. Do not use broad nearby-date matching as proof. Nearby same-amount rows are only review hints.
7. Ignore `imported_id` for matching. It identifies the n8n or Gmail import source, not the BCA CSV row.

## Duplicates and review hints

Same-date, same-amount duplicates are expected. Actual deduplicates n8n imports, so duplicate imports are unlikely.

For duplicate groups, compare counts by date and amount. If CSV and Actual have the same count, treat the group as reconciled. If counts differ, report the excess CSV rows as missing candidates and include nearby Actual rows as hints.

Use `review-candidates.json` for rows that have same-amount Actual rows nearby. These are not matches. They only point to card settlement lag or date parsing issues that need human review.

## Tests

Run the fixture tests after editing the script. Use an absolute path because Bun may ignore tests under hidden directories when passed as a relative pattern.

The fixtures are synthetic and safe to commit. They mirror the real KlikBCA export shape: metadata rows, a blank line, the `Tanggal,Keterangan,Cabang,Jumlah,,Saldo` header, transaction rows, and footer balance rows.

```bash
bun test "$PWD/.agents/skills/reconciling-bca/scripts/reconcile-bca.test.ts"
```

## Artifacts

Write reconciliation artifacts under `.reconcile/bca/latest/`:

- `actual-query.json`: raw Actual query output
- `parsed-csv.json`: normalized CSV transactions
- `actual-transactions.json`: normalized Actual transactions
- `missing-candidates.json`: CSV rows with no Actual match
- `review-candidates.json`: missing candidates with nearby same-amount Actual hints
- `duplicate-groups.json`: date/amount groups where counts differ or duplicates exist
- `reconcile-result.json`: full result, including matches and unmatched Actual rows
- `report.md`: human-readable local report

These files contain personal financial data. Keep `.reconcile/` gitignored.

## Safety

- Do not print secrets from `.env`, Actual credentials, session tokens, sync IDs, or encryption passwords.
- Treat bank exports, reconciliation artifacts, transaction descriptions, and amounts as private. Summarize counts unless the user asks for detailed rows.
- Run `actual --help` and command-specific help before using Actual CLI commands. Treat help output as the source of truth for command syntax.
- Prefer machine-readable Actual output for agent workflows, then summarize counts and actions.
- Prefer `actual query run` over `actual transactions list` if `transactions list` hits auth or network failures.
- Do not use `actual` for Terraform, GCP, Cloud Run, bucket, IAM, or domain mapping changes.
- Ask before any Actual mutation. Report-only is the default.
