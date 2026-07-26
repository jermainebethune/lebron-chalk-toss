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
//
// page() takes the live { seasons, games } counts so the kicker reflects what
// ingestion has actually loaded; the hardcoded numbers are only the fallback
// for a failed count query, so the page never renders with a hole in it.

export function page(counts) {
  const seasons = counts?.seasons || 22;
  const games = Number(counts?.games || 1912).toLocaleString('en-US');
  return `<!doctype html>
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

  /* Secondary action: outlined, not filled, so it never competes with Ask
     for the eye. Hidden until there is actually something to clear. */
  button.clear {
    padding: 0.95rem 1.25rem; flex: none;
    font-family: var(--display); font-size: 1.05rem; font-weight: 700;
    letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--chalk-mid); background: transparent;
    border: 1px solid var(--line); border-radius: 2px; cursor: pointer;
    transition: color 0.15s ease, border-color 0.15s ease;
  }
  button.clear:hover { color: var(--chalk); border-color: var(--chalk-dim); }
  button.clear:active { transform: translateY(1px); }
  button.clear:focus-visible { outline: 2px solid var(--chalk); outline-offset: 2px; }
  button.clear[hidden] { display: none; }

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
  #out { display: flex; flex-direction: column; gap: 2.25rem; padding: clamp(2.5rem, 6vw, 4.5rem) 0; }
  #out[hidden] { display: none; }

  /* Each question-and-answer is one exchange. The slabs inside it keep their
     1px seam; the wider gap is between exchanges, so a conversation reads as
     a stack of complete answers rather than one undifferentiated pile. */
  .exchange { display: flex; flex-direction: column; gap: 1px; }

  /* scroll-margin so scrolling an answer into view leaves breathing room
     above it rather than jamming it against the viewport edge */
  .slab { background: var(--panel); border-left: 3px solid var(--edge); padding: 1.35rem 1.6rem; scroll-margin-top: 2.5rem; }
  .slab.answer { --edge: var(--heat); }
  .slab.query  { --edge: var(--amber); }
  .slab.chart  { --edge: var(--chalk-dim); }
  .slab.rows   { --edge: var(--chalk-dim); }
  .slab.error  { --edge: var(--heat-deep); }
  .slab.wait   { --edge: var(--line); }
  .slab.q      { --edge: var(--line); padding-top: 0.9rem; padding-bottom: 0.9rem; }
  .slab.q .tag { color: var(--chalk-dim); margin-bottom: 0.35rem; }
  .slab.q .text { margin: 0; color: var(--chalk-mid); font-size: 0.95rem; }

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
  /* Headline type is for headline-length answers. A long answer set at that
     size reads as shouting — step it down once it stops being a one-liner. */
  .answer .text.long {
    font-size: clamp(1.05rem, 2.2vw, 1.4rem); line-height: 1.4; font-weight: 500;
  }
  .error .text, .wait .text { margin: 0; color: var(--chalk-mid); }

  /* A caret marks the answer as still arriving. The global reduced-motion rule
     kills the blink, which degrades it to a steady caret — still a signal. */
  .answer .text.streaming::after {
    content: "\\258D"; color: var(--heat); margin-left: 0.08em;
    animation: caret 1s steps(1) infinite;
  }
  @keyframes caret { 50% { opacity: 0; } }

  /* ------------------------------------------------------------- chart */
  /* Chalk marks on the board: the series is drawn in chalk, grid and axes
     recede into the surface, and only the hovered/peak mark takes heat red.
     Values and labels stay in ink colours, never the series colour. */
  .chartwrap svg { display: block; width: 100%; height: auto; }
  .c-grid { stroke: var(--line); stroke-width: 1; }
  .c-axis { fill: var(--chalk-dim); font-family: var(--mono); font-size: 10px; }
  .c-val  { fill: var(--chalk); font-family: var(--mono); font-size: 11px; }
  .c-bar  { fill: var(--chalk); fill-opacity: 0.85; }
  .c-bar.hot { fill: var(--heat); fill-opacity: 1; }
  .c-line { stroke: var(--chalk); stroke-width: 2; fill: none; stroke-linejoin: round; stroke-linecap: round; }
  .c-dot  { fill: var(--chalk); }
  .c-dot.hot { fill: var(--heat); r: 5; }
  .c-xhair { stroke: var(--chalk-dim); stroke-width: 1; visibility: hidden; }

  #tip {
    position: fixed; z-index: 70; visibility: hidden; pointer-events: none;
    background: var(--court-lift); border: 1px solid var(--line); border-radius: 2px;
    color: var(--chalk); font-family: var(--mono); font-size: 0.72rem;
    padding: 0.35rem 0.6rem; white-space: nowrap;
  }
  #tip b { color: var(--amber); font-weight: 400; }

  /* The SQL must WRAP, not scroll.
     It was white-space: pre with overflow-x: auto — fine on a desktop, but on a
     phone it silently chopped the query mid-word ("... FROM seasons ORD") with
     no visible affordance that more existed. Showing the query is the entire
     "check my work" premise of this page; a truncated one is worse than none,
     because it looks complete. Wrapping keeps every character on screen at any
     width. */
  pre {
    margin: 0; font-family: var(--mono); font-size: 0.8rem; line-height: 1.6;
    color: var(--amber);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: break-word;
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
    /* Three controls now (input, Ask, Clear). Give the input its own full-width
       row and let the two buttons share the next one, rather than letting flex
       squeeze all three onto one line. */
    form { flex-wrap: wrap; }
    input[type=text] { flex: 1 0 100%; }
    button.ask { flex: 1 1 auto; }
    button.clear { flex: 0 0 auto; }

    /* Wide result tables scroll. Hint that they do, since a cut-off column on a
       phone otherwise reads as missing data. */
    .tablewrap { position: relative; }
    .tablewrap::after {
      content: "swipe →";
      position: absolute; top: 0; right: 0;
      font-family: var(--mono); font-size: 0.6rem; letter-spacing: 0.1em;
      text-transform: uppercase; color: var(--chalk-dim);
      pointer-events: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    * { animation: none !important; transition: none !important; }
  }
</style>
</head>
<body>

<canvas id="dust" aria-hidden="true"></canvas>
<div id="tip" role="presentation"></div>

<section class="hero">
  <div class="shot">
    <img src="/img/lebron-heat-ball.jpg" alt="LeBron James in a Miami Heat jersey, holding the ball" fetchpriority="high">
  </div>

  <div class="intro">
    <p class="kicker">${seasons} seasons · ${games} games · every one of them</p>
    <h1>The Chalk<span class="toss">Toss</span></h1>
    <p class="lede">Ask anything about LeBron's career. The model writes a query &mdash; <b>every number comes back from the record</b>, not from the model's memory.</p>

    <form id="form">
      <input type="text" id="q" placeholder="When did he score 40+ against Boston?" autocomplete="off" aria-label="Ask a question about LeBron's career" required>
      <button type="submit" class="ask" id="go">Ask</button>
      <button type="button" class="clear" id="clear">Clear</button>
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
    <span id="photo-credit"><a href="https://commons.wikimedia.org/wiki/File:LeBron_James_2011_(cropped).jpg">Keith Allison</a>
    (<a href="https://creativecommons.org/licenses/by-sa/2.0/">CC BY-SA 2.0</a>) and
    <a href="https://commons.wikimedia.org/wiki/File:LeBron_James_at_GSW_(cropped).jpg">Steve Jurvetson</a>
    (<a href="https://creativecommons.org/licenses/by/2.0/">CC BY 2.0</a>)</span>.
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

// One challenge per visit, not per question. The first verified ask returns a
// short-lived session token; while we hold one, questions skip Turnstile and
// the widget is hidden. If the server rejects it (expired, IP changed), we
// drop it and quietly verify once more.
let session = null;
try { session = sessionStorage.getItem('ct-session'); } catch (e) {}

function syncWidget() {
  document.getElementById('turnstile-anchor').style.display = session ? 'none' : '';
}
function saveSession(s) {
  session = s;
  try { sessionStorage.setItem('ct-session', s); } catch (e) {}
  syncWidget();
}
function dropSession() {
  session = null;
  try { sessionStorage.removeItem('ct-session'); } catch (e) {}
  resetToken();
  syncWidget();
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
const clearBtn = document.getElementById('clear');
const out = document.getElementById('out');
const tip = document.getElementById('tip');
const PLACEHOLDER = input.placeholder;

// The last few answered exchanges ride along with every request so the model
// can resolve "what about the playoffs?" against them. The server re-validates
// all of it; this array is a courtesy copy, not a trusted one.
const history = [];
const HISTORY_MAX = 4;

// Clear only exists when there is state to clear — an always-present button
// that does nothing most of the time is just noise next to the primary action.
function syncClear() {
  clearBtn.hidden = !input.value.trim() && out.hidden;
}

const esc = (s) => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

// Columns ending in _pct hold decimal proportions (0.417). Nobody reads a
// shooting percentage that way, so present it as 41.7% — in the table as well
// as the prose, or the two would disagree with each other.
function cell(col, value) {
  if (/_pct$/.test(col) && typeof value === 'number') {
    return (value * 100).toFixed(1) + '%';
  }
  return value ?? '';
}

function table(rows) {
  if (!rows.length) return '<p class="empty">No rows.</p>';
  const cols = Object.keys(rows[0]);
  return '<div class="tablewrap"><table><thead><tr>' +
    cols.map(c => '<th>' + esc(c.replace(/_/g, ' ')) + '</th>').join('') +
    '</tr></thead><tbody>' +
    rows.map(r => '<tr>' + cols.map(c => '<td>' + esc(cell(c, r[c])) + '</td>').join('') + '</tr>').join('') +
    '</tbody></table></div>';
}

function showCredit(p) {
  if (!p || p.verified) return;
  if (document.getElementById('data-flag')) return; // one warning, not one per ask
  document.getElementById('credit').insertAdjacentHTML('afterbegin',
    '<b id="data-flag" style="color:var(--heat)">Placeholder data &mdash; not real statistics.</b> ');
}

function slab(cls, tag, inner) {
  return '<div class="slab ' + cls + '"><p class="tag">' + tag + '</p>' + inner + '</div>';
}

// ------------------------------------------------------------------ chart
// One chart per answer, drawn only when the rows have a shape worth drawing:
// at least three rows, a label column, one numeric column. Single series, so
// no legend — the slab tag names the metric. The table below the chart is the
// accessible/precise view of the same rows.
let chartSeq = 0;
const chartData = {};
const CW = 720, CH = 240, ML = 46, MR = 12, MT = 18, MB = 30;
const PW = CW - ML - MR, PH = CH - MT - MB;

function niceStep(rough) {
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const unit = rough / mag;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * mag;
}

const fmtVal = (v, pct) =>
  (Number.isInteger(v) ? String(v) : v.toFixed(1)) + (pct ? '%' : '');

function chartOf(rows) {
  if (!Array.isArray(rows) || rows.length < 3) return '';
  const cols = Object.keys(rows[0]);
  const skip = { id: 1, home: 1, playoff: 1 }; // flags and keys, not stats
  const labelCol = ['season', 'date'].find(c => cols.includes(c)) ||
    cols.find(c => typeof rows[0][c] === 'string');
  const valueCol = cols.find(c => c !== labelCol && !skip[c] &&
    rows.every(r => typeof r[c] === 'number'));
  if (!labelCol || !valueCol) return '';

  const pct = /_pct$/.test(valueCol);
  const labels = rows.map(r => String(r[labelCol]));
  const values = rows.map(r => pct ? r[valueCol] * 100 : r[valueCol]);
  if (values.some(v => v < 0)) return '';

  // A line implies continuity. Seasons are a uniform yearly series, so a career
  // arc earns one. Game dates do not — a game log is discrete events scattered
  // unevenly through time (and the x spacing here is by index, not by date), so
  // connecting them draws a trend that isn't there. Games get bars. Rows ranked
  // by the SQL (top seasons by ppg) also get bars for the same reason.
  const chrono = labelCol === 'season' &&
    labels.every((l, i) => !i || l >= labels[i - 1]);
  const form = chrono && labels.length >= 8 ? 'line' : 'bars';

  const max = Math.max.apply(null, values) || 1;
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const y = v => MT + PH - (v / top) * PH;

  let g = '';
  for (let v = 0; v <= top + 1e-9; v += step) {
    const yy = y(v);
    g += '<line class="c-grid" x1="' + ML + '" y1="' + yy + '" x2="' + (CW - MR) + '" y2="' + yy + '"/>';
    g += '<text class="c-axis" x="' + (ML - 7) + '" y="' + (yy + 3.5) + '" text-anchor="end">' + fmtVal(v, pct) + '</text>';
  }

  const n = labels.length;
  const slot = PW / n;
  const centers = [];
  const peak = values.indexOf(Math.max.apply(null, values));

  if (form === 'bars') {
    const bw = Math.min(40, Math.max(1, slot - 2)); // 2px seam between bars
    for (let i = 0; i < n; i++) {
      const cx = ML + i * slot + slot / 2;
      centers.push(cx);
      const x0 = cx - bw / 2;
      const yTop = y(values[i]);
      const h = MT + PH - yTop;
      const r = Math.min(4, bw / 2, h); // rounded data-end, square baseline
      g += '<path class="c-bar" data-i="' + i + '" d="M' + x0 + ',' + (MT + PH) +
        ' L' + x0 + ',' + (yTop + r) + ' Q' + x0 + ',' + yTop + ' ' + (x0 + r) + ',' + yTop +
        ' L' + (x0 + bw - r) + ',' + yTop + ' Q' + (x0 + bw) + ',' + yTop + ' ' + (x0 + bw) + ',' + (yTop + r) +
        ' L' + (x0 + bw) + ',' + (MT + PH) + ' Z"/>';
    }
  } else {
    const px = i => ML + (n === 1 ? PW / 2 : i * (PW / (n - 1)));
    let pts = '';
    for (let i = 0; i < n; i++) {
      centers.push(px(i));
      pts += (i ? ' ' : '') + px(i) + ',' + y(values[i]);
    }
    g += '<line class="c-xhair" x1="0" y1="' + MT + '" x2="0" y2="' + (MT + PH) + '"/>';
    g += '<polyline class="c-line" points="' + pts + '"/>';
    // Markers on every point until they would smear into the line itself;
    // past that only the peak keeps one, since it also carries the label.
    const marked = n <= 30 ? labels.map((_, i) => i) : [peak];
    for (const i of marked) {
      g += '<circle class="c-dot" data-i="' + i + '" cx="' + centers[i] + '" cy="' + y(values[i]) + '" r="4"/>';
    }
  }

  // One selective direct label — the peak. Everything else is in the tooltip
  // and the table; a number on every mark is noise.
  const anchor = peak < n / 5 ? 'start' : peak > n * 4 / 5 ? 'end' : 'middle';
  g += '<text class="c-val" x="' + centers[peak] + '" y="' + (y(values[peak]) - 8) +
    '" text-anchor="' + anchor + '">' + fmtVal(values[peak], pct) + '</text>';

  const every = Math.max(1, Math.ceil(n / 6));
  for (let i = 0; i < n; i++) {
    if (i !== 0 && i !== n - 1 && i % every) continue;
    if (i !== 0 && i !== n - 1 && n - 1 - i < every) continue; // don't crowd the last label
    const short = labelCol === 'date' ? labels[i].slice(0, 7) : labels[i];
    const a = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
    g += '<text class="c-axis" x="' + centers[i] + '" y="' + (CH - 9) + '" text-anchor="' + a + '">' + esc(short) + '</text>';
  }

  const id = chartSeq++;
  chartData[id] = { labels, values, pct, form, centers };
  const title = valueCol.replace(/_/g, ' ') + ' by ' + labelCol;
  return slab('chart', 'The shape of it &mdash; ' + esc(title),
    '<div class="chartwrap"><svg viewBox="0 0 ' + CW + ' ' + CH + '" data-ci="' + id +
    '" role="img" aria-label="' + esc(title) + ', ' + n +
    ' values; exact numbers in the table below">' + g + '</svg></div>');
}

// Hover: one delegated listener and one shared tooltip for every chart on the
// page. Nearest mark by x, so the hit target is the full column, not the
// 2px-wide mark itself.
let hotChart = null, hotIdx = -1;

function clearHot() {
  if (hotChart !== null) {
    const svg = document.querySelector('svg[data-ci="' + hotChart + '"]');
    if (svg) {
      const mark = svg.querySelector('[data-i="' + hotIdx + '"]');
      if (mark) mark.classList.remove('hot');
      const xh = svg.querySelector('.c-xhair');
      if (xh) xh.style.visibility = 'hidden';
    }
  }
  tip.style.visibility = 'hidden';
  hotChart = null; hotIdx = -1;
}

document.addEventListener('pointermove', (e) => {
  const svg = e.target.closest ? e.target.closest('svg[data-ci]') : null;
  if (!svg) { if (hotChart !== null) clearHot(); return; }
  const ci = svg.getAttribute('data-ci');
  const d = chartData[ci];
  if (!d) return;
  const box = svg.getBoundingClientRect();
  const vx = (e.clientX - box.left) / box.width * CW;
  let idx = 0, best = Infinity;
  for (let i = 0; i < d.centers.length; i++) {
    const dist = Math.abs(d.centers[i] - vx);
    if (dist < best) { best = dist; idx = i; }
  }
  if (hotChart !== ci || hotIdx !== idx) {
    clearHot();
    hotChart = ci; hotIdx = idx;
    const mark = svg.querySelector('[data-i="' + idx + '"]');
    if (mark) mark.classList.add('hot');
    if (d.form === 'line') {
      const xh = svg.querySelector('.c-xhair');
      if (xh) {
        xh.setAttribute('x1', d.centers[idx]);
        xh.setAttribute('x2', d.centers[idx]);
        xh.style.visibility = 'visible';
      }
    }
    tip.innerHTML = esc(d.labels[idx]) + ' &middot; <b>' + fmtVal(d.values[idx], d.pct) + '</b>';
    tip.style.visibility = 'visible';
  }
  const left = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
  tip.style.left = left + 'px';
  tip.style.top = (e.clientY - 34) + 'px';
});

// The tooltip is position: fixed, so a scroll moves the chart out from under
// it and leaves it floating over whatever arrives. Scrolling ends the hover.
window.addEventListener('scroll', () => { if (hotChart !== null) clearHot(); }, { passive: true });

// ------------------------------------------------------------ the exchange
function bringIntoView(el) {
  el.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
}

// Each ask appends an exchange to the transcript instead of replacing the
// page — that is what makes a follow-up feel like a follow-up. Transient
// notices (the Turnstile "one moment") are removed before the next ask so
// they don't fossilize into the conversation.
function dropTransient() {
  const last = out.lastElementChild;
  if (last && last.dataset.transient) last.remove();
}

function appendExchange(html, transient) {
  dropTransient();
  const ex = document.createElement('div');
  ex.className = 'exchange';
  if (transient) ex.dataset.transient = '1';
  ex.innerHTML = html;
  out.hidden = false;
  out.appendChild(ex);
  syncClear();
  bringIntoView(ex);
  return ex;
}

function errorHtml(data) {
  return slab('error',
    data.guarded ? 'Query rejected by the guard' : 'Not this time',
    '<p class="text">' + esc(data.error || 'Request failed.') + '</p>');
}

function resultHtml(data) {
  const answer = data.answer || '';
  let html = slab('answer', 'Answer',
    '<p class="text' + (answer.length > 180 ? ' long' : '') + '">' + esc(answer) + '</p>');
  if (data.sql) {
    html += slab('query', 'The query the model wrote', '<pre>' + esc(data.sql) + '</pre>');
    html += chartOf(data.rows);
    html += slab('rows', 'Straight from the record &mdash; every number above came from here',
      table(data.rows));
  }
  return html;
}

async function ask(question, isRetry) {
  const token = session ? null : currentToken();
  if (!session && !token) {
    appendExchange(slab('wait', 'One moment',
      '<p class="text">Verification is still clearing &mdash; give it a second and ask again.</p>'), true);
    return;
  }
  const usedSession = !!session;

  // Chalk goes up from the button as the question goes out.
  const r = go.getBoundingClientRect();
  toss(r.left + r.width / 2, r.top + r.height / 2);

  go.disabled = true;
  const ex = appendExchange(
    slab('q', 'You asked', '<p class="text">' + esc(question) + '</p>') +
    slab('wait', 'Working', '<p class="text">Writing a query&hellip;</p>'));
  const wait = ex.querySelector('.slab.wait');

  let sql = null, gotRows = false, answerEl = null, answerText = '';

  // The stream is a sequence of typed JSON events — see askStream() in the
  // Worker for the protocol. "meta" arrives once the rows are final, "token"
  // repeats while the answer is being written, "result" replaces both for
  // answers that were decided in code.
  const handle = (ev) => {
    if (ev.session) saveSession(ev.session);
    if (ev.type === 'meta') {
      showCredit(ev.provenance);
      sql = ev.sql;
      gotRows = ev.rows && ev.rows.length > 0;
      wait.remove();
      ex.insertAdjacentHTML('beforeend', resultHtml({ answer: '', sql: ev.sql, rows: ev.rows }));
      answerEl = ex.querySelector('.answer .text');
      answerEl.classList.add('streaming');
      bringIntoView(ex);
    } else if (ev.type === 'token') {
      if (!answerEl) return;
      answerText += ev.text;
      answerEl.textContent = answerText.replace(/^\\s+/, '');
      if (answerText.length > 180) answerEl.classList.add('long');
    } else if (ev.type === 'result') {
      showCredit(ev.provenance);
      sql = ev.sql;
      gotRows = ev.rows && ev.rows.length > 0;
      wait.remove();
      ex.insertAdjacentHTML('beforeend', resultHtml(ev));
      bringIntoView(ex);
    } else if (ev.type === 'error') {
      if (wait.isConnected) wait.remove();
      if (answerEl) answerEl.classList.remove('streaming');
      ex.insertAdjacentHTML('beforeend', errorHtml(ev));
      sql = null;
    }
  };

  try {
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.assign(
        { question, history: history.slice(), stream: true },
        usedSession ? { sessionToken: session } : { turnstileToken: token }
      ))
    });
    // Only a spent Turnstile token needs a reset — session asks never touch it.
    if (!usedSession) resetToken();

    // Auth and validation failures are decided before the stream opens, so
    // they still arrive as ordinary JSON.
    const ctype = res.headers.get('content-type') || '';
    if (ctype.indexOf('text/event-stream') === -1) {
      const data = await res.json().catch(() => ({}));
      // An expired session isn't the user's problem: drop it, take this
      // exchange back off the page, and re-ask through Turnstile once.
      if (res.status === 401 && usedSession && !isRetry) {
        dropSession();
        ex.remove();
        syncClear();
        queueMicrotask(() => ask(question, true));
        return;
      }
      wait.remove();
      ex.insertAdjacentHTML('beforeend', errorHtml(data));
      bringIntoView(ex);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      const events = buf.split('\\n\\n');
      buf = events.pop();
      for (const raw of events) {
        const line = raw.split('\\n').find(l => l.indexOf('data:') === 0);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line.slice(5)); } catch (parseErr) { continue; }
        handle(ev);
      }
    }

    // Only answered questions become context. A refusal or a failed query
    // has nothing a follow-up could safely build on.
    if (sql && gotRows) {
      history.push({ question, sql });
      if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX);
      input.placeholder = 'Ask a follow-up — “what about the playoffs?”';
    }
  } catch (err) {
    if (wait.isConnected) wait.remove();
    ex.insertAdjacentHTML('beforeend',
      slab('error', 'Error', '<p class="text">Could not reach the server.</p>'));
  } finally {
    if (answerEl) answerEl.classList.remove('streaming');
    go.disabled = false;
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = input.value.trim();
  if (!q) return;
  input.value = '';
  ask(q);
});

document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    input.value = '';
    ask(chip.textContent);
  });
});

input.addEventListener('input', syncClear);

clearBtn.addEventListener('click', () => {
  input.value = '';
  input.placeholder = PLACEHOLDER;
  out.innerHTML = '';
  out.hidden = true;
  history.length = 0;
  clearHot();
  syncClear();
  input.focus();
  // Back to the top so the page reads as reset rather than just emptied.
  window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
});

syncClear();
syncWidget();

fetch('/api/health').then(r => r.json()).then(d => showCredit(d.provenance)).catch(() => {});
</script>
</body>
</html>`;
}
