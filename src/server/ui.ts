/**
 * Settings UI — a single self-contained page served at /.
 *
 * Deliberately one hand-written string rather than a build step: the whole surface is five fields
 * and a list of books. A bundler, framework and asset pipeline would be more machinery than the
 * thing it serves, and would mean the container could no longer be built from `tsc` alone.
 *
 * There is no auth, matching the deployment model (single user, private network only). That is
 * also why nothing here ever renders an API key: keys live in env and are never sent to the
 * browser, so an unauthenticated page has nothing worth stealing.
 */
export const SETTINGS_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>worldbrain</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fbfbfa; --fg: #1a1a19; --muted: #6b6b68;
    --line: #e2e2df; --card: #fff; --accent: #3b6ea5;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#16161a; --fg:#e8e8e6; --muted:#9a9a97; --line:#2c2c31; --card:#1e1e23; --accent:#7aa7d9; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 1.25rem; background: var(--bg); color: var(--fg);
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 46rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; letter-spacing: -.01em; }
  .sub { color: var(--muted); margin: 0 0 2rem; font-size: .9rem; }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 1.25rem; margin-bottom: 1.25rem; }
  h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); margin: 0 0 1rem; }
  label { display: block; margin-bottom: .9rem; }
  label > span { display: block; font-size: .82rem; color: var(--muted); margin-bottom: .3rem; }
  input[type=text], select {
    width: 100%; padding: .5rem .6rem; border: 1px solid var(--line); border-radius: 6px;
    background: var(--bg); color: var(--fg); font: inherit; font-size: .92rem;
  }
  .row { display: flex; align-items: center; gap: .5rem; margin-bottom: .9rem; }
  .row input { width: auto; }
  .row label { margin: 0; }
  button {
    background: var(--accent); color: #fff; border: 0; border-radius: 6px;
    padding: .5rem 1.1rem; font: inherit; font-weight: 500; cursor: pointer;
  }
  button:disabled { opacity: .55; cursor: default; }
  .status { margin-left: .75rem; font-size: .85rem; color: var(--muted); }
  .hint { font-size: .82rem; color: var(--muted); margin: .75rem 0 0; }
  table { width: 100%; border-collapse: collapse; font-size: .9rem; }
  th { text-align: left; font-weight: 500; color: var(--muted); font-size: .78rem;
       text-transform: uppercase; letter-spacing: .05em; padding-bottom: .5rem; }
  td { padding: .45rem 0; border-top: 1px solid var(--line); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; color: var(--muted); }
  .tag { display: inline-block; background: var(--bg); border: 1px solid var(--line);
         border-radius: 4px; padding: .05rem .35rem; margin-right: .25rem; font-size: .78rem; }
  .empty { color: var(--muted); font-style: italic; }
</style>
</head>
<body>
<main>
  <h1>worldbrain</h1>
  <p class="sub">Shared context store. One book per project, read and written by every AI tool you use.</p>

  <section>
    <h2>Books</h2>
    <div id="books"><p class="empty">Loading…</p></div>
  </section>

  <section>
    <h2>Settings</h2>
    <form id="form">
      <div class="row">
        <input type="checkbox" id="embeddingEnabled">
        <label for="embeddingEnabled">Embeddings enabled (required for semantic search)</label>
      </div>
      <label>
        <span>Embedding provider</span>
        <select id="embeddingRouter">
          <option value="openai">OpenAI</option>
          <option value="openrouter">OpenRouter</option>
          <option value="openrouter_external">OpenRouter (external key)</option>
          <option value="voyage">Voyage</option>
          <option value="ollama">Ollama (local)</option>
        </select>
      </label>
      <label>
        <span>Embedding model</span>
        <input type="text" id="embeddingModel" placeholder="text-embedding-3-small">
      </label>
      <label>
        <span>Extraction provider</span>
        <select id="llmRouter">
          <option value="openai">OpenAI</option>
          <option value="openrouter">OpenRouter</option>
          <option value="nanogpt">nanoGPT</option>
          <option value="custom">Custom (OpenAI-compatible)</option>
        </select>
      </label>
      <label>
        <span>Extraction model</span>
        <input type="text" id="llmModel" placeholder="gpt-4o-mini">
      </label>
      <button type="submit" id="save">Save</button>
      <span class="status" id="status"></span>
      <p class="hint">
        API keys are read from environment variables and are never stored in the database or shown here.
        The embedding model must produce <strong>1024 dimensions</strong> — the vector column is fixed at
        that size, so switching to a model of another size needs a schema migration and a full re-embed.
      </p>
    </form>
  </section>

  <section>
    <h2>Connect a client</h2>
    <p class="hint" style="margin-top:0">
      Remote MCP clients point at <code id="mcpurl">/mcp</code>. For Claude Desktop or Cursor, which
      spawn a process instead, use the bridge:
    </p>
    <pre style="overflow-x:auto;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:.75rem;font-size:.82rem"><code>{
  "mcpServers": {
    "worldbrain": {
      "command": "npx",
      "args": ["-y", "worldbrain-stdio"],
      "env": { "WORLDBRAIN_URL": "<span id="baseurl">http://localhost:8080</span>" }
    }
  }
}</code></pre>
  </section>
</main>

<script>
const $ = (id) => document.getElementById(id);
const status = $("status");

document.getElementById("baseurl").textContent = location.origin;
document.getElementById("mcpurl").textContent = location.origin + "/mcp";

async function loadSettings() {
  const s = await (await fetch("/api/settings")).json();
  $("embeddingEnabled").checked = s.embeddingEnabled;
  $("embeddingRouter").value = s.embeddingRouter ?? "openai";
  $("embeddingModel").value = s.embeddingModel ?? "";
  $("llmRouter").value = s.llmRouter ?? "openai";
  $("llmModel").value = s.llmModel ?? "";
}

async function loadBooks() {
  const el = $("books");
  try {
    const books = await (await fetch("/api/worlds")).json();
    if (!books.length) {
      el.innerHTML = '<p class="empty">No books yet. Ask a connected AI tool to create one with world_create.</p>';
      return;
    }
    el.innerHTML = '<table><thead><tr><th>Title</th><th>Tags</th><th>Entities</th><th>Updated</th></tr></thead><tbody>'
      + books.map(b =>
          '<tr><td>' + escapeHtml(b.title)
          + (b.readOnly ? ' <span class="tag">read-only</span>' : '')
          + (b.tagGated ? ' <span class="tag">tag-gated</span>' : '')
          + '<br><code>' + b.id + '</code></td>'
          + '<td>' + (b.tags.map(t => '<span class="tag">' + escapeHtml(t) + '</span>').join('') || '<span class="empty">none</span>') + '</td>'
          + '<td>' + b.entityCount + '</td>'
          + '<td>' + new Date(b.updatedAt).toLocaleDateString() + '</td></tr>'
        ).join('')
      + '</tbody></table>';
  } catch {
    el.innerHTML = '<p class="empty">Could not load books — is the database reachable?</p>';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("save").disabled = true;
  status.textContent = "Saving…";
  try {
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeddingEnabled: $("embeddingEnabled").checked,
        embeddingRouter: $("embeddingRouter").value,
        embeddingModel: $("embeddingModel").value || null,
        llmRouter: $("llmRouter").value,
        llmModel: $("llmModel").value || null,
      }),
    });
    status.textContent = res.ok ? "Saved." : "Failed to save.";
  } catch {
    status.textContent = "Failed to save.";
  } finally {
    $("save").disabled = false;
    setTimeout(() => (status.textContent = ""), 3000);
  }
});

loadSettings().catch(() => (status.textContent = "Could not load settings."));
loadBooks();
</script>
</body>
</html>`;
