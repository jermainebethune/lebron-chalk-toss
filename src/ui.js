// The page. Served inline so the Worker has no asset dependency.
//
// Design intent: the answer is never shown alone. The SQL that ran and the rows
// it returned sit directly beneath it, so a reader can always check the prose
// against the data it came from. That transparency is the product.

export const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stat Oracle</title>
<style>
  :root {
    --ground: #FBFAF8; --panel: #FFF; --ink: #14161A; --soft: #52565E;
    --faint: #8A8F98; --rule: #E3E1DC; --ai: #E8730C; --data: #1F6F7A;
    --warn-bg: #FDF1E4; --warn-ink: #A3341F;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    --display: "Avenir Next", Futura, "Trebuchet MS", sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ground: #121316; --panel: #1A1C20; --ink: #EDEBE7; --soft: #A8ACB4;
      --faint: #6E737C; --rule: #2C2F35; --ai: #F59A47; --data: #5FB8C4;
      --warn-bg: #2A1E12; --warn-ink: #E08472;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 3rem 1.25rem 5rem; background: var(--ground); color: var(--ink);
    font-family: var(--sans); line-height: 1.6;
  }
  .wrap { max-width: 40rem; margin: 0 auto; display: flex; flex-direction: column; gap: 1.75rem; }
  h1 {
    font-family: var(--display); font-size: 1.9rem; font-weight: 600;
    letter-spacing: -0.02em; margin: 0 0 0.4rem;
  }
  .sub { color: var(--soft); margin: 0; font-size: 0.95rem; }

  .banner {
    background: var(--warn-bg); border: 1px solid var(--warn-ink); border-radius: 3px;
    padding: 0.85rem 1rem; font-size: 0.86rem; color: var(--warn-ink);
  }
  .banner b { font-family: var(--mono); font-size: 0.8rem; }
  .banner[hidden] { display: none; }

  form { display: flex; gap: 0.6rem; }
  input {
    flex: 1; padding: 0.75rem 0.9rem; font-size: 1rem; font-family: var(--sans);
    background: var(--panel); color: var(--ink);
    border: 1px solid var(--rule); border-radius: 3px;
  }
  input:focus-visible { outline: 2px solid var(--data); outline-offset: 1px; }
  button {
    padding: 0.75rem 1.25rem; font-size: 0.95rem; font-family: var(--sans); font-weight: 600;
    background: var(--ink); color: var(--ground); border: 0; border-radius: 3px; cursor: pointer;
  }
  button:disabled { opacity: 0.45; cursor: default; }
  button:focus-visible { outline: 2px solid var(--data); outline-offset: 2px; }

  .examples { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  .chip {
    font-size: 0.82rem; padding: 0.35rem 0.7rem; background: transparent;
    color: var(--soft); border: 1px solid var(--rule); border-radius: 100px;
    cursor: pointer; font-family: var(--sans); font-weight: 400;
  }
  .chip:hover { border-color: var(--data); color: var(--data); }

  #out { display: flex; flex-direction: column; gap: 1rem; }
  #out[hidden] { display: none; }

  .card {
    background: var(--panel); border: 1px solid var(--rule);
    border-left: 3px solid var(--edge); border-radius: 3px; padding: 1rem 1.15rem;
  }
  .card.answer { --edge: var(--ai); }
  .card.query  { --edge: var(--ai); }
  .card.rows   { --edge: var(--data); }
  .card.error  { --edge: var(--warn-ink); }

  .label {
    font-family: var(--mono); font-size: 0.66rem; letter-spacing: 0.1em;
    text-transform: uppercase; color: var(--edge); margin: 0 0 0.5rem;
  }
  .answer p.text { margin: 0; font-size: 1.05rem; }
  pre {
    margin: 0; font-family: var(--mono); font-size: 0.78rem; line-height: 1.55;
    color: var(--soft); overflow-x: auto; white-space: pre;
  }
  .tablewrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 0.82rem; font-family: var(--mono); }
  th, td { text-align: left; padding: 0.4rem 0.9rem 0.4rem 0; border-bottom: 1px solid var(--rule); white-space: nowrap; }
  th { color: var(--faint); font-weight: 400; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; }
  td { font-variant-numeric: tabular-nums; }
  .empty { color: var(--faint); font-size: 0.88rem; margin: 0; }

  footer { font-size: 0.8rem; color: var(--faint); border-top: 1px solid var(--rule); padding-top: 1rem; }
</style>
</head>
<body>
<div class="wrap">

  <header>
    <h1>Stat Oracle</h1>
    <p class="sub">Ask in plain English. The model writes a SQL query &mdash; every number comes back from the database, not from the model.</p>
  </header>

  <div class="banner" id="banner" hidden></div>

  <form id="form">
    <input id="q" placeholder="When did he score 40+ against Boston?" autocomplete="off" required>
    <button type="submit" id="go">Ask</button>
  </form>

  <div class="examples">
    <button class="chip">When did he score 40+ against Boston?</button>
    <button class="chip">Which playoff games were triple-doubles?</button>
    <button class="chip">What was his best scoring season?</button>
    <button class="chip">How many games did he play in Miami?</button>
  </div>

  <div id="out" hidden></div>

  <footer>
    Workers &middot; Workers AI &middot; D1 &nbsp;|&nbsp; every generated query is validated before it runs
  </footer>

</div>

<script>
const form = document.getElementById('form');
const input = document.getElementById('q');
const go = document.getElementById('go');
const out = document.getElementById('out');
const banner = document.getElementById('banner');

const esc = (s) => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

function showBanner(p) {
  if (!p || p.verified) { banner.hidden = true; return; }
  banner.hidden = false;
  banner.innerHTML = '<b>PLACEHOLDER DATA</b> &mdash; these numbers are invented and are not real statistics. ' +
    'The pipeline works; the dataset has not been sourced yet. (' + esc(p.source) + ')';
}

function table(rows) {
  if (!rows.length) return '<p class="empty">No matching rows.</p>';
  const cols = Object.keys(rows[0]);
  return '<div class="tablewrap"><table><thead><tr>' +
    cols.map(c => '<th>' + esc(c) + '</th>').join('') +
    '</tr></thead><tbody>' +
    rows.map(r => '<tr>' + cols.map(c => '<td>' + esc(r[c] ?? '') + '</td>').join('') + '</tr>').join('') +
    '</tbody></table></div>';
}

async function ask(question) {
  go.disabled = true;
  out.hidden = false;
  out.innerHTML = '<div class="card"><p class="empty">Writing a query&hellip;</p></div>';

  try {
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question })
    });
    const data = await res.json();

    if (!res.ok) {
      out.innerHTML = '<div class="card error"><p class="label">' +
        (data.guarded ? 'Query rejected by the guard' : 'Error') +
        '</p><p class="text">' + esc(data.error || 'Request failed.') + '</p></div>';
      return;
    }

    showBanner(data.provenance);

    let html = '<div class="card answer"><p class="label">Answer</p><p class="text">' +
      esc(data.answer) + '</p></div>';

    if (data.sql) {
      html += '<div class="card query"><p class="label">SQL the model wrote</p><pre>' +
        esc(data.sql) + '</pre></div>';
      html += '<div class="card rows"><p class="label">Rows D1 returned &mdash; the actual source of every number above</p>' +
        table(data.rows) + '</div>';
    }
    out.innerHTML = html;
  } catch (err) {
    out.innerHTML = '<div class="card error"><p class="label">Error</p><p class="text">Could not reach the server.</p></div>';
  } finally {
    go.disabled = false;
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (input.value.trim()) ask(input.value.trim());
});

document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    input.value = chip.textContent;
    ask(chip.textContent);
  });
});

fetch('/api/health').then(r => r.json()).then(d => showBanner(d.provenance)).catch(() => {});
</script>
</body>
</html>`;
