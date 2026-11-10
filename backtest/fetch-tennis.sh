#!/usr/bin/env bash
# Downloads finished ATP matches (TML-Database, github.com/Tennismylife/TML-Database) for the tennis backtest.
# Usage: backtest/fetch-tennis.sh <data-dir>
set -euo pipefail
dir="${1:?usage: backtest/fetch-tennis.sh <data-dir>}"
mkdir -p "$dir"
for year in 2019 2020 2021 2022 2023 2024 2025 2026; do
  url="https://raw.githubusercontent.com/Tennismylife/TML-Database/master/$year.csv"
  if curl -sSfL -m 60 -o "$dir/$year.csv" "$url"; then echo "ok   $year"; else rm -f "$dir/$year.csv"; fi
done
