import type {
  AbilityOrAction,
  Combatant,
  GridPosition,
  ScoreBreakdown,
  TacticalCandidate,
  TacticalDecisionReport,
  TerrainType,
  WorldState,
} from './types.ts';
import { DeterministicRNG, estimateDiceExpectedValue, getGlobalRng } from './dice.ts';

/**
 * Euclidean grid distance (1 tile = 5ft).
 */
export function gridDistance(a: GridPosition, b: GridPosition): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Computes a dynamic Threat Index for a combatant based on offensive capability,
 * remaining health ratio, spellcasting potential, and active conditions.
 */
export function computeCombatantThreatIndex(combatant: Combatant): number {
  if (!combatant.isAlive || combatant.hp <= 0) return 0;

  const hpFactor = 0.4 + 0.6 * (combatant.hp / Math.max(1, combatant.maxHp));
  let maxActionOffense = 0;

  for (const act of combatant.actions) {
    const avgDmg = estimateDiceExpectedValue(act.damageFormula);
    const aoeMultiplier = act.aoeRadius ? 1 + act.aoeRadius * 0.45 : 1.0;
    const rangeMultiplier = act.range > 2 ? 1.15 : 1.0;
    const score = avgDmg * aoeMultiplier * rangeMultiplier;
    if (score > maxActionOffense) {
      maxActionOffense = score;
    }
  }

  const conditionPenalty =
    combatant.conditions.includes('stunned') || combatant.conditions.includes('unconscious')
      ? 0.25
      : combatant.conditions.includes('restrained') || combatant.conditions.includes('prone')
        ? 0.75
        : 1.0;

  return Math.max(1.0, maxActionOffense * hpFactor * conditionPenalty);
}

/**
 * Computes the Total Battlefield Threat Ratio (opposing faction total threat vs allied faction total threat).
 */
export function computeBattlefieldThreatRatio(state: WorldState, actor: Combatant): number {
  let enemyThreatSum = 0;
  let allyThreatSum = 0;

  for (const c of Object.values(state.combatants)) {
    if (!c.isAlive) continue;
    const threat = computeCombatantThreatIndex(c);
    if (c.faction === actor.faction) {
      allyThreatSum += threat;
    } else if (c.faction !== 'neutral') {
      enemyThreatSum += threat;
    }
  }

  return enemyThreatSum / Math.max(1.0, allyThreatSum);
}

/**
 * Enumerates reachable grid positions within actor's movement speed on the map,
 * respecting map boundaries, difficult terrain, and occupied tiles.
 */
export function getReachablePositions(state: WorldState, actor: Combatant): GridPosition[] {
  const occupied = new Set<string>();
  for (const c of Object.values(state.combatants)) {
    if (c.id !== actor.id && c.isAlive && c.hp > 0) {
      occupied.add(`${c.position.x},${c.position.y}`);
    }
  }

  const reachable: GridPosition[] = [];
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

      const cellTerrain: TerrainType = state.map.cells[ny]?.[nx] ?? 'normal';
      const cellElevation: number = state.map.elevation[ny]?.[nx] ?? 0;
      const moveCost =
        gridDistance(actor.position, { x: nx, y: ny }) * (cellTerrain === 'difficult' ? 1.5 : 1.0);

      if (moveCost <= maxStep + 0.01) {
        reachable.push({
          x: nx,
          y: ny,
          elevation: cellElevation,
          terrain: cellTerrain,
        });
      }
    }
  }

  if (reachable.length === 0) {
    reachable.push({ ...actor.position });
  }
  return reachable;
}

/**
 * Checks if moving to `candidatePos` places `actor` on the opposite side of `target`
 * with respect to an allied combatant adjacent to `target` (Flanking check).
 */
export function isFlankingPosition(
  state: WorldState,
  actor: Combatant,
  candidatePos: GridPosition,
  target: Combatant
): boolean {
  if (gridDistance(candidatePos, target.position) > 1.6) return false;

  for (const ally of Object.values(state.combatants)) {
    if (ally.id === actor.id || ally.faction !== actor.faction || !ally.isAlive || ally.hp <= 0) {
      continue;
    }
    if (gridDistance(ally.position, target.position) <= 1.6) {
      // Check vector dot product across the target center
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

/**
 * Computes the 6 continuous dynamic situational dimensions for a candidate (moveTo, action, target).
 * Strictly derived from continuous battlefield metrics without hardcoded fake scores.
 */
function scoreCandidateDimensions(
  state: WorldState,
  actor: Combatant,
  moveTo: GridPosition,
  action: AbilityOrAction,
  primaryTarget: Combatant | undefined,
  allEnemies: Combatant[],
  allAllies: Combatant[],
  battlefieldThreatRatio: number
): { breakdown: ScoreBreakdown; targetsInAoe: string[] } {
  // 1. Lethality Score: Expected damage vs target remaining HP + smooth exponential Kill Confirm bonus
  let lethalityScore = 0;
  const targetsInAoe: string[] = [];

  if (
    primaryTarget &&
    (action.type === 'melee' || action.type === 'ranged' || action.type === 'spell' || action.type === 'debuff')
  ) {
    const rawExpectedDmg = estimateDiceExpectedValue(action.damageFormula);
    const hitProbEstimate = action.saveAbility
      ? 0.65
      : Math.max(
          0.15,
          Math.min(0.95, (21 - (primaryTarget.ac - (action.attackBonus ?? 5))) / 20)
        );
    const flankingBoost =
      action.type === 'melee' && isFlankingPosition(state, actor, moveTo, primaryTarget) ? 1.22 : 1.0;
    const elevationBoost = (moveTo.elevation ?? 0) > (primaryTarget.position.elevation ?? 0) ? 1.12 : 1.0;

    const effectiveExpectedDmg = rawExpectedDmg * hitProbEstimate * flankingBoost * elevationBoost;
    const hpRatioDealt = effectiveExpectedDmg / Math.max(1, primaryTarget.hp);

    // Smooth exponential kill-confirm curve when expected damage approaches or exceeds remaining HP
    const killConfirmBonus =
      hpRatioDealt >= 0.85 ? 1.8 * (1 - Math.exp(-1.5 * hpRatioDealt)) : 0.4 * hpRatioDealt;

    const targetThreatWeight = computeCombatantThreatIndex(primaryTarget) / 10.0;
    const debuffValue = action.appliesCondition && !primaryTarget.conditions.includes(action.appliesCondition)
      ? 1.15 * targetThreatWeight
      : 0;

    lethalityScore =
      (Math.min(2.5, hpRatioDealt * 1.4) + killConfirmBonus + debuffValue) *
      (0.75 + 0.25 * targetThreatWeight);
  }

  // 2. Triage Urgency: Non-linear exponential surge when ally is at 0 HP (dying) or low HP (<35%) / low SAN (<30%)
  let triageUrgency = 0;
  if (primaryTarget && (action.type === 'heal' || action.type === 'buff')) {
    const missingHpRatio = 1 - primaryTarget.hp / Math.max(1, primaryTarget.maxHp);
    const sanRatio = primaryTarget.san / Math.max(1, primaryTarget.maxSan);
    const isDying = primaryTarget.hp === 0 && primaryTarget.isAlive;

    if (action.type === 'heal') {
      const expectedHeal = estimateDiceExpectedValue(action.healFormula);
      const healEfficiency = Math.min(
        1.5,
        expectedHeal / Math.max(1, primaryTarget.maxHp - primaryTarget.hp + 1)
      );

      if (isDying) {
        // Emergency rescue surge for 0 HP unconscious ally
        triageUrgency = 4.2 + healEfficiency * 0.9;
      } else if (missingHpRatio > 0.05) {
        // Non-linear exponential urgency curve: spikes sharply when HP < 35% (missingHpRatio > 0.65)
        triageUrgency =
          (Math.exp(2.6 * missingHpRatio) - 1) * 0.85 * (0.5 + 0.5 * healEfficiency);
      } else {
        // Penalty for wasting heals on full-HP allies
        triageUrgency = -1.8;
      }
    } else if (action.type === 'buff') {
      const lowSanUrgency = sanRatio < 0.3 ? (0.3 - sanRatio) * 3.0 : 0;
      const alreadyBuffed =
        action.appliesCondition && primaryTarget.conditions.includes(action.appliesCondition);
      triageUrgency = alreadyBuffed
        ? -1.2
        : 0.75 + missingHpRatio * 0.8 + lowSanUrgency;
    }
  }

  // 3. AOE Cluster Efficiency: Enemies caught in AOE radius minus severe penalty for friendly fire
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
        totalClusterThreat += computeCombatantThreatIndex(enemy) / 12.0;
      }
    }
    for (const ally of allAllies) {
      if (gridDistance(center, ally.position) <= action.aoeRadius + 0.25) {
        alliesHit++;
      }
    }

    // Multi-target AOE synergy vs friendly fire penalty
    aoeClusterEfficiency =
      enemiesHit * 1.15 + totalClusterThreat * 0.45 - alliesHit * 2.4;
  } else if (primaryTarget) {
    targetsInAoe.push(primaryTarget.id);
  }

  // 4. Positional Safety: Terrain cover, high ground, role-specific optimal engagement distance
  let positionalSafety = 0;
  const terrain = moveTo.terrain ?? state.map.cells[moveTo.y]?.[moveTo.x] ?? 'normal';
  const elevation = moveTo.elevation ?? state.map.elevation[moveTo.y]?.[moveTo.x] ?? 0;

  if (terrain === 'cover_three_quarters') positionalSafety += 1.35;
  else if (terrain === 'cover_half') positionalSafety += 0.85;
  else if (terrain === 'hazard') positionalSafety -= 2.2;

  positionalSafety += elevation * 0.45;

  // Distance to nearest high-threat enemy and nearest vulnerable ally
  let minEnemyDist = 99;
  for (const enemy of allEnemies) {
    const d = gridDistance(moveTo, enemy.position);
    if (d < minEnemyDist) minEnemyDist = d;
  }

  const selfHpRatio = actor.hp / Math.max(1, actor.maxHp);

  if (actor.role === 'arcanist' || actor.role === 'healer') {
    // Ranged casters/healers prefer kiting distance (3.5 to 7 tiles away from enemies)
    const idealDist = 5.0;
    const distPenalty =
      minEnemyDist < 2.2
        ? -1.6 * (2.2 - minEnemyDist)
        : -0.18 * Math.abs(minEnemyDist - idealDist);
    positionalSafety += distPenalty * (1.3 - 0.5 * selfHpRatio);
  } else if (actor.role === 'vanguard') {
    // Vanguard prefers screening between enemies and fragile backline allies
    let screenBonus = 0;
    for (const ally of allAllies) {
      if (ally.role === 'arcanist' || ally.role === 'healer') {
        const distToBackline = gridDistance(moveTo, ally.position);
        if (minEnemyDist <= 1.8 && distToBackline <= 3.5) {
          screenBonus += 0.95;
        }
      }
    }
    positionalSafety += screenBonus + (minEnemyDist <= 1.6 ? 0.65 : -0.15 * minEnemyDist);
  } else if (actor.role === 'rogue') {
    // Rogue prefers flanking tiles or cover tiles
    if (primaryTarget && isFlankingPosition(state, actor, moveTo, primaryTarget)) {
      positionalSafety += 1.25;
    }
  }

  // Dodge action defensive bonus when low HP and threatened
  if (action.type === 'dodge') {
    positionalSafety += (1 - selfHpRatio) * 2.1 + (minEnemyDist <= 1.8 ? 0.9 : -0.6);
  }

  // 5. Resource Conservation: Spell slot level vs current Battlefield Threat Ratio & target worthiness
  let resourceConservation = 0;
  const spellLevel = action.spellLevel ?? 0;
  if (spellLevel > 0) {
    const slotInfo = actor.stats.spellSlots?.[spellLevel];
    const remainingSlots = slotInfo?.current ?? 0;
    const maxSlots = slotInfo?.max ?? 1;
    const scarcityRatio = 1 - remainingSlots / Math.max(1, maxSlots);

    // High-level spells are justified when battlefieldThreatRatio is high or hitting multiple targets
    const targetCountFactor = Math.max(1, targetsInAoe.length);
    const worthiness = battlefieldThreatRatio * 0.75 + targetCountFactor * 0.45 + triageUrgency * 0.35;
    const slotCost = spellLevel * (0.45 + 0.35 * scarcityRatio);

    resourceConservation = worthiness - slotCost;
  } else {
    // Cantrips & martial attacks conserve spell slots
    resourceConservation = 0.35;
  }

  // 6. Persona Alignment: Dynamic dot-product between role/persona weights and situational dimensions
  const p = actor.persona;
  const investigateUtility =
    action.type === 'investigate'
      ? (p.curiosity ?? 0.8) * (allEnemies.length === 0 ? 2.4 : 0.35)
      : 0;

  const personaAlignment =
    (lethalityScore * (p.aggression - 1.0) +
      triageUrgency * (p.altruism - 1.0) +
      aoeClusterEfficiency * (p.tacticalPrecision - 1.0) +
      positionalSafety * (p.caution - 1.0) +
      resourceConservation * (p.resourceThrift - 1.0) +
      investigateUtility) *
    0.45;

  return {
    breakdown: {
      lethalityScore: Number(lethalityScore.toFixed(4)),
      triageUrgency: Number(triageUrgency.toFixed(4)),
      aoeClusterEfficiency: Number(aoeClusterEfficiency.toFixed(4)),
      positionalSafety: Number(positionalSafety.toFixed(4)),
      resourceConservation: Number(resourceConservation.toFixed(4)),
      personaAlignment: Number(personaAlignment.toFixed(4)),
    },
    targetsInAoe,
  };
}

/**
 * Numerically stable Softmax probability distribution:
 * P_i = exp((U_i - maxU) / tau) / sum_j exp((U_j - maxU) / tau)
 */
export function computeSoftmaxProbabilities(
  utilities: number[],
  temperature = 0.65
): number[] {
  if (utilities.length === 0) return [];
  const tau = Math.max(0.05, temperature);
  const maxU = Math.max(...utilities);

  const exps = utilities.map((u) => Math.exp((u - maxU) / tau));
  const sumExp = exps.reduce((acc, v) => acc + v, 0);

  return exps.map((e) => e / sumExp);
}

/**
 * Multi-layered Situational Awareness & Softmax Tactical Decision Engine.
 * Enumerates all legal (MovePosition, Action/Spell, Target) tuples for `actorId`,
 * evaluates 6 continuous situational dimensions, applies numerically stable Softmax,
 * and samples an optimal tactical decision while returning the Top-3 analytical report.
 */
export function evaluateTacticalActions(
  state: WorldState,
  actorId: string,
  temperature = 0.65,
  rng: DeterministicRNG = getGlobalRng(),
  preferredActionId?: string,
  preferredTargetId?: string
): TacticalDecisionReport {
  const actor = state.combatants[actorId];
  if (!actor) {
    throw new Error(`Combatant "${actorId}" not found in WorldState.`);
  }

  const allCombatants = Object.values(state.combatants).filter((c) => c.isAlive);
  const allEnemies = allCombatants.filter(
    (c) => c.faction !== actor.faction && c.faction !== 'neutral' && c.hp > 0
  );
  const allAllies = allCombatants.filter((c) => c.faction === actor.faction);

  const battlefieldThreatRatio = computeBattlefieldThreatRatio(state, actor);
  const reachableTiles = getReachablePositions(state, actor);

  const candidates: TacticalCandidate[] = [];

  for (const moveTo of reachableTiles) {
    for (const action of actor.actions) {
      // Skip leveled spells if out of spell slots
      if (action.spellLevel && action.spellLevel > 0) {
        const slot = actor.stats.spellSlots?.[action.spellLevel];
        if (!slot || slot.current <= 0) {
          continue;
        }
      }

      // Skip class features that are used up (Second Wind, Lay on Hands, ...)
      if (action.usesResource && (actor.stats.resources?.[action.usesResource]?.current ?? 0) <= 0) {
        continue;
      }

      // Determine valid targets for this action from `moveTo`
      let potentialTargets: (Combatant | undefined)[] = [];
      if (action.type === 'heal' || action.type === 'buff') {
        potentialTargets = allAllies.filter(
          (ally) => gridDistance(moveTo, ally.position) <= action.range + 0.35
        );
      } else if (action.type === 'dodge' || action.type === 'dash' || action.type === 'investigate') {
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
        const totalUtility =
          breakdown.lethalityScore * p.aggression +
          breakdown.triageUrgency * p.altruism +
          breakdown.aoeClusterEfficiency * p.tacticalPrecision +
          breakdown.positionalSafety * p.caution +
          breakdown.resourceConservation * p.resourceThrift +
          breakdown.personaAlignment;

        const moveDesc =
          moveTo.x === actor.position.x && moveTo.y === actor.position.y
            ? `堅守原位 (${moveTo.x},${moveTo.y})`
            : `移動至 (${moveTo.x},${moveTo.y}${moveTo.terrain && moveTo.terrain !== 'normal' ? ` [${moveTo.terrain}]` : ''})`;

        const targetDesc = target && target.id !== actor.id ? ` -> 目標【${target.name}】` : '';
        const aoeDesc =
          targetsInAoe.length > 1 ? ` (AOE 波及 ${targetsInAoe.length} 名目標)` : '';

        candidates.push({
          id: `${actor.id}_${action.id}_${moveTo.x}_${moveTo.y}_${target?.id ?? 'self'}`,
          actorId: actor.id,
          action,
          targetId: target?.id,
          targetIdsInAoe: targetsInAoe,
          moveTo,
          targetPosition: target ? { ...target.position } : { ...moveTo },
          description: `${moveDesc}，施展【${action.name}】${targetDesc}${aoeDesc}`,
          scoreBreakdown: breakdown,
          totalUtility: Number(totalUtility.toFixed(4)),
          probability: 0,
        });
      }
    }
  }

  // Fallback candidate if all enemies are out of immediate range: Dash/Advance toward nearest enemy
  if (candidates.length === 0) {
    const nearestEnemy = allEnemies[0];
    let bestTile = reachableTiles[0];
    if (nearestEnemy) {
      bestTile = [...reachableTiles].sort(
        (a, b) => gridDistance(a, nearestEnemy.position) - gridDistance(b, nearestEnemy.position)
      )[0];
    }
    const dashAction: AbilityOrAction = {
      id: 'dash_advance',
      name: '戰術疾走推進 (Dash)',
      type: 'dash',
      range: 0,
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
      description: `疾走推進至 (${bestTile.x},${bestTile.y}) 逼近敵方陣線`,
      scoreBreakdown: breakdown,
      totalUtility: Number(
        (breakdown.positionalSafety + breakdown.resourceConservation).toFixed(4)
      ),
      probability: 1.0,
    });
  }

  // Compute Softmax probabilities across all candidates
  const utilities = candidates.map((c) => c.totalUtility);
  const probs = computeSoftmaxProbabilities(utilities, temperature);
  for (let i = 0; i < candidates.length; i++) {
    candidates[i].probability = Number(probs[i].toFixed(4));
  }

  // Sort descending by utility for Top-3 analytical report
  const sorted = [...candidates].sort((a, b) => b.totalUtility - a.totalUtility);
  const topCandidates = sorted.slice(0, 3);

  // Sample from the Softmax distribution over the top viable candidates (prevents low-probability noise while preserving stochasticity)
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

  // Deterministic override: honor an explicitly declared action (zero-hallucination
  // contract for host agents), matched by full candidate id or bare action id.
  // Unmatched overrides are hard errors, never silent fallbacks.
  // An optional target id narrows the choice to candidates aimed at that combatant.
  if (preferredActionId || preferredTargetId) {
    const pool = candidates.filter(
      (c) =>
        (!preferredActionId || c.id === preferredActionId || c.action.id === preferredActionId) &&
        (!preferredTargetId || c.targetId === preferredTargetId)
    );
    const override = pool.reduce<(typeof pool)[number] | undefined>(
      (best, c) => (!best || c.totalUtility > best.totalUtility ? c : best),
      undefined
    );
    if (!override) {
      const unique = (ids: string[]) => [...new Set(ids)];
      const legalActionIds = unique(candidates.map((c) => c.action.id));
      const legalTargetIds = unique(
        candidates
          .filter((c) => !preferredActionId || c.action.id === preferredActionId)
          .map((c) => c.targetId)
          .filter((id): id is string => Boolean(id))
      );
      const actionOk = !preferredActionId || legalActionIds.includes(preferredActionId);
      throw new Error(
        (actionOk
          ? `Target "${preferredTargetId}" is not a legal target for "${actor.name}" (${actor.id})` +
            `${preferredActionId ? ` with action "${preferredActionId}"` : ''}. `
          : `Action "${preferredActionId}" is not a legal candidate for "${actor.name}" (${actor.id}). `) +
          `Legal action ids: ${legalActionIds.join(', ')}. Legal target ids: ${legalTargetIds.join(', ')}. Re-run ai-decide for current candidates.`
      );
    }
    selectedCandidate = override;
  }

  const b = selectedCandidate.scoreBreakdown;
  const narrativeReasoning = `[戰術情勢感知 Softmax 決策 (τ=${temperature}, 戰場威脅比=${battlefieldThreatRatio.toFixed(2)})] ${actor.name} (${actor.role}) 評估了 ${candidates.length} 種合法走位與行動組合，最終以 ${(selectedCandidate.probability * 100).toFixed(1)}% 機率選擇：「${selectedCandidate.description}」(總效用 U=${selectedCandidate.totalUtility.toFixed(2)} | 斬殺=${b.lethalityScore.toFixed(2)}, 救援=${b.triageUrgency.toFixed(2)}, AOE=${b.aoeClusterEfficiency.toFixed(2)}, 站位安全=${b.positionalSafety.toFixed(2)}, 資源保育=${b.resourceConservation.toFixed(2)}, 性格契合=${b.personaAlignment.toFixed(2)})。`;

  return {
    actorId: actor.id,
    actorName: actor.name,
    role: actor.role,
    temperature,
    selectedCandidate,
    topCandidates,
    allCandidateCount: candidates.length,
    battlefieldThreatRatio: Number(battlefieldThreatRatio.toFixed(3)),
    narrativeReasoning,
  };
}
