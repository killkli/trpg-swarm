/**
 * Campaign book importer: converts the narrative "campaign book" JSON format
 * (examples/campaign-crimson-crypt.json, examples/campaign-arkham-shadow.json)
 * into the engine WorldState shape so any host agent can start a session with a
 * single cross-platform command (`init --example <name>`) — no shell copy, no
 * schema mismatch. Files already in WorldState format pass through unchanged.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  AbilityOrAction,
  Combatant,
  CombatantRole,
  ConditionType,
  FactCategory,
  MapGrid,
  PersonaWeights,
  RuleSystem,
  TerrainType,
  VillainAction,
  WorldState,
} from './types.ts';
import { getAbilityModifier } from './rulesEngine.ts';
import { createDefaultTacticalMap, recordEpisodicEvent, upsertSemanticFact } from './stateStore.ts';

// ---------------------------------------------------------------------------
// Loose structural contracts of the campaign book format (both rule systems).
// ---------------------------------------------------------------------------

interface BookHp {
  current?: number;
  max?: number;
}

interface BookAttack {
  name?: string;
  bonus?: number;
  skill?: string | number;
  percentage?: number;
  damage?: string;
  damageType?: string;
  range?: string;
}

interface BookPartyMember {
  id: string;
  name: string;
  controlledBy?: string;
  // D&D 5e shape
  class?: string;
  ac?: number;
  hp?: BookHp;
  speed?: number;
  abilities?: Record<string, { score?: number }>;
  proficiencyBonus?: number;
  skills?: Record<string, number>;
  attacks?: BookAttack[];
  resources?: Record<string, { current?: number; max?: number; effect?: string }>;
  spellcasting?: {
    ability?: string;
    slots?: Record<string, { current?: number; max?: number }>;
    preparedSpells?: string[];
  };
  // CoC 7e shape
  occupation?: string;
  characteristics?: Record<string, number>;
  derivedStats?: {
    hp?: BookHp;
    mp?: BookHp;
    sanity?: { current?: number; max?: number };
    luck?: { current?: number };
    damageBonus?: string;
    build?: number;
    mov?: number;
  };
  weapons?: BookAttack[];
}

interface BookEncounter {
  entityId?: string;
  name: string;
  status?: string;
  ac?: number;
  armor?: number;
  hp?: BookHp;
  speed?: number;
  mov?: number;
  dex?: number;
  attacks?: BookAttack[];
  resistances?: string[];
  immunities?: string[];
  vulnerabilities?: string[];
  villainActions?: Array<{ round?: number; name?: string; effect?: string }>;
  position?: { x: number; y: number };
}

interface BookArea {
  areaId?: string;
  sceneId?: string;
  name: string;
  ambientDescription?: string;
  gridSize?: { width?: number; height?: number };
  terrainFeatures?: Array<{
    type?: string;
    cover?: string;
    coords?: Array<{ x: number; y: number }>;
  }>;
  trapsAndHazards?: Array<{
    name?: string;
    type?: string;
    coord?: { x: number; y: number };
    coords?: Array<{ x: number; y: number }>;
    location?: { x: number; y: number }; // key used by the bundled books
  }>;
  encounters?: BookEncounter[];
}

export interface CampaignBook {
  title: string;
  system: string;
  synopsis?: string;
  sessionState?: {
    sceneId?: string;
    round?: number;
    tensionLevel?: number;
    questFlags?: Record<string, boolean>;
  };
  party: BookPartyMember[];
  dungeonAreas?: BookArea[];
  investigationScenes?: BookArea[];
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

const PERSONA_BY_ROLE: Record<CombatantRole, PersonaWeights> = {
  vanguard: { aggression: 1.0, altruism: 0.9, caution: 1.2, tacticalPrecision: 0.8, resourceThrift: 0.6 },
  rogue: { aggression: 1.3, altruism: 0.4, caution: 1.1, tacticalPrecision: 1.2, resourceThrift: 0.7 },
  arcanist: { aggression: 1.1, altruism: 0.5, caution: 1.3, tacticalPrecision: 1.4, resourceThrift: 1.2 },
  healer: { aggression: 0.6, altruism: 1.6, caution: 1.0, tacticalPrecision: 0.9, resourceThrift: 0.8 },
  monster: { aggression: 1.4, altruism: 0.2, caution: 0.8, tacticalPrecision: 0.9, resourceThrift: 0.4 },
};

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'action';
}

/**
 * Parses range notations ("5 ft", "100/400 ft", "15 yds", "80/320 ft") into grid
 * tiles at 1 tile = 5 ft; yard values count as ~3 ft per yard. Longest range wins.
 */
function rangeToTiles(rangeStr?: string): number {
  if (!rangeStr) return 1;
  const match = rangeStr.match(/(\d+)\s*(?:\/\s*(\d+))?\s*(ft|yds|yd)/i);
  if (!match) return 1;
  const unit = match[3].toLowerCase().startsWith('yd') ? 3 : 5;
  const longest = Number(match[2] ?? match[1]);
  return Math.max(1, Math.round(longest / unit));
}

/** Infers the tactical role from the entity id / class / occupation keywords. */
function inferRole(...hintTexts: Array<string | undefined>): CombatantRole {
  const hints = hintTexts.filter(Boolean).join(' ').toLowerCase();
  if (/(vanguard|paladin|fighter|barbarian|monk|戰士|聖武士|前衛|警探|憲兵)/.test(hints)) return 'vanguard';
  if (/(rogue|ranger|bard|thief|scout|盜賊|斥候|遊蕩|偵探|走私)/.test(hints)) return 'rogue';
  if (/(arcanist|wizard|sorcerer|warlock|法師|奧術|教授|學者|神秘)/.test(hints)) return 'arcanist';
  if (/(healer|cleric|druid|牧師|醫師|治療|精神)/.test(hints)) return 'healer';
  return 'vanguard';
}

function terrainFromFeature(type?: string, cover?: string): TerrainType {
  const text = `${type ?? ''} ${cover ?? ''}`.toLowerCase();
  if (/(three|3\/4|3４|pillar|column|statue|altar|wall)/.test(text)) return 'cover_three_quarters';
  if (/(half|crate|barrel|low)/.test(text)) return 'cover_half';
  if (/(difficult|rubble|water|web|debris|瓦礫|水)/.test(text)) return 'difficult';
  if (/(hazard|fire|trap|spike|miasma|邪氣|陷阱)/.test(text)) return 'hazard';
  return 'normal';
}

function buildMapFromArea(area: BookArea | undefined): MapGrid {
  if (!area?.gridSize?.width || !area?.gridSize?.height) {
    return createDefaultTacticalMap();
  }
  const width = area.gridSize.width;
  const height = area.gridSize.height;
  const cells: TerrainType[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => 'normal' as TerrainType)
  );
  const elevation: number[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => 0)
  );

  for (const feature of area.terrainFeatures ?? []) {
    const terrain = terrainFromFeature(feature.type, feature.cover);
    if (terrain === 'normal') continue;
    for (const coord of feature.coords ?? []) {
      if (coord.y >= 0 && coord.y < height && coord.x >= 0 && coord.x < width) {
        cells[coord.y][coord.x] = terrain;
      }
    }
  }
  for (const hazard of area.trapsAndHazards ?? []) {
    for (const coord of [hazard.coord, hazard.location, ...(hazard.coords ?? [])]) {
      if (coord && coord.y >= 0 && coord.y < height && coord.x >= 0 && coord.x < width) {
        cells[coord.y][coord.x] = 'hazard';
      }
    }
  }

  return { width, height, cells, elevation };
}

function dndAttackToAction(attack: BookAttack): AbilityOrAction {
  const tiles = rangeToTiles(attack.range);
  return {
    id: slugify(attack.name ?? 'attack'),
    name: attack.name ?? 'Attack',
    type: tiles > 1 ? 'ranged' : 'melee',
    range: tiles,
    attackBonus: attack.bonus,
    damageFormula: attack.damage,
    damageType: attack.damageType?.toLowerCase(),
  };
}

function cocAttackToAction(attack: BookAttack): AbilityOrAction {
  const skillName = typeof attack.skill === 'string' ? attack.skill : undefined;
  const percentage =
    attack.percentage ?? (typeof attack.skill === 'number' ? attack.skill : undefined);
  return {
    id: slugify(attack.name ?? 'weapon'),
    name: attack.name ?? 'Weapon',
    type: rangeToTiles(attack.range) > 1 ? 'ranged' : 'melee',
    range: Math.max(1, rangeToTiles(attack.range)),
    attackBonus: percentage,
    damageFormula: attack.damage,
    cocSkillName: skillName,
  };
}

function clampCoord(value: number, max: number): number {
  return Math.min(Math.max(0, Math.round(value)), max - 1);
}

function baseCombatant(partial: Partial<Combatant> & Pick<Combatant, 'id' | 'name' | 'faction' | 'role'>): Combatant {
  return {
    position: { x: 1, y: 1 },
    hp: 10,
    maxHp: 10,
    san: 0,
    maxSan: 0,
    ac: 10,
    speed: 5,
    initiative: 10,
    conditions: [] as ConditionType[],
    stats: {},
    actions: [],
    persona: PERSONA_BY_ROLE[partial.role],
    isAlive: true,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
const COC_HEAL_SKILLS = [
  { regex: /first aid|急救/i, id: 'first_aid' },
  { regex: /medicine|醫學/i, id: 'medicine' },
];

// Main converter
// ---------------------------------------------------------------------------

export function campaignBookToWorldState(book: CampaignBook, seed = 42, sceneOverride?: string): WorldState {
  const system = (book.system ?? 'dnd5e').toLowerCase() as RuleSystem;
  if (!['dnd5e', 'coc7e', 'pbta'].includes(system)) {
    throw new Error(`Unsupported campaign system "${book.system}" (expected dnd5e | coc7e | pbta).`);
  }

  const areas = book.dungeonAreas ?? book.investigationScenes ?? [];
  const sceneId = sceneOverride ?? book.sessionState?.sceneId;
  const matched = areas.find((a) => a.sceneId === sceneId || a.areaId === sceneId);
  if (sceneOverride && !matched) {
    const valid = areas.map((a) => a.sceneId ?? a.areaId).join(', ');
    throw new Error(`Unknown scene "${sceneOverride}". Valid scene ids: ${valid}`);
  }
  const area = matched ?? areas[0];
  const map = buildMapFromArea(area);

  const combatants: Record<string, Combatant> = {};
  const party: Combatant[] = book.party.map((member, idx) => {
    const role = inferRole(member.id, member.class, member.occupation, member.controlledBy === 'human' ? 'fighter' : undefined);

    if (system === 'coc7e') {
      const derived = member.derivedStats ?? {};
      const skills: Record<string, number> = { ...(member.skills ?? {}) };
      const actions: AbilityOrAction[] = (member.weapons ?? []).map(cocAttackToAction);
      for (const action of actions) {
        if (action.cocSkillName && action.attackBonus !== undefined) {
          skills[action.cocSkillName] = action.attackBonus;
        }
      }
      // First Aid / Medicine stabilise a dying investigator (references/coc7e-rules.md). The rules
      // doc gives no heal amount, so the minimum the heal step applies (1 HP) is used.
      for (const [skillName, percentage] of Object.entries(member.skills ?? {})) {
        const kind = COC_HEAL_SKILLS.find((h) => h.regex.test(skillName))?.id;
        if (kind && !actions.some((a) => a.id === kind)) {
          actions.push({
            id: kind,
            name: skillName,
            type: 'heal',
            range: 1,
            healFormula: '1',
            cocSkillName: skillName,
            attackBonus: percentage,
          });
        }
      }
      return baseCombatant({
        id: member.id,
        name: member.name,
        faction: 'party',
        role,
        position: { x: 1, y: clampCoord(2 + idx, map.height) },
        hp: derived.hp?.current ?? 10,
        maxHp: derived.hp?.max ?? 10,
        san: derived.sanity?.current ?? 0,
        maxSan: derived.sanity?.max ?? 99,
        ac: 10,
        speed: Math.max(2, Math.round((derived.mov ?? 8) / 2)),
        initiative: Math.round((member.characteristics?.DEX ?? 50) / 20),
        stats: {
          str: member.characteristics?.STR,
          con: member.characteristics?.CON,
          siz: member.characteristics?.SIZ,
          dex: member.characteristics?.DEX,
          app: member.characteristics?.APP,
          int: member.characteristics?.INT,
          pow: member.characteristics?.POW,
          edu: member.characteristics?.EDU,
          luck: derived.luck?.current,
          build: derived.build,
          damageBonus: derived.damageBonus,
          skills,
        },
        actions,
      });
    }

    const abilities = member.abilities ?? {};
    const actions: AbilityOrAction[] = (member.attacks ?? []).map(dndAttackToAction);
    const resources: Record<string, { current: number; max: number }> = {};
    for (const [resourceName, resource] of Object.entries(member.resources ?? {})) {
      const max = resource?.max ?? resource?.current;
      if (max !== undefined) resources[resourceName] = { current: resource.current ?? max, max };
      if (resource && (resource.current ?? 0) > 0 && /heal|治療/i.test(resource.effect ?? '')) {
        const healMatch = (resource.effect ?? '').match(/(\d+d\d+(?:\s*[+-]\s*\d+)?)/i);
        actions.push({
          id: slugify(resourceName),
          name: resourceName,
          type: 'heal',
          range: 0,
          healFormula: healMatch?.[1] ?? '1d8+2',
          usesResource: resourceName,
        });
      }
    }
    // Prepared healing spells become heal actions (1 tile = 5 ft). Without this, a healer
    // defined through `spellcasting` never gets a heal candidate.
    const castingScore = member.spellcasting?.ability
      ? abilities[member.spellcasting.ability]?.score
      : undefined;
    const castingMod = castingScore !== undefined ? getAbilityModifier(castingScore) : 0;
    const modSuffix = castingMod >= 0 ? `+${castingMod}` : `${castingMod}`;
    const healSpells: Record<string, { id: string; name: string; range: number; dice: string }> = {
      'cure wounds': { id: 'cure_wounds', name: '療傷術 (Cure Wounds)', range: 1, dice: '1d8' },
      'healing word': { id: 'healing_word', name: '治癒真言 (Healing Word)', range: 12, dice: '1d4' },
    };
    for (const spell of member.spellcasting?.preparedSpells ?? []) {
      const def = healSpells[spell.toLowerCase()];
      if (def && !actions.some((a) => a.id === def.id)) {
        actions.push({
          id: def.id,
          name: def.name,
          type: 'heal',
          range: def.range,
          healFormula: `${def.dice}${modSuffix}`,
          spellLevel: 1,
        });
      }
    }
    const spellSlots: Record<number, { current: number; max: number }> = {};
    for (const [level, slot] of Object.entries(member.spellcasting?.slots ?? {})) {
      const max = slot.max ?? slot.current ?? 0;
      spellSlots[Number(level)] = { current: slot.current ?? max, max };
    }
    return baseCombatant({
      id: member.id,
      name: member.name,
      faction: 'party',
      role,
      position: { x: 1, y: clampCoord(2 + idx, map.height) },
      hp: member.hp?.current ?? 10,
      maxHp: member.hp?.max ?? 10,
      san: 0,
      maxSan: 0,
      ac: member.ac ?? 12,
      speed: Math.max(2, Math.round((member.speed ?? 25) / 5)),
      initiative: abilities.DEX?.score ? Math.floor((abilities.DEX.score - 10) / 2) : 0,
      deathSaves: { successes: 0, failures: 0, isStable: false },
      stats: {
        str: abilities.STR?.score,
        dex: abilities.DEX?.score,
        con: abilities.CON?.score,
        int: abilities.INT?.score,
        wis: abilities.WIS?.score,
        cha: abilities.CHA?.score,
        proficiencyBonus: member.proficiencyBonus ?? 2,
        skills: member.skills,
        spellSlots: Object.keys(spellSlots).length > 0 ? spellSlots : undefined,
        resources: Object.keys(resources).length > 0 ? resources : undefined,
      },
      actions,
    });
  });
  for (const member of party) {
    combatants[member.id] = member;
  }

  (area?.encounters ?? []).forEach((encounter, idx) => {
    const id = encounter.entityId ?? slugify(encounter.name);
    const actions: AbilityOrAction[] = (encounter.attacks ?? []).map((attack) =>
      system === 'coc7e' || attack.skill !== undefined || attack.bonus === undefined
        ? cocAttackToAction(attack)
        : dndAttackToAction(attack)
    );
    const skills: Record<string, number> = {};
    for (const action of actions) {
      if (action.cocSkillName && action.attackBonus !== undefined) {
        skills[action.cocSkillName] = action.attackBonus;
      }
    }
    const spawn = encounter.position ?? { x: map.width - 2, y: clampCoord(2 + idx, map.height) };
    combatants[id] = baseCombatant({
      id,
      name: encounter.name,
      faction: 'enemy',
      role: 'monster',
      position: { x: clampCoord(spawn.x, map.width), y: clampCoord(spawn.y, map.height) },
      hp: encounter.hp?.current ?? 10,
      maxHp: encounter.hp?.max ?? 10,
      san: 0,
      maxSan: 0,
      ac: encounter.ac ?? encounter.armor ?? 12,
      speed: encounter.speed
        ? Math.max(2, Math.round(encounter.speed / 5))
        : Math.max(2, Math.round((encounter.mov ?? 8) / 2)),
      initiative: encounter.dex ? Math.round(encounter.dex / 20) : 2,
      stats: {
        dex: encounter.dex,
        skills: Object.keys(skills).length > 0 ? skills : undefined,
        resistances: encounter.resistances?.map((t) => t.toLowerCase()),
        immunities: encounter.immunities?.map((t) => t.toLowerCase()),
        vulnerabilities: encounter.vulnerabilities?.map((t) => t.toLowerCase()),
      },
      actions,
    });
  });

  // Villain actions: a "summon" action holds back the combatants standing on the coordinates it
  // names, so they enter the fight on the owner's turn instead of at the start.
  const villainActions: VillainAction[] = [];
  const reserve: Record<string, Combatant> = {};
  for (const encounter of area?.encounters ?? []) {
    const ownerId = encounter.entityId ?? slugify(encounter.name);
    for (const va of encounter.villainActions ?? []) {
      const effect = va.effect ?? '';
      const summons: string[] = [];
      if (/召喚|summon/i.test(effect)) {
        for (const m of effect.matchAll(/x:\s*(\d+)\s*,\s*y:\s*(\d+)/gi)) {
          const [x, y] = [Number(m[1]), Number(m[2])];
          const unit = Object.values(combatants).find(
            (c) => c.faction === 'enemy' && c.id !== ownerId && c.position.x === x && c.position.y === y
          );
          if (unit && !summons.includes(unit.id)) summons.push(unit.id);
        }
      }
      for (const id of summons) {
        reserve[id] = combatants[id];
        delete combatants[id];
      }
      villainActions.push({ ownerId, round: va.round ?? 1, name: va.name ?? 'Villain action', effect, summons });
    }
  }

  const initiativeOrder = Object.values(combatants)
    .sort((a, b) => b.initiative - a.initiative || (a.faction === 'party' ? -1 : 1))
    .map((c) => c.id);

  const state: WorldState = {
    campaignName: book.title,
    ruleSystem: system,
    turn: 1,
    round: book.sessionState?.round && book.sessionState.round > 0 ? book.sessionState.round : 1,
    activeActorIndex: 0,
    initiativeOrder,
    sceneName: area?.name ?? book.title,
    sceneDescription: area?.ambientDescription ?? book.synopsis ?? '',
    dangerLevel: Math.min(
      5,
      Math.max(1, Math.ceil((book.sessionState?.tensionLevel ?? 60) / 20))
    ),
    rngSeed: seed,
    map,
    combatants,
    workingMemory: [],
    episodicLog: [],
    semanticFacts: [],
    villainActions: villainActions.length > 0 ? villainActions : undefined,
    reserve: Object.keys(reserve).length > 0 ? reserve : undefined,
  };

  for (const [flag, value] of Object.entries(book.sessionState?.questFlags ?? {})) {
    upsertSemanticFact(state, flag, 'questFlag', String(value), 'quest' as FactCategory);
  }
  for (const encounter of area?.encounters ?? []) {
    if (encounter.entityId && (encounter.status ?? 'active') === 'active') {
      upsertSemanticFact(state, encounter.entityId, 'status', 'active', 'npc');
    }
  }

  recordEpisodicEvent(state, {
    actorId: 'system_dm',
    actorName: 'Dungeon Master',
    actionType: 'scene_init',
    narrativeSummary: `戰役【${book.title}】(${system.toUpperCase()}) 已從範例劇本匯入！先攻順序：${initiativeOrder.join(' -> ')}。`,
  });

  return state;
}

/**
 * Loads a JSON file that is either already a WorldState (passes through) or a
 * campaign book (converted automatically). This is the import entry point.
 */
export function importWorldState(filePath: string, seed = 42, sceneOverride?: string): WorldState {
  const abs = path.resolve(filePath);
  const raw: unknown = JSON.parse(fs.readFileSync(abs, 'utf-8'));
  if (
    raw &&
    typeof raw === 'object' &&
    'combatants' in raw &&
    'initiativeOrder' in raw &&
    'ruleSystem' in raw
  ) {
    return raw as WorldState;
  }
  return campaignBookToWorldState(raw as CampaignBook, seed, sceneOverride);
}
