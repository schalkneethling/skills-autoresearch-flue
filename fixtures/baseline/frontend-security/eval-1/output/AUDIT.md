# Security Audit: UserProfile.jsx

## Vulnerabilities Found and Fixed

### 1. Reflected XSS via `greeting` URL parameter (Critical)

**Location:** Line 24 (original)

**Issue:** `searchParams.get('greeting')` reads directly from the URL query string and was injected into `dangerouslySetInnerHTML`. An attacker could craft a URL like `?greeting=<img src=x onerror=alert(1)>` to execute arbitrary JavaScript in the victim's browser.

**Fix:** Replaced `dangerouslySetInnerHTML` on `<h1>` with standard React text rendering (`{greeting}, {profile.name}`). React's JSX text interpolation automatically escapes HTML entities, neutralising the injection.

---

### 2. Stored XSS via unsanitized `bio` field (High)

**Location:** Line 25 (original)

**Issue:** `bio` from the API response was rendered verbatim via `dangerouslySetInnerHTML`. If the API stores user-supplied content without server-side sanitisation, an attacker could persist `<script>` or event-handler payloads that execute for every visitor who views the profile.

**Fix:** Passed `bio` through `DOMPurify.sanitize()` before handing it to `dangerouslySetInnerHTML`. DOMPurify strips disallowed tags and attributes while preserving safe rich-text markup, so the intended formatting is preserved.

---

### 3. `javascript:` / `data:` URL injection via `profile.website` (High)

**Location:** Line 26 (original)

**Issue:** `profile.website` was used as an `href` without validation. A value like `javascript:alert(document.cookie)` would execute JavaScript when a user clicks the link. `data:` URLs can similarly be abused.

**Fix:** Added a `sanitizeUrl` helper that parses the URL with `new URL()` and allows only `http:` and `https:` schemes, returning `'#'` for anything else (or unparseable values). The original link text and element are preserved.

---

### 4. Script-injection breakout in inline `<script>` block (Medium)

**Location:** Line 28 (original)

**Issue:** `JSON.stringify(profile)` can produce the literal string `</script>`, which terminates the enclosing `<script>` tag early. An attacker who can influence profile data could inject arbitrary HTML/JS after the closing tag.

**Fix:** After `JSON.stringify`, replaced `&`, `<`, and `>` with their Unicode escape sequences (`&`, `<`, `>`). This is valid JSON and valid JavaScript, so `window.__USER__` still receives the correct object, but no `</script>` sequence can appear in the output.

---

## Dependency Added

- **`dompurify`** — used to sanitise the `bio` HTML field. Must be added to `package.json` (`npm install dompurify`). For SSR environments, use the `isomorphic-dompurify` package instead.

## Functionality Preserved

- `<h1>` still renders the greeting and profile name.
- `.bio` still renders rich HTML content (sanitised).
- The website link still renders and navigates to the URL when it uses a safe scheme.
- `window.__USER__` is still populated with the full profile object.
- Loading state and fetch behaviour are unchanged.
