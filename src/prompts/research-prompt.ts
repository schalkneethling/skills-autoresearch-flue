import { AggregateReport } from "../aggregate.js";
import { SkillResearchRequest } from "../orchestrator.js";
import { EvalScore, GuidanceLedger } from "../schemas.js";
import { formatFileSet, fencedJson, MountedFile } from "./shared.js";

export interface ResearchPromptInput {
  request: SkillResearchRequest;
  workspaceDir: string;
  skillFiles: MountedFile[];
  referenceFiles: MountedFile[];
  seedReferenceFiles: MountedFile[];
  evalFiles: MountedFile[];
  guidanceLedger: GuidanceLedger;
}

export function buildResearchPrompt({
  request,
  workspaceDir,
  skillFiles,
  referenceFiles,
  seedReferenceFiles,
  evalFiles,
  guidanceLedger
}: ResearchPromptInput): string {
  return [
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
    ...formatRegressionContext(request.baselineScores, request.previousScores, request.previousAggregate),
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
    ...formatGuidanceContext(seedReferenceFiles, guidanceLedger),
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
      resource_decisions: [
        {
          path: "SKILL.md",
          placement: "skill",
          reason: "Core procedural guidance needed whenever the skill runs."
        },
        {
          path: "references/domain-rules.md",
          placement: "reference",
          reason: "Stable domain detail that should be loaded only when needed."
        }
      ],
      changes: [
        { path: "SKILL.md", contents: "Complete replacement file contents." },
        { path: "references/domain-rules.md", contents: "Complete reference file contents." }
      ]
    }),
    "Each change path must be relative to the skill directory.",
    "Classify every changed file in resource_decisions, using the same path exactly once.",
    "Use placement skill for SKILL.md core workflow instructions, reference for stable domain facts or detailed guidance under references/, script for fragile or repeated deterministic logic under scripts/, and asset for reusable output templates or media under assets/.",
    "Keep SKILL.md concise. Link to each bundled resource from SKILL.md and say when to read, run, or reuse it so the skill progressively discloses detail instead of loading everything up front.",
    "Do not duplicate the same material in SKILL.md and a bundled resource.",
    "For text assets, return their exact contents. Do not invent binary file contents.",
    "Changed files under scripts/ receive focused built-in syntax validation after the patch is applied. Prefer a supported, self-contained script format; validation results or an explicit skipped note will be recorded in RESEARCH.md.",
    "Use guidance entries to update the guidance ledger whenever you inspect, use, defer, ignore, or need more seed/reference guidance.",
    "Prefer the smallest effective change over recreating or expanding the whole reference skill.",
    "Do not copy seed/reference files wholesale unless the scores show the current candidate is missing that entire file's behavior.",
    "If the aggregate target is already close, focus on the specific score gaps and avoid changes that could regress stronger eval cases.",
    "After iteration 1, prefer the guidance ledger and seed/reference index first; pull exact seed/reference content only when the latest failures justify it."
  ].join("\n");
}

function formatRegressionContext(
  baselineScores: EvalScore[],
  previousScores: EvalScore[],
  previousAggregate: AggregateReport
): string[] {
  const regressions = scoreRegressions(baselineScores, previousScores);
  if (regressions.length === 0) {
    return [
      "Regression guard:",
      "No previous eval total-score regressions are currently known relative to the baseline."
    ];
  }

  return [
    "Regression guard:",
    `The previous candidate score ${previousAggregate.overall.normalizedScore} is not enough on its own if an eval regressed from baseline.`,
    "Fix these regressions while preserving the aggregate gains:",
    ...regressions.map(
      (regression) =>
        `- ${regression.evalId}: baseline ${regression.baselineScore}/${regression.baselineMaxScore}, previous ${regression.previousScore}/${regression.previousMaxScore}`
    )
  ];
}

function scoreRegressions(baselineScores: EvalScore[], previousScores: EvalScore[]) {
  const previousByEval = new Map(previousScores.map((score) => [score.eval_id, score]));
  return baselineScores
    .map((baseline) => {
      const previous = previousByEval.get(baseline.eval_id);
      if (previous && previous.total_score >= baseline.total_score) {
        return undefined;
      }
      return {
        evalId: baseline.eval_id,
        baselineScore: baseline.total_score,
        baselineMaxScore: baseline.max_score,
        previousScore: previous?.total_score ?? 0,
        previousMaxScore: previous?.max_score ?? 0
      };
    })
    .filter((regression): regression is NonNullable<typeof regression> => Boolean(regression));
}

function formatGuidanceContext(seedReferenceFiles: MountedFile[], ledger: GuidanceLedger): string[] {
  if (seedReferenceFiles.length === 0) {
    return ["Seed/reference skill guidance:", "No seed/reference skill files are configured."];
  }

  return [
    "Guidance ledger:",
    fencedJson(ledger),
    "",
    "Seed/reference skill index:",
    formatGuidanceIndex(seedReferenceFiles),
    "",
    "Use the seed/reference files as progressive guidance. Start from the index and ledger; only consult or copy exact seed/reference content when a current score gap clearly justifies that section."
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
