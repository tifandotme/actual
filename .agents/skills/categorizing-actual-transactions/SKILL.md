---
name: categorizing-actual-transactions
description: Categorizes Actual Budget uncategorized transactions through payee cleanup, category proposals, and approved CLI updates. Use when asked to categorize Actual transactions, clean Actual payees, review uncategorized transactions, or create Actual rules for recurring merchants.
---

# Categorizing Actual Transactions

Turn uncategorized Actual transactions into a small approval list, then update only approved rows.

## Workflow

1. Load `using-actual-cli` and follow its mutation gate. Ask before `sync`, `transactions update`, payee merges, or rule changes.
2. Use a fresh local cache when the default cache is stale:
   ```bash
   mkdir -p .categorize/actual-cache .categorize/latest
   ACTUAL_DATA_DIR="$PWD/.categorize/actual-cache" bunx @actual-app/cli@latest sync --clear
   ```
3. Fetch read-only inputs:
   ```bash
   ACTUAL_DATA_DIR="$PWD/.categorize/actual-cache" bunx @actual-app/cli@latest categories list --format json > .categorize/latest/categories.json
   ACTUAL_DATA_DIR="$PWD/.categorize/actual-cache" bunx @actual-app/cli@latest payees list --format json > .categorize/latest/payees.json
   ACTUAL_DATA_DIR="$PWD/.categorize/actual-cache" bunx @actual-app/cli@latest rules list --format json > .categorize/latest/rules.json
   ACTUAL_DATA_DIR="$PWD/.categorize/actual-cache" bunx @actual-app/cli@latest query run --table transactions --select 'id,date,amount,payee.name,imported_payee,category.name,notes,imported_id,account.name,transfer_id,starting_balance_flag,is_parent,is_child' --filter '{"category":null,"is_parent":false,"starting_balance_flag":false}' --order-by 'date:desc' --format json > .categorize/latest/uncategorized.json
   ```
4. Run `scripts/propose-categories.py` to write:
   - `.categorize/latest/proposal.md`
   - `.categorize/latest/proposal.json`
   - `.categorize/latest/category-updates.json`
5. Show the grouped proposal, not raw transaction details unless asked. Call out low-confidence groups.
6. Apply categories only after approval:
   ```bash
   python3 .agents/skills/categorizing-actual-transactions/scripts/apply-categories.py
   ```
7. Verify with a fresh sync and count remaining non-transfer uncategorized transactions.

## Payee cleanup

Normalize payees before rules, but after category proposals. Merge only obvious variants of the same merchant. Keep vague transfers, people, wallet top-ups, and blank payees unmerged unless the user confirms.

Create rules only for recurring imported names. Do not create one-off rules.

## Local merchant notes

- `Kimsyahla Fashion`, `Fit Hub Itc Kuningan`, and `Jumpstart` are dining/takeout.
- `Endang Sri Wijayanti` is BPJS Kesehatan and maps to `🛡️ Insurance`.
- `Pajak Bunga ...` maps to `% Taxes`; `Bunga ...` maps to `🪙 Interests`.
- Blank payees stay manual.
