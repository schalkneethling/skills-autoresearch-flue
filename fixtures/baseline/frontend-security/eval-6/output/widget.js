(function () {
  'use strict';

  const API_BASE = 'https://comments.example.com/api/threads';

  const THEMES = {
    light: {
      bg: '#ffffff',
      surface: '#f9fafb',
      border: '#e5e7eb',
      text: '#111827',
      muted: '#6b7280',
      accent: '#2563eb',
      accentText: '#ffffff',
      inputBg: '#ffffff',
    },
    dark: {
      bg: '#111827',
      surface: '#1f2937',
      border: '#374151',
      text: '#f9fafb',
      muted: '#9ca3af',
      accent: '#3b82f6',
      accentText: '#ffffff',
      inputBg: '#1f2937',
    },
  };

  function buildStyles(theme) {
    const t = THEMES[theme] || THEMES.light;
    return `
      :host {
        display: block;
        font-family: system-ui, -apple-system, sans-serif;
        font-size: 14px;
        line-height: 1.5;
        color: ${t.text};
        background: ${t.bg};
        border: 1px solid ${t.border};
        border-radius: 8px;
        overflow: hidden;
      }
      .widget {
        padding: 16px;
      }
      h2 {
        margin: 0 0 16px;
        font-size: 16px;
        font-weight: 600;
        color: ${t.text};
      }
      .comment-list {
        display: flex;
        flex-direction: column;
        gap: 12px;
        margin-bottom: 20px;
      }
      .comment {
        background: ${t.surface};
        border: 1px solid ${t.border};
        border-radius: 6px;
        padding: 10px 12px;
      }
      .comment-meta {
        display: flex;
        align-items: baseline;
        gap: 8px;
        margin-bottom: 6px;
      }
      .comment-author {
        font-weight: 600;
        font-size: 13px;
      }
      .comment-time {
        font-size: 12px;
        color: ${t.muted};
      }
      .comment-body {
        margin: 0;
        color: ${t.text};
        word-break: break-word;
      }
      .comment-body a {
        color: ${t.accent};
        text-decoration: underline;
      }
      .empty {
        color: ${t.muted};
        font-style: italic;
        margin-bottom: 20px;
      }
      .error-msg {
        color: #dc2626;
        background: #fef2f2;
        border: 1px solid #fecaca;
        border-radius: 4px;
        padding: 8px 10px;
        margin-bottom: 12px;
        font-size: 13px;
      }
      form {
        display: flex;
        flex-direction: column;
        gap: 10px;
        border-top: 1px solid ${t.border};
        padding-top: 16px;
      }
      label {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 13px;
        font-weight: 500;
        color: ${t.text};
      }
      input, textarea {
        background: ${t.inputBg};
        border: 1px solid ${t.border};
        border-radius: 4px;
        color: ${t.text};
        font-family: inherit;
        font-size: 13px;
        padding: 7px 10px;
        outline: none;
        transition: border-color 0.15s;
        width: 100%;
        box-sizing: border-box;
      }
      input:focus, textarea:focus {
        border-color: ${t.accent};
      }
      textarea {
        resize: vertical;
        min-height: 72px;
      }
      button[type="submit"] {
        align-self: flex-start;
        background: ${t.accent};
        border: none;
        border-radius: 4px;
        color: ${t.accentText};
        cursor: pointer;
        font-family: inherit;
        font-size: 13px;
        font-weight: 600;
        padding: 8px 16px;
        transition: opacity 0.15s;
      }
      button[type="submit"]:hover:not(:disabled) {
        opacity: 0.9;
      }
      button[type="submit"]:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .spinner {
        display: inline-block;
        width: 16px;
        height: 16px;
        border: 2px solid ${t.border};
        border-top-color: ${t.accent};
        border-radius: 50%;
        animation: spin 0.6s linear infinite;
        margin: 8px auto;
      }
      @keyframes spin {
        to { transform: rotate(360deg); }
      }
    `;
  }

  function formatTime(iso) {
    try {
      return new Date(iso).toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    } catch {
      return iso;
    }
  }

  // Sanitise user-supplied HTML: allow only b, strong, i, em, a (href only).
  function sanitiseBody(raw) {
    const div = document.createElement('div');
    div.textContent = raw;
    // Raw is plain text from API — if API returns HTML we sanitise it below.
    // Re-assign as innerHTML then walk and strip disallowed nodes.
    div.innerHTML = raw;
    walk(div);
    return div.innerHTML;
  }

  const ALLOWED_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'A']);

  function walk(node) {
    const children = [...node.childNodes];
    for (const child of children) {
      if (child.nodeType === Node.TEXT_NODE) continue;
      if (child.nodeType === Node.ELEMENT_NODE) {
        if (!ALLOWED_TAGS.has(child.tagName)) {
          // Replace with its text content
          child.replaceWith(document.createTextNode(child.textContent));
          continue;
        }
        // Strip all attributes except href on <a>
        for (const attr of [...child.attributes]) {
          if (child.tagName === 'A' && attr.name === 'href') {
            // Only allow http/https/mailto hrefs
            if (!/^(https?:|mailto:)/i.test(attr.value)) {
              child.removeAttribute(attr.name);
            }
          } else {
            child.removeAttribute(attr.name);
          }
        }
        if (child.tagName === 'A') {
          child.setAttribute('target', '_blank');
          child.setAttribute('rel', 'noopener noreferrer');
        }
        walk(child);
      } else {
        child.remove();
      }
    }
  }

  class CommentWidget {
    constructor(host, threadId, theme = 'light') {
      this._host = host;
      this._threadId = threadId;
      this._theme = theme;
      this._shadow = host.attachShadow({ mode: 'open' });
      this._comments = [];
      this._loading = true;
      this._submitError = null;
      this._render();
      this._fetchComments();
    }

    configure(threadId, theme) {
      this._threadId = threadId;
      this._theme = theme;
      this._comments = [];
      this._loading = true;
      this._submitError = null;
      this._render();
      this._fetchComments();
    }

    async _fetchComments() {
      try {
        const res = await fetch(`${API_BASE}/${encodeURIComponent(this._threadId)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        this._comments = Array.isArray(data) ? data : (data.comments ?? []);
      } catch (err) {
        this._comments = [];
        console.error('[comment-widget] Failed to load comments:', err);
      } finally {
        this._loading = false;
        this._render();
      }
    }

    _render() {
      const t = THEMES[this._theme] || THEMES.light;
      const shadow = this._shadow;

      // Keep form values across re-renders if form exists
      let savedAuthor = '';
      let savedBody = '';
      const existingAuthor = shadow.querySelector('#cw-author');
      const existingBody = shadow.querySelector('#cw-body');
      if (existingAuthor) savedAuthor = existingAuthor.value;
      if (existingBody) savedBody = existingBody.value;

      shadow.innerHTML = '';

      const style = document.createElement('style');
      style.textContent = buildStyles(this._theme);
      shadow.appendChild(style);

      const wrap = document.createElement('div');
      wrap.className = 'widget';

      const heading = document.createElement('h2');
      heading.textContent = 'Comments';
      wrap.appendChild(heading);

      if (this._loading) {
        const spinner = document.createElement('div');
        spinner.className = 'spinner';
        wrap.appendChild(spinner);
      } else {
        const list = document.createElement('div');
        list.className = 'comment-list';

        if (this._comments.length === 0) {
          const empty = document.createElement('p');
          empty.className = 'empty';
          empty.textContent = 'No comments yet. Be the first!';
          wrap.appendChild(empty);
        } else {
          for (const c of this._comments) {
            list.appendChild(this._buildComment(c));
          }
          wrap.appendChild(list);
        }
      }

      const form = this._buildForm(savedAuthor, savedBody);
      wrap.appendChild(form);

      shadow.appendChild(wrap);
    }

    _buildComment(c) {
      const article = document.createElement('article');
      article.className = 'comment';

      const meta = document.createElement('div');
      meta.className = 'comment-meta';

      const author = document.createElement('span');
      author.className = 'comment-author';
      author.textContent = c.author ?? 'Anonymous';

      const time = document.createElement('time');
      time.className = 'comment-time';
      time.dateTime = c.createdAt ?? '';
      time.textContent = c.createdAt ? formatTime(c.createdAt) : '';

      meta.appendChild(author);
      meta.appendChild(time);

      const body = document.createElement('p');
      body.className = 'comment-body';
      body.innerHTML = sanitiseBody(c.body ?? '');

      article.appendChild(meta);
      article.appendChild(body);
      return article;
    }

    _buildForm(authorValue = '', bodyValue = '') {
      const form = document.createElement('form');

      if (this._submitError) {
        const err = document.createElement('div');
        err.className = 'error-msg';
        err.textContent = this._submitError;
        form.appendChild(err);
      }

      const authorLabel = document.createElement('label');
      authorLabel.textContent = 'Name';
      const authorInput = document.createElement('input');
      authorInput.id = 'cw-author';
      authorInput.type = 'text';
      authorInput.placeholder = 'Your name';
      authorInput.required = true;
      authorInput.maxLength = 100;
      authorInput.value = authorValue;
      authorLabel.appendChild(authorInput);

      const bodyLabel = document.createElement('label');
      bodyLabel.textContent = 'Comment';
      const bodyInput = document.createElement('textarea');
      bodyInput.id = 'cw-body';
      bodyInput.placeholder = 'Write a comment…';
      bodyInput.required = true;
      bodyInput.maxLength = 5000;
      bodyInput.value = bodyValue;
      bodyLabel.appendChild(bodyInput);

      const submit = document.createElement('button');
      submit.type = 'submit';
      submit.textContent = 'Post comment';

      form.appendChild(authorLabel);
      form.appendChild(bodyLabel);
      form.appendChild(submit);

      form.addEventListener('submit', (e) => {
        e.preventDefault();
        this._submitComment(authorInput.value.trim(), bodyInput.value.trim(), submit, bodyInput);
      });

      return form;
    }

    async _submitComment(author, body, btn, bodyInput) {
      if (!author || !body) return;

      btn.disabled = true;
      btn.textContent = 'Posting…';
      this._submitError = null;

      try {
        const res = await fetch(
          `${API_BASE}/${encodeURIComponent(this._threadId)}/comments`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ author, body }),
          }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        // Optimistically append the new comment
        this._comments.push({
          id: data.id ?? data.commentId,
          author: data.author ?? author,
          body: data.body ?? body,
          createdAt: data.createdAt ?? new Date().toISOString(),
        });
        this._submitError = null;
        this._render();

        window.parent.postMessage(
          { type: 'comment-posted', commentId: data.id ?? data.commentId, author },
          '*'
        );
      } catch (err) {
        console.error('[comment-widget] Failed to post comment:', err);
        this._submitError = 'Failed to post your comment. Please try again.';
        btn.disabled = false;
        btn.textContent = 'Post comment';
        // Re-render error without losing form values
        const errEl = this._shadow.querySelector('.error-msg');
        if (errEl) {
          errEl.textContent = this._submitError;
        } else {
          const form = this._shadow.querySelector('form');
          if (form) {
            const div = document.createElement('div');
            div.className = 'error-msg';
            div.textContent = this._submitError;
            form.prepend(div);
          }
        }
      }
    }
  }

  function init() {
    const container = document.querySelector('[data-thread-id]')
      ?? document.getElementById('comments-widget');

    if (!container) return;

    const threadId = container.dataset.threadId;
    const widget = new CommentWidget(container, threadId, 'light');

    window.addEventListener('message', (event) => {
      if (!event.data || event.data.type !== 'configure') return;
      const { threadId: tid, theme } = event.data;
      if (tid) widget.configure(tid, theme || 'light');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
