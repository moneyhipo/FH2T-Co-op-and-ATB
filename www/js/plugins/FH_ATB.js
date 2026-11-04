//=============================================================================
// FH_ATB.js
//=============================================================================
/*:
 * @plugindesc v0.5.13 Gauge-based ATB battles for Fear & Hunger 2: Termina.
 * Place at the very bottom of the plugin list. Turn Galv_ExAgiTurn OFF.
 * @author FH2 Co-op Mod
 *
 * @param Enabled
 * @type boolean
 * @default true
 *
 * @param Actor Average Seconds
 * @desc Seconds for an actor as fast as the enemies (AGI / enemy average
 * AGI = 1) to fill its gauge. Faster actors divide it by their rate.
 * @type number
 * @decimals 2
 * @default 4.5
 *
 * @param Actor Rate Per AGI
 * @desc Each AGI point below the enemy average makes the gauge this much
 * slower, compounding (0.2: x 0.8 a point), so it never stops.
 * @type number
 * @decimals 2
 * @default 0.2
 *
 * @param Time Stop AGI Ratio
 * @desc From this AGI / enemy average AGI on (3 = AGI 30 against 10), time
 * stops while that player chooses: no gauge moves, every turn, no limit.
 * @type number
 * @decimals 2
 * @default 3
 *
 * @param Actor Rate Log Scale
 * @desc Faster than the enemies: rate = 1 + this x ln(AGI / enemy average
 * AGI), no cap. 2: AGI 16 against 10 -> 1.94 (2.2 turns per enemy turn).
 * @type number
 * @decimals 2
 * @default 2
 *
 * @param Enemy Average Seconds
 * @desc Seconds for an enemy of average AGI to fill its gauge. Faster
 * enemies take less (down to / Rate Max), slower ones more (/ Enemy Rate Min).
 * @type number
 * @decimals 2
 * @default 5
 *
 * @param Actor First Turn Min Seconds
 * @desc An actor's first turn comes no sooner than this after the battle
 * starts (not in a preemptive battle). 0 = as soon as its gauge is full.
 * @type number
 * @decimals 2
 * @default 0
 *
 * @param Enemy First Turn Min Seconds
 * @desc An enemy's first turn comes no sooner than this after the battle
 * starts. After a surprise attack it counts from the end of the ambush.
 * @type number
 * @decimals 2
 * @default 6
 *
 * @param Enemy Rate Min
 * @desc Lowest speed multiplier for enemies (0.9 = the slowest enemy takes
 * 5.6 s with Enemy Average Seconds 5).
 * @type number
 * @decimals 2
 * @default 0.9
 *
 * @param Rate Max
 * @desc Highest enemy speed multiplier (enemy AGI / average AGI).
 * @type number
 * @decimals 2
 * @default 1.5
 *
 * @param Start Gauge Max
 * @desc Random starting gauge, 0 ~ this ratio.
 * @type number
 * @decimals 2
 * @default 0.3
 *
 * @param Ambush Bonus
 * @desc Gauge ratio added on preemptive (actors) / surprise (enemies).
 * 1 = the ambushing side acts right away.
 * @type number
 * @decimals 2
 * @default 1
 *
 * @param Gauge X
 * @type number
 * @default 8
 *
 * @param Gauge Y
 * @type number
 * @default 8
 *
 * @param Show Enemy Gauges
 * @type boolean
 * @default false
 *
 * @param Choosing Enemy Rate
 * @desc While a player chooses a command, enemy gauges (and the round)
 * fill at this rate...
 * @type number
 * @decimals 2
 * @default 0.2
 *
 * @param Choosing Max Delay Seconds
 * @desc ...until the enemies have lost this much time (then full speed):
 * a slow chooser does not hold everyone in co-op.
 * @type number
 * @decimals 2
 * @default 3
 *
 * @param Co-op Choosing Max Delay Seconds
 * @desc The same limit when other players fight in this battle; then the
 * actor gauges slow down too, not only the enemies.
 * @type number
 * @decimals 2
 * @default 2
 *
 * @param Choosing Delays Per Enemy Turn
 * @desc How many of a player's turns after an enemy action slow the enemies
 * down while that player chooses (each player its own count).
 * @type number
 * @default 1
 *
 * @param Choosing Delays Extra Turn
 * @desc The same for a player fast enough for the original's extra turn
 * (Galv_ExAgiTurn: AGI above the enemy average by its Agi Percent, 16
 * against 10).
 * @type number
 * @default 2
 *
 * @param Wait Mode
 * @desc true: gauges stop while you choose a command. false (default):
 * time keeps running and enemies attack while you are choosing.
 * @type boolean
 * @default false
 *
 * @param Debug Log
 * @type boolean
 * @default false
 *
 * @help
 * Replaces the "input everything, then run the round" flow with per-battler
 * gauges. Each battler's gauge grows every frame by
 *
 *   MAX / fillTicks * rate
 *
 * where fillTicks is Actor Average Seconds (4.5 s) or Enemy Average Seconds
 * (5 s), and rate depends on AGI:
 *
 * - Enemies: clamp(agi / battle average AGI, Enemy Rate Min, Rate Max),
 *   so 3.3-5.6 s.
 * - Actors (speed-based extra turns), against the enemy-side average AGI
 *   (as the original extra turns compared with the opposing side): faster,
 *   r = 1 + 2 ln(AGI / average); slower, r = 0.8 per point below. No floor,
 *   no cap. Against AGI 10 enemies (turns per enemy turn): AGI 7 -> 0.57,
 *   10 -> 1.1, 13 -> 1.7, 16 (the original's extra turn) -> 2.2, 20 -> 2.6,
 *   24 -> 3.1, 30 -> 3.6, 60 -> 5.1, 78 -> 5.7.
 *
 * First turn: an actor acts as soon as its gauge is full (Actor First Turn
 * Min Seconds, 0) and an enemy no sooner than Enemy First Turn Min Seconds
 * (6 s) after the battle starts; the gauge still fills meanwhile. The ambushing
 * side acts at once (Ambush Bonus); after an enemy surprise attack the
 * enemies' next turn counts as their first one again.
 *
 * While a player chooses a command on its first turn since the enemies last
 * acted (its first two at the original's extra-turn speed, AGI 16 against
 * 10: Choosing Delays Per Enemy Turn / Extra Turn), enemy gauges and the
 * round fill at Choosing Enemy Rate (0.2) until the enemies have lost
 * Choosing Max Delay Seconds (3 s); the budget comes back once nobody is
 * choosing. When other
 * players fight in the battle (co-op), every gauge slows down, actors too,
 * and the limit is Co-op Choosing Max Delay Seconds (2 s).
 *
 * Gauges keep filling while another battler's action plays
 * (actions themselves still run one at a time), but stop for messages,
 * troop events and (Wait mode) open command windows. The acting battler's
 * own gauge restarts once its action is over.
 *
 * Personal turn: when a battler's gauge fills it gets onTurnStart, acts
 * (actors get the command window), then onTurnEnd. State/buff turns, HP
 * regen, Boost Points and counter limits therefore tick per personal turn.
 * Turn-end states the battler gave itself during its own action get one
 * free turn so e.g. Guard lasts until its next action.
 *
 * Global round: every average enemy fill time (Enemy Average Seconds,
 * 5 s by default) the troop turn count goes up
 * and the battle enters the 'turnEnd' phase once, so the original
 * "Turn End" troop event pages (limb checks, enemy AI, ammo, death checks)
 * keep running unchanged.
 */

var FH = FH || {};
FH.ATB = FH.ATB || {};

(function($) {
'use strict';

var params = PluginManager.parameters('FH_ATB');
$.enabled = params['Enabled'] !== 'false';
$.actorAverageSec = Number(params['Actor Average Seconds'] || 4.5);
$.actorRatePerAgi = Number(params['Actor Rate Per AGI'] || 0.2);
$.actorRateLogScale = Number(params['Actor Rate Log Scale'] || 2);
$.timeStopRatio = Number(params['Time Stop AGI Ratio'] || 3);
$.TIME_STOP_TEXT = 'Everything around you starts to look slow...';
$.TIME_STOP_TEXT_KO = '주변의 모든 것이 느려 보이기 시작했다...';
$.enemyAverageSec = Number(params['Enemy Average Seconds'] || 5);
$.actorFirstMinSec = Number(params['Actor First Turn Min Seconds'] || 0);
$.enemyFirstMinSec = Number(params['Enemy First Turn Min Seconds'] || 6);
$.rateMax = Number(params['Rate Max'] || 1.5);
$.enemyRateMin = Number(params['Enemy Rate Min'] || 0.9);
$.startMax = Number(params['Start Gauge Max'] || 0.3);
$.ambushBonus = Number(params['Ambush Bonus'] || 1);
$.gaugeX = Number(params['Gauge X'] || 8);
$.gaugeY = Number(params['Gauge Y'] || 8);
$.showEnemies = params['Show Enemy Gauges'] === 'true';
$.debug = params['Debug Log'] === 'true';
$.waitMode = params['Wait Mode'] === 'true';
$.choosingRate = Number(params['Choosing Enemy Rate'] || 0.2);
$.choosingMaxDelaySec = Number(params['Choosing Max Delay Seconds'] || 3);
$.choosingMaxDelayCoopSec = Number(params['Co-op Choosing Max Delay Seconds'] || 2);
$.choosingDelays = Number(params['Choosing Delays Per Enemy Turn'] || 1);
$.choosingDelaysFast = Number(params['Choosing Delays Extra Turn'] || 2);
// The original's extra turn: AGI above the opposing average by Agi Percent.
$.extraTurnRatio = 1 + Number(PluginManager.parameters('Galv_ExAgiTurn')['Agi Percent'] || 50) / 100;

$.MAX = 1000;
// Ticks an average battler (rate 1) of that side needs to fill its gauge.
$.fillTicks = function(battler) {
    var sec = battler.isActor() ? $.actorAverageSec : $.enemyAverageSec;
    return Math.max(1, Math.round(sec * 60));
};
// The global round follows the enemies' pace: the original troop events
// (enemy AI on V19, limb checks) expect about one enemy action per round.
$.roundTicks = function() {
    return Math.max(1, Math.round($.enemyAverageSec * 60));
};
// Ticks before a battler's first turn may come.
$.firstTurnTicks = function(battler) {
    var sec = battler.isActor() ? $.actorFirstMinSec : $.enemyFirstMinSec;
    return Math.max(0, Math.round(sec * 60));
};

$.log = function() {
    if ($.debug) console.log.apply(console, ['[FH_ATB]'].concat([].slice.call(arguments)));
    // Also to the co-op log file, with the frame, for timing checks - in a
    // co-op session only (a single player game wrote every turn: final review E).
    if (window.FH && FH.Coop && FH.Coop.dlog && FH.Coop.role) {
        FH.Coop.dlog.apply(null, ['ATB f' + Graphics.frameCount].concat([].slice.call(arguments)));
    }
};

// Galv_ExAgiTurn gives AGI-based bonus rounds; ATB replaces it.
if (typeof Galv !== 'undefined' && Galv.EXTURN) {
    BattleManager.setupExTurn = function() {
        this._exBattlers = [];
        Galv.EXTURN.active = false;
    };
}

//=============================================================================
// Game_Battler
//=============================================================================

Game_Battler.prototype.atbGauge = function() {
    return this._atbGauge || 0;
};

Game_Battler.prototype.setAtbGauge = function(value) {
    this._atbGauge = Math.max(0, Math.min($.MAX, value));
};

Game_Battler.prototype.atbRate = function(avgAgi) {
    if (this.isActor()) {
        var foeAvg = BattleManager.atbEnemyAverageAgi();
        return $.actorRate(this.agi, foeAvg);
    }
    var ratio = avgAgi > 0 ? this.agi / avgAgi : 1;
    return Math.max($.enemyRateMin, Math.min($.rateMax, ratio));
};

// Speed-based extra turns (user decisions 2026-11-02). Faster than the enemy
// side's average: 1 + 2 ln(AGI / average), so each step of speed adds less
// (AGI multiplies with buffs: amulet + Fast stance + Pep pills + heroin is
// 78, 5.7 turns per enemy turn, not 7 or more); AGI 16 against 10, the
// original's extra turn, is 2.2 turns per enemy turn, a little room above
// two. No cap. Slower: 20% a point, compounding (heroin's lowest AGI 7:
// 0.51), so even far below them (AGI 15-20 enemies) it never stops.
$.actorRate = function(agi, foeAgi) {
    if (!(foeAgi > 0) || agi === foeAgi) return 1;
    if (agi < foeAgi) return Math.pow(1 - $.actorRatePerAgi, foeAgi - agi);
    return 1 + $.actorRateLogScale * Math.log(agi / foeAgi);
};

Game_Battler.prototype.canGainAtb = function() {
    return this.isAlive() && this.isAppeared() && this.isBattleMember();
};

Game_Battler.prototype.isAtbReady = function() {
    if (this._atbFirstWait > 0) return false;
    return this.canGainAtb() && this.atbGauge() >= $.MAX;
};

//=============================================================================
// BattleManager
//=============================================================================

BattleManager.isAtb = function() {
    return $.enabled && !!this._atbActive;
};

var _initMembers = BattleManager.initMembers;
BattleManager.initMembers = function() {
    _initMembers.call(this);
    this._atbActive = $.enabled;
    this._atbStarted = false;
    this._atbRoundTick = 0;
    this._atbRoundEnd = false;
    this._atbRoundPending = false;
    this._atbSurprisePending = false;
    this._atbActing = null;
    this._atbInputActor = null;
    this._atbPreForceSubject = null;
    this._atbPreForcePhase = null;
    this._atbSuspended = null;
    this._atbInputMemory = null;
    this._atbAvgAgi = 0;
    this._atbFoeAvgAgi = 0;
    this._atbOneTurn = false;
    this._atbBattleId = $.battleCount = ($.battleCount || 0) + 1; // a new battle (time-stop line)
};

// Door battles (troops 241-259) end at the first turn end unless the door
// is broken: "The door was too strong for you". In the original every party
// member hits once before that, so here each actor acts exactly once and the
// round ends when all of them have acted (no clock). Detected by a turn-end
// page with no enemy/switch condition that aborts the battle.
BattleManager.isAtbOneTurnTroop = function() {
    var troop = $gameTroop.troop();
    return !!troop && troop.pages.some(function(page) {
        var c = page.conditions;
        return c.turnEnding && !c.enemyValid && !c.switchValid && !c.actorValid &&
            page.list.some(function(cmd) { return cmd.code === 340; });
    });
};

BattleManager.allActorsDoneAtbRound = function() {
    return $gameParty.battleMembers().every(function(a) {
        return !a.canGainAtb() || a._atbDoneRound;
    });
};

BattleManager.atbBattlers = function() {
    return $gameParty.battleMembers().concat($gameTroop.members());
};

// Average AGI of the battle, counting a monster once rather than once per
// body part (a six-part villager would otherwise weigh six times as much as
// an actor). A monster counts with its slowest living part. It is taken once
// when the battle starts, so cutting off a limb does not change everyone's
// speed; a battler's own AGI changes (buffs, debuffs) still count at once.
BattleManager.atbAverageAgi = function() {
    if (this._atbAvgAgi) return this._atbAvgAgi;
    return this.measureAtbAverageAgi();
};

BattleManager.measureAtbAverageAgi = function() {
    var values = [];
    var bodies = {};
    this.atbBattlers().forEach(function(b) {
        if (!b.canGainAtb()) return;
        if (b.isActor()) {
            values.push(b.agi);
            return;
        }
        var key = $.bodyKey(b);
        bodies[key] = bodies[key] === undefined ? b.agi : Math.min(bodies[key], b.agi);
    });
    var foes = Object.keys(bodies).map(function(key) { return bodies[key]; });
    var sum = function(list) { return list.reduce(function(r, v) { return r + v; }, 0); };
    // actors compare themselves with the enemy side (taken with the battle average)
    this._atbFoeAvgAgi = foes.length ? sum(foes) / foes.length : 0;
    values = values.concat(foes);
    if (values.length === 0) return 1;
    return sum(values) / values.length;
};

// Average AGI of the enemy side (a monster counted once), fixed at the start.
BattleManager.atbEnemyAverageAgi = function() {
    if (!this._atbAvgAgi) this._atbAvgAgi = this.measureAtbAverageAgi();
    return this._atbFoeAvgAgi || this._atbAvgAgi;
};

BattleManager.startAtb = function() {
    this._atbStarted = true;
    this._atbRoundTick = 0;
    this._atbRoundEnd = false;
    this._atbSurprisePending = false;
    this._atbAvgAgi = 0;
    this._atbAvgAgi = this.measureAtbAverageAgi();
    this._atbOneTurn = this.isAtbOneTurnTroop();
    // (its count since the enemies acted is this battle's: the last battle's
    // last action, or a save, kept the first turn from slowing them - review 2026-11-03)
    $gameParty.members().forEach(function(a) {
        a._atbDoneRound = false;
        a._atbActsSinceFoe = 0;
        a._atbActedSinceFoe = false;
    });
    var bonus = $.ambushBonus * $.MAX;
    this.atbBattlers().forEach(function(b) {
        var g = Math.random() * $.startMax * $.MAX;
        var ambushing = (this._preemptive && b.isActor()) || (this._surprise && b.isEnemy());
        if (ambushing) g += bonus;
        b.setAtbGauge(g);
        b._atbFirstWait = ambushing ? 0 : $.firstTurnTicks(b);
        b._atbSurpriseStart = !!(this._surprise && b.isEnemy() && b.canGainAtb());
        if (b._atbSurpriseStart) this._atbSurprisePending = true;
    }, this);
    // The original game is in turn 1 while the first actions resolve.
    $gameTroop.increaseTurn();
    this._phase = 'atb';
    $.log('start, round ticks =', $.roundTicks());
};

// In a surprise battle the enemies' opening actions happen at once. Once
// every ambushing enemy has started its action, their next turn counts as
// the first one: it waits Enemy First Turn Min Seconds again.
BattleManager.updateAtbSurpriseWait = function() {
    if (!this._atbSurprisePending) return;
    var pending = $gameTroop.members().some(function(e) {
        return e._atbSurpriseStart && e.canGainAtb();
    });
    if (pending) return;
    this._atbSurprisePending = false;
    $gameTroop.members().forEach(function(e) {
        e._atbSurpriseStart = false;
        if (e.isAlive()) e._atbFirstWait = $.firstTurnTicks(e);
    });
    $.log('surprise over; enemies wait', $.enemyFirstMinSec, 's for their next turn');
};

var _startInput = BattleManager.startInput;
BattleManager.startInput = function() {
    if (!this.isAtb()) return _startInput.call(this);
    if (!this._atbStarted) {
        this.startAtb();
    } else {
        this._phase = 'atb';
    }
};

var _update = BattleManager.update;
BattleManager.update = function() {
    if (this.isAtb() && this._phase === 'atb') {
        // Safety net: never run the gauges of a battle that did not start
        // them (leftover gauges from the last battle would act once, then
        // nothing would ever fill again).
        if (!this._atbStarted) this.startAtb();
        if (!this.isBusy() && !this.updateEvent()) {
            this.updateAtb();
        }
        return;
    }
    _update.call(this);
};

// Troop events (enemy HP pages, switch pages) and forced actions must also
// run while the gauges are filling.
var _updateEvent = BattleManager.updateEvent;
BattleManager.updateEvent = function() {
    if (this.isAtb() && this._phase === 'atb' && !this._processingForcedAction) {
        if (this.isActionForced()) {
            this.processForcedAction();
            return true;
        }
        return this.updateEventMain();
    }
    return _updateEvent.call(this);
};

// The clock runs only between actions: any action animation (some enemies
// have very long ones), messages, troop events and open command windows
// stop every gauge.
$.TICK_PHASES = ['atb'];

BattleManager.canTickAtb = function() {
    if (!this.isAtb() || !this._atbStarted) return false;
    var inputting = !$.waitMode && this._phase === 'input';
    if (!inputting && !$.TICK_PHASES.contains(this._phase)) return false;
    if ($gameMessage.isBusy() || $gameTroop.isEventRunning()) return false;
    return true;
};

// A player is choosing a command here on a turn that slows the enemies
// (co-op adds the joiners asked for theirs: FH_CoopBattle).
BattleManager.atbChoosing = function() {
    var a = this._phase === 'input' ? this._atbInputActor : null;
    return !!a && this.atbChooseSlows(a);
};

// A player's first turn since the enemies last acted slows them while it
// chooses; at the original's extra-turn speed its first two (user decision
// 2026-11-02: the extra turn was lost to the time spent choosing). Each
// player counts its own: in co-op the other players' gauges slow down too,
// so nobody holds the enemies alone.
BattleManager.atbChooseSlows = function(actor) {
    var foe = this.atbEnemyAverageAgi();
    var limit = foe > 0 && actor.agi > foe * $.extraTurnRatio ? $.choosingDelaysFast : $.choosingDelays;
    return (actor._atbActsSinceFoe || 0) < limit;
};

// While such a player chooses, the enemies and the round go at Choosing
// Enemy Rate until they have lost Choosing Max Delay Seconds (user decision
// 2026-10-27: a fast torso took its turn while the player was still choosing
// - nobody is hit twice without acting once, unless it is really slow). The
// budget comes back once nobody is choosing.
// Co-op (user decision 2026-10-29): with several players choosing in turn the
// enemies lost a budget per player, so there every gauge slows, actors too,
// and the budget is Co-op Choosing Max Delay Seconds.
BattleManager.atbEnemyPace = function() {
    if (this.atbTimeStopChoosing()) return 0;
    if (!this.atbChoosing()) {
        this._atbChooseDelay = 0;
        return 1;
    }
    var maxSec = this.atbCoopBattle() ? $.choosingMaxDelayCoopSec : $.choosingMaxDelaySec;
    var left = maxSec * 60 - (this._atbChooseDelay || 0);
    if (left <= 0 || $.choosingRate >= 1) return 1;
    var pace = Math.max($.choosingRate, 1 - left);
    this._atbChooseDelay = (this._atbChooseDelay || 0) + (1 - pace);
    return pace;
};

// Time stop (user decision 2026-11-02): from Time Stop AGI Ratio (AGI 30
// against 10, 3.5 turns per enemy turn) a player's choosing stops time
// altogether - every gauge, the round and the enemies' first-turn wait -
// on every turn of its, with no count or time limit.
BattleManager.atbStopsTime = function(actor) {
    var foe = this.atbEnemyAverageAgi();
    return !!actor && foe > 0 && actor.agi >= foe * $.timeStopRatio;
};

// A player choosing now stops time (co-op adds the joiners asked for theirs:
// FH_CoopBattle).
BattleManager.atbTimeStopChoosing = function() {
    var a = this._phase === 'input' ? this._atbInputActor : null;
    return this.atbStopsTime(a);
};

// Other players fight in this battle (FH_CoopBattle).
BattleManager.atbCoopBattle = function() {
    return false;
};

// How often each actor has acted since the enemies last did: an enemy's
// action clears it for every actor (not an installation's: a bear trap acts
// after every actor's action), an actor's own action counts.
var _startActionChoosing = BattleManager.startAction;
BattleManager.startAction = function() {
    var subject = this._subject;
    if (this.isAtb() && subject) {
        if (subject.isActor()) {
            subject._atbActedSinceFoe = true;
            subject._atbActsSinceFoe = (subject._atbActsSinceFoe || 0) + 1;
        } else if (!$.isInstallation(subject)) {
            $gameParty.members().forEach(function(a) {
                a._atbActedSinceFoe = false;
                a._atbActsSinceFoe = 0;
            });
        }
    }
    _startActionChoosing.call(this);
};

BattleManager.tickAtb = function() {
    this.updateAtbSurpriseWait(); // an ambusher may die before it acts
    var avg = this.atbAverageAgi();
    var pace = this.atbEnemyPace();
    // (a time stop holds every gauge, also in a battle with no joiner - user
    // decision 2026-11-02; the slowdown while choosing is the co-op one only)
    var actorPace = pace === 0 ? 0 : pace < 1 && this.atbCoopBattle() ? pace : 1;
    this.atbBattlers().forEach(function(b) {
        if (b._atbFirstWait > 0 && !(pace === 0 && b.isEnemy())) b._atbFirstWait--;
        // The acting battler fills too, so a long attack animation does
        // not cost its owner extra time.
        if (b === this._atbActing && this._phase === 'input') return;
        if (this._atbOneTurn && b.isActor() && b._atbDoneRound) return;
        // canGainAtb() without isBattleMember(): the list already holds only
        // battle members, and that check rebuilds the party list per actor.
        if (b.isAlive() && b.isAppeared()) {
            b.setAtbGauge(b.atbGauge() + $.MAX / $.fillTicks(b) * b.atbRate(avg) * (b.isEnemy() ? pace : actorPace));
        } else if (b.isDead()) {
            b.setAtbGauge(0);
        }
    }, this);
    this._atbRoundTick += pace;
    if (this._atbOneTurn) return; // rounds follow the actors (updateAtb)
    if (this._atbRoundTick >= $.roundTicks()) {
        this._atbRoundTick = 0;
        this._atbRoundPending = true;
    }
};

// Active mode: an enemy whose gauge fills while an actor is still choosing
// acts right away. The command windows close, the enemy (and a pending
// round end) runs, then the actor gets its command window back.
BattleManager.atbEnemyWaiting = function() {
    return $gameTroop.members().some(function(e) { return e.isAtbReady(); });
};

BattleManager.suspendAtbInput = function() {
    var actor = this._atbInputActor;
    if (!actor) return;
    $.log('input interrupted:', actor.name());
    this._atbSuspended = actor;
    this._atbInputActor = null;
    this._atbActing = null;
    actor.clearActions();
    this.changeActor(-1, 'waiting');
    this._phase = 'atb';
};

BattleManager.updateAtb = function() {
    if (this._atbOneTurn && !this._atbRoundPending && this.allActorsDoneAtbRound()) {
        this._atbRoundPending = true;
    }
    var held = this._atbSuspended;
    if (held && !held.canGainAtb()) {
        this._atbSuspended = null;
        this._atbInputMemory = null;
        held.setAtbGauge(0);
    }
    // A battler whose gauge is full acts before the round ends, as the
    // original's turn end comes after that turn's actions (an enemy filling
    // in one round, 5 s, became ready with the round end each time and acted
    // right after it, on the next round's first tick: troop 212's Moonless
    // beast on every round, play test 2026-10-31).
    var ready = this.atbReadyBattler();
    if (this._atbRoundPending && !ready) {
        this._atbRoundPending = false;
        this.startAtbRoundEnd();
        return;
    }
    if (this.atbSpringTrapOnGuard()) return; // the trap page runs first
    ready = ready || this.atbReadyBattler();
    if (ready) {
        if (ready.isEnemy()) this.pullAtbBodyParts(ready);
        this.startAtbTurn(ready);
    }
};

// Bear trap (enemy 50, troops 6/10/11/21/49 villagers and 96/118 Abella).
// Original: a turn-end page sets the trap (skill 296/543 message, enemy 50
// appears, V120 Bear_trap_random = 6). At the next turn end it arms it
// (V120 -> 7, SW2876 Beartrap_set) and the SW2876 page resolves it at once:
// if the player guarded that turn (CE153 Just Guard_BATTLE turns SW1281
// GUARD_BATTLE on) "You jump over the bear trap!", else a coin toss (lost:
// skill 297, leg cut); the trap is gone either way. SW1281 goes off at every
// turn end. With gauges a round is 5 s, so a fast actor could guard, get its
// next turn before the round end and guard again. Here a guard made while a
// set trap waits arms it right away, so the trap resolves next, before
// anyone's next turn.
$.GUARD_TRAP = { enemyId: 50, armSwitch: 2876, guardSwitch: 1281, stateVar: 120, placed: 6, armed: 7 };

BattleManager.atbSpringTrapOnGuard = function() {
    var t = $.GUARD_TRAP;
    if (!$gameSwitches.value(t.guardSwitch) || $gameSwitches.value(t.armSwitch)) return false;
    if ($gameVariables.value(t.stateVar) !== t.placed) return false;
    var trap = $gameTroop.members().filter(function(e) {
        return e.enemyId() === t.enemyId && e.isAlive() && e.isAppeared();
    })[0];
    if (!trap) return false;
    var troop = $gameTroop.troop();
    var hasPage = !!troop && troop.pages.some(function(page) {
        return page.conditions.switchValid && page.conditions.switchId === t.armSwitch;
    });
    if (!hasPage) return false;
    $gameVariables.setValue(t.stateVar, t.armed);
    $gameSwitches.setValue(t.armSwitch, true);
    trap.setAtbGauge($.MAX); // it is the trap's move now
    $.log('guard: the bear trap resolves now');
    return true;
};

// Installations (user request 2026-10-19): the bear trap (enemy 50) and the
// gasoline canister (84) are things, not fighters. They took turns on
// gauges of their own, as often as anyone. Now their gauges do not fill with
// time: right after an actor's action (this PC's player, a joiner, anyone in
// the party) each one there gets its turn, before the next battler. A guard
// still springs a set trap at once (above, it fills the trap's gauge).
// (Doors, tanks and the like have no turns to speak of; bosses that act
// through troop events are left alone.)
$.INSTALLATION_ENEMIES = [50, 84];

$.isInstallation = function(battler) {
    return !!battler && battler.isEnemy() && $.INSTALLATION_ENEMIES.indexOf(battler.enemyId()) >= 0;
};

var _startAtbInstallations = BattleManager.startAtb;
BattleManager.startAtb = function() {
    _startAtbInstallations.call(this);
    $gameTroop.members().forEach(function(e) {
        if ($.isInstallation(e)) e.setAtbGauge(0);
    });
};

// The troop's installations, found once per troop (its enemy list is new with
// every battle, also one taken over from another PC); nothing made per tick.
$.installCache = { enemies: null, list: [], gauges: [] };
$.troopInstallations = function() {
    var c = $.installCache, enemies = $gameTroop._enemies;
    if (c.enemies !== enemies || c.count !== enemies.length) {
        c.enemies = enemies;
        c.count = enemies.length;
        c.list = enemies.filter($.isInstallation);
    }
    return c.list;
};

var _tickAtbInstallations = BattleManager.tickAtb;
BattleManager.tickAtb = function() {
    var list = $.troopInstallations();
    if (!list.length) return _tickAtbInstallations.call(this);
    // what they had before this tick: they do not fill with time
    var gauges = $.installCache.gauges;
    for (var i = 0; i < list.length; i++) gauges[i] = list[i].atbGauge();
    _tickAtbInstallations.call(this);
    for (var j = 0; j < list.length; j++) if (list[j].isAlive()) list[j].setAtbGauge(gauges[j]);
};

BattleManager.atbReadyInstallations = function() {
    $gameTroop.members().forEach(function(e) {
        if (!$.isInstallation(e) || !e.canGainAtb()) return;
        e._atbFirstWait = 0;
        e.setAtbGauge($.MAX);
    });
};

// A monster is several enemies, one per body part ("Janitor [torso]",
// "Janitor [left arm]"...). In the original every part acts in the same
// turn, so the parts share one clock: when one is ready, the rest of the
// body acts right after it instead of on gauges of their own.
// Only parts with the same base AGI are pulled. A faster part (Henryk's
// right arm, Rher's eyes) keeps its own gauge and acts more often on its
// own, as it did with Galv_ExAgiTurn's extra turns, without dragging the
// whole body along.
$.bodyKey = function(enemy) {
    var name = enemy.originalName().replace(/\s*\[[^\]]*\]\s*$/, '');
    return name + '#' + (enemy._letter || '');
};

BattleManager.pullAtbBodyParts = function(enemy) {
    // A part pulled in by the body does not pull the others again.
    if (enemy._atbPulled) {
        enemy._atbPulled = false;
        return;
    }
    var key = $.bodyKey(enemy);
    var agi = enemy.paramBase(6);
    $gameTroop.members().forEach(function(e) {
        if (e !== enemy && e.canGainAtb() && $.bodyKey(e) === key && e.paramBase(6) === agi) {
            e._atbPulled = true;
            e._atbFirstWait = 0;
            e.setAtbGauge($.MAX);
        }
    });
};

BattleManager.atbReadyBattler = function() {
    var list = this.atbBattlers().filter(function(b) { return b.isAtbReady(); });
    var held = this._atbSuspended;
    if (held && list.length > 1) list = list.filter(function(b) { return b !== held; });
    if (list.length === 0) return null;
    list.sort(function(a, b) {
        if (a.isActor() !== b.isActor()) return a.isActor() ? -1 : 1;
        return b.agi - a.agi;
    });
    return list[0];
};

BattleManager.startAtbRoundEnd = function() {
    $.log('round end, turn', $gameTroop.turnCount());
    this._atbRoundEnd = true;
    this._atbRoundTick = 0;
    $gameParty.members().forEach(function(a) { a._atbDoneRound = false; });
    this._preemptive = false;
    this._surprise = false;
    this._phase = 'turnEnd';
};

var _updateTurnEnd = BattleManager.updateTurnEnd;
BattleManager.updateTurnEnd = function() {
    if (!this.isAtb()) return _updateTurnEnd.call(this);
    // All "Turn End" pages have run; open the next round.
    this._atbRoundEnd = false;
    $gameTroop.increaseTurn();
    this.refreshStatus();
    this._phase = 'atb';
};

BattleManager.snapshotAtbStates = function(battler) {
    var snap = {};
    battler._states.forEach(function(id) {
        snap[id] = battler._stateTurns[id] || 0;
    });
    battler._atbStateSnap = snap;
};

BattleManager.startAtbTurn = function(battler) {
    var avg = this.atbAverageAgi();
    $.log('turn:', battler.name(), 'agi', battler.agi, 'avg', avg.toFixed(1),
        'rate', battler.atbRate(avg).toFixed(2), 'tick', Math.round(this._atbRoundTick));
    // The gauge stays full while choosing and empties when the action starts.
    if (battler === this._atbSuspended) {
        this._atbSuspended = null; // interrupted turn: already started
    } else {
        battler.onTurnStart();
        battler.refresh();
        this.snapshotAtbStates(battler);
    }
    this._atbActing = battler;
    this._subject = null;
    battler.makeActions();
    if (battler.isActor() && battler.canInput()) {
        this._atbInputActor = battler;
        this._phase = 'input';
        this.changeActor($gameParty.members().indexOf(battler), 'undecided');
        return;
    }
    battler.setAtbGauge(0); // the next wait starts with the action
    if (battler._atbSurpriseStart) {
        battler._atbSurpriseStart = false;
        this.updateAtbSurpriseWait();
    }
    this._subject = battler;
    this._phase = 'turn';
};

BattleManager.finishAtbInput = function() {
    var actor = this._atbInputActor;
    this._atbInputActor = null;
    this.changeActor(-1, 'waiting');
    actor.setAtbGauge(0); // the next wait starts with the action
    this._subject = actor;
    this._phase = 'turn';
};

var _selectNextCommand = BattleManager.selectNextCommand;
BattleManager.selectNextCommand = function() {
    if (!this.isAtb()) return _selectNextCommand.call(this);
    if (this._phase !== 'input' || !this._atbInputActor) return;
    var actor = this.actor();
    if (!actor) {
        // Coming back from the party command window ("Fight").
        this.changeActor($gameParty.members().indexOf(this._atbInputActor), 'undecided');
        return;
    }
    if (actor.selectNextCommand()) return;
    this.finishAtbInput();
};

var _selectPreviousCommand = BattleManager.selectPreviousCommand;
BattleManager.selectPreviousCommand = function() {
    if (!this.isAtb()) return _selectPreviousCommand.call(this);
    var actor = this.actor();
    if (actor && actor.selectPreviousCommand()) return;
    // No previous actor in ATB: drop to the party command window (escape),
    // keeping this actor's turn reserved.
    if (actor) this.changeActor(-1, 'undecided');
};

// Called by a failed escape and by malcommandequip after an equip change:
// both should consume only the current actor's turn.
var _startTurn = BattleManager.startTurn;
BattleManager.startTurn = function() {
    if (!this.isAtb()) return _startTurn.call(this);
    if (this._atbInputActor) {
        this._atbInputActor.clearActions();
        this.finishAtbInput();
    }
};

var _getNextSubject = BattleManager.getNextSubject;
BattleManager.getNextSubject = function() {
    if (!this.isAtb()) return _getNextSubject.call(this);
    return null;
};

var _updateTurn = BattleManager.updateTurn;
BattleManager.updateTurn = function() {
    if (!this.isAtb()) return _updateTurn.call(this);
    $gameParty.requestMotionRefresh();
    if (this._subject) {
        this.processTurn();
        return;
    }
    if (this._atbActing) this.finishAtbTurn(this._atbActing);
    this._phase = this._atbRoundEnd ? 'turnEnd' : 'atb';
};

// The state malcommandequip_edits adds after an equip change (125).
$.equipCostState = function() {
    var mal = window.Mal;
    return (mal && mal.Param && Number(mal.Param.coolD)) || 0;
};

BattleManager.finishAtbTurn = function(battler) {
    this._atbActing = null;
    // the turn went by without the windows (stunned...): forget them
    if (this._atbInputMemory && this._atbInputMemory.actor === battler) this._atbInputMemory = null;
    if (battler.isActor()) battler._atbDoneRound = true;
    battler._atbPulled = false;
    var snap = battler._atbStateSnap || {};
    battler._atbStateSnap = null;
    // Turn-end states the battler got during its own turn skip this tick.
    // Not the equip-change state (malcommandequip_edits): it stands for the
    // turn the change cost, which is this one; kept, it skipped the next.
    var equipCost = $.equipCostState();
    battler._states.forEach(function(id) {
        var state = $dataStates[id];
        if (!state || state.autoRemovalTiming !== 2 || id === equipCost) return;
        if (snap[id] === undefined || (battler._stateTurns[id] || 0) > snap[id]) {
            battler._stateTurns[id] = (battler._stateTurns[id] || 0) + 1;
        }
    });
    battler.onTurnEnd();
    this.refreshStatus();
    this._logWindow.displayAutoAffectedStatus(battler);
    this._logWindow.displayRegeneration(battler);
};

// Installations (above): a turn right after an actor's action, first.
var _finishAtbTurnInstallations = BattleManager.finishAtbTurn;
BattleManager.finishAtbTurn = function(battler) {
    _finishAtbTurnInstallations.call(this, battler);
    if (battler && battler.isActor()) this.atbReadyInstallations();
};

// A ready installation goes before anyone else.
var _atbReadyBattlerInstallations = BattleManager.atbReadyBattler;
BattleManager.atbReadyBattler = function() {
    var held = this._atbSuspended, list = $.troopInstallations();
    for (var i = 0; i < list.length; i++) {
        if (list[i] !== held && list[i].isAtbReady()) return list[i];
    }
    return _atbReadyBattlerInstallations.call(this);
};

// A forced action must not let the forced battler continue with its own
// queued actions; give the turn back to whoever was acting before.
// $.RESUME_PHASES are the phases a forced action can interrupt without a
// subject of their own: the battle-start page of an ambush ('start', e.g.
// Villager-Knives' lunge), the gauges and the round end.
$.RESUME_PHASES = ['start', 'atb', 'turnEnd'];

var _startActionAtb = BattleManager.startAction;
BattleManager.startAction = function() {
    this._atbActionStarted = true;
    var subject = this._subject;
    _startActionAtb.call(this);
    // the engine calls removeCurrentAction on it right after (forced action)
    if (!this._subject && this._atbInForceStart && subject) this._subject = subject;
};

var _processForcedAction = BattleManager.processForcedAction;
BattleManager.processForcedAction = function() {
    var forced = this.isAtb() && this._actionForcedBattler;
    if (forced) {
        this._atbPreForceSubject = this._subject;
        this._atbPreForcePhase = this._phase;
        this._atbActionStarted = false;
    }
    // An action that ends inside startAction (nothing to do, the battler
    // fell meanwhile) must not hand the turn back before the engine's
    // removeCurrentAction on the forced battler: that read a null subject
    // (crash on a guest's PC, a defeat with a forced action, 0.38.1).
    this._atbInForceStart = !!forced;
    this._atbResumeLater = false;
    try {
        _processForcedAction.call(this);
    } finally {
        this._atbInForceStart = false;
        if (this._atbResumeLater) {
            this._atbResumeLater = false;
            this.resumeAfterAtbForce();
        }
    }
    // A dead battler cannot be forced (remove_current_action_of_null_fix):
    // no action starts and no endAction comes to clear YEP's forced flag,
    // which would block the troop interpreter, and with it every gauge.
    if (forced && this._processingForcedAction && !this._atbActionStarted) {
        $.log('forced action skipped: battler cannot act');
        this._processingForcedAction = false;
        if (this._forceActionQueue && this._forceActionQueue.length) this._forceActionQueue.shift();
        this.resumeAfterAtbForce();
    }
};

BattleManager.resumeAfterAtbForce = function() {
    var resumePhase = this._atbPreForcePhase;
    this._subject = this._atbPreForceSubject;
    this._atbPreForceSubject = null;
    this._atbPreForcePhase = null;
    if ($.RESUME_PHASES.contains(resumePhase)) this._phase = resumePhase;
};

var _endAction = BattleManager.endAction;
BattleManager.endAction = function() {
    var wasForced = this.isAtb() && this._processingForcedAction;
    _endAction.call(this);
    if (wasForced && this._atbInForceStart) this._atbResumeLater = true; // after the engine is done
    else if (wasForced) this.resumeAfterAtbForce();
};

//=============================================================================
// Gauge display
//=============================================================================

function Sprite_FHAtbGauges() {
    this.initialize.apply(this, arguments);
}

Sprite_FHAtbGauges.prototype = Object.create(Sprite.prototype);
Sprite_FHAtbGauges.prototype.constructor = Sprite_FHAtbGauges;

Sprite_FHAtbGauges.ROW_H = 20;
Sprite_FHAtbGauges.WIDTH = 180;
Sprite_FHAtbGauges.NAME_W = 70;
Sprite_FHAtbGauges.BAR_W = Sprite_FHAtbGauges.WIDTH - Sprite_FHAtbGauges.NAME_W - 4;

// Two layers: the names (outlined text, slow to draw) change only when the
// list or the acting battler does; the bars change every few frames while
// they fill and are plain rectangles.
Sprite_FHAtbGauges.prototype.initialize = function() {
    Sprite.prototype.initialize.call(this);
    var h = Sprite_FHAtbGauges.ROW_H * 12;
    this.bitmap = new Bitmap(Sprite_FHAtbGauges.WIDTH, h);
    this.bitmap.fontSize = 14;
    this._bars = new Sprite(new Bitmap(Sprite_FHAtbGauges.WIDTH, h));
    this.addChild(this._bars);
    this.x = $.gaugeX;
    this.y = $.gaugeY;
    this._nameKey = '';
    this._barKey = '';
};

Sprite_FHAtbGauges.prototype.battlers = function() {
    var list = $gameParty.battleMembers().slice();
    if ($.showEnemies) {
        list = list.concat($gameTroop.members().filter(function(e) { return e.isAppeared(); }));
    }
    return list.filter(function(b) { return b.isAlive(); });
};

Sprite_FHAtbGauges.prototype.update = function() {
    Sprite.prototype.update.call(this);
    this.visible = BattleManager.isAtb() && !$gameMessage.isBusy() &&
        !BattleManager.isBattleEnd();
    if (!this.visible) return;
    var list = this.battlers();
    var nameKey = '', barKey = '';
    for (var i = 0; i < list.length; i++) {
        var b = list[i];
        var acting = b === BattleManager._atbActing;
        nameKey += b.name() + (acting ? '*|' : '|');
        // one step per bar pixel: the bar is redrawn only when it can change
        barKey += this.barWidth(b) + (acting ? '*|' : '|');
    }
    if (nameKey !== this._nameKey) {
        this._nameKey = nameKey;
        this.redrawNames(list);
    }
    if (barKey !== this._barKey) {
        this._barKey = barKey;
        this.redrawBars(list);
    }
};

Sprite_FHAtbGauges.prototype.barWidth = function(battler) {
    return Math.floor((Sprite_FHAtbGauges.BAR_W - 2) * battler.atbGauge() / $.MAX);
};

Sprite_FHAtbGauges.prototype.redrawNames = function(list) {
    var bmp = this.bitmap;
    var h = Sprite_FHAtbGauges.ROW_H;
    bmp.clear();
    list.forEach(function(b, i) {
        var acting = b === BattleManager._atbActing;
        bmp.textColor = acting ? '#ffd966' : (b.isEnemy() ? '#ff9a9a' : '#ffffff');
        bmp.drawText(b.name(), 0, i * h, Sprite_FHAtbGauges.NAME_W, h, 'left');
    });
};

Sprite_FHAtbGauges.prototype.redrawBars = function(list) {
    var bmp = this._bars.bitmap;
    var h = Sprite_FHAtbGauges.ROW_H;
    var x = Sprite_FHAtbGauges.NAME_W;
    bmp.clear();
    list.forEach(function(b, i) {
        var acting = b === BattleManager._atbActing;
        var by = i * h + h / 2 - 3;
        bmp.fillRect(x, by, Sprite_FHAtbGauges.BAR_W, 6, 'rgba(0,0,0,0.6)');
        var color = acting || b.atbGauge() >= $.MAX ? '#ffd966' : (b.isEnemy() ? '#c04040' : '#7fb3d5');
        bmp.fillRect(x + 1, by + 1, this.barWidth(b), 4, color);
    }, this);
};

// The equipment change screen (commandequip) always pauses the battle.
Scene_Battle.prototype.isFHAtbEquipOpen = function() {
    return [this._equipCommandWindow, this._slotWindow, this._equipItemWindow].some(function(w) {
        return w && w.active;
    });
};

Scene_Battle.prototype.canTickFHAtb = function() {
    if (!this.isActive() || !BattleManager.canTickAtb()) return false;
    if (!this.isAnyInputWindowActive()) return true;
    return !$.waitMode && !this.isFHAtbEquipOpen();
};

// Close every command/selection window without consuming the turn.
Scene_Battle.prototype.suspendFHAtbInput = function() {
    BattleManager._atbInputMemory = this.captureFHAtbInput(BattleManager._atbInputActor);
    [this._skillWindow, this._itemWindow, this._actorWindow, this._enemyWindow,
        this._extraSkillWindow].forEach(function(w) {
        if (w) {
            w.deactivate();
            w.hide();
        }
    });
    if (this._helpWindow) this._helpWindow.hide();
    this._partyCommandWindow.deactivate();
    this._actorCommandWindow.deactivate();
    this.endCommandSelection();
    $gameParty.select(null);
    $gameTroop.select(null);
    BattleManager.suspendAtbInput();
};

//-----------------------------------------------------------------------------
// Command memory: when an enemy interrupts the command windows, the actor's
// windows come back where they were (command, skill/item list, target).
// Things are remembered by object, not position: if the skill can no longer
// be used or the target is gone, the restore stops one step earlier.
//-----------------------------------------------------------------------------

Scene_Battle.prototype.captureFHAtbInput = function(actor) {
    var cmd = this._actorCommandWindow;
    if (!actor || !cmd || cmd.index() < 0) return null;
    var mem = { actor: actor, symbol: cmd.currentSymbol(), ext: cmd.currentExt(), layer: 'command' };
    var list = mem.symbol === 'skill' ? this._skillWindow : mem.symbol === 'item' ? this._itemWindow : null;
    var extra = this._extraSkillWindow && this._extraSkillWindow.active;
    if (this._enemyWindow.active || this._actorWindow.active) {
        var action = actor.inputtingAction();
        mem.layer = 'target';
        mem.item = action ? action.item() : null;
        mem.target = this._enemyWindow.active ? this._enemyWindow.enemy() : this._actorWindow.actor();
    } else if (list && (list.active || extra)) {
        mem.layer = 'list'; // an Extra Skill List comes back as its parent skill
        mem.item = list.item();
    } else if (!cmd.active) {
        return null; // e.g. the party command window: nothing to bring back
    }
    mem.listIndex = list ? list.index() : -1;
    return mem;
};

Scene_Battle.prototype.restoreFHAtbInput = function(mem) {
    var cmd = this._actorCommandWindow;
    var index = -1;
    for (var i = 0; i < cmd._list.length; i++) {
        if (cmd._list[i].symbol === mem.symbol && cmd._list[i].ext === mem.ext) {
            index = i;
            break;
        }
    }
    if (index < 0) return;
    cmd.select(index);
    if (mem.layer === 'command' || !cmd.isCurrentItemEnabled()) return;
    var list = null;
    if (mem.symbol === 'skill' || mem.symbol === 'item') {
        cmd.deactivate(); // what processOk does before its handler
        if (mem.symbol === 'skill') this.commandSkill(); else this.commandItem();
        list = mem.symbol === 'skill' ? this._skillWindow : this._itemWindow;
        var at = mem.item ? list._data.indexOf(mem.item) : -1;
        var fallback = Math.min(mem.listIndex, list.maxItems() - 1);
        list.select(at >= 0 ? at : Math.max(0, fallback));
        if (mem.layer !== 'target' || at < 0 || !list.isCurrentItemEnabled()) return;
        list.deactivate();
        if (list === this._skillWindow) this.onSkillOk(); else this.onItemOk();
    } else if (mem.symbol === 'attack' && mem.layer === 'target') {
        cmd.deactivate();
        this.commandAttack();
    } else {
        return;
    }
    this.restoreFHAtbTarget(mem);
};

Scene_Battle.prototype.restoreFHAtbTarget = function(mem) {
    if (!mem.target) return;
    if (this._enemyWindow.active) {
        var e = this._enemyWindow._enemies ? this._enemyWindow._enemies.indexOf(mem.target) : -1;
        if (e >= 0) this._enemyWindow.select(e);
    } else if (this._actorWindow.active) {
        var a = $gameParty.members().indexOf(mem.target);
        if (a >= 0) this._actorWindow.select(a);
    }
};

var _startActorCommandSelectionAtb = Scene_Battle.prototype.startActorCommandSelection;
Scene_Battle.prototype.startActorCommandSelection = function() {
    _startActorCommandSelectionAtb.call(this);
    this.sayFHAtbTimeStop(BattleManager.actor());
    var mem = BattleManager._atbInputMemory;
    BattleManager._atbInputMemory = null;
    if (!mem || mem.actor !== BattleManager.actor()) return;
    try {
        this.restoreFHAtbInput(mem);
    } catch (e) {
        $.log('command memory: restore failed', e.message); // the plain window stays
    }
};

// The first time in a battle a player's own command window opens at the
// time-stop speed, a line in the battle log (the screen of that player).
Scene_Battle.prototype.sayFHAtbTimeStop = function(actor) {
    if (!actor || !BattleManager.atbStopsTime(actor)) return;
    if (actor._atbTimeStopSaid === BattleManager._atbBattleId) return;
    actor._atbTimeStopSaid = BattleManager._atbBattleId;
    var ko = window.FH && FH.Coop && FH.Coop.koreanData && FH.Coop.koreanData();
    if (this._logWindow) this._logWindow.addText(ko ? $.TIME_STOP_TEXT_KO : $.TIME_STOP_TEXT);
    $.log('time stop:', actor.name(), 'agi', actor.agi);
};

var _Scene_Battle_update = Scene_Battle.prototype.update;
Scene_Battle.prototype.update = function() {
    if (this.canTickFHAtb()) {
        BattleManager.tickAtb();
        if (!$.waitMode && BattleManager._phase === 'input' && !this.isFHAtbEquipOpen() &&
                BattleManager.atbEnemyWaiting()) {
            this.suspendFHAtbInput();
        }
    }
    _Scene_Battle_update.call(this);
};

var _createDisplayObjects = Scene_Battle.prototype.createDisplayObjects;
Scene_Battle.prototype.createDisplayObjects = function() {
    _createDisplayObjects.call(this);
    if ($.enabled) {
        this._fhAtbGauges = new Sprite_FHAtbGauges();
        this.addChild(this._fhAtbGauges);
    }
};

// An enemy a troop event turns into another one (Change Enemy, 336) starts
// a new gauge: the original's new form acts in the next turn, after the
// players chose (play test 2026-10-31: troop 212's "Lurker in the dark"
// turns into the Moonless beast at a turn end with a gauge it had built up;
// the beast and the parts pulled along with it, $.bodyKey, acted at once).
var _transformAtb = Game_Enemy.prototype.transform;
Game_Enemy.prototype.transform = function(enemyId) {
    var was = this._enemyId;
    _transformAtb.call(this, enemyId);
    if (BattleManager.isAtb() && was !== enemyId && $gameParty.inBattle()) {
        this.setAtbGauge(0);
        $.log('transform:', this.name(), '- a new gauge');
    }
};

// A troop page "once per turn" on a switch (span Turn: troop 212 page 6 on
// SW200 SKILLS_BATTLE, set by every skill's common event: Run!'s escape roll,
// Leg sweep) ran once a round. With gauges a round holds several actions
// (faster actors, co-op): the next skill's page waited for the next round
// and went off later, out of turn (play test 2026-10-31: Run! used again and
// again). The switch turned on anew opens its page again.
var _setValueAtbPage = Game_Switches.prototype.setValue;
Game_Switches.prototype.setValue = function(switchId, value) {
    var was = !!this._data[switchId];
    _setValueAtbPage.call(this, switchId, value);
    if (was || !value || this !== $gameSwitches || !BattleManager.isAtb() || !$gameParty.inBattle()) return;
    var troop = $gameTroop.troop();
    if (!troop) return;
    troop.pages.forEach(function(page, i) {
        var c = page.conditions;
        if (page.span === 1 && c.switchValid && c.switchId === switchId && $gameTroop._eventFlags[i]) {
            $gameTroop._eventFlags[i] = false;
        }
    });
};

})(FH.ATB);
