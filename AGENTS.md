# AGENTS.md

This repo has two scopes:

- Actual Budget infrastructure on GCP, managed with Terraform in `terraform/`
- Local workflows for Actual Budget data through the `actual` CLI

Before changing Terraform, read `terraform/main.tf`, `terraform/variables.tf`, `terraform/outputs.tf`, and `terraform/mise.toml`.

Never run `terraform apply` or `terraform destroy`.

After changing Terraform, run `cd terraform && mise run check`.

## Balance sources

- BCA: the user's BCA Mobile balance is the target for Actual's `BCA` account. BCA Mobile statements (`exports/bca/statements/`) and KlikBCA CSVs (`exports/bca/klikbca/`) supply transaction rows; their balances are the ledger, 10,000 above BCA Mobile (a hold), so ask the user for the BCA Mobile balance before reconciling.
- Jago: the `Saldo terbaru` values in the `Kantong Utama` and `GoPay Tabungan` PDFs match the app.

Do not print secrets from `.env`, `terraform/.env`, Actual credentials, session tokens, sync IDs, or encryption passwords.
