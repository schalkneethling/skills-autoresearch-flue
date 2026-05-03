import { mkdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  EvalCasesFile,
  EvalCasesFileSchema,
  ProjectConfig,
  ProjectConfigSchema,
  parseWithSchema
} from "./schemas.js";

export interface ProjectInputs {
  root: string;
  config: ProjectConfig;
  evals: EvalCasesFile;
  rubric: string;
  referenceDir: string;
  baselineDir?: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function loadProject(rootPath: string): Promise<ProjectInputs> {
  const root = resolve(rootPath);
  const configJson = JSON.parse(await readFile(join(root, "config.json"), "utf8")) as unknown;
  const evalCasesJson = JSON.parse(await readFile(join(root, "evals", "eval-cases.json"), "utf8")) as unknown;
  const rubric = await readFile(join(root, "evals", "rubric.md"), "utf8");
  const referenceDir = join(root, "reference");
  const baselineDir = join(root, "workspace", "baseline");

  if (!(await exists(referenceDir))) {
    await mkdir(referenceDir, { recursive: true });
  }

  return {
    root,
    config: parseWithSchema(ProjectConfigSchema, configJson, "config.json"),
    evals: parseWithSchema(EvalCasesFileSchema, evalCasesJson, "eval-cases.json"),
    rubric,
    referenceDir,
    baselineDir: (await exists(baselineDir)) ? baselineDir : undefined
  };
}

export function trackForEval(config: ProjectConfig, evalType: string) {
  const track = config.tracks.find((candidate) => candidate.eval_type === evalType);
  if (!track) {
    throw new Error(`No track configured for eval type "${evalType}"`);
  }
  return track;
}
