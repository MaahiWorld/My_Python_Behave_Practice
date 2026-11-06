#!/usr/bin/env bash
# Downloads finished-match results (openfootball, public domain) for the backtest.
# Usage: backtest/fetch-data.sh <data-dir>
set -euo pipefail
dir="${1:?usage: backtest/fetch-data.sh <data-dir>}"
mkdir -p "$dir"
for season in 2019-20 2020-21 2021-22 2022-23 2023-24 2024-25 2025-26 2026-27; do
  for league in en.1 en.2 de.1 es.1 it.1 fr.1 nl.1 pt.1 sco.1 tr.1 be.1 at.1; do
    url="https://raw.githubusercontent.com/openfootball/football.json/master/$season/$league.json"
    if curl -sSfL -m 30 -o "$dir/$season.$league.json" "$url"; then echo "ok   $season $league"; else rm -f "$dir/$season.$league.json"; fi
  done
done
