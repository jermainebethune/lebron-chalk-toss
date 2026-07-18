// The Chalk Toss — the page.
//
// Design notes, so a later edit doesn't quietly undo the intent:
//
// The motif is the pre-game ritual: chalk into the air, then the game starts.
// So the ground is arena-dark, the type is chalk-white, and asking a question
// throws a puff of chalk. That burst is the one piece of motion on the page and
// it fires on submit only — it marks the moment the question goes up, which is
// the same beat the ritual marks.
//
// Colour is Heat black-and-red because both photographs are from the Miami
// years. If the photos are ever swapped for Cleveland or Lakers shots, the
// accent should move with them or the page will look mismatched.
//
// Served inline so the Worker has no template dependency. Photos come from
// /img/ via the static assets binding.

export const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The Chalk Toss — LeBron's career, straight from the record</title>
<meta name="description" content="Ask about LeBron James' career in plain English. The model writes a SQL query; every number comes back from the database.">
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileReady" async defer></script>
<style>
  :root {
    --court:      #0B0909;   /* arena dark, warm-biased */
    --court-lift: #141010;
    --panel:      #171212;
    --chalk:      #F4F0E7;   /* warm chalk, never pure white */
    --chalk-mid:  #A9A199;
    --chalk-dim:  #6E6862;
    --heat:       #D01B34;   /* Miami red */
    --heat-deep:  #8C0F22;
    --amber:      #D9932F;   /* hardwood */
    --line:       #2A2220;
    --line-soft:  #1E1817;

    --display: "Avenir Next Condensed", "Futura Condensed", "Helvetica Neue", -apple-system, sans-serif;
    --body: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }

  * { box-sizing: border-box; }

  html, body { background: var(--court); }

  body {
    margin: 0;
    color: var(--chalk);
    font-family: var(--body);
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
    overflow-x: hidden;
  }

  /* chalk-dust canvas sits above the page, ignores pointer events */
  #dust {
    position: fixed; inset: 0; width: 100%; height: 100%;
    pointer-events: none; z-index: 60;
  }

  /* ------------------------------------------------------------------ hero */
  .hero {
    display: grid;
    grid-template-columns: minmax(0, 0.82fr) minmax(0, 1.18fr);
    align-items: stretch;
    min-height: 100svh;
    border-bottom: 1px solid var(--line);
  }

  .shot { position: relative; overflow: hidden; background: #000; }
  .shot img {
    width: 100%; height: 100%; object-fit: cover; object-position: 50% 18%;
    display: block; filter: grayscale(0.28) contrast(1.06);
  }
  /* the photo dissolves into the page rather than sitting in a box */
  .shot::after {
    content: ""; position: absolute; inset: 0;
    background:
      linear-gradient(90deg, transparent 55%, var(--court) 99%),
      linear-gradient(0deg, var(--court) 2%, transparent 30%);
  }

  .intro {
    display: flex; flex-direction: column; justify-content: center;
    gap: 1.75rem; padding: clamp(2rem, 5vw, 4.5rem) clamp(1.5rem, 5vw, 4.5rem);
    min-width: 0;
  }

  .kicker {
    font-family: var(--mono); font-size: 0.68rem; letter-spacing: 0.24em;
    text-transform: uppercase; color: var(--heat); margin: 0;
  }

  h1 {
    font-family: var(--display);
    font-size: clamp(3.2rem, 11vw, 7rem);
    font-weight: 700; line-height: 0.86; letter-spacing: -0.02em;
    text-transform: uppercase; margin: 0;
    text-wrap: balance;
  }
  h1 .toss { display: block; color: var(--heat); }

  .lede {
    font-size: clamp(1rem, 1.6vw, 1.12rem); color: var(--chalk-mid);
    max-width: 34ch; margin: 0;
  }
  .lede b { color: var(--chalk); font-weight: 600; }

  /* ------------------------------------------------------------------ ask */
  form { display: flex; gap: 0.6rem; max-width: 34rem; }

  input[type=text] {
    flex: 1; min-width: 0;
    padding: 0.95rem 1.1rem;
    font-size: 1rem; font-family: var(--body); color: var(--chalk);
    background: var(--court-lift);
    border: 1px solid var(--line);
    border-radius: 2px;
  }
  input[type=text]::placeholder { color: var(--chalk-dim); }
  input[type=text]:focus-visible {
    outline: none; border-color: var(--heat);
    box-shadow: 0 0 0 3px rgba(208, 27, 52, 0.18);
  }

  button.ask {
    padding: 0.95rem 1.6rem; flex: none;
    font-family: var(--display); font-size: 1.05rem; font-weight: 700;
    letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--chalk); background: var(--heat);
    border: 0; border-radius: 2px; cursor: pointer;
    transition: background 0.15s ease, transform 0.08s ease;
  }
  button.ask:hover { background: var(--heat-deep); }
  button.ask:active { transform: translateY(1px); }
  button.ask:disabled { opacity: 0.45; cursor: default; }
  button.ask:focus-visible { outline: 2px solid var(--chalk); outline-offset: 2px; }

  .suggest { display: flex; flex-wrap: wrap; gap: 0.45rem; max-width: 36rem; }
  .chip {
    font-family: var(--body); font-size: 0.82rem;
    padding: 0.4rem 0.8rem; cursor: pointer;
    color: var(--chalk-mid); background: transparent;
    border: 1px solid var(--line); border-radius: 100px;
    transition: color 0.15s ease, border-color 0.15s ease;
  }
  .chip:hover { color: var(--chalk); border-color: var(--heat); }
  .chip:focus-visible { outline: 2px solid var(--heat); outline-offset: 2px; }

  #turnstile-anchor:not(:empty) { margin-top: 0.25rem; }

  /* ------------------------------------------------------------- results */
  .results { max-width: 60rem; margin: 0 auto; padding: 0 clamp(1.5rem, 5vw, 3rem); }
  #out { display: flex; flex-direction: column; gap: 1px; padding: clamp(2.5rem, 6vw, 4.5rem) 0; }
  #out[hidden] { display: none; }

  /* scroll-margin so scrolling an answer into view leaves breathing room
     above it rather than jamming it against the viewport edge */
  .slab { background: var(--panel); border-left: 3px solid var(--edge); padding: 1.35rem 1.6rem; scroll-margin-top: 2.5rem; }
  .slab.answer { --edge: var(--heat); }
  .slab.query  { --edge: var(--amber); }
  .slab.rows   { --edge: var(--chalk-dim); }
  .slab.error  { --edge: var(--heat-deep); }
  .slab.wait   { --edge: var(--line); }

  .tag {
    font-family: var(--mono); font-size: 0.64rem; letter-spacing: 0.2em;
    text-transform: uppercase; color: var(--edge); margin: 0 0 0.7rem;
  }
  .slab.rows .tag { color: var(--chalk-dim); }

  .answer .text {
    font-family: var(--display); font-size: clamp(1.35rem, 3vw, 1.85rem);
    font-weight: 600; line-height: 1.25; letter-spacing: -0.01em; margin: 0;
    text-wrap: pretty;
  }
  .error .text, .wait .text { margin: 0; color: var(--chalk-mid); }

  pre {
    margin: 0; font-family: var(--mono); font-size: 0.8rem; line-height: 1.6;
    color: var(--amber); overflow-x: auto; white-space: pre;
  }

  .tablewrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-family: var(--mono); font-size: 0.82rem; }
  th, td { text-align: left; padding: 0.5rem 1.2rem 0.5rem 0; white-space: nowrap; }
  th {
    color: var(--chalk-dim); font-weight: 400; font-size: 0.64rem;
    letter-spacing: 0.16em; text-transform: uppercase;
    border-bottom: 1px solid var(--line); padding-bottom: 0.6rem;
  }
  td { color: var(--chalk); border-bottom: 1px solid var(--line-soft); font-variant-numeric: tabular-nums; }
  tr:last-child td { border-bottom: 0; }
  .empty { color: var(--chalk-dim); margin: 0; font-family: var(--body); }

  /* --------------------------------------------------------------- how */
  .how {
    border-top: 1px solid var(--line);
    display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.85fr);
    align-items: center; gap: 0;
  }
  .how-copy { padding: clamp(2.5rem, 6vw, 4.5rem) clamp(1.5rem, 5vw, 4.5rem); }
  .how h2 {
    font-family: var(--display); font-size: clamp(1.8rem, 4vw, 2.6rem);
    font-weight: 700; text-transform: uppercase; letter-spacing: -0.015em;
    line-height: 1; margin: 0 0 1.1rem;
  }
  .how p { color: var(--chalk-mid); max-width: 46ch; margin: 0 0 1.5rem; }
  .how p b { color: var(--chalk); font-weight: 600; }

  .steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.75rem; }
  .steps li { display: grid; grid-template-columns: 1.9rem 1fr; gap: 0.85rem; align-items: baseline; }
  .steps .n {
    font-family: var(--mono); font-size: 0.72rem; color: var(--heat);
    border: 1px solid var(--line); border-radius: 2px; padding: 0.1rem 0; text-align: center;
  }
  .steps .s { font-size: 0.9rem; color: var(--chalk-mid); }
  .steps .s b { color: var(--chalk); font-weight: 600; }

  .shot.side { min-height: 26rem; }
  .shot.side::after {
    background:
      linear-gradient(270deg, transparent 55%, var(--court) 99%),
      linear-gradient(0deg, var(--court) 2%, transparent 34%);
  }

  /* ------------------------------------------------------------- footer */
  footer {
    border-top: 1px solid var(--line);
    padding: 2.25rem clamp(1.5rem, 5vw, 4.5rem) 3.5rem;
    display: flex; flex-direction: column; gap: 0.7rem;
    font-size: 0.8rem; color: var(--chalk-dim);
  }
  footer .stack-row { display: flex; flex-wrap: wrap; gap: 0.4rem 1.1rem; align-items: center; }
  footer .stack-row span { font-family: var(--mono); font-size: 0.7rem; letter-spacing: 0.12em; text-transform: uppercase; }
  footer a { color: var(--chalk-mid); text-decoration: none; border-bottom: 1px solid var(--line); }
  footer a:hover, footer a:focus-visible { color: var(--chalk); border-bottom-color: var(--heat); }
  .credit { max-width: 62ch; line-height: 1.5; }

  /* ------------------------------------------------------------ responsive */
  @media (max-width: 56rem) {
    .hero { grid-template-columns: 1fr; min-height: 0; }
    .shot { height: 42vh; min-height: 15rem; order: -1; }
    .shot img { object-position: 50% 12%; }
    .shot::after {
      background: linear-gradient(0deg, var(--court) 3%, transparent 55%);
    }
    .intro { padding-top: 1rem; }
    .how { grid-template-columns: 1fr; }
    .shot.side { height: 34vh; min-height: 14rem; order: 0; }
    .shot.side::after { background: linear-gradient(0deg, var(--court) 3%, transparent 55%); }
    form { flex-wrap: wrap; }
    input[type=text] { flex: 1 1 12rem; }
  }

  @media (prefers-reduced-motion: reduce) {
    * { animation: none !important; transition: none !important; }
  }
</style>
</head>
<body>

<canvas id="dust" aria-hidden="true"></canvas>

<section class="hero">
  <div class="shot">
    <img src="/img/lebron-heat-ball.jpg" alt="LeBron James in a Miami Heat jersey, holding the ball" fetchpriority="high">
  </div>

  <div class="intro">
    <p class="kicker">22 seasons · 1,565 games · one database</p>
    <h1>The Chalk<span class="toss">Toss</span></h1>
    <p class="lede">Ask anything about LeBron's career. The model writes a query &mdash; <b>every number comes back from the record</b>, not from the model's memory.</p>

    <form id="form">
      <input type="text" id="q" placeholder="When did he score 40+ against Boston?" autocomplete="off" aria-label="Ask a question about LeBron's career" required>
      <button type="submit" class="ask" id="go">Ask</button>
    </form>

    <div class="suggest">
      <button class="chip" type="button">When did he score 40+ against Boston?</button>
      <button class="chip" type="button">What was his best scoring season?</button>
      <button class="chip" type="button">Which playoff games were triple-doubles?</button>
      <button class="chip" type="button">What was his career high?</button>
    </div>

    <div id="turnstile-anchor"></div>
  </div>
</section>

<div class="results">
  <div id="out" hidden></div>
</div>

<section class="how">
  <div class="how-copy">
    <h2>Why it can't make things up</h2>
    <p>A chatbot asked for a statistic answers from memory, and can be confidently wrong. This one is never asked what it knows. The model has exactly two jobs, and <b>neither of them lets it invent a number</b>.</p>
    <ol class="steps">
      <li><span class="n">01</span><span class="s">Your question becomes a <b>SQL query</b></span></li>
      <li><span class="n">02</span><span class="s">A guard <b>validates that query</b> before it runs</span></li>
      <li><span class="n">03</span><span class="s">The database returns <b>real rows</b></span></li>
      <li><span class="n">04</span><span class="s">The model describes <b>only those rows</b></span></li>
    </ol>
  </div>
  <div class="shot side">
    <img src="/img/lebron-miami-6.jpg" alt="LeBron James in a Miami Heat number 6 jersey on the court" loading="lazy">
  </div>
</section>

<footer>
  <div class="stack-row">
    <span>Cloudflare Workers</span><span>&middot;</span>
    <span>Workers AI</span><span>&middot;</span>
    <span>D1</span><span>&middot;</span>
    <span>Turnstile</span>
  </div>
  <p class="credit" id="credit">
    Stats from the balldontlie API. Photographs from Wikimedia Commons, cropped and resized &mdash;
    <span id="photo-credit">credit and licence pending verification</span>.
    <a href="https://github.com/jermainebethune/lebron-chalk-toss">Source on GitHub</a>
  </p>
</footer>

<script>
// ---------------------------------------------------------------- turnstile
const SITEKEY = '0x4AAAAAAD4sTljW5JRb7KjZ';
let widgetId = null;

window.onTurnstileReady = function () {
  widgetId = turnstile.render('#turnstile-anchor', {
    sitekey: SITEKEY,
    theme: 'dark',
    size: 'flexible'
  });
};

function currentToken() {
  try { return widgetId !== null ? turnstile.getResponse(widgetId) : null; }
  catch (e) { return null; }
}
function resetToken() {
  try { if (widgetId !== null) turnstile.reset(widgetId); } catch (e) {}
}

// ------------------------------------------------------------- chalk burst
// The ritual: powder goes up when the question does. Fires on submit only —
// scattering it around would make it decoration instead of a signal.
const canvas = document.getElementById('dust');
const ctx = canvas.getContext('2d');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let motes = [];
let running = false;

function sizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
sizeCanvas();
window.addEventListener('resize', sizeCanvas);

function toss(x, y) {
  if (reduceMotion) return;
  for (let i = 0; i < 110; i++) {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 2.1;
    const speed = 1.4 + Math.random() * 5.2;
    motes.push({
      x: x + (Math.random() - 0.5) * 26,
      y: y + (Math.random() - 0.5) * 12,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      r: 0.7 + Math.random() * 2.6,
      life: 1,
      decay: 0.006 + Math.random() * 0.012
    });
  }
  if (!running) { running = true; requestAnimationFrame(step); }
}

function step() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  motes = motes.filter(m => m.life > 0);

  for (const m of motes) {
    m.x += m.vx;
    m.y += m.vy;
    m.vy += 0.055;          // gravity
    m.vx *= 0.985;          // drag
    m.vy *= 0.985;
    m.life -= m.decay;
    ctx.globalAlpha = Math.max(m.life, 0) * 0.72;
    ctx.fillStyle = '#F4F0E7';
    ctx.beginPath();
    ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  if (motes.length) requestAnimationFrame(step);
  else { running = false; ctx.clearRect(0, 0, canvas.width, canvas.height); }
}

// ------------------------------------------------------------------- ask
const form = document.getElementById('form');
const input = document.getElementById('q');
const go = document.getElementById('go');
const out = document.getElementById('out');

const esc = (s) => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

function table(rows) {
  if (!rows.length) return '<p class="empty">No rows.</p>';
  const cols = Object.keys(rows[0]);
  return '<div class="tablewrap"><table><thead><tr>' +
    cols.map(c => '<th>' + esc(c.replace(/_/g, ' ')) + '</th>').join('') +
    '</tr></thead><tbody>' +
    rows.map(r => '<tr>' + cols.map(c => '<td>' + esc(r[c] ?? '') + '</td>').join('') + '</tr>').join('') +
    '</tbody></table></div>';
}

function showCredit(p) {
  if (!p) return;
  if (!p.verified) {
    document.getElementById('credit').insertAdjacentHTML('afterbegin',
      '<b style="color:var(--heat)">Placeholder data &mdash; not real statistics.</b> ');
  }
}

// The hero is full-height, so anything written into #out starts below the
// fold. Every render must bring itself into view or the page looks inert —
// this caught out the "one moment" and error states, which appeared to do
// nothing at all.
function render(html) {
  out.hidden = false;
  out.innerHTML = html;
  (out.firstElementChild || out).scrollIntoView({
    behavior: reduceMotion ? 'auto' : 'smooth',
    block: 'start'
  });
}

async function ask(question) {
  const token = currentToken();
  if (!token) {
    render('<div class="slab wait"><p class="tag">One moment</p>' +
      '<p class="text">Verification is still clearing &mdash; give it a second and ask again.</p></div>');
    return;
  }

  // Chalk goes up from the button as the question goes out.
  const r = go.getBoundingClientRect();
  toss(r.left + r.width / 2, r.top + r.height / 2);

  go.disabled = true;
  render('<div class="slab wait"><p class="tag">Working</p><p class="text">Writing a query&hellip;</p></div>');

  try {
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question, turnstileToken: token })
    });
    const data = await res.json();
    resetToken();

    if (!res.ok) {
      render('<div class="slab error"><p class="tag">' +
        (data.guarded ? 'Query rejected by the guard' : 'Not this time') +
        '</p><p class="text">' + esc(data.error || 'Request failed.') + '</p></div>');
      return;
    }

    showCredit(data.provenance);

    let html = '<div class="slab answer"><p class="tag">Answer</p><p class="text">' +
      esc(data.answer) + '</p></div>';

    if (data.sql) {
      html += '<div class="slab query"><p class="tag">The query the model wrote</p><pre>' +
        esc(data.sql) + '</pre></div>';
      html += '<div class="slab rows"><p class="tag">Straight from the record &mdash; every number above came from here</p>' +
        table(data.rows) + '</div>';
    }
    render(html);
  } catch (err) {
    render('<div class="slab error"><p class="tag">Error</p><p class="text">Could not reach the server.</p></div>');
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

fetch('/api/health').then(r => r.json()).then(d => showCredit(d.provenance)).catch(() => {});
</script>
</body>
</html>`;
