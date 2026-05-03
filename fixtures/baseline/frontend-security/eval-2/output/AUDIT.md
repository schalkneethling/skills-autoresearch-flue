# Security Audit: contact.html.twig

## Findings

### 1. Reflected XSS via `|raw` filter (Critical)

**Line 17 (original):**
```twig
{{ app.request.get('message')|raw }}
```

The `|raw` filter disables Twig's auto-escaping, so attacker-controlled input from the `message` request parameter is injected directly into the HTML without sanitization. Any user can craft a URL or form submission containing `<script>` tags or other HTML payloads that execute in the victim's browser.

**Fix:** Remove `|raw`. Twig's default auto-escaping safely encodes the value for HTML context, so the preview still renders the message text — just without executing embedded HTML or scripts.

### 2. Missing CSRF Protection (High)

**Original form:** No CSRF token present.

Without a CSRF token, any third-party site can silently submit the contact form on behalf of a logged-in user (cross-site request forgery). Symfony ships with a built-in CSRF token service that makes this trivial to fix.

**Fix:** Added a hidden field using Symfony's `csrf_token()` function:
```twig
<input type="hidden" name="_token" value="{{ csrf_token('contact') }}">
```
The controller must validate this token with `$this->isCsrfTokenValid('contact', $request->request->get('_token'))` before processing the submission.

## What Was Not Changed

- `{{ app.request.get('name') }}` and `{{ app.request.get('email') }}` in input `value` attributes — Twig's auto-escaping applies by default, so these are safe as written.
- `{{ app.request.get('message') }}` inside the `<textarea>` — also auto-escaped, no issue.
- Form action, method, field names, and layout — all preserved. The preview feature continues to work; it now displays the message as plain text rather than rendered HTML.
