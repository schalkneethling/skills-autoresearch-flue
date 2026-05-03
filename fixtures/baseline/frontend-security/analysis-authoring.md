# Authoring Baseline Analysis

Eval type: `secure-author` | Evals: 5 (`react-search-secure-author`), 6 (`vanilla-widget-secure-author`)
Overall composite: **1.25 / 4.0**

---

## 1. Secure defaults the model already applies

The skill should **not** add instructions for these — the model does them reliably without prompting.

| Pattern | Evidence |
|---|---|
| JSX interpolation for text content (no `dangerouslySetInnerHTML` on plain strings) | Eval 5: heading rendered as `{query}` |
| Controlled React inputs via state | Eval 5: `value`/`onChange` pattern applied correctly |
| `encodeURIComponent` on URL query params | Eval 5: fetch URL constructed safely |
| `textContent` for plain fields in vanilla JS | Eval 6: author and timestamp |
| `fetch` with `Content-Type: application/json` over form action | Eval 6 |
| No `document.write()` | Eval 6 |
| Shadow DOM for style isolation | Eval 6 |
| Recognises "basic formatting" in comment bodies as requiring sanitisation (vanilla JS context) | Eval 6 |

---

## 2. Dangerous patterns the model uses by default

These are the target failures the skill must address.

**React context (Eval 5 — secure_defaults: 0/3, defence_in_depth: 0/3)**

- **`dangerouslySetInnerHTML` on unsanitised API data.** When the spec says a field "may contain HTML", the model uses `dangerouslySetInnerHTML` directly — no DOMPurify, no sanitisation at all. This is the highest-severity miss: stored XSS via API response.
- **Unvalidated `href` from API-supplied URLs.** `result.url` is passed directly to `<a href>`. No protocol check, allowing `javascript:` and `data:` URLs.

**Cross-origin messaging (Eval 6 — both directions failed)**

- **Wildcard target origin on outbound `postMessage`.** Sends `postMessage(data, '*')` instead of `postMessage(data, 'https://comments.example.com')`, leaking `commentId` and `author` to any cross-origin frame.
- **No `event.origin` validation on inbound `postMessage`.** Any attacker page can send a `configure` message to redirect the widget to an arbitrary `threadId`.

---

## 3. Context recognition

| Security-sensitive context | Recognised? | Notes |
|---|---|---|
| HTML in API response field → sanitise before rendering | **No** | Fell for the spec trap in eval 5: "description may contain HTML" → used `dangerouslySetInnerHTML` unsanitised |
| API-supplied URL in `href` → validate protocol | **No** | Passed `result.url` directly in eval 5 |
| "Basic formatting" in comment bodies → sanitise | **Yes** | Correctly flagged in eval 6 (vanilla JS) |
| `postMessage` as a security boundary | **No** | Neither inbound origin validation nor outbound target origin applied |
| `encodeURIComponent` on URL params | **Yes** | Applied in both evals |

Key gap: the model recognises injection risk when working with DOM `innerHTML` in vanilla JS, but not when working with React's `dangerouslySetInnerHTML` on API-returned HTML. It has no mental model of `postMessage` as a security boundary at all.

---

## 4. Defence in depth

Mixed — the model layers defences only where it already recognises a threat.

**Where layering is present:** The eval 6 comment-body sanitiser stacks tag allowlist + attribute stripping + protocol check + `rel=noopener`. This is genuine defence in depth.

**Where single-fix or no-fix dominates:**
- React (eval 5): `encodeURIComponent` is applied for functional reasons, but there is no security layer on HTML rendering or URL handling. Secure_defaults score: 0, defence_in_depth score: 0.
- `postMessage` (eval 6): zero defence in either direction — no origin check on receive, wildcard on send.

The model does not generalise defence-in-depth thinking across the full component surface; it applies it locally where a threat is already recognised.

---

## 5. Recommended skill focus

Ordered by eval impact:

1. **`dangerouslySetInnerHTML` trap rule.** Any spec that says a field "may contain HTML" or "supports formatting" is a signal to sanitise, not to enable raw HTML. The rule: if `dangerouslySetInnerHTML` is needed, DOMPurify is required. If the HTML is only for `<em>`/`<strong>` highlights, prefer rendering as plain text and losing the highlights rather than using unsanitised HTML.

2. **URL protocol validation on `href`.** All URLs from API responses or user input used in `href` must have a protocol allowlist check (`https:`, `http:`, `mailto:` — reject everything else, especially `javascript:` and `data:`). This applies in React and vanilla JS.

3. **`postMessage` origin discipline.** Two mandatory checks: (a) inbound — always validate `event.origin` against a hardcoded expected origin before processing; (b) outbound — never use `'*'` as the target when the message contains any data; specify the exact receiver origin.

4. **Spec trap awareness.** When a spec mentions HTML content without saying how to handle it safely, default to plain text rendering. The spec is a product spec, not a security spec. The agent should treat "may contain HTML" as a risk signal, not a permission.

5. **DOMPurify as the canonical library.** The model's custom sanitiser in eval 6 had dead code (`div.textContent` immediately overwritten by `div.innerHTML`). The skill should steer toward DOMPurify for React and vanilla JS when HTML rendering is genuinely needed, rather than custom walk-function sanitisers.

---

## 6. Description keywords

The skill description should include trigger terms for the contexts the model currently misses:

- `dangerouslySetInnerHTML`
- `innerHTML`
- `href` with external or API-supplied URLs
- `postMessage` / cross-origin communication
- HTML in API responses / server-returned HTML
- URL validation / protocol check
- XSS / injection

Suggested description fragment: _"Guides secure authoring of frontend components that render HTML from API responses (`dangerouslySetInnerHTML`, `innerHTML`), link to external URLs (`href` protocol validation), or communicate across origins (`postMessage` origin validation)."_
