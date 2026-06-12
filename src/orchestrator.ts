import { cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { aggregateScores, AggregateReport } from "./aggregate.js";
import { importBaselineArtefacts } from "./baseline.js";
import { createModelCallPreview, ModelRunCostSummary, ModelRunCostTracker, persistCostSummary } from "./cost.js";
import { loadAvailableFlueRoles, validateConfiguredFlueRoles } from "./flue-roles.js";
import { loadProject, ProjectInputs } from "./project.js";
import { runEval, runWithConcurrency, EvalAgent } from "./runner.js";
import { EvalScore } from "./schemas.js";

export type RunEvent =
  | { type: "project-loaded"; root: string }
  | { type: "cost-preview"; summary: ModelRunCostSummary }
  | { type: "baseline-imported"; scores: number; missing: string[] }
  | { type: "baseline-started"; evals: number; countsTowardIterations: false }
  | { type: "baseline-generated"; scores: number }
  | {
      type: "iteration-started";
      iteration: number;
      previousSkillDir: string;
      candidateSkillDir: string;
    }
  | { type: "iteration-generated"; iteration: number; candidateSkillDir: string }
  | { type: "iteration-scored"; iteration: number; scores: number; aggregate: AggregateReport }
  | { type: "baseline-target-score-reached"; normalizedScore: number; targetScore: number }
  | {
      type: "target-score-reached";
      iteration: number;
      normalizedScore: number;
      targetScore: number;
    }
  | {
      type: "target-score-blocked-by-regression";
      iteration: number;
      normalizedScore: number;
      targetScore: number;
      regressions: ScoreRegression[];
    }
  | { type: "max-iterations-reached"; completedIterations: number; maxIterations: number }
  | { type: "research-loop-ready"; completedIterations: number; maxIterations: number }
  | { type: "budget-reached"; budgetUsd: number; actualCostUsd: number; completedIterations: number }
  | { type: "aggregated"; aggregate: AggregateReport };

export interface ScoreRegression {
  evalId: string;
  baselineScore: number;
  candidateScore: number;
}

export interface IterationResult {
  iteration: number;
  skillDir: string;
  scores: EvalScore[];
  aggregate: AggregateReport;
}

export interface OrchestratorResult {
  project: ProjectInputs;
  baselineScores: EvalScore[];
  aggregate: AggregateReport;
  completedIterations: number;
  iterations: IterationResult[];
  bestIteration?: IterationResult;
  cost: ModelRunCostSummary;
  events: RunEvent[];
}

export interface SkillResearchRequest {
  project: ProjectInputs;
  iteration: number;
  previousSkillDir: string;
  candidateSkillDir: string;
  guidanceSkillDir?: string;
  guidanceLedgerPath?: string;
  baselineScores: EvalScore[];
  previousScores: EvalScore[];
  previousAggregate: AggregateReport;
  costTracker?: ModelRunCostTracker;
}

export interface SkillResearcher {
  improve(request: SkillResearchRequest): Promise<void>;
}

export interface OrchestrateOptions {
  projectRoot: string;
  agent?: EvalAgent;
  researcher?: SkillResearcher;
  withBaseline?: boolean;
  runResearch?: boolean;
  forceResearch?: boolean;
  seedSkillDir?: string;
  guidanceSkillDir?: string;
  budgetUsd?: number;
  modelBacked?: boolean;
  onEvent?: (event: RunEvent) => void;
}

export async function orchestrateBaseline(options: OrchestrateOptions): Promise<OrchestratorResult> {
  const events: RunEvent[] = [];
  const emit = createEventSink(events, options.onEvent);
  const project = await loadProject(options.projectRoot);
  emit({ type: "project-loaded", root: project.root });
  validateConfiguredFlueRoles(project.config, await loadAvailableFlueRoles());
  const costTracker = new ModelRunCostTracker(
    createModelCallPreview(project, {
      withBaseline: options.withBaseline,
      runResearch: options.runResearch,
      modelBacked: options.modelBacked
    }),
    options.budgetUsd ?? project.config.budget_usd
  );
  emit({ type: "cost-preview", summary: costTracker.summary() });

  const expectedEvalIds = project.evals.evals.map((evalCase) => evalCase.id);
  const baselineScores = options.withBaseline
    ? await importRequiredBaseline(project, expectedEvalIds, emit)
    : await generateInitialBaseline(project, options.agent, emit, costTracker);

  const aggregate = aggregateScores(project.config, baselineScores);
  emit({ type: "aggregated", aggregate });

  if (
    options.runResearch &&
    !options.forceResearch &&
    aggregate.overall.normalizedScore >= project.config.target_score
  ) {
    emit({
      type: "baseline-target-score-reached",
      normalizedScore: aggregate.overall.normalizedScore,
      targetScore: project.config.target_score
    });
    return finishRun(project, emit, events, costTracker, {
      project,
      baselineScores,
      aggregate,
      completedIterations: 0,
      iterations: []
    });
  }

  emit({
    type: "research-loop-ready",
    completedIterations: 0,
    maxIterations: project.config.max_iterations
  });

  if (!options.runResearch) {
    return finishRun(project, emit, events, costTracker, {
      project,
      baselineScores,
      aggregate,
      completedIterations: 0,
      iterations: []
    });
  }

  const research = await runResearchIterations(project, baselineScores, aggregate, options, emit, costTracker);

  return finishRun(project, emit, events, costTracker, {
    project,
    baselineScores,
    aggregate: research.bestIteration?.aggregate ?? aggregate,
    completedIterations: research.iterations.length,
    iterations: research.iterations,
    bestIteration: research.bestIteration
  });
}

async function importRequiredBaseline(
  project: ProjectInputs,
  expectedEvalIds: string[],
  emit: (event: RunEvent) => void
): Promise<EvalScore[]> {
  if (!project.baselineDir) {
    throw new Error(
      "Run was started with --with-baseline, but workspace/baseline was not found. Remove --with-baseline to generate an initial baseline run."
    );
  }

  const baseline = await importBaselineArtefacts(project.baselineDir, expectedEvalIds);
  emit({
    type: "baseline-imported",
    scores: baseline.scores.length,
    missing: baseline.missing
  });

  const missingScores = expectedEvalIds.filter((evalId) => !baseline.scores.some((score) => score.eval_id === evalId));
  if (missingScores.length > 0 || baseline.missing.length > 0) {
    throw new Error(
      `Run was started with --with-baseline, but baseline artefacts are incomplete. Missing: ${[
        ...missingScores.map((evalId) => `score:${evalId}`),
        ...baseline.missing
      ].join(", ")}`
    );
  }

  return baseline.scores;
}

async function generateInitialBaseline(
  project: ProjectInputs,
  agent: EvalAgent | undefined,
  emit: (event: RunEvent) => void,
  costTracker: ModelRunCostTracker
): Promise<EvalScore[]> {
  if (!agent) {
    throw new Error("No eval agent was provided to generate the initial baseline run");
  }

  emit({
    type: "baseline-started",
    evals: project.evals.evals.length,
    countsTowardIterations: false
  });

  const outputRoot = join(project.root, "workspace", "baseline");
  const baselineScores = await runWithConcurrency(project.evals.evals, project.config.max_concurrency, (evalCase) =>
    runEval(
      {
        config: project.config,
        projectRoot: project.root,
        evalCase,
        baseline: true,
        outputRoot,
        costTracker
      },
      agent
    )
  );
  await persistBaselineScores(project.root, baselineScores);
  emit({ type: "baseline-generated", scores: baselineScores.length });
  return baselineScores;
}

async function persistBaselineScores(projectRoot: string, scores: EvalScore[]): Promise<void> {
  const baselineDir = join(projectRoot, "workspace", "baseline");
  await mkdir(baselineDir, { recursive: true });
  await Promise.all(
    scores.map((score, index) =>
      writeFile(join(baselineDir, `scores-${index}.json`), `${JSON.stringify(score, null, 2)}\n`, {
        flag: "wx"
      })
    )
  );
}

async function runResearchIterations(
  project: ProjectInputs,
  baselineScores: EvalScore[],
  baselineAggregate: AggregateReport,
  options: OrchestrateOptions,
  emit: (event: RunEvent) => void,
  costTracker: ModelRunCostTracker
): Promise<{ iterations: IterationResult[]; bestIteration?: IterationResult }> {
  if (!options.agent) {
    throw new Error("No eval agent was provided to run research iterations");
  }
  if (!options.researcher) {
    throw new Error("No skill researcher was provided to run research iterations");
  }

  const agent = options.agent;
  const seedSkillDir = await resolveSeedSkillDir(project, options.seedSkillDir);
  const guidanceSkillDir = await resolveGuidanceSkillDir(project, options.guidanceSkillDir, seedSkillDir);
  const guidanceLedgerPath = guidanceSkillDir ? join(project.root, "workspace", "guidance-ledger.json") : undefined;
  const iterations: IterationResult[] = [];
  let previousSkillDir = await resolveInitialResearchSkillDir(project, seedSkillDir);
  let previousScores = baselineScores;
  let previousAggregate = baselineAggregate;
  let bestIteration: IterationResult | undefined;
  let reachedTarget = false;

  for (let iteration = 1; iteration <= project.config.max_iterations; iteration++) {
    const iterationDir = join(project.root, "workspace", "iterations", String(iteration));
    const candidateSkillDir = join(iterationDir, "skill");
    await mkdir(iterationDir, { recursive: true });
    emit({ type: "iteration-started", iteration, previousSkillDir, candidateSkillDir });

    await options.researcher.improve({
      project,
      iteration,
      previousSkillDir,
      candidateSkillDir,
      guidanceSkillDir,
      guidanceLedgerPath,
      baselineScores,
      previousScores,
      previousAggregate,
      costTracker
    });
    await assertExists(
      candidateSkillDir,
      `Researcher did not create candidate skill directory for iteration ${iteration}`
    );
    emit({ type: "iteration-generated", iteration, candidateSkillDir });

    if (costTracker.isBudgetReached()) {
      emitBudgetReached(emit, costTracker, iterations.length);
      break;
    }

    const scores = await runWithConcurrency(project.evals.evals, project.config.max_concurrency, (evalCase) =>
      runEval(
        {
          config: project.config,
          projectRoot: project.root,
          evalCase,
          baseline: false,
          targetSkillDir: candidateSkillDir,
          outputRoot: join(iterationDir, "outputs"),
          costTracker
        },
        agent
      )
    );
    await persistIterationScores(iterationDir, scores);

    const aggregate = aggregateScores(project.config, scores);
    await persistAggregate(join(iterationDir, "summary.json"), aggregate);
    const result = { iteration, skillDir: candidateSkillDir, scores, aggregate };
    iterations.push(result);
    emit({ type: "iteration-scored", iteration, scores: scores.length, aggregate });

    if (!bestIteration || aggregate.overall.normalizedScore > bestIteration.aggregate.overall.normalizedScore) {
      bestIteration = result;
    }
    if (aggregate.overall.normalizedScore >= project.config.target_score) {
      const regressions = findScoreRegressions(baselineScores, scores);
      if (regressions.length > 0) {
        emit({
          type: "target-score-blocked-by-regression",
          iteration,
          normalizedScore: aggregate.overall.normalizedScore,
          targetScore: project.config.target_score,
          regressions
        });
      } else {
        emit({
          type: "target-score-reached",
          iteration,
          normalizedScore: aggregate.overall.normalizedScore,
          targetScore: project.config.target_score
        });
        reachedTarget = true;
        break;
      }
    }

    if (costTracker.isBudgetReached()) {
      emitBudgetReached(emit, costTracker, iterations.length);
      break;
    }

    previousSkillDir = candidateSkillDir;
    previousScores = scores;
    previousAggregate = aggregate;
  }

  if (!reachedTarget && iterations.length === project.config.max_iterations) {
    emit({
      type: "max-iterations-reached",
      completedIterations: iterations.length,
      maxIterations: project.config.max_iterations
    });
  }

  return { iterations, bestIteration };
}

function createEventSink(events: RunEvent[], onEvent: OrchestrateOptions["onEvent"]): (event: RunEvent) => void {
  return (event) => {
    events.push(event);
    onEvent?.(event);
  };
}

async function finishRun(
  project: ProjectInputs,
  emit: (event: RunEvent) => void,
  events: RunEvent[],
  costTracker: ModelRunCostTracker,
  result: Omit<OrchestratorResult, "cost" | "events">
): Promise<OrchestratorResult> {
  const cost = costTracker.summary();
  await persistCostSummary(project.root, cost);
  return { ...result, cost, events };
}

function emitBudgetReached(
  emit: (event: RunEvent) => void,
  costTracker: ModelRunCostTracker,
  completedIterations: number
): void {
  if (costTracker.budgetUsd === undefined || costTracker.actualCostUsd === undefined) {
    return;
  }
  emit({
    type: "budget-reached",
    budgetUsd: costTracker.budgetUsd,
    actualCostUsd: costTracker.actualCostUsd,
    completedIterations
  });
}

function findScoreRegressions(baselineScores: EvalScore[], candidateScores: EvalScore[]): ScoreRegression[] {
  const baselineByEval = new Map(baselineScores.map((score) => [score.eval_id, score]));
  return candidateScores
    .map((candidate) => {
      const baseline = baselineByEval.get(candidate.eval_id);
      if (!baseline || candidate.total_score >= baseline.total_score) {
        return undefined;
      }
      return {
        evalId: candidate.eval_id,
        baselineScore: baseline.total_score,
        candidateScore: candidate.total_score
      };
    })
    .filter((regression): regression is ScoreRegression => Boolean(regression));
}

async function resolveSeedSkillDir(project: ProjectInputs, seedSkillDir?: string): Promise<string> {
  const configured = seedSkillDir ?? project.config.origin_skill;
  if (!configured) {
    throw new Error("No seed skill directory was provided. Set origin_skill in config.json or pass seedSkillDir.");
  }
  const resolved = seedSkillDir ? resolve(seedSkillDir) : resolveProjectConfigPath(project, configured);
  await assertExists(resolved, `Seed skill directory was not found: ${resolved}`);
  return resolved;
}

async function resolveGuidanceSkillDir(
  project: ProjectInputs,
  guidanceSkillDir: string | undefined,
  seedSkillDir: string
): Promise<string | undefined> {
  const resolved = resolveConfiguredGuidanceSkillDir(project, guidanceSkillDir, seedSkillDir);
  if (!resolved) {
    return undefined;
  }
  await assertExists(resolved, `Guidance skill directory was not found: ${resolved}`);
  return resolved;
}

function resolveConfiguredGuidanceSkillDir(
  project: ProjectInputs,
  guidanceSkillDir: string | undefined,
  seedSkillDir: string
): string | undefined {
  if (guidanceSkillDir) {
    return resolve(guidanceSkillDir);
  }
  if (project.config.guidance_skill) {
    return resolveProjectConfigPath(project, project.config.guidance_skill);
  }
  return project.config.research_start === "empty" ? seedSkillDir : undefined;
}

async function resolveInitialResearchSkillDir(project: ProjectInputs, seedSkillDir: string): Promise<string> {
  if ((project.config.research_start ?? "seed") !== "empty") {
    return seedSkillDir;
  }

  const emptySkillDir = resolve(project.root, "workspace", "empty-skill");
  await rm(emptySkillDir, { recursive: true, force: true });
  await mkdir(emptySkillDir, { recursive: true });
  return emptySkillDir;
}

function resolveProjectConfigPath(project: ProjectInputs, path: string): string {
  return isAbsolute(path) ? path : resolve(project.root, path);
}

async function assertExists(path: string, message: string): Promise<void> {
  try {
    await stat(path);
  } catch {
    throw new Error(message);
  }
}

async function persistIterationScores(iterationDir: string, scores: EvalScore[]): Promise<void> {
  await Promise.all(
    scores.map((score, index) =>
      writeFile(join(iterationDir, `scores-${index}.json`), `${JSON.stringify(score, null, 2)}\n`, {
        flag: "wx"
      })
    )
  );
}

async function persistAggregate(path: string, aggregate: AggregateReport): Promise<void> {
  await writeFile(path, `${JSON.stringify(aggregate, null, 2)}\n`, { flag: "wx" });
}

export async function copySkillSnapshot(from: string, to: string): Promise<void> {
  await cp(from, to, {
    recursive: true,
    errorOnExist: true,
    force: false
  });
}
