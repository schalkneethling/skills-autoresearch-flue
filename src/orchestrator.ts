import { cp, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { aggregateScores, AggregateReport } from "./aggregate.js";
import { importBaselineArtefacts } from "./baseline.js";
import { loadProject, ProjectInputs } from "./project.js";
import { runEval, runWithConcurrency, EvalAgent } from "./runner.js";
import { EvalScore } from "./schemas.js";

export type RunEvent =
  | { type: "project-loaded"; root: string }
  | { type: "baseline-imported"; scores: number; missing: string[] }
  | { type: "baseline-started"; evals: number; countsTowardIterations: false }
  | { type: "baseline-generated"; scores: number }
  | { type: "iteration-started"; iteration: number; previousSkillDir: string; candidateSkillDir: string }
  | { type: "iteration-generated"; iteration: number; candidateSkillDir: string }
  | { type: "iteration-scored"; iteration: number; scores: number; aggregate: AggregateReport }
  | { type: "target-score-reached"; iteration: number; normalizedScore: number; targetScore: number }
  | { type: "max-iterations-reached"; completedIterations: number; maxIterations: number }
  | { type: "research-loop-ready"; completedIterations: number; maxIterations: number }
  | { type: "aggregated"; aggregate: AggregateReport };

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
  events: RunEvent[];
}

export interface SkillResearchRequest {
  project: ProjectInputs;
  iteration: number;
  previousSkillDir: string;
  candidateSkillDir: string;
  baselineScores: EvalScore[];
  previousScores: EvalScore[];
  previousAggregate: AggregateReport;
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
  seedSkillDir?: string;
}

export async function orchestrateBaseline(options: OrchestrateOptions): Promise<OrchestratorResult> {
  const events: RunEvent[] = [];
  const project = await loadProject(options.projectRoot);
  events.push({ type: "project-loaded", root: project.root });

  const expectedEvalIds = project.evals.evals.map((evalCase) => evalCase.id);
  const baselineScores = options.withBaseline
    ? await importRequiredBaseline(project, expectedEvalIds, events)
    : await generateInitialBaseline(project, options.agent, events);

  const aggregate = aggregateScores(project.config, baselineScores);
  events.push({ type: "aggregated", aggregate });
  events.push({
    type: "research-loop-ready",
    completedIterations: 0,
    maxIterations: project.config.max_iterations
  });

  if (!options.runResearch) {
    return { project, baselineScores, aggregate, completedIterations: 0, iterations: [], events };
  }

  const research = await runResearchIterations(project, baselineScores, aggregate, options, events);

  return {
    project,
    baselineScores,
    aggregate: research.bestIteration?.aggregate ?? aggregate,
    completedIterations: research.iterations.length,
    iterations: research.iterations,
    bestIteration: research.bestIteration,
    events
  };
}

async function importRequiredBaseline(
  project: ProjectInputs,
  expectedEvalIds: string[],
  events: RunEvent[]
): Promise<EvalScore[]> {
  if (!project.baselineDir) {
    throw new Error(
      "Run was started with --with-baseline, but workspace/baseline was not found. Remove --with-baseline to generate an initial baseline run."
    );
  }

  const baseline = await importBaselineArtefacts(project.baselineDir, expectedEvalIds);
  events.push({ type: "baseline-imported", scores: baseline.scores.length, missing: baseline.missing });

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
  events: RunEvent[]
): Promise<EvalScore[]> {
  if (!agent) {
    throw new Error("No eval agent was provided to generate the initial baseline run");
  }

  events.push({
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
        outputRoot
      },
      agent
    )
  );
  await persistBaselineScores(project.root, baselineScores);
  events.push({ type: "baseline-generated", scores: baselineScores.length });
  return baselineScores;
}

async function persistBaselineScores(projectRoot: string, scores: EvalScore[]): Promise<void> {
  const baselineDir = join(projectRoot, "workspace", "baseline");
  await mkdir(baselineDir, { recursive: true });
  await Promise.all(
    scores.map((score, index) =>
      writeFile(join(baselineDir, `scores-${index}.json`), `${JSON.stringify(score, null, 2)}\n`, { flag: "wx" })
    )
  );
}

async function runResearchIterations(
  project: ProjectInputs,
  baselineScores: EvalScore[],
  baselineAggregate: AggregateReport,
  options: OrchestrateOptions,
  events: RunEvent[]
): Promise<{ iterations: IterationResult[]; bestIteration?: IterationResult }> {
  if (!options.agent) {
    throw new Error("No eval agent was provided to run research iterations");
  }
  if (!options.researcher) {
    throw new Error("No skill researcher was provided to run research iterations");
  }

  const agent = options.agent;
  const seedSkillDir = await resolveSeedSkillDir(project, options.seedSkillDir);
  const iterations: IterationResult[] = [];
  let previousSkillDir = seedSkillDir;
  let previousScores = baselineScores;
  let previousAggregate = baselineAggregate;
  let bestIteration: IterationResult | undefined;
  let reachedTarget = false;

  for (let iteration = 1; iteration <= project.config.max_iterations; iteration++) {
    const iterationDir = join(project.root, "workspace", "iterations", String(iteration));
    const candidateSkillDir = join(iterationDir, "skill");
    await mkdir(iterationDir, { recursive: true });
    events.push({ type: "iteration-started", iteration, previousSkillDir, candidateSkillDir });

    await options.researcher.improve({
      project,
      iteration,
      previousSkillDir,
      candidateSkillDir,
      baselineScores,
      previousScores,
      previousAggregate
    });
    await assertExists(
      candidateSkillDir,
      `Researcher did not create candidate skill directory for iteration ${iteration}`
    );
    events.push({ type: "iteration-generated", iteration, candidateSkillDir });

    const scores = await runWithConcurrency(project.evals.evals, project.config.max_concurrency, (evalCase) =>
      runEval(
        {
          config: project.config,
          projectRoot: project.root,
          evalCase,
          baseline: false,
          targetSkillDir: candidateSkillDir,
          outputRoot: join(iterationDir, "outputs")
        },
        agent
      )
    );
    await persistIterationScores(iterationDir, scores);

    const aggregate = aggregateScores(project.config, scores);
    await persistAggregate(join(iterationDir, "summary.json"), aggregate);
    const result = { iteration, skillDir: candidateSkillDir, scores, aggregate };
    iterations.push(result);
    events.push({ type: "iteration-scored", iteration, scores: scores.length, aggregate });

    if (!bestIteration || aggregate.overall.normalizedScore > bestIteration.aggregate.overall.normalizedScore) {
      bestIteration = result;
    }
    if (aggregate.overall.normalizedScore >= project.config.target_score) {
      events.push({
        type: "target-score-reached",
        iteration,
        normalizedScore: aggregate.overall.normalizedScore,
        targetScore: project.config.target_score
      });
      reachedTarget = true;
      break;
    }

    previousSkillDir = candidateSkillDir;
    previousScores = scores;
    previousAggregate = aggregate;
  }

  if (!reachedTarget && iterations.length === project.config.max_iterations) {
    events.push({
      type: "max-iterations-reached",
      completedIterations: iterations.length,
      maxIterations: project.config.max_iterations
    });
  }

  return { iterations, bestIteration };
}

async function resolveSeedSkillDir(project: ProjectInputs, seedSkillDir?: string): Promise<string> {
  const resolved = seedSkillDir ?? project.config.origin_skill;
  if (!resolved) {
    throw new Error("No seed skill directory was provided. Set origin_skill in config.json or pass seedSkillDir.");
  }
  await assertExists(resolved, `Seed skill directory was not found: ${resolved}`);
  return resolved;
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
      writeFile(join(iterationDir, `scores-${index}.json`), `${JSON.stringify(score, null, 2)}\n`, { flag: "wx" })
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
