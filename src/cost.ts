import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pricingForModel } from "./pricing.js";
import { ProjectInputs } from "./project.js";
import { ModelConfig } from "./schemas.js";

export type ModelCallRole =
  | "baseline_producer"
  | "baseline_judge"
  | "researcher"
  | "iteration_producer"
  | "iteration_judge";

export type ModelCallCounts = Record<ModelCallRole, number>;

export interface ModelCallPreview {
  evalCount: number;
  maxIterations: number;
  maxConcurrency: number;
  withBaseline: boolean;
  runResearch: boolean;
  modelBacked: boolean;
  calls: ModelCallCounts;
  totalCalls: number;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export interface ModelUsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export type ModelUsageByRole = Record<ModelCallRole, ModelUsageSummary>;

export interface ModelCallRecord {
  role: ModelCallRole;
  phase?: string;
  model: ModelConfig;
  usage?: ModelUsage;
  costUsd?: number;
}

export interface ModelRunCostSummary {
  budgetUsd?: number;
  planned: ModelCallPreview;
  actual: {
    calls: ModelCallCounts;
    totalCalls: number;
    usageByRole: ModelUsageByRole;
    totalUsage: ModelUsageSummary;
    costUsd?: number;
    records: ModelCallRecord[];
  };
}

export class BudgetExceededError extends Error {
  constructor(
    readonly budgetUsd: number,
    readonly actualCostUsd: number
  ) {
    super(`Model budget reached: observed $${actualCostUsd.toFixed(4)} >= configured budget $${budgetUsd.toFixed(4)}`);
  }
}

export const MODEL_CALL_ROLES: readonly ModelCallRole[] = [
  "baseline_producer",
  "baseline_judge",
  "researcher",
  "iteration_producer",
  "iteration_judge"
];

const EMPTY_USAGE: ModelUsageSummary = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0
};

export function createModelCallPreview(
  project: ProjectInputs,
  options: { withBaseline?: boolean; runResearch?: boolean; modelBacked?: boolean }
): ModelCallPreview {
  const evalCount = project.evals.evals.length;
  const maxIterations = project.config.max_iterations;
  const modelBacked = options.modelBacked ?? true;
  const calls = emptyCallCounts();

  if (modelBacked) {
    if (!options.withBaseline) {
      calls.baseline_producer = evalCount;
      calls.baseline_judge = evalCount;
    }
    if (options.runResearch) {
      calls.researcher = maxIterations;
      calls.iteration_producer = evalCount * maxIterations;
      calls.iteration_judge = evalCount * maxIterations;
    }
  }

  return {
    evalCount,
    maxIterations,
    maxConcurrency: project.config.max_concurrency,
    withBaseline: options.withBaseline ?? false,
    runResearch: options.runResearch ?? false,
    modelBacked,
    calls,
    totalCalls: sumCalls(calls)
  };
}

export class ModelRunCostTracker {
  readonly #budgetUsd: number | undefined;
  readonly #planned: ModelCallPreview;
  readonly #calls = emptyCallCounts();
  readonly #usageByRole = emptyUsageByRole();
  readonly #records: ModelCallRecord[] = [];
  #costUsd: number | undefined;

  constructor(planned: ModelCallPreview, budgetUsd?: number) {
    this.#planned = planned;
    this.#budgetUsd = budgetUsd;
  }

  get budgetUsd(): number | undefined {
    return this.#budgetUsd;
  }

  get planned(): ModelCallPreview {
    return this.#planned;
  }

  get actualCostUsd(): number | undefined {
    return this.#costUsd;
  }

  assertCanStartModelCall(): void {
    if (this.#budgetUsd === undefined || this.#costUsd === undefined) {
      return;
    }
    if (this.#costUsd >= this.#budgetUsd) {
      throw new BudgetExceededError(this.#budgetUsd, this.#costUsd);
    }
  }

  isBudgetReached(): boolean {
    return this.#budgetUsd !== undefined && this.#costUsd !== undefined && this.#costUsd >= this.#budgetUsd;
  }

  recordModelCall(record: ModelCallRecord): void {
    this.#calls[record.role]++;
    addUsage(this.#usageByRole[record.role], record.usage);
    const costUsd = record.costUsd ?? estimateUsageCostUsd(record.model, record.usage);
    if (costUsd !== undefined) {
      this.#costUsd = (this.#costUsd ?? 0) + costUsd;
    }
    this.#records.push({ ...record, costUsd });
  }

  summary(): ModelRunCostSummary {
    const usageByRole = cloneUsageByRole(this.#usageByRole);
    return {
      ...(this.#budgetUsd === undefined ? {} : { budgetUsd: this.#budgetUsd }),
      planned: this.#planned,
      actual: {
        calls: { ...this.#calls },
        totalCalls: sumCalls(this.#calls),
        usageByRole,
        totalUsage: totalUsage(usageByRole),
        ...(this.#costUsd === undefined ? {} : { costUsd: this.#costUsd }),
        records: this.#records.map((record) => ({
          ...record,
          usage: record.usage ? { ...record.usage } : undefined
        }))
      }
    };
  }
}

export async function persistCostSummary(projectRoot: string, summary: ModelRunCostSummary): Promise<void> {
  const workspaceDir = join(projectRoot, "workspace");
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(join(workspaceDir, "cost-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
}

export function formatCallCounts(counts: ModelCallCounts): string {
  return MODEL_CALL_ROLES.map((role) => `${role}: ${counts[role]}`).join(", ");
}

export function estimateUsageCostUsd(model: ModelConfig, usage: ModelUsage | undefined): number | undefined {
  if (!usage || model.provider !== "anthropic") {
    return undefined;
  }
  const pricing = pricingForModel(model);
  if (!pricing) {
    return undefined;
  }
  return (
    ((usage.inputTokens ?? 0) * pricing.inputUsdPerMillion +
      (usage.outputTokens ?? 0) * pricing.outputUsdPerMillion +
      (usage.cacheCreationInputTokens ?? 0) * pricing.cacheCreationUsdPerMillion +
      (usage.cacheReadInputTokens ?? 0) * pricing.cacheReadUsdPerMillion) /
    1_000_000
  );
}

function emptyCallCounts(): ModelCallCounts {
  return {
    baseline_producer: 0,
    baseline_judge: 0,
    researcher: 0,
    iteration_producer: 0,
    iteration_judge: 0
  };
}

function emptyUsageByRole(): ModelUsageByRole {
  return {
    baseline_producer: { ...EMPTY_USAGE },
    baseline_judge: { ...EMPTY_USAGE },
    researcher: { ...EMPTY_USAGE },
    iteration_producer: { ...EMPTY_USAGE },
    iteration_judge: { ...EMPTY_USAGE }
  };
}

function addUsage(target: ModelUsageSummary, usage: ModelUsage | undefined): void {
  if (!usage) {
    return;
  }
  target.inputTokens += usage.inputTokens ?? 0;
  target.outputTokens += usage.outputTokens ?? 0;
  target.cacheCreationInputTokens += usage.cacheCreationInputTokens ?? 0;
  target.cacheReadInputTokens += usage.cacheReadInputTokens ?? 0;
}

function cloneUsageByRole(usageByRole: ModelUsageByRole): ModelUsageByRole {
  return {
    baseline_producer: { ...usageByRole.baseline_producer },
    baseline_judge: { ...usageByRole.baseline_judge },
    researcher: { ...usageByRole.researcher },
    iteration_producer: { ...usageByRole.iteration_producer },
    iteration_judge: { ...usageByRole.iteration_judge }
  };
}

function totalUsage(usageByRole: ModelUsageByRole): ModelUsageSummary {
  const summary = { ...EMPTY_USAGE };
  for (const role of MODEL_CALL_ROLES) {
    addUsage(summary, usageByRole[role]);
  }
  return summary;
}

function sumCalls(counts: ModelCallCounts): number {
  return MODEL_CALL_ROLES.reduce((sum, role) => sum + counts[role], 0);
}
