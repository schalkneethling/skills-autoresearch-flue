import { EvalScore, ProjectConfig } from "./schemas.js";

export interface TrackAggregate {
  trackId: string;
  evalType: string;
  targetSkill: string;
  score: number;
  maxScore: number;
  normalizedScore: number;
  evalCount: number;
}

export interface AggregateReport {
  tracks: TrackAggregate[];
  overall: {
    score: number;
    maxScore: number;
    normalizedScore: number;
    evalCount: number;
  };
}

export function aggregateScores(config: ProjectConfig, scores: EvalScore[]): AggregateReport {
  const tracks = config.tracks.map((track) => {
    const trackScores = scores.filter((score) => score.track_id === track.id || score.eval_type === track.eval_type);
    const score = trackScores.reduce((sum, item) => sum + item.total_score, 0);
    const maxScore = trackScores.reduce((sum, item) => sum + item.max_score, 0);
    return {
      trackId: track.id,
      evalType: track.eval_type,
      targetSkill: track.target_skill,
      score,
      maxScore,
      normalizedScore: maxScore === 0 ? 0 : score / maxScore,
      evalCount: trackScores.length
    };
  });

  const score = tracks.reduce((sum, track) => sum + track.score, 0);
  const maxScore = tracks.reduce((sum, track) => sum + track.maxScore, 0);
  const evalCount = tracks.reduce((sum, track) => sum + track.evalCount, 0);

  return {
    tracks,
    overall: {
      score,
      maxScore,
      normalizedScore: maxScore === 0 ? 0 : score / maxScore,
      evalCount
    }
  };
}
