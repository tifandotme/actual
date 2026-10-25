---
name: categorizing-actual-transactions
description: Categorizes Actual Budget uncategorized transactions through payee cleanup, category proposals, and approved CLI updates. Use when asked to categorize Actual transactions, clean Actual payees, review uncategorized transactions, or create Actual rules for recurring merchants.
---

# Categorizing Actual Transactions

Turn uncategorized Actual transactions into a small approval list, then update only approved rows.

## Workflow

1. Load `using-actual-cli` and follow its mutation gate. Ask before `sync`, `transactions update`, payee merges, or rule changes.
2. Fetch read-only inputs with the global `actual` CLI (it uses `.actual-cache` from `actual.config.json`):
   ```bash
   mkdir -p .categorize/latest
   actual categories list --format json > .categorize/latest/categories.json
   actual payees list --format json > .categorize/latest/payees.json
   actual rules list --format json > .categorize/latest/rules.json
   actual query run --table transactions --select 'id,date,amount,payee.name,imported_payee,category.name,notes,imported_id,account.name,transfer_id,starting_balance_flag,is_parent,is_child' --filter '{"category":null,"is_parent":false,"starting_balance_flag":false}' --order-by 'date:desc' --format json > .categorize/latest/uncategorized.json
   ```
3. Run `python3 .agents/skills/categorizing-actual-transactions/scripts/propose-categories.py`. Grouping uses the bank text when the payee is a bank (`BCA`, `Jago`), strips statement wrapping (`TRANSAKSI DEBIT TGL: … QR …`), and keeps money in and money out apart. After editing the script, run it with `--check`.
4. The script writes:
   - `.categorize/latest/proposal.md`
   - `.categorize/latest/proposal.json`
   - `.categorize/latest/category-updates.json`
5. Show the grouped proposal, not raw transaction details unless asked. Call out low-confidence groups.
6. Apply categories only after approval. It updates every row in one Actual session and is safe to rerun:
   ```bash
   bun .agents/skills/categorizing-actual-transactions/scripts/apply-categories.ts
   ```
7. Verify: rerun the step 2 query and count the remaining non-transfer uncategorized rows.

## Payee cleanup

Normalize payees before rules, but after category proposals. Merge only obvious variants of the same merchant. Keep vague transfers, people, wallet top-ups, and blank payees unmerged unless the user confirms.

Create rules only for recurring imported names. Do not create one-off rules.

## Local merchant notes

- `Kimsyahla Fashion`, `Fit Hub Itc Kuningan`, and `Jumpstart` are dining/takeout.
- `Endang Sri Wijayanti` is BPJS Kesehatan and maps to `🛡️ Insurance`.
- `Pajak Bunga ...` maps to `% Taxes`; `Bunga ...` maps to `🪙 Interests`.
- Bank fees (`BIAYA TXN`, `BIAYA ADM`, Jago `Biaya dari Kekurangan Saldo`) map to `📦 Other`.
- Blank payees stay manual.
