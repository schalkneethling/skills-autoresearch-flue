import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { EvalScore, EvalScoreSchema, parseWithSchema } from "./schemas.js";

export interface BaselineImport {
  scores: EvalScore[];
  summaries: Record<string, unknown>;
  analyses: Record<string, string>;
  evalArtefacts: Record<string, BaselineEvalArtefact>;
  missing: string[];
}

export interface BaselineEvalArtefact {
  id: string;
  dir: string;
  inputDir: string;
  outputDir: string;
  taskPath: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

function scoreFileIndex(file: string): number {
  const match = file.match(/^scores-(\d+)\.json$/);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

function parseScoreFile(raw: unknown, filePath: string): EvalScore[] {
  if (Array.isArray(raw)) {
    return raw.map((item, index) => parseBaselineScore(item, `${filePath}[${index}]`));
  }

  if (raw && typeof raw === "object" && "scores" in raw && Array.isArray((raw as { scores: unknown }).scores)) {
    return (raw as { scores: unknown[] }).scores.map((item, index) =>
      parseBaselineScore(item, `${filePath}.scores[${index}]`)
    );
  }

  return [parseBaselineScore(raw, filePath)];
}

function parseBaselineScore(raw: unknown, filePath: string): EvalScore {
  try {
    return parseWithSchema(EvalScoreSchema, raw, filePath);
  } catch {
    return normalizeLegacyBaselineScore(raw, filePath);
  }
}

function normalizeLegacyBaselineScore(raw: unknown, filePath: string): EvalScore {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Invalid baseline score ${filePath}: expected object`);
  }

  const score = raw as {
    eval_id?: unknown;
    eval_name?: unknown;
    eval_type?: unknown;
    scores?: unknown;
    composite_score?: unknown;
  };

  if (typeof score.eval_type !== "string" || !score.scores || typeof score.scores !== "object") {
    throw new Error(`Invalid baseline score ${filePath}: missing eval_type or scores`);
  }

  const evalId =
    typeof score.eval_id === "number"
      ? `eval-${score.eval_id}`
      : typeof score.eval_id === "string"
        ? score.eval_id
        : filePath.match(/scores-(\d+)\.json$/)
          ? `eval-${Number(filePath.match(/scores-(\d+)\.json$/)?.[1]) + 1}`
          : "";

  if (!evalId) {
    throw new Error(`Invalid baseline score ${filePath}: missing eval_id`);
  }

  const dimensions = Object.entries(score.scores as Record<string, unknown>).map(([id, value]) => {
    if (!value || typeof value !== "object" || typeof (value as { score?: unknown }).score !== "number") {
      throw new Error(`Invalid baseline score ${filePath}: dimension ${id} is missing numeric score`);
    }
    return {
      id,
      score: (value as { score: number }).score,
      max_score: 3,
      rationale:
        typeof (value as { justification?: unknown }).justification === "string"
          ? (value as { justification: string }).justification
          : "Imported baseline score"
    };
  });

  const totalScore =
    typeof score.composite_score === "number"
      ? score.composite_score
      : dimensions.reduce((sum, dimension) => sum + dimension.score, 0) / Math.max(1, dimensions.length);

  return {
    eval_id: evalId,
    eval_type: score.eval_type,
    track_id: score.eval_type,
    total_score: totalScore,
    max_score: 3,
    dimensions,
    summary: typeof score.eval_name === "string" ? score.eval_name : `Imported ${evalId}`
  };
}

export async function importBaselineArtefacts(baselineDir: string, expectedEvalIds: string[]): Promise<BaselineImport> {
  const missing: string[] = [];
  const scores: EvalScore[] = [];
  const summaries: Record<string, unknown> = {};
  const analyses: Record<string, string> = {};
  const evalArtefacts: Record<string, BaselineEvalArtefact> = {};
  const baselineFiles = await listFiles(baselineDir);
  const scoreFiles = baselineFiles.filter((file) => /^scores-\d+\.json$/.test(file)).sort((a, b) => scoreFileIndex(a) - scoreFileIndex(b));

  for (const evalId of expectedEvalIds) {
    const evalDir = join(baselineDir, evalId);
    const inputDir = join(evalDir, "input");
    const outputDir = join(evalDir, "output");
    const taskPath = join(evalDir, "task.md");

    if (!(await exists(evalDir))) {
      missing.push(evalDir);
      continue;
    }
    for (const required of [inputDir, outputDir, taskPath]) {
      if (!(await exists(required))) {
        missing.push(required);
      }
    }
    evalArtefacts[evalId] = { id: evalId, dir: evalDir, inputDir, outputDir, taskPath };
  }

  if (scoreFiles.length === 0) {
    missing.push(join(baselineDir, "scores-*.json"));
  }

  for (const scoreFile of scoreFiles) {
    const scorePath = join(baselineDir, scoreFile);
    const raw = JSON.parse(await readFile(scorePath, "utf8")) as unknown;
    scores.push(...parseScoreFile(raw, scorePath));
  }

  for (const summaryFile of baselineFiles.filter((file) => /^summary(?:-.+)?\.json$/.test(file))) {
    const summaryPath = join(baselineDir, summaryFile);
    const key = summaryFile.replace(/\.json$/, "");
    summaries[key] = JSON.parse(await readFile(summaryPath, "utf8")) as unknown;
  }

  if (!("summary" in summaries)) {
    missing.push(join(baselineDir, "summary.json"));
  }

  for (const analysisFile of baselineFiles.filter((file) => /^analysis-.+\.md$/.test(file))) {
    const analysisPath = join(baselineDir, analysisFile);
    const key = analysisFile.replace(/^analysis-/, "").replace(/\.md$/, "");
    analyses[key] = await readFile(analysisPath, "utf8");
  }

  return { scores, summaries, analyses, evalArtefacts, missing };
}
