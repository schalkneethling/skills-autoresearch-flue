import { join } from "node:path";
import { resolveModel } from "./model.js";
import { trackForEval } from "./project.js";
import { createEvalSandbox, EvalSandbox } from "./sandbox.js";
import { EvalCase, EvalScore, ModelConfig, ProjectConfig, Track } from "./schemas.js";

export interface EvalRunRequest {
  config: ProjectConfig;
  projectRoot: string;
  evalCase: EvalCase;
  baseline: boolean;
  targetSkillDir?: string;
  outputRoot: string;
  model?: Partial<ModelConfig>;
}

export interface EvalAgentRequest {
  evalCase: EvalCase;
  track: Track;
  role: string;
  targetSkill?: string;
  model: ModelConfig;
  sandbox: EvalSandbox;
}

export interface EvalAgent {
  run(request: EvalAgentRequest): Promise<EvalScore>;
}

export async function runEval(request: EvalRunRequest, agent: EvalAgent): Promise<EvalScore> {
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

  return agent.run({
    evalCase: request.evalCase,
    track,
    role,
    targetSkill: request.baseline ? undefined : track.target_skill,
    model,
    sandbox
  });
}

export async function runWithConcurrency<TInput, TOutput>(
  inputs: TInput[],
  limit: number,
  worker: (input: TInput, index: number) => Promise<TOutput>
): Promise<TOutput[]> {
  const results = new Array<TOutput>(inputs.length);
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
