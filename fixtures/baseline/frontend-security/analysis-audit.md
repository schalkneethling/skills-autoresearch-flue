# Audit Skill — Baseline Analysis

Covers detect-and-fix evals 1–4. Scores from `summary-audit.json`.

---

## 1. Strong areas (2.5+) — skill should NOT add content here

| Dimension | Score |
|---|---|
| vulnerability_detection | 3.0 |
| fix_completeness | 3.0 |
| regression_avoidance | 3.0 |
| fix_correctness | 2.75 |
| false_positive_avoidance | 2.5 |

The model reliably identifies XSS vectors (stored, reflected, DOM), classifies severity correctly, applies root-cause fixes, preserves functionality, and avoids flagging safe patterns like React JSX interpolation or Twig auto-escaped expressions. No guidance needed for these.

---

## 2. Weak areas (below 2.0) — primary skill focus

| Dimension | Score |
|---|---|
| defence_in_depth | 2.0 |

The model treats "remove the bad thing" as a complete fix. When `unsafe-inline`/`unsafe-eval` are removed from `script-src`, it stops there instead of adding the stronger replacement (`nonce` + `strict-dynamic`). The crypto import that was already present in the file — an obvious hint to use it — was left unused.

---

## 3. Consistently missed expectations

**a) Nonce + strict-dynamic not implemented (eval 4)**
Removing `unsafe-inline`/`unsafe-eval` is necessary but not sufficient for a bundled app. The correct fix is:
```js
const nonce = crypto.randomBytes(16).toString('base64');
res.locals.nonce = nonce;
// script-src: `'nonce-${nonce}' 'strict-dynamic'`
```
The model knows the keywords exist but does not wire up the infrastructure.

**b) Container reset via `innerHTML = ''` instead of `replaceChildren()` (eval 3)**
When clearing a DOM container before re-rendering, `innerHTML = ''` is an anti-pattern — it triggers HTML parsing on an empty string and loses event listeners. The expected idiom is `container.replaceChildren()` or a `removeChild` loop. The model consistently falls back to the unsafe shortcut.

**c) CSP overrides framework defaults — not noted (eval 4)**
The `res.setHeader('Content-Security-Policy', ...)` call silently overrides `helmet()`'s default CSP. This interaction is never mentioned in the audit, leaving the reader unaware of the interaction.

**d) Context-aware origin preservation (eval 4)**
`cdn.jsdelivr.net` was present in `script-src` and the README did not say it was unused. The model flagged it as "unjustified" and removed it — the opposite of the required preservation. The skill needs to instruct the model to keep origins it cannot verify are unused.

---

## 4. False positives

One confirmed false positive across the detect-and-fix evals:

- **eval 4:** `cdn.jsdelivr.net` removed from `script-src` as "unjustified" despite the eval expectation to preserve it. The model applied a "stricter is better" heuristic without checking whether the origin is actually used.

No false positives in evals 1–3 (the model correctly handled auto-escaped Twig expressions, React JSX text nodes, `img src`, `alt` attributes, and `fetch` GET requests).

---

## 5. Recommended skill focus (tied to eval evidence)

1. **Nonce + strict-dynamic replacement pattern (eval 4, defence_in_depth=2)**
   When removing `unsafe-inline`/`unsafe-eval`, always implement a per-request nonce and pair it with `'strict-dynamic'`. Include a concrete `crypto.randomBytes` snippet and the middleware wiring. This is the single largest gap.

2. **Detect and note CSP/framework interactions (eval 4, missed expectation)**
   When a manual `setHeader('Content-Security-Policy')` follows `helmet()`, the audit must note that the manual header overrides helmet's defaults. The skill should call this pattern out explicitly.

3. **Origin preservation under uncertainty (eval 4, false_positive_avoidance=2)**
   Do not remove existing allowlisted origins (CDN, analytics, font hosts) unless the code or README confirms they are unused. When in doubt, preserve and note the uncertainty in the audit.

4. **`replaceChildren()` as the idiomatic DOM reset (eval 3, framework_idiom=2)**
   When clearing a container before re-rendering with DOM APIs, use `container.replaceChildren()`. Flag `innerHTML = ''` in the same category as `innerHTML +=` — it is a lesser but real anti-pattern.

5. **Defence-in-depth framing for CSP (eval 4, defence_in_depth=2)**
   The audit should distinguish between "removed the dangerous directive" and "added the stronger replacement." A fix that only removes is incomplete. The skill should instruct the model to always propose both halves of a CSP hardening step.
