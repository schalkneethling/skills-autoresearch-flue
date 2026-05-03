import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AnthropicMessagesClient,
  buildEvalModelRequest,
  buildResearchModelRequest,
  ModelClient,
  ModelEvalAgent,
  ModelSkillResearcher,
  ModelRequest
} from "../src/model-agent.js";
import { createEvalSandbox } from "../src/sandbox.js";
import { trackForEval } from "../src/project.js";
import { score, syntheticConfig, syntheticEvals, tempProject, writeFixture } from "./helpers.js";
import { loadProject } from "../src/project.js";

class MemoryModelClient implements ModelClient {
  requests: ModelRequest[] = [];

  constructor(private readonly response: string) {}

  async complete(request: ModelRequest): Promise<string> {
    this.requests.push(request);
    return this.response;
  }
}

test("buildEvalModelRequest includes eval, mounted files, and target skill context", async () => {
  const root = await tempProject();
  await writeFixture(root, syntheticConfig, syntheticEvals);
  const skillDir = join(root, "skill");
  const outputDir = join(root, "out");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(root, "input", "CHANGELOG.md"), "Added parser\n");
  await writeFile(join(skillDir, "SKILL.md"), "# Release skill\n");

  const evalCase = syntheticEvals.evals[0];
  const request = await buildEvalModelRequest({
    evalCase,
    track: trackForEval(syntheticConfig, evalCase.eval_type),
    role: "release-editor",
    targetSkill: "release-summary",
    model: { provider: "anthropic", name: "claude-sonnet-4-6" },
    sandbox: createEvalSandbox({
      evalId: evalCase.id,
      inputDir: join(root, "input"),
      referenceDir: join(root, "reference"),
      evalsDir: join(root, "evals"),
      outputDir,
      skillDir
    })
  });

  expect(request.system).toBe("release-editor");
  expect(request.prompt).toContain("CHANGELOG.md");
  expect(request.prompt).toContain("Added parser");
  expect(request.prompt).toContain("Target skill: release-summary");
  expect(request.prompt).toContain("SKILL.md");
});

test("ModelEvalAgent persists transcripts and parses returned score blocks", async () => {
  const root = await tempProject();
  await writeFixture(root, syntheticConfig, syntheticEvals);
  const evalCase = syntheticEvals.evals[0];
  const evalScore = score(evalCase.id, evalCase.eval_type, "summarise");
  const client = new MemoryModelClient(`\`\`\`json\n${JSON.stringify(evalScore)}\n\`\`\``);
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
    role: "release-editor",
    model: { provider: "anthropic", name: "claude-sonnet-4-6" },
    sandbox
  });

  expect(result.eval_id).toBe(evalCase.id);
  await expect(readFile(join(sandbox.outputDir, "transcript.json"), "utf8")).resolves.toContain("release-editor");
});

test("ModelSkillResearcher snapshots the skill and records research transcript", async () => {
  const root = await tempProject();
  await writeFixture(root, syntheticConfig, syntheticEvals);
  const project = await loadProject(root);
  const previousSkillDir = join(root, "previous-skill");
  const candidateSkillDir = join(root, "candidate-skill");
  await mkdir(previousSkillDir, { recursive: true });
  await writeFile(join(previousSkillDir, "SKILL.md"), "# Previous\n");
  const client = new MemoryModelClient("Improve the examples.");
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

  await expect(readFile(join(candidateSkillDir, "SKILL.md"), "utf8")).resolves.toBe("# Previous\n");
  await expect(readFile(join(candidateSkillDir, "RESEARCH.md"), "utf8")).resolves.toBe("Improve the examples.");
  await expect(readFile(join(candidateSkillDir, ".autoresearch-transcript.json"), "utf8")).resolves.toContain(
    "Improve the examples."
  );
});

test("AnthropicMessagesClient posts messages request and extracts text response", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchStub: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ content: [{ type: "text", text: "Done" }] }), { status: 200 });
  };
  const client = new AnthropicMessagesClient({ apiKey: "test-key", fetch: fetchStub });

  const result = await client.complete({
    model: { provider: "anthropic", name: "claude-sonnet-4-6" },
    system: "system prompt",
    prompt: "user prompt"
  });

  expect(result).toBe("Done");
  expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
  expect((calls[0].init.headers as Record<string, string>)["x-api-key"]).toBe("test-key");
  expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
    model: "claude-sonnet-4-6",
    system: "system prompt",
    messages: [{ role: "user", content: "user prompt" }]
  });
});
