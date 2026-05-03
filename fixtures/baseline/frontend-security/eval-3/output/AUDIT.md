# Security Audit: comments.js

## Vulnerabilities Found and Fixed

### 1. Stored XSS via `innerHTML` in `render()` — **High**

**Original code** interpolated `comment.author`, `comment.date`, `comment.body`, and `comment.id` directly into an HTML template string assigned to `innerHTML`. Any of these fields containing `<script>` tags or event handler attributes would execute in the victim's browser.

**Fix:** Replaced the template-string/innerHTML approach with `document.createElement` + `element.textContent` for every user-supplied field. `textContent` never interprets its value as markup, so injection is impossible regardless of content.

---

### 2. JavaScript Injection via Inline `onclick` Handler — **High**

**Original code** wrote `onclick="deleteComment(${comment.id})"` into HTML. If `comment.id` was not a plain integer (e.g. `1); alert(1); //`), it would execute arbitrary JavaScript in the handler string.

**Fix:** Removed the inline handler entirely. The delete button is created with `createElement('button')` and wired via `addEventListener('click', () => deleteComment(comment.id))`. The id value is passed as a JavaScript value, never concatenated into a code string.

---

### 3. Reflected XSS in `search()` Result — **High**

**Original code** put the raw `query` string directly into `innerHTML`:

```js
`<p>Found ${results.length} results for "${query}"</p>`
```

A query containing `<img src=x onerror=alert(1)>` would execute.

**Fix:** The result paragraph is built with `createElement('p')` and `textContent`, so the query is always treated as plain text.

---

### 4. Race Condition in `addComment()` — **Medium**

**Original code** called `fetch(POST)` without `await` and then immediately called `this.loadComments()`. The GET for the refreshed list could resolve before the POST was processed, silently dropping the new comment from the UI.

**Fix:** `addComment` is now `async` and `await`s the POST before calling `await this.loadComments()`, guaranteeing the UI reflects the saved comment.

---

### 5. Accumulating `innerHTML +=` in `render()` — **Low / Performance**

Appending to `innerHTML` repeatedly causes the browser to re-parse and re-serialize the entire container on every iteration, which also re-creates existing DOM nodes and loses any attached event listeners.

**Fix:** The loop now creates each comment node independently and uses `appendChild`, touching the DOM only once per comment.

---

## What Was Preserved

- `loadComments()` fetches from `/api/comments` and calls `render()`.
- `render()` outputs each comment with author (`<strong>`), date (`.date`), body (`.body`), and a Delete button wired to `deleteComment(id)`.
- `search(query)` filters comments by body and author and displays the result count.
- `addComment(author, body)` POSTs to `/api/comments` and refreshes the list.
