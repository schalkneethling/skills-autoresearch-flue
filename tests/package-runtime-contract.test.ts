import { execFile } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runDeterminizationReport } from "../packages/skills-autoresearch/src/determinization/run.js";
import { StaticDeterminizationTransport } from "../packages/skills-autoresearch/src/determinization/transport.js";
import { loadAvailableFlueRoles } from "../packages/skills-autoresearch/src/flue-roles.js";
import { orchestrateBaseline } from "../packages/skills-autoresearch/src/orchestrator.js";
import type { EvalAgent } from "../packages/skills-autoresearch/src/runner.js";
import { score, syntheticConfig, syntheticEvals, tempProject, writeFixture } from "./helpers.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const packageRoot = join(repositoryRoot, "packages", "skills-autoresearch");
const catalogRoot = join(packageRoot, "catalog", "deterministic-assets");
const fixtureProject = join(repositoryRoot, "fixtures", "projects", "release-notes-alpha");
const fixtureResponse = join(
  repositoryRoot,
  "fixtures",
  "expected",
  "determinization",
  "release-notes-alpha",
  "analysis-response.json"
);
const execFileAsync = promisify(execFile);

type PackageManifest = {
  version: string;
  bin: Record<"skills-autoresearch" | "skills-autoresearch-flue", string>;
};

async function recordedResponse(): Promise<unknown> {
  return JSON.parse(await readFile(fixtureResponse, "utf8")) as unknown;
}

async function fromUnrelatedDirectory<T>(run: () => Promise<T>): Promise<T> {
  const original = process.cwd();
  const unrelated = await tempProject("skills autoresearch unrelated cwd-");
  try {
    process.chdir(unrelated);
    return await run();
  } finally {
    process.chdir(original);
  }
}

test("the bundled catalog is used outside the checkout and an explicit override remains supported", async () => {
  const outputRoot = await tempProject("skills autoresearch default catalog output-");
  const defaultResult = await fromUnrelatedDirectory(async () =>
    runDeterminizationReport({
      projectRoot: fixtureProject,
      outputRoot,
      transport: new StaticDeterminizationTransport(await recordedResponse())
    })
  );
  expect(defaultResult).toMatchObject({ opportunityCount: 1, recommendationCount: 3, cost: { actualCalls: 0 } });

  const overrideRoot = join(await tempProject("skills autoresearch catalog override-"), "catalog with spaces");
  await cp(catalogRoot, overrideRoot, { recursive: true });
  const overrideCatalogPath = join(overrideRoot, "language.json");
  const overrideCatalog = JSON.parse(await readFile(overrideCatalogPath, "utf8")) as {
    assets: Array<{ contribution: string }>;
  };
  const overrideMarker = "override-catalog-marker";
  overrideCatalog.assets[0].contribution = overrideMarker;
  await writeFile(overrideCatalogPath, `${JSON.stringify(overrideCatalog, null, 2)}\n`, "utf8");
  let observedPrompt = "";
  const recordedTransport = new StaticDeterminizationTransport(await recordedResponse());
  const overrideResult = await fromUnrelatedDirectory(async () =>
    runDeterminizationReport({
      projectRoot: fixtureProject,
      outputRoot: await tempProject("skills autoresearch override output-"),
      catalogRoot: overrideRoot,
      transport: {
        name: recordedTransport.name,
        makesModelCall: recordedTransport.makesModelCall,
        analyze(request) {
          observedPrompt = request.prompt;
          return recordedTransport.analyze(request);
        }
      }
    })
  );
  expect(overrideResult).toMatchObject({ opportunityCount: 1, recommendationCount: 3, cost: { actualCalls: 0 } });
  expect(observedPrompt).toContain(overrideMarker);
});

test("role validation reads the selected project rather than the caller's working directory", async () => {
  const projectRoot = await tempProject("skills autoresearch project with spaces-");
  const roles = { judge: "project-judge", skill_builder: "project-builder", producer: "project-producer" };
  await writeFixture(
    projectRoot,
    {
      ...syntheticConfig,
      roles: { judge: roles.judge, skill_builder: roles.skill_builder },
      tracks: [{ ...syntheticConfig.tracks[0], role: roles.producer }]
    },
    syntheticEvals
  );
  await mkdir(join(projectRoot, "roles"), { recursive: true });
  await Promise.all(
    Object.values(roles).map((role) => writeFile(join(projectRoot, "roles", `${role}.md`), `# ${role}\n`))
  );
  const agent: EvalAgent = {
    async run(request) {
      return score(request.evalCase.id, request.evalCase.eval_type, request.track.id);
    }
  };

  const result = await fromUnrelatedDirectory(() => orchestrateBaseline({ projectRoot, agent }));
  expect(result.aggregate.overall.normalizedScore).toBe(1);
});

test("the release-notes fixture carries every Flue role named by its configuration", async () => {
  const config = JSON.parse(await readFile(join(fixtureProject, "config.json"), "utf8")) as {
    roles: { judge: string; skill_builder: string };
    tracks: Array<{ role: string }>;
  };

  expect(await loadAvailableFlueRoles(fixtureProject)).toEqual(
    [config.roles.judge, config.roles.skill_builder, ...config.tracks.map((track) => track.role)].sort()
  );
});

test("both public CLI entrypoints report the package version from a directory with spaces", async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as PackageManifest;
  expect(Object.keys(manifest.bin).sort()).toEqual(["skills-autoresearch", "skills-autoresearch-flue"]);
  await execFileAsync(process.execPath, [
    join(repositoryRoot, "node_modules", "typescript", "bin", "tsc"),
    "-p",
    join(packageRoot, "tsconfig.json")
  ]);

  for (const [name, binary] of Object.entries(manifest.bin)) {
    const binaryPath = join(packageRoot, binary);
    const version = await fromUnrelatedDirectory(() => execFileAsync(process.execPath, [binaryPath, "--version"]));
    expect(version).toMatchObject({ stdout: `${manifest.version}\n`, stderr: "" });

    await expect(
      fromUnrelatedDirectory(() => execFileAsync(process.execPath, [binaryPath, "--version", "smoke"]))
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        name === "skills-autoresearch" ? "Unknown option '--version'" : "--version must be used on its own."
      )
    });
  }
});
