import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { EvalScore, ProjectConfig } from "../src/schemas.js";

export async function tempProject(prefix = "autoresearch-") {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function writeFixture(root: string, config: unknown, evals: unknown) {
  await mkdir(join(root, "evals"), { recursive: true });
  await mkdir(join(root, "reference"), { recursive: true });
  await mkdir(join(root, "input"), { recursive: true });
  await writeFile(join(root, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(join(root, "evals", "eval-cases.json"), `${JSON.stringify(evals, null, 2)}\n`);
  await writeFile(join(root, "evals", "rubric.md"), "# Rubric\n\nScore the configured dimensions.\n");
  await writeFile(join(root, "reference", "context.md"), "Reference material\n");
}

export const securityConfig = {
  skill_name: "frontend-security",
  topic_group: "frontend-injection-and-defence",
  origin_skill: "~/dev/claude-toolkit/skills/frontend-security",
  target_score: 2.7,
  max_iterations: 5,
  max_concurrency: 2,
  model: {
    provider: "anthropic",
    name: "claude-sonnet-4-6"
  },
  roles: {
    judge: "judge",
    skill_builder: "skill-builder"
  },
  tracks: [
    {
      id: "audit",
      eval_type: "detect-and-fix",
      role: "security-auditor",
      target_skill: "security-audit",
      requires_description: false
    },
    {
      id: "authoring",
      eval_type: "secure-author",
      role: "secure-author",
      target_skill: "secure-authoring",
      requires_description: true
    }
  ]
} satisfies ProjectConfig;

export const syntheticConfig = {
  skill_name: "release-notes",
  topic_group: "developer-communications",
  target_score: 0.8,
  max_iterations: 3,
  max_concurrency: 1,
  roles: {
    judge: "judge",
    skill_builder: "skill-builder"
  },
  tracks: [
    {
      id: "summarise",
      eval_type: "summarise-changelog",
      role: "release-editor",
      target_skill: "release-summary",
      requires_description: false
    }
  ]
} satisfies ProjectConfig;

export const securityEvals = {
  evals: [
    {
      id: "xss-001",
      eval_type: "detect-and-fix",
      title: "Detect reflected XSS",
      input: {},
      expectations: {},
      scoring_dimensions: [{ id: "finding", label: "Finding", max_score: 2 }]
    },
    {
      id: "author-001",
      eval_type: "secure-author",
      title: "Author safe DOM code",
      input: {},
      expectations: {},
      scoring_dimensions: [{ id: "safety", label: "Safety", max_score: 3 }]
    }
  ]
};

export const syntheticEvals = {
  evals: [
    {
      id: "notes-001",
      eval_type: "summarise-changelog",
      title: "Summarise changes",
      input: {},
      expectations: {},
      scoring_dimensions: [{ id: "clarity", label: "Clarity", max_score: 1 }]
    }
  ]
};

export function score(eval_id: string, eval_type: string, track_id: string, total_score = 1, max_score = 1): EvalScore {
  return {
    eval_id,
    eval_type,
    track_id,
    total_score,
    max_score,
    dimensions: [{ id: "clarity", score: total_score, max_score, rationale: "Clear" }],
    summary: "Good"
  };
}
