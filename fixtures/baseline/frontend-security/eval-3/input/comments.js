export class CommentSection {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.comments = [];
  }

  async loadComments() {
    const response = await fetch('/api/comments');
    this.comments = await response.json();
    this.render();
  }

  render() {
    this.container.innerHTML = '';
    this.comments.forEach(comment => {
      const html = `
        <div class="comment" id="comment-${comment.id}">
          <strong>${comment.author}</strong>
          <span class="date">${comment.date}</span>
          <div class="body">${comment.body}</div>
          <button onclick="deleteComment(${comment.id})">Delete</button>
        </div>
      `;
      this.container.innerHTML += html;
    });
  }

  addComment(author, body) {
    fetch('/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author, body })
    });
    this.loadComments();
  }

  search(query) {
    const results = this.comments.filter(c =>
      c.body.includes(query) || c.author.includes(query)
    );
    document.getElementById('search-results').innerHTML =
      `<p>Found ${results.length} results for "${query}"</p>`;
  }
}
