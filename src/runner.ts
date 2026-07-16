import { join } from "node:path";
import { ModelRunCostTracker } from "./cost.js";
import { resolveModel } from "./model.js";
import { trackForEval } from "./project.js";
import { createEvalSandbox, EvalSandbox } from "./sandbox.js";
import { EvalCase, EvalScore, ModelConfig, OutputFile, ProjectConfig, RoleModels, Track } from "./schemas.js";

export interface EvalRunRequest {
  config: ProjectConfig;
  projectRoot: string;
  evalCase: EvalCase;
  baseline: boolean;
  targetSkillDir?: string;
  outputRoot: string;
  model?: Partial<ModelConfig>;
  costTracker?: ModelRunCostTracker;
}

export interface EvalAgentRequest {
  evalCase: EvalCase;
  track: Track;
  role: string;
  baseline?: boolean;
  modelRoles?: {
    judge?: string;
  };
  targetSkill?: string;
  model: ModelConfig;
  models?: RoleModels;
  costTracker?: ModelRunCostTracker;
  sandbox: EvalSandbox;
}

export interface EvalAgent {
  run(request: EvalAgentRequest): Promise<EvalScore>;
  judge?(request: EvalAgentRequest, outputFiles: OutputFile[]): Promise<EvalScore>;
}

export async function runEval(request: EvalRunRequest, agent: EvalAgent): Promise<EvalScore> {
  return agent.run(createEvalAgentRequest(request));
}

export async function judgeEval(
  request: EvalRunRequest,
  agent: EvalAgent,
  outputFiles: OutputFile[]
): Promise<EvalScore> {
  if (!agent.judge) {
    throw new Error(
      `Eval agent cannot resume the judge phase for "${request.evalCase.id}". ` +
        "Use a model-backed agent that supports judge-only resume."
    );
  }
  return agent.judge(createEvalAgentRequest(request), outputFiles);
}

function createEvalAgentRequest(request: EvalRunRequest): EvalAgentRequest {
  const track = trackForEval(request.config, request.evalCase.eval_type);
  const model = resolveModel(request.config, request.model);
  const role = track.role;
  const sandbox = createEvalSandbox({
    evalId: request.evalCase.id,
    inputDir: join(request.projectRoot, "input"),
    referenceDir: join(request.projectRoot, "reference"),
    evalsDir: join(request.projectRoot, "evals"),
    outputDir: request.outputRoot,
    skillDir: request.baseline ? undefined : request.targetSkillDir
  });

  return {
    evalCase: request.evalCase,
    track,
    role,
    baseline: request.baseline,
    modelRoles: {
      judge: request.config.roles.judge
    },
    targetSkill: request.baseline ? undefined : track.target_skill,
    model,
    models: request.config.models,
    costTracker: request.costTracker,
    sandbox
  };
}

export async function runWithConcurrency<TInput, TOutput>(
  inputs: TInput[],
  limit: number,
  worker: (input: TInput, index: number) => Promise<TOutput>
): Promise<TOutput[]> {
  const results: TOutput[] = [];
  results.length = inputs.length;
  let cursor = 0;

  async function runNext(): Promise<void> {
    const index = cursor++;
    if (index >= inputs.length) {
      return;
    }
    results[index] = await worker(inputs[index], index);
    await runNext();
  }

  await Promise.all(Array.from({ length: Math.min(limit, inputs.length) }, () => runNext()));
  return results;
}
