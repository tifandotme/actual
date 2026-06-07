# AGENTS.md

This repo has two scopes:

- Actual Budget infrastructure on GCP, managed with Terraform in `terraform/`
- Local workflows for Actual Budget data through the `actual` CLI

Before changing Terraform, read `terraform/main.tf`, `terraform/variables.tf`, `terraform/outputs.tf`, and `terraform/mise.toml`.

Never run `terraform apply` or `terraform destroy`.

After changing Terraform, run `cd terraform && mise run check`.

Do not print secrets from `.env`, `terraform/.env`, Actual credentials, session tokens, sync IDs, or encryption passwords.
