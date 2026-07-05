---
description: Categorize Actual Budget uncategorized transactions with approval gates
argument-hint: "[instructions]"
---

/categorizing-actual-transactions /using-actual-cli

Categorize my uncategorized Actual transactions.

Extra instructions: ${ARGUMENTS:-none}

Start read-only:

1. Use a fresh local Actual CLI cache if needed.
2. Fetch categories, payees, rules, and uncategorized transactions.
3. Exclude transfers and starting balances from category work.
4. Group by payee and imported payee.
5. Generate proposal files under `.categorize/latest/`.
6. Show auto-category candidates and manual-review groups.

Do not update transactions, merge payees, create rules, sync mutable changes, or otherwise mutate Actual data until I approve the exact action.

After approval, apply only the approved category updates, then fresh-sync and report remaining non-transfer uncategorized transactions.
