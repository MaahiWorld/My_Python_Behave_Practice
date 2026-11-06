// Merging match lists from several sources: drop duplicates, prefer the higher-priority source.
const STOP = /\b(fc|cf|sc|afc|ac|cd|club|de|the|fk|sk|if|bk|calcio|sv|ss|as|us|cs|ca|se|ec|cr|rc|kv|kaa|vfb|vfl|tsg|fsv|ssc)\b/g;
export const normName = (n) => String(n || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(STOP, ' ').replace(/[^a-z0-9]/g, '');
export const sameTeam = (a, b) => {
  const x = normName(a.name), y = normName(b.name);
  if (!x || !y) return false;
  return x === y || (Math.min(x.length, y.length) >= 5 && (x.includes(y) || y.includes(x)));
};
const exactTeam = (a, b) => normName(a.name) !== '' && normName(a.name) === normName(b.name);
// Same kickoff window, both teams similar, and at least one team name identical once normalized.
export const sameMatch = (a, b) => Math.abs(new Date(a.date) - new Date(b.date)) < 3 * 3_600_000
  && sameTeam(a.home, b.home) && sameTeam(a.away, b.away) && (exactTeam(a.home, b.home) || exactTeam(a.away, b.away));

// Sources with a limited quota refresh their list less often, so move their clock forward meanwhile.
export function extrapolate(m) {
  const cap = { H1: 47, H2: 98, ET: 122 }[m.phase || (m.minute <= 45 ? 'H1' : 'H2')];
  if (m.state !== 'in' || !m.fetchedAt || m.detail === 'HT' || !cap) return m;
  const add = Math.floor((Date.now() - m.fetchedAt) / 60_000);
  if (add <= 0) return m;
  const minute = Math.min(m.minute + add, cap);
  return { ...m, minute, detail: `${minute}'`, estimatedClock: true };
}

export function mergeMatches(lists) {
  const out = [];
  for (const { src, matches } of [...lists].sort((x, y) => x.src.priority - y.src.priority)) {
    for (const m of matches) {
      const dup = out.find((o) => sameMatch(o, m));
      if (dup) { (dup.alsoIn ||= []).push(src.name); continue; }
      out.push(extrapolate(m));
    }
  }
  return out;
}
