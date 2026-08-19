import { execFile, type ExecFileException } from "node:child_process";
import { cp, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { ModelCallRole, ModelUsage } from "./cost.js";
import { SkillResearcher, SkillResearchRequest } from "./orchestrator.js";
import { persistResearchArtifact, persistTranscript, withArtifactStage } from "./artifact-lifecycle.js";
import { projectLayout } from "./project-layout.js";
import { DEFAULT_MODEL } from "./model.js";
import { resolveContainedPath as resolveContained } from "./contained-path.js";
import { extractScoreJson, validateEvalScore } from "./score.js";
import { EvalAgent, EvalAgentRequest } from "./runner.js";
import { buildJudgePrompt } from "./prompts/judge-prompt.js";
import { buildProducePrompt } from "./prompts/produce-prompt.js";
import { buildResearchPrompt } from "./prompts/research-prompt.js";
import {
  EvalCase,
  EvalScore,
  EvalScoreSchema,
  GuidanceLedger,
  GuidanceLedgerSchema,
  ModelConfig,
  ModelProduceResponse,
  ModelProduceResponseSchema,
  OutputFile,
  ResourceDecision,
  ResourcePlacement,
  SkillResearchPatch,
  SkillResearchPatchSchema,
  Track,
  parseWithSchema
} from "./schemas.js";

export interface ScriptValidationResult {
  path: string;
  status: "passed" | "failed" | "skipped";
  validator?: string;
  note: string;
}

type ScriptValidator = "javascript" | "typescript" | "shell" | "python";

export interface ModelRequest {
  system: string;
  prompt: string;
  model: ModelConfig;
  phase?: string;
  workspaceDir?: string;
  signal?: AbortSignal;
}

export interface ModelCompletionResponse {
  text: string;
  usage?: ModelUsage;
}

export type ModelCompletion = string | ModelCompletionResponse;

export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelCompletion>;
}

export interface AnthropicMessagesClientOptions {
  apiKey?: string;
  version?: string;
  maxTokens?: number;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
}

export class AnthropicMessagesClient implements ModelClient {
  readonly #apiKey: string;
  readonly #version: string;
  readonly #maxTokens: number;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;

  constructor(options: AnthropicMessagesClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is required for the Anthropic model client");
    }
    this.#apiKey = apiKey;
    this.#version = options.version ?? "2023-06-01";
    this.#maxTokens = options.maxTokens ?? 4096;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#maxAttempts = options.maxAttempts ?? 3;
  }

  async complete(request: ModelRequest): Promise<ModelCompletion> {
    if (request.model.provider !== "anthropic") {
      throw new Error(`AnthropicMessagesClient cannot run provider "${request.model.provider}"`);
    }

    let response: Response | undefined;
    let finalError: Error | undefined;
    for (let attempt = 0; attempt < this.#maxAttempts; attempt++) {
      const controller = new AbortController();
      const onAbort = () => controller.abort(request.signal?.reason);
      request.signal?.addEventListener("abort", onAbort, { once: true });
      const timeout = setTimeout(() => controller.abort(new Error("Anthropic request timed out")), this.#timeoutMs);
      try {
        response = await this.#fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": this.#apiKey,
            "anthropic-version": this.#version
          },
          signal: controller.signal,
          body: JSON.stringify({
            model: request.model.name,
            max_tokens: this.#maxTokens,
            system: request.system,
            messages: [{ role: "user", content: request.prompt }]
          })
        });
      } catch (error) {
        finalError = error instanceof Error ? error : new Error(String(error));
        if (attempt + 1 >= this.#maxAttempts || controller.signal.aborted) throw finalError;
      } finally {
        clearTimeout(timeout);
        request.signal?.removeEventListener("abort", onAbort);
      }
      if (response?.ok) break;
      if (response && response.status !== 429 && response.status !== 503) {
        throw new Error(`Anthropic request failed with ${response.status}: ${await response.text()}`);
      }
      if (response)
        finalError = new Error(`Anthropic request failed with ${response.status}: ${await response.text()}`);
      if (attempt + 1 < this.#maxAttempts) {
        const retryAfter = Number(response?.headers.get("retry-after"));
        const delayMs = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : 250 * 2 ** attempt;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(delayMs, 5_000)));
      }
    }
    if (!response?.ok) throw finalError ?? new Error("Anthropic request failed");

    const body = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
    };
    const text = body.content
      ?.filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("\n");
    if (!text) {
      throw new Error("Anthropic response did not include text content");
    }
    return {
      text,
      usage: {
        inputTokens: body.usage?.input_tokens,
        outputTokens: body.usage?.output_tokens,
        cacheCreationInputTokens: body.usage?.cache_creation_input_tokens,
        cacheReadInputTokens: body.usage?.cache_read_input_tokens
      }
    };
  }
}

export class ModelEvalAgent implements EvalAgent {
  readonly #client: ModelClient;

  constructor(client: ModelClient) {
    this.#client = client;
  }

  async run(request: EvalAgentRequest): Promise<EvalScore> {
    const produceRequest = await buildProduceModelRequest(request);
    const produceResponse = await completeTrackedModelRequest(
      this.#client,
      produceRequest,
      request.baseline ? "baseline_producer" : "iteration_producer",
      request.costTracker
    );
    await persistTranscript(
      join(request.sandbox.outputDir, "producer-transcript.json"),
      produceRequest,
      produceResponse
    );
    const produced = parseModelProduceResponse(produceResponse);
    await applyOutputFiles(request.sandbox.outputDir, produced.output_files);

    return this.judge(request, produced.output_files);
  }

  async judge(request: EvalAgentRequest, outputFiles: OutputFile[]): Promise<EvalScore> {
    const judgeRequest = await buildJudgeModelRequest(request, outputFiles);
    const judgeResponse = await completeTrackedModelRequest(
      this.#client,
      judgeRequest,
      request.baseline ? "baseline_judge" : "iteration_judge",
      request.costTracker
    );
    await persistTranscript(join(request.sandbox.outputDir, "judge-transcript.json"), judgeRequest, judgeResponse);
    return parseModelJudgeResponse(judgeResponse, request.evalCase, request.track);
  }
}

export class ModelSkillResearcher implements SkillResearcher {
  readonly #client: ModelClient;

  constructor(client: ModelClient) {
    this.#client = client;
  }

  async improve(request: SkillResearchRequest): Promise<void> {
    const modelRequest = await buildResearchModelRequest(request);
    const response = await completeTrackedModelRequest(this.#client, modelRequest, "researcher", request.costTracker);
    const patch = parseSkillResearchPatch(response);
    await persistResearchArtifact(
      request,
      modelRequest,
      patch,
      response,
      ".autoresearch-transcript.json",
      researchArtifactOperations
    );
  }
}

async function completeTrackedModelRequest(
  client: ModelClient,
  request: ModelRequest,
  role: ModelCallRole,
  tracker: SkillResearchRequest["costTracker"] | EvalAgentRequest["costTracker"]
): Promise<string> {
  tracker?.assertCanStartModelCall();
  const completion = await client.complete(request);
  tracker?.recordModelCall({
    role,
    phase: request.phase,
    model: request.model,
    usage: modelCompletionUsage(completion)
  });
  return modelCompletionText(completion);
}

export function modelCompletionText(completion: ModelCompletion): string {
  return typeof completion === "string" ? completion : completion.text;
}

export function modelCompletionUsage(completion: ModelCompletion): ModelUsage | undefined {
  return typeof completion === "string" ? undefined : completion.usage;
}

export async function buildProduceModelRequest(request: EvalAgentRequest): Promise<ModelRequest> {
  const workspaceDir = await createPhaseWorkspace(request, "producer", ["/input", "/reference", "/skill"]);
  const inputFiles = await readFilesFromMount(join(workspaceDir, "input"));
  const referenceFiles = await readFilesFromMount(join(workspaceDir, "reference"));
  const skillFiles = await readFilesFromMount(join(workspaceDir, "skill"));

  return checkedModelRequest({
    model: roleModel(request, "producer"),
    system: request.role,
    phase: `producer eval ${request.evalCase.id}`,
    workspaceDir,
    prompt: buildProducePrompt({ request, workspaceDir, inputFiles, referenceFiles, skillFiles })
  });
}

export async function buildJudgeModelRequest(
  request: EvalAgentRequest,
  outputFiles: OutputFile[]
): Promise<ModelRequest> {
  await applyOutputFiles(request.sandbox.outputDir, outputFiles);
  const workspaceDir = await createPhaseWorkspace(request, "judge", ["/reference"]);
  await applyOutputFiles(join(workspaceDir, "output"), outputFiles);
  const referenceFiles = await readFilesFromMount(join(workspaceDir, "reference"));
  const rubricFiles = await readFilesFromMount(join(workspaceDir, "evals"));
  const workspaceOutputFiles = await readFilesFromMount(join(workspaceDir, "output"));

  return checkedModelRequest({
    model: roleModel(request, "judge"),
    system: request.modelRoles?.judge ?? "judge",
    phase: `judge eval ${request.evalCase.id}`,
    workspaceDir,
    prompt: buildJudgePrompt({
      request,
      workspaceDir,
      referenceFiles,
      rubricFiles,
      workspaceOutputFiles
    })
  });
}

async function createPhaseWorkspace(
  request: EvalAgentRequest,
  phase: "producer" | "judge",
  mountTargets: string[]
): Promise<string> {
  const workspaceDir = join(request.sandbox.outputDir, ".phase-workspaces", phase);
  return withArtifactStage(`prepare ${phase} phase workspace ${workspaceDir}`, async () => {
    await rm(workspaceDir, { recursive: true, force: true });
    await mkdir(workspaceDir, { recursive: true });

    for (const target of mountTargets) {
      const mount = request.sandbox.mounts.find((candidate) => candidate.target === target);
      if (!mount || !(await exists(mount.source))) {
        continue;
      }
      await cp(mount.source, join(workspaceDir, target.slice(1)), {
        recursive: true,
        force: false,
        errorOnExist: true
      });
    }

    const evalsMount = request.sandbox.mounts.find((candidate) => candidate.target === "/evals");
    if (phase === "judge" && evalsMount && (await exists(evalsMount.source))) {
      await mkdir(join(workspaceDir, "evals"), { recursive: true });
      const rubricPath = join(evalsMount.source, "rubric.md");
      if (await exists(rubricPath)) {
        await cp(rubricPath, join(workspaceDir, "evals", "rubric.md"), {
          force: false,
          errorOnExist: true
        });
      }
    }

    return workspaceDir;
  });
}

export function parseModelProduceResponse(response: string): ModelProduceResponse {
  return parseWithSchema(
    ModelProduceResponseSchema,
    parseJson(response, "Model producer response"),
    "model producer response"
  );
}

export function parseModelJudgeResponse(response: string, evalCase: EvalCase, track: Track): EvalScore {
  return validateModelJudgeResponse(extractScoreJson(response), evalCase, track);
}

export function validateModelJudgeResponse(response: unknown, evalCase: EvalCase, track: Track): EvalScore {
  const score = parseWithSchema(EvalScoreSchema, response, "model judge response");
  validateEvalScore(score, evalCase, track);
  return score;
}

export async function applyOutputFiles(outputDir: string, files: OutputFile[]): Promise<void> {
  for (const file of files) {
    const destination = resolveContainedPath(outputDir, file.path, "Eval output file");
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.contents, "utf8");
  }
}

export async function buildResearchModelRequest(request: SkillResearchRequest): Promise<ModelRequest> {
  const workspaceDir = await createResearchWorkspace(request);
  const skillFiles = await readFilesFromMount(join(workspaceDir, "skill"));
  const referenceFiles = await readFilesFromMount(join(workspaceDir, "reference"));
  const seedReferenceFiles = await readFilesFromMount(join(workspaceDir, "seed-reference"));
  const evalFiles = await readFilesFromMount(join(workspaceDir, "evals"));
  const guidanceLedger = await readGuidanceLedger(request.guidanceLedgerPath);
  return checkedModelRequest({
    model: request.project.config.models?.researcher ?? request.project.config.model ?? DEFAULT_MODEL,
    system: request.project.config.roles.skill_builder,
    phase: `research iteration ${request.iteration}`,
    workspaceDir,
    prompt: buildResearchPrompt({
      request,
      workspaceDir,
      skillFiles,
      referenceFiles,
      seedReferenceFiles,
      evalFiles,
      guidanceLedger
    })
  });
}

async function createResearchWorkspace(request: SkillResearchRequest): Promise<string> {
  const workspaceDir = projectLayout(request.project.root).researchWorkspaceDir(request.iteration);
  return withArtifactStage(`prepare research workspace ${workspaceDir}`, async () => {
    await rm(workspaceDir, { recursive: true, force: true });
    await mkdir(join(workspaceDir, "scores"), { recursive: true });
    await cp(join(request.project.root, "config.json"), join(workspaceDir, "config.json"), {
      force: false,
      errorOnExist: true
    });
    await cp(join(request.project.root, "evals"), join(workspaceDir, "evals"), {
      recursive: true,
      force: false,
      errorOnExist: true
    });
    if (await exists(request.project.referenceDir)) {
      await cp(request.project.referenceDir, join(workspaceDir, "reference"), {
        recursive: true,
        force: false,
        errorOnExist: true
      });
    }
    if (request.guidanceSkillDir) {
      await cp(request.guidanceSkillDir, join(workspaceDir, "seed-reference"), {
        recursive: true,
        force: false,
        errorOnExist: true
      });
    }
    await cp(request.previousSkillDir, join(workspaceDir, "skill"), {
      recursive: true,
      force: false,
      errorOnExist: true
    });
    await writeFile(
      join(workspaceDir, "scores", "previous-aggregate.json"),
      `${JSON.stringify(request.previousAggregate, null, 2)}\n`
    );
    await writeFile(
      join(workspaceDir, "scores", "previous-scores.json"),
      `${JSON.stringify(request.previousScores, null, 2)}\n`
    );
    await writeFile(
      join(workspaceDir, "scores", "baseline-scores.json"),
      `${JSON.stringify(request.baselineScores, null, 2)}\n`
    );
    return workspaceDir;
  });
}

function roleModel(request: EvalAgentRequest, role: "producer" | "judge"): ModelConfig {
  return request.models?.[role] ?? request.model;
}

export function parseSkillResearchPatch(response: string): SkillResearchPatch {
  const raw = parseJson(response, "Research response");
  return parseWithSchema(SkillResearchPatchSchema, raw, "skill research patch");
}

export async function readGuidanceLedger(path: string | undefined): Promise<GuidanceLedger> {
  if (!path || !(await exists(path))) {
    return { entries: [] };
  }
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    return parseWithSchema(GuidanceLedgerSchema, raw, "guidance ledger");
  } catch (error) {
    throw new Error(`Could not read guidance ledger at ${path}: ${(error as Error).message}`, {
      cause: error
    });
  }
}

export async function appendGuidanceLedger(
  path: string | undefined,
  iteration: number,
  patch: SkillResearchPatch
): Promise<void> {
  if (!path || patch.guidance.length === 0) {
    return;
  }
  const ledger = await readGuidanceLedger(path);
  ledger.entries.push(...patch.guidance.map((entry) => ({ ...entry, iteration })));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

export async function applySkillResearchPatch(skillDir: string, patch: SkillResearchPatch): Promise<void> {
  for (const change of patch.changes) {
    const destination = resolveSkillPath(skillDir, change.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, change.contents, "utf8");
  }
}

export function validateSkillResearchPatch(skillDir: string, patch: SkillResearchPatch): void {
  for (const change of patch.changes) {
    resolveSkillPath(skillDir, change.path);
  }

  const decisionsByPath = new Map<string, ResourceDecision>();
  for (const decision of patch.resource_decisions ?? []) {
    resolveSkillPath(skillDir, decision.path);
    if (decisionsByPath.has(decision.path)) {
      throw new Error(`Research patch has duplicate resource decision for: ${decision.path}`);
    }
    decisionsByPath.set(decision.path, decision);
    const expected = inferResourcePlacement(decision.path);
    if (decision.placement !== expected) {
      throw new Error(
        `Resource decision for ${decision.path} uses placement "${decision.placement}", expected "${expected}"`
      );
    }
  }

  const changedPaths = new Set(patch.changes.map((change) => change.path));
  const missing = [...changedPaths].filter((path) => !decisionsByPath.has(path));
  const extra = [...decisionsByPath.keys()].filter((path) => !changedPaths.has(path));
  if (missing.length > 0) {
    throw new Error(`Research patch is missing resource decisions for: ${missing.join(", ")}`);
  }
  if (extra.length > 0) {
    throw new Error(`Resource decisions do not have matching changes: ${extra.join(", ")}`);
  }
}

function inferResourcePlacement(path: string): ResourcePlacement {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.startsWith("references/")) return "reference";
  if (normalized.startsWith("scripts/")) return "script";
  if (normalized.startsWith("assets/")) return "asset";
  return "skill";
}

function parseJson(response: string, label: string): unknown {
  try {
    return JSON.parse(response.trim());
  } catch (error) {
    throw new Error(`${label} was not valid JSON: ${(error as Error).message}`, { cause: error });
  }
}

function resolveSkillPath(skillDir: string, path: string): string {
  return resolveContainedPath(skillDir, path, "Research patch path");
}

function resolveContainedPath(rootDir: string, path: string, label: string): string {
  return resolveContained(rootDir, path, {
    absolute: (value) => `${label} escapes target directory: ${value}`,
    outside: (value) => `${label} escapes target directory: ${value}`
  });
}

export function formatResearchSummary(
  patch: SkillResearchPatch,
  scriptValidations: ScriptValidationResult[] = []
): string {
  const explicitDecisions = new Map((patch.resource_decisions ?? []).map((decision) => [decision.path, decision]));
  const decisions = patch.changes.map(
    (change): ResourceDecision =>
      explicitDecisions.get(change.path) ?? {
        path: change.path,
        placement: inferResourcePlacement(change.path),
        reason: "Placement inferred from the changed file path; the researcher did not report a decision."
      }
  );
  return [
    `# Research Summary`,
    "",
    patch.summary,
    "",
    "## Changed Files",
    "",
    ...patch.changes.map((change) => `- ${change.path}`),
    "",
    "## Resource Placement",
    "",
    ...decisions.map((decision) => `- \`${decision.path}\` — ${decision.placement}: ${decision.reason}`),
    "",
    "## Script Validation",
    "",
    ...(scriptValidations.length > 0
      ? scriptValidations.map((result) => {
          const validator = result.validator ? ` (\`${result.validator}\`)` : "";
          return `- \`${result.path}\` — ${result.status}${validator}: ${result.note}`;
        })
      : ["No scripts were generated or changed in this iteration."])
  ].join("\n");
}

export async function validateChangedScripts(
  skillDir: string,
  patch: SkillResearchPatch
): Promise<ScriptValidationResult[]> {
  return Promise.all(
    patch.changes
      .filter((change) => inferResourcePlacement(change.path) === "script")
      .map((change) => {
        const path = resolveSkillPath(skillDir, change.path);
        const extension = extname(path).toLowerCase();
        if ([".js", ".mjs", ".cjs"].includes(extension)) {
          return runScriptValidation(change.path, path, "javascript", "node --check");
        }
        if ([".ts", ".mts", ".cts"].includes(extension)) {
          return runScriptValidation(change.path, path, "typescript", "TypeScript parser");
        }
        if ([".sh", ".bash"].includes(extension)) {
          return runScriptValidation(change.path, path, "shell", "/bin/bash -n");
        }
        if (extension === ".py") {
          return runScriptValidation(change.path, path, "python", "python3 ast.parse");
        }
        return Promise.resolve({
          path: change.path,
          status: "skipped" as const,
          note: `No built-in validator is available for ${extension || "extensionless"} scripts.`
        });
      })
  );
}

async function runScriptValidation(
  path: string,
  absolutePath: string,
  validator: ScriptValidator,
  validatorLabel: string
): Promise<ScriptValidationResult> {
  const result = await executeScriptValidator(validator, absolutePath);
  if (!result.error) {
    return { path, status: "passed", validator: validatorLabel, note: "Focused syntax validation passed." };
  }
  if (result.error.code === "ENOENT") {
    return {
      path,
      status: "skipped",
      validator: validatorLabel,
      note: `Validator executable was unavailable for ${validatorLabel}.`
    };
  }
  const stderr = result.stderr.trim();
  return {
    path,
    status: "failed",
    validator: validatorLabel,
    note: stderr
      ? `Focused syntax validation failed: ${stderr}`
      : `Focused syntax validation failed: ${result.error.message}`
  };
}

interface ValidatorExecutionResult {
  error: ExecFileException | null;
  stderr: string;
}

function executeScriptValidator(validator: ScriptValidator, absolutePath: string): Promise<ValidatorExecutionResult> {
  return new Promise((resolveExecution) => {
    const options = { timeout: 10_000, maxBuffer: 1_000_000, shell: false, encoding: "utf8" } as const;
    const complete = (error: ExecFileException | null, _stdout: string, stderr: string) => {
      resolveExecution({ error, stderr });
    };

    switch (validator) {
      case "javascript":
        execFile("node", ["--check", absolutePath], options, complete);
        break;
      case "typescript":
        execFile(
          process.execPath,
          [
            "--input-type=module",
            "--eval",
            "import ts from 'typescript'; import fs from 'node:fs'; const p=process.argv[1]; const s=fs.readFileSync(p,'utf8'); const k=p.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS; const d=ts.createSourceFile(p,s,ts.ScriptTarget.Latest,true,k).parseDiagnostics; if(d.length){console.error(d.map(x=>ts.flattenDiagnosticMessageText(x.messageText,'\\n')).join('\\n'));process.exitCode=1;}",
            absolutePath
          ],
          options,
          complete
        );
        break;
      case "shell":
        execFile("/bin/bash", ["-n", absolutePath], options, complete);
        break;
      case "python":
        execFile(
          "python3",
          ["-c", "import ast, pathlib, sys; ast.parse(pathlib.Path(sys.argv[1]).read_text())", absolutePath],
          options,
          complete
        );
        break;
    }
  });
}

export const researchArtifactOperations = {
  validatePatch: validateSkillResearchPatch,
  applyPatch: applySkillResearchPatch,
  validateScripts: validateChangedScripts,
  appendLedger: appendGuidanceLedger,
  formatSummary: formatResearchSummary
};

async function readFilesFromMount(root: string | undefined): Promise<Array<{ path: string; contents: string }>> {
  if (!root || !(await exists(root))) {
    return [];
  }
  const files = await listTextFiles(root);
  return Promise.all(
    files.map(async (path) => {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024) {
        throw new Error(`Mounted file exceeds the 1 MiB limit or is not a regular file: ${path}`);
      }
      const contents = await readFile(path, "utf8");
      if (Buffer.byteLength(contents) > 1024 * 1024) throw new Error(`Mounted file exceeds the 1 MiB limit: ${path}`);
      return { path: relative(root, path), contents };
    })
  );
}

async function listTextFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        return listTextFiles(path);
      }
      if (entry.isFile() && !isHiddenGeneratedFile(entry.name)) {
        return [path];
      }
      return [];
    })
  );
  return nested.flat().sort();
}

function isHiddenGeneratedFile(fileName: string): boolean {
  return basename(fileName).startsWith(".autoresearch-");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const MAX_PROMPT_TOKENS = 180_000;
const APPROX_CHARS_PER_TOKEN = 4;

function checkedModelRequest(request: ModelRequest): ModelRequest {
  const estimatedTokens = estimateTokens(`${request.system}\n${request.prompt}`);
  if (estimatedTokens <= MAX_PROMPT_TOKENS) {
    return request;
  }

  const phase = request.phase ?? "model request";
  throw new Error(
    [
      `[flue] prompt budget exceeded before ${phase}: estimated ${estimatedTokens} tokens > ${MAX_PROMPT_TOKENS} token budget`,
      `Prompt size: ${request.prompt.length} chars. This was detected before submitting a provider request.`,
      "Reduce the eval input/reference/skill/output artifacts for this phase or add a more compact summary."
    ].join("\n")
  );
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
}
