# Reconciliation manual

Your steps for each run. The agent does everything else.

## 1. Collect the exports

Put each file in its folder under `exports/`, with the name the app gives it. Delete the files from the last run first.

| Account   | What to get                                                                                                          | Where it goes             |
| --------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| BCA       | BCA Mobile: e-Statement PDF for each closed month since the last reconcile                                           | `exports/bca/statements/` |
| BCA       | KlikBCA (`ibank.klikbca.com`): one Mutasi Rekening CSV, from the 1st of this month to today                          | `exports/bca/klikbca/`    |
| Jago      | Jago app: transaction history PDF for **Kantong Utama** and for **GoPay Tabungan**, from the last reconcile to today | `exports/jago/`           |
| ShopeePay | Screenshots of the transaction history back to the last reconcile                                                    | `exports/shopeepay/`      |

### Gotchas

- **BCA statements** cover closed months only (in October, September is the latest) and go back to 2021. The file name must stay `<account>_<MON>_<YYYY>.pdf`. The script reads the year and month from it.
- **KlikBCA** is only for the current month: export from the 1st to today. Closed months come from statements.
- **Jago** needs exactly two PDFs, one per pocket. Older PDFs in the folder make the run fail.
- **ShopeePay**: in the history screen, set **Payment Method → ShopeePay** (ShopeePay Balance only) and stay on the **All** tab before you take screenshots. Scroll until you pass the last reconcile date. Without the filter, the list mixes in card and bank payments that never touched the balance.

## 2. Read three balances

Write these down as the apps show them:

- **BCA Mobile** balance (not the KlikBCA `Saldo Akhir`; BCA Mobile excludes a 10,000 hold)
- **ShopeePay** balance
- **Cash**: count your wallet

## 3. Start the run

In this repo, run `/reconciling-actual-accounts` and paste the three balances, for example:

```text
BCA 3,386,211.95, ShopeePay 2,464, Cash 61,000
```

## 4. Review and approve

The agent shows `.reconcile/<date>/PLAN.md`: what it adds, deletes, and changes per account, and the balance after the plan. Read the account table and any row that looks wrong. Say "apply" to write the changes, or tell the agent what to change.

## 5. After

- Optional: run `/categorizing-actual-transactions` for the new rows that have no category.
- Delete the files in `exports/` once Actual shows the accounts as reconciled.
