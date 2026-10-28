-- PV Pokémon Worlds - battles leaderboard (D1). One row per trainer per world; the board adds a trainer's worlds together.
CREATE TABLE IF NOT EXISTS battle_stats (
  name_key TEXT NOT NULL,       -- their display name, lower case (who they are)
  world    TEXT NOT NULL,       -- MZ Mesagoza, MT The Marine Tube, ...
  name     TEXT NOT NULL,       -- their display name as they spell it
  wins     INTEGER NOT NULL,
  losses   INTEGER NOT NULL,
  stamp    INTEGER NOT NULL,    -- when the world made the link (unix seconds)
  updated  INTEGER NOT NULL,    -- when it reached the board
  PRIMARY KEY (name_key, world)
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
