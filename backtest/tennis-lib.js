// Tennis backtest: replays finished ATP matches through the app's own tennis model (js/tennis.js).
// Data: TML-Database (github.com/Tennismylife/TML-Database), one CSV per year with each player's
// world ranking at the time of the match, surface, best-of and the final score.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Minimal CSV reader (TML has no quoted commas in the columns used here, but handle quotes anyway).
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const split = (l) => {
    const out = []; let cur = '', q = false;
    for (const ch of l) {
      if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const head = split(lines[0]);
  return lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [head[i], v])));
}

// "6-4 6-7(2) 7-6(5)" -> [[6,4],[6,7],[7,6]] from the winner's side; null for retirements / walkovers.
export function parseScore(s) {
  if (!s || /RET|W\/O|DEF|ABD|Walkover|unfinished/i.test(s)) return null;
  const sets = s.trim().split(/\s+/).map((x) => x.replace(/\(\d+\)/, '').split('-').map(Number));
  if (!sets.length || sets.some((x) => x.length !== 2 || x.some((v) => !Number.isFinite(v)))) return null;
  return sets;
}

// Returns finished matches in the app's tennis shape (players a / b with ranks and set scores).
// Who is "a" alternates so the winner is not always first.
export function loadTennis(dir) {
  const out = [];
  let flip = false;
  for (const f of readdirSync(dir).filter((x) => /^\d{4}\.csv$/.test(x)).sort()) {
    for (const r of parseCSV(readFileSync(join(dir, f), 'utf8'))) {
      const sets = parseScore(r.score);
      const wr = Number(r.winner_rank), lr = Number(r.loser_rank);
      if (!sets || !(wr > 0) || !(lr > 0)) continue;
      const bestOf = Number(r.best_of) === 5 ? 5 : 3;
      const W = { id: r.winner_id, name: r.winner_name, rank: wr, winner: true, sets: sets.map(([x]) => ({ games: x })) };
      const L = { id: r.loser_id, name: r.loser_name, rank: lr, winner: false, sets: sets.map(([, y]) => ({ games: y })) };
      flip = !flip;
      out.push({
        sport: 'tennis', id: `${r.tourney_id}-${r.match_num}`, tour: 'atp', year: +f.slice(0, 4), date: r.tourney_date,
        event: r.tourney_name, surface: r.surface || 'Hard', level: r.tourney_level, state: 'post', bestOf,
        a: flip ? W : L, b: flip ? L : W,
      });
    }
  }
  return out;
}

export const TRAIN_YEARS = [2019, 2020, 2021, 2022, 2023];
