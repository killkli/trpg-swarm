/**
 * Regression checks for the engine fixes on this branch: CoC dying/unconscious, D&D healing spells and
 * slots, damage types, villain actions, CoC First Aid, scene/target options, hazard cells, adjust/temp HP,
 * and save damage downing allies.
 *
 * Run: node --experimental-strip-types tests/engine-fixes.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { campaignBookToWorldState } from '../src/engine/campaignImport.ts';
import { resolveCoC7eOpposedCombat, absorbTempHp, adjustDamageForType, applyCoC7eDamage, resolveDnD5eSavingThrow } from '../src/engine/rulesEngine.ts';
import { DeterministicRNG } from '../src/engine/dice.ts';
import { resolvePbtALastBreath } from '../src/engine/pbtaLastBreath.ts';
import { adjustCombatant, stepCombatTurn } from '../src/engine/stateStore.ts';
import { carryPartyIntoScene } from '../src/engine/sceneCarry.ts';

import { existsSync } from 'node:fs';

const load = (name: string) => {
  const candidates = [
    new URL(`../examples/campaign-${name}.json`, import.meta.url),
    new URL(`../examples/coc7e/${name}.json`, import.meta.url),
    new URL(`../examples/dnd5e/${name}.json`, import.meta.url),
    new URL(`../examples/pbta/${name}.json`, import.meta.url),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return JSON.parse(readFileSync(c, 'utf8'));
  }
  throw new Error(`Scenario ${name} not found`);
};

// 1a. Major wound at 0 HP -> unconscious + dying, still alive.
const coc = campaignBookToWorldState(load('arkham-shadow'));
const hero = coc.combatants['trpg-companion-vanguard'];
hero.hp = 8;
applyCoC7eDamage(hero, 11);
assert.equal(hero.hp, 0);
assert.equal(hero.isAlive, true);
for (const c of ['major_wound', 'unconscious', 'dying']) assert.ok(hero.conditions.includes(c), c);

// 1b. No major wound at 0 HP -> unconscious only.
const rogue = coc.combatants['trpg-companion-rogue'];
rogue.hp = 2;
applyCoC7eDamage(rogue, 2);
assert.equal(rogue.isAlive, true);
assert.ok(rogue.conditions.includes('unconscious'));
assert.ok(!rogue.conditions.includes('dying'));

// 1c. Monsters still die at 0 HP.
const cultist = Object.values(coc.combatants).find((c) => c.faction === 'enemy');
if (cultist) {
  applyCoC7eDamage(cultist, 999);
  assert.equal(cultist.isAlive, false);
}

// 1d. A dying actor's turn is a CON check, never an attack; a downed one just loses the turn.
const state = campaignBookToWorldState(load('arkham-shadow'));
const dying = state.combatants['trpg-companion-vanguard'];
dying.hp = 0;
dying.conditions.push('unconscious', 'dying');
const turn = stepCombatTurn(state, 'trpg-companion-vanguard');
assert.match(turn.resolutionNarrative, /CON/);

// 2. Healing spells and slots from `spellcasting`.
const dnd = campaignBookToWorldState(load('crimson-crypt'));
const healer = dnd.combatants['trpg-companion-healer'];
const ids = healer.actions.filter((a) => a.type === 'heal').map((a) => a.id);
assert.ok(ids.includes('cure_wounds') && ids.includes('healing_word'), `heal ids: ${ids}`);
assert.equal(healer.stats.spellSlots?.[1]?.max, 4);

// 3. Damage-type modifiers read from the campaign book (skeleton: vulnerable to bludgeoning, immune to poison).
const skeleton = Object.values(dnd.combatants).find((c) => c.id.startsWith('enemy-skeleton'));
assert.ok(skeleton, 'skeleton present');
assert.deepEqual(skeleton.stats.vulnerabilities, ['bludgeoning']);
assert.deepEqual(skeleton.stats.immunities, ['poison']);
assert.equal(adjustDamageForType(6, 'bludgeoning', skeleton), 12);
assert.equal(adjustDamageForType(6, 'poison', skeleton), 0);
assert.equal(adjustDamageForType(6, 'slashing', skeleton), 6);
assert.equal(adjustDamageForType(7, undefined, skeleton), 7);
const wightLike = { ...skeleton, stats: { ...skeleton.stats, resistances: ['necrotic'], vulnerabilities: [] } };
assert.equal(adjustDamageForType(7, 'necrotic', wightLike), 3);

// 4. Villain actions: summoned skeletons wait in reserve and join on the boss's turn.
const finale = load('crimson-crypt');
finale.sessionState.sceneId = 'area-3-abyssal-sanctum';
const boss = campaignBookToWorldState(finale);
assert.equal(boss.villainActions?.length, 2);
assert.deepEqual(Object.keys(boss.reserve ?? {}).sort(), ['enemy-honor-guard-skeleton-1', 'enemy-honor-guard-skeleton-2']);
assert.ok(!('enemy-honor-guard-skeleton-1' in boss.combatants));
assert.ok(!boss.initiativeOrder.includes('enemy-honor-guard-skeleton-1'));
stepCombatTurn(boss, 'boss-sir-malcolm-wight');
assert.ok('enemy-honor-guard-skeleton-1' in boss.combatants && 'enemy-honor-guard-skeleton-2' in boss.combatants);
assert.ok(boss.initiativeOrder.includes('enemy-honor-guard-skeleton-2'));
assert.equal(Object.keys(boss.reserve ?? {}).length, 0);
assert.equal(boss.villainActions?.filter((v) => v.fired).length, 1, 'round-2 action not fired yet');

// 5. CoC First Aid: the healer gets a heal action; a failed roll changes nothing, a success stabilises.
const aid = campaignBookToWorldState(load('arkham-shadow'));
const medic = aid.combatants['trpg-companion-healer'];
const firstAid = medic.actions.find((a) => a.id === 'first_aid');
assert.ok(firstAid && firstAid.type === 'heal', 'first aid heal action');
const downed = aid.combatants['trpg-companion-vanguard'];
downed.hp = 0;
downed.conditions.push('unconscious', 'dying');
firstAid.attackBonus = 0;
stepCombatTurn(aid, 'trpg-companion-healer', 0.65, 'first_aid');
assert.ok(downed.conditions.includes('dying'), 'failed first aid leaves the investigator dying');
firstAid.attackBonus = 100;
stepCombatTurn(aid, 'trpg-companion-healer', 0.65, 'first_aid');
assert.ok(!downed.conditions.includes('dying') && downed.hp === 1, 'successful first aid stabilises');

// 6. Scene override: load the book at another scene; a bad id lists the valid ones.
const atPier = campaignBookToWorldState(load('arkham-shadow'), 42, 'scene-3-pier-4-warehouse');
assert.ok('enemy-dock-deep-one-scout' in atPier.combatants);
assert.throws(
  () => campaignBookToWorldState(load('arkham-shadow'), 42, 'nope'),
  /Valid scene ids: scene-1-miskatonic-archive/
);

// 7. step-turn --target: the chosen candidate aims at the named combatant; a bad target lists the legal ones.
for (const target of ['enemy-skeleton-guard-1', 'enemy-skeleton-guard-2']) {
  const duel = campaignBookToWorldState(load('crimson-crypt'));
  const aimed = stepCombatTurn(duel, 'player-hero', 0.65, 'heavy_crossbow', target);
  assert.equal(aimed.decisionReport.selectedCandidate.targetId, target);
}
assert.throws(
  () => stepCombatTurn(campaignBookToWorldState(load('crimson-crypt')), 'player-hero', 0.65, 'heavy_crossbow', 'nobody'),
  /Legal target ids: .*enemy-skeleton-guard-1/
);

// 8. Hazard cells: the books give a trap's cell as `location`.
const gallery = campaignBookToWorldState(load('crimson-crypt'));
assert.equal(gallery.map.cells[4][5], 'hazard', 'scythe plate cell (5,4) is painted');

// 9. adjust: clamp, revive from 0, validation, and temp HP soaking damage first.
const adj = campaignBookToWorldState(load('crimson-crypt'));
const mate = adj.combatants['trpg-companion-rogue'];
adjustCombatant(adj, mate.id, { hp: '+999' });
assert.equal(mate.hp, mate.maxHp);
mate.hp = 0;
mate.conditions.push('unconscious', 'dying');
adjustCombatant(adj, mate.id, { hp: '+3' });
assert.equal(mate.hp, 3);
assert.ok(!mate.conditions.includes('unconscious') && !mate.conditions.includes('dying'));
assert.throws(() => adjustCombatant(adj, mate.id, { addConditions: ['flying'] }), /Valid conditions/);
assert.throws(() => adjustCombatant(adj, mate.id, { hp: 'lots' }), /Invalid hp value/);
adj.combatants['enemy-skeleton-guard-2'].isAlive = false;
assert.throws(() => adjustCombatant(adj, 'enemy-skeleton-guard-2', { hp: '+1' }), /dead/);
const tmp = { tempHp: 5 } as unknown as Parameters<typeof absorbTempHp>[0];
assert.equal(absorbTempHp(tmp, 8), 3);
assert.equal(tmp.tempHp, 0);
tmp.tempHp = 5;
assert.equal(absorbTempHp(tmp, 3), 0);
assert.equal(tmp.tempHp, 2);
const soak = campaignBookToWorldState(load('crimson-crypt'));
const dummy = soak.combatants['enemy-skeleton-guard-1'];
dummy.tempHp = 100;
for (let i = 0; i < 12 && dummy.tempHp === 100; i++) {
  stepCombatTurn(soak, 'player-hero', 0.65, 'heavy_crossbow', dummy.id);
}
assert.ok(dummy.tempHp < 100, 'a hit landed');
assert.equal(dummy.hp, dummy.maxHp, 'temp HP soaked the damage');

// 10. A failed save that drops an ally to 0 HP leaves them unconscious, like an attack does.
const fall = campaignBookToWorldState(load('crimson-crypt'));
const faller = fall.combatants['trpg-companion-rogue'];
const trap = { id: 'test-blast', name: 'blast', type: 'save', saveAbility: 'dex', saveDC: 99, damageFormula: '50' } as unknown as Parameters<typeof resolveDnD5eSavingThrow>[2];
for (let i = 0; i < 20 && !faller.conditions.includes('unconscious'); i++) {
  faller.hp = 1;
  resolveDnD5eSavingThrow(fall.combatants['enemy-skeleton-guard-1'], faller, trap, false);
}
assert.equal(faller.hp, 0);
assert.ok(faller.conditions.includes('unconscious') && faller.isAlive, 'save damage downs the ally');
// Revived (clearDowned leaves isStable true), then dropped again: death saves start fresh and unstable.
adjustCombatant(fall, faller.id, { hp: '+3' });
assert.equal(faller.deathSaves?.isStable, true);
for (let i = 0; i < 20 && faller.hp > 0; i++) {
  faller.hp = 1;
  resolveDnD5eSavingThrow(fall.combatants['enemy-skeleton-guard-1'], faller, trap, false);
}
assert.equal(faller.hp, 0);
assert.equal(faller.deathSaves?.isStable, false, 'second drop resets stability');

// 11. Opposed combat reads the book's 'Fighting: Brawl' key and the weapon's own skill, not a hidden default.
// A roll of 01 always succeeds, so count wins over many trials: a 0% skill wins ~1%, the old 60% default ~60%.
{
  const world = campaignBookToWorldState(load('arkham-shadow'), 3);
  const [a, d] = Object.values(world.combatants).filter((c) => c.faction === 'party');
  d.stats.skills = { Dodge: 0 };
  const attackerWins = (weaponSkill?: number) => {
    let wins = 0;
    for (let i = 0; i < 200; i++) {
      d.hp = d.maxHp;
      wins += resolveCoC7eOpposedCombat(a, d, 'dodge', '1d6', true, undefined, weaponSkill).winner === 'attacker' ? 1 : 0;
    }
    return wins;
  };
  a.stats.skills = { 'Fighting: Brawl': 0 };
  assert.ok(attackerWins() <= 20, "a 0% 'Fighting: Brawl' is used, not a default");
  a.stats.skills = { 'Fighting: Brawl': 99 };
  assert.ok(attackerWins(0) <= 20, 'an explicit weapon skill overrides the sheet');
}

// 12. PbtA Last Breath is a flat 2d6 (no modifier): 10+ cheats death, 7-9 bargains, 6- dies.
{
  const seen = new Set<string>();
  for (let seed = 1; seed <= 300; seed++) {
    const r = resolvePbtALastBreath(new DeterministicRNG(seed));
    assert.ok(r.total >= 2 && r.total <= 12, 'flat 2d6 range');
    assert.equal(r.tier, r.total >= 10 ? '10+ (Cheat Death)' : r.total >= 7 ? '7-9 (Bargain)' : '6- (Death)');
    seen.add(r.tier);
  }
  assert.equal(seen.size, 3, 'all three outcomes occur');
}

// 13. Carrying the party into the next scene keeps their state, resets position, and swaps the enemies.
{
  const book = load('arkham-shadow');
  const prev = campaignBookToWorldState(book, 7, 'scene-1-miskatonic-archive');
  const partyIds = Object.values(prev.combatants).filter((c) => c.faction === 'party').map((c) => c.id);
  const [hurt, dead, dyingId] = partyIds;
  prev.combatants[hurt].hp = 3;
  prev.combatants[hurt].position = { x: 9, y: 9 };
  prev.combatants[dead].hp = 0;
  prev.combatants[dead].isAlive = false;
  prev.combatants[dyingId].conditions.push('dying');
  const enemyBefore = Object.values(prev.combatants).filter((c) => c.faction !== 'party').map((c) => c.id);

  const next = campaignBookToWorldState(book, 7, 'scene-2-riverside-boarding-house');
  const newPositionOfHurt = next.combatants[hurt].position;
  const warnings = carryPartyIntoScene(prev, next);

  assert.equal(next.combatants[hurt].hp, 3, 'party HP carries over');
  assert.deepEqual(next.combatants[hurt].position, newPositionOfHurt, 'position comes from the new scene');
  assert.equal(next.combatants[dead].isAlive, false, 'dead stays dead');
  assert.ok(!next.initiativeOrder.includes(dead), 'dead member takes no turns');
  assert.ok(next.combatants[dyingId].conditions.includes('dying'), 'dying carries over');
  assert.equal(warnings.length, 1, 'a dying member produces one warning');
  for (const id of enemyBefore) assert.ok(!next.combatants[id], `old enemy ${id} left behind`);
  assert.equal(next.episodicLog.at(-1)?.actionType, 'scene-transition');
  assert.equal(next.rngSeed, prev.rngSeed);

  const otherSystem = campaignBookToWorldState(load('crimson-crypt'), 7);
  assert.throws(() => carryPartyIntoScene(prev, otherSystem), /rule system differs/);
  const mismatched = campaignBookToWorldState(book, 7, 'scene-2-riverside-boarding-house');
  delete mismatched.combatants[hurt];
  assert.throws(() => carryPartyIntoScene(prev, mismatched), /party differs/);
}

console.log('engine-fixes: all assertions passed');
