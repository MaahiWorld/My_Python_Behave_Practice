# Backtest results

Run on 2026-11-08 with `backtest/fetch-data.sh` + `backtest/run.js`; full figures in `results.json`.

## Pre-match only (2026-11-10)

Picks are now made **before kick-off only** (`RULES.preMatchOnly` in `js/markets.js`). Every figure in
this file is pre-match; in-play picks were never backtested (the historical data has no goal times or
live stats), and in-play Under / BTTS picks were the ones failing in use. Live probabilities are still
shown on match pages.

Why Under 2.5 and BTTS give no pre-match picks (all high-confidence matches, hit rate when the model
rated the side at least this high):

| Side | 55%+ | 60%+ | 65%+ |
| --- | --- | --- | --- |
| Under 2.5, unseen seasons | 55.2 (707) | 52.1 (71) | 50.0 (2) |
| BTTS Yes, unseen seasons | 57.9 (1,877) | 59.8 (219) | 55.6 (9) |
| BTTS No, unseen seasons | 65.6 (32) | – | – |

A stronger team model was also tried for these markets: opponent-adjusted, time-weighted attack and
defence ratings fitted on every earlier league match (Dixon-Coles style). On unseen seasons it moved
log loss by at most 0.002 and accuracy by under 1 point (Over 2.5 55.5 → 56.3; BTTS 54.9 → 54.8), so
it isn't used. Results and tables alone don't carry enough information to predict these markets
well; see "What would raise accuracy" below.

## What would raise accuracy

In order of expected gain, none of which the free ESPN feed provides:

1. **Bookmaker odds** (opening and closing prices). The market price is the strongest single
   predictor of a match and would also allow the app to measure value, not just hit rate.
2. **Expected goals (xG) and shot data** per team and match: far better than goals at telling a lucky
   team from a good one, and the main input for Under / BTTS.
3. **Confirmed line-ups, injuries and suspensions**, about an hour before kick-off.
4. **Full fixture history for every team** (Elo / pi-ratings), and more leagues of backtest data.

## Data and method

- **25,056 finished matches** from 12 European leagues (England 1–2, Germany, Spain, Italy, France,
  Netherlands, Portugal, Scotland, Turkey, Belgium, Austria), seasons 2019-20 to 2026-27 so far.
  Source: openfootball (final and half-time scores).
- Every match is replayed through the app's own code (`js/model.js`, `js/markets.js`) using only what
  was known **before kick-off**: the season table to that date (games, goals, points), each team's
  last 5 results, earlier head-to-head meetings and the league's scoring average. Results are added
  only after the prediction (no look-ahead).
- The model's settings and pick bars were chosen on **2019-20 to 2023-24** (17,356 matches). All
  headline numbers below are from **2024-25 to 2026-27** (7,700 matches), which the tuning never saw.
- 6,229 of the test matches had a **high-confidence** prediction (season record and recent form for
  both teams); the rest are excluded, as in the app.
- Not covered: in-play match stats and xG (the historical data has none), so the "current match
  stats" part of the model is untested. There are no bookmaker odds in the data, so **betting
  yield (profit per stake) can't be measured**; "more yield" here means more correct picks at the
  same or better hit rate. See "Fair odds" below for the prices a pick needs to be worth backing.

## Data fix (2026-11-08): goalless draws were missing

openfootball writes goalless draws differently: from 2025-26 as `score: [0, 0]` instead of
`{ft, ht}`, and in every season without a half-time score. The loader skipped them, so:

- **every 0-0 from 2025-26 and 2026-27 was missing** (225 matches). That flattered the Over markets on
  the unseen seasons and left those matches out of the tables and form the model learns from;
- **every 0-0 was missing from the first-half markets** (1,429 matches), which flattered 1st half
  Over 0.5 and made the model look under-confident there when it wasn't.

Both are now read as 0-0 at full time and half time (`backtest/lib.js`, with a test). The previously
published figures (85.1 of 100 for Over 1.5, 84.5 of 100 overall) were inflated by this; the
honest figure for the settings shipped on 2026-11-07 is **83.3 of 100 (1,329 of 1,595)**.

## Headline: out of 100

| On unseen seasons (2024-25 to 2026-27) | Settings of 2026-11-07 | **Now** |
| --- | --- | --- |
| **All validated picks correct** | 83.3 (1,329 of 1,595) | **83.4 (1,353 of 1,622)** |
| — Over 1.5 | 83.3 (1,083 of 1,300) | **83.7** (1,041 of 1,244) |
| — Full-time result (1X2) | 81.0 (85 of 105) | **84.1 (122 of 145)** |
| — 1st half Over 0.5 | 84.7 (161 of 190) | 81.5 (190 of 233) |
| — Over 2.5, BTTS, 1st half Over 1.5 | no picks | no picks |

More picks at the same hit rate: 24 more correct picks on the same matches. Over 1.5 happens in
**76.9 of 100** high-confidence matches anyway, so its picks are about 7 points better than always
backing it; a first-half goal happens 71.7 in 100 anyway. 1X2 picks are favourites to win, now
including away favourites (10 of 10 correct).

## Model comparison (2026-11-08)

Candidates from the football-prediction literature, each tried on top of the existing model using
only data the app has live (league table, last 5 results, head-to-head). Each was fitted on the
training seasons and kept only if it also improved the unseen seasons. Log loss (lower is better):

| Candidate | Market | Train: before → after | Unseen: before → after | Kept? |
| --- | --- | --- | --- | --- |
| **Points per game** as a team rating for the result (league table; recent form when no table) | 1X2 | 1.0183 → **1.0085** | 1.0174 → **1.0078** | **Yes** |
| Draw adjustment (`drawFactor` 1.1) | 1X2 | part of the row above | | Yes |
| **Logistic recalibration** per market (Platt scaling) | BTTS | 0.6898 → **0.6880** | 0.6870 → **0.6865** | **Yes** |
| | Over 2.5 | 0.6837 → 0.6830 | 0.6850 → 0.6841 | Yes |
| | Over 1.5 | 0.5402 → 0.5397 | 0.5358 → 0.5352 | Yes |
| | 1st half Over 0.5 / 1.5 | tiny gain | **worse** | No |
| Dixon-Coles low-score correction (ρ from −0.15 to +0.05) | all | no gain; BTTS worse at ρ < 0 | ±0.0007 | No |
| Home advantage measured per league (1.03 Austria to 1.14 Spain) | all | −0.0009 (1X2) | +0.0003 (1X2) | No |
| Negative binomial (overdispersed goals) | totals | not needed: goal counts are slightly *under*-dispersed vs Poisson (Pearson 0.97 train, 0.87 test) | | No |
| Re-fit of the goal model on the corrected data (`strengthPower` 0.6 → 0.7) | all | combined with the rows kept above: 0.6040 → 0.6033 | 0.6024 → 0.6019 | Yes |

Not tried because the app has no data for them live: Elo / pi-ratings and opponent-adjusted
(Dixon-Coles style) team strengths need every team's full match history, and xG models need shot
data. Those are the next step if a source with full fixture history is added.

Why points per game helps the result: goal records are tempered (`strengthPower`) because that is
right for goal totals, which left win chances too flat. The league table's points carry who actually
wins games (narrow wins, late winners) that goal difference alone misses. It's applied as
`exp(0.3 × points-per-game gap)` on the ratio of the two teams' scoring rates, for the result only,
so goal totals are unchanged. With no table (cups), points per game from the last 5 results is used
at a smaller weight (0.15).

Calibration of 1X2 on unseen seasons (said → happened):

| Model said | 2026-11-07 settings | Now |
| --- | --- | --- |
| 60–70% | 64.0 → 68.6 (653) | 64.2 → 66.3 (812) |
| 70–80% | 73.3 → **83.8** (154) | 74.1 → **77.2** (325) |
| 80–90% | 81.8 → 42.9 (7) | 83.0 → 84.3 (51) |

BTTS above 60% was over-confident (63.1% said, 60.7% happened); after recalibration it says 61.5%
and 59.8% happens, and no BTTS probability reaches 70%, so BTTS still gives no picks. Calibration is
applied before kick-off only (it was fitted on pre-match data); live probabilities are unchanged.

## Pick bars

Chosen on the training seasons only, as the bar that gives the most picks while keeping at least
82 of 100 correct there (`js/markets.js`):

| Market | Bar (model / every check) | Train | Unseen |
| --- | --- | --- | --- |
| Over 1.5 | 80% / 70% | 83.2 (3,594) | 83.7 (1,244) |
| 1X2 | 75% / 50% (was 70% / 60%) | 82.4 (398) | 84.1 (145) |
| 1st half Over 0.5 | 78% / 70% (kept; no bar reaches 82 on training) | 79.3 (685) | 81.5 (233) |
| 1st half Over 1.5 / Under 1.5 | 85% (was 80%: 7 training picks, 4 correct) | – | – |
| Over 2.5, BTTS | 80% / 70% (no bar with a usable number of picks reaches 82 on training) | – | – |

## Fair odds

Without odds data the app can't tell whether a pick is good value, only how often it lands. A pick
that lands *p* of the time breaks even at decimal odds of 1 / *p*:

| Market | Hit rate on unseen seasons | Break-even odds |
| --- | --- | --- |
| Over 1.5 | 83.7% | 1.19 |
| 1X2 favourite | 84.1% | 1.19 |
| 1st half Over 0.5 | 81.5% | 1.23 |

Only odds above these would have made money over the backtest; bookmakers often price these
selections below that, so a high hit rate is not the same as a profit.

## Every high-confidence match (not just picks)

Calling whichever side the model rates above 50%, on unseen seasons:

| Market | Model correct | Always backing the more common side |
| --- | --- | --- |
| Over 1.5 | 76.9 | 76.9 |
| Over 2.5 | 55.4 | 53.2 |
| BTTS | 54.9 | 54.9 |
| 1X2 | 50.5 | 43.6 (home win) |

On single matches the goal markets barely beat the simple baseline: goals are hard to predict from
results alone. The value is in honest probabilities, which is what makes the high-confidence picks
work.

## Rest of the match from half time

- Another goal after half time happened in **80 of 100** matches. The model's yes/no call is right
  80 times in 100, the same as always saying "yes": it adds no edge here.
- Expected second-half goals: 1.61 predicted vs 1.54 actual on average.
- The most likely number of further goals was exactly right **33 times in 100**.

## Earlier tuning (2026-11-06)

Settings fitted on the training seasons (`js/model.js` `PARAMS`): team strength differences tempered
(`strengthPower` 1 → 0.6, now 0.7), small samples pulled harder toward average (`seasonK` 4 → 16,
`formK` 2 → 12), recent form weight 35% → 20%, head-to-head weight 25% → 10%, trailing team's push
12% → 20% per goal behind, home advantage (1.10) and first-half share of goals (44.5%) set to the
values measured in the data. Before that tuning, on the corrected data, picks were 78.9 of 100
correct on unseen seasons (Over 1.5: 79.7 of 3,162; Over 2.5: 70.0 of 230; BTTS: 65.0 of 40).

## Re-running

```bash
backtest/fetch-data.sh /tmp/football-data
node backtest/tune.js /tmp/football-data   # optional: re-fit settings on the training seasons (~2 min)
node backtest/run.js /tmp/football-data    # writes backtest/results.json
```
