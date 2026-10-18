import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  Combatant,
  ConditionType,
  DiceRollResult,
  EpisodicEvent,
  FactCategory,
  MapGrid,
  MemoryFact,
  RuleSystem,
  TerrainType,
  WorldState,
} from './types.ts';
import { CONDITION_TYPES } from './types.ts';
import { DeterministicRNG, rollDice } from './dice.ts';
import {
  COC_LEVEL_RANK,
  clearDowned,
  resolveCoC7eDeathCheck,
  resolveCoC7eCheck,
  resolveCoC7eOpposedCombat,
  resolveCoC7eSanity,
  resolveDnD5eAttack,
  resolveDnD5eDeathSave,
  resolveDnD5eSavingThrow,
  resolvePbtAMove,
} from './rulesEngine.ts';
import { evaluateTacticalActions, isFlankingPosition } from './tacticalAI.ts';

const WORKING_MEMORY_WINDOW = 12;

/**
 * Appends an immutable event to the Episodic Log and maintains the 12-event sliding window Working Memory.
 */
export function recordEpisodicEvent(
  state: WorldState,
  event: Omit<EpisodicEvent, 'id' | 'turn' | 'timestamp'>
): EpisodicEvent {
  const fullEvent: EpisodicEvent = {
    id: `evt_t${state.turn}_${state.episodicLog.length + 1}`,
    turn: state.turn,
    timestamp: new Date().toISOString(),
    ...event,
  };

  state.episodicLog.push(fullEvent);
  state.workingMemory.push(fullEvent);

  if (state.workingMemory.length > WORKING_MEMORY_WINDOW) {
    state.workingMemory = state.workingMemory.slice(
      state.workingMemory.length - WORKING_MEMORY_WINDOW
    );
  }

  return fullEvent;
}

/**
 * Semantic Memory with Temporal Supersession:
 * When a new fact `(subject, predicate, value)` conflicts with an existing active fact
 * sharing the same `(subject, predicate)`, the old fact is marked `isActive = false`
 * and `supersededBy = newFact.id`, preventing contradictory memory retrieval.
 */
export function upsertSemanticFact(
  state: WorldState,
  subject: string,
  predicate: string,
  value: string,
  category: FactCategory = 'status'
): { newFact: MemoryFact; supersededFacts: MemoryFact[] } {
  const newFactId = `fact_t${state.turn}_${state.semanticFacts.length + 1}`;
  const supersededFacts: MemoryFact[] = [];

  for (const existing of state.semanticFacts) {
    if (
      existing.isActive &&
      existing.subject.toLowerCase() === subject.toLowerCase() &&
      existing.predicate.toLowerCase() === predicate.toLowerCase()
    ) {
      existing.isActive = false;
      existing.supersededBy = newFactId;
      supersededFacts.push(existing);
    }
  }

  const newFact: MemoryFact = {
    id: newFactId,
    category,
    subject,
    predicate,
    value,
    turnCreated: state.turn,
    isActive: true,
  };

  state.semanticFacts.push(newFact);
  return { newFact, supersededFacts };
}

/**
 * Queries only active (non-superseded) semantic facts, optionally filtered by subject or category.
 */
export function queryActiveFacts(
  state: WorldState,
  filter?: { subject?: string; predicate?: string; category?: FactCategory }
): MemoryFact[] {
  return state.semanticFacts.filter((f) => {
    if (!f.isActive) return false;
    if (filter?.subject && f.subject.toLowerCase() !== filter.subject.toLowerCase()) {
      return false;
    }
    if (filter?.predicate && f.predicate.toLowerCase() !== filter.predicate.toLowerCase()) {
      return false;
    }
    if (filter?.category && f.category !== filter.category) {
      return false;
    }
    return true;
  });
}

/**
 * Builds a default 12x10 tactical grid map with half cover pillars, 3/4 cover altars, high ground, and hazards.
 */
export function createDefaultTacticalMap(): MapGrid {
  const width = 12;
  const height = 10;
  const cells: TerrainType[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => 'normal' as TerrainType)
  );
  const elevation: number[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => 0)
  );

  // Add tactical cover pillars & high ground
  cells[2][4] = 'cover_half';
  cells[2][7] = 'cover_half';
  cells[4][3] = 'cover_three_quarters';
  cells[4][8] = 'cover_three_quarters';
  cells[6][5] = 'difficult';
  cells[6][6] = 'difficult';
  cells[5][5] = 'hazard';

  // Elevated dais on rows 1-2 and backline balcony on row 7-8
  for (let x = 2; x <= 9; x++) {
    elevation[1][x] = 1;
    elevation[8][x] = 1;
  }

  return { width, height, cells, elevation };
}

/**
 * Generates a full 4-companion AI party + enemy encounter for D&D 5e, CoC 7e, or PbtA.
 */
export function createDefaultEncounter(system: RuleSystem = 'dnd5e', seed = 42): WorldState {
  const map = createDefaultTacticalMap();

  const combatants: Record<string, Combatant> = {
    aria_vanguard: {
      id: 'aria_vanguard',
      name: '亞莉亞·聖盾 (Aria the Vanguard)',
      faction: 'party',
      role: 'vanguard',
      position: { x: 4, y: 6, elevation: 0, terrain: 'normal' },
      hp: 44,
      maxHp: 44,
      san: 70,
      maxSan: 70,
      ac: 18,
      speed: 6,
      initiative: 15,
      conditions: [],
      stats: {
        str: 18,
        dex: 12,
        con: 16,
        int: 10,
        wis: 13,
        cha: 16,
        proficiencyBonus: 3,
        spellSlots: { 1: { current: 3, max: 3 }, 2: { current: 2, max: 2 } },
        siz: 65,
        edu: 60,
        pow: 70,
        luck: 55,
        skills: { 'Fighting (Brawl)': 75, Dodge: 45, SpotHidden: 50 },
        pbtaMods: { str: 2, dex: 0, con: 2, int: 0, wis: 1, cha: 1 },
        xp: 0,
        level: 5,
        armor: 3,
      },
      actions: [
        {
          id: 'radiant_longsword',
          name: '輝耀長劍斬擊 (Radiant Longsword)',
          type: 'melee',
          range: 1.5,
          attackBonus: 7,
          damageFormula: '1d8+4',
          pbtaMoveName: 'Hack and Slash',
          pbtaStat: 'str',
        },
        {
          id: 'divine_smite_strike',
          name: '至聖斬重擊 (Divine Smite)',
          type: 'melee',
          range: 1.5,
          attackBonus: 7,
          damageFormula: '3d8+4',
          spellLevel: 1,
          pbtaMoveName: 'Hack and Slash',
          pbtaStat: 'str',
        },
        {
          id: 'lay_on_hands',
          name: '聖療術 (Lay on Hands)',
          type: 'heal',
          range: 1.5,
          healFormula: '2d8+4',
        },
        {
          id: 'vanguard_dodge',
          name: '舉盾防禦姿態 (Total Defense)',
          type: 'dodge',
          range: 0,
        },
      ],
      persona: {
        aggression: 1.25,
        altruism: 1.45,
        caution: 1.1,
        tacticalPrecision: 1.0,
        resourceThrift: 0.9,
      },
      isAlive: true,
    },

    kael_rogue: {
      id: 'kael_rogue',
      name: '凱爾·影刃 (Kael the Shadow Rogue)',
      faction: 'party',
      role: 'rogue',
      position: { x: 3, y: 4, elevation: 0, terrain: 'cover_three_quarters' },
      hp: 32,
      maxHp: 32,
      san: 62,
      maxSan: 65,
      ac: 16,
      speed: 7,
      initiative: 19,
      conditions: [],
      stats: {
        str: 10,
        dex: 18,
        con: 14,
        int: 14,
        wis: 12,
        cha: 12,
        proficiencyBonus: 3,
        siz: 55,
        edu: 65,
        pow: 65,
        luck: 65,
        skills: { 'Fighting (Brawl)': 65, Dodge: 70, SpotHidden: 75, Locksmith: 80 },
        pbtaMods: { str: 0, dex: 2, con: 1, int: 1, wis: 0, cha: 1 },
        xp: 0,
        level: 5,
        armor: 1,
      },
      actions: [
        {
          id: 'sneak_attack_blade',
          name: '背刺暗影短劍 (Sneak Attack Blade)',
          type: 'melee',
          range: 1.5,
          attackBonus: 7,
          damageFormula: '4d6+4',
          pbtaMoveName: 'Hack and Slash',
          pbtaStat: 'dex',
        },
        {
          id: 'hand_crossbow_shot',
          name: '精準手弩射擊 (Hand Crossbow)',
          type: 'ranged',
          range: 6,
          attackBonus: 7,
          damageFormula: '3d6+4',
          pbtaMoveName: 'Volley',
          pbtaStat: 'dex',
        },
        {
          id: 'investigate_trap',
          name: '洞察機關與弱點 (Tactical Survey)',
          type: 'investigate',
          range: 4,
          cocSkillName: 'SpotHidden',
        },
      ],
      persona: {
        aggression: 1.5,
        altruism: 0.75,
        caution: 1.35,
        tacticalPrecision: 1.65,
        resourceThrift: 1.2,
        curiosity: 1.4,
      },
      isAlive: true,
    },

    lyra_arcanist: {
      id: 'lyra_arcanist',
      name: '萊菈·星辰奧術師 (Lyra the Arcanist)',
      faction: 'party',
      role: 'arcanist',
      position: { x: 4, y: 8, elevation: 1, terrain: 'normal' },
      hp: 26,
      maxHp: 26,
      san: 58,
      maxSan: 75,
      ac: 14,
      speed: 6,
      initiative: 16,
      conditions: [],
      stats: {
        str: 8,
        dex: 14,
        con: 14,
        int: 18,
        wis: 13,
        cha: 12,
        proficiencyBonus: 3,
        spellSlots: {
          1: { current: 4, max: 4 },
          2: { current: 3, max: 3 },
          3: { current: 2, max: 2 },
        },
        siz: 50,
        edu: 85,
        pow: 75,
        luck: 50,
        skills: { 'Fighting (Brawl)': 35, Dodge: 50, Occult: 85, CthulhuMythos: 22 },
        pbtaMods: { str: -1, dex: 1, con: 1, int: 2, wis: 1, cha: 0 },
        xp: 0,
        level: 5,
        armor: 0,
      },
      actions: [
        {
          id: 'fireball_3rd',
          name: '三環火球術 (Fireball)',
          type: 'spell',
          range: 8,
          aoeRadius: 2.5,
          damageFormula: '8d6',
          spellLevel: 3,
          saveAbility: 'dex',
          saveDC: 15,
          pbtaMoveName: 'Cast a Spell',
          pbtaStat: 'int',
        },
        {
          id: 'hold_monster_debuff',
          name: '二環定身控場術 (Web / Hold)',
          type: 'debuff',
          range: 7,
          aoeRadius: 1.5,
          damageFormula: '2d6',
          spellLevel: 2,
          saveAbility: 'wis',
          saveDC: 15,
          appliesCondition: 'restrained',
          requiresConcentration: true,
          pbtaMoveName: 'Cast a Spell',
          pbtaStat: 'int',
        },
        {
          id: 'fire_bolt_cantrip',
          name: '火焰箭戲法 (Fire Bolt Cantrip)',
          type: 'ranged',
          range: 8,
          attackBonus: 7,
          damageFormula: '2d10',
          spellLevel: 0,
          pbtaMoveName: 'Cast a Spell',
          pbtaStat: 'int',
        },
      ],
      persona: {
        aggression: 1.35,
        altruism: 0.9,
        caution: 1.6,
        tacticalPrecision: 1.85,
        resourceThrift: 1.35,
        curiosity: 1.7,
      },
      isAlive: true,
    },

    theron_healer: {
      id: 'theron_healer',
      name: '瑟隆·黎明牧師 (Theron the Dawn Cleric)',
      faction: 'party',
      role: 'healer',
      position: { x: 6, y: 8, elevation: 1, terrain: 'normal' },
      hp: 35,
      maxHp: 35,
      san: 76,
      maxSan: 80,
      ac: 17,
      speed: 6,
      initiative: 12,
      conditions: [],
      stats: {
        str: 14,
        dex: 10,
        con: 14,
        int: 12,
        wis: 18,
        cha: 14,
        proficiencyBonus: 3,
        spellSlots: {
          1: { current: 4, max: 4 },
          2: { current: 3, max: 3 },
          3: { current: 2, max: 2 },
        },
        siz: 60,
        edu: 75,
        pow: 80,
        luck: 60,
        skills: { 'Fighting (Brawl)': 50, Dodge: 45, FirstAid: 80, Psychology: 75 },
        pbtaMods: { str: 1, dex: 0, con: 1, int: 0, wis: 2, cha: 1 },
        xp: 0,
        level: 5,
        armor: 2,
      },
      actions: [
        {
          id: 'cure_wounds_2nd',
          name: '二環療傷術 (Cure Wounds II)',
          type: 'heal',
          range: 5,
          healFormula: '2d8+4',
          spellLevel: 2,
        },
        {
          id: 'healing_word_1st',
          name: '一環治癒真言 (Healing Word)',
          type: 'heal',
          range: 7,
          healFormula: '1d4+4',
          spellLevel: 1,
        },
        {
          id: 'bless_party',
          name: '一環祝福術 (Bless)',
          type: 'buff',
          range: 6,
          spellLevel: 1,
          appliesCondition: 'blessed',
          requiresConcentration: true,
        },
        {
          id: 'guiding_bolt_1st',
          name: '一環導引箭 (Guiding Bolt)',
          type: 'ranged',
          range: 8,
          attackBonus: 7,
          damageFormula: '4d6',
          spellLevel: 1,
        },
        {
          id: 'sacred_flame_cantrip',
          name: '神聖火焰戲法 (Sacred Flame)',
          type: 'spell',
          range: 7,
          damageFormula: '2d8',
          spellLevel: 0,
          saveAbility: 'dex',
          saveDC: 15,
        },
      ],
      persona: {
        aggression: 0.85,
        altruism: 1.9,
        caution: 1.45,
        tacticalPrecision: 1.2,
        resourceThrift: 1.25,
      },
      isAlive: true,
    },

    cult_archon_boss: {
      id: 'cult_archon_boss',
      name: '深淵祭司·瑪拉凱 (Malakor the Abyssal Archon)',
      faction: 'enemy',
      role: 'monster',
      position: { x: 5, y: 2, elevation: 1, terrain: 'cover_half' },
      hp: 58,
      maxHp: 58,
      san: 99,
      maxSan: 99,
      ac: 16,
      speed: 6,
      initiative: 17,
      conditions: [],
      stats: {
        str: 16,
        dex: 14,
        con: 16,
        int: 16,
        wis: 15,
        cha: 18,
        proficiencyBonus: 3,
        spellSlots: { 1: { current: 3, max: 3 }, 2: { current: 2, max: 2 }, 3: { current: 1, max: 1 } },
        skills: { 'Fighting (Brawl)': 70, Dodge: 50 },
      },
      actions: [
        {
          id: 'void_blast_aoe',
          name: '深淵死靈衝擊波 (Abyssal Pulse)',
          type: 'spell',
          range: 7,
          aoeRadius: 2.0,
          damageFormula: '4d6+3',
          spellLevel: 2,
          saveAbility: 'con',
          saveDC: 14,
        },
        {
          id: 'accursed_glaive',
          name: '詛咒長柄刀重劈 (Accursed Glaive)',
          type: 'melee',
          range: 2.0,
          attackBonus: 6,
          damageFormula: '2d10+3',
        },
        {
          id: 'eldritch_spear',
          name: '魔能穿刺槍 (Eldritch Spear)',
          type: 'ranged',
          range: 8,
          attackBonus: 6,
          damageFormula: '2d8+3',
        },
      ],
      persona: {
        aggression: 1.65,
        altruism: 0.4,
        caution: 1.0,
        tacticalPrecision: 1.4,
        resourceThrift: 0.8,
      },
      isAlive: true,
    },

    ghoul_stalker_1: {
      id: 'ghoul_stalker_1',
      name: '墓穴食屍鬼獵手 A (Crypt Ghoul Alpha)',
      faction: 'enemy',
      role: 'monster',
      position: { x: 4, y: 3, elevation: 0, terrain: 'normal' },
      hp: 24,
      maxHp: 24,
      san: 99,
      maxSan: 99,
      ac: 13,
      speed: 6,
      initiative: 14,
      conditions: [],
      stats: {
        str: 14,
        dex: 15,
        con: 12,
        int: 7,
        wis: 10,
        cha: 6,
        proficiencyBonus: 2,
        skills: { 'Fighting (Brawl)': 55, Dodge: 40 },
      },
      actions: [
        {
          id: 'paralyzing_claws',
          name: '麻痺腐爪撕裂 (Paralyzing Claws)',
          type: 'melee',
          range: 1.5,
          attackBonus: 5,
          damageFormula: '2d4+2',
          appliesCondition: 'poisoned',
        },
      ],
      persona: {
        aggression: 1.8,
        altruism: 0.2,
        caution: 0.5,
        tacticalPrecision: 0.9,
        resourceThrift: 1.0,
      },
      isAlive: true,
    },

    ghoul_stalker_2: {
      id: 'ghoul_stalker_2',
      name: '墓穴食屍鬼獵手 B (Crypt Ghoul Beta)',
      faction: 'enemy',
      role: 'monster',
      position: { x: 6, y: 3, elevation: 0, terrain: 'normal' },
      hp: 22,
      maxHp: 24,
      san: 99,
      maxSan: 99,
      ac: 13,
      speed: 6,
      initiative: 11,
      conditions: [],
      stats: {
        str: 14,
        dex: 15,
        con: 12,
        int: 7,
        wis: 10,
        cha: 6,
        proficiencyBonus: 2,
        skills: { 'Fighting (Brawl)': 55, Dodge: 40 },
      },
      actions: [
        {
          id: 'paralyzing_claws',
          name: '麻痺腐爪撕裂 (Paralyzing Claws)',
          type: 'melee',
          range: 1.5,
          attackBonus: 5,
          damageFormula: '2d4+2',
          appliesCondition: 'poisoned',
        },
      ],
      persona: {
        aggression: 1.8,
        altruism: 0.2,
        caution: 0.5,
        tacticalPrecision: 0.9,
        resourceThrift: 1.0,
      },
      isAlive: true,
    },
  };

  const initiativeOrder = Object.values(combatants)
    .sort((a, b) => b.initiative - a.initiative)
    .map((c) => c.id);

  const state: WorldState = {
    campaignName:
      system === 'coc7e'
        ? '阿卡姆地底星之教堂 (The Starry Crypt beneath Arkham)'
        : system === 'pbta'
          ? '地城世界：黑曜裂隙聖殿 (Obsidian Rift Sanctum)'
          : '被遺忘的國度：深淵血月地窖 (Crypt of the Blood Moon)',
    ruleSystem: system,
    turn: 1,
    round: 1,
    activeActorIndex: 0,
    initiativeOrder,
    sceneName: '古老地下祭壇大廳 (Ancient Subterranean Altar Hall)',
    sceneDescription:
      '潮濕的石柱提供半掩體與四分之三掩體，南北兩側設有高地石階 (+1 Elevation)，中央祭壇正散發著不祥的深淵能量。',
    dangerLevel: 3,
    rngSeed: seed,
    map,
    combatants,
    workingMemory: [],
    episodicLog: [],
    semanticFacts: [],
  };

  // Seed initial semantic facts
  upsertSemanticFact(state, 'Crypt_Altar', 'state', 'corrupted_active', 'location');
  upsertSemanticFact(state, 'Tavern_Door', 'state', 'locked', 'location');
  upsertSemanticFact(state, 'cult_archon_boss', 'status', 'alive_commanding', 'npc');
  upsertSemanticFact(state, 'ghoul_stalker_1', 'status', 'alive', 'npc');
  upsertSemanticFact(state, 'ghoul_stalker_2', 'status', 'alive', 'npc');

  recordEpisodicEvent(state, {
    actorId: 'system_dm',
    actorName: 'Dungeon Master',
    actionType: 'scene_init',
    narrativeSummary: `戰役【${state.campaignName}】(${system.toUpperCase()}) 遭遇戰開始！先攻順序：${initiativeOrder.join(' -> ')}。`,
  });

  return state;
}

/**
 * Executes a full deterministic turn for the current active combatant (or specified actorId):
 * 1. Runs Softmax Tactical AI to select optimal move & action
 * 2. Updates combatant grid position
 * 3. Resolves action via the active RuleSystem (dnd5e / coc7e / pbta)
 * 4. Updates Semantic Facts (e.g. Temporal Supersession if an enemy dies) & Working/Episodic Memory
 * 5. Advances turn & initiative pointer
 */
export function stepCombatTurn(
  state: WorldState,
  overrideActorId?: string,
  temperature = 0.65,
  preferredActionId?: string,
  preferredTargetId?: string
): {
  actorId: string;
  actorName: string;
  decisionReport: ReturnType<typeof evaluateTacticalActions>;
  resolutionNarrative: string;
  eventRecorded: EpisodicEvent;
} {
  const rng = new DeterministicRNG(state.rngSeed + state.turn * 101);
  state.rngSeed = rng.getSeed();

  // Select active living actor
  let actorId = overrideActorId;
  if (!actorId) {
    for (let offset = 0; offset < state.initiativeOrder.length; offset++) {
      const idx = (state.activeActorIndex + offset) % state.initiativeOrder.length;
      const candidate = state.combatants[state.initiativeOrder[idx]];
      if (candidate && candidate.isAlive) {
        actorId = candidate.id;
        state.activeActorIndex = idx;
        break;
      }
    }
  }

  if (!actorId || !state.combatants[actorId]) {
    throw new Error('No living combatants available to take a turn.');
  }

  const actor = state.combatants[actorId];

  fireVillainActions(state, actor.id);

  // If actor is at 0 HP and unconscious in D&D 5e, perform Death Save first
  if (actor.hp === 0 && actor.isAlive && state.ruleSystem === 'dnd5e') {
    const ds = resolveDnD5eDeathSave(actor, rng);
    return finishDownedTurn(state, actor, ds.narrative, temperature, preferredActionId, ds.roll);
  }

  // CoC 7e: a downed investigator cannot act. A dying one rolls CON each turn and dies on a failure.
  if (actor.hp === 0 && actor.isAlive && state.ruleSystem === 'coc7e') {
    const dying = actor.conditions.includes('dying');
    let narrative = `${actor.name} 昏迷不醒，無法行動。`;
    if (dying) {
      const check = resolveCoC7eDeathCheck(actor, rng);
      narrative = check.narrative;
      if (check.isDead) upsertSemanticFact(state, actor.id, 'status', 'dead', 'npc');
    }
    return finishDownedTurn(state, actor, narrative, temperature, preferredActionId);
  }

  // Run Softmax Situational Tactical AI
  const decisionReport = evaluateTacticalActions(state, actor.id, temperature, rng, preferredActionId, preferredTargetId);
  const chosen = decisionReport.selectedCandidate;
  const action = chosen.action;

  // Apply movement
  actor.position = { ...chosen.moveTo };

  // Deduct spell slot if leveled spell
  if (action.spellLevel && action.spellLevel > 0) {
    const slot = actor.stats.spellSlots?.[action.spellLevel];
    if (slot && slot.current > 0) {
      slot.current -= 1;
    }
  }

  const target = chosen.targetId ? state.combatants[chosen.targetId] : undefined;
  let resolutionNarrative = '';

  if (action.type === 'heal' && target && state.ruleSystem === 'coc7e' && action.attackBonus !== undefined) {
    const check = resolveCoC7eCheck({ skill: action.attackBonus, rng });
    if (check.levelRank < COC_LEVEL_RANK.Regular) {
      resolutionNarrative = `${actor.name} 對 ${target.name} 施行【${action.name}】[${check.roll.total}/${check.level}] 失敗，沒能穩定傷勢。`;
    } else {
      const prevHp = target.hp;
      target.hp = Math.min(target.maxHp, target.hp + Math.max(1, rollDice(action.healFormula ?? '1', rng).total));
      if (prevHp === 0) clearDowned(target);
      resolutionNarrative = `${actor.name} 對 ${target.name} 施行【${action.name}】[${check.roll.total}/${check.level}] 成功，傷勢穩定 (${prevHp} -> ${target.hp}/${target.maxHp})。`;
    }
  } else if (action.type === 'heal' && target) {
    const healRoll = rollDice(action.healFormula ?? '1d8+3', rng);
    const prevHp = target.hp;
    target.hp = Math.min(target.maxHp, target.hp + Math.max(1, healRoll.total));
    if (prevHp === 0 && target.hp > 0) clearDowned(target);
    resolutionNarrative = `${actor.name} 對 ${target.name} 施展【${action.name}】恢復 ${target.hp - prevHp} 點 HP (${prevHp} -> ${target.hp}/${target.maxHp})。`;
  } else if (action.type === 'buff' && target) {
    if (action.appliesCondition && !target.conditions.includes(action.appliesCondition)) {
      target.conditions.push(action.appliesCondition);
    }
    if (action.requiresConcentration) {
      actor.concentratingOn = action.name;
      if (!actor.conditions.includes('concentrating')) {
        actor.conditions.push('concentrating');
      }
    }
    resolutionNarrative = `${actor.name} 對 ${target.name} 施展增益【${action.name}】，附加狀態【${action.appliesCondition ?? 'blessed'}】。`;
  } else if (action.type === 'dodge') {
    if (!actor.conditions.includes('dodging')) {
      actor.conditions.push('dodging');
    }
    resolutionNarrative = `${actor.name} 採取【${action.name}】防禦姿態，直到下回合開始前敵方對其攻擊承受劣勢。`;
  } else if (action.type === 'dash' || action.type === 'investigate') {
    resolutionNarrative = `${actor.name} 執行【${action.name}】(${chosen.description})。`;
  } else if (state.ruleSystem === 'dnd5e') {
    if (action.aoeRadius && action.aoeRadius > 0 && chosen.targetIdsInAoe && chosen.targetIdsInAoe.length > 0) {
      const subLogs: string[] = [];
      for (const tid of chosen.targetIdsInAoe) {
        const aoeTarget = state.combatants[tid];
        if (!aoeTarget || !aoeTarget.isAlive) continue;
        const saveRes = resolveDnD5eSavingThrow(actor, aoeTarget, action, true, rng);
        subLogs.push(saveRes.narrative);
        if (!aoeTarget.isAlive) {
          upsertSemanticFact(state, aoeTarget.id, 'status', 'dead', 'npc');
        }
      }
      resolutionNarrative = `${actor.name} 施放範圍法術【${action.name}】：${subLogs.join(' | ')}`;
    } else if (action.saveAbility && target) {
      const saveRes = resolveDnD5eSavingThrow(actor, target, action, true, rng);
      resolutionNarrative = saveRes.narrative;
      if (!target.isAlive) {
        upsertSemanticFact(state, target.id, 'status', 'dead', 'npc');
      }
    } else if (target) {
      const flanking = isFlankingPosition(state, actor, actor.position, target);
      const atkRes = resolveDnD5eAttack({
        attacker: actor,
        defender: target,
        action,
        isFlanking: flanking,
        rng,
      });
      resolutionNarrative = atkRes.narrative;
      if (!target.isAlive) {
        upsertSemanticFact(state, target.id, 'status', 'dead', 'npc');
      }
    }
  } else if (state.ruleSystem === 'coc7e' && target) {
    const cocCombat = resolveCoC7eOpposedCombat(
      actor,
      target,
      'dodge',
      action.damageFormula ?? '1d6+1',
      true,
      rng,
      // attackBonus is a percentage only for weapons imported with a named CoC skill (the built-in roster uses a d20 bonus).
      action.cocSkillName ? action.attackBonus : undefined
    );
    let sanNarrative = '';
    if (actor.faction === 'enemy' && target.faction === 'party') {
      const sanRes = resolveCoC7eSanity(target.san, '1/1d6', target.stats.int ? target.stats.int * 5 : 65, target, rng);
      sanNarrative = ` | ${sanRes.narrative}`;
    }
    resolutionNarrative = `${cocCombat.narrative}${sanNarrative}`;
    if (!target.isAlive) {
      upsertSemanticFact(state, target.id, 'status', 'dead', 'npc');
    }
  } else if (state.ruleSystem === 'pbta') {
    const statKey = action.pbtaStat ?? 'str';
    const statMod = actor.stats.pbtaMods?.[statKey] ?? 1;
    const pbtaRes = resolvePbtAMove(
      actor,
      action.pbtaMoveName ?? action.name,
      statMod,
      state.dangerLevel,
      target,
      action.damageFormula ?? '1d8+2',
      rng
    );
    resolutionNarrative = pbtaRes.narrative;
    if (target && !target.isAlive) {
      upsertSemanticFact(state, target.id, 'status', 'dead', 'npc');
    }
  }

  const fullSummary = `${decisionReport.narrativeReasoning} => 裁決結果：${resolutionNarrative}`;
  const eventRecorded = recordEpisodicEvent(state, {
    actorId: actor.id,
    actorName: actor.name,
    actionType: action.type,
    targetId: target?.id,
    narrativeSummary: fullSummary,
  });

  advanceTurnCounters(state);

  return {
    actorId: actor.id,
    actorName: actor.name,
    decisionReport,
    resolutionNarrative,
    eventRecorded,
  };
}

export interface AdjustOptions {
  hp?: string; // "+N", "-N", "=N" or "N" (set)
  tempHp?: number;
  san?: string;
  luck?: number;
  addConditions?: string[];
  removeConditions?: string[];
}

function applyDelta(current: number, spec: string, min: number, max: number, label: string): number {
  const m = /^([+\-=]?)(\d+)$/.exec(spec.trim());
  if (!m) throw new Error(`Invalid ${label} value "${spec}". Use +N, -N, =N or N.`);
  const n = Number(m[2]);
  const next = m[1] === '+' ? current + n : m[1] === '-' ? current - n : n;
  return Math.min(max, Math.max(min, next));
}

/**
 * Out-of-combat state changes the host rolled for itself (rests, potions, temp HP, sanity,
 * luck, conditions). HP is clamped to [0, maxHp]; raising HP from 0 clears unconscious and dying.
 */
export function adjustCombatant(state: WorldState, actorId: string, opts: AdjustOptions): string[] {
  const c = state.combatants[actorId];
  if (!c) {
    throw new Error(`Unknown combatant "${actorId}". Valid ids: ${Object.keys(state.combatants).join(', ')}`);
  }
  if (!c.isAlive) throw new Error(`${c.name} (${c.id}) is dead and cannot be adjusted.`);
  const log: string[] = [];
  const known = CONDITION_TYPES as readonly string[];
  for (const cond of [...(opts.addConditions ?? []), ...(opts.removeConditions ?? [])]) {
    if (!known.includes(cond)) {
      throw new Error(`Unknown condition "${cond}". Valid conditions: ${known.join(', ')}`);
    }
  }
  if (opts.hp !== undefined) {
    const prev = c.hp;
    c.hp = applyDelta(c.hp, opts.hp, 0, c.maxHp, 'hp');
    if (prev === 0 && c.hp > 0) clearDowned(c);
    log.push(`HP ${prev} -> ${c.hp}/${c.maxHp}`);
  }
  if (opts.tempHp !== undefined) {
    c.tempHp = Math.max(0, Math.floor(opts.tempHp));
    log.push(`臨時 HP -> ${c.tempHp}`);
  }
  if (opts.san !== undefined) {
    const prev = c.san;
    c.san = applyDelta(c.san, opts.san, 0, c.maxSan, 'san');
    log.push(`SAN ${prev} -> ${c.san}/${c.maxSan}`);
  }
  if (opts.luck !== undefined) {
    c.stats.luck = Math.max(0, Math.floor(opts.luck));
    log.push(`幸運 -> ${c.stats.luck}`);
  }
  for (const cond of opts.addConditions ?? []) {
    if (!c.conditions.includes(cond as ConditionType)) c.conditions.push(cond as ConditionType);
    log.push(`+狀態 ${cond}`);
  }
  for (const cond of opts.removeConditions ?? []) {
    c.conditions = c.conditions.filter((x) => x !== cond);
    log.push(`-狀態 ${cond}`);
  }
  recordEpisodicEvent(state, {
    actorId: c.id,
    actorName: c.name,
    actionType: 'adjust',
    narrativeSummary: `【手動調整】${c.name}：${log.join('；')}`,
  });
  return log;
}

/** Fire due villain actions on their owner's turn; summons join the initiative order. */
/** Shared tail of a downed actor's turn: record the death-save event, advance the turn, return the step result. */
function finishDownedTurn(
  state: WorldState,
  actor: Combatant,
  narrative: string,
  temperature: number,
  preferredActionId?: string,
  diceRoll?: DiceRollResult
): ReturnType<typeof stepCombatTurn> {
  const decisionReport = evaluateTacticalActions(state, actor.id, temperature, undefined, preferredActionId);
  const evt = recordEpisodicEvent(state, {
    actorId: actor.id,
    actorName: actor.name,
    actionType: 'death_save',
    diceRoll,
    narrativeSummary: narrative,
  });
  advanceTurnCounters(state);
  return {
    actorId: actor.id,
    actorName: actor.name,
    decisionReport,
    resolutionNarrative: narrative,
    eventRecorded: evt,
  };
}

function fireVillainActions(state: WorldState, actorId: string): void {
  for (const va of state.villainActions ?? []) {
    if (va.fired || va.ownerId !== actorId || state.round < va.round) continue;
    va.fired = true;
    const arrivals: string[] = [];
    for (const id of va.summons ?? []) {
      const unit = state.reserve?.[id];
      if (!unit) continue;
      state.combatants[id] = unit;
      delete state.reserve![id];
      state.initiativeOrder.push(id);
      arrivals.push(unit.name);
    }
    const owner = state.combatants[actorId];
    recordEpisodicEvent(state, {
      actorId,
      actorName: owner?.name ?? actorId,
      actionType: 'villain_action',
      narrativeSummary: `【Boss 專屬行動：${va.name}】${va.effect}${arrivals.length ? ` 登場：${arrivals.join('、')}。` : ''}`,
    });
  }
}

function advanceTurnCounters(state: WorldState): void {
  state.turn += 1;
  state.activeActorIndex = (state.activeActorIndex + 1) % state.initiativeOrder.length;
  if (state.activeActorIndex === 0) {
    state.round += 1;
  }
}

export function saveWorldState(filePath: string, state: WorldState): void {
  const abs = path.resolve(filePath);
  const dir = path.dirname(abs);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(abs, JSON.stringify(state, null, 2), 'utf-8');
}

export function loadWorldState(filePath: string): WorldState {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`WorldState file not found at "${abs}"`);
  }
  const raw = fs.readFileSync(abs, 'utf-8');
  return JSON.parse(raw) as WorldState;
}
