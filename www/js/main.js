//=============================================================================
// main.js (FH2 Co-op 1.0.1)
//=============================================================================
// Adds the co-op mod plugins to the game's plugin list. plugins.js is not
// changed, so translation patches keep working. To remove the mod, put back
// main.js.original (or let Steam verify the game files).

var FH_COOP_VERSION = "1.0.1"; // shown when host and guest differ

(function() {
    var mod = [
        {
            "name": "FH_ATB",
            "status": true,
            "description": "v1.0.1 Gauge-based ATB battles for Fear & Hunger 2: Termina.",
            "parameters": {
                "Enabled": "true",
                "Actor Average Seconds": "4.5",
                "Actor Rate Per AGI": "0.2",
                "Time Stop AGI Ratio": "3",
                "Actor Rate Log Scale": "2",
                "Enemy Average Seconds": "5",
                "Actor First Turn Min Seconds": "0",
                "Enemy First Turn Min Seconds": "6",
                "Enemy Rate Min": "0.9",
                "Rate Max": "1.5",
                "Start Gauge Max": "0.3",
                "Ambush Bonus": "1",
                "Gauge X": "8",
                "Gauge Y": "8",
                "Show Enemy Gauges": "false",
                "Wait Mode": "false",
                "Debug Log": "false"
            }
        },
        {
            "name": "FH_Coop",
            "status": true,
            "description": "v1.0.1 Co-op core: session (IP, F6), guest join, snapshots, shared map view with player avatars.",
            "parameters": {
                "Port": "27600",
                "Guest Actor ID": "3",
                "Sync Interval": "6"
            }
        },
        {
            "name": "FH_CoopWorld",
            "status": true,
            "description": "v1.0.1 Co-op field play: guests run events, own inventories, trading.",
            "parameters": {}
        },
        {
            "name": "FH_CoopBattle",
            "status": true,
            "description": "v1.0.1 Co-op battles: battles run on the PC of whoever started them, joining, downs, ghosts, the betrayal tournament.",
            "parameters": {
                "Down Seconds": "300",
                "Revive HP Rate": "0.25"
            }
        },
        {
            "name": "FH_CoopRoam",
            "status": true,
            "description": "v1.0.1 Co-op: every player explores on their own; sub-hosts, sleeping together, Eye of Rher.",
            "parameters": {}
        },
        {
            "name": "FH_CoopSteam",
            "status": true,
            "description": "v1.0.1 Co-op over Steam (FHSteamHelper), snapshot compression.",
            "parameters": {
                "Helper Path": "fh_steam_helper/FHSteamHelper.exe",
                "Control Port": "27610",
                "Guest Port": "27601"
            }
        }
    ];
    $plugins = $plugins.filter(function(p) { return !/^FH_/.test(p.name); });
    $plugins.forEach(function(p) {
        if (p.name === 'Galv_ExAgiTurn') p.status = false; // replaced by FH_ATB
    });
    // Other mods it supports (MINIMAP - Termina's TM_ModLoader, Bloodier
    // battles, Immersive enemy sprites): installed by a line in plugins.js
    // that a translation patch put on afterwards takes out. Their file is
    // there and the line is not: added here, before this mod's plugins.
    var companions = [
        {
            "name": "TM_ModLoader",
            "status": true,
            "description": "[Termina mod] Loads all installed TM_* mods (shared by every mod)",
            "parameters": {}
        },
        {
            "name": "bloodierbattles",
            "status": true,
            "description": "",
            "parameters": {}
        },
        {
            "name": "immersivesprites",
            "status": true,
            "description": "",
            "parameters": {}
        },
        {
            "name": "immersive-attacks",
            "status": true,
            "description": "",
            "parameters": {}
        }
    ];
    companions.forEach(function(c) {
        if (!$plugins.some(function(p) { return p.name === c.name; }) && hasPlugin(c.name)) $plugins.push(c);
    });
    $plugins = $plugins.concat(mod);
    // this mod's optional files (a separate download), after its plugins
    var optional = [
        {
            "name": "FH_CoopPNP",
            "status": true,
            "description": "Co-op with Playable Non-Playables (optional file)",
            "parameters": {}
        }
    ];
    optional.forEach(function(o) {
        if (hasPlugin(o.name)) $plugins.push(o);
    });

    // js/plugins/<name>.js is there (the game: from the disk; a browser: asked for)
    function hasPlugin(name) {
        try {
            if (typeof require === 'function' && typeof process === 'object' && process.mainModule) {
                var path = require('path');
                return require('fs').existsSync(path.join(path.dirname(process.mainModule.filename), 'js', 'plugins', name + '.js'));
            }
            var xhr = new XMLHttpRequest();
            xhr.open('HEAD', 'js/plugins/' + name + '.js', false);
            xhr.send(null);
            return xhr.status === 200;
        } catch (e) {
            return false;
        }
    }
})();

PluginManager.setup($plugins);

window.onload = function() {
    SceneManager.run(Scene_Boot);
};
