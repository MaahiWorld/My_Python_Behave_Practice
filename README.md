# GoalScope ⚽

An installable mobile web app (PWA) that scans football matches being played right now and estimates
**whether another goal will come before the final whistle — and how many.**

## What you see

The **Live** tab lists every match being played right now, from any country the data sources
cover, sorted by how likely a goal is in the **next 15 minutes**:

> **Bodø/Glimt vs Molde · 62' · 2–2**
> ⚡ Goal expected soon: 61% chance of a goal in the next 15 minutes; half the time the next goal
> comes within ~12 minutes. 83% chance of another goal before full time.

Matches at 50% or more for the next 15 minutes are pinned in a **Goal watch** group at the top.
Open any match for the full reasoning.

## What it analyses

For every match it builds a Poisson goal model from:

| Factor | Source |
| --- | --- |
| **Attacking power** | Goals scored per game in the league table, blended with the last 5 results |
| **Defensive strength** | Goals conceded per game (table + last 5) |
| **Recent form** | W/D/L and goals in the last 5 matches |
| **Head to head** | Past meetings — average goals nudge the expectancy up or down |
| **Players on the pitch** | Live lineups, including substitutions and goalscorers |
| **Live state** | Minute played, scoreline (trailing side pushes), red cards, shots-on-target pressure |

It then shows the chance of at least one more goal, expected remaining goals, a distribution of
0 / 1 / 2 / 3 / 4 / 5+ more goals, the likeliest final scores, win/draw/loss odds, Over 2.5 and
both-teams-to-score, plus a "Stats runner" comparing the two sides and a plain-English list of every
adjustment the model made.

> Statistical estimates for fun and learning — not betting advice.

## Data sources

**ESPN (free, always on)** scans about 185 competitions worldwide: all major European leagues and
their lower divisions, plus the Americas, Asia, Africa, Oceania and international tournaments (see
`LEAGUES` in `js/api.js`). Every competition is scanned every 3 minutes; competitions with a live
match are refreshed every 30 seconds. Any competition ESPN doesn't recognise is skipped
automatically.

**API-Football (free key)** adds matches from its 1,000+ competitions that ESPN doesn't carry. The free
100 requests a day are managed automatically: the match list costs 1 request and refreshes at most
every 10 minutes (clocks are moved forward in between), an opened match's live stats refresh at most
every 3 minutes, and the app stops 5 requests before the daily limit. Matches found by both sources
are shown once.

Tap **⛁ Data sources** in the header to add keys. Each source has a key field and a **Test** button;
a working key joins the scan straight away, and a switch lets you leave a source out:

| Source | Cost | Adds |
| --- | --- | --- |
| ESPN (default) | Free | Scores, lineups, form, H2H, tables, shots |
| API-Football | Free 100 req/day, paid from ~$19/mo | 1,000+ leagues, xG for some leagues |
| Sportmonks | From ~€29/mo, live xG add-on ~€199/mo | Live expected goals (xG) |
| football-data.org | Free (delayed), live from ~€12/mo | Tables, form, H2H for 12 competitions |

Keys are stored only in the browser on your device (localStorage); they are never committed to the
repository. When a source supplies live xG, the prediction uses it in place of shots on target.

If live data can't be reached, the app falls back to **demo matches**. Demo mode can also be switched
on in ⚙ Settings. If your browser blocks a feed (CORS), set a CORS proxy in Settings, e.g.
`https://corsproxy.io/?url={url}`.

## How predictions are explained

Every match screen has a **Why this prediction** section: a confidence rating listing the data used
and missing, then each step (league baseline, attack vs defence, head to head, time left, game state,
red cards, live xG or shot pressure) in plain English with its evidence and how many expected goals it
adds or removes. The steps add up to the final figure.

## Run it

```bash
npm start          # serves on http://localhost:8080 (just python3 -m http.server)
npm test           # model + parser unit tests (Node 18+)
```

No build step and no dependencies — plain HTML, CSS and ES modules.

## Install on your phone

1. Publish it: push to `main` and enable **Settings → Pages → Source: GitHub Actions** on the
   repository; the included workflow deploys it to `https://<user>.github.io/<repo>/`.
2. Open that URL on your phone:
   - **Android (Chrome):** menu ⋮ → *Install app* / *Add to Home screen*
   - **iPhone (Safari):** Share → *Add to Home Screen*

## Project layout

```
index.html            App shell
css/styles.css        Styles (light + dark)
js/app.js             UI, routing, refresh loop
js/api.js             ESPN fetchers and parsers
js/model.js           Prediction model
js/demo.js            Offline demo data
js/sources.js         Paid/keyed data source adapters + registry
sw.js                 Service worker (offline app shell)
manifest.webmanifest  PWA manifest
tests/                Unit tests
```
