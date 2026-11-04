# FH2 Co-op + ATB

A co-op (up to 4 players) and ATB battle mod for **Fear & Hunger 2: Termina** (RPG Maker MV).

This repository holds only the mod's game files, the files that go into the game folder:

| File | What it does |
| --- | --- |
| `www/js/main.js` | Loader. Adds the mod plugins to the game's plugin list without changing `plugins.js`, so translation patches keep working. |
| `www/js/plugins/FH_ATB.js` | Gauge-based ATB battles |
| `www/js/plugins/FH_Coop.js` | Co-op core: session, joining, snapshots |
| `www/js/plugins/FH_CoopWorld.js` | Field play: guests run events, own inventories |
| `www/js/plugins/FH_CoopRoam.js` | Every player explores on their own (different maps) |
| `www/js/plugins/FH_CoopBattle.js` | Co-op battles, downs and deaths |
| `www/js/plugins/FH_CoopSteam.js` | Steam invites (talks to the Steam helper) |

The game itself is not included. You need your own copy of Fear & Hunger 2: Termina.

## Download

Get `FH2_Coop_<version>.zip` from [Releases](https://github.com/moneyhipo/FH2T-Co-op-and-ATB/releases).

Steam invites (F7) also need the Steam helper, a separate download with its source code:
[FHSteamHelper-source-review](https://github.com/moneyhipo/FHSteamHelper-source-review/releases).
Without it, players join by IP.

## Install

1. Close the game.
2. Extract the zip into the game folder (next to `Game.exe`) and overwrite.

Works with or without a translation patch, in either install order.
Uninstall: rename `www/js/main.js.original` back to `main.js`, or verify the game files in Steam.

## Play together

- Host: F6 on the title screen opens a session, then New Game or "Multi Continue".
  F7 invites Steam friends (needs the Steam helper; without it, join by IP).
- Guest: accept the Steam invite, or "Co-op Join" on the title screen and type the host's IP.
- Everyone needs the exact same mod version.

Rules and known bugs: [KNOWN_ISSUES.txt](KNOWN_ISSUES.txt).
Bug reports: please attach `<game folder>/fhcoop_logs/` from every player.

## Status

Beta. Back up your saves before playing. Only 2-player games have been played so far.

This mod was made with AI assistance (Claude).
