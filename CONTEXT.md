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

**Unknown row**:
A parsed source export row whose account-boundary effect cannot be classified deterministically.
_Avoid_: Maybe external

**Jago PDF import ID**:
An Actual imported*id for an approved PDF backfill, formed as `jago-pdf:<Jago ID#>` when the Jago transaction ID is present.
\_Avoid*: PDF row number, filename key
