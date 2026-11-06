# GoalScope ⚽

An installable mobile web app (PWA) that scans football matches being played right now and estimates
**whether another goal will come before the final whistle — and how many.**

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

## Data

Live scores, lineups, form, head-to-head and standings come from ESPN's public soccer feeds
(no API key). About 25 competitions are tracked (top-5 European leagues, UEFA competitions, MLS,
Liga MX, Brasileirão, and more — see `LEAGUES` in `js/api.js`).

If live data can't be reached, the app falls back to **demo matches** so you can still explore it.
Demo mode can also be switched on in ⚙ Settings. If your browser blocks the feed (CORS), set a
CORS proxy in Settings, e.g. `https://corsproxy.io/?url={url}`.

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
sw.js                 Service worker (offline app shell)
manifest.webmanifest  PWA manifest
tests/                Unit tests
```
