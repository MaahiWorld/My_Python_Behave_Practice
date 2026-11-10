# Tennis backtest

Run on 2026-11-10 with `backtest/fetch-tennis.sh` + `backtest/tennis-tune.js` + `backtest/tennis-run.js`;
full figures in `tennis-results.json`.

## Data and method

- **18,113 finished ATP main-tour singles matches**, 2019 to January 2026, from TML-Database
  (github.com/Tennismylife/TML-Database): each player's world ranking at the time, surface, best of 3
  or 5, and the final score. Retirements and walkovers are left out (the app voids them).
- Every match goes through the app's own code (`js/tennis.js`) as it looks **before the first ball**,
  using only what the app has live: the two rankings, the format, and the tournament name.
- Settings were fitted on **2019–2023** (12,334 matches). The figures below are on **2024–2026**
  (5,779 matches), which the fitting never saw.
- WTA isn't covered (no free WTA history was reachable). It uses the same settings with its own serve level.

## What was wrong

The first model was well calibrated on the **winner**, but it treated every match as if both players
played at a fixed level. That made matches look closer than they are:

| Unseen 2024–26, before the change | Model said | Happened |
| --- | --- | --- |
| Total games picks (75% bar) | 85.6% | **76.0%** (4,101 of 5,398) |
| Underdog wins a set picks (75% bar) | 82.1% | **73.7%** (445 of 604) |
| Over 2.5 sets, when the model leaned Over | 69.9% | 56.3% |

In real tennis, favourites win in straight sets and matches end quickly more often than a fixed-level
model allows, because a player's level varies from day to day.

## What changed

| Change | Effect (log loss on training years, lower is better) |
| --- | --- |
| **Day-to-day form**: the serve-strength gap varies by ±0.045 between matches; the model averages over it, keeping the ranking-based win chance | total games 0.637 → 0.593, total sets 0.690 → 0.658, underdog set 0.669 → 0.652 |
| Serve level 64% → 65% (ATP hard court) | small gain |
| **Surface** from the tournament name and month: clay −2 points of serve, grass +1.5 | small gain on games |
| Logistic recalibration per market | small (the day-to-day form fixed most of the miscalibration) |
| Ranking power (0.4 to 0.6 tried) | 0.5 kept: best for the match winner |

Log loss on the unseen years: total games 0.622 → **0.584**, total sets 0.683 → **0.654**, underdog
set 0.666 → **0.653**, winner unchanged (0.628).

## Pick bars

Chosen on 2019–2023 as the lowest bar that kept at least 82 of 100 picks correct with 40+ picks (the
same target as football). Picks are made **before the match only**.

| Market | Bar | Training 2019–23 | **Unseen 2024–26** |
| --- | --- | --- | --- |
| Match winner | 75% | 82.3% (1,259 of 1,529) | **82.9%** (600 of 724) |
| Total games | 80% | 90.5% (8,747 of 9,664) | **92.2%** (4,213 of 4,568) |
| Underdog to win a set / favourite in straight sets | no bar reaches 82% | best 77% | **no picks** |
| Total sets | only 29 training picks at 80% | – | **no picks** |

Total-games picks by line on unseen years: Over 16.5 (best of 3) 92.7% of 4,203; Over 18.5 86.3% of
248; Unders 24.5 to 42.5 mostly 85–94% on small numbers. **Over 16.5 means the match isn't
6-0 6-0 to 6-4 6-4 territory**: it lands often, but bookmakers price it very short (break-even odds
1.08), so a high hit rate here isn't the same as value.

## Re-running

```bash
backtest/fetch-tennis.sh /tmp/tennis-data
node backtest/tennis-tune.js /tmp/tennis-data         # re-fit settings on 2019–2023 (~10 min)
node backtest/tennis-run.js /tmp/tennis-data --bars   # writes backtest/tennis-results.json
```
