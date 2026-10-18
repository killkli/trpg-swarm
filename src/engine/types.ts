export type RuleSystem = 'dnd5e' | 'coc7e' | 'pbta';

export type TerrainType =
  | 'normal'
  | 'difficult'
  | 'cover_half'
  | 'cover_three_quarters'
  | 'hazard';

export interface GridPosition {
  x: number;
  y: number;
  elevation?: number;
  terrain?: TerrainType;
}

export type ActionType =
  | 'melee'
  | 'ranged'
  | 'spell'
  | 'heal'
  | 'buff'
  | 'debuff'
  | 'investigate'
  | 'dodge'
  | 'dash';

export const CONDITION_TYPES = [
  'prone',
  'restrained',
  'blessed',
  'frightened',
  'poisoned',
  'stunned',
  'unconscious',
  'dodging',
  'concentrating',
  'major_wound',
  'dying',
  'madness_phobia',
  'madness_mania',
  'madness_hallucination',
] as const;
export type ConditionType = (typeof CONDITION_TYPES)[number];

export interface CharacterStats {
  // D&D 5e core stats (1-30) & modifiers
  str?: number;
  dex?: number;
  con?: number;
  int?: number;
  wis?: number;
  cha?: number;
  proficiencyBonus?: number;
  // D&D damage-type modifiers (lowercase types such as 'poison', 'bludgeoning', 'necrotic')
  resistances?: string[];
  immunities?: string[];
  vulnerabilities?: string[];
  spellSlots?: Record<number, { current: number; max: number }>;
  // Per-rest class features with a counter (Second Wind, Action Surge, ...), keyed by the book's resource name.
  resources?: Record<string, { current: number; max: number }>;

  // CoC 7e core attributes (1-100) & investigator resources
  siz?: number;
  edu?: number;
  pow?: number;
  app?: number;
  luck?: number;
  skills?: Record<string, number>;
  build?: number;
  damageBonus?: string;

  // PbtA (Dungeon World) stats (-3 to +3) & XP/Level
  pbtaMods?: {
    str: number;
    dex: number;
    con: number;
    int: number;
    wis: number;
    cha: number;
  };
  xp?: number;
  level?: number;
  armor?: number;
}

export interface AbilityOrAction {
  id: string;
  name: string;
  type: ActionType;
  range: number; // In grid tiles (1 tile = 5ft)
  aoeRadius?: number; // In grid tiles (0 or undefined = single target)
  attackBonus?: number;
  damageFormula?: string;
  damageType?: string;
  healFormula?: string;
  spellLevel?: number; // 0 = cantrip, 1-9 = leveled spell
  saveAbility?: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';
  saveDC?: number;
  appliesCondition?: ConditionType;
  requiresConcentration?: boolean;
  cocSkillName?: string;
  pbtaMoveName?: string;
  pbtaStat?: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';
  description?: string;
  usesResource?: string; // key in `stats.resources`; each use costs 1 and is blocked at 0
}

export interface PersonaWeights {
  aggression: number; // Weight for lethality & offensive actions (0.1 - 2.0)
  altruism: number; // Weight for triage, healing & protecting allies (0.1 - 2.0)
  caution: number; // Weight for positional safety, cover & distance (0.1 - 2.0)
  tacticalPrecision: number; // Weight for AOE efficiency & flanking (0.1 - 2.0)
  resourceThrift: number; // Weight for conserving high-tier spell slots (0.1 - 2.0)
  curiosity?: number; // Weight for investigation / objective interaction (0.1 - 2.0)
}

export type CombatantRole = 'vanguard' | 'rogue' | 'arcanist' | 'healer' | 'monster';
export type FactionType = 'party' | 'enemy' | 'neutral';

export interface Combatant {
  id: string;
  name: string;
  faction: FactionType;
  role: CombatantRole;
  position: GridPosition;
  hp: number;
  maxHp: number;
  san: number;
  maxSan: number;
  ac: number;
  speed: number; // In grid tiles (e.g. 6 tiles = 30ft)
  initiative: number;
  conditions: ConditionType[];
  tempHp?: number; // D&D temporary HP: drained before hp by attack and save damage
  deathSaves?: {
    successes: number;
    failures: number;
    isStable: boolean;
  };
  concentratingOn?: string;
  stats: CharacterStats;
  actions: AbilityOrAction[];
  persona: PersonaWeights;
  isAlive: boolean;
}

export interface ScoreBreakdown {
  lethalityScore: number;
  triageUrgency: number;
  aoeClusterEfficiency: number;
  positionalSafety: number;
  resourceConservation: number;
  personaAlignment: number;
}

export interface TacticalCandidate {
  id: string;
  actorId: string;
  action: AbilityOrAction;
  targetId?: string;
  targetIdsInAoe?: string[];
  moveTo: GridPosition;
  targetPosition: GridPosition;
  description: string;
  scoreBreakdown: ScoreBreakdown;
  totalUtility: number;
  probability: number;
}

export interface TacticalDecisionReport {
  actorId: string;
  actorName: string;
  role: CombatantRole;
  temperature: number;
  selectedCandidate: TacticalCandidate;
  topCandidates: TacticalCandidate[];
  allCandidateCount: number;
  battlefieldThreatRatio: number;
  narrativeReasoning: string;
}

export type FactCategory = 'lore' | 'npc' | 'location' | 'quest' | 'status';

export interface MemoryFact {
  id: string;
  category: FactCategory;
  subject: string;
  predicate: string;
  value: string;
  turnCreated: number;
  isActive: boolean;
  supersededBy?: string;
}

export interface DiceRollResult {
  expression: string;
  rawRolls: number[];
  keptRolls: number[];
  droppedRolls: number[];
  modifier: number;
  total: number;
  isCriticalSuccess: boolean;
  isCriticalFailure: boolean;
  seedUsed?: number;
  details: string;
}

export interface EpisodicEvent {
  id: string;
  turn: number;
  timestamp: string;
  actorId: string;
  actorName: string;
  actionType: string;
  targetId?: string;
  diceRoll?: DiceRollResult;
  narrativeSummary: string;
  mechanicalOutcome?: Record<string, unknown>;
}

export interface MapGrid {
  width: number;
  height: number;
  cells: TerrainType[][];
  elevation: number[][];
}

/** Scripted boss action from the campaign book (`villainActions`). */
export interface VillainAction {
  ownerId: string;
  round: number;
  name: string;
  effect: string;
  /** Reserve combatants this action brings into the fight (parsed from "summon ... (x: N, y: M)"). */
  summons?: string[];
  fired?: boolean;
}

export interface WorldState {
  campaignName: string;
  ruleSystem: RuleSystem;
  turn: number;
  round: number;
  activeActorIndex: number;
  initiativeOrder: string[];
  sceneName: string;
  sceneDescription: string;
  dangerLevel: number; // 1 (Low) to 5 (Extreme)
  rngSeed: number;
  map: MapGrid;
  combatants: Record<string, Combatant>;
  workingMemory: EpisodicEvent[]; // Sliding window of last 12 events
  episodicLog: EpisodicEvent[]; // Immutable append-only log
  semanticFacts: MemoryFact[]; // Knowledge base with Temporal Supersession
  villainActions?: VillainAction[]; // Scripted boss actions, fired on the owner's turn
  reserve?: Record<string, Combatant>; // Combatants held back until a villain action summons them
}
