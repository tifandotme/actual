# Friction Log

Repeated or systemic workflow friction that should become automation, docs, or workflow fixes.


## 2026-07-05 17:36 - Actual CLI JSON has install noise

- Trigger: `bunx @actual-app/cli@latest ... --format json` printed dependency/install lines before JSON, causing simple `json.loads(stdout)` parsing to fail.
- Workaround: Logged raw output and parsed from the first line beginning with `{` or `[`.
- Prevention: Wrap Actual CLI calls with a small helper that strips `bunx` noise before JSON parsing, or use an installed binary that emits clean JSON.

