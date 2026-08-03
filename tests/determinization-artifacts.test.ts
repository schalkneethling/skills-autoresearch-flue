import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  assertAnalysisArtifactBoundary,
  resumeAnalysisArtifacts,
  writeAnalysisArtifacts
} from "../src/determinization/artifacts.js";
import { serializeCanonical, sha256 } from "../src/determinization/canonical.js";
import { loadDeterministicAssetCatalog } from "../src/determinization/catalog.js";
import type { SourceSelection } from "../src/determinization/source.js";

const catalogIndex = resolve("catalog/deterministic-assets/catalog.json");
const catalogRoot = dirname(catalogIndex);
const catalogPaths = ["catalog.json", "javascript-typescript.json", "language.json", "markdown.json"];

function conciseResponse() {
  return {
    schema_version: "1.0.0",
    opportunities: [
      {
        source_refs: [{ path: "skill/SKILL.md", locator: "Keep the output concise.", evidence_kind: "skill" }],
        normalized_requirement: "Keep the output concise.",
        origin: "skill_guidance",
        classification: "partially_deterministic",
        current_automation_potential: "medium",
        remaining_human_judgment:
          "Editorial judgment must determine whether the result is useful and appropriately concise.",
        recommendations: [
          {
            relationship: "existing",
            asset_kind: "script",
            catalog_asset_id: "catalog_text_metrics",
            proposed_name: "Text metrics",
            contribution: "Word and sentence counts can provide partial signals.",
            confidence: "high",
            expected_improvement: "Adds consistent measurements.",
            supporting_evidence: ["Length is directly measurable."],
            limitations: ["Metrics do not establish editorial quality."],
            alternative_assessments: []
          },
          {
            relationship: "existing",
            asset_kind: "languagetool",
            catalog_asset_id: "catalog_languagetool_existing_families",
            proposed_name: "LanguageTool capability families",
            contribution: "Existing style signals may contribute after later evidence identifies applicable rules.",
            confidence: "medium",
            expected_improvement: "May add repeatable style warnings.",
            supporting_evidence: ["The catalog describes a candidate capability family."],
            limitations: ["No specific rule is established or verified; editorial judgment remains."],
            alternative_assessments: []
          }
        ],
        confidence: "high",
        expected_improvement: "Repeatable signals can reduce inconsistent review without replacing an editor.",
        supporting_evidence: ["Length is measurable, while usefulness and clarity remain contextual."],
        limitations: ["No deterministic asset fully establishes concision."]
      }
    ]
  };
}

async function workspace(prefix: string, selectedCatalogRoot = catalogRoot) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const skill = join(root, "selected-skill");
  const context = join(root, "context");
  await import("node:fs/promises").then(({ mkdir }) => Promise.all([mkdir(skill), mkdir(context)]));
  await writeFile(join(skill, "SKILL.md"), "# Release Summary\n\nKeep the output concise.\n");
  await writeFile(join(context, "rubric.md"), "Prefer useful, concise release notes.\n");
  const selections: SourceSelection[] = [
    { namespace: "skill", root: skill, paths: ["SKILL.md"] },
    { namespace: "context", root: context, paths: ["rubric.md"] },
    { namespace: "catalog", root: selectedCatalogRoot, paths: catalogPaths }
  ];
  return {
    root,
    skill,
    context,
    selections,
    catalogRoot: selectedCatalogRoot,
    catalogIndexPath: join(selectedCatalogRoot, "catalog.json")
  };
}

async function artifactBytes(root: string) {
  const relativePaths = [
    "source.json",
    "opportunities.json",
    "report.md",
    "research-request.json",
    "prompts/research.md",
    "transcript.json"
  ];
  return Promise.all(relativePaths.map((path) => readFile(join(root, path), "utf8")));
}

test("writes deterministic hash-linked artifacts across fresh temporary directories", async () => {
  const first = await workspace("det-artifacts-one-");
  const second = await workspace("det-artifacts-two-");
  const expectedAnalysisRequest = {
    system: "determinize",
    prompt: "analyze",
    model: { provider: "anthropic", name: "fixture" }
  };
  const transcript = { request: expectedAnalysisRequest, response: conciseResponse() };
  const one = await writeAnalysisArtifacts({
    outputRoot: join(first.root, "workspace/determinization"),
    selections: first.selections,
    catalogIndexPath: first.catalogIndexPath,
    analysis: { role: "determinizer", transport: "direct_model", model: { provider: "anthropic", name: "fixture" } },
    analysisResponse: conciseResponse(),
    expectedAnalysisRequest,
    transcript
  });
  const two = await writeAnalysisArtifacts({
    outputRoot: join(second.root, "workspace/determinization"),
    selections: second.selections,
    catalogIndexPath: second.catalogIndexPath,
    analysis: { role: "determinizer", transport: "direct_model", model: { provider: "anthropic", name: "fixture" } },
    analysisResponse: conciseResponse(),
    expectedAnalysisRequest,
    transcript
  });
  expect(await artifactBytes(one.paths.root)).toEqual(await artifactBytes(two.paths.root));
  const canonical = await readFile(one.paths.opportunities, "utf8");
  for (const path of [one.paths.report, one.paths.researchRequest, one.paths.researchPrompt, one.paths.transcript]) {
    expect(await readFile(path, "utf8")).toContain(one.sourceOpportunitiesSha256);
  }
  expect(canonical).not.toContain("audit_only");
  const source = JSON.parse(await readFile(one.paths.source, "utf8")) as {
    analysis: { request_sha256: string; response_sha256: string };
    inputs: Array<{ path: string }>;
  };
  expect(source.inputs.filter(({ path }) => path.startsWith("catalog/")).map(({ path }) => path)).toEqual(
    catalogPaths.map((path) => `catalog/${path}`).sort()
  );
  expect(await readFile(one.paths.source, "utf8")).toContain('"role": "determinizer"');
  expect(source.analysis.request_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(source.analysis.response_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(one.opportunityCount).toBe(1);
  expect(one.recommendationCount).toBe(2);
});

test("resumes only byte-identical artifacts and rejects partial mismatches", async () => {
  const project = await workspace("det-artifacts-resume-");
  const options = {
    outputRoot: join(project.root, "workspace/determinization"),
    selections: project.selections,
    catalogIndexPath: project.catalogIndexPath,
    analysisResponse: conciseResponse()
  };
  const first = await writeAnalysisArtifacts(options);
  const resumed = await writeAnalysisArtifacts(options);
  expect(resumed.resumedFiles.length).toBe(first.createdFiles.length);
  const canonical = await readFile(first.paths.opportunities, "utf8");
  await writeFile(first.paths.opportunities, `${canonical.trimEnd()} \n`);
  await expect(writeAnalysisArtifacts(options)).rejects.toThrow(/does not match canonical bytes/);
  await writeFile(first.paths.opportunities, canonical);
  await writeFile(first.paths.report, "stale report\n");
  await expect(writeAnalysisArtifacts(options)).rejects.toThrow(/does not match canonical bytes/);
  expect(await readFile(first.paths.opportunities, "utf8")).toContain('"schema_version": "1.0.0"');
});

test("leaves selected skill, context, and catalog unchanged on success and failure", async () => {
  const project = await workspace("det-artifacts-readonly-");
  const selected = [
    join(project.skill, "SKILL.md"),
    join(project.context, "rubric.md"),
    ...catalogPaths.map((path) => join(project.catalogRoot, path))
  ];
  const before = await Promise.all(selected.map((path) => readFile(path)));
  await writeAnalysisArtifacts({
    outputRoot: join(project.root, "workspace/determinization"),
    selections: project.selections,
    catalogIndexPath: project.catalogIndexPath,
    analysisResponse: conciseResponse()
  });
  await expect(
    assertAnalysisArtifactBoundary(join(project.skill, "preflight-generated"), project.selections)
  ).rejects.toThrow(/must not be inside/);
  await expect(
    writeAnalysisArtifacts({
      outputRoot: join(project.root, "failed-output"),
      selections: project.selections,
      catalogIndexPath: project.catalogIndexPath,
      analysisResponse: { schema_version: "9.0.0", opportunities: [] }
    })
  ).rejects.toThrow(/Unsupported/);
  expect(await Promise.all(selected.map((path) => readFile(path)))).toEqual(before);
  await expect(
    writeAnalysisArtifacts({
      outputRoot: join(project.skill, "generated"),
      selections: project.selections,
      catalogIndexPath: project.catalogIndexPath,
      analysisResponse: conciseResponse()
    })
  ).rejects.toThrow(/must not be inside/);
  await expect(
    writeAnalysisArtifacts({
      outputRoot: join(project.root, "unselected-catalog-output"),
      selections: project.selections,
      catalogIndexPath: join(project.context, "rubric.md"),
      analysisResponse: conciseResponse()
    })
  ).rejects.toThrow(/selected catalog root/);
  await expect(
    writeAnalysisArtifacts({
      outputRoot: join(project.root, "incomplete-catalog-output"),
      selections: project.selections.map((selection) =>
        selection.namespace === "catalog" ? { ...selection, paths: ["catalog.json"] } : selection
      ),
      catalogIndexPath: project.catalogIndexPath,
      analysisResponse: conciseResponse()
    })
  ).rejects.toThrow(/every schema 1.0.0 domain file/);
  await symlink(project.skill, join(project.root, "redirected-output"));
  await expect(
    writeAnalysisArtifacts({
      outputRoot: join(project.root, "redirected-output/generated"),
      selections: project.selections,
      catalogIndexPath: project.catalogIndexPath,
      analysisResponse: conciseResponse()
    })
  ).rejects.toThrow(/must not be inside/);
});

test("resume rejects tampered, non-canonical, or semantically unrelated transcripts", async () => {
  const project = await workspace("det-artifacts-transcript-resume-");
  const outputRoot = join(project.root, "workspace/determinization");
  const model = { provider: "anthropic", name: "fixture" };
  const response = conciseResponse();
  const expectedAnalysisRequest = { system: "determinize", prompt: "canonical prompt", model };
  await expect(
    writeAnalysisArtifacts({
      outputRoot: join(project.root, "mismatched-transcript"),
      selections: project.selections,
      catalogIndexPath: project.catalogIndexPath,
      analysis: { role: "determinizer", transport: "direct_model", model },
      analysisResponse: response,
      expectedAnalysisRequest,
      transcript: {
        request: { ...expectedAnalysisRequest, prompt: "different prompt" },
        response
      }
    })
  ).rejects.toThrow(/does not match the expected analysis request/);
  const result = await writeAnalysisArtifacts({
    outputRoot,
    selections: project.selections,
    catalogIndexPath: project.catalogIndexPath,
    analysis: { role: "determinizer", transport: "direct_model", model },
    analysisResponse: response,
    expectedAnalysisRequest,
    transcript: {
      request: expectedAnalysisRequest,
      response
    }
  });
  const originalTranscript = await readFile(result.paths.transcript, "utf8");
  await rm(result.paths.report);
  const resume = () =>
    resumeAnalysisArtifacts({
      outputRoot,
      selections: project.selections,
      catalogIndexPath: project.catalogIndexPath,
      expectedModel: model,
      expectedAnalysisRequest
    });

  const wrongSchema = JSON.parse(originalTranscript) as Record<string, unknown>;
  wrongSchema.schema_version = "9.9.9";
  await writeFile(result.paths.transcript, serializeCanonical(wrongSchema));
  await expect(resume()).rejects.toThrow(/transcript provenance/);
  await expect(readFile(result.paths.report, "utf8")).rejects.toThrow(/ENOENT/);

  const wrongRequest = JSON.parse(originalTranscript) as Record<string, unknown>;
  wrongRequest.request = {
    system: "replacement system",
    prompt: "replacement prompt",
    model
  };
  wrongRequest.request_sha256 = sha256(serializeCanonical(wrongRequest.request));
  await writeFile(result.paths.transcript, serializeCanonical(wrongRequest));
  await expect(resume()).rejects.toThrow(/transcript provenance/);

  const wrongResponse = JSON.parse(originalTranscript) as Record<string, unknown>;
  wrongResponse.response = { schema_version: "1.0.0", opportunities: [] };
  wrongResponse.response_sha256 = sha256(serializeCanonical(wrongResponse.response));
  await writeFile(result.paths.transcript, serializeCanonical(wrongResponse));
  await expect(resume()).rejects.toThrow(/transcript provenance/);

  const overwrittenCatalogField = JSON.parse(originalTranscript) as Record<string, unknown>;
  const overwrittenResponse = overwrittenCatalogField.response as {
    opportunities: Array<{ recommendations: Array<Record<string, unknown>> }>;
  };
  overwrittenResponse.opportunities[0].recommendations[0].contribution =
    "Tampered raw claim that normalization would replace";
  overwrittenCatalogField.response_sha256 = sha256(serializeCanonical(overwrittenResponse));
  await writeFile(result.paths.transcript, serializeCanonical(overwrittenCatalogField));
  await expect(resume()).rejects.toThrow(/transcript provenance/);
  await expect(readFile(result.paths.report, "utf8")).rejects.toThrow(/ENOENT/);

  await writeFile(result.paths.transcript, `${originalTranscript.trimEnd()}  \n`);
  await expect(resume()).rejects.toThrow(/transcript provenance/);
});

test("rejects nested output-directory and artifact-file symlinks without writing through them", async () => {
  const directoryProject = await workspace("det-artifacts-directory-symlink-");
  const directoryOutput = join(directoryProject.root, "workspace/determinization");
  await mkdir(directoryOutput, { recursive: true });
  await symlink(directoryProject.skill, join(directoryOutput, "prompts"));
  const skillBefore = await readFile(join(directoryProject.skill, "SKILL.md"), "utf8");
  await expect(
    writeAnalysisArtifacts({
      outputRoot: directoryOutput,
      selections: directoryProject.selections,
      catalogIndexPath: directoryProject.catalogIndexPath,
      analysisResponse: conciseResponse()
    })
  ).rejects.toThrow(/directory component must not be a symlink/);
  expect(await readFile(join(directoryProject.skill, "SKILL.md"), "utf8")).toBe(skillBefore);
  await expect(readFile(join(directoryProject.skill, "research.md"), "utf8")).rejects.toThrow(/ENOENT/);

  const fileProject = await workspace("det-artifacts-file-symlink-");
  const fileOutput = join(fileProject.root, "workspace/determinization");
  await mkdir(fileOutput, { recursive: true });
  await symlink(join(fileProject.skill, "SKILL.md"), join(fileOutput, "opportunities.json"));
  const fileSkillBefore = await readFile(join(fileProject.skill, "SKILL.md"), "utf8");
  await expect(
    writeAnalysisArtifacts({
      outputRoot: fileOutput,
      selections: fileProject.selections,
      catalogIndexPath: fileProject.catalogIndexPath,
      analysisResponse: conciseResponse()
    })
  ).rejects.toThrow(/Artifact file must not be a symlink/);
  expect(await readFile(join(fileProject.skill, "SKILL.md"), "utf8")).toBe(fileSkillBefore);
});

test("report and research projection preserve the read-only phase boundary", async () => {
  const project = await workspace("det-artifacts-claims-");
  const response = conciseResponse();
  response.opportunities[0].supporting_evidence = ["Line one\n# injected heading remains one field."];
  const result = await writeAnalysisArtifacts({
    outputRoot: join(project.root, "workspace/determinization"),
    selections: project.selections,
    catalogIndexPath: project.catalogIndexPath,
    analysisResponse: response
  });
  const report = await readFile(result.paths.report, "utf8");
  expect(report).toContain("partially_deterministic");
  expect(report).toContain("Origin: skill_guidance");
  expect(report).toContain("skill/SKILL.md \\[skill\\]");
  expect(report).toContain("Relationship: existing");
  expect(report).toContain("Catalog reference: catalog_text_metrics");
  expect(report).toContain("Lower-tier alternative assessments");
  expect(report).toContain("Line one \\# injected heading remains one field.");
  expect(report).not.toContain("Line one\n# injected heading");
  expect(report.endsWith("\n")).toBe(true);
  expect(report.endsWith("\n\n")).toBe(false);
  expect(report).toContain("suggested and unverified");
  expect(report).toMatch(/[Ee]ditorial judgment/);
  expect(report).toContain("no LanguageTool signal by itself fully establishes concision");
  expect(report).not.toMatch(/lifecycle_status: (?:verified|adopted)/);
  const prompt = await readFile(result.paths.researchPrompt, "utf8");
  expect(prompt).toContain("read-only evidence request");
  expect(prompt).toContain("authoritative evidence");
  expect(prompt).not.toContain("Apply the");
  expect(prompt).toContain("catalog\\_text\\_metrics");
  expect(prompt).toContain("product or rule versions, language variants, runtime constraints, and configuration");
  expect(prompt).toContain("Contribution: Deterministic metrics can measure properties");
  expect(prompt).toContain("Existing evidence: Catalog capability evidence basis:");
  expect(prompt).toContain("Line one \\# injected heading remains one field.");
  expect(prompt).not.toContain("\n# injected heading");
  const request = JSON.parse(await readFile(result.paths.researchRequest, "utf8")) as {
    opportunity_requests: Array<{
      source_refs: unknown[];
      suggested_assets: Array<{ contribution: string; supporting_evidence: string[]; evidence_questions: string[] }>;
    }>;
  };
  expect(request.opportunity_requests[0].source_refs).toHaveLength(1);
  expect(request.opportunity_requests[0].suggested_assets[0].contribution).toBeTruthy();
  expect(request.opportunity_requests[0].suggested_assets[0].supporting_evidence).toHaveLength(1);
  expect(request.opportunity_requests[0].suggested_assets[0].evidence_questions).toHaveLength(3);
});

test("loads the catalog from selected bytes instead of accepting an earlier stale catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "det-artifacts-catalog-freshness-"));
  const copiedCatalog = join(root, "catalog");
  await mkdir(copiedCatalog);
  await Promise.all(catalogPaths.map((path) => cp(join(catalogRoot, path), join(copiedCatalog, path))));
  const stalePriorLoad = await loadDeterministicAssetCatalog(join(copiedCatalog, "catalog.json"));
  expect(stalePriorLoad.assets.some(({ id }) => id === "catalog_text_metrics")).toBe(true);
  const languagePath = join(copiedCatalog, "language.json");
  const language = JSON.parse(await readFile(languagePath, "utf8")) as { assets: Array<{ id: string }> };
  language.assets = language.assets.filter(({ id }) => id !== "catalog_text_metrics");
  await writeFile(languagePath, `${JSON.stringify(language, null, 2)}\n`);
  const project = await workspace("det-artifacts-catalog-project-", copiedCatalog);
  await expect(
    writeAnalysisArtifacts({
      outputRoot: join(project.root, "workspace/determinization"),
      selections: project.selections,
      catalogIndexPath: project.catalogIndexPath,
      analysisResponse: conciseResponse()
    })
  ).rejects.toThrow(/Unknown catalog asset/);
});

test("catalog capability metadata overrides adversarial model claims while transcript retains the raw response", async () => {
  const project = await workspace("det-artifacts-catalog-claims-");
  const response = conciseResponse();
  const marker = "EXISTING_CONFIGURED_VERIFIED_FULLY_SOLVES_CONCISION";
  const languageTool = response.opportunities[0].recommendations[1];
  languageTool.proposed_name = marker;
  languageTool.contribution = marker;
  languageTool.expected_improvement = marker;
  languageTool.supporting_evidence = [marker];
  languageTool.limitations = [marker];
  const expectedAnalysisRequest = {
    system: "determinize",
    prompt: "analyze catalog claims",
    model: { provider: "anthropic", name: "fixture" }
  };
  const result = await writeAnalysisArtifacts({
    outputRoot: join(project.root, "workspace/determinization"),
    selections: project.selections,
    catalogIndexPath: project.catalogIndexPath,
    analysis: {
      role: "determinizer",
      transport: "direct_model",
      model: { provider: "anthropic", name: "fixture" }
    },
    analysisResponse: response,
    expectedAnalysisRequest,
    transcript: {
      request: expectedAnalysisRequest,
      response
    }
  });
  const canonical = await readFile(result.paths.opportunities, "utf8");
  const report = await readFile(result.paths.report, "utf8");
  const transcript = await readFile(result.paths.transcript, "utf8");
  expect(canonical).not.toContain(marker);
  expect(report).not.toContain(marker);
  expect(canonical).toContain("This catalogs a capability family only");
  expect(report).toContain("suggested (unverified)");
  expect(transcript).toContain(marker);
});
