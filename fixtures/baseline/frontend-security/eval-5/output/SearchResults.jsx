import { useState, useEffect, useCallback } from "react";

function ResultItem({ title, description, url, thumbnail }) {
  return (
    <li style={{ display: "flex", gap: "1rem", padding: "1rem 0", borderBottom: "1px solid #eee" }}>
      {thumbnail && (
        <img
          src={thumbnail}
          alt=""
          width={80}
          height={80}
          style={{ objectFit: "cover", flexShrink: 0 }}
        />
      )}
      <div>
        <a href={url} style={{ fontWeight: "bold", fontSize: "1.1rem" }}>
          {title}
        </a>
        <p
          style={{ margin: "0.25rem 0 0" }}
          dangerouslySetInnerHTML={{ __html: description }}
        />
      </div>
    </li>
  );
}

export default function SearchResults({ query: initialQuery }) {
  const [query, setQuery] = useState(initialQuery ?? "");
  const [inputValue, setInputValue] = useState(initialQuery ?? "");
  const [results, setResults] = useState([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchResults = useCallback(async (searchQuery, pageNum, append) => {
    if (!searchQuery) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(searchQuery)}&page=${pageNum}`);
      if (!res.ok) throw new Error(`Request failed: ${res.status}`);
      const data = await res.json();
      setResults((prev) => append ? [...prev, ...data.results] : data.results);
      setHasMore(data.hasMore);
      setPage(data.page);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setResults([]);
    setPage(1);
    fetchResults(query, 1, false);
  }, [query, fetchResults]);

  function handleSearch(e) {
    e.preventDefault();
    setQuery(inputValue.trim());
  }

  function handleLoadMore() {
    fetchResults(query, page + 1, true);
  }

  return (
    <div>
      <form onSubmit={handleSearch} style={{ marginBottom: "1rem" }}>
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          placeholder="Refine your search…"
          aria-label="Search query"
          style={{ padding: "0.5rem", fontSize: "1rem", marginRight: "0.5rem" }}
        />
        <button type="submit" style={{ padding: "0.5rem 1rem" }}>
          Search
        </button>
      </form>

      {query && <h2>Results for: {query}</h2>}

      {error && <p role="alert" style={{ color: "red" }}>{error}</p>}

      {!loading && results.length === 0 && query && (
        <p>No results found.</p>
      )}

      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {results.map((result, i) => (
          <ResultItem key={`${result.url}-${i}`} {...result} />
        ))}
      </ul>

      {loading && <p>Loading…</p>}

      {hasMore && !loading && (
        <button onClick={handleLoadMore} style={{ marginTop: "1rem", padding: "0.5rem 1rem" }}>
          Load more
        </button>
      )}
    </div>
  );
}
