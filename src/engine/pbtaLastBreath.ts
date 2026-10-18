/**
 * PbtA Last Breath (references/pbta-dungeon-world.md §2.8): at 0 HP, roll a flat 2d6 with no stat modifier.
 */
import { DeterministicRNG, getGlobalRng, rollDice } from './dice.ts';

export interface PbtALastBreathResolution {
  total: number;
  tier: '10+ (Cheat Death)' | '7-9 (Bargain)' | '6- (Death)';
  narrative: string;
}

export function resolvePbtALastBreath(rng: DeterministicRNG = getGlobalRng()): PbtALastBreathResolution {
  const total = rollDice('2d6', rng).total;
  if (total >= 10) {
    return {
      total,
      tier: '10+ (Cheat Death)',
      narrative: `彌留之際 (2d6 = ${total})：【10+】欺騙了死神，瀕危但穩定（1 HP）。`,
    };
  }
  if (total >= 7) {
    return {
      total,
      tier: '7-9 (Bargain)',
      narrative: `彌留之際 (2d6 = ${total})：【7-9】死神開價。接受交易（烙印、使命或代價）就穩定下來，拒絕則踏入黑門。`,
    };
  }
  return {
    total,
    tier: '6- (Death)',
    narrative: `彌留之際 (2d6 = ${total})：【6-】命運已定，死神帶走靈魂。`,
  };
}
