//=============================================================================
// FH_CoopWorld.js
//=============================================================================
/*:
 * @plugindesc v1.0.1 Co-op field play: guests run events, own inventories,
 * trading, time votes, host-only saves, guns, chasing enemies. Below FH_Coop.
 * @author FH2 Co-op Mod
 *
 * @help
 * Needs FH_Coop.js (and FH_ATB.js) above it.
 *
 * Host side, every guest has a "context": its own character (SELECT switch),
 * its own party (just its character), its own items, weapons, armors and
 * money. When a guest talks to, touches or is touched by an event, the host
 * runs that event in the guest's context with an interpreter of its own, so
 * the host's own events keep running. Messages and choices of such an event
 * are shown on the guest's screen, screen effects and sounds are played
 * there too, and the guest's answers come back to the host.
 *
 * All of this is for the guests on the host's map. A guest on another map
 * runs that map on its own PC (FH_CoopRoam).
 */

var FH = FH || {};
FH.Coop = FH.Coop || {};

(function($) {
'use strict';

if (!$.isHost) {
    console.error('FH_CoopWorld needs FH_Coop.js above it.');
    return;
}

//=============================================================================
// Message dispatch: other co-op plugins register handlers by message type.
//=============================================================================

$.hostHandlers = $.hostHandlers || {};
$.guestHandlers = $.guestHandlers || {};

var _onHostMessage = $.onHostMessage;
$.onHostMessage = function(conn, msg) {
    var handler = $.hostHandlers[msg.t];
    if (handler) {
        if (!conn.guestId) return;
        try {
            handler(conn, msg);
        } catch (e) {
            $.dlog('ERROR host handler', msg.t, e.stack || String(e));
        }
        return;
    }
    _onHostMessage(conn, msg);
};

var _onGuestMessage = $.onGuestMessage;
$.onGuestMessage = function(conn, msg) {
    var handler = $.guestHandlers[msg.t];
    if (handler) {
        try {
            handler(msg);
        } catch (e) {
            $.dlog('ERROR guest handler', msg.t, e.stack || String(e));
        }
        return;
    }
    _onGuestMessage(conn, msg);
};

// This PC runs a map for other players: the host, or a guest running its map
// for guests who came later (FH_CoopRoam). Session things (saves, votes,
// deaths, connections) stay $.isHost().
$.runsWorld = $.runsWorld || function() { return $.isHost(); };
$.worldSync = $.worldSync || function() { $.hostSync(); };

$.clientById = function(id) {
    for (var i = 0; i < $.clients.length; i++) {
        if ($.clients[i].guestId === id) return $.clients[i];
    }
    return null;
};

$.sendTo = function(id, msg) {
    if (id === 'host') {
        // A message for the host's own screen while the host runs it.
        var handler = $.guestHandlers[msg.t];
        if (handler) handler(msg);
        return;
    }
    var conn = $.clientById(id);
    if (conn) conn.send(msg);
};

// Guests that take part in the shared game right now (character chosen,
// on the host's map, past their solo tutorial).
$.activeGuests = function() {
    return $.clients.filter(function(c) {
        return c.inGame && c.actorId && !c.solo;
    });
};

$.sessionActive = function() {
    if ($.isGuest()) return !!$.myActorId && !$.solo;
    return $.isHost() && $.activeGuests().length > 0;
};

$.guestOnMap = function(conn) {
    return !!conn.lastPos && (!conn.lastPos.m || conn.lastPos.m === $gameMap.mapId());
};

// The host's character, also inside a guest's context: there the selection
// switches and the party are that guest's, so $.hostActorId() named the guest
// (the sleep group made from Marina's bed logged "Marina, Marina" for the
// host O'saa and Marina, 0.38.3-pre5).
$.realHostActorId = function() {
    var save = $.ctx && $.ctxSave;
    if (!save || !save.sel) return $.hostActorId();
    var found = 0;
    $.SELECT_SWITCHES.forEach(function(id, i) {
        if (!found && save.sel[i] && $.SELECT_ACTOR[id]) found = $.SELECT_ACTOR[id];
    });
    return found || (save.actors && save.actors[0]) || 0;
};

// Display name of a player: "<character> (<nickname>)".
$.playerLabel = function(id) {
    if (id === 'host') {
        var a = $gameActors.actor($.realHostActorId());
        return a ? a.name() : $.myName;
    }
    var conn = $.clientById(id);
    if (!conn) return 'Someone';
    var actor = conn.actorId && $gameActors.actor(conn.actorId);
    return actor ? actor.name() : conn.name;
};

//=============================================================================
// Guest context (host side)
//=============================================================================

$.FACE_SWITCHES = { 8: 10, 2: 11, 4: 12, 6: 13 }; // FACE_UP/DOWN/LEFT/RIGHT
$.ctx = null;      // conn whose context is active
$.ctxDepth = 0;

$.inventoryOf = function(conn) {
    var inv = $.guestInventory(conn.name);
    if (inv.g === undefined) inv.g = 0;
    return inv;
};

$.enterContext = function(conn) {
    if ($.ctx === conn) {
        $.ctxDepth++;
        return;
    }
    if ($.ctx) $.exitContext(true);
    var sw = $gameSwitches._data;
    var party = $gameParty;
    var save = {
        sel: $.SELECT_SWITCHES.map(function(id) { return sw[id]; }),
        face: [10, 11, 12, 13].map(function(id) { return sw[id]; }),
        actors: party._actors,
        items: party._items,
        weapons: party._weapons,
        armors: party._armors,
        gold: party._gold
    };
    $.SELECT_SWITCHES.forEach(function(id) { sw[id] = false; });
    var sel = $.SELECT_OF_ACTOR[conn.actorId];
    if (sel) sw[sel] = true;
    var remote = $.remotes[conn.guestId];
    var dir = remote ? remote._direction : 2;
    [10, 11, 12, 13].forEach(function(id) { sw[id] = false; });
    if ($.FACE_SWITCHES[dir]) sw[$.FACE_SWITCHES[dir]] = true;
    var inv = $.inventoryOf(conn);
    party._actors = [conn.actorId];
    party._items = inv.i;
    party._weapons = inv.w;
    party._armors = inv.a;
    party._gold = inv.g;
    $.ctx = conn;
    $.ctxSave = save;
    $.ctxDepth = 1;
};

$.exitContext = function(force) {
    if (!$.ctx) return;
    if (!force && --$.ctxDepth > 0) return;
    var conn = $.ctx;
    var save = $.ctxSave;
    var sw = $gameSwitches._data;
    var party = $gameParty;
    $.inventoryOf(conn).g = party._gold;
    $.SELECT_SWITCHES.forEach(function(id, i) { sw[id] = save.sel[i]; });
    [10, 11, 12, 13].forEach(function(id, i) { sw[id] = save.face[i]; });
    party._actors = save.actors;
    party._items = save.items;
    party._weapons = save.weapons;
    party._armors = save.armors;
    party._gold = save.gold;
    $.ctx = null;
    $.ctxSave = null;
    $.ctxDepth = 0;
};

// $gamePlayer.refresh() inside a guest context must still show the host.
var _Game_Player_refresh = Game_Player.prototype.refresh;
Game_Player.prototype.refresh = function() {
    if ($.ctx && $.ctxSave && !this._fhRemoteId) {
        var party = $gameParty;
        var now = party._actors;
        party._actors = $.ctxSave.actors;
        try {
            _Game_Player_refresh.call(this);
        } finally {
            party._actors = now;
        }
        return;
    }
    _Game_Player_refresh.call(this);
};

$.inContext = function(conn, fn) {
    $.enterContext(conn);
    try {
        return fn();
    } finally {
        $.exitContext();
    }
};

// SW202 suicide_inprocess and SW410 CANNOTUSE_BOW are each PC's "a scene is
// running" flags: the host's parallel events (hunger, outfit, sanity) and its
// bow wait on them. A guest's event set the host's (a ritual circle drawing
// kept the host's needs stopped for seconds): in a guest's context they are
// that guest's own values.
// The ladders too (0.38.3-pre5: a guest on the ladder of the Mayor's manor
// made the host "climb"): SW203 CLIMBING (Map020 EV104/107 on, EV80-85/108
// off; the outfit common events (CE396 ...) draw the climbing sprite, CE40
// sets speed 3 and CE576 stops the run while it is on), SW241
// coming_UP_LADDERS (EV108 on; the parallel EV87 tints the screen back and
// turns it off) and SW4318 UPSTAIRS (Map020/147 EV75 regain_sanity) are
// where that one player is.
// SW41 disabled too (CE40 turns it on when that player's character has lost
// its last arm and leg; the "disabled" autorun of every map then holds it:
// FH_CoopRoam "No limbs left").
$.CTX_OWN_SWITCHES = [202, 410, 203, 241, 4318, 41];
$.ctxOwnSave = null; // the host's values while a guest's context is active

var _enterContextOwn = $.enterContext;
$.enterContext = function(conn) {
    var was = $.ctx;
    _enterContextOwn(conn);
    if ($.ctx !== conn || was === conn) return;
    var sw = $gameSwitches._data, mine = conn._fhCtxSw || {}, save = {};
    $.CTX_OWN_SWITCHES.forEach(function(id) {
        save[id] = sw[id];
        sw[id] = !!mine[id];
    });
    $.ctxOwnSave = { conn: conn, sw: save };
};

var _exitContextOwn = $.exitContext;
$.exitContext = function(force) {
    var saved = $.ctxOwnSave;
    _exitContextOwn(force);
    if (!saved || $.ctx === saved.conn) return;
    $.ctxOwnSave = null;
    var sw = $gameSwitches._data, mine = {};
    $.CTX_OWN_SWITCHES.forEach(function(id) {
        if (sw[id]) mine[id] = true;
        sw[id] = saved.sw[id];
    });
    saved.conn._fhCtxSw = mine;
};

// Its own values now (in its context they are in the world).
$.ctxOwnOf = function(conn) {
    var out = {};
    if ($.ctxOwnSave && $.ctxOwnSave.conn === conn) {
        $.CTX_OWN_SWITCHES.forEach(function(id) { if ($gameSwitches._data[id]) out[id] = true; });
        return out;
    }
    Object.keys(conn && conn._fhCtxSw || {}).forEach(function(id) { if (conn._fhCtxSw[id]) out[id] = true; });
    return out;
};

// Actor + belongings of a guest, sent so its menu shows the right things.
$.meData = function(conn) {
    var actor = $gameActors.actor(conn.actorId);
    if (actor && !conn.solo) $.giveProtagonistSkills(actor);
    return {
        t: 'me',
        actorId: conn.actorId,
        actor: actor ? ($.actorJson ? $.actorJson(actor) : $.jsonEx(actor)) : null,
        inv: $.inventoryOf(conn),
        syn: $.synOf(conn)
    };
};

// What a player has crafted (YEP_ItemSynthesis $gameSystem._synthedItems /
// Weapons / Armors: the crafting window shows "????" for the rest). The
// host's are in its $gameSystem; a guest's are kept in the host's save by
// name, and its PC puts them in its $gameSystem (a snapshot brings the
// host's). 0.41 audit.
$.SYN_KEYS = { i: '_synthedItems', w: '_synthedWeapons', a: '_synthedArmors' };

$.emptySyn = function() { return { i: [], w: [], a: [] }; };

// Ids only, each once.
$.cleanSyn = function(s) {
    var out = $.emptySyn();
    Object.keys($.SYN_KEYS).forEach(function(k) {
        ((s && s[k]) || []).forEach(function(id) {
            id = Number(id);
            if (id > 0 && out[k].indexOf(id) < 0) out[k].push(id);
        });
    });
    return out;
};

$.mergeSyn = function(a, b) {
    var out = $.cleanSyn(a), more = $.cleanSyn(b);
    Object.keys($.SYN_KEYS).forEach(function(k) {
        more[k].forEach(function(id) { if (out[k].indexOf(id) < 0) out[k].push(id); });
    });
    return out;
};

$.synOf = function(conn) {
    var all = $.coopData().synth || {};
    return $.cleanSyn(conn && all[conn.name]);
};

$.hostHandlers.synMe = function(conn, msg) {
    if (!conn.actorId || !msg || !msg.syn) return;
    var data = $.coopData();
    data.synth = data.synth || {};
    data.synth[conn.name] = $.mergeSyn(data.synth[conn.name], msg.syn);
};

$.mySyn = null;    // guest: its crafted ids (the host's record + synNew)
$.synNew = null;   // guest: crafted here, not yet in a record from the host

$.writeMySyn = function() {
    if (!$.mySyn || !$gameSystem) return;
    Object.keys($.SYN_KEYS).forEach(function(k) { $gameSystem[$.SYN_KEYS[k]] = $.mySyn[k].slice(); });
};

// The host's record counts (a new game starts empty), with what was made
// here since that the host has not seen yet.
$.takeSyn = function(syn) {
    var host = $.cleanSyn(syn), left = $.emptySyn();
    Object.keys($.SYN_KEYS).forEach(function(k) {
        ((($.synNew || {})[k]) || []).forEach(function(id) { if (host[k].indexOf(id) < 0) left[k].push(id); });
    });
    $.synNew = left;
    $.mySyn = $.mergeSyn(host, left);
    $.writeMySyn();
};

// Guest crafted something: its own record, and the host keeps it.
if (Game_System.prototype.addSynth) {
    var _Game_System_addSynth = Game_System.prototype.addSynth;
    Game_System.prototype.addSynth = function(item) {
        _Game_System_addSynth.call(this, item);
        if (!$.isGuest() || !$.myActorId || !item || this !== $gameSystem) return;
        var k = DataManager.isItem(item) ? 'i' : DataManager.isWeapon(item) ? 'w' : DataManager.isArmor(item) ? 'a' : '';
        if (!k) return;
        var add = $.emptySyn();
        add[k].push(item.id);
        $.synNew = $.mergeSyn($.synNew, add);
        $.mySyn = $.mergeSyn($.mySyn, add);
        if ($.conn) $.conn.send({ t: 'synMe', syn: $.mySyn });
    };
}

// A snapshot, a roam or a load put the host's $gameSystem here.
var _extractSaveContentsSyn = DataManager.extractSaveContents;
DataManager.extractSaveContents = function(contents) {
    _extractSaveContentsSyn.call(this, contents);
    if ($.isGuest()) $.writeMySyn();
};

var _leaveAsGuestSyn = $.leaveAsGuest;
$.leaveAsGuest = function(message) {
    $.mySyn = null;
    $.synNew = null;
    _leaveAsGuestSyn(message);
};

$.pushMe = function(conn) {
    if (!conn || !conn.actorId) return;
    var data = $.meData(conn);
    if (conn._needPos) {
        var pos = ($.coopData().pos || {})[conn.name];
        if (pos && pos.m === $gameMap.mapId()) data.pos = pos;
        conn._needPos = false;
    }
    var key = JSON.stringify([data.actor, data.inv, data.pos, data.syn]);
    if (key === conn._lastMeKey) return;
    conn._lastMeKey = key;
    conn.send(data);
};

// Everyone gets fresh data with each snapshot.
var _sendSnapshot = $.sendSnapshot;
$.sendSnapshot = function(conn) {
    _sendSnapshot(conn);
    $.snapshotTargets(conn).forEach(function(c) {
        c._lastMeKey = null;
        $.pushMe(c);
    });
};

// The saved position is given back once after a load and re-join.
var _sendAssign = $.sendAssign;
$.sendAssign = function(conn, actorId) {
    conn._needPos = true;
    _sendAssign(conn, actorId);
};

// Guest opened a menu with its own copy (hp + bag). When the menu closes the
// host keeps its current copy and adds only what the menu changed, so host
// changes made meanwhile (gifts, gunshots, its event) survive whatever order
// the messages arrive in.
$.hostHandlers.menuOpen = function(conn, msg) {
    var inv = msg.inv || {};
    conn._menuBase = {
        hp: Number(msg.hp) || 0,
        inv: { i: inv.i || {}, w: inv.w || {}, a: inv.a || {}, g: Number(inv.g) || 0 },
        at: $.clockMs ? $.clockMs() : 0
    };
};

$.hostHandlers.syncMe = function(conn, msg) {
    if (!conn.actorId || msg.actorId !== conn.actorId) return;
    var base = conn._menuBase;
    conn._menuBase = null;
    var before = $gameActors.actor(conn.actorId);
    var hostHp = before ? before.hp : 0;
    var parsed = msg.actor ? JsonEx.parse(msg.actor) : null;
    var menuHp = parsed ? parsed.hp : hostHp;
    if (parsed && parsed._actorId === conn.actorId) $gameActors._data[conn.actorId] = parsed;
    if (msg.inv) {
        var inv = $.inventoryOf(conn);
        var sent = { i: msg.inv.i || {}, w: msg.inv.w || {}, a: msg.inv.a || {}, g: Number(msg.inv.g) || 0 };
        if (base) {
            $.applyInvDelta(inv, base.inv, sent); // host copy + what the menu changed
        } else {
            inv.i = sent.i;
            inv.w = sent.w;
            inv.a = sent.a;
            inv.g = sent.g;
        }
    }
    var after = $gameActors.actor(conn.actorId);
    if (base && after) after.setHp(Math.max(0, Math.min(after.mhp, hostHp + (menuHp - base.hp))));
    conn._lastMeKey = null;
    $.pushMe(conn); // a 'me' sent while the menu was open was dropped
    if (conn.roam && conn._pendingCe && conn._pendingCe.length) {
        // its 'roam' left before this menu was seen: the guest runs its own
        // map now, so its items' events run there, once (FH_CoopRoam
        // 'ceRun'). Here they ran in the host's world for a guest no longer
        // in it, and its next roamMe dropped what they did (0.4 review 2 S1).
        conn.send({ t: 'ceRun', ids: conn._pendingCe.slice() });
    } else {
        (conn._pendingCe || []).forEach(function(id) { $.queueCommonEvent(conn, id); });
    }
    conn._pendingCe = [];
};

// inv += (now - base), per item kind
$.applyInvDelta = function(inv, base, now) {
    ['i', 'w', 'a'].forEach(function(k) {
        var keys = {};
        Object.keys(base[k] || {}).concat(Object.keys(now[k] || {})).forEach(function(id) { keys[id] = true; });
        Object.keys(keys).forEach(function(id) {
            var d = ((now[k] || {})[id] || 0) - ((base[k] || {})[id] || 0);
            if (!d) return;
            var n = (inv[k][id] || 0) + d;
            if (n > 0) inv[k][id] = n; else delete inv[k][id];
        });
    });
    inv.g = Math.max(0, inv.g + ((now.g || 0) - (base.g || 0)));
};

//=============================================================================
// Guest side: own character, own belongings
//=============================================================================

$.lastMe = null;

$.applyMe = function(msg) {
    if (!msg || !msg.actorId || msg.actorId !== $.myActorId) return;
    // its solo tutorial runs its own character: the host's copy is older (a
    // 'me' from fixLyingImages put the character back to before its history)
    var soloRuns = !!$.solo && !$.solo.waiting;
    if (msg.actor && !soloRuns) $gameActors._data[msg.actorId] = JsonEx.parse(msg.actor);
    if (msg.syn) $.takeSyn(msg.syn);
    if ($.isThin()) {
        $gameParty._actors = [msg.actorId];
        var inv = msg.inv || {};
        $gameParty._items = inv.i || {};
        $gameParty._weapons = inv.w || {};
        $gameParty._armors = inv.a || {};
        $gameParty._gold = Number(inv.g) || 0;
    }
    if (msg.pos && msg.pos.m === $gameMap.mapId()) {
        $gamePlayer.locate(msg.pos.x, msg.pos.y);
        $gamePlayer.setDirection(msg.pos.d || 2);
    }
    if ($gamePlayer) $gamePlayer.refresh();
};

$.guestHandlers.me = function(msg) {
    var keep = { t: msg.t, actorId: msg.actorId, actor: msg.actor, inv: msg.inv, pos: msg.pos, syn: msg.syn, mn: msg.mn };
    $.lastMe = keep;
    // In a menu the guest's own copy is the newer one; it is sent back when
    // the menu closes.
    if (!(SceneManager._scene instanceof Scene_Map)) return;
    if ($.pendingSnapshot) return; // applied after the snapshot
    $.applyMe(msg);
    $.lastMe.pos = null;
};

var _processPendingSnapshot = $.processPendingSnapshot;
$.processPendingSnapshot = function() {
    var had = !!$.pendingSnapshot;
    if (had && $.pm) {
        // the new $gameMessage never clears the old one: show it again
        $.pmQueue.unshift($.pm.msg);
        $.pm = null;
    }
    _processPendingSnapshot();
    if (had && $.lastMe) $.applyMe($.lastMe);
    // the snapshot's party is the host's: a thin guest's is its own character
    // even before any 'me' (a duel or a fight opened from it used the host's)
    if (had && $.isThin() && $.myActorId && $gameParty && $gameActors.actor($.myActorId)) {
        $gameParty._actors = [$.myActorId];
    }
};

$.sendSyncMe = function() {
    if (!$.conn || !$.myActorId || !$.isThin()) return;
    var actor = $gameActors.actor($.myActorId);
    $.conn.send({
        t: 'syncMe',
        actorId: $.myActorId,
        actor: actor ? $.jsonEx(actor) : null,
        inv: { i: $gameParty._items, w: $gameParty._weapons, a: $gameParty._armors, g: $gameParty._gold }
    });
};

// Menu, shop and so on change the guest's copy; send it back afterwards.
var _Scene_Map_start = Scene_Map.prototype.start;
Scene_Map.prototype.start = function() {
    _Scene_Map_start.call(this);
    $.menuOpenBase = null;
    if ($.isThin() && $.myActorId && $.returningFromSubScene) {
        $.returningFromSubScene = false;
        $.sendSyncMe();
        if ($.pendingShopReply) {
            $.conn.send({ t: 'pmsgDone', id: $.pendingShopReply });
            $.pendingShopReply = null;
        }
    }
};

var _Scene_Map_terminate = Scene_Map.prototype.terminate;
Scene_Map.prototype.terminate = function() {
    _Scene_Map_terminate.call(this);
    if ($.isThin() && SceneManager._nextScene instanceof Scene_MenuBase) {
        $.returningFromSubScene = true;
        var me = $gameActors.actor($.myActorId);
        var base = { hp: me ? me.hp : 0,
            inv: { i: $gameParty._items, w: $gameParty._weapons, a: $gameParty._armors, g: $gameParty._gold } };
        if ($.conn) $.conn.send({ t: 'menuOpen', hp: base.hp, inv: base.inv });
        // (a 'roam' that comes before the host saw this: FH_CoopRoam startRoam)
        $.menuOpenBase = JSON.parse(JSON.stringify(base));
    }
};

// Personal inventory UI: a guest with a character may open the menu.
var _Scene_Map_isMenuEnabled = Scene_Map.prototype.isMenuEnabled;
Scene_Map.prototype.isMenuEnabled = function() {
    if ($.isThin()) {
        return !!$.myActorId && !$.pm && !$.pmQueue.length && !$.myEventRunning &&
            !$gameMessage.isBusy() && !$.isDownMe();
    }
    return _Scene_Map_isMenuEnabled.call(this);
};

// Thin guests: Scene_Map.callMenu checks isEventRunning (always false).
// Common events started from items run on the host for this guest.
var _Game_Temp_reserveCommonEvent = Game_Temp.prototype.reserveCommonEvent;
Game_Temp.prototype.reserveCommonEvent = function(id) {
    if ($.isThin() && $.conn) {
        // hotkeys repeat while held: one request per event and half second
        var inMenu = !(SceneManager._scene instanceof Scene_Map);
        if (!inMenu) {
            if (id === $.lastCeId && Graphics.frameCount - $.lastCeFrame < 30) return;
            $.lastCeId = id;
            $.lastCeFrame = Graphics.frameCount;
        }
        $.conn.send({ t: 'ce', id: id, menu: inMenu });
        if (inMenu) $.menuCeSent = true;
        return;
    }
    _Game_Temp_reserveCommonEvent.call(this, id);
};

// The original closes the menu when a used skill or item reserved a common
// event (Scene_ItemBase.checkCommonEvent), so the event runs on the map. A
// thin guest's goes to the host, which waits for the menu to close: the menu
// stayed open and nothing came (play test 2026-10-31: Marina's Engrave on
// herself, OK in the target window - "the guest froze").
var _checkCommonEventThin = Scene_ItemBase.prototype.checkCommonEvent;
Scene_ItemBase.prototype.checkCommonEvent = function() {
    if ($.isThin() && $.menuCeSent) {
        $.menuCeSent = false;
        SceneManager.goto(Scene_Map);
        return;
    }
    _checkCommonEventThin.call(this);
};

var _startMenuCe = Scene_Map.prototype.start;
Scene_Map.prototype.start = function() {
    _startMenuCe.call(this);
    $.menuCeSent = false;
};

// Only the host saves.
if (Window_MenuCommand.prototype.isSaveEnabled) {
    var _isSaveEnabled = Window_MenuCommand.prototype.isSaveEnabled;
    Window_MenuCommand.prototype.isSaveEnabled = function() {
        if ($.isGuest()) return false;
        return _isSaveEnabled.call(this);
    };
}

var _Scene_Save_onSavefileOk = Scene_Save.prototype.onSavefileOk;
Scene_Save.prototype.onSavefileOk = function() {
    if ($.isGuest()) {
        SoundManager.playBuzzer();
        this.activateListWindow();
        $.toast('Co-op: only the host can save');
        return;
    }
    _Scene_Save_onSavefileOk.call(this);
};

//=============================================================================
// Guest-run events (host side)
//=============================================================================

$.owned = {};          // guestId -> { interp, ev }
$.ownedQueue = {};     // guestId -> [common event ids] (sanity checks etc.)
$.nextWaitId = 1;

$.isBusy = function(conn) {
    return !!$.owned[conn.guestId] || !!conn.inBattle || !!conn.waitingConsent;
};

// Time passes: CE303 (DAYS_GO_BY) / CE305 (WakeUP), or a bed. A bed's
// first page only turns SW463 SLEEPING on; its autorun page then takes the
// sleeper to the dream (Map032), whose EV7 runs CE303 (the new day). So a bed
// needs the vote too (before, a guest's bed passed the day for everyone
// without asking). Co-op rule: players sharing a map agree together; players
// on other maps join by lying down themselves. Each player uses its own dream
// and Hexen board; the day changes once (FH_CoopRoam; SW463 is each player's
// own).
$.SLEEPING_SWITCH = 463;
$.pageStartsSleep = function(list) {
    return list.some(function(cmd) {
        var p = cmd.parameters;
        return cmd.code === 121 && p[2] === 0 && p[0] <= $.SLEEPING_SWITCH && p[1] >= $.SLEEPING_SWITCH;
    });
};
$.pageNeedsConsent = function(list) {
    return list.some(function(cmd) {
        if (cmd.code === 117 && (cmd.parameters[0] === 303 || cmd.parameters[0] === 305)) return true;
        var p = cmd.parameters;
        return cmd.code === 121 && p[2] === 0 && p[0] <= $.SLEEPING_SWITCH && p[1] >= $.SLEEPING_SWITCH;
    });
};

// Guest page of an event: page conditions use the guest's SELECT switch.
$.guestPage = function(conn, ev) {
    var index = $.inContext(conn, function() { return ev.findProperPageIndex(); });
    return index >= 0 ? { index: index, page: ev.event().pages[index] } : null;
};

$.lockToward = function(ev, character) {
    if (ev._locked) return;
    ev._prelockDirection = ev.direction();
    if (character) ev.turnTowardCharacter(character);
    ev._locked = true;
};

// hooks other plugins fill: return true when they took the event over
$.eventStartHooks = $.eventStartHooks || [];

$.SHARE_GUEST_SCENES = false;

// The host's own run of this event (another of its pages) is going on: a
// guest's page of it waits. Not while that run waits at the sleep barrier
// (FH_CoopRoam, wait mode 'fhSleep'): the host's move into its dream is a
// page of the same bed as a guest's scene before its dream (Map005 EV114:
// the host's dream page, Marina's Samarie page 4) and waits for that scene.
$.hostRunHolds = function(ev) {
    var interp = $gameMap._interpreter;
    return interp.isRunning() && interp.eventId() === ev.eventId() && interp._waitMode !== 'fhSleep';
};

$.startEventFor = function(conn, ev, triggers, normal) {
    if (!conn || !conn.actorId || $.isBusy(conn) || $.isDown(conn.guestId)) return false;
    if (ev._erased) return false;
    var found = $.guestPage(conn, ev);
    if (!found) return false;
    var page = found.page;
    if (triggers && triggers.indexOf(page.trigger) < 0) return false;
    if (normal !== undefined && (page.priorityType === 1) !== normal) return false;
    if (!page.list || page.list.length <= 1) return false;
    // hooks first: walking into an enemy someone is fighting joins that fight
    for (var i = 0; i < $.eventStartHooks.length; i++) {
        if ($.eventStartHooks[i](conn, ev, page)) return true;
    }
    if (ev._fhOwner || ev._locked || ev._starting) return false;
    if ($.hostRunHolds(ev)) return false;
    var start = function() {
        // A story scene on the same page the host sees used to be shared
        // with everyone through the host's own interpreter. Off: the host's
        // screen got the guest's dialogue and waited on it (the guest never
        // saw it). What a guest starts plays on its own screen; autorun and
        // parallel scenes are still shared.
        if ($.SHARE_GUEST_SCENES && $.isHost() && found.index === ev._pageIndex && $.isCutscenePage(page) &&
                !$gameMap.isEventRunning() &&
                !$gameParty.inBattle() && !$.bgUpdate && SceneManager._scene instanceof Scene_Map) {
            ev._fhConsented = true;
            ev._fhStarter = conn.guestId; // that guest runs the dialogue
            $.asHost(function() { ev.start(); });
            return;
        }
        $.runOwned(conn, page.list, ev);
    };
    if ($.pageNeedsConsent(page.list) && page.trigger <= 2) {
        $.requestConsent(conn.guestId, start, {
            sleep: $.pageStartsSleep(page.list), mapId: $gameMap.mapId(), eventId: ev.eventId()
        });
    } else {
        start();
    }
    return true;
};

$.runOwned = function(conn, list, ev) {
    var interp = new Game_Interpreter();
    interp._fhOwner = conn.guestId;
    interp.setup(list, ev ? ev.eventId() : 0);
    if (ev) {
        ev._fhOwner = conn.guestId;
        $.lockToward(ev, $.remotes[conn.guestId]);
    }
    $.owned[conn.guestId] = { interp: interp, ev: ev };
    conn.send({ t: 'evRun', on: true });
    $.dlog('guest event', conn.name, ev ? 'ev' + ev.eventId() : 'common');
};

$.finishOwned = function(id) {
    var entry = $.owned[id];
    if (!entry) return;
    delete $.owned[id];
    if (entry.ev) {
        entry.ev._fhOwner = null;
        // an event of a map the host has left meanwhile (Map004 EV58, the
        // guest's grab fight lost after the host went to Map013): its data is
        // gone, turning it back crashed in YEP_SaveEventLocations (2026-11-01)
        if ($gameMap.event(entry.ev.eventId()) === entry.ev) entry.ev.unlock();
        else entry.ev._locked = false;
    }
    var conn = $.clientById(id);
    if (conn) {
        conn._choiceMods = null;
        conn.send({ t: 'evRun', on: false });
        if (entry.audio && $.audioInfo) conn.send({ t: 'au', au: $.audioInfo() });
    }
    $.pushMe(conn);
};

// The host's music again after its event changed it (thin: it plays the
// host's map; its own map plays its own).
$.guestHandlers.au = function(msg) {
    if (msg && msg.au && $.isThin() && $.applyAudio) $.applyAudio(msg.au);
};

$.updateOwned = function() {
    Object.keys($.owned).forEach(function(id) {
        var entry = $.owned[id];
        var conn = $.clientById(id);
        if (!conn || !conn.actorId) {
            $.finishOwned(id);
            return;
        }
        $.enterContext(conn);
        $.causeSkip = !!entry.queued; // sanity checks, items: nobody's door
        $.ownedSwEntry = entry; // (a switch turned: its look again, $.refreshLookOf at the end)
        try {
            entry.interp.update();
        } catch (e) {
            $.dlog('ERROR guest event', e.stack || String(e));
            entry.interp.clear();
        } finally {
            $.ownedSwEntry = null;
            $.causeSkip = false;
            $.exitContext();
        }
        if (!entry.interp.isRunning() && !$.ownedLoops(entry, id)) $.finishOwned(id);
    });
    // Queued common events (sanity checks after the group moved, items)
    Object.keys($.ownedQueue).forEach(function(id) {
        var conn = $.clientById(id);
        var queue = $.ownedQueue[id];
        if (!conn || !queue.length || $.isDead(id)) {
            delete $.ownedQueue[id];
            return;
        }
        // a down player runs nothing (they made it the dialogue's "busy"
        // owner every few seconds: 2026-10-20); they wait for the revive
        if ($.isBusy(conn) || $.isDown(id)) return;
        var ce = $dataCommonEvents[queue.shift()];
        if (ce) {
            $.runOwned(conn, ce.list, null);
            $.owned[id].queued = true;
        }
    });
};

$.queueCommonEvent = function(conn, id) {
    ($.ownedQueue[conn.guestId] = $.ownedQueue[conn.guestId] || []).push(id);
};

// Items are used in the guest's menu; their common events run once the
// guest is back on the map and its inventory came back (syncMe), so the
// event does not work on an old copy.
$.hostHandlers.ce = function(conn, msg) {
    if (!$dataCommonEvents[msg.id]) return;
    if (!msg.menu) {
        $.queueCommonEvent(conn, msg.id);
        return;
    }
    (conn._pendingCe = conn._pendingCe || []).push(msg.id);
};

// Guest pressed OK / walked onto something (thin client).
$.actHooks = $.actHooks || [];
$.hostHandlers.act = function(conn, msg) {
    if (!$.guestOnMap(conn) || msg.m !== $gameMap.mapId()) return;
    if (!$dataMap || SceneManager.isSceneChanging()) return; // the host is loading a map
    for (var i = 0; i < $.actHooks.length; i++) {
        if ($.actHooks[i](conn, msg)) return;
    }
    $gameMap.eventsXy(msg.x, msg.y).some(function(ev) {
        return $.startEventFor(conn, ev, msg.tr, msg.n);
    });
};

var _Game_Player_startMapEvent = Game_Player.prototype.startMapEvent;
Game_Player.prototype.startMapEvent = function(x, y, triggers, normal) {
    if ($.isThin()) {
        if ($.conn && $.myActorId && !$.pm && !$.isDownMe()) {
            var key = [x, y, triggers.join(), normal].join(',');
            if (key !== $.lastActKey || Graphics.frameCount - $.lastActFrame > 20) {
                $.lastActKey = key;
                $.lastActFrame = Graphics.frameCount;
                $.conn.send({ t: 'act', m: $gameMap.mapId(), x: x, y: y, tr: triggers, n: normal });
            }
        }
        return;
    }
    _Game_Player_startMapEvent.call(this, x, y, triggers, normal);
};

//-----------------------------------------------------------------------------
// Interpreter: what changes when it runs for a guest
//-----------------------------------------------------------------------------

Game_Interpreter.prototype.fhOwner = function() {
    return this._fhOwner || null;
};

var _setupChild = Game_Interpreter.prototype.setupChild;
Game_Interpreter.prototype.setupChild = function(list, eventId) {
    _setupChild.call(this, list, eventId);
    if (this._fhOwner) this._childInterpreter._fhOwner = this._fhOwner;
};

// "Player" means the guest's avatar.
var _character = Game_Interpreter.prototype.character;
Game_Interpreter.prototype.character = function(param) {
    if (this._fhOwner && param < 0 && !$gameParty.inBattle()) {
        return $.remotes[this._fhOwner] || null;
    }
    return _character.call(this, param);
};

var _updateWaitMode = Game_Interpreter.prototype.updateWaitMode;
Game_Interpreter.prototype.updateWaitMode = function() {
    if (this._waitMode === 'fhRemote') {
        if (this._fhWaitId) return true;
        this._waitMode = '';
        return false;
    }
    return _updateWaitMode.call(this);
};

$.waitRemote = function(interp, msg) {
    var id = $.nextWaitId++;
    msg.id = id;
    interp._fhWaitId = id;
    interp.setWaitMode('fhRemote');
    $.sendTo(interp._fhOwner, msg);
    return id;
};

// Find the waiting interpreter (an event or one of its common events).
$.findWaiting = function(owner, id) {
    var entry = $.owned[owner];
    var interp = entry && entry.interp;
    while (interp) {
        if (interp._fhWaitId === id) return interp;
        interp = interp._childInterpreter;
    }
    return $.extraWaiters && $.extraWaiters[id] || null;
};

// Show Text (+ the choice / number / item that follows it) on the guest.
Game_Interpreter.prototype.fhRemoteMessage = function(withText) {
    var msg = { t: 'pmsg', tx: [], f: '', fi: 0, bg: 0, p: 2 };
    if (withText) {
        msg.f = this._params[0];
        msg.fi = this._params[1];
        msg.bg = this._params[2];
        msg.p = this._params[3];
        while (this.nextEventCode() === 401) {
            this._index++;
            msg.tx.push($.convertForGuest(this.currentCommand().parameters[0]));
        }
    }
    var next = withText ? this.nextEventCode() : this.currentCommand().code;
    var params = withText ? (this._list[this._index + 1] || {}).parameters : this._params;
    if (next === 102 && this.combineChoices) {
        // HIME_LargeChoices: back-to-back choice blocks are one list
        if (withText) this._index++;
        params = this.combineChoices();
        if (withText) this._index--;
    }
    if (next === 102) {
        var mods = $.takeChoiceMods();
        msg.ch = params[0].map(function(text, i) {
            return $.convertForGuest(mods.text[i] !== undefined ? mods.text[i] : text);
        });
        msg.dis = mods.dis;
        msg.ct = params[1];
        msg.dt = params.length > 2 ? params[2] : 0;
        msg.cp = params.length > 3 ? params[3] : 2;
        msg.cb = params.length > 4 ? params[4] : 0;
        this._fhPending = { type: 'choice', cancel: params[1] };
        if (withText) this._index++;
    } else if (next === 103) {
        msg.num = { v: params[0], d: params[1], cur: $gameVariables.value(params[0]) };
        this._fhPending = { type: 'num', v: params[0] };
        if (withText) this._index++;
    } else if (next === 104) {
        msg.item = { v: params[0], k: params[1] || 2 };
        this._fhPending = { type: 'item', v: params[0] };
        if (withText) this._index++;
    } else {
        this._fhPending = null;
    }
    if (next !== 102) $.takeChoiceMods(); // vanilla clears them with the message
    this._index++;
    $.waitRemote(this, msg);
    return false;
};

// \V[n], \N[n], \P[n] are the host's values (the guest's copy is old).
$.convertForGuest = function(text) {
    text = String(text);
    for (var i = 0; i < 2; i++) {
        text = text.replace(/\\V\[(\d+)\]/gi, function(m, n) { return $gameVariables.value(Number(n)); });
    }
    text = text.replace(/\\N\[(\d+)\]/gi, function(m, n) {
        var actor = Number(n) >= 1 ? $gameActors.actor(Number(n)) : null;
        return actor ? actor.name() : '';
    });
    text = text.replace(/\\P\[(\d+)\]/gi, function(m, n) {
        var actor = $gameParty.members()[Number(n) - 1];
        return actor ? actor.name() : '';
    });
    return text;
};

// disable_choice / choice_text inside a guest's event belong to that guest's
// next choice list, not to the host's message box.
$.takeChoiceMods = function() {
    var conn = $.ctx;
    var mods = conn && conn._choiceMods || { dis: {}, text: {} };
    if (conn) conn._choiceMods = null;
    return mods;
};

$.choiceModsOf = function() {
    var conn = $.ctx;
    if (!conn._choiceMods) conn._choiceMods = { dis: {}, text: {} };
    return conn._choiceMods;
};

if (Game_Message.prototype.disableChoice) {
    var _disableChoice = Game_Message.prototype.disableChoice;
    Game_Message.prototype.disableChoice = function(choiceNum, bool) {
        if ($.runsWorld() && $.ctx) {
            $.choiceModsOf().dis[choiceNum] = bool;
            return;
        }
        _disableChoice.call(this, choiceNum, bool);
    };
}

if (Game_Message.prototype.setChoiceText) {
    var _setChoiceText = Game_Message.prototype.setChoiceText;
    Game_Message.prototype.setChoiceText = function(choiceNum, text) {
        if ($.runsWorld() && $.ctx) {
            $.choiceModsOf().text[choiceNum] = text;
            return;
        }
        _setChoiceText.call(this, choiceNum, text);
    };
}

var _command101 = Game_Interpreter.prototype.command101;
Game_Interpreter.prototype.command101 = function() {
    if (this._fhOwner && $.runsWorld()) return this.fhRemoteMessage(true);
    return _command101.call(this);
};

['102', '103', '104'].forEach(function(code) {
    var base = Game_Interpreter.prototype['command' + code];
    Game_Interpreter.prototype['command' + code] = function() {
        if (this._fhOwner && $.runsWorld()) return this.fhRemoteMessage(false);
        return base.call(this);
    };
});

$.hostHandlers.pmsgDone = function(conn, msg) {
    var interp = $.findWaiting(conn.guestId, msg.id);
    if (!interp) return;
    var pending = interp._fhPending;
    interp._fhPending = null;
    if (pending && pending.type === 'choice') {
        var n = Number(msg.choice);
        interp._branch[interp._indent] = isNaN(n) ? pending.cancel : n;
    } else if (pending && (pending.type === 'num' || pending.type === 'item')) {
        $gameVariables.setValue(pending.v, Number(msg.value) || 0);
    }
    interp._fhWaitId = 0;
    if ($.extraWaiters) delete $.extraWaiters[msg.id];
};

// Screen, picture and sound commands play on the guest's screen. Scroll Map
// (204) moves that guest's view, not the host's (0.38.3: "the player" of a
// guest's event is never the host).
$.FORWARD_CODES = [221, 222, 223, 224, 225, 231, 232, 233, 234, 235, 241, 242, 243,
    244, 245, 246, 249, 250, 251, 204];
// Commands that only make sense when the whole group is involved, and
// Change Menu Access (135: a guest's bed turned the host's menu off), the
// player's followers (216 Change Player Followers, 217 Gather Followers: the
// ladders, Map020 EV104/108, hid and gathered the host's), Change Save Access
// (134: whether the host can save is the host's; in the data only Map004
// EV230's arrival scenes, every character's page - final review B10).
$.IGNORE_FOR_GUEST = [129, 134, 135, 351, 352, 354, 216, 217];
// Music a guest's event plays goes to that guest (FORWARD_CODES); the
// host's map music never changed. At the event's end that guest gets the
// host's music back (final review B9: the event's music stayed).
$.AUDIO_CODES = { 241: 1, 242: 1, 243: 1, 244: 1, 245: 1, 246: 1 };

$.forwardWait = function(interp, code, p) {
    switch (code) {
    case 221: case 222: return interp.fadeSpeed();
    case 223: return p[2] ? p[1] : 0;
    case 224: return p[2] ? p[1] : 0;
    case 225: return p[3] ? p[2] : 0;
    case 232: return p[11] ? p[10] : 0;
    case 234: return p[3] ? p[2] : 0;
    }
    return 0;
};

var _executeCommand = Game_Interpreter.prototype.executeCommand;
Game_Interpreter.prototype.executeCommand = function() {
    if (this._fhOwner && $.runsWorld()) {
        var command = this.currentCommand();
        if (command) {
            var code = command.code;
            if ($.FORWARD_CODES.indexOf(code) >= 0) {
                $.sendTo(this._fhOwner, { t: 'cmd', c: code, p: command.parameters });
                var entry = $.AUDIO_CODES[code] && $.owned[this._fhOwner];
                if (entry) entry.audio = true;
                var w = $.forwardWait(this, code, command.parameters);
                this._index++;
                if (w > 0) this.wait(w);
                return true;
            }
            if (code === 211 || ((code === 212 || code === 213) && command.parameters[0] < 0)) {
                $.sendTo(this._fhOwner, { t: 'cmd', c: code, p: command.parameters });
                // the others see it on its character too (a gun's shot)
                var shown = $.remotes[this._fhOwner];
                if (code === 212 && shown) shown.requestAnimation(command.parameters[1]);
                this._index++;
                return true;
            }
            if (code === 205 && command.parameters[0] < 0) {
                this._index++;
                var route = command.parameters[1];
                if (route && route.wait) {
                    $.waitRemote(this, { t: 'route', p: command.parameters });
                    return false;
                }
                $.sendTo(this._fhOwner, { t: 'cmd', c: code, p: command.parameters });
                return true;
            }
            if ($.IGNORE_FOR_GUEST.indexOf(code) >= 0) {
                this._index++;
                return true;
            }
            if (code === 302) {
                // the engine sets these only when it runs the command
                this._params = command.parameters;
                this._indent = command.indent;
                return this.fhGuestShop();
            }
        }
    }
    return _executeCommand.call(this);
};

// A shop opens on the guest's screen with its own money and items.
Game_Interpreter.prototype.fhGuestShop = function() {
    var goods = [this._params];
    while (this.nextEventCode() === 605) {
        this._index++;
        goods.push(this.currentCommand().parameters);
    }
    this._index++;
    $.waitRemote(this, { t: 'shop', goods: goods, po: !!this._params[4] });
    return false;
};

// "The player" of a guest's event is that guest, never the host (0.38.3-pre5
// ladder report; the 0.35.2 door fix was the same family). Already that
// guest's: Transfer (201, FH_CoopRoam fhGuestTransfer), Set Move Route on the
// player (205), transparency / animation / balloon (211-213), Scroll Map
// (204, FORWARD_CODES), the followers (216/217, ignored), "player X / Y" and
// "player faces" (character(-1) is its avatar). Here: Set Event Location on
// the player (203) places that guest, and a script (355) that reads
// $gamePlayer (Galv.SPAWN.event(n, $gamePlayer.x, $gamePlayer.y): CE169
// BONESAW and 200 more) sees the guest's avatar, not the host.
var _command203Guest = Game_Interpreter.prototype.command203;
Game_Interpreter.prototype.command203 = function() {
    if (this._fhOwner && $.runsWorld() && this._params[0] < 0 && !$gameParty.inBattle()) {
        return this.fhGuestLocate();
    }
    return _command203Guest.call(this);
};

Game_Interpreter.prototype.fhGuestLocate = function() {
    var p = this._params;
    var conn = $.clientById(this._fhOwner);
    var remote = $.remotes[this._fhOwner];
    if (!conn || !remote) return true;
    var x, y;
    if (p[1] === 0) {
        x = p[2];
        y = p[3];
    } else if (p[1] === 1) {
        x = $gameVariables.value(p[2]);
        y = $gameVariables.value(p[3]);
    } else {
        var other = this.character(p[2]);
        if (!other || other === remote) return true;
        x = other.x;
        y = other.y;
        other.locate(remote.x, remote.y);
    }
    var d = p[4] > 0 ? p[4] : 0;
    remote.setPosition(x, y);
    if (d) remote._direction = d;
    conn.send({ t: 'place', x: x, y: y, d: d });
    conn.lastPos = Object.assign({}, conn.lastPos || {}, { x: x, y: y });
    if (d) conn.lastPos.d = d;
    $.dlog('guest event places', conn.name, 'at', x + ',' + y, '(Set Event Location on the player)');
    return true;
};

var _command355Guest = Game_Interpreter.prototype.command355;
Game_Interpreter.prototype.command355 = function() {
    var remote = this._fhOwner && $.runsWorld() && !$gameParty.inBattle() && !$.realPlayer ?
        $.remotes[this._fhOwner] : null;
    if (!remote) return _command355Guest.call(this);
    var self = this;
    return $.withPlayer({ id: this._fhOwner, ch: remote }, function() { return _command355Guest.call(self); });
};

// Game over in a guest's event: the guest is down, not the whole game.
var _command353 = Game_Interpreter.prototype.command353;
Game_Interpreter.prototype.command353 = function() {
    if (this._fhOwner && $.runsWorld()) {
        if ($.onPlayerDefeated) $.onPlayerDefeated(this._fhOwner);
        this._index = this._list.length;
        return true;
    }
    return _command353.call(this);
};

// Party changes: every player's party is just its own character.
var _command129 = Game_Interpreter.prototype.command129;
Game_Interpreter.prototype.command129 = function() {
    if ($.isHost() && $.clients.some(function(c) { return c.actorId; })) {
        var actorId = this._params[0];
        if (this._params[1] === 0) return true; // no companions in co-op
        if ($.isHumanActor(actorId)) return true; // nobody removes a player
    }
    return _command129.call(this);
};

$.isHumanActor = function(actorId) {
    if (actorId === $.hostActorId()) return true;
    return $.clients.some(function(c) { return c.actorId === actorId; });
};

//-----------------------------------------------------------------------------
// Companions: recruiting is answered as "your party is full" (decision A)
//-----------------------------------------------------------------------------
// Blocking the party add alone left the recruit events running: they set
// Olivia_joined (SW2802), Marcoh_gone (2788), karin_joined (3611), the
// *_waiting_train switches off and so on, so the NPC left the world without
// being in anybody's party and its story (moonscorching, death, V201) never
// came. Every recruit asks the party size first (CE49 Party_Check -> V34
// PartySize): "IF V34 < 4" (Map004 EV223/226/322/323, Map014 EV72/80/84/85/
// 147/148/203/204/208-214, Map067, Map105, Map118 EV142/146, CE73 demon seed,
// Map005 EV153 Kalev, Map037 EV518 Marina ...; "< 3" for Karin + Marina in
// Map039) whose ELSE branch is the original decline ("your party is pretty
// crowded"); necromancy asks "IF V34 >= 4" -> "no room for ghouls" in events
// that call CE57 NECROMANCY_CHECK_UP. In co-op these checks answer "full", so
// the NPC declines and stays where the original leaves a declined NPC, and
// none of the join flags change. The blood golem (CE501 "V34 <= 3") is not a
// room check here: it has its own co-op rules (FH_CoopRoam).
$.PARTY_SIZE_VAR = 34;
$.NECROMANCY_CHECK_CE = 57;
$.recruitLogged = {};

$.companionsBlocked = function() {
    if ($.isRoaming && $.isRoaming()) return true; // its own map (and sub-hosts)
    if ($.isGuest() && $.solo) return true;        // tutorial on its own PC
    return $.isHost() && $.clients.some(function(c) { return c.actorId; });
};

// Party-size check at list[index]: 'room' (V34 < n), 'full' (necromancy's
// V34 >= 4) or '' (anything else that reads V34, e.g. the Hexen board).
$.partyRoomCheck = function(list, index) {
    var cmd = list && list[index];
    var p = cmd && cmd.parameters;
    if (!p || cmd.code !== 111 || p[0] !== 1 || p[1] !== $.PARTY_SIZE_VAR || p[2] !== 0) return '';
    if (p[4] === 4) return 'room';
    if (p[4] === 1 && p[3] === 4 && list.some(function(c) {
        return c.code === 117 && c.parameters[0] === $.NECROMANCY_CHECK_CE;
    })) return 'full';
    return '';
};

var _command111Recruit = Game_Interpreter.prototype.command111;
Game_Interpreter.prototype.command111 = function() {
    var kind = this._params[0] === 1 && this._params[1] === $.PARTY_SIZE_VAR && $.companionsBlocked() ?
        $.partyRoomCheck(this._list, this._index) : '';
    if (kind) {
        var result = kind === 'full'; // the party counts as full
        this._branch[this._indent] = result;
        if (!result) this.skipBranch();
        // once per place: CE73 (demon seed) is a parallel event
        var key = this._mapId + '/' + this._eventId + '/' + this._index + '/' + this._list.length;
        if (!$.recruitLogged[key]) {
            $.recruitLogged[key] = true;
            $.dlog('companion check answered "party full"', 'map', this._mapId, 'event', this._eventId,
                'line', this._index);
        }
        return true;
    }
    // "Button pressed" in a guest's event: that guest's keys now, as the
    // original reads the keyboard now (no waiting: the clock puzzle checks
    // ok, right, left, down, up, cancel in turn every frame, Map084 EV188;
    // the Lucky coin's Shift while choosing heads or tails, 67 chests)
    if (this._fhOwner && $.runsWorld() && this._params[0] === 11) {
        var pressed = $.guestPressed($.clientById(this._fhOwner), String(this._params[1] || ''));
        this._branch[this._indent] = pressed;
        if (!pressed) this.skipBranch();
        return true;
    }
    return _command111Recruit.call(this);
};

// A guest's keys while its event runs on the host: the guest sends them when
// they change ('keys'). One let go a moment ago still counts: a short tap may
// be over before the event's next check reaches it (the clock puzzle waits
// 15 frames after each move, longer than this).
$.REMOTE_BUTTON_KEYS = { ok: true, cancel: true, shift: true, up: true, down: true, left: true, right: true };
$.KEY_HOLD_MS = 150;

$.hostHandlers.keys = function(conn, msg) {
    var now = $.clockMs(), was = conn.heldKeys || {}, down = {};
    (msg && Array.isArray(msg.k) ? msg.k : []).forEach(function(k) { if ($.REMOTE_BUTTON_KEYS[k]) down[k] = true; });
    conn.keyUpAt = conn.keyUpAt || {};
    Object.keys(was).forEach(function(k) { if (!down[k]) conn.keyUpAt[k] = now; });
    conn.heldKeys = down;
};

$.guestPressed = function(conn, key) {
    if (!conn) return false;
    if (conn.heldKeys && conn.heldKeys[key]) return true;
    var up = conn.keyUpAt && conn.keyUpAt[key];
    return !!up && $.clockMs() - up < $.KEY_HOLD_MS;
};

// Sanity checks on entering a map also apply to the guests there.
var _command117 = Game_Interpreter.prototype.command117;
Game_Interpreter.prototype.command117 = function() {
    var id = this._params[0];
    if (id === 303 && $.role) {
        $.dlog('day passes (CE303) on map', $gameMap.mapId(), 'for', this._fhOwner || ($.isHost() ? 'host' : 'this PC'),
            'times', [1501, 1502, 1503].map(function(s) { return $gameSwitches.value(s) ? 1 : 0; }).join(''));
    }
    if ($.runsWorld()) {
        if ($.GUN_CES[id]) $.pendingGun = $.GUN_CES[id];
        if (!this._fhOwner && id >= 372 && id <= 376 && !$gameParty.inBattle()) {
            $.activeGuests().forEach(function(c) {
                if ($.guestOnMap(c)) $.queueCommonEvent(c, id);
            });
        }
    }
    return _command117.call(this);
};

//-----------------------------------------------------------------------------
// Guest side: personal messages, forwarded commands, shops
//-----------------------------------------------------------------------------

$.pm = null;       // personal message on screen: { id, choice }
$.pmQueue = [];

$.guestHandlers.pmsg = function(msg) {
    $.pmQueue.push(msg);
};

// While its event runs on the host: the keys held, sent when they change
// (none again when it ends).
$.sentKeys = '';
$.updateRemoteButtons = function() {
    if (!$.isGuest() || !$.conn) return;
    var down = $.myEventRunning ? Object.keys($.REMOTE_BUTTON_KEYS).filter(function(k) { return Input.isPressed(k); }) : [];
    var key = down.join();
    if (key === $.sentKeys) return;
    $.sentKeys = key;
    $.conn.send({ t: 'keys', k: down });
};

$.showNextPersonal = function() {
    if ($.pm || !$.pmQueue.length || $gameMessage.isBusy()) return;
    var msg = $.pmQueue.shift();
    $.pm = { id: msg.id, choice: null, msg: msg };
    $gameMessage.setFaceImage(msg.f || '', msg.fi || 0);
    $gameMessage.setBackground(msg.bg || 0);
    $gameMessage.setPositionType(msg.p === undefined ? 2 : msg.p);
    (msg.tx || []).forEach(function(line) { $gameMessage.add(line); });
    if (msg.ch) {
        var cancel = msg.ct >= msg.ch.length ? -2 : msg.ct;
        $gameMessage.setChoices(msg.ch, msg.dt >= msg.ch.length ? -1 : (msg.dt || 0), cancel);
        $gameMessage.setChoiceBackground(msg.cb || 0);
        $gameMessage.setChoicePositionType(msg.cp === undefined ? 2 : msg.cp);
        $gameMessage.setChoiceCallback(function(n) { if ($.pm) $.pm.choice = n; });
        if (msg.dis && $gameMessage.disableChoice) {
            Object.keys(msg.dis).forEach(function(k) { $gameMessage.disableChoice(Number(k), msg.dis[k]); });
        }
    } else if (msg.num) {
        $gameVariables._data[msg.num.v] = msg.num.cur || 0;
        $gameMessage.setNumberInput(msg.num.v, msg.num.d);
    } else if (msg.item) {
        $gameMessage.setItemChoice(msg.item.v, msg.item.k);
    }
    if (!$gameMessage.isBusy()) $.finishPersonal(); // nothing to show
};

$.finishPersonal = function() {
    var pm = $.pm;
    if (!pm) return;
    $.pm = null;
    var reply = { t: 'pmsgDone', id: pm.id, choice: pm.choice };
    if (pm.msg.num) reply.value = $gameVariables.value(pm.msg.num.v);
    if (pm.msg.item) reply.value = $gameVariables.value(pm.msg.item.v);
    if ($.isHost()) {
        $.hostHandlers.pmsgDone({ guestId: 'host' }, reply);
    } else if ($.conn) {
        $.conn.send(reply);
    }
};

// (A new Game_Message clears itself in initialize, before its fields exist:
// DataManager.createGameObjects while a personal message was on screen, e.g.
// $.startRoam, threw "Cannot read property 'length' of undefined" - guest
// log 2026-10-19. That new one never showed the message: nothing closes.)
var _Game_Message_clear = Game_Message.prototype.clear;
Game_Message.prototype.clear = function() {
    var closing = $.pm && this._texts && (this._texts.length || (this._choices || []).length ||
        this._numInputVariableId || this._itemChoiceVariableId);
    _Game_Message_clear.call(this);
    if (closing) $.finishPersonal();
};

// Personal messages use the normal input, not the shared-dialogue vote.
var _fhGuestInput = Window_Message.prototype.updateFHCoopGuestInput;
Window_Message.prototype.updateFHCoopGuestInput = function() {
    if ($.pm) return $.baseUpdateInput.call(this);
    return _fhGuestInput.call(this);
};
// The engine's own Window_Message.updateInput (the co-op one adds votes).
$.baseUpdateInput = function() {
    if (this.isAnySubWindowActive()) return true;
    if (this.pause) {
        if (this.isTriggered()) {
            Input.update();
            this.pause = false;
            if (!this._textState) this.terminateMessage();
        }
        return true;
    }
    return false;
};

var _callOk = Window_ChoiceList.prototype.callOkHandler;
Window_ChoiceList.prototype.callOkHandler = function() {
    if ($.pm) {
        $gameMessage.onChoice(this.index());
        this._messageWindow.terminateMessage();
        this.close();
        return;
    }
    _callOk.call(this);
};

var _callCancel = Window_ChoiceList.prototype.callCancelHandler;
Window_ChoiceList.prototype.callCancelHandler = function() {
    if ($.pm) {
        $gameMessage.onChoice($gameMessage.choiceCancelType());
        this._messageWindow.terminateMessage();
        this.close();
        return;
    }
    _callCancel.call(this);
};

// The host's shared message mirror waits while a personal one is up. One only
// waiting in the queue does not hold it back while the shared one fills the
// box: the shared one closing is what lets the personal one show (both waited
// for each other forever before).
var _applyMessage = $.applyMessage;
$.applyMessage = function(m) {
    if ($.pm || ($.pmQueue.length && !$gameMessage.isBusy())) {
        $.deferredShared = m;
        return;
    }
    _applyMessage(m);
};

// A forwarded Fade Out / Fade In (221 / 222) does nothing while a message is
// up on this screen (the engine's command waits for it, a one-shot
// interpreter here does not): the guest's event faded out, its fade in came
// while the host's shared line was up, and the screen stayed black. It waits
// here for the message to close; a later fade replaces one still waiting.
$.fadeQueue = null;
var _guestCmdFade = function(msg) {
    if ((msg.c === 221 || msg.c === 222) && $gameMessage && $gameMessage.isBusy()) {
        if (!$.fadeQueue) $.dlog('fade', msg.c, 'waits for the message on screen');
        $.fadeQueue = msg;
        return true;
    }
    return false;
};

$.runFadeQueue = function() {
    var msg = $.fadeQueue;
    if (!msg || !$gameMessage || $gameMessage.isBusy()) return;
    $.fadeQueue = null;
    $.dlog('fade', msg.c, 'after the message');
    $.guestHandlers.cmd(msg);
};

$.guestHandlers.cmd = function(msg) {
    if (_guestCmdFade(msg)) return;
    // pictures its own event shows here (a resync keeps them: FH_Coop)
    if (msg.c === 231 && msg.p && $.ownPicIds) $.ownPicIds[msg.p[0]] = true;
    var interp = new Game_Interpreter();
    interp._params = msg.p;
    interp._indent = 0;
    interp._list = [{ code: msg.c, indent: 0, parameters: msg.p }];
    var fn = interp['command' + msg.c];
    if (fn) {
        try {
            fn.call(interp);
        } catch (e) {
            $.dlog('ERROR forwarded command', msg.c, String(e));
        }
    }
};

$.guestHandlers.shop = function(msg) {
    if (!(SceneManager._scene instanceof Scene_Map)) {
        $.conn.send({ t: 'pmsgDone', id: msg.id });
        return;
    }
    $.pendingShopReply = msg.id;
    $.returningFromSubScene = true;
    SceneManager.push(Scene_Shop);
    SceneManager.prepareNextScene(msg.goods, msg.po);
};

$.guestHandlers.toast = function(msg) {
    $.toast(msg.text);
};

$.myEventRunning = false;
$.guestHandlers.evRun = function(msg) {
    $.myEventRunning = !!msg.on;
    if (!msg.on) $.ownPicIds = {};
};

// A new world (a snapshot): a fade still waiting belonged to the old one.
var _processPendingSnapshotFade = $.processPendingSnapshot;
$.processPendingSnapshot = function() {
    if ($.pendingSnapshot) $.fadeQueue = null;
    _processPendingSnapshotFade();
};

// A forced move route on the guest's own character; replies when done.
$.routeWaits = [];
$.guestHandlers.route = function(msg) {
    $.guestHandlers.cmd({ c: 205, p: msg.p });
    $.routeWaits.push(msg.id);
};

$.guestExtras = $.guestExtras || [];
// (also the asks for a resync that waited for the last one: FH_Coop)
$.guestExtras.push(function() {
    $.runFadeQueue();
    if ($.resyncAskDue && $.nowMs() - $.resyncAskedAt >= $.RESYNC_MIN_MS) $.askResync($.resyncAskDue);
});
$.guestExtras.push(function() {
    if (!$.routeWaits.length || !$gamePlayer || $gamePlayer.isMoveRouteForcing()) return;
    $.routeWaits.forEach(function(id) { if ($.conn) $.conn.send({ t: 'pmsgDone', id: id }); });
    $.routeWaits = [];
});

//=============================================================================
// Group transfers and the host's other scenes
//=============================================================================

// While the host is in a battle or a menu the field keeps going for the
// guests: their events, enemies, sync. The host's own event is on hold.
// $gameMap and $dataMap are the same map. Not while a load (or the next map)
// is coming in: the loaded world on the old map's data breaks events, the
// view and snapshots made from it.
$.worldReady = function() {
    // dataMapId 0: no map loaded through DataManager yet (nothing to compare)
    return !!$gameMap && $gameMap.mapId() > 0 && !!$dataMap && (!$.dataMapId || $.dataMapId === $gameMap.mapId());
};

// The host's world runs behind a menu or a battle only while the host is
// in a game: not after a game over or at the title, whose Load / Options
// screens are menus too (0.41 play test: after an all-down game over the
// old world went on behind the title's Load screen, and its Rher form
// attacked a guest who was back at the title).
$.hostWorldOn = function() {
    if (!$.isHost()) return true;
    if (!$.hostInGame) return false;
    var scene = SceneManager._scene;
    if (scene instanceof Scene_Title || scene instanceof Scene_Gameover) return false;
    return SceneManager._stack.indexOf(Scene_Title) < 0;
};

// One who joined (or came back) while the host fights or sits in its menu
// gets its character now, not when the host is back on its map: with no
// other guest in the game there is no session yet, and the world below does
// not run (flow tests L-2d). Only the picking: the world stays paused as
// for a host alone.
$.pickingWaits = function() {
    return $.isHost() && $.clients.some(function(c) { return c.inGame && !c.actorId && !c.solo; });
};

$.backgroundPicking = function() {
    if (!$.pickingWaits() || !$gameMap || !$gameMap.mapId() || !$.worldReady() || !$.hostWorldOn()) return;
    if (Graphics.frameCount % $.syncInterval !== 0) return;
    var wasBattle = $gameParty._inBattle;
    $gameParty._inBattle = false; // (what goes out is the map's world, as in the background world)
    try {
        $.updatePicking();
    } catch (e) {
        $.dlog('ERROR background picking', e.stack || String(e));
    } finally {
        $gameParty._inBattle = wasBattle;
    }
};

$.backgroundWorld = function() {
    if ($.isHost() && !$.sessionActive()) $.backgroundPicking();
    if (!$.runsWorld() || !$.sessionActive() || !$gameMap || !$gameMap.mapId() || !$.worldReady()) return;
    if (!$.hostWorldOn()) {
        if (!$.bgOffLogged) $.dlog('background world: not in a game - the old world does not run');
        $.bgOffLogged = true;
        return;
    }
    $.bgOffLogged = false;
    var wasBattle = $gameParty._inBattle;
    $gameParty._inBattle = false;
    $.bgUpdate = true;
    $.bgBattle = wasBattle;
    try {
        $gameMap.update(false);
        $.updateOwned();
        $.updateWorldExtras();
        Object.keys($.remotes).forEach(function(id) { $.remotes[id].update(); });
        if (++$.frame % $.syncInterval === 0) $.worldSync();
    } catch (e) {
        $.dlog('ERROR background world', e.stack || String(e));
    } finally {
        $.bgUpdate = false;
        $gameParty._inBattle = wasBattle;
    }
};

// In battle the host's parallel events wait too (they draw HUD pictures,
// tint the screen and can end the game).
var _Game_CommonEvent_update = Game_CommonEvent.prototype.update;
Game_CommonEvent.prototype.update = function() {
    if ($.bgUpdate && $.bgBattle) return;
    _Game_CommonEvent_update.call(this);
};

var _Game_Event_updateParallel = Game_Event.prototype.updateParallel;
Game_Event.prototype.updateParallel = function() {
    // in battle only a guest's bullet needs the map's parallel checks
    if ($.bgUpdate && $.bgBattle && !($.bullet && $.bullet.shooter !== 'host')) return;
    // parallel events belong to the host, even next to a guest
    if (!$.realPlayer) return _Game_Event_updateParallel.call(this); // no facade: no closure
    var self = this;
    $.asHost(function() { _Game_Event_updateParallel.call(self); });
};

// "Approach" / random movers also move near guests far from the host.
var _isNearTheScreen = Game_Event.prototype.isNearTheScreen;
Game_Event.prototype.isNearTheScreen = function() {
    if (_isNearTheScreen.call(this)) return true;
    var targets = $.eventTargets();
    if (!targets) return false;
    for (var i = 0; i < targets.length; i++) {
        var t = targets[i];
        if (t.id !== 'host' && Math.abs(this.deltaXFrom(t.ch.x)) <= 12 &&
                Math.abs(this.deltaYFrom(t.ch.y)) <= 10) return true;
    }
    return false;
};

var _Game_Map_updateInterpreter = Game_Map.prototype.updateInterpreter;
Game_Map.prototype.updateInterpreter = function() {
    if ($.bgUpdate) return; // the host's own event waits for the host
    _Game_Map_updateInterpreter.call(this);
};

var _Scene_Map_update = Scene_Map.prototype.update;
Scene_Map.prototype.update = function() {
    _Scene_Map_update.call(this);
    if ($.runsWorld() && $.clients.length) {
        $.updateOwned();
        $.updateWorldExtras();
    }
    if ($.isGuest()) {
        $.showNextPersonal();
        if (!$.pm && !$.pmQueue.length && $.deferredShared !== undefined) {
            var m = $.deferredShared;
            $.deferredShared = undefined;
            _applyMessage(m);
        }
        $.updateRemoteButtons();
        $.updateGuestExtras();
    }
};

var _Scene_MenuBase_update = Scene_MenuBase.prototype.update;
Scene_MenuBase.prototype.update = function() {
    _Scene_MenuBase_update.call(this);
    if ($.runsWorld()) $.backgroundWorld();
};

// Hooks for the world-wide per-frame work (filled further down / by others)
$.worldExtras = $.worldExtras || [];
$.guestExtras = $.guestExtras || [];
$.updateWorldExtras = function() {
    $.worldExtras.forEach(function(fn) {
        try { fn(); } catch (e) { $.dlog('ERROR world extra', e.stack || String(e)); }
    });
};
$.updateGuestExtras = function() {
    $.guestExtras.forEach(function(fn) {
        try { fn(); } catch (e) { $.dlog('ERROR guest extra', e.stack || String(e)); }
    });
};

// Fast-forward (holding OK on the map) would speed up everyone's game.
var _isFastForward = Scene_Map.prototype.isFastForward;
Scene_Map.prototype.isFastForward = function() {
    if ($.sessionActive()) return false;
    return _isFastForward.call(this);
};

//=============================================================================
// Events touching guests, enemies chasing the nearest player
//=============================================================================

$.humanTargets = function() {
    var list = [];
    if (!$.isDown('host')) list.push({ id: 'host', ch: $gamePlayer });
    $.activeGuests().forEach(function(c) {
        var r = $.remotes[c.guestId];
        if (r && $.guestOnMap(c) && !$.isDown(c.guestId)) list.push({ id: c.guestId, ch: r, conn: c });
    });
    return list;
};

// A stand-in for $gamePlayer at a guest's position (chase plugins and the
// engine read $gamePlayer.x / .y / .pos()).
$.playerFacade = function(target) {
    var f = Object.create($gamePlayer);
    var r = target.ch;
    f._x = r._x;
    f._y = r._y;
    f._realX = r._realX;
    f._realY = r._realY;
    f._direction = r._direction;
    f._fhRemoteId = target.id;
    return f;
};

$.realPlayer = null; // the host's player while a facade stands in
$.withPlayer = function(target, fn) {
    if (!target || target.id === 'host') return fn();
    var real = $gamePlayer;
    $.realPlayer = real;
    // one stand-in per player per frame (the per-frame target lists are new each frame)
    window.$gamePlayer = target._facade || (target._facade = $.playerFacade(target));
    try {
        return fn();
    } finally {
        window.$gamePlayer = real;
        $.realPlayer = null;
    }
};

// Run fn with the real host player in place (inside a facade swap).
$.asHost = function(fn) {
    if (!$.realPlayer) return fn();
    var facade = $gamePlayer;
    window.$gamePlayer = $.realPlayer;
    try {
        return fn();
    } finally {
        window.$gamePlayer = facade;
    }
};

$.NOBODY = '#nobody';
$.nobodyTarget = function() {
    if (!$.nobody) $.nobody = { id: $.NOBODY, ch: { _x: -100, _y: -100, _realX: -100, _realY: -100, _direction: 2, x: -100, y: -100 } };
    if ($.nobody._facade && Object.getPrototypeOf($.nobody._facade) !== $gamePlayer) $.nobody._facade = null;
    return $.nobody;
};

$.nearestTarget = function(ev, targets) {
    targets = targets || $.humanTargets();
    var best = null, bestDist = Infinity;
    for (var i = 0; i < targets.length; i++) {
        var t = targets[i];
        var d = Math.abs(ev.deltaXFrom(t.ch.x)) + Math.abs(ev.deltaYFrom(t.ch.y));
        if (d < bestDist) {
            best = t;
            bestDist = d;
        }
    }
    return best;
};

// The players events chase or touch, or null outside a shared session.
// Game_Map.updateEvents builds the list once for all its events: each
// event used to rebuild it (several arrays and objects) every frame. The
// entries hold the characters, so positions stay live within the frame.
$.frameTargets = undefined; // undefined: no shared list right now
$.eventTargets = function() {
    if ($.frameTargets !== undefined) return $.frameTargets;
    return $.runsWorld() && $.sessionActive() ? $.humanTargets() : null;
};

var _Game_Map_updateEventsTargets = Game_Map.prototype.updateEvents;
Game_Map.prototype.updateEvents = function() {
    $.frameTargets = undefined;
    $.frameTargets = $.eventTargets();
    try {
        _Game_Map_updateEventsTargets.call(this);
    } finally {
        $.frameTargets = undefined;
    }
};

// Only events that react to the player need the nearest one in its place:
// most of a map (scenery, NPCs standing still, items) does not.
$.ROUTE_PLAYER_CODES = [10, 11, 25, 26]; // move / turn toward / away from player
$.routeCache = new WeakMap(); // route -> uses the player (kept out of saves)
$.routeUsesPlayer = function(route) {
    if (!route || !route.list) return false;
    var hit = $.routeCache.get(route);
    if (hit === undefined) {
        hit = route.list.some(function(cmd) {
            if ($.ROUTE_PLAYER_CODES.indexOf(cmd.code) >= 0) return true;
            return cmd.code === 45 && /Player/.test(String(cmd.parameters && cmd.parameters[0]));
        });
        $.routeCache.set(route, hit);
    }
    return hit;
};

// A chasing monster's path search on a map of many events (user 2026-11-04:
// Map058's Inquisitor stuttered the game; the original does it too). YEP
// chase searches a path (findDirectionTo, VE_DiagonalMovement's: 8 ways) on
// every step; each tile it tries asks for the events on it, and that read all
// 922 events of Map058. The player's own tile is never passable to it, so the
// search fills its whole range: about 100 ms a step. Nothing moves during a
// search: the events on each tile are read once for it (the same answer).
// The search itself kept its open and closed tiles in arrays (indexOf on
// every neighbour): VE_DiagonalMovement's own search, the same steps and
// answers, with its tiles kept by number instead ($.veFindDirectionTo; only
// when that plugin's search is the one in the game).
$.pathEvents = null; // y * width + x -> events there (during a search only)

$.veFindDirectionTo = function(goalX, goalY) {
    var searchLimit = this.searchLimit();
    var mapWidth = $gameMap.width();
    var nodeList = [], open = {}, closed = {};
    var start = {}, best = start;
    if (this.x === goalX && this.y === goalY) return 0;
    start.parent = null;
    start.x = this.x;
    start.y = this.y;
    start.g = 0;
    start.f = $gameMap.distance(start.x, start.y, goalX, goalY);
    nodeList.push(start);
    open[start.y * mapWidth + start.x] = start;
    var list = [2, 4, 6, 8, 1, 3, 7, 9];
    while (nodeList.length > 0) {
        var bestIndex = 0;
        for (var i = 0; i < nodeList.length; i++) {
            if (nodeList[i].f < nodeList[bestIndex].f) bestIndex = i;
        }
        var current = nodeList[bestIndex];
        var x1 = current.x, y1 = current.y, pos1 = y1 * mapWidth + x1, g1 = current.g;
        nodeList.splice(bestIndex, 1);
        delete open[pos1];
        closed[pos1] = true;
        if (current.x === goalX && current.y === goalY) {
            best = current;
            break;
        }
        if (g1 >= searchLimit) continue;
        for (var j = 0; j < list.length; j++) {
            var direction = list[j], x2, y2;
            if (direction % 2 === 0) {
                x2 = $gameMap.roundXWithDirection(x1, direction);
                y2 = $gameMap.roundYWithDirection(y1, direction);
            } else {
                x2 = $gameMap.roundXWithDirection(x1, (direction === 1 || direction === 7) ? 4 : 6);
                y2 = $gameMap.roundYWithDirection(y1, (direction === 1 || direction === 3) ? 2 : 8);
            }
            var pos2 = y2 * mapWidth + x2;
            if (closed[pos2]) continue;
            if (!this.canPassFindDirection(x1, y1, direction)) continue;
            var g2 = g1 + ((direction % 2 === 0) ? 1 : 1.4);
            var neighbor = open[pos2];
            if (!neighbor || g2 < neighbor.g) {
                if (!neighbor) {
                    neighbor = {};
                    nodeList.push(neighbor);
                    open[pos2] = neighbor;
                }
                neighbor.parent = current;
                neighbor.x = x2;
                neighbor.y = y2;
                neighbor.g = g2;
                neighbor.f = g2 + $gameMap.distance(x2, y2, goalX, goalY);
                if (!best || neighbor.f - neighbor.g < best.f - best.g) best = neighbor;
            }
        }
    }
    var node = best;
    while (node.parent && node.parent !== start) node = node.parent;
    var deltaX1 = $gameMap.deltaX(node.x, start.x);
    var deltaY1 = $gameMap.deltaY(node.y, start.y);
    if (deltaX1 !== 0 && deltaY1 !== 0) {
        if (deltaX1 < 0 && deltaY1 > 0) return 1;
        if (deltaX1 > 0 && deltaY1 > 0) return 3;
        if (deltaX1 < 0 && deltaY1 < 0) return 7;
        if (deltaX1 > 0 && deltaY1 < 0) return 9;
    }
    if (deltaY1 > 0) return 2;
    if (deltaX1 < 0) return 4;
    if (deltaX1 > 0) return 6;
    if (deltaY1 < 0) return 8;
    var deltaX2 = this.deltaXFrom(goalX);
    var deltaY2 = this.deltaYFrom(goalY);
    if (Math.abs(deltaX2) > Math.abs(deltaY2)) return deltaX2 > 0 ? 4 : 6;
    if (deltaY2 !== 0) return deltaY2 > 0 ? 8 : 2;
    return 0;
};

var _findDirectionToFast = Game_Character.prototype.findDirectionTo;
$.findDirectionToBase = _findDirectionToFast; // (the game's own: tests compare)
// (VE_DiagonalMovement's search: it tries 8 ways and keeps its closed tiles in closedList)
$.veSearchInGame = /closedList/.test(String(_findDirectionToFast)) && /canPassFindDirection/.test(String(_findDirectionToFast));
Game_Character.prototype.findDirectionTo = function(goalX, goalY) {
    var search = $.veSearchInGame ? $.veFindDirectionTo : _findDirectionToFast;
    if ($.pathEvents) return search.apply(this, arguments);
    var at = {}, w = $gameMap.width();
    $gameMap.events().forEach(function(ev) {
        var k = ev._y * w + ev._x;
        (at[k] = at[k] || []).push(ev);
    });
    $.pathEvents = at;
    try {
        return search.apply(this, arguments);
    } finally {
        $.pathEvents = null;
    }
};

var _eventsXyNtFast = Game_Map.prototype.eventsXyNt;
Game_Map.prototype.eventsXyNt = function(x, y) {
    var at = $.pathEvents;
    if (!at) return _eventsXyNtFast.apply(this, arguments);
    var here = at[y * this.width() + x];
    return here ? here.filter(function(ev) { return ev.posNt(x, y); }) : [];
};

// YEP_EventChasePlayer's "See Player" is on for every event (plugin
// setting), and alone it reads nothing: the player is read only within a
// chase / flee range. Counting it made all 922 events of Map058 swap in a
// stand-in every frame next to a guest (lag audit 1, docs/조사(보관용)/렉_감사.md).
// An autorun page starts in its update: the start wrappers tell whose it is
// by the stand-in (the Moonless beast's page next to a guest, Map092 EV105).
$.eventNeedsPlayer = function(ev) {
    if (ev._trigger === 2 || ev._trigger === 3 || ev._moveType === 2) return true;
    if (ev._chasePlayer || ev._fleePlayer || ev._alertPlayer) return true;
    if (ev._chaseRange > 0 || ev._fleeRange > 0) return true;
    return (ev._moveType === 3 || ev._moveRouteForcing) && $.routeUsesPlayer(ev._moveRoute);
};

var _Game_Event_update = Game_Event.prototype.update;
Game_Event.prototype.update = function() {
    var targets = $.eventTargets();
    if (targets && (this._erased || !this.event())) targets = null;
    // Nobody alive here (the host down or dead, no guest on this map): the
    // events see nobody - a stand-in far off the map - instead of the body.
    // (every event with "See Player" as before: the stand-in also keeps their
    // pages from starting, see FH_CoopRoam _gameEventStartNobody). Not an
    // autorun that moves the ghost on (a door's opening the ghost started,
    // an elevator's ride: FH_CoopBattle $.ghostMovePage).
    var ghostMove = this._trigger === 3 && $gamePlayer._fhGhost && $.ghostWayOn && !this._seePlayer && $.ghostWayOn(this);
    if (targets && !targets.length && !ghostMove && (this._seePlayer || $.eventNeedsPlayer(this))) {
        var me = this;
        $.withPlayer($.nobodyTarget(), function() { _Game_Event_update.call(me); });
        return;
    }
    // (one living guest and the host down or dead: that guest, not the body)
    if (targets && targets.length && (targets.length > 1 || targets[0].id !== 'host') && $.eventNeedsPlayer(this)) {
        var target = $.nearestTarget(this, targets);
        if (target && target.id !== 'host') {
            var self = this;
            $.withPlayer(target, function() { _Game_Event_update.call(self); });
            return;
        }
    }
    _Game_Event_update.call(this);
};

var _Game_Event_start = Game_Event.prototype.start;
Game_Event.prototype.start = function() {
    // Touch events started while chasing a guest belong to that guest;
    // autorun / parallel pages stay with the host.
    if ($.runsWorld() && $gamePlayer._fhRemoteId && this._trigger >= 1 && this._trigger <= 2) {
        $.startEventFor($.clientById($gamePlayer._fhRemoteId), this, [1, 2]);
        return;
    }
    if ($gamePlayer._fhRemoteId) {
        var ev = this;
        $.asHost(function() { ev.start(); });
        return;
    }
    if ($.isHost() && !this._fhConsented && $.sessionActive() && this.page() &&
            this._trigger <= 2 && $.pageNeedsConsent(this.list())) {
        var self = this;
        $.requestConsent('host', function() {
            self._fhConsented = true;
            self.start();
        }, {
            sleep: $.pageStartsSleep(this.list()), mapId: $gameMap.mapId(), eventId: this.eventId()
        });
        return;
    }
    this._fhConsented = false;
    if (this._fhOwner) return; // a guest is running it
    // who started it owns its shared dialogue (autorun: nobody, see chooseDialogueOwner)
    this._fhStartedBy = this._fhStarter || (this._trigger <= 2 ? 'host' : null);
    this._fhStarter = null;
    _Game_Event_start.call(this);
};

var _isCollidedWithPlayerCharacters = Game_Event.prototype.isCollidedWithPlayerCharacters;
Game_Event.prototype.isCollidedWithPlayerCharacters = function(x, y) {
    var self = this;
    var hostHit = $.realPlayer
        ? $.asHost(function() { return _isCollidedWithPlayerCharacters.call(self, x, y); })
        : _isCollidedWithPlayerCharacters.call(this, x, y);
    if (hostHit) return true;
    if (!$.runsWorld() || !this.isNormalPriority()) return false;
    // humanTargets() also outside a session (a guest that just left still blocks)
    var targets = $.frameTargets || $.humanTargets();
    return !!$.guestTargetAt(targets, x, y);
};

$.guestTargetAt = function(targets, x, y) {
    for (var i = 0; i < targets.length; i++) {
        if (targets[i].id !== 'host' && targets[i].ch.pos(x, y)) return targets[i];
    }
    return null;
};

var _checkEventTriggerTouch = Game_Event.prototype.checkEventTriggerTouch;
Game_Event.prototype.checkEventTriggerTouch = function(x, y) {
    if (this._trigger === 2 && !this.isJumping() && this.isNormalPriority()) {
        var targets = $.eventTargets();
        var hit = targets && $.guestTargetAt(targets, x, y);
        if (hit) {
            $.startEventFor(hit.conn, this, [2]);
            return;
        }
    }
    if (!$.realPlayer) return _checkEventTriggerTouch.call(this, x, y);
    var ev = this;
    $.asHost(function() { _checkEventTriggerTouch.call(ev, x, y); });
};

//=============================================================================
// Time votes: sleeping / letting time pass needs everyone's yes
//=============================================================================

$.consent = null; // host: { id, from, votes, voters, cb, until (ms, $.clockMs) }
$.nextConsentId = 1;
$.CONSENT_MS = 30000; // as long as the vote box stays open (real time)

$.requestConsent = function(fromId, cb, opts) {
    if ($.consent) {
        $.sendTo(fromId, { t: 'toast', text: 'Co-op: another vote is running' });
        return;
    }
    // the living vote (a dead host watches). Sleep requests may supply the
    // living players on the requesting map; other time votes still use all.
    var voters = opts && Array.isArray(opts.voters) ? opts.voters.slice() :
        ($.isDead('host') ? [] : ['host']).concat($.activeGuests().filter(function(c) {
        return !$.isDead(c.guestId);
    }).map(function(c) { return c.guestId; }));
    if (voters.length <= 1) {
        cb();
        return;
    }
    var from = $.clientById(fromId);
    if (from) from.waitingConsent = true;
    $.consent = {
        id: $.nextConsentId++, from: fromId, votes: {}, voters: voters, cb: cb,
        until: $.clockMs() + $.CONSENT_MS,
        sleep: !!(opts && opts.sleep), mapId: opts && opts.mapId, eventId: opts && opts.eventId
    };
    // opts.text: another question than time (the tower door)
    var text = opts && opts.text ? opts.text : $.playerLabel(fromId) + ' wants to let time pass. Agree?';
    voters.forEach(function(id) {
        $.sendTo(id, { t: 'consent', id: $.consent.id, text: text });
    });
};

$.resolveConsent = function(ok) {
    var c = $.consent;
    $.consent = null;
    var from = $.clientById(c.from);
    if (from) from.waitingConsent = false;
    var text = ok ? 'Co-op: everyone agreed' : 'Co-op: not everyone agreed';
    c.voters.forEach(function(id) { $.sendTo(id, { t: 'toast', text: text }); });
    if (ok) c.cb();
};

$.onConsentVote = function(id, consentId, yes) {
    var c = $.consent;
    if (!c || c.id !== consentId || c.voters.indexOf(id) < 0) return;
    c.votes[id] = !!yes;
    if (!yes) {
        $.resolveConsent(false);
        return;
    }
    if (c.voters.every(function(v) { return c.votes[v]; })) $.resolveConsent(true);
};

$.hostHandlers.consentVote = function(conn, msg) {
    $.onConsentVote(conn.guestId, msg.id, msg.yes);
};

$.worldExtras.push(function() {
    if ($.consent && $.clockMs() > $.consent.until) $.resolveConsent(false);
});

// Vote box (DOM, works in any scene): Y = yes, N = no.
$.guestHandlers.consent = function(msg) {
    $.showVoteBox(msg.text, function(yes) {
        if ($.isHost()) {
            $.onConsentVote('host', msg.id, yes);
        } else if ($.conn) {
            $.conn.send({ t: 'consentVote', id: msg.id, yes: yes });
        }
    });
};

// A box replaced or dropped takes its key listener along (a replaced box's
// listener stayed and answered the next box's Y/N - final review B).
$.voteBoxOff = null;
$.closeVoteBox = function() {
    if ($.voteBoxOff) $.voteBoxOff();
    $.voteBoxOff = null;
    var old = document.getElementById('fhcoop-vote');
    if (old) old.parentNode.removeChild(old);
};

// The vote's world is gone (a load, the session game's end): no late yes
// lets the old bed's time pass in the new one (final review B).
$.dropConsent = function(why) {
    var c = $.consent;
    if (!c) return;
    $.consent = null;
    var from = $.clientById(c.from);
    if (from) from.waitingConsent = false;
    $.dlog('time vote dropped:', why);
    c.voters.forEach(function(id) {
        if (id === 'host') $.closeVoteBox();
        else $.sendTo(id, { t: 'consentEnd', id: c.id });
    });
};

$.guestHandlers.consentEnd = function() {
    $.closeVoteBox();
};

var _loadGameConsent = DataManager.loadGame;
DataManager.loadGame = function(savefileId) {
    var ok = _loadGameConsent.apply(this, arguments);
    if (ok && $.isHost()) $.dropConsent('a save loaded');
    return ok;
};

$.showVoteBox = function(text, done) {
    $.closeVoteBox();
    var box = document.createElement('div');
    box.id = 'fhcoop-vote';
    box.style.cssText = 'position:fixed;left:50%;top:30%;transform:translate(-50%,-50%);' +
        'z-index:102;background:rgba(0,0,0,0.85);padding:12px 16px;border:1px solid #888;' +
        'font:15px sans-serif;color:#fff;text-align:center;';
    box.innerHTML = $.escape($.ko(text)) + '<br><br>' + ($.koOn() ? '[Y] 예 &nbsp;&nbsp; [N] 아니요' : '[Y] Yes &nbsp;&nbsp; [N] No');
    document.body.appendChild(box);
    var off = function() {
        document.removeEventListener('keydown', onKey, true);
        if ($.voteBoxOff === off) $.voteBoxOff = null;
    };
    var finish = function(yes) {
        off();
        if (box.parentNode) box.parentNode.removeChild(box);
        done(yes);
    };
    var onKey = function(e) {
        if (e.keyCode === 89) { e.stopPropagation(); finish(true); }
        if (e.keyCode === 78) { e.stopPropagation(); finish(false); }
    };
    document.addEventListener('keydown', onKey, true);
    $.voteBoxOff = off;
    setTimeout(function() { if (box.parentNode) finish(false); }, $.CONSENT_MS);
};

//=============================================================================
// Trading (menu command "Trade")
//=============================================================================

$.tradePartners = function() {
    var list = [];
    if ($.isGuest()) {
        ($.roster || []).forEach(function(p) {
            if (p.id !== $.myId && $.remotes[p.id]) list.push({ id: p.id, name: p.name });
        });
    } else if ($.isHost()) {
        $.activeGuests().forEach(function(c) {
            if ($.guestOnMap(c)) list.push({ id: c.guestId, name: $.playerLabel(c.guestId) });
        });
    }
    return list;
};

var _makeMenuCommandList = Window_MenuCommand.prototype.makeCommandList;
Window_MenuCommand.prototype.makeCommandList = function() {
    _makeMenuCommandList.call(this);
    if ($.sessionActive() && this.findSymbol('fhTrade') < 0) {
        this.addCommand('Trade', 'fhTrade', $.tradePartners().length > 0);
    }
};

var _createCommandWindow = Scene_Menu.prototype.createCommandWindow;
Scene_Menu.prototype.createCommandWindow = function() {
    _createCommandWindow.call(this);
    this._commandWindow.setHandler('fhTrade', function() { SceneManager.push(Scene_FHTrade); });
};

function Window_FHTradeItems() {
    this.initialize.apply(this, arguments);
}
Window_FHTradeItems.prototype = Object.create(Window_ItemList.prototype);
Window_FHTradeItems.prototype.constructor = Window_FHTradeItems;
Window_FHTradeItems.prototype.includes = function(item) {
    if (!item) return false;
    // key items stay, and the hidden ones (3, 4: the crafting schematics 248/249
    // the menu never shows - given away, the crafting window had no list).
    // Books trade (user decision 2026-11-02, FH_CoopRoam "Books").
    if ($.isTradeBook && $.isTradeBook(item)) return true;
    return !(DataManager.isItem(item) && item.itypeId >= 2);
};
$.Window_FHTradeItems = Window_FHTradeItems; // (tests)
Window_FHTradeItems.prototype.isEnabled = function(item) {
    return !!item;
};

function Window_FHTradePartners() {
    this.initialize.apply(this, arguments);
}
Window_FHTradePartners.prototype = Object.create(Window_Command.prototype);
Window_FHTradePartners.prototype.constructor = Window_FHTradePartners;
Window_FHTradePartners.prototype.initialize = function(x, y, partners) {
    this._fhPartners = partners;
    Window_Command.prototype.initialize.call(this, x, y);
};
Window_FHTradePartners.prototype.windowWidth = function() {
    return 260;
};
Window_FHTradePartners.prototype.makeCommandList = function() {
    (this._fhPartners || []).forEach(function(p) { this.addCommand(p.name, 'who', true, p.id); }, this);
};

function Scene_FHTrade() {
    this.initialize.apply(this, arguments);
}
Scene_FHTrade.prototype = Object.create(Scene_MenuBase.prototype);
Scene_FHTrade.prototype.constructor = Scene_FHTrade;

Scene_FHTrade.prototype.create = function() {
    Scene_MenuBase.prototype.create.call(this);
    this._help = new Window_Help(1);
    this._help.setText('Give an item to:');
    this.addWindow(this._help);
    this._partners = new Window_FHTradePartners(0, this._help.height, $.tradePartners());
    this._partners.setHandler('who', this.onPartner.bind(this));
    this._partners.setHandler('cancel', this.popScene.bind(this));
    this.addWindow(this._partners);
    var y = this._help.height;
    this._items = new Window_FHTradeItems(this._partners.width, y,
        Graphics.boxWidth - this._partners.width, Graphics.boxHeight - y);
    this._items.setCategory('all');
    this._items.setHandler('ok', this.onItem.bind(this));
    this._items.setHandler('cancel', this.onItemCancel.bind(this));
    this._items.refresh();
    this.addWindow(this._items);
};

Scene_FHTrade.prototype.onPartner = function() {
    this._target = this._partners.currentExt();
    this._help.setText('Give what to ' + this._partners.commandName(this._partners.index()) + '?');
    this._items.activate();
    this._items.select(0);
};

Scene_FHTrade.prototype.onItemCancel = function() {
    this._items.deselect();
    this._help.setText('Give an item to:');
    this._partners.activate();
};

Scene_FHTrade.prototype.onItem = function() {
    var item = this._items.item();
    var kind = DataManager.isWeapon(item) ? 'w' : DataManager.isArmor(item) ? 'a' : 'i';
    var msg = { t: 'trade', to: this._target, k: kind, id: item.id, n: 1 };
    if ($.runsWorld()) {
        // this PC has both bags (the host, or a guest running its map)
        var bag = $.containerOf('host', kind);
        var before = bag ? bag[item.id] || 0 : 0;
        $.doTrade('host', msg);
        if (!bag || (bag[item.id] || 0) === before) { // the partner left meanwhile
            SoundManager.playBuzzer();
            $.toast('Co-op: the trade did not go through');
            this._items.refresh();
            this._items.activate();
            return;
        }
    } else {
        $gameParty.loseItem(item, 1, false); // given back on 'tradeFail'
        $.conn.send(msg);
    }
    SoundManager.playShop();
    this._items.refresh();
    this._items.activate();
};

$.containerOf = function(id, kind) {
    if (id === 'host') {
        var party = $.ctx ? $.ctxSave : null;
        var src = party ? { i: party.items, w: party.weapons, a: party.armors } :
            { i: $gameParty._items, w: $gameParty._weapons, a: $gameParty._armors };
        return src[kind];
    }
    var conn = $.clientById(id);
    return conn ? $.inventoryOf(conn)[kind] : null;
};

$.doTrade = function(fromId, msg) {
    var from = $.containerOf(fromId, msg.k);
    var to = $.containerOf(msg.to, msg.k);
    var n = Math.max(1, Number(msg.n) || 1);
    if (!from || !to || (from[msg.id] || 0) < n || fromId === msg.to) {
        var failed = $.clientById(fromId);
        if (failed) {
            failed._tradeFails = (failed._tradeFails || []).concat([{ k: msg.k, id: msg.id, n: n }]);
            failed.send({ t: 'tradeFail', k: msg.k, id: msg.id, n: n });
        }
        return;
    }
    from[msg.id] -= n;
    if (from[msg.id] <= 0) delete from[msg.id];
    to[msg.id] = (to[msg.id] || 0) + n;
    // the giver's menu already took it off: not a host-side change
    var giver = $.clientById(fromId);
    if (giver && giver._menuBase) {
        var b = giver._menuBase.inv[msg.k];
        b[msg.id] = (b[msg.id] || 0) - n;
        if (b[msg.id] <= 0) delete b[msg.id];
    }
    var data = msg.k === 'w' ? $dataWeapons : msg.k === 'a' ? $dataArmors : $dataItems;
    var name = data[msg.id] ? data[msg.id].name : 'an item';
    $.sendTo(msg.to, { t: 'toast', text: 'Co-op: ' + $.playerLabel(fromId) + ' gave you ' + name });
    [fromId, msg.to].forEach(function(id) {
        if (id !== 'host') {
            var c = $.clientById(id);
            if (c) {
                c._lastMeKey = null;
                $.pushMe(c);
            }
        }
    });
};

$.hostHandlers.trade = function(conn, msg) {
    $.doTrade(conn.guestId, msg);
};

// Still in the menu: the guest gives it back itself (its syncMe carries it).
// Already back on the map: its syncMe lost the item, so the host gives it back.
$.restoresTradeItself = function() {
    return !(SceneManager._scene instanceof Scene_Map);
};

$.guestHandlers.tradeFail = function(msg) {
    var inMenu = $.restoresTradeItself();
    var data = msg.k === 'w' ? $dataWeapons : msg.k === 'a' ? $dataArmors : $dataItems;
    if (inMenu && data[msg.id]) $gameParty.gainItem(data[msg.id], msg.n || 1);
    if ($.conn) $.conn.send({ t: 'tradeAck', k: msg.k, id: msg.id, n: msg.n, restored: inMenu, by: msg.by || null });
    $.toast('Co-op: the trade did not go through');
    var scene = SceneManager._scene;
    if (scene && scene._items && scene._items.refresh) scene._items.refresh();
};

$.hostHandlers.tradeAck = function(conn, msg) {
    var list = conn._tradeFails || [];
    var index = -1;
    list.some(function(t, i) {
        if (t.k === msg.k && t.id === msg.id) index = i;
        return index >= 0;
    });
    if (index < 0) return; // only failures the host really reported
    var t = list.splice(index, 1)[0];
    if (msg.restored) return;
    var bag = $.inventoryOf(conn)[t.k];
    if (bag) bag[t.id] = (bag[t.id] || 0) + t.n;
    conn._lastMeKey = null;
    $.pushMe(conn);
};

$.FH_Scene_FHTrade = Scene_FHTrade;
window.Scene_FHTrade = Scene_FHTrade;

//=============================================================================
// Saving: the host's save keeps everyone; the file title lists the players
//=============================================================================

var _makeSaveContents = DataManager.makeSaveContents;
DataManager.makeSaveContents = function() {
    if ($.isHost() && $.isMultiplayerSaveMode() && $gameSystem) {
        var data = $.coopData();
        data.pos = data.pos || {};
        $.clients.forEach(function(c) {
            // a guest not placed yet (after a load) keeps the spot the save has
            // (snapshots build save contents too, with its spot from before)
            if (c.actorId && c.lastPos && !c._needPos) {
                data.pos[c.name] = { m: c.lastPos.m || $gameMap.mapId(), x: c.lastPos.x, y: c.lastPos.y, d: c.lastPos.d };
            }
        });
        if ($.activeGuests().length) {
            data.players = [{ name: $.myName, actorId: $.hostActorId(), host: true }].concat(
                $.activeGuests().map(function(c) { return { name: c.name, actorId: c.actorId }; }));
        } else if (!data.players || !data.players.length) {
            data.players = [{ name: $.myName, actorId: $.hostActorId(), host: true }];
        }
    }
    return _makeSaveContents.call(this);
};

var _makeSavefileInfo = DataManager.makeSavefileInfo;
DataManager.makeSavefileInfo = function() {
    var info = _makeSavefileInfo.call(this);
    var players = $gameSystem && $gameSystem._fhCoop && $gameSystem._fhCoop.players;
    if ($.isMultiplayerSaveMode() && players && players.length) {
        info.title = $dataSystem.gameTitle + ' - ' + players.map(function(p) {
            var actor = $dataActors[p.actorId];
            var playerName = p.name || (p.host ? 'Host' : 'Guest');
            return playerName + ' (' + (actor ? actor.name : '?') + ')';
        }).join(', ');
        info.fhCoop = players;
    }
    return info;
};

//=============================================================================
// Field guns: other players can be shot too
//=============================================================================
// Each map has a parallel "arrow_check" event: with a gun equipped, Shift
// moves the bullet event to the shooter (Set Event Location) and turns
// SW297 (player_arrow) on; the bullet then flies ten tiles. Enemies check
// the bullet themselves. Here a bullet that reaches another player hurts
// that player: no limb damage, no instant death, a fixed damage per gun.

$.GUN_CES = { 227: 'rifle', 228: 'pistol', 229: 'shotgun' };
// (user 2026-11-08: "fixed, in proportion - the field damage pistol 1, rifle
// 2, shotgun 3, times 20; no less with distance"; was 5-30 / 20-55 / 40-80 by
// distance)
$.GUN_DAMAGE = { pistol: 20, rifle: 40, shotgun: 60 };
$.BULLET_SWITCHES = [297, 300];
$.GUN_OK_SWITCH = 2251;
$.bullet = null;

var _command203 = Game_Interpreter.prototype.command203;
Game_Interpreter.prototype.command203 = function() {
    var ch = this.character(this._params[0]);
    if (ch && ch.eventId) $.lastLocated = ch.eventId();
    return _command203.call(this);
};

var _Game_Switches_setValue = Game_Switches.prototype.setValue;
Game_Switches.prototype.setValue = function(id, value) {
    if ($.runsWorld()) {
        if (id === $.GUN_OK_SWITCH && value) $.lastGun = $.pendingGun;
        if ($.BULLET_SWITCHES.indexOf(id) >= 0 && value && !this.value(id) && $.lastLocated) {
            var shooter = $.ctx ? $.ctx.guestId : 'host';
            var ch = shooter === 'host' ? $gamePlayer : $.remotes[shooter];
            $.bullet = {
                eventId: $.lastLocated, shooter: shooter, gun: $.lastGun || 'pistol',
                x0: ch ? ch.x : 0, y0: ch ? ch.y : 0, mapId: $gameMap.mapId(),
                marks: !!this._data[731] // MarksmanshipAVAILABLE: a rifle may kill at once (FH_CoopRoam forms)
            };
            // a guest's shot flies its way and hits with its gun (below)
            if ($.ctx) {
                var data = this._data;
                $.bullet.face = [10, 11, 12, 13].filter(function(f) { return !!data[f]; })[0] || 0;
                $.bullet.gunSw = $.gunSwitchesFor($gameActors.actor($.ctx.actorId));
            }
        }
    }
    _Game_Switches_setValue.call(this, id, value);
};

$.gunDamage = function(gun) {
    return $.GUN_DAMAGE[gun] || $.GUN_DAMAGE.pistol;
};

// Rare extras of a shot at another player (user decision 2026-10-29):
// a pistol, 1 in 100, on a male character: twice the damage, 50 mind and a
// line; a rifle, 1 in 4: an arm off (not through an arm guard); a shotgun,
// 1 in 2: Fracture (user 2026-11-08: "rifle 25%, shotgun 50%, not the
// pistol"; both were 1 in 20).
// (Marina is a man in a dress in the story: user decision 2026-10-31)
$.GUN_MALE_ACTORS = [1, 3, 4, 6, 13]; // Levi, Marina, Daan, O'saa, Marcoh
$.GUN_GROIN_RATE = 0.01;
$.GUN_GROIN_MIND = 50;
$.GUN_GROIN_TEXT = 'You seem to have been hit somewhere not so good...';
$.GUN_GROIN_TEXT_KO = '당신은 영 좋지 않은 곳에 맞은 것 같다...';
$.GUN_ARM_RATE = 0.25;
$.GUN_FRACTURE_RATE = 0.5;
$.GUN_FRACTURE_STATE = 19;

// The Korean patch: the data's names are in Hangul.
$.koreanData = function() {
    var a = $dataActors && $dataActors[1];
    return !!a && /[가-힣]/.test(a.name || '');
};

$.gunExtra = function(gun, actor) {
    if (!actor) return null;
    if (gun === 'pistol' && $.GUN_MALE_ACTORS.indexOf(actor.actorId()) >= 0 &&
            Math.random() < $.GUN_GROIN_RATE) return 'groin';
    if (gun === 'rifle' && Math.random() < $.GUN_ARM_RATE) return 'arm';
    if (gun === 'shotgun' && Math.random() < $.GUN_FRACTURE_RATE) return 'fracture';
    return null;
};

// An arm of that player's character (the first one left; nothing through a
// guard). True: one was cut.
$.gunCutArm = function(id, actor) {
    var limbs = $.LIMB_SWITCHES && $.LIMB_SWITCHES[actor.actorId()] || [];
    if (limbs.length < 2 || ($.pvpHasGuard && $.pvpHasGuard(actor, 'armR'))) return false;
    var sw = !$gameSwitches.value(limbs[0]) ? limbs[0] : !$gameSwitches.value(limbs[1]) ? limbs[1] : 0;
    if (!sw) return false;
    $gameSwitches.setValue(sw, true);
    // (its own PC draws the lost limb from its own switch)
    if (id !== 'host') $.sendTo(id, { t: 'cmd', c: 121, p: [sw, sw, 0] });
    return true;
};

$.gunGab = function(id, text) {
    if (id === 'host') $.fieldGab(text);
    else $.sendTo(id, { t: 'gab', text: text });
};

$.actorOfPlayer = function(id) {
    if (id === 'host') return $gameActors.actor($.hostActorId());
    var conn = $.clientById(id);
    return conn && conn.actorId ? $gameActors.actor(conn.actorId) : null;
};

$.worldExtras.push(function() {
    var b = $.bullet;
    if (!b) return;
    var flying = $.BULLET_SWITCHES.some(function(id) { return $gameSwitches.value(id); });
    if (!flying || b.mapId !== $gameMap.mapId()) {
        $.bullet = null;
        return;
    }
    var ev = $gameMap.event(b.eventId);
    if (!ev) return;
    var hit = $.humanTargets().filter(function(t) {
        return t.id !== b.shooter && t.ch.x === ev.x && t.ch.y === ev.y;
    })[0];
    if (!hit) return;
    var dist = Math.abs(hit.ch.x - b.x0) + Math.abs(hit.ch.y - b.y0);
    var dmg = $.gunDamage(b.gun);
    var actor = $.actorOfPlayer(hit.id);
    $.bullet = null;
    $.BULLET_SWITCHES.forEach(function(id) { $gameSwitches.setValue(id, false); });
    if (!actor) return;
    var extra = $.gunExtra(b.gun, actor);
    if (extra === 'groin') {
        dmg *= 2;
        actor.gainMp(-$.GUN_GROIN_MIND);
        $.gunGab(hit.id, $.koreanData() ? $.GUN_GROIN_TEXT_KO : $.GUN_GROIN_TEXT);
    } else if (extra === 'arm') {
        if (!$.gunCutArm(hit.id, actor)) extra = null;
        else $.gunGab(hit.id, 'Your arm...!');
    }
    actor.gainHp(-dmg);
    // (after the hit: Fracture also lowers max HP)
    if (extra === 'fracture') {
        if (actor.isAlive()) actor.addState($.GUN_FRACTURE_STATE);
        if (!actor.isStateAffected($.GUN_FRACTURE_STATE)) extra = null;
    }
    $.dlog('shot', $.playerLabel(b.shooter), '->', $.playerLabel(hit.id), b.gun, 'dist', dist, 'dmg', dmg,
        extra ? '(' + extra + ')' : '');
    $.sendTo(hit.id, { t: 'toast', text: 'Co-op: shot by ' + $.playerLabel(b.shooter) + ' (-' + dmg + ')' });
    $.sendTo(hit.id, { t: 'cmd', c: 224, p: [[255, 0, 0, 170], 20, false] });
    if (b.shooter !== 'host') $.sendTo(b.shooter, { t: 'toast', text: 'Co-op: you shot ' + $.playerLabel(hit.id) });
    if (hit.id !== 'host') $.pushMe(hit.conn);
    if (actor.hp <= 0 || actor.isDead()) {
        actor.setHp(1);
        if ($.onPlayerDefeated) $.onPlayerDefeated(hit.id);
    }
});

// Guests shoot with Shift like the host: the host runs this map's
// arrow_check event for them, with Shift counted as held.
// Its shooting pages go by RIFLE/SHOTGUN/PISTOL_EQUIPPED (SW2252-2254),
// which each character's outfit common event (CE39, CE42 ...) sets from
// that character's weapon: weapon 10/11 -> 2252, 12 -> 2253, 13 -> 2254.
// In the world they are the host's (its outfit event runs here), so a
// guest's page is picked with its own weapon's values.
$.GUN_EQUIP_SWITCHES = [2252, 2253, 2254];
$.GUN_WEAPON_SWITCH = { 10: 2252, 11: 2252, 12: 2253, 13: 2254 };

$.gunSwitchesFor = function(actor) {
    var on = {};
    (actor && actor.weapons ? actor.weapons() : []).forEach(function(item) {
        var id = item && $.GUN_WEAPON_SWITCH[item.id];
        if (id) on[id] = true;
    });
    return on;
};

// The page this guest would see: its SELECT (guest context) and its gun.
$.gunPageFor = function(conn, ev) {
    var sw = $gameSwitches._data, keep = {};
    var on = $.gunSwitchesFor($gameActors.actor(conn.actorId));
    $.GUN_EQUIP_SWITCHES.forEach(function(id) {
        keep[id] = sw[id];
        sw[id] = !!on[id];
    });
    var found;
    try {
        found = $.guestPage(conn, ev);
    } finally {
        $.GUN_EQUIP_SWITCHES.forEach(function(id) { sw[id] = keep[id]; });
    }
    return found ? found.page : null;
};

$.shootEventOf = function(conn) {
    var found = null;
    $gameMap.events().some(function(ev) {
        var page = conn ? $.gunPageFor(conn, ev) : ev.page();
        if (page && page.trigger === 4 && page.list.some(function(c) {
            return c.code === 117 && $.GUN_CES[c.parameters[0]];
        })) {
            found = { ev: ev, page: page };
            return true;
        }
        return false;
    });
    return found;
};

$.hostHandlers.shoot = function(conn, msg) {
    if (!$.guestOnMap(conn) || $.isBusy(conn) || $.isDown(conn.guestId)) return;
    var remote = $.remotes[conn.guestId];
    if (remote && msg.d) remote._direction = msg.d;
    var found = $.shootEventOf(conn);
    if (!found) {
        var weapons = ($gameActors.actor(conn.actorId) ? $gameActors.actor(conn.actorId).weapons() : [])
            .map(function(w) { return w && w.id; });
        var why = $gameMap.mapId() + ':' + weapons.join(',');
        if (conn._noShootLog !== why) { // once per map and weapons
            conn._noShootLog = why;
            $.dlog('shoot: no shooting page for', conn.name, 'weapons', weapons);
        }
        return;
    }
    conn._noShootLog = null;
    var interp = new Game_Interpreter();
    interp._fhOwner = conn.guestId;
    interp._fhShift = true;
    interp.setup(found.page.list, found.ev.eventId());
    $.owned[conn.guestId] = { interp: interp, ev: null };
};

var _command111 = Game_Interpreter.prototype.command111;
Game_Interpreter.prototype.command111 = function() {
    if (this._fhShift && this._params[0] === 11 && this._params[1] === 'shift') {
        this._branch[this._indent] = true;
        if (!this._branch[this._indent]) this.skipBranch();
        return true;
    }
    return _command111.call(this);
};

var _setupChildShift = Game_Interpreter.prototype.setupChild;
Game_Interpreter.prototype.setupChild = function(list, eventId) {
    _setupChildShift.call(this, list, eventId);
    if (this._fhShift) this._childInterpreter._fhShift = true;
};

// A guest's bullet: the bullet event (arrow_player) flies by its page for
// FACE_UP/DOWN/LEFT/RIGHT (SW10-13) and the map's hit checks (arrow_check
// pages on SW297, enemies) branch on RIFLE/SHOTGUN/PISTOL_EQUIPPED. Those
// are the host's in the world: the guest's shot flew the host's way (no hit)
// and hit like the host's gun. While it flies they are the shooter's.
$.withBulletOf = function(fn) {
    var b = $.bullet;
    if (!b || b.shooter === 'host' || !b.gunSw || b.mapId !== $gameMap.mapId()) return fn();
    var sw = $gameSwitches._data, keep = {};
    var ids = [10, 11, 12, 13].concat($.GUN_EQUIP_SWITCHES);
    ids.forEach(function(id) { keep[id] = sw[id]; });
    [10, 11, 12, 13].forEach(function(id) { sw[id] = id === b.face; });
    $.GUN_EQUIP_SWITCHES.forEach(function(id) { sw[id] = !!b.gunSw[id]; });
    try {
        return fn();
    } finally {
        ids.forEach(function(id) { sw[id] = keep[id]; });
    }
};

var _findProperPageIndexBullet = Game_Event.prototype.findProperPageIndex;
Game_Event.prototype.findProperPageIndex = function() {
    var b = $.bullet, self = this;
    if (b && b.shooter !== 'host' && b.eventId === this.eventId() && !$.ctx) {
        return $.withBulletOf(function() { return _findProperPageIndexBullet.call(self); });
    }
    return _findProperPageIndexBullet.call(this);
};

var _updateParallelBullet = Game_Event.prototype.updateParallel;
Game_Event.prototype.updateParallel = function() {
    var b = $.bullet, self = this;
    if (b && b.shooter !== 'host' && !$.ctx && this._interpreter) {
        return $.withBulletOf(function() { return _updateParallelBullet.call(self); });
    }
    return _updateParallelBullet.call(this);
};

$.guestExtras.push(function() {
    if (!$.isThin() || !$.conn || !$.myActorId || $.pm || $.isDownMe()) return;
    if (!(SceneManager._scene instanceof Scene_Map)) return;
    // (Shift is the run key too: only with a gun in hand - final review B8)
    if (Input.isTriggered('shift') && Object.keys($.gunSwitchesFor($gameActors.actor($.myActorId))).length) {
        $.conn.send({ t: 'shoot', d: $gamePlayer.direction() });
    }
});

// The shooting pose (0.38.3-pre play test: a thin guest's shot showed no
// pose on the host's screen). CE327 SHOOT_GFX puts the shooter's character
// on its gun sheet ('%<character>4', an index per gun and arm). For a thin
// guest it runs here in the guest's context and changed only this PC's copy
// of that character, which no screen draws: a thin guest's player is drawn
// from its own PC (the character's own image), and the others see what that
// PC reports. The pose goes to the shooter's PC instead: its player shows it
// while the bullet flies (and reports it, so every screen shows it), then
// its own image again.
$.GUN_POSE_MAX_MS = 2500; // (real time, $.clockMs)

$.isGunPoseImage = function(actorId, name) {
    var data = $dataActors[actorId];
    return !!data && !!data.characterName && String(name) === data.characterName + '4';
};

var _setCharacterImagePose = Game_Actor.prototype.setCharacterImage;
Game_Actor.prototype.setCharacterImage = function(name, index) {
    var conn = $.ctx;
    if (conn && $.runsWorld() && conn.actorId === this.actorId() && conn.send && $.isGunPoseImage(this.actorId(), name)) {
        conn.send({ t: 'gunPose', n: String(name), i: Number(index) || 0 });
        conn._fhGunPose = { at: $.clockMs(), flew: false };
        return; // this PC's copy keeps its own image
    }
    _setCharacterImagePose.call(this, name, index);
};

// The pose ends when that bullet has flown (or after a while).
$.worldExtras.push(function() {
    $.clients.forEach(function(c) {
        var pose = c._fhGunPose;
        if (!pose) return;
        var flying = $.bullet && $.bullet.shooter === c.guestId &&
            $.BULLET_SWITCHES.some(function(id) { return $gameSwitches.value(id); });
        if (flying) pose.flew = true;
        if ((pose.flew && !flying) || $.clockMs() - pose.at > $.GUN_POSE_MAX_MS) {
            c._fhGunPose = null;
            c.send({ t: 'gunPose', n: '' });
        }
    });
});

$.gunPose = null; // guest: { n, i, until }
$.guestHandlers.gunPose = function(msg) {
    $.gunPose = msg && msg.n ? { n: msg.n, i: Number(msg.i) || 0, until: $.clockMs() + $.GUN_POSE_MAX_MS } : null;
};

if (Game_Player.prototype.updateFHCoopGraphic) {
    var _updateGraphicPose = Game_Player.prototype.updateFHCoopGraphic;
    Game_Player.prototype.updateFHCoopGraphic = function() {
        var pose = $.gunPose;
        if (pose && (this.isMoving() || $.clockMs() > pose.until)) pose = $.gunPose = null;
        if (pose) {
            if (this._characterName !== pose.n || this._characterIndex !== pose.i) this.setImage(pose.n, pose.i);
            return;
        }
        _updateGraphicPose.call(this);
    };
}

//=============================================================================
// Sound effects of the shared world
//=============================================================================

var _playSe = AudioManager.playSe;
AudioManager.playSe = function(se) {
    if ($.runsWorld() && $.ctx) {
        $.sendTo($.ctx.guestId, { t: 'se', se: se });
        return; // a guest's event sounds on the guest's PC
    }
    _playSe.call(this, se);
    if ($.runsWorld() && $.shareSe && $.clients.length && se && se.name &&
            ($.bgUpdate || SceneManager._scene instanceof Scene_Map)) {
        $.activeGuests().forEach(function(c) {
            if ($.guestOnMap(c)) c.send({ t: 'se', se: se });
        });
    }
};

$.shareSe = 0;
var _command250 = Game_Interpreter.prototype.command250;
Game_Interpreter.prototype.command250 = function() {
    // map events only: parallel common events (run steps, heartbeat) are the host's
    var share = this._eventId > 0;
    if (share) $.shareSe++;
    try {
        return _command250.call(this);
    } finally {
        if (share) $.shareSe--;
    }
};

// Sounds in event move routes (doors, monsters), not the host's own.
var _processMoveCommand = Game_Character.prototype.processMoveCommand;
Game_Character.prototype.processMoveCommand = function(command) {
    var share = command.code === Game_Character.ROUTE_PLAY_SE && this !== $gamePlayer && !this._fhRemoteId;
    if (share) $.shareSe++;
    try {
        _processMoveCommand.call(this, command);
    } finally {
        if (share) $.shareSe--;
    }
};

$.guestHandlers.se = function(msg) {
    if (msg.se) _playSe.call(AudioManager, msg.se);
};

// Leaving the session: nothing of the old one may block the next.
var _leaveAsGuestWorld = $.leaveAsGuest;
$.leaveAsGuest = function(message) {
    $.myEventRunning = false;
    $.pm = null;
    $.pmQueue = [];
    $.routeWaits = [];
    $.deferredShared = null;
    $.fadeQueue = null;
    $.droppedScr = null;
    $.resyncAskDue = null;
    _leaveAsGuestWorld(message);
};

//=============================================================================
// Train ending: every living player rides the train
//=============================================================================
// Map161 EV1 (page for V1388 ENDING_FREE) shows one "train_<name>" picture per
// SELECT switch that is on: the party.
// In co-op the players who reached the ending are all on it; the rest of the
// scene (ending picture, ending switches) stays the host's.

$.TRAIN_END_MAP = 161;
$.TRAIN_END_EVENT = 1;

$.livingPlayerSelects = function() {
    var ids = [];
    if (!$.isDead('host')) ids.push($.SELECT_OF_ACTOR[$.hostActorId()]);
    $.activeGuests().forEach(function(c) {
        if (!$.isDead(c.guestId) && !c._fhNoSelect) ids.push($.SELECT_OF_ACTOR[c.actorId]);
    });
    return ids.filter(Boolean);
};

// Ending A (V1814 ENDING_MACHINE, page 1) draws the survivors' train: each
// contestant whose SELECT is off (and not dead, mad, or in the bunker party)
// rode home and counts in "N managed to survive". The players all went to the
// machine together (FH_CoopRoam "Ending A"): no player's character is on it.
$.ENDING_MACHINE_VAR = 1814;

// (every character of this game's players, also of one who left: it did not
// ride home either)
$.playerSelects = function() {
    var ids = [$.SELECT_OF_ACTOR[$.hostActorId()]];
    var assign = $.assignments ? $.assignments() : {};
    Object.keys(assign).forEach(function(name) { ids.push($.SELECT_OF_ACTOR[assign[name]]); });
    $.activeGuests().forEach(function(c) { ids.push($.SELECT_OF_ACTOR[c.actorId]); });
    return ids.filter(Boolean);
};

var _command111TrainA = Game_Interpreter.prototype.command111;
Game_Interpreter.prototype.command111 = function() {
    var p = this._params;
    if ($.isHost() && $.sessionActive() && !this._fhOwner && p[0] === 0 && p[2] === 1 &&
            $gameMap.mapId() === $.TRAIN_END_MAP && this._mapId === $.TRAIN_END_MAP && this._eventId === $.TRAIN_END_EVENT &&
            $gameVariables.value($.ENDING_MACHINE_VAR) >= 1 && $.playerSelects().indexOf(p[1]) >= 0) {
        this._branch[this._indent] = false;
        this.skipBranch();
        return true;
    }
    return _command111TrainA.call(this);
};

var _command111Train = Game_Interpreter.prototype.command111;
Game_Interpreter.prototype.command111 = function() {
    var p = this._params;
    if ($.isHost() && $.sessionActive() && !this._fhOwner && p[0] === 0 && p[2] === 0 &&
            $gameMap.mapId() === $.TRAIN_END_MAP && this._eventId === $.TRAIN_END_EVENT &&
            $.SELECT_SWITCHES.indexOf(p[1]) >= 0) {
        var next = this._list[this._index + 1];
        if (next && next.code === 231 && /^train_/.test(String(next.parameters[1]))) {
            var companion = $gameSwitches.value(p[1]) && $gameParty._actors.indexOf($.SELECT_ACTOR[p[1]]) >= 0;
            this._branch[this._indent] = companion || $.livingPlayerSelects().indexOf(p[1]) >= 0;
            if (!this._branch[this._indent]) this.skipBranch();
            return true;
        }
    }
    return _command111Train.call(this);
};

//=============================================================================
// Down / dead helpers (filled in by FH_CoopBattle)
//=============================================================================

$.isDown = $.isDown || function(id) { return false; };
$.isDead = $.isDead || function(id) { return false; };
$.isDownMe = $.isDownMe || function() { return false; };

//=============================================================================
// A shared dialogue never waits on a guest who cannot answer it
//=============================================================================
// The guest chosen to advance a shared scene may be busy with its own event,
// in a fight, off the host's map or gone: the host takes the dialogue over.

// (down or dead: it only reads along - play test 2026-10-20, a down guest
// held the scene "Again sleeping, are we?")
$.ownerCannotAnswer = function(conn) {
    return !conn || !$.guestOnMap(conn) || !!conn.roam || !!conn.inBattle || !!$.owned[conn.guestId] ||
        $.isDown(conn.guestId) || $.isDead(conn.guestId);
};

$.hostTakesDialogue = function() {
    $.msgOwner = 'host';
    $.votes = {};
    $.lastMsgKey = ''; // everyone gets the line again, with the host as its owner
    var scene = SceneManager._scene;
    var win = scene && scene._messageWindow;
    if (win && win._choiceWindow && $.syncHostChoiceInput) $.syncHostChoiceInput(win._choiceWindow);
};

$.worldExtras.push(function() {
    if (!$.isHost() || !$.msgShared || !$.msgOwner || $.msgOwner === 'host') return;
    if (!$.ownerCannotAnswer($.clientById($.msgOwner))) return;
    $.dlog('dialogue owner cannot answer, host takes it', $.msgOwner);
    $.hostTakesDialogue();
});

// ... nor on one who does not answer: away from the keyboard, its window
// minimized (its game loop stops), a frozen PC whose connection still stands
// (docs/조사(보관용)/검수/최종검토_B 2). A time limit alone cut slow readers off (0.4
// review: a 4-line line, a hard choice talked over on voice), so the owner's
// PC tells the host it shows the line ('msgSeen': at once and every
// MSG_SEEN_EVERY_MS, from its game loop - nothing comes while it is minimized
// or frozen). The host answers the line itself when no 'msgSeen' came within
// MSG_SEEN_GRACE_MS of it (the guest never got it), when they stopped for
// that long, or after MSG_OWNER_MAX_MS in all (away, the game left running).
// The event goes on once, from the host's answer: a late answer of that
// guest is stale (its vote counts only for the current owner). Time the
// host's own game loop stood still (its window minimized) does not count.
$.MSG_SEEN_EVERY_MS = 3000;   // (real time, $.clockMs)
$.MSG_SEEN_GRACE_MS = 8000;
$.MSG_OWNER_MAX_MS = 120000;
$.MSG_WAIT_HINT_MS = 15000;   // the host is told whom it waits for
$.msgOwnerWait = null;  // host: { key, since, last, floor (ms), hinted }
$.msgSeen = null;       // host: { key, at (ms) } the owner's last 'msgSeen'

// The host's copy of the shared line waits for its owner's answer now.
$.sharedLineWaits = function() {
    var scene = SceneManager._scene;
    var win = scene && scene._messageWindow;
    if (!win || !$gameMessage.isBusy()) return false;
    var list = win._choiceWindow;
    return !!win.pause || !!(list && list._fhVoting && $.choiceListUp(list));
};

$.msgOwnerKey = function() {
    return $.msgClears + ':' + $.msgStep + ':' + $.msgOwner;
};

$.hostHandlers.msgSeen = function(conn, msg) {
    if (!$.isHost() || !msg || msg.id !== $.msgClears || msg.step !== $.msgStep || $.msgOwner !== conn.guestId) return;
    $.msgSeen = { key: $.msgOwnerKey(), at: $.clockMs() };
};

// Why the host takes the line now ('' = not yet).
$.msgOwnerLate = function(w, now) {
    var seen = $.msgSeen && $.msgSeen.key === w.key ? $.msgSeen.at : 0;
    if (now - w.since > $.MSG_OWNER_MAX_MS) return 'no answer in ' + $.MSG_OWNER_MAX_MS / 1000 + ' s';
    var last = Math.max(seen, w.floor);
    if (now - last <= $.MSG_SEEN_GRACE_MS) return '';
    return seen ? 'its PC stopped showing the line' : 'its PC never showed the line';
};

$.worldExtras.push(function() {
    if (!$.isHost() || !$.msgShared || !$.msgOwner || $.msgOwner === 'host' || $.dialogueOwnerResponded() ||
            !$.sharedLineWaits()) {
        $.msgOwnerWait = null;
        return;
    }
    var key = $.msgOwnerKey(), now = $.clockMs(), w = $.msgOwnerWait;
    if (!w || w.key !== key) {
        $.msgOwnerWait = { key: key, since: now, last: now, floor: now, hinted: false };
        return;
    }
    // this PC's loop stood still (minimized): that time is nobody's silence
    var gap = now - w.last;
    w.last = now;
    if (gap > 1000) {
        w.since += gap;
        w.floor = now;
    }
    if (!w.hinted && now - w.since > $.MSG_WAIT_HINT_MS) {
        w.hinted = true;
        $.toast('Co-op: waiting for ' + $.playerLabel($.msgOwner) + '...');
    }
    var why = $.msgOwnerLate(w, now);
    if (!why) return;
    var owner = $.msgOwner;
    $.msgOwnerWait = null;
    $.dlog('dialogue owner does not answer (' + why + '), host takes it', owner);
    $.hostTakesDialogue();
    $.sendTo(owner, { t: 'toast', text: 'Co-op: no answer from you - the host goes on with the dialogue' });
    $.toast('Co-op: ' + $.playerLabel(owner) + ' did not answer - your turn to go on');
});

// Guest: its own shared line is on its screen (not a personal message over it).
$.msgSeenSent = { key: '', at: 0 };
$.guestExtras.push(function() {
    if (!$.conn || !$.guestMsgShared || $.guestMsgOwner !== $.myId || $.guestVoted || $.pm || !$.myActorId ||
            !$gameMessage.isBusy()) return;
    var key = $.guestMsgId + ':' + $.guestStep, now = $.clockMs(), last = $.msgSeenSent;
    if (key === last.key && now - last.at < $.MSG_SEEN_EVERY_MS) return;
    $.msgSeenSent = { key: key, at: now };
    $.conn.send({ t: 'msgSeen', id: $.guestMsgId, step: $.guestStep });
});

// A fade that waited for a message on the host's own screen (FH_CoopWorld
// guestHandlers.cmd: 'host' is this PC).
$.worldExtras.push(function() { if ($.fadeQueue) $.runFadeQueue(); });

//=============================================================================
// Autorun pages a guest's event set off run for that guest
//=============================================================================
// Some doors only flip a switch and let autorun pages do the rest (Map005
// EV035, the abandoned house cellar: OK sets SW74, autorun pages count on
// and transfer the player). Autorun pages ran as the host's, so a guest at
// that door moved the host. Switches, variables and self switches written
// by a guest's event are remembered for a moment; an autorun page whose
// conditions use one of them runs for that guest, as its own event (the
// chain goes on the same way, page after page).

$.CAUSE_MS = 2000; // (real time, $.clockMs: drawn frames run as fast as the screen)
$.causes = {}; // 'sw:id' | 'v:id' | 'ss:map,event,ch' -> { id ('host': this PC), at (ms), n (order) }
$.causeSeq = 0;

// a newer than b (the same millisecond: the later write)
$.newerCause = function(a, b) {
    return !b || a.at > b.at || (a.at === b.at && (a.n || 0) > (b.n || 0));
};
$.causeSkip = false;

// The host's own writes count too: the newest write decides. A write on this
// PC (the host's, or a thin guest's event run here) is a new record: an older
// "its own PC ran it" (own, from a roaming guest's world delta) never carries
// over. It did, and a door (Map005 EV35, the cellar) stuck on its autorun
// page for everyone after a thin guest pressed it (0.38.3-pre play test).
$.markCause = function(key) {
    if ($.causeSkip || !$.role || !$.runsWorld()) return;
    var id = $.ctx && $.ctx.guestId ? $.ctx.guestId : 'host';
    $.causes[key] = { id: id, at: $.clockMs(), n: ++$.causeSeq, press: $.pressRunning() };
};

// The event whose command runs now ($.causeInterp): a write from a page a
// player started (button, touch), or from an autorun page such a press
// turned on, is that player's press (the elevator rope, Map169 EV7: Z on p0
// sets V2025, autorun p1 sets it again, autorun p2 asks "Climb up").
$.causeInterp = null;
var _executeCommandCause = Game_Interpreter.prototype.executeCommand;
Game_Interpreter.prototype.executeCommand = function() {
    var keep = $.causeInterp;
    $.causeInterp = this;
    try {
        return _executeCommandCause.call(this);
    } finally {
        $.causeInterp = keep;
    }
};

$.pressRunning = function() {
    var interp = $.causeInterp;
    var ev = interp && interp._eventId > 0 && $gameMap ? $gameMap.event(interp._eventId) : null;
    if (!ev || !ev.page()) return false;
    return ev._trigger <= 2 || $.pressChainPage(ev);
};

// An autorun page the host's press turned on that is the host's own, as a
// guest's is that guest's (Game_Event.start below): not a story scene for
// everyone. Its messages are a pressed event's (FH_Coop isFHCoopShared).
$.pressChainPage = function(ev) {
    var page = ev && ev.page();
    if (!page || page.trigger !== 3 || ev._fhPressPage !== ev._pageIndex) return false;
    return !$.isCutscenePage(page) || $.pageMovesPlayer(page) || $.pagePersonal(page) || $.pageUsesBag(page) ||
        $.pageFights(page);
};

var _swSetCause = Game_Switches.prototype.setValue;
Game_Switches.prototype.setValue = function(id, value) {
    _swSetCause.call(this, id, value);
    if (this === $gameSwitches) $.markCause('sw:' + id);
};

var _varSetCause = Game_Variables.prototype.setValue;
Game_Variables.prototype.setValue = function(id, value) {
    _varSetCause.call(this, id, value);
    if (this === $gameVariables) $.markCause('v:' + id);
};

var _ssSetCause = Game_SelfSwitches.prototype.setValue;
Game_SelfSwitches.prototype.setValue = function(key, value) {
    _ssSetCause.call(this, key, value);
    if (this === $gameSelfSwitches) $.markCause('ss:' + String(key));
};

// The guest whose recent write turned this page on (the newest one).
$.pageCause = function(ev) {
    var page = ev.page();
    if (!page) return null;
    var c = page.conditions, keys = [];
    if (c.switch1Valid) keys.push('sw:' + c.switch1Id);
    if (c.switch2Valid) keys.push('sw:' + c.switch2Id);
    if (c.variableValid) keys.push('v:' + c.variableId);
    if (c.selfSwitchValid) keys.push('ss:' + [$gameMap.mapId(), ev.eventId(), c.selfSwitchCh].join(','));
    var best = null, now = $.clockMs();
    keys.forEach(function(k) {
        var cause = $.causes[k];
        if (cause && now - cause.at <= $.CAUSE_MS && $.newerCause(cause, best)) best = cause;
    });
    return best;
};

// An event whose autorun pages read the keys (a panel, a puzzle) is played by
// the one who set it off, its opening and closing pages too: as a shared
// scene it ran on the host's PC with the host's keys.
$.eventReadsKeys = function(ev) {
    return ev.event().pages.some(function(pg) {
        return pg.trigger === 3 && pg.list.some(function(c) { return c.code === 111 && c.parameters[0] === 11; });
    });
};

// A page like that which is still the event's page goes round again at once.
// Ending and starting it told the guest's PC "no event runs" between rounds:
// its keys were not sent then and a short press was lost.
$.ownedLoops = function(entry, id) {
    var ev = entry.ev, o = ev && ev._fhLoopOwner;
    if (!o || o.id !== id || o.page !== ev._pageIndex || ev._erased) return false;
    if ($gameMap.event(ev.eventId()) !== ev || !$.eventReadsKeys(ev)) return false;
    var page = ev.page();
    if (!page || page.trigger !== 3 || ev.findProperPageIndex() !== ev._pageIndex) return false;
    var conn = $.clientById(id);
    if (!conn || !$.guestOnMap(conn) || $.isDown(id)) return false;
    entry.interp.setup(page.list, ev.eventId());
    return true;
};

// An autorun page that starts again and again for the guest who set it off
// (its condition stays on while it waits for keys: the sewage panel, Map096
// EV298 p2) stays that guest's, however long. Its cause is old after
// $.CAUSE_MS, and the panel went to the host and the host's keys (4-player
// review 2026-11-09: "only the host's game activates it").
$.loopCause = function(ev) {
    var o = ev._fhLoopOwner;
    if (!o || o.page !== ev._pageIndex) return null;
    var c = $.clientById(o.id);
    return c && $.guestOnMap(c) && !c.roam ? { id: o.id, at: $.clockMs(), n: ++$.causeSeq } : null;
};

var _Game_Event_start_cause = Game_Event.prototype.start;
$.pageTransferMap = function(page) {
    var commands = $.pageTransferCommands(page && page.list, {});
    if (commands.length !== 1) return 0;
    var command = commands[0];
    if (!command) return 0;
    var p = command.parameters;
    return p[0] === 0 ? Number(p[1]) || 0 : Number($gameVariables.value(p[1])) || 0;
};

Game_Event.prototype.start = function() {
    if ($.runsWorld() && this._fhAwaitHostTransfer && this._trigger === 0 && !this._fhOwner) {
        this._fhAwaitHostTransfer = false;
    }
    // only the map's own event (a snapshot builds fresh copies, which start too;
    // one Game_Map.setupEvents makes is not in the list yet - it was let
    // through, and the host who came to Map036 after a guest watched
    // Pocketcat's scene there, EV239, played it again, 0.5.11)
    var slot = $gameMap._events[this.eventId()];
    if ($.runsWorld() && this._trigger === 3 && !this._fhOwner && !$gamePlayer._fhRemoteId &&
            (!slot || slot === this)) {
        // this page went on with a guest on its own PC (a transfer): not here again
        if (this._fhHandedPage === this._pageIndex) return;
        // Turned on by a guest whose own PC ran this same map (its world
        // changes came here): it played the page there; the host never plays
        // it again (Map040 EV191: a door's scene ending in a transfer took the
        // dead host to the sewers, 0.38.1).
        var first = $.pageLastCause(this);
        if (first && $.causeOwnHere(first) && first.id !== 'host') {
            var firstConn = $.clientById(first.id);
            var targetMap = $.pageTransferMap(this.page());
            if ($.pageTransfers(this.page()) && targetMap && targetMap !== $gameMap.mapId() &&
                    !($.DREAM_MAPS && $.DREAM_MAPS[targetMap]) && firstConn && !$.guestOnMap(firstConn)) {
                this._fhAwaitHostTransfer = true;
                this._trigger = 0;
                this._starting = false;
                if (this._fhHostTransferLogged !== this._pageIndex) {
                    this._fhHostTransferLogged = this._pageIndex;
                    $.dlog('autorun ev' + this.eventId(), 'p' + this._pageIndex,
                        'waits for the host to use the transfer after', first.id, 'left');
                }
                return;
            }
            if (this._fhOwnRunLogged !== this._pageIndex) {
                this._fhOwnRunLogged = this._pageIndex;
                $.dlog('autorun ev' + this.eventId(), 'p' + this._pageIndex, 'ran on the PC of', first.id, '- not here');
            }
            return;
        }
        var cause = $.pageCause(this);
        if (cause && cause.id === 'host') this._fhLoopOwner = null; // (the host's press now)
        if (!cause) cause = $.loopCause(this);
        var conn = cause && cause.id !== 'host' ? $.clientById(cause.id) : null;
        // A guest running its own map set it and may be on its way here (the
        // well: jump down on its map, land on the host's): the page waits for
        // it while the cause is fresh (not renewed: then the host's again).
        if (conn && conn.actorId && (conn.roam || conn.roamPending) && !$.isDown(conn.guestId)) {
            if (!cause.waitLogged) {
                cause.waitLogged = true;
                $.dlog('autorun ev' + this.eventId(), 'waits for', conn.name, '(its own map set it)');
            }
            return;
        }
        // a story scene stays shared (autorun scenes are everyone's), but not
        // one that shows or hides the player (the landing after the well fall)
        // (nor one whose effect is on that player alone: the Sylvanus sigil's
        // full heal at a ritual circle healed the host, not the guest who drew it)
        // A fight it set off while it lies down (it cannot fight): the page
        // waits for that player to stand up, not the host's fight (0.40 ③ S8).
        if (conn && conn.actorId && $.guestOnMap(conn) && $.isDown(conn.guestId) && !$.isDead(conn.guestId) &&
                $.pageFights(this.page())) {
            cause.at = $.clockMs();
            if (this._fhDownWaitLogged !== this._pageIndex) {
                this._fhDownWaitLogged = this._pageIndex;
                $.dlog('autorun ev' + this.eventId(), 'p' + this._pageIndex, 'is a fight set off by', conn.name, '(down) - waits');
            }
            return;
        }
        // (nor one with a fight of its own: whoever turned it on fights it,
        // user decision 2026-10-22 - the Moonless beast, Map092 EV105 page 2,
        // opened on the host wherever it stood when a guest stepped on the line)
        if (conn && conn.actorId && $.guestOnMap(conn) && !$.isDown(conn.guestId) &&
                (!$.isCutscenePage(this.page()) || $.pageMovesPlayer(this.page()) || $.pagePersonal(this.page()) ||
                $.pageUsesBag(this.page()) || $.pageFights(this.page()) || $.eventEndsGame(this) ||
                $.eventReadsKeys(this))) {
            // its event is still finishing, or the host's own run of this
            // event (another of its pages) goes on: wait for it. (Falling
            // through queued the page for the host's interpreter: the host
            // played that guest's scene as its own.)
            if ($.isBusy(conn) || $.hostRunHolds(this)) {
                cause.at = $.clockMs();
                cause.n = ++$.causeSeq;
                return;
            }
            if ($.startEventFor(conn, this, [3])) {
                this._fhLoopOwner = { id: conn.guestId, page: this._pageIndex };
                return;
            }
        }
        // A page that moves the player, turned on by a guest who did not come
        // (its own map ran it: a bed's night scene, Map020 EV191 Samarie /
        // Caligura creeping in) or with the host dead: never the host's. It
        // took the dead host into a dream (0.38.1).
        if ($.pageTransfers(this.page())) {
            var last = $.pageLastCause(this);
            var lastConn = last && last.id !== 'host' ? $.clientById(last.id) : null;
            var away = !!last && last.id !== 'host' && (!lastConn || !$.guestOnMap(lastConn));
            // (the ghost host's own way on: a door's opening it started, an
            // elevator's ride - FH_CoopBattle $.ghostMovePage; not a guest's)
            var ghostWay = $gamePlayer._fhGhost && $.ghostWayOn && (!last || last.id === 'host') && $.ghostWayOn(this);
            if (away || ($.isDead('host') && !ghostWay)) {
                if (this._fhNotHostLogged !== this._pageIndex) {
                    this._fhNotHostLogged = this._pageIndex;
                    $.dlog('autorun ev' + this.eventId(), 'p' + this._pageIndex, 'moves the player and is not the host\'s:',
                        last ? 'set by ' + last.id : 'the host is dead', '- not run here');
                }
                return;
            }
        }
        this._fhPressPage = cause && cause.id === 'host' && cause.press ? this._pageIndex : -1;
    }
    _Game_Event_start_cause.call(this);
};

// Traps from the menu: item 76 Bear trap -> CE55 turns SW301 bearTREP on,
// item 104 Booby trap -> CE17 turns SW66 Smoke_TREP on. Every map has trap
// events (bearTrap1, smoke_trap1 ...) whose parallel page on that switch
// reads the player's tile (122 game data: player map X / Y), moves itself
// there (203) and turns the switch off. That page runs on the PC running the
// map, with that PC's player: a thin guest's trap appeared under the host,
// and a roaming guest's (its switch came with its world changes) moved the
// host's copy under the host too (0.38.1). Now the page reads the tile of
// the player who set the trap; a roaming guest's trap on another map is
// not placed on the host's map at all (its own PC placed it there).
$.TRAP_SWITCHES = { 301: true, 66: true };
$.trapOwner = null; // host: { id, x, y } of the guest whose trap is being set

var _swSetTrap = Game_Switches.prototype.setValue;
Game_Switches.prototype.setValue = function(id, value) {
    _swSetTrap.call(this, id, value);
    if (this !== $gameSwitches || !$.TRAP_SWITCHES[id] || !value || !$.role || !$.runsWorld()) return;
    var gid = $.ctx && $.ctx.guestId;
    var r = gid && $.remotes && $.remotes[gid];
    $.trapOwner = r ? { id: gid, x: r.x, y: r.y } : null;
};

// A roaming guest's world changes turned one on.
// Returns the switches not placed here: they go back to nobody (an echo
// would turn the trap off on its PC before its own page placed it, and
// move every other roaming guest's trap under that guest).
$.trapFromGuest = function(conn, sw) {
    var dropped = [];
    Object.keys(sw || {}).forEach(function(id) {
        if (!$.TRAP_SWITCHES[id] || !sw[id]) return;
        var p = conn.lastPos || {};
        if (p.m === $gameMap.mapId()) {
            $.trapOwner = { id: conn.guestId, x: p.x, y: p.y };
        } else {
            $.trapOwner = null;
            $gameSwitches._data[id] = false; // its own PC placed it on its map
            dropped.push(Number(id));
            $.dlog('trap of', conn.name, 'on map', p.m, ': not placed on the host map');
        }
    });
    return dropped;
};

$.isTrapPage = function(list) {
    return (list || []).some(function(cmd) {
        var p = cmd.parameters;
        if (cmd.code !== 121 || p[2] !== 1) return false;
        for (var id = p[0]; id <= p[1]; id++) if ($.TRAP_SWITCHES[id]) return true;
        return false;
    });
};

var _gameDataOperandTrap = Game_Interpreter.prototype.gameDataOperand;
Game_Interpreter.prototype.gameDataOperand = function(type, param1, param2) {
    var o = $.trapOwner;
    if (type === 5 && param1 === -1 && (param2 === 0 || param2 === 1) && o && $.isTrapPage(this._list)) {
        return param2 === 0 ? o.x : o.y;
    }
    return _gameDataOperandTrap.call(this, type, param1, param2);
};

var _command121Trap = Game_Interpreter.prototype.command121;
Game_Interpreter.prototype.command121 = function() {
    var p = this._params;
    var done = !!$.trapOwner && p[2] === 1 && $.isTrapPage([this.currentCommand()]);
    var result = _command121Trap.call(this);
    if (done) $.trapOwner = null;
    return result;
};

// The yellow mage's field Hurting (day mage Map037 EV010 etc., Mastermind
// Map080 EV104/117): floor tiles in its sight turn SW3772 dance on, the map's
// parallel page casts and turns SW3775 hurting on, and the autorun page on
// SW3775 calls CE420, which cuts a limb of the SELECT character. That page
// was the host's (the parallel page set its switch): a guest who walked into
// the sight cost the host a limb. Now the player whose step turned the dance
// on first is its target: SW3775 counts as that player's write, so the
// autorun page runs as that player's ("Autorun pages a guest turned on").
$.YM_DANCE_SWITCH = 3772;
$.YM_HURT_SWITCH = 3775;
$.ymTarget = null; // host / sub-host: guestId | 'host' - who the dance is on

var _swSetYellowMage = Game_Switches.prototype.setValue;
Game_Switches.prototype.setValue = function(id, value) {
    var was = this === $gameSwitches && this.value(id);
    _swSetYellowMage.call(this, id, value);
    if (this !== $gameSwitches || !$.role || !$.runsWorld()) return;
    if (id === $.YM_DANCE_SWITCH) {
        if (value && !was) {
            $.ymTarget = $.ctx && $.ctx.guestId ? $.ctx.guestId : 'host';
            $.dlog('yellow mage: sees', $.playerLabel ? $.playerLabel($.ymTarget) : $.ymTarget, 'first');
        } else if (!value) {
            $.ymTarget = null;
        }
    } else if (id === $.YM_HURT_SWITCH && value && $.ymTarget && $.ymTarget !== 'host') {
        $.causes['sw:' + id] = { id: $.ymTarget, at: $.clockMs(), n: ++$.causeSeq };
    }
};

// The one it sees is down, dead or gone from this map (or runs it on its own
// PC): the dance stops - nobody else takes its Hurting. (The original: losing
// to it is a game over, so nobody lay in its sight.) A sub-host checks its own
// map the same way ('host' is its own player there; isDown/isDead use pstateOf).
$.ymCheckTarget = function() {
    var id = $.ymTarget;
    if (!id || !$.runsWorld() || !$gameSwitches._data[$.YM_DANCE_SWITCH]) return;
    var why = '';
    if ($.isDown && $.isDown(id)) why = 'down';
    else if ($.isDead && $.isDead(id)) why = 'dead';
    else if (id !== 'host') {
        var c = $.clientById(id);
        if (!c) why = 'left';
        else if (c.roam) why = 'runs its own map';
        else if (!c.lastPos || (c.lastPos.m && c.lastPos.m !== $gameMap.mapId())) why = 'not on this map';
    }
    if (!why) return;
    $.dlog('yellow mage: its target is', why, '- the dance stops');
    $gameSwitches.setValue($.YM_DANCE_SWITCH, false);
    $.ymTarget = null;
};
$.worldExtras.push(function() {
    if (Graphics.frameCount % 10 === 0) $.ymCheckTarget();
});

$.pageTransferCommands = function(list, seen, result) {
    seen = seen || {};
    result = result || [];
    for (var i = 0; i < (list || []).length; i++) {
        var command = list[i];
        if (command.code === 201) {
            result.push(command);
            continue;
        }
        if (command.code !== 117) continue;
        var id = Number(command.parameters[0]);
        if (!id || seen[id]) continue;
        seen[id] = true;
        var commonEvent = $dataCommonEvents[id];
        if (commonEvent) $.pageTransferCommands(commonEvent.list, seen, result);
    }
    return result;
};

$.pageTransferCommand = function(list, seen) {
    return $.pageTransferCommands(list, seen)[0] || null;
};

$.pageTransfers = function(page) {
    if (!page) return false;
    if (page._fhTransfers === undefined) page._fhTransfers = !!$.pageTransferCommand(page.list, {});
    return page._fhTransfers;
};

// A Battle Processing (301) of the page's own (a fixed fight: an autorun boss
// page, an enemy's touch page). FH_CoopRoam "Fixed fights" uses it too.
$.pageFights = function(page) {
    if (!page) return false;
    if (page._fhFights === undefined) {
        page._fhFights = (page.list || []).some(function(cmd) { return cmd.code === 301; });
    }
    return page._fhFights;
};

// The cause keys of this page's conditions.
$.pageCauseKeys = function(ev) {
    var page = ev.page();
    if (!page) return [];
    var c = page.conditions, keys = [];
    if (c.switch1Valid) keys.push('sw:' + c.switch1Id);
    if (c.switch2Valid) keys.push('sw:' + c.switch2Id);
    if (c.variableValid) keys.push('v:' + c.variableId);
    if (c.selfSwitchValid) keys.push('ss:' + [$gameMap.mapId(), ev.eventId(), c.selfSwitchCh].join(','));
    return keys;
};

// A guest's write that its own PC made on this map (it played the pages
// there), also when this PC came to the map after it.
$.causeOwnHere = function(cause) {
    return !!cause && (!!cause.own || (!!cause.m && !!$gameMap && cause.m === $gameMap.mapId()));
};

// The newest write that turned this page on, however old.
$.pageLastCause = function(ev) {
    if (!ev.page()) return null;
    var best = null;
    $.pageCauseKeys(ev).forEach(function(k) {
        var cause = $.causes[k];
        if (cause && $.newerCause(cause, best)) best = cause;
    });
    return best;
};

// Change Transparency (211) is about the one player the page is for.
$.pageMovesPlayer = function(page) {
    if (page._fhMovesPlayer === undefined) {
        page._fhMovesPlayer = (page.list || []).some(function(cmd) { return cmd.code === 211; });
    }
    return page._fhMovesPlayer;
};

// A scene whose effect is on the party (one player's): CE267 FULL_HEAL.
// Data: the ritual circles' Sylvanus page (Map005 EV146 page 7, Map020/147
// EV316, Map051 EV389, Map114 EV33: autorun on SW4023, tint + CE267 + the
// outfit CEs + "You feel rejuvenated") after a player drew that sigil.
// CE420 YELLOW_MAGE_HURTING: the limb of the player the mage saw first.
$.PERSONAL_SCENE_CES = { 267: true, 420: true };
$.pagePersonal = function(page) {
    if (!page) return false;
    if (page._fhPersonal === undefined) {
        page._fhPersonal = (page.list || []).some(function(cmd) {
            return cmd.code === 117 && !!$.PERSONAL_SCENE_CES[cmd.parameters[0]];
        });
    }
    return page._fhPersonal;
};

// The Sylvanus sigil's full heal is for everyone standing in that ritual
// circle (user request 2026-11-02). The drawer stands on the circle's middle
// tile (its event: "Draw the sigil" with the Chalk); the circle is the 3x3
// around it. The heal page (CE267 + "You feel rejuvenated") runs as the
// drawer's; each other player in the circle gets CE267 and the same words as
// its own. The affinity (V264 +1) is the drawing page's: the drawer's alone.
$.CIRCLE_HEAL_CE = 267;
$.CHALK_ITEM = 207;
$.circleHeals = []; // [{ ids: ['host' (this PC's player) | guest id], gab: text }]

// A ritual circle's middle event: one of its pages asks for the chalk.
$.isRitualCircle = function(ev) {
    var data = ev && ev.event && ev.event();
    if (!data || !data.pages) return false;
    if (data._fhCircle === undefined) {
        data._fhCircle = data.pages.some(function(p) {
            return (p.list || []).some(function(cmd) {
                return cmd.code === 111 && cmd.parameters[0] === 8 && cmd.parameters[1] === $.CHALK_ITEM;
            });
        });
    }
    return data._fhCircle;
};

$.inCircle = function(ev, x, y) {
    return Math.abs(x - ev.x) <= 1 && Math.abs(y - ev.y) <= 1;
};

// The players in the circle but the drawer ('host': this PC's player).
$.circleOthers = function(ev, drawer) {
    var ids = [], me = $.realPlayer || $gamePlayer;
    if (drawer !== 'host' && $.inCircle(ev, me.x, me.y) && !me._fhGhost && !$.isDownMe() && !$gameParty.inBattle()) {
        ids.push('host');
    }
    $.clients.forEach(function(c) {
        if (c.guestId === drawer || !c.lastPos || !$.fieldGuestFree(c)) return;
        if ($.inCircle(ev, c.lastPos.x, c.lastPos.y)) ids.push(c.guestId);
    });
    return ids;
};

// The page's own words (GabText), whatever language the data is in.
$.pageGabText = function(list) {
    for (var i = 0; i < (list || []).length; i++) {
        var cmd = list[i], text = cmd.code === 356 ? String(cmd.parameters[0] || '') : '';
        if (/^GabText /.test(text)) return text.slice(8);
    }
    return '';
};

var _command117Circle = Game_Interpreter.prototype.command117;
Game_Interpreter.prototype.command117 = function() {
    if (this._params[0] === $.CIRCLE_HEAL_CE && $.role && $.runsWorld() && this._eventId > 0) {
        var ev = $gameMap.event(this._eventId);
        if ($.isRitualCircle(ev)) {
            var ids = $.circleOthers(ev, this._fhOwner || 'host');
            if (ids.length) $.circleHeals.push({ ids: ids, gab: $.pageGabText(this._list) });
        }
    }
    return _command117Circle.call(this);
};

$.healInCircle = function(id, gab) {
    var heal = $dataCommonEvents[$.CIRCLE_HEAL_CE];
    if (!heal) return;
    if (id === 'host') {
        var interp = new Game_Interpreter();
        interp.setup(heal.list, 0);
        $.causeSkip = true;
        try {
            for (var i = 0; i < 10 && interp.isRunning(); i++) interp.update();
        } finally {
            $.causeSkip = false;
        }
        if (gab) $.fieldGab(gab);
        $.dlog('ritual circle: full heal for this PC\'s player (in the circle)');
        return;
    }
    var conn = $.clientById(id);
    if (!conn || !conn.actorId || !$.guestOnMap(conn) || $.isDown(conn.guestId)) return;
    if (!$.fieldGuestFree(conn)) {
        $.queueCommonEvent(conn, $.CIRCLE_HEAL_CE); // busy since: the heal once it is free
        $.dlog('ritual circle: full heal for', conn.name, 'queued (busy)');
        return;
    }
    var list = [{ code: 117, indent: 0, parameters: [$.CIRCLE_HEAL_CE] }];
    if (gab) {
        list.push({ code: 356, indent: 0, parameters: ['GabText ' + gab] },
            { code: 356, indent: 0, parameters: ['ShowGab'] });
    }
    list.push({ code: 0, indent: 0, parameters: [] });
    $.runOwned(conn, list, null);
    $.owned[conn.guestId].queued = true; // (its switches set off no one's page)
    $.dlog('ritual circle: full heal for', conn.name, '(in the circle)');
};

$.worldExtras.push(function() {
    if (!$.circleHeals.length || $.ctx) return;
    var heals = $.circleHeals;
    $.circleHeals = [];
    heals.forEach(function(h) {
        h.ids.forEach(function(id) { $.healInCircle(id, h.gab); });
    });
});

// A scene that looks in the bag or changes it (gold, items, weapons, armors:
// a condition on them, or a change) is about one player's bag: the ritual
// circle by the altar of the new gods (Map011 EV53, Map051 EV296, Map108
// EV48: SW1062 from a tile by the altar, then "Pray / Give an offering"
// and "Offer the Heart-shaped lock?") ran as the host's shared scene - its
// choices showed on the host too, and it looked in the host's bag
// (2026-11-02). 29 such autorun pages (offerings, the new gods' gifts, the
// spirits of the Cameo, the Bremen lieutenant's trade).
$.BAG_CODES = { 125: true, 126: true, 127: true, 128: true };
$.pageUsesBag = function(page) {
    if (!page) return false;
    if (page._fhUsesBag === undefined) {
        page._fhUsesBag = (page.list || []).some(function(cmd) {
            if ($.BAG_CODES[cmd.code]) return true;
            return cmd.code === 111 && cmd.parameters[0] >= 7 && cmd.parameters[0] <= 10;
        });
    }
    return page._fhUsesBag;
};

// An event whose autorun pages lead to a game over (353): every autorun page
// of it is the player's who set it off - a game over is one player's. The
// white mold apartment bed (Map071 EV173, Map075 EV222: p0 hides the player,
// p1 "You could sleep here forever...", p2 the game over) went to the guest
// for p0 only; p1 and p2 are plain message pages, ran as the host's shared
// scene, and the host died for the guest's rest.
$.eventEndsGame = function(ev) {
    var data = ev && ev.event && ev.event();
    if (!data || !data.pages) return false;
    if (data._fhEndsGame === undefined) {
        data._fhEndsGame = data.pages.some(function(p) {
            return (p.trigger === 3 || p.trigger === 4) && (p.list || []).some(function(cmd) { return cmd.code === 353; });
        });
    }
    return data._fhEndsGame;
};

// A new page: the hand-off mark was for the old one.
var _setupPageHanded = Game_Event.prototype.setupPage;
Game_Event.prototype.setupPage = function() {
    if (this._fhHandedPage !== undefined && this._fhHandedPage !== this._pageIndex) delete this._fhHandedPage;
    _setupPageHanded.call(this);
    if ($.runsWorld() && this._fhAwaitHostTransfer && this._trigger === 3 && $.pageTransfers(this.page())) {
        this._trigger = 0;
    }
};

//=============================================================================
// Screen effects belong to the player they happen to
//=============================================================================
// A guest's event runs on the host (its own interpreter); its tint, flash,
// shake, pictures and sounds already went to the guest (FORWARD_CODES). The
// rest of the "screen" was the host's: filters (FilterController: the
// heartbeat CE456/457 motion blur and RGB split, CE367/370), Olivia's horror
// noise (HorrorEffects Screen / Picture: CE261 static, CE265/281/291),
// Galv's screen zoom (Galv.ZOOM.target / center / restore: the heartbeat's
// zoom) and the small text box (GabText + ShowGab: "You feel rejuvenated").
// Data: these come from game data as Plugin Command (356) or one-line Script
// (355). Now they play on the guest's PC only. The host's own effects never
// reached the guests (a thin guest copies only tone, brightness, weather and
// pictures; filters, zoom and noise are each PC's own).
$.FX_PLUGIN_WORDS = { createFilter: true, setFilter: true, eraseFilter: true, moveFilter: true };

// Also the player's own view, Terrax's flashlight: on the owner's PC. GALV's
// vision circle (VISRANGE) of another player's event plays nowhere (below).
// Terrax "Light on/off <id>" are a map's lamps (light ids), not the
// player's: they stay where they run.
$.FX_VIEW_WORDS = { Flashlight: true };

$.fxPluginCommand = function(text) {
    var words = String(text || '').split(' ');
    if ($.FX_PLUGIN_WORDS[words[0]] || $.FX_VIEW_WORDS[words[0]]) return true;
    return words[0] === 'HorrorEffects' && (words[1] === 'Screen' || words[1] === 'Picture');
};

$.fxScript = function(text) {
    return /^\s*Galv\.ZOOM\.(target|center|restore)\s*\(/.test(String(text || ''));
};

// true: done here (sent to the owner instead)
Game_Interpreter.prototype.fhForwardFx = function(command) {
    var p = command.parameters || [];
    var entry = $.owned[this._fhOwner];
    // the guest's own tint and fade (its screen if the host leaves it on this map)
    if ((command.code === 223 || command.code === 221 || command.code === 222) && entry && entry.interp &&
            $.isOwnedChain(entry.interp, this)) {
        if (command.code === 223) entry.tint = p[0];
        else entry.faded = command.code === 221;
        return false;
    }
    if (command.code === 356) {
        var text = String(p[0] || '');
        var word = text.split(' ')[0];
        if (word === 'ShowGab' || word === 'ForceGab') {
            if (this._gabText) $.sendTo(this._fhOwner, { t: 'gab', text: $.convertForGuest(this._gabText).trim() });
            if (this.clearGabInformation) this.clearGabInformation();
            return true;
        }
        if (word === 'ClearGab') return true; // (the guest's box closes by itself)
        // GALV's vision circle is this PC's player's view: CE104 Room_CHANGE
        // takes it off on every door and the new map's own parallel event
        // puts it back. Run here for another player (its event, or the rest
        // of a door event its PC handed over: unroam +event) it took the
        // circle off this PC's screen (0.41 play test: "vision -" in the
        // host's log after a guest came back through a door, and a wrong
        // circle until the menu). That player's view is its own map's: a
        // guest here sees this map's (snapshot), a roaming one its own map's.
        if (word === 'VISRANGE') {
            $.dlog('vision: VISRANGE', text.split(' ')[1] || '', 'of', $.playerLabel(this._fhOwner) + '\'s event not run here');
            return true;
        }
        if ($.fxPluginCommand(text)) {
            $.sendTo(this._fhOwner, { t: 'cmd', c: 356, p: p });
            return true;
        }
        return false;
    }
    if (command.code === 355 && $.fxScript(p[0]) && this.nextEventCode() !== 655) {
        $.sendTo(this._fhOwner, { t: 'cmd', c: 355, p: p });
        return true;
    }
    return false;
};

$.isOwnedChain = function(top, interp) {
    for (var i = top; i; i = i._childInterpreter) if (i === interp) return true;
    return false;
};

var _executeCommandFx = Game_Interpreter.prototype.executeCommand;
Game_Interpreter.prototype.executeCommand = function() {
    if (this._fhOwner && $.runsWorld()) {
        var command = this.currentCommand();
        if (command && this.fhForwardFx(command)) {
            this._index++;
            return true;
        }
    }
    return _executeCommandFx.call(this);
};

// Galv's zoom on an event the guest's PC does not have (a heartbeat aimed at a
// character event of the host's map): the screen's center instead of an error.
if (typeof Galv !== 'undefined' && Galv.ZOOM && Galv.ZOOM.target) {
    var _galvZoomTarget = Galv.ZOOM.target;
    Galv.ZOOM.target = function(id, scale, duration) {
        if (id > 0 && $gameMap && !$gameMap.event(id) && Galv.ZOOM.center) return Galv.ZOOM.center(scale, duration);
        return _galvZoomTarget.call(this, id, scale, duration);
    };
}

// An enemy that sees a guest (YEP_EventChasePlayer: the chase starts, its
// "alert" common event) - CE263 Enemy_attention turns SW29 on and the
// parallel CE261 ENEMY_ATTENTION! plays the film static, a whimper and the
// horror noise - is that guest's scare, not the host's: the host's PC ran
// it (the chase checks run with a stand-in player at the guest's spot).
// Only an alert that is nothing but the scare goes to the guest's PC as
// effects. Other alerts carry the world too (data: CE364 the Inquisitor's
// bell SW3322, CE419 SW3695, CE317 SW2956, CE548-557 the "spotted" counters
// V2501-2510, CE579/580 the villagers' rage V2732/V2734, CE266 the janitor's
// line): sent away as effects they never reached the world. Those run here
// as that guest's own event (its context: the world gets the story, its
// SW29 static still plays on its PC, see FX_START_SWITCHES).
$.ALERT_FX_CODES = { 0: true, 108: true, 408: true, 230: true, 223: true, 224: true, 225: true, 231: true, 232: true,
    233: true, 234: true, 235: true, 245: true, 246: true, 249: true, 250: true, 251: true };
$.alertIsPersonal = function(id) {
    var ce = $dataCommonEvents && $dataCommonEvents[id];
    if (!ce || !ce.list) return false;
    if (ce._fhAlertFx === undefined) {
        ce._fhAlertFx = ce.list.every(function(cmd) {
            var p = cmd.parameters || [], k;
            if (cmd.code === 121) {
                for (k = p[0]; k <= p[1]; k++) if (!$.FX_START_SWITCHES[k]) return false;
                return true;
            }
            if (cmd.code === 122) {
                for (k = p[0]; k <= p[1]; k++) if (!($.PC_VARS && $.PC_VARS[k])) return false;
                return true;
            }
            if (cmd.code === 356) return $.fxPluginCommand(p[0]);
            return !!$.ALERT_FX_CODES[cmd.code];
        });
    }
    return ce._fhAlertFx;
};

if (Game_Event.prototype.playAlertCommonEvent) {
    var _playAlertCommonEvent = Game_Event.prototype.playAlertCommonEvent;
    Game_Event.prototype.playAlertCommonEvent = function() {
        var id = $gamePlayer && $gamePlayer._fhRemoteId;
        var ceId = this._alertCommonEvent;
        if (id && $.runsWorld() && ceId > 0) {
            var conn = id !== $.NOBODY ? $.clientById(id) : null;
            if ($.alertIsPersonal(ceId)) {
                if (conn) $.sendTo(id, { t: 'fxCe', id: ceId });
                return;
            }
            if (conn) {
                $.queueCommonEvent(conn, ceId);
                return;
            }
            if (id === $.NOBODY) return;
        }
        _playAlertCommonEvent.call(this);
    };
}

// Guest (a thin one: its world is the host's copy, nothing of it is sent
// back): another PC's common event for this player, run here for its
// effects - sounds, screen, pictures, filters, noise, zoom, the small text
// box, and the waits, loops, branches and scratch values between them. No
// messages, transfers, party, item or actor changes. A switch it turns on
// that starts a parallel common event plays that one once, as the original
// does (each turns its switch off at its end):
//   CE263 Enemy_attention (an enemy's "alert") -> SW4820 run_exhaust ->
//   CE582: the heartbeat sound and the pulsing "exhaustion" picture 19;
//   -> SW29 ENEMY_ATTENTION1 -> CE261: film static, a whimper, horror noise.
// This is the heartbeat that played on the host when an enemy saw a guest.
$.FX_RUN_CODES = { 0: true, 108: true, 408: true, 111: true, 411: true, 412: true, 112: true, 113: true,
    413: true, 117: true, 121: true, 122: true, 230: true, 223: true, 224: true, 225: true,
    231: true, 232: true, 233: true, 234: true, 235: true, 245: true, 246: true, 249: true, 250: true, 251: true };
$.FX_RUNS_MAX = 4;
$.fxRuns = [];

$.fxRunAllows = function(cmd) {
    var c = cmd.code, p = cmd.parameters || [];
    if (c === 121 && p[2] === 0) {
        for (var id = p[0]; id <= p[1]; id++) $.fxStartParallel(id);
    }
    if ($.FX_RUN_CODES[c]) return true;
    if (c === 356) return $.fxPluginCommand(p[0]) || /^(GabText|ShowGab|ClearGab)(\s|$)/.test(String(p[0] || ''));
    if (c === 355) return $.fxScript(p[0]);
    return false;
};

$.fxStartParallel = function(switchId) {
    ($dataCommonEvents || []).forEach(function(ce) {
        if (ce && ce.trigger === 2 && ce.switchId === switchId) $.runFxCommonEvent(ce.id);
    });
};

$.runFxCommonEvent = function(id) {
    var ce = $dataCommonEvents && $dataCommonEvents[id];
    if (!ce || !ce.list || $.fxRuns.length >= $.FX_RUNS_MAX) return false;
    // the same one already playing: not twice at once
    if ($.fxRuns.some(function(i) { return i._list === ce.list; })) return false;
    var interp = new Game_Interpreter();
    interp._fhFx = true;
    interp.setup(ce.list, 0);
    $.fxRuns.push(interp);
    return true;
};

var _executeCommandFxRun = Game_Interpreter.prototype.executeCommand;
Game_Interpreter.prototype.executeCommand = function() {
    if (this._fhFx) {
        var command = this.currentCommand();
        if (command && !$.fxRunAllows(command)) {
            this._index++;
            return true;
        }
    }
    return _executeCommandFxRun.call(this);
};

var _setupChildFx = Game_Interpreter.prototype.setupChild;
Game_Interpreter.prototype.setupChild = function(list, eventId) {
    _setupChildFx.call(this, list, eventId);
    if (this._fhFx && this._childInterpreter) this._childInterpreter._fhFx = true;
};

$.guestHandlers.fxCe = function(msg) {
    var id = Number(msg.id);
    if (!$gameMap || !$dataCommonEvents[id]) return;
    if ($.isRoaming && $.isRoaming()) {
        $gameTemp.reserveCommonEvent(id); // its own world: as the original
        return;
    }
    if ($.runFxCommonEvent(id)) $.dlog('effects of CE' + id, 'played here (another PC ran it for this player)');
};

$.guestHandlers.fxSw = function(msg) {
    var id = Number(msg.id);
    if (!$gameMap || !$.FX_START_SWITCHES[id]) return;
    if ($.isRoaming && $.isRoaming()) {
        $gameSwitches.setValue(id, true);
        return;
    }
    $gameSwitches._data[id] = true; // (its parallel event turns it off at its end)
    $.fxStartParallel(id);
};

// Host: a guest's event turning one of these on (Map026 EV17/EV34 touch
// pages set SW4820) scares that guest, on its PC; the host's stays the host's.
$.FX_START_SWITCHES = { 29: true, 4820: true };
var _swSetFxStart = Game_Switches.prototype.setValue;
Game_Switches.prototype.setValue = function(id, value) {
    if (this === $gameSwitches && $.FX_START_SWITCHES[id] && $.ctx && $.ctx.guestId && $.runsWorld()) {
        if (value) $.sendTo($.ctx.guestId, { t: 'fxSw', id: id });
        return;
    }
    _swSetFxStart.call(this, id, value);
};

// The "exhaustion" picture (CE582's pulse) is each player's own: the host's is
// not copied to the guests' screens (a thin guest's own comes from its CE582).
$.PERSONAL_PICTURES = { exhaustion: true };
var _pictureInfoFx = $.pictureInfo;
$.pictureInfo = function(pic) {
    if (pic && pic.name && ($.PERSONAL_PICTURES[pic.name()] || $.privatePicture(pic))) return null;
    return _pictureInfoFx(pic);
};

// The coin / soul stone count (CE262 COIN_HUD, CE290 SOULSTONE_HUD: pictures 14-17 -
// coin_background, the icon, two digits) is the count of this PC's player: the host's
// or a sub-host's went to every guest on its map with its sync (gallery 4p report
// 2026-11-09: the coin picture on the others' screens, the host's own chest).
// (data: these names as pictures 14-17 are only these two events' - their icons
// icon_small_coin / icon_small_stone. By name and place, not by the background:
// a snapshot's pictures are taken away one by one, the background first)
$.COUNT_HUD_PICS = [14, 15, 16, 17];
$.countHudPicture = function(pic) {
    if (!pic || !$gameScreen || !pic.name || !pic.name()) return false;
    var at = function(id) { return $gameScreen.picture(id) === pic; };
    var name = pic.name();
    if (at(14)) return name === 'coin_background';
    if (at(15)) return name === 'icon_small_coin' || name === 'icon_small_stone';
    if (at(16) || at(17)) return /^number_\d$/.test(name);
    // the ammo count (CE10 AMMO_HUD, pictures 10-13; data: these names there are only
    // CE10's - Map073's intro pictures and Map102's blackscreen use other names)
    if (at(10)) return name === 'ammo_background';
    if (at(11)) return /^icon_small_(rifle|shotgun|pistol)$/.test(name);
    if (at(12) || at(13)) return /^number_\d$/.test(name);
    return false;
};

// What a player's own item or skill shows is that player's (2026-11-10, the same
// class as the coin picture): the common event it reserves (a book, a letter, the
// Prehevil map, the character chart, party talk ... - 64 items) runs on the map
// interpreter of the PC running that map, and its pictures went to every guest on
// that map with the sync (and with a snapshot / roam start). Its text did not (a
// reserved common event is no shared scene). The pictures that interpreter (and its
// children) shows are marked; the sync and a world sent leave them out, and the
// guest that gets a world keeps its own. By where they come from, not by name: the
// same pictures serve shared scenes too (the endings, character select, the Ouija
// board events, the day text after a bed).
$.ownCeReserved = 0; // a common event this PC's own player reserved by an item / skill
var _applyGlobalOwnCe = Game_Action.prototype.applyGlobal;
Game_Action.prototype.applyGlobal = function() {
    var was = $.ownCeAction;
    $.ownCeAction = !$.ctx && !$gameParty.inBattle();
    try {
        _applyGlobalOwnCe.call(this);
    } finally {
        $.ownCeAction = was;
    }
};
var _reserveCommonEventOwn = Game_Temp.prototype.reserveCommonEvent;
Game_Temp.prototype.reserveCommonEvent = function(id) {
    _reserveCommonEventOwn.call(this, id);
    if ($.ownCeAction && this._commonEventId === id) $.ownCeReserved = id;
};
var _setupStartingEventOwn = Game_Map.prototype.setupStartingEvent;
Game_Map.prototype.setupStartingEvent = function() {
    var id = $gameTemp.isCommonEventReserved() ? $gameTemp._commonEventId : 0;
    var started = _setupStartingEventOwn.call(this);
    if (started && id && id === $.ownCeReserved && !$gameTemp.isCommonEventReserved()) {
        this._interpreter._fhPersonalPics = true;
        $.ownCeReserved = 0;
    }
    return started;
};
var _clearPersonalPics = Game_Interpreter.prototype.clear;
Game_Interpreter.prototype.clear = function() {
    _clearPersonalPics.call(this);
    this._fhPersonalPics = false;
};
var _setupChildPersonalPics = Game_Interpreter.prototype.setupChild;
Game_Interpreter.prototype.setupChild = function(list, eventId) {
    _setupChildPersonalPics.call(this, list, eventId);
    if (this._fhPersonalPics && this._childInterpreter) this._childInterpreter._fhPersonalPics = true;
};
var _command231PersonalPics = Game_Interpreter.prototype.command231;
Game_Interpreter.prototype.command231 = function() {
    var result = _command231PersonalPics.call(this);
    if (this._fhPersonalPics && $gameScreen) {
        var pic = $gameScreen.picture(this._params[0]);
        if (pic) pic._fhPersonal = true;
    }
    return result;
};

// A picture that is this PC's player's alone: a count (coin, soul stone, ammo) or
// what its own item showed.
$.privatePicture = function(pic) {
    return !!pic && (!!pic._fhPersonal || $.countHudPicture(pic));
};

// The ammo count is each player's own (user 2026-11-10, "(나)"): CE10 AMMO_HUD
// (parallel on SW79) draws the gun in hand (SW2252-2254, which the character's
// outfit event sets from its weapon) and the bag's ammo for it. A thin guest's PC
// runs no common event: it saw the host's count (synced) and never its own. The
// count is a personal picture now (not synced, not taken from a snapshot), and a
// thin guest's PC draws its own: CE10's list with its own gun and its own bag.
$.AMMO_HUD_CE = 10;
$.AMMO_HUD_EVERY = 6;   // frames (the host's CE10 runs every frame)
$.AMMO_HUD_VAR = 252;   // CE10's scratch value (this PC's, put back)
$.thinAmmoHud = function() {
    if (!$.isThin || !$.isThin() || !$gameMap || !$gameMap.mapId() || $gameParty.inBattle()) return;
    if (!(SceneManager._scene instanceof Scene_Map) || Graphics.frameCount % $.AMMO_HUD_EVERY !== 0) return;
    var ce = $dataCommonEvents && $dataCommonEvents[$.AMMO_HUD_CE];
    var actor = $gameActors.actor($.myActorId);
    if (!ce || !actor || !$gameSwitches.value(ce.switchId)) return;
    // (a shared scene's pictures there - Map073's intro, Map102's blackscreen: not over them)
    var busy = [10, 11, 12, 13].some(function(id) {
        var pic = $gameScreen.picture(id);
        return !!pic && !!pic.name() && !$.countHudPicture(pic);
    });
    if (busy) return;
    var sw = $gameSwitches._data, keep = {}, on = $.gunSwitchesFor(actor);
    $.GUN_EQUIP_SWITCHES.forEach(function(id) {
        keep[id] = sw[id];
        sw[id] = !!on[id];
    });
    var v = $gameVariables._data[$.AMMO_HUD_VAR];
    try {
        var interp = new Game_Interpreter();
        interp.setup(ce.list);
        interp.update(); // (no wait before its pictures: its one wait is at the end)
    } finally {
        $.GUN_EQUIP_SWITCHES.forEach(function(id) { sw[id] = keep[id]; });
        $gameVariables._data[$.AMMO_HUD_VAR] = v;
    }
};
$.guestExtras.push($.thinAmmoHud);

$.guestExtras.push(function() {
    if (!$.fxRuns.length) return;
    // (one may start another: those join the list, from the next frame)
    // Its scratch values are this PC's, like a parallel common event's: one
    // still playing when this guest starts running its own map (a roam) does
    // not send them into the world (CE261's V383 whimper pick).
    $.parallelDepth = ($.parallelDepth || 0) + 1;
    try {
        $.fxRuns.slice().forEach(function(interp) { interp.update(); });
    } finally {
        $.parallelDepth--;
    }
    $.fxRuns = $.fxRuns.filter(function(interp) { return interp.isRunning(); });
});

// Leaving the session: nothing of the old one plays on.
var _leaveAsGuestFx = $.leaveAsGuest;
$.leaveAsGuest = function(message) {
    $.fxRuns = [];
    _leaveAsGuestFx(message);
};

//=============================================================================
// Pages that hang on a player's own switches (the ladders)
//=============================================================================
// SW203 CLIMBING, SW241 coming_UP_LADDERS ... are each player's own
// (CTX_OWN_SWITCHES). The pages on them are that player's too:
// - A thin guest's PC shows the host's pages. A ladder's blocker (Map020
//   EV86 on the ladder tile: page 0 "same as characters", page 1 below the
//   characters while SW203 is on) would close the ladder to a climbing guest.
//   The host sends each thin guest the priority and "through" of such events
//   as that guest's own switches make them ('ownEv').
// - A parallel page on one of them (Map020 EV87 on SW241: tint back to
//   normal, SW202 and SW241 off, after the climb up, EV108, tinted the screen
//   black) runs for each guest whose own switch is on, as that guest's own
//   event. It ran as the host's: the host's screen got the tint back and the
//   guest's stayed black (0.38.3-pre5, "black after the ladder").

$.ownSwIndex = null;
$.ownSwitchIndex = function() {
    if ($.ownSwIndex && $.ownSwIndex.map === $dataMap) return $.ownSwIndex;
    var own = {};
    $.CTX_OWN_SWITCHES.forEach(function(id) { own[id] = true; });
    var idx = { map: $dataMap, all: [], par: [] };
    (($dataMap && $dataMap.events) || []).forEach(function(ev) {
        if (!ev || !ev.pages) return;
        var any = false, par = false;
        ev.pages.forEach(function(p) {
            var c = p.conditions || {};
            if (!((c.switch1Valid && own[c.switch1Id]) || (c.switch2Valid && own[c.switch2Id]))) return;
            any = true;
            if (p.trigger === 4) par = true;
        });
        if (any) idx.all.push(ev.id);
        if (par) idx.par.push(ev.id);
    });
    $.ownSwIndex = idx;
    return idx;
};

// This guest's own values differ from the host's (outside any context).
$.ownSwitchesDiffer = function(conn) {
    var mine = $.ctxOwnOf(conn), sw = $gameSwitches._data;
    return $.CTX_OWN_SWITCHES.some(function(id) { return !!mine[id] !== !!sw[id]; });
};

// [[event id, priority type, through]] where this guest's page is not the host's.
$.ownEventView = function(conn) {
    var out = [];
    if ($.ctx || !$.ownSwitchesDiffer(conn)) return out;
    var ids = $.ownSwitchIndex().all;
    if (!ids.length) return out;
    $.inContext(conn, function() {
        ids.forEach(function(id) {
            var ev = $gameMap.event(id);
            if (!ev || ev._erased) return;
            var index = ev.findProperPageIndex();
            if (index === ev._pageIndex) return;
            var page = index >= 0 ? ev.event().pages[index] : null;
            out.push([id, page ? page.priorityType : 0, page ? (page.through ? 1 : 0) : 1]); // no page: nothing there
        });
    });
    return out;
};

// (the host's guests from hostSync, a sub-host's from subHostSync: FH_CoopRoam)
$.sendOwnEvents = function() {
    if (!$.runsWorld() || !$gameMap || !$gameMap.mapId()) return;
    $.clients.forEach(function(c) {
        if (!c.actorId || c.roam || c.roamPending || c.solo || !$.guestOnMap(c)) return;
        var view = $.ownEventView(c);
        var key = $gameMap.mapId() + ':' + JSON.stringify(view);
        if (key === c._fhOwnEvKey) return;
        c._fhOwnEvKey = key;
        c.send({ t: 'ownEv', m: $gameMap.mapId(), ev: view });
    });
};

var _hostSyncOwnEv = $.hostSync;
$.hostSync = function() {
    _hostSyncOwnEv();
    $.sendOwnEvents();
};

var _sendSnapshotOwnEv = $.sendSnapshot;
$.sendSnapshot = function(conn) {
    ($.snapshotTargets(conn) || []).forEach(function(c) { c._fhOwnEvKey = null; });
    _sendSnapshotOwnEv(conn);
};

// Thin guest: those events as this player's own switches make them.
$.ownEv = null; // { m, ev: { id: [id, priority type, through] } }
$.guestHandlers.ownEv = function(msg) {
    var map = {}, n = 0;
    (msg.ev || []).forEach(function(e) {
        if (e) {
            map[e[0]] = e;
            n++;
        }
    });
    $.ownEv = n ? { m: Number(msg.m) || 0, ev: map } : null;
};

$.ownEvOf = function(ev) {
    var o = $.ownEv;
    if (!o || !$.isThin() || !$gameMap || o.m !== $gameMap.mapId()) return null;
    return o.ev[ev.eventId()] || null;
};

var _evNormalPriorityOwn = Game_Event.prototype.isNormalPriority;
Game_Event.prototype.isNormalPriority = function() {
    var o = $.ownEv ? $.ownEvOf(this) : null;
    return o ? o[1] === 1 : _evNormalPriorityOwn.call(this);
};

var _evThroughOwn = Game_Event.prototype.isThrough;
Game_Event.prototype.isThrough = function() {
    var o = $.ownEv ? $.ownEvOf(this) : null;
    return o ? !!o[2] : _evThroughOwn.call(this);
};

var _processPendingSnapshotOwnEv = $.processPendingSnapshot;
$.processPendingSnapshot = function() {
    if ($.pendingSnapshot) $.ownEv = null; // the host sends them again for the new world
    _processPendingSnapshotOwnEv();
};

var _leaveAsGuestOwnEv = $.leaveAsGuest;
$.leaveAsGuest = function(message) {
    $.ownEv = null;
    _leaveAsGuestOwnEv(message);
};

// The switch of this page that is on for this guest alone (its own), or 0.
$.ownPageSwitch = function(page, mine) {
    var c = page.conditions || {};
    var own = function(id) { return $.CTX_OWN_SWITCHES.indexOf(id) >= 0 && !!mine[id]; };
    if (c.switch1Valid && own(c.switch1Id)) return c.switch1Id;
    if (c.switch2Valid && own(c.switch2Id)) return c.switch2Id;
    return 0;
};

// The page turns that switch off itself (it runs once, not for ever).
$.pageTurnsOff = function(page, sw) {
    return (page.list || []).some(function(cmd) {
        var p = cmd.parameters || [];
        return cmd.code === 121 && p[0] <= sw && p[1] >= sw && p[2] === 1;
    });
};

$.ownParallelLogged = {};
$.runOwnParallels = function() {
    if (!$.runsWorld() || $.ctx || !$gameMap || !$gameMap.mapId() || !$dataMap) return;
    var ids = $.ownSwitchIndex().par;
    if (!ids.length) return;
    $.clients.forEach(function(c) {
        if (!c.actorId || c.roam || c.roamPending || c.solo || !$.guestOnMap(c)) return;
        if ($.isBusy(c) || $.isDown(c.guestId)) return;
        var mine = $.ctxOwnOf(c);
        if (!Object.keys(mine).length) return;
        for (var i = 0; i < ids.length; i++) {
            var ev = $gameMap.event(ids[i]);
            if (!ev || ev._erased || ev._fhOwner || ev._locked || ev._starting) continue;
            var found = $.guestPage(c, ev);
            if (!found || found.page.trigger !== 4 || !found.page.list || found.page.list.length <= 1) continue;
            var sw = $.ownPageSwitch(found.page, mine);
            if (!sw) continue;
            var key = $gameMap.mapId() + ':' + ev.eventId() + ':' + found.index;
            if (!$.pageTurnsOff(found.page, sw)) {
                if (!$.ownParallelLogged[key]) {
                    $.ownParallelLogged[key] = true;
                    $.dlog('parallel ev' + ev.eventId(), 'p' + found.index, 'on the own SW' + sw, 'of', c.name,
                        'never turns it off - not run for it');
                }
                continue;
            }
            $.runOwned(c, found.page.list, ev);
            $.dlog('parallel ev' + ev.eventId(), 'p' + found.index, 'runs for', c.name, '(its own SW' + sw + ')');
            return; // one at a time
        }
    });
};

$.worldExtras.push(function() { $.runOwnParallels(); });

//=============================================================================
// Field skills on other players (user request v6: Marina's Engrave on others)
//=============================================================================
// A skill for one ally, used from the menu (Engrave, skill 335: state 116 on
// the target, then CE298 ENGRAVING finds whoever has state 116 and asks the
// caster which sigil), only reached this PC's own character: the party is one
// player. Its target window now also lists the other players on this map
// (the host and the guests on the host's map). The host's world has their
// characters: the host applies the skill there. A guest pays the cost in its
// menu (its own copy) and asks the host ('fieldUse'), who applies it in that
// guest's context; the skill's common event runs as that guest's (its menu
// closes, as the original does for a skill with a common event). A guest
// running its own map has no one else's character: not there.

$.FIELD_TARGET_SCOPES = { 7: true }; // one living ally (one dead ally: the co-op revive)
$.FIELD_PUSH_MS = 60000;            // the target's PC hears its character this long (the event runs on)
$.fieldTargets = null;              // [{ id: null (this PC's player) | 'host' | guest id, actorId }]

$.fieldSkillFor = function(item) {
    return !!$.role && !!item && DataManager.isSkill(item) && !!$.FIELD_TARGET_SCOPES[item.scope] &&
        (item.occasion === 0 || item.occasion === 2);
};

// This PC's own player's character in the map code (a sub-host's SELECT
// switches are not the host's: never $.hostActorId() there).
$.fieldOwnActorId = function() {
    return $.isHost() ? $.realHostActorId() : $.myActorId;
};

// A guest on the host's map the host can apply a skill to now.
$.fieldGuestFree = function(c) {
    return !!c && !!c.actorId && !!c.inGame && !c.solo && !c.roam && !c.roamPending && !c.subOf &&
        $.guestOnMap(c) && !$.isDead(c.guestId) && !$.isDown(c.guestId) && !$.isBusy(c) && !c._menuBase;
};

// The menu lists only this PC's own character again (user decision
// 2026-10-31: the menu let Marina engrave Levi on another map). A skill on
// another player is used from the player OK box (talking to them):
// $.talkFieldSkills / $.useFieldSkillOn below.
$.FIELD_MENU_OTHERS = false;

$.fieldTargetsFor = function(item) {
    if (!$.FIELD_MENU_OTHERS || !$.fieldSkillFor(item)) return null;
    var out = [{ id: null, actorId: $.isHost() ? $.hostActorId() : $.myActorId }];
    if ($.isHost()) {
        $.clients.forEach(function(c) {
            if ($.fieldGuestFree(c)) out.push({ id: c.guestId, actorId: c.actorId });
        });
    } else if ($.isThin()) {
        // the players drawn on this map (the roster has their characters)
        ($.roster || []).forEach(function(p) {
            if (!p || p.id === $.myId || !p.a || p.dead || !$.remotes[p.id] || !$gameActors.actor(p.a)) return;
            out.push({ id: p.id, actorId: p.a });
        });
    } else {
        return null;
    }
    return out.length > 1 ? out : null;
};

$.fieldTarget = function(win) {
    return $.fieldTargets && win && !win.cursorAll() ? $.fieldTargets[win.index()] || null : null;
};

var _determineItemField = Scene_Skill.prototype.determineItem;
Scene_Skill.prototype.determineItem = function() {
    $.fieldTargets = $.fieldTargetsFor(this.item());
    _determineItemField.call(this);
    if ($.fieldTargets && this._actorWindow) this._actorWindow.refresh();
};

var _hideSubWindowField = Scene_ItemBase.prototype.hideSubWindow;
Scene_ItemBase.prototype.hideSubWindow = function(win) {
    _hideSubWindowField.call(this, win);
    if ($.fieldTargets && win === this._actorWindow) {
        $.fieldTargets = null;
        win.refresh();
    }
};

var _terminateSkillField = Scene_Skill.prototype.terminate;
Scene_Skill.prototype.terminate = function() {
    _terminateSkillField.call(this);
    $.fieldTargets = null;
};

// The target window draws the listed characters (the menu's status window
// draws $gameParty.members()[index]).
var _maxItemsField = Window_MenuActor.prototype.maxItems;
Window_MenuActor.prototype.maxItems = function() {
    return $.fieldTargets ? $.fieldTargets.length : _maxItemsField.call(this);
};

var _drawItemField = Window_MenuActor.prototype.drawItem;
Window_MenuActor.prototype.drawItem = function(index) {
    if (!$.fieldTargets) return _drawItemField.call(this, index);
    var keep = $gameParty._actors;
    $gameParty._actors = $.fieldTargets.map(function(t) { return t.actorId; });
    try {
        _drawItemField.call(this, index);
    } finally {
        $gameParty._actors = keep;
    }
};

var _processOkMenuActorField = Window_MenuActor.prototype.processOk;
Window_MenuActor.prototype.processOk = function() {
    var t = $.fieldTarget(this);
    if (!t) return _processOkMenuActorField.call(this);
    // (the original sets the party's target / menu actor from the party list)
    if (t.id === null) $gameParty.setTargetActor($gameActors.actor(t.actorId));
    Window_Selectable.prototype.processOk.call(this);
};

var _itemTargetActorsField = Scene_Skill.prototype.itemTargetActors;
Scene_Skill.prototype.itemTargetActors = function() {
    var t = $.fieldTarget(this._actorWindow);
    if (!t || t.id === null) return _itemTargetActorsField.call(this);
    var actor = $gameActors.actor(t.actorId);
    return actor ? [actor] : [];
};

$.fieldCes = function(item) {
    return (item.effects || []).filter(function(e) { return e.code === Game_Action.EFFECT_COMMON_EVENT; })
        .map(function(e) { return e.dataId; });
};

var _applyItemField = Scene_Skill.prototype.applyItem;
Scene_Skill.prototype.applyItem = function() {
    var t = $.fieldTarget(this._actorWindow), item = this.item();
    if (!t || t.id === null) return _applyItemField.call(this);
    if ($.isGuest()) {
        // the cost is paid here (this copy goes back with syncMe); the host applies it
        $.conn.send({ t: 'fieldUse', skill: item.id, to: t.id });
        $.dlog('field skill', item.id, 'on', t.id, '- asked the host');
        if ($.fieldCes(item).length) SceneManager.goto(Scene_Map); // its event runs once the menu is closed
        return;
    }
    _applyItemField.call(this);
    var c = $.clientById(t.id);
    $.dlog('field skill', item.id, 'by the host on', c ? c.name : t.id);
    $.fieldTouched(c, $.playerLabel('host') + ' used ' + item.name + ' on you.');
};

// The target's PC gets its character for a while (the skill's event changes it).
$.fieldTouched = function(c, text) {
    if (!c) return;
    c._fieldPushUntil = $.clockMs() + $.FIELD_PUSH_MS;
    c._lastMeKey = null;
    $.pushMe(c);
    if (text) c.send({ t: 'toast', text: 'Co-op: ' + text });
};

$.fieldPushTick = function() {
    var now = $.clockMs();
    $.clients.forEach(function(c) {
        if (!c._fieldPushUntil) return;
        if (now > c._fieldPushUntil) c._fieldPushUntil = 0;
        else $.pushMe(c);
    });
};

$.worldExtras.push(function() {
    if ($.runsWorld() && Graphics.frameCount % 30 === 0) $.fieldPushTick();
});

// This PC's player's skills it can use on the player it talks to now (the
// player OK box: next to it, on its map). Not from a guest running its own
// map alone (no one else's character there).
$.talkFieldSkills = function() {
    if (!$.isHost() && !$.isThin() && !($.subHosting && $.subHosting())) return [];
    var actor = $gameActors.actor($.isHost() ? $.hostActorId() : $.myActorId);
    if (!actor) return [];
    return actor.skills().filter(function(s) { return $.fieldSkillFor(s) && actor.canUse(s); });
};

// Use one on that player ('host' or a guest id). The host checks and applies
// it; the cost is paid then (a guest: on the host's copy, sent back).
$.useFieldSkillOn = function(toId, skillId) {
    var skill = $dataSkills[skillId];
    if (!skill) return;
    if ($.isGuest() && !($.subHosting && $.subHosting())) {
        if ($.conn) $.conn.send({ t: 'fieldUse', skill: skill.id, to: toId, talk: 1 });
        $.dlog('field skill', skill.id, 'on', toId, '(talking) - asked the host');
        return;
    }
    var c = $.clientById(toId), caster = $gameActors.actor($.fieldOwnActorId());
    var target = c && c.actorId && $gameActors.actor(c.actorId);
    var why = '';
    if (!caster || !caster.canUse(skill)) why = 'you cannot use ' + skill.name + ' now';
    else if (!$.fieldGuestFree(c) || !target) why = ((c && c.name) || 'that player') + ' is busy right now';
    var action = null;
    if (!why) {
        action = new Game_Action(caster);
        action.setSkill(skill.id);
        if (!action.testApply(target)) why = 'it would have no effect';
    }
    if (why) {
        $.toast('Co-op: ' + why + '.');
        return;
    }
    caster.useItem(skill); // (the cost)
    for (var i = 0; i < action.numRepeats(); i++) action.apply(target);
    $.fieldCes(skill).forEach(function(id) { if ($dataCommonEvents[id]) $gameTemp.reserveCommonEvent(id); });
    $.dlog('field skill', skill.id, skill.name, 'by the host on', c.name, '(talking)');
    $.fieldTouched(c, $.playerLabel('host') + ' used ' + skill.name + ' on you.');
};

// Host: a guest's skill on another player.
$.hostHandlers.fieldUse = function(conn, msg) {
    var skill = $dataSkills[Number(msg.skill)], caster = conn.actorId && $gameActors.actor(conn.actorId);
    var to = String(msg.to || ''), tc = to === 'host' ? null : $.clientById(to);
    var target = to === 'host' ? $gameActors.actor($.fieldOwnActorId()) : tc && tc.actorId && $gameActors.actor(tc.actorId);
    var why = '';
    if (!skill || !caster || !caster.isLearnedSkill(skill.id) || !$.fieldSkillFor(skill)) why = 'that skill cannot be used on others';
    else if (!$.guestOnMap(conn) || conn.roam || conn.subOf) why = 'you are not on the same map';
    else if (!target) why = 'that player is not here';
    else if (to === 'host' && ($.isDead('host') || $.isDown('host') || $gameParty.inBattle())) why = 'the host cannot take it now';
    else if (tc && !$.fieldGuestFree(tc)) why = (tc.name || 'that player') + ' is busy right now';
    var action = null;
    if (!why) {
        action = new Game_Action(caster);
        action.setSkill(skill.id);
        if (!$.inContext(conn, function() { return action.testApply(target); })) why = 'it would have no effect';
        // from the player OK box: the cost is paid here (not in a menu)
        else if (msg.talk && !$.inContext(conn, function() { return caster.canUse(skill); })) {
            why = 'you cannot use ' + skill.name + ' now';
        }
    }
    if (why) {
        // a menu's cost goes back with its syncMe (talking: nothing was paid)
        if (!msg.talk) conn._fieldRefund = { mp: caster ? caster.skillMpCost(skill) : 0, tp: caster ? caster.skillTpCost(skill) : 0 };
        conn.send({ t: 'toast', text: 'Co-op: ' + why + '.' });
        $.dlog('field skill', msg.skill, 'by', conn.name, 'on', to, 'refused:', why);
        return;
    }
    $.inContext(conn, function() {
        if (msg.talk) caster.useItem(skill);
        for (var i = 0; i < action.numRepeats(); i++) action.apply(target);
    });
    if (msg.talk) {
        conn._lastMeKey = null;
        $.pushMe(conn);
    }
    $.fieldCes(skill).forEach(function(id) {
        if (!$dataCommonEvents[id]) return;
        if (conn._menuBase) (conn._pendingCe = conn._pendingCe || []).push(id); // after its menu (syncMe)
        else $.queueCommonEvent(conn, id);
    });
    $.dlog('field skill', skill.id, skill.name, 'by', conn.name, 'on', to);
    var text = conn.name + ' used ' + skill.name + ' on you.';
    if (tc) $.fieldTouched(tc, text);
    else $.toast('Co-op: ' + text);
};

// A refused one: its cost back (the menu's copy came back with syncMe).
var _syncMeField = $.hostHandlers.syncMe;
$.hostHandlers.syncMe = function(conn, msg) {
    _syncMeField(conn, msg);
    var r = conn._fieldRefund, actor = conn.actorId && $gameActors.actor(conn.actorId);
    if (!r || !actor) return;
    conn._fieldRefund = null;
    actor.gainMp(r.mp || 0);
    actor.gainTp(r.tp || 0);
    conn._lastMeKey = null;
    $.pushMe(conn);
};

// The mark a field skill puts on its target (Engrave: state 116) comes off at
// the end of its common event, from "the entire party" (CE298's last line,
// 313 [0, 0, 1, 116]). The event runs in the caster's world: another player
// as the target kept the mark, and the next Engrave found it there (play test
// 2026-10-31: Marina engraved herself after Levi - "Unfortunately Levi has
// got a sigil already."). It comes off every player's character.
$.fieldMarks = null;
$.fieldMarkStates = function() {
    if (!$.fieldMarks) {
        $.fieldMarks = {};
        $dataSkills.forEach(function(s) {
            if (!s || !$.FIELD_TARGET_SCOPES[s.scope] || !$.fieldCes(s).length) return;
            s.effects.forEach(function(e) {
                if (e.code === Game_Action.EFFECT_ADD_STATE && e.dataId > 0) $.fieldMarks[e.dataId] = true;
            });
        });
    }
    return $.fieldMarks;
};

var _command313Field = Game_Interpreter.prototype.command313;
Game_Interpreter.prototype.command313 = function() {
    var done = _command313Field.call(this);
    var p = this._params;
    if ($.runsWorld() && $.sessionActive() && p[0] === 0 && p[1] === 0 && p[2] === 1 && $.fieldMarkStates()[p[3]]) {
        // (in a guest's context $.hostActorId() is that guest's)
        [$.fieldOwnActorId()].concat($.clients.map(function(c) { return c.actorId; })).forEach(function(id) {
            var actor = id && $gameActors.actor(id);
            if (actor && actor.isStateAffected(p[3])) actor.removeState(p[3]);
        });
    }
    return done;
};

// A thin guest's look is the host's copy of its character: its sheet on the
// map (FH_Coop updateFHCoopGraphic), its face (the menu portrait:
// GALV_BustMenu draws faceName_index), its battler. Its outfit common event
// (CE42 for Marina: a gun in hand %occultist3, the sigil faces on SW602 /
// 606, an arm lost) runs for the host's party only, and a thin guest runs
// none (play test 2026-10-31: Marina's Rher sigil never showed; Levi's pistol
// in her hands - no gun in her hands on the map, no first-time words). The
// host works it out with that event in its context: only its image lines
// run, never the walking sheet (SW1956 off: the host's own run). Its words
// and what it does to that one player (a gun's first-time words and their
// switch, "out of ammo" taking the gun off) run after it as that player's
// own event. When: its event turned a switch, it closed its menu (syncMe),
// a snapshot.
$.ownedSwEntry = null; // the owned run being updated ($.updateOwned)

var _setValueOwned = Game_Switches.prototype.setValue;
Game_Switches.prototype.setValue = function(switchId, value) {
    _setValueOwned.call(this, switchId, value);
    if ($.ownedSwEntry && this === $gameSwitches) $.ownedSwEntry.sw = true;
};

$.outfitCes = null; // actor id -> its outfit common event (parallel, first "if in the party")
$.outfitCeOf = function(actorId) {
    if (!$.outfitCes) {
        $.outfitCes = {};
        $dataCommonEvents.forEach(function(ce) {
            if (!ce || ce.trigger !== 2 || !/Outfit/i.test(ce.name)) return;
            var first = ce.list.filter(function(cmd) { return cmd.code === 111; })[0];
            if (first && first.parameters[0] === 4 && !$.outfitCes[first.parameters[1]]) $.outfitCes[first.parameters[1]] = ce;
        });
    }
    return $.outfitCes[actorId] || null;
};

$.LOOK_SKIP_CODES = [102, 117, 122, 123, 126, 127, 128, 230, 313, 201, 205, 301];
$.LOOK_RUN_SWITCH = 1956;

$.lookOf = function(actor) {
    return [actor.characterName(), actor.characterIndex(), actor.faceName(), actor.faceIndex(), actor.battlerName()].join();
};

// { changed, replay: a list to run as its event, or null }
$.refreshLookOf = function(conn) {
    var actor = conn && conn.actorId && $gameActors.actor(conn.actorId), ce = actor && $.outfitCeOf(conn.actorId);
    if (!ce || $.isDown(conn.guestId)) return { changed: false, replay: null };
    var was = $.lookOf(actor), replay = [];
    var interp = new Game_Interpreter();
    $.LOOK_SKIP_CODES.forEach(function(code) { interp['command' + code] = function() { return true; }; });
    interp.command355 = function() {
        var text = this.currentCommand().parameters[0];
        return /\.set(Character|Face|Battler)Image\(/.test(text) ? Game_Interpreter.prototype.command355.call(this) : true;
    };
    interp.command101 = function() {
        var list = this._list, i = this._index;
        replay.push(list[i]);
        while (list[i + 1] && list[i + 1].code === 401) replay.push(list[++i]);
        return true;
    };
    interp.command121 = function() {
        var p = this._params, own = true;
        for (var id = p[0]; id <= p[1]; id++) if (!($.HEXEN_SW && $.HEXEN_SW[id])) own = false;
        if (own) replay.push(this.currentCommand());
        return true;
    };
    interp.command319 = function() {
        replay.push(this.currentCommand());
        return true;
    };
    interp.setup(ce.list, 0);
    try {
        $.inContext(conn, function() {
            var sw = $gameSwitches._data, run = sw[$.LOOK_RUN_SWITCH];
            sw[$.LOOK_RUN_SWITCH] = false;
            try {
                for (var i = 0; i < 10 && interp.isRunning(); i++) interp.update();
            } finally {
                sw[$.LOOK_RUN_SWITCH] = run;
            }
        });
    } catch (e) {
        $.dlog('ERROR look of', conn.name, e.stack || String(e));
    }
    var now = $.lookOf(actor);
    if (now !== was) $.dlog('look of', conn.name, was, '->', now);
    var words = replay.some(function(cmd) { return cmd.code === 101 || cmd.code === 319; });
    return {
        changed: now !== was,
        replay: words ? replay.map(function(cmd) {
            return { code: cmd.code, indent: 0, parameters: cmd.parameters };
        }).concat([{ code: 0, indent: 0, parameters: [] }]) : null
    };
};

$.lookConn = function(conn) {
    return !!conn && !!conn.actorId && !conn.roam && !conn.subOf && !conn.solo;
};

$.LOOK_WORDS_MS = 60000; // the same words again only after this long (nothing they do changes it)
$.runLookReplay = function(conn, list) {
    if (!list || $.owned[conn.guestId] || $.isBusy(conn)) return;
    var key = JSON.stringify(list), now = $.clockMs();
    if (conn._lookWords && conn._lookWords.key === key && now - conn._lookWords.at < $.LOOK_WORDS_MS) return;
    conn._lookWords = { key: key, at: now };
    $.runOwned(conn, list, null);
    $.owned[conn.guestId].look = true;
    $.dlog('outfit words for', conn.name);
};

var _finishOwnedLook = $.finishOwned;
$.finishOwned = function(id) {
    var entry = $.owned[id], conn = $.clientById(id);
    var look = entry && entry.sw && !entry.look && $.lookConn(conn) ? $.refreshLookOf(conn) : null;
    _finishOwnedLook(id); // (its character goes to its PC)
    if (look && look.replay) $.runLookReplay(conn, look.replay);
};

var _syncMeLook = $.hostHandlers.syncMe;
$.hostHandlers.syncMe = function(conn, msg) {
    _syncMeLook(conn, msg);
    if (!$.lookConn(conn) || $.owned[conn.guestId]) return;
    var look = $.refreshLookOf(conn);
    if (look.changed) {
        conn._lastMeKey = null;
        $.pushMe(conn);
    }
    if (look.replay) $.runLookReplay(conn, look.replay);
};

var _sendSnapshotLook = $.sendSnapshot;
$.sendSnapshot = function(conn) {
    $.clients.forEach(function(c) {
        if ((!conn || c === conn) && $.lookConn(c) && !$.owned[c.guestId] && !$.ctx) $.refreshLookOf(c);
    });
    return _sendSnapshotLook(conn);
};

//=============================================================================
// The host's own tint
//=============================================================================
// The guests on the host's map take the host's screen tone. A tint of an
// event the host pressed (not a talk others hear) is the host's alone: a
// body's "Saw off his head" darkens the screen while sawing (223 to black,
// Map004 EV10 page 5 ...), and every guest's screen went dark with it
// (2026-11-02; a guest's own event's tint already goes to that guest only).
// Meanwhile the guests get the tone from before it, until that event is over
// and its tint back.
$.ownTint = null; // { t: the tone before, list: the map interpreter's event }

$.inMapInterpreter = function(interp) {
    for (var i = $gameMap._interpreter; i; i = i._childInterpreter) if (i === interp) return true;
    return false;
};

$.pressedRun = function() {
    var root = $gameMap._interpreter;
    var ev = root._eventId > 0 ? $gameMap.event(root._eventId) : null;
    var page = ev && ev.page();
    return !!page && (page.trigger <= 2 || $.pressChainPage(ev));
};

var _command223OwnTint = Game_Interpreter.prototype.command223;
Game_Interpreter.prototype.command223 = function() {
    if ($.role && $.runsWorld() && !$.ctx && !$gameParty.inBattle() && $.inMapInterpreter(this)) {
        // (and its own item's event - Heroin, the Necronomicon, Engrave ...: 2026-11-10)
        if (this.isFHCoopShared() || !($.pressedRun() || $gameMap._interpreter._fhPersonalPics)) {
            $.ownTint = null;
        } else if (!$.ownTint) {
            var sc = $gameScreen;
            $.ownTint = { t: (sc._toneDuration > 0 ? sc._toneTarget : sc._tone).slice(), list: $gameMap._interpreter._list };
        }
    }
    return _command223OwnTint.call(this);
};

var _screenInfoOwnTint = $.screenInfo;
$.screenInfo = function() {
    var info = _screenInfoOwnTint();
    var own = $.ownTint;
    if (own) {
        var root = $gameMap._interpreter;
        if ((root.isRunning() && root._list === own.list) || $gameScreen._toneDuration > 0) {
            info.t = own.t.map(Math.round);
        } else {
            $.ownTint = null;
        }
    }
    return info;
};

})(FH.Coop);
