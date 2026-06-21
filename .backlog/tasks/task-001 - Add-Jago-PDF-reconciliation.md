---
id: TASK-001
title: Add Jago PDF reconciliation
status: Done
assignee: []
created_date: '2026-06-21 13:36'
updated_date: '2026-06-21 14:58'
labels:
  - reconciliation
  - jago
  - actual
dependencies: []
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Build a report-only reconciliation flow for Jago PDFs exported from exports/jago. Actual has one merged account named Jago (Utama+GoPay), while Jago exports Kantong Utama and GoPay Tabungan as separate PDFs. The flow must parse both PDFs, exclude internal Utama/GoPay/pocket movements, compare external rows against Actual deterministically, and use the same approval-before-add safety model as BCA. n8n automation is deferred until local parsing is stable.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Parses one or more Jago PDF exports into structured rows with date, time, source/target, detail, note, amount, balance, source account, and Jago ID when present.
- [x] #2 Classifies rows as external, internal, or unknown; internal rows are excluded, unknown rows are reported for review, and classification does not rely on balance thresholds.
- [x] #3 Computes Actual query range from external rows only and reconciles against the Actual account named Jago (Utama+GoPay) by exact date and exact signed amount.
- [x] #4 Writes detailed artifacts under .reconcile/jago/latest/, including parsed rows, classified rows, external rows, internal rows, unknown rows, ID problems, missing candidates, review candidates, approval candidates, approval.md, reconcile result, and report.md.
- [x] #5 Backfill approval uses approval.md and requires explicit confirmation before any Actual mutation; approved rows use imported_id jago-pdf:<Jago ID#> and fail/report when an external approved row lacks exactly one Jago ID.
- [x] #6 Includes one runnable Bun test covering PDF text parsing/classification/matching behavior without requiring live Actual or n8n.
- [x] #7 n8n workflow automation is not implemented in this task and is documented as deferred.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add a separate Bun script for Jago PDF reconciliation, leaving the BCA script untouched.
2. Parse pdftotext -layout output into structured Jago rows, with parser tests using fixture text instead of live PDFs.
3. Classify rows as external/internal/unknown with explicit Jago description rules and ID problem reporting.
4. Reconcile external rows against Actual query JSON by exact date and amount, then write .reconcile/jago/latest artifacts and approval.md.
5. Support approval-to-add JSON generation with imported_id jago-pdf:<Jago ID#>, failing on missing/duplicate IDs for approved rows.
6. Run bun test for the Jago script.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented local Jago PDF reconciliation in .agents/skills/reconciling-actual-accounts/scripts/reconcile-jago-pdfs.ts. Ran read-only Actual query for Jago (Utama+GoPay), wrote report artifacts under .reconcile/jago/latest/, and generated recommendation files for the -150642 IDR balance delta. No Actual mutations were run.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added a separate Bun Jago PDF reconciliation script, parser/classifier tests, and local reconciliation artifacts. The run parsed the two Jago PDFs, excluded internal rows, matched external rows by exact date and amount, and produced approval/report files. Recommendation artifacts identify a 3-row candidate set that exactly matches the -150642 IDR balance difference. n8n automation remains deferred.
<!-- SECTION:FINAL_SUMMARY:END -->
