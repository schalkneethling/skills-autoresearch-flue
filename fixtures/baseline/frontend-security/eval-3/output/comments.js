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

  #escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  render() {
    this.container.innerHTML = '';
    this.comments.forEach(comment => {
      const article = document.createElement('div');
      article.className = 'comment';
      article.id = `comment-${this.#escapeHtml(comment.id)}`;

      const author = document.createElement('strong');
      author.textContent = comment.author;

      const date = document.createElement('span');
      date.className = 'date';
      date.textContent = comment.date;

      const body = document.createElement('div');
      body.className = 'body';
      body.textContent = comment.body;

      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', () => deleteComment(comment.id));

      article.append(author, date, body, deleteBtn);
      this.container.appendChild(article);
    });
  }

  async addComment(author, body) {
    await fetch('/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author, body })
    });
    await this.loadComments();
  }

  search(query) {
    const results = this.comments.filter(c =>
      c.body.includes(query) || c.author.includes(query)
    );
    const container = document.getElementById('search-results');
    container.innerHTML = '';
    const p = document.createElement('p');
    p.textContent = `Found ${results.length} results for "${query}"`;
    container.appendChild(p);
  }
}
