//=============================================================================
// FH_CoopSteam.js
//=============================================================================
/*:
 * @plugindesc v1.0.1 Co-op over Steam: F7 invites friends through the
 * FHSteamHelper program, snapshots are compressed. Below FH_CoopBattle.
 * @author FH2 Co-op Mod
 *
 * @param Helper Path
 * @desc Helper program, relative to the game folder.
 * @default fh_steam_helper/FHSteamHelper.exe
 *
 * @param Control Port
 * @type number
 * @default 27610
 *
 * @param Guest Port
 * @desc Local port the helper opens for the guest's game.
 * @type number
 * @default 27601
 *
 * @help
 * The game cannot talk to Steam itself (NW.js 0.29 / Node 9), so a small
 * helper program does it. It starts with the game when it is found:
 *
 *  - F6 (title): open a session. The helper creates a friends-only Steam
 *    lobby and passes friends' traffic to the game's co-op port.
 *  - F7: the game's own friend list; picking a friend sends a lobby invite.
 *  - A friend who accepts the invite gets the game's "Co-op Join" done for
 *    them: the helper joins the lobby and opens a local port the game
 *    connects to. Nicknames are Steam names.
 *
 * Without the helper everything works by IP as before.
 */

var FH = FH || {};
FH.Coop = FH.Coop || {};

(function($) {
'use strict';

if (!$.hostHandlers) {
    console.error('FH_CoopSteam needs FH_CoopWorld.js above it.');
    return;
}

var net = require('net');
var path = require('path');
var fs = require('fs');
var childProcess = require('child_process');

var params = PluginManager.parameters('FH_CoopSteam');
$.helperPath = String(params['Helper Path'] || 'fh_steam_helper/FHSteamHelper.exe');
$.controlPort = Number(params['Control Port'] || 27610);
$.guestPort = Number(params['Guest Port'] || 27601);
// The helper is a separate download (Nexus quarantines files with an exe),
// so an old one can stay next to a new mod. It sends its protocol version
// with the Steam name ("ver", none before 0.42 = 0); raise this when the
// mod needs something an older helper lacks.
$.HELPER_MIN_VERSION = 0;

//=============================================================================
// Snapshot compression (snapshots reach ~1.8 MB uncompressed)
//=============================================================================

$.lz = typeof LZString !== 'undefined' ? LZString : null;
$.zlib = (function() {
    try { return require('zlib'); } catch (e) { return null; }
})();
$.patchedSend = false;

// Snapshots are a whole save (~1.8 MB). Node's native zlib packs it many
// times faster than LZString in JS ('zz'); LZString ('z') stays as the
// fallback and is still unpacked. The last result is reused when the same
// save goes to several players.
$.packSnapshot = function(msg) {
    if (!msg || (msg.t !== 'snap' && msg.t !== 'roam') || typeof msg.data !== 'string') return msg;
    if (!$.zlib && !$.lz) return msg;
    if (msg.data !== $.lastSnapRaw) {
        $.lastSnapRaw = msg.data;
        $.lastSnapPacked = $.zlib
            ? { zz: $.zlib.deflateSync(Buffer.from(msg.data, 'utf8')).toString('base64') }
            : { z: $.lz.compressToBase64(msg.data) };
    }
    var packed = {};
    Object.keys(msg).forEach(function(k) { if (k !== 'data') packed[k] = msg[k]; });
    Object.keys($.lastSnapPacked).forEach(function(k) { packed[k] = $.lastSnapPacked[k]; });
    // kept for the other players of this same send only (it held the whole
    // save and its packed copy, megabytes, until the next snapshot)
    if (!$.snapDropDue) {
        $.snapDropDue = true;
        setTimeout($.dropSnapCache, 0);
    }
    return packed;
};

$.snapDropDue = false;
$.dropSnapCache = function() {
    $.snapDropDue = false;
    $.lastSnapRaw = null;
    $.lastSnapPacked = null;
};

$.unpackSnapshot = function(msg) {
    if (!msg || (msg.t !== 'snap' && msg.t !== 'roam')) return;
    if (msg.zz && $.zlib) {
        msg.data = $.zlib.inflateSync(Buffer.from(msg.zz, 'base64')).toString('utf8');
        delete msg.zz;
    } else if (msg.z && $.lz) {
        msg.data = $.lz.decompressFromBase64(msg.z);
        delete msg.z;
    }
};

$.patchConnectionSend = function(conn) {
    if ($.patchedSend || (!$.zlib && !$.lz) || !conn) return;
    var proto = Object.getPrototypeOf(conn);
    var base = proto.send;
    proto.send = function(msg) {
        base.call(this, $.packSnapshot(msg));
    };
    $.patchedSend = true;
};

var _onHostMessage = $.onHostMessage;
$.onHostMessage = function(conn, msg) {
    $.patchConnectionSend(conn);
    _onHostMessage(conn, msg);
};

var _onGuestMessage = $.onGuestMessage;
$.onGuestMessage = function(conn, msg) {
    $.unpackSnapshot(msg);
    _onGuestMessage(conn, msg);
};

//=============================================================================
// Helper program
//=============================================================================

$.helper = null;      // { proc, sock, buffer, ready }
$.steamLobby = null;

// The helper zip is a download of its own (0.42), so it may be extracted
// a little off: its files straight into the game folder or www/, or with
// the zip's own folder around them (FH2_Coop_SteamHelper_0.42/...). Looked
// for at Helper Path first, then there (one folder deep); kept once found.
$.HELPER_EXE = 'FHSteamHelper.exe';
$.helperFileFound = null;
$.helperCandidates = function(root) {
    var list = [path.join(root, $.helperPath)];
    var tops = [root, path.join(root, 'www')];
    tops.forEach(function(top) {
        list.push(path.join(top, 'fh_steam_helper', $.HELPER_EXE), path.join(top, $.HELPER_EXE));
    });
    tops.forEach(function(top) {
        var names = [];
        try {
            names = fs.readdirSync(top);
        } catch (e) {
            return;
        }
        names.forEach(function(n) {
            if (/^(www|save|fhcoop_logs|locales|swiftshader)$/i.test(n)) return;
            var sub = path.join(top, n);
            list.push(path.join(sub, 'fh_steam_helper', $.HELPER_EXE), path.join(sub, $.HELPER_EXE));
        });
    });
    return list;
};

$.helperFile = function(root) {
    if ($.helperFileFound) return $.helperFileFound;
    root = root || path.dirname(process.execPath); // (tests pass another)
    var list = $.helperCandidates(root);
    var file = null;
    for (var i = 0; i < list.length && !file; i++) {
        try {
            if (fs.statSync(list[i]).isFile()) file = list[i];
        } catch (e) {
            // not there
        }
    }
    if (file && file !== list[0]) $.dlog('Steam helper found at', path.relative(root, file));
    if (file && !fs.existsSync(path.join(path.dirname(file), 'steam_api64.dll'))) {
        $.dlog('Steam helper: steam_api64.dll is not next to', path.relative(root, file));
    }
    if (file) $.helperFileFound = file;
    return file;
};

$.startHelper = function(onReady) {
    if ($.helper && $.helper.ready) {
        if (onReady) onReady();
        return true;
    }
    var file = $.helperFile();
    if (!file) return false;
    if (!$.helper) {
        var proc = null;
        try {
            proc = childProcess.spawn(file, ['--port', String($.controlPort)], {
                cwd: path.dirname(file), windowsHide: true, stdio: 'ignore'
            });
        } catch (e) {
            $.dlog('helper start failed', String(e));
            return false;
        }
        $.helper = { proc: proc, sock: null, buffer: '', ready: false, waiting: [], connecting: false };
        proc.on('error', function(e) {
            // e.g. blocked by an antivirus: co-op by IP still works
            $.dlog('helper error', String(e));
            if ($.helper && $.helper.proc === proc) $.helper = null;
        });
        proc.on('exit', function() {
            $.dlog('helper exited');
            if (!$.helper || $.helper.proc !== proc) return;
            if ($.helper.sock && $.helper.ready) {
                // a helper from an earlier run owns the port and we are
                // talking to it: keep using that one
                $.helper.proc = null;
                return;
            }
            $.steamJoining = false;
            if ($.helper.sock) $.helper.sock.destroy();
            $.helper = null;
        });
        window.addEventListener('unload', function() {
            try { proc.kill(); } catch (e) {}
        });
        $.connectHelper(0);
    }
    // a slow start used up the retries: try again
    if (!$.helper.sock && !$.helper.connecting) $.connectHelper(0);
    if (onReady) $.helper.waiting.push(onReady);
    return true;
};

$.connectHelper = function(tries) {
    if (!$.helper) return;
    $.helper.connecting = true;
    var sock = net.connect($.controlPort, '127.0.0.1');
    sock.setEncoding('utf8');
    sock.on('connect', function() {
        if (!$.helper) {
            sock.destroy();
            return;
        }
        $.helper.connecting = false;
        $.helper.sock = sock;
        $.helper.ready = true;
        $.dlog('helper connected');
        var waiting = $.helper.waiting;
        $.helper.waiting = [];
        waiting.forEach(function(fn) { fn(); });
    });
    sock.on('data', function(chunk) {
        var h = $.helper;
        if (!h) return;
        h.buffer += chunk;
        if (String(chunk).indexOf('\n') < 0) return;
        var idx;
        while ((idx = h.buffer.indexOf('\n')) >= 0) {
            var line = h.buffer.slice(0, idx);
            h.buffer = h.buffer.slice(idx + 1);
            if (!line) continue;
            try {
                var t0 = $.frameLogClock(); // (the frame-time log; helper events carry no peer message)
                $.onHelperEvent(JSON.parse(line));
                $.frameLogMsg('helper', $.frameLogClock() - t0);
            } catch (e) {
                $.dlog('bad helper line', line);
            }
        }
    });
    sock.on('error', function() {
        if (!$.helper || $.helper.ready) return;
        if (tries < 40) {
            setTimeout(function() { $.connectHelper(tries + 1); }, 250);
        } else {
            $.helper.connecting = false;
        }
    });
    sock.on('close', function() {
        if ($.helper && $.helper.sock === sock) {
            $.helper.sock = null;
            $.helper.ready = false;
            if (!$.helper.proc) $.helper = null; // the adopted helper is gone: start a fresh one next time
        }
    });
};

$.helperSend = function(cmd) {
    if ($.helper && $.helper.sock) $.helper.sock.write(JSON.stringify(cmd) + '\n');
};

$.onHelperEvent = function(evt) {
    switch (evt.evt) {
    case 'name':
        $.helperVersion = Number(evt.ver) || 0;
        if ($.helperVersion < $.HELPER_MIN_VERSION && !$.helperOldTold) {
            $.helperOldTold = true;
            $.toast('Co-op: Steam helper is outdated. Download the latest helper file.');
        }
        if (evt.name) {
            $.myName = String(evt.name).slice(0, 32);
            $.helperNamed = true;
            $.refreshWindowTitle();
        }
        break;
    case 'lobby':
        $.steamLobby = evt.lobby;
        $.toast('Co-op: Steam session ready - press F7 to invite friends');
        break;
    case 'joinRequest':
        // A friend's invite was accepted (or the game was started from it).
        $.pendingSteamJoin = evt.lobby;
        break;
    case 'ready':
        $.joinViaHelper(evt.port || $.guestPort);
        break;
    case 'friends':
        $.steamFriends = Array.isArray(evt.list) ? evt.list : [];
        if (SceneManager._scene instanceof Scene_FHInvite) SceneManager._scene.onFriends();
        break;
    case 'invited':
        $.toast(evt.ok ? 'Co-op: invite sent to ' + (evt.name || 'your friend')
            : 'Co-op: Steam did not send the invite to ' + (evt.name || 'that friend'));
        break;
    case 'error':
        $.toast('Co-op (Steam): ' + (evt.text || 'error'));
        break;
    }
};

// A join right after the game started (by IP) went in under the Windows
// user name while the helper had not told the Steam name yet: the save knew
// that player by its Steam name - no character, no bag (final review C).
// With a helper running and no name yet, wait for it (at most 3 s).
$.helperNamed = false;
$.NAME_WAIT_MS = 3000;
var _joinNamed = $.join;
$.join = function(address, onFail) {
    var since = Date.now(), port = $.port; // (joinViaHelper sets the port only for its call)
    var tryJoin = function() {
        var alive = !!$.helper && ($.helper.connecting || !!$.helper.sock || !!$.helper.proc);
        if ($.helperNamed || !alive || Date.now() - since >= $.NAME_WAIT_MS) {
            if (!$.helperNamed && alive) $.dlog('join: no Steam name from the helper yet, joining as', $.myName);
            var keep = $.port;
            $.port = port;
            try {
                return _joinNamed(address, onFail);
            } finally {
                $.port = keep;
            }
        }
        setTimeout(tryJoin, 100);
    };
    tryJoin();
};

$.joinViaHelper = function(port) {
    var oldPort = $.port;
    $.port = port;
    $.join('127.0.0.1', function() {
        $.toast('Co-op: could not reach the host through Steam');
    });
    $.port = oldPort;
};

// Open the session: the Steam lobby comes with it.
var _startHost = $.startHost;
$.startHost = function() {
    var wasHost = $.isHost();
    _startHost();
    if (!wasHost && $.isHost()) {
        $.startHelper(function() {
            $.helperSend({ cmd: 'host', port: $.port });
        });
    }
};

// F7: the game's own friend list. The Steam overlay invite dialog is not
// used: in NW.js the overlay is drawn by the GPU process but never gets the
// mouse or keyboard, so it could be neither used nor closed.
$.invite = function() {
    if (!$.isHost()) {
        $.toast('Co-op: press F6 on the title screen to open a session first');
        return;
    }
    if (!$.steamLobby) {
        $.toast('Co-op: the Steam session is not ready yet - try again in a moment');
        return;
    }
    var scene = SceneManager._scene;
    // a battle would end if another scene took over; events and transfers wait
    var canOpen = scene instanceof Scene_Title ||
        (scene instanceof Scene_Map && !$gameMessage.isBusy() && !$gamePlayer.isTransferring() &&
            !SceneManager.isSceneChanging());
    if (scene instanceof Scene_FHInvite) return;
    if (!canOpen) {
        $.toast('Co-op: invite from the title screen or the field (not in battle)');
        return;
    }
    if (!$.startHelper(function() { $.helperSend({ cmd: 'friends' }); })) {
        $.toast('Co-op: Steam helper not found - friends can join by IP');
        return;
    }
    $.steamFriends = null;
    SceneManager.push(Scene_FHInvite);
};

document.addEventListener('keydown', function(e) {
    if (e.keyCode === 118) { // F7
        e.preventDefault();
        $.invite();
    }
});

//-----------------------------------------------------------------------------
// Invite window: online Steam friends, those playing F&H2 first.
// A Scene_MenuBase, so the field keeps running for the guests meanwhile.
//-----------------------------------------------------------------------------

function Window_FHInviteFriends() {
    this.initialize.apply(this, arguments);
}
Window_FHInviteFriends.prototype = Object.create(Window_Command.prototype);
Window_FHInviteFriends.prototype.constructor = Window_FHInviteFriends;

Window_FHInviteFriends.prototype.initialize = function(y) {
    this._friendsY = y;
    Window_Command.prototype.initialize.call(this, 0, y);
};

Window_FHInviteFriends.prototype.windowWidth = function() { return Graphics.boxWidth; };
Window_FHInviteFriends.prototype.numVisibleRows = function() {
    return Math.floor((Graphics.boxHeight - this._friendsY - this.standardPadding() * 2) / this.lineHeight());
};

Window_FHInviteFriends.prototype.makeCommandList = function() {
    var list = ($.steamFriends || []).slice().sort(function(a, b) {
        if (a.game !== b.game) return b.game - a.game;          // playing F&H2 first
        if ((a.st === 1) !== (b.st === 1)) return a.st === 1 ? -1 : 1; // then online
        return String(a.name).localeCompare(String(b.name));
    });
    list.forEach(function(f) {
        var mark = f.game ? '  [F&H2]' : f.st === 1 ? '' : '  (away)';
        var sent = $.steamInvited && $.steamInvited[f.id] ? '  - invited' : '';
        this.addCommand(String(f.name) + mark + sent, 'friend', true, f.id);
    }, this);
};

function Scene_FHInvite() {
    this.initialize.apply(this, arguments);
}
Scene_FHInvite.prototype = Object.create(Scene_MenuBase.prototype);
Scene_FHInvite.prototype.constructor = Scene_FHInvite;

Scene_FHInvite.prototype.create = function() {
    Scene_MenuBase.prototype.create.call(this);
    this._help = new Window_Help(2);
    this.addWindow(this._help);
    this._friends = new Window_FHInviteFriends(this._help.height);
    this._friends.setHandler('friend', this.onInvite.bind(this));
    this._friends.setHandler('cancel', this.popScene.bind(this));
    this.addWindow(this._friends);
    this._waited = 0;
    this.onFriends();
};

Scene_FHInvite.prototype.onFriends = function() {
    if (!this._friends) return;
    var loading = !$.steamFriends;
    var none = !loading && $.steamFriends.length === 0;
    this._help.setText(loading ? 'Loading your Steam friends...' :
        none ? 'No Steam friend is online. (Esc: back)' :
        'Invite a Steam friend to this session. (Esc: back)\nThey accept in Steam and join by themselves.');
    var index = Math.max(0, this._friends.index());
    this._friends.refresh();
    this._friends.select(Math.min(index, Math.max(0, this._friends.maxItems() - 1)));
    this._friends.activate();
};

Scene_FHInvite.prototype.update = function() {
    Scene_MenuBase.prototype.update.call(this);
    // no answer from the helper: say so instead of waiting forever
    if (!$.steamFriends && ++this._waited === 60 * 5) {
        this._help.setText('Steam did not answer. Esc: back, then use the Steam friends list\n' +
            '(right-click a friend > Invite to Game) or let them join by IP.');
    }
};

Scene_FHInvite.prototype.onInvite = function() {
    var id = this._friends.currentExt();
    $.steamInvited = $.steamInvited || {};
    $.steamInvited[id] = true;
    $.helperSend({ cmd: 'inviteUser', id: String(id) });
    this.onFriends(); // shows "- invited", stays open for more friends
};

window.Scene_FHInvite = Scene_FHInvite;

// The helper is started with the game so that accepted invites arrive.
$.startHelper(function() { $.helperSend({ cmd: 'hello' }); });

// Steam starts the game with "+connect_lobby <id>" when a friend accepts an
// invite while the game is closed.
$.launchLobby = function() {
    var argv = [];
    try { argv = (typeof nw !== 'undefined' && nw.App && nw.App.argv) || []; } catch (e) {}
    var i = argv.indexOf('+connect_lobby');
    return i >= 0 ? argv[i + 1] : null;
};
if ($.launchLobby()) $.pendingSteamJoin = $.launchLobby();

// Title: an accepted invite joins right away.
var _Scene_Title_update = Scene_Title.prototype.update;
Scene_Title.prototype.update = function() {
    _Scene_Title_update.call(this);
    if ($.pendingSteamJoin && !$.role && !$.steamJoining) {
        var lobby = $.pendingSteamJoin;
        $.steamJoining = true;
        $.toast('Co-op: joining your friend through Steam...');
        var started = $.startHelper(function() {
            $.steamJoining = false;
            if ($.pendingSteamJoin !== lobby) return;
            $.pendingSteamJoin = null;
            $.helperSend({ cmd: 'join', lobby: lobby });
        });
        if (!started) {
            $.steamJoining = false;
            $.pendingSteamJoin = null;
            $.toast('Co-op: Steam helper not found');
        }
    }
};

})(FH.Coop);
