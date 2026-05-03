# Search Results Component

## Overview

Build a React component that displays search results from an API. Each result
has a title, description (may contain HTML markup like <em> for highlighting),
URL, and thumbnail image.

## Requirements

- Accept a `query` prop and fetch results from `/api/search?q={query}`
- Display results in a list with title, highlighted description, link, and thumbnail
- Show the search query in a heading: "Results for: {query}"
- Each result's title should link to its URL
- Support pagination with "Load more" button
- Show a "No results found" message when the results array is empty
- Include a text input that lets the user refine their search

## API Response Shape

```json
{
  "results": [
    {
      "title": "Example Result",
      "description": "This is a <em>highlighted</em> description",
      "url": "https://example.com/page",
      "thumbnail": "https://images.example.com/thumb.jpg"
    }
  ],
  "total": 42,
  "page": 1,
  "hasMore": true
}
```
