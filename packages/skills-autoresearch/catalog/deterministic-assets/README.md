# Deterministic asset catalog

This directory contains the repository-owned reusable deterministic-asset catalog. `catalog.json` is the versioned index and must list exactly these domain documents in canonical order:

- `javascript-typescript.json`
- `language.json`
- `markdown.json`

Each indexed document declares its matching domain and keeps assets ordered by priority, then stable ID. Capability levels map to priority as follows: `existing` → `1`, `configurable` → `2`, and `extensible` → `3`.
