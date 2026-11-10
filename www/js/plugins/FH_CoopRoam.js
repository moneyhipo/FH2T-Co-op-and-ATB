//=============================================================================
// FH_CoopRoam.js
//=============================================================================
/*:
 * @plugindesc v1.0.0 Co-op: every player explores on their own. A guest on a
 * map without the host runs that map on its own PC. Below FH_CoopBattle.
 * @author FH2 Co-op Mod
 *
 * @help
 * Needs FH_Coop, FH_CoopWorld and FH_CoopBattle above it.
 *
 * On the host's map the host runs the map, as before. A guest on any other
 * map runs that map on its own PC, like a single player game with its own
 * character. Switches, variables and self switches that events change are
 * sent both ways through the host, so story progress is shared. Changes made
 * by parallel processes (hunger, fear, run meter, HUD) stay on each PC. The
 * guest's character and belongings go to the host for the host's save.
 *
 * Moving between the two:
 * - A transfer in a guest's event (door, stairs) moves only that guest. When
 *   it leads off the host's map, the rest of the event runs on the guest's PC.
 * - When the host leaves a map, the guests there stay and run it themselves.
 * - A guest who walks onto the host's map, or whose map the host walks onto,
 *   goes back to the host's game as soon as nothing runs on its PC.
 *
 * Two guests on one map without the host: the one there first runs the map
 * for the other, like the host does. Fights there can be joined (OK on the
 * enemy or on the fighting player) and the down revived, as on the host's map.
 *
 * Tutorial: everyone plays it on its own PC, but the workshop fight (the
 * janitor) can be joined by another player on the same map: OK on the
 * fighting player.
 *
 * Global Meta (ending unlocks) is the host's: guests never write it.
 */

var FH = FH || {};
FH.Coop = FH.Coop || {};

(function($) {
'use strict';

if (!$.handleGameOver) {
    console.error('FH_CoopRoam needs FH_CoopBattle.js above it.');
    return;
}

$.roam = null;        // guest: this PC runs its own map { leaving, since }
$.pendingRoam = null; // guest: 'roam' message waiting for the map scene
$.hostMapId = 0;      // guest: the host's map, from 'state'
$.handOffs = {};      // host: guest id -> its event moves to its PC
$.backToHost = null;  // guest: transfer onto the host's map waiting to be sent

$.isRoaming = function() {
    return !!$.roam && !$.roam.leaving;
};

// A roaming guest runs everything itself; while it leaves it waits like a
// thin client.
var _isThin = $.isThin;
$.isThin = function() {
    // (a host, sub-host or nobody: never - asked for every event every frame)
    if ($.role !== 'guest' || $.isRoaming()) return false;
    return _isThin();
};

//=============================================================================
// Global Meta (ending unlocks): the host's config only
//=============================================================================
// Olivia_MetaControls keeps <Global Meta> switches in config.rpgsave. The
// endings belong to the host's game. The other Global Meta switches are
// options (run key, message sounds, filters) and stay each PC's own.

$.ENDING_META = [];
for (var em = 1428; em <= 1440; em++) $.ENDING_META.push(em);
$.OPTION_META = [1540, 2245, 3353, 3397, 3400, 3679, 3680];

$.isEndingMeta = function(id) {
    return $.ENDING_META.indexOf(id) >= 0;
};

var _swValue = Game_Switches.prototype.value;
Game_Switches.prototype.value = function(id) {
    if ($.isGuest() && $.isEndingMeta(id)) return !!this._data[id];
    return _swValue.call(this, id);
};

// The host's values are in _data before anything is sent to a guest.
$.refreshMeta = function() {
    if (!$.isHost() || !$gameSwitches) return;
    $.ENDING_META.forEach(function(id) { $gameSwitches.value(id); });
};

var _makeSaveContents = DataManager.makeSaveContents;
DataManager.makeSaveContents = function() {
    $.refreshMeta();
    return _makeSaveContents.call(this);
};

var _fhDelegateBattle = Game_Interpreter.prototype.fhDelegateBattle;
Game_Interpreter.prototype.fhDelegateBattle = function() {
    $.refreshMeta();
    return _fhDelegateBattle.call(this);
};

var _startPvpMeta = $.startPvp;
$.startPvp = function(attackerId, foeId) {
    $.refreshMeta();
    return _startPvpMeta(attackerId, foeId);
};

var _startMeleeMeta = $.startMelee;
$.startMelee = function(ids) {
    $.refreshMeta();
    return _startMeleeMeta(ids);
};

//=============================================================================
// Shared world: switches, variables, self switches
//=============================================================================

$.NO_SYNC_SWITCHES = {};
// (410 CANNOTUSE_BOW: each PC's "a scene runs", like 202; 29 ENEMY_ATTENTION1 and
// 4820 run_exhaust: an enemy saw this PC's player - its parallel CE261 / CE582
// play the static and the heartbeat on this PC, FH_CoopWorld)
// (203 CLIMBING, 241 coming_UP_LADDERS, 4318 UPSTAIRS: where that player is on
// a ladder, FH_CoopWorld CTX_OWN_SWITCHES)
// The doors' steps (door1_1..4, door2_1..4, door3_1..3, door_3_1..4,
// door_4_1..4): a door turns them on one by one, an autorun page on each
// moves the player, and CE104 Room_CHANGE turns them all off on the new
// map. They are where one player's door is: shared, the host's door made a
// door on a roaming guest's map start (Map016 EV276 took the guest to the
// small hut), and a guest left behind got the host's last step on and went
// through the host's door after it (Map039 EV411, 2026-11-01).
// The elevators the same way (2026-11-02): SW196 elevator2 (Map024/026/116/
// 118 EV27: an autorun on it goes down to Map025), SW2967 elevator_use (the
// church shortcut: Map041 EV148, Map045/051 EV222, Map170 EV23 ask the
// floor and move), and the rope lifts' steps V2025 / V2026 (Map167/169/173:
// autorun pages on 1 and 2 go to Map168, $.DOOR_VARS, kept out like PC_VARS).
$.DOOR_SWITCHES = [74, 75, 76, 77, 190, 191, 192, 193, 591, 592, 593,
    3361, 3362, 3363, 3364, 3365, 3366, 3367, 3368, 196, 2967];
$.DOOR_VARS = [2025, 2026];
$.clearDoorSteps = function() {
    $.DOOR_SWITCHES.forEach(function(id) { $gameSwitches._data[id] = false; });
    $.DOOR_VARS.forEach(function(id) { $gameVariables._data[id] = 0; });
};
// The hard mode Bellends' fall (2026-11-02 night): the frames of the fall
// (bellend_jump1-5, bellend2_jump1-5) and the shadow's size (shadow1-3,
// shadow2_1-3) are two sets of switches for 12 Bellends on 7 maps. The
// Bellend's page follows the frames while a move route carries it down to
// its shadow; another PC's fall elsewhere turned them off on this PC's world
// mid-way, its page went back to the sky one and that cancelled the route
// (Game_Event setupPage), so it stayed up while its landing fight still came
// at the shadow. Each PC's fall is its own; the Bellend's own switches
// (bellendN_active, _jump_animation, _surprise_attack) are the world's.
$.BELLEND_FALL_SWITCHES = [3881, 3882, 3883, 3884, 3885, 3887, 3888, 3889,
    3921, 3922, 3923, 3924, 3925, 3927, 3928, 3929];
$.SELECT_SWITCHES.concat([10, 11, 12, 13, 202, 410, 29, 4820], $.CTX_OWN_SWITCHES || [], $.BULLET_SWITCHES,
    [$.GUN_OK_SWITCH], $.OPTION_META, $.DOOR_SWITCHES, $.BELLEND_FALL_SWITCHES)
    .forEach(function(id) { $.NO_SYNC_SWITCHES[id] = true; });

$.parallelDepth = 0;  // > 0: a parallel common event is writing (each PC's own)
$.mapParallelDepth = 0; // > 0: a map's parallel page is writing (see below)
$.noSyncWrite = 0;    // > 0: Control Variables from game data (positions etc.)
$.worldDirty = null;  // { sw: {}, v: {}, ss: {}, el: {} } changes not sent yet

$.trackingWorld = function() {
    if ($.isGuest()) return $.isRoaming();
    return $.isHost() && $.clients.some(function(c) { return c.roam; });
};

$.markWorld = function(kind, key, value) {
    if (!$.trackingWorld()) return;
    if (kind === 'sw' && $.NO_SYNC_SWITCHES[key]) return;
    var d = $.worldDirty = $.worldDirty || { sw: {}, v: {}, ss: {}, el: {} };
    d[kind] = d[kind] || {};
    d[kind][key] = value === undefined ? null : value;
};

// A map's parallel pages also carry story: shooting on the map is one
// (Map015 EV035 arrow_check: "the woodsman was shot down" sets SW23). Most
// of their writes are each PC's own, though: pages that set a switch every
// frame (inside / outside, area), timers that turn one on and off, locks.
// Shared from them: a switch turned on, that no parallel page of this map
// sets plainly (at the top of the page) or turns both on and off, and that
// is not one of the switches each PC keeps for itself. Their variables
// (scratch: positions, counters) are not shared.
$.MAP_PARALLEL_OWN = {};
[202, 298, 299, 410, 1042, 1043, 1044, 1045, 4140, 1498, 1956, 2244, 2919, 241, 2270, 2271]
    .forEach(function(id) { $.MAP_PARALLEL_OWN[id] = true; });
for (var mpo = 1600; mpo <= 1611; mpo++) $.MAP_PARALLEL_OWN[mpo] = true;

$.parallelSwitchInfo = null; // { map, plain: { id }, both: { id } } from $dataMap

// The switches this map's parallel pages set every frame or flip both ways.
$.mapParallelSwitches = function() {
    var mapId = $gameMap ? $gameMap.mapId() : 0;
    if (!$dataMap || !mapId || ($.dataMapId && $.dataMapId !== mapId)) return null;
    var info = $.parallelSwitchInfo;
    if (info && info.map === mapId && info.data === $dataMap) return info;
    info = $.parallelSwitchInfo = { map: mapId, data: $dataMap, plain: {}, both: {} };
    ($dataMap.events || []).forEach(function(ev) {
        if (!ev) return;
        ev.pages.forEach(function(page) {
            if (page.trigger !== 4) return;
            var on = {}, off = {};
            (page.list || []).forEach(function(cmd) {
                if (cmd.code !== 121) return;
                var p = cmd.parameters;
                for (var id = p[0]; id <= p[1]; id++) {
                    if (cmd.indent === 0) info.plain[id] = true;
                    if (p[2] === 0) on[id] = true; else off[id] = true;
                }
            });
            Object.keys(on).forEach(function(id) { if (off[id]) info.both[id] = true; });
        });
    });
    return info;
};

$.sharedParallelSwitch = function(id, before, now) {
    if (before || !now || $.MAP_PARALLEL_OWN[id]) return false;
    var info = $.mapParallelSwitches();
    return !!info && !info.plain[id] && !info.both[id];
};

var _swSet = Game_Switches.prototype.setValue;
Game_Switches.prototype.setValue = function(id, value) {
    var before = !!this._data[id];
    if ($.isGuest() && $.isEndingMeta(id)) {
        this._data[id] = value; // not into this PC's config
        this.onChange();
    } else {
        _swSet.call(this, id, value);
    }
    if (this !== $gameSwitches || $.parallelDepth || $.noSyncWrite) return;
    if ($.mapParallelDepth && !$.sharedParallelSwitch(id, before, !!this._data[id])) return;
    $.markWorld('sw', id, !!this._data[id]);
};

var _varSet = Game_Variables.prototype.setValue;
Game_Variables.prototype.setValue = function(id, value) {
    _varSet.call(this, id, value);
    if (this === $gameVariables && !$.parallelDepth && !$.mapParallelDepth && !$.noSyncWrite) {
        $.markWorld('v', id, this._data[id]);
    }
};

// Self switches belong to map events, so parallel pages count too.
var _ssSet = Game_SelfSwitches.prototype.setValue;
Game_SelfSwitches.prototype.setValue = function(key, value) {
    _ssSet.call(this, key, value);
    if (this === $gameSelfSwitches) {
        $.markWorld('ss', Array.isArray(key) ? key.join(',') : String(key), !!value);
    }
};

var _Game_CommonEvent_update = Game_CommonEvent.prototype.update;
Game_CommonEvent.prototype.update = function() {
    $.parallelDepth++;
    try {
        _Game_CommonEvent_update.call(this);
    } finally {
        $.parallelDepth--;
    }
};

var _updateParallel = Game_Event.prototype.updateParallel;
Game_Event.prototype.updateParallel = function() {
    $.mapParallelDepth++;
    try {
        _updateParallel.call(this);
    } finally {
        $.mapParallelDepth--;
    }
};

// "Control Variables = player X / map ID / ..." fills scratch variables an
// event reads right away; another PC's copy would break the host's event.
var _command122 = Game_Interpreter.prototype.command122;
Game_Interpreter.prototype.command122 = function() {
    var scratch = this._params[3] === 3;
    if (scratch) $.noSyncWrite++;
    try {
        return _command122.call(this);
    } finally {
        if (scratch) $.noSyncWrite--;
    }
};

// Apply changes from the other side. Keys changed here and not sent yet win;
// they go out with the next flush.
$.applyWorldDelta = function(d, pending, persist) {
    pending = pending || { sw: {}, v: {}, ss: {} };
    var applied = { sw: [], v: [], ss: [], el: [] };
    Object.keys(d.sw || {}).forEach(function(k) {
        var id = Number(k);
        if (k in pending.sw || $.NO_SYNC_SWITCHES[id]) return;
        var on = !!d.sw[k];
        if (persist && $.isEndingMeta(id)) {
            _swSet.call($gameSwitches, id, on); // into the host's config
        } else {
            $gameSwitches._data[id] = on;
        }
        applied.sw.push(id);
    });
    Object.keys(d.v || {}).forEach(function(k) {
        if (k in pending.v) return;
        $gameVariables._data[Number(k)] = d.v[k] === null ? 0 : d.v[k];
        applied.v.push(Number(k));
    });
    Object.keys(d.ss || {}).forEach(function(k) {
        if (k in pending.ss) return;
        if (d.ss[k]) $gameSelfSwitches._data[k] = true; else delete $gameSelfSwitches._data[k];
        applied.ss.push(k);
    });
    // saved event locations of other maps (not the one this PC runs: its
    // events are the newer ones; "Saved event locations" at the end of file)
    Object.keys(d.el || {}).forEach(function(k) {
        if (pending.el && k in pending.el) return;
        if ($.takeSavedLocation && $.takeSavedLocation(k, d.el[k])) applied.el.push(k);
    });
    if ($gameMap) $gameMap.requestRefresh();
    return applied;
};

// Host: send what changed to every roaming guest (its own changes come back
// too, so both sides end up with the same value whatever the order).
$.flushWorldHost = function() {
    var d = $.worldDirty;
    if (!d) return;
    $.worldDirty = null;
    var msg = { t: 'wDelta', sw: d.sw, v: d.v, ss: d.ss, el: d.el || {}, m: $gameMap ? $gameMap.mapId() : 0 };
    $.clients.forEach(function(c) { if (c.roam) c.send(msg); });
};

$.hostHandlers.wDelta = function(conn, msg) {
    if (!conn.roam) return;
    // each player's own (sleep, wake spot, Hexen board...): never from a guest
    if (msg && msg.sw) {
        var sw = {};
        Object.keys(msg.sw).forEach(function(id) { if (!$.NO_SYNC_SWITCHES[id]) sw[id] = msg.sw[id]; });
        msg = Object.assign({}, msg, { sw: sw });
    }
    // the values before it: only a write that changed something can turn a
    // page on (CE104 after every room door writes switches that are off
    // already)
    var before = { sw: {}, v: {}, ss: {} };
    Object.keys(msg.sw || {}).forEach(function(k) { before.sw[k] = !!$gameSwitches._data[Number(k)]; });
    Object.keys(msg.v || {}).forEach(function(k) { before.v[k] = $gameVariables._data[Number(k)] || 0; });
    Object.keys(msg.ss || {}).forEach(function(k) { before.ss[k] = !!$gameSelfSwitches._data[k]; });
    var applied = $.applyWorldDelta(msg, $.worldDirty, true);
    var notHere = $.trapFromGuest ? $.trapFromGuest(conn, msg.sw) : []; // its trap: its tile (FH_CoopWorld)
    if (notHere.length) applied.sw = applied.sw.filter(function(id) { return notHere.indexOf(id) < 0; });
    applied.sw.forEach(function(id) { $.markWorld('sw', id, !!$gameSwitches._data[id]); });
    applied.v.forEach(function(id) { $.markWorld('v', id, $gameVariables._data[id]); });
    applied.ss.forEach(function(k) { $.markWorld('ss', k, !!$gameSelfSwitches._data[k]); });
    applied.el.forEach(function(k) { $.markWorld('el', k, msg.el[k]); });
    // that guest caused them: an autorun page they turn on here is its own
    // (FH_CoopWorld: the well's landing scene on the host's map)
    $.markCausesFor(conn.guestId, {
        sw: applied.sw.filter(function(id) { return before.sw[id] !== !!$gameSwitches._data[id]; }),
        v: applied.v.filter(function(id) { return before.v[id] !== ($gameVariables._data[id] || 0); }),
        ss: applied.ss.filter(function(k) { return before.ss[k] !== !!$gameSelfSwitches._data[k]; })
    }, Number(msg.m) || 0);
};

// mapId: the map its PC ran when it wrote them (sent with the delta; an
// older guest does not: its last reported spot then).
$.markCausesFor = function(id, applied, mapId) {
    if (!$.causes) return;
    // its PC was running the map the host is on: it ran that map's pages itself
    var c = $.clientById(id);
    var m = mapId || (c && c.lastPos ? c.lastPos.m : 0) || 0;
    var own = !!m && m === $gameMap.mapId();
    // (m: the host may come to that map later - Pocketcat's scene, Map036
    // EV239, played again for the host who came in while or after a guest
    // watched it on its PC, 0.5.11; $.causeOwnHere)
    var mark = function(key) { $.causes[key] = { id: id, at: $.clockMs(), n: ++$.causeSeq, own: own, m: m }; };
    applied.sw.forEach(function(k) { mark('sw:' + k); });
    applied.v.forEach(function(k) { mark('v:' + k); });
    applied.ss.forEach(function(k) { mark('ss:' + k); });
};

$.flushWorldGuest = function() {
    var d = $.worldDirty;
    if (!d || !$.conn) return;
    $.worldDirty = null;
    $.conn.send({ t: 'wDelta', sw: d.sw, v: d.v, ss: d.ss, el: d.el || {}, m: $gameMap ? $gameMap.mapId() : 0 });
};

$.roamDeltas = [];
$.guestHandlers.wDelta = function(msg) {
    if ($.pendingRoam) {
        $.roamDeltas.push(msg); // newer than the snapshot it waits with
        return;
    }
    if (!$.isRoaming()) return;
    var before = $.deltaBefore(msg);
    var applied = $.applyWorldDelta(msg, $.worldDirty, false);
    // The host's world wrote them while it was on this same map: it played
    // their pages there. A page here that moves the player is not this
    // player's (0.41 play test: the host took the Tunnel 7 elevator, Map024
    // EV27, and the guest on that map rode it too and landed by the host).
    if (msg.m && $gameMap && msg.m === $gameMap.mapId()) $.markCausesFor('remote', $.deltaChanged(applied, before), msg.m);
};

// The values a delta's keys had before it (only a real change turns a page on).
$.deltaBefore = function(msg) {
    var before = { sw: {}, v: {}, ss: {} };
    Object.keys(msg.sw || {}).forEach(function(k) { before.sw[k] = !!$gameSwitches._data[Number(k)]; });
    Object.keys(msg.v || {}).forEach(function(k) { before.v[k] = $gameVariables._data[Number(k)] || 0; });
    Object.keys(msg.ss || {}).forEach(function(k) { before.ss[k] = !!$gameSelfSwitches._data[k]; });
    return before;
};

$.deltaChanged = function(applied, before) {
    return {
        sw: applied.sw.filter(function(id) { return before.sw[id] !== !!$gameSwitches._data[id]; }),
        v: applied.v.filter(function(id) { return before.v[id] !== ($gameVariables._data[id] || 0); }),
        ss: applied.ss.filter(function(k) { return before.ss[k] !== !!$gameSelfSwitches._data[k]; })
    };
};

// A roaming guest: an autorun page that moves the player, turned on by the
// host's world on this same map, is the host's - not run here.
var _eventStartRemote = Game_Event.prototype.start;
Game_Event.prototype.start = function() {
    if ($.isGuest() && $.isRoaming && $.isRoaming() && this._trigger === 3 && $.pageTransfers &&
            $.pageTransfers(this.page()) && $gameMap.event(this.eventId()) === this) {
        var last = $.pageLastCause ? $.pageLastCause(this) : null;
        if (last && last.id === 'remote' && last.own) {
            if (this._fhRemoteLogged !== this._pageIndex) {
                this._fhRemoteLogged = this._pageIndex;
                $.dlog('autorun ev' + this.eventId(), 'p' + this._pageIndex, 'moves the player and the host set it - not run here');
            }
            return;
        }
    }
    _eventStartRemote.call(this);
};

// A guest's battle on its PC (as a thin guest) changed these on the host.
var _battleEnd = $.hostHandlers.battleEnd;
$.hostHandlers.battleEnd = function(conn, msg) {
    var known = $.reportsFor($.battles[msg.bid], conn.guestId); // (a duel: both players)
    _battleEnd(conn, msg);
    if (!known) return; // dropped (a load) or not that guest's
    (msg.swd || []).forEach(function(d) {
        if ($.isEndingMeta(d[0]) && d[1]) _swSet.call($gameSwitches, d[0], true);
        $.markWorld('sw', d[0], !!$gameSwitches._data[d[0]]);
    });
    (msg.vd || []).forEach(function(d) { $.markWorld('v', d[0], $gameVariables._data[d[0]]); });
    (msg.ssd || []).forEach(function(d) { $.markWorld('ss', d[0], !!$gameSelfSwitches._data[d[0]]); });
};

//=============================================================================
// Host: who runs which map
//=============================================================================

// Roaming guests are not part of the host's map, even when standing on it.
var _guestOnMap = $.guestOnMap;
$.guestOnMap = function(conn) {
    if (conn.roam || conn.roamPending) return false;
    return _guestOnMap(conn);
};

// A story scene is shared through the host's own interpreter, but a scene
// with a transfer in it (a door with a picture) would move the host: that
// one runs for the player who started it. Common events it calls count too.
$.listHasTransfer = function(list, seen) {
    return (list || []).some(function(cmd) {
        if (cmd.code === 201) return true;
        if (cmd.code !== 117) return false;
        var id = cmd.parameters[0];
        if (seen[id]) return false;
        seen[id] = true;
        var ce = $dataCommonEvents[id];
        return !!ce && $.listHasTransfer(ce.list, seen);
    });
};

var _isCutscenePage = $.isCutscenePage;
$.isCutscenePage = function(page) {
    if (page._fhTransfer === undefined) page._fhTransfer = $.listHasTransfer(page.list, {});
    if (page._fhTransfer) return false;
    return _isCutscenePage(page);
};

// Shared dialogue is for the players on the host's map (a talk: the ones
// near it, FH_Coop $.hearsDialogue).
$.dialogueVoters = function() {
    if (!$.isHost() || !(SceneManager._scene instanceof Scene_Map)) return [];
    if (!$.tutorialOver()) return [];
    return $.clients.filter(function(c) {
        return c.inGame && c.actorId && !c.solo && $.guestOnMap(c) && $.hearsDialogue(c);
    });
};

// The train ending takes the players who are there.
$.livingPlayerSelects = function() {
    var ids = [];
    if (!$.isDead('host')) ids.push($.SELECT_OF_ACTOR[$.hostActorId()]);
    $.activeGuests().forEach(function(c) {
        var here = c.lastPos && c.lastPos.m === $gameMap.mapId();
        if (here && !$.isDead(c.guestId) && !c._fhNoSelect) ids.push($.SELECT_OF_ACTOR[c.actorId]);
    });
    return ids.filter(Boolean);
};

// Snapshots go to the guests on the host's map; one sent to a guest by name
// brings it back to the host's game.
var _sendSnapshot = $.sendSnapshot;
$.sendSnapshot = function(conn) {
    if (conn) {
        conn.roam = false;
        conn.roamPending = null;
        conn._ghostStay = false;
        return _sendSnapshot(conn);
    }
    var all = $.clients.filter(function(c) { return !c.solo; });
    var some = all.filter(function(c) { return !c.roam && !c.roamPending && !c._ghostStay; });
    if (some.length === all.length) return _sendSnapshot();
    if (some.length) _sendSnapshot(some); // one save build for all of them
};

$.hostHandlers.needSnap = function(conn) {
    if (conn.roam || conn.roamPending) return; // it is not on the host's map
    $.sendSnapshot(conn);
};

// The guest's PC takes over its map: the world as it is now, its spot, and
// optionally the event it was in the middle of.
$.sendRoam = function(conn, opts) {
    opts = opts || {};
    var pos = opts.pos || conn.lastPos || {};
    var mapId = pos.m || $gameMap.mapId();
    var msg = {
        t: 'roam', data: opts.data || $.snapshotData(),
        here: mapId === $gameMap.mapId(),
        pos: { m: mapId, x: pos.x || 0, y: pos.y || 0, d: pos.d || 2 },
        interp: opts.interp || null,
        hx: $.boardOf ? $.withHostSigils($.boardOf(conn)) : null, // its own Hexen board (end of file)
        own: $.takeOwnSwitches ? $.takeOwnSwitches(conn) : null, // its sleep (end of file)
        scr: opts.scr || null, // left behind: the map's screen, not the host's departing one (end of file)
        pc: $.ctxOwnOf ? $.ctxOwnOf(conn) : null, // its own SW202 / SW410 (FH_CoopWorld), not the host's
        // a guest that was not running its own map (on the host's map, or
        // after a load) takes its character and bag from the host's copy
        me: conn.roam ? null : $.snapMe(conn),
        // the menu as a free player has it: the world sent is the host's, its
        // menu off while the host dreams or sits in a scene (review 6 #2: a
        // re-join during the dream played on with no menu)
        menuOn: !!opts.menuOn || (!!$.DREAM_MAPS[$gameMap.mapId()] && !$.DREAM_MAPS[mapId])
    };
    conn.roam = true;
    conn.roamPending = null;
    conn._lastRoamMeKey = null;
    delete $.remotes[conn.guestId];
    $.dlog('roam', conn.name, 'map', mapId, msg.here ? '(here)' : '(load)', opts.interp ? '+event' : '');
    conn.send(msg);
};

// Transfer in a guest's event: only that guest moves.
var _command201 = Game_Interpreter.prototype.command201;
Game_Interpreter.prototype.command201 = function() {
    if ($.runsWorld() && this._fhOwner && !$gameParty.inBattle()) return this.fhGuestTransfer();
    // (not into a dream: each player has its own, see "Sleeping together")
    if ($.isRoaming() && !$gameParty.inBattle() && $.hostMapId && !$.DREAM_MAPS[$.hostMapId] &&
            $.transferTarget(this) === $.hostMapId) {
        return this.fhBackToHost();
    }
    return _command201.call(this);
};

$.transferSpot = function(interp) {
    var p = interp._params;
    if (p[0] === 0) return { m: p[1], x: p[2], y: p[3], d: p[4] || 0 };
    return { m: $gameVariables.value(p[1]), x: $gameVariables.value(p[2]),
        y: $gameVariables.value(p[3]), d: p[4] || 0 };
};

Game_Interpreter.prototype.fhGuestTransfer = function() {
    if ($gameMessage.isBusy()) return false;
    var conn = $.clientById(this._fhOwner);
    var spot = $.transferSpot(this);
    if (!conn) {
        this._index++;
        return false;
    }
    // a dream is each player's own: never the host's ("Sleeping together")
    var dream = !!$.DREAM_MAPS[spot.m];
    if (spot.m === $gameMap.mapId() && !dream) {
        // within the host's map (or back to it from a map the host left)
        if (conn.roamPending) {
            // the snapshot is made out of this guest's context (next hostSync):
            // here the world has its SELECT, party, board (final review C7)
            conn._snapPlace = { m: spot.m, x: spot.x, y: spot.y, d: spot.d || 2 };
        } else {
            conn.send({ t: 'place', x: spot.x, y: spot.y, d: spot.d });
        }
        var remote = $.remotes[conn.guestId];
        if (remote) {
            remote.setPosition(spot.x, spot.y);
            if (spot.d) remote._direction = spot.d;
        }
        conn.lastPos = Object.assign({}, conn.lastPos || {}, { m: spot.m, x: spot.x, y: spot.y });
        if (spot.d) conn.lastPos.d = spot.d;
        this._fhFollowAt = 0;
        this._index++;
        return false;
    }
    // The host is on its way to that map too (same door, together): wait for
    // it instead of handing the guest that map and taking it back right after
    // (two whole-world transfers).
    var host = $.realPlayer || $gamePlayer;
    if (host.isTransferring() && host._newMapId === spot.m && !dream) return false;
    // The host a few steps away may take the same door a moment later (host
    // logs 2026-11-01: 19 hand-offs taken back 1-4 s later): wait a little.
    if (!dream && $.hostMayFollow(this, conn)) return false;
    this._fhFollowAt = 0;
    // another map: the guest's PC runs the rest of the event from here
    this._fhHandOff = true;
    this.setWaitMode('fhHanded');
    $.handOffs[this._fhOwner] = true;
    return false;
};

// Only while the host stands within HOST_FOLLOW_TILES of the guest on this
// map, for HOST_FOLLOW_MS from the transfer (user decision 2026-11-02); a
// host far away does not hold the guest's door.
$.HOST_FOLLOW_MS = 1000;
$.HOST_FOLLOW_TILES = 5;
$.hostMayFollow = function(interp, conn) {
    var host = $.realPlayer || $gamePlayer;
    var at = conn.lastPos;
    if (!host || !at || (at.m && at.m !== $gameMap.mapId())) return false;
    if (Math.abs(host.x - at.x) + Math.abs(host.y - at.y) > $.HOST_FOLLOW_TILES) return false;
    var now = $.clockMs();
    // (a mark from another run of the clock would hold it for ever)
    if (!interp._fhFollowAt || interp._fhFollowAt > now) interp._fhFollowAt = now;
    return now - interp._fhFollowAt < $.HOST_FOLLOW_MS;
};

var _updateWaitMode = Game_Interpreter.prototype.updateWaitMode;
Game_Interpreter.prototype.updateWaitMode = function() {
    if (this._waitMode === 'fhHanded') return true;
    return _updateWaitMode.call(this);
};

// A handed page that takes its player off the map: the others here press
// the event to go too, as after a roaming guest's (FH_CoopWorld
// Game_Event.start). Kaiser's room door (Map136 EV243: OK, then autorun
// pages on self switches A, B, C; C moves to Map140 and stays on): after a
// guest on the host's map went through, the host pressing it stayed in the
// room (0.5.11).
$.awaitOthersTransfer = function(ev) {
    var target = $.pageTransferMap(ev.page());
    if (!$.pageTransfers(ev.page()) || !target || target === $gameMap.mapId() ||
            ($.DREAM_MAPS && $.DREAM_MAPS[target])) return;
    ev._fhAwaitHostTransfer = true;
    ev._trigger = 0;
    ev._starting = false;
};

// A handed page comes back when a player here presses what turns it on
// again (Map139 EV32, the hall of the gods: a wall turns SW2860 on, the
// autorun takes the player on to Kaiser; the switch stays on after a guest
// went, and the host touching a wall next stayed in the hall, 0.5.11).
var _markCauseHanded = $.markCause;
$.markCause = function(key) {
    _markCauseHanded(key);
    if ($.causeSkip || !$.role || !$.runsWorld() || !$gameMap || !$.pressRunning()) return;
    $gameMap._events.forEach(function(ev) { // (not events(): a new array at every switch write)
        if (!ev || ev._fhHandedPage === undefined || ev._fhHandedPage !== ev._pageIndex) return;
        if ($.pageCauseKeys(ev).indexOf(key) < 0) return;
        delete ev._fhHandedPage;
        // (an autorun again, for the one who pressed)
        if (ev._fhAwaitHostTransfer) {
            ev._fhAwaitHostTransfer = false;
            ev._trigger = ev.page().trigger;
        }
    });
};

var _updateOwned = $.updateOwned;
$.updateOwned = function() {
    _updateOwned();
    Object.keys($.handOffs).forEach(function(id) {
        delete $.handOffs[id];
        var entry = $.owned[id];
        var conn = $.clientById(id);
        if (!entry || !conn) return;
        var json = JsonEx.stringify(entry.interp);
        // an autorun page that goes on there must not start here again
        if (entry.ev && entry.ev._trigger === 3) {
            entry.ev._fhHandedPage = entry.ev._pageIndex;
            $.awaitOthersTransfer(entry.ev);
        }
        // its door's steps stay on here (its CE104 runs on its PC): another
        // door's autorun on them would start (unless the host is in a door itself)
        if (!$gameMap._interpreter.isRunning()) {
            $.clearDoorSteps();
            $gameMap.requestRefresh();
        }
        $.finishOwned(id);
        $.sendRoam(conn, { interp: json, pos: conn.roamPending ? conn.lastPos : null });
    });
};

// The host leaves a map: the guests standing there keep playing it.
var _performTransfer = Game_Player.prototype.performTransfer;
Game_Player.prototype.performTransfer = function() {
    if ($.runsWorld() && this.isTransferring() && this._newMapId !== $gameMap.mapId()) {
        $.leaveGuestsBehind(this._newMapId);
    }
    _performTransfer.call(this);
};

$.leaveGuestsBehind = function(newMapId) {
    var here = $gameMap.mapId();
    if (!$.tutorialOver()) return;
    if (here === $.TRAIN_MAP && newMapId === $.EXIT_MAP) return; // everyone leaves the train together
    var data = null; // the same world for everyone left behind: build it once
    $.clients.forEach(function(c) {
        if (!c.inGame || !c.actorId || c.solo || c.roam || c.roamPending || c.subOf) return;
        if ($.isDead(c.guestId)) {
            $.ghostLeftBehind(c, here, newMapId);
            return;
        }
        if (!c.lastPos || (c.lastPos.m && c.lastPos.m !== here)) return;
        if ($.roamHeld(c)) {
            c.roamPending = { m: here }; // after its event, battle or menu
            return;
        }
        data = data || $.snapshotData();
        $.sendRoam(c, { data: data });
    });
};

// A ghost stays where it is (user 2026-11-07: "the dead guest's ghost keeps
// following me, and it lags"). A dead guest on the host's map used to follow
// the host through every door (0.3.x spectating): a whole world sent to it at
// each one, every fight of the host watched by it. Now the map it is on stays
// on its PC as a still copy ($.spec, as when it walks through a door itself)
// and the snapshots of the host's new maps leave it out (_ghostStay); a door
// it takes to the host's map asks for the world again (needSnap), and the
// host coming onto its map takes it back in where it stands.
// Into an ending (the host won: the tower, ending A) it still follows the host
// and watches it, as before (2026-11-06: "the ghosts watch the winner's ending").
$.ghostLeftBehind = function(c, here, newMapId) {
    if ($.ENDING_MAPS && $.ENDING_MAPS[newMapId]) {
        c._ghostStay = false;
        if (c.lastPos) delete c.lastPos.m; // it follows the host
        return;
    }
    var at = c.lastPos && c.lastPos.m ? c.lastPos.m : here;
    if (at === newMapId) { // the host comes onto its map: back in the world
        c._ghostStay = false;
        return;
    }
    if (at === here) {
        c.lastPos = Object.assign({}, c.lastPos || {}, { m: here });
        if (!c._ghostStay) c.send({ t: 'ghostStay', m: here });
    }
    c._ghostStay = true;
    delete $.remotes[c.guestId];
    $.dlog('ghost', c.name, 'stays on map', at, '- the host goes to', newMapId);
};

$.guestHandlers.ghostStay = function(msg) {
    if (!$.isGhostMe() || $.spec || !$gameMap || $gameMap.mapId() !== msg.m) return;
    var hide = $.playerInfo($.myId);
    hide.tr = 1;
    if ($.conn) $.conn.send({ t: 'pos', p: hide });
    $.spec = { m: msg.m };
    $.dlog('ghost: the host left, this map stays as a still copy', msg.m);
};

// Taken back in on the map it stood on: it stays where it stands.
var _processPendingSnapshotGhostStay = $.processPendingSnapshot;
$.processPendingSnapshot = function() {
    var snap = $.pendingSnapshot, p = typeof $gamePlayer !== 'undefined' ? $gamePlayer : null;
    var keep = snap && $.spec && p && !$.ghostArrive && snap.mapId === $.spec.m ?
        { m: snap.mapId, x: p.x, y: p.y, d: p.direction() } : null;
    _processPendingSnapshotGhostStay();
    if (keep && $gameMap && $gameMap.mapId() === keep.m && $gamePlayer) {
        $gamePlayer.locate(keep.x, keep.y);
        $gamePlayer.setDirection(keep.d);
    }
};

// Not left to its own map yet: busy, or its menu is open. The host's copy
// of its character and bag (what 'roam' takes along) is from before the
// menu until the menu closes (syncMe): a roam started meanwhile put back the
// equipment it changed and the items it used, and their common events ran
// once more (0.4 review C bug 1). The common events its menu queued run
// here first (once), so the copy that goes along has them.
$.roamHeld = function(c) {
    var queued = $.ownedQueue && $.ownedQueue[c.guestId];
    return $.isBusy(c) || !!c._menuBase || !!(queued && queued.length);
};

// Every sync: send world changes, settle guests left behind while busy.
var _hostSync = $.hostSync;
$.hostSync = function() {
    _hostSync();
    $.flushWorldHost();
    var data = null; // several let go at once: one world build (final review C)
    $.clients.forEach(function(c) {
        if (!c.roamPending) return;
        // the map it was left on (a guest on the host's map has no m in lastPos)
        var left = c.roamPending.m || (c.lastPos && c.lastPos.m);
        if (left === $gameMap.mapId()) {
            if (!c._menuBase) $.sendSnapshot(c); // the host came back first
        } else if (!$.roamHeld(c)) {
            data = data || $.snapshotData();
            $.sendRoam(c, { pos: Object.assign({}, c.lastPos || {}, { m: left }), data: data });
        }
    });
};

// Its event brought a guest left behind back to this PC's map (fhGuestTransfer):
// this PC's own world, out of every guest context, before the loop above
// (the host's hostSync, a sub-host's subHostSync).
$.flushSnapPlaces = function() {
    if ($.ctx) return;
    $.clients.forEach(function(c) {
        if (!c._snapPlace) return;
        var at = c._snapPlace;
        c._snapPlace = null;
        if (!c.roamPending) return; // taken some other way meanwhile
        c._placeAt = at;
        $.sendSnapshot(c);
    });
};

var _hostSyncSnapPlace = $.hostSync;
$.hostSync = function() {
    $.flushSnapPlaces();
    _hostSyncSnapPlace();
};

// Guest walked (or was carried) onto the host's map.
$.hostHandlers.unroam = function(conn, msg) {
    if (!conn.roam) return;
    $.storeBelongings(conn, msg);
    var spot = { m: msg.m, x: msg.x, y: msg.y, d: msg.d || 2 };
    if (msg.m !== $gameMap.mapId()) {
        // the host left meanwhile: stay on the guest's PC
        $.sendRoam(conn, { pos: spot, interp: msg.interp });
        return;
    }
    conn.lastPos = Object.assign({}, conn.lastPos || {}, spot, { id: conn.guestId });
    conn._placeAt = spot;
    $.dlog('unroam', conn.name, 'map', msg.m, msg.interp ? '+event' : '');
    $.sendSnapshot(conn);
    if (msg.interp) {
        var interp = JsonEx.parse(msg.interp);
        $.cleanInterp(interp);
        for (var i = interp; i; i = i._childInterpreter) i._fhOwner = conn.guestId;
        $.owned[conn.guestId] = { interp: interp, ev: null };
        conn.send({ t: 'evRun', on: true });
    }
};

$.storeBelongings = function(conn, msg) {
    var actor = msg.actor ? $.parseActor(msg.actor) : null;
    if (actor && actor._actorId === conn.actorId) $gameActors._data[conn.actorId] = actor;
    if (msg.inv) {
        var inv = $.inventoryOf(conn);
        inv.i = msg.inv.i || {};
        inv.w = msg.inv.w || {};
        inv.a = msg.inv.a || {};
        inv.g = Number(msg.inv.g) || 0;
    }
};

$.hostHandlers.roamMe = function(conn, msg) {
    if (conn.roam && conn.actorId) $.storeBelongings(conn, msg);
};

$.hostHandlers.roamDown = function(conn, msg) {
    if (!conn.roam) return;
    // a death for good (beheaded, starved, ...): its PC says so
    if (msg && msg.doom && $.markDoom) $.markDoom($.actorOfPlayer(conn.guestId), String(msg.doom));
    $.onPlayerDefeated(conn.guestId);
};

// The host's copy of a roaming guest is not the newest: no 'me' for it.
// A guest coming back gets its spot; a saved spot on another map (after a
// load) means that guest runs that map.
// A spot record goes to the others' avatars (hostSync): a re-join's new
// record had no character - their PCs threw on it until its first 'pos'
// (flow tests L-2a). It starts with its character's look.
$.spotLook = function(conn) {
    var old = conn.lastPos, a = $gameActors.actor(conn.actorId);
    if (old && typeof old.n === 'string') return { n: old.n, i: Number(old.i) || 0 };
    return { n: a ? a.characterName() : '', i: a ? a.characterIndex() : 0 };
};

var _pushMe = $.pushMe;
$.pushMe = function(conn) {
    if (!conn || conn.roam || !conn.actorId) return;
    if (conn._placeAt) {
        var data = $.meData(conn);
        data.pos = conn._placeAt;
        conn.lastPos = Object.assign($.spotLook(conn), conn.lastPos || {}, conn._placeAt, { id: conn.guestId });
        conn._placeAt = null;
        conn._needPos = false;
        conn._lastMeKey = JSON.stringify([data.actor, data.inv, data.pos, data.syn]);
        conn.send(data);
        return;
    }
    if (conn._needPos && !conn.solo && $.tutorialOver()) {
        var saved = ($.coopData().pos || {})[conn.name];
        if (saved && saved.m && saved.m !== $gameMap.mapId()) {
            conn._needPos = false;
            conn.lastPos = Object.assign($.spotLook(conn), conn.lastPos || {}, saved, { id: conn.guestId });
            $.sendRoam(conn, { pos: saved, menuOn: true }); // (a re-join / a load: no scene of its own)
            return;
        }
        if (saved && saved.m === $gameMap.mapId() && !$gameMap.isValid(saved.x, saved.y)) {
            conn._needPos = false; // not a spot on this map: where the snapshot has it
            return _pushMe(conn);
        }
        if (saved && saved.m === $gameMap.mapId()) {
            conn._needPos = false;
            conn._placeAt = { m: saved.m, x: saved.x, y: saved.y, d: saved.d || 2 };
            $.pushMe(conn); // the spot on the host's map
            return;
        }
    }
    _pushMe(conn);
};

var _sendAssign = $.sendAssign;
$.sendAssign = function(conn, actorId) {
    _sendAssign(conn, actorId);
    if (!conn.solo && conn.inGame) $.pushMe(conn);
};

// No trading with a guest whose bag lives on its own PC.
var _containerOf = $.containerOf;
$.containerOf = function(id, kind) {
    var conn = id === 'host' ? null : $.clientById(id);
    if (conn && conn.roam) return null;
    return _containerOf(id, kind);
};

// A loaded save or the title screen: everyone is in the host's game again.
$.resetRoams = function() {
    $.clients.forEach(function(c) {
        c.roam = false;
        c.roamPending = null;
    });
    $.handOffs = {};
    $.worldDirty = null;
    $.causes = {}; // (a load, the title: the old world's writes)
};

var _onLoadSuccess = Scene_Load.prototype.onLoadSuccess;
Scene_Load.prototype.onLoadSuccess = function() {
    if ($.isHost()) {
        $.dropOldWorld();
        // a save made while a guest's event ran has that event locked (and
        // a fight's enemy held): nobody runs them here now
        if ($gameMap) $.resetRoamEvents($gameMap.events());
        $.resetRoams();
        $.restoreSavedSpots();
        $.snapshotQueued = true;
    }
    _onLoadSuccess.call(this);
};

// Fights, guest events and down timers of the world before the load: gone.
// A guest fighting one ends it (its result is not taken any more).
$.dropOldWorld = function() {
    Object.keys($.battles).forEach(function(k) {
        var b = $.battles[k];
        b.joiners.forEach(function(id) { $.bSend(id, { t: 'bEnd', bid: b.bid, r: 1 }); });
        if (b.owner !== 'host') $.sendTo(b.owner, { t: 'bDrop', bid: b.bid });
        // both duelists (each runs a battle; one may still wait to open it)
        if (b.pvp) $.duelIds(b).forEach(function(id) { if (id) $.sendTo(id, { t: 'pvpEnd', bid: b.bid }); });
    });
    $.battles = {};
    $.hostInJoin = 0;
    $.clients.forEach(function(c) { c.inBattle = 0; });
    Object.keys($.owned).forEach(function(id) { $.finishOwned(id); });
    $.ownedQueue = {};
    $.downs = {}; // the snapshot that follows sends everyone's state again
};

$.guestHandlers.bDrop = function(msg) {
    var ab = $.authBattle;
    if (!ab || ab.bid !== msg.bid) return;
    $.dlog('battle dropped: the host loaded a save', msg.bid);
    $.toast('Co-op: the host loaded a save');
    if ($gameParty.inBattle()) {
        BattleManager.abort();
        return;
    }
    // the battle screen is still opening: it does not open
    $.authBattle = null;
    $.localBattle = null;
    var rf = $.roamFight;
    if (rf) {
        $.roamFight = null;
        var b = $.battles[msg.bid];
        if (b) {
            delete $.battles[msg.bid];
            $.unfreezeBattle(b);
        }
    }
    if (SceneManager.isNextScene(Scene_Battle)) {
        BattleManager.replayBgmAndBgs();
        SceneManager.pop();
    }
};

// After a load every guest goes back where the save had it (the same map:
// that spot; another map: its PC runs that map), not to the host's spot.
// Taken with the snapshot that follows (pushMe).
$.restoreSavedSpots = function() {
    $.clients.forEach(function(c) {
        if (!c.actorId || c.solo) return;
        c._needPos = true;
        if (c.lastPos) delete c.lastPos.m;
    });
};

// The session's game is over (everyone down: a game over; the host back at
// the title): its world stops at once. Its fights (their PCs are told),
// guest events, downs and fixed fights go, and the guests wait in the lobby
// right away, not when the host reaches the title (0.41 play test: after an
// all-down game over the guest stayed in the old fight and the down, "You
// are down: 0 s", and the old world started a fight on its title screen).
$.endSessionGame = function(why) {
    if (!$.isHost() || !$.hostInGame) return;
    $.dlog('session game ends:', why, '- guests to the lobby');
    $.hostInGame = false;
    $.dropOldWorld();
    $.resetRoams();
    $.remotes = {};
    $.resetPicks();
    if ($.dropConsent) $.dropConsent(why);
    $.clients.forEach(function(c) { c.send({ t: 'lobby' }); });
};

var _Scene_Title_start = Scene_Title.prototype.start;
Scene_Title.prototype.start = function() {
    if ($.isHost()) $.resetRoams();
    if ($.isGuest()) {
        $.roam = null;
        $.pendingRoam = null;
    }
    $.ownCeQueue = [];
    _Scene_Title_start.call(this);
};

//=============================================================================
// Guest: running its own map
//=============================================================================

$.guestHandlers.roam = function(msg) {
    // came while this player's menu is open: the host had not seen it open
    if ($.menuOpenBase && $.returningFromSubScene && !(SceneManager._scene instanceof Scene_Map)) {
        msg._menuBase = $.menuOpenBase;
    }
    $.pendingSnapshot = null;
    $.pendingRoam = msg;
    $.roamDeltas = [];
    $.waitingSnap = false;
};

$.guestHandlers.snap = function(msg) {
    $.pendingRoam = null;
    $.pendingSnapshot = msg;
    // the host's copy of this player at the snapshot: what the snapshot puts
    // back (a 'me' that comes later still wins)
    if (msg && msg.me && msg.me.actorId === $.myActorId) {
        $.lastMe = { t: 'me', actorId: msg.me.actorId, actor: msg.me.actor, inv: msg.me.inv, pos: null, mn: msg.me.mn };
    }
};

// The host's copy of a guest's character and bag, sent with snapshots and
// roam starts (host only; a sub-host's guests get their 'me' as before).
$.snapMe = function(conn) {
    if (!$.isHost() || !conn || !conn.actorId || conn.solo || conn.subOf) return null;
    var d = $.meData(conn);
    // (its companion too: without it a load kept a companion the save never
    // had, and a roam start dropped its own - 0.41 review 3 H3)
    return { actorId: d.actorId, actor: d.actor, inv: d.inv, mn: d.mn };
};

// A forwarded transfer within the host's map.
$.guestHandlers.place = function(msg) {
    if (!$.isThin() || !$gamePlayer) return;
    $gamePlayer.locate(msg.x, msg.y);
    if (msg.d) $gamePlayer.setDirection(msg.d);
    $.guestSync();
};

// An interpreter that ran on the other PC: drop the co-op wait states.
$.cleanInterp = function(interp) {
    for (var i = interp; i; i = i._childInterpreter) {
        delete i._fhOwner;
        delete i._fhShift;
        delete i._fhHandOff;
        i._fhWaitId = 0;
        i._fhPending = null;
        i._fhBattleWait = 0;
        if (/^fh/.test(i._waitMode || '')) i._waitMode = '';
    }
    return interp;
};

// The host's run of them is not this PC's.
$.resetRoamEvents = function(events) {
    events.forEach(function(ev) {
        if (!ev) return;
        ev._fhOwner = null;
        ev._fhBattle = 0;
        ev._starting = false;
        delete ev._fhHandedPage;
        if (ev._locked) ev.unlock();
    });
};

$.canStartRoam = function() {
    return !!$.myActorId && SceneManager._scene instanceof Scene_Map && !SceneManager.isSceneChanging() &&
        !$.pendingSnapshot && !$.localBattle && !$.puppet;
};

$.startRoam = function(msg) {
    var mine = $gameActors.actor($.myActorId);
    var actorJson = mine ? $.actorJson(mine) : null;
    var inv = { i: $gameParty._items, w: $gameParty._weapons, a: $gameParty._armors, g: $gameParty._gold };
    var screen = { b: $gameScreen._brightness, t: $gameScreen._tone.slice(),
        tt: ($gameScreen._toneTarget || $gameScreen._tone).slice(), td: $gameScreen._toneDuration || 0 };
    var me = { x: $gamePlayer.x, y: $gamePlayer.y, d: $gamePlayer.direction(), hidden: $gamePlayer.isTransparent() };
    DataManager.createGameObjects();
    DataManager.extractSaveContents($.parseSnapshot(msg.data));
    // the same map: this PC has its data, build the events in the host's world
    if (!msg.here) delete $gameMap._fhEv;
    else if (!$.expandEvents() && $gameMap._fhEv) $gameMap._fhEv.reset = $.resetRoamEvents; // after the map loads
    $gameParty._inBattle = false; // a snapshot made while the host fought
    ($.roamDeltas || []).forEach(function(d) { $.applyWorldDelta(d, null, false); });
    $.roamDeltas = [];
    // the newest copy of the guest's own things is this PC's while it was
    // already running its map; otherwise (and after a load) the host's
    var menu = msg._menuBase, hostHp = -1;
    if (msg.me && msg.me.actorId === $.myActorId) {
        if (menu) {
            // A roam the host sent before it saw this player's menu open:
            // its copy is from before the menu. Keep what the menu did on
            // top of it (its equipment; HP and bag as the change), as the
            // host does with syncMe - the menu's changes were lost.
            var hostCopy = msg.me.actor ? $.parseActor(msg.me.actor) : null;
            hostHp = hostCopy ? hostCopy.hp : -1;
            var merged = JSON.parse(JSON.stringify(msg.me.inv || {}));
            merged = { i: merged.i || {}, w: merged.w || {}, a: merged.a || {}, g: Number(merged.g) || 0 };
            $.applyInvDelta(merged, menu.inv, inv);
            inv = merged;
        } else {
            if (msg.me.actor) actorJson = msg.me.actor;
            inv = msg.me.inv || {};
        }
        if (msg.me.syn && $.takeSyn) $.takeSyn(msg.me.syn); // its crafted record, not the host's
    }
    $.lastMe = null; // an old 'me' must never come back after a later snapshot
    if (actorJson) $gameActors._data[$.myActorId] = $.parseActor(actorJson);
    var menuMe = menu && hostHp >= 0 ? $gameActors.actor($.myActorId) : null;
    if (menuMe) menuMe.setHp(Math.max(0, Math.min(menuMe.mhp, hostHp + (menuMe.hp - menu.hp))));
    $.SELECT_SWITCHES.forEach(function(id) { $gameSwitches._data[id] = false; });
    var sel = $.SELECT_OF_ACTOR[$.myActorId];
    if (sel) $gameSwitches._data[sel] = true;
    if ($.applyOwnSwitches) $.applyOwnSwitches(msg.own); // its sleep, not the host's (end of file)
    // its own "a scene runs" flags: the host's (a scene of the host's) would
    // stop this PC's hunger and outfit events for good
    if (msg.pc && $.CTX_OWN_SWITCHES) $.CTX_OWN_SWITCHES.forEach(function(id) { $gameSwitches._data[id] = !!msg.pc[id]; });
    // no door of the host's half done (its last step is on while it leaves;
    // a door of this player's handed over is past its steps: its CE104 is next)
    $.clearDoorSteps();
    $gameParty._actors = [$.myActorId];
    $gameParty._items = inv.i || {};
    $gameParty._weapons = inv.w || {};
    $gameParty._armors = inv.a || {};
    $gameParty._gold = Number(inv.g) || 0;
    // nothing of the host's own scene
    $gameMessage.clear();
    $gameMap._interpreter = msg.interp ? $.cleanInterp(JsonEx.parse(msg.interp)) : new Game_Interpreter();
    $gameMap._commonEvents = $gameMap.parallelCommonEvents().map(function(ce) {
        return new Game_CommonEvent(ce.id);
    });
    $.resetRoamEvents($gameMap.events());
    if (msg.here && !msg.interp) $.clearHostWaySteps();
    var p = $gamePlayer;
    p.clearTransferInfo();
    p._moveRouteForcing = false;
    // an event going on here keeps the player hidden as it had it (the
    // elevator rope, Map167 EV44: 211 hides the player, then the transfer
    // hands the event over - a second Marina stood in the shaft, 2026-10-31)
    p.setTransparent(!!msg.interp && me.hidden);
    p.setOpacity(255);
    p.setBlendMode(0);
    if (msg.here) {
        p.locate(me.x, me.y);
        p.setDirection(me.d);
        // keep this PC's fade (its own event's), but not the host's screen
        // as it left the map (msg.scr: the map's look before the host's scene)
        if (msg.scr && Array.isArray(msg.scr.t)) {
            screen = { b: Number(msg.scr.b), t: msg.scr.t.slice(), tt: msg.scr.t.slice(), td: 0 };
        }
        $gameScreen._brightness = isNaN(screen.b) ? 255 : screen.b;
        $gameScreen._fadeOutDuration = 0;
        $gameScreen._fadeInDuration = 0;
        $gameScreen._tone = screen.t;
        $gameScreen._toneTarget = screen.tt; // (not the snapshot's: the host's tint on its way)
        $gameScreen._toneDuration = screen.td;
    } else {
        $gameScreen.clear();
        p.reserveTransfer(msg.pos.m, msg.pos.x, msg.pos.y, msg.pos.d || 2, 2);
    }
    p.refresh();
    $.remotes = {};
    $.pm = null;
    $.pmQueue = [];
    $.myEventRunning = false;
    $.deferredShared = undefined;
    // the host's shared dialogue is not this PC's game now (its "closed" is
    // dropped while roaming: the flag made the next personal choice a vote)
    if ($.resetGuestShared) $.resetGuestShared();
    $.worldDirty = null;
    $.lastRoamMeKey = null;
    $.roam = { leaving: false, since: Graphics.frameCount };
    $.dlog('roaming on map', msg.pos.m, msg.interp ? 'with an event' : '');
    if (msg.here && $.canSwapInPlace(msg.pos.m)) $.swapInPlace(); else SceneManager.goto(Scene_Map);
};

// Left behind on the host's map: a way out the host was taking is the host's.
// Its event's autorun pages are steps (switches or self switches) and the
// last one moves the player; some turn the steps off only after the move
// (the gate before Prehevil, Map016 EV125 lock_target1: SW3132-3134, p4
// moves to Map036 and then turns them off), so the world the host left with
// had the last step on, and this PC went through the gate after it (Karin,
// 2026-11-02 - the doors' shared steps, $.DOOR_SWITCHES, the same way on
// 2026-11-01). Every event here whose page now is an autorun that moves the
// player gets its autorun steps off on this PC - the switches and self
// switches that event turns on itself (not a story switch set elsewhere).
$.eventOwnSteps = function(data) {
    if (data._fhOwnSteps === undefined) {
        // (steps: what it turns on and off again - not a story flag it only
        // turns on, Map020 EV060 SW120 Mayor_dead, review 2026-11-03)
        var on = { sw: {}, ss: {} }, off = { sw: {}, ss: {} }, sw = {}, ss = {};
        data.pages.forEach(function(pg) {
            (pg.list || []).forEach(function(cmd) {
                var p = cmd.parameters;
                if (cmd.code === 121) for (var id = p[0]; id <= p[1]; id++) (p[2] === 0 ? on : off).sw[id] = true;
                if (cmd.code === 123) (p[1] === 0 ? on : off).ss[p[0]] = true;
            });
        });
        Object.keys(on.sw).forEach(function(id) { if (off.sw[id]) sw[id] = true; });
        Object.keys(on.ss).forEach(function(ch) { if (off.ss[ch]) ss[ch] = true; });
        data._fhOwnSteps = { sw: sw, ss: ss };
    }
    return data._fhOwnSteps;
};

$.clearHostWaySteps = function() {
    var mapId = $gameMap.mapId(), cleared = [];
    $gameMap.events().forEach(function(ev) {
        var data = ev.event(), index = data ? ev.findProperPageIndex() : -1;
        var page = index >= 0 ? data.pages[index] : null;
        if (!page || page.trigger !== 3 || !$.pageTransfers(page)) return;
        // (a bed's way into a dream is each player's own: "Sleeping together")
        var to = $.pageTransferMap(page);
        if (to && $.DREAM_MAPS[to]) return;
        var own = $.eventOwnSteps(data), any = false;
        data.pages.forEach(function(pg) {
            if (pg.trigger !== 3) return;
            var c = pg.conditions;
            [c.switch1Valid && c.switch1Id, c.switch2Valid && c.switch2Id].forEach(function(id) {
                // (each PC's own switches are its own already: its sleep, its scene flags)
                if (id && own.sw[id] && !$.NO_SYNC_SWITCHES[id] && $gameSwitches._data[id]) {
                    $gameSwitches._data[id] = false;
                    any = true;
                }
            });
            var key = [mapId, ev.eventId(), c.selfSwitchCh].join(',');
            if (c.selfSwitchValid && own.ss[c.selfSwitchCh] && $gameSelfSwitches._data[key]) {
                delete $gameSelfSwitches._data[key];
                any = true;
            }
        });
        if (any) cleared.push(ev.eventId());
    });
    if (!cleared.length) return;
    $gameMap.requestRefresh();
    $.dlog('left behind: the host\'s way out not taken here, ev', cleared.join(', '));
};

// Transfer onto the host's map: the host runs the rest of the event.
Game_Interpreter.prototype.fhBackToHost = function() {
    if ($gameMessage.isBusy()) return false;
    var spot = $.transferSpot(this);
    var inMapChain = false;
    for (var i = $gameMap._interpreter; i; i = i._childInterpreter) {
        if (i === this) inMapChain = true;
    }
    this._index++;
    this.setWaitMode('fhHanded');
    $.backToHost = { spot: spot, event: inMapChain };
    return false;
};

$.sendUnroam = function(spot, interpJson) {
    $.flushWorldGuest();
    var actor = $gameActors.actor($.myActorId);
    var msg = {
        t: 'unroam', m: spot.m, x: spot.x, y: spot.y, d: spot.d || $gamePlayer.direction(),
        interp: interpJson || null, actor: $.actorJson(actor),
        inv: { i: $gameParty._items, w: $gameParty._weapons, a: $gameParty._armors, g: $gameParty._gold }
    };
    // the host came onto this map: where its events are here ("The host walks
    // onto a guest's map", end of file)
    if (spot.m === $gameMap.mapId() && $.hostMapId === spot.m && $.roamEventStates) {
        msg.ms = $.roamMapMs();
        msg.ev = $.roamEventStates();
    }
    $.conn.send(msg);
    $.roam.leaving = true;
    $.dlog('back to the host map', spot.m);
};

$.roamIdle = function() {
    return SceneManager._scene instanceof Scene_Map && !SceneManager.isSceneChanging() &&
        !$gameMap.isEventRunning() && !$gameMessage.isBusy() && !$gamePlayer.isTransferring() &&
        !$.localBattle && !$.puppet && !$.roamAsk && Graphics.frameCount - $.roam.since > 30;
};

$.sendRoamMe = function(force) {
    var actor = $gameActors.actor($.myActorId);
    var msg = { t: 'roamMe', actor: $.actorJson(actor),
        inv: { i: $gameParty._items, w: $gameParty._weapons, a: $gameParty._armors, g: $gameParty._gold } };
    var key = JSON.stringify([msg.actor, msg.inv]);
    $.lastRoamInvKey = JSON.stringify(msg.inv);
    if (!force && key === $.lastRoamMeKey) return;
    $.lastRoamMeKey = key;
    $.conn.send(msg);
};

// The bag changed since the last report (cheap: no character JSON).
$.lastRoamInvKey = '';
$.roamInvChanged = function() {
    return JSON.stringify({ i: $gameParty._items, w: $gameParty._weapons, a: $gameParty._armors,
        g: $gameParty._gold }) !== $.lastRoamInvKey;
};

// The common events of items used in a menu while its roam was on the way
// (the host sends them back): run here, one at a time, once roaming.
$.ownCeQueue = [];
$.guestHandlers.ceRun = function(msg) {
    (msg.ids || []).forEach(function(id) { if ($dataCommonEvents[id]) $.ownCeQueue.push(id); });
};

$.runOwnCeQueue = function() {
    if (!$.ownCeQueue.length || !$.isRoaming() || !(SceneManager._scene instanceof Scene_Map) ||
            $gameMap.isEventRunning() || $gameTemp.isCommonEventReserved()) return;
    var id = $.ownCeQueue.shift();
    $.dlog('menu item event here (it came back from the host)', id);
    $gameTemp.reserveCommonEvent(id);
};

$.roamFrame = 0;
$.guestExtras.push(function() {
    $.runOwnCeQueue();
    if ($.pendingRoam && $.canStartRoam()) {
        var msg = $.pendingRoam;
        $.pendingRoam = null;
        $.startRoam(msg);
        return;
    }
    if (!$.isRoaming() || !$.conn) return;
    if ($.backToHost && !$.subsBusy()) {
        var back = $.backToHost;
        $.backToHost = null;
        $.sendUnroam(back.spot, back.event ? JsonEx.stringify($gameMap._interpreter) : null);
        return;
    }
    if ($.roamAsk && $.clockMs() > $.roamAsk.until) $.roamAsk = null;
    if (++$.roamFrame % $.syncInterval === 0) {
        // the bag goes before the world change that came with it: a chest
        // opened on its map reached the host 0.1 s after, the item up to
        // 1 s after - a save or a disconnect in between lost the item
        // (final review C5)
        if ($.worldDirty || $.roamInvChanged()) $.sendRoamMe(false);
        $.flushWorldGuest();
    }
    if ($.roamFrame % 60 === 0) $.sendRoamMe(false);
    if ($.hostMapId === $gameMap.mapId() && !$.DREAM_MAPS[$.hostMapId] && $.roamIdle()) {
        $.sendUnroam({ m: $gameMap.mapId(), x: $gamePlayer.x, y: $gamePlayer.y, d: $gamePlayer.direction() });
    }
});

// The host's map view is not this PC's game while it roams.
var _applyState = $.applyState;
$.applyState = function(msg) {
    // a guest running its map for others says where the host is (hm)
    if (msg && msg.mapId) $.hostMapId = msg.hm || msg.mapId;
    if ($.roam || $.pendingRoam) {
        if ($gameMap && msg && !$.pendingSnapshot) $.applyPlayers(msg.pl, msg.mapId);
        // the host's world is on its way (back from a dream): its screen
        // after that snapshot is the one to show (FH_Coop "Resync")
        if ($.pendingSnapshot) $.keepDroppedScr(msg, true);
        return;
    }
    _applyState(msg);
};

var _guestMe = $.guestHandlers.me;
$.guestHandlers.me = function(msg) {
    if (($.isRoaming() || $.pendingRoam) && !$.pendingSnapshot) return;
    // the spot from the host's snapshot reply survives a later 'me'
    var spot = $.pendingSnapshot && $.lastMe && $.lastMe.pos;
    _guestMe(msg);
    if (spot && $.lastMe && !$.lastMe.pos) $.lastMe.pos = spot;
};

// Any snapshot puts the guest back into the host's game.
var _processPendingSnapshot = $.processPendingSnapshot;
$.processPendingSnapshot = function() {
    var had = !!$.pendingSnapshot;
    var ownPc = had ? $.pendingSnapshot.pc : null; // its own SW202 / SW410 ... (FH_Coop sendSnapshot)
    if (had) {
        $.roam = null;
        $.backToHost = null;
        $.roamAsk = null;
        $.worldDirty = null;
    }
    _processPendingSnapshot();
    if (ownPc && $gameSwitches && $.CTX_OWN_SWITCHES) {
        $.CTX_OWN_SWITCHES.forEach(function(id) { $gameSwitches._data[id] = !!ownPc[id]; });
    }
    if (had && $gameParty) $gameParty._inBattle = false; // made while the host fought
};

var _leaveAsGuest = $.leaveAsGuest;
$.leaveAsGuest = function(message) {
    $.roam = null;
    $.pendingRoam = null;
    $.backToHost = null;
    $.roamAsk = null;
    $.worldDirty = null;
    _leaveAsGuest(message);
};

var _canMove = Game_Player.prototype.canMove;
Game_Player.prototype.canMove = function() {
    if ($.isGuest() && ($.pendingRoam || ($.roam && $.roam.leaving))) return false;
    return _canMove.call(this);
};

// Own game: the engine's message and choice input, no votes.
$.asOwnGame = function(fn) {
    var solo = $.solo;
    $.solo = solo || { roam: true };
    try {
        return fn();
    } finally {
        $.solo = solo;
    }
};

var _updateInput = Window_Message.prototype.updateInput;
Window_Message.prototype.updateInput = function() {
    if ($.isRoaming() && !$.pm) {
        var self = this;
        return $.asOwnGame(function() { return _updateInput.call(self); });
    }
    return _updateInput.call(this);
};

['callOkHandler', 'callCancelHandler'].forEach(function(name) {
    var base = Window_ChoiceList.prototype[name];
    Window_ChoiceList.prototype[name] = function() {
        if ($.isRoaming() && !$.pm) {
            var self = this;
            return $.asOwnGame(function() { return base.call(self); });
        }
        return base.call(this);
    };
});

// Companions do not join a player's party in co-op.
var _command129 = Game_Interpreter.prototype.command129;
Game_Interpreter.prototype.command129 = function() {
    if ($.isRoaming()) return true;
    return _command129.call(this);
};

var _tradePartners = $.tradePartners;
$.tradePartners = function() {
    if ($.isRoaming()) return [];
    return _tradePartners();
};

//-----------------------------------------------------------------------------
// Defeat on the guest's own map: down, like everywhere else
//-----------------------------------------------------------------------------

var _handleGameOver = $.handleGameOver;
$.handleGameOver = function() {
    if ($.isGuest() && $.isRoaming() && !$.localBattle && !$.puppet) {
        $.roamDefeated();
        return true;
    }
    return _handleGameOver();
};

$.roamDefeated = function() {
    $.dlog('down on own map', $gameMap.mapId());
    var stopped = $gameMap._interpreter.isRunning();
    for (var i = $gameMap._interpreter; i; i = i._childInterpreter) {
        if (i._list) i._index = i._list.length; // the event stops as after a defeat
    }
    if (stopped) $.afterStoppedScene();
    // the game over flow's tint / flags on this PC (CE500 in its own fight,
    // CE359 ...): the game goes on; a screen still dark later is put back
    if ($.undoDeathFlow) $.undoDeathFlow('self', 'down on its own map');
    if ($.openScreenFix) $.openScreenFix('down', $.downMs + 5000);
    var actor = $gameActors.actor($.myActorId);
    if ($gameParty.inBattle()) {
        $gameParty.reviveBattleMembers();
        BattleManager.replayBgmAndBgs();
    }
    if (actor) {
        actor.removeState(actor.deathStateId());
        if (actor.hp <= 0) actor.setHp(1);
    }
    $.myState = 'down';
    $.sendRoamMe(true);
    $.conn.send({ t: 'roamDown', doom: $.doomOf ? $.doomOf(actor) : '' });
    if (!(SceneManager._scene instanceof Scene_Map) || $gameParty.inBattle()) SceneManager.goto(Scene_Map);
};

// What a stopped scene left behind. In the original such a defeat is the game
// over, so nothing undoes it; the co-op down plays on: the scene's black tint
// (Map005 EV114 page 4 line 207 before the Samarie fight), its "a scene runs"
// flags SW202 / SW410 (this PC's own), a hidden player, a closed menu.
$.afterStoppedScene = function() {
    var sc = $gameScreen;
    var dark = function(t) { return !!t && t[0] <= -128 && t[1] <= -128 && t[2] <= -128; };
    var undo = [];
    if (dark(sc._tone) || (sc._toneDuration > 0 && dark(sc._toneTarget))) {
        sc.startTint([0, 0, 0, 0], 30);
        undo.push('tint');
    }
    if (sc._brightness < 255 || sc._fadeOutDuration > 0) {
        sc.startFadeIn(30);
        undo.push('fade');
    }
    $gameSwitches.setValue(202, false);
    $gameSwitches.setValue(410, false);
    if ($gamePlayer.isTransparent()) undo.push('hidden player');
    $gamePlayer.setTransparent(false);
    $gameSystem.enableMenu();
    $.dlog('down: the stopped scene is undone (SW202/410 off, menu on' + (undo.length ? ', ' + undo.join(', ') : '') + ')');
};

// Revived (a down guest goes back to the host's game when the host comes to
// its map; then anyone there can revive it): this PC has the character.
$.pstateOf = {}; // guest: player id -> '' | 'down' | 'dead' (from the host)

// A guest running a map for others needs to know who is down.
var _isDownRoam = $.isDown;
$.isDown = function(id) {
    // 'host' is this PC's own player in the map code
    if (!$.isHost() && $.subHosting()) return !!$.pstateOf[id === 'host' ? $.myId : id];
    return _isDownRoam(id);
};

// (the same for a death: the host's word, as the host told this PC. It was
// always "no" on a sub-host - a trade to a ghost of its map went through, a
// dead guest's bag came back after the host had emptied it: audit 2026-11-10)
var _isDeadRoam = $.isDead;
$.isDead = function(id) {
    if (!$.isHost() && $.subHosting()) return $.pstateOf[id === 'host' ? $.myId : id] === 'dead';
    return _isDeadRoam(id);
};

var _pstate = $.guestHandlers.pstate;
$.guestHandlers.pstate = function(msg) {
    var wasDown = $.isGuest() && msg.id === $.myId && !!$.myState;
    $.pstateOf[msg.id] = msg.s || '';
    _pstate(msg);
    if (wasDown && !msg.s && $.isRoaming()) {
        var actor = $gameActors.actor($.myActorId);
        if (actor) {
            actor.removeState($.KNOCKOUT);
            actor.setHp(Math.max(actor.hp, Math.round(actor.mhp * $.reviveRate)));
            if ($.restoreDownStates) $.restoreDownStates(actor); // (its states from before the down)
            // what its own game over flow's Change Actor Images replaced
            var images = $.standUpImages && $.standUpImages(actor);
            if (images && $gamePlayer) $gamePlayer.refresh();
            $.dlog('revived (own map) - hp', actor.hp, images ? '- images from before the game over back' : '');
        }
    }
};

//-----------------------------------------------------------------------------
// Things the host decides for everyone: sleeping, the Hollow Tower door
//-----------------------------------------------------------------------------

$.roamAsk = null; // guest: { id, until (ms, $.clockMs) }
$.ROAM_ASK_MS = 35000; // the host's vote (30 s) and a little more
$.nextAskId = 1;

var _Game_Event_start = Game_Event.prototype.start;
Game_Event.prototype.start = function() {
    if ($.isRoaming() && !this._fhConsented && this.page() && !$gamePlayer._fhRemoteId) {
        var kind = '';
        if (this._trigger <= 2 && $.pageNeedsConsent(this.list())) kind = 'consent';
        if ($gameMap.mapId() === $.TOWER_MAP && this.eventId() === $.TOWER_EVENT && this._trigger <= 1) kind = 'betray';
        if (kind) {
            if (!$.roamAsk) {
                $.flushWorldGuest();
                $.roamAsk = { id: $.nextAskId++, ev: this.eventId(), map: $gameMap.mapId(),
                    sleep: kind === 'consent' && $.pageStartsSleep(this.list()),
                    until: $.clockMs() + $.ROAM_ASK_MS };
                $.conn.send({ t: kind === 'consent' ? 'consentReq' : 'betrayAsk', id: $.roamAsk.id,
                    sleep: $.roamAsk.sleep, mapId: $.roamAsk.map, eventId: $.roamAsk.ev });
            }
            return;
        }
    }
    _Game_Event_start.call(this); // FH_CoopWorld clears _fhConsented
};

$.guestHandlers.askOk = function(msg) {
    var ask = $.roamAsk;
    if (!ask || ask.id !== msg.id) return;
    $.roamAsk = null;
    var ev = $gameMap.mapId() === ask.map ? $gameMap.event(ask.ev) : null;
    if (!ev || !$.isRoaming()) return;
    ev._fhConsented = true;
    ev.start();
};

$.guestHandlers.askNo = function(msg) {
    if ($.roamAsk && $.roamAsk.id === msg.id) $.roamAsk = null;
};

$.isSleepBedConsent = function(conn, msg) {
    if (!msg || !msg.sleep || !Number(msg.mapId) || !Number(msg.eventId)) return false;
    var mapId = Number(msg.mapId);
    if (mapId !== $.playerMapOfRest(conn.guestId)) return false;
    // When the host runs this map it can verify the bed page from game data.
    // A roaming/sub-hosted client is running a different map copy, so its
    // authenticated position is the available server-side map check.
    if (mapId !== $gameMap.mapId()) return !!(conn.roam || conn.roamPending || conn.subOf);
    var ev = $gameMap.event(Number(msg.eventId));
    if (!ev || ev._erased) return false;
    var data = ev.event();
    return !!(data && data.pages && data.pages.some(function(page) {
        return page.trigger <= 2 && $.pageStartsSleep(page.list);
    }));
};

$.hostHandlers.consentReq = function(conn, msg) {
    if (!conn.roam) return;
    if (msg.sleep && !$.isSleepBedConsent(conn, msg)) {
        conn.send({ t: 'toast', text: 'Co-op: could not sync this bed event' });
        conn.send({ t: 'askNo', id: msg.id });
        return;
    }
    if ($.consent) {
        conn.send({ t: 'toast', text: 'Co-op: another vote is running' });
        conn.send({ t: 'askNo', id: msg.id });
        return;
    }
    var sleep = !!msg.sleep;
    $.requestConsent(conn.guestId, function() {
        if (sleep) $.sleepTogether(conn.guestId);
        conn.send({ t: 'askOk', id: msg.id });
    }, { sleep: sleep, mapId: msg.mapId, eventId: msg.eventId });
    if ($.consent && $.consent.from === conn.guestId) $.consent.fhAsk = { conn: conn, id: msg.id };
};

var _resolveConsent = $.resolveConsent;
$.resolveConsent = function(ok) {
    var c = $.consent;
    _resolveConsent(ok);
    if (!ok && c && c.fhAsk) c.fhAsk.conn.send({ t: 'askNo', id: c.fhAsk.id });
};

var _pvpHandler = $.guestHandlers.pvp;
$.guestHandlers.pvp = function(msg) {
    if ($.isGuest() && $.isRoaming()) {
        // this PC's world is already in sync; keep its own SELECT and processes
        msg.sw = $gameSwitches._data.slice();
        msg.v = $gameVariables._data.slice();
        msg.ss = Object.assign({}, $gameSelfSwitches._data);
    }
    _pvpHandler(msg);
};

// Only one may enter the tower: the players left decide it in duels first
// (FH_CoopBattle tournament).
// forId: a sub-host asks for the guest it runs (that guest is at the door).
$.hostHandlers.betrayAsk = function(conn, msg) {
    if (!conn.roam) return;
    var sub = msg.forId ? $.clientById(msg.forId) : null;
    if (msg.forId && (!sub || sub.subOf !== conn.guestId)) return;
    var id = sub ? sub.guestId : conn.guestId;
    if ($.isDown(id)) { // (just died or down there: its state not on its PC yet - review 2026-11-06)
        if (!sub) conn.send({ t: 'askNo', id: msg.id });
        return;
    }
    if ($.towerDoorUse(id)) {
        conn.send(sub ? { t: 'towerOk', forId: sub.guestId, ev: msg.ev } : { t: 'askOk', id: msg.id });
    } else if (!sub) {
        conn.send({ t: 'askNo', id: msg.id });
    }
};

// Sub-host: a guest it runs uses the tower door. The host decides it.
$.towerAskAt = {}; // sub-host: guest id -> ms of its last ask
$.eventStartHooks.push(function(conn, ev, page) {
    if ($.isHost() || !$.subHosting() || !$.isTowerDoor(ev) || !page || page.trigger > 1) return false;
    if (ev._fhTowerOk === conn.guestId) {
        ev._fhTowerOk = null; // the host said: the original door
        return false;
    }
    var at = $.towerAskAt[conn.guestId], now = $.clockMs();
    if (at === undefined || now - at > $.TOWER_TELL_MS) {
        $.towerAskAt[conn.guestId] = now;
        $.conn.send({ t: 'betrayAsk', id: 0, forId: conn.guestId, ev: ev.eventId() });
    }
    return true;
});

$.guestHandlers.towerOk = function(msg) {
    var c = $.clientById(msg.forId);
    var ev = $gameMap.mapId() === $.TOWER_MAP ? $gameMap.event(msg.ev) : null;
    if (!c || !ev || !$.subHosting()) return;
    ev._fhTowerOk = c.guestId;
    if (!$.startEventFor(c, ev, [0, 1])) ev._fhTowerOk = null;
};

// The host loaded a save: the tournament of the world before is over.
var _dropOldWorldTourney = $.dropOldWorld;
$.dropOldWorld = function() {
    if ($.tourney && $.tourneyOver) $.tourneyOver('a save loaded');
    $.tourney = null;
    $.tourneyAsk = null;
    $.endDuelIntro(false);
    _dropOldWorldTourney();
};

//=============================================================================
// Two guests on one map without the host: the first one runs it for both
//=============================================================================
// The guest who came to the map first ("sub-host") runs it for the guests who
// come later, the way the host runs its own map: they are thin clients of the
// sub-host. Guests only talk to the host, so the host passes the messages on
// (sub-host -> 'subRelay' -> guest, guest -> host -> 'subMsg' -> sub-host).
// The later guest's character and bag stay with the sub-host while it is
// there and are reported to the host for its save. Fights on that map are
// in the host's list too, so the players there can join them (see the end).

$.SUB_FORWARD = { act: 1, pmsgDone: 1, syncMe: 1, menuOpen: 1, ce: 1, battleEnd: 1, shoot: 1,
    needSnap: 1, pos: 1, bConsume: 1, bGain: 1, bLeft: 1, trade: 1, tradeAck: 1, resync: 1,
    sleepCancel: 1, keys: 1 };
$.SUB_ASK_MS = 60000; // a join request nobody answered is asked again (real time, $.clockMs)

// Host -----------------------------------------------------------------------

$.subsOf = function(conn) {
    return $.clients.filter(function(c) { return c.subOf === conn.guestId; });
};

var _guestOnMapSub = $.guestOnMap;
$.guestOnMap = function(conn) {
    if (conn.subOf) return false;
    return _guestOnMapSub(conn);
};

var _onHostMessageSub = $.onHostMessage;
$.onHostMessage = function(conn, msg) {
    if (msg && msg.t === 'pos' && msg.p && conn.guestId) {
        // (a re-join's first word: on that map from now, whatever spot the host gave it)
        if (!conn.lastPos || conn.lastPos.m !== msg.p.m || conn._fhNoPos) {
            conn.mapSince = Graphics.frameCount;
            conn.subAsked = null;
        }
        conn._fhNoPos = false;
    }
    if (msg && msg.t === 'tradeAck' && msg.by && $.subAckHandled(conn, msg)) return;
    if (conn.subOf && msg && $.SUB_FORWARD[msg.t]) {
        var owner = $.clientById(conn.subOf);
        if (owner) owner.send({ t: 'subMsg', from: conn.guestId, m: msg });
        if (msg.t === 'battleEnd') $.subFightEndSeen(conn, msg);
        // the host keeps positions too (avatars, saves) and who is in which fight
        if (msg.t !== 'pos' && msg.t !== 'bLeft') return;
    }
    _onHostMessageSub(conn, msg);
};

// A guest of a sub-host gets its world from the sub-host only.
var _hostSyncSub = $.hostSync;
$.hostSync = function() {
    var all = $.clients;
    if (all.some(function(c) { return c.subOf; })) $.clients = all.filter(function(c) { return !c.subOf; });
    try {
        _hostSyncSub();
    } finally {
        $.clients = all;
    }
    $.settleSubs();
};

var _sendSnapshotSub = $.sendSnapshot;
$.sendSnapshot = function(conn) {
    if (conn) {
        if (conn.subOf) $.detachSub(conn); // the host takes it over
        return _sendSnapshotSub(conn);
    }
    var all = $.clients;
    if (!all.some(function(c) { return c.subOf; })) return _sendSnapshotSub();
    $.clients = all.filter(function(c) { return !c.subOf; });
    try {
        return _sendSnapshotSub();
    } finally {
        $.clients = all;
    }
};

var _pushMeSub = $.pushMe;
$.pushMe = function(conn) {
    if (conn && conn.subOf && $.isHost()) return; // its sub-host has the newest copy
    _pushMeSub(conn);
};

var _containerOfSub = $.containerOf;
$.containerOf = function(id, kind) {
    var conn = id === 'host' ? null : $.clientById(id);
    if (conn && conn.subOf) return null;
    return _containerOfSub(id, kind);
};

$.cameFirst = function(a, b) {
    var ta = a.mapSince || 0, tb = b.mapSince || 0;
    return ta < tb || (ta === tb && a.guestId < b.guestId);
};

// A roaming guest that came second to a roaming guest's map joins it.
$.settleSubs = function() {
    if ($.tourney) return; // no sub-hosting while the duels last (FH_CoopBattle)
    $.clients.forEach(function(c) {
        if (c.subAsked && $.clockMs() - (c.subAskedAt || 0) > $.SUB_ASK_MS) c.subAsked = null;
        if (!c.roam || c.subAsked || c.roamPending || !c.lastPos || $.subsOf(c).length) return;
        if ($.DREAM_MAPS[c.lastPos.m]) return; // each dreams alone ("Sleeping together")
        // one whose PC has not said where it is since it (re)joined (still at its
        // title) neither joins nor takes guests yet: it refused every guest sent
        // to it, and the host sent them back and again (flow tests L-2b)
        if (c._fhNoPos) return;
        var first = null;
        $.clients.forEach(function(o) {
            if (o === c || !o.roam || o.subOf || o.subAsked || !o.lastPos || o.lastPos.m !== c.lastPos.m) return;
            if (o._fhNoPos) return;
            if ($.cameFirst(o, c) && (!first || $.cameFirst(o, first))) first = o;
        });
        if (!first) return;
        c.subAsked = first.guestId;
        c.subAskedAt = $.clockMs();
        c.send({ t: 'subJoin' });
    });
};

var _unroamSub = $.hostHandlers.unroam;
$.hostHandlers.unroam = function(conn, msg) {
    var owner = conn.subAsked && $.clientById(conn.subAsked);
    conn.subAsked = null;
    if (conn.roam && owner && owner.roam && !owner.subOf && owner.lastPos && owner.lastPos.m === msg.m &&
            msg.m !== $gameMap.mapId()) {
        $.storeBelongings(conn, msg);
        conn.roam = false;
        conn.subOf = owner.guestId;
        conn.lastPos = Object.assign({}, conn.lastPos || {}, { id: conn.guestId, m: msg.m, x: msg.x, y: msg.y, d: msg.d || 2 });
        delete $.remotes[conn.guestId];
        var actor = $gameActors.actor(conn.actorId);
        owner.send({
            t: 'subAdd', id: conn.guestId, name: conn.name, actorId: conn.actorId,
            actor: $.actorJson(actor), inv: $.inventoryOf(conn), hx: $.withHostSigils($.boardOf(conn)),
            pos: { m: msg.m, x: msg.x, y: msg.y, d: msg.d || 2 }, interp: msg.interp || null
        });
        $.dlog('sub', conn.name, 'joins', owner.name, 'on map', msg.m);
        return;
    }
    _unroamSub(conn, msg);
};

// The sub-host gives a guest back (it left the map): the message to the
// guest is a 'roam' and from now on that guest runs its own map.
$.hostHandlers.subRelay = function(conn, msg) {
    var c = $.clientById(msg.to);
    if (!c || c.subOf !== conn.guestId || !msg.m) return;
    if (msg.m.t === 'tradeFail') $.addSubFail(c, conn.guestId, msg.m, false);
    if (msg.m.t === 'roam') {
        $.subFailsLeft(c, conn.guestId);
        c.subOf = null;
        c.subWas = conn.guestId;
        c.subWasInv = null; // its own PC has its things from now on
        c.roam = true;
        c.roamPending = null;
        c._lastRoamMeKey = null;
    }
    c.send(msg.m);
};

$.hostHandlers.subMe = function(conn, msg) {
    var c = $.clientById(msg.id);
    if (c && c.subOf === conn.guestId) {
        $.storeBelongings(c, msg);
        return;
    }
    // the last report of a guest the host took from its sub-host (or that
    // left): what changed there since the host's copy, the bag only
    c = c || $.subLeft[msg.id];
    if (!c || c.subOf || c.roam || c.subWas !== conn.guestId || !c.subWasInv || !msg.inv) return;
    var now = { i: msg.inv.i || {}, w: msg.inv.w || {}, a: msg.inv.a || {}, g: Number(msg.inv.g) || 0 };
    $.applyInvDelta($.inventoryOf(c), c.subWasInv, now);
    c.subWasInv = JSON.parse(JSON.stringify(now));
    if ($.clients.indexOf(c) >= 0) {
        c._lastMeKey = null;
        $.pushMe(c);
    }
};

$.hostHandlers.subDown = function(conn, msg) {
    var c = $.clientById(msg.id);
    if (!c || c.subOf !== conn.guestId) return;
    if (msg.doom && $.markDoom) $.markDoom($.actorOfPlayer(c.guestId), String(msg.doom));
    $.onPlayerDefeated(c.guestId);
};

$.hostHandlers.subRefuse = function(conn, msg) {
    var c = $.clientById(msg.id);
    if (!c || c.subOf !== conn.guestId) return;
    c.subOf = null;
    $.sendRoam(c, { pos: c.lastPos });
};

// The host takes a guest from its sub-host. The sub-host's last report of
// it (subMe) still counts, as a change to the host's copy as it is now.
$.subLeft = {}; // guest id -> its connection, after it left a sub-host
// gone: its PC dropped (not a hand-over): a fixed fight it ran there is a
// loss, rolled back there (flow tests F-3).
$.detachSub = function(c, gone) {
    var owner = $.clientById(c.subOf);
    $.subFailsLeft(c, c.subOf);
    c.subWas = c.subOf;
    c.subWasInv = JSON.parse(JSON.stringify($.inventoryOf(c)));
    $.subLeft[c.guestId] = c;
    c.subOf = null;
    if (owner) owner.send(gone ? { t: 'subGone', id: c.guestId, gone: 1 } : { t: 'subGone', id: c.guestId });
};

var _resetRoamsSub = $.resetRoams;
$.resetRoams = function() {
    _resetRoamsSub();
    $.subLeft = {};
    $.clients.forEach(function(c) {
        c.subOf = null;
        c.subAsked = null;
        c.subWas = null;
        c.subWasInv = null;
        c._subFails = [];
        c.send({ t: 'subReset' });
    });
};

// Trades on a sub-host's map are made there; a guest that left it meanwhile
// gets its item back through the host. The sub-host's refusals carry its id
// (by), so the guest's answer is known when it comes to the host instead.
$.tradeData = function(k) {
    return k === 'w' ? $dataWeapons : k === 'a' ? $dataArmors : k === 'i' ? $dataItems : null;
};

// The item a sub-host took from a guest it no longer runs goes back to it.
$.subOwe = function(c, k, id, n) {
    var data = $.tradeData(k);
    n = Math.max(1, Number(n) || 1);
    if (!data || !data[id]) return;
    if (c.roam) {
        // its answer (back): taken on its PC, or back in a shared game meanwhile
        $.addSubFail(c, c.subWas, { k: k, id: id, n: n }, true, true);
        c.send({ t: 'tradeBack', k: k, id: id, n: n, by: c.subWas });
        return;
    }
    var bag = $.inventoryOf(c)[k];
    bag[id] = (bag[id] || 0) + n;
    if ($.clients.indexOf(c) < 0) return; // gone: kept for its save
    c._lastMeKey = null;
    $.pushMe(c);
};

// Only a guest given back to its own PC (subRelay 'roam'): one the host took
// over is settled by the sub-host's last report (subMe).
$.leftSubOf = function(conn, id) {
    var c = $.clientById(id) || $.subLeft[id];
    return c && !c.subOf && !c.subWasInv && c.subWas === conn.guestId ? c : null;
};

// The sub-host refusals the host passed on: an answer counts for one of them,
// once. left: that sub-host no longer runs the guest (the host settles it).
$.addSubFail = function(c, by, m, left, back) {
    var data = $.tradeData(m.k);
    if (!data || !data[m.id]) return;
    c._subFails = (c._subFails || []).concat([{ by: by, k: m.k, id: m.id, n: Math.max(1, Number(m.n) || 1),
        left: !!left, back: !!back }]);
};

$.subFailsLeft = function(c, by) {
    (c._subFails || []).forEach(function(t) { if (t.by === by) t.left = true; });
};

$.takeSubFail = function(c, msg) {
    var list = c._subFails || [];
    for (var i = 0; i < list.length; i++) {
        var t = list[i];
        if (t.by === msg.by && t.k === msg.k && t.id === msg.id && t.back === !!msg.back) return list.splice(i, 1)[0];
    }
    return null;
};

// A guest's answer to a sub-host's refusal (true: settled here). Still that
// sub-host's guest: passed on, the sub-host has the record. Otherwise the
// host settles it with its record: the guest's bag is on its sub-host now
// (subGive), here, or on its own PC (tradeBack).
$.subAckHandled = function(conn, msg) {
    if (!$.isHost() || conn._sub) return false;
    var t = $.takeSubFail(conn, msg);
    if (!t) return conn.subOf !== msg.by; // no record: nothing to pay
    if (!t.left && conn.subOf === t.by) return false; // passed on as usual
    if (msg.restored) return true;
    var owner = conn.subOf ? $.clientById(conn.subOf) : null;
    if (owner) owner.send({ t: 'subGive', who: conn.guestId, k: t.k, id: t.id, n: t.n });
    else $.subOwe(conn, t.k, t.id, t.n);
    return true;
};

// A guest's trade the sub-host got after giving that guest back.
$.hostHandlers.subTradeFail = function(conn, msg) {
    var c = $.leftSubOf(conn, msg.from);
    var m = msg.m;
    if (!c || !m || !$.tradeData(m.k) || $.clients.indexOf(c) < 0) return;
    $.addSubFail(c, conn.guestId, m, true);
    c.send({ t: 'tradeFail', k: m.k, id: m.id, n: Math.max(1, Number(m.n) || 1), by: conn.guestId });
};

// A guest's answer to a refusal, after the sub-host gave that guest back.
$.hostHandlers.subTradeBack = function(conn, msg) {
    var c = $.leftSubOf(conn, msg.from);
    if (c) $.subOwe(c, msg.k, msg.id, msg.n);
};

var _onGuestClosedSub = $.onGuestClosed;
$.onGuestClosed = function(conn) {
    _onGuestClosedSub(conn);
    if (conn.subOf) $.detachSub(conn, true);
    $.clients.forEach(function(c) {
        if (c.subOf !== conn.guestId) return;
        $.subFailsLeft(c, conn.guestId);
        c.subOf = null; // its sub-host is gone: it runs the map itself (fresh)
        c.subWas = conn.guestId;
        c.subWasInv = null;
        $.sendRoam(c, { pos: c.lastPos });
    });
};

// Sleeping on a sub-host's map: the host asks everyone for that guest.
var _consentReqSub = $.hostHandlers.consentReq;
$.hostHandlers.consentReq = function(conn, msg) {
    var forConn = msg.forId && $.clientById(msg.forId);
    if (!forConn || forConn.subOf !== conn.guestId) return _consentReqSub(conn, msg);
    if (msg.sleep && !$.isSleepBedConsent(forConn, msg)) {
        conn.send({ t: 'toast', text: 'Co-op: could not sync this bed event' });
        conn.send({ t: 'askNo', id: msg.id });
        return;
    }
    if ($.consent) {
        conn.send({ t: 'askNo', id: msg.id });
        return;
    }
    var sleep = !!msg.sleep;
    $.requestConsent(forConn.guestId, function() {
        if (sleep) $.sleepTogether(forConn.guestId);
        conn.send({ t: 'askOk', id: msg.id });
    }, { sleep: sleep, mapId: msg.mapId, eventId: msg.eventId });
    if ($.consent && $.consent.from === forConn.guestId) $.consent.fhAsk = { conn: conn, id: msg.id };
};

// Sub-host --------------------------------------------------------------------

function SubConn(info) {
    this.guestId = info.id;
    this.name = info.name;
    this.actorId = info.actorId;
    this.inGame = true;
    this.solo = false;
    this._sub = true;
    this._inv = info.inv || { i: {}, w: {}, a: {}, g: 0 };
    this._hx = info.hx || null; // its Hexen board while it is here (end of file)
    this.lastPos = Object.assign({ id: info.id, n: '', i: 0 }, info.pos);
}

SubConn.prototype.send = function(m) {
    if (!$.conn || !m) return;
    if (m.t === 'tradeFail') m = Object.assign({}, m, { by: $.myId }); // see subTradeFail
    if ($.packSnapshot) m = $.packSnapshot(m); // cached: several subs get one pack
    $.conn.send({ t: 'subRelay', to: this.guestId, m: m });
};

$.SubConn = SubConn;

$.subHosting = function() {
    return $.isGuest() && $.isRoaming() && $.clients.length > 0;
};

$.runsWorld = function() {
    return $.isHost() || $.subHosting();
};

// A guest down on the map it runs alone: its events see nobody, as on the
// host's map with nobody standing (FH_CoopWorld $.eventTargets). They chased
// the body and stood round it (play test 2026-11-02, Map055 Fecal hounds).
var _eventTargetsDown = $.eventTargets;
$.eventTargets = function() {
    if ($.frameTargets === undefined && $.isGuest() && $.isRoaming() && !$.subHosting() &&
            $.myState === 'down' && $.sessionActive()) {
        return [];
    }
    return _eventTargetsDown();
};

$.worldSync = function() {
    if ($.isHost()) $.hostSync(); else if ($.subHosting()) $.subHostSync();
};

var _inventoryOfSub = $.inventoryOf;
$.inventoryOf = function(conn) {
    if (conn && conn._sub) {
        if (conn._inv.g === undefined) conn._inv.g = 0;
        ['i', 'w', 'a'].forEach(function(k) { conn._inv[k] = conn._inv[k] || {}; });
        return conn._inv;
    }
    return _inventoryOfSub(conn);
};

$.guestHandlers.subAdd = function(msg) {
    if (!$.isRoaming() || !msg.pos || msg.pos.m !== $gameMap.mapId() || $.roam.joinSub) {
        if ($.conn) $.conn.send({ t: 'subRefuse', id: msg.id });
        return;
    }
    var v = new SubConn(msg);
    var actor = $.parseActor(msg.actor);
    if (actor && actor._actorId === msg.actorId) $gameActors._data[msg.actorId] = actor;
    $.clients = $.clients.filter(function(c) { return c.guestId !== v.guestId; }).concat([v]);
    $.applyRemote(v.guestId, v.lastPos);
    v._placeAt = msg.pos;
    $.subSendSnapshot(v);
    if (msg.interp) {
        var interp = $.cleanInterp(JsonEx.parse(msg.interp));
        for (var i = interp; i; i = i._childInterpreter) i._fhOwner = v.guestId;
        $.owned[v.guestId] = { interp: interp, ev: null };
        v.send({ t: 'evRun', on: true });
    }
    $.toast('Co-op: ' + (actor ? actor.name() : msg.name) + ' is here');
    $.dlog('running map', $gameMap.mapId(), 'for', msg.name);
};

$.subSendSnapshot = function(v) {
    // (its own SW202 / SW410 too, not this PC's: FH_Coop sendSnapshot)
    v.send({ t: 'snap', mapId: $gameMap.mapId(), data: $.snapshotData(), pc: $.ctxOwnOf ? $.ctxOwnOf(v) : null });
    $.resetSyncKeys();
    v._lastMeKey = null;
    $.pushMe(v);
};

// Messages of a guest of this PC, passed on by the host.
$.guestHandlers.subMsg = function(msg) {
    var v = $.clientById(msg.from);
    var m = msg.m;
    if ((!v || !v._sub) && m) return $.subMsgLeft(msg.from, m);
    if (!v || !v._sub || !m) return;
    if (m.t === 'pos') {
        if (!m.p) return;
        v.lastPos = m.p;
        if (m.p.m === $gameMap.mapId()) $.applyRemote(v.guestId, m.p); else delete $.remotes[v.guestId];
        return;
    }
    if (m.t === 'needSnap') {
        if (!v.roamPending) $.subSendSnapshot(v);
        return;
    }
    if (m.t === 'trade' && m.to === $.myId) m.to = 'host'; // 'host' = this PC in the map code
    if (m.t === 'bConsume' || m.t === 'bGain') {
        var bag = m.jid === $.myId ? null : $.clientById(m.jid);
        if (m.jid === $.myId) {
            m.jid = 'host'; // 'host' = this PC in the map code
        } else if (!bag || !bag._sub) {
            if ($.conn) $.conn.send(m); // someone else's bag: the host has it
            return;
        }
    }
    var handler = $.hostHandlers[m.t];
    if (!handler) return;
    try {
        handler(v, m);
    } catch (e) {
        $.dlog('ERROR sub handler', m.t, e.stack || String(e));
    }
};

// A trade of a guest given back already (the host passed it on before it knew):
// the item it gave goes back to it, through the host.
$.subTradeFails = {}; // guest id -> refusals it has not answered, after it left
$.subMsgLeft = function(id, m) {
    if (!$.conn) return;
    if (m.t === 'trade') {
        $.conn.send({ t: 'subTradeFail', from: id, m: { k: m.k, id: m.id, n: m.n } });
        return;
    }
    if (m.t !== 'tradeAck') return;
    var list = $.subTradeFails[id] || [];
    var index = -1;
    list.some(function(t, i) {
        if (t.k === m.k && t.id === m.id) index = i;
        return index >= 0;
    });
    if (index < 0) return;
    var t = list.splice(index, 1)[0];
    if (!m.restored) $.conn.send({ t: 'subTradeBack', from: id, k: t.k, id: t.id, n: t.n });
};

$.removeSub = function(v) {
    if ($.subSleepMeta) delete $.subSleepMeta[v.guestId];
    if ($.subSleepPending) delete $.subSleepPending[v.guestId];
    if (v._tradeFails && v._tradeFails.length) {
        $.subTradeFails[v.guestId] = ($.subTradeFails[v.guestId] || []).concat(v._tradeFails);
    }
    if ($.owned[v.guestId]) $.finishOwned(v.guestId);
    if ($.onGuestClosedBattle) $.onGuestClosedBattle(v);
    $.clients = $.clients.filter(function(c) { return c !== v; });
    if (!$.clients.length) $.worldDirty = $.worldDirty; // nothing else to clean
};

// An item owed to a guest of this PC (refused while it was elsewhere).
$.guestHandlers.subGive = function(msg) {
    var v = $.clientById(msg.who);
    var data = $.tradeData(msg.k);
    var n = Math.max(1, Number(msg.n) || 1);
    if (!data || !data[msg.id] || !$.conn) return;
    if (!v || !v._sub) {
        // gone again: the host settles it
        $.conn.send({ t: 'subTradeBack', from: msg.who, k: msg.k, id: msg.id, n: n });
        return;
    }
    var bag = $.inventoryOf(v)[msg.k];
    bag[msg.id] = (bag[msg.id] || 0) + n;
    v._lastMeKey = null;
    $.pushMe(v);
    $.sendSubMe(v, false);
};

$.guestHandlers.subGone = function(msg) {
    var v = $.clientById(msg.id);
    if (!v || !v._sub) return;
    if ($.conn) $.sendSubMe(v, true); // its last bag: the host counts what changed here
    // its PC dropped in the middle of a fixed fight run here: rolled back
    // here, as the host does for its own guests (0.40 review M2)
    if (msg.gone && $.fxOwnerGone) $.fxOwnerGone(v);
    $.removeSub(v);
};

$.guestHandlers.subReset = function() {
    $.clients.slice().forEach(function(v) { if (v._sub) $.removeSub(v); });
    $.clients = [];
    $.subTradeFails = {};
};

$.sendSubMe = function(v, force) {
    var actor = $gameActors.actor(v.actorId);
    var msg = { t: 'subMe', id: v.guestId, actor: $.actorJson(actor), inv: $.inventoryOf(v) };
    var key = JSON.stringify([msg.actor, msg.inv]);
    if (!force && key === v._lastSubMeKey) return;
    v._lastSubMeKey = key;
    $.conn.send(msg);
};

// Giving a guest back: it runs the map on its own PC from here.
var _sendRoamSub = $.sendRoam;
$.sendRoam = function(conn, opts) {
    if (conn && conn._sub) {
        $.sendSubMe(conn, true);
        _sendRoamSub(conn, opts);
        $.removeSub(conn);
        return;
    }
    _sendRoamSub(conn, opts);
};

// The map view for the guests of this PC (like the host's sync).
$.subFrame = 0;
$.subSyncFrame = 0;
$.subHostSync = function() {
    var events = $.syncEvents(false); // (FH_Coop hostSync)
    var pres = $.presentationDelta();
    var players = [$.playerInfo($.myId)];
    $.clients.forEach(function(c) { if (c.lastPos) players.push(c.lastPos); });
    var full = null;
    $.clients.forEach(function(c) {
        var msg = {
            t: 'state', mapId: $gameMap.mapId(), hm: $.hostMapId, ev: events,
            pl: players.filter(function(p) { return p.id !== c.guestId; }),
            scr: pres.scr, pic: pres.pic, au: pres.au, msg: pres.msg
        };
        if ($.resyncDue(c)) full = $.withFullState(msg, full || $.fullState($.allEventInfo())); // (FH_Coop "Resync")
        c.send(msg);
    });
    // guests left behind while busy (this PC changed maps)
    $.clients.slice().forEach(function(c) {
        if (!c.roamPending) return;
        if (c.lastPos && c.lastPos.m === $gameMap.mapId()) {
            c.roamPending = null;
            $.subSendSnapshot(c);
        } else if (!$.isBusy(c)) {
            $.sendRoam(c, {});
        }
    });
    if (++$.subFrame % 10 === 0) $.clients.forEach(function(c) { $.sendSubMe(c, false); });
};

// A ladder's blocker for this PC's guests too (FH_CoopWorld "Pages that hang on
// a player's own switches"). Only the host sent them: a sub-host's guest stepped
// onto a ladder, its move was refused for ever and it stood there (gallery report
// 2026-11-09, four players; flows Z-21).
var _subHostSyncOwnEv = $.subHostSync;
$.subHostSync = function() {
    _subHostSyncOwnEv();
    $.sendOwnEvents();
};
var _subSendSnapshotOwnEv = $.subSendSnapshot;
$.subSendSnapshot = function(v) {
    v._fhOwnEvKey = null; // (its PC drops them with a snapshot)
    return _subSendSnapshotOwnEv(v);
};

var _subHostSyncSnapPlace = $.subHostSync;
$.subHostSync = function() {
    $.flushSnapPlaces();
    _subHostSyncSnapPlace();
};

$.guestExtras.push(function() {
    if ($.subHosting() && ++$.subSyncFrame % $.syncInterval === 0) $.subHostSync();
});

// The host's player list: the guests of this PC are drawn from their own
// positions, not the host's older copy.
var _applyPlayersSub = $.applyPlayers;
$.applyPlayers = function(list, hostMapId) {
    if (!$.subHosting()) return _applyPlayersSub(list, hostMapId);
    var mine = {};
    $.clients.forEach(function(c) { mine[c.guestId] = true; });
    var keep = {};
    Object.keys($.remotes).forEach(function(id) { if (mine[id]) keep[id] = $.remotes[id]; });
    _applyPlayersSub((list || []).filter(function(p) { return !mine[p.id]; }), hostMapId);
    Object.keys(keep).forEach(function(id) { $.remotes[id] = keep[id]; });
};

// A guest here with its menu open holds the way back too: its bag on the
// host is older than this PC's copy (a gift traded to it meanwhile) and its
// menu's syncMe went to the host with no base, so the item was gone on both
// sides (final review C4). Not for ever (a menu left open): SUB_MENU_HOLD_MS.
$.SUB_MENU_HOLD_MS = 20000;
$.subMenuHolds = function(v) {
    if (!v._sub || !v._menuBase) return false;
    var at = v._menuBase.at || 0;
    return !at || $.clockMs() - at < $.SUB_MENU_HOLD_MS;
};

$.subsBusy = function() {
    return $.subHosting() && $.clients.some(function(v) { return $.isBusy(v) || $.subMenuHolds(v); });
};

var _roamIdleSub = $.roamIdle;
$.roamIdle = function() {
    return _roamIdleSub() && !$.subsBusy();
};

// Leaving to the host's game: the guests here run the map themselves.
var _sendUnroamSub = $.sendUnroam;
$.sendUnroam = function(spot, interpJson) {
    $.clients.slice().forEach(function(v) {
        if (!v._sub) return;
        v.roamPending = null;
        if ($.owned[v.guestId]) $.finishOwned(v.guestId);
        $.sendRoam(v, {});
    });
    _sendUnroamSub(spot, interpJson);
};

// Session matters of the guests here go to the host.
var _onPlayerDefeatedSub = $.onPlayerDefeated;
$.onPlayerDefeated = function(id) {
    if (!$.isHost() && $.isGuest() && $.conn) {
        if (id === 'host' || id === $.myId) {
            if ($.isRoaming()) $.conn.send({ t: 'roamDown', doom: $.doomOf($gameActors.actor($.myActorId)) });
        } else if ($.clientById(id)) {
            $.conn.send({ t: 'subDown', id: id, doom: $.doomOf($.actorOfPlayer(id)) });
        }
        return;
    }
    _onPlayerDefeatedSub(id);
};

$.subAsks = {};
var _requestConsentSub = $.requestConsent;
$.requestConsent = function(fromId, cb, opts) {
    if ($.isHost() || !$.subHosting()) return _requestConsentSub(fromId, cb, opts);
    var id = $.nextAskId++;
    var v = $.clientById(fromId);
    if (v) v.waitingConsent = true;
    $.subAsks[id] = function(ok) {
        if (v) v.waitingConsent = false;
        if (ok) cb();
    };
    $.conn.send({ t: 'consentReq', id: id, forId: fromId === 'host' ? null : fromId,
        sleep: !!(opts && opts.sleep), mapId: opts && opts.mapId, eventId: opts && opts.eventId });
};

var _askOkSub = $.guestHandlers.askOk;
$.guestHandlers.askOk = function(msg) {
    var cb = $.subAsks[msg.id];
    if (cb) {
        delete $.subAsks[msg.id];
        cb(true);
        return;
    }
    _askOkSub(msg);
};

var _askNoSub = $.guestHandlers.askNo;
$.guestHandlers.askNo = function(msg) {
    var cb = $.subAsks[msg.id];
    delete $.subAsks[msg.id];
    if (cb) cb(false);
    _askNoSub(msg);
};

// Trading and the player OK menu on this PC's map. Every player here trades
// with every other one: this PC has its own bag and those of its guests.
var _tradePartnersSub = $.tradePartners;
$.tradePartners = function() {
    if (!$.subHosting()) return _tradePartnersSub();
    return $.clients.filter(function(v) {
        return v._sub && v.actorId && $.guestOnMap(v);
    }).map(function(v) {
        return { id: v.guestId, name: $.playerLabel(v.guestId) };
    });
};

// Nobody trades as a ghost or with one (play test 2026-10-31; the host also
// refuses it: FH_CoopBattle $.doTrade). (A guest knows only its own death.)
var _tradePartnersGhost = $.tradePartners;
$.tradePartners = function() {
    if ($.isGhostMe()) return [];
    return _tradePartnersGhost().filter(function(p) { return !$.isDead(p.id); });
};

// The bags a trade here changed go to the host right away (its save).
$.reportTradeBags = function(ids) {
    if (!$.conn) return;
    ids.forEach(function(id) {
        var v = id === 'host' ? null : $.clientById(id);
        if (v && v._sub) $.sendSubMe(v, false);
    });
    if (ids.indexOf('host') >= 0) $.sendRoamMe(false);
};

var _doTradeSub = $.doTrade;
$.doTrade = function(fromId, msg) {
    _doTradeSub(fromId, msg);
    if ($.subHosting()) $.reportTradeBags([fromId, msg.to]);
};

var _tradeAckReport = $.hostHandlers.tradeAck;
$.hostHandlers.tradeAck = function(conn, msg) {
    _tradeAckReport(conn, msg);
    if (conn && conn._sub && $.subHosting()) $.reportTradeBags([conn.guestId]);
};

// 'host' in the map code is this PC's player.
var _playerLabelSub = $.playerLabel;
$.playerLabel = function(id) {
    if ($.isGuest() && (id === $.myId || (id === 'host' && $.subHosting()))) {
        var a = $gameActors.actor($.myActorId);
        return a ? a.name() : $.myName;
    }
    return _playerLabelSub(id);
};

// A guest here facing this PC's player: it knows that player by its id
// ('host' is the real host on its PC).
var _offerInteractSub = $.offerInteract;
$.offerInteract = function(fromId, targetId) {
    if (targetId !== 'host' || fromId === 'host' || !$.subHosting()) return _offerInteractSub(fromId, targetId);
    if ($.isDown('host')) return false;
    if ($.requesterBusy(fromId)) return true; // the one asking is in its own event
    if ($gameParty.inBattle() || $gameMap.isEventRunning() || $.puppet) {
        $.sendTo(fromId, { t: 'toast', text: 'Co-op: ' + $.playerLabel($.myId) + ' is busy' });
        return true;
    }
    $.sendTo(fromId, { t: 'pAct', id: $.myId, name: $.playerLabel($.myId) });
    return true;
};

// This PC's player pressing OK at one of its guests (after revive, joining
// and the map's own events, like the host).
var _triggerButtonSubPlayers = Game_Player.prototype.triggerButtonAction;
Game_Player.prototype.triggerButtonAction = function() {
    if (_triggerButtonSubPlayers.call(this)) return true;
    if ($.subHosting() && Input.isTriggered('ok') && !this._fhRemoteId && !$.isDownMe() && !$.puppet) {
        var x = $gameMap.roundXWithDirection(this.x, this.direction());
        var y = $gameMap.roundYWithDirection(this.y, this.direction());
        var target = $.playerAtForHost(x, y, 'host');
        if (target) return $.offerInteract('host', target);
    }
    return false;
};

// Guest -----------------------------------------------------------------------

$.guestHandlers.subJoin = function() {
    if ($.isRoaming() && !$.subHosting()) {
        $.roam.joinSub = $gameMap.mapId();
    } else if ($.pendingRoam) {
        $.joinSubAfterRoam = $.pendingRoam.pos ? $.pendingRoam.pos.m : 0;
    } else if ($.conn) {
        $.conn.send({ t: 'subJoinNo' });
    }
};

var _startRoamSub = $.startRoam;
$.startRoam = function(msg) {
    var join = $.joinSubAfterRoam;
    $.joinSubAfterRoam = 0;
    _startRoamSub(msg);
    if (join && $.roam) $.roam.joinSub = join;
};

$.hostHandlers.subJoinNo = function(conn) {
    conn.subAsked = null;
};

$.guestExtras.push(function() {
    if ($.isRoaming() && $.roam.joinSub && $.roam.joinSub !== $gameMap.mapId()) $.roam.joinSub = 0;
    if ($.isRoaming() && $.roam.joinSub && !$.subHosting() && $.roamIdle()) {
        $.roam.joinSub = false;
        $.sendUnroam({ m: $gameMap.mapId(), x: $gamePlayer.x, y: $gamePlayer.y, d: $gamePlayer.direction() });
    }
});

// A refused trade comes back to a guest running its own map (or about to):
// its bag is its own. The sub-host it gave the item to has given it back.
var _restoresTradeItself = $.restoresTradeItself;
$.restoresTradeItself = function() {
    return $.isRoaming() || !!$.pendingRoam || _restoresTradeItself();
};

$.guestHandlers.tradeBack = function(msg) {
    var data = $.tradeData(msg.k);
    if (!data || !data[msg.id]) return;
    if (!$.restoresTradeItself()) {
        // back in a shared game meanwhile: the copy there gets it
        if ($.conn) $.conn.send({ t: 'tradeAck', k: msg.k, id: msg.id, n: msg.n, restored: false, by: msg.by || null, back: true });
        return;
    }
    $gameParty.gainItem(data[msg.id], Math.max(1, Number(msg.n) || 1));
    if ($.conn) $.conn.send({ t: 'tradeAck', k: msg.k, id: msg.id, n: msg.n, restored: true, by: msg.by || null, back: true });
    $.toast('Co-op: the trade did not go through');
    var scene = SceneManager._scene;
    if (scene && scene._items && scene._items.refresh) scene._items.refresh();
};

var _leaveAsGuestSub = $.leaveAsGuest;
$.leaveAsGuest = function(message) {
    $.clients = [];
    $.subAsks = {};
    $.subTradeFails = {};
    $.owned = {};
    $.ownedQueue = {};
    $.battles = {};
    _leaveAsGuestSub(message);
};

//=============================================================================
// Ending A: the museum bunker waits for the host
//=============================================================================
// The ladder down from the museum ballroom (Map117 EV043) leads to the bunker
// tunnels of ending A. Guests may go down only after the host has.

$.BUNKER_DOOR = { map: 117, ev: 43 };
$.BUNKER_TEXT = 'A strange chill runs through you... your feet will not move forward.';

$.bunkerMaps = function() {
    if ($._bunkerMaps) return $._bunkerMaps;
    var set = { 126: true, 125: true };
    var grew = true;
    while (grew) {
        grew = false;
        ($dataMapInfos || []).forEach(function(info) {
            if (info && set[info.parentId] && !set[info.id]) {
                set[info.id] = true;
                grew = true;
            }
        });
    }
    return ($._bunkerMaps = set);
};

$.hostInBunker = function() {
    var hostMap = $.isHost() ? $gameMap.mapId() : $.hostMapId;
    return !!$.bunkerMaps()[hostMap];
};

$.isBunkerDoor = function(ev) {
    return $gameMap.mapId() === $.BUNKER_DOOR.map && ev.eventId() === $.BUNKER_DOOR.ev;
};

$.fieldGab = function(text) {
    text = $.ko(text); // (the Korean patch: in Korean)
    var scene = SceneManager._scene;
    if (scene && scene._gabWindow) {
        try {
            var interp = new Game_Interpreter();
            interp.pluginCommand('GabText', String(text).split(' '));
            interp.pluginCommand('ShowGab', []);
            return;
        } catch (e) {}
    }
    $.toast(text);
};

$.guestHandlers.gab = function(msg) {
    $.fieldGab(msg.text);
};

// a guest on the host's map (or on a sub-host's map)
$.eventStartHooks.push(function(conn, ev) {
    if (!$.isBunkerDoor(ev) || $.hostInBunker()) return false;
    // bumping the ladder repeats every frame: tell once a second
    if (conn.bunkerToldAt === undefined || Graphics.frameCount - conn.bunkerToldAt > 60) {
        conn.bunkerToldAt = Graphics.frameCount;
        $.sendTo(conn.guestId, { t: 'gab', text: $.BUNKER_TEXT });
    }
    return true;
});

// a guest running the museum on its own PC
var _startBunker = Game_Event.prototype.start;
Game_Event.prototype.start = function() {
    if ($.isGuest() && $.isRoaming() && $.isBunkerDoor(this) && !$.hostInBunker() && !$gamePlayer._fhRemoteId) {
        if ($._bunkerToldAt === undefined || Graphics.frameCount - $._bunkerToldAt > 60) {
            $._bunkerToldAt = Graphics.frameCount;
            $.fieldGab($.BUNKER_TEXT);
        }
        return;
    }
    _startBunker.call(this);
};

// The vault door (Map125 EV31, a parallel page on S4463 "the uplinks are on"):
// it turns S4441-4458 vault_door1-18 on in one go, then its self switch A.
// A parallel page's own switches stay on its PC (mapParallelSwitches), its
// self switch is shared: opened on a guest's own PC (the host on the ladder
// map), the door stayed shut on every other PC for good (EV31 already on page
// 1 there; the doors' pages need S4455). These are the open door: shared.
$.PARALLEL_SHARED_SWITCHES = {};
for (var vaultSw = 4441; vaultSw <= 4458; vaultSw++) $.PARALLEL_SHARED_SWITCHES[vaultSw] = true;
// The same for every switch a map's parallel page turns on plainly that
// nothing in the game ever turns off (maps, common events, troops, scripts):
// story, not a per-frame flag. Seen on one PC only, they never came to the
// world: the needles scene's Tanaka1 / SALARYMAN_DEAD (Map024 EV213), Caligura
// after the sewer fight (caligura1, Map078 EV293), the museum's shutters and
// alarm (Map084 EV134), the doorways (Map030 EV80), the walls of Tunnel 7 and
// 6, the bellends and moonscorched set loose, kaiser_gone (0.5.11 review).
// Not: INTRO (213, 295), burn (1880, the burning player's own), a skill
// (1990), day_text (3082), the hollow tower's (4187, 4193: its winner's PC).
// tools/one_way_parallel_switches.js lists them from the game data.
[53, [414, 416], [421, 427], [429, 430], 432, 502, [524, 529], [531, 535], [542, 546], [642, 647], 649, 719,
    1118, [1484, 1485], [1639, 1640], [1655, 1656], [1674, 1678], 1715, 1761, [1769, 1770], [1776, 1780],
    [1789, 1790], 2577, [2661, 2667], 2685, 3016, [3018, 3028], 3083, [3085, 3086], [3096, 3099], 3306, 3325,
    [3382, 3392], 3401, 3465, 3549, 3879, 3891, 3898, 3906, 3926, 3931, 3939, 3958, 3965, 3984, 3992,
    [4234, 4241], 4258, [4260, 4265], [4267, 4271], [4279, 4280], 4289, [4300, 4301], 4307, [4310, 4313], 4345,
    4353, [4355, 4356], [4421, 4422], 4424, 4426, [4557, 4564], [4626, 4633], [4641, 4642], [4644, 4645],
    [4701, 4704], 4706, [4723, 4726], 4728, [4730, 4733], 4735, 4744, 4775, 4799, 4935, 4944, 4955, 4960, 4971,
    4976].forEach(function(r) {
    for (var s = r[0] || r; s <= (r[1] || r); s++) $.PARALLEL_SHARED_SWITCHES[s] = true;
});

var _sharedParallelSwitchVault = $.sharedParallelSwitch;
$.sharedParallelSwitch = function(id, before, now) {
    if ($.PARALLEL_SHARED_SWITCHES[id]) return !before && !!now;
    return _sharedParallelSwitchVault(id, before, now);
};

// The flamethrower corridors (Map127, Map134): a trooper aims at one of three
// lanes (V865); stepping on a lane's tiles writes the lane to V867
// flame_danger (touch events); a parallel event (EV198) sets V868 burn when
// they match, and the burn event (EV221 page 0 on V868 >= 1, page 1 on >= 2)
// burns whoever runs it: its SELECT's sprite, flames on the player, the legs,
// GAMEOVER. In co-op the PC running the map burned (the host) when a guest
// stepped in. The burn pages now run as the event of the one who last wrote
// V867 there (its context: its character, its down).
$.FLAME_DANGER_VAR = 867;
$.FLAME_BURN_VAR = 868;
$.flameStepper = null; // { id, m } who stepped on a lane last, on which map
$.flameBurnSeq = 0;    // one per burn (V868 from below 1 to 1 or more)

var _varSetFlame = Game_Variables.prototype.setValue;
Game_Variables.prototype.setValue = function(id, value) {
    var before = this._data[id] || 0;
    _varSetFlame.call(this, id, value);
    if (this !== $gameVariables || !$.role || !$gameMap) return;
    if (id === $.FLAME_DANGER_VAR && !$.noSyncWrite) {
        $.flameStepper = { id: $.ctx ? $.ctx.guestId : $.myPlayerId(), m: $gameMap.mapId() };
    }
    if (id === $.FLAME_BURN_VAR && before < 1 && this._data[id] >= 1) $.flameBurnSeq++;
};

$.isBurnPage = function(page) {
    var c = page && page.conditions;
    return !!c && page.trigger === 4 && c.variableValid && c.variableId === $.FLAME_BURN_VAR;
};

var _updateParallelFlame = Game_Event.prototype.updateParallel;
Game_Event.prototype.updateParallel = function() {
    var s = $.flameStepper;
    var page = s && this._interpreter && !this._interpreter.isRunning() ? this.page() : null;
    if (!page || !$.isBurnPage(page) || s.m !== $gameMap.mapId() || s.id === $.myPlayerId() ||
            !($.isHost() || $.subHosting())) {
        return _updateParallelFlame.call(this);
    }
    var key = $.flameBurnSeq + ':' + this._pageIndex;
    if (this._fhBurnFor === key) return; // (that page runs, or ran, as its event)
    var conn = $.clientById(s.id);
    if (!conn || !conn.actorId) {
        // the one who stepped in is gone: nobody burns, the lane is clear again
        $.dlog('flame: the one who stepped in is gone - no burn');
        $.flameStepper = null;
        $gameVariables.setValue($.FLAME_DANGER_VAR, 0);
        $gameVariables.setValue($.FLAME_BURN_VAR, 0);
        return;
    }
    if ($.owned[conn.guestId]) return; // in another event: once it ends
    this._fhBurnFor = key;
    $.dlog('flame: the burn goes to', conn.name, 'map', $gameMap.mapId(), 'ev' + this.eventId(), 'p' + this._pageIndex);
    $.runOwned(conn, page.list, this);
};

// The way down to Kaiser: Map137's exits (EV1/15/73/74/76) turn SW202 / SW410
// on (no run, no bow or gun) and black the screen; Map139 EV37 page 1 (the
// hall's arrival, autorun) turns them off again. Map139's exit (EV32) turns
// them on and hides the player; Map136 EV2 page 0 shows it and turns them
// off. Both scenes end on their self switch A, a world value: the first one
// in runs it, everyone after came in unable to run or shoot through Kaiser and
// Logic (a late host also unseen). One who comes onto that map once its scene
// ran gets the scene's end: SW202 / SW410 off, shown again. Every PC does it
// for its own player; the PC running the map also for the players it runs.
$.ARRIVAL_SCENES = { 139: 37, 136: 2 }; // map -> its arrival event (ends on self switch A)
$.ARRIVAL_OWN_SWITCHES = [202, 410];

$.arrivalSceneRan = function(mapId) {
    var e = $.ARRIVAL_SCENES[mapId];
    return !!e && !!$gameSelfSwitches.value([mapId, e, 'A']);
};

$.arrivalRestore = function(key) {
    $.ARRIVAL_OWN_SWITCHES.forEach(function(id) { $.setOwnSwitchValue(key, id, false); });
    if (key === 'self' && $gamePlayer) $gamePlayer.setTransparent(false);
    $.dlog('arrival: map', $gameMap.mapId(), 'scene ran before -', key === 'self' ? 'this player' : $.playerLabel(key),
        'can run and shoot again');
};

// This PC's player: once, as it comes in (the first one in runs the scene
// itself). A player this PC runs: once the scene ran and it is in no event of
// its own (it may have come in with the one who ran it).
$.arrivalCheck = function() {
    if (!$.role || !$gameMap || !$gamePlayer || $gamePlayer.isTransferring()) return;
    var m = $gameMap.mapId();
    if ($.arrivedOn !== m) {
        $.arrivedOn = m;
        if ($.arrivalSceneRan(m) && !$.isDownMe() && !$gamePlayer._fhGhost) $.arrivalRestore('self');
    }
    if (!$.ARRIVAL_SCENES[m] || !($.isHost() || $.subHosting())) return;
    $.clients.forEach(function(c) {
        if (!c.guestId || c.roam) return;
        if ($.playerMapOf(c.guestId) !== m) {
            c._fhArrivedOn = 0;
            return;
        }
        if (c._fhArrivedOn === m || !$.arrivalSceneRan(m) || $.owned[c.guestId]) return;
        c._fhArrivedOn = m;
        $.arrivalRestore(c.guestId);
    });
};

var _sceneMapUpdateArrival = Scene_Map.prototype.update;
Scene_Map.prototype.update = function() {
    _sceneMapUpdateArrival.call(this);
    if (!$gamePlayer._fhRemoteId) $.arrivalCheck();
};

//=============================================================================
// A fight on a map a guest runs: the host knows it, so others can join it
// and the host's copy of that map holds the enemy (no second fight or talk)
//=============================================================================

$.roamFight = null; // guest: { m, e, troopId, bid } while its own fight lasts
$.ownFightLost = false; // guest: its own fight ended with it lying dead (others won)

// A fight on this PC's own map: a roaming guest's, or in the tutorial (each
// player in its own copy of the world) the workshop fight.
$.ownFightHere = function(interp) {
    if (!$.isGuest() || interp._fhOwner || $gameParty.inBattle() || !$.conn) return false;
    if ($.isRoaming()) return true;
    return !!$.solo && $.tutorialJoinMap();
};

var _command301_roam = Game_Interpreter.prototype.command301;
Game_Interpreter.prototype.command301 = function() {
    var mine = $.ownFightHere(this);
    var troopId = mine ? $.troopIdOf(this) : 0;
    var result = _command301_roam.call(this);
    if (mine && $dataTroops[troopId] && !$.roamFight) {
        var n = $.roamFightSeq = ($.roamFightSeq || 0) + 1;
        $.roamFight = { m: $gameMap.mapId(), e: this._eventId, troopId: troopId, n: n };
        $.authBattle = { bid: 0, owner: $.myId, joiners: [], troopId: troopId };
        $.conn.send({ t: 'roamFight', m: $.roamFight.m, e: $.roamFight.e, troopId: troopId, n: n });
    }
    return result;
};

$.guestHandlers.roamFightId = function(msg) {
    var rf = $.roamFight;
    if (!rf || rf.n !== msg.n || !$.authBattle || $.authBattle.owner !== $.myId || $.authBattle.bid) {
        // that fight is already over here: the host lets go of it
        if ($.conn) $.conn.send({ t: 'roamFightEnd', bid: msg.bid, joiners: [] });
        return;
    }
    $.authBattle.bid = msg.bid;
    rf.bid = msg.bid;
    // the players here (a sub-host's guests) join it on this PC's map
    $.battles[msg.bid] = { bid: msg.bid, owner: $.myId, troopId: rf.troopId, eventId: rf.e, mapId: rf.m, joiners: [] };
    if (rf.m === $gameMap.mapId()) $.freezeEvent(rf.e, msg.bid);
};

// The end of this PC's own fight: the joiners are let go, the host is told.
$.finishRoamFight = function(result) {
    var rf = $.roamFight;
    if (!rf || !$.isGuest()) return;
    $.roamFight = null;
    var ab = $.authBattle;
    var joiners = (ab && ab.joiners || []).map(function(id) {
        var a = $.joinerActor(id);
        return a ? { id: id, actor: $.actorJson(a) } : null;
    }).filter(Boolean);
    if (ab && ab.owner === $.myId) $.endAuthBattle(result);
    // down while the others won: the defeat comes on the map (updateBattleEnd
    // goes to the game over, or the check below)
    if ($.ownerDownAfterBattle) $.ownFightLost = true;
    $.ownerDownAfterBattle = false;
    var b = rf.bid ? $.battles[rf.bid] : null;
    if (b) {
        delete $.battles[rf.bid];
        $.unfreezeBattle(b);
    }
    // this PC's own guests (sub-host) have their characters here: send them
    joiners.forEach(function(j) {
        var v = $.clientById(j.id);
        if (!v || !v._sub) return;
        v.inBattle = 0;
        v._lastMeKey = null;
        $.pushMe(v);
    });
    if ($.conn && rf.bid) $.conn.send({ t: 'roamFightEnd', bid: rf.bid, joiners: joiners, result: result });
};

var _endBattle_roam = BattleManager.endBattle;
BattleManager.endBattle = function(result) {
    _endBattle_roam.call(this, result);
    $.finishRoamFight(result);
};

// Down in its own fight: the joiners fight on, the owner lies there until it
// ends. Nobody left: the fight ends for the joiners too before the defeat.
var _handleGameOverOwn = $.handleGameOver;
$.handleGameOver = function() {
    var ab = $.authBattle;
    var ownFight = $.isGuest() ? !!$.roamFight && !!ab && ab.owner === $.myId
        : $.isHost() && !$.sessionActive() && !!ab && ab.owner === 'host'; // the host in the tutorial
    if (!ownFight) $.ownFightLost = false; // the defeat after the fight is this one
    if (ownFight && $gameParty.inBattle() && ab.joiners.length) {
        if ($.joinersAlive()) {
            ab.ownerDown = true;
            var own = $gameActors.actor($.isHost() ? $.hostActorId() : $.myActorId);
            ab.ownerDownDead = !!own && own.isDead();
            return true;
        }
        if ($.isGuest()) {
            $.finishRoamFight(2);
        } else {
            $.endAuthBattle(2);
            $.finishHostBattle(2);
        }
    } else if (ownFight && $.isGuest()) {
        $.finishRoamFight(2);
    }
    return _handleGameOverOwn();
};

$.guestExtras.push(function() {
    if (!$.ownFightLost || $gameParty.inBattle() || SceneManager.isSceneChanging()) return;
    $.ownFightLost = false;
    // the game over (even a scripted one) came while the others fought on
    if ($.isRoaming()) {
        if (!$.myState) $.roamDefeated();
    } else if ($.solo) {
        SceneManager.goto(Scene_Gameover);
    }
});

$.hostHandlers.roamFight = function(conn, msg) {
    // the tutorial: a fight in that guest's own copy of the world
    var solo = !!conn.solo && $.TUTORIAL_JOIN_MAPS.indexOf(msg.m) >= 0 && !!conn.lastPos && conn.lastPos.m === msg.m;
    if (!conn.roam && !conn.subOf && !solo) return;
    var bid = $.newBid();
    $.battles[bid] = { bid: bid, owner: conn.guestId, troopId: msg.troopId, eventId: msg.e, mapId: msg.m, joiners: [],
        ownWorld: true, soloWorld: solo };
    conn.inBattle = bid;
    if (msg.m === $gameMap.mapId() && !solo) $.freezeEvent(msg.e, bid);
    $.dlog('fight on a guest map', conn.name, 'map', msg.m, 'ev' + msg.e, 'troop', msg.troopId, solo ? '(tutorial)' : '');
    conn.send({ t: 'roamFightId', bid: bid, n: msg.n, e: msg.e, m: msg.m });
};

$.hostHandlers.roamFightEnd = function(conn, msg) {
    var b = $.battles[msg.bid];
    if (!b || b.owner !== conn.guestId) return;
    delete $.battles[msg.bid];
    conn.inBattle = 0;
    $.unfreezeBattle(b);
    $.applyJoinerResults(b, msg.joiners || []);
};

// The host comes onto a map where a guest fights: hold that enemy here too.
$.holdGuestFights = function() {
    var mapId = $gameMap.mapId();
    Object.keys($.battles).forEach(function(k) {
        var b = $.battles[k];
        if (b.mapId !== mapId || b.owner === 'host' || !b.eventId || b.soloWorld) return;
        var ev = $gameMap.event(b.eventId);
        if (ev && ev._fhBattle !== b.bid) ev._fhBattle = b.bid;
    });
};

var _hostSync_fights = $.hostSync;
$.hostSync = function() {
    _hostSync_fights();
    $.holdGuestFights();
};

//=============================================================================
// Joining fights on a map a guest runs for others; reviving there
//=============================================================================
// The host keeps the list of every fight. A sub-host's own fight is in it
// (roamFight) and so are the fights of its guests (subFight, ids made of the
// sub-host's id so they never meet the host's). OK on a frozen enemy or on a
// fighting player there (the sub-host's own OK, or its guest's passed on)
// asks the host (joinFight), which joins as everywhere else. The sub-host's
// guests' characters live on the sub-host: it gets them back after a fight
// and sends them on. Reviving there goes through the host too (subRevive).

// Host -----------------------------------------------------------------------

var _newBidSub = $.newBid;
$.newBid = function() {
    if ($.isHost()) return _newBidSub();
    return $.myId + ':' + ($.nextBid++);
};

$.fightOf = function(owner) {
    var found = null;
    Object.keys($.battles).forEach(function(k) {
        var b = $.battles[k];
        if (!found && owner && b.owner === owner && !b.pvp) found = b;
    });
    return found;
};

// { id: the one who joins (the sender or its guest), bid or owner, actor }
$.hostHandlers.joinFight = function(conn, msg) {
    var c = $.clientById(msg.id);
    if (conn.subOf || !c || !c.actorId || (c !== conn && c.subOf !== conn.guestId)) return;
    var b = msg.bid ? $.battles[msg.bid] : $.fightOf(msg.owner);
    var m = conn.lastPos && conn.lastPos.m;
    if (!b || !m || b.mapId !== m) return; // only a fight on the asking PC's map
    // the host's copy of a player running its own map (or a sub-host's guest) is older
    var actor = $.parseActor(msg.actor);
    if (actor && actor._actorId === c.actorId && (c.roam || c.subOf || c.solo)) $gameActors._data[c.actorId] = actor;
    $.requestJoin(c.guestId, b.bid);
};

$.hostHandlers.subFight = function(conn, msg) {
    var c = $.clientById(msg.owner);
    var bid = msg.bid;
    if (!conn.roam || !c || c.subOf !== conn.guestId || !conn.lastPos || conn.lastPos.m !== msg.m) return;
    if (typeof bid !== 'string' || bid.indexOf(conn.guestId + ':') !== 0 || $.battles[bid]) return;
    $.battles[bid] = { bid: bid, owner: c.guestId, troopId: msg.troopId, eventId: msg.e, mapId: msg.m, joiners: [],
        ownWorld: true, sub: conn.guestId };
    c.inBattle = bid;
    $.dlog('fight on a sub-host map', c.name, 'map', msg.m, 'ev' + msg.e, 'troop', msg.troopId);
};

$.hostHandlers.subFightEnd = function(conn, msg) {
    var b = $.battles[msg.bid];
    if (!b || b.sub !== conn.guestId) return;
    delete $.battles[msg.bid];
    var c = $.clientById(b.owner);
    if (c) c.inBattle = 0;
    $.applyJoinerResults(b, msg.joiners || []);
};

$.hostHandlers.subRevive = function(conn, msg) {
    var here = function(id) {
        var c = $.clientById(id);
        return !!c && (c === conn || c.subOf === conn.guestId);
    };
    if (!conn.roam || msg.id === msg.by || !here(msg.id) || !here(msg.by) || $.isDown(msg.by)) return;
    $.reviveOrAsk(msg.id, msg.by);
};

// A sub-host's guest that joined or left a fight is busy or free there too.
var _requestJoinRoam = $.requestJoin;
$.requestJoin = function(id, bid) {
    if (!$.isHost()) {
        if ($.isGuest()) $.askJoin(id, { bid: bid });
        return;
    }
    _requestJoinRoam(id, bid);
    var b = $.battles[bid];
    var c = id === 'host' ? null : $.clientById(id);
    if (b && c && c.subOf && b.joiners.indexOf(id) >= 0) $.sendTo(c.subOf, { t: 'subBusy', id: id, bid: b.bid });
};

var _applyJoinerResultsSub = $.applyJoinerResults;
$.applyJoinerResults = function(b, list) {
    if (!$.isHost()) {
        // this PC's own character came with the fight's end (bEnd)
        return _applyJoinerResultsSub(b, list.filter(function(j) { return j.id !== $.myId; }));
    }
    var was = {};
    var fell = [];
    list = list.map(function(j) {
        var c = $.clientById(j.id);
        if (!c || !(c.roam || c.solo)) return j;
        // its own PC has the newer copy (it may be up again already): only the fall counts here
        var a = $.parseActor(j.actor);
        if (a && a.isDead()) fell.push(j.id);
        // ...and a death for good in it (beheaded): no down for a moment first
        var doom = c.roam && a && $.doomOf ? $.doomOf(a) : '';
        if (doom && $.markDoom) $.markDoom($.actorOfPlayer(j.id), doom);
        return { id: j.id, actor: null };
    });
    list.map(function(j) { return j.id; }).concat(b.joiners || []).forEach(function(id) {
        var c = $.clientById(id);
        if (c && c.subOf && c.inBattle) was[id] = c.inBattle;
    });
    _applyJoinerResultsSub(b, list);
    fell.forEach(function(id) { $.onPlayerDefeated(id); });
    Object.keys(was).forEach(function(id) {
        var c = $.clientById(id);
        if (!c || !c.subOf || c.inBattle) return;
        var j = list.filter(function(e) { return e.id === id; })[0];
        $.sendTo(c.subOf, { t: 'subBusy', id: id, bid: 0, was: was[id], actor: j && j.actor || null });
    });
};

// A sub-host's guest's fight ended (its result went on to the sub-host).
$.subFightEndSeen = function(conn, msg) {
    var b = $.battles[msg.bid];
    if (b && b.sub === conn.subOf && b.owner === conn.guestId) b.endSeen = msg.joiners || [];
};

// The sub-host left: fights of its guests that ended are closed here; the
// others go on, and their end comes to the host itself (the guest roams now).
var _onGuestClosedSubFights = $.onGuestClosed;
$.onGuestClosed = function(conn) {
    _onGuestClosedSubFights(conn);
    if (!$.isHost() || !conn.guestId) return;
    Object.keys($.battles).forEach(function(k) {
        var b = $.battles[k];
        if (b.sub !== conn.guestId) return;
        if (!b.endSeen) {
            delete b.sub;
            return;
        }
        delete $.battles[k];
        var c = $.clientById(b.owner);
        if (c) c.inBattle = 0;
        b.joiners.forEach(function(id) { $.bSend(id, { t: 'bEnd', bid: b.bid, r: 1 }); });
        $.applyJoinerResults(b, b.endSeen);
    });
};

// Tutorial players run their own world: no 'me' from the host's old copy, no
// down (dying there is a retry on their own PC).
var _pushMeSolo = $.pushMe;
$.pushMe = function(conn) {
    if (conn && conn.solo && $.isHost()) return;
    _pushMeSolo(conn);
};

var _onPlayerDefeatedSolo = $.onPlayerDefeated;
$.onPlayerDefeated = function(id) {
    var c = $.isHost() && id !== 'host' ? $.clientById(id) : null;
    if (c && c.solo) return;
    _onPlayerDefeatedSolo(id);
};

// Guest (running its own map) -----------------------------------------------

// Join a fight through the host: { bid } or { owner }.
$.lastAsk = null; // { key, at }: bumping an enemy asks every frame
$.askJoin = function(id, target) {
    if (!$.conn) return;
    var mine = id === $.myId;
    var v = mine ? null : $.clientById(id);
    if (!mine && (!v || !v._sub)) return;
    var key = id + ':' + (target.bid || target.owner);
    if ($.lastAsk && $.lastAsk.key === key && Graphics.frameCount - $.lastAsk.at < 30) return;
    $.lastAsk = { key: key, at: Graphics.frameCount };
    var busy = mine ? $gameParty.inBattle() || $gameMap.isEventRunning() || !!$.puppet : $.isBusy(v);
    if (busy) {
        var text = 'Co-op: cannot join - you are busy';
        if (mine) $.toast(text); else v.send({ t: 'toast', text: text });
        return;
    }
    var actor = $gameActors.actor(mine ? $.myActorId : v.actorId);
    $.conn.send({ t: 'joinFight', id: id, bid: target.bid || 0, owner: target.owner || null, actor: $.actorJson(actor) });
};

// Items a joiner uses or gets in a fight on this PC: this PC's own bag and
// its guests' bags are here, not on the host.
$.localJoinerBag = function(jid) {
    if ($.isHost() || !$.subHosting()) return null;
    if (jid === $.myId) return 'host'; // 'host' = this PC in the map code
    var v = $.clientById(jid);
    return v && v._sub ? jid : null;
};

var _joinerUsedItemSub = $.joinerUsedItem;
$.joinerUsedItem = function(jid, itemId) {
    var local = $.localJoinerBag(jid);
    if (local) $.hostHandlers.bConsume(null, { jid: local, id: itemId }); else _joinerUsedItemSub(jid, itemId);
};

var _joinerGainedItemSub = $.joinerGainedItem;
$.joinerGainedItem = function(jid, itemId, n, kind) {
    var local = $.localJoinerBag(jid);
    if (local) $.hostHandlers.bGain(null, { jid: local, id: itemId, n: n, k: kind || 'i' });
    else _joinerGainedItemSub(jid, itemId, n, kind);
};

// A fight of a guest of this PC: the host lists it (joiners come through it).
var _fhDelegateBattleSub = Game_Interpreter.prototype.fhDelegateBattle;
Game_Interpreter.prototype.fhDelegateBattle = function() {
    var result = _fhDelegateBattleSub.call(this);
    var b = !$.isHost() && this._fhBattleWait ? $.battles[this._fhBattleWait] : null;
    if (b && $.conn) {
        b.ownWorld = true;
        $.conn.send({ t: 'subFight', bid: b.bid, owner: b.owner, troopId: b.troopId, e: b.eventId, m: b.mapId });
    }
    return result;
};

var _battleEndSub = $.hostHandlers.battleEnd;
$.hostHandlers.battleEnd = function(conn, msg) {
    var b = $.isHost() ? null : $.battles[msg.bid];
    _battleEndSub(conn, msg);
    if (b && b.owner === conn.guestId && !$.battles[msg.bid] && $.conn) {
        $.conn.send({ t: 'subFightEnd', bid: msg.bid, joiners: msg.joiners || [] });
    }
};

$.guestHandlers.subBusy = function(msg) {
    var v = $.clientById(msg.id);
    if (!v || !v._sub) return;
    if (msg.bid) {
        v.inBattle = msg.bid;
    } else if (v.inBattle === msg.was) { // not a fight it started meanwhile
        v.inBattle = 0;
        var actor = $.parseActor(msg.actor); // as that fight left it
        if (actor && actor._actorId === v.actorId) $gameActors._data[v.actorId] = actor;
        v._lastMeKey = null;
        $.pushMe(v); // its character here (a fight it left)
    }
};

// The end of a joined fight: a PC running its own world keeps the character
// as the fight left it; dead, it is down (roaming) or tries again (tutorial).
var _bEndOwn = $.guestHandlers.bEnd;
$.guestHandlers.bEnd = function(msg) {
    var mine = !!$.puppet && msg.bid === $.puppet.bid && !$.puppet.pvp && !$.pvpBattle; // not a duel
    _bEndOwn(msg);
    if (!mine || !$.isGuest() || !($.isRoaming() || $.solo)) return;
    var actor = $.parseActor(msg.me);
    if (actor && actor._actorId === $.myActorId) $gameActors._data[$.myActorId] = actor;
    var own = $gameActors.actor($.myActorId);
    if (!own || !own.isDead()) return;
    if ($.isRoaming()) $.roamDefeated(); else SceneManager.goto(Scene_Gameover);
};

// Down players here: the host's states ($.pstateOf), this PC's player too.
var _downPlayerAtSub = $.downPlayerAt;
$.downPlayerAt = function(x, y) {
    if ($.isHost() || !$.subHosting()) return _downPlayerAtSub(x, y);
    var hit = null;
    if ($.pstateOf[$.myId] === 'down' && $gamePlayer.pos(x, y)) hit = $.myId;
    Object.keys($.remotes).forEach(function(id) {
        if (!hit && $.pstateOf[id] === 'down' && $.remotes[id].pos(x, y)) hit = id;
    });
    return hit;
};

var _reviveSub = $.revive;
$.revive = function(id, byId) {
    if ($.isHost()) return _reviveSub(id, byId);
    if ($.subHosting() && $.conn && $.pstateOf[id] === 'down') $.conn.send({ t: 'subRevive', id: id, by: byId });
};

// A guest of this PC revived: its character here is up again.
var _pstateSubRevive = $.guestHandlers.pstate;
$.guestHandlers.pstate = function(msg) {
    var v = $.isGuest() ? $.clientById(msg.id) : null;
    var revived = !!v && !!v._sub && $.pstateOf[msg.id] === 'down' && !msg.s;
    _pstateSubRevive(msg);
    if (!revived) return;
    var actor = $gameActors.actor(v.actorId);
    if (actor) {
        actor.removeState($.KNOCKOUT);
        actor.setHp(Math.max(actor.hp, Math.round(actor.mhp * $.reviveRate)));
        if ($.restoreDownStates) $.restoreDownStates(actor);
        if ($.standUpImages) $.standUpImages(actor);
    }
    v._lastMeKey = null;
    $.pushMe(v);
};

// This PC's player: OK on a down player, a fight's enemy or the fighting one.
var _triggerButtonOwn = Game_Player.prototype.triggerButtonAction;
Game_Player.prototype.triggerButtonAction = function() {
    if ($.isGuest() && ($.isRoaming() || $.solo) && $.conn && Input.isTriggered('ok') &&
            !this._fhRemoteId && !$.isDownMe() && !$.puppet) {
        var x = $gameMap.roundXWithDirection(this.x, this.direction());
        var y = $gameMap.roundYWithDirection(this.y, this.direction());
        var down = $.downPlayerAt(x, y);
        if (down && down !== $.myId) {
            $.revive(down, $.myId);
            return true;
        }
        var bid = $.battleAtTile(x, y);
        if (bid) {
            $.requestJoin($.myId, bid);
            return true;
        }
        // tutorial: only the host knows whether that player fights
        var other = $.solo && $.tutorialJoinMap() ? $.remotePlayerAt(x, y) : null;
        if (other) $.askJoin($.myId, { owner: other });
    }
    return _triggerButtonOwn.call(this);
};

var _startOwnFightJoin = Game_Event.prototype.start;
Game_Event.prototype.start = function() {
    if (this._fhBattle && $.isGuest() && $.isRoaming() && !$gamePlayer._fhRemoteId) {
        $.requestJoin($.myId, this._fhBattle);
        return;
    }
    _startOwnFightJoin.call(this);
};

var _leaveAsGuestFights = $.leaveAsGuest;
$.leaveAsGuest = function(message) {
    $.roamFight = null;
    $.ownFightLost = false;
    _leaveAsGuestFights(message);
};

//=============================================================================
// Tutorial: the workshop fight can be joined
//=============================================================================
// Everyone plays the tutorial on its own PC, so every player has its own
// janitor. A player fighting it (the host, or a guest: roamFight above) is in
// the host's list; another player on that map joins with OK on them.

$.TUTORIAL_JOIN_MAPS = [17, 149]; // Workshop, Workshop2 (EV18 janitor1, troop 4)

$.tutorialJoinMap = function() {
    return !$.tutorialOver() && $.TUTORIAL_JOIN_MAPS.indexOf($gameMap.mapId()) >= 0;
};

var _hostFightJoinable = $.hostFightJoinable;
$.hostFightJoinable = function() {
    if (_hostFightJoinable()) return true;
    return $.tutorialJoinMap() && $.clients.some(function(c) { return c.solo && c.actorId; });
};

// The host: OK on a tutorial player who fights.
var _triggerButtonTutorial = Game_Player.prototype.triggerButtonAction;
Game_Player.prototype.triggerButtonAction = function() {
    if ($.isHost() && !$.sessionActive() && $.tutorialJoinMap() && Input.isTriggered('ok') && !this._fhRemoteId) {
        var x = $gameMap.roundXWithDirection(this.x, this.direction());
        var y = $gameMap.roundYWithDirection(this.y, this.direction());
        var bid = $.battleAtTile(x, y);
        if (bid) {
            $.requestJoin('host', bid);
            return true;
        }
    }
    return _triggerButtonTutorial.call(this);
};


//=============================================================================
// Snapshots wait for a whole world
//=============================================================================
// A guest asking for a snapshot while the host loads a save (or between two
// maps) got the loaded world on the old map's data. It is sent once the map
// is up; the full snapshot then covers the guests on the host's map.

$.snapLater = []; // host: connections that asked meanwhile

var _sendSnapshotReady = $.sendSnapshot;
$.sendSnapshot = function(conn) {
    if ($.isHost() && !$.worldReady()) {
        if (!conn) {
            $.snapshotQueued = true; // the map scene's start sends it
        } else {
            (Array.isArray(conn) ? conn : [conn]).forEach(function(c) {
                if ($.snapLater.indexOf(c) < 0) $.snapLater.push(c);
            });
        }
        $.dlog('snapshot waits for the map', $gameMap ? $gameMap.mapId() : 0, 'data', $.dataMapId);
        return;
    }
    if (!conn) {
        // the full snapshot reaches the guests on the host's map
        $.snapLater = $.snapLater.filter(function(c) { return c.roam || c.roamPending || c.subOf || c.solo; });
    }
    return _sendSnapshotReady.apply(this, arguments);
};

var _hostSyncReady = $.hostSync;
$.hostSync = function() {
    _hostSyncReady();
    if (!$.snapLater.length || !$.worldReady()) return;
    var list = $.snapLater;
    $.snapLater = [];
    list.forEach(function(c) {
        if ($.clients.indexOf(c) < 0 || c.solo) return; // a tutorial player stays in its own world
        var p = c._placeAt;
        if (p && p.m !== $gameMap.mapId()) {
            // it walked onto the map the host has left meanwhile: it runs that map
            c._placeAt = null;
            c.lastPos = Object.assign({}, c.lastPos || {}, p, { id: c.guestId });
            var entry = $.owned[c.guestId];
            var json = entry ? JsonEx.stringify(entry.interp) : null;
            if (entry) $.finishOwned(c.guestId);
            if (c.inBattle) c.roamPending = { m: p.m };
            else $.sendRoam(c, { pos: p, interp: json });
            return;
        }
        $.sendSnapshot(c);
    });
};

//=============================================================================
// Blood golem: the summoner's own companion, one in the world
//=============================================================================
// Original (data): the Blood golem skills (51, 103, 684, 706, 724, battle
// only) call CE64 (SW200, SW373 on). The troop's "Blood golem" page calls
// CE501: unless SW374 ("already summoned") and if the party has room (CE49
// counts the party into V34, V34 <= 3), Change Party adds actor 10, SW374 on,
// V34 + 1. After the fight CE66 (AFTER BATTLE, after all but 2 of the 1784
// battle commands) turns SW374 off, recovers actor 10 and takes it out of the
// party; CE500 (protagonist dead) takes it out too. So it lives for one fight.
//
// Co-op: it joins the fight of the one who summons it, on the PC that runs
// that fight (a guest's own fight: the guest's PC). The host's fight list
// marks that fight (b.golem): a second summon anywhere is refused before the
// skill is used (no cost, no switches). It takes one of the 4 places, so
// that fight takes 2 joiners at most ($.fightFull). Joiners (a fight run by
// another PC), duels and the tutorial guest cannot summon it. It leaves when
// the fight ends on that PC, when its summoner falls or runs away (the fight
// moves on without it), and its numbers go back to the host's actor 10.
// Nothing is saved: a load drops every fight, and a golem left in a party
// (an old save) is taken out when the next fight starts.

$.golemBid = 0;          // guest: the fight that has the golem (from the host)
$.golemDismissDue = '';  // authority: take it out at the next quiet moment

// SW373 / SW374 belong to the fight on each PC, not to the shared world: a
// guest's fight (or the one it starts with them off) never changes the host's.
[$.GOLEM_CASTING_SWITCH, $.GOLEM_SUMMONED_SWITCH].forEach(function(id) { $.NO_SYNC_SWITCHES[id] = true; });

var _battleEndGolem = $.hostHandlers.battleEnd;
$.hostHandlers.battleEnd = function(conn, msg) {
    if (msg && msg.swd && msg.swd.filter) {
        msg.swd = msg.swd.filter(function(d) {
            return d[0] !== $.GOLEM_CASTING_SWITCH && d[0] !== $.GOLEM_SUMMONED_SWITCH;
        });
    }
    _battleEndGolem(conn, msg);
};

// This PC's fight has it.
$.golemHere = function() {
    return $gameParty.inBattle() && $gameParty._actors.indexOf($.GOLEM_ACTOR) >= 0;
};

// Host: the fight that has it (0: free).
$.golemFight = function() {
    var found = 0;
    Object.keys($.battles).forEach(function(k) {
        if (!found && $.battles[k].golem) found = $.battles[k].bid;
    });
    return found;
};

// Why actor (or this PC's own character) cannot summon it now; '' = it can.
$.golemRefusal = function(actor) {
    if (!$.role) return '';
    var ab = $.authBattle;
    if ($.puppet || (actor && actor._fhJoiner)) return 'The blood golem only answers in your own fight.';
    if ((ab && ab.pvp) || $.pvpBattle) return 'No blood golem in a duel.';
    if ($.isGuest() && ($.solo || !ab)) return 'The blood golem does not answer here.';
    if ($.golemHere()) return ''; // the original says it is summoned already
    var taken = $.isHost() ? $.golemFight() : $.golemBid;
    if (taken && taken !== (ab ? ab.bid : 0)) return 'The blood golem already serves someone else.';
    return '';
};

// Refused: the skill cannot be used (no cost, CE64 never runs).
var _meetsSkillConditionsGolem = Game_BattlerBase.prototype.meetsSkillConditions;
Game_BattlerBase.prototype.meetsSkillConditions = function(skill) {
    if ($.role && $.isGolemSkill(skill) && this.isActor() && $gameParty.inBattle() && $.golemRefusal(this)) {
        return false;
    }
    return _meetsSkillConditionsGolem.call(this, skill);
};

// Choosing it anyway says why.
var _processOkGolem = Window_BattleSkill.prototype.processOk;
Window_BattleSkill.prototype.processOk = function() {
    var item = this.item ? this.item() : null;
    if ($.role && $.isGolemSkill(item) && this.isCurrentItemEnabled && !this.isCurrentItemEnabled()) {
        var why = $.golemRefusal(this._actor);
        if (why) $.battleGab(why, true);
    }
    _processOkGolem.call(this);
};

// CE501 itself, if it became taken meanwhile: nothing changes but SW373.
var _command117Golem = Game_Interpreter.prototype.command117;
Game_Interpreter.prototype.command117 = function() {
    if ($.role && this._params[0] === $.GOLEM_CE && $gameParty.inBattle() && !$.puppet &&
            $gameSwitches.value($.GOLEM_CASTING_SWITCH)) {
        var why = $.golemRefusal(null);
        if (why) {
            $gameSwitches.setValue($.GOLEM_CASTING_SWITCH, false);
            $.battleGab(why);
            return true;
        }
    }
    return _command117Golem.call(this);
};

// CE484 Hesitation_battle (every contestant troop's BATTLE START page, Troop
// 95-111): a contestant in the party who is not the chosen character (its
// SELECT off) is a companion, gets Hesitation (state 180: skips its turns
// until hit, 99%) and says it will not fight one of its own. In co-op the
// fight's PC has only its own player's SELECT on, so another player who
// joined the fight read as a companion and stood there (play test
// 2026-11-05: Daan in the host's fight with Karin, states [180], no turn
// for 20 s). Companions cannot join in co-op, so every contestant in a co-op
// party is a player: not run in a session.
$.HESITATION_CE = 484;
var _command117Hesitation = Game_Interpreter.prototype.command117;
Game_Interpreter.prototype.command117 = function() {
    if (this._params[0] === $.HESITATION_CE && $.role && $.sessionActive()) {
        $.dlog('CE484 Hesitation skipped: the contestants in this party are players');
        return true;
    }
    return _command117Hesitation.call(this);
};

// Change Party for the golem: past the co-op "no companions" rules.
var _command129Golem = Game_Interpreter.prototype.command129;
Game_Interpreter.prototype.command129 = function() {
    var p = this._params;
    if ($.role && p[0] === $.GOLEM_ACTOR) {
        if (p[1] === 0 && $gameParty.inBattle() && !$.puppet) $.summonGolem(!!p[2]);
        // taken out mid-fight (CE500): the fight, the host and the joiners know
        else if (p[1] !== 0 && $gameParty.inBattle() && !$.puppet) $.dismissGolem('');
        else if (p[1] !== 0) $gameParty.removeActor($.GOLEM_ACTOR);
        return true;
    }
    return _command129Golem.call(this);
};

$.summonGolem = function(init) {
    var why = $.golemRefusal(null);
    var golem = $gameActors.actor($.GOLEM_ACTOR);
    if (why || !golem) {
        if (why) $.battleGab(why);
        return false;
    }
    if (init) golem.setup($.GOLEM_ACTOR);
    // whole, as CE66 left it after its last fight (that may have been on another PC)
    golem.recoverAll();
    $gameParty.addActor($.GOLEM_ACTOR);
    var ab = $.authBattle;
    if ($.isHost()) {
        var b = ab ? $.battles[ab.bid] : null;
        if (b) b.golem = true;
    } else if (ab && $.conn) {
        $.conn.send({ t: 'golemClaim', bid: ab.bid });
    }
    $.dlog('blood golem summoned, fight', ab ? ab.bid : '-');
    $.broadcastParty();
    $.refreshBattleStatus();
    return true;
};

// Out of this PC's fight (or party). ended: the fight is over already.
$.dismissGolem = function(text, ended) {
    var id = $.GOLEM_ACTOR;
    if ($gameParty._actors.indexOf(id) < 0) return false;
    var golem = $gameActors.actor(id);
    var ab = $.authBattle;
    var live = $gameParty.inBattle() && !ended && !!golem;
    if (live) {
        var bm = BattleManager;
        var inputting = bm.actor() === golem;
        if (inputting) bm.changeActor(-1, 'waiting');
        ['_atbInputActor', '_atbActing', '_atbSuspended', '_subject', '_atbPreForceSubject',
            '_actionForcedBattler'].forEach(function(k) {
            if (bm[k] === golem) bm[k] = null;
        });
        if (bm._atbInputMemory && bm._atbInputMemory.actor === golem) bm._atbInputMemory = null;
        if (bm._actionBattlers) bm._actionBattlers = bm._actionBattlers.filter(function(b) { return b !== golem; });
        golem.clearActions();
    }
    $gameParty._actors = $gameParty._actors.filter(function(a) { return a !== id; });
    if (golem && $gameParty.inBattle()) golem.onBattleEnd();
    if ($gameSwitches.value($.GOLEM_SUMMONED_SWITCH)) $gameSwitches.setValue($.GOLEM_SUMMONED_SWITCH, false);
    if (ab) {
        if ($.isHost()) {
            var b = $.battles[ab.bid];
            if (b) b.golem = false;
        } else if ($.conn) {
            $.conn.send({ t: 'golemEnd', bid: ab.bid, actor: golem ? $.actorJson(golem) : null });
        }
    }
    if (live) {
        if (inputting) $.closeBattleInput();
        $.resumeAfterRun(golem);
        $.broadcastParty();
        if (text) $.battleGab(text);
    }
    $.dlog('blood golem gone', ab ? ab.bid : '-', text || '');
    return true;
};

// It leaves with the fight on this PC.
var _endAuthBattleGolem = $.endAuthBattle;
$.endAuthBattle = function(result) {
    $.golemDismissDue = '';
    if ($.authBattle) $.dismissGolem('', true);
    _endAuthBattleGolem(result);
};

// The summoner runs and the fight moves on: it does not go along.
var _startHandoffGolem = $.startHandoff;
$.startHandoff = function(actor, cand, to) {
    $.dismissGolem('The blood golem crumbles.');
    _startHandoffGolem(actor, cand, to);
};

// Its summoner fell (or the host refused it): out at the next quiet moment.
var _updateGolem = BattleManager.update;
BattleManager.update = function() {
    if ($.role && $.authBattle && !$.puppet && $.golemHere()) {
        var own = $gameActors.actor($.ownBattleActorId());
        if (!$.golemDismissDue && own && own.isDead()) $.golemDismissDue = 'The blood golem crumbles.';
        if ($.golemDismissDue && $.handoffSafe()) {
            var text = $.golemDismissDue;
            $.golemDismissDue = '';
            $.dismissGolem(text);
        }
    }
    _updateGolem.call(this);
};

// A golem still in a party when a fight starts (an old save): out.
var _setupGolem = BattleManager.setup;
BattleManager.setup = function(troopId, canEscape, canLose) {
    if ($.role && !$.puppet) {
        $gameParty._actors = $gameParty._actors.filter(function(a) { return a !== $.GOLEM_ACTOR; });
        if ($gameSwitches.value($.GOLEM_SUMMONED_SWITCH)) $gameSwitches.setValue($.GOLEM_SUMMONED_SWITCH, false);
        $.golemDismissDue = '';
    }
    _setupGolem.call(this, troopId, canEscape, canLose);
};

// Host ------------------------------------------------------------------------

// A guest's fight (its own PC runs it) has it now, unless another fight does.
$.hostHandlers.golemClaim = function(conn, msg) {
    var b = $.battles[msg.bid];
    if (!b || b.owner !== conn.guestId) b = $.fightOf(conn.guestId);
    var taken = $.golemFight();
    if (!b || b.pvp || (taken && taken !== b.bid)) {
        conn.send({ t: 'golemNo', bid: msg.bid });
        return;
    }
    b.golem = true;
};

// It left a guest's fight: its numbers are the world's actor 10 again.
$.hostHandlers.golemEnd = function(conn, msg) {
    var b = $.battles[msg.bid];
    if (!b || b.owner !== conn.guestId) b = $.fightOf(conn.guestId);
    if (!b || !b.golem) return;
    b.golem = false;
    var golem = $.parseActor(msg.actor);
    // (a host watching that fight has its copy in the party: not its own)
    var hostHasOne = !$.puppet && $gameParty._actors.indexOf($.GOLEM_ACTOR) >= 0;
    if (golem && golem._actorId === $.GOLEM_ACTOR && !hostHasOne) $gameActors._data[$.GOLEM_ACTOR] = golem;
};

// A fight carried on by a joiner after its PC left: the golem went with it.
var _rescueBattleGolem = $.rescueBattle;
$.rescueBattle = function(b, conn) {
    b.golem = false;
    _rescueBattleGolem(b, conn);
};

// Everyone knows which fight has it (for the skill windows).
var _hostSyncGolem = $.hostSync;
$.hostSync = function() {
    _hostSyncGolem();
    var bid = $.golemFight();
    $.clients.forEach(function(c) {
        if ((c._golemSent || 0) === bid) return;
        c._golemSent = bid;
        // free again: with its numbers now (level, experience) for the next summon
        var golem = bid ? null : $gameActors.actor($.GOLEM_ACTOR);
        c.send({ t: 'golem', bid: bid, actor: golem ? $.actorJson(golem) : null });
    });
};

// Guest -----------------------------------------------------------------------

$.guestHandlers.golem = function(msg) {
    $.golemBid = msg.bid || 0;
    var golem = !$.golemBid && !$gameParty.inBattle() ? $.parseActor(msg.actor) : null;
    if (golem && golem._actorId === $.GOLEM_ACTOR && $gameParty._actors.indexOf($.GOLEM_ACTOR) < 0) {
        $gameActors._data[$.GOLEM_ACTOR] = golem;
    }
};

// Its summoner sees it: status and gauge (others' characters are hidden).
var _isOtherPlayerActorGolem = $.isOtherPlayerActor;
$.isOtherPlayerActor = function(actor) {
    if (actor && !$.puppet && actor.isActor() && actor.actorId() === $.GOLEM_ACTOR) return false;
    return _isOtherPlayerActorGolem(actor);
};

// Another fight got it first.
$.guestHandlers.golemNo = function(msg) {
    var ab = $.authBattle;
    // claimed before the host had given this PC's own fight its id: bid 0
    if (!ab || (msg.bid && ab.bid !== msg.bid) || !$.golemHere()) return;
    $.golemDismissDue = 'The blood golem already serves someone else.';
};

var _leaveAsGuestGolem = $.leaveAsGuest;
$.leaveAsGuest = function(message) {
    $.golemBid = 0;
    $.golemDismissDue = '';
    _leaveAsGuestGolem(message);
};


//=============================================================================
// Hexen board: each player has its own
//=============================================================================
// Original (data): the Hexen board is Map031, entered from Map032 EV7 (moon
// tower), Map164 EV104 (school) and Map174 EV1 (Donnovan's house). Buying a
// node takes one soul stone (item 116, made from soul fragments in the
// player's bag) and turns the node's switches on (SKILL_*, *AVAILABLE,
// Escape_plan!; text_* / CANT_LEARN / HEXEN_GFX are the board's screen
// state). The skill goes with Change Skill to the party member the player
// picks (CE49 counts the party into V34, V411 = that member) or, for a few
// nodes (mastery, devour), to the protagonist (SELECT switch); learns_*
// (V1861-1891) remember who. God nodes need that god's affliction (V261-266,
// raised in the character history Map019 EV224 and at shrines). The
// character history turns the nodes of the starting skills on (the same
// switches). Outside the board: doors (SKILL_Lockpicking), battle options
// (persuade, intimidate, diplomacy, escape plan), map checks (marksmanship,
// engarde), common events (CE503 lists the learned spells, crafting CE174/220).
//
// Co-op: these values belong to a player. The host's are the world's (an
// older save's shared board is the host's). A guest's are kept in the
// host's save by name (coopData().hexen) and are in the world only while
// something runs for that guest: its events on the host (guest context), its
// own map (roaming: its PC reports them back), its fights on its PC. They
// are not part of the shared world. With a guest's party in the context,
// the board's own Change Skill branches only reach that guest's character;
// any other character is ignored on the board. Soul stones are items, so
// they are already each player's own (whoever picks them up or makes them).
// The sigils a player knows (SW1421-1427 SIGIL_*: its character history,
// its books) go with the board: a ritual circle (Map005 EV146 ...) offers the
// sigils of the player at it (before, the host's: a guest's were "????").
// Not per player: the *_SOUL switches (a contestant died: world story),
// SKILL_dash (SW1956: also the run key's "running" flag), the trip there and
// back (V2289, V2299, V2300, V2592, V2593, V2600, SW2879; on the board a PC
// keeps its own V2289 / V2300 / V2592, and the Orphanage table's V2593 waits
// for every player: "The Orphanage's Tes'tich table" near the end).

$.HEXEN_MAP = 31;
$.HEXEN_SWITCHES = [];
[[731, 733], [1185, 1186], [1207, 1207], [1220, 1249], [1251, 1253], [1261, 1262], [1421, 1427], [1448, 1455],
    [1541, 1552], [1923, 1955], [1957, 1987], [1989, 1990], [1992, 1992], [1994, 2019], [2021, 2045],
    [2079, 2080], [2084, 2099], [2201, 2214], [2411, 2411], [2420, 2420], [2766, 2766]]
    .forEach(function(r) { for (var id = r[0]; id <= r[1]; id++) $.HEXEN_SWITCHES.push(id); });
// Off the board, but the same kind: what the protagonist knows, whoever it
// is (docs/조사(보관용)/개인값_감사.md). SW1167 PORTAL_LEARNED (CE86, read by CE48/71/
// 72/201), SW1267/1268 SKILL_blood_sword/spear (CE480/481/522, read by CE482),
// SW260 SuicideLEARNED (CE35), SW2081/2082 pistol/rifle_for_the_first_time
// (CE39/42: the first-time hint). Not here: the values the parallel common
// events work out again from the skills (SW28, 341, 766, 802, 803).
$.PERSONAL_EXTRA_SW = {};
[1167, 1267, 1268, 260, 2081, 2082].forEach(function(id) { $.PERSONAL_EXTRA_SW[id] = true; $.HEXEN_SWITCHES.push(id); });
$.HEXEN_AFFLICTIONS = [261, 262, 263, 264, 265, 266];
$.HEXEN_VARS = $.HEXEN_AFFLICTIONS.concat([435, 436, 1891, 1961]);
for (var hxv = 1861; hxv <= 1876; hxv++) $.HEXEN_VARS.push(hxv);
// The Spice forge's (CE503-508): forge_* 1841-1856 = which rank of which skill
// this player chose, 1837-1839 / 1857 / 1858 = its window's spice and cursors.
// Shared, one player's rank was taught to the next who ran CE505.
for (hxv = 1841; hxv <= 1856; hxv++) $.HEXEN_VARS.push(hxv);
$.HEXEN_VARS.push(1837, 1838, 1839, 1857, 1858);
$.SIGIL_KNOWN = {};
for (var sgk = 1421; sgk <= 1427; sgk++) $.SIGIL_KNOWN[sgk] = true;
// The host's sigils stay known to everyone (as before; older boards have
// none): a guest knows its own and the host's.
$.withHostSigils = function(b, hostBoard) {
    if (!$.isHost() || !b) return b;
    var host = hostBoard || ($.hxCtx ? $.hxCtx.own : $.readBoard());
    var out = { s: Object.assign({}, b.s || {}), v: Object.assign({}, b.v || {}) };
    Object.keys($.SIGIL_KNOWN).forEach(function(id) { if (host.s && host.s[id]) out.s[id] = true; });
    return out;
};
// A skin bible in the bag is its sigil known (user 2026-11-07: a book the host
// got from a guest left the circle's sigil "????"). The original turns SIGIL_*
// on only when a book is picked up (CE25 RANDOM BOOK GET: having 210 Gro-goroth,
// 317 Sylvian, 244 Alll-mer, 211 Rher, 316 Vinushka, 315 Fear and Hunger), so a
// bible handed over (trade, a body, an inheritance) never taught it. Read in co-op
// on a PC that runs the world (the host - a guest's bag in its context - or a
// roaming guest): an unknown sigil whose bible the bag holds is turned on for
// that player (its board's own value, kept when the book is given away later).
$.SIGIL_BOOKS = { 1421: 210, 1422: 317, 1423: 244, 1424: 211, 1425: 316, 1426: 315 };
var _swValueSigilBook = Game_Switches.prototype.value;
Game_Switches.prototype.value = function(id) {
    var v = _swValueSigilBook.call(this, id);
    var book = $.SIGIL_BOOKS[id];
    if (v || !book || this !== $gameSwitches || !$.role || !($.isHost() || $.isRoaming())) return v;
    if ($.sigilBookSetting || typeof $gameParty === 'undefined' || !$gameParty || !$dataItems ||
            !$gameParty.hasItem($dataItems[book])) return v;
    $.sigilBookSetting = true; // (the setValue wrappers read the old value)
    try {
        this.setValue(id, true);
    } finally {
        $.sigilBookSetting = false;
    }
    $.dlog('sigil', id, 'known: its skin bible is in the bag', $.ctx ? '(' + $.playerLabel($.ctx.guestId) + ')' : '');
    return true;
};

$.HEXEN_SW = {};
$.HEXEN_V = {};
$.HEXEN_SWITCHES.forEach(function(id) { $.HEXEN_SW[id] = true; $.NO_SYNC_SWITCHES[id] = true; });
$.HEXEN_VARS.forEach(function(id) { $.HEXEN_V[id] = true; });

// Node switch -> the skills that node teaches (Map031 node pages). A
// character that knows one of them has that node (older saves, late joiners).
$.HEXEN_NODE_SKILLS = {
    731: [326], 732: [325], 733: [324], 1185: [480], 1186: [146], 1207: [313], 1221: [294], 1223: [313],
    1225: [21], 1227: [314], 1229: [315], 1231: [55], 1233: [238], 1235: [199], 1237: [190], 1239: [12],
    1241: [51], 1246: [335], 1248: [337], 1449: [805], 1451: [642], 1453: [802], 1455: [798],
    1541: [366, 367], 1543: [369], 1545: [386, 388, 389, 390, 544, 545, 546, 547, 548, 549, 550, 551, 552, 553, 554],
    1547: [373], 1549: [371], 1551: [372], 1924: [323], 1926: [441], 1928: [445], 1930: [440], 1932: [487],
    1934: [486], 1936: [368], 1938: [454], 1940: [456], 1942: [455], 1944: [461], 1946: [460], 1948: [459],
    1950: [482], 1952: [480], 1954: [291], 1958: [496], 1960: [495], 1962: [494], 1964: [146], 1966: [468],
    1968: [465], 1970: [466], 1972: [467], 1974: [464], 1986: [475], 1990: [476], 1992: [511], 1994: [512],
    1996: [450], 1998: [451], 2000: [449], 2002: [444], 2004: [115], 2006: [338], 2008: [446], 2010: [470],
    2012: [473], 2014: [471], 2016: [437], 2018: [472], 2022: [500], 2024: [150], 2026: [799], 2030: [504],
    2032: [505], 2034: [506], 2036: [507], 2038: [508], 2043: [511], 2045: [512], 2079: [637], 2085: [218],
    2089: [516], 2093: [515], 2095: [519], 2097: [520], 2099: [521], 2204: [522], 2206: [525], 2208: [498],
    2210: [483], 2212: [447], 2214: [462], 2766: [291]
};
// Skill -> its learns_* variable (= the actor that learned it).
$.HEXEN_LEARNS = { 12: 1861, 51: 1863, 55: 1869, 150: 1864, 190: 1867, 199: 1866, 218: 1871, 238: 1870,
    294: 1874, 314: 1875, 462: 1891, 500: 1862, 504: 1865, 505: 1868, 519: 1872, 521: 1873, 525: 1876 };

$.emptyBoard = function() { return { s: {}, v: {} }; };

// The board in the world now (sparse: only what is on).
$.readBoard = function() {
    var b = $.emptyBoard();
    var sw = $gameSwitches._data, v = $gameVariables._data;
    $.HEXEN_SWITCHES.forEach(function(id) { if (sw[id]) b.s[id] = true; });
    $.HEXEN_VARS.forEach(function(id) { if (v[id]) b.v[id] = v[id]; });
    return b;
};

// Put a board into the world (every value: what it does not have is off / 0).
$.writeBoard = function(b, refresh) {
    var s = (b && b.s) || {}, vals = (b && b.v) || {};
    var sw = $gameSwitches._data, v = $gameVariables._data;
    $.HEXEN_SWITCHES.forEach(function(id) { sw[id] = !!s[id]; });
    $.HEXEN_VARS.forEach(function(id) { v[id] = Number(vals[id]) || 0; });
    if (refresh && $gameMap) $gameMap.requestRefresh();
};

// Only board values, from another PC.
$.cleanBoard = function(b) {
    var out = $.emptyBoard();
    if (!b) return out;
    $.HEXEN_SWITCHES.forEach(function(id) { if (b.s && b.s[id]) out.s[id] = true; });
    $.HEXEN_VARS.forEach(function(id) { if (b.v && Number(b.v[id])) out.v[id] = Number(b.v[id]); });
    return out;
};

// The nodes a character has by its skills (god afflictions: unknown, 0).
$.boardFromSkills = function(actor) {
    var b = $.emptyBoard();
    if (!actor || !actor.isLearnedSkill) return b;
    Object.keys($.HEXEN_NODE_SKILLS).forEach(function(id) {
        if ($.HEXEN_NODE_SKILLS[id].some(function(sk) { return actor.isLearnedSkill(sk); })) b.s[id] = true;
    });
    Object.keys($.HEXEN_LEARNS).forEach(function(sk) {
        if (actor.isLearnedSkill(Number(sk))) b.v[$.HEXEN_LEARNS[sk]] = actor.actorId();
    });
    return b;
};

// Host ------------------------------------------------------------------------

$.hexenBoards = function() {
    var data = $.coopData();
    data.hexen = data.hexen || {};
    return data.hexen;
};

$.hxCtx = null; // { conn, own, key }: a guest's board is in the world (its context)

// A guest's board. Never had one (an older save, a late joiner): the nodes
// of the skills its character knows.
$.boardOf = function(conn) {
    if (!conn) return $.emptyBoard();
    if ($.hxCtx && $.hxCtx.conn === conn) return $.readBoard();
    if (conn._sub) {
        if (!conn._hx) conn._hx = $.boardFromSkills($gameActors.actor(conn.actorId));
        return conn._hx;
    }
    var boards = $.hexenBoards();
    if (!boards[conn.name]) {
        if (!conn.actorId || conn.solo) return $.emptyBoard(); // its tutorial makes it
        boards[conn.name] = $.boardFromSkills($gameActors.actor(conn.actorId));
        $.dlog('hexen board made from the skills of', conn.name);
    }
    return boards[conn.name];
};

$.setBoard = function(conn, b) {
    if (!conn) return;
    if (conn._sub) conn._hx = b; else $.hexenBoards()[conn.name] = b;
    conn._lastMeKey = null; // its PC gets it with the next 'me'
};

// The guest context swaps the board too (like the SELECT switch).
var _enterContextHx = $.enterContext;
$.enterContext = function(conn) {
    _enterContextHx(conn);
    if ($.ctx !== conn || ($.hxCtx && $.hxCtx.conn === conn)) return;
    var own = $.readBoard();
    var b = $.boardOf(conn);
    $.hxCtx = { conn: conn, own: own, key: JSON.stringify($.cleanBoard(b)) };
    $.writeBoard($.withHostSigils(b, own), false);
};

var _exitContextHx = $.exitContext;
$.exitContext = function(force) {
    var hx = $.hxCtx;
    _exitContextHx(force);
    if (!hx || $.ctx === hx.conn) return;
    var b = $.readBoard();
    $.hxCtx = null;
    if (JSON.stringify(b) !== hx.key) $.setBoard(hx.conn, b);
    $.writeBoard(hx.own, false);
};

// What the protagonist's skills allow, worked out by parallel common events
// from the SELECT switch: CE96 -> SW802 GREATERBloodMagicAVAILABLE (skill 74),
// CE98 -> SW803 BloodsacrificeAVAILABLE (skill 75, read by the ritual circles
// CE48/71/72/201/233), CE97 -> SW864 Greater_NecromancyOK (with skill 104).
// They run in the world, where SELECT is the host's: a guest's were the
// host's (docs/조사(보관용)/개인값_감사.md, design E). In its context: its own.
// CE73 too (user 2026-10-26: each player's own): SW729 LockpickingAVAILABLE
// (skill 72), SW766 DevourAVAILABLE (78: corpses and NPCs, 2857 places),
// SW28 DEMONSEED_AVAILABLE (54, and only while SW2190 is off). The original
// turns them on when anyone (any actor) knows the skill: in co-op one
// player's skill was everyone's (see otherPlayersActors below for the world).
$.CTX_SKILL_SWITCHES = { 802: 74, 803: 75, 864: 104, 729: 72, 766: 78, 28: 54 };
$.DEMON_SEED_OFF_SWITCH = 2190; // CE73: no demon seed while it is on
// SW731 MarksmanshipAVAILABLE (79) is a node of the Hexen board: the
// player's board gets it (as CE73 gives the protagonist's).
$.MARKSMANSHIP_SWITCH = 731;
$.MARKSMANSHIP_SKILL = 79;
$.skillSwSave = null;
// each PC's own: never merged between worlds (a roaming guest's own map)
Object.keys($.CTX_SKILL_SWITCHES).forEach(function(id) { $.NO_SYNC_SWITCHES[id] = true; });

// Into the world: these values for this character (731 onto the board in it).
$.writeSkillSwitches = function(actor, save) {
    var sw = $gameSwitches._data;
    var knows = function(skill) { return !!(actor && actor.isLearnedSkill(skill)); };
    Object.keys($.CTX_SKILL_SWITCHES).forEach(function(id) {
        if (save) save[id] = sw[id];
        sw[id] = knows($.CTX_SKILL_SWITCHES[id]) && (Number(id) !== 28 || !sw[$.DEMON_SEED_OFF_SWITCH]);
    });
    if (knows($.MARKSMANSHIP_SKILL)) sw[$.MARKSMANSHIP_SWITCH] = true;
};

var _enterContextSkillSw = $.enterContext;
$.enterContext = function(conn) {
    var was = $.ctx;
    _enterContextSkillSw(conn);
    if ($.ctx !== conn || was === conn) return;
    var save = {};
    // (731 is on its board, which the board's own exit keeps for it)
    $.writeSkillSwitches($gameActors.actor(conn.actorId), save);
    $.skillSwSave = { conn: conn, sw: save };
};

// Its own map: the host's world came with the host's values, and the
// original common events only ever turn them on.
var _startRoamSkillSw = $.startRoam;
$.startRoam = function(msg) {
    _startRoamSkillSw(msg);
    if ($.isRoaming() && $.myActorId) $.writeSkillSwitches($gameActors.actor($.myActorId), null);
};

var _exitContextSkillSw = $.exitContext;
$.exitContext = function(force) {
    var saved = $.skillSwSave;
    _exitContextSkillSw(force);
    if (!saved || $.ctx === saved.conn) return;
    $.skillSwSave = null;
    var sw = $gameSwitches._data;
    Object.keys(saved.sw).forEach(function(id) { sw[id] = saved.sw[id]; });
};

// The world's own values: CE73 (parallel, on every PC that runs a world - the
// host, a guest on its own map, a sub-host) asks "has actor N learned skill
// S" for each protagonist. Another player's character answers no there, so
// the world's SW729/766/731/28 are this PC's player's (and the original
// companions'), not the union of every player (user 2026-10-26).
$.UNION_SKILL_CE = 73;
$.otherActorsCache = { frame: -1, out: null };
$.otherPlayersActors = function() {
    var cache = $.otherActorsCache;
    if (cache.frame === Graphics.frameCount && cache.out) return cache.out;
    var me = $.myPlayerId ? $.myPlayerId() : ($.isHost() ? 'host' : $.myId), out = {};
    ($.roster || []).forEach(function(p) { if (p && p.id !== me && p.a) out[p.a] = true; });
    if ($.isHost()) {
        // players of this save who are not here now: their characters are in the world too
        var assign = $.coopData().assign || {};
        Object.keys(assign).forEach(function(name) { if (assign[name]) out[assign[name]] = true; });
        $.clients.forEach(function(c) { if (c.actorId) out[c.actorId] = true; });
        delete out[$.hostActorId()];
    } else if ($.myActorId) {
        delete out[$.myActorId];
    }
    cache.frame = Graphics.frameCount;
    cache.out = out;
    return out;
};

var _command111Union = Game_Interpreter.prototype.command111;
Game_Interpreter.prototype.command111 = function() {
    var p = this._params;
    if (p[0] === 4 && p[2] === 3 && $.role && !$.ctx) {
        var ce = $dataCommonEvents[$.UNION_SKILL_CE];
        if (ce && this._list === ce.list && $.otherPlayersActors()[p[1]]) {
            this._branch[this._indent] = false;
            this.skipBranch();
            return true;
        }
    }
    return _command111Union.call(this);
};

// CE97 GREATER BLOOD MAGIC (parallel while SW802 is on) turns the
// protagonist's Blood golem / Hurting / Necromancy ... into the greater ones,
// by SELECT: only the host's character ever got them. A guest whose world
// runs here (on the host's map, or a sub-host's guest) and who knows Greater
// blood magic gets the same, run in its context once a second. A guest
// running its own map has its own SELECT there: the original CE97 runs.
$.GREATER_MAGIC_CE = 97;
$.GREATER_MAGIC_SKILL = 74;

$.worldHereFor = function(c) {
    if (!c || !c.actorId || c.solo || c.inBattle) return false;
    return $.isHost() ? (!c.roam && !c.roamPending && !c.subOf) : !!c._sub;
};

$.runGreaterMagicFor = function(c) {
    var ce = $dataCommonEvents[$.GREATER_MAGIC_CE];
    var actor = $gameActors.actor(c.actorId);
    if (!ce || !actor || !actor.isLearnedSkill($.GREATER_MAGIC_SKILL)) return;
    var before = actor._skills.join();
    $.inContext(c, function() {
        var interp = new Game_Interpreter();
        interp.setup(ce.list, 0);
        for (var i = 0; i < 20 && interp.isRunning(); i++) interp.update(); // (no waits in it)
    });
    var now = $gameActors.actor(c.actorId);
    if (now && now._skills.join() !== before) {
        $.dlog('greater blood magic for', c.name, now._skills.join());
        $.pushMe(c); // its PC's menu and fights
    }
};

$.worldExtras.push(function() {
    if (!$.runsWorld() || Graphics.frameCount % 60 !== 30 || $.ctx) return;
    $.clients.forEach(function(c) { if ($.worldHereFor(c)) $.runGreaterMagicFor(c); });
});

// A guest's PC gets its board with its character and bag.
var _meDataHx = $.meData;
$.meData = function(conn) {
    var data = _meDataHx(conn);
    if (conn && conn.actorId && !conn.solo) data.hx = $.boardOf(conn);
    return data;
};

// Not the shared world: variables (the switches are in NO_SYNC_SWITCHES).
var _markWorldHx = $.markWorld;
$.markWorld = function(kind, key, value) {
    if (kind === 'v' && $.HEXEN_V[key]) return;
    _markWorldHx(kind, key, value);
};

var _applyWorldDeltaHx = $.applyWorldDelta;
$.applyWorldDelta = function(d, pending, persist) {
    if (d && d.v) {
        var v = {};
        Object.keys(d.v).forEach(function(k) { if (!$.HEXEN_V[k]) v[k] = d.v[k]; });
        d = Object.assign({}, d, { v: v });
    }
    return _applyWorldDeltaHx(d, pending, persist);
};

// Battle diffs [[id, value]]: the board's part apart.
$.splitBoardDelta = function(swd, vd) {
    var mine = { sw: [], v: [] };
    return {
        swd: (swd || []).filter(function(d) { return $.HEXEN_SW[d[0]] ? (mine.sw.push(d), false) : true; }),
        vd: (vd || []).filter(function(d) { return $.HEXEN_V[d[0]] ? (mine.v.push(d), false) : true; }),
        mine: mine
    };
};

// A guest's fight on its PC changed its own board (not the world's).
var _battleEndHx = $.hostHandlers.battleEnd;
$.hostHandlers.battleEnd = function(conn, msg) {
    if (msg && (msg.swd || msg.vd)) {
        var b = $.battles[msg.bid];
        var split = $.splitBoardDelta(msg.swd, msg.vd);
        msg.swd = split.swd;
        msg.vd = split.vd;
        if ($.reportsFor(b, conn.guestId) && (split.mine.sw.length || split.mine.v.length)) {
            var board = $.cleanBoard($.boardOf(conn));
            split.mine.sw.forEach(function(d) { if (d[1]) board.s[d[0]] = true; else delete board.s[d[0]]; });
            split.mine.v.forEach(function(d) { if (Number(d[1])) board.v[d[0]] = Number(d[1]); else delete board.v[d[0]]; });
            $.setBoard(conn, board);
        }
    }
    _battleEndHx(conn, msg);
};

// A fight moved from another PC: its world's board is not this one's.
var _applyBattleDeltaHx = $.applyBattleDelta;
$.applyBattleDelta = function(swd, vd, ssd) {
    var split = $.splitBoardDelta(swd, vd);
    return _applyBattleDeltaHx(split.swd, split.vd, ssd);
};

// A roaming guest's board (while it runs its map, and before it comes back).
// One sent just before the host's snapshot reached it is still its newest.
// Not roaming any more (the host loaded a save): the save's board counts.
$.hostHandlers.hxMe = function(conn, msg) {
    if (!conn.roam || !conn.actorId || conn.solo || conn.subOf || !msg.hx) return;
    if ($.hxCtx && $.hxCtx.conn === conn) return;
    $.setBoard(conn, $.cleanBoard(msg.hx));
};

// A sub-host's guest's board (also its last report after it left there,
// like subMe).
$.hostHandlers.hxSub = function(conn, msg) {
    var c = $.clientById(msg.id) || $.subLeft[msg.id];
    if (!c || !msg.hx || ($.hxCtx && $.hxCtx.conn === c)) return;
    var left = !c.subOf && !c.roam && c.subWas === conn.guestId && !!c.subWasInv;
    if (c.subOf === conn.guestId || left) $.setBoard(c, $.cleanBoard(msg.hx));
};

// A guest's character history (its solo tutorial): its starting board.
$.hostHandlers.hxSolo = function(conn, msg) {
    if (!conn.solo || !msg.hx) return;
    $.hexenBoards()[conn.name] = $.cleanBoard(msg.hx);
    $.dlog('hexen board from the tutorial of', conn.name);
    if ($.applySoloCarry) $.applySoloCarry(conn, msg.carry);
    $.keepSolo(conn, { hx: $.cleanBoard(msg.hx), carry: msg.carry || null });
};

// A save from before its exit: the board and history values come back too.
var _restoreSoloHx = $.restoreSolo;
$.restoreSolo = function(conn, actorId) {
    if (!_restoreSoloHx(conn, actorId)) return false;
    var k = $.soloKept[conn.name];
    if (k.hx) $.hexenBoards()[conn.name] = JSON.parse(k.hx);
    if (k.carry) $.applySoloCarry(conn, JSON.parse(k.carry));
    return true;
};

// On the board, Change Skill reaches the characters of the party running it
// (in a guest's context: that guest's character), no other player's.
var _command318Hx = Game_Interpreter.prototype.command318;
Game_Interpreter.prototype.command318 = function() {
    var p = this._params;
    var onBoard = $.role && $gameMap && $gameMap.mapId() === $.HEXEN_MAP && !$gameParty.inBattle();
    if (onBoard || ($.role && this._fhForgeTeach)) {
        var id = p[0] === 0 ? p[1] : $gameVariables.value(p[1]);
        if (id > 0 && $gameParty._actors.indexOf(id) < 0) return true;
    }
    return _command318Hx.call(this);
};

// The Spice forge, used from the menu on any map (user 2026-11-09). CE505
// forgets every rank for the party, then teaches the ranks of forge_* to the
// actor in learns_*: anyone else's character is left alone (the rule above,
// off the board too). CE503 opens with what this character really knows, so
// a rank chosen while the values were shared does not come back.
$.FORGE_MENU_EVENT = 503;
$.FORGE_TEACH_EVENT = 505;

// { skill: [forge variable, rank] }, read from CE505.
$.forgeRanks = function() {
    var out = {}, cond = null;
    $dataCommonEvents[$.FORGE_TEACH_EVENT].list.forEach(function(c) {
        if (c.code === 111 && c.parameters[0] === 1) cond = c.parameters;
        if (c.code === 318 && c.parameters[0] === 1 && cond) out[c.parameters[3]] = [cond[1], cond[3]];
    });
    return out;
};

$.forgeFromSkills = function(actor) {
    if (!actor) return;
    var ranks = $.forgeRanks(), v = $gameVariables._data;
    Object.keys(ranks).forEach(function(skill) { v[ranks[skill][0]] = 0; });
    Object.keys(ranks).forEach(function(skill) {
        var r = ranks[skill];
        if (actor.isLearnedSkill(Number(skill)) && r[1] > (v[r[0]] || 0)) v[r[0]] = r[1];
    });
};

var _setupForge = Game_Interpreter.prototype.setup;
Game_Interpreter.prototype.setup = function(list, eventId) {
    var ce = $dataCommonEvents;
    this._fhForgeOpen = !!ce && !!ce[$.FORGE_MENU_EVENT] && list === ce[$.FORGE_MENU_EVENT].list;
    this._fhForgeTeach = !!ce && !!ce[$.FORGE_TEACH_EVENT] && list === ce[$.FORGE_TEACH_EVENT].list;
    _setupForge.call(this, list, eventId);
};

var _executeCommandForge = Game_Interpreter.prototype.executeCommand;
Game_Interpreter.prototype.executeCommand = function() {
    if (this._fhForgeOpen) {
        this._fhForgeOpen = false;
        if ($.role) $.forgeFromSkills($gameActors.actor($.ctx ? $.ctx.actorId : ($.isHost() ? $.hostActorId() : $.myActorId)));
    }
    return _executeCommandForge.call(this);
};

// Sub-host: its guest's board goes to the host with its bag.
var _sendSubMeHx = $.sendSubMe;
$.sendSubMe = function(v, force) {
    _sendSubMeHx(v, force);
    if (!$.conn || !v) return;
    var b = $.cleanBoard($.boardOf(v));
    var key = JSON.stringify(b);
    if (!force && key === v._hxSentKey) return;
    v._hxSentKey = key;
    $.conn.send({ t: 'hxSub', id: v.guestId, hx: b });
};

// Guest -----------------------------------------------------------------------

$.myHx = null;     // guest: its board (from the host; a thin guest's world has it too)
$.hxSentKey = '';  // guest: the board last sent while roaming
$.hxBase = null;   // guest: the board as its solo tutorial started

var _guestMeHx = $.guestHandlers.me;
$.guestHandlers.me = function(msg) {
    if (msg && msg.hx && !$.isRoaming() && !$.pendingRoam) $.myHx = $.cleanBoard(msg.hx);
    _guestMeHx(msg);
    if (msg && msg.hx && $.isThin() && $.myHx && $gameParty && !$gameParty.inBattle() &&
            !$.pendingSnapshot && !$.localBattle) {
        $.writeBoard($.myHx, false);
    }
};

// The host's world arrives with the host's board.
var _processPendingSnapshotHx = $.processPendingSnapshot;
$.processPendingSnapshot = function() {
    var had = !!$.pendingSnapshot;
    _processPendingSnapshotHx();
    if (had && $.myHx && $.isThin()) $.writeBoard($.myHx, false);
};

// Its own map: its own board.
var _startRoamHx = $.startRoam;
$.startRoam = function(msg) {
    _startRoamHx(msg);
    var b = msg && msg.hx ? $.cleanBoard(msg.hx) : $.myHx;
    if (!b) return;
    $.myHx = b;
    $.writeBoard(b, true);
    $.hxSentKey = JSON.stringify(b);
};

$.sendHxMe = function(force) {
    if (!$.conn || !$.isRoaming() || $.puppet || ($gameParty && $gameParty.inBattle())) return;
    if ($.pendingSnapshot || $.pendingRoam) return; // the host's world is on its way
    var b = $.readBoard();
    var key = JSON.stringify(b);
    if (!force && key === $.hxSentKey) return;
    $.hxSentKey = key;
    $.myHx = b;
    $.conn.send({ t: 'hxMe', hx: b });
};

$.guestExtras.push(function() {
    if ($.isRoaming() && $.roamFrame % 10 === 5) $.sendHxMe(false); // a bought node goes soon
});

var _sendUnroamHx = $.sendUnroam;
$.sendUnroam = function(spot, interpJson) {
    $.sendHxMe(true);
    _sendUnroamHx(spot, interpJson);
};

// A fight's world from another PC (a duel, a fight taken over): this
// player's board stays its own, and the fight does not count it as changed.
$.keepOwnBoard = function(fn) {
    var own = $.isRoaming() ? $.readBoard() : ($.myHx || $.readBoard());
    fn();
    var lb = $.localBattle;
    if (!lb) return;
    $.writeBoard(own, false);
    $.HEXEN_SWITCHES.forEach(function(id) { if (lb.sw0) lb.sw0[id] = $gameSwitches._data[id]; });
    $.HEXEN_VARS.forEach(function(id) { if (lb.v0) lb.v0[id] = $gameVariables._data[id]; });
};

// Every way in: bTakeOver, one waiting for the battle screen, bRescue (the
// host's world).
var _takeOverBattleHx = $.takeOverBattle;
$.takeOverBattle = function(msg) {
    if (!$.isGuest() || !msg || !msg.sw) return _takeOverBattleHx(msg);
    $.keepOwnBoard(function() { _takeOverBattleHx(msg); });
};

var _pvpHx = $.guestHandlers.pvp;
$.guestHandlers.pvp = function(msg) {
    if (!$.isGuest() || !msg || !msg.sw) return _pvpHx(msg);
    $.keepOwnBoard(function() { _pvpHx(msg); });
};

// Solo tutorial: the nodes its character history gave (the starting board).
var _startSoloHx = $.startSolo;
$.startSolo = function(inv) {
    _startSoloHx(inv);
    $.hxBase = $.readBoard();
};

$.soloBoard = function() {
    var now = $.readBoard();
    var base = $.hxBase || $.emptyBoard();
    var b = $.boardFromSkills($gameActors.actor($.myActorId));
    Object.keys(now.s).forEach(function(id) {
        if (!base.s[id] && ($.HEXEN_NODE_SKILLS[id] || $.SIGIL_KNOWN[id] || $.PERSONAL_EXTRA_SW[id])) b.s[id] = true;
    });
    $.HEXEN_AFFLICTIONS.forEach(function(id) {
        var gain = (Number(now.v[id]) || 0) - (Number(base.v[id]) || 0);
        if (gain > 0) b.v[id] = gain;
    });
    return b;
};

// World values only one character's history page sets (Map019 EV224), read
// after the tutorial: they belong to that character, so the host's world
// takes the guest's. Its solo world was dropped at the exit, and with it the
// max HP bonus (0.41 audit: SW2781 Levi, SW4501 Marcoh, SW4513 O'saa - the
// hunger common events CE106/425/115 set max HP 125/115 only with it on).
// V2484 butterfly1_activate (Levi; Map058/067), V2694 var8 (O'saa's text
// adventure; Map148).
$.SOLO_CARRY_SW = [2781, 4501, 4513];
$.SOLO_CARRY_V = [2484, 2694];
$.soloCarryBase = null; // guest: those values as its solo tutorial started

$.readSoloCarry = function() {
    var out = { sw: {}, v: {} };
    $.SOLO_CARRY_SW.forEach(function(id) { out.sw[id] = !!$gameSwitches._data[id]; });
    $.SOLO_CARRY_V.forEach(function(id) { out.v[id] = Number($gameVariables._data[id]) || 0; });
    return out;
};

// The ones its tutorial changed.
$.soloCarry = function() {
    var base = $.soloCarryBase || { sw: {}, v: {} }, now = $.readSoloCarry(), out = { sw: {}, v: {} };
    $.SOLO_CARRY_SW.forEach(function(id) { if (now.sw[id] !== !!base.sw[id]) out.sw[id] = now.sw[id]; });
    $.SOLO_CARRY_V.forEach(function(id) { if (now.v[id] !== (Number(base.v[id]) || 0)) out.v[id] = now.v[id]; });
    return out;
};

var _startSoloCarry = $.startSolo;
$.startSolo = function(inv) {
    _startSoloCarry(inv);
    $.soloCarryBase = $.readSoloCarry();
};

var _finishSoloHx = $.finishSolo;
$.finishSolo = function() {
    if ($.conn && $.myActorId) $.conn.send({ t: 'hxSolo', hx: $.soloBoard(), carry: $.soloCarry() });
    _finishSoloHx.apply(this, arguments);
};

// Host: only the listed ones, into the shared world.
$.applySoloCarry = function(conn, carry) {
    if (!carry) return;
    var done = [];
    $.SOLO_CARRY_SW.forEach(function(id) {
        if (carry.sw && id in carry.sw) { $gameSwitches.setValue(id, !!carry.sw[id]); done.push('SW' + id); }
    });
    $.SOLO_CARRY_V.forEach(function(id) {
        if (carry.v && id in carry.v) { $gameVariables.setValue(id, Number(carry.v[id]) || 0); done.push('V' + id); }
    });
    if (done.length) $.dlog('history values from the tutorial of', conn.name + ':', done.join(' '));
};

var _leaveAsGuestHx = $.leaveAsGuest;
$.leaveAsGuest = function(message) {
    $.myHx = null;
    $.hxSentKey = '';
    $.hxBase = null;
    _leaveAsGuestHx(message);
};


// Start area: picking a character turns its *_SOUL switch on (Map155 EV1
// page 4: Levi 494, Marina 495, Daan 496, Abella 497, O'saa 500, Marcoh
// 499, Karin 498, Olivia 493), and the board (Map031 nodes, EV148/EV150)
// opens the area of every SOUL that is on. The same switch goes on when that
// contestant dies, so it stays a world value. On the board each player sees
// its own character's area, and not the area of a character another living
// player plays (that one is on only because that player picked it).
$.SOUL_OF_ACTOR = { 1: 494, 3: 495, 4: 496, 5: 497, 6: 500, 13: 499, 14: 498, 15: 493 };
$.SOUL_ACTOR = {};
Object.keys($.SOUL_OF_ACTOR).forEach(function(a) { $.SOUL_ACTOR[$.SOUL_OF_ACTOR[a]] = Number(a); });
// The contestants nobody plays have an area on the board too (Map031 reads
// SW734-739 apprentice / hunter / chef / mobster / salaryman / lieutenant
// _SOUL): Samarie, August, Henryk, Caligura, Tanaka, Pav. Their souls are one
// player's as well (2026-11-02: Pav killed in front of the Empty tower,
// Map111 EV352, opened his area on every board, the guest's too).
$.NPC_SOUL_ACTOR = { 734: 36, 735: 31, 736: 33, 737: 32, 738: 35, 739: 34 };
Object.keys($.NPC_SOUL_ACTOR).forEach(function(sw) { $.SOUL_ACTOR[sw] = $.NPC_SOUL_ACTOR[sw]; });

// The host's character, also inside a guest's context (SELECT swapped).
$.hostCharacter = function() {
    if ($.ctx && $.ctxSave && $.ctxSave.sel) {
        var found = 0;
        $.SELECT_SWITCHES.forEach(function(id, i) {
            if (!found && $.ctxSave.sel[i] && $.SELECT_ACTOR[id]) found = $.SELECT_ACTOR[id];
        });
        return found;
    }
    return $.hostActorId();
};

// Whose board is on screen: a guest's context, else this PC's player.
$.boardCharacter = function() {
    if ($.ctx && $.ctx.actorId) return $.ctx.actorId;
    if ($.isHost()) return $.hostActorId();
    return $.myActorId || 0;
};

// actor id -> true: characters living players play now.
$.livingPlayerCharacters = function() {
    var ids = {};
    if ($.isHost()) {
        var host = $.hostCharacter();
        if (host && !$.isDead('host')) ids[host] = true;
        $.clients.forEach(function(c) {
            if (c.actorId && !c.solo && !$.isDead(c.guestId)) ids[c.actorId] = true;
        });
    } else {
        ($.roster || []).forEach(function(p) { if (p.a && !p.dead) ids[p.a] = true; });
        if ($.myActorId) ids[$.myActorId] = true;
        if ($.ctx && $.ctx.actorId) ids[$.ctx.actorId] = true;
    }
    return ids;
};

$.boardSoul = function(id) {
    var owner = $.SOUL_ACTOR[id];
    if (!owner || !$.role || !$gameMap || $gameMap.mapId() !== $.HEXEN_MAP) return undefined;
    if (owner === $.boardCharacter()) return true;
    if ($.livingPlayerCharacters()[owner]) return false;
    var to = $.soulOwnerMap()[id]; // a dead contestant's soul one player took
    if ($.coopSetting && $.coopSetting('soulsShared')) return undefined; // (Co-op Settings: everyone's board)
    if (to) return to === $.boardCharacter() ? undefined : false; // (its own: the world's value)
    return undefined;
};

var _switchValueSoul = Game_Switches.prototype.value;
Game_Switches.prototype.value = function(id) {
    if ($.SOUL_ACTOR[id] && this === $gameSwitches) {
        var v = $.boardSoul(id);
        if (v !== undefined) return v;
    }
    return _switchValueSoul.call(this, id);
};

// A contestant's soul is one player's (user 2026-10-26): when its *_SOUL
// switch goes on (it died), the player whose event or fight did it gets
// "Absorb" / "Give to <name>"; only the one who has it sees that area on
// its board. Before, the switch was the world's: every board opened it.
// Who did it: on the host, the guest whose context runs (its events), else
// the host; a roaming guest's world change (wDelta) is that guest's (a
// sub-host's guests: the sub-host's). Opened on the Hexen board itself
// (Map031 EV131, a soul stone): the one at the board keeps it, no question.
// Kept in the host's save by the taker's character (coopData().souls:
// switch -> actor id); guests get it ('souls'). Nobody's (no player did it,
// an older save): every board, as before.
$.soulOwners = {}; // guest: the host's coopData().souls

$.soulOwnerMap = function() {
    if ($.isHost()) {
        var data = $.coopData();
        return (data.souls = data.souls || {});
    }
    return $.soulOwners || {};
};

// The living players who can take a soul: [{ id, a }].
$.soulTakers = function() {
    var list = [];
    if (!$.isDead('host') && $.hostActorId()) list.push({ id: 'host', a: $.hostActorId() });
    $.activeGuests().forEach(function(c) {
        if (!$.isDead(c.guestId)) list.push({ id: c.guestId, a: c.actorId });
    });
    return list;
};

$.broadcastSouls = function() {
    var s = $.soulOwnerMap();
    $.clients.forEach(function(c) { c.send({ t: 'souls', s: s }); });
};

$.guestHandlers.souls = function(msg) {
    if (!$.isHost()) $.soulOwners = msg.s || {};
};

$.soulGained = function(id, causeId, mapId) {
    var contestant = $.SOUL_ACTOR[id];
    if (!contestant || $.livingPlayerCharacters()[contestant]) return; // a player's own pick
    var owners = $.soulOwnerMap();
    if (owners[id]) return;
    if ($.coopSetting('soulsShared')) return; // (Co-op Settings: everyone's board, nobody is asked)
    var takers = $.soulTakers();
    var cause = takers.filter(function(p) { return p.id === causeId; })[0];
    if (!cause) return; // nobody living did it: every board, as before
    owners[id] = cause.a;
    $.broadcastSouls();
    var name = $dataActors[contestant] ? $dataActors[contestant].name : 'someone';
    $.dlog('soul of', name, 'goes to', $.playerLabel(causeId), mapId === $.HEXEN_MAP ? '(its board)' : '');
    var others = takers.filter(function(p) { return p.id !== causeId; });
    if (mapId === $.HEXEN_MAP || !others.length) return;
    $.soulWait[id] = { at: $.clockMs(), asked: true, cause: causeId };
    $.sendTo(causeId, { t: 'soulAsk', sw: id, name: name,
        to: others.map(function(p) { return { id: p.id, label: $.playerLabel(p.id), a: p.a }; }) });
};

$.SOUL_ASK_TEXT = 'The soul of %1 is yours.';
$.guestHandlers.soulAsk = function(msg) {
    var to = msg.to || [];
    var options = ['Absorb'].concat(to.map(function(p) { return 'Give to ' + p.label; }));
    if (!$.isHost()) $.soulAsked(msg.sw);
    $.showPickBox($.SOUL_ASK_TEXT.replace('%1', msg.name), options, function(i) {
        var pick = { t: 'soulGive', sw: msg.sw, to: i > 0 && to[i - 1] ? to[i - 1].id : null };
        if (!$.isHost()) $.soulAnswered(msg.sw, i > 0 && to[i - 1] ? to[i - 1].a : $.myActorId);
        if ($.isHost()) $.soulGive('host', pick);
        else if ($.conn) $.conn.send(pick);
    }, 0);
};

$.hostHandlers.soulGive = function(conn, msg) {
    $.soulGive(conn.guestId, msg);
};

$.soulGive = function(fromId, msg) {
    var owners = $.soulOwnerMap(), takers = $.soulTakers();
    var from = takers.filter(function(p) { return p.id === fromId; })[0];
    var contestant = $.SOUL_ACTOR[msg && msg.sw];
    if (!from || !contestant || owners[msg.sw] !== from.a) return;
    var name = $dataActors[contestant].name;
    var to = msg.to ? takers.filter(function(p) { return p.id === msg.to; })[0] : null;
    if (!to || to.id === fromId) {
        $.broadcastToast($.playerLabel(fromId) + ' absorbed the soul of ' + name + '.');
        return;
    }
    owners[msg.sw] = to.a;
    $.broadcastSouls();
    $.dlog('soul of', name, 'given by', $.playerLabel(fromId), 'to', $.playerLabel(to.id));
    $.broadcastToast($.playerLabel(fromId) + ' gave the soul of ' + name + ' to ' + $.playerLabel(to.id) + '.');
};

// Host: a soul switch goes on in its world.
$.soulCauseId = null; // host: who did it, when the host's code turns it on for a player
var _swSetSoul = Game_Switches.prototype.setValue;
Game_Switches.prototype.setValue = function(id, value) {
    var gain = this === $gameSwitches && !!$.SOUL_ACTOR[id] && !!value && $.isHost() && $.sessionActive() &&
        !_switchValueSoul.call(this, id);
    _swSetSoul.call(this, id, value);
    if (gain && _switchValueSoul.call(this, id)) {
        $.soulGained(id, $.soulCauseId || ($.ctx ? $.ctx.guestId : $.soulShooter() || 'host'), $gameMap ? $gameMap.mapId() : 0);
    }
};

// A guest's bullet on the host's map: the map's gun check (arrow_check, a
// parallel page the host runs as its own) turns the shot down form's soul on
// (the giant SW499, the Chaugnar SW497, the Mastermind SW500 ...) - the
// shooter's soul, not the host's (user 2026-11-08: "a guest shooting it?").
$.soulShooter = function() {
    var b = $.bullet;
    if (!$.mapParallelDepth || !b || !b.shooter || b.shooter === 'host' || !$gameMap || b.mapId !== $gameMap.mapId()) return null;
    return b.shooter;
};

// The Mastermind shot down on the field (Map080 EV35: SW3804 mastermind1 and
// CE547 only) gives no soul in the original, unlike the other contestants'
// forms shot down (Map076 EV101 the giant: SW499, Map084 the monstrosity:
// SW493, the Chaugnar: SW497, the Judgement: SW738) and unlike its own fight
// (Map080 EV82: SW500 then SW3804). User 2026-11-07 ("the others give their
// soul when shot"): in co-op SW3804 coming on brings O'saa's soul (SW500) too,
// on the PC that runs that world (whose it is: as any soul switch).
$.MASTERMIND_DEAD_SWITCH = 3804;
$.OSAA_SOUL_SWITCH = 500;
var _swSetMastermindSoul = Game_Switches.prototype.setValue;
Game_Switches.prototype.setValue = function(id, value) {
    _swSetMastermindSoul.call(this, id, value);
    if (id !== $.MASTERMIND_DEAD_SWITCH || !value || this !== $gameSwitches || !$.role) return;
    if (!($.isHost() || ($.isRoaming && $.isRoaming())) || this._data[$.OSAA_SOUL_SWITCH]) return;
    $.dlog('the Mastermind is dead without its fight - the soul of Osaa (SW500) too');
    this.setValue($.OSAA_SOUL_SWITCH, true);
};

$.playerIdOfName = function(name) {
    if (!name) return null;
    if (name === $.nameOf('host')) return 'host';
    var c = $.clients.filter(function(x) { return x.name === name; })[0];
    return c ? c.guestId : null;
};

// Host: a roaming guest's world turned one on.
var _wDeltaSoul = $.hostHandlers.wDelta;
$.hostHandlers.wDelta = function(conn, msg) {
    var gains = [];
    if (conn && conn.roam && msg && msg.sw) {
        Object.keys(msg.sw).forEach(function(k) {
            var id = Number(k);
            if ($.SOUL_ACTOR[id] && msg.sw[k] && !_switchValueSoul.call($gameSwitches, id)) gains.push(id);
        });
    }
    _wDeltaSoul(conn, msg);
    gains.forEach(function(id) {
        // (its sub-guest's fight killed it: that guest's - subSoul below)
        var by = $.subSoulBy[id] && $.subSoulBy[id].sub === conn.guestId ? $.subSoulBy[id].who : conn.guestId;
        delete $.subSoulBy[id];
        if (_switchValueSoul.call($gameSwitches, id)) $.soulGained(id, by, Number(msg.m) || 0);
    });
};

// A sub-host's guest's own fight killed a contestant (isHost audit 2026-11-10): the
// sub-host's world turns its switch on and its wDelta came as the sub-host's. The
// sub-host names the guest first; the host credits that guest when the switch comes.
$.subSoulBy = {}; // host: soul switch -> { who, sub }
$.hostHandlers.subSoul = function(conn, msg) {
    var c = msg && $.clientById(msg.who);
    if (!c || c.subOf !== conn.guestId) return;
    (msg.sw || []).forEach(function(id) {
        if ($.SOUL_ACTOR[id]) $.subSoulBy[id] = { who: c.guestId, sub: conn.guestId };
    });
};

// Host: a guest's own fight (on its PC, others joined) killed a contestant:
// its switches come with battleEnd and are written as they are, so the soul
// was nobody's and every board opened it, with no question (2026-11-02). It
// is that fight's owner's, as its event's would be.
var _battleEndSoul = $.hostHandlers.battleEnd;
$.hostHandlers.battleEnd = function(conn, msg) {
    if (!$.isHost()) {
        // a sub-host (its guest's fight, passed on by the host): not its souls to give
        var subGains = (msg && msg.swd || []).filter(function(d) {
            return $.SOUL_ACTOR[d[0]] && d[1] && !_switchValueSoul.call($gameSwitches, d[0]);
        }).map(function(d) { return d[0]; });
        if (subGains.length && $.conn && conn && conn._sub) $.conn.send({ t: 'subSoul', who: conn.guestId, sw: subGains });
        return _battleEndSoul(conn, msg);
    }
    var gains = (msg && msg.swd || []).filter(function(d) {
        return $.SOUL_ACTOR[d[0]] && d[1] && !_switchValueSoul.call($gameSwitches, d[0]);
    }).map(function(d) { return d[0]; });
    _battleEndSoul(conn, msg);
    gains.forEach(function(id) {
        if (_switchValueSoul.call($gameSwitches, id)) $.soulGained(id, conn.guestId, $gameMap ? $gameMap.mapId() : 0);
    });
};

// A guest gets who has which soul when it gets its character.
var _sendAssignSouls = $.sendAssign;
$.sendAssign = function(conn, actorId) {
    _sendAssignSouls(conn, actorId);
    conn.send({ t: 'souls', s: $.soulOwnerMap() });
};

// Guests learn the others' characters with the roster.
var _sendAssignRoster = $.sendAssign;
$.sendAssign = function(conn, actorId) {
    _sendAssignRoster(conn, actorId);
    if ($.broadcastRoster) $.broadcastRoster();
};

// The original's "You absorbed the <kind> soul." right after the kill
// (Map130 EV104: SW498 Karin's soul on, an animation, then the line; the
// same in every contestant's death, 160-odd lines): in co-op the soul
// is not absorbed yet - its player picks Absorb or Give (above), and that
// line came anyway, on every screen on the map, also for a player who gave
// it away (play test 2026-11-05: O'saa gave Karin's soul to Daan, both
// screens said "You absorbed"). The event now waits at that message until the
// pick is made (at most SOUL_WAIT_MS), and the line names who took it:
// "Daan absorbed the Endless soul." With no pick (nobody else to give it
// to) the line stays as it is.
// Kept on the PC whose interpreter runs the kill: the host (its own events,
// a thin guest's), or a roaming guest (its own map: the host's question
// comes back to it after its world change).
$.SOUL_WAIT_MS = 60000;
$.SOUL_ASK_COMING_MS = 3000; // a roaming guest: the host's question on its way
$.SOUL_LINE_RE = /^You absorbed the (.*soul)/i;
$.soulWait = {}; // switch -> { at, asked, cause (host), done: actor id }
$.lastSoulOn = null; // { sw, at }: the soul switch an event here just turned on

$.soulAsked = function(sw) {
    var rec = $.soulWait[sw] || ($.soulWait[sw] = { at: $.clockMs() });
    rec.asked = true;
    rec.at = $.clockMs();
    delete rec.done; // (a pick before a load)
};

$.soulAnswered = function(sw, actorId) {
    var rec = $.soulWait[sw];
    if (rec) rec.done = actorId || 0;
};

// Whose the soul is now: an actor id, 'wait' while its pick is open, or null
// (no pick: the line as it is).
$.soulLineOwner = function(sw) {
    var rec = $.soulWait[sw], now = $.clockMs();
    if (!rec) return null;
    if (rec.done !== undefined) return rec.done || null;
    if (!rec.asked) return now - rec.at < $.SOUL_ASK_COMING_MS ? 'wait' : null;
    var gone = $.isHost() && rec.cause && !$.soulTakers().some(function(p) { return p.id === rec.cause; });
    if (gone || now - rec.at >= $.SOUL_WAIT_MS) return $.isHost() ? $.soulOwnerMap()[sw] || null : null;
    return 'wait';
};

// Host: the pick made (Absorb or Give).
var _soulGiveLine = $.soulGive;
$.soulGive = function(fromId, msg) {
    _soulGiveLine(fromId, msg);
    var rec = msg && $.soulWait[msg.sw];
    if (rec && rec.cause === fromId) rec.done = $.soulOwnerMap()[msg.sw] || 0;
};

// The soul switch an event on this PC turned on (a roaming guest: a question
// comes only when another living player could take it, not on the board).
var _swSetSoulLine = Game_Switches.prototype.setValue;
Game_Switches.prototype.setValue = function(id, value) {
    var gain = this === $gameSwitches && !!$.SOUL_ACTOR[id] && !!value && !!$.role && $.sessionActive() &&
        !_switchValueSoul.call(this, id);
    _swSetSoulLine.call(this, id, value);
    if (!gain) return;
    $.lastSoulOn = { sw: id, at: $.clockMs() };
    if (!$.isHost() && $gameMap && $gameMap.mapId() !== $.HEXEN_MAP) {
        var others = ($.roster || []).some(function(p) { return p.a && !p.dead && p.a !== $.myActorId; });
        if (others) $.soulWait[id] = { at: $.clockMs() }; // (anew: a pick before a load)
        else delete $.soulWait[id];
    }
};

// The message with that line: wait for the pick, then the taker's name.
var _command101SoulLine = Game_Interpreter.prototype.command101;
Game_Interpreter.prototype.command101 = function() {
    var last = $.lastSoulOn, list = this._list, i = this._index + 1;
    if (!last || !$.role || $.clockMs() - last.at > $.SOUL_WAIT_MS + 30000) return _command101SoulLine.apply(this, arguments);
    var hit = false;
    for (; list[i] && list[i].code === 401; i++) if ($.SOUL_LINE_RE.test(list[i].parameters[0])) hit = true;
    if (!hit) return _command101SoulLine.apply(this, arguments);
    var owner = $.soulLineOwner(last.sw);
    if (owner === 'wait') return false;
    $.lastSoulOn = null;
    var data = owner && $dataActors[owner];
    if (!data) return _command101SoulLine.apply(this, arguments);
    $.soulLineName = data.name;
    try {
        return _command101SoulLine.apply(this, arguments);
    } finally {
        $.soulLineName = null;
    }
};

$.soulLineName = null;
var _messageAddSoulLine = Game_Message.prototype.add;
Game_Message.prototype.add = function(text) {
    if ($.soulLineName && typeof text === 'string' && $.SOUL_LINE_RE.test(text)) {
        text = text.replace(/^You absorbed/i, $.soulLineName + ' absorbed');
    }
    _messageAddSoulLine.call(this, text);
};


// Guest belongings around saves and loads (a guest's gun and book were gone
// after a load): what the host has for each guest goes to the log.
$.guestKitLine = function(c) {
    var a = c && c.actorId ? $gameActors.actor(c.actorId) : null;
    var inv = $.inventoryOf(c);
    var equips = a ? a._equips.map(function(e) { return e ? (e._dataClass === 'weapon' ? 'w' : 'a') + e._itemId : 0; }) : [];
    return c.name + ' equips ' + JSON.stringify(equips) + ' weapons ' + JSON.stringify(inv.w || {}) +
        ' items ' + JSON.stringify(inv.i || {});
};

var _saveGameKit = DataManager.saveGame;
DataManager.saveGame = function(savefileId) {
    if ($.isHost()) {
        $.clients.forEach(function(c) {
            if (c.actorId && c.name && !c._sub) {
                $.dlog('save', savefileId, $.guestKitLine(c), c.roam ? '(its map: last report)' : '',
                    c._menuBase ? '(menu open)' : '');
            }
        });
    }
    return _saveGameKit.call(this, savefileId);
};

var _onLoadSuccessKit = Scene_Load.prototype.onLoadSuccess;
Scene_Load.prototype.onLoadSuccess = function() {
    if ($.isHost()) {
        $.clients.forEach(function(c) {
            if (c.actorId && c.name && !c._sub) $.dlog('loaded', $.guestKitLine(c));
        });
    }
    _onLoadSuccessKit.call(this);
};

var _syncMeKit = $.hostHandlers.syncMe;
$.hostHandlers.syncMe = function(conn, msg) {
    var a = conn && conn.actorId ? $gameActors.actor(conn.actorId) : null;
    var before = a ? JSON.stringify(a._equips.map(function(e) { return e && e._itemId; })) : '';
    _syncMeKit(conn, msg);
    a = conn && conn.actorId ? $gameActors.actor(conn.actorId) : null;
    var after = a ? JSON.stringify(a._equips.map(function(e) { return e && e._itemId; })) : '';
    if (before !== after) $.dlog('equipment of', conn.name, before, '->', after);
};


//=============================================================================
// Sleeping together
//=============================================================================
// Original (data): a bed's first page (Map005 EV114 ...) dims the screen,
// hides the player and turns SW463 SLEEPING on; that map's autorun pages on
// SW463 (one per SELECT switch) set the wake spot (SW561-571 Tower_*) and
// move the sleeper to the dream (Map032 at 5,14). Map032 EV7 runs CE303 (the
// day passes), Perkele talks, the Hexen board (Map031) is one choice; then
// SW2919 Wake_up on, SW463 off and CE440 takes the sleeper back to the bed
// (by SW561-571), where that map's Wake_up page shows the waking.
//
// Co-op: SW463, SW2919 and the wake spot are each player's own (in a guest's
// context its own values, like the SELECT switch; never in the world sync),
// so one player's bed starts nobody else's dream. When the bed vote passed
// and its player goes to the dream, the other players on that map who can
// (not busy, not down) lie down too and each goes to its own dream on its own
// PC (the host on its own). The day passes once: in the host's dream when the
// host sleeps, else in the dream of the player who used the bed; the other
// dreams skip CE303 (its switches reach them with the world sync). The
// dream maps are nobody's shared map (no joining the host's or another
// guest's dream). Each wakes at the bed. Players elsewhere keep playing.
// The protagonist's sex (SW239 MALE_CLASS / SW240 FEMALE_CLASS, set with
// the SELECT switch on Map155) is each player's own too.

$.DREAM_MAP = 32;
$.DREAM_MAPS = { 31: true, 32: true }; // the dream and the Hexen board
$.DAY_CE = 303;
$.WAKE_SWITCH = 2919;
$.OWN_SWITCHES = [$.SLEEPING_SWITCH, $.WAKE_SWITCH];
for (var ows = 561; ows <= 571; ows++) $.OWN_SWITCHES.push(ows);
$.OWN_SW = {};
$.OWN_SWITCHES.forEach(function(id) { $.OWN_SW[id] = true; });
$.OWN_PAGE_SW = {}; // the ones with pages of their own (autorun / parallel)
$.OWN_PAGE_SW[$.SLEEPING_SWITCH] = true;
$.OWN_PAGE_SW[$.WAKE_SWITCH] = true;
// The dream's own state (INTRO1-5, SHADOWS, Perkele_talking,
// Coming_back_from_hexen, AMMO_HUD_OFF, day_change_text; V1897): each PC's.
$.DREAM_PC_SWITCHES = [2843, 2844, 2845, 2846, 2847, 2848, 2859, 2879, 3259, 4712];
$.DREAM_PC_V = { 1897: true };
$.GENDER_SWITCHES = [239, 240];
$.GENDER_OF_ACTOR = { 1: 239, 4: 239, 6: 239, 13: 239, 3: 240, 5: 240, 14: 240, 15: 240 };
$.OWN_SWITCHES.concat($.DREAM_PC_SWITCHES, $.GENDER_SWITCHES).forEach(function(id) {
    $.NO_SYNC_SWITCHES[id] = true;
});

var _markWorldSleep = $.markWorld;
$.markWorld = function(kind, key, value) {
    if (kind === 'v' && $.DREAM_PC_V[key]) return;
    _markWorldSleep(kind, key, value);
};

var _applyWorldDeltaSleep = $.applyWorldDelta;
$.applyWorldDelta = function(d, pending, persist) {
    if (d && d.v && Object.keys(d.v).some(function(k) { return $.DREAM_PC_V[k]; })) {
        var v = {};
        Object.keys(d.v).forEach(function(k) { if (!$.DREAM_PC_V[k]) v[k] = d.v[k]; });
        d = Object.assign({}, d, { v: v });
    }
    return _applyWorldDeltaSleep(d, pending, persist);
};

$.setGender = function(sw, actorId) {
    var g = $.GENDER_OF_ACTOR[actorId];
    if (!g) return;
    $.GENDER_SWITCHES.forEach(function(id) { sw[id] = id === g; });
};

// Host / sub-host: a guest's own values (only the ones on).
$.ownSwitchesOf = function(conn) {
    if (!conn._fhOwnSw) conn._fhOwnSw = {};
    return conn._fhOwnSw;
};

$.ownCtx = null; // { conn, save }: a guest's own values are in the world

var _enterContextSleep = $.enterContext;
$.enterContext = function(conn) {
    _enterContextSleep(conn);
    if ($.ctx !== conn || ($.ownCtx && $.ownCtx.conn === conn)) return;
    var sw = $gameSwitches._data, save = {};
    var own = $.ownSwitchesOf(conn);
    $.OWN_SWITCHES.concat($.GENDER_SWITCHES).forEach(function(id) { save[id] = sw[id]; });
    $.OWN_SWITCHES.forEach(function(id) { sw[id] = !!own[id]; });
    $.setGender(sw, conn.actorId);
    $.ownCtx = { conn: conn, save: save };
};

var _exitContextSleep = $.exitContext;
$.exitContext = function(force) {
    var oc = $.ownCtx;
    _exitContextSleep(force);
    if (!oc || $.ctx === oc.conn) return;
    $.ownCtx = null;
    var sw = $gameSwitches._data, own = {};
    $.OWN_SWITCHES.forEach(function(id) { if (sw[id]) own[id] = true; });
    oc.conn._fhOwnSw = own;
    Object.keys(oc.save).forEach(function(id) { sw[id] = oc.save[id]; });
};

// Its PC runs them from now on (sendRoam): they go with the roam message.
$.SLEEP_MS = 120000; // (real time, $.clockMs)
$.takeOwnSwitches = function(conn) {
    if (!conn) return null;
    var nd = !!conn._fhSleepNd && $.clockMs() - conn._fhSleepNd <= $.SLEEP_MS;
    var out = { sw: conn._fhOwnSw || {}, nd: nd };
    conn._fhOwnSw = {};
    conn._fhSleepNd = 0;
    return out;
};

// A guest's own page (its bed's dream page, its waking) runs for it as its
// own event, like the host's run for the host.
$.ownPageOf = function(conn) {
    return $.inContext(conn, function() {
        var found = null;
        var on = function(valid, id) { return valid && $.OWN_PAGE_SW[id] && $gameSwitches.value(id); };
        $gameMap.events().some(function(ev) {
            if (!ev || ev._erased || ev._fhOwner) return false;
            var index = ev.findProperPageIndex();
            var page = index >= 0 ? ev.event().pages[index] : null;
            if (!page || (page.trigger !== 3 && page.trigger !== 4) || !page.list || page.list.length <= 1) return false;
            var c = page.conditions;
            if (!on(c.switch1Valid, c.switch1Id) && !on(c.switch2Valid, c.switch2Id)) return false;
            found = { ev: ev, page: page };
            return true;
        });
        return found;
    });
};

$.OWN_PAGE_EVERY = 10;
$.runOwnPages = function() {
    if (!$.runsWorld() || !$gameMap || !$.worldReady() || Graphics.frameCount % $.OWN_PAGE_EVERY !== 0) return;
    $.clients.forEach(function(conn) {
        var own = conn._fhOwnSw;
        if (!own || !Object.keys(own).some(function(id) { return own[id] && $.OWN_PAGE_SW[id]; })) return;
        if (!conn.actorId || !$.guestOnMap(conn) || $.isBusy(conn) || $.isDown(conn.guestId)) return;
        var found = $.ownPageOf(conn);
        if (!found) return;
        $.dlog('own page ev' + found.ev.eventId(), 'runs for', conn.name);
        $.runOwned(conn, found.page.list, null);
        // "this event" (no lock: another sleeper may use the same page)
        $.owned[conn.guestId].interp._eventId = found.ev.eventId();
    });
};
$.worldExtras.push(function() { $.runOwnPages(); });

// Host: a bed vote that passed (set by $.requestConsent below, also when the
// bed's player was alone on its map and nobody had to vote).
$.sleepVote = null; // { from, at, mapId }

// (a guest in its menu lies down when the menu closes: $.sleepersLate)
$.canLieDown = function(c) {
    return !!c.actorId && !!c.inGame && !c.solo && !c.subOf && $.guestOnMap(c) && !$.isBusy(c) &&
        !c._menuBase && !$.isDown(c.guestId) && !$.isDead(c.guestId);
};

$.layDownGuest = function(c) {
    if ($.sleepUndoTake) $.sleepUndoTake(c.guestId, $gameMap.mapId(), 0);
    $.ownSwitchesOf(c)[$.SLEEPING_SWITCH] = true; // its bed's dream page runs for it ($.runOwnPages)
    c._fhSleepNd = Math.max(1, $.clockMs());
    c.send({ t: 'cmd', c: 223, p: [[-255, -255, -255, 0], 40, false] });
    c.send({ t: 'cmd', c: 211, p: [0] });
    c.send({ t: 'toast', text: 'Co-op: you fall asleep with the others' });
};

$.hostCanLieDown = function() {
    return SceneManager._scene instanceof Scene_Map && !SceneManager.isSceneChanging() && !$.bgUpdate &&
        !$gameParty.inBattle() && !$gameMap.isEventRunning() && !$gamePlayer.isTransferring() &&
        !$.isDown('host') && !$.isDead('host') && !$gameMessage.isBusy();
};

// The host lies down like at the bed (Map005 EV114 page 0 after "Rest").
// Not inside a guest's context (its own SW463 is in the world then).
$.layDownHost = function() {
    if ($.ctx || !$.hostCanLieDown()) return false;
    $gameSwitches.setValue(202, true);
    $gameSwitches.setValue(410, true);
    $gameScreen.startTint([-255, -255, -255, 0], 40);
    $gamePlayer.setTransparent(true);
    $.sleepUndoTake('host', $gameMap.mapId(), 0);
    $gameSwitches.setValue($.SLEEPING_SWITCH, true); // the bed's dream page (autorun) takes the host
    $.toast('Co-op: you fall asleep with the others');
    return true;
};

// The player whose bed vote passed goes to the dream: the others lie down.
$.sleepTogether = function(starter) {
    var vote = $.sleepVote;
    if (!vote || vote.from !== starter || $.clockMs() - vote.at > $.SLEEP_MS) return;
    $.sleepVote = null;
    var hostSleeps = starter === 'host' || $.hostCanLieDown();
    if (starter !== 'host' && hostSleeps) $.hostToBed = Graphics.frameCount; // right after this guest's event
    var names = [];
    $.clients.forEach(function(c) {
        if (c.guestId === starter) {
            if (hostSleeps) c._fhSleepNd = Math.max(1, $.clockMs()); // the host's dream passes the day
            return;
        }
        if (!$.canLieDown(c)) return;
        $.layDownGuest(c);
        names.push(c.name);
    });
    $.dlog('sleeping together on map', $gameMap.mapId(), 'bed of', $.playerLabel(starter),
        hostSleeps && starter !== 'host' ? '+ host' : '', names.length ? '+ ' + names.join(', ') : '',
        '| the day passes in the dream of', hostSleeps ? 'the host' : $.playerLabel(starter));
};

// The host lies down outside the guest's context after the same-map vote.
// If it is busy now, the sleep monitor retries; it never advances the day alone.
$.hostToBed = 0;
$.worldExtras.push(function() {
    if (!$.hostToBed || $.ctx || !$.isHost()) return;
    $.hostToBed = 0;
    if ($.layDownHost()) return;
    $.dlog('sleeping together: the host is still busy; it will lie down when free');
    if ($.onHostStaysAwake) $.onHostStaysAwake(); // (the sleep barrier, end of file)
});

// A guest's transfer into the dream (its bed's dream page on the host).
var _fhGuestTransferSleep = Game_Interpreter.prototype.fhGuestTransfer;
Game_Interpreter.prototype.fhGuestTransfer = function() {
    if ($.isHost() && this._fhOwner && $.ctx && !$gameMessage.isBusy() &&
            $gameSwitches._data[$.SLEEPING_SWITCH] && $.transferSpot(this).m === $.DREAM_MAP) {
        $.sleepTogether(this._fhOwner);
    }
    return _fhGuestTransferSleep.call(this);
};

// The host's own transfer into the dream.
var _reserveTransferSleep = Game_Player.prototype.reserveTransfer;
Game_Player.prototype.reserveTransfer = function(mapId, x, y, d, fadeType) {
    if ($.isHost() && !$.ctx && !this._fhRemoteId && mapId === $.DREAM_MAP &&
            $gameSwitches._data[$.SLEEPING_SWITCH]) {
        $.sleepTogether('host');
    }
    _reserveTransferSleep.call(this, mapId, x, y, d, fadeType);
};

var _resetRoamsSleep = $.resetRoams;
$.resetRoams = function() {
    _resetRoamsSleep();
    $.sleepVote = null;
    $.hostToBed = 0;
    $.clients.forEach(function(c) {
        c._fhOwnSw = {};
        c._fhSleepNd = 0;
    });
};

// Guest: its own values come with the roam message (not the host's).
$.skipDayUntil = 0;

$.applyOwnSwitches = function(own) {
    var sw = $gameSwitches._data, on = (own && own.sw) || {};
    $.OWN_SWITCHES.forEach(function(id) { sw[id] = !!on[id]; });
    $.DREAM_PC_SWITCHES.forEach(function(id) { sw[id] = false; });
    $.setGender(sw, $.myActorId);
    $.skipDayUntil = own && own.nd ? $.clockMs() + $.SLEEP_MS : 0;
};

var _command117Sleep = Game_Interpreter.prototype.command117;
Game_Interpreter.prototype.command117 = function() {
    if (this._params[0] === $.DAY_CE && $.isGuest() && $.isRoaming() && $.skipDayUntil &&
            $.clockMs() <= $.skipDayUntil && $gameMap.mapId() === $.DREAM_MAP) {
        $.skipDayUntil = 0;
        $.dlog('the day passes in another dream (sleeping together): CE303 skipped here');
        return true;
    }
    return _command117Sleep.call(this);
};

// Back on the host's map: its own values (awake at the bed: Wake_up) go first.
var _sendUnroamSleep = $.sendUnroam;
$.sendUnroam = function(spot, interpJson) {
    if ($.conn) {
        var sw = {};
        $.OWN_SWITCHES.forEach(function(id) { if ($gameSwitches._data[id]) sw[id] = true; });
        $.conn.send({ t: 'ownSw', sw: sw });
    }
    _sendUnroamSleep(spot, interpJson);
};

$.hostHandlers.ownSw = function(conn, msg) {
    if (!conn.roam || !msg) return;
    var own = {};
    Object.keys(msg.sw || {}).forEach(function(id) { if ($.OWN_SW[id] && msg.sw[id]) own[id] = true; });
    conn._fhOwnSw = own;
};

var _leaveAsGuestSleep = $.leaveAsGuest;
$.leaveAsGuest = function(message) {
    $.skipDayUntil = 0;
    _leaveAsGuestSleep(message);
};

// User rule (2026-10-19, beds across maps 2026-10-22, v0.41): time passes
// only with everyone together. A bed (a page that turns SW463 on; data audit:
// all 54 player-started time pages are beds, the other CE303/305 pages are
// autorun / parallel) is voted on by the living players on the bed's map who
// are not in bed yet; nobody else is asked. The ones who agreed lie down
// together (the sleep group, end of file); everyone on other maps is in the
// group's roster as awake and lies down in any bed of its own (its own map's
// vote). Only when every living player is in bed do they all go to their
// dreams; the day passes once. A vote without a bed (none in the data) still
// needs everyone on the starter's map ("Everyone must be here to rest.").
// Captive scenes that pass days by themselves (crucified Map016 EV354, tied
// up Map014 EV183/202, Map067 EV120, the train intro) are story, not rest.
$.WAIT_WAKE_TEXT = 'Wait for the others to wake up.';
$.REST_TOGETHER_TEXT = 'Everyone must be here to rest.';

$.playerMapOfRest = function(id) {
    if (id === 'host') return $gameMap.mapId();
    var c = $.clientById(id);
    if (!c) return 0;
    if (c.roam || c.roamPending || c.subOf) return c.lastPos && c.lastPos.m || 0;
    return $.guestOnMap(c) ? $gameMap.mapId() : (c.lastPos && c.lastPos.m || $gameMap.mapId());
};

$.restLivingIds = function() {
    return ($.isDead('host') ? [] : ['host']).concat($.activeGuests().filter(function(c) {
        return !$.isDead(c.guestId);
    }).map(function(c) { return c.guestId; }));
};

$.restAway = function(fromId) {
    var here = $.playerMapOfRest(fromId);
    var ids = ($.isDead('host') ? [] : ['host']).concat($.activeGuests().filter(function(c) {
        return !$.isDead(c.guestId);
    }).map(function(c) { return c.guestId; }));
    return ids.filter(function(id) { return id !== fromId && $.playerMapOfRest(id) !== here; });
};

$.restRefused = false;
var _requestConsentTogether = $.requestConsent;
$.requestConsent = function(fromId, cb, opts) {
    $.restRefused = false;
    if ($.isHost() && !$.consent && opts && opts.sleep) {
        var g = $.sleepGroup;
        if (g && g.go1 && !g.go2) {
            // the others dream already (this one was down then): no second night
            $.restRefused = true;
            $.dlog('bed refused for', $.playerLabel(fromId), '- the others dream');
            var wait = 'Co-op: ' + $.WAIT_WAKE_TEXT;
            if (fromId === 'host') $.toast(wait); else $.sendTo(fromId, { t: 'toast', text: wait });
            return;
        }
        opts = Object.assign({}, opts);
        var bedMap = Number(opts.mapId) || $.playerMapOfRest(fromId);
        opts.mapId = bedMap;
        opts.voters = $.restLivingIds().filter(function(id) {
            return id === fromId || ($.playerMapOfRest(id) === bedMap && !$.sleepInBed(id));
        });
    } else if ($.isHost() && !$.consent && !(opts && opts.text)) { // (a vote on time, not another question)
        var away = $.restAway(fromId);
        if (away.length) {
            $.restRefused = true;
            $.dlog('rest refused for', $.playerLabel(fromId), '- away:', away.map($.playerLabel).join(', '));
            var text = 'Co-op: ' + $.REST_TOGETHER_TEXT;
            if (fromId === 'host') $.toast(text); else $.sendTo(fromId, { t: 'toast', text: text });
            return;
        }
    }
    if ($.isHost() && opts && opts.sleep) {
        var requested = cb;
        cb = function() {
            var bedMap = Number(opts.mapId) || $.playerMapOfRest(fromId);
            $.sleepVote = { from: fromId, at: $.clockMs(), mapId: bedMap };
            // a bed this PC runs (the host's, a guest's on the host's map): its values before
            if (bedMap === $gameMap.mapId()) $.sleepUndoTake(fromId, bedMap, Number(opts.eventId) || 0);
            requested();
        };
    }
    _requestConsentTogether(fromId, cb, opts);
};

// a roaming guest (or a sub-host) waiting for the answer gets a no at once
var _consentReqTogether = $.hostHandlers.consentReq;
$.hostHandlers.consentReq = function(conn, msg) {
    _consentReqTogether(conn, msg);
    if ($.restRefused) {
        $.restRefused = false;
        conn.send({ t: 'askNo', id: msg.id });
    }
};

/// Everyone falls asleep: one busy then (its event, a fight) lies down as soon
// as it is free, within the time a dream lasts.
// It never could (play test 2026-10-19): the host leaving for its dream left
// the busy guest behind (roamPending), which is not "on the host's map", so
// the check waited the whole 2 minutes. The entry keeps the bed's map; a
// guest still there when it is free lies down where it is:
// - on the host's map (the host is back): as before, its dream page runs here;
// - left behind, not running the map yet (roamPending): its own SW463 and the
//   day skip go with the roam that is sent to it now that it is free
//   (sendRoam: own), and its PC runs its own dream page (Map020 EV191 p2 ...);
// - running the map on its own PC already: 'sleepNow' does it there.
$.sleepersLate = []; // host: [{ id, until, m }] (m: the bed's map)

var _sleepTogetherLate = $.sleepTogether;
$.sleepTogether = function(starter) {
    var vote = $.sleepVote;
    var live = !!vote && vote.from === starter && $.clockMs() - vote.at <= $.SLEEP_MS;
    _sleepTogetherLate(starter);
    if (!live) return;
    var m = $gameMap.mapId();
    $.clients.forEach(function(c) {
        if (c.guestId === starter || $.canLieDown(c) || $.ownSwitchesOf(c)[$.SLEEPING_SWITCH]) return;
        if (!c.actorId || c.solo || $.isDead(c.guestId)) return;
        if ($.playerMapOfRest(c.guestId) !== m) return; // (everyone was here for the vote)
        $.sleepersLate.push({ id: c.guestId, until: $.clockMs() + $.SLEEP_MS, m: m });
        $.dlog('sleeping together:', c.name, 'is busy - lies down when free', $.notSleepingWhy(c));
    });
};

// why a guest cannot lie down now (for the log)
$.notSleepingWhy = function(c) {
    var why = [];
    if ($.owned[c.guestId]) why.push('its event');
    if (c.inBattle) why.push('a fight');
    if (c.waitingConsent) why.push('a vote');
    if ($.isDown(c.guestId)) why.push('down');
    if (c.roam) why.push('roaming');
    if (c.roamPending) why.push('left behind');
    if (c.subOf) why.push('on a sub-host');
    return why.length ? '(' + why.join(', ') + ')' : '';
};

// a guest running the bed's map lies down there (its own PC: sleepNow below)
$.sendSleepNow = function(c, m) {
    c.send({ t: 'sleepNow', m: m, nd: true });
};

$.lateSleeperFree = function(c) {
    return !!c.actorId && !!c.inGame && !c.solo && !$.isBusy(c) && !c._menuBase &&
        !$.isDown(c.guestId) && !$.isDead(c.guestId);
};

$.worldExtras.push(function() {
    if (!$.isHost() || !$.sleepersLate.length) return;
    $.sleepersLate = $.sleepersLate.filter(function(s) {
        var c = $.clientById(s.id);
        if (!c || $.isDead(s.id)) return false;
        if ($.clockMs() > s.until && !($.sleepGroup && $.sleepGroup.split)) {
            $.dlog('sleeping together:', c.name, 'stayed busy too long - stays awake', $.notSleepingWhy(c));
            $.sleepSet(s.id, 'out', 'stayed busy too long on its map');
            return false;
        }
        if ($.ownSwitchesOf(c)[$.SLEEPING_SWITCH]) return false; // asleep already
        var m = s.m || $gameMap.mapId();
        var on = c.roamPending ? (c.roamPending.m || (c.lastPos && c.lastPos.m)) : $.playerMapOfRest(c.guestId);
        if (on && on !== m) {
            // it left that map (its event took it away): it lies down in a bed itself (review S3)
            var lm = $.sleepGroup && $.sleepGroup.members[c.guestId];
            if (lm && lm.st === 'scene') $.sleepSet(c.guestId, $.sleepGroup.split ? 'awake' : 'out', 'left the bed\'s map');
            $.dlog('sleeping together:', c.name, 'left map', m, '- not laid down there');
            return false;
        }
        if (c.subOf) {
            var owner = $.clientById(c.subOf), g = $.sleepGroup;
            if (!g || g.go2 || !owner || $.isDown(c.guestId) || !c.lastPos || c.lastPos.m !== m) return false;
            $.sleepJoin(c.guestId);
            c.send($.sleepInfo(g, c.guestId));
            owner.send(Object.assign({}, $.sleepInfo(g, c.guestId), { t: 'sleepSubInfo',
                who: c.guestId, groupId: g.id, mapId: m, sc: g.members[c.guestId].sc }));
            owner.send({ t: 'sleepSub', who: c.guestId, groupId: g.id, mapId: m,
                sc: g.members[c.guestId].sc, split: !!g.split });
            $.dlog('sleeping together:', c.name, 'joins through sub-host on map', m);
            return false;
        }
        if (!$.lateSleeperFree(c)) return true;
        if ($.guestOnMap(c)) {
            if ($gameMap.mapId() !== m) return true;
            $.layDownGuest(c);
            $.dlog('sleeping together:', c.name, 'lies down now');
            return false;
        }
        var left = c.roamPending ? (c.roamPending.m || (c.lastPos && c.lastPos.m)) : 0;
        if (c.roamPending && left === m) {
            // the next sync's roam carries its SW463 and the day skip
            $.layDownGuest(c);
            $.dlog('sleeping together:', c.name, 'lies down now - its own PC runs its dream (map ' + m + ')');
            return false;
        }
        if (c.roam && c.lastPos && c.lastPos.m === m) {
            $.sendSleepNow(c, m);
            $.dlog('sleeping together:', c.name, 'lies down now on its own PC (map ' + m + ')');
            return false;
        }
        return true;
    });
});

// Guest running the bed's map itself: it lies down there once its own game
// is free (like the bed's first page: dark, hidden, SW463 on - that map's
// dream page takes it to its own dream; the day passed in another one).
$.sleepNowPending = null; // guest: { m, nd, until }
$.guestHandlers.sleepNow = function(msg) {
    if (!$.isRoaming() && !$.pendingRoam) return;
    $.sleepNowPending = { m: Number(msg.m) || 0, nd: !!msg.nd, until: $.clockMs() + $.SLEEP_MS };
};

$.guestExtras.push(function() {
    var s = $.sleepNowPending;
    if (!s || $.pendingRoam) return;
    if (!$.isRoaming() || $.clockMs() > s.until || (s.m && $gameMap.mapId() !== s.m)) {
        $.sleepNowPending = null;
        // (the host counted it in bed: it is awake after all - review M1)
        if ($.sleepMine && $.conn) $.conn.send({ t: 'sleepAt', id: $.sleepMine.id, at: 'awake' });
        return;
    }
    if (!$.roamIdle() || $.isDownMe()) return;
    $.sleepNowPending = null;
    $.sleepUndoTake($.myId, $gameMap.mapId(), 0);
    $gameSwitches.setValue($.SLEEPING_SWITCH, true); // (each PC's own: not in the world sync)
    if (s.nd) $.skipDayUntil = $.clockMs() + $.SLEEP_MS;
    $gameScreen.startTint([-255, -255, -255, 0], 40);
    $gamePlayer.setTransparent(true);
    $.floorSleep = { m: $gameMap.mapId() }; // (curled up where it stands: "Lying pictures")
    $gameMap.requestRefresh();
    $.toast('Co-op: you fall asleep with the others');
    $.dlog('sleeping together: lies down here (its own map ' + $gameMap.mapId() + ')');
});

// A guest that went to sleep in a roam message: it lies in its bed (the
// bed's first page hid it) until its dream page takes it.
var _startRoamAsleep = $.startRoam;
$.startRoam = function(msg) {
    _startRoamAsleep(msg);
    var own = msg && msg.own && msg.own.sw;
    if (own && own[$.SLEEPING_SWITCH] && $gamePlayer) $gamePlayer.setTransparent(true);
};

var _leaveAsGuestLate = $.leaveAsGuest;
$.leaveAsGuest = function(message) {
    $.sleepNowPending = null;
    _leaveAsGuestLate(message);
};

// A snapshot (the host loaded a save, or this guest is back in the host's
// game): a "lie down" still waiting is from the world before. (A roam right
// after the load's snapshot could otherwise put it to sleep in the loaded
// world, its day skipped.)
var _snapSleepNow = $.guestHandlers.snap;
$.guestHandlers.snap = function(msg) {
    $.sleepNowPending = null;
    return _snapSleepNow(msg);
};

// The host leaves a map (its own dream, a door): a guest left there kept the
// host's last screen - the dream page's white tint, under its own vision
// circle "a white circle on black" (play test 2026-10-19). It gets the screen
// the host had while no event of the host's ran (the map's own look), or its
// own event's tint while that event still runs.
$.freeScreen = null; // host / sub-host: { m, t, b } while no event of its own runs
$.worldExtras.push(function() {
    if (!$.runsWorld() || !$gameScreen || !$gameMap || !$gameMap.mapId()) return;
    var mapId = $gameMap.mapId();
    if ($.DREAM_MAPS[mapId] || $gameMap.isEventRunning()) return;
    // a new record only when it changed (it was a new object every frame)
    var t = $gameScreen.tone(), b = Math.round($gameScreen.brightness()), f = $.freeScreen;
    if (f && f.m === mapId && f.b === b && f.t[0] === t[0] && f.t[1] === t[1] && f.t[2] === t[2] && f.t[3] === t[3]) return;
    $.freeScreen = { m: mapId, t: t.slice(), b: b };
});

$.leftScreen = function(c) {
    var entry = c && $.owned[c.guestId];
    // (one taken on the map before - the host was never free on this one, a
    // scene that went on through it - is not this map's look)
    var free = $.freeScreen && $.freeScreen.m === $gameMap.mapId() ? $.freeScreen : { t: [0, 0, 0, 0], b: 255 };
    return {
        t: (entry && entry.tint ? entry.tint : free.t).slice(),
        b: entry && entry.faded ? 0 : free.b
    };
};

$.leavingScreen = null; // host: set while leaveGuestsBehind sends its roams

var _leaveGuestsBehindScreen = $.leaveGuestsBehind;
$.leaveGuestsBehind = function(newMapId) {
    var pending = {};
    $.clients.forEach(function(c) { pending[c.guestId] = !!c.roamPending; });
    $.leavingScreen = $.leftScreen(null);
    try {
        _leaveGuestsBehindScreen(newMapId);
    } finally {
        $.leavingScreen = null;
    }
    // busy ones: still on the host's view of that map, waiting for their roam
    $.clients.forEach(function(c) {
        if (!c.roamPending || pending[c.guestId]) return;
        var scr = $.leftScreen(c);
        c.send({ t: 'scrFix', tone: scr.t, b: scr.b });
        $.dlog('left', c.name, 'busy on map', $gameMap.mapId(), '- its screen: tone', JSON.stringify(scr.t),
            'brightness', scr.b);
    });
};

// the ones sent their map now: not the host's departing screen either
var _sendRoamScreen = $.sendRoam;
$.sendRoam = function(conn, opts) {
    if ($.leavingScreen && !(opts && opts.interp)) opts = Object.assign({}, opts || {}, { scr: $.leavingScreen });
    return _sendRoamScreen(conn, opts);
};

$.guestHandlers.scrFix = function(msg) {
    if (!$gameScreen || $.isRoaming() || !Array.isArray(msg.tone)) return;
    var sc = $gameScreen;
    sc._tone = msg.tone.slice();
    sc._toneTarget = msg.tone.slice();
    sc._toneDuration = 0;
    if (typeof msg.b === 'number') {
        sc._brightness = msg.b;
        sc._fadeOutDuration = 0;
        sc._fadeInDuration = 0;
    }
    $.dlog('screen set back after the host left: tone', JSON.stringify(msg.tone), 'brightness', msg.b);
};

var _resetRoamsLate = $.resetRoams;
$.resetRoams = function() {
    _resetRoamsLate();
    $.sleepersLate = [];
};


//=============================================================================
// Another player's gun in a fight on this PC
//=============================================================================
// Original (data): every troop calls CE240-245 (Character_battleGFX) each
// turn; for each party member with a gun it checks the party's bag for that
// gun's ammo (Conditional Branch: item 75 / 77 / 78) and otherwise says
// "... is out of ammo, so ... continues unarmed" and unequips it (Change
// Equipment). In co-op the party's bag in a fight is the bag of the player
// whose PC runs it; a joiner's own ammo is in its own bag. So a joiner's gun
// was taken off (into the fight owner's bag) when the owner had no ammo for
// it: "the gun vanished". Here a fight never unequips another player's gun
// (its own outfit check on the map does, with its own bag).

$.FIELD_GUNS = { 10: true, 11: true, 12: true, 13: true };

$.mineHere = function(actorId) {
    return actorId === ($.isHost() ? $.hostActorId() : $.myActorId);
};

var _command319Gun = Game_Interpreter.prototype.command319;
Game_Interpreter.prototype.command319 = function() {
    var p = this._params;
    var actor = $.role && $gameParty.inBattle() ? $gameActors.actor(p[0]) : null;
    if (actor && p[1] === 1 && !p[2] && $.SELECT_OF_ACTOR[p[0]] && !$.mineHere(p[0]) &&
            actor.weapons().some(function(w) { return w && $.FIELD_GUNS[w.id]; })) {
        $.dlog('fight: kept the gun of', actor.name(), '(its ammo is in its own bag)');
        return true;
    }
    return _command319Gun.call(this);
};

// Host: a guest's equipment changing on this PC goes to the log (the cause).
var _changeEquipLog = Game_Actor.prototype.changeEquip;
Game_Actor.prototype.changeEquip = function(slotId, item) {
    var watch = $.role && $.isHost() && $.SELECT_OF_ACTOR[this._actorId] && !$.mineHere(this._actorId) &&
        $.clients.some(function(c) { return c.actorId === this._actorId; }, this);
    var before = watch && this._equips[slotId] ? this._equips[slotId]._itemId : 0;
    _changeEquipLog.call(this, slotId, item);
    if (!watch) return;
    var after = this._equips[slotId] ? this._equips[slotId]._itemId : 0;
    if (before !== after) {
        $.dlog('equip of', this.name(), 'slot', slotId, before, '->', after, 'on the host:',
            $gameParty.inBattle() ? 'in a fight' : ($.ctx ? 'its event' : 'the host world'));
    }
};

// A stand-in for nobody (FH_CoopWorld: nobody alive on the map) starts
// nothing. Outermost, so no wrapper takes it for a guest first.
// a stand-in for nobody starts nothing
var _gameEventStartNobody = Game_Event.prototype.start;
Game_Event.prototype.start = function() {
    if ($gamePlayer && $gamePlayer._fhRemoteId === $.NOBODY) return;
    _gameEventStartNobody.call(this);
};

//=============================================================================
// Defeat scenes: the original capture when everyone standing lost together
//=============================================================================
// User decision (2026-10-19, docs/기획_정리.md "사망 — 그로기 시스템"):
// a battle that can be lost whose "if lose" branch moves the player (a 201,
// also in the common events it calls; FH_CoopBattle $.defeatScene: the
// villagers 10/21 -> pig pen Map016, the priest 14 -> cross Map016, the
// needles 40 -> Map050, Stitches 162/163 -> Map116, the neighbour 80 ->
// Map129) runs that branch as in the original only when every player
// standing (not down, not dead, connected, past the tutorial) fought it and
// they all lost. All of them go there. Anything else (someone standing
// outside the fight, someone who ran from it) stays the co-op down; so does
// a branch without a transfer (CE66 + CE47 game over).
//
// Who decides, at the defeat:
// - the PC running its own fight (the host's, a roaming guest's): in
//   BattleManager.processDefeat, with the fight's owner and joiners. "Can
//   lose" is turned back on, so the engine ends it as the original: the
//   party back to 1 HP, the event takes its "if lose" branch.
// - the PC running the map of a guest's event fight (the host, a sub-host):
//   when the result comes (battleEnd).
// The player of the PC that decides leads when it was in the fight (else the
// fight's owner): it runs the branch (its own event, or the event of the
// fight). The others wait (a thin guest's PC as in an event of its own)
// until the leader's transfer, then each runs the commands the leader ran
// (its path: the branch's conditions as the leader took them, so a random
// one like the neighbour's 1 in 3 is the same for all) as its own event on
// the PC that runs its map: CE66, HP and states on its own character, the
// screen tint, the message, then the same transfer, after the leader's (a
// thin guest follows it onto the new map, whose scene the leader's PC
// runs). The leader's run ending without a transfer (CE47: the game over
// in the branch) puts the others down too.
// The scene holds the others while they stand on the arrival spot: they
// mirror the leader's transparency and menu, and fall with it (the cross:
// boxed in on one tile, nobody could revive the one who lies there). The
// scene lets go when the leader leaves the map or is free (visible, menu on,
// no event) for a moment.
// CE352 REMOVE_PARTY (the needles) kills the companions in the party: the
// death switch, V201 - 1. In co-op another player's character is never one
// of them. (CE51 REMOVEmembers, the neighbour, only takes them out of the
// party: Change Party never removes a player in co-op.)

// (times in ms, real time: $.clockMs; drawn frames run as fast as the screen)
$.SCENE_WAIT_MS = 120000;  // the others wait this long for the leader's transfer
$.SCENE_FREE_MS = 2000;    // the leader free this long: the scene holds nobody
$.SCENE_KEEP_MS = 600000;
$.SCENE_AWAY_MS = 60000;   // a deciding PC's word: this long after the wait (the fight still ends there)
$.SCENE_RESEND_MS = 2000;  // the hold's commands again now and then
$.SCENE_DEFER_MS = 10000;  // a sub-host's own fall waits this long for its guest's fight result
$.SCENE_TEXT = 'everyone lost the fight - you are taken away together';
$.REMOVE_PARTY_CE = 352;
// commands a follower's path leaves out (the branch's flow, taken already)
$.SCENE_FLOW_CODES = { 0: 1, 111: 1, 411: 1, 412: 1, 112: 1, 113: 1, 413: 1, 402: 1, 403: 1, 404: 1, 118: 1, 119: 1 };
// lines a command reads itself (never executed on their own)
$.SCENE_MORE_LINES = { 101: 401, 105: 405, 108: 408, 355: 655 };
$.scenes = {};       // id -> scene
$.sceneRec = [];     // scenes whose leader's path is being written
$.nextSceneId = 1;
$.sceneOwn = null;   // this PC's own player leads with its own run when free: scene
$.sceneHold = null;  // { sc, leaderId, members: { id: { held, tr, menu } }, freeSince }
$.sceneDeferDown = null; // sub-host: { bid, at } its own fall in its guest's fight
$.sceneAway = {};     // host: deciding guest id -> { player id: time } (its word awaited)
$.sceneAwayPark = {}; // host: thin guest id -> its held event while it waits for that word
$.sceneSent = {};     // host: roaming guest id -> time its part was passed on (sceneSelf)

// Players standing now, as this PC knows them (a guest: the roster + pstate).
$.standingPlayers = function() {
    if ($.isHost()) {
        var ids = $.isDown('host') ? [] : ['host']; // down or dead
        $.activeGuests().forEach(function(c) {
            if (!$.isDown(c.guestId)) ids.push(c.guestId);
        });
        return ids;
    }
    // (the roster's own "dead" may be from before a load; pstate is resent)
    return ($.roster || []).filter(function(p) {
        if (!p || !p.a || p.np) return false;
        var st = p.id === $.myId ? $.myState :
            $.pstateOf[p.id] || ($.deadIds[p.id] ? 'dead' : $.downIds[p.id] ? 'down' : '');
        return !st;
    }).map(function(p) { return p.id; });
};

// The roster tells the guests who is not playing yet (lobby, solo tutorial).
var _buildRosterScene = $.buildRoster;
$.buildRoster = function() {
    _buildRosterScene();
    ($.roster || []).forEach(function(p) {
        var c = p.id === 'host' ? null : $.clientById(p.id);
        if (c && (!c.inGame || !c.actorId || c.solo)) p.np = 1;
    });
};

var _onSoloDoneScene = $.onSoloDone;
$.onSoloDone = function(conn, msg) {
    var was = conn.solo;
    _onSoloDoneScene(conn, msg);
    if (was !== false && conn.solo === false && $.broadcastRoster) $.broadcastRoster();
};

// fought: the ids in the fight at its end.
$.sceneDefeatOk = function(fought) {
    var out = $.standingPlayers().filter(function(id) { return fought.indexOf(id) < 0; });
    $.dlog('defeat scene:', out.length ? 'no - standing outside the fight: ' + out.join(', ') : 'yes',
        '- fought:', fought.join(', '));
    return !out.length;
};

// 'own': this PC's player; 'mine': a thin guest on this PC's map; '': the
// map of that player runs elsewhere.
$.sceneSide = function(id) {
    if (id === $.myPlayerId()) return 'own';
    var c = $.clientById(id);
    if (!c || !c.actorId) return '';
    if ($.isHost()) return !c.roam && !c.roamPending && !c.subOf && !c.solo && $.guestOnMap(c) ? 'mine' : '';
    return c._sub ? 'mine' : '';
};

// As the original defeat that can be lost: a dead character gets 1 HP.
$.reviveForScene = function(actor) {
    if (actor && actor.isDead()) actor.setHp(1);
    return actor;
};

$.revivedJson = function(json) {
    var actor = json ? $.parseActor(json) : null;
    return actor ? $.actorJson($.reviveForScene(actor)) : json;
};

$.ownSceneActor = function() {
    return $gameActors.actor($.isHost() ? $.hostActorId() : $.myActorId);
};

// branch: { list, from, to } ($.defeatScene); others: the rest of the fight.
$.newScene = function(branch, leaderId, others) {
    var now = $.clockMs();
    var sc = { id: $.nextSceneId++, branch: branch, leaderId: leaderId, others: others, waiting: {}, parked: {},
        lead: null, leadList: null, from: 0, to: 0, leadPending: false, path: [], moved: false, moveIndex: -1,
        spot: null, done: false, at: now, until: now + $.SCENE_WAIT_MS, marks: [],
        world: $gameMap }; // a load (or a snapshot, a new roam) makes a new world: then it is gone
    $.scenes[sc.id] = sc;
    return sc;
};

// The interpreters running a scene are known here only (nothing on them:
// they are saved, and sent with a hand-off), each with the list it had then
// (a map interpreter runs other events later).
$.markScene = function(sc, interp) {
    if (interp) sc.marks.push({ interp: interp, list: interp._list });
};

$.sceneOf = function(interp) {
    var found = null;
    Object.keys($.scenes).forEach(function(k) {
        var sc = $.scenes[k];
        if (!found && sc.marks.some(function(m) { return m.interp === interp && m.list === interp._list; })) found = sc;
    });
    return found;
};

// from / to: where the branch is in the leader's list.
$.setSceneLead = function(sc, interp, from, to) {
    sc.lead = interp || null;
    sc.leadList = interp ? interp._list : null;
    sc.from = from || 0;
    sc.to = to || (sc.leadList ? sc.leadList.length : 0);
    sc.leadPending = false;
    $.markScene(sc, interp);
    if (interp && $.sceneRec.indexOf(sc) < 0) $.sceneRec.push(sc);
};

$.sceneRecDone = function(sc) {
    $.sceneRec = $.sceneRec.filter(function(x) { return x !== sc; });
};

// (a guest leading with its event here: gone with its connection or event)
$.sceneLeadActive = function(sc) {
    if (sc.leadPending) return true;
    var i = sc.lead;
    if (!i || !i._list || i._list !== sc.leadList || !i.isRunning()) return false;
    if (sc.leaderId === $.myPlayerId()) return true;
    var entry = $.owned[sc.leaderId];
    return !!$.clientById(sc.leaderId) && !!entry && $.interpInChain(entry.interp, i);
};

// (a player whose map another PC runs is told with bScene)
$.sceneToast = function(id) {
    var text = 'Co-op: ' + $.SCENE_TEXT;
    var side = $.sceneSide(id);
    if (side === 'own') $.toast(text); else if (side === 'mine') $.sendTo(id, { t: 'toast', text: text });
};

// The leader's path: the commands it ran in the branch.
var _executeCommandScene = Game_Interpreter.prototype.executeCommand;
Game_Interpreter.prototype.executeCommand = function() {
    for (var k = 0; k < $.sceneRec.length; k++) {
        var sc = $.sceneRec[k];
        if (sc.lead === this && !sc.moved && !sc.done && this._list === sc.leadList) {
            var i = this._index;
            if (i >= sc.from && i < sc.to && sc.path[sc.path.length - 1] !== i) sc.path.push(i);
        }
    }
    return _executeCommandScene.call(this);
};

// What a follower runs: the leader's path up to its transfer, the transfer
// and the rest of its block (indents from 0).
$.scenePathList = function(sc) {
    var src = sc.leadList || [];
    var out = [];
    var copy = function(c, ind) { return { code: c.code, indent: Math.max(0, c.indent - ind), parameters: c.parameters }; };
    sc.path.forEach(function(i) {
        var c = src[i];
        if (!c || i >= sc.moveIndex || $.SCENE_FLOW_CODES[c.code]) return;
        out.push(copy(c, c.indent));
        var more = $.SCENE_MORE_LINES[c.code];
        for (var k = i + 1; more && src[k] && src[k].code === more; k++) out.push(copy(src[k], c.indent));
    });
    var at = src[sc.moveIndex];
    for (var j = sc.moveIndex; at && j < sc.to && src[j] && src[j].indent >= at.indent; j++) out.push(copy(src[j], at.indent));
    var last = out[out.length - 1];
    if (!last || last.code !== 0 || last.indent !== 0) out.push({ code: 0, indent: 0, parameters: [] });
    return out;
};

// This PC's own fight was lost. The scene (or null).
$.sceneAtDefeat = function(info) {
    var ab = $.authBattle;
    if (!info || !info.list || !ab || ab.pvp || $.puppet || $.pvpBattle || $.localBattle) return null;
    if (ab.owner !== $.myPlayerId() || !$.coopNoLose()) return null;
    // one beheaded (or another death for good) in it: no capture scene
    if ($gameParty.battleMembers().some(function(a) { return !!$.doomOf(a); })) return null;
    var fought = [ab.owner].concat(ab.joiners);
    if (!$.sceneDefeatOk(fought)) return null;
    ab.ownerDown = false; // not down after it: it goes to the scene
    ab.joiners.forEach(function(id) { $.reviveForScene($.joinerActor(id)); });
    var sc = $.newScene(info, ab.owner, ab.joiners.slice());
    $.setSceneLead(sc, info.interp, info.from, info.to);
    return sc;
};

var _processDefeatScene = BattleManager.processDefeat;
BattleManager.processDefeat = function() {
    var sc = this._fhScene && !this._canLose ? $.sceneAtDefeat(this._fhScene) : null;
    // the original defeat: party to 1 HP, the event takes its "if lose" branch
    if (sc) this._canLose = true;
    _processDefeatScene.call(this);
    if (sc) $.sceneWaitOthers(sc, null);
};

// A parked event: it waits for the leader's transfer (then its PC runs the
// follower's path instead of it).
var _updateWaitModeScene = Game_Interpreter.prototype.updateWaitMode;
Game_Interpreter.prototype.updateWaitMode = function() {
    if (this._waitMode === 'fhScene') {
        var self = this;
        var parked = Object.keys($.scenes).some(function(k) {
            var p = $.scenes[k].parked;
            return Object.keys(p).some(function(id) { return p[id] === self; });
        }) || Object.keys($.sceneAwayPark).some(function(id) { return $.sceneAwayPark[id] === self; });
        if (parked) return true;
        this._waitMode = '';
        this._index = this._list ? this._list.length : 0; // nothing of it runs on its own
        return false;
    }
    return _updateWaitModeScene.call(this);
};

// After the decision: the leader runs, the others wait for its transfer.
// owner: { id, interp } of a guest whose event fight it was, when it follows.
$.sceneWaitOthers = function(sc, owner) {
    $.sceneToast(sc.leaderId);
    if (sc.leaderId === $.myPlayerId() && !sc.lead) {
        // this PC's player leads with its own run of the branch (a guest's
        // event fight it joined): as soon as nothing else runs here
        $.reviveForScene($.ownSceneActor());
        sc.leadPending = true;
        $.sceneOwn = sc;
    }
    var hold = { sc: sc, leaderId: sc.leaderId, members: {}, freeSince: -1 };
    sc.others.forEach(function(id) {
        $.sceneToast(id);
        var side = $.sceneSide(id);
        if (side === 'own') return; // (this PC's player leads whenever it fought)
        sc.waiting[id] = side || 'away';
        if (side !== 'mine') return;
        hold.members[id] = {};
        var interp = owner && owner.id === id ? owner.interp : null;
        if (!interp) {
            if ($.owned[id]) { // busy after all: down, as before
                delete sc.waiting[id];
                delete hold.members[id];
                $.dlog('defeat scene: busy, down instead', $.playerLabel(id));
                $.onPlayerDefeated(id);
                return;
            }
            $.runOwned($.clientById(id), [{ code: 0, indent: 0, parameters: [] }], null);
            interp = $.owned[id].interp;
        }
        interp.setWaitMode('fhScene');
        sc.parked[id] = interp;
    });
    // the host keeps who waits for this PC's word (down if this PC leaves)
    var away = Object.keys(sc.waiting).filter(function(id) { return sc.waiting[id] === 'away'; });
    if (away.length && $.isGuest() && $.conn) $.conn.send({ t: 'sceneAway', ids: away });
    if (sc.leaderId === $.myPlayerId() && Object.keys(hold.members).length) $.sceneHold = hold;
    $.dlog('defeat scene: the branch for', [sc.leaderId].concat(sc.others).join(', '), '- leader', sc.leaderId);
};

// The leader moved: the others run its path (or the whole branch, given up
// waiting for it).
$.sceneStartOthers = function(sc, list) {
    Object.keys(sc.waiting).forEach(function(id) {
        var side = sc.waiting[id];
        delete sc.waiting[id];
        var parked = sc.parked[id];
        delete sc.parked[id];
        if (side === 'away') {
            $.sceneWord(id, { t: 'bScene', bid: sc.bid || 0, list: list });
            return;
        }
        var entry = $.owned[id];
        var conn = $.clientById(id);
        if (!entry || !conn || entry.interp !== parked && !$.interpInChain(entry.interp, parked)) {
            $.dlog('defeat scene: lost track of', id);
            return;
        }
        var interp = new Game_Interpreter();
        interp._fhOwner = id;
        interp.setup(list, 0);
        interp._fhSceneFollow = true; // the world's values: the leader's
        entry.interp = interp; // in place of the parked one (its event stays held)
        $.markScene(sc, interp);
    });
};

$.interpInChain = function(root, interp) {
    for (var i = root; i; i = i._childInterpreter) if (i === interp) return true;
    return false;
};

// The leader's run ended without a transfer (the game over in the branch):
// the others are down too.
$.sceneOthersDown = function(sc) {
    Object.keys(sc.waiting).forEach(function(id) {
        var side = sc.waiting[id];
        delete sc.waiting[id];
        var parked = sc.parked[id];
        delete sc.parked[id];
        if (side === 'away') {
            $.sceneWord(id, { t: 'bScene', bid: sc.bid || 0, down: 1 });
            return;
        }
        var entry = $.owned[id];
        if (entry && parked && (entry.interp === parked || $.interpInChain(entry.interp, parked))) entry.interp.clear();
        $.dlog('defeat scene: the leader fell without going: down too', $.playerLabel(id));
        $.onPlayerDefeated(id);
    });
};

// A guest's event fight on this PC's map was lost (the result came).
$.sceneAtResult = function(conn, b, msg) {
    if (!b || b.owner !== conn.guestId || !b.scene || b.pvp || !msg.dead || msg.r !== 2 || !$.coopNoLose()) return null;
    var doomed = [msg.actor].concat((msg.joiners || []).map(function(j) { return j && j.actor; })).some(function(json) {
        var a = json ? $.parseActor(json) : null;
        return !!$.doomOf(a);
    });
    if (doomed) return null; // one dies for good: the usual defeat
    var fought = [b.owner];
    // (b.joiners too: one an event took out of that PC's party, e.g. CE500)
    (msg.joiners || []).map(function(j) { return j && j.id; }).concat(b.joiners || []).forEach(function(id) {
        if (id && fought.indexOf(id) < 0) fought.push(id);
    });
    if (!$.sceneDefeatOk(fought)) return null;
    // as a defeat that can be lost: everyone at 1 HP, the event takes the branch
    msg.dead = false;
    msg.actor = $.revivedJson(msg.actor);
    (msg.joiners || []).forEach(function(j) { if (j) j.actor = $.revivedJson(j.actor); });
    var own = $.myPlayerId();
    var leader = fought.indexOf(own) >= 0 ? own : b.owner;
    var sc = $.newScene(b.scene, leader, fought.filter(function(id) { return id !== leader; }));
    sc.bid = b.bid;
    return sc;
};

var _battleEndScene = $.hostHandlers.battleEnd;
$.hostHandlers.battleEnd = function(conn, msg) {
    var b = msg ? $.battles[msg.bid] : null;
    var interp = b && b.interp;
    var sc = b ? $.sceneAtResult(conn, b, msg) : null;
    _battleEndScene(conn, msg);
    var defer = $.sceneDeferDown;
    if (defer && b && defer.bid === b.bid) {
        $.sceneDeferDown = null;
        if (!sc || sc.leaderId !== $.myPlayerId()) $.sceneOwnFall();
    }
    if (!sc) return;
    if (sc.leaderId === b.owner) {
        $.setSceneLead(sc, interp, b.scene.from, b.scene.to);
        $.sceneWaitOthers(sc, null);
    } else {
        $.sceneWaitOthers(sc, { id: b.owner, interp: interp });
    }
};

// A sub-host in its guest's fight: the defeat's down waits for the result.
$.sceneOwnFall = function() {
    var actor = $gameActors.actor($.myActorId);
    if ($.isRoaming() && actor && actor.isDead() && !$.myState) $.roamDefeated();
};

var _bEndScene = $.guestHandlers.bEnd;
$.guestHandlers.bEnd = function(msg) {
    var b = msg && msg.r === 2 && $.isGuest() && $.isRoaming() ? $.battles[msg.bid] : null;
    if (!b || !b.scene || b.owner === $.myId || !$.puppet || $.puppet.bid !== msg.bid) return _bEndScene(msg);
    var roamDefeated = $.roamDefeated;
    $.roamDefeated = function() { $.sceneDeferDown = { bid: b.bid, at: $.clockMs() }; };
    try {
        _bEndScene(msg);
    } finally {
        $.roamDefeated = roamDefeated;
    }
};

// A player in the fight whose map another PC runs (the host in a roaming
// guest's fight): it runs the leader's path itself, or is down with it.
// (A thin guest's comes to the PC running its map: bRelay below.) Down or
// dead meanwhile: it stays so.
$.guestHandlers.bScene = function(msg) {
    if (!msg || !($.isHost() || $.isRoaming())) return;
    var state = $.isHost() ? ($.isDead('host') ? 'dead' : $.downs.host ? 'down' : '') : $.myState;
    if (msg.down) {
        if ($.isHost()) $.onPlayerDefeated('host'); else if (!state) $.roamDefeated();
        return;
    }
    if (!msg.list || !msg.list.length || state) return;
    $.reviveForScene($.ownSceneActor());
    var sc = $.newScene({ list: msg.list }, $.myPlayerId(), []);
    sc.leadPending = true;
    sc.follow = true; // the leader (another PC) wrote the world already
    $.sceneOwn = sc;
    $.toast('Co-op: ' + $.SCENE_TEXT);
};

// The PC running a thin guest's map (the host, a sub-host): that guest's
// part of a scene decided elsewhere. msg: { list } or { down }.
$.sceneForGuestHere = function(id, msg) {
    var c = $.clientById(id);
    if (!c || !c.actorId || !msg) return;
    if (msg.down) {
        $.sceneUnpark(id);
        $.onPlayerDefeated(id); // (nothing if down or dead already)
        return;
    }
    if (!msg.list || !msg.list.length || $.isDown(id)) { // down or dead meanwhile: so it stays
        $.sceneUnpark(id);
        return;
    }
    var entry = $.owned[id];
    var held = $.sceneAwayPark[id];
    delete $.sceneAwayPark[id];
    var interp;
    if (entry && held && entry.interp === held) {
        interp = new Game_Interpreter(); // in place of its held event (it waited for this)
        interp._fhOwner = id;
        interp.setup(msg.list, 0);
        entry.interp = interp;
    } else if (entry) {
        $.dlog('defeat scene: busy, down instead', $.playerLabel(id));
        $.onPlayerDefeated(id);
        return;
    } else {
        $.runOwned(c, msg.list, null);
        interp = $.owned[id].interp;
    }
    $.reviveForScene($gameActors.actor(c.actorId));
    interp._fhSceneFollow = true;
    $.sendTo(id, { t: 'toast', text: 'Co-op: ' + $.SCENE_TEXT });
    $.dlog('defeat scene: the branch for', $.playerLabel(id), '(its fight ran on another PC)');
};

// Host: a held thin guest is let go (its word came, or never will).
$.sceneUnpark = function(id) {
    var held = $.sceneAwayPark[id];
    delete $.sceneAwayPark[id];
    var entry = held && $.owned[id];
    if (entry && entry.interp === held) entry.interp.clear();
};

// Host: a scene's word for a player (m: { t: 'bScene', list | down }), to
// the PC running its map: its sub-host, this PC (a thin guest here), else
// its own PC (a roaming guest; the host itself).
$.sendSceneTo = function(id, m) {
    var c = id === 'host' ? null : $.clientById(id);
    if (c && c.subOf) {
        $.sendTo(c.subOf, { t: 'bSceneFor', id: c.guestId, list: m.list || null, down: m.down || 0 });
    } else if (c && !c.roam) {
        $.sceneForGuestHere(c.guestId, m);
    } else {
        if (c && m.list) $.sceneSent[c.guestId] = $.clockMs(); // (it may still turn thin: sceneSelf)
        $.sendTo(id, m);
    }
};

// A scene's word from this PC: the host passes it on itself.
$.sceneWord = function(id, m) {
    if ($.isHost()) $.sendSceneTo(id, m); else $.bSend(id, m);
};

// Only a word the host waits for (from that deciding PC, for that player):
// one from before a load is not.
var _bRelayScene = $.hostHandlers.bRelay;
$.hostHandlers.bRelay = function(conn, msg) {
    var m = msg && msg.m;
    if (!m || m.t !== 'bScene') return _bRelayScene(conn, msg);
    var away = $.sceneAway[conn.guestId];
    if (!away || !(msg.to in away)) {
        $.dlog('defeat scene: a word nobody waits for (dropped)', conn.guestId, '->', msg.to);
        return;
    }
    delete away[msg.to];
    if (!Object.keys(away).length) delete $.sceneAway[conn.guestId];
    $.sendSceneTo(msg.to, m);
};

// (the host checked it)
$.guestHandlers.bSceneFor = function(msg) {
    var v = msg && $.clientById(msg.id);
    if (v && v._sub && $.subHosting()) $.sceneForGuestHere(msg.id, msg);
};

// A deciding guest PC: the players whose scene it will send. A thin guest
// here waits held (as in an event of its own) until then.
$.hostHandlers.sceneAway = function(conn, msg) {
    var away = $.sceneAway[conn.guestId] = $.sceneAway[conn.guestId] || {};
    (msg.ids || []).forEach(function(id) {
        if (typeof id !== 'string') return;
        away[id] = $.clockMs();
        var c = id === 'host' ? null : $.clientById(id);
        if (!c || c.roam || c.subOf || !c.actorId || $.owned[id] || $.isDown(id)) return;
        $.runOwned(c, [{ code: 0, indent: 0, parameters: [] }], null);
        var held = $.owned[id].interp;
        held.setWaitMode('fhScene');
        $.sceneAwayPark[id] = held;
    });
};

// A guest whose own scene could not run on its PC (it is a thin guest now):
// only one the host passed on to it.
$.hostHandlers.sceneSelf = function(conn, msg) {
    var at = $.sceneSent[conn.guestId];
    delete $.sceneSent[conn.guestId];
    if (at === undefined || $.clockMs() - at > $.SCENE_WAIT_MS * 2) {
        $.dlog('defeat scene: a part nobody passed on (dropped)', conn.guestId);
        return;
    }
    $.sendSceneTo(conn.guestId, { t: 'bScene', list: msg.list || null, down: msg.down || 0 });
};

// ids: the ones of that deciding PC to give up on (all when left out).
$.sceneAwayDown = function(fromId, why, ids) {
    var away = $.sceneAway[fromId] || {};
    (ids || Object.keys(away)).forEach(function(id) {
        delete away[id];
        $.sceneUnpark(id);
        $.dlog('defeat scene: no word from the deciding PC (' + why + '): down', $.playerLabel(id));
        if (id === 'host' || $.clientById(id)) $.onPlayerDefeated(id);
    });
    if (!Object.keys(away).length) delete $.sceneAway[fromId];
};

var _onGuestClosedScene = $.onGuestClosed;
$.onGuestClosed = function(conn) {
    _onGuestClosedScene(conn);
    if ($.isHost() && conn && conn.guestId && $.sceneAway[conn.guestId]) $.sceneAwayDown(conn.guestId, 'it left');
};

// The leader's transfer: the scene moved, the others go after it.
var _command201Scene = Game_Interpreter.prototype.command201;
Game_Interpreter.prototype.command201 = function() {
    var sc = $.sceneOf(this);
    if (!sc || sc.lead !== this || sc.moved || $gameParty.inBattle()) return _command201Scene.call(this);
    var index = this._index;
    var result = _command201Scene.call(this);
    if (result === true || this._index !== index || this._waitMode === 'fhHanded') {
        sc.moved = true;
        sc.moveIndex = index;
        sc.spot = $.transferSpot(this);
        $.sceneRecDone(sc);
        $.dlog('defeat scene: the leader goes to map', sc.spot.m, sc.spot.x, sc.spot.y);
        $.sceneStartOthers(sc, $.scenePathList(sc));
    }
    return result;
};

$.canStartOwnScene = function() {
    return SceneManager._scene instanceof Scene_Map && !SceneManager.isSceneChanging() && !$gameParty.inBattle() &&
        !$.puppet && !$gameMap.isEventRunning() && !($.realPlayer || $gamePlayer).isTransferring();
};

$.sceneCmd = function(id, code, params) {
    $.sendTo(id, { t: 'cmd', c: code, p: params });
};

$.releaseSceneMember = function(id, m) {
    if (m.tr) $.sceneCmd(id, 211, [1]);
    if (m.menu === false) $.sceneCmd(id, 135, [1]);
};

$.endSceneHold = function(why) {
    var hold = $.sceneHold;
    if (!hold) return;
    $.sceneHold = null;
    Object.keys(hold.members).forEach(function(id) {
        if (hold.members[id].held) $.releaseSceneMember(id, hold.members[id]);
    });
    $.dlog('defeat scene: lets go -', why);
};

// The leader fell in the scene: the ones it holds fall with it.
$.sceneHoldFalls = function() {
    var hold = $.sceneHold;
    $.sceneHold = null;
    Object.keys(hold.members).forEach(function(id) {
        var m = hold.members[id];
        if (!m.held || !$.clientById(id)) return;
        $.releaseSceneMember(id, m);
        $.dlog('defeat scene: held with the leader, down too:', $.playerLabel(id));
        $.onPlayerDefeated(id);
    });
};

var _onPlayerDefeatedScene = $.onPlayerDefeated;
$.onPlayerDefeated = function(id) {
    var hold = $.sceneHold;
    _onPlayerDefeatedScene(id);
    if (hold && hold === $.sceneHold && id === hold.leaderId && $.isHost()) $.sceneHoldFalls();
};

var _roamDefeatedScene = $.roamDefeated;
$.roamDefeated = function() {
    var hold = $.sceneHold;
    _roamDefeatedScene();
    if (hold && hold === $.sceneHold && hold.leaderId === $.myId) $.sceneHoldFalls();
};

$.updateSceneHold = function() {
    var hold = $.sceneHold;
    if (!hold) return;
    var sc = hold.sc;
    var now = $.clockMs();
    if (!sc.moved) {
        if (sc.done) $.endSceneHold('the leader never moved');
        return;
    }
    var p = $.realPlayer || $gamePlayer;
    if (p.isTransferring() || SceneManager.isSceneChanging()) return;
    if ($gameMap.mapId() !== sc.spot.m) {
        $.endSceneHold('the leader left the map');
        return;
    }
    var tr = p.isTransparent(), menu = $gameSystem.isMenuEnabled();
    if (tr || !menu || $gameMap.isEventRunning()) {
        hold.freeSince = -1;
    } else if (hold.freeSince < 0) {
        hold.freeSince = now;
    } else if (now - hold.freeSince >= $.SCENE_FREE_MS) {
        $.endSceneHold('the scene is over');
        return;
    }
    Object.keys(hold.members).forEach(function(id) {
        var m = hold.members[id];
        var c = $.clientById(id);
        var pos = c && c.lastPos;
        var here = !!pos && (!pos.m || pos.m === sc.spot.m) && pos.x === sc.spot.x && pos.y === sc.spot.y;
        if (!c || (m.held && !here)) {
            if (c && m.held) $.releaseSceneMember(id, m);
            delete hold.members[id];
            return;
        }
        if (!here) {
            if (now > sc.until + $.SCENE_WAIT_MS) delete hold.members[id]; // never came
            return;
        }
        m.held = true;
        // again now and then: a snapshot may have reset the guest's own
        var again = !m.sentAt || now - m.sentAt >= $.SCENE_RESEND_MS;
        if (m.tr !== tr || again) $.sceneCmd(id, 211, [tr ? 0 : 1]);
        if (m.menu !== menu || again) $.sceneCmd(id, 135, [menu ? 1 : 0]);
        if (m.tr !== tr || m.menu !== menu || again) m.sentAt = now;
        m.tr = tr;
        m.menu = menu;
    });
};

$.updateDefeatScene = function() {
    if ($.sceneTickAt === Graphics.frameCount) return;
    $.sceneTickAt = Graphics.frameCount;
    var now = $.clockMs();
    // a scene of the world before (a load, a snapshot, a new roam) is gone
    Object.keys($.scenes).forEach(function(k) {
        var sc = $.scenes[k];
        if (sc.world === $gameMap) return;
        $.sceneRecDone(sc);
        delete $.scenes[k];
        if ($.sceneOwn === sc) $.sceneOwn = null;
        if ($.sceneHold && $.sceneHold.sc === sc) $.sceneHold = null;
        $.dlog('defeat scene: dropped with the world before');
    });
    var own = $.sceneOwn;
    if (own && $.isGuest() && !$.isRoaming()) {
        // a thin guest now: the PC running its map runs it
        $.sceneOwn = null;
        own.leadPending = false;
        if ($.conn) $.conn.send({ t: 'sceneSelf', list: own.branch.list });
        $.dlog('defeat scene: thin now - the branch goes to the PC running this map');
    } else if (own && $.canStartOwnScene()) {
        $.sceneOwn = null;
        var interp = $gameMap._interpreter;
        interp.setup(own.branch.list, 0);
        $.setSceneLead(own, interp, 0, own.branch.list.length);
        if (own.follow) interp._fhSceneFollow = true;
        $.dlog('defeat scene: this PC\'s player runs the branch');
    } else if (own && now > own.until) {
        // busy all along: down, as a defeat without the scene
        $.sceneOwn = null;
        own.leadPending = false;
        $.dlog('defeat scene: this PC\'s player could not run the branch (busy) - down');
        if ($.isHost()) $.onPlayerDefeated('host'); else if ($.isRoaming() && !$.myState) $.roamDefeated();
    }
    if ($.isHost()) {
        Object.keys($.sceneAway).forEach(function(from) {
            var away = $.sceneAway[from];
            var late = Object.keys(away).filter(function(id) { return now - away[id] > $.SCENE_WAIT_MS + $.SCENE_AWAY_MS; });
            if (late.length) $.sceneAwayDown(from, 'too long', late);
            else if (!Object.keys(away).length) delete $.sceneAway[from];
        });
    }
    Object.keys($.scenes).forEach(function(k) {
        var sc = $.scenes[k];
        if (!sc.moved && !sc.done && !$.sceneLeadActive(sc)) {
            sc.done = true; // the leader's run is over without a transfer
            $.sceneRecDone(sc);
            $.sceneOthersDown(sc);
        } else if (!sc.moved && !sc.done && now > sc.until) {
            sc.done = true; // waited long enough: each runs the whole branch
            $.sceneRecDone(sc);
            $.dlog('defeat scene: the leader never went - the others run the branch on their own');
            $.sceneStartOthers(sc, sc.branch.list);
        }
        if (now - sc.at > $.SCENE_KEEP_MS) {
            $.sceneRecDone(sc);
            delete $.scenes[k];
        }
    });
    var defer = $.sceneDeferDown;
    if (defer && (!$.battles[defer.bid] || now - defer.at > $.SCENE_DEFER_MS)) {
        $.sceneDeferDown = null; // the result never came
        $.sceneOwnFall();
    }
    $.updateSceneHold();
};

$.worldExtras.push(function() { $.updateDefeatScene(); });
$.guestExtras.push(function() { if ($.isGuest()) $.updateDefeatScene(); });

$.clearDefeatScenes = function() {
    $.scenes = {};
    $.sceneRec = [];
    $.sceneOwn = null;
    $.sceneHold = null;
    $.sceneDeferDown = null;
    $.sceneAway = {};
    $.sceneAwayPark = {};
    $.sceneSent = {};
};

// The host loads a save or goes to the title.
var _resetRoamsScene = $.resetRoams;
$.resetRoams = function() {
    _resetRoamsScene();
    $.clearDefeatScenes();
};

var _leaveAsGuestScene = $.leaveAsGuest;
$.leaveAsGuest = function(message) {
    $.clearDefeatScenes();
    _leaveAsGuestScene(message);
};

// A guest gets a new world (the host's snapshot, e.g. after its load; its
// own map to run; its sub-host part dropped): the scenes of the old one
// are gone. Its own part not run yet goes to the host first (it may be
// thin now; the host takes only one it passed on).
var _processPendingSnapshotScene = $.processPendingSnapshot;
$.processPendingSnapshot = function() {
    var had = !!$.pendingSnapshot;
    var own = had && $.isGuest() ? $.sceneOwn : null;
    if (own && own.follow && $.conn) $.conn.send({ t: 'sceneSelf', list: own.branch.list });
    _processPendingSnapshotScene();
    if (had && $.isGuest()) $.clearDefeatScenes();
};

var _startRoamScene = $.startRoam;
$.startRoam = function(msg) {
    if ($.isGuest()) $.clearDefeatScenes();
    return _startRoamScene(msg);
};

var _subResetScene = $.guestHandlers.subReset;
$.guestHandlers.subReset = function(msg) {
    $.clearDefeatScenes();
    _subResetScene(msg);
};

// A follower's run (and the common events it calls) leaves the world's
// switches, variables and self switches alone: the leader wrote them, and
// the world is shared (Map111 EV384, the needles: "Pav" V201 - 1 once, not
// once per player). Its own values stay: the PC's own switches (SW202 ...),
// a player's own (sleep), the game-data variables (positions).
$.scenePersonalSwitch = function(id) {
    return !!$.NO_SYNC_SWITCHES[id] || !!($.OWN_SW && $.OWN_SW[id]);
};

var _setupScene = Game_Interpreter.prototype.setup;
Game_Interpreter.prototype.setup = function(list, eventId) {
    delete this._fhSceneFollow; // (a map interpreter runs other events later)
    _setupScene.call(this, list, eventId);
};

var _setupChildScene = Game_Interpreter.prototype.setupChild;
Game_Interpreter.prototype.setupChild = function(list, eventId) {
    _setupChildScene.call(this, list, eventId);
    if (this._fhSceneFollow && this._childInterpreter) this._childInterpreter._fhSceneFollow = true;
};

var _command121Scene = Game_Interpreter.prototype.command121;
Game_Interpreter.prototype.command121 = function() {
    if (!this._fhSceneFollow) return _command121Scene.call(this);
    var p = this._params;
    for (var id = p[0]; id <= p[1]; id++) {
        if ($.scenePersonalSwitch(id)) $gameSwitches.setValue(id, p[2] === 0);
    }
    return true;
};

var _command122Scene = Game_Interpreter.prototype.command122;
Game_Interpreter.prototype.command122 = function() {
    if (!this._fhSceneFollow || this._params[3] === 3) return _command122Scene.call(this);
    return true;
};

var _command123Scene = Game_Interpreter.prototype.command123;
Game_Interpreter.prototype.command123 = function() {
    if (!this._fhSceneFollow) return _command123Scene.call(this);
    return true;
};

// CE352 REMOVE_PARTY: "is <actor> in the party" is no for another player's
// character (its death switch and V201 are its own player's matter).
$.isPlayerCharacter = function(actorId) {
    if (!$.DEATH_SWITCH[actorId]) return false;
    if (actorId === ($.isHost() ? $.hostActorId() : $.myActorId)) return true;
    if ($.clients.some(function(c) { return c.actorId === actorId; })) return true;
    return ($.roster || []).some(function(p) { return p && p.a === actorId; });
};

var _command111Scene = Game_Interpreter.prototype.command111;
Game_Interpreter.prototype.command111 = function() {
    var p = this._params;
    var ce = $dataCommonEvents[$.REMOVE_PARTY_CE];
    if ($.role && p && p[0] === 4 && p[2] === 0 && ce && this._list === ce.list && $.isPlayerCharacter(p[1])) {
        $.dlog('CE352: a player\'s character is not one of the companions it takes', p[1]);
        this._branch[this._indent] = false;
        this.skipBranch();
        return true;
    }
    return _command111Scene.call(this);
};

//=============================================================================
// A snapshot does not bring the host's own screen effects
//=============================================================================
// The host's world (a snapshot, a roam) carries its screen zoom ($gameScreen:
// the heartbeat's Galv.ZOOM 1.05) and its filters ($gameMap._filterConArr:
// the heartbeat's MOTION2 / RGB2 / SATURATION2, CE456/457) and its pictures
// (CE582's "exhaustion" pulse, FH_CoopWorld PERSONAL_PICTURES). Taken in the middle
// of the host's heartbeat, the guest kept the host's zoom and blur (its PC
// never gets the host's "restore"), and a guest's own heartbeat lost its
// filter controllers - their filters stayed on its screen for good. This PC's
// own are kept instead. (Map filters - godrays and such - still come.)
$.PERSONAL_FILTERS = ['MOTION2', 'RGB2', 'SATURATION2'];
$.ZOOM_FIELDS = ['_zoomX', '_zoomY', '_zoomScale', '_zoomXTarget', '_zoomYTarget', '_zoomScaleTarget', '_zoomDuration'];

// (and the coin / soul stone count, FH_CoopWorld $.countHudPicture: a snapshot or a
// roam start - the whole save of the PC that sent it - carried that PC's count to the
// guest; one that went on to run another map kept it there for good, nobody there to
// erase it: the gallery 4p report "the coin picture on another map", 2026-11-10)
$.personalPicture = function(pic) {
    if (!pic || !pic.name) return false;
    return (!!$.PERSONAL_PICTURES && !!$.PERSONAL_PICTURES[pic.name()]) || (!!$.privatePicture && $.privatePicture(pic));
};

$.ownFxState = function() {
    var out = { zoom: null, filters: [], pics: [] };
    if ($gameScreen) {
        out.zoom = {};
        $.ZOOM_FIELDS.forEach(function(k) { out.zoom[k] = $gameScreen[k]; });
        ($gameScreen._pictures || []).forEach(function(pic, i) { if ($.personalPicture(pic)) out.pics.push([i, pic]); });
    }
    var arr = $gameMap && $gameMap._filterConArr;
    if (arr && arr.get) {
        $.PERSONAL_FILTERS.forEach(function(id) {
            var fc = arr.get(id);
            if (fc) out.filters.push([id, fc]);
        });
    }
    return out;
};

$.restoreOwnFx = function(st, keep) {
    if (!st) return;
    if (keep && st.zoom && $gameScreen) {
        $.ZOOM_FIELDS.forEach(function(k) { if (st.zoom[k] !== undefined) $gameScreen[k] = st.zoom[k]; });
    }
    if ($gameScreen && $gameScreen._pictures) {
        $gameScreen._pictures.forEach(function(pic, i) { if ($.personalPicture(pic)) $gameScreen._pictures[i] = null; });
        if (keep) st.pics.forEach(function(p) { $gameScreen._pictures[p[0]] = p[1]; });
    }
    var arr = $gameMap && $gameMap._filterConArr;
    if (arr && arr.set) {
        $.PERSONAL_FILTERS.forEach(function(id) { arr.delete(id); });
        if (keep) st.filters.forEach(function(p) { arr.set(p[0], p[1]); });
    }
};

var _processPendingSnapshotFx = $.processPendingSnapshot;
$.processPendingSnapshot = function() {
    var st = $.pendingSnapshot && $.isGuest() ? $.ownFxState() : null;
    _processPendingSnapshotFx();
    if (st) $.restoreOwnFx(st, true);
};

var _startRoamFx = $.startRoam;
$.startRoam = function(msg) {
    var st = $.ownFxState();
    _startRoamFx(msg);
    // its own map elsewhere starts with a clear screen (an event going on
    // there keeps its own effects)
    $.restoreOwnFx(st, !!(msg && (msg.here || msg.interp)));
};

//=============================================================================
// Dream maps: their self switches are each PC's own
//=============================================================================
// Data: Map032 EV7 "The Hexen" tints the screen black and goes to Map031
// (8,8). Map031 EV1 page 1 (autorun) sets the board up (CE290 soul stone HUD,
// SW2420, the cursor, banner picture 1, LAYER_S / LAYER REFRESH), lifts the
// black (line 174: tint 0) and turns its self switch A on (175); page 2
// (parallel, A) leaves on Cancel and turns A off (41). Every player dreams on
// its own PC, but self switches were in the world sync: a PC entering the
// board while another sat on it (A on) never ran page 1 - black, nothing on
// it (play test 2026-10-19: the guest's void, the host's black screen), and
// one leaving (A off) restarted the other's page. Nobody shares a dream map.
$.HEXEN_READY_SS = '31,1,A';

$.dreamSelfSwitch = function(key) {
    return !!$.DREAM_MAPS[Number(String(key).split(',')[0])];
};

// (V2797 exhaust: the heartbeat's counter, CE263 / CE582 - each PC's too)
// V61 / V62: the vision circle's size and strength (GALV, set by each map's
// own parallel event): each player's view, not the world's (0.41 play test:
// another map's value came in with the world sync).
$.PC_VARS = { 2797: true, 61: true, 62: true };
$.DOOR_VARS.forEach(function(id) { $.PC_VARS[id] = true; }); // the rope lifts' steps (top of file)

// A battle's own variables (FH_CoopBattle $.battleVar): not to or from a PC
// fighting (another PC's battle reset this fight's V19, moonless review M1).
var _markWorldBattle = $.markWorld;
$.markWorld = function(kind, key, value) {
    if (kind === 'v' && $gameParty && $gameParty.inBattle() && $.battleVar && $.battleVar(key)) return;
    _markWorldBattle(kind, key, value);
};

var _applyWorldDeltaBattle = $.applyWorldDelta;
$.applyWorldDelta = function(d, pending, persist) {
    if (d && d.v && $gameParty && $gameParty.inBattle() && $.battleVar &&
            Object.keys(d.v).some(function(k) { return $.battleVar(k); })) {
        var v = {};
        Object.keys(d.v).forEach(function(k) { if (!$.battleVar(k)) v[k] = d.v[k]; });
        d = Object.assign({}, d, { v: v });
    }
    return _applyWorldDeltaBattle(d, pending, persist);
};

var _markWorldDream = $.markWorld;
$.markWorld = function(kind, key, value) {
    if (kind === 'ss' && $.dreamSelfSwitch(key)) return;
    if (kind === 'v' && $.PC_VARS[key]) return;
    _markWorldDream(kind, key, value);
};

var _applyWorldDeltaDream = $.applyWorldDelta;
$.applyWorldDelta = function(d, pending, persist) {
    if (d && d.ss && Object.keys(d.ss).some(function(k) { return $.dreamSelfSwitch(k); })) {
        var ss = {};
        Object.keys(d.ss).forEach(function(k) { if (!$.dreamSelfSwitch(k)) ss[k] = d.ss[k]; });
        d = Object.assign({}, d, { ss: ss });
    }
    if (d && d.v && Object.keys(d.v).some(function(k) { return $.PC_VARS[k]; })) {
        var v = {};
        Object.keys(d.v).forEach(function(k) { if (!$.PC_VARS[k]) v[k] = d.v[k]; });
        d = Object.assign({}, d, { v: v });
    }
    return _applyWorldDeltaDream(d, pending, persist);
};

// A snapshot or a roam can still bring another PC's "board is set up" (A
// on): entering the board, this PC's own is off (the original always turns it
// off on the way out). Straight in the data: not a world change.
var _setupDream = Game_Map.prototype.setup;
Game_Map.prototype.setup = function(mapId) {
    var from = this._mapId;
    if ($.role && mapId === $.HEXEN_MAP && $gameSelfSwitches && $gameSelfSwitches._data[$.HEXEN_READY_SS]) {
        delete $gameSelfSwitches._data[$.HEXEN_READY_SS];
        $.dlog('Hexen board: its "set up" self switch (31,1,A) was on - cleared for this PC');
    }
    _setupDream.call(this, mapId);
    if ($.role && from !== mapId && ($.DREAM_MAPS[mapId] || $.DREAM_MAPS[from] || $.TUTORIAL_WATCH_MAPS[mapId])) {
        $.watchScreen('map ' + from + ' -> ' + mapId);
    }
};
// The train (Map019 the intro seats, Map014 the train), also while a guest
// plays its tutorial alone: hard mode's black screen there (0.41 play test,
// 61.png) is not explained yet; the watch lines carry the player's light.
$.TUTORIAL_WATCH_MAPS = { 14: true, 19: true };

// The screen around the dreams, once a second for a while (the black screen
// back on the host's map after a dream is not explained yet: 2026-10-19).
$.SCREEN_WATCH_MS = 12000;
$.screenWatch = null; // { tag, until, next, last }

$.watchScreen = function(tag) {
    if (!$.role) return;
    $.screenWatch = { tag: tag, until: $.clockMs() + $.SCREEN_WATCH_MS, next: 0, last: '' };
};

$.screenWatchLine = function() {
    var sc = $gameScreen;
    var pic = function(id) {
        var p = sc.picture(id);
        return p && p.name() ? p.name() + '@' + Math.round(p.opacity()) : '-';
    };
    var ev1 = $gameMap.mapId() === $.HEXEN_MAP ? $gameMap.event(1) : null;
    var scene = SceneManager._scene;
    return 'map ' + $gameMap.mapId() + ' tone ' + JSON.stringify(sc.tone().map(Math.round)) +
        (sc._toneDuration ? ' -> ' + JSON.stringify((sc._toneTarget || []).map(Math.round)) + ' in ' + sc._toneDuration : '') +
        ' bright ' + Math.round(sc.brightness()) + $.screenFadeInfo(sc, scene) +
        ' ss31A ' + !!$gameSelfSwitches._data[$.HEXEN_READY_SS] +
        (ev1 ? ' ev1 p' + ev1._pageIndex : '') + ' pic1 ' + pic(1) + ' pic14 ' + pic(14) +
        ' player ' + ($gamePlayer.isTransparent() ? 'hidden' : 'shown') +
        ' ' + ($.isRoaming() ? 'roaming' : $.isGuest() ? 'thin' : 'host') +
        (scene ? ' ' + (scene.constructor && scene.constructor.name) : '') + $.screenLightInfo() +
        ' event ' + ($gameMap.isEventRunning() ? 'running' : 'none') + ($.isGuest() && $.myEventRunning ? ' (its own on the host)' : '');
};

// The black screen after waking is not explained yet (2026-10-20): the scene's
// own fade (a transfer's fade cut short), the screen's fade out / in (221 /
// 222) still going, Terrax lighting's darkness, GALV's vision circle.
$.screenFadeInfo = function(sc, scene) {
    var f = scene && scene._fadeSprite;
    return ' fadeOut ' + (sc._fadeOutDuration || 0) + ' fadeIn ' + (sc._fadeInDuration || 0) +
        ' sceneFade ' + (f ? Math.round(f.opacity) : '-') + (scene && scene._fadeDuration ? ' in ' + scene._fadeDuration : '');
};

$.screenLightInfo = function() {
    var v = $gameVariables, out = '';
    try {
        if (v.GetTint) {
            out += ' terrax ' + v.GetTint() + (v.GetTintTarget && v.GetTintTarget() !== v.GetTint() ? '->' + v.GetTintTarget() : '') +
                (v.GetScriptActive && !v.GetScriptActive() ? ' off' : '') + (v.GetStopScript && v.GetStopScript() ? ' stopped' : '');
        }
        // the player's light (radius, flashlight): hard mode's candle is 100
        if (v.GetRadius) out += ' light ' + v.GetRadius() + (v.GetFlashlight && v.GetFlashlight() ? ' flashlight on' : '');
        if (typeof Galv !== 'undefined' && Galv.VR) {
            out += ' vision ' + ($gameSystem.galvVis || '-') + '@' + v.value(Galv.VR.opacity) + ' zoom ' + v.value(Galv.VR.zoom);
            // the circle sprite itself (it can differ from the state above)
            var set = SceneManager._scene && SceneManager._scene._spriteset;
            var r = set && set._galvVisRange;
            out += ' circle ' + (r ? (r.name || '?') + ' x' + Math.round(r.scale.x * 100) / 100 : 'none');
        }
    } catch (e) {
        out += ' (light info: ' + String(e) + ')';
    }
    return out;
};

// The screen commands a thin guest gets from the host's events while its
// screen is watched (a fade out with no fade in after it: 2026-10-20 report).
var _cmdWatch = $.guestHandlers.cmd;
$.guestHandlers.cmd = function(msg) {
    if ($.screenWatch && msg && (msg.c === 221 || msg.c === 222 || msg.c === 223)) {
        $.dlog('screen watch (' + $.screenWatch.tag + '): got command', msg.c, JSON.stringify(msg.p || []));
    }
    return _cmdWatch(msg);
};

// back on the host's map: watch that screen too
var _sendUnroamWatch = $.sendUnroam;
$.sendUnroam = function(spot, interpJson) {
    _sendUnroamWatch(spot, interpJson);
    $.watchScreen('back to the host map ' + spot.m);
};

var _unroamWatch = $.hostHandlers.unroam;
$.hostHandlers.unroam = function(conn, msg) {
    var was = !!conn.roam;
    _unroamWatch(conn, msg);
    if (was && !conn.roam) $.watchScreen('unroam of ' + conn.name);
};

// One line of the screen a second after every map screen starts (a new map,
// back from the menu or a battle): the vision circle (state and sprite) and
// the player's light as they came out (0.41 play test: a wrong circle after a
// guest's door until the menu).
$.screenNote = null; // { at (ms), tag }
var _sceneMapStartNote = Scene_Map.prototype.start;
Scene_Map.prototype.start = function() {
    _sceneMapStartNote.call(this);
    if (!$.role) return;
    var from = SceneManager._previousClass;
    $.screenNote = { at: $.clockMs() + 1000,
        tag: this._transfer ? 'new map' : from && from !== Scene_Map ? 'back from ' + from.name : 'map screen' };
};

var _sceneMapUpdateWatch = Scene_Map.prototype.update;
Scene_Map.prototype.update = function() {
    _sceneMapUpdateWatch.call(this);
    var note = $.screenNote;
    if (note && $gameMap && $gameScreen && $.clockMs() >= note.at) {
        $.screenNote = null;
        if ($.role) $.dlog('screen (' + note.tag + '):', $.screenWatchLine());
    }
    var w = $.screenWatch;
    if (!w || !$gameMap || !$gameScreen) return;
    var now = $.clockMs();
    if (now > w.until || !$.role) {
        $.screenWatch = null;
        return;
    }
    if (now < w.next) return;
    w.next = now + 1000;
    var line = $.screenWatchLine();
    if (line === w.last) return;
    w.last = line;
    $.dlog('screen watch (' + w.tag + '):', line);
};

// A thin guest back on the host's map after its dream: its screen there.
var _processPendingSnapshotWatch = $.processPendingSnapshot;
$.processPendingSnapshot = function() {
    var had = !!$.pendingSnapshot;
    var from = $gameMap ? $gameMap.mapId() : 0;
    _processPendingSnapshotWatch();
    if (had && ($.DREAM_MAPS[from] || $.DREAM_MAPS[$.hostMapId])) $.watchScreen('snapshot after the dream map ' + from);
};

//=============================================================================
// Why this guest cannot move (log)
//=============================================================================
// Play test 2026-10-19: a guest stood frozen in the bedroom for half a minute
// after the host's dream, with nothing in either log. Now and then while it
// presses a direction and cannot move, the reasons go to the log.
$.cantMoveLog = { at: 0, key: '' };

$.cantMoveReasons = function(p) {
    var why = [];
    if ($.picking) why.push('picking a character');
    if (!$.myActorId) why.push('no character');
    if ($.solo && ($.solo.waiting || $.solo.dead)) why.push('tutorial wait');
    if ($.isDownMe && $.isDownMe()) why.push('down');
    if ($.duelIntro) why.push('duel intro');
    if ($.pickOpen && $.pickOpen()) why.push('trade/duel box');
    if ($.pendingRoam) why.push('roam coming');
    if ($.roam && $.roam.leaving) why.push('going back to the host map');
    if ($.pendingSnapshot) why.push('snapshot coming');
    if ($gameMap.isEventRunning()) why.push('event running (map ' + ($gameMap._interpreter._eventId || 0) + ')');
    if ($gameMessage.isBusy()) {
        why.push('message ' + ($.pm ? 'personal #' + $.pm.id : $.guestMsgShared ? 'shared (owner ' + $.guestMsgOwner +
            (($.guestVoted ? ', voted' : '') + ')') : 'other'));
    }
    if ($.pmQueue && $.pmQueue.length) why.push($.pmQueue.length + ' personal message(s) waiting');
    if ($.myEventRunning) why.push('its event runs on the host');
    if (p.isMoveRouteForcing()) why.push('move route');
    if (p.isTransferring()) why.push('transfer');
    if ($.localBattle) why.push('local battle');
    if ($.puppet) why.push('puppet');
    if (!why.length) why.push('another plugin');
    return why;
};

var _canMoveWhy = Game_Player.prototype.canMove;
Game_Player.prototype.canMove = function() {
    var ok = _canMoveWhy.call(this);
    if (!ok && $.isGuest() && this === $gamePlayer && !this._fhRemoteId && Input.dir4 &&
            SceneManager._scene instanceof Scene_Map) {
        $.logCantMove(this);
    }
    return ok;
};

$.logCantMove = function(p) {
    var now = $.clockMs(), log = $.cantMoveLog;
    if (now - log.at < 1000) return;
    var why = $.cantMoveReasons(p).join(', ');
    if (why === log.key && now - log.at < 5000) return;
    $.cantMoveLog = { at: now, key: why };
    $.dlog('cannot move:', why, '| map', $gameMap.mapId(), 'at', p.x + ',' + p.y);
};

// Back on the host's map: its own SW202 / SW410 go first (its event may go on
// there in its context; FH_CoopWorld CTX_OWN_SWITCHES).
var _sendUnroamPc = $.sendUnroam;
$.sendUnroam = function(spot, interpJson) {
    if ($.conn && $.CTX_OWN_SWITCHES) {
        var sw = {};
        $.CTX_OWN_SWITCHES.forEach(function(id) { if ($gameSwitches._data[id]) sw[id] = true; });
        $.conn.send({ t: 'pcSw', sw: sw });
    }
    _sendUnroamPc(spot, interpJson);
};

$.hostHandlers.pcSw = function(conn, msg) {
    if (!conn.roam || !msg) return;
    var own = {};
    ($.CTX_OWN_SWITCHES || []).forEach(function(id) { if (msg.sw && msg.sw[id]) own[id] = true; });
    conn._fhCtxSw = own;
};

// a load: nobody's scene runs any more
var _resetRoamsPc = $.resetRoams;
$.resetRoams = function() {
    _resetRoamsPc();
    $.clients.forEach(function(c) { c._fhCtxSw = {}; });
};

//=============================================================================
// Soul stones: two made, one for every other player
//=============================================================================
// User decision 2026-10-20: each player's soul stones (item 116) made from
// shards (3 x item 118, the synthesis menu: YEP_ItemSynthesis, the shard's
// <Item Recipe: 116>, the stone's <Synthesis Ingredients> item 118: 3) are
// counted per player in the host's save; every second one made gives every
// other living player one stone (one not connected: into its bag in the
// host's save), with "<name> shared a soul stone.". Only stones made in the
// synthesis menu count (not trades, gifts or found ones). The host counts;
// every guest (on the host's map, running its own map, a sub-host and its
// guests) tells the host directly.
$.SOUL_STONE_ITEM = 116;
$.SOUL_SHARE_EVERY = 2;

$.soulData = function() {
    var data = $.coopData();
    var soul = data.soul = data.soul || {};
    soul.made = soul.made || {};     // name -> stones made
    soul.shared = soul.shared || {}; // name -> pairs given out already
    soul.owed = soul.owed || {};     // name -> { n, from: [labels] } not given yet
    return soul;
};

// "<name> shared a soul stone." (one line per giver)
$.soulTexts = function(from) {
    var count = {}, order = [];
    (from || []).forEach(function(label) {
        if (!count[label]) order.push(label);
        count[label] = (count[label] || 0) + 1;
    });
    return order.map(function(label) {
        return count[label] > 1 ? label + ' shared ' + count[label] + ' soul stones.' : label + ' shared a soul stone.';
    });
};

// Any PC: made in its synthesis menu
if (typeof Scene_Synthesis !== 'undefined' && Scene_Synthesis.prototype.doBuy) {
    var _synthesisDoBuy = Scene_Synthesis.prototype.doBuy;
    Scene_Synthesis.prototype.doBuy = function(number) {
        _synthesisDoBuy.call(this, number);
        var item = this._item;
        if (!$.role || !item || !DataManager.isItem(item) || item.id !== $.SOUL_STONE_ITEM) return;
        $.soulStonesMade(Math.max(0, Math.floor(Number(number) || 0)));
    };
}

$.soulStonesMade = function(n) {
    if (!n) return;
    if ($.isHost()) $.countSoulStones('host', n);
    else if ($.isGuest() && $.conn) $.conn.send({ t: 'soulMade', n: n });
};

$.hostHandlers.soulMade = function(conn, msg) {
    if (!conn.actorId) return;
    $.countSoulStones(conn.guestId, Math.min(99, Math.max(0, Math.floor(Number(msg.n) || 0))));
};

// The living players other than this name: here or not ('#host': the host).
$.soulReceivers = function(fromName) {
    var names = { '#host': true };
    Object.keys($.assignments()).forEach(function(name) { names[name] = true; });
    $.clients.forEach(function(c) { if (c.actorId && !c._sub) names[c.name] = true; });
    var dead = $.coopDead();
    return Object.keys(names).filter(function(name) { return name !== fromName && !dead[name]; });
};

$.countSoulStones = function(id, n) {
    var name = $.nameOf(id);
    if (!$.isHost() || !name || !n) return;
    var soul = $.soulData();
    soul.made[name] = (soul.made[name] || 0) + n;
    var pairs = Math.floor(soul.made[name] / $.SOUL_SHARE_EVERY);
    var give = pairs - (soul.shared[name] || 0);
    var label = $.playerLabel(id);
    if (give <= 0) {
        $.dlog('soul stones:', label, 'made', n, '(' + soul.made[name] + ' in all)');
        return;
    }
    soul.shared[name] = pairs;
    var to = $.soulReceivers(name);
    to.forEach(function(other) {
        var o = soul.owed[other] = soul.owed[other] || { n: 0, from: [] };
        o.n += give;
        for (var i = 0; i < give; i++) o.from.push(label);
    });
    $.dlog('soul stones:', label, 'made', n, '(' + soul.made[name] + ' in all) - shares', give, 'with',
        to.length ? to.join(', ') : 'nobody');
    $.deliverSoulStones();
};

// Owed stones go where that player's bag is now; one in a fight on its own
// PC (its bag comes back whole after it) or in its tutorial gets them later.
$.deliverSoulStones = function() {
    if (!$.isHost()) return;
    var soul = $.soulData(), dead = $.coopDead();
    Object.keys(soul.owed).forEach(function(name) {
        var o = soul.owed[name];
        if (!o || !(o.n > 0) || dead[name]) {
            delete soul.owed[name];
            return;
        }
        if (name === '#host') {
            $.giveHostSoulStones(o);
            delete soul.owed[name];
            return;
        }
        var c = $.clients.filter(function(x) { return x.name === name && !x._sub; })[0];
        if (!c) {
            var bag = $.guestInventory(name);
            bag.i = bag.i || {};
            bag.i[$.SOUL_STONE_ITEM] = (bag.i[$.SOUL_STONE_ITEM] || 0) + o.n;
            $.dlog('soul stones:', o.n, 'into the saved bag of', name, '(not here)');
            delete soul.owed[name];
            return;
        }
        if (!c.actorId || !c.inGame || c.solo || c.inBattle) return;
        // (it just came back: see oweSoulStonesAgain; a time from a save of
        // another run of the game is no wait)
        var wait = (o.wait || 0) - $.clockMs();
        if (wait > 0 && wait <= $.SOUL_RETRY_MS) return;
        if ($.giveGuestSoulStones(c, o)) delete soul.owed[name];
    });
};

$.worldExtras.push(function() {
    if (!$.isHost()) return;
    var data = $.coopData();
    if (data.soul && data.soul.owed && Object.keys(data.soul.owed).length) $.deliverSoulStones();
});

$.giveHostSoulStones = function(o) {
    var item = $dataItems[$.SOUL_STONE_ITEM];
    if (!item) return;
    if ($.ctx && $.ctxSave) {
        $.ctxSave.items[item.id] = ($.ctxSave.items[item.id] || 0) + o.n; // (the host's own bag)
    } else {
        $gameParty.gainItem(item, o.n);
    }
    $.soulTexts(o.from).forEach(function(text) { $.toast(text); });
    $.dlog('soul stones: the host got', o.n);
};

$.giveGuestSoulStones = function(c, o) {
    var gift = { n: o.n, from: (o.from || []).slice() };
    if (c.subOf) {
        // its bag is on the guest running its map
        var owner = $.clientById(c.subOf);
        if (!owner) return false;
        owner.send({ t: 'subSoul', who: c.guestId, n: gift.n, from: gift.from });
    } else if (c.roam) {
        c.send({ t: 'soulGift', n: gift.n, from: gift.from, gen: $.soulGen }); // its own PC has its bag
    } else {
        // on the host's map (or about to be sent its map): the host's copy
        var bag = $.inventoryOf(c).i;
        bag[$.SOUL_STONE_ITEM] = (bag[$.SOUL_STONE_ITEM] || 0) + gift.n;
        c._lastMeKey = null;
        $.pushMe(c);
        $.soulTexts(gift.from).forEach(function(text) { c.send({ t: 'toast', text: text }); });
    }
    $.dlog('soul stones:', gift.n, 'for', c.name, c.subOf ? '(on a sub-host)' : c.roam ? '(its own PC)' : '');
    return true;
};

// It could not take them where the host sent them (it just changed maps):
// owed again, given where it is now.
$.oweSoulStonesAgain = function(c, n, from) {
    n = Math.max(0, Math.floor(Number(n) || 0));
    if (!c || !n) return;
    var soul = $.soulData();
    var o = soul.owed[c.name] = soul.owed[c.name] || { n: 0, from: [] };
    o.n += n;
    o.from = o.from.concat(Array.isArray(from) ? from : []);
    // not straight back the same way: the host's view of where it is (its own
    // map, a sub-host) may be a moment behind - once a second, not every frame
    o.wait = $.clockMs() + $.SOUL_RETRY_MS;
};
$.SOUL_RETRY_MS = 1000;

// Host: a new game or a load makes a new world. Stones sent back from the
// world before (a gift that waited for a roam the load called off) are not
// owed in this one: its save has its own owed list (final review C5).
$.soulGen = 1;
var _extractSaveContentsSoul = DataManager.extractSaveContents;
DataManager.extractSaveContents = function(contents) {
    _extractSaveContentsSoul.call(this, contents);
    if (!$.isGuest()) $.soulGen++;
};
var _setupNewGameSoul = DataManager.setupNewGame;
DataManager.setupNewGame = function() {
    _setupNewGameSoul.call(this);
    if (!$.isGuest()) $.soulGen++;
};

$.soulBackOld = function(msg) {
    if (!msg || msg.gen === undefined || msg.gen === $.soulGen) return false;
    $.dlog('soul stones sent back from a world before a load: not owed again', msg.n);
    return true;
};

$.hostHandlers.soulBack = function(conn, msg) {
    if ($.soulBackOld(msg)) return;
    $.oweSoulStonesAgain(conn, msg.n, msg.from);
};

$.hostHandlers.subSoulBack = function(conn, msg) {
    $.oweSoulStonesAgain($.clientById(msg.who), msg.n, msg.from);
};

// Guest running its own map: its bag is here.
$.soulGiftsLater = []; // gifts that came while its own map was on the way
$.guestHandlers.soulGift = function(msg) {
    if ($.pendingRoam) {
        $.soulGiftsLater.push(msg);
        return;
    }
    $.takeSoulGift(msg);
};

$.takeSoulGift = function(msg) {
    var n = Math.max(0, Math.floor(Number(msg.n) || 0));
    if (!n || !$.conn) return;
    if (!$.isRoaming() || $.roam.leaving || $.pendingSnapshot) {
        // back in the host's game meanwhile: the host's copy is the bag
        $.conn.send({ t: 'soulBack', n: n, from: msg.from || [], gen: msg.gen });
        return;
    }
    $gameParty.gainItem($dataItems[$.SOUL_STONE_ITEM], n);
    $.soulTexts(msg.from).forEach(function(text) { $.toast(text); });
    if ($.sendRoamMe) $.sendRoamMe(true);
};

var _startRoamSoul = $.startRoam;
$.startRoam = function(msg) {
    _startRoamSoul(msg);
    var later = $.soulGiftsLater;
    $.soulGiftsLater = [];
    later.forEach($.takeSoulGift);
};

// A snapshot called the roam off: the gifts that waited for it go back (they
// stayed, and came in at a later roam: twice after a load, none if the game
// was closed first).
var _processPendingSnapshotSoul = $.processPendingSnapshot;
$.processPendingSnapshot = function() {
    var later = $.pendingSnapshot ? $.soulGiftsLater : [];
    if (later.length) $.soulGiftsLater = [];
    _processPendingSnapshotSoul();
    later.forEach(function(msg) {
        var n = Math.max(0, Math.floor(Number(msg.n) || 0));
        if (n && $.conn) $.conn.send({ t: 'soulBack', n: n, from: msg.from || [], gen: msg.gen });
    });
};

var _leaveAsGuestSoul = $.leaveAsGuest;
$.leaveAsGuest = function(message) {
    $.soulGiftsLater = [];
    _leaveAsGuestSoul(message);
};

// Sub-host: one of its guests' bags is here.
$.guestHandlers.subSoul = function(msg) {
    var v = $.clientById(msg.who);
    var n = Math.max(0, Math.floor(Number(msg.n) || 0));
    if (!n || !$.conn) return;
    if (!v || !v._sub) {
        $.conn.send({ t: 'subSoulBack', who: msg.who, n: n, from: msg.from || [] });
        return;
    }
    var bag = $.inventoryOf(v).i;
    bag[$.SOUL_STONE_ITEM] = (bag[$.SOUL_STONE_ITEM] || 0) + n;
    v._lastMeKey = null;
    $.pushMe(v);
    $.sendSubMe(v, false);
    $.soulTexts(msg.from).forEach(function(text) { v.send({ t: 'toast', text: text }); });
};

//=============================================================================
// Sleeping together: falling asleep and waking up together (the sleep barrier)
//=============================================================================
// Play test 2026-10-20 (docs/조사(보관용)/다운_게스트_대화_멈춤.md section 4): the host
// went to its dream while Marina's bed showed her the Samarie scene first; she
// lay down again after it and the day passed twice; the two woke up seconds
// apart, one alone on the bed's map. The players who lie down together (the
// sleep group, kept by the host) now:
// - fall asleep together (barrier 1): each sleeper's move into the dream (its
//   bed's dream page: 201 to Map032 with its SW463 on) waits until every
//   sleeper got there. A character's scene before the dream (Marina's Samarie
//   peek: Map005 EV114 p3, Map020 EV191 p2, Map054 EV33 p2; Marcoh's Aligura:
//   Map020 EV191 p7, Map054 EV33 p6) ends awake (SW463 off, its "seen" switch
//   4907 / 4916 on): that player lies down again by itself once free and
//   joins the group's dream ($.SLEEP_RELIE; false: it stays awake and the
//   others go - "use the bed again", as in the original). Any other wake
//   without a dream (the ambush instead of a dream) leaves the group.
// - wake together (barrier 2): the move out of the dream (Map032: CE440's 201
//   back to the bed, EV7's to Map129) waits until every sleeper finished its
//   dream and its Hexen board.
// - the day (CE303) passes once: in one dream of the group (the host's when
//   it sleeps, else the bed's player's; if that one is not in the dream when
//   the group falls asleep, the host's or the first one's there), every other
//   dream skips it.
// A sleeper down, dead, gone, or too slow (SLEEP_FALL_MS to fall asleep,
// SLEEP_WAKE_MS for the others to finish their dreams) holds nobody. Whoever
// waits sees "Waiting for the others to fall asleep..." / "... to wake...".
// Thin guests' dream pages run on the host: their interpreters wait there. A
// guest running its own map (its dream always runs on its own PC) waits on
// its PC: it tells the host ('sleepAt') and gets the group's state back
// ('sleepIn', 'sleepOut').

$.SLEEP_FALL_MS = 180000;   // (real time, $.clockMs) one sleeper's time to get into its dream
$.SLEEP_WAKE_MS = 600000;   // the others' time to finish theirs (the Hexen board takes long)
$.SLEEP_GROUP_MS = 1800000; // a group older than this is dropped
$.SLEEP_RELIE = true;       // a scene before the dream: lie down again by itself (false: stays awake)
$.SLEEP_RELIE_MAX = 2;
$.PRE_DREAM_SWITCHES = [4907, 4916]; // Marina saw Samarie / Marcoh met Aligura (set by those scenes)
$.PRE_DREAM_SWITCH_OF_ACTOR = { 3: 4907, 13: 4916 }; // Marina, Marcoh
$.SLEEP_FALL_TEXT = 'Waiting for the others to fall asleep...';
$.SLEEP_WAKE_TEXT = 'Waiting for the others to wake...';
$.SLEEP_HINT_MS = 2500;

// Beds on different maps (v0.41, user decision 2026-10-22): the group's
// roster is every living player. One not in bed is 'awake' and holds barrier
// 1 until it lies down in any bed (the vote of its own map); a group with
// members on several maps is 'split'. There the first sleepers wait at
// barrier 1 with "(X: get up)": X (cancel) gets them up, awake again, and the
// others hear "<name> got up." Down, dead or gone players hold nobody (back
// before the dreams: awake again). The in-bed state lives only here and in
// each player's own SW463 (never in the world, never in a save).
// host: { id, bed, split, autoMaps, members: { 'host' | guest id: { st, t, sc, seen, relaid, inDream,
//   mapId, gone, manualAwake } }, t0, go1, go2, t2, dayBy, dayPassed, waitKey }
// st: 'awake' (not in bed) | 'lying' (asleep, not at its dream yet) | 'scene'
// (woke for a scene, lies down again) | 'ready' (waits at barrier 1) |
// 'dreaming' | 'done' (waits at barrier 2) | 'woke' | 'out' (holds nobody)
$.sleepGroup = null;
$.sleepSeq = 0;
// guest: { id, go1, go2, nd, w, st, phase ('bed' | 'dream' | 'left'), inDream, seen, sc, told1, told2, daySkipped }
$.sleepMine = null;

$.sceneSwitchesNow = function() {
    var sc = {};
    $.PRE_DREAM_SWITCHES.forEach(function(id) { sc[id] = !!$gameSwitches._data[id]; });
    return sc;
};

// A scene before the dream played since that lie-down: that character's own
// (the switches are the world's: Marina's Samarie seen while O'saa's bed gave
// him the ambush made his wake a "scene" - laid down again after the ambush).
$.sceneFlipped = function(sc, actorId) {
    var id = $.PRE_DREAM_SWITCH_OF_ACTOR[actorId];
    return !!id && !!$gameSwitches._data[id] && !(sc && sc[id]);
};

$.sleeperActorId = function(id) {
    if (id === 'host') return $.realHostActorId(); // (also inside a guest's context)
    var c = $.clientById(id);
    return c ? c.actorId : 0;
};

// Host: the vote passed and its player goes to the dream - the group forms.
var _sleepTogetherBarrier = $.sleepTogether;
$.sleepTogether = function(starter) {
    var vote = $.sleepVote;
    var live = !!vote && vote.from === starter && $.clockMs() - vote.at <= $.SLEEP_MS;
    if (!live || !$.isHost()) {
        _sleepTogetherBarrier(starter);
        return;
    }
    var mapId = Number(vote.mapId) || $.playerMapOfRest(starter);
    if ($.sleepGroup) {
        $.sleepVote = null;
        $.sleepJoin(starter, mapId);
        $.sleepQueueSameMap(starter, mapId);
        $.sleepNotify(starter);
        $.sleepRelease();
        return;
    }
    var hostAtBedMap = mapId === $gameMap.mapId();
    if (hostAtBedMap) _sleepTogetherBarrier(starter);
    $.sleepVote = null;
    $.makeSleepGroup(starter, hostAtBedMap && (starter === 'host' || !!$.hostToBed), mapId);
    $.sleepQueueSameMap(starter, mapId); // (the ones there who agreed but are busy, the host too)
};

// ... or already when the bed's player lies down (its bed's first page turns
// its SW463 on): a scene before its own dream (Marina at her bed: Samarie)
// then keeps the others asleep, waiting, instead of awake.
var _swSetSleepGroup = Game_Switches.prototype.setValue;
Game_Switches.prototype.setValue = function(id, value) {
    var subConn = id === $.SLEEPING_SWITCH && $.subHosting() && $.ctx && $.ctx._sub ? $.ctx : null;
    var wasSubSleeping = !!(subConn && this.value(id));
    var subSceneBefore = subConn && !wasSubSleeping && value ? $.sceneSwitchesNow() : null;
    _swSetSleepGroup.call(this, id, value);
    if (subConn && subSceneBefore && this.value(id)) {
        var startingMeta = $.subSleepMeta[subConn.guestId];
        if (startingMeta) startingMeta.sc = subSceneBefore;
        if (startingMeta && $.conn) $.conn.send({ t: 'sleepSubAt', who: subConn.guestId, id: startingMeta.groupId, at: 'bed' });
    }
    if (subConn && wasSubSleeping && !this.value(id)) {
        var subMeta = $.subSleepMeta[subConn.guestId];
        if ($.sleepUndo) delete $.sleepUndo[subConn.guestId];
        if (subMeta && $.conn) {
            $.conn.send({ t: 'sleepSubAt', who: subConn.guestId, id: subMeta.groupId, at: 'awake',
                scene: $.sceneFlipped(subMeta.sc, subConn.actorId) });
        }
    }
    if (id !== $.SLEEPING_SWITCH || !value || this !== $gameSwitches || !$.isHost() || !$.sleepVote) return;
    var who = $.ctx ? $.ctx.guestId : 'host';
    if (who && $.sleepVote.from === who) $.sleepTogether(who);
};

$.sleepQueueSameMap = function(starter, mapId) {
    var g = $.sleepGroup;
    if (!g || !$.isHost() || g.go2) return;
    mapId = Number(mapId) || $.playerMapOfRest(starter);
    var hm = g.members.host;
    if (starter !== 'host' && hm && hm.st === 'awake' && $.playerMapOfRest('host') === mapId) {
        hm.autoMap = mapId; // it agreed there: it lies down there once free ($.sleepMonitor)
    }
    $.clients.forEach(function(c) {
        if (!c.actorId || !c.inGame || c.solo || c.guestId === starter || $.isDead(c.guestId) ||
                $.playerMapOfRest(c.guestId) !== mapId || $.ownSwitchesOf(c)[$.SLEEPING_SWITCH]) return;
        var m = g.members[c.guestId];
        if (m && m.st !== 'awake' && m.st !== 'scene' && m.st !== 'out') return;
        if ($.sleepersLate.some(function(s) { return s.id === c.guestId; })) return;
        $.sleepersLate.push({ id: c.guestId, until: $.clockMs() + $.SLEEP_MS, m: mapId });
        $.dlog('sleep group', g.id + ': same-map sleeper queued', c.name, 'on map', mapId,
            $.notSleepingWhy(c));
    });
};

$.SLEEP_NOTIFY_TEXT = ' is sleeping. Lie down in any bed to end the day.';
$.SLEEP_UP_TEXT = ' got up.';

// The players not in bed hear that someone lies down (and gets up again).
$.sleepNotify = function(id, up) {
    var g = $.sleepGroup;
    if (!g || (!up && g.members[id] && g.members[id].bedPending)) return;
    var text = 'Co-op: ' + $.playerLabel(id) + (up ? $.SLEEP_UP_TEXT : $.SLEEP_NOTIFY_TEXT);
    $.restLivingIds().forEach(function(who) {
        if (who === id || (!up && $.sleepInBed(who))) return;
        if (who === 'host' && !up && $.hostToBed) return; // (it lies down this frame)
        if (who === 'host') $.toast(text);
        else $.sendTo(who, { t: 'toast', text: text });
    });
};

// in bed and not in its dream yet (it is not asked to vote again)
$.sleepInBed = function(id) {
    var g = $.sleepGroup, m = g && !g.go1 && g.members[id];
    return !!m && !m.bedPending && (m.st === 'lying' || m.st === 'scene' || m.st === 'ready');
};

// One group a night: a bed used while the group still falls asleep joins it
// ($.sleepTogether); a group whose dreams began is over for a new one (bed
// votes are refused while they last: $.requestConsent).
$.makeSleepGroup = function(starter, hostIn, bedMap) {
    if ($.sleepGroup && !$.sleepGroup.go1) return $.sleepGroup;
    if ($.sleepGroup) $.endSleepGroup('a new sleep');
    var now = $.clockMs(), sc = $.sceneSwitchesNow();
    var mapId = Number(bedMap) || $.playerMapOfRest(starter);
    var ids = $.restLivingIds();
    if (ids.indexOf(starter) < 0) ids.push(starter);
    var g = { id: ++$.sleepSeq, bed: mapId, members: {}, split: false,
        t0: now, go1: false, go2: false, t2: 0, dayBy: hostIn ? 'host' : starter,
        dayPassed: false, waitKey: '' };
    ids.forEach(function(id) {
        var c = id === 'host' ? null : $.clientById(id);
        var ownSleep = c ? !!$.ownSwitchesOf(c)[$.SLEEPING_SWITCH] :
            (!$.ctx && !!$gameSwitches._data[$.SLEEPING_SWITCH]);
        var memberMap = $.playerMapOfRest(id) || mapId;
        var lying = id === starter || ownSleep;
        g.members[id] = { st: lying ? 'lying' : 'awake', t: now, sc: sc, seen: false,
            relaid: 0, mapId: memberMap, daySkipped: false, manualAwake: false,
            bedPending: lying && $.sleepRemote(id) };
        if (memberMap !== mapId) g.split = true;
    });
    $.sleepGroup = g;
    $.dlog('sleep group', g.id, 'at the bed on map', g.bed + ':', Object.keys(g.members).map($.playerLabel).join(', '),
        '| the day passes in the dream of', $.playerLabel(g.dayBy));
    $.sleepTellRoaming(g, false);
    $.sleepNotify(starter);
    return g;
};

$.endSleepGroup = function(why) {
    var g = $.sleepGroup;
    if (!g) return;
    $.sleepGroup = null;
    $.sleepersLate = []; // (no lie-down without a group: a dream without the day - review S3)
    $.hostToBed = 0;
    $.sleepUndo = {};
    Object.keys(g.members).forEach(function(id) {
        var c = id === 'host' ? null : $.clientById(id);
        if (c) {
            c.send({ t: 'sleepOut', id: g.id });
            if (c.subOf) {
                var owner = $.clientById(c.subOf);
                if (owner) owner.send({ t: 'sleepSubOut', who: id, groupId: g.id });
            }
        }
    });
    $.dlog('sleep group', g.id, 'ends:', why);
};

$.sleepSet = function(id, st, why) {
    var g = $.sleepGroup, m = g && g.members[id];
    if (!m || m.st === st) return;
    $.dlog('sleep group', g.id + ':', $.playerLabel(id), m.st, '->', st, why ? '(' + why + ')' : '');
    m.st = st;
    m.t = $.clockMs();
    if (st === 'out') $.sleepersLate = $.sleepersLate.filter(function(s) { return s.id !== id; });
    $.sleepTellRoaming(g, false);
};

// the ones barrier 1 (at 1) or barrier 2 (at 2) still waits for
$.sleepPending = function(g, at) {
    return Object.keys(g.members).filter(function(id) {
        var st = g.members[id].st;
        if (st === 'awake' || st === 'lying' || st === 'scene') return true;
        return at === 2 && (st === 'ready' || st === 'dreaming');
    });
};

// this player's dream skips CE303
$.sleepNd = function(g, id) {
    return g.dayPassed || g.dayBy !== id;
};

$.sleepInfo = function(g, id) {
    var m = g.members[id];
    return { t: 'sleepIn', id: g.id, q: ++$.sleepInfoSeq, go1: g.go1, go2: g.go2, nd: $.sleepNd(g, id), st: m ? m.st : '',
        w: $.sleepPending(g, g.go1 ? 2 : 1).filter(function(x) { return x !== id; }).map($.playerLabel),
        sc: m && m.sc, mapId: m && m.mapId, split: !!g.split };
};

// to roaming members and sub-hosted members whose own PC reports the barriers
$.sleepTellRoaming = function(g, onlyWaiting) {
    Object.keys(g.members).forEach(function(id) {
        var c = id === 'host' ? null : $.clientById(id);
        if (!c) return;
        var st = g.members[id].st;
        if (onlyWaiting && st !== 'ready' && st !== 'done') return;
        c.send($.sleepInfo(g, id));
        if (c.subOf) {
            var owner = $.clientById(c.subOf);
            if (owner) owner.send(Object.assign({}, $.sleepInfo(g, id), { t: 'sleepSubInfo', who: id,
                groupId: g.id, mapId: g.members[id].mapId, sc: g.members[id].sc }));
        }
    });
};

// A sub-host runs its guests' bed pages in its own world. The main host keeps
// the barrier state and asks that sub-host to turn on the guest's own SW463.
$.subSleepMeta = {}; // sub-host: guestId -> { groupId, mapId }
$.subSleepPending = {}; // sub-host: guestId -> { groupId, mapId, until }
$.guestHandlers.sleepSubInfo = function(msg) {
    if (!$.subHosting() || !msg) return;
    var c = $.clientById(msg.who);
    if (!c || !c._sub) return;
    if ($.subSleepMeta[c.guestId] && $.subSleepMeta[c.guestId].groupId !== msg.groupId) {
        delete $.subSleepPending[c.guestId];
    }
    var old = $.subSleepMeta[c.guestId];
    $.subSleepMeta[c.guestId] = { groupId: msg.groupId, mapId: msg.mapId, sc: msg.sc || $.sceneSwitchesNow(),
        go1: !!msg.go1, go2: !!msg.go2, nd: !!msg.nd, st: msg.st || '', w: msg.w || [], split: !!msg.split,
        told1: old && old.groupId === msg.groupId ? !!old.told1 : false,
        told2: old && old.groupId === msg.groupId ? !!old.told2 : false,
        daySkipped: old && old.groupId === msg.groupId ? !!old.daySkipped : false };
    c.send({ t: 'sleepIn', id: msg.id, go1: !!msg.go1, go2: !!msg.go2, nd: !!msg.nd,
        st: msg.st || '', w: msg.w || [], mapId: msg.mapId, split: !!msg.split, q: msg.q });
    if (msg.go1) $.sleepUndo[c.guestId] = null; // (the night goes on: nothing to undo)
};

$.startSubSleep = function(c, meta) {
    if (!c || !c._sub || !meta || !$.subHosting() || $.isBusy(c) ||
            Number(meta.mapId) !== $gameMap.mapId() || !c.lastPos || c.lastPos.m !== $gameMap.mapId()) return false;
    $.subSleepMeta[c.guestId] = { groupId: meta.groupId, mapId: meta.mapId, sc: $.sceneSwitchesNow(),
        go1: false, go2: false, nd: true, st: 'lying', w: [], split: !!meta.split, told1: false, told2: false };
    $.ownSwitchesOf(c)[$.SLEEPING_SWITCH] = true;
    c._fhSleepNd = Math.max(1, $.clockMs());
    c.send({ t: 'cmd', c: 223, p: [[-255, -255, -255, 0], 40, false] });
    c.send({ t: 'cmd', c: 211, p: [0] });
    c.send({ t: 'toast', text: 'Co-op: you fall asleep with the others' });
    $gameMap.requestRefresh();
    $.sleepUndoTake(c.guestId, $gameMap.mapId(), 0);
    if ($.conn) $.conn.send({ t: 'sleepSubAt', who: c.guestId, id: meta.groupId, at: 'bed' });
    $.dlog('sleep group', meta.groupId + ': sub-host starts', c.name, 'on map', meta.mapId);
    return true;
};

$.guestHandlers.sleepSub = function(msg) {
    if (!$.subHosting() || !msg) return;
    var c = $.clientById(msg.who);
    if (!c || !c._sub || Number(msg.mapId) !== $gameMap.mapId() ||
            !c.lastPos || c.lastPos.m !== $gameMap.mapId()) return;
    var meta = { groupId: msg.groupId, mapId: msg.mapId, sc: $.sceneSwitchesNow(), split: !!msg.split };
    $.subSleepMeta[c.guestId] = meta;
    if (!$.startSubSleep(c, meta)) {
        $.subSleepPending[c.guestId] = { groupId: msg.groupId, mapId: msg.mapId,
            until: $.clockMs() + $.SLEEP_FALL_MS };
    }
};

$.guestHandlers.sleepSubOut = function(msg) {
    if (!$.subHosting() || !msg) return;
    var meta = $.subSleepMeta[msg.who];
    if (!meta || meta.groupId !== msg.groupId) return;
    delete $.subSleepMeta[msg.who];
    delete $.subSleepPending[msg.who];
};

$.guestHandlers.sleepSubWake = function(msg) {
    if (msg && $.subHosting()) $.wakeSubSleeper(msg.who, msg.groupId, !!msg.restore);
};

$.worldExtras.push(function() {
    if (!$.subHosting()) return;
    Object.keys($.subSleepPending).forEach(function(id) {
        var pending = $.subSleepPending[id], c = $.clientById(id);
        var meta = $.subSleepMeta[id];
        if (!meta || meta.groupId !== pending.groupId || !c || !c._sub || !c.lastPos ||
                (!meta.split && $.clockMs() > pending.until) || c.lastPos.m !== pending.mapId ||
                $gameMap.mapId() !== pending.mapId) {
            delete $.subSleepPending[id];
            if ($.conn && c) $.conn.send({ t: 'sleepSubAt', who: id, id: pending.groupId, at: 'awake' });
            return;
        }
        if ($.startSubSleep(c, pending)) delete $.subSleepPending[id];
    });
});

// A player lies down (again, or late) while the group has not woken yet.
$.sleepJoin = function(id) {
    var mapId = arguments.length > 1 ? Number(arguments[1]) : $.playerMapOfRest(id);
    var g = $.sleepGroup;
    if (!g || !$.isHost() || g.go2) return;
    var m = g.members[id];
    if (!m) {
        g.members[id] = { st: 'lying', t: $.clockMs(), sc: $.sceneSwitchesNow(), seen: false,
            relaid: 0, mapId: mapId || g.bed, daySkipped: false, manualAwake: false, bedPending: $.sleepRemote(id) };
        if (mapId && mapId !== g.bed) g.split = true;
        $.dlog('sleep group', g.id + ':', $.playerLabel(id), 'lies down late on map', mapId || g.bed);
        $.sleepTellRoaming(g, false);
        return;
    }
    if (mapId) m.mapId = mapId;
    if (m.mapId !== g.bed) g.split = true;
    if (m.st === 'awake') {
        m.manualAwake = false;
        m.sc = $.sceneSwitchesNow();
        m.seen = false;
        m.bedPending = $.sleepRemote(id);
        $.sleepSet(id, 'lying', 'uses a bed');
        return;
    }
    if (m.st !== 'scene' && m.st !== 'out') return;
    m.bedPending = $.sleepRemote(id);
    m.relaid++;
    m.manualAwake = false;
    m.sc = $.sceneSwitchesNow();
    m.seen = false;
    $.sleepSet(id, 'lying', 'lies down again');
};

var _layDownGuestBarrier = $.layDownGuest;
$.layDownGuest = function(c) {
    _layDownGuestBarrier(c);
    $.sleepJoin(c.guestId);
};

var _sendSleepNowBarrier = $.sendSleepNow;
$.sendSleepNow = function(c, m) {
    $.sleepJoin(c.guestId);
    _sendSleepNowBarrier(c, m);
    var g = $.sleepGroup;
    if (g && g.members[c.guestId]) c.send($.sleepInfo(g, c.guestId));
};

// a guest handed its map (and its dream page): its group state goes with it
var _sendRoamBarrier = $.sendRoam;
// A sleeper whose bed ran on another PC that is gone (its sub-host left) gets
// its map without its bed and without its event: it is awake again.
$.sendRoam = function(conn, opts) {
    var wasRoaming = !!(conn && conn.roam);
    if (conn) conn._fhSentSleep = false;
    _sendRoamBarrier(conn, opts);
    var g = $.sleepGroup, m = g && conn && g.members[conn.guestId];
    if (!$.isHost() || !m) return;
    if (!wasRoaming && !(opts && opts.interp) && !conn._fhSentSleep &&
            (m.st === 'lying' || m.st === 'scene' || m.st === 'ready')) {
        m.manualAwake = true;
        $.sleepSet(conn.guestId, g.go1 ? 'out' : 'awake', 'its bed was on a PC that is gone');
    }
    conn.send($.sleepInfo(g, conn.guestId));
};

// its dream skips the day unless it is the group's day
var _takeOwnSwitchesBarrier = $.takeOwnSwitches;
$.takeOwnSwitches = function(conn) {
    var out = _takeOwnSwitchesBarrier(conn);
    if (conn) conn._fhSentSleep = !!(out && out.sw && out.sw[$.SLEEPING_SWITCH]);
    var g = $.sleepGroup;
    if (out && g && conn && g.members[conn.guestId] && out.sw && out.sw[$.SLEEPING_SWITCH]) {
        out.nd = $.sleepNd(g, conn.guestId);
    }
    return out;
};

// Kept for older callers: a busy host stays in the roster until it uses a bed.
$.onHostStaysAwake = function() {
    var g = $.sleepGroup, m = g && g.members.host;
    if (m && m.st === 'lying') {
        m.autoMap = $gameMap.mapId();
        $.sleepSet('host', 'awake', 'busy - lies down here when free');
    }
};

// A scene before the dream is retried on the same bed map. In a split group,
// an ordinary wake-up returns the member to awake and keeps it in the roster.
$.sleepWokeEarly = function(id, scene) {
    var g = $.sleepGroup, m = g && g.members[id];
    if (!m || m.st !== 'lying') return;
    if ($.sleepUndo) delete $.sleepUndo[id]; // (awake without a dream: what happened stays)
    if (scene && $.SLEEP_RELIE && m.relaid < $.SLEEP_RELIE_MAX) {
        m.manualAwake = false;
        $.sleepSet(id, 'scene', 'a scene before its dream - lies down again when free');
        if (id !== 'host' && !$.sleepersLate.some(function(s) { return s.id === id; })) {
            $.sleepersLate.push({ id: id, until: $.clockMs() + $.SLEEP_FALL_MS, m: m.mapId || g.bed });
        }
        return;
    }
    var pending = m.bedPending;
    m.manualAwake = true;
    m.bedPending = false;
    $.sleepSet(id, g.split ? 'awake' : 'out', pending ? 'not in bed after all' : scene ?
        'a scene before its dream - stays awake (SLEEP_RELIE off)' : 'awake without a dream');
    if (g.split && !pending) $.sleepNotify(id, true); // (the night ambush: it has to lie down again)
};

$.sleeperGoneWhy = function(id) {
    if (id === 'host') return $.isDead('host') ? 'dead' : $.isDown('host') ? 'down' : '';
    var c = $.clientById(id);
    if (!c || !c.actorId) return 'left';
    if ($.isDead(id)) return 'dead';
    if ($.isDown(id)) return 'down';
    if (c.solo) return 'elsewhere';
    return '';
};

// Host, every frame: who is gone, who woke before the dream, who is too slow.
$.sleepMonitorFrame = -1;
$.sleepMonitor = function() {
    var g = $.sleepGroup;
    if (!g || !$.isHost() || $.ctx) return;
    $.sleepMonitorFrame = Graphics.frameCount;
    var now = $.clockMs();
    if (now - g.t0 > $.SLEEP_GROUP_MS && !(g.split && !g.go1)) {
        $.endSleepGroup('too long');
        return;
    }
    // every living player is in the roster until the dreams begin (one who
    // joined the session meanwhile too: awake, it has to lie down as well)
    if (!g.go1) {
        $.restLivingIds().forEach(function(id) {
            if (g.members[id] || $.sleeperGoneWhy(id)) return;
            var mapId = $.playerMapOfRest(id) || g.bed;
            g.members[id] = { st: 'awake', t: now, sc: $.sceneSwitchesNow(), seen: false, relaid: 0,
                mapId: mapId, daySkipped: false, manualAwake: true };
            if (mapId !== g.bed) g.split = true;
            $.dlog('sleep group', g.id + ':', $.playerLabel(id), 'is in the game now - awake on map', mapId);
            $.sleepTellRoaming(g, false);
        });
    }
    Object.keys(g.members).forEach(function(id) {
        var m = g.members[id];
        if (m.st === 'woke') return;
        var why = $.sleeperGoneWhy(id);
        if (m.st === 'out') {
            // up again from down, or back in the session, before the dreams:
            // in the roster again (it lies down in a bed itself)
            if (g.split && !g.go1 && m.gone && !why) {
                m.gone = '';
                m.manualAwake = true;
                $.sleepSet(id, 'awake', 'back');
            }
            return;
        }
        if (why) {
            m.gone = why;
            $.sleepSet(id, 'out', why);
            return;
        }
        // one map's group: who did not get to bed in time holds nobody (as before)
        if (!g.split && !g.go1 && m.st === 'awake' && now - m.t > $.SLEEP_FALL_MS &&
                !$.sleepersLate.some(function(s) { return s.id === id; })) {
            $.sleepSet(id, 'out', 'not in bed in time');
            return;
        }
        if (m.st === 'dreaming' && id === 'host') $.sleepLeftDream(m, 'host');
        var c = id === 'host' ? null : $.clientById(id);
        // If a local party agreed to rest while the host was busy, it joins
        // as soon as that map is free. A player who chose X stays awake until
        // they use a bed again.
        if (m.st === 'awake' || m.st === 'out') {
            var on = $.playerMapOfRest(id);
            if (on) m.mapId = on;
            if (!g.go1 && m.st === 'awake' && m.mapId !== g.bed) g.split = true;
        }
        if (!c && m.st === 'awake') {
            if (m.autoMap && m.autoMap !== $gameMap.mapId()) m.autoMap = 0; // it left that map
            if (m.autoMap && $.hostCanLieDown() && $.layDownHost()) {
                m.autoMap = 0;
                m.sc = $.sceneSwitchesNow();
                m.seen = false;
                $.sleepSet('host', 'lying', 'lies down after the map vote');
            }
            return;
        }
        if (m.st !== 'lying' && m.st !== 'scene') return;
        if (!g.split && now - m.t > $.SLEEP_FALL_MS) {
            $.sleepSet(id, 'out', m.st === 'scene' ? 'not free to lie down again in time' : 'not in its dream in time');
            return;
        }
        if (c && (c.roam || c.subOf)) {
            // its PC / sub-host reports sleepAt; no word of its bed in time: awake
            // (a "No" at the bed, a lie-down that never came - review M1)
            if (g.split && m.st === 'lying' && now - m.t > $.SLEEP_FALL_MS) {
                m.bedPending = false;
                $.sleepSet(id, 'awake', 'no word of its bed');
                c.send({ t: 'toast', text: 'Co-op: ' + $.NOT_IN_BED_TEXT });
            }
            return;
        }
        var asleep = c ? !!$.ownSwitchesOf(c)[$.SLEEPING_SWITCH] : !!$gameSwitches._data[$.SLEEPING_SWITCH];
        if (m.st === 'lying') {
            if (asleep) {
                m.seen = true;
            } else if (m.seen) {
                m.seen = false;
                $.sleepWokeEarly(id, $.sceneFlipped(m.sc, $.sleeperActorId(id)));
            }
            return;
        }
        // The host lies down again here (a guest: through $.sleepersLate).
        if (!c && m.st === 'scene' && m.mapId === $gameMap.mapId() && $.hostCanLieDown() && $.layDownHost()) {
            m.relaid++;
            m.manualAwake = false;
            m.sc = $.sceneSwitchesNow();
            m.seen = false;
            $.sleepSet('host', 'lying', 'lies down again');
        }
    });
    $.sleepRelease();
};
$.worldExtras.push(function() { $.sleepMonitor(); });

// Out of the dream without its way out (barrier 2): the Hexen board's exits
// to Map174 / Map164 (Map031 EV1 p1: another player's V2289 / V2592, the way
// in from Donnovan's house or the school). It holds nobody: the others waited
// SLEEP_WAKE_MS at their way out for a dream that was over.
$.sleepLeftDream = function(m, id) {
    var p = $.realPlayer || $gamePlayer;
    if ($.DREAM_MAPS[$gameMap.mapId()]) {
        m.inDream = true;
    } else if (m.inDream && !p.isTransferring()) {
        $.sleepSet(id, 'out', 'left the dream another way');
    }
};

$.sleepRelease = function() {
    var g = $.sleepGroup;
    if (!g || !$.isHost()) return;
    var ids = Object.keys(g.members);
    var st = function(id) { return g.members[id].st; };
    if (ids.every(function(id) { return st(id) === 'out' || st(id) === 'woke' || (g.go1 && st(id) === 'awake'); })) {
        $.endSleepGroup(ids.some(function(id) { return st(id) === 'woke'; }) ? 'everyone is awake' : 'nobody dreams');
        return;
    }
    if (!g.go1 && !ids.some(function(id) { return st(id) === 'lying' || st(id) === 'scene' || st(id) === 'ready'; })) {
        $.endSleepGroup('nobody is in bed'); // (all got up again)
        return;
    }
    if (!g.go1 && !$.sleepPending(g, 1).length) $.sleepGo(g, 1);
    if (g.go1 && !g.go2 && g.t2) {
        var late = $.clockMs() - g.t2 > $.SLEEP_WAKE_MS;
        if (!$.sleepPending(g, 2).length || late) $.sleepGo(g, 2, late);
    }
    // the names a waiting PC shows
    var key = JSON.stringify([g.go1, g.go2, $.sleepPending(g, g.go1 ? 2 : 1)]);
    if (key !== g.waitKey) {
        g.waitKey = key;
        $.sleepTellRoaming(g, true);
    }
};

$.sleepGo = function(g, at, late) {
    var members = g.members;
    if (at === 1) {
        g.go1 = true;
        $.sleepUndo = {};
        var by = members[g.dayBy];
        if (!g.dayPassed && (!by || by.st !== 'ready')) {
            var ready = Object.keys(members).filter(function(id) { return members[id].st === 'ready'; });
            if (ready.length) g.dayBy = ready.indexOf('host') >= 0 ? 'host' : ready[0];
        }
        Object.keys(members).forEach(function(id) { if (members[id].st === 'ready') members[id].st = 'dreaming'; });
        $.dlog('sleep group', g.id + ': everyone is asleep - into the dreams', g.dayPassed ? '(the day passed already)' :
            '(the day passes in the dream of ' + $.playerLabel(g.dayBy) + ')');
    } else {
        g.go2 = true;
        Object.keys(members).forEach(function(id) { if (members[id].st === 'done') members[id].st = 'woke'; });
        $.dlog('sleep group', g.id + ':', late ? 'waited long enough - the ones awake wake up' : 'everyone dreamt - all wake up');
    }
    $.sleepTellRoaming(g, false);
};

// Host: a guest running its own map, or its sub-host, reports sleep progress.
$.handleSleepAt = function(id, msg, reply) {
    var g = $.sleepGroup;
    if (!msg || !g || g.id !== msg.id || !g.members[id]) {
        reply.send({ t: 'sleepOut', id: msg && msg.id });
        return;
    }
    var m = g.members[id];
    if ((msg.at === 'bed' || msg.at === 'ready') && m.bedPending) {
        m.bedPending = false; // its PC turned its SW463 on: in bed
        m.t = $.clockMs();
        $.sleepNotify(id);
    }
    if (msg.at === 'ready') {
        if (m.st !== 'dreaming' && m.st !== 'done' && m.st !== 'woke') $.sleepSet(id, g.go1 ? 'dreaming' : 'ready');
    } else if (msg.at === 'done') {
        if (m.st !== 'woke') {
            if (!g.t2) g.t2 = $.clockMs();
            $.sleepSet(id, g.go2 ? 'woke' : 'done');
        }
    } else if (msg.at === 'awake') {
        $.sleepWokeEarly(id, !!msg.scene);
    } else if (msg.at === 'cancel') {
        $.cancelSleepMember(id, g.id, 'gets up while waiting');
    } else if (msg.at === 'left' && m.st === 'dreaming') {
        $.sleepSet(id, 'out', 'left the dream another way');
    }
    $.sleepRelease();
    if ($.sleepGroup === g) reply.send($.sleepInfo(g, id));
};

$.hostHandlers.sleepAt = function(conn, msg) {
    $.handleSleepAt(conn.guestId, msg, conn);
};

$.hostHandlers.sleepSubAt = function(conn, msg) {
    var c = msg && $.clientById(msg.who);
    if (!c || c.subOf !== conn.guestId) return;
    $.handleSleepAt(c.guestId, msg, c);
};

$.hostHandlers.sleepCancel = function(conn, msg) {
    if ($.subHosting()) {
        var meta = $.subSleepMeta[conn.guestId];
        if (!meta || !meta.split || meta.go1 || meta.st !== 'ready') return;
        // only ask: the host may have let everyone dream already (review S1)
        if ($.conn) $.conn.send({ t: 'sleepSubAt', who: conn.guestId, id: meta.groupId, at: 'cancel' });
        return;
    }
    if (!conn || conn.roam || conn.subOf || !msg) return;
    var g = $.sleepGroup;
    if (g && msg.id === g.id) $.cancelSleepMember(conn.guestId, g.id, 'gets up while waiting');
};

$.guestHandlers.sleepIn = function(msg) {
    var s = $.sleepMine;
    if (!s || s.id !== msg.id) {
        s = $.sleepMine = { id: msg.id, phase: 'bed', seen: false, sc: null, told1: false, told2: false, daySkipped: false };
    }
    // (a sub-host's guest gets it twice: the host's and the sub-host's relay)
    if (msg.q && s.q && msg.q < s.q) return;
    if (msg.q) s.q = msg.q;
    s.go1 = !!msg.go1;
    s.go2 = !!msg.go2;
    s.nd = !!msg.nd;
    if (s.st !== (msg.st || '')) s.upAsked = false;
    s.st = msg.st || '';
    if (s.go1) $.sleepUndo[$.myId] = null;
    s.split = !!msg.split;
    s.mapId = Number(msg.mapId) || 0;
    s.w = Array.isArray(msg.w) ? msg.w : [];
};

$.guestHandlers.sleepOut = function(msg) {
    if ($.sleepMine && (!msg || $.sleepMine.id === msg.id)) $.sleepMine = null;
};

$.abortSleepWait = function(id) {
    var list = [];
    if ($gameMap && $gameMap._interpreter) list.push($gameMap._interpreter);
    if ($.owned && $.owned[id] && $.owned[id].interp) list.push($.owned[id].interp);
    list.forEach(function(interp) {
        if (!interp || !interp._fhSleep || interp._fhSleep.who !== id || interp._fhSleep.at !== 1) return;
        if (interp.terminate) interp.terminate();
        interp._waitMode = '';
        interp._fhSleep = null;
        interp._fhSleepPass = -1;
    });
};

// Getting up (X at barrier 1): undo what the bed's first page did (Map005
// EV114 p0: SW202 / SW410 on, menu off, dark, hidden, SW463 on) and the wake
// spot its dream page set (SW561-571), like the night ambush's way up.
$.SLEEP_UP_SWITCHES = [202, 410].concat($.OWN_SWITCHES);
$.wakeLocalSleep = function(ownsWorld) {
    if (ownsWorld && $gameSwitches) {
        $.SLEEP_UP_SWITCHES.forEach(function(id) { $gameSwitches.setValue(id, false); });
        if ($gameSystem) $gameSystem.enableMenu();
    }
    if ($gameScreen) $gameScreen.startTint([0, 0, 0, 0], 10);
    if ($gamePlayer) $gamePlayer.setTransparent(false);
    if ($gameMap) $gameMap.requestRefresh();
};

// The same for a guest whose bed runs on this PC (its own values).
$.wakeOwnedSleep = function(c) {
    $.SLEEP_UP_SWITCHES.forEach(function(id) {
        if (c._fhOwnSw) delete c._fhOwnSw[id];
        if (c._fhCtxSw) delete c._fhCtxSw[id];
    });
    c._fhSleepNd = 0;
};

$.wakeSubSleeper = function(id, groupId, restore) {
    var c = $.clientById(id), meta = $.subSleepMeta[id];
    if (!c || !c._sub || !meta || (groupId && meta.groupId !== groupId)) return;
    $.wakeOwnedSleep(c);
    $.sleepUndoRestore(id, restore);
    delete $.subSleepPending[id];
    meta.st = 'awake';
    meta.told1 = false; // (a bed again this night: its dream move is told again)
    $.abortSleepWait(id);
    c.send({ t: 'sleepWake', id: meta.groupId });
    $.dlog('sleep group', meta.groupId + ': sub-host lets', c.name, 'get up');
};

$.cancelSleepMember = function(id, groupId, why) {
    var g = $.sleepGroup, m = g && g.members[id];
    // (only at barrier 1: a bed page still running would take it to the dream)
    if (!g || !m || g.id !== groupId || !g.split || g.go1 || m.st !== 'ready') return false;
    // the night's world values its bed set go back unless another one sleeps on that map (review S4)
    var restore = !Object.keys(g.members).some(function(o) {
        return o !== id && $.sleepInBed(o) && g.members[o].mapId === m.mapId;
    });
    if (id === 'host') {
        $.wakeLocalSleep(true);
        $.sleepUndoRestore('host', restore);
    } else {
        var c = $.clientById(id);
        if (c) {
            if (!c.roam && !c.subOf) {
                $.wakeOwnedSleep(c); // (its own PC / its sub-host has the rest)
                $.sleepUndoRestore(id, restore);
            }
            if (c.subOf) {
                var owner = $.clientById(c.subOf);
                if (owner) owner.send({ t: 'sleepSubWake', who: id, groupId: g.id, restore: restore });
            } else {
                c.send({ t: 'sleepWake', id: g.id, restore: restore });
            }
        }
    }
    m.autoMap = 0;
    $.abortSleepWait(id);
    $.sleepersLate = $.sleepersLate.filter(function(s) { return s.id !== id; });
    m.manualAwake = true;
    $.sleepSet(id, 'awake', why || 'gets up while waiting');
    $.sleepNotify(id, true);
    $.dlog('sleep group', g.id + ':', $.playerLabel(id), 'gets up; the day still waits for this player');
    $.sleepRelease();
    return true;
};

$.guestHandlers.sleepWake = function(msg) {
    if (!msg) return;
    var ownsWorld = $.isRoaming();
    $.wakeLocalSleep(ownsWorld);
    if (ownsWorld) $.sleepUndoRestore($.myId, !!msg.restore);
    $.abortSleepWait($.isGuest() ? $.myId : 'host');
    if ($.sleepMine && $.sleepMine.id === msg.id) {
        $.sleepMine.st = 'awake';
        $.sleepMine.upAsked = false;
        // a bed again this night tells the host its bed and its dream move again
        // (they were told: it lay down again, the others waited for it for good)
        $.sleepMine.phase = 'bed';
        $.sleepMine.seen = false;
        $.sleepMine.inDream = false;
        $.sleepMine.told1 = false;
    }
};

// The player whose move this is: 'host', a guest id, or null (not a sleeper's).
$.sleeperOf = function(interp) {
    if ($.isHost()) return interp._fhOwner || ($.ctx ? null : 'host');
    if ($.isGuest() && $.subHosting() && interp._fhOwner && $.subSleepMeta[interp._fhOwner]) return interp._fhOwner;
    if ($.isGuest() && $.isRoaming() && !interp._fhOwner) return $.myId;
    return null;
};

// 1: into the dream asleep (a bed's dream page), 2: out of the dream, 0: other
$.sleepStep = function(interp) {
    if ($gameParty.inBattle()) return 0;
    var from = $gameMap.mapId(), to = $.transferTarget(interp);
    if (to === $.DREAM_MAP && !$.DREAM_MAPS[from] && $gameSwitches._data[$.SLEEPING_SWITCH]) return 1;
    // (a guest's event the host runs is never in a dream: dreams are never the host's map)
    if (from === $.DREAM_MAP && !$.DREAM_MAPS[to] && !interp._fhOwner) return 2;
    return 0;
};

// true: this transfer waits (wait mode 'fhSleep')
$.sleepBarrier = function(interp) {
    var step = $.sleepStep(interp);
    var who = step ? $.sleeperOf(interp) : null;
    if (!who) return false;
    if ($.isHost()) return $.sleepBarrierHost(interp, who, step);
    if ($.subHosting() && interp._fhOwner) return $.sleepBarrierSubGuest(interp, who, step);
    return $.sleepBarrierGuest(interp, step);
};

$.sleepBarrierSubGuest = function(interp, who, step) {
    var meta = $.subSleepMeta[who];
    if (!meta || !$.conn) return false;
    var key = 'told' + step;
    if (!meta[key]) {
        meta[key] = true;
        $.conn.send({ t: 'sleepSubAt', who: who, id: meta.groupId, at: step === 1 ? 'ready' : 'done' });
    }
    if (step === 1 ? meta.go1 : meta.go2) return false;
    $.sleepWait(interp, meta.groupId, step, who, true);
    return true;
};

$.sleepBarrierHost = function(interp, who, step) {
    // the bed's player gets here first: the others lie down now (the group forms)
    if (step === 1 && $.sleepVote && $.sleepVote.from === who) $.sleepTogether(who);
    var g = $.sleepGroup, m = g && g.members[who];
    if (!m) return false;
    if (step === 1) {
        if (m.st === 'dreaming' || m.st === 'done' || m.st === 'woke') return false;
        $.sleepSet(who, g.go1 ? 'dreaming' : 'ready');
    } else {
        if (m.st === 'woke') return false;
        if (!g.t2) g.t2 = $.clockMs();
        $.sleepSet(who, g.go2 ? 'woke' : 'done');
    }
    $.sleepRelease();
    if ($.sleepGroup !== g || (step === 1 ? g.go1 : g.go2)) return false;
    $.sleepWait(interp, g.id, step, who);
    return true;
};

$.sleepBarrierGuest = function(interp, step) {
    var s = $.sleepMine;
    if (!s || !$.conn) return false;
    if (step === 1) s.phase = 'dream';
    if (!s['told' + step]) {
        s['told' + step] = true;
        $.conn.send({ t: 'sleepAt', id: s.id, at: step === 1 ? 'ready' : 'done' });
    }
    if (step === 1 ? s.go1 : s.go2) return false;
    $.sleepWait(interp, s.id, step, $.myId);
    return true;
};

$.sleepWait = function(interp, id, step, who, sub) {
    interp._fhSleep = { id: id, at: step, who: who, since: $.clockMs(), hint: 0, sub: !!sub };
    interp.setWaitMode('fhSleep');
    $.dlog('sleep group', id + ':', $.isHost() ? $.playerLabel(who) : 'this player', 'waits',
        step === 1 ? 'to fall asleep with the others' : 'to wake with the others');
    $.sleepHint(interp, true);
};

$.sleepWaitOver = function(interp) {
    var w = interp._fhSleep;
    if (!w || !$.role) return true;
    if ($.isHost()) {
        // (the world extras stop with the last guest gone: the check runs here then)
        if (!$.ctx && $.sleepMonitorFrame !== Graphics.frameCount) $.sleepMonitor();
        var g = $.sleepGroup, m = g && g.id === w.id ? g.members[w.who] : null;
        if (!m || m.st === 'out') return true;
        return w.at === 1 ? g.go1 : g.go2;
    }
    if (w.sub && $.subHosting()) {
        var sub = $.subSleepMeta[w.who];
        if (!sub || sub.groupId !== w.id) return true;
        if (w.at === 1 ? sub.go1 : sub.go2) return true;
        // (in bed for the ones on other maps: as long as it takes, X gets up)
        return !(w.at === 1 && sub.split) && $.clockMs() - w.since > $.SLEEP_GROUP_MS;
    }
    var s = $.sleepMine;
    if (!s || s.id !== w.id || !$.isRoaming()) return true;
    if (w.at === 1 ? s.go1 : s.go2) return true;
    // no word from the host for longer than a group lives (a host that leaves
    // or loads lets it go at once: leaveAsGuest, snap, sleepOut)
    if (!(w.at === 1 && s.split) && $.clockMs() - w.since > $.SLEEP_GROUP_MS) {
        $.dlog('sleep group', w.id + ': no word from the host - goes on alone');
        return true;
    }
    return false;
};

$.sleepHint = function(interp, now) {
    var w = interp._fhSleep;
    if (!w) return;
    var t = $.clockMs();
    if (!now && t - (w.hint || 0) < $.SLEEP_HINT_MS) return;
    w.hint = t;
    var names = [];
    if ($.isHost()) {
        var g = $.sleepGroup;
        if (g) names = $.sleepPending(g, w.at).filter(function(id) { return id !== w.who; }).map($.playerLabel);
    } else if (w.sub && $.subSleepMeta[w.who]) {
        names = $.subSleepMeta[w.who].w || [];
    } else if ($.sleepMine) {
        names = $.sleepMine.w || [];
    }
    var text = (w.at === 1 ? $.SLEEP_FALL_TEXT : $.SLEEP_WAKE_TEXT) + (names.length ? ' (' + names.join(', ') + ')' : '');
    var canGetUp = w.at === 1 && ($.isHost() ? !!($.sleepGroup && $.sleepGroup.split) :
        w.sub ? !!($.subSleepMeta[w.who] && $.subSleepMeta[w.who].split) : !!($.sleepMine && $.sleepMine.split));
    if (canGetUp) text += ' (X: get up)';
    if ($.isHost() && w.who !== 'host') $.sendTo(w.who, { t: 'toast', text: text });
    else if (w.sub) $.sendTo(w.who, { t: 'toast', text: text });
    else $.toast(text);
};

// A long wait at barrier 1 (others still awake, maybe on other maps): the
// dream page's white screen (223 [255,255,255,0] before its 201) dims to
// dark, the player lying in bed; it turns white again before the move.
$.SLEEP_DIM_MS = 3000;
$.SLEEP_UNDIM_FRAMES = 20;
$.sleepDim = function(interp, on) {
    var tone = on ? [-255, -255, -255, 0] : [255, 255, 255, 0];
    var frames = on ? 60 : $.SLEEP_UNDIM_FRAMES;
    if (interp._fhOwner) {
        $.sendTo(interp._fhOwner, { t: 'cmd', c: 223, p: [tone, frames, false] }); // (its screen)
    } else if ($gameScreen) {
        $gameScreen.startTint(tone, frames);
    }
};

// Outermost: before the guest transfer, the way back to the host and the
// defeat scenes (they all run after the wait).
var _command201Barrier = Game_Interpreter.prototype.command201;
Game_Interpreter.prototype.command201 = function() {
    if (this._fhSleepPass !== this._index && $.role && $.sleepBarrier(this)) return false;
    var index = this._index;
    var result = _command201Barrier.call(this);
    if (this._index !== index || this._waitMode) this._fhSleepPass = -1;
    return result;
};

var _updateWaitModeBarrier = Game_Interpreter.prototype.updateWaitMode;
Game_Interpreter.prototype.updateWaitMode = function() {
    if (this._waitMode === 'fhSleep') {
        var wait = this._fhSleep;
        if (wait && wait.at === 1 && wait.who === 'host' && $.sleepGroup && $.sleepGroup.split &&
                Input.isTriggered('cancel') && !$gameMessage.isBusy()) {
            $.cancelSleepMember('host', wait.id, 'gets up while waiting');
            return true;
        }
        if (!$.sleepWaitOver(this)) {
            if (wait && wait.at === 1 && !wait.dim && $.clockMs() - wait.since > $.SLEEP_DIM_MS) {
                wait.dim = true;
                $.sleepDim(this, true);
            }
            $.sleepHint(this, false);
            return true;
        }
        this._waitMode = '';
        this._fhSleep = null;
        this._fhSleepPass = this._index; // the same transfer goes now
        if (wait && wait.dim) {
            $.sleepDim(this, false); // the dream page's white again, then the move
            this._waitCount = $.SLEEP_UNDIM_FRAMES;
            return true;
        }
        return false;
    }
    return _updateWaitModeBarrier.call(this);
};

// Guest running its own map: it tells the host when it woke before its dream
// (or left the dream without its way out: $.sleepLeftDream).
$.guestExtras.push(function() {
    var s = $.sleepMine;
    if (!s || !$.isGuest() || !$.conn) return;
    if (s.split && !s.go1 && s.st === 'ready' && !s.upAsked &&
            Input.isTriggered('cancel') && !$gameMessage.isBusy() && SceneManager._scene instanceof Scene_Map) {
        // only ask: the host may have let everyone dream already; it answers
        // with 'sleepWake' (then this PC gets up) or the dream (review S1)
        s.upAsked = true;
        if ($.isRoaming()) $.conn.send({ t: 'sleepAt', id: s.id, at: 'cancel' });
        else $.conn.send({ t: 'sleepCancel', id: s.id });
        return;
    }
    if (!$.isRoaming()) return;
    if (s.phase === 'dream' && !s.told2) {
        var inDream = !!$.DREAM_MAPS[$gameMap.mapId()];
        if (inDream) s.inDream = true;
        if (inDream || !s.inDream || $gamePlayer.isTransferring()) return;
        s.phase = 'left';
        $.dlog('sleep group', s.id + ': left the dream another way (map ' + $gameMap.mapId() + ')');
        $.conn.send({ t: 'sleepAt', id: s.id, at: 'left' });
        return;
    }
    if (s.phase !== 'bed') return;
    if ($.DREAM_MAPS[$gameMap.mapId()]) {
        s.phase = 'dream';
        return;
    }
    if ($gameSwitches._data[$.SLEEPING_SWITCH]) {
        if (!s.seen) {
            s.seen = true;
            s.sc = $.sceneSwitchesNow();
            $.conn.send({ t: 'sleepAt', id: s.id, at: 'bed' }); // in bed now (review M1)
        }
        return;
    }
    if (!s.seen) return;
    s.seen = false;
    var scene = $.sceneFlipped(s.sc, $.myActorId);
    delete $.sleepUndo[$.myId];
    $.dlog('sleep group', s.id + ': awake before the dream', scene ? '(a scene before the dream)' : '');
    $.conn.send({ t: 'sleepAt', id: s.id, at: 'awake', scene: scene });
});

// The day passes once per group.
var _command117Barrier = Game_Interpreter.prototype.command117;
Game_Interpreter.prototype.command117 = function() {
    if (this._params[0] === $.DAY_CE && $.role && $gameMap.mapId() === $.DREAM_MAP && $.groupSkipsDay(this)) return true;
    return _command117Barrier.call(this);
};

$.groupSkipsDay = function(interp) {
    if ($.isHost()) {
        var g = $.sleepGroup, m = g && !interp._fhOwner && !$.ctx ? g.members.host : null;
        if (!m || !$.sleepNd(g, 'host') || m.daySkipped) return false;
        m.daySkipped = true;
        $.dlog('sleep group', g.id + ': the day passes in another dream - CE303 skipped here');
        return true;
    }
    if ($.subHosting() && interp._fhOwner) {
        var sub = $.subSleepMeta[interp._fhOwner];
        if (!sub || !sub.nd) return false;
        if (sub.daySkipped) return false;
        sub.daySkipped = true;
        $.dlog('sleep group', sub.groupId + ': the day passes in another dream - CE303 skipped for', $.playerLabel(interp._fhOwner));
        return true;
    }
    var s = $.isGuest() && $.isRoaming() ? $.sleepMine : null;
    if (!s) return false;
    if (!s.nd) {
        $.skipDayUntil = 0; // this dream passes the group's day
        return false;
    }
    if (s.daySkipped) return false;
    s.daySkipped = true;
    $.skipDayUntil = 0;
    $.dlog('sleep group', s.id + ': the day passes in another dream - CE303 skipped here');
    return true;
};

// A load, the title, leaving: no group any more.
var _resetRoamsBarrier = $.resetRoams;
$.resetRoams = function() {
    _resetRoamsBarrier();
    $.endSleepGroup('a load or the title');
};

var _leaveAsGuestBarrier = $.leaveAsGuest;
$.leaveAsGuest = function(message) {
    $.sleepMine = null;
    $.subSleepMeta = {};
    $.subSleepPending = {};
    _leaveAsGuestBarrier(message);
};

// back in the host's game: the host keeps its state
var _snapBarrier = $.guestHandlers.snap;
$.guestHandlers.snap = function(msg) {
    $.sleepMine = null;
    $.subSleepMeta = {}; // (no sub-host any more)
    $.subSleepPending = {};
    return _snapBarrier(msg);
};


//=============================================================================
// Sleeping across maps: review fixes (v0.41, docs/조사(보관용)/검수/0.41_검수.md)
//=============================================================================
// M1: a bed run on another PC (a guest running its own map, a sub-host's
// guest) is in the group from its vote, but its player may still pick
// "Leave" at the bed's choice. Until that PC says its SW463 is on ('bed' /
// 'ready') the member is bedPending: not "in bed" for votes and toasts. The
// PC says 'awake' when the bed's event ends without it (or a lie-down it was
// sent is dropped); with no word for SLEEP_FALL_MS the host makes it awake.
// S4: X gives back the world values its bed's page and that map's dream pages
// write (Map020 SW2256 / V2467 / V2549, Map014 SW3088, Map087 / 105
// V909-921 / V545 ...), taken on the PC that runs that bed just before it
// runs; not while another player still sleeps on that map.

$.NOT_IN_BED_TEXT = 'You are not in bed. Lie down in any bed to sleep with the others.';
$.SLEEP_BED_CHECK_MS = 500; // (real time) the bed's event ended without SW463: "Leave"
$.sleepInfoSeq = 0;

// its bed runs on its own PC or on its sub-host's
$.sleepRemote = function(id) {
    var c = id === 'host' ? null : $.clientById(id);
    return !!c && !!(c.roam || c.subOf);
};

$.sleepUndo = {}; // player id -> { at, sw: { id: value }, v: { id: value } } (this PC's world)
$.sleepWritesCache = {};

// What a bed (its trigger 0-2 page that turns SW463 on) and that map's dream
// pages (autorun on SW463) write, without the values that are each player's.
$.sleepWrites = function(mapId, evId) {
    var key = mapId + ':' + evId;
    if ($.sleepWritesCache[key]) return $.sleepWritesCache[key];
    var out = { sw: [], v: [] };
    if (!$dataMap || !$gameMap || $gameMap.mapId() !== mapId) return out;
    var sw = {}, v = {};
    var take = function(list) {
        (list || []).forEach(function(cmd) {
            var p = cmd.parameters, i;
            if (cmd.code === 121) for (i = p[0]; i <= p[1]; i++) sw[i] = true;
            if (cmd.code === 122) for (i = p[0]; i <= p[1]; i++) v[i] = true;
        });
    };
    ($dataMap.events || []).forEach(function(ev) {
        if (!ev) return;
        ev.pages.forEach(function(page) {
            var c = page.conditions;
            var dream = page.trigger === 3 && ((c.switch1Valid && c.switch1Id === $.SLEEPING_SWITCH) ||
                (c.switch2Valid && c.switch2Id === $.SLEEPING_SWITCH));
            var bed = ev.id === evId && page.trigger <= 2 && $.pageStartsSleep(page.list);
            if (dream || bed) take(page.list);
        });
    });
    var mine = {};
    ($.CTX_OWN_SWITCHES || []).concat($.SELECT_SWITCHES || []).forEach(function(id) { mine[id] = true; });
    out.sw = Object.keys(sw).map(Number).filter(function(id) { return !$.NO_SYNC_SWITCHES[id] && !mine[id]; });
    out.v = Object.keys(v).map(Number).filter(function(id) { return !$.DREAM_PC_V[id]; });
    $.sleepWritesCache[key] = out;
    return out;
};

// Before this player's bed runs here. Being laid down again keeps the first
// (the same lie-down); waking without a dream (a night ambush, a scene)
// drops it - what happened then stays ($.sleepWokeEarly, the PCs' 'awake').
$.sleepUndoTake = function(id, mapId, evId) {
    var old = $.sleepUndo[id], now = $.clockMs();
    if (old && !evId && now - old.at < $.SLEEP_FALL_MS) return;
    var w = $.sleepWrites(mapId, evId), rec = { at: now, ev: evId, sw: {}, v: {} };
    w.sw.forEach(function(sid) { rec.sw[sid] = !!$gameSwitches._data[sid]; });
    w.v.forEach(function(vid) { rec.v[vid] = $gameVariables._data[vid] || 0; });
    $.sleepUndo[id] = rec;
};

$.sleepUndoRestore = function(id, restore) {
    var rec = $.sleepUndo[id];
    delete $.sleepUndo[id];
    if (!rec || !restore) return;
    var back = [];
    Object.keys(rec.sw).forEach(function(sid) {
        if (!!$gameSwitches._data[sid] === rec.sw[sid]) return;
        $gameSwitches.setValue(Number(sid), rec.sw[sid]);
        back.push('S' + sid);
    });
    Object.keys(rec.v).forEach(function(vid) {
        if (($gameVariables._data[vid] || 0) === rec.v[vid]) return;
        $gameVariables.setValue(Number(vid), rec.v[vid]);
        back.push('V' + vid);
    });
    if (back.length) $.dlog('sleep: got up -', $.playerLabel(id), 'its bed\'s values back:', back.join(' '));
};

// Guest running its own map: the vote said yes - its values before the bed;
// then watch whether the bed turned its SW463 on.
$.sleepBedAsk = null; // guest: { ev, map, at }
var _askOkBed = $.guestHandlers.askOk;
$.guestHandlers.askOk = function(msg) {
    var ask = $.roamAsk;
    if (ask && msg && ask.id === msg.id && ask.sleep) {
        $.sleepUndoTake($.myId, ask.map, ask.ev);
        $.sleepBedAsk = { ev: ask.ev, map: ask.map, at: $.clockMs() };
    }
    _askOkBed(msg);
};

$.guestExtras.push(function() {
    var a = $.sleepBedAsk;
    if (!a) return;
    if (!$.isRoaming() || $gameSwitches._data[$.SLEEPING_SWITCH]) {
        $.sleepBedAsk = null; // (in bed: 'bed' goes with the sleep watch)
        return;
    }
    var ev = $gameMap.mapId() === a.map ? $gameMap.event(a.ev) : null;
    var interp = $gameMap._interpreter;
    var running = !!ev && (ev._starting || (interp.isRunning() && interp.eventId() === a.ev));
    if (running || $.clockMs() - a.at < $.SLEEP_BED_CHECK_MS) return;
    $.sleepBedAsk = null;
    if (!$.sleepMine || !$.conn) return;
    $.dlog('sleep group', $.sleepMine.id + ': the bed ended without sleeping ("Leave")');
    $.conn.send({ t: 'sleepAt', id: $.sleepMine.id, at: 'awake' });
});

// Sub-host: the same for a guest of its own
$.subBedAsk = {}; // sub-host: guest id -> { at }
var _requestConsentBed = $.requestConsent;
$.requestConsent = function(fromId, cb, opts) {
    if (!$.isHost() && $.subHosting() && opts && opts.sleep && fromId !== 'host') {
        var asked = cb;
        cb = function() {
            $.sleepUndoTake(fromId, $gameMap.mapId(), Number(opts.eventId) || 0);
            $.subBedAsk[fromId] = { at: $.clockMs() };
            asked();
        };
    }
    return _requestConsentBed(fromId, cb, opts);
};

$.worldExtras.push(function() {
    if (!$.subHosting()) return;
    Object.keys($.subBedAsk).forEach(function(id) {
        var a = $.subBedAsk[id], c = $.clientById(id);
        if (!c || !c._sub || $.ownSwitchesOf(c)[$.SLEEPING_SWITCH]) {
            delete $.subBedAsk[id];
            return;
        }
        if ($.owned[id] || $.clockMs() - a.at < $.SLEEP_BED_CHECK_MS) return;
        delete $.subBedAsk[id];
        var meta = $.subSleepMeta[id];
        if (meta && $.conn) $.conn.send({ t: 'sleepSubAt', who: id, id: meta.groupId, at: 'awake' });
    });
});

// L4: in bed (until the dreams), X is "get up", never the menu
var _isMenuEnabledBed = Scene_Map.prototype.isMenuEnabled;
Scene_Map.prototype.isMenuEnabled = function() {
    var s = $.sleepMine;
    if ($.isGuest() && s && !s.go1 && (s.st === 'lying' || s.st === 'ready')) return false;
    return _isMenuEnabledBed.call(this);
};

var _snapBed = $.guestHandlers.snap;
$.guestHandlers.snap = function(msg) {
    $.sleepBedAsk = null;
    $.subBedAsk = {};
    $.sleepUndo = {};
    return _snapBed(msg);
};

var _leaveAsGuestBed = $.leaveAsGuest;
$.leaveAsGuest = function(message) {
    $.sleepBedAsk = null;
    $.subBedAsk = {};
    $.sleepUndo = {};
    _leaveAsGuestBed(message);
};

var _resetRoamsBed = $.resetRoams;
$.resetRoams = function() {
    _resetRoamsBed();
    $.sleepUndo = {};
};


//=============================================================================
// Sleeping together: the pre-dream events first (docs/조사(보관용)/침대_꿈전장면.md)
//=============================================================================
// User decision 2026-10-26: "Whoever has a pre-dream event sees it first. If
// it is an ambush they fight it, and players on the same map can join that
// fight. The others wait standing (not lying). When it is over, everyone lies
// down together and goes to the dream."
// Data: each bed's dream page (autorun on SW463 + the character's SELECT)
// usually goes straight to the dream (201 to Map032). Before it some show
// something else, decided by switches only (no coin toss):
// - Marina's Samarie (SW242: Map005 EV114 p3, Map020 EV191 p2, Map054 EV33
//   p2; SW3681 / SW4907 off), Marcoh's Aligura (SW2403: Map020 EV191 p7,
//   Map054 EV33 p6; SW1514 / 4916 / 3401 off and V4 random_var rolled 1..2 in
//   that page = 1): a scene, then awake (SW463 off);
// - the night ambush: the bed's monster still alive (Map005 SW23 woodsman1,
//   Map011 SW302, Map020 SW361 Oscar1, Map054 SW1581 bobby6, Map087
//   SW1914-1920, Map121/122 SW4326): "You hear heavy breathing..." - SW463 off,
//   CE74, the fight. Won: the monster's switch is on, the next sleep dreams.
// When a sleep starts on a map (the bed vote passed, or a player alone used a
// bed), the PC running that map (the host for its own map, else the guest
// running it, for itself and its sub-host guests) reads, for each player who
// would lie down, the page its own SW463 would start (the first event with an
// autorun / parallel page on SW463 for that player's SELECT and own switches,
// like $.ownPageOf / the map's autorun) and follows that page's control flow
// (branches 111 / 411, labels 118 / 119, switch and variable writes) on a
// copy of the values until a transfer, a message or a battle: 201 to Map032
// first is the dream; a message or a battle first is a pre-dream event (a
// battle in that branch: an ambush). V4's roll is made then and the real run
// of that page uses the same number ($.preDreamRolls, command122).
// - Nobody has one: as before.
// - Some have: they lie down (their page runs their event). An ambush is one
//   fight: the bed's player has it if it gets it, else the host, else the
//   first one; the others with the same ambush wait standing and can join it
//   (the existing battle join). Everyone else on the map does not lie down;
//   they hear "Waiting for <name> before sleeping...". The bed's player
//   without an event of its own waits at its dream move (barrier 1) - the
//   group's barrier holds while anyone of it is awake.
// - When every pre-dream event is over (that player is free again with its
//   SW463 off, or down / dead / gone), the events are read again: who still
//   has one (the ambush lost or fled: the monster lives) stays awake - the
//   original wants the bed used again; everyone else on the map lies down
//   together (the ones who had the event too), then the barriers as before.
// - PRE_DREAM_MS (real time) after the start the others lie down without the
//   ones still in their event.
// $.SLEEP_RELIE stays the fallback for a scene not caught in advance.

$.PRE_DREAM_FIRST = true;      // false: the old way (everyone lies down at once)
$.PRE_DREAM_MS = 180000;       // (real time, $.clockMs) the cap: SLEEP_FALL_MS
$.PRE_DREAM_HINT_MS = 5000;    // the waiting ones' reminder
$.PRE_DREAM_UNSEEN_MS = 5000;  // one with an event never laid down (busy, "Leave"): not waited for after this free time
$.PRE_DREAM_STEPS = 500;       // commands followed in one page (labels can loop)
$.PRE_DREAM_ROLL_MS = 1800000; // a roll older than this is not used
$.PRE_DREAM_WAIT_TEXT = 'Waiting for %1 before sleeping...';
$.PRE_DREAM_FIGHT_TEXT = '%1 (fight - you can join it)';
$.PRE_DREAM_STAY_TEXT = 'You are still awake. Use a bed again to sleep.';
$.PRE_DREAM_AMBUSH_TEXT = '%1 is attacked in bed - it wakes you all, everyone fights. Use a bed again later.';

$.preHold = null;     // the PC running the bed's map: { id, mapId, gid, starter, at, until, lie, wait, info, seen, freeAt, stay, told, released, hintAt }
$.preHoldSeq = 0;
$.preDreamRolls = {}; // player id -> { list, index, value, at }
$.preDreamNow = null; // roaming guest: a 'sleepNow' kept while it waits

// this PC's own player
$.preDreamMe = function() {
    return $.isHost() ? 'host' : $.myId;
};

$.preDreamLabel = function(id) {
    if (id === $.preDreamMe() && !$.isHost()) {
        var a = $gameActors.actor($.myActorId);
        return a ? a.name() : ($.myName || 'Someone');
    }
    return $.playerLabel(id);
};

// fn runs with that player's SELECT and own switches (SW463 on) in the world
// (also inside another player's context), every touched switch restored.
$.preDreamView = function(id, fn) {
    var sw = $gameSwitches._data, me = id === $.preDreamMe();
    var c = me ? null : $.clientById(id);
    if (!me && (!c || !c.actorId)) return null;
    var want = {};
    var sel = c ? $.SELECT_OF_ACTOR[c.actorId] : 0;
    $.SELECT_SWITCHES.forEach(function(sid, i) {
        if (c) want[sid] = sid === sel;
        else want[sid] = $.ctx && $.ctxSave ? !!$.ctxSave.sel[i] : !!sw[sid];
    });
    var own = c && $.ctx !== c ? (c._fhOwnSw || {}) : null;
    var ownSave = !c && $.ownCtx ? $.ownCtx.save : null;
    $.OWN_SWITCHES.forEach(function(sid) {
        want[sid] = own ? !!own[sid] : ownSave ? !!ownSave[sid] : !!sw[sid];
    });
    want[$.SLEEPING_SWITCH] = true;
    var keep = {};
    Object.keys(want).forEach(function(sid) {
        keep[sid] = sw[sid];
        sw[sid] = want[sid];
    });
    try {
        return fn();
    } finally {
        Object.keys(keep).forEach(function(sid) { sw[sid] = keep[sid]; });
    }
};

// The page this player's SW463 would start here. (An event a player runs now
// counts: the bed's own event runs the bed's page for its player while this
// is read, and is free again when the others' pages start.)
$.preDreamPageOf = function(id) {
    var found = null;
    $gameMap.events().some(function(ev) {
        if (!ev || ev._erased) return false;
        var index = ev.findProperPageIndex();
        var page = index >= 0 ? ev.event().pages[index] : null;
        if (!page || (page.trigger !== 3 && page.trigger !== 4) || !page.list || page.list.length <= 1) return false;
        var k = page.conditions;
        if (!(k.switch1Valid && k.switch1Id === $.SLEEPING_SWITCH) && !(k.switch2Valid && k.switch2Id === $.SLEEPING_SWITCH)) return false;
        found = { ev: ev, index: index, page: page };
        return true;
    });
    return found;
};

// A conditional branch (111) on the walk's values: true / false, or null (a
// kind the dream pages never use - data: only switches and variables).
$.preDreamCond = function(p, evId, swOf, varOf) {
    if (p[0] === 0) return swOf(p[1]) === (p[2] === 0);
    if (p[0] === 1) {
        var a = varOf(p[1]), b = p[2] === 0 ? p[3] : varOf(p[3]);
        switch (p[4]) {
        case 0: return a === b;
        case 1: return a >= b;
        case 2: return a <= b;
        case 3: return a > b;
        case 4: return a < b;
        case 5: return a !== b;
        }
        return null;
    }
    if (p[0] === 2) {
        var key = [$gameMap.mapId(), evId, p[1]];
        return $gameSelfSwitches.value(key) === (p[2] === 0);
    }
    return null;
};

// Follows the page like the interpreter (its control flow only) until a
// transfer, a message or a battle. roll: the player's kept roll of a random
// variable write (Marcoh's V4); a new roll comes back in out.roll.
// { kind: 'dream' | 'scene' | 'ambush' | 'none', at, troop, roll }
$.preDreamWalk = function(list, evId, roll) {
    var sw = {}, v = {}, branch = {}, out = { kind: 'none', at: -1, troop: 0, roll: null };
    var swOf = function(id) { return id in sw ? sw[id] : !!$gameSwitches._data[id]; };
    var varOf = function(id) { return id in v ? v[id] : ($gameVariables._data[id] || 0); };
    var skip = function(i) {
        var ind = list[i].indent;
        while (list[i + 1] && list[i + 1].indent > ind) i++;
        return i;
    };
    var message = -1;
    for (var i = 0, steps = 0; i < list.length && steps < $.PRE_DREAM_STEPS; i++, steps++) {
        var c = list[i], p = c.parameters || [];
        if (c.code === 111) {
            var r = $.preDreamCond(p, evId, swOf, varOf);
            if (r === null) return out; // (not one of the dream pages' kinds: not read)
            branch[c.indent] = r;
            if (!r) i = skip(i);
        } else if (c.code === 411) {
            if (branch[c.indent] !== false) i = skip(i);
        } else if (c.code === 119) {
            for (var j = 0; j < list.length; j++) {
                if (list[j].code !== 118 || list[j].parameters[0] !== p[0]) continue;
                // (Game_Interpreter.jumpTo: the branches of the indents passed are forgotten)
                var ind = c.indent, from = Math.min(i, j), to = Math.max(i, j);
                for (var k = from; k <= to; k++) {
                    if (list[k].indent !== ind) {
                        branch[ind] = null;
                        ind = list[k].indent;
                    }
                }
                i = j;
                break;
            }
        } else if (c.code === 121) {
            for (var s = p[0]; s <= p[1]; s++) sw[s] = p[2] === 0;
        } else if (c.code === 122) {
            var value = 0;
            if (p[3] === 0) value = p[4];
            else if (p[3] === 1) value = varOf(p[4]);
            else if (p[3] === 2) {
                if (roll && roll.list === list && roll.index === i) {
                    value = roll.value;
                } else {
                    value = p[4] + Math.randomInt(p[5] - p[4] + 1);
                    roll = { list: list, index: i, value: value, at: $.clockMs() };
                }
                out.roll = roll;
            } else {
                continue; // (game data / script: not in the dream pages)
            }
            for (var x = p[0]; x <= p[1]; x++) {
                var old = varOf(x);
                switch (p[2]) {
                case 0: v[x] = value; break;
                case 1: v[x] = old + value; break;
                case 2: v[x] = old - value; break;
                case 3: v[x] = old * value; break;
                case 4: v[x] = value ? Math.floor(old / value) : old; break;
                case 5: v[x] = value ? old % value : old; break;
                }
            }
        } else if (c.code === 201) {
            if (message >= 0) {
                out.kind = 'scene'; // a scene, then a move
                return out;
            }
            out.at = i;
            out.kind = p[0] === 0 && p[1] === $.DREAM_MAP ? 'dream' : 'scene';
            return out;
        } else if (c.code === 301) {
            out.kind = 'ambush';
            out.at = message >= 0 ? message : i;
            out.troop = p[0] === 0 ? p[1] : 0;
            return out;
        } else if (c.code === 101 && message < 0) {
            message = i;
            out.at = i; // (on to see whether a battle follows)
        }
    }
    if (message >= 0) out.kind = 'scene';
    return out;
};

// What this player's sleep here starts with. { kind, ev, page, at, troop }
$.preDreamOf = function(id) {
    if (!$gameMap || !$dataMap) return { kind: 'none' };
    var kept = $.preDreamRolls[id];
    if (kept && $.clockMs() - kept.at > $.PRE_DREAM_ROLL_MS) kept = null;
    var res = $.preDreamView(id, function() {
        var found = $.preDreamPageOf(id);
        if (!found) return { kind: 'none' };
        var walk = $.preDreamWalk(found.page.list, found.ev.eventId(), kept);
        walk.ev = found.ev.eventId();
        walk.page = found.index;
        return walk;
    }) || { kind: 'none' };
    if (res.roll) $.preDreamRolls[id] = res.roll;
    return res;
};

$.preDreamHas = function(info) {
    return !!info && (info.kind === 'scene' || info.kind === 'ambush');
};

$.preDreamWhere = function(info) {
    return 'map ' + $gameMap.mapId() + ' ev' + info.ev + ' p' + info.page +
        (info.kind === 'ambush' ? ' troop ' + info.troop : '');
};

// The real run of that page rolls the number the reading rolled.
var _command122PreDream = Game_Interpreter.prototype.command122;
Game_Interpreter.prototype.command122 = function() {
    var p = this._params;
    if (!$.role || !p || p[3] !== 2) return _command122PreDream.call(this);
    var who = this._fhOwner || ($.ctx ? null : $.preDreamMe());
    var r = who && $.preDreamRolls[who];
    if (!r || r.list !== this._list || r.index !== this._index || $.clockMs() - r.at > $.PRE_DREAM_ROLL_MS) {
        return _command122PreDream.call(this);
    }
    delete $.preDreamRolls[who];
    $.dlog('pre-dream: the roll read before for', $.preDreamLabel(who), '- V' + p[0], '=', r.value);
    var keep = Math.randomInt;
    Math.randomInt = function() { return r.value - p[4]; };
    try {
        return _command122PreDream.call(this);
    } finally {
        Math.randomInt = keep;
    }
};

// The players of this sleep with an event (lie: they lie down now) and the
// ones who wait. The ambush is only ever the bed's player's (user 2026-10-26:
// only the one who used the bed is attacked). Before, when the bed's player
// had a scene (Marina's Samarie, read before the woodcutter) and another an
// ambush, the host or the first one was laid down and attacked (0.41 review
// 3 H5): now such a player only stays awake this time (awake: it uses a bed
// itself later and meets its own night then); the others go on as planned.
$.preDreamPlan = function(ids, starter) {
    var info = {}, lie = {}, wait = {}, any = false;
    ids.forEach(function(id) {
        info[id] = $.preDreamOf(id);
        var i = info[id];
        $.dlog('pre-dream event for', $.preDreamLabel(id) + ':', $.preDreamHas(i) ? i.kind + ' (' + $.preDreamWhere(i) + ')' :
            i.kind === 'dream' ? 'none - its dream' : 'none (' + i.kind + ')');
        if ($.preDreamHas(i)) any = true;
    });
    if (!any) return null;
    var fighter = starter && info[starter] && info[starter].kind === 'ambush' ? starter : null;
    var awake = {};
    ids.forEach(function(id) {
        var i = info[id];
        if (id === fighter || i.kind === 'scene') lie[id] = true;
        else if (i.kind === 'ambush') awake[id] = true;
        else wait[id] = true;
    });
    if (fighter) {
        $.dlog('pre-dream: the night ambush on map', $gameMap.mapId(), '(troop ' + info[fighter].troop + '):',
            $.preDreamLabel(fighter), 'fights it - the sleep is called off for everyone (they can join the fight)');
    }
    // A night ambush calls the whole sleep off (user 2026-10-26): the one
    // whose page runs it wakes and fights as in the original; nobody lies
    // down, waits or lies down again after it - everyone uses a bed again.
    return { info: info, lie: lie, wait: wait, awake: awake, ambush: fighter };
};

$.preDreamNewHold = function(plan, starter, mapId) {
    var now = $.clockMs();
    var h = { id: ++$.preHoldSeq, mapId: mapId, gid: 0, starter: starter, at: now, until: now + $.PRE_DREAM_MS,
        lie: plan.lie, wait: plan.wait, info: plan.info, seen: {}, freeAt: {}, stay: {}, told: {}, done: {},
        released: false, hintAt: 0, ambush: plan.ambush || null };
    $.preHold = h;
    if (h.ambush) {
        // the others are free at once: nobody waits for the fight
        var text = 'Co-op: ' + $.PRE_DREAM_AMBUSH_TEXT.replace('%1', $.preDreamLabel(h.ambush));
        Object.keys(h.wait).concat(Object.keys(h.lie), Object.keys(plan.awake || {})).forEach(function(id) {
            if (id !== h.ambush) $.preDreamDrop(h, id, 'a night ambush - the sleep is called off', text);
        });
    }
    if (!h.ambush) Object.keys(plan.awake || {}).forEach(function(id) {
        if (id !== h.ambush) $.preDreamDrop(h, id, 'its night ambush - it did not use the bed, it stays awake');
    });
    $.dlog('pre-dream hold', h.id, 'on map', mapId + ': first', Object.keys(h.lie).map($.preDreamLabel).join(', '),
        '| waiting standing:', Object.keys(h.wait).filter(function(id) { return id !== starter; })
            .map($.preDreamLabel).join(', ') || '-',
        h.wait[starter] ? '| ' + $.preDreamLabel(starter) + ' (the bed\'s) waits at its dream' : '');
    return h;
};

// the hold this PC keeps for its map, while the events go on
$.preDreamActive = function() {
    var h = $.preHold;
    return !!h && !h.released && !!$gameMap && h.mapId === $gameMap.mapId();
};

// true: this player does not lie down now
$.preDreamBlocks = function(id) {
    var h = $.preHold;
    if (!h || !$gameMap || h.mapId !== $gameMap.mapId()) return false;
    if (h.stay[id]) return true;
    if (h.released || (!h.lie[id] && !h.wait[id])) return false; // (one elsewhere is not this map's)
    // (one with an event lies down once; after it, with the others)
    return !h.lie[id] || !!h.seen[id];
};

// the event ones not over yet
$.preDreamPending = function(h) {
    return Object.keys(h.lie).filter(function(id) { return !h.done[id]; });
};

$.preDreamWaitText = function(h) {
    var names = $.preDreamPending(h).map(function(id) {
        var label = $.preDreamLabel(id);
        return h.info[id] && h.info[id].kind === 'ambush' ? $.PRE_DREAM_FIGHT_TEXT.replace('%1', label) : label;
    });
    return 'Co-op: ' + $.PRE_DREAM_WAIT_TEXT.replace('%1', names.join(', ') || 'the others');
};

// ---- this PC's players (the host: the host and its map's guests; a guest
// running its map: itself and its sub-host guests)

$.preDreamConn = function(id) {
    return id === $.preDreamMe() ? null : $.clientById(id);
};

$.preDreamGone = function(id) {
    if (id === $.preDreamMe()) return $.isHost() ? $.sleeperGoneWhy('host') : ($.isDownMe() ? 'down' : '');
    var c = $.clientById(id);
    if (!c || !c.actorId) return 'left';
    if ($.isHost()) return $.sleeperGoneWhy(id);
    return $.isDown(id) ? 'down' : '';
};

$.preDreamAsleep = function(id) {
    var c = $.preDreamConn(id);
    if (c) return $.ctx === c ? !!$gameSwitches._data[$.SLEEPING_SWITCH] : !!$.ownSwitchesOf(c)[$.SLEEPING_SWITCH];
    if ($.ownCtx) return !!$.ownCtx.save[$.SLEEPING_SWITCH];
    return !!$gameSwitches._data[$.SLEEPING_SWITCH];
};

$.preDreamFree = function(id) {
    var c = $.preDreamConn(id);
    if (c) return !$.isBusy(c) && !c._menuBase;
    return SceneManager._scene instanceof Scene_Map && !SceneManager.isSceneChanging() && !$gameParty.inBattle() &&
        !$gameMap.isEventRunning() && !$gameMessage.isBusy() && !$gamePlayer.isTransferring() && !$.localBattle;
};

$.preDreamTell = function(id, text) {
    if (id === $.preDreamMe()) $.toast(text);
    else $.sendTo(id, { t: 'toast', text: text });
};

// ---- the host's map

$.preDreamHostIds = function(starter, mapId) {
    var ids = [starter];
    if (starter !== 'host' && $.playerMapOfRest('host') === mapId && !$.isDead('host') && !$.isDown('host') &&
            !$.sleepInBed('host')) {
        ids.push('host');
    }
    $.clients.forEach(function(c) {
        if (c.guestId === starter || !c.actorId || !c.inGame || c.solo || c.subOf || !$.guestOnMap(c) ||
                $.isDead(c.guestId) || $.isDown(c.guestId) || $.sleepInBed(c.guestId) ||
                $.preDreamAsleep(c.guestId)) return;
        ids.push(c.guestId);
    });
    return ids;
};

// The vote passed and the bed's player lies down ($.sleepTogether): read the
// events before the others lie down (they do in the call after this).
$.preDreamHostStart = function(starter, mapId) {
    if ($.preDreamActive()) return null; // (one at a time on a map)
    $.preHold = null; // (a new sleep: the ones who stayed awake last time are read again)
    var plan = $.preDreamPlan($.preDreamHostIds(starter, mapId), starter);
    if (!plan) return null;
    var h = $.preDreamNewHold(plan, starter, mapId);
    if (h.lie[starter] && $.preDreamAsleep(starter)) h.seen[starter] = true;
    return h;
};

var _sleepTogetherPre = $.sleepTogether;
$.sleepTogether = function(starter) {
    var vote = $.sleepVote;
    var live = $.isHost() && $.PRE_DREAM_FIRST && !!vote && vote.from === starter && $.clockMs() - vote.at <= $.SLEEP_MS;
    var mapId = live ? (Number(vote.mapId) || $.playerMapOfRest(starter)) : 0;
    var h = live && mapId === $gameMap.mapId() && !($.sleepGroup && $.sleepGroup.go1 && !$.sleepGroup.go2) ?
        $.preDreamHostStart(starter, mapId) : null;
    _sleepTogetherPre(starter);
    if (!h) return;
    h.gid = $.sleepGroup ? $.sleepGroup.id : 0;
    if (h.ambush) $.preDreamUnqueue(h);
    $.preDreamHint(h, true);
};

// A night ambush: the ones of this map it let go are not queued to lie down
// later either ($.sleepTogether queues whoever it could not lay down now).
// Only this map's players are in a hold: one on another map (in its own bed,
// or walking) is never touched (user 2026-10-26).
$.preDreamUnqueue = function(h) {
    var g = $.sleepGroup;
    $.sleepersLate = $.sleepersLate.filter(function(s) { return !h.stay[s.id]; });
    Object.keys(h.stay).forEach(function(id) {
        var m = g && g.members[id];
        if (!m) return;
        m.autoMap = 0;
        m.manualAwake = true;
        m.bedPending = false;
        if (m.st === 'lying' || m.st === 'scene') $.sleepSet(id, g.split ? 'awake' : 'out', 'a night ambush - the sleep is called off');
    });
};

// Who waits: not laid down now (they are queued: $.sleepersLate, the host's
// autoMap) and not given up on while the events last.
var _canLieDownPre = $.canLieDown;
$.canLieDown = function(c) {
    if ($.isHost() && $.preDreamBlocks(c.guestId)) return false;
    return _canLieDownPre(c);
};

var _lateSleeperFreePre = $.lateSleeperFree;
$.lateSleeperFree = function(c) {
    if ($.isHost() && $.preDreamBlocks(c.guestId)) return false;
    return _lateSleeperFreePre(c);
};

var _layDownHostPre = $.layDownHost;
$.layDownHost = function() {
    var h = $.preHold;
    if ($.isHost() && !$.ctx && $.preDreamBlocks('host')) {
        if (h && !h.told.hostHeld) {
            h.told.hostHeld = true;
            $.dlog('pre-dream hold', h.id + ': the host does not lie down yet');
        }
        return false;
    }
    return _layDownHostPre();
};

// One who had its event wakes without its dream: it lies down again with the
// others (also an ambush won), whatever SLEEP_RELIE says.
var _sleepWokeEarlyPre = $.sleepWokeEarly;
$.sleepWokeEarly = function(id, scene) {
    var h = $.preHold;
    if (!$.isHost() || !h || h.released || !h.lie[id]) return _sleepWokeEarlyPre(id, scene);
    var keep = $.SLEEP_RELIE;
    $.SLEEP_RELIE = true;
    try {
        _sleepWokeEarlyPre(id, true);
    } finally {
        $.SLEEP_RELIE = keep;
    }
    $.dlog('pre-dream hold', h.id + ':', $.preDreamLabel(id), 'woke from its pre-dream event - lies down with the others later');
};

// barrier 1 while the events last: who it waits for
var _sleepHintPre = $.sleepHint;
$.sleepHint = function(interp, now) {
    var w = interp._fhSleep, h = $.preHold;
    if (!w || w.at !== 1 || !$.preDreamActive() || !$.preDreamPending(h).length) return _sleepHintPre(interp, now);
    var t = $.clockMs();
    if (!now && t - (w.hint || 0) < $.SLEEP_HINT_MS) return;
    w.hint = t;
    var text = $.preDreamWaitText(h);
    if (($.isHost() && w.who === 'host') || (!$.isHost() && !w.sub)) $.toast(text);
    else $.sendTo(w.who, { t: 'toast', text: text });
};

// the ones standing hear it now and then
$.preDreamHint = function(h, now) {
    var t = $.clockMs();
    if (!now && t - h.hintAt < $.PRE_DREAM_HINT_MS) return;
    h.hintAt = t;
    var text = $.preDreamWaitText(h);
    Object.keys(h.wait).forEach(function(id) {
        if (id === h.starter || h.stay[id] || $.preDreamGone(id)) return;
        $.preDreamTell(id, text);
    });
    Object.keys(h.lie).forEach(function(id) {
        if (h.done[id] && !h.stay[id] && !$.preDreamGone(id)) $.preDreamTell(id, text);
    });
};

// It sleeps no more this time: awake (it uses a bed again).
$.preDreamDrop = function(h, id, why, text) {
    h.stay[id] = true;
    // a roll its page never used is not the next night's (0.41 review 3 S3:
    // Marcoh's V4 stayed 30 minutes and the next sleep rolled nothing new)
    delete $.preDreamRolls[id];
    if ($.isHost()) {
        var g = $.sleepGroup, m = g && g.members[id];
        $.sleepersLate = $.sleepersLate.filter(function(s) { return s.id !== id; });
        if (m) {
            m.autoMap = 0;
            m.manualAwake = true;
            m.bedPending = false;
            if (m.st === 'awake' || m.st === 'scene' || m.st === 'lying') $.sleepSet(id, g.split ? 'awake' : 'out', why);
        }
    } else {
        $.preDreamRemoteSay(h, id, 'stay');
    }
    $.dlog('pre-dream hold', h.id + ':', $.preDreamLabel(id), 'stays awake -', why);
    if (!$.preDreamGone(id)) $.preDreamTell(id, text || 'Co-op: ' + $.PRE_DREAM_STAY_TEXT);
};

// Every frame on the PC that keeps a hold.
$.preDreamUpdate = function() {
    var h = $.preHold;
    if (!h || $.ctx || !$gameMap) return;
    var now = $.clockMs();
    if (h.released) {
        if (now > h.until + $.PRE_DREAM_MS || h.mapId !== $gameMap.mapId()) $.preHold = null;
        return;
    }
    if (h.mapId !== $gameMap.mapId()) {
        $.dlog('pre-dream hold', h.id + ': left map', h.mapId);
        $.preHold = null;
        $.preDreamNow = null;
        return;
    }
    if ($.isHost() && h.gid && (!$.sleepGroup || $.sleepGroup.id !== h.gid)) {
        $.dlog('pre-dream hold', h.id + ': the sleep group is over');
        $.preHold = null;
        return;
    }
    Object.keys(h.lie).forEach(function(id) {
        if (h.done[id]) return;
        var gone = $.preDreamGone(id);
        var asleep = !gone && $.preDreamAsleep(id);
        var free = !gone && !asleep && $.preDreamFree(id);
        if (asleep) h.seen[id] = true;
        if (!free) h.freeAt[id] = 0;
        else if (!h.freeAt[id]) h.freeAt[id] = now;
        var over = !!gone || (h.seen[id] ? free : free && now - h.freeAt[id] >= $.PRE_DREAM_UNSEEN_MS);
        if (!over) return;
        h.done[id] = true;
        $.dlog('pre-dream hold', h.id + ':', $.preDreamLabel(id), gone ? 'is ' + gone :
            h.seen[id] ? 'is free again - its pre-dream event is over' : 'never lay down for its event');
    });
    // the waiting ones stay in the queue as long as the events last
    if ($.isHost()) {
        var g = $.sleepGroup;
        $.sleepersLate.forEach(function(s) {
            if ($.preDreamBlocks(s.id)) s.until = Math.max(s.until, now + $.SLEEP_MS);
        });
        if (g) {
            Object.keys(g.members).forEach(function(id) {
                var m = g.members[id];
                if ((m.st === 'awake' || m.st === 'scene') && $.preDreamBlocks(id)) m.t = now;
            });
        }
    } else {
        $.preDreamRemoteKeep(h);
    }
    var late = now > h.until;
    if (!late && $.preDreamPending(h).length) {
        $.preDreamHint(h, false);
        return;
    }
    $.preDreamRelease(h, late);
};
$.worldExtras.push(function() { if ($.isHost()) $.preDreamUpdate(); });
$.guestExtras.push(function() { if ($.isGuest() && $.isRoaming()) $.preDreamUpdate(); });

// The events are over (or took too long): read them again, then the others lie down.
$.preDreamRelease = function(h, late) {
    if (late) {
        $.preDreamPending(h).forEach(function(id) {
            $.preDreamDrop(h, id, 'its pre-dream event took too long (' + Math.round($.PRE_DREAM_MS / 1000) + ' s)');
        });
    }
    var ids = Object.keys(h.lie).concat(Object.keys(h.wait));
    var lying = [];
    ids.forEach(function(id) {
        if (h.stay[id] || $.preDreamGone(id)) return;
        if (h.ambush) {
            // (won, lost or fled: the original wants the bed used again)
            $.preDreamDrop(h, id, 'its night ambush is over - the sleep was called off');
            return;
        }
        if ($.preDreamAsleep(id)) return; // in bed already (the bed's player at its dream move)
        var g = $.isHost() ? $.sleepGroup : null, m = g && g.members[id];
        if (m && m.st === 'out') return;
        var info = $.preDreamOf(id);
        if ($.preDreamHas(info)) {
            $.preDreamDrop(h, id, 'still has its pre-dream event (' + info.kind + ', ' + $.preDreamWhere(info) +
                ') - the original wants the bed used again');
            return;
        }
        lying.push(id);
        if (m && (m.st === 'awake' || m.st === 'scene')) m.t = $.clockMs();
    });
    h.released = true;
    // (the ones lying down keep theirs: their page's real run rolls that one)
    ids.forEach(function(id) { if (lying.indexOf(id) < 0) delete $.preDreamRolls[id]; });
    $.dlog('pre-dream hold', h.id + ':', late ? 'waited long enough' : 'every pre-dream event is over', '- lying down together:',
        lying.map($.preDreamLabel).join(', ') || 'nobody');
    if (!$.isHost()) $.preDreamRemoteRelease(h);
};

// Nobody in bed while the events last (the one with the event is down, the
// others stand): the group waits for them ($.preDreamRelease decides).
var _sleepReleasePre = $.sleepRelease;
$.sleepRelease = function() {
    var g = $.sleepGroup, h = $.preHold;
    if ($.isHost() && g && !g.go1 && h && !h.released && h.gid === g.id) {
        var st = function(id) { return g.members[id].st; };
        var ids = Object.keys(g.members);
        if (!ids.some(function(id) { return st(id) === 'lying' || st(id) === 'scene' || st(id) === 'ready'; }) &&
                ids.some(function(id) { return st(id) === 'awake' && $.preDreamBlocks(id); })) {
            return;
        }
    }
    _sleepReleasePre();
};

// The group ends while the events last (a load, too long): nobody lies
// down; the ones standing hear it.
var _endSleepGroupPre = $.endSleepGroup;
$.endSleepGroup = function(why) {
    var g = $.sleepGroup, h = $.preHold;
    _endSleepGroupPre(why);
    if (!g || !h || h.gid !== g.id || !$.isHost()) return;
    $.preHold = null;
    if (h.released) return;
    $.dlog('pre-dream hold', h.id + ': the sleep group is over - nobody lies down');
    Object.keys(h.wait).concat(Object.keys(h.lie)).forEach(function(id) { delete $.preDreamRolls[id]; });
    Object.keys(h.wait).concat(Object.keys(h.lie)).forEach(function(id) {
        if (!h.stay[id] && !$.preDreamGone(id)) $.preDreamTell(id, 'Co-op: ' + $.PRE_DREAM_STAY_TEXT);
    });
};

// ---- a guest running the bed's map (itself and its sub-host guests): the
// host queued everyone there at the vote ('sleepNow', 'sleepSub'); this PC
// holds the ones who wait and tells the host ('held', later 'bed'; 'stay').

$.preDreamGid = function(id) {
    if (id === $.myId) return $.sleepMine ? $.sleepMine.id : 0;
    var meta = $.subSleepMeta[id];
    return meta ? meta.groupId : 0;
};

$.preDreamRemoteIds = function(starter) {
    var map = $gameMap.mapId(), ids = [];
    if (starter) ids.push(starter);
    if ($.myId !== starter && !$.isDownMe() && !$.preDreamAsleep($.myId)) ids.push($.myId);
    $.clients.forEach(function(c) {
        if (c.guestId === starter || !c._sub || !c.actorId || !c.lastPos || c.lastPos.m !== map ||
                $.isDown(c.guestId) || $.preDreamAsleep(c.guestId)) return;
        ids.push(c.guestId);
    });
    return ids;
};

// the bed's player whose vote passed here (its bed's event runs on this PC)
$.preDreamBedStarter = function() {
    if ($.ctx && $.subBedAsk && $.subBedAsk[$.ctx.guestId]) return $.ctx.guestId;
    if (!$.ctx && $.sleepBedAsk) return $.myId;
    return null;
};

$.preDreamRemoteStart = function(starter, why) {
    if (!$.PRE_DREAM_FIRST || !$.isGuest() || !$.isRoaming() || $.preDreamActive()) return null;
    var gid = $.preDreamGid(starter || $.myId) || ($.sleepMine && $.sleepMine.id) || 0;
    var old = $.preHold;
    // (that sleep's events were read - unless a night ambush called that try off: $.preDreamStale)
    if (!starter && old && old.gid === gid && gid && !(old.released && old.ambush)) return null;
    var plan = $.preDreamPlan($.preDreamRemoteIds(starter), starter);
    if (!plan) {
        $.preHold = { id: ++$.preHoldSeq, mapId: $gameMap.mapId(), gid: gid, released: true, until: $.clockMs(),
            lie: {}, wait: {}, info: {}, seen: {}, freeAt: {}, stay: {}, told: {}, done: {} };
        return null;
    }
    $.dlog('pre-dream: read on this PC (' + why + ')');
    var h = $.preDreamNewHold(plan, starter || $.myId, $gameMap.mapId());
    h.gid = gid;
    if (starter && h.lie[starter] && $.preDreamAsleep(starter)) h.seen[starter] = true;
    $.preDreamHint(h, true);
    return h;
};

// to the host: 'held' (waits standing), 'stay' (sleeps no more this time)
// A hold to read again before a lie-down: none, or one over for another sleep -
// or one a night ambush called off (its "stays awake" marks were for that try:
// the same sleep group goes on, and a sub-host's guest marked then was sent back
// awake at every bed after it - 4p flows S-3 sub-host variant, 2026-11-10).
$.preDreamStale = function(gid) {
    var h = $.preHold;
    return !h || (h.released && (h.gid !== gid || !!h.ambush));
};

$.preDreamRemoteSay = function(h, id, at) {
    var gid = $.preDreamGid(id) || h.gid;
    if (!$.conn || !gid) return false;
    if (id === $.myId) $.conn.send({ t: 'sleepAt', id: gid, at: at });
    else $.conn.send({ t: 'sleepSubAt', who: id, id: gid, at: at });
    return true;
};

$.preDreamRemoteKeep = function(h) {
    Object.keys(h.wait).concat(Object.keys(h.lie)).forEach(function(id) {
        // (the ones with an event: their wake tells the host - 'awake', a scene)
        if (h.told[id] || h.lie[id] || id === h.starter || !$.preDreamBlocks(id)) return;
        if ($.preDreamRemoteSay(h, id, 'held')) h.told[id] = true;
    });
    if ($.preDreamNow) $.preDreamNow.until = $.clockMs() + $.SLEEP_MS;
};

$.preDreamRemoteRelease = function(h) {
    var keep = $.preDreamNow;
    $.preDreamNow = null;
    if (keep && !h.stay[$.myId]) _sleepNowPre(keep.msg);
};

// a lie-down the host sent (this player, from the vote or after its event)
var _sleepNowPre = $.guestHandlers.sleepNow;
$.guestHandlers.sleepNow = function(msg) {
    if ($.PRE_DREAM_FIRST && $.isRoaming() && !$.pendingRoam) {
        if ($.preDreamStale($.preDreamGid($.myId))) {
            $.preDreamRemoteStart($.preDreamBedStarter() || ($.sleepBedAsk ? $.myId : null), 'a lie-down from the host');
        }
        if ($.preDreamBlocks($.myId)) {
            $.preDreamNow = { msg: msg, until: $.clockMs() + $.SLEEP_MS };
            var h = $.preHold;
            if (h && h.stay[$.myId]) {
                $.preDreamNow = null;
                $.preDreamRemoteSay(h, $.myId, 'stay');
            }
            return;
        }
    }
    _sleepNowPre(msg);
};

// a sub-host guest the host lies down here
var _startSubSleepPre = $.startSubSleep;
$.startSubSleep = function(c, meta) {
    if (!$.PRE_DREAM_FIRST || !c || !c._sub || !$.subHosting()) return _startSubSleepPre(c, meta);
    if ($.preDreamStale(meta && meta.groupId)) {
        $.preDreamRemoteStart($.preDreamBedStarter() || ($.subBedAsk && $.subBedAsk[c.guestId] ? c.guestId : null),
            'a lie-down from the host');
    }
    if ($.preDreamBlocks(c.guestId)) {
        var h = $.preHold;
        if (h && h.stay[c.guestId]) {
            delete $.subSleepPending[c.guestId];
            $.preDreamRemoteSay(h, c.guestId, 'stay');
        }
        return false; // (kept in $.subSleepPending: tried again every frame)
    }
    return _startSubSleepPre(c, meta);
};

// the bed of a player here turns its SW463 on: read the events first
var _swSetPreDream = Game_Switches.prototype.setValue;
Game_Switches.prototype.setValue = function(id, value) {
    var starter = id === $.SLEEPING_SWITCH && value && this === $gameSwitches && $.PRE_DREAM_FIRST &&
        $.role && $.isGuest() && $.isRoaming() && !this._data[id] ? $.preDreamBedStarter() : null;
    _swSetPreDream.call(this, id, value);
    if (starter && !$.preDreamActive()) $.preDreamRemoteStart(starter, 'the bed of ' + $.preDreamLabel(starter));
};

// a wake from the event: the host lays it down again (with the others)
var _sceneFlippedPre = $.sceneFlipped;
$.sceneFlipped = function(sc, actorId) {
    if (_sceneFlippedPre(sc, actorId)) return true;
    var h = $.preHold;
    if (!h || $.isHost() || h.released) return false;
    return Object.keys(h.lie).some(function(id) {
        var a = id === $.myId ? $.myActorId : ($.clientById(id) || {}).actorId;
        return a === actorId && !h.stay[id];
    });
};

// Host: what that PC says of its players.
var _handleSleepAtPre = $.handleSleepAt;
$.handleSleepAt = function(id, msg, reply) {
    var g = $.sleepGroup, m = g && msg && g.id === msg.id ? g.members[id] : null;
    if (m && msg.at === 'held') {
        m.bedPending = false;
        m.manualAwake = false;
        m.preHeld = true;
        $.sleepSet(id, 'awake', 'waits standing for a pre-dream event on its map');
    } else if (m && msg.at === 'stay') {
        m.bedPending = false;
        m.manualAwake = true;
        m.preHeld = false;
        $.sleepersLate = $.sleepersLate.filter(function(s) { return s.id !== id; });
        $.sleepSet(id, g.split ? 'awake' : 'out', 'still has its pre-dream event - use the bed again');
    } else if (m && msg.at === 'bed' && m.preHeld) {
        m.preHeld = false;
        if (m.st === 'awake') {
            m.sc = $.sceneSwitchesNow();
            m.seen = false;
            $.sleepSet(id, 'lying', 'lies down after the pre-dream events');
        }
    }
    return _handleSleepAtPre(id, msg, reply);
};

var _sleepOutPre = $.guestHandlers.sleepOut;
$.guestHandlers.sleepOut = function(msg) {
    var h = $.preHold;
    if (h && msg && h.gid === msg.id) {
        $.preHold = null;
        $.preDreamNow = null;
    }
    return _sleepOutPre(msg);
};

var _resetRoamsPre = $.resetRoams;
$.resetRoams = function() {
    _resetRoamsPre();
    $.preHold = null;
    $.preDreamRolls = {};
    $.preDreamNow = null;
};

var _leaveAsGuestPre = $.leaveAsGuest;
$.leaveAsGuest = function(message) {
    $.preHold = null;
    $.preDreamRolls = {};
    $.preDreamNow = null;
    _leaveAsGuestPre(message);
};

var _snapPre = $.guestHandlers.snap;
$.guestHandlers.snap = function(msg) {
    $.preHold = null;
    $.preDreamNow = null;
    return _snapPre(msg);
};


//=============================================================================
// Sleeping together: night ambushes, character scenes, lying pictures
//=============================================================================
// User decisions 2026-11-04 (docs/진행상황.md):
// (1) A night ambush when several sleep: every player of that sleep on the
//     bed's map is put into the fight (the boss rooms' pull, FH_CoopBattle
//     $.bossPull), not only the bed's player. The sleep is still called off
//     for everyone (they use a bed again).
// (2) A character's own scene before the dream (Marina's Samarie, Marcoh's
//     Aligura: stalking, threats) plays only to one who sleeps alone on that
//     map ("one against a party would be mad"). With others in this sleep
//     there, or asleep there already, its dream page reads its "seen" switch
//     (4907 / 4916, the only check in front of each scene) as on for that run:
//     straight to its dream (or the ambush), the scene still unseen for a
//     night alone.
// (3) Lying pictures: the original shows the sleeper as the bed event's own
//     picture (Map005 EV114 p2-p9: SW463 + the character's SELECT, sleeping1)
//     with the player invisible. SW463 is each player's own in co-op, so the
//     world's switches drew the host in every bed of the map and nobody else.
//     Now the bed shows the player whose bed page lit it (that page's picture
//     for its character), and no one when nobody uses it; the others laid down
//     with it lie curled up on the floor where they stood (sleeping1, the
//     beds' picture for their character) instead of turning invisible.

// ---- (2) character scenes only alone

$.PRE_DREAM_SCENES_ALONE = true; // false: a character's scene plays with others there too (the old way)
$.preDreamSkip = {}; // player id -> { at }: its scene does not play this sleep

$.preDreamActorOf = function(id) {
    if (id === $.preDreamMe()) return $.isHost() ? $.realHostActorId() : $.myActorId;
    var c = $.clientById(id);
    return c ? c.actorId : 0;
};

$.preDreamSkipSwitchOf = function(id) {
    var s = id && $.preDreamSkip[id];
    if (!s || $.clockMs() - s.at > $.PRE_DREAM_ROLL_MS) return 0;
    return $.PRE_DREAM_SWITCH_OF_ACTOR[$.preDreamActorOf(id)] || 0;
};

// another player of this map (not in ids) lies in bed here already
$.preDreamOthersAsleepHere = function(ids) {
    var map = $gameMap.mapId(), here = [$.preDreamMe()];
    $.clients.forEach(function(c) {
        if (!c.actorId) return;
        var on = $.isHost() ? !c.subOf && !c.roam && $.guestOnMap(c) : !!c._sub && !!c.lastPos && c.lastPos.m === map;
        if (on) here.push(c.guestId);
    });
    return here.some(function(id) { return ids.indexOf(id) < 0 && !$.preDreamGone(id) && $.preDreamAsleep(id); });
};

var _preDreamPlanAlone = $.preDreamPlan;
$.preDreamPlan = function(ids, starter) {
    ids.forEach(function(id) { delete $.preDreamSkip[id]; });
    if ($.PRE_DREAM_SCENES_ALONE && (ids.length > 1 || $.preDreamOthersAsleepHere(ids))) {
        var skipped = ids.filter(function(id) { return !!$.PRE_DREAM_SWITCH_OF_ACTOR[$.preDreamActorOf(id)]; });
        skipped.forEach(function(id) { $.preDreamSkip[id] = { at: $.clockMs() }; });
        if (skipped.length) {
            $.dlog('pre-dream: not sleeping alone - no character scene for', skipped.map($.preDreamLabel).join(', '));
        }
    }
    return _preDreamPlanAlone(ids, starter);
};

// the reading sees its "seen" switch on
var _preDreamViewAlone = $.preDreamView;
$.preDreamView = function(id, fn) {
    var sw = $.preDreamSkipSwitchOf(id);
    if (!sw) return _preDreamViewAlone(id, fn);
    return _preDreamViewAlone(id, function() {
        var data = $gameSwitches._data, keep = data[sw];
        data[sw] = true;
        try {
            return fn();
        } finally {
            data[sw] = keep;
        }
    });
};

// ... and so does the real run of its dream page
var _command111Alone = Game_Interpreter.prototype.command111;
Game_Interpreter.prototype.command111 = function() {
    var p = this._params;
    var sw = $.role && p && p[0] === 0 ? $.preDreamSkipSwitchOf(this._fhOwner || ($.ctx ? null : $.preDreamMe())) : 0;
    if (!sw || p[1] !== sw || !$gameSwitches._data[$.SLEEPING_SWITCH]) return _command111Alone.call(this);
    var data = $gameSwitches._data, keep = data[sw];
    data[sw] = true;
    try {
        return _command111Alone.call(this);
    } finally {
        data[sw] = keep;
    }
};

// at its dream move: that sleep is over for it
var _sleepBarrierAlone = $.sleepBarrier;
$.sleepBarrier = function(interp) {
    if ($.sleepStep(interp) === 1) {
        var who = $.sleeperOf(interp);
        if (who) delete $.preDreamSkip[who];
    }
    return _sleepBarrierAlone(interp);
};

// ---- (1) a night ambush: everyone of that sleep fights

$.AMBUSH_PULL_TEXT = 'Co-op: the attack wakes you - you are in the fight!';
$.AMBUSH_PULL_MS = 250;
$.bedAmbush = null; // host: { owner, mapId, ev, troop, ids, until, bid }
$.bedAmbushAt = 0;

$.setBedAmbush = function(owner, mapId, ev, troop, ids) {
    ids = (ids || []).filter(function(id) { return id && id !== owner; });
    if (!ids.length) return;
    $.bedAmbush = { owner: owner, mapId: mapId, ev: Number(ev) || 0, troop: Number(troop) || 0, ids: ids,
        until: $.clockMs() + $.PRE_DREAM_MS, bid: null };
    $.dlog('night ambush on map', mapId, 'troop', troop + ':', ids.map($.playerLabel).join(', '),
        'go into the fight of', $.playerLabel(owner));
};

var _preDreamNewHoldAmbush = $.preDreamNewHold;
$.preDreamNewHold = function(plan, starter, mapId) {
    var h = _preDreamNewHoldAmbush(plan, starter, mapId);
    if (!h.ambush) return h;
    var info = plan.info[h.ambush] || {};
    var ids = Object.keys(plan.lie).concat(Object.keys(plan.wait), Object.keys(plan.awake || {}));
    if ($.isHost()) {
        $.setBedAmbush(h.ambush, mapId, info.ev, info.troop, ids);
    } else if ($.conn) {
        $.conn.send({ t: 'bedAmbush', owner: h.ambush, m: mapId, ev: info.ev, troop: info.troop,
            ids: ids.filter(function(id) { return id !== h.ambush; }) });
    }
    return h;
};

// a guest running the bed's map: its ambush (it, or a guest of its own, fights)
$.hostHandlers.bedAmbush = function(conn, msg) {
    if (!msg || !conn.roam || !conn.lastPos || conn.lastPos.m !== Number(msg.m)) return;
    var mine = function(id) {
        var c = $.clientById(id);
        return id === conn.guestId || (!!c && c.subOf === conn.guestId);
    };
    if (!mine(msg.owner)) return;
    $.setBedAmbush(msg.owner, Number(msg.m), msg.ev, msg.troop, (msg.ids || []).filter(mine));
};

$.isBedAmbushFight = function(b, a) {
    return !!b && !!a && !b.pvp && b.owner === a.owner && b.mapId === a.mapId &&
        (!a.troop || b.troopId === a.troop) && (!a.ev || b.eventId === a.ev);
};

var _bossPullTickAmbush = $.bossPullTick;
$.bossPullTick = function() {
    _bossPullTickAmbush();
    var a = $.bedAmbush, now = $.clockMs();
    if (!a || !$.isHost() || now - $.bedAmbushAt < $.AMBUSH_PULL_MS) return;
    $.bedAmbushAt = now;
    if (a.bid && !$.battles[a.bid]) {
        $.bedAmbush = null; // that fight is over
        return;
    }
    if (!a.bid && now > a.until) {
        $.dlog('night ambush on map', a.mapId + ': no fight of', $.playerLabel(a.owner), 'came');
        $.bedAmbush = null;
        return;
    }
    Object.keys($.battles).forEach(function(k) {
        var b = $.battles[k];
        if (!$.isBedAmbushFight(b, a)) return;
        a.bid = b.bid;
        $.bossPull(b, a.ids, $.AMBUSH_PULL_TEXT);
    });
};

// ---- (3) lying pictures

$.SLEEP_FLOOR_IMAGE = 'sleeping1';
// SELECT switch -> [index, direction] (the beds' pages, pattern 1)
$.SLEEP_FLOOR_OF_SELECT = { 246: [0, 2], 242: [0, 4], 244: [0, 6], 243: [0, 8],
    2403: [1, 2], 2402: [1, 4], 2404: [1, 6], 2401: [1, 8] };
$.BED_CHECK_EVERY = 15;

$.floorSleepLook = function(actorId) {
    var f = $.SLEEP_FLOOR_OF_SELECT[$.SELECT_OF_ACTOR[actorId]];
    return f ? { name: $.SLEEP_FLOOR_IMAGE, index: f[0], direction: f[1], pattern: 1 } : null;
};

// this PC's own player lies on the floor: { m, shown, fix }
$.floorSleep = null;

$.floorSleepLying = function() {
    var f = $.floorSleep;
    if (!f || !$gameMap || f.m !== $gameMap.mapId() || $.DREAM_MAPS[$gameMap.mapId()]) return false;
    if ($.isHost() || $.isRoaming()) return !!$gameSwitches._data[$.SLEEPING_SWITCH];
    return true; // a guest on the host's map: the host says when it gets up ('floorSleep')
};

// hide: back to invisible (still asleep: its dream move, a map change)
$.endFloorSleep = function(p, hide) {
    var f = $.floorSleep;
    $.floorSleep = null;
    if (!f || !f.shown || !p) return;
    p.setDirectionFix(!!f.fix);
    p.refresh();
    if (hide) p.setTransparent(true);
};

$.updateFloorSleep = function(p) {
    var f = $.floorSleep;
    if (!f) return;
    if (!$.floorSleepLying()) {
        var mapGone = !$gameMap || f.m !== $gameMap.mapId() || !!$.DREAM_MAPS[$gameMap.mapId()];
        $.endFloorSleep(p, mapGone || (($.isHost() || $.isRoaming()) && !!$gameSwitches._data[$.SLEEPING_SWITCH]));
        return;
    }
    var look = $.floorSleepLook($.preDreamActorOf($.preDreamMe()));
    if (!look) return;
    if (!f.shown) {
        f.shown = true;
        f.fix = p.isDirectionFixed();
    }
    if (p.characterName() !== look.name || p.characterIndex() !== look.index) p.setImage(look.name, look.index);
    p.setDirectionFix(false);
    p.setDirection(look.direction);
    p.setDirectionFix(true);
    p.setPattern(look.pattern);
    p.setTransparent(false);
};

var _gamePlayerUpdateFloor = Game_Player.prototype.update;
Game_Player.prototype.update = function(sceneActive) {
    _gamePlayerUpdateFloor.call(this, sceneActive);
    if ($.role && $.floorSleep && !$.ctx && !this._fhRemoteId && this === ($.realPlayer || $gamePlayer)) {
        $.updateFloorSleep(this);
    }
};

var _gamePlayerCanMoveFloor = Game_Player.prototype.canMove;
Game_Player.prototype.canMove = function() {
    if ($.role && $.floorSleep && $.floorSleep.shown) return false; // (asleep)
    return _gamePlayerCanMoveFloor.call(this);
};

// into the dream (or any move away): invisible as the bed left it
var _performTransferFloor = Game_Player.prototype.performTransfer;
Game_Player.prototype.performTransfer = function() {
    if ($.role && $.floorSleep && this.isTransferring() && !this._fhRemoteId) $.endFloorSleep(this, true);
    _performTransferFloor.call(this);
};

var _layDownHostFloor = $.layDownHost;
$.layDownHost = function() {
    var ok = _layDownHostFloor();
    if (ok) $.floorSleep = { m: $gameMap.mapId() };
    return ok;
};

$.tellFloorSleep = function(c, on) {
    c._fhFloor = on;
    // (one left behind lies on the map the host left)
    var m = c.roamPending ? (c.roamPending.m || (c.lastPos && c.lastPos.m)) : $gameMap.mapId();
    c.send({ t: 'floorSleep', on: on, m: m });
};

var _layDownGuestFloor = $.layDownGuest;
$.layDownGuest = function(c) {
    _layDownGuestFloor(c);
    $.tellFloorSleep(c, true);
};

var _startSubSleepFloor = $.startSubSleep;
$.startSubSleep = function(c, meta) {
    var ok = _startSubSleepFloor(c, meta);
    if (ok) $.tellFloorSleep(c, true);
    return ok;
};

$.guestHandlers.floorSleep = function(msg) {
    if (!msg) return;
    if (msg.on) {
        $.floorSleep = { m: Number(msg.m) || 0 };
        return;
    }
    $.endFloorSleep($gamePlayer, false);
};

// The bed's player: its bed shows it (on the PC running that map).
$.bedSleepers = {}; // 'mapId:eventId' -> player id

$.bedSleeperAsleep = function(id) {
    if (id === $.preDreamMe()) return !!(($.ownCtx ? $.ownCtx.save : $gameSwitches._data)[$.SLEEPING_SWITCH]);
    var c = $.clientById(id);
    if (!c) return false;
    return $.ctx === c ? !!$gameSwitches._data[$.SLEEPING_SWITCH] : !!$.ownSwitchesOf(c)[$.SLEEPING_SWITCH];
};

var _command121Bed = Game_Interpreter.prototype.command121;
Game_Interpreter.prototype.command121 = function() {
    // (data: only the 54 beds' own pages turn SW463 on; this player's own SW463)
    var p = this._params;
    var lights = $.role && !!$gameMap && !!this._eventId && p[2] === 0 && p[0] <= $.SLEEPING_SWITCH &&
        p[1] >= $.SLEEPING_SWITCH && !$gameSwitches._data[$.SLEEPING_SWITCH] && $.runsWorld() &&
        !!$gameMap.event(this._eventId);
    var result = _command121Bed.call(this);
    if (lights) {
        var who = this._fhOwner || ($.ctx ? $.ctx.guestId : $.preDreamMe());
        $.bedSleepers[$gameMap.mapId() + ':' + this._eventId] = who;
        $.dlog('bed ev' + this._eventId, 'on map', $gameMap.mapId() + ':', $.preDreamLabel(who), 'lies in it');
        $gameMap.requestRefresh();
    }
    return result;
};

// the bed's picture of that player (that bed's page for its character)
$.bedLookOf = function(ev, id) {
    var sel = $.SELECT_OF_ACTOR[$.preDreamActorOf(id)];
    var found = null;
    ev.event().pages.some(function(page) {
        var c = page.conditions, im = page.image;
        if (page.trigger !== 3 || !im || !im.characterName) return false;
        var lit = (c.switch1Valid && c.switch1Id === $.SLEEPING_SWITCH) || (c.switch2Valid && c.switch2Id === $.SLEEPING_SWITCH);
        if (!lit || !((c.switch1Valid && c.switch1Id === sel) || (c.switch2Valid && c.switch2Id === sel))) return false;
        found = { name: im.characterName, index: im.characterIndex, direction: im.direction, pattern: im.pattern };
        return true;
    });
    return found || $.floorSleepLook($.preDreamActorOf(id));
};

$.isBedSleepPage = function(page) {
    if (!page || page.trigger !== 3 || !page.image || !page.image.characterName) return false;
    var c = page.conditions;
    return (c.switch1Valid && c.switch1Id === $.SLEEPING_SWITCH) || (c.switch2Valid && c.switch2Id === $.SLEEPING_SWITCH);
};

var _gameEventRefreshBed = Game_Event.prototype.refresh;
Game_Event.prototype.refresh = function() {
    _gameEventRefreshBed.call(this);
    if (!$.role || !$.sessionActive() || !$.runsWorld() || this._erased) return;
    var who = $.bedSleepers[this._mapId + ':' + this._eventId];
    var look = who ? $.bedLookOf(this, who) : null;
    if (!look) {
        if ($.isBedSleepPage(this.page())) {
            look = { name: '', index: 0, direction: this._direction, pattern: this._pattern }; // nobody's bed
        } else {
            if (this._fhBedLook && this.page()) this.setupPageSettings(); // its own picture back
            this._fhBedLook = false;
            return;
        }
    }
    this._fhBedLook = !!who;
    this.setImage(look.name, look.index);
    this._direction = this._originalDirection = look.direction;
    this._pattern = this._originalPattern = look.pattern;
};

// Every few frames on the PC running the world: who got up, whose bed is gone;
// the guests laid on the floor here hear when they are up again.
$.worldExtras.push(function() {
    if (!$.runsWorld() || !$gameMap || Graphics.frameCount % $.BED_CHECK_EVERY !== 0) return;
    var map = $gameMap.mapId(), changed = false;
    Object.keys($.bedSleepers).forEach(function(key) {
        var who = $.bedSleepers[key];
        if (Number(key.split(':')[0]) === map && $.bedSleeperAsleep(who)) return;
        delete $.bedSleepers[key];
        changed = true;
    });
    if (changed) $gameMap.requestRefresh();
    $.clients.forEach(function(c) {
        if (!c._fhFloor) return;
        if (c.roam || c.roamPending) {
            c._fhFloor = false; // (its own PC has it now: its map, its SW463)
            return;
        }
        if (!$.ownSwitchesOf(c)[$.SLEEPING_SWITCH]) $.tellFloorSleep(c, false);
    });
});

var _resetRoamsLying = $.resetRoams;
$.resetRoams = function() {
    _resetRoamsLying();
    $.preDreamSkip = {};
    $.bedAmbush = null;
    $.bedSleepers = {};
    $.clients.forEach(function(c) { c._fhFloor = false; });
};

var _leaveAsGuestLying = $.leaveAsGuest;
$.leaveAsGuest = function(message) {
    $.preDreamSkip = {};
    $.bedSleepers = {};
    if ($.floorSleep) $.endFloorSleep($gamePlayer, false);
    _leaveAsGuestLying(message);
};

var _snapLying = $.guestHandlers.snap;
$.guestHandlers.snap = function(msg) {
    $.preDreamSkip = {};
    $.bedSleepers = {};
    $.floorSleep = null; // (the host's world: its own look comes with it)
    return _snapLying(msg);
};


//=============================================================================
// Eye of Rher: each player's own timer, moonscorched for good (README 2-1)
//=============================================================================
// Original (data):
// - Hard mode only: V2197 EYE_OF_RHER_ACTIVE is set to 1 only with SW4819
//   HARD_MODE on (Map004 EV205-211, Map130 EV117-123 on the way into town).
// - Each map that counts has a parallel "regain_sanity" event. Outside (41
//   maps, e.g. Map004 EV28: wait 400, CE372) it calls CE372 SANITY_OUTSIDE:
//   V2197 = 1 and SW202 off -> SW247 EYE_OF_RHER on. Inside / safe places
//   (100 maps, e.g. Map011 EV75: CE540 at once, then every 400 frames
//   CE373-376) reset it. Five dream-like maps do both every 400 frames.
// - SW247 runs the parallel CE535 EYE_OF_RHER: while SW202 is off, a step,
//   then a wait. Stage (V2198) 0, 1, 2: one of the eye animations 671 / 670 /
//   669 on the player ("The Moon God has noticed you..." the first time,
//   V2424); 3: 668, 4: 667, 5: 666, each with the heartbeat CE456; stage 6:
//   666 + heartbeat + SW1292 MOONSCORCHED. The wait after a step by the new
//   stage: >= 4: 300, 3: 600, 2: 700, else 999 frames. Battles, menus and
//   scenes (SW202) stop it.
// - CE540 / 547 / 373-376 (hard mode, stage >= 1): the screen zoom and the
//   heartbeat filters back, stage 0, SW247 off. CE547 rher_reset is in the
//   "won" branch of 877 enemy events (not all of them: the kills that reset
//   are the ones whose event calls it) and in their field gun checks.
// - CE536 MOONSCORCHED (SW1292): a white screen, then map 141 (map 132 for
//   Daan, SW243): a game over.
// In co-op (user decisions 2026-10-18/19): every PC runs this for its own
// player only (the host, a guest on the host's map, a guest running its own
// map, a sub-host and its guests), from the map it is on. CE535 never runs in
// a co-op game, so nothing turns SW1292 on and the host's world never goes to
// the moonscorched scene. Stage 6: that player dies for good ('moonscorch',
// FH_CoopBattle "Deaths for good") after a short local flash, a ghost; the
// host keeps the world running. Its PC alone then plays that character's own
// moonscorched scene (map 141 / Daan's 132) over its screen ("The
// moonscorched scene, on the dying player's screen only" below). Where it
// died its moonscorched form stands as an event of that map for everyone (saved in the host's save, coop data
// 'rher'), chasing like the original field monsters; touching it is a fight
// with that form's troop that others can join. Killed: its body stays (the
// form's own dead sprite) and the dead player's bag and equipment go to the
// player who first started a fight with it. Daan is the exception (Pocketcat,
// the moon god's clever servant, 추가요청v5.txt): no fight, a Pocketcat that
// wanders where he fell; talked to, it hands over Daan's keys and is gone
// ("Daan's Pocketcat" below, user request 2026-11-02).

$.RHER_ACTIVE_VAR = 2197;  // EYE_OF_RHER_ACTIVE
$.RHER_STAGE_VAR = 2198;   // EYE_OF_RHER (each PC's own in co-op)
$.RHER_SWITCH = 247;       // EYE_OF_RHER
$.RHER_HARD_SWITCH = 4819; // HARD_MODE
$.RHER_HOLD_SWITCH = 202;  // suicide_inprocess: a scene runs (no step)
$.RHER_TIMER_CE = 535;
$.RHER_KILL_CE = 547;
$.RHER_SANITY_CES = { 372: 'outside', 373: 'reset', 374: 'reset', 375: 'reset', 376: 'reset', 540: 'reset' };
$.RHER_EYE_ANIMS = [671, 670, 669]; // stages 0-2 (V2199 = 1 / 2 / 3)
$.RHER_STEP_ANIM = { 3: 668, 4: 667, 5: 666 };
$.RHER_LAST_ANIM = 666;
$.RHER_HEART_FROM = 3;
$.RHER_LAST_STAGE = 6;
$.RHER_GAB = 'The Moon God has noticed you...';
$.rherWait = function(stage) {
    return stage >= 4 ? 300 : stage >= 3 ? 600 : stage >= 2 ? 700 : 999;
};
// CE536 on this PC only: its sounds, shake, the white and (not Daan's) the
// moonscorch animation on the player.
$.RHER_SCENE_SES = [
    { name: 'wind2_MMO_Game_Magic_Source_Wind_Howl_08_Cold_Winter_Analog_01', volume: 90, pitch: 60, pan: 0 },
    { name: 'tinnitus_end', volume: 50, pitch: 110, pan: 0 }
];
$.RHER_SCENE_ANIM = 673;
$.RHER_DAAN = 4;

// Each player's moonscorched form (the user's "Moonscorched Contestants").
// troop: Troops.json (by name); live: [sheet, index, direction, pattern] of
// that form's own field event; dead: the "killed" page of the same character
// on the temple square (Map111 EV616-625, the contestants' bodies).
//   Levi   -> Weeping scope    troop 125, Map090 EV61 p0 (the fast chaser),     dead Map111 EV616 p4
//   Marina -> Cocoon           troop 128, Map081 EV276 p0,                     dead Map111 EV625 p4
//   Daan   -> Pocketcat (NPC)  (troops 123/124 not used), hands over his keys;
//             it stands as the museum's Pocketcat (Daan) (Map084 EV108, $.rherCatPage)
//   Abella -> Chaugnar         troop 20,  Map024 EV55 p0,                      dead Map111 EV623 p4
//   O'saa  -> Mastermind       troop 126, Map080 EV82 p0,                      dead Map111 EV618 p4
//   Marcoh -> Giant            troop 122, Map076 EV151 p0,                     dead Map111 EV621 p4
//   Karin  -> Valkyrie         troop 129, Map059 EV698 p0,                     dead Map111 EV624 p4
//   Olivia -> Mechanical dance troop 120, Map084 EV107 p0,                     dead Map111 EV620 p4
// Speed: the original chasers' (Weeping scope and Chaugnar 4), else 3. The
// original Cocoon and Valkyrie fights cannot be fled (they are ambushes on
// their own maps); as chasing field monsters every form can be fled here,
// like the other chasers (the original 602 branch: it waits 90 frames).
//
// The field event as the original's (0.41 play test: every form walked with
// its direction free, but three sheets have no walking rows - rows 4/6/8 are
// other states, the body and the flowers - so a chasing Cocoon flickered
// between them). page: what differs from a chasing walker -
//   Cocoon (Map081 EV276 p0): remains in place at speed 2, direction fixed,
//     no walking animation. The original event is fixed in place; the stairs
//     bring it down. A moving proxy was both unlike that setup and lagged.
//   Valkyrie (Map059 EV698 p0): stays in place, direction fixed, no walking
//     frames; a touch starts the fight.
//   Mastermind (Map080 EV82 p0): sits in place, direction fixed, its step
//     animation on; a touch starts the fight. Its field Hurting gives the
//     player 150 frames to leave range before it takes a limb.
// The other five walk on four rows in the original too (direction free).
// kill: the switches the original's win over that form turns on besides
// <name>_SOUL, CHARACTERS_LEFT -1 and <name>1 (those came with the player's
// death, DEATH_SWITCH): the form's own "killed" (user decision 2026-10-23:
// killing a player's form is killing that character's moonscorched self).
// v: a variable the win adds to. soul: its "You absorbed the ... soul" box
// (face, index) and line, with animation 403 on the player.
$.RHER_FORMS = {
    1: { name: 'Weeping scope', troop: 125, live: ['$weeping_scope1', 0, 2, 1], dead: ['$weeping_scope4', 0, 6, 1], speed: 4,
        kill: [3542, 3598], soul: ['Aura2', 1, 'Solitary'] },
    3: { name: 'Cocoon', troop: 128, live: ['$cocoon1', 0, 2, 1], dead: ['$cocoon1', 0, 4, 1], speed: 2,
        // it chases with the sheet's top row only (direction fixed): walking
        // turns that row's three frames, never the other rows (its corpse
        // poses - the stutter of the 0.41 play test). User's choice.
        page: { dirFix: true, walk: true, trigger: 2, freq: 5 }, kill: [265], soul: ['Aura2', 2, 'Changeling'] },
    4: { name: 'Pocketcat', npc: true, live: ['$pocketcat', 0, 2, 1], speed: 3 },
    5: { name: 'Chaugnar', troop: 20, live: ['$big_boy', 0, 2, 1], dead: ['$big_boy2', 0, 2, 1], speed: 4,
        kill: [511, 520], soul: ['Aura1', 0, 'Caressing'] },
    6: { name: 'Mastermind', troop: 126, live: ['$mastermind1', 0, 2, 1], dead: ['$mastermind2', 0, 2, 0], speed: 3,
        page: { dirFix: true, still: true, step: true, trigger: 2, freq: 3 }, kill: [3804], soul: ['Aura2', 4, 'Enlightened'] },
    13: { name: 'Giant', troop: 122, live: ['$giant1', 0, 2, 1], dead: ['$giant_dead_1', 0, 2, 1], speed: 3,
        kill: [2768, 4601], soul: ['Aura1', 5, 'Tainted'] },
    14: { name: 'Valkyrie', troop: 129, live: ['$valkyrie1', 0, 2, 1], dead: ['$valkyrie2', 0, 4, 2], speed: 3,
        // it chases, flapping all the time; facing left the sheet $valkyrie1,
        // right $valkyrie3 (user's choice; see $.rherValkyrieUpdate)
        page: { dirFix: true, walk: false, trigger: 2 }, kill: [4674], soul: ['Aura2', 0, 'Endless'] },
    15: { name: 'Mechanical dance', troop: 120, live: ['$mechanical_dance1', 0, 2, 1], dead: ['$mechanical_dance2', 0, 2, 1], speed: 3,
        kill: [2784], v: [[2308, 1]], soul: ['Aura1', 2, 'Shadowed'] }
};
// The characters' SOUL switches (the original's win turns its one on).
$.RHER_SOUL_SWITCH = { 1: 494, 3: 495, 5: 497, 6: 500, 13: 499, 14: 498, 15: 493 };
// A character without a form of its own: a plain moonscorched (Map078 EV229,
// troop 27 Moonscorched1).
$.RHER_FALLBACK_FORM = { name: 'Moonscorched', troop: 27, live: ['$moonscorched1', 0, 2, 1], dead: ['$moonscorched1', 0, 2, 0], speed: 3 };
$.RHER_EVENT_BASE = 9000;   // event ids of the forms: far above any map's own

// The tower's (the one the others went on without, FH_CoopRoam "comes back
// moonscorched"): as the original tower scene (Map111 EV617 p1) - Daan there
// is no talk but the Pocketcat fight (troop 124 Pocketcat2, its win: SW496
// doctor_SOUL, SW4808 pocketcat_sq, SW2821 Pocketcat1), with the museum's
// moonscorched Daan look (Map084 EV108: $pocketcat2_5, killed $pocketcat2_2)
// and its "Blank soul" box (EV108 p3: Aura1 6). User 2026-11-06.
$.RHER_TOWER_FORMS = {
    4: { name: 'Pocketcat', troop: 124, live: ['$pocketcat2_5', 0, 2, 1], dead: ['$pocketcat2_2', 0, 2, 1], speed: 3,
        kill: [4808, 2821], soul: ['Aura1', 6, 'Blank'] }
};
$.RHER_SOUL_SWITCH[4] = 496; // doctor_SOUL (only the tower's Pocketcat is fought)

$.rherForm = function(actorId, rec) {
    if (rec && rec.tower && $.RHER_TOWER_FORMS[actorId]) return $.RHER_TOWER_FORMS[actorId];
    return $.RHER_FORMS[actorId] || $.RHER_FALLBACK_FORM;
};

// Each PC: its own player's timer ----------------------------------------------

$.rherFresh = function() {
    return { active: false, stage: 0, wait: 0, seen: false, doomed: false };
};
$.rher = $.rherFresh();
$.rherFx = [];          // this PC's eye effects (heartbeat, the zoom back)
$.rherSan = { map: 0, data: null, runs: [] }; // this map's regain_sanity pages
$.rherThinHold = false; // thin guest: its SW202 on the host

$.rherClear = function() {
    $.rher = $.rherFresh();
    $.rherSan = { map: 0, data: null, runs: [] };
    $.rherThinHold = false;
};

// A co-op game past the tutorial, hard mode's eye on, this player alive.
$.rherEligible = function() {
    if (!$.role || $.solo || !$gameMap || !$gameMap.mapId()) return false;
    if (!$.tutorialOver() || $gameVariables.value($.RHER_ACTIVE_VAR) !== 1) return false;
    if ($.isGuest() && !$.myActorId) return false;
    if ($.isGhostMe && $.isGhostMe()) return false;
    return !$.spec;
};

$.rherPaused = function() {
    if ($gameParty.inBattle() || $.puppet || ($.isDownMe && $.isDownMe())) return true;
    if (SceneManager.isSceneChanging() || $gamePlayer.isTransferring()) return true;
    if ($.isGuest() && ($.pendingSnapshot || $.pendingRoam || ($.roam && $.roam.leaving))) return true;
    if ($.soloWaitHolds && $.soloWaitHolds()) return true; // at the train exit (FH_Coop)
    return !$.worldReady();
};

// SW202 of this player: a scene runs (the original's step waits for it).
// Lying in bed waiting for the others does not stop it (user 2026-10-23: the
// v0.41 hold on its own SW463 was taken out 2026-10-26).
$.rherHold = function() {
    var sw = $gameSwitches._data;
    if ($.isHost()) return !!($.ctxOwnSave ? $.ctxOwnSave.sw[$.RHER_HOLD_SWITCH] : sw[$.RHER_HOLD_SWITCH]);
    if ($.isRoaming()) return !!sw[$.RHER_HOLD_SWITCH];
    return !!$.rherThinHold;
};

$.rherUpdate = function() {
    $.rherFxUpdate();
    if (!$.rherEligible()) {
        if ($.rher.active || $.rher.stage || $.rher.doomed) $.rherClear();
        return;
    }
    if ($.rherPaused()) return;
    $.rherSanityUpdate();
    $.rherTick();
};

$.rherTick = function() {
    var r = $.rher;
    if (!r.active || r.doomed) return;
    if (r.wait > 0) {
        r.wait--;
        return;
    }
    if ($.rherHold()) return;
    $.rherStep();
};

// One pass of CE535.
$.rherStep = function() {
    var r = $.rher, s = r.stage;
    if (s >= $.RHER_LAST_STAGE) {
        $gamePlayer.requestAnimation($.RHER_LAST_ANIM);
        $.rherHeartbeat();
        r.doomed = true;
        r.wait = $.rherWait(s);
        $.rherMoonscorched();
        return;
    }
    if (s === 0 && !r.seen) {
        r.seen = true;
        $.rherRunFx([$.rherCmd(356, ['GabText ' + $.rherGabText()]), $.rherCmd(356, ['ShowGab'])]);
    }
    var anim = s < $.RHER_HEART_FROM ? $.RHER_EYE_ANIMS[Math.randomInt($.RHER_EYE_ANIMS.length)] : $.RHER_STEP_ANIM[s];
    $gamePlayer.requestAnimation(anim);
    if (s >= $.RHER_HEART_FROM) $.rherHeartbeat();
    r.stage = s + 1;
    r.wait = $.rherWait(r.stage);
    $.dlog('Eye of Rher: stage', r.stage);
};

// CE535's own text (the Korean patch translates it), else the English one.
$.rherGabText = function() {
    var ce = $dataCommonEvents && $dataCommonEvents[$.RHER_TIMER_CE];
    var hit = ce && ce.list.filter(function(c) { return c.code === 356 && /^GabText /.test(String(c.parameters[0])); })[0];
    return hit ? String(hit.parameters[0]).slice(8) : $.RHER_GAB;
};

// CE540 and the others on this player (hard mode, stage >= 1).
$.rherReset = function() {
    var r = $.rher;
    if (!$gameSwitches.value($.RHER_HARD_SWITCH) || r.stage < 1 || r.doomed) return;
    $.rherRunFx([
        $.rherCmd(355, ['if (typeof Galv !== "undefined" && Galv.ZOOM) Galv.ZOOM.restore(30);']),
        $.rherCmd(356, ['eraseFilter MOTION2']),
        $.rherCmd(356, ['eraseFilter RGB2'])
    ]);
    r.stage = 0;
    r.active = false;
    r.wait = 0;
    $.dlog('Eye of Rher: reset');
};

$.rherCmd = function(code, params) {
    return { code: code, indent: 0, parameters: params };
};

$.rherHeartbeat = function() {
    if ($.duelHeartList) $.rherRunFx($.duelHeartList().slice(0, -1));
};

// Effects on this PC only (sounds, filters, zoom, the small text box,
// waits). Lists built here, so a plain interpreter: FH_CoopWorld's effect
// runner (_fhFx) would skip the guarded Galv zoom scripts (its fxScript only
// takes a bare "Galv.ZOOM...").
$.rherRunFx = function(list) {
    var interp = new Game_Interpreter();
    interp._fhRherFx = true;
    interp.setup(list.concat([$.rherCmd(0, [])]), 0);
    $.rherFx.push(interp);
};

$.rherFxUpdate = function() {
    if (!$.rherFx.length) return;
    $.parallelDepth = ($.parallelDepth || 0) + 1;
    try {
        $.rherFx.slice().forEach(function(interp) { interp.update(); });
    } finally {
        $.parallelDepth--;
    }
    $.rherFx = $.rherFx.filter(function(interp) { return interp.isRunning(); });
};

// This map's regain_sanity pages, on this PC, for this player: only their
// waits, branches and the calls of CE372-376 / 540 (as this player's).
$.RHER_SANITY_CODES = { 0: true, 108: true, 408: true, 111: true, 411: true, 412: true, 112: true, 113: true,
    413: true, 115: true, 230: true };

$.rherSanityPage = function(page) {
    return page.trigger === 4 && (page.list || []).some(function(c) {
        return c.code === 117 && !!$.RHER_SANITY_CES[c.parameters[0]];
    });
};

$.rherSanityUpdate = function() {
    var s = $.rherSan, mapId = $gameMap.mapId();
    if (s.map !== mapId || s.data !== $dataMap) {
        s.map = mapId;
        s.data = $dataMap;
        s.runs = [];
        ($dataMap.events || []).forEach(function(ev) {
            if (!ev || ev.id > $.RHER_EVENT_BASE || !ev.pages || !ev.pages.some($.rherSanityPage)) return;
            var interp = new Game_Interpreter();
            interp._fhRherSanity = true;
            s.runs.push({ ev: ev, interp: interp });
        });
    }
    s.runs.forEach(function(run) {
        var interp = run.interp;
        if (!interp.isRunning()) {
            var page = $.rherActivePage(mapId, run.ev);
            if (!page || !$.rherSanityPage(page)) return;
            interp.setup(page.list, run.ev.id);
        }
        interp.update();
    });
};

// The page an event shows now (the last one whose conditions are met).
$.rherActivePage = function(mapId, ev) {
    var probe = { _mapId: mapId, _eventId: ev.id };
    for (var i = ev.pages.length - 1; i >= 0; i--) {
        if (Game_Event.prototype.meetsConditions.call(probe, ev.pages[i])) return ev.pages[i];
    }
    return null;
};

var _executeCommandRher = Game_Interpreter.prototype.executeCommand;
Game_Interpreter.prototype.executeCommand = function() {
    if (this._fhRherSanity) {
        var command = this.currentCommand();
        if (command && command.code === 117) {
            var kind = $.RHER_SANITY_CES[command.parameters[0]];
            if (kind === 'outside') $.rherOutside();
            else if (kind === 'reset') $.rherReset();
            this._index++;
            return true;
        }
        if (command && !$.RHER_SANITY_CODES[command.code]) {
            this._index++;
            return true;
        }
    }
    return _executeCommandRher.call(this);
};

// CE372's part: the eye opens (SW247) for this player.
$.rherOutside = function() {
    if ($gameVariables.value($.RHER_ACTIVE_VAR) !== 1 || $.rherHold() || $.rher.active) return;
    $.rher.active = true;
    $.dlog('Eye of Rher: outside, the eye is on');
};

var _sceneMapUpdateRher = Scene_Map.prototype.update;
Scene_Map.prototype.update = function() {
    _sceneMapUpdateRher.call(this);
    if (!$.role) return;
    try {
        $.rherUpdate();
    } catch (e) {
        $.dlog('ERROR Eye of Rher', e.stack || String(e));
    }
};

// The original timer never runs in a co-op game (this PC's own runs instead).
var _commonEventActiveRher = Game_CommonEvent.prototype.isActive;
Game_CommonEvent.prototype.isActive = function() {
    if ($.role && this._commonEventId === $.RHER_TIMER_CE) return false;
    return _commonEventActiveRher.call(this);
};

// Each PC's own (the moonscorched scene never goes to another PC).
[$.RHER_SWITCH, 1292].forEach(function(id) { $.NO_SYNC_SWITCHES[id] = true; });
$.PC_VARS[$.RHER_STAGE_VAR] = true;

// A load, the title, a new game: no heartbeat of the old game plays on. Both
// effect runners stop (the eye's $.rherFx, FH_CoopWorld's $.fxRuns: the
// static, an alert's heartbeat), the heartbeat's filters go and the screen
// zoom is normal again (what CE540 / CE74 do; only the heartbeats use
// MOTION2 / RGB2). 0.41 play test: loaded in the middle of a beat, its zoom,
// blur and colour split went on in the loaded game.
$.dropEyeFx = function(why) {
    var had = $.rherFx.length + ($.fxRuns ? $.fxRuns.length : 0);
    $.rherFx = [];
    $.fxRuns = [];
    if (!$.role && !had) return; // (a single player game: as the original)
    try {
        if ($gameMap && $gameMap.eraseFilter && $gameMap._filterConArr) {
            $gameMap.eraseFilter('MOTION2');
            $gameMap.eraseFilter('RGB2');
        }
        if ($gameScreen && $gameScreen.zoomScale() !== 1) $gameScreen.clearZoom();
    } catch (e) {
        $.dlog('ERROR eye effects reset', String(e));
    }
    if (had) $.dlog('eye / heartbeat effects stopped (' + why + '):', had);
};

// A load, the title, leaving: a new start.
var _onLoadSuccessRher = Scene_Load.prototype.onLoadSuccess;
Scene_Load.prototype.onLoadSuccess = function() {
    $.rherClear();
    $.dropEyeFx('a save loaded'); // (the loaded game's map and screen)
    _onLoadSuccessRher.call(this);
};

var _leaveAsGuestRher = $.leaveAsGuest;
$.leaveAsGuest = function(message) {
    $.rherClear();
    _leaveAsGuestRher(message);
};

var _setupNewGameRher = DataManager.setupNewGame;
DataManager.setupNewGame = function() {
    $.rherClear();
    _setupNewGameRher.call(this);
    $.dropEyeFx('a new game');
};

var _sceneTitleStartRher = Scene_Title.prototype.start;
Scene_Title.prototype.start = function() {
    $.rherClear();
    $.dropEyeFx('the title');
    _sceneTitleStartRher.call(this);
};

// Host: a thin guest's SW202 (its scene on the host) and V2197 (its copy of
// the world is a snapshot's).
$.rherLastOn = undefined;
$.worldExtras.push(function() {
    if (!$.runsWorld() || Graphics.frameCount % 10 !== 0) return;
    var on = $gameVariables.value($.RHER_ACTIVE_VAR);
    if ($.isHost() && on !== $.rherLastOn) {
        $.rherLastOn = on;
        $.clients.forEach(function(c) { c.send({ t: 'rherOn', v: on }); });
    }
    // (a sub-host's guests: their own SW202 is on the sub-host, which tells them -
    // isHost audit 2026-11-10)
    $.clients.forEach(function(c) {
        if (c.roam || c.subOf || !c.actorId || ($.isHost() && c._sub)) return;
        var hold = !!$.ctxOwnOf(c)[$.RHER_HOLD_SWITCH];
        if (hold === !!c._fhRherHold) return;
        c._fhRherHold = hold;
        c.send({ t: 'rherHold', on: hold });
    });
});

$.guestHandlers.rherOn = function(msg) {
    if ($gameVariables && $.isThin()) $gameVariables._data[$.RHER_ACTIVE_VAR] = Number(msg.v) || 0;
};

$.guestHandlers.rherHold = function(msg) {
    $.rherThinHold = !!msg.on;
};

// Kills that reset (CE547 in an event's "won" branch) ------------------------

// The player whose event this is (a map's gun check, arrow_check, while a
// guest's bullet flies: that guest's kill).
// A sub-host runs its guests' events and shots the same way ($.bullet's
// 'host' is the PC running the world).
$.rherPlayerOf = function(interp) {
    if (interp._fhOwner) return interp._fhOwner;
    if ($.runsWorld()) {
        if ($.ctx) return $.ctx.guestId;
        var b = $.bullet;
        if ($.mapParallelDepth && b && b.shooter && b.shooter !== 'host' && b.mapId === $gameMap.mapId()) return b.shooter;
    }
    return $.myPlayerId();
};

var _command117Rher = Game_Interpreter.prototype.command117;
Game_Interpreter.prototype.command117 = function() {
    if (this._params[0] === $.RHER_KILL_CE && $.role && !this._fhFx && !this._fhRherFx && ($.isHost() || $.isRoaming())) {
        $.rherKillReset(this);
    }
    return _command117Rher.call(this);
};

// The event's player and whoever fought that fight with it.
$.rherKillReset = function(interp) {
    var ids = [$.rherPlayerOf(interp)].concat(interp._fhRherJoiners || []);
    ids.filter(function(id, i) { return !!id && ids.indexOf(id) === i; }).forEach($.rherResetPlayer);
};

$.rherResetPlayer = function(id) {
    if (id === $.myPlayerId()) {
        $.rherReset();
        return;
    }
    if ($.isHost()) {
        $.sendTo(id, { t: 'rherReset' });
        return;
    }
    var v = $.clientById(id); // a sub-host's guest
    if (v) v.send({ t: 'rherReset' });
    else if ($.conn) $.conn.send({ t: 'rherResetFor', id: id });
};

$.guestHandlers.rherReset = function() {
    $.rherReset();
};

$.hostHandlers.rherResetFor = function(conn, msg) {
    var id = msg && msg.id;
    if (id === 'host' || $.clientById(id)) $.rherResetPlayer(id);
};

// Who fought it with the event's player (the joiners), for the reset above.
var _endAuthBattleRher = $.endAuthBattle;
$.endAuthBattle = function(result) {
    var ab = $.authBattle;
    if (ab && ab.interp) ab.interp._fhRherJoiners = (ab.joiners || []).slice();
    return _endAuthBattleRher(result);
};

var _battleEndRher = $.hostHandlers.battleEnd;
$.hostHandlers.battleEnd = function(conn, msg) {
    var b = msg && $.battles[msg.bid];
    if (b && b.interp && !b.pvp) b.interp._fhRherJoiners = (b.joiners || []).slice();
    return _battleEndRher(conn, msg);
};

var _clearRher = Game_Interpreter.prototype.clear;
Game_Interpreter.prototype.clear = function() {
    _clearRher.call(this);
    delete this._fhRherJoiners;
};

// Stage 6: this player is moonscorched ------------------------------------------

$.rherMoonscorched = function() {
    var actorId = $.isHost() ? $.hostActorId() : $.myActorId;
    var spot = { m: $gameMap.mapId(), x: $gamePlayer.x, y: $gamePlayer.y, d: $gamePlayer.direction() };
    $.dlog('Eye of Rher: moonscorched at map', spot.m, spot.x, spot.y);
    if ($.isHost() && !$.sessionActive()) {
        // nobody else in the game: the original scene and its game over
        $gameSwitches.setValue(1292, true);
        return;
    }
    $.rherSceneFx(actorId === $.RHER_DAAN);
    $.rherStageBegin(actorId); // (its own scene on this screen, after the white)
    if ($.isHost()) {
        $.rherDoom('host', spot);
        return;
    }
    var msg = Object.assign({ t: 'rherDoom' }, spot);
    if ($.isRoaming()) {
        // its bag is on this PC: the host's copy is the one the form keeps
        msg.actor = $.actorJson($gameActors.actor($.myActorId));
        msg.inv = { i: $gameParty._items, w: $gameParty._weapons, a: $gameParty._armors, g: $gameParty._gold };
    }
    if ($.conn) $.conn.send(msg);
};

$.rherSceneFx = function(daan) {
    $.RHER_SCENE_SES.forEach(function(se) { AudioManager.playSe(se); });
    $gameScreen.startShake(1, 9, 150);
    $gameScreen.startFlash([255, 255, 255, 255], 100);
    if (!daan) $gamePlayer.requestAnimation($.RHER_SCENE_ANIM);
};

$.hostHandlers.rherDoom = function(conn, msg) {
    if (!conn.actorId || $.isDead(conn.guestId) || !msg) return;
    if (conn.roam && (msg.actor || msg.inv)) $.storeBelongings(conn, msg);
    var p = conn.lastPos || {};
    var spot = {
        m: Number(msg.m) || p.m || $gameMap.mapId(),
        x: Number(msg.x), y: Number(msg.y), d: Number(msg.d) || 2
    };
    if (isNaN(spot.x) || isNaN(spot.y)) {
        spot.x = p.x || 0;
        spot.y = p.y || 0;
    }
    $.rherDoom(conn.guestId, spot);
};

// Host: dies for good; its form stands where it fell (its body does not).
$.rherNoBody = 0;
$.rherDoom = function(id, spot) {
    if (!$.isHost() || $.isDead(id)) return;
    var actor = $.actorOfPlayer(id);
    if (!actor) return;
    $.markDoom(actor, 'moonscorch');
    $.rherSpawn(id, actor.actorId(), spot);
    $.rherNoBody = actor.actorId();
    try {
        $.doomDies(id, 'moonscorch');
    } finally {
        $.rherNoBody = 0;
    }
};

var _addCorpseRher = $.addCorpse;
$.addCorpse = function(actorId, m, x, y) {
    if ($.rherNoBody && actorId === $.rherNoBody) return;
    _addCorpseRher(actorId, m, x, y);
};

// The moonscorched scene, on the dying player's screen only ------------------
// (user request 2026-11-05: each character's own scene again, seen by that
// player alone). The original: CE536 (the white, a wait of 150), then map 141
// "transform" - no tiles, the parallax white_background; each character's
// transform event (EV5 Marcoh, EV7-12 Levi, Karin, O'saa, Olivia, Abella,
// Marina), its frames pages on its SELECT switch and V1069; the autorun EV6
// moves that one to the middle and steps V1069 with the noise and the
// screams, then a game over. Daan: map 132, EV3's SW1292 branch (no tiles
// either, no words: Pocketcat comes up, the mask's frames on SW4888-4898,
// the black), a game over. Here the death, the ghost
// and the form come at once as before (the others see the form appear); this
// PC then plays that map's scene over its own screen as a stage of its own:
// that map's data read here, its events drawn as sprites above the map, the
// scene's list run by an interpreter whose switches, variables, self
// switches, event moves, tint and screen noise are the stage's - never the
// world's (the world's switches go to everyone; a thin guest's screen tone is
// the host's). Its words are this PC's own (event 0: nobody's message to
// share). Its game over is its end; the ghost walks on where it fell. The
// player does not move, open the menu or watch a fight meanwhile.
$.RHER_STAGE_WAIT = 150;                              // CE536: the white, then the move
$.RHER_STAGE_TINT_IN = 70;                            // CE536: the tint back on the next map
$.RHER_STAGE_FADE = 30;                               // its end: back to the ghost's map
$.RHER_STAGE_SCENE = { 141: 6, 132: 3 };              // map -> the event whose first page is the scene
$.RHER_STAGE_SPOT = { 141: [8, 6], 132: [8, 9] };     // CE536's move: the camera's centre
$.rherStage = null;

$.rherStageBegin = function(actorId) {
    var mapId = actorId === $.RHER_DAAN ? $.MOONSCORCH_DAAN_MAP : $.MOONSCORCH_MAP;
    var data = $.bodyMapData(mapId);
    var sceneEv = $.RHER_STAGE_SCENE[mapId];
    var page = data && data.events[sceneEv] && data.events[sceneEv].pages[0];
    if (!page) {
        $.dlog('Eye of Rher: no scene data of map', mapId);
        return;
    }
    var sw = {};
    Object.keys($.SELECT_ACTOR).forEach(function(id) {
        if ($.SELECT_ACTOR[id] === actorId) sw[id] = true;
    });
    sw[$.MOONSCORCHED_SWITCH] = true; // (Daan's scene: its SW1292 branch)
    var spot = $.RHER_STAGE_SPOT[mapId];
    var tilesX = Math.round(Graphics.width / 48), tilesY = Math.round(Graphics.height / 48);
    $.rherStage = {
        actorId: actorId, map: mapId, data: data, sceneEv: sceneEv, list: page.list, wait: $.RHER_STAGE_WAIT,
        sw: sw, v: {}, ss: {}, chars: {}, interp: null,
        disp: { x: Math.max(0, Math.min(data.width - tilesX, spot[0] - Math.floor(tilesX / 2))),
            y: Math.max(0, Math.min(data.height - tilesY, spot[1] - Math.floor(tilesY / 2))) },
        tone: [255, 255, 255, 0], toneTarget: [0, 0, 0, 0], toneDur: $.RHER_STAGE_TINT_IN,
        fx: $.rherStageFx(), over: false, fade: 0, layer: null
    };
    $.dlog('Eye of Rher: the moonscorched scene of map', mapId, 'for actor', actorId);
};

// The stage's screen effects (Olivia_HorrorEffects "Screen" in its list):
// its layer follows this source, not $gameScreen.
$.rherStageFx = function() {
    var gs = Game_System.prototype;
    return { _horrorFilters: {}, clearHorrorEffects: function() { this._horrorFilters = {}; },
        createHorrorEffect: gs.createHorrorEffect, removeHorrorEffect: gs.removeHorrorEffect,
        setHorrorEffectToValue: gs.setHorrorEffectToValue };
};

// Its page's conditions with the stage's switches and variables.
$.rherStageMeets = function(s, evId, c) {
    if (c.switch1Valid && !s.sw[c.switch1Id]) return false;
    if (c.switch2Valid && !s.sw[c.switch2Id]) return false;
    if (c.variableValid && (s.v[c.variableId] || 0) < c.variableValue) return false;
    if (c.selfSwitchValid && !s.ss[evId + ',' + c.selfSwitchCh]) return false;
    if (c.itemValid) return false;
    if (c.actorValid && c.actorId !== s.actorId) return false;
    return true;
};

// An event of the scene's map: drawn where the scene's camera is, its page
// the last one the stage meets (as a map event's, without the map).
$.RherStageChar = function() { this.initialize.apply(this, arguments); };
$.RherStageChar.prototype = Object.create(Game_Character.prototype);
$.RherStageChar.prototype.constructor = $.RherStageChar;
$.RherStageChar.prototype.initialize = function(data) {
    Game_Character.prototype.initialize.call(this);
    this._fhStageData = data;
    this._pageIndex = -2;
    this._originalPattern = 1;
    this.locate(data.x, data.y);
};
$.RherStageChar.prototype.refreshBushDepth = function() { this._bushDepth = 0; };
$.RherStageChar.prototype.scrolledX = function() { return this._realX - ($.rherStage ? $.rherStage.disp.x : 0); };
$.RherStageChar.prototype.scrolledY = function() { return this._realY - ($.rherStage ? $.rherStage.disp.y : 0); };
$.RherStageChar.prototype.isOriginalPattern = function() { return this.pattern() === this._originalPattern; };
$.RherStageChar.prototype.resetPattern = function() { this.setPattern(this._originalPattern); };
$.RherStageChar.prototype.refreshPage = function(s) {
    var data = this._fhStageData, index = -1;
    for (var i = data.pages.length - 1; i >= 0; i--) {
        if ($.rherStageMeets(s, data.id, data.pages[i].conditions)) {
            index = i;
            break;
        }
    }
    if (index === this._pageIndex) return;
    this._pageIndex = index;
    var page = data.pages[index];
    if (!page) {
        this.setImage('', 0);
        return;
    }
    var img = page.image;
    if (img.tileId > 0) this.setTileImage(img.tileId);
    else this.setImage(img.characterName, img.characterIndex);
    this.setDirectionFix(false);
    this.setDirection(img.direction);
    this.setDirectionFix(page.directionFix);
    this._originalPattern = img.pattern;
    this.setPattern(img.pattern);
    this.setWalkAnime(page.walkAnime);
    this.setStepAnime(page.stepAnime);
    this.setPriorityType(page.priorityType);
};

// The scene's list, on the stage.
$.RherStageInterp = function() { this.initialize.apply(this, arguments); };
$.RherStageInterp.prototype = Object.create(Game_Interpreter.prototype);
$.RherStageInterp.prototype.constructor = $.RherStageInterp;
var GI = Game_Interpreter.prototype, SI = $.RherStageInterp.prototype;
SI.character = function(param) {
    var s = $.rherStage;
    if (!s || param < 0) return null; // (the player: hidden behind the stage)
    return s.chars[param === 0 ? s.sceneEv : param] || null;
};
SI.command111 = function() {
    var s = $.rherStage, p = this._params, result;
    if (!s) return true;
    if (p[0] === 0) {
        result = !!s.sw[p[1]] === (p[2] === 0);
    } else if (p[0] === 1) {
        var a = s.v[p[1]] || 0, b = p[2] === 0 ? p[3] : s.v[p[3]] || 0;
        result = [a === b, a >= b, a <= b, a > b, a < b, a !== b][p[4]];
    } else if (p[0] === 2) {
        result = !!s.ss[s.sceneEv + ',' + p[1]] === (p[2] === 0);
    } else {
        return GI.command111.call(this);
    }
    this._branch[this._indent] = !!result;
    if (!result) this.skipBranch();
    return true;
};
SI.command121 = function() {
    var s = $.rherStage, p = this._params;
    for (var id = p[0]; s && id <= p[1]; id++) s.sw[id] = p[2] === 0;
    return true;
};
SI.command122 = function() {
    var s = $.rherStage, p = this._params, value = 0;
    if (!s) return true;
    if (p[3] === 0) value = p[4];
    else if (p[3] === 1) value = s.v[p[4]] || 0;
    else if (p[3] === 2) value = p[4] + Math.randomInt(p[5] - p[4] + 1);
    for (var id = p[0]; id <= p[1]; id++) {
        var old = s.v[id] || 0;
        s.v[id] = [value, old + value, old - value, old * value, value ? Math.floor(old / value) : 0,
            value ? old % value : 0][p[2]] || 0;
    }
    return true;
};
SI.command123 = function() {
    var s = $.rherStage;
    if (s) s.ss[s.sceneEv + ',' + this._params[0]] = this._params[1] === 0;
    return true;
};
SI.command223 = function() {
    var s = $.rherStage, p = this._params;
    if (s) {
        s.toneTarget = p[0].slice();
        s.toneDur = p[1];
        if (!p[1]) s.tone = p[0].slice();
    }
    if (p[2]) this.wait(p[1]);
    return true;
};
SI.command353 = function() { // the game over: its end
    if ($.rherStage) $.rherStage.over = true;
    this._index = this._list.length;
    return true;
};
// Nothing of the player, the world or the map it is not on: the player's
// look (211), menu (135), a common event (117: CE104 the room change), a move
// (201), the screen's own fades, flash and shake (221, 222, 224, 225; its tint
// is the stage's, 223 above), the save, the title.
[117, 135, 201, 211, 221, 222, 224, 225, 352, 354].forEach(function(code) {
    SI['command' + code] = function() { return true; };
});
// Its words are this PC's alone (a sub-host shares its messages by $.msgShared).
SI.command101 = function() {
    if (!$gameMessage.isBusy()) {
        $.msgShared = false;
        $.msgOwner = null;
    }
    return GI.command101.call(this);
};
SI.getPluginCommandHorrorEffectsTarget = function(args) {
    var text = String(args.shift() || '');
    return /(?:Screen|Map)/i.test(text) && $.rherStage ? $.rherStage.fx : null;
};

$.rherStageUpdate = function() {
    var s = $.rherStage;
    if (!s) return;
    if (s.wait > 0) {
        s.wait--;
        return;
    }
    if (!s.interp) {
        s.data.events.forEach(function(ev) {
            if (ev) s.chars[ev.id] = new $.RherStageChar(ev);
        });
        s.interp = new $.RherStageInterp();
        s.interp._fhRherStage = true;
        s.interp.setup(s.list, 0);
    }
    if (!s.over) {
        try {
            s.interp.update();
        } catch (e) {
            $.dlog('ERROR Eye of Rher scene', e.stack || String(e));
            s.over = true;
        }
        if (!s.interp.isRunning()) s.over = true;
    }
    Object.keys(s.chars).forEach(function(id) {
        s.chars[id].refreshPage(s);
        s.chars[id].update();
    });
    if (s.toneDur > 0) {
        var d = s.toneDur--;
        s.tone = s.tone.map(function(t, i) { return (t * (d - 1) + s.toneTarget[i]) / d; });
    }
    if (s.over) s.fade++;
    $.rherStageDraw(s);
    if (s.fade >= $.RHER_STAGE_FADE) $.rherStageStop('is over');
};

// Above the map (its tint, lighting, fog and pictures), under the windows.
$.rherStageDraw = function(s) {
    var scene = SceneManager._scene;
    if (s.noDraw) {
        if (s.layer && s.layer.parent) s.layer.parent.removeChild(s.layer);
        s.layer = null;
        return;
    }
    if (!(scene instanceof Scene_Map) || !scene._windowLayer || typeof ScreenSprite === 'undefined') return;
    try {
        if (!s.layer || s.layer.parent !== scene) {
            if (s.layer && s.layer.parent) s.layer.parent.removeChild(s.layer);
            var layer = new Sprite();
            layer._horrorFiltersSource = s.fx;
            // (its sprites update in the scene's own loop: another plugin's
            // hook failing on a character that is no map event ends the
            // scene, never the game; taken off on the next frame)
            layer.update = function() {
                try {
                    Sprite.prototype.update.call(this);
                } catch (e) {
                    $.dlog('ERROR Eye of Rher scene sprites', e.stack || String(e));
                    s.noDraw = true;
                    s.over = true;
                }
            };
            var back = new ScreenSprite();
            back.setBlack();
            layer.addChild(back);
            if (s.data.parallaxName) layer.addChild(new Sprite(ImageManager.loadParallax(s.data.parallaxName)));
            Object.keys(s.chars).forEach(function(id) { layer.addChild(new Sprite_Character(s.chars[id])); });
            s.white = new ScreenSprite();
            s.white.setWhite();
            s.black = new ScreenSprite();
            s.black.setBlack();
            layer.addChild(s.white);
            layer.addChild(s.black);
            scene.addChildAt(layer, scene.children.indexOf(scene._windowLayer));
            s.layer = layer;
        }
        var avg = (s.tone[0] + s.tone[1] + s.tone[2]) / 3;
        s.white.opacity = Math.max(0, Math.min(255, avg));
        s.black.opacity = Math.max(0, Math.min(255, -avg));
        s.layer.opacity = s.over ? Math.round(255 * Math.max(0, 1 - s.fade / $.RHER_STAGE_FADE)) : 255;
    } catch (e) {
        $.dlog('ERROR Eye of Rher scene layer', e.stack || String(e));
        if (s.layer && s.layer.parent) s.layer.parent.removeChild(s.layer);
        s.layer = null;
        s.noDraw = true; // (not again every frame: the scene ends)
        s.over = true;
    }
};

$.rherStageStop = function(why) {
    var s = $.rherStage;
    if (!s) return;
    $.rherStage = null;
    if (s.layer && s.layer.parent) s.layer.parent.removeChild(s.layer);
    $.dlog('Eye of Rher: the moonscorched scene', why);
};

var _sceneMapUpdateRherStage = Scene_Map.prototype.update;
Scene_Map.prototype.update = function() {
    _sceneMapUpdateRherStage.call(this);
    if (!$.rherStage) return;
    try {
        $.rherStageUpdate();
    } catch (e) {
        $.dlog('ERROR Eye of Rher scene', e.stack || String(e));
        $.rherStageStop('stopped');
    }
};

var _canMoveRherStage = Game_Player.prototype.canMove;
Game_Player.prototype.canMove = function() {
    if ($.rherStage && this === $gamePlayer) return false;
    return _canMoveRherStage.call(this);
};

var _isMenuEnabledRherStage = Scene_Map.prototype.isMenuEnabled;
Scene_Map.prototype.isMenuEnabled = function() {
    return !$.rherStage && _isMenuEnabledRherStage.call(this);
};

var _askWatchFightRherStage = $.askWatchFight;
$.askWatchFight = function() {
    if ($.rherStage) return;
    _askWatchFightRherStage();
};

var _watchHintTextRherStage = $.watchHintText;
$.watchHintText = function() {
    return $.rherStage ? '' : _watchHintTextRherStage();
};

// A load, the title, a new game, leaving: no scene of the game before.
var _onLoadSuccessRherStage = Scene_Load.prototype.onLoadSuccess;
Scene_Load.prototype.onLoadSuccess = function() {
    $.rherStageStop('dropped (a save loaded)');
    _onLoadSuccessRherStage.call(this);
};
var _leaveAsGuestRherStage = $.leaveAsGuest;
$.leaveAsGuest = function(message) {
    $.rherStageStop('dropped (left)');
    _leaveAsGuestRherStage(message);
};
var _setupNewGameRherStage = DataManager.setupNewGame;
DataManager.setupNewGame = function() {
    $.rherStageStop('dropped (a new game)');
    _setupNewGameRherStage.call(this);
};
var _sceneTitleStartRherStage = Scene_Title.prototype.start;
Scene_Title.prototype.start = function() {
    $.rherStageStop('dropped (the title)');
    _sceneTitleStartRherStage.call(this);
};

// The forms: map events of their own, in the host's save ---------------------

$.rherData = function() {
    var d = $.coopData();
    d.rher = d.rher || {};
    d.rher.list = d.rher.list || [];
    d.rher.owed = d.rher.owed || {};
    return d.rher;
};

// The forms (read only: a single player game's save gets nothing new).
$.rherList = function() {
    var d = $gameSystem && $gameSystem._fhCoop && $gameSystem._fhCoop.rher;
    return d && Array.isArray(d.list) ? d.list : [];
};

$.rherRecord = function(eventId, mapId) {
    var list = $.rherList();
    for (var i = 0; i < list.length; i++) {
        if (list[i].id === eventId && (!mapId || list[i].m === mapId)) return list[i];
    }
    return null;
};

$.rherRecordN = function(n) {
    return $.rherList().filter(function(r) { return r.n === n; })[0] || null;
};

// A free event id on that map, the same on every PC (it is in the record):
// above the map's own events, the other forms there and the GALV spawner's
// saved events (they take the next id after the highest).
$.rherNewId = function(m) {
    var top = $.RHER_EVENT_BASE;
    $.rherData().list.forEach(function(r) { if (r.m === m) top = Math.max(top, r.id); });
    var saved = $gameMap._savedSpawnedEvents && $gameMap._savedSpawnedEvents[m];
    Object.keys(saved || {}).forEach(function(k) { top = Math.max(top, Number(k) || 0); });
    if ($gameMap.mapId() === m) top = Math.max(top, $gameMap._events.length - 1);
    return top + 1;
};

$.rherSpawn = function(id, actorId, spot, who, opts) {
    var data = $.rherData();
    var form = $.rherForm(actorId, opts);
    data.n = (data.n || 0) + 1;
    var rec = {
        n: data.n, id: $.rherNewId(spot.m), a: actorId, who: who || $.nameOf(id) || '#host',
        kind: form.npc ? 'npc' : 'boss', m: spot.m, x: spot.x, y: spot.y, dead: false, first: null
    };
    if (opts && opts.tower) rec.tower = true;
    data.list.push(rec);
    $.rherFreshId(rec.m, rec.id);
    $.dlog('Eye of Rher:', $.playerLabel(id), 'is now', form.name, '- event', rec.id, 'on map', rec.m, rec.x, rec.y);
    $.rherBroadcast();
    $.rherPlaceAll();
    var who = $dataActors[actorId] ? $dataActors[actorId].name : $.playerLabel(id);
    $.broadcastToast(who + ' turned into ' + (form.npc ? 'the ' : 'a ') + form.name + '.');
    return rec;
};

// A GALV spawned event that had this id on a visit (unsaved ones give their
// ids back) may have left self switches or a YEP saved location: a new form
// there would start as a body, or somewhere else.
$.rherFreshId = function(m, id) {
    ['A', 'B', 'C', 'D'].forEach(function(ch) {
        if ($gameSelfSwitches.value([m, id, ch])) $gameSelfSwitches.setValue([m, id, ch], false);
    });
    var saved = $gameSystem._savedEventLocations;
    if (saved) delete saved[[m, id]];
};

$.rherBroadcast = function() {
    var list = $.rherData().list;
    $.clients.forEach(function(c) { if (!c._sub) c.send({ t: 'rherList', list: list }); });
};

$.guestHandlers.rherList = function(msg) {
    if (!$gameSystem || !msg || !Array.isArray(msg.list)) return;
    $.rherData().list = msg.list;
    $.rherPlaceAll();
};

// The event data of a form (the same on every PC).
$.rherPage = function(o) {
    return {
        conditions: {
            actorId: 1, actorValid: false, itemId: 1, itemValid: false, selfSwitchCh: 'A', selfSwitchValid: !!o.ss,
            switch1Id: 1, switch1Valid: false, switch2Id: 1, switch2Valid: false, variableId: 1, variableValid: false,
            variableValue: 0
        },
        directionFix: !!o.dirFix,
        image: { tileId: 0, characterName: o.look[0], characterIndex: o.look[1], direction: o.look[2], pattern: o.look[3] },
        list: o.list,
        moveFrequency: o.freq || 3,
        moveRoute: o.route || { list: [$.rherCmd(0, [])], repeat: true, skippable: false, wait: false },
        moveSpeed: o.speed || 3,
        moveType: o.moveType || 0,
        priorityType: o.prio === undefined ? 1 : o.prio,
        stepAnime: !!o.step,
        through: false,
        trigger: o.trigger || 0,
        walkAnime: o.walk !== false
    };
};

$.rherBossList = function(rec, form) {
    var c = function(code, params, indent) { return { code: code, indent: indent || 0, parameters: params }; };
    var script = function(fn, indent) { return c(355, ['FH.Coop.' + fn + '(this, ' + rec.n + ');'], indent); };
    var wait = { code: 15, parameters: [90], indent: null };
    return [
        script('rherTouched'),
        c(223, [[-255, -255, -255, 0], 10, false]),
        c(117, [74]), // BEFORE BATTLE
        c(132, [{ name: 'desperation', volume: 90, pitch: 100, pan: 0 }]),
        c(301, [0, form.troop, true, false]),
        c(601, []),
        c(117, [66], 1), // AFTER BATTLE
        script('rherWon', 1),
        c(117, [$.RHER_KILL_CE], 1)
    ].concat(form.soul ? [ // the original's "soul absorbed" (on the winner)
        c(212, [-1, 403, true], 1),
        c(101, [form.soul[0], form.soul[1], 1, 1], 1),
        c(401, ['You absorbed the \\c[2]' + form.soul[2] + ' soul\\c[0].'], 1)
    ] : []).concat([
        c(0, [], 1),
        c(602, []),
        c(117, [66], 1),
        c(205, [0, { list: [wait, { code: 0 }], repeat: false, skippable: false, wait: false }], 1),
        c(505, [wait], 1),
        c(0, [], 1),
        c(604, []),
        c(132, [{ name: 'breath_of_the_moon', volume: 90, pitch: 100, pan: 0 }]),
        c(0, [])
    ]);
};

// Like the original chasers (Map024 EV55): chase within 10 tiles once seen,
// the "seen" scare (CE263), wander otherwise.
$.rherChaseRoute = function() {
    var r = function(code, params) { return params ? { code: code, parameters: params, indent: null } : { code: code, indent: null }; };
    return {
        list: [r(45, ['this._chaseRange = 10']), r(45, ['this._seePlayer = true']), r(45, ['this._alertCommonEvent = 263']),
            r(9), r(9), r(9), r(15, [60]), r(9), r(9), r(15, [40]), r(0)],
        repeat: true, skippable: true, wait: false
    };
};

$.rherEventData = function(rec) {
    var form = $.rherForm(rec.a, rec);
    var pages;
    if (rec.kind === 'npc') {
        // the museum's Pocketcat (Daan) as it is (it stands; play test
        // 2026-11-06: "가만히 서 있어야 하는데 움직인다")
        var cat = $.rherCatPage();
        pages = [
            $.rherPage({ look: [cat.image.characterName, cat.image.characterIndex, cat.image.direction, cat.image.pattern],
                list: [$.rherCmd(355, ['FH.Coop.rherCatTalk(this);']), $.rherCmd(0, [])],
                moveType: 0, speed: cat.moveSpeed, freq: cat.moveFrequency, trigger: 0, dirFix: cat.directionFix,
                walk: cat.walkAnime, step: cat.stepAnime, prio: cat.priorityType }),
            // gone (it handed over the keys)
            $.rherPage({ look: ['', 0, 2, 0], list: [$.rherCmd(0, [])], ss: true, prio: 0, trigger: 0 })
        ];
    } else {
        // (the original's settings of that form, RHER_FORMS page; the body
        // keeps its row too: a talk turns an event toward the player)
        var o = form.page || {};
        pages = [
            $.rherPage({ look: form.live, list: $.rherBossList(rec, form), moveType: o.still ? 0 : 3,
                route: o.still ? null : $.rherChaseRoute(),
                speed: form.speed, freq: o.freq || 5, trigger: o.trigger || 2, dirFix: o.dirFix, walk: o.walk, step: o.step }),
            $.rherPage({ look: form.dead, list: [$.rherCmd(0, [])], ss: true, prio: 0, trigger: 0, dirFix: true })
        ];
    }
    return { id: rec.id, name: 'FH_rher_' + rec.n, note: '', meta: {}, x: rec.x, y: rec.y, pages: pages, _fhRher: rec.n };
};

// The original's moonscorched Daan in the museum, before the Guernica
// (Map084 EV108 "pocketdaan" p0: $pocketcat 0 facing down, fixed in place,
// its direction fixed; not EV9, the Pocketcat who sells books). Other data
// without it: the same settings.
$.RHER_CAT_NPC = { map: 84, ev: 108 };
$.RHER_CAT_PAGE = { image: { characterName: '$pocketcat', characterIndex: 0, direction: 2, pattern: 1 },
    moveSpeed: 3, moveFrequency: 5, directionFix: true, walkAnime: true, stepAnime: false, priorityType: 1 };
$.rherCatPage = function() {
    var m = $.bodyMapData ? $.bodyMapData($.RHER_CAT_NPC.map) : null;
    var ev = m && m.events && m.events[$.RHER_CAT_NPC.ev];
    var p = ev && ev.pages && ev.pages[0];
    return p && p.image && /pocketcat/i.test(p.image.characterName) && p.moveType === 0 ? p : $.RHER_CAT_PAGE;
};

// Mastermind's overworld Hurting, as the original yellow mage's (data: Map080
// EV104/117 and the day mage's EV010 of Map037 etc.: while SW3772 dance is on,
// animation 442 on the player at 10 and 60 frames, at 90 SW3775 -> CE420
// YELLOW_MAGE_HURTING; then a 20-frame cooldown (SW3777) and again). The
// original turns the dance on with floor tiles in the mage's sight; a form
// stands anywhere, so here the range is four tiles (the original's dance-on
// tiles lie 3-5 tiles from the mage: Map080, 037, 079). Leaving it stops the cast.
// Touching it starts the battle instead.
$.RHER_MASTERMIND_RANGE = 4;
$.RHER_MASTERMIND_ANIM_MS = [167, 1000]; // (10 and 60 frames at 60 fps, $.clockMs)
$.RHER_MASTERMIND_HIT_MS = 1833;         // 90 frames to CE420, its 20-frame wait, then the cut (110)
// CE420's waits and the cooldown page are about a second: the original's
// pace (user 2026-11-06: "follow the original" - the 4 s rest of the 0.41
// play test's "far too fast" is gone; the original Mastermind is as fast)
$.RHER_MASTERMIND_COOL_MS = 1000;

// A screen command on that player's own screen (its PC draws it).
$.rherMastermindCmd = function(target, code, params) {
    if (target.ch === $gamePlayer) {
        var interp = new Game_Interpreter();
        interp._params = params;
        interp._indent = 0;
        interp._list = [{ code: code, indent: 0, parameters: params }];
        interp['command' + code].call(interp);
    } else {
        $.sendTo(target.id, { t: 'cmd', c: code, p: params });
    }
};

$.rherMastermindGab = function(target, text) {
    if (target.ch === $gamePlayer) $.fieldGab(text);
    else $.sendTo(target.id, { t: 'gab', text: text });
};

// CE420 for one character: limb switches [arm1, arm2, leg1, leg2] (on = lost).
// Both second limbs gone: nothing to cut (442, the dance ends). Else arm or
// leg at random (the other when one side is gone), the first of that side,
// then the second; 445 when that side has none left. 20 HP each time
// (it never kills: 311 without death).
$.rherMastermindHit = function(target, rec) {
    var actor = $.actorOfPlayer(target.id);
    var limbs = actor && $.LIMB_SWITCHES && $.LIMB_SWITCHES[actor.actorId()] || [];
    if (limbs.length < 4) return null;
    var lost = function(i) { return $gameSwitches.value(limbs[i]); };
    if (lost(1) && lost(3)) {
        $.rherMastermindCmd(target, 212, [-1, 442, false]);
        $.dlog('Mastermind field Hurting: nothing left to cut for', $.playerLabel(target.id));
        return null;
    }
    var arm = Math.random() < 0.5;
    if (lost(1)) arm = false;
    if (lost(3)) arm = true;
    var first = arm ? 0 : 2, sw = null;
    if (!lost(first)) sw = limbs[first];
    else if (!lost(first + 1)) sw = limbs[first + 1];
    $.rherMastermindCmd(target, 212, [-1, sw ? (arm ? 443 : 444) : 445, false]);
    $.rherMastermindCmd(target, 311, [0, 0, 1, 0, 20, false]);
    if (sw) {
        $gameSwitches.setValue(sw, true); // (field Hurting ignores limb-protecting gear)
        // and on that player's own PC: its outfit common event draws the lost
        // limb from its own switch (0.41 play test: the guest kept all four
        // limbs on screen after the cut)
        if (target.ch !== $gamePlayer) $.rherMastermindCmd(target, 121, [sw, sw, 0]);
        $.rherMastermindGab(target, arm ? 'Your arm...!' : 'Your leg...!');
    }
    $.dlog('Mastermind field Hurting hit', $.playerLabel(target.id), 'actor', actor.actorId(), 'limb switch', sw);
    return sw;
};

// Both second limbs gone: CE420 has nothing left and ends the dance - no more
// casts at that player (they repeated every few seconds: 0.41 play test).
$.rherMastermindCanCut = function(target) {
    var actor = $.actorOfPlayer(target.id);
    var limbs = actor && $.LIMB_SWITCHES && $.LIMB_SWITCHES[actor.actorId()] || [];
    return limbs.length >= 4 && !($gameSwitches.value(limbs[1]) && $gameSwitches.value(limbs[3]));
};

$.rherMastermindTargetReady = function(target) {
    // nobody in a fight (its own or one it joined): the form's own fight too
    // (0.41 play test: Hurting went on at Abella through the battle with it)
    var fighting = Object.keys($.battles || {}).some(function(bid) {
        var b = $.battles[bid];
        return b && (b.owner === target.id || (b.joiners || []).indexOf(target.id) >= 0);
    });
    if (fighting) return false;
    if (target.id === 'host') {
        return !$gameParty.inBattle() && !($.bgUpdate && $.bgBattle) && ($.bgUpdate || !$gameMap.isEventRunning());
    }
    return !target.conn || (!target.conn.inBattle && !$.isBusy(target.conn));
};

// The cast's pose: the original's dance (Map080 EV82 pages 2-5 on SW3772,
// one per value of V613 mastermind_dance, which the parallel EV105 steps
// 0, 1, 2, 3, 2, 1 every 7, 7, 7, 7, 4, 4 frames): the sheet's four rows in
// turn, the tentacles writhing (0.41 play test: one still frame was not it).
// Back to sitting (its own stepping) afterwards.
$.RHER_DANCE = [[2, 0, 117], [4, 1, 117], [6, 1, 117], [8, 1, 117], [6, 1, 67], [4, 1, 67]]; // dir, pattern, ms
$.rherMastermindPose = function(ev, dancing) {
    if (!dancing) {
        if (!ev._fhDancing) return;
        ev._fhDancing = 0;
        ev._direction = 2;
        ev._pattern = 1;
        ev._originalPattern = 1;
        ev.setStepAnime(true);
        return;
    }
    if (!ev._fhDancing) {
        ev._fhDancing = $.clockMs();
        ev.setStepAnime(false);
    }
    var loop = 0;
    $.RHER_DANCE.forEach(function(f) { loop += f[2]; });
    var t = ($.clockMs() - ev._fhDancing) % loop;
    for (var i = 0; i < $.RHER_DANCE.length; i++) {
        if (t < $.RHER_DANCE[i][2]) break;
        t -= $.RHER_DANCE[i][2];
    }
    var f = $.RHER_DANCE[Math.min(i, $.RHER_DANCE.length - 1)];
    ev._direction = f[0];
    ev._pattern = f[1];
    ev._originalPattern = f[1];
};

// (every frame on every map: a map without a living Mastermind stops here,
// before the player lists - lag audit 6)
$.rherMastermindHere = function(mapId) {
    var list = $.rherList();
    for (var i = 0; i < list.length; i++) {
        var rec = list[i];
        if (rec.a === 6 && rec.kind === 'boss' && !rec.dead && rec.m === mapId) return true;
    }
    return false;
};

$.rherMastermindUpdate = function() {
    if (!$.runsWorld() || !$gameMap || !$gameMap.mapId() || !$gameSystem || !$gameSystem._fhCoop) return;
    if (!$.rherMastermindHere($gameMap.mapId())) return;
    var candidates = $.humanTargets().filter(function(target) {
        return !$.isDown(target.id) && !!$.actorOfPlayer(target.id) && $.rherMastermindTargetReady(target) &&
            $.rherMastermindCanCut(target);
    });
    $.rherList().forEach(function(rec) {
        if (rec.a !== 6 || rec.kind !== 'boss' || rec.dead || rec.m !== $gameMap.mapId()) return;
        var ev = $gameMap.event(rec.id);
        if (!ev) return;
        var target = $.nearestTarget(ev, candidates);
        var dist = target ? Math.max(Math.abs(ev.x - target.ch.x), Math.abs(ev.y - target.ch.y)) : Infinity;
        if (!target || dist > $.RHER_MASTERMIND_RANGE) {
            if (ev._fhMastermindCast && !ev._fhMastermindCast.hit && target && dist > $.RHER_MASTERMIND_RANGE) {
                $.dlog('Mastermind field Hurting cancelled for', $.playerLabel(ev._fhMastermindCast.id), 'left range');
            }
            ev._fhMastermindCast = null;
            $.rherMastermindPose(ev, false);
            return;
        }
        var cast = ev._fhMastermindCast, now = $.clockMs();
        // the one it saw first stays its target while in range
        if (cast && cast.id !== target.id) {
            var held = candidates.filter(function(t) { return t.id === cast.id; })[0];
            if (held && Math.max(Math.abs(ev.x - held.ch.x), Math.abs(ev.y - held.ch.y)) <= $.RHER_MASTERMIND_RANGE) {
                target = held;
            } else {
                cast = null;
            }
        }
        if (!cast) {
            ev._fhMastermindCast = { id: target.id, at: now, anims: 0, hit: false };
            $.rherMastermindPose(ev, true);
            $.dlog('Mastermind field Hurting started for', $.playerLabel(target.id), 'distance', dist);
            return;
        }
        var t = now - cast.at;
        if (!cast.hit) $.rherMastermindPose(ev, true);
        while (cast.anims < $.RHER_MASTERMIND_ANIM_MS.length && t >= $.RHER_MASTERMIND_ANIM_MS[cast.anims]) {
            cast.anims++;
            $.rherMastermindCmd(target, 212, [-1, 442, false]);
        }
        if (!cast.hit && t >= $.RHER_MASTERMIND_HIT_MS) {
            cast.hit = true;
            cast.limb = $.rherMastermindHit(target, rec);
            $.rherMastermindPose(ev, false);
        }
        // cooldown over: the next cast (the original's loop while the dance is on)
        if (cast.hit && t >= $.RHER_MASTERMIND_HIT_MS + $.RHER_MASTERMIND_COOL_MS) ev._fhMastermindCast = null;
    });
};

$.worldExtras.push(function() { $.rherMastermindUpdate(); });

// Valkyrie's flight, as the original (Map041 EV22 pages on SW1861-1863,
// stepped by the parallel EV26: rows 2, 4, 6, 8, 6, 4 for 12, 5, 8, 10, 4, 4
// frames - the wings beat). The original only flies right to left on
// $valkyrie1; $valkyrie3 is the same bird facing right (Map112 EV40). Going
// left or right picks the sheet; up and down keep the last one.
$.RHER_FLAP = [[2, 200], [4, 83], [6, 133], [8, 167], [6, 67], [4, 67]]; // row, ms
$.RHER_VALKYRIE_SHEETS = { left: '$valkyrie1', right: '$valkyrie3' };
$.rherValkyrieUpdate = function() {
    if (!$gameMap || !$gameMap.mapId() || !$gameSystem || !$gameSystem._fhCoop) return;
    $.rherList().forEach(function(rec) {
        if (rec.a !== 14 || rec.kind !== 'boss' || rec.dead || rec.m !== $gameMap.mapId()) return;
        var ev = $gameMap.event(rec.id);
        if (!ev || ev._pageIndex !== 0) return; // (its corpse page keeps its own picture)
        if (ev._fhLastX !== undefined && ev._x !== ev._fhLastX) ev._fhFacing = ev._x < ev._fhLastX ? 'left' : 'right';
        ev._fhLastX = ev._x;
        var sheet = $.RHER_VALKYRIE_SHEETS[ev._fhFacing || 'left'];
        if (ev._characterName !== sheet) ev._characterName = sheet;
        var loop = 0;
        $.RHER_FLAP.forEach(function(f) { loop += f[1]; });
        var t = $.clockMs() % loop, i = 0;
        while (i < $.RHER_FLAP.length - 1 && t >= $.RHER_FLAP[i][1]) t -= $.RHER_FLAP[i++][1];
        ev._direction = $.RHER_FLAP[i][0];
        ev._pattern = 1;
        ev._originalPattern = 1;
    });
};

$.worldExtras.push(function() { $.rherValkyrieUpdate(); });

// Into this map's data ($dataMap must be that map's).
$.rherEnsureData = function(rec) {
    var events = $dataMap && $dataMap.events;
    if (!events || !rec) return null;
    var have = events[rec.id];
    if (have && have._fhRher === rec.n) return have;
    if (have) return null; // the map's own (never: the id is above them)
    events[rec.id] = $.rherEventData(rec);
    return events[rec.id];
};

$.rherInjectMap = function(mapId) {
    $.rherList().forEach(function(rec) { if (rec.m === mapId) $.rherEnsureData(rec); });
};

var _gameMapSetupRher = Game_Map.prototype.setup;
Game_Map.prototype.setup = function(mapId) {
    if ($gameSystem && $dataMap) $.rherInjectMap(mapId);
    _gameMapSetupRher.call(this, mapId);
    if ($gameSystem) $.rherFixBodies(mapId);
};

// An event of a saved map, a snapshot's or a live one asking for its data
// before the map was set up here (a load, a snapshot): put it in now.
var _gameEventDataRher = Game_Event.prototype.event;
Game_Event.prototype.event = function() {
    var data = _gameEventDataRher.call(this);
    if (data || this._eventId <= $.RHER_EVENT_BASE || !$dataMap || !$gameMap || !$gameSystem) return data;
    if (this._mapId !== $gameMap.mapId() || ($.dataMapId && $.dataMapId !== this._mapId)) return data;
    var rec = $.rherRecord(this._eventId, this._mapId);
    return rec ? $.rherEnsureData(rec) : data;
};

// A killed form shows its body (its self switch A; set again if a world
// without it came in).
$.rherFixBodies = function(mapId) {
    if (!$.runsWorld() && !$.isRoaming()) return;
    $.rherList().forEach(function(rec) {
        if (rec.m === mapId && rec.dead && !$gameSelfSwitches.value([rec.m, rec.id, 'A'])) {
            $gameSelfSwitches.setValue([rec.m, rec.id, 'A'], true);
        }
    });
};

// The forms of this map that are not on it yet (one made just now).
$.rherPlaceAll = function() {
    if (!$gameMap || !$dataMap || !$gameMap.mapId() || !$.worldReady()) return;
    var mapId = $gameMap.mapId();
    $.rherList().forEach(function(rec) {
        if (rec.m !== mapId || $gameMap._events[rec.id]) return;
        $.rherPlace(rec);
    });
    $.rherFixBodies(mapId);
};

$.rherPlace = function(rec) {
    if (!$.rherEnsureData(rec)) return null;
    var was = $.buildingEvents;
    $.buildingEvents = true; // (a thin guest sets its page up once too)
    var ev;
    try {
        ev = new Game_Event(rec.m, rec.id);
    } finally {
        $.buildingEvents = was;
    }
    $gameMap._events[rec.id] = ev;
    var scene = SceneManager._scene;
    var set = scene && scene._spriteset;
    if (set && set._tilemap && set._characterSprites && typeof Sprite_Character !== 'undefined') {
        var sprite = new Sprite_Character(ev);
        set._characterSprites.push(sprite);
        set._tilemap.addChild(sprite);
    }
    return ev;
};

// The form's fight: who started it first, who killed it ----------------------

$.rherTouched = function(interp, n) {
    var by = $.rherPlayerOf(interp);
    if ($.isHost()) $.rherFirst(n, by);
    else if ($.conn) $.conn.send({ t: 'rherTouch', n: n, by: by });
};

$.rherWon = function(interp, n) {
    var by = $.rherPlayerOf(interp);
    if ($.isHost()) {
        $.rherKilled(n, by);
        return;
    }
    var rec = $.rherRecordN(n);
    if (rec && rec.m === $gameMap.mapId()) $gameSelfSwitches.setValue([rec.m, rec.id, 'A'], true);
    if ($.conn) $.conn.send({ t: 'rherKill', n: n, by: by });
};

// A player id a guest's PC sent: one the host knows, else that guest.
$.rherSender = function(conn, id) {
    return id === 'host' || (id && $.clientById(id)) ? id : conn.guestId;
};

$.hostHandlers.rherTouch = function(conn, msg) {
    $.rherFirst(Number(msg.n), $.rherSender(conn, msg.by));
};

$.hostHandlers.rherKill = function(conn, msg) {
    $.rherKilled(Number(msg.n), $.rherSender(conn, msg.by));
};

$.rherFirst = function(n, by) {
    var rec = $.rherRecordN(n);
    var name = $.nameOf(by);
    if (!rec || rec.dead || rec.first || !name) return;
    rec.first = name;
    $.dlog('Eye of Rher: the first fight with form', n, 'was', $.playerLabel(by));
    $.rherBroadcast();
};

$.rherKilled = function(n, by) {
    var rec = $.rherRecordN(n);
    if (!rec || rec.dead || rec.kind !== 'boss') return;
    rec.dead = true;
    $gameSelfSwitches.setValue([rec.m, rec.id, 'A'], true);
    $.rherKillSwitches(rec);
    var dead = $.coopDead();
    var taker = rec.first && !dead[rec.first] ? rec.first : ($.nameOf(by) || rec.first);
    var bag = $.rherTakeBelongings(rec);
    var who = $dataActors[rec.a] ? $dataActors[rec.a].name : 'the dead';
    var form = $.rherForm(rec.a, rec);
    $.dlog('Eye of Rher: form', n, 'killed by', $.playerLabel(by), '- the belongings go to', taker);
    if (taker) $.rherOwe(taker, bag, who);
    $.rherBroadcast();
    $.broadcastToast('The ' + form.name + ' (' + who + ') is dead.');
};

// Its SOUL goes on in rherKillSwitches: the one its belongings go to (the
// first to fight it, else the killer) has the soul ($.soulGained).
var _rherKilledSoul = $.rherKilled;
$.rherKilled = function(n, by) {
    var rec = $.rherRecordN(n), dead = $.coopDead();
    var taker = rec ? (rec.first && !dead[rec.first] ? rec.first : ($.nameOf(by) || rec.first)) : null;
    $.soulCauseId = $.playerIdOfName(taker) || by || null;
    try {
        _rherKilledSoul(n, by);
    } finally {
        $.soulCauseId = null;
    }
};

// Field guns on a form (user request 2026-11-07): a bullet (FH_CoopWorld
// "Field guns") reaching a form's event hurts it as the original's
// arrow_check hurts that enemy: a rifle +2 (with Marksmanship 1 in 4 at once,
// where the original has it), a shotgun +3, a pistol +1; at its count or
// more the next shot brings it down (the original's checks: Big boy 10,
// Giant 10, Mastermind 8, Judgement/Mechanical dance 14, Moonscorched 3).
// Weeping scope, Cocoon and Valkyrie are never shot in the original: counts
// of our own. The tower's Pocketcat is not shot (user 2026-11-07: an NPC -
// no count, the bullet goes by). Brought down = killed in a fight ($.rherKilled:
// the belongings, the soul, the switches); no Eye of Rher reset (the
// original's shot down has no CE547 either).
$.RHER_SHOT_HP = {
    'Chaugnar': 10, 'Giant': 10, 'Mastermind': 8, 'Mechanical dance': 14, 'Moonscorched': 3,
    'Weeping scope': 10, 'Cocoon': 8, 'Valkyrie': 10
};
$.RHER_SHOT_CRIT = { 'Chaugnar': true, 'Mastermind': true, 'Moonscorched': true };
$.RHER_SHOT_DAMAGE = { rifle: 2, shotgun: 3, pistol: 1 };
$.RHER_SHOT_ANIM = 18;

$.rherShotCheck = function() {
    var b = $.bullet;
    if (!b) return;
    if (b.mapId !== $gameMap.mapId() || !$.BULLET_SWITCHES.some(function(id) { return $gameSwitches.value(id); })) {
        if (!$.runsWorld()) $.bullet = null; // (the host's: the players' check above ends it)
        return;
    }
    var ev = $gameMap.event(b.eventId);
    if (!ev) return;
    var rec = $.rherList().filter(function(r) {
        var e = r.m === b.mapId && r.kind === 'boss' && !r.dead && $.RHER_SHOT_HP[$.rherForm(r.a, r).name] ?
            $gameMap.event(r.id) : null;
        return e && e.x === ev.x && e.y === ev.y;
    })[0];
    if (!rec) return;
    $.bullet = null;
    $.BULLET_SWITCHES.forEach(function(id) { $gameSwitches.setValue(id, false); });
    var crit = b.gun === 'rifle' && !!b.marks && Math.randomInt(4) === 0;
    var target = $gameMap.event(rec.id);
    if (target) target.requestAnimation($.RHER_SHOT_ANIM);
    if ($.isHost()) $.rherShot(rec.n, b.shooter, b.gun, crit);
    else if ($.conn) {
        // (a sub-host's guest shot it: the host credits that guest - isHost audit 2026-11-10)
        var by = $.subHosting() && b.shooter && b.shooter !== 'host' ? b.shooter : undefined;
        $.conn.send({ t: 'rherShot', n: rec.n, gun: b.gun, crit: crit, by: by });
    }
};
$.worldExtras.push($.rherShotCheck);

// A guest alone on the map it runs: FH_CoopWorld keeps no bullet there (its
// world extras run only with guests of its own); its own shot, here.
$.rherLoneRoamer = function() {
    return $.role && $.isGuest() && $.isRoaming() && !($.runsWorld() && $.clients.length);
};

var _swSetRherShot = Game_Switches.prototype.setValue;
Game_Switches.prototype.setValue = function(id, value) {
    if (value && this === $gameSwitches && $.BULLET_SWITCHES.indexOf(id) >= 0 && !this._data[id] && $.lastLocated &&
            $.rherLoneRoamer()) {
        $.bullet = {
            eventId: $.lastLocated, shooter: 'host', // (its gun: the EQUIPPED switches, RIFLE / SHOTGUN)
            gun: this._data[2252] ? 'rifle' : this._data[2253] ? 'shotgun' : 'pistol',
            x0: $gamePlayer.x, y0: $gamePlayer.y, mapId: $gameMap.mapId(), marks: !!this._data[731]
        };
    }
    _swSetRherShot.call(this, id, value);
};

var _sceneMapUpdateRherShot = Scene_Map.prototype.update;
Scene_Map.prototype.update = function() {
    _sceneMapUpdateRherShot.call(this);
    if ($.bullet && $.rherLoneRoamer()) $.rherShotCheck();
};

$.hostHandlers.rherShot = function(conn, msg) {
    var gun = $.RHER_SHOT_DAMAGE[msg.gun] ? msg.gun : 'pistol';
    var sub = msg.by && $.clientById(msg.by);
    var by = sub && sub.subOf === conn.guestId ? sub.guestId : conn.guestId; // (only its own sub-guest)
    $.rherShot(Number(msg.n), by, gun, !!msg.crit, true);
};

// (host) a shot of that player at form n; mine: its PC played the animation
$.rherShot = function(n, by, gun, crit, theirs) {
    var rec = $.rherRecordN(n);
    if (!rec || rec.dead || rec.kind !== 'boss') return;
    var form = $.rherForm(rec.a, rec);
    var hp = $.RHER_SHOT_HP[form.name];
    if (!hp) return;
    var down = (rec.shot || 0) >= hp || (crit && !!$.RHER_SHOT_CRIT[form.name]);
    // the guests on the host's map see it hit (the shooter's PC if it did not)
    if (rec.m === $gameMap.mapId()) {
        $.activeGuests().forEach(function(c) {
            if ((theirs && c.guestId === by) || !$.guestOnMap(c)) return;
            c.send({ t: 'cmd', c: 212, p: [rec.id, $.RHER_SHOT_ANIM, false] });
        });
    }
    if (!down) {
        rec.shot = (rec.shot || 0) + ($.RHER_SHOT_DAMAGE[gun] || 1);
        $.dlog('Eye of Rher: form', n, 'shot by', $.playerLabel(by), gun, '-', rec.shot, 'of', hp);
        $.gunGab(by, 'You shoot the ' + form.name + '!');
        $.rherBroadcast();
        return;
    }
    $.dlog('Eye of Rher: form', n, 'shot down by', $.playerLabel(by), gun, crit ? '(at once)' : '');
    $.gunGab(by, 'The ' + form.name + ' is shot down!');
    // (the original's soul line, to the shooter when its belongings go to it -
    // the one who fought it first takes them, as in $.rherKilled)
    var first = rec.first && !$.coopDead()[rec.first] ? rec.first : null;
    $.rherKilled(n, by);
    if (form.soul && (!first || first === $.nameOf(by))) $.gunGab(by, 'You absorbed the \\c[2]' + form.soul[2] + ' soul\\c[0].');
};

// User decision (2026-10-23): killing a player's form is killing that
// character's moonscorched self. The world gets what the original's win over
// that form gives (RHER_FORMS kill / v: the body pages of its own map, the
// temple square, the ending maps), and its SOUL and <name>1 if still off.
// CHARACTERS_LEFT is not taken again: the player's death did that.
$.rherKillSwitches = function(rec) {
    var form = $.rherForm(rec.a, rec);
    var on = [];
    (form.kill || []).concat([$.RHER_SOUL_SWITCH[rec.a], $.DEATH_SWITCH && $.DEATH_SWITCH[rec.a]]).forEach(function(id) {
        if (!id || $gameSwitches.value(id)) return;
        $gameSwitches.setValue(id, true);
        on.push(id);
    });
    (form.v || []).forEach(function(set) {
        $gameVariables.setValue(set[0], set[1]);
    });
    $.dlog('Eye of Rher: form', rec.n, '(' + form.name + ') killed - switches on:', on.join(',') || 'none',
        (form.v || []).length ? '- variables: ' + JSON.stringify(form.v) : '');
};

// The dead player's bag and equipment (the host's copy), taken out.
$.rherTakeBelongings = function(rec) {
    var bag = { i: {}, w: {}, a: {}, g: 0 };
    var take = function(src, k) {
        Object.keys(src || {}).forEach(function(id) {
            var n = Number(src[id]) || 0;
            if (n > 0) bag[k][id] = (bag[k][id] || 0) + n;
            delete src[id];
        });
    };
    if (rec.who === '#host') {
        var own = $.ctx && $.ctxSave ? $.ctxSave : null;
        take(own ? own.items : $gameParty._items, 'i');
        take(own ? own.weapons : $gameParty._weapons, 'w');
        take(own ? own.armors : $gameParty._armors, 'a');
        if (own) {
            bag.g = own.gold || 0;
            own.gold = 0;
        } else {
            bag.g = $gameParty._gold || 0;
            $gameParty._gold = 0;
        }
    } else {
        var inv = $.guestInventory(rec.who);
        take(inv.i, 'i');
        take(inv.w, 'w');
        take(inv.a, 'a');
        bag.g = Number(inv.g) || 0;
        inv.g = 0;
    }
    var actor = $gameActors.actor(rec.a);
    if (actor) {
        actor.equips().forEach(function(item, slot) {
            if (!item) return;
            var k = DataManager.isWeapon(item) ? 'w' : 'a';
            bag[k][item.id] = (bag[k][item.id] || 0) + 1;
            actor._equips[slot].setObject(null);
        });
        actor.refresh();
    }
    return bag;
};

// Belongings owed to a player: given where that player's bag is now -----------

$.rherOwe = function(name, bag, from) {
    var owed = $.rherData().owed;
    owed[name] = (owed[name] || []).concat([{ bag: bag, from: from }]);
    $.rherDeliver();
};

$.rherBagEmpty = function(bag) {
    return !bag.g && ['i', 'w', 'a'].every(function(k) { return !Object.keys(bag[k] || {}).length; });
};

$.rherAddBag = function(inv, bag) {
    ['i', 'w', 'a'].forEach(function(k) {
        inv[k] = inv[k] || {};
        Object.keys(bag[k] || {}).forEach(function(id) {
            var n = Math.max(0, Math.floor(Number(bag[k][id]) || 0));
            if (n) inv[k][id] = (inv[k][id] || 0) + n;
        });
    });
    inv.g = (Number(inv.g) || 0) + Math.max(0, Math.floor(Number(bag.g) || 0));
};

$.rherLootText = function(from) {
    return 'Co-op: you took ' + from + '\'s belongings.';
};

$.rherDeliver = function() {
    // not inside a guest's context (a thin guest's kill runs in it): leaving
    // it writes the party's gold back over that guest's bag. Next world frame.
    if (!$.isHost() || $.ctx) return;
    var owed = $.rherData().owed;
    Object.keys(owed).forEach(function(name) {
        var gifts = owed[name] || [];
        if (!gifts.length) {
            delete owed[name];
            return;
        }
        if (name === '#host') {
            gifts.forEach(function(g) { $.rherGiveHost(g); });
            delete owed[name];
            return;
        }
        var c = $.clients.filter(function(x) { return x.name === name && !x._sub; })[0];
        if (!c) {
            gifts.forEach(function(g) { $.rherAddBag($.guestInventory(name), g.bag); });
            $.dlog('Eye of Rher: belongings into the saved bag of', name, '(not here)');
            delete owed[name];
            return;
        }
        if (!c.actorId || !c.inGame || c.solo || c.inBattle) return;
        var wait = (gifts[0].wait || 0) - $.clockMs();
        if (wait > 0 && wait <= $.SOUL_RETRY_MS) return;
        if (c.subOf) {
            var owner = $.clientById(c.subOf);
            if (!owner) return;
            gifts.forEach(function(g) { owner.send({ t: 'subRherLoot', who: c.guestId, bag: g.bag, from: g.from }); });
        } else if (c.roam) {
            gifts.forEach(function(g) { c.send({ t: 'rherLoot', bag: g.bag, from: g.from }); });
        } else {
            var inv = $.inventoryOf(c);
            gifts.forEach(function(g) {
                $.rherAddBag(inv, g.bag);
                c.send({ t: 'toast', text: $.rherLootText(g.from) });
            });
            c._lastMeKey = null;
            $.pushMe(c);
        }
        $.dlog('Eye of Rher: belongings for', c.name, c.subOf ? '(on a sub-host)' : c.roam ? '(its own PC)' : '');
        delete owed[name];
    });
};

$.worldExtras.push(function() {
    if (!$.isHost()) return;
    var d = $.coopData().rher;
    if (d && d.owed && Object.keys(d.owed).length) $.rherDeliver();
});

$.rherGiveHost = function(g) {
    var own = $.ctx && $.ctxSave ? $.ctxSave : null;
    var inv = own ? { i: own.items, w: own.weapons, a: own.armors, g: own.gold } :
        { i: $gameParty._items, w: $gameParty._weapons, a: $gameParty._armors, g: $gameParty._gold };
    $.rherAddBag(inv, g.bag);
    if (own) own.gold = inv.g; else $gameParty._gold = Math.min(inv.g, $gameParty.maxGold());
    if (!$.rherBagEmpty(g.bag)) $.toast($.rherLootText(g.from));
};

$.rherOweAgain = function(c, bag, from) {
    if (!c || !bag) return;
    var owed = $.rherData().owed;
    owed[c.name] = (owed[c.name] || []).concat([{ bag: bag, from: String(from || ''), wait: $.clockMs() + $.SOUL_RETRY_MS }]);
};

$.hostHandlers.rherLootBack = function(conn, msg) {
    $.rherOweAgain(conn, msg.bag, msg.from);
};

$.hostHandlers.subRherLootBack = function(conn, msg) {
    $.rherOweAgain($.clientById(msg.who), msg.bag, msg.from);
};

// Guest running its own map: its bag is here.
$.rherLootLater = [];
$.guestHandlers.rherLoot = function(msg) {
    if ($.pendingRoam) {
        $.rherLootLater.push(msg);
        return;
    }
    $.rherTakeLoot(msg);
};

$.rherTakeLoot = function(msg) {
    if (!msg || !msg.bag || !$.conn) return;
    if (!$.isRoaming() || $.roam.leaving || $.pendingSnapshot) {
        $.conn.send({ t: 'rherLootBack', bag: msg.bag, from: msg.from });
        return;
    }
    var inv = { i: $gameParty._items, w: $gameParty._weapons, a: $gameParty._armors, g: $gameParty._gold };
    $.rherAddBag(inv, msg.bag);
    $gameParty._gold = Math.min(inv.g, $gameParty.maxGold());
    $.toast($.rherLootText(msg.from));
    if ($.sendRoamMe) $.sendRoamMe(true);
};

var _startRoamRher = $.startRoam;
$.startRoam = function(msg) {
    _startRoamRher(msg);
    var later = $.rherLootLater;
    $.rherLootLater = [];
    later.forEach($.rherTakeLoot);
};

// Sub-host: one of its guests' bags is here.
$.guestHandlers.subRherLoot = function(msg) {
    var v = $.clientById(msg.who);
    if (!$.conn) return;
    if (!v || !v._sub) {
        $.conn.send({ t: 'subRherLootBack', who: msg.who, bag: msg.bag, from: msg.from });
        return;
    }
    $.rherAddBag($.inventoryOf(v), msg.bag || {});
    v._lastMeKey = null;
    $.pushMe(v);
    $.sendSubMe(v, false);
    v.send({ t: 'toast', text: $.rherLootText(msg.from) });
};

// Daan's Pocketcat: hands over the dead Daan player's keys --------------------
// User request 2026-11-02: Daan hit by the moon's beam stands as the Pocketcat
// NPC, with no fight to win his bag from. Talked to, it hands over the keys
// Daan had (KEY_ITEMS, from his bag on the host: the one who talked, once) and
// is gone a second later (its self switch A, an empty page: for everyone, in
// the save). Its lines are its own, in the wiki's voice of Pocketcat
// (theatrical, "old sport", the little eavesdropper, stretched words).
$.RHER_CAT_HEAD = '\\>\\i[144]\\}OCKETCAT\\{\\<'; // (the museum Pocketcat's name line)
$.RHER_CAT_LINES = [
    ['"Oh-ho! If it isn\'t my favorite little eavesdropper!"'],
    ['"I\'ve been keeping these warm for you. Ssssomething tells me',
        'you\'ll be needing them more than the old me ever will..."'],
    ['"Ain\'t that a pickle to suckle on? Off you go, old sport."']
];
$.RHER_CAT_KEYS_TEXT = 'Pocketcat hands you the keys %1 had.';
$.RHER_CAT_EMPTY_TEXT = 'Pocketcat\'s paws are empty...';
$.RHER_CAT_GONE_WAIT = 60; // frames: gone a second after the keys

$.rherCatList = function(n) {
    var list = [];
    $.RHER_CAT_LINES.forEach(function(box) {
        list.push($.rherCmd(101, ['', 0, 0, 2]), $.rherCmd(401, [$.RHER_CAT_HEAD]));
        box.forEach(function(t) { list.push($.rherCmd(401, [t])); });
    });
    return list.concat([
        $.rherCmd(355, ['FH.Coop.rherCatGive(this, ' + n + ');']),
        $.rherCmd(230, [$.RHER_CAT_GONE_WAIT]),
        $.rherCmd(355, ['FH.Coop.rherCatGone(this, ' + n + ');']),
        $.rherCmd(0, [])
    ]);
};

$.rherCatTalk = function(interp) {
    var rec = $.rherRecord(interp._eventId, interp._mapId);
    if (!rec || rec.dead) return;
    interp.setupChild($.rherCatList(rec.n), interp._eventId);
};

// The one who talked: in a guest's context that guest (also a sub-host's).
$.rherCatGive = function(interp, n) {
    var who = $.ctx && $.ctx.name ? $.ctx.name : '';
    if ($.isHost()) $.rherCatGiveHost(n, who || $.nameOf('host'));
    else if ($.conn) $.conn.send({ t: 'rherCatGive', n: n, who: who });
};

// Host: Daan's keys into a parcel for that player (deliverInherit).
$.rherCatGiveHost = function(n, who) {
    var rec = $.rherRecordN(n);
    if (!rec || rec.kind !== 'npc' || rec.given || !who || who === rec.who) return;
    rec.given = true;
    var gift = $.emptyGift();
    $.takeKeys(rec.who, gift);
    var label = $dataActors[rec.a] ? $dataActors[rec.a].name : rec.who;
    $.dlog('Eye of Rher: Pocketcat', n, 'hands', label + '\'s keys to', who, ':', JSON.stringify(gift.i));
    $.clients.forEach(function(c) {
        if (c.name === rec.who && c.actorId) {
            c._menuBase = null;
            c._lastMeKey = null;
            $.pushMe(c);
        }
    });
    if (!$.giftSize(gift)) {
        $.bodyTell(who, $.RHER_CAT_EMPTY_TEXT);
        return;
    }
    var data = $.coopData();
    data.parcels = data.parcels || [];
    data.parcels.push({ id: $.newInheritId(), to: who, gift: gift, line: true, text: $.RHER_CAT_KEYS_TEXT.replace('%1', label) });
};

$.hostHandlers.rherCatGive = function(conn, msg) {
    if (!conn || !conn.name || !msg) return;
    var who = conn.name;
    if (msg.who && msg.who !== conn.name) {
        var v = $.clients.filter(function(c) { return c.name === msg.who && c.subOf === conn.guestId; })[0];
        if (!v) return;
        who = v.name;
    }
    $.rherCatGiveHost(Number(msg.n), who);
};

$.rherCatGone = function(interp, n) {
    var rec = $.rherRecordN(n);
    if (rec && rec.m === $gameMap.mapId()) $gameSelfSwitches.setValue([rec.m, rec.id, 'A'], true);
    if ($.isHost()) $.rherCatGoneHost(n);
    else if ($.conn) $.conn.send({ t: 'rherCatGone', n: n });
};

$.rherCatGoneHost = function(n) {
    var rec = $.rherRecordN(n);
    if (!rec || rec.kind !== 'npc' || rec.dead) return;
    rec.dead = true; // (rherFixBodies keeps it gone on every visit)
    $gameSelfSwitches.setValue([rec.m, rec.id, 'A'], true);
    $.dlog('Eye of Rher: Pocketcat', n, 'is gone');
    $.rherBroadcast();
};

$.hostHandlers.rherCatGone = function(conn, msg) {
    if (msg) $.rherCatGoneHost(Number(msg.n));
};

//=============================================================================
// Screen left dark (0.38.3-pre5)
//=============================================================================
// A dark screen with nothing running is never the game's own look (data:
// the only near-black tints are -255 and one -221, all transitions). Two
// safety nets besides the undone game over flows (FH_CoopBattle):
// - This PC's own screen (the host, a guest running its own map): for a
//   while after a down, a load or a new own-map world, a black tint or a
//   fade out that stays once no event and no message runs (1 s) goes back
//   to the plain look. (The host's black after a fight was even saved, and
//   loading that save kept it black.)
// - A thin guest: its screen is the host's look plus what its own events
//   send it (tints, fades). Dark while the host's is not, with no event of
//   its own running for 3 s (1 s right after its own down): the host's look
//   again. (The ladder: EV108 tinted the guest black, the restoring parallel
//   EV87 ran for the host; loading a save was the only way out.)
$.SCREEN_FIX_HOLD_MS = 1000;
$.THIN_SCREEN_FIX_MS = 3000;
$.THIN_SCREEN_FAST_MS = 1000;

// Dark now and not on its way back (a fade in or a tint to a light tone).
// (White counts too: the dream's way out left on the screen, 0.4.)
$.screenIsDark = function(sc) {
    if (!sc) return false;
    var tone = $.isOffTone(sc._tone) && !(sc._toneDuration > 0 && !$.isOffTone(sc._toneTarget));
    var faded = sc._brightness < 128 && !(sc._fadeInDuration > 0);
    return tone || faded;
};

// Why a dark screen may be meant now ('' = nothing: it is left over).
$.screenFixBusy = function() {
    var scene = SceneManager._scene;
    if (!$gameMap || !$gameScreen || !$gamePlayer || !(scene instanceof Scene_Map) || SceneManager.isSceneChanging()) {
        return 'scene';
    }
    if ($gameParty.inBattle() || $.puppet || $.localBattle) return 'battle';
    if ($gameMap.isEventRunning() || $gameMessage.isBusy()) return 'event';
    if ($.duelIntro) return 'duel';
    if ($.DREAM_MAPS[$gameMap.mapId()]) return 'dream';
    if ($gamePlayer.isTransparent()) return 'hidden'; // (lying in bed for the sleep, a scene)
    if ($.pendingSnapshot || $.pendingRoam || ($.roam && $.roam.leaving)) return 'world coming';
    if ($.isGuest() && $.myEventRunning) return 'its event';
    if (!$.isThin() && $gameSwitches.value($.SLEEPING_SWITCH)) return 'asleep';
    if ($.darkParallelRuns()) return 'parallel';
    return '';
};

// A parallel event or common event that made the screen dark itself and
// still runs: that dark is meant (CE108 BLINDNESS tints black again every
// second while SW816 is on; the hunger common events before a starvation;
// Map016 EV354 fades the player in and out). "Event running" never counts
// parallels: the screen fix lit a blind player's screen up every 2 s.
var _setupDarkParallel = Game_Interpreter.prototype.setup;
Game_Interpreter.prototype.setup = function(list, eventId) {
    _setupDarkParallel.call(this, list, eventId);
    this._fhDarkTint = false;
};

$.markParallelDark = function(interp, dark) {
    if ($.parallelDepth || $.mapParallelDepth) interp._fhDarkTint = dark;
};

var _command221DarkParallel = Game_Interpreter.prototype.command221;
Game_Interpreter.prototype.command221 = function() {
    $.markParallelDark(this, true);
    return _command221DarkParallel.call(this);
};

var _command222DarkParallel = Game_Interpreter.prototype.command222;
Game_Interpreter.prototype.command222 = function() {
    $.markParallelDark(this, false);
    return _command222DarkParallel.call(this);
};

var _command223DarkParallel = Game_Interpreter.prototype.command223;
Game_Interpreter.prototype.command223 = function() {
    $.markParallelDark(this, $.isOffTone(this._params[0]));
    return _command223DarkParallel.call(this);
};

$.darkParallelRuns = function() {
    var runs = function(interp) {
        for (var i = interp; i; i = i._childInterpreter) {
            if (i._fhDarkTint && i.isRunning()) return true;
        }
        return false;
    };
    var ces = ($gameMap && $gameMap._commonEvents) || [];
    for (var k = 0; k < ces.length; k++) {
        if (ces[k] && ces[k]._interpreter && runs(ces[k]._interpreter)) return true;
    }
    var evs = $gameMap ? $gameMap.events() : [];
    for (k = 0; k < evs.length; k++) {
        if (evs[k]._interpreter && runs(evs[k]._interpreter)) return true;
    }
    return false;
};

$.updateScreenFix = function() {
    var w = $.screenFix;
    if (!w || $.isThin()) return;
    var now = $.clockMs();
    if (now > w.until) {
        $.screenFix = null;
        return;
    }
    if (!$.screenIsDark($gameScreen) || $.screenFixBusy()) {
        w.since = 0;
        return;
    }
    if (!w.since) {
        w.since = now;
        return;
    }
    if (now - w.since < $.SCREEN_FIX_HOLD_MS) return;
    w.since = 0;
    var before = $.screenWatchLine();
    var done = $.screenBackFrom(null);
    $.dlog('screen fix (' + w.why + '): dark with nothing running -', before, '->', done.join(', '));
};

// Thin guest: the host's screen as last sent.
$.lastHostScr = null; // { t, b }
$.thinScreen = { since: 0, fastUntil: 0 };

var _applyScreenLast = $.applyScreen;
$.applyScreen = function(scr) {
    $.noteHostScr(scr);
    _applyScreenLast(scr);
};

// (also a resync's screen kept off while its own event runs: FH_Coop)
$.noteHostScr = function(scr) {
    if (scr && Array.isArray(scr.t)) $.lastHostScr = { t: scr.t.slice(), b: Number(scr.b) };
};

var _processPendingSnapshotScr = $.processPendingSnapshot;
$.processPendingSnapshot = function() {
    var had = !!$.pendingSnapshot;
    _processPendingSnapshotScr();
    if (had && $gameScreen && $.isThin()) {
        $.lastHostScr = { t: $gameScreen.tone().slice(), b: Math.round($gameScreen.brightness()) };
        $.thinScreen.since = 0;
    }
};

var _scrFixLast = $.guestHandlers.scrFix;
$.guestHandlers.scrFix = function(msg) {
    if (msg && Array.isArray(msg.tone)) $.lastHostScr = { t: msg.tone.slice(), b: typeof msg.b === 'number' ? msg.b : 255 };
    _scrFixLast(msg);
};

$.resyncScreenFromHost = function(why) {
    var host = $.lastHostScr, sc = $gameScreen;
    if (!host || !sc) return false;
    var before = $.screenWatchLine();
    sc.startTint(host.t.slice(), 30);
    sc._brightness = isNaN(host.b) ? 255 : host.b;
    sc._fadeOutDuration = 0;
    sc._fadeInDuration = 0;
    $.dlog('screen back to the host\'s (' + why + '):', before, '-> tone', JSON.stringify(host.t), 'brightness',
        sc._brightness);
    return true;
};

$.updateThinScreenFix = function() {
    if (!$.isGuest() || !$.isThin() || !$.lastHostScr || !$gameScreen) return;
    var t = $.thinScreen, now = $.clockMs(), host = $.lastHostScr;
    var hostDark = $.isOffTone(host.t) || host.b < 128;
    if (hostDark || !$.screenIsDark($gameScreen) || $.screenFixBusy()) {
        t.since = 0;
        return;
    }
    if (!t.since) {
        t.since = now;
        return;
    }
    var hold = now < t.fastUntil ? $.THIN_SCREEN_FAST_MS : $.THIN_SCREEN_FIX_MS;
    if (now - t.since < hold) return;
    t.since = 0;
    $.resyncScreenFromHost('dark with no event of its own for ' + (hold / 1000) + ' s');
};

// its own down: a game over flow's tint (CE47 / CE359 in its event on the
// host, CE500 in its fight) goes sooner
var _pstateScreenFix = $.guestHandlers.pstate;
$.guestHandlers.pstate = function(msg) {
    _pstateScreenFix(msg);
    if ($.isGuest() && msg && msg.id === $.myId && msg.s === 'down') $.thinScreen.fastUntil = $.clockMs() + 60000;
};

var _sceneMapUpdateScreenFix = Scene_Map.prototype.update;
Scene_Map.prototype.update = function() {
    _sceneMapUpdateScreenFix.call(this);
    try {
        $.updateScreenFix();
        $.updateThinScreenFix();
    } catch (e) {
        $.dlog('ERROR screen fix', e.stack || String(e));
    }
};

// A load (a co-op save: one made black stays black otherwise) and a new
// world of its own map open the window.
var _loadGameScreenFix = DataManager.loadGame;
DataManager.loadGame = function(savefileId) {
    var ok = _loadGameScreenFix.call(this, savefileId);
    if (ok && $gameSystem && $gameSystem._fhCoop) $.openScreenFix('load', 10000);
    return ok;
};

var _startRoamScreenFix = $.startRoam;
$.startRoam = function(msg) {
    _startRoamScreenFix(msg);
    $.openScreenFix('own map', 10000);
    // the host's view it waited to show is not this PC's game now
    $.droppedScr = null;
    $.fadeQueue = null;
    $.resyncAfterFight = false;
    $.resyncAskDue = null;
};

// More moments that leave a dark (or white) screen behind with nothing to
// lift it on this PC (docs/조사(보관용)/검수/최종검토_D 3): waking up (out of the dream
// maps), the way back from a fight, a ladder (SW203 CLIMBING / SW241
// coming_UP_LADDERS change: EV108's black and the parallel EV87 that tints it
// back). A thin guest has its own net (updateThinScreenFix) at all times.
$.SCREEN_FIX_EVENT_MS = 10000;

var _setupScreenFixWake = Game_Map.prototype.setup;
Game_Map.prototype.setup = function(mapId) {
    var from = this._mapId;
    _setupScreenFixWake.call(this, mapId);
    if ($.role && $.DREAM_MAPS[from] && !$.DREAM_MAPS[mapId]) $.openScreenFix('wake', $.SCREEN_FIX_EVENT_MS);
};

var _sceneBattleTerminateScreenFix = Scene_Battle.prototype.terminate;
Scene_Battle.prototype.terminate = function() {
    _sceneBattleTerminateScreenFix.call(this);
    if ($.role) $.openScreenFix('battle', $.SCREEN_FIX_EVENT_MS);
};

$.LADDER_SWITCHES = { 203: true, 241: true };
var _swSetScreenFixLadder = Game_Switches.prototype.setValue;
Game_Switches.prototype.setValue = function(id, value) {
    var watch = $.LADDER_SWITCHES[id] && this === $gameSwitches && $.role && !$.ctx;
    var before = watch && !!this._data[id];
    _swSetScreenFixLadder.call(this, id, value);
    if (watch && before !== !!this._data[id]) $.openScreenFix('ladder', $.SCREEN_FIX_EVENT_MS);
};

// The host's world coming in: a screen dropped before it is older than it.
var _snapDroppedScr = $.guestHandlers.snap;
$.guestHandlers.snap = function(msg) {
    $.droppedScr = null;
    return _snapDroppedScr(msg);
};

//=============================================================================
// Fixed fights: one in the world, a lost one goes back to before its trigger
//=============================================================================
// User decisions (2026-10-22, docs/조사(보관용)/문리스_난입.md, 보스전_목록.md). A map
// event's own fight (a page with a Battle Processing: the Moonless beast,
// Map092 EV105 page 2 on V2054, Kaiser, Logic, the Ratkin gang, Father Hugo,
// an enemy's touch page) is the same fight for everyone:
// 1. One in the world. While a player runs that page (its scene, its fight,
//    its scene after the fight), nobody else starts it: the PC running the
//    page tells the host (fixedOn / fixedOff), the host keeps the list
//    ($.fixedHolds) and every PC running a map has it, so the page does not
//    start even on the frame the map loads (the host came onto Map092 while
//    a roaming guest fought the beast there: a second beast, a second Black
//    steel). A fight on the host's map was held already (a guest's event is
//    its own, a frozen enemy is joined).
// 2. A loss (a co-op down: the event stops) rolls the scene back to before
//    the player's action that set it off: every switch, variable and self
//    switch the scene wrote (the trigger line, the autorun pages after it,
//    the fight page up to the Battle Processing: Kaiser's August cut-in takes
//    CHARACTERS_LEFT down before the fight) and the items and gold it gave or
//    took (the Heartless one's offering) go back. The page is off, its
//    trigger is armed again; whoever steps on it next fights it again, the
//    same way. Only when that is safe: the scene started with a player's
//    action on this map (touch or OK), it changed nobody's party, no fight
//    of it was fought before this one (the Sylvian trooper before the
//    Platoon), the trigger's page comes back and the fight's page goes off.
//    Otherwise the page waits until the player who lost it stands up again
//    (it used to open again right away on the downed player's PC).
// 3. (FH_CoopWorld "Autorun pages a guest's event set off") a guest who sets
//    off such an autorun page on the host's map fights it on its own PC.
//
// A scene is a chain: a page a player starts (touch, OK) begins one; an
// autorun or parallel page whose conditions the newest chain wrote belongs
// to that chain; common events it calls belong to it too.

$.fxStack = [];         // interpreters executing a command right now (innermost last)
$.fxChains = {};        // chain id ('<pc>#<n>') -> { n, m, e, p (trigger page), who, before: { key: value }, items, gold, dirty, fights }
$.fxChainOrder = [];
$.fxChainSeq = 0;
$.fxRunTag = Date.now().toString(36); // (an id saved with an interpreter is not one of this run's)
$.fxKeyChain = {};      // 'sw:id' | 'v:id' | 'ss:m,e,ch' -> the chain that wrote it last
$.FX_CHAIN_KEEP = 40;
$.fxQuiet = false;      // a rollback writing: no chain records it
$.fxToldBlocked = '';
$.fixedHolds = {};      // 'map,event' -> { id: who runs it, by: the PC running it, p, down }
$.fxVer = 0;
$.fxLocalDown = {};     // roaming guest: 'map,event' -> lost here, no rollback (until that player stands up)
$.fxFightInterp = null; // the interpreter of this PC's newest fight
// Never rolled back (user decision 2026-10-22: left as they are): the tower
// gate chain takes the companions out of the party one by one before each
// fight (Map111 EV617).
$.FX_NO_ROLLBACK = { '111,617': 'the tower gate chain' };
// A page joins a chain only while that chain runs or wrote a moment ago (real
// time): a page turned on minutes later by something else is not that scene.
$.FX_CHAIN_MS = 5000;
// The common events every fight calls (CE74 BEFORE BATTLE, CE66 AFTER BATTLE)
// and the party counts: their writes (SW16, SW17, V990 ...) tie nothing
// together and are not rolled back (a lost fight left them as before 0.40 ③).
$.FX_GENERIC_CES = { 49: true, 50: true, 66: true, 74: true };
// The day goes on (CE303 DAYS_GO_BY, CE305 WakeUP): a scene with it (a bed,
// its night ambush: Map020 EV191 page 4, Map005 EV114 page 5) is never rolled
// back - the sleep and the new day stay (the loser's wait instead).
$.FX_TIME_CES = { 303: true, 305: true };
$.FX_SLEEP_SWITCH = 463;
$.fxBattle = null;      // this PC's fixed fight running now: { fx, vars: { key: before }, items, gold } (its troop's)
$.fxAdoptQueue = [];    // host: runs of players who left (or ending A), for the host's own interpreter

$.fxMe = function() {
    return $.isHost() ? 'host' : $.myId;
};

// This PC runs the world of its map in a shared game.
$.fxWorldPc = function() {
    if (!$.role) return false;
    if ($.isHost()) return true;
    return $.isRoaming() && !$.solo;
};

$.fxShared = function() {
    if ($.isHost()) return $.sessionActive();
    return !!$.conn && $.isRoaming() && !$.solo;
};

$.fxKey = function(m, e) {
    return m + ',' + e;
};

$.fxPageIndex = function(list, eventId) {
    var ev = eventId > 0 && $gameMap ? $gameMap.event(eventId) : null;
    var data = ev && ev.event();
    if (!data || !list) return -1;
    for (var i = 0; i < data.pages.length; i++) {
        if (data.pages[i].list === list) return i;
    }
    return -1;
};

$.fxCondKeys = function(page, mapId, eventId) {
    var c = page.conditions, keys = [];
    if (c.switch1Valid) keys.push('sw:' + c.switch1Id);
    if (c.switch2Valid) keys.push('sw:' + c.switch2Id);
    if (c.variableValid) keys.push('v:' + c.variableId);
    if (c.selfSwitchValid) keys.push('ss:' + [mapId, eventId, c.selfSwitchCh].join(','));
    return keys;
};

// Each player's own page (a sleeping switch, a SELECT switch): not one in the world.
$.fxPerPlayer = function(page) {
    var c = page.conditions;
    return (c.switch1Valid && $.scenePersonalSwitch(c.switch1Id)) || (c.switch2Valid && $.scenePersonalSwitch(c.switch2Id));
};

// (ids name this PC: an interpreter that came from another PC keeps its id,
// which is nothing here)
$.fxNewChain = function(eventId, pageIndex, who, page) {
    var n = ++$.fxChainSeq, id = $.fxMe() + '#' + $.fxRunTag + '.' + n;
    $.fxChains[id] = { id: id, n: n, m: $gameMap.mapId(), e: eventId, p: pageIndex, who: who,
        before: {}, items: [], gold: 0, itemWho: '', dirty: '', fights: 0, at: $.clockMs(), root: null, evPos: {} };
    if (page && $.pageNeedsConsent(page.list || [])) $.fxChains[id].dirty = 'a bed (sleep, the day)';
    $.fxChainOrder.push(id);
    if ($.fxChainOrder.length > $.FX_CHAIN_KEEP) delete $.fxChains[$.fxChainOrder.shift()];
    return id;
};

// The chain an autorun / parallel page belongs to: the newest one that wrote
// one of its conditions (on this map).
$.fxChainOfPage = function(page, eventId) {
    var best = null, mapId = $gameMap.mapId();
    $.fxCondKeys(page, mapId, eventId).forEach(function(k) {
        var id = $.fxKeyChain[k];
        var ch = id && $.fxChains[id];
        if (ch && ch.m === mapId && $.fxChainLive(ch) && (!best || ch.n > best.n)) best = ch;
    });
    return best ? best.id : 0;
};

// Its page runs now, or it wrote a moment ago.
$.fxChainLive = function(ch) {
    var r = ch.root;
    if (r && r._fhChain === ch.id && r.isRunning()) return true;
    return $.clockMs() - (ch.at || 0) <= $.FX_CHAIN_MS;
};

// A common event's id from its list (only the ones that matter here).
$.fxCeOf = function(list, ids) {
    var found = 0;
    Object.keys(ids).forEach(function(id) {
        var ce = $dataCommonEvents && $dataCommonEvents[id];
        if (ce && ce.list === list) found = Number(id);
    });
    return found;
};

$.fxCurChain = function() {
    var top = $.fxStack[$.fxStack.length - 1];
    var id = top && top._fhChain;
    return id ? $.fxChains[id] || null : null;
};

// World switches a troop turns on that a lost (rolled back) fight must take
// back. Logic's troop 191 (normal mode) turns SW4819 HARD_MODE on at its first
// turn (page 7, an original quirk: the ending follows, Map161 gives the hard
// mode unlock): lost in co-op, the whole game stayed in hard mode.
$.FX_TROOP_WORLD_KEYS = { 'sw:4819': true };

$.fxNote = function(key, before) {
    if ($.fxQuiet) return;
    var top = $.fxStack[$.fxStack.length - 1];
    if (!top || top._fhGeneric) return;
    // the fight's own troop: its variables go back when it is lost (fxBattle);
    // a fight the grabbers joined, its switches too (parts, "<name>1")
    if (top._fhTroop) {
        var fb = $.fxBattle;
        if (fb && (fb.grab || /^v:/.test(key) || $.FX_TROOP_WORLD_KEYS[key]) && !(key in fb.vars)) fb.vars[key] = before;
        if (fb && fb.grab && $.grabTroopNote) $.grabTroopNote(fb, key);
        return;
    }
    var ch = $.fxCurChain();
    if (!ch) return;
    if (!(key in ch.before)) ch.before[key] = before;
    if (key === 'sw:' + $.FX_SLEEP_SWITCH) ch.dirty = ch.dirty || 'a bed (sleep, the day)';
    ch.at = $.clockMs();
    $.fxKeyChain[key] = ch.id;
};

// An event a scene moves with Set Event Location (user 2026-11-07: the altar
// of the new gods, Map051 EV297 moves the god's figure EV474 onto the circle
// before the Heartless one's fight - lost and rolled back, it stayed there, "a
// spotlight sunk in the floor"): where it stood before, put back with the rest.
$.fxNotePos = function(ev) {
    if ($.fxQuiet || !ev) return;
    var top = $.fxStack[$.fxStack.length - 1];
    if (!top || top._fhGeneric || top._fhTroop) return;
    var ch = $.fxCurChain();
    if (!ch) return;
    ch.evPos = ch.evPos || {};
    if (!ch.evPos[ev.eventId()]) ch.evPos[ev.eventId()] = { x: ev.x, y: ev.y, d: ev.direction() };
};

var _command203Fx = Game_Interpreter.prototype.command203;
Game_Interpreter.prototype.command203 = function() {
    if ($.fxWorldPc() && $gameMap) $.fxNotePos(this.character(this._params[0]));
    return _command203Fx.call(this);
};

$.fxNoteThing = function(ch, entry, gold) {
    var who = $.ctx && $.ctx.guestId ? $.ctx.guestId : $.fxMe();
    if (ch.itemWho && ch.itemWho !== who) ch.dirty = ch.dirty || 'items of two players';
    ch.itemWho = who;
    if (entry) ch.items.push(entry);
    if (gold) ch.gold += gold;
};

var _setupFx = Game_Interpreter.prototype.setup;
Game_Interpreter.prototype.setup = function(list, eventId) {
    _setupFx.call(this, list, eventId);
    this._fhChain = 0;
    this._fhFixed = null;
    this._fhTroop = this._depth === 0 && !!$gameTroop && this === $gameTroop._interpreter;
    this._fhGeneric = false;
    if (this._depth > 0 || !$.fxWorldPc() || !$gameMap) return;
    var index = $.fxPageIndex(list, eventId);
    if (index < 0) return;
    var page = $gameMap.event(eventId).event().pages[index];
    var who = this._fhOwner || $.fxMe();
    this._fhChain = page.trigger <= 2 ? $.fxNewChain(eventId, index, who, page) : $.fxChainOfPage(page, eventId);
    var ch = this._fhChain ? $.fxChains[this._fhChain] : null;
    if (ch) {
        ch.root = this;
        ch.at = $.clockMs();
    }
    if ($.pageFights(page)) {
        this._fhFixed = { m: $gameMap.mapId(), e: eventId, p: index, t: page.trigger, who: who, fight: -1, chain: this._fhChain };
        // a parallel page loops all the time: held from its fight on
        if (page.trigger !== 4) $.fxHoldStart(this._fhFixed, page);
    }
};

var _setupChildFx = Game_Interpreter.prototype.setupChild;
Game_Interpreter.prototype.setupChild = function(list, eventId) {
    _setupChildFx.call(this, list, eventId);
    var child = this._childInterpreter;
    if (!child) return;
    child._fhChain = this._fhChain || 0;
    child._fhTroop = !!this._fhTroop;
    child._fhGeneric = !!this._fhGeneric || !!$.fxCeOf(list, $.FX_GENERIC_CES);
    var ch = child._fhChain ? $.fxChains[child._fhChain] : null;
    if (ch && $.fxCeOf(list, $.FX_TIME_CES)) ch.dirty = ch.dirty || 'the day goes on';
};

var _executeCommandFx = Game_Interpreter.prototype.executeCommand;
Game_Interpreter.prototype.executeCommand = function() {
    var fx = this._fhFixed;
    // the command after the fight runs: it was won (or run from)
    if (fx && fx.fight >= 0 && this._list && this._index > fx.fight && this._index < this._list.length && $.fxWorldPc()) {
        fx.fight = -1;
        fx.won = true;
        if ($.fxBattle && $.fxBattle.fx === fx) $.fxBattle = null;
        if (fx.held && $.isGuest() && $.conn) $.conn.send({ t: 'fixedRb', m: fx.m, e: fx.e, rb: null });
        if ($.fxFightGoesOn(this, fx)) return false;
    }
    if (this._fhChain && this._depth === 0) {
        var live = $.fxChains[this._fhChain];
        if (live) live.at = $.clockMs();
    }
    $.fxStack.push(this);
    try {
        return _executeCommandFx.call(this);
    } finally {
        $.fxStack.pop();
    }
};

var _swSetFx = Game_Switches.prototype.setValue;
Game_Switches.prototype.setValue = function(id, value) {
    var before = !!this._data[id];
    _swSetFx.call(this, id, value);
    if (this === $gameSwitches && $.fxStack.length) $.fxNote('sw:' + id, before);
};

var _varSetFx = Game_Variables.prototype.setValue;
Game_Variables.prototype.setValue = function(id, value) {
    var before = this._data[id] || 0;
    _varSetFx.call(this, id, value);
    if (this === $gameVariables && $.fxStack.length) $.fxNote('v:' + id, before);
};

var _ssSetFx = Game_SelfSwitches.prototype.setValue;
Game_SelfSwitches.prototype.setValue = function(key, value) {
    var before = !!this._data[key];
    _ssSetFx.call(this, key, value);
    if (this === $gameSelfSwitches && $.fxStack.length) $.fxNote('ss:' + String(key), before);
};

var _gainItemFx = Game_Party.prototype.gainItem;
Game_Party.prototype.gainItem = function(item, amount, includeEquip) {
    var fb = this === $gameParty && item && !$.fxQuiet && $.fxBattle && this.inBattle() ? $.fxBattle : null;
    var top = $.fxStack[$.fxStack.length - 1];
    var ch = this === $gameParty && item && $.fxStack.length && !$.fxQuiet && !(top && (top._fhGeneric || top._fhTroop)) ?
        $.fxCurChain() : null;
    var before = ch || fb ? this.numItems(item) : 0;
    _gainItemFx.call(this, item, amount, includeEquip);
    // won in the fight (the troop's reward: Black steel, troop 212 page 11)
    if (fb && this.numItems(item) > before) {
        fb.items.push([DataManager.isItem(item) ? 'i' : DataManager.isWeapon(item) ? 'w' : 'a', item.id, this.numItems(item) - before]);
    }
    if (!ch) return;
    var n = this.numItems(item) - before;
    if (includeEquip && n !== amount) ch.dirty = ch.dirty || 'equipment';
    var kind = DataManager.isItem(item) ? 'i' : DataManager.isWeapon(item) ? 'w' : 'a';
    if (n) $.fxNoteThing(ch, [kind, item.id, n], 0);
};

var _gainGoldFx = Game_Party.prototype.gainGold;
Game_Party.prototype.gainGold = function(amount) {
    var top = $.fxStack[$.fxStack.length - 1];
    var ch = this === $gameParty && $.fxStack.length && !$.fxQuiet && !(top && (top._fhGeneric || top._fhTroop)) ?
        $.fxCurChain() : null;
    var fb = this === $gameParty && !$.fxQuiet && $.fxBattle && this.inBattle() ? $.fxBattle : null;
    var before = this._gold;
    _gainGoldFx.call(this, amount);
    if (ch && this._gold !== before) $.fxNoteThing(ch, null, this._gold - before);
    if (fb && this._gold > before) fb.gold += this._gold - before;
};

['addActor', 'removeActor'].forEach(function(name) {
    var base = Game_Party.prototype[name];
    Game_Party.prototype[name] = function(actorId) {
        var ch = this === $gameParty && $.fxStack.length ? $.fxCurChain() : null;
        var before = this._actors.join();
        base.call(this, actorId);
        if (ch && this._actors.join() !== before) ch.dirty = ch.dirty || 'the party';
    };
});

// What a loss of this fight would roll back: the scene so far.
$.fxSnapshot = function(ch) {
    if (!ch) return { no: 'no player action on this map set it off' };
    if (ch.dirty) return { no: 'it changed ' + ch.dirty };
    if (ch.fights) return { no: 'a fight of the same scene came before it' };
    var after = {};
    Object.keys(ch.before).forEach(function(k) { after[k] = $.fxRaw(k); });
    return { m: ch.m, e: ch.e, p: ch.p, keys: Object.assign({}, ch.before), after: after, items: ch.items.slice(),
        gold: ch.gold, who: ch.itemWho, pos: Object.assign({}, ch.evPos || {}) };
};

// The rollback of one key now: only what this scene changed. A variable
// takes back the scene's change (another player's change since stays: a
// contestant killed elsewhere while Kaiser was fought); a switch goes back
// only when nobody changed it since. undefined: leave it.
$.fxTarget = function(k, before, after) {
    var cur = $.fxRaw(k);
    if (/^v:/.test(k)) {
        var d = (before || 0) - (after || 0);
        return d ? cur + d : undefined;
    }
    return cur === !!after && cur !== !!before ? !!before : undefined;
};

$.fxSetKey = function(k, v) {
    var m = /^(sw|v|ss):(.+)$/.exec(k);
    if (!m) return;
    if (m[1] === 'sw') $gameSwitches.setValue(Number(m[2]), !!v);
    else if (m[1] === 'v') $gameVariables.setValue(Number(m[2]), v || 0);
    else {
        var parts = m[2].split(',');
        $gameSelfSwitches.setValue([Number(parts[0]), Number(parts[1]), parts[2]], !!v);
    }
};

// Outermost: the fight really starts here (a guest's copy of a talk that
// turns into a fight returns false first, FH_CoopBattle handBattleToGuest).
var _command301Fx = Game_Interpreter.prototype.command301;
Game_Interpreter.prototype.command301 = function() {
    var inBattle = $gameParty.inBattle();
    var troopId = $.troopIdOf(this);
    var ch = this._fhChain ? $.fxChains[this._fhChain] || null : null;
    var fx = this._fhFixed;
    var snap = fx && !inBattle ? $.fxSnapshot(ch) : null;
    var result = _command301Fx.call(this);
    if (!result || inBattle || !$dataTroops[troopId]) return result;
    if (fx) {
        fx.fight = this._index;
        fx.rb = snap;
        if (fx.t === 4) {
            var ev = $gameMap.event(fx.e);
            if (ev && ev.event()) $.fxHoldStart(fx, ev.event().pages[fx.p]);
        }
        // this PC runs the battle (a thin guest's runs on its PC: fixedFight)
        if (!this._fhOwner) $.fxBattle = { fx: fx, vars: {}, items: [], gold: 0 };
        var oc = this._fhOwner ? $.clientById(this._fhOwner) : null;
        if (oc && oc.inBattle) oc.send({ t: 'fixedFight', bid: oc.inBattle });
        if (fx.held && $.isGuest() && $.conn) $.conn.send({ t: 'fixedRb', m: fx.m, e: fx.e, rb: $.fxRbForHost(snap) });
    }
    if (ch) ch.fights++;
    $.fxFightInterp = this;
    return result;
};

var _terminateFx = Game_Interpreter.prototype.terminate;
Game_Interpreter.prototype.terminate = function() {
    var fx = this._fhFixed;
    this._fhFixed = null;
    _terminateFx.call(this);
    // the event stopped right after its fight: a co-op defeat (a copy
    // from a snapshot on a thin guest's PC is nothing)
    if (fx && $.fxWorldPc()) {
        fx.who = this._fhOwner || $.fxMe(); // (a run handed on: Run!, ending A)
        $.fxRunEnd(fx, fx.fight >= 0);
    }
};

$.fxRunEnd = function(fx, lost) {
    var back = false;
    if (lost) {
        $.fxTakeBack(fx);
        back = $.fxRollback(fx);
        $.dlog('fixed fight lost: map', fx.m, 'ev' + fx.e, 'p' + (fx.p + 1), 'by', $.playerLabel ? $.playerLabel(fx.who) : fx.who,
            back ? '- rolled back to before its trigger' : '- it waits until that player stands up');
    }
    // (a page a player starts never starts again by itself: no wait)
    $.fxHoldEnd(fx, lost && !back && fx.t >= 3);
};

// Raw values (no record, no sync): for the check.
$.fxRaw = function(key, value) {
    var m = /^(sw|v|ss):(.+)$/.exec(key);
    if (!m) return undefined;
    var data = m[1] === 'sw' ? $gameSwitches._data : m[1] === 'v' ? $gameVariables._data : $gameSelfSwitches._data;
    var id = m[1] === 'ss' ? m[2] : Number(m[2]);
    var old = m[1] === 'v' ? data[id] || 0 : !!data[id];
    if (value !== undefined) {
        if (m[1] === 'ss' && !value) delete data[id]; else data[id] = value;
    }
    return old;
};

$.fxRollback = function(fx) {
    var rb = fx.rb, why = '';
    if (!rb) why = 'no scene before it';
    else if (rb.no) why = rb.no;
    else if ($.FX_NO_ROLLBACK[$.fxKey(fx.m, fx.e)]) why = $.FX_NO_ROLLBACK[$.fxKey(fx.m, fx.e)];
    else if ($gameMap.mapId() !== fx.m || rb.m !== fx.m) why = 'another map';
    else if ((rb.items.length || rb.gold) && rb.who !== fx.who) why = 'items of another player';
    var keys = rb && !why ? Object.keys(rb.keys).filter(function(k) {
        var m = /^sw:(\d+)$/.exec(k);
        return !(m && $.scenePersonalSwitch(Number(m[1]))); // each player's own (SW202 / SW410: the stopped scene's)
    }) : [];
    var target = {};
    keys.forEach(function(k) {
        var t = $.fxTarget(k, rb.keys[k], rb.after ? rb.after[k] : rb.keys[k]);
        if (t !== undefined) target[k] = t;
    });
    keys = Object.keys(target);
    if (!why) {
        // as it would be: the fight's page off, the trigger's page back
        var now = {};
        keys.forEach(function(k) { now[k] = $.fxRaw(k, target[k]); });
        var ev = $gameMap.event(fx.e), trig = $gameMap.event(rb.e);
        var still = !!ev && ev.findProperPageIndex() === fx.p;
        var armed = !!trig && trig.findProperPageIndex() === rb.p;
        keys.forEach(function(k) { $.fxRaw(k, now[k]); });
        // (a fight the grabbers joined: its talk page stays; only the player starts it again)
        if (still && !(fx.grab && fx.t <= 2 && rb.e === fx.e && rb.p === fx.p)) why = 'its page would start again';
        else if (!armed) why = 'its trigger would not come back';
    }
    if (why) {
        $.dlog('fixed fight: no rollback (' + why + ')');
        return false;
    }
    $.fxQuiet = true;
    try {
        keys.forEach(function(k) { $.fxSetKey(k, target[k]); });
        rb.items.forEach(function(it) { $.fxGiveBack(it); });
        if (rb.gold) $.fxGoldBack(-rb.gold);
        Object.keys(rb.pos || {}).forEach(function(id) {
            var ev = $gameMap.event(Number(id)), at = rb.pos[id];
            if (!ev) return;
            ev.locate(at.x, at.y);
            ev.setDirection(at.d);
        });
    } finally {
        $.fxQuiet = false;
    }
    $gameMap.requestRefresh();
    return true;
};

// An item change undone ([kind, id, change]): only what is there to take
// (one traded away meanwhile is not made twice).
$.fxGiveBack = function(it) {
    var data = it[0] === 'i' ? $dataItems : it[0] === 'w' ? $dataWeapons : $dataArmors;
    var item = data[it[1]];
    if (!item) return;
    var n = -it[2];
    if (n < 0) {
        var have = $gameParty.numItems(item);
        if (have < -n) $.dlog('fixed fight: ' + (-n - have) + ' of', item.name, 'are gone already (traded?)');
        n = -Math.min(have, -n);
    }
    if (n) $gameParty.gainItem(item, n);
};

$.fxGoldBack = function(n) {
    if (n < 0) n = -Math.min($gameParty.gold(), -n);
    if (n) $gameParty.gainGold(n);
};

// What the lost fight itself gave (its troop's rewards, its variables).
$.fxTakeBack = function(fx) {
    var fb = $.fxBattle;
    if (!fb || fb.fx !== fx) return;
    $.fxBattle = null;
    $.fxQuiet = true;
    try {
        fb.items.forEach(function(it) { $.fxGiveBack(it); });
        if (fb.gold) $.fxGoldBack(-fb.gold);
        Object.keys(fb.vars).forEach(function(k) { $.fxSetKey(k, fb.vars[k]); });
    } finally {
        $.fxQuiet = false;
    }
    if (fb.items.length || fb.gold) $.dlog('fixed fight lost: what it gave goes back', JSON.stringify(fb.items), fb.gold || '');
};

// The keys the host can roll back when this guest drops (no check, no items).
$.fxRbForHost = function(rb) {
    if (!rb || rb.no) return null;
    var keys = {};
    Object.keys(rb.keys).forEach(function(k) {
        var m = /^sw:(\d+)$/.exec(k);
        if (!(m && $.scenePersonalSwitch(Number(m[1])))) keys[k] = [rb.keys[k], rb.after[k]];
    });
    return { keys: keys };
};

// Thin guest: its fight is a fixed one (the host says so): what the troop
// gives in it goes back if it is lost (its result carries no reward).
$.guestHandlers.fixedFight = function(msg) {
    if ($.localBattle && $.localBattle.bid === msg.bid) $.fxBattle = { fx: { bid: msg.bid }, vars: {}, items: [], gold: 0, local: true };
};

var _finishLocalBattleFx = $.finishLocalBattle;
$.finishLocalBattle = function(result, dead) {
    var fb = $.fxBattle, lb = $.localBattle;
    if (fb && fb.local && lb && !lb.sent && fb.fx.bid === lb.bid) {
        $.fxBattle = null;
        if (dead) {
            fb.fx = null;
            $.fxBattle = fb;
            $.fxTakeBack(null);
            // its variables (and a grab fight's switches) as they were when it
            // began (unset ones too: no change to report)
            Object.keys(fb.vars).forEach(function(k) {
                var m = /^(v|sw):(\d+)$/.exec(k), id = m ? Number(m[2]) : 0;
                if (m && m[1] === 'v') $gameVariables._data[id] = lb.v0[id];
                else if (m) $gameSwitches._data[id] = lb.sw0[id];
            });
            if ($gameMap) $gameMap.requestRefresh();
        }
    }
    _finishLocalBattleFx(result, dead);
};

// Host: a guest dropped in the middle of its fixed fight.
$.fxDropRollback = function(rb, why) {
    if (!rb || !rb.keys) return;
    $.fxQuiet = true;
    try {
        Object.keys(rb.keys).forEach(function(k) {
            var t = $.fxTarget(k, rb.keys[k][0], rb.keys[k][1]);
            if (t !== undefined) $.fxSetKey(k, t);
        });
    } finally {
        $.fxQuiet = false;
    }
    $gameMap.requestRefresh();
    $.dlog('fixed fight: rolled back -', why);
};

// Holds ----------------------------------------------------------------------

$.fxSetHold = function(key, hold) {
    if (hold) $.fixedHolds[key] = hold; else delete $.fixedHolds[key];
    $.fxVer++;
};

$.fxHoldStart = function(fx, page) {
    if (!page || $.fxPerPlayer(page) || !$.fxShared()) return;
    var key = $.fxKey(fx.m, fx.e);
    // another player's run holds it: not taken over (0.41 review 4 H2)
    var old = $.fixedHolds[key];
    if (old && !old.down && old.id !== fx.who) {
        $.dlog('fixed fight map', fx.m, 'ev' + fx.e, 'held by', old.id, 'already - not taken over');
        return;
    }
    fx.held = true;
    if ($.isHost()) {
        $.fxSetHold(key, { id: fx.who, by: 'host', p: fx.p });
        return;
    }
    $.fixedHolds[key] = { id: fx.who, by: $.myId, p: fx.p };
    delete $.fxLocalDown[key];
    // the scene so far: the host rolls it back if this PC drops before the end
    var ch = fx.chain ? $.fxChains[fx.chain] || null : null;
    $.conn.send({ t: 'fixedOn', m: fx.m, e: fx.e, p: fx.p, id: fx.who, rb: ch ? $.fxRbForHost($.fxSnapshot(ch)) : null });
};

$.fxHoldEnd = function(fx, down) {
    if (!fx.held) return;
    fx.held = false;
    var key = $.fxKey(fx.m, fx.e);
    if ($.isHost()) {
        var h = $.fixedHolds[key];
        if (h && h.by !== 'host') return; // (another PC's, kept: a race, see fixedOn)
        $.fxSetHold(key, down ? { id: fx.who, by: 'host', p: fx.p, down: true } : null);
        return;
    }
    if (!$.conn) return;
    // the rollback (and the scene's last writes) reach the host first
    $.flushWorldGuest();
    if (down) $.fxLocalDown[key] = fx.who;
    if ($.fixedHolds[key] && $.fixedHolds[key].by === $.myId) delete $.fixedHolds[key];
    $.conn.send({ t: 'fixedOff', m: fx.m, e: fx.e, down: !!down });
};

// Why this page may not start on this PC now ('' = it may).
$.fxBlocked = function(ev, page) {
    if (!page || !$.pageFights(page) || $.fxPerPlayer(page) || !$.fxWorldPc()) return '';
    var key = $.fxKey($gameMap.mapId(), ev.eventId());
    // the ending A script won on a guest's PC comes here (its fight is over)
    if ($.endingAPending && key === $.fxKey($.ENDING_A_FIGHT.m, $.ENDING_A_FIGHT.e)) return 'ending A comes from a guest';
    if ($.isGuest() && $.fxLocalDown[key]) return 'lost here, its player is down';
    var h = $.fixedHolds[key];
    if (!h) return '';
    if (h.down) return 'lost by ' + h.id + ', down';
    if (h.by === $.fxMe()) return '';
    return 'run by ' + h.id;
};

$.FX_BUSY_TEXT = 'Someone else is dealing with this right now...';
$.fxToldAt = 0;

// who: the player who tried (talked to it, touched it), or none (an autorun page)
$.fxTellBlocked = function(ev, why, who) {
    var tag = ev.eventId() + ':' + why;
    if ($.fxToldBlocked !== tag) {
        $.fxToldBlocked = tag;
        $.dlog('fixed fight ev' + ev.eventId(), 'map', $gameMap.mapId(), 'not started here:', why);
    }
    // bumping into it repeats every frame: tell once a second
    if (!who || $.clockMs() - $.fxToldAt < 1000) return;
    $.fxToldAt = $.clockMs();
    if (who === $.fxMe()) $.fieldGab($.FX_BUSY_TEXT); else $.sendTo(who, { t: 'gab', text: $.FX_BUSY_TEXT });
};

// Outermost: before any wrapper takes the page for a guest. A frozen enemy
// someone fights (touch, OK) is still joined (FH_CoopBattle requestJoin);
// an autorun page never joins by itself.
var _startFx = Game_Event.prototype.start;
Game_Event.prototype.start = function() {
    var page = this.page();
    if ($.role && page && (this._trigger === 3 || !this._fhBattle)) {
        var why = $.fxBlocked(this, page);
        if (why) {
            $.fxTellBlocked(this, why, this._trigger <= 2 && !$gamePlayer._fhRemoteId ? $.fxMe() : '');
            return;
        }
    }
    _startFx.call(this);
};

// a guest on this map (OK, touch: FH_CoopWorld startEventFor)
$.eventStartHooks.push(function(conn, ev, page) {
    if (!$.role || ev._fhBattle) return false; // (a frozen enemy is joined: the hooks before)
    var why = $.fxBlocked(ev, page);
    if (why) $.fxTellBlocked(ev, why, page.trigger <= 2 ? conn.guestId : '');
    return !!why;
});

var _updateParallelFx = Game_Event.prototype.updateParallel;
Game_Event.prototype.updateParallel = function() {
    if ($.role && this._interpreter && !this._interpreter.isRunning()) {
        var why = $.fxBlocked(this, this.page());
        if (why) {
            $.fxTellBlocked(this, why);
            return;
        }
    }
    _updateParallelFx.call(this);
};

// A run on this map whose page is one in the world.
$.fxHoldable = function(fx) {
    var ev = fx.m === $gameMap.mapId() ? $gameMap.event(fx.e) : null;
    var page = ev && ev.event() ? ev.event().pages[fx.p] : null;
    return !!page && !$.fxPerPlayer(page);
};

// The interpreters of this PC that run a fixed page now: { key: who }
// (a parallel page from its fight on). fxs: key -> its run.
$.fxLiveRuns = function(fxs) {
    var out = {};
    var see = function(i) {
        var fx = i && i._fhFixed;
        if (!fx || (fx.t === 4 && fx.fight < 0)) return;
        out[$.fxKey(fx.m, fx.e)] = i._fhOwner || $.fxMe();
        if (fxs) fxs[$.fxKey(fx.m, fx.e)] = fx;
    };
    if ($gameMap && $gameMap._interpreter) see($gameMap._interpreter);
    Object.keys($.owned || {}).forEach(function(id) { see($.owned[id].interp); });
    // (a body's id above 9000 makes the array sparse: FH_Coop $.eventsOf)
    var list = $gameMap ? $.eventsOf($gameMap._events) : [];
    for (var i = 0; i < list.length; i++) see(list[i]._interpreter);
    return out;
};

// Host ------------------------------------------------------------------------

$.hostHandlers.fixedOn = function(conn, msg) {
    if (!conn.roam) return;
    var c = $.clientById(msg.id);
    var id = msg.id === conn.guestId || (c && c.subOf === conn.guestId) ? msg.id : conn.guestId;
    var key = $.fxKey(msg.m, msg.e);
    var h = $.fixedHolds[key];
    if (h && !h.down && h.by !== conn.guestId) {
        $.dlog('fixed fight map', msg.m, 'ev' + msg.e, 'started by', conn.name, 'while', h.id, 'runs it');
        return;
    }
    $.fxSetHold(key, { id: id, by: conn.guestId, p: msg.p, rb: msg.rb || null });
};

// The scene to roll back (at its fight; none once won).
$.hostHandlers.fixedRb = function(conn, msg) {
    var h = $.fixedHolds[$.fxKey(msg.m, msg.e)];
    if (h && h.by === conn.guestId && !h.down) h.rb = msg.rb || null;
};

$.hostHandlers.fixedOff = function(conn, msg) {
    var key = $.fxKey(msg.m, msg.e);
    var h = $.fixedHolds[key];
    if (!h || h.by !== conn.guestId) return;
    $.fxSetHold(key, msg.down ? { id: h.id, by: h.by, p: h.p, down: true } : null);
};

// Holds whose run is gone, losers who stood up (or died), PCs that left.
$.fxJanitor = function() {
    var live = null;
    // a run that came from another PC (a guest's event the host goes on with)
    if ($.sessionActive()) {
        var fxs = {};
        live = $.fxLiveRuns(fxs);
        Object.keys(live).forEach(function(key) {
            var h = $.fixedHolds[key];
            if ((h && !h.down) || !$.fxHoldable(fxs[key])) return;
            fxs[key].held = true;
            $.fxSetHold(key, { id: live[key], by: 'host', p: fxs[key].p });
        });
    }
    Object.keys($.fixedHolds).forEach(function(key) {
        var h = $.fixedHolds[key];
        var gone = false;
        if (h.down) {
            gone = !$.downs[h.id];
        } else if (h.by === 'host') {
            live = live || $.fxLiveRuns();
            if (!live[key]) gone = true;
            else if (live[key] !== h.id) $.fxSetHold(key, { id: live[key], by: 'host', p: h.p }); // run handed on
        } else {
            var c = $.clientById(h.by);
            gone = !c || !c.roam;
        }
        if (gone) $.fxSetHold(key, null);
    });
};

$.fxSendHolds = function() {
    $.clients.forEach(function(c) {
        if (!c.roam || c._fxVer === $.fxVer) return;
        c._fxVer = $.fxVer;
        c.send({ t: 'fixedHolds', h: $.fixedHolds });
    });
};

var _sendRoamFx = $.sendRoam;
$.sendRoam = function(conn, opts) {
    conn._fxVer = -1;
    return _sendRoamFx(conn, opts);
};

var _hostSyncFx = $.hostSync;
$.hostSync = function() {
    _hostSyncFx();
    $.fxJanitor();
    $.fxSendHolds();
};

// A player who leaves in the middle of a fixed fight: a loss (rolled back).
// Its scene after a won fight (or ending A) goes on as the host's.
var _onGuestClosedFx = $.onGuestClosed;
$.onGuestClosed = function(conn) {
    if ($.isHost()) $.fxOwnerGone(conn);
    _onGuestClosedFx(conn);
    Object.keys($.fixedHolds).forEach(function(key) {
        var h = $.fixedHolds[key];
        if (h.by !== conn.guestId && h.id !== conn.guestId) return;
        if (h.by === conn.guestId && h.rb && !h.down) $.fxDropRollback(h.rb, conn.name + ' left during it');
        $.fxSetHold(key, null);
    });
};

$.fxOwnerGone = function(conn) {
    var entry = $.owned[conn.guestId];
    var interp = entry && entry.interp;
    var fx = interp && interp._fhFixed;
    if (!fx) return;
    // its fight goes on with a joiner (FH_CoopBattle moves the event to it)
    var b = conn.inBattle ? $.battles[conn.inBattle] : null;
    if (b && b.owner === conn.guestId && b.joiners.length) return;
    if (fx.won || interp === $.endingAMove) {
        $.fxAdopt(conn.guestId, 'its player left');
        return;
    }
    if (!fx.rb) fx.rb = $.fxSnapshot(interp._fhChain ? $.fxChains[interp._fhChain] : null);
    var back = false;
    $.inContext(conn, function() {
        $.fxTakeBack(fx);
        back = $.fxRollback(fx);
    });
    interp._fhFixed = null;
    if (interp._list) interp._index = interp._list.length;
    $.dlog('fixed fight: map', fx.m, 'ev' + fx.e, conn.name, 'left during it', back ? '- rolled back' : '- not rolled back');
};

// A guest's run of a fixed page becomes the host's own (the host's
// interpreter takes it when free: the rest of the scene, the ending A script).
$.fxAdopt = function(id, why) {
    var entry = $.owned[id];
    if (!entry) return;
    delete $.owned[id];
    if (entry.ev) {
        entry.ev._fhOwner = null;
        // (an event of a map the host has left: see $.finishOwned)
        if ($gameMap.event(entry.ev.eventId()) === entry.ev) entry.ev.unlock();
        else entry.ev._locked = false;
    }
    var interp = entry.interp;
    if (interp === $.endingAMove) $.endingAMove = null;
    for (var k = interp; k; k = k._childInterpreter) delete k._fhOwner;
    if (interp._fhFixed) interp._fhFixed.who = 'host'; // (its hold follows: fxJanitor)
    $.fxAdoptQueue.push(interp);
    var conn = $.clientById(id);
    if (conn) conn.send({ t: 'evRun', on: false });
    $.dlog('fixed scene of', id, 'goes on as the host\'s:', why);
};

$.worldExtras.push(function() {
    if (!$.isHost() || !$.fxAdoptQueue.length || $gameMap._interpreter.isRunning()) return;
    var interp = $.fxAdoptQueue.shift();
    if (interp._waitMode === 'fhHanded') interp._waitMode = '';
    $gameMap._interpreter = interp;
});

// Guest -----------------------------------------------------------------------

$.guestHandlers.fixedHolds = function(msg) {
    var mine = {};
    // this PC's own runs the host has not answered yet stay
    Object.keys($.fixedHolds).forEach(function(k) {
        if ($.fixedHolds[k].by === $.myId && !$.fixedHolds[k].down) mine[k] = $.fixedHolds[k];
    });
    $.fixedHolds = Object.assign({}, msg.h || {}, mine);
};

$.fxDownHere = function(id) {
    if (id === $.myId) return $.myState === 'down';
    return $.pstateOf[id] === 'down';
};

$.guestExtras.push(function() {
    if (!$.isGuest()) return;
    Object.keys($.fxLocalDown).forEach(function(key) {
        if (!$.fxDownHere($.fxLocalDown[key])) delete $.fxLocalDown[key];
    });
    if (!$.isRoaming() || !$.conn || Graphics.frameCount % 30) return;
    var fxs = {}, live = $.fxLiveRuns(fxs);
    // a run this PC goes on with (an event the host handed over)
    Object.keys(live).forEach(function(key) {
        var h = $.fixedHolds[key];
        if ((h && h.by === $.myId) || !$.fxHoldable(fxs[key])) return;
        fxs[key].held = true;
        $.fixedHolds[key] = { id: live[key], by: $.myId, p: fxs[key].p };
        $.conn.send({ t: 'fixedOn', m: fxs[key].m, e: fxs[key].e, p: fxs[key].p, id: live[key] });
    });
    Object.keys($.fixedHolds).forEach(function(key) {
        var h = $.fixedHolds[key];
        if (h.by !== $.myId || h.down) return;
        live = live || $.fxLiveRuns();
        if (live[key]) return;
        var p = key.split(',');
        delete $.fixedHolds[key];
        $.conn.send({ t: 'fixedOff', m: Number(p[0]), e: Number(p[1]), down: false });
    });
});

// A fight lost on this PC's own map: the event of that fight stops too when
// it is not the map's (a parallel page: the sewer Monster, Map078 EV293 page
// 2, went on as if won - its after-fight writes, CHARACTERS_LEFT - 1).
var _roamDefeatedFx = $.roamDefeated;
$.roamDefeated = function() {
    var fi = $.fxFightInterp;
    var inMap = false;
    for (var i = $gameMap._interpreter; i; i = i._childInterpreter) if (i === fi) inMap = true;
    if (fi && !inMap && fi._list && fi._fhFixed && fi._fhFixed.fight >= 0) fi._index = fi._list.length;
    _roamDefeatedFx();
};

// A load, the title: the old world's scenes and holds are gone.
$.fxReset = function() {
    $.fxChains = {};
    $.fxChainOrder = [];
    $.fxKeyChain = {};
    $.fixedHolds = {};
    $.fxLocalDown = {};
    $.fxFightInterp = null;
    $.fxBattle = null;
    $.fxAdoptQueue = [];
    $.endingAMove = null;
    $.endingA = null;
    $.endingAPending = null;
    $.fxVer++;
};

var _resetRoamsFx = $.resetRoams;
$.resetRoams = function() {
    _resetRoamsFx();
    $.fxReset();
};

var _sceneTitleStartFx = Scene_Title.prototype.start;
Scene_Title.prototype.start = function() {
    $.fxReset();
    _sceneTitleStartFx.call(this);
};

var _processPendingSnapshotFixed = $.processPendingSnapshot;
$.processPendingSnapshot = function() {
    if ($.pendingSnapshot && $.isGuest()) {
        // the host's game from now on: this PC runs no map of its own
        $.fixedHolds = {};
        $.fxLocalDown = {};
    }
    _processPendingSnapshotFixed();
};

//=============================================================================
// Ending A: everyone watches it together
//=============================================================================
// User decision (2026-10-22): when the ending A script starts (Logic is
// beaten, Map140 EV19 page 1 goes on after its fight: the machine god
// pictures, then the fall into Map162 final_falling), every connected player
// watches it on the host's game: the guests running maps of their own (and
// their sub-host's guests, the downed, the ghosts) are brought onto the
// host's map, the script runs as the host's own scene (screen, pictures and
// the transfer shared), and the transfer to the ending map takes everyone.
// Won on a guest's PC (its own map, or a sub-host's guest), its PC hands the
// rest of the script to the host, which comes to that spot first.
// User decision (2026-10-29): together to the very end. The script ends on
// Map162; the ending goes on there (EV86) to Map143 (the walk up, EV46), to
// Map154 (EV5) and to Map161 EV1 (the train, the credits, the game over that
// ends the session: "The endings" below). Until then every
// transfer of the host takes everyone, a guest starts no transfer of its own,
// a player busy when it began (a fight, its menu) comes once free, and Logic
// (EV19, an autorun on V1158 only) never starts again on any PC.

$.ENDING_A_FIGHT = { m: 140, e: 19 };
$.ENDING_A_MAPS = { 140: true, 162: true, 143: true, 154: true, 161: true };
$.ENDING_A_MARK = 'FHENDA'; // self switch of Map140 EV19: ending A began (saved, synced)
$.endingA = null;        // host: { since } from the ending A script on (everyone follows the host)
$.endingAPending = null; // host: { json, m, x, y, d, from } a guest's script waiting for the host

$.isEndingAFight = function(fx) {
    return !!fx && fx.m === $.ENDING_A_FIGHT.m && fx.e === $.ENDING_A_FIGHT.e;
};

$.endingAMarkKey = function() {
    return [$.ENDING_A_FIGHT.m, $.ENDING_A_FIGHT.e, $.ENDING_A_MARK];
};

$.endingABegun = function() {
    return !!$gameSelfSwitches && !!$gameSelfSwitches.value($.endingAMarkKey());
};

// Host: ending A begins (or goes on after a load of a save made in it).
$.endingAStart = function() {
    $.endingA = { since: $.clockMs() };
    if ($.endingABegun()) return;
    $gameSelfSwitches.setValue($.endingAMarkKey(), true);
    $.endingAReviveAll();
    $.endingABringGhosts();
};

// The ones down (in the Logic fight a joiner won): up again, no line. Their
// timers ran on through the scene ("X died." in the middle of the ending, a
// down host who cannot walk the way up on Map143).
$.endingAReviveAll = function() {
    var ids = Object.keys($.downs);
    if (!ids.length) return;
    var toast = $.broadcastToast;
    $.broadcastToast = function() {};
    try {
        ids.forEach(function(id) { $.revive(id, 'host'); });
    } finally {
        $.broadcastToast = toast;
    }
    $.dlog('ending A: up again (no line)', ids.join(', '));
};

// The dead on the host's map may walk a still copy of another map ($.spec,
// the host does not know): a snapshot brings each to the Map140 scene.
$.endingABringGhosts = function() {
    $.clients.forEach(function(c) {
        if (!c.inGame || !c.actorId || c.solo || c.roam || c.roamPending || c.subOf || !$.isDead(c.guestId)) return;
        $.dlog('ending A: brings the dead', c.name, 'to the host\'s scene');
        $.sendSnapshot(c);
    });
};

// The fight of this run was won: true when the script must wait here (it
// goes to the host's own interpreter / to the host's PC).
$.fxFightGoesOn = function(interp, fx) {
    if (!$.isEndingAFight(fx) || !$.role || !$.fxShared()) return false;
    if ($.isHost()) {
        $.endingAStart();
        $.dlog('ending A: the script starts', interp._fhOwner ? '(won by ' + $.playerLabel(interp._fhOwner) + ')' : '');
        $.endingAPull();
        if (!interp._fhOwner) return false;
        // a guest's run on this map: the host's own scene from the next frame
        // (also when that guest leaves meanwhile)
        $.endingAMove = interp;
        interp.setWaitMode('fhHanded');
        $.fxAdopt(interp._fhOwner, 'ending A');
        return true;
    }
    interp.setWaitMode('fhHanded');
    // a guest's own map (or its sub-host's guest's run): to the host
    $.flushWorldGuest();
    var p = interp._fhOwner && $.remotes[interp._fhOwner] ? $.remotes[interp._fhOwner] : $gamePlayer;
    var copy = $.cleanInterp(JsonEx.parse(JsonEx.stringify(interp)));
    $.conn.send({ t: 'endingA', json: JsonEx.stringify(copy), m: $gameMap.mapId(), x: p.x, y: p.y, d: p.direction() });
    $.dlog('ending A: the script goes to the host');
    return true;
};

// Host: every player not in the host's game comes (a fight of its own first
// ends). Until the session ends: one busy at the start comes once free.
$.endingAPull = function() {
    if (!$.isHost() || !$.endingA) return;
    if ($gamePlayer.isTransferring()) return; // (to the host's next map, not this one)
    $.clients.forEach(function(c) {
        if (!c.inGame || !c.actorId || c.solo) return;
        if (!c.roam && !c.roamPending && !c.subOf) return;
        if (c.inBattle || $.roamHeld(c)) return; // (after its fight, its menu)
        if (c.roam && c.lastPos && $.DREAM_MAPS[c.lastPos.m]) return; // (after its own dream)
        // (its own event, message or scene: a fight's after-scene goes on to its end)
        if (c.roam && c.roamBusy) return;
        var spot = { m: $gameMap.mapId(), x: $gamePlayer.x, y: $gamePlayer.y, d: $gamePlayer.direction() };
        c._placeAt = spot;
        if (c.lastPos) c.lastPos = Object.assign({}, c.lastPos, spot, { id: c.guestId });
        $.dlog('ending A: brings', c.name, 'to the host');
        $.sendSnapshot(c);
    });
};

$.hostHandlers.endingA = function(conn, msg) {
    if (!conn.roam && !conn.subOf) return;
    $.endingAPending = { json: msg.json, m: Number(msg.m), x: Number(msg.x), y: Number(msg.y), d: Number(msg.d) || 2,
        from: conn.guestId };
    $.endingAStart();
    $.dlog('ending A: won on the PC of', conn.name, '- the host comes to map', msg.m);
    $.endingAPull();
};

$.worldExtras.push(function() {
    if (!$.isHost()) return;
    // a save made in the ending loaded (the load drops $.endingA, fxReset)
    if (!$.endingA && $.hostInGame && $.sessionActive() && $.ENDING_A_MAPS[$gameMap.mapId()] && $.endingABegun()) {
        $.endingAStart();
        $.dlog('ending A goes on (map', $gameMap.mapId() + '): everyone together again');
    }
    if (!$.endingA) return;
    var pend = $.endingAPending;
    if (pend && SceneManager._scene instanceof Scene_Map && !SceneManager.isSceneChanging() &&
            !$gameParty.inBattle() && !$gameMap.isEventRunning() && !$gamePlayer.isTransferring()) {
        if ($gameMap.mapId() !== pend.m) {
            if (!pend.going) {
                pend.going = true;
                $gamePlayer.reserveTransfer(pend.m, pend.x, pend.y, pend.d, 0);
            }
        } else {
            $.endingAPending = null;
            var interp = $.cleanInterp(JsonEx.parse(pend.json));
            $gameMap._interpreter = interp;
            var fx = interp._fhFixed;
            if (fx) {
                fx.who = 'host';
                fx.held = true;
                $.fxSetHold($.fxKey(fx.m, fx.e), { id: 'host', by: 'host', p: fx.p });
            }
            $.dlog('ending A: the host runs the script');
        }
    }
    if (Graphics.frameCount % 30 === 0) $.endingAPull();
});

// The host leaves the map in the ending: everyone comes along (as the dead do).
var _leaveGuestsBehindEnding = $.leaveGuestsBehind;
$.leaveGuestsBehind = function(newMapId) {
    if ($.endingA) {
        $.clients.forEach(function(c) {
            if (c.inGame && c.actorId && !c.solo && !c.roam && !c.subOf && c.lastPos) delete c.lastPos.m;
        });
        return;
    }
    _leaveGuestsBehindEnding(newMapId);
};

// Logic (EV19: an autorun on V1158 alone, no self switch) never starts again
// once ending A began: a player who comes to Map140 later (busy when it
// began, a load) fought it again, and its win took the host back there.
var _fxBlockedEndingA = $.fxBlocked;
$.fxBlocked = function(ev, page) {
    if ($.role && $.fxWorldPc() && $gameMap.mapId() === $.ENDING_A_FIGHT.m && ev.eventId() === $.ENDING_A_FIGHT.e &&
            $.endingABegun() && !$.endingAPending) {
        return 'ending A began already';
    }
    return _fxBlockedEndingA(ev, page);
};

// A guest takes no way out of the ending's maps of its own (Map143 EV46, the
// step into Map154: it went alone): the host leads.
$.ENDING_A_LEAD_TEXT = 'The host leads the way from here.';
$.eventStartHooks.push(function(conn, ev, page) {
    if (!$.isHost() || !$.endingA || !page || !$.listHasTransfer(page.list, {})) return false;
    if (conn.endingAToldAt === undefined || Graphics.frameCount - conn.endingAToldAt > 60) {
        conn.endingAToldAt = Graphics.frameCount;
        $.sendTo(conn.guestId, { t: 'gab', text: $.ENDING_A_LEAD_TEXT });
    }
    return true;
});

//=============================================================================
// The tower gate: no companion chain in co-op
//=============================================================================
// Map111 EV62 "Touch it" counts the contestants in the party (CE50 -> V34);
// two or more start the chain where each companion turns into a moonscorched
// boss (V799 -> EV617). In co-op a party is its player's own character, but
// the host's party keeps a companion recruited before the session (an old
// save, FH_CoopBattle "the host's own party"): that chain must not start.
// User decision 2026-10-22: co-op blocks it.
$.TOWER_GATE = { countVar: 34 }; // (the door: $.TOWER_MAP / $.TOWER_EVENT, FH_CoopBattle)

var _command111Gate = Game_Interpreter.prototype.command111;
Game_Interpreter.prototype.command111 = function() {
    var p = this._params;
    if ($.role && p[0] === 1 && p[1] === $.TOWER_GATE.countVar && p[2] === 0 && p[4] === 1 &&
            $gameMap.mapId() === $.TOWER_MAP && this._eventId === $.TOWER_EVENT && $.fxShared()) {
        if ($gameVariables.value(p[1]) >= p[3]) $.dlog('tower gate: a companion in the party, no chain in co-op');
        this._branch[this._indent] = false;
        this.skipBranch();
        return true;
    }
    return _command111Gate.call(this);
};

//=============================================================================
// The endings: B / C are the winner's alone; the end of an ending
//=============================================================================
// User decision (2026-10-29, plan A): the dead (the ghosts, a dead host too)
// do not follow a winner through the opened tower door. The winner (a guest)
// plays B / C on its own PC (Map119 -> 120 -> 146 -> 154 / 163 -> 161), so the
// host's PC never runs those maps with the dead host's character (Map120
// EV119, Map146 EV7, Perkele's fight) and never takes the winner back into
// its world. A ghost takes no door of an ending map either: ending A goes on
// as the host's scene (Map143 EV46 is the host's step). Plan B (2026-10-30,
// "The ghosts watch the winner's ending" below): a dead guest at the opened
// door asks the host and watches on the winner's PC; a dead host stays out.
// B / C: the tower (119, 120), Perkele (146), the endings (154, 163) and the
// last scene (161); A also falls through 162 and 143.
$.ENDING_WATCH_MAPS = { 119: true, 120: true, 146: true, 154: true, 163: true, 161: true };
$.ENDING_MAPS = Object.assign({ 162: true, 143: true }, $.ENDING_WATCH_MAPS);
$.TOWER_GHOST_TEXT = 'Only the living may pass.';
$.TOWER_OPEN_SWITCH = 4188; // Map111 EV62 p7 (the opened door's step)
// A dead host at the opened door with no winner's ending to watch
$.TOWER_HOST_TEXT = 'O, you don\'t have the right.';

// (FH_CoopBattle ghostTryDoor; the tower's line once a second)
$.ghostDoorBarred = function(ev) {
    if (!$.role || !$gameMap || !ev) return '';
    if ($.isTowerDoor(ev)) {
        if (!$.towerGhostToldAt || $.clockMs() - $.towerGhostToldAt > 1000) {
            $.towerGhostToldAt = $.clockMs();
            // a dead guest at the opened door: the host lets it watch (or says no)
            var open = $gameSwitches.value($.TOWER_OPEN_SWITCH);
            if ($.isGuest() && $.conn && open) $.conn.send({ t: 'endingWatch' });
            else if (!($.isHost() && open && $.hostWatchStart())) {
                $.fieldGab($.isHost() && open ? $.TOWER_HOST_TEXT : $.TOWER_GHOST_TEXT);
            }
        }
        return 'the tower is for the living';
    }
    return $.ENDING_MAPS[$gameMap.mapId()] ? 'an ending map' : '';
};

// Every ending ends at Map161 EV1 page 5: the last line, then GAMEOVER (the
// original's only way from an ending back to the title). In co-op that game
// over was the host's down (FH_CoopBattle): ending A stood still on a black
// map, B / C said "the host died". User decision (2026-10-29): it ends the
// session. Every PC goes to the title (the host through the original's game
// over screen when it ran the ending), nobody is put down. Run on a guest's
// PC (a B / C winner), the host is told and ends it the same way.
$.ENDING_END = { m: 161, e: 1 };
$.ENDING_OVER_TEXT = 'The end. The session is over.';

$.isEndingGameOver = function(interp) {
    return !!$gameMap && $gameMap.mapId() === $.ENDING_END.m && interp._mapId === $.ENDING_END.m &&
        interp._eventId === $.ENDING_END.e && !$gameParty.inBattle();
};

// Guest: how long the ending's last frame waits for the host's lobby before
// this PC goes to the title alone (the host gone, the message lost).
$.ENDING_OVER_WAIT_MS = 10000;

// Outermost: before the down, the dooms and the spent page (FH_CoopBattle)
var _command353Ending = Game_Interpreter.prototype.command353;
Game_Interpreter.prototype.command353 = function() {
    if (!$.role || !$.isEndingGameOver(this) || !$.fxShared()) return _command353Ending.call(this);
    if ($.isHost()) {
        this._index = this._list.length;
        $.endingOver('host');
        return true;
    }
    // A guest's PC waits here for the lobby: its scene does not change, and
    // a finished page 5 (autorun, self switch C) started again at once - the
    // last line again, endingOver again (review M1).
    // (its last world writes - the unlocks - reach the host first)
    $.flushWorldGuest();
    $.conn.send({ t: 'endingOver' });
    $.dlog('the ending is over on this PC: the host ends the session');
    this._fhEndingAt = $.clockMs();
    this.setWaitMode('fhEndingOver');
    return true;
};

var _updateWaitModeEnding = Game_Interpreter.prototype.updateWaitMode;
Game_Interpreter.prototype.updateWaitMode = function() {
    if (this._waitMode !== 'fhEndingOver') return _updateWaitModeEnding.call(this);
    if (!this._fhEndingAlone && $.clockMs() - (this._fhEndingAt || 0) > $.ENDING_OVER_WAIT_MS) {
        this._fhEndingAlone = true;
        $.dlog('the ending is over: no lobby from the host in', $.ENDING_OVER_WAIT_MS / 1000, 's - to the title alone');
        SceneManager.goto(Scene_Title);
    }
    return true;
};

// Host: the session's game ends with the ending (by: who ran it).
$.endingOver = function(by) {
    if (!$.isHost()) return;
    var label = $.playerLabel(by); // (before the session's end lets go of the picks)
    $.dlog('the ending is over (' + label + '): the session ends, everyone to the title');
    $.downs = {};
    $.clients.forEach(function(c) { c.send({ t: 'toast', text: 'Co-op: ' + $.ENDING_OVER_TEXT }); });
    // the host did not see that ending: whose it was
    if (by !== 'host') $.toast('Co-op: ' + label + ' reached the end. The session is over.');
    if ($.endSessionGame) $.endSessionGame('the ending is over');
    if (by === 'host') $.realGameOver(); else SceneManager.goto(Scene_Title);
};

$.hostHandlers.endingOver = function(conn) {
    if (!conn.roam) return; // (an ending runs on a PC that runs its own map)
    $.endingOver(conn.guestId);
};

//=============================================================================
// The ghosts watch the winner's ending (plan B, user decision 2026-10-29)
//=============================================================================
// A guest who won B / C plays the ending on its own PC (a roaming guest on
// Map119 -> 120 -> 146 -> 154 / 163 -> 161). A dead guest at the opened tower
// door (its PC: ghostDoorBarred above) asks the host; the host makes it a
// guest of the winner's PC, as a sub-host's guest (a thin client of that PC,
// "Two guests on one map"), standing at the winner's spot. It sees that PC's
// map, scenes, dialogue (read only: the winner answers), pictures, music and
// the credits. It runs nothing: a ghost starts no event and takes no door of
// an ending map. Each of the winner's transfers takes its watchers along (a
// sub-host gives its guests back when it leaves a map: not these), with the
// new map's snapshot once it is set up. The ending's last game over ends the
// session as before (everyone to the title). A watcher goes back to the
// host's world when the winner's PC refuses it (in a transfer or a fight),
// gives it back, or drops. A dead host runs the world and cannot be a guest
// of another PC: it is sent the winner's screen ($.hostWatchStart).
$.ENDING_WATCH_FIGHT_TEXT = ' is in a fight. Come back after it.';
$.ENDING_WATCH_RETRY_TEXT = 'Not now. Try again.';

// Host: the winner playing B / C on its own PC, or null.
$.endingWinnerConn = function() {
    var found = null;
    $.activeGuests().forEach(function(c) {
        if (found || !c.roam || c.subOf || c.roamPending || !c.lastPos || !$.ENDING_WATCH_MAPS[c.lastPos.m]) return;
        if (!$.isDead(c.guestId)) found = c;
    });
    return found;
};

$.hostHandlers.endingWatch = function(conn) {
    if (!conn.inGame || conn.solo || conn.roam || conn.roamPending || conn.subOf || !$.isDead(conn.guestId)) return;
    var w = $.endingWinnerConn();
    if (!w) return conn.send({ t: 'gab', text: $.TOWER_GHOST_TEXT });
    if (w.inBattle) return conn.send({ t: 'gab', text: $.playerLabel(w.guestId) + $.ENDING_WATCH_FIGHT_TEXT });
    var p = w.lastPos;
    var msg = {
        t: 'subAdd', id: conn.guestId, name: conn.name, actorId: conn.actorId,
        actor: $.actorJson($gameActors.actor(conn.actorId)), inv: $.inventoryOf(conn), hx: $.boardOf(conn),
        pos: { m: p.m, x: p.x, y: p.y, d: p.d || 2 }, interp: null, watch: 1
    };
    conn.subOf = w.guestId;
    conn._watchOf = w.guestId;
    delete $.remotes[conn.guestId];
    w.send(msg);
    $.dlog('ending watch:', conn.name, 'follows', w.name, 'into map', p.m);
};

// Host: a watcher back in the host's world, next to the host's player.
$.watchBack = function(c, why) {
    var p = $.realPlayer || $gamePlayer;
    c._watchOf = null;
    c.subOf = null;
    c._placeAt = { m: $gameMap.mapId(), x: p.x, y: p.y, d: p.direction() };
    $.dlog('ending watch:', c.name, 'back in the host\'s world (' + why + ')');
    $.sendSnapshot(c);
};

$.isWatcherOf = function(c, conn) {
    return !!c && !!c._watchOf && c.subOf === conn.guestId && c._watchOf === conn.guestId;
};

var _subRefuseWatch = $.hostHandlers.subRefuse;
$.hostHandlers.subRefuse = function(conn, msg) {
    var c = $.clientById(msg.id);
    if (!$.isWatcherOf(c, conn)) return _subRefuseWatch(conn, msg);
    // it never left: the world it missed meanwhile comes with the next sync
    c._watchOf = null;
    c.subOf = null;
    c._fhResyncWant = 'ending watch refused';
    $.dlog('ending watch:', c.name, 'refused by', conn.name);
    c.send({ t: 'gab', text: $.ENDING_WATCH_RETRY_TEXT });
};

// (a sub-host's 'roam' would let a ghost run a map of its own)
var _subRelayWatch = $.hostHandlers.subRelay;
$.hostHandlers.subRelay = function(conn, msg) {
    var c = msg && $.clientById(msg.to);
    if ($.isWatcherOf(c, conn) && msg.m && msg.m.t === 'roam') return $.watchBack(c, 'given back by ' + conn.name);
    _subRelayWatch(conn, msg);
};

var _onGuestClosedWatch = $.onGuestClosed;
$.onGuestClosed = function(conn) {
    var back = $.clients.filter(function(c) { return c !== conn && $.isWatcherOf(c, conn); });
    back.forEach(function(c) { c.subOf = null; }); // (not given a map of its own below)
    _onGuestClosedWatch(conn);
    // (not when its leaving ended the session's game: the watchers went to
    // the lobby, a snapshot now took them back into it - review 2026-11-06)
    back.forEach(function(c) {
        if ($.clients.indexOf(c) >= 0 && $.hostInGame) $.watchBack(c, conn.name + ' is gone');
    });
};

var _resetRoamsWatch = $.resetRoams;
$.resetRoams = function() {
    if ($.hostWatch) $.hostWatchStop('the session game is over');
    $.clients.forEach(function(c) { c._watchOf = null; });
    _resetRoamsWatch();
};

// A dead host watches too (user 2026-11-10, reversing 2026-10-30): the winner's
// world cannot come here as it does for a ghost guest, because this PC runs the
// session's world and passes everyone's messages. The winner's PC sends what its
// screen shows instead, one picture each time the host asks for the next, so a
// slow line only lowers the rate. Nothing of the world changes here.
$.EW_FRAMES = 15;      // at most 4 pictures a second
$.EW_WIDTH = 600;
$.EW_QUALITY = 0.6;
$.EW_HINT = 'Esc: stop watching';
// The picture covers the game, so no key may act behind it (F9 would open the
// load screen unseen). These three belong to the window: F4, F5, F12.
$.EW_WINDOW_KEYS = { 115: 1, 116: 1, 123: 1 };
$.hostWatch = null;    // host: { from, img, hint, onKey, au }

$.hostWatchStart = function() {
    if ($.hostWatch) return true;
    if (!$.isHost() || !$.isDead('host') || typeof document === 'undefined') return false;
    var w = $.endingWinnerConn();
    if (!w) return false;
    var img = document.createElement('img');
    img.id = 'fhcoop-endwatch';
    img.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;object-fit:contain;background:#000;z-index:101;';
    var hint = document.createElement('div');
    hint.id = 'fhcoop-endwatch-hint';
    hint.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:102;color:#ccc;font:14px sans-serif;';
    hint.textContent = $.ko($.EW_HINT);
    document.body.appendChild(img);
    document.body.appendChild(hint);
    var onKey = function(e) {
        if ($.EW_WINDOW_KEYS[e.keyCode]) return;
        e.stopPropagation();
        e.preventDefault();
        if (e.keyCode === 27 || e.keyCode === 88) $.hostWatchStop('closed');
    };
    document.addEventListener('keydown', onKey, true);
    $.hostWatch = { from: w.guestId, img: img, hint: hint, onKey: onKey, au: $.audioInfo() };
    w.send({ t: 'ewAsk', on: true });
    $.dlog('ending watch: the dead host watches', w.name);
    return true;
};

$.hostWatchStop = function(why) {
    var h = $.hostWatch;
    if (!h) return;
    $.hostWatch = null;
    document.removeEventListener('keydown', h.onKey, true);
    [h.img, h.hint].forEach(function(el) { if (el.parentNode) el.parentNode.removeChild(el); });
    var c = $.clientById(h.from);
    if (c) c.send({ t: 'ewAsk', on: false });
    $.applyAudio(h.au);
    $.dlog('ending watch: the host stops watching (' + why + ')');
};

$.hostHandlers.ewShot = function(conn, msg) {
    var h = $.hostWatch;
    if (!h || !msg || h.from !== conn.guestId) return;
    if (msg.img) h.img.src = msg.img;
    if (msg.au) $.applyAudio(msg.au);
    conn.send({ t: 'ewAsk', on: true });
};

var _canMoveHostWatch = Game_Player.prototype.canMove;
Game_Player.prototype.canMove = function() {
    if ($.hostWatch && this === ($.realPlayer || $gamePlayer)) return false; // (not a guest's stand-in)
    return _canMoveHostWatch.call(this);
};

// No menu behind the picture: a pad's menu button or a right click closes it.
var _updateCallMenuHostWatch = Scene_Map.prototype.updateCallMenu;
Scene_Map.prototype.updateCallMenu = function() {
    if (!$.hostWatch) return _updateCallMenuHostWatch.call(this);
    if (this.isMenuCalled()) $.hostWatchStop('closed');
};

var _endingOverHostWatch = $.endingOver;
$.endingOver = function(by) {
    $.hostWatchStop('the ending is over');
    _endingOverHostWatch(by);
};

var _onGuestClosedHostWatch = $.onGuestClosed;
$.onGuestClosed = function(conn) {
    if ($.hostWatch && $.hostWatch.from === conn.guestId) $.hostWatchStop(conn.name + ' is gone');
    _onGuestClosedHostWatch(conn);
};

// The winner's PC: the next picture, after the host asked for it.
$.ewWant = false;
$.ewAt = 0;
$.ewAu = '';

$.guestHandlers.ewAsk = function(msg) {
    $.ewWant = !!(msg && msg.on);
    if (!$.ewWant) $.ewAu = '';
};

$.ewCapture = function() {
    var snap = Bitmap.snap(SceneManager._scene);
    var out = document.createElement('canvas');
    out.width = $.EW_WIDTH;
    out.height = Math.round($.EW_WIDTH * snap.height / snap.width);
    var ctx = out.getContext('2d');
    ctx.drawImage(snap.canvas, 0, 0, out.width, out.height);
    // (a movie plays in its own element over the game: Map146's moon scene)
    if (Graphics.isVideoPlaying()) ctx.drawImage(Graphics._video, 0, 0, out.width, out.height);
    return out.toDataURL('image/jpeg', $.EW_QUALITY);
};

$.ewShotFrame = function() {
    if (!$.ewWant || !$.conn || !SceneManager._scene || Graphics.frameCount - $.ewAt < $.EW_FRAMES) return;
    $.ewWant = false; // (the next one when this one has arrived)
    $.ewAt = Graphics.frameCount;
    var msg = { t: 'ewShot' };
    try {
        msg.img = $.ewCapture();
    } catch (e) {
        $.dlog('ending watch: no picture', String(e && e.message || e)); // (the host asks again)
    }
    var au = JSON.stringify($.audioInfo());
    if (au !== $.ewAu) {
        $.ewAu = au;
        msg.au = $.audioInfo();
    }
    $.conn.send(msg);
};

var _renderSceneEw = SceneManager.renderScene;
SceneManager.renderScene = function() {
    _renderSceneEw.call(this);
    if ($.ewWant && this.isCurrentSceneStarted()) $.ewShotFrame(); // (a scene still loading has no picture)
};

// A map a guest runs (roaming, or a sub-host): the field NPC of every other
// player's character is hidden there too, as on the host's map (FH_Coop
// $.hideTakenNpc). It was not: on its own map a guest met the NPC of the host's
// or a friend's character (isHost audit 2026-11-10, user: "why leave it?").
// The players: the session roster; its own character is the original's to handle.
$.ROAM_NPC_FRAMES = 30;
$.roamNpcKey = '';
$.roamNpcFor = null;
$.roamTakenPrep = function() {
    var keys = [], sels = [];
    ($.roster || []).forEach(function(r) {
        var a = Number(r && r.a);
        if (!a || a === $.myActorId || !$dataActors[a]) return;
        keys.push($dataActors[a].characterName.replace(/^[!$%]+/, '').replace(/\d+$/, ''));
        if ($.SELECT_OF_ACTOR[a]) sels.push($.SELECT_OF_ACTOR[a]);
    });
    $.takenSelects = sels;
    return keys.length ? new RegExp('^[!$%]*(' + keys.join('|') + ')(\\d|_|$)') : null;
};
$.hideRoamNpcs = function() {
    if (!$.isGuest() || !$.isRoaming() || !$gameMap || !$gameMap.mapId() || $.ctx) return;
    if (Graphics.frameCount % $.ROAM_NPC_FRAMES !== 0) return;
    var re = $.roamTakenPrep();
    if (!re) return;
    $gameMap.events().forEach(function(ev) { $.hideTakenNpc(ev, re); });
    var key = re.source + '/' + $gameMap.mapId();
    if (key !== $.roamNpcKey) {
        $.roamNpcKey = key;
        $.dlog('this map: the other players\' characters as NPCs hidden (' + re.source + ')');
    }
};
var _sceneMapUpdateRoamNpc = Scene_Map.prototype.update;
Scene_Map.prototype.update = function() {
    _sceneMapUpdateRoamNpc.call(this);
    $.hideRoamNpcs();
};

// The winner's PC ---------------------------------------------------------------

$.watchersHere = function() {
    return $.clients.filter(function(v) { return v._sub && v._watch; });
};

var _subAddWatch = $.guestHandlers.subAdd;
$.guestHandlers.subAdd = function(msg) {
    if (msg && msg.watch && $gameParty.inBattle()) {
        if ($.conn) $.conn.send({ t: 'subRefuse', id: msg.id });
        return;
    }
    _subAddWatch(msg);
    var v = msg && msg.watch ? $.clientById(msg.id) : null;
    if (v && v._sub) {
        v._watch = true;
        $.dlog('ending watch:', msg.name, 'watches here');
    }
};

// Leaving a map: the watchers come along (the others are given back as before).
var _leaveGuestsBehindWatch = $.leaveGuestsBehind;
$.leaveGuestsBehind = function(newMapId) {
    var watchers = $.isHost() ? [] : $.watchersHere();
    if (!watchers.length) return _leaveGuestsBehindWatch(newMapId);
    $.clients = $.clients.filter(function(v) { return watchers.indexOf(v) < 0; });
    try {
        _leaveGuestsBehindWatch(newMapId);
    } finally {
        $.clients = $.clients.concat(watchers);
    }
    watchers.forEach(function(v) {
        delete $.remotes[v.guestId];
        v._watchMove = true;
    });
    $.dlog('ending watch: the watchers come along to map', newMapId);
};

// ... and get the new map once it is set up, at this PC's spot.
$.guestExtras.push(function() {
    if ($.isHost() || !$.subHosting() || !$gamePlayer || $gamePlayer.isTransferring() ||
            SceneManager.isSceneChanging() || !(SceneManager._scene instanceof Scene_Map)) return;
    $.clients.forEach(function(v) {
        if (!v._sub || !v._watchMove) return;
        v._watchMove = false;
        v._placeAt = { m: $gameMap.mapId(), x: $gamePlayer.x, y: $gamePlayer.y, d: $gamePlayer.direction() };
        v.lastPos = Object.assign({}, v.lastPos || {}, v._placeAt, { id: v.guestId });
        $.applyRemote(v.guestId, v.lastPos);
        $.subSendSnapshot(v);
    });
});

// The winner's scenes are shown to its watchers (read only: nobody else
// answers). Only the host shares dialogue otherwise (FH_Coop).
$.watchShare = function(interp) {
    if ($.isHost() || !$.subHosting() || $gameMessage.isBusy() || !$.watchersHere().length) return;
    $.msgShared = !interp._fhOwner && !$gameParty.inBattle();
    $.msgOwner = null;
};

var _command101Watch = Game_Interpreter.prototype.command101;
Game_Interpreter.prototype.command101 = function() {
    $.watchShare(this);
    return _command101Watch.call(this);
};

var _command102Watch = Game_Interpreter.prototype.command102;
Game_Interpreter.prototype.command102 = function() {
    $.watchShare(this);
    return _command102Watch.call(this);
};

var _command105Watch = Game_Interpreter.prototype.command105;
Game_Interpreter.prototype.command105 = function() {
    $.watchShare(this);
    return _command105Watch.call(this);
};

// (two same lines in a row are two messages there too: FH_Coop messageInfo id)
var _clearMessageWatch = Game_Message.prototype.clear;
Game_Message.prototype.clear = function() {
    _clearMessageWatch.call(this);
    if ($.role && !$.isHost() && $.subHosting() && $.watchersHere().length) $.msgClears++;
};

//=============================================================================
// The B / C winner inherits (hidden, user decision 2026-10-29)
//=============================================================================
// Not in the patch notes. When the tower door opens for the last one (Map111
// EV62 "Touch it" with V201 <= 1 turns SW4181 on: the original's opening),
// that player gets everything the dead players had, for Perkele: each one's
// bag (items, weapons, armors, gold), what its character wore (into the
// winner's bag, not put on) and the souls it owned (coopData().souls: the
// switch goes to the winner's character; its board and Absorb are the
// winner's). The dead: everyone in coopData().dead - the ghosts (a dead host
// too), the ones the tower vote counted dead, the ones killed in a duel (the
// tower's or one to the death). Their bags are the host's copies (a dead
// guest is back in the host's game; one not connected: its saved bag; a dead
// loser's late duel report brings the bag its duel left it - FH_CoopBattle),
// and are taken once. Their bags and gear are empty afterwards, and stay so:
// a dead player's own copy (a menu it had open) does not bring them back
// (coopData().stripped: name -> true, saved; what a body search may read).
// The winner: the one who opened the door (coopData().doorBy: the guest whose
// event or own world turned SW4181 on, else the host), if it lives; else the
// only one not dead.
// The host does it once (coopData().inherit, saved): the switch is a world
// value, so it sees the door open on any PC (its own events, a thin guest's
// event in its world, a roaming guest's own world through wDelta). A load of
// a save from before the door has the dead players' things again and the
// door shut; a load of one from after does not do it again. What the winner
// gets goes where its bag is (as the soul stones' gifts do): the host's party,
// a thin guest's copy on the host (not while its own PC fights: that report
// would put the bag back), a roaming guest's own PC ('inherit'; back to the
// host's copy if it is in the host's game by then), a sub-host's guest on its
// sub-host ('subInherit'; back if that guest fights there), one not connected
// into its saved bag. Sent to another PC it stays in the save until that PC
// says it has it ('inheritAck'; again after INHERIT_RESEND_MS, a PC that has
// it already only answers: the id). A count over the engine's maximum (99
// of one item) is cut there: the rest is lost. The winner sees one line.
$.INHERIT_SWITCH = 4181; // tower_door_opened (Map111 EV62 page 0, V201 <= 1)
$.INHERIT_TEXT = 'You take what the others left behind.';
$.INHERIT_RESEND_MS = 10000; // (real time) a gift sent and not answered goes again

$.emptyGift = function() {
    return { i: {}, w: {}, a: {}, g: 0 };
};

// gift += from (no limit: a gift is a list of counts)
$.addGift = function(to, from) {
    ['i', 'w', 'a'].forEach(function(k) {
        to[k] = to[k] || {};
        Object.keys((from && from[k]) || {}).forEach(function(id) {
            var n = Math.floor(Number(from[k][id]) || 0);
            if (n > 0) to[k][id] = (to[k][id] || 0) + n;
        });
    });
    to.g = (Number(to.g) || 0) + Math.max(0, Math.floor(Number(from && from.g) || 0));
};

// A real bag += gift: each count at most the engine's maximum (99), the gold
// at most its maximum. Returns how many did not fit (lost).
$.addToBag = function(bag, gift) {
    var lost = 0;
    [['i', $dataItems], ['w', $dataWeapons], ['a', $dataArmors]].forEach(function(kd) {
        var k = kd[0], data = kd[1];
        bag[k] = bag[k] || {};
        Object.keys((gift && gift[k]) || {}).forEach(function(id) {
            var n = Math.floor(Number(gift[k][id]) || 0);
            if (n <= 0) return;
            var max = data && data[id] ? $gameParty.maxItems(data[id]) : 99;
            var now = bag[k][id] || 0;
            var to = Math.max(now, Math.min(max, now + n));
            lost += now + n - to;
            if (to > 0) bag[k][id] = to;
        });
    });
    var g = Math.max(0, Math.floor(Number(gift && gift.g) || 0));
    bag.g = Math.min($gameParty.maxGold(), (Number(bag.g) || 0) + g);
    return lost;
};

$.giftSize = function(gift) {
    var n = gift && gift.g > 0 ? 1 : 0;
    ['i', 'w', 'a'].forEach(function(k) { n += Object.keys((gift && gift[k]) || {}).length; });
    return n;
};

// A dead player whose things the B / C winner took.
$.strippedDead = function(name) {
    return !!name && !!($.coopData().stripped || {})[name];
};

// The one the door opened for: the name that opened it while it lives, else
// the only one not dead (a name: '#host' for the host), or ''.
$.inheritHeir = function() {
    var dead = $.coopDead(), by = $.coopData().doorBy;
    if (by && !dead[by] && (by === $.nameOf('host') ? $.hostHasChosen() : !!$.assignments()[by])) return by;
    var names = [];
    if ($.hostHasChosen() && !dead[$.nameOf('host')]) names.push($.nameOf('host'));
    Object.keys($.assignments()).forEach(function(name) {
        if (!dead[name] && names.indexOf(name) < 0) names.push(name);
    });
    return names.length === 1 ? names[0] : '';
};

$.actorOfName = function(name) {
    if (name === $.nameOf('host')) return $.realHostActorId();
    return Number($.assignments()[name]) || 0;
};

// Host: who turned the door's switch on (its own world: the guest whose event
// runs, else the host; a roaming guest's world: below).
var _swSetInherit = Game_Switches.prototype.setValue;
Game_Switches.prototype.setValue = function(id, value) {
    var opening = id === $.INHERIT_SWITCH && !!value && this === $gameSwitches && !this._data[id];
    var opens = opening && $.isHost();
    _swSetInherit.call(this, id, value);
    if (opens && this._data[id]) $.coopData().doorBy = $.ctx && $.ctx.name ? $.ctx.name : $.nameOf('host');
    // a sub-host: its guest's event opened it - the host hears whose before its
    // world delta (that came as the sub-host's own: isHost audit 2026-11-10)
    if (opening && !$.isHost() && $.subHosting() && $.ctx && $.ctx._sub && $.conn && this._data[id]) {
        $.conn.send({ t: 'subDoorBy', who: $.ctx.guestId });
    }
};

$.subDoorBy = null; // host: { who: name, sub: the sub-host's id }
$.hostHandlers.subDoorBy = function(conn, msg) {
    var c = msg && $.clientById(msg.who);
    if (!c || c.subOf !== conn.guestId || !c.name) return; // (only a sub-host for its own guest)
    $.subDoorBy = { who: c.name, sub: conn.guestId };
};

var _wDeltaInherit = $.hostHandlers.wDelta;
$.hostHandlers.wDelta = function(conn, msg) {
    var opens = !!conn && !!conn.name && !!msg && !!msg.sw && !!msg.sw[$.INHERIT_SWITCH] &&
        !$gameSwitches._data[$.INHERIT_SWITCH];
    var sub = $.subDoorBy && conn && $.subDoorBy.sub === conn.guestId ? $.subDoorBy.who : '';
    if (opens) $.subDoorBy = null;
    _wDeltaInherit(conn, msg);
    if (opens && $gameSwitches._data[$.INHERIT_SWITCH]) $.coopData().doorBy = sub || conn.name;
};

// A dead player's bag and gear, emptied into gift.
$.takeLeftBehind = function(name, gift) {
    var host = name === $.nameOf('host');
    // (a thin guest searching the host's body: in its context the party is its own)
    var own = host && $.ctx && $.ctxSave ? $.ctxSave : null;
    var bag = own ? { i: own.items, w: own.weapons, a: own.armors, g: own.gold } :
        host ? { i: $gameParty._items, w: $gameParty._weapons, a: $gameParty._armors, g: $gameParty._gold } :
        $.guestInventory(name);
    $.addGift(gift, bag);
    if (own) {
        own.items = {};
        own.weapons = {};
        own.armors = {};
        own.gold = 0;
    } else if (host) {
        $gameParty._items = {};
        $gameParty._weapons = {};
        $gameParty._armors = {};
        $gameParty._gold = 0;
    } else {
        bag.i = {};
        bag.w = {};
        bag.a = {};
        bag.g = 0;
    }
    var data = $.coopData();
    data.stripped = data.stripped || {};
    data.stripped[name] = true;
    var actor = $gameActors.actor($.actorOfName(name));
    if (!actor) return;
    var worn = { i: {}, w: {}, a: {}, g: 0 };
    $.countEquips(actor, worn.w, worn.a);
    $.addGift(gift, worn);
    actor._equips.forEach(function(slot) { if (slot) slot.setObject(null); });
    actor.refresh();
};

// Its things are the winner's now: the copy a dead player's PC sends back
// (its menu closing) does not put them back on it or in its bag.
var _syncMeStripped = $.hostHandlers.syncMe;
$.hostHandlers.syncMe = function(conn, msg) {
    if (conn && conn.name && $.isDead(conn.guestId) && $.strippedDead(conn.name)) {
        conn._menuBase = null;
        conn._lastMeKey = null;
        $.pushMe(conn);
        return;
    }
    return _syncMeStripped(conn, msg);
};

$.inheritNow = function() {
    var data = $.coopData();
    var heir = $.inheritHeir();
    if (!heir) return;
    data.inherited = true;
    var heirActor = $.actorOfName(heir);
    var gift = $.emptyGift(), from = [], souls = 0;
    var dead = $.coopDead(), owners = $.soulOwnerMap();
    Object.keys(dead).forEach(function(name) {
        if (!dead[name] || name === heir) return;
        var deadActor = $.actorOfName(name);
        $.takeLeftBehind(name, gift);
        Object.keys(owners).forEach(function(sw) {
            if (deadActor && owners[sw] === deadActor && heirActor) {
                owners[sw] = heirActor;
                souls++;
            }
        });
        from.push(name);
    });
    if (souls) $.broadcastSouls();
    // the dead connected ones see their empty bags
    $.clients.forEach(function(c) {
        if (c.name && dead[c.name] && c.actorId) {
            c._menuBase = null;
            c._lastMeKey = null;
            $.pushMe(c);
        }
    });
    if ($.isDead('host') && $gamePlayer) $gamePlayer.refresh();
    var size = $.giftSize(gift);
    $.dlog('the tower opened for', heir, '- takes from', from.join(', ') || 'nobody', ':', JSON.stringify(gift),
        souls ? '(' + souls + ' souls)' : '');
    if (!size && !souls) return;
    data.inherit = { id: $.newInheritId(), to: heir, gift: gift, line: true };
    $.deliverInherit();
};

$.inheritSeq = 0;
$.newInheritId = function() {
    return 'i' + ($.soulGen || 0) + '.' + Math.round($.clockMs()) + '.' + (++$.inheritSeq);
};

$.inheritLost = function(lost, to) {
    if (lost > 0) $.dlog('inherit:', lost, 'over the maximum of an item - lost (' + to + ')');
};

// Where the winner's bag is now (not yet: it fights on its own PC, or the
// gift waits for that PC's answer). The same way for the other parcels of
// things (coopData().parcels: a body searched, "Bodies as events" below):
// { id, to, gift, line, text }.
$.deliverInherit = function() {
    var data = $.coopData();
    if (data.inherit && $.deliverParcel(data.inherit)) delete data.inherit;
    if (data.parcels && data.parcels.length) {
        data.parcels = data.parcels.filter(function(p) { return !$.deliverParcel(p); });
    }
};

$.parcelText = function(p) {
    return p.line ? p.text || $.INHERIT_TEXT : '';
};

// true: done (it is in that bag now)
$.deliverParcel = function(p) {
    if (!p.id) p.id = $.newInheritId();
    var gift = p.gift || $.emptyGift();
    var text = $.parcelText(p);
    if (p.to === $.nameOf('host')) {
        if ($.ctx) return false; // (the host's own bag is put aside in a guest's context)
        $.giveHostGift(gift);
        if (text) $.fieldGab(text);
        return true;
    }
    var c = $.clients.filter(function(x) { return x.name === p.to && !x._sub; })[0];
    if (!c) {
        $.inheritLost($.addToBag($.guestInventory(p.to), gift), p.to);
        $.dlog('inherit: into the saved bag of', p.to, '(not here)');
        return true; // (no line: it was not there to see it)
    }
    if (!c.actorId || !c.inGame || c.solo || c.inBattle) return false;
    var now = $.clockMs();
    // (a time from a save of another run of the game is no wait)
    if (p.sentAt && now >= p.sentAt && now - p.sentAt < $.INHERIT_RESEND_MS) return false;
    if (p.wait && now < p.wait && p.wait - now <= $.SOUL_RETRY_MS) return false;
    if (c.subOf) {
        var owner = $.clientById(c.subOf);
        if (!owner) return false;
        p.sentAt = now;
        owner.send({ t: 'subInherit', id: p.id, who: c.guestId, gift: gift, line: !!p.line, text: text });
    } else if (c.roam) {
        p.sentAt = now;
        c.send({ t: 'inherit', id: p.id, gift: gift, line: !!p.line, text: text, gen: $.soulGen });
    } else {
        $.inheritLost($.addToBag($.inventoryOf(c), gift), c.name);
        c._lastMeKey = null;
        $.pushMe(c);
        if (text) c.send({ t: 'gab', text: text });
        $.dlog('inherit: for', c.name);
        return true;
    }
    $.dlog('inherit: for', c.name, c.subOf ? '(on a sub-host)' : '(its own PC)');
    return false;
};

// The parcel with that id (the door's or a body's).
$.parcelById = function(id) {
    var data = $.coopData();
    if (!id) return null;
    if (data.inherit && data.inherit.id === id) return data.inherit;
    return (data.parcels || []).filter(function(p) { return p.id === id; })[0] || null;
};

$.giveHostGift = function(gift) {
    var party = $gameParty;
    var bag = { i: party._items, w: party._weapons, a: party._armors, g: party._gold };
    $.inheritLost($.addToBag(bag, gift), 'this PC');
    party._gold = bag.g;
    if ($gamePlayer) $gamePlayer.refresh();
};

$.inheritFrame = function() {
    if (!$.isHost() || !$.hostInGame || !$gameSystem || $.ctx) return;
    var data = $.coopData();
    if (data.inherit || (data.parcels && data.parcels.length)) $.deliverInherit();
    if (!data.inherited && $gameSwitches.value($.INHERIT_SWITCH)) $.inheritNow();
};
$.worldExtras.push(function() { $.inheritFrame(); });

// The winner's PC (or its sub-host) has it: done.
$.hostHandlers.inheritAck = function(conn, msg) {
    var data = $.coopData(), p = msg && $.parcelById(msg.id);
    if (!p) return;
    if (data.inherit === p) delete data.inherit;
    else data.parcels = data.parcels.filter(function(x) { return x !== p; });
    $.dlog('inherit: taken by', p.to);
};

// It could not take it there (back in the host's game, fighting on its
// sub-host's map): again where it is a moment later.
$.inheritAgain = function(msg) {
    var p = msg && $.parcelById(msg.id);
    if (!p) return;
    p.sentAt = 0;
    p.wait = $.clockMs() + $.SOUL_RETRY_MS;
};

$.hostHandlers.inheritBack = function(conn, msg) {
    if (!msg || $.soulBackOld(msg)) return;
    $.inheritAgain(msg);
};

$.hostHandlers.subInheritBack = function(conn, msg) {
    $.inheritAgain(msg);
};

// Guest running its own map: its bag is here.
$.inheritLater = []; // ones that came while its own map was on the way
$.inheritGot = {}; // ids put in this PC's bags (one sent again is only answered)
$.guestHandlers.inherit = function(msg) {
    if ($.pendingRoam) {
        $.inheritLater.push(msg);
        return;
    }
    $.takeInherit(msg);
};

$.takeInherit = function(msg) {
    if (!msg || !msg.gift || !$.conn) return;
    if (msg.id && $.inheritGot[msg.id]) {
        $.conn.send({ t: 'inheritAck', id: msg.id });
        return;
    }
    if (!$.isRoaming() || $.roam.leaving || $.pendingSnapshot) {
        // back in the host's game meanwhile: the host's copy is the bag
        $.conn.send({ t: 'inheritBack', id: msg.id, gen: msg.gen });
        return;
    }
    if (msg.id) $.inheritGot[msg.id] = true;
    $.giveHostGift(msg.gift); // (its own party)
    if (msg.line) $.fieldGab(msg.text || $.INHERIT_TEXT);
    if ($.sendRoamMe) $.sendRoamMe(true); // (the host's copy first, then the answer)
    $.conn.send({ t: 'inheritAck', id: msg.id });
};

var _startRoamInherit = $.startRoam;
$.startRoam = function(msg) {
    _startRoamInherit(msg);
    var later = $.inheritLater;
    $.inheritLater = [];
    later.forEach($.takeInherit);
};

var _processPendingSnapshotInherit = $.processPendingSnapshot;
$.processPendingSnapshot = function() {
    var later = $.pendingSnapshot ? $.inheritLater : [];
    if (later.length) $.inheritLater = [];
    _processPendingSnapshotInherit();
    later.forEach(function(msg) {
        if ($.conn) $.conn.send({ t: 'inheritBack', id: msg.id, gen: msg.gen });
    });
};

var _leaveAsGuestInherit = $.leaveAsGuest;
$.leaveAsGuest = function(message) {
    $.inheritLater = [];
    $.inheritGot = {}; // (back later: the host's copy is the bag, a gift not answered comes again)
    _leaveAsGuestInherit(message);
};

// Sub-host: one of its guests' bags is here (not while it fights here: that
// fight's report would put its bag back).
$.guestHandlers.subInherit = function(msg) {
    var v = $.clientById(msg.who);
    if (!msg.gift || !$.conn) return;
    if (msg.id && $.inheritGot[msg.id]) {
        $.conn.send({ t: 'inheritAck', id: msg.id });
        return;
    }
    if (!v || !v._sub || v.inBattle) {
        $.conn.send({ t: 'subInheritBack', id: msg.id, who: msg.who });
        return;
    }
    if (msg.id) $.inheritGot[msg.id] = true;
    $.inheritLost($.addToBag($.inventoryOf(v), msg.gift), v.name);
    v._lastMeKey = null;
    $.pushMe(v);
    $.sendSubMe(v, true); // (the host's copy first, then the answer)
    if (msg.line) v.send({ t: 'gab', text: msg.text || $.INHERIT_TEXT });
    $.conn.send({ t: 'inheritAck', id: msg.id });
};

//=============================================================================
// Bodies as events (user decision 2026-10-29, docs/조사(보관용)/플레이어_시체.md)
//=============================================================================
// A player's body (coopData().corpses, FH_CoopBattle "Bodies") is a map
// event of its own, as a Rher form is: its data goes into that map's
// $dataMap at an id above the map's own (in the record: the same on every
// PC) when the map is set up, a saved or sent event asks for it, or the list
// comes. Its self switches go the shared way. Old saves' bodies (no id) stay
// a picture.
// - 'duel' (it died in a duel, the tower's or one to the death): the
//   original's contestant body of that character - the NPC event's six pages
//   (body, flowers, headless, brain / heart flower, flesh) without their
//   death and place switch conditions, the original's ten-entry menu. Search
//   gives what that player had (its bag and gear, once: a search or the
//   door's inheritance strips it, coopData().stripped), not the NPC's fixed
//   things; its searched mark is self switch B (the original's D is Daan's
//   flesh page).
// - 'plain' (any other death): the original's companion body (the spawn map
//   Map028, page 1: "Here lies ..."), as CE53 makes one.
$.BODY_SOURCE = { // actor -> [map, event, first of the six pages]
    1: [14, 203, 4], 3: [14, 83, 0], 4: [4, 245, 3], 5: [4, 22, 0],
    6: [4, 10, 5], 13: [4, 36, 12], 14: [4, 309, 9], 15: [4, 223, 12]
};
$.BODY_PLAIN_MAP = 28;
$.BODY_PLAIN = { 1: 18, 3: 17, 4: 14, 5: 15, 6: 16, 13: 25, 14: 26, 15: 27 }; // its events (page 1)
$.BODY_SEARCH_TEXT = 'You take what %1 had.';
$.BODY_EMPTY_TEXT = 'Someone has taken everything already.';

// A file of the game's data folder, read now (the tests read theirs).
$.readGameData = function(name) {
    var path = require('path'), fs = require('fs');
    return JSON.parse(fs.readFileSync(path.join(path.dirname(process.mainModule.filename), 'data', name), 'utf8'));
};

$.bodyMaps = {}; // map id -> its data (read once)
$.bodyMapData = function(mapId) {
    if ($.bodyMaps[mapId] !== undefined) return $.bodyMaps[mapId];
    var data = null;
    try {
        data = $.readGameData('Map' + String(mapId).padStart(3, '0') + '.json');
    } catch (e) {
        $.dlog('ERROR body data of map', mapId, String(e));
    }
    $.bodyMaps[mapId] = data;
    return data;
};

$.bodyCopy = function(o) {
    return JSON.parse(JSON.stringify(o));
};

// The six pages of that character's contestant body.
$.bodyDuelPages = function(actorId) {
    var src = $.BODY_SOURCE[actorId];
    var map = src && $.bodyMapData(src[0]);
    var ev = map && map.events[src[1]];
    var pages = ev ? ev.pages.slice(src[2], src[2] + 6).map($.bodyCopy) : [];
    if (pages.length < 6) return null;
    var death = $.DEATH_SWITCH[actorId];
    var c0 = pages[0].conditions;
    var place = [c0.switch1Valid && c0.switch1Id, c0.switch2Valid && c0.switch2Id].filter(function(id) {
        return id && id !== death;
    })[0] || 0;
    pages.forEach(function(p) {
        var c = p.conditions, keep = [];
        if (c.switch1Valid && c.switch1Id !== death && c.switch1Id !== place) keep.push(c.switch1Id);
        if (c.switch2Valid && c.switch2Id !== death && c.switch2Id !== place) keep.push(c.switch2Id);
        c.switch1Valid = keep.length > 0;
        c.switch1Id = keep[0] || 1;
        c.switch2Valid = keep.length > 1;
        c.switch2Id = keep[1] || 1;
        $.bodySearchHook(p.list);
    });
    return pages;
};

// The menu's Search (the second choice box, first entry): "IF self D: nothing
// of value / else: the NPC's things, self D on" becomes "IF self B: the same
// line / else: bodySearch, self B on".
$.bodySearchHook = function(list) {
    var box = list.filter(function(c) { return c.code === 102; })[1];
    if (!box) return;
    var ind = box.indent, at = -1, k;
    for (k = list.indexOf(box) + 1; k < list.length; k++) {
        if (list[k].indent !== ind) continue;
        if (list[k].code === 404) break;
        if (list[k].code === 402 && list[k].parameters[0] === 0) {
            at = k;
            break;
        }
    }
    if (at < 0) return;
    var end = at + 1;
    while (end < list.length && !(list[end].indent === ind && (list[end].code === 402 || list[end].code === 404))) end++;
    var cmd = function(code, params, indent) { return { code: code, indent: indent, parameters: params }; };
    var body = list.slice(at + 1, end);
    var cond = body[0], i411 = -1, i412 = -1;
    body.forEach(function(c, i) {
        if (c.indent === ind + 1 && c.code === 411 && i411 < 0) i411 = i;
        if (c.indent === ind + 1 && c.code === 412 && i412 < 0) i412 = i;
    });
    var search = [cmd(355, ['FH.Coop.bodySearch(this);'], ind + 2), cmd(123, ['B', 0], ind + 2), cmd(0, [], ind + 2)];
    var made;
    if (cond && cond.code === 111 && cond.parameters[0] === 2 && i411 > 0 && i412 > i411) {
        cond.parameters = [2, 'B', 0];
        made = body.slice(0, i411 + 1).concat(search, body.slice(i412));
    } else {
        made = search.map(function(c) { return cmd(c.code, c.parameters, ind + 1); });
    }
    Array.prototype.splice.apply(list, [at + 1, end - at - 1].concat(made));
};

// The companion body ("Here lies ...") gives the dead player's keys to whoever
// touches it (user request 2026-11-02: a key lost with a dead player had the
// game loaded again). The items of the wiki's "Keys" list (game data ids).
// Only those: the rest stays for the tower door's heir.
$.KEY_ITEMS = [20, 131, 199, 205, 209, 222, 238, 241, 261, 262, 263, 264, 272, 276, 290, 344];
$.BODY_KEYS_TEXT = 'You take the keys %1 had.';

$.bodyPlainPages = function(actorId) {
    var map = $.BODY_PLAIN[actorId] && $.bodyMapData($.BODY_PLAIN_MAP);
    var ev = map && map.events[$.BODY_PLAIN[actorId]];
    if (!ev || !ev.pages[1]) return null;
    var page = $.bodyCopy(ev.pages[1]);
    page.conditions.switch1Valid = false;
    page.conditions.switch2Valid = false;
    var end = page.list.length - 1; // (its last command, the end)
    page.list.splice(end, 0, { code: 355, indent: 0, parameters: ['FH.Coop.bodySearch(this, true);'] });
    return [page];
};

$.bodyDataCache = {};
$.bodyEventData = function(rec) {
    var key = [rec.n, rec.kind, rec.a, rec.m, rec.id, rec.x, rec.y].join(',');
    if ($.bodyDataCache[key]) return $.bodyDataCache[key];
    var pages = (rec.kind === 'duel' && $.bodyDuelPages(rec.a)) || $.bodyPlainPages(rec.a);
    if (!pages) return null;
    var data = { id: rec.id, name: 'FH_body_' + rec.n, note: '', meta: {}, x: rec.x, y: rec.y, pages: pages, _fhBody: rec.n };
    $.bodyDataCache[key] = data;
    return data;
};

// Bodies and Rher forms take free ids above each other's (rherNewId).
var _rherNewIdBodies = $.rherNewId;
$.rherNewId = function(m) {
    var id = _rherNewIdBodies(m);
    $.corpses().forEach(function(r) { if (r.m === m && r.id >= id) id = r.id + 1; });
    return id;
};

$.bodyNewId = function(m) {
    var id = $.rherNewId(m);
    $.rherFreshId(m, id);
    return id;
};

$.bodyRecord = function(eventId, mapId) {
    if (!$gameSystem || !$gameSystem._fhCoop) return null;
    return $.corpses().filter(function(r) { return r.id && r.id === eventId && r.m === mapId; })[0] || null;
};

// Into this map's data ($dataMap must be that map's).
$.bodyEnsureData = function(rec) {
    var events = $dataMap && $dataMap.events;
    if (!events || !rec || !rec.id) return null;
    var have = events[rec.id];
    if (have && have._fhBody === rec.n) return have;
    if (have) return null;
    var data = $.bodyEventData(rec);
    if (data) events[rec.id] = data;
    return data;
};

var _gameMapSetupBodies = Game_Map.prototype.setup;
Game_Map.prototype.setup = function(mapId) {
    if ($gameSystem && $gameSystem._fhCoop && $dataMap) {
        $.corpses().forEach(function(r) { if (r.m === mapId) $.bodyEnsureData(r); });
    }
    _gameMapSetupBodies.call(this, mapId);
};

var _gameEventDataBodies = Game_Event.prototype.event;
Game_Event.prototype.event = function() {
    var data = _gameEventDataBodies.call(this);
    if (data || this._eventId <= $.RHER_EVENT_BASE || !$dataMap || !$gameMap) return data;
    if (this._mapId !== $gameMap.mapId() || ($.dataMapId && $.dataMapId !== this._mapId)) return data;
    var rec = $.bodyRecord(this._eventId, this._mapId);
    return rec ? $.bodyEnsureData(rec) : data;
};

// The bodies of this map that are not on it yet (one made just now).
$.bodyPlaceAll = function() {
    if (!$gameMap || !$dataMap || !$gameMap.mapId() || !$.worldReady()) return;
    var mapId = $gameMap.mapId();
    $.corpses().forEach(function(r) {
        if (!r.id || r.m !== mapId || $gameMap._events[r.id]) return;
        if (!$.bodyEnsureData(r)) return;
        var was = $.buildingEvents;
        $.buildingEvents = true; // (a thin guest sets its page up once too)
        var ev;
        try {
            ev = new Game_Event(r.m, r.id);
        } finally {
            $.buildingEvents = was;
        }
        $gameMap._events[r.id] = ev;
        var set = SceneManager._scene && SceneManager._scene._spriteset;
        if (set && set._tilemap && set._characterSprites && typeof Sprite_Character !== 'undefined') {
            var sprite = new Sprite_Character(ev);
            set._characterSprites.push(sprite);
            set._tilemap.addChild(sprite);
        }
    });
};

// The player of that character ('' if nobody has it).
$.nameOfActor = function(actorId) {
    if ($.hostHasChosen() && $.realHostActorId() === actorId) return $.nameOf('host');
    var a = $.assignments();
    return Object.keys(a).filter(function(name) { return Number(a[name]) === actorId; })[0] || '';
};

// Search on a contestant's body (its event, on whichever PC runs that map);
// keys: the companion body's (its keys only).
$.bodySearch = function(interp, keys) {
    var rec = interp ? $.bodyRecord(interp._eventId, interp._mapId) : null;
    if (!rec) return;
    var who = $.ctx && $.ctx.name ? $.ctx.name : '';
    if ($.isHost()) {
        $.bodySearchHost(rec, who || $.nameOf('host'), keys);
    } else if ($.conn) {
        $.conn.send({ t: 'bodySearch', n: rec.n, who: who, keys: keys ? 1 : 0 });
    }
};

// A dead player's keys, moved into gift (its bag: the host's own one also
// inside a guest's context).
$.takeKeys = function(name, gift) {
    var own = $.ctx && $.ctxSave ? $.ctxSave : null;
    var items = name === $.nameOf('host') ? (own ? own.items : $gameParty._items) : $.guestInventory(name).i;
    $.KEY_ITEMS.forEach(function(id) {
        var n = Math.floor(Number(items && items[id]) || 0);
        if (n <= 0) return;
        gift.i[id] = (gift.i[id] || 0) + n;
        delete items[id];
    });
    var data = $.coopData();
    data.keysTaken = data.keysTaken || {};
    data.keysTaken[name] = true;
};

// The keys are the finder's now: a dead player's PC still sends its bag (its
// menu closing, its roam) - without them, or they were on both (review 2026-11-03).
$.withoutTakenKeys = function(conn, msg) {
    var taken = conn && conn.name && $.isDead(conn.guestId) && ($.coopData().keysTaken || {})[conn.name];
    if (!taken || !msg || !msg.inv || !msg.inv.i) return msg;
    var i = Object.assign({}, msg.inv.i);
    $.KEY_ITEMS.forEach(function(id) { delete i[id]; });
    return Object.assign({}, msg, { inv: Object.assign({}, msg.inv, { i: i }) });
};
var _syncMeKeys = $.hostHandlers.syncMe;
$.hostHandlers.syncMe = function(conn, msg) {
    return _syncMeKeys(conn, $.withoutTakenKeys(conn, msg));
};
var _storeBelongingsKeys = $.storeBelongings;
$.storeBelongings = function(conn, msg) {
    return _storeBelongingsKeys(conn, $.withoutTakenKeys(conn, msg));
};

// Host: that player's things into a parcel for the one who searched (its bag
// takes it where it is: deliverInherit, next frame - not in a context).
$.bodySearchHost = function(rec, who, keys) {
    var dead = $.nameOfActor(rec.a);
    var gift = $.emptyGift();
    if (dead && dead !== who && $.coopDead()[dead]) {
        if (keys) $.takeKeys(dead, gift);
        else if (!$.strippedDead(dead)) $.takeLeftBehind(dead, gift);
    }
    var label = $dataActors[rec.a] ? $dataActors[rec.a].name : dead;
    $.dlog('body of', label, 'searched by', who, ':', JSON.stringify(gift));
    $.clients.forEach(function(c) {
        if (c.name === dead && c.actorId) {
            c._menuBase = null;
            c._lastMeKey = null;
            $.pushMe(c);
        }
    });
    if (!$.giftSize(gift)) {
        if (!keys) $.bodyTell(who, $.BODY_EMPTY_TEXT); // (no keys: "Here lies ..." alone)
        return;
    }
    var data = $.coopData();
    data.parcels = data.parcels || [];
    data.parcels.push({ id: $.newInheritId(), to: who, gift: gift, line: true,
        text: (keys ? $.BODY_KEYS_TEXT : $.BODY_SEARCH_TEXT).replace('%1', label) });
};

$.bodyTell = function(who, text) {
    if (who === $.nameOf('host')) {
        $.fieldGab(text);
        return;
    }
    var c = $.clients.filter(function(x) { return x.name === who; })[0];
    if (c && !c._sub) c.send({ t: 'gab', text: text });
};

// A roaming guest (its own map) or a sub-host (one of its guests).
$.hostHandlers.bodySearch = function(conn, msg) {
    var rec = msg && $.corpses().filter(function(r) { return r.n === msg.n; })[0];
    if (!rec || !conn || !conn.name) return;
    var who = conn.name;
    if (msg.who && msg.who !== conn.name) {
        var v = $.clients.filter(function(c) { return c.name === msg.who && c.subOf === conn.guestId; })[0];
        if (!v) return;
        who = v.name;
    }
    $.bodySearchHost(rec, who, !!msg.keys);
};

//=============================================================================
// A player's character is never one of the original's moonscorched NPCs
//=============================================================================
// User decision (2026-10-23): a character a player has (alive or dead) has
// one moonscorched self, the Rher form where the eye's beam hit; the
// original's encounter of that character never shows. CE303 (DAYS_GO_BY)
// turns those encounters on for the characters nobody plays ("<name>1 off
// and its SELECT off", day 3 evening): Abella_gone, mastermind_mausoleum_alley,
// Marcoh_gone_crazy, valkyrie_active / flight1, mechanical_dance_appear,
// Pocketdaan_appear. Its other SELECT branches are NPC fates too (Levi killed
// in the Caligura scene, Marcoh against Pav). A co-op world has only the
// host's SELECT on, so the guests' characters went that way (0.41 play test
// save, hard mode: four of them on from the start). Now CE303 and the school
// door that lets the Weeping scope out (Map087 EV254, MERCENARY_SELECT) read
// every player's character's SELECT as on. The Cocoon (Map081 EV276) needs no
// switch: its blank page on OCCULTIST_SELECT is read the same way. Encounter
// switches already on (an old save, a guest that picked late) go off when
// the session's game starts, a save is loaded or a guest gets its character.
$.SELECT_AS_PLAYERS_EVENTS = { '87,254': true };
// The original's blank SELECT pages hide each player's own moonscorched
// self. The stair plates are separate events from Cocoon EV276; every one
// needs its page treated as selected too (M1/M2, review 2).
$.ENCOUNTER_PAGES = [
    { m: 81, e: 276, sw: 242 }, { m: 81, e: 277, sw: 242 }, { m: 81, e: 278, sw: 242 },
    { m: 81, e: 279, sw: 242 }, { m: 81, e: 280, sw: 242 },
    { m: 76, e: 151, sw: 2403 }, { m: 76, e: 159, sw: 2403 }, { m: 76, e: 160, sw: 2403 },
    { m: 93, e: 188, sw: 2403 }, { m: 93, e: 189, sw: 2403 }, { m: 93, e: 190, sw: 2403 },
    { m: 99, e: 34, sw: 2403 },
    { m: 84, e: 107, sw: 2402 }, { m: 84, e: 108, sw: 243 }
];
// actor -> the encounter switches of its moonscorched self
$.ENCOUNTER_SWITCHES = { 1: [3597], 4: [4752], 5: [2657], 6: [3814], 13: [2791], 14: [4580, 4581], 15: [4751] };
$.ENCOUNTER_SWITCH_ACTOR = {};
Object.keys($.ENCOUNTER_SWITCHES).forEach(function(actorId) {
    $.ENCOUNTER_SWITCHES[actorId].forEach(function(id) { $.ENCOUNTER_SWITCH_ACTOR[id] = Number(actorId); });
});

// Every player's character: { actorId: true } (the host, the guests here,
// and every name the save has a character for).
$.playerCharacters = function() {
    var ids = {};
    var add = function(a) {
        a = Number(a) || 0;
        if (a) ids[a] = true;
    };
    if ($.isHost()) {
        if ($.hostHasChosen()) add($.realHostActorId());
        $.clients.forEach(function(c) { add(c.actorId); });
    } else {
        add($.myActorId);
        ($.roster || []).forEach(function(r) { add(r.a); });
    }
    var assign = $gameSystem && $gameSystem._fhCoop && $gameSystem._fhCoop.assign;
    Object.keys(assign || {}).forEach(function(name) { add(assign[name]); });
    return ids;
};

$.readsSelectAsPlayers = function(interp) {
    var ce = $dataCommonEvents && $dataCommonEvents[$.DAY_CE];
    if (ce && interp._list === ce.list) return true;
    return !!$.SELECT_AS_PLAYERS_EVENTS[interp._mapId + ',' + interp._eventId] && interp._depth === 0 &&
        !!$gameMap && interp._mapId === $gameMap.mapId();
};

var _command111Players = Game_Interpreter.prototype.command111;
Game_Interpreter.prototype.command111 = function() {
    var p = this._params;
    var actorId = p[0] === 0 && $.SELECT_ACTOR[p[1]];
    if ($.role && actorId && !$gameSwitches.value(p[1]) && $.readsSelectAsPlayers(this) && $.playerCharacters()[actorId]) {
        if (!this._fhSelLogged) {
            this._fhSelLogged = true;
            $.dlog('a player\'s character (actor', actorId + ') reads as selected in', this._mapId ? 'map ' + this._mapId +
                ' event ' + this._eventId : 'CE' + $.DAY_CE, '- no NPC fate for it');
        }
        var result = p[2] === 0; // "SELECT is ON"
        this._branch[this._indent] = result;
        if (!result) this.skipBranch();
        return true;
    }
    return _command111Players.call(this);
};

// The page of an encounter that hides it while that character is selected.
$.encounterPageSwitch = function(ev, page) {
    var c = page && page.conditions;
    if (!c || !c.switch1Valid) return 0;
    for (var i = 0; i < $.ENCOUNTER_PAGES.length; i++) {
        var e = $.ENCOUNTER_PAGES[i];
        if (ev._mapId === e.m && ev._eventId === e.e && c.switch1Id === e.sw && !$gameSwitches._data[e.sw] &&
                $.playerCharacters()[$.SELECT_ACTOR[e.sw]]) return e.sw;
    }
    return 0;
};

// CE303 has several paths that turn a moonscorched encounter on without
// checking the character's SELECT (Marcoh's third-day branch is one). Keep
// any player's original encounter off throughout the co-op game, including
// old saves and paths reached after the initial cleanup (M2/S1, review 2).
var _setValuePlayerEncounter = Game_Switches.prototype.setValue;
Game_Switches.prototype.setValue = function(id, value) {
    var actorId = $.ENCOUNTER_SWITCH_ACTOR[id];
    if (this === $gameSwitches && $.isHost() && $.hostInGame && value && actorId && $.playerCharacters()[actorId]) {
        if (!this.value(id)) $.dlog('original moonscorched encounter kept off for player actor', actorId, 'switch', id);
        return;
    }
    _setValuePlayerEncounter.call(this, id, value);
};

var _meetsConditionsPlayers = Game_Event.prototype.meetsConditions;
Game_Event.prototype.meetsConditions = function(page) {
    var sw = $.role ? $.encounterPageSwitch(this, page) : 0;
    if (!sw) return _meetsConditionsPlayers.call(this, page);
    var data = $gameSwitches._data, was = data[sw];
    data[sw] = true;
    try {
        return _meetsConditionsPlayers.call(this, page);
    } finally {
        data[sw] = was;
    }
};

// Host: encounter switches of players' characters still on go off.
$.clearPlayerEncounters = function(why) {
    if (!$.isHost() || !$gameSwitches) return;
    var chars = $.playerCharacters(), off = [];
    Object.keys(chars).forEach(function(a) {
        ($.ENCOUNTER_SWITCHES[a] || []).forEach(function(id) {
            if (!$gameSwitches.value(id)) return;
            $gameSwitches.setValue(id, false);
            off.push(id);
        });
    });
    if (off.length) $.dlog('players\' characters: their original moonscorched encounters off (' + why + '):', off.join(','));
};

var _sceneMapStartEncounters = Scene_Map.prototype.start;
Scene_Map.prototype.start = function() {
    var starts = $.isHost() && !$.hostInGame;
    _sceneMapStartEncounters.call(this);
    if (starts && $.hostInGame) $.clearPlayerEncounters('the game starts');
};

var _onLoadSuccessEncounters = Scene_Load.prototype.onLoadSuccess;
Scene_Load.prototype.onLoadSuccess = function() {
    _onLoadSuccessEncounters.call(this);
    if ($.isHost()) $.clearPlayerEncounters('a save loaded');
};

var _sendAssignEncounters = $.sendAssign;
$.sendAssign = function(conn, actorId) {
    _sendAssignEncounters(conn, actorId);
    if ($.isHost() && $gameSwitches) $.clearPlayerEncounters('a guest plays actor ' + actorId);
};

//=============================================================================
// Necromancy: one raised companion per player (user 2026-10-26)
//=============================================================================
// Original (data, docs/참고(보관용)/위키_정리.md): a corpse's "Use Necromancy" calls
// CE57 (skill 21, 30 mind), CE49 counts the party (V34) and "IF V34 >= 4"
// says "Unfortunately there is no room for ghouls in your party."; else a
// "Rising" event names it (303) and Change Party adds it: soldiers -> Ghoul
// actor 16 / 17, villagers -> Villager actor 22 / 29. Co-op answered that
// check "full" (no companions, FH_CoopWorld partyRoomCheck).
//
// Now each player can have one: the check is "full" only for a player who
// has one. The host's is in its own party as in the original. A guest's is
// kept in the host's save by name (coopData().minions: name -> actor id),
// its numbers in the host's actor; the guest's PC has it in its party
// ('me' mn, back with syncMe / roamMe / its fight: 'minionSync'). In a fight
// it fights for the one whose fight it is (a joiner's stays out); when the
// fight is full and one more player joins, it steps back until the fight
// ends. Not in a duel. One that another player has (the original gives two
// corpses the same actor) is refused. Its owner dies: it is gone. A guest's
// event on the host skips the name input (303 would open on the host).
$.MINION_ACTORS = [16, 17, 18, 22, 28, 29];
$.MINION_TAKEN_TEXT = 'That body already serves %1.';
$.MINION_BENCH_TEXT = '%1 steps back - the fight is full.';
$.myMinion = 0;      // guest: its companion (from 'me')
$.takenMinions = {}; // guest: actor id -> player id (from 'minions')

$.isMinionActor = function(id) {
    return $.MINION_ACTORS.indexOf(Number(id)) >= 0;
};

$.minionsData = function() {
    var data = $.coopData();
    return (data.minions = data.minions || {});
};

// Host: the host's own party, also while a guest's context runs.
$.hostPartyIds = function() {
    return ($.ctx && $.ctxSave ? $.ctxSave.actors : $gameParty._actors) || [];
};

$.hostMinion = function() {
    return $.hostPartyIds().filter($.isMinionActor)[0] || 0;
};

// Host: player id -> its companion's actor id (0: none).
$.minionOfPlayer = function(id) {
    if (id === 'host') return $.hostMinion();
    var c = $.clientById(id);
    return c && c.name ? ($.minionsData()[c.name] || 0) : 0;
};

// Host: who has this actor (a player id), or ''.
$.minionHolder = function(actorId) {
    if ($.hostPartyIds().indexOf(actorId) >= 0) return 'host';
    var d = $.minionsData(), found = '';
    $.clients.forEach(function(c) { if (!found && c.name && d[c.name] === actorId) found = c.guestId; });
    if (!found) {
        Object.keys(d).forEach(function(name) { if (!found && d[name] === actorId) found = 'name:' + name; });
    }
    return found;
};

$.minionTakenMap = function() {
    var out = {}, host = $.hostMinion(), d = $.minionsData();
    if (host) out[host] = 'host';
    $.clients.forEach(function(c) { if (c.name && d[c.name]) out[d[c.name]] = c.guestId; });
    return out;
};

$.broadcastMinions = function() {
    var m = $.minionTakenMap();
    $.clients.forEach(function(c) { c.send({ t: 'minions', m: m }); });
};

$.guestHandlers.minions = function(msg) {
    if (!$.isHost()) $.takenMinions = msg.m || {};
};

// The player an event or a check runs for, on this PC: 'host', a guest id
// (the host running its event), 'me' (a guest's own PC), or 'sub:<id>' (a
// sub-host running its guest's event: its companion would be the sub-host's
// and gone with the context - 0.41 review 3 H4; there it has no room).
$.MINION_SUB_TEXT = "No room for ghouls on %1's map.";
$.minionRunner = function(interp) {
    if (!$.isHost()) {
        var g = (interp && interp._fhOwner) || ($.ctx && $.ctx.guestId) || '';
        return g && g !== $.myId ? 'sub:' + g : 'me';
    }
    if (interp && interp._fhOwner) return interp._fhOwner;
    return $.ctx ? $.ctx.guestId : 'host';
};

$.runnerHasMinion = function(runner) {
    if (runner.indexOf('sub:') === 0) return true;
    if (runner === 'me') return !!$.myMinion || $gameParty._actors.some($.isMinionActor);
    return !!$.minionOfPlayer(runner);
};

// Another player has it: its label, else ''.
$.minionTakenBy = function(actorId, runner) {
    var holder = $.isHost() ? $.minionHolder(actorId) : ($.takenMinions[actorId] || '');
    if (!holder || holder === runner || (runner === 'me' && holder === $.myId)) return '';
    return holder.indexOf('name:') === 0 ? holder.slice(5) : $.playerLabel(holder);
};

$.minionTell = function(runner, text) {
    if (runner.indexOf('sub:') === 0) {
        var c = $.clientById(runner.slice(4));
        if (c) c.send({ t: 'toast', text: 'Co-op: ' + text });
    } else if (runner === 'host' || runner === 'me') $.toast('Co-op: ' + text);
    else $.sendTo(runner, { t: 'toast', text: 'Co-op: ' + text });
};

// The necromancy room check (CE57 events: "IF V34 >= 4"): full only for a
// player who has one.
var _command111Minion = Game_Interpreter.prototype.command111;
Game_Interpreter.prototype.command111 = function() {
    var p = this._params;
    if (p[0] === 1 && p[1] === $.PARTY_SIZE_VAR && $.companionsBlocked && $.companionsBlocked() &&
            $.partyRoomCheck(this._list, this._index) === 'full') {
        var runner = $.minionRunner(this);
        var full = $.runnerHasMinion(runner);
        if (runner.indexOf('sub:') === 0) $.minionTell(runner, $.MINION_SUB_TEXT.replace('%1', $.playerLabel($.myId)));
        this._branch[this._indent] = full;
        if (!full) this.skipBranch();
        $.dlog('necromancy: room check for', runner === 'me' ? 'this player' : runner.indexOf('sub:') === 0 ? runner : $.playerLabel(runner),
            full ? '- it has one already' : '- room');
        return true;
    }
    return _command111Minion.call(this);
};

// Leaving it at the train or the PRHVL Bop is off in co-op (user
// 2026-10-26): taking it back asks "IF V34 < 4", which co-op answers "full"
// (FH_CoopWorld), so it was lost there. The drop-off events (Map014 EV74,
// Map105 EV51: "<name> sits down to wait your orders.") ask "IF <actor> is
// in the party" for each companion: for these it is "no", and it stays.
$.MINION_DROP_EVENTS = { 14: [74], 105: [51] };

$.isMinionDropCheck = function(interp) {
    var p = interp._params;
    var evs = $.MINION_DROP_EVENTS[interp._mapId];
    return p[0] === 4 && $.isMinionActor(p[1]) && !!evs && evs.indexOf(interp._eventId) >= 0;
};

var _command111MinionDrop = Game_Interpreter.prototype.command111;
Game_Interpreter.prototype.command111 = function() {
    if ($.role && $.companionsBlocked && $.companionsBlocked() && $.isMinionDropCheck(this)) {
        this._branch[this._indent] = false;
        this.skipBranch();
        return true;
    }
    return _command111MinionDrop.call(this);
};

// Adding one: refused if another player has it; else it is this player's.
$.minionAdd = function(runner, actorId) {
    if (runner.indexOf('sub:') === 0) return false;
    var by = $.minionTakenBy(actorId, runner);
    if (by) {
        $.minionTell(runner, $.MINION_TAKEN_TEXT.replace('%1', by));
        $.dlog('necromancy: actor', actorId, 'refused for', runner, '- it serves', by);
        return false;
    }
    if (runner === 'me') {
        $.myMinion = actorId; // (the host hears of it once it is in the party: command129)
    } else if (runner !== 'host') {
        var c = $.clientById(runner);
        if (!c || !c.name) return false;
        $.minionsData()[c.name] = actorId;
        c._lastMeKey = null;
        $.pushMe(c);
        $.broadcastMinions();
    }
    $.dlog('necromancy:', runner === 'me' ? 'this player' : $.playerLabel(runner), 'has actor', actorId);
    return true;
};

$.minionRemove = function(runner, actorId) {
    if (runner.indexOf('sub:') === 0) return;
    if (runner === 'me') {
        if ($.myMinion === actorId) $.myMinion = 0;
        if ($.conn) $.conn.send({ t: 'minionDrop', id: actorId });
    } else if (runner !== 'host') {
        var c = $.clientById(runner), d = $.minionsData();
        if (c && c.name && d[c.name] === actorId) {
            delete d[c.name];
            c._lastMeKey = null;
            $.pushMe(c);
            $.broadcastMinions();
        }
    }
};

var _command129Minion = Game_Interpreter.prototype.command129;
Game_Interpreter.prototype.command129 = function() {
    var p = this._params;
    if ($.role && $.isMinionActor(p[0]) && !$gameParty.inBattle()) {
        var runner = $.minionRunner(this);
        if (p[1] === 0) {
            if (!$.minionAdd(runner, p[0])) return true;
            if (runner !== 'host' && runner !== 'me') return true; // (kept by name: its PC's party)
        } else {
            $.minionRemove(runner, p[0]);
            if (runner !== 'host' && runner !== 'me') return true;
        }
        // this PC's own party (the co-op rules below refuse companions:
        // FH_CoopWorld for the host, roaming for a guest)
        if (p[1] === 0) {
            if (p[2]) $gameActors.actor(p[0]).setup(p[0]);
            $gameParty.addActor(p[0]);
            if (runner === 'me' && $.conn) {
                $.conn.send({ t: 'minionSet', id: p[0], actor: $.actorJson($gameActors.actor(p[0])) });
            }
        } else {
            $gameParty.removeActor(p[0]);
        }
        if ($gamePlayer) $gamePlayer.refresh();
        if (runner === 'host') $.broadcastMinions();
        return true;
    }
    return _command129Minion.call(this);
};

// A guest's event on the host: its Change Party is skipped there
// (IGNORE_FOR_GUEST) and its name input would open on the host's screen.
var _executeCommandMinion = Game_Interpreter.prototype.executeCommand;
Game_Interpreter.prototype.executeCommand = function() {
    var command = this._fhOwner && $.runsWorld() ? this.currentCommand() : null;
    if (command && (command.code === 129 || command.code === 303) && $.isMinionActor(command.parameters[0])) {
        this._params = command.parameters;
        this._indent = command.indent;
        if (command.code === 129) this.command129();
        this._index++;
        return true;
    }
    return _executeCommandMinion.call(this);
};

// ---- the host's copy and the guest's PC

var _meDataMinion = $.meData;
$.meData = function(conn) {
    var data = _meDataMinion(conn);
    var id = conn && conn.name && !conn.solo ? ($.minionsData()[conn.name] || 0) : 0;
    var actor = id ? $gameActors.actor(id) : null;
    data.mn = actor ? { id: id, actor: $.actorJson(actor) } : null;
    return data;
};

// A change of its companion alone sends a new 'me' too.
var _pushMeMinion = $.pushMe;
$.pushMe = function(conn) {
    if (conn && conn.actorId && conn.name) {
        var id = $.minionsData()[conn.name] || 0;
        var actor = id ? $gameActors.actor(id) : null;
        var key = id + ':' + (actor ? actor.hp + '/' + actor.mhp + '/' + actor._states.join(',') : '');
        if (key !== conn._mnKey) {
            conn._mnKey = key;
            conn._lastMeKey = null;
        }
    }
    _pushMeMinion(conn);
};

$.takeMinionCopy = function(conn, mn) {
    if (!conn || !conn.name || !mn || !mn.actor) return;
    var id = Number(mn.id);
    if ($.minionsData()[conn.name] !== id) return;
    var actor = $.parseActor ? $.parseActor(mn.actor) : JsonEx.parse(mn.actor);
    if (actor && actor._actorId === id) $gameActors._data[id] = actor;
};

$.hostHandlers.minionSync = function(conn, msg) {
    $.takeMinionCopy(conn, msg);
};

// A roaming guest raised one on its own map.
$.hostHandlers.minionSet = function(conn, msg) {
    var id = Number(msg && msg.id);
    if (!conn.name || !$.isMinionActor(id)) return;
    var holder = $.minionHolder(id);
    if (holder && holder !== conn.guestId) {
        conn.send({ t: 'minionNo', id: id, by: holder.indexOf('name:') === 0 ? holder.slice(5) : $.playerLabel(holder) });
        return;
    }
    $.minionsData()[conn.name] = id;
    $.takeMinionCopy(conn, msg);
    $.broadcastMinions();
};

$.hostHandlers.minionDrop = function(conn, msg) {
    var d = $.minionsData();
    if (conn.name && d[conn.name] === Number(msg && msg.id)) {
        delete d[conn.name];
        $.broadcastMinions();
    }
};

$.guestHandlers.minionNo = function(msg) {
    var id = Number(msg.id);
    if ($.myMinion === id) $.myMinion = 0;
    $gameParty._actors = $gameParty._actors.filter(function(a) { return a !== id; });
    if ($gamePlayer) $gamePlayer.refresh();
    $.toast('Co-op: ' + $.MINION_TAKEN_TEXT.replace('%1', msg.by || 'someone else'));
};

// The guest's party: its character and its companion.
$.myPartyIds = function() {
    var ids = [$.myActorId];
    if ($.myMinion && $gameActors.actor($.myMinion)) ids.push($.myMinion);
    return ids;
};

var _applyMeMinion = $.applyMe;
$.applyMe = function(msg) {
    if (msg && msg.actorId === $.myActorId && msg.mn !== undefined && !$.solo) {
        if (msg.mn && msg.mn.actor) {
            $gameActors._data[msg.mn.id] = $.parseActor ? $.parseActor(msg.mn.actor) : JsonEx.parse(msg.mn.actor);
            $.myMinion = Number(msg.mn.id);
        } else {
            $.myMinion = 0;
        }
    }
    _applyMeMinion(msg);
    if ($.isThin() && $.myActorId && !$.pvpBattle && !$gameParty.inBattle()) {
        $gameParty._actors = $.myPartyIds();
        if ($gamePlayer) $gamePlayer.refresh();
    }
};

var _processPendingSnapshotMinion = $.processPendingSnapshot;
$.processPendingSnapshot = function() {
    var had = !!$.pendingSnapshot;
    _processPendingSnapshotMinion();
    if (had && $.isThin() && $.myActorId && $.myMinion && $gameParty) $gameParty._actors = $.myPartyIds();
};

var _startRoamMinion = $.startRoam;
$.startRoam = function(msg) {
    if (msg && msg.me && msg.me.mn !== undefined) {
        var mn = msg.me.mn;
        if (mn && mn.actor) $gameActors._data[mn.id] = $.parseActor(mn.actor);
        $.myMinion = mn ? Number(mn.id) : 0;
    }
    _startRoamMinion(msg);
    if ($.myMinion && $gameActors.actor($.myMinion)) {
        $gameParty._actors = $.myPartyIds();
        if ($gamePlayer) $gamePlayer.refresh();
    }
};

$.sendMinionSync = function() {
    var actor = $.myMinion ? $gameActors.actor($.myMinion) : null;
    if (!actor || !$.conn) return;
    $.conn.send({ t: 'minionSync', id: $.myMinion, actor: $.actorJson(actor) });
};

var _sendSyncMeMinion = $.sendSyncMe;
$.sendSyncMe = function() {
    _sendSyncMeMinion();
    if ($.isThin() && $.myActorId) $.sendMinionSync();
};

var _sendRoamMeMinion = $.sendRoamMe;
$.sendRoamMe = function(force) {
    _sendRoamMeMinion(force);
    var actor = $.myMinion ? $gameActors.actor($.myMinion) : null;
    var key = actor ? $.actorJson(actor) : '';
    if (actor && (force || key !== $.lastMinionKey)) {
        $.lastMinionKey = key;
        $.sendMinionSync();
    }
};

var _finishLocalBattleMinion = $.finishLocalBattle;
$.finishLocalBattle = function(result, dead) {
    var send = !!$.localBattle && !$.localBattle.sent && !$.localBattle.pvp;
    _finishLocalBattleMinion(result, dead);
    if (send) $.sendMinionSync();
};

// The host's own fight of a guest's: its party is the guest's character and
// companion (a guest's fight runs on its PC with its own party).
var _enterContextMinion = $.enterContext;
$.enterContext = function(conn) {
    _enterContextMinion(conn);
    var id = $.ctx === conn && conn && conn.name ? $.minionsData()[conn.name] : 0;
    if (id && $gameActors.actor(id) && $gameParty._actors.length === 1) $gameParty._actors = [conn.actorId, id];
};

// Its owner died: it is gone.
var _killPlayerMinion = $.killPlayer;
$.killPlayer = function(id, why) {
    var c = $.clientById(id);
    if (c && c.name && $.minionsData()[c.name]) {
        $.dlog('necromancy:', c.name, 'died - its companion is gone');
        delete $.minionsData()[c.name];
        $.broadcastMinions();
    }
    _killPlayerMinion(id, why);
};

// The host died (a ghost, or the game is over): its own goes too (0.41
// review 3 H7 - it stayed in the ghost's party).
var _hostDiesMinion = $.hostDies;
$.hostDies = function() {
    var save = $.ctx && $.ctxSave ? $.ctxSave : null;
    var before = $.hostPartyIds();
    var left = before.filter(function(id) { return !$.isMinionActor(id); });
    if (left.length !== before.length) {
        if (save) save.actors = left; else $gameParty._actors = left;
        if ($gamePlayer) $gamePlayer.refresh();
        $.dlog('necromancy: the host died - its companion is gone');
        $.broadcastMinions();
    }
    _hostDiesMinion();
};

// A guest's companion died (its own fight on its PC, or one it joined): the
// original's CE53 deathCheck (parallel, SW79) takes a dead 16/17/18/22/28/29
// out of the party, its gear back to the bag, and turns on its "died" switch.
// It runs in the world only (the host's party): a thin guest's dead one
// stayed, and its room check said "no room" for good (0.41 review 3 H2).
// Host, once a second: the same for such a guest (its bag, its record; the
// corpse the original spawns where the player stands is left out). A roaming
// guest's own PC runs CE53 (minionDrop).
$.MINION_DEATH_SWITCH = { 16: 233, 17: 235, 18: 237, 22: 4473, 28: 4475, 29: 4477 };
$.minionDeathCheck = function(conn) {
    var d = $.minionsData(), id = conn && conn.name ? d[conn.name] : 0;
    var actor = id ? $gameActors.actor(id) : null;
    if (!actor || !actor.isDead()) return false;
    $.inContext(conn, function() {
        for (var etype = 1; etype <= actor.equipSlots().length; etype++) actor.changeEquipById(etype, 0);
    });
    delete d[conn.name];
    if ($.MINION_DEATH_SWITCH[id]) $gameSwitches.setValue($.MINION_DEATH_SWITCH[id], true);
    $.dlog('necromancy:', conn.name + "'s companion", id, 'died - out of its party');
    conn._lastMeKey = null;
    $.pushMe(conn);
    $.broadcastMinions();
    return true;
};

$.worldExtras.push(function() {
    if (!$.isHost() || Graphics.frameCount % 60 !== 45 || $.ctx || $gameParty.inBattle()) return;
    $.clients.forEach(function(c) {
        if (c.actorId && c.name && !c.solo && !c.roam && !c.roamPending) $.minionDeathCheck(c);
    });
});

// Everyone learns who has which, a guest its own with its character.
var _sendAssignMinion = $.sendAssign;
$.sendAssign = function(conn, actorId) {
    _sendAssignMinion(conn, actorId);
    conn.send({ t: 'minions', m: $.minionTakenMap() });
};

var _leaveAsGuestMinion = $.leaveAsGuest;
$.leaveAsGuest = function(message) {
    $.myMinion = 0;
    $.takenMinions = {};
    _leaveAsGuestMinion(message);
};

// ---- fights (user 2026-10-26: a joiner's comes along too)
// Companions only fight by themselves (AI), so the PC running the fight runs
// a joiner's as well and hands it back when it ends or its owner leaves the
// fight - its numbers and what it wears (equipment is part of the actor),
// like the Black steel: the host sends it with 'bJoin' (mn), the fight's PC
// returns it ('minionBack'). Its coin toss is its owner's. Nobody changes a
// companion's equipment in a fight (it never takes a turn of input).

$.JOIN_FLAGS.push('_fhMinionOf', '_fhMinionName');

// Host: a joiner brings its living companion.
var _bSendMinion = $.bSend;
$.bSend = function(to, msg) {
    if (msg && msg.t === 'bJoin' && $.isHost() && msg.mn === undefined && msg.jid) {
        var id = $.minionOfPlayer(msg.jid);
        var m = id ? $gameActors.actor(id) : null;
        msg.mn = m && m.isAlive() ? { id: id, actor: $.actorJson(m), name: $.nameOf(msg.jid) } : null;
    }
    return _bSendMinion(to, msg);
};

$.addJoinerMinion = function(msg) {
    var mn = msg && msg.mn;
    if (!mn || !mn.actor || !$.joinerActor(msg.jid)) return false;
    var id = Number(mn.id);
    if ($gameParty._actors.indexOf(id) >= 0 || $gameParty.battleMembers().length >= $gameParty.maxBattleMembers()) {
        return false;
    }
    var m = $.parseActor(mn.actor);
    if (!m || m._actorId !== id) return false;
    m._fhMinionOf = msg.jid;
    m._fhMinionName = mn.name || '';
    m.setAtbGauge(0);
    $gameActors._data[id] = m;
    $gameParty._actors.push(id);
    m.onBattleStart();
    $.battleGab(m.name() + ' follows ' + $.playerLabel(msg.jid) + '.');
    $.dlog('necromancy: actor', id, 'fights with its owner', msg.jid);
    $.broadcastParty();
    $.refreshBattleStatus();
    return true;
};

// A joiner's companion out of this fight: its copy as it is, for its owner.
$.takeOutMinion = function(m) {
    var bm = BattleManager;
    if (bm.actor && bm.actor() === m) bm.changeActor(-1, 'waiting');
    ['_atbInputActor', '_atbActing', '_atbSuspended', '_subject', '_atbPreForceSubject',
        '_actionForcedBattler'].forEach(function(k) {
        if (bm[k] === m) bm[k] = null;
    });
    if (bm._atbInputMemory && bm._atbInputMemory.actor === m) bm._atbInputMemory = null;
    if (bm._actionBattlers) bm._actionBattlers = bm._actionBattlers.filter(function(b) { return b !== m; });
    m.clearActions();
    $gameParty._actors = $gameParty._actors.filter(function(a) { return a !== m.actorId(); });
    var back = { of: m._fhMinionOf, name: m._fhMinionName || '', id: m.actorId() };
    if ($gameParty.inBattle()) m.onBattleEnd();
    $.stripJoinFlags(m);
    back.actor = $.actorJson(m);
    return back;
};

$.returnMinions = function(list) {
    if (!list.length) return;
    if ($.isHost()) $.minionsBack(list);
    else if ($.conn) $.conn.send({ t: 'minionBack', list: list });
};

$.hostHandlers.minionBack = function(conn, msg) {
    $.minionsBack((msg && msg.list) || []);
};

// Host: the copies back to their owners (by name: one who left meanwhile
// gets it in the save).
$.minionsBack = function(list) {
    var d = $.minionsData();
    list.forEach(function(b) {
        var id = Number(b.id), actor = $.parseActor(b.actor);
        if (!actor || actor._actorId !== id) return;
        if (b.of === 'host') {
            if ($.hostMinion() === id) $gameActors._data[id] = actor;
            return;
        }
        var c = $.clientById(b.of);
        var name = c && c.name ? c.name : b.name;
        if (!name || d[name] !== id) return;
        $gameActors._data[id] = actor;
        if (c) {
            c.send({ t: 'minionCopy', id: id, actor: b.actor });
            c._lastMeKey = null;
            $.pushMe(c);
        }
    });
};

// (It comes as the fight ends, often with the fight's screen still up: kept
// until the map, or the copy the fight's view left won and went back to the
// host with the next menu's minionSync - 0.41 review 3 H3.)
$.minionCopyLater = null;
$.guestHandlers.minionCopy = function(msg) {
    if (!msg || Number(msg.id) !== $.myMinion) return;
    if ($gameParty.inBattle() || !(SceneManager._scene instanceof Scene_Map)) {
        $.minionCopyLater = msg;
        return;
    }
    $.minionCopyLater = null;
    var actor = $.parseActor(msg.actor);
    if (actor && actor._actorId === $.myMinion) $gameActors._data[$.myMinion] = actor;
};

var _sceneMapStartMinion = Scene_Map.prototype.start;
Scene_Map.prototype.start = function() {
    _sceneMapStartMinion.call(this);
    var later = $.minionCopyLater;
    if (later && $.role && !$gameParty.inBattle()) $.guestHandlers.minionCopy(later);
};

// Its coin toss: its owner tosses (a joiner) - on this PC the fight's player.
var _battleChoiceOwnerMinion = $.battleChoiceOwner;
$.battleChoiceOwner = function(interp) {
    var r = _battleChoiceOwnerMinion(interp);
    if (r) return r;
    var ab = $.authBattle;
    if (!ab || ab.pvp || $.puppet || !$gameParty.inBattle() || !$.isTroopInterp(interp)) return null;
    var a = $.coinActor();
    var of = a && a._fhMinionOf;
    if (!of || !a.isAlive() || !$.joinerActor(of)) return null;
    return of;
};

// Its owner flees: it goes along.
var _bLeaveMinion = $.guestHandlers.bLeave;
$.guestHandlers.bLeave = function(msg) {
    var ab = $.authBattle, from = msg && (msg.from || 'host');
    if (ab && msg && ab.bid === msg.bid && $gameParty.inBattle()) {
        var back = $gameParty.battleMembers().filter(function(a) { return a._fhMinionOf === from; })
            .map($.takeOutMinion);
        $.returnMinions(back);
        if (back.length) $.broadcastParty();
    }
    _bLeaveMinion(msg);
};

// The fight is full and one more player joins: a companion steps back (out
// of the fight; this player's own is back in its party when it ends, a
// joiner's goes back to its owner).
$.benchMinion = function() {
    var ab = $.authBattle;
    var id = $gameParty._actors.filter(function(a) { return $.isMinionActor(a); })[0];
    if (!ab || !id) return false;
    var m = $gameActors.actor(id);
    if (m && m._fhMinionOf) {
        $.returnMinions([$.takeOutMinion(m)]);
        $.broadcastParty();
        $.refreshBattleStatus();
        $.battleGab($.MINION_BENCH_TEXT.replace('%1', m.name()));
        return true;
    }
    var bm = BattleManager;
    if (bm.actor() === m) bm.changeActor(-1, 'waiting');
    ['_atbInputActor', '_atbActing', '_atbSuspended', '_subject', '_atbPreForceSubject',
        '_actionForcedBattler'].forEach(function(k) {
        if (bm[k] === m) bm[k] = null;
    });
    if (bm._atbInputMemory && bm._atbInputMemory.actor === m) bm._atbInputMemory = null;
    if (bm._actionBattlers) bm._actionBattlers = bm._actionBattlers.filter(function(b) { return b !== m; });
    if (m) m.clearActions();
    $gameParty._actors = $gameParty._actors.filter(function(a) { return a !== id; });
    ab.benchedMinion = id;
    if ($.broadcastParty) $.broadcastParty();
    if ($.refreshBattleStatus) $.refreshBattleStatus();
    $.battleGab($.MINION_BENCH_TEXT.replace('%1', m ? m.name() : 'The ghoul'));
    $.dlog('necromancy: actor', id, 'steps back for a joiner, fight', ab.bid);
    return true;
};

var _bJoinMinion = $.guestHandlers.bJoin;
$.guestHandlers.bJoin = function(msg) {
    var ab = $.authBattle;
    var live = ab && msg && ab.bid === msg.bid && $gameParty.inBattle() && !$.puppet;
    if (live && $gameParty.battleMembers().length >= $gameParty.maxBattleMembers()) $.benchMinion();
    _bJoinMinion(msg);
    if (live) $.addJoinerMinion(msg);
};

var _endAuthBattleMinion = $.endAuthBattle;
$.endAuthBattle = function(result) {
    var ab = $.authBattle;
    var own = ab && ab.benchedMinion;
    var back = ab ? $gameParty._actors.map(function(id) { return $gameActors.actor(id); })
        .filter(function(a) { return a && a._fhMinionOf; }).map($.takeOutMinion) : [];
    _endAuthBattleMinion(result);
    if (own && $gameParty._actors.indexOf(own) < 0) $gameParty._actors.push(own);
    $.returnMinions(back);
};

//=============================================================================
// The grab at the hubs: in co-op the grabbers join the fight instead
//=============================================================================
// docs/조사(보관용)/제압_참가자_난입.md. In the original, killing a contestant on the
// train (Map014), Path1 (Map004) or the club (Map067) turns SW1179
// ATTACKED_ON_TRAIN on right after the fight; that map's autorun page picks
// the first contestant left (V721-726 grabbed_by_*, in that order), turns
// SW1180 on and plays the grab: the player is tied up until the night of day
// 3 (Karin's "Try to attack her" is a game over). User decision 2026-10-26:
// never in co-op. Instead, when the fight starts, every contestant that page
// would pick (the original picks one; the user: all of them) and that stands
// on this map joins it: its own fight's troop goes into the same battle. Won:
// each of them dies as in its own fight (the commands after its Battle
// Processing). Lost: the fixed fight rule (a loss rolls back to before the
// talk), with what the troop wrote (parts, "<name>1") too.
// Nothing here is an event id: the pages come from the conditions on SW1179 /
// SW1180, the grabbers from their kill branches on this map.
$.GRAB_SWITCH = 1179;  // ATTACKED_ON_TRAIN: a contestant was killed here
$.GRAB_SWITCH2 = 1180; // ATTACKED_ON_TRAIN2: the grab scene
$.GRAB_MAX_JOIN = 3;   // screen room: the one fought and three more
$.GRAB_WIDTH = 816;    // the screen the bodies share (the game's own; every PC the same)
// A joiner's battle start and turn end are the fight's once (0.41 review 4
// M2, user decision 2026-10-26): its lines play, but not the mechanics the
// first one's pages already do - CE564 Pinecone_Pig (items), CE484
// Hesitation, CE502 FIRST_ATTACKS and V19 battleturns / V2713
// battle_turn_negative (the first turn's advantage) at the start; the V19
// MOVE CONTROL count and CE467 Adrenaline_rush at the turn end.
$.GRAB_STRIP_START = { ce: { 564: true, 484: true, 502: true }, v: { 19: true, 2713: true } };
$.GRAB_STRIP_END = { ce: { 467: true }, v: { 19: true } };
$.GRAB_TROOP_RE = /^fhgrab:(\d+):(\d+(?:,\d+)*)$/;
// the index of the enemy in the troop commands (339: when an enemy acts)
$.GRAB_ENEMY_ARG = { 331: 0, 332: 0, 342: 0, 333: 0, 334: 0, 335: 0, 336: 0, 337: 0, 339: 1 };

$.grabPageOn = function(page, id) {
    var c = page && page.conditions;
    return !!c && ((c.switch1Valid && c.switch1Id === id) || (c.switch2Valid && c.switch2Id === id));
};

// (a map interpreter is every event's: nothing of one run is left for the next
// - a lost joined fight's grabbers died after a later fight, review 4 H1)
var _clearGrab = Game_Interpreter.prototype.clear;
Game_Interpreter.prototype.clear = function() {
    _clearGrab.call(this);
    this._fhGrab = null;
    this._fhGrabQueue = null;
    this._fhGrabRun = false;
};

// The grab pages (the autorun on SW1179, the scene on SW1180, the grabbers'
// pictures on it) never come on in co-op, an old save's switches neither.
var _meetsConditionsGrab = Game_Event.prototype.meetsConditions;
Game_Event.prototype.meetsConditions = function(page) {
    if ($.role && ($.grabPageOn(page, $.GRAB_SWITCH) || $.grabPageOn(page, $.GRAB_SWITCH2))) return false;
    return _meetsConditionsGrab.call(this, page);
};

// The commands a won Battle Processing at list[index] goes on with:
// { from, to (not included), indent } or null.
$.grabAfterFight = function(list, index) {
    var at = list && list[index];
    if (!at || at.code !== 301) return null;
    var ind = at.indent, i = index + 1;
    if (list[i] && list[i].code === 601 && list[i].indent === ind) {
        var j = i + 1;
        while (j < list.length && list[j].indent > ind) j++;
        return { from: i + 1, to: j, indent: ind + 1 };
    }
    var k = i;
    while (k < list.length && list[k].indent >= ind && !(list[k].indent === ind && list[k].code === 0)) k++;
    return { from: i, to: k, indent: ind };
};

// The switches those commands turn on: { id: true }.
$.grabSwitchesOn = function(list, range) {
    var on = {};
    for (var i = range.from; i < range.to; i++) {
        var p = list[i].parameters;
        if (list[i].code === 121 && p[2] === 0) for (var id = p[0]; id <= p[1]; id++) on[id] = true;
    }
    return on;
};

// The autorun page on SW1179 this event would show with the switch on.
$.grabPageOf = function(ev) {
    var pages = ev.event() ? ev.event().pages : [];
    if (!pages.some(function(p) { return p.trigger === 3 && $.grabPageOn(p, $.GRAB_SWITCH); })) return null;
    var data = $gameSwitches._data, was = data[$.GRAB_SWITCH];
    data[$.GRAB_SWITCH] = true;
    try {
        for (var i = pages.length - 1; i >= 0; i--) {
            if (!_meetsConditionsGrab.call(ev, pages[i])) continue;
            return pages[i].trigger === 3 && $.grabPageOn(pages[i], $.GRAB_SWITCH) ? pages[i] : null;
        }
    } finally {
        data[$.GRAB_SWITCH] = was;
    }
    return null;
};

$.grabPagesHere = function() {
    var out = [];
    if ($gameMap) $gameMap.events().forEach(function(ev) {
        var page = $.grabPageOf(ev);
        if (page) out.push({ ev: ev, page: page });
    });
    return out;
};

// The grabbers' variables (V721-726): the variable condition of the grab
// pictures on SW1180 on this map.
$.grabVarsHere = function() {
    var vars = {};
    if ($dataMap) ($dataMap.events || []).forEach(function(ev) {
        (ev && ev.pages || []).forEach(function(p) {
            if ($.grabPageOn(p, $.GRAB_SWITCH2) && p.conditions.variableValid) vars[p.conditions.variableId] = true;
        });
    });
    return vars;
};

$.grabCond = function(p, sw, v, ev) {
    if (p[0] === 0) return sw(p[1]) === (p[2] === 0);
    if (p[0] === 1) {
        var a = v(p[1]), b = p[2] === 0 ? p[3] : v(p[3]);
        return [a === b, a >= b, a <= b, a > b, a < b, a !== b][p[4]] || false;
    }
    if (p[0] === 2) return !!ev && $gameSelfSwitches.value([ev._mapId, ev._eventId, p[1]]) === (p[2] === 0);
    return false;
};

$.grabOp = function(cur, op, value) {
    if (op === 1) return cur + value;
    if (op === 2) return cur - value;
    if (op === 3) return cur * value;
    if (op === 4) return value ? Math.floor(cur / value) : cur;
    if (op === 5) return value ? cur % value : cur;
    return value;
};

// The grab page read, not run: conditions, jumps, switch and variable
// writes only (no screen, no common event). on: switches taken as on; skip:
// grabber variables not to pick (a picked one's jump is skipped with it).
// { grab: it reached SW1180 on, sw / v: what it wrote before }.
$.grabDryRun = function(list, ev, on, skip) {
    var sw = {}, vr = {}, branch = {}, out = { grab: false, sw: sw, v: vr };
    var swv = function(id) { return id in sw ? sw[id] : !!on[id] || $gameSwitches.value(id); };
    var vv = function(id) { return id in vr ? vr[id] : $gameVariables.value(id); };
    var skipBranch = function(i) {
        var ind = list[i].indent;
        while (i + 1 < list.length && list[i + 1].indent > ind) i++;
        return i;
    };
    for (var i = 0, steps = 0; i < list.length && steps < 20000; i++, steps++) {
        var c = list[i], p = c.parameters;
        if (c.code === 111) {
            branch[c.indent] = $.grabCond(p, swv, vv, ev);
            if (!branch[c.indent]) i = skipBranch(i);
        } else if (c.code === 411) {
            if (branch[c.indent] !== false) i = skipBranch(i);
        } else if (c.code === 119) {
            for (var j = 0; j < list.length; j++) {
                if (list[j].code === 118 && list[j].parameters[0] === p[0]) {
                    i = j;
                    break;
                }
            }
        } else if (c.code === 121) {
            for (var s = p[0]; s <= p[1]; s++) {
                if (s === $.GRAB_SWITCH2 && p[2] === 0) {
                    out.grab = true;
                    return out;
                }
                sw[s] = p[2] === 0;
            }
        } else if (c.code === 122 && (p[3] === 0 || p[3] === 1)) {
            var value = p[3] === 0 ? p[4] : vv(p[4]), skipped = false;
            for (var k = p[0]; k <= p[1]; k++) {
                if (skip[k] && value) skipped = true;
                else vr[k] = $.grabOp(vv(k), p[2], value);
            }
            if (skipped && list[i + 1] && list[i + 1].code === 119) i++;
        }
    }
    return out;
};

// Every grabber the pages would pick, in their order: [{ v, list }].
$.grabbersFor = function(pages, on) {
    var vars = $.grabVarsHere(), skip = {}, found = [];
    pages.forEach(function(gp) {
        for (var n = 0; n < 10; n++) {
            var r = $.grabDryRun(gp.page.list, gp.ev, on, skip), pick = 0;
            Object.keys(r.v).forEach(function(k) {
                if (!pick && vars[k] && r.v[k] >= 1) pick = Number(k);
            });
            if (!pick) break;
            skip[pick] = true;
            found.push({ v: pick, list: gp.page.list });
        }
    });
    return found;
};

// The switches a grabber's pick hangs on (its SELECT, "<name>1", "waiting
// in the train" ...): the conditions around "V<grabber> = 1".
$.grabGuards = function(list, v) {
    var ids = {};
    list.forEach(function(c, k) {
        var p = c.parameters;
        if (c.code !== 122 || p[0] > v || p[1] < v || p[2] !== 0 || p[3] !== 0 || !p[4]) return;
        var want = c.indent - 1;
        for (var j = k - 1; j >= 0 && want >= 0; j--) {
            var d = list[j];
            if (d.indent !== want || d.code !== 111) continue;
            if (d.parameters[0] === 0) ids[d.parameters[1]] = true;
            want--;
        }
    });
    return ids;
};

// A fight at list[k] that kills this grabber and nobody else: its win turns
// one of its guards on, no other contestant's (others), and no second fight
// follows in it (Map004 EV36's "Attack Tanaka" fights Marcoh after him -
// review 4 M1). { e, p, at, troop } or null.
$.grabKillAt = function(ev, pi, k, guards, others) {
    var list = ev.event().pages[pi].list, c = list[k];
    if (c.code !== 301 || c.parameters[0] !== 0 || !$dataTroops[c.parameters[1]]) return null;
    var after = $.grabAfterFight(list, k);
    for (var i = after.from; i < after.to; i++) if (list[i].code === 301) return null;
    var on = Object.keys($.grabSwitchesOn(list, after));
    if (!on.some(function(id) { return guards[id]; }) || on.some(function(id) { return others[id] && !guards[id]; })) return null;
    return { e: ev.eventId(), p: pi, at: k, troop: c.parameters[1] };
};

// (hub: only a kill that is the hub's own - it turns SW1179 on)
$.grabKillIn = function(ev, pi, guards, others, hub) {
    var list = ev.event().pages[pi].list;
    for (var k = 0; k < list.length; k++) {
        var hit = list[k].code === 301 ? $.grabKillAt(ev, pi, k, guards, others) : null;
        if (hit && (!hub || $.grabSwitchesOn(list, $.grabAfterFight(list, k))[$.GRAB_SWITCH])) return hit;
    }
    return null;
};

// Someone else deals with this event now: held, frozen in a fight, run as a
// fixed page or listed in a fight (review 4 H2).
$.grabBusy = function(ev, live) {
    var key = $.fxKey($gameMap.mapId(), ev.eventId());
    if ($.fixedHolds[key] || ev._fhBattle || live[key]) return true;
    return Object.keys($.battles || {}).some(function(bid) {
        var b = $.battles[bid];
        return !!b && b.eventId === ev.eventId() && b.mapId === $gameMap.mapId();
    });
};

// The grabber's fight on this map. The original takes the grabber whether it
// stands here or not (user decision 2026-10-26: the same), so any event with
// its fight will do: one whose page now has it first, then a kill of the hub
// (it turns SW1179 on: not the boxing ring's match), then any. Busy if any
// of its events is.
// { e, p, at, troop } | { busy: true } | null.
$.grabberHere = function(guards, others, notEventId) {
    var evs = ($gameMap ? $gameMap.events() : []).filter(function(ev) {
        return ev.eventId() !== notEventId && !!ev.event();
    });
    var mine = [];
    evs.forEach(function(ev) {
        for (var pi = 0; pi < ev.event().pages.length; pi++) {
            if ($.grabKillIn(ev, pi, guards, others)) {
                mine.push(ev);
                return;
            }
        }
    });
    if (!mine.length) return null;
    var live = $.fxLiveRuns();
    if (mine.some(function(ev) { return $.grabBusy(ev, live); })) return { busy: true };
    var found = null;
    mine.some(function(ev) {
        found = ev._pageIndex >= 0 && !ev._erased ? $.grabKillIn(ev, ev._pageIndex, guards, others) : null;
        return !!found;
    });
    [true, false].forEach(function(hub) {
        mine.some(function(ev) {
            for (var pi = 0; !found && pi < ev.event().pages.length; pi++) found = $.grabKillIn(ev, pi, guards, others, hub);
            return !!found;
        });
    });
    return found;
};

// The players' characters are nobody's grabber: their SELECT as on (a
// sub-host's own guests too).
$.grabPlayerSelects = function() {
    var on = {}, players = $.playerCharacters();
    ($.clients || []).forEach(function(c) { if (c && c.actorId) players[c.actorId] = true; });
    Object.keys($.SELECT_ACTOR).forEach(function(sw) {
        if (players[$.SELECT_ACTOR[sw]]) on[sw] = true;
    });
    return on;
};

// This Battle Processing's fight with the grabbers in it, or null:
// { troopId, j: [{ e, p, at, troop }] }.
$.grabPlan = function(interp) {
    var p = interp._params, list = interp._list;
    if (!p || p[0] !== 0 || !$dataTroops[p[1]] || !$gameMap || !list) return null;
    var after = $.grabAfterFight(list, interp._index);
    var aOn = after ? $.grabSwitchesOn(list, after) : {};
    if (!aOn[$.GRAB_SWITCH]) return null;
    var pages = $.grabPagesHere();
    if (!pages.length) return null;
    // every grabber's guards; a kill branch turning another's on is not its own
    var guardsOf = {}, all = {};
    Object.keys($.grabVarsHere()).forEach(function(v) {
        guardsOf[v] = {};
        pages.forEach(function(gp) { Object.assign(guardsOf[v], $.grabGuards(gp.page.list, Number(v))); });
    });
    Object.keys(guardsOf).forEach(function(v) {
        Object.keys(guardsOf[v]).forEach(function(id) { if (!$.SELECT_ACTOR[id]) all[id] = true; });
    });
    // as after the fight: the one fought is dead ("<name>1" on)
    var on = Object.assign($.grabPlayerSelects(), aOn);
    var j = [], over = [], skipped = [];
    $.grabbersFor(pages, on).forEach(function(f) {
        var hit = $.grabberHere(guardsOf[f.v] || $.grabGuards(f.list, f.v), all, interp._eventId);
        if (!hit || hit.busy) {
            skipped.push('V' + f.v + (hit ? ' busy' : ' no fight here'));
            return;
        }
        if (j.some(function(x) { return x.e === hit.e; })) return;
        if (j.length < $.GRAB_MAX_JOIN) j.push(hit); else over.push(hit.e);
    });
    if (skipped.length) $.dlog('grab: not joining -', skipped.join(', '));
    if (over.length) $.dlog('grab: no room in the fight for ev' + over.join(', ev'));
    if (!j.length) return null;
    var troopId = 'fhgrab:' + p[1] + ':' + j.map(function(x) { return x.troop; }).join(',');
    return $.grabTroop(troopId) ? { troopId: troopId, j: j } : null;
};

// The troop "fhgrab:<A>:<B1>,<B2>": the same on every PC from its name (a
// key that is not an index: $dataTroops.length stays).
// fhGroup: each member's fighter (0 the one fought, 1.. the joiners).
$.grabTroop = function(id) {
    if ($dataTroops[id]) return $dataTroops[id];
    var m = typeof id === 'string' ? $.GRAB_TROOP_RE.exec(id) : null;
    if (!m) return null;
    var a = $dataTroops[Number(m[1])], bs = m[2].split(',').map(function(n) { return $dataTroops[Number(n)]; });
    if (!a || bs.some(function(b) { return !b; })) return null;
    var members = [], pages = [], groups = [], aEnemies = {}, fhGroup = [], fhOwnSw = [{}];
    var aOwn = a.members.map(function(x, i) {
        aEnemies[x.enemyId] = true;
        members.push(JsonEx.makeDeepCopy(x));
        fhGroup.push(0);
        return i;
    });
    groups.push(aOwn);
    a.pages.forEach(function(pg) { pages.push($.grabTroopPage(pg, function(i) { return i; }, aOwn)); });
    bs.forEach(function(b, n) {
        var map = {}, own = [], g = n + 1;
        b.members.forEach(function(x, i) {
            if (x.hidden && aEnemies[x.enemyId]) return; // (the gasoline canister: one is enough)
            map[i] = members.length;
            own.push(members.length);
            members.push(JsonEx.makeDeepCopy(x));
            fhGroup.push(g);
        });
        var ownSw = $.grabOwnSwitches(b);
        fhOwnSw.push(ownSw);
        b.pages.forEach(function(pg) {
            var refs = $.grabPageRefs(pg);
            // a page that is not about its enemies is the same as the first one's
            if (!refs.length || refs.some(function(i) { return i >= 0 && map[i] === undefined; })) return;
            var q = $.grabTroopPage(pg, function(i) { return map[i]; }, own);
            $.grabStripJoiner(q);
            $.grabOwnSwitchPage(q, g, ownSw);
            pages.push(q);
        });
        groups.push(own);
    });
    // side by side: each body on its share of the screen
    var w = $.GRAB_WIDTH;
    groups.forEach(function(own, g) {
        var shown = own.filter(function(i) { return !members[i].hidden; });
        if (!shown.length) shown = own;
        var mid = shown.reduce(function(s, i) { return s + members[i].x; }, 0) / shown.length;
        var dx = Math.round(w * (g + 1) / (groups.length + 1) - mid);
        own.forEach(function(i) { members[i].x = Math.max(24, Math.min(w - 24, members[i].x + dx)); });
    });
    var troop = { id: id, name: a.name, members: members, pages: pages, fhGroup: fhGroup, fhOwnSw: fhOwnSw };
    $dataTroops[id] = troop;
    return troop;
};

// The enemy indices a troop page names (-1: all of them).
$.grabPageRefs = function(page) {
    var refs = [];
    if (page.conditions.enemyValid) refs.push(page.conditions.enemyIndex);
    page.list.forEach(function(c) {
        var p = c.parameters, at = $.GRAB_ENEMY_ARG[c.code];
        if (c.code === 111 && p[0] === 5) refs.push(p[1]);
        else if (at !== undefined && !(c.code === 339 && p[0] !== 0)) refs.push(c.code === 337 && p[2] ? -1 : p[at]);
    });
    return refs;
};

// A copy of a troop page with its enemies at their places in the new troop;
// "all of them" is that fighter's own members only (its torso destroyed does
// not kill the others).
$.grabTroopPage = function(page, map, own) {
    var q = JsonEx.makeDeepCopy(page), out = [];
    if (q.conditions.enemyValid) q.conditions.enemyIndex = map(q.conditions.enemyIndex);
    q.list.forEach(function(c) {
        var p = c.parameters, at = $.GRAB_ENEMY_ARG[c.code];
        if (c.code === 111 && p[0] === 5) p[1] = map(p[1]);
        if (at === undefined || (c.code === 339 && p[0] !== 0)) {
            out.push(c);
            return;
        }
        if (p[at] >= 0 && !(c.code === 337 && p[2])) {
            p[at] = map(p[at]);
            out.push(c);
            return;
        }
        own.forEach(function(i) {
            var d = JsonEx.makeDeepCopy(c);
            d.parameters[at] = i;
            if (d.code === 337) d.parameters[2] = false;
            out.push(d);
        });
    });
    q.list = out;
    return q;
};

// A joiner's battle start (turn 0) and turn end pages without what the
// first one's pages do for the fight ($.GRAB_STRIP_START / _END).
$.grabStripJoiner = function(q) {
    var c = q.conditions;
    var strip = c.turnEnding ? $.GRAB_STRIP_END : c.turnValid && c.turnA === 0 && c.turnB === 0 ? $.GRAB_STRIP_START : null;
    if (!strip) return;
    q.list = q.list.filter(function(cmd) {
        var p = cmd.parameters;
        if (cmd.code === 117) return !strip.ce[p[0]];
        if (cmd.code === 122) return !(p[0] === p[1] && strip.v[p[0]]);
        return true;
    });
};

// The switches a joiner's own: its enemies act on them (the torso's tackle on
// SW17 guard1_tackle) and its pages write them. Each fighter keeps its own
// (the joiner's arms cut do not make the first one's torso tackle).
$.grabOwnSwitches = function(troop) {
    var acts = {}, own = {};
    troop.members.forEach(function(m) {
        var en = $dataEnemies[m.enemyId];
        (en && en.actions || []).forEach(function(a) { if (a.conditionType === 6) acts[a.conditionParam1] = true; });
    });
    troop.pages.forEach(function(pg) {
        pg.list.forEach(function(c) {
            var p = c.parameters;
            if (c.code === 121) for (var id = p[0]; id <= p[1]; id++) if (acts[id]) own[id] = true;
        });
    });
    return own;
};

$.grabOwnSwitchPage = function(q, g, own) {
    if (!Object.keys(own).length) return;
    var out = [];
    q.list.forEach(function(c) {
        var p = c.parameters;
        if (c.code === 111 && p[0] === 0 && own[p[1]]) {
            out.push({ code: 111, indent: c.indent,
                parameters: [12, (p[2] === 0 ? '' : '!') + 'FH.Coop.grabSwOn(' + g + ',' + p[1] + ')'] });
            return;
        }
        if (c.code !== 121 || !Object.keys(own).some(function(id) { return p[0] <= id && id <= p[1]; })) {
            out.push(c);
            return;
        }
        for (var id = p[0]; id <= p[1]; id++) {
            if (own[id]) {
                out.push({ code: 355, indent: c.indent,
                    parameters: ['FH.Coop.grabSwSet(' + g + ',' + id + ',' + (p[2] === 0) + ')'] });
            } else {
                out.push({ code: 121, indent: c.indent, parameters: [id, id, p[2]] });
            }
        }
    });
    q.list = out;
};

$.grabSwOn = function(g, id) {
    var sw = $gameTroop && $gameTroop._fhGrabSw;
    return !!sw && !!sw[g + ':' + id];
};

$.grabSwSet = function(g, id, value) {
    if (!$gameTroop) return;
    $gameTroop._fhGrabSw = $gameTroop._fhGrabSw || {};
    $gameTroop._fhGrabSw[g + ':' + id] = !!value;
};

// A joiner's enemy acts on its fighter's own switch.
var _meetsSwitchConditionGrab = Game_Enemy.prototype.meetsSwitchCondition;
Game_Enemy.prototype.meetsSwitchCondition = function(param) {
    var troop = $gameTroop && $.isGrabTroop($gameTroop._troopId) ? $gameTroop.troop() : null;
    var g = troop && troop.fhGroup ? troop.fhGroup[this.index()] : 0;
    if (g > 0 && troop.fhOwnSw[g][param]) return $.grabSwOn(g, param);
    return _meetsSwitchConditionGrab.call(this, param);
};

$.isGrabTroop = function(id) {
    return typeof id === 'string' && $.GRAB_TROOP_RE.test(id);
};

// (a PC that only gets the name: a joiner's view, a guest's own fight)
var _setupTroopGrab = Game_Troop.prototype.setup;
Game_Troop.prototype.setup = function(troopId) {
    if ($.isGrabTroop(troopId)) $.grabTroop(troopId);
    _setupTroopGrab.call(this, troopId);
    this._fhGrabSw = {};
};

// Outermost: the fight with the grabbers in it. The PC that runs the event
// decides (each copy of it again: FH_CoopBattle handBattleToGuest).
var _command301Grab = Game_Interpreter.prototype.command301;
Game_Interpreter.prototype.command301 = function() {
    // (a grabber's death as in its own fight has no fight of its own: M1)
    if (this._fhGrabRun) {
        $.dlog('grab: a fight in a grabber\'s death skipped');
        return true;
    }
    var start = !$gameParty.inBattle();
    var plan = $.role && start && !this._fhSceneFollow ? $.grabPlan(this) : null;
    if (plan) {
        this._params = [0, plan.troopId, this._params[2], this._params[3]];
        $.dlog('grab: they join the fight instead of the grab - ev' + plan.j.map(function(x) { return x.e; }).join(', ev'),
            'troop', plan.troopId);
    }
    // (only this fight's grabbers: none from an earlier one - review 4 H1)
    if (start) this._fhGrab = plan ? { indent: this._indent, j: plan.j } : null;
    var result = _command301Grab.call(this);
    var fx = this._fhFixed;
    if (plan && result && fx) {
        fx.grab = true;
        if ($.fxBattle && $.fxBattle.fx === fx) $.fxBattle.grab = true;
        // their events: nobody else starts a fight with them meanwhile
        fx.grabHolds = plan.j.map(function(x) {
            var ev = $gameMap.event(x.e);
            var h = { m: fx.m, e: x.e, p: ev._pageIndex >= 0 ? ev._pageIndex : x.p, t: 0, who: fx.who, fight: -1, chain: 0 };
            $.fxHoldStart(h, ev.event().pages[h.p]);
            return h;
        });
    }
    return result;
};

// A thin guest's own copy of the fight (FH_CoopBattle "battle"): its troop
// writes go back if lost, switches too.
var _fixedFightGrab = $.guestHandlers.fixedFight;
$.guestHandlers.fixedFight = function(msg) {
    _fixedFightGrab(msg);
    if ($.fxBattle && $.fxBattle.local && $.isGrabTroop($gameTroop._troopId)) $.fxBattle.grab = true;
};

// A roaming guest's grab fight: what its troop writes goes to the host too,
// for the rollback if this PC drops in the middle of it (review 4 L1).
$.grabTroopNote = function(fb, key) {
    var fx = fb.fx;
    if (!$.isGuest() || !$.conn || fb.local || !fx || !fx.held) return;
    $.conn.send({ t: 'fixedTroopRb', m: fx.m, e: fx.e, k: key, v: [fb.vars[key], $.fxRaw(key)] });
};

$.hostHandlers.fixedTroopRb = function(conn, msg) {
    var h = $.fixedHolds[$.fxKey(msg.m, msg.e)];
    if (!h || h.by !== conn.guestId || h.down || !msg.k || !msg.v) return;
    h.rb = h.rb || { keys: {} };
    var had = h.rb.keys[msg.k];
    h.rb.keys[msg.k] = had ? [had[0], msg.v[1]] : msg.v;
};

var _fxRunEndGrab = $.fxRunEnd;
$.fxRunEnd = function(fx, lost) {
    _fxRunEndGrab(fx, lost);
    (fx.grabHolds || []).forEach(function(h) { $.fxHoldEnd(h, false); });
    fx.grabHolds = null;
};

// (their events count as running while the fight they joined does)
var _fxLiveRunsGrab = $.fxLiveRuns;
$.fxLiveRuns = function(fxs) {
    var all = {}, out = _fxLiveRunsGrab(all);
    Object.keys(all).forEach(function(key) {
        (all[key].grabHolds || []).forEach(function(h) {
            if (!h.held) return;
            out[$.fxKey(h.m, h.e)] = out[key];
            all[$.fxKey(h.m, h.e)] = h;
        });
    });
    if (fxs) Object.assign(fxs, all);
    return out;
};

// SW1179 on: never in co-op. The fight with the grabbers was won: each of
// them dies as in its own fight, one after the other, then what the grab page
// writes when it has nobody left to grab (after People_left: CHARACTERS_HOSTILE
// - user decision 2026-10-26; before it the page would still tie the player
// up: nothing). Nobody joined: that write only.
var _command121Grab = Game_Interpreter.prototype.command121;
Game_Interpreter.prototype.command121 = function() {
    var p = this._params;
    if (!$.role || this._fhSceneFollow || p[2] !== 0 || p[0] > $.GRAB_SWITCH || p[1] < $.GRAB_SWITCH) {
        return _command121Grab.call(this);
    }
    for (var id = p[0]; id <= p[1]; id++) if (id !== $.GRAB_SWITCH) $gameSwitches.setValue(id, true);
    if (!this._fhGrabRun) $.grabInstead(this);
    return true;
};

$.grabInstead = function(interp) {
    var g = interp._fhGrab;
    interp._fhGrab = null;
    if (!g) {
        $.grabNobody();
        return;
    }
    if (interp._branch[g.indent] !== 0) {
        $.dlog('grab: the fight they joined was not won - they live');
        return;
    }
    var q = [];
    g.j.forEach(function(x) {
        var ev = $gameMap.event(x.e);
        var list = ev && ev.event() ? ev.event().pages[x.p].list : null;
        var after = list ? $.grabAfterFight(list, x.at) : null;
        if (!after) return;
        var run = [];
        for (var i = after.from; i < after.to; i++) {
            var c = list[i];
            if (c.code === 117 && $.FX_GENERIC_CES[c.parameters[0]]) continue; // (CE66 ran for the fight)
            run.push({ code: c.code, indent: Math.max(0, c.indent - after.indent), parameters: c.parameters });
        }
        run.push({ code: 0, indent: 0, parameters: [] });
        q.push({ list: run, e: x.e });
    });
    q.push({ nobody: true });
    $.dlog('grab: no grab in co-op;', q.length - 1, 'who joined the fight die as in their own');
    interp._fhGrabQueue = q;
};

$.grabNobody = function() {
    var wrote = false;
    $.grabPagesHere().forEach(function(gp) {
        var r = $.grabDryRun(gp.page.list, gp.ev, $.grabPlayerSelects(), {});
        if (r.grab) return;
        Object.keys(r.sw).forEach(function(id) {
            if (Number(id) !== $.GRAB_SWITCH) $gameSwitches.setValue(Number(id), r.sw[id]);
        });
        Object.keys(r.v).forEach(function(id) { $gameVariables.setValue(Number(id), r.v[id]); });
        wrote = true;
    });
    $.dlog('grab: no grab in co-op' + (wrote ? ' (nobody to grab: what the page writes then)' : ''));
};

var _updateChildGrab = Game_Interpreter.prototype.updateChild;
Game_Interpreter.prototype.updateChild = function() {
    if (_updateChildGrab.call(this)) return true;
    var q = this._fhGrabQueue;
    if (!q) return false;
    var next = q.shift();
    if (!q.length) this._fhGrabQueue = null;
    if (!next) return false;
    if (next.nobody) {
        $.grabNobody();
        return false;
    }
    this.setupChild(next.list, next.e);
    var child = this._childInterpreter;
    if (child) {
        child._fhGrabRun = true;
        if (this._fhOwner) child._fhOwner = this._fhOwner;
    }
    return true;
};

//=============================================================================
// A write that changes nothing refreshes nothing (lag audit 2)
//=============================================================================
// The original's parallel events write the same values over and over
// (Map058: V7/V8 120 times a second, V44/V61/V168 and SW1610/2270/2271 60).
// Each write asked for a refresh of the whole map, so every page of every
// event was checked again every frame (922 events on Map058, a third of the
// frame without the mod). The outermost setValue: the write goes through
// every wrapper as before (world sync, causes, contexts, Olivia's Global Meta,
// FilterController's decimals); only its refresh is left out when the stored
// value is the same after it. A nested write (a wrapper writing another
// value) refreshes as asked.
// Same as before (every write refreshes): a <Global> switch (Olivia keeps it
// in the config) and the maps whose pages read more than the switches - the
// Hexen board's souls (boardSoul) and the moonscorched encounter pages
// (encounterPageSwitch: the players' characters).
$.writeDepth = 0;      // the outermost setValue runs
$.writeAsked = false;  // its onChange came (put off to its end)
$.writeNested = false; // another setValue ran inside it
$.globalMetaSwitches = null;

$.refreshEveryWrite = function(cls, id) {
    if (cls === Game_Switches) {
        var meta = $.globalMetaSwitches;
        if (!meta) {
            meta = $.globalMetaSwitches = {};
            ($dataSystem && $dataSystem.switches || []).forEach(function(name, i) {
                if (/<(?:Global|Global Meta)>/i.test(name || '')) meta[i] = true;
            });
        }
        if (meta[id]) return true;
    }
    var mapId = $gameMap ? $gameMap.mapId() : 0;
    return mapId === $.HEXEN_MAP || !!$.ENCOUNTER_MAPS[mapId];
};
$.ENCOUNTER_MAPS = {};
$.ENCOUNTER_PAGES.forEach(function(e) { $.ENCOUNTER_MAPS[e.m] = true; });

$.refreshOnlyIfChanged = function(cls) {
    var set = cls.prototype.setValue, change = cls.prototype.onChange;
    cls.prototype.setValue = function(id, value) {
        if ($.writeDepth) {
            $.writeNested = true;
            return set.apply(this, arguments);
        }
        var data = this._data, before = data[id];
        $.writeDepth++;
        $.writeAsked = $.writeNested = false;
        try {
            return set.apply(this, arguments);
        } finally {
            $.writeDepth--;
            var asked = $.writeAsked;
            var same = !$.writeNested && this._data === data && data[id] === before;
            $.writeAsked = $.writeNested = false;
            if (asked && (!same || $.refreshEveryWrite(cls, id))) change.call(this);
        }
    };
    cls.prototype.onChange = function() {
        if ($.writeDepth) {
            $.writeAsked = true;
            return;
        }
        return change.apply(this, arguments);
    };
};
[Game_Switches, Game_Variables, Game_SelfSwitches].forEach($.refreshOnlyIfChanged);

// Pages and common events that read the session itself (grab pages, the
// Rher timer CE's isActive): a session starting or ending refreshes the map.
$.refreshRole = null;
var _refreshIfNeededRole = Game_Map.prototype.refreshIfNeeded;
Game_Map.prototype.refreshIfNeeded = function() {
    if ($.refreshRole !== $.role) {
        $.refreshRole = $.role;
        this._needsRefresh = true;
    }
    _refreshIfNeededRole.call(this);
};

// Values the mod writes straight into the world (not through setValue) on
// the way into a world of its own: the map's pages follow them.
var _startRoamRefresh = $.startRoam;
$.startRoam = function(msg) {
    _startRoamRefresh(msg);
    if ($gameMap) $gameMap.requestRefresh();
};

//=============================================================================
// Re-joins (flow tests 2026-10-28, docs/조사(보관용)/흐름테스트_결과.md)
//=============================================================================

// A. The spot kept for a re-join (and in a save) is never a dream map. One
// who dropped in the dream came back alone into Map032: its dream ran again
// from the start, CE303 with it (a second day for everyone), and Leave took
// it to CE440's fallback (Map004). The dream is the group's night; one who
// left it is out of that night ("Sleeping together": a drop holds nobody)
// and comes back awake where it was before its dream - its bed's map.
// Not a re-join spot either: Map129 (day_change), where some nights everyone
// passes on the way out of the dream (Map032 EV7 Leave with SW4712) before
// CE440 - a re-join there woke at CE440's fallback (review 6 #1). Kept apart
// from DREAM_MAPS (the transfers, sub-hosts and sleep barriers read that).
$.NO_REJOIN_MAPS = { 31: true, 32: true, 129: true };
$.worldExtras.push(function() {
    if (!$.isHost()) return;
    $.clients.forEach(function(c) {
        var p = c.lastPos;
        if (!p || !p.m || $.NO_REJOIN_MAPS[p.m]) return;
        var a = c._fhAwakePos;
        if (a && a.m === p.m && a.x === p.x && a.y === p.y && a.d === p.d) return;
        c._fhAwakePos = { m: p.m, x: p.x, y: p.y, d: p.d };
    });
});

// the kept spot of one player: its last spot before a dream, else none
// (it then comes back where the host's world has it)
// log: say so (a drop; a save writes it again each time - review 6 #4)
$.keepAwakeSpot = function(c, log) {
    var data = $.coopData(), pos = data.pos;
    var p = pos && c && pos[c.name];
    if (!p || !$.NO_REJOIN_MAPS[p.m]) return;
    var a = c._fhAwakePos;
    if (a) pos[c.name] = { m: a.m, x: a.x, y: a.y, d: a.d };
    else delete pos[c.name];
    if (log) $.dlog('re-join spot of', c.name, 'out of map', p.m + ':', a ? 'map ' + a.m + ' ' + a.x + ',' + a.y : 'none');
};

var _onGuestClosedAwake = $.onGuestClosed;
$.onGuestClosed = function(conn) {
    _onGuestClosedAwake(conn);
    if ($.isHost() && conn && conn.name && $gameSystem) $.keepAwakeSpot(conn, true);
};

// (the save's copy: contents.system is $gameSystem, written out after this)
var _makeSaveContentsAwake = DataManager.makeSaveContents;
DataManager.makeSaveContents = function() {
    var contents = _makeSaveContentsAwake.call(this);
    // (one not placed yet after a load keeps the save's spot as the save has
    // it: its _fhAwakePos is from before the load - pushMe drops a bad one)
    if ($.isHost() && $gameSystem) {
        $.clients.forEach(function(c) { if (!c._needPos) $.keepAwakeSpot(c, false); });
    }
    return contents;
};

// An older save (or record) with a dream map spot: not used.
var _pushMeAwake = $.pushMe;
$.pushMe = function(conn) {
    if (conn && conn._needPos && conn.name) {
        var saved = ($.coopData().pos || {})[conn.name];
        if (saved && $.NO_REJOIN_MAPS[saved.m]) {
            delete $.coopData().pos[conn.name];
            $.dlog('re-join spot of', conn.name, 'was map', saved.m, '- not used');
        }
    }
    _pushMeAwake(conn);
};

// A roam marked menuOn (a re-join, a load, out of the host's dream): the menu
// is on whatever the host's world had (review 6 #2). Not with an event of its
// own (the event decides).
var _startRoamMenuOn = $.startRoam;
$.startRoam = function(msg) {
    _startRoamMenuOn(msg);
    if (msg && msg.menuOn && !msg.interp && $gameSystem) $gameSystem.enableMenu();
};

// C. Back at its title (a re-join), a guest gets the host's snapshot and,
// when its spot is on another map, a 'roam' right after: with a big snapshot
// both come in one read, before the title applies the snapshot. The roam
// dropped the snapshot (the later of the two wins on a map), but the title
// only applies snapshots and a roam starts only from a map scene - stuck at
// the title for good. There the snapshot takes it into the game first; its
// roam starts as soon as the map scene is up.
var _roamAfterTitle = $.guestHandlers.roam;
$.guestHandlers.roam = function(msg) {
    if ($.pendingSnapshot && SceneManager._scene instanceof Scene_Title) {
        $.pendingSnapshot._fhThenRoam = msg;
        $.roamDeltas = [];
        $.waitingSnap = false;
        $.dlog('roam to map', msg && msg.pos ? msg.pos.m : '?', 'waits for the snapshot (at the title)');
        return;
    }
    _roamAfterTitle(msg);
};

var _processSnapshotThenRoam = $.processPendingSnapshot;
$.processPendingSnapshot = function() {
    var snap = $.pendingSnapshot;
    var then = snap && snap._fhThenRoam;
    _processSnapshotThenRoam();
    if (then && $.pendingSnapshot !== snap && !$.pendingSnapshot && !$.pendingRoam) $.pendingRoam = then;
};

// what comes for that roam's world meanwhile goes with it
var _wDeltaThenRoam = $.guestHandlers.wDelta;
$.guestHandlers.wDelta = function(msg) {
    if ($.pendingSnapshot && $.pendingSnapshot._fhThenRoam) {
        $.roamDeltas.push(msg);
        return;
    }
    _wDeltaThenRoam(msg);
};

// Host: a new connection has not said where it is yet ($.settleSubs).
var _helloGoesOnNoPos = $.helloGoesOn;
$.helloGoesOn = function(conn, msg) {
    _helloGoesOnNoPos(conn, msg);
    if (conn && conn.guestId) conn._fhNoPos = true;
};

var _subJoinThenRoam = $.guestHandlers.subJoin;
$.guestHandlers.subJoin = function(msg) {
    var then = $.pendingSnapshot && $.pendingSnapshot._fhThenRoam;
    if (then && !$.isRoaming()) {
        $.joinSubAfterRoam = then.pos ? then.pos.m : 0;
        return;
    }
    _subJoinThenRoam(msg);
};

//=============================================================================
// Saves are the host's
//=============================================================================
// The host keeps the saves. The God of Fear & Hunger's statue (FH_CoopBattle
// $.savePage) and the Book of enlightenment (item 40: CE22) open the save
// screen and are used up once used, so a guest neither starts the one nor
// uses the other (user decision 2026-10-31): a guest's start of a save page
// is turned down (the host or sub-host running it, or its own PC), the book
// is greyed out in a guest's menu and no trade gives it to a guest.
$.HOST_SAVE_TEXT = 'Co-op: only the host can use this (the host keeps the saves).';

$.eventStartHooks.push(function(conn, ev, page) {
    if (!$.savePage(page)) return false;
    if (conn) conn.send({ t: 'toast', text: $.HOST_SAVE_TEXT });
    $.dlog('save page of map', $gameMap.mapId(), 'ev' + ev.eventId(), 'not for', conn ? conn.name : '?');
    return true;
});

var _startSaveGuest = Game_Event.prototype.start;
Game_Event.prototype.start = function() {
    if ($.isGuest() && $.sessionActive() && $.savePage(this.page())) {
        $.toast($.HOST_SAVE_TEXT);
        return;
    }
    _startSaveGuest.call(this);
};

var _canUseHostBook = Game_Party.prototype.canUse;
Game_Party.prototype.canUse = function(item) {
    if ($.isGuest() && item && DataManager.isItem(item) && item.id === $.HOST_BOOK_ITEM) return false;
    return _canUseHostBook.call(this, item);
};

var _doTradeHostBook = $.doTrade;
$.doTrade = function(fromId, msg) {
    if (msg && msg.k === 'i' && Number(msg.id) === $.HOST_BOOK_ITEM && msg.to !== 'host') {
        return $.refuseTrade(fromId, msg, 'the book is the host\'s');
    }
    return _doTradeHostBook(fromId, msg);
};

// A guest who gets the book keeps it (user decision 2026-11-02 night: it
// went to the host's bag by itself, 2026-10-31 - odd). It cannot read it (the
// host keeps the saves): it can give it to the host (Trade).
$.HOST_BOOK_ITEM = 40;

// Books (user decision 2026-11-02 night; before, the bookshelf's book went to
// every player): a book is the one finder's, and the original's "have it
// already?" checks that keep a book from coming out twice look at every
// player's bag - a book anyone has found does not come out again. They are
// the bookshelves' (CE25 and CE513 "got_all_the_books?", the museum's own
// Map084 EV576 with the same 26 books) and the NLU report pick-ups (report #1,
// then #2). Checks that use a book (a recipe book's crafting, copying marks
// to the Prehevil map, the Crosswords puzzle in Judgement's talk) stay the
// player's own. Books trade like other items (FH_CoopWorld Window_FHTradeItems).
// The Book of enlightenment (40) and the 'Man in dreams' flyer (360) come many
// times in the original: not in the list.
$.DUP_BOOKS = {
    3: true, 4: true, 13: true, 22: true, 23: true, 89: true, 98: true,
    133: true, 136: true, 208: true, 210: true, 211: true, 212: true,
    215: true, 221: true, 243: true, 244: true, 258: true, 259: true,
    315: true, 316: true, 317: true, 318: true, 320: true, 321: true,
    363: true, 364: true
};
$.BOOK_DUP_CES = { 25: true, 513: true };
$.BOOK_DUP_EVENTS = { 84: [576], 118: [86, 87, 88, 91, 92, 93], 169: [120, 121, 122, 123, 124, 126, 127, 129, 130] };

// Every book of the wiki's list in the game (key items): these trade. The
// Book of enlightenment only from a guest (to the host: $.doTrade above).
$.TRADE_BOOKS = Object.assign({
    1: true, 2: true, 18: true, 26: true, 195: true, 196: true, 203: true, 226: true, 239: true,
    271: true, 304: true, 314: true, 319: true, 322: true, 323: true, 324: true, 325: true, 326: true,
    360: true, 361: true, 362: true
}, $.DUP_BOOKS);
$.isTradeBook = function(item) {
    if (!item || !DataManager.isItem(item)) return false;
    if (item.id === $.HOST_BOOK_ITEM) return $.isGuest();
    return !!$.TRADE_BOOKS[item.id];
};

$.bookClaims = function() {
    if (!$gameSystem) return {};
    var claims = $gameSystem._fhCoopBookClaims || ($gameSystem._fhCoopBookClaims = {});
    function seed(items) {
        Object.keys($.DUP_BOOKS).forEach(function(id) {
            if (items && items[id] > 0) claims[id] = true;
        });
    }
    if ($.isHost()) {
        seed($.ctxSave && $.ctxSave.items ? $.ctxSave.items : $gameParty._items);
        $.clients.forEach(function(conn) {
            var inv = $.inventoryOf(conn);
            seed(inv && inv.i);
        });
    } else {
        seed($.ctxSave && $.ctxSave.items ? $.ctxSave.items : $gameParty._items);
    }
    return claims;
};

$.isDupBook = function(item) {
    return !!(item && DataManager.isItem(item) && $.DUP_BOOKS[item.id]);
};

$.bookIds = function() {
    var claims = $.bookClaims();
    return Object.keys(claims).filter(function(id) { return claims[id]; }).map(Number).sort(function(a, b) { return a - b; });
};

$.sendSharedBooks = function(conn) {
    if (conn) conn.send({ t: 'bookState', ids: $.bookIds() });
};

// Host: what was found goes to every PC (a roaming guest's shelf checks on
// its own PC), when it changes. Found on a guest's PC: its roamMe bag or its
// bookClaim.
$.bookKeySent = '';
// (a load or a new game: the new world's found books go out again)
var _extractSaveContentsBooks = DataManager.extractSaveContents;
DataManager.extractSaveContents = function(contents) {
    _extractSaveContentsBooks.call(this, contents);
    if (!$.isGuest()) $.bookKeySent = '';
};
var _setupNewGameBooks = DataManager.setupNewGame;
DataManager.setupNewGame = function() {
    _setupNewGameBooks.call(this);
    if (!$.isGuest()) $.bookKeySent = '';
};
$.syncBookClaims = function() {
    if (!$.isHost() || !$gameSystem) return;
    var ids = $.bookIds(), key = ids.join(',');
    if (key === $.bookKeySent) return;
    $.bookKeySent = key;
    $.clients.forEach(function(conn) { conn.send({ t: 'bookState', ids: ids }); });
};

var _hostSyncBooks = $.hostSync;
$.hostSync = function() {
    _hostSyncBooks();
    $.syncBookClaims();
};

$.hostHandlers.bookClaim = function(conn, msg) {
    var id = Number(msg && msg.id);
    if (!$.DUP_BOOKS[id]) return;
    if (!$.isHost()) {
        $.bookClaims()[id] = true;
        if ($.conn) $.conn.send({ t: 'bookClaim', id: id }); // (a sub-host: on to the host)
        return;
    }
    $.bookClaims()[id] = true;
    $.syncBookClaims();
};

$.hostHandlers.bookSync = function(conn, msg) {
    if (!$.isHost()) {
        if ($.conn) $.conn.send({ t: 'bookSync', ids: msg && Array.isArray(msg.ids) ? msg.ids : [] });
        return;
    }
    // the books in a guest's bag count as found
    var claims = $.bookClaims();
    (msg && Array.isArray(msg.ids) ? msg.ids : []).forEach(function(id) {
        if ($.DUP_BOOKS[Number(id)]) claims[Number(id)] = true;
    });
    $.sendSharedBooks(conn);
};

$.guestHandlers.bookState = function(msg) {
    var claims = $.bookClaims();
    (msg && msg.ids || []).forEach(function(id) {
        id = Number(id);
        if ($.DUP_BOOKS[id]) claims[id] = true;
    });
    // a sub-host: its guests' PCs as well
    if ($.clients && $.clients.length) $.clients.forEach(function(conn) { $.sendSharedBooks(conn); });
};

$.bookSyncConn = null;
$.guestExtras.push(function() {
    if ($.isGuest() && $.conn && $.bookSyncConn !== $.conn) {
        $.bookSyncConn = $.conn;
        $.conn.send({ t: 'bookSync', ids: $.bookIds() });
    }
});

// Guest: a book found on this PC is told to the host at once (two shelves
// rolled at the same time on two PCs could still give the same one).
var _gainItemBooks = Game_Party.prototype.gainItem;
Game_Party.prototype.gainItem = function(item, amount, includeEquip) {
    _gainItemBooks.call(this, item, amount, includeEquip);
    if (this === $gameParty && amount > 0 && $.isGuest() && $.conn && $.isDupBook(item)) {
        $.bookClaims()[item.id] = true;
        $.conn.send({ t: 'bookClaim', id: item.id });
    }
};

var _command117Book = Game_Interpreter.prototype.command117;
Game_Interpreter.prototype.command117 = function() {
    var bookShelf = this._fhBookShelf || !!$.BOOK_DUP_CES[Number(this._params[0])];
    var result = _command117Book.call(this);
    if (bookShelf && this._childInterpreter) this._childInterpreter._fhBookShelf = true;
    return result;
};

var _setupBooks = Game_Interpreter.prototype.setup;
Game_Interpreter.prototype.setup = function(list, eventId) {
    _setupBooks.call(this, list, eventId);
    var evs = eventId && $gameMap && $.BOOK_DUP_EVENTS[$gameMap.mapId()];
    this._fhBookShelf = !!(evs && evs.indexOf(eventId) >= 0);
};

var _command111Book = Game_Interpreter.prototype.command111;
Game_Interpreter.prototype.command111 = function() {
    var checking = this._fhBookShelf;
    if (checking) $.bookShelfCheckDepth = ($.bookShelfCheckDepth || 0) + 1;
    try {
        return _command111Book.call(this);
    } finally {
        if (checking) $.bookShelfCheckDepth--;
    }
};

// The shelves roll again (a jump back, no wait) for a book that is had: if the
// rolls keep landing on found books within one frame (a shelf whose books are
// not all in CE513's count), this PC's own bag decides from there.
$.BOOK_ROLL_MAX = 500;
$.bookRollFrame = -1;
$.bookRollHits = 0;
var _hasItemBooks = Game_Party.prototype.hasItem;
Game_Party.prototype.hasItem = function(item, includeEquip) {
    var own = _hasItemBooks.call(this, item, includeEquip);
    if (own || !$.bookShelfCheckDepth || !$.isDupBook(item)) return own;
    // (a co-op save played alone: its own bag, as the original - review 2026-11-03)
    if (!$.role || !$.sessionActive() || !$.bookClaims()[item.id]) return own;
    if ($.bookRollFrame !== Graphics.frameCount) {
        $.bookRollFrame = Graphics.frameCount;
        $.bookRollHits = 0;
    }
    return ++$.bookRollHits <= $.BOOK_ROLL_MAX;
};

// The herbal and cooking books' recipes (YEP_ItemSynthesis <Item Recipe: n>
// read from the bag) are everyone's once anyone has found the book (user
// decision 2026-11-02 night: else the books go back and forth for each
// craft). Alchemillia vol.1-3, Recipes of the 15th Century vol.1-2. With
// SKILL_masterchef (SW1942, each player's board) also the cooking books'
// hidden copies (357, 356), as the original gives them with the book.
$.RECIPE_BOOKS = [133, 13, 89, 3, 243];
$.MASTERCHEF_SW = 1942;
$.MASTERCHEF_COPIES = { 3: 357, 243: 356 };
$.sharedRecipeBooks = function() {
    if (!$.role || !$gameSystem) return [];
    var claims = $.bookClaims(), out = [];
    $.RECIPE_BOOKS.forEach(function(id) {
        if (!claims[id]) return;
        out.push($dataItems[id]);
        var copy = $.MASTERCHEF_COPIES[id];
        if (copy && $gameSwitches.value($.MASTERCHEF_SW)) out.push($dataItems[copy]);
    });
    return out.filter(Boolean);
};

if (typeof Scene_Synthesis !== 'undefined' && Scene_Synthesis.availableLibrary) {
    var _availableLibraryBooks = Scene_Synthesis.availableLibrary;
    Scene_Synthesis.availableLibrary = function() {
        var library = _availableLibraryBooks.call(this);
        if ($gameTemp._synthRecipe) return library; // one recipe item's own window
        var shared = $.sharedRecipeBooks();
        if (shared.length) library.push(shared);
        return library;
    };
}

// Heroin's private cutscene hides the guest's local player. Keep that
// presentation local: its avatar remains visible to the host and other PCs.
$.HEROIN_CE = 258;
var _setupHeroinPresentation = Game_Interpreter.prototype.setup;
Game_Interpreter.prototype.setup = function(list, eventId) {
    _setupHeroinPresentation.call(this, list, eventId);
    this._fhHeroinPresentation = !!($dataCommonEvents[$.HEROIN_CE] &&
        list === $dataCommonEvents[$.HEROIN_CE].list);
};

$.heroinPresentationRunning = function(interpreter) {
    if (!interpreter) return false;
    if (interpreter._fhHeroinPresentation && interpreter.isRunning()) return true;
    return $.heroinPresentationRunning(interpreter._childInterpreter);
};

$.isHeroinPresentationRunning = function() {
    if (!$gameMap) return false;
    if ($.heroinPresentationRunning($gameMap._interpreter)) return true;
    return $gameMap.events().some(function(ev) {
        return $.heroinPresentationRunning(ev._interpreter);
    });
};

var _playerInfoHeroin = $.playerInfo;
$.playerInfo = function(id) {
    var info = _playerInfoHeroin(id);
    if ($.isGuest() && $gamePlayer.isTransparent() && $.isHeroinPresentationRunning()) info.tr = 0;
    return info;
};

// An event a guest's event spawns (GALV: CE258 HEROIN spawns Map028 EV1, the
// injection, at the player) is that guest's: its autorun page runs for that
// guest. Item common events write no causes (FH_CoopWorld causeSkip), so the
// host ran it (review 2026-11-03): the guest got the black screen and was
// hidden (CE258), but the page's "show the player" (211 [1]) and its screen
// tint back went to the host, and the guest stayed hidden on a black screen.
// (the new event starts its autorun page as it is made - Game_Event
// setupPage: $.spawningFor tells whose it is by then)
$.spawningFor = null;
if (Game_Map.prototype.spawnEvent) {
    var _spawnEventOwner = Game_Map.prototype.spawnEvent;
    Game_Map.prototype.spawnEvent = function(id, x, y, save) {
        var n = this._events.length;
        var owner = $.ctx && $.ctx.guestId && $.runsWorld() ? $.ctx.guestId : null;
        var was = $.spawningFor;
        $.spawningFor = owner;
        try {
            return _spawnEventOwner.call(this, id, x, y, save);
        } finally {
            $.spawningFor = was;
            if (owner) for (var i = n; i < this._events.length; i++) if (this._events[i]) this._events[i]._fhSpawnFor = owner;
        }
    };
}

var _gameEventStartSpawnFor = Game_Event.prototype.start;
Game_Event.prototype.start = function() {
    if (!this._fhSpawnFor && $.spawningFor && this.isSpawnEvent) this._fhSpawnFor = $.spawningFor;
    var owner = this._fhSpawnFor;
    if (owner && this._trigger === 3 && $.runsWorld() && !this._fhOwner && !$gamePlayer._fhRemoteId) {
        var conn = $.clientById(owner);
        if (conn && conn.actorId && $.guestOnMap(conn) && !$.isDown(owner)) {
            if ($.isBusy(conn)) return; // (its event that spawned it is finishing)
            if ($.startEventFor(conn, this, [3])) return;
        }
    }
    _gameEventStartSpawnFor.call(this);
};

//=============================================================================
// Roaming monsters: one at a time in the whole session (the mob, Needles)
//=============================================================================
// The mob ambushes (troop 235 Mob: riflemen, half-cocooned, meat grinder) wait
// on lines across the streets (Map039 EV541/544, Map055 EV572/617-619, Map057
// EV521/522, Map060 EV421, Map079 EV343-350): each step on one rolls
// ambush_random (V2380, 1 in 3 to 6) and a hit sets that place's ambush
// variable to 2 - its autorun brings the mob and arms every other place
// again. Needles: each map's parallel event (Map036 EV109 ...) waits 999
// frames, rolls 1 in 2, puts Needles there and turns SW1096 Needles_HERE on;
// CE104 turns it off at every room change. The gull bros (troop 239, hard
// mode: V2600 GULL_BROS_ACTIVE) the same way: Map036 EV397 ... and V2612
// Gulls_HERE = 1.
// With several players every one of them rolled, and one player's room
// change let Needles come on another map while it stood on the first: the
// mob came at nearly every map change (play test 2026-11-01). Now (user
// decision 2026-11-01):
// - one roll for a line however many cross it: after one player rolled
//   there, the others' steps on it do not roll for a while (on that PC: two
//   players on one map are on one PC);
// - while the mob, Needles or the gull bros are out on someone's map, they
//   do not come on any other map, until nobody is on that map any more. The
//   host keeps these (stalkLocks) and sends them to every PC that runs a map.
$.AMBUSH_ROLL_VAR = 2380; // ambush_random
$.AMBUSH_VARS = [2374, 2375, 2365, 2378, 2376]; // the places' ambush variables (west, back alleys ...)
$.AMBUSH_SHARE_MS = 60000;
// the ones a map's parallel page puts there: its "here" switch or variable
$.STALKERS = { needles: { sw: 1096 }, gulls: { v: 2612 } };
$.stalkLocks = {};  // { mob | needles | gulls: { m, by } } - the host's, copied to every PC
$.ambushRolls = {}; // this PC: { 'map:variable': { by, at } }

// The ambush variable a line's page sets on a hit (0: not an ambush line).
$.ambushVarOf = function(page) {
    if (!page) return 0;
    if (page._fhAmbushVar !== undefined) return page._fhAmbushVar;
    var rolled = false, found = 0;
    (page.list || []).some(function(c) {
        var p = c.parameters;
        if (c.code !== 122) return false;
        if (p[0] === $.AMBUSH_ROLL_VAR && p[3] === 2) rolled = true;
        else if (rolled && $.AMBUSH_VARS.indexOf(p[0]) >= 0 && p[3] === 0 && p[4] === 2) found = p[0];
        return !!found;
    });
    page._fhAmbushVar = found;
    return found;
};

// The one a map's parallel page puts on the map ('' if none).
$.stalkerSpawnOf = function(page) {
    if (!page || page.trigger !== 4) return '';
    if (page._fhStalker === undefined) {
        page._fhStalker = '';
        (page.list || []).some(function(c) {
            var p = c.parameters;
            return Object.keys($.STALKERS).some(function(kind) {
                var s = $.STALKERS[kind];
                var on = s.sw ? c.code === 121 && p[0] <= s.sw && p[1] >= s.sw && p[2] === 0 :
                    c.code === 122 && p[0] <= s.v && p[1] >= s.v && p[2] === 0 && p[3] === 0 && p[4] >= 1;
                if (on) page._fhStalker = kind;
                return on;
            });
        });
    }
    return page._fhStalker;
};

$.runsOwnMap = function() {
    return !!$.role && ($.runsWorld() || $.isRoaming());
};

$.stalkWho = function() {
    if ($.ctx) return $.ctx.guestId;
    return $.isHost() ? 'host' : ($.myId || 'me');
};

$.stalkOut = function(kind) {
    return !!$.stalkLocks[kind];
};

$.setStalkLock = function(kind, mapId) {
    if ($.stalkLocks[kind]) return;
    var by = $.isHost() ? $.stalkWho() : ($.myId || 'me');
    $.stalkLocks[kind] = { m: mapId, by: by };
    $.dlog('roaming monster out:', kind, 'map', mapId, 'by', $.playerLabel ? $.playerLabel(by) : by);
    if (!$.isHost() && $.conn) $.conn.send({ t: 'stalkLock', k: kind, m: mapId });
};

$.hostHandlers.stalkLock = function(conn, msg) {
    if (!$.isHost()) { // a sub-host: on to the host
        if ($.conn) $.conn.send(msg);
        return;
    }
    var kind = msg && (msg.k === 'mob' || $.STALKERS[msg.k]) ? msg.k : null;
    if (!kind) return;
    var had = $.stalkLocks[kind];
    if (had) {
        if (had.m !== msg.m) $.dlog('roaming monster out twice:', kind, 'map', had.m, 'and', msg.m, '(first kept)');
        return;
    }
    $.stalkLocks[kind] = { m: Number(msg.m) || 0, by: conn.guestId };
    $.dlog('roaming monster out:', kind, 'map', msg.m, 'by', $.playerLabel ? $.playerLabel(conn.guestId) : conn.name);
};

$.guestHandlers.stalk = function(msg) {
    $.stalkLocks = (msg && msg.locks) || {};
};

// A line's roll: none while a mob is out, one for the players crossing together.
var _command122Stalk = Game_Interpreter.prototype.command122;
Game_Interpreter.prototype.command122 = function() {
    var p = this._params;
    if (p[0] === $.AMBUSH_ROLL_VAR && p[3] === 2 && this._eventId > 0 && $.runsOwnMap()) {
        var ev = $gameMap.event(this._eventId);
        var amb = ev && ev._pageIndex >= 0 ? $.ambushVarOf(ev.page()) : 0;
        if (amb) {
            var key = $gameMap.mapId() + ':' + amb, who = $.stalkWho(), now = $.clockMs();
            var last = $.ambushRolls[key];
            var why = $.stalkOut('mob') ? 'the mob is out on map ' + $.stalkLocks.mob.m :
                last && last.by !== who && now - last.at < $.AMBUSH_SHARE_MS ? 'rolled for ' + last.by : '';
            if (why) {
                $gameVariables._data[$.AMBUSH_ROLL_VAR] = 0; // no hit
                if ($.ambushSkipLog !== key + why) {
                    $.ambushSkipLog = key + why;
                    $.dlog('ambush line', key, 'no roll:', why);
                }
                return true;
            }
            $.ambushRolls[key] = { by: who, at: now };
        }
    }
    return _command122Stalk.call(this);
};

var _setVariableStalk = Game_Variables.prototype.setValue;
Game_Variables.prototype.setValue = function(id, value) {
    var was = this._data[id];
    _setVariableStalk.call(this, id, value);
    if (!$.runsOwnMap() || !$gameMap) return;
    if (value === 2 && was !== 2 && $.AMBUSH_VARS.indexOf(id) >= 0) $.setStalkLock('mob', $gameMap.mapId());
    if (value >= 1 && !(was >= 1) && id === $.STALKERS.gulls.v) $.setStalkLock('gulls', $gameMap.mapId());
};

var _setSwitchStalk = Game_Switches.prototype.setValue;
Game_Switches.prototype.setValue = function(id, value) {
    var was = !!this._data[id];
    _setSwitchStalk.call(this, id, value);
    if (id === $.STALKERS.needles.sw && value && !was && $.runsOwnMap() && $gameMap) {
        $.setStalkLock('needles', $gameMap.mapId());
    }
};

// Its spawn page waits while it is out somewhere (on its own map too: there
// it stands already).
var _updateParallelStalk = Game_Event.prototype.updateParallel;
Game_Event.prototype.updateParallel = function() {
    if (this._interpreter && !this.page()) return;
    if (this._interpreter && $.runsOwnMap()) {
        var kind = $.stalkerSpawnOf(this.page());
        if (kind && $.stalkOut(kind)) return;
    }
    _updateParallelStalk.call(this);
};

// The host: a monster is gone with the last player on its map.
$.stalkMapsHeld = function() {
    var maps = {};
    maps[$gameMap.mapId()] = true;
    $.clients.forEach(function(c) {
        if (c.inGame && c.lastPos && c.lastPos.m) maps[c.lastPos.m] = true;
    });
    return maps;
};

var _hostSyncStalk = $.hostSync;
$.hostSync = function() {
    _hostSyncStalk();
    if (!$.isHost()) return;
    var held = null;
    Object.keys($.stalkLocks).forEach(function(kind) {
        held = held || $.stalkMapsHeld();
        if (held[$.stalkLocks[kind].m]) return;
        $.dlog('roaming monster gone:', kind, '(nobody on map', $.stalkLocks[kind].m + ')');
        delete $.stalkLocks[kind];
    });
    var key = JSON.stringify($.stalkLocks);
    $.clients.forEach(function(c) {
        if (c._stalkKey === key) return;
        c._stalkKey = key;
        c.send({ t: 'stalk', locks: $.stalkLocks });
    });
};

var _resetRoamsStalk = $.resetRoams;
$.resetRoams = function() {
    _resetRoamsStalk();
    // (a guest keeps the host's: they come once per change of them)
    if (!$.role || $.isHost()) $.stalkLocks = {};
    $.ambushRolls = {};
};

//=============================================================================
// The host walks onto a guest's map: the map as that guest had it
//=============================================================================
// Play test 2026-11-02 (a friend hosting): the host came onto the map a guest
// was running and the guest's enemies went back to their first spots or
// jumped. The guest went back to the host's game ('unroam') with its
// character and bag only; the host had just set the map up from its data, so
// its events stood where the map starts them, and the guest got that world.
// Now a guest that has run the map longer than the host has been on it sends
// where the map's own events are (spot, direction, erased) with 'unroam', and
// the host puts its events there before the snapshot. Not the other way: when
// the host was there first, its world is the newer one.
$.mapSetupAt = 0; // (real time) this PC set its map up

var _gameMapSetupAt = Game_Map.prototype.setup;
Game_Map.prototype.setup = function(mapId) {
    _gameMapSetupAt.call(this, mapId);
    $.mapSetupAt = $.clockMs();
};

var _startRoamAt = $.startRoam;
$.startRoam = function(msg) {
    _startRoamAt(msg);
    if ($.roam) $.roam.at = $.clockMs();
};

// This PC's map's own events (not spawned ones, Rher forms or bodies) where
// they are not as the map starts them.
$.roamEventStates = function() {
    var out = [], data = $dataMap && $dataMap.events;
    if (!data || !$gameMap) return out;
    $gameMap.events().forEach(function(ev) {
        var d = data[ev.eventId()];
        if (!d || d !== ev.event() || d._fhBody || d._fhRher) return;
        // (one with a saved spot is sent at its first spot too: the host's may
        // stand where its own older saved spot put it - review 2026-11-03)
        var saves = ev.isSaveLocation ? ev.isSaveLocation() : false;
        if (ev.x === d.x && ev.y === d.y && !ev._erased && !saves) return;
        out.push({ i: ev.eventId(), x: ev.x, y: ev.y, d: ev.direction(), e: ev._erased ? 1 : 0 });
    });
    return out;
};

// How long this PC has run its map (since its roam began or its last map).
$.roamMapMs = function() {
    if (!$.roam) return 0;
    return Math.max(0, $.clockMs() - Math.max($.roam.at || 0, $.mapSetupAt || 0));
};

// Host: its events where the guest had them (none it runs or that runs now).
$.applyRoamEventStates = function(list) {
    var moved = 0;
    (list || []).forEach(function(s) {
        var ev = $gameMap.event(Number(s.i));
        var d = ev && $dataMap && $dataMap.events[ev.eventId()];
        if (!ev || !d || d !== ev.event() || d._fhBody || d._fhRher) return;
        if (ev._fhOwner || ev._locked || ev.isStarting()) return;
        if ($gameMap._interpreter.isRunning() && $gameMap._interpreter.eventId() === ev.eventId()) return;
        if (s.e) {
            ev.erase();
        } else {
            // (YEP_SaveEventLocations: locate loads this PC's older saved
            // spot - the Bellends, the wanderers; the new one is saved)
            $gameTemp._bypassLoadLocation = true;
            try {
                ev.locate(Number(s.x), Number(s.y));
            } finally {
                $gameTemp._bypassLoadLocation = undefined;
            }
            if (s.d) ev.setDirection(Number(s.d));
            if (ev.saveLocation) ev.saveLocation();
        }
        moved++;
    });
    return moved;
};

var _unroamStates = $.hostHandlers.unroam;
$.hostHandlers.unroam = function(conn, msg) {
    if (conn && conn.roam && msg && Array.isArray(msg.ev) && msg.m === $gameMap.mapId() &&
            Number(msg.ms) > $.clockMs() - $.mapSetupAt) {
        var n = $.applyRoamEventStates(msg.ev);
        $.dlog('unroam', conn.name, 'ran map', msg.m, 'longer than the host: its events kept (' + n + ')');
    }
    return _unroamStates(conn, msg);
};

//=============================================================================
// Saved event locations: the world's, not each PC's
//=============================================================================
// YEP_SaveEventLocations keeps where 520 events of 99 maps are (the
// wanderers, the hard mode Bellends: <Save Event Location>) in $gameSystem,
// so they were each PC's own: a Bellend that fell on a guest's PC stood in
// the sky again once the host's world had that map (play test 2026-11-02
// night). A PC leaving a map (its own transfer, a guest going back to the
// host) sends that map's saved spots with the world changes; the host passes
// them on to the other roaming PCs. A PC keeps its own for the map it runs.
$.savedLocationsOf = function(mapId) {
    var out = {}, saved = $gameSystem && $gameSystem._savedEventLocations;
    if (!saved || !mapId) return out;
    // (not the spawned bodies and Rher forms: their ids are this world's)
    var spawned = {};
    $.rherList().concat($.corpses ? $.corpses() : []).forEach(function(r) {
        if (r && r.m === mapId) spawned[r.id] = true;
    });
    // (nor GALV's spawned bodies: an id past the map's events, its own on
    // each PC - only the map's own events still standing here, review 2026-11-03)
    var here = $gameMap && $gameMap.mapId() === mapId ? $gameMap._events : null;
    var pre = mapId + ',';
    Object.keys(saved).forEach(function(k) {
        var v = saved[k], id = Number(k.slice(pre.length));
        if (k.indexOf(pre) !== 0 || spawned[id] || !Array.isArray(v)) return;
        if (here && (!here[id] || here[id].isSpawnEvent)) return;
        out[k] = [v[0], v[1], v[2]];
    });
    return out;
};

$.markSavedLocations = function(mapId) {
    if (!$.trackingWorld()) return;
    var spots = $.savedLocationsOf(mapId);
    Object.keys(spots).forEach(function(k) { $.markWorld('el', k, spots[k]); });
};

// From another PC: false when not taken.
$.takeSavedLocation = function(key, value) {
    var parts = String(key).split(','), mapId = Number(parts[0]), id = Number(parts[1]);
    if (!$gameSystem || !mapId || !id || !Array.isArray(value)) return false;
    if ($gameMap && mapId === $gameMap.mapId() && ($.isHost() || $.isRoaming())) return false;
    var saved = $gameSystem._savedEventLocations || ($gameSystem._savedEventLocations = {});
    saved[key] = [Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 2];
    return true;
};

var _performTransferSaved = Game_Player.prototype.performTransfer;
Game_Player.prototype.performTransfer = function() {
    if (this.isTransferring() && $gameMap && this._newMapId !== $gameMap.mapId() && ($.isHost() || $.isRoaming())) {
        $.markSavedLocations($gameMap.mapId());
    }
    _performTransferSaved.call(this);
};

var _sendUnroamSaved = $.sendUnroam;
$.sendUnroam = function(spot, interpJson) {
    if ($gameMap) $.markSavedLocations($gameMap.mapId()); // (flushed first thing)
    return _sendUnroamSaved(spot, interpJson);
};

//=============================================================================
// Decrepit Priest's coin toss: held, freed, or the cross
//=============================================================================
// The original (troops 14 Oscar, 78 the church's, 142 the orphanage's, page
// 13): a lost toss sets V2695 priest_trigger and V2459 priest_scene and
// aborts the fight; the map's autorun page on V2459 (Map009/020/081/108)
// takes the legs (CE545), turns SW3264 on and moves the player to the cross
// (Map016), where EV354 (parallel on SW3264) lets days go by (CE303) and ends
// in a game over (day 3 evening, the second time, August gone) or August
// takes the player down. In co-op (user decisions 2026-11-03):
// - it is the loser's: its screen and character; nobody else's days go by
//   (the cross's page runs without CE303) and SW3264 is that PC's only;
// - another player free on that map (the host's world): the loser lies held,
//   a down nobody revives; the priest killed in a fight frees it as it was at
//   the toss; nobody free left on that map: its scene plays. Each its own;
// - a game over on the cross is a death.
$.PRIEST_TROOPS = { 14: true, 78: true, 142: true };
$.PRIEST_TRIGGER_VAR = 2695;
$.PRIEST_SCENE_VAR = 2459;
$.PRIEST_CROSS_SWITCH = 3264;
$.PRIEST_CROSS_MAP = 16;
$.DAYS_GO_BY_CE = 303;
$.PRIEST_CROSS_CMD = 'FHCoopPriestCross';
$.PRIEST_HOLD_TEXT = 'is held by the priest! Kill the priest to free them.';
$.PRIEST_FREE_TEXT = 'is free: the priest is dead.';
$.PRIEST_REVIVE_TEXT = 'Co-op: only killing the priest frees them.';
$.DOOM_TEXT.priest = 'died on the cross';
$.priestLost = null;  // the toss just lost in this PC's fight: { actorId, map, ev, was }
$.priestHolds = {};   // host: player id -> { actorId, map, ev, was }
$.priestQueue = [];   // players whose scene starts here when they can
$.priestSceneMap = 0; // a roaming guest: its scene, when on this map
$.priestCross = null; // this PC's player on the cross: { list, ev }

// Who it is on this PC's world: 'host', a thin guest here, 'self' (a roaming
// guest's own), or null (another PC's: the original goes on).
$.priestPlayerOf = function(actor) {
    if (!actor || !$.runsOwnMap()) return null;
    if (!$.isHost()) {
        if (actor === $.ownActor()) return 'self';
        // a sub-host: its guest on its map, as the host's thin guest (isHost audit
        // 2026-11-10: the toss lost by a sub-host's guest ran the original page in the
        // sub-host's world); its scene runs as that guest's here (priestStartScenes)
        if (!$.subHosting()) return null;
        var sub = $.clients.filter(function(c) { return c._sub && c.actorId === actor.actorId(); })[0];
        return sub && $.guestOnMap(sub) ? sub.guestId : null;
    }
    var id = $.playerOfActor(actor.actorId());
    if (id === 'host') return id;
    var conn = id ? $.clientById(id) : null;
    return conn && !conn.roam && $.guestOnMap(conn) ? id : null;
};

$.priestWas = function(actor) {
    return { hp: actor.hp, mp: actor.mp, tp: actor.tp, states: actor._states.slice(),
        turns: JSON.parse(JSON.stringify(actor._stateTurns || {})) };
};

$.isPriestVar = function(p) {
    return [$.PRIEST_TRIGGER_VAR, $.PRIEST_SCENE_VAR].some(function(id) { return p[0] <= id && p[1] >= id; });
};

var _command122Priest = Game_Interpreter.prototype.command122;
Game_Interpreter.prototype.command122 = function() {
    if (this === $gameTroop._interpreter && this._fhToss && $.coopBattleHere() &&
            $.PRIEST_TROOPS[$gameTroop._troopId] && $.isPriestVar(this._params)) {
        if (!$.priestLost) {
            var loser = $.tossLoser().actor;
            if (!$.doomCounts(loser) || !$.priestPlayerOf(loser)) return _command122Priest.call(this);
            var b = $.authBattle && $.battles[$.authBattle.bid];
            $.priestLost = { actorId: loser.actorId(), map: $gameMap.mapId(), ev: b ? b.eventId : 0, was: $.priestWas(loser) };
            $.dlog('priest: the toss lost by', loser.name());
        }
        return true; // (not the world's: the scene is the loser's)
    }
    return _command122Priest.call(this);
};

// Host: the players on that map who could free one held there.
$.priestOthersHere = function(id, mapId) {
    var ids = ['host'].concat($.activeGuests().map(function(c) { return c.guestId; }));
    return ids.filter(function(other) {
        return other !== id && !$.isDown(other) && $.playerMapOfRest(other) === mapId;
    });
};

$.priestAfterFight = function() {
    var lost = $.priestLost;
    $.priestLost = null;
    var id = $gameMap.mapId() === lost.map ? $.priestPlayerOf($gameActors.actor(lost.actorId)) : null;
    if (!id) return;
    if ($.isHost() && $.priestOthersHere(id, lost.map).length) $.priestHold(id, lost);
    else $.priestQueue.push(id);
};

$.priestHold = function(id, lost) {
    var actor = $gameActors.actor(lost.actorId);
    $.priestHolds[id] = { actorId: lost.actorId, map: lost.map, ev: lost.ev, was: lost.was, sent: $.clockMs() };
    if (!actor.isDead()) actor.addState($.KNOCKOUT);
    $.downs[id] = { end: $.clockMs() + $.downMs, held: true };
    $.dlog('priest: holds', $.playerLabel(id));
    $.broadcastState(id);
    $.broadcastToast($.playerLabel(id) + ' ' + $.PRIEST_HOLD_TEXT);
};

// Back as it was at the toss (freed), or standing for its scene.
$.priestLetGo = function(id, freed) {
    var h = $.priestHolds[id];
    delete $.priestHolds[id];
    delete $.downs[id];
    var actor = h && $gameActors.actor(h.actorId);
    if (actor) {
        actor.removeState($.KNOCKOUT);
        actor._states = h.was.states.slice();
        actor._stateTurns = JSON.parse(JSON.stringify(h.was.turns));
        actor.setHp(Math.max(1, h.was.hp));
        actor.setMp(h.was.mp);
        actor.setTp(h.was.tp);
        actor.refresh();
    }
    $.dlog('priest: lets go of', $.playerLabel(id), freed ? '(freed)' : '(its scene)');
    $.broadcastState(id);
    if (freed) $.broadcastToast($.playerLabel(id) + ' ' + $.PRIEST_FREE_TEXT);
    if (id !== 'host') $.pushMe($.clientById(id));
    else $gamePlayer.refresh();
};

// A fight with a priest won on that map: everyone it held there is free.
$.priestKilled = function(mapId) {
    Object.keys($.priestHolds).forEach(function(id) {
        if ($.priestHolds[id].map === mapId) $.priestLetGo(id, true);
    });
};

var _finishHostBattlePriest = $.finishHostBattle;
$.finishHostBattle = function(result) {
    var b = Object.keys($.battles).map(function(k) { return $.battles[k]; }).filter(function(x) {
        return x.owner === 'host' && !x.pvp;
    })[0];
    _finishHostBattlePriest(result);
    if (result === 0 && b && $.PRIEST_TROOPS[b.troopId]) $.priestKilled(b.mapId);
};

var _roamFightEndPriest = $.hostHandlers.roamFightEnd;
$.hostHandlers.roamFightEnd = function(conn, msg) {
    var b = $.battles[msg.bid];
    _roamFightEndPriest(conn, msg);
    if (msg.result === 0 && b && b.owner === conn.guestId && $.PRIEST_TROOPS[b.troopId]) $.priestKilled(b.mapId);
};

var _revivePriest = $.revive;
$.revive = function(id, byId) {
    if ($.priestHolds[id]) {
        if (byId === 'host') $.toast($.PRIEST_REVIVE_TEXT);
        else $.sendTo(byId, { t: 'toast', text: $.PRIEST_REVIVE_TEXT });
        return;
    }
    return _revivePriest(id, byId);
};

// Host: the held ones stay down (no timer runs out on them) until the
// priest dies or nobody free is left on their map.
$.priestTick = function() {
    var now = $.clockMs();
    Object.keys($.priestHolds).forEach(function(id) {
        var h = $.priestHolds[id];
        if (!$.downs[id] || $.isDead(id) || (id !== 'host' && !$.clientById(id))) {
            delete $.priestHolds[id];
            return;
        }
        $.downs[id].end = now + $.downMs;
        if (now - h.sent > 60000) {
            h.sent = now;
            $.broadcastState(id);
        }
        if (!$.priestOthersHere(id, h.map).length) {
            $.priestLetGo(id, false);
            $.priestQueue.push(id);
        }
    });
};

// The map's page that takes the legs (V2459), as the loser's: SW3264 is not
// the world's (the cross below is this player's), the cross after the move.
$.priestLegsOf = function() {
    var found = null;
    $gameMap.events().some(function(ev) {
        return ev.event().pages.some(function(pg) {
            var c = pg.conditions;
            if (pg.trigger !== 3 || !c.variableValid || c.variableId !== $.PRIEST_SCENE_VAR ||
                    !pg.list.some(function(cmd) { return cmd.code === 201; })) return false;
            var list = [];
            pg.list.forEach(function(cmd) {
                var p = cmd.parameters;
                if (cmd.code === 121 && p[0] <= $.PRIEST_CROSS_SWITCH && p[1] >= $.PRIEST_CROSS_SWITCH) return;
                list.push(cmd);
                if (cmd.code === 201) list.push({ code: 356, indent: cmd.indent, parameters: [$.PRIEST_CROSS_CMD] });
            });
            found = { ev: ev, list: list };
            return true;
        });
    });
    return found;
};

// One whose scene waits: when it (its PC, its interpreter) is free.
$.priestStartScenes = function() {
    $.priestQueue = $.priestQueue.filter(function(id) {
        if (id === 'host' || id === 'self') {
            if ($gameMap.isEventRunning()) return true;
            var mine = $.priestLegsOf();
            if (mine) $gameMap._interpreter.setup(mine.list, mine.ev.eventId());
            $.dlog('priest: the scene of this PC\'s player', mine ? 'ev' + mine.ev.eventId() : '(none on this map)');
            return false;
        }
        var conn = $.clientById(id);
        if (!conn) return false;
        if (conn.roam || conn.roamPending) {
            var h = conn.lastPos && conn.lastPos.m;
            conn.send({ t: 'priestScene', map: h || 0 });
            return false;
        }
        if (!$.guestOnMap(conn)) return true; // (on its way here: the host runs it once it is)
        if ($.owned[id] || $.isBusy(conn)) return true;
        var legs = $.priestLegsOf();
        if (legs) $.runOwned(conn, legs.list, legs.ev);
        $.dlog('priest: the scene of', conn.name, legs ? 'ev' + legs.ev.eventId() : '(none on this map)');
        return false;
    });
};

$.guestHandlers.priestScene = function(msg) {
    $.priestSceneMap = Number(msg.map) || ($gameMap ? $gameMap.mapId() : 0);
};

var _pluginCommandPriest = Game_Interpreter.prototype.pluginCommand;
Game_Interpreter.prototype.pluginCommand = function(command, args) {
    if (command !== $.PRIEST_CROSS_CMD) return _pluginCommandPriest.call(this, command, args);
    var owner = this._fhOwner && $.runsWorld() ? $.clientById(this._fhOwner) : null;
    if (owner) owner.send({ t: 'priestCross' });
    else $.priestCross = { list: null };
};

$.guestHandlers.priestCross = function() {
    $.priestCross = { list: null };
};

// The cross's page (Map016 EV354: parallel on SW3264, days go by in it).
$.priestCrossPage = function() {
    var found = null;
    $gameMap.events().some(function(ev) {
        return ev.event().pages.some(function(pg) {
            var c = pg.conditions;
            if (pg.trigger !== 4 || !((c.switch1Valid && c.switch1Id === $.PRIEST_CROSS_SWITCH) ||
                    (c.switch2Valid && c.switch2Id === $.PRIEST_CROSS_SWITCH))) return false;
            found = { ev: ev, page: pg };
            return true;
        });
    });
    return found;
};

$.priestCrossTick = function() {
    var pc = $.priestCross;
    if (!pc.list) {
        if ($gameMap.mapId() !== $.PRIEST_CROSS_MAP || $gamePlayer.isTransferring() || $gameMap.isEventRunning()) return;
        var cross = $.priestCrossPage();
        if (!cross) {
            $.priestCross = null;
            return;
        }
        pc.page = cross.page;
        pc.list = cross.page.list.filter(function(cmd) {
            return !(cmd.code === 117 && cmd.parameters[0] === $.DAYS_GO_BY_CE);
        });
        $gameSwitches._data[$.PRIEST_CROSS_SWITCH] = true; // (its sprite on the cross: this PC's)
        $gameMap.requestRefresh();
        pc.ev = cross.ev.eventId();
        $gameMap._interpreter.setup(pc.list, pc.ev);
        $.dlog('priest: on the cross (no days go by)');
        return;
    }
    if ($.isPriestCrossRun($gameMap._interpreter)) return;
    $gameSwitches._data[$.PRIEST_CROSS_SWITCH] = false;
    $gameMap.requestRefresh();
    $.priestCross = null;
};

// Its own copy runs: the page itself does not (days would go by).
var _updateParallelPriest = Game_Event.prototype.updateParallel;
Game_Event.prototype.updateParallel = function() {
    if ($.priestCross && $.priestCross.page && this.page() === $.priestCross.page) return;
    _updateParallelPriest.call(this);
};

// This PC's run of the cross (its list may come back a copy: a transfer, a
// snapshot): its event, its length.
$.isPriestCrossRun = function(interp) {
    var pc = $.priestCross;
    return !!pc && !!pc.list && !!interp && interp.isRunning() && interp._eventId === pc.ev &&
        !!interp._list && interp._list.length === pc.list.length;
};

// Its game over on the cross: a death.
var _command117Priest = Game_Interpreter.prototype.command117;
Game_Interpreter.prototype.command117 = function() {
    if ($.isPriestCrossRun(this) && $.GAME_OVER_CES[this._params[0]]) {
        $.markDoom($.ownActor(), 'priest');
    }
    return _command117Priest.call(this);
};
$.GAME_OVER_CES = { 47: true, 359: true };

var _sceneMapUpdatePriest = Scene_Map.prototype.update;
Scene_Map.prototype.update = function() {
    _sceneMapUpdatePriest.call(this);
    if (!$.role || $gameParty.inBattle() || SceneManager.isSceneChanging()) return;
    if ($.priestLost) $.priestAfterFight();
    if ($.isHost()) $.priestTick();
    if ($.priestSceneMap && $gameMap.mapId() === $.priestSceneMap && $.runsOwnMap()) {
        $.priestSceneMap = 0;
        $.priestQueue.push('self');
    }
    if ($.priestQueue.length) $.priestStartScenes();
    if ($.priestCross) $.priestCrossTick();
};

//=============================================================================
// God affinity in co-op (user request 2026-11-04)
//=============================================================================
// Original (data): the affinities (V261 the God of Fear and Hunger, V262
// Alll-mer, V263 Rher, V264 Sylvian, V265 Vinushka, V266 Gro-goroth: each
// player's own, the Hexen board's) open the god nodes at 1-3. They grow at
// the five ritual circles of the new gods (Map005 EV146, Map020 EV316,
// Map051 EV389, Map114 EV33, Map164 EV107 / EV118): drawing a sigil +1 (one
// sigil a circle, for good: the world's), then at a Gro-goroth sigil a
// party member sacrificed (CE529, once a circle) and at a Sylvian sigil the
// skill Masturbation (CE528, once a circle; the Hexen node Map031 EV181
// wants Blood sacrifice, Samarie's soul and a soul stone). The six blood
// portal circles (Map014 EV164, Map021 EV154, Map051 EV349, Map054 EV45,
// Map105 EV39, Map174 EV26) give Alll-mer or Fear and Hunger +1 for their
// sigil, the church's confessional (Map044 EV262) Alll-mer +1 once. A
// one-player game has all the circles; players in co-op share them.
// Co-op (user decisions 2026-11-04):
// - Gro-goroth: at a Gro-goroth sigil each player can once offer four arms
//   or legs (food items 141 / 142, any mix) for +1 - a grey screen hints at
//   it (F&H1 raised it by eating people). The sacrifice (a ghoul too) stays.
// - Sylvian: Masturbation is everyone's once any player holds Samarie's
//   soul: at a Sylvian sigil each player can use it once a circle (its first
//   time asks a soul stone, what the node cost). The Hexen node teaches it no
//   more.
// - Samarie's soul (otherwise of no use) gives the one who gets it +1 with
//   every god (all six: the wiki's god affinity skills).
// - Vinushka, Rher, Alll-mer, Fear and Hunger: as in the original.

$.GOD_AFFINITIES = [261, 262, 263, 264, 265, 266];
$.ARM_ITEM = 141;
$.LEG_ITEM = 142;
$.LIMBS_FOR_GROGOROTH = 4;
$.SOUL_STONE_ITEM = 116;
$.SAMARIE_SOUL = 734;
$.MASTURBATION_NODE_SWITCH = 1998;
$.SYLVIAN_CIRCLE_CE = 528;
$.GROGOROTH_CIRCLE_CE = 529;
$.SYLVIAN_CIRCLE_VAR0 = 2082; // V2082-2086: each circle's "used" (abandoned house ... school)
// each player's own (unused by the game data), kept with its Hexen board
$.LIMBS_GIVEN_SWITCH = 4809;  // it offered its four limbs
$.SYLVIAN_PAID_SWITCH = 4810; // it gave the soul stone
$.SYLVIAN_USED_VAR = 2895;    // the Sylvian circles it used (a bit a circle)
$.HEXEN_SWITCHES.push($.LIMBS_GIVEN_SWITCH, $.SYLVIAN_PAID_SWITCH);
$.HEXEN_VARS.push($.SYLVIAN_USED_VAR);
[$.LIMBS_GIVEN_SWITCH, $.SYLVIAN_PAID_SWITCH].forEach(function(id) { $.HEXEN_SW[id] = true; $.NO_SYNC_SWITCHES[id] = true; });
$.HEXEN_V[$.SYLVIAN_USED_VAR] = true;

$.GOD_TEXT = {
    grogoroth: 'There is a sigil of Gro-goroth drawn here.',
    offer: 'Offer four arms and legs',
    other: 'Something else',
    short: 'Gro-goroth wants four arms or legs.',
    accepts: 'Gro-goroth takes the flesh...',
    grown: 'Your affinity with the Gro-goroth has increased.',
    masturbation: 'You could use the skill \\c[2]Masturbation\\c[0] here...',
    use: 'Use \\c[2]Masturbation\\c[0]',
    leave: 'Leave',
    stone: 'The Sylvian asks for a \\c[2]Soul stone\\c[0] the first time.',
    paid: 'You give a \\c[2]Soul stone\\c[0] to the Sylvian.',
    exhausted: 'The ritual circle has been exhausted.',
    node: 'Co-op: Masturbation is not learned here. Once any player holds Samarie\'s soul, everyone can use it at a Sylvian sigil.',
    samarie: 'Co-op: Samarie\'s soul - your affinity with every god has increased.'
};

// ---- event command helpers

$.godCmd = function(code, indent, params) {
    return { code: code, indent: indent, parameters: params || [] };
};

$.godText = function(indent, text) {
    return [$.godCmd(101, indent, ['', 0, 0, 2]), $.godCmd(401, indent, [text])];
};

$.godListCalls = function(list, ce) {
    return (list || []).some(function(c) { return c.code === 117 && c.parameters[0] === ce; });
};

// ---- the values these pages read (in the player's own world: its board, its bag)

$.limbCount = function() {
    return $gameParty.numItems($dataItems[$.ARM_ITEM]) + $gameParty.numItems($dataItems[$.LEG_ITEM]);
};

$.limbOfferOpen = function() {
    return !$gameSwitches.value($.LIMBS_GIVEN_SWITCH);
};

$.limbOfferTake = function() {
    var left = $.LIMBS_FOR_GROGOROTH;
    [$.ARM_ITEM, $.LEG_ITEM].forEach(function(id) {
        var take = Math.min(left, $gameParty.numItems($dataItems[id]));
        if (take > 0) $gameParty.loseItem($dataItems[id], take);
        left -= take;
    });
    $gameSwitches.setValue($.LIMBS_GIVEN_SWITCH, true);
    $.dlog('Gro-goroth: four limbs offered (+1)');
};

$.masturbationOpen = function() {
    return !!$.soulOwnerMap()[$.SAMARIE_SOUL];
};

$.sylvianBit = function(circleVar) {
    var bit = circleVar - $.SYLVIAN_CIRCLE_VAR0;
    return bit >= 0 && bit < 30 ? 1 << bit : 0;
};

$.sylvianFresh = function(circleVar) {
    return !($gameVariables.value($.SYLVIAN_USED_VAR) & $.sylvianBit(circleVar));
};

$.sylvianUsed = function(circleVar) {
    $gameVariables.setValue($.SYLVIAN_USED_VAR, $gameVariables.value($.SYLVIAN_USED_VAR) | $.sylvianBit(circleVar));
};

// ---- the pages

// At a Gro-goroth sigil: the offering first (once), then the original page.
$.grogorothCoopList = function(list) {
    var t = $.GOD_TEXT, c = $.godCmd;
    var head = [c(111, 0, [12, 'FH.Coop.limbOfferOpen()'])]
        .concat($.godText(1, t.grogoroth), [
            c(102, 1, [[t.offer, t.other], 1, 0, 2, 0]),
            c(402, 1, [0, t.offer]),
            c(111, 2, [12, 'FH.Coop.limbCount() >= FH.Coop.LIMBS_FOR_GROGOROTH']),
            c(121, 3, [202, 202, 0]), c(121, 3, [410, 410, 0]),
            c(223, 3, [[0, 0, 0, 255], 60, true]),
            c(250, 3, [{ name: 'terror_attack_01', volume: 90, pitch: 80, pan: 0 }]),
            c(230, 3, [80])
        ], $.godText(3, t.accepts), [
            c(355, 3, ['FH.Coop.limbOfferTake();']),
            c(122, 3, [266, 266, 1, 0, 1]),
            c(250, 3, [{ name: 'mystic1488327__robinhood76__08013-mystic-spill_01', volume: 90, pitch: 50, pan: 0 }])
        ], $.godText(3, t.grown), [
            c(223, 3, [[0, 0, 0, 0], 60, true]),
            c(121, 3, [202, 202, 1]), c(121, 3, [410, 410, 1]),
            c(115, 3), c(0, 3),
            c(411, 2)
        ], $.godText(3, t.short), [
            c(115, 3), c(0, 3),
            c(412, 2), c(0, 2),
            c(402, 1, [1, t.other]), c(0, 2),
            c(404, 1), c(0, 1),
            c(412, 0)
        ]);
    return head.concat(list);
};

// At a Sylvian sigil: Masturbation for everyone once Samarie's soul is
// someone's, once a circle for each player, a soul stone the first time.
$.sylvianCoopList = function(list) {
    var first = (list || []).filter(function(cmd) { return cmd.code === 111 && cmd.parameters[0] === 1; })[0];
    var circleVar = first ? first.parameters[1] : 0;
    if (!$.sylvianBit(circleVar)) return null;
    var t = $.GOD_TEXT, c = $.godCmd;
    var use = function(indent) {
        return [c(117, indent, [$.SYLVIAN_CIRCLE_CE]), c(355, indent, ['FH.Coop.sylvianUsed(' + circleVar + ');'])];
    };
    return [c(111, 0, [12, 'FH.Coop.sylvianFresh(' + circleVar + ')']),
        c(111, 1, [12, 'FH.Coop.masturbationOpen()'])]
        .concat($.godText(2, t.masturbation), [
            c(102, 2, [[t.use, t.leave], 1, 0, 2, 0]),
            c(402, 2, [0, t.use]),
            c(111, 3, [0, $.SYLVIAN_PAID_SWITCH, 0])
        ], use(4), [
            c(0, 4),
            c(411, 3),
            c(111, 4, [8, $.SOUL_STONE_ITEM])
        ], $.godText(5, t.paid), [
            c(126, 5, [$.SOUL_STONE_ITEM, 1, 0, 1]),
            c(121, 5, [$.SYLVIAN_PAID_SWITCH, $.SYLVIAN_PAID_SWITCH, 0])
        ], use(5), [
            c(0, 5),
            c(411, 4)
        ], $.godText(5, t.stone), [
            c(0, 5),
            c(412, 4), c(0, 4),
            c(412, 3), c(0, 3),
            c(402, 2, [1, t.leave]), c(0, 3),
            c(404, 2), c(0, 2),
            c(412, 1), c(0, 1),
            c(411, 0)
        ], $.godText(1, t.exhausted), [
            c(0, 1),
            c(412, 0), c(0, 0)
        ]);
};

// The Hexen board's Masturbation node: not learned there in co-op.
$.isMasturbationNode = function(list) {
    return !!$gameMap && $gameMap.mapId() === $.HEXEN_MAP && (list || []).some(function(cmd) {
        var p = cmd.parameters;
        return cmd.code === 121 && p[2] === 0 && p[0] <= $.MASTURBATION_NODE_SWITCH && p[1] >= $.MASTURBATION_NODE_SWITCH;
    });
};

// (kept beside the lists, nothing written on them: a list with extra keys
// was no longer the same as its common event's - a snapshot sent it whole,
// not by id, and compared it every time; Snapshot review 5 L1)
$.godLists = new WeakMap(); // list -> { key: map id, out: its co-op list or null }
$.godMade = new WeakSet();  // the co-op lists made (never made over again)

$.coopGodList = function(list) {
    if (!$.role || !list || !list.length || $.godMade.has(list) || !$.sessionActive()) return list;
    var key = $gameMap ? $gameMap.mapId() : 0;
    var known = $.godLists.get(list);
    if (known && known.key === key) return known.out || list;
    var out = null;
    if ($.isMasturbationNode(list)) {
        out = $.godText(0, $.GOD_TEXT.node).concat([$.godCmd(0, 0)]);
    } else if ($.godListCalls(list, $.GROGOROTH_CIRCLE_CE)) {
        out = $.grogorothCoopList(list);
    } else if ($.godListCalls(list, $.SYLVIAN_CIRCLE_CE)) {
        out = $.sylvianCoopList(list);
    }
    $.godLists.set(list, { key: key, out: out });
    if (out) $.godMade.add(out);
    return out || list;
};

var _interpreterSetupGods = Game_Interpreter.prototype.setup;
Game_Interpreter.prototype.setup = function(list, eventId) {
    _interpreterSetupGods.call(this, $.coopGodList(list), eventId);
};

// ---- Samarie's soul: +1 with every god for the one who gets it

$.addAffinity = function(id, n) {
    var add = function(v) { $.GOD_AFFINITIES.forEach(function(k) { v[k] = (Number(v[k]) || 0) + n; }); };
    var addWorld = function() {
        $.GOD_AFFINITIES.forEach(function(k) { $gameVariables.setValue(k, $gameVariables.value(k) + n); });
    };
    if (id === 'host') {
        if ($.hxCtx) add($.hxCtx.own.v = $.hxCtx.own.v || {}); else addWorld();
        $.toast($.GOD_TEXT.samarie);
        return;
    }
    var c = $.clientById(id);
    if (!c) return;
    if (c.roam) {
        c.send({ t: 'affinityAdd', n: n }); // its board is on its PC
        return;
    }
    if (c.subOf) {
        var owner = $.clientById(c.subOf);
        if (owner) owner.send({ t: 'affinityAddSub', id: id, n: n });
        return;
    }
    if ($.hxCtx && $.hxCtx.conn === c) {
        addWorld();
    } else {
        var b = $.boardOf(c);
        b.v = b.v || {};
        add(b.v);
        $.setBoard(c, b);
    }
    c.send({ t: 'toast', text: $.GOD_TEXT.samarie });
};

$.guestHandlers.affinityAdd = function(msg) {
    if (!msg || !$.isRoaming()) return;
    $.GOD_AFFINITIES.forEach(function(k) { $gameVariables.setValue(k, $gameVariables.value(k) + (Number(msg.n) || 0)); });
    if ($.sendHxMe) $.sendHxMe(true);
    $.toast($.GOD_TEXT.samarie);
};

$.guestHandlers.affinityAddSub = function(msg) {
    var c = msg && $.subHosting() ? $.clientById(msg.id) : null;
    if (!c || !c._sub) return;
    var n = Number(msg.n) || 0;
    if ($.hxCtx && $.hxCtx.conn === c) {
        $.GOD_AFFINITIES.forEach(function(k) { $gameVariables.setValue(k, $gameVariables.value(k) + n); });
    } else {
        var b = $.boardOf(c);
        b.v = b.v || {};
        $.GOD_AFFINITIES.forEach(function(k) { b.v[k] = (Number(b.v[k]) || 0) + n; });
        $.setBoard(c, b);
    }
    c.send({ t: 'toast', text: $.GOD_TEXT.samarie });
};

// host: once a game (kept in its save)
$.samarieBonus = function(id) {
    var data = $.coopData();
    if (data.samarieBonus || !id) return;
    data.samarieBonus = $.playerLabel(id);
    $.dlog('Samarie\'s soul:', $.playerLabel(id), 'gets +1 with every god');
    $.addAffinity(id, 1);
};

var _soulGainedSamarie = $.soulGained;
$.soulGained = function(id, causeId, mapId) {
    var owners = $.soulOwnerMap(), had = !!owners[id];
    _soulGainedSamarie(id, causeId, mapId);
    if (id !== $.SAMARIE_SOUL || had || !owners[id]) return;
    // no question (its board, nobody else to give it to): it is that player's now
    var others = $.soulTakers().filter(function(p) { return p.id !== causeId; });
    if (mapId === $.HEXEN_MAP || !others.length) $.samarieBonus(causeId);
};

var _soulGiveSamarie = $.soulGive;
$.soulGive = function(fromId, msg) {
    var owners = $.soulOwnerMap(), before = owners[$.SAMARIE_SOUL];
    var from = $.soulTakers().filter(function(p) { return p.id === fromId; })[0];
    _soulGiveSamarie(fromId, msg);
    if (!msg || msg.sw !== $.SAMARIE_SOUL || !from || before !== from.a) return;
    var to = msg.to ? $.soulTakers().filter(function(p) { return p.id === msg.to; })[0] : null;
    $.samarieBonus(to && to.id !== fromId ? to.id : fromId);
};

// Its question never answered (SOUL_WAIT_MS): the soul stayed with the one who
// took it (soulGained), and so does the bonus.
$.samarieTimeout = function() {
    var rec = $.soulWait[$.SAMARIE_SOUL];
    if (!rec || !rec.cause || rec.done !== undefined || $.clockMs() - rec.at < $.SOUL_WAIT_MS) return;
    var owner = $.soulOwnerMap()[$.SAMARIE_SOUL];
    rec.done = owner || 0;
    var p = $.soulTakers().filter(function(t) { return t.a === owner; })[0];
    $.dlog("Samarie's soul: its question went unanswered -", p ? $.playerLabel(p.id) + ' keeps it' : 'its taker is gone');
    if (p) $.samarieBonus(p.id);
};
$.worldExtras.push(function() {
    if ($.isHost() && Graphics.frameCount % 60 === 0) $.samarieTimeout();
});

//=============================================================================
// The church's confessional: each player's own confession (user 2026-11-04)
//=============================================================================
// Original (data): the booth door (Map044 EV268 / EV305: on it, facing up)
// turns SW3817 on and takes the player into Map109, whose autorun EV8 is the
// talk with the deep-voiced person (O'saa): what was confessed (SW3911 /
// 3913 / 3998 ...), absolved (SW3820), condemned (SW3997); the second visit
// ends it (SW3999 confessional_DONE). Then SW3819 on, back to Map044 (30,65),
// where the autorun EV262 (SW3819) gives Alll-mer +1 the first time (SW3821)
// and EV265 (SW3999) is O'saa's laugh, his reveal and his fight (SW4001-4004:
// the world's story). Nothing else in the data reads the talk's switches.
// Co-op: they were the world's: one player's confession set off the return
// pages for whoever ran Map044 (user report from before 0.5.11, flow A-1:
// the host got Anna's O'saa scene and her affinity, she never could go in
// again). They are each player's own now (with the Hexen board,
// $.PERSONAL_EXTRA_SW: saved, carried to its own map, back with it); the
// booth's look (SW3817 / 3818) and O'saa's story stay the world's. Alll-mer
// +1 comes once for each player (SW3821 its own). A guest on the host's map
// gets its return pages as its own event, like a bed's dream page.
// The booth (Map109) is whoever sits in it: its talk is that player's own,
// whoever wrote its conditions before. O'saa out (SW4001, his reveal on a
// guest's return) made the empty booth's page (EV8 p4, back to the church)
// a guest's move in the host's world: the host never ran it and sat in the
// booth for good (flow A-1: "autorun ev8 p4 moves the player and is not the
// host's: set by g1").
$.CONFESSIONAL_MAP = 109;
$.CONFESSION_SWITCHES = [3819, 3820, 3821, 3822, 3823, 3911, 3912, 3913, 3914, 3915, 3996, 3997, 3998, 3999, 4000];
$.CONFESSION_PAGE_SW = { 3819: true, 3999: true }; // the return pages' conditions
$.CONFESSION_EVERY = 10;
$.CONFESSION_SWITCHES.forEach(function(id) {
    $.PERSONAL_EXTRA_SW[id] = true;
    $.HEXEN_SWITCHES.push(id);
    $.HEXEN_SW[id] = true;
    $.NO_SYNC_SWITCHES[id] = true;
});

// Its return page here (with its own values in the world).
$.confessionPageOf = function(conn) {
    return $.inContext(conn, function() {
        var found = null;
        var on = function(valid, id) { return valid && $.CONFESSION_PAGE_SW[id] && $gameSwitches.value(id); };
        $gameMap.events().some(function(ev) {
            if (!ev || ev._erased || ev._fhOwner) return false;
            var index = ev.findProperPageIndex();
            var page = index >= 0 ? ev.event().pages[index] : null;
            if (!page || page.trigger !== 3 || !page.list || page.list.length <= 1) return false;
            var c = page.conditions;
            if (!on(c.switch1Valid, c.switch1Id) && !on(c.switch2Valid, c.switch2Id)) return false;
            found = { ev: ev, page: page };
            return true;
        });
        return found;
    });
};

$.worldExtras.push(function() {
    if (!$.runsWorld() || !$gameMap || !$.worldReady() || Graphics.frameCount % $.CONFESSION_EVERY !== 3) return;
    $.clients.forEach(function(conn) {
        if (!conn.actorId || conn.solo || !$.guestOnMap(conn) || $.isBusy(conn) || $.isDown(conn.guestId)) return;
        var s = ($.boardOf(conn) || {}).s || {};
        if (!Object.keys($.CONFESSION_PAGE_SW).some(function(id) { return s[id]; })) return;
        var found = $.confessionPageOf(conn);
        if (!found) return;
        $.dlog('confessional: ev' + found.ev.eventId(), 'runs for', conn.name, '(its own confession)');
        $.runOwned(conn, found.page.list, found.ev);
    });
});

// O'saa out (another player's talk revealed him, SW4001): the empty booth
// (EV8 p4) turns SW3820 sins_absolved off - the original gives nothing then.
// Each player's +1 once (user 2026-11-04): one who never had it (its own
// SW3821 off) leaves the empty booth absolved, EV262 gives it then.
$.OSAA_OUT_SWITCH = 4001;
$.SINS_ABSOLVED_SWITCH = 3820;
$.FIRST_CONFESSION_SWITCH = 3821;
$.BOOTH_RETURN_SWITCH = 3819;
var _command121Booth = Game_Interpreter.prototype.command121;
Game_Interpreter.prototype.command121 = function() {
    var p = this._params;
    var result = _command121Booth.call(this);
    if ($.role && $.sessionActive() && $gameMap && $gameMap.mapId() === $.CONFESSIONAL_MAP && p[2] === 0 &&
            p[0] <= $.BOOTH_RETURN_SWITCH && p[1] >= $.BOOTH_RETURN_SWITCH && $gameSwitches.value($.OSAA_OUT_SWITCH) &&
            !$gameSwitches.value($.FIRST_CONFESSION_SWITCH)) {
        $gameSwitches.setValue($.SINS_ABSOLVED_SWITCH, true);
        $.dlog('confessional: O\'saa is out - its first confession absolves it (Alll-mer +1 once)');
    }
    return result;
};

// The church's rafters (user decision 2026-11-04): the ceiling area a player
// climbed into (SW2983-2989 CeilingAREA1-7, set by the ladders and the
// rafters' area edges on Map037 / 044 / 046 / 047) picks where its fall
// lands (Map046 / 047 fall tiles, Map044 EV251). The world's: two players on
// different ladders fell at the later one's spot. Each player's own now (with
// the Hexen board); nothing else reads them.
$.CEILING_AREA_SWITCHES = [2983, 2984, 2985, 2986, 2987, 2988, 2989];
$.CEILING_AREA_SWITCHES.forEach(function(id) {
    $.PERSONAL_EXTRA_SW[id] = true;
    $.HEXEN_SWITCHES.push(id);
    $.HEXEN_SW[id] = true;
    $.NO_SYNC_SWITCHES[id] = true;
});

var _gameEventStartBooth = Game_Event.prototype.start;
Game_Event.prototype.start = function() {
    if ($.role && $.causes && $.runsWorld() && $gameMap && $gameMap.mapId() === $.CONFESSIONAL_MAP &&
            this._trigger === 3 && !this._fhOwner && $.pageCauseKeys) {
        $.pageCauseKeys(this).forEach(function(k) { delete $.causes[k]; });
    }
    _gameEventStartBooth.call(this);
};

//=============================================================================
// MINIMAP - Termina (Nexus mod 295, TM_Minimap.js): co-op support
//=============================================================================
// User request 2026-11-04. Only when that mod is installed: it loads through
// its own TM_ModLoader after these plugins, so it is checked at run time and
// its window is patched once it exists. Its files are not changed.
// (1) Our HUD (fhcoop-hud) sat in its corner (top right) over its map: below
//     its canvas while that shows.
// (2) Explored places are the world's save data ($gameSystem._fhMapSeen:
//     map id -> bits): a guest's went with every snapshot of the host. Each
//     player's newly explored places go to the host every MM_SYNC_FRAMES; the
//     host merges them (a bitwise or) and sends them on: one shared map, in
//     the host's save. A guest keeps its own through a new world from the
//     host (the same playthrough).
// (3) The other players on this map: dots of their own colour.

$.MM_SYNC_FRAMES = 90;
$.MM_PLAYER_COLOR = '#5bc0eb';
$.MM_HUD_GAP = 6;
$.mmSent = {}; // map id -> its bits as last sent or taken (what changed since)

$.minimapOn = function() {
    return !!(window.Imported && Imported.TM_Minimap && window.FH && FH.Minimap && FH.Minimap.seen);
};

// ---- (6) in the game image (a test build, user 2026-11-04: "it stutters a
// little"). Its own setting Screen Corner false: its window is a game window
// in the image's top right instead of a second canvas over the game's. A bit
// smaller there (160 instead of 200: about a fifth of the image's width, a
// quarter of its height, user "분모 +1"). Only when the release main.js says
// so (FH_COOP_MINIMAP_IN_GAME): the plugins are the same in both builds (one
// hash), so the two can play together. Its loader (TM_ModLoader) sets its
// settings before it loads, after these plugins: changed there.
$.MM_IN_GAME_SIZE = 160;

$.mmInGame = function() {
    return typeof FH_COOP_MINIMAP_IN_GAME !== 'undefined' && !!FH_COOP_MINIMAP_IN_GAME;
};

$.mmInGameParams = function() {
    var p = $.mmInGame() && PluginManager._parameters && PluginManager._parameters.tm_minimap;
    if (!p) return;
    p['Screen Corner'] = 'false';
    p['Size'] = String($.MM_IN_GAME_SIZE);
};

var _setParametersMinimap = PluginManager.setParameters;
PluginManager.setParameters = function(name, parameters) {
    _setParametersMinimap.apply(this, arguments);
    if (String(name).toLowerCase() === 'tm_minimap') $.mmInGameParams();
};
$.mmInGameParams(); // (already set: its loader ran before these plugins)

// ---- (1) the HUD below its canvas (or its window in the game image)

$.MM_HUD_FRAMES = 15; // (its place: not a layout read at every frame)
$.mmPlaceHud = function() {
    var el = document.getElementById('fhcoop-hud');
    if (!el) return;
    var cv = $.minimapOn() ? FH.Minimap.screen : null;
    var top = $.MM_HUD_GAP;
    var win = $.minimapOn() && !FH.Minimap.inCorner && SceneManager._scene && SceneManager._scene._fhMinimap;
    if (win && win.visible && el.style.display !== 'none' && Graphics._canvas) {
        var rect = Graphics._canvas.getBoundingClientRect(), scale = rect.height ? rect.height / Graphics.height : 1;
        top = Math.round(rect.top + (win.y + win.height) * scale) + $.MM_HUD_GAP;
    } else if (cv && cv.style.display !== 'none') top = Math.round(cv.getBoundingClientRect().bottom) + $.MM_HUD_GAP;
    var want = top + 'px';
    if (el.style.top !== want) el.style.top = want;
};

var _sceneBaseUpdateMinimap = Scene_Base.prototype.update;
Scene_Base.prototype.update = function() {
    _sceneBaseUpdateMinimap.call(this);
    if ($.role && window.Imported && Imported.TM_Minimap && Graphics.frameCount % $.MM_HUD_FRAMES === 0) $.mmPlaceHud();
};

// ---- (1b) not over a choice list (user 2026-11-07: "the minimap sometimes
// cuts the choices off - can it close while a menu is open"): while the message
// asks for a choice, a number or an item, its window and its corner canvas are
// not shown. Its own update shows them again every frame, so this hides them
// after it, for that frame; the canvas draws again once it is not hidden
// ($.mmPatchScreen). Alone too.
// Off for the last stretch of an ending (user 2026-11-10: nothing left to look
// up there): ending A from the Sylvian cavalry's tunnel (Map137) on, B / C inside
// the hollow tower. Each PC by the map it is on.
$.MM_OFF_MAPS = Object.assign({ 137: true, 139: true, 136: true, 140: true }, $.ENDING_MAPS);
$.mmOffHere = function() {
    return typeof $gameMap !== 'undefined' && !!$gameMap && !!$.MM_OFF_MAPS[$gameMap.mapId()];
};

$.mmMenuOpen = function() {
    if ($.mmOffHere()) return true;
    if ($.mmHexenOpen()) return true;
    if (typeof $gameMessage === 'undefined' || !$gameMessage) return false;
    return $gameMessage.isChoice() || $gameMessage.isNumberInput() || $gameMessage.isItemChoice();
};

// The Hexen's skill pages (user 2026-11-08, "spice forge too"): standing on a
// skill shows its page, picture hexen_<skill> over the right half - the
// minimap's place. Not while one is shown.
$.mmHexenOpen = function() {
    var list = typeof $gameScreen !== 'undefined' && $gameScreen && $gameScreen._pictures;
    if (!list) return false;
    for (var i = 0; i < list.length; i++) {
        var p = list[i];
        if (p && p.opacity() > 0 && /^hexen_/.test(p.name())) return true;
    }
    return false;
};

$.mmHideForMenu = function(scene) {
    var win = scene && scene._fhMinimap;
    if (!win || !window.FH || !FH.Minimap || !$.mmMenuOpen()) return false;
    win.visible = false;
    if (typeof FH.Minimap.hideScreen === 'function') FH.Minimap.hideScreen();
    return true;
};

var _sceneMapUpdateMmMenu = Scene_Map.prototype.update;
Scene_Map.prototype.update = function() {
    _sceneMapUpdateMmMenu.call(this);
    $.mmHideForMenu(this);
};

// ---- (2) one explored map for everyone

$.mmMerge = function(all, id, bits) {
    if (!all || !Array.isArray(bits)) return false;
    var cur = all[id];
    if (!cur) {
        all[id] = bits.slice();
        return true;
    }
    if (cur.length !== bits.length) return false; // (another map's size: other game data)
    var changed = false;
    for (var i = 0; i < bits.length; i++) {
        var v = cur[i] | bits[i];
        if (v !== cur[i]) {
            cur[i] = v;
            changed = true;
        }
    }
    return changed;
};

// this map's minimap paints what it now knows: the cells new in it (old: its
// bits before, none = a new map: every explored cell)
$.mmRepaint = function(id, old) {
    var win = SceneManager._scene && SceneManager._scene._fhMinimap;
    if (!win || win._mapId !== Number(id) || !$gameMap || $gameMap.mapId() !== Number(id)) return;
    var bits = $gameSystem._fhMapSeen[id], w = $gameMap.width(), n = w * $gameMap.height();
    if (!old || !win._full || typeof win.paintCell !== 'function') {
        win._mapId = 0; // (its setupMap paints every explored cell)
        return;
    }
    for (var i = 0; i < bits.length; i++) {
        var fresh = bits[i] & ~(old[i] | 0);
        if (!fresh) continue;
        for (var b = 0; b < 32; b++) {
            var c = i * 32 + b;
            if (c < n && (fresh >>> b) & 1) win.paintCell(c % w, Math.floor(c / w));
        }
    }
};

// Maps whose bits changed since mmChanged looked (all: every map, a new world)
$.mmDirty = {};
$.mmAllDirty = true;

$.mmTake = function(maps) {
    var all = $gameSystem && ($gameSystem._fhMapSeen = $gameSystem._fhMapSeen || {});
    if (!all || !maps) return;
    Object.keys(maps).forEach(function(id) {
        var old = all[id] ? all[id].slice() : null;
        var mine = (old ? JSON.stringify(old) : '') !== ($.mmSent[id] || ''); // (explored here, not sent yet)
        if (!$.mmMerge(all, id, maps[id])) return;
        $.mmDirty[id] = true;
        // a guest does not send the host's own back; the host passes every
        // player's on to the others (marked sent, a new map went to nobody)
        if (!mine && !$.isHost()) $.mmSent[id] = JSON.stringify(all[id]);
        $.mmRepaint(id, old);
    });
};

// what this PC's own minimap explored (TM_Minimap's reveal: the map it is on)
$.mmWatchReveal = function() {
    var mm = window.FH && FH.Minimap;
    if (!mm || typeof mm.reveal !== 'function' || mm.reveal._fhDirty) return;
    var orig = mm.reveal;
    mm.reveal = function() {
        var fresh = orig.apply(this, arguments);
        if (fresh && fresh.length && $gameMap) $.mmDirty[$gameMap.mapId()] = true;
        return fresh;
    };
    mm.reveal._fhDirty = true;
};

$.mmChanged = function() {
    var all = $gameSystem && $gameSystem._fhMapSeen, out = null;
    if (!all) return null;
    if ($.mmSystem !== $gameSystem) $.mmAllDirty = true; // (a new game, a load, a snapshot)
    $.mmSystem = $gameSystem;
    var ids = $.mmAllDirty ? Object.keys(all) : Object.keys($.mmDirty).filter(function(id) { return !!all[id]; });
    $.mmAllDirty = false;
    $.mmDirty = {};
    ids.forEach(function(id) {
        var key = JSON.stringify(all[id]);
        if (key === $.mmSent[id]) return;
        $.mmSent[id] = key;
        (out = out || {})[id] = all[id];
    });
    return out;
};

$.mmSync = function() {
    if (!$.minimapOn() || !$gameSystem || Graphics.frameCount % $.MM_SYNC_FRAMES !== 0) return;
    var maps = $.mmChanged();
    if (!maps) return;
    if ($.isHost()) $.clients.forEach(function(c) { if (!c._sub) c.send({ t: 'mmSeen', m: maps }); });
    else if ($.conn) $.conn.send({ t: 'mmSeen', m: maps });
};

// ---- (4) the Korean patch: locked doors (alone too, no session needed)
// Its red "locked" mark looks for "lock"/"locked" in the page's text: in the
// Korean data that found none of the 210 pages it finds in English. A page
// with 잠겨/잠긴/잠궈/잠겼/잠가/자물쇠 is locked too, but not "생각에 잠긴"
// (lost in thought) or a locker (사물함 잠겨 = "the locker door is stuck",
// not marked in English either) or learning Lockpicking (자물쇠 따기).
// Checked on the Korean data: 181 of the English pages found (the 29 others
// are mostly English false hits: "a joint lock", "locked me up").
$.MM_KO_LOCKED = /잠겨|잠긴|잠궈|잠겼|잠가|자물쇠/;
$.MM_KO_NOT_LOCKED = /생각에|사물함|자물쇠 ?따기/;
$.mmKoLocked = new WeakMap(); // page list -> locked (its texts do not change)

$.mmKoreanLocked = function(list) {
    if (!list) return false;
    var known = $.mmKoLocked.get(list);
    if (known !== undefined) return known;
    var locked = list.some(function(c) {
        var t = c.code === 401 && String(c.parameters[0] || '');
        return !!t && $.MM_KO_LOCKED.test(t) && !$.MM_KO_NOT_LOCKED.test(t);
    });
    $.mmKoLocked.set(list, locked);
    return locked;
};

$.mmPatchKorean = function() {
    var mm = FH.Minimap;
    if (mm._fhKorean || typeof mm.markerOf !== 'function' || !$.koreanData || !$.koreanData()) return;
    mm._fhKorean = true;
    var _markerOf = mm.markerOf;
    mm.markerOf = function(ev) {
        var kind = _markerOf.call(this, ev);
        if (kind === 'locked' || !ev || ev._erased) return kind;
        var page = ev.page();
        return page && $.mmKoreanLocked(page.list) ? 'locked' : kind;
    };
};

var _sceneMapUpdateMinimap = Scene_Map.prototype.update;
Scene_Map.prototype.update = function() {
    _sceneMapUpdateMinimap.call(this);
    if ($.minimapOn() && !FH.Minimap._fhKorean) $.mmPatchKorean();
    if ($.minimapOn()) $.mmWatchReveal();
    if ($.minimapOn()) $.mmPatchWindow(this._fhMinimap);
    if (!$.role || !$.sessionActive() || !(window.Imported && Imported.TM_Minimap)) return;
    $.mmSync();
};

$.hostHandlers.mmSeen = function(conn, msg) {
    if (msg && $.minimapOn()) $.mmTake(msg.m);
};

$.guestHandlers.mmSeen = function(msg) {
    if (msg && $.minimapOn()) $.mmTake(msg.m);
};

// A guest's new world from the host (a snapshot, a roam, its tutorial's
// retry): the places it explored stay explored (the same playthrough only).
// Its M (minimap shown or hidden, $gameSystem._fhMinimapOn - unset = shown)
// is its own: the host's came with every snapshot, so a guest's hidden map
// came back at the next map change and the host's M went to everyone.
var _extractSaveContentsMinimap = DataManager.extractSaveContents;
DataManager.extractSaveContents = function(contents) {
    var keep = null, run = '', guest = $.role && $.isGuest() && window.Imported && Imported.TM_Minimap && $gameSystem;
    var shown = guest ? $gameSystem._fhMinimapOn : undefined;
    if (guest && $gameSystem._fhMapSeen) {
        keep = $gameSystem._fhMapSeen;
        run = $.playRun();
    }
    _extractSaveContentsMinimap.call(this, contents);
    if (guest && $gameSystem) {
        if (shown === undefined) delete $gameSystem._fhMinimapOn;
        else $gameSystem._fhMinimapOn = shown;
    }
    if (!keep || !$gameSystem || $.playRun() !== run) return;
    var all = $gameSystem._fhMapSeen = $gameSystem._fhMapSeen || {};
    Object.keys(keep).forEach(function(id) { $.mmMerge(all, id, keep[id]); });
};

var _resetRoamsMinimap = $.resetRoams;
$.resetRoams = function() {
    _resetRoamsMinimap();
    $.mmSent = {}; // (a load: everything goes again)
    $.mmAllDirty = true;
};

// ---- (3) the other players on this map

// (also (5) below: alone too, its redraw is wrapped once, the dots inside)
$.mmPatchWindow = function(win) {
    var proto = win && Object.getPrototypeOf(win);
    if (!proto || proto._fhCoopPlayers || typeof proto.redraw !== 'function') return;
    proto._fhCoopPlayers = true;
    $.mmMarkCache();
    $.mmPatchScreen();
    var _redraw = proto.redraw;
    proto.redraw = function() {
        var key = $.mmDrawKey(this);
        if (key === this._fhDrawn) return; // (nothing it shows changed: its drawing stays)
        this._fhDrawGen = ++$.mmDrawCount;
        _redraw.call(this);
        this._fhDrawn = key; // (after it: a failed drawing is tried again)
        if ($.role && $.sessionActive()) $.mmDrawPlayers(this);
    };
    ['paintCell', 'setupMap'].forEach(function(name) {
        var orig = proto[name];
        if (typeof orig !== 'function') return;
        proto[name] = function() {
            this._fhGen = (this._fhGen || 0) + 1; // (its map image changed)
            return orig.apply(this, arguments);
        };
    });
};

// ---- (5) only draw when something changed (user 2026-11-04: a laptop
// running a host and a guest with it spun its fan hard). Every frame (60 a
// second, standing still too) it cleared and drew its whole window, read the
// texts of every seen door's page again for its mark, and drew its canvas
// over the game's again (setting its size and measuring the game's canvas).
// Now a door's mark is read once per page; the window draws again only when
// what it shows changed (its map image, the player's place or blink, the
// marks, the other players' dots); its canvas only after a new drawing or a
// new window size.

$.mmDrawCount = 0; // (every drawing a new number: a new window never matches an old canvas)

$.mmMarkCache = function() {
    var mm = FH.Minimap;
    if (mm._fhMarkCache || typeof mm.markerOf !== 'function') return;
    mm._fhMarkCache = true;
    var base = mm.markerOf, known = new WeakMap(); // page list -> its mark (its texts do not change)
    mm.markerOf = function(ev) {
        if (!ev || ev._erased) return null;
        var page = ev.page(), list = page && page.list;
        if (!list) return base.call(this, ev);
        var kind = known.get(list);
        if (kind === undefined) {
            kind = base.call(this, ev) || null;
            known.set(list, kind);
        }
        return kind;
    };
};

// what its window shows, as text: the same text = the same picture (places
// to half a pixel of its window: it draws on whole pixels)
$.mmDrawKey = function(win) {
    var mm = FH.Minimap, s = win._cell || 1;
    var at = function(v) { return Math.round(v * s * 2); };
    var key = [win._mapId, win._fhGen || 0, win._cell, win._full ? win._full.width + 'x' + win._full.height : '',
        at($gamePlayer._realX), at($gamePlayer._realY), (win._blink || 0) < 28 ? 1 : 0];
    if (typeof mm.isSeen === 'function' && typeof mm.seen === 'function' && typeof mm.markerOf === 'function') {
        var arr = mm.seen();
        $gameMap.events().forEach(function(ev) {
            if (!mm.isSeen(arr, ev.x, ev.y)) return;
            var kind = mm.markerOf(ev);
            if (kind) key.push(ev.x + ',' + ev.y + kind);
        });
    }
    if ($.role && $.sessionActive()) {
        Object.keys($.remotes || {}).forEach(function(id) {
            var r = $.remotes[id];
            if (r && !r._transparent && r._placed) key.push(id + ':' + at(r._realX) + ',' + at(r._realY));
        });
    }
    return key.join('|');
};

$.mmPatchScreen = function() {
    var mm = FH.Minimap;
    if (mm._fhScreenOnce || typeof mm.drawScreen !== 'function') return;
    mm._fhScreenOnce = true;
    var _drawScreen = mm.drawScreen;
    mm.drawScreen = function(contents) {
        var win = SceneManager._scene && SceneManager._scene._fhMinimap;
        var stamp = win && win._fhDrawGen ? win._fhDrawGen + '|' + (Graphics._realScale || 1) + '|' +
            window.innerWidth + 'x' + window.innerHeight : null;
        var cv = mm.screen;
        if (stamp && cv && cv.style.display !== 'none' && cv._fhStamp === stamp) return;
        _drawScreen.call(this, contents);
        if (mm.screen) mm.screen._fhStamp = stamp;
    };
};

// (the same placement as its own dot for the player)
$.mmDrawPlayers = function(win) {
    if (!win._full || !win.contents) return;
    var b = win.contents, s = win._cell, inner = win.contentsWidth();
    var fw = win._full.width, fh = win._full.height;
    var px = ($gamePlayer._realX + 0.5) * s, py = ($gamePlayer._realY + 0.5) * s;
    var ox = fw <= inner ? Math.floor((inner - fw) / 2) : Math.round(Math.min(0, Math.max(inner - fw, inner / 2 - px)));
    var oy = fh <= inner ? Math.floor((inner - fh) / 2) : Math.round(Math.min(0, Math.max(inner - fh, inner / 2 - py)));
    var pm = Math.max(3, s + 1);
    Object.keys($.remotes || {}).forEach(function(id) {
        var r = $.remotes[id];
        if (!r || r._transparent || !r._placed) return;
        var qx = Math.round(ox + (r._realX + 0.5) * s - pm / 2), qy = Math.round(oy + (r._realY + 0.5) * s - pm / 2);
        b.fillRect(qx - 1, qy - 1, pm + 2, pm + 2, '#000000');
        b.fillRect(qx, qy, pm, pm, $.MM_PLAYER_COLOR);
    });
};

//=============================================================================
// A ghost guest's door on the host's map (user decision 2026-11-05)
//=============================================================================
// A ghost uses every move-related interaction as anyone (FH_CoopBattle
// $.ghostMovePage: a lock, a choice, a ladder, an elevator, a door that opens
// in steps). That ran on the PC running the map: the dead host's, a roaming
// ghost's. A ghost guest on the host's map is a thin client and runs no
// events: Z there did nothing but on simple doors. Now the host runs that
// event for it as it runs a living guest's ($.runOwned), with the ghost's
// rules: an answer with a fight greyed out, the autorun pages its door turns
// on are its own too (a living guest's go through startEventFor, which turns
// a dead one down - those pages moved the host), and its move to another map
// is a ghost's (a still copy, $.ghostGo), not a map of its own to run.

$.ghostRunFor = function(conn, ev, triggers, normal) {
    if (!conn || !conn.actorId || !$.isDead(conn.guestId) || !$.guestOnMap(conn) ||
            conn.roam || conn.roamPending || conn.subOf || $.isBusy(conn)) {
        return false;
    }
    if (ev._erased || ev._fhOwner || ev._locked || ev._starting || $.hostRunHolds(ev) || $.ghostDoorBarred(ev)) {
        return false;
    }
    var found = $.guestPage(conn, ev);
    if (!found) return false;
    var page = found.page;
    if (triggers && triggers.indexOf(page.trigger) < 0) return false;
    if (normal !== undefined && normal !== null && (page.priorityType === 1) !== normal) return false;
    // (not a sleep, not a fight outside a choice's answers: $.ghostMovePage)
    if (!$.ghostMovePage(ev, page) || $.pageNeedsConsent(page.list)) return false;
    $.runOwned(conn, page.list, ev);
    $.dlog('ghost door of', conn.name, ': the host runs ev' + ev.eventId(), 'p' + found.index);
    return true;
};

// Its 'act' (FH_CoopBattle $.ghostAskHost): the event it pressed or stepped on.
$.ghostActFor = function(conn, msg) {
    var id = Number(msg.g);
    $gameMap.eventsXy(msg.x, msg.y).some(function(ev) {
        return ev.eventId() === id && $.ghostRunFor(conn, ev, msg.tr, msg.n);
    });
};

// An autorun page its door turned on (the next step of a gate, an elevator's
// ride): its own, as its door was. (The newest write decides, as in
// FH_CoopWorld "Autorun pages a guest turned on"; outside every context.)
var _gameEventStartGhostGuest = Game_Event.prototype.start;
Game_Event.prototype.start = function() {
    if ($.isHost() && this._trigger === 3 && !this._fhOwner && !$.ctx && !$gamePlayer._fhRemoteId &&
            this._fhHandedPage !== this._pageIndex) {
        var slot = $gameMap._events[this.eventId()];
        var cause = !slot || slot === this ? $.pageCause(this) : null;
        var conn = cause && cause.id !== 'host' ? $.clientById(cause.id) : null;
        if (conn && $.isDead(conn.guestId) && $.guestOnMap(conn) && $.ghostMovePage(this, this.page())) {
            // its door is still finishing: this page waits for it
            if ($.isBusy(conn) || $.hostRunHolds(this)) {
                cause.at = $.clockMs();
                cause.n = ++$.causeSeq;
                return;
            }
            if ($.ghostRunFor(conn, this, [3])) return;
        }
    }
    _gameEventStartGhostGuest.call(this);
};

// Its move to another map: a ghost's way there (its PC shows that map as a
// still copy and runs no events). The rest of the event is the map's it
// left: it ends here. On the host's map (a ladder, a door within the map)
// it moves as any guest does.
$.ghostGone = {}; // host: guest id -> its spot { m, x, y, d, f }
var _fhGuestTransferGhost = Game_Interpreter.prototype.fhGuestTransfer;
Game_Interpreter.prototype.fhGuestTransfer = function() {
    var id = this._fhOwner;
    if (!id || !$.isDead(id) || !$.clientById(id) || $gameMessage.isBusy()) return _fhGuestTransferGhost.call(this);
    var spot = $.transferSpot(this);
    if (spot.m === $gameMap.mapId() || ($.DREAM_MAPS && $.DREAM_MAPS[spot.m])) return _fhGuestTransferGhost.call(this);
    spot.f = this._params[5] || 0;
    $.ghostGone[id] = spot;
    this.setWaitMode('fhHanded'); // (until it is let go below)
    return false;
};

// Let go as a hand-off is (FH_CoopRoam "A guest's transfer to another map"):
// an autorun page that took it stays its own until someone presses it again
// (the Kaiser room door: the next one through goes too), the door's steps go
// off.
var _updateOwnedGhost = $.updateOwned;
$.updateOwned = function() {
    _updateOwnedGhost();
    Object.keys($.ghostGone).forEach(function(id) {
        var spot = $.ghostGone[id];
        delete $.ghostGone[id];
        var entry = $.owned[id];
        var conn = $.clientById(id);
        if (!entry || !conn) return;
        if (entry.ev && entry.ev._trigger === 3) {
            entry.ev._fhHandedPage = entry.ev._pageIndex;
            $.awaitOthersTransfer(entry.ev);
        }
        if (!$gameMap._interpreter.isRunning()) {
            $.clearDoorSteps();
            $gameMap.requestRefresh();
        }
        $.finishOwned(id);
        conn.send({ t: 'ghostGo', m: spot.m, x: spot.x, y: spot.y, d: spot.d, f: spot.f });
        $.dlog('ghost door of', conn.name, ': to map', spot.m, spot.x, spot.y);
    });
};

// Its choice: an answer with a fight greyed out, as on the dead host's own
// map (FH_CoopBattle $.fightAnswers; that one greys them in setupChoices,
// which a guest's event never calls - its choices go to its screen).
var _fhRemoteMessageGhost = Game_Interpreter.prototype.fhRemoteMessage;
Game_Interpreter.prototype.fhRemoteMessage = function(withText) {
    if (this._fhOwner && $.ctx && this._list && $.isDead(this._fhOwner)) {
        var at = this._index;
        if (withText) {
            at++;
            while (this._list[at] && this._list[at].code === 401) at++;
        }
        var cmd = this._list[at];
        if (cmd && cmd.code === 102) {
            var mods = $.choiceModsOf();
            $.fightAnswers(this._list, at).forEach(function(n) { mods.dis[n] = true; });
        }
    }
    return _fhRemoteMessageGhost.call(this, withText);
};

//=============================================================================
// Companions in co-op: a recruit goes to wait on the train or at the club
//=============================================================================
// User decision 2026-11-05 (docs/진행상황.md): a companion walking along with
// the players is hard to do in co-op, and a plain "your party is full" left
// the recruit talks unused. The original has the place for a companion who is
// not in the party: brought onto the train (Map014 EV74, touched at the
// door) or into PRHVL Bop (Map067 EV85), each one "sits down" there and waits
// (its own *_waiting_train / *_waiting_club switches, Olivia's train
// V2301, Marcoh's train only "already left"; Daan's club is the bar). So in
// co-op a recruit talk runs as in the original (its party-size question
// answered "room"), the party add is left out (FH_CoopWorld), and once the
// talk is over that character's part of one of those two drop-off events
// runs, at random, quietly (its switches and variables, not its words), as
// if the party had walked in there with them. The player who talked is told
// where they went.
// - Only the eight contestants who can be players (not ghouls, Black Kalev,
//   the golem), not a character a player plays, not on the start screens.
// - Not the temporary joins: Daan in the shack (Map049 EV36, he leaves at the
//   Lake / Old Town exits: S3190 travelling_with_doctor) and Marina in the
//   Mayor's manor (Map020 EV76 / EV256, she leaves after some rooms: S469
//   marina_joined_manor) - a recruit that writes one of those stays "full",
//   as before (wiki: Daan, Marina are recruited for good later).
// - A drop-off part that does not get to its party remove (Karin's club
//   before the journal is shown, Abella's and Karin's club before the
//   headquarters...) is tried first without writing anything; the other
//   place is taken then, and with neither the talk stays "full".
// - A companion waiting at one of them: its talk's "Want to tag along?" is
//   greyed out and an answer is added - "Wait for me at the club." on the
//   train, "Wait for me on the train." at the club (user, same day). It runs
//   the tag-along answer (the original's words and its waiting switch off)
//   and sends it to the other place.
// - Where the world runs: the host, a roaming guest on its own map (its world
//   writes go to the host as always). Not a guest's own tutorial.
$.DROP_RECRUITS = [1, 3, 4, 5, 6, 13, 14, 15];
$.DROP_START_MAPS = [10, 35, 155];
$.DROP_TEMP_FLAGS = [3190, 469];
$.DROP_PLACES = {
    train: { map: 14, ev: 74, words: 'on the train', ask: '"Wait for me on the train."' },
    club: { map: 67, ev: 85, words: 'at the club', ask: '"Wait for me at the club."' }
};
// where each one waits now: its switches (and Olivia's V2301); else the map.
// The club is read first: Marcoh's train has no switch of its own - he stands
// outside the train again (Map004 EV226, in the evening inside: Map014 EV148)
// once recruited (S3663 marcoh_recruited_once) and not at the club.
$.DROP_WAIT = {
    club: { s: { 1: [3702], 3: [3656], 4: [1747], 5: [2654], 6: [4005], 13: [3441], 14: [3603], 15: [3432] }, v: {}, maps: [67, 105] },
    train: { s: { 1: [2241, 3707], 3: [3665], 4: [3418, 3573], 5: [2650], 6: [4008], 13: [3663], 14: [3608] }, v: { 15: 2301 }, maps: [14] }
};
$.dropOffs = [];     // [{ actor, runner, mapId, eventId, interp, at, place }]
$.dropForce = {};    // actor -> the place its next drop-off goes to (the added answer)
$.dropLists = {};    // 'place/actor' -> its part of the drop-off event

$.dropOffOn = function() {
    if (!$.role || !$.companionsBlocked || !$.companionsBlocked() || ($.isGuest() && $.solo)) return false;
    if (!$.isHost() && !($.isRoaming && $.isRoaming())) return false;
    return !!$gameMap && $.DROP_START_MAPS.indexOf($gameMap.mapId()) < 0;
};

$.dropIsPlayer = function(actorId) {
    if (actorId === $.myActorId) return true;
    if (($.clients || []).some(function(c) { return c.actorId === actorId; })) return true;
    try {
        return $.takenActors().indexOf(actorId) >= 0;
    } catch (e) {
        return false;
    }
};

$.dropRecruit = function(actorId) {
    return $.DROP_RECRUITS.indexOf(actorId) >= 0 && !$.dropIsPlayer(actorId);
};

// The block after list[at] (deeper than its indent): its contestant adds, and
// whether it is a temporary join.
$.dropAddsIn = function(list, at) {
    var out = { actors: [], temp: false }, indent = list[at].indent;
    for (var i = at + 1; i < list.length && list[i].indent > indent; i++) {
        var c = list[i];
        if (c.code === 129 && c.parameters[1] === 0 && $.dropRecruit(c.parameters[0]) &&
                out.actors.indexOf(c.parameters[0]) < 0) out.actors.push(c.parameters[0]);
        if (c.code === 121 && c.parameters[2] === 0 && $.DROP_TEMP_FLAGS.some(function(s) {
            return s >= c.parameters[0] && s <= c.parameters[1];
        })) out.temp = true;
    }
    return out;
};

// A temporary join at list[i] (a 129): one of its flags goes on in the rest
// of that block.
$.dropTempAt = function(list, i) {
    var indent = list[i].indent;
    for (var j = i + 1; j < list.length && list[j].indent >= indent; j++) {
        var c = list[j];
        if (c.code === 121 && c.parameters[2] === 0 && $.DROP_TEMP_FLAGS.some(function(s) {
            return s >= c.parameters[0] && s <= c.parameters[1];
        })) return true;
    }
    return false;
};

// That character's part of a drop-off event: the top-level statements that
// ask whether it is in the party.
$.dropOffList = function(actorId, place) {
    var key = place + '/' + actorId;
    if ($.dropLists[key] !== undefined) return $.dropLists[key];
    var spec = $.DROP_PLACES[place], data = spec && $.bodyMapData(spec.map);
    var ev = data && data.events && data.events[spec.ev];
    var list = ev && ev.pages[0] && ev.pages[0].list, out = [];
    if (list) {
        var stmt = [];
        var flush = function() {
            if (stmt.some(function(c) {
                return c.code === 111 && c.parameters[0] === 4 && c.parameters[1] === actorId && c.parameters[2] === 0;
            })) out = out.concat(stmt);
            stmt = [];
        };
        list.forEach(function(c) {
            if (c.indent === 0 && c.code !== 411 && c.code !== 412) flush();
            if (c.code !== 108 && c.code !== 408 && !(c.indent === 0 && c.code === 0)) stmt.push(c);
        });
        flush();
    }
    $.dropLists[key] = out.length ? out.concat([{ code: 0, indent: 0, parameters: [] }]) : null;
    return $.dropLists[key];
};

// Runs a drop-off part quietly: no words, tints, waits, sounds, lights or
// common events; the facing check at the door is met; a Set Event Location
// only on that map. dry: switches and variables are read and written in a
// copy - only whether it gets to its party remove.
function Game_FHDropInterp(actorId, place, dry) {
    Game_Interpreter.call(this, 0);
    this._fhDrop = { actor: actorId, map: $.DROP_PLACES[place].map, removed: false, dry: !!dry, s: {}, v: {} };
}
Game_FHDropInterp.prototype = Object.create(Game_Interpreter.prototype);
Game_FHDropInterp.prototype.constructor = Game_FHDropInterp;
$.Game_FHDropInterp = Game_FHDropInterp;
$.DROP_QUIET = [101, 102, 117, 223, 224, 225, 230, 231, 232, 233, 234, 235, 241, 242, 245, 246, 249, 250, 251, 356, 401, 355, 655];

Game_FHDropInterp.prototype.dropSw = function(id) {
    var d = this._fhDrop;
    return d.dry && d.s[id] !== undefined ? d.s[id] : $gameSwitches.value(id);
};

Game_FHDropInterp.prototype.dropVar = function(id) {
    var d = this._fhDrop;
    return d.dry && d.v[id] !== undefined ? d.v[id] : $gameVariables.value(id);
};

Game_FHDropInterp.prototype.executeCommand = function() {
    var c = this.currentCommand();
    if (!c) {
        this.terminate();
        return false;
    }
    var p = c.parameters, d = this._fhDrop;
    this._params = p;
    this._indent = c.indent;
    if ($.DROP_QUIET.indexOf(c.code) >= 0 || (c.code === 203 && $gameMap.mapId() !== d.map)) {
        this._index++;
        return true;
    }
    if (c.code === 129) {
        if (p[0] === d.actor && p[1] !== 0) d.removed = true;
        this._index++;
        return true;
    }
    if (c.code === 111 && (p[0] === 6 || (d.dry && (p[0] === 0 || p[0] === 1)))) {
        var r = true;
        if (p[0] === 0) r = this.dropSw(p[1]) === (p[2] === 0);
        if (p[0] === 1) {
            var a = this.dropVar(p[1]), b = p[2] === 0 ? p[3] : this.dropVar(p[3]);
            r = [a === b, a >= b, a <= b, a > b, a < b, a !== b][p[4]];
        }
        this._branch[this._indent] = r;
        if (!r) this.skipBranch();
        this._index++;
        return true;
    }
    if (d.dry && c.code === 121) {
        for (var s = p[0]; s <= p[1]; s++) d.s[s] = p[2] === 0;
        this._index++;
        return true;
    }
    if (d.dry && c.code === 122) {
        var val = p[3] === 0 ? p[4] : p[3] === 1 ? this.dropVar(p[4]) : 0;
        for (var v = p[0]; v <= p[1]; v++) {
            var cur = this.dropVar(v);
            d.v[v] = [val, cur + val, cur - val, cur * val, val ? Math.floor(cur / val) : cur, val ? cur % val : cur][p[2]];
        }
        this._index++;
        return true;
    }
    if (d.dry && (c.code === 123 || c.code === 203)) {
        this._index++;
        return true;
    }
    return Game_Interpreter.prototype.executeCommand.call(this);
};

// true: that place took it (its party remove ran)
$.dropOffRun = function(actorId, place, dry) {
    var list = $.dropOffList(actorId, place);
    if (!list) return false;
    var it = new Game_FHDropInterp(actorId, place, dry);
    var party = $gameParty._actors;
    it.setup(list, 0);
    $gameParty._actors = [actorId]; // (its part asks "in the party?")
    try {
        for (var n = 0; n < 4000 && it.isRunning(); n++) {
            if (!it.executeCommand()) break;
        }
    } catch (e) {
        $.dlog('ERROR drop-off of actor', actorId, place, String(e));
        it._fhDrop.removed = false;
    } finally {
        $gameParty._actors = party;
    }
    if (!dry && $gameMap) $gameMap.requestRefresh();
    return it._fhDrop.removed;
};

// The places that would take it now: the asked one, else both at random.
$.dropPlacesFor = function(actorId, only) {
    var order = only ? [only] : (Math.random() < 0.5 ? ['train', 'club'] : ['club', 'train']);
    return order.filter(function(place) { return $.dropOffRun(actorId, place, true); });
};

// Where it waits now: 'train', 'club' or ''.
$.dropWhere = function(actorId) {
    var found = '';
    ['club', 'train'].forEach(function(place) {
        var w = $.DROP_WAIT[place];
        if (found) return;
        if ((w.s[actorId] || []).some(function(s) { return $gameSwitches.value(s); })) found = place;
        else if (w.v[actorId] && $gameVariables.value(w.v[actorId]) > 0) found = place;
    });
    if (!found && $gameMap) {
        ['train', 'club'].forEach(function(place) {
            if (!found && $.DROP_WAIT[place].maps.indexOf($gameMap.mapId()) >= 0) found = place;
        });
    }
    return found;
};

// The party-size question of a recruit: "room" when every character it adds
// has a place to go (not for a temporary join).
var _command111Drop = Game_Interpreter.prototype.command111;
Game_Interpreter.prototype.command111 = function() {
    var p = this._params;
    if (p[0] === 1 && p[1] === $.PARTY_SIZE_VAR && $.partyRoomCheck(this._list, this._index) === 'room' && $.dropOffOn()) {
        var adds = $.dropAddsIn(this._list, this._index);
        if (adds.actors.length && !adds.temp && adds.actors.every(function(a) {
            return $.dropPlacesFor(a, $.dropForce[a] || '').length > 0;
        })) {
            this._branch[this._indent] = true;
            $.dlog('companion check answered "room" (they go to wait on the train or at the club)', 'map', this._mapId,
                'event', this._eventId, 'line', this._index, 'actors', adds.actors.join(','));
            return true;
        }
    }
    return _command111Drop.call(this);
};

// The party add: noted, done when the talk is over.
$.dropOffAdd = function(interp, actorId) {
    if (interp._list && $.dropTempAt(interp._list, interp._index)) return false;
    var place = $.dropForce[actorId] || '';
    delete $.dropForce[actorId];
    $.dropOffs.push({ actor: actorId, runner: $.minionRunner(interp), mapId: interp._mapId || $gameMap.mapId(),
        eventId: interp._eventId, interp: interp, at: Graphics.frameCount, place: place });
    $.dlog('companion', actorId, 'joins: to wait', place || 'on the train or at the club', 'after the talk');
    return true;
};

var _command129Drop = Game_Interpreter.prototype.command129;
Game_Interpreter.prototype.command129 = function() {
    var p = this._params;
    if (p[1] === 0 && $.dropRecruit(p[0]) && $.dropOffOn() && $.dropOffAdd(this, p[0])) return true;
    return _command129Drop.call(this);
};

// (a guest's event on the host skips Change Party: IGNORE_FOR_GUEST)
var _executeCommandDrop = Game_Interpreter.prototype.executeCommand;
Game_Interpreter.prototype.executeCommand = function() {
    var command = this._fhOwner && $.runsWorld() && !(this instanceof Game_FHDropInterp) ? this.currentCommand() : null;
    if (command && command.code === 129 && command.parameters[1] === 0 && $.dropRecruit(command.parameters[0]) &&
            $.dropOffOn()) {
        this._params = command.parameters;
        this._indent = command.indent;
        $.dropOffAdd(this, command.parameters[0]);
        this._index++;
        return true;
    }
    return _executeCommandDrop.call(this);
};

// Its talk still runs: an interpreter of that event on this PC.
$.dropBusy = function(d) {
    if (Graphics.frameCount - d.at < 2) return true;
    if (Graphics.frameCount - d.at > 60 * 60 * 5) return false; // (5 minutes: it is over)
    if (d.interp && d.interp.isRunning()) return true;
    if (!d.eventId) return false;
    if ($gameMap.mapId() === d.mapId) {
        var mi = $gameMap._interpreter;
        if (mi && mi.isRunning() && mi.eventId() === d.eventId) return true;
        var ev = $gameMap.event(d.eventId);
        if (ev && ev._interpreter && ev._interpreter.isRunning()) return true;
    }
    var owned = $.owned || {};
    return Object.keys(owned).some(function(k) {
        var o = owned[k];
        return !!o && !!o.interp && o.interp.isRunning() && o.interp._eventId === d.eventId;
    });
};

$.dropOffDo = function(d) {
    var places = $.dropPlacesFor(d.actor, d.place);
    if (!places.length && d.place) places = $.dropPlacesFor(d.actor, '');
    var place = places[0];
    if (!place || !$.dropOffRun(d.actor, place, false)) {
        $.dlog('ERROR companion', d.actor, 'has no place to wait (train / club)');
        return;
    }
    var actor = $gameActors.actor(d.actor);
    $.dlog('companion', d.actor, 'went to wait', place, '(told', d.runner + ')');
    $.minionTell(d.runner, (actor ? actor.name() : 'They') + ' went to wait ' + $.DROP_PLACES[place].words + '.');
};

$.dropOffUpdate = function() {
    if (!$.dropOffs.length) return;
    var due = $.dropOffs.filter(function(d) { return !$.dropBusy(d); });
    if (!due.length) return;
    $.dropOffs = $.dropOffs.filter(function(d) { return due.indexOf(d) < 0; });
    due.forEach($.dropOffDo);
};

$.worldExtras.push(function() { if ($.isHost()) $.dropOffUpdate(); });
$.guestExtras.push(function() { if ($.isRoaming && $.isRoaming()) $.dropOffUpdate(); });

// (a load, a new game, leaving: $.freshGameState below - not at every
// extractSaveContents: a guest's snapshot or roam start keeps its drop-offs)

// ---- the waiting companion's talk

// The tag-along answer of a choice whose add is a companion waiting on the
// train or at the club: { answer, actor, other, text, extra } or null.
$.dropTalk = function(list, at) {
    if (!list || !list[at] || list[at].code !== 102 || !$.dropOffOn()) return null;
    var indent = list[at].indent, found = null;
    for (var i = at + 1; i < list.length && !found; i++) {
        var c = list[i];
        if (c.indent < indent || (c.indent === indent && c.code !== 402 && c.code !== 403)) break;
        if (c.indent !== indent || c.code !== 402) continue;
        var adds = $.dropAddsIn(list, i);
        if (adds.actors.length && !adds.temp) found = { answer: c.parameters[0], actor: adds.actors[0] };
    }
    if (!found) return null;
    var now = $.dropWhere(found.actor);
    if (!now) return null; // (not waiting anywhere: a first recruit goes at random)
    found.other = now === 'train' ? 'club' : 'train';
    found.text = $.DROP_PLACES[found.other].ask;
    found.extra = list[at].parameters[0].length;
    found.canGo = $.dropPlacesFor(found.actor, found.other).length > 0;
    return found;
};

var _setupChoicesDrop = Game_Interpreter.prototype.setupChoices;
Game_Interpreter.prototype.setupChoices = function(params) {
    var talk = this._fhOwner ? null : $.dropTalk(this._list, this._index);
    _setupChoicesDrop.call(this, params);
    if (!talk || !$gameMessage.isChoice()) return;
    if ($gameMessage.disableChoice) $gameMessage.disableChoice(talk.answer, true);
    if (!talk.canGo) return;
    var extra = $gameMessage._choices.length;
    $gameMessage._choices.push(talk.text);
    var cb = $gameMessage._choiceCallback;
    $gameMessage.setChoiceCallback(function(n) {
        if (n === extra) {
            $.dropForce[talk.actor] = talk.other;
            n = talk.answer;
        }
        if (cb) cb(n);
    });
};

// a guest's event: its choice goes to its screen (the added answer too)
var _fhRemoteMessageDrop = Game_Interpreter.prototype.fhRemoteMessage;
Game_Interpreter.prototype.fhRemoteMessage = function(withText) {
    this._fhDropTalk = null; // (a talk before: its answer was another question's)
    var at = this._index;
    if (withText) {
        at++;
        while (this._list[at] && this._list[at].code === 401) at++;
    }
    var cmd = this._list && this._list[at];
    var talk = this._fhOwner && $.ctx && cmd && cmd.code === 102 ? $.dropTalk(this._list, at) : null;
    if (!talk) return _fhRemoteMessageDrop.call(this, withText);
    $.choiceModsOf().dis[talk.answer] = true;
    if (!talk.canGo) return _fhRemoteMessageDrop.call(this, withText);
    var orig = cmd.parameters, copy = orig.slice();
    copy[0] = orig[0].concat([talk.text]);
    cmd.parameters = copy;
    if (!withText) this._params = copy;
    this._fhDropTalk = { extra: orig[0].length, answer: talk.answer, actor: talk.actor, other: talk.other };
    try {
        return _fhRemoteMessageDrop.call(this, withText);
    } finally {
        cmd.parameters = orig;
        if (!withText) this._params = orig;
    }
};

var _pmsgDoneDrop = $.hostHandlers.pmsgDone;
$.hostHandlers.pmsgDone = function(conn, msg) {
    var interp = $.findWaiting(conn.guestId, msg.id), dt = interp && interp._fhDropTalk;
    if (dt) {
        interp._fhDropTalk = null;
        if (Number(msg.choice) === dt.extra) {
            $.dropForce[dt.actor] = dt.other;
            msg = Object.assign({}, msg, { choice: dt.answer });
        }
    }
    return _pmsgDoneDrop(conn, msg);
};

//=============================================================================
// No limbs left: "You are unable to move..." (play test 2026-11-06)
//=============================================================================
// Original (data): CE40 Speed Status_check (parallel) turns SW41 disabled on
// when the chosen character has lost its second arm and its second leg (its
// <name>_arm2 / _leg2 switches, $.LIMB_SWITCHES [1] / [3]); nothing turns it
// off. Every map has an autorun "disabled" (Map004 EV6 ...) on SW41: "You are
// unable to move..." - "Quit breathing" (CE47 GameOver) / "Hold on!" (the
// page ends and starts again: the player never moves again).
// Co-op (play test: a thin guest with no limbs left walked about - it runs
// no CE40, its speed was ours): SW41 is each player's own (CTX_OWN_SWITCHES).
// The host turns a thin guest's on from its limbs and runs that map's page
// as the guest's event, again after each "Hold on!"; its PC does not move
// meanwhile. The host's own (its CE40) and a roaming guest's (its own map)
// run as in the original. Never a scene for everyone (the page is that
// player's alone). "Quit breathing" is a death for good (user 2026-11-06:
// up again it would be held again). Not for a ghost or a downed player.
$.DISABLED_SWITCH = 41;
$.DISABLED_RETRY = 30; // frames between "Hold on!" and the question again

$.isDisabledPage = function(page) {
    var c = page && page.conditions;
    return !!c && page.trigger === 3 && ((c.switch1Valid && c.switch1Id === $.DISABLED_SWITCH) ||
        (c.switch2Valid && c.switch2Id === $.DISABLED_SWITCH));
};

// This map's "disabled" page: { ev, page } or null
$.disabledPageHere = function() {
    var found = null;
    (($dataMap && $dataMap.events) || []).some(function(ev) {
        if (!ev || !ev.pages) return false;
        return ev.pages.some(function(p) {
            if (!$.isDisabledPage(p)) return false;
            found = { id: ev.id, page: p };
            return true;
        });
    });
    return found;
};

$.isDisabledList = function(list) {
    if (!list || !$dataMap || !$dataMap.events) return false;
    return $dataMap.events.some(function(ev) {
        return !!ev && ev.pages.some(function(p) {
            return $.isDisabledPage(p) && (p.list === list || ($.sameListShape && $.sameListShape(p.list, list)));
        });
    });
};

// An actor with no arm and no leg left (CE40's test)
$.limbless = function(actorId) {
    var sw = ($.LIMB_SWITCHES || {})[actorId];
    return !!sw && $gameSwitches.value(sw[1]) && $gameSwitches.value(sw[3]);
};

// "Quit breathing": the game over this page calls
$.DOOM_TEXT.disabled = 'quit breathing';
var _setupChildDisabled = Game_Interpreter.prototype.setupChild;
Game_Interpreter.prototype.setupChild = function(list, eventId) {
    _setupChildDisabled.call(this, list, eventId);
    var ce = $dataCommonEvents[$.GAME_OVER_CE];
    if ($.role && ce && this._childInterpreter && (list === ce.list || $.sameListShape(ce.list, list)) &&
            $.isDisabledList(this._list)) {
        this._childInterpreter._fhDoomCause = 'disabled';
    }
};

// That player's alone: never shared with the others on the map
var _isFHCoopSharedDisabled = Game_Interpreter.prototype.isFHCoopShared;
Game_Interpreter.prototype.isFHCoopShared = function() {
    var ev = this._eventId > 0 && $gameMap ? $gameMap.event(this._eventId) : null;
    if (ev && $.isDisabledPage(ev.page())) return false;
    return _isFHCoopSharedDisabled.call(this);
};

// The host's own page: not while it is a ghost or down
var _checkEventTriggerAutoDisabled = Game_Event.prototype.checkEventTriggerAuto;
Game_Event.prototype.checkEventTriggerAuto = function() {
    if ($.role && $.isDisabledPage(this.page()) && ($.isDownMe() || $gamePlayer._fhGhost)) return;
    _checkEventTriggerAutoDisabled.call(this);
};

// Host: a thin guest with no limbs left
$.disabledGuests = function() {
    if (!$.runsWorld() || $.ctx || !$gameMap || Graphics.frameCount % 10 !== 0) return;
    $.clients.forEach(function(c) {
        // (a sub-host: its own guests - isHost audit 2026-11-10)
        if ($.subHosting() && !c._sub) return;
        if ((!c.inGame && !c._sub) || !c.actorId || c.solo || c.roam || c.roamPending || c.subOf || $.isDown(c.guestId)) return;
        if (!$.limbless(c.actorId)) return;
        var own = c._fhCtxSw = c._fhCtxSw || {};
        if (!own[$.DISABLED_SWITCH]) {
            own[$.DISABLED_SWITCH] = true;
            $.dlog('no limbs left:', c.name, '- unable to move (SW41 its own)');
        }
        if (!$.guestOnMap(c) || $.isBusy(c)) {
            c._fhDisabledAt = Graphics.frameCount + $.DISABLED_RETRY; // (after its event: the wait from there)
            return;
        }
        if (Graphics.frameCount < (c._fhDisabledAt || 0)) return;
        var here = $.disabledPageHere();
        if (!here) return;
        $.runOwned(c, here.page.list, $gameMap.event(here.id));
    });
};
$.worldExtras.push($.disabledGuests);

// A thin guest's PC: no step with no limbs left (its own map: the page holds it)
var _canMoveDisabled = Game_Player.prototype.canMove;
Game_Player.prototype.canMove = function() {
    if ($.isThin && $.isThin() && !$.isDownMe() && !this._fhGhost && $.myActorId && $.limbless($.myActorId)) return false;
    return _canMoveDisabled.call(this);
};

//=============================================================================
// The duels hold: no step, no time (user 2026-11-06)
//=============================================================================
// A duelist whose turn came walked off the tower map and the bracket waited
// for it for ever (review 2026-11-06). User: "못 움직이고, 시간도 동결시켜서
// 다른 거 안 줄어들게" - from the tournament's start scene to its end, every
// living player in it stays where it is, and its time stands still: its
// hunger common events wait, its mind (MP) does not go down, its Eye of Rher
// timer (hard mode, "레르빔 제한시간도 멈춰야 함") waits. One who lost is a
// ghost: free. The host tells every PC when the duels are over or gone (a
// load); a player back in the middle of them is told too.
$.tourneyHold = null; // every PC: { ids } while the duels last

$.tourneyHoldMe = function() {
    var h = $.tourneyHold;
    if (!h || !$.role || h.ids.indexOf($.myPlayerId()) < 0) return false;
    return !($.isGhostMe && $.isGhostMe()) && !($.isDownMe && $.isDownMe());
};

var _tourneyIntroHold = $.guestHandlers.tourneyIntro;
$.guestHandlers.tourneyIntro = function(msg) {
    $.tourneyHold = { ids: (msg.ids || []).slice() };
    $.dlog('the duels hold: no step, no time until they are over');
    return _tourneyIntroHold(msg);
};

$.guestHandlers.tourneyHold = function(msg) {
    $.tourneyHold = msg.on ? { ids: (msg.ids || []).slice() } : null;
    if (!msg.on) $.dlog('the duels are over: free again');
};

// Host: the duels are over (or gone with a load)
$.tourneyOver = function(why) {
    $.tourneyHold = null;
    $.dlog('the duels hold ends (' + why + ')');
    $.clients.forEach(function(c) { c.send({ t: 'tourneyHold', on: false }); });
};

// a player back in the middle of them
var _sendAssignTourneyHold = $.sendAssign;
$.sendAssign = function(conn, actorId) {
    _sendAssignTourneyHold(conn, actorId);
    if ($.isHost() && $.tourney) conn.send({ t: 'tourneyHold', on: true, ids: $.tourney.players });
    if ($.isHost() && $.towerReadyNow) conn.send({ t: 'towerReady', on: true });
};

var _canMoveTourneyHold = Game_Player.prototype.canMove;
Game_Player.prototype.canMove = function() {
    if ($.tourneyHoldMe()) return false;
    return _canMoveTourneyHold.call(this);
};

var _commonEventUpdateTourneyHold = Game_CommonEvent.prototype.update;
Game_CommonEvent.prototype.update = function() {
    if ($.isHungerCe && $.isHungerCe(this._commonEventId) && $.tourneyHoldMe()) return;
    _commonEventUpdateTourneyHold.call(this);
};

var _gainMpTourneyHold = Game_Battler.prototype.gainMp;
Game_Battler.prototype.gainMp = function(value) {
    if (value < 0 && !$.ctx && this.isActor() && !$gameParty.inBattle() && $.tourneyHoldMe() &&
            $gameParty.members().indexOf(this) >= 0) return;
    _gainMpTourneyHold.call(this, value);
};

var _rherPausedTourneyHold = $.rherPaused;
$.rherPaused = function() {
    return $.tourneyHoldMe() || _rherPausedTourneyHold();
};

// The tower's duels can start (user 2026-11-09): once only players are left
// (the door's condition, $.onlyPlayersLeft) the Eye of Rher's time stands
// still for whoever is on the tower map; elsewhere it goes on. The host works
// it out and tells every PC when it changes, and one who comes back.
$.towerReadyNow = false;
$.updateTowerReady = function() {
    if (!$.isHost()) return;
    var on = !!$.onlyPlayersLeft();
    if (on === $.towerReadyNow) return;
    $.towerReadyNow = on;
    $.dlog('tower: only players left', on);
    $.clients.forEach(function(c) { c.send({ t: 'towerReady', on: on }); });
};

$.guestHandlers.towerReady = function(msg) {
    $.towerReadyNow = !!(msg && msg.on);
};

var _rherPausedTower = $.rherPaused;
$.rherPaused = function() {
    return ($.towerReadyNow && !!$gameMap && $gameMap.mapId() === $.TOWER_MAP) || _rherPausedTower();
};

var _sceneMapUpdateTowerReady = Scene_Map.prototype.update;
Scene_Map.prototype.update = function() {
    _sceneMapUpdateTowerReady.call(this);
    if (Graphics.frameCount % 30 === 0) $.updateTowerReady();
};

//=============================================================================
// The one the others went on without comes back moonscorched (user 2026-11-06)
//=============================================================================
// A player away from the tower door whom the others voted to go on without
// counts as dead (FH_CoopBattle towerDropOffline). User: once the duels are
// over (or at once, nobody left to duel), the last one standing is told "A
// chill runs down your spine..." (등골이 서늘하다), and a second later that
// player's character stands there moonscorched: its Eye of Rher form
// ($.RHER_FORMS; Daan as the original tower's: the Pocketcat fight,
// $.RHER_TOWER_FORMS), in its character's
// seat of the original tower scene (Map111 EV617), else by the winner. Its
// belongings: the one who kills it, or the tower's heir (whichever comes
// first - both take them out of its bag). Waiting ones are in the save.
$.TOWER_CHILL_TEXT = 'A chill runs down your spine...';
$.TOWER_CHILL_DELAY_MS = 1500; // the winner back from its last duel: a moment, then the line
$.TOWER_CHILL_MS = 3000;       // the line's time on screen (a toast), then the encounter at once
$.towerChill = null; // host: { win, at (ms), told } from the duels' end to the encounter

var _towerDropOfflineForms = $.towerDropOffline;
$.towerDropOffline = function(names) {
    var was = Object.assign({}, $.coopDead());
    _towerDropOfflineForms(names);
    var dead = $.coopDead(), assign = $.assignments(), data = $.coopData();
    (names || []).forEach(function(name) {
        if (was[name] || !dead[name] || !assign[name]) return;
        data.towerForms = data.towerForms || [];
        data.towerForms.push({ name: name, a: assign[name] });
        $.dlog('tower:', name, 'comes back moonscorched once the duels are over');
    });
};

// Its character's seat of the tower scene (Map111 EV617 -> "<name>_in_party"
// -> the seat event whose first page needs it), from the map's data.
$.towerSeatFromData = function(actorId) {
    var map = $.bodyMapData ? $.bodyMapData($.TOWER_MAP) : null;
    var ev = map && map.events[$.TOWER_SCENE_EVENT];
    if (!ev || !ev.pages[0]) return null;
    var sw = 0, at = 0;
    ev.pages[0].list.forEach(function(cmd) {
        var p = cmd.parameters;
        if (cmd.code === 111 && p[0] === 4 && p[2] === 0) at = p[1];
        else if (cmd.code === 121 && at) {
            if (at === actorId && !sw) sw = p[0];
            at = 0;
        }
    });
    if (!sw) return null;
    var seat = null;
    map.events.some(function(e) {
        var c = e && e.pages[0] && e.pages[0].conditions;
        if (!c || !c.switch1Valid || c.switch1Id !== sw || c.switch2Valid) return false;
        seat = { m: $.TOWER_MAP, x: e.x, y: e.y, d: e.pages[0].image.direction || 2 };
        return true;
    });
    return seat;
};

$.towerWinnerSpot = function(id) {
    if (id === 'host') return { m: $gameMap.mapId(), x: $gamePlayer.x, y: $gamePlayer.y, d: $gamePlayer.direction() };
    var c = $.clientById(id), p = c && c.lastPos;
    return p ? { m: p.m || $gameMap.mapId(), x: p.x, y: p.y, d: p.d || 2 } : null;
};

// The winner is back on its map, free (not fighting, no event of its own).
$.towerWinnerFree = function(id) {
    if (id === 'host') return !$gameParty.inBattle() && SceneManager._scene instanceof Scene_Map && !$gameMap.isEventRunning();
    var c = $.clientById(id);
    return !!c && !c.inBattle && !$.isBusy(c);
};

$.towerFormsUpdate = function() {
    var data = $.coopData(), list = data.towerForms;
    if (!$.isHost() || !list || !list.length || $.tourney || $.tourneyAsk || $.consent) return;
    var living = $.towerLiving();
    if (living.length !== 1) { $.towerChill = null; return; } // (the duels first)
    var win = living[0], now = $.clockMs();
    var ch = $.towerChill;
    if (!ch || ch.win !== win) ch = $.towerChill = { win: win, at: 0, told: false };
    if (!ch.told) {
        if (!$.towerWinnerFree(win)) { ch.at = 0; return; }
        if (!ch.at) { ch.at = now + $.TOWER_CHILL_DELAY_MS; return; }
        if (now < ch.at) return;
        ch.told = true;
        ch.at = now + $.TOWER_CHILL_MS;
        if (win === 'host') $.toast($.TOWER_CHILL_TEXT);
        else $.clientById(win).send({ t: 'toast', text: $.TOWER_CHILL_TEXT });
        $.dlog('tower: the chill for', $.playerLabel(win));
        return;
    }
    if (now < ch.at) return;
    $.towerChill = null;
    var near = $.towerWinnerSpot(win);
    data.towerForms = [];
    var first = null;
    list.forEach(function(f) {
        var seat = $.towerSeatFromData(f.a);
        var spot = seat && near && near.m === $.TOWER_MAP ? seat : near;
        if (!spot) return;
        if ($gameActors.actor(f.a)) $.markDoom($gameActors.actor(f.a), 'moonscorch');
        var rec = $.rherSpawn(null, f.a, spot, f.name, { tower: true });
        first = first || rec;
        $.dlog('tower:', f.name, 'is back moonscorched at map', spot.m, spot.x, spot.y);
    });
    if (first) $.towerEncounter(win, first);
};
// (every map frame, not as a world extra: those run only while a guest is connected,
// and a host alone at the door - the others offline - never got its encounter:
// user test 2026-11-10, log window_18216)
var _sceneMapUpdateTowerForms = Scene_Map.prototype.update;
Scene_Map.prototype.update = function() {
    _sceneMapUpdateTowerForms.call(this);
    if ($.isHost() && $.hostInGame) $.towerFormsUpdate();
};

// The encounter at once: the form's page (its fight - Pocketcat: its talk)
// for the winner.
$.towerEncounter = function(win, rec) {
    var c = win === 'host' ? null : $.clientById(win);
    if (c && (c.roam || c.roamPending)) {
        c.send({ t: 'rherStart', n: rec.n }); // (its PC runs that map)
        return;
    }
    var ev = rec.m === $gameMap.mapId() ? $gameMap.event(rec.id) : null;
    if (!ev) return;
    if (c) $.runOwned(c, ev.list(), ev);
    else ev.start();
    $.dlog('tower: the encounter with', rec.who + '\'s form for', $.playerLabel(win));
};

// A PC running its own map: that form's page starts here (once it stands here).
$.rherStartWant = null; // { n, until (ms) }
$.guestHandlers.rherStart = function(msg) {
    $.rherStartWant = { n: Number(msg.n), until: $.clockMs() + 5000 };
};
$.guestExtras.push(function() {
    var w = $.rherStartWant;
    if (!w) return;
    if ($.clockMs() > w.until) { $.rherStartWant = null; return; }
    var rec = $.rherRecordN(w.n);
    var ev = rec && rec.m === $gameMap.mapId() ? $gameMap.event(rec.id) : null;
    if (!ev || $gameMap.isEventRunning() || $gamePlayer.isTransferring()) return;
    $.rherStartWant = null;
    ev.start();
});

//=============================================================================
// The Orphanage's Tes'tich table (hard mode): each player once (user 2026-11-06)
//=============================================================================
// Original (data): Map164 EV104 (the table, 81,45), hard mode (SW4819): "Use
// hexen" sets V2300 facing and V2592 school_hexen_use 1 and goes to the board
// (Map031 8,8). The board's way out (Map031 EV1 page 1): V2592 1 -> 0, and in
// hard mode with V2593 gull_hexen_surprise 0: V2600 GULL_BROS_ACTIVE 1 (the
// Gull Bros about Prehevil) and V2593 1, back by the table. The table's page
// on V2593 >= 1 is empty; Map164 EV109 (parallel, V2593 >= 1): the Gull Bros
// come in and crush it (V2594 1-3), then hunt the player.
// Co-op (user 2026-11-06): every living player may use it once. The first one
// back turns the Gull Bros on (V2600, as in the original); the crush waits
// until the last of them is back from the board (V2593: the host turns it on
// then). One who used it has "Use hexen" greyed out.
// The trip's values (V2289 / V2592 / V2300) are world values: another
// player's way out (V2592 back to 0) or use (its facing) came into a PC on the
// board and sent it out the wrong way (to the Moon tower). On the board a PC
// keeps its own (set before it went there) and takes no other player's.
$.TESTICH = { map: 164, ev: 104, hard: $.HARD_MODE_SWITCH || 4819, use: 2592, crush: 2593, board: 31 };
$.TRIP_VARS = { 2289: true, 2592: true, 2300: true };
$.testichSeen = {};        // a guest: name -> 'in' / 'done' (from the host)
$.testichMe = '';          // a guest: its name on the host
$.testichCrushing = false; // the host turns V2593 on

$.testichHard = function() {
    return !!$gameSwitches && !!$gameSwitches.value($.TESTICH.hard);
};

// name -> 'in' (on its way / on the board) or 'done' (back)
$.testichUses = function() {
    if (!$.isHost()) return $.testichSeen;
    var d = $.coopData();
    if (!d.testich) d.testich = {};
    return d.testich;
};

$.testichSpent = function(name) {
    return !!name && !!$.testichUses()[name];
};

$.testichTell = function() {
    var s = $.testichUses();
    $.clients.forEach(function(c) { c.send({ t: 'testich', s: s, me: c.name }); });
};
$.guestHandlers.testich = function(msg) {
    $.testichSeen = Object.assign({}, msg.s || {});
    $.testichMe = String(msg.me || '');
};

$.testichMark = function(name, st, why) {
    var uses = $.testichUses();
    if (!name || uses[name] === st || (st === 'done' && uses[name] !== 'in')) return;
    uses[name] = st;
    $.dlog("Tes'tich table:", name, st === 'in' ? 'uses it' : 'is back from the board', '(' + why + ')');
    $.testichTell();
};

// A player back in the game is not on the board (its trip there is over).
var _sendAssignTestich = $.sendAssign;
$.sendAssign = function(conn, actorId) {
    _sendAssignTestich(conn, actorId);
    if (!$.isHost() || !$.coopData().testich) return;
    if (conn.name && $.coopData().testich[conn.name] === 'in') $.testichMark(conn.name, 'done', 'back in the game');
    conn.send({ t: 'testich', s: $.coopData().testich, me: conn.name });
};

// Every PC: no crush from the board's way out in co-op. The host: who used it
// (its own event or a guest's event on its map) and who is back.
var _varSetTestich = Game_Variables.prototype.setValue;
Game_Variables.prototype.setValue = function(id, value) {
    var T = $.TESTICH, mapId = $gameMap ? $gameMap.mapId() : 0;
    if (id === T.crush && this === $gameVariables && $.role && mapId === T.board && Number(value) > 0 &&
            !$.testichCrushing) {
        $.dlog("Tes'tich table: the crush waits for the last player back from the board");
        return;
    }
    _varSetTestich.call(this, id, value);
    if (id !== T.use || this !== $gameVariables || !$.role || !$.testichHard()) return;
    var st = Number(value) === 1 && mapId === T.map ? 'in' : !Number(value) && mapId === T.board && !$.ctx ? 'done' : '';
    if (!st) return;
    if ($.isHost()) {
        $.testichMark($.ctx ? $.ctx.name : $.nameOf('host'), st, st === 'in' ? 'its event' : 'its way out');
    } else if ($.conn) {
        // a roaming guest's own map; a sub-host's: maybe the event of a guest
        // it runs (not the sub-host's own use - its world writes would say so)
        $.conn.send({ t: 'testichUse', st: st, who: $.ctx && $.ctx._sub ? $.ctx.guestId : null });
    }
};

$.hostHandlers.testichUse = function(conn, msg) {
    if (!conn || !msg || !$.testichHard()) return;
    var c = conn;
    if (msg.who) {
        c = $.clientById(msg.who);
        if (!c || c.subOf !== conn.guestId) return;
    }
    if (msg.st === 'in' || msg.st === 'done') $.testichMark(c.name, msg.st, msg.who ? 'on the map of ' + conn.name : 'its map');
};

// On the board: no other player's trip values.
var _applyWorldDeltaTrip = $.applyWorldDelta;
$.applyWorldDelta = function(d, pending, persist) {
    if (d && d.v && $.role && $gameMap && $gameMap.mapId() === $.TESTICH.board &&
            Object.keys(d.v).some(function(k) { return $.TRIP_VARS[k]; })) {
        var v = {};
        Object.keys(d.v).forEach(function(k) { if (!$.TRIP_VARS[k]) v[k] = d.v[k]; });
        d = Object.assign({}, d, { v: v });
    }
    return _applyWorldDeltaTrip(d, pending, persist);
};

// The host: every living player has used it and is back - the crush.
$.testichCheck = function() {
    if (!$.isHost() || !$gameVariables || !$.testichHard() || $gameVariables.value($.TESTICH.crush) > 0) return false;
    var uses = $.coopData().testich;
    if (!uses || !Object.keys(uses).length) return false;
    var ids = ['host'].concat($.activeGuests().map(function(c) { return c.guestId; }));
    var names = ids.filter(function(id) { return !$.isDead(id); }).map($.nameOf);
    if (!names.length || names.some(function(n) { return uses[n] !== 'done'; })) return false;
    $.testichCrushing = true;
    try {
        $gameVariables.setValue($.TESTICH.crush, 1);
    } finally {
        $.testichCrushing = false;
    }
    $.dlog("Tes'tich table: everyone has used it and is back - the Gull Bros come for it");
    return true;
};
$.worldExtras.push(function() {
    if (Graphics.frameCount % 10 === 0) $.testichCheck();
});

// "Use hexen": the answer whose branch sets V2592 to 1 (-1: not the table's).
$.testichAnswer = function(interp, list, at) {
    var T = $.TESTICH, c = list && list[at];
    if (!$.role || !c || c.code !== 102 || !$gameMap || $gameMap.mapId() !== T.map || interp._eventId !== T.ev ||
            !$.testichHard()) return -1;
    var ans = -1;
    for (var i = at + 1; i < list.length && list[i].indent >= c.indent; i++) {
        var x = list[i];
        if (x.indent === c.indent) {
            if (x.code !== 402) break;
            ans = x.parameters[0];
        } else if (x.code === 122 && x.parameters[0] <= T.use && T.use <= x.parameters[1] && x.parameters[3] === 0 &&
                x.parameters[4] === 1) {
            return ans;
        }
    }
    return -1;
};

// its own event (the host's, a roaming guest's)
var _setupChoicesTestich = Game_Interpreter.prototype.setupChoices;
Game_Interpreter.prototype.setupChoices = function(params) {
    var n = this._fhOwner ? -1 : $.testichAnswer(this, this._list, this._index);
    _setupChoicesTestich.call(this, params);
    if (n >= 0 && $.testichSpent($.isHost() ? $.nameOf('host') : $.testichMe || $.myName) && $gameMessage.isChoice() &&
            $gameMessage.disableChoice) $gameMessage.disableChoice(n, true);
};

// a guest's event on the host's map: its choice goes to its screen
var _fhRemoteMessageTestich = Game_Interpreter.prototype.fhRemoteMessage;
Game_Interpreter.prototype.fhRemoteMessage = function(withText) {
    if (this._fhOwner && $.ctx && this._list) {
        var at = this._index;
        if (withText) {
            at++;
            while (this._list[at] && this._list[at].code === 401) at++;
        }
        var n = $.testichAnswer(this, this._list, at);
        if (n >= 0 && $.testichSpent($.ctx.name)) $.choiceModsOf().dis[n] = true;
    }
    return _fhRemoteMessageTestich.call(this, withText);
};

//=============================================================================
// Magna-medicinal on a dead player's body (co-op only, user 2026-11-06)
//=============================================================================
// Original (data): skill 368 Magna-medicinal (Map031 EV115: the Hexen board,
// Daan's area; 677 is Daan's own from the character history) - in a fight,
// 50 mind, CE494 "What do you want to sacrifice to resurrect \N[x]?" -
// Sacrifice an arm / a leg / Nevermind (an option greyed out when the caster
// has lost both: its <name>_arm2 / _leg2 switch), then the dead member is up
// with 21 HP (311 +20, 313 off Knockout) and the caster loses that limb
// (CE495 / CE496 add state 3 / 14 to the caster by its SELECT switch, CE240
// does the rest).
// Co-op (user 2026-11-06): a living player who learned it on the Hexen board
// (368, not Daan's 677) can bring back a dead player at that player's body,
// at any time: 50 mind, a soul stone, a contestant's head (any of the
// fourteen) and its own arm or leg (its choice, as in CE494). Only a
// player who died on its own: its body is the companion's ("Here lies ...",
// 'plain'), not a duel's (a kill at mind 0, the tower), not headless, not
// moonscorched (no body). Not once the tower door was touched (the vote, the
// duels, the door open). Its player must be in the game. Keys someone took
// from the body stay taken. The world values its death changed go back: its
// <name>1 switch (dead) off, V201 CHARACTERS_LEFT +1. It is up where its
// body lay, with 21 HP.
$.MAGNA_SKILL = 368;
$.MAGNA_MIND = 50;
$.MAGNA_HP = 21;
$.MAGNA_CE = 494;
$.MAGNA_HEADS = [293, 296, 288, 277, 298, 279, 278, 292, 309, 302, 275, 289, 282, 283]; // the 14 contestants
$.MAGNA_TEXT = {
    cost: 'Magna-medicinal: 50 mind, a soul stone and a contestant\'s head.',
    ask: 'What do you want to sacrifice to resurrect \\N[%1]?',
    need: 'To resurrect \\N[%1] with Magna-medicinal you need 50 mind, a soul stone and a contestant\'s head.',
    limbs: 'You have no arm or leg left to sacrifice.',
    head: 'Without a head, \\N[%1] cannot be brought back.',
    tower: 'It is too late to bring \\N[%1] back.',
    away: '\\N[%1]\'s player is not in the game.',
    done: '%1 brought %2 back with Magna-medicinal.',
    free: 'Resurrect \\N[%1] with Magna-medicinal?',
    yes: 'Resurrect'
};
// Mod Settings "Bringing back the dead": no cost (the skill still needed).
$.magnaFree = function() {
    return !!$.coopSetting && !!$.coopSetting('magnaFree');
};
$.magnaOk = {}; // a guest: body number -> '' (can be brought back) or why not (from the host)

$.magnaTowerOver = function() {
    return !!$.tourney || !!$.coopData().towerTouched || !!($gameSwitches && $gameSwitches.value($.INHERIT_SWITCH));
};

// The tower door touched: the vote, the duels.
var _towerDropOfflineMagna = $.towerDropOffline;
$.towerDropOffline = function() {
    if ($.isHost()) $.coopData().towerTouched = true;
    return _towerDropOfflineMagna.apply(this, arguments);
};
var _startTourneyMagna = $.startTourney;
$.startTourney = function(ids) {
    if ($.isHost()) $.coopData().towerTouched = true;
    return _startTourneyMagna.apply(this, arguments);
};

// Host: the player id of a name (null: not in the game now).
$.idOfName = function(name) {
    if (name === $.nameOf('host')) return 'host';
    var c = $.activeGuests().filter(function(x) { return x.name === name; })[0];
    return c ? c.guestId : null;
};

// Host: why that body's player cannot be brought back ('' : it can).
$.magnaWhyNot = function(rec) {
    if (!rec || rec.kind !== 'plain') return 'kind';
    var name = $.nameOfActor(rec.a);
    if (!name || !$.coopDead()[name]) return 'kind';
    if ($.duelDead()[rec.a]) return 'kind';
    var actor = $gameActors.actor(rec.a), doom = actor && actor._fhDoom;
    if (doom === 'moonscorch') return 'kind';
    if (doom === 'headless') return 'head';
    if ($.magnaTowerOver()) return 'tower';
    if (!$.idOfName(name)) return 'away';
    return '';
};

$.magnaList = function() {
    var out = {};
    $.corpses().forEach(function(r) { if (r.kind === 'plain' && r.n) out[r.n] = $.magnaWhyNot(r); });
    return out;
};

$.magnaTell = function(force) {
    var list = $.magnaList(), key = JSON.stringify(list);
    if (!force && key === $.magnaSentKey) return;
    $.magnaSentKey = key;
    $.clients.forEach(function(c) { c.send({ t: 'magnaOk', s: list }); });
};
$.magnaSentKey = '';
$.guestHandlers.magnaOk = function(msg) {
    $.magnaOk = Object.assign({}, msg.s || {});
};
$.worldExtras.push(function() {
    if (Graphics.frameCount % 30 === 0 && $.clients.length) $.magnaTell(false);
});
var _sendAssignMagna = $.sendAssign;
$.sendAssign = function(conn, actorId) {
    _sendAssignMagna(conn, actorId);
    if ($.isHost()) conn.send({ t: 'magnaOk', s: $.magnaList() });
};

// Who runs this body's event: its actor, whether it can do it at all.
$.magnaRunner = function() {
    if ($.isHost()) {
        var id = $.ctx ? $.ctx.guestId : 'host';
        return { id: id, name: $.nameOf(id), actor: $.ctx ? $gameActors.actor($.ctx.actorId) : $gameActors.actor($.realHostActorId()),
            up: !$.isDead(id) && !$.isDown(id) };
    }
    if ($.ctx && $.ctx._sub) {
        return { id: $.ctx.guestId, actor: $gameActors.actor($.ctx.actorId), up: !$.ctx.dead && !$.ctx.down };
    }
    return { id: $.myId, actor: $gameActors.actor($.myActorId), up: !$.isGhostMe() && !$.isDownMe() };
};

$.magnaHead = function() {
    return $.MAGNA_HEADS.filter(function(id) { return $dataItems[id] && $gameParty.numItems($dataItems[id]) > 0; })[0] || 0;
};

// The limbs it can give: [arm, leg].
$.magnaLimbs = function(actor) {
    var sw = actor && $.LIMB_SWITCHES[actor.actorId()];
    if (!sw) return [false, false];
    return [!$gameSwitches.value(sw[1]), !$gameSwitches.value(sw[3])];
};

// Its body's event: what to show ('' nothing, 'ask', 'need', 'limbs',
// 'head', 'tower', 'away').
$.magnaCheck = function(interp) {
    interp._fhMagna = null;
    if (!$.role || !$.sessionActive || !$.sessionActive()) return '';
    var rec = $.bodyRecord(interp._eventId, interp._mapId);
    var who = rec && rec.kind === 'plain' ? $.magnaRunner() : null;
    if (!who || !who.up || !who.actor || !who.actor.isLearnedSkill($.MAGNA_SKILL)) return '';
    var why = $.isHost() ? $.magnaWhyNot(rec) : $.magnaOk[rec.n];
    if (why === undefined || why === 'kind') return '';
    var st = why;
    if (!st && $.magnaFree()) {
        st = 'free'; // (Mod Settings: no cost)
    } else if (!st) {
        var limbs = $.magnaLimbs(who.actor);
        if (who.actor.mp < $.MAGNA_MIND || $gameParty.numItems($dataItems[$.SOUL_STONE_ITEM]) < 1 || !$.magnaHead()) st = 'need';
        else if (!limbs[0] && !limbs[1]) st = 'limbs';
        else st = 'ask';
    }
    interp._fhMagna = { st: st, n: rec.n, a: rec.a, who: who.id };
    return st;
};

$.magnaIs = function(interp, st) {
    return !!interp._fhMagna && interp._fhMagna.st === st;
};

// Before the question: the options it has no limb for.
$.magnaGrey = function(interp) {
    var who = $.magnaRunner(), limbs = $.magnaLimbs(who && who.actor);
    if (!$gameMessage.disableChoice) return;
    if (!limbs[0]) $gameMessage.disableChoice(0, true);
    if (!limbs[1]) $gameMessage.disableChoice(1, true);
};

// Its choice: the costs (the limb goes with the original's CE495 / CE496 and
// CE240 after this). false: not any more - nothing happens.
$.magnaPay = function(interp, limb) {
    var m = interp._fhMagna;
    if (!m || $.magnaCheck(interp) !== 'ask' || !$.magnaLimbs($.magnaRunner().actor)[limb === 'arm' ? 0 : 1]) {
        $.dlog('Magna-medicinal: not any more');
        return false;
    }
    var who = $.magnaRunner(), head = $.magnaHead();
    who.actor.setMp(who.actor.mp - $.MAGNA_MIND);
    $gameParty.loseItem($dataItems[$.SOUL_STONE_ITEM], 1);
    $gameParty.loseItem($dataItems[head], 1);
    $.dlog('Magna-medicinal by', who.actor.name(), ': 50 mind, a soul stone,', $dataItems[head].name + ', an', limb);
    return true;
};

// Its yes with no cost (Mod Settings): still so? false - nothing happens.
$.magnaPayFree = function(interp) {
    if (!interp._fhMagna || $.magnaCheck(interp) !== 'free') {
        $.dlog('Magna-medicinal: not any more');
        return false;
    }
    $.dlog('Magna-medicinal by', $.magnaRunner().actor.name(), ': no cost (Mod Settings)');
    return true;
};

// The scene is over: the host brings that player back.
$.magnaFinish = function(interp) {
    var m = interp._fhMagna;
    interp._fhMagna = null;
    if (!m) return;
    if ($.isHost()) $.magnaRevive(m.n, m.who);
    else if ($.conn) $.conn.send({ t: 'magnaRevive', n: m.n, who: $.ctx && $.ctx._sub ? $.ctx.guestId : null });
};

$.hostHandlers.magnaRevive = function(conn, msg) {
    if (!conn || !msg) return;
    var by = conn.guestId;
    if (msg.who) {
        var c = $.clientById(msg.who);
        if (!c || c.subOf !== conn.guestId) return;
        by = c.guestId;
    }
    $.magnaRevive(Number(msg.n), by);
};

// Host: that body's player is up again, where the body lay.
$.magnaRevive = function(n, byId) {
    var list = $.corpses();
    var rec = list.filter(function(r) { return r.n === n; })[0];
    var why = $.magnaWhyNot(rec);
    if (!rec || why) {
        $.dlog('Magna-medicinal: body', n, 'cannot be brought back (' + (why || 'gone') + ')');
        return false;
    }
    var name = $.nameOfActor(rec.a), id = $.idOfName(name);
    delete $.coopDead()[name];
    var sw = $.DEATH_SWITCH[rec.a];
    if (sw && $gameSwitches.value(sw)) {
        $gameSwitches.setValue(sw, false);
        $gameVariables.setValue($.CHARACTERS_LEFT_VAR, $gameVariables.value($.CHARACTERS_LEFT_VAR) + 1);
    }
    var data = $.coopData();
    if (data.keysTaken) delete data.keysTaken[name]; // (the keys taken are not given back)
    var actor = $gameActors.actor(rec.a);
    if (actor) {
        actor.removeState($.KNOCKOUT);
        actor._fhDoom = null;
        actor._fhDownStates = null;
        actor.setHp($.MAGNA_HP);
    }
    list.splice(list.indexOf(rec), 1);
    var stamp = data.corpsesStamp = $.corpseStamp();
    $.clients.forEach(function(c) { c.send({ t: 'corpses', list: list, stamp: stamp }); });
    $.bodyDropGone();
    $.dlog('Magna-medicinal:', name, 'is up again at', rec.m, rec.x + ',' + rec.y, 'by', $.playerLabel(byId));
    $.magnaPlace(id, rec);
    $.broadcastState(id);
    $.magnaTell(true);
    $.broadcastToast($.MAGNA_TEXT.done.replace('%1', $.playerLabel(byId)).replace('%2', $.playerLabel(id)));
    return true;
};

// Where its body lay.
$.magnaPlace = function(id, rec) {
    if (id === 'host') {
        if ($gameMap.mapId() === rec.m) $gamePlayer.locate(rec.x, rec.y);
        else $gamePlayer.reserveTransfer(rec.m, rec.x, rec.y, 2, 0);
        $gamePlayer.refresh();
        return;
    }
    var conn = $.clientById(id);
    if (!conn) return;
    var spot = { m: rec.m, x: rec.x, y: rec.y, d: 2 };
    conn._lastMeKey = null;
    if (!conn.roam && !conn.subOf && rec.m === $gameMap.mapId()) {
        $.pushMe(conn);
        conn.send({ t: 'place', x: rec.x, y: rec.y, d: 2 });
        var remote = $.remotes[id];
        if (remote) remote.setPosition(rec.x, rec.y);
        conn.lastPos = Object.assign({}, conn.lastPos || {}, spot);
    } else {
        if (conn.subOf && $.detachSub) $.detachSub(conn);
        $.sendRoam(conn, { pos: spot });
        conn.lastPos = Object.assign({}, conn.lastPos || {}, spot);
        $.pushMe(conn);
    }
};

// Bodies gone from the list: off this map now (erased), out of it (its event
// and data) once nothing runs it any more - the revive runs in that body's
// own event, which still needs its page to end.
$.bodyGone = {}; // event id -> map id
$.bodyDropGone = function() {
    if (!$gameMap || !$dataMap || !$dataMap.events) return;
    var have = {};
    $.corpses().forEach(function(r) { if (r.m === $gameMap.mapId() && r.id) have[r.id] = r.n; });
    $gameMap._events.forEach(function(ev, id) {
        var data = ev && $dataMap.events[id];
        if (!data || data._fhBody === undefined || have[id] === data._fhBody || $.bodyGone[id]) return;
        ev.erase();
        $.bodyGone[id] = $gameMap.mapId();
        $.dlog('body', data._fhBody, 'is gone from this map');
    });
};

$.bodyRunning = function(id) {
    var main = $gameMap._interpreter;
    if (main && main.isRunning() && main.eventId() === id) return true;
    return Object.keys($.owned || {}).some(function(k) {
        var o = $.owned[k], it = o && o.interp;
        return !!it && it.isRunning() && it._eventId === id && it._mapId === $gameMap.mapId();
    });
};

$.bodyGoneSweep = function() {
    var ids = Object.keys($.bodyGone);
    if (!ids.length || !$gameMap) return;
    ids.forEach(function(k) {
        var id = Number(k);
        if ($.bodyGone[k] !== $gameMap.mapId()) {
            delete $.bodyGone[k]; // (another map's data: gone with that map)
            return;
        }
        if ($.bodyRunning(id)) return;
        delete $.bodyGone[k];
        var data = $dataMap && $dataMap.events[id];
        if (data && data._fhBody !== undefined) delete $dataMap.events[id];
        delete $gameMap._events[id];
    });
};
$.worldExtras.push(function() { $.bodyGoneSweep(); });
$.guestExtras.push(function() { $.bodyGoneSweep(); });

var _corpsesGone = $.guestHandlers.corpses;
$.guestHandlers.corpses = function(msg) {
    _corpsesGone(msg);
    if ($gameSystem) $.bodyDropGone();
};

// The companion body's page: the question before its keys.
var _bodyPlainPagesMagna = $.bodyPlainPages;
$.bodyPlainPages = function(actorId) {
    var pages = _bodyPlainPagesMagna(actorId);
    if (!pages) return pages;
    var list = pages[0].list, at = list.length - 2; // (before the keys and the end)
    Array.prototype.splice.apply(list, [at, 0].concat($.magnaCommands(actorId)));
    return pages;
};

$.magnaCommands = function(actorId) {
    var cmd = function(code, indent, params) { return { code: code, indent: indent, parameters: params }; };
    var line = function(key, indent) {
        return [cmd(101, indent, ['', 0, 0, 2]), cmd(401, indent, [$.MAGNA_TEXT[key].replace('%1', actorId)])];
    };
    var out = [cmd(355, 0, ['FH.Coop.magnaCheck(this);'])];
    ['need', 'limbs', 'head', 'tower', 'away'].forEach(function(st) {
        out.push(cmd(111, 0, [12, "FH.Coop.magnaIs(this, '" + st + "')"]));
        out = out.concat(line(st, 1), [cmd(0, 1, []), cmd(412, 0, [])]);
    });
    out.push(cmd(111, 0, [12, "FH.Coop.magnaIs(this, 'ask')"]));
    out.push(cmd(355, 1, ['FH.Coop.magnaGrey(this);']));
    out.push(cmd(101, 1, ['', 0, 0, 2]), cmd(401, 1, [$.MAGNA_TEXT.cost]),
        cmd(401, 1, [$.MAGNA_TEXT.ask.replace('%1', actorId)]));
    out.push(cmd(102, 1, [['Sacrifice an arm', 'Sacrifice a leg', 'Nevermind'], 2, 0, 2, 0]));
    var scene = $.magnaScenes();
    ['arm', 'leg'].forEach(function(limb, i) {
        out.push(cmd(402, 1, [i, i ? 'Sacrifice a leg' : 'Sacrifice an arm']));
        out.push(cmd(111, 2, [12, "FH.Coop.magnaPay(this, '" + limb + "')"]));
        (scene[i] || []).forEach(function(c) { out.push(cmd(c.code, c.indent - scene.base + 3, $.bodyCopy(c.parameters))); });
        out.push(cmd(355, 3, ['FH.Coop.magnaFinish(this);']), cmd(0, 3, []), cmd(412, 2, []), cmd(0, 2, []));
    });
    out.push(cmd(402, 1, [2, 'Nevermind']), cmd(0, 2, []), cmd(404, 1, []), cmd(0, 1, []), cmd(412, 0, []));
    // no cost (Mod Settings): a yes, no limb scene
    out.push(cmd(111, 0, [12, "FH.Coop.magnaIs(this, 'free')"]));
    out.push(cmd(101, 1, ['', 0, 0, 2]), cmd(401, 1, [$.MAGNA_TEXT.free.replace('%1', actorId)]));
    out.push(cmd(102, 1, [[$.MAGNA_TEXT.yes, 'Nevermind'], 1, 0, 2, 0]));
    out.push(cmd(402, 1, [0, $.MAGNA_TEXT.yes]));
    out.push(cmd(111, 2, [12, 'FH.Coop.magnaPayFree(this)']));
    out.push(cmd(355, 3, ['FH.Coop.magnaFinish(this);']), cmd(0, 3, []), cmd(412, 2, []), cmd(0, 2, []));
    out.push(cmd(402, 1, [1, 'Nevermind']), cmd(0, 2, []), cmd(404, 1, []), cmd(0, 1, []), cmd(412, 0, []));
    return out;
};

// The original's two answers (CE494, its first question): the sounds, the
// dark, the limb (CE495 / CE496, CE240) - not its revive of that party
// member (311 / 313: the host does it).
$.magnaScenes = function() {
    if ($.magnaScenesCache) return $.magnaScenesCache;
    var ce = $dataCommonEvents && $dataCommonEvents[$.MAGNA_CE], list = ce ? ce.list : [];
    var box = list.findIndex(function(c) { return c.code === 102; });
    var out = [];
    out.base = box >= 0 ? list[box].indent + 1 : 0;
    if (box < 0) return out;
    var ind = list[box].indent;
    for (var i = box + 1; i < list.length && list[i].indent >= ind; i++) {
        var c = list[i];
        if (c.indent === ind && c.code === 404) break;
        if (c.indent === ind && c.code === 402) {
            out[c.parameters[0]] = [];
            continue;
        }
        var cur = out[out.length - 1];
        if (!cur || c.indent === ind + 1 && c.code === 0) continue;
        if (c.code === 311 || c.code === 313 && c.parameters[3] === $.KNOCKOUT) continue;
        cur.push(c);
    }
    out.length = Math.min(out.length, 2);
    $.magnaScenesCache = out;
    return out;
};

//=============================================================================
// Co-op Settings (the menu, user 2026-11-06) - "Mod Settings" since 2026-11-08
// (with the ATB ones, which count in a solo game too: coop: true marks the
// co-op only ones)
//=============================================================================
// A menu entry "Co-op Settings" in a shared game. Only the host changes them
// (a guest sees them); they are kept in the host's save
// (coopData().settings) and go to every guest (a join, a load, a change).
// - soulsShared (user: "players will fight over who owns a soul"): off - a
//   dead contestant's soul is the player's who got it ("Absorb / Give to",
//   only its board opens that area, as before); on - nobody is asked, every
//   player's Hexen board opens it. The souls of characters players play stay
//   theirs either way.
$.COOP_SETTINGS = [
    // (Everyone by default, user 2026-11-07: "players will fight over souls")
    { key: 'soulsShared', label: 'Contestant souls (Hexen)', off: 'Owner only', on: 'Everyone', def: true, coop: true,
        help: ['Owner only: the player who got a soul (or was given it) opens its Hexen area.',
            'Everyone: a soul opens its Hexen area on every player\'s board, nobody is asked.'] },
    // (user 2026-11-10: "a setting that takes away the cost of bringing back a dead
    // player's body - the Hexen skill still needed") Magna-medicinal at a dead player's
    // body: off - 50 mind, a soul stone, a contestant's head and an arm or leg; on - no
    // cost, the skill (368, learned on the Hexen board) still needed.
    { key: 'magnaFree', label: 'Bringing back the dead (Magna-medicinal)', off: 'Cost', on: 'No cost', coop: true,
        help: ['Cost: at a dead player\'s body, 50 mind, a soul stone, a contestant\'s head and your arm or leg.',
            'No cost: only Magna-medicinal learned on the Hexen board is needed.'] },
    { key: 'doubleFinds', label: 'Consumables found', off: 'Normal', on: 'Double', coop: true,
        help: ['Double: enemy drops and items picked up on the map count twice -',
            'healing items and food only: no weapons, armor, ammo, bombs, traps, buffs, keys or soul stones.'] },
    // (user 2026-11-07: "put save in the options too, keep it on for now";
    // F9 load the same day) F8 / F9: the save / load screen anywhere on the
    // map (FH_Coop.js); off - the host saves and loads the original way only.
    // On unless the host turns it off.
    // (user 2026-11-08: not co-op only - "it works in solo too, many want
    // to save and load": a solo game follows it as well)
    { key: 'quickSave', label: 'F8 save / F9 load', off: 'Off', on: 'On', def: true,
        help: ['On: F8 / F9 on the map (not during an event or message) open the save / load screen - in co-op for the host only.',
            'Off: saving and loading only the original way.'] },
    // ATB (user 2026-11-08: "Mod Settings", not co-op only - solo games too;
    // in co-op the host's, like the others). Read by FH_ATB (FH.Coop.coopSettingValue).
    // atbWaitTurn: a player choosing a command stops every gauge (the time
    // stop's way, also for a joiner choosing on its PC).
    { key: 'atbWaitTurn', label: 'Time stops on your turn (ATB)', off: 'Off', on: 'On',
        help: ['On: when a player\'s turn comes, every gauge stops until that player has chosen.',
            'Off: time keeps running while you choose (the enemies only slow down for a moment).'] },
    // atbTurnCap: 0 (no limit) or 2-10 player turns per enemy turn at most.
    { key: 'atbTurnCap', label: 'Most player turns per enemy turn (ATB)', type: 'num', min: 2, max: 10, off: 'No limit',
        help: ['A player acts at most this many times per enemy turn, however fast it is (2 - 10).',
            'No limit: speed alone decides. Left / right to change.'] }
];
$.coopSettingsSeen = {}; // a guest: the host's

$.coopSettingItem = function(key) {
    return $.COOP_SETTINGS.filter(function(x) { return x.key === key; })[0];
};
// A stored value as that setting's kind: on / off, or a number in its range
// (anything else: 0, no limit).
$.coopSettingNorm = function(item, v) {
    if (item.type === 'num') {
        v = Math.floor(Number(v));
        return v >= item.min && v <= item.max ? v : 0;
    }
    return !!v;
};
$.coopSettingText = function(item, v) {
    if (item.type === 'num') return v ? String(v) : item.off;
    return v ? item.on : item.off;
};
// The value after this one (OK, right) or before it (left): on / off, or
// no limit, min ... max, no limit again.
$.coopSettingNext = function(item, v, dir) {
    if (item.type !== 'num') return !v;
    var list = [0];
    for (var n = item.min; n <= item.max; n++) list.push(n);
    var i = Math.max(0, list.indexOf($.coopSettingNorm(item, v)));
    return list[(i + (dir < 0 ? -1 : 1) + list.length) % list.length];
};

$.coopSettingsData = function() {
    if (!$.isHost()) return $.coopSettingsSeen;
    var d = $.coopData();
    if (!d.settings) d.settings = {};
    return d.settings;
};

// This PC's own choices (the title's Co-op Settings, user 2026-11-08: "under
// Co-op Join, easy to find"): kept in config.rpgsave, for every game this PC
// hosts. A change in a game's menu is kept there too, so the title shows the
// last choice; a game hosted on a PC with no choice of its own uses its save's.
$.coopSettingsPref = function() {
    if (!ConfigManager.fhCoopSettings || typeof ConfigManager.fhCoopSettings !== 'object') ConfigManager.fhCoopSettings = {};
    return ConfigManager.fhCoopSettings;
};
var _configMakeDataSettings = ConfigManager.makeData;
ConfigManager.makeData = function() {
    var config = _configMakeDataSettings.call(this);
    config.fhCoopSettings = Object.assign({}, $.coopSettingsPref());
    return config;
};
var _configApplyDataSettings = ConfigManager.applyData;
ConfigManager.applyData = function(config) {
    _configApplyDataSettings.call(this, config);
    var s = config && config.fhCoopSettings;
    this.fhCoopSettings = {};
    if (s && typeof s === 'object') {
        $.COOP_SETTINGS.forEach(function(item) {
            if (typeof s[item.key] === (item.type === 'num' ? 'number' : 'boolean')) {
                this.fhCoopSettings[item.key] = $.coopSettingNorm(item, s[item.key]);
            }
        }, this);
    }
};

// Who may change them: the host, or anyone on the title (not in a session).
$.canEditCoopSettings = function() {
    return !$.role || $.isHost();
};

// A setting's value: a guest - the host's; the host (or the title, or a solo
// game) - this PC's choice, else the save's, else its default (def).
$.coopSettingValue = function(key) {
    var item = $.coopSettingItem(key);
    if (!item) return false;
    var pref = $.isGuest() ? undefined : $.coopSettingsPref()[key];
    var v = pref !== undefined ? pref : (!$.role ? undefined : $.coopSettingsData()[key]);
    return $.coopSettingNorm(item, v === undefined ? item.def : v);
};
$.coopSettingOn = function(key) {
    return !!$.coopSettingValue(key);
};

$.coopSetting = function(key) {
    return !!$.role && !!($gameSystem || $.isGuest()) && $.coopSettingOn(key);
};

$.sendCoopSettings = function(conn) {
    // (the values in use: this PC's choice over the save's)
    var now = {};
    $.COOP_SETTINGS.forEach(function(item) { now[item.key] = $.coopSettingValue(item.key); });
    var msg = { t: 'coopSettings', s: now };
    if (conn) conn.send(msg);
    else $.clients.forEach(function(c) { c.send(msg); });
};

$.guestHandlers.coopSettings = function(msg) {
    if ($.isHost()) return;
    var was = JSON.stringify($.coopSettingsSeen);
    $.coopSettingsSeen = Object.assign({}, (msg && msg.s) || {});
    if (was !== JSON.stringify($.coopSettingsSeen)) $.dlog('co-op settings from the host:', JSON.stringify($.coopSettingsSeen));
};

$.setCoopSetting = function(key, value) {
    if (!$.canEditCoopSettings()) return;
    var item = $.coopSettingItem(key);
    if (!item) return;
    value = $.coopSettingNorm(item, value);
    $.coopSettingsPref()[key] = value;
    try { ConfigManager.save(); } catch (e) { $.dlog('ERROR co-op settings: config not saved', e && e.message); }
    if (!$.role) {
        $.dlog('mod setting (title / solo)', key, '=', value);
        return;
    }
    $.coopSettingsData()[key] = value;
    $.dlog('co-op setting', key, '=', value);
    $.sendCoopSettings(null);
    $.broadcastToast('the host set ' + item.label + ': ' + $.coopSettingText(item, value) + '.');
};

var _sendAssignSettings = $.sendAssign;
$.sendAssign = function(conn, actorId) {
    _sendAssignSettings(conn, actorId);
    if ($.isHost()) $.sendCoopSettings(conn);
};
var _sendSnapshotSettings = $.sendSnapshot;
$.sendSnapshot = function(conn) {
    var out = _sendSnapshotSettings.apply(this, arguments);
    if ($.isHost() && $gameSystem && conn) $.sendCoopSettings(conn);
    return out;
};

var _makeMenuCommandListSettings = Window_MenuCommand.prototype.makeCommandList;
Window_MenuCommand.prototype.makeCommandList = function() {
    _makeMenuCommandListSettings.call(this);
    // (user 2026-11-08: "Mod Settings" - the ATB ones count in a solo game too)
    if (this.findSymbol('fhCoopSettings') < 0) this.addCommand('Mod Settings', 'fhCoopSettings', true);
};
var _createCommandWindowSettings = Scene_Menu.prototype.createCommandWindow;
Scene_Menu.prototype.createCommandWindow = function() {
    _createCommandWindowSettings.call(this);
    this._commandWindow.setHandler('fhCoopSettings', function() { SceneManager.push(Scene_FHCoopSettings); });
};

function Window_FHCoopSettings() {
    this.initialize.apply(this, arguments);
}
Window_FHCoopSettings.prototype = Object.create(Window_Command.prototype);
Window_FHCoopSettings.prototype.constructor = Window_FHCoopSettings;
Window_FHCoopSettings.prototype.windowWidth = function() {
    return Graphics.boxWidth;
};
Window_FHCoopSettings.prototype.makeCommandList = function() {
    $.COOP_SETTINGS.forEach(function(item) {
        this.addCommand(item.label + ':  ' + $.coopSettingText(item, $.coopSettingValue(item.key)), item.key,
            $.canEditCoopSettings());
    }, this);
};
// Left / right change the value under the cursor (a number a step, on / off
// flips), as in the original Options.
Window_FHCoopSettings.prototype.fhStep = function(dir) {
    var item = $.COOP_SETTINGS[this.index()];
    if (!item || !$.canEditCoopSettings()) return;
    $.setCoopSetting(item.key, $.coopSettingNext(item, $.coopSettingValue(item.key), dir));
    SoundManager.playCursor();
    this.refresh();
};
Window_FHCoopSettings.prototype.cursorRight = function() {
    this.fhStep(1);
};
Window_FHCoopSettings.prototype.cursorLeft = function() {
    this.fhStep(-1);
};

function Scene_FHCoopSettings() {
    this.initialize.apply(this, arguments);
}
Scene_FHCoopSettings.prototype = Object.create(Scene_MenuBase.prototype);
Scene_FHCoopSettings.prototype.constructor = Scene_FHCoopSettings;
Scene_FHCoopSettings.prototype.create = function() {
    Scene_MenuBase.prototype.create.call(this);
    this._help = new Window_Help(3);
    this.addWindow(this._help);
    this._list = new Window_FHCoopSettings(0, this._help.height);
    var self = this;
    $.COOP_SETTINGS.forEach(function(item) {
        self._list.setHandler(item.key, function() {
            $.setCoopSetting(item.key, $.coopSettingNext(item, $.coopSettingValue(item.key), 1));
            self._list.refresh();
            self._list.activate();
            self.updateHelp();
        });
    });
    this._list.setHandler('cancel', this.popScene.bind(this));
    this.addWindow(this._list);
    this.updateHelp();
};
Scene_FHCoopSettings.prototype.updateHelp = function() {
    var item = $.COOP_SETTINGS[this._list.index()] || $.COOP_SETTINGS[0];
    var lines = item.help.slice();
    // (no "OK: change it" line - user 2026-11-08: not needed, stiff; a guest
    // is still told why it cannot change them)
    if (!$.canEditCoopSettings()) lines.push('Only the host can change these.');
    else if (item.coop && !$.role) lines.push('Co-op games only.');
    this._help.setText(lines.join('\n'));
};
Scene_FHCoopSettings.prototype.update = function() {
    Scene_MenuBase.prototype.update.call(this);
    if (this._list && this._list.index() !== this._lastIndex) {
        this._lastIndex = this._list.index();
        this.updateHelp();
    }
};
$.Scene_FHCoopSettings = Scene_FHCoopSettings;
$.Window_FHCoopSettings = Window_FHCoopSettings;

// doubleFinds (user 2026-11-06: "even two players are short of supplies in
// hard mode, three or more cannot cope"; "consumables only, no equipment"):
// a consumable item (itype 1, consumed on use) that is not a key (the
// companion body's keys list) or a soul stone. Enemy drops (the PC that runs
// the fight) and a map event's "Change Items +" (the player whose event it
// is: a guest's on the host goes to its bag) - not a common event's
// (crafting, trading, a recipe's result) and not a troop event's.
// Not the ones for a fight either (user, same day: "no ammo, no bombs - what
// hurts or puts a state on enemies"): an item used on enemies (scope 1-6) or
// that deals HP damage (Pipe bomb, the vials, stones, darts, glass shards, the
// poison plants ...), and gun powder (the ammo is no consumable in the data:
// 9mm, 12-gauge, .303 are not counted anyway).
// And only what heals (user, same day: "no buffs either - only the healing
// ones double"): an item counts when it restores Body or Mind, cures a state,
// fills hunger (the FOOD common events) or gives regen - and not when it puts a
// buff on (Brown and Green vial, Pep pills, Heroin, the talismans, the "+"
// dishes). Crafting things with no use of their own (matches, oil, stick,
// flour, red herb ...) are not counted.
$.DOUBLE_FIND_NOT = [247, 76, 104, 200, 149]; // Gun powder, Bear trap, Booby trap, Gasoline canister, Purifying talisman
$.DOUBLE_FIND_BUFFS = [18, 20, 21, 105, 107, 108, 192, 197]; // speed, attack, evasion, heroin, defence, magic def
$.DOUBLE_FIND_HEAL_STATES = [172, 220, 221]; // Condensed green, Regen, Greater regen
$.DOUBLE_FIND_FOOD_CES = [31, 32, 33];
$.doubleFindItem = function(item) {
    if (!item || !DataManager.isItem(item) || item.itypeId !== 1 || !item.consumable) return false;
    if (item.id === $.SOUL_STONE_ITEM || ($.KEY_ITEMS && $.KEY_ITEMS.indexOf(item.id) >= 0)) return false;
    if ($.DOUBLE_FIND_NOT.indexOf(item.id) >= 0) return false;
    var d = item.damage || {};
    if ((item.scope >= 1 && item.scope <= 6) || d.type === 1 || d.type === 5) return false;
    var heals = d.type === 3 || d.type === 4, effects = item.effects || [];
    for (var i = 0; i < effects.length; i++) {
        var e = effects[i];
        if (e.code === 21 && $.DOUBLE_FIND_BUFFS.indexOf(e.dataId) >= 0) return false;
        if (e.code === 31) return false; // add buff
        if (e.code === 11 || e.code === 12 || e.code === 22) heals = true;
        if (e.code === 21 && $.DOUBLE_FIND_HEAL_STATES.indexOf(e.dataId) >= 0) heals = true;
        if (e.code === 44 && $.DOUBLE_FIND_FOOD_CES.indexOf(e.dataId) >= 0) heals = true;
    }
    return heals;
};

var _makeDropItemsDouble = Game_Enemy.prototype.makeDropItems;
Game_Enemy.prototype.makeDropItems = function() {
    var list = _makeDropItemsDouble.call(this);
    if (!$.coopSetting('doubleFinds')) return list;
    var out = [];
    list.forEach(function(item) {
        out.push(item);
        if ($.doubleFindItem(item)) out.push(item);
    });
    return out;
};

$.commonEventList = function(list) {
    if (!list || !$dataCommonEvents) return false;
    if (list._fhCommon !== undefined) return list._fhCommon;
    var found = $dataCommonEvents.some(function(ce) { return !!ce && ce.list === list; });
    try {
        Object.defineProperty(list, '_fhCommon', { value: found, enumerable: false, configurable: true });
    } catch (e) { /* (a frozen list: asked again next time) */ }
    return found;
};

var _command126Double = Game_Interpreter.prototype.command126;
Game_Interpreter.prototype.command126 = function() {
    var p = this._params;
    var item = p && $dataItems[p[0]];
    var twice = !!p && p[1] === 0 && this._eventId > 0 && !$gameParty.inBattle() && $.coopSetting('doubleFinds') &&
        $.doubleFindItem(item) && !$.commonEventList(this._list);
    var out = _command126Double.call(this);
    if (twice) {
        var n = this.operateValue(p[1], p[2], p[3]);
        if (n > 0) {
            $gameParty.gainItem(item, n);
            $.dlog('double finds:', item.name, '+' + n);
        }
    }
    return out;
};

//=============================================================================
// Co-op: no sanity drift while standing still or in a menu (user 2026-11-06)
//=============================================================================
// Original: most maps' parallel EV28 waits 400 frames and calls CE372
// SANITY_OUTSIDE / CE373 _INSIDE / CE374 _ALTERNATIVE, which take 1 mind
// from the party (312, by difficulty: every time in hard mode, every few
// times otherwise). Alone the game stands still in a menu and there is
// little waiting. In co-op the world goes on in a menu and players wait for
// each other ("too hard to keep the mind up"). Now in a co-op game that drift
// (only those common events' Change MP) skips while this PC's player is in a
// menu or has not moved for IDLE_SANITY_MS. Scenes and fights still take
// mind as in the original.
$.SANITY_DRIFT_CES = [372, 373, 374];
$.IDLE_SANITY_MS = 3000;
$.lastMoveAt = 0;
$.lastMoveKey = '';

$.trackPlayerMove = function() {
    var p = $.realPlayer || $gamePlayer;
    if (!p || !$gameMap) return;
    var key = $gameMap.mapId() + ':' + p.x + ',' + p.y;
    if (key !== $.lastMoveKey || p.isMoving()) {
        $.lastMoveKey = key;
        $.lastMoveAt = $.clockMs();
    }
};
var _sceneMapUpdateIdle = Scene_Map.prototype.update;
Scene_Map.prototype.update = function() {
    _sceneMapUpdateIdle.call(this);
    if ($.role) $.trackPlayerMove();
};

$.playerIdle = function() {
    if (!(SceneManager._scene instanceof Scene_Map)) return true; // a menu (the world goes on)
    return $.clockMs() - $.lastMoveAt >= $.IDLE_SANITY_MS;
};

$.isSanityDrift = function(list) {
    return !!list && $.SANITY_DRIFT_CES.some(function(id) {
        return !!$dataCommonEvents[id] && $dataCommonEvents[id].list === list;
    });
};

var _command312Idle = Game_Interpreter.prototype.command312;
Game_Interpreter.prototype.command312 = function() {
    var p = this._params;
    if ($.role && !this._fhOwner && !$.ctx && p[2] === 1 && !$gameParty.inBattle() && $.sessionActive &&
            $.sessionActive() && $.isSanityDrift(this._list) && $.playerIdle()) {
        if (!$.idleSanityLogged || $.clockMs() - $.idleSanityLogged > 60000) {
            $.idleSanityLogged = $.clockMs();
            $.dlog('sanity drift skipped: standing still or in a menu');
        }
        return true;
    }
    return _command312Idle.call(this);
};

//=============================================================================
// The yellow mage's dance turned on by a guest on its own map (FH_CoopWorld)
//=============================================================================
// A guest running its own map turns the dance on there: its world writes come
// as a wDelta (straight into the data, no setValue), so the host did not know
// who - and a guest that lost to Mastermind came back to the host's map with
// the dance on: its Hurting went on the host, a limb every two seconds (play
// test 2026-11-06, Map080).
var _wDeltaYellowMage = $.hostHandlers.wDelta;
$.hostHandlers.wDelta = function(conn, msg) {
    var on = !!(msg && msg.sw && msg.sw[$.YM_DANCE_SWITCH]);
    var was = !!$gameSwitches._data[$.YM_DANCE_SWITCH];
    _wDeltaYellowMage(conn, msg);
    var now = !!$gameSwitches._data[$.YM_DANCE_SWITCH];
    if (on && !was && now && conn && conn.guestId) {
        $.ymTarget = conn.guestId;
        $.dlog('yellow mage: sees', $.playerLabel ? $.playerLabel(conn.guestId) : conn.guestId, 'first (its own map)');
    } else if (was && !now) {
        $.ymTarget = null;
    }
};

//=============================================================================
// A new game, a load, leaving: nothing of the game before (review 0.6.0)
//=============================================================================
// Kept by this PC across games, none of it in the save: a drop-off of the
// game before ran in the next one, an execution, a priest's scene, a floor
// sleep, a soul's question waited there.
$.freshGameState = function(why) {
    $.dropOffs = [];
    $.dropForce = {};
    $.snapPending = null;
    $.snapRun = 0;
    $.priestLost = null;
    $.priestHolds = {};
    $.priestQueue = [];
    $.priestSceneMap = 0;
    $.priestCross = null;
    $.floorSleep = null;
    $.arrivedOn = 0;
    $.soulWait = {};
    $.lastSoulOn = null;
    $.tourneyHold = null;
    $.towerChill = null;
    $.testichSeen = {};
    $.testichMe = '';
    if ($.hostWatch) $.hostWatchStop('a new game or a load');
    $.ewWant = false;
    $.towerReadyNow = false;
    ($.clients || []).forEach(function(c) { c._ghostStay = false; }); // (a new world: everyone in it)
    $.dlog("this PC's state of the game before dropped (" + why + ')');
};

var _setupNewGameFresh = DataManager.setupNewGame;
DataManager.setupNewGame = function() {
    _setupNewGameFresh.call(this);
    $.freshGameState('a new game');
};
var _onLoadSuccessFresh = Scene_Load.prototype.onLoadSuccess;
Scene_Load.prototype.onLoadSuccess = function() {
    $.freshGameState('a save loaded');
    _onLoadSuccessFresh.call(this);
};
var _leaveAsGuestFresh = $.leaveAsGuest;
$.leaveAsGuest = function(message) {
    $.freshGameState('left');
    $.tutorialStartSnap = null; // (its host's tutorial: not the next host's)
    _leaveAsGuestFresh(message);
};

})(FH.Coop);
