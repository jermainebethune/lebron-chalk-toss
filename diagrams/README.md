# Diagrams

Source HTML for every diagram made for this project. Self-contained — no build step, no
dependencies, no external assets. Open any file in a browser.

| File | What it is | Where it's published |
|---|---|---|
| `01-original-design-sketch.html` | The **plan**, before anything was built — one model, a happy path, no refusals. Kept deliberately for contrast | artifact `68a50115` |
| `02-architecture-walkthrough.html` | As-built, scrollable, with the full bug history | artifact `53599c28` |
| `03-architecture-onepage.html` | One-page reference: build path, request path, verification band | Evernote, project note |
| `04-build-ask-verify-observe.html` | ByteByteGo-style poster, five columns (REFRESH joined 26 Jul 2026) | Evernote, system design note |
| `05-what-is-a-worker.html` | Teaching diagram — server→Worker, isolates, how the page is produced, why the limits exist | Evernote, study note |
| `06-where-everything-lives.html` | Storage and geography — code everywhere, data in Virginia, cached vs stored | Evernote, study note |

Keeping `01` matters. The gap between what the plan looked like and what got built — one model
versus two, no refusals versus six — is the most honest thing in this repo.

---

## Two things that will confuse you later

**The `zoom:` value in each file is a screenshot-fitting hack, not a design decision.** These
were captured at a fixed viewport, so `zoom` was tuned per diagram until the content filled the
frame without clipping. It has no meaning. Change it freely; it only affects how a screenshot
crops.

**`02` has no `<!doctype>` or `<head>`.** It's written for the artifact publisher, which wraps
it. Opening it directly still renders, but em dashes and arrows will be mojibake because
nothing declares UTF-8. Add `<meta charset="utf-8">` if you need to view it standalone — that
exact problem cost a debugging round the first time.

---

## The visual language, since it took several attempts

The ByteByteGo idiom is a **poster**, not a dashboard:

- cream ground (`#FBFAEF`), never blue-grey
- big solid colour blocks behind the title words
- tall tinted columns with rounded borders
- pill labels sitting **on top of** white cards, overlapping the border
- **a large icon on every node** — the single biggest signature, and the thing most obviously
  missing from a first attempt
- dashed connectors with short bold annotations beside them
- generous vertical rhythm, far less text per box

The first attempt was a dense, blue-grey, icon-free business dashboard. It was wrong, and it
was wrong because it was built from a *description* of the style rather than from the style
itself. Looking at two real examples changed nearly every decision.

## Colour meanings, consistent across all of them

| Colour | Means |
|---|---|
| Orange | A model is involved — output untrusted until validated |
| Teal / green | Ground truth — numbers originate here |
| Indigo / blue | Platform — Worker, routing, compute |
| Red | Refusal — where it stops rather than guesses |
| Purple | Client, or verification |
| Gold | Scheduled data refresh — the cron lifecycle, no model and no laptop involved |

**Orange never touches green.** That's the argument of the whole system, visible before you
read a word: the model writes the query and describes the rows, and the only thing producing
numbers sits between them.
