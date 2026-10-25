#!/usr/bin/env bun
// Applies .categorize/latest/category-updates.json in one Actual session. Safe to rerun: it only sets categories.
import { readFileSync } from "node:fs";
import { openActual } from "../../reconciling-actual-accounts/scripts/reconcile";

const updates: { id: string; category: string }[] = JSON.parse(readFileSync(".categorize/latest/category-updates.json", "utf8"));
const { api } = await openActual();
try {
  await api.batchBudgetUpdates(async () => {
    for (const u of updates) await api.updateTransaction(u.id, { category: u.category });
  });
  await api.sync();
  console.log(`updated ${updates.length}`);
} finally {
  await api.shutdown();
}
