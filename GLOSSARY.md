# Actual Budget Reconciliation

This context defines the language for comparing bank and wallet exports with Actual Budget accounts.

## Language

**Merged Actual account**:
An Actual Budget account that represents multiple real-world balances managed as one budget account.
_Avoid_: Combined account, app account

**Internal row**:
A source export row that moves money only between balances inside the same merged Actual account. It is not income, expense, or an Actual transfer.
_Avoid_: Transfer, transaction

**External row**:
A source export row where money enters or leaves the merged Actual account boundary.
_Avoid_: Real transaction

**Jago PDF import ID**:
An Actual `imported_id` for a row added from a Jago PDF, formed as `jago-pdf:<Jago ID#>`.
_Avoid_: PDF row number, filename key

**Lock**:
Marking every cleared row of an account reconciled and stamping the account's `last_reconciled`, as Actual's reconcile button does. The next run starts from the lock.
_Avoid_: Close, finalize

**Day-end check**:
Comparing Actual's running balance after the plan with the bank's balance at the end of each day. A steady offset is fine; a change that persists marks a missing or wrong row.
_Avoid_: Daily diff
