// Lobby-based game rating (0-10), comparing each player to the other 9 in the same game.
// Each stat becomes a z-score within the lobby, then a role-weighted average is taken,
// plus the gold/CS lead over the direct lane opponent and a small bonus for winning.
export const RATING_VERSION = 1;

const W = { // role weights per stat
  TOP:     { kda: 1, kp: 1,   dmg: 1.2, tank: 1,   gold: 1,   cs: 1,   vis: .4,  deaths: 1 },
  JUNGLE:  { kda: 1, kp: 1.5, dmg: .9,  tank: .8,  gold: .8,  cs: .6,  vis: .8,  deaths: 1 },
  MIDDLE:  { kda: 1, kp: 1.1, dmg: 1.4, tank: .4,  gold: 1,   cs: 1,   vis: .4,  deaths: 1 },
  BOTTOM:  { kda: 1, kp: 1,   dmg: 1.5, tank: .3,  gold: 1.1, cs: 1.2, vis: .3,  deaths: 1 },
  UTILITY: { kda: 1.1, kp: 1.5, dmg: .5, tank: .6, gold: .2,  cs: 0,   vis: 1.6, deaths: 1 },
};
// Measured on 1,620 player-games (162 per role) from this race's saved scoreboards.
const CAL = {"TOP":{"mu":0.019,"sd":0.973},"JUNGLE":{"mu":0.171,"sd":0.737},"MIDDLE":{"mu":0.049,"sd":0.919},"BOTTOM":{"mu":0.29,"sd":1.12},"UTILITY":{"mu":0.412,"sd":0.64}};
const CAL_MU = 0, CAL_SD = 0.9;
const LANE_W = { TOP: 1, JUNGLE: .5, MIDDLE: 1, BOTTOM: 1, UTILITY: .3 };

export function rateGame(sb) {
  const min = Math.max(sb.dur, 300) / 60, P = sb.players;
  const teamKills = t => P.filter(x => x.team === t).reduce((s, x) => s + x.k, 0) || 1;
  const teamSum = (t, k) => P.filter(x => x.team === t).reduce((s, x) => s + (x[k] || 0), 0) || 1;
  const raw = P.map(x => ({
    kda: Math.min((x.k + x.a) / Math.max(1, x.d), 10), kp: (x.k + x.a) / teamKills(x.team),
    dmg: x.dmg / min, tank: (x.taken || 0) / min, gold: x.gold / min, cs: x.cs / min, vis: x.vis / min, deaths: -x.d / min,
  }));
  const z = {};
  for (const k of Object.keys(raw[0])) {
    const v = raw.map(r => r[k]), m = v.reduce((a, b) => a + b, 0) / v.length;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) || 1;
    z[k] = v.map(x => (x - m) / sd);
  }
  const out = P.map((x, i) => {
    const w = W[x.role] || W.MIDDLE, parts = {};
    let sum = 0, tw = 0;
    for (const k of Object.keys(w)) { parts[k] = w[k] * z[k][i]; sum += parts[k]; tw += w[k]; }
    let score = sum / tw;
    const opp = P.find(y => y.team !== x.team && y.role && y.role === x.role);
    let laneGold = null, laneCs = null;
    if (opp) {
      laneGold = x.gold - opp.gold; laneCs = x.cs - opp.cs;
      const lane = Math.max(-1.5, Math.min(1.5, laneGold / 3000)) * (LANE_W[x.role] ?? .5);
      score += lane * .35; parts.lane = lane;
    }
    const win = sb.teams.find(t => t.id === x.team)?.win;
    score += win ? .25 : -.25;
    // Per-role calibration so every role has the same spread of ratings
    const c = CAL[x.role];
    if (c && !sb._raw) score = (score - c.mu) / c.sd * CAL_SD + CAL_MU;
    if (sb._raw) x._raw = score;
    const rating = Math.round(Math.max(0, Math.min(10, 5 + 2.2 * score)) * 10) / 10;
    // Human-readable reasons, strongest first
    const tk = teamKills(x.team);
    const say = {
      kda: () => `${((x.k + x.a) / Math.max(1, x.d)).toFixed(1)} KDA`,
      kp: () => `${Math.round((x.k + x.a) / tk * 100)}% kill participation`,
      dmg: () => `${Math.round(x.dmg / teamSum(x.team, "dmg") * 100)}% of team damage`,
      tank: () => `${Math.round((x.taken || 0) / teamSum(x.team, "taken") * 100)}% of team damage taken`,
      gold: () => `${Math.round(x.gold / teamSum(x.team, "gold") * 100)}% of team gold`,
      cs: () => `${(x.cs / min).toFixed(1)} CS/min`,
      vis: () => `${x.vis} vision score`,
      deaths: () => `${x.d} death${x.d === 1 ? "" : "s"}`,
      lane: () => `${laneGold >= 0 ? "+" : "−"}${(Math.abs(laneGold) / 1000).toFixed(1)}k gold vs lane opponent`,
    };
    const ranked = Object.entries(parts).filter(([k]) => say[k]).sort((a, b) => b[1] - a[1]);
    return { rating, good: ranked.filter(([, v]) => v > .35).slice(0, 3).map(([k]) => say[k]()),
             bad: ranked.reverse().filter(([, v]) => v < -.35).slice(0, 3).map(([k]) => say[k]()), laneGold, laneCs };
  });
  const order = out.map((o, i) => i).sort((a, b) => out[b].rating - out[a].rating);
  order.forEach((i, place) => { out[i].place = place + 1; });
  return out;
}
