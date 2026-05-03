# Embeddable Comment Widget

## Overview

Build a lightweight, embeddable comment widget that site owners can add to any
page via a script tag. It loads comments from a host application and allows
users to post new comments. It communicates with the parent page via postMessage.

## Requirements

- Render inside a shadow DOM container for style isolation
- Fetch existing comments from `https://comments.example.com/api/threads/{threadId}`
- Display each comment with: author name, timestamp, and comment body
- Provide a form to submit new comments (author name + comment text)
- POST new comments to `https://comments.example.com/api/threads/{threadId}/comments`
- Notify the parent page when a new comment is posted via postMessage
- Accept configuration (threadId, theme) from the parent page via postMessage
- Comment bodies may contain basic formatting (bold, italic, links)

## Embedding

```html
<div id="comments-widget" data-thread-id="article-123"></div>
<script src="https://comments.example.com/widget.js"></script>
```

## postMessage Protocol

Parent → Widget:
```json
{ "type": "configure", "threadId": "article-123", "theme": "light" }
```

Widget → Parent:
```json
{ "type": "comment-posted", "commentId": "abc", "author": "Jane" }
```
