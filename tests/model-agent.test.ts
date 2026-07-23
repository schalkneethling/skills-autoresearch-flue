import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AnthropicMessagesClient,
  applyOutputFiles,
  buildJudgeModelRequest,
  buildProduceModelRequest,
  buildResearchModelRequest,
  ModelClient,
  ModelEvalAgent,
  ModelSkillResearcher,
  ModelRequest,
  parseModelProduceResponse,
  readGuidanceLedger,
  parseSkillResearchPatch,
  validateChangedScripts,
  validateSkillResearchPatch
} from "../src/model-agent.js";
import { createEvalSandbox } from "../src/sandbox.js";
import { trackForEval } from "../src/project.js";
import { score, syntheticConfig, syntheticEvals, tempProject, writeFixture } from "./helpers.js";
import { loadProject } from "../src/project.js";

class MemoryModelClient implements ModelClient {
  requests: ModelRequest[] = [];
  readonly #responses: string[];

  constructor(...responses: string[]) {
    this.#responses = responses;
  }

  async complete(request: ModelRequest): Promise<string> {
    this.requests.push(request);
    const response = this.#responses.shift();
    if (!response) {
      throw new Error("No queued model response");
    }
    return response;
  }
}

test("buildProduceModelRequest includes eval, mounted files, and target skill context", async () => {
  const root = await tempProject();
  await writeFixture(root, syntheticConfig, syntheticEvals);
  const skillDir = join(root, "skill");
  const outputDir = join(root, "out");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(root, "input", "CHANGELOG.md"), "Added parser\n");
  await writeFile(join(skillDir, "SKILL.md"), "# Release skill\n");

  const evalCase = syntheticEvals.evals[0];
  const request = await buildProduceModelRequest({
    evalCase,
    track: trackForEval(syntheticConfig, evalCase.eval_type),
    role: "task-producer",
    targetSkill: "release-summary",
    model: { provider: "anthropic", name: "claude-sonnet-4-6" },
    models: { producer: { provider: "anthropic", name: "claude-haiku-4-5" } },
    sandbox: createEvalSandbox({
      evalId: evalCase.id,
      inputDir: join(root, "input"),
      referenceDir: join(root, "reference"),
      evalsDir: join(root, "evals"),
      outputDir,
      skillDir
    })
  });

  expect(request.system).toBe("task-producer");
  expect(request.model.name).toBe("claude-haiku-4-5");
  expect(request.prompt).toContain("CHANGELOG.md");
  expect(request.prompt).toContain("Added parser");
  expect(request.prompt).toContain("Target skill: release-summary");
  expect(request.prompt).toContain("SKILL.md");
  expect(request.prompt).toContain("Do not score your own work");
});

test("ModelEvalAgent runs producer then judge and persists separate transcripts", async () => {
  const root = await tempProject();
  await writeFixture(root, syntheticConfig, syntheticEvals);
  const evalCase = syntheticEvals.evals[0];
  const evalScore = score(evalCase.id, evalCase.eval_type, "summarise");
  const client = new MemoryModelClient(
    JSON.stringify({
      output_files: [{ path: "RESULT.md", contents: "Summarised changes\n" }]
    }),
    JSON.stringify(evalScore)
  );
  const agent = new ModelEvalAgent(client);
  const sandbox = createEvalSandbox({
    evalId: evalCase.id,
    inputDir: join(root, "input"),
    referenceDir: join(root, "reference"),
    evalsDir: join(root, "evals"),
    outputDir: join(root, "out")
  });

  const result = await agent.run({
    evalCase,
    track: trackForEval(syntheticConfig, evalCase.eval_type),
    role: "task-producer",
    modelRoles: { judge: "eval-judge" },
    model: { provider: "anthropic", name: "claude-sonnet-4-6" },
    models: {
      producer: { provider: "anthropic", name: "claude-haiku-4-5" },
      judge: { provider: "anthropic", name: "claude-sonnet-4-6" }
    },
    sandbox
  });

  expect(result.eval_id).toBe(evalCase.id);
  expect(client.requests.map((request) => request.model.name)).toEqual(["claude-haiku-4-5", "claude-sonnet-4-6"]);
  await expect(readFile(join(sandbox.outputDir, "RESULT.md"), "utf8")).resolves.toBe("Summarised changes\n");
  await expect(readFile(join(sandbox.outputDir, "producer-transcript.json"), "utf8")).resolves.toContain(
    "task-producer"
  );
  await expect(readFile(join(sandbox.outputDir, "judge-transcript.json"), "utf8")).resolves.toContain("eval-judge");
});

test("parseModelProduceResponse requires output files and output writes reject unsafe paths", async () => {
  expect(() => parseModelProduceResponse(JSON.stringify({ output_files: [] }))).toThrow(
    /Invalid model producer response/
  );
  await expect(applyOutputFiles("/tmp/output", [{ path: "../escape.md", contents: "bad" }])).rejects.toThrow(
    /escapes target directory/
  );
});

test("buildJudgeModelRequest scores only producer output with judge model", async () => {
  const root = await tempProject();
  await writeFixture(root, syntheticConfig, syntheticEvals);
  const evalCase = syntheticEvals.evals[0];
  const request = await buildJudgeModelRequest(
    {
      evalCase,
      track: trackForEval(syntheticConfig, evalCase.eval_type),
      role: "task-producer",
      modelRoles: { judge: "eval-judge" },
      model: { provider: "anthropic", name: "claude-sonnet-4-6" },
      models: { judge: { provider: "anthropic", name: "claude-sonnet-4-6" } },
      sandbox: createEvalSandbox({
        evalId: evalCase.id,
        inputDir: join(root, "input"),
        referenceDir: join(root, "reference"),
        evalsDir: join(root, "evals"),
        outputDir: join(root, "out")
      })
    },
    [{ path: "RESULT.md", contents: "Output\n" }]
  );

  expect(request.system).toBe("eval-judge");
  expect(request.prompt).toContain("Producer output files");
  expect(request.prompt).toContain("Score only the producer output");
});

test("buildJudgeModelRequest bounds large producer outputs before judging", async () => {
  const root = await tempProject();
  await writeFixture(root, syntheticConfig, syntheticEvals);
  const evalCase = syntheticEvals.evals[0];
  const request = await buildJudgeModelRequest(
    {
      evalCase,
      track: trackForEval(syntheticConfig, evalCase.eval_type),
      role: "task-producer",
      model: { provider: "anthropic", name: "claude-sonnet-4-6" },
      sandbox: createEvalSandbox({
        evalId: evalCase.id,
        inputDir: join(root, "input"),
        referenceDir: join(root, "reference"),
        evalsDir: join(root, "evals"),
        outputDir: join(root, "out")
      })
    },
    [{ path: "RESULT.md", contents: "x".repeat(250_000) }]
  );

  expect(request.prompt.length).toBeLessThan(120_000);
  expect(request.prompt).toContain("truncated");
  expect(request.prompt).toContain("judge eval notes-001 producer output files/RESULT.md");
});

test("buildProduceModelRequest fails before provider calls when prompt budget is exceeded", async () => {
  const root = await tempProject();
  await writeFixture(root, syntheticConfig, {
    evals: [
      {
        ...syntheticEvals.evals[0],
        expectations: { huge: "x".repeat(800_000) }
      }
    ]
  });
  const evalCase = {
    ...syntheticEvals.evals[0],
    expectations: { huge: "x".repeat(800_000) }
  };

  await expect(
    buildProduceModelRequest({
      evalCase,
      track: trackForEval(syntheticConfig, evalCase.eval_type),
      role: "task-producer",
      model: { provider: "anthropic", name: "claude-sonnet-4-6" },
      sandbox: createEvalSandbox({
        evalId: evalCase.id,
        inputDir: join(root, "input"),
        referenceDir: join(root, "reference"),
        evalsDir: join(root, "evals"),
        outputDir: join(root, "out")
      })
    })
  ).rejects.toThrow(/prompt budget exceeded before producer eval notes-001/);
});

test("ModelSkillResearcher snapshots the skill, applies patch changes, and records transcript", async () => {
  const root = await tempProject();
  await writeFixture(root, syntheticConfig, syntheticEvals);
  const project = await loadProject(root);
  const previousSkillDir = join(root, "previous-skill");
  const candidateSkillDir = join(root, "candidate-skill");
  await mkdir(previousSkillDir, { recursive: true });
  await writeFile(join(previousSkillDir, "SKILL.md"), "# Previous\n");
  await writeFile(join(previousSkillDir, "RESEARCH.md"), "# Old research\n");
  await writeFile(join(previousSkillDir, ".autoresearch-transcript.json"), "{}\n");
  await writeFile(join(previousSkillDir, ".autoresearch-flue-transcript.json"), "{}\n");
  await writeFile(join(previousSkillDir, ".autoresearch-iteration.json"), "{}\n");
  const patch = {
    summary: "Improve the examples.",
    resource_decisions: [
      { path: "SKILL.md", placement: "skill", reason: "Keep the core workflow concise." },
      {
        path: "references/basic.md",
        placement: "reference",
        reason: "Keep detailed examples available on demand."
      },
      { path: "scripts/format.js", placement: "script", reason: "Reuse deterministic formatting logic." },
      { path: "scripts/manual.tool", placement: "script", reason: "Retain a project-specific helper." },
      { path: "assets/template.md", placement: "asset", reason: "Reuse the output template." }
    ],
    changes: [
      { path: "SKILL.md", contents: "# Updated\n" },
      { path: "references/basic.md", contents: "Use concise release notes.\n" },
      { path: "scripts/format.js", contents: "export const format = (value) => String(value).trim();\n" },
      { path: "scripts/manual.tool", contents: "project-specific helper\n" },
      { path: "assets/template.md", contents: "# Release\n\n{{summary}}\n" }
    ]
  };
  const client = new MemoryModelClient(JSON.stringify(patch));
  const researcher = new ModelSkillResearcher(client);

  const modelRequest = await buildResearchModelRequest({
    project,
    iteration: 1,
    previousSkillDir,
    candidateSkillDir,
    baselineScores: [],
    previousScores: [],
    previousAggregate: {
      tracks: [],
      overall: { score: 0, maxScore: 1, normalizedScore: 0, evalCount: 0 }
    }
  });

  expect(modelRequest.prompt).toContain("Current skill files");
  expect(modelRequest.prompt).toContain("# Previous");
  expect(modelRequest.prompt).toContain("Classify every changed file in resource_decisions");
  expect(modelRequest.prompt).toContain("stable domain facts or detailed guidance under references/");
  expect(modelRequest.prompt).toContain("fragile or repeated deterministic logic under scripts/");
  expect(modelRequest.prompt).toContain("reusable output templates or media under assets/");

  await researcher.improve({
    project,
    iteration: 1,
    previousSkillDir,
    candidateSkillDir,
    baselineScores: [],
    previousScores: [],
    previousAggregate: {
      tracks: [],
      overall: { score: 0, maxScore: 1, normalizedScore: 0, evalCount: 0 }
    }
  });

  await expect(readFile(join(candidateSkillDir, "SKILL.md"), "utf8")).resolves.toBe("# Updated\n");
  await expect(readFile(join(candidateSkillDir, "references", "basic.md"), "utf8")).resolves.toBe(
    "Use concise release notes.\n"
  );
  await expect(readFile(join(candidateSkillDir, "scripts", "format.js"), "utf8")).resolves.toContain("trim()");
  await expect(readFile(join(candidateSkillDir, "assets", "template.md"), "utf8")).resolves.toContain("{{summary}}");
  await expect(readFile(join(candidateSkillDir, "RESEARCH.md"), "utf8")).resolves.toContain("Improve the examples.");
  await expect(readFile(join(candidateSkillDir, "RESEARCH.md"), "utf8")).resolves.toContain(
    "`references/basic.md` — reference"
  );
  await expect(readFile(join(candidateSkillDir, "RESEARCH.md"), "utf8")).resolves.toContain(
    "`scripts/format.js` — passed"
  );
  await expect(readFile(join(candidateSkillDir, "RESEARCH.md"), "utf8")).resolves.toContain(
    "`scripts/manual.tool` — skipped"
  );
  await expect(readFile(join(candidateSkillDir, ".autoresearch-transcript.json"), "utf8")).resolves.toContain(
    "SKILL.md"
  );
  await expect(stat(join(candidateSkillDir, ".autoresearch-flue-transcript.json"))).rejects.toMatchObject({
    code: "ENOENT"
  });
  await expect(stat(join(candidateSkillDir, ".autoresearch-iteration.json"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(candidateSkillDir, "RESEARCH.md"), "utf8")).resolves.not.toContain("Old research");
});

test("buildResearchModelRequest uses progressive seed guidance and regression context", async () => {
  const root = await tempProject();
  await writeFixture(root, { ...syntheticConfig, research_start: "empty" }, syntheticEvals);
  const project = await loadProject(root);
  const previousSkillDir = join(root, "previous-skill");
  const guidanceSkillDir = join(root, "seed-skill");
  const guidanceLedgerPath = join(root, "workspace", "guidance-ledger.json");
  await mkdir(previousSkillDir, { recursive: true });
  await mkdir(guidanceSkillDir, { recursive: true });
  await writeFile(join(previousSkillDir, "SKILL.md"), "# Candidate\n");
  await writeFile(
    join(guidanceSkillDir, "SKILL.md"),
    "# Seed Skill\n\n## Breaking changes\n\nMention risky changes.\n\n## Tone\n\nBe concise.\n"
  );
  await mkdir(join(root, "workspace"), { recursive: true });
  await writeFile(
    guidanceLedgerPath,
    `${JSON.stringify(
      {
        entries: [
          {
            iteration: 1,
            source: "seed-reference/SKILL.md",
            section: "Breaking changes",
            action: "used",
            reason: "The first failure missed risk notes.",
            appliedTo: "SKILL.md"
          }
        ]
      },
      null,
      2
    )}\n`
  );

  const first = await buildResearchModelRequest({
    project,
    iteration: 1,
    previousSkillDir,
    candidateSkillDir: join(root, "candidate-1"),
    guidanceSkillDir,
    guidanceLedgerPath,
    baselineScores: [score("missing-case", "summarise-changelog", "summarise", 1)],
    previousScores: [],
    previousAggregate: {
      tracks: [],
      overall: { score: 0, maxScore: 1, normalizedScore: 0, evalCount: 0 }
    }
  });

  expect(first.prompt).toContain("Guidance ledger");
  expect(first.prompt).toContain("Seed/reference skill index");
  expect(first.prompt).toContain("Breaking changes");
  expect(first.prompt).not.toContain("Mention risky changes.");
  expect(first.prompt).toContain("Prefer the smallest effective change");
  expect(first.prompt).toContain("missing-case: baseline 1/1, previous 0/0");

  const second = await buildResearchModelRequest({
    project,
    iteration: 2,
    previousSkillDir,
    candidateSkillDir: join(root, "candidate-2"),
    guidanceSkillDir,
    guidanceLedgerPath,
    baselineScores: [],
    previousScores: [],
    previousAggregate: {
      tracks: [],
      overall: { score: 0, maxScore: 1, normalizedScore: 0, evalCount: 0 }
    }
  });

  expect(second.prompt).toContain("Guidance ledger");
  expect(second.prompt).toContain("Seed/reference skill index");
  expect(second.prompt).toContain("Breaking changes");
  expect(second.prompt).not.toContain("Mention risky changes.");
});

test("ModelSkillResearcher appends guidance decisions to the ledger", async () => {
  const root = await tempProject();
  await writeFixture(root, syntheticConfig, syntheticEvals);
  const project = await loadProject(root);
  const previousSkillDir = join(root, "previous-skill");
  const candidateSkillDir = join(root, "candidate-skill");
  const guidanceLedgerPath = join(root, "workspace", "guidance-ledger.json");
  await mkdir(previousSkillDir, { recursive: true });
  await writeFile(join(previousSkillDir, "SKILL.md"), "# Previous\n");
  const client = new MemoryModelClient(
    JSON.stringify({
      summary: "Apply relevant seed guidance.",
      guidance: [
        {
          source: "seed-reference/SKILL.md",
          section: "Breaking changes",
          action: "used",
          reason: "Judge rationale called out missing breaking-change risk.",
          appliedTo: "SKILL.md"
        }
      ],
      resource_decisions: [{ path: "SKILL.md", placement: "skill", reason: "Apply the core guidance." }],
      changes: [{ path: "SKILL.md", contents: "# Updated\n" }]
    })
  );
  const researcher = new ModelSkillResearcher(client);

  await researcher.improve({
    project,
    iteration: 2,
    previousSkillDir,
    candidateSkillDir,
    guidanceLedgerPath,
    baselineScores: [],
    previousScores: [],
    previousAggregate: {
      tracks: [],
      overall: { score: 0, maxScore: 1, normalizedScore: 0, evalCount: 0 }
    }
  });

  await expect(readGuidanceLedger(guidanceLedgerPath)).resolves.toMatchObject({
    entries: [
      {
        iteration: 2,
        source: "seed-reference/SKILL.md",
        section: "Breaking changes",
        action: "used"
      }
    ]
  });
});

test("readGuidanceLedger reports invalid ledger files with context", async () => {
  const root = await tempProject();
  const guidanceLedgerPath = join(root, "workspace", "guidance-ledger.json");
  await mkdir(join(root, "workspace"), { recursive: true });
  await writeFile(guidanceLedgerPath, "{not json");

  await expect(readGuidanceLedger(guidanceLedgerPath)).rejects.toThrow(/Could not read guidance ledger/);
});

test("parseSkillResearchPatch rejects non-JSON responses and unsafe paths fail during research", async () => {
  expect(() => parseSkillResearchPatch("plain text")).toThrow(/not valid JSON/);

  const root = await tempProject();
  await writeFixture(root, syntheticConfig, syntheticEvals);
  const project = await loadProject(root);
  const previousSkillDir = join(root, "previous-skill");
  const candidateSkillDir = join(root, "candidate-skill");
  await mkdir(previousSkillDir, { recursive: true });
  await writeFile(join(previousSkillDir, "SKILL.md"), "# Previous\n");
  const client = new MemoryModelClient(
    JSON.stringify({ summary: "bad", changes: [{ path: "../escape.md", contents: "bad" }] })
  );
  const researcher = new ModelSkillResearcher(client);

  await expect(
    researcher.improve({
      project,
      iteration: 1,
      previousSkillDir,
      candidateSkillDir,
      baselineScores: [],
      previousScores: [],
      previousAggregate: {
        tracks: [],
        overall: { score: 0, maxScore: 1, normalizedScore: 0, evalCount: 0 }
      }
    })
  ).rejects.toThrow(/escapes target directory/);
  await expect(stat(candidateSkillDir)).rejects.toMatchObject({ code: "ENOENT" });
});

test("validateSkillResearchPatch requires complete, path-consistent resource decisions when reported", () => {
  const root = "/tmp/candidate-skill";
  const patch = parseSkillResearchPatch(
    JSON.stringify({
      summary: "Split stable detail from the core instructions.",
      resource_decisions: [
        { path: "references/rules.md", placement: "script", reason: "Incorrect category for this path." }
      ],
      changes: [
        { path: "SKILL.md", contents: "# Skill\n" },
        { path: "references/rules.md", contents: "# Rules\n" }
      ]
    })
  );

  expect(() => validateSkillResearchPatch(root, patch)).toThrow(/uses placement "script", expected "reference"/);

  const missing = parseSkillResearchPatch(
    JSON.stringify({
      summary: "Report only one of two placement decisions.",
      resource_decisions: [{ path: "SKILL.md", placement: "skill", reason: "Core workflow." }],
      changes: [
        { path: "SKILL.md", contents: "# Skill\n" },
        { path: "assets/template.md", contents: "Template\n" }
      ]
    })
  );
  expect(() => validateSkillResearchPatch(root, missing)).toThrow(
    /missing resource decisions for: assets\/template.md/
  );

  const omitted = parseSkillResearchPatch(
    JSON.stringify({
      summary: "Omit all placement decisions.",
      changes: [{ path: "SKILL.md", contents: "# Skill\n" }]
    })
  );
  expect(() => validateSkillResearchPatch(root, omitted)).toThrow(/missing resource decisions for: SKILL.md/);
});

test("validateChangedScripts records failed syntax checks without executing generated code", async () => {
  const root = await tempProject();
  await mkdir(join(root, "scripts"));
  await writeFile(join(root, "scripts", "broken.js"), "const = ;\n");
  const patch = parseSkillResearchPatch(
    JSON.stringify({
      summary: "Add deterministic logic.",
      resource_decisions: [{ path: "scripts/broken.js", placement: "script", reason: "Reuse deterministic logic." }],
      changes: [{ path: "scripts/broken.js", contents: "const = ;\n" }]
    })
  );

  await expect(validateChangedScripts(root, patch)).resolves.toMatchObject([
    {
      path: "scripts/broken.js",
      status: "failed",
      note: expect.stringContaining("syntax validation failed")
    }
  ]);
});

test("validateChangedScripts passes shell metacharacters as literal path arguments", async () => {
  const root = await tempProject();
  const scriptPath = "scripts/check; echo not-a-command.js";
  await mkdir(join(root, "scripts"));
  await writeFile(join(root, scriptPath), "const valid = true;\n");
  const patch = parseSkillResearchPatch(
    JSON.stringify({
      summary: "Add a script whose path contains shell metacharacters.",
      resource_decisions: [{ path: scriptPath, placement: "script", reason: "Exercise literal arguments." }],
      changes: [{ path: scriptPath, contents: "const valid = true;\n" }]
    })
  );

  const results = await validateChangedScripts(root, patch);

  expect(results).toMatchObject([
    {
      path: scriptPath,
      status: "passed",
      validator: "node --check"
    }
  ]);
  expect(JSON.stringify(results)).not.toContain(root);
});

test("AnthropicMessagesClient posts messages request and extracts text response", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchStub: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: "Done" }],
        usage: { input_tokens: 12, output_tokens: 3 }
      }),
      {
        status: 200
      }
    );
  };
  const client = new AnthropicMessagesClient({ apiKey: "test-key", fetch: fetchStub });

  const result = await client.complete({
    model: { provider: "anthropic", name: "claude-sonnet-4-6" },
    system: "system prompt",
    prompt: "user prompt"
  });

  expect(result).toMatchObject({ text: "Done", usage: { inputTokens: 12, outputTokens: 3 } });
  expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
  expect((calls[0].init.headers as Record<string, string>)["x-api-key"]).toBe("test-key");
  expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
    model: "claude-sonnet-4-6",
    system: "system prompt",
    messages: [{ role: "user", content: "user prompt" }]
  });
});
