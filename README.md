# PV Pokémon Worlds

The site for the PV Pokémon Worlds on VRChat - Mesagoza, The Marine Tube, Power Plant, Spear Pillar, Meteor Falls, Magma Cavern and
Ilex Forest - and the **battle trainers' leaderboard** across all of them: https://tokyubevoxelverse.github.io/PVPokeWrldsData/

## How the leaderboard works

VRChat worlds can't send data out on their own, so:

1. Each world counts your Pokémon battles (player vs player, 3+ turns; leaving or forfeiting counts as a loss).
2. At the world's leaderboard, **Submit Your Stats** makes a signed link with your name, wins and losses. You paste it into the
   URL field and press **SUBMIT** - VRChat opens it, and it reaches the leaderboard server (`worker/`, a Cloudflare Worker).
   Submitting needs *Allow Untrusted URLs* on.
3. The server checks the link, adds your worlds together and republishes `battles/top10.txt` and `battles/leaderboard.json`
   here. The worlds read the top 10 from this site (GitHub Pages is on VRChat's trusted list, so anyone sees the board).

## Files

- `index.html` - the site: the worlds, and the full leaderboard
- `battles/top10.txt` - the top 10 the worlds show: a header line `PVPOKE-BATTLES|1|<updated>|<trainers>`, then `rank|name|wins|losses`
- `battles/leaderboard.json` - everyone (the site's table)
- `worker/` - the leaderboard server

## Setting up the server (once)

From the `worker` folder (Node is installed):

```
npx wrangler login
npx wrangler d1 create pvpoke-battles          # paste the database_id it prints into wrangler.toml
npx wrangler d1 execute pvpoke-battles --remote --file schema.sql
npx wrangler secret put BATTLE_KEY             # the signing key the worlds use (kept out of this repo)
npx wrangler secret put GITHUB_TOKEN           # a fine-grained token: this repo only, Contents read and write
npx wrangler deploy
```

Then turn on GitHub Pages for this repo (Settings > Pages > Deploy from a branch > `main` / root).
