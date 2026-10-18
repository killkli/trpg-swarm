/**
 * Carry the party from one saved scene into a freshly built one, so a campaign can move on without
 * hand-copying HP, SAN, Luck, conditions, XP and inventory between save files.
 */
import type { WorldState } from './types.ts';
import { recordEpisodicEvent } from './stateStore.ts';

/**
 * Overwrites the party in `next` with the party from `previous`, keeping only each member's new position.
 * Mutates `next` and returns warnings (a dying member keeps the condition, so the next turn still needs its roll).
 */
export function carryPartyIntoScene(previous: WorldState, next: WorldState): string[] {
  if (previous.ruleSystem !== next.ruleSystem) {
    throw new Error(`--carry: rule system differs (${previous.ruleSystem} vs ${next.ruleSystem}).`);
  }
  const oldIds = Object.values(previous.combatants)
    .filter((c) => c.faction === 'party')
    .map((c) => c.id);
  const newIds = Object.values(next.combatants)
    .filter((c) => c.faction === 'party')
    .map((c) => c.id);
  const missing = newIds.filter((id) => !oldIds.includes(id));
  const extra = oldIds.filter((id) => !newIds.includes(id));
  if (missing.length || extra.length) {
    throw new Error(
      `--carry: party differs between the save and the scene (not in save: ${missing.join(', ') || '-'}; not in scene: ${extra.join(', ') || '-'}).`
    );
  }

  const warnings: string[] = [];
  for (const id of newIds) {
    const old = previous.combatants[id];
    next.combatants[id] = { ...structuredClone(old), position: next.combatants[id].position };
    if (old.conditions.includes('dying')) warnings.push(`${old.name} is still dying; the condition carries over.`);
  }

  // Dead members stay in the roster but take no turns.
  next.initiativeOrder = next.initiativeOrder.filter((id) => next.combatants[id].isAlive);
  next.rngSeed = previous.rngSeed;
  next.episodicLog = previous.episodicLog;
  next.workingMemory = previous.workingMemory;
  next.semanticFacts = previous.semanticFacts;

  recordEpisodicEvent(next, {
    actorId: 'system',
    actorName: 'System',
    actionType: 'scene-transition',
    narrativeSummary: `隊伍進入場景：${next.sceneName}`,
  });
  return warnings;
}
