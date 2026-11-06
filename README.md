# GoalScope ⚽

An installable mobile web app (PWA) that scans football matches being played right now and estimates
**whether another goal will come before the final whistle — and how many.**

## What you see

The **Live** tab lists every match being played right now, from any country the data sources
cover, sorted by how many more goals are expected from the current minute to the end of the match:

> **Bodø/Glimt vs Molde · 62' · 2–2**
> About **1.9 more goals** expected before full time. **85%** chance of at least one more goal;
> most likely 1 more. 0 more 15% · 1 more 29% · 2 more 27% · 3 more 17% · 4+ more 12%

This works at every point of a match: from kick-off, through first-half added time (shown as 45+2'),
half time (counting the whole second half), late added time (90+3'),
the break before extra time, extra time, and penalty shoot-outs (which don't count as match goals).

Matches where at least one more goal is 75% likely or better are pinned in a **High goal scope** group at
the top.
Open any match for the full reasoning.

## Only high-confidence predictions

A match is listed only when its prediction is **high confidence**, meaning every core input is
available: season attacking/defensive records for both teams (5+ games), recent form for both
teams (4+ matches), and for live matches from 10', current match stats for both teams. Other matches
are hidden, with a count of how many and why; ⚙ Settings can show them if you want.

## How accurate is it? (backtest)

Replayed on 24,831 finished matches from 12 European leagues, tuned on 2019-20 to 2023-24 and scored
on 2024-25 to 2026-27 (unseen): validated Goal-market picks were correct **85 times in 100**
(1,363 of 1,601, all Over 1.5, against a natural Over 1.5 rate of 79 in 100). Full results, including
where the model adds little, in [backtest/RESULTS.md](backtest/RESULTS.md).

## Goal markets page

The **Goal markets** page lists Over 1.5, Over 2.5 and Both-teams-to-score picks (and their
Under/No sides) for live matches and those starting within 12 hours. A pick appears only when:

1. the match prediction is high confidence;
2. the model gives it at least 80%;
3. independent cross-checks all agree at 70%+: the season record alone, recent form alone, the
   prediction without live match stats, and head-to-head history (4+ meetings, before kick-off),
   with at least two checks required;
4. the market isn't already decided.

Every pick shown is stored on the device and marked won or lost at full time, so each market builds
its own track record (`js/markets.js`).

## What it analyses

Every prediction is built from four groups of inputs, each shown as its own step with its effect on
the goals expected for the rest of the match:

| Input | What it uses |
| --- | --- |
| **Attacking power vs defensive strength** | Each team's goals scored and conceded per game this season, against the league average; one side's attack is set against the other's defence |
| **Recent form** | Goals scored and conceded and W/D/L in the last 5 matches; counts 35% against the season level, or fully when there is no season record (cups) |
| **Current match stats** | Shots on target, total shots, corners and possession so far (plus xG when a source has it) compared with a typical team's pace; trusted more as the match goes on |
| **Match situation** | Minute and stage of the match, scoreline (a trailing team pushes forward), red cards, and head-to-head history |

Each match card shows how these moved the prediction, e.g. `Attack/defence ▲ +0.3 · Form ▼ −0.2 · Match stats ▲ +0.1`.

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
js/markets.js         Over 1.5 / 2.5 / BTTS picks, validation, track record
js/merge.js           Merging and de-duplicating matches across sources
sw.js                 Service worker (offline app shell)
manifest.webmanifest  PWA manifest
tests/                Unit tests
```
