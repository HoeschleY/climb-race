// Reads the League client running on this PC (read-only): game phase, champ select, and the in-game clock.
// The client exposes a local API protected by a password written in its "lockfile". Nothing is ever sent to the client.
const fs = require("fs"), https = require("https"), { execFile } = require("child_process");
const agent = new https.Agent({ rejectUnauthorized: false });   // the local client uses a self-signed certificate
const LOCKS = ["C:/Riot Games/League of Legends/lockfile", "D:/Riot Games/League of Legends/lockfile", "E:/Riot Games/League of Legends/lockfile",
  "C:/Program Files/Riot Games/League of Legends/lockfile", "D:/Games/Riot Games/League of Legends/lockfile"];
let auth = null, lastProbe = 0;

function readLock() {
  for (const f of LOCKS) try { const [, , port, pw] = fs.readFileSync(f, "utf8").split(":"); if (port && pw) return { port: +port, pw }; } catch {}
  return null;
}
// Fallback when League isn't installed in a usual folder: read the port/password from the running client's command line
function probeProcess() {
  return new Promise(res => execFile("powershell.exe", ["-NoProfile", "-Command",
    "(Get-CimInstance Win32_Process -Filter \"name='LeagueClientUx.exe'\").CommandLine"], { windowsHide: true, timeout: 8000 }, (err, out) => {
    const port = /--app-port=(\d+)/.exec(out || ""), pw = /--remoting-auth-token=([\w-]+)/.exec(out || "");
    res(port && pw ? { port: +port[1], pw: pw[1] } : null);
  }));
}
function get(port, path, pw) {
  return new Promise(res => {
    const req = https.get({ host: "127.0.0.1", port, path, agent, timeout: 1500,
      headers: pw ? { Authorization: "Basic " + Buffer.from("riot:" + pw).toString("base64") } : {} }, r => {
      let b = ""; r.on("data", c => b += c); r.on("end", () => { try { res(r.statusCode < 300 ? JSON.parse(b) : null); } catch { res(null); } });
    });
    req.on("error", () => res(null)); req.on("timeout", () => { req.destroy(); res(null); });
  });
}
async function lcu(path) {
  if (!auth) { auth = readLock(); if (!auth && Date.now() - lastProbe > 30000) { lastProbe = Date.now(); auth = await probeProcess(); } }
  if (!auth) return undefined;
  const r = await get(auth.port, path, auth.pw);
  if (r === null) { const again = readLock(); if (again && again.port !== auth.port) auth = again; }
  return r;
}

// Compact champ-select state for the overlay
function draftOf(s) {
  if (!s) return null;
  const meCell = s.localPlayerCellId, acts = (s.actions || []).flat();
  const cur = acts.find(a => a.isInProgress && a.actorCellId === meCell);
  return {
    me: meCell,
    allies: (s.myTeam || []).map(x => ({ cell: x.cellId, pos: (x.assignedPosition || "").toUpperCase(), champ: x.championId || 0, hover: x.championPickIntent || 0,
      name: x.gameName ? `${x.gameName}#${x.tagLine}` : "" })),
    enemies: (s.theirTeam || []).map(x => ({ cell: x.cellId, champ: x.championId || 0, pos: (x.assignedPosition || "").toUpperCase() })),
    bans: [...(s.bans?.myTeamBans || []), ...(s.bans?.theirTeamBans || []), ...acts.filter(a => a.type === "ban" && a.completed).map(a => a.championId)].filter(x => x > 0),
    turn: cur ? cur.type : null, phase: s.timer?.phase || "", left: Math.round((s.timer?.adjustedTimeLeftInPhase || 0) / 1000),
  };
}

let state = { phase: "Neutral", client: false };
async function poll() {
  const fl = await lcu("/lol-gameflow/v1/gameflow-phase");
  const next = { client: fl !== undefined && fl !== null, phase: "Neutral" };
  if (next.client && !state.me) { const me = await lcu("/lol-summoner/v1/current-summoner"); if (me?.gameName) next.me = `${me.gameName}#${me.tagLine}`; }
  else next.me = state.me;
  if (fl === "ChampSelect") { next.phase = "ChampSelect"; next.draft = draftOf(await lcu("/lol-champ-select/v1/session")); }
  else if (fl === "InProgress" || fl === "GameStart" || fl === "Reconnect") {
    const gs = await get(2999, "/liveclientdata/gamestats");      // in-game API, only answers once the game has loaded
    next.phase = gs && gs.gameTime > 3 ? "InGame" : "Loading"; next.gameTime = gs?.gameTime || 0;
  }
  state = next; return state;
}
module.exports = { poll, intervalFor: () => state.phase === "ChampSelect" ? 1000 : state.phase === "InGame" ? 10000 : 3000 };
