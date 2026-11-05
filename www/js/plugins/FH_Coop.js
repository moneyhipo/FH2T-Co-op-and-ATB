//=============================================================================
// FH_Coop.js
//=============================================================================
/*:
 * @plugindesc v0.6.0 Co-op core: session (IP, F6), guest join, snapshots,
 * shared map view with player avatars. Place below FH_ATB.
 * @author FH2 Co-op Mod
 *
 * @param Port
 * @type number
 * @default 27600
 *
 * @param Sync Interval
 * @desc Frames between position/event updates (6 = 10 per second).
 * @type number
 * @default 6
 *
 * @help
 * The connection, the session and the shared map view. Steam invites:
 * FH_CoopSteam. Guests' own maps and events: FH_CoopWorld / FH_CoopRoam.
 *
 * Host:  press F6 on the title screen (lobby panel, top-left), wait for
 *        guests, then choose New Game or Continue. Guests come along.
 * Guest: choose "Co-op Join" on the title screen and type the host IP
 *        (127.0.0.1 when both games run on the same PC). Players who join
 *        after the host started are sent in right away.
 * F8:   open the save screen from the map (host only during co-op; also
 *       in solo games - a beta convenience that skips the game's own
 *       save rules, kept on purpose).
 *
 * The host's PC runs the world. A guest on the host's map shows it (its
 * events run on the host for it); a guest elsewhere runs that map on its
 * own PC (FH_CoopRoam). Up to 4 players; one name, one player.
 */

var FH = FH || {};
FH.Coop = FH.Coop || {};

(function($) {
'use strict';

var net = require('net');
var os = require('os');

var params = PluginManager.parameters('FH_Coop');
$.port = Number(params['Port'] || 27600);

// Playable protagonists and the switches the game turns on for the host's
// pick (CE38 DEFAULT CHARACTER checks these).
$.PLAYABLE = [1, 3, 4, 5, 6, 13, 14, 15];
$.SELECT_SWITCHES = [242, 243, 244, 245, 246, 375, 380,
    2401, 2402, 2403, 2404, 2405, 2406, 2407, 2408, 2409, 2410];
// Select switch -> actor, as set by the character choice on map 155.
$.SELECT_ACTOR = { 246: 1, 242: 3, 243: 4, 244: 5, 2401: 6, 2403: 13, 2404: 14, 2402: 15 };
// Map 155 "start_the_game" turns MERCENARY SELECT on as a default before
// applying the real pick, so the choice only counts once the host left it.
$.CHOICE_MAP_ID = 155;

$.myActorId = 0;        // guest: assigned character (0 = not chosen yet)
$.picking = false;      // guest: selection window should be open
$.pickList = [];
$.picker = null;        // host: guest whose turn it is to choose
$.syncInterval = Math.max(1, Number(params['Sync Interval'] || 6));

$.role = null;          // null | 'host' | 'guest'
$.server = null;
$.clients = [];         // host: connections to guests
$.conn = null;          // guest: connection to host
$.nextGuestId = 1;
// Shared real-time clock used by every co-op plugin for deadlines and ordering.
// Keep this in the core so World/Battle/Roam can rely on it after load order.
$.clockMs = $.clockMs || function() { return Date.now(); };
// Players in a session at most, the host included (user decision 2026-10-19;
// the original battle party has 4 places). Every way in (an IP join, a Steam
// invite, a guest that a sub-host will run) says hello here first.
$.MAX_PLAYERS = 4;
$.remotes = {};         // id -> Game_RemotePlayer
$.frame = 0;
$.snapshotQueued = false;
$.pendingSnapshot = null;
$.lastEventKeys = {};
$.lastPicKeys = {};
$.lastScreenKey = '';
$.lastAudioKey = '';
$.lastMsgKey = '';
$.guestMsgKey = '';
$.roster = [];          // [{id, name}] shown in the session panel
$.hostInGame = false;   // host has entered the map since opening the session

// Nickname: Windows user name until Steam is connected.
$.myName = (function() {
    try { return os.userInfo().username || 'Player'; } catch (e) { return 'Player'; }
})();

// F5 reloads the page but NW.js keeps the Node side alive, so a server or
// socket from before the reload would keep running with the old code.
// Keep them on Node's global object and shut them down on every load.
var nodeGlobal = typeof global !== 'undefined' ? global : window;
$.cleanupNetwork = function() {
    var old = nodeGlobal.__fhCoopNet;
    if (old) {
        if (old.server) {
            try { old.server.close(); } catch (e) {}
        }
        old.sockets.forEach(function(sock) {
            try { sock.destroy(); } catch (e) {}
        });
    }
    nodeGlobal.__fhCoopNet = { server: null, sockets: [] };
};
$.cleanupNetwork();
window.addEventListener('unload', $.cleanupNetwork);

$.trackSocket = function(socket) {
    var net = nodeGlobal.__fhCoopNet;
    net.sockets.push(socket);
    socket.on('close', function() {
        var i = net.sockets.indexOf(socket);
        if (i >= 0) net.sockets.splice(i, 1);
    });
};

$.logFile = null;
// Keep the identity across F5 in the same NW.js process. A reused PID from a
// later launch must start a fresh log instead of appending to an old one.
$.logRunId = nodeGlobal.__fhCoopLogRunId || (nodeGlobal.__fhCoopLogRunId =
    Date.now().toString(36) + '-' + process.pid + '-' + Math.random().toString(36).slice(2));
$.dlog = function() {
    try {
        var fs = require('fs'), path = require('path');
        if (!$.logFile) {
            var dir = path.join(process.cwd(), 'fhcoop_logs');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir);
            $.logFile = path.join(dir, 'window_' + process.pid + '.log');
            // F5 keeps the process (same pid): continue only this run's log.
            // A later launch may reuse the PID, so identify the run in its header.
            var head = ($.versionLabel ? 'mod ' + $.versionLabel($.modVersion, $.modHash) + '\n' : '') +
                'log run ' + $.logRunId + '\n';
            var sameRun = false;
            if (fs.existsSync($.logFile)) {
                var fd = fs.openSync($.logFile, 'r');
                var first = Buffer.alloc(1024), n = 0;
                try { n = fs.readSync(fd, first, 0, first.length, 0); } finally { fs.closeSync(fd); }
                sameRun = first.toString('utf8', 0, n).indexOf('log run ' + $.logRunId + '\n') >= 0;
            }
            if (sameRun) {
                fs.appendFileSync($.logFile, '--- reload (F5) ---\n' + head);
            } else {
                fs.writeFileSync($.logFile, head);
                $.pruneLogs(dir);
            }
            $.logBytes = fs.statSync($.logFile).size;
        }
        var parts = [].slice.call(arguments).map(function(a) {
            return typeof a === 'string' ? a : JSON.stringify(a);
        });
        var t = new Date().toTimeString().slice(0, 8);
        var line = t + ' [' + ($.role || '-') + '] ' + parts.join(' ') + '\n';
        if ($.logBytes + line.length > $.LOG_MAX_BYTES) $.rotateLog();
        fs.appendFileSync($.logFile, line);
        $.logBytes += line.length;
    } catch (e) {}
};

// Limits (final review E): a log a launch, the newest LOG_KEEP kept; one
// over LOG_MAX_BYTES goes on in a fresh file (the full one: *.old.log).
$.LOG_KEEP = 10;
$.LOG_MAX_BYTES = 5 * 1024 * 1024;
$.logBytes = 0;

$.pruneLogs = function(dir) {
    try {
        var fs = require('fs'), path = require('path');
        var logs = fs.readdirSync(dir).filter(function(f) { return /^window_\d+(\.old)?\.log$/.test(f); })
            .map(function(f) { var p = path.join(dir, f); return { p: p, t: fs.statSync(p).mtime.getTime() }; })
            .sort(function(a, b) { return b.t - a.t; });
        logs.slice($.LOG_KEEP).forEach(function(l) {
            if (l.p !== $.logFile) try { fs.unlinkSync(l.p); } catch (e) {}
        });
    } catch (e) {}
};

$.rotateLog = function() {
    var fs = require('fs');
    var old = $.logFile.replace(/\.log$/, '.old.log');
    try { fs.unlinkSync(old); } catch (e) {}
    fs.renameSync($.logFile, old);
    fs.writeFileSync($.logFile, 'log run ' + $.logRunId + '\n--- continued (the earlier part: ' +
        require('path').basename(old) + ') ---\n');
    $.logBytes = fs.statSync($.logFile).size;
};
window.addEventListener('error', function(e) {
    $.dlog('ERROR', String(e.message), e.filename + ':' + e.lineno, e.error && e.error.stack);
});

// The "Game has encountered a bug" screen: the engine catches the error in
// its update loop, so it never reaches the listener above.
$.logCrash = function(kind, e) {
    var where = [];
    try {
        where.push('scene ' + (SceneManager._scene && SceneManager._scene.constructor.name));
        if ($gameMap) where.push('map ' + $gameMap.mapId());
        if ($gameParty && $gameParty.inBattle()) where.push('in battle');
    } catch (e2) {}
    $.dlog('CRASH ' + kind, where.join(', '), 'mod ' + $.versionLabel($.modVersion, $.modHash));
    $.dlog(e && e.stack ? e.stack : String(e && e.message || e));
};
var _SceneManager_catchException = SceneManager.catchException;
SceneManager.catchException = function(e) {
    $.logCrash('exception', e);
    return _SceneManager_catchException.apply(this, arguments);
};
var _SceneManager_onError = SceneManager.onError;
SceneManager.onError = function(e) {
    $.logCrash('error', e && e.error || { message: e && e.message + ' ' + e.filename + ':' + e.lineno });
    return _SceneManager_onError.apply(this, arguments);
};

//=============================================================================
// A missing image must not hold the game at "Loading..."
//=============================================================================
// (0.38.3-pre, docs/조사(보관용)/무한로딩.md.) The villagers' pig pen (Map016 ev344
// pages 6 and 8) puts O'saa on '%yellow_mage5', a sheet the game does not
// have ('%journalist5' for Olivia neither). TY_AbortUrl hides the load error,
// the bitmap stays in the image cache as an error, ImageCache.isReady() is
// false for good and no later scene starts: the game over stayed at
// "Loading...". An original data bug (single player too); here:
// - a bitmap that failed is not waited for; each failed file is logged once;
// - a file the server answers with an error status (400 and up) fails the
//   bitmap (before, it stayed "decrypting" and was waited for forever);
// - those two sheets are the pictures CE288 shows for them as protagonists
//   ('yellow_mage' / 'journalist', index 4 / 5).

ImageCache.prototype.isReady = function() {
    var items = this._items;
    return !Object.keys(items).some(function(key) {
        var b = items[key].bitmap;
        return !b.isRequestOnly() && !b.isReady() && !b.isError();
    });
};

$.imageErrors = {};
var _bitmapOnErrorLog = Bitmap.prototype._onError;
Bitmap.prototype._onError = function() {
    _bitmapOnErrorLog.call(this);
    var url = String(this._url || '');
    if (url && !$.imageErrors[url]) {
        $.imageErrors[url] = true;
        $.dlog('image failed to load', url);
    }
};

// (rpg_core 1.6's Decrypter.decryptImg, plus the error status branch)
Decrypter.decryptImg = function(url, bitmap) {
    url = this.extToEncryptExt(url);
    var requestFile = new XMLHttpRequest();
    requestFile.open('GET', url);
    requestFile.responseType = 'arraybuffer';
    requestFile.send();
    var fail = function() {
        if (bitmap._loader) bitmap._loader(); else bitmap._onError();
    };
    requestFile.onload = function() {
        if (this.status < Decrypter._xhrOk) {
            var arrayBuffer = Decrypter.decryptArrayBuffer(requestFile.response);
            bitmap._image.src = Decrypter.createBlobUrl(arrayBuffer);
            bitmap._image.addEventListener('load', bitmap._loadListener = Bitmap.prototype._onLoad.bind(bitmap));
            bitmap._image.addEventListener('error', bitmap._errorListener = bitmap._loader || Bitmap.prototype._onError.bind(bitmap));
        } else {
            fail(); // no such file: not "decrypting" for ever
        }
    };
    requestFile.onerror = fail;
};

$.MISSING_SHEETS = {
    '%yellow_mage5': { name: 'yellow_mage', index: { 0: 4, 2: 5 } },
    '%journalist5': { name: 'journalist', index: { 0: 4, 2: 5 } }
};

var _setCharacterImageMissing = Game_Actor.prototype.setCharacterImage;
Game_Actor.prototype.setCharacterImage = function(name, index) {
    var alias = $.MISSING_SHEETS[name];
    if (alias && alias.index[index] !== undefined) {
        name = alias.name;
        index = alias.index[index];
    }
    _setCharacterImageMissing.call(this, name, index);
};

$.isHost = function() { return $.role === 'host'; };
$.isGuest = function() { return $.role === 'guest'; };
// A guest mirrors the host (thin client) except while playing solo.
$.isThin = function() { return $.role === 'guest' && !$.solo; };

//=============================================================================
// Connection (newline-delimited JSON over TCP)
//=============================================================================

$.KEEPALIVE_MS = 10000;

function Connection(socket, onMessage, onClose) {
    this.socket = socket;
    $.trackSocket(socket);
    this.buffer = '';
    this.closed = false;
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    // A PC switched off (power, crash) sends no close: without TCP keepalive
    // the other side kept the connection for minutes (the player still "in
    // the game" for sleeps and duels; a re-join met its old connection).
    // Now the system probes after 10 s of silence (final review C).
    if (socket.setKeepAlive) socket.setKeepAlive(true, $.KEEPALIVE_MS);
    socket.on('data', function(chunk) {
        if (this.ignoring) return; // (left: closing gently, see endGently)
        this.buffer += chunk;
        // A big snapshot comes in many chunks: only look for line ends once
        // a chunk brings one, not through the whole buffer every time.
        if (chunk.indexOf('\n') < 0) return;
        var idx;
        while ((idx = this.buffer.indexOf('\n')) >= 0) {
            var line = this.buffer.slice(0, idx);
            this.buffer = this.buffer.slice(idx + 1);
            if (!line) continue;
            var msg;
            try {
                msg = JSON.parse(line);
            } catch (e) {
                console.error('[FH_Coop] bad message', e);
                continue;
            }
            onMessage(this, msg);
        }
    }.bind(this));
    var close = function() {
        if (this.closed) return;
        this.closed = true;
        onClose(this);
    }.bind(this);
    socket.on('close', close);
    socket.on('error', function(e) {
        console.error('[FH_Coop] socket error', e);
        close();
    });
}

Connection.prototype.send = function(msg) {
    if (this.closed) return;
    this.socket.write(JSON.stringify(msg) + '\n');
};

Connection.prototype.close = function() {
    this.socket.destroy();
};

// Leaving on purpose with something still to deliver: the last messages
// go out before the end (destroy() dropped them: with unread data from the
// host in the socket Windows resets the connection, and the host lost what
// was written last - 0.4 review 2 S2). Nothing more is read; the socket is
// destroyed after GENTLE_CLOSE_MS if the host has not closed it by then.
$.GENTLE_CLOSE_MS = 1000;
Connection.prototype.endGently = function() {
    var socket = this.socket;
    this.ignoring = true;
    try {
        socket.end();
    } catch (e) {
        socket.destroy();
        return;
    }
    setTimeout(function() { socket.destroy(); }, $.GENTLE_CLOSE_MS);
};
$.Connection = Connection; // (tests)

//=============================================================================
// HUD (DOM overlay, never pauses the game)
//=============================================================================

$.hud = function(text) {
    var el = document.getElementById('fhcoop-hud');
    if (!el) {
        el = document.createElement('div');
        el.id = 'fhcoop-hud';
        el.style.cssText = 'position:fixed;top:6px;right:8px;z-index:100;' +
            'font:13px sans-serif;color:#fff;background:rgba(0,0,0,0.55);' +
            'padding:3px 8px;border-radius:3px;pointer-events:none;';
        document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.display = text ? 'block' : 'none';
};

$.toast = function(text) {
    $.hud(text);
    clearTimeout($._toastTimer);
    $._toastTimer = setTimeout($.refreshHud, 3000);
};

$.refreshHud = function() {
    $.hud('');
    $.refreshPanel();
    $.refreshWindowTitle();
};

// In-game the two windows look identical, so name the role in the title bar.
$.refreshWindowTitle = function() {
    var base = ($dataSystem && $dataSystem.gameTitle) || document.title.replace(/ \[.*\]$/, '');
    var tag = '';
    if ($.isHost()) tag = ' [HOST]';
    if ($.isGuest()) tag = ' [GUEST: ' + $.myName + ']';
    document.title = base + tag;
};

// Session panel (lobby): top-left, title screen only.
$.refreshPanel = function() {
    var el = document.getElementById('fhcoop-panel');
    if (!el) {
        el = document.createElement('div');
        el.id = 'fhcoop-panel';
        el.style.cssText = 'position:fixed;top:6px;left:8px;z-index:100;' +
            'font:13px sans-serif;color:#fff;background:rgba(0,0,0,0.6);' +
            'padding:5px 9px;border:1px solid rgba(255,255,255,0.25);' +
            'border-radius:3px;pointer-events:none;line-height:1.5;';
        document.body.appendChild(el);
    }
    var show = !!$.role && SceneManager._scene instanceof Scene_Title;
    el.style.display = show ? 'block' : 'none';
    if (!show) return;
    var title = $.isHost() ? 'HOST  (port ' + $.port + ')' : 'CO-OP';
    var lines = $.roster.map(function(p) {
        var tag = p.id === 'host' ? ' [host]' : '';
        var me = (p.id === ($.isHost() ? 'host' : $.myId)) ? ' (me)' : '';
        return '&#9679; ' + $.escape(p.name) + tag + me;
    });
    el.innerHTML = '<b>' + title + '</b><br>' + lines.join('<br>');
};

$.escape = function(text) {
    return String(text).replace(/[&<>"]/g, function(c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
};

$.buildRoster = function() {
    // a: the character (Hexen board start areas), dead: died for good
    var dead = function(id) { return !!($.isDead && $.isDead(id)); };
    var hostActor = $gameSwitches && $gameParty ? $.hostActorId() : 0;
    $.roster = [{ id: 'host', name: $.myName, a: hostActor, dead: dead('host') }].concat($.clients.map(function(c) {
        return { id: c.guestId, name: c.name, a: c.actorId || 0, dead: dead(c.guestId) };
    }));
};

$.broadcastRoster = function() {
    $.buildRoster();
    $.clients.forEach(function(c) { c.send({ t: 'roster', list: $.roster }); });
    $.refreshPanel();
};

//=============================================================================
// Host
//=============================================================================

$.startHost = function() {
    if ($.role) return;
    if (!(SceneManager._scene instanceof Scene_Title)) {
        $.toast('Co-op: press F6 on the title screen');
        return;
    }
    var server = net.createServer(function(socket) {
        new Connection(socket, $.onHostMessage, $.onGuestClosed);
    });
    server.on('error', function(e) {
        $.role = null;
        $.server = null;
        $.roster = [];
        $.refreshHud();
        if (e.code === 'EADDRINUSE') {
            $.toast('Co-op: port ' + $.port + ' is already hosted - use "Co-op Join"');
        } else {
            $.toast('Co-op: server error (' + e.code + ')');
        }
    });
    server.listen($.port, '0.0.0.0', function() {
        $.toast('Co-op: session open on port ' + $.port);
    });
    $.server = server;
    nodeGlobal.__fhCoopNet.server = server;
    $.role = 'host';
    $.hostInGame = false;
    $.buildRoster();
    $.refreshHud();
};

// Host and guest must run the same mod code: the release label (main.js of
// a release sets FH_COOP_VERSION; install.bat copies are '<MOD_RELEASE> dev')
// and a hash of the mod plugin files, which is what is compared.
$.MOD_RELEASE = '0.6.0';
$.modVersion = (typeof FH_COOP_VERSION !== 'undefined' && FH_COOP_VERSION) || $.MOD_RELEASE + ' dev';
$.modHash = (function() {
    try {
        var fs = require('fs'), path = require('path'), crypto = require('crypto');
        var dir = path.join(path.dirname(process.mainModule.filename), 'js', 'plugins');
        var hash = crypto.createHash('md5');
        fs.readdirSync(dir).filter(function(n) { return /^FH_.*\.js$/.test(n); }).sort().forEach(function(n) {
            hash.update(n);
            hash.update(fs.readFileSync(path.join(dir, n)));
        });
        return hash.digest('hex').slice(0, 8);
    } catch (e) {
        return '';
    }
})();
$.versionLabel = function(v, h) {
    return (v || 'old') + (h ? ' [' + h + ']' : '');
};

$.onHostMessage = function(conn, msg) {
    switch (msg.t) {
    case 'hello':
        if ($.modHash && msg.h !== $.modHash) {
            var mine = $.versionLabel($.modVersion, $.modHash), theirs = $.versionLabel(msg.v, msg.h);
            $.dlog('version mismatch', msg.name, 'host', mine, 'guest', theirs);
            conn.send({ t: 'versionMismatch', host: mine, guest: theirs });
            $.toast('Co-op: ' + String(msg.name || 'a guest').slice(0, 32) + ' has another mod version (' + theirs +
                ', host ' + mine + ')');
            setTimeout(function() { conn.close(); }, 500);
            break;
        }
        $.helloGoesOn(conn, msg);
        break;
    case 'pos':
        if (!conn.guestId) break;
        conn.lastPos = msg.p;
        if (msg.p && msg.p.m && msg.p.m !== $gameMap.mapId()) {
            delete $.remotes[conn.guestId]; // on another map (solo)
        } else {
            $.applyRemote(conn.guestId, msg.p);
        }
        break;
    case 'needSnap':
        $.sendSnapshot(conn);
        break;
    case 'pick':
        $.dlog('guest pick', conn.name, msg.id);
        $.onGuestPick(conn, msg.id);
        break;
    case 'soloDone':
        $.onSoloDone(conn, msg);
        break;
    case 'msgVote':
        $.onGuestVote(conn, msg);
        break;
    }
};

$.helloGoesOn = function(conn, msg) {
    // (before the full check: a re-join takes its old place). Checked again
    // whenever a hello goes on after a wait: another one with that name may
    // have come in meanwhile.
    var name = String(msg.name || '').slice(0, 32);
    var probing = name && $.helloProbes[name];
    if (probing && probing !== conn && !probing.closed) {
        $.refuseSameName(conn, name); // one re-join with that name is already being checked
        return;
    }
    var same = $.clientNamed(name, conn);
    if (same) {
        $.helloSameName(conn, msg, same);
        return;
    }
    if ($.sessionFull()) {
        var who = String(msg.name || 'a guest').slice(0, 32);
        $.dlog('session full: refused', who, 'players', $.clients.length + 1);
        conn.send({ t: 'sessionFull', max: $.MAX_PLAYERS });
        $.toast('Co-op: ' + who + ' could not join - the session is full (' + $.MAX_PLAYERS + ' players)');
        setTimeout(function() { conn.close(); }, 500);
        return;
    }
    conn.guestId = 'g' + ($.nextGuestId++);
    conn.name = String(msg.name || conn.guestId).slice(0, 32);
    $.clients.push(conn);
    conn.send({ t: 'welcome', id: conn.guestId });
    // Guests who join in the lobby wait until the host starts the game.
    if ($.hostInGame) $.sendSnapshot(conn);
    conn.inGame = $.hostInGame;
    $.broadcastRoster();
    $.toast('Co-op: ' + conn.name + ' joined');
};

// One name, one player: the save keeps a guest's character, bag, spot and
// death under its name, so a second "Bob" played the first one's character
// and bag with it (0.4 review B4/C3: two PCs with one Windows user name, or
// windows on one PC). Bob again while an old Bob is still listed is a re-join
// the host has not seen the drop of yet (no keepalive: a PC that lost power
// leaves a half-open socket for minutes). The old connection goes when it is
// closed, or quiet (nothing in HELLO_LIVE_MS) and no answer to a ping in
// HELLO_PROBE_MS; a live one keeps its place and the newcomer is turned
// away. A guest answers a ping from its socket handler, minimized or not.
$.HELLO_LIVE_MS = 3000;   // (real time, $.clockMs; _fhHeardAt: every message)
$.HELLO_PROBE_MS = 3000;
$.helloProbes = {}; // name -> the connection whose re-join under that name is being checked

$.clientNamed = function(name, except) {
    if (!name) return null;
    return $.clients.filter(function(c) { return c !== except && c.guestId && c.name === name; })[0] || null;
};

$.connDead = function(c) {
    var s = c.socket;
    return !!c.closed || !!(s && (s.destroyed || s.writable === false));
};

$.helloSameName = function(conn, msg, old) {
    var now = $.clockMs();
    if ($.connDead(old)) {
        $.replaceClient(old, conn, msg, 'its old connection is closed');
    } else if (old._fhHeardAt && now - old._fhHeardAt < $.HELLO_LIVE_MS) {
        $.refuseSameName(conn, old.name);
    } else {
        conn._fhHelloProbe = { msg: msg, old: old, at: now, name: old.name };
        $.helloProbes[old.name] = conn;
        $.dlog('same name:', old.name, '- its old connection is quiet, asked if it is still there');
        old.send({ t: 'ping' });
        setTimeout(function() { $.endHelloProbe(conn); }, $.HELLO_PROBE_MS);
    }
};

$.endHelloProbe = function(conn) {
    var probe = conn._fhHelloProbe;
    if (!probe) return;
    conn._fhHelloProbe = null;
    if ($.helloProbes[probe.name] === conn) delete $.helloProbes[probe.name];
    if (conn.closed) return;
    var old = probe.old;
    if ($.clients.indexOf(old) < 0) {
        $.helloGoesOn(conn, probe.msg); // it left meanwhile (checks the name again)
    } else if (!$.connDead(old) && old._fhHeardAt >= probe.at) {
        $.refuseSameName(conn, old.name);
    } else {
        $.replaceClient(old, conn, probe.msg, 'no answer in ' + $.HELLO_PROBE_MS / 1000 + ' s');
    }
};

// The old connection leaves as a drop does (its spot is kept for the re-join).
$.replaceClient = function(old, conn, msg, why) {
    $.dlog('same name:', old.name, 're-joins (' + why + ') - the old connection is dropped');
    var wasClosed = old.closed;
    old.closed = true; // (its socket's close event does nothing more)
    if (!wasClosed) $.onGuestClosed(old);
    $.clients = $.clients.filter(function(c) { return c !== old; }); // (gone for the name check)
    try {
        if (old.close) old.close();
    } catch (e) {}
    $.helloGoesOn(conn, msg);
};

$.refuseSameName = function(conn, name) {
    $.dlog('same name: refused', name, '(already in the session)');
    conn.send({ t: 'nameTaken', name: name });
    $.toast('Co-op: a second "' + name + '" could not join - that name is already in the session');
    setTimeout(function() { conn.close(); }, 500);
};

// The host and its guests fill every place.
$.sessionFull = function() {
    return $.clients.filter(function(c) { return !!c.guestId; }).length + 1 >= $.MAX_PLAYERS;
};

$.onGuestClosed = function(conn) {
    $.clients = $.clients.filter(function(c) { return c !== conn; });
    // where it was, for a re-join under the same name (saves keep this too)
    if (conn.actorId && conn.lastPos && !conn.solo && $.tutorialOver()) {
        var p = conn.lastPos, data = $.coopData();
        data.pos = data.pos || {};
        data.pos[conn.name] = { m: p.m || $gameMap.mapId(), x: p.x, y: p.y, d: p.d };
    }
    if ($.picker === conn) $.picker = null;
    if (conn.guestId) {
        delete $.remotes[conn.guestId];
        $.broadcastRoster();
        $.toast('Co-op: ' + conn.name + ' left');
        if ($.msgShared && $.msgOwner === conn.guestId) {
            $.msgOwner = 'host';
            $.votes = {};
            $.lastMsgKey = '';
            var scene = SceneManager._scene;
            var win = scene && scene._messageWindow;
            if (win && win._choiceWindow) $.syncHostChoiceInput(win._choiceWindow);
        }
    }
};

// conn: one connection, a list of them (the save is built once), or none
// for every player in the shared game. Wrappers use the same rule.
$.snapshotTargets = function(conn) {
    if (Array.isArray(conn)) return conn;
    if (conn) return [conn];
    var tutorial = !$.tutorialOver();
    return $.clients.filter(function(c) {
        // a guest waiting at the train exit must not be pulled into the
        // host's tutorial maps; it joins when the host leaves the train
        return !c.solo && !(tutorial && c.atExit);
    });
};

// Map events are most of a snapshot (hundreds of KB). Both PCs have the map
// data, so an event goes as the fields that differ from the same event built
// fresh from that data (in the snapshot's world, so the guest builds the same
// one). Events that cannot be rebuilt that way go whole.
$.COMPACT_EVENTS = true;

$.sameValue = function(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    try {
        return a.constructor === b.constructor && JSON.stringify(a) === JSON.stringify(b);
    } catch (e) {
        return false; // circular: send it (JsonEx handles that)
    }
};

// { field: value } for plain values, { field: { '@fhJ': JsonEx text } } for
// objects, { field: { '@fhDel': 1 } } for a field the event does not have.
$.eventDiff = function(ev, mapId, id) {
    var fresh = new Game_Event(mapId, id);
    var diff = null;
    Object.keys(ev).forEach(function(k) {
        var v = ev[k];
        if (v === undefined || $.sameValue(v, fresh[k])) return;
        (diff = diff || {})[k] = v && typeof v === 'object' ? { '@fhJ': JsonEx.stringify(v) } : v;
    });
    Object.keys(fresh).forEach(function(k) {
        if (fresh[k] !== undefined && (!(k in ev) || ev[k] === undefined)) (diff = diff || {})[k] = { '@fhDel': 1 };
    });
    return diff;
};

$.compactEvents = function(map) {
    var mapId = map.mapId();
    var out = { m: mapId, n: map._events.length, p: [], d: {}, f: {} };
    map._events.forEach(function(ev, id) {
        if (!ev) return;
        if (ev.constructor !== Game_Event || ev._eventId !== id || ev._mapId !== mapId || !$dataMap.events[id]) {
            out.f[id] = JsonEx.stringify(ev);
            return;
        }
        out.p.push(id);
        var diff = $.eventDiff(ev, mapId, id);
        if (diff) out.d[id] = diff;
    });
    return out;
};

$.snapshotData = function() {
    var contents = DataManager.makeSaveContents();
    return $.withCeListIds(function() {
        if ($.COMPACT_EVENTS && $dataMap && contents.map === $gameMap) {
            var map = Object.assign(Object.create(Game_Map.prototype), $gameMap);
            map._events = [];
            map._fhEv = $.compactEvents($gameMap);
            contents.map = map;
        }
        return JsonEx.stringify(contents);
    });
};

// What is left is mostly common event lists: a running common event's
// interpreter holds its whole list (a real save: 18 running parallel ones,
// about 900,000 characters - CE41 alone 130,000 - of 1.19 million; lag audit
// 3, docs/조사(보관용)/렉_감사.md). Both PCs run the same mod on the same data, so a
// list that is a common event's own goes as { '@fhCe': id } and is that
// common event's list again on the other PC. The interpreter's place in it
// (_index, _indent, _branch, its children) goes as before. Any other list (a
// map event's page, one the mod built, a changed copy) goes whole.
$.CE_LIST_IDS = true;
$.ceListIds = null; // { data: $dataCommonEvents, ids: Map list -> id, byLength: Map n -> [id] }

$.ceListIndex = function() {
    var c = $.ceListIds;
    if (c && c.data === $dataCommonEvents) return c;
    c = $.ceListIds = { data: $dataCommonEvents, ids: new Map(), byLength: new Map() };
    $dataCommonEvents.forEach(function(ce, id) {
        if (!ce || !Array.isArray(ce.list)) return;
        if (!c.ids.has(ce.list)) c.ids.set(ce.list, id);
        var same = c.byLength.get(ce.list.length);
        if (same) same.push(id); else c.byLength.set(ce.list.length, [id]);
    });
    return c;
};

// Plain data alike (event commands: numbers, strings, arrays, objects).
$.sameData = function(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    var ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (var i = 0; i < ka.length; i++) {
        if (!Object.prototype.hasOwnProperty.call(b, ka[i]) || !$.sameData(a[ka[i]], b[ka[i]])) return false;
    }
    return true;
};

// The common event whose list this is (0: none). A list read from a save (a
// load, a snapshot, an interpreter handed over, HIME_LargeChoices' copy at
// every choice) is a copy of it: one alike is that common event's too, but
// only where a common event's list can be (pageOnly: the list of an event's
// own run is its page - Map114 EV348's parallel pages are CE574/575 word for
// word, Map077 EV326 p0 is CE419: those go whole, never by id).
// hint: the common event it runs for (a parallel common event's own).
$.ceCopyIds = new WeakMap(); // a copy -> the id it is alike (0: none); compared once
$.ceListId = function(list, hint, pageOnly) {
    if (!list || !Array.isArray(list) || typeof $dataCommonEvents === 'undefined' || !$dataCommonEvents) return 0;
    var c = $.ceListIndex();
    var id = c.ids.get(list);
    if (id || pageOnly) return id || 0;
    var known = $.ceCopyIds.get(list);
    if (known !== undefined && (!hint || known === hint)) return known;
    var ids = hint ? [hint] : (c.byLength.get(list.length) || []);
    id = 0;
    for (var i = 0; i < ids.length && !id; i++) {
        var ce = $dataCommonEvents[ids[i]];
        if (ce && ce.list && ce.list.length === list.length && $.sameData(ce.list, list)) id = ids[i];
    }
    if (!hint || id) $.ceCopyIds.set(list, id);
    return id;
};

// The shape of a list (its length, a checksum of each command's code and
// indent): the other PC runs from the same place only in a list of the same
// shape. Kept per list (the data's lists do not change).
$.ceShapes = new WeakMap();
$.ceListShape = function(list) {
    var s = $.ceShapes.get(list);
    if (s) return s;
    var h = 0;
    for (var i = 0; i < list.length; i++) {
        var cmd = list[i] || {};
        h = (Math.imul(h, 31) + (Number(cmd.code) || 0)) | 0;
        h = (Math.imul(h, 31) + (Number(cmd.indent) || 0)) | 0;
    }
    s = { n: list.length, h: h };
    $.ceShapes.set(list, s);
    return s;
};

// fn runs with those lists as { '@fhCe': id, n, h } in the live interpreters
// (the map's, the parallel common events', the map events', and their
// children); each has its own list object back right after (a copy stays a
// copy: the scene records and checks that follow a list by the object -
// sceneLeadActive, sceneOf, fxCeOf - are not cut by a snapshot).
$.withCeListIds = function(fn) {
    if (!$.CE_LIST_IDS || !$gameMap) return fn();
    var swapped = [];
    var swap = function(interp, hint) {
        for (var i = interp; i; i = i._childInterpreter) {
            // the top of a run started by an event (_eventId > 0) is its page
            var top = i === interp;
            var id = $.ceListId(i._list, top ? hint : 0, top && !hint && i._eventId > 0);
            if (!id) continue;
            var shape = $.ceListShape($dataCommonEvents[id].list);
            swapped.push(i, i._list);
            i._list = { '@fhCe': id, n: shape.n, h: shape.h };
        }
    };
    swap($gameMap._interpreter, 0);
    ($gameMap._commonEvents || []).forEach(function(ce) { if (ce) swap(ce._interpreter, ce._commonEventId); });
    ($gameMap._events || []).forEach(function(ev) { if (ev) swap(ev._interpreter, 0); });
    try {
        return fn();
    } finally {
        for (var k = 0; k < swapped.length; k += 2) swapped[k]._list = swapped[k + 1];
    }
};

// The other side: ids back to this PC's lists. A list this PC does not have,
// or of another shape (other game data: the same _index would be another
// command), ends that interpreter's run instead of running a wrong command.
$.restoreCeLists = function(interp) {
    for (var i = interp; i; i = i._childInterpreter) {
        var l = i._list;
        if (!l || Array.isArray(l) || !l['@fhCe']) continue;
        var ce = $dataCommonEvents && $dataCommonEvents[l['@fhCe']];
        var list = ce && Array.isArray(ce.list) ? ce.list : null;
        var shape = list ? $.ceListShape(list) : null;
        if (list && shape.n === l.n && shape.h === l.h) {
            i._list = list;
            continue;
        }
        i._list = null;
        $.dlog('snapshot: CE' + l['@fhCe'], list ? 'differs from the host one (' + shape.n + ' commands, host ' + l.n + ')' :
            'is not in this game data', '- its run ends here (another game version?)');
    }
};

$.restoreSnapshotLists = function(contents) {
    var map = contents && contents.map;
    if (!map) return contents;
    $.restoreCeLists(map._interpreter);
    (map._commonEvents || []).forEach(function(ce) { if (ce) $.restoreCeLists(ce._interpreter); });
    (map._events || []).forEach(function(ev) { if (ev) $.restoreCeLists(ev._interpreter); });
    return contents;
};

// Every snapshot ('snap', 'roam', the tutorial's start) is read with this.
$.parseSnapshot = function(text) {
    return $.restoreSnapshotLists(JsonEx.parse(text));
};

// Which map $dataMap holds (it has no id of its own).
$.dataMapId = 0;
var _DataManager_loadMapData = DataManager.loadMapData;
DataManager.loadMapData = function(mapId) {
    $.dataMapId = mapId;
    _DataManager_loadMapData.call(this, mapId);
};

// Guest: rebuild the events once that map's data is loaded. Not yet loaded:
// left for Scene_Map.onMapLoaded.
$.expandEvents = function() {
    var c = $gameMap && $gameMap._fhEv;
    if (!c) return false;
    if (c.m !== $gameMap.mapId() || !$dataMap || ($.dataMapId && $.dataMapId !== c.m)) return false;
    delete $gameMap._fhEv;
    var events = [];
    events.length = c.n;
    c.p.forEach(function(id) {
        // Set up its page as the host's fresh copy was (a thin guest skips
        // Game_Event.refresh): without it an unchanged event keeps the
        // defaults - no graphic, same-as-characters, not through - an
        // invisible wall until the host happens to send it again.
        $.buildingEvents = true;
        var ev;
        try {
            ev = new Game_Event(c.m, id);
        } finally {
            $.buildingEvents = false;
        }
        var diff = c.d[id];
        if (diff) {
            Object.keys(diff).forEach(function(k) {
                var v = diff[k];
                if (v && v['@fhDel']) delete ev[k];
                else ev[k] = v && v['@fhJ'] !== undefined ? JsonEx.parse(v['@fhJ']) : v;
            });
        }
        events[id] = ev;
    });
    Object.keys(c.f).forEach(function(id) { events[id] = JsonEx.parse(c.f[id]); });
    events.forEach(function(ev) { if (ev) $.restoreCeLists(ev._interpreter); }); // ($.withCeListIds)
    $gameMap._events = events;
    if (c.reset) c.reset(events);
    return true;
};

var _Scene_Map_onMapLoaded_events = Scene_Map.prototype.onMapLoaded;
Scene_Map.prototype.onMapLoaded = function() {
    // a transfer to another map sets that map up from its data anyway
    if (!$gamePlayer.isTransferring() || $gamePlayer.newMapId() === $gameMap.mapId()) $.expandEvents();
    if ($gameMap) delete $gameMap._fhEv;
    _Scene_Map_onMapLoaded_events.call(this);
    // A guest's place from a snapshot was centred while $dataMap was still
    // the map it came from: the camera was cut to that map's size and stayed
    // off the player (0.41 play test: map 9 is 55 wide, so on map 16 the
    // camera stuck at 38 with the player at 68 - the view circle drew off
    // the screen and everything stayed dark). Centre it again now.
    $.recenterGuestCamera();
};

$.recenterGuestCamera = function() {
    if ($.isGuest() && $gamePlayer && $gameMap && !$gamePlayer.isTransferring()) $gamePlayer.center($gamePlayer.x, $gamePlayer.y);
};

$.sendSnapshot = function(conn) {
    var targets = $.snapshotTargets(conn);
    $.dlog('send snapshot, map', $gameMap.mapId(), conn ? targets.map(function(c) { return c.name; }).join(',') : 'all');
    var snap = {
        t: 'snap',
        mapId: $gameMap.mapId(),
        data: $.snapshotData()
    };
    targets.forEach(function(c) {
        // its own character and bag as the host has them, in the same
        // message: a 'me' sent after a 1.8 MB snapshot can come frames late
        var me = $.snapMe ? $.snapMe(c) : null;
        c.send(me ? Object.assign({}, snap, { me: me }) : snap);
        c.inGame = true;
    });
    $.resetSyncKeys();
};

// Forget what was sent so the next state carries everything again.
$.resetSyncKeys = function() {
    $.lastEventKeys = {};
    $.lastEventN = 0;
    $.lastPicKeys = {};
    $.lastScreenKey = '';
    $.lastAudioKey = '';
    // null, not '': "no shared dialogue" ('') goes out again too, so a guest
    // whose old dialogue flag outlived a snapshot gets it cleared
    $.lastMsgKey = null;
};

$.round = function(v) {
    return Math.round(v * 10) / 10;
};

$.screenInfo = function() {
    var sc = $gameScreen;
    return {
        b: Math.round(sc.brightness()),
        t: sc.tone().map(Math.round),
        w: [sc.weatherType(), $.round(sc.weatherPower())]
    };
};

$.pictureInfo = function(pic) {
    if (!pic || !pic.name()) return null;
    return [
        pic.name(), pic.origin(), $.round(pic.x()), $.round(pic.y()),
        $.round(pic.scaleX()), $.round(pic.scaleY()), Math.round(pic.opacity()),
        pic.blendMode(), $.round(pic.angle()),
        pic.tone() ? pic.tone().map(Math.round) : null
    ];
};

$.audioInfo = function() {
    var pick = function(a) {
        return a ? { name: a.name, volume: a.volume, pitch: a.pitch, pan: a.pan } : null;
    };
    return { bgm: pick(AudioManager._currentBgm), bgs: pick(AudioManager._currentBgs) };
};

$.messageInfo = function() {
    var m = $gameMessage;
    if ((!m.hasText() && !m.choices().length) || !$.msgShared) return null;
    var scroll = m.scrollMode();
    return {
        id: $.msgClears, // two identical lines in a row are still two messages
        owner: scroll ? null : $.msgOwner, // (scroll text: nobody answers it)
        f: m.faceName(), fi: m.faceIndex(), bg: m.background(), p: m.positionType(),
        tx: m._texts.slice(), ch: m.choices().slice(),
        dt: m.choiceDefaultType(), ct: m.choiceCancelType(),
        sc: scroll ? [m.scrollSpeed(), m.scrollNoFast()] : null
    };
};

// Screen, pictures, music and the message box, sent only when changed.
$.presentationDelta = function() {
    var out = {};
    var scr = $.screenInfo();
    var key = JSON.stringify(scr);
    if (key !== $.lastScreenKey) { out.scr = scr; $.lastScreenKey = key; }
    var pics = [];
    for (var id = 1; id <= $gameScreen.maxPictures(); id++) {
        var info = $.pictureInfo($gameScreen.picture(id));
        var pk = info ? JSON.stringify(info) : '';
        if (($.lastPicKeys[id] || '') !== pk) {
            pics.push([id, info]);
            $.lastPicKeys[id] = pk;
        }
    }
    if (pics.length) out.pic = pics;
    var au = $.audioInfo();
    key = JSON.stringify(au);
    if (key !== $.lastAudioKey) { out.au = au; $.lastAudioKey = key; }
    var msg = $.messageInfo();
    key = msg ? JSON.stringify(msg) : '';
    if (key !== $.lastMsgKey) { out.msg = msg; $.lastMsgKey = key; }
    return out;
};

//-----------------------------------------------------------------------------
// Shared cutscenes: one player owns a whole event dialogue, rotating in
// host and guest join order. The others see a read-only copy.
//-----------------------------------------------------------------------------

$.msgShared = false; // host: current message belongs to a cutscene
$.msgClears = 0;   // host: bumps on every $gameMessage.clear()
$.msgStep = 0;     // host: bumps every time the dialogue advances
$.votes = {};      // host: current message owner's confirmation or choice
$.msgOwner = null;
$.dialogueOwnerInterp = null;
$.dialogueOwnerScope = null;
$.lastDialogueOwner = null;

var _Game_Message_clear = Game_Message.prototype.clear;
Game_Message.prototype.clear = function() {
    _Game_Message_clear.call(this);
    if ($.isHost()) {
        $.msgClears++;
        $.msgStep = 0;
        $.votes = {};
    }
};

// Guests with a character, while the host is on the map, share dialogue.
$.dialogueVoters = function() {
    if (!$.isHost() || !(SceneManager._scene instanceof Scene_Map)) return [];
    if (!$.tutorialOver()) return []; // everyone plays the tutorial alone
    return $.clients.filter(function(c) { return c.inGame && c.actorId && !c.solo && $.hearsDialogue(c); });
};

// A conversation a player starts (talks to someone, touches something) is
// heard only by the players within HEAR_TILES of it - of the event or of the
// one who started it (user decision 2026-10-31: the host's talk with Tanaka
// showed on a guest across the map and held it there). Autorun and parallel
// scenes stay everyone's on the map. Once a guest hears a dialogue it keeps
// hearing it to its end (it is held while it reads).
$.HEAR_TILES = 3;
$.msgNear = null;     // host: { x, y, by } of the player-started dialogue now, else null
$.msgHearers = {};    // host: guestId -> true, the ones that heard it
$.msgHearScope = null;

$.setHearing = function(interp, shared) {
    var scope = $.dialogueScope(interp);
    if (scope !== $.msgHearScope) {
        $.msgHearers = {};
        $.msgHearScope = scope;
    }
    var ev = interp._eventId > 0 && $gameMap ? $gameMap.event(interp._eventId) : null;
    var page = ev && ev.page();
    var pressed = page && (page.trigger <= 2 || ($.pressChainPage && $.pressChainPage(ev)));
    $.msgNear = shared && pressed ? { x: ev.x, y: ev.y, by: ev._fhStartedBy || null } : null;
};

$.hearsDialogue = function(c) {
    var near = $.msgNear;
    if (!near) return true;
    if ($.msgHearers[c.guestId] || near.by === c.guestId) return true;
    var p = c.lastPos;
    if (!p || p.m !== $gameMap.mapId()) return false;
    var spots = [[near.x, near.y]];
    if (near.by === 'host') spots.push([$gamePlayer.x, $gamePlayer.y]);
    var by = near.by && near.by !== 'host' ? $.clients.filter(function(x) { return x.guestId === near.by; })[0] : null;
    if (by && by.lastPos) spots.push([by.lastPos.x, by.lastPos.y]);
    var hears = spots.some(function(s) {
        return Math.max(Math.abs(p.x - s[0]), Math.abs(p.y - s[1])) <= $.HEAR_TILES;
    });
    if (hears) $.msgHearers[c.guestId] = true;
    return hears;
};

// The shared message of this sync as this guest gets it: only when it hears
// it, and only when that changed for it (each guest has its own key now).
$.hearMessage = function(c, msg, said, saidKey) {
    var mine = said && $.hearsDialogue(c) ? said : null;
    var key = mine ? saidKey : '';
    if (msg.full || (c._fhMsgKey || '') !== key) msg.msg = mine;
    else delete msg.msg;
    c._fhMsgKey = key;
};

$.isSharedDialogue = function() {
    return $.msgShared && $.dialogueVoters().length > 0;
};

// A down or dead player still reads a shared dialogue but never answers it
// (play test 2026-10-20: a down guest was chosen; FH_CoopBattle fills these).
$.cannotOwnDialogue = function(id) {
    return !!(($.isDown && $.isDown(id)) || ($.isDead && $.isDead(id)));
};

// The player who talked to the event runs its dialogue, if still on the map.
$.dialogueStarter = function() {
    var root = $gameMap && $gameMap._interpreter;
    var ev = root && root.isRunning() && root.eventId() > 0 ? $gameMap.event(root.eventId()) : null;
    var id = ev && ev._fhStartedBy;
    if (!id) return null;
    if (id === 'host') return 'host';
    if ($.cannotOwnDialogue(id)) return null;
    return $.dialogueVoters().some(function(c) { return c.guestId === id; }) ? id : null;
};

$.chooseDialogueOwner = function() {
    var guests = $.dialogueVoters().filter(function(c) { return !$.cannotOwnDialogue(c.guestId); });
    // A host-only cutscene keeps working but does not consume the co-op turn.
    // (Nobody standing besides the host: the host answers.)
    if (!guests.length) return 'host';
    var players = ['host'].concat(guests.map(function(c) { return c.guestId; }));
    // a down host leaves its turns to the ones standing
    if ($.cannotOwnDialogue('host')) players.shift();
    var index = 0;
    if ($.lastDialogueOwner) {
        var lastIndex = players.indexOf($.lastDialogueOwner);
        if (lastIndex >= 0) {
            index = (lastIndex + 1) % players.length;
        } else {
            var lastRank = $.lastDialogueOwner === 'host' ? 0 : Number(String($.lastDialogueOwner).slice(1)) || 0;
            index = players.findIndex(function(id) {
                var rank = id === 'host' ? 0 : Number(String(id).slice(1)) || 0;
                return rank > lastRank;
            });
            if (index < 0) index = 0;
        }
    }
    $.lastDialogueOwner = players[index];
    return $.lastDialogueOwner;
};

$.dialogueScope = function(interp) {
    var eventId = Number(interp._eventId) || 0;
    var ev = eventId > 0 && $gameMap ? $gameMap.event(eventId) : null;
    if (ev && ev.page()) return $gameMap.mapId() + ':' + eventId + ':' + ev._pageIndex;
    return interp;
};

// The interpreter whose end ends this dialogue: the one running it, or for a
// called common event (a child) the event's own. It was always the map
// interpreter: a parallel event's dialogue lost its owner whenever the map
// interpreter ended some other event (final review B5).
$.dialogueRoot = function(interp) {
    var map = $gameMap && $gameMap._interpreter;
    if (!interp._depth) return interp;
    if (map && map.isRunning() && map._eventId === interp._eventId) return map;
    var ev = interp._eventId > 0 && $gameMap ? $gameMap.event(interp._eventId) : null;
    if (ev && ev._interpreter && ev._interpreter.isRunning()) return ev._interpreter;
    return map || interp;
};

$.setDialogueOwner = function(interp, shared) {
    var scope = $.dialogueScope(interp);
    if (!shared) {
        if ($.dialogueOwnerInterp === interp || $.dialogueOwnerScope === scope) {
            $.dialogueOwnerInterp = null;
            $.dialogueOwnerScope = null;
            $.msgOwner = null;
        }
        return;
    }
    if ($.dialogueOwnerScope === scope && $.msgOwner) return;
    // Keep the root interpreter so cleanup still works after a transfer
    // makes the event page (and its scope key) unavailable.
    $.dialogueOwnerInterp = $.dialogueRoot(interp);
    $.dialogueOwnerScope = scope;
    $.msgOwner = $.dialogueStarter() || $.chooseDialogueOwner();
    $.votes = {};
};

var _terminateDialogueOwner = Game_Interpreter.prototype.terminate;
Game_Interpreter.prototype.terminate = function() {
    var scope = $.dialogueScope(this);
    if (!this._depth && ($.dialogueOwnerInterp === this || $.dialogueOwnerScope === scope)) {
        $.dialogueOwnerInterp = null;
        $.dialogueOwnerScope = null;
        $.msgOwner = null;
        $.msgShared = false;
        $.msgNear = null;
        $.msgHearers = {};
        $.msgHearScope = null;
        $.votes = {};
    }
    _terminateDialogueOwner.call(this);
};

// A new map drops its events' and common events' interpreters without a
// terminate: a dialogue one of them owned is over (the map interpreter stays).
var _Game_Map_setupDialogueOwner = Game_Map.prototype.setup;
Game_Map.prototype.setup = function(mapId) {
    var owner = $.dialogueOwnerInterp;
    _Game_Map_setupDialogueOwner.call(this, mapId);
    if (owner && owner !== this._interpreter && $.dialogueOwnerInterp === owner) {
        $.dialogueOwnerInterp = null;
        $.dialogueOwnerScope = null;
        $.msgOwner = null;
        $.votes = {};
    }
};

// Who sees a message depends on the event: autorun/parallel pages are
// cutscenes for everyone on the map. Pages started by a player (button or
// touch), and autorun pages that player's press turned on (FH_CoopWorld
// $.pressChainPage: the elevator rope, Map169 EV7), are shared only from
// the first spoken line on: a conversation (user decision 2026-10-31: a
// corpse's menu and an elevator's question showed on a guest nearby /
// across the map). Common events called from items or keys are personal.
Game_Interpreter.prototype.isFHCoopShared = function() {
    if ($gameParty.inBattle()) return false;
    if ($.isPrologueEvent(this._eventId)) return false;
    var ev = this._eventId > 0 ? $gameMap.event(this._eventId) : null;
    var page = ev && ev.page();
    if (!page) return false;
    if ((page.trigger === 3 || page.trigger === 4) && !($.pressChainPage && $.pressChainPage(ev))) return true;
    return $.talkStarted(this);
};

// A spoken line: the speaker's name under its icon ("\>\i[82]\}TANAKA\{\<"),
// or a face.
$.TALK_LINE = /\\i\[\d+\]\\\}/;
$.talkScope = null; // host: the dialogue scope that has spoken
$.isTalkMessage = function(interp) {
    var list = interp._list || [], index = interp._index;
    var cmd = list[index];
    if (!cmd || cmd.code !== 101) return false;
    if (cmd.parameters && cmd.parameters[0]) return true;
    while (list[index + 1] && list[index + 1].code === 401) {
        index++;
        if ($.TALK_LINE.test(String(list[index].parameters[0] || ''))) return true;
    }
    return false;
};

$.talkStarted = function(interp) {
    var scope = $.dialogueScope(interp);
    if ($.talkScope === scope) return true;
    if (!$.isTalkMessage(interp)) return false;
    $.talkScope = scope;
    return true;
};

var _terminateTalkScope = Game_Interpreter.prototype.terminate;
Game_Interpreter.prototype.terminate = function() {
    if (!this._depth && $.talkScope === $.dialogueScope(this)) $.talkScope = null;
    _terminateTalkScope.call(this);
};

$.CUTSCENE_TEXTS = 6;
// Show Picture, Fade Out/In, Tint Screen, Play BGM
$.CUTSCENE_CODES = [231, 221, 222, 223, 241];

$.isCutscenePage = function(page) {
    if (page._fhCutscene === undefined) {
        var texts = 0, staged = false;
        page.list.forEach(function(cmd) {
            if (cmd.code === 101) texts++;
            if ($.CUTSCENE_CODES.contains(cmd.code)) staged = true;
        });
        page._fhCutscene = staged || texts >= $.CUTSCENE_TEXTS;
    }
    return page._fhCutscene;
};

var _Game_Interpreter_command101 = Game_Interpreter.prototype.command101;
Game_Interpreter.prototype.command101 = function() {
    if ($.isHost() && !$gameMessage.isBusy()) {
        $.msgShared = this.isFHCoopShared();
        $.setHearing(this, $.msgShared);
        $.setDialogueOwner(this, $.msgShared);
    }
    return _Game_Interpreter_command101.call(this);
};

// Scroll text (the credits: CE561 from Map161 EV1) in a scene: the guests on
// the map see it scroll too.
var _Game_Interpreter_command105 = Game_Interpreter.prototype.command105;
Game_Interpreter.prototype.command105 = function() {
    if ($.isHost() && !$gameMessage.isBusy()) {
        $.msgShared = this.isFHCoopShared();
        $.setHearing(this, $.msgShared);
    }
    return _Game_Interpreter_command105.call(this);
};

var _Game_Interpreter_command102 = Game_Interpreter.prototype.command102;
Game_Interpreter.prototype.command102 = function() {
    if ($.isHost() && !$gameMessage.isBusy()) {
        $.msgShared = this.isFHCoopShared();
        $.setHearing(this, $.msgShared);
        $.setDialogueOwner(this, $.msgShared);
    }
    return _Game_Interpreter_command102.call(this);
};

$.dialogueOwnerResponded = function() {
    return !!$.msgOwner && $.votes[$.msgOwner] !== undefined;
};

$.advanceStep = function() {
    $.msgStep++;
    $.votes = {};
    $.clients.forEach(function(c) { c.send({ t: 'msgStep', id: $.msgClears, step: $.msgStep }); });
};

$.onGuestVote = function(conn, msg) {
    if (msg.id !== $.msgClears || msg.step !== $.msgStep) return; // stale
    if ($.msgOwner !== conn.guestId || $.votes[conn.guestId] !== undefined) return;
    $.votes[conn.guestId] = msg.v;
};

$.dialogueOwnerChoice = function() {
    return $.votes[$.msgOwner];
};

// Host, every frame: resolve the selected dialogue owner's choice.
$.updateChoiceVote = function() {
    var scene = SceneManager._scene;
    var win = scene && scene._messageWindow && scene._messageWindow._choiceWindow;
    if (!win || !win._fhVoting || !$.dialogueOwnerResponded()) return;
    var choice = $.dialogueOwnerChoice();
    win._fhVoting = false;
    $.advanceStep();
    $gameMessage.onChoice(choice);
    win._messageWindow.terminateMessage();
    win.close();
};

var _Window_Message_updateInput = Window_Message.prototype.updateInput;
Window_Message.prototype.updateInput = function() {
    // (a personal message's choice is never a vote: FH_CoopWorld $.pm)
    if (this._choiceWindow && this._choiceWindow._fhVoting && !$.pm) return true;
    if ($.isGuest()) return this.updateFHCoopGuestInput();
    if (!$.isSharedDialogue() || this.isAnySubWindowActive() || !this.pause) {
        return _Window_Message_updateInput.call(this);
    }
    if ($.msgOwner === 'host' && $.votes.host === undefined && this.isTriggered()) {
        Input.update();
        $.votes.host = true;
    }
    if ($.dialogueOwnerResponded()) {
        $.advanceStep();
        this.pause = false;
        if (!this._textState) this.terminateMessage();
    }
    return true;
};

// The host's choices can arrive while a new map scene is being built: the
// list is then measured before it has contents. start() measures it again.
var _Window_ChoiceList_maxChoiceWidth = Window_ChoiceList.prototype.maxChoiceWidth;
Window_ChoiceList.prototype.maxChoiceWidth = function() {
    if (!this._windowContentsSprite) return 96;
    return _Window_ChoiceList_maxChoiceWidth.call(this);
};

var _Window_ChoiceList_callOkHandler = Window_ChoiceList.prototype.callOkHandler;
Window_ChoiceList.prototype.callOkHandler = function() {
    if ($.solo) return _Window_ChoiceList_callOkHandler.call(this);
    if ($.isGuest()) return this.sendFHCoopVote(this.index());
    if (!$.isSharedDialogue()) return _Window_ChoiceList_callOkHandler.call(this);
    this.castFHCoopHostVote(this.index());
};

var _Window_ChoiceList_callCancelHandler = Window_ChoiceList.prototype.callCancelHandler;
Window_ChoiceList.prototype.callCancelHandler = function() {
    if ($.solo) return _Window_ChoiceList_callCancelHandler.call(this);
    if ($.isGuest()) return this.sendFHCoopVote($gameMessage.choiceCancelType());
    if (!$.isSharedDialogue()) return _Window_ChoiceList_callCancelHandler.call(this);
    this.castFHCoopHostVote($gameMessage.choiceCancelType());
};

Window_ChoiceList.prototype.castFHCoopHostVote = function(choice) {
    if ($.msgOwner !== 'host' || $.votes.host !== undefined) return;
    $.votes.host = choice;
    this._fhVoting = true;
    this.deactivate();
};

// The choice list is up: the message has choices and its window is open (or
// opening: Window_ChoiceList.start opens it first). Anything else must leave
// it inactive - an active sub window makes Window_Message ignore OK forever
// (play test 2026-10-20: the host frozen on "Again sleeping, are we?" after
// it took a text-only shared line over from a down guest).
$.choiceListUp = function(win) {
    return $gameMessage.isChoice() && (win.isOpen() || !!(win.isOpening && win.isOpening()));
};

$.choiceListDown = function(win) {
    if ($.choiceListUp(win)) return false;
    win._fhVoting = false;
    win.deactivate();
    return true;
};

$.syncHostChoiceInput = function(win) {
    if (!$.isHost() || !win || $.choiceListDown(win) || !$.msgShared) return;
    // a battle's choice (a coin toss) is never a shared-dialogue vote: a flag
    // left from the map's scene before the fight must not take it away
    if ($gameParty && $gameParty.inBattle()) {
        win._fhVoting = false;
        win.activate();
        return;
    }
    var canVote = $.msgOwner === 'host' && $.votes.host === undefined;
    win._fhVoting = !canVote;
    if (canVote) win.activate();
    else win.deactivate();
};

//-----------------------------------------------------------------------------
// Guest side of shared dialogue
//-----------------------------------------------------------------------------

$.guestMsgId = -1;
$.guestStep = 0;
$.guestVoted = false;
$.guestMsgOwner = null;
$.guestMsgShared = false;

$.syncGuestChoiceInput = function(win) {
    // (a text-only line it owns: the vote is OK on the message, see
    // updateFHCoopGuestInput - an active choice list blocked it)
    if (!$.isGuest() || !win || $.choiceListDown(win)) return;
    // A personal choice (the guest's own event, FH_CoopWorld $.pm) is this
    // player's alone. A shared-dialogue flag left over from before (a roam,
    // a snapshot) made the ritual circle's sigil list a vote nobody could
    // cast: no key worked and the host waited forever (0.38.3-pre2).
    // So is a choice of a fight on this PC or a joined one's coin toss
    // (FH_CoopBattle): the shared-dialogue flags are not updated during a
    // fight, one left from before deactivated the toss (0.38.3-pre5).
    if ($.pm || $.puppet || $.localBattle) {
        win._fhVoting = false;
        win.activate();
        return;
    }
    if (!$.guestMsgShared) return;
    var canVote = !!$.myActorId && $.myId === $.guestMsgOwner && !$.guestVoted;
    win._fhVoting = !canVote;
    if (canVote) win.activate();
    else win.deactivate();
};

// The world changed under the guest (a snapshot, its own map, leaving): the
// host's shared dialogue it showed is gone, and the "closed" the host sent
// once may never have arrived (dropped while roaming, a scene change).
$.resetGuestShared = function() {
    $.guestMsgShared = false;
    $.guestMsgOwner = null;
    $.guestVoted = false;
    $.guestMsgKey = '';
    var scene = SceneManager._scene;
    var win = scene && scene._messageWindow;
    if (win && win._choiceWindow) win._choiceWindow._fhVoting = false;
};

$.sendGuestVote = function(v) {
    if (!$.conn || $.guestVoted || !$.myActorId || $.myId !== $.guestMsgOwner) return false;
    $.guestVoted = true;
    $.conn.send({ t: 'msgVote', id: $.guestMsgId, step: $.guestStep, v: v });
    $.toast('Co-op: waiting for the host');
    return true;
};

Window_Message.prototype.updateFHCoopGuestInput = function() {
    if ($.solo) return _Window_Message_updateInput.call(this);
    if (this.isAnySubWindowActive()) return true;
    if (!this.pause) return false;
    if (this.isTriggered()) {
        Input.update();
        $.sendGuestVote(true);
    }
    return true;
};

Window_ChoiceList.prototype.sendFHCoopVote = function(choice) {
    if (!$.sendGuestVote(choice)) return;
    this._fhVoting = true;
    this.deactivate();
};

var _Window_ChoiceList_startDialogue = Window_ChoiceList.prototype.start;
Window_ChoiceList.prototype.start = function() {
    _Window_ChoiceList_startDialogue.call(this);
    if ($.isGuest()) $.syncGuestChoiceInput(this);
    else $.syncHostChoiceInput(this);
};

$.closeGuestChoice = function(win) {
    win._choiceWindow._fhVoting = false;
    win._choiceWindow.deactivate();
    win._choiceWindow.close();
};

// Host moved the dialogue on: release the guest's copy of the window.
$.onMsgStep = function(msg) {
    if (msg.id !== $.guestMsgId) return;
    $.guestStep = msg.step;
    $.guestVoted = false;
    var scene = SceneManager._scene;
    var win = scene && scene._messageWindow;
    if (!win) return;
    if (win._choiceWindow && win._choiceWindow.isOpen()) {
        $.closeGuestChoice(win);
        win.terminateMessage();
        return;
    }
    if (win.pause) {
        win.pause = false;
        if (!win._textState) win.terminateMessage();
    }
};

$.playerInfo = function(id) {
    return {
        id: id,
        x: $gamePlayer.x,
        y: $gamePlayer.y,
        d: $gamePlayer.direction(),
        s: $gamePlayer.realMoveSpeed(),
        n: $gamePlayer.characterName(),
        i: $gamePlayer.characterIndex(),
        a: $.playerActorId(),
        tr: $gamePlayer.isTransparent() ? 1 : 0,
        m: $gameMap.mapId()
    };
};

$.eventInfo = function(ev) {
    return [
        ev.eventId(), ev._x, ev._y, ev._direction, ev._characterName,
        ev._characterIndex, ev._pattern, ev._tileId, ev._opacity,
        ev._transparent ? 1 : 0, ev._erased ? 1 : 0, ev._priorityType,
        ev._through ? 1 : 0, ev.realMoveSpeed()
    ];
};

//-----------------------------------------------------------------------------
// Character selection (host decides; stored in the host's save)
//-----------------------------------------------------------------------------

// nickname -> actorId, saved with the host's game.
$.assignments = function() {
    $gameSystem._fhCoop = $gameSystem._fhCoop || { assign: {} };
    return $gameSystem._fhCoop.assign;
};

$.hostHasChosen = function() {
    if ($gameMap.mapId() === $.CHOICE_MAP_ID) return false;
    return $.SELECT_SWITCHES.some(function(id) { return $gameSwitches.value(id); });
};

$.hostActorId = function() {
    var found = 0;
    Object.keys($.SELECT_ACTOR).forEach(function(sw) {
        if (!found && $gameSwitches.value(Number(sw))) found = $.SELECT_ACTOR[sw];
    });
    if (found) return found;
    var leader = $gameParty.leader();
    return leader ? leader.actorId() : 0;
};

// The party leader can still be Levi while a guest's selected protagonist is
// being applied. Use the co-op assignment/switch as the visual identity.
$.playerActorId = function() {
    if ($.isGuest() && Number($.myActorId) > 0) return Number($.myActorId);
    if ($.isHost() && $.hostHasChosen()) return Number($.hostActorId()) || 0;
    var leader = $gameParty && $gameParty.leader();
    return leader ? leader.actorId() : 0;
};

$.takenActors = function() {
    var assign = $.assignments();
    var taken = [$.hostActorId()];
    Object.keys(assign).forEach(function(name) { taken.push(assign[name]); });
    return taken;
};

// The host's game ended (game over, back to the title): the next game picks
// again like a fresh join - its own save's assignments, or a new pick. A kept
// conn.actorId skipped the guest's pick and solo intro in the next new game
// (0.41 play test: the guest got its old character as a plain companion).
$.resetPicks = function() {
    $.picker = null;
    $.clients.forEach(function(c) {
        c.actorId = 0;
        c.toldWait = false;
        c.inGame = false;
        c.atExit = false;
    });
};

$.sendAssign = function(conn, actorId) {
    conn.actorId = actorId;
    conn.send({ t: 'assign', id: actorId });
}; // replaced in the solo tutorial section

// Host picks first (in the game's own intro), then guests in join order.
$.updatePicking = function() {
    if (!$.hostHasChosen()) {
        $.clients.forEach(function(c) {
            if (c.inGame && !c.actorId && !c.toldWait) {
                c.toldWait = true;
                c.send({ t: 'pickWait', why: 'host' });
            }
        });
        return;
    }
    var assign = $.assignments();
    var hostId = $.hostActorId();
    $.clients.forEach(function(c) {
        if (!c.inGame || c.actorId) return;
        var saved = assign[c.name];
        if (saved && saved !== hostId) {
            var missing = $.historyMissing(c, saved); // (before its 'me' makes it a board)
            if (missing && $.restoreSolo(c, saved)) missing = false; // (before 'assign' sends the bag)
            $.sendAssign(c, saved);
            if (missing && !c.solo) {
                $.dlog('no character history yet for', c.name);
                $.giveHistorySkip(c, saved);
            }
        }
    });
    if ($.picker && !$.picker.actorId && $.clients.contains($.picker)) return;
    $.picker = null;
    var next = $.clients.filter(function(c) { return c.inGame && !c.actorId; })[0];
    if (!next) return;
    $.picker = next;
    var taken = $.takenActors();
    next.send({ t: 'pickTurn', list: $.PLAYABLE.map(function(id) {
        return { id: id, taken: taken.contains(id) };
    }) });
    $.clients.forEach(function(c) {
        if (c !== next && c.inGame && !c.actorId) c.send({ t: 'pickWait', why: 'guest' });
    });
};

$.onGuestPick = function(conn, actorId) {
    if (conn !== $.picker) return;
    if (!$.PLAYABLE.contains(actorId) || $.takenActors().contains(actorId)) {
        $.picker = null; // send the list again with fresh data
        return;
    }
    $.assignments()[conn.name] = actorId;
    $.sendAssign(conn, actorId);
    $.picker = null;
    $.giveHistorySkip(conn, actorId);
    $.toast('Co-op: ' + conn.name + ' chose ' + $dataActors[actorId].name);
};

// A guest picking after the tutorial skipped the character history: its
// character is still the companion NPC of the host's world. Give it what the
// history's "Skip?" -> Yes branch gives (map 19 event 224, the page of that
// character): skills, items, equipment, its switches. No fades, waits or the
// move to the train. Once per player and character.
$.HISTORY_MAP = 19;
$.HISTORY_EVENT = 224;
$.SKIP_CODES = [121, 126, 127, 128, 311, 312, 313, 314, 315, 316, 317, 318, 319, 320, 321, 322, 325, 326];
$.SKIP_NOT_SWITCHES = [79, 2861, 2862, 2863]; // START, Sleep1-3: the scene, not the character

$.readHistoryMap = function() {
    try {
        var path = require('path'), fs = require('fs');
        var file = path.join(path.dirname(process.mainModule.filename), 'data', 'Map019.json');
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        $.dlog('ERROR history data', String(e));
        return null;
    }
};

$.historySkipList = function(actorId) {
    var map = $.readHistoryMap();
    if (!map) return null;
    var ev = map.events[$.HISTORY_EVENT];
    var sel = $.SELECT_OF_ACTOR[actorId];
    var page = ev && ev.pages.filter(function(p) {
        return p.conditions.switch1Valid && p.conditions.switch1Id === sel;
    })[0];
    if (!page) return null;
    var list = page.list;
    var start = list.findIndex(function(c) { return c.code === 402 && c.indent === 0 && c.parameters[0] === 0; });
    if (start < 0) return null;
    var out = [];
    for (var i = start + 1; i < list.length; i++) {
        var c = list[i];
        if (c.indent === 0) break; // the next choice branch
        if (c.indent !== 1 || !$.SKIP_CODES.contains(c.code)) continue;
        if (c.code === 121 && $.SKIP_NOT_SWITCHES.contains(c.parameters[0])) continue;
        out.push({ code: c.code, indent: 0, parameters: c.parameters });
    }
    out.push({ code: 0, indent: 0, parameters: [] });
    return out;
};

$.giveHistorySkip = function(conn, actorId) {
    if (conn.solo || !$.tutorialOver() || !$.runOwned) return;
    var done = $.coopData().historySkip = $.coopData().historySkip || {};
    var key = conn.name + ':' + actorId;
    if (done[key]) return;
    var list = $.historySkipList(actorId);
    if (!list || list.length <= 1) return;
    done[key] = true;
    $.historyDone()[conn.name] = 'skip';
    $.dlog('history skip set for', conn.name, actorId, (list.length - 1) + ' commands');
    $.runOwned(conn, list, null);
};

// Whose character history is done in this save: 'solo' (its tutorial),
// 'skip' (giveHistorySkip), 'old' (an older save: it had a board).
$.historyDone = function() {
    var data = $.coopData();
    data.historyDone = data.historyDone || {};
    return data.historyDone;
};

// Assigned again from the save after the tutorial, with no history yet: it
// left in the middle of its solo tutorial, or the save was made before it
// reached the exit (hard mode). It never got its history's skills, items
// and switches (0.41 audit: Abella's weapon schematics); it gets the skip
// set (updatePicking). Before the tutorial ends its solo tutorial gives it.
$.historyMissing = function(conn, actorId) {
    if (!$.tutorialOver()) return false;
    var done = $.historyDone();
    if (done[conn.name]) return false;
    var data = $.coopData();
    if ((data.historySkip || {})[conn.name + ':' + actorId] || (data.hexen || {})[conn.name]) {
        done[conn.name] = 'old'; // an older save: it had its history or played on with it
        return false;
    }
    return true;
};

// What each guest's solo tutorial gave, kept by the host for this run of the
// game (not in the save). A save made before that guest reached the exit
// (hard mode: a game over loads one) has none of it; the guest gets it back
// instead of the skip set (0.41 play test: Abella picked weapon crafting,
// the host died and loaded, the schematics were gone).
// Each kept with the playthrough it came from (coopData().run, made at a new
// game): a save of another playthrough loaded in the same run of the game
// does not take it (0.41 review 3 S5). A save from before that mark has
// none and takes it as before.
$.soloKept = {};

$.playRun = function() {
    return $gameSystem ? ($.coopData().run || '') : '';
};

var _setupNewGameRun = DataManager.setupNewGame;
DataManager.setupNewGame = function() {
    _setupNewGameRun.call(this);
    $.coopData().run = Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
};

$.keepSolo = function(conn, part) {
    var k = $.soloKept[conn.name], run = $.playRun();
    if (!k || k.actorId !== conn.actorId || k.run !== run) {
        k = $.soloKept[conn.name] = { actorId: conn.actorId, run: run };
    }
    Object.keys(part).forEach(function(key) { k[key] = JSON.stringify(part[key]); });
};

$.restoreSolo = function(conn, actorId) {
    var k = $.soloKept[conn.name];
    var run = $.playRun();
    if (!k || k.actorId !== actorId || !k.actor || (run && k.run && k.run !== run)) return false;
    $gameActors._data[actorId] = JsonEx.parse(JSON.parse(k.actor));
    if (k.inv) { $.guestInventory(conn.name); $.coopData().inv[conn.name] = JSON.parse(k.inv); }
    $.historyDone()[conn.name] = 'solo';
    $.dlog('history from the tutorial of', conn.name, 'given again (the save was made before it)');
    return true;
};

// Hide the field NPC of every character a guest plays (the game already
// handles the host's own pick). Matches sheet names like "%occultist",
// "$occultist_rowing1", "occultist2" but not "mechanical_dance".
// Every sync used to test every event of the map (922 on Map058). Now all
// of them when the taken characters, the map or its events are new, else only
// the events whose look changed since the last sync ($.syncEvents).
$.takenNpcRe = null;
$.takenNpcFor = null; // the events array the last full check was for
$.takenNpcPrep = function() {
    var hostId = $.hostActorId();
    var keys = [];
    $.takenSelects = [];
    $.clients.forEach(function(c) {
        if (!c.actorId || c.actorId === hostId) return;
        var name = $dataActors[c.actorId].characterName.replace(/^[!$%]+/, '');
        keys.push(name.replace(/\d+$/, ''));
        if ($.SELECT_OF_ACTOR[c.actorId]) $.takenSelects.push($.SELECT_OF_ACTOR[c.actorId]);
    });
    if (keys.length === 0) {
        $.takenNpcFor = null; // (events that change meanwhile are checked when it is back)
        return null;
    }
    var source = keys.join('|');
    if ($.takenNpcSource !== source) {
        $.takenNpcSource = source;
        $.takenNpcRe = new RegExp('^[!$%]*(' + source + ')(\\d|_|$)');
        $.takenNpcFor = null;
    }
    return $.takenNpcRe;
};

// (a player's own body is that character's look: FH_CoopRoam "Bodies as events")
$.hideTakenNpc = function(ev, re) {
    if (ev._erased || !ev.characterName()) return;
    if (!re.test(ev.characterName()) && !$.selectGoneNpc(ev)) return;
    var data = ev.event();
    if (data && data._fhBody) return;
    ev.erase();
};

// Where all the contestants stand together (Path1 after the train, the train
// cabins) some of them are drawn from sheets of several people
// ($characters1-3, $botanist1: Abella "redhair" $characters2, Daan "doctor"
// $characters3...), which the name test above misses (play test 2026-11-05:
// a guest played Abella, her NPC stood at Path1). The original takes the
// chosen character's NPC away with a page on its SELECT switch with nothing
// on it (redhair: [SW244] empty). Such an event goes when, with a guest's
// SELECT taken as on, its page would be an empty one that needs that switch -
// unless its picture shows up on another event then (Daan's pick moves
// people about: Henryk's event is empty, his picture stands in Karin's).
// Only on those maps and only people (elsewhere such pages also take away
// monsters and door tiles in that character's story).
$.SELECT_NPC_MAPS = [4, 14];
$.takenSelects = [];

$.pageNeedsSwitch = function(page, sw) {
    var c = page.conditions;
    return (c.switch1Valid && c.switch1Id === sw) || (c.switch2Valid && c.switch2Id === sw);
};

// The page index the event would take with switch sw on (-1: none).
$.pageWithSwitchOn = function(ev, sw) {
    var pages = ev.event().pages;
    for (var i = pages.length - 1; i >= 0; i--) {
        var page = pages[i];
        if ($.pageNeedsSwitch(page, sw)) {
            var c = Object.assign({}, page.conditions);
            if (c.switch1Valid && c.switch1Id === sw) c.switch1Valid = false;
            if (c.switch2Valid && c.switch2Id === sw) c.switch2Valid = false;
            page = Object.assign({}, page, { conditions: c });
        }
        if (ev.meetsConditions(page)) return i;
    }
    return -1;
};

$.npcCellKey = function(image) {
    var name = image.characterName;
    // a "$" sheet is one picture of 3 x 4 poses (here: of several people)
    return /^[!]*\$/.test(name) ? name + ':' + image.direction + ':' + image.pattern : name + ':' + image.characterIndex;
};

$.isPersonImage = function(image) {
    return !!image && !!image.characterName && !image.tileId && image.characterName.charAt(0) !== '!';
};

// cell key -> true: the pictures events show with switch sw on, where that
// switch changes their page (made once per full check of the map).
$.selectMovedCache = null; // { events, map: { sw: { key: true } } }
$.selectMovedCells = function(sw) {
    var cache = $.selectMovedCache;
    if (!cache || cache.events !== $gameMap._events) cache = $.selectMovedCache = { events: $gameMap._events, map: {} };
    if (cache.map[sw]) return cache.map[sw];
    var cells = cache.map[sw] = {};
    $gameMap.events().forEach(function(ev) {
        var data = ev.event();
        if (!data || !data.pages) return;
        var i = $.pageWithSwitchOn(ev, sw);
        if (i < 0 || i === ev._pageIndex || !$.pageNeedsSwitch(data.pages[i], sw)) return;
        if ($.isPersonImage(data.pages[i].image)) cells[$.npcCellKey(data.pages[i].image)] = true;
    });
    return cells;
};

$.selectGoneNpc = function(ev) {
    if (!$.takenSelects.length || $.SELECT_NPC_MAPS.indexOf($gameMap.mapId()) < 0) return false;
    var data = ev.event();
    var now = data && data.pages && data.pages[ev._pageIndex];
    if (!now || !$.isPersonImage(now.image)) return false;
    var key = $.npcCellKey(now.image);
    return $.takenSelects.some(function(sw) {
        var i = $.pageWithSwitchOn(ev, sw);
        if (i < 0 || i === ev._pageIndex) return false;
        var page = data.pages[i];
        if (page.image.characterName || page.image.tileId || !$.pageNeedsSwitch(page, sw)) return false;
        return !$.selectMovedCells(sw)[key];
    });
};

$.hideTakenNpcs = function() {
    var re = $.takenNpcPrep();
    if (!re) return;
    $.selectMovedCache = null;
    $gameMap.events().forEach(function(ev) { $.hideTakenNpc(ev, re); });
    $.takenNpcFor = $gameMap._events;
};

// Bodies and Rher forms take event ids above 9000 (FH_CoopRoam
// RHER_EVENT_BASE, the same on every PC), so a map with one has a sparse
// event array. The engine's events() filtered all 9000 slots several times a
// frame and the sync walked them too (play test 2026-10-31: lag on a map with
// a body, gone off it; harness map 4: 1.9 -> 2.9 ms a frame). Walk only the
// events there (the same ones, in id order).
// Such a list is still 5 times slower to walk than a full one, and
// TerraxLighting rebuilds its light list every 200 frames calling events()
// some 7 times per event (play test 2026-10-31: the host still stuttered;
// harness map 4: 28 -> 166 ms each time). Made once a frame, again when the
// array's length changes (an event added or removed); kept beside it in a
// WeakMap, nothing on the array (saves).
$.SPARSE_EVENTS = 2000;
$.eventsCache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
$.eventsOf = function(list) {
    if (list.length < $.SPARSE_EVENTS) return list.filter(function(ev) { return !!ev; });
    var frame = Graphics.frameCount, hit = $.eventsCache && $.eventsCache.get(list);
    if (hit && hit.frame === frame && hit.len === list.length) return hit.out;
    var out = [], keys = Object.keys(list);
    for (var i = 0; i < keys.length; i++) {
        var ev = list[keys[i]];
        if (ev) out.push(ev);
    }
    if ($.eventsCache) $.eventsCache.set(list, { frame: frame, len: list.length, out: out });
    return out;
};

Game_Map.prototype.events = function() {
    return $.eventsOf(this._events);
};

// YEP_StopMapMovement asks this for every self-moving event every frame, and
// walked the whole array by index (play test 2026-10-31: still lag on a map
// with a body, none in a save without deaths).
Game_Map.prototype.isAnyEventStartingQuick = function() {
    var list = $.eventsOf(this._events);
    for (var i = 0; i < list.length; i++) {
        if (list[i].isStarting()) return true;
    }
    return false;
};

// Was info (an event's last sent $.eventInfo) made from ev as it is now?
// Keep in step with $.eventInfo. Each field as info.join(',') compared them
// (undefined, null and '' alike).
var syncSame = function(a, b) {
    return a === b || (a === undefined || a === null ? '' : String(a)) === (b === undefined || b === null ? '' : String(b));
};
$.eventInfoSame = function(info, ev) {
    var same = syncSame;
    return same(info[1], ev._x) && same(info[2], ev._y) && same(info[3], ev._direction) &&
        same(info[4], ev._characterName) && same(info[5], ev._characterIndex) && same(info[6], ev._pattern) &&
        same(info[7], ev._tileId) && same(info[8], ev._opacity) && info[9] === (ev._transparent ? 1 : 0) &&
        info[10] === (ev._erased ? 1 : 0) && same(info[11], ev._priorityType) && info[12] === (ev._through ? 1 : 0) &&
        same(info[13], ev.realMoveSpeed());
};

// The host's / a sub-host's sync: [$.eventInfo] of the events that changed
// since the last one, the taken characters' NPCs hidden first (hostSync did
// that before it). $.lastEventKeys: event id -> its last sent info ({}: send
// every event again). No arrays or strings for an event that did not change
// (lag audit 4: the old key was info.join(',') for every event every sync).
$.lastEventN = 0; // events in $.lastEventKeys
$.syncEvents = function(hideNpcs) {
    var re = hideNpcs ? $.takenNpcPrep() : null;
    var checkAll = !!re && $.takenNpcFor !== $gameMap._events;
    if (checkAll) $.selectMovedCache = null;
    var last = $.lastEventKeys, list = $.eventsOf($gameMap._events), changed = [], n = 0, added = 0;
    for (var i = 0; i < list.length; i++) {
        var ev = list[i];
        n++;
        var id = ev.eventId(), info = last[id];
        if (checkAll) $.hideTakenNpc(ev, re);
        if (info && $.eventInfoSame(info, ev)) continue;
        if (re && !checkAll) {
            $.hideTakenNpc(ev, re);
            if (info && $.eventInfoSame(info, ev)) continue;
        }
        if (!info) added++;
        info = $.eventInfo(ev);
        last[info[0]] = info;
        changed.push(info);
    }
    if (checkAll) $.takenNpcFor = $gameMap._events;
    // events gone since the last sync (a spawned one removed): forget them
    if ($.lastEventN + added !== n) {
        var keep = {};
        for (var j = 0; j < list.length; j++) {
            if (last[list[j].eventId()]) keep[list[j].eventId()] = last[list[j].eventId()];
        }
        $.lastEventKeys = keep;
    }
    $.lastEventN = n;
    return changed;
};

// Every event's info (a guest asked for the whole state): after $.syncEvents
// the last sent ones are every event as it is now.
$.allEventInfo = function() {
    var out = [];
    $gameMap.events().forEach(function(ev) { out.push($.lastEventKeys[ev.eventId()] || $.eventInfo(ev)); });
    return out;
};

$.hostSync = function() {
    if ($.clients.length === 0) return;
    $.updatePicking();
    var events = $.syncEvents(true); // (and the taken characters' NPCs hidden)
    var pres = $.presentationDelta();
    var said = $.messageInfo(), saidKey = said ? JSON.stringify(said) : '';
    var players = [$.playerInfo('host')];
    $.clients.forEach(function(c) {
        if (c.lastPos) players.push(c.lastPos);
    });
    var full = null;
    $.clients.forEach(function(c) {
        var msg = {
            t: 'state',
            mapId: $gameMap.mapId(),
            ev: events,
            pl: players.filter(function(p) { return p.id !== c.guestId; }),
            scr: pres.scr,
            pic: pres.pic,
            au: pres.au,
            msg: pres.msg
        };
        if ($.resyncDue(c)) full = $.withFullState(msg, full || $.fullState($.allEventInfo()));
        $.hearMessage(c, msg, said, saidKey);
        c.send(msg);
    });
};

//-----------------------------------------------------------------------------
// Resync: a guest that dropped states asks for everything again
//-----------------------------------------------------------------------------
// The sync above sends only what changed, with keys shared by all guests. A
// thin guest drops the states that come while it waits for a snapshot, loads
// a map, or is in its own fight or a joined one (FH_CoopBattle): what changed
// then never came again (docs/조사(보관용)/검수/최종검토_B 1, D 1: the white or black
// screen after a dream, an enemy erased during its fight still standing, a
// shared line it should answer that it never saw - the host waited for good).
// When its map is up again (map scene start, the fight over, a world swapped
// in place) it asks; the host sends that guest alone the whole state once
// (events, screen, pictures, music, the shared message). At most once a
// second per guest; the guest asks at most once a second too, so nothing can
// loop: a full state never makes it ask again.
$.RESYNC_MIN_MS = 1000; // (real time, $.clockMs)

$.nowMs = function() {
    return $.clockMs ? $.clockMs() : Date.now();
};

// Host (or sub-host): this connection gets the whole state with this sync.
$.resyncDue = function(c) {
    if (!c || !c._fhResyncWant) return false;
    var now = $.nowMs();
    if (c._fhResyncAt && now - c._fhResyncAt < $.RESYNC_MIN_MS) return false;
    $.dlog('resync for', c.name, '(' + c._fhResyncWant + ')');
    c._fhResyncWant = null;
    c._fhResyncAt = now;
    return true;
};

$.fullState = function(allEvents) {
    var pics = [];
    for (var id = 1; id <= $gameScreen.maxPictures(); id++) {
        pics.push([id, $.pictureInfo($gameScreen.picture(id))]);
    }
    return { ev: allEvents, scr: $.screenInfo(), pic: pics, au: $.audioInfo(), msg: $.messageInfo() };
};

$.withFullState = function(msg, full) {
    msg.ev = full.ev;
    msg.scr = full.scr;
    msg.pic = full.pic;
    msg.au = full.au;
    msg.msg = full.msg;
    msg.full = 1;
    return full;
};

$.hostHandlers = $.hostHandlers || {};
$.hostHandlers.resync = function(conn, msg) {
    conn._fhResyncWant = String(msg && msg.why || 'asked').slice(0, 40);
};

// Guest: ask (now, or once the last ask is a second old).
$.resyncAskedAt = 0;
$.resyncAskDue = null;
$.askResync = function(why) {
    if (!$.conn || !$.isThin() || $.solo) return;
    var now = $.nowMs();
    if ($.resyncAskedAt && now - $.resyncAskedAt < $.RESYNC_MIN_MS) {
        $.resyncAskDue = why;
        return;
    }
    $.resyncAskDue = null;
    $.resyncAskedAt = now;
    $.conn.send({ t: 'resync', why: why });
};

// The last screen of a state the guest dropped (newer than the snapshot it
// waited for: an older one goes when the next snapshot arrives). Put on the
// screen once the map takes states again (on the same map), unless that
// state has a newer one or this guest's own event (or effect) has the screen.
$.droppedScr = null; // { s: scr, m: map id }
$.keepDroppedScr = function(msg, force) {
    if (msg && msg.scr && (force || $.isThin())) $.droppedScr = { s: msg.scr, m: msg.mapId };
};

// This guest's own event runs on the host (its tints, fades, pictures and
// music come from there), a personal message is up, or its own effects run
// on this PC (FH_CoopWorld fxRuns: the static, the heartbeat).
$.ownScreenBusy = function() {
    return !!$.myEventRunning || !!$.pm || !!($.fxRuns && $.fxRuns.length);
};

//=============================================================================
// Guest
//=============================================================================

$.join = function(address, onFail) {
    var socket = net.connect($.port, address);
    var opened = false;
    socket.on('connect', function() {
        opened = true;
        $.role = 'guest';
        $.conn.send({ t: 'hello', name: $.myName, v: $.modVersion, h: $.modHash });
        $.refreshHud();
        $.toast('Co-op: connected, waiting for the host');
    });
    var conn = $.conn = new Connection(socket, $.onGuestMessage, function() {
        if (conn.leftOnPurpose) return; // leaveAsGuest closed it and said why
        $.conn = null;
        if (!opened) {
            if (onFail) onFail();
            return;
        }
        $.leaveAsGuest('Co-op: disconnected from host');
    });
};

$.leaveAsGuest = function(message) {
    if ($.dropTutorialSeatLocal) $.dropTutorialSeatLocal();
    $.role = null;
    $.solo = null;
    $.myActorId = 0;
    $.picking = false;
    $.remotes = {};
    $.roster = [];
    $.pendingSnapshot = null;
    $.resetGuestShared();
    if ($.conn) {
        $.conn.leftOnPurpose = true;
        $.conn.close();
    }
    $.conn = null;
    $.refreshWindowTitle();
    $.toast(message);
    SceneManager.goto(Scene_Title);
};

// A guest's Game End -> To Title leaves the session. Before, the title came
// up still connected with its commands off - nothing left but closing the
// game - and the host kept that player "in the game" (a bed vote, the
// tournament waited for it; 0.4 review C bug 4). A re-join under the same
// name brings its character back.
var _commandToTitleGuest = Scene_GameEnd.prototype.commandToTitle;
Scene_GameEnd.prototype.commandToTitle = function() {
    if (!$.isGuest()) {
        _commandToTitleGuest.call(this);
        return;
    }
    $.dlog('left the session (Game End - To Title)');
    // what its menu changed goes to the host first (no menu close follows)
    try {
        if ($.isRoaming && $.isRoaming()) {
            if ($.flushWorldGuest) $.flushWorldGuest();
            if ($.sendRoamMe) $.sendRoamMe(true);
        } else if ($.isThin() && $.returningFromSubScene && $.sendSyncMe) {
            $.sendSyncMe();
        }
    } catch (e) {
        $.dlog('ERROR leaving', e.stack || String(e));
    }
    $.returningFromSubScene = false;
    var conn = $.conn;
    if (conn && conn.endGently) conn.close = conn.endGently; // (what was just sent reaches the host)
    this.fadeOutAll();
    $.leaveAsGuest('Co-op: you left the session');
};

$.onGuestMessage = function(conn, msg) {
    switch (msg.t) {
    case 'versionMismatch':
        $.dlog('version mismatch: host', msg.host, 'me', msg.guest);
        $.leaveAsGuest('Co-op: different mod version - host ' + msg.host + ', yours ' + msg.guest +
            '. Install the same version on both PCs.');
        break;
    case 'welcome':
        $.myId = msg.id;
        break;
    case 'ping': // (the host asks whether this connection is still there)
        if ($.conn) $.conn.send({ t: 'pong' });
        break;
    case 'nameTaken':
        $.dlog('refused: the name is taken', msg.name);
        $.leaveAsGuest('Co-op: a player named "' + String(msg.name || $.myName) + '" is already in this session. ' +
            'Each player needs a different name (Steam name, or Windows user name for IP play).');
        break;
    case 'sessionFull':
        $.dlog('refused: the session is full');
        $.leaveAsGuest('Co-op: Session is full (' + (Number(msg.max) || $.MAX_PLAYERS) + ' players max).');
        break;
    case 'snap':
        $.pendingSnapshot = msg;
        break;
    case 'state':
        $.applyState(msg);
        break;
    case 'roster':
        $.roster = msg.list || [];
        $.refreshPanel();
        break;
    case 'msgStep':
        $.onMsgStep(msg);
        break;
    case 'pickTurn':
        $.pickList = msg.list;
        $.picking = true;
        break;
    case 'pickWait':
        $.toast(msg.why === 'host' ?
            'Co-op: the host is choosing a character first' :
            'Co-op: another player is choosing a character');
        break;
    case 'tutorialStart': // (before 'assign': its tutorial starts there)
        $.tutorialStartSnap = msg.data;
        break;
    case 'hostAtExit':
        $.hostWaitingAtExit = true;
        if ($.solo) $.toast('Co-op: the host is waiting at the train exit');
        break;
    case 'assign':
        $.dlog('assigned actor', msg.id, 'solo', msg.solo);
        $.myActorId = msg.id;
        $.picking = false;
        $.hostWaitingAtExit = !!msg.hostAtExit;
        if (msg.solo) $.startSolo(msg.inv);
        if ($gamePlayer) $gamePlayer.refresh();
        $.toast('Co-op: you play ' + $dataActors[msg.id].name);
        break;
    case 'lobby':
        $.remotes = {};
        $.pendingSnapshot = null;
        // the next game assigns (or asks) again, and plays its own intro
        $.myActorId = 0;
        $.solo = null;
        $.picking = false;
        if ($.dropTutorialSeatLocal) $.dropTutorialSeatLocal();
        if (!(SceneManager._scene instanceof Scene_Title)) SceneManager.goto(Scene_Title);
        $.toast('Co-op: waiting for the host');
        break;
    }
};

// Called every frame from the current scene so the scene change happens on
// the game loop, not inside a socket callback.
$.processPendingSnapshot = function() {
    var snap = $.pendingSnapshot;
    if (!snap) return;
    $.pendingSnapshot = null;
    $.solo = null; // back to the shared game
    $.hostWaitingAtExit = false;
    $.dlog('apply snapshot, map', snap.mapId);
    // The world as the host first entered the intro: a guest that picks
    // late still starts its own tutorial from there.
    if (snap.mapId === 155) $.tutorialStartSnap = null;
    if (snap.mapId === 19 && !$.tutorialStartSnap) $.tutorialStartSnap = snap.data;
    var inPlace = $.canSwapInPlace(snap.mapId);
    DataManager.createGameObjects();
    DataManager.extractSaveContents($.parseSnapshot(snap.data));
    $.remotes = {};
    $.lastEventKeys = {};
    // A snapshot taken while the host was on its way to another map carried
    // that transfer: the new map scene would carry it out for this guest.
    $gamePlayer.clearTransferInfo();
    $gamePlayer.refresh();
    // The snapshot carries the host's player flags; the guest's own avatar
    // should always be visible.
    $gamePlayer.setTransparent(false);
    // The snapshot's player speed is the host's; keep this guest's own
    // (its speed event only runs where this PC runs the map).
    if ($.ownMoveSpeed) $gamePlayer.setMoveSpeed($.ownMoveSpeed);
    $.resetGuestShared(); // the host sends its dialogue (or none) again
    if (inPlace) $.swapInPlace(); else SceneManager.goto(Scene_Map);
};

// The same map already on screen: swap the world in without reopening the
// map scene (no map file load, no fade, no new windows). Only the map's
// sprites are built again, for the new event and player objects.
$.SWAP_IN_PLACE = true;
$.canSwapInPlace = function(mapId) {
    var s = SceneManager._scene;
    return $.SWAP_IN_PLACE && s instanceof Scene_Map && s.isActive() && !SceneManager.isSceneChanging() &&
        !!s._spriteset && !!$dataMap && !!$gameMap && $gameMap.mapId() === mapId && $.dataMapId === mapId &&
        !$gamePlayer.isTransferring();
};

$.swapInPlace = function() {
    var s = SceneManager._scene;
    if ($gameMap._fhEv) $.expandEvents();
    var old = s._spriteset;
    var index = s.children.indexOf(old);
    s.removeChild(old);
    s.createSpriteset();
    if (index >= 0) {
        s.removeChild(s._spriteset);
        s.addChildAt(s._spriteset, index); // under the windows, as before
    }
    // the message window belonged to the old $gameMessage
    var win = s._messageWindow;
    if (win) {
        win._textState = null;
        win.pause = false;
        win.openness = 0;
        if (win._choiceWindow) {
            win._choiceWindow.deactivate();
            win._choiceWindow.openness = 0;
        }
    }
    $gamePlayer.refresh();
    $gameMap.requestRefresh();
    $.dlog('world swapped in place, map', $gameMap.mapId());
    $.askResync('snapshot');
};

$.applyState = function(msg) {
    if (!$gameMap || $.pendingSnapshot) {
        $.keepDroppedScr(msg);
        return;
    }
    // The old map screen is fading out or the new one is not up yet: the
    // next state comes in a few frames (a message box built now breaks).
    // What changed meanwhile comes again with the resync the map scene asks.
    var scene = SceneManager._scene;
    if (SceneManager.isSceneChanging() || (scene instanceof Scene_Map && !scene.isActive())) {
        $.keepDroppedScr(msg);
        return;
    }
    if ($.solo) {
        // Own game on screen: only show the others' avatars.
        $.applyPlayers(msg.pl, msg.mapId);
        return;
    }
    if ($gameMap.mapId() !== msg.mapId) {
        if (!$.waitingSnap) {
            $.waitingSnap = true;
            $.conn.send({ t: 'needSnap' });
        }
        return;
    }
    $.waitingSnap = false;
    var dropped = $.droppedScr;
    $.droppedScr = null;
    if (dropped && !msg.scr && dropped.m === msg.mapId) {
        if ($.ownScreenBusy()) {
            if ($.noteHostScr) $.noteHostScr(dropped.s);
        } else {
            $.dlog('screen from a dropped state put back: tone', JSON.stringify(dropped.s.t), 'brightness', dropped.s.b);
            $.applyScreen(dropped.s);
        }
    }
    msg.ev.forEach($.applyEvent);
    // A whole state (a resync) while this guest's own event runs on the host
    // (or its own effects here): that event's tint, fade, pictures and music
    // stay (the host's look is noted for the screen safety net, FH_CoopRoam).
    var own = !!msg.full && $.ownScreenBusy();
    if (msg.scr) {
        if (own) {
            if ($.noteHostScr) $.noteHostScr(msg.scr);
        } else {
            $.applyScreen(msg.scr);
        }
    }
    if (msg.pic) {
        msg.pic.forEach(function(entry) {
            if (msg.full && !entry[1] && $.keepOwnPicture(entry[0], own)) return;
            $.applyPicture(entry);
        });
    }
    if (msg.au && !own) $.applyAudio(msg.au);
    if (msg.msg !== undefined) $.applyMessage(msg.msg);
    $.applyPlayers(msg.pl, msg.mapId);
};

// A resync's "no picture here": not over this player's own picture (one its
// running event showed here, one of its own effects while they run, its own
// heartbeat's). Others the host erased meanwhile go.
$.ownPicIds = {}; // guest: picture ids its event on the host showed (forwarded 231)
$.keepOwnPicture = function(id, own) {
    var pic = $gameScreen.picture(id);
    if (!pic || !pic.name()) return false;
    if ($.PERSONAL_PICTURES && $.PERSONAL_PICTURES[pic.name()]) return true;
    if (!own) return false;
    if ($.fxRuns && $.fxRuns.length) return true;
    return !!$.ownPicIds[id];
};

// Avatars of the others; only those standing on this map are drawn.
$.applyPlayers = function(list, hostMapId) {
    var seen = {};
    (list || []).forEach(function(p) {
        var mapId = p.m || hostMapId;
        if (mapId !== $gameMap.mapId()) return;
        seen[p.id] = true;
        $.applyRemote(p.id, p);
    });
    Object.keys($.remotes).forEach(function(id) {
        if (!seen[id]) delete $.remotes[id];
    });
};

$.applyScreen = function(scr) {
    var sc = $gameScreen;
    sc._brightness = scr.b;
    sc._fadeOutDuration = 0;
    sc._fadeInDuration = 0;
    sc.startTint(scr.t, $.syncInterval);
    sc._weatherType = scr.w[0];
    sc._weatherPower = scr.w[1];
    sc._weatherPowerTarget = scr.w[1];
    sc._weatherDuration = 0;
};

$.applyPicture = function(entry) {
    var id = entry[0], p = entry[1];
    if (!p) {
        $gameScreen.erasePicture(id);
        return;
    }
    var pic = $gameScreen.picture(id);
    if (!pic || pic.name() !== p[0]) {
        $gameScreen.showPicture(id, p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7]);
        pic = $gameScreen.picture(id);
    } else {
        // Glide to the host's values over one sync period.
        pic._origin = p[1];
        pic._targetX = p[2];
        pic._targetY = p[3];
        pic._targetScaleX = p[4];
        pic._targetScaleY = p[5];
        pic._targetOpacity = p[6];
        pic._blendMode = p[7];
        pic._duration = $.syncInterval;
    }
    pic._angle = p[8];
    pic._rotationSpeed = 0;
    pic._tone = p[9];
    pic._toneDuration = 0;
};

$.applyAudio = function(au) {
    if (au.bgm) AudioManager.playBgm(au.bgm); else AudioManager.stopBgm();
    if (au.bgs) AudioManager.playBgs(au.bgs); else AudioManager.stopBgs();
};

// Read-only mirror of the host's message box.
$.applyMessage = function(m) {
    var scene = SceneManager._scene;
    var win = scene && scene._messageWindow;
    var view = m ? Object.assign({}, m) : null;
    if (view) delete view.owner;
    var key = view ? JSON.stringify(view) : '';
    if (m) {
        $.guestMsgOwner = m.owner;
        $.guestMsgShared = true;
        if (key === $.guestMsgKey) {
            if (win && win._choiceWindow) $.syncGuestChoiceInput(win._choiceWindow);
            return;
        }
    } else {
        $.guestMsgOwner = null;
        $.guestMsgShared = false;
    }
    if (key === $.guestMsgKey) return;
    $.guestMsgKey = key;
    // the host's scroll text is over (it may have sped it up): this one too
    var stw = scene && scene._scrollTextWindow;
    if (stw instanceof Window_ScrollText && stw._text && !(m && m.sc)) {
        stw._text = null;
        stw.hide();
    }
    if (win && win._choiceWindow && win._choiceWindow.isOpen()) $.closeGuestChoice(win);
    if (win && ($gameMessage.hasText() || win._textState)) {
        win._textState = null;
        win.pause = false;
        win.terminateMessage();
    } else {
        $gameMessage.clear();
    }
    $.guestVoted = false;
    $.guestStep = 0;
    if (!m) return;
    $.guestMsgId = m.id;
    $gameMessage.setFaceImage(m.f, m.fi);
    $gameMessage.setBackground(m.bg);
    $gameMessage.setPositionType(m.p);
    m.tx.forEach(function(line) { $gameMessage.add(line); });
    if (m.sc) $gameMessage.setScroll(m.sc[0], m.sc[1]); // (Window_ScrollText shows it, not the message box)
    if (m.ch && m.ch.length) $gameMessage.setChoices(m.ch, m.dt, m.ct);
    if (win && win._choiceWindow) $.syncGuestChoiceInput(win._choiceWindow);
};

// Tiles between two spots for walking: a diagonal step (VE_DiagonalMovement)
// is one step, so it walks there instead of jumping.
$.stepDistance = function(x1, y1, x2, y2) {
    return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2));
};

$.applyEvent = function(info) {
    var ev = $gameMap.event(info[0]);
    if (!ev) return;
    var x = info[1], y = info[2];
    if ($.stepDistance(ev._x, ev._y, x, y) > 1) {
        ev.setPosition(x, y);
    } else {
        if (ev._x !== x || ev._y !== y) ev.resetStopCount();
        ev._x = x;
        ev._y = y;
    }
    ev._direction = info[3];
    ev._characterName = info[4];
    ev._characterIndex = info[5];
    if (!ev.isMoving()) ev._pattern = info[6];
    ev._tileId = info[7];
    ev._opacity = info[8];
    ev._transparent = !!info[9];
    ev._erased = !!info[10];
    ev._priorityType = info[11];
    ev._through = !!info[12];
    ev._moveSpeed = info[13];
};

$.guestSync = function() {
    if (!$.conn) return;
    $.conn.send({ t: 'pos', p: $.playerInfo($.myId) });
};

//=============================================================================
// Remote player avatar
//=============================================================================

function Game_RemotePlayer() {
    this.initialize.apply(this, arguments);
}

Game_RemotePlayer.prototype = Object.create(Game_Character.prototype);
Game_RemotePlayer.prototype.constructor = Game_RemotePlayer;

Game_RemotePlayer.prototype.initialize = function() {
    Game_Character.prototype.initialize.call(this);
    this.setThrough(true);
    this._placed = false;
    this._fhTutorialSeat = false;
    this._fhTutorialSeatMirror = false;
};

// The character a player sits as on the train, 0 before it is picked. This
// PC's own: the host's selection, the guest's assignment. Another player:
// the roster (the host's list; the actor a guest PC sends is its party
// leader until it picks), the host also by what its PC sends.
$.tutorialSeatActor = function(id, sentActor) {
    id = String(id);
    var ownId = $.isHost() ? 'host' : String($.myId || '');
    if (id === ownId) {
        if ($.isHost()) return $.hostHasChosen() ? Number($.hostActorId()) || 0 : 0;
        return Number($.myActorId) || 0;
    }
    var entry = ($.roster || []).filter(function(r) { return String(r.id) === id; })[0];
    var actorId = entry ? Number(entry.a) || 0 : 0;
    if (!actorId && id === 'host') {
        var shown = $.remotes && $.remotes.host;
        actorId = Number(sentActor) || (shown ? Number(shown._actorId) || 0 : 0);
    }
    return actorId;
};

// Reserve a distinct visual seat for each co-op slot. Coordinates mirror the
// train layout; only the remote character's rendering is moved.
$.tutorialSeatForRemote = function(p) {
    if (!p || !$.TUTORIAL_MAPS || !$gameMap || !$gamePlayer || !$gameVariables ||
            $.tutorialOver() || ($gameSwitches && $gameSwitches.value(2864))) return null;
    var mapId = $gameMap.mapId();
    // Map014 has a native character seat at (26,18), which collides with the
    // current remote-seat layout. Keep the tested intro spawn on Map019 only.
    if (mapId !== 19) return null;
    if (p.m !== mapId) return null;
    var near = Math.abs(p.x - $gamePlayer.x) + Math.abs(p.y - $gamePlayer.y) <= 3;
    if (!near) return null;
    // A player who has not picked yet has no seat (it stands as it is): its
    // own PC drew it as the party leader then (the host's character, 0.41
    // play test), the other PC by the roster - two different seats.
    var actorId = $.tutorialSeatActor(p.id, p.a);
    var image = { 1: 'mercenary', 3: 'occultist', 4: 'doctor', 5: 'mechanic_alt',
        6: 'yellow_mage', 13: 'thug', 14: 'journalist', 15: 'botanist' }[actorId];
    if (!image) return null;
    // Guest IDs keep increasing across disconnects, so map active players to
    // seats by roster order instead of assuming the IDs stop at g3.
    var rosterIds = ($.roster || []).map(function(r) { return String(r.id); });
    if (rosterIds.indexOf('host') < 0) rosterIds.unshift('host');
    var slot = rosterIds.indexOf(String(p.id));
    if (slot < 0) {
        var knownSlot = { g1: 1, g2: 2, g3: 3 }[String(p.id)];
        if (knownSlot !== undefined) slot = knownSlot;
    }
    if (slot < 0 || slot >= $.MAX_PLAYERS) return null;
    var inSeatArea = p.y >= 17 && p.y <= 19 && $gamePlayer.y >= 17 && $gamePlayer.y <= 19 &&
        p.x >= 37 && p.x <= 43 && $gamePlayer.x >= 37 && $gamePlayer.x <= 43;
    if (!inSeatArea) return null;

    // Map 019 has two seats on either side of the aisle. The host keeps its
    // character's own seat (EV223 at 41: Levi, Marina, Daan, Abella; EV70 at
    // 42: O'saa, Olivia, Marcoh, Karin), the third player the other one on
    // that side, the second and fourth 38 and 37 across the aisle. Only the
    // slot (connection order) and the host's character count, so every PC
    // puts everyone on the same seat (before, the first guest's character
    // moved the others, and a guest not picked yet counted as the leader).
    var hostSeat = [6, 13, 14, 15].indexOf($.tutorialSeatActor('host')) >= 0 ? 42 : 41;
    var x = [hostSeat, 38, hostSeat === 41 ? 42 : 41, 37][slot];
    var direction = 2;
    if ($gameSwitches) {
        if ($gameSwitches.value(2863)) direction = 8;
        else if ($gameSwitches.value(2862)) direction = 6;
        else if ($gameSwitches.value(2861)) direction = 4;
    }
    return { x: x, y: 18, image: image, actorId: actorId, direction: direction, mirror: slot === 1 || slot === 3 };
};

// The local player's seat (Codex 2026-10-23; review 0.41 M2): only sprites
// are hidden (the player's, the map's own seat event of that character) and
// shown again; the game state ($gamePlayer / event transparency, Terrax's
// flashlight) is never changed. Before, the end of the intro (Map019 EV224:
// SW2864 on and 211 [1] in one frame) was undone by putting back the
// transparency saved at its start: the host stayed invisible for everyone.
$.tutorialSeatLocalState = null; // { id, actorId, x, y, sprites: [hidden Sprite_Character] }
$.tutorialSeatLocalCharacter = null;
$.tutorialSeatLocalSprite = null;
$.tutorialSeatLocalForPlayer = function() {
    if (!$.role || !$gameMap || !$gamePlayer || !$gameParty || !$gameParty.leader()) return null;
    if ($gameMap.mapId() !== 19 || $.tutorialOver() || ($gameSwitches && $gameSwitches.value(2864))) return null;
    // This is the initial history prompt spawn. The engine keeps the player's
    // logical position here while Map019 draws their seated event separately.
    if ($gamePlayer.x !== 40 || $gamePlayer.y !== 18) return null;
    var id = $.isHost() ? 'host' : ($.myId || 'g1');
    var seat = $.tutorialSeatForRemote($.playerInfo(id));
    if (!seat) return null;
    return seat;
};

$.tutorialSeatLocalEvent = function(seat) {
    if (!$gameMap || $gameMap.mapId() !== 19) return null;
    var candidates = [70, 223];
    for (var i = 0; i < candidates.length; i++) {
        var event = $gameMap.event(candidates[i]);
        if (event && !event._erased && event._characterName === seat.image && event._characterIndex === 2) return event;
    }
    return null;
};

// the sprite of a character in this spriteset
$.tutorialSeatSpriteOf = function(spriteset, character) {
    var list = spriteset && spriteset._characterSprites || [];
    for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i]._character === character) return list[i];
    }
    return null;
};

$.tutorialSeatHide = function(sprite) {
    var state = $.tutorialSeatLocalState;
    if (!sprite || !state) return;
    if (state.sprites.indexOf(sprite) < 0) state.sprites.push(sprite);
    if (sprite.hide) sprite.hide(); // (Sprite_Base: stays hidden while the sprite updates)
    sprite.visible = false;
};

// The seat ends: the hidden sprites show what the game says again.
$.restoreTutorialSeatLocalDisplay = function() {
    var state = $.tutorialSeatLocalState;
    if (!state) return;
    state.sprites.forEach(function(sprite) {
        if (sprite.show) sprite.show();
        if (sprite._character) sprite.visible = !sprite._character.isTransparent();
    });
    $.dlog('tutorial local seat restored', state.id, state.actorId, state.x, state.y);
    $.dropTutorialSeatLocal();
};

// A load, the title, a new game, leaving: the old spriteset's sprites are
// gone; nothing is put back (nothing of the game was changed).
$.dropTutorialSeatLocal = function() {
    if ($.tutorialSeatLocalSprite && $.tutorialSeatLocalSprite.parent) {
        $.tutorialSeatLocalSprite.parent.removeChild($.tutorialSeatLocalSprite);
    }
    $.tutorialSeatLocalSprite = null;
    $.tutorialSeatLocalCharacter = null;
    $.tutorialSeatLocalState = null;
};

$.updateTutorialSeatLocalDisplay = function(spriteset) {
    var seat = $.tutorialSeatLocalForPlayer();
    if (!seat || !spriteset || !spriteset._tilemap) {
        $.restoreTutorialSeatLocalDisplay();
        return;
    }
    var state = $.tutorialSeatLocalState;
    if (state && state.spriteset !== spriteset) {
        $.dropTutorialSeatLocal(); // (a new map scene)
        state = null;
    }
    if (!state) {
        state = $.tutorialSeatLocalState = { id: $.isHost() ? 'host' : ($.myId || 'g1'), actorId: seat.actorId,
            x: seat.x, y: seat.y, sprites: [], spriteset: spriteset };
        $.dlog('tutorial local seat', state.id, state.actorId, 'at', $gamePlayer.x, $gamePlayer.y, '->', seat.x, seat.y);
    } else if (state.actorId !== seat.actorId) {
        $.dlog('tutorial local seat actor changed', state.id, state.actorId, '->', seat.actorId);
        state.actorId = seat.actorId;
        state.x = seat.x;
        state.y = seat.y;
    }
    var nativeSeat = $.tutorialSeatLocalEvent(seat);
    if (nativeSeat) $.tutorialSeatHide($.tutorialSeatSpriteOf(spriteset, nativeSeat));
    $.tutorialSeatHide($.tutorialSeatSpriteOf(spriteset, $gamePlayer));

    if (!$.tutorialSeatLocalCharacter) {
        var character = $.tutorialSeatLocalCharacter = new Game_Character();
        character.setThrough(true);
        character.setPriorityType(1);
        character.setWalkAnime(false);
        character.setStepAnime(false);
        character.setDirectionFix(true);
    }
    var c = $.tutorialSeatLocalCharacter;
    if (c.x !== seat.x || c.y !== seat.y) c.locate(seat.x, seat.y);
    if (c._characterName !== seat.image || c._characterIndex !== 2) c.setImage(seat.image, 2);
    c.setDirectionFix(false);
    c.setDirection(seat.direction);
    c.setDirectionFix(true);
    c.setPattern(1);
    c.setTransparent(false);
    if (!$.tutorialSeatLocalSprite || $.tutorialSeatLocalSprite.parent !== spriteset._tilemap) {
        if ($.tutorialSeatLocalSprite && $.tutorialSeatLocalSprite.parent) {
            $.tutorialSeatLocalSprite.parent.removeChild($.tutorialSeatLocalSprite);
        }
        $.tutorialSeatLocalSprite = new Sprite_Character(c);
        spriteset._tilemap.addChild($.tutorialSeatLocalSprite);
    }
    $.tutorialSeatLocalSprite.scale.x = seat.mirror ? -1 : 1;
};

var _setupNewGameSeat = DataManager.setupNewGame;
DataManager.setupNewGame = function() {
    $.dropTutorialSeatLocal();
    _setupNewGameSeat.call(this);
};

var _loadGameSeat = DataManager.loadGame;
DataManager.loadGame = function(savefileId) {
    $.dropTutorialSeatLocal();
    return _loadGameSeat.call(this, savefileId);
};

Game_RemotePlayer.prototype.setTarget = function(p) {
    if (!this._placed || $.stepDistance(this._x, this._y, p.x, p.y) > 1) {
        this.setPosition(p.x, p.y);
        this._placed = true;
    } else {
        if (this._x !== p.x || this._y !== p.y) this.resetStopCount();
        this._x = p.x;
        this._y = p.y;
    }
    this._direction = p.d;
    // speed changes go to the log (to compare players' speeds after a session)
    if (this._moveSpeed !== p.s && this._placed) $.dlog('speed', p.id, this._moveSpeed, '->', p.s);
    this._moveSpeed = p.s;
    this._playerId = p.id;
    this._actorId = Number(p.a) || (($.roster || []).filter(function(r) { return r.id === p.id; })[0] || {}).a || 0;
    var seat = $.tutorialSeatForRemote(p);
    if (!seat && p.m === 19 && p.m === $gameMap.mapId() && p.y >= 17 && p.y <= 19) { // (the train seats only)
        var check = [p.id, p.a || this._actorId, p.x, p.y, $gamePlayer.x, $gamePlayer.y, $.tutorialOver() ? 1 : 0].join(':');
        if (this._fhSeatCheckKey !== check) {
            this._fhSeatCheckKey = check;
            $.dlog('tutorial seat skipped', check);
        }
    }
    if (seat) {
        this._fhSeatCheckKey = null;
        this.locate(seat.x, seat.y);
        // The intro seat sprites are index 2 in each actor's character sheet.
        if (this._characterName !== seat.image || this._characterIndex !== 2) this.setImage(seat.image, 2);
        this._direction = seat.direction;
        this._pattern = 1;
        this.setDirectionFix(true);
        this.setWalkAnime(false);
        this.setStepAnime(false);
        this._transparent = false;
        this._fhTutorialSeat = true;
        this._fhTutorialSeatMirror = seat.mirror;
    } else {
        if (this._fhTutorialSeat) {
            this.setDirectionFix(false);
            this.setWalkAnime(true);
            this.setStepAnime(false);
            this._fhTutorialSeat = false;
        }
        this._fhTutorialSeatMirror = false;
        // Cutscenes hide the player (e.g. the intro shows a seated event instead).
        this._transparent = !!p.tr;
        // a record without a character keeps the old look (setImage threw on
        // it in the socket handler: the whole state was lost - flow tests L-2a)
        var index = Number(p.i) || 0;
        if (typeof p.n === 'string' && (this._characterName !== p.n || this._characterIndex !== index)) {
            this.setImage(p.n, index);
        }
    }
};

Game_RemotePlayer.prototype.info = function(id) {
    return {
        id: id, x: this._x, y: this._y, d: this._direction,
        s: this._moveSpeed, n: this._characterName, i: this._characterIndex,
        tr: this._transparent ? 1 : 0
    };
};

$.Game_RemotePlayer = Game_RemotePlayer;

$.applyRemote = function(id, p) {
    if (!p) return;
    var remote = $.remotes[id];
    if (!remote) remote = $.remotes[id] = new Game_RemotePlayer();
    remote.setTarget(p);
};

var _Spriteset_Map_update = Spriteset_Map.prototype.update;
Spriteset_Map.prototype.update = function() {
    _Spriteset_Map_update.call(this);
    this.updateFHCoopRemotes();
};

// Runs every frame, also in plain single-player: no per-frame allocations.
Spriteset_Map.prototype.updateFHCoopRemotes = function() {
    $.updateTutorialSeatLocalDisplay(this);
    if (!this._tilemap) return;
    var sprites = this._fhRemoteSprites;
    var id;
    if (!sprites) {
        for (id in $.remotes) break;
        if (id === undefined) return; // nobody to draw
        sprites = this._fhRemoteSprites = {};
    }
    for (id in $.remotes) {
        var remote = $.remotes[id];
        if (!sprites[id] || sprites[id]._character !== remote) {
            if (sprites[id]) this._tilemap.removeChild(sprites[id]);
            sprites[id] = new Sprite_Character(remote);
            this._tilemap.addChild(sprites[id]);
        }
        sprites[id].scale.x = remote._fhTutorialSeat && remote._fhTutorialSeatMirror ? -1 : 1;
    }
    for (id in sprites) {
        if ($.remotes[id]) continue;
        this._tilemap.removeChild(sprites[id]);
        delete sprites[id];
    }
};

// A host snapshot replaces $gameMap while the old Scene_Map still updates
// (fading out); its GALV layer sprites then find no settings for their id
// and throw. Drop those sprites first (the classes are private to GALV).
// Battle layers read $gameSystem._bLayers: CE66 (AFTER BATTLE) clears them
// with Galv.LG.bLayer(1/2), and in co-op another player's fight can end
// (its event goes on here) while this PC is still in its own battle. Each
// sprite asks its own settings (lValue: map or battle), so both are covered.
$.dropOrphanLayers = function(spriteset) {
    var layers = spriteset.layerGraphics;
    if (!layers) return;
    for (var id in layers) {
        var s = layers[id];
        var config;
        try {
            config = s && s.lValue ? s.lValue() : null;
        } catch (e) {
            config = null;
        }
        if (config) continue;
        if (s && s.parent) s.parent.removeChild(s);
        delete layers[id];
        $.dlog('layer sprite without settings dropped', id, spriteset instanceof Spriteset_Battle ? 'battle' : 'map',
            $gameMap ? $gameMap.mapId() : 0);
    }
};

var _Spriteset_Map_update_layers = Spriteset_Map.prototype.update;
Spriteset_Map.prototype.update = function() {
    $.dropOrphanLayers(this);
    _Spriteset_Map_update_layers.call(this);
};

var _Spriteset_Battle_update_layers = Spriteset_Battle.prototype.update;
Spriteset_Battle.prototype.update = function() {
    $.dropOrphanLayers(this);
    _Spriteset_Battle_update_layers.call(this);
};

// "LAYER REFRESH" rebuilds the current scene's layers: a guest's event on
// the host can run it while the host is in a menu (no spriteset: TypeError)
// or in battle (the battle spriteset is not the map's). The map scene builds
// its layers when it opens again.
if (typeof Galv !== 'undefined' && Galv.LG && Galv.LG.createLayer) {
    var _galvCreateLayer = Galv.LG.createLayer;
    Galv.LG.createLayer = function(config) {
        if (config && config[0] === 'REFRESH') {
            var scene = SceneManager._scene;
            if (!scene || !(scene._spriteset instanceof Spriteset_Map)) {
                $.dlog('LAYER REFRESH skipped: no map on screen');
                return;
            }
        }
        _galvCreateLayer.call(this, config);
    };
}

//=============================================================================
// The visibility circle (GALV_VisibilityRange): a check
//=============================================================================
// (The "Co-op Fog" option is gone, user decision 2026-10-19: fog shows as in
// the original. An old config with fhCoopFog loads as before: unknown keys
// are not read.) What the user saw on a guest was the visibility circle
// around the player "jumping". The circle stands at $gamePlayer's screen
// spot, its size is V61, its strength V62, its picture $gameSystem.galvVis.
// A jump (it moves more than a tile in one frame on the same map and the
// same world, or its size or picture changes) goes to the log with what it
// followed, at most once a second.

$.VIS_JUMP_PX = 40;
$.visWatch = null;
$.visLoggedAt = -999;

$.watchVisibility = function(spriteset) {
    var r = spriteset && spriteset._galvVisRange;
    if (!$.role || !r || !$gamePlayer || !$gameMap) {
        $.visWatch = null;
        return;
    }
    var now = {
        x: Math.round(r.x), y: Math.round(r.y), z: $gameVariables.value(61), o: $gameVariables.value(62),
        img: $gameSystem.galvVis, px: $gamePlayer._realX, py: $gamePlayer._realY,
        dx: $gameMap._displayX, dy: $gameMap._displayY, m: $gameMap.mapId(), p: $gamePlayer, s: spriteset
    };
    var was = $.visWatch;
    $.visWatch = now;
    // a new map, world or screen: not a jump
    if (!was || was.m !== now.m || was.p !== now.p || was.s !== now.s || now.o <= 0) return;
    var moved = Math.abs(now.x - was.x) + Math.abs(now.y - was.y);
    if (moved <= $.VIS_JUMP_PX && now.z === was.z && now.img === was.img) return;
    if (Graphics.frameCount - $.visLoggedAt < 60) return;
    $.visLoggedAt = Graphics.frameCount;
    $.dlog('visibility circle jump:', JSON.stringify({
        circle: [was.x, was.y, '->', now.x, now.y], size: [was.z, now.z], strength: [was.o, now.o],
        picture: [was.img, now.img], player: [was.px, was.py, '->', now.px, now.py],
        scroll: [was.dx, was.dy, '->', now.dx, now.dy], map: now.m,
        zoom: $gameScreen ? [$gameScreen.zoomX(), $gameScreen.zoomY(), $gameScreen.zoomScale()] : null,
        thin: !!($.isThin && $.isThin()), roam: !!($.isRoaming && $.isRoaming()),
        ghost: !!($.isGhostMe && $.isGhostMe()), transfer: $gamePlayer.isTransferring()
    }));
};

// The circle shown is the one the state says ($gameSystem.galvVis). GALV
// makes or drops the sprite only when VISRANGE runs on the map screen or a
// map screen is made, so a world that came in without a new screen (a
// snapshot swapped in place) or a VISRANGE run off this screen could leave
// it missing or left over until the menu made a new screen (0.41 play test:
// a wrong circle after a guest's door, put right by opening the menu). The
// menu's fix, at once.
$.syncVisSprite = function(spriteset) {
    if (!$.role || !$gameSystem || !spriteset || !spriteset.doVisSprite || !spriteset._tilemap) return;
    var want = $gameSystem.galvVis && $gameSystem.galvVis !== 'X' ? $gameSystem.galvVis : null;
    if (!!want === !!spriteset._galvVisRange) return;
    $.dlog('vision: the circle was', spriteset._galvVisRange ? 'shown' : 'missing', 'while the state says',
        want || 'none', '- made again (map ' + ($gameMap ? $gameMap.mapId() : 0) + ')');
    spriteset.doVisSprite(want);
};

var _Spriteset_Map_update_vis = Spriteset_Map.prototype.update;
Spriteset_Map.prototype.update = function() {
    _Spriteset_Map_update_vis.call(this);
    $.syncVisSprite(this);
    $.watchVisibility(this);
};

//=============================================================================
// Scene hooks
//=============================================================================

var _Scene_Map_update = Scene_Map.prototype.update;
Scene_Map.prototype.update = function() {
    _Scene_Map_update.call(this);
    if (!$.role) return;
    Object.keys($.remotes).forEach(function(id) { $.remotes[id].update(); });
    if ($.isGuest()) $.processPendingSnapshot();
    if ($.isGuest()) this.updateFHCoopPick();
    if ($.isGuest()) this.updateFHCoopSolo();
    if ($.isHost()) $.updateChoiceVote();
    if (this._fhSnapshotDue && $.isHost()) {
        this._fhSnapshotDue = false;
        $.sendSnapshot();
    }
    if (++$.frame % $.syncInterval !== 0) return;
    if ($.isHost()) $.hostSync();
    if ($.isGuest()) $.guestSync();
};

Scene_Map.prototype.updateFHCoopPick = function() {
    if ($.picking && !this._fhPickWindow) {
        this._fhPickHelp = new Window_Help(1);
        this._fhPickHelp.setText('Co-op: choose your character');
        this._fhPickWindow = new Window_FHCoopPick();
        this._fhPickWindow.setHandler('pick', this.onFHCoopPick.bind(this));
        this.addWindow(this._fhPickHelp);
        this.addWindow(this._fhPickWindow);
    } else if (!$.picking && this._fhPickWindow) {
        this.closeFHCoopPick();
    }
};

Scene_Map.prototype.onFHCoopPick = function() {
    var id = this._fhPickWindow.currentExt();
    $.picking = false;
    this.closeFHCoopPick();
    if ($.conn) $.conn.send({ t: 'pick', id: id });
};

Scene_Map.prototype.closeFHCoopPick = function() {
    this._windowLayer.removeChild(this._fhPickWindow);
    this._windowLayer.removeChild(this._fhPickHelp);
    this._fhPickWindow = null;
    this._fhPickHelp = null;
};

function Window_FHCoopPick() {
    this.initialize.apply(this, arguments);
}

Window_FHCoopPick.prototype = Object.create(Window_Command.prototype);
Window_FHCoopPick.prototype.constructor = Window_FHCoopPick;

Window_FHCoopPick.prototype.initialize = function() {
    Window_Command.prototype.initialize.call(this, 0, 0);
    this.x = (Graphics.boxWidth - this.width) / 2;
    this.y = (Graphics.boxHeight - this.height) / 2;
};

Window_FHCoopPick.prototype.windowWidth = function() {
    return 420;
};

Window_FHCoopPick.prototype.makeCommandList = function() {
    $.pickList.forEach(function(entry) {
        var actor = $dataActors[entry.id];
        var cls = $dataClasses[actor.classId];
        var label = actor.name + (cls ? '  -  ' + cls.name : '');
        this.addCommand(label, 'pick', !entry.taken, entry.id);
    }, this);
};

var _Scene_Map_start = Scene_Map.prototype.start;
Scene_Map.prototype.start = function() {
    _Scene_Map_start.call(this);
    // Host just started/continued the game: bring the lobby guests in.
    if ($.isHost() && !$.hostInGame) {
        $.hostInGame = true;
        $.saveMode = $.SAVE_MODE_MULTIPLAYER;
        this._fhSnapshotDue = true;
    }
    // Guest: tell the host this map is on screen (it may hold its events).
    if ($.isGuest() && $.conn && !$.solo) $.conn.send({ t: 'mapReady', m: $gameMap.mapId() });
    // ... and everything that changed while it was not (see "Resync"); not
    // back from its menu or a shop: states were taken meanwhile (FH_CoopWorld)
    if ($.isGuest() && !$.returningFromSubScene) $.askResync('map');
    // Host: a new map was set up (transfer, battle return, load) -> resend.
    if ($.isHost() && $.snapshotQueued) {
        $.snapshotQueued = false;
        this._fhSnapshotDue = true;
    }
};

var _performTransfer = Game_Player.prototype.performTransfer;
Game_Player.prototype.performTransfer = function() {
    var changed = this.isTransferring() && this._newMapId !== $gameMap.mapId();
    _performTransfer.call(this);
    if ($.isHost() && changed) {
        $.remotes = {};
        $.snapshotQueued = true;
        if (SceneManager._scene instanceof Scene_Map) SceneManager._scene._fhSnapshotDue = true;
    }
};

var _Scene_Map_isMenuEnabled = Scene_Map.prototype.isMenuEnabled;
Scene_Map.prototype.isMenuEnabled = function() {
    if ($.isThin()) return false;
    return _Scene_Map_isMenuEnabled.call(this);
};

//=============================================================================
// Guest: thin client (no event logic)
//=============================================================================

var _Game_Map_updateInterpreter = Game_Map.prototype.updateInterpreter;
Game_Map.prototype.updateInterpreter = function() {
    if ($.isThin()) return;
    if ($.isHost() && $.exitHoldActive()) return;
    _Game_Map_updateInterpreter.call(this);
};

$.ownMoveSpeed = 0; // guest: last speed its own game gave its player
var _Game_Player_setMoveSpeed = Game_Player.prototype.setMoveSpeed;
Game_Player.prototype.setMoveSpeed = function(moveSpeed) {
    _Game_Player_setMoveSpeed.call(this, moveSpeed);
    if ($.isGuest() && !$.isThin() && this === $gamePlayer && !$.localBattle) $.ownMoveSpeed = moveSpeed;
};

var _Game_Map_updateEvents = Game_Map.prototype.updateEvents;
Game_Map.prototype.updateEvents = function() {
    if ($.isThin()) {
        this.events().forEach(function(ev) { ev.update(); });
        return;
    }
    _Game_Map_updateEvents.call(this);
};

var _Game_Map_isEventRunning = Game_Map.prototype.isEventRunning;
Game_Map.prototype.isEventRunning = function() {
    if ($.isThin()) return false;
    return _Game_Map_isEventRunning.call(this);
};

var _Game_Event_update = Game_Event.prototype.update;
Game_Event.prototype.update = function() {
    if ($.isThin()) {
        if (this.event()) Game_Character.prototype.update.call(this);
        return;
    }
    if (!this.event()) return; // world swapped, map not reloaded yet
    _Game_Event_update.call(this);
};

var _Game_Event_updateStop = Game_Event.prototype.updateStop;
Game_Event.prototype.updateStop = function() {
    if ($.isThin()) {
        Game_CharacterBase.prototype.updateStop.call(this);
        return;
    }
    _Game_Event_updateStop.call(this);
};

if (Game_Event.prototype.saveLocation) {
    var _Game_Event_saveLocation = Game_Event.prototype.saveLocation;
    Game_Event.prototype.saveLocation = function() {
        if ($.isThin()) return;
        _Game_Event_saveLocation.call(this);
    };
}

var _Game_Event_refresh = Game_Event.prototype.refresh;
Game_Event.prototype.refresh = function() {
    // After a world swap the old map runs one more frame with new events.
    if (($.isThin() && !$.buildingEvents) || !this.event()) return;
    _Game_Event_refresh.call(this);
};

var _Game_Player_startMapEvent = Game_Player.prototype.startMapEvent;
Game_Player.prototype.startMapEvent = function(x, y, triggers, normal) {
    if ($.isThin()) return;
    _Game_Player_startMapEvent.call(this, x, y, triggers, normal);
};

var _Game_Player_refresh = Game_Player.prototype.refresh;
Game_Player.prototype.refresh = function() {
    _Game_Player_refresh.call(this);
    if ($.isThin()) {
        // No avatar until the guest has a character.
        var actor = $dataActors[$.myActorId];
        if (actor) {
            this.setImage(actor.characterName, actor.characterIndex);
        } else {
            this.setImage('', 0);
        }
    }
};

// Running sheet per character (the outfit events' default, no injuries).
$.RUN_GRAPHICS = {
    1: ['run1', 0], 3: ['run1', 4], 4: ['run2', 0], 5: ['run2', 4],
    6: ['run3', 0], 13: ['run4', 0], 14: ['run4', 4], 15: ['run3', 4]
};

// The original speeds (CE40 Speed Status_check, CE576 run_key): the events
// set walk 4, run 4.5; with a hurt leg 3.5 (3 or 2 with arms gone too), no
// run. The engine dash (+1, TDDP Force Dashing) is switched off by the game
// (YEP_DashToggle "DisableDashing", kept in $gameSystem) except where the
// game turns it on. A thin guest runs neither event: same numbers here, and
// the dash only when the host's world allows it (it used to be always on:
// 5 / 5.5, faster than the host).
$.WALK_SPEED = 4;
$.RUN_SPEED = 4.5;

$.guestBaseSpeed = function(running) {
    var sw = ($.LIMB_SWITCHES || {})[$.myActorId] || [];
    var on = function(i) { return !!sw[i] && $gameSwitches.value(sw[i]); };
    if (on(3)) return on(1) ? 2 : on(0) ? 3 : 3.5;
    return running && !on(2) ? $.RUN_SPEED : $.WALK_SPEED;
};

// The run meter (CE573 stamina_meter1: 52 steps of 20 frames while running;
// CE575 stamina_cooldown: when it is empty, no run while it comes back 26
// steps at 15 frames each).
$.RUN_FRAMES = 52 * 20;
$.RUN_COOLDOWN_FRAMES = 26 * 15;
$.RUN_REFILL = 20 / 15; // meter frames back per frame when not running
$.runMeter = 0;         // guest: frames run
$.runCooldown = 0;

$.updateRunMeter = function(player) {
    if ($.runCooldown > 0) $.runCooldown--;
    if (player._fhRunning && player.isMoving()) {
        if (++$.runMeter >= $.RUN_FRAMES) {
            $.runCooldown = $.RUN_COOLDOWN_FRAMES;
            $.runMeter = $.RUN_FRAMES / 2;
            player._fhRunning = false;
        }
    } else if (!player._fhRunning && $.runMeter > 0) {
        $.runMeter = Math.max(0, $.runMeter - $.RUN_REFILL);
    }
};

// No run with a gun in hand: Shift aims and shoots (CE576 runs only with
// SW2252-2254 off; play test 2026-10-31: Marina ran and shot with Levi's
// pistol). The guns' switches: FH_CoopWorld $.gunSwitchesFor.
$.gunInHands = function() {
    var actor = $gameActors && $gameActors.actor($.myActorId);
    return !!actor && !!$.gunSwitchesFor && Object.keys($.gunSwitchesFor(actor)).length > 0;
};

var _Game_Player_updateDashing = Game_Player.prototype.updateDashing;
Game_Player.prototype.updateDashing = function() {
    if (!$.isThin()) return _Game_Player_updateDashing.call(this);
    $.updateRunMeter(this);
    if (this.isMoving()) return;
    this._dashing = this.canMove() && !this.isInVehicle() && !$gameMap.isDashDisabled();
    this._fhRunning = this.canMove() && Input.isPressed('shift') && $.runCooldown <= 0 && !$.gunInHands();
    if (!this.isMoveRouteForcing()) this.setMoveSpeed($.guestBaseSpeed(this._fhRunning));
};

var _Game_Player_update = Game_Player.prototype.update;
Game_Player.prototype.update = function(sceneActive) {
    _Game_Player_update.call(this, sceneActive);
    if ($.isThin()) this.updateFHCoopGraphic();
};

// Its sheet: its character's as the host has it (the host works it out from
// its outfit event: a gun in hand, an arm lost - FH_CoopWorld
// $.refreshLookOf), else the database's.
Game_Player.prototype.updateFHCoopGraphic = function() {
    var actor = $dataActors[$.myActorId];
    if (!actor) return;
    var run = $.RUN_GRAPHICS[$.myActorId];
    var own = $gameActors.actor($.myActorId);
    var name = own && own.characterName() ? own.characterName() : actor.characterName;
    var index = own && own.characterName() ? own.characterIndex() : actor.characterIndex;
    // (a step ends a frame before the next one starts: on the direction key
    // alone the run sheet blinked back to the walk sheet at every tile - the
    // guest's own run stuttered on its screen, play test 2026-10-31)
    var going = this.isMoving() || (this.canMove() && Input.dir4 !== 0);
    if (run && this._fhRunning && going && this._moveSpeed >= $.RUN_SPEED) {
        name = run[0];
        index = run[1];
    }
    if (this._characterName !== name || this._characterIndex !== index) {
        this.setImage(name, index);
    }
};

var _Game_Player_canMove = Game_Player.prototype.canMove;
Game_Player.prototype.canMove = function() {
    if ($.isGuest() && ($.picking || !$.myActorId)) return false;
    if ($.isGuest() && $.solo && ($.solo.waiting || $.solo.dead)) return false;
    return _Game_Player_canMove.call(this);
};

var _Game_Followers_isVisible = Game_Followers.prototype.isVisible;
Game_Followers.prototype.isVisible = function() {
    if ($.isThin()) return false;
    return _Game_Followers_isVisible.call(this);
};

//=============================================================================
// Solo tutorial: each player plays the train on their own
//=============================================================================
//
// After picking a character, a guest's window stops mirroring the host and
// runs the original game as a single player game with its own character:
// the character history on map 19 and the train on map 14. Leaving the
// train (map 14 -> map 4) is the meeting point: the guest sends its actor
// and belongings to the host and waits; the host waits at the same exit
// until every guest has arrived, then everyone continues together.

$.PROLOGUE_MAP = 19;
$.PROLOGUE_EVENT = 224;
// Intro route: 19 cabins -> 17 workshop -> 18 grand hall -> 8 moon -> 14
// train; the history route goes 19 -> 14. Both leave at 14 -> 4.
$.TUTORIAL_MAPS = [19, 17, 149, 18, 8, 14];
$.TRAIN_MAP = 14;
$.EXIT_MAP = 4;
$.HARD_MODE_SWITCH = 4819;
$.isHardMode = function() {
    return !!($gameSwitches && $gameSwitches.value($.HARD_MODE_SWITCH));
};

$.isPrologueEvent = function(eventId) {
    return eventId === $.PROLOGUE_EVENT && $gameMap.mapId() === $.PROLOGUE_MAP;
};

$.solo = null; // guest: { startSave, checkpoint, dead, autoSkip, waiting }

$.coopData = function() {
    $gameSystem._fhCoop = $gameSystem._fhCoop || { assign: {} };
    return $gameSystem._fhCoop;
};

// Host --------------------------------------------------------------------

// V2498 left_the_cabin_once: the game sets it the first time anyone
// steps off the train, so saves past the tutorial are recognised too.
$.LEFT_TRAIN_VAR = 2498;
$.tutorialOver = function() {
    return $gameVariables.value($.LEFT_TRAIN_VAR) >= 1;
};

$.guestInventory = function(name) {
    var data = $.coopData();
    data.inv = data.inv || {};
    data.inv[name] = data.inv[name] || { i: {}, w: {}, a: {} };
    return data.inv[name];
};

// The world as the host came into the character history (Map019) in this
// playthrough. A guest that picks later (the host on the train already)
// never had a snapshot of Map019 to start its own tutorial from: it began
// on the train and never got its history's skills, items and switches -
// not even the skip set, its tutorial counted as its history (flow T-4).
// It gets this world and plays its history first. None (a save loaded past
// Map019): it gets the history's skip set when it reaches the exit.
$.hostTutorialStart = null; // host: { run, data }

$.tutorialStartData = function() {
    var s = $.hostTutorialStart;
    if (s && $.tutorialOver()) s = $.hostTutorialStart = null; // (no guest needs it now)
    return s && s.run === $.playRun() ? s.data : null;
};

// Guests play the tutorial alone if the host is still on the train.
$.sendAssign = function(conn, actorId) {
    var solo = !$.tutorialOver() && $.TUTORIAL_MAPS.contains($gameMap.mapId());
    conn.solo = solo;
    conn.actorId = actorId;
    conn._fhNoHistory = false;
    if (solo && $gameMap.mapId() !== $.PROLOGUE_MAP) {
        var start = $.tutorialStartData();
        if (start) conn.send({ t: 'tutorialStart', data: start });
        else conn._fhNoHistory = true;
        $.dlog('tutorial for', conn.name, 'past the history map:', start ? 'from its start' : 'no start - the skip set at the exit');
    }
    conn.send({ t: 'assign', id: actorId, solo: solo, inv: $.guestInventory(conn.name), hostAtExit: !!$.hostAtExit });
};

// A new game or a load: the train exit's wait is from the world before (it
// stayed on: the next game told its guests the host waited at the exit).
$.resetTrainExit = function() {
    $.hostAtExit = false;
    $.exitHold = null;
    $.hostTutorialStart = null; // (the world before's start)
};
var _setupNewGameTrainExit = DataManager.setupNewGame;
DataManager.setupNewGame = function() {
    _setupNewGameTrainExit.call(this);
    $.resetTrainExit();
};
var _loadGameTrainExit = DataManager.loadGame;
DataManager.loadGame = function(savefileId) {
    var ok = _loadGameTrainExit.apply(this, arguments);
    if (ok) $.resetTrainExit();
    return ok;
};

var _gameMapSetupTutorialStart = Game_Map.prototype.setup;
Game_Map.prototype.setup = function(mapId) {
    _gameMapSetupTutorialStart.call(this, mapId);
    if ($.isHost() && mapId === $.PROLOGUE_MAP && this === $gameMap && !$.tutorialOver() && !$.tutorialStartData()) {
        $.hostTutorialStart = { run: $.playRun(), data: $.snapshotData() };
        $.dlog('tutorial start kept (the history map) for guests who pick later');
    }
};

// Its tutorial began past its history (no start world): the skip set.
$.giveNoHistorySkip = function(conn) {
    if (!conn || !conn._fhNoHistory || conn.solo || !$.tutorialOver()) return;
    conn._fhNoHistory = false;
    delete $.historyDone()[conn.name];
    $.giveHistorySkip(conn, conn.actorId);
};

$.onSoloDone = function(conn, msg) {
    if (conn.solo === false) return;
    $.dlog('guest reached the train exit', conn.name);
    conn.solo = false;
    conn.atExit = true; // no snapshots of the host's tutorial maps (snapshotTargets)
    // it leaves the train with the host: a spot saved on the train (autosave)
    // must not send it back there to run that map itself
    conn._needPos = false;
    var saved = $.coopData().pos;
    if (saved) delete saved[conn.name];
    if (conn.lastPos) delete conn.lastPos.m;
    if (conn.actorId && msg.actor) {
        $gameActors._data[conn.actorId] = JsonEx.parse(msg.actor);
    }
    if (msg.inv) { $.guestInventory(conn.name); $.coopData().inv[conn.name] = msg.inv; }
    if (!conn._fhNoHistory) $.historyDone()[conn.name] = 'solo';
    if (conn.actorId && msg.actor) $.keepSolo(conn, { actor: msg.actor, inv: msg.inv || null });
    $.giveNoHistorySkip(conn); // (hard mode: the host may be off the train already)
    $.toast('Co-op: ' + conn.name + ' reached the train exit');
    // Hard mode: the host is off the train already - the shared game now. A
    // snapshot came only with the host's next map change: the guest waited
    // on its own copy (its own arrival scene, the day text) meanwhile (flow T-7).
    if (!$.TUTORIAL_MAPS.contains($gameMap.mapId())) {
        $.dlog('the host is past the train: the shared game for', conn.name, 'now');
        $.sendSnapshot(conn);
    }
};

$.allAtExit = function() {
    return !$.clients.some(function(c) { return c.solo; });
};

$.exitProgress = function() {
    var playing = $.clients.filter(function(c) { return c.solo !== undefined; });
    var done = playing.filter(function(c) { return !c.solo; }).length;
    return (done + 1) + '/' + (playing.length + 1);
};

$.stillOnTrain = function() {
    return $.clients.filter(function(c) { return c.solo; }).map(function(c) { return c.name; });
};

$.transferTarget = function(interp) {
    var p = interp._params;
    return p[0] === 0 ? p[1] : $gameVariables.value(p[1]);
};

var _Game_Interpreter_command201 = Game_Interpreter.prototype.command201;
Game_Interpreter.prototype.command201 = function() {
    var leavingTrain = $gameMap.mapId() === $.TRAIN_MAP &&
        $.transferTarget(this) === $.EXIT_MAP && !$gameParty.inBattle();
    if ($.isGuest() && $.solo && leavingTrain) {
        if ($.isHardMode()) {
            if (!$.solo.waiting) $.finishSolo(false);
        } else {
            if (!$.solo.waiting) $.finishSolo();
            this.command115();
            return true;
        }
    }
    if ($.isHost() && leavingTrain && !$.isHardMode()) {
        if (!$.allAtExit()) {
            if (!$.hostAtExit) {
                // guests may leave the train only from now on (see the door below)
                $.hostAtExit = true;
                $.clients.forEach(function(c) { c.send({ t: 'hostAtExit' }); });
            }
            var progress = $.exitProgress();
            if (this._fhWaitShown !== progress) {
                this._fhWaitShown = progress;
                var text = 'Co-op: waiting at the train exit (' + progress + ') - still on the train: ' +
                    $.stillOnTrain().join(', ');
                $.toast(text);
                // those already waiting at the exit see who they wait for too
                $.clients.forEach(function(c) { if (c.atExit && !c.solo) c.send({ t: 'toast', text: text }); });
            }
            return false; // retried next frame
        }
    }
    if ($.isHost() && leavingTrain) {
        $.hostAtExit = false; // everyone is through
        $.startExitHold();
        $.clients.forEach($.giveNoHistorySkip);
    }
    return _Game_Interpreter_command201.call(this);
};

// Off the train the host's map events wait until every guest has the new map
// on screen (or 5 s): the arrival scene's choices used to reach a guest while
// its map screen was still being built.
$.EXIT_HOLD_MS = 5000; // (real time, $.clockMs: drawn frames run as fast as the screen)
$.exitHold = null; // host: { waiting: { guestId: true }, until (ms) }

$.startExitHold = function() {
    var waiting = {};
    $.clients.forEach(function(c) { if (c.actorId && !c.solo) waiting[c.guestId] = true; });
    $.exitHold = Object.keys(waiting).length ? { waiting: waiting, until: 0 } : null;
};

$.exitHoldActive = function() {
    var hold = $.exitHold;
    if (!hold || !$gameMap || $gameMap.mapId() !== $.EXIT_MAP) return false;
    var now = $.clockMs ? $.clockMs() : Date.now();
    if (!hold.until) hold.until = now + $.EXIT_HOLD_MS;
    var left = Object.keys(hold.waiting).filter(function(id) {
        return $.clients.some(function(c) { return c.guestId === id; });
    });
    if (!left.length || now > hold.until) {
        $.dlog('exit hold done', left.length ? 'timeout ' + left.join(',') : 'all ready');
        $.exitHold = null;
        return false;
    }
    return true;
};

$.hostHandlers = $.hostHandlers || {};
$.hostHandlers.mapReady = function(conn, msg) {
    if ($.exitHold && msg.m === $.EXIT_MAP) delete $.exitHold.waiting[conn.guestId];
};

// Guest -------------------------------------------------------------------

// A guest that reaches the train door before the host is waiting there is
// stopped at the door with a message, like the bunker ladder. It used to
// walk out into a black screen (the door event tints the screen before the
// transfer) and wait there.
$.TRAIN_DOOR_EVENT = 28; // map 14: page 0 opens the door, pages 1-2 leave
$.TRAIN_EXIT_TEXT = 'The others are still on the train... wait for them here before you step outside.';
$.hostWaitingAtExit = false;

// Waiting for the shared game at the train exit (hard mode: already outside,
// on this PC's own Map004) is a scene for the original: SW202 reads on, so
// the hard mode sanity drop (Map EV28 -> CE372-374: "SW202 off -> MP - 1")
// stops (play test 2026-11-02: a guest out first lost sanity standing still
// until the host came; the Eye of Rher waits too, FH_CoopRoam rherPaused).
// The shared game's snapshot replaces this world.
$.SCENE_SWITCH = 202;
$.soloWaitHolds = function() {
    return $.isGuest() && !!$.solo && !!$.solo.waiting;
};
var _Game_Switches_value_soloWait = Game_Switches.prototype.value;
Game_Switches.prototype.value = function(id) {
    if (id === $.SCENE_SWITCH && this === $gameSwitches && $.soloWaitHolds()) return true;
    return _Game_Switches_value_soloWait.call(this, id);
};

var _Game_Event_start_trainDoor = Game_Event.prototype.start;
Game_Event.prototype.start = function() {
    if ($.isGuest() && $.solo && !$.isHardMode() && !$.solo.waiting && !$.hostWaitingAtExit &&
            $gameMap.mapId() === $.TRAIN_MAP && this.eventId() === $.TRAIN_DOOR_EVENT && this._pageIndex === 0) {
        // bumping the door repeats every frame: tell once a second
        if ($._trainToldAt === undefined || Graphics.frameCount - $._trainToldAt > 60) {
            $._trainToldAt = Graphics.frameCount;
            if ($.fieldGab) $.fieldGab($.TRAIN_EXIT_TEXT); else $.toast($.TRAIN_EXIT_TEXT);
        }
        return;
    }
    _Game_Event_start_trainDoor.call(this);
};

// The history event's setup page (Map019 EV224 page 0, run once on the
// host) teaches Party talk, Talk and Run! only to the protagonist; the other
// characters get companion skills instead (Levi even forgets Talk). Every
// player's character is a protagonist.
$.PROTAGONIST_SKILLS = [8, 11, 40];

$.giveProtagonistSkills = function(actor) {
    if (!actor || !actor.learnSkill) return;
    $.PROTAGONIST_SKILLS.forEach(function(id) {
        if (!actor.isLearnedSkill(id)) actor.learnSkill(id);
    });
};

$.SELECT_OF_ACTOR = {};
Object.keys($.SELECT_ACTOR).forEach(function(sw) { $.SELECT_OF_ACTOR[$.SELECT_ACTOR[sw]] = Number(sw); });

$.saveLocal = function() {
    return JsonEx.stringify(DataManager.makeSaveContents());
};

$.startSolo = function(inv) {
    // Picked after the host moved on: go back to the start of the intro.
    var rewind = $gameMap.mapId() !== $.PROLOGUE_MAP && !!$.tutorialStartSnap;
    if (rewind) {
        DataManager.createGameObjects();
        DataManager.extractSaveContents($.parseSnapshot($.tutorialStartSnap));
    }
    // The guest's copy of the world, seen as a single player game with its
    // own character as the protagonist and its own belongings.
    $.SELECT_SWITCHES.forEach(function(id) { $gameSwitches._data[id] = false; });
    var sw = $.SELECT_OF_ACTOR[$.myActorId];
    if (sw) $gameSwitches._data[sw] = true;
    if ($gameMap.mapId() === $.PROLOGUE_MAP) {
        // Page 0 of the history event is setup the host already ran.
        var key = [$.PROLOGUE_MAP, $.PROLOGUE_EVENT];
        $gameSelfSwitches._data[key.concat('B').join(',')] = true;
        delete $gameSelfSwitches._data[key.concat('A').join(',')];
    }
    $gameParty._actors = [$.myActorId];
    $.giveProtagonistSkills($gameActors.actor($.myActorId));
    $gameParty._items = Object.assign({}, inv && inv.i);
    $gameParty._weapons = Object.assign({}, inv && inv.w);
    $gameParty._armors = Object.assign({}, inv && inv.a);
    $gameMap._interpreter.clear();
    $gameMessage.clear();
    $gameScreen.clearPictures();
    $.remotes = {};
    $.solo = { dead: false, autoSkip: false, waiting: false };
    if (rewind) {
        $.dlog('solo rewind to the intro');
        $gamePlayer.setTransparent(false);
        $gamePlayer.reserveTransfer($gameMap.mapId(), $gamePlayer.x, $gamePlayer.y, $gamePlayer.direction(), 0);
        $gamePlayer.requestMapReload();
        _SceneManager_goto_base.call(SceneManager, Scene_Map);
        $.toast('Co-op: your own story - meet the others at the train exit');
        return; // checkpoints are taken when the map starts
    }
    $gameMap.refresh();
    $gamePlayer.refresh();
    $gamePlayer.setTransparent(false);
    $.solo.startSave = $.saveLocal();
    $.solo.checkpoint = $.solo.startSave;
    $.solo.checkpointMap = $gameMap.mapId();
    $.dlog('solo start, actor', $.myActorId, 'map', $gameMap.mapId());
    $.toast('Co-op: your own story - meet the others at the train exit');
};

$.finishSolo = function(waitAtExit) {
    $.dlog('solo finish at the train exit');
    $.solo.waiting = true;
    var actor = $gameActors.actor($.myActorId);
    if ($.conn) {
        $.conn.send({
            t: 'soloDone',
            actor: actor ? JsonEx.stringify(actor) : null,
            inv: { i: $gameParty._items, w: $gameParty._weapons, a: $gameParty._armors }
        });
    }
    $.toast(waitAtExit === false ? 'Co-op: joining the shared game' : 'Co-op: waiting for the others at the train exit');
};

// New area: remember it as the retry point.
var _Scene_Map_start_solo = Scene_Map.prototype.start;
Scene_Map.prototype.start = function() {
    _Scene_Map_start_solo.call(this);
    if ($.isGuest() && $.solo && !$.solo.dead && $.solo.checkpointMap !== $gameMap.mapId()) {
        var save = $.saveLocal();
        if (!$.solo.startSave) $.solo.startSave = save;
        $.solo.checkpoint = save;
        $.solo.checkpointMap = $gameMap.mapId();
    }
};

// Each history page (O'saa's text adventure has several) is a retry point.
var _Game_Interpreter_setup = Game_Interpreter.prototype.setup;
Game_Interpreter.prototype.setup = function(list, eventId) {
    if ($.isGuest() && $.solo && !$.solo.dead && $.isPrologueEvent(eventId) && this === $gameMap._interpreter) {
        $.solo.checkpoint = $.saveLocal();
        $.dlog('solo checkpoint: history page', $gameMap.event(eventId)._pageIndex);
    }
    _Game_Interpreter_setup.call(this, list, eventId);
};

// Dying alone (a lost fight, O'saa's text adventure) offers a retry.
var _SceneManager_goto = SceneManager.goto;
var _SceneManager_goto_base = _SceneManager_goto;
SceneManager.goto = function(sceneClass) {
    if (sceneClass === Scene_Gameover && $.isGuest() && $.solo) {
        $.dlog('solo death on map', $gameMap.mapId());
        $.solo.dead = true;
        $.loadLocal($.solo.checkpoint);
        return;
    }
    _SceneManager_goto.call(this, sceneClass);
};

$.loadLocal = function(save) {
    DataManager.createGameObjects();
    DataManager.extractSaveContents(JsonEx.parse(save));
    $gamePlayer.reserveTransfer($gameMap.mapId(), $gamePlayer.x, $gamePlayer.y, $gamePlayer.direction(), 0);
    $gamePlayer.requestMapReload();
    _SceneManager_goto.call(SceneManager, Scene_Map);
};

// Party changes (companions joining) belong to the shared game.
var _Game_Interpreter_command129 = Game_Interpreter.prototype.command129;
Game_Interpreter.prototype.command129 = function() {
    if ($.isGuest() && $.solo) return true;
    return _Game_Interpreter_command129.call(this);
};

// "Skip The Character History?" answered Yes automatically after a skip.
// It is the first choice of every history page; matched by position, not by
// text, so translated games (e.g. the Korean patch) work too.
$.isFirstChoiceOfList = function(interp) {
    var list = interp._list || [];
    for (var i = 0; i < list.length; i++) {
        if (list[i].code === 102) return i === interp._index;
    }
    return false;
};

var _Game_Interpreter_setupChoices = Game_Interpreter.prototype.setupChoices;
Game_Interpreter.prototype.setupChoices = function(params) {
    if ($.isGuest() && $.solo && $.solo.autoSkip &&
            $.isPrologueEvent(this._eventId) && $.isFirstChoiceOfList(this)) {
        $.solo.autoSkip = false;
        $gameMessage.clear();
        this._branch[this._indent] = 0;
        return;
    }
    _Game_Interpreter_setupChoices.call(this, params);
};

Scene_Map.prototype.updateFHCoopSolo = function() {
    if (!$.solo || !$.solo.dead || this._fhRescueWindow) return;
    this._fhRescueHelp = new Window_Help(1);
    this._fhRescueHelp.setText('You died. Try again?');
    this._fhRescueWindow = new Window_FHCoopRescue($gameMap.mapId() === $.PROLOGUE_MAP);
    this._fhRescueWindow.setHandler('retry', this.onFHCoopRescue.bind(this, false));
    this._fhRescueWindow.setHandler('skip', this.onFHCoopRescue.bind(this, true));
    this.addWindow(this._fhRescueHelp);
    this.addWindow(this._fhRescueWindow);
};

Scene_Map.prototype.onFHCoopRescue = function(skip) {
    this._windowLayer.removeChild(this._fhRescueWindow);
    this._windowLayer.removeChild(this._fhRescueHelp);
    this._fhRescueWindow = null;
    this._fhRescueHelp = null;
    $.solo.dead = false;
    if (skip) {
        $.solo.autoSkip = true;
        $.loadLocal($.solo.startSave);
    }
};

function Window_FHCoopRescue() {
    this.initialize.apply(this, arguments);
}

Window_FHCoopRescue.prototype = Object.create(Window_Command.prototype);
Window_FHCoopRescue.prototype.constructor = Window_FHCoopRescue;

Window_FHCoopRescue.prototype.initialize = function(canSkip) {
    this._canSkip = canSkip;
    Window_Command.prototype.initialize.call(this, 0, 0);
    this.x = (Graphics.boxWidth - this.width) / 2;
    this.y = (Graphics.boxHeight - this.height) / 2;
};

Window_FHCoopRescue.prototype.windowWidth = function() {
    return 440;
};

Window_FHCoopRescue.prototype.makeCommandList = function() {
    this.addCommand('Retry', 'retry');
    if (this._canSkip) this.addCommand('Skip the character history', 'skip');
};

//=============================================================================
// Title: "Co-op Join"
//=============================================================================

// Keep solo saves in the game's normal save/ folder and co-op saves under
// save/multiplayer/. Global save metadata follows the same mode; config stays
// shared with the normal game.
$.SAVE_MODE_NORMAL = 'normal';
$.SAVE_MODE_MULTIPLAYER = 'multiplayer';
$.saveMode = $.SAVE_MODE_NORMAL;

$.withSaveMode = function(mode, callback) {
    var previous = $.saveMode;
    $.saveMode = mode;
    try {
        return callback();
    } finally {
        $.saveMode = previous;
    }
};

$.hasSaveFilesInMode = function(mode) {
    return $.withSaveMode(mode, function() {
        return DataManager.isAnySavefileExists();
    });
};

$.isMultiplayerSaveMode = function() {
    return $.saveMode === $.SAVE_MODE_MULTIPLAYER;
};

var _StorageManager_localFilePath = StorageManager.localFilePath;
StorageManager.localFilePath = function(savefileId) {
    var filePath = _StorageManager_localFilePath.call(this, savefileId);
    if (!$.isMultiplayerSaveMode() || savefileId < 0) return filePath;
    var path = require('path');
    return path.join(path.dirname(filePath), 'multiplayer', path.basename(filePath));
};

var _StorageManager_saveToLocalFile = StorageManager.saveToLocalFile;
StorageManager.saveToLocalFile = function(savefileId, json) {
    if ($.isMultiplayerSaveMode() && savefileId >= 0) {
        var fs = require('fs');
        var path = require('path');
        var rootPath = this.localFileDirectoryPath();
        var dirPath = path.dirname(this.localFilePath(savefileId));
        if (!fs.existsSync(rootPath)) fs.mkdirSync(rootPath);
        if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath);
    }
    return _StorageManager_saveToLocalFile.call(this, savefileId, json);
};

var _StorageManager_webStorageKey = StorageManager.webStorageKey;
StorageManager.webStorageKey = function(savefileId) {
    var key = _StorageManager_webStorageKey.call(this, savefileId);
    if ($.isMultiplayerSaveMode() && savefileId >= 0) return 'FH Co-op ' + key;
    return key;
};

// Move older co-op slots (marked by their saved participant list) out of the
// shared save folder once, while keeping ordinary saves in place.
$.migrateLegacyMultiplayerSaves = function() {
    if (!StorageManager.isLocalMode()) return;
    var fs = require('fs');
    var path = require('path');
    var normalInfo;
    var multiplayerInfo;
    try {
        normalInfo = $.withSaveMode($.SAVE_MODE_NORMAL, function() {
            var json = StorageManager.load(0);
            return json ? JSON.parse(json) : [];
        });
        multiplayerInfo = $.withSaveMode($.SAVE_MODE_MULTIPLAYER, function() {
            var json = StorageManager.load(0);
            return json ? JSON.parse(json) : [];
        });
    } catch (e) {
        console.error('[FH_Coop] could not inspect legacy saves', e);
        return;
    }
    if (!Array.isArray(normalInfo)) normalInfo = [];
    if (!Array.isArray(multiplayerInfo)) multiplayerInfo = [];

    var moved = [];
    for (var oldId = 1; oldId <= DataManager.maxSavefiles(); oldId++) {
        var info = normalInfo[oldId];
        if (!info || !Array.isArray(info.fhCoop)) continue;
        var oldPath = $.withSaveMode($.SAVE_MODE_NORMAL, function() {
            return StorageManager.localFilePath(oldId);
        });
        if (!fs.existsSync(oldPath)) continue;

        var newId = oldId;
        var occupied = function(id) {
            return !!multiplayerInfo[id] || $.withSaveMode($.SAVE_MODE_MULTIPLAYER, function() {
                return StorageManager.exists(id);
            });
        };
        if (occupied(newId)) {
            newId = 0;
            for (var candidate = 1; candidate <= DataManager.maxSavefiles(); candidate++) {
                if (!occupied(candidate)) {
                    newId = candidate;
                    break;
                }
            }
            if (!newId) continue;
        }

        var newPath = $.withSaveMode($.SAVE_MODE_MULTIPLAYER, function() {
            return StorageManager.localFilePath(newId);
        });
        var rootPath = $.withSaveMode($.SAVE_MODE_NORMAL, function() {
            return StorageManager.localFileDirectoryPath();
        });
        var newDir = path.dirname(newPath);
        try {
            if (!fs.existsSync(rootPath)) fs.mkdirSync(rootPath);
            if (!fs.existsSync(newDir)) fs.mkdirSync(newDir);
            fs.writeFileSync(newPath, fs.readFileSync(oldPath));
        } catch (e) {
            if (fs.existsSync(newPath)) fs.unlinkSync(newPath);
            console.error('[FH_Coop] could not copy legacy save slot ' + oldId, e);
            continue;
        }
        if (fs.existsSync(oldPath + '.bak')) {
            try {
                fs.writeFileSync(newPath + '.bak', fs.readFileSync(oldPath + '.bak'));
            } catch (e) {
                console.error('[FH_Coop] could not copy backup for legacy save slot ' + oldId, e);
            }
        }
        multiplayerInfo[newId] = info;
        moved.push({ oldId: oldId, newId: newId, oldPath: oldPath, newPath: newPath });
    }

    if (!moved.length) return;
    var originalMultiplayerInfo = multiplayerInfo.slice();
    try {
        $.withSaveMode($.SAVE_MODE_MULTIPLAYER, function() {
            StorageManager.save(0, JSON.stringify(multiplayerInfo));
        });
        moved.forEach(function(entry) { delete normalInfo[entry.oldId]; });
        $.withSaveMode($.SAVE_MODE_NORMAL, function() {
            StorageManager.save(0, JSON.stringify(normalInfo));
        });
        moved.forEach(function(entry) {
            try {
                if (fs.existsSync(entry.oldPath)) fs.unlinkSync(entry.oldPath);
                if (fs.existsSync(entry.oldPath + '.bak')) fs.unlinkSync(entry.oldPath + '.bak');
            } catch (e) {
                console.error('[FH_Coop] could not remove migrated legacy save slot ' + entry.oldId, e);
            }
        });
        console.log('[FH_Coop] moved ' + moved.length + ' legacy co-op save(s) to save/multiplayer/');
    } catch (e) {
        try {
            $.withSaveMode($.SAVE_MODE_MULTIPLAYER, function() {
                StorageManager.save(0, JSON.stringify(originalMultiplayerInfo));
            });
        } catch (rollbackError) {
            console.error('[FH_Coop] could not roll back multiplayer save index', rollbackError);
        }
        console.error('[FH_Coop] could not finish legacy save migration', e);
    }
};
$.migrateLegacyMultiplayerSaves();

var _Window_TitleCommand_makeCommandList = Window_TitleCommand.prototype.makeCommandList;
Window_TitleCommand.prototype.makeCommandList = function() {
    $.withSaveMode($.SAVE_MODE_NORMAL, function() {
        _Window_TitleCommand_makeCommandList.call(this);
    }.bind(this));
    this.addCommand('Co-op Join', 'fhCoopJoin');
    this.addCommand('Multi Continue', 'fhCoopContinue',
        $.hasSaveFilesInMode($.SAVE_MODE_MULTIPLAYER));
};

var _Scene_Title_createCommandWindow = Scene_Title.prototype.createCommandWindow;
Scene_Title.prototype.createCommandWindow = function() {
    _Scene_Title_createCommandWindow.call(this);
    this._commandWindow.setHandler('fhCoopJoin', this.commandFHCoopJoin.bind(this));
    this._commandWindow.setHandler('fhCoopContinue', this.commandFHCoopContinue.bind(this));
};

var _Scene_Title_commandNewGame = Scene_Title.prototype.commandNewGame;
Scene_Title.prototype.commandNewGame = function() {
    $.saveMode = $.isHost() ? $.SAVE_MODE_MULTIPLAYER : $.SAVE_MODE_NORMAL;
    _Scene_Title_commandNewGame.call(this);
};

var _Scene_Title_commandContinue = Scene_Title.prototype.commandContinue;
Scene_Title.prototype.commandContinue = function() {
    $.saveMode = $.SAVE_MODE_NORMAL;
    _Scene_Title_commandContinue.call(this);
};

Scene_Title.prototype.commandFHCoopContinue = function() {
    $.saveMode = $.SAVE_MODE_MULTIPLAYER;
    this._commandWindow.close();
    SceneManager.push(Scene_Load);
};

Scene_Title.prototype.commandFHCoopJoin = function() {
    var win = this._commandWindow;
    $.askAddress(function(address) {
        $.toast('Co-op: connecting to ' + address + ' ...');
        $.join(address, function() {
            $.toast('Co-op: could not connect to ' + address);
            win.activate();
        });
    }, function() {
        win.activate();
    });
};

var _Scene_Title_start = Scene_Title.prototype.start;
Scene_Title.prototype.start = function() {
    $.dropTutorialSeatLocal();
    _Scene_Title_start.call(this);
    if ($.isHost() && $.hostInGame) {
        // Host went back to the title: guests wait in the lobby again (the
        // session's world is dropped too, FH_CoopRoam endSessionGame).
        if ($.endSessionGame) {
            $.endSessionGame('the host is back at the title');
        } else {
            $.hostInGame = false;
            $.remotes = {};
            $.resetPicks();
            $.clients.forEach(function(c) { c.send({ t: 'lobby' }); });
        }
    }
    // A connected guest waits for the host instead of starting its own game.
    if ($.isGuest()) this._commandWindow.deactivate();
    $.refreshPanel();
};

var _Scene_Title_stop = Scene_Title.prototype.stop;
Scene_Title.prototype.stop = function() {
    _Scene_Title_stop.call(this);
    var el = document.getElementById('fhcoop-panel');
    if (el) el.style.display = 'none';
};

// The mod version in the title's bottom-right corner, so both players can
// see at a glance that they run the same release.
$.versionText = function() {
    return 'FH2 Co-op ' + $.versionLabel($.modVersion, $.modHash);
};

var _Scene_Title_create_version = Scene_Title.prototype.create;
Scene_Title.prototype.create = function() {
    _Scene_Title_create_version.call(this);
    var sprite = new Sprite(new Bitmap(Graphics.width, 28));
    sprite.bitmap.fontSize = 16;
    sprite.bitmap.outlineWidth = 3;
    sprite.bitmap.drawText($.versionText(), 0, 0, Graphics.width - 10, 28, 'right');
    sprite.y = Graphics.height - 30;
    sprite.opacity = 200;
    this._fhVersionSprite = sprite;
    this.addChild(sprite);
};

var _Scene_Title_update = Scene_Title.prototype.update;
Scene_Title.prototype.update = function() {
    _Scene_Title_update.call(this);
    if ($.isGuest() && $.pendingSnapshot && !this._fhJoining) {
        this._fhJoining = true;
        this.fadeOutAll();
        $.processPendingSnapshot();
    }
};

$.askAddress = function(onOk, onCancel) {
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:50%;top:40%;transform:translate(-50%,-50%);' +
        'z-index:101;background:rgba(0,0,0,0.85);padding:12px 16px;border:1px solid #888;' +
        'font:15px sans-serif;color:#fff;';
    box.innerHTML = 'Host IP (Enter = join, Esc = cancel)<br>';
    var input = document.createElement('input');
    input.type = 'text';
    input.style.cssText = 'margin-top:6px;width:220px;font:15px monospace;';
    var last = '';
    try { last = localStorage.getItem('fhCoopLastIp') || ''; } catch (e) {}
    input.value = last || '127.0.0.1';
    box.appendChild(input);
    document.body.appendChild(box);
    input.focus();
    input.select();
    var done = function(ok) {
        document.body.removeChild(box);
        Input.clear();
        if (ok) {
            var ip = input.value.trim() || '127.0.0.1';
            try { localStorage.setItem('fhCoopLastIp', ip); } catch (e) {}
            onOk(ip);
        } else {
            onCancel();
        }
    };
    // Keep keys away from the game's Input handler while typing.
    input.addEventListener('keydown', function(e) {
        e.stopPropagation();
        if (e.keyCode === 13) done(true);
        if (e.keyCode === 27) done(false);
    });
    input.addEventListener('keyup', function(e) { e.stopPropagation(); });
};

//=============================================================================
// Keys: F6 = open session; F8 = quick access to the save screen
//=============================================================================

document.addEventListener('keydown', function(e) {
    if (e.keyCode === 117) { // F6
        e.preventDefault();
        $.startHost();
    }
    if (e.keyCode === 119) { // F8
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!(SceneManager._scene instanceof Scene_Map) || !$gameMap || $gameParty.inBattle()) return;
        if ($.isGuest()) {
            $.toast('Co-op: only the host can save');
            return;
        }
        if ($gameMap.isEventRunning() || $gameMessage.isBusy()) {
            $.toast('Save is unavailable during an event or message');
            return;
        }
        SceneManager.push(Scene_Save);
    }
});

})(FH.Coop);
