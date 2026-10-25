---
name: reconciling-actual-accounts
description: Reconciles Actual Budget accounts (BCA, Jago, ShopeePay, Cash) with bank exports and app balances, then locks them. Use when reconciling Actual accounts, checking bank exports against Actual, or finding transactions missing from Actual.
---

# Reconciling Actual accounts

One run locks every on-budget account from its last lock to today: BCA, `Jago (Utama+GoPay)`, ShopeePay, Cash. The user's steps are in [MANUAL.md](MANUAL.md); point them there when inputs are missing.

```bash
s=.agents/skills/reconciling-actual-accounts/scripts/reconcile.ts
bun $s plan --balance "BCA=<BCA Mobile>" --balance "ShopeePay=<app>" --balance "Cash=<counted>"
bun $s apply
```

`plan` is read-only. It writes `.reconcile/<today>/PLAN.md` and `plan.json`. `apply` writes to Actual.

## Steps

1. **Inputs.** Get the three balances from the user. Check that `exports/` holds what MANUAL.md lists. If `exports/shopeepay/` has screenshots, transcribe the ShopeePay Balance rows dated on or after the ShopeePay last reconcile into `exports/shopeepay/history.csv`:

   ```csv
   # from 2026-10-01
   date,amount,description
   2026-10-20,-25000,Shopee Marketplace
   2026-10-21,50000,Top Up BCA
   ```

   `# from` is the oldest date the screenshots reach; list every row from that date on. Signed IDR, any order. Without the file, ShopeePay balances by an adjustment.

2. **Plan.** Run `plan`. Done when it prints no `BLOCKERS`. For each blocker, investigate with the exports and Actual (`using-actual-cli`), then record the decision in `.reconcile/<today>/decisions.json` and re-run `plan`:

   ```json
   {
     "skip": ["<source ref>"],
     "override": {
       "<source ref>": {
         "transfer": "<account>",
         "payee": "<payee>",
         "schedule": "<schedule name>",
         "date": "YYYY-MM-DD"
       }
     },
     "delete": [{ "id": "<actual id>", "reason": "..." }],
     "keep": ["<actual id>"],
     "update": [{ "id": "<actual id>", "fields": { "amount": -1250000 }, "reason": "..." }],
     "adjust": { "<account>": "<reason for a balance adjustment>" },
     "dayEnd": { "<account>": "<why its day-end gaps are expected>" }
   }
   ```

   Use `adjust` only when the cause is known and no row can carry it. A **day-end check** line marks 4+ days where Actual and the bank drift apart, and blocks the run: find the misdated or missing row, or record in `dayEnd` why the drift is expected (for example a row the bank posted 5 days late).

3. **Approve.** Show the user the account table from PLAN.md and summarize each account's adds, deletes, updates, and decisions. Wait for "apply".

4. **Apply.** Run `apply`. It stops if Actual changed since `plan` (re-run `plan` and get approval again). It backs up `.actual-cache` to `.reconcile/<today>/backup/`, then deletes, updates, adds (transfers create their counterpart), checks every balance against the bank, advances linked schedules, and locks the accounts. Each step (and each account's adds) leaves a `.done-*` marker, so a rerun after a failure resumes; `plan` clears the markers. Done when it prints every account at its bank balance.

5. Offer `/categorizing-actual-transactions` for added rows without a category.

## How `plan` decides

- **Window**: from each account's last reconcile (`last_reconciled`), or `--since YYYY-MM-DD`. Exports that start after it block the run; get the missing export instead of deleting Actual rows.
- **Sources**: BCA statements win over KlikBCA CSVs for their months; segments must chain balance to balance. Jago drops internal rows and PSD02-R reversal pairs. Each source proves its own running balance and fails hard when it does not.
- **Matching**: same date and amount, then nearest within 4 days, then two Actual rows summing to one bank row (Starbucks 50,000 + 1,000 fee), then an unlocked same-amount row within 31 days to redate.
- **Net-zero patterns**: n8n `…admin` fee rows whose payment matched are deleted; BCA includes the fee in the payment.
- **New rows**: `RULES` in the script decides transfers (BCA↔Jago, ATM→Cash, BCA→ShopeePay, Bibit→Jago) and payees. When the other account already has the row as a plain payment, the plan changes that row's payee to the transfer payee and Actual creates this side. The only fixed-amount schedule on the account with that amount links the row; category comes from the payee's latest use.
- **Residual**: cents close automatically; Cash and ShopeePay without history close by adjustment; anything else blocks.

## Gotchas

- BCA Mobile shows 10,000 less than the bank ledger (a hold). The BCA day-end check therefore sits at a constant offset; only changes in that offset matter.
- BCA charges the monthly admin fee around the 3rd for the month before. The schedule runs on the 3rd.
- `updateSchedule` ignores `resetNextDate` unless a field changes; `apply` re-sends the name.
- Cloud Run cold starts fail the first login with `network-failure`; the script warms `/info` and retries.
- Exports and `.reconcile/` hold private financial data and stay gitignored. Summarize counts and totals; print rows only when the user asks.

## Tests

```bash
bun test "$PWD/.agents/skills/reconciling-actual-accounts/scripts/reconcile.test.ts"
```
