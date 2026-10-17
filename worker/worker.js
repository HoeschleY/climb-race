// GENERATED from worker/src.js by worker/build.mjs: edit src.js, then run `node worker/build.mjs`
// Climb Race lookup proxy (Cloudflare Worker).
// Lets the website look up any player live without exposing the Riot API key: the key is stored
// as a secret in Cloudflare (RIOT_API_KEY) and never leaves this worker.
//   GET /player?id=Name%23TAG   rank + last 10 ranked Solo/Duo games (&n=5 for fewer)
//   GET /match?id=EUW1_123      full scoreboard of one game (same shape as the site's saved games)
//   GET /live?p=puuid,puuid     who of the race players is in a game right now (cached 20 s, shared by every viewer)
// Answers are cached (players 10 min, games 7 days), so repeated clicks cost no Riot requests.
const PLATFORM = "euw1", REGION = "europe";
const ALLOWED = ["https://hoeschley.github.io"];
const GAMES = 10;

// ---- lobby rating (copied from scripts/rating.mjs) ----
// Lobby-based game rating (0-10), comparing each player to the other 9 in the same game.
// Each stat becomes a z-score within the lobby, then a role-weighted average is taken,
// plus the gold/CS lead over the direct lane opponent and a small bonus for winning.
const RATING_VERSION = 1;

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

function rateGame(sb) {
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
// ---- end of rating ----

function cors(req) {
  const o = req.headers.get("Origin") || "";
  return { "Access-Control-Allow-Origin": ALLOWED.includes(o) ? o : ALLOWED[0], "Vary": "Origin" };
}
const json = (req, body, status = 200, maxAge = 0) => new Response(JSON.stringify(body), { status,
  headers: { "Content-Type": "application/json", "Cache-Control": maxAge ? `public, max-age=${maxAge}` : "no-store", ...cors(req) } });

class RiotError extends Error { constructor(status, retry) { super("riot " + status); this.status = status; this.retry = retry; } }
async function riot(env, host, path) {
  const r = await fetch(`https://${host}.api.riotgames.com${path}`, { headers: { "X-Riot-Token": env.RIOT_API_KEY } });
  if (r.status === 404) return null;
  if (!r.ok) throw new RiotError(r.status, +r.headers.get("retry-after") || 0);
  return r.json();
}
const nameOf = x => x.riotIdGameName ? `${x.riotIdGameName}#${x.riotIdTagline}` : (x.summonerName || "?");

function scoreboard(m) {
  const i = m.info;
  const sb = {
    id: m.metadata.matchId, at: i.gameEndTimestamp || i.gameStartTimestamp, dur: i.gameDuration, queue: i.queueId,
    patch: (i.gameVersion || "").split(".").slice(0, 2).join("."), live: true,
    teams: i.teams.map(t => ({ id: t.teamId, win: t.win, kills: t.objectives?.champion?.kills ?? 0,
      obj: { baron: t.objectives?.baron?.kills ?? 0, dragon: t.objectives?.dragon?.kills ?? 0, herald: t.objectives?.riftHerald?.kills ?? 0,
        grubs: t.objectives?.horde?.kills ?? 0, tower: t.objectives?.tower?.kills ?? 0, inhib: t.objectives?.inhibitor?.kills ?? 0 } })),
    players: i.participants.map(x => ({
      name: nameOf(x), tracked: null, team: x.teamId, champ: x.championName, lvl: x.champLevel, role: x.teamPosition || "",
      k: x.kills, d: x.deaths, a: x.assists, cs: x.totalMinionsKilled + x.neutralMinionsKilled, dmg: x.totalDamageDealtToChampions,
      taken: x.totalDamageTaken, gold: x.goldEarned, vis: x.visionScore, wards: x.wardsPlaced, multi: x.largestMultiKill,
      items: [x.item0, x.item1, x.item2, x.item3, x.item4, x.item5, x.item6], spells: [x.summoner1Id, x.summoner2Id],
      rune: x.perks?.styles?.[0]?.selections?.[0]?.perk ?? null, sub: x.perks?.styles?.[1]?.style ?? null })),
  };
  try { const r = rateGame(sb); sb.players.forEach((x, k) => { x.rating = r[k].rating; x.place = r[k].place; }); } catch {}
  return sb;
}

// One game, cached for a week (finished games never change)
async function getMatch(env, ctx, id) {
  const key = new Request(`https://cache.climb-race/match/${id}`), cache = caches.default;
  const hit = await cache.match(key); if (hit) return hit.json();
  const m = await riot(env, REGION, `/lol/match/v5/matches/${id}`); if (!m) return null;
  const sb = scoreboard(m);
  ctx.waitUntil(cache.put(key, new Response(JSON.stringify(sb), { headers: { "Cache-Control": "public, max-age=604800" } })));
  return sb;
}

async function player(env, ctx, id, n = GAMES) {
  const [name, tag] = id.split("#"); if (!name || !tag) return { error: "Use Name#TAG" };
  const acc = await riot(env, REGION, `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`);
  if (!acc) return { error: "Player not found" };
  const [entries, sum, ids] = await Promise.all([
    riot(env, PLATFORM, `/lol/league/v4/entries/by-puuid/${acc.puuid}`),
    riot(env, PLATFORM, `/lol/summoner/v4/summoners/by-puuid/${acc.puuid}`),
    riot(env, REGION, `/lol/match/v5/matches/by-puuid/${acc.puuid}/ids?queue=420&count=${n}`)]);
  const e = (entries || []).find(z => z.queueType === "RANKED_SOLO_5x5");
  const matches = (await Promise.all((ids || []).map(mid => getMatch(env, ctx, mid).catch(() => null)))).filter(Boolean);
  const riotId = `${acc.gameName}#${acc.tagLine}`;
  const games = matches.map(sb => {
    const me = sb.players.find(x => x.name.toLowerCase() === riotId.toLowerCase()); if (!me) return null;
    const team = sb.teams.find(t => t.id === me.team), tk = sb.players.filter(x => x.team === me.team).reduce((s, x) => s + x.k, 0) || 1;
    return { id: sb.id, at: sb.at, dur: sb.dur, win: !!team?.win, champ: me.champ, role: me.role, k: me.k, d: me.d, a: me.a, cs: me.cs,
      dmg: me.dmg, gold: me.gold, vis: me.vis, kp: Math.round((me.k + me.a) / tk * 100), rating: me.rating ?? null, place: me.place ?? null,
      items: me.items, spells: me.spells, rune: me.rune, sub: me.sub,
      vs: sb.players.filter(x => x.team !== me.team).map(x => x.champ), with: sb.players.filter(x => x.team === me.team && x !== me).map(x => x.champ) };
  }).filter(Boolean).sort((a, b) => b.at - a.at);
  return { riotId, level: sum?.summonerLevel ?? null, icon: sum?.profileIconId ?? null, at: Date.now(),
    rank: e ? { tier: e.tier, division: e.rank, lp: e.leaguePoints, wins: e.wins, losses: e.losses, hot: !!e.hotStreak } : null, games };
}

// Live games of the race players (spectator API), so the site shows a game within seconds instead of waiting for the tracker
async function live(env, puuids) {
  const out = {};
  await Promise.all(puuids.map(async pu => {
    const g = await riot(env, PLATFORM, `/lol/spectator/v5/active-games/by-summoner/${pu}`).catch(e => { if (e.status === 429) throw e; return undefined; });
    if (g === undefined) return;                       // unknown (error): the site keeps what it had
    const me = g?.participants?.find(x => x.puuid === pu);
    out[pu] = g && me ? { gameId: g.gameId, champId: me.championId, team: me.teamId, queue: g.gameQueueConfigId, start: g.gameStartTime || 0, len: g.gameLength || 0,
      players: g.participants.map(x => ({ name: x.riotId || "", champId: x.championId, team: x.teamId, spells: [x.spell1Id, x.spell2Id],
        rune: x.perks?.perkIds?.[0] ?? null, sub: x.perks?.perkSubStyle ?? null, me: x.puuid === pu })) } : null;
  }));
  return { at: Date.now(), games: out };
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === "OPTIONS") return new Response(null, { headers: { ...cors(req), "Access-Control-Allow-Methods": "GET", "Access-Control-Max-Age": "86400" } });
    const url = new URL(req.url), id = (url.searchParams.get("id") || "").trim().slice(0, 60);
    if (!env.RIOT_API_KEY) return json(req, { error: "RIOT_API_KEY secret is missing in the worker settings" }, 500);
    try {
      if (url.pathname === "/player") {
        // n = number of games (1-10): the overlay asks for 5 per teammate in champ select to save Riot requests
        const n = Math.min(GAMES, Math.max(1, +url.searchParams.get("n") || GAMES));
        const key = new Request(`https://cache.climb-race/player/${n}/${encodeURIComponent(id.toLowerCase())}`), cache = caches.default;
        const hit = await cache.match(key); if (hit) return json(req, await hit.json(), 200, 120);
        const out = await player(env, ctx, id, n);
        if (out.error) return json(req, out, 404);
        ctx.waitUntil(cache.put(key, new Response(JSON.stringify(out), { headers: { "Cache-Control": "public, max-age=600" } })));
        return json(req, out, 200, 120);
      }
      if (url.pathname === "/live") {
        const ps = (url.searchParams.get("p") || "").split(",").filter(x => /^[\w-]{60,90}$/.test(x)).slice(0, 8).sort();
        if (!ps.length) return json(req, { error: "No players" }, 400);
        const key = new Request(`https://cache.climb-race/live/${ps.join(",")}`), cache = caches.default;
        const hit = await cache.match(key); if (hit) return json(req, await hit.json(), 200);
        const out = await live(env, ps);
        ctx.waitUntil(cache.put(key, new Response(JSON.stringify(out), { headers: { "Cache-Control": "public, max-age=20" } })));
        return json(req, out, 200);
      }
      if (url.pathname === "/match") {
        if (!/^[A-Z0-9]+_\d+$/.test(id)) return json(req, { error: "Bad match id" }, 400);
        const sb = await getMatch(env, ctx, id); return sb ? json(req, sb, 200, 86400) : json(req, { error: "Game not found" }, 404);
      }
      if (url.pathname === "/") return json(req, { ok: true, service: "climb-race lookup" });
      return json(req, { error: "Not found" }, 404);
    } catch (e) {
      if (e instanceof RiotError) {
        if (e.status === 429) return json(req, { error: "Riot's rate limit is reached, try again in a minute", retry: e.retry || 60 }, 429);
        if (e.status === 401 || e.status === 403) return json(req, { error: "Riot refused the API key (expired?). Update RIOT_API_KEY in the worker settings." }, 502);
        return json(req, { error: `Riot error ${e.status}` }, 502);
      }
      return json(req, { error: "Lookup failed" }, 500);
    }
  },
};
