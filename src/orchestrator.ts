import { cp, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { aggregateScores, AggregateReport } from "./aggregate.js";
import { importBaselineArtefacts } from "./baseline.js";
import { createModelCallPreview, ModelRunCostSummary, ModelRunCostTracker, persistCostSummary } from "./cost.js";
import { loadAvailableFlueRoles, validateConfiguredFlueRoles } from "./flue-roles.js";
import { loadProject, ProjectInputs, trackForEval } from "./project.js";
import {
  findUnexpectedScoreFiles,
  inspectProducerArtifact,
  inspectJudgeArtifact,
  inspectResearchArtifact,
  inspectScoreArtifact,
  inspectSummaryArtifact
} from "./resume.js";
import { judgeEval, runEval, runWithConcurrency, EvalAgent } from "./runner.js";
import { EvalScore } from "./schemas.js";

export type RunEvent =
  | { type: "project-loaded"; root: string }
  | { type: "cost-preview"; summary: ModelRunCostSummary }
  | { type: "baseline-imported"; scores: number; missing: string[] }
  | { type: "baseline-started"; evals: number; countsTowardIterations: false }
  | { type: "baseline-generated"; scores: number }
  | { type: "baseline-resumed"; scores: number; remaining: number }
  | {
      type: "iteration-started";
      iteration: number;
      previousSkillDir: string;
      candidateSkillDir: string;
    }
  | { type: "iteration-generated"; iteration: number; candidateSkillDir: string }
  | { type: "iteration-research-resumed"; iteration: number; candidateSkillDir: string }
  | { type: "eval-score-resumed"; iteration: number; evalId: string }
  | { type: "eval-producer-resumed"; iteration: number; evalId: string }
  | { type: "eval-judge-resumed"; iteration: number; evalId: string }
  | { type: "iteration-summary-rebuilt"; iteration: number }
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
  resume?: boolean;
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
    : options.resume
      ? await resumeInitialBaseline(project, options.agent, emit, costTracker)
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
  const baselineScores = await runWithConcurrency(
    project.evals.evals,
    project.config.max_concurrency,
    async (evalCase, index) => {
      const score = await runEval(
        {
          config: project.config,
          projectRoot: project.root,
          evalCase,
          baseline: true,
          outputRoot,
          costTracker
        },
        agent
      );
      await persistEvalScore(outputRoot, index, score);
      return score;
    }
  );
  emit({ type: "baseline-generated", scores: baselineScores.length });
  return baselineScores;
}

async function resumeInitialBaseline(
  project: ProjectInputs,
  agent: EvalAgent | undefined,
  emit: (event: RunEvent) => void,
  costTracker: ModelRunCostTracker
): Promise<EvalScore[]> {
  const baselineDir = join(project.root, "workspace", "baseline");
  await assertNoUnexpectedScores(baselineDir, project.evals.evals.length);
  const existing = await inspectConfiguredScores(project, baselineDir, baselineDir);
  const remaining = existing.filter((score) => score === undefined).length;
  emit({
    type: "baseline-resumed",
    scores: existing.length - remaining,
    remaining
  });

  const outputRoot = baselineDir;
  const scores = await runWithConcurrency(
    project.evals.evals,
    project.config.max_concurrency,
    async (evalCase, index) => {
      const reused = existing[index];
      if (reused) {
        return reused;
      }
      const request = {
        config: project.config,
        projectRoot: project.root,
        evalCase,
        baseline: true,
        outputRoot,
        costTracker
      };
      const evalOutputDir = join(outputRoot, evalCase.id);
      const track = trackForEval(project.config, evalCase.eval_type);
      const judgeArtifact = await inspectJudgeArtifact(evalOutputDir, evalCase, track);
      if (judgeArtifact.status === "invalid" || judgeArtifact.status === "incomplete") {
        throw new Error(`Cannot resume baseline judge for eval "${evalCase.id}": ${judgeArtifact.reason}`);
      }
      if (judgeArtifact.status === "complete") {
        await persistEvalScore(outputRoot, index, judgeArtifact.value.score);
        return judgeArtifact.value.score;
      }

      const producerArtifact = await inspectProducerArtifact(evalOutputDir, evalCase.id);
      if (producerArtifact.status === "invalid") {
        throw new Error(`Cannot resume baseline producer for eval "${evalCase.id}": ${producerArtifact.reason}`);
      }
      if (!agent) {
        throw new Error("No eval agent was provided to resume the incomplete baseline run");
      }
      if (
        producerArtifact.status === "incomplete" ||
        (producerArtifact.status === "absent" && (await pathExists(evalOutputDir)))
      ) {
        await archiveIncompleteArtifact(project.root, evalOutputDir, `baseline-${evalCase.id}-producer`);
      }
      const score =
        producerArtifact.status === "complete"
          ? await judgeEval(request, agent, producerArtifact.value.outputFiles)
          : await runEval(request, agent);
      await persistEvalScore(outputRoot, index, score);
      return score;
    }
  );
  if (remaining > 0) {
    emit({ type: "baseline-generated", scores: scores.length });
  }
  return scores;
}

async function runResearchIterations(
  project: ProjectInputs,
  baselineScores: EvalScore[],
  baselineAggregate: AggregateReport,
  options: OrchestrateOptions,
  emit: (event: RunEvent) => void,
  costTracker: ModelRunCostTracker
): Promise<{ iterations: IterationResult[]; bestIteration?: IterationResult }> {
  const agent = options.agent;
  const seedSkillDir = await resolveSeedSkillDir(project, options.seedSkillDir);
  const guidanceSkillDir = await resolveGuidanceSkillDir(project, options.guidanceSkillDir, seedSkillDir);
  const guidanceLedgerPath = guidanceSkillDir ? join(project.root, "workspace", "guidance-ledger.json") : undefined;
  const iterations: IterationResult[] = [];
  let previousSkillDir = resolveInitialResearchSkillDir(project, seedSkillDir);
  let previousScores = baselineScores;
  let previousAggregate = baselineAggregate;
  let bestIteration: IterationResult | undefined;
  let reachedTarget = false;

  for (let iteration = 1; iteration <= project.config.max_iterations; iteration++) {
    const iterationDir = join(project.root, "workspace", "iterations", String(iteration));
    const candidateSkillDir = join(iterationDir, "skill");
    await mkdir(iterationDir, { recursive: true });
    emit({ type: "iteration-started", iteration, previousSkillDir, candidateSkillDir });

    if (options.resume) {
      const researchArtifact = await inspectResearchArtifact(candidateSkillDir, iteration);
      if (researchArtifact.status === "invalid") {
        throw new Error(`Cannot resume iteration ${iteration} research: ${researchArtifact.reason}`);
      }
      if (researchArtifact.status === "complete") {
        emit({ type: "iteration-research-resumed", iteration, candidateSkillDir });
      } else {
        await assertNoIterationEvaluationArtifacts(iterationDir, iteration);
        await assertNoFutureIterationArtifacts(project.root, iteration);
        if (!options.researcher) {
          throw new Error("No skill researcher was provided to resume the incomplete research run");
        }
        if (researchArtifact.status === "incomplete") {
          await archiveIncompleteArtifact(project.root, candidateSkillDir, `iteration-${iteration}-research`);
        }
        if (iteration === 1) {
          previousSkillDir = await prepareInitialResearchSkillDir(project, seedSkillDir);
        }
        await improveSkill(
          options.researcher,
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
        );
        emit({ type: "iteration-generated", iteration, candidateSkillDir });
      }
    } else {
      if (!options.researcher) {
        throw new Error("No skill researcher was provided to run research iterations");
      }
      if (iteration === 1) {
        previousSkillDir = await prepareInitialResearchSkillDir(project, seedSkillDir);
      }
      await improveSkill(
        options.researcher,
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
      );
      emit({ type: "iteration-generated", iteration, candidateSkillDir });
    }

    if (costTracker.isBudgetReached()) {
      emitBudgetReached(emit, costTracker, iterations.length);
      break;
    }

    const scores = options.resume
      ? await resumeIterationScores(project, iteration, iterationDir, candidateSkillDir, agent, emit, costTracker)
      : await runFreshIterationScores(
          project,
          iterationDir,
          candidateSkillDir,
          requireEvalAgent(agent, "run research iterations"),
          costTracker
        );

    const aggregate = aggregateScores(project.config, scores);
    const summaryPath = join(iterationDir, "summary.json");
    if (options.resume) {
      const summary = await inspectSummaryArtifact(summaryPath, aggregate);
      if (summary.status === "invalid") {
        throw new Error(`Cannot resume iteration ${iteration} summary: ${summary.reason}`);
      }
      if (summary.status === "absent") {
        await persistAggregate(summaryPath, aggregate);
        emit({ type: "iteration-summary-rebuilt", iteration });
      }
    } else {
      await persistAggregate(summaryPath, aggregate);
    }
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

async function improveSkill(
  researcher: SkillResearcher,
  project: ProjectInputs,
  iteration: number,
  previousSkillDir: string,
  candidateSkillDir: string,
  guidanceSkillDir: string | undefined,
  guidanceLedgerPath: string | undefined,
  baselineScores: EvalScore[],
  previousScores: EvalScore[],
  previousAggregate: AggregateReport,
  costTracker: ModelRunCostTracker
): Promise<void> {
  await researcher.improve({
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
}

async function runFreshIterationScores(
  project: ProjectInputs,
  iterationDir: string,
  candidateSkillDir: string,
  agent: EvalAgent,
  costTracker: ModelRunCostTracker
): Promise<EvalScore[]> {
  return runWithConcurrency(project.evals.evals, project.config.max_concurrency, async (evalCase, index) => {
    const score = await runEval(
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
    );
    await persistEvalScore(iterationDir, index, score);
    return score;
  });
}

async function resumeIterationScores(
  project: ProjectInputs,
  iteration: number,
  iterationDir: string,
  candidateSkillDir: string,
  agent: EvalAgent | undefined,
  emit: (event: RunEvent) => void,
  costTracker: ModelRunCostTracker
): Promise<EvalScore[]> {
  await assertNoUnexpectedScores(iterationDir, project.evals.evals.length);
  const outputRoot = join(iterationDir, "outputs");
  const existing = await inspectConfiguredScores(project, iterationDir, outputRoot);

  return runWithConcurrency(project.evals.evals, project.config.max_concurrency, async (evalCase, index) => {
    const reused = existing[index];
    if (reused) {
      emit({ type: "eval-score-resumed", iteration, evalId: evalCase.id });
      return reused;
    }

    const evalOutputDir = join(outputRoot, evalCase.id);
    const track = trackForEval(project.config, evalCase.eval_type);
    const judgeArtifact = await inspectJudgeArtifact(evalOutputDir, evalCase, track);
    if (judgeArtifact.status === "invalid" || judgeArtifact.status === "incomplete") {
      throw new Error(`Cannot resume iteration ${iteration} judge for eval "${evalCase.id}": ${judgeArtifact.reason}`);
    }
    if (judgeArtifact.status === "complete") {
      emit({ type: "eval-judge-resumed", iteration, evalId: evalCase.id });
      await persistEvalScore(iterationDir, index, judgeArtifact.value.score);
      return judgeArtifact.value.score;
    }

    const producerArtifact = await inspectProducerArtifact(evalOutputDir, evalCase.id);
    if (producerArtifact.status === "invalid") {
      throw new Error(
        `Cannot resume iteration ${iteration} producer for eval "${evalCase.id}": ${producerArtifact.reason}`
      );
    }
    if (!agent) {
      throw new Error("No eval agent was provided to resume the incomplete research run");
    }
    if (
      producerArtifact.status === "incomplete" ||
      (producerArtifact.status === "absent" && (await pathExists(evalOutputDir)))
    ) {
      await archiveIncompleteArtifact(project.root, evalOutputDir, `iteration-${iteration}-${evalCase.id}-producer`);
    }

    const request = {
      config: project.config,
      projectRoot: project.root,
      evalCase,
      baseline: false,
      targetSkillDir: candidateSkillDir,
      outputRoot,
      costTracker
    };
    const score =
      producerArtifact.status === "complete"
        ? await judgeEval(request, agent, producerArtifact.value.outputFiles)
        : await runEval(request, agent);
    if (producerArtifact.status === "complete") {
      emit({ type: "eval-producer-resumed", iteration, evalId: evalCase.id });
    }
    await persistEvalScore(iterationDir, index, score);
    return score;
  });
}

async function inspectConfiguredScores(
  project: ProjectInputs,
  directory: string,
  outputRoot: string
): Promise<Array<EvalScore | undefined>> {
  return Promise.all(
    project.evals.evals.map(async (evalCase, index) => {
      const artifact = await inspectScoreArtifact({
        directory,
        index,
        evalCase,
        track: trackForEval(project.config, evalCase.eval_type)
      });
      if (artifact.status === "invalid") {
        throw new Error(`Cannot resume score ${index} for eval "${evalCase.id}": ${artifact.reason}`);
      }
      if (artifact.status !== "complete") {
        return undefined;
      }

      const judgeArtifact = await inspectJudgeArtifact(
        join(outputRoot, evalCase.id),
        evalCase,
        trackForEval(project.config, evalCase.eval_type)
      );
      if (judgeArtifact.status === "invalid" || judgeArtifact.status === "incomplete") {
        throw new Error(`Cannot reconcile score ${index} for eval "${evalCase.id}": ${judgeArtifact.reason}`);
      }
      if (judgeArtifact.status === "complete" && !isDeepStrictEqual(artifact.value, judgeArtifact.value.score)) {
        throw new Error(
          `Cannot resume score ${index} for eval "${evalCase.id}": persisted score does not match judge transcript`
        );
      }
      return artifact.value;
    })
  );
}

function requireEvalAgent(agent: EvalAgent | undefined, action: string): EvalAgent {
  if (!agent) {
    throw new Error(`No eval agent was provided to ${action}`);
  }
  return agent;
}

async function assertNoUnexpectedScores(directory: string, expectedCount: number): Promise<void> {
  const unexpected = await findUnexpectedScoreFiles(directory, expectedCount);
  if (unexpected.length > 0) {
    throw new Error(
      `Cannot resume because unexpected positional score artifacts were found in ${directory}: ${unexpected.join(", ")}`
    );
  }
}

async function assertNoIterationEvaluationArtifacts(iterationDir: string, iteration: number): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(iterationDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  const conflicts = entries.filter(
    (entry) => /^scores-\d+\.json$/.test(entry) || entry === "summary.json" || entry === "outputs"
  );
  if (conflicts.length > 0) {
    throw new Error(
      `Cannot resume iteration ${iteration}: evaluation artifacts exist without completed research: ${conflicts.join(", ")}`
    );
  }
}

async function assertNoFutureIterationArtifacts(projectRoot: string, currentIteration: number): Promise<void> {
  const iterationsDir = join(projectRoot, "workspace", "iterations");
  let entries: string[];
  try {
    entries = await readdir(iterationsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  const future = entries
    .filter((entry) => /^\d+$/.test(entry) && Number(entry) > currentIteration)
    .sort((left, right) => Number(left) - Number(right));
  if (future.length > 0) {
    throw new Error(
      `Cannot resume iteration ${currentIteration}: later iteration artifacts already exist: ${future.join(", ")}`
    );
  }
}

async function archiveIncompleteArtifact(projectRoot: string, source: string, label: string): Promise<void> {
  if (!(await pathExists(source))) {
    return;
  }
  const backupRoot = join(projectRoot, "workspace", "resume-backups");
  await mkdir(backupRoot, { recursive: true });
  let destination = join(backupRoot, label);
  let suffix = 2;
  while (await pathExists(destination)) {
    destination = join(backupRoot, `${label}-${suffix++}`);
  }
  await rename(source, destination);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
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

function resolveInitialResearchSkillDir(project: ProjectInputs, seedSkillDir: string): string {
  if ((project.config.research_start ?? "seed") !== "empty") {
    return seedSkillDir;
  }

  return resolve(project.root, "workspace", "empty-skill");
}

async function prepareInitialResearchSkillDir(project: ProjectInputs, seedSkillDir: string): Promise<string> {
  const initialSkillDir = resolveInitialResearchSkillDir(project, seedSkillDir);
  if ((project.config.research_start ?? "seed") !== "empty") {
    return initialSkillDir;
  }

  const emptySkillDir = initialSkillDir;
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

async function persistEvalScore(dir: string, index: number, score: EvalScore): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `scores-${index}.json`), `${JSON.stringify(score, null, 2)}\n`, {
    flag: "wx"
  });
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
