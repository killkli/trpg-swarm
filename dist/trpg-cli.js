#!/usr/bin/env node

// scripts/trpg-cli.ts
import * as path3 from "node:path";
import * as fs3 from "node:fs";
import { fileURLToPath } from "node:url";

// src/engine/dice.ts
var DeterministicRNG = class {
  state;
  constructor(seed) {
    if (seed !== void 0 && Number.isFinite(seed)) {
      this.state = seed >>> 0;
    } else {
      this.state = (Date.now() ^ Math.floor(Math.random() * 4294967295)) >>> 0;
    }
  }
  getSeed() {
    return this.state >>> 0;
  }
  nextFloat() {
    let t = this.state += 1831565813;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
  /**
   * Returns an integer in [min, max] inclusive.
   */
  nextInt(min, max) {
    return Math.floor(this.nextFloat() * (max - min + 1)) + min;
  }
};
var globalRng = new DeterministicRNG();
function getGlobalRng() {
  return globalRng;
}
function rollDice(expression, seedOrRng) {
  const rng = seedOrRng instanceof DeterministicRNG ? seedOrRng : seedOrRng !== void 0 ? new DeterministicRNG(seedOrRng) : globalRng;
  const seedUsed = rng.getSeed();
  const cleanExpr = expression.replace(/\s+/g, "").toLowerCase();
  const termRegex = /([+-]?)(\d+d\d+(?:(?:kh|kl|dh|dl)\d+)?|\d+)/g;
  let match;
  const allRawRolls = [];
  const allKeptRolls = [];
  const allDroppedRolls = [];
  let totalModifier = 0;
  let diceTotal = 0;
  let primaryDieSides = 0;
  let primaryKeptValue = 0;
  let hasPrimaryDie = false;
  const termDetails = [];
  while ((match = termRegex.exec(cleanExpr)) !== null) {
    if (match[0] === "") continue;
    const sign = match[1] === "-" ? -1 : 1;
    const body = match[2];
    if (body.includes("d")) {
      const diceMatch = /^(\d+)d(\d+)(?:(kh|kl|dh|dl)(\d+))?$/.exec(body);
      if (!diceMatch) {
        throw new Error(`Invalid dice term "${body}" in expression "${expression}"`);
      }
      const count = parseInt(diceMatch[1], 10);
      const sides = parseInt(diceMatch[2], 10);
      const keepDropMode = diceMatch[3];
      const keepDropCount = diceMatch[4] ? parseInt(diceMatch[4], 10) : count;
      if (count <= 0 || count > 200 || sides <= 0 || sides > 1e4) {
        throw new Error(`Dice parameters out of bounds in "${body}"`);
      }
      const rolls = [];
      for (let i = 0; i < count; i++) {
        const val = rng.nextInt(1, sides);
        rolls.push({ val, idx: i });
        allRawRolls.push(val);
      }
      let keptIndices = new Set(rolls.map((r) => r.idx));
      if (keepDropMode) {
        const sorted = [...rolls].sort((a, b) => a.val - b.val);
        keptIndices.clear();
        if (keepDropMode === "kh") {
          const toKeep = sorted.slice(Math.max(0, sorted.length - keepDropCount));
          for (const item of toKeep) keptIndices.add(item.idx);
        } else if (keepDropMode === "kl") {
          const toKeep = sorted.slice(0, Math.min(sorted.length, keepDropCount));
          for (const item of toKeep) keptIndices.add(item.idx);
        } else if (keepDropMode === "dl") {
          const toKeep = sorted.slice(Math.min(sorted.length, keepDropCount));
          for (const item of toKeep) keptIndices.add(item.idx);
        } else if (keepDropMode === "dh") {
          const toKeep = sorted.slice(0, Math.max(0, sorted.length - keepDropCount));
          for (const item of toKeep) keptIndices.add(item.idx);
        }
      }
      const termKept = [];
      const termDropped = [];
      for (const r of rolls) {
        if (keptIndices.has(r.idx)) {
          termKept.push(r.val);
          allKeptRolls.push(r.val);
        } else {
          termDropped.push(r.val);
          allDroppedRolls.push(r.val);
        }
      }
      const termSum = termKept.reduce((acc, v) => acc + v, 0) * sign;
      diceTotal += termSum;
      if (!hasPrimaryDie) {
        hasPrimaryDie = true;
        primaryDieSides = sides;
        primaryKeptValue = termKept.length > 0 ? termKept[0] : 0;
      }
      const fmtRolls = rolls.map((r) => keptIndices.has(r.idx) ? `${r.val}` : `~${r.val}~`).join(", ");
      termDetails.push(`${sign < 0 ? "-" : ""}${body}[${fmtRolls}]`);
    } else {
      const modVal = parseInt(body, 10) * sign;
      totalModifier += modVal;
      termDetails.push(`${modVal >= 0 ? "+" + modVal : modVal}`);
    }
  }
  const total = diceTotal + totalModifier;
  let isCriticalSuccess = false;
  let isCriticalFailure = false;
  if (hasPrimaryDie) {
    if (primaryDieSides === 20) {
      isCriticalSuccess = primaryKeptValue === 20;
      isCriticalFailure = primaryKeptValue === 1;
    } else if (primaryDieSides === 100) {
      isCriticalSuccess = primaryKeptValue === 1;
      isCriticalFailure = primaryKeptValue >= 96;
    } else if (primaryDieSides === 6 && allRawRolls.length === 2 && allKeptRolls.length === 2) {
      const sum2d6 = allKeptRolls[0] + allKeptRolls[1];
      isCriticalSuccess = sum2d6 === 12;
      isCriticalFailure = sum2d6 === 2;
    }
  }
  return {
    expression: cleanExpr,
    rawRolls: allRawRolls,
    keptRolls: allKeptRolls,
    droppedRolls: allDroppedRolls,
    modifier: totalModifier,
    total,
    isCriticalSuccess,
    isCriticalFailure,
    seedUsed,
    details: `${cleanExpr} => ${termDetails.join(" ")} = ${total}`
  };
}
function rollCoCD100(skill, bonusPenaltyDice = 0, seedOrRng) {
  const rng = seedOrRng instanceof DeterministicRNG ? seedOrRng : seedOrRng !== void 0 ? new DeterministicRNG(seedOrRng) : globalRng;
  const seedUsed = rng.getSeed();
  const unitsDie = rng.nextInt(0, 9);
  const extraTensCount = Math.min(2, Math.abs(Math.trunc(bonusPenaltyDice)));
  const tensDice = [];
  for (let i = 0; i < 1 + extraTensCount; i++) {
    tensDice.push(rng.nextInt(0, 9));
  }
  const candidateTotals = tensDice.map((tens) => {
    const val = tens * 10 + unitsDie;
    return val === 0 ? 100 : val;
  });
  let chosenTotal;
  if (bonusPenaltyDice > 0) {
    chosenTotal = Math.min(...candidateTotals);
  } else if (bonusPenaltyDice < 0) {
    chosenTotal = Math.max(...candidateTotals);
  } else {
    chosenTotal = candidateTotals[0];
  }
  const droppedRolls = candidateTotals.filter((v, idx) => {
    const chosenIdx = candidateTotals.indexOf(chosenTotal);
    return idx !== chosenIdx;
  });
  const isCriticalSuccess = chosenTotal === 1;
  const isCriticalFailure = skill < 50 ? chosenTotal >= 96 : chosenTotal === 100;
  const modeLabel = bonusPenaltyDice > 0 ? `1d100+${extraTensCount}B` : bonusPenaltyDice < 0 ? `1d100+${extraTensCount}P` : "1d100";
  return {
    expression: modeLabel,
    rawRolls: candidateTotals,
    keptRolls: [chosenTotal],
    droppedRolls,
    modifier: 0,
    total: chosenTotal,
    isCriticalSuccess,
    isCriticalFailure,
    seedUsed,
    unitsDie,
    tensDice,
    skillThreshold: skill,
    details: `${modeLabel} (units=${unitsDie}, tens=[${tensDice.join(",")}]) => candidates=[${candidateTotals.join(", ")}] => ${chosenTotal} (vs Skill ${skill})`
  };
}
function estimateDiceExpectedValue(formula) {
  if (!formula) return 0;
  const clean = formula.replace(/\s+/g, "").toLowerCase();
  const termRegex = /([+-]?)(\d+d\d+|\d+)/g;
  let match;
  let expected = 0;
  while ((match = termRegex.exec(clean)) !== null) {
    if (match[0] === "") continue;
    const sign = match[1] === "-" ? -1 : 1;
    const body = match[2];
    if (body.includes("d")) {
      const [cStr, sStr] = body.split("d");
      const count = parseInt(cStr, 10) || 1;
      const sides = parseInt(sStr, 10) || 6;
      expected += sign * count * ((sides + 1) / 2);
    } else {
      expected += sign * (parseInt(body, 10) || 0);
    }
  }
  return Math.max(0, expected);
}

// src/engine/rulesEngine.ts
function getAbilityModifier(score = 10) {
  return Math.floor((score - 10) / 2);
}
function calculateDnD5eSaveDC(caster, spellAbility = "int") {
  const prof = caster.stats.proficiencyBonus ?? 2;
  const score = caster.stats[spellAbility] ?? 14;
  return 8 + prof + getAbilityModifier(score);
}
function doubleDamageDiceInFormula(formula) {
  return formula.replace(/(\d+)d(\d+)/gi, (_match, countStr, sidesStr) => {
    const count = parseInt(countStr, 10) * 2;
    return `${count}d${sidesStr}`;
  });
}
function resolveDnD5eAttack(opts) {
  const { attacker, defender, action, isFlanking = false } = opts;
  const rng = opts.rng ?? getGlobalRng();
  const coverTerrain = opts.targetCover ?? defender.position.terrain ?? "normal";
  let coverBonus = 0;
  if (coverTerrain === "cover_half") coverBonus = 2;
  else if (coverTerrain === "cover_three_quarters") coverBonus = 5;
  const effectiveAC = defender.ac + coverBonus;
  let advCount = 0;
  let disadvCount = 0;
  const attackerElev = attacker.position.elevation ?? 0;
  const defenderElev = defender.position.elevation ?? 0;
  if (attackerElev > defenderElev) {
    advCount++;
  }
  if (isFlanking && action.type === "melee") {
    advCount++;
  }
  if (defender.conditions.includes("Restrained") || defender.conditions.includes("restrained")) {
    advCount++;
  }
  if (defender.conditions.includes("stunned") || defender.conditions.includes("unconscious")) {
    advCount++;
  }
  if (defender.conditions.includes("prone")) {
    const dist = Math.hypot(
      attacker.position.x - defender.position.x,
      attacker.position.y - defender.position.y
    );
    if (dist <= 1.5) advCount++;
    else disadvCount++;
  }
  if (defender.conditions.includes("dodging")) {
    disadvCount++;
  }
  if (attacker.conditions.includes("prone") || attacker.conditions.includes("poisoned") || attacker.conditions.includes("frightened") || attacker.conditions.includes("restrained")) {
    disadvCount++;
  }
  let advantageState = "normal";
  if (advCount > 0 && disadvCount === 0) advantageState = "advantage";
  else if (disadvCount > 0 && advCount === 0) advantageState = "disadvantage";
  const atkBonus = action.attackBonus ?? (attacker.stats.proficiencyBonus ?? 2) + getAbilityModifier(attacker.stats.str ?? 14);
  const d20Core = advantageState === "advantage" ? "2d20kh1" : advantageState === "disadvantage" ? "2d20kl1" : "1d20";
  const blessBonus = attacker.conditions.includes("blessed") ? "+1d4" : "";
  const signBonus = atkBonus >= 0 ? `+${atkBonus}` : `${atkBonus}`;
  const attackExpr = `${d20Core}${blessBonus}${signBonus}`;
  const attackRoll = rollDice(attackExpr, rng);
  const isCritical = attackRoll.isCriticalSuccess;
  const isFumble = attackRoll.isCriticalFailure;
  const hit = isCritical || !isFumble && attackRoll.total >= effectiveAC;
  let damageRoll;
  let totalDamage = 0;
  let concentrationBroken = false;
  if (hit) {
    const baseFormula = action.damageFormula ?? "1d8+3";
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
  const narrative = hit ? `${attacker.name} \u4F7F\u7528\u3010${action.name}\u3011(${advantageState}) \u64F2\u51FA ${attackRoll.total} vs AC ${effectiveAC} (\u542B\u63A9\u9AD4 +${coverBonus}) \u2014\u2014 ${isCritical ? "\u3010\u66B4\u64CA Natural 20\uFF01\u3011" : "\u547D\u4E2D\uFF01"}\u9020\u6210 ${totalDamage} \u9EDE\u50B7\u5BB3 (${defender.name} \u5269\u9918 HP: ${defender.hp}/${defender.maxHp})\u3002` : `${attacker.name} \u4F7F\u7528\u3010${action.name}\u3011(${advantageState}) \u64F2\u51FA ${attackRoll.total} vs AC ${effectiveAC} (\u542B\u63A9\u9AD4 +${coverBonus}) \u2014\u2014 ${isFumble ? "\u3010\u5927\u5931\u6557 Natural 1\uFF01\u3011" : "\u672A\u547D\u4E2D\u3002"}`;
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
    narrative
  };
}
function resolveDnD5eSavingThrow(caster, target, action, halfOnSave = true, rng = getGlobalRng()) {
  const saveAbility = action.saveAbility ?? "dex";
  const dc = action.saveDC ?? calculateDnD5eSaveDC(caster, caster.role === "healer" ? "wis" : "int");
  const abilityScore = target.stats[saveAbility] ?? 10;
  const mod = getAbilityModifier(abilityScore);
  let coverBonus = 0;
  if (saveAbility === "dex") {
    if (target.position.terrain === "cover_half") coverBonus = 2;
    else if (target.position.terrain === "cover_three_quarters") coverBonus = 5;
  }
  const totalMod = mod + coverBonus;
  const d20Expr = target.conditions.includes("dodging") && saveAbility === "dex" ? "2d20kh1" : "1d20";
  const signMod = totalMod >= 0 ? `+${totalMod}` : `${totalMod}`;
  const saveRoll = rollDice(`${d20Expr}${signMod}`, rng);
  const succeeded = saveRoll.isCriticalSuccess || !saveRoll.isCriticalFailure && saveRoll.total >= dc;
  let damageRoll;
  let damageTaken = 0;
  let conditionApplied;
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
  const narrative = `${target.name} \u9032\u884C ${saveAbility.toUpperCase()} \u8C41\u514D\u6AA2\u5B9A (DC ${dc})\uFF1A\u64F2\u51FA ${saveRoll.total} \u2014\u2014 ${succeeded ? "\u8C41\u514D\u6210\u529F\uFF01" : "\u8C41\u514D\u5931\u6557\uFF01"}${damageTaken > 0 ? `\u53D7\u5230 ${damageTaken} \u9EDE\u50B7\u5BB3 (\u5269\u9918 HP: ${target.hp}/${target.maxHp})\u3002` : ""}${conditionApplied ? `\u9677\u5165\u3010${conditionApplied}\u3011\u72C0\u614B\uFF01` : ""}`;
  return {
    dc,
    saveAbility,
    saveRoll,
    succeeded,
    damageRoll,
    damageTaken,
    conditionApplied,
    narrative
  };
}
function resolveDnD5eDeathSave(combatant, rng = getGlobalRng()) {
  if (!combatant.deathSaves) {
    combatant.deathSaves = { successes: 0, failures: 0, isStable: false };
  }
  const roll = rollDice("1d20", rng);
  let revivedWith1Hp = false;
  let isDead = false;
  if (roll.isCriticalSuccess) {
    combatant.hp = 1;
    combatant.deathSaves = { successes: 0, failures: 0, isStable: true };
    combatant.conditions = combatant.conditions.filter((c) => c !== "unconscious");
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
  const narrative = revivedWith1Hp ? `${combatant.name} \u6B7B\u4EA1\u8C41\u514D\u64F2\u51FA Natural 20\uFF01\u5947\u8E5F\u822C\u6062\u5FA9 1 \u9EDE HP \u4E26\u7526\u9192\uFF01` : isDead ? `${combatant.name} \u6B7B\u4EA1\u8C41\u514D\u64F2\u51FA ${roll.total}\uFF0C\u7D2F\u8A08\u5931\u6557\u9054 3 \u6B21\uFF0C\u89D2\u8272\u9663\u4EA1\u3002` : `${combatant.name} \u6B7B\u4EA1\u8C41\u514D\u64F2\u51FA ${roll.total} (\u6210\u529F: ${combatant.deathSaves.successes}/3, \u5931\u6557: ${combatant.deathSaves.failures}/3)${combatant.deathSaves.isStable ? " \u2014\u2014 \u50B7\u52E2\u5DF2\u7A69\u5B9A\uFF01" : ""}`;
  return {
    roll,
    successes: combatant.deathSaves.successes,
    failures: combatant.deathSaves.failures,
    isStable: combatant.deathSaves.isStable,
    revivedWith1Hp,
    isDead,
    narrative
  };
}
function resolveConcentrationCheck(combatant, damageTaken, rng = getGlobalRng()) {
  const dc = Math.max(10, Math.floor(damageTaken / 2));
  const conMod = getAbilityModifier(combatant.stats.con ?? 12);
  const signMod = conMod >= 0 ? `+${conMod}` : `${conMod}`;
  const roll = rollDice(`1d20${signMod}`, rng);
  const maintained = roll.total >= dc;
  if (!maintained) {
    combatant.concentratingOn = void 0;
    combatant.conditions = combatant.conditions.filter((c) => c !== "concentrating");
  }
  return {
    dc,
    roll,
    maintained,
    narrative: `${combatant.name} \u9032\u884C\u5C08\u6CE8\u6AA2\u5B9A (DC ${dc}) \u64F2\u51FA ${roll.total} \u2014\u2014 ${maintained ? "\u6210\u529F\u7DAD\u6301\u6CD5\u8853\u5C08\u6CE8\uFF01" : "\u5C08\u6CE8\u4E2D\u65B7\uFF01"}`
  };
}
var COC_LEVEL_RANK = {
  Fumble: 0,
  Failure: 1,
  Regular: 2,
  Hard: 3,
  Extreme: 4,
  Critical: 5
};
function classifyCoC7eRoll(rollVal, skill) {
  const hard = Math.floor(skill / 2);
  const extreme = Math.floor(skill / 5);
  const isFumble = skill < 50 ? rollVal >= 96 : rollVal === 100;
  if (rollVal === 1) return "Critical";
  if (isFumble) return "Fumble";
  if (rollVal <= extreme) return "Extreme";
  if (rollVal <= hard) return "Hard";
  if (rollVal <= skill) return "Regular";
  return "Failure";
}
function resolveCoC7eCheck(opts) {
  const {
    skill,
    bonusPenaltyDice = 0,
    difficulty = "Regular",
    spendLuckToSucceed = false,
    availableLuck = 0,
    pushRoll = false
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
  if (!succeeded && spendLuckToSucceed && level !== "Fumble") {
    const targetThreshold = difficulty === "Extreme" ? extremeThreshold : difficulty === "Hard" ? hardThreshold : skill;
    const needed = roll.total - targetThreshold;
    if (needed > 0 && availableLuck >= needed) {
      luckSpent = needed;
      remainingLuck = availableLuck - needed;
      level = difficulty;
      levelRank = COC_LEVEL_RANK[level];
      succeeded = true;
    }
  }
  let pushedAttempt;
  if (!succeeded && pushRoll && level !== "Fumble") {
    const pRoll = rollCoCD100(skill, bonusPenaltyDice, rng);
    const pLevel = classifyCoC7eRoll(pRoll.total, skill);
    const pSucceeded = COC_LEVEL_RANK[pLevel] >= requiredRank;
    pushedAttempt = {
      roll: pRoll,
      level: pLevel,
      succeeded: pSucceeded,
      consequenceTriggered: !pSucceeded
    };
    if (pSucceeded) {
      level = pLevel;
      levelRank = COC_LEVEL_RANK[pLevel];
      succeeded = true;
    }
  }
  const narrative = `CoC 7e \u6280\u80FD\u6AA2\u5B9A (\u76EE\u6A19 ${skill} / \u56F0\u96E3 ${hardThreshold} / \u6975\u9650 ${extremeThreshold})\uFF1A\u64F2\u51FA ${roll.total} => \u3010${level}\u3011${luckSpent > 0 ? ` (\u71C3\u71D2 ${luckSpent} \u9EDE\u5E78\u904B\u503C\u9006\u8F49\u6210\u529F\uFF01)` : ""}${pushedAttempt ? ` | \u5B64\u6CE8\u4E00\u64F2\u91CD\u64F2: ${pushedAttempt.roll.total} (${pushedAttempt.level})${pushedAttempt.consequenceTriggered ? " \u2014\u2014 \u5B64\u6CE8\u4E00\u64F2\u5931\u6557\uFF0C\u89F8\u767C\u5B88\u79D8\u4EBA\u56B4\u91CD\u5F8C\u679C\uFF01" : ""}` : ""}`;
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
    narrative
  };
}
function resolveCoC7eSanity(currentSan, sanLossFormula = "1/1d6", intScore = 65, combatant, rng = getGlobalRng()) {
  const sanRoll = rollCoCD100(currentSan, 0, rng);
  const succeeded = sanRoll.total <= currentSan;
  const [passLossExpr, failLossExpr] = sanLossFormula.includes("/") ? sanLossFormula.split("/") : ["0", sanLossFormula];
  const activeExpr = succeeded ? passLossExpr : failLossExpr;
  const lossRoll = rollDice(activeExpr, rng);
  const sanLost = Math.max(0, lossRoll.total);
  const newSan = Math.max(0, currentSan - sanLost);
  if (combatant) {
    combatant.san = newSan;
  }
  let intCheckRoll;
  let triggeredBoutOfMadness = false;
  let madnessType;
  let madnessDurationRounds;
  if (sanLost >= 5) {
    intCheckRoll = rollCoCD100(intScore, 0, rng);
    if (intCheckRoll.total <= intScore) {
      triggeredBoutOfMadness = true;
      const madnessTypes = [
        "Phobia (\u6050\u61FC\u75C7)",
        "Mania (\u72C2\u66B4/\u504F\u57F7)",
        "Hallucination (\u5E7B\u89BA\u8207\u5984\u60F3)"
      ];
      const idx = rng.nextInt(0, madnessTypes.length - 1);
      madnessType = madnessTypes[idx];
      madnessDurationRounds = rollDice("1d10", rng).total;
      if (combatant) {
        const condMap = ["madness_phobia", "madness_mania", "madness_hallucination"];
        const cond = condMap[idx];
        if (!combatant.conditions.includes(cond)) {
          combatant.conditions.push(cond);
        }
      }
    }
  }
  const narrative = `\u7406\u667A\u6AA2\u5B9A (1d100=${sanRoll.total} vs SAN ${currentSan})\uFF1A${succeeded ? "\u6210\u529F" : "\u5931\u6557"}\uFF0C\u640D\u5931 ${sanLost} \u9EDE SAN (\u5269\u9918 SAN: ${newSan})\u3002${sanLost >= 5 ? `\u55AE\u6B21\u5931\u667A >= 5\uFF0C\u89F8\u767C INT \u6AA2\u5B9A (${intCheckRoll?.total} vs INT ${intScore})\uFF1A${triggeredBoutOfMadness ? `\u3010\u6AA2\u5B9A\u901A\u904E\uFF0C\u9818\u609F\u6050\u6016\u771F\u76F8\uFF01\u89F8\u767C\u81E8\u6642\u760B\u72C2\uFF1A${madnessType}\uFF0C\u6301\u7E8C ${madnessDurationRounds} \u56DE\u5408\uFF01\u3011` : "\u5927\u8166\u81EA\u6211\u4FDD\u8B77\u58D3\u6291\u4E86\u6050\u6016\u8A18\u61B6\uFF0C\u672A\u9677\u5165\u760B\u72C2\u3002"}` : ""}`;
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
    narrative
  };
}
function applyCoC7eDamage(target, damage) {
  target.hp = Math.max(0, target.hp - damage);
  if (damage >= Math.ceil(target.maxHp / 2) && !target.conditions.includes("major_wound")) {
    target.conditions.push("major_wound");
  }
  if (target.hp > 0) return;
  if (target.faction === "enemy") {
    target.isAlive = false;
    return;
  }
  if (!target.conditions.includes("unconscious")) target.conditions.push("unconscious");
  if (target.conditions.includes("major_wound") && !target.conditions.includes("dying")) {
    target.conditions.push("dying");
  }
}
function absorbTempHp(target, damage) {
  const soaked = Math.min(target.tempHp ?? 0, damage);
  if (soaked > 0) target.tempHp = (target.tempHp ?? 0) - soaked;
  return damage - soaked;
}
function dropAtZeroHp(c) {
  if (c.faction === "enemy") {
    c.isAlive = false;
    return;
  }
  if (c.conditions.includes("unconscious") && c.deathSaves) return;
  if (!c.conditions.includes("unconscious")) c.conditions.push("unconscious");
  c.deathSaves = { successes: 0, failures: 0, isStable: false };
}
function takeDnDDamage(target, amount, damageType) {
  const adjusted = adjustDamageForType(amount, damageType, target);
  target.hp = Math.max(0, target.hp - absorbTempHp(target, adjusted));
  return adjusted;
}
function adjustDamageForType(damage, damageType, target) {
  if (!damageType) return damage;
  const type = damageType.toLowerCase();
  if (target.stats.immunities?.includes(type)) return 0;
  const resisted = target.stats.resistances?.includes(type) ?? false;
  const vulnerable = target.stats.vulnerabilities?.includes(type) ?? false;
  if (resisted && !vulnerable) return Math.floor(damage / 2);
  if (vulnerable && !resisted) return damage * 2;
  return damage;
}
function resolveCoC7eDeathCheck(combatant, rng = getGlobalRng()) {
  const con = resolveCoC7eCheck({ skill: combatant.stats.con ?? 50, rng });
  if (con.levelRank >= COC_LEVEL_RANK.Regular) {
    return { isDead: false, narrative: `${combatant.name} \u7015\u6B7B\uFF0CCON \u6AA2\u5B9A [${con.roll.total}/${con.level}] \u6210\u529F\uFF0C\u52C9\u5F37\u6490\u904E\u9019\u4E00\u8F2A\u3002` };
  }
  combatant.isAlive = false;
  return { isDead: true, narrative: `${combatant.name} \u7015\u6B7B\uFF0CCON \u6AA2\u5B9A [${con.roll.total}/${con.level}] \u5931\u6557\uFF0C\u3010\u6B7B\u4EA1\u3011\u3002` };
}
function clearDowned(c) {
  c.conditions = c.conditions.filter((x) => x !== "unconscious" && x !== "dying");
  c.deathSaves = { successes: 0, failures: 0, isStable: true };
}
function resolveCoC7eOpposedCombat(attacker, defender, defenseMode = "dodge", baseDamageFormula = "1d6+1", canImpale = true, rng = getGlobalRng()) {
  const atkSkill = attacker.stats.skills?.["Fighting (Brawl)"] ?? 60;
  const defSkill = defenseMode === "dodge" ? defender.stats.skills?.["Dodge"] ?? 45 : defender.stats.skills?.["Fighting (Brawl)"] ?? 50;
  const attackerCheck = resolveCoC7eCheck({ skill: atkSkill, rng });
  const defenderCheck = resolveCoC7eCheck({ skill: defSkill, rng });
  let winner = "none";
  if (attackerCheck.levelRank < COC_LEVEL_RANK.Regular && defenderCheck.levelRank < COC_LEVEL_RANK.Regular) {
    winner = "none";
  } else if (defenseMode === "dodge") {
    if (defenderCheck.levelRank >= attackerCheck.levelRank && defenderCheck.levelRank >= COC_LEVEL_RANK.Regular) {
      winner = "defender";
    } else if (attackerCheck.levelRank >= COC_LEVEL_RANK.Regular) {
      winner = "attacker";
    }
  } else {
    if (attackerCheck.levelRank >= defenderCheck.levelRank && attackerCheck.levelRank >= COC_LEVEL_RANK.Regular) {
      winner = "attacker";
    } else if (defenderCheck.levelRank >= COC_LEVEL_RANK.Regular) {
      winner = "defender";
    }
  }
  let isImpale = false;
  let damageDealt = 0;
  if (winner === "attacker") {
    isImpale = canImpale && attackerCheck.levelRank >= COC_LEVEL_RANK.Extreme;
    if (isImpale) {
      const extraRoll = rollDice(baseDamageFormula, rng);
      damageDealt = extraRoll.total + 6;
    } else {
      damageDealt = rollDice(baseDamageFormula, rng).total;
    }
    applyCoC7eDamage(defender, damageDealt);
  } else if (winner === "defender" && defenseMode === "fight_back") {
    damageDealt = rollDice("1d4+1", rng).total;
    applyCoC7eDamage(attacker, damageDealt);
  }
  const narrative = `CoC 7e \u5C0D\u6297\u8FD1\u6230\uFF1A${attacker.name} \u653B\u64CA [${attackerCheck.roll.total}/${attackerCheck.level}] vs ${defender.name} ${defenseMode === "dodge" ? "\u9583\u907F" : "\u53CD\u64CA"} [${defenderCheck.roll.total}/${defenderCheck.level}] => ${winner === "attacker" ? `${attacker.name} \u52DD\u51FA\uFF01${isImpale ? "\u3010\u6975\u9650\u8CAB\u7A7F Impale\uFF01\u3011" : ""}\u5C0D ${defender.name} \u9020\u6210 ${damageDealt} \u9EDE\u50B7\u5BB3\uFF01` : winner === "defender" ? defenseMode === "dodge" ? `${defender.name} \u9A5A\u96AA\u9583\u907F\u4E86\u653B\u64CA\uFF01` : `${defender.name} \u53CD\u64CA\u6210\u529F\uFF01\u5C0D ${attacker.name} \u9020\u6210 ${damageDealt} \u9EDE\u50B7\u5BB3\uFF01` : "\u96D9\u65B9\u7686\u672A\u547D\u4E2D\u3002"}`;
  return {
    attackerCheck,
    defenderCheck,
    defenseMode,
    winner,
    isImpale,
    damageDealt,
    narrative
  };
}
var PBTA_PARTIAL_BARGAINS = {
  "Hack and Slash": [
    "\u4F60\u9020\u6210\u50B7\u5BB3\uFF0C\u4F46\u540C\u6642\u66B4\u9732\u5728\u6575\u4EBA\u7684\u53CD\u64CA\u4E4B\u4E0B\uFF08\u53D7\u5230\u6575\u65B9\u50B7\u5BB3\uFF09",
    "\u4F60\u52C9\u5F37\u64CA\u4E2D\uFF0C\u4F46\u6B66\u5668\u5361\u4F4F\u6216\u5931\u53BB\u6709\u5229\u7AD9\u4F4D"
  ],
  Volley: [
    "\u4F60\u5FC5\u9808\u79FB\u52D5\u5230\u5371\u96AA\u4F4D\u7F6E\u624D\u80FD\u53D6\u5F97\u5C04\u754C",
    "\u4F60\u53EA\u80FD\u59A5\u5354\u627F\u53D7\u50B7\u5BB3\u6E1B\u534A (-1d6)",
    "\u4F60\u6D88\u8017\u4E86\u984D\u5916\u5F48\u85E5\uFF08\u6A19\u8A18 1 \u9EDE\u5F48\u85E5\u8017\u640D\uFF09"
  ],
  "Cast a Spell": [
    "\u6CD5\u8853\u5F15\u4F86\u975E\u9810\u671F\u7684\u5967\u8853\u53CD\u566C\uFF0C\u4F60\u5438\u5F15\u5230\u4E86\u5468\u906D\u602A\u7269\u7684\u4EC7\u6068",
    "\u9019\u6B21\u65BD\u6CD5\u64FE\u52D5\u4E86\u9B54\u7DB2\uFF0C\u4F60\u5728\u4E0B\u4E00\u6B21\u65BD\u6CD5\u6AA2\u5B9A\u627F\u53D7 -1 \u6E1B\u503C",
    "\u6CD5\u8853\u5728\u672C\u6B21\u906D\u9047\u7D50\u675F\u524D\u88AB\u66AB\u6642\u907A\u5FD8"
  ],
  "Defy Danger": [
    "\u4F60\u8DCC\u8DCC\u649E\u649E\u52C9\u5F37\u907F\u958B\u81F4\u547D\u50B7\uFF0C\u4F46\u9677\u5165\u7A98\u8FEB\u8655\u5883",
    "GM \u63D0\u51FA\u4E00\u500B\u8271\u96E3\u7684\u53D6\u6368\u4EE3\u50F9\uFF08\u6368\u68C4\u4E00\u4EF6\u975E\u95DC\u9375\u88DD\u5099\u6216\u627F\u53D7\u8F15\u5FAE\u64E6\u50B7\uFF09"
  ],
  default: [
    "\u6210\u529F\u9054\u6210\u76EE\u7684\uFF0C\u4F46\u4F34\u96A8\u660E\u986F\u7684\u4EE3\u50F9\u6216\u8907\u96DC\u5C40\u52E2",
    "\u4F60\u5FC5\u9808\u5728\u300C\u627F\u53D7\u5C0F\u984D\u50B7\u5BB3\u300D\u8207\u300C\u4F7F\u53CB\u8ECD\u9677\u5165\u4E0D\u5229\u4F4D\u7F6E\u300D\u4E4B\u9593\u4E8C\u9078\u4E00"
  ]
};
var GM_HARD_MOVES_BY_DANGER = {
  1: [
    "\u3010\u6D88\u8017\u8CC7\u6E90 Use Up Their Resources\u3011\u6575\u4EBA\u7684\u731B\u64CA\u9707\u98DB\u4E86\u89D2\u8272\u7684\u88DC\u7D66\u54C1\u6216\u706B\u628A",
    "\u3010\u9810\u793A\u903C\u8FD1\u7684\u5A01\u8105 Show Signs of an Approaching Threat\u3011\u9060\u8655\u8FF4\u5ECA\u50B3\u4F86\u6C89\u91CD\u7684\u589E\u63F4\u8173\u6B65\u8072"
  ],
  2: [
    "\u3010\u88FD\u9020\u5169\u96E3\u8655\u5883 Put Someone in a Spot\u3011\u602A\u7269\u5C07\u5229\u722A\u67B6\u5728\u7015\u6B7B\u53CB\u8ECD\u9838\u90E8\uFF0C\u903C\u8FEB\u4F60\u7ACB\u5373\u6289\u64C7",
    "\u3010\u7FFB\u8F49\u4ED6\u5011\u7684\u8209\u52D5 Turn Their Move Back on Them\u3011\u62DB\u5F0F\u88AB\u6575\u4EBA\u5FB9\u5E95\u770B\u7A7F\u4E26\u501F\u529B\u53CD\u5236"
  ],
  3: [
    "\u3010\u76F4\u63A5\u9020\u6210\u50B7\u5BB3 Deal Damage\u3011\u6575\u4EBA\u6293\u4F4F\u7834\u7DBB\u767C\u52D5\u6BEB\u4E0D\u7559\u60C5\u7684\u91CD\u64CA",
    "\u3010\u62C6\u6563\u968A\u4F0D Separate Them\u3011\u5730\u677F\u584C\u9677\u6216\u6697\u9580\u843D\u4E0B\uFF0C\u5C07\u524D\u6392\u8207\u5F8C\u6392\u786C\u751F\u751F\u9694\u96E2"
  ],
  4: [
    "\u3010\u76F4\u63A5\u9020\u6210\u6C89\u91CD\u50B7\u5BB3\u4E26\u9644\u52A0\u8CA0\u9762\u72C0\u614B Deal Heavy Damage & Debility\u3011\u72C2\u66B4\u9996\u9818\u767C\u52D5\u6BC0\u6EC5\u6027\u6A6B\u6383\uFF0C\u9707\u788E\u8B77\u7532",
    "\u3010\u596A\u8D70\u95DC\u9375\u512A\u52E2 Take Away Their Stuff\u3011\u6CD5\u6756\u6216\u6B66\u5668\u88AB\u64CA\u843D\u81F3\u6DF1\u6DF5\u908A\u7DE3"
  ],
  5: [
    "\u3010\u707D\u5384\u7D1A\u786C\u62DB\u5F0F Catastrophic GM Hard Move\u3011\u53E4\u8001\u796D\u58C7\u7206\u767C\u6DF7\u6C8C\u80FD\u91CF\uFF0C\u5168\u5834\u5730\u5F62\u5D29\u6BC0\u4E26\u5C0D\u89F8\u767C\u8005\u9020\u6210\u7A7F\u7532\u91CD\u5275\uFF01"
  ]
};
function resolvePbtAMove(actor, moveName = "Hack and Slash", statMod = 1, dangerLevel = 2, target, damageFormula = "1d8+2", rng = getGlobalRng()) {
  const signMod = statMod >= 0 ? `+${statMod}` : `${statMod}`;
  const roll = rollDice(`2d6${signMod}`, rng);
  let tier;
  let xpAwarded = 0;
  let complicationsOrBargains = [];
  let gmHardMove;
  let damageDealt;
  if (roll.total >= 10) {
    tier = "10+ (Full Success)";
    if (target) {
      damageDealt = rollDice(damageFormula, rng).total;
      target.hp = Math.max(0, target.hp - damageDealt);
      if (target.hp === 0) target.isAlive = false;
    }
  } else if (roll.total >= 7) {
    tier = "7-9 (Partial Success)";
    complicationsOrBargains = PBTA_PARTIAL_BARGAINS[moveName] ?? PBTA_PARTIAL_BARGAINS.default;
    if (target) {
      damageDealt = rollDice(damageFormula, rng).total;
      target.hp = Math.max(0, target.hp - damageDealt);
      if (target.hp === 0) target.isAlive = false;
      const counterDmg = rollDice("1d6", rng).total;
      actor.hp = Math.max(0, actor.hp - counterDmg);
    }
  } else {
    tier = "6- (Miss)";
    xpAwarded = 1;
    actor.stats.xp = (actor.stats.xp ?? 0) + 1;
    const clampedDanger = Math.max(1, Math.min(5, Math.round(dangerLevel)));
    const pool = GM_HARD_MOVES_BY_DANGER[clampedDanger] ?? GM_HARD_MOVES_BY_DANGER[2];
    gmHardMove = pool[rng.nextInt(0, pool.length - 1)];
    const hardDmg = rollDice(`${clampedDanger}d4`, rng).total;
    actor.hp = Math.max(0, actor.hp - hardDmg);
  }
  const narrative = `PbtA \u52D5\u4F5C\u3010${moveName}\u3011(${roll.details}) => \u5224\u5B9A\u7D50\u679C\uFF1A\u3010${tier}\u3011${damageDealt !== void 0 && target ? ` | \u5C0D ${target.name} \u9020\u6210 ${damageDealt} \u9EDE\u50B7\u5BB3` : ""}${complicationsOrBargains.length > 0 ? ` | 7-9 \u4EE3\u50F9\uFF1A${complicationsOrBargains[0]}` : ""}${gmHardMove ? ` | \u89D2\u8272\u7372\u5F97 +1 XP (\u7576\u524D XP: ${actor.stats.xp})\uFF0C\u540C\u6642\u89F8\u767C GM Hard Move (\u5371\u96AA\u7B49\u7D1A ${dangerLevel})\uFF1A${gmHardMove}` : ""}`;
  return {
    moveName,
    statUsed: "pbtaMod",
    statMod,
    roll,
    tier,
    xpAwarded,
    complicationsOrBargains,
    gmHardMove,
    damageDealt,
    narrative
  };
}

// src/engine/tacticalAI.ts
function gridDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function computeCombatantThreatIndex(combatant) {
  if (!combatant.isAlive || combatant.hp <= 0) return 0;
  const hpFactor = 0.4 + 0.6 * (combatant.hp / Math.max(1, combatant.maxHp));
  let maxActionOffense = 0;
  for (const act of combatant.actions) {
    const avgDmg = estimateDiceExpectedValue(act.damageFormula);
    const aoeMultiplier = act.aoeRadius ? 1 + act.aoeRadius * 0.45 : 1;
    const rangeMultiplier = act.range > 2 ? 1.15 : 1;
    const score = avgDmg * aoeMultiplier * rangeMultiplier;
    if (score > maxActionOffense) {
      maxActionOffense = score;
    }
  }
  const conditionPenalty = combatant.conditions.includes("stunned") || combatant.conditions.includes("unconscious") ? 0.25 : combatant.conditions.includes("restrained") || combatant.conditions.includes("prone") ? 0.75 : 1;
  return Math.max(1, maxActionOffense * hpFactor * conditionPenalty);
}
function computeBattlefieldThreatRatio(state, actor) {
  let enemyThreatSum = 0;
  let allyThreatSum = 0;
  for (const c of Object.values(state.combatants)) {
    if (!c.isAlive) continue;
    const threat = computeCombatantThreatIndex(c);
    if (c.faction === actor.faction) {
      allyThreatSum += threat;
    } else if (c.faction !== "neutral") {
      enemyThreatSum += threat;
    }
  }
  return enemyThreatSum / Math.max(1, allyThreatSum);
}
function getReachablePositions(state, actor) {
  const occupied = /* @__PURE__ */ new Set();
  for (const c of Object.values(state.combatants)) {
    if (c.id !== actor.id && c.isAlive && c.hp > 0) {
      occupied.add(`${c.position.x},${c.position.y}`);
    }
  }
  const reachable = [];
  const maxStep = Math.max(1, actor.speed);
  for (let dy = -maxStep; dy <= maxStep; dy++) {
    for (let dx = -maxStep; dx <= maxStep; dx++) {
      const nx = actor.position.x + dx;
      const ny = actor.position.y + dy;
      if (nx < 0 || ny < 0 || nx >= state.map.width || ny >= state.map.height) {
        continue;
      }
      if (occupied.has(`${nx},${ny}`)) {
        continue;
      }
      const cellTerrain = state.map.cells[ny]?.[nx] ?? "normal";
      const cellElevation = state.map.elevation[ny]?.[nx] ?? 0;
      const moveCost = gridDistance(actor.position, { x: nx, y: ny }) * (cellTerrain === "difficult" ? 1.5 : 1);
      if (moveCost <= maxStep + 0.01) {
        reachable.push({
          x: nx,
          y: ny,
          elevation: cellElevation,
          terrain: cellTerrain
        });
      }
    }
  }
  if (reachable.length === 0) {
    reachable.push({ ...actor.position });
  }
  return reachable;
}
function isFlankingPosition(state, actor, candidatePos, target) {
  if (gridDistance(candidatePos, target.position) > 1.6) return false;
  for (const ally of Object.values(state.combatants)) {
    if (ally.id === actor.id || ally.faction !== actor.faction || !ally.isAlive || ally.hp <= 0) {
      continue;
    }
    if (gridDistance(ally.position, target.position) <= 1.6) {
      const v1x = candidatePos.x - target.position.x;
      const v1y = candidatePos.y - target.position.y;
      const v2x = ally.position.x - target.position.x;
      const v2y = ally.position.y - target.position.y;
      const dot = v1x * v2x + v1y * v2y;
      if (dot < -0.4) {
        return true;
      }
    }
  }
  return false;
}
function scoreCandidateDimensions(state, actor, moveTo, action, primaryTarget, allEnemies, allAllies, battlefieldThreatRatio) {
  let lethalityScore = 0;
  const targetsInAoe = [];
  if (primaryTarget && (action.type === "melee" || action.type === "ranged" || action.type === "spell" || action.type === "debuff")) {
    const rawExpectedDmg = estimateDiceExpectedValue(action.damageFormula);
    const hitProbEstimate = action.saveAbility ? 0.65 : Math.max(
      0.15,
      Math.min(0.95, (21 - (primaryTarget.ac - (action.attackBonus ?? 5))) / 20)
    );
    const flankingBoost = action.type === "melee" && isFlankingPosition(state, actor, moveTo, primaryTarget) ? 1.22 : 1;
    const elevationBoost = (moveTo.elevation ?? 0) > (primaryTarget.position.elevation ?? 0) ? 1.12 : 1;
    const effectiveExpectedDmg = rawExpectedDmg * hitProbEstimate * flankingBoost * elevationBoost;
    const hpRatioDealt = effectiveExpectedDmg / Math.max(1, primaryTarget.hp);
    const killConfirmBonus = hpRatioDealt >= 0.85 ? 1.8 * (1 - Math.exp(-1.5 * hpRatioDealt)) : 0.4 * hpRatioDealt;
    const targetThreatWeight = computeCombatantThreatIndex(primaryTarget) / 10;
    const debuffValue = action.appliesCondition && !primaryTarget.conditions.includes(action.appliesCondition) ? 1.15 * targetThreatWeight : 0;
    lethalityScore = (Math.min(2.5, hpRatioDealt * 1.4) + killConfirmBonus + debuffValue) * (0.75 + 0.25 * targetThreatWeight);
  }
  let triageUrgency = 0;
  if (primaryTarget && (action.type === "heal" || action.type === "buff")) {
    const missingHpRatio = 1 - primaryTarget.hp / Math.max(1, primaryTarget.maxHp);
    const sanRatio = primaryTarget.san / Math.max(1, primaryTarget.maxSan);
    const isDying = primaryTarget.hp === 0 && primaryTarget.isAlive;
    if (action.type === "heal") {
      const expectedHeal = estimateDiceExpectedValue(action.healFormula);
      const healEfficiency = Math.min(
        1.5,
        expectedHeal / Math.max(1, primaryTarget.maxHp - primaryTarget.hp + 1)
      );
      if (isDying) {
        triageUrgency = 4.2 + healEfficiency * 0.9;
      } else if (missingHpRatio > 0.05) {
        triageUrgency = (Math.exp(2.6 * missingHpRatio) - 1) * 0.85 * (0.5 + 0.5 * healEfficiency);
      } else {
        triageUrgency = -1.8;
      }
    } else if (action.type === "buff") {
      const lowSanUrgency = sanRatio < 0.3 ? (0.3 - sanRatio) * 3 : 0;
      const alreadyBuffed = action.appliesCondition && primaryTarget.conditions.includes(action.appliesCondition);
      triageUrgency = alreadyBuffed ? -1.2 : 0.75 + missingHpRatio * 0.8 + lowSanUrgency;
    }
  }
  let aoeClusterEfficiency = 0;
  if (action.aoeRadius && action.aoeRadius > 0 && primaryTarget) {
    const center = primaryTarget.position;
    let enemiesHit = 0;
    let alliesHit = 0;
    let totalClusterThreat = 0;
    for (const enemy of allEnemies) {
      if (gridDistance(center, enemy.position) <= action.aoeRadius + 0.25) {
        enemiesHit++;
        targetsInAoe.push(enemy.id);
        totalClusterThreat += computeCombatantThreatIndex(enemy) / 12;
      }
    }
    for (const ally of allAllies) {
      if (gridDistance(center, ally.position) <= action.aoeRadius + 0.25) {
        alliesHit++;
      }
    }
    aoeClusterEfficiency = enemiesHit * 1.15 + totalClusterThreat * 0.45 - alliesHit * 2.4;
  } else if (primaryTarget) {
    targetsInAoe.push(primaryTarget.id);
  }
  let positionalSafety = 0;
  const terrain = moveTo.terrain ?? state.map.cells[moveTo.y]?.[moveTo.x] ?? "normal";
  const elevation = moveTo.elevation ?? state.map.elevation[moveTo.y]?.[moveTo.x] ?? 0;
  if (terrain === "cover_three_quarters") positionalSafety += 1.35;
  else if (terrain === "cover_half") positionalSafety += 0.85;
  else if (terrain === "hazard") positionalSafety -= 2.2;
  positionalSafety += elevation * 0.45;
  let minEnemyDist = 99;
  for (const enemy of allEnemies) {
    const d = gridDistance(moveTo, enemy.position);
    if (d < minEnemyDist) minEnemyDist = d;
  }
  const selfHpRatio = actor.hp / Math.max(1, actor.maxHp);
  if (actor.role === "arcanist" || actor.role === "healer") {
    const idealDist = 5;
    const distPenalty = minEnemyDist < 2.2 ? -1.6 * (2.2 - minEnemyDist) : -0.18 * Math.abs(minEnemyDist - idealDist);
    positionalSafety += distPenalty * (1.3 - 0.5 * selfHpRatio);
  } else if (actor.role === "vanguard") {
    let screenBonus = 0;
    for (const ally of allAllies) {
      if (ally.role === "arcanist" || ally.role === "healer") {
        const distToBackline = gridDistance(moveTo, ally.position);
        if (minEnemyDist <= 1.8 && distToBackline <= 3.5) {
          screenBonus += 0.95;
        }
      }
    }
    positionalSafety += screenBonus + (minEnemyDist <= 1.6 ? 0.65 : -0.15 * minEnemyDist);
  } else if (actor.role === "rogue") {
    if (primaryTarget && isFlankingPosition(state, actor, moveTo, primaryTarget)) {
      positionalSafety += 1.25;
    }
  }
  if (action.type === "dodge") {
    positionalSafety += (1 - selfHpRatio) * 2.1 + (minEnemyDist <= 1.8 ? 0.9 : -0.6);
  }
  let resourceConservation = 0;
  const spellLevel = action.spellLevel ?? 0;
  if (spellLevel > 0) {
    const slotInfo = actor.stats.spellSlots?.[spellLevel];
    const remainingSlots = slotInfo?.current ?? 0;
    const maxSlots = slotInfo?.max ?? 1;
    const scarcityRatio = 1 - remainingSlots / Math.max(1, maxSlots);
    const targetCountFactor = Math.max(1, targetsInAoe.length);
    const worthiness = battlefieldThreatRatio * 0.75 + targetCountFactor * 0.45 + triageUrgency * 0.35;
    const slotCost = spellLevel * (0.45 + 0.35 * scarcityRatio);
    resourceConservation = worthiness - slotCost;
  } else {
    resourceConservation = 0.35;
  }
  const p = actor.persona;
  const investigateUtility = action.type === "investigate" ? (p.curiosity ?? 0.8) * (allEnemies.length === 0 ? 2.4 : 0.35) : 0;
  const personaAlignment = (lethalityScore * (p.aggression - 1) + triageUrgency * (p.altruism - 1) + aoeClusterEfficiency * (p.tacticalPrecision - 1) + positionalSafety * (p.caution - 1) + resourceConservation * (p.resourceThrift - 1) + investigateUtility) * 0.45;
  return {
    breakdown: {
      lethalityScore: Number(lethalityScore.toFixed(4)),
      triageUrgency: Number(triageUrgency.toFixed(4)),
      aoeClusterEfficiency: Number(aoeClusterEfficiency.toFixed(4)),
      positionalSafety: Number(positionalSafety.toFixed(4)),
      resourceConservation: Number(resourceConservation.toFixed(4)),
      personaAlignment: Number(personaAlignment.toFixed(4))
    },
    targetsInAoe
  };
}
function computeSoftmaxProbabilities(utilities, temperature = 0.65) {
  if (utilities.length === 0) return [];
  const tau = Math.max(0.05, temperature);
  const maxU = Math.max(...utilities);
  const exps = utilities.map((u) => Math.exp((u - maxU) / tau));
  const sumExp = exps.reduce((acc, v) => acc + v, 0);
  return exps.map((e) => e / sumExp);
}
function evaluateTacticalActions(state, actorId, temperature = 0.65, rng = getGlobalRng(), preferredActionId, preferredTargetId) {
  const actor = state.combatants[actorId];
  if (!actor) {
    throw new Error(`Combatant "${actorId}" not found in WorldState.`);
  }
  const allCombatants = Object.values(state.combatants).filter((c) => c.isAlive);
  const allEnemies = allCombatants.filter(
    (c) => c.faction !== actor.faction && c.faction !== "neutral" && c.hp > 0
  );
  const allAllies = allCombatants.filter((c) => c.faction === actor.faction);
  const battlefieldThreatRatio = computeBattlefieldThreatRatio(state, actor);
  const reachableTiles = getReachablePositions(state, actor);
  const candidates = [];
  for (const moveTo of reachableTiles) {
    for (const action of actor.actions) {
      if (action.spellLevel && action.spellLevel > 0) {
        const slot = actor.stats.spellSlots?.[action.spellLevel];
        if (!slot || slot.current <= 0) {
          continue;
        }
      }
      if (action.usesResource && (actor.stats.resources?.[action.usesResource]?.current ?? 0) <= 0) {
        continue;
      }
      let potentialTargets = [];
      if (action.type === "heal" || action.type === "buff") {
        potentialTargets = allAllies.filter(
          (ally) => gridDistance(moveTo, ally.position) <= action.range + 0.35
        );
      } else if (action.type === "dodge" || action.type === "dash" || action.type === "investigate") {
        potentialTargets = [actor];
      } else {
        potentialTargets = allEnemies.filter(
          (enemy) => gridDistance(moveTo, enemy.position) <= action.range + 0.35
        );
      }
      for (const target of potentialTargets) {
        const { breakdown, targetsInAoe } = scoreCandidateDimensions(
          state,
          actor,
          moveTo,
          action,
          target,
          allEnemies,
          allAllies,
          battlefieldThreatRatio
        );
        const p = actor.persona;
        const totalUtility = breakdown.lethalityScore * p.aggression + breakdown.triageUrgency * p.altruism + breakdown.aoeClusterEfficiency * p.tacticalPrecision + breakdown.positionalSafety * p.caution + breakdown.resourceConservation * p.resourceThrift + breakdown.personaAlignment;
        const moveDesc = moveTo.x === actor.position.x && moveTo.y === actor.position.y ? `\u5805\u5B88\u539F\u4F4D (${moveTo.x},${moveTo.y})` : `\u79FB\u52D5\u81F3 (${moveTo.x},${moveTo.y}${moveTo.terrain && moveTo.terrain !== "normal" ? ` [${moveTo.terrain}]` : ""})`;
        const targetDesc = target && target.id !== actor.id ? ` -> \u76EE\u6A19\u3010${target.name}\u3011` : "";
        const aoeDesc = targetsInAoe.length > 1 ? ` (AOE \u6CE2\u53CA ${targetsInAoe.length} \u540D\u76EE\u6A19)` : "";
        candidates.push({
          id: `${actor.id}_${action.id}_${moveTo.x}_${moveTo.y}_${target?.id ?? "self"}`,
          actorId: actor.id,
          action,
          targetId: target?.id,
          targetIdsInAoe: targetsInAoe,
          moveTo,
          targetPosition: target ? { ...target.position } : { ...moveTo },
          description: `${moveDesc}\uFF0C\u65BD\u5C55\u3010${action.name}\u3011${targetDesc}${aoeDesc}`,
          scoreBreakdown: breakdown,
          totalUtility: Number(totalUtility.toFixed(4)),
          probability: 0
        });
      }
    }
  }
  if (candidates.length === 0) {
    const nearestEnemy = allEnemies[0];
    let bestTile = reachableTiles[0];
    if (nearestEnemy) {
      bestTile = [...reachableTiles].sort(
        (a, b2) => gridDistance(a, nearestEnemy.position) - gridDistance(b2, nearestEnemy.position)
      )[0];
    }
    const dashAction = {
      id: "dash_advance",
      name: "\u6230\u8853\u75BE\u8D70\u63A8\u9032 (Dash)",
      type: "dash",
      range: 0
    };
    const { breakdown } = scoreCandidateDimensions(
      state,
      actor,
      bestTile,
      dashAction,
      actor,
      allEnemies,
      allAllies,
      battlefieldThreatRatio
    );
    candidates.push({
      id: `${actor.id}_dash_${bestTile.x}_${bestTile.y}`,
      actorId: actor.id,
      action: dashAction,
      targetId: actor.id,
      moveTo: bestTile,
      targetPosition: bestTile,
      description: `\u75BE\u8D70\u63A8\u9032\u81F3 (${bestTile.x},${bestTile.y}) \u903C\u8FD1\u6575\u65B9\u9663\u7DDA`,
      scoreBreakdown: breakdown,
      totalUtility: Number(
        (breakdown.positionalSafety + breakdown.resourceConservation).toFixed(4)
      ),
      probability: 1
    });
  }
  const utilities = candidates.map((c) => c.totalUtility);
  const probs = computeSoftmaxProbabilities(utilities, temperature);
  for (let i = 0; i < candidates.length; i++) {
    candidates[i].probability = Number(probs[i].toFixed(4));
  }
  const sorted = [...candidates].sort((a, b2) => b2.totalUtility - a.totalUtility);
  const topCandidates = sorted.slice(0, 3);
  const topProbs = computeSoftmaxProbabilities(
    topCandidates.map((c) => c.totalUtility),
    temperature
  );
  const r = rng.nextFloat();
  let cumulative = 0;
  let selectedCandidate = topCandidates[0];
  for (let i = 0; i < topCandidates.length; i++) {
    cumulative += topProbs[i];
    if (r <= cumulative) {
      selectedCandidate = topCandidates[i];
      break;
    }
  }
  if (preferredActionId || preferredTargetId) {
    const pool = candidates.filter(
      (c) => (!preferredActionId || c.id === preferredActionId || c.action.id === preferredActionId) && (!preferredTargetId || c.targetId === preferredTargetId)
    );
    const override = pool.reduce(
      (best, c) => !best || c.totalUtility > best.totalUtility ? c : best,
      void 0
    );
    if (!override) {
      const unique = (ids) => [...new Set(ids)];
      const legalActionIds = unique(candidates.map((c) => c.action.id));
      const legalTargetIds = unique(
        candidates.filter((c) => !preferredActionId || c.action.id === preferredActionId).map((c) => c.targetId).filter((id) => Boolean(id))
      );
      const actionOk = !preferredActionId || legalActionIds.includes(preferredActionId);
      throw new Error(
        (actionOk ? `Target "${preferredTargetId}" is not a legal target for "${actor.name}" (${actor.id})${preferredActionId ? ` with action "${preferredActionId}"` : ""}. ` : `Action "${preferredActionId}" is not a legal candidate for "${actor.name}" (${actor.id}). `) + `Legal action ids: ${legalActionIds.join(", ")}. Legal target ids: ${legalTargetIds.join(", ")}. Re-run ai-decide for current candidates.`
      );
    }
    selectedCandidate = override;
  }
  const b = selectedCandidate.scoreBreakdown;
  const narrativeReasoning = `[\u6230\u8853\u60C5\u52E2\u611F\u77E5 Softmax \u6C7A\u7B56 (\u03C4=${temperature}, \u6230\u5834\u5A01\u8105\u6BD4=${battlefieldThreatRatio.toFixed(2)})] ${actor.name} (${actor.role}) \u8A55\u4F30\u4E86 ${candidates.length} \u7A2E\u5408\u6CD5\u8D70\u4F4D\u8207\u884C\u52D5\u7D44\u5408\uFF0C\u6700\u7D42\u4EE5 ${(selectedCandidate.probability * 100).toFixed(1)}% \u6A5F\u7387\u9078\u64C7\uFF1A\u300C${selectedCandidate.description}\u300D(\u7E3D\u6548\u7528 U=${selectedCandidate.totalUtility.toFixed(2)} | \u65AC\u6BBA=${b.lethalityScore.toFixed(2)}, \u6551\u63F4=${b.triageUrgency.toFixed(2)}, AOE=${b.aoeClusterEfficiency.toFixed(2)}, \u7AD9\u4F4D\u5B89\u5168=${b.positionalSafety.toFixed(2)}, \u8CC7\u6E90\u4FDD\u80B2=${b.resourceConservation.toFixed(2)}, \u6027\u683C\u5951\u5408=${b.personaAlignment.toFixed(2)})\u3002`;
  return {
    actorId: actor.id,
    actorName: actor.name,
    role: actor.role,
    temperature,
    selectedCandidate,
    topCandidates,
    allCandidateCount: candidates.length,
    battlefieldThreatRatio: Number(battlefieldThreatRatio.toFixed(3)),
    narrativeReasoning
  };
}

// src/engine/stateStore.ts
import * as fs from "node:fs";
import * as path from "node:path";

// src/engine/types.ts
var CONDITION_TYPES = [
  "prone",
  "restrained",
  "blessed",
  "frightened",
  "poisoned",
  "stunned",
  "unconscious",
  "dodging",
  "concentrating",
  "major_wound",
  "dying",
  "madness_phobia",
  "madness_mania",
  "madness_hallucination"
];

// src/engine/stateStore.ts
var WORKING_MEMORY_WINDOW = 12;
function recordEpisodicEvent(state, event) {
  const fullEvent = {
    id: `evt_t${state.turn}_${state.episodicLog.length + 1}`,
    turn: state.turn,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    ...event
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
function upsertSemanticFact(state, subject, predicate, value, category = "status") {
  const newFactId = `fact_t${state.turn}_${state.semanticFacts.length + 1}`;
  const supersededFacts = [];
  for (const existing of state.semanticFacts) {
    if (existing.isActive && existing.subject.toLowerCase() === subject.toLowerCase() && existing.predicate.toLowerCase() === predicate.toLowerCase()) {
      existing.isActive = false;
      existing.supersededBy = newFactId;
      supersededFacts.push(existing);
    }
  }
  const newFact = {
    id: newFactId,
    category,
    subject,
    predicate,
    value,
    turnCreated: state.turn,
    isActive: true
  };
  state.semanticFacts.push(newFact);
  return { newFact, supersededFacts };
}
function queryActiveFacts(state, filter) {
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
function createDefaultTacticalMap() {
  const width = 12;
  const height = 10;
  const cells = Array.from(
    { length: height },
    () => Array.from({ length: width }, () => "normal")
  );
  const elevation = Array.from(
    { length: height },
    () => Array.from({ length: width }, () => 0)
  );
  cells[2][4] = "cover_half";
  cells[2][7] = "cover_half";
  cells[4][3] = "cover_three_quarters";
  cells[4][8] = "cover_three_quarters";
  cells[6][5] = "difficult";
  cells[6][6] = "difficult";
  cells[5][5] = "hazard";
  for (let x = 2; x <= 9; x++) {
    elevation[1][x] = 1;
    elevation[8][x] = 1;
  }
  return { width, height, cells, elevation };
}
function createDefaultEncounter(system = "dnd5e", seed = 42) {
  const map = createDefaultTacticalMap();
  const combatants = {
    aria_vanguard: {
      id: "aria_vanguard",
      name: "\u4E9E\u8389\u4E9E\xB7\u8056\u76FE (Aria the Vanguard)",
      faction: "party",
      role: "vanguard",
      position: { x: 4, y: 6, elevation: 0, terrain: "normal" },
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
        skills: { "Fighting (Brawl)": 75, Dodge: 45, SpotHidden: 50 },
        pbtaMods: { str: 2, dex: 0, con: 2, int: 0, wis: 1, cha: 1 },
        xp: 0,
        level: 5,
        armor: 3
      },
      actions: [
        {
          id: "radiant_longsword",
          name: "\u8F1D\u8000\u9577\u528D\u65AC\u64CA (Radiant Longsword)",
          type: "melee",
          range: 1.5,
          attackBonus: 7,
          damageFormula: "1d8+4",
          pbtaMoveName: "Hack and Slash",
          pbtaStat: "str"
        },
        {
          id: "divine_smite_strike",
          name: "\u81F3\u8056\u65AC\u91CD\u64CA (Divine Smite)",
          type: "melee",
          range: 1.5,
          attackBonus: 7,
          damageFormula: "3d8+4",
          spellLevel: 1,
          pbtaMoveName: "Hack and Slash",
          pbtaStat: "str"
        },
        {
          id: "lay_on_hands",
          name: "\u8056\u7642\u8853 (Lay on Hands)",
          type: "heal",
          range: 1.5,
          healFormula: "2d8+4"
        },
        {
          id: "vanguard_dodge",
          name: "\u8209\u76FE\u9632\u79A6\u59FF\u614B (Total Defense)",
          type: "dodge",
          range: 0
        }
      ],
      persona: {
        aggression: 1.25,
        altruism: 1.45,
        caution: 1.1,
        tacticalPrecision: 1,
        resourceThrift: 0.9
      },
      isAlive: true
    },
    kael_rogue: {
      id: "kael_rogue",
      name: "\u51F1\u723E\xB7\u5F71\u5203 (Kael the Shadow Rogue)",
      faction: "party",
      role: "rogue",
      position: { x: 3, y: 4, elevation: 0, terrain: "cover_three_quarters" },
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
        skills: { "Fighting (Brawl)": 65, Dodge: 70, SpotHidden: 75, Locksmith: 80 },
        pbtaMods: { str: 0, dex: 2, con: 1, int: 1, wis: 0, cha: 1 },
        xp: 0,
        level: 5,
        armor: 1
      },
      actions: [
        {
          id: "sneak_attack_blade",
          name: "\u80CC\u523A\u6697\u5F71\u77ED\u528D (Sneak Attack Blade)",
          type: "melee",
          range: 1.5,
          attackBonus: 7,
          damageFormula: "4d6+4",
          pbtaMoveName: "Hack and Slash",
          pbtaStat: "dex"
        },
        {
          id: "hand_crossbow_shot",
          name: "\u7CBE\u6E96\u624B\u5F29\u5C04\u64CA (Hand Crossbow)",
          type: "ranged",
          range: 6,
          attackBonus: 7,
          damageFormula: "3d6+4",
          pbtaMoveName: "Volley",
          pbtaStat: "dex"
        },
        {
          id: "investigate_trap",
          name: "\u6D1E\u5BDF\u6A5F\u95DC\u8207\u5F31\u9EDE (Tactical Survey)",
          type: "investigate",
          range: 4,
          cocSkillName: "SpotHidden"
        }
      ],
      persona: {
        aggression: 1.5,
        altruism: 0.75,
        caution: 1.35,
        tacticalPrecision: 1.65,
        resourceThrift: 1.2,
        curiosity: 1.4
      },
      isAlive: true
    },
    lyra_arcanist: {
      id: "lyra_arcanist",
      name: "\u840A\u83C8\xB7\u661F\u8FB0\u5967\u8853\u5E2B (Lyra the Arcanist)",
      faction: "party",
      role: "arcanist",
      position: { x: 4, y: 8, elevation: 1, terrain: "normal" },
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
          3: { current: 2, max: 2 }
        },
        siz: 50,
        edu: 85,
        pow: 75,
        luck: 50,
        skills: { "Fighting (Brawl)": 35, Dodge: 50, Occult: 85, CthulhuMythos: 22 },
        pbtaMods: { str: -1, dex: 1, con: 1, int: 2, wis: 1, cha: 0 },
        xp: 0,
        level: 5,
        armor: 0
      },
      actions: [
        {
          id: "fireball_3rd",
          name: "\u4E09\u74B0\u706B\u7403\u8853 (Fireball)",
          type: "spell",
          range: 8,
          aoeRadius: 2.5,
          damageFormula: "8d6",
          spellLevel: 3,
          saveAbility: "dex",
          saveDC: 15,
          pbtaMoveName: "Cast a Spell",
          pbtaStat: "int"
        },
        {
          id: "hold_monster_debuff",
          name: "\u4E8C\u74B0\u5B9A\u8EAB\u63A7\u5834\u8853 (Web / Hold)",
          type: "debuff",
          range: 7,
          aoeRadius: 1.5,
          damageFormula: "2d6",
          spellLevel: 2,
          saveAbility: "wis",
          saveDC: 15,
          appliesCondition: "restrained",
          requiresConcentration: true,
          pbtaMoveName: "Cast a Spell",
          pbtaStat: "int"
        },
        {
          id: "fire_bolt_cantrip",
          name: "\u706B\u7130\u7BAD\u6232\u6CD5 (Fire Bolt Cantrip)",
          type: "ranged",
          range: 8,
          attackBonus: 7,
          damageFormula: "2d10",
          spellLevel: 0,
          pbtaMoveName: "Cast a Spell",
          pbtaStat: "int"
        }
      ],
      persona: {
        aggression: 1.35,
        altruism: 0.9,
        caution: 1.6,
        tacticalPrecision: 1.85,
        resourceThrift: 1.35,
        curiosity: 1.7
      },
      isAlive: true
    },
    theron_healer: {
      id: "theron_healer",
      name: "\u745F\u9686\xB7\u9ECE\u660E\u7267\u5E2B (Theron the Dawn Cleric)",
      faction: "party",
      role: "healer",
      position: { x: 6, y: 8, elevation: 1, terrain: "normal" },
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
          3: { current: 2, max: 2 }
        },
        siz: 60,
        edu: 75,
        pow: 80,
        luck: 60,
        skills: { "Fighting (Brawl)": 50, Dodge: 45, FirstAid: 80, Psychology: 75 },
        pbtaMods: { str: 1, dex: 0, con: 1, int: 0, wis: 2, cha: 1 },
        xp: 0,
        level: 5,
        armor: 2
      },
      actions: [
        {
          id: "cure_wounds_2nd",
          name: "\u4E8C\u74B0\u7642\u50B7\u8853 (Cure Wounds II)",
          type: "heal",
          range: 5,
          healFormula: "2d8+4",
          spellLevel: 2
        },
        {
          id: "healing_word_1st",
          name: "\u4E00\u74B0\u6CBB\u7652\u771F\u8A00 (Healing Word)",
          type: "heal",
          range: 7,
          healFormula: "1d4+4",
          spellLevel: 1
        },
        {
          id: "bless_party",
          name: "\u4E00\u74B0\u795D\u798F\u8853 (Bless)",
          type: "buff",
          range: 6,
          spellLevel: 1,
          appliesCondition: "blessed",
          requiresConcentration: true
        },
        {
          id: "guiding_bolt_1st",
          name: "\u4E00\u74B0\u5C0E\u5F15\u7BAD (Guiding Bolt)",
          type: "ranged",
          range: 8,
          attackBonus: 7,
          damageFormula: "4d6",
          spellLevel: 1
        },
        {
          id: "sacred_flame_cantrip",
          name: "\u795E\u8056\u706B\u7130\u6232\u6CD5 (Sacred Flame)",
          type: "spell",
          range: 7,
          damageFormula: "2d8",
          spellLevel: 0,
          saveAbility: "dex",
          saveDC: 15
        }
      ],
      persona: {
        aggression: 0.85,
        altruism: 1.9,
        caution: 1.45,
        tacticalPrecision: 1.2,
        resourceThrift: 1.25
      },
      isAlive: true
    },
    cult_archon_boss: {
      id: "cult_archon_boss",
      name: "\u6DF1\u6DF5\u796D\u53F8\xB7\u746A\u62C9\u51F1 (Malakor the Abyssal Archon)",
      faction: "enemy",
      role: "monster",
      position: { x: 5, y: 2, elevation: 1, terrain: "cover_half" },
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
        skills: { "Fighting (Brawl)": 70, Dodge: 50 }
      },
      actions: [
        {
          id: "void_blast_aoe",
          name: "\u6DF1\u6DF5\u6B7B\u9748\u885D\u64CA\u6CE2 (Abyssal Pulse)",
          type: "spell",
          range: 7,
          aoeRadius: 2,
          damageFormula: "4d6+3",
          spellLevel: 2,
          saveAbility: "con",
          saveDC: 14
        },
        {
          id: "accursed_glaive",
          name: "\u8A5B\u5492\u9577\u67C4\u5200\u91CD\u5288 (Accursed Glaive)",
          type: "melee",
          range: 2,
          attackBonus: 6,
          damageFormula: "2d10+3"
        },
        {
          id: "eldritch_spear",
          name: "\u9B54\u80FD\u7A7F\u523A\u69CD (Eldritch Spear)",
          type: "ranged",
          range: 8,
          attackBonus: 6,
          damageFormula: "2d8+3"
        }
      ],
      persona: {
        aggression: 1.65,
        altruism: 0.4,
        caution: 1,
        tacticalPrecision: 1.4,
        resourceThrift: 0.8
      },
      isAlive: true
    },
    ghoul_stalker_1: {
      id: "ghoul_stalker_1",
      name: "\u5893\u7A74\u98DF\u5C4D\u9B3C\u7375\u624B A (Crypt Ghoul Alpha)",
      faction: "enemy",
      role: "monster",
      position: { x: 4, y: 3, elevation: 0, terrain: "normal" },
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
        skills: { "Fighting (Brawl)": 55, Dodge: 40 }
      },
      actions: [
        {
          id: "paralyzing_claws",
          name: "\u9EBB\u75FA\u8150\u722A\u6495\u88C2 (Paralyzing Claws)",
          type: "melee",
          range: 1.5,
          attackBonus: 5,
          damageFormula: "2d4+2",
          appliesCondition: "poisoned"
        }
      ],
      persona: {
        aggression: 1.8,
        altruism: 0.2,
        caution: 0.5,
        tacticalPrecision: 0.9,
        resourceThrift: 1
      },
      isAlive: true
    },
    ghoul_stalker_2: {
      id: "ghoul_stalker_2",
      name: "\u5893\u7A74\u98DF\u5C4D\u9B3C\u7375\u624B B (Crypt Ghoul Beta)",
      faction: "enemy",
      role: "monster",
      position: { x: 6, y: 3, elevation: 0, terrain: "normal" },
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
        skills: { "Fighting (Brawl)": 55, Dodge: 40 }
      },
      actions: [
        {
          id: "paralyzing_claws",
          name: "\u9EBB\u75FA\u8150\u722A\u6495\u88C2 (Paralyzing Claws)",
          type: "melee",
          range: 1.5,
          attackBonus: 5,
          damageFormula: "2d4+2",
          appliesCondition: "poisoned"
        }
      ],
      persona: {
        aggression: 1.8,
        altruism: 0.2,
        caution: 0.5,
        tacticalPrecision: 0.9,
        resourceThrift: 1
      },
      isAlive: true
    }
  };
  const initiativeOrder = Object.values(combatants).sort((a, b) => b.initiative - a.initiative).map((c) => c.id);
  const state = {
    campaignName: system === "coc7e" ? "\u963F\u5361\u59C6\u5730\u5E95\u661F\u4E4B\u6559\u5802 (The Starry Crypt beneath Arkham)" : system === "pbta" ? "\u5730\u57CE\u4E16\u754C\uFF1A\u9ED1\u66DC\u88C2\u9699\u8056\u6BBF (Obsidian Rift Sanctum)" : "\u88AB\u907A\u5FD8\u7684\u570B\u5EA6\uFF1A\u6DF1\u6DF5\u8840\u6708\u5730\u7A96 (Crypt of the Blood Moon)",
    ruleSystem: system,
    turn: 1,
    round: 1,
    activeActorIndex: 0,
    initiativeOrder,
    sceneName: "\u53E4\u8001\u5730\u4E0B\u796D\u58C7\u5927\u5EF3 (Ancient Subterranean Altar Hall)",
    sceneDescription: "\u6F6E\u6FD5\u7684\u77F3\u67F1\u63D0\u4F9B\u534A\u63A9\u9AD4\u8207\u56DB\u5206\u4E4B\u4E09\u63A9\u9AD4\uFF0C\u5357\u5317\u5169\u5074\u8A2D\u6709\u9AD8\u5730\u77F3\u968E (+1 Elevation)\uFF0C\u4E2D\u592E\u796D\u58C7\u6B63\u6563\u767C\u8457\u4E0D\u7965\u7684\u6DF1\u6DF5\u80FD\u91CF\u3002",
    dangerLevel: 3,
    rngSeed: seed,
    map,
    combatants,
    workingMemory: [],
    episodicLog: [],
    semanticFacts: []
  };
  upsertSemanticFact(state, "Crypt_Altar", "state", "corrupted_active", "location");
  upsertSemanticFact(state, "Tavern_Door", "state", "locked", "location");
  upsertSemanticFact(state, "cult_archon_boss", "status", "alive_commanding", "npc");
  upsertSemanticFact(state, "ghoul_stalker_1", "status", "alive", "npc");
  upsertSemanticFact(state, "ghoul_stalker_2", "status", "alive", "npc");
  recordEpisodicEvent(state, {
    actorId: "system_dm",
    actorName: "Dungeon Master",
    actionType: "scene_init",
    narrativeSummary: `\u6230\u5F79\u3010${state.campaignName}\u3011(${system.toUpperCase()}) \u906D\u9047\u6230\u958B\u59CB\uFF01\u5148\u653B\u9806\u5E8F\uFF1A${initiativeOrder.join(" -> ")}\u3002`
  });
  return state;
}
function stepCombatTurn(state, overrideActorId, temperature = 0.65, preferredActionId, preferredTargetId) {
  const rng = new DeterministicRNG(state.rngSeed + state.turn * 101);
  state.rngSeed = rng.getSeed();
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
    throw new Error("No living combatants available to take a turn.");
  }
  const actor = state.combatants[actorId];
  fireVillainActions(state, actor.id);
  if (actor.hp === 0 && actor.isAlive && state.ruleSystem === "dnd5e") {
    const ds = resolveDnD5eDeathSave(actor, rng);
    return finishDownedTurn(state, actor, ds.narrative, temperature, preferredActionId, ds.roll);
  }
  if (actor.hp === 0 && actor.isAlive && state.ruleSystem === "coc7e") {
    const dying = actor.conditions.includes("dying");
    let narrative = `${actor.name} \u660F\u8FF7\u4E0D\u9192\uFF0C\u7121\u6CD5\u884C\u52D5\u3002`;
    if (dying) {
      const check = resolveCoC7eDeathCheck(actor, rng);
      narrative = check.narrative;
      if (check.isDead) upsertSemanticFact(state, actor.id, "status", "dead", "npc");
    }
    return finishDownedTurn(state, actor, narrative, temperature, preferredActionId);
  }
  const decisionReport = evaluateTacticalActions(state, actor.id, temperature, rng, preferredActionId, preferredTargetId);
  const chosen = decisionReport.selectedCandidate;
  const action = chosen.action;
  actor.position = { ...chosen.moveTo };
  if (action.spellLevel && action.spellLevel > 0) {
    const slot = actor.stats.spellSlots?.[action.spellLevel];
    if (slot && slot.current > 0) {
      slot.current -= 1;
    }
  }
  if (action.usesResource) {
    const resource = actor.stats.resources?.[action.usesResource];
    if (resource) resource.current -= 1;
  }
  const target = chosen.targetId ? state.combatants[chosen.targetId] : void 0;
  let resolutionNarrative = "";
  if (action.type === "heal" && target && state.ruleSystem === "coc7e" && action.attackBonus !== void 0) {
    const check = resolveCoC7eCheck({ skill: action.attackBonus, rng });
    if (check.levelRank < COC_LEVEL_RANK.Regular) {
      resolutionNarrative = `${actor.name} \u5C0D ${target.name} \u65BD\u884C\u3010${action.name}\u3011[${check.roll.total}/${check.level}] \u5931\u6557\uFF0C\u6C92\u80FD\u7A69\u5B9A\u50B7\u52E2\u3002`;
    } else {
      const prevHp = target.hp;
      target.hp = Math.min(target.maxHp, target.hp + Math.max(1, rollDice(action.healFormula ?? "1", rng).total));
      if (prevHp === 0) clearDowned(target);
      resolutionNarrative = `${actor.name} \u5C0D ${target.name} \u65BD\u884C\u3010${action.name}\u3011[${check.roll.total}/${check.level}] \u6210\u529F\uFF0C\u50B7\u52E2\u7A69\u5B9A (${prevHp} -> ${target.hp}/${target.maxHp})\u3002`;
    }
  } else if (action.type === "heal" && target) {
    const healRoll = rollDice(action.healFormula ?? "1d8+3", rng);
    const prevHp = target.hp;
    target.hp = Math.min(target.maxHp, target.hp + Math.max(1, healRoll.total));
    if (prevHp === 0 && target.hp > 0) clearDowned(target);
    resolutionNarrative = `${actor.name} \u5C0D ${target.name} \u65BD\u5C55\u3010${action.name}\u3011\u6062\u5FA9 ${target.hp - prevHp} \u9EDE HP (${prevHp} -> ${target.hp}/${target.maxHp})\u3002`;
  } else if (action.type === "buff" && target) {
    if (action.appliesCondition && !target.conditions.includes(action.appliesCondition)) {
      target.conditions.push(action.appliesCondition);
    }
    if (action.requiresConcentration) {
      actor.concentratingOn = action.name;
      if (!actor.conditions.includes("concentrating")) {
        actor.conditions.push("concentrating");
      }
    }
    resolutionNarrative = `${actor.name} \u5C0D ${target.name} \u65BD\u5C55\u589E\u76CA\u3010${action.name}\u3011\uFF0C\u9644\u52A0\u72C0\u614B\u3010${action.appliesCondition ?? "blessed"}\u3011\u3002`;
  } else if (action.type === "dodge") {
    if (!actor.conditions.includes("dodging")) {
      actor.conditions.push("dodging");
    }
    resolutionNarrative = `${actor.name} \u63A1\u53D6\u3010${action.name}\u3011\u9632\u79A6\u59FF\u614B\uFF0C\u76F4\u5230\u4E0B\u56DE\u5408\u958B\u59CB\u524D\u6575\u65B9\u5C0D\u5176\u653B\u64CA\u627F\u53D7\u52A3\u52E2\u3002`;
  } else if (action.type === "dash" || action.type === "investigate") {
    resolutionNarrative = `${actor.name} \u57F7\u884C\u3010${action.name}\u3011(${chosen.description})\u3002`;
  } else if (state.ruleSystem === "dnd5e") {
    if (action.aoeRadius && action.aoeRadius > 0 && chosen.targetIdsInAoe && chosen.targetIdsInAoe.length > 0) {
      const subLogs = [];
      for (const tid of chosen.targetIdsInAoe) {
        const aoeTarget = state.combatants[tid];
        if (!aoeTarget || !aoeTarget.isAlive) continue;
        const saveRes = resolveDnD5eSavingThrow(actor, aoeTarget, action, true, rng);
        subLogs.push(saveRes.narrative);
        if (!aoeTarget.isAlive) {
          upsertSemanticFact(state, aoeTarget.id, "status", "dead", "npc");
        }
      }
      resolutionNarrative = `${actor.name} \u65BD\u653E\u7BC4\u570D\u6CD5\u8853\u3010${action.name}\u3011\uFF1A${subLogs.join(" | ")}`;
    } else if (action.saveAbility && target) {
      const saveRes = resolveDnD5eSavingThrow(actor, target, action, true, rng);
      resolutionNarrative = saveRes.narrative;
      if (!target.isAlive) {
        upsertSemanticFact(state, target.id, "status", "dead", "npc");
      }
    } else if (target) {
      const flanking = isFlankingPosition(state, actor, actor.position, target);
      const atkRes = resolveDnD5eAttack({
        attacker: actor,
        defender: target,
        action,
        isFlanking: flanking,
        rng
      });
      resolutionNarrative = atkRes.narrative;
      if (!target.isAlive) {
        upsertSemanticFact(state, target.id, "status", "dead", "npc");
      }
    }
  } else if (state.ruleSystem === "coc7e" && target) {
    const cocCombat = resolveCoC7eOpposedCombat(
      actor,
      target,
      "dodge",
      action.damageFormula ?? "1d6+1",
      true,
      rng
    );
    let sanNarrative = "";
    if (actor.faction === "enemy" && target.faction === "party") {
      const sanRes = resolveCoC7eSanity(target.san, "1/1d6", target.stats.int ? target.stats.int * 5 : 65, target, rng);
      sanNarrative = ` | ${sanRes.narrative}`;
    }
    resolutionNarrative = `${cocCombat.narrative}${sanNarrative}`;
    if (!target.isAlive) {
      upsertSemanticFact(state, target.id, "status", "dead", "npc");
    }
  } else if (state.ruleSystem === "pbta") {
    const statKey = action.pbtaStat ?? "str";
    const statMod = actor.stats.pbtaMods?.[statKey] ?? 1;
    const pbtaRes = resolvePbtAMove(
      actor,
      action.pbtaMoveName ?? action.name,
      statMod,
      state.dangerLevel,
      target,
      action.damageFormula ?? "1d8+2",
      rng
    );
    resolutionNarrative = pbtaRes.narrative;
    if (target && !target.isAlive) {
      upsertSemanticFact(state, target.id, "status", "dead", "npc");
    }
  }
  const fullSummary = `${decisionReport.narrativeReasoning} => \u88C1\u6C7A\u7D50\u679C\uFF1A${resolutionNarrative}`;
  const eventRecorded = recordEpisodicEvent(state, {
    actorId: actor.id,
    actorName: actor.name,
    actionType: action.type,
    targetId: target?.id,
    narrativeSummary: fullSummary
  });
  advanceTurnCounters(state);
  return {
    actorId: actor.id,
    actorName: actor.name,
    decisionReport,
    resolutionNarrative,
    eventRecorded
  };
}
function applyDelta(current, spec, min, max, label) {
  const m = /^([+\-=]?)(\d+)$/.exec(spec.trim());
  if (!m) throw new Error(`Invalid ${label} value "${spec}". Use +N, -N, =N or N.`);
  const n = Number(m[2]);
  const next = m[1] === "+" ? current + n : m[1] === "-" ? current - n : n;
  return Math.min(max, Math.max(min, next));
}
function adjustCombatant(state, actorId, opts) {
  const c = state.combatants[actorId];
  if (!c) {
    throw new Error(`Unknown combatant "${actorId}". Valid ids: ${Object.keys(state.combatants).join(", ")}`);
  }
  if (!c.isAlive) throw new Error(`${c.name} (${c.id}) is dead and cannot be adjusted.`);
  const log = [];
  const known = CONDITION_TYPES;
  for (const cond of [...opts.addConditions ?? [], ...opts.removeConditions ?? []]) {
    if (!known.includes(cond)) {
      throw new Error(`Unknown condition "${cond}". Valid conditions: ${known.join(", ")}`);
    }
  }
  if (opts.hp !== void 0) {
    const prev = c.hp;
    c.hp = applyDelta(c.hp, opts.hp, 0, c.maxHp, "hp");
    if (prev === 0 && c.hp > 0) clearDowned(c);
    log.push(`HP ${prev} -> ${c.hp}/${c.maxHp}`);
  }
  if (opts.tempHp !== void 0) {
    c.tempHp = Math.max(0, Math.floor(opts.tempHp));
    log.push(`\u81E8\u6642 HP -> ${c.tempHp}`);
  }
  if (opts.san !== void 0) {
    const prev = c.san;
    c.san = applyDelta(c.san, opts.san, 0, c.maxSan, "san");
    log.push(`SAN ${prev} -> ${c.san}/${c.maxSan}`);
  }
  if (opts.luck !== void 0) {
    c.stats.luck = Math.max(0, Math.floor(opts.luck));
    log.push(`\u5E78\u904B -> ${c.stats.luck}`);
  }
  for (const cond of opts.addConditions ?? []) {
    if (!c.conditions.includes(cond)) c.conditions.push(cond);
    log.push(`+\u72C0\u614B ${cond}`);
  }
  for (const cond of opts.removeConditions ?? []) {
    c.conditions = c.conditions.filter((x) => x !== cond);
    log.push(`-\u72C0\u614B ${cond}`);
  }
  recordEpisodicEvent(state, {
    actorId: c.id,
    actorName: c.name,
    actionType: "adjust",
    narrativeSummary: `\u3010\u624B\u52D5\u8ABF\u6574\u3011${c.name}\uFF1A${log.join("\uFF1B")}`
  });
  return log;
}
function finishDownedTurn(state, actor, narrative, temperature, preferredActionId, diceRoll) {
  const decisionReport = evaluateTacticalActions(state, actor.id, temperature, void 0, preferredActionId);
  const evt = recordEpisodicEvent(state, {
    actorId: actor.id,
    actorName: actor.name,
    actionType: "death_save",
    diceRoll,
    narrativeSummary: narrative
  });
  advanceTurnCounters(state);
  return {
    actorId: actor.id,
    actorName: actor.name,
    decisionReport,
    resolutionNarrative: narrative,
    eventRecorded: evt
  };
}
function fireVillainActions(state, actorId) {
  for (const va of state.villainActions ?? []) {
    if (va.fired || va.ownerId !== actorId || state.round < va.round) continue;
    va.fired = true;
    const arrivals = [];
    for (const id of va.summons ?? []) {
      const unit = state.reserve?.[id];
      if (!unit) continue;
      state.combatants[id] = unit;
      delete state.reserve[id];
      state.initiativeOrder.push(id);
      arrivals.push(unit.name);
    }
    const owner = state.combatants[actorId];
    recordEpisodicEvent(state, {
      actorId,
      actorName: owner?.name ?? actorId,
      actionType: "villain_action",
      narrativeSummary: `\u3010Boss \u5C08\u5C6C\u884C\u52D5\uFF1A${va.name}\u3011${va.effect}${arrivals.length ? ` \u767B\u5834\uFF1A${arrivals.join("\u3001")}\u3002` : ""}`
    });
  }
}
function advanceTurnCounters(state) {
  state.turn += 1;
  state.activeActorIndex = (state.activeActorIndex + 1) % state.initiativeOrder.length;
  if (state.activeActorIndex === 0) {
    state.round += 1;
  }
}
function saveWorldState(filePath, state) {
  const abs = path.resolve(filePath);
  const dir = path.dirname(abs);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(abs, JSON.stringify(state, null, 2), "utf-8");
}
function loadWorldState(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`WorldState file not found at "${abs}"`);
  }
  const raw = fs.readFileSync(abs, "utf-8");
  return JSON.parse(raw);
}

// src/engine/campaignImport.ts
import * as fs2 from "node:fs";
import * as path2 from "node:path";
var PERSONA_BY_ROLE = {
  vanguard: { aggression: 1, altruism: 0.9, caution: 1.2, tacticalPrecision: 0.8, resourceThrift: 0.6 },
  rogue: { aggression: 1.3, altruism: 0.4, caution: 1.1, tacticalPrecision: 1.2, resourceThrift: 0.7 },
  arcanist: { aggression: 1.1, altruism: 0.5, caution: 1.3, tacticalPrecision: 1.4, resourceThrift: 1.2 },
  healer: { aggression: 0.6, altruism: 1.6, caution: 1, tacticalPrecision: 0.9, resourceThrift: 0.8 },
  monster: { aggression: 1.4, altruism: 0.2, caution: 0.8, tacticalPrecision: 0.9, resourceThrift: 0.4 }
};
function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "action";
}
function rangeToTiles(rangeStr) {
  if (!rangeStr) return 1;
  const match = rangeStr.match(/(\d+)\s*(?:\/\s*(\d+))?\s*(ft|yds|yd)/i);
  if (!match) return 1;
  const unit = match[3].toLowerCase().startsWith("yd") ? 3 : 5;
  const longest = Number(match[2] ?? match[1]);
  return Math.max(1, Math.round(longest / unit));
}
function inferRole(...hintTexts) {
  const hints = hintTexts.filter(Boolean).join(" ").toLowerCase();
  if (/(vanguard|paladin|fighter|barbarian|monk|戰士|聖武士|前衛|警探|憲兵)/.test(hints)) return "vanguard";
  if (/(rogue|ranger|bard|thief|scout|盜賊|斥候|遊蕩|偵探|走私)/.test(hints)) return "rogue";
  if (/(arcanist|wizard|sorcerer|warlock|法師|奧術|教授|學者|神秘)/.test(hints)) return "arcanist";
  if (/(healer|cleric|druid|牧師|醫師|治療|精神)/.test(hints)) return "healer";
  return "vanguard";
}
function terrainFromFeature(type, cover) {
  const text = `${type ?? ""} ${cover ?? ""}`.toLowerCase();
  if (/(three|3\/4|3４|pillar|column|statue|altar|wall)/.test(text)) return "cover_three_quarters";
  if (/(half|crate|barrel|low)/.test(text)) return "cover_half";
  if (/(difficult|rubble|water|web|debris|瓦礫|水)/.test(text)) return "difficult";
  if (/(hazard|fire|trap|spike|miasma|邪氣|陷阱)/.test(text)) return "hazard";
  return "normal";
}
function buildMapFromArea(area) {
  if (!area?.gridSize?.width || !area?.gridSize?.height) {
    return createDefaultTacticalMap();
  }
  const width = area.gridSize.width;
  const height = area.gridSize.height;
  const cells = Array.from(
    { length: height },
    () => Array.from({ length: width }, () => "normal")
  );
  const elevation = Array.from(
    { length: height },
    () => Array.from({ length: width }, () => 0)
  );
  for (const feature of area.terrainFeatures ?? []) {
    const terrain = terrainFromFeature(feature.type, feature.cover);
    if (terrain === "normal") continue;
    for (const coord of feature.coords ?? []) {
      if (coord.y >= 0 && coord.y < height && coord.x >= 0 && coord.x < width) {
        cells[coord.y][coord.x] = terrain;
      }
    }
  }
  for (const hazard of area.trapsAndHazards ?? []) {
    for (const coord of [hazard.coord, hazard.location, ...hazard.coords ?? []]) {
      if (coord && coord.y >= 0 && coord.y < height && coord.x >= 0 && coord.x < width) {
        cells[coord.y][coord.x] = "hazard";
      }
    }
  }
  return { width, height, cells, elevation };
}
function dndAttackToAction(attack) {
  const tiles = rangeToTiles(attack.range);
  return {
    id: slugify(attack.name ?? "attack"),
    name: attack.name ?? "Attack",
    type: tiles > 1 ? "ranged" : "melee",
    range: tiles,
    attackBonus: attack.bonus,
    damageFormula: attack.damage,
    damageType: attack.damageType?.toLowerCase()
  };
}
function cocAttackToAction(attack) {
  const skillName = typeof attack.skill === "string" ? attack.skill : void 0;
  const percentage = attack.percentage ?? (typeof attack.skill === "number" ? attack.skill : void 0);
  return {
    id: slugify(attack.name ?? "weapon"),
    name: attack.name ?? "Weapon",
    type: rangeToTiles(attack.range) > 1 ? "ranged" : "melee",
    range: Math.max(1, rangeToTiles(attack.range)),
    attackBonus: percentage,
    damageFormula: attack.damage,
    cocSkillName: skillName
  };
}
function clampCoord(value, max) {
  return Math.min(Math.max(0, Math.round(value)), max - 1);
}
function baseCombatant(partial) {
  return {
    position: { x: 1, y: 1 },
    hp: 10,
    maxHp: 10,
    san: 0,
    maxSan: 0,
    ac: 10,
    speed: 5,
    initiative: 10,
    conditions: [],
    stats: {},
    actions: [],
    persona: PERSONA_BY_ROLE[partial.role],
    isAlive: true,
    ...partial
  };
}
var COC_HEAL_SKILLS = [
  { regex: /first aid|急救/i, id: "first_aid" },
  { regex: /medicine|醫學/i, id: "medicine" }
];
function campaignBookToWorldState(book, seed = 42, sceneOverride) {
  const system = (book.system ?? "dnd5e").toLowerCase();
  if (!["dnd5e", "coc7e", "pbta"].includes(system)) {
    throw new Error(`Unsupported campaign system "${book.system}" (expected dnd5e | coc7e | pbta).`);
  }
  const areas = book.dungeonAreas ?? book.investigationScenes ?? [];
  const sceneId = sceneOverride ?? book.sessionState?.sceneId;
  const matched = areas.find((a) => a.sceneId === sceneId || a.areaId === sceneId);
  if (sceneOverride && !matched) {
    const valid = areas.map((a) => a.sceneId ?? a.areaId).join(", ");
    throw new Error(`Unknown scene "${sceneOverride}". Valid scene ids: ${valid}`);
  }
  const area = matched ?? areas[0];
  const map = buildMapFromArea(area);
  const combatants = {};
  const party = book.party.map((member, idx) => {
    const role = inferRole(member.id, member.class, member.occupation, member.controlledBy === "human" ? "fighter" : void 0);
    if (system === "coc7e") {
      const derived = member.derivedStats ?? {};
      const skills = { ...member.skills ?? {} };
      const actions2 = (member.weapons ?? []).map(cocAttackToAction);
      for (const action of actions2) {
        if (action.cocSkillName && action.attackBonus !== void 0) {
          skills[action.cocSkillName] = action.attackBonus;
        }
      }
      for (const [skillName, percentage] of Object.entries(member.skills ?? {})) {
        const kind = COC_HEAL_SKILLS.find((h) => h.regex.test(skillName))?.id;
        if (kind && !actions2.some((a) => a.id === kind)) {
          actions2.push({
            id: kind,
            name: skillName,
            type: "heal",
            range: 1,
            healFormula: "1",
            cocSkillName: skillName,
            attackBonus: percentage
          });
        }
      }
      return baseCombatant({
        id: member.id,
        name: member.name,
        faction: "party",
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
          skills
        },
        actions: actions2
      });
    }
    const abilities = member.abilities ?? {};
    const actions = (member.attacks ?? []).map(dndAttackToAction);
    const resources = {};
    for (const [resourceName, resource] of Object.entries(member.resources ?? {})) {
      const max = resource?.max ?? resource?.current;
      if (max !== void 0) resources[resourceName] = { current: resource.current ?? max, max };
      if (resource && (resource.current ?? 0) > 0 && /heal|治療/i.test(resource.effect ?? "")) {
        const healMatch = (resource.effect ?? "").match(/(\d+d\d+(?:\s*[+-]\s*\d+)?)/i);
        actions.push({
          id: slugify(resourceName),
          name: resourceName,
          type: "heal",
          range: 0,
          healFormula: healMatch?.[1] ?? "1d8+2",
          usesResource: resourceName
        });
      }
    }
    const castingScore = member.spellcasting?.ability ? abilities[member.spellcasting.ability]?.score : void 0;
    const castingMod = castingScore !== void 0 ? getAbilityModifier(castingScore) : 0;
    const modSuffix = castingMod >= 0 ? `+${castingMod}` : `${castingMod}`;
    const healSpells = {
      "cure wounds": { id: "cure_wounds", name: "\u7642\u50B7\u8853 (Cure Wounds)", range: 1, dice: "1d8" },
      "healing word": { id: "healing_word", name: "\u6CBB\u7652\u771F\u8A00 (Healing Word)", range: 12, dice: "1d4" }
    };
    for (const spell of member.spellcasting?.preparedSpells ?? []) {
      const def = healSpells[spell.toLowerCase()];
      if (def && !actions.some((a) => a.id === def.id)) {
        actions.push({
          id: def.id,
          name: def.name,
          type: "heal",
          range: def.range,
          healFormula: `${def.dice}${modSuffix}`,
          spellLevel: 1
        });
      }
    }
    const spellSlots = {};
    for (const [level, slot] of Object.entries(member.spellcasting?.slots ?? {})) {
      const max = slot.max ?? slot.current ?? 0;
      spellSlots[Number(level)] = { current: slot.current ?? max, max };
    }
    return baseCombatant({
      id: member.id,
      name: member.name,
      faction: "party",
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
        spellSlots: Object.keys(spellSlots).length > 0 ? spellSlots : void 0,
        resources: Object.keys(resources).length > 0 ? resources : void 0
      },
      actions
    });
  });
  for (const member of party) {
    combatants[member.id] = member;
  }
  (area?.encounters ?? []).forEach((encounter, idx) => {
    const id = encounter.entityId ?? slugify(encounter.name);
    const actions = (encounter.attacks ?? []).map(
      (attack) => system === "coc7e" || attack.skill !== void 0 || attack.bonus === void 0 ? cocAttackToAction(attack) : dndAttackToAction(attack)
    );
    const skills = {};
    for (const action of actions) {
      if (action.cocSkillName && action.attackBonus !== void 0) {
        skills[action.cocSkillName] = action.attackBonus;
      }
    }
    const spawn = encounter.position ?? { x: map.width - 2, y: clampCoord(2 + idx, map.height) };
    combatants[id] = baseCombatant({
      id,
      name: encounter.name,
      faction: "enemy",
      role: "monster",
      position: { x: clampCoord(spawn.x, map.width), y: clampCoord(spawn.y, map.height) },
      hp: encounter.hp?.current ?? 10,
      maxHp: encounter.hp?.max ?? 10,
      san: 0,
      maxSan: 0,
      ac: encounter.ac ?? encounter.armor ?? 12,
      speed: encounter.speed ? Math.max(2, Math.round(encounter.speed / 5)) : Math.max(2, Math.round((encounter.mov ?? 8) / 2)),
      initiative: encounter.dex ? Math.round(encounter.dex / 20) : 2,
      stats: {
        dex: encounter.dex,
        skills: Object.keys(skills).length > 0 ? skills : void 0,
        resistances: encounter.resistances?.map((t) => t.toLowerCase()),
        immunities: encounter.immunities?.map((t) => t.toLowerCase()),
        vulnerabilities: encounter.vulnerabilities?.map((t) => t.toLowerCase())
      },
      actions
    });
  });
  const villainActions = [];
  const reserve = {};
  for (const encounter of area?.encounters ?? []) {
    const ownerId = encounter.entityId ?? slugify(encounter.name);
    for (const va of encounter.villainActions ?? []) {
      const effect = va.effect ?? "";
      const summons = [];
      if (/召喚|summon/i.test(effect)) {
        for (const m of effect.matchAll(/x:\s*(\d+)\s*,\s*y:\s*(\d+)/gi)) {
          const [x, y] = [Number(m[1]), Number(m[2])];
          const unit = Object.values(combatants).find(
            (c) => c.faction === "enemy" && c.id !== ownerId && c.position.x === x && c.position.y === y
          );
          if (unit && !summons.includes(unit.id)) summons.push(unit.id);
        }
      }
      for (const id of summons) {
        reserve[id] = combatants[id];
        delete combatants[id];
      }
      villainActions.push({ ownerId, round: va.round ?? 1, name: va.name ?? "Villain action", effect, summons });
    }
  }
  const initiativeOrder = Object.values(combatants).sort((a, b) => b.initiative - a.initiative || (a.faction === "party" ? -1 : 1)).map((c) => c.id);
  const state = {
    campaignName: book.title,
    ruleSystem: system,
    turn: 1,
    round: book.sessionState?.round && book.sessionState.round > 0 ? book.sessionState.round : 1,
    activeActorIndex: 0,
    initiativeOrder,
    sceneName: area?.name ?? book.title,
    sceneDescription: area?.ambientDescription ?? book.synopsis ?? "",
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
    villainActions: villainActions.length > 0 ? villainActions : void 0,
    reserve: Object.keys(reserve).length > 0 ? reserve : void 0
  };
  for (const [flag, value] of Object.entries(book.sessionState?.questFlags ?? {})) {
    upsertSemanticFact(state, flag, "questFlag", String(value), "quest");
  }
  for (const encounter of area?.encounters ?? []) {
    if (encounter.entityId && (encounter.status ?? "active") === "active") {
      upsertSemanticFact(state, encounter.entityId, "status", "active", "npc");
    }
  }
  recordEpisodicEvent(state, {
    actorId: "system_dm",
    actorName: "Dungeon Master",
    actionType: "scene_init",
    narrativeSummary: `\u6230\u5F79\u3010${book.title}\u3011(${system.toUpperCase()}) \u5DF2\u5F9E\u7BC4\u4F8B\u5287\u672C\u532F\u5165\uFF01\u5148\u653B\u9806\u5E8F\uFF1A${initiativeOrder.join(" -> ")}\u3002`
  });
  return state;
}
function importWorldState(filePath, seed = 42, sceneOverride) {
  const abs = path2.resolve(filePath);
  const raw = JSON.parse(fs2.readFileSync(abs, "utf-8"));
  if (raw && typeof raw === "object" && "combatants" in raw && "initiativeOrder" in raw && "ruleSystem" in raw) {
    return raw;
  }
  return campaignBookToWorldState(raw, seed, sceneOverride);
}

// scripts/trpg-cli.ts
var DEFAULT_STATE_PATH = "./campaign-state.json";
var EXAMPLE_ALIASES = {
  "crimson-crypt": "dnd5e/crimson-crypt.json",
  crimson: "dnd5e/crimson-crypt.json",
  dnd5e: "dnd5e/crimson-crypt.json",
  "arkham-shadow": "coc7e/arkham-shadow.json",
  arkham: "coc7e/arkham-shadow.json",
  coc7e: "coc7e/arkham-shadow.json"
};
function parseCliArgs(argv) {
  const args = argv.slice(2);
  const command = args[0] ?? "help";
  const positionals = [];
  const flags = {};
  for (let i = 1; i < args.length; i++) {
    const token = args[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(token);
    }
  }
  return { command, positionals, flags };
}
function printOutput(data, asJson, humanText) {
  if (asJson) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    if (humanText) {
      console.log(humanText);
    } else {
      console.log(JSON.stringify(data, null, 2));
    }
  }
}
function resolveExampleFile(requested) {
  const rootDir = path3.resolve(path3.dirname(fileURLToPath(import.meta.url)), "..");
  const cleanRequested = requested.trim();
  const withJson = cleanRequested.endsWith(".json") ? cleanRequested : `${cleanRequested}.json`;
  const candidateDirect = path3.resolve(process.cwd(), cleanRequested);
  if (fs3.existsSync(candidateDirect) && fs3.statSync(candidateDirect).isFile()) {
    return candidateDirect;
  }
  const candidateDirectJson = path3.resolve(process.cwd(), withJson);
  if (fs3.existsSync(candidateDirectJson) && fs3.statSync(candidateDirectJson).isFile()) {
    return candidateDirectJson;
  }
  const candidateCampaign = path3.resolve(rootDir, "campaigns", withJson);
  if (fs3.existsSync(candidateCampaign) && fs3.statSync(candidateCampaign).isFile()) {
    return candidateCampaign;
  }
  const normalized = cleanRequested.toLowerCase().replace(/\.json$/, "");
  const relativeFromAlias = EXAMPLE_ALIASES[normalized];
  if (relativeFromAlias) {
    const p = path3.resolve(rootDir, "examples", relativeFromAlias);
    if (fs3.existsSync(p)) return p;
  }
  const examplesDir = path3.resolve(rootDir, "examples");
  const candidateBaseNames = [
    cleanRequested,
    withJson,
    `campaign-${withJson.replace(/^campaign-/, "")}`,
    withJson.replace(/^campaign-/, "")
  ];
  for (const sub of ["", "dnd5e", "coc7e", "pbta"]) {
    for (const name of candidateBaseNames) {
      const target = path3.resolve(examplesDir, sub, name);
      if (fs3.existsSync(target) && fs3.statSync(target).isFile()) {
        return target;
      }
    }
  }
  const availableAliases = Object.keys(EXAMPLE_ALIASES).sort().join(", ");
  throw new Error(`Scenario "${requested}" not found. Available aliases: ${availableAliases}
Run "node dist/trpg-cli.js init --list" to view all scenarios.`);
}
var parseList = (v) => typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : void 0;
var parseNum = (v, label) => {
  if (v === void 0) return void 0;
  const n = Number(v);
  if (typeof v !== "string" || !Number.isFinite(n)) throw new Error(`--${label} needs a number.`);
  return n;
};
function resolveActorId(state, requested) {
  if (!requested) return void 0;
  const ids = Object.keys(state.combatants);
  if (ids.includes(requested)) return requested;
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const wanted = norm(requested.replace(/^(trpg-)?companion[-_]?/, ""));
  if (!wanted) {
    throw new Error(`Actor "${requested}" not found. Available ids: ${ids.join(", ")}`);
  }
  for (const id of ids) {
    if (norm(id) === wanted) return id;
  }
  for (const id of ids) {
    if (norm(id).endsWith(wanted)) return id;
  }
  for (const id of ids) {
    if (norm(id).includes(wanted)) return id;
  }
  for (const c of Object.values(state.combatants)) {
    const nameNorm = norm(c.name);
    if (nameNorm && (nameNorm.includes(wanted) || wanted.includes(nameNorm))) return c.id;
  }
  throw new Error(`Actor "${requested}" not found. Available ids: ${ids.join(", ")}`);
}
function main() {
  const { command, positionals, flags } = parseCliArgs(process.argv);
  const asJson = Boolean(flags.json);
  const seed = flags.seed !== void 0 ? Number(flags.seed) : void 0;
  const rng = seed !== void 0 ? new DeterministicRNG(seed) : new DeterministicRNG();
  if (flags.temperature !== void 0 && flags.temp === void 0) {
    flags.temp = flags.temperature;
  }
  switch (command) {
    case "init": {
      if (flags.list) {
        const rootDir = path3.resolve(path3.dirname(fileURLToPath(import.meta.url)), "..");
        const catalogPath = path3.resolve(rootDir, "examples", "catalog.json");
        const catalog = fs3.existsSync(catalogPath) ? JSON.parse(fs3.readFileSync(catalogPath, "utf-8")) : [];
        if (asJson) {
          console.log(JSON.stringify(catalog, null, 2));
        } else {
          console.log("\n[TRPG-Swarm \u5167\u5EFA\u7D93\u5178\u6230\u5F79\u5287\u672C\u5EAB]\n");
          for (const item of catalog) {
            const aliases = Array.isArray(item.alias) ? item.alias.join(" | ") : item.alias;
            console.log(`- [${item.system.toUpperCase()}] ${item.title} (\u5225\u540D: ${aliases})`);
            console.log(`  \u8DEF\u5F91: ${item.relativePath} | \u968A\u4F0D: ${item.partySize}`);
            console.log(`  \u7C21\u4ECB: ${item.synopsis}
`);
          }
          console.log("\u8F09\u5165\u65B9\u5F0F: node dist/trpg-cli.js init --example <\u5225\u540D> --state ./campaign-state.json\n");
        }
        break;
      }
      const example = flags.example;
      const statePath = flags.state ?? DEFAULT_STATE_PATH;
      if (example) {
        const examplePath = resolveExampleFile(String(example));
        const state2 = importWorldState(examplePath, seed ?? 42, flags.scene);
        saveWorldState(statePath, state2);
        const summaryObj2 = {
          status: "initialized",
          fromExample: path3.basename(examplePath),
          stateFile: statePath,
          campaignName: state2.campaignName,
          ruleSystem: state2.ruleSystem,
          combatantIds: Object.keys(state2.combatants),
          initiativeOrder: state2.initiativeOrder,
          activeSemanticFacts: queryActiveFacts(state2).length
        };
        printOutput(
          summaryObj2,
          asJson,
          `[TRPG-CLI] \u5DF2\u8F09\u5165\u7BC4\u4F8B\u6230\u5F79\u3010${state2.campaignName}\u3011(${state2.ruleSystem.toUpperCase()}) \u81F3 ${statePath}
\u53EF\u7528 actor ids: ${Object.keys(state2.combatants).join(", ")}
\u5148\u653B\u9806\u5E8F: ${state2.initiativeOrder.join(" -> ")}`
        );
        break;
      }
      const system = (flags.system ?? "dnd5e").toLowerCase();
      const initialSeed = seed ?? 42;
      const state = createDefaultEncounter(system, initialSeed);
      saveWorldState(statePath, state);
      const summaryObj = {
        status: "initialized",
        stateFile: statePath,
        campaignName: state.campaignName,
        ruleSystem: state.ruleSystem,
        seed: initialSeed,
        combatantIds: Object.keys(state.combatants),
        initiativeOrder: state.initiativeOrder,
        activeSemanticFacts: queryActiveFacts(state).length
      };
      printOutput(
        summaryObj,
        asJson,
        `[TRPG-CLI] \u5DF2\u521D\u59CB\u5316\u3010${state.campaignName}\u3011(${state.ruleSystem.toUpperCase()}) \u72C0\u614B\u6A94\u81F3 ${statePath}
\u53EF\u7528 actor ids: ${Object.keys(state.combatants).join(", ")}
\u5148\u653B\u9806\u5E8F: ${state.initiativeOrder.join(" -> ")}`
      );
      break;
    }
    case "roll": {
      const expr = positionals[0] ?? flags.expr ?? "1d20+5";
      const result = rollDice(expr, rng);
      printOutput(
        result,
        asJson,
        `[TRPG-CLI \u64F2\u9AB0] ${result.details}${result.isCriticalSuccess ? " \u3010\u5927\u6210\u529F Critical!\u3011" : ""}${result.isCriticalFailure ? " \u3010\u5927\u5931\u6557 Fumble!\u3011" : ""}`
      );
      break;
    }
    case "check": {
      const statePath = flags.state;
      let system = flags.system?.toLowerCase();
      if (!system && statePath) {
        system = loadWorldState(statePath).ruleSystem;
      }
      system = system ?? "coc7e";
      if (system === "coc7e") {
        const skillRaw = flags.skill;
        const skill = Number(skillRaw ?? 65);
        if (skillRaw !== void 0 && !Number.isFinite(skill)) {
          throw new Error(
            `CoC 7e \u7684 --skill \u5FC5\u9808\u662F 0-100 \u7684\u6578\u5B57\uFF08\u6280\u80FD\u767E\u5206\u6BD4\u503C\uFF09\uFF0C\u6536\u5230 "${String(skillRaw)}"\u3002`
          );
        }
        const bonus = Number(flags.bonus ?? 0);
        const luck = flags.luck !== void 0 ? Number(flags.luck) : void 0;
        const push = Boolean(flags.push);
        const difficultyRaw = String(flags.difficulty ?? "regular").toLowerCase();
        const difficulty = difficultyRaw === "hard" ? "Hard" : difficultyRaw === "extreme" ? "Extreme" : "Regular";
        const checkRes = resolveCoC7eCheck({
          skill,
          bonusPenaltyDice: bonus,
          difficulty,
          spendLuckToSucceed: luck !== void 0,
          availableLuck: luck,
          pushRoll: push,
          rng
        });
        let sanRes = void 0;
        if (flags.san !== void 0) {
          const san = Number(flags.san);
          const sanLoss = flags["san-loss"] ?? "1/1d6";
          const intScore = Number(flags.int ?? 65);
          sanRes = resolveCoC7eSanity(san, sanLoss, intScore, void 0, rng);
        }
        const payload = { system: "coc7e", difficulty, skillCheck: checkRes, sanityCheck: sanRes };
        printOutput(
          payload,
          asJson,
          `[CoC 7e \u6AA2\u5B9A] ${checkRes.narrative}${sanRes ? `
[CoC 7e \u7406\u667A] ${sanRes.narrative}` : ""}`
        );
      } else if (system === "pbta") {
        const moveName = flags.move ?? "Hack and Slash";
        const statMod = Number(flags.mod ?? 2);
        const danger = Number(flags.danger ?? 3);
        const dummyState = createDefaultEncounter("pbta", seed ?? 42);
        const actor = dummyState.combatants.aria_vanguard;
        const target = dummyState.combatants.cult_archon_boss;
        const pbtaRes = resolvePbtAMove(actor, moveName, statMod, danger, target, "1d8+2", rng);
        printOutput(pbtaRes, asJson, `[PbtA \u6AA2\u5B9A] ${pbtaRes.narrative}`);
      } else {
        const dc = flags.dc !== void 0 ? Number(flags.dc) : void 0;
        if (dc !== void 0) {
          const mode = String(flags.mode ?? "normal").toLowerCase();
          const dieExpr = mode === "advantage" ? "2d20kh1" : mode === "disadvantage" ? "2d20kl1" : "1d20";
          const mod = Number(flags.mod ?? 0);
          const roll = rollDice(
            mod !== 0 ? `${dieExpr}${mod >= 0 ? "+" : ""}${mod}` : dieExpr,
            rng
          );
          const success = roll.total >= dc;
          const label = String(flags.label ?? flags.skill ?? "Ability Check");
          const payload = { system: "dnd5e", label, mode, dc, roll, success };
          printOutput(
            payload,
            asJson,
            `[D&D 5e \u6AA2\u5B9A] ${label}: ${roll.details} vs DC ${dc} -> ${success ? "\u6210\u529F Success" : "\u5931\u6557 Failure"}`
          );
        } else {
          const dummyState = createDefaultEncounter("dnd5e", seed ?? 42);
          const attacker = dummyState.combatants.aria_vanguard;
          const defender = dummyState.combatants.cult_archon_boss;
          const atkRes = resolveDnD5eAttack({
            attacker,
            defender,
            action: attacker.actions[0],
            isFlanking: Boolean(flags.flank),
            rng
          });
          printOutput(atkRes, asJson, `[D&D 5e \u653B\u64CA\u793A\u7BC4] ${atkRes.narrative}`);
        }
      }
      break;
    }
    case "ai-decide": {
      const statePath = flags.state ?? DEFAULT_STATE_PATH;
      const state = loadWorldState(statePath);
      const actorId = resolveActorId(state, flags.actor) ?? "aria_vanguard";
      const temperature = flags.temp !== void 0 ? Number(flags.temp) : 0.65;
      const report = evaluateTacticalActions(state, actorId, temperature, rng);
      const top3Text = report.topCandidates.map(
        (c, idx) => `  #${idx + 1} [P=${(c.probability * 100).toFixed(1)}%, U=${c.totalUtility.toFixed(2)}] ${c.description} (action-id: ${c.action.id})`
      ).join("\n");
      printOutput(
        report,
        asJson,
        `${report.narrativeReasoning}
Top-3 \u5019\u9078\u6230\u8853\u5206\u6790:
${top3Text}`
      );
      break;
    }
    case "step-turn": {
      const statePath = flags.state ?? DEFAULT_STATE_PATH;
      const temperature = flags.temp !== void 0 ? Number(flags.temp) : 0.65;
      const state = loadWorldState(statePath);
      const actorId = resolveActorId(state, flags.actor);
      const stepRes = stepCombatTurn(
        state,
        actorId,
        temperature,
        flags["action-id"],
        flags.target
      );
      saveWorldState(statePath, state);
      printOutput(
        {
          turnCompleted: state.turn - 1,
          round: state.round,
          actorId: stepRes.actorId,
          actorName: stepRes.actorName,
          selectedCandidateId: stepRes.decisionReport.selectedCandidate.id,
          selectedActionId: stepRes.decisionReport.selectedCandidate.action.id,
          selectedAction: stepRes.decisionReport.selectedCandidate.description,
          probability: stepRes.decisionReport.selectedCandidate.probability,
          scoreBreakdown: stepRes.decisionReport.selectedCandidate.scoreBreakdown,
          resolutionNarrative: stepRes.resolutionNarrative,
          nextActorId: state.initiativeOrder[state.activeActorIndex]
        },
        asJson,
        `[\u56DE\u5408\u63A8\u9032 Turn ${state.turn - 1}] ${stepRes.eventRecorded.narrativeSummary}`
      );
      break;
    }
    case "adjust": {
      const statePath = flags.state ?? DEFAULT_STATE_PATH;
      const state = loadWorldState(statePath);
      const actorId = resolveActorId(state, flags.actor);
      if (!actorId) {
        throw new Error(`adjust needs --actor. Valid ids: ${Object.keys(state.combatants).join(", ")}`);
      }
      const log = adjustCombatant(state, actorId, {
        hp: flags.hp,
        tempHp: parseNum(flags["temp-hp"], "temp-hp"),
        san: flags.san,
        luck: parseNum(flags.luck, "luck"),
        addConditions: parseList(flags["add-condition"]),
        removeConditions: parseList(flags["remove-condition"])
      });
      saveWorldState(statePath, state);
      printOutput({ status: "adjusted", actorId, changes: log }, asJson, `[TRPG-CLI] ${actorId}\uFF1A${log.join("\uFF1B") || "\u7121\u8B8A\u66F4"}`);
      break;
    }
    case "fact-set": {
      const statePath = flags.state ?? DEFAULT_STATE_PATH;
      const subject = flags.subject ?? "Unknown_Entity";
      const predicate = flags.predicate ?? "state";
      const value = flags.value ?? flags.object ?? "updated";
      const category = flags.category ?? "location";
      const state = loadWorldState(statePath);
      const { newFact, supersededFacts } = upsertSemanticFact(
        state,
        subject,
        predicate,
        value,
        category
      );
      saveWorldState(statePath, state);
      printOutput(
        {
          newFact,
          supersededCount: supersededFacts.length,
          supersededFacts,
          activeFactsCount: queryActiveFacts(state).length
        },
        asJson,
        `[\u8A9E\u7FA9\u8A18\u61B6\u5EAB\u66F4\u65B0 Temporal Supersession] \u65B0\u589E\u4E8B\u5BE6: (${newFact.subject}, ${newFact.predicate}, "${newFact.value}") [ID: ${newFact.id}]${supersededFacts.length > 0 ? ` | \u5DF2\u81EA\u52D5\u8986\u5BEB\u4E26\u6A19\u8A18\u5931\u6548\u820A\u4E8B\u5BE6 ${supersededFacts.length} \u7B46 (${supersededFacts.map((f) => `${f.id}:"${f.value}"`).join(", ")})` : ""}`
      );
      break;
    }
    case "summary": {
      const statePath = flags.state ?? DEFAULT_STATE_PATH;
      const state = loadWorldState(statePath);
      const activeFacts = queryActiveFacts(state);
      const supersededFacts = state.semanticFacts.filter((f) => !f.isActive);
      const combatantSummaries = Object.values(state.combatants).map((c) => ({
        id: c.id,
        name: c.name,
        faction: c.faction,
        role: c.role,
        hp: `${c.hp}/${c.maxHp}${c.tempHp ? ` (+${c.tempHp} \u81E8\u6642)` : ""}`,
        san: `${c.san}/${c.maxSan}`,
        ac: c.ac,
        pos: `(${c.position.x},${c.position.y})`,
        conditions: c.conditions,
        isAlive: c.isAlive
      }));
      const summaryPayload = {
        campaignName: state.campaignName,
        ruleSystem: state.ruleSystem,
        round: state.round,
        turn: state.turn,
        nextActiveCombatant: state.initiativeOrder[state.activeActorIndex],
        combatants: combatantSummaries,
        workingMemoryCount: state.workingMemory.length,
        episodicLogCount: state.episodicLog.length,
        activeSemanticFacts: activeFacts,
        supersededSemanticFacts: supersededFacts,
        recentEvents: state.workingMemory.slice(-5).map((e) => e.narrativeSummary)
      };
      const humanLines = [
        `=== \u6230\u5F79\u72C0\u614B\u6458\u8981\uFF1A\u3010${state.campaignName}\u3011(${state.ruleSystem.toUpperCase()}) ===`,
        `\u56DE\u5408: Round ${state.round} / Turn ${state.turn} | \u4E0B\u4E00\u4F4D\u884C\u52D5\u8005: ${state.initiativeOrder[state.activeActorIndex]}`,
        `--- \u53C3\u6230\u8005\u72C0\u614B ---`,
        ...combatantSummaries.map(
          (c) => `  [${c.faction.toUpperCase()}] ${c.name} (${c.id}): HP ${c.hp}, SAN ${c.san}, AC ${c.ac}, \u5EA7\u6A19 ${c.pos}${c.conditions.length ? ` \u72C0\u614B:[${c.conditions.join(",")}]` : ""}${!c.isAlive ? " [\u5DF2\u9663\u4EA1]" : ""}`
        ),
        `--- \u6709\u6548\u8A9E\u7FA9\u8A18\u61B6 (Active Semantic Facts: ${activeFacts.length}, \u5DF2\u8986\u5BEB\u6B77\u53F2\u4E8B\u5BE6: ${supersededFacts.length}) ---`,
        ...activeFacts.map((f) => `  * (${f.subject}, ${f.predicate}) => "${f.value}" [Turn ${f.turnCreated}]`),
        `--- \u8FD1\u671F\u5DE5\u4F5C\u8A18\u61B6 (Working Memory: ${state.workingMemory.length}/12) ---`,
        ...state.workingMemory.slice(-4).map((e) => `  [T${e.turn}] ${e.narrativeSummary}`)
      ];
      printOutput(summaryPayload, asJson, humanLines.join("\n"));
      break;
    }
    default: {
      console.log(`trpg-swarm deterministic rules & tactics CLI

Usage (cross-platform, works in bash / zsh / PowerShell / cmd):
  node dist/trpg-cli.js <command> [options]
  node --experimental-strip-types scripts/trpg-cli.ts <command> [options]   (Node >= 22.6)

Commands:
  init       [--list] | --system <dnd5e|coc7e|pbta> --state <path> [--seed <num>] [--json]
             --example <alias|path> [--scene <id>] --state <path>   (load bundled campaign by alias or file path; run 'init --list' to view all)
  roll       "<expression>" [--seed <num>] [--json]
  check      [--system <dnd5e|coc7e|pbta>] [--state <path>]
             D&D 5e generic check : --dc <num> [--mod <num>] [--mode advantage|disadvantage|normal] [--label <str>]
             CoC 7e               : --skill <0-100> [--bonus <-2..2>] [--difficulty regular|hard|extreme]
                                    [--push] [--luck <num>] [--san <num>] [--san-loss <formula>] [--int <num>]
             PbtA                 : --move <name> [--mod <num>] [--danger <1-5>]
  ai-decide  --state <path> --actor <actorId|alias> [--temperature <num>] [--seed <num>] [--json]
  step-turn  --state <path> [--actor <actorId|alias>] [--action-id <id>] [--target <actorId>] [--temperature <num>] [--json]
  adjust     --state <path> --actor <id> [--hp +N|-N|=N] [--temp-hp N] [--san +N|-N|=N] [--luck N] [--add-condition c1,c2] [--remove-condition c1]
  fact-set   --state <path> --subject <str> --predicate <str> (--value|--object) <str> [--category <type>] [--json]
  summary    --state <path> [--json]

Notes:
  - Actor aliases are resolved automatically (e.g. "vanguard", "companion-rogue",
    "trpg-companion-healer"); on ambiguity the error lists all valid ids.
  - --action-id accepts either the full candidate id or the bare action id
    printed by ai-decide.
  - --json emits machine-readable output for host agents; --seed makes runs reproducible.`);
      break;
    }
  }
}
try {
  main();
} catch (err) {
  console.error(`[TRPG-CLI Error] ${err.message}`);
  process.exitCode = 1;
}
