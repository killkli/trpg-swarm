#!/usr/bin/env node
/**
 * trpg-swarm deterministic rules & tactics CLI.
 *
 * Cross-platform contract (any OS, any host agent):
 *   - Preferred:  node dist/trpg-cli.js <command>        (prebuilt bundle, Node >= 18, zero deps)
 *   - Source mode: node --experimental-strip-types scripts/trpg-cli.ts <command>  (Node >= 22.6)
 *   - All commands accept --json for machine-readable output and --seed for deterministic replay.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FactCategory, RuleSystem, WorldState } from '../src/engine/types.ts';
import { DeterministicRNG, rollDice } from '../src/engine/dice.ts';
import {
  resolveCoC7eCheck,
  resolveCoC7eSanity,
  resolveDnD5eAttack,
  resolvePbtAMove,
} from '../src/engine/rulesEngine.ts';
import { evaluateTacticalActions } from '../src/engine/tacticalAI.ts';
import {
  adjustCombatant,
  createDefaultEncounter,
  loadWorldState,
  queryActiveFacts,
  saveWorldState,
  stepCombatTurn,
  upsertSemanticFact,
} from '../src/engine/stateStore.ts';
import { importWorldState } from '../src/engine/campaignImport.ts';

const DEFAULT_STATE_PATH = './campaign-state.json';

const EXAMPLE_ALIASES: Record<string, string> = {
  'crimson-crypt': 'dnd5e/crimson-crypt.json',
  crimson: 'dnd5e/crimson-crypt.json',
  dnd5e: 'dnd5e/crimson-crypt.json',
  'arkham-shadow': 'coc7e/arkham-shadow.json',
  arkham: 'coc7e/arkham-shadow.json',
  coc7e: 'coc7e/arkham-shadow.json',
};

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseCliArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const command = args[0] ?? 'help';
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 1; i < args.length; i++) {
    const token = args[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
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

function printOutput(data: unknown, asJson: boolean, humanText?: string): void {
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


function resolveExampleFile(requested: string): string {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const cleanRequested = requested.trim();
  const withJson = cleanRequested.endsWith('.json') ? cleanRequested : `${cleanRequested}.json`;

  // 1. Direct path check (as given or with .json)
  const candidateDirect = path.resolve(process.cwd(), cleanRequested);
  if (fs.existsSync(candidateDirect) && fs.statSync(candidateDirect).isFile()) {
    return candidateDirect;
  }
  const candidateDirectJson = path.resolve(process.cwd(), withJson);
  if (fs.existsSync(candidateDirectJson) && fs.statSync(candidateDirectJson).isFile()) {
    return candidateDirectJson;
  }

  // 2. Check in campaigns/ directory
  const candidateCampaign = path.resolve(rootDir, 'campaigns', withJson);
  if (fs.existsSync(candidateCampaign) && fs.statSync(candidateCampaign).isFile()) {
    return candidateCampaign;
  }

  // 3. Normalized alias check
  const normalized = cleanRequested.toLowerCase().replace(/\.json$/, '');
  const relativeFromAlias = EXAMPLE_ALIASES[normalized];
  if (relativeFromAlias) {
    const p = path.resolve(rootDir, 'examples', relativeFromAlias);
    if (fs.existsSync(p)) return p;
  }

  // 4. Search inside examples/ and its system subdirectories
  const examplesDir = path.resolve(rootDir, 'examples');
  const candidateBaseNames = [
    cleanRequested,
    withJson,
    `campaign-${withJson.replace(/^campaign-/, '')}`,
    withJson.replace(/^campaign-/, ''),
  ];

  for (const sub of ['', 'dnd5e', 'coc7e', 'pbta']) {
    for (const name of candidateBaseNames) {
      const target = path.resolve(examplesDir, sub, name);
      if (fs.existsSync(target) && fs.statSync(target).isFile()) {
        return target;
      }
    }
  }

  const availableAliases = Object.keys(EXAMPLE_ALIASES).sort().join(', ');
  throw new Error(`Scenario "${requested}" not found. Available aliases: ${availableAliases}\nRun "node dist/trpg-cli.js init --list" to view all scenarios.`);
}

/**
 * Actor id resolver: host agents frequently guess ids ("vanguard", "companion-rogue",
 * "trpg-companion-healer"). Accept exact id, normalized equality, role-token suffix /
 * containment, and character-name matches. On failure, list every available id so the
 * agent can self-correct in one round-trip.
 */
const parseList = (v: string | boolean | undefined) =>
  typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined;

const parseNum = (v: string | boolean | undefined, label: string) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (typeof v !== 'string' || !Number.isFinite(n)) throw new Error(`--${label} needs a number.`);
  return n;
};

function resolveActorId(state: WorldState, requested?: string): string | undefined {
  if (!requested) return undefined;
  const ids = Object.keys(state.combatants);
  if (ids.includes(requested)) return requested;

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const wanted = norm(requested.replace(/^(trpg-)?companion[-_]?/, ''));
  if (!wanted) {
    throw new Error(`Actor "${requested}" not found. Available ids: ${ids.join(', ')}`);
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

  throw new Error(`Actor "${requested}" not found. Available ids: ${ids.join(', ')}`);
}


function main(): void {
  const { command, positionals, flags } = parseCliArgs(process.argv);
  const asJson = Boolean(flags.json);
  const seed = flags.seed !== undefined ? Number(flags.seed) : undefined;
  const rng = seed !== undefined ? new DeterministicRNG(seed) : new DeterministicRNG();
  // --temperature is the documented long form; normalize onto --temp once here.
  if (flags.temperature !== undefined && flags.temp === undefined) {
    flags.temp = flags.temperature;
  }

  // `<command> --help` / `-h` prints the usage; without this the command ran with its defaults.
  const wantsHelp = flags.help !== undefined || positionals.includes('-h');

  switch (wantsHelp ? 'help' : command) {
    case 'init': {
      if (flags.list) {
        const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
        const catalogPath = path.resolve(rootDir, 'examples', 'catalog.json');
        const catalog = fs.existsSync(catalogPath) ? JSON.parse(fs.readFileSync(catalogPath, 'utf-8')) : [];
        if (asJson) {
          console.log(JSON.stringify(catalog, null, 2));
        } else {
          console.log('\n[TRPG-Swarm 內建經典戰役劇本庫]\n');
          for (const item of catalog) {
            const aliases = Array.isArray(item.alias) ? item.alias.join(' | ') : item.alias;
            console.log(`- [${item.system.toUpperCase()}] ${item.title} (別名: ${aliases})`);
            console.log(`  路徑: ${item.relativePath} | 隊伍: ${item.partySize}`);
            console.log(`  簡介: ${item.synopsis}\n`);
          }
          console.log('載入方式: node dist/trpg-cli.js init --example <別名> --state ./campaign-state.json\n');
        }
        break;
      }
      const example = flags.example as string | undefined;
      const statePath = (flags.state as string) ?? DEFAULT_STATE_PATH;

      if (example) {
        const examplePath = resolveExampleFile(String(example));
        const state = importWorldState(examplePath, seed ?? 42, flags.scene as string | undefined);
        saveWorldState(statePath, state);
        const summaryObj = {
          status: 'initialized',
          fromExample: path.basename(examplePath),
          stateFile: statePath,
          campaignName: state.campaignName,
          ruleSystem: state.ruleSystem,
          combatantIds: Object.keys(state.combatants),
          initiativeOrder: state.initiativeOrder,
          activeSemanticFacts: queryActiveFacts(state).length,
        };
        printOutput(
          summaryObj,
          asJson,
          `[TRPG-CLI] 已載入範例戰役【${state.campaignName}】(${state.ruleSystem.toUpperCase()}) 至 ${statePath}\n可用 actor ids: ${Object.keys(state.combatants).join(', ')}\n先攻順序: ${state.initiativeOrder.join(' -> ')}`
        );
        break;
      }

      const system = ((flags.system as string) ?? 'dnd5e').toLowerCase() as RuleSystem;
      const initialSeed = seed ?? 42;
      const state = createDefaultEncounter(system, initialSeed);
      saveWorldState(statePath, state);

      const summaryObj = {
        status: 'initialized',
        stateFile: statePath,
        campaignName: state.campaignName,
        ruleSystem: state.ruleSystem,
        seed: initialSeed,
        combatantIds: Object.keys(state.combatants),
        initiativeOrder: state.initiativeOrder,
        activeSemanticFacts: queryActiveFacts(state).length,
      };
      printOutput(
        summaryObj,
        asJson,
        `[TRPG-CLI] 已初始化【${state.campaignName}】(${state.ruleSystem.toUpperCase()}) 狀態檔至 ${statePath}\n可用 actor ids: ${Object.keys(state.combatants).join(', ')}\n先攻順序: ${state.initiativeOrder.join(' -> ')}`
      );
      break;
    }

    case 'roll': {
      const expr = positionals[0] ?? (flags.expr as string) ?? '1d20+5';
      const result = rollDice(expr, rng);
      printOutput(
        result,
        asJson,
        `[TRPG-CLI 擲骰] ${result.details}${result.isCriticalSuccess ? ' 【大成功 Critical!】' : ''}${result.isCriticalFailure ? ' 【大失敗 Fumble!】' : ''}`
      );
      break;
    }

    case 'check': {
      const statePath = flags.state as string | undefined;
      let system = (flags.system as string | undefined)?.toLowerCase();
      if (!system && statePath) {
        system = loadWorldState(statePath).ruleSystem;
      }
      system = (system ?? 'coc7e') as RuleSystem;

      if (system === 'coc7e') {
        const skillRaw = flags.skill;
        const skill = Number(skillRaw ?? 65);
        if (skillRaw !== undefined && !Number.isFinite(skill)) {
          throw new Error(
            `CoC 7e 的 --skill 必須是 0-100 的數字（技能百分比值），收到 "${String(skillRaw)}"。`
          );
        }
        const bonus = Number(flags.bonus ?? 0);
        const luck = flags.luck !== undefined ? Number(flags.luck) : undefined;
        const push = Boolean(flags.push);
        const difficultyRaw = String(flags.difficulty ?? 'regular').toLowerCase();
        const difficulty =
          difficultyRaw === 'hard'
            ? ('Hard' as const)
            : difficultyRaw === 'extreme'
              ? ('Extreme' as const)
              : ('Regular' as const);
        const checkRes = resolveCoC7eCheck({
          skill,
          bonusPenaltyDice: bonus,
          difficulty,
          spendLuckToSucceed: luck !== undefined,
          availableLuck: luck,
          pushRoll: push,
          rng,
        });

        let sanRes = undefined;
        if (flags.san !== undefined) {
          const san = Number(flags.san);
          const sanLoss = (flags['san-loss'] as string) ?? '1/1d6';
          const intScore = Number(flags.int ?? 65);
          sanRes = resolveCoC7eSanity(san, sanLoss, intScore, undefined, rng);
        }

        const payload = { system: 'coc7e', difficulty, skillCheck: checkRes, sanityCheck: sanRes };
        printOutput(
          payload,
          asJson,
          `[CoC 7e 檢定] ${checkRes.narrative}${sanRes ? `\n[CoC 7e 理智] ${sanRes.narrative}` : ''}`
        );
      } else if (system === 'pbta') {
        const moveName = (flags.move as string) ?? 'Hack and Slash';
        const statMod = Number(flags.mod ?? 2);
        const danger = Number(flags.danger ?? 3);
        const dummyState = createDefaultEncounter('pbta', seed ?? 42);
        const actor = dummyState.combatants.aria_vanguard;
        const target = dummyState.combatants.cult_archon_boss;
        const pbtaRes = resolvePbtAMove(actor, moveName, statMod, danger, target, '1d8+2', rng);
        printOutput(pbtaRes, asJson, `[PbtA 檢定] ${pbtaRes.narrative}`);
      } else {
        const dc = flags.dc !== undefined ? Number(flags.dc) : undefined;
        if (dc !== undefined) {
          // Generic D&D 5e ability/skill check: 1d20 + mod vs DC (advantage/disadvantage).
          const mode = String(flags.mode ?? 'normal').toLowerCase();
          const dieExpr =
            mode === 'advantage' ? '2d20kh1' : mode === 'disadvantage' ? '2d20kl1' : '1d20';
          const mod = Number(flags.mod ?? 0);
          const roll = rollDice(
            mod !== 0 ? `${dieExpr}${mod >= 0 ? '+' : ''}${mod}` : dieExpr,
            rng
          );
          const success = roll.total >= dc;
          const label = String(flags.label ?? flags.skill ?? 'Ability Check');
          const payload = { system: 'dnd5e', label, mode, dc, roll, success };
          printOutput(
            payload,
            asJson,
            `[D&D 5e 檢定] ${label}: ${roll.details} vs DC ${dc} -> ${success ? '成功 Success' : '失敗 Failure'}`
          );
        } else {
          // Demo resolution: showcase attack math against the default encounter boss.
          const dummyState = createDefaultEncounter('dnd5e', seed ?? 42);
          const attacker = dummyState.combatants.aria_vanguard;
          const defender = dummyState.combatants.cult_archon_boss;
          const atkRes = resolveDnD5eAttack({
            attacker,
            defender,
            action: attacker.actions[0],
            isFlanking: Boolean(flags.flank),
            rng,
          });
          printOutput(atkRes, asJson, `[D&D 5e 攻擊示範] ${atkRes.narrative}`);
        }
      }
      break;
    }

    case 'ai-decide': {
      const statePath = (flags.state as string) ?? DEFAULT_STATE_PATH;
      const state = loadWorldState(statePath);
      const actorId = resolveActorId(state, flags.actor as string | undefined) ?? 'aria_vanguard';
      const temperature = flags.temp !== undefined ? Number(flags.temp) : 0.65;
      const report = evaluateTacticalActions(state, actorId, temperature, rng);

      const top3Text = report.topCandidates
        .map(
          (c, idx) =>
            `  #${idx + 1} [P=${(c.probability * 100).toFixed(1)}%, U=${c.totalUtility.toFixed(2)}] ${c.description} (action-id: ${c.action.id})`
        )
        .join('\n');

      printOutput(
        report,
        asJson,
        `${report.narrativeReasoning}\nTop-3 候選戰術分析:\n${top3Text}`
      );
      break;
    }

    case 'step-turn': {
      const statePath = (flags.state as string) ?? DEFAULT_STATE_PATH;
      const temperature = flags.temp !== undefined ? Number(flags.temp) : 0.65;
      const state = loadWorldState(statePath);
      const actorId = resolveActorId(state, flags.actor as string | undefined);
      const stepRes = stepCombatTurn(
        state,
        actorId,
        temperature,
        flags['action-id'] as string | undefined,
        flags.target as string | undefined
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
          nextActorId: state.initiativeOrder[state.activeActorIndex],
        },
        asJson,
        `[回合推進 Turn ${state.turn - 1}] ${stepRes.eventRecorded.narrativeSummary}`
      );
      break;
    }

    case 'adjust': {
      const statePath = (flags.state as string) ?? DEFAULT_STATE_PATH;
      const state = loadWorldState(statePath);
      const actorId = resolveActorId(state, flags.actor as string | undefined);
      if (!actorId) {
        throw new Error(`adjust needs --actor. Valid ids: ${Object.keys(state.combatants).join(', ')}`);
      }
      const log = adjustCombatant(state, actorId, {
        hp: flags.hp as string | undefined,
        tempHp: parseNum(flags['temp-hp'], 'temp-hp'),
        san: flags.san as string | undefined,
        luck: parseNum(flags.luck, 'luck'),
        addConditions: parseList(flags['add-condition']),
        removeConditions: parseList(flags['remove-condition']),
      });
      saveWorldState(statePath, state);
      printOutput({ status: 'adjusted', actorId, changes: log }, asJson, `[TRPG-CLI] ${actorId}：${log.join('；') || '無變更'}`);
      break;
    }

    case 'fact-set': {
      const statePath = (flags.state as string) ?? DEFAULT_STATE_PATH;
      const subject = (flags.subject as string) ?? 'Unknown_Entity';
      const predicate = (flags.predicate as string) ?? 'state';
      const value = ((flags.value ?? flags.object) as string) ?? 'updated';
      const category = ((flags.category as string) ?? 'location') as FactCategory;

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
          activeFactsCount: queryActiveFacts(state).length,
        },
        asJson,
        `[語義記憶庫更新 Temporal Supersession] 新增事實: (${newFact.subject}, ${newFact.predicate}, "${newFact.value}") [ID: ${newFact.id}]${
          supersededFacts.length > 0
            ? ` | 已自動覆寫並標記失效舊事實 ${supersededFacts.length} 筆 (${supersededFacts.map((f) => `${f.id}:"${f.value}"`).join(', ')})`
            : ''
        }`
      );
      break;
    }

    case 'summary': {
      const statePath = (flags.state as string) ?? DEFAULT_STATE_PATH;
      const state = loadWorldState(statePath);
      const activeFacts = queryActiveFacts(state);
      const supersededFacts = state.semanticFacts.filter((f) => !f.isActive);

      const combatantSummaries = Object.values(state.combatants).map((c) => ({
        id: c.id,
        name: c.name,
        faction: c.faction,
        role: c.role,
        hp: `${c.hp}/${c.maxHp}${c.tempHp ? ` (+${c.tempHp} 臨時)` : ''}`,
        san: `${c.san}/${c.maxSan}`,
        ac: c.ac,
        pos: `(${c.position.x},${c.position.y})`,
        conditions: c.conditions,
        isAlive: c.isAlive,
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
        recentEvents: state.workingMemory.slice(-5).map((e) => e.narrativeSummary),
      };

      const humanLines = [
        `=== 戰役狀態摘要：【${state.campaignName}】(${state.ruleSystem.toUpperCase()}) ===`,
        `回合: Round ${state.round} / Turn ${state.turn} | 下一位行動者: ${state.initiativeOrder[state.activeActorIndex]}`,
        `--- 參戰者狀態 ---`,
        ...combatantSummaries.map(
          (c) =>
            `  [${c.faction.toUpperCase()}] ${c.name} (${c.id}): HP ${c.hp}, SAN ${c.san}, AC ${c.ac}, 座標 ${c.pos}${c.conditions.length ? ` 狀態:[${c.conditions.join(',')}]` : ''}${!c.isAlive ? ' [已陣亡]' : ''}`
        ),
        `--- 有效語義記憶 (Active Semantic Facts: ${activeFacts.length}, 已覆寫歷史事實: ${supersededFacts.length}) ---`,
        ...activeFacts.map((f) => `  * (${f.subject}, ${f.predicate}) => "${f.value}" [Turn ${f.turnCreated}]`),
        `--- 近期工作記憶 (Working Memory: ${state.workingMemory.length}/12) ---`,
        ...state.workingMemory.slice(-4).map((e) => `  [T${e.turn}] ${e.narrativeSummary}`),
      ];

      printOutput(summaryPayload, asJson, humanLines.join('\n'));
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
  console.error(`[TRPG-CLI Error] ${(err as Error).message}`);
  process.exitCode = 1;
}
