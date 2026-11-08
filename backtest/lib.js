// Shared backtest code: load finished matches, rebuild what was known before each kick-off,
// and score the app's predictions against what actually happened.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { predict } from '../js/model.js';
import { marketPicks, MARKETS, sidesOf, bestSide } from '../js/markets.js';

// Result of a finished match in the shape the markets settle on.
export const resultOf = (m) => ({ hs: m.ft[0], as: m.ft[1], ht: m.ht ? { home: m.ht[0], away: m.ht[1] } : null, aet: false });

// openfootball league codes -> ESPN league ids (as the app sees them).
export const ESPN_ID = { 'en.1': 'eng.1', 'en.2': 'eng.2', 'de.1': 'ger.1', 'es.1': 'esp.1', 'it.1': 'ita.1', 'fr.1': 'fra.1',
  'nl.1': 'ned.1', 'pt.1': 'por.1', 'sco.1': 'sco.1', 'tr.1': 'tur.1', 'be.1': 'bel.1', 'at.1': 'aut.1' };

export const TRAIN_SEASONS = ['2019-20', '2020-21', '2021-22', '2022-23', '2023-24'];

// Returns one context per finished match: the match as the app would see it before kick-off and at
// half time, plus the pre-match detail (table, form, h2h, league average), all built without look-ahead.
export function loadContexts(dir) {
  const byLeague = new Map();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const [season, ...rest] = f.replace(/\.json$/, '').split('.');
    const league = rest.join('.');
    const data = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    for (const m of data.matches || []) {
      // openfootball leaves out the half-time score of goalless draws, and from 2025-26 writes them as
      // `score: [0, 0]` instead of {ft, ht}. Skipping those dropped every 0-0 from the recent seasons and
      // every 0-0 from the first-half markets, so read them as 0-0 at full time and at half time.
      let sc = m.score;
      if (Array.isArray(sc)) sc = { ft: sc };
      if (!sc || !Array.isArray(sc.ft) || sc.ft.length !== 2) continue;
      if (!Array.isArray(sc.ht) && sc.ft[0] === 0 && sc.ft[1] === 0) sc = { ...sc, ht: [0, 0] };
      const list = byLeague.get(league) || [];
      list.push({ season, league, date: m.date, time: m.time || '', home: m.team1, away: m.team2, ft: sc.ft, ht: Array.isArray(sc.ht) ? sc.ht : null });
      byLeague.set(league, list);
    }
  }

    const rows = [];
  for (const [league, matches] of byLeague) {
    matches.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    const tables = new Map(); // season -> team -> {gp, gf, ga}
    const hist = new Map(); // team -> [{gf, ga, res, ...}] newest last
    const h2h = new Map(); // pair -> [{homeId, hs, as}] newest last
    const seasonGoals = new Map(); // season -> {gp, gf}
    const pairKey = (a, b) => [a, b].sort().join('|');
    for (const m of matches) {
      const table = tables.get(m.season) || new Map();
      tables.set(m.season, table);
      const row = (t) => table.get(t) || { gp: 0, gf: 0, ga: 0, pts: 0 };
      const sg = seasonGoals.get(m.season) || { gp: 0, gf: 0 };
      const form = (t) => (hist.get(t) || []).slice(-5).reverse();
      const detail = {
        table: { home: { ...row(m.home) }, away: { ...row(m.away) } },
        form: { home: form(m.home), away: form(m.away) },
        h2h: (h2h.get(pairKey(m.home, m.away)) || []).slice(-10).reverse(),
        leagueAvg: sg.gp >= 20 ? sg.gf / sg.gp : null,
      };
      const team = (name) => ({ id: name, name, short: name, abbr: name.slice(0, 3), score: 0 });
      const match = { id: `${m.date}-${m.home}`, league: ESPN_ID[league] || league, leagueName: league, state: 'pre', minute: 0, date: m.date, home: team(m.home), away: team(m.away) };

      const htMatch = m.ht ? { ...match, state: 'in', minute: 45, phase: 'HT', detail: 'HT', home: { ...match.home, score: m.ht[0] }, away: { ...match.away, score: m.ht[1] } } : null;
      rows.push({ m, match, htMatch, detail });

      // Update state with the result (after predicting).
      const [hs, as] = m.ft;
      for (const [t, gf, ga] of [[m.home, hs, as], [m.away, as, hs]]) {
        const r = row(t);
        table.set(t, { gp: r.gp + 1, gf: r.gf + gf, ga: r.ga + ga, pts: r.pts + (gf > ga ? 3 : gf === ga ? 1 : 0) });
        const list = hist.get(t) || [];
        list.push({ gf, ga, res: gf > ga ? 'W' : gf < ga ? 'L' : 'D', home: t === m.home, date: m.date });
        hist.set(t, list);
      }
      seasonGoals.set(m.season, { gp: sg.gp + 2, gf: sg.gf + hs + as });
      const k = pairKey(m.home, m.away);
      h2h.set(k, [...(h2h.get(k) || []), { homeId: m.home, awayId: m.away, hs, as }]);
    }
  }
  return rows;
}

// Runs the model over contexts. Optional season filter.
export function predictAll(contexts, { seasons, withPicks = false } = {}) {
  return contexts.filter((c) => !seasons || seasons.includes(c.m.season)).map((c) => ({
    ...c, pre: predict(c.match, c.detail), half: c.htMatch ? predict(c.htMatch, c.detail) : null,
    picks: withPicks ? marketPicks(c.match, c.detail) : [],
  }));
}

// Mean log loss over the goal markets (pre-match) and "another goal after half time" — lower is better.
export function logLoss(rows) {
  const eps = 1e-6, ll = (p) => -Math.log(Math.min(1 - eps, Math.max(eps, p)));
  let sum = 0, n = 0;
  for (const r of rows) {
    if (r.pre.confidence.level !== 'High') continue;
    const res = resultOf(r.m);
    for (const mk of MARKETS) {
      if (mk.id === '1x2' || mk.id.startsWith('h1')) continue; // tuning target kept as originally defined
      sum += ll(mk.probs(r.pre)[mk.settle(res)]); n++;
    }
    if (r.half) { sum += ll(hs(r) ? r.half.pMoreGoal : 1 - r.half.pMoreGoal); n++; }
  }
  return sum / n;
}
const hs = (r) => r.m.ft[0] + r.m.ft[1] - r.m.ht[0] - r.m.ht[1] > 0;

export function score(rows) {
  const pct = (x) => Math.round(x * 1000) / 10;
  const total = (r) => r.m.ft[0] + r.m.ft[1];
  const high = rows.filter((r) => r.pre.confidence.level === 'High');

  function marketStats(list, mk) {
    list = list.filter((r) => mk.settle(resultOf(r.m)) != null);
    let correct = 0, brier = 0;
    const buckets = [[0.33, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.01]].map(([lo, hi]) => ({ lo, hi, n: 0, sumP: 0, hits: 0 }));
    const sideCount = {};
    for (const r of list) {
      const won = mk.settle(resultOf(r.m));
      sideCount[won] = (sideCount[won] || 0) + 1;
      const best = bestSide(mk, r.pre);
      if (best.side === won) correct++;
      for (const sd of sidesOf(mk)) brier += (best.probs[sd] - (sd === won ? 1 : 0)) ** 2;
      const b = buckets.find((x) => best.p >= x.lo && best.p < x.hi);
      if (b) { b.n++; b.sumP += best.p; b.hits += best.side === won ? 1 : 0; }
    }
    const [commonSide, commonN] = Object.entries(sideCount).sort((a, b) => b[1] - a[1])[0] || ['-', 0];
    return {
      n: list.length, accuracy: pct(correct / list.length), brier: Math.round((brier / list.length) * 1000) / 1000,
      baseline: pct(commonN / list.length), baselineSide: `always ${commonSide}`,
      calibration: buckets.filter((b) => b.n).map((b) => ({ range: `${Math.round(b.lo * 100)}-${Math.min(100, Math.round(b.hi * 100))}%`, n: b.n, predicted: pct(b.sumP / b.n), actual: pct(b.hits / b.n) })),
    };
  }

  const allPicks = rows.flatMap((r) => r.picks.map((pk) => ({ r, pk })));
  const pickStats = Object.fromEntries(MARKETS.map((mk) => {
    const xs = allPicks.filter((x) => x.pk.market.id === mk.id && mk.settle(resultOf(x.r.m)) != null);
    const hit = ({ r, pk }) => mk.settle(resultOf(r.m)) === pk.side;
    const won = xs.filter(hit).length;
    const bySide = {};
    for (const side of sidesOf(mk)) {
      const sx = xs.filter((x) => x.pk.side === side);
      if (sx.length) bySide[mk.label ? side : side === 'yes' ? mk.yes : mk.no] = { n: sx.length, won: sx.filter(hit).length };
    }
    const avgP = xs.length ? xs.reduce((s, x) => s + x.pk.p, 0) / xs.length : 0;
    return [mk.id, { name: mk.name, picks: xs.length, won, hitRate: xs.length ? pct(won / xs.length) : null, avgPredicted: pct(avgP), bySide }];
  }));
  const pickTotal = Object.values(pickStats).reduce((s, x) => ({ n: s.n + x.picks, won: s.won + x.won }), { n: 0, won: 0 });

  // Expected goals vs actual (high-confidence matches).
  const mae = high.reduce((s, r) => s + Math.abs(r.pre.expectedFinalTotal - total(r)), 0) / high.length;
  const meanPred = high.reduce((s, r) => s + r.pre.expectedFinalTotal, 0) / high.length;
  const meanAct = high.reduce((s, r) => s + total(r), 0) / high.length;
  const naiveMae = high.reduce((s, r) => s + Math.abs(meanAct - total(r)), 0) / high.length;
  // Exact number of goals: model's single most likely total vs actual.
  const exactTotal = high.filter((r) => r.pre.mostLikelyMore === total(r)).length / high.length;
  // Goal scope levels: does "high scope" (75%+ chance of a goal) actually produce goals?
  const scope = ['high', 'medium', 'low'].map((lvl) => {
    const xs = high.filter((r) => r.pre.scopeLevel === lvl);
    return { level: lvl, n: xs.length, atLeastOneGoal: xs.length ? pct(xs.filter((r) => total(r) > 0).length / xs.length) : null };
  });

  // Half-time ("rest of match from minute 45").
  const halfRows = rows.filter((r) => r.half && r.half.confidence.level !== 'Low' && r.pre.confidence.level === 'High');
  const secondHalf = (r) => total(r) - r.m.ht[0] - r.m.ht[1];
  const ht = {
    n: halfRows.length,
    anotherGoalAccuracy: pct(halfRows.filter((r) => (r.half.pMoreGoal >= 0.5) === (secondHalf(r) > 0)).length / halfRows.length),
    anotherGoalBaseline: pct(Math.max(...[true, false].map((v) => halfRows.filter((r) => (secondHalf(r) > 0) === v).length / halfRows.length))),
    expectedMoreMean: Math.round((halfRows.reduce((s, r) => s + r.half.expectedMore, 0) / halfRows.length) * 100) / 100,
    actualMoreMean: Math.round((halfRows.reduce((s, r) => s + secondHalf(r), 0) / halfRows.length) * 100) / 100,
    mostLikelyMoreExact: pct(halfRows.filter((r) => r.half.mostLikelyMore === Math.min(5, secondHalf(r))).length / halfRows.length),
    highScope: (() => {
      const xs = halfRows.filter((r) => r.half.scopeLevel === 'high');
      return { n: xs.length, gotAnotherGoal: xs.length ? pct(xs.filter((r) => secondHalf(r) > 0).length / xs.length) : null };
    })(),
    calibration: [[0.5, 0.65], [0.65, 0.75], [0.75, 0.85], [0.85, 1.01]].map(([lo, hi]) => {
      const xs = halfRows.filter((r) => r.half.pMoreGoal >= lo && r.half.pMoreGoal < hi);
      return xs.length ? { range: `${Math.round(lo * 100)}-${Math.min(100, Math.round(hi * 100))}%`, n: xs.length,
        predicted: pct(xs.reduce((s, r) => s + r.half.pMoreGoal, 0) / xs.length), actual: pct(xs.filter((r) => secondHalf(r) > 0).length / xs.length) } : null;
    }).filter(Boolean),
  };

  const seasons = [...new Set(rows.map((r) => r.m.season))].sort();
  return {
    data: { matches: rows.length, seasons: `${seasons[0]} to ${seasons.at(-1)}`, highConfidence: high.length, logLoss: Math.round(logLoss(rows) * 10000) / 10000 },
    picks: { total: pickTotal.n, won: pickTotal.won, hitRate: pickTotal.n ? pct(pickTotal.won / pickTotal.n) : null, byMarket: pickStats },
    highConfidenceMarkets: Object.fromEntries(MARKETS.map((mk) => [mk.id, marketStats(high, mk)])),
    goals: { meanPredicted: Math.round(meanPred * 100) / 100, meanActual: Math.round(meanAct * 100) / 100, mae: Math.round(mae * 100) / 100, naiveMae: Math.round(naiveMae * 100) / 100, exactTotal: pct(exactTotal), scope },
    halfTime: ht,
  };
}
