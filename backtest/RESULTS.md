# Backtest results

Run on 2026-11-06 with `backtest/fetch-data.sh` + `backtest/run.js`; full figures in `results.json`.

## Data and method

- **24,831 finished matches** from 12 European leagues (England 1–2, Germany, Spain, Italy, France,
  Netherlands, Portugal, Scotland, Turkey, Belgium, Austria), seasons 2019-20 to 2026-27 so far.
  Source: openfootball (final and half-time scores).
- Every match is replayed through the app's own code (`js/model.js`, `js/markets.js`) using only what
  was known **before kick-off**: the season table to that date, each team's last 5 results,
  earlier head-to-head meetings and the league's scoring average. Results are added only after the
  prediction (no look-ahead).
- The model's settings were tuned on **2019-20 to 2023-24** (17,356 matches). All headline numbers
  below are from **2024-25 to 2026-27** (7,475 matches), which the tuning never saw.
- 5,991 of the test matches had a **high-confidence** prediction (season record and recent form for
  both teams); the rest are excluded, as in the app.
- Not covered: in-play match stats and xG (the historical data has none), so the "current match
  stats" part of the model is untested.

## Headline: out of 100

| On unseen seasons (2024-25 to 2026-27) | Before tuning | After tuning |
| --- | --- | --- |
| **Validated Goal-market picks correct** | 80.9 (2,956 of 3,653) | **85.1 (1,363 of 1,601)** |
| — Over 1.5 picks | 81.6 (claimed 82) | **85.1** (claimed 83) |
| — Over 2.5 picks | 73.3 (claimed 79) | no pick reached the bar |
| — BTTS picks | 66.7 (claimed 77) | no pick reached the bar |

For comparison, Over 1.5 happened in **79.1 of 100** high-confidence matches anyway, so the picks
are about **6 points better than always backing Over 1.5**.

## Every high-confidence match (not just picks)

Calling whichever side the model rates above 50%:

| Market | Model correct | Always backing the more common side |
| --- | --- | --- |
| Over 1.5 | 79.1 | 79.1 |
| Over 2.5 | 56.2 | 54.6 |
| BTTS | 56.3 | 56.4 |

So on single matches the model barely beats the simple baseline: goals are hard to predict from
results alone. What tuning fixed is **honesty of the probabilities** (calibration):

| Over 2.5, model said | Before: actually happened | After: actually happened |
| --- | --- | --- |
| 60–70% (avg 63–64%) | 57% | **63%** |
| 70–80% (avg 73%) | 63% | **81%** (67 matches) |

BTTS above 70% remains overconfident (72% said, 60% happened, 37 matches), which is why BTTS
picks now need 80% and don't occur.

## Rest of the match from half time

- Another goal after half time happened in **85 of 100** matches. The model's yes/no call is right
  85 times in 100, the same as always saying "yes": it adds no edge here.
- Expected second-half goals: 1.66 predicted vs 1.64 actual on average.
- The most likely number of further goals was exactly right **36 times in 100**.

## What changed after tuning

Settings fitted on the training seasons (`js/model.js` `PARAMS`):

- Team strength differences tempered (`strengthPower` 1 → 0.6): raw goal records overstated how
  different teams are.
- Small samples pulled harder toward average (`seasonK` 4 → 16, `formK` 2 → 12).
- Recent form weight 35% → 20%; head-to-head weight 25% → 10%.
- Trailing team's push 12% → 20% per goal behind.
- Home advantage (1.10) and first-half share of goals (44.5%) set to the values measured in the data.

Pick rules (`js/markets.js` `RULES`): model ≥ 80% (was 75%) and every cross-check ≥ 70% (was 60%).
On the training seasons, these rules gave 82.7% over 3,802 picks; 75%/60% gave 79.9%; 85%/70%
gave 85.9% but only 687 picks.

## Re-running

```bash
backtest/fetch-data.sh /tmp/football-data
node backtest/tune.js /tmp/football-data   # optional: re-fit settings on the training seasons
node backtest/run.js /tmp/football-data    # writes backtest/results.json
```
