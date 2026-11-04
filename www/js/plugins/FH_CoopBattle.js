//=============================================================================
// FH_CoopBattle.js
//=============================================================================
/*:
 * @plugindesc v0.5.13 Co-op battles: battles run on the PC of whoever started
 * them, other players can join, downed players, betrayal duel. Below
 * FH_CoopWorld.
 * @author FH2 Co-op Mod
 *
 * @param Down Seconds
 * @desc Seconds a downed player can be revived before dying.
 * @type number
 * @default 300
 *
 * @param Revive HP Rate
 * @desc HP ratio a revived player gets back.
 * @type number
 * @decimals 2
 * @default 0.25
 *
 * @help
 * Battle authority: a battle runs on the PC of the player who started it.
 * The host sends that PC the current switches, variables and the player's
 * character; the PC runs the original battle (troop events and all) and
 * sends back the result, the character and the switches that changed.
 *
 * Joining: while a battle runs, the enemy that started it stays frozen on
 * the map. Another player who presses OK on it (or on the fighting player)
 * joins: the character is added to that battle's party, its commands are
 * chosen on its own PC, which shows the battle from the authority's data.
 *
 * Down: a lost battle or a game over puts the player down on the map. The
 * others have Down Seconds to revive the player with OK. A guest who is not
 * revived dies until the host loads a save; the host dying ends the game.
 *
 * Betrayal: touching the Hollow Tower door while one other player lives
 * opens a duel against that player's character (its enemy look and body
 * parts, its own stats and skills, chosen by that player).
 */

var FH = FH || {};
FH.Coop = FH.Coop || {};

(function($) {
'use strict';

if (!$.hostHandlers) {
    console.error('FH_CoopBattle needs FH_CoopWorld.js above it.');
    return;
}

var params = PluginManager.parameters('FH_CoopBattle');
$.downFrames = Math.round(Number(params['Down Seconds'] || 300) * 60);
// The down time runs on the clock, in ms (user decision: 300 real seconds,
// 2026-10-31 - 60 was too short to come over from a map or two away).
// Graphics.frameCount counts drawn frames: it runs as fast as the monitor
// (a 144 Hz screen: 2.4 times real time), while the game itself updates 60
// times a second (TDDP_FluidTimestep). A down ran out in about 25 s (play
// test 2026-10-19).
$.downMs = Math.round(Number(params['Down Seconds'] || 300) * 1000);
$.clockMs = function() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
};
$.reviveRate = Number(params['Revive HP Rate'] || 0.25);
// (No duel damage rate since 0.38.3 - the 'PvP Damage Rate' parameter is
// gone: duel hits go through a compression curve on the duel body, user
// decision 2026-10-20. See $.PVP_CURVE_K.)

$.NO_JOIN_TROOPS = [207];          // Heartless one: a one on one duel
$.MAX_JOINERS = 3;                 // 4 battle places: the owner + 3
// Blood golem (actor 10): the summoner's own companion for one fight. The
// skills (battle only) call CE64; the troop page calls CE501, which adds it
// (see FH_CoopRoam "Blood golem"). It takes one of the places.
$.GOLEM_ACTOR = 10;
$.GOLEM_SKILLS = [51, 103, 684, 706, 724];
$.GOLEM_CE = 501;
$.GOLEM_CASTING_SWITCH = 373;      // CE64 on, CE501 off
$.GOLEM_SUMMONED_SWITCH = 374;     // CE501 on, CE66 (after battle) off

$.isGolemSkill = function(item) {
    return !!item && DataManager.isSkill(item) && $.GOLEM_SKILLS.indexOf(item.id) >= 0;
};

// Host: no place left for one more joiner (the golem takes one).
$.fightFull = function(b) {
    return b.joiners.length + (b.golem ? 1 : 0) >= $.MAX_JOINERS;
};
$.KNOCKOUT = 1;
$.CHARACTERS_LEFT_VAR = 201;
// Death switch of every playable character (CE53 skips the protagonist).
$.DEATH_SWITCH = { 1: 3485, 3: 3552, 4: 2815, 5: 2637, 6: 3774, 13: 2676, 14: 3433, 15: 2695 };
// Lying sprite used by the original game over (CE47).
$.DOWN_GRAPHIC = {
    1: '%mercenary2', 3: '%occultist2', 4: '%doctor2', 5: '%mechanic2',
    6: '%yellow_mage2', 13: '%thug2', 14: '%journalist2', 15: '%botanist2'
};
$.DOWN_INDEX = 2;

//=============================================================================
// Relay: every battle message goes through the host.
//=============================================================================

$.bSend = function(to, msg) {
    if ($.isHost()) {
        $.sendTo(to, msg);
    } else if ($.conn) {
        if (to === $.myId) {
            var handler = $.guestHandlers[msg.t];
            if (handler) handler(msg);
            return;
        }
        $.conn.send({ t: 'bRelay', to: to, m: msg });
    }
};

$.hostHandlers.bRelay = function(conn, msg) {
    if (!msg.m || typeof msg.m.t !== 'string' || msg.m.t.charAt(0) !== 'b') return;
    msg.m.from = conn.guestId;
    $.sendTo(msg.to, msg.m);
};

$.myPlayerId = function() {
    return $.isHost() ? 'host' : $.myId;
};

// Joiner flags only live inside a fight: never sent, saved or kept.
$.JOIN_FLAGS = ['_fhJoiner', '_fhAwait', '_fhRemoteReady'];

$.stripJoinFlags = function(actor) {
    if (actor) $.JOIN_FLAGS.forEach(function(k) { delete actor[k]; });
    return actor;
};

$.actorJson = function(actor) {
    if (!actor) return null;
    var saved = {};
    $.JOIN_FLAGS.forEach(function(k) {
        if (k in actor) {
            saved[k] = actor[k];
            delete actor[k];
        }
    });
    var json = JsonEx.stringify(actor);
    Object.keys(saved).forEach(function(k) { actor[k] = saved[k]; });
    return json;
};

$.parseActor = function(json) {
    return json ? $.stripJoinFlags(JsonEx.parse(json)) : null;
};

//=============================================================================
// Down, revive, death
//=============================================================================

$.downs = {};   // host: player id -> { until }

$.coopDead = function() {
    var data = $.coopData();
    data.dead = data.dead || {};
    return data.dead;
};

$.nameOf = function(id) {
    if (id === 'host') return '#host';
    var c = $.clientById(id);
    return c ? c.name : null;
};

$.isDown = function(id) {
    return !!$.downs[id] || $.isDead(id);
};

$.isDead = function(id) {
    if (!$.isHost()) return false;
    var name = $.nameOf(id);
    return !!name && !!$.coopDead()[name];
};

// guest side: told by the host
$.myState = '';  // '' | 'down' | 'dead'
$.isDownMe = function() {
    if ($.isHost()) return $.isDown('host');
    return !!$.myState;
};

$.othersAlive = function(id) {
    var ids = ['host'].concat($.activeGuests().map(function(c) { return c.guestId; }));
    return ids.filter(function(other) { return other !== id && !$.isDown(other); });
};

// A down: { end } (the clock, ms). An entry with only "until" (frames, older
// code) gets its end from that once.
$.downEnd = function(down) {
    if (!down) return 0;
    if (down.end === undefined) {
        down.end = $.clockMs() + Math.max(0, (Number(down.until) || 0) - Graphics.frameCount) * 1000 / 60;
    }
    return down.end;
};

$.downLeftMs = function(id) {
    var down = $.downs[id];
    return down ? Math.max(0, Math.round($.downEnd(down) - $.clockMs())) : 0;
};

// 'pstate': s ('' / 'down' / 'dead'), ms (time left; 'left' is the same in
// frames of 1/60 s for an older PC).
$.pstateMsg = function(id) {
    var ms = $.downLeftMs(id);
    return { t: 'pstate', id: id, s: $.isDead(id) ? 'dead' : $.downs[id] ? 'down' : '',
        ms: ms, left: Math.round(ms * 60 / 1000) };
};

$.broadcastState = function(id) {
    var msg = $.pstateMsg(id);
    $.clients.forEach(function(c) { c.send(msg); });
    $.guestHandlers.pstate(msg);
};

// Host: a player lost a battle or hit a game over.
$.onPlayerDefeated = function(id) {
    if (!$.isHost()) return;
    if (!$.sessionActive()) {
        if (id === 'host') $.realGameOver();
        return;
    }
    if ($.isDead(id)) return;
    // the original's game over flow (CE47 / CE359 / CE500) ends in a down
    // here: what it did to that player's screen and flags is undone, and a
    // screen still left dark once nothing runs is put back (FH_CoopRoam)
    $.undoDeathFlow(id === 'host' ? 'self' : id, 'down');
    if (id === 'host') $.openScreenFix('down', $.downMs + 5000);
    // beheaded, starved, ... (Deaths for good, at the end): no down, even
    // for one already down
    var doom = $.doomOf($.actorOfPlayer(id));
    if (doom) {
        $.doomDies(id, doom);
        return;
    }
    if ($.downs[id]) return;
    var actor = $.actorOfPlayer(id);
    if (actor && !actor.isDead()) actor.addState($.KNOCKOUT);
    $.downs[id] = { end: $.clockMs() + $.downMs };
    $.dlog('player down', $.playerLabel(id));
    $.broadcastState(id);
    var text = $.playerLabel(id) + ' is down! Revive them with OK (' + Math.round($.downMs / 1000) + ' s)';
    $.broadcastToast(text);
    $.checkEveryoneDown();
};

$.broadcastToast = function(text) {
    $.clients.forEach(function(c) { c.send({ t: 'toast', text: 'Co-op: ' + text }); });
    $.toast('Co-op: ' + text);
};

$.checkEveryoneDown = function() {
    if ($.othersAlive(null).length === 0 && $.isDown('host')) $.hostDies();
};

$.revive = function(id, byId) {
    if (!$.downs[id]) return;
    var doom = $.doomOf($.actorOfPlayer(id));
    if (doom) { // nothing brings that back: it dies now
        $.doomDies(id, doom);
        return;
    }
    delete $.downs[id];
    var actor = $.actorOfPlayer(id);
    var images = false;
    if (actor) {
        actor.removeState($.KNOCKOUT);
        actor.setHp(Math.max(1, Math.round(actor.mhp * $.reviveRate)));
        $.restoreDownStates(actor);
        // the images the game over's flow replaced (a lost arm's portrait)
        images = $.standUpImages(actor);
    }
    // (a flow that ran after the down, e.g. CE359 on the map: undone now)
    $.undoDeathFlow(id === 'host' ? 'self' : id, 'revive');
    $.dlog('revived', $.playerLabel(id), 'by', $.playerLabel(byId), '- hp', actor ? actor.hp : '?',
        images ? '- images from before the game over back' : '');
    $.broadcastState(id);
    $.broadcastToast($.playerLabel(byId) + ' revived ' + $.playerLabel(id));
    if (id !== 'host') $.pushMe($.clientById(id));
    if (id === 'host') $gamePlayer.refresh();
};

// The states a player had when it went down come back with its revive (user
// decision 2026-11-03: the engine's die() clears them all - bleeding,
// fractures, infections, phobias - so a revive cured everything). Kept as it
// dies (the engine calls die() before it adds Knockout); a death in battle
// leaves out what that battle's end or its turns take off anyway.
$.downStatesOf = function(battler) {
    var inBattle = !!($gameParty && $gameParty.inBattle());
    var ids = [], turns = {}, steps = {};
    (battler._states || []).forEach(function(id) {
        var st = $dataStates[id];
        if (!st || id === battler.deathStateId()) return;
        if (inBattle && (st.removeAtBattleEnd || st.autoRemovalTiming > 0)) return;
        ids.push(id);
        turns[id] = battler._stateTurns[id];
        steps[id] = battler._stateSteps[id];
    });
    return ids.length ? { ids: ids, turns: turns, steps: steps } : null;
};

var _dieDownStates = Game_BattlerBase.prototype.die;
Game_BattlerBase.prototype.die = function() {
    if (this.isActor && this.isActor()) this._fhDownStates = $.downStatesOf(this);
    _dieDownStates.call(this);
};

$.restoreDownStates = function(actor) {
    var keep = actor && actor._fhDownStates;
    if (!keep) return;
    actor._fhDownStates = null;
    keep.ids.forEach(function(id) {
        if (!$dataStates[id] || actor.isStateAffected(id)) return;
        actor._states.push(id);
        if (keep.turns[id] !== undefined) actor._stateTurns[id] = keep.turns[id];
        if (keep.steps[id] !== undefined) actor._stateSteps[id] = keep.steps[id];
    });
    actor.sortStates();
    actor.refresh();
    $.dlog('revive: states back for', actor.name(), '-', keep.ids.join(','));
};

// Timer ran out.
$.downExpired = function(id) {
    delete $.downs[id];
    if (id === 'host') {
        $.hostDies();
        return;
    }
    $.killPlayer(id, 'died');
};

// Permanent death of a guest (until the host loads a save).
$.killPlayer = function(id, why) {
    var conn = $.clientById(id);
    if (!conn) return;
    delete $.downs[id];
    $.coopDead()[conn.name] = true;
    var sw = $.DEATH_SWITCH[conn.actorId];
    if (sw && !$gameSwitches.value(sw)) {
        $gameSwitches.setValue(sw, true);
        $gameVariables.setValue($.CHARACTERS_LEFT_VAR, $gameVariables.value($.CHARACTERS_LEFT_VAR) - 1);
    }
    var actor = $.actorOfPlayer(id);
    if (actor) actor.addState($.KNOCKOUT);
    $.dlog('player dead', conn.name, why);
    // the dead watch the host: back into the host's game, on the host's map
    if (conn.lastPos) delete conn.lastPos.m;
    if (conn.roam || conn.roamPending) $.sendSnapshot(conn);
    $.broadcastState(id);
    if (!$.quietDeath) $.broadcastToast($.playerLabel(id) + ' ' + (why || 'died') + '.');
    $.checkEveryoneDown();
};
$.quietDeath = false; // host: the caller tells this death itself (a duel to the death)

$.hostDies = function() {
    // Others still alive: they play on. This PC keeps running the world in
    // the background and its player watches, like a dead guest.
    if (($.sessionActive() && $.othersAlive('host').length) || $.saveGuestsPending()) {
        $.hostDeadWatch();
        return;
    }
    $.dlog('host died: game over');
    $.clients.forEach(function(c) { c.send({ t: 'toast', text: 'Co-op: the host died - game over' }); });
    $.downs = {};
    // the session's game ends here: its world, fights and downs too, and the
    // guests go to the lobby now (FH_CoopRoam)
    if ($.endSessionGame) $.endSessionGame('game over');
    $.realGameOver();
};

$.hostDeadWatch = function() {
    delete $.downs.host;
    $.coopDead()[$.nameOf('host')] = true; // in the host's save, as a dead guest's
    var actorId = $.hostActorId();
    var sw = $.DEATH_SWITCH[actorId];
    if (sw && !$gameSwitches.value(sw)) {
        $gameSwitches.setValue(sw, true);
        $gameVariables.setValue($.CHARACTERS_LEFT_VAR, $gameVariables.value($.CHARACTERS_LEFT_VAR) - 1);
    }
    var actor = $gameActors.actor(actorId);
    if (actor) actor.addState($.KNOCKOUT);
    $.dlog('host died: the others play on');
    $.broadcastState('host');
    if (!$.quietDeath) $.broadcastToast($.playerLabel('host') + ' died. The others play on (the host walks as a ghost).');
};

$.realGameOver = function() {
    $.gameOverPending = true; // nothing may replace it (e.g. the battle's pop)
    $.gameOverPendingAt = $.clockMs();
    $.allowGameOver = true;
    SceneManager.goto(Scene_Gameover);
    $.allowGameOver = false;
};

var _Scene_Gameover_start = Scene_Gameover.prototype.start;
Scene_Gameover.prototype.start = function() {
    $.gameOverPending = false;
    _Scene_Gameover_start.call(this);
};

// A game over screen that never starts (it waited for an image, see
// FH_Coop "A missing image") must not swallow every later scene change.
$.GAME_OVER_WAIT_MS = 10000;
var _updateSceneGameOverWait = SceneManager.updateScene;
SceneManager.updateScene = function() {
    if ($.gameOverPending && $.clockMs() - ($.gameOverPendingAt || 0) > $.GAME_OVER_WAIT_MS) {
        $.dlog('the game over screen did not start in', $.GAME_OVER_WAIT_MS / 1000, 's: scene changes free again');
        $.gameOverPending = false;
    }
    _updateSceneGameOverWait.call(this);
};

$.worldExtras.push(function() {
    Object.keys($.downs).forEach(function(id) {
        if ($.downs[id] && $.clockMs() >= $.downEnd($.downs[id])) $.downExpired(id);
    });
    // Down players stay on the floor.
    if ($.downs.host) $.applyDownGraphic($gamePlayer, $.hostActorId()); // down, not dead (a ghost)
});

// The original game over (CE47) and death (CE359) change the character's
// own image to the lying one (%..2, index 2) and drop the face. In co-op a
// game over is a down, so those images stayed after the revive: the host's
// own character was drawn crouching (0.38.1, O'saa at the train). A player
// who is neither down nor dead gets its image back once no event runs.
$.fixLyingImage = function(actorId) {
    var actor = actorId ? $gameActors.actor(actorId) : null;
    var data = $dataActors[actorId];
    if (!actor || !data || !$.DOWN_GRAPHIC[actorId]) return false;
    // what the game over's Change Actor Images replaced, kept at its 322
    // (below): all of it back - the face and the battler (the menu portrait
    // with a lost arm) too, not the database's
    if (actor._fhPreDownImg) {
        $.standUpImages(actor);
        $.dlog('images from before the game over put back for', actor.name());
        return true;
    }
    if (actor.characterName() !== $.DOWN_GRAPHIC[actorId] || actor.characterIndex() !== $.DOWN_INDEX) return false;
    // the same sprite is the crawl of a character without an arm and a leg
    // (outfit common events, e.g. CE396: SW262 + SW264 for O'saa): that stays
    var limbs = ($.LIMB_SWITCHES || {})[actorId] || [];
    if (limbs.length && $gameSwitches.value(limbs[1]) && $gameSwitches.value(limbs[3])) return false;
    actor.setCharacterImage(data.characterName, data.characterIndex);
    if (!actor.faceName() && data.faceName) actor.setFaceImage(data.faceName, data.faceIndex);
    $.dlog('lying image put back for', actor.name());
    return true;
};

$.fixLyingImages = function() {
    if ($gameParty.inBattle() || $gameMap.isEventRunning() || $.puppet) return;
    // (a ghost walks with its own image too)
    if (!$.downs.host && $.fixLyingImage($.hostActorId())) $gamePlayer.refresh();
    $.clients.forEach(function(c) {
        if (c.actorId && !c.roam && !$.downs[c.guestId] && $.fixLyingImage(c.actorId)) $.pushMe(c);
    });
};

//-----------------------------------------------------------------------------
// A game over that became a down: what its flow did is undone
//-----------------------------------------------------------------------------
// The original's game over flows (data):
// - CE47 GameOver: Change Actor Images (322) of every protagonist to the
//   lying sprite, no face, the database battler (the menu portrait), then
//   Game Over (353).
// - CE359 DEATH_MAIN_CHARACTER: menu off (135), SW202 / SW410 on, 322, 353.
// - CE500 main_character_dead? (each troop's turn end: page "turn end" ->
//   CE499 -> CE500): the protagonist dead -> SW202 / SW410 on, the screen
//   tinted black (-255, 30 frames, wait), the companions out of the party:
//   the fight is lost, the game is over.
// In co-op the game goes on (a down), and nothing undid them: the host's
// screen stayed black after a fight it went down in (0.38.3-pre5: a
// villager on Map009, Marina joined; tone [-255,-255,-255] for good, even
// saved so), its run key and needs stayed off (SW202 / SW410: CE576 run_key
// waits for both off), a revived player kept CE47's portrait (O'saa's lost
// arm drawn again). Now the first change such a flow makes notes what was
// there, for the player it is about (this PC's own, or a guest whose event
// runs here); a down undoes it: those switches, the menu, the screen (tint
// and fade back where darker now). The images are kept per actor at the
// 322 and given back when that player stands up.
$.DEATH_FLOW_CES = [47, 359, 500];
$.DEATH_FLOW_CODES = { 121: true, 135: true, 221: true, 223: true, 322: true, 353: true };
$.DEATH_FLOW_MS = 180000; // (real time, $.clockMs)
$.deathFlows = {}; // 'self' | guest id -> { at, ce, sw: { 202, 410 }, menu, tone, b }

$.deathFlowOf = function(list) {
    if (!list || typeof $dataCommonEvents === 'undefined' || !$dataCommonEvents) return 0;
    for (var i = 0; i < $.DEATH_FLOW_CES.length; i++) {
        var ce = $dataCommonEvents[$.DEATH_FLOW_CES[i]];
        if (!ce || !ce.list) continue;
        // (a run handed over from another PC comes as a JSON copy)
        if (ce.list === list || (ce.list.length === list.length && $.sameListShape && $.sameListShape(ce.list, list))) {
            return $.DEATH_FLOW_CES[i];
        }
    }
    return 0;
};

var _setupDeathFlow = Game_Interpreter.prototype.setup;
Game_Interpreter.prototype.setup = function(list, eventId) {
    _setupDeathFlow.call(this, list, eventId);
    this._fhDeathFlow = $.role ? $.deathFlowOf(list) : 0;
};

var _setupChildDeathFlow = Game_Interpreter.prototype.setupChild;
Game_Interpreter.prototype.setupChild = function(list, eventId) {
    _setupChildDeathFlow.call(this, list, eventId);
    if (this._childInterpreter) this._childInterpreter._fhDeathFlow = $.role ? $.deathFlowOf(list) : 0;
};

var _executeCommandDeathFlow = Game_Interpreter.prototype.executeCommand;
Game_Interpreter.prototype.executeCommand = function() {
    if (this._fhDeathFlow) {
        var cmd = this.currentCommand();
        if (cmd && $.DEATH_FLOW_CODES[cmd.code]) $.noteDeathFlow(this);
        // CE500 comes at every turn end while the owner lies dead in a fight
        // the joiners go on with: its black tint went back the next frame
        // and came again each round (the screen blinked black)
        if (cmd && cmd.code === 223 && this._fhDeathFlow === 500 && $.fightGoesOnWithoutOwner()) {
            this._index++;
            return true;
        }
    }
    return _executeCommandDeathFlow.call(this);
};

$.fightGoesOnWithoutOwner = function() {
    var ab = $.authBattle;
    return $gameParty.inBattle() && !$.puppet && !!ab && !ab.pvp && !!ab.joiners.length &&
        !!$.joinersAlive && $.joinersAlive();
};

// Whose flow: a guest's event run here (its context: its SW202 / SW410 are
// in the world now), else this PC's player.
$.deathFlowKey = function(interp) {
    return interp._fhOwner && $.runsWorld() && $.clientById(interp._fhOwner) ? interp._fhOwner : 'self';
};

$.noteDeathFlow = function(interp) {
    var key = $.deathFlowKey(interp);
    var rec = $.deathFlows[key];
    if (rec && $.clockMs() - rec.at < $.DEATH_FLOW_MS) return; // (what was there before the first change)
    var sw = $gameSwitches._data;
    $.deathFlows[key] = {
        at: $.clockMs(), ce: interp._fhDeathFlow, sw: { 202: !!sw[202], 410: !!sw[410] },
        menu: $gameSystem.isMenuEnabled(), tone: $gameScreen.tone().slice(), b: Math.round($gameScreen.brightness())
    };
    $.dlog('game over flow CE' + interp._fhDeathFlow, 'starts for', key === 'self' ? 'this player' : $.playerLabel(key));
};

// A player's own switch (SW202 / SW410 ...), wherever it is now: this PC's in
// the world (or saved aside while a guest's context is active); a guest's
// in the world while its context is active, else kept with its connection.
$.ownSwitchValue = function(key, id) {
    if (key === 'self') {
        if ($.ctxOwnSave && $.ctxOwnSave.sw && id in $.ctxOwnSave.sw) return !!$.ctxOwnSave.sw[id];
        return !!$gameSwitches._data[id];
    }
    var conn = $.clientById(key);
    if (!conn) return false;
    if ($.ctx === conn) return !!$gameSwitches._data[id];
    return !!(conn._fhCtxSw && conn._fhCtxSw[id]);
};

$.setOwnSwitchValue = function(key, id, value) {
    if (key === 'self') {
        if ($.ctxOwnSave && $.ctxOwnSave.sw && id in $.ctxOwnSave.sw) $.ctxOwnSave.sw[id] = !!value;
        else $gameSwitches._data[id] = !!value;
        return;
    }
    var conn = $.clientById(key);
    if (!conn) return;
    if ($.ctx === conn) {
        $gameSwitches._data[id] = !!value;
        return;
    }
    conn._fhCtxSw = conn._fhCtxSw || {};
    if (value) conn._fhCtxSw[id] = true; else delete conn._fhCtxSw[id];
};

$.isDarkTone = function(t) {
    return !!t && t[0] <= -128 && t[1] <= -128 && t[2] <= -128;
};

// White is a transition too (the dream's way out tints [255,255,255,255]
// before the bed's page tints it back): never a map's own look.
$.isWhiteTone = function(t) {
    return !!t && t[0] >= 128 && t[1] >= 128 && t[2] >= 128;
};

$.isOffTone = function(t) {
    return $.isDarkTone(t) || $.isWhiteTone(t);
};

// This PC's screen back where it is darker than before (rec: the flow's
// note, or null: the map's plain look).
$.screenBackFrom = function(rec) {
    var sc = $gameScreen, out = [];
    if (!sc) return out;
    if ($.isOffTone(sc._tone) || (sc._toneDuration > 0 && $.isOffTone(sc._toneTarget))) {
        var tone = rec && rec.tone && !$.isOffTone(rec.tone) ? rec.tone.slice() : [0, 0, 0, 0];
        sc.startTint(tone, 30);
        out.push('tint ' + JSON.stringify(tone));
    }
    if (sc._brightness < 255 || sc._fadeOutDuration > 0) {
        sc._fadeOutDuration = 0;
        sc.startFadeIn(30);
        out.push('fade in');
    }
    if (sc._flashDuration > 0) {
        sc.clearFlash();
        out.push('flash off');
    }
    return out;
};

$.undoDeathFlow = function(key, why) {
    var rec = $.deathFlows[key];
    if (!rec) return false;
    delete $.deathFlows[key];
    if ($.clockMs() - rec.at > $.DEATH_FLOW_MS) return false;
    var undo = [];
    [202, 410].forEach(function(id) {
        if (!rec.sw[id] && $.ownSwitchValue(key, id)) {
            $.setOwnSwitchValue(key, id, false);
            undo.push('SW' + id + ' off');
        }
    });
    if (key === 'self') {
        if (rec.menu && !$gameSystem.isMenuEnabled()) {
            $gameSystem.enableMenu();
            undo.push('menu on');
        }
        undo = undo.concat($.screenBackFrom(rec));
    }
    if ($gameMap) $gameMap.requestRefresh();
    $.dlog('down: the game over flow CE' + rec.ce, 'of', key === 'self' ? 'this player' : $.playerLabel(key),
        'undone -', undo.join(', ') || 'nothing left to undo', why ? '(' + why + ')' : '');
    return true;
};

// A window in which a screen left dark with nothing running is put back
// (FH_CoopRoam "Screen left dark"): after a down, a load, a new map world.
$.screenFix = null; // this PC: { why, until (ms), since }
// (a shorter one never cuts an open window short: a ladder after a down)
$.openScreenFix = function(why, ms) {
    var until = $.clockMs() + ms, w = $.screenFix;
    if (w && w.until >= until) return;
    $.screenFix = { why: why, until: until, since: w ? w.since : 0 };
};

// The joiners fight on while the owner lies dead: CE500 tinted the owner's
// screen black and turned its flags on for a game over that does not come.
$.undoDeathFlowInFight = function() {
    var ab = $.authBattle;
    if (!$.deathFlows.self || $.puppet || !$gameParty.inBattle() || !ab || ab.pvp || !ab.joiners.length) return;
    if (!$.joinersAlive || !$.joinersAlive() || $gameTroop.isEventRunning()) return;
    var own = $.ownActor ? $.ownActor() : null;
    if (!own || own.isAlive()) return;
    $.undoDeathFlow('self', 'the others fight on');
};

var _bmUpdateDeathFlow = BattleManager.update;
BattleManager.update = function() {
    _bmUpdateDeathFlow.call(this);
    if ($.deathFlows.self) $.undoDeathFlowInFight();
};

// What CE47 / CE359's Change Actor Images replaces with the lying sprite.
var _command322Down = Game_Interpreter.prototype.command322;
Game_Interpreter.prototype.command322 = function() {
    var p = this._params;
    var actor = $.role ? $gameActors.actor(p[0]) : null;
    var lyingDown = !!actor && $.DOWN_GRAPHIC[p[0]] === p[1] && p[2] === $.DOWN_INDEX;
    $.lyingImageSet = lyingDown;
    try {
        return $.command322Down(this, actor, p, lyingDown);
    } finally {
        $.lyingImageSet = false;
    }
};

$.command322Down = function(interp, actor, p, lyingDown) {
    if (lyingDown) {
        var lying = actor.characterName() === p[1] && actor.characterIndex() === p[2];
        // (already lying from a game over before: that one's note stays)
        if (!lying || !actor._fhPreDownImg) {
            actor._fhPreDownImg = { c: actor.characterName(), ci: actor.characterIndex(), f: actor.faceName(),
                fi: actor.faceIndex(), b: actor.battlerName() };
        }
    }
    return _command322Down.call(interp);
};

// A newer picture the game gives that character afterwards (its outfit
// common event, a scene's own Change Actor Images after CE368's lying one)
// wins: the note from before is dropped, or the old outfit came back later.
['setCharacterImage', 'setFaceImage', 'setBattlerImage'].forEach(function(name) {
    var orig = Game_Actor.prototype[name];
    Game_Actor.prototype[name] = function() {
        if (this._fhPreDownImg && !$.lyingImageSet) delete this._fhPreDownImg;
        return orig.apply(this, arguments);
    };
});

$.standUpImages = function(actor) {
    var img = actor && actor._fhPreDownImg;
    if (!img) return false;
    delete actor._fhPreDownImg;
    actor.setCharacterImage(img.c, img.ci);
    actor.setFaceImage(img.f, img.fi);
    actor.setBattlerImage(img.b);
    return true;
};

// a load: notes of the world before mean nothing
var _loadGameDeathFlow = DataManager.loadGame;
DataManager.loadGame = function(savefileId) {
    $.deathFlows = {};
    return _loadGameDeathFlow.call(this, savefileId);
};

$.worldExtras.push(function() {
    if ($.isHost() && Graphics.frameCount % 30 === 0) $.fixLyingImages();
});

// A guest running its own map: its own character.
$.guestExtras.push(function() {
    if (!$.isGuest() || !$.isRoaming || !$.isRoaming() || $.myState === 'down' || Graphics.frameCount % 30 !== 0) return;
    if ($gameParty.inBattle() || $gameMap.isEventRunning() || $.puppet) return;
    if ($.fixLyingImage($.myActorId)) $gamePlayer.refresh();
});

// A down player's lying sprite and the game's own image (Game_Player.refresh
// after an outfit common event such as CE396, a menu, a transfer) took turns:
// the host's character flickered between lying and standing (0.38.1 video).
// The lying sprite now wins every refresh while that player is down.
var _gamePlayerRefreshDown = Game_Player.prototype.refresh;
Game_Player.prototype.refresh = function() {
    _gamePlayerRefreshDown.call(this);
    if (!$.role || this !== $gamePlayer || this._fhRemoteId) return;
    if ($.isHost() && $.downs && $.downs.host) $.applyDownGraphic(this, $.hostActorId());
    else if ($.isGuest() && $.myState === 'down') $.applyDownGraphic(this, $.myActorId);
};

$.applyDownGraphic = function(character, actorId) {
    var name = $.DOWN_GRAPHIC[actorId];
    if (name && (character.characterName() !== name || character.characterIndex() !== $.DOWN_INDEX)) {
        character.setImage(name, $.DOWN_INDEX);
    }
};

$.guestHandlers.pstate = function(msg) {
    if ($.isGuest() && msg.id === $.myId) {
        $.myState = msg.s;
        if (!msg.s && $gamePlayer) $gamePlayer.refresh();
    }
    if (msg.s) {
        $.downUntil = $.downUntil || {};
        $.downUntil[msg.id] = $.clockMs() + (msg.ms !== undefined ? Number(msg.ms) || 0 : (Number(msg.left) || 0) * 1000 / 60);
    }
};

var _canMove = Game_Player.prototype.canMove;
Game_Player.prototype.canMove = function() {
    // a dead player walks as a ghost (see Ghosts at the end); the down lie
    if ($.role && $.isDownMe() && !($.isGhostMe && $.isGhostMe())) return false;
    return _canMove.call(this);
};

// A dead player walks around as a ghost (Ghosts, at the end of this file).
var _Game_Player_update_dead = Game_Player.prototype.update;
Game_Player.prototype.update = function(sceneActive) {
    _Game_Player_update_dead.call(this, sceneActive);
    if (this === $gamePlayer && !this._fhRemoteId && $.updateGhostLook) $.updateGhostLook(this);
};

// Nothing walks into a down or dead host and starts (a fight with a body).
// The same on a guest's PC running its own map (a Rher form or a chaser
// walking into that guest lying down there); the others on the host's map
// are not touched while down ($.humanTargets).
// (the real player: while an event chases a living guest, $gamePlayer is that
// guest's stand-in - play test 2026-10-31: a villager chasing Marina walked
// into the ghost host and started its fight)
var _checkTouchDownHost = Game_Event.prototype.checkEventTriggerTouch;
Game_Event.prototype.checkEventTriggerTouch = function(x, y) {
    var downHere = $.isHost() ? $.sessionActive() && $.isDown('host') : $.isGuest() && !!$.myState && !$.solo;
    var me = $.realPlayer || $gamePlayer;
    if (downHere && me.pos(x, y) && !me._fhRemoteId &&
            !($.remotePlayerAt && $.remotePlayerAt(x, y))) return;
    _checkTouchDownHost.call(this, x, y);
};

// The living player a ghost last went to (Ghosts, at the end).
$.watchId = 'host';

// guests know the others' states from 'pstate'
$.deadIds = {};
$.downIds = {};
var _pstateWatch = $.guestHandlers.pstate;
$.guestHandlers.pstate = function(msg) {
    var died = $.isGuest() && msg.id === $.myId && msg.s === 'dead' && $.myState !== 'dead';
    _pstateWatch(msg);
    if (msg.s === 'dead') $.deadIds[msg.id] = true; else delete $.deadIds[msg.id];
    if (msg.s === 'down') $.downIds[msg.id] = true; else delete $.downIds[msg.id];
    if (died) $.toast('Co-op: you are a ghost now - walk around, Z: ping the others');
};

//-----------------------------------------------------------------------------
// Down timer (user decision 2026-10-19): while anyone is down, every PC shows
// how long each down player has left, the whole time, in a line of its own
// at the top of the screen (map, menus and battles alike):
//   "You are down: 42 s - wait for a revive"   (the down player's own PC)
//   "Levi is down: 42 s - revive them with OK" (everyone else)
// The host counts from $.downs; a guest from 'pstate' (left frames).
//-----------------------------------------------------------------------------

$.downName = function(id) {
    if ($.isHost()) return $.playerLabel(id);
    if (id === $.myId) {
        var mine = $gameActors && $gameActors.actor($.myActorId);
        return mine ? mine.name() : $.myName;
    }
    var p = ($.roster || []).filter(function(r) { return r.id === id; })[0];
    var actor = p && p.a && $gameActors ? $gameActors.actor(p.a) : null;
    return actor ? actor.name() : p ? p.name : 'Someone';
};

// [{ id, name, left (seconds), me }], this player first.
$.downTimerList = function() {
    if (!$.role) return [];
    var now = $.clockMs(), list = [];
    var me = $.myPlayerId();
    var add = function(id, until) {
        list.push({ id: id, name: $.downName(id), left: Math.max(0, Math.ceil((until - now) / 1000)), me: id === me });
    };
    if ($.isHost()) {
        Object.keys($.downs).forEach(function(id) { add(id, $.downEnd($.downs[id])); });
    } else {
        var inRoster = {};
        ($.roster || []).forEach(function(r) { inRoster[r.id] = true; });
        Object.keys($.downIds || {}).forEach(function(id) {
            // one who left (no 'pstate' for that) is not shown on
            if (($.roster || []).length && !inRoster[id]) return;
            if ($.downUntil && $.downUntil[id] !== undefined) add(id, $.downUntil[id]);
        });
    }
    list.sort(function(a, b) { return (b.me ? 1 : 0) - (a.me ? 1 : 0); });
    return list;
};

$.downTimerText = function() {
    return $.downTimerList().map(function(d) {
        return d.me ? 'You are down: ' + d.left + ' s - wait for a revive' :
            d.name + ' is down: ' + d.left + ' s - revive them with OK';
    }).join(String.fromCharCode(10));
};

$.lastDownTimerText = null;
$.updateDownTimer = function() {
    if (typeof document === 'undefined') return;
    var scene = SceneManager._scene;
    var text = !scene || scene instanceof Scene_Title ? '' : $.downTimerText();
    if (text === $.lastDownTimerText) return;
    $.lastDownTimerText = text;
    var el = document.getElementById('fhcoop-down');
    if (!el) {
        if (!text) return;
        el = document.createElement('div');
        el.id = 'fhcoop-down';
        el.style.cssText = 'position:fixed;top:30px;left:50%;transform:translateX(-50%);z-index:101;' +
            'font:bold 15px sans-serif;color:#fff;background:rgba(120,0,0,0.75);padding:4px 12px;' +
            'border:1px solid rgba(255,160,160,0.6);border-radius:3px;pointer-events:none;' +
            'white-space:pre;text-align:center;';
        document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.display = text ? 'block' : 'none';
};

var _sceneBaseUpdateDownTimer = Scene_Base.prototype.update;
Scene_Base.prototype.update = function() {
    _sceneBaseUpdateDownTimer.call(this);
    if (Graphics.frameCount % 10 === 0 || $.lastDownTimerText === null) $.updateDownTimer();
};

// living players on this map ($.remotes), the host first
$.watchable = function() {
    var gone = function(id) { return !!$.deadIds[id] || ($.isHost() && id !== 'host' && $.isDead(id)); };
    var ids = Object.keys($.remotes || {}).filter(function(id) { return !gone(id); });
    ids.sort(function(a, b) { return a === 'host' ? -1 : b === 'host' ? 1 : (a < b ? -1 : a > b ? 1 : 0); });
    return ids;
};

$.watchName = function(id) {
    var entry = ($.roster || []).filter(function(p) { return p.id === id; })[0];
    return entry ? entry.name : id;
};

if (Game_Player.prototype.updateFHCoopGraphic) {
    var _updateGraphic = Game_Player.prototype.updateFHCoopGraphic;
    Game_Player.prototype.updateFHCoopGraphic = function() {
        if ($.myState === 'down') {
            $.applyDownGraphic(this, $.myActorId);
            return;
        }
        _updateGraphic.call(this);
    };
}

// Revive: OK in front of a down player.
$.downPlayerAt = function(x, y) {
    var hit = null;
    if ($.downs.host && $gamePlayer.pos(x, y)) hit = 'host';
    Object.keys($.remotes).forEach(function(id) {
        if (!hit && $.downs[id] && $.remotes[id].pos(x, y)) hit = id;
    });
    return hit;
};

$.actHooks.push(function(conn, msg) {
    if ($.isDown(conn.guestId)) return true;
    if (msg.tr.indexOf(0) < 0) return false;
    var target = $.downPlayerAt(msg.x, msg.y);
    if (!target || target === conn.guestId) return false;
    $.revive(target, conn.guestId);
    return true;
});

var _triggerButtonAction = Game_Player.prototype.triggerButtonAction;
Game_Player.prototype.triggerButtonAction = function() {
    if ($.isHost() && $.sessionActive() && Input.isTriggered('ok') && !$.isDown('host')) {
        var x = $gameMap.roundXWithDirection(this.x, this.direction());
        var y = $gameMap.roundYWithDirection(this.y, this.direction());
        var target = $.downPlayerAt(x, y);
        if (target && target !== 'host') {
            $.revive(target, 'host');
            return true;
        }
        var joined = $.battleAtTile(x, y);
        if (joined) {
            $.requestJoin('host', joined);
            return true;
        }
    }
    return _triggerButtonAction.call(this);
};

// Game over: in co-op it means "down".
var _goto = SceneManager.goto;
SceneManager.goto = function(sceneClass) {
    if ($.gameOverPending) {
        if (sceneClass === Scene_Gameover) _goto.call(this, sceneClass);
        return;
    }
    if (sceneClass === Scene_Gameover && !$.allowGameOver && $.role) {
        if ($.handleGameOver()) return;
    }
    _goto.call(this, sceneClass);
};

$.handleGameOver = function() {
    // Joined battle (puppet view): the authority decides.
    if ($.puppet) return true;
    if ($.isGuest()) {
        if ($.solo) return false; // FH_Coop's tutorial rescue
        if ($.localBattle) {
            // the joiners fight on; the owner is put down afterwards
            if ($gameParty.inBattle() && $.authBattle && $.authBattle.joiners.length && $.joinersAlive()) {
                return true;
            }
            $.finishLocalBattle(2, true);
            return true;
        }
        return true; // thin guests never end the game themselves
    }
    // A save loaded with the host dead: the guests of that save are not back
    // yet, so no session - the original's "all dead" game over went through a
    // few seconds after the load (play test 2026-10-31). It waits for them
    // (saveGuestsPending; then the map's load check decides).
    if (!$.sessionActive()) return $.isDead('host') && $.saveGuestsPending();
    if ($gameParty.inBattle()) {
        if ($.authBattle && $.authBattle.joiners.length && $.joinersAlive()) {
            $.authBattle.ownerDown = true; // the others fight on
            $.authBattle.ownerDownDead = $.actorOfPlayer('host') ? $.actorOfPlayer('host').isDead() : false;
            return true;
        }
        $.endHostBattleDefeated();
        return true;
    }
    $.onPlayerDefeated('host');
    return true;
};

var _command353 = Game_Interpreter.prototype.command353;
// A co-op save loaded with the host dead and guests alive: the host is the
// first in, the guests are not back yet, so "nobody alive" was true and the
// game over sent everyone to the title (0.41 play test). For a while after a
// load the living players of that save count as coming back.
$.LOAD_WAIT_MS = 180000; // (real time, $.clockMs)
$.loadedAt = 0;
$.saveGuestsPending = function() {
    if (!$.isHost() || !$.loadedAt || $.clockMs() - $.loadedAt > $.LOAD_WAIT_MS) return false;
    var dead = $.coopDead(), assign = $.assignments();
    return Object.keys(assign).some(function(name) {
        return !dead[name] && !$.clients.some(function(c) { return c.name === name && c.inGame && c.actorId; });
    });
};

var _loadGameWait = DataManager.loadGame;
DataManager.loadGame = function(savefileId) {
    var ok = _loadGameWait.apply(this, arguments);
    if (ok && $.isHost()) $.loadedAt = $.clockMs();
    return ok;
};

// All of them back, or the wait is over: then a dead host with nobody alive
// is a game over as before.
var _sceneMapUpdateLoadWait = Scene_Map.prototype.update;
Scene_Map.prototype.update = function() {
    _sceneMapUpdateLoadWait.call(this);
    if (!$.loadedAt || !$.isHost() || $.saveGuestsPending()) return;
    $.loadedAt = 0;
    if ($.isDead('host') && $.othersAlive('host').length === 0) {
        $.dlog('after the load nobody living came back - game over');
        $.hostDies();
    }
};

Game_Interpreter.prototype.command353 = function() {
    // a dead host (a ghost) with others alive or coming back: no game over
    if ($.isHost() && !this._fhOwner && !$gameParty.inBattle() && $.isDead('host') &&
            ($.sessionActive() || $.saveGuestsPending())) {
        this._index = this._list.length;
        return true;
    }
    if ($.isHost() && !this._fhOwner && $.sessionActive() && !$gameParty.inBattle()) {
        $.onPlayerDefeated('host');
        this._index = this._list.length;
        return true;
    }
    return _command353.call(this);
};

//=============================================================================
// Battle authority
//=============================================================================

$.battles = {};      // host: bid -> { owner, troopId, eventId, mapId, joiners, interp, pvp }
$.nextBid = 1;
// Battle ids are unique in the session: a guest running a map for others
// makes its own (FH_CoopRoam).
$.newBid = function() {
    return $.nextBid++;
};
$.authBattle = null; // this PC runs a battle: { bid, owner, joiners: [ids], pvp }
$.localBattle = null; // guest: delegated battle state

$.freezeEvent = function(eventId, bid) {
    var ev = eventId > 0 ? $gameMap.event(eventId) : null;
    if (ev) ev._fhBattle = bid;
};

$.unfreezeBattle = function(b) {
    if (!b) return;
    if (b.mapId === $gameMap.mapId()) {
        var ev = $gameMap.event(b.eventId);
        if (ev && ev._fhBattle === b.bid) ev._fhBattle = 0;
    }
};

var _Game_Event_updateSelfMovement = Game_Event.prototype.updateSelfMovement;
Game_Event.prototype.updateSelfMovement = function() {
    if (this._fhBattle) return; // waits on the spot while the fight lasts
    _Game_Event_updateSelfMovement.call(this);
};

$.troopIdOf = function(interp) {
    var p = interp._params;
    if (p[0] === 0) return p[1];
    if (p[0] === 1) return $gameVariables.value(p[1]);
    return $gamePlayer.makeEncounterTroopId();
};

// A guest talked to an event the host shares as a cutscene (FH_CoopWorld
// startEventFor) and the talk turns into a fight: that guest fights it.
// The rest of the event goes to the guest (as its own event); the host's
// map interpreter lets go after this frame (it may be mid-update here).
$.battleStarterConn = function(interp) {
    if (!$.isHost() || !$.sessionActive() || interp._fhOwner || $gameParty.inBattle()) return null;
    var root = $gameMap._interpreter, inChain = false;
    for (var i = root; i; i = i._childInterpreter) {
        if (i === interp) inChain = true;
    }
    var ev = inChain && root.eventId() > 0 ? $gameMap.event(root.eventId()) : null;
    var id = ev && ev._fhStartedBy;
    if (!id || id === 'host') return null;
    var conn = $.clientById(id);
    if (!conn || !conn.actorId || $.isBusy(conn) || !$.guestOnMap(conn) || $.isDown(id)) return null;
    return conn;
};

$.battleHandOff = null; // host: { conn, json, eventId }

$.handBattleToGuest = function(conn, interp) {
    var root = $gameMap._interpreter;
    $.battleHandOff = { conn: conn, json: JsonEx.stringify(root), eventId: root.eventId() };
    interp.setWaitMode('fhHanded');
    $.dlog('battle goes to', conn.name, 'ev' + root.eventId());
};

$.finishBattleHandOff = function() {
    var h = $.battleHandOff;
    if (!h) return;
    $.battleHandOff = null;
    var root = $gameMap._interpreter;
    $.setDialogueOwner(root, false);
    if (h.eventId > 0) $gameMap.unlockEvent(h.eventId);
    root.clear();
    if (!$.clientById(h.conn.guestId)) return;
    var interp = $.cleanInterp(JsonEx.parse(h.json));
    for (var i = interp; i; i = i._childInterpreter) i._fhOwner = h.conn.guestId;
    var ev = h.eventId > 0 ? $gameMap.event(h.eventId) : null;
    if (ev) {
        ev._fhOwner = h.conn.guestId;
        $.lockToward(ev, $.remotes[h.conn.guestId]);
    }
    $.owned[h.conn.guestId] = { interp: interp, ev: ev };
    h.conn.send({ t: 'evRun', on: true });
};

var _Game_Map_updateInterpreter_battle = Game_Map.prototype.updateInterpreter;
Game_Map.prototype.updateInterpreter = function() {
    _Game_Map_updateInterpreter_battle.call(this);
    if ($.battleHandOff) $.finishBattleHandOff();
};

var _command301 = Game_Interpreter.prototype.command301;
Game_Interpreter.prototype.command301 = function() {
    if ($.runsWorld() && this._fhOwner && !$gameParty.inBattle()) return this.fhDelegateBattle();
    var starter = $.battleStarterConn(this);
    if (starter) {
        $.handBattleToGuest(starter, this);
        return false; // the guest's copy runs this command again
    }
    var hostBattle = $.isHost() && $.hostFightJoinable() && !this._fhOwner && !$gameParty.inBattle();
    var troopId = hostBattle ? $.troopIdOf(this) : 0;
    var result = _command301.call(this);
    // User decision (2026-10-19): in co-op a battle "that can be lost" is a
    // co-op down like any other defeat: the "if lose" branch never runs, the
    // event stops. Except a capture scene (a transfer in that branch: the
    // villagers' pig pen, the priest's cross, the needles, Stitches, the
    // neighbour) when every standing player lost that fight together: the
    // defeat turns "can lose" back on (FH_CoopRoam "Defeat scenes").
    var scene = null;
    if (BattleManager._canLose && $.coopNoLose()) {
        BattleManager._canLose = false;
        scene = $.defeatScene(this);
        BattleManager._fhScene = scene ? { list: scene.list, from: scene.from, to: scene.to, interp: this } : null;
        $.dlog('co-op: this battle cannot be lost (a defeat is a down)', 'troop', $.troopIdOf(this),
            scene ? '- capture scene if everyone standing loses it' : '');
    }
    if (hostBattle && $dataTroops[troopId]) {
        var bid = $.newBid();
        // outside a session (the tutorial) each player has its own world
        $.battles[bid] = {
            bid: bid, owner: 'host', troopId: troopId, eventId: this._eventId,
            mapId: $gameMap.mapId(), joiners: [], scene: scene,
            ownWorld: !$.sessionActive() || !!($.tutorialJoinMap && $.tutorialJoinMap())
        };
        $.freezeEvent(this._eventId, bid);
        $.authBattle = { bid: bid, owner: 'host', joiners: [], troopId: troopId, interp: this };
    }
    return result;
};

// A shared game (not a solo tutorial): no "can lose" battles.
$.coopNoLose = function() {
    if (!$.role) return false;
    if ($.isHost()) return $.sessionActive();
    return !!$.myActorId && (!$.solo || !!$.solo.roam);
};

// The "if lose" branch of the Battle Processing at list[index], or null:
// { list: its commands as a list of their own (indents from 0), from / to:
// where they are in that list }.
$.loseBranchOf = function(list, index) {
    var at = list && list[index];
    if (!at || at.code !== 301) return null;
    var ind = at.indent;
    for (var i = index + 1; i < list.length && list[i].indent >= ind; i++) {
        var c = list[i];
        if (c.indent > ind || c.code === 601 || c.code === 602) continue;
        if (c.code !== 603) return null;
        var out = [];
        for (var j = i + 1; j < list.length && list[j].indent > ind; j++) {
            out.push({ code: list[j].code, indent: list[j].indent - ind - 1, parameters: list[j].parameters });
        }
        var last = out[out.length - 1];
        if (!last || last.code !== 0 || last.indent !== 0) out.push({ code: 0, indent: 0, parameters: [] });
        return { list: out, from: i + 1, to: j };
    }
    return null;
};

// A transfer in the list or in a common event it calls.
$.listMoves = function(list, seen) {
    seen = seen || {};
    return (list || []).some(function(c) {
        if (c.code === 201) return true;
        if (c.code !== 117 || seen[c.parameters[0]]) return false;
        seen[c.parameters[0]] = true;
        var ce = $dataCommonEvents[c.parameters[0]];
        return !!ce && $.listMoves(ce.list, seen);
    });
};

// The capture scene of the battle this interpreter starts: its "if lose"
// branch when that moves the player (data, 2026-10-19: 181 of the 316
// battles that can be lost; the others' branch is CE66 + CE47 game over).
$.defeatScene = function(interp) {
    var branch = $.loseBranchOf(interp._list, interp._index);
    return branch && $.listMoves(branch.list) ? branch : null;
};

// Others can join the host's fight (in the tutorial only some: FH_CoopRoam).
$.hostFightJoinable = function() {
    return $.sessionActive();
};

// Leftover joiner flags (older saves) would lock that actor's input.
var _BattleManager_setup = BattleManager.setup;
BattleManager.setup = function(troopId, canEscape, canLose) {
    $gameParty.members().forEach(function(a) { $.stripJoinFlags(a); });
    this._fhScene = null; // set by the Battle Processing that starts it
    $.hostDuelLost = false; // a lost duel's "no down" is for that duel only
    _BattleManager_setup.call(this, troopId, canEscape, canLose);
};

// A save made during a guest's fight must not keep that enemy frozen.
var _extractSaveContents = DataManager.extractSaveContents;
DataManager.extractSaveContents = function(contents) {
    _extractSaveContents.call(this, contents);
    if ($gameMap) $gameMap.events().forEach(function(ev) { ev._fhBattle = 0; });
    if ($gameActors) $gameActors._data.forEach(function(a) { $.stripJoinFlags(a); });
};

// A guest's event starts a battle: the guest's PC runs it.
Game_Interpreter.prototype.fhDelegateBattle = function() {
    var conn = $.clientById(this._fhOwner);
    var troopId = $.troopIdOf(this);
    if (!conn || !$dataTroops[troopId]) return true;
    var bid = $.newBid();
    conn.inBattle = bid;
    $.battles[bid] = {
        bid: bid, owner: conn.guestId, troopId: troopId, eventId: this._eventId,
        mapId: $gameMap.mapId(), joiners: [], interp: this,
        // this PC decides it when the result comes (FH_CoopRoam "Defeat scenes")
        scene: this._params[3] ? $.defeatScene(this) : null
    };
    $.freezeEvent(this._eventId, bid);
    this._fhBattleWait = bid;
    this.setWaitMode('fhBattle');
    var me = $.meData(conn);
    $.dlog('delegate battle', conn.name, 'troop', troopId);
    conn.send({
        t: 'battle', bid: bid, troopId: troopId, ce: !!this._params[2], cl: false, // no "can lose" in co-op
        sw: $gameSwitches._data, v: $gameVariables._data, ss: $gameSelfSwitches._data,
        actor: me.actor, inv: me.inv
    });
    return true;
};

var _updateWaitMode = Game_Interpreter.prototype.updateWaitMode;
Game_Interpreter.prototype.updateWaitMode = function() {
    if (this._waitMode === 'fhBattle') {
        if (this._fhBattleWait) return true;
        this._waitMode = '';
        return false;
    }
    return _updateWaitMode.call(this);
};

//-----------------------------------------------------------------------------
// Guest: run the delegated battle
//-----------------------------------------------------------------------------

$.guestHandlers.battle = function(msg) {
    $.dlog('battle start (local)', msg.troopId);
    var sw = msg.sw || [], v = msg.v || [];
    $gameSwitches._data = sw.slice();
    $gameVariables._data = v.slice();
    $gameSelfSwitches._data = Object.assign({}, msg.ss || {});
    $gameMap.requestRefresh(); // (no setValue: a same-value write refreshes nothing now)
    $.applyMe({ actorId: $.myActorId, actor: msg.actor, inv: msg.inv });
    $.localBattle = {
        bid: msg.bid, result: undefined,
        sw0: sw.slice(), v0: v.slice(), ss0: Object.assign({}, msg.ss || {})
    };
    $.authBattle = { bid: msg.bid, owner: $.myId, joiners: [], troopId: msg.troopId };
    BattleManager.setup(msg.troopId, msg.ce, msg.cl);
    BattleManager.setEventCallback(function(n) {
        if ($.localBattle) $.localBattle.result = n;
    });
    $gamePlayer.makeEncounterCount();
    SceneManager.push(Scene_Battle);
};

$.diffArray = function(now, before) {
    var out = [];
    var n = Math.max(now.length, before.length);
    for (var i = 1; i < n; i++) {
        if (now[i] !== before[i] && !(now[i] == null && before[i] == null)) out.push([i, now[i]]);
    }
    return out;
};

$.diffObject = function(now, before) {
    var out = [];
    Object.keys(now).forEach(function(k) {
        if (now[k] !== before[k]) out.push([k, now[k]]);
    });
    Object.keys(before).forEach(function(k) {
        if (!(k in now)) out.push([k, null]);
    });
    return out;
};

$.finishLocalBattle = function(result, dead) {
    var lb = $.localBattle;
    if (!lb || lb.sent) return;
    lb.sent = true;
    var actor = $gameActors.actor($.myActorId);
    var joinerActors = ($.authBattle && $.authBattle.joiners || []).map(function(id) {
        return { id: id, a: $.joinerActor(id) };
    }).filter(function(j) { return j.a; });
    // a duel: this player's own limbs lost in it (endAuthBattle clears the
    // duel); the other PC gets this body once more (dead or not)
    var cuts = $.duelSelfCuts ? $.duelSelfCuts() : [];
    if (lb.pvp && $.sendDuelBody) $.sendDuelBody();
    $.endAuthBattle(result);
    $.conn.send({
        t: 'battleEnd', bid: lb.bid, r: result, dead: !!dead,
        actor: $.actorJson(actor),
        inv: { i: $gameParty._items, w: $gameParty._weapons, a: $gameParty._armors, g: $gameParty._gold },
        swd: $.diffArray($gameSwitches._data, lb.sw0),
        vd: $.diffArray($gameVariables._data, lb.v0),
        ssd: $.diffObject($gameSelfSwitches._data, lb.ss0),
        joiners: joinerActors.map(function(j) { return { id: j.id, actor: $.actorJson(j.a) }; }),
        pvp: lb.pvp ? { won: result === 0 && !dead, cuts: cuts } : null
    });
    $.localBattle = null;
    if (dead) {
        $gameParty.reviveBattleMembers();
        // CE500's black tint and flags on this PC: the game goes on (a down)
        $.undoDeathFlow('self', 'down after its fight');
        if ($.resyncScreenFromHost && $.isThin()) $.resyncScreenFromHost('down after its fight');
        _goto.call(SceneManager, Scene_Map);
    }
};

var _endBattle = BattleManager.endBattle;
BattleManager.endBattle = function(result) {
    var ab = $.authBattle;
    var abort = result === 2 && !this._canLose && $.isHost() && ab && ab.owner === 'host' && ab.interp;
    _endBattle.call(this, result);
    if (abort && ab.interp._list) ab.interp._index = ab.interp._list.length;
    if ($.localBattle && !$.localBattle.sent) {
        $.localBattle.result = result;
        $.localBattle.ended = true;
    } else if ($.isHost() && $.authBattle && $.authBattle.owner === 'host') {
        $.endAuthBattle(result);
        $.finishHostBattle(result);
    }
};

// The guest is back on the map after its battle.
var _Scene_Map_start = Scene_Map.prototype.start;
Scene_Map.prototype.start = function() {
    _Scene_Map_start.call(this);
    if ($.isGuest() && $.localBattle && $.localBattle.ended) {
        $.finishLocalBattle($.localBattle.result, false);
    }
    $.applyMeAfterBattle();
};

// A 'me' that comes while a thin guest is still on its battle screen (the
// host's copy after a duel, a joined fight or its own) is only kept there;
// it is the newer copy, so it goes on once the map is back. (A lost test
// duel left the guest's own copy dead while the host had restored it.)
$.meAfterBattle = false;
var _guestMeAfterBattle = $.guestHandlers.me;
$.guestHandlers.me = function(msg) {
    var scene = SceneManager._scene;
    var inBattle = scene instanceof Scene_Battle || ($gameParty && $gameParty.inBattle());
    // (not one from the middle of this PC's fight: its result comes after)
    var over = !$.puppet && (!$.localBattle || $.localBattle.sent || $.localBattle.ended);
    _guestMeAfterBattle(msg);
    if ($.isGuest() && !(scene instanceof Scene_Map) && inBattle && over && msg && msg.actorId === $.myActorId) {
        $.meAfterBattle = true;
    }
};

$.applyMeAfterBattle = function() {
    if (!$.meAfterBattle || !$.isGuest()) return;
    if (!(SceneManager._scene instanceof Scene_Map) || $gameParty.inBattle() || $.localBattle || $.puppet) return;
    $.meAfterBattle = false;
    if ($.isThin() && $.lastMe && $.lastMe.actorId === $.myActorId && !$.pendingSnapshot) $.applyMe($.lastMe);
};

//-----------------------------------------------------------------------------
// Host: results
//-----------------------------------------------------------------------------

// Whose PC reports this battle's end: its owner's; a duel's, both players'
// (each runs its own battle).
$.reportsFor = function(b, id) {
    return !!b && (b.owner === id || (!!b.pvp && (b.attackerId === id || b.foeId === id)));
};

$.hostHandlers.battleEnd = function(conn, msg) {
    var b = $.battles[msg.bid];
    // a duel already settled by the other side's report: this PC gets its
    // character as the host has it now (healed winner, restored test duel)
    if (!b && $.settledDuels && $.settledDuels[msg.bid]) {
        // (only its mark of this duel: not one of a fight that began since)
        if (!conn.inBattle || String(conn.inBattle) === String(msg.bid) || !$.battles[conn.inBattle]) conn.inBattle = 0;
        conn._lastMeKey = null;
        $.pushMe(conn);
        return;
    }
    if (!b || !$.reportsFor(b, conn.guestId)) return;
    if (!b.pvp) delete $.battles[msg.bid];
    conn.inBattle = 0;
    if (!b.pvp) $.unfreezeBattle(b);
    var skip = {};
    // (and each player's own "a scene runs" / ladder flags: CE500 turns the
    // owner's SW202 / SW410 on before a lost fight's game over; the host's own
    // then stopped its run key and its needs)
    $.SELECT_SWITCHES.concat([10, 11, 12, 13], $.CTX_OWN_SWITCHES || []).forEach(function(id) { skip[id] = true; });
    (msg.swd || []).forEach(function(d) { if (!skip[d[0]]) $gameSwitches._data[d[0]] = d[1]; });
    (msg.vd || []).forEach(function(d) { if (!$.battleVar(d[0])) $gameVariables._data[d[0]] = d[1]; });
    (msg.ssd || []).forEach(function(d) {
        if (d[1] === null) delete $gameSelfSwitches._data[d[0]]; else $gameSelfSwitches._data[d[0]] = d[1];
    });
    $gameMap.requestRefresh();
    $.hostHandlers.syncMe(conn, { actorId: conn.actorId, actor: msg.actor, inv: msg.inv });
    $.applyJoinerResults(b, msg.joiners || []);
    var interp = b.interp;
    if (b.pvp) {
        $.duelReport(b, conn.guestId, msg.pvp || { won: false });
    } else if (msg.dead) {
        if (interp) interp._index = interp._list.length;
        $.onPlayerDefeated(conn.guestId);
    } else {
        if (interp) interp._branch[interp._indent] = msg.r;
        // won by the joiners while the owner lay dead
        var own = $.actorOfPlayer(conn.guestId);
        if (own && own.isDead()) $.onPlayerDefeated(conn.guestId);
    }
    if (interp) interp._fhBattleWait = 0;
    $.pushMe(conn);
};

$.applyJoinerResults = function(b, list) {
    list.forEach(function(j) {
        var conn = $.clientById(j.id);
        var actor = $.parseActor(j.actor);
        if (j.id === 'host') {
            if (actor) $gameActors._data[actor._actorId] = actor;
        } else if (conn && actor && actor._actorId === conn.actorId) {
            $gameActors._data[conn.actorId] = actor;
        }
        if (conn) conn.inBattle = 0;
        if (j.id === 'host') $.hostInJoin = 0;
        var a = $.actorOfPlayer(j.id);
        if (a && a.isDead()) $.onPlayerDefeated(j.id);
        if (conn) $.pushMe(conn);
    });
    b.joiners.forEach(function(id) {
        var c = $.clientById(id);
        if (c) c.inBattle = 0;
    });
};

// Host's own battle ended (won, escaped, or lost with "can lose").
$.finishHostBattle = function(result) {
    var bid = Object.keys($.battles).filter(function(k) {
        return $.battles[k].owner === 'host' && !$.battles[k].pvp; // duels settle in finishPvp
    })[0];
    var b = bid && $.battles[bid];
    if (!b) return;
    delete $.battles[bid];
    $.unfreezeBattle(b);
    var joiners = b.joiners.map(function(id) {
        var a = $.actorOfPlayer(id);
        return { id: id, actor: $.actorJson(a) };
    });
    $.applyJoinerResults(b, joiners);
    if ($.ownerDownAfterBattle) {
        $.ownerDownAfterBattle = false;
        $.onPlayerDefeated('host');
    }
};

// Host lost a battle that cannot be lost: down on the map instead of game
// over. The event goes on as after a defeat.
$.endHostBattleDefeated = function() {
    var pb = $.pvpBattle;
    if (pb || $.hostDuelLost) {
        // the host lost its own duel: no down, the duel's result decides
        // (BattleManager.endBattle below reports it; this is for a game over
        // that came without it)
        $.dlog('host lost a duel');
        $.hostDuelLost = false;
        var duel = pb ? $.battles[pb.bid] : null;
        var cuts = pb ? $.duelSelfCuts() : [];
        if (pb) $.sendDuelBody();
        $.endAuthBattle(2);
        $gameParty.reviveBattleMembers();
        _goto.call(SceneManager, Scene_Map);
        if (duel) $.duelReport(duel, 'host', { won: false, cuts: cuts });
        return;
    }
    $.dlog('host lost a battle: down');
    var cb = BattleManager._eventCallback;
    var interp = $.authBattle && $.authBattle.interp;
    BattleManager._eventCallback = null;
    $.endAuthBattle(2);
    $.finishHostBattle(2);
    if (BattleManager._canLose) {
        if (cb) cb(2);
    } else if (interp && interp._list) {
        interp._index = interp._list.length; // no "if lose" branch: the event stops
    }
    $gameParty.reviveBattleMembers();
    var actor = $.actorOfPlayer('host');
    if (actor) actor.setHp(1);
    BattleManager.replayBgmAndBgs();
    _goto.call(SceneManager, Scene_Map);
    $.onPlayerDefeated('host');
};

// Death of a player whose connection is already gone.
$.markDeadConn = function(conn, text) {
    if (!conn || !conn.name || $.coopDead()[conn.name]) return;
    $.coopDead()[conn.name] = true;
    var sw = $.DEATH_SWITCH[conn.actorId];
    if (sw && !$gameSwitches.value(sw)) {
        $gameSwitches.setValue(sw, true);
        $gameVariables.setValue($.CHARACTERS_LEFT_VAR, $gameVariables.value($.CHARACTERS_LEFT_VAR) - 1);
    }
    if (!$.quietDeath) $.broadcastToast(text || conn.name + ' fled the duel and died.');
};

$.onGuestClosedBattle = function(conn) {
    Object.keys($.battles).forEach(function(bid) {
        var b = $.battles[bid];
        if (b.pvp && (b.attackerId === conn.guestId || b.foeId === conn.guestId)) {
            // a duelist left: it loses (and dies), the other one wins (a
            // test duel: nobody dies, leaving it either)
            // (a duel to the death: its one line, "<winner> killed <it>.", is
            // the only one)
            $.quietDeath = !!b.lethal;
            try {
                if (!b.test) $.markDeadConn(conn);
            } finally {
                $.quietDeath = false;
            }
            $.duelReport(b, conn.guestId, { won: false, gone: true });
            return;
        }
        if (b.owner === conn.guestId) {
            delete $.battles[bid];
            $.unfreezeBattle(b);
            if (b.interp) {
                b.interp._branch[b.interp._indent] = 1; // as if escaped
                b.interp._fhBattleWait = 0;
            }
            b.joiners.forEach(function(id) {
                $.bSend(id, { t: 'bEnd', bid: b.bid, r: 1 });
                var c = $.clientById(id);
                if (c) c.inBattle = 0;
                if (id === 'host') $.hostInJoin = 0;
            });
        } else if (b.joiners.indexOf(conn.guestId) >= 0) {
            b.joiners = b.joiners.filter(function(id) { return id !== conn.guestId; });
            $.bSend(b.owner, { t: 'bLeave', bid: b.bid, from: conn.guestId });
        }
    });
    // leaving does not get a down player out of it: back down on re-join
    var down = $.downs[conn.guestId];
    if (down && conn.name) {
        var left = $.coopData().downLeftMs = $.coopData().downLeftMs || {};
        left[conn.name] = Math.max(1000, $.downLeftMs(conn.guestId));
    }
    delete $.downs[conn.guestId];
    if ($.owned[conn.guestId]) $.finishOwned(conn.guestId);
    // the last one standing left while the host is down: the game is over
    // now, not when the host's 60 seconds run out (final review D B5)
    if ($.hostInGame && $.isDown('host') && $.othersAlive(conn.guestId).length === 0) {
        $.dlog('the last player standing left - everyone is down');
        $.hostDies();
    }
};

var _sendAssignDown = $.sendAssign;
$.sendAssign = function(conn, actorId) {
    _sendAssignDown(conn, actorId);
    var data = $.coopData();
    var ms = data.downLeftMs && data.downLeftMs[conn.name];
    // (an older save: frames of 1/60 s)
    if (!ms && data.downLeft && data.downLeft[conn.name]) ms = data.downLeft[conn.name] * 1000 / 60;
    if (!ms || conn.solo) return;
    $.downs[conn.guestId] = { end: $.clockMs() + ms };
    if (data.downLeftMs) delete data.downLeftMs[conn.name];
    if (data.downLeft) delete data.downLeft[conn.name];
    $.dlog('back down after re-join', conn.name);
    $.broadcastState(conn.guestId);
};

var _onGuestClosed = $.onGuestClosed;
$.onGuestClosed = function(conn) {
    _onGuestClosed(conn);
    $.onGuestClosedBattle(conn);
};

//=============================================================================
// Joining a battle
//=============================================================================

$.battleAtTile = function(x, y) {
    var found = 0;
    Object.keys($.battles).forEach(function(bid) {
        var b = $.battles[bid];
        if (found || b.mapId !== $gameMap.mapId()) return;
        // a fight in the owner's own copy of the world (tutorial): not this enemy
        var ev = b.soloWorld ? null : $gameMap.event(b.eventId);
        if (ev && ev.pos(x, y)) found = b.bid;
        var owner = b.owner === $.myPlayerId() ? $gamePlayer : $.remotes[b.owner];
        if (owner && owner.pos(x, y)) found = b.bid;
    });
    return found;
};

$.eventStartHooks.push(function(conn, ev) {
    if (!ev._fhBattle) return false;
    $.requestJoin(conn.guestId, ev._fhBattle);
    return true;
});

$.actHooks.push(function(conn, msg) {
    if (msg.tr.indexOf(0) < 0) return false;
    var bid = $.battleAtTile(msg.x, msg.y);
    if (!bid) return false;
    $.requestJoin(conn.guestId, bid);
    return true;
});

var _Game_Event_start = Game_Event.prototype.start;
Game_Event.prototype.start = function() {
    if ($.isHost() && this._fhBattle && !$gamePlayer._fhRemoteId) {
        $.requestJoin('host', this._fhBattle);
        return;
    }
    if (this._fhBattle) return; // frozen in a fight
    _Game_Event_start.call(this);
};

$.requestJoin = function(id, bid) {
    var b = $.battles[bid];
    var conn = id === 'host' ? null : $.clientById(id);
    var why = '';
    if (!b) return;
    if (b.owner === id || b.joiners.indexOf(id) >= 0) return;
    if (b.pvp && $.tourney) { // the tower door during a duel
        $.towerDoorTell(id, 'busy');
        return;
    }
    if (b.pvp || $.NO_JOIN_TROOPS.indexOf(b.troopId) >= 0) why = 'this fight is one on one';
    else if ($.fightFull(b)) why = 'the fight is full';
    else if ($.isDown(id)) why = 'you are down';
    else if (conn && $.isBusy(conn)) why = 'you are busy';
    else if (id === 'host' && ($gameParty.inBattle() || $gameMap.isEventRunning())) why = 'you are busy';
    if (why) {
        $.sendTo(id, { t: 'toast', text: 'Co-op: cannot join - ' + why });
        return;
    }
    b.joiners.push(id);
    if (conn) conn.inBattle = bid;
    if (id === 'host') $.hostInJoin = bid;
    var actor = $.actorOfPlayer(id);
    $.dlog('join battle', $.playerLabel(id), '->', b.bid);
    $.bSend(b.owner, { t: 'bJoin', bid: b.bid, jid: id, actor: $.actorJson(actor) });
};

//-----------------------------------------------------------------------------
// Authority side: add the joiner, stream the battle to it
//-----------------------------------------------------------------------------

$.joinerActor = function(id) {
    var list = $gameParty.battleMembers().filter(function(a) { return a._fhJoiner === id; });
    return list[0] || null;
};

$.guestHandlers.bJoin = function(msg) {
    var ab = $.authBattle;
    // asked while the battle screen is still opening: added when it starts
    if (ab && ab.bid === msg.bid && msg.actor && !$gameParty.inBattle()) {
        (ab.pendingJoins = ab.pendingJoins || []).push(msg);
        return;
    }
    if (!ab || ab.bid !== msg.bid || !$gameParty.inBattle() || !msg.actor) return;
    if ($gameParty.battleMembers().length >= $gameParty.maxBattleMembers()) {
        if ($.isHost()) {
            var b = $.battles[msg.bid];
            if (b) b.joiners = b.joiners.filter(function(id) { return id !== msg.jid; });
            $.applyJoinerResults({ joiners: [] }, [{ id: msg.jid, actor: msg.actor }]);
            $.sendTo(msg.jid, { t: 'toast', text: 'Co-op: cannot join - the fight is full' });
        } else {
            $.conn.send({ t: 'bLeft', bid: msg.bid, jid: msg.jid, actor: msg.actor });
        }
        return;
    }
    var actor = $.parseActor(msg.actor);
    actor._fhJoiner = msg.jid;
    actor._fhAwait = false;
    actor._fhRemoteReady = false;
    actor._atbActsSinceFoe = 0; // (counted on its own PC before it came)
    actor._atbActedSinceFoe = false;
    actor.setAtbGauge(0);
    if (!$.isHost() || msg.jid !== 'host') $gameActors._data[actor._actorId] = actor;
    if ($gameParty._actors.indexOf(actor._actorId) < 0) $gameParty._actors.push(actor._actorId);
    actor.onBattleStart();
    if (actor.setupBattleBP) actor.setupBattleBP(); // Boost Points as at a battle start
    ab.joiners.push(msg.jid);
    var label = actor.name();
    $.battleGab(label + ' has joined the battle!');
    $.bSend(msg.jid, $.battleViewMessage());
    // a dialogue already on this screen: the newcomer reads it too
    if ($.lastBDialog && $gameMessage.isBusy()) $.bSend(msg.jid, $.lastBDialog);
    $.broadcastParty(msg.jid);
    $.refreshBattleStatus();
};

// Joins and leaves: the other joiners' screens get the new party.
$.broadcastParty = function(except) {
    var ab = $.authBattle;
    if (!ab) return;
    var view = $.battleViewMessage();
    ab.joiners.forEach(function(id) {
        if (id !== except) $.bSend(id, { t: 'bParty', bid: view.bid, actors: view.actors });
    });
};

$.refreshBattleStatus = function() {
    var scene = SceneManager._scene;
    if (scene instanceof Scene_Battle && scene._statusWindow) scene._statusWindow.refresh();
};

$.battleViewMessage = function() {
    var ab = $.authBattle;
    return {
        t: 'bView', bid: ab.bid, owner: $.myPlayerId(), troopId: ab.troopId,
        actors: $gameParty.battleMembers().map(function(a) {
            return { id: a.actorId(), json: $.actorJson(a), j: a._fhJoiner || $.myPlayerId() };
        }),
        st: $.battleStateData()
    };
};

$.battleStateData = function() {
    return {
        e: $gameTroop.members().map(function(e) {
            return [e.enemyId(), e.hp, e.mp, e._states.slice(), e.isHidden() ? 1 : 0, e.isAlive() ? 1 : 0];
        }),
        a: $gameParty.battleMembers().map(function(a) {
            return [a.actorId(), a.hp, a.mp, a._states.slice(), Math.round(a.atbGauge ? a.atbGauge() : 0),
                a.storedBP ? a.storedBP() : 0, // Boost Points (the eye icons, Olivia_OctoBattle)
                a.battlerName(), a.faceName(), a.faceIndex()]; // limb loss and beheading change them (CE240-245)
        }),
        t: $gameTroop.turnCount()
    };
};

$.battleParticipants = function() {
    var ab = $.authBattle;
    return ab ? ab.joiners.slice() : [];
};

$.battleBroadcast = function(msg) {
    var ab = $.authBattle;
    if (!ab || !$gameParty.inBattle()) return;
    msg.bid = ab.bid;
    $.battleViewers().forEach(function(id) { $.bSend(id, msg); });
};

$.joinersAlive = function() {
    return $.battleParticipants().some(function(id) {
        var a = $.joinerActor(id);
        return a && a.isAlive();
    });
};

// Small battle message (the same box as "the needles waltz towards you").
$.battleGab = function(text, local) {
    var scene = SceneManager._scene;
    if (scene && scene._gabWindow) {
        try {
            var interp = new Game_Interpreter();
            // unwrapped: the 'gab' broadcast below already reaches the joiners
            _pluginCommand.call(interp, 'GabText', String(text).split(' '));
            _pluginCommand.call(interp, 'ShowGab', []);
        } catch (e) {
            $.toast('Co-op: ' + text);
        }
    } else {
        $.toast('Co-op: ' + text);
    }
    if (!local) $.battleBroadcast({ t: 'bFx', k: 'gab', text: text });
};

var _pluginCommand = Game_Interpreter.prototype.pluginCommand;
Game_Interpreter.prototype.pluginCommand = function(command, args) {
    _pluginCommand.call(this, command, args);
    if ($gameParty.inBattle() && $.authBattle && $.battleViewers().length && !$.puppet &&
            (command === 'GabText' || command === 'ShowGab')) {
        $.battleBroadcast({ t: 'bFx', k: 'plug', c: command, a: args });
    }
};

// Animations, damage numbers, collapse effects shown on the joiners' PCs.
// $.fxEcho: an effect replayed here from another PC (a duel) is not sent on.
$.fxEcho = false;
$.battlerRef = function(battler) {
    if (battler.isEnemy()) return ['e', $gameTroop.members().indexOf(battler)];
    return ['a', battler.actorId()]; // party order differs between PCs
};

var _startAnimation = Game_Battler.prototype.startAnimation;
Game_Battler.prototype.startAnimation = function(animationId, mirror, delay) {
    _startAnimation.call(this, animationId, mirror, delay);
    if ($.authBattle && $.battleViewers().length && $gameParty.inBattle() && !$.puppet && !$.fxEcho) {
        var ref = $.battlerRef(this);
        $.battleBroadcast({ t: 'bFx', k: 'anim', s: ref[0], i: ref[1], a: animationId, m: mirror, d: delay });
    }
};

// YEP keeps a battler's damage popups in a list; the engine's own value is
// false (a new battler, a copy parsed from JSON), and YEP turns it into a
// list only when the battler's sprite first looks at it. A popup started
// before that threw "this._damagePopup.push is not a function": another
// PC's hit replayed on this player's own character (bFx), which no sprite
// drew while the party was still the host's character (guest log,
// 0.38.3-pre duel: on every hit), or right after a copy replaced it.
$.popupReady = function(battler) {
    if (!battler || Array.isArray(battler._damagePopup)) return;
    if (battler.clearDamagePopup) battler.clearDamagePopup();
    if (!Array.isArray(battler._damagePopup)) battler._damagePopup = [];
};

var _startDamagePopup = Game_Battler.prototype.startDamagePopup;
Game_Battler.prototype.startDamagePopup = function() {
    $.popupReady(this);
    _startDamagePopup.call(this);
    if ($.authBattle && $.battleViewers().length && $gameParty.inBattle() && !$.puppet && !$.fxEcho) {
        var ref = $.battlerRef(this);
        var r = this.result();
        $.battleBroadcast({ t: 'bFx', k: 'pop', s: ref[0], i: ref[1], r: {
            used: r.used, missed: r.missed, evaded: r.evaded, critical: r.critical,
            hpAffected: r.hpAffected, hpDamage: r.hpDamage, mpDamage: r.mpDamage
        } });
    }
};

var _performCollapse = Game_Enemy.prototype.performCollapse;
Game_Enemy.prototype.performCollapse = function() {
    _performCollapse.call(this);
    if ($.authBattle && $.battleViewers().length && !$.puppet && !$.fxEcho) {
        $.battleBroadcast({ t: 'bFx', k: 'collapse', i: $gameTroop.members().indexOf(this) });
    }
};

// Hit, dodge and fall motions (shake, damage pose, sounds) on the joiners'
// screens too: their copies never run the actions.
// Wrapped where each is defined last (Game_Actor's own versions call the
// Game_Battler one, so that one is not wrapped again for actors).
$.PERF_FX = [
    [Game_Actor, 'performDamage'], [Game_Enemy, 'performDamage'], [Game_Actor, 'performCollapse'],
    [Game_Actor, 'performEvasion'], [Game_Enemy, 'performEvasion'],
    [Game_Actor, 'performMagicEvasion'], [Game_Enemy, 'performMagicEvasion']
];
$.PERF_NAMES = {};

$.PERF_FX.forEach(function(entry) {
    var cls = entry[0], name = entry[1];
    var base = cls.prototype[name];
    $.PERF_NAMES[name] = true;
    cls.prototype[name] = function() {
        base.apply(this, arguments);
        if ($.authBattle && $.battleViewers().length && $gameParty.inBattle() && !$.puppet && !$.fxEcho) {
            var ref = $.battlerRef(this);
            $.battleBroadcast({ t: 'bFx', k: 'perf', f: name, s: ref[0], i: ref[1] });
        }
    };
});

// A character's own action on the joiners' screens: the swing (thrust,
// skill, item) and its weapon picture (play test 2026-10-31: Marina's attack
// showed only on the host's screen, hers stood still). Hits and falls come
// with 'perf' above.
$.ACTION_MOTIONS = { thrust: true, swing: true, missile: true, skill: true, spell: true, item: true };
['requestMotion', 'forceMotion'].forEach(function(name) {
    var base = Game_Battler.prototype[name];
    Game_Battler.prototype[name] = function(motionType) {
        base.call(this, motionType);
        if (this.isActor() && $.ACTION_MOTIONS[motionType] && $.authBattle && $.battleViewers().length &&
                $gameParty.inBattle() && !$.puppet && !$.fxEcho) {
            $.battleBroadcast({ t: 'bFx', k: 'motion', f: name, s: 'a', i: this.actorId(), m: motionType });
        }
    };
});

var _startWeaponAnimation = Game_Battler.prototype.startWeaponAnimation;
Game_Battler.prototype.startWeaponAnimation = function(weaponImageId) {
    _startWeaponAnimation.call(this, weaponImageId);
    if (this.isActor() && weaponImageId && $.authBattle && $.battleViewers().length &&
            $gameParty.inBattle() && !$.puppet && !$.fxEcho) {
        $.battleBroadcast({ t: 'bFx', k: 'weapon', s: 'a', i: this.actorId(), w: weaponImageId });
    }
};

// a joiner's copy (no broadcast from here: $.puppet)
$.playPerf = function(target, name) {
    if ($.PERF_NAMES[name] && typeof target[name] === 'function') target[name]();
};

$.battleStreamFrame = 0;
var _BattleManager_update = BattleManager.update;
BattleManager.update = function() {
    if ($.puppet) {
        $.updatePuppet();
        return;
    }
    _BattleManager_update.call(this);
    $.streamBattleState();
};

// The battle state (HP, states, gauges) to the joiners' views, once a frame
// at most. Also called from Scene_Battle.update: while this PC's player has
// its command window open the scene does not update BattleManager, and the
// joiners' gauges froze half full (0.38.1 play test).
$.lastStreamFrame = -1;
$.streamBattleState = function() {
    if (!$.authBattle || !$.battleViewers().length) return;
    if ($.lastStreamFrame === Graphics.frameCount) return;
    $.lastStreamFrame = Graphics.frameCount;
    if (++$.battleStreamFrame % 6 !== 0) return;
    // Gauges stop during actions, messages and events: skip the send
    // while nothing changed, but repeat it once a second regardless.
    var st = $.battleStateData();
    var key = $.authBattle.bid + JSON.stringify(st);
    if (key !== $.lastBStateKey || $.battleStreamFrame % 60 === 0) {
        $.lastBStateKey = key;
        $.battleBroadcast({ t: 'bState', st: st });
    }
};

// Who gets the battle stream: the joiners (and, see "Duel: both sides"
// below, the other duelist).
$.battleViewers = function() {
    var ab = $.authBattle;
    return ab ? ab.joiners : [];
};

// A joiner whose gauge fills while this PC's player is choosing is asked at
// once (its PC shows its command window); before, it waited until the
// player here had chosen. Its answer then interrupts the window like a
// ready enemy does (_fhRemoteReady).
// A joiner asked for its command chooses too: the enemies slow down for it
// as for the player here, on its own first turn(s) since they acted (FH_ATB
// atbChooseSlows).
var _atbChoosingJoiners = BattleManager.atbChoosing;
BattleManager.atbChoosing = function() {
    if (_atbChoosingJoiners.call(this)) return true;
    var bm = this;
    return !!$.authBattle && !$.puppet && $gameParty.battleMembers().some(function(a) {
        return !!a._fhJoiner && !!a._fhAwait && bm.atbChooseSlows(a);
    });
};

// A joiner at the time-stop speed stops time while it chooses (FH_ATB).
var _atbTimeStopJoiners = BattleManager.atbTimeStopChoosing;
BattleManager.atbTimeStopChoosing = function() {
    if (_atbTimeStopJoiners.call(this)) return true;
    var bm = this;
    return !!$.authBattle && !$.puppet && $gameParty.battleMembers().some(function(a) {
        return !!a._fhJoiner && !!a._fhAwait && bm.atbStopsTime(a);
    });
};

// Other players fight here: the actor gauges slow down too while one
// chooses, and the limit is shorter (FH_ATB atbEnemyPace).
BattleManager.atbCoopBattle = function() {
    return !$.puppet && !!$.authBattle && $.authBattle.joiners.length > 0;
};

$.askReadyJoiners = function() {
    var bm = BattleManager;
    if (!$.authBattle || $.puppet || bm._phase !== 'input' || !bm.isAtb || !bm.isAtb()) return;
    $gameParty.battleMembers().forEach(function(a) {
        if (!a._fhJoiner || a._fhAwait || a._fhRemoteReady || !a.isAtbReady()) return;
        // one that cannot choose (stunned, confused...) acts by itself in the
        // normal turn (startAtbTurn), never through a command window
        if (!a.canInput()) {
            $.logJoinerNoInput(a);
            return;
        }
        a.onTurnStart();
        a.refresh();
        bm.snapshotAtbStates(a);
        a.makeActions();
        a._fhAwait = true;
        $.dlog('joiner ready while choosing:', a.name());
        $.noteInputAsk(a, a._fhJoiner);
        $.bSend(a._fhJoiner, { t: 'bInput', bid: $.authBattle.bid, actorId: a.actorId(), pvp: false });
    });
};

// A joiner asked for its command whose answer (bAction) never comes - its
// view busy for good, a lost message, its PC gone quiet - never got another
// turn in that fight (docs/조사(보관용)/검수/최종검토_A A5). The joiner's PC says when
// its command window opened ('bInputSeen') and, while it chooses, every
// PUPPET_BEAT_MS ('bChoosing', from its game loop: nothing while it is
// minimized or frozen). An ask its PC never showed is asked again after
// INPUT_REASK_MS and guarded after INPUT_GIVEUP_MS of fight time (a troop
// event, a message or a choice on this PC - the gauges wait too - does not
// count). One being chosen is guarded only when its signals stop for
// INPUT_SILENT_MS, or after INPUT_CHOOSE_MAX_MS (its window closes then):
// asking again a player who was choosing opened a second, "ghost" window
// after its pick (0.4 review M1).
$.INPUT_REASK_MS = 10000;  // (real time, $.clockMs)
$.INPUT_GIVEUP_MS = 30000;
$.INPUT_SILENT_MS = 10000;
$.INPUT_CHOOSE_MAX_MS = 90000;
$.PUPPET_BEAT_MS = 3000;
$.inputAsks = {}; // actor id -> { bid, pid, waited, last, asked, seen, beat } (not on the actor: it would be saved)

$.noteInputAsk = function(battler, playerId) {
    if (!battler || !battler.isActor() || !$.authBattle) return;
    $.inputAsks[battler.actorId()] = { bid: $.authBattle.bid, pid: playerId, waited: 0, last: $.clockMs(), asked: 1,
        seen: 0, beat: 0 };
    $.dlog('joiner asked for its command:', battler.name(), '(' + playerId + ')');
};

// The joiner's PC shows the command window / is still choosing.
$.guestHandlers.bInputSeen = function(msg) {
    var ab = $.authBattle;
    if (!ab || !msg || ab.bid !== msg.bid) return;
    var a = $.joinerActor(msg.from || 'host');
    var ask = a && $.inputAsks[a.actorId()];
    if (!ask) return;
    var now = $.clockMs();
    if (!ask.seen) ask.seen = now;
    ask.beat = now;
};
$.guestHandlers.bChoosing = $.guestHandlers.bInputSeen;

$.guardJoiner = function(a, ask, why) {
    delete $.inputAsks[a.actorId()];
    $.dlog('joiner: no command from', ask.pid, 'for', a.name(), '(' + why + ') - guards');
    a._fhAwait = false;
    var guard = new Game_Action(a);
    guard.setGuard();
    a._actions = [guard];
    a._fhRemoteReady = true;
    $.bSend(ask.pid, { t: 'bInputOff', bid: ask.bid, actorId: a.actorId() });
    $.bSend(ask.pid, { t: 'toast', text: 'Co-op: no command came from your PC in time - ' + a.name() + ' guards' });
};

$.inputPaused = function() {
    return $gameTroop.isEventRunning() || $gameMessage.isBusy() || !!$.bDialogWait || !!$.bChoiceWait;
};

// A target picked while no action is being input any more (the turn was
// taken back meanwhile: a re-ask, a Guard after the wait, the ATB, the fight
// handed over) crashed in the original onEnemyOk / onActorOk, "Cannot read
// property 'setTarget' of null" (0.41 play test: the host joined a guest's
// Needles fight). The target window closes and the input goes on safely.
$.targetWithoutAction = function(scene, win) {
    if (BattleManager.inputtingAction()) return false;
    $.dlog('battle: a target was picked with no action being input - back to the commands');
    if (win) {
        win.hide();
        win.deactivate();
    }
    if (BattleManager.actor()) scene.startActorCommandSelection();
    else scene.endCommandSelection();
    return true;
};

var _onEnemyOkNoAction = Scene_Battle.prototype.onEnemyOk;
Scene_Battle.prototype.onEnemyOk = function() {
    if ($.targetWithoutAction(this, this._enemyWindow)) return;
    _onEnemyOkNoAction.call(this);
};

var _onActorOkNoAction = Scene_Battle.prototype.onActorOk;
Scene_Battle.prototype.onActorOk = function() {
    if ($.targetWithoutAction(this, this._actorWindow)) return;
    _onActorOkNoAction.call(this);
};

$.checkInputAsks = function() {
    var ab = $.authBattle, now = $.clockMs();
    Object.keys($.inputAsks).forEach(function(id) {
        var ask = $.inputAsks[id];
        var a = $gameActors.actor(Number(id));
        if (!ab || ab.bid !== ask.bid || !a || !a._fhAwait || !a.isAlive() || $gameParty.battleMembers().indexOf(a) < 0) {
            delete $.inputAsks[id];
            return;
        }
        var gap = now - ask.last;
        if (!$.inputPaused()) ask.waited += Math.max(0, gap);
        ask.last = now;
        if (ask.seen) {
            // (this PC's loop stood still: no silence of the joiner's)
            if (gap > 1000) ask.beat = Math.max(ask.beat, now);
            if (now - ask.beat > $.INPUT_SILENT_MS) $.guardJoiner(a, ask, 'its PC stopped choosing');
            else if (now - ask.seen > $.INPUT_CHOOSE_MAX_MS) $.guardJoiner(a, ask, 'still choosing after ' + $.INPUT_CHOOSE_MAX_MS / 1000 + ' s');
            return;
        }
        if (ask.waited >= $.INPUT_GIVEUP_MS) {
            $.guardJoiner(a, ask, 'nothing in ' + $.INPUT_GIVEUP_MS / 1000 + ' s');
            return;
        }
        if (ask.asked < 2 && ask.waited >= $.INPUT_REASK_MS) {
            ask.asked = 2;
            $.dlog('joiner: no command yet from', ask.pid, 'for', a.name(), '- asked again');
            $.bSend(ask.pid, { t: 'bInput', bid: ab.bid, actorId: a.actorId(), pvp: false });
        }
    });
};

// (a new fight: nothing of the last one's asks)
var _bmSetupInputAsks = BattleManager.setup;
BattleManager.setup = function(troopId, canEscape, canLose) {
    $.inputAsks = {};
    _bmSetupInputAsks.call(this, troopId, canEscape, canLose);
};

// (log, at most every 5 s per joiner: its turn comes without a command window)
$.joinerNoInputLog = {}; // actor id -> ms (not on the actor: it would be saved)
$.logJoinerNoInput = function(a) {
    var now = $.clockMs(), last = $.joinerNoInputLog[a.actorId()];
    if (last && now - last < 5000) return;
    $.joinerNoInputLog[a.actorId()] = now;
    $.dlog('joiner ready but cannot choose - acts by itself:', a.name(), '(hp ' + a.hp + ', states ' +
        JSON.stringify(a._states) + ', restriction ' + a.restriction() + ')');
};

var _sceneBattleUpdateStream = Scene_Battle.prototype.update;
Scene_Battle.prototype.update = function() {
    _sceneBattleUpdateStream.call(this);
    if ($.authBattle && !$.puppet && $gameParty.inBattle()) {
        $.askReadyJoiners();
        $.checkInputAsks();
        $.streamBattleState();
    }
};

// Remote-controlled actors (joiners): commands come from their PCs.
var _isAtbReady = Game_Battler.prototype.isAtbReady;
Game_Battler.prototype.isAtbReady = function() {
    if (this._fhAwait) return false;
    return _isAtbReady.call(this);
};

var _atbEnemyWaiting = BattleManager.atbEnemyWaiting;
BattleManager.atbEnemyWaiting = function() {
    if ($gameParty.battleMembers().some(function(a) { return a._fhRemoteReady && a.isAlive(); })) return true;
    return _atbEnemyWaiting.call(this);
};

var _startAtbTurn = BattleManager.startAtbTurn;
BattleManager.startAtbTurn = function(battler) {
    if (battler._fhRemoteReady) {
        battler._fhRemoteReady = false;
        this._atbActing = battler;
        battler.setAtbGauge(0);
        this._subject = battler;
        this._phase = 'turn';
        return;
    }
    _startAtbTurn.call(this, battler);
    if (battler.isActor() && battler._fhJoiner && this._atbInputActor === battler) {
        this._atbInputActor = null;
        this.changeActor(-1, 'waiting');
        this._phase = 'atb';
        $.requestRemoteInput(battler, battler._fhJoiner);
    }
};

// A joiner who dies keeps no pending input.
var _die = Game_BattlerBase.prototype.die;
Game_BattlerBase.prototype.die = function() {
    _die.call(this);
    this._fhAwait = false;
    this._fhRemoteReady = false;
};

$.requestRemoteInput = function(battler, playerId) {
    battler._fhAwait = true;
    $.noteInputAsk(battler, playerId);
    BattleManager._atbActing = null;
    BattleManager._phase = 'atb';
    $.bSend(playerId, {
        t: 'bInput', bid: $.authBattle.bid,
        actorId: battler.isActor() ? battler.actorId() : 0,
        pvp: battler.isEnemy()
    });
};

$.guestHandlers.bAction = function(msg) {
    var ab = $.authBattle;
    if (!ab || ab.bid !== msg.bid || !$gameParty.inBattle()) return;
    if (msg.pvp) return; // (0.38.2: the duel foe's move; each duelist now fights on its own PC)
    var battler = $.joinerActor(msg.from || 'host');
    if (!battler || !battler._fhAwait) return;
    battler._fhAwait = false;
    if (battler.isActor()) delete $.inputAsks[battler.actorId()];
    if (!battler.isAlive()) return;
    battler.clearActions();
    var action = new Game_Action(battler);
    var item = msg.kind === 'item' ? $dataItems[msg.id] : $dataSkills[msg.id];
    if (!item) item = $dataSkills[battler.attackSkillId ? battler.attackSkillId() : 1];
    if (msg.kind === 'item') action.setItem(item.id); else action.setSkill(item.id);
    action.setTarget(msg.target >= 0 ? msg.target : -1);
    battler._actions = [action];
    // boosted on the joiner's PC: the same points come off here
    var bp = Math.max(0, Math.min(Number(msg.bp) || 0, battler.storedBP ? battler.storedBP() : 0));
    if (bp && battler.setUseBP) {
        battler.gainStoredBP(-bp);
        battler.setUseBP(bp);
    }
    battler._fhRemoteReady = true;
};

$.guestHandlers.bLeave = function(msg) {
    var ab = $.authBattle;
    if (!ab || ab.bid !== msg.bid) return;
    var from = msg.from || 'host';
    var actor = $.joinerActor(from);
    ab.joiners = ab.joiners.filter(function(id) { return id !== from; });
    if (actor) {
        $gameParty._actors = $gameParty._actors.filter(function(id) { return id !== actor.actorId(); });
        actor.onBattleEnd();
        $.stripJoinFlags(actor);
        $.battleGab(actor.name() + ' fled from the battle.');
        var json = $.actorJson(actor);
        if ($.isHost()) {
            var b = $.battles[ab.bid];
            if (b) b.joiners = b.joiners.filter(function(id) { return id !== from; });
            $.applyJoinerResults({ joiners: [] }, [{ id: from, actor: json }]); // the others still fight
        } else {
            $.conn.send({ t: 'bLeft', bid: ab.bid, jid: from, actor: json });
        }
        $.broadcastParty(from);
        $.refreshBattleStatus();
    }
    $.bSend(from, { t: 'bEnd', bid: ab.bid, r: 1, me: actor ? json : null });
};

$.hostHandlers.bLeft = function(conn, msg) {
    var b = $.battles[msg.bid];
    if (!b || b.owner !== conn.guestId) return;
    b.joiners = b.joiners.filter(function(id) { return id !== msg.jid; });
    $.applyJoinerResults({ joiners: [] }, [{ id: msg.jid, actor: msg.actor }]);
};

// Battle over on the authority: release the joiners.
$.endAuthBattle = function(result) {
    var ab = $.authBattle;
    if (!ab) return;
    $.authBattle = null;
    // Each joiner gets its character as the fight left it ('me'): a PC that
    // runs its own map keeps that copy (FH_CoopRoam).
    var finals = {};
    // The party is this player's character again.
    var own = $.isHost() ? $.hostActorId() : $.myActorId;
    var keep = $gameParty._actors.filter(function(id) {
        var a = $gameActors.actor(id);
        return !a || !a._fhJoiner;
    });
    if (keep.indexOf(own) < 0 && own) keep.unshift(own);
    $gameParty.battleMembers().forEach(function(a) {
        if (a._fhJoiner) {
            var jid = a._fhJoiner;
            a.onBattleEnd(); // Scene_Battle only ends the battle for the party left
            $.stripJoinFlags(a);
            finals[jid] = $.actorJson(a);
        }
    });
    ab.joiners.forEach(function(id) {
        $.bSend(id, { t: 'bEnd', bid: ab.bid, r: result, me: finals[id] || null });
    });
    $gameParty._actors = keep;
    // down in the fight: still down after it, unless revived meanwhile
    var ownActor = own ? $gameActors.actor(own) : null;
    if (ab.ownerDown && !(ab.ownerDownDead && ownActor && !ownActor.isDead())) $.ownerDownAfterBattle = true;
    $.pvpBattle = null;
};

//=============================================================================
// Joiner side: the puppet battle view
//=============================================================================

$.puppet = null; // { bid, owner, saveActors, myActorId, input }

$.guestHandlers.bView = function(msg) {
    var myId = $.isHost() ? $.hostActorId() : $.myActorId;
    $.puppet = { bid: msg.bid, owner: msg.owner, saveActors: $gameParty._actors.slice(),
        myActorId: myId, dialogQueue: [], dialogAdvances: {} };
    msg.actors.forEach(function(entry) {
        $gameActors._data[entry.id] = $.parseActor(entry.json);
    });
    $gameParty._actors = msg.actors.map(function(entry) { return entry.id; });
    BattleManager.setup(msg.troopId, true, true);
    $.applyPuppetState(msg.st);
    BattleManager._phase = 'puppet';
    BattleManager.saveBgmAndBgs();
    $.dlog('joined battle view', msg.bid);
    SceneManager.push(Scene_Battle);
};

var _startBattle = BattleManager.startBattle;
BattleManager.startBattle = function() {
    if ($.puppet) {
        this._phase = 'puppet';
        $gameSystem.onBattleStart();
        $gameParty.onBattleStart();
        $gameTroop.onBattleStart();
        $.applyPuppetState($.puppet.lastState);
        if (!$.puppet.spec) $.battleGab($gameActors.actor($.puppet.myActorId).name() + ' has joined the battle!', true);
        return;
    }
    $.talkOwner = $.battleStartTalkOwner();
    _startBattle.call(this);
    var ab = $.authBattle;
    var pending = ab && ab.pendingJoins;
    if (pending) {
        ab.pendingJoins = null;
        pending.forEach(function(m) { $.guestHandlers.bJoin(m); });
    }
};

$.applyPuppetState = function(st) {
    if (!st) return;
    if ($.puppet) $.puppet.lastState = st;
    if (st.t !== undefined) $gameTroop._turnCount = st.t;
    var enemies = $gameTroop.members();
    (st.e || []).forEach(function(d, i) {
        var e = enemies[i];
        if (!e) return;
        if (e.enemyId() !== d[0]) e.transform(d[0]);
        var wasDead = e.isDead();
        e._hp = d[1];
        e._mp = d[2];
        e._states = d[3].slice();
        if (d[4] && !e.isHidden()) e.hide();
        if (!d[4] && e.isHidden()) e.appear();
        // a cut-off limb fades out here too (the owner's PC ran its collapse)
        if (!wasDead && e.isDead()) e.performCollapse();
        if (wasDead && e.isAlive()) e.requestEffect('appear');
    });
    var actors = $gameParty.battleMembers();
    var changed = false;
    (st.a || []).forEach(function(d) {
        var a = $gameActors.actor(d[0]);
        if (!a || actors.indexOf(a) < 0) return;
        if (a._hp !== d[1] || a._mp !== d[2] || !$.sameList(a._states, d[3])) changed = true;
        a._hp = d[1];
        a._mp = d[2];
        a._states = d[3].slice();
        if (a.setAtbGauge) a.setAtbGauge(d[4]); // the gauge sprite redraws itself
        // Boost Points regenerate on the PC that runs the fight; the boost
        // window redraws itself when the count changes. Not while this
        // player is boosting its own command (its local count is newer).
        var choosing = BattleManager._phase === 'input' && $.puppet && d[0] === $.puppet.myActorId;
        if (d[5] !== undefined && !choosing && a._storedBP !== d[5]) a._storedBP = d[5];
        // its picture and face as the fight PC has them (a cut limb, no head)
        if (typeof d[6] === 'string' && a.battlerName() !== d[6]) {
            a.setBattlerImage(d[6]);
            changed = true;
        }
        if (typeof d[7] === 'string' && (a.faceName() !== d[7] || a.faceIndex() !== d[8])) {
            a.setFaceImage(d[7], Number(d[8]) || 0);
            changed = true;
        }
    });
    // This arrives 10 times a second; the status window (text, gauges) is
    // redrawn only when what it shows changed.
    if (changed) $.refreshBattleStatus();
};

$.sameList = function(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
};

$.guestHandlers.bParty = function(msg) {
    if (!$.puppet || msg.bid !== $.puppet.bid) return;
    var now = $gameParty._actors;
    msg.actors.forEach(function(entry) {
        if (now.indexOf(entry.id) < 0) $gameActors._data[entry.id] = $.parseActor(entry.json);
    });
    $gameParty._actors = msg.actors.map(function(entry) { return entry.id; });
    $.refreshBattleStatus();
};

$.guestHandlers.bState = function(msg) {
    if (!$.puppet || msg.bid !== $.puppet.bid) return;
    if ($gameParty.inBattle()) $.applyPuppetState(msg.st); else $.puppet.lastState = msg.st;
};

$.guestHandlers.bFx = function(msg) {
    if (!$.puppet || msg.bid !== $.puppet.bid || !$gameParty.inBattle()) return;
    var target = msg.s === 'e' ? $gameTroop.members()[msg.i] : $gameActors.actor(msg.i);
    if (target && msg.s === 'a' && $gameParty.battleMembers().indexOf(target) < 0) target = null;
    switch (msg.k) {
    case 'anim':
        if (target) _startAnimation.call(target, msg.a, msg.m, msg.d);
        break;
    case 'pop':
        if (target) {
            target.clearResult();
            Object.assign(target._result, msg.r);
            $.popupReady(target);
            _startDamagePopup.call(target);
        }
        break;
    case 'collapse':
        var e = $gameTroop.members()[msg.i];
        if (e) _performCollapse.call(e);
        break;
    case 'perf':
        if (target) $.playPerf(target, msg.f);
        break;
    case 'motion':
        if (target && $.ACTION_MOTIONS[msg.m]) target[msg.f === 'forceMotion' ? 'forceMotion' : 'requestMotion'](msg.m);
        break;
    case 'weapon':
        if (target) target.startWeaponAnimation(msg.w);
        break;
    case 'gab':
        $.battleGab(msg.text, true);
        break;
    case 'plug':
        if (SceneManager._scene && SceneManager._scene._gabWindow) {
            try { _pluginCommand.call(new Game_Interpreter(), msg.c, msg.a || []); } catch (e) {}
        }
        break;
    }
};

$.guestHandlers.bInput = function(msg) {
    if (msg.pvp) return; // no duel move lists any more: both duelists have a battle screen
    if (!$.puppet || msg.bid !== $.puppet.bid) return;
    // asked again while its window is open: that window answers it (a flag
    // left here opened a second window after the pick)
    if (BattleManager._phase === 'input') {
        $.puppetBeat(true);
        return;
    }
    $.puppet.input = true;
};

// Its signals to the fight's PC: the window is up / still choosing; its own
// Talk lines (shown or waiting in its queue) are still being read.
$.puppetBeat = function(now) {
    var p = $.puppet;
    if (!p || p.spec) return;
    var t = $.clockMs();
    if (!now && p._beatAt && t - p._beatAt < $.PUPPET_BEAT_MS) return;
    p._beatAt = t;
    if (BattleManager._phase === 'input') {
        $.bSend(p.owner, { t: p._choosing ? 'bChoosing' : 'bInputSeen', bid: p.bid, actorId: p.myActorId });
        p._choosing = true;
    }
    var me = $.myPlayerId();
    var ids = [];
    if (p.dialog && p.dialog.interactive && !p.dialog.sent) ids.push(p.dialog.id);
    (p.dialogQueue || []).forEach(function(d) { if (d.owner === me) ids.push(d.id); });
    ids.forEach(function(id) { $.bSend(p.owner, { t: 'bDialogSeen', bid: p.bid, id: id }); });
};

var _sceneBattleUpdateBeat = Scene_Battle.prototype.update;
Scene_Battle.prototype.update = function() {
    _sceneBattleUpdateBeat.call(this);
    var p = $.puppet;
    if (!p) return;
    var choosing = BattleManager._phase === 'input';
    if (choosing && !p._choosing) $.puppetBeat(true); // the window just opened
    if (!choosing) p._choosing = false;
    $.puppetBeat(false);
};

// The fight's PC gave up on this command (it stood still too long): the
// window closes, the next ask opens it again.
$.guestHandlers.bInputOff = function(msg) {
    var p = $.puppet;
    if (!p || msg.bid !== p.bid || BattleManager._phase !== 'input') return;
    var scene = SceneManager._scene;
    if (scene instanceof Scene_Battle) $.holdPuppetInput(scene);
    BattleManager.changeActor(-1, 'waiting');
    BattleManager._phase = 'puppet';
    p.input = false;
    p._choosing = false;
    $.dlog('joiner (fight ' + p.bid + '): its command window closed - the fight\'s PC went on (Guard)');
};

$.updatePuppet = function() {
    var bm = BattleManager;
    $.watchPuppetTurns(bm);
    if (bm._phase === 'puppet' && $.puppet.input && !bm.isBusy()) {
        $.puppet.input = false;
        var actor = $gameActors.actor($.puppet.myActorId);
        var index = $gameParty.members().indexOf(actor);
        if (!actor || index < 0 || !actor.canInput()) {
            $.puppetLog('skip', 'turn skipped (Guard sent): ' + $.puppetWhy(actor, index));
            $.sendPuppetAction(null);
            return;
        }
        actor.makeActions();
        bm._phase = 'input';
        bm._actorIndex = index;
        actor.setActionState('inputting');
    }
};

// Why a joiner's turn goes by without its command window (play test
// 2026-10-20: the host joined Marina's Samarie fight and only watched; not
// explained yet). Each reason at most every 5 s.
$.PUPPET_QUIET_MS = 20000;
$.puppetLog = function(key, text) {
    var p = $.puppet;
    if (!p) return;
    var now = $.clockMs();
    p._fhLog = p._fhLog || {};
    if (p._fhLog[key] && now - p._fhLog[key] < 5000) return;
    p._fhLog[key] = now;
    $.dlog('joiner (fight ' + p.bid + '):', text);
};

$.puppetWhy = function(actor, index) {
    var why = [];
    if (!actor) {
        why.push('no character ' + $.puppet.myActorId);
    } else {
        if (index < 0) why.push('not in the party ' + JSON.stringify($gameParty._actors));
        if (!actor.canInput()) {
            why.push('cannot input (hp ' + actor.hp + ', states ' + JSON.stringify(actor._states) +
                ', restriction ' + actor.restriction() + (actor.isAppeared() ? '' : ', not appeared') + ')');
        }
    }
    if ($gameMessage.isBusy()) why.push('a message is up');
    return why.join(', ') || 'can input';
};

$.puppetBusyWhy = function(bm) {
    var why = [];
    if ($gameMessage.isBusy()) why.push('message');
    if (bm._logWindow && bm._logWindow.isBusy()) why.push('battle log');
    if (bm._spriteset && bm._spriteset.isBusy()) why.push('animations');
    return why.join(', ') || '?';
};

// the turn asked but held (busy), or no turn asked for a long time
$.watchPuppetTurns = function(bm) {
    var p = $.puppet;
    if (!p) return;
    var now = $.clockMs();
    if (!p._fhSince) p._fhSince = now;
    if (bm._phase === 'puppet' && p.input && bm.isBusy()) {
        $.puppetLog('busy', 'turn asked, held: busy (' + $.puppetBusyWhy(bm) + ')');
    }
    if (p.input || bm._phase === 'input') {
        p._fhAsked = now;
        return;
    }
    var quiet = now - (p._fhAsked || p._fhSince);
    if (quiet > $.PUPPET_QUIET_MS && (!p._fhQuietLogged || now - p._fhQuietLogged > $.PUPPET_QUIET_MS)) {
        p._fhQuietLogged = now;
        var actor = $gameActors.actor(p.myActorId);
        $.dlog('joiner (fight ' + p.bid + '): no turn asked for', Math.round(quiet / 1000), 's (phase', bm._phase +
            ', gauge', actor && actor.atbGauge ? Math.round(actor.atbGauge()) : '-', ',',
            actor ? $.puppetWhy(actor, $gameParty.members().indexOf(actor)) : 'no character', ')');
    }
};

$.sendPuppetAction = function(action) {
    var msg = { t: 'bAction', bid: $.puppet.bid, kind: 'skill', id: 0, target: -1 };
    // the Boost Points put on this command (Olivia_OctoBattle boost)
    var me = $gameActors.actor($.puppet.myActorId);
    msg.bp = me && me.useBP ? me.useBP() : 0;
    if (me && me.setUseBP && msg.bp) me.setUseBP(0); // spent on the fight's PC
    if (action && action.item()) {
        msg.kind = DataManager.isItem(action.item()) ? 'item' : 'skill';
        msg.id = action.item().id;
        msg.target = action._targetIndex;
    } else {
        msg.id = 2; // Guard
    }
    $.bSend($.puppet.owner, msg);
};

var _selectNextCommand = BattleManager.selectNextCommand;
BattleManager.selectNextCommand = function() {
    if ($.puppet && this._phase === 'input') {
        var actor = this.actor();
        if (!actor) {
            // "Fight" after cancelling back to the party command
            var me = $gameActors.actor($.puppet.myActorId);
            this.changeActor($gameParty.members().indexOf(me), 'undecided');
            return;
        }
        if (actor.selectNextCommand()) return;
        this.changeActor(-1, 'waiting');
        this._phase = 'puppet';
        $.sendPuppetAction(actor ? actor.action(0) : null);
        return;
    }
    _selectNextCommand.call(this);
};

var _selectPreviousCommand = BattleManager.selectPreviousCommand;
BattleManager.selectPreviousCommand = function() {
    if ($.puppet && this._phase === 'input') {
        var actor = this.actor();
        if (actor && actor.selectPreviousCommand()) return;
        this.changeActor(-1, 'undecided'); // party command: Fight / Escape
        return;
    }
    _selectPreviousCommand.call(this);
};

var _processEscape = BattleManager.processEscape;
BattleManager.processEscape = function() {
    if ($.puppet) {
        $.bSend($.puppet.owner, { t: 'bLeave', bid: $.puppet.bid });
        this._phase = 'puppet';
        return true;
    }
    return _processEscape.call(this);
};

var _canTickAtb = BattleManager.canTickAtb;
BattleManager.canTickAtb = function() {
    if ($.puppet) return false;
    return _canTickAtb.call(this);
};

var _isBattleEnd = BattleManager.isBattleEnd;
BattleManager.isBattleEnd = function() {
    if ($.puppet) return false;
    return _isBattleEnd.call(this);
};

$.guestHandlers.bEnd = function(msg) {
    if (!$.puppet || msg.bid !== $.puppet.bid) return;
    // its toss list, a read-only copy or a dialogue still up: it closed with
    // the fight ($gameMessage outlives the battle scene: the list came up on
    // the map, the coin pictures stayed - 0.4 review 2 S3)
    var p = $.puppet;
    if (p.choiceUp || p.dialog) {
        if (p.choiceUp) $.COIN_PICTURES.forEach(function(id) { $gameScreen.erasePicture(id); });
        $.closePuppetMessage();
    }
    var save = $.puppet.saveActors;
    $.puppet = null;
    $gameParty._actors = save;
    BattleManager._phase = null;
    if ($gamePlayer) $gamePlayer.refresh(); // the leader may have been the fight's
    if ($gameParty.inBattle() || SceneManager._scene instanceof Scene_Battle ||
            SceneManager.isNextScene(Scene_Battle)) { // still loading: pop cancels it
        BattleManager.replayBgmAndBgs();
        SceneManager.pop();
    }
    $.toast(msg.r === 1 ? 'Co-op: you left the battle' : 'Co-op: the battle is over');
};

// A joined view whose fight is gone must not stay open (0.38.1: the host
// joined a roaming guest's fight 2 s before it ended, the guest went on to
// another fight, and the host's screen stayed on a dead battle view).
// - Host: it keeps the list of every fight; a view of a fight no longer in
//   it closes after a short grace.
// - Everyone: the fight's PC streams its state at least once a second; a
//   view that heard nothing for a while asks the host (below).
// The fight's PC is told (bLeave), in case the fight still runs there.
// (Real time, $.clockMs: drawn frames run as fast as the screen.)
$.PUPPET_GONE_MS = 1000;

$.puppetHeard = function(msg) {
    if ($.puppet && msg && msg.bid === $.puppet.bid) $.puppet.heardAt = $.clockMs();
};

['bView', 'bState', 'bFx', 'bInput', 'bParty'].forEach(function(t) {
    var base = $.guestHandlers[t];
    $.guestHandlers[t] = function(msg) {
        base(msg);
        $.puppetHeard(msg);
    };
});

$.closeLostPuppet = function(why) {
    var p = $.puppet;
    if (!p) return;
    $.dlog('battle view closed:', why, p.bid);
    $.bSend(p.owner, { t: 'bLeave', bid: p.bid });
    $.guestHandlers.bEnd({ t: 'bEnd', bid: p.bid, r: 0, me: null });
    $.toast('Co-op: lost the battle view - back to the map');
};

// Silence alone never closes a view: the fight's PC may just be minimized
// (no frames, no stream) or busy. A guest's view that heard nothing for a
// while asks the host, who has the list of every fight; only "gone" closes it.
$.PUPPET_ASK_MS = 5000;

$.closeGonePuppet = function(why) {
    var p = $.puppet;
    if (!p) return;
    $.closeLostPuppet(why);
};

$.checkLostPuppet = function() {
    var p = $.puppet;
    if (!p) return;
    var now = $.clockMs();
    if (p.heardAt === undefined) p.heardAt = now;
    if ($.isHost()) {
        if (!$.battles[p.bid]) {
            if (p.goneAt === undefined) p.goneAt = now;
            if (now - p.goneAt >= $.PUPPET_GONE_MS) $.closeGonePuppet('the fight is over on the host list');
        } else {
            p.goneAt = undefined;
        }
        return;
    }
    if (now - p.heardAt < $.PUPPET_ASK_MS || !$.conn) return;
    if (p.askedAt !== undefined && now - p.askedAt < $.PUPPET_ASK_MS) return;
    p.askedAt = now;
    $.conn.send({ t: 'bCheck', bid: p.bid });
};

// Host: is that fight still on?
$.hostHandlers.bCheck = function(conn, msg) {
    if (msg && msg.bid && !$.battles[msg.bid]) conn.send({ t: 'bGone', bid: msg.bid });
};

$.guestHandlers.bGone = function(msg) {
    if ($.puppet && msg && $.puppet.bid === msg.bid) $.closeGonePuppet('the fight is over (host)');
};

$.worldExtras.push(function() {
    if (!$.isHost()) return;
    $.checkLostPuppet();
    // a join the fight's PC never took (the fight ended first): not busy
    if ($.hostInJoin && !$.puppet && !$.battles[$.hostInJoin]) $.hostInJoin = 0;
});
$.guestExtras.push(function() { if ($.isGuest()) $.checkLostPuppet(); });

// Only my own gauge (others are not shown in my UI).
var _createDisplayObjects = Scene_Battle.prototype.createDisplayObjects;
Scene_Battle.prototype.createDisplayObjects = function() {
    _createDisplayObjects.call(this);
    var gauges = this._fhAtbGauges;
    if (gauges) {
        var proto = Object.getPrototypeOf(gauges);
        if (!proto._fhCoopBattlers) {
            var base = proto.battlers;
            proto._fhCoopBattlers = true;
            proto.battlers = function() {
                var list = base.call(this);
                if (!$.role) return list;
                var mine = $.isHost() ? $.hostActorId() : $.myActorId;
                if ($.puppet) mine = $.puppet.myActorId;
                // (the blood golem: its summoner's own)
                return list.filter(function(b) {
                    return b.isEnemy() || b.actorId() === mine || (!$.puppet && b.actorId() === $.GOLEM_ACTOR);
                });
            };
        }
    }
};

// The host keeps the field running for the guests while it fights.
var _Scene_Battle_update = Scene_Battle.prototype.update;
Scene_Battle.prototype.update = function() {
    _Scene_Battle_update.call(this);
    if ($.runsWorld()) $.backgroundWorld();
};

// Battle log fast-forward would speed up the joiners' view too.
var _logFastForward = Window_BattleLog.prototype.isFastForward;
Window_BattleLog.prototype.isFastForward = function() {
    if ($.puppet || ($.authBattle && $.authBattle.joiners.length)) return false;
    return _logFastForward.call(this);
};

//=============================================================================
// Aggro: enemies go for whoever hurt them most
//=============================================================================

$.dmgTable = {}; // enemy index -> { actorId: damage }

var _pvpDamageContext = null;
var _executeHpDamage = Game_Action.prototype.executeHpDamage;
Game_Action.prototype.executeHpDamage = function(target, value) {
    var previousDamageContext = _pvpDamageContext;
    if ($.pvpBattle && value > 0 && target && target._fhPvpFoe) {
        _pvpDamageContext = { target: target, bodyRate: $.pvpAoeBodyDamageRate(this) };
    }
    try {
        _executeHpDamage.call(this, target, value);
    } finally {
        _pvpDamageContext = previousDamageContext;
    }
    var subject = this.subject();
    if ($gameParty.inBattle() && subject && subject.isActor() && target.isEnemy() && value > 0) {
        var key = $gameTroop.members().indexOf(target);
        var row = $.dmgTable[key] = $.dmgTable[key] || {};
        row[subject.actorId()] = (row[subject.actorId()] || 0) + value;
    }
};

var _setupTroop = Game_Troop.prototype.setup;
Game_Troop.prototype.setup = function(troopId) {
    _setupTroop.call(this, troopId);
    $.dmgTable = {};
};

// Recent damage counts more: older damage fades each round.
var _increaseTurn = Game_Troop.prototype.increaseTurn;
Game_Troop.prototype.increaseTurn = function() {
    _increaseTurn.call(this);
    Object.keys($.dmgTable).forEach(function(k) {
        var row = $.dmgTable[k];
        Object.keys(row).forEach(function(id) { row[id] *= 0.8; });
    });
};

$.aggroOn = function() {
    return $gameParty.inBattle() && $.authBattle && $.authBattle.joiners.length > 0;
};

$.damageShares = function(enemy) {
    var key = $gameTroop.members().indexOf(enemy);
    var row = $.dmgTable[key];
    var total = 0;
    if (!row || !Object.keys(row).length) {
        row = {};
        Object.keys($.dmgTable).forEach(function(k) {
            Object.keys($.dmgTable[k]).forEach(function(id) { row[id] = (row[id] || 0) + $.dmgTable[k][id]; });
        });
    }
    Object.keys(row).forEach(function(id) { total += row[id]; });
    return { row: row, total: total };
};

var _randomTarget = Game_Party.prototype.randomTarget;
Game_Party.prototype.randomTarget = function() {
    var subject = BattleManager._subject;
    if (!$.aggroOn() || !subject || !subject.isEnemy()) return _randomTarget.call(this);
    var shares = $.damageShares(subject);
    var members = this.aliveMembers();
    var weights = members.map(function(m) {
        var share = shares.total > 0 ? (shares.row[m.actorId()] || 0) / shares.total : 0;
        return m.tgr * (1 + share);
    });
    var sum = weights.reduce(function(r, w) { return r + w; }, 0);
    var roll = Math.random() * sum;
    for (var i = 0; i < members.length; i++) {
        roll -= weights[i];
        if (roll <= 0) return members[i];
    }
    return members[members.length - 1] || null;
};

// "Actor 1" in troop events (fixed target): the one this enemy hates most,
// then whoever did the most damage, then the player who started the fight.
var _smoothTarget = Game_Party.prototype.smoothTarget;
Game_Party.prototype.smoothTarget = function(index) {
    var subject = BattleManager._subject;
    if (index === 0 && $.aggroOn() && subject && subject.isEnemy()) {
        var shares = $.damageShares(subject);
        var best = null, bestDmg = 0;
        this.aliveMembers().forEach(function(m) {
            var d = shares.row[m.actorId()] || 0;
            if (d > bestDmg) {
                best = m;
                bestDmg = d;
            }
        });
        if (best) return best;
    }
    return _smoothTarget.call(this, index);
};

//=============================================================================
// Betrayal: the Hollow Tower door
//=============================================================================

$.TOWER_MAP = 111;
$.TOWER_EVENT = 62;
// Each playable character's own enemy version (troop) and limb switches
// [arm1, arm2, leg1, leg2] (arm1/leg1 taken as the right side).
$.PVP_TROOP = { 1: 108, 3: 106, 4: 103, 5: 96, 6: 109, 13: 97, 14: 105, 15: 98 };
// HP (user decisions 2026-10-19 and 2026-10-26, both sides the same): the
// whole body (the torso) is the character's max HP x 10 at the duel's start
// (100 HP: 1000, 125: 1250; a fixed 800 before), and every other part a
// share of it: head 10%, one arm 30%, both arms as one part 50%, one leg
// 50%, both legs as one part 60%, Olivia's left arm (also her leg) 70%
// (100 HP: head 100, arm 300, leg 500, arms 500, legs 600, Olivia's 700).
// A hit on a limb or the head takes that part's pool and the body (the whole
// hit, also beyond what the limb had left); a hit on the torso the body. The
// character's real HP is the body's share of its max HP: realHp =
// round(mhp * body / bodyMax) (body / 10 while the max HP stays), at least 1
// while body > 0. Body 0 (or the head 0): defeated. A limb at 0: cut. Limbs
// and the head never heal. See $.pvpPartPools, $.duelSyncSelfHp.
// Damage (user decision 2026-10-20): every hit goes through a compression
// curve ($.pvpCurve), each hit of a multi-hit skill on its own:
//   on the body = round(K * log2(1 + raw / B)), K 25, B 50, at least 1
//   raw 10 -> 7, 100 -> 40, 500 -> 86, 1000 -> 110, 2000 -> 134, 3000 -> 148
// so strong weapons still hurt more, but nothing one-shots (100 HP, raw 100
// on a leg: leg 500 -> 460, body 1000 -> 960, 96 HP). Guards and the Salmonsnake
// rune halve limb damage after the curve. Healing takes the same curve on
// the healed amount (a heal of 100 HP: +40 on the body, then the real HP is
// the body's share again); so does any other change of a duelist's own HP
// on its own PC (poison, a skill's HP cost). What the character drains or
// life-steals is the curved hit itself: its body gains as much.
// (0.38.3-pre: parts as shares of the character's HP and a 1/10 damage rate
// - the plugin parameter 'PvP Damage Rate', removed in 0.38.3 - a leg of 38
// HP with 100 HP. Before that the enemy versions' own proportions: a leg was
// 11 HP and went with one 10-damage hit, play test 2026-10-19.)
$.PVP_CURVE_K = 25;
$.PVP_CURVE_B = 50;
$.PVP_BODY_PER_HP = 10;
$.PVP_PART_SHARE = {
    head: 0.1,
    armR: 0.3, armL: 0.3, arms: 0.5,
    legR: 0.5, legL: 0.5, legs: 0.6
};
$.PVP_ACTOR_PART_SHARE = { 15: { armL: 0.7 } };
$.PVP_AOE_REFERENCE_TARGETS = 5; // torso plus two arms and two legs
$.PVP_ARM_GUARDS = [41, 46]; // fluted arm guard, arm guard
$.PVP_LEG_GUARDS = [22]; // leg guards
$.LIMB_SWITCHES = {
    1: [36, 37, 38, 39], 3: [248, 249, 250, 251], 4: [252, 253, 254, 255],
    5: [256, 257, 258, 259], 6: [261, 262, 263, 264], 13: [1781, 1782, 1783, 1784],
    14: [2069, 2070, 2071, 2072], 15: [1785, 1786, 1787, 1788]
};
$.PART_WORDS = {
    torso: ['torso', '몸통'], head: ['head', '머리'],
    armR: ['right arm', '오른팔'], armL: ['left arm', '왼팔'], arms: ['arm', 'arms', '팔'],
    legR: ['right leg', '오른다리'], legL: ['left leg', '왼다리'], legs: ['leg', 'legs', '다리']
};
$.NOT_PARTS = [50, 84]; // bear trap, gasoline canister

$.isPvpLimb = function(kind) {
    return ['armR', 'armL', 'arms', 'legR', 'legL', 'legs'].indexOf(kind) >= 0;
};

$.isPvpLeg = function(kind) {
    return ['legR', 'legL', 'legs'].indexOf(kind) >= 0;
};

// The members of a character's duel form (its enemy version), in troop order:
// the same list on every PC, so a part index means the same part everywhere.
$.pvpTroopMembers = function(actorId) {
    var src = $dataTroops[$.PVP_TROOP[actorId]];
    if (!src) return [];
    return src.members.filter(function(m) { return $.NOT_PARTS.indexOf(m.enemyId) < 0; });
};

// The whole body of a character with this max HP.
$.pvpBodyMax = function(mhp) {
    return Math.max(1, Math.round(Number(mhp) || 1)) * $.PVP_BODY_PER_HP;
};

// [{ kind, enemyId, mhp }] per member: the torso (the body) its max HP x 10
// ($.pvpBodyMax), every other part its share of that ($.PVP_PART_SHARE,
// rounded the same way on both PCs). A part of no known kind gets the enemy
// version's proportion of the body.
$.pvpPartShare = function(actorId, kind) {
    var own = $.PVP_ACTOR_PART_SHARE[actorId] || {};
    return own[kind] || $.PVP_PART_SHARE[kind] || 0;
};

$.pvpPartPools = function(actorId, mhp) {
    var bodyMax = $.pvpBodyMax(mhp);
    var members = $.pvpTroopMembers(actorId);
    var kinds = members.map(function(m) {
        var data = $dataEnemies[m.enemyId];
        return data ? $.partKind(data.name) : '';
    });
    var hpOf = function(m) {
        var data = $dataEnemies[m.enemyId];
        return data ? Math.max(0, data.params[0]) : 0;
    };
    var torsoAt = kinds.indexOf('torso');
    var bodyAt = torsoAt >= 0 ? torsoAt : 0; // (no torso: the first part is the body, as pb.ctl)
    var torsoHp = torsoAt >= 0 ? hpOf(members[torsoAt]) : Math.max.apply(null, members.map(hpOf).concat([1]));
    return members.map(function(m, i) {
        var kind = kinds[i];
        var share = $.pvpPartShare(actorId, kind);
        var hp = i === bodyAt ? bodyMax : share ? Math.round(bodyMax * share) :
            Math.round(hpOf(m) / Math.max(1, torsoHp) * bodyMax);
        return { kind: kind, enemyId: m.enemyId, mhp: Math.max(1, Math.min(bodyMax, hp)), body: i === bodyAt };
    });
};

// The compression curve: a raw hit (or heal) of any size -> what it does on
// the duel body, round(K * log2(1 + raw / B)), at least 1 for a non-zero
// amount. Only the PC that hits computes it; the other one gets the result.
$.pvpCurve = function(raw) {
    raw = Math.abs(Number(raw) || 0);
    if (!raw) return 0;
    var log2 = Math.log2 ? Math.log2(1 + raw / $.PVP_CURVE_B) : Math.log(1 + raw / $.PVP_CURVE_B) / Math.LN2;
    return Math.max(1, Math.round($.PVP_CURVE_K * log2));
};

// Real HP <-> the body (both PCs, the same rounding). bodyMax: the whole
// body set at the duel's start (default: this max HP x 10). A change of max
// HP during the duel keeps the body and moves the real HP with it.
// - the real HP of a body: round(mhp * body / bodyMax), at least 1 while the
//   body is above 0, 0 when it is 0;
// - the body of a real HP (the duel's start): round(bodyMax * hp / mhp), at
//   least 1 while the HP is above 0;
// - a change of real HP on the character's own PC (a potion, poison, a
//   skill's HP cost) of X: the curve of X on the body ($.duelBodyDelta).
$.duelHpOfBody = function(body, mhp, bodyMax) {
    mhp = Math.max(1, mhp || 1);
    bodyMax = Math.max(1, bodyMax || $.pvpBodyMax(mhp));
    if (!(body > 0)) return 0;
    return Math.max(1, Math.min(mhp, Math.round(mhp * body / bodyMax)));
};

$.duelBodyOfHp = function(hp, mhp, bodyMax) {
    mhp = Math.max(1, mhp || 1);
    bodyMax = Math.max(1, bodyMax || $.pvpBodyMax(mhp));
    if (!(hp > 0)) return 0;
    return Math.max(1, Math.min(bodyMax, Math.round(bodyMax * hp / mhp)));
};

// A change of X real HP (a heal, poison) -> the change on the body: the
// curve of X, signed (a heal of 100: +40; poison of 10: -7).
$.duelBodyDelta = function(dHp) {
    var d = $.pvpCurve(dHp);
    return dHp > 0 ? d : -d;
};

// The small battle message when someone loses a limb (both players see it).
$.pvpCutText = function(name, kind) {
    var text = { armR: ' lost an arm!', armL: ' lost an arm!', arms: ' lost both arms!',
        legR: ' lost a leg!', legL: ' lost a leg!', legs: ' lost both legs!' }[kind];
    return text ? name + text : '';
};

$.updatePvpAoeBodyRate = function() {
    if (!$.pvpBattle) return;
    var count = $gameTroop.members().filter(function(e) {
        return e._fhPvpFoe && e.isAlive() && !e.isHidden() && !e._fhPvpHeadLocked &&
            (e._fhPart === 'torso' || e._fhPart === 'head' || $.isPvpLimb(e._fhPart));
    }).length;
    $.pvpBattle.aoeBodyRate = Math.max(1, $.PVP_AOE_REFERENCE_TARGETS / Math.max(1, count));
};

$.pvpAoeBodyDamageRate = function(action) {
    if (!$.pvpBattle || !action || !action.isForAll || !action.isForAll()) return 1;
    if (typeof action._fhPvpAoeBodyRate === 'number') return action._fhPvpAoeBodyRate;
    return $.pvpBattle.aoeBodyRate || 1;
};

var _makeTargetsPvpAoe = Game_Action.prototype.makeTargets;
Game_Action.prototype.makeTargets = function() {
    var targets = _makeTargetsPvpAoe.call(this);
    this._fhPvpAoeBodyRate = $.pvpBattle && this.isForAll && this.isForAll()
        ? ($.pvpBattle.aoeBodyRate || 1) : 1;
    return targets;
};

// Guards in the data resist the limb-loss state (arm 3, leg 14); the
// Salmonsnake rune (62) resists both. Any equip with that resistance counts.
$.PVP_ARM_LOSS_STATE = 3;
$.PVP_LEG_LOSS_STATE = 14;

$.pvpHasGuard = function(actor, kind) {
    if (!actor || !actor.equips) return false;
    var arm = kind.indexOf('arm') === 0;
    var ids = arm ? $.PVP_ARM_GUARDS : $.PVP_LEG_GUARDS;
    var state = arm ? $.PVP_ARM_LOSS_STATE : $.PVP_LEG_LOSS_STATE;
    return actor.equips().some(function(item) {
        return item && (ids.indexOf(item.id) >= 0 || (item.traits || []).some(function(t) {
            return t.code === Game_BattlerBase.TRAIT_STATE_RESIST && t.dataId === state;
        }));
    });
};

// A leg at 0 HP is gone even while it still stands: the battle's own hit
// leaves it standing until the action ends (YEP's IMMORTAL on the targets).
$.pvpLegsDestroyed = function() {
    var legs = $gameTroop.members().filter(function(e) {
        return e._fhPvpFoe && $.isPvpLeg(e._fhPart);
    });
    return legs.length > 0 && legs.every(function(e) { return e.isDead() || e.isHidden() || e.hp <= 0; });
};

// The head can be hit once the legs are gone. Until then it is not a
// target, but it stays drawn: a hidden enemy loses its picture, and the
// other player's character looked headless.
// Looked at again whenever a foe part falls, however it fell ($.checkPvpParts
// from Game_Battler.refresh), and every frame of the duel battle
// (Scene_Battle.update). Before 0.38.3 only a leg that fell inside its own
// gainHp unlocked it: the battle's own hits never did that (YEP keeps the
// target alive at 0 HP until the action ends), and the head stayed out of
// the enemy window for good (play test 0.38.3-pre3, O'saa against Marina).
// True: a head's lock changed.
$.updatePvpHead = function() {
    var unlocked = $.pvpLegsDestroyed(), changed = false;
    $gameTroop.members().forEach(function(e) {
        if (!e._fhPvpFoe || e._fhPart !== 'head') return;
        if (!!e._fhPvpHeadLocked !== !unlocked) changed = true;
        e._fhPvpHeadLocked = !unlocked;
    });
    return changed;
};

$.pvpHeadLocked = function(e) {
    return !!($.pvpBattle && e && e._fhPvpHeadLocked);
};

// Target lists (enemy window, random and "all" targets) skip a locked head
// (on both duelists' screens: each fights the other's duel form).
var _troopAliveMembersPvpHead = Game_Troop.prototype.aliveMembers;
Game_Troop.prototype.aliveMembers = function() {
    var list = _troopAliveMembersPvpHead.call(this);
    if (!$.pvpBattle) return list;
    return list.filter(function(e) { return !e._fhPvpHeadLocked; });
};

$.pvpFoeHpRate = function(pb) {
    if (!pb || !pb.ctl || pb.ctl.mhp <= 0) return null;
    var rate = pb.ctl.hp / pb.ctl.mhp;
    return isFinite(rate) ? rate : null;
};

$.partKind = function(enemyName) {
    var m = /\[([^\]]+)\]/.exec(enemyName);
    if (!m) return '';
    var word = m[1].trim().toLowerCase();
    var kind = '';
    Object.keys($.PART_WORDS).forEach(function(k) {
        if (!kind && $.PART_WORDS[k].indexOf(word) >= 0) kind = k;
    });
    return kind;
};

$.isTowerDoor = function(ev) {
    return $gameMap.mapId() === $.TOWER_MAP && ev.eventId() === $.TOWER_EVENT;
};

// Host: player id used the tower door. true: the original door runs for it;
// false: the door is the co-op one (told, the duels started or waited for,
// the vote on the missing). Every way to the door comes here: the host's own
// player, a thin guest (tryBetrayal), a roaming guest and a sub-host's guest
// (FH_CoopRoam betrayAsk).
$.towerDoorUse = function(id) {
    var check = $.towerDoorCheck();
    if (check === 'original') return true;
    $.towerDoorTell(id, check);
    if (check === 'tourney') $.startTourney($.towerLiving());
    if (check === 'wait') $.noteTourneyAsk();
    if (check === 'absent') $.askTowerWithout(id);
    return false;
};

// The door (action button, page 0) and the opened door (player touch, page 7).
$.tryBetrayal = function(id, ev, page) {
    if (!$.isHost() || !$.isTowerDoor(ev) || !page || page.trigger > 1) return false;
    return !$.towerDoorUse(id);
};

// A player who left and does not come back held the door forever (user
// 2026-10-26): the ones here vote to go on without it. It then counts as
// dead (like one who left in the middle of its duel: V201 one less).
$.TOWER_ABSENT_TEXT = '%1 not here. Go on without them? (They count as dead.)';
$.askTowerWithout = function(fromId) {
    var names = $.towerOffline();
    if (!names.length || $.consent) return;
    var text = $.TOWER_ABSENT_TEXT.replace('%1', names.join(', ') + (names.length > 1 ? ' are' : ' is'));
    $.dlog('tower: asks to go on without', names.join(', '));
    $.requestConsent(fromId, function() { $.towerDropOffline(names); }, { text: text });
};

$.TOWER_BACK_TEXT = '%1 is back.';
$.towerDropOffline = function(names) {
    var assign = $.assignments(), dead = $.coopDead();
    // who is still away now, as the vote ends: one who came back meanwhile
    // stays alive (it was counted dead and played on - 0.41 review 3 H6)
    var still = $.towerOffline();
    names.filter(function(name) { return still.indexOf(name) < 0 && !dead[name]; }).forEach(function(name) {
        $.dlog('tower: back before the vote ended:', name);
        $.broadcastToast($.TOWER_BACK_TEXT.replace('%1', name));
    });
    names = names.filter(function(name) { return still.indexOf(name) >= 0; });
    if (!names.length) return;
    names.forEach(function(name) {
        if (dead[name]) return;
        dead[name] = true;
        var sw = $.DEATH_SWITCH[assign[name]];
        if (sw && !$gameSwitches.value(sw)) {
            $gameSwitches.setValue(sw, true);
            $gameVariables.setValue($.CHARACTERS_LEFT_VAR, $gameVariables.value($.CHARACTERS_LEFT_VAR) - 1);
        }
        // its companion goes with it (0.41 review 3 H7)
        if ($.minionsData && $.minionsData()[name]) {
            delete $.minionsData()[name];
            if ($.broadcastMinions) $.broadcastMinions();
        }
        $.dlog('tower: went on without', name, '(counts as dead)');
    });
    $.broadcastToast(names.join(', ') + ' will not come back. The tower door awaits the rest.');
};

$.eventStartHooks.push(function(conn, ev, page) {
    return $.tryBetrayal(conn.guestId, ev, page);
});

var _startForHost = Game_Event.prototype.start;
Game_Event.prototype.start = function() {
    if ($.isHost() && $.sessionActive() && !$gamePlayer._fhRemoteId && this.page() &&
            $.tryBetrayal('host', this, this.page())) {
        return;
    }
    _startForHost.call(this);
};

$.limbState = function(actorId) {
    var ids = $.LIMB_SWITCHES[actorId] || [];
    return ids.map(function(id) { return !!$gameSwitches.value(id); });
};

// Symmetric duel (user decision 2026-10-19): each duelist's PC runs a battle
// of its own. Its character is the party, the other player's duel form (its
// body parts) the enemy, with the same rules and numbers on both sides. Both
// PCs get 'pvp', each with the other one as the foe. How the two battles
// stay in step: "Duel: both sides" at the end of this file.
$.startPvp = function(attackerId, foeId) {
    var foeActor = $.actorOfPlayer(foeId);
    var me = $.actorOfPlayer(attackerId);
    if (!foeActor || !me || !$.PVP_TROOP[foeActor.actorId()] || !$.PVP_TROOP[me.actorId()]) return;
    var bid = $.newBid();
    $.battles[bid] = {
        bid: bid, owner: attackerId, troopId: 0, eventId: $.TOWER_EVENT, mapId: $gameMap.mapId(),
        joiners: [], pvp: true, foeId: foeId, attackerId: attackerId, opened: {}, reports: {}
    };
    [attackerId, foeId].forEach(function(id) {
        var c = id === 'host' ? null : $.clientById(id);
        if (c) c.inBattle = bid;
    });
    var turned = $.playerLabel(attackerId) + ' turned on ' + $.playerLabel(foeId) + '!';
    if ($.duelQuietStart) { // (a duel to the death: the two alone)
        [attackerId, foeId].forEach(function(id) { $.sendTo(id, { t: 'toast', text: 'Co-op: ' + turned }); });
    } else {
        $.broadcastToast(turned);
    }
    $.dlog('betrayal duel', $.playerLabel(attackerId), 'vs', $.playerLabel(foeId));
    // the guest first: the host's own battle opens at once (sendTo 'host')
    var sides = [[attackerId, foeId, 'atk'], [foeId, attackerId, 'def']];
    if (attackerId === 'host') sides.reverse();
    sides.forEach(function(s) { $.sendTo(s[0], $.duelStartMsg(bid, s[0], s[1], s[2])); });
};

// What a duelist's PC needs: its foe's character and limbs, its own limbs,
// and for a guest its character, bag and the world (it runs the battle).
$.duelStartMsg = function(bid, id, foeId, role) {
    var mine = $.actorOfPlayer(id), foe = $.actorOfPlayer(foeId);
    var msg = {
        t: 'pvp', bid: bid, role: role, foeId: foeId, foeName: $.playerLabel(foeId),
        foeActor: $.actorJson(foe), limbs: $.limbState(foe.actorId()), myLimbs: $.limbState(mine.actorId())
    };
    var conn = id === 'host' ? null : $.clientById(id);
    if (conn) {
        var data = $.meData(conn);
        msg.actor = data.actor;
        msg.inv = data.inv;
        msg.sw = $gameSwitches._data;
        msg.v = $gameVariables._data;
        msg.ss = $gameSelfSwitches._data;
    }
    return msg;
};

$.PVP_TROOP_ID = 0;

$.buildPvpTroop = function(foeActorId, limbs) {
    if (!$.PVP_TROOP_ID) $.PVP_TROOP_ID = $dataTroops.length;
    var members = $.pvpTroopMembers(foeActorId)
        .map(function(m) { return { enemyId: m.enemyId, x: m.x, y: m.y, hidden: false }; });
    $dataTroops[$.PVP_TROOP_ID] = {
        id: $.PVP_TROOP_ID, name: 'FH Co-op duel', members: members,
        pages: [{ conditions: {
            actorHp: 50, actorId: 1, actorValid: false, enemyHp: 50, enemyIndex: 0, enemyValid: false,
            switchId: 1, switchValid: false, turnA: 0, turnB: 0, turnEnding: false, turnValid: false
        }, list: [{ code: 0, indent: 0, parameters: [] }], span: 0 }]
    };
    return $.PVP_TROOP_ID;
};

// This PC's duel: { bid, role ('atk' / 'def'), foeId, foeName, foe (a copy of
// the other player's character), limbs (its limbs cut before), ctl (its
// torso here), cut, self (this player's own body), hitsOut / hitsIn (hits
// sent / taken), waitFoe (the other battle is not up yet), won (the host
// settled it for this player) }
$.pvpBattle = null;
$.pendingDuel = null; // a duel whose battle waits here for a free screen

// The battle opens only from the map, with no message, box or map change in
// the way. Until then it waits (tryPendingDuel); there is no other way to
// fight a duel.
$.canOpenDuel = function() {
    // a PC that runs its map's events: not in the middle of one either (a
    // wait or a move route between two messages)
    var runsEvents = $.isHost() || !!($.isRoaming && $.isRoaming());
    return !$.puppet && !$.pvpBattle && !$gameParty.inBattle() && SceneManager._scene instanceof Scene_Map &&
        !SceneManager.isSceneChanging() && !$gameMessage.isBusy() && !$.pickOpen() &&
        !($gamePlayer && $gamePlayer.isTransferring()) && !(runsEvents && $gameMap && $gameMap.isEventRunning());
};

$.guestHandlers.pvp = function(msg) {
    if (!msg || !msg.bid) return;
    if (!$.canOpenDuel()) {
        if (!$.pendingDuel || $.pendingDuel.bid !== msg.bid) $.dlog('duel: the battle waits for a free screen', msg.bid);
        msg.late = true; // this PC's own character will be the newer one by then
        $.pendingDuel = msg;
        return;
    }
    $.pendingDuel = null;
    if ($.isGuest()) {
        $gameSwitches._data = (msg.sw || []).slice();
        $gameVariables._data = (msg.v || []).slice();
        $gameSelfSwitches._data = Object.assign({}, msg.ss || {});
        $gameMap.requestRefresh();
        if (!msg.late) $.applyMe({ actorId: $.myActorId, actor: msg.actor, inv: msg.inv });
        $.localBattle = {
            bid: msg.bid, pvp: true, sw0: $gameSwitches._data.slice(), v0: $gameVariables._data.slice(),
            ss0: Object.assign({}, $gameSelfSwitches._data)
        };
        if ($.duelSnapAtOpen) { // (duelStart came while it waited)
            $.duelSnapAtOpen = false;
            $.duelSnap = $.copyInv($.partyInv(), $gameActors.actor($.myActorId));
        }
    }
    var foe = JsonEx.parse(msg.foeActor);
    var troopId = $.buildPvpTroop(foe.actorId(), msg.limbs);
    var myId = $.isHost() ? $.hostActorId() : $.myActorId;
    var mine = $gameActors.actor(myId);
    // The party is this player's own character, whatever the party was (a
    // thin guest's could still be the host's from a snapshot, and a duel that
    // waited for a free screen skipped applyMe: the guest fought as the host's
    // character, its status row empty, play test 2026-10-19).
    var partyBefore = $gameParty._actors.slice();
    if (myId && mine) $gameParty._actors = [myId];
    $.hostDuelLost = false;
    $.authBattle = { bid: msg.bid, owner: $.myPlayerId(), joiners: [], troopId: troopId, pvp: true };
    // the host's own party (a companion from before the session) comes back
    // after the duel (endAuthBattle); a guest's is its character and its
    // raised companion (a roaming guest got no 'me' to put it back and was
    // without it until its next roam - 0.41 review 3 H8)
    var guestKeeps = !$.isHost() && partyBefore.indexOf(myId) >= 0 && partyBefore.every(function(id) {
        return id === myId || ($.isMinionActor && $.isMinionActor(id));
    });
    if (($.isHost() || guestKeeps) && myId && mine && partyBefore.join() !== String(myId)) {
        $.authBattle.restoreActors = partyBefore;
    }
    $.pvpBattle = {
        bid: msg.bid, role: msg.role || 'atk', foeId: msg.foeId, foeName: msg.foeName || foe.name(), foe: foe,
        limbs: msg.limbs, ctl: null, cut: {},
        self: $.duelSelfBody(myId, mine ? mine.hp : 1, mine ? mine.mhp : 1, msg.myLimbs),
        hitsOut: 0, hitsIn: 0, waitFoe: true, openedAt: $.clockMs()
    };
    BattleManager.setup(troopId, false, false);
    BattleManager.setEventCallback(function(n) {
        if ($.localBattle) $.localBattle.result = n;
    });
    $.setupPvpEnemies();
    SceneManager.push(Scene_Battle);
    $.dlog('duel: my battle opens', msg.bid, msg.role, 'against', $.pvpBattle.foeName);
    if (msg.role === 'def') $.toast('Co-op: ' + $.pvpBattle.foeName + ' betrayed you - fight!');
};

// A limb cut before the duel ([right arm, left arm, right leg, left leg]).
$.limbCutBefore = function(kind, limbs) {
    limbs = limbs || [];
    return !!((kind === 'armR' && limbs[0]) || (kind === 'armL' && limbs[1]) ||
        (kind === 'arms' && limbs[0] && limbs[1]) || (kind === 'legR' && limbs[2]) ||
        (kind === 'legL' && limbs[3]) || (kind === 'legs' && limbs[2] && limbs[3]));
};

// The foe's parts here: the HP model of $.pvpPartPools (the body its max HP
// x 10, the other parts their shares), limbs cut before are gone. The body
// starts at the character's HP share (60 of 100 HP: 600 of 1000).
$.setupPvpEnemies = function() {
    var pb = $.pvpBattle;
    var foe = pb.foe;
    var pools = $.pvpPartPools(foe.actorId(), foe.mhp);
    $gameTroop.members().forEach(function(e, i) {
        e._fhPvpFoe = foe;
        e._fhPvpAppliedStates = {};
        var kind = $.partKind(e.originalName());
        e._fhPart = kind;
        var pool = pools[i] && pools[i].enemyId === e.enemyId() ? pools[i] :
            pools.filter(function(p) { return p.enemyId === e.enemyId(); })[0];
        if (pool) {
            e._fhPvpMaxHp = pool.mhp;
            e.refresh();
            e.setHp(pool.body ? Math.max(1, Math.min(e.mhp, $.duelBodyOfHp(foe.hp, foe.mhp, pool.mhp))) : e.mhp);
        }
        e._mp = Math.min(foe.mp, e.mmp); // the other player's own MP
        if (kind === 'torso') {
            e._fhPvpCtl = true;
            pb.ctl = e;
        }
        if ($.limbCutBefore(kind, pb.limbs)) e.hide();
    });
    if (!pb.ctl) pb.ctl = $gameTroop.members()[0];
    if (pb.ctl) pb.ctl._fhPvpCtl = true;
    $.updatePvpHead();
    $.updatePvpAoeBodyRate();
};

// The duel enemy fights with the other player's own stats.
// The foe is a copy outside the party: its stats cannot change during the
// duel, so each is computed once (every part reads AGI every frame).
var _paramBase = Game_Enemy.prototype.paramBase;
Game_Enemy.prototype.paramBase = function(paramId) {
    var foe = this._fhPvpFoe;
    if (foe && paramId >= 1) { // HP stays the part's own
        var cache = foe._fhParamCache = foe._fhParamCache || [];
        if (cache[paramId] === undefined) cache[paramId] = foe.param(paramId);
        return cache[paramId];
    }
    return _paramBase.call(this, paramId);
};

var _enemyParamPvp = Game_Enemy.prototype.param;
Game_Enemy.prototype.param = function(paramId) {
    if (this._fhPvpMaxHp && paramId === 0) return this._fhPvpMaxHp;
    return _enemyParamPvp.call(this, paramId);
};

var _enemyStateRatePvp = Game_Enemy.prototype.stateRate;
Game_Enemy.prototype.stateRate = function(stateId) {
    var rate = _enemyStateRatePvp.call(this, stateId);
    if (this._fhPvpFoe) rate *= this._fhPvpFoe.stateRate(stateId);
    return rate;
};

var _enemyIsStateResistPvp = Game_Enemy.prototype.isStateResist;
Game_Enemy.prototype.isStateResist = function(stateId) {
    return _enemyIsStateResistPvp.call(this, stateId) ||
        !!(this._fhPvpFoe && this._fhPvpFoe.isStateResist(stateId));
};

var _applyItemEffectPvpStateTracking = Game_Action.prototype.applyItemEffect;
Game_Action.prototype.applyItemEffect = function(target, effect) {
    var previousStateContext = $.pvpStateApplyContext;
    $.pvpStateApplyContext = { action: this, target: target };
    try {
        _applyItemEffectPvpStateTracking.call(this, target, effect);
    } finally {
        $.pvpStateApplyContext = previousStateContext;
    }
};

// Duel states (user decision 2026-10-26): blindness only from a hit on the
// head; a state that stops the other player acting (Red arc, the rats,
// Concussion...) at half the chance - one roll per action, so an attack on
// all five parts is not five tries - and for one turn at most on its PC
// ($.duelAddState).
$.DUEL_BLIND_STATES = [49, 93];
$.duelStateBlocked = function(target, stateId) {
    var context = $.pvpStateApplyContext;
    var action = context && context.target === target ? context.action : null;
    var subject = action && action.subject();
    if (!$.pvpBattle || !target || !target._fhPvpFoe || !subject || !subject.isActor()) return false;
    if ($.DUEL_BLIND_STATES.indexOf(stateId) >= 0) return target._fhPart !== 'head';
    var state = $dataStates[stateId];
    if (!state || state.restriction <= 0) return false;
    var rolls = action._fhDuelStunRoll = action._fhDuelStunRoll || {};
    if (rolls[stateId] === undefined) rolls[stateId] = Math.random() < 0.5;
    return !rolls[stateId];
};

var _addStatePvpStateTracking = Game_Battler.prototype.addState;
Game_Battler.prototype.addState = function(stateId) {
    if ($.duelStateBlocked(this, stateId)) return;
    _addStatePvpStateTracking.call(this, stateId);
    var context = $.pvpStateApplyContext;
    var subject = context && context.action && context.action.subject();
    if (context && context.target === this && $.pvpBattle && this._fhPvpFoe &&
            subject && subject.isActor() && this.isStateAffected(stateId)) {
        this._fhPvpAppliedStates = this._fhPvpAppliedStates || {};
        this._fhPvpAppliedStates[stateId] = true;
    }
};

var _makeEnemyActions = Game_Enemy.prototype.makeActions;
Game_Enemy.prototype.makeActions = function() {
    if (this._fhPvpFoe) {
        this.clearActions(); // the other player chooses for the torso
        return;
    }
    _makeEnemyActions.call(this);
};

// Duel HP damage on the foe's parts: the curve of the raw hit (each hit on
// its own: a multi-hit skill comes here once a hit), then a guard (or the
// Salmonsnake rune) halves limb damage, at least 1. A heal on the foe: the
// curve of the healed amount, on its body only; limbs and the head never
// heal. (MP is the other player's own: no curve.)
var _makeDamageValue = Game_Action.prototype.makeDamageValue;
Game_Action.prototype.makeDamageValue = function(target, critical) {
    var value = _makeDamageValue.call(this, target, critical);
    if ($.pvpBattle && target && target._fhPvpFoe) {
        var kind = target._fhPart;
        if (kind === 'head' && !$.pvpLegsDestroyed()) return 0;
        var hp = this.isHpEffect();
        if (value < 0) {
            if (!target._fhPvpCtl) return 0;
            return hp ? -$.pvpCurve(value) : value;
        }
        if (value > 0 && hp) value = $.pvpCurve(value);
        if (value > 0 && $.isPvpLimb(kind) && $.pvpHasGuard(target._fhPvpFoe, kind)) {
            value = Math.max(1, Math.round(value * 0.5));
        }
    }
    return value;
};

// Limbs and the head cannot regain HP. Damage on any proxy part also reduces
// the body (torso) pool, including regeneration damage such as poison and
// bleeding. (On Game_Battler, where MV defines gainHp: hooked on
// Game_BattlerBase before 0.38.3, this never ran - limbs healed, a limb hit
// left the torso alone, a broken torso or head did not fell the body.)
// A duelist's own character on its own PC: every change of its HP goes to
// its body ($.duelGainOwnBody).
var _gainHpPvp = Game_Battler.prototype.gainHp;
Game_Battler.prototype.gainHp = function(value) {
    if (value > 0 && this._fhPvpFoe && !this._fhPvpCtl) return;
    if (value && $.duelOwnsHp(this)) {
        $.duelGainOwnBody(this, value);
        return;
    }
    _gainHpPvp.call(this, value);
    if (!$.pvpBattle || !this._fhPvpFoe) return;

    var damage = Math.max(0, -value);
    var body = $.pvpBattle.ctl;
    var damageContext = _pvpDamageContext && _pvpDamageContext.target === this
        ? _pvpDamageContext : null;
    var bodyRate = damageContext ? damageContext.bodyRate : 1;
    var bodyDamage = this === body
        ? Math.round(damage * Math.max(0, bodyRate - 1))
        : Math.round(damage * bodyRate);

    if (body && bodyDamage > 0 && body.isAlive()) {
        // (setHp: the torso's own hit result, if any, stays as it was)
        body.setHp(Math.max(0, body.hp - bodyDamage));
        if (body !== this) $.checkPvpParts(body);
    }
    $.checkPvpParts(this);
};

// A recovery item or skill on the foe: what it would heal the other player's
// character (its own max HP), through the curve, on its body only.
var _itemEffectRecoverHpPvp = Game_Action.prototype.itemEffectRecoverHp;
Game_Action.prototype.itemEffectRecoverHp = function(target, effect) {
    if ($.pvpBattle && target && target._fhPvpFoe && effect) {
        if (!target._fhPvpCtl) return; // limbs and the head never heal
        var raw = (target._fhPvpFoe.mhp * effect.value1 + effect.value2) * target.rec;
        if (this.isItem()) raw *= this.subject().pha;
        raw = Math.floor(raw);
        if (raw !== 0) {
            target.gainHp(raw > 0 ? $.pvpCurve(raw) : -$.pvpCurve(raw));
            this.makeSuccess(target);
        }
        return;
    }
    _itemEffectRecoverHpPvp.call(this, target, effect);
};

// A foe part fell: a limb is cut, the head lock and the AoE share are looked
// at again. Torso or head destroyed: the other player has lost, every part
// falls (pb.foeDown; the parts that fall with it are not cut).
$.checkPvpParts = function(target) {
    var pb = $.pvpBattle;
    if (!pb || !target.isEnemy() || !target._fhPvpFoe || !target.isDead()) return;
    var kind = target._fhPart;
    if (!pb.foeDown) {
        pb.cut[kind] = true;
        if ($.isPvpLimb(kind) && !target._fhCutTold) {
            target._fhCutTold = true;
            $.battleGab($.pvpCutText(target._fhPvpFoe.name(), kind), true);
        }
    }
    $.updatePvpHead();
    $.updatePvpAoeBodyRate();
    if ((kind === 'torso' || kind === 'head') && !pb.foeDown) $.pvpFoeFalls();
};

// The foe lost: every part of it falls here. A part the battle keeps
// standing for the rest of an action (YEP's IMMORTAL on its targets) too.
$.pvpFoeFalls = function() {
    if ($.pvpBattle) $.pvpBattle.foeDown = true;
    $gameTroop.members().forEach(function(e) {
        if (e.isImmortal && e.isImmortal() && e.removeImmortal) e.removeImmortal();
        if (e.isAlive()) {
            e.addState(e.deathStateId());
            e.performCollapse();
        }
    });
};

// A foe part that falls, however it fell: in its own hit (gainHp), when the
// battle's action ends (YEP lifts IMMORTAL from its targets: a part at 0 HP
// falls only then), a death state, the other PC's stream. Before 0.38.3 only
// the first was looked at: a leg cut by the battle's own attack never
// unlocked the head (play test 0.38.3-pre3).
var _refreshPvpPart = Game_Battler.prototype.refresh;
Game_Battler.prototype.refresh = function() {
    _refreshPvpPart.call(this);
    if (!this._fhPvpFoe || !$.pvpBattle || !this.isEnemy()) return;
    var down = this.isDead();
    if (!!this._fhPvpDown === down) return;
    this._fhPvpDown = down;
    if (down) {
        $.checkPvpParts(this);
    } else {
        $.updatePvpHead();
        $.updatePvpAoeBodyRate();
    }
};

// Every frame of a duel battle (cheap: a few parts): the head lock follows
// the legs, and once the foe lost nothing of it stands, whatever path
// changed them.
$.duelFoePartsFrame = function() {
    var pb = $.pvpBattle;
    if (!pb) return;
    if ($.updatePvpHead()) $.updatePvpAoeBodyRate();
    if (pb.foeDown && $gameTroop.members().some(function(e) { return e._fhPvpFoe && e.isAlive(); })) {
        $.pvpFoeFalls();
    }
};

$.pvpFoeCuts = function() {
    return $.pvpBattle ? Object.keys($.pvpBattle.cut) : [];
};

// False-flag exceptions: opponent-only states and wiki-listed battle states.
$.PVP_BATTLE_ONLY_STATE_IDS = [29, 49, 57, 58, 59, 60, 89, 93, 174, 214];
$.pvpStatePersistsAfterBattle = function(stateId) {
    var state = $dataStates[stateId];
    return !!state && !state.removeAtBattleEnd &&
        $.PVP_BATTLE_ONLY_STATE_IDS.indexOf(stateId) < 0;
};

$.pvpFoeStates = function(pb) {
    var turnsByState = {};
    if (!pb) return [];
    $gameTroop.members().forEach(function(e) {
        if (!e._fhPvpFoe || !e.isAlive() || e.isHidden()) return;
        (e._states || []).forEach(function(stateId) {
            var turns = e._stateTurns && Number(e._stateTurns[stateId]);
            if (stateId > 0 && stateId !== e.deathStateId() && $.pvpStatePersistsAfterBattle(stateId) &&
                    e._fhPvpAppliedStates && e._fhPvpAppliedStates[stateId] && turns > 0) {
                turnsByState[stateId] = Math.max(turnsByState[stateId] || 0, Math.floor(turns));
            }
        });
    });
    return Object.keys(turnsByState).map(function(stateId) {
        return [Number(stateId), turnsByState[stateId]];
    });
};

$.applyPvpFoeStates = function(actor, states) {
    if (!actor || !Array.isArray(states)) return;
    states.forEach(function(entry) {
        var stateId = Math.floor(Number(entry && entry[0]));
        var turns = Math.floor(Number(entry && entry[1]));
        if (stateId <= 0 || !$.pvpStatePersistsAfterBattle(stateId) ||
                stateId === actor.deathStateId() || turns <= 0) return;
        if (!actor.isStateAffected(stateId)) actor.addState(stateId);
        if (actor.isStateAffected(stateId)) {
            actor._stateTurns[stateId] = Math.max(Number(actor._stateTurns[stateId]) || 0, turns);
        }
    });
};

// Host: the duel is over. msg.pvp: { won: the attacker won, cuts: { player
// id: [the limbs it lost in the duel] } } (foeCut, the older form: the foe's,
// when the attacker won).
$.finishPvp = function(b, msg) {
    var pvp = (msg && msg.pvp) || {};
    var won = !!pvp.won;
    var loser = won ? b.foeId : b.attackerId;
    var winner = won ? b.attackerId : b.foeId;
    var cuts = pvp.cuts || {};
    [b.attackerId, b.foeId].forEach(function(id) { $.applyDuelCuts(id, cuts[id]); });
    if (won && pvp.foeCut) $.applyDuelCuts(b.foeId, pvp.foeCut);
    [b.attackerId, b.foeId].forEach(function(id) {
        var c = id === 'host' ? null : $.clientById(id);
        if (c) c.inBattle = 0;
    });
    $.sendDuelEnd(b, winner);
    // a duel to the death (mind 0, "Mind 0: a duel to the death" below): one
    // line, "<winner> killed <loser>.", in place of the two
    // (a loser that left: the name it had - its connection is gone by now)
    var label = function(id) { return (b.names && b.names[id]) || $.playerLabel(id); };
    $.broadcastToast(b.lethal ? label(winner) + ' killed ' + label(loser) + '.' : label(winner) + ' won the duel.');
    $.quietDeath = !!b.lethal; // (no second line for that death: killPlayer, hostDeadWatch)
    // its body is a contestant's (FH_CoopRoam "Bodies as events"): the actor
    // that died in a duel, the tower's or one to the death
    var lostActor = !b.test && $.actorOfPlayer(loser);
    if (lostActor) $.duelDead()[lostActor.actorId()] = true;
    try {
        if (loser === 'host') {
            // The host runs the world: when the host falls the session ends.
            $.hostDies();
            return;
        }
        $.killPlayer(loser, 'was killed in the duel');
    } finally {
        $.quietDeath = false;
    }
    var actor = $.actorOfPlayer(loser);
    if (actor) {
        var sel = $.SELECT_OF_ACTOR[actor.actorId()];
        if (sel && loser !== 'host') {
            // The loser no longer counts as a protagonist anywhere.
            var c = $.clientById(loser);
            if (c) c._fhNoSelect = true;
        }
    }
};

// A limb lost in the duel is lost for good (the character's switches).
$.applyDuelCuts = function(id, kinds) {
    var actor = $.actorOfPlayer(id);
    if (!actor || !kinds || !kinds.length) return;
    var sw = $.LIMB_SWITCHES[actor.actorId()] || [];
    var has = function(k) { return kinds.indexOf(k) >= 0; };
    if (sw[0] && (has('armR') || has('arms'))) $gameSwitches.setValue(sw[0], true);
    if (sw[1] && (has('armL') || has('arms'))) $gameSwitches.setValue(sw[1], true);
    if (sw[2] && (has('legR') || has('legs'))) $gameSwitches.setValue(sw[2], true);
    if (sw[3] && (has('legL') || has('legs'))) $gameSwitches.setValue(sw[3], true);
};

// Both duelists: the duel is over (win: that one won; without a winner the
// battle just ends, e.g. a duel called off).
$.sendDuelEnd = function(b, winner) {
    [b.attackerId, b.foeId].forEach(function(id) {
        var msg = { t: 'pvpEnd', bid: b.bid };
        if (winner) msg.win = id === winner;
        $.sendTo(id, msg);
    });
};

// The host's own duel battle ends -> it reports like a guest's PC does
// (battleEnd). A lost one is no down (endHostBattleDefeated).
var _endBattlePvp = BattleManager.endBattle;
BattleManager.endBattle = function(result) {
    var pb = $.pvpBattle;
    var cuts = pb ? $.duelSelfCuts() : [];
    if (pb && $.isHost()) $.sendDuelBody();
    _endBattlePvp.call(this, result);
    if ($.isHost() && pb && !$.localBattle) {
        $.pvpBattle = null;
        if (result === 2) $.hostDuelLost = true;
        var b = $.battles[pb.bid];
        if (b) $.duelReport(b, 'host', { won: result === 0, cuts: cuts });
    }
};

// canUse() on the map rejects battle-only skills.
$.canUseInDuel = function(actor, skill) {
    return actor.isSkillWtypeOk(skill) && actor.canPaySkillCost(skill) &&
        !actor.isSkillSealed(skill.id) && !actor.isSkillTypeSealed(skill.stypeId);
};

// Simple list box (DOM): up/down + Enter. With cancelIndex, Esc / X picks it.
// Returns a function that closes it without an answer.
// One box at a time: a new one waits until the one up is answered. (It
// replaced the one up and left that one's key listener on: one Enter answered
// the hidden duel Talk box too, and two souls in a row made the first an
// Absorb nobody saw - 0.41 review 3 H9.) Returns a function that closes it,
// shown or still waiting.
$.pickQueue = [];
$.pickShown = null;
$.showPickBox = function(title, options, done, cancelIndex) {
    var entry = { title: title, options: options, done: done, cancelIndex: cancelIndex, close: null };
    $.pickQueue.push(entry);
    if (!$.pickShown) $.nextPickBox();
    return function() {
        var i = $.pickQueue.indexOf(entry);
        if (i >= 0) $.pickQueue.splice(i, 1);
        if ($.pickShown === entry) {
            entry.close();
            $.pickShown = null;
            $.nextPickBox();
        }
    };
};

$.nextPickBox = function() {
    var entry = $.pickQueue.shift();
    if (!entry || typeof document === 'undefined') return;
    $.pickShown = entry;
    var options = entry.options, cancelIndex = entry.cancelIndex;
    var old = document.getElementById('fhcoop-pick');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var box = document.createElement('div');
    box.id = 'fhcoop-pick';
    box.style.cssText = 'position:fixed;left:50%;top:60%;transform:translate(-50%,-50%);' +
        'z-index:102;background:rgba(0,0,0,0.85);padding:10px 16px;border:1px solid #888;' +
        'font:15px sans-serif;color:#fff;min-width:240px;';
    var index = 0;
    var render = function() {
        box.innerHTML = '<b>' + $.escape(entry.title) + '</b><br>' + options.map(function(o, i) {
            return (i === index ? '&#9654; ' : '&nbsp;&nbsp; ') + $.escape(o);
        }).join('<br>');
    };
    render();
    document.body.appendChild(box);
    entry.close = function() {
        document.removeEventListener('keydown', onKey, true);
        if (box.parentNode) box.parentNode.removeChild(box);
    };
    var onKey = function(e) {
        if (e.keyCode === 38) index = (index + options.length - 1) % options.length;
        else if (e.keyCode === 40) index = (index + 1) % options.length;
        else if (e.keyCode === 13 || e.keyCode === 90 ||
                (cancelIndex !== undefined && (e.keyCode === 27 || e.keyCode === 88))) {
            entry.close();
            e.stopPropagation();
            e.preventDefault();
            if ($.pickShown === entry) $.pickShown = null;
            entry.done(e.keyCode === 27 || e.keyCode === 88 ? cancelIndex : index);
            if (!$.pickShown) $.nextPickBox();
            return;
        } else return;
        e.stopPropagation();
        e.preventDefault();
        render();
    };
    document.addEventListener('keydown', onKey, true);
};

// A dead loser's SELECT switch stays off in every context.
var _enterContext = $.enterContext;
$.enterContext = function(conn) {
    _enterContext(conn);
    if (conn._fhNoSelect) {
        $.SELECT_SWITCHES.forEach(function(id) { $gameSwitches._data[id] = false; });
    }
};

//-----------------------------------------------------------------------------
// Betrayal tournament: once only the players' characters are left, the
// living players duel at the tower door one pair at a time until one is left.
// That one is then the last participant (V201 = 1): the original door opens.
//-----------------------------------------------------------------------------

$.TOURNEY_GAB = 'Strange... a murderous urge toward each other is boiling up!!!';
$.TOWER_NOTHING_GAB = '... Nothing happens.';
$.TOWER_DOWN_GAB = 'Someone is down. Revive them first, or wait.';
$.TOWER_BUSY_GAB = 'The duels are under way.';
$.TOWER_WAIT_GAB = 'Someone is busy (in a fight or an event). Wait for them.';
// The original "going crazy" scene at the tower (Map111 EV617, user decision
// 2026-11-03: its own staging, not one of ours). Page 0 turns the screen
// black and turns on "<name>_in_party" for each contestant in the party: the
// seat event of that companion (EV616-625, its first page needs that switch)
// stands it there. Page 1 lights the screen again, and each companion holds
// its head (the seat event's next page: $characters_distress, Olivia's
// $botanist_sawing4) to the heartbeat of CE457 HEARTBEAT1. Here the players
// take their characters' seats and all hold their heads at once; what the
// original does after (the words, the moonscorched forms, the fights) is
// left out: the duels follow. Every value comes from the game's data
// ($.towerSceneData); the player's spot of page 0 (21,26) is the camera's.
$.TOWER_SCENE_EVENT = 617;
$.TOWER_HEART_CE = 457;      // HEARTBEAT1: V800 picks the companion it zooms on
$.HEARTBEAT_VAR = 800;
$.DUEL_POSE_SHEET = '$characters_distress'; // (a pose without a sheet of its own)
$.TOWER_DARK_TONE = [-255, -255, -255, 0];  // EV617 page 0's tint
$.TOWER_TINT_FRAMES = 80;                   // the original's tints, both ways
// (real time, $.clockMs: in frames the staging ran 2.4 times as fast on a
// 144 Hz screen - 0.4 review A6)
$.DUEL_DARK_MS = 1400;       // to black (80 frames), then everyone in its seat
$.DUEL_LIGHT_MS = 1400;      // back from black (80 frames), then the heads held
$.DUEL_POSE_MS = 2600;       // the heartbeat (CE457, about 1.6 s) and a moment more
$.DUEL_INTRO_MS = 5600;      // the first duel starts after this
$.TOWER_TELL_MS = 1000;      // the door's message, at most this often per player

// The heartbeat of the Eye of Rher (CE456 HEARTBEAT2, hard mode) without its
// zoom on one character: sound, motion blur, RGB split and a small zoom
// pulse, twice. Run by a local interpreter on each PC.
$.duelHeartList = function() {
    var zoom = function(code) {
        return { code: 355, indent: 0, parameters: ['if (typeof Galv !== "undefined" && Galv.ZOOM) Galv.ZOOM.' + code + ';'] };
    };
    var cmd = function(code, params) { return { code: code, indent: 0, parameters: params }; };
    var beat = [
        cmd(356, ['createFilter MOTION2 motionblur 0']), cmd(356, ['setFilter MOTION2 4 4']),
        cmd(356, ['createFilter RGB2 rgbsplit 0 0']), cmd(356, ['setFilter RGB2 3 3']),
        zoom('center(1.05,8)'), cmd(230, [8]), zoom('restore(30)'), cmd(230, [30]),
        cmd(356, ['eraseFilter MOTION2']), cmd(356, ['eraseFilter RGB2']), cmd(230, [7])
    ];
    return [cmd(250, [{ name: 'heartbeat_387072__tobiasludwig__heartbeat_01', volume: 90, pitch: 100, pan: 0 }])]
        .concat(beat, beat, [cmd(0, [])]);
};

// CE457 as it is, but each PC zooms on its own player: every "V800 ==
// <companion>" branch is false, so its last "else" (Galv.ZOOM.target(0), the
// player) runs. (The variable is a world value: not set for this.)
$.towerHeartList = function() {
    var ce = $dataCommonEvents && $dataCommonEvents[$.TOWER_HEART_CE];
    if (!ce) return $.duelHeartList();
    return ce.list.map(function(cmd) {
        var p = cmd.parameters;
        if (cmd.code === 111 && p[0] === 1 && p[1] === $.HEARTBEAT_VAR) {
            return { code: 111, indent: cmd.indent, parameters: [12, 'false'] };
        }
        return cmd;
    });
};

// From EV617 page 0 and the seat events (Map111 only, read once):
// { seats: { actor id: { x, y, d, pose: [direction, pattern, sheet, index] } },
//   center: [x, y] }, or null on another map.
$.towerScene = null;
$.towerSceneData = function() {
    if ($.towerScene) return $.towerScene;
    if (!$dataMap || !$gameMap || $gameMap.mapId() !== $.TOWER_MAP) return null;
    var ev = $dataMap.events[$.TOWER_SCENE_EVENT];
    if (!ev || !ev.pages[0]) return null;
    var scene = { seats: {}, center: null };
    var actorId = 0;
    ev.pages[0].list.forEach(function(cmd) {
        var p = cmd.parameters;
        if (cmd.code === 111 && p[0] === 4 && p[2] === 0) { // IF <actor> in the party
            actorId = p[1];
        } else if (cmd.code === 121 && actorId) {           // <name>_in_party ON
            var seat = $.towerSeatOf(p[0]);
            if (seat) scene.seats[actorId] = seat;
            actorId = 0;
        } else if (cmd.code === 201 && p[0] === 0 && p[1] === $.TOWER_MAP) {
            scene.center = [p[2], p[3]];
        }
    });
    $.towerScene = scene;
    return scene;
};

// The event that stands a companion there once its "_in_party" switch is on.
$.towerSeatOf = function(sw) {
    var seat = null;
    $dataMap.events.some(function(e) {
        var first = e && e.pages[0];
        var c = first && first.conditions;
        if (!c || !c.switch1Valid || c.switch1Id !== sw || c.switch2Valid) return false;
        var held = e.pages[1]; // (that switch and "<name>_going_crazy")
        var img = held && held.conditions.switch1Valid && held.conditions.switch1Id === sw ? held.image : null;
        seat = { x: e.x, y: e.y, d: first.image.direction,
            pose: img ? [img.direction, img.pattern, img.characterName, img.characterIndex] : null };
        return true;
    });
    return seat;
};

// (all in real time, $.clockMs: drawn frames run as fast as the screen)
$.DUEL_GAP_MS = 2000;        // between two duels
$.DUEL_WAIT_TELL_MS = 10000; // "the next duel waits for ..." again after this
$.DUEL_RETRY_MS = 10000;     // a duel that could not be set up is tried again after this
$.DUEL_OPEN_MS = 60000;      // a duel not open on both PCs by then is called off (checkDuelOpen)
$.DUEL_TIMEOUT_MS = 300000;  // a duel this long is checked for a silent player
$.DUEL_SILENT_MS = 90000;    // nothing heard from a guest for this long: it is gone

$.tourney = null; // host: { players, round, next, cur: { a, b, bid, snap, since }, introUntil, nextAt (ms), duels }
$.towerToldAt = {}; // host: player id -> ms of the last door message
$.duelIntro = null; // every PC: { seatAt, poseAt, until (ms), tone, seated, posed, heart, chars: [posed], ids, actors }
$.duelSnap = null; // guest: its own bag when its duel started

// Players whose characters are still alive (down counts as alive).
$.towerLiving = function() {
    var ids = $.isDead('host') ? [] : ['host'];
    $.activeGuests().forEach(function(c) {
        if (!$.isDead(c.guestId)) ids.push(c.guestId);
    });
    return ids;
};

$.playerMapOf = function(id) {
    if (id === 'host') return $gameMap.mapId();
    var conn = $.clientById(id);
    if (!conn || !conn.lastPos) return 0;
    return conn.lastPos.m || $gameMap.mapId();
};

// Characters of players who are not connected now and have not died: they
// still count in V201 and are missing at the tower.
$.towerOffline = function() {
    var assign = $.assignments(), dead = $.coopDead();
    var online = {};
    $.clients.forEach(function(c) { if (c.name) online[c.name] = true; });
    return Object.keys(assign).filter(function(name) {
        var sw = $.DEATH_SWITCH[assign[name]];
        return !online[name] && !dead[name] && !!sw && !$gameSwitches.value(sw);
    });
};

// 'original' | 'tourney' | 'down' | 'gather' | 'busy' | 'wait'
$.towerDoorCheck = function() {
    var living = $.towerLiving();
    var offline = $.towerOffline();
    if (living.length + offline.length < 2) return 'original';
    if ($.tourney) return 'busy';
    // other Termina participants still alive: the door is the original one
    if ($gameVariables.value($.CHARACTERS_LEFT_VAR) > living.length + offline.length) return 'original';
    if (living.some(function(id) { return !!$.downs[id]; })) return 'down';
    var away = living.some(function(id) { return $.playerMapOf(id) !== $.TOWER_MAP; });
    if (offline.length && !away) return 'absent'; // everyone here but the ones not connected: vote
    if (offline.length || away) return 'gather';
    // nobody is moved into the row out of a fight, an event or a menu
    if (living.some(function(id) { return !$.duelReady(id); })) return 'wait';
    return 'tourney';
};

// Bumping the door repeats every frame: tell once a second.
$.towerDoorTell = function(id, check) {
    var text = check === 'down' ? $.TOWER_DOWN_GAB : check === 'gather' ? $.TOWER_NOTHING_GAB :
        check === 'busy' ? $.TOWER_BUSY_GAB : check === 'wait' ? $.TOWER_WAIT_GAB : '';
    if (!text) return;
    var at = $.towerToldAt[id], now = $.clockMs();
    if (at !== undefined && now - at <= $.TOWER_TELL_MS) return;
    $.towerToldAt[id] = now;
    $.sendTo(id, { t: 'gab', text: text });
};

$.shuffle = function(list) {
    for (var i = list.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var x = list[i];
        list[i] = list[j];
        list[j] = x;
    }
    return list;
};

// Pairs in order; an odd one out waits for the next round (a bye).
$.bracketText = function(round) {
    var parts = [];
    for (var i = 0; i + 1 < round.length; i += 2) {
        parts.push($.playerLabel(round[i]) + ' vs ' + $.playerLabel(round[i + 1]));
    }
    var text = (parts.length > 1 ? 'Duels: ' : 'Duel: ') + parts.join(', then ');
    if (round.length % 2) text += '. ' + $.playerLabel(round[round.length - 1]) + ' waits for the next round';
    return text + '.';
};

$.startTourney = function(ids) {
    var order = $.shuffle(ids.slice());
    order.forEach(function(id) {
        var conn = id === 'host' ? null : $.clientById(id);
        // no sub-hosting while the duels last: each guest runs its own map,
        // so its duel results and its heal come to the host directly
        if (conn && conn.subOf) {
            $.detachSub(conn);
            conn.roam = true;
            $.sendRoam(conn, { pos: conn.lastPos });
        }
    });
    var actors = {};
    order.forEach(function(id) {
        var actor = $.actorOfPlayer(id);
        actors[id] = actor ? actor.actorId() : 0;
    });
    $.tourney = {
        players: order.slice(), round: order, next: [], cur: null,
        introUntil: $.clockMs() + $.DUEL_INTRO_MS, nextAt: 0, duels: 0
    };
    $.dlog('betrayal tournament', order.join(' '));
    var msg = { t: 'tourneyIntro', ids: order, text: $.TOURNEY_GAB, actors: actors };
    $.activeGuests().forEach(function(c) { c.send(msg); });
    $.guestHandlers.tourneyIntro(msg);
    $.broadcastToast($.bracketText(order));
};

// Every PC: the gab, then the original scene (each PC seats its own player
// and the avatars it draws: a roaming guest's spot reaches the host as any
// step does).
$.guestHandlers.tourneyIntro = function(msg) {
    if ($.fieldGab) $.fieldGab(msg.text); else $.toast(msg.text);
    $.playDuelIntro(msg.ids || [], msg.actors || {});
};

// Each player in its character's seat (once the screen is black). The host
// keeps a thin guest's new spot for the avatars it sends on.
$.seatDuelists = function(ids, actors) {
    var scene = $.towerSceneData();
    if (!scene) return;
    var me = $.myPlayerId();
    ids.forEach(function(id) {
        var seat = scene.seats[actors[id]];
        if (!seat) return; // (no seat: stays where it is)
        if (id === me) {
            $gamePlayer.locate(seat.x, seat.y);
            $gamePlayer.setDirection(seat.d);
            return;
        }
        var remote = $.remotes[id];
        if (remote) {
            remote.setPosition(seat.x, seat.y);
            remote._direction = seat.d;
        }
        var conn = $.isHost() && id !== 'host' ? $.clientById(id) : null;
        if (conn && conn.lastPos && !conn.roam) {
            conn.lastPos.x = seat.x;
            conn.lastPos.y = seat.y;
            conn.lastPos.d = seat.d;
        }
    });
    if (scene.center) $gamePlayer.center(scene.center[0], scene.center[1]);
    if ($.isGuest() && $.isThin() && $.guestSync) $.guestSync(); // the host sees the new spot now
};

// Nobody walks out of the scene.
var _canMoveDuelIntro = Game_Player.prototype.canMove;
Game_Player.prototype.canMove = function() {
    if ($.duelIntro) return false;
    return _canMoveDuelIntro.call(this);
};

// EV617 page 0: to black. The rest goes on in $.updateDuelIntro.
$.playDuelIntro = function(ids, actors) {
    if (!$gameMap || $gameMap.mapId() !== $.TOWER_MAP) return; // e.g. a dead host watching elsewhere
    var now = $.clockMs();
    $.duelIntro = { seatAt: now + $.DUEL_DARK_MS, poseAt: now + $.DUEL_DARK_MS + $.DUEL_LIGHT_MS,
        until: now + $.DUEL_DARK_MS + $.DUEL_LIGHT_MS + $.DUEL_POSE_MS,
        tone: $gameScreen.tone().slice(), seated: false, heart: null, chars: [], ids: ids, actors: actors || {} };
    $gameScreen.startTint($.TOWER_DARK_TONE, $.TOWER_TINT_FRAMES);
};

// EV617 page 1: everyone holds its head (its seat event's pose) to CE457.
$.showDuelPoses = function(d) {
    var me = $.myPlayerId();
    var seats = ($.towerSceneData() || { seats: {} }).seats;
    d.ids.forEach(function(id) {
        var ch = id === me ? $gamePlayer : $.remotes[id];
        var seat = seats[d.actors[id]];
        if (!ch || !seat || !seat.pose) return;
        ch._fhPose = seat.pose;
        d.chars.push(ch);
    });
    d.heart = new Game_Interpreter();
    d.heart.setup($.towerHeartList(), 0);
};

$.stopDuelHeart = function(d) {
    if (!d.heart) return;
    d.heart = null;
    try {
        var interp = new Game_Interpreter();
        ['MOTION2', 'RGB2', 'SATURATION2'].forEach(function(id) { interp.pluginCommand('eraseFilter', [id]); });
        if (typeof Galv !== 'undefined' && Galv.ZOOM) Galv.ZOOM.restore(1);
    } catch (e) {}
};

// restoreTint: cut short while the screen is (going) black.
$.endDuelIntro = function(restoreTint) {
    var d = $.duelIntro;
    if (!d) return;
    $.duelIntro = null;
    $.stopDuelHeart(d);
    (d.chars || []).forEach(function(ch) { delete ch._fhPose; });
    if (restoreTint && !d.seated && $gameScreen) $gameScreen.startTint(d.tone, 30);
};

$.updateDuelIntro = function() {
    var d = $.duelIntro;
    if (!d) return;
    var now = $.clockMs();
    if (!d.seated) {
        if (now < d.seatAt) return;
        d.seated = true;
        $.seatDuelists(d.ids, d.actors);
        $gameScreen.startTint(d.tone, $.TOWER_TINT_FRAMES);
    }
    if (!d.posed) {
        if (now < d.poseAt) return;
        d.posed = true;
        $.showDuelPoses(d);
    }
    if (d.heart) {
        try {
            d.heart.update();
            if (!d.heart.isRunning()) d.heart = null;
        } catch (e) {
            $.dlog('duel heartbeat skipped', String(e && e.message || e)); // no filter plugin / scene: just the pose
            $.stopDuelHeart(d);
        }
    }
    if (now < d.until) return;
    $.endDuelIntro(true);
};

// The pose: drawn from its sheet while it lasts (the character's own image,
// direction and step stay as they are underneath).
var _spriteCharacterUpdateBitmapPose = Sprite_Character.prototype.updateBitmap;
Sprite_Character.prototype.updateBitmap = function() {
    var pose = this._character && this._character._fhPose;
    var sheet = pose && (pose[2] || $.DUEL_POSE_SHEET);
    if (pose && this._characterName !== sheet) {
        this._tileId = 0;
        this._characterName = sheet;
        this._characterIndex = pose[3] || 0;
        this.setCharacterBitmap();
        this._fhPosed = true;
        return;
    }
    if (pose) return;
    if (this._fhPosed) {
        this._fhPosed = false;
        this._characterName = ''; // back to the character's own image
    }
    _spriteCharacterUpdateBitmapPose.call(this);
};

var _spriteCharacterPatternXPose = Sprite_Character.prototype.characterPatternX;
Sprite_Character.prototype.characterPatternX = function() {
    var pose = this._character && this._character._fhPose;
    return pose ? pose[1] : _spriteCharacterPatternXPose.call(this);
};

var _spriteCharacterPatternYPose = Sprite_Character.prototype.characterPatternY;
Sprite_Character.prototype.characterPatternY = function() {
    var pose = this._character && this._character._fhPose;
    return pose ? (pose[0] - 2) / 2 : _spriteCharacterPatternYPose.call(this);
};

var _sceneMapUpdateDuelIntro = Scene_Map.prototype.update;
Scene_Map.prototype.update = function() {
    _sceneMapUpdateDuelIntro.call(this);
    $.updateDuelIntro();
};

// Dead, gone or no longer playing.
$.tourneyOut = function(id) {
    if (id === 'host') return $.isDead('host');
    var conn = $.clientById(id);
    return !conn || !conn.actorId || !!conn.solo || $.isDead(id);
};

// Free for a duel: on the tower map, not down, in no fight, event or menu.
$.duelReady = function(id) {
    if ($.playerMapOf(id) !== $.TOWER_MAP || $.isDown(id)) return false;
    if (id === 'host') {
        return !$gameParty.inBattle() && SceneManager._scene instanceof Scene_Map &&
            !SceneManager.isSceneChanging() &&
            !$gameMap.isEventRunning() && !$gameMessage.isBusy() && !$.hostInJoin &&
            !$.pvpBattle && !$.pendingDuel && !$gamePlayer.isTransferring();
    }
    var conn = $.clientById(id);
    // a roaming guest reports its own events, messages and menus (roamBusy)
    return !!conn && !$.isBusy(conn) && !conn._menuBase && !(conn.roam && conn.roamBusy);
};

// A menu holds the duels TOURNEY_MENU_MS at most (user decision 2026-10-22,
// "나"): then that player's menu closes and the duels go on. Only a menu the
// player opened (not a shop or a name entry of an event), never a fight or
// an event. Equipment put on in it stays on; an item not used yet is not used.
$.TOURNEY_MENU_MS = 90000;      // (real time, $.clockMs)
$.MENU_CLOSE_AGAIN_MS = 5000;   // asked again while it is still open
$.tourneyAsk = null;            // host: { since, closedAt } the door was used while someone was not free

// Not free only because of its menu.
$.inMenuOnly = function(id) {
    if ($.playerMapOf(id) !== $.TOWER_MAP || $.isDown(id)) return false;
    if (id === 'host') {
        return $.menuCanClose() && !$gameParty.inBattle() && !$.hostInJoin && !$.pvpBattle && !$.pendingDuel;
    }
    var conn = $.clientById(id);
    if (!conn || $.isBusy(conn)) return false;
    return conn.roam ? !!(conn.roamBusy && conn.roamMenu) : !!conn._menuBase;
};

// This PC's menu, one the player opened.
$.menuCanClose = function() {
    var scene = SceneManager._scene;
    if (!(scene instanceof Scene_MenuBase) || scene instanceof Scene_Shop || scene instanceof Scene_Name ||
            SceneManager.isSceneChanging()) return false;
    var runsEvents = $.isHost() || !!($.isRoaming && $.isRoaming());
    return !(runsEvents && $gameMap && $gameMap.isEventRunning()); // (a menu an event opened)
};

$.leaveMenuForDuel = function(text) {
    if (!$.menuCanClose()) return false;
    $.dlog('the duels go on: this menu is closed');
    $.toast(text || 'Co-op: the duels go on - your menu was closed');
    SceneManager._stack.length = 0; // (the menu's own scenes too: back to the map)
    SceneManager.goto(Scene_Map);
    return true;
};

$.guestHandlers.duelMenuClose = function(msg) {
    $.leaveMenuForDuel(msg && msg.text);
};

// The ones of ids in a menu for TOURNEY_MENU_MS: closed. Counted from when
// each one's menu was first seen open (holder.menuSince), not from the start
// of the wait: a menu opened after a long fight or event got only seconds
// (0.4 review 2 M2). A player out of its menu starts again from zero.
$.closeDuelMenus = function(ids, holder) {
    var now = $.clockMs();
    var seen = holder.menuSince = holder.menuSince || {};
    var menus = ids.filter(function(id) {
        if (!$.inMenuOnly(id)) {
            delete seen[id];
            return false;
        }
        if (!seen[id]) seen[id] = now;
        return now - seen[id] >= $.TOURNEY_MENU_MS;
    });
    if (!menus.length || now - (holder.closedAt || 0) < $.MENU_CLOSE_AGAIN_MS) return;
    holder.closedAt = now;
    $.dlog('duels: menu closed for', menus.join(' '), 'after', $.TOURNEY_MENU_MS / 1000, 's in it');
    $.broadcastToast(menus.map($.playerLabel).join(' and ') + ' stayed in the menu: it is closed, the duels go on.');
    menus.forEach(function(id) {
        if (id === 'host') $.leaveMenuForDuel();
        else $.sendTo(id, { t: 'duelMenuClose' });
    });
};

// The door used while someone is not free: the duels start by themselves
// once everyone is (before, the door had to be used again; a menu held them
// for good).
$.noteTourneyAsk = function() {
    if ($.tourneyAsk || $.tourney) return;
    $.tourneyAsk = { since: $.clockMs(), closedAt: 0, checkedAt: 0, menuSince: {} };
    $.closeDuelMenus($.towerLiving(), $.tourneyAsk); // (notes who is in a menu now)
    var menus = $.towerLiving().filter($.inMenuOnly);
    $.broadcastToast('the duels start once everyone is free' + (menus.length ? ' (' +
        menus.map($.playerLabel).join(' and ') + ': a menu closes after ' + $.TOURNEY_MENU_MS / 1000 + ' s).' : '.'));
};

$.updateTourneyAsk = function() {
    var ask = $.tourneyAsk;
    if (!ask || !$.isHost()) return;
    var now = $.clockMs();
    if (now - ask.checkedAt < 250) return;
    ask.checkedAt = now;
    if ($.tourney) {
        $.tourneyAsk = null;
        return;
    }
    var check = $.towerDoorCheck();
    if (check === 'tourney') {
        $.tourneyAsk = null;
        $.dlog('betrayal: everyone is free now - the tournament starts');
        $.startTourney($.towerLiving());
        return;
    }
    if (check !== 'wait') { // someone went away, went down, ...: the door again
        $.tourneyAsk = null;
        return;
    }
    $.closeDuelMenus($.towerLiving(), ask);
};

// The bag, and the weapons and armour the actor wears, by id.
$.copyInv = function(inv, actor) {
    var copy = { i: Object.assign({}, inv.i || {}), w: Object.assign({}, inv.w || {}),
        a: Object.assign({}, inv.a || {}), ew: {}, ea: {} };
    if (actor) $.countEquips(actor, copy.ew, copy.ea);
    return copy;
};

$.countEquips = function(actor, ew, ea) {
    actor.equips().forEach(function(item) {
        if (!item) return;
        var box = DataManager.isWeapon(item) ? ew : ea;
        box[item.id] = (box[item.id] || 0) + 1;
    });
};

$.partyInv = function() {
    return { i: $gameParty._items, w: $gameParty._weapons, a: $gameParty._armors };
};

$.duelInvSnapshot = function(id) {
    var actor = $.actorOfPlayer(id);
    if (id === 'host') return $.copyInv($.partyInv(), actor);
    var conn = $.clientById(id);
    return conn ? $.copyInv($.inventoryOf(conn), actor) : null;
};

// What was used up comes back; what was gained stays. Something put on
// meanwhile is not given back again: each id comes back to what the bag and
// the actor held together at the start, less what the actor wears now.
$.restoreDuelItems = function(inv, snap, actor) {
    if (!inv || !snap) return;
    var ew = {}, ea = {};
    if (actor) $.countEquips(actor, ew, ea);
    var wornNow = { i: {}, w: ew, a: ea }, wornThen = { i: {}, w: snap.ew || {}, a: snap.ea || {} };
    ['i', 'w', 'a'].forEach(function(k) {
        inv[k] = inv[k] || {};
        var had = snap[k] || {};
        Object.keys(had).concat(Object.keys(wornThen[k])).forEach(function(itemId) {
            var back = (had[itemId] || 0) + (wornThen[k][itemId] || 0) - (wornNow[k][itemId] || 0);
            if ((inv[k][itemId] || 0) < back) inv[k][itemId] = back;
        });
    });
};

// Full recovery: cut limbs too (the switches of that character).
$.healLimbs = function(actor) {
    ($.LIMB_SWITCHES[actor.actorId()] || []).forEach(function(sw) {
        if ($gameSwitches.value(sw)) $gameSwitches.setValue(sw, false);
    });
};

// Host: the winner of a duel is healed fully and gets back what it used
// (snap: its bag when the duel started). A roaming guest's newest copy is
// on its own PC: it does the same there (duelWon).
$.duelHeal = function(id, snap) {
    var actor = $.actorOfPlayer(id);
    if (actor) {
        actor.recoverAll();
        $.healLimbs(actor);
    }
    if (id === 'host') {
        $.restoreDuelItems($.partyInv(), snap, actor);
        $gamePlayer.refresh();
        return;
    }
    var conn = $.clientById(id);
    if (!conn) return;
    $.restoreDuelItems($.inventoryOf(conn), snap, actor);
    conn._lastMeKey = null;
    $.pushMe(conn);
    conn.send({ t: 'duelWon' });
};

// Both duelists get it (each fights in a battle scene of its own). A battle
// still waiting for a free screen takes the bag when it opens ('pvp').
$.duelSnapAtOpen = false;
$.guestHandlers.duelStart = function() {
    $.duelSnapAtOpen = !!$.pendingDuel;
    $.duelSnap = $.copyInv($.partyInv(), $gameActors.actor($.myActorId));
};

$.guestHandlers.duelWon = function() {
    var snap = $.duelSnap;
    $.duelSnap = null;
    if ($.isThin()) return; // the host's copy comes with 'me'
    var actor = $gameActors.actor($.myActorId);
    if (actor) {
        actor.recoverAll();
        $.healLimbs(actor);
    }
    $.restoreDuelItems($.partyInv(), snap, actor);
    if ($gamePlayer) $gamePlayer.refresh();
    if ($.isRoaming && $.isRoaming() && $.sendRoamMe) $.sendRoamMe(true);
};

// The duel of cur is over (or one side is out): the bracket goes on.
$.tourneyMatchDone = function(winner, loser) {
    var t = $.tourney;
    var cur = t && t.cur;
    if (!cur) return;
    t.cur = null;
    t.duels++;
    t.nextAt = $.clockMs() + $.DUEL_GAP_MS;
    $.dlog('tournament duel over', winner, 'beat', loser);
    if ($.tourneyOut(winner)) return;
    $.duelHeal(winner, cur.snap ? cur.snap[winner] : null);
    t.next.push(winner);
    $.broadcastToast($.playerLabel(winner) + ' recovers fully.');
};

// A participant left the session: it forfeits and dies.
$.tourneyForfeit = function(conn) {
    var t = $.tourney;
    var id = conn.guestId;
    if (!t || t.players.indexOf(id) < 0) return;
    $.markDeadConn(conn, conn.name + ' left the duels and died.');
    var keep = function(other) { return other !== id; };
    t.round = t.round.filter(keep);
    t.next = t.next.filter(keep);
    var cur = t.cur;
    if (!cur || (cur.a !== id && cur.b !== id)) return;
    // it left a running duel: that duel was settled already (the other one
    // won, finishPvp)
    if (cur.bid && $.battles[cur.bid]) return;
    $.tourneyMatchDone(cur.a === id ? cur.b : cur.a, id);
};

$.tryStartDuel = function() {
    var t = $.tourney;
    var cur = t.cur;
    if (!$.duelReady(cur.a) || !$.duelReady(cur.b)) {
        if ($.clockMs() - (cur.toldAt || 0) >= $.DUEL_WAIT_TELL_MS) {
            cur.toldAt = $.clockMs();
            var waiting = [cur.a, cur.b].filter(function(id) { return !$.duelReady(id); });
            $.broadcastToast('the next duel waits for ' + waiting.map($.playerLabel).join(' and ') +
                ' (free, at the tower).');
        }
        return;
    }
    if ($.clockMs() < (cur.retryAt || 0)) return;
    // both fight in a battle scene: each may use its bag
    cur.snap = {};
    cur.snap[cur.a] = $.duelInvSnapshot(cur.a);
    cur.snap[cur.b] = $.duelInvSnapshot(cur.b);
    $.startPvp(cur.a, cur.b);
    Object.keys($.battles).forEach(function(k) {
        var b = $.battles[k];
        if (b.pvp && b.attackerId === cur.a && b.foeId === cur.b) cur.bid = b.bid;
    });
    if (!cur.bid) {
        cur.retryAt = $.clockMs() + $.DUEL_RETRY_MS;
        $.dlog('ERROR tournament duel could not start', cur.a, cur.b);
        return;
    }
    cur.startedAt = $.clockMs();
    $.battles[cur.bid].openBy = $.clockMs() + $.DUEL_OPEN_MS;
    [cur.a, cur.b].forEach(function(id) { if (id !== 'host') $.sendTo(id, { t: 'duelStart' }); });
};

// A duel whose battle is not open on both PCs after a while (one player
// stays in a menu or a message): called off, so the other one does not sit
// in a battle that stands still; it starts again once both are free. A PC
// that never answered at all is not busy but stuck or gone: that is for
// checkDuelTimeout (the side still heard from wins).
$.checkDuelOpen = function(b) {
    if (!b || !b.openBy || $.clockMs() <= b.openBy) return false;
    var opened = b.opened || {}, waiting = b.waiting || {};
    var ids = [b.attackerId, b.foeId];
    if (ids.every(function(id) { return opened[id]; })) {
        b.openBy = 0;
        return false;
    }
    var busy = ids.filter(function(id) { return !opened[id] && waiting[id]; });
    if (!busy.length) return false;
    var names = busy.map($.playerLabel).join(' and ');
    $.abortDuel(b, names + ' stayed busy');
    $.broadcastToast('the duel waits: ' + names + (busy.length > 1 ? ' are' : ' is') +
        ' busy. It starts again once both are free.');
    return true;
};

// A duel that never reports back: the side still heard from wins.
$.duelSilent = function(id) {
    if (id === 'host') return false;
    var conn = $.clientById(id);
    return !conn || $.clockMs() - (conn._fhHeardAt || 0) > $.DUEL_SILENT_MS;
};

$.checkDuelTimeout = function() {
    var cur = $.tourney.cur;
    var b = $.battles[cur.bid];
    if ($.clockMs() - (cur.startedAt || 0) < $.DUEL_TIMEOUT_MS) return;
    var silentA = $.duelSilent(cur.a), silentB = $.duelSilent(cur.b);
    if (silentA === silentB) return; // a long duel (or both silent): wait
    var winner = silentA ? cur.b : cur.a, loser = silentA ? cur.a : cur.b;
    $.dlog('tournament duel timed out:', loser, 'silent,', winner, 'wins');
    delete $.battles[cur.bid];
    $.unfreezeBattle(b);
    [cur.a, cur.b].forEach(function(id) {
        var c = $.clientById(id);
        if (c) c.inBattle = 0;
    });
    $.settledDuels[b.bid] = true;
    $.sendDuelEnd(b, winner);
    if (loser === 'host') $.hostDies();
    else $.killPlayer(loser, 'did not answer in the duel and died');
    $.tourneyMatchDone(winner, loser);
};

$.tourneyUpdate = function() {
    var t = $.tourney;
    if (!t || !$.isHost()) return;
    var now = $.clockMs();
    if (now < t.introUntil || now < (t.nextAt || 0)) return;
    var keep = function(id) { return !$.tourneyOut(id); };
    t.round = t.round.filter(keep);
    t.next = t.next.filter(keep);
    var cur = t.cur;
    if (cur) {
        if (cur.bid && $.battles[cur.bid]) { // the duel runs
            $.closeDuelMenus([cur.a, cur.b], cur); // (its battle waits for a menu)
            if (!$.checkDuelOpen($.battles[cur.bid])) $.checkDuelTimeout();
            return;
        }
        if (cur.bid) cur.bid = 0; // gone without a result: again
        var outA = $.tourneyOut(cur.a), outB = $.tourneyOut(cur.b);
        if (outA || outB) {
            if (outA && outB) t.cur = null;
            else $.tourneyMatchDone(outA ? cur.b : cur.a, outA ? cur.a : cur.b);
            return;
        }
        $.closeDuelMenus([cur.a, cur.b], cur);
        $.tryStartDuel();
        return;
    }
    if (t.round.length >= 2) {
        var isFinal = t.round.length === 2 && t.next.length === 0;
        t.cur = { a: t.round.shift(), b: t.round.shift(), bid: 0, toldAt: now, since: now, menuSince: {} };
        $.closeDuelMenus([t.cur.a, t.cur.b], t.cur); // (notes who is in a menu now)
        $.broadcastToast((isFinal ? 'Final: ' : 'Duel ' + (t.duels + 1) + ': ') +
            $.playerLabel(t.cur.a) + ' vs ' + $.playerLabel(t.cur.b) + '!');
        $.tryStartDuel();
        return;
    }
    if (t.round.length === 1) t.next.push(t.round.shift()); // the bye
    if (t.next.length >= 2) {
        t.round = t.next;
        t.next = [];
        return;
    }
    $.tourney = null;
    if (t.next[0]) {
        // the last participant: the original door opens for it (a death whose
        // switch was already on did not lower V201)
        $gameVariables.setValue($.CHARACTERS_LEFT_VAR, 1);
        $.dlog('tournament won by', t.next[0]);
        $.broadcastToast($.playerLabel(t.next[0]) + ' is the last one standing. The tower door awaits.');
    }
};

$.worldExtras.push(function() {
    if ($.tourney) $.tourneyUpdate();
    else if ($.tourneyAsk) $.updateTourneyAsk();
});

var _finishPvpTourney = $.finishPvp;
$.finishPvp = function(b, msg) {
    var t = $.tourney;
    var mine = !!t && !!t.cur && t.cur.bid === b.bid;
    _finishPvpTourney(b, msg);
    if (!mine) return;
    var won = !!(msg.pvp && msg.pvp.won);
    $.tourneyMatchDone(won ? b.attackerId : b.foeId, won ? b.foeId : b.attackerId);
};

// When the host last heard from each guest (duel timeout).
var _onHostMessageTourney = $.onHostMessage;
$.onHostMessage = function(conn, msg) {
    if (conn) conn._fhHeardAt = $.clockMs();
    return _onHostMessageTourney(conn, msg);
};

// A guest tells the host when it is in an event, a message or a menu (the
// host only sees a roaming guest's own world through this).
$.hostHandlers.roamBusy = function(conn, msg) {
    conn.roamBusy = !!msg.busy;
    conn.roamMenu = !!msg.menu; // (a menu the tournament may close)
};

$.lastRoamBusy = false;
$.lastRoamMenu = false;
var _sceneBaseUpdateRoamBusy = Scene_Base.prototype.update;
Scene_Base.prototype.update = function() {
    _sceneBaseUpdateRoamBusy.call(this);
    if (!$.isGuest() || !$.conn || !$.myActorId) return;
    var busy = !(this instanceof Scene_Map) || !$gameMap || $gameMap.isEventRunning() || $gameMessage.isBusy();
    var menu = busy && $.menuCanClose();
    if (busy === $.lastRoamBusy && menu === $.lastRoamMenu) return;
    $.lastRoamBusy = busy;
    $.lastRoamMenu = menu;
    $.conn.send({ t: 'roamBusy', busy: busy, menu: menu });
};

// Back at the title (a load follows): no tower tint left to restore.
var _sceneTitleStartDuelIntro = Scene_Title.prototype.start;
Scene_Title.prototype.start = function() {
    $.endDuelIntro(false);
    _sceneTitleStartDuelIntro.call(this);
};

var _onGuestClosedTourney = $.onGuestClosed;
$.onGuestClosed = function(conn) {
    _onGuestClosedTourney(conn);
    if ($.isHost() && $.tourney) $.tourneyForfeit(conn);
};

//-----------------------------------------------------------------------------
// Boss rooms: everyone there fights (user decision 2026-11-03)
//-----------------------------------------------------------------------------
// Kaiser's void room (Map136 EV1, troop 194) and the white womb of Logic
// (Map140 EV19, troop 191, easy mode 238): once anyone's fight with that
// boss runs, every other player on that map is put into it (the usual join,
// $.requestJoin). Not one down or dead; one in its menu has it closed; one
// busy (an event, a message, another fight, moving) comes in once free. Each
// one once a fight: one who left it stays out. The fight's places (4) are the
// limit. Also one who comes to the map while the fight lasts.
$.BOSS_ROOMS = { 194: 136, 191: 140, 238: 140 }; // troop -> its map
$.BOSS_PULL_MS = 250; // (real time) how often the host looks
$.BOSS_PULL_TEXT = 'Co-op: everyone in the room is drawn into the fight!';
$.BOSS_MENU_TEXT = 'Co-op: the fight began - your menu was closed';
$.bossPullAt = 0;

$.isBossRoomFight = function(b) {
    // (a fight a guest's own PC runs counts too: its ownWorld is that PC's map)
    return !!b && !b.pvp && $.BOSS_ROOMS[b.troopId] === b.mapId;
};

// Free to be put into a fight on mapId now.
$.bossJoinFree = function(id, mapId) {
    if ($.playerMapOf(id) !== mapId || $.isDown(id) || $.isDead(id)) return false;
    if (id === 'host') {
        return SceneManager._scene instanceof Scene_Map && !SceneManager.isSceneChanging() &&
            !$gameMap.isEventRunning() && !$gameMessage.isBusy() && !$.hostInJoin && !$.pvpBattle &&
            !$.pendingDuel && !$gamePlayer.isTransferring();
    }
    var conn = $.clientById(id);
    // (every guest PC reports its events, messages and menus: roamBusy)
    return !!conn && !!conn.actorId && !conn.solo && !$.isBusy(conn) && !conn._menuBase && !conn.roamBusy;
};

// Held only by a menu it opened itself (closed for the fight).
$.bossMenuOnly = function(id, mapId) {
    if ($.playerMapOf(id) !== mapId || $.isDown(id) || $.isDead(id)) return false;
    if (id === 'host') return $.menuCanClose() && !$.hostInJoin && !$.pvpBattle && !$.pendingDuel;
    var conn = $.clientById(id);
    return !!conn && !$.isBusy(conn) && (!!conn._menuBase || !!(conn.roamBusy && conn.roamMenu));
};

// only: these players (the night ambush's sleepers, FH_CoopRoam), else everyone there
$.bossPull = function(b, only, text) {
    var pulled = b.pulled = b.pulled || {};
    var ids = only || ['host'].concat($.activeGuests().map(function(c) { return c.guestId; }));
    ids.forEach(function(id) {
        if (id === b.owner || pulled[id] || b.joiners.indexOf(id) >= 0 || $.fightFull(b)) return;
        if ($.bossMenuOnly(id, b.mapId)) {
            var now = $.clockMs();
            b.menuToldAt = b.menuToldAt || {};
            if (now - (b.menuToldAt[id] || -Infinity) < $.MENU_CLOSE_AGAIN_MS) return;
            b.menuToldAt[id] = now;
            $.dlog('boss fight: the menu of', $.playerLabel(id), 'is closed');
            if (id === 'host') $.leaveMenuForDuel($.BOSS_MENU_TEXT);
            else $.sendTo(id, { t: 'duelMenuClose', text: $.BOSS_MENU_TEXT });
            return;
        }
        if (!$.bossJoinFree(id, b.mapId)) return;
        $.requestJoin(id, b.bid);
        if (b.joiners.indexOf(id) < 0) return; // (refused: tried again later)
        pulled[id] = true;
        $.dlog('boss fight: ' + $.playerLabel(id) + ' is put into', b.bid, 'troop', b.troopId);
        $.sendTo(id, { t: 'toast', text: text || $.BOSS_PULL_TEXT });
    });
};

$.bossPullTick = function() {
    if (!$.isHost() || !$.sessionActive()) return;
    var now = $.clockMs();
    if (now - $.bossPullAt < $.BOSS_PULL_MS) return;
    $.bossPullAt = now;
    Object.keys($.battles).forEach(function(k) {
        if ($.isBossRoomFight($.battles[k])) $.bossPull($.battles[k]);
    });
};

// Every scene of the host (its own battle too), not a world extra: in the
// background world the host's battle reads as no battle, and a join sent to
// itself then waited for a battle start that had passed.
var _sceneBaseUpdateBossPull = Scene_Base.prototype.update;
Scene_Base.prototype.update = function() {
    _sceneBaseUpdateBossPull.call(this);
    if ($.role && $.isHost()) $.bossPullTick();
};

//=============================================================================
// Guest: local battle must not be disturbed by the shared view
//=============================================================================

var _applyState = $.applyState;
$.applyState = function(msg) {
    if ($.localBattle || $.puppet) {
        if (msg && msg.pl) $.applyPlayers(msg.pl, msg.mapId);
        // what changed on the map meanwhile comes again once it is back
        // (FH_Coop "Resync": an enemy erased during the fight stood there)
        $.keepDroppedScr(msg, true);
        $.resyncAfterFight = true;
        return;
    }
    _applyState(msg);
};

$.resyncAfterFight = false;
$.guestExtras.push(function() {
    if (!$.resyncAfterFight || $.localBattle || $.puppet || $.pendingSnapshot) return;
    var scene = SceneManager._scene;
    if (!(scene instanceof Scene_Map) || !scene.isActive() || SceneManager.isSceneChanging()) return;
    $.resyncAfterFight = false;
    $.askResync('fight over');
});

var _applyMessage = $.applyMessage;
$.applyMessage = function(m) {
    if ($.localBattle || $.puppet) {
        $.deferredShared = m;
        return;
    }
    _applyMessage(m);
};

// Messages / choices inside the guest's own battle: normal input.
var _guestInput = Window_Message.prototype.updateFHCoopGuestInput;
Window_Message.prototype.updateFHCoopGuestInput = function() {
    if ($.localBattle || $.puppet) return $.baseUpdateInput.call(this);
    return _guestInput.call(this);
};

var _callOk = Window_ChoiceList.prototype.callOkHandler;
Window_ChoiceList.prototype.callOkHandler = function() {
    if ($.isGuest() && ($.localBattle || $.puppet)) {
        $gameMessage.onChoice(this.index());
        this._messageWindow.terminateMessage();
        this.close();
        return;
    }
    _callOk.call(this);
};

var _callCancel = Window_ChoiceList.prototype.callCancelHandler;
Window_ChoiceList.prototype.callCancelHandler = function() {
    if ($.isGuest() && ($.localBattle || $.puppet)) {
        $gameMessage.onChoice($gameMessage.choiceCancelType());
        this._messageWindow.terminateMessage();
        this.close();
        return;
    }
    _callCancel.call(this);
};

// Items used in the guest's own battle run their common events there.
var _reserveCommonEvent = Game_Temp.prototype.reserveCommonEvent;
Game_Temp.prototype.reserveCommonEvent = function(id) {
    if ($.isGuest() && $.localBattle) {
        this._commonEventId = id;
        return;
    }
    _reserveCommonEvent.call(this, id);
};

var _isThin = $.isThin;
$.isThin = function() {
    if ($.localBattle) return false;
    return _isThin();
};

// Leaving the session drops every battle and down state.
var _leaveAsGuest = $.leaveAsGuest;
$.leaveAsGuest = function(message) {
    $.localBattle = null;
    $.puppet = null;
    $.authBattle = null;
    $.pvpBattle = null;
    $.pendingDuel = null;
    $.myState = '';
    $.downUntil = {};
    _leaveAsGuest(message);
};

// The host's game is over (a game over, the title): this guest waits in the
// lobby with nothing of that game's fights and downs (0.41 play test: the
// title showed the old fight's "Marina was defeated" and "You are down:
// 0 s"). Its character goes too (FH_Coop 'lobby', $.resetPicks): the
// host's next game assigns it again from that save, or asks for a pick.
$.dropGuestGame = function() {
    $.localBattle = null;
    $.puppet = null;
    $.authBattle = null;
    $.pvpBattle = null;
    $.pendingDuel = null;
    $.roamFight = null;
    $.ownFightLost = false;
    $.ownerDownAfterBattle = false;
    $.myState = '';
    $.downUntil = {};
    $.downIds = {};
    $.deadIds = {};
};

var _onGuestMessageLobby = $.onGuestMessage;
$.onGuestMessage = function(conn, msg) {
    if (msg && msg.t === 'lobby' && $.isGuest()) {
        $.dlog('lobby: the host\'s game is over - its fights and downs are dropped');
        $.dropGuestGame();
    }
    return _onGuestMessageLobby(conn, msg);
};

// Not in a game (the title, a game over, a load screen): no fight opens
// here. A late message of the old world is dropped (0.41 play test: a fight
// opened over the title screen).
$.guestOffGame = function() {
    if (!$.isGuest()) return false;
    var scene = SceneManager._scene;
    return scene instanceof Scene_Title || scene instanceof Scene_Gameover || scene instanceof Scene_Load ||
        SceneManager.isNextScene(Scene_Title);
};

['battle', 'bView', 'pvp'].forEach(function(t) {
    var base = $.guestHandlers[t];
    $.guestHandlers[t] = function(msg) {
        if ($.guestOffGame()) {
            $.dlog('not in a game: battle message dropped', t, msg && msg.bid);
            return;
        }
        return base(msg);
    };
});

// After a snapshot (e.g. the host loaded a save) everyone's state is resent.
var _sendSnapshotStates = $.sendSnapshot;
$.sendSnapshot = function(conn) {
    _sendSnapshotStates(conn);
    var targets = conn ? $.snapshotTargets(conn) : $.clients;
    var ids = ['host'].concat($.clients.map(function(c) { return c.guestId; }));
    ids.forEach(function(id) {
        var msg = $.pstateMsg(id);
        targets.forEach(function(c) { c.send(msg); });
    });
};

//=============================================================================
// Items a joiner uses come out of the joiner's own bag
//=============================================================================

var _meetsItemConditions = Game_BattlerBase.prototype.meetsItemConditions;
Game_BattlerBase.prototype.meetsItemConditions = function(item) {
    if (this._fhJoiner) return this.meetsUsableItemConditions(item); // checked on the joiner's PC
    return _meetsItemConditions.call(this, item);
};

var _consumeItem = Game_Battler.prototype.consumeItem;
Game_Battler.prototype.consumeItem = function(item) {
    if (this._fhJoiner) {
        if (DataManager.isItem(item) && item.consumable) $.joinerUsedItem(this._fhJoiner, item.id);
        return;
    }
    _consumeItem.call(this, item);
};

$.joinerUsedItem = function(jid, itemId) {
    if ($.isHost()) $.hostHandlers.bConsume(null, { jid: jid, id: itemId });
    else if ($.conn) $.conn.send({ t: 'bConsume', jid: jid, id: itemId });
};

// Host keeps everyone's bags.
$.hostHandlers.bConsume = function(conn, msg) {
    var item = $dataItems[msg.id];
    if (!item) return;
    if (msg.jid === 'host') {
        $gameParty.loseItem(item, 1);
        return;
    }
    var c = $.clientById(msg.jid);
    if (!c) return;
    var inv = $.inventoryOf(c);
    var n = (inv.i[msg.id] || 0) - 1;
    if (n > 0) inv.i[msg.id] = n; else delete inv.i[msg.id];
    c.send({ t: 'bUsed', id: msg.id }); // the joiner's own list goes down too
};

$.guestHandlers.bUsed = function(msg) {
    var item = $dataItems[msg.id];
    if (item) $gameParty.loseItem(item, 1);
};

//=============================================================================
// Coin toss: the player it is about decides
//=============================================================================
// Troop pages ask "heads or tails" after an enemy grabs or stabs someone
// (guard break), after a bear trap and for the STEAL skill. Holding Shift
// with a coin (item 59) rolls twice and costs the coin. The page runs on the
// PC that runs the battle, so in a joined battle the choice, the Shift key
// and the coin come from the player whose character the last action was
// about: the actor that used it, or the actor an enemy used it on.

$.COIN_ITEM = 59;
$.COIN_HUD_CE = 262;       // coin count picture
$.COIN_PICTURES = [14, 15, 16, 17];
$.BCHOICE_MS = 30000;      // an answer that never comes: the default (real time, $.clockMs)
$.BDIALOG_MS = 120000;     // a talker's line nobody closes: the fight goes on (real time; see bDialogLate)
$.coinOwner = 0;            // authority: actor of the last action
$.coinCause = 0;            // authority: actor of the last action that sets a troop event off (below)
$.bChoiceWait = null;       // authority: { interp, id, jid, indent, cancel, until }
$.coinCtx = null;           // authority: { jid, coins, shift } until the page ends
$.nextBChoice = 1;

// Who tosses: the one the action that set the toss page off was about - an
// enemy's on its victim (the Neighbour's "preparing for a devastating
// attack", skill 589 -> CE4 SW16 -> troop 55 page 13), a player's own on that
// player. Those actions call a common event (skill effect 44) that turns on a
// coin page's switch ($.isTossCe). The last action of all (coinOwner) is the
// fallback (the bear trap's SW2876, STEAL's SW200 pages): a
// joiner's plain attack between the grab and the page took the toss from the
// one grabbed (0.38.3-pre5, Marina tossed for O'saa).
$.actionAbout = function(action, target) {
    var subject = action.subject();
    if (subject && subject.isActor()) return subject.actorId();
    return target && target.isActor() ? target.actorId() : 0;
};

// Only a common event that turns on a coin page's switch (data: CE4
// guard_break SW16). Any common event was too wide: the enemies' weapon
// skills call CE240 (dismemberment GFX), food and books theirs - a Hatchet on
// another player between the grab and the page took the toss again.
$.tossCes = null; // { common event id: true }
$.isTossCe = function(id) {
    if (!$.tossCes) {
        var sws = {}, ces = {};
        ($dataTroops || []).forEach(function(t) {
            (t && t.pages || []).forEach(function(pg) {
                var c = pg.conditions || {};
                if (c.switchValid && $.isCoinPage(pg.list)) sws[c.switchId] = true;
            });
        });
        ($dataCommonEvents || []).forEach(function(ce) {
            if (ce && (ce.list || []).some(function(cmd) {
                var p = cmd.parameters || [];
                if (cmd.code !== 121 || p[2] !== 0) return false;
                for (var s = p[0]; s <= p[1]; s++) if (sws[s]) return true;
                return false;
            })) ces[ce.id] = true;
        });
        $.tossCes = ces;
    }
    return !!$.tossCes[id];
};

$.setsEventOff = function(item) {
    return !!item && (item.effects || []).some(function(e) {
        return e.code === Game_Action.EFFECT_COMMON_EVENT && $.isTossCe(e.dataId);
    });
};

// A skill whose common event turns on a switch this troop has a page for:
// that page's text is the user's, as the Talk skill's (play test 2026-10-31:
// Marina's Run! - CE46, SW200, troop 212 page 6 - showed "The party tries to
// escape..." on the host's screen, not hers). Coin tosses keep theirs.
$.troopPageSws = null; // { troopId, sws: { switch id: true } }
$.callsTroopPage = function(item) {
    var troop = $gameTroop.troop();
    if (!troop || !item || $.setsEventOff(item)) return false;
    if (!$.troopPageSws || $.troopPageSws.troopId !== troop.id) {
        var sws = {};
        (troop.pages || []).forEach(function(pg) {
            var c = pg.conditions || {};
            if (c.switchValid) sws[c.switchId] = true;
        });
        $.troopPageSws = { troopId: troop.id, sws: sws };
    }
    var on = $.troopPageSws.sws;
    return (item.effects || []).some(function(e) {
        var ce = e.code === Game_Action.EFFECT_COMMON_EVENT && $dataCommonEvents[e.dataId];
        return !!ce && (ce.list || []).some(function(cmd) {
            var p = cmd.parameters || [];
            if (cmd.code !== 121 || p[2] !== 0) return false;
            for (var s = p[0]; s <= p[1]; s++) if (on[s]) return true;
            return false;
        });
    });
};

$.coinActor = function() {
    var members = $gameParty.battleMembers();
    var cause = $.coinCause ? $gameActors.actor($.coinCause) : null;
    if (cause && cause.isAlive() && members.indexOf(cause) >= 0) return cause;
    return $gameActors.actor($.coinOwner);
};

var _actionApply = Game_Action.prototype.apply;
Game_Action.prototype.apply = function(target) {
    if ($gameParty.inBattle()) {
        var subject = this.subject();
        if (subject && subject.isActor()) $.coinOwner = subject.actorId();
        else if (target && target.isActor()) $.coinOwner = target.actorId();
        var about = $.actionAbout(this, target);
        if (about && $.setsEventOff(this.item())) $.coinCause = about;
        var item = this.item();
        if (item && DataManager.isSkill(item) && subject && subject.isActor() &&
                (item.id === 11 || $.callsTroopPage(item))) {
            $.talkOwner = subject.actorId();
        } else if (!BattleManager._processingForcedAction) {
            $.talkOwner = 0;
        }
    }
    _actionApply.call(this, target);
};

$.isTroopInterp = function(interp) {
    for (var i = $gameTroop._interpreter; i; i = i._childInterpreter) {
        if (i === interp) return true;
    }
    return false;
};

// The joiner who decides this battle choice, or null (this PC decides).
$.battleChoiceOwner = function(interp) {
    var ab = $.authBattle;
    if (!$gameParty.inBattle() || $.puppet || !ab || !ab.joiners.length || ab.pvp) return null;
    if (!$.isTroopInterp(interp)) return null;
    var actor = $.coinActor();
    if (!actor || !actor._fhJoiner || !actor.isAlive() || $gameParty.battleMembers().indexOf(actor) < 0) return null;
    return actor._fhJoiner;
};

// The Talk skill runs battle dialogue from a troop page. Keep its owner
// through that page so its text and any choice can be shown to the right PC.
$.talkOwner = 0;
$.nextBDialog = 1;
$.bDialogWait = null;

$.battleStartTalkOwner = function() {
    if (!$.authBattle || $.authBattle.pvp || !$gameParty) return 0;
    var actor = $gameParty.battleMembers().filter(function(member) {
        return member.isLearnedSkill && member.isLearnedSkill(483);
    })[0];
    return actor ? actor.actorId() : 0;
};

$.battleTalkOwner = function(interp) {
    if (!$.authBattle || !$.authBattle.joiners.length || $.puppet ||
            !$gameParty.inBattle() || !$.isTroopInterp(interp)) return null;
    // troop talk with no talker: this PC answers, the joiners read along
    if (!$.talkOwner) return $.myPlayerId();
    var actor = $gameActors.actor($.talkOwner);
    if (!actor || !actor.isAlive() || $gameParty.battleMembers().indexOf(actor) < 0) return null;
    $.talkUsed = true;
    return actor._fhJoiner || $.myPlayerId();
};

$.choiceOptions = function(value) {
    if (Array.isArray(value)) return value.map(String);
    if (value && Array.isArray(value.value)) {
        return value.value.slice(0, Number(value.Count) || value.value.length).map(String);
    }
    return [];
};

$.battleDialogData = function(interp) {
    var list = interp._list || [];
    var index = interp._index;
    var p = interp._params || [];
    var data = {
        face: p[0] || '', faceIndex: Number(p[1]) || 0,
        background: Number(p[2]) || 0, position: Number(p[3]) || 2,
        text: [], choices: null, defaultChoice: 0, cancelChoice: -1,
        choicePosition: 2, choiceBackground: 0
    };
    while (list[index + 1] && list[index + 1].code === 401) {
        index++;
        data.text.push(String(list[index].parameters[0] || ''));
    }
    if (list[index + 1] && list[index + 1].code === 102) {
        var cp = list[index + 1].parameters;
        data.choices = $.choiceOptions(cp[0]);
        data.cancelChoice = Number(cp[1]);
        if (data.cancelChoice >= data.choices.length) data.cancelChoice = -2;
        data.defaultChoice = Number(cp[2]) || 0;
        data.choicePosition = cp.length > 3 ? Number(cp[3]) || 0 : 2;
        data.choiceBackground = cp.length > 4 ? Number(cp[4]) || 0 : 0;
    }
    return data;
};

$.battleDialogPacket = function(data, owner) {
    return {
        t: 'bDialog', bid: $.authBattle.bid, id: $.nextBDialog++, owner: owner,
        face: data.face, faceIndex: data.faceIndex, background: data.background,
        position: data.position, text: data.text, choices: data.choices,
        defaultChoice: data.defaultChoice, cancelChoice: data.cancelChoice,
        choicePosition: data.choicePosition, choiceBackground: data.choiceBackground
    };
};

$.broadcastBattleChoicePreview = function(owner, choices, cancel, defaultChoice, position, background, exclude) {
    var packet = $.battleDialogPacket({
        face: '', faceIndex: 0, background: 0, position: 2, text: [],
        choices: choices, cancelChoice: cancel, defaultChoice: defaultChoice,
        choicePosition: position, choiceBackground: background
    }, owner);
    $.battleParticipants().forEach(function(id) {
        if (id !== exclude) $.bSend(id, packet);
    });
    return packet;
};

var _command101BattleTalk = Game_Interpreter.prototype.command101;
Game_Interpreter.prototype.command101 = function() {
    var owner = $.battleTalkOwner(this);
    if (!owner || $gameMessage.isBusy()) return _command101BattleTalk.call(this);
    var data = $.battleDialogData(this);
    var packet = $.battleDialogPacket(data, owner);
    $.msgShared = false;
    if (owner === $.myPlayerId()) {
        $.battleBroadcast(packet);
        $.lastBDialog = packet;
        return _command101BattleTalk.call(this);
    }
    var list = this._list || [];
    var index = this._index;
    while (list[index + 1] && list[index + 1].code === 401) index++;
    if (list[index + 1] && list[index + 1].code === 102) index++;
    this._index = index + 1;
    $.bDialogWait = {
        interp: this, id: packet.id, jid: owner, indent: this._indent,
        cancel: data.cancelChoice, count: data.choices ? data.choices.length : 0,
        since: $.clockMs(), last: $.clockMs(), floor: $.clockMs(), seen: 0
    };
    this.setWaitMode('fhBDialog');
    $.battleBroadcast(packet);
    return false;
};

// A troop page with the coin HUD (CE262): a coin toss.
$.coinPageHere = function(interp) {
    return $gameParty.inBattle() && $.isTroopInterp(interp) && !!$gameTroop._interpreter &&
        $.isCoinPage($gameTroop._interpreter._list);
};

// Who reads a coin toss along (the joiners see it as text): this PC's view.
$.coinPreviewOwner = function(interp) {
    var ab = $.authBattle;
    if (!ab || !ab.joiners.length || $.puppet || !$gameParty.inBattle() || !$.isTroopInterp(interp)) return null;
    return $.myPlayerId();
};

var _command102Coin = Game_Interpreter.prototype.command102;
Game_Interpreter.prototype.command102 = function() {
    // a Talk choice is the talker's; a coin toss the one the action that set
    // it off was about ($.coinActor; a Talk's toss: the talker, its skill
    // calls CE14); other choices the one the last action was about
    var coin = $.coinPageHere(this);
    var talker = $.talkOwner && !coin ? $.battleTalkOwner(this) : null;
    var jid = talker ? (talker !== $.myPlayerId() ? talker : null) : $.battleChoiceOwner(this);
    var owner = coin ? $.coinPreviewOwner(this) : $.battleTalkOwner(this);
    var p = this._params;
    var choices = $.choiceOptions(p[0]);
    if (jid) return this.fhRemoteBattleChoice(jid, !!owner && !coin);
    // (once: the command waits here while a message is up)
    if (owner && !$gameMessage.isBusy()) {
        var preview = $.broadcastBattleChoicePreview(owner, choices, p[1], p[2], p[3], p[4], null);
        // This PC's player picks: the joiners' read-only copy closes with
        // the pick (terminateMessage). A separate choice (coin toss: text,
        // CE262, then 102) was never advanced: the copy stayed up and kept
        // that joiner's command window shut (0.4 review A4).
        if (owner === $.myPlayerId()) $.lastBDialog = preview;
    }
    return _command102Coin.call(this);
};

Game_Interpreter.prototype.fhRemoteBattleChoice = function(jid, talkChoice) {
    if ($gameMessage.isBusy()) return false;
    var p = this._params;
    var choices = $.choiceOptions(p[0]);
    var id = $.nextBChoice++;
    $.bChoiceWait = { interp: this, id: id, jid: jid, indent: this._indent, cancel: p[1], count: choices.length,
        until: $.clockMs() + $.BCHOICE_MS, dialogId: 0 };
    this._index++;
    this.setWaitMode('fhBChoice');
    $.bSend(jid, { t: 'bChoice', bid: $.authBattle.bid, id: id, ch: choices,
        ct: p[1], dt: p[2], cp: p[3], cb: p[4] });
    if (talkChoice) {
        var preview = $.broadcastBattleChoicePreview(jid, choices, p[1], p[2], p[3], p[4], jid);
        $.bChoiceWait.dialogId = preview.id;
    }
    var actor = $.coinActor();
    if (!talkChoice) $.battleGab((actor ? actor.name() : 'Someone') + ' decides...', true);
    $.dlog('battle choice for', jid, choices);
    return false;
};

var _updateWaitModeCoin = Game_Interpreter.prototype.updateWaitMode;
Game_Interpreter.prototype.updateWaitMode = function() {
    if (this._waitMode === 'fhBDialog') {
        var d = $.bDialogWait;
        if (d && d.interp === this) {
            var dialogActor = $.joinerActor(d.jid);
            if (!dialogActor || !dialogActor.isAlive()) {
                $.resolveBDialog(-1);
            } else if (d.since && $.bDialogLate(d)) {
                // the talker's PC does not show it (minimized, frozen) or
                // nobody answers: every gauge waits while this page runs
                $.dlog('battle talk: no answer from', d.jid, '(' + $.bDialogLate(d) + ') - goes on');
                $.battleBroadcast({ t: 'bDialogAdvance', id: d.id });
                $.resolveBDialog(-1);
                $.battleGab(dialogActor.name() + ' took too long to answer.');
            } else {
                return true;
            }
        }
        this._waitMode = '';
        return false;
    }
    if (this._waitMode === 'fhBChoice') {
        var w = $.bChoiceWait;
        if (w && w.interp === this) {
            var a = $.joinerActor(w.jid);
            if (!a || !a.isAlive() || $.clockMs() > w.until) {
                $.dropBChoice(w);
                $.resolveBChoice(-1, false, 0);
            } else {
                return true;
            }
        }
        this._waitMode = '';
        return false;
    }
    return _updateWaitModeCoin.call(this);
};

// A Talk line waits for its talker while its PC shows it (or has it queued:
// 'bDialogSeen' every PUPPET_BEAT_MS from its game loop). Given up when no
// such word came within BDIALOG_SEEN_MS, when it stopped for that long, or
// after BDIALOG_MS in all. Time this PC's own loop stood still does not count.
$.BDIALOG_SEEN_MS = 8000;
$.bDialogLate = function(d) {
    var now = $.clockMs();
    var gap = now - d.last;
    d.last = now;
    if (gap > 1000) {
        d.since += gap;
        d.floor = now;
    }
    if (now - d.since > $.BDIALOG_MS) return 'nothing in ' + $.BDIALOG_MS / 1000 + ' s';
    if (now - Math.max(d.seen || 0, d.floor) <= $.BDIALOG_SEEN_MS) return '';
    return d.seen ? 'its PC stopped showing it' : 'its PC never showed it';
};

$.guestHandlers.bDialogSeen = function(msg) {
    var d = $.bDialogWait;
    if (!d || d.cat || !$.authBattle || msg.bid !== $.authBattle.bid || d.id !== msg.id ||
            (msg.from || 'host') !== d.jid) return;
    d.seen = $.clockMs();
};

$.resolveBDialog = function(choice) {
    var d = $.bDialogWait;
    if (!d) return;
    $.bDialogWait = null;
    if (d.count) {
        var n = Number(choice);
        if (isNaN(n) || n < 0) {
            if (d.cancel === -2 || d.cancel >= d.count) n = -2;
            else n = d.cancel >= 0 ? d.cancel : 0;
        }
        d.interp._branch[d.indent] = n;
    }
    d.interp._waitMode = '';
};

$.guestHandlers.bDialogDone = function(msg) {
    var d = $.bDialogWait;
    if (!d || !$.authBattle || msg.bid !== $.authBattle.bid || d.id !== msg.id ||
            (msg.from || 'host') !== d.jid) return;
    $.battleBroadcast({ t: 'bDialogAdvance', id: d.id });
    $.resolveBDialog(msg.choice);
};

$.resolveBChoice = function(choice, shift, coins) {
    var w = $.bChoiceWait;
    if (!w) return;
    $.bChoiceWait = null;
    var n = Number(choice);
    if (isNaN(n) || n < 0) {
        if (w.cancel >= w.count) n = -2;           // the "When Cancel" branch
        else n = w.cancel >= 0 ? w.cancel : 0;
    }
    w.interp._branch[w.indent] = n;
    $.coinCtx = { jid: w.jid, coins: Math.max(0, Number(coins) || 0), shift: !!shift };
    w.interp._waitMode = '';
};

// No answer in time (or its player is gone): the others' read-only copy and
// that player's own list close too - either one left up kept a joiner's
// command window shut.
$.dropBChoice = function(w) {
    if (!$.authBattle) return;
    $.dlog('battle choice: no answer from', w.jid, '- default taken');
    if (w.dialogId) $.battleBroadcast({ t: 'bDialogAdvance', id: w.dialogId });
    $.bSend(w.jid, { t: 'bChoiceOff', bid: $.authBattle.bid, id: w.id });
};

$.guestHandlers.bChoiceDone = function(msg) {
    var w = $.bChoiceWait;
    if (!w || !$.authBattle || msg.bid !== $.authBattle.bid || w.id !== msg.id ||
            (msg.from || 'host') !== w.jid) return;
    if (w.dialogId) $.battleBroadcast({ t: 'bDialogAdvance', id: w.dialogId });
    $.resolveBChoice(msg.choice, msg.shift, msg.coins);
};

// The rest of the page: that player's Shift and coins.
var _command111Coin = Game_Interpreter.prototype.command111;
Game_Interpreter.prototype.command111 = function() {
    if ($.coinCtx && this._params[0] === 11 && this._params[1] === 'shift' &&
            $gameParty.inBattle() && $.isTroopInterp(this)) {
        this._branch[this._indent] = $.coinCtx.shift;
        if (!this._branch[this._indent]) this.skipBranch();
        return true;
    }
    return _command111Coin.call(this);
};

$.isCoin = function(item) {
    return !!item && DataManager.isItem(item) && item.id === $.COIN_ITEM;
};

var _numItemsCoin = Game_Party.prototype.numItems;
Game_Party.prototype.numItems = function(item) {
    if ($.coinCtx && this === $gameParty && $.isCoin(item)) return $.coinCtx.coins;
    return _numItemsCoin.call(this, item);
};

var _command126Coin = Game_Interpreter.prototype.command126;
Game_Interpreter.prototype.command126 = function() {
    var p = this._params;
    if ($.coinCtx && p[0] === $.COIN_ITEM && $gameParty.inBattle()) {
        var n = this.operateValue(p[1], p[2], p[3]);
        var ctx = $.coinCtx;
        if (n < 0) {
            for (var k = 0; k < -n && ctx.coins > 0; k++) {
                ctx.coins--;
                $.joinerUsedItem(ctx.jid, $.COIN_ITEM);
            }
        } else if (n > 0) {
            ctx.coins += n;
            $.joinerGainedItem(ctx.jid, $.COIN_ITEM, n);
        }
        return true;
    }
    return _command126Coin.call(this);
};

// kind: 'i' (default), 'w' or 'a'.
$.joinerGainedItem = function(jid, itemId, n, kind) {
    var msg = { jid: jid, id: itemId, n: n, k: kind || 'i' };
    if ($.isHost()) $.hostHandlers.bGain(null, msg);
    else if ($.conn) { msg.t = 'bGain'; $.conn.send(msg); }
};

$.itemOfKind = function(kind, id) {
    return (kind === 'w' ? $dataWeapons : kind === 'a' ? $dataArmors : $dataItems)[id] || null;
};

$.hostHandlers.bGain = function(conn, msg) {
    var kind = msg.k === 'w' || msg.k === 'a' ? msg.k : 'i';
    var item = $.itemOfKind(kind, msg.id);
    var n = Math.max(0, Number(msg.n) || 0);
    if (!item || !n) return;
    if (msg.jid === 'host') {
        $gameParty.gainItem(item, n);
        return;
    }
    var c = $.clientById(msg.jid);
    if (!c) return;
    var inv = $.inventoryOf(c);
    inv[kind][msg.id] = (inv[kind][msg.id] || 0) + n;
    c.send({ t: 'bGot', id: msg.id, n: n, k: kind });
};

$.guestHandlers.bGot = function(msg) {
    var item = $.itemOfKind(msg.k, msg.id);
    if (item) $gameParty.gainItem(item, msg.n || 1);
};

// A part's reward goes to the one who broke it (user 2026-10-26): a troop
// page "enemy N at 0 HP" that gives an item (Moonless troops 212/213 page 11:
// the Black Steel part -> weapon 37 Black steel). The PC running the battle
// keeps who hit each enemy last (a joiner's companion: its owner). The reward still lands in this PC's bag
// first (a lost fixed fight takes it back: FH_CoopRoam fxBattle); a won
// battle hands it over, with a line for everyone.
$.PART_REWARD_TEXT = '%1 sought out its rightful owner: %2.';
$.partRewards = [];

var _applyPartHit = Game_Action.prototype.apply;
Game_Action.prototype.apply = function(target) {
    var hp = target ? target.hp : 0;
    _applyPartHit.call(this, target);
    var subject = this.subject();
    if (target && target.isEnemy() && subject && subject.isActor() && target.hp < hp &&
            $gameParty.inBattle() && $.authBattle && !$.puppet) {
        // (a joiner's raised companion breaks it for its owner - user 2026-10-26)
        target._fhHitBy = subject._fhJoiner || subject._fhMinionOf || $.myPlayerId();
    }
};

var _setupBattleEventPart = Game_Troop.prototype.setupBattleEvent;
Game_Troop.prototype.setupBattleEvent = function() {
    var interp = this._interpreter;
    var was = interp.isRunning() ? interp._list : null;
    _setupBattleEventPart.call(this);
    if (!interp.isRunning() || interp._list === was) return;
    interp._fhPartBy = null;
    var list = interp._list, members = this.members();
    this.troop().pages.forEach(function(p) {
        var c = p.conditions;
        if (p.list === list && c.enemyValid && c.enemyHp === 0 && members[c.enemyIndex]) {
            interp._fhPartBy = members[c.enemyIndex]._fhHitBy || null;
        }
    });
};

$.notePartReward = function(interp, kind) {
    var p = interp._params;
    var by = interp._fhPartBy;
    if (!by || by === $.myPlayerId() || !$.authBattle || $.puppet || !$gameParty.inBattle()) return;
    var n = interp.operateValue(p[1], p[2], p[3]);
    if (n > 0) $.partRewards.push({ to: by, k: kind, id: p[0], n: n });
};

var _command126Part = Game_Interpreter.prototype.command126;
Game_Interpreter.prototype.command126 = function() {
    if ($.isTroopInterp(this)) $.notePartReward(this, 'i');
    return _command126Part.call(this);
};

var _command127Part = Game_Interpreter.prototype.command127;
Game_Interpreter.prototype.command127 = function() {
    if ($.isTroopInterp(this)) $.notePartReward(this, 'w');
    return _command127Part.call(this);
};

var _command128Part = Game_Interpreter.prototype.command128;
Game_Interpreter.prototype.command128 = function() {
    if ($.isTroopInterp(this)) $.notePartReward(this, 'a');
    return _command128Part.call(this);
};

// Won: to the breaker, if it is still in this fight (one who left keeps
// nothing on the way: the reward stays here).
$.givePartRewards = function() {
    var list = $.partRewards;
    $.partRewards = [];
    list.forEach(function(r) {
        var item = $.itemOfKind(r.k, r.id);
        if (!item || !$.joinerActor(r.to)) return;
        var n = Math.min(r.n, $gameParty.numItems(item));
        if (n <= 0) return;
        var quiet = $.fxQuiet;
        $.fxQuiet = true; // (not a change of a fixed fight's scene)
        try {
            $gameParty.loseItem(item, n);
        } finally {
            $.fxQuiet = quiet;
        }
        $.joinerGainedItem(r.to, r.id, n, r.k);
        $.dlog('part reward:', item.name, 'x' + n, 'to', $.playerLabel(r.to), '(it broke the part)');
        $.battleGab($.PART_REWARD_TEXT.replace('%1', item.name).replace('%2', $.playerLabel(r.to)));
    });
};

var _bmSetupPart = BattleManager.setup;
BattleManager.setup = function(troopId, canEscape, canLose) {
    $.partRewards = [];
    _bmSetupPart.call(this, troopId, canEscape, canLose);
};

var _endBattlePart = BattleManager.endBattle;
BattleManager.endBattle = function(result) {
    if (result === 0 && $.partRewards.length && $.authBattle && !$.puppet) $.givePartRewards();
    else $.partRewards = [];
    _endBattlePart.call(this, result);
};

var _terminateCoin = Game_Interpreter.prototype.terminate;
Game_Interpreter.prototype.terminate = function() {
    _terminateCoin.call(this);
    if (this === $gameTroop._interpreter) {
        $.coinCtx = null;
        // the talker stays through pages that ran before its talk page
        // (a round end right after the Talk skill)
        if ($.talkUsed) $.talkOwner = 0;
        $.talkUsed = false;
        $.bDialogWait = null;
        if (this._fhToss) $.coinCause = 0; // that toss is over
    }
};

var _endBattleCoin = BattleManager.endBattle;
BattleManager.endBattle = function(result) {
    $.coinCtx = null;
    $.bChoiceWait = null;
    $.bDialogWait = null;
    $.talkOwner = 0;
    $.talkUsed = false;
    $.coinOwner = 0;
    $.coinCause = 0;
    _endBattleCoin.call(this, result);
};

// Joiner: the choice on its own screen, with its own coin count.
$.guestHandlers.bChoice = function(msg) {
    if (!$.puppet || msg.bid !== $.puppet.bid) return;
    $.puppet.choice = msg;
};

$.guestHandlers.bDialog = function(msg) {
    if (!$.puppet || msg.bid !== $.puppet.bid) return;
    if (!$.puppet.dialogQueue) $.puppet.dialogQueue = [];
    if ($.puppet.dialogAdvances && $.puppet.dialogAdvances[msg.id]) return;
    $.puppet.dialogQueue.push(msg);
};

// The battle's own PC closed a dialogue the joiners read along: close theirs.
var _terminateMessage_bDialog = Window_Message.prototype.terminateMessage;
Window_Message.prototype.terminateMessage = function() {
    _terminateMessage_bDialog.call(this);
    var d = $.lastBDialog;
    if (d && !$.puppet && $.authBattle && d.bid === $.authBattle.bid) $.battleBroadcast({ t: 'bDialogAdvance', id: d.id });
    $.lastBDialog = null;
};

$.guestHandlers.bDialogAdvance = function(msg) {
    var puppet = $.puppet;
    if (!puppet || msg.bid !== puppet.bid) return;
    // The Talk user's acknowledgement closes this read-only copy for everyone.
    if (!puppet.dialogAdvances) puppet.dialogAdvances = {};
    puppet.dialogAdvances[msg.id] = true;
    puppet.dialogQueue = (puppet.dialogQueue || []).filter(function(dialog) {
        return dialog.id !== msg.id;
    });
    if (!puppet.dialog || puppet.dialog.id !== msg.id) return;
    $.closePuppetMessage();
    puppet.dialog = null;
};

// The message on a joined fight's screen closes (a list on it too: an
// active choice list would keep the message window waiting).
$.closePuppetMessage = function() {
    var scene = SceneManager._scene;
    var window = scene instanceof Scene_Battle ? scene._messageWindow : null;
    if (window && window.terminateMessage) {
        var list = window._choiceWindow;
        if (list && list.active) {
            list.deactivate();
            list.close();
        }
        window.terminateMessage();
    } else {
        $gameMessage.clear();
    }
};

// The fight's PC took the default for this player's choice (no answer in time).
$.guestHandlers.bChoiceOff = function(msg) {
    var p = $.puppet;
    if (!p || msg.bid !== p.bid) return;
    if (p.choice && p.choice.id === msg.id) {
        p.choice = null;
        return;
    }
    if (p.choiceUp !== msg.id) return;
    p.choiceUp = 0;
    $.COIN_PICTURES.forEach(function(id) { $gameScreen.erasePicture(id); });
    $.closePuppetMessage();
    $.dlog('joiner (fight ' + p.bid + '): its choice closed - the fight\'s PC took the default');
};

$.showPuppetBattleDialog = function(msg) {
    var interactive = msg.owner === $.myPlayerId();
    var text = (msg.text || []).slice();
    var choices = $.choiceOptions(msg.choices);
    if (!interactive && choices.length) {
        choices.forEach(function(choice, i) { text.push((i + 1) + '. ' + choice); });
    }
    var dialog = { id: msg.id, interactive: interactive, sent: false, shown: true };
    $.puppet.dialog = dialog;
    $gameMessage.setFaceImage(msg.face || '', Number(msg.faceIndex) || 0);
    $gameMessage.setBackground(Number(msg.background) || 0);
    $gameMessage.setPositionType(msg.position === undefined ? 2 : msg.position);
    text.forEach(function(line) { $gameMessage.add(String(line)); });
    if (interactive && choices.length) {
        var cancel = Number(msg.cancelChoice);
        if (cancel >= choices.length) cancel = -2;
        $gameMessage.setChoices(choices, Number(msg.defaultChoice) || 0, isNaN(cancel) ? -1 : cancel);
        $gameMessage.setChoiceBackground(Number(msg.choiceBackground) || 0);
        $gameMessage.setChoicePositionType(Number(msg.choicePosition) || 0);
        $gameMessage.setChoiceCallback(function(n) {
            if (dialog.sent) return;
            dialog.sent = true;
            $.bSend($.puppet.owner, { t: 'bDialogDone', bid: $.puppet.bid, id: dialog.id, choice: n });
        });
    }
};

// The coin toss (or a dialogue) a joined fight gives this player, on screen.
$.pumpPuppetMessages = function() {
    var pc = $.puppet && $.puppet.choice;
    if (pc && !$gameMessage.isBusy()) {
        $.puppet.choice = null;
        $.showBattleChoice(pc);
    }
    var puppet = $.puppet;
    if (puppet && !puppet.dialog && !puppet.choice && puppet.dialogQueue &&
            puppet.dialogQueue.length && !$gameMessage.isBusy()) {
        $.showPuppetBattleDialog(puppet.dialogQueue.shift());
    }
};

var _updatePuppetCoin = $.updatePuppet;
$.updatePuppet = function() {
    $.pumpPuppetMessages();
    var puppet = $.puppet;
    if (puppet && puppet.dialog && puppet.dialog.shown && !$gameMessage.isBusy()) {
        var dialog = puppet.dialog;
        if (dialog.interactive && !dialog.sent) {
            dialog.sent = true;
            $.bSend(puppet.owner, { t: 'bDialogDone', bid: puppet.bid, id: dialog.id, choice: -1 });
        }
        puppet.dialog = null;
    }
    if ($.puppet) _updatePuppetCoin();
};

$.showBattleChoice = function(msg) {
    var hud = $dataCommonEvents[$.COIN_HUD_CE];
    if (hud && msg.ch.length === 2) {
        var interp = new Game_Interpreter();
        interp.setup(hud.list);
        for (var k = 0; k < 30 && interp.isRunning(); k++) interp.update();
    }
    var owner = $.puppet.owner;
    var puppet = $.puppet;
    puppet.choiceUp = msg.id;
    var cancel = msg.ct >= msg.ch.length ? -2 : msg.ct;
    $gameMessage.setChoices(msg.ch, msg.dt >= msg.ch.length ? -1 : (msg.dt || 0), cancel);
    $gameMessage.setChoiceBackground(msg.cb || 0);
    $gameMessage.setChoicePositionType(msg.cp === undefined ? 2 : msg.cp);
    $gameMessage.setChoiceCallback(function(n) {
        if (puppet.choiceUp === msg.id) puppet.choiceUp = 0;
        $.COIN_PICTURES.forEach(function(id) { $gameScreen.erasePicture(id); });
        $.bSend(owner, {
            t: 'bChoiceDone', bid: msg.bid, id: msg.id, choice: n,
            shift: Input.isPressed('shift'), coins: $gameParty.numItems($dataItems[$.COIN_ITEM])
        });
    });
};

// A joiner's own command window can be open when its coin toss comes (its
// turn came up while the fight's PC ran the toss page). Scene_Battle updates
// BattleManager - and so this queue - only while no input window is active:
// the toss waited behind the command window and the fight's PC gave up on it
// after 30 s (0.38.3-pre5: HEADS / TAILS on neither screen, the toss lost).
// Now the command windows close for it; the turn's window opens again after
// it (the phase stays 'input': changeInputWindow brings it back).
$.puppetAnswerWaits = function() {
    var p = $.puppet;
    if (!p || $gameMessage.isBusy()) return false;
    if (p.choice) return true;
    var next = !p.dialog && p.dialogQueue && p.dialogQueue[0];
    return !!next && next.owner === $.myPlayerId(); // (its own Talk: not a read-along)
};

$.holdPuppetInput = function(scene) {
    // (commandequip's Equip screen and OctoBattle's extra skills too: they
    // count in isAnyInputWindowActive)
    [scene._skillWindow, scene._itemWindow, scene._actorWindow, scene._enemyWindow, scene._extraSkillWindow,
        scene._equipCommandWindow, scene._slotWindow, scene._equipItemWindow]
        .forEach(function(w) {
            if (!w) return;
            if (w.deactivate) w.deactivate();
            if (w.hide) w.hide();
        });
    if (scene._helpWindow && scene._helpWindow.hide) scene._helpWindow.hide();
    if (scene._partyCommandWindow && scene._partyCommandWindow.deactivate) scene._partyCommandWindow.deactivate();
    if (scene._actorCommandWindow && scene._actorCommandWindow.deactivate) scene._actorCommandWindow.deactivate();
    if (scene.endCommandSelection) scene.endCommandSelection();
};

$.puppetAnswerOverInput = function(scene) {
    if (!$.puppetAnswerWaits() || !scene.isAnyInputWindowActive || !scene.isAnyInputWindowActive()) return false;
    $.holdPuppetInput(scene);
    $.pumpPuppetMessages(); // (now: the message makes the scene busy, nothing reopens the window this frame)
    $.dlog('joiner (fight ' + $.puppet.bid + '): command window closed for its', $.puppet.dialog ? 'dialogue' : 'coin toss');
    return true;
};

var _sceneBattleUpdatePuppetAnswer = Scene_Battle.prototype.update;
Scene_Battle.prototype.update = function() {
    if ($.puppet) $.puppetAnswerOverInput(this);
    _sceneBattleUpdatePuppetAnswer.call(this);
};

//=============================================================================
// Running away from a joined fight: only the one who runs leaves
//=============================================================================
// Running is the Run! skill (CE46 turns SW215 on, the troop page aborts the
// battle when the roll works) or the party Escape command. A joiner who runs
// leaves the way the Escape command lets it. When the player whose PC runs
// the battle runs while others still fight, the battle moves to the PC of
// one of them: at the next quiet moment (no action, troop event or message)
// this PC sends the troop, the party, the gauges and the switches; the host
// points its record and the waiting map event at the new owner, and the new
// owner's battle view becomes the real battle. The map event's outcome (and
// its rewards) then go to the new owner. Not for duels and for fights on a
// map a guest runs: those still end for everyone.

$.RUN_SKILL = 40;
$.RUN_SWITCH = 215;
$.HANDOFF_ASK_MS = 5000; // the host's answer (real time, $.clockMs)
$.OWNER_MSGS = { bAction: 1, bLeave: 1, bChoiceDone: 1, bDialogDone: 1 }; // joiner -> battle owner
$.runBy = 0;      // authority: actor that used Run! last
$.abortBy = 0;    // authority: actor whose run ends the battle (read in processAbort)
$.handoff = null; // old authority: { bid, own, cand, to, askedAt } until it is sent
$.handedOff = {}; // old authority: bid -> new owner, for late messages

var _startActionRun = BattleManager.startAction;
BattleManager.startAction = function() {
    var subject = this._subject;
    var action = subject && subject.currentAction();
    var item = action && action.item();
    if (subject && subject.isActor() && item && DataManager.isSkill(item) && item.id === $.RUN_SKILL) {
        $.runBy = subject.actorId();
    }
    _startActionRun.call(this);
};

// Abort Battle inside the troop page's "if SW215 is ON" block.
$.inRunBranch = function(interp) {
    var list = interp._list || [];
    var cmd = list[interp._index];
    var indent = cmd ? cmd.indent : interp._indent;
    for (var i = interp._index - 1; i >= 0 && indent > 0; i--) {
        var c = list[i];
        if (!c || c.indent >= indent) continue;
        indent = c.indent;
        var p = c.parameters;
        if (c.code === 111 && p[0] === 0 && p[1] === $.RUN_SWITCH && p[2] === 0) return true;
    }
    return false;
};

var _command340Run = Game_Interpreter.prototype.command340;
Game_Interpreter.prototype.command340 = function() {
    if ($gameParty.inBattle() && $.authBattle && !$.puppet && $.runBy &&
            $.isTroopInterp(this) && $.inRunBranch(this)) {
        $.abortBy = $.runBy;
    }
    return _command340Run.call(this);
};

$.ownBattleActorId = function() {
    return $.isHost() ? $.hostActorId() : $.myActorId;
};

var _processEscapeRun = BattleManager.processEscape;
BattleManager.processEscape = function() {
    $.abortBy = !$.puppet && $.authBattle && $gameParty.inBattle() ? $.ownBattleActorId() : 0;
    try {
        return _processEscapeRun.call(this);
    } finally {
        $.abortBy = 0;
    }
};

var _processAbortRun = BattleManager.processAbort;
BattleManager.processAbort = function() {
    var by = $.abortBy;
    $.abortBy = 0;
    if (by === $.runBy) $.runBy = 0;
    if (by && $.onRunAway(by)) return;
    _processAbortRun.call(this);
};

// true: the battle goes on (without the one who ran)
$.onRunAway = function(actorId) {
    var ab = $.authBattle;
    if (!ab || ab.pvp || $.puppet || !$gameParty.inBattle() || !ab.joiners.length) return false;
    var actor = $gameActors.actor(actorId);
    var members = $gameParty.battleMembers();
    if (!actor || members.indexOf(actor) < 0) return false;
    // nobody stays to fight: everyone gets away, as before (the blood golem
    // leaves with its summoner, FH_CoopRoam)
    if (!members.some(function(a) { return a !== actor && a.isAlive() && a.actorId() !== $.GOLEM_ACTOR; })) return false;
    if (actor._fhJoiner) {
        $.dlog('joiner ran', actor._fhJoiner);
        $.guestHandlers.bLeave({ t: 'bLeave', bid: ab.bid, from: actor._fhJoiner });
        $.resumeAfterRun(actor);
        return true;
    }
    if (!$.canHandOff()) return false;
    var cand = ab.joiners.filter(function(id) {
        var a = $.joinerActor(id);
        return a && a.isAlive();
    });
    var to = null;
    if ($.isHost()) {
        to = $.pickReceiver($.battles[ab.bid], cand);
        if (!to) return false;
    }
    $.startHandoff(actor, cand, to);
    return true;
};

$.canHandOff = function() {
    var ab = $.authBattle;
    if ($.isHost()) {
        var b = $.battles[ab.bid];
        return ab.owner === 'host' && !!b && b.owner === 'host' && !b.pvp && !b.ownWorld;
    }
    return !!$.localBattle && !$.localBattle.pvp && ab.owner === $.myId && !$.roamFight && !!$.conn;
};

// The one who ran is no longer in the party: it neither acts nor ends a turn.
$.resumeAfterRun = function(actor) {
    var bm = BattleManager;
    bm._escaped = false;
    if (bm._subject === actor) bm._subject = null;
    if (bm._atbActing === actor) bm._atbActing = null;
    if (bm._phase === 'aborting' || bm._phase === 'input') {
        bm._phase = bm._subject || bm._atbActing ? 'turn' : 'atb';
    }
    $.refreshBattleStatus();
};

// Command, list and target windows closed (the turn is not this PC's now).
$.closeBattleInput = function() {
    var scene = SceneManager._scene;
    if (!(scene instanceof Scene_Battle)) return;
    [scene._skillWindow, scene._itemWindow, scene._actorWindow, scene._enemyWindow,
        scene._extraSkillWindow].forEach(function(w) {
        if (w) {
            w.deactivate();
            w.hide();
        }
    });
    if (scene._helpWindow) scene._helpWindow.hide();
    if (scene._partyCommandWindow) scene._partyCommandWindow.deactivate();
    if (scene._actorCommandWindow) scene._actorCommandWindow.deactivate();
    scene.endCommandSelection();
    $gameParty.select(null);
    $gameTroop.select(null);
};

// Old authority: its own character is out; the others fight on here until
// the battle can be sent.
$.startHandoff = function(actor, cand, to) {
    var ab = $.authBattle;
    var bm = BattleManager;
    $.battleGab(actor.name() + ' fled from the battle.');
    if (bm.actor() === actor) bm.changeActor(-1, 'waiting');
    if (bm._atbInputActor === actor) bm._atbInputActor = null;
    if (bm._atbActing === actor) bm._atbActing = null;
    if (bm._atbSuspended === actor) bm._atbSuspended = null;
    if (bm._subject === actor) bm._subject = null;
    bm._atbInputMemory = null;
    actor.clearActions();
    $gameParty._actors = $gameParty._actors.filter(function(id) { return id !== actor.actorId(); });
    $.closeBattleInput();
    $.resumeAfterRun(actor);
    $.handoff = { bid: ab.bid, own: actor.actorId(), cand: cand, to: to || null, askedAt: $.clockMs() };
    $.broadcastParty();
    if (!to) $.conn.send({ t: 'bHandoffAsk', bid: ab.bid, cand: cand });
    $.dlog('owner ran, battle', ab.bid, 'goes to', to || cand.join(','));
};

$.handoffSafe = function() {
    var bm = BattleManager;
    return bm._phase === 'atb' && !bm._subject && !bm._atbActing && !bm._processingForcedAction &&
        !bm.isActionForced() && !bm.isBusy() && !$gameTroop.isEventRunning() && !$gameMessage.isBusy() &&
        !$gameTemp.isCommonEventReserved() && !$.bChoiceWait && !$.bDialogWait;
};

var _updateHandoff = BattleManager.update;
BattleManager.update = function() {
    var h = $.handoff;
    if (h && !$.puppet) {
        if (!h.to && $.clockMs() - h.askedAt > $.HANDOFF_ASK_MS) {
            $.cancelHandoff('no answer');
        } else if (h.to && $.handoffSafe()) {
            $.sendHandoff();
            return;
        }
    }
    _updateHandoff.call(this);
};

// The host said no (or nothing): everyone gets away, as before.
$.cancelHandoff = function(why) {
    var h = $.handoff;
    $.handoff = null;
    if (!h) return;
    $.dlog('battle hand-over off:', why);
    if ($gameParty._actors.indexOf(h.own) < 0) $gameParty._actors.unshift(h.own);
    if ($gameParty.inBattle() && $.authBattle && $.authBattle.bid === h.bid) BattleManager.abort();
};

// The battle ended here before it could be sent (won, or all the others fell).
var _endBattleHandoff = BattleManager.endBattle;
BattleManager.endBattle = function(result) {
    var h = $.handoff;
    $.handoff = null;
    if (h && $gameParty._actors.indexOf(h.own) < 0) $gameParty._actors.unshift(h.own);
    _endBattleHandoff.call(this, result);
    $.runBy = 0;
    $.abortBy = 0;
};

$.sendHandoff = function() {
    var h = $.handoff;
    var ab = $.authBattle;
    var lb = $.localBattle;
    var bm = BattleManager;
    var sw = $gameSwitches._data, v = $gameVariables._data, ss = $gameSelfSwitches._data;
    var msg = {
        t: 'bHandoff', bid: h.bid, to: h.to, cand: h.cand, troopId: ab.troopId,
        troop: JsonEx.stringify($gameTroop),
        actors: $gameParty.battleMembers().map(function(a) {
            return { id: a.actorId(), json: $.actorJson(a), j: a._fhJoiner || '', aw: !!a._fhAwait, rd: !!a._fhRemoteReady };
        }),
        bm: {
            ce: !!bm._canEscape, cl: !!bm._canLose, er: bm._escapeRatio, tick: bm._atbRoundTick,
            pend: !!bm._atbRoundPending, avg: bm._atbAvgAgi, foe: bm._atbFoeAvgAgi, one: !!bm._atbOneTurn,
            sur: !!bm._atbSurprisePending
        },
        dmg: $.dmgTable,
        sw: sw.slice(), v: v.slice(), ss: Object.assign({}, ss),
        sw0: (lb ? lb.sw0 : sw).slice(), v0: (lb ? lb.v0 : v).slice(), ss0: Object.assign({}, lb ? lb.ss0 : ss)
    };
    var interp = ab.interp;
    if ($.isGuest()) {
        msg.actor = $.actorJson($gameActors.actor(h.own));
        msg.inv = { i: $gameParty._items, w: $gameParty._weapons, a: $gameParty._armors, g: $gameParty._gold };
    } else if (interp) {
        // the host's event waits for the new owner's result
        interp._fhBattleWait = h.bid;
        interp.setWaitMode('fhBattle');
    }
    $.leaveHandedBattle(h);
    if ($.isHost()) $.hostHandoff('host', msg, interp); else $.conn.send(msg);
};

// Back to the map, as after a successful escape, without telling the joiners
// the battle is over.
$.leaveHandedBattle = function(h) {
    var bm = BattleManager;
    $.handedOff[h.bid] = h.to;
    $.authBattle = null;
    $.localBattle = null;
    $.dmgTable = {};
    var keep = [];
    $gameParty._actors.forEach(function(id) {
        var a = $gameActors.actor(id);
        if (a && a._fhJoiner) {
            a.onBattleEnd();
            $.stripJoinFlags(a);
        } else {
            keep.push(id);
        }
    });
    if (keep.indexOf(h.own) < 0) keep.unshift(h.own);
    $gameParty._actors = keep;
    bm._eventCallback = null;
    bm._escaped = true;
    bm.replayBgmAndBgs();
    bm.endBattle(1);
};

// Late messages from joiners that still think this PC runs the battle.
Object.keys($.OWNER_MSGS).forEach(function(t) {
    var base = $.guestHandlers[t];
    $.guestHandlers[t] = function(msg) {
        var to = $.handedOff[msg.bid];
        if (to && !($.authBattle && $.authBattle.bid === msg.bid)) {
            $.forwardBattleMsg(to, msg);
            return;
        }
        base(msg);
    };
});

$.forwardBattleMsg = function(to, msg) {
    var copy = Object.assign({}, msg);
    var from = copy.from || 'host';
    delete copy.from;
    if ($.isHost()) {
        copy.from = from;
        $.sendTo(to, copy);
    } else if ($.conn) {
        copy.fwd = from;
        $.conn.send({ t: 'bRelay', to: to, m: copy });
    }
};

// Host: joiner messages for the one who ran go to the new owner; messages
// it passes on keep who sent them.
var _bRelayHandoff = $.hostHandlers.bRelay;
$.hostHandlers.bRelay = function(conn, msg) {
    var m = msg && msg.m;
    var b = m && $.battles[m.bid];
    var fwd = m && m.fwd;
    if (m) delete m.fwd;
    var ran = function(id) { return !!b && !!b.prevOwners && b.prevOwners.indexOf(id) >= 0; };
    if (m && $.OWNER_MSGS[m.t] && ran(msg.to) && b.joiners.indexOf(msg.to) < 0) msg.to = b.owner;
    if (fwd && ran(conn.guestId) && $.OWNER_MSGS[m.t]) {
        m.from = fwd;
        $.sendTo(msg.to, m);
        return;
    }
    _bRelayHandoff(conn, msg);
};

// Host: one who just ran does not walk straight back in (OK pressed again
// on the frozen enemy or the player now running the fight).
$.REJOIN_MS = 5000; // (real time, $.clockMs)
$.ranAt = {}; // 'player:bid' -> ms

$.markRan = function(id, bid) {
    $.ranAt[id + ':' + bid] = $.clockMs();
};

var _requestJoinRan = $.requestJoin;
$.requestJoin = function(id, bid) {
    var at = $.ranAt[id + ':' + bid];
    if (at !== undefined && $.clockMs() - at < $.REJOIN_MS) return;
    _requestJoinRan(id, bid);
};

var _bLeftRan = $.hostHandlers.bLeft;
$.hostHandlers.bLeft = function(conn, msg) {
    $.markRan(msg.jid, msg.bid);
    _bLeftRan(conn, msg);
};

var _bLeaveRan = $.guestHandlers.bLeave;
$.guestHandlers.bLeave = function(msg) {
    if ($.isHost() && $.authBattle && $.authBattle.bid === msg.bid) $.markRan(msg.from || 'host', msg.bid);
    _bLeaveRan(msg);
};

$.pickReceiver = function(b, list) {
    if (!b) return null;
    for (var i = 0; i < list.length; i++) {
        var id = list[i];
        if (!id || b.joiners.indexOf(id) < 0) continue;
        if (id === 'host') return id;
        // not a player running its own world (tutorial, own map, a sub-host's guest)
        var c = $.clientById(id);
        if (c && !c.solo && !c.roam && !c.subOf) return id;
    }
    return null;
};

$.hostHandlers.bHandoffAsk = function(conn, msg) {
    var b = $.battles[msg.bid];
    // not a fight in its owner's own world (a map a guest runs, the tutorial)
    var to = b && b.owner === conn.guestId && !b.pvp && !b.ownWorld ? $.pickReceiver(b, msg.cand || []) : null;
    conn.send(to ? { t: 'bHandoffOk', bid: msg.bid, to: to } : { t: 'bHandoffNo', bid: msg.bid });
};

$.guestHandlers.bHandoffOk = function(msg) {
    var h = $.handoff;
    if (h && h.bid === msg.bid && !h.to) h.to = msg.to;
};

$.guestHandlers.bHandoffNo = function(msg) {
    var h = $.handoff;
    if (h && h.bid === msg.bid) $.cancelHandoff('refused');
};

$.hostHandlers.bHandoff = function(conn, msg) {
    $.hostHandoff(conn.guestId, msg, null);
};

$.hostHandoff = function(fromId, msg, hostInterp) {
    var b = $.battles[msg.bid];
    if (!b || b.owner !== fromId) return;
    $.markRan(fromId, b.bid);
    var fromConn = fromId === 'host' ? null : $.clientById(fromId);
    if (fromConn) {
        fromConn.inBattle = 0;
        $.hostHandlers.syncMe(fromConn, { actorId: fromConn.actorId, actor: msg.actor, inv: msg.inv });
    }
    if (fromId === 'host') b.interp = hostInterp;
    var to = $.pickReceiver(b, [msg.to].concat(msg.cand || []));
    if (!to) {
        $.failHandoff(b, msg);
        return;
    }
    b.prevOwners = (b.prevOwners || []).concat([fromId]);
    b.owner = to;
    b.joiners = b.joiners.filter(function(id) { return id !== to && id !== fromId; });
    var toConn = to === 'host' ? null : $.clientById(to);
    if (toConn) toConn.inBattle = b.bid; else $.hostInJoin = 0;
    $.moveBattleInterp(b, fromId, to);
    b.joiners.forEach(function(id) { $.sendTo(id, { t: 'bOwner', bid: b.bid, owner: to }); });
    $.dlog('battle', b.bid, 'moved', $.playerLabel(fromId), '->', $.playerLabel(to));
    $.sendTo(to, Object.assign({}, msg, { t: 'bTakeOver', from: fromId }));
};

// Nobody left to take it: everyone gets away, as before.
$.failHandoff = function(b, msg) {
    $.dlog('battle hand-over failed', b.bid);
    delete $.battles[b.bid];
    $.unfreezeBattle(b);
    if (msg.sw && msg.sw0) {
        $.applyBattleDelta($.diffArray(msg.sw, msg.sw0), $.diffArray(msg.v, msg.v0), $.diffObject(msg.ss, msg.ss0));
    }
    $.applyJoinerResults(b, (msg.actors || []).filter(function(e) { return !!e.j; }).map(function(e) {
        return { id: e.j, actor: e.json };
    }));
    b.joiners.forEach(function(id) { $.bSend(id, { t: 'bEnd', bid: b.bid, r: 1 }); });
    if (b.interp) {
        b.interp._branch[b.interp._indent] = 1;
        b.interp._fhBattleWait = 0;
    }
};

// Host: the fleeing player's switch and variable changes (as battleEnd).
// A battle's own variables (moonless review M1, 2026-11-02): the ones every
// battle sets again when it starts - a troop's turn 0 page or CE502
// FIRST_ATTACKS (V19 battleturns, V2713, V65 Attack_RANDOM, the phobias
// V1328-1333, V2060 moonless_random...). They mean something only inside the
// battle that set them, but went through the world sync, also during
// battles: another PC's battle start or turn end changed this PC's V19 mid
// fight, and troop 212's Moonless beast replayed or skipped its appearance
// stages (V19 1 / 2 / 3 at its turn ends). A PC in a battle neither sends
// nor takes them (FH_CoopRoam), a battle's end does not hand them over.
$.FIRST_ATTACKS_CE = 502;
// Not the ones a map sets for the battle to take (its turn 0 page reads them
// and sets them back to 0): V1197 necessary_fight (Map020/039/042/054 ->
// troop 104 Caligura), V2732 villager_rage (CE579 -> the villagers). Kept out,
// the 0 stayed on the PC that fought and the world kept 1 (review 2026-11-03).
$.BATTLE_VAR_WORLD = { 1197: true, 2732: true };
$.battleVarSet = null;
$.battleVar = function(id) {
    if (!$.battleVarSet) {
        if (!$dataTroops || !$dataCommonEvents) return false;
        var set = {};
        var note = function(list) {
            (list || []).forEach(function(cmd) {
                if (cmd.code === 122) for (var v = cmd.parameters[0]; v <= cmd.parameters[1]; v++) set[v] = true;
            });
        };
        $dataTroops.forEach(function(troop) {
            if (troop) troop.pages.forEach(function(page) {
                var c = page.conditions;
                if (c.turnValid && c.turnA === 0 && c.turnB === 0) note(page.list);
            });
        });
        var ce = $dataCommonEvents[$.FIRST_ATTACKS_CE];
        if (ce) note(ce.list);
        Object.keys($.BATTLE_VAR_WORLD).forEach(function(id) { delete set[id]; });
        $.battleVarSet = set;
    }
    return !!$.battleVarSet[Number(id)];
};

// keepBattleVars: the host takes over the fight itself (its own values go on)
$.applyBattleDelta = function(swd, vd, ssd, keepBattleVars) {
    if (!keepBattleVars) vd = vd.filter(function(d) { return !$.battleVar(d[0]); });
    var skip = {};
    // (and each player's own "a scene runs" / ladder flags: CE500 turns the
    // owner's SW202 / SW410 on before a lost fight's game over; the host's own
    // then stopped its run key and its needs)
    $.SELECT_SWITCHES.concat([10, 11, 12, 13], $.CTX_OWN_SWITCHES || []).forEach(function(id) { skip[id] = true; });
    swd.forEach(function(d) { if (!skip[d[0]]) $gameSwitches._data[d[0]] = d[1]; });
    vd.forEach(function(d) { $gameVariables._data[d[0]] = d[1]; });
    ssd.forEach(function(d) {
        if (d[1] === null) delete $gameSelfSwitches._data[d[0]]; else $gameSelfSwitches._data[d[0]] = d[1];
    });
    if ($.markWorld) {
        swd.forEach(function(d) { $.markWorld('sw', d[0], !!$gameSwitches._data[d[0]]); });
        vd.forEach(function(d) { $.markWorld('v', d[0], $gameVariables._data[d[0]]); });
        ssd.forEach(function(d) { $.markWorld('ss', d[0], !!$gameSelfSwitches._data[d[0]]); });
    }
    $gameMap.requestRefresh();
};

$.chainDepth = function(root, interp) {
    var depth = 0;
    for (var i = root; i; i = i._childInterpreter, depth++) {
        if (i === interp) return depth;
    }
    return -1;
};

$.chainAt = function(root, depth) {
    var i = root;
    while (i && depth-- > 0) i = i._childInterpreter;
    return i;
};

// The map event waiting for the battle runs on for the new owner, so what it
// gives after the fight is theirs. When that is not possible (the host's
// parallel event, the host busy with its own event) it stays where it is.
$.moveBattleInterp = function(b, from, to) {
    var interp = b.interp;
    if (!interp) return;
    if (from === 'host') {
        var root = $gameMap._interpreter;
        var depth = $.chainDepth(root, interp);
        if (depth < 0 || $.owned[to]) {
            $.dlog('battle event stays with the host');
            return;
        }
        var json = JsonEx.stringify(root);
        var eventId = root.eventId();
        $.setDialogueOwner(root, false);
        if (eventId > 0) $gameMap.unlockEvent(eventId);
        root.clear();
        var copy = $.cleanInterp(JsonEx.parse(json));
        var waiting = $.chainAt(copy, depth);
        waiting._fhBattleWait = b.bid;
        waiting._waitMode = 'fhBattle';
        for (var i = copy; i; i = i._childInterpreter) i._fhOwner = to;
        var ev = eventId > 0 ? $gameMap.event(eventId) : null;
        if (ev) {
            ev._fhOwner = to;
            $.lockToward(ev, $.remotes[to]);
        }
        $.owned[to] = { interp: copy, ev: ev };
        b.interp = waiting;
        $.sendTo(to, { t: 'evRun', on: true });
        return;
    }
    var entry = $.owned[from];
    if (!entry || $.chainDepth(entry.interp, interp) < 0) return;
    var k;
    if (to === 'host') {
        if ($gameMap._interpreter.isRunning()) {
            $.dlog('battle event stays with', $.playerLabel(from));
            return;
        }
        delete $.owned[from];
        for (k = entry.interp; k; k = k._childInterpreter) delete k._fhOwner;
        if (entry.ev) entry.ev._fhOwner = null; // unlocked when the event ends
        $gameMap._interpreter = entry.interp;
    } else {
        if ($.owned[to]) return;
        delete $.owned[from];
        for (k = entry.interp; k; k = k._childInterpreter) k._fhOwner = to;
        if (entry.ev) entry.ev._fhOwner = to;
        $.owned[to] = entry;
        $.sendTo(to, { t: 'evRun', on: true });
    }
    var fromConn = $.clientById(from);
    if (fromConn) {
        fromConn._choiceMods = null;
        fromConn.send({ t: 'evRun', on: false });
    }
};

$.hostHandlers.bTakeFail = function(conn, msg) {
    var b = $.battles[msg.bid];
    var id = conn ? conn.guestId : 'host';
    if (!b || b.owner !== id) return;
    $.dlog('battle', b.bid, 'could not be taken over');
    delete $.battles[b.bid];
    $.unfreezeBattle(b);
    if (conn) conn.inBattle = 0;
    b.joiners.forEach(function(j) {
        $.bSend(j, { t: 'bEnd', bid: b.bid, r: 1 });
        var c = $.clientById(j);
        if (c) c.inBattle = 0;
        if (j === 'host') $.hostInJoin = 0;
    });
    if (b.interp) {
        b.interp._branch[b.interp._indent] = 1;
        b.interp._fhBattleWait = 0;
    }
};

// Joiners: commands now go to the new owner.
$.guestHandlers.bOwner = function(msg) {
    if ($.puppet && $.puppet.bid === msg.bid) $.puppet.owner = msg.owner;
};

// New owner: the battle view becomes the battle.
$.guestHandlers.bTakeOver = function(msg) {
    var p = $.puppet;
    if (!p || p.bid !== msg.bid) {
        $.dlog('take over: not in battle', msg.bid);
        if ($.isHost()) $.hostHandlers.bTakeFail(null, { bid: msg.bid });
        else if ($.conn) $.conn.send({ t: 'bTakeFail', bid: msg.bid });
        return;
    }
    if (!$gameParty.inBattle()) {
        p.takeOver = msg; // the battle screen is still opening
        return;
    }
    $.takeOverBattle(msg);
};

var _startBattleTakeOver = BattleManager.startBattle;
BattleManager.startBattle = function() {
    _startBattleTakeOver.call(this);
    var p = $.puppet;
    if (p && p.takeOver) {
        var msg = p.takeOver;
        p.takeOver = null;
        $.takeOverBattle(msg);
    } else if (p && p.rescue) {
        var rescue = p.rescue;
        p.rescue = null;
        $.guestHandlers.bRescue(rescue);
    }
};

$.mergeTroop = function(troop) {
    var live = $gameTroop._enemies;
    (troop._enemies || []).forEach(function(e, i) {
        // the sprites keep their enemy objects: copy into them
        if (live[i]) Object.keys(e).forEach(function(k) { live[i][k] = e[k]; });
    });
    Object.keys(troop).forEach(function(k) {
        if (k !== '_enemies') $gameTroop[k] = troop[k];
    });
};

$.takeOverBattle = function(msg) {
    var p = $.puppet;
    var me = $.myPlayerId();
    var bm = BattleManager;
    var s = msg.bm || {};
    $.puppet = null;
    bm._phase = 'atb';
    bm._subject = null;
    bm._actionBattlers = [];
    bm._actorIndex = -1;
    bm._escaped = false;
    bm._canEscape = !!s.ce;
    bm._canLose = !!s.cl;
    if (s.er !== undefined) bm._escapeRatio = s.er;
    bm._actionForcedBattler = null;
    bm._processingForcedAction = false;
    bm._forceActionQueue = [];
    bm._atbStarted = true;
    bm._atbActing = null;
    bm._atbInputActor = null;
    bm._atbSuspended = null;
    bm._atbInputMemory = null;
    bm._atbPreForceSubject = null;
    bm._atbPreForcePhase = null;
    bm._atbRoundTick = s.tick || 0;
    bm._atbRoundPending = !!s.pend;
    bm._atbRoundEnd = false;
    bm._atbAvgAgi = s.avg || 0;
    bm._atbFoeAvgAgi = s.foe || 0;
    bm._atbOneTurn = !!s.one;
    bm._atbSurprisePending = !!s.sur;
    var joiners = [];
    var mine = null;
    (msg.actors || []).forEach(function(e) {
        var a = $.parseActor(e.json);
        if (!a) return;
        if (e.j && e.j !== me) {
            a._fhJoiner = e.j;
            a._fhAwait = !!e.aw;
            a._fhRemoteReady = !!e.rd;
            joiners.push(e.j);
        } else {
            mine = a;
            if (e.rd) a._fhRemoteReady = true; // the chosen action still runs
            else if (e.aw) bm._atbSuspended = a; // its turn has begun: the window opens again
        }
        $gameActors._data[e.id] = a;
    });
    $gameParty._actors = (msg.actors || []).map(function(e) { return e.id; });
    $.mergeTroop(JsonEx.parse(msg.troop));
    $.dmgTable = msg.dmg || {};
    $.coinOwner = 0;
    $.coinCause = 0;
    $.talkOwner = 0;
    $.coinCtx = null;
    $.bChoiceWait = null;
    $.bDialogWait = null;
    $.lastBDialog = null;
    var wait = null;
    if ($.isHost()) {
        // the host's battles run on its own switches; the fight's own values
        // (V19 battleturns, the Moonless stage...) come as the fighting PC had
        // them (review 2026-11-03: they were dropped and the host fought on
        // with its own V19)
        $.applyBattleDelta($.diffArray(msg.sw, msg.sw0), $.diffArray(msg.v, msg.v0), $.diffObject(msg.ss, msg.ss0), true);
        (msg.v || []).forEach(function(value, id) { if ($.battleVar(id)) $gameVariables._data[id] = value; });
        var b = $.battles[msg.bid];
        wait = b ? b.interp : null;
        bm.setEventCallback(function(n) {
            if (wait && wait._branch) wait._branch[wait._indent] = n;
        });
    } else {
        $gameSwitches._data = msg.sw.slice();
        $gameVariables._data = msg.v.slice();
        $gameSelfSwitches._data = Object.assign({}, msg.ss);
        $gameMap.requestRefresh();
        $.localBattle = {
            bid: msg.bid, result: undefined,
            sw0: msg.sw0.slice(), v0: msg.v0.slice(), ss0: Object.assign({}, msg.ss0)
        };
        bm.setEventCallback(function(n) {
            if ($.localBattle) $.localBattle.result = n;
        });
    }
    $.authBattle = {
        bid: msg.bid, owner: me, joiners: joiners, troopId: msg.troopId,
        interp: wait, waitInterp: wait, restoreActors: p.saveActors
    };
    $.closeBattleInput();
    $.refreshBattleStatus();
    $.broadcastParty();
    $.battleGab((mine ? mine.name() : $.playerLabel(me)) + ' fights on.');
    $.dlog('took over battle', msg.bid, 'from', msg.from);
};

var _endAuthBattleHandoff = $.endAuthBattle;
$.endAuthBattle = function(result) {
    var ab = $.authBattle;
    _endAuthBattleHandoff(result);
    if (!ab) return;
    if (ab.waitInterp) ab.waitInterp._fhBattleWait = 0;
    var own = $.ownBattleActorId();
    if (ab.restoreActors && ab.restoreActors.indexOf(own) >= 0) $gameParty._actors = ab.restoreActors.slice();
};

var _leaveAsGuestHandoff = $.leaveAsGuest;
$.leaveAsGuest = function(message) {
    $.handoff = null;
    $.handedOff = {};
    _leaveAsGuestHandoff(message);
};

//-----------------------------------------------------------------------------
// The battle's PC is gone (disconnect): a joiner carries the fight on
//-----------------------------------------------------------------------------
// Nothing can be sent from a PC that left, so the new owner builds the battle
// from its own view: enemies and party as last streamed, the troop's turn
// count, the host's switches. What only the old PC knew is lost: a troop
// event in progress, battle-only switches it set, its character's last
// numbers. Battle-start pages do not run a second time.

$.recordBattleFlags = function(interp, b) {
    if (!b || !interp) return;
    var p = interp._params || [];
    b.ce = !!p[2];
    b.cl = !!p[3];
};

var _fhDelegateBattleRescue = Game_Interpreter.prototype.fhDelegateBattle;
Game_Interpreter.prototype.fhDelegateBattle = function() {
    var result = _fhDelegateBattleRescue.call(this);
    if (this._fhBattleWait) $.recordBattleFlags(this, $.battles[this._fhBattleWait]);
    return result;
};

// joiners: which player each character in the view belongs to
var _bViewRescue = $.guestHandlers.bView;
$.guestHandlers.bView = function(msg) {
    _bViewRescue(msg);
    if ($.puppet) $.puppet.owners = $.actorOwners(msg.actors);
};

var _bPartyRescue = $.guestHandlers.bParty;
$.guestHandlers.bParty = function(msg) {
    _bPartyRescue(msg);
    if ($.puppet && msg.bid === $.puppet.bid) $.puppet.owners = $.actorOwners(msg.actors);
};

$.actorOwners = function(list) {
    var owners = {};
    (list || []).forEach(function(e) { owners[e.id] = e.j; });
    return owners;
};

// Host: before the usual clean-up of a closed connection.
var _onGuestClosedBattleRescue = $.onGuestClosedBattle;
$.onGuestClosedBattle = function(conn) {
    Object.keys($.battles).forEach(function(bid) {
        var b = $.battles[bid];
        // a fight in the owner's own world went with that PC
        if (b.owner === conn.guestId && !b.pvp && !b.ownWorld) $.rescueBattle(b, conn);
    });
    _onGuestClosedBattleRescue(conn);
};

$.rescueBattle = function(b, conn) {
    var to = $.pickReceiver(b, b.joiners.filter(function(id) {
        return id !== 'host' || ($.puppet && $.puppet.bid === b.bid);
    }));
    if (!to) return;
    $.dlog('battle', b.bid, 'owner left; carried on by', $.playerLabel(to));
    b.prevOwners = (b.prevOwners || []).concat([conn.guestId]);
    b.owner = to;
    b.joiners = b.joiners.filter(function(id) { return id !== to; });
    var toConn = to === 'host' ? null : $.clientById(to);
    if (toConn) toConn.inBattle = b.bid; else $.hostInJoin = 0;
    $.moveBattleInterp(b, conn.guestId, to);
    b.joiners.forEach(function(id) { $.sendTo(id, { t: 'bOwner', bid: b.bid, owner: to }); });
    var sw = $gameSwitches._data, v = $gameVariables._data, ss = $gameSelfSwitches._data;
    $.sendTo(to, {
        t: 'bRescue', bid: b.bid, gone: conn.guestId, troopId: b.troopId,
        ce: b.ce !== undefined ? b.ce : true, cl: !!b.cl,
        sw: sw.slice(), v: v.slice(), ss: Object.assign({}, ss)
    });
};

// New owner: the take-over message made from this PC's own view.
$.guestHandlers.bRescue = function(msg) {
    var p = $.puppet;
    if (!p || p.bid !== msg.bid) {
        $.guestHandlers.bTakeOver({ t: 'bTakeOver', bid: msg.bid }); // says it cannot
        return;
    }
    if (!$gameParty.inBattle()) {
        p.rescue = msg; // the battle screen is still opening
        return;
    }
    var owners = p.owners || {};
    var gone = $gameParty.battleMembers().filter(function(a) { return owners[a.actorId()] === msg.gone; });
    gone.forEach(function(a) { $.battleGab(a.name() + ' is gone from the battle.', true); });
    $.markStartPagesDone();
    var actors = $gameParty.battleMembers().filter(function(a) { return gone.indexOf(a) < 0; });
    var take = {
        t: 'bTakeOver', bid: msg.bid, from: msg.gone, troopId: msg.troopId,
        troop: JsonEx.stringify($gameTroop),
        actors: actors.map(function(a) {
            return { id: a.actorId(), json: $.actorJson(a), j: owners[a.actorId()] || '', aw: false, rd: false };
        }),
        bm: { ce: msg.ce, cl: msg.cl, tick: 0 },
        dmg: {},
        sw: msg.sw, v: msg.v, ss: msg.ss, sw0: msg.sw, v0: msg.v, ss0: msg.ss
    };
    $.takeOverBattle(take);
    // gauges start over (the view never had the enemies' gauges)
    $gameTroop.members().forEach(function(e) { e.setAtbGauge(Math.random() * 0.3 * FH.ATB.MAX); });
};

// "Battle" span pages for the start of the fight (turn 0, or no condition)
// already ran on the old PC.
$.markStartPagesDone = function() {
    var troop = $gameTroop.troop();
    if (!troop) return;
    troop.pages.forEach(function(page, i) {
        var c = page.conditions;
        var none = !c.turnEnding && !c.turnValid && !c.enemyValid && !c.actorValid && !c.switchValid;
        var start = c.turnValid && c.turnA === 0 && c.turnB === 0;
        if (page.span === 0 && (none || start)) $gameTroop._eventFlags[i] = true;
    });
};

//=============================================================================
// Battle status: every player in the fight
//=============================================================================
// (User request 2026-10-19: the rows were always empty for the others.) The
// status window shows every fighter as the original shows the party: name,
// Body, Mind, states, its battler picture (limb loss included). Only this
// PC's own player gets commands. On a joined or watched screen the numbers,
// states and pictures are the fight PC's (bState, 10 a second, below).
// (The small ATB gauge list stays this player's own.)

$.isOtherPlayerActor = function(actor) {
    if (!$.role || !actor || !$gameParty.inBattle()) return false;
    var mine = $.puppet ? $.puppet.myActorId : ($.isHost() ? $.hostActorId() : $.myActorId);
    return actor.actorId() !== mine;
};

//=============================================================================
// Players block each other; OK in front of a player
//=============================================================================
// Each PC stops its own player from walking into another player's avatar
// (where that player is now on this PC). Not while an event moves the player
// (a cutscene must never get stuck on someone), not into the down or the
// dead (bodies on the floor; the down are revived from the next tile), not
// into players a cutscene hides.
// OK in front of a player: the host checks it after reviving and joining a
// fight (those come first), then that PC gets a small box: Trade / Wave.

$.PLAYER_COLLISION = true;
$.WAVE_BALLOON = 1; // "!"

$.remoteBlocks = function(id, r) {
    if (!r || r._transparent) return false;
    if ($.isHost()) {
        var conn = $.clientById(id);
        return !!conn && $.guestOnMap(conn) && !$.isDown(id);
    }
    return !$.downIds[id] && !$.deadIds[id];
};

$.remotePlayerAt = function(x, y) {
    var ids = Object.keys($.remotes || {});
    for (var i = 0; i < ids.length; i++) {
        var r = $.remotes[ids[i]];
        if (r.pos(x, y) && $.remoteBlocks(ids[i], r)) return ids[i];
    }
    return null;
};

var _isCollidedPlayers = Game_Player.prototype.isCollidedWithCharacters;
Game_Player.prototype.isCollidedWithCharacters = function(x, y) {
    if (_isCollidedPlayers.call(this, x, y)) return true;
    if (!$.collisionOn(this) || this.isMoveRouteForcing()) return false;
    var id = $.remotePlayerAt(x, y);
    return !!id && !$.pushedThrough(id);
};

// Not in the tutorial: everyone plays it on its own PC (the train is narrow
// and those done wait at the exit).
$.collisionOn = function(player) {
    return $.PLAYER_COLLISION && !!$.role && player === $gamePlayer && !player._fhRemoteId &&
        !$.isDownMe() && !$.solo && $.tutorialOver();
};

// Walking into the same player for a moment lets you pass (a narrow
// corridor must not trap anyone).
$.PUSH_THROUGH_FRAMES = 90;
$.push = null; // { id, since, last }

$.pushedThrough = function(id) {
    var p = $.push;
    return !!p && p.id === id && Graphics.frameCount - p.since >= $.PUSH_THROUGH_FRAMES;
};

// Counted where the input becomes a step, straight or diagonal
// (VE_DiagonalMovement).
$.STEP_DX = [0, -1, 0, 1, -1, 0, 1, -1, 0, 1];
$.STEP_DY = [0, 1, 1, 1, 0, 0, 0, -1, -1, -1];

var _executeMovePush = Game_Player.prototype.executeMove;
Game_Player.prototype.executeMove = function(d) {
    if ($.collisionOn(this) && $.STEP_DX[d] !== undefined) {
        // a diagonal step also checks the two corner tiles
        var x2 = $gameMap.roundX(this.x + $.STEP_DX[d]), y2 = $gameMap.roundY(this.y + $.STEP_DY[d]);
        var id = $.remotePlayerAt(x2, y2) ||
            (d % 2 ? $.remotePlayerAt(this.x, y2) || $.remotePlayerAt(x2, this.y) : null);
        var p = $.push;
        if (!id) {
            $.push = null;
        } else {
            if (!p || p.id !== id || Graphics.frameCount - p.last > 2) p = $.push = { id: id, since: Graphics.frameCount };
            p.last = Graphics.frameCount;
        }
    }
    _executeMovePush.call(this, d);
};

// Host: which player stands on (x, y), for a player pressing OK at it.
$.playerAtForHost = function(x, y, exceptId) {
    if (exceptId !== 'host' && $gamePlayer.pos(x, y) && !$gamePlayer.isTransparent()) return 'host';
    var hit = null;
    $.clients.forEach(function(c) {
        var r = $.remotes[c.guestId];
        if (!hit && c.guestId !== exceptId && r && r.pos(x, y) && $.guestOnMap(c)) hit = c.guestId;
    });
    return hit;
};

$.offerInteract = function(fromId, targetId) {
    if ($.isDown(targetId)) return false; // the revive above is for them
    // one in its own event (or a fight) does not open Trade / Duel either
    if ($.requesterBusy(fromId)) return true;
    var conn = targetId === 'host' ? null : $.clientById(targetId);
    var busy = conn ? $.isBusy(conn) || !conn.actorId : $gameParty.inBattle() || $gameMap.isEventRunning();
    if (busy) {
        $.sendTo(fromId, { t: 'toast', text: 'Co-op: ' + $.playerLabel(targetId) + ' is busy' });
        return true;
    }
    $.sendTo(fromId, { t: 'pAct', id: targetId, name: $.playerLabel(targetId) });
    return true;
};

// The player asking (fromId; 'host' is this PC's own player).
$.requesterBusy = function(fromId) {
    if (fromId === 'host') return $gameParty.inBattle() || $gameMap.isEventRunning();
    var c = $.clientById(fromId);
    return !c || !c.actorId || $.isBusy(c);
};

// guests (after revive and joining, which were pushed first)
$.actHooks.push(function(conn, msg) {
    if (msg.tr.indexOf(0) < 0) return false;
    var target = $.playerAtForHost(msg.x, msg.y, conn.guestId);
    return !!target && $.offerInteract(conn.guestId, target);
});

// the host
var _triggerButtonPlayers = Game_Player.prototype.triggerButtonAction;
Game_Player.prototype.triggerButtonAction = function() {
    if (_triggerButtonPlayers.call(this)) return true;
    if ($.isHost() && $.sessionActive() && Input.isTriggered('ok') && !$.isDown('host') && !this._fhRemoteId) {
        var x = $gameMap.roundXWithDirection(this.x, this.direction());
        var y = $gameMap.roundYWithDirection(this.y, this.direction());
        var target = $.playerAtForHost(x, y, 'host');
        if (target) return $.offerInteract('host', target);
    }
    return false;
};

$.pickOpen = function() {
    return typeof document !== 'undefined' && !!document.getElementById('fhcoop-pick');
};

var _canMovePick = Game_Player.prototype.canMove;
Game_Player.prototype.canMove = function() {
    if ($.role && $.pickOpen()) return false;
    return _canMovePick.call(this);
};

$.tradeWith = null; // partner chosen on the map: the trade screen opens on it

$.guestHandlers.pAct = function(msg) {
    if (!(SceneManager._scene instanceof Scene_Map) || $gameMessage.isBusy() || $.pickOpen()) return;
    // no trading as a ghost or with one (play test 2026-10-31: the dead host
    // gave Marina its things from here)
    var trade = !$.isGhostMe() && !$.isDead(msg.id);
    // a skill for one ally this player knows (Marina's Engrave): on the one
    // it talks to (user decision 2026-10-31: not from the menu, where it
    // reached a player on another map)
    var skills = trade && $.talkFieldSkills ? $.talkFieldSkills() : [];
    var opts = [];
    if (trade) opts.push('Trade');
    skills.forEach(function(s) { opts.push(s.name); });
    opts.push('Wave', 'Cancel');
    $.showPickBox(msg.name || 'Player', opts, function(i) {
        if (trade && i === 0) {
            $.tradeWith = msg.id;
            SceneManager.push(Scene_FHTrade);
            return;
        }
        var k = i - (trade ? 1 : 0);
        if (k < skills.length) {
            $.useFieldSkillOn(msg.id, skills[k].id);
        } else if (k === skills.length) {
            $.sendWave(msg.id);
        }
    }, opts.length - 1);
};

// Host: a trade that does not go through - the giver gets it back.
$.refuseTrade = function(fromId, msg, why) {
    var n = Math.max(1, Number(msg.n) || 1);
    var failed = $.clientById(fromId);
    if (failed) {
        failed._tradeFails = (failed._tradeFails || []).concat([{ k: msg.k, id: msg.id, n: n }]);
        failed.send({ t: 'tradeFail', k: msg.k, id: msg.id, n: n });
    }
    $.dlog('trade refused (' + why + '):', $.playerLabel(fromId), '->', $.playerLabel(msg.to));
};

// A trade by or to a dead player (a ghost's bag goes to the B / C winner or
// its body; a guest ghost's own menu sent one).
var _doTradeDead = $.doTrade;
$.doTrade = function(fromId, msg) {
    if (msg && ($.isDead(fromId) || $.isDead(msg.to))) return $.refuseTrade(fromId, msg, 'a dead player');
    return _doTradeDead(fromId, msg);
};

if (typeof Scene_FHTrade !== 'undefined') {
    var _tradeCreateWith = Scene_FHTrade.prototype.create;
    Scene_FHTrade.prototype.create = function() {
        _tradeCreateWith.call(this);
        var id = $.tradeWith;
        $.tradeWith = null;
        var index = id ? this._partners.findExt(id) : -1;
        if (index >= 0) {
            this._partners.select(index);
            this._partners.deactivate();
            this.onPartner();
        }
    };
}

$.sendWave = function(to) {
    if ($.isHost()) $.hostHandlers.wave(null, { t: 'wave', to: to });
    else if ($.conn) $.conn.send({ t: 'wave', to: to });
};

$.hostHandlers.wave = function(conn, msg) {
    var from = conn ? conn.guestId : 'host';
    var out = { t: 'wave', from: from, to: msg.to, name: $.playerLabel(from) };
    $.clients.forEach(function(c) { c.send(out); });
    $.guestHandlers.wave(out);
};

// everyone sees the "!" over the one who waves; the one waved at is told
$.guestHandlers.wave = function(msg) {
    var me = $.myPlayerId();
    var who = msg.from === me ? $gamePlayer : $.remotes && $.remotes[msg.from];
    if (who) who.requestBalloon($.WAVE_BALLOON);
    if (msg.to === me) $.toast('Co-op: ' + msg.name + ' waves at you');
};

//=============================================================================
// Crossed swords over an enemy someone is fighting that others can join
//=============================================================================

$.BATTLE_MARKS = false; // in progress: off until tested in the game
$.battleMarks = []; // [{ m, e, p: [owner and joiners] }] on every PC

$.joinableMarks = function() {
    return Object.keys($.battles).map(function(k) { return $.battles[k]; }).filter(function(b) {
        return !b.pvp && b.eventId > 0 && $.NO_JOIN_TROOPS.indexOf(b.troopId) < 0 && !$.fightFull(b);
    }).map(function(b) {
        return { m: b.mapId, e: b.eventId, p: [b.owner].concat(b.joiners) };
    });
};

$.lastMarksKey = '';
var _hostSyncMarks = $.hostSync;
$.hostSync = function() {
    _hostSyncMarks();
    if (!$.BATTLE_MARKS) return;
    var marks = $.joinableMarks();
    var key = JSON.stringify(marks);
    if (key === $.lastMarksKey) return;
    $.lastMarksKey = key;
    $.battleMarks = marks;
    $.clients.forEach(function(c) { c.send({ t: 'bMarks', list: marks }); });
};

$.guestHandlers.bMarks = function(msg) {
    $.battleMarks = msg.list || [];
};

// A snapshot does not carry the marks: a guest coming in asks for them again.
var _sendSnapshotMarks = $.sendSnapshot;
$.sendSnapshot = function(conn) {
    $.lastMarksKey = '';
    return _sendSnapshotMarks.apply(this, arguments);
};

$.marksHere = function() {
    var me = $.myPlayerId();
    var mapId = $gameMap.mapId();
    return $.battleMarks.filter(function(mk) { return mk.m === mapId && mk.p.indexOf(me) < 0; });
};

function Sprite_FHBattleMark() {
    this.initialize.apply(this, arguments);
}

Sprite_FHBattleMark.prototype = Object.create(Sprite.prototype);
Sprite_FHBattleMark.prototype.constructor = Sprite_FHBattleMark;

Sprite_FHBattleMark.prototype.initialize = function(eventId) {
    Sprite.prototype.initialize.call(this);
    this._eventId = eventId;
    this.bitmap = Sprite_FHBattleMark.bitmap();
    this.anchor.x = 0.5;
    this.anchor.y = 1;
    this.z = 9;
};

// Two crossed blades, drawn once.
Sprite_FHBattleMark.bitmap = function() {
    if (this._bitmap) return this._bitmap;
    var b = new Bitmap(28, 28);
    var ctx = b._context;
    var blade = function(flip) {
        ctx.save();
        ctx.translate(14, 14);
        ctx.scale(flip ? -1 : 1, 1);
        ctx.rotate(-Math.PI / 4);
        ctx.fillStyle = '#e8e8e8';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(-2, -12); ctx.lineTo(0, -15); ctx.lineTo(2, -12); ctx.lineTo(2, 6); ctx.lineTo(-2, 6);
        ctx.closePath();
        ctx.stroke();
        ctx.fill();
        ctx.fillStyle = '#c8a040';
        ctx.fillRect(-6, 6, 12, 3); // guard
        ctx.strokeRect(-6, 6, 12, 3);
        ctx.fillStyle = '#6a3a1a';
        ctx.fillRect(-1.5, 9, 3, 5); // grip
        ctx.restore();
    };
    blade(false);
    blade(true);
    b._setDirty();
    this._bitmap = b;
    return b;
};

Sprite_FHBattleMark.prototype.update = function() {
    Sprite.prototype.update.call(this);
    var ev = $gameMap.event(this._eventId);
    if (!ev) {
        this.visible = false;
        return;
    }
    this.visible = true;
    this.x = ev.screenX();
    this.y = ev.screenY() - 50 + Math.round(Math.sin(Graphics.frameCount / 15) * 2);
};

var _Spriteset_Map_update_marks = Spriteset_Map.prototype.update;
Spriteset_Map.prototype.update = function() {
    _Spriteset_Map_update_marks.call(this);
    if (this._tilemap) this.updateFHBattleMarks();
};

Spriteset_Map.prototype.updateFHBattleMarks = function() {
    var sprites = this._fhBattleMarks = this._fhBattleMarks || {};
    var want = {};
    if ($.role && $.BATTLE_MARKS) $.marksHere().forEach(function(mk) { want[mk.e] = true; });
    var id;
    for (id in want) {
        if (!sprites[id]) {
            sprites[id] = new Sprite_FHBattleMark(Number(id));
            this._tilemap.addChild(sprites[id]);
        }
    }
    for (id in sprites) {
        if (want[id]) continue;
        this._tilemap.removeChild(sprites[id]);
        delete sprites[id];
    }
};

$.Sprite_FHBattleMark = Sprite_FHBattleMark;

//=============================================================================
// Test duel (tests only): nobody dies
//=============================================================================
// For trying the betrayal duel without the tower. Both players get their
// character back as it was before the duel (fully healed, limbs as before;
// the bag is not put back). Off in a release and not in any menu (the menu
// entry was removed in 0.40); the tests turn it on. The duel
// itself (pvpIn, abortDuel, pvpCancel, the 'pvp' handlers) is the tower
// tournament's and stays.

$.TEST_DUEL = false;

$.testDuelRefusal = function(a, f, conn, fc) {
    var foeActor = $.actorOfPlayer(f);
    if ($.tourney) return 'the tournament is on';
    if ((conn && conn.subOf) || (fc && fc.subOf)) return 'not on a map another guest runs';
    if ($.isDown(a) || $.isDown(f)) return 'someone is down';
    if ((conn && $.isBusy(conn)) || (fc && $.isBusy(fc))) return 'someone is busy';
    if ((a === 'host' || f === 'host') && ($gameParty.inBattle() || $gameMap.isEventRunning() || $.pvpBattle ||
            $.pendingDuel)) {
        return 'the host is busy';
    }
    if (!foeActor || !$.PVP_TROOP[foeActor.actorId()]) return 'no duel form for that character';
    var mine = $.actorOfPlayer(a);
    if (!mine || !$.PVP_TROOP[mine.actorId()]) return 'no duel form for your character';
    return '';
};

$.hostHandlers.testDuel = function(conn, msg) {
    if (!$.TEST_DUEL || !msg) return;
    var a = conn ? conn.guestId : 'host';
    var f = msg.to;
    var fc = f === 'host' ? null : $.clientById(f);
    if (!f || f === a || (f !== 'host' && !fc)) return;
    var why = $.testDuelRefusal(a, f, conn, fc);
    if (why) {
        $.sendTo(a, { t: 'toast', text: 'Co-op: no test duel - ' + why });
        return;
    }
    var keep = {};
    [a, f].forEach(function(id) {
        var actor = $.actorOfPlayer(id);
        var sw = $.LIMB_SWITCHES[actor.actorId()] || [];
        keep[id] = { actor: $.actorJson(actor), limbs: sw.map(function(s) { return $gameSwitches.value(s); }) };
    });
    $.startPvp(a, f);
    Object.keys($.battles).forEach(function(k) {
        var b = $.battles[k];
        if (b.pvp && !b.test && b.attackerId === a && b.foeId === f) b.test = keep;
    });
    $.dlog('test duel', $.playerLabel(a), 'vs', $.playerLabel(f));
};

// A test duel ends: nobody dies, both get their character from before it.
var _finishPvpTest = $.finishPvp;
$.finishPvp = function(b, msg) {
    if (!b || !b.test) return _finishPvpTest(b, msg);
    var won = !!(msg && msg.pvp && msg.pvp.won);
    var winner = won ? b.attackerId : b.foeId;
    [b.attackerId, b.foeId].forEach(function(id) {
        var c = id === 'host' ? null : $.clientById(id);
        if (c) c.inBattle = 0;
        var k = b.test[id];
        var actor = k && $.parseActor(k.actor);
        if (!actor) return;
        actor.recoverAll();
        $gameActors._data[actor.actorId()] = actor;
        ($.LIMB_SWITCHES[actor.actorId()] || []).forEach(function(s, i) { $gameSwitches.setValue(s, !!k.limbs[i]); });
        if (!c) return;
        c._lastMeKey = null;
        if (c.roam) c.send({ t: 'testDuelEnd', actor: $.actorJson(actor) });
        else $.pushMe(c);
    });
    if (b.foeId === 'host' || b.attackerId === 'host') $gamePlayer.refresh();
    // the winner's battle ends as a win; the loser's just ends (its character
    // is the one from before the duel again, it must not fall now)
    [b.attackerId, b.foeId].forEach(function(id) {
        var end = { t: 'pvpEnd', bid: b.bid };
        if (id === winner) end.win = true;
        $.sendTo(id, end);
    });
    $.broadcastToast('Test duel: ' + $.playerLabel(winner) + ' won (nobody dies).');
};

// A roaming guest's own copy of its character.
$.guestHandlers.testDuelEnd = function(msg) {
    var actor = $.parseActor(msg.actor);
    if (actor && actor._actorId === $.myActorId) {
        $gameActors._data[$.myActorId] = actor;
        if ($gamePlayer) $gamePlayer.refresh();
    }
};


// Each duelist's PC says when its battle opened (or that it waits for a free
// screen). A test duel whose battle does not open on both PCs in time (an
// error there, a player who stays in a menu) is called off instead of
// leaving both players marked as fighting.
$.TEST_DUEL_OPEN_MS = 60000; // (real time, $.clockMs)

var _pvpOpenAck = $.guestHandlers.pvp;
$.guestHandlers.pvp = function(msg) {
    var ok = false, waits = false;
    try {
        _pvpOpenAck(msg);
        waits = !!($.pendingDuel && msg && $.pendingDuel.bid === msg.bid);
        ok = !waits && !!($.pvpBattle && msg && $.pvpBattle.bid === msg.bid);
    } finally {
        if (msg && msg.bid && (!waits || !msg.toldWait)) {
            if (waits) msg.toldWait = true;
            else if (!ok) $.dlog('duel: my battle did not open', msg.bid);
            var ack = { t: 'pvpIn', bid: msg.bid, ok: ok, wait: waits };
            if ($.isHost()) $.hostHandlers.pvpIn(null, ack);
            else if ($.conn) $.conn.send(ack);
        }
    }
};

$.hostHandlers.pvpIn = function(conn, msg) {
    var b = msg && $.battles[msg.bid];
    var id = conn ? conn.guestId : 'host';
    if (!b || !b.pvp || (b.attackerId !== id && b.foeId !== id)) return;
    b.opened = b.opened || {};
    b.waiting = b.waiting || {};
    if (msg.wait) {
        b.waiting[id] = true;
        $.dlog('duel: battle', b.bid, 'waits for a free screen on', $.playerLabel(id));
        return;
    }
    $.dlog('duel: battle', b.bid, msg.ok ? 'opened on' : 'FAILED on', $.playerLabel(id));
    if (msg.ok) {
        b.opened[id] = true;
        // it waited (a menu, a trade...): what it used or gave away meanwhile
        // was not used in the duel, the winner's restore takes its bag now
        var cur = $.tourney && $.tourney.cur;
        if (b.waiting[id] && cur && cur.bid === b.bid && cur.snap) cur.snap[id] = $.duelInvSnapshot(id);
        delete b.waiting[id];
        return;
    }
    if (b.test) $.cancelTestDuel(b, $.playerLabel(id) + '\'s battle did not open');
    else $.abortDuel(b, 'the battle did not open for ' + $.playerLabel(id));
};

// Both duelists' battles end without a result (nobody wins or dies).
$.abortDuel = function(b, why) {
    if (!b || !$.battles[b.bid]) return;
    delete $.battles[b.bid];
    $.unfreezeBattle(b); // (a guest's duel holds its event like any fight of a guest)
    $.settledDuels[b.bid] = true; // a report that still comes only resyncs that PC
    [b.attackerId, b.foeId].forEach(function(id) {
        var c = id === 'host' ? null : $.clientById(id);
        if (c) c.inBattle = 0;
        $.sendTo(id, { t: 'pvpCancel', bid: b.bid });
    });
    $.dlog('duel called off', b.bid, why);
    var t = $.tourney;
    if (t && t.cur && t.cur.bid === b.bid) t.cur.retryAt = $.clockMs() + $.DUEL_RETRY_MS;
};

$.cancelTestDuel = function(b, why) {
    if (!b || !$.battles[b.bid]) return;
    $.abortDuel(b, why);
    $.broadcastToast('Test duel called off: ' + why + '.');
};

$.guestHandlers.pvpCancel = function(msg) {
    var pend = $.pendingDuel;
    if (pend && msg && pend.bid === msg.bid) $.pendingDuel = null;
    var pb = $.pvpBattle, ab = $.authBattle;
    var mine = (pb && pb.bid === msg.bid) || (ab && ab.pvp && ab.bid === msg.bid);
    if (!mine) return;
    if ($gameParty.inBattle()) {
        BattleManager.abort();
        return;
    }
    $.dropDuelBattle();
};

var _testDuelOpenAt = $.hostHandlers.testDuel;
$.hostHandlers.testDuel = function(conn, msg) {
    $.dlog('test duel asked by', conn ? conn.name : 'host', 'against', msg && msg.to);
    var before = Object.keys($.battles);
    _testDuelOpenAt(conn, msg);
    Object.keys($.battles).forEach(function(k) {
        if (before.indexOf(k) < 0 && $.battles[k].test) $.battles[k].openBy = $.clockMs() + $.TEST_DUEL_OPEN_MS;
    });
};

$.worldExtras.push(function() {
    if (!$.isHost()) return;
    Object.keys($.battles).forEach(function(k) {
        var b = $.battles[k];
        if (!b || !b.test || !b.openBy || $.clockMs() <= b.openBy) return;
        var opened = b.opened || {}, waiting = b.waiting || {};
        var late = [b.attackerId, b.foeId].filter(function(id) { return !opened[id]; })[0];
        if (!late) return;
        $.cancelTestDuel(b, waiting[late] ? $.playerLabel(late) + ' stayed busy' :
            $.playerLabel(late) + '\'s battle did not open');
    });
});

//=============================================================================
// Mind 0: a duel to the death (hidden, user decision 2026-10-29)
//=============================================================================
// Not in the patch notes. The moment a player's mind (MP) falls to 0 from
// above 0 (a fight, an event, an item, a gun's groin hit, any cause), that
// player smells it: "A foul stench grows strong....." on its screen alone
// (Korean data: the Korean line), the first time only, and from then on, for
// this playthrough, it may kill another player. Kept by name in the host's
// save (coopData().stench: name -> true; the host '#host'): a re-join and a
// load keep it, a load from before it has it off again. Down or dead (a
// ghost) at that moment: nothing.
// Where the MP falls: every PC that changes a player's character reports it
// (Game_BattlerBase.setMp and paySkillCost - a spell's cost goes straight to
// _mp - on the PC's own copy in $gameActors: the host's
// copies of the thin guests' characters in their events and in the host's
// fights, a guest PC's fight with its joiners, a roaming guest's own world,
// a sub-host's guests). The host names the player by its character and
// decides once; the same fall seen on two PCs counts once. Views of a fight
// (a joiner, a watching ghost) set MP directly, not through setMp.
// OK in front of a living player then gives "Attack <name>" / "Leave" (in
// place of Trade / Wave; trading stays in the menu). Attack opens the tower
// duel's battle ($.startPvp) between the two; the other one cannot say no.
// The loser dies like a tower duel loser (finishPvp: a ghost, its death
// switch, V201 - 1, its SELECT off; its soul as there: nobody takes it).
// Unlike the tower duel and the test duel the winner keeps what the duel did
// to it: no full heal (duelHeal), no bag put back (restoreDuelItems / the
// test duel's copy from before). Its real HP is what the duel left: the body's
// share of its max HP (duelSyncSelfHp, at least 1 while the body is up); the
// items it used stay used; the limbs it lost in the duel stay lost
// (applyDuelCuts); states that last past a battle stay. One line for all:
// "<winner> killed <loser>.". No bracket, no tower door state.
// Not allowed (a toast): the tournament on, someone down / busy / in a fight
// (the test duel's refusals), a map another guest runs, not the same map, a
// dream map (31 / 32), the tutorial, an ending.

$.STENCH_TEXT = 'A foul stench grows strong.....';
$.STENCH_TEXT_KO = '지독한 냄새가 강하게 느껴진다.....';
$.LETHAL_NO_MAPS = { 31: true, 32: true }; // the Hexen board, the dream
$.LETHAL_MENU_MS = 15000; // a duelist whose battle waits for its menu: closed after this (real time)
$.myStench = false; // guest: this player's own (from the host's record)
$.lethalSettled = {}; // host: bid -> true once a duel to the death is settled

$.stenchData = function() {
    var data = $.coopData();
    return (data.stench = data.stench || {});
};

// Host: whose character this is now (player id), or null.
$.playerOfActor = function(actorId) {
    if (!actorId || !$.isHost()) return null;
    if ($.realHostActorId() === actorId) return 'host';
    var c = $.clients.filter(function(x) { return x.actorId === actorId && !!x.name; })[0];
    return c ? c.guestId : null;
};

$.stenchLine = function() {
    $.fieldGab($.koreanData && $.koreanData() ? $.STENCH_TEXT_KO : $.STENCH_TEXT);
};

// Host: that player's mind went to 0.
$.stenchFor = function(id) {
    var name = id ? $.nameOf(id) : null;
    if (!name) return;
    var rec = $.stenchData();
    if (rec[name] || $.isDown(id)) return; // (down: the dead too)
    rec[name] = true;
    $.dlog('mind 0:', $.playerLabel(id), 'may kill now');
    if (id === 'host') {
        $.stenchLine();
        return;
    }
    var c = $.clientById(id);
    if (c) c._stenchSent = true;
    $.sendTo(id, { t: 'stench', on: true, line: true });
};

$.mindHitZero = function(actor) {
    var actorId = actor.actorId();
    if ($.isHost()) {
        $.stenchFor($.playerOfActor(actorId));
    } else if ($.isGuest() && $.conn && $.myActorId) {
        $.conn.send({ t: 'mind0', a: actorId });
    }
};

$.hostHandlers.mind0 = function(conn, msg) {
    if (!conn.actorId) return;
    $.stenchFor($.playerOfActor(Number(msg && msg.a) || 0));
};

$.guestHandlers.stench = function(msg) {
    $.myStench = !!(msg && msg.on);
    if (msg && msg.line) $.stenchLine();
};

// A player's character on this PC went from above 0 mind to 0.
$.mindWatch = function(battler, before) {
    if ($.role && before > 0 && battler._mp <= 0 && battler instanceof Game_Actor &&
            $gameActors && $gameActors._data[battler._actorId] === battler && $.PLAYABLE.contains(battler._actorId)) {
        $.mindHitZero(battler);
    }
};

// (the engine's setMp - YEP_CoreEngine is off in this game; gainMp and the
// Change MP command go through it)
var _setMpStench = Game_BattlerBase.prototype.setMp;
Game_BattlerBase.prototype.setMp = function(mp) {
    var before = this._mp;
    _setMpStench.call(this, mp);
    $.mindWatch(this, before);
};

// A spell's mind cost (the engine takes it off _mp directly, no setMp; the
// YEP and Olivia wrappers call the engine's): spending the last of the mind
// is 0 too, in a fight or from the menu.
var _paySkillCostStench = Game_BattlerBase.prototype.paySkillCost;
Game_BattlerBase.prototype.paySkillCost = function(skill) {
    var before = this._mp;
    _paySkillCostStench.call(this, skill);
    $.mindWatch(this, before);
};

// A guest learns its own with its character (a re-join) and with each
// snapshot (a load: that save's record).
$.sendStench = function(c, force) {
    var on = !!$.stenchData()[c.name];
    if (!force && c._stenchSent === on) return;
    c._stenchSent = on;
    c.send({ t: 'stench', on: on });
};

var _sendAssignStench = $.sendAssign;
$.sendAssign = function(conn, actorId) {
    _sendAssignStench(conn, actorId);
    $.sendStench(conn, true);
};

var _sendSnapshotStench = $.sendSnapshot;
$.sendSnapshot = function(conn) {
    var out = _sendSnapshotStench.apply(this, arguments);
    if ($.isHost() && $gameSystem) {
        $.snapshotTargets(conn).forEach(function(c) { if (c.name && c.actorId) $.sendStench(c, false); });
    }
    return out;
};

var _leaveAsGuestStench = $.leaveAsGuest;
$.leaveAsGuest = function(message) {
    $.myStench = false;
    _leaveAsGuestStench(message);
};

// This PC's player may attack: it smelled it and stands (not down, no ghost).
$.lethalOpen = function() {
    if (!$.role || $.isDownMe() || $.isGhostMe()) return false;
    return $.isHost() ? !!$.stenchData()[$.nameOf('host')] : !!$.myStench;
};

var _pActLethal = $.guestHandlers.pAct;
$.guestHandlers.pAct = function(msg) {
    if (!msg || !$.lethalOpen()) return _pActLethal(msg);
    if (!(SceneManager._scene instanceof Scene_Map) || $gameMessage.isBusy() || $.pickOpen()) return;
    var name = msg.name || 'Player';
    $.showPickBox(name, ['Attack ' + name, 'Leave'], function(i) {
        if (i !== 0) return;
        var ask = { t: 'lethalDuel', to: msg.id };
        if ($.isHost()) $.hostHandlers.lethalDuel(null, ask);
        else if ($.conn) $.conn.send(ask);
    }, 1);
};

// '' or why not (the test duel's refusals first).
$.lethalRefusal = function(a, f, conn, fc) {
    var why = $.testDuelRefusal(a, f, conn, fc);
    if (why) return why;
    if ($.tourneyAsk) return 'the tournament is on';
    var m = $.playerMapOf(a);
    if (!m || m !== $.playerMapOf(f)) return 'not on the same map';
    if ($.LETHAL_NO_MAPS[m]) return 'not in a dream';
    if (!$.tutorialOver() || $.TUTORIAL_MAPS.contains(m) || (conn && conn.solo) || (fc && fc.solo)) {
        return 'not in the tutorial';
    }
    if ($.endingA || ($.ENDING_MAPS && $.ENDING_MAPS[m])) return 'not in an ending';
    return '';
};

$.hostHandlers.lethalDuel = function(conn, msg) {
    var a = conn ? conn.guestId : 'host';
    var f = msg && msg.to;
    var fc = f === 'host' ? null : $.clientById(f);
    if (!f || f === a || (f !== 'host' && !fc)) return;
    if (!$.stenchData()[$.nameOf(a)]) return; // (a guest's word alone does not open it)
    var why = $.lethalRefusal(a, f, conn, fc);
    if (why) {
        $.dlog('duel to the death refused:', $.playerLabel(a), 'on', $.playerLabel(f), '-', why);
        $.sendTo(a, { t: 'toast', text: 'Co-op: you cannot attack now - ' + why + '.' });
        return;
    }
    // each guest's bag now: a late report brings only its change to it
    var snap = {}, names = {};
    [a, f].forEach(function(id) {
        var c = id === 'host' ? null : $.clientById(id);
        if (c) snap[id] = $.copyBag($.inventoryOf(c));
        names[id] = $.playerLabel(id);
    });
    var before = Object.keys($.battles);
    $.duelQuietStart = true; // ("A turned on B!" to the two alone: the feature is hidden)
    try {
        $.startPvp(a, f);
    } finally {
        $.duelQuietStart = false;
    }
    Object.keys($.battles).forEach(function(k) {
        var b = $.battles[k];
        if (before.indexOf(k) >= 0 || !b.pvp) return;
        b.lethal = true;
        b.eventId = 0; // (startPvp names the tower door: here no event waits on it, none is held)
        b.snap = snap;
        b.names = names;
        b.since = $.clockMs();
        b.openBy = b.since + $.TEST_DUEL_OPEN_MS;
        $.dlog('duel to the death', b.bid, $.playerLabel(a), 'attacks', $.playerLabel(f));
    });
};

$.copyBag = function(inv) {
    inv = inv || {};
    return { i: Object.assign({}, inv.i || {}), w: Object.assign({}, inv.w || {}), a: Object.assign({}, inv.a || {}),
        g: Number(inv.g) || 0 };
};

// Settled: what the duel did stays (no heal, no restore: finishPvp alone).
// $.lethalSettled[bid]: { late: the one whose report has not come yet,
// snap: the guests' bags at the start, until: its "in a fight" mark ends }.
// The one still in its battle stays in a fight for the host (its gifts wait,
// nobody attacks it again) until its report comes or LETHAL_LATE_MS pass.
// A load or a new game forgets them (the world they belong to is gone).
$.LETHAL_LATE_MS = 60000; // (real time)
var _finishPvpLethal = $.finishPvp;
$.finishPvp = function(b, msg) {
    if (!b || !b.lethal) return _finishPvpLethal(b, msg);
    var late = [b.attackerId, b.foeId].filter(function(id) { return !(b.reports && b.reports[id]); })[0] || null;
    var rec = $.lethalSettled[b.bid] = { late: late, snap: b.snap || {}, until: 0 };
    _finishPvpLethal(b, msg);
    var c = late && late !== 'host' ? $.clientById(late) : null;
    if (c && !$.isDead(late)) {
        c.inBattle = b.bid;
        rec.until = $.clockMs() + $.LETHAL_LATE_MS;
    }
};

$.forgetLethal = function() {
    if (!$.isGuest()) $.lethalSettled = {};
};
var _extractSaveContentsLethal = DataManager.extractSaveContents;
DataManager.extractSaveContents = function(contents) {
    _extractSaveContentsLethal.call(this, contents);
    $.forgetLethal();
};
var _setupNewGameLethal = DataManager.setupNewGame;
DataManager.setupNewGame = function() {
    _setupNewGameLethal.call(this);
    $.forgetLethal();
};

// The second report of a settled duel (the first one settled it) carries
// that player's character as its duel left it: the tower and the test duel
// put the host's copy back on it (healed, restored); here that copy is the
// one from before the duel, so the report's character is taken, its bag
// changed by what the duel changed (from the bag at the start: what came in
// meanwhile stays), and the limbs it lost (settleDuel had only the first
// report's). A roaming guest's own copy is the newer one: taken whole.
// A dead loser of a tower duel reporting late: its bag as the duel left it
// (what it drank there is not passed on to the B / C winner).
$.lethalLateReport = function(conn, msg, rec) {
    var base = rec.snap && rec.snap[conn.guestId];
    if (base && msg.inv && !conn.roam) {
        $.hostHandlers.syncMe(conn, { actorId: conn.actorId, actor: msg.actor });
        if (!$.lethalBagLocked(conn)) $.applyInvDelta($.inventoryOf(conn), base, $.copyBag(msg.inv));
    } else {
        $.hostHandlers.syncMe(conn, { actorId: conn.actorId, actor: msg.actor, inv: msg.inv });
    }
    $.applyDuelCuts(conn.guestId, msg.pvp && msg.pvp.cuts);
    var actor = $gameActors.actor(conn.actorId);
    if (actor && $.isDead(conn.guestId) && !actor.isStateAffected($.KNOCKOUT)) actor.addState($.KNOCKOUT);
    $.dlog('duel to the death', msg.bid, ': the late report of', $.playerLabel(conn.guestId), 'taken as it is');
};

// (FH_CoopRoam: a dead player whose things the B / C winner took)
$.lethalBagLocked = function(conn) {
    return !!($.strippedDead && $.strippedDead(conn.name));
};

var _battleEndLethal = $.hostHandlers.battleEnd;
$.hostHandlers.battleEnd = function(conn, msg) {
    var settled = !!msg && !!conn && !!conn.actorId && !$.battles[msg.bid];
    var rec = settled ? $.lethalSettled[msg.bid] : null;
    if (rec && (!rec.late || rec.late === conn.guestId)) {
        delete $.lethalSettled[msg.bid];
        $.lethalLateReport(conn, msg, rec);
    } else if (settled && !rec && $.settledDuels[msg.bid] && msg.inv && $.isDead(conn.guestId) &&
            !$.lethalBagLocked(conn)) {
        var bag = $.inventoryOf(conn), now = $.copyBag(msg.inv);
        bag.i = now.i;
        bag.w = now.w;
        bag.a = now.a;
        bag.g = now.g;
        $.dlog('duel', msg.bid, ': the dead loser', conn.name, 'keeps the bag its duel left it');
    }
    _battleEndLethal(conn, msg);
};

// The host's own battle ended after a guest's report settled it: its limbs.
var _endBattleLethal = BattleManager.endBattle;
BattleManager.endBattle = function(result) {
    var pb = $.isHost() && !$.localBattle ? $.pvpBattle : null;
    var cuts = pb ? $.duelSelfCuts() : [];
    _endBattleLethal.call(this, result);
    if (pb && $.lethalSettled[pb.bid] && cuts.length) $.applyDuelCuts('host', cuts);
    if (pb && $.lethalSettled[pb.bid] && $.lethalSettled[pb.bid].late === 'host') delete $.lethalSettled[pb.bid];
};

// Called off (a battle that did not open): both duelists are told.
var _abortDuelLethal = $.abortDuel;
$.abortDuel = function(b, why) {
    var tell = !!b && !!b.lethal && !!$.battles[b.bid];
    _abortDuelLethal(b, why);
    if (!tell) return;
    [b.attackerId, b.foeId].forEach(function(id) {
        $.sendTo(id, { t: 'toast', text: 'Co-op: the fight was called off (' + why + ').' });
    });
};

// Every box (showPickBox) on this PC: answered with its cancel choice and
// closed, the ones waiting too. True: there was one.
$.closePickBoxes = function() {
    var all = ($.pickShown ? [$.pickShown] : []).concat($.pickQueue);
    $.pickQueue = [];
    if ($.pickShown) {
        if ($.pickShown.close) $.pickShown.close();
        $.pickShown = null;
    }
    all.forEach(function(e) { if (e.cancelIndex !== undefined) e.done(e.cancelIndex); });
    return all.length > 0;
};

// The one attacked cannot hide in its menu or behind a box (its battle opens
// only from a free map screen).
$.LETHAL_MENU_TEXT = 'Co-op: you are attacked - your menu was closed';
$.lethalFreeScreen = function() {
    if ($.closePickBoxes()) $.dlog('duel to the death: the boxes on this screen were closed');
    $.leaveMenuForDuel($.LETHAL_MENU_TEXT);
};

var _duelMenuCloseLethal = $.guestHandlers.duelMenuClose;
$.guestHandlers.duelMenuClose = function(msg) {
    if (!msg || !msg.lethal) return _duelMenuCloseLethal(msg);
    $.lethalFreeScreen();
};

// Not open on both PCs in time: called off. A duelist whose battle waits for
// its screen gets its menu and its boxes closed first. A late reporter's
// "in a fight" mark ends after LETHAL_LATE_MS (a PC that never reports).
$.lethalFrame = function() {
    if (!$.isHost()) return;
    var now = $.clockMs();
    Object.keys($.battles).forEach(function(k) {
        var b = $.battles[k];
        if (!b || !b.lethal || !b.openBy) return;
        var opened = b.opened || {}, waiting = b.waiting || {};
        var late = [b.attackerId, b.foeId].filter(function(id) { return !opened[id]; });
        if (!late.length) {
            b.openBy = 0;
            return;
        }
        if (now > b.openBy) {
            $.abortDuel(b, waiting[late[0]] ? $.playerLabel(late[0]) + ' stayed busy' :
                $.playerLabel(late[0]) + '\'s battle did not open');
            return;
        }
        if (now - (b.since || now) < $.LETHAL_MENU_MS || now - (b.menuClosedAt || 0) < $.MENU_CLOSE_AGAIN_MS) return;
        late.forEach(function(id) {
            if (!waiting[id]) return;
            b.menuClosedAt = now;
            if (id === 'host') $.lethalFreeScreen();
            else $.sendTo(id, { t: 'duelMenuClose', lethal: true });
        });
    });
    Object.keys($.lethalSettled).forEach(function(bid) {
        var rec = $.lethalSettled[bid];
        if (!rec.until || now <= rec.until) return;
        rec.until = 0;
        var c = rec.late ? $.clientById(rec.late) : null;
        if (c && String(c.inBattle) === String(bid)) c.inBattle = 0;
        $.dlog('duel to the death', bid, ': no late report from', rec.late, '- free again');
    });
};
$.worldExtras.push(function() { $.lethalFrame(); });

//=============================================================================
// Duel: both sides (user decision 2026-10-19: symmetric, always a battle)
//=============================================================================
// Each duelist's PC runs its own battle ($.startPvp sends 'pvp' to both):
// its character is the party, the other player's duel form (body parts) the
// enemy, with the same part HP model, limb loss, guards, head lock and ATB
// on both PCs. The foe's parts never act here: the other player acts on its
// own PC. What links the two battles:
// - a hit: this PC applies its action to the foe's parts with every duel
//   rule (the damage curve too: only the hitter computes it) and sends
//   what changed (bDuelHit: HP per part on the body's scale,
//   MP, states, buffs, kill when the torso or the head broke). The foe's PC
//   applies that to its own body ($.pvpBattle.self: the body (torso) max HP
//   x 10, limbs and head their shares); its character's real HP follows the body
//   ($.duelHpOfBody).
// - the body: each PC streams its own body (bState with 'dv': the pools with
//   the body, the cuts, how many hits it took in, dead) next to its
//   character's HP, MP, states and gauge; the other PC shows that on the
//   foe's parts. A copy that does not have this PC's last hit yet is not
//   used for HP. A change of the character's HP on its own PC (a potion,
//   poison) goes to the body first, through the curve ($.duelGainOwnBody,
//   $.duelSyncSelfHp).
// - effects: animations, damage numbers, motions and battle messages go both
//   ways (bFx); the foe's parts here are its character there.
// - the end: the PC whose battle ends first reports (battleEnd / the host's
//   own); the host settles at once and tells both (pvpEnd with win). A kill
//   is the hitter's word (both PCs saw the same hit), a death of its own
//   (poison) the owner's.
// - a PC that cannot open its battle yet (a menu, a message, a box, a map
//   change) waits and opens it as soon as it can; the other battle waits for
//   it (its gauges stand still, "Waiting for ..."). There is no other way to
//   fight a duel (0.38.2's small move list is gone).

$.settledDuels = {}; // host: bid -> true once settled (a later report only resyncs that PC)
$.DUEL_WAIT_TELL_AFTER_MS = 1000; // "Waiting for ..." when the other battle is not up after this (real time)

// The first report settles the duel: pvp { won, cuts, gone }.
$.duelReport = function(b, id, pvp) {
    if (!b || !b.pvp || !$.battles[b.bid]) return;
    pvp = pvp || {};
    b.reports = b.reports || {};
    b.reports[id] = { won: !!pvp.won, cuts: pvp.cuts || [] };
    var other = id === b.attackerId ? b.foeId : b.attackerId;
    var winner = pvp.won ? id : other;
    $.dlog('duel', b.bid, 'reported by', $.playerLabel(id), pvp.gone ? '(left)' : '', '- winner:', $.playerLabel(winner));
    $.settleDuel(b, winner);
};

$.settleDuel = function(b, winner) {
    if (!$.battles[b.bid]) return;
    delete $.battles[b.bid];
    $.settledDuels[b.bid] = true;
    $.unfreezeBattle(b);
    var cuts = {};
    Object.keys(b.reports || {}).forEach(function(id) { cuts[id] = b.reports[id].cuts; });
    $.finishPvp(b, { pvp: { won: winner === b.attackerId, cuts: cuts } });
};

// This player's character in its duel.
$.duelMe = function() {
    return $gameActors.actor($.isHost() ? $.hostActorId() : $.myActorId);
};

// This player's own body: one entry per part of its duel form, in troop
// order (the index the other PC uses). Every part keeps its pool here on
// the body's scale: the body (torso) starts at the character's HP share, the
// limbs and the head full (limbs and head never heal). hp / mhp: the real HP
// and max HP the body was last matched to ($.duelSyncSelfHp).
$.duelSelfBody = function(actorId, hp, mhp, limbs) {
    var parts = $.pvpPartPools(actorId, mhp).map(function(p) {
        var cut = !p.body && $.limbCutBefore(p.kind, limbs);
        var now = p.body ? $.duelBodyOfHp(hp, mhp, p.mhp) : cut ? 0 : p.mhp;
        return { kind: p.kind, mhp: p.mhp, hp: now, cut: cut, cutNow: false, body: !!p.body };
    });
    return { parts: parts, hp: hp, mhp: mhp };
};

// The body part of this player's own body (the torso).
$.duelSelfTorso = function(pb) {
    pb = pb || $.pvpBattle;
    if (!pb || !pb.self) return null;
    return pb.self.parts.filter(function(p) { return p.body; })[0] || null;
};

// This player's character and its body agree. Every gainHp of its character
// on this PC (a potion, a heal, poison, a skill's HP cost, a drain) goes to
// the body at once ($.duelGainOwnBody). Anything else that set its HP here
// (recover all, a direct change) is taken in the next time this runs: the
// curve of the change on the body (real HP 0: the body 0; healed to full:
// the whole body). Then the real HP is the body's share again:
// round(mhp * body / bodyMax), at least 1 while the body is above 0. A change of
// max HP alone (a buff, equipment) keeps the body and moves the real HP with
// it. True: the real HP was moved.
$.duelSyncSelfHp = function() {
    var pb = $.pvpBattle, me = $.duelMe();
    var torso = $.duelSelfTorso(pb);
    if (!torso || !me || pb.selfDead || pb.won) return false;
    var self = pb.self, mhp = me.mhp, moved = false;
    if (me.hp !== self.hp && mhp === self.mhp) {
        if (me.hp <= 0) torso.hp = 0;
        else if (me.hp >= mhp) torso.hp = torso.mhp; // healed to full: the whole body
        else torso.hp = Math.max(1, Math.min(torso.mhp, torso.hp + $.duelBodyDelta(me.hp - self.hp)));
    }
    var real = $.duelHpOfBody(torso.hp, mhp, torso.mhp);
    if (me.hp !== real && me.isAlive()) {
        me.setHp(real);
        moved = true;
    }
    self.hp = me.hp;
    self.mhp = mhp;
    return moved;
};

// gainHp on this player's own character in its duel goes to the body. (Not
// once the duel is decided, not for a view; bDuelHit sets the real HP from
// the body itself: $.duelHpThrough.)
$.duelHpThrough = false;
$.duelOwnsHp = function(battler) {
    var pb = $.pvpBattle;
    return !!pb && !!pb.self && !$.duelHpThrough && !$.puppet && !pb.selfDead && !pb.won && !!battler &&
        battler.isActor() && $gameParty.inBattle() && battler === $.duelMe();
};

// A change of X HP on this player's own character (a potion, poison, a
// skill's HP cost): the curve of X on its body (a heal of 100: +40); what it
// drains or life-steals from the foe ($.duelHitBy): the curved hit it dealt,
// as it is. The real HP is the body's share again. The number shown is the
// body's, as for the other player's hits on it.
$.duelGainOwnBody = function(me, value) {
    var pb = $.pvpBattle;
    $.duelSyncSelfHp(); // (a direct change since the last look first)
    var torso = $.duelSelfTorso(pb);
    if (!torso) {
        $.duelHpThrough = true;
        try { me.gainHp(value); } finally { $.duelHpThrough = false; }
        return;
    }
    var d = value > 0 && $.duelHitBy === me ? Math.round(value) : $.duelBodyDelta(value);
    torso.hp = Math.max(0, Math.min(torso.mhp, torso.hp + d));
    me._result.hpDamage = -d;
    me._result.hpAffected = true;
    me.setHp($.duelHpOfBody(torso.hp, me.mhp, torso.mhp));
    pb.self.hp = me.hp;
    pb.self.mhp = me.mhp;
};

// The limbs this player lost in this duel.
$.duelSelfCuts = function() {
    var pb = $.pvpBattle;
    if (!pb || !pb.self) return [];
    return pb.self.parts.filter(function(p) { return p.cutNow && $.isPvpLimb(p.kind); })
        .map(function(p) { return p.kind; });
};

// The other duelist gets this PC's battle stream and effects.
var _battleViewersDuel = $.battleViewers;
$.battleViewers = function() {
    var list = _battleViewersDuel();
    var ab = $.authBattle, pb = $.pvpBattle;
    if (ab && ab.pvp && pb && pb.bid === ab.bid && pb.foeId && list.indexOf(pb.foeId) < 0) {
        list = list.concat([pb.foeId]);
    }
    return list;
};

var _battleStateDataDuel = $.battleStateData;
$.battleStateData = function() {
    var ab = $.authBattle, pb = $.pvpBattle;
    var duel = !!(ab && ab.pvp && pb && pb.self);
    if (duel && $gameParty.inBattle()) $.duelSyncSelfHp(); // (the row of HP below too)
    var st = _battleStateDataDuel();
    if (duel) {
        var me = $.duelMe();
        st.dv = {
            id: me ? me.actorId() : 0, ack: pb.hitsIn,
            hp: pb.self.parts.map(function(p) { return p.hp; }), // the body (torso) too, on the body's scale
            mx: pb.self.parts.map(function(p) { return p.mhp; }), // its pools: the other PC takes these
            cut: pb.self.parts.map(function(p) { return p.cut ? 1 : 0; }),
            dead: !me || me.isDead() || pb.selfDead ? 1 : 0
        };
    }
    return st;
};

// Now, not at the next stream step (the battle is about to end).
$.sendDuelBody = function() {
    var pb = $.pvpBattle;
    if (!pb || !pb.foeId || !$.authBattle || !pb.self) return;
    $.bSend(pb.foeId, { t: 'bState', bid: pb.bid, st: $.battleStateData() });
};

// Hits ----------------------------------------------------------------------

$.duelFoeSnap = function() {
    return $gameTroop.members().map(function(e) {
        return { hp: e._hp, mp: e._mp, st: e._states.slice(), bf: e._buffs.slice(), bt: e._buffTurns.slice(),
            dead: e.isDead() };
    });
};

// $.duelHitBy: the character whose action is landing on the foe's parts
// (what it drains or life-steals is on the body's scale: see gainHp).
$.duelHitBy = null;
var _applyDuelHit = Game_Action.prototype.apply;
Game_Action.prototype.apply = function(target) {
    var pb = $.pvpBattle;
    var track = !!pb && !!target && !!target._fhPvpFoe && target.isEnemy() && $gameParty.inBattle();
    var before = track ? $.duelFoeSnap() : null;
    var hitBy = $.duelHitBy;
    if (track) $.duelHitBy = this.subject();
    try {
        _applyDuelHit.call(this, target);
    } finally {
        $.duelHitBy = hitBy;
    }
    if (track && $.pvpBattle === pb) $.sendDuelHit(before, $.duelFoeSnap());
};

$.sendDuelHit = function(before, after) {
    var pb = $.pvpBattle;
    var members = $gameTroop.members();
    var death = members.length ? members[0].deathStateId() : 1;
    var hit = { t: 'bDuelHit', bid: pb.bid, d: [], st: [], rs: [], mp: 0, bf: [], kill: 0 };
    after.forEach(function(now, i) {
        var was = before[i];
        if (!was) return;
        if (now.hp !== was.hp) hit.d.push([i, now.hp - was.hp]);
        now.st.forEach(function(id) {
            if (id !== death && was.st.indexOf(id) < 0 && hit.st.indexOf(id) < 0) hit.st.push(id);
        });
        var kind = members[i]._fhPart;
        // (at 0 HP it is broken even while the battle keeps it standing to
        // the end of the action - YEP immortal - and it falls here then)
        if ((kind === 'torso' || kind === 'head') && (now.dead || now.hp <= 0) && !was.dead && was.hp > 0) hit.kill = 1;
    });
    var at = members.indexOf(pb.ctl);
    var tw = before[at], tn = after[at];
    if (tw && tn) {
        hit.mp = tn.mp - tw.mp;
        tw.st.forEach(function(id) { if (id !== death && tn.st.indexOf(id) < 0) hit.rs.push(id); });
        tn.bf.forEach(function(level, i) {
            if (level !== tw.bf[i]) hit.bf.push([i, level - tw.bf[i], tn.bt[i] || 0]);
        });
    }
    if (!hit.d.length && !hit.st.length && !hit.rs.length && !hit.mp && !hit.bf.length && !hit.kill) return;
    hit.n = ++pb.hitsOut;
    $.bSend(pb.foeId, hit);
};

// The other player hit this one (on its PC, with the same rules).
$.guestHandlers.bDuelHit = function(msg) {
    var pb = $.pvpBattle;
    if (!pb || !msg || msg.bid !== pb.bid || (msg.from || 'host') !== pb.foeId) return;
    if (!(msg.n > pb.hitsIn)) return;
    pb.hitsIn = msg.n;
    var me = $.duelMe();
    // (won: the host settled it for this player; a hit still on its way
    // from the other battle does not undo that, nor one after this PC's own
    // battle has ended)
    if (!me || pb.selfDead || pb.won || me.isDead() || !$gameParty.inBattle() ||
            BattleManager._phase === 'battleEnd') return;
    if (msg.kill) {
        $.duelDie('killed');
        return;
    }
    $.duelSyncSelfHp(); // (this PC's own HP changes since the last look first)
    var body = $.duelSelfTorso(pb);
    var torso = 0, headGone = false;
    (msg.d || []).forEach(function(entry) {
        var part = pb.self.parts[entry[0]];
        var dv = Number(entry[1]) || 0;
        if (!part || !dv) return;
        if (part === body) {
            torso += dv;
            return;
        }
        if (part.cut || dv > 0) return;
        part.hp = Math.max(0, part.hp + dv);
        if (part.hp > 0) return;
        part.cut = true;
        part.cutNow = true;
        if (part.kind === 'head') headGone = true;
        else $.battleGab($.pvpCutText(me.name(), part.kind), true);
    });
    if (msg.mp) me.gainMp(msg.mp);
    (msg.st || []).forEach(function(id) { if ($dataStates[id]) $.duelAddState(me, id); });
    (msg.rs || []).forEach(function(id) {
        me.removeState(id);
        if (pb.stunLater) pb.stunLater = pb.stunLater.filter(function(s) { return s !== id; });
    });
    (msg.bf || []).forEach(function(b) {
        for (var n = 0; n < Math.abs(b[1]); n++) {
            if (b[1] > 0) me.addBuff(b[0], b[2] || 1); else me.addDebuff(b[0], b[2] || 1);
        }
    });
    // the body took the hit on its scale; the real HP is its share
    // (100 HP, raw 100 on a leg: 40, body 1000 -> 960, 96 HP)
    if (body) {
        if (torso) body.hp = Math.max(0, Math.min(body.mhp, body.hp + torso));
        var real = $.duelHpOfBody(body.hp, me.mhp, body.mhp);
        if (real !== me.hp) {
            $.duelHpThrough = true;
            try { me.gainHp(real - me.hp); } finally { $.duelHpThrough = false; }
        }
        pb.self.hp = me.hp;
        pb.self.mhp = me.mhp;
    }
    if (headGone || (body && body.hp <= 0) || me.hp <= 0 || me.isDead()) {
        $.duelDie(headGone ? 'head' : 'torso');
        return;
    }
    if ($.refreshBattleStatus) $.refreshBattleStatus();
};

// A state from the other player's hit on this player's character. One that
// stops it acting lasts one turn at most, and waits for the end of its own
// turn if it came in one (added there it would cost that turn and the next:
// FH_ATB finishAtbTurn, as the Talk trick).
$.duelAddState = function(me, id) {
    var pb = $.pvpBattle, state = $dataStates[id];
    if (!state || state.restriction <= 0) {
        me.addState(id);
        return;
    }
    if ($.duelTalkOwnTurn()) {
        pb.stunLater = pb.stunLater || [];
        if (pb.stunLater.indexOf(id) < 0) pb.stunLater.push(id);
        return;
    }
    me.addState(id);
    if (me.isStateAffected(id) && me._stateTurns[id] > 1) me._stateTurns[id] = 1;
};

$.duelStunFrame = function() {
    var pb = $.pvpBattle;
    if (!pb || !pb.stunLater || !pb.stunLater.length) return;
    var me = $.duelMe();
    if (!me || !$.inDuelBattle() || pb.selfDead || pb.won || me.isDead()) {
        pb.stunLater = null;
        return;
    }
    if ($.duelTalkOwnTurn()) return;
    var ids = pb.stunLater;
    pb.stunLater = null;
    ids.forEach(function(id) { $.duelAddState(me, id); });
    if ($.refreshBattleStatus) $.refreshBattleStatus();
};

// A command window still open closes (this player's turn is over). The
// windows themselves too: while one is active the scene never updates the
// battle (it could not end), and OK on it found no actor (a TypeError in
// commandAttack / the battle equipment screen).
$.duelStopInput = function() {
    var bm = BattleManager;
    if (bm._phase !== 'input') return;
    var actor = bm._atbInputActor || bm.actor();
    bm._atbInputActor = null;
    bm._atbActing = null;
    bm._atbInputMemory = null;
    if (actor) actor.clearActions();
    bm.changeActor(-1, 'waiting');
    bm._phase = 'atb';
    $.closeBattleInput();
    var scene = SceneManager._scene;
    if (scene instanceof Scene_Battle) {
        // the battle equipment screen (commandequip)
        [scene._equipCommandWindow, scene._slotWindow, scene._equipItemWindow,
            scene._equipStatusWindow].forEach(function(w) {
            if (w) {
                w.deactivate();
                w.hide();
            }
        });
    }
};

// This player lost: its character falls, the battle ends as a defeat.
$.duelDie = function(why) {
    var pb = $.pvpBattle, me = $.duelMe();
    if (!pb || !me || pb.won) return;
    pb.selfDead = true;
    if (!$gameParty.inBattle()) return;
    $.duelStopInput();
    if (me.isAlive()) me.addState(me.deathStateId());
    me.performCollapse();
    if ($.refreshBattleStatus) $.refreshBattleStatus();
    $.dlog('duel: I lost', pb.bid, why || '');
    $.sendDuelBody();
};

// The other player lost (its PC or the host says so): every part falls.
$.duelWinNow = function(bid) {
    var pb = $.pvpBattle;
    if (!pb || (bid && pb.bid !== bid) || !$gameParty.inBattle()) return;
    $.duelStopInput();
    $.pvpFoeFalls();
};

// ('pvpGone', the 0.38.2 name of this, is gone: nothing sends it, and a
// host with other mod code is turned away at 'hello' - no older host to
// answer.)

// The body ------------------------------------------------------------------

// The other player's body, as its PC streams it, on its parts here.
$.applyDuelFoeBody = function(st) {
    var pb = $.pvpBattle;
    if (!pb || !st || !st.dv || !$gameParty.inBattle()) return;
    var dv = st.dv;
    if (pb.waitFoe) {
        pb.waitFoe = false;
        $.dlog('duel: both battles are up', pb.bid);
        if (pb.toldWait) $.battleGab(pb.foeName + ' is here. Fight!', true);
    }
    var row = (st.a || []).filter(function(r) { return r[0] === dv.id; })[0];
    var members = $gameTroop.members();
    if (row) members.forEach(function(e) { e._fhMirrorGauge = Number(row[4]) || 0; });
    if (dv.dead) {
        $.duelWinNow(pb.bid);
        return;
    }
    if ((dv.ack || 0) < pb.hitsOut) return; // my last hit is not in it yet
    var death = members.length ? members[0].deathStateId() : 1;
    var states = row ? (row[3] || []).filter(function(id) { return id !== death && $dataStates[id]; }) : null;
    var changed = false;
    members.forEach(function(e, i) {
        if (!e._fhPvpFoe || e.isHidden() || e.isDead()) return;
        // its pools as its own PC set them at its start (the copy of its
        // character here may be a step older: another max HP)
        var mx = dv.mx ? Number(dv.mx[i]) : 0;
        if (mx > 0 && e._fhPvpMaxHp !== mx) {
            e._fhPvpMaxHp = mx;
            e._hp = Math.min(e._hp, mx);
            changed = true;
        }
        if (e === pb.ctl) {
            // the body on its scale (an older PC sent -1: its real HP's share)
            var body = dv.hp && dv.hp[i] >= 0 ? Number(dv.hp[i]) :
                row ? $.duelBodyOfHp(Number(row[1]) || 0, pb.foe.mhp, e.mhp) : e._hp;
            e._hp = Math.max(1, Math.min(e.mhp, body || 0));
            if (row) e._mp = Math.max(0, Math.min(e.mmp, Number(row[2]) || 0));
        } else if (dv.cut && dv.cut[i]) {
            // lost on the owner's PC (a hit this PC had not seen fall). A
            // target of the action running here stands to its end (YEP
            // immortal) and falls then, at 0 HP.
            e._hp = 0;
            if (!(e.isImmortal && e.isImmortal())) {
                e.addState(death);
                e.performCollapse();
                $.checkPvpParts(e);
            }
            changed = true;
            return;
        } else if (dv.hp && dv.hp[i] >= 0) {
            e._hp = Math.max(1, Math.min(e.mhp, dv.hp[i]));
        }
        if (states && !$.sameList(e._states, states)) {
            e._states = states.slice();
            states.forEach(function(id) { if (!e._stateTurns[id]) e._stateTurns[id] = 1; });
        }
    });
    if (changed) {
        $.updatePvpHead();
        $.updatePvpAoeBodyRate();
    }
};

var _bStateDuelSide = $.guestHandlers.bState;
$.guestHandlers.bState = function(msg) {
    var pb = $.pvpBattle;
    if (pb && msg && msg.bid === pb.bid && !$.puppet) {
        if ((msg.from || 'host') === pb.foeId) $.applyDuelFoeBody(msg.st);
        return;
    }
    _bStateDuelSide(msg);
};

// Effects -------------------------------------------------------------------

// There 'e' is this player's body, 'a' the other player's character.
$.playDuelFx = function(msg) {
    var pb = $.pvpBattle;
    var target = msg.s === 'e' ? $.duelMe() : msg.s === 'a' ? pb.ctl : null;
    $.fxEcho = true;
    try {
        switch (msg.k) {
        case 'anim':
            if (target) _startAnimation.call(target, msg.a, msg.m, msg.d);
            break;
        case 'pop':
            if (target) {
                target.clearResult();
                // (the other player's own HP numbers - a potion, poison - are
                // its body's already: $.duelGainOwnBody)
                Object.assign(target._result, msg.r);
                $.popupReady(target);
                _startDamagePopup.call(target);
            }
            break;
        case 'perf':
            if (target) $.playPerf(target, msg.f);
            break;
        case 'gab':
            $.battleGab(msg.text, true);
            break;
        case 'plug':
            if (SceneManager._scene && SceneManager._scene._gabWindow) {
                try { _pluginCommand.call(new Game_Interpreter(), msg.c, msg.a || []); } catch (e) {}
            }
            break;
        // 'collapse': a part there is this player's own limb or body; its own
        // battle shows that loss
        }
    } finally {
        $.fxEcho = false;
    }
};

var _bFxDuelSide = $.guestHandlers.bFx;
$.guestHandlers.bFx = function(msg) {
    var pb = $.pvpBattle;
    if (pb && msg && msg.bid === pb.bid && !$.puppet) {
        if ((msg.from || 'host') === pb.foeId && $gameParty.inBattle()) $.playDuelFx(msg);
        return;
    }
    return _bFxDuelSide(msg);
};

// Gauges --------------------------------------------------------------------

// The foe's parts never take a turn here and show the other player's gauge.
var _isAtbReadyDuel = Game_Battler.prototype.isAtbReady;
Game_Battler.prototype.isAtbReady = function() {
    if (this._fhPvpFoe && this.isEnemy()) return false;
    return _isAtbReadyDuel.call(this);
};

var _atbGaugeDuel = Game_Battler.prototype.atbGauge;
Game_Battler.prototype.atbGauge = function() {
    if (this._fhPvpFoe && this.isEnemy()) return this._fhMirrorGauge || 0;
    return _atbGaugeDuel.call(this);
};

// Nothing moves until the other battle is up too.
var _canTickAtbDuel = BattleManager.canTickAtb;
BattleManager.canTickAtb = function() {
    var pb = $.pvpBattle;
    if (pb && pb.waitFoe && !$.puppet) return false;
    return _canTickAtbDuel.call(this);
};

var _sceneBattleUpdateDuelWait = Scene_Battle.prototype.update;
Scene_Battle.prototype.update = function() {
    _sceneBattleUpdateDuelWait.call(this);
    var pb = $.pvpBattle;
    // this player's own HP changes (a potion, poison) go to its duel body
    if (pb && !$.puppet && $gameParty.inBattle() && $.duelSyncSelfHp() && $.refreshBattleStatus) {
        $.refreshBattleStatus();
    }
    // the foe's parts: the head lock follows its legs, a lost foe is all down
    if (pb && !$.puppet && $gameParty.inBattle()) $.duelFoePartsFrame();
    if (pb && pb.waitFoe && !pb.toldWait && !$.puppet &&
            $.clockMs() - (pb.openedAt || 0) >= $.DUEL_WAIT_TELL_AFTER_MS) {
        pb.toldWait = true;
        $.battleGab('Waiting for ' + pb.foeName + '...', true);
    }
};

// Opening late --------------------------------------------------------------

// A duel that waited for a free screen opens through the whole 'pvp' chain
// (a roaming guest's own world, its board, the open report).
$.tryPendingDuel = function() {
    var msg = $.pendingDuel;
    if (!msg || !$.canOpenDuel()) return;
    $.guestHandlers.pvp(msg);
};

$.guestExtras.push(function() { if ($.isGuest()) $.tryPendingDuel(); });
$.worldExtras.push(function() { if ($.isHost()) $.tryPendingDuel(); });

// A duel battle that had not started yet does not start. (One that already
// ended here, on its way back to the map, keeps its report: Scene_Map.start
// sends it.)
$.dropDuelBattle = function() {
    if ($.localBattle && $.localBattle.ended) return;
    $.authBattle = null;
    $.localBattle = null;
    $.pvpBattle = null;
    if (SceneManager.isNextScene && SceneManager.isNextScene(Scene_Battle)) SceneManager.pop();
};

// The host settled the duel (win: this player won; none: it just ends).
$.guestHandlers.pvpEnd = function(msg) {
    msg = msg || {};
    var pend = $.pendingDuel;
    if (pend && (!msg.bid || pend.bid === msg.bid)) $.pendingDuel = null;
    var pb = $.pvpBattle;
    if (!pb || (msg.bid && pb.bid !== msg.bid)) return;
    if (!$gameParty.inBattle()) {
        $.dropDuelBattle();
        return;
    }
    if (msg.win === true) {
        pb.won = true;
        $.duelWinNow(pb.bid);
    } else if (msg.win === false) $.duelDie('the host says so');
    else BattleManager.abort();
};

//=============================================================================
// Ghosts (README 2-4, user decision 2026-10-19: ghost roaming)
//=============================================================================
// A dead player walks around as a ghost: its own character, half see-through
// (others see it faintly too). Walls stop it as they stop anyone; events and
// the living do not (it walks through them). It cannot use ordinary events,
// trade or revive; enemies neither see nor chase it, and it does not vote.
// Doors are the exception. A simple unconditional transfer is taken directly
// without running its page. A door with choices, locks or an opening sequence
// runs its original event on a live map, so the original interaction works.
// A dead guest on a still copy still takes only simple transfers.
// The fog circle (GALV_VisibilityRange) and the player light (Terrax) are
// drawn around the player: they follow the ghost by themselves.
// No jumping to players (user decision 2026-10-19: removed; ghosts walk).
// A door to another map: a dead host's world goes there (as when a living
// host walks there). A dead guest's PC shows that map as a still copy ($.spec:
// a thin client runs no events, so nothing in the world changes); a door back
// to the host's map asks for the host's world.
// Z: a short line to the nearest living player (Q / W: which line).
// Standing near a living player who fights: that fight opens as a view
// without commands until it ends.
// A body stays where a player died (coop data, in the save): the lying sprite.

$.GHOST_OPACITY = 110;
$.GHOST_FIGHT_RANGE = 4;
$.WATCH_FIGHT_ASK_FRAMES = 90; // ask about a nearby fight
$.WATCH_PING_FRAMES = 120;
$.WATCH_LINES = ['is watching you', 'Look out!', 'Over here!', 'Run!', 'Good luck!'];
$.watchLine = 0;
$.spec = null; // dead guest: { m } while it walks a copy of another map

$.isGhostMe = function() {
    if (!$.role) return false;
    if ($.isHost()) return $.isDead('host') && $.sessionActive();
    return $.myState === 'dead' && !$.solo;
};

// A ghost neither starves nor loses its mind (user decision 2026-11-03):
// this PC's hunger common events (HUNGER_of_*: CE124-137, CE426-436, each
// counting a character's hunger down and calling its HUNGER LEVELS) wait,
// and its own character's MP does not go down (the hard mode sanity drop,
// Map EV28 -> CE372 "the party's MP - 1", and every scene's).
$.HUNGER_CE_NAME = /^HUNGER_of_/;
$.isHungerCe = function(id) {
    var ce = $dataCommonEvents && $dataCommonEvents[id];
    if (!ce) return false;
    if (ce._fhHunger === undefined) ce._fhHunger = ce.trigger === 2 && $.HUNGER_CE_NAME.test(ce.name || '');
    return ce._fhHunger;
};
var _commonEventUpdateGhost = Game_CommonEvent.prototype.update;
Game_CommonEvent.prototype.update = function() {
    if ($.isHungerCe(this._commonEventId) && $.isGhostMe()) return;
    _commonEventUpdateGhost.call(this);
};
var _gainMpGhost = Game_Battler.prototype.gainMp;
Game_Battler.prototype.gainMp = function(value) {
    if (value < 0 && !$.ctx && this.isActor() && $.isGhostMe() && $gameParty.members().indexOf(this) >= 0) return;
    _gainMpGhost.call(this, value);
};
$.isWatching = $.isGhostMe;

$.updateGhostLook = function(p) {
    if ($.isGhostMe()) {
        if (p.isTransparent()) p.setTransparent(false);
        if (p.opacity() !== $.GHOST_OPACITY) p.setOpacity($.GHOST_OPACITY);
        p._fhGhost = true;
        // a death flow that ran for the ghost (CE359: menu off, SW202 / SW410
        // on - the run key waits for both off) is undone as a down undoes it
        // (play test 2026-10-31: a ghost had no X and no run)
        if ($.deathFlows.self && !$gameMap.isEventRunning()) $.undoDeathFlow('self', 'a ghost walks on');
        $.updateGhostKeys(p);
    } else if (p._fhGhost) {
        p._fhGhost = false;
        p.setOpacity(255);
    }
};

// The others see it faintly.
var _playerInfoGhost = $.playerInfo;
$.playerInfo = function(id) {
    var info = _playerInfoGhost(id);
    if ($gamePlayer && $gamePlayer._fhGhost) info.o = $.GHOST_OPACITY;
    return info;
};

var _setTargetGhost = $.Game_RemotePlayer.prototype.setTarget;
$.Game_RemotePlayer.prototype.setTarget = function(p) {
    _setTargetGhost.call(this, p);
    var o = p && p.o ? p.o : 255;
    if (this._opacity !== o) this._opacity = o;
};

// Through the living; events and walls as anyone (user decision 2026-10-31:
// walking through events, a ghost never bumped a door that opens on a bump).
var _isCollidedGhost = Game_Player.prototype.isCollidedWithCharacters;
Game_Player.prototype.isCollidedWithCharacters = function(x, y) {
    if (this === $gamePlayer && this._fhGhost) return this.isCollidedWithEvents(x, y);
    return _isCollidedGhost.call(this, x, y);
};

// The events walk through it (play test 2026-10-31: blocked by the ghost, a
// villager's touch page started its fight on it). (Not a stand-in for a
// living guest: it is made from the ghost's player.)
var _isCollidedGhost2 = Game_Player.prototype.isCollided;
Game_Player.prototype.isCollided = function(x, y) {
    if (this._fhGhost && !this._fhRemoteId) return false;
    return _isCollidedGhost2.call(this, x, y);
};

var _canEncounterGhost = Game_Player.prototype.canEncounter;
Game_Player.prototype.canEncounter = function() {
    if (this._fhGhost) return false;
    return _canEncounterGhost.call(this);
};

// Doors ----------------------------------------------------------------------

// A simple door page transfers directly, without running its other commands.
// A door whose move is a choice's answer runs its original event on the live
// map; a lock or an opening sequence takes the ghost straight to its move.
// Still copies only allow simple transfers.
$.GHOST_DOOR_BAD = {};
[101, 102, 103, 104, 105, 125, 126, 127, 128, 129, 301, 302, 303, 311, 312, 313, 314, 315, 316, 317, 318,
    319, 320, 321, 322, 324, 325, 326, 353, 354].forEach(function(code) { $.GHOST_DOOR_BAD[code] = true; });

// The transfer of a page that is only a door, or null.
$.ghostDoorTransfer = function(page) {
    if (!page || !page.list) return null;
    var hit = null, ok = true;
    page.list.forEach(function(cmd) {
        if ($.GHOST_DOOR_BAD[cmd.code]) ok = false;
        if (cmd.code === 201) {
            if (cmd.indent !== 0) ok = false;
            else if (!hit) hit = cmd.parameters;
        }
    });
    return ok && hit ? hit : null;
};

// A door may be in an opening sequence whose current page has no transfer.
// Check the whole event so the ghost can start that page normally.
$.ghostDoorEvent = function(ev) {
    var data = ev && typeof ev.event === 'function' ? ev.event() : ev;
    var pages = data && data.pages ? data.pages : [];
    var hasTransfer = function(page) {
        return page && page.list && page.list.some(function(cmd) { return cmd.code === 201; });
    };
    return pages.some(function(page) {
        return page && page.trigger < 3 && hasTransfer(page);
    }) || (/^lock_target\d*$/i.test(data && data.name || '') && pages.some(hasTransfer));
};

// Everything that moves a player, the ghost uses as anyone (user decision
// 2026-10-31: "every move-related interaction on, the rest off"; play test:
// a lock it walked through, a ladder it skipped and got stuck on, an elevator
// it could not call). An event is about moving when its current page moves
// the player (201, also inside a lock check or a choice), or turns on a
// switch / self switch / sets a variable that brings up a page that does -
// another page of it, or (a switch) another event's autorun page - and so on (Map026
// EV44 the elevator: "Go up" turns SW195 on, its autorun pages SW195 ->
// SW196 -> the move; Map016 EV125 a gate: unlocked SW350, the next press
// SW3132, autorun steps, the move; Map016 EV528 the bakery door: "Use it"
// V2666 2, its autorun pages on V2666, the move; Map041 EV156 the church
// shortcut elevator: SW2967, EV148's autorun asks the floor and moves).
// Not a page that starts a sleep or a fight (outside a choice's answers); an
// answer with a fight is greyed out for the ghost.
$.ghostMovesFrom = function(ev, page) {
    var data = ev && typeof ev.event === 'function' ? ev.event() : null;
    if (!data || !page || !page.list) return false;
    var mapEvents = ($dataMap && $dataMap.events || []).filter(function(e) { return e && e !== data; });
    var seen = [], todo = [{ data: data, page: page }];
    var opens = function(c, sw, vars, self, own) {
        return (c.switch1Valid && sw.indexOf(c.switch1Id) >= 0) || (c.switch2Valid && sw.indexOf(c.switch2Id) >= 0) ||
            (own && c.variableValid && vars.indexOf(c.variableId) >= 0) || (own && c.selfSwitchValid && self.indexOf(c.selfSwitchCh) >= 0);
    };
    while (todo.length) {
        var cur = todo.shift();
        if (seen.indexOf(cur.page) >= 0) continue;
        seen.push(cur.page);
        if (cur.page.list.some(function(cmd) { return cmd.code === 201; })) return true;
        var sw = [], vars = [], self = [];
        cur.page.list.forEach(function(cmd) {
            var p = cmd.parameters, id;
            if (cmd.code === 121 && p[2] === 0) for (id = p[0]; id <= p[1]; id++) sw.push(id);
            if (cmd.code === 122) for (id = p[0]; id <= p[1]; id++) vars.push(id);
            if (cmd.code === 123 && p[1] === 0) self.push(p[0]);
        });
        if (!sw.length && !vars.length && !self.length) continue;
        cur.data.pages.forEach(function(next) {
            if (next && next.conditions && seen.indexOf(next) < 0 && opens(next.conditions, sw, vars, self, true)) {
                todo.push({ data: cur.data, page: next });
            }
        });
        mapEvents.forEach(function(other) {
            other.pages.forEach(function(next) {
                if (next && next.trigger === 3 && next.conditions && seen.indexOf(next) < 0 &&
                        opens(next.conditions, sw, vars, self, false)) {
                    todo.push({ data: other, page: next });
                }
            });
        });
    }
    return false;
};

// A door's page with only its words (Map016 EV301 "Closed until tomorrow."):
// the ghost reads them as anyone; nothing else happens.
$.TEXT_ONLY_CODES = [0, 101, 401, 108, 408, 249, 250];
// (also an elevator not working yet: Map041 EV156 page 0, its other pages
// call it)
$.ghostDoorWords = function(ev, page) {
    if (page.trigger > 2 || !page.list.some(function(cmd) { return cmd.code === 101; }) ||
            !page.list.every(function(cmd) { return $.TEXT_ONLY_CODES.indexOf(cmd.code) >= 0; })) {
        return false;
    }
    if ($.ghostDoorEvent(ev)) return true;
    var data = ev && typeof ev.event === 'function' ? ev.event() : null;
    return !!data && data.pages.some(function(other) {
        return other !== page && other && other.list && $.ghostMovesFrom(ev, other);
    });
};

// What a door the ghost started turns on goes on for it: the next map's
// landing (play test 2026-10-31: the toilet's "Jump in", Map022 EV22, turns
// SW2889 on and moves; Map034 EV2's autorun on SW2889 tints the screen back
// and shows the player - the dead host alone stayed in the black, unseen).
// The switches its door events turned on, a while (real time).
$.GHOST_CHAIN_MS = 60000;
$.ghostDoorSw = {};

var _command121GhostChain = Game_Interpreter.prototype.command121;
Game_Interpreter.prototype.command121 = function() {
    var ev = this._eventId && $gameMap.event(this._eventId), p = this._params;
    if (ev && ev._fhGhostDoor && $gamePlayer._fhGhost && p[2] === 0) {
        for (var id = p[0]; id <= p[1]; id++) $.ghostDoorSw[id] = $.clockMs();
    }
    return _command121GhostChain.call(this);
};

$.ghostChain = function(ev) {
    var page = ev && ev.page && ev.page(), c = page && page.conditions, now = $.clockMs();
    if (!c || page.trigger !== 3) return false;
    var fresh = function(id) { return $.ghostDoorSw[id] && now - $.ghostDoorSw[id] < $.GHOST_CHAIN_MS; };
    return (c.switch1Valid && fresh(c.switch1Id)) || (c.switch2Valid && fresh(c.switch2Id));
};

// A ghost's own way on: a door's page it started, a move-related autorun, an
// autorun one of its doors turned on (that one counts as its door too).
$.ghostWayOn = function(ev) {
    if (!ev || !$gamePlayer._fhGhost) return false;
    if (ev._fhGhostDoor || $.ghostMovePage(ev, ev.page())) return true;
    if ($.ghostChain(ev)) {
        ev._fhGhostDoor = true;
        return true;
    }
    return false;
};

// A fight on the page outside a choice's answers (those are greyed out).
$.pageFightsOutright = function(page) {
    var open = [];
    return page.list.some(function(cmd) {
        open[cmd.indent] = cmd.code;
        if (cmd.code !== 301) return false;
        for (var i = 0; i < cmd.indent; i++) {
            if (open[i] === 402) return false;
        }
        return true;
    });
};

// (kept on the page: the map's data does not change, and the lone ghost's
// map asks it for its autorun events every frame)
$.ghostMovePage = function(ev, page) {
    if (!page || !page.list || page.list.length <= 1) return false;
    if (page._fhGhostMove === undefined) {
        page._fhGhostMove = !($.pageStartsSleep && $.pageStartsSleep(page.list)) && !$.pageFightsOutright(page) &&
            ($.ghostMovesFrom(ev, page) || $.ghostDoorWords(ev, page));
    }
    return page._fhGhostMove;
};

// The answers of a choice with a fight in them (the commands from its 402 to
// the next answer at the same indent).
$.fightAnswers = function(list, at) {
    var out = [], indent = list[at].indent, answer = -1;
    for (var i = at + 1; i < list.length; i++) {
        var cmd = list[i];
        if (cmd.indent === indent) {
            if (cmd.code === 402) answer = cmd.parameters[0];
            else if (cmd.code === 403) answer = -2;
            else break; // (404, the end)
        } else if (cmd.code === 301 && answer >= 0 && out.indexOf(answer) < 0) {
            out.push(answer);
        }
    }
    return out;
};

var _setupChoicesGhost = Game_Interpreter.prototype.setupChoices;
Game_Interpreter.prototype.setupChoices = function(params) {
    _setupChoicesGhost.call(this, params);
    var ev = this._eventId && $gameMap.event(this._eventId);
    if (!ev || !ev._fhGhostDoor || !$gamePlayer._fhGhost || $gamePlayer._fhRemoteId || !$gameMessage.disableChoice) return;
    $.fightAnswers(this._list, this._index).forEach(function(n) { $gameMessage.disableChoice(n, true); });
};

// The player's own switches a door page turns off (the top of a ladder turns
// SW203 CLIMBING and SW410 off as it moves you up: Map011 EV38). The ghost
// skips the page, so these go off as it goes (play test 2026-10-31: a ghost
// crawled on after the ladder). Not the ones it turns on: they start a scene
// the ghost does not play (EV38 SW202 on, SW241 for the tint back).
$.ghostOwnLines = function(page) {
    (page && page.list || []).forEach(function(cmd) {
        if (cmd.code !== 121 || cmd.indent !== 0 || cmd.parameters[2] !== 1 || !$.ghostOwnSwitches(cmd)) return;
        for (var id = cmd.parameters[0]; id <= cmd.parameters[1]; id++) $gameSwitches.setValue(id, false);
    });
};

// A page that only sets the player's own switches (FH_CoopWorld
// CTX_OWN_SWITCHES: the ladder SW203 / SW241, SW202 / SW410, SW4318) with
// the followers, a wait, conditions and comments: a ghost runs it as anyone
// (user decision 2026-10-31: Map020 EV80-85 turn SW203 CLIMBING off at the
// foot of a ladder - a ghost kept climbing). Not world switches, variables
// or self switches: the tiles that set those are also traps and lookouts
// (play test 2026-10-31: a ghost on Map040 set them and the rifle man's
// fixed fight, EV107 p9, started on it). No lines, fights, items or party.
// A move route of the player's own (205 on -1, its 505 lines): the foot of a
// ladder steps it on (play test 2026-10-31: Map011 EV71 - a ghost could not
// climb out of the basement). Its sounds (Map106 EV199: a waterfall's BGS).
// (Map068 EV73 and Map098 EV192 also turn the map's picture layers - the
// world's, not run.)
$.GHOST_SAFE_CODES = {};
[0, 108, 408, 111, 411, 412, 121, 216, 217, 230, 205, 505, 245, 246, 249, 250].forEach(function(code) { $.GHOST_SAFE_CODES[code] = true; });

$.ghostOwnSwitches = function(cmd) {
    var own = $.CTX_OWN_SWITCHES || [];
    for (var id = cmd.parameters[0]; id <= cmd.parameters[1]; id++) {
        if (own.indexOf(id) < 0) return false;
    }
    return true;
};

$.ghostSafePage = function(page) {
    if (!page || !page.list || page.trigger > 2) return false;
    if (page._fhGhostSafe === undefined) {
        page._fhGhostSafe = page.list.length > 1 && page.list.every(function(cmd) {
            return $.GHOST_SAFE_CODES[cmd.code] && (cmd.code !== 121 || $.ghostOwnSwitches(cmd)) &&
                (cmd.code !== 205 || cmd.parameters[0] === -1);
        });
    }
    return page._fhGhostSafe;
};

// A hand-started page that opens the save screen (the God of Fear & Hunger's
// statue, called with a perfect circle: Map014 EV88 p7-9). It is used up
// once it ran, so only the host - who keeps the saves - starts it (guests:
// FH_CoopRoam "Saves are the host's").
$.savePage = function(page) {
    if (!page || !page.list || page.trigger > 2) return false;
    if (page._fhSave === undefined) {
        page._fhSave = page.list.some(function(cmd) {
            if (cmd.code === 352) return true;
            var ce = cmd.code === 117 && $dataCommonEvents[cmd.parameters[0]];
            return !!ce && ce.list.some(function(c) { return c.code === 352; });
        });
    }
    return page._fhSave;
};

// The dead host still saves there (user decision 2026-10-31).
$.ghostSavePage = function(page) {
    return $.isHost() && $.savePage(page);
};

// (its fade: the move's own, black when the page fades out itself first)
$.ghostDoorSpot = function(p, page) {
    var f = p[5] || 0;
    if (f === 2 && page && page.list.some(function(cmd) { return cmd.code === 221; })) f = 0;
    if (p[0] === 0) return { m: p[1], x: p[2], y: p[3], d: p[4] || 0, f: f, door: true };
    return { m: $gameVariables.value(p[1]), x: $gameVariables.value(p[2]), y: $gameVariables.value(p[3]), d: p[4] || 0,
        f: f, door: true };
};

// The endings (FH_CoopRoam): a door no ghost takes - the opened tower door
// (B / C are the winner's alone), a door of an ending map. Its reason, or ''.
$.ghostDoorBarred = $.ghostDoorBarred || function(ev) { return ''; };

$.ghostLogged = {};
$.ghostTryDoor = function(x, y, triggers, normal) {
    var used = false;
    $gameMap.eventsXy(x, y).some(function(ev) {
        var barred = $.ghostDoorBarred(ev);
        if (barred) {
            var bkey = $gameMap.mapId() + '/' + ev.eventId() + '/barred';
            if (!$.ghostLogged[bkey]) {
                $.ghostLogged[bkey] = true;
                $.dlog('ghost: no door here', 'map', $gameMap.mapId(), 'ev' + ev.eventId(), '-', barred);
            }
            return false;
        }
        var page = ev.page();
        if (!page || triggers.indexOf(page.trigger) < 0) return false;
        var t = $.ghostDoorTransfer(page);
        // (as anyone: its choices, its checks, its opening, its own move)
        if (!t && !$.spec && $.ghostMovePage(ev, page) && !$gameMap.isEventRunning() &&
                (normal === undefined || ev.isNormalPriority() === normal)) {
            ev._fhGhostDoor = true;
            ev.start();
            if (ev._starting) {
                used = true;
                $.dlog('ghost door event', 'map', $gameMap.mapId(), 'ev' + ev.eventId(), 'p' + ev._pageIndex);
                return true;
            }
        }
        // (as the engine starts it: its priority on this check, no event running)
        if (!t && ($.ghostSafePage(page) || $.ghostSavePage(page)) &&
                (normal === undefined || ev.isNormalPriority() === normal) &&
                !$gameMap.isEventRunning()) {
            ev.start();
            if (ev._starting) {
                var skey = $gameMap.mapId() + '/' + ev.eventId() + '/' + ev._pageIndex + '/safe';
                if (!$.ghostLogged[skey]) {
                    $.ghostLogged[skey] = true;
                    $.dlog('ghost runs a state page', 'map', $gameMap.mapId(), 'ev' + ev.eventId(), 'p' + ev._pageIndex);
                }
                used = true;
                return true;
            }
        }
        if (!t) {
            var key = $gameMap.mapId() + '/' + ev.eventId() + '/' + ev._pageIndex;
            if (!$.ghostLogged[key]) {
                $.ghostLogged[key] = true;
                $.dlog($.ghostDoorEvent(ev) ? 'ghost: door needs live world' : 'ghost: not a door (or locked)',
                    'map', $gameMap.mapId(), 'ev' + ev.eventId(), 'p' + ev._pageIndex);
            }
            return false;
        }
        used = true;
        $.ghostOwnLines(page);
        $.ghostGo($.ghostDoorSpot(t, page), 'door ev' + ev.eventId());
        return true;
    });
    return used;
};

// The ghost goes to a spot (a door's, a player's).
$.ghostGo = function(spot, why) {
    var p = $gamePlayer;
    if (!spot || !spot.m || p.isTransferring()) return;
    $.dlog('ghost to map', spot.m, spot.x, spot.y, '(' + why + ')');
    var fade = spot.f === undefined ? 0 : spot.f;
    if ($.isHost()) {
        // (a door to another spot of the same map fades too, as for anyone -
        // play test 2026-10-31: Map021 EV44 / 49 cut with no black screen)
        if (spot.m === $gameMap.mapId() && !spot.door) p.locate(spot.x, spot.y);
        else p.reserveTransfer(spot.m, spot.x, spot.y, spot.d || 0, fade);
        return;
    }
    var hostMap = $.hostMapId || $gameMap.mapId();
    if (spot.m === $gameMap.mapId()) {
        p.locate(spot.x, spot.y);
        return;
    }
    if (spot.m === hostMap) {
        // back to the host's world: there at that spot
        $.ghostArrive = { m: spot.m, x: spot.x, y: spot.y, d: spot.d || 2 };
        if ($.conn) $.conn.send({ t: 'needSnap' });
        return;
    }
    // another map: a still copy on this PC; the host no longer draws it
    if (!$.spec && $.conn) {
        var hide = $.playerInfo($.myId);
        hide.tr = 1;
        $.conn.send({ t: 'pos', p: hide });
    }
    $.spec = { m: spot.m };
    p.reserveTransfer(spot.m, spot.x, spot.y, spot.d || 0, fade);
};

var _startMapEventGhost = Game_Player.prototype.startMapEvent;
Game_Player.prototype.startMapEvent = function(x, y, triggers, normal) {
    // (ending A is the host's scene for everyone, also a dead host's: its
    // path on Map143 and the step into Map154 start as a living host's would,
    // FH_CoopRoam $.endingA)
    if (this === $gamePlayer && this._fhGhost && !($.isHost() && $.endingA)) {
        if (!this.isTransferring()) $.ghostTryDoor(x, y, triggers, normal);
        return;
    }
    _startMapEventGhost.call(this, x, y, triggers, normal);
};

// A dead host with nobody alive on its map: no map scene starts for it,
// except an opening sequence started by a ghost at a door, an autorun that
// moves it on (the elevator's ride, Map025 EV3 / EV10: $.ghostMovePage), and
// ending A (everyone's scene, a guest on its way still in a fight of its own).
var _updateGhostDoorSequence = Game_Event.prototype.update;
Game_Event.prototype.update = function() {
    _updateGhostDoorSequence.call(this);
    if (this._fhGhostDoor && this._trigger !== 3 && !$gameMap.isEventRunning()) this._fhGhostDoor = false;
};

var _gameEventStartGhost = Game_Event.prototype.start;
Game_Event.prototype.start = function() {
    if ($.isHost() && this._trigger === 3 && $.isDead('host') && $.sessionActive() && !$gamePlayer._fhRemoteId &&
            !$.endingA && !$.ghostWayOn(this) && !$.activeGuests().some(function(c) { return $.guestOnMap(c) && !$.isDead(c.guestId); })) {
        return;
    }
    _gameEventStartGhost.call(this);
};

// Players --------------------------------------------------------------------

$.watchLabel = function(id) {
    if ($.isHost()) return $.playerLabel(id);
    return $.watchName(id);
};

$.nearestLiving = function(range) {
    var p = $gamePlayer, best = null, bestD = Infinity;
    $.watchable().forEach(function(id) {
        var r = $.remotes[id];
        if (!r) return;
        var d = Math.abs(r.x - p.x) + Math.abs(r.y - p.y);
        if (d < bestD && (range === undefined || d <= range)) {
            best = id;
            bestD = d;
        }
    });
    return best;
};

$.updateGhostKeys = function(p) {
    if (!(SceneManager._scene instanceof Scene_Map) || $gameMessage.isBusy() || p.isTransferring()) return;
    if (Input.isTriggered('pageup')) $.watchLine = ($.watchLine + $.WATCH_LINES.length - 1) % $.WATCH_LINES.length;
    if (Input.isTriggered('pagedown')) $.watchLine = ($.watchLine + 1) % $.WATCH_LINES.length;
};

// Z with no door in front: the line to the nearest living player.
var _triggerButtonActionGhost = Game_Player.prototype.triggerButtonAction;
Game_Player.prototype.triggerButtonAction = function() {
    var used = _triggerButtonActionGhost.call(this);
    if (used || !this._fhGhost || !Input.isTriggered('ok') || this.isTransferring()) return used;
    $.sendGhostPing();
    return true;
};

$.sendGhostPing = function() {
    var now = Graphics.frameCount;
    if ($.lastWatchPing && now - $.lastWatchPing < $.WATCH_PING_FRAMES) return;
    var to = $.nearestLiving() || ($.watchable().indexOf($.watchId) >= 0 ? $.watchId : null);
    if (!to) return;
    $.lastWatchPing = now;
    if ($.isHost()) $.deliverWatchPing('host', to, $.watchLine);
    else if ($.conn) $.conn.send({ t: 'watchPing', to: to, k: $.watchLine });
    $.toast('Co-op: to ' + $.watchLabel(to) + ' - ' + $.WATCH_LINES[$.watchLine]);
};

// Dead guest: another map as a still copy ------------------------------------

var _applyStateSpec = $.applyState;
$.applyState = function(msg) {
    if ($.spec && msg) {
        if (msg.mapId) $.hostMapId = msg.hm || msg.mapId;
        if ($gameMap && !$.pendingSnapshot && !SceneManager.isSceneChanging()) $.applyPlayers(msg.pl, msg.mapId);
        return;
    }
    _applyStateSpec(msg);
};

var _guestSyncSpec = $.guestSync;
$.guestSync = function() {
    if ($.spec) return; // not on the host's map
    _guestSyncSpec();
};

var _gameMapSetupSpec = Game_Map.prototype.setup;
Game_Map.prototype.setup = function(mapId) {
    if (!$.spec || !$.isThin()) return _gameMapSetupSpec.call(this, mapId);
    var was = $.buildingEvents;
    $.buildingEvents = true; // the events as the world has them
    try {
        _gameMapSetupSpec.call(this, mapId);
    } finally {
        $.buildingEvents = was;
    }
};

$.ghostArrive = null; // dead guest: where it goes once the host's world is here
var _processPendingSnapshotSpec = $.processPendingSnapshot;
$.processPendingSnapshot = function() {
    var had = !!$.pendingSnapshot;
    if (had) $.spec = null; // back on the host's map
    _processPendingSnapshotSpec();
    var a = $.ghostArrive;
    if (had && a) {
        $.ghostArrive = null;
        if ($gameMap && $gameMap.mapId() === a.m && $gamePlayer) {
            $gamePlayer.locate(a.x, a.y);
            if (a.d) $gamePlayer.setDirection(a.d);
        }
    }
};

// Fights ---------------------------------------------------------------------

$.fightOfPlayer = function(id) {
    var found = null;
    Object.keys($.battles).forEach(function(k) {
        var b = $.battles[k];
        if (!found && b && (b.owner === id || (b.joiners || []).indexOf(id) >= 0)) found = b;
    });
    return found;
};

// Host: the ghost asks about the fight of a player near it.
$.requestWatchFight = function(watcherId, targetId) {
    var b = $.fightOfPlayer(targetId);
    if (!b || b.owner === watcherId || (b.joiners || []).indexOf(watcherId) >= 0) return;
    $.bSend(b.owner, { t: 'bWatch', bid: b.bid, wid: watcherId });
};

$.hostHandlers.watchFight = function(conn, msg) {
    if (!msg || !$.isDead(conn.guestId)) return;
    $.requestWatchFight(conn.guestId, msg.id);
};

// The host keeps who watches which fight too: the list of the fight's PC is
// gone with it when that player drops. A fight carried on by another player
// gets its watchers; a fight whose record goes (however it ended) sends them
// its end (flow tests E-1: the ghost stayed in the battle view for good).
$.watching = {}; // host: watcher id -> { bid, owner }
var _requestWatchFightHost = $.requestWatchFight;
$.requestWatchFight = function(watcherId, targetId) {
    var b = $.fightOfPlayer(targetId);
    _requestWatchFightHost(watcherId, targetId);
    if (b && b.owner !== watcherId && (b.joiners || []).indexOf(watcherId) < 0) {
        $.watching[watcherId] = { bid: b.bid, owner: b.owner };
    }
};

$.WATCH_CHECK_EVERY = 10;
$.watchingCheck = function() {
    if (!$.isHost() || Graphics.frameCount % $.WATCH_CHECK_EVERY !== 0) return;
    Object.keys($.watching).forEach(function(wid) {
        var w = $.watching[wid], b = $.battles[w.bid];
        if (wid !== 'host' && !$.clientById(wid)) {
            delete $.watching[wid];
            return;
        }
        if (!b) {
            delete $.watching[wid];
            $.bSend(wid, { t: 'bEnd', bid: w.bid, r: 1, me: null }); // (one that saw the end already ignores it)
            return;
        }
        if (b.owner === w.owner) return;
        w.owner = b.owner;
        $.dlog('battle', w.bid, 'carried on by', $.playerLabel(b.owner), '- its watcher', $.playerLabel(wid), 'goes along');
        if (b.owner === 'host') $.guestHandlers.bWatchAdd({ bid: w.bid, wid: wid });
        else $.bSend(b.owner, { t: 'bWatchAdd', bid: w.bid, wid: wid });
        $.bSend(wid, { t: 'bWatchOwner', bid: w.bid, owner: b.owner });
    });
};
// (a load drops the fights: their watchers get the end through the check)
$.worldExtras.push(function() { $.watchingCheck(); });

// A watcher that left the view (back to its map) is not one any more: a
// carried-on fight must not pull it back in.
$.watchLeft = function(wid, bid) {
    var w = $.watching[wid];
    if (w && w.bid === bid) delete $.watching[wid];
};
var _bRelayWatching = $.hostHandlers.bRelay;
$.hostHandlers.bRelay = function(conn, msg) {
    if (msg && msg.m && msg.m.t === 'bLeave') $.watchLeft(conn.guestId, msg.m.bid);
    return _bRelayWatching(conn, msg);
};
var _bSendWatching = $.bSend;
$.bSend = function(to, msg) {
    if ($.isHost() && msg && msg.t === 'bLeave' && !msg.from) $.watchLeft('host', msg.bid);
    return _bSendWatching(to, msg);
};

// The fight's new PC: one more watcher of its fight (it has the view already).
$.guestHandlers.bWatchAdd = function(msg) {
    var ab = $.authBattle;
    if (!ab || !msg || ab.bid !== msg.bid || $.puppet || !msg.wid) return;
    ab.watchers = ab.watchers || [];
    if (ab.watchers.indexOf(msg.wid) < 0) ab.watchers.push(msg.wid);
};

// The watcher: its view's fight runs on another PC now.
$.guestHandlers.bWatchOwner = function(msg) {
    var p = $.puppet;
    if (p && p.spec && msg && msg.bid === p.bid && msg.owner) p.owner = msg.owner;
};

// The fight's PC: send the view, keep the watcher in the stream.
$.guestHandlers.bWatch = function(msg) {
    var ab = $.authBattle;
    if (!ab || ab.bid !== msg.bid || !$gameParty.inBattle() || $.puppet || !msg.wid) return;
    ab.watchers = ab.watchers || [];
    if (ab.watchers.indexOf(msg.wid) < 0) ab.watchers.push(msg.wid);
    $.dlog('battle', ab.bid, 'watched by', msg.wid);
    $.bSend(msg.wid, Object.assign($.battleViewMessage(), { spec: true }));
};

var _battleViewersSpec = $.battleViewers;
$.battleViewers = function() {
    var list = _battleViewersSpec();
    var ab = $.authBattle;
    (ab && ab.watchers || []).forEach(function(id) { if (list.indexOf(id) < 0) list = list.concat([id]); });
    return list;
};

var _broadcastPartySpec = $.broadcastParty;
$.broadcastParty = function(except) {
    _broadcastPartySpec(except);
    var ab = $.authBattle;
    if (!ab || !ab.watchers || !ab.watchers.length) return;
    var view = $.battleViewMessage();
    ab.watchers.forEach(function(id) {
        if (id !== except) $.bSend(id, { t: 'bParty', bid: view.bid, actors: view.actors });
    });
};

var _endAuthBattleSpec = $.endAuthBattle;
$.endAuthBattle = function(result) {
    var ab = $.authBattle;
    var watchers = ab && ab.watchers ? ab.watchers.slice() : [];
    _endAuthBattleSpec(result);
    watchers.forEach(function(id) { $.bSend(id, { t: 'bEnd', bid: ab.bid, r: result, me: null }); });
};

var _bLeaveSpec = $.guestHandlers.bLeave;
$.guestHandlers.bLeave = function(msg) {
    var ab = $.authBattle;
    var from = msg.from || 'host';
    if (ab && ab.bid === msg.bid && ab.watchers && ab.watchers.indexOf(from) >= 0) {
        ab.watchers = ab.watchers.filter(function(id) { return id !== from; });
        return;
    }
    _bLeaveSpec(msg);
};

// The ghost's PC: a view without commands. The characters in it are the
// fight's copies: this PC's own copies come back afterwards.
$.specKeep = function(ids) {
    var p = $.puppet;
    if (!p || !p.spec) return;
    p.kept = p.kept || {};
    ids.forEach(function(id) {
        if (!(id in p.kept)) p.kept[id] = $gameActors._data[id];
    });
};

var _bViewSpec = $.guestHandlers.bView;
$.guestHandlers.bView = function(msg) {
    if (!msg || !msg.spec) return _bViewSpec(msg);
    if ($.puppet || $gameParty.inBattle() || !(SceneManager._scene instanceof Scene_Map) ||
            SceneManager.isSceneChanging()) {
        $.bSend(msg.owner, { t: 'bLeave', bid: msg.bid });
        return;
    }
    var keep = {};
    (msg.actors || []).forEach(function(e) { keep[e.id] = $gameActors._data[e.id]; });
    _bViewSpec(msg);
    if ($.puppet) {
        $.puppet.spec = true;
        $.puppet.kept = keep;
        $.dlog('watching the fight', msg.bid);
    }
};

var _bPartySpec = $.guestHandlers.bParty;
$.guestHandlers.bParty = function(msg) {
    if ($.puppet && $.puppet.spec && msg && msg.bid === $.puppet.bid) {
        $.specKeep((msg.actors || []).map(function(e) { return e.id; }));
    }
    _bPartySpec(msg);
};

var _bEndSpec = $.guestHandlers.bEnd;
$.guestHandlers.bEnd = function(msg) {
    var p = $.puppet;
    var spec = !!p && p.spec && msg && msg.bid === p.bid;
    _bEndSpec(msg);
    if (!spec) return;
    Object.keys(p.kept || {}).forEach(function(id) {
        if (p.kept[id]) $gameActors._data[id] = p.kept[id];
    });
    if ($gamePlayer) $gamePlayer.refresh();
    $.lastWatchFightAsk = Graphics.frameCount; // not straight back into it
};

$.askWatchFight = function() {
    if (!$.isGhostMe() || $.puppet || !(SceneManager._scene instanceof Scene_Map) || SceneManager.isSceneChanging()) return;
    var now = Graphics.frameCount;
    if ($.lastWatchFightAsk && now - $.lastWatchFightAsk < $.WATCH_FIGHT_ASK_FRAMES) return;
    $.lastWatchFightAsk = now;
    var id = $.nearestLiving($.GHOST_FIGHT_RANGE);
    if (!id) return;
    if ($.isHost()) $.requestWatchFight('host', id);
    else if ($.conn && !$.spec) $.conn.send({ t: 'watchFight', id: id });
};

$.worldExtras.push(function() { if ($.isHost()) $.askWatchFight(); });
$.guestExtras.push(function() { if ($.isGuest()) $.askWatchFight(); });

// Pings ----------------------------------------------------------------------

$.watchPingText = function(fromName, k) {
    var line = $.WATCH_LINES[k] || $.WATCH_LINES[0];
    return k ? fromName + ': ' + line : fromName + ' ' + line;
};

$.deliverWatchPing = function(fromId, to, k) {
    if (!to || to === fromId) return;
    var text = 'Co-op: ' + $.watchPingText($.playerLabel(fromId), Number(k) || 0);
    $.dlog('ping', $.playerLabel(fromId), '->', $.playerLabel(to), k);
    if (to === 'host') $.toast(text);
    else $.sendTo(to, { t: 'toast', text: text });
};

$.hostHandlers.watchPing = function(conn, msg) {
    if (!msg || !$.isDead(conn.guestId)) return;
    $.deliverWatchPing(conn.guestId, msg.to, msg.k);
};

// Guests' interactions on the host: never from a ghost.
$.actHooks.unshift(function(conn) { return $.isDead(conn.guestId); });

// The hint (always on while a ghost) -----------------------------------------

$.watchHintText = function() {
    if (!$.isGhostMe()) return '';
    var scene = SceneManager._scene;
    var inFight = $.puppet && $.puppet.spec && scene instanceof Scene_Battle;
    if (!(scene instanceof Scene_Map) && !inFight) return '';
    if (inFight) return 'Ghost: watching a fight';
    var near = $.nearestLiving();
    var text = 'Ghost' + (near ? ' (near ' + $.watchLabel(near) + ')' : '');
    return text + '   Z: ping "' + $.WATCH_LINES[$.watchLine] + '"   Q/W: line';
};

$.updateWatchHint = function() {
    var text = $.watchHintText();
    if (text === $.lastWatchHint) return;
    $.lastWatchHint = text;
    var el = document.getElementById('fhcoop-watch');
    if (!el) {
        if (!text) return;
        el = document.createElement('div');
        el.id = 'fhcoop-watch';
        el.style.cssText = 'position:fixed;bottom:10px;left:50%;transform:translateX(-50%);z-index:101;' +
            'font:14px sans-serif;color:#fff;background:rgba(0,0,0,0.6);padding:4px 12px;' +
            'border-radius:3px;pointer-events:none;white-space:nowrap;';
        document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.display = text ? 'block' : 'none';
};

var _updateSceneWatchHint = SceneManager.updateScene;
SceneManager.updateScene = function() {
    _updateSceneWatchHint.call(this);
    try {
        $.updateWatchHint();
    } catch (e) {
        $.lastWatchHint = null;
    }
};

// Bodies ---------------------------------------------------------------------

// The list lives in $gameSystem, which a guest swaps whole for a snapshot
// or a roam start. A list sent while one was on its way (a dying roaming
// guest gets the snapshot that brings it back first, then its own body) was
// written into the world about to go. So a guest keeps the newest list it
// got and puts it back over an older one; the host stamps each list (its
// clock, rising) and stamps the world again on a load, so a list from
// before a load never comes back.
$.corpsesMsg = null; // guest: { list, stamp }

$.corpseStamp = function() {
    $.lastCorpseStamp = Math.max(Date.now(), ($.lastCorpseStamp || 0) + 1);
    return $.lastCorpseStamp;
};

$.corpses = function() {
    var d = $.coopData();
    if (!d.corpses) d.corpses = [];
    var kept = $.corpsesMsg;
    if (kept && !$.isHost() && (d.corpsesStamp || 0) < kept.stamp) {
        d.corpses = kept.list.slice();
        d.corpsesStamp = kept.stamp;
    }
    return d.corpses;
};

// The characters that died in a duel (actor id -> true; their bodies have
// the contestant's menu).
$.duelDead = function() {
    var d = $.coopData();
    d.duelDead = d.duelDead || {};
    return d.duelDead;
};

// A body: its character, where, its number, what kind ('duel' / 'plain') and
// its map event id (FH_CoopRoam: the same on every PC; none in old saves:
// those stay a picture).
$.addCorpse = function(actorId, m, x, y) {
    if (!actorId || !m) return;
    var list = $.corpses();
    var d = $.coopData();
    d.corpseN = (d.corpseN || 0) + 1;
    var rec = { a: actorId, m: m, x: x, y: y, n: d.corpseN, kind: $.duelDead()[actorId] ? 'duel' : 'plain' };
    if ($.bodyNewId) rec.id = $.bodyNewId(m);
    list.push(rec);
    var stamp = $.coopData().corpsesStamp = $.corpseStamp();
    $.dlog('body of', $dataActors[actorId] ? $dataActors[actorId].name : actorId, 'left on map', m, x, y);
    $.clients.forEach(function(c) { c.send({ t: 'corpses', list: list, stamp: stamp }); });
    if ($.bodyPlaceAll) $.bodyPlaceAll();
};

$.guestHandlers.corpses = function(msg) {
    var list = (msg && msg.list) || [];
    $.corpsesMsg = { list: list.slice(), stamp: Number(msg && msg.stamp) || 0 };
    if (!$gameSystem) return;
    $.coopData().corpses = list;
    $.coopData().corpsesStamp = $.corpsesMsg.stamp;
    if ($.bodyPlaceAll) $.bodyPlaceAll();
};

// Host: a loaded world is newer than any list a guest still keeps.
var _onLoadSuccessBodies = Scene_Load.prototype.onLoadSuccess;
Scene_Load.prototype.onLoadSuccess = function() {
    if ($.isHost()) $.coopData().corpsesStamp = $.corpseStamp();
    _onLoadSuccessBodies.call(this);
};

// Host: a world that never had a body (a new game) is stamped as well.
var _snapshotDataBodies = $.snapshotData;
$.snapshotData = function() {
    if ($.isHost() && $gameSystem && !$.coopData().corpsesStamp) $.coopData().corpsesStamp = $.corpseStamp();
    return _snapshotDataBodies.apply(this, arguments);
};

var _leaveAsGuestBodies = $.leaveAsGuest;
$.leaveAsGuest = function(message) {
    $.corpsesMsg = null; // (another host's clock next time)
    return _leaveAsGuestBodies.apply(this, arguments);
};

$.corpsesHere = function() {
    var m = $gameMap ? $gameMap.mapId() : 0;
    return $.corpses().filter(function(c) { return c.m === m; });
};

var _hostDeadWatchBody = $.hostDeadWatch;
$.hostDeadWatch = function() {
    _hostDeadWatchBody();
    $.addCorpse($.hostActorId(), $gameMap.mapId(), $gamePlayer.x, $gamePlayer.y);
};

var _killPlayerBody = $.killPlayer;
$.killPlayer = function(id, why) {
    var conn = $.clientById(id);
    var p = conn && conn.lastPos ? Object.assign({}, conn.lastPos) : null;
    var wasDead = !!conn && $.isDead(id);
    _killPlayerBody(id, why);
    if (!conn || wasDead || !$.isDead(id) || !p) return;
    $.addCorpse(conn.actorId, p.m || $gameMap.mapId(), p.x, p.y);
};

// Drawn as characters of their own (not events: nothing runs, nothing is
// saved but the list).
function Game_FHCorpse(c) {
    this.initialize(c);
}
Game_FHCorpse.prototype = Object.create(Game_CharacterBase.prototype);
Game_FHCorpse.prototype.constructor = Game_FHCorpse;
Game_FHCorpse.prototype.initialize = function(c) {
    Game_CharacterBase.prototype.initialize.call(this);
    this.setImage($.DOWN_GRAPHIC[c.a] || '', $.DOWN_INDEX);
    this.setPosition(c.x, c.y);
    this.setDirection(2);
    this._priorityType = 0;
    this._stepAnime = false;
    this._walkAnime = false;
    this._pattern = 1;
};
$.Game_FHCorpse = Game_FHCorpse;

var _spritesetMapUpdateBodies = Spriteset_Map.prototype.update;
Spriteset_Map.prototype.update = function() {
    _spritesetMapUpdateBodies.call(this);
    if (!$.role || !this._tilemap || !$gameMap) return;
    var here = $.corpsesHere();
    var key = $gameMap.mapId() + ':' + JSON.stringify(here);
    if (key === this._fhBodyKey) return;
    this._fhBodyKey = key;
    var map = this._tilemap;
    (this._fhBodySprites || []).forEach(function(s) { map.removeChild(s); });
    // (a body that is a map event draws itself: FH_CoopRoam)
    this._fhBodySprites = here.filter(function(c) { return !c.id && !!$.DOWN_GRAPHIC[c.a]; }).map(function(c) {
        var s = new Sprite_Character(new Game_FHCorpse(c));
        map.addChild(s);
        return s;
    });
};

//=============================================================================
// Deaths for good (user decision 2026-10-19): no down, no revive
//=============================================================================
// These kill the player at once, even with HP left; the others play on and
// the dead one walks as a ghost (or the game is over, as for any death):
// - Beheading: state 31 Headless on a player's character (skills 307
//   Guillotine swing, 618 Helm splitter, 743 / 814 Peck, 759 Gentle
//   beheading). CE240-245 show it, then take the state off again: the
//   character is marked (_fhDoom = 'headless') and falls in the fight.
// - Game overs in: starvation (CE125-129, 132, 133, 426, 428, 430), the
//   Necronomicon (CE3), the ritual circle refusing (CE48, 71, 72, 201, 233),
//   spontaneous combustion (CE490), the Eye of Rher (the moonscorched scene
//   CE536 takes the player to: map 141, map 132 with SW1292 on), the
//   flamethrower's burn in the White bunker (a page on V868 burn), a mine
//   (Map039/060/156 "mine": its burst, then a page that ends the game).
// - Rher's SANITY LOST (troop 219 page 13): whoever lost that coin toss.
// - SNAP NECK (Chaugnar troop 20, Poe troop 210): whoever lost that toss.
// The mark goes with the character (actorJson) to the host, and the
// roamDown / subDown reports carry it too. On the host a defeat of a marked
// player ($.onPlayerDefeated) is a death: a guest dies (killPlayer), the host
// dies (hostDies: a ghost while others live, else the game is over). Revive
// refuses it. Also: a guard-break coin toss's punishment (339, e.g. the
// Guillotine swing) hits the one who lost the toss, not a random player.

$.HEADLESS_STATE = 31;
$.DOOM_TEXT = {
    headless: 'lost their head',
    sanity: 'lost their mind',
    moonscorch: 'was moonscorched by Rher',
    starve: 'starved to death',
    necro: 'lost their mind to the Necronomicon',
    ritual: 'was struck down by the gods',
    combust: 'burst into flames',
    mold: 'became part of the sleeping house',
    burn: 'burned to death',
    mine: 'stepped on a mine',
    snap: 'had their neck snapped'
};
// The white mold apartment's beds (Map071 EV194/195/199/200, Map075): "Rest"
// sets V1013 apartment_bed_activate, and the autorun pages counting on it end
// in "You became a permanent part of the sleeping house." and a game over
// (Map071 EV173 p2, Map075 EV222 p2). A death, not a down. Found by that
// condition, not by map and event ids.
$.MOLD_BED_VAR = 1013;
$.DOOM_CES = {
    3: 'necro', 48: 'ritual', 71: 'ritual', 72: 'ritual', 201: 'ritual', 233: 'ritual', 490: 'combust',
    125: 'starve', 126: 'starve', 127: 'starve', 128: 'starve', 129: 'starve', 132: 'starve', 133: 'starve',
    426: 'starve', 428: 'starve', 430: 'starve'
};
$.MOONSCORCH_MAP = 141;        // CE536 MOONSCORCHED: the scene (EV6 ends in a game over)
$.MOONSCORCH_DAAN_MAP = 132;   // Daan's (Pocketcat), when SW1292 is on
$.MOONSCORCHED_SWITCH = 1292;
$.TIME_UP_SWITCH = 1507;       // TIME_UP: the third day is over

$.doomOf = function(actor) {
    var doom = actor && actor._fhDoom;
    return doom && $.DOOM_TEXT[doom] ? doom : '';
};

// Players' characters in a shared game (not the tutorial, not a duel).
$.doomCounts = function(actor) {
    return !!$.role && !!actor && !!actor.isActor && actor.isActor() && $.PLAYABLE.indexOf(actor.actorId()) >= 0 &&
        !$.puppet && !$.pvpBattle && $.coopNoLose();
};

$.markDoom = function(actor, doom) {
    if (!actor || !$.DOOM_TEXT[doom] || actor._fhDoom) return;
    actor._fhDoom = doom;
    $.dlog('dies for good:', actor.name(), doom);
};

// Host: that player's death.
$.doomDies = function(id, doom) {
    delete $.downs[id];
    var why = $.DOOM_TEXT[doom] || 'died';
    if (id === 'host') {
        $.dlog('host dies for good:', doom);
        $.broadcastToast($.playerLabel('host') + ' ' + why + '.');
        $.hostDies();
        return;
    }
    $.killPlayer(id, why);
};

$.ownActor = function() {
    return $gameActors.actor($.isHost() ? $.hostActorId() : $.myActorId);
};

// This PC runs a co-op fight (not a duel, not a view of someone else's).
$.coopBattleHere = function() {
    return !!$.role && $gameParty.inBattle() && !$.puppet && !!$.authBattle && !$.authBattle.pvp;
};

// The character falls in the fight, HP left or not (a death resistance does
// not hold it either).
$.doomFall = function(actor) {
    if (!actor || actor.isDead()) return;
    actor.addNewState(actor.deathStateId());
    actor.refresh();
    if ($gameParty.inBattle()) {
        actor.performCollapse();
        $.refreshBattleStatus();
    }
};

// Beheading ------------------------------------------------------------------

var _addStateDoom = Game_Battler.prototype.addState;
Game_Battler.prototype.addState = function(stateId) {
    _addStateDoom.call(this, stateId);
    if (stateId === $.HEADLESS_STATE && this.isActor() && this.isStateAffected(stateId) && $.doomCounts(this)) {
        $.markDoom(this, 'headless');
    }
};

// The damage comes before the state: one the hit itself kills never gets
// Headless (a dead battler takes no state), e.g. 150 of Gentle beheading on
// 100 HP. Killed by a skill that beheads, and the state not resisted, is
// beheaded too.
$.beheads = function(item) {
    return !!item && (item.effects || []).some(function(e) {
        return e.code === Game_Action.EFFECT_ADD_STATE && e.dataId === $.HEADLESS_STATE;
    });
};

// Its chance to behead (Helm splitter: 95 %), as the state would have had.
$.beheadChance = function(item) {
    var e = item && (item.effects || []).filter(function(f) {
        return f.code === Game_Action.EFFECT_ADD_STATE && f.dataId === $.HEADLESS_STATE;
    })[0];
    return e ? Number(e.value1) || 0 : 0;
};

var _applyDoom = Game_Action.prototype.apply;
Game_Action.prototype.apply = function(target) {
    var check = !!target && target.isActor() && target.isAlive() && $.beheads(this.item());
    _applyDoom.call(this, target);
    var chance = check ? $.beheadChance(this.item()) : 0;
    if (check && target.isDead() && target.result().isHit() && !target.isStateResist($.HEADLESS_STATE) &&
            target.stateRate($.HEADLESS_STATE) > 0 && (chance >= 1 || Math.random() < chance) &&
            $.doomCounts(target)) {
        $.markDoom(target, 'headless');
    }
};

// CE240-245 take the state off after the picture and the message: it falls.
var _removeStateDoom = Game_Battler.prototype.removeState;
Game_Battler.prototype.removeState = function(stateId) {
    _removeStateDoom.call(this, stateId);
    if (stateId === $.HEADLESS_STATE && this.isActor() && $.doomOf(this) && this.isAlive() &&
            $gameParty.inBattle() && !$.puppet) {
        $.doomFall(this);
    }
};

// One that is still up when nothing runs any more (a skill without the
// common event): it falls now.
$.doomSweepFight = function() {
    if (!$.role || !$gameParty.inBattle() || $.puppet || $gameTroop.isEventRunning() ||
            $gameTemp.isCommonEventReserved() || BattleManager._subject) return;
    $gameParty.battleMembers().forEach(function(a) {
        if ($.doomOf(a) && a.isAlive()) $.doomFall(a);
    });
};

var _battleManagerUpdateDoom = BattleManager.update;
BattleManager.update = function() {
    _battleManagerUpdateDoom.call(this);
    if (!$.puppet) $.doomSweepFight();
};

// Host: a marked player that nothing put down yet (a fight the others won
// while it lay there, a report that never came): it dies now.
$.doomSweepWorld = function() {
    if (!$.isHost() || !$.sessionActive() || $gameParty.inBattle()) return;
    ['host'].concat($.clients.map(function(c) { return c.guestId; })).forEach(function(id) {
        var c = id === 'host' ? null : $.clientById(id);
        if (c && (c.solo || c.inBattle || !c.actorId)) return;
        if ($.isDead(id) || !$.doomOf($.actorOfPlayer(id))) return;
        $.onPlayerDefeated(id);
    });
};

$.worldExtras.push(function() {
    if (Graphics.frameCount % 30 === 0) $.doomSweepWorld();
});

// A guest running its own map: its own defeat (roamDown carries the mark).
$.guestExtras.push(function() {
    if (!$.isGuest() || !$.isRoaming || !$.isRoaming() || $.myState || $gameParty.inBattle() || $.puppet ||
            $.localBattle || Graphics.frameCount % 30 !== 0) return;
    if ($.doomOf($gameActors.actor($.myActorId)) && $.roamDefeated) $.roamDefeated();
});

// Game overs that are deaths -------------------------------------------------

$.doomLists = null; // [[list, doom]] of the common events above

$.doomOfList = function(list) {
    if (!list || !$dataCommonEvents) return '';
    if (!$.doomLists || $.doomLists.data !== $dataCommonEvents) {
        $.doomLists = [];
        $.doomLists.data = $dataCommonEvents;
        Object.keys($.DOOM_CES).forEach(function(id) {
            var ce = $dataCommonEvents[Number(id)];
            if (ce && ce.list) $.doomLists.push([ce.list, $.DOOM_CES[id]]);
        });
    }
    for (var i = 0; i < $.doomLists.length; i++) {
        if ($.doomLists[i][0] === list) return $.doomLists[i][1];
    }
    // a copy of one (an event run handed over between PCs comes as JSON, maybe
    // from a PC with other texts, e.g. the Korean patch): the same commands
    for (var k = 0; k < $.doomLists.length; k++) {
        if ($.sameListShape($.doomLists[k][0], list)) return $.doomLists[k][1];
    }
    return '';
};

// Same command codes and indents, in the same order (texts may differ).
$.sameListShape = function(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
        if (!a[i] || !b[i] || a[i].code !== b[i].code || a[i].indent !== b[i].indent) return false;
    }
    return true;
};

$.doomOf353 = function(interp) {
    if ($gameParty.inBattle()) {
        // a game over right in a coin toss page: that toss was lost
        return interp === $gameTroop._interpreter && interp._fhToss ? 'sanity' : '';
    }
    var doom = $.doomOfList(interp._list);
    if (doom) return doom;
    if ($.isMoldBedList(interp._list)) return 'mold';
    if ($.isFlameBurnList(interp._list)) return 'burn';
    if ($.isMineList(interp._list)) return 'mine';
    if ($.snapRun) {
        var snapped = $.doomActorFor(interp);
        if (snapped && snapped.actorId() === $.snapRun) return 'snap';
    }
    var mapId = $gameMap ? $gameMap.mapId() : 0;
    // (map 132 also after the third day: waking with SW1507 TIME_UP sends
    // only Daan there, without SW1292 - final review D B4)
    if (mapId === $.MOONSCORCH_MAP ||
            (mapId === $.MOONSCORCH_DAAN_MAP && ($gameSwitches.value($.MOONSCORCHED_SWITCH) ||
            $gameSwitches.value($.TIME_UP_SWITCH)))) return 'moonscorch';
    return '';
};

// A page of this map that waits for the white mold bed (V1013) and ends the game.
$.isMoldBedList = function(list) {
    if (!list || !$dataMap || !$dataMap.events) return false;
    return $dataMap.events.some(function(ev) {
        return !!ev && ev.pages.some(function(p) {
            return p.list === list && p.conditions.variableValid && p.conditions.variableId === $.MOLD_BED_VAR &&
                list.some(function(c) { return c.code === 353; });
        });
    });
};

// The flamethrower's burn (Map127 / Map134 EV221 page 1, on V868 burn): the
// fire does not go out in the original - a death, not a down (user decision
// 2026-11-03). Found by its condition, not by map and event ids.
$.FLAME_BURN_VAR = 868;
$.isFlameBurnList = function(list) {
    if (!list || !$dataMap || !$dataMap.events) return false;
    return $dataMap.events.some(function(ev) {
        return !!ev && ev.pages.some(function(p) {
            return p.list === list && p.trigger === 4 && p.conditions.variableValid &&
                p.conditions.variableId === $.FLAME_BURN_VAR && list.some(function(c) { return c.code === 353; });
        });
    });
};

// A mine (Map039 EV500-505, Map060 EV405-410, Map156): page 0, stepped on,
// shows its burst and turns a self switch on; the page on that self switch
// waits and ends the game. A death (user decision 2026-11-03). Found by that
// shape, not by map and event ids.
$.isMineList = function(list) {
    if (!list || !$dataMap || !$dataMap.events) return false;
    return $dataMap.events.some(function(ev) {
        var first = ev && ev.pages[0];
        return !!first && ev.pages.some(function(p) {
            if (p.list !== list || p.trigger !== 3 || !p.conditions.selfSwitchValid) return false;
            var ch = p.conditions.selfSwitchCh;
            return list.some(function(c) { return c.code === 353; }) &&
                first.list.some(function(c) { return c.code === 212; }) &&
                first.list.some(function(c) { return c.code === 123 && c.parameters[0] === ch && c.parameters[1] === 0; });
        });
    });
};

// Whose game over it is: the guest whose event this PC runs for it, else
// this PC's player.
$.doomActorFor = function(interp) {
    if (interp._fhOwner && $.runsWorld && $.runsWorld()) return $.actorOfPlayer(interp._fhOwner);
    return $.ownActor();
};

var _command353Doom = Game_Interpreter.prototype.command353;
Game_Interpreter.prototype.command353 = function() {
    var doom = $.role ? $.doomOf353(this) : '';
    if (!doom) return _command353Doom.call(this);
    var actor = null;
    if (doom === 'sanity') {
        var toss = $.tossLoser();
        if (toss.remote && !toss.actor) return true; // that joiner is gone: nobody to take
        actor = toss.actor;
    } else {
        actor = $.doomActorFor(this);
    }
    if (!actor || !$.doomCounts(actor)) return _command353Doom.call(this);
    $.markDoom(actor, doom);
    // The mold bed's V1013 stays 3 after its game over (the original loads a
    // save): its autorun pages (Map071 EV173 p2, Map075 EV222 p2 - the same
    // variable) started again for the next one there and killed the host too
    // (0.41 review 3 H1). Back to before anyone rested.
    if (doom === 'mold') $gameVariables.setValue($.MOLD_BED_VAR, 0);
    // The burn leaves V868 at 2 (the original's game over ends it there): the
    // lane stayed safe for good and its trooper no fight (EV130 waits for
    // V868 < 1). Back to 0: the trooper as it was, its burn pages off.
    if (doom === 'burn') $gameVariables.setValue($.FLAME_BURN_VAR, 0);
    // the game goes on (the others fight on, a ghost walks): not on a screen
    // the lost toss tinted white
    if (doom === 'sanity' && this._fhTossTone) $gameScreen.startTint(this._fhTossTone, 30);
    if ($gameParty.inBattle()) {
        $.doomFall(actor);
        // a joiner lost: the fight goes on for the others
        if (actor !== $.ownActor()) return true;
    }
    return _command353Doom.call(this);
};

// A game over the session lives through: the page is spent --------------------
// The original ends the game at 353 and a load puts the world back. Here the
// world goes on, and an autorun or parallel page whose condition still holds
// started again at once, its cause used up: on the host's interpreter (a mine
// a guest stepped on - Map039/060/156 "mine", self switch A - put the host
// down every 100 frames after the guest; 0.41 review 3 S1). Such a page does
// not start again while its event shows that page: a self switch key of its
// own, "<map>,<event>,FHSPENT<page>", saved and synced with the world's.
// Other events of the map whose page ends the game on the same conditions go
// with it (one trigger, one death: Map028's crown events all wait for V1552).
// A page with no condition (a scene map the player is moved to: the pit,
// Map142 EV2) is not spent: the next one moved there must meet it too.
$.SPENT_CH = 'FHSPENT';

$.spentKey = function(mapId, eventId, pageIndex) {
    return [mapId, eventId, $.SPENT_CH + pageIndex];
};

$.isSpentPage = function(ev) {
    if (!$.role || !ev || ev._pageIndex < 0 || !$gameSelfSwitches) return false;
    return $gameSelfSwitches.value($.spentKey(ev._mapId, ev._eventId, ev._pageIndex));
};

$.pageEndsGame = function(page) {
    return !!page && (page.trigger === 3 || page.trigger === 4) &&
        (page.list || []).some(function(cmd) { return cmd.code === 353; });
};

// The map event whose autorun / parallel page this interpreter runs.
$.autoPageEventOf = function(interp) {
    if (!interp._eventId || !$gameMap || interp._mapId !== $gameMap.mapId()) return null;
    var ev = $gameMap.event(interp._eventId);
    var page = ev && ev.page();
    var c = page && page.conditions;
    if (!$.pageEndsGame(page) || !(c.selfSwitchValid || c.switch1Valid || c.switch2Valid || c.variableValid ||
            c.itemValid || c.actorValid)) return null;
    return page.list === interp._list || $.sameListShape(page.list, interp._list) ? ev : null;
};

$.spendPage = function(ev) {
    var page = ev.page();
    var cond = JSON.stringify(page.conditions);
    $gameMap.events().forEach(function(e) {
        var p = e.page();
        if (e !== ev && (!$.pageEndsGame(p) || JSON.stringify(p.conditions) !== cond)) return;
        if ($.isSpentPage(e)) return;
        $gameSelfSwitches.setValue($.spentKey(e._mapId, e._eventId, e._pageIndex), true);
        $.dlog('autorun ev' + e.eventId(), 'p' + e._pageIndex, 'spent: it ended in a game over the session lives through');
    });
};

var _command353Spent = Game_Interpreter.prototype.command353;
Game_Interpreter.prototype.command353 = function() {
    var ev = $.role && ($.isHost() || ($.isRoaming && $.isRoaming())) ? $.autoPageEventOf(this) : null;
    var page = ev ? ev._pageIndex : -1;
    var result = _command353Spent.call(this);
    if (ev && ev._pageIndex === page && !$.gameOverPending && !(SceneManager._nextScene instanceof Scene_Gameover)) {
        $.spendPage(ev);
    }
    return result;
};

var _checkEventTriggerAutoSpent = Game_Event.prototype.checkEventTriggerAuto;
Game_Event.prototype.checkEventTriggerAuto = function() {
    if (this._trigger === 3 && $.isSpentPage(this)) return;
    _checkEventTriggerAutoSpent.call(this);
};

var _updateParallelSpent = Game_Event.prototype.updateParallel;
Game_Event.prototype.updateParallel = function() {
    if (this._interpreter && !this._interpreter.isRunning() && $.isSpentPage(this)) return;
    _updateParallelSpent.call(this);
};

// Another page (its condition changed: the mold bed used again): free again.
var _setupPageSpent = Game_Event.prototype.setupPage;
Game_Event.prototype.setupPage = function() {
    if ($.role && $gameSelfSwitches) {
        var self = this, data = this.event();
        (data && data.pages || []).forEach(function(p, i) {
            if (i === self._pageIndex) return;
            var key = $.spentKey(self._mapId, self._eventId, i);
            if ($gameSelfSwitches.value(key)) $gameSelfSwitches.setValue(key, false);
        });
    }
    _setupPageSpent.call(this);
};

// Coin tosses: the one who lost takes what follows ----------------------------

// SNAP NECK (Chaugnar troop 20 page 14, Poe troop 210 page 11): a lost toss
// turns SW560 Big_boy_attack on and aborts the fight; that map's pages on it
// play the execution and end the game (Chaugnar: an autorun, Map024 EV108;
// Poe: a touch or parallel page that sets V1479, then autoruns) - on the PC
// that ran the fight, for whoever those pages picked, not the one who lost
// the toss when a joiner did. Here SW560 stays off in the world: when the map
// is back, the page it would start runs as the loser's (its screen, its
// character; the pages after it run for whoever wrote their conditions), and
// the game over at the end is a death (user decisions 2026-11-03: a death,
// with the scene). A loser on another PC falls in the fight instead.
$.SNAP_NECK_SWITCH = 560;
$.SNAP_CHAIN = { sw: [540], v: [1479] }; // Big_boy_exection, djinn_execution: back for the next one
$.snapPending = null; // { actorId, map }: the loser's execution, once the map is back
$.snapRun = 0;        // the actor whose execution runs
var _command121Snap = Game_Interpreter.prototype.command121;
Game_Interpreter.prototype.command121 = function() {
    var p = this._params;
    if (this === $gameTroop._interpreter && this._fhToss && $.coopBattleHere() && p[2] === 0 &&
            p[0] <= $.SNAP_NECK_SWITCH && p[1] >= $.SNAP_NECK_SWITCH) {
        var loser = $.tossLoser().actor;
        if (loser && $.doomCounts(loser)) {
            $.markDoom(loser, 'snap');
            if ($.snapPlayer(loser)) $.snapPending = { actorId: loser.actorId(), map: $gameMap.mapId() };
            else $.doomFall(loser);
        }
        return true;
    }
    return _command121Snap.call(this);
};

// Who plays it on this PC's map: 'self', a thin guest here (its conn), or null.
$.snapPlayer = function(actor) {
    if (!actor || !$.runsOwnMap()) return null;
    if (actor === $.ownActor()) return 'self';
    var id = $.isHost() ? $.playerOfActor(actor.actorId()) : null;
    var conn = id && id !== 'host' ? $.clientById(id) : null;
    return conn && !conn.roam && $.guestOnMap(conn) ? conn : null;
};

// The page SW560 starts on this map (the page each event would show with it
// on, one that waits for it), the nearest to the loser.
$.snapStartOf = function(x, y) {
    var data = $gameSwitches._data, was = data[$.SNAP_NECK_SWITCH], best = null, bestD = Infinity;
    data[$.SNAP_NECK_SWITCH] = true;
    try {
        $gameMap.events().forEach(function(ev) {
            var pages = ev.event().pages;
            for (var i = pages.length - 1; i >= 0; i--) {
                if (!ev.meetsConditions(pages[i])) continue;
                var c = pages[i].conditions, id = $.SNAP_NECK_SWITCH;
                if ((c.switch1Valid && c.switch1Id === id) || (c.switch2Valid && c.switch2Id === id)) {
                    var d = Math.abs(ev.x - x) + Math.abs(ev.y - y);
                    if (d < bestD) { bestD = d; best = { ev: ev, list: pages[i].list }; }
                }
                break;
            }
        });
    } finally {
        data[$.SNAP_NECK_SWITCH] = was;
    }
    return best;
};

$.playSnap = function() {
    var s = $.snapPending;
    if (!s || $gameParty.inBattle() || SceneManager.isSceneChanging()) return;
    var actor = $gameActors.actor(s.actorId), who = $.snapPlayer(actor);
    if ($gameMap.mapId() !== s.map || !who) {
        $.snapPending = null; // (gone meanwhile: the mark stays, its next fall is its death)
        return;
    }
    if (who === 'self' ? $gameMap.isEventRunning() : ($.owned[who.guestId] || $.isBusy(who))) return;
    var pos = who === 'self' ? $gamePlayer : ($.remotes[who.guestId] || who.lastPos || {});
    var start = $.snapStartOf(pos.x, pos.y);
    // (no execution on this map: the original's game over itself)
    var list = start ? start.list : $dataCommonEvents[47].list, ev = start ? start.ev : null;
    $.snapPending = null;
    $.snapRun = s.actorId;
    $.dlog('SNAP NECK: the execution of', actor.name(), ev ? 'ev' + ev.eventId() : 'CE47');
    if (who === 'self') $gameMap._interpreter.setup(list, ev ? ev.eventId() : 0);
    else $.runOwned(who, list, ev);
};

var _sceneMapUpdateSnap = Scene_Map.prototype.update;
Scene_Map.prototype.update = function() {
    _sceneMapUpdateSnap.call(this);
    if ($.snapPending) $.playSnap();
    if ($.snapRun && $.snapDone()) $.snapEnd();
};

// The executed player is dead: its game over became its death ($.onPlayerDefeated).
$.snapDone = function() {
    if (!$.isHost()) return $.myActorId === $.snapRun && $.myState === 'dead';
    var id = $.playerOfActor($.snapRun);
    return !id || $.isDead(id);
};

// What is left of its execution stops (its last autorun page started again
// for the dead host: a game over for nobody, its black screen, forever) and
// the execution's state goes back.
$.snapEnd = function() {
    var id = $.isHost() ? $.playerOfActor($.snapRun) : 'self';
    $.snapRun = 0;
    var interp = $gameMap._interpreter;
    if ((id === 'host' || id === 'self') && interp.isRunning() && $.snapChainEvent($gameMap.event(interp.eventId()))) {
        interp.clear();
    } else if (id && $.owned[id] && $.snapChainEvent($.owned[id].ev)) {
        $.finishOwned(id);
    }
    $.snapReset();
};

// An event of the execution: a page waits for SW560, SW540 or V1479.
$.snapChainEvent = function(ev) {
    return !!ev && ev.event().pages.some(function(pg) {
        var c = pg.conditions, sw = [$.SNAP_NECK_SWITCH].concat($.SNAP_CHAIN.sw);
        return sw.some(function(id) { return (c.switch1Valid && c.switch1Id === id) || (c.switch2Valid && c.switch2Id === id); }) ||
            (c.variableValid && $.SNAP_CHAIN.v.indexOf(c.variableId) >= 0);
    });
};

// The execution's state goes back: the next one who loses there is executed too.
$.snapReset = function() {
    $.SNAP_CHAIN.sw.forEach(function(id) { $gameSwitches.setValue(id, false); });
    $.SNAP_CHAIN.v.forEach(function(id) { $gameVariables.setValue(id, 0); });
    $gameMap.events().forEach(function(ev) {
        var uses = ev.event().pages.some(function(pg) {
            var c = pg.conditions;
            return $.SNAP_CHAIN.sw.some(function(id) {
                return (c.switch1Valid && c.switch1Id === id) || (c.switch2Valid && c.switch2Id === id);
            });
        });
        if (uses) ['A', 'B', 'C', 'D'].forEach(function(ch) {
            $gameSelfSwitches.setValue([$gameMap.mapId(), ev.eventId(), ch], false);
        });
    });
};

$.isCoinPage = function(list) {
    return (list || []).some(function(c) { return c.code === 117 && c.parameters[0] === $.COIN_HUD_CE; });
};

// A coin toss in a troop page: from here to the page's end what it costs is
// the loser's (_fhToss on the troop interpreter, until its next page).
var _command102Toss = Game_Interpreter.prototype.command102;
Game_Interpreter.prototype.command102 = function() {
    if (this === $gameTroop._interpreter && $gameParty.inBattle() && $.isCoinPage(this._list)) {
        // the screen's tone before what the loss shows (SANITY LOST tints it
        // white before its game over): back to it when the game goes on
        if (!this._fhToss && $gameScreen) this._fhTossTone = $gameScreen.tone().slice();
        this._fhToss = true;
    }
    return _command102Toss.call(this);
};

var _clearDoom = Game_Interpreter.prototype.clear;
Game_Interpreter.prototype.clear = function() {
    _clearDoom.call(this);
    delete this._fhToss;
    delete this._fhTossTone;
    delete this._fhCatTarget;
};

// { actor, remote }: the joiner who answered the toss, or this PC's player.
$.tossLoser = function() {
    var root = $gameTroop._interpreter;
    if (!root || !root._fhToss) return { actor: null, remote: false };
    if ($.coinCtx && $.coinCtx.jid) return { actor: $.joinerActor($.coinCtx.jid), remote: true };
    var own = $.ownActor();
    return { actor: own && $gameParty.battleMembers().indexOf(own) >= 0 ? own : null, remote: false };
};

// The forced action (339) of an enemy on one player: the cat's victim, or
// the one who lost the coin toss of this page.
$.forcedTargetOf = function(interp) {
    if (!$.coopBattleHere() || !$.isTroopInterp(interp)) return null;
    var p = interp._params;
    var skill = p[0] === 0 ? $dataSkills[p[2]] : null;
    if (!skill || (skill.scope !== 1 && skill.scope !== 3)) return null;
    var root = $gameTroop._interpreter;
    if (root._fhCatTarget && $.CAT_SKILLS.indexOf(p[2]) >= 0) return $gameActors.actor(root._fhCatTarget);
    if (root._fhToss) return $.tossLoser().actor;
    return null;
};

var _command339Doom = Game_Interpreter.prototype.command339;
Game_Interpreter.prototype.command339 = function() {
    var p = this._params;
    var target = $.forcedTargetOf(this);
    var result = _command339Doom.call(this);
    if (target) {
        var enemies = p[1] < 0 ? $gameTroop.members() : [$gameTroop.members()[p[1]]];
        enemies.forEach(function(enemy) {
            var action = enemy && enemy._actions && enemy._actions[0];
            if (!action || !action._forcing || action.item() !== $dataSkills[p[2]]) return;
            action._fhFixedTarget = target.actorId();
            action._targetIndex = target.index();
            $.dlog('forced', $dataSkills[p[2]].name, 'on', target.name());
        });
    }
    var root = $gameTroop._interpreter;
    if (root && root._fhCatTarget && $.CAT_SKILLS.indexOf(p[2]) >= 0) $.catSaveLimbs(root);
    return result;
};

// A fixed target: that player or nobody (fled, fallen), never someone else.
var _makeTargetsFixed = Game_Action.prototype.makeTargets;
Game_Action.prototype.makeTargets = function() {
    var id = this._fhFixedTarget;
    if (id && $gameParty.inBattle() && this.isForOpponent()) {
        var actor = $gameActors.actor(id);
        return actor && actor.isAlive() && $gameParty.battleMembers().indexOf(actor) >= 0 ? [actor] : [];
    }
    return _makeTargetsFixed.call(this);
};

//=============================================================================
// Pocketcat (troops 123 / 124): the player it asks loses the limb
//=============================================================================
// At every round end the cat asks "Rip my arm / Rip my leg / Behead me / I
// don't want you to do anything!" (page 13) and its torso then uses 575 (arm),
// 758 (leg) or 759 (head) on a random party member. In co-op (user decision
// 2026-10-19):
// - It asks the players in turn: the one who started the fight first, then
//   the next one in the party (the joiners in the order they came), skipping
//   the fallen. A question asked again (an arm three times in a row, "I don't
//   want...") stays with the same player.
// - That player chooses on its own screen (the others read along), and the
//   limb is that player's.
// - "The same limb only twice in a row" (V2617 arms / V2618 legs) counts per
//   player: kept on its character (_fhCatLimbs), put into the variables
//   before the question, read back after the answer.
// - Every gauge stands still meanwhile (the round end is a troop event; also
//   checked here), on the joiners' screens too (they show this PC's gauges).
// - A joiner that does not answer in 30 s: the cat picks for it, an arm or a
//   leg it may still lose (never the head); it hits that player.

$.CAT_TROOPS = [123, 124];
$.CAT_SKILLS = [575, 758, 759]; // arm, leg, head
$.CAT_ARM_VAR = 2617;
$.CAT_LEG_VAR = 2618;
$.CAT_ASK_MS = 30000;
$.catRota = null; // this fight: { last: actor id asked last }

var _battleSetupCat = BattleManager.setup;
BattleManager.setup = function(troopId, canEscape, canLose) {
    $.catRota = null;
    _battleSetupCat.call(this, troopId, canEscape, canLose);
};

// The cat's question: Show Text with the four answers, in its page.
$.isCatQuestion = function(interp) {
    if (interp !== $gameTroop._interpreter || !$.coopBattleHere() || $.CAT_TROOPS.indexOf($gameTroop._troopId) < 0) {
        return false;
    }
    var list = interp._list || [];
    var i = interp._index + 1;
    while (list[i] && list[i].code === 401) i++;
    var c = list[i];
    if (!c || c.code !== 102 || $.choiceOptions(c.parameters[0]).length < 3) return false;
    return list.some(function(cmd) { return cmd.code === 339 && $.CAT_SKILLS.indexOf(cmd.parameters[2]) >= 0; });
};

// The players in this fight, in party order: this PC's player, the joiners.
$.fightPlayers = function() {
    var own = $.isHost() ? $.hostActorId() : $.myActorId;
    return $gameParty.battleMembers().filter(function(a) {
        return a.actorId() !== $.GOLEM_ACTOR && (a.actorId() === own || !!a._fhJoiner);
    });
};

$.catNextTarget = function() {
    var ab = $.authBattle;
    var own = $.isHost() ? $.hostActorId() : $.myActorId;
    var list = $.fightPlayers();
    var last = $.catRota ? $.catRota.last : 0;
    var at = -1;
    list.forEach(function(a, i) { if (a.actorId() === last) at = i; });
    for (var k = 1; k <= list.length; k++) {
        var a = list[(at + k) % list.length];
        if (a.isAlive() && !(ab && ab.ownerDown && a.actorId() === own)) {
            $.catRota = { last: a.actorId() };
            return a;
        }
    }
    return null;
};

$.catLoadLimbs = function(actor) {
    var l = actor._fhCatLimbs || [0, 0];
    $gameVariables.setValue($.CAT_ARM_VAR, Number(l[0]) || 0);
    $gameVariables.setValue($.CAT_LEG_VAR, Number(l[1]) || 0);
};

$.catSaveLimbs = function(interp) {
    var actor = interp._fhCatTarget ? $gameActors.actor(interp._fhCatTarget) : null;
    if (actor) actor._fhCatLimbs = [$gameVariables.value($.CAT_ARM_VAR), $gameVariables.value($.CAT_LEG_VAR)];
};

// This page's victim (picked at its first question).
$.catTargetOf = function(interp) {
    if (!interp._fhCatTarget) {
        var next = $.catNextTarget();
        if (!next) return null;
        interp._fhCatTarget = next.actorId();
        $.catLoadLimbs(next);
        $.dlog('the cat asks', next.name());
    }
    return $gameActors.actor(interp._fhCatTarget);
};

// An arm, or a leg when the arms had their two turns; never the head.
$.catDefaultChoice = function() {
    return $gameVariables.value($.CAT_ARM_VAR) >= 2 ? 1 : 0;
};

$.catAsking = function() {
    var d = $.bDialogWait;
    return !!(d && d.cat);
};

var _command101Cat = Game_Interpreter.prototype.command101;
Game_Interpreter.prototype.command101 = function() {
    if ($gameMessage.isBusy() || !$.isCatQuestion(this)) return _command101Cat.call(this);
    var target = $.catTargetOf(this);
    if (target && target._fhJoiner) return this.fhCatAskRemote(target);
    // this PC's player answers here, the joiners read along (not a talker)
    var keep = $.talkOwner;
    $.talkOwner = 0;
    try {
        return _command101Cat.call(this);
    } finally {
        $.talkOwner = keep;
    }
};

// The question on that joiner's screen (text and answers), the others read it.
Game_Interpreter.prototype.fhCatAskRemote = function(target) {
    var jid = target._fhJoiner;
    var data = $.battleDialogData(this);
    var packet = $.battleDialogPacket(data, jid);
    $.msgShared = false;
    var list = this._list || [];
    var index = this._index;
    while (list[index + 1] && list[index + 1].code === 401) index++;
    if (list[index + 1] && list[index + 1].code === 102) index++;
    this._index = index + 1;
    $.bDialogWait = {
        interp: this, id: packet.id, jid: jid, indent: this._indent, cancel: data.cancelChoice,
        count: data.choices ? data.choices.length : 0, cat: target.actorId(), until: $.clockMs() + $.CAT_ASK_MS
    };
    this.setWaitMode('fhBDialog');
    $.battleBroadcast(packet);
    $.battleGab(target.name() + ' decides...', true);
    $.dlog('the cat asks', jid);
    return false;
};

// No answer in time, or that player is gone: the cat picks for it.
var _updateWaitModeCat = Game_Interpreter.prototype.updateWaitMode;
Game_Interpreter.prototype.updateWaitMode = function() {
    var d = $.bDialogWait;
    if (this._waitMode === 'fhBDialog' && d && d.interp === this && d.cat) {
        var actor = $.joinerActor(d.jid);
        var late = $.clockMs() >= d.until;
        if (actor && actor.isAlive() && !late) return true;
        $.battleBroadcast({ t: 'bDialogAdvance', id: d.id });
        $.resolveBDialog($.catDefaultChoice());
        if (late && actor) $.battleGab(actor.name() + ' took too long - the cat chooses.');
        this._waitMode = '';
        return false;
    }
    return _updateWaitModeCat.call(this);
};

var _terminateCat = Game_Interpreter.prototype.terminate;
Game_Interpreter.prototype.terminate = function() {
    if (this._fhCatTarget) $.catSaveLimbs(this);
    _terminateCat.call(this);
};

var _canTickAtbCat = BattleManager.canTickAtb;
BattleManager.canTickAtb = function() {
    if ($.catAsking()) return false;
    return _canTickAtbCat.call(this);
};

//-----------------------------------------------------------------------------
// Duel skills (user 2026-10-26): the duel's troop has no pages ($.buildPvpTroop),
// so the skills that work through the original troop pages - the "SpecialSkills"
// page on SW200, Talk's SW52, Run's SW215 - only cost a turn there. Run, Steal,
// Analyze, Leg sweep and Scorched earth are off in a duel. Talk is a trick:
// "<name>: I'm sorry! I give up, please stop!" and the other player picks
// "Really?" (its character loses a turn: state 115 "Can't do shit - one turn")
// or "Shut up" (nothing). No answer in time: "Shut up". While the question is
// up both duelists' gauges stand still (user 2026-10-26).
$.DUEL_OFF_SKILLS = [40, 31, 70, 473, 369, 136, 504]; // Run, Steal x3, Analyze, Leg sweep, Scorched earth
$.DUEL_TALK_SKILL = 11;
$.DUEL_TALK_STATE = 115;
$.DUEL_TALK_MS = 10000; // real time ($.clockMs)
$.DUEL_TALK_TEXT = "%1: I'm sorry! I give up, please stop!";
$.DUEL_TALK_CHOICES = ['Really?', 'Shut up'];

$.inDuelBattle = function() {
    return !!$.pvpBattle && !$.puppet && $gameParty.inBattle();
};

var _meetsSkillConditionsDuel = Game_BattlerBase.prototype.meetsSkillConditions;
Game_BattlerBase.prototype.meetsSkillConditions = function(skill) {
    if (skill && this.isActor() && $.DUEL_OFF_SKILLS.indexOf(skill.id) >= 0 && $.inDuelBattle()) return false;
    return _meetsSkillConditionsDuel.call(this, skill);
};

// This player's Talk in its duel: the trick instead of CE14 (SW52).
var _applyGlobalDuelTalk = Game_Action.prototype.applyGlobal;
Game_Action.prototype.applyGlobal = function() {
    var item = this.item();
    if (item && DataManager.isSkill(item) && item.id === $.DUEL_TALK_SKILL && $.inDuelBattle() &&
            this.subject() === $.duelMe()) {
        $.duelTalk(this.subject());
        return;
    }
    _applyGlobalDuelTalk.call(this);
};

$.duelTalk = function(me) {
    var pb = $.pvpBattle;
    $.battleGab($.DUEL_TALK_TEXT.replace('%1', me.name())); // (both screens: the other duelist views this battle)
    $.bSend(pb.foeId, { t: 'bDuelTalk', bid: pb.bid, name: me.name() });
    $.dlog('duel: talk - begs', pb.foeName, 'to stop');
};

// The other player begs: believe it or not. One question at a time, asked
// outside this player's own turn (a state added in its own turn would cost
// that turn and the next: FH_ATB finishAtbTurn); the gauges here stand still
// while it is up.
$.guestHandlers.bDuelTalk = function(msg) {
    var pb = $.pvpBattle;
    if (!pb || !msg || msg.bid !== pb.bid || (msg.from || 'host') !== pb.foeId) return;
    if (pb.talkAsk || pb.talkWait || !$.inDuelBattle() || pb.selfDead || pb.won) return;
    pb.talkWait = msg;
    $.duelTalkFrame();
};

$.duelTalkOwnTurn = function() {
    var me = $.duelMe(), bm = BattleManager;
    return !!me && (bm._atbInputActor === me || bm._atbActing === me || bm._subject === me);
};

$.duelTalkOpen = function(pb, msg) {
    var ask = pb.talkAsk = $.duelTalkAsk = { pb: pb, at: $.clockMs(), close: null, done: false };
    var answer = function(i) {
        if (ask.done) return;
        ask.done = true;
        if (pb.talkAsk === ask) pb.talkAsk = null;
        if ($.duelTalkAsk === ask) $.duelTalkAsk = null;
        if ($.pvpBattle !== pb) return;
        var me = $.duelMe();
        var fell = i === 0 && !!me && me.isAlive() && $.inDuelBattle();
        if (fell) me.addState($.DUEL_TALK_STATE);
        $.dlog('duel: talk from', pb.foeName, '-', fell ? 'believed it (a turn lost)' : 'not believed');
        $.bSend(pb.foeId, { t: 'bDuelTalkAns', bid: pb.bid, fell: fell });
        $.battleGab(fell ? 'It was a lie!' : 'Shut up!', true);
    };
    ask.answer = answer;
    var text = $.DUEL_TALK_TEXT.replace('%1', msg.name || pb.foeName);
    ask.close = $.showPickBox(text, $.DUEL_TALK_CHOICES, answer, 1);
    // the one who talked stands still too while it is up (user 2026-10-26)
    $.bSend(pb.foeId, { t: 'bDuelTalkUp', bid: pb.bid });
};

// The talker's PC: both duelists' gauges stop while the question is up, until
// the answer (or the answerer's 10 s "Shut up"; a lost answer frees it a
// little after that).
$.DUEL_TALK_HOLD_SLACK_MS = 3000;
$.guestHandlers.bDuelTalkUp = function(msg) {
    var pb = $.pvpBattle;
    if (!pb || !msg || msg.bid !== pb.bid || (msg.from || 'host') !== pb.foeId) return;
    pb.talkHeld = $.clockMs();
};

$.duelTalkHeld = function() {
    var pb = $.pvpBattle;
    if (!pb || !pb.talkHeld) return false;
    if (!$.inDuelBattle() || $.clockMs() - pb.talkHeld >= $.DUEL_TALK_MS + $.DUEL_TALK_HOLD_SLACK_MS) {
        pb.talkHeld = 0;
        return false;
    }
    return true;
};

$.guestHandlers.bDuelTalkAns = function(msg) {
    var pb = $.pvpBattle;
    if (!pb || !msg || msg.bid !== pb.bid || (msg.from || 'host') !== pb.foeId) return;
    pb.talkHeld = 0;
    $.battleGab(msg.fell ? pb.foeName + ' fell for it!' : pb.foeName + ': "Shut up!"', true);
};

// No answer in time: "Shut up". Its duel is over: the box just closes.
$.duelTalkAsk = null;
$.duelTalkFrame = function() {
    var pb = $.pvpBattle;
    if (pb && pb.talkWait && !pb.talkAsk) {
        if (!$.inDuelBattle() || pb.selfDead || pb.won) pb.talkWait = null;
        else if (!$.duelTalkOwnTurn()) {
            var msg = pb.talkWait;
            pb.talkWait = null;
            $.duelTalkOpen(pb, msg);
        }
    }
    var ask = $.duelTalkAsk;
    if (!ask) return;
    if ($.pvpBattle !== ask.pb || !$gameParty.inBattle()) $.duelTalkClose();
    else if ($.clockMs() - ask.at >= $.DUEL_TALK_MS) {
        if (ask.close) ask.close();
        ask.answer(1);
    }
};

$.duelTalkClose = function() {
    var ask = $.duelTalkAsk;
    if (!ask) return;
    $.duelTalkAsk = null;
    if (ask.pb.talkAsk === ask) ask.pb.talkAsk = null;
    ask.done = true;
    if (ask.close) ask.close();
};

var _sceneBattleUpdateDuelTalk = Scene_Battle.prototype.update;
Scene_Battle.prototype.update = function() {
    _sceneBattleUpdateDuelTalk.call(this);
    $.duelTalkFrame();
    $.duelStunFrame();
};

var _sceneMapUpdateDuelTalk = Scene_Map.prototype.update;
Scene_Map.prototype.update = function() {
    _sceneMapUpdateDuelTalk.call(this);
    if ($.duelTalkAsk) $.duelTalkClose();
};

var _canTickAtbDuelTalk = BattleManager.canTickAtb;
BattleManager.canTickAtb = function() {
    if ($.duelTalkAsk || $.duelTalkHeld()) return false;
    return _canTickAtbDuelTalk.call(this);
};

var _endBattleDuelTalk = BattleManager.endBattle;
BattleManager.endBattle = function(result) {
    $.duelTalkClose();
    _endBattleDuelTalk.call(this, result);
};

})(FH.Coop);
