# Sync errors

Run read-only checks first. Never reset sync or delete bucket files without the user's OK.

| Error                             | Meaning                                                               | Fix                                               |
| --------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------- |
| `SyncError: out-of-sync`          | Server snapshot and message log disagree. A fresh download fails too. | Server side: see below.                           |
| `PostError: file-has-reset`       | `ACTUAL_SYNC_ID` is the pre-reset group ID.                           | Set the new ID, then clear the CLI state.         |
| `budget directory does not exist` | CLI state points at a deleted cache folder.                           | Move `.actual-cache/.actual-cli/<sync-id>` aside. |

## Diagnose out-of-sync

```bash
gcloud storage ls -l --recursive gs://actual-bucket-new/user-files/
gcloud run services describe actual-server --region asia-southeast1 \
  --format='value(spec.template.metadata.annotations)'
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="actual-server" AND severity>=ERROR' \
  --limit 10 --freshness=7d --format='value(timestamp,textPayload)'
```

- gcloud uses config `personal`, project `actual-474910`.
- `file-*.blob` (snapshot) much newer than `group-*.sqlite` (message log) means the log did not flush.
- Likely cause: `min_instance_count = 0` with CPU throttling stops the instance before the bucket mount flushes. See `COSTS.md` before changing it.
- `express-rate-limit` `Forwarded` header errors are harmless.

## Fix

1. Back up: `./backup-actual.sh`.
2. User opens the web UI, checks the data, then runs Settings, Show advanced settings, Reset sync. This gives the budget a new sync ID.
3. Find the new ID without printing it, then `pbcopy` it:

   ```bash
   actual --format json budgets list 2>/dev/null
   ```

   The `groupId` that differs from `$ACTUAL_SYNC_ID` is the new one.

4. User updates `ACTUAL_SYNC_ID` and restarts the session.
5. Move `.actual-cache/.actual-cli/<old-sync-id>` aside, then run `actual --format table accounts list`.
