import { defineAgentProfile } from "@flue/runtime";

export const producerProfile = defineAgentProfile({
  name: "producer",
  description: "Produces eval output files by following the mounted skill and eval task.",
  instructions:
    "You produce concrete output files for the current eval task. Follow the mounted skill instructions closely. Produce concrete output files only; do not score your own work."
});

export const judgeProfile = defineAgentProfile({
  name: "judge",
  description: "Scores eval outputs against the eval case, expectations, rubric, and reference material.",
  instructions:
    "You are an independent evaluator. Score only the producer output files against the eval case, expectations, and reference material. Do not give credit for requirements stated in a skill file unless the producer output actually satisfies them. Be specific in rationales. Penalize omissions, invented facts, regressions, unsafe assumptions, and unsupported claims."
});

export const researcherProfile = defineAgentProfile({
  name: "researcher",
  description: "Improves skill instructions based on score feedback and previous outputs.",
  instructions:
    "You improve skill instructions based on evaluation results. Make the smallest effective change that addresses the observed score gap. Preserve the skill's intended scope and avoid overfitting to a single fixture."
});

export const autoresearchProfiles = [producerProfile, judgeProfile, researcherProfile];
