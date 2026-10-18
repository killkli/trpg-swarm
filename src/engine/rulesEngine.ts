import type {
  AbilityOrAction,
  Combatant,
  ConditionType,
  DiceRollResult,
  TerrainType,
} from './types.ts';
import { DeterministicRNG, getGlobalRng, rollCoCD100, rollDice } from './dice.ts';

// ============================================================================
// Helpers
// ============================================================================

export function getAbilityModifier(score = 10): number {
  return Math.floor((score - 10) / 2);
}

export function calculateDnD5eSaveDC(caster: Combatant, spellAbility: 'int' | 'wis' | 'cha' = 'int'): number {
  const prof = caster.stats.proficiencyBonus ?? 2;
  const score = caster.stats[spellAbility] ?? 14;
  return 8 + prof + getAbilityModifier(score);
}

function doubleDamageDiceInFormula(formula: string): string {
  return formula.replace(/(\d+)d(\d+)/gi, (_match, countStr, sidesStr) => {
    const count = parseInt(countStr, 10) * 2;
    return `${count}d${sidesStr}`;
  });
}

// ============================================================================
// 1. D&D 5e SRD 5.1 Deterministic Adjudication Module
// ============================================================================

export interface DnD5eAttackOptions {
  attacker: Combatant;
  defender: Combatant;
  action: AbilityOrAction;
  targetCover?: TerrainType;
  isFlanking?: boolean;
  rng?: DeterministicRNG;
}

export interface DnD5eAttackResolution {
  hit: boolean;
  isCritical: boolean;
  isFumble: boolean;
  attackRoll: DiceRollResult;
  effectiveAC: number;
  coverBonus: number;
  advantageState: 'advantage' | 'disadvantage' | 'normal';
  damageRoll?: DiceRollResult;
  totalDamage: number;
  defenderRemainingHp: number;
  concentrationBroken?: boolean;
  narrative: string;
}

export function resolveDnD5eAttack(opts: DnD5eAttackOptions): DnD5eAttackResolution {
  const { attacker, defender, action, isFlanking = false } = opts;
  const rng = opts.rng ?? getGlobalRng();

  const coverTerrain = opts.targetCover ?? defender.position.terrain ?? 'normal';
  let coverBonus = 0;
  if (coverTerrain === 'cover_half') coverBonus = 2;
  else if (coverTerrain === 'cover_three_quarters') coverBonus = 5;

  const effectiveAC = defender.ac + coverBonus;

  // Determine advantage and disadvantage sources
  let advCount = 0;
  let disadvCount = 0;

  // High ground (+1 elevation difference gives tactical advantage on attacks)
  const attackerElev = attacker.position.elevation ?? 0;
  const defenderElev = defender.position.elevation ?? 0;
  if (attackerElev > defenderElev) {
    advCount++;
  }

  if (isFlanking && action.type === 'melee') {
    advCount++;
  }

  // Condition checks
  if (defender.conditions.includes('Restrained' as ConditionType) || defender.conditions.includes('restrained')) {
    advCount++;
  }
  if (defender.conditions.includes('stunned') || defender.conditions.includes('unconscious')) {
    advCount++;
  }
  if (defender.conditions.includes('prone')) {
    const dist = Math.hypot(
      attacker.position.x - defender.position.x,
      attacker.position.y - defender.position.y
    );
    if (dist <= 1.5) advCount++;
    else disadvCount++;
  }
  if (defender.conditions.includes('dodging')) {
    disadvCount++;
  }

  if (attacker.conditions.includes('prone') || attacker.conditions.includes('poisoned') || attacker.conditions.includes('frightened') || attacker.conditions.includes('restrained')) {
    disadvCount++;
  }

  let advantageState: 'advantage' | 'disadvantage' | 'normal' = 'normal';
  if (advCount > 0 && disadvCount === 0) advantageState = 'advantage';
  else if (disadvCount > 0 && advCount === 0) advantageState = 'disadvantage';

  const atkBonus = action.attackBonus ?? (attacker.stats.proficiencyBonus ?? 2) + getAbilityModifier(attacker.stats.str ?? 14);
  const d20Core =
    advantageState === 'advantage'
      ? '2d20kh1'
      : advantageState === 'disadvantage'
        ? '2d20kl1'
        : '1d20';

  const blessBonus = attacker.conditions.includes('blessed') ? '+1d4' : '';
  const signBonus = atkBonus >= 0 ? `+${atkBonus}` : `${atkBonus}`;
  const attackExpr = `${d20Core}${blessBonus}${signBonus}`;

  const attackRoll = rollDice(attackExpr, rng);
  const isCritical = attackRoll.isCriticalSuccess;
  const isFumble = attackRoll.isCriticalFailure;

  const hit = isCritical || (!isFumble && attackRoll.total >= effectiveAC);

  let damageRoll: DiceRollResult | undefined;
  let totalDamage = 0;
  let concentrationBroken = false;

  if (hit) {
    const baseFormula = action.damageFormula ?? '1d8+3';
    const finalFormula = isCritical ? doubleDamageDiceInFormula(baseFormula) : baseFormula;
    damageRoll = rollDice(finalFormula, rng);
    totalDamage = takeDnDDamage(defender, Math.max(1, damageRoll.total), action.damageType);
    if (defender.hp === 0) dropAtZeroHp(defender);

    if (defender.concentratingOn && defender.hp > 0) {
      const concCheck = resolveConcentrationCheck(defender, totalDamage, rng);
      concentrationBroken = !concCheck.maintained;
    }

    if (action.appliesCondition && !defender.conditions.includes(action.appliesCondition)) {
      defender.conditions.push(action.appliesCondition);
    }
  }

  const narrative = hit
    ? `${attacker.name} 使用【${action.name}】(${advantageState}) 擲出 ${attackRoll.total} vs AC ${effectiveAC} (含掩體 +${coverBonus}) —— ${isCritical ? '【暴擊 Natural 20！】' : '命中！'}造成 ${totalDamage} 點傷害 (${defender.name} 剩餘 HP: ${defender.hp}/${defender.maxHp})。`
    : `${attacker.name} 使用【${action.name}】(${advantageState}) 擲出 ${attackRoll.total} vs AC ${effectiveAC} (含掩體 +${coverBonus}) —— ${isFumble ? '【大失敗 Natural 1！】' : '未命中。'}`;

  return {
    hit,
    isCritical,
    isFumble,
    attackRoll,
    effectiveAC,
    coverBonus,
    advantageState,
    damageRoll,
    totalDamage,
    defenderRemainingHp: defender.hp,
    concentrationBroken,
    narrative,
  };
}

export interface DnD5eSaveResolution {
  dc: number;
  saveAbility: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';
  saveRoll: DiceRollResult;
  succeeded: boolean;
  damageRoll?: DiceRollResult;
  damageTaken: number;
  conditionApplied?: ConditionType;
  narrative: string;
}

export function resolveDnD5eSavingThrow(
  caster: Combatant,
  target: Combatant,
  action: AbilityOrAction,
  halfOnSave = true,
  rng: DeterministicRNG = getGlobalRng()
): DnD5eSaveResolution {
  const saveAbility = action.saveAbility ?? 'dex';
  const dc = action.saveDC ?? calculateDnD5eSaveDC(caster, caster.role === 'healer' ? 'wis' : 'int');

  const abilityScore = target.stats[saveAbility] ?? 10;
  const mod = getAbilityModifier(abilityScore);

  let coverBonus = 0;
  if (saveAbility === 'dex') {
    if (target.position.terrain === 'cover_half') coverBonus = 2;
    else if (target.position.terrain === 'cover_three_quarters') coverBonus = 5;
  }

  const totalMod = mod + coverBonus;
  const d20Expr = target.conditions.includes('dodging') && saveAbility === 'dex' ? '2d20kh1' : '1d20';
  const signMod = totalMod >= 0 ? `+${totalMod}` : `${totalMod}`;
  const saveRoll = rollDice(`${d20Expr}${signMod}`, rng);

  const succeeded = saveRoll.isCriticalSuccess || (!saveRoll.isCriticalFailure && saveRoll.total >= dc);

  let damageRoll: DiceRollResult | undefined;
  let damageTaken = 0;
  let conditionApplied: ConditionType | undefined;

  if (action.damageFormula) {
    damageRoll = rollDice(action.damageFormula, rng);
    if (succeeded) {
      damageTaken = halfOnSave ? Math.floor(damageRoll.total / 2) : 0;
    } else {
      damageTaken = damageRoll.total;
    }
    damageTaken = takeDnDDamage(target, damageTaken, action.damageType);
    if (target.hp === 0) dropAtZeroHp(target);
  }

  if (!succeeded && action.appliesCondition) {
    conditionApplied = action.appliesCondition;
    if (!target.conditions.includes(conditionApplied)) {
      target.conditions.push(conditionApplied);
    }
  }

  const narrative = `${target.name} 進行 ${saveAbility.toUpperCase()} 豁免檢定 (DC ${dc})：擲出 ${saveRoll.total} —— ${succeeded ? '豁免成功！' : '豁免失敗！'}${damageTaken > 0 ? `受到 ${damageTaken} 點傷害 (剩餘 HP: ${target.hp}/${target.maxHp})。` : ''}${conditionApplied ? `陷入【${conditionApplied}】狀態！` : ''}`;

  return {
    dc,
    saveAbility,
    saveRoll,
    succeeded,
    damageRoll,
    damageTaken,
    conditionApplied,
    narrative,
  };
}

export interface DnD5eDeathSaveResolution {
  roll: DiceRollResult;
  successes: number;
  failures: number;
  isStable: boolean;
  revivedWith1Hp: boolean;
  isDead: boolean;
  narrative: string;
}

export function resolveDnD5eDeathSave(
  combatant: Combatant,
  rng: DeterministicRNG = getGlobalRng()
): DnD5eDeathSaveResolution {
  if (!combatant.deathSaves) {
    combatant.deathSaves = { successes: 0, failures: 0, isStable: false };
  }

  const roll = rollDice('1d20', rng);
  let revivedWith1Hp = false;
  let isDead = false;

  if (roll.isCriticalSuccess) {
    combatant.hp = 1;
    combatant.deathSaves = { successes: 0, failures: 0, isStable: true };
    combatant.conditions = combatant.conditions.filter((c) => c !== 'unconscious');
    revivedWith1Hp = true;
  } else if (roll.isCriticalFailure) {
    combatant.deathSaves.failures += 2;
  } else if (roll.total >= 10) {
    combatant.deathSaves.successes += 1;
  } else {
    combatant.deathSaves.failures += 1;
  }

  if (combatant.deathSaves.successes >= 3) {
    combatant.deathSaves.isStable = true;
  }
  if (combatant.deathSaves.failures >= 3) {
    isDead = true;
    combatant.isAlive = false;
  }

  const narrative = revivedWith1Hp
    ? `${combatant.name} 死亡豁免擲出 Natural 20！奇蹟般恢復 1 點 HP 並甦醒！`
    : isDead
      ? `${combatant.name} 死亡豁免擲出 ${roll.total}，累計失敗達 3 次，角色陣亡。`
      : `${combatant.name} 死亡豁免擲出 ${roll.total} (成功: ${combatant.deathSaves.successes}/3, 失敗: ${combatant.deathSaves.failures}/3)${combatant.deathSaves.isStable ? ' —— 傷勢已穩定！' : ''}`;

  return {
    roll,
    successes: combatant.deathSaves.successes,
    failures: combatant.deathSaves.failures,
    isStable: combatant.deathSaves.isStable,
    revivedWith1Hp,
    isDead,
    narrative,
  };
}

export function resolveConcentrationCheck(
  combatant: Combatant,
  damageTaken: number,
  rng: DeterministicRNG = getGlobalRng()
): { dc: number; roll: DiceRollResult; maintained: boolean; narrative: string } {
  const dc = Math.max(10, Math.floor(damageTaken / 2));
  const conMod = getAbilityModifier(combatant.stats.con ?? 12);
  const signMod = conMod >= 0 ? `+${conMod}` : `${conMod}`;
  const roll = rollDice(`1d20${signMod}`, rng);
  const maintained = roll.total >= dc;

  if (!maintained) {
    combatant.concentratingOn = undefined;
    combatant.conditions = combatant.conditions.filter((c) => c !== 'concentrating');
  }

  return {
    dc,
    roll,
    maintained,
    narrative: `${combatant.name} 進行專注檢定 (DC ${dc}) 擲出 ${roll.total} —— ${maintained ? '成功維持法術專注！' : '專注中斷！'}`,
  };
}

// ============================================================================
// 2. Call of Cthulhu 7e (CoC 7e) Deterministic Adjudication Module
// ============================================================================

export type CoCSuccessLevel =
  | 'Critical'
  | 'Extreme'
  | 'Hard'
  | 'Regular'
  | 'Failure'
  | 'Fumble';

export const COC_LEVEL_RANK: Record<CoCSuccessLevel, number> = {
  Fumble: 0,
  Failure: 1,
  Regular: 2,
  Hard: 3,
  Extreme: 4,
  Critical: 5,
};

export interface CoC7eCheckOptions {
  skill: number;
  bonusPenaltyDice?: number;
  difficulty?: 'Regular' | 'Hard' | 'Extreme';
  spendLuckToSucceed?: boolean;
  availableLuck?: number;
  pushRoll?: boolean;
  rng?: DeterministicRNG;
}

export interface CoC7eCheckResolution {
  roll: DiceRollResult;
  skill: number;
  hardThreshold: number;
  extremeThreshold: number;
  level: CoCSuccessLevel;
  levelRank: number;
  succeeded: boolean;
  luckSpent: number;
  remainingLuck?: number;
  pushedAttempt?: {
    roll: DiceRollResult;
    level: CoCSuccessLevel;
    succeeded: boolean;
    consequenceTriggered: boolean;
  };
  narrative: string;
}

export function classifyCoC7eRoll(rollVal: number, skill: number): CoCSuccessLevel {
  const hard = Math.floor(skill / 2);
  const extreme = Math.floor(skill / 5);
  const isFumble = skill < 50 ? rollVal >= 96 : rollVal === 100;

  if (rollVal === 1) return 'Critical';
  if (isFumble) return 'Fumble';
  if (rollVal <= extreme) return 'Extreme';
  if (rollVal <= hard) return 'Hard';
  if (rollVal <= skill) return 'Regular';
  return 'Failure';
}

export function resolveCoC7eCheck(opts: CoC7eCheckOptions): CoC7eCheckResolution {
  const {
    skill,
    bonusPenaltyDice = 0,
    difficulty = 'Regular',
    spendLuckToSucceed = false,
    availableLuck = 0,
    pushRoll = false,
  } = opts;
  const rng = opts.rng ?? getGlobalRng();

  const hardThreshold = Math.floor(skill / 2);
  const extremeThreshold = Math.floor(skill / 5);
  const requiredRank = COC_LEVEL_RANK[difficulty];

  const roll = rollCoCD100(skill, bonusPenaltyDice, rng);
  let level = classifyCoC7eRoll(roll.total, skill);
  let levelRank = COC_LEVEL_RANK[level];
  let succeeded = levelRank >= requiredRank;

  let luckSpent = 0;
  let remainingLuck = availableLuck;

  // Optional: Spend Luck to turn Failure into required success (cannot spend on Fumble)
  if (!succeeded && spendLuckToSucceed && level !== 'Fumble') {
    const targetThreshold =
      difficulty === 'Extreme'
        ? extremeThreshold
        : difficulty === 'Hard'
          ? hardThreshold
          : skill;
    const needed = roll.total - targetThreshold;
    if (needed > 0 && availableLuck >= needed) {
      luckSpent = needed;
      remainingLuck = availableLuck - needed;
      level = difficulty;
      levelRank = COC_LEVEL_RANK[level];
      succeeded = true;
    }
  }

  let pushedAttempt: CoC7eCheckResolution['pushedAttempt'];
  if (!succeeded && pushRoll && level !== 'Fumble') {
    const pRoll = rollCoCD100(skill, bonusPenaltyDice, rng);
    const pLevel = classifyCoC7eRoll(pRoll.total, skill);
    const pSucceeded = COC_LEVEL_RANK[pLevel] >= requiredRank;
    pushedAttempt = {
      roll: pRoll,
      level: pLevel,
      succeeded: pSucceeded,
      consequenceTriggered: !pSucceeded,
    };
    if (pSucceeded) {
      level = pLevel;
      levelRank = COC_LEVEL_RANK[pLevel];
      succeeded = true;
    }
  }

  const narrative = `CoC 7e 技能檢定 (目標 ${skill} / 困難 ${hardThreshold} / 極限 ${extremeThreshold})：擲出 ${roll.total} => 【${level}】${luckSpent > 0 ? ` (燃燒 ${luckSpent} 點幸運值逆轉成功！)` : ''}${pushedAttempt ? ` | 孤注一擲重擲: ${pushedAttempt.roll.total} (${pushedAttempt.level})${pushedAttempt.consequenceTriggered ? ' —— 孤注一擲失敗，觸發守秘人嚴重後果！' : ''}` : ''}`;

  return {
    roll,
    skill,
    hardThreshold,
    extremeThreshold,
    level,
    levelRank,
    succeeded,
    luckSpent,
    remainingLuck,
    pushedAttempt,
    narrative,
  };
}

export type BoutOfMadnessType = 'Phobia (恐懼症)' | 'Mania (狂暴/偏執)' | 'Hallucination (幻覺與妄想)';

export interface CoC7eSanityResolution {
  sanRoll: DiceRollResult;
  previousSan: number;
  newSan: number;
  sanLost: number;
  succeeded: boolean;
  intCheckRoll?: DiceRollResult;
  triggeredBoutOfMadness: boolean;
  madnessType?: BoutOfMadnessType;
  madnessDurationRounds?: number;
  narrative: string;
}

export function resolveCoC7eSanity(
  currentSan: number,
  sanLossFormula = '1/1d6',
  intScore = 65,
  combatant?: Combatant,
  rng: DeterministicRNG = getGlobalRng()
): CoC7eSanityResolution {
  const sanRoll = rollCoCD100(currentSan, 0, rng);
  const succeeded = sanRoll.total <= currentSan;

  const [passLossExpr, failLossExpr] = sanLossFormula.includes('/')
    ? sanLossFormula.split('/')
    : ['0', sanLossFormula];

  const activeExpr = succeeded ? passLossExpr : failLossExpr;
  const lossRoll = rollDice(activeExpr, rng);
  const sanLost = Math.max(0, lossRoll.total);
  const newSan = Math.max(0, currentSan - sanLost);

  if (combatant) {
    combatant.san = newSan;
  }

  let intCheckRoll: DiceRollResult | undefined;
  let triggeredBoutOfMadness = false;
  let madnessType: BoutOfMadnessType | undefined;
  let madnessDurationRounds: number | undefined;

  if (sanLost >= 5) {
    intCheckRoll = rollCoCD100(intScore, 0, rng);
    // In CoC 7e, succeeding on the INT check means the investigator fully comprehends the cosmic horror and goes temporarily insane!
    if (intCheckRoll.total <= intScore) {
      triggeredBoutOfMadness = true;
      const madnessTypes: BoutOfMadnessType[] = [
        'Phobia (恐懼症)',
        'Mania (狂暴/偏執)',
        'Hallucination (幻覺與妄想)',
      ];
      const idx = rng.nextInt(0, madnessTypes.length - 1);
      madnessType = madnessTypes[idx];
      madnessDurationRounds = rollDice('1d10', rng).total;

      if (combatant) {
        const condMap: ConditionType[] = ['madness_phobia', 'madness_mania', 'madness_hallucination'];
        const cond = condMap[idx];
        if (!combatant.conditions.includes(cond)) {
          combatant.conditions.push(cond);
        }
      }
    }
  }

  const narrative = `理智檢定 (1d100=${sanRoll.total} vs SAN ${currentSan})：${succeeded ? '成功' : '失敗'}，損失 ${sanLost} 點 SAN (剩餘 SAN: ${newSan})。${
    sanLost >= 5
      ? `單次失智 >= 5，觸發 INT 檢定 (${intCheckRoll?.total} vs INT ${intScore})：${
          triggeredBoutOfMadness
            ? `【檢定通過，領悟恐怖真相！觸發臨時瘋狂：${madnessType}，持續 ${madnessDurationRounds} 回合！】`
            : '大腦自我保護壓抑了恐怖記憶，未陷入瘋狂。'
        }`
      : ''
  }`;

  return {
    sanRoll,
    previousSan: currentSan,
    newSan,
    sanLost,
    succeeded,
    intCheckRoll,
    triggeredBoutOfMadness,
    madnessType,
    madnessDurationRounds,
    narrative,
  };
}

export interface CoC7eOpposedCombatResolution {
  attackerCheck: CoC7eCheckResolution;
  defenderCheck: CoC7eCheckResolution;
  defenseMode: 'fight_back' | 'dodge';
  winner: 'attacker' | 'defender' | 'none';
  isImpale: boolean;
  damageDealt: number;
  narrative: string;
}

/**
 * CoC 7e damage per references/coc7e-rules.md: a single hit of at least half max HP is a
 * major wound. At 0 HP an investigator with a major wound is dying (CON check each turn,
 * stabilised by First Aid or Medicine); without one the investigator is only unconscious.
 * Monsters (enemy faction) still die at 0 HP.
 */
export function applyCoC7eDamage(target: Combatant, damage: number): void {
  target.hp = Math.max(0, target.hp - damage);
  if (damage >= Math.ceil(target.maxHp / 2) && !target.conditions.includes('major_wound')) {
    target.conditions.push('major_wound');
  }
  if (target.hp > 0) return;
  if (target.faction === 'enemy') {
    target.isAlive = false;
    return;
  }
  if (!target.conditions.includes('unconscious')) target.conditions.push('unconscious');
  if (target.conditions.includes('major_wound') && !target.conditions.includes('dying')) {
    target.conditions.push('dying');
  }
}

/** Temporary HP soak damage first; returns the damage that is left for hp. */
export function absorbTempHp(target: Combatant, damage: number): number {
  const soaked = Math.min(target.tempHp ?? 0, damage);
  if (soaked > 0) target.tempHp = (target.tempHp ?? 0) - soaked;
  return damage - soaked;
}

/** D&D 0 HP: enemies die, party members fall unconscious and start death saves. */
function dropAtZeroHp(c: Combatant): void {
  if (c.faction === 'enemy') {
    c.isAlive = false;
    return;
  }
  if (c.conditions.includes('unconscious') && c.deathSaves) return;
  if (!c.conditions.includes('unconscious')) c.conditions.push('unconscious');
  c.deathSaves = { successes: 0, failures: 0, isStable: false };
}

/** Apply D&D damage to a target: type modifiers, then temp HP, then hp. Returns the adjusted damage. */
export function takeDnDDamage(target: Combatant, amount: number, damageType: string | undefined): number {
  const adjusted = adjustDamageForType(amount, damageType, target);
  target.hp = Math.max(0, target.hp - absorbTempHp(target, adjusted));
  return adjusted;
}

/** D&D 5e damage-type modifiers: immunity -> 0, resistance -> half, vulnerability -> double (both cancel). */
export function adjustDamageForType(damage: number, damageType: string | undefined, target: Combatant): number {
  if (!damageType) return damage;
  const type = damageType.toLowerCase();
  if (target.stats.immunities?.includes(type)) return 0;
  const resisted = target.stats.resistances?.includes(type) ?? false;
  const vulnerable = target.stats.vulnerabilities?.includes(type) ?? false;
  if (resisted && !vulnerable) return Math.floor(damage / 2);
  if (vulnerable && !resisted) return damage * 2;
  return damage;
}

/** CoC 7e dying turn: a CON check each round; a failure is death. Mirrors resolveDnD5eDeathSave. */
export function resolveCoC7eDeathCheck(
  combatant: Combatant,
  rng: DeterministicRNG = getGlobalRng()
): { isDead: boolean; narrative: string } {
  const con = resolveCoC7eCheck({ skill: combatant.stats.con ?? 50, rng });
  if (con.levelRank >= COC_LEVEL_RANK.Regular) {
    return { isDead: false, narrative: `${combatant.name} 瀕死，CON 檢定 [${con.roll.total}/${con.level}] 成功，勉強撐過這一輪。` };
  }
  combatant.isAlive = false;
  return { isDead: true, narrative: `${combatant.name} 瀕死，CON 檢定 [${con.roll.total}/${con.level}] 失敗，【死亡】。` };
}

/** An ally back above 0 HP is no longer downed: clear unconscious and dying, reset death saves. */
export function clearDowned(c: Combatant): void {
  c.conditions = c.conditions.filter((x) => x !== 'unconscious' && x !== 'dying');
  c.deathSaves = { successes: 0, failures: 0, isStable: true };
}

export function resolveCoC7eOpposedCombat(
  attacker: Combatant,
  defender: Combatant,
  defenseMode: 'fight_back' | 'dodge' = 'dodge',
  baseDamageFormula = '1d6+1',
  canImpale = true,
  rng: DeterministicRNG = getGlobalRng(),
  attackSkill?: number
): CoC7eOpposedCombatResolution {
  // Imported books name the skill 'Fighting: Brawl'; 'Fighting (Brawl)' is the built-in encounter spelling.
  const atkSkill =
    attackSkill ?? attacker.stats.skills?.['Fighting: Brawl'] ?? attacker.stats.skills?.['Fighting (Brawl)'] ?? 60;
  const defSkill =
    defenseMode === 'dodge'
      ? defender.stats.skills?.['Dodge'] ?? 45
      : defender.stats.skills?.['Fighting: Brawl'] ?? defender.stats.skills?.['Fighting (Brawl)'] ?? 50;

  const attackerCheck = resolveCoC7eCheck({ skill: atkSkill, rng });
  const defenderCheck = resolveCoC7eCheck({ skill: defSkill, rng });

  let winner: 'attacker' | 'defender' | 'none' = 'none';

  if (attackerCheck.levelRank < COC_LEVEL_RANK.Regular && defenderCheck.levelRank < COC_LEVEL_RANK.Regular) {
    winner = 'none';
  } else if (defenseMode === 'dodge') {
    // Dodge wins ties in CoC 7e
    if (defenderCheck.levelRank >= attackerCheck.levelRank && defenderCheck.levelRank >= COC_LEVEL_RANK.Regular) {
      winner = 'defender';
    } else if (attackerCheck.levelRank >= COC_LEVEL_RANK.Regular) {
      winner = 'attacker';
    }
  } else {
    // Fight back: Attacker wins ties in CoC 7e
    if (attackerCheck.levelRank >= defenderCheck.levelRank && attackerCheck.levelRank >= COC_LEVEL_RANK.Regular) {
      winner = 'attacker';
    } else if (defenderCheck.levelRank >= COC_LEVEL_RANK.Regular) {
      winner = 'defender';
    }
  }

  let isImpale = false;
  let damageDealt = 0;

  if (winner === 'attacker') {
    isImpale = canImpale && attackerCheck.levelRank >= COC_LEVEL_RANK.Extreme;
    if (isImpale) {
      // Impale: maximum base damage + extra roll of damage die
      const extraRoll = rollDice(baseDamageFormula, rng);
      damageDealt = extraRoll.total + 6;
    } else {
      damageDealt = rollDice(baseDamageFormula, rng).total;
    }
    applyCoC7eDamage(defender, damageDealt);
  } else if (winner === 'defender' && defenseMode === 'fight_back') {
    damageDealt = rollDice('1d4+1', rng).total;
    applyCoC7eDamage(attacker, damageDealt);
  }

  const narrative = `CoC 7e 對抗近戰：${attacker.name} 攻擊 [${attackerCheck.roll.total}/${attackerCheck.level}] vs ${defender.name} ${defenseMode === 'dodge' ? '閃避' : '反擊'} [${defenderCheck.roll.total}/${defenderCheck.level}] => ${
    winner === 'attacker'
      ? `${attacker.name} 勝出！${isImpale ? '【極限貫穿 Impale！】' : ''}對 ${defender.name} 造成 ${damageDealt} 點傷害！`
      : winner === 'defender'
        ? defenseMode === 'dodge'
          ? `${defender.name} 驚險閃避了攻擊！`
          : `${defender.name} 反擊成功！對 ${attacker.name} 造成 ${damageDealt} 點傷害！`
        : '雙方皆未命中。'
  }`;

  return {
    attackerCheck,
    defenderCheck,
    defenseMode,
    winner,
    isImpale,
    damageDealt,
    narrative,
  };
}

// ============================================================================
// 3. PbtA (Dungeon World) Deterministic Adjudication Module
// ============================================================================

export type PbtAOutcomeTier = '10+ (Full Success)' | '7-9 (Partial Success)' | '6- (Miss)';

export interface PbtAMoveResolution {
  moveName: string;
  statUsed: string;
  statMod: number;
  roll: DiceRollResult;
  tier: PbtAOutcomeTier;
  xpAwarded: number;
  complicationsOrBargains: string[];
  gmHardMove?: string;
  damageDealt?: number;
  narrative: string;
}

const PBTA_PARTIAL_BARGAINS: Record<string, string[]> = {
  'Hack and Slash': [
    '你造成傷害，但同時暴露在敵人的反擊之下（受到敵方傷害）',
    '你勉強擊中，但武器卡住或失去有利站位',
  ],
  Volley: [
    '你必須移動到危險位置才能取得射界',
    '你只能妥協承受傷害減半 (-1d6)',
    '你消耗了額外彈藥（標記 1 點彈藥耗損）',
  ],
  'Cast a Spell': [
    '法術引來非預期的奧術反噬，你吸引到了周遭怪物的仇恨',
    '這次施法擾動了魔網，你在下一次施法檢定承受 -1 減值',
    '法術在本次遭遇結束前被暫時遺忘',
  ],
  'Defy Danger': [
    '你跌跌撞撞勉強避開致命傷，但陷入窘迫處境',
    'GM 提出一個艱難的取捨代價（捨棄一件非關鍵裝備或承受輕微擦傷）',
  ],
  default: [
    '成功達成目的，但伴隨明顯的代價或複雜局勢',
    '你必須在「承受小額傷害」與「使友軍陷入不利位置」之間二選一',
  ],
};

const GM_HARD_MOVES_BY_DANGER: Record<number, string[]> = {
  1: [
    '【消耗資源 Use Up Their Resources】敵人的猛擊震飛了角色的補給品或火把',
    '【預示逼近的威脅 Show Signs of an Approaching Threat】遠處迴廊傳來沉重的增援腳步聲',
  ],
  2: [
    '【製造兩難處境 Put Someone in a Spot】怪物將利爪架在瀕死友軍頸部，逼迫你立即抉擇',
    '【翻轉他們的舉動 Turn Their Move Back on Them】招式被敵人徹底看穿並借力反制',
  ],
  3: [
    '【直接造成傷害 Deal Damage】敵人抓住破綻發動毫不留情的重擊',
    '【拆散隊伍 Separate Them】地板塌陷或暗門落下，將前排與後排硬生生隔離',
  ],
  4: [
    '【直接造成沉重傷害並附加負面狀態 Deal Heavy Damage & Debility】狂暴首領發動毀滅性橫掃，震碎護甲',
    '【奪走關鍵優勢 Take Away Their Stuff】法杖或武器被擊落至深淵邊緣',
  ],
  5: [
    '【災厄級硬招式 Catastrophic GM Hard Move】古老祭壇爆發混沌能量，全場地形崩毀並對觸發者造成穿甲重創！',
  ],
};

export function resolvePbtAMove(
  actor: Combatant,
  moveName = 'Hack and Slash',
  statMod = 1,
  dangerLevel = 2,
  target?: Combatant,
  damageFormula = '1d8+2',
  rng: DeterministicRNG = getGlobalRng()
): PbtAMoveResolution {
  const signMod = statMod >= 0 ? `+${statMod}` : `${statMod}`;
  const roll = rollDice(`2d6${signMod}`, rng);

  let tier: PbtAOutcomeTier;
  let xpAwarded = 0;
  let complicationsOrBargains: string[] = [];
  let gmHardMove: string | undefined;
  let damageDealt: number | undefined;

  if (roll.total >= 10) {
    tier = '10+ (Full Success)';
    if (target) {
      damageDealt = rollDice(damageFormula, rng).total;
      target.hp = Math.max(0, target.hp - damageDealt);
      if (target.hp === 0) target.isAlive = false;
    }
  } else if (roll.total >= 7) {
    tier = '7-9 (Partial Success)';
    complicationsOrBargains = PBTA_PARTIAL_BARGAINS[moveName] ?? PBTA_PARTIAL_BARGAINS.default;
    if (target) {
      damageDealt = rollDice(damageFormula, rng).total;
      target.hp = Math.max(0, target.hp - damageDealt);
      if (target.hp === 0) target.isAlive = false;
      // On 7-9 Hack & Slash, enemy also deals counter damage
      const counterDmg = rollDice('1d6', rng).total;
      actor.hp = Math.max(0, actor.hp - counterDmg);
    }
  } else {
    tier = '6- (Miss)';
    xpAwarded = 1;
    actor.stats.xp = (actor.stats.xp ?? 0) + 1;

    const clampedDanger = Math.max(1, Math.min(5, Math.round(dangerLevel)));
    const pool = GM_HARD_MOVES_BY_DANGER[clampedDanger] ?? GM_HARD_MOVES_BY_DANGER[2];
    gmHardMove = pool[rng.nextInt(0, pool.length - 1)];

    // Apply mechanical impact of GM Hard Move on 6-
    const hardDmg = rollDice(`${clampedDanger}d4`, rng).total;
    actor.hp = Math.max(0, actor.hp - hardDmg);
  }

  const narrative = `PbtA 動作【${moveName}】(${roll.details}) => 判定結果：【${tier}】${
    damageDealt !== undefined && target ? ` | 對 ${target.name} 造成 ${damageDealt} 點傷害` : ''
  }${
    complicationsOrBargains.length > 0
      ? ` | 7-9 代價：${complicationsOrBargains[0]}`
      : ''
  }${
    gmHardMove
      ? ` | 角色獲得 +1 XP (當前 XP: ${actor.stats.xp})，同時觸發 GM Hard Move (危險等級 ${dangerLevel})：${gmHardMove}`
      : ''
  }`;

  return {
    moveName,
    statUsed: 'pbtaMod',
    statMod,
    roll,
    tier,
    xpAwarded,
    complicationsOrBargains,
    gmHardMove,
    damageDealt,
    narrative,
  };
}
