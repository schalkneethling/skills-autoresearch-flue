import { EvalCase, EvalScore, EvalScoreSchema, Track, parseWithSchema } from "./schemas.js";

export function extractScoreJson(response: string): unknown {
  try {
    return JSON.parse(response.trim());
  } catch (error) {
    throw new Error(`Judge response was not valid JSON: ${(error as Error).message}`);
  }
}

export function parseEvalScore(response: string, evalCase: EvalCase, track: Track): EvalScore {
  const score = parseWithSchema(EvalScoreSchema, extractScoreJson(response), "judge score");
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

  return score;
}
