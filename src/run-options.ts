export interface RunOptions {
  projectRoot: string;
  withBaseline: boolean;
  runResearch: boolean;
  forceResearch: boolean;
  resume: boolean;
  withCleanup: boolean;
  seedSkillDir?: string;
  guidanceSkillDir?: string;
  budgetUsd?: number;
}

export type RunOptionInput = Partial<RunOptions>;

export function normalizeRunOptions(input: RunOptionInput, defaultProjectRoot = process.cwd()): RunOptions {
  const options: RunOptions = {
    projectRoot: input.projectRoot ?? defaultProjectRoot,
    withBaseline: input.withBaseline ?? false,
    runResearch: input.runResearch ?? false,
    forceResearch: input.forceResearch ?? false,
    resume: input.resume ?? false,
    withCleanup: input.withCleanup ?? false,
    seedSkillDir: input.seedSkillDir,
    guidanceSkillDir: input.guidanceSkillDir,
    budgetUsd: input.budgetUsd
  };
  if (options.resume && options.withCleanup) {
    throw new Error("Use either --resume or --with-cleanup (either resume or withCleanup), not both.");
  }
  if (options.budgetUsd !== undefined && (!Number.isFinite(options.budgetUsd) || options.budgetUsd < 0)) {
    throw new Error("budgetUsd must be a non-negative number.");
  }
  return options;
}
