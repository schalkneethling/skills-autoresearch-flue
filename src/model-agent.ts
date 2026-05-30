import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { SkillResearcher, SkillResearchRequest } from "./orchestrator.js";
import { EvalAgent, EvalAgentRequest } from "./runner.js";
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
  SkillResearchPatch,
  SkillResearchPatchSchema,
  Track,
  parseWithSchema
} from "./schemas.js";

type MountedFile = { path: string; contents: string };

export interface ModelRequest {
  system: string;
  prompt: string;
  model: {
    provider: string;
    name: string;
  };
  phase?: string;
  workspaceDir?: string;
}

export interface ModelClient {
  complete(request: ModelRequest): Promise<string>;
}

export interface AnthropicMessagesClientOptions {
  apiKey?: string;
  version?: string;
  maxTokens?: number;
  fetch?: typeof fetch;
}

export class AnthropicMessagesClient implements ModelClient {
  readonly #apiKey: string;
  readonly #version: string;
  readonly #maxTokens: number;
  readonly #fetch: typeof fetch;

  constructor(options: AnthropicMessagesClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is required for the Anthropic model client");
    }
    this.#apiKey = apiKey;
    this.#version = options.version ?? "2023-06-01";
    this.#maxTokens = options.maxTokens ?? 4096;
    this.#fetch = options.fetch ?? fetch;
  }

  async complete(request: ModelRequest): Promise<string> {
    if (request.model.provider !== "anthropic") {
      throw new Error(`AnthropicMessagesClient cannot run provider "${request.model.provider}"`);
    }

    const response = await this.#fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.#apiKey,
        "anthropic-version": this.#version
      },
      body: JSON.stringify({
        model: request.model.name,
        max_tokens: this.#maxTokens,
        system: request.system,
        messages: [{ role: "user", content: request.prompt }]
      })
    });

    if (!response.ok) {
      throw new Error(`Anthropic request failed with ${response.status}: ${await response.text()}`);
    }

    const body = (await response.json()) as { content?: Array<{ type?: string; text?: string }> };
    const text = body.content
      ?.filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("\n");
    if (!text) {
      throw new Error("Anthropic response did not include text content");
    }
    return text;
  }
}

export class ModelEvalAgent implements EvalAgent {
  readonly #client: ModelClient;

  constructor(client: ModelClient) {
    this.#client = client;
  }

  async run(request: EvalAgentRequest): Promise<EvalScore> {
    const produceRequest = await buildProduceModelRequest(request);
    const produceResponse = await this.#client.complete(produceRequest);
    await persistTranscript(
      join(request.sandbox.outputDir, "producer-transcript.json"),
      produceRequest,
      produceResponse
    );
    const produced = parseModelProduceResponse(produceResponse);
    await applyOutputFiles(request.sandbox.outputDir, produced.output_files);

    const judgeRequest = await buildJudgeModelRequest(request, produced.output_files);
    const judgeResponse = await this.#client.complete(judgeRequest);
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
    const response = await this.#client.complete(modelRequest);
    const patch = parseSkillResearchPatch(response);
    validateSkillResearchPatch(request.candidateSkillDir, patch);
    await cp(request.previousSkillDir, request.candidateSkillDir, {
      recursive: true,
      errorOnExist: true,
      force: false
    });
    await mkdir(request.candidateSkillDir, { recursive: true });
    await applySkillResearchPatch(request.candidateSkillDir, patch);
    await appendGuidanceLedger(request.guidanceLedgerPath, request.iteration, patch);
    await writeFile(join(request.candidateSkillDir, "RESEARCH.md"), formatResearchSummary(patch), { flag: "wx" });
    await persistTranscript(join(request.candidateSkillDir, ".autoresearch-transcript.json"), modelRequest, response);
  }
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
    prompt: [
      `Run the target skill for "${request.evalCase.title}" (${request.evalCase.id}).`,
      `Eval type: ${request.evalCase.eval_type}`,
      `Track: ${request.track.id}`,
      request.targetSkill ? `Target skill: ${request.targetSkill}` : "Baseline run: no target skill is mounted.",
      `Authoritative workspace root: ${workspaceDir}`,
      "Only files under this workspace are authoritative for this producer phase.",
      "Available paths: ./input, ./reference, ./skill when present.",
      "",
      "Eval case JSON:",
      fencedJson(request.evalCase),
      "",
      "Input files:",
      formatFileSet(inputFiles, `producer eval ${request.evalCase.id} input files`),
      "",
      "Reference files:",
      formatFileSet(referenceFiles, `producer eval ${request.evalCase.id} reference files`),
      "",
      "Skill files:",
      formatFileSet(skillFiles, `producer eval ${request.evalCase.id} skill files`),
      "",
      "Produce the concrete eval output files. Do not score your own work.",
      "Return only well-formed JSON with this shape. Do not include markdown, code fences, prose, or XML tags:",
      fencedJson({
        output_files: [
          {
            path: "RESULT.md",
            contents: "The concrete output produced for this eval."
          }
        ]
      }),
      "Each output_files path must be relative to the eval output directory."
    ].join("\n")
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
    prompt: [
      `Judge output for "${request.evalCase.title}" (${request.evalCase.id}).`,
      `Eval type: ${request.evalCase.eval_type}`,
      `Track: ${request.track.id}`,
      `Authoritative workspace root: ${workspaceDir}`,
      "Only files under this workspace are authoritative for this judge phase.",
      "Available paths: ./evals, ./reference, ./output.",
      "",
      "Eval case JSON:",
      fencedJson(request.evalCase),
      "",
      "Rubric files:",
      formatFileSet(rubricFiles, `judge eval ${request.evalCase.id} rubric files`),
      "",
      "Reference files:",
      formatFileSet(referenceFiles, `judge eval ${request.evalCase.id} reference files`),
      "",
      "Producer output files:",
      formatFileSet(workspaceOutputFiles, `judge eval ${request.evalCase.id} producer output files`),
      "",
      "Score only the producer output. Do not award credit for requirements merely stated in the skill instructions.",
      "Return only well-formed JSON matching the EvalScore schema. Do not include markdown, code fences, prose, or XML tags:",
      fencedJson({
        eval_id: request.evalCase.id,
        eval_type: request.evalCase.eval_type,
        track_id: request.track.id,
        total_score: 0,
        max_score: request.evalCase.scoring_dimensions.reduce((sum, dimension) => sum + dimension.max_score, 0),
        dimensions: request.evalCase.scoring_dimensions.map((dimension) => ({
          id: dimension.id,
          score: 0,
          max_score: dimension.max_score,
          rationale: "Rationale grounded only in the producer output."
        })),
        summary: "Concise scoring summary."
      })
    ].join("\n")
  });
}

async function createPhaseWorkspace(
  request: EvalAgentRequest,
  phase: "producer" | "judge",
  mountTargets: string[]
): Promise<string> {
  const workspaceDir = join(request.sandbox.outputDir, ".phase-workspaces", phase);
  await rm(workspaceDir, { recursive: true, force: true });
  await mkdir(workspaceDir, { recursive: true });

  for (const target of mountTargets) {
    const mount = request.sandbox.mounts.find((candidate) => candidate.target === target);
    if (!mount || !(await exists(mount.source))) {
      continue;
    }
    await cp(mount.source, join(workspaceDir, target.slice(1)), { recursive: true, force: false, errorOnExist: true });
  }

  const evalsMount = request.sandbox.mounts.find((candidate) => candidate.target === "/evals");
  if (phase === "judge" && evalsMount && (await exists(evalsMount.source))) {
    await mkdir(join(workspaceDir, "evals"), { recursive: true });
    const rubricPath = join(evalsMount.source, "rubric.md");
    if (await exists(rubricPath)) {
      await cp(rubricPath, join(workspaceDir, "evals", "rubric.md"), { force: false, errorOnExist: true });
    }
  }

  return workspaceDir;
}

export function parseModelProduceResponse(response: string): ModelProduceResponse {
  return parseWithSchema(
    ModelProduceResponseSchema,
    parseJson(response, "Model producer response"),
    "model producer response"
  );
}

export function parseModelJudgeResponse(response: string, evalCase: EvalCase, track: Track): EvalScore {
  const score = parseWithSchema(EvalScoreSchema, parseJson(response, "Model judge response"), "model judge response");
  validateEvalScore(score, evalCase, track);
  return score;
}

export function validateModelProduceResponse(response: ModelProduceResponse): ModelProduceResponse {
  return response;
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
    model: request.project.config.models?.researcher ??
      request.project.config.model ?? { provider: "anthropic", name: "claude-sonnet-4-6" },
    system: request.project.config.roles.skill_builder,
    phase: `research iteration ${request.iteration}`,
    workspaceDir,
    prompt: [
      `Improve skill "${request.project.config.skill_name}" for iteration ${request.iteration}.`,
      `Topic group: ${request.project.config.topic_group}`,
      `Target normalized score: ${request.project.config.target_score}`,
      `Previous normalized score: ${request.previousAggregate.overall.normalizedScore}`,
      `Authoritative workspace root: ${workspaceDir}`,
      "Only files under this workspace are authoritative for this research phase.",
      "Available paths: ./config.json, ./evals, ./reference, ./skill, ./scores.",
      request.guidanceSkillDir
        ? "Seed/reference skill guidance is available under ./seed-reference for this research phase."
        : "No separate seed/reference skill guidance directory is configured for this research phase.",
      "",
      "Previous aggregate:",
      fencedJson(request.previousAggregate),
      "",
      "Previous scores:",
      fencedJson(request.previousScores),
      "",
      "Baseline scores:",
      fencedJson(request.baselineScores),
      "",
      "Current skill files:",
      formatFileSet(skillFiles, `research iteration ${request.iteration} skill files`),
      "",
      "Eval and rubric files:",
      formatFileSet(evalFiles, `research iteration ${request.iteration} eval files`),
      "",
      "Reference files:",
      formatFileSet(referenceFiles, `research iteration ${request.iteration} reference files`),
      "",
      ...formatGuidanceContext(request.iteration, seedReferenceFiles, guidanceLedger),
      "",
      "Return only well-formed JSON with this shape. Do not include markdown, code fences, prose, or XML tags:",
      fencedJson({
        summary: "Brief summary of the intended skill improvement.",
        guidance: [
          {
            source: "seed-reference/SKILL.md",
            section: "Optional section heading or concise location.",
            action: "used",
            reason: "Why this guidance was or was not needed for the current failures.",
            appliedTo: "SKILL.md"
          }
        ],
        changes: [{ path: "SKILL.md", contents: "Complete replacement file contents." }]
      }),
      "Each change path must be relative to the skill directory.",
      "Use guidance entries to update the guidance ledger whenever you inspect, use, defer, ignore, or need more seed/reference guidance.",
      "After iteration 1, prefer the guidance ledger and seed/reference index first; pull exact seed/reference content only when the latest failures justify it."
    ].join("\n")
  });
}

async function createResearchWorkspace(request: SkillResearchRequest): Promise<string> {
  const workspaceDir = join(request.project.root, "workspace", ".phase-workspaces", `research-${request.iteration}`);
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
}

function formatGuidanceContext(iteration: number, seedReferenceFiles: MountedFile[], ledger: GuidanceLedger): string[] {
  if (seedReferenceFiles.length === 0) {
    return ["Seed/reference skill guidance:", "No seed/reference skill files are configured."];
  }

  if (iteration === 1) {
    return [
      "Seed/reference skill files:",
      formatFileSet(seedReferenceFiles, `research iteration ${iteration} seed/reference skill files`),
      "",
      "Guidance ledger:",
      fencedJson(ledger)
    ];
  }

  return [
    "Guidance ledger:",
    fencedJson(ledger),
    "",
    "Seed/reference skill index:",
    formatGuidanceIndex(seedReferenceFiles)
  ];
}

function formatGuidanceIndex(files: MountedFile[]): string {
  return files.map((file) => `- ${file.path}${formatHeadings(file.contents)}`).join("\n");
}

function formatHeadings(contents: string): string {
  const headings = contents
    .split(/\r?\n/)
    .map((line) => line.match(/^(#{1,6})\s+(.+)$/)?.[2]?.trim())
    .filter((heading): heading is string => Boolean(heading))
    .slice(0, 8);
  return headings.length > 0 ? ` (${headings.join("; ")})` : "";
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
    throw new Error(`Could not read guidance ledger at ${path}: ${(error as Error).message}`, { cause: error });
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
  const root = resolve(rootDir);
  const destination = resolve(root, path);
  const rel = relative(root, destination);
  if (rel === "" || rel.startsWith("..") || rel.startsWith("/")) {
    throw new Error(`${label} escapes target directory: ${path}`);
  }
  return destination;
}

function validateEvalScore(score: EvalScore, evalCase: EvalCase, track: Track): void {
  const knownDimensions = new Set(evalCase.scoring_dimensions.map((dimension) => dimension.id));
  const unknown = score.dimensions.filter((dimension) => !knownDimensions.has(dimension.id));

  if (score.eval_id !== evalCase.id) {
    throw new Error(`Judge score eval_id "${score.eval_id}" does not match "${evalCase.id}"`);
  }
  if (score.eval_type !== evalCase.eval_type) {
    throw new Error(`Judge score eval_type "${score.eval_type}" does not match "${evalCase.eval_type}"`);
  }
  if (score.track_id !== track.id) {
    throw new Error(`Judge score track_id "${score.track_id}" does not match "${track.id}"`);
  }
  if (unknown.length > 0) {
    throw new Error(`Judge score included unknown dimensions: ${unknown.map((dimension) => dimension.id).join(", ")}`);
  }
}

function formatResearchSummary(patch: SkillResearchPatch): string {
  return [
    `# Research Summary`,
    "",
    patch.summary,
    "",
    "## Changed Files",
    "",
    ...patch.changes.map((change) => `- ${change.path}`)
  ].join("\n");
}

async function persistTranscript(path: string, request: ModelRequest, response: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ request, response }, null, 2)}\n`, { flag: "wx" });
}

async function readFilesFromMount(root: string | undefined): Promise<Array<{ path: string; contents: string }>> {
  if (!root || !(await exists(root))) {
    return [];
  }
  const files = await listTextFiles(root);
  return Promise.all(
    files.map(async (path) => ({
      path: relative(root, path),
      contents: await readFile(path, "utf8")
    }))
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
const MAX_FILE_CHARS = 80_000;
const MAX_FILE_SET_CHARS = 240_000;

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

function formatFileSet(files: Array<{ path: string; contents: string }>, label: string): string {
  if (files.length === 0) {
    return "(none)";
  }
  let remainingChars = MAX_FILE_SET_CHARS;
  const formatted: string[] = [];
  let omittedFiles = 0;

  for (const file of files) {
    const separatorOverhead = formatted.length > 0 ? "\n\n".length : 0;
    const heading = `### ${file.path}\n\n`;
    const fenceOverhead = fenced("").length;
    const renderedOverhead = separatorOverhead + heading.length + fenceOverhead;

    if (remainingChars <= renderedOverhead) {
      omittedFiles++;
      continue;
    }

    const maxContentsChars = Math.min(MAX_FILE_CHARS, remainingChars - renderedOverhead);
    const contents = truncateText(file.contents, maxContentsChars, `${label}/${file.path}`);
    remainingChars -= renderedOverhead + contents.length;
    formatted.push(`${heading}${fenced(contents)}`);
  }

  if (omittedFiles > 0) {
    formatted.push(
      `[${omittedFiles} file(s) omitted from ${label}; ${MAX_FILE_SET_CHARS} char file-set budget exhausted.]`
    );
  }

  return formatted.join("\n\n");
}

function fenced(contents: string): string {
  return `\`\`\`\n${contents}\n\`\`\``;
}

function truncateText(contents: string, maxChars: number, label: string): string {
  if (contents.length <= maxChars) {
    return contents;
  }
  if (maxChars <= 0) {
    return "";
  }
  const keptChars = Math.max(0, maxChars - 128);
  const marker = `\n\n[truncated ${contents.length - keptChars} chars from ${label}; kept first ${keptChars} chars]\n`;
  return `${contents.slice(0, keptChars)}${marker}`.slice(0, maxChars);
}

function fencedJson(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}
