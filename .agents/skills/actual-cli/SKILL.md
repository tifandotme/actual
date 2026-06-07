---
name: actual-cli
description: Use the local `actual` CLI for Actual Budget data tasks. Use when the user asks to inspect, reconcile, export, query, sync, or manage budget data; run `actual --help` and command-specific help before choosing flags.
---

# Actual CLI

## Quick start

```bash
actual --help
actual <command> --help
actual <command> <subcommand> --help
```

Treat the CLI help output as the source of truth. Do not rely on this skill for a command list, flag list, or option syntax.

## When to use it

Use `actual` when the task concerns Actual Budget data, such as:

- inspecting budgets, accounts, categories, payees, tags, rules, or schedules
- listing, querying, importing, exporting, or reviewing transactions
- running AQL queries
- syncing or checking the local Actual cache
- using Actual server utilities exposed by the CLI

Do not use `actual` for GCP, Cloud Run, bucket, IAM, domain mapping, or Terraform changes. This repository's Terraform manages the hosted server infrastructure; the `actual` CLI manages budget data and Actual server utilities.

## Workflow

1. Run `actual --help` to confirm the installed CLI and global options.
2. Run command-specific help before executing a data-changing command.
3. Prefer environment variables or existing project configuration for credentials. Do not print passwords, tokens, sync IDs, or encryption secrets.
4. Prefer machine-readable output for agent workflows when the CLI supports it, then summarize the result for the user.
5. Use refresh or cache controls only after checking the current help text and when stale data would affect the answer.
6. Before destructive or broad data changes, show the exact command and ask the user to confirm.

## Safety rules

- Never expose secrets in commands, logs, summaries, or saved files.
- Never guess flags or subcommands. Read `actual --help` or `actual <command> --help` first.
- Avoid concurrent budget mutations unless the current help text explains a safe locking or cache strategy.
- If Actual data and Terraform infrastructure overlap in a request, separate the two scopes before acting.
