---
name: using-actual-cli
description: Runs Actual Budget CLI commands for accounts, transactions, queries, imports, and troubleshooting. Use when working with Actual Budget data through the `actual` CLI or when another skill needs Actual account data.
---

# Using Actual CLI

Use the global `actual` CLI for Actual Budget work. It prints no install lines before JSON; keep stderr out of piped JSON with `2>/dev/null`.

## Workflow

1. Check the CLI help before choosing flags.

   ```bash
   actual --help
   actual accounts list --help
   actual query run --help
   ```

2. Use the existing project configuration for credentials.
   - Do not print `.env` values, Actual credentials, session tokens, sync IDs, encryption passwords, account IDs, or other secrets.
   - Prefer machine-readable output for agent workflows.

3. List accounts when you need the target account ID.

   ```bash
   mkdir -p .reconcile/<source>/latest
   actual accounts list --format json \
     > .reconcile/<source>/latest/accounts.json
   ```

4. Query transactions by account and date range.

   ```bash
   actual query run \
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
- To hand the user a secret such as a sync ID, `pbcopy` it and say so; do not print it.
- Prefer `query run` over `transactions list` if `transactions list` hits auth or network failures.
- `SyncError: out-of-sync`, `file-has-reset`, or `budget directory does not exist`: read [SYNC-ERRORS.md](SYNC-ERRORS.md).
- Keep Actual CLI work separate from Terraform, GCP, Cloud Run, bucket, IAM, or domain mapping changes.

### Cloud Run cold starts

This repo's Actual server may scale to zero. If the CLI returns `Authentication failed: network-failure`, treat it as possibly transient before debugging credentials.

1. Warm the server.

   ```bash
   curl -fsS "$ACTUAL_SERVER_URL/info" >/dev/null
   ```

2. Retry a read-only CLI command with short backoff.

   ```bash
   for i in 1 2 3 4 5; do
     actual accounts list --format json && break
     sleep "$((i * 2))"
   done
   ```

3. If it still fails, compare curl and Node networking.

   ```bash
   curl -fsS -w 'status=%{http_code} total=%{time_total}\n' \
     "$ACTUAL_SERVER_URL/info" -o /dev/null

   node -e "fetch(process.env.ACTUAL_SERVER_URL + '/info').then(r=>console.log(r.status)).catch(console.error)"
   ```

Do not conclude credentials are wrong unless login fails after the server is warm.
