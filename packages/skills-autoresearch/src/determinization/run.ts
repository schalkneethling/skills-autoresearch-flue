import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { estimateUsageCostUsd, type ModelUsage } from "../cost.js";
import { resolveBundledCatalogRoot } from "../package-resources.js";
import { GENERATED_SKILL_FILES, projectLayout } from "../project-layout.js";
import { ProjectConfigSchema, parseWithSchema, type ModelConfig, type ProjectConfig } from "../schemas.js";
import { buildDeterminizationAnalysisPrompt } from "./analysis-prompt.js";
import { compareCodePoints } from "./canonical.js";
import {
  assertAnalysisArtifactBoundary,
  resumeAnalysisArtifacts,
  writeAnalysisArtifacts,
  type AnalysisArtifactResult
} from "./artifacts.js";
import { loadDeterministicAssetCatalog } from "./catalog.js";
import { createSourceManifest, MAX_DETERMINIZATION_SOURCE_FILE_BYTES, type SourceSelection } from "./source.js";
import type { DeterminizationTransport } from "./transport.js";

const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const CATALOG_FILES = ["catalog.json", "javascript-typescript.json", "language.json", "markdown.json"];
const DETERMINIZER_SYSTEM_PROMPT = "You are the read-only determinizer for an agent-skill evaluation harness.";

export interface RunDeterminizationReportOptions {
  projectRoot: string;
  transport: DeterminizationTransport;
  skillDir?: string;
  contextRoot?: string;
  catalogRoot?: string;
  outputRoot?: string;
  modelOverride?: ModelConfig;
}

export type ResumeDeterminizationReportOptions = Omit<RunDeterminizationReportOptions, "transport" | "modelOverride">;

export interface DeterminizationRunCost {
  plannedCalls: number;
  actualCalls: number;
  model: ModelConfig;
  usage?: ModelUsage;
  costUsd?: number;
}

export interface DeterminizationReportResult extends AnalysisArtifactResult {
  selectedSkillDir: string;
  selectedSkillSource: "explicit" | "best_iteration" | "origin_skill";
  cost: DeterminizationRunCost;
}

interface SelectedSkill {
  dir: string;
  source: DeterminizationReportResult["selectedSkillSource"];
}

interface PreparedInputs {
  selections: SourceSelection[];
  files: Array<{ path: string; contents: string }>;
}

function buildAnalysisRequest(
  prepared: PreparedInputs,
  catalog: Awaited<ReturnType<typeof loadDeterministicAssetCatalog>>,
  model: ModelConfig
) {
  return {
    system: DETERMINIZER_SYSTEM_PROMPT,
    prompt: buildDeterminizationAnalysisPrompt({ files: prepared.files, catalog }),
    model
  };
}

async function readConfig(projectRoot: string): Promise<ProjectConfig> {
  const value = JSON.parse(await readFile(join(projectRoot, "config.json"), "utf8")) as unknown;
  return parseWithSchema(ProjectConfigSchema, value, "config.json");
}

export function resolveDeterminizerModel(config: ProjectConfig): ModelConfig {
  return (
    config.models?.determinizer ??
    config.models?.researcher ??
    config.model ?? { provider: "anthropic", name: "claude-sonnet-4-6" }
  );
}

async function regularFile(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function assertRegularDirectory(path: string, label: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink())
    throw new Error(`Symbolic links are not valid determinization ${label} roots: ${path}`);
  if (!metadata.isDirectory()) throw new Error(`Determinization ${label} root must be a directory: ${path}`);
}

async function selectBestIteration(projectRoot: string): Promise<string | undefined> {
  const iterationsDir = projectLayout(projectRoot).iterationsDir;
  let entries;
  try {
    entries = await readdir(iterationsDir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  const candidates: Array<{ iteration: number; score: number; dir: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    const iteration = Number(entry.name);
    const dir = join(iterationsDir, entry.name, "skill");
    if (!(await regularFile(join(dir, "SKILL.md")))) continue;
    try {
      const summary = JSON.parse(await readFile(join(iterationsDir, entry.name, "summary.json"), "utf8")) as {
        overall?: { normalizedScore?: unknown };
      };
      const score = summary.overall?.normalizedScore;
      if (typeof score === "number" && Number.isFinite(score)) candidates.push({ iteration, score, dir });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  candidates.sort((left, right) => right.score - left.score || left.iteration - right.iteration);
  return candidates[0]?.dir;
}

async function selectSkill(projectRoot: string, config: ProjectConfig, explicit?: string): Promise<SelectedSkill> {
  if (explicit) {
    const dir = resolve(projectRoot, explicit);
    if (!(await regularFile(join(dir, "SKILL.md")))) throw new Error(`Selected skill has no regular SKILL.md: ${dir}`);
    return { dir, source: "explicit" };
  }
  const best = await selectBestIteration(projectRoot);
  if (best) return { dir: best, source: "best_iteration" };
  const configured = config.origin_skill ?? "seed-skill";
  const dir = resolve(projectRoot, configured);
  if (!(await regularFile(join(dir, "SKILL.md")))) {
    throw new Error("No explicit skill, scored iteration, or configured origin skill with SKILL.md was found");
  }
  return { dir, source: "origin_skill" };
}

async function listRegularFiles(root: string, prefix = ""): Promise<string[]> {
  if (!prefix) await assertRegularDirectory(root, "input");
  const directory = join(root, prefix);
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => compareCodePoints(a.name, b.name))) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not valid determinization inputs: ${relativePath}`);
    if (entry.isDirectory()) files.push(...(await listRegularFiles(root, relativePath)));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

async function optionalDirectoryFiles(root: string): Promise<string[]> {
  try {
    return await listRegularFiles(root);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

function assertSeparateRoot(projectRoot: string, contextRoot: string): void {
  const rel = relative(resolve(contextRoot), projectLayout(projectRoot).determinizationDir);
  if (!rel || (rel !== ".." && !rel.startsWith(`..${sep}`))) {
    throw new Error("--context-root must not contain the project determinization output directory");
  }
}

async function prepareInputs(
  projectRoot: string,
  skillDir: string,
  catalogRoot: string,
  contextRoot?: string
): Promise<PreparedInputs> {
  const selections: SourceSelection[] = [];
  const skillPaths = (await listRegularFiles(skillDir)).filter(
    (path) => !GENERATED_SKILL_FILES.includes(path.split("/").at(-1) as (typeof GENERATED_SKILL_FILES)[number])
  );
  selections.push({ namespace: "skill", root: skillDir, paths: skillPaths });

  const evalRoot = join(projectRoot, "evals");
  const evalPaths = await optionalDirectoryFiles(evalRoot);
  if (evalPaths.length) selections.push({ namespace: "evaluation", root: evalRoot, paths: evalPaths });
  const projectInputRoot = join(projectRoot, "input");
  const projectInputPaths = await optionalDirectoryFiles(projectInputRoot);
  if (projectInputPaths.length) {
    selections.push({ namespace: "evaluation", root: projectInputRoot, paths: projectInputPaths });
  }
  const referenceRoot = join(projectRoot, "reference");
  const referencePaths = await optionalDirectoryFiles(referenceRoot);
  if (referencePaths.length) selections.push({ namespace: "reference", root: referenceRoot, paths: referencePaths });
  const iterationRoot = dirname(skillDir);
  const isIteration = dirname(iterationRoot) === projectLayout(projectRoot).iterationsDir;
  if (isIteration) {
    const iterationPaths = (await optionalDirectoryFiles(iterationRoot)).filter(
      (path) =>
        path === "summary.json" ||
        /^scores-\d+\.json$/u.test(path) ||
        path.split("/").some((segment) => segment === "outputs" || segment === "input") ||
        path.split("/").at(-1) === "task.md"
    );
    if (iterationPaths.length) {
      selections.push({ namespace: "evaluation", root: iterationRoot, paths: iterationPaths });
    }
  } else {
    const baselineRoot = projectLayout(projectRoot).baselineDir;
    const baselinePaths = (await optionalDirectoryFiles(baselineRoot)).filter(
      (path) =>
        path === "summary.json" ||
        /^scores-\d+\.json$/u.test(path) ||
        path.split("/").some((segment) => segment === "output" || segment === "input") ||
        path.split("/").at(-1) === "task.md"
    );
    if (baselinePaths.length) selections.push({ namespace: "evaluation", root: baselineRoot, paths: baselinePaths });
  }

  if (contextRoot) {
    const resolvedContext = resolve(contextRoot);
    assertSeparateRoot(projectRoot, resolvedContext);
    await assertRegularDirectory(resolvedContext, "context");
    const allowlist = ["AGENTS.md", "README.md", "package.json"];
    const contextPaths: string[] = [];
    for (const path of allowlist) if (await regularFile(join(resolvedContext, path))) contextPaths.push(path);
    if (!contextPaths.length)
      throw new Error("--context-root contains no allowlisted AGENTS.md, README.md, or package.json");
    selections.push({ namespace: "context", root: resolvedContext, paths: contextPaths });
  }
  selections.push({ namespace: "catalog", root: catalogRoot, paths: [...CATALOG_FILES] });

  // Validate roots, every path component, and current bytes before any selected
  // content is placed in a model prompt.
  await createSourceManifest(selections);

  let totalBytes = 0;
  const files: Array<{ path: string; contents: string }> = [];
  for (const selection of selections.filter(({ namespace }) => namespace !== "catalog")) {
    for (const path of selection.paths) {
      const absolute = join(selection.root, ...path.split("/"));
      const metadata = await lstat(absolute);
      if (metadata.size > MAX_DETERMINIZATION_SOURCE_FILE_BYTES) {
        throw new Error(`Determinization input exceeds 256 KiB: ${path}`);
      }
      const contents = await readFile(absolute, "utf8");
      const bytes = Buffer.byteLength(contents);
      if (bytes > MAX_DETERMINIZATION_SOURCE_FILE_BYTES) {
        throw new Error(`Determinization input exceeds 256 KiB: ${path}`);
      }
      totalBytes += bytes;
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Determinization inputs exceed the 2 MiB total limit");
      files.push({ path: `${selection.namespace}/${path}`, contents });
    }
  }
  files.sort((a, b) => compareCodePoints(a.path, b.path));
  return { selections, files };
}

export async function runDeterminizationReport(
  options: RunDeterminizationReportOptions
): Promise<DeterminizationReportResult> {
  const projectRoot = resolve(options.projectRoot);
  await assertRegularDirectory(projectRoot, "project");
  const config = await readConfig(projectRoot);
  const selected = await selectSkill(projectRoot, config, options.skillDir);
  const catalogRoot = resolve(options.catalogRoot ?? resolveBundledCatalogRoot());
  const catalogIndexPath = join(catalogRoot, "catalog.json");
  await createSourceManifest([{ namespace: "catalog", root: catalogRoot, paths: [...CATALOG_FILES] }]);
  const catalog = await loadDeterministicAssetCatalog(catalogIndexPath);
  const prepared = await prepareInputs(projectRoot, selected.dir, catalogRoot, options.contextRoot);
  await assertAnalysisArtifactBoundary(
    options.outputRoot ?? projectLayout(projectRoot).determinizationDir,
    prepared.selections
  );
  const model = options.modelOverride ?? resolveDeterminizerModel(config);
  const request = buildAnalysisRequest(prepared, catalog, model);
  const completion = await options.transport.analyze(request);
  const result = await writeAnalysisArtifacts({
    outputRoot: options.outputRoot ?? projectLayout(projectRoot).determinizationDir,
    selections: prepared.selections,
    catalogIndexPath,
    analysis: {
      role: "determinizer",
      transport: options.transport.name,
      model: { provider: model.provider, name: model.name }
    },
    analysisResponse: completion.response,
    expectedAnalysisRequest: request,
    transcript: completion.transcript
  });
  const costUsd = completion.costUsd ?? estimateUsageCostUsd(model, completion.usage);
  const modelCalls = options.transport.makesModelCall ? 1 : 0;
  return {
    ...result,
    selectedSkillDir: selected.dir,
    selectedSkillSource: selected.source,
    cost: {
      plannedCalls: modelCalls,
      actualCalls: modelCalls,
      model,
      ...(completion.usage && { usage: completion.usage }),
      ...(costUsd !== undefined && { costUsd })
    }
  };
}

export async function resumeDeterminizationReport(
  options: ResumeDeterminizationReportOptions
): Promise<DeterminizationReportResult> {
  const projectRoot = resolve(options.projectRoot);
  await assertRegularDirectory(projectRoot, "project");
  const config = await readConfig(projectRoot);
  const selected = await selectSkill(projectRoot, config, options.skillDir);
  const catalogRoot = resolve(options.catalogRoot ?? resolveBundledCatalogRoot());
  const prepared = await prepareInputs(projectRoot, selected.dir, catalogRoot, options.contextRoot);
  const model = resolveDeterminizerModel(config);
  const catalog = await loadDeterministicAssetCatalog(join(catalogRoot, "catalog.json"));
  const result = await resumeAnalysisArtifacts({
    outputRoot: options.outputRoot ?? projectLayout(projectRoot).determinizationDir,
    selections: prepared.selections,
    catalogIndexPath: join(catalogRoot, "catalog.json"),
    expectedModel: model,
    expectedAnalysisRequest: buildAnalysisRequest(prepared, catalog, model)
  });
  return {
    ...result,
    selectedSkillDir: selected.dir,
    selectedSkillSource: selected.source,
    cost: { plannedCalls: 0, actualCalls: 0, model }
  };
}
