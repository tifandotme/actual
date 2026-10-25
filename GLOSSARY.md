# Actual Budget Reconciliation

This context defines the language for comparing bank and wallet exports with Actual Budget accounts.

## Language

**Merged Actual account**:
An Actual Budget account that represents multiple real-world balances managed as one budget account.
_Avoid_: Combined account, app account

**Internal row**:
A source export row that moves money only between balances inside the same merged Actual account. It is not income, expense, or an Actual transfer. A card charge and its PSD02-R reversal are handled the same way: both count toward the day-end check, and neither reaches Actual.
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
Comparing Actual's running balance after the plan with the bank's balance at the end of each day. A steady offset is fine (BCA's ledger runs 10,000 above BCA Mobile because of a hold); a change that lasts 4 or more days blocks the run.
_Avoid_: Daily diff
