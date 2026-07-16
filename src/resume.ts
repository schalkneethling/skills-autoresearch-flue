import { readFile, readdir, stat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { isAbsolute, join, relative, resolve } from "node:path";
import { AggregateReport } from "./aggregate.js";
import {
  EvalCase,
  EvalScore,
  EvalScoreSchema,
  ModelProduceResponseSchema,
  OutputFile,
  SkillResearchPatchSchema,
  Track,
  parseWithSchema
} from "./schemas.js";

export type ArtifactInspection<T> =
  | { status: "absent" }
  | { status: "incomplete"; reason: string }
  | { status: "complete"; value: T }
  | { status: "invalid"; reason: string };

export interface ScoreArtifactOptions {
  directory: string;
  index: number;
  evalCase: EvalCase;
  track: Track;
}

export interface ResearchArtifact {
  candidateSkillDir: string;
  markerPath: string;
}

export interface ProducerArtifact {
  transcriptPath: string;
  outputFiles: OutputFile[];
}

export interface JudgeArtifact {
  transcriptPath: string;
  score: EvalScore;
}

const RESEARCH_MARKERS = [
  ".autoresearch-flue-transcript.json",
  ".autoresearch-transcript.json",
  ".autoresearch-iteration.json"
] as const;

const PRODUCER_TRANSCRIPTS = ["producer-flue-transcript.json", "producer-transcript.json"] as const;
const JUDGE_TRANSCRIPTS = ["judge-flue-transcript.json", "judge-transcript.json"] as const;

export async function inspectScoreArtifact(options: ScoreArtifactOptions): Promise<ArtifactInspection<EvalScore>> {
  const path = join(options.directory, `scores-${options.index}.json`);
  const contents = await readOptionalFile(path);
  if (contents.status !== "complete") {
    return contents;
  }

  try {
    const score = parseWithSchema(EvalScoreSchema, JSON.parse(contents.value), path);
    validateScoreIdentity(score, options.evalCase, options.track, path);
    return { status: "complete", value: score };
  } catch (error) {
    return invalid(path, error);
  }
}

export async function findUnexpectedScoreFiles(directory: string, expectedCount: number): Promise<string[]> {
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }

  return files
    .filter((file) => {
      const match = /^scores-(\d+)\.json$/.exec(file);
      return match !== null && Number(match[1]) >= expectedCount;
    })
    .sort((left, right) => scoreIndex(left) - scoreIndex(right));
}

export async function inspectResearchArtifact(
  candidateSkillDir: string,
  iteration: number
): Promise<ArtifactInspection<ResearchArtifact>> {
  const candidateKind = await pathKind(candidateSkillDir);
  const markers = await existingPaths(RESEARCH_MARKERS.map((marker) => join(candidateSkillDir, marker)));

  if (candidateKind === "absent" && markers.length === 0) {
    return { status: "absent" };
  }
  if (candidateKind !== "directory") {
    return {
      status: "invalid",
      reason: `Candidate skill path is ${candidateKind}, expected a directory: ${candidateSkillDir}`
    };
  }
  if (markers.length === 0) {
    return {
      status: "incomplete",
      reason: `Candidate skill directory exists without a research completion marker: ${candidateSkillDir}`
    };
  }
  if (markers.length > 1) {
    return {
      status: "invalid",
      reason: `Candidate skill has multiple research completion markers: ${markers.join(", ")}`
    };
  }

  const markerPath = markers[0];
  const contents = await readOptionalFile(markerPath);
  if (contents.status === "invalid" || contents.status === "incomplete") {
    return contents;
  }
  if (contents.status !== "complete") {
    return {
      status: "invalid",
      reason: `Research completion marker disappeared while inspecting it: ${markerPath}`
    };
  }

  try {
    const marker = JSON.parse(contents.value) as unknown;
    validateResearchMarker(marker, markerPath, iteration);
    if (!(await containsSkillFile(candidateSkillDir))) {
      return {
        status: "incomplete",
        reason: `Candidate skill has a research completion marker but no SKILL.md: ${candidateSkillDir}`
      };
    }
    return {
      status: "complete",
      value: { candidateSkillDir, markerPath }
    };
  } catch (error) {
    return invalid(markerPath, error);
  }
}

export async function inspectProducerArtifact(
  evalOutputDir: string,
  expectedEvalId: string
): Promise<ArtifactInspection<ProducerArtifact>> {
  const transcripts = await existingPaths(PRODUCER_TRANSCRIPTS.map((transcript) => join(evalOutputDir, transcript)));
  if (transcripts.length === 0) {
    return { status: "absent" };
  }
  if (transcripts.length > 1) {
    return {
      status: "invalid",
      reason: `Eval output has multiple producer transcripts: ${transcripts.join(", ")}`
    };
  }

  const transcriptPath = transcripts[0];
  const contents = await readOptionalFile(transcriptPath);
  if (contents.status === "invalid" || contents.status === "incomplete") {
    return contents;
  }
  if (contents.status !== "complete") {
    return {
      status: "invalid",
      reason: `Producer transcript disappeared while inspecting it: ${transcriptPath}`
    };
  }

  try {
    const outputFiles = parseProducerTranscript(transcriptPath, contents.value, expectedEvalId);
    const outputValidation = await validateOutputFiles(evalOutputDir, outputFiles, transcriptPath);
    if (outputValidation) {
      return outputValidation;
    }
    return {
      status: "complete",
      value: { transcriptPath, outputFiles }
    };
  } catch (error) {
    return invalid(transcriptPath, error);
  }
}

export async function inspectJudgeArtifact(
  evalOutputDir: string,
  evalCase: EvalCase,
  track: Track
): Promise<ArtifactInspection<JudgeArtifact>> {
  const transcripts = await existingPaths(JUDGE_TRANSCRIPTS.map((transcript) => join(evalOutputDir, transcript)));
  if (transcripts.length === 0) {
    return { status: "absent" };
  }
  if (transcripts.length > 1) {
    return {
      status: "invalid",
      reason: `Eval output has multiple judge transcripts: ${transcripts.join(", ")}`
    };
  }

  const transcriptPath = transcripts[0];
  const contents = await readOptionalFile(transcriptPath);
  if (contents.status === "invalid") {
    return contents;
  }
  if (contents.status !== "complete") {
    return {
      status: "incomplete",
      reason: `Judge transcript disappeared while inspecting it: ${transcriptPath}`
    };
  }

  try {
    const transcript = parseTranscript(contents.value, transcriptPath);
    validateTranscriptPhase(transcript.request, `judge eval ${evalCase.id}`, transcriptPath);
    const score = parseWithSchema(EvalScoreSchema, parseTranscriptResponse(transcript.response), transcriptPath);
    validateScoreIdentity(score, evalCase, track, transcriptPath);
    return { status: "complete", value: { transcriptPath, score } };
  } catch (error) {
    return invalid(transcriptPath, error);
  }
}

export async function inspectSummaryArtifact(
  summaryPath: string,
  expected?: AggregateReport
): Promise<ArtifactInspection<AggregateReport>> {
  const contents = await readOptionalFile(summaryPath);
  if (contents.status !== "complete") {
    return contents;
  }

  try {
    const summary = JSON.parse(contents.value) as unknown;
    if (!isAggregateReport(summary)) {
      throw new Error("expected an aggregate report");
    }
    if (expected && !isDeepStrictEqual(summary, expected)) {
      throw new Error("does not match the aggregate recomputed from persisted scores");
    }
    return { status: "complete", value: summary };
  } catch (error) {
    return invalid(summaryPath, error);
  }
}

function validateScoreIdentity(score: EvalScore, evalCase: EvalCase, track: Track, path: string): void {
  if (score.eval_id !== evalCase.id) {
    throw new Error(`${path} has eval_id "${score.eval_id}", expected "${evalCase.id}"`);
  }
  if (score.eval_type !== evalCase.eval_type) {
    throw new Error(`${path} has eval_type "${score.eval_type}", expected "${evalCase.eval_type}"`);
  }
  if (score.track_id !== track.id) {
    throw new Error(`${path} has track_id "${score.track_id}", expected "${track.id}"`);
  }

  const knownDimensions = new Set(evalCase.scoring_dimensions.map((dimension) => dimension.id));
  const unknownDimensions = score.dimensions.filter((dimension) => !knownDimensions.has(dimension.id));
  if (unknownDimensions.length > 0) {
    throw new Error(`${path} has unknown dimensions: ${unknownDimensions.map((dimension) => dimension.id).join(", ")}`);
  }
}

function validateResearchMarker(marker: unknown, markerPath: string, iteration: number): void {
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) {
    throw new Error("expected a JSON object");
  }

  if (markerPath.endsWith(".autoresearch-iteration.json")) {
    if ((marker as { iteration?: unknown }).iteration !== iteration) {
      throw new Error(`records a different iteration; expected ${iteration}`);
    }
    return;
  }

  const transcript = marker as { request?: unknown; response?: unknown };
  validateTranscriptPhase(transcript.request, `research iteration ${iteration}`, markerPath);
  parseWithSchema(SkillResearchPatchSchema, parseTranscriptResponse(transcript.response), markerPath);
}

function parseProducerTranscript(transcriptPath: string, contents: string, expectedEvalId: string): OutputFile[] {
  const transcript = parseTranscript(contents, transcriptPath);
  validateTranscriptPhase(transcript.request, `producer eval ${expectedEvalId}`, transcriptPath);
  return parseWithSchema(ModelProduceResponseSchema, parseTranscriptResponse(transcript.response), transcriptPath)
    .output_files;
}

async function validateOutputFiles(
  outputDir: string,
  outputFiles: OutputFile[],
  transcriptPath: string
): Promise<ArtifactInspection<never> | undefined> {
  const seen = new Set<string>();
  for (const outputFile of outputFiles) {
    if (isAbsolute(outputFile.path)) {
      throw new Error(`declares an absolute output path: ${outputFile.path}`);
    }

    const destination = resolve(outputDir, outputFile.path);
    const rel = relative(resolve(outputDir), destination);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`declares an output path outside its eval directory: ${outputFile.path}`);
    }
    if (seen.has(destination)) {
      throw new Error(`declares the output path more than once: ${outputFile.path}`);
    }
    seen.add(destination);

    let actual: string;
    try {
      actual = await readFile(destination, "utf8");
    } catch (error) {
      if (isMissing(error)) {
        return {
          status: "incomplete",
          reason: `Producer transcript ${transcriptPath} declares a missing output file: ${outputFile.path}`
        };
      }
      throw error;
    }
    if (actual !== outputFile.contents) {
      throw new Error(`does not match persisted output file contents: ${outputFile.path}`);
    }
  }

  if (outputFiles.length === 0) {
    throw new Error(`${transcriptPath} does not declare any output files`);
  }
}

function parseTranscript(contents: string, transcriptPath: string): { request: unknown; response: unknown } {
  const transcript = JSON.parse(contents) as unknown;
  if (!transcript || typeof transcript !== "object" || Array.isArray(transcript)) {
    throw new Error("expected a JSON object");
  }
  if (!("request" in transcript) || !("response" in transcript)) {
    throw new Error(`${transcriptPath} must contain request and response fields`);
  }
  return transcript as { request: unknown; response: unknown };
}

function parseTranscriptResponse(response: unknown): unknown {
  return typeof response === "string" ? JSON.parse(response) : response;
}

function validateTranscriptPhase(request: unknown, expectedPhase: string, transcriptPath: string): void {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error(`${transcriptPath} is missing its request object`);
  }
  const phase = (request as { phase?: unknown }).phase;
  if (phase !== expectedPhase) {
    throw new Error(`${transcriptPath} records phase "${String(phase)}", expected "${expectedPhase}"`);
  }
}

async function containsSkillFile(directory: string): Promise<boolean> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name === "SKILL.md") {
      return true;
    }
    if (entry.isDirectory() && (await containsSkillFile(join(directory, entry.name)))) {
      return true;
    }
  }
  return false;
}

function isAggregateReport(value: unknown): value is AggregateReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const report = value as { tracks?: unknown; overall?: unknown };
  if (!Array.isArray(report.tracks) || !isNumericAggregate(report.overall)) {
    return false;
  }
  return report.tracks.every(
    (track) =>
      track !== null &&
      typeof track === "object" &&
      !Array.isArray(track) &&
      typeof (track as { trackId?: unknown }).trackId === "string" &&
      typeof (track as { evalType?: unknown }).evalType === "string" &&
      typeof (track as { targetSkill?: unknown }).targetSkill === "string" &&
      isNumericAggregate(track)
  );
}

function isNumericAggregate(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const aggregate = value as Record<string, unknown>;
  return (
    typeof aggregate.score === "number" &&
    typeof aggregate.maxScore === "number" &&
    typeof aggregate.normalizedScore === "number" &&
    typeof aggregate.evalCount === "number"
  );
}

async function existingPaths(paths: string[]): Promise<string[]> {
  const present = await Promise.all(paths.map(async (path) => ({ path, kind: await pathKind(path) })));
  return present.filter((item) => item.kind !== "absent").map((item) => item.path);
}

async function pathKind(path: string): Promise<"absent" | "file" | "directory" | "other"> {
  try {
    const value = await stat(path);
    if (value.isFile()) {
      return "file";
    }
    if (value.isDirectory()) {
      return "directory";
    }
    return "other";
  } catch (error) {
    if (isMissing(error)) {
      return "absent";
    }
    throw error;
  }
}

async function readOptionalFile(path: string): Promise<ArtifactInspection<string>> {
  try {
    return { status: "complete", value: await readFile(path, "utf8") };
  } catch (error) {
    if (isMissing(error)) {
      return { status: "absent" };
    }
    if ((error as NodeJS.ErrnoException).code === "EISDIR") {
      return { status: "invalid", reason: `Invalid resume artifact ${path}: expected a file` };
    }
    throw error;
  }
}

function invalid(path: string, error: unknown): ArtifactInspection<never> {
  return {
    status: "invalid",
    reason: `Invalid resume artifact ${path}: ${error instanceof Error ? error.message : String(error)}`
  };
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function scoreIndex(file: string): number {
  return Number(/^scores-(\d+)\.json$/.exec(file)?.[1] ?? Number.POSITIVE_INFINITY);
}
