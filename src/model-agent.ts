import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { SkillResearcher, SkillResearchRequest } from "./orchestrator.js";
import { EvalAgent, EvalAgentRequest } from "./runner.js";
import {
  EvalCase,
  EvalScore,
  EvalScoreSchema,
  ModelConfig,
  ModelProduceResponse,
  ModelProduceResponseSchema,
  OutputFile,
  SkillResearchPatch,
  SkillResearchPatchSchema,
  Track,
  parseWithSchema
} from "./schemas.js";

export interface ModelRequest {
  system: string;
  prompt: string;
  model: {
    provider: string;
    name: string;
  };
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
    await writeFile(join(request.candidateSkillDir, "RESEARCH.md"), formatResearchSummary(patch), { flag: "wx" });
    await persistTranscript(join(request.candidateSkillDir, ".autoresearch-transcript.json"), modelRequest, response);
  }
}

export async function buildProduceModelRequest(request: EvalAgentRequest): Promise<ModelRequest> {
  const inputFiles = await readFilesFromMount(
    request.sandbox.mounts.find((mount) => mount.target === "/input")?.source
  );
  const referenceFiles = await readFilesFromMount(
    request.sandbox.mounts.find((mount) => mount.target === "/reference")?.source
  );
  const skillFiles = await readFilesFromMount(
    request.sandbox.mounts.find((mount) => mount.target === "/skill")?.source
  );

  return {
    model: roleModel(request, "producer"),
    system: request.role,
    prompt: [
      `Run the target skill for "${request.evalCase.title}" (${request.evalCase.id}).`,
      `Eval type: ${request.evalCase.eval_type}`,
      `Track: ${request.track.id}`,
      request.targetSkill ? `Target skill: ${request.targetSkill}` : "Baseline run: no target skill is mounted.",
      "",
      "Eval case JSON:",
      fencedJson(request.evalCase),
      "",
      "Input files:",
      formatFileSet(inputFiles),
      "",
      "Reference files:",
      formatFileSet(referenceFiles),
      "",
      "Skill files:",
      formatFileSet(skillFiles),
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
  };
}

export async function buildJudgeModelRequest(
  request: EvalAgentRequest,
  outputFiles: OutputFile[]
): Promise<ModelRequest> {
  const referenceFiles = await readFilesFromMount(
    request.sandbox.mounts.find((mount) => mount.target === "/reference")?.source
  );

  return {
    model: roleModel(request, "judge"),
    system: request.modelRoles?.judge ?? "judge",
    prompt: [
      `Judge output for "${request.evalCase.title}" (${request.evalCase.id}).`,
      `Eval type: ${request.evalCase.eval_type}`,
      `Track: ${request.track.id}`,
      "",
      "Eval case JSON:",
      fencedJson(request.evalCase),
      "",
      "Reference files:",
      formatFileSet(referenceFiles),
      "",
      "Producer output files:",
      formatFileSet(outputFiles),
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
  };
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
  const skillFiles = await readFilesFromMount(request.previousSkillDir);
  return {
    model: request.project.config.models?.researcher ??
      request.project.config.model ?? { provider: "anthropic", name: "claude-sonnet-4-6" },
    system: request.project.config.roles.skill_builder,
    prompt: [
      `Improve skill "${request.project.config.skill_name}" for iteration ${request.iteration}.`,
      `Topic group: ${request.project.config.topic_group}`,
      `Target normalized score: ${request.project.config.target_score}`,
      `Previous normalized score: ${request.previousAggregate.overall.normalizedScore}`,
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
      formatFileSet(skillFiles),
      "",
      "Return only well-formed JSON with this shape. Do not include markdown, code fences, prose, or XML tags:",
      fencedJson({
        summary: "Brief summary of the intended skill improvement.",
        changes: [{ path: "SKILL.md", contents: "Complete replacement file contents." }]
      }),
      "Each change path must be relative to the skill directory."
    ].join("\n")
  };
}

function roleModel(request: EvalAgentRequest, role: "producer" | "judge"): ModelConfig {
  return request.models?.[role] ?? request.model;
}

export function parseSkillResearchPatch(response: string): SkillResearchPatch {
  const raw = parseJson(response, "Research response");
  return parseWithSchema(SkillResearchPatchSchema, raw, "skill research patch");
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

function formatFileSet(files: Array<{ path: string; contents: string }>): string {
  if (files.length === 0) {
    return "(none)";
  }
  return files.map((file) => `### ${file.path}\n\n${fenced(file.contents)}`).join("\n\n");
}

function fenced(contents: string): string {
  return `\`\`\`\n${contents}\n\`\`\``;
}

function fencedJson(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}
