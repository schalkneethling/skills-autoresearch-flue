# 1. Run TypeSafe Jev As A Shadow Judge

## Status

Proposed.

## Context

Every "is this candidate better" decision in the research loop is arithmetic over a single Judge sample per eval.

- `aggregateScores` sums `total_score` and `max_score` across matched tracks and divides them (`packages/skills-autoresearch/src/aggregate.ts:23-66`).
- The loop keeps the iteration with the highest `aggregate.overall.normalizedScore` and compares that number against `project.config.target_score` (`packages/skills-autoresearch/src/orchestrator.ts:509-531`).
- Target attainment is blocked when any eval regressed, where regression is the per-eval comparison `candidate.total_score >= baseline.total_score` (`packages/skills-autoresearch/src/orchestrator.ts:833-848`).
- The Judge produces that number once per eval, from one model call, returning JSON matching `EvalScoreSchema` (`packages/skills-autoresearch/src/prompts/judge-prompt.ts:41-56`, `packages/skills-autoresearch/src/schemas.ts:73-81`).

Judge sampling noise therefore lands directly on acceptance and blocking. We currently have no measurement of how large that noise is.

The harness is also locked to one provider. `ModelProviderSchema` is a picklist of `["anthropic"]` (`packages/skills-autoresearch/src/schemas.ts:3`) and `resolveModel` throws on anything else (`packages/skills-autoresearch/src/model.ts:17-19`). `AGENTS.md:96` records cross-provider judging as planned but not implemented.

A model that returns typed judgments and probability distributions rather than generated text is a plausible complement here, because it gives a per-dimension second reading whose spread is itself a signal, without asking a second text model to re-argue the rubric. TypeSafe's Jev is such a model: its Score primitive returns `score`, `legend`, `probabilities` and `confidence`, and its Noul primitive returns a single `noul` probability between 0 and 1 (verified 2026-09-19 at <https://docs.typesafe.ai/primitives.md> and the SDK's `ScoreResponse` and `NoulResponse` interfaces).

## Decision

Add Jev as a **shadow judge**: it runs alongside the existing Claude Judge, its output is recorded, and it has **no gating effect** on the loop. `EvalScore`, aggregation, regression detection, best-iteration selection and target comparison stay exactly as they are.

### Failure isolation

The shadow judge is best-effort. A failed Jev request, a response that fails schema validation, or a failed shadow artifact write must never alter or discard the Claude Judge result, and must never stop the loop from completing. Each of those failures is caught at the shadow-judge boundary and recorded as a failed shadow status, with the reason, in the shadow artifact; a run with no key configured records a skipped status. When the artifact write itself is what failed, the failure is surfaced through the run log instead, since there is nothing left to write the status into. Caller-initiated aborts are the exception: they propagate as they do for the Judge.

### Shape of the shadow request

For each producer output that the Judge scores, the shadow judge issues one Jev request whose question set is built in code from the eval case:

- one Score question per entry in `evalCase.scoring_dimensions` (`packages/skills-autoresearch/src/schemas.ts:45-49`);
- one Noul question per bullet of the project's `evals/rubric.md`;
- one Noul question per entry of the `must_include` expectation, where the eval case declares one. `expectations` is an open record (`packages/skills-autoresearch/src/schemas.ts:53`), so the code must tolerate its absence.

Question keys are deterministic and prefixed by their source (scoring dimension, rubric bullet, or `must_include` entry), so a dimension id can never overwrite a rubric or expectation question that happens to share its name, and the same eval case yields the same keys on every run. Keys are for code only; the docs state that question IDs are not sent to the model (<https://docs.typesafe.ai/primitives.md>). Before the request is issued, the builder checks the full generated set for duplicate keys and rejects the question set on any collision rather than letting a later entry silently replace an earlier one. A rejected question set is a shadow failure under the isolation rule above. The exact key format is to be decided in implementation.

`state` carries the producer output plus the relevant rubric and reference text, filtered in code. Jev's documented budget is 64k tokens per request with 32k for `state` plus the longest single question (<https://docs.typesafe.ai/models.md>), which is far tighter than the harness's existing 180,000-token prompt budget in `checkedModelRequest` (`packages/skills-autoresearch/src/model-agent.ts:762-779`), so the shadow judge needs its own bound rather than reuse of that one.

How a Jev Score maps onto a dimension's `max_score` is deliberately left open. The Jev docs state the model cannot reliably reconstruct an exact number by interpolating between adjacent levels (<https://docs.typesafe.ai/model-jaggedness/jev-1.13.md>), so a naive linear rescale is not obviously sound. This ADR does not fix a formula.

### Typed output, validated at the boundary

Because the question set is constructed in code, the expected answer shape is known before the request is sent. Two schemas follow from that, both owned by this repository:

1. **A response schema derived from the question set.** Every expected question key present, the correct answer type for each key (a Score answer for dimension questions, a Noul answer for rubric and expectation questions), per-type value checks, and no unknown keys. A Score answer validates `confidence` within [0, 1] and each entry of `probabilities` within [0, 1]; a Noul answer validates `noul` within [0, 1] and carries no `confidence` (<https://docs.typesafe.ai/confidence.md>, <https://docs.typesafe.ai/api.md>). The docs do not state that `probabilities` sum to 1, so the schema does not assert it. This mirrors what the Judge path already does: `parseWithSchema` runs a Valibot `safeParse` and throws a labelled error on failure (`packages/skills-autoresearch/src/schemas.ts:153-165`), and `validateEvalScore` additionally rejects dimensions the eval case did not declare (`packages/skills-autoresearch/src/score.ts:19-35`). The determinization path shows the stricter form to copy, rejecting unknown keys outright via `exactKeys` (`packages/skills-autoresearch/src/determinization/analyzer.ts:115`).

2. **An artifact schema for the persisted shadow record**, covering the audit record for one eval and the per-dimension agreement summary. Determinization artifacts carry a `schema_version` literal (`packages/skills-autoresearch/src/determinization/artifacts.ts:72`) while `EvalScoreSchema` does not; the shadow artifact should follow the versioned determinization convention, since it is a new artifact with no back-compatibility debt. Field names are to be decided in implementation.

The SDK's types do not remove the need for (1). `SystemOneResult<Q>` keys `answers` by question name and derives each answer type through `ResultFor<Q[K]>`, which is genuine compile-time safety over a statically known question map. But the client parses the body with `JSON.parse` and returns `parsed as T` — a cast, not a runtime check (`src/client.ts` in <https://github.com/typesafe-ai/typesafe-sdk-js>, the `#request` method). The SDK's own `validateQuestions` validates the request, not the response (`src/questions.ts`). Our question map is built at runtime from eval-case data, so the compile-time typing is weaker here than it would be for a literal question map, and runtime validation at the trust boundary is required either way.

### Persistence and reporting

Results are written as a separate audit artifact alongside the Judge's `EvalScore`. They never overwrite it and never feed back into it. Writes use the existing exclusive-create discipline (`{ flag: "wx" }`, as in `packages/skills-autoresearch/src/artifact-lifecycle.ts:11` and `packages/skills-autoresearch/src/orchestrator.ts:922-927`), and the new paths are declared in `packages/skills-autoresearch/src/project-layout.ts` rather than constructed at call sites. Agreement is summarised per scoring dimension.

## Integration Constraints

- **Client lives outside Flue.** Flue's provider layer does not cover TypeSafe, and `ModelProviderSchema` admits only `anthropic`. The shadow judge is not a Flue role and must not be wired through `resolveModel`. Whether the provider picklist is eventually widened is a separate decision; for this ADR it stays as it is.
- **SDK versus raw fetch is open.** The published `@typesafe-ai/sdk` (Node 20+, ESM/CJS/types, key from `TYPESAFE_API_KEY`) documents a per-request `signal` as a "cancellation signal for the request and pending retries", and the source's `sleep` helper clears its timer and rejects on abort (`src/retry.ts`). That is consistent with the intent behind `tooling/ast-grep/rules/no-unabortable-delay-in-loop.yml`, though that rule only scans `packages/skills-autoresearch/src/**` and would not cover a dependency. A hand-rolled `fetch` retry loop inside our source **would** be scanned and must honour the caller's signal. A closer read of the SDK, at the version we would pin, is a prerequisite to choosing.
- **Credentials.** The key is referenced from `.env.schema` through Varlock and 1Password, in the same style as the existing `ANTHROPIC_API_KEY` entry (`.env.schema:5`). The exact line is written when the item exists, not from memory.
- **Opt-in only.** `AGENTS.md:89` requires `pnpm run check` and `alpha:smoke` to stay credential-free. The shadow judge is therefore off by default and skipped when no key is configured, so the model-free verification path is untouched.
- **Cost accounting.** `MODEL_PRICING_RULES` is keyed by provider and a model-name pattern, and `TokenPricing` carries input, output and two cache rates (`packages/skills-autoresearch/src/pricing.ts:3-37`). Jev is priced on input only, with output free (docs, 2026-09-19), and `ModelCallRole` is a closed union that does not include a shadow role (`packages/skills-autoresearch/src/cost.ts:7`). Either the accounting types grow a non-Anthropic entry or the shadow judge tracks its own spend separately; this ADR does not pick one.
- **knip.** A new runtime dependency must be reachable from `packages/skills-autoresearch/src/index.ts` or it will be reported unused (`knip.json:10-12`).

## Consequences

Positive:

- A cheap second signal per dimension. At the documented $0.042 per million input tokens with free output, a shadow pass over a small eval set is negligible next to the Judge call it accompanies.
- A concrete step toward the cross-provider judging recorded as planned in `AGENTS.md:96`, without touching the provider picklist yet.
- Probability distributions and a confidence statistic per answer, which is strictly more information than the Judge's single number.
- The measurements are the evidence base for any later noise-aware gating decision.

Negative:

- **No rationale.** Jev is "not trained to generate text" (jaggedness docs). The Judge's `rationale` and `summary` fields are what make a score auditable (`packages/skills-autoresearch/src/schemas.ts:66-81`), so Jev supplements the Judge and cannot replace it.
- **A new vendor and a new secret** in a repo whose guardrails are explicitly about keeping credentials out of files, prompts and transcripts.
- **Documented jaggedness that touches this use case**: literal reading of question wording, unreliable counting, weak numeric and date comparison, degraded accuracy on multi-hop reasoning, and accuracy falling as `state` grows with irrelevant content. Rubric bullets phrased loosely will be read at face value.
- **Injection exposure.** The producer output placed in `state` is model-written, and the docs state that adversarially written content can move the answer. The shadow judge does not gate anything, which bounds the blast radius, but the exposure is real.
- **More artifact surface** to declare, clean up and resume over.
- **Third-party data egress.** Eval inputs, reference text and producer outputs leave for a second vendor. Acceptable for the committed fixture; a consideration for anyone running the harness on private material.

## Alternatives Considered

- **A second Claude Judge sample, or self-consistency over N samples.** No new vendor, no new secret, and it measures the same noise directly. Rejected as the first move because it costs a full Judge call per sample and gives no independent reading — correlated errors stay invisible.
- **A second LLM provider as cross-judge.** This is the thing `AGENTS.md:96` actually names. It is a larger change: the provider picklist, `resolveModel`, pricing rules and the Flue agent layer all move. Worth doing, but not cheaply, and it does not have to come first.
- **Jev as the primary judge.** Rejected. It produces no rationale, which breaks the auditability guardrail, and it is unvalidated on this domain.
- **Do nothing.** Leaves the loop gating on an unmeasured single sample. Acceptable while the fixture has one eval, but it blocks any principled move to noise-aware gating.

## Success And Exit Criteria

A prerequisite gates the whole experiment: the committed fixture has one eval case, one scoring dimension (`clarity`, `max_score` 1), three `must_include` entries and a three-bullet rubric (`fixtures/projects/release-notes-alpha/evals/eval-cases.json`, `fixtures/projects/release-notes-alpha/evals/rubric.md`). Agreement statistics over one case and one dimension are not meaningful. A materially larger eval set must land before any shadow-judge result is interpreted.

Given that, the experiment justifies a follow-up ADR proposing a gating role when, across a larger eval set and several iterations, per-dimension agreement with the Judge is high enough and stable enough that Jev's disagreements consistently track cases where repeated Judge samples also disagree — that is, where the shadow signal predicts Judge instability rather than merely adding a second opinion. The thresholds are set once there is data to set them against.

It should be removed when agreement is no better than chance for the dimensions we care about, when disagreements do not correspond to anything a human reviewer recognises, when the documented jaggedness dominates on this kind of prose-quality judgement, or when the operational cost of the extra vendor, secret and artifact exceeds the value of the signal.

## Out Of Scope

Listed as possible follow-ups only, each needing its own decision record:

- A noise-aware regression gate replacing the strict per-eval `>=` comparison.
- Verification of Judge rationales against producer output.
- Enum classification inside the determinizer.
- Failure tagging of researcher iterations.

## Open Questions

- How a Jev Score maps onto a dimension's `max_score`, given the documented interpolation weakness.
- Whether to depend on `@typesafe-ai/sdk` or call the endpoint directly, pending a read of the pinned SDK source.
- What "agreement" means concretely per dimension, and whether confidence or the raw distribution is the better input to it.
- Whether the shadow record lives under the iteration output directory next to the judge transcript, or in its own workspace location.
- Whether cost accounting grows a non-Anthropic role, or the shadow judge tracks spend separately.
- How rubric bullets are extracted from `rubric.md` reliably enough to build stable question keys across runs.
- Whether unverified vendor claims about the model change the calculus. Note that the TypeSafe confidence documentation describes confidence as a statistic computed from the probability distribution and does not make a calibration claim, so this ADR does not assume calibrated probabilities.
