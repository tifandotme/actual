# actual

Infrastructure and local workflows for my Actual Budget instance.

## Quick facts

- Service: `actual-server`
- Domain: `actual.tifan.me`
- Runtime: Google Cloud Run
- Data: SQLite files in GCS bucket `actual-bucket-new`
- Terraform state: GCS backend `actual-terraform-state`, prefix `actual`
- Backup script: `backup-actual.sh`

## Terraform workflow

From `terraform/`:

```bash
mise run set-project
mise run check
terraform plan
```

Agents should stop at `terraform plan`. Humans can apply after reviewing the plan.

## Actual CLI workflow

Check CLI help before choosing command syntax:

```bash
actual --help
actual <command> --help
actual <command> <subcommand> --help
```

Do not print credentials, session tokens, sync IDs, encryption passwords, or `.env` values.

## Routine checks

- Visit `https://actual.tifan.me` and test normal budget operations.
- Check Cloud Run revisions and logs in GCP.
- Check that GCS contains recent Actual data files.
- Run `backup-actual.sh` and confirm files land under `~/backups/actual-backup-latest`.
- Review GCP billing and budget alerts.

## Backups and recovery

- GCS soft delete is configured for 7 days.
- Manual backup: run `backup-actual.sh` after checking its configured gcloud profile.
- Recovery: restore the needed files into the GCS bucket, then verify Actual can open and sync the budget.

## Upgrading Actual

The service uses `actualbudget/actual-server:latest-alpine`. To upgrade, redeploy through the existing deployment path, then watch Cloud Run logs and test budget operations.

## Known issue

Cold starts can delay the first request. This is expected for a low-traffic personal service that scales to zero.
