#!/usr/bin/env bun
// Applies .categorize/latest/category-updates.json in one Actual session. Safe to rerun: it sets fixed values.
import { readFileSync } from "node:fs";
import { openActual } from "../../reconciling-actual-accounts/scripts/reconcile";

// Each entry sets `category`, and optionally `notes` and `payee`.
const updates: { id: string; category: string; notes?: string; payee?: string }[] = JSON.parse(readFileSync(".categorize/latest/category-updates.json", "utf8"));
const { api } = await openActual();
try {
  await api.batchBudgetUpdates(async () => {
    for (const { id, ...fields } of updates) await api.updateTransaction(id, fields);
  });
  await api.sync();
  console.log(`updated ${updates.length}`);
} finally {
  await api.shutdown();
}
