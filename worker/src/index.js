// PV Pokémon Worlds - battles leaderboard server (Cloudflare Worker + D1).
//
// The worlds can't send data out on their own: each builds a signed link, the player pastes it into a URL field in the world and
// presses SUBMIT, and VRChat opens it - that GET lands here.
//
//   GET /battles/submit?p=<payload>&s=<signature>   record a trainer's battle record from one world; answers in plain text
//   GET /battles/top10                               the top 10 (the same text the first worlds read from GitHub Pages)
//   GET /battles/ranks                               everyone, ranked, with their ball rank (what the worlds read now)
//   GET /battles/leaderboard.json                    everyone, for the website
//
// After a submission changes the board it republishes battles/top10.txt, battles/ranks.txt and battles/leaderboard.json to the GitHub Pages repo
// (at most once a minute; a cron trigger catches anything left over). The worlds read the board from GitHub Pages because
// *.github.io is on VRChat's trusted list - nobody needs "Allow Untrusted URLs" just to see it.
//
// Payload: "1~<world>~<name as UTF-16 hex, 4 digits a code unit>~<wins>~<losses>~<unix seconds>" (all URL-safe ASCII)
// Signature: two 32-bit FNV-1a hashes of the payload keyed with BATTLE_KEY (hex, 16 digits). The worlds compute the same.
//
// Bindings (wrangler.toml): DB (D1). Secrets: BATTLE_KEY, GITHUB_TOKEN. Vars: GITHUB_REPO, GITHUB_BRANCH.

const WORLDS = { MZ: "Mesagoza", MT: "The Marine Tube", PP: "Power Plant", SP: "Spear Pillar", MF: "Meteor Falls", MC: "Magma Cavern", IF: "Ilex Forest" };
const AUTHOR = { name: "tokyubevoxelverse", email: "tokyubeverse@gmail.com" };
const PUBLISH_EVERY = 60;            // seconds between republishes at most
const MAX_AGE = 48 * 3600;           // a link older than this is refused (copy a fresh one)
const MAX_TOTAL = 100000;
// ball ranks: 0 Poke Ball, 1 Great Ball (50+ wins), 2 Ultra Ball (500+), 3 Master Ball (2500+ wins with losses under 10% of wins)
const GREAT = 50, ULTRA = 500, MASTER = 2500, MASTER_LOSS_SHARE = 0.10;
function tier(r) {
  if (r.wins >= MASTER && r.losses < r.wins * MASTER_LOSS_SHARE) return 3;
  if (r.wins >= ULTRA) return 2;
  if (r.wins >= GREAT) return 1;
  return 0;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/battles/submit") return text(await submit(url, env, ctx));
      if (url.pathname === "/battles/top10") return text(top10Text(await board(env)));
      if (url.pathname === "/battles/ranks") return text(ranksText(await board(env)));
      if (url.pathname === "/battles/leaderboard.json") return json(leaderboardJson(await board(env)));
      if (url.pathname === "/") return text("PV Pokémon Worlds - battles leaderboard server. The board: https://tokyubevoxelverse.github.io/PVPokeWrldsData/");
      return new Response("not found", { status: 404, headers: cors() });
    } catch (e) {
      return text("ERR|The leaderboard server hit a snag - try again in a minute.", 500);
    }
  },
  async scheduled(event, env, ctx) {
    if ((await meta(env, "dirty")) === "1") await publish(env);
  },
};

// ------------------------------------------------------------------------------------------------ submissions
async function submit(url, env, ctx) {
  const p = url.searchParams.get("p") || "", s = (url.searchParams.get("s") || "").toLowerCase();
  if (!/^[0-9A-Za-z~]{1,400}$/.test(p) || !/^[0-9a-f]{16}$/.test(s)) return "ERR|That link isn't a battle stats link - copy it again from the world.";
  if (sign(p, env.BATTLE_KEY) !== s) return "ERR|That link doesn't check out - copy it again from the world (don't edit it).";
  const f = p.split("~");
  if (f.length !== 6 || f[0] !== "1") return "ERR|That link is from an older version of the world - copy a new one.";
  const world = f[1];
  if (!WORLDS[world]) return "ERR|Unknown world.";
  const name = decodeName(f[2]);
  if (!name || name.length > 40) return "ERR|That name can't go on the board.";
  const wins = int(f[3]), losses = int(f[4]), stamp = int(f[5]);
  if (wins < 0 || losses < 0 || wins + losses > MAX_TOTAL) return "ERR|Those numbers don't look right.";
  const now = Math.floor(Date.now() / 1000);
  if (stamp > now + 600) return "ERR|That link is dated in the future - check your clock and copy it again.";
  if (stamp < now - MAX_AGE) return "ERR|That link is more than two days old - copy a fresh one from the world.";
  const key = name.trim().toLowerCase();

  const old = await env.DB.prepare("SELECT wins, losses, stamp FROM battle_stats WHERE name_key = ? AND world = ?").bind(key, world).first();
  if (old) {
    if (stamp <= old.stamp) return reply(env, key, name, "Already on the board - nothing new since your last submit.");
    if (wins < old.wins || losses < old.losses) return "ERR|The board already has a higher record for " + name + " in " + WORLDS[world] + ".";
    // believable: no more than one battle a minute since the last record (plus a little slack)
    const battles = (wins - old.wins) + (losses - old.losses);
    if (battles > Math.max(5, Math.floor((stamp - old.stamp) / 60) + 5)) return "ERR|That's more battles than fit in the time since your last submit.";
  }
  await env.DB.prepare(
    "INSERT INTO battle_stats (name_key, world, name, wins, losses, stamp, updated) VALUES (?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT (name_key, world) DO UPDATE SET name = excluded.name, wins = excluded.wins, losses = excluded.losses, stamp = excluded.stamp, updated = excluded.updated"
  ).bind(key, world, name, wins, losses, stamp, now).run();
  await setMeta(env, "dirty", "1");
  // republish now if it's been a minute (the answer doesn't wait on GitHub)
  const last = int(await meta(env, "published"));
  if (now - last >= PUBLISH_EVERY) ctx.waitUntil(publish(env));
  return reply(env, key, name, "Saved!");
}

async function reply(env, key, name, head) {
  const rows = await board(env);
  const i = rows.findIndex((r) => r.key === key);
  const r = rows[i];
  return "OK|" + head + "|" + clean(name) + "|" + (r ? r.wins : 0) + "|" + (r ? r.losses : 0) + "|" + (i + 1) + "|" + rows.length;
}

// ------------------------------------------------------------------------------------------------ the board
async function board(env) {
  const { results } = await env.DB.prepare("SELECT name_key, world, name, wins, losses, updated FROM battle_stats").all();
  const by = new Map();
  for (const r of results) {
    let e = by.get(r.name_key);
    if (!e) by.set(r.name_key, (e = { key: r.name_key, name: r.name, wins: 0, losses: 0, updated: 0, worlds: {} }));
    e.wins += r.wins; e.losses += r.losses;
    e.worlds[r.world] = { wins: r.wins, losses: r.losses };
    if (r.updated > e.updated) { e.updated = r.updated; e.name = r.name; }     // the latest spelling of their name
  }
  return [...by.values()].sort((a, b) => b.wins - a.wins || a.losses - b.losses || a.updated - b.updated);
}

function top10Text(rows) {
  const lines = ["PVPOKE-BATTLES|1|" + Math.floor(Date.now() / 1000) + "|" + rows.length];
  rows.slice(0, 10).forEach((r, i) => lines.push((i + 1) + "|" + clean(r.name) + "|" + r.wins + "|" + r.losses + "|" + tier(r)));
  return lines.join("\n") + "\n";
}

// everyone, best first: "PVPOKE-BATTLES|2|<updated>|<trainers>" then "rank|name|wins|losses|ball rank" - the worlds show the
// top 10 and find your own line (by your name) for the YOUR PLACE row
function ranksText(rows) {
  const lines = ["PVPOKE-BATTLES|2|" + Math.floor(Date.now() / 1000) + "|" + rows.length];
  rows.forEach((r, i) => lines.push((i + 1) + "|" + clean(r.name) + "|" + r.wins + "|" + r.losses + "|" + tier(r)));
  return lines.join("\n") + "\n";
}

function leaderboardJson(rows) {
  return {
    updated: Math.floor(Date.now() / 1000),
    trainers: rows.length,
    worlds: WORLDS,
    entries: rows.slice(0, 500).map((r, i) => ({ rank: i + 1, name: r.name, wins: r.wins, losses: r.losses, tier: tier(r), worlds: r.worlds })),
  };
}

// ------------------------------------------------------------------------------------------------ publishing to GitHub Pages
async function publish(env) {
  const now = Math.floor(Date.now() / 1000);
  await setMeta(env, "published", String(now));
  await setMeta(env, "dirty", "0");
  const rows = await board(env);
  const files = [
    { path: "battles/top10.txt", content: top10Text(rows) },
    { path: "battles/ranks.txt", content: ranksText(rows) },
    { path: "battles/leaderboard.json", content: JSON.stringify(leaderboardJson(rows), null, 1) + "\n" },
  ];
  const repo = env.GITHUB_REPO, branch = env.GITHUB_BRANCH || "main";
  const gh = (path, init = {}) => fetch("https://api.github.com/repos/" + repo + path, {
    ...init,
    headers: { Authorization: "Bearer " + env.GITHUB_TOKEN, Accept: "application/vnd.github+json", "User-Agent": "pvpoke-battles-worker", "Content-Type": "application/json" },
  }).then(async (r) => { if (!r.ok) throw new Error(path + " " + r.status + " " + (await r.text())); return r.json(); });
  try {
    const ref = await gh("/git/ref/heads/" + branch);
    const head = await gh("/git/commits/" + ref.object.sha);
    const tree = await gh("/git/trees", { method: "POST", body: JSON.stringify({ base_tree: head.tree.sha, tree: files.map((f) => ({ path: f.path, mode: "100644", type: "blob", content: f.content })) }) });
    const when = new Date().toISOString();
    const commit = await gh("/git/commits", { method: "POST", body: JSON.stringify({ message: "Battles leaderboard: " + rows.length + " trainers", tree: tree.sha, parents: [ref.object.sha], author: { ...AUTHOR, date: when }, committer: { ...AUTHOR, date: when } }) });
    await gh("/git/refs/heads/" + branch, { method: "PATCH", body: JSON.stringify({ sha: commit.sha }) });
  } catch (e) {
    await setMeta(env, "dirty", "1");          // try again on the next cron
    console.log("publish failed: " + e.message);
  }
}

// ------------------------------------------------------------------------------------------------ small things
function sign(payload, key) {
  return hex8(fnv1a(key + "|" + payload, 2166136261)) + hex8(fnv1a(payload + "|" + key, 1494134386));
}
function fnv1a(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
function hex8(n) { return n.toString(16).padStart(8, "0"); }
function decodeName(hex) {
  if (!/^([0-9A-Fa-f]{4}){1,40}$/.test(hex)) return "";
  let s = "";
  for (let i = 0; i < hex.length; i += 4) s += String.fromCharCode(parseInt(hex.substr(i, 4), 16));
  return s.replace(/[\u0000-\u001f\u007f]/g, "").trim();
}
function clean(name) { return String(name).replace(/[|\r\n]/g, "¦"); }
function int(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; }
async function meta(env, k) { const r = await env.DB.prepare("SELECT v FROM meta WHERE k = ?").bind(k).first(); return r ? r.v : ""; }
async function setMeta(env, k, v) { await env.DB.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").bind(k, v).run(); }
function cors() { return { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" }; }
function text(body, status = 200) { return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...cors() } }); }
function json(obj) { return new Response(JSON.stringify(obj), { headers: { "Content-Type": "application/json; charset=utf-8", ...cors() } }); }
