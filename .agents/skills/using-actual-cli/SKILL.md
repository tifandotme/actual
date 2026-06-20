---
name: using-actual-cli
description: Runs Actual Budget CLI commands for accounts, transactions, queries, imports, and troubleshooting. Use when working with Actual Budget data through bunx @actual-app/cli@latest or when another skill needs Actual account data.
---

# Using Actual CLI

Use `bunx @actual-app/cli@latest` for Actual Budget CLI work.

## Workflow

1. Check the CLI help before choosing flags.

   ```bash
   bunx @actual-app/cli@latest --help
   bunx @actual-app/cli@latest accounts list --help
   bunx @actual-app/cli@latest query run --help
   ```

2. Use the existing project configuration for credentials.
   - Do not print `.env` values, Actual credentials, session tokens, sync IDs, encryption passwords, account IDs, or other secrets.
   - Prefer machine-readable output for agent workflows.

3. List accounts when you need the target account ID.

   ```bash
   mkdir -p .reconcile/<source>/latest
   bunx @actual-app/cli@latest accounts list --format json \
     > .reconcile/<source>/latest/accounts.json
   ```

4. Query transactions by account and date range.

   ```bash
   bunx @actual-app/cli@latest query run \
     --table transactions \
     --select 'id,date,amount,payee.name,notes,imported_id,cleared' \
     --filter '{"account":"ACTUAL_ACCOUNT_ID","date":{"$gte":"YYYY-MM-DD","$lte":"YYYY-MM-DD"},"is_parent":false}' \
     --order-by 'date:asc' \
     --format json \
     > .reconcile/<source>/latest/actual-query.json
   ```

5. Summarize results without leaking private data.
   - Counts, file paths, and next actions are safe by default.
   - Transaction descriptions, payees, amounts, account numbers, and account IDs are private unless the user asks for details.

## Mutations

Ask before running any command that creates, imports, updates, deletes, syncs, uploads, or changes Actual data. Read-only commands are the default.

## Troubleshooting

- Treat command-specific help output as the source of truth for syntax.
- Prefer `query run` over `transactions list` if `transactions list` hits auth or network failures.
- Keep Actual CLI work separate from Terraform, GCP, Cloud Run, bucket, IAM, or domain mapping changes.
