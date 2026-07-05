---
name: budgeting-actual-months
description: Drafts and applies Actual Budget month budgets to zero To Budget. Use when budgeting past or current Actual months, funding one month ahead, or adjusting For next month holds.
---

# Budgeting Actual Months

Draft month budgets from categorized Actual transactions, then apply only approved changes through the Actual CLI.

## Rules

1. Load `using-actual-cli` and follow its mutation gate.
2. Use the canonical repo cache from `actual.config.json` (`.actual-cache`). Do not create task-specific caches.
3. Never write SQLite directly. SQLite may be read for analysis only when CLI queries are inefficient.
4. Draft first. Apply only after explicit user approval.
5. After apply, verify every target month has `To Budget = 0`.

## Budget principle

Default to one-month-ahead budgeting:

- Salary received on the 9th should fund the next month, not the current month.
- Current month should be funded from money available before payday.
- `For next month` should grow toward a full month of spending, not stay fixed at Rp2M.
- If the user is not fully one month ahead yet, use transition mode: budget actual/current needs, then hold all remaining To Budget for next month.

## Workflow

1. Check cache health:
   ```bash
   bunx @actual-app/cli@latest sync --status --format json
   ```
2. If stale or missing, ask before syncing:
   ```bash
   bunx @actual-app/cli@latest --lock-timeout 120 sync --format json
   ```
3. Draft budgets:
   ```bash
   python3 .agents/skills/budgeting-actual-months/scripts/plan-budget-months.py --months 2026-05 2026-06 2026-07
   ```
4. Explain the draft, especially `For next month` and any transition shortfall.
5. Apply only after approval:
   ```bash
   python3 .agents/skills/budgeting-actual-months/scripts/plan-budget-months.py --months 2026-05 2026-06 2026-07 --apply
   ```
6. Read back each month and confirm `To Budget = 0`.

## Script behavior

`scripts/plan-budget-months.py`:

- Parses Actual CLI JSON even when `bunx` prints install noise before JSON.
- Resets holds before setting `For next month`, because hold updates are additive.
- Ignores income categories when setting budget amounts.
- Sets spending categories to categorized outflows for each month.
- In draft mode, prints planned category budgets and holds without mutations.
- In apply mode, mutates only with Actual CLI commands.
