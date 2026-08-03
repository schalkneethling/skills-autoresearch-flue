import { validateConfiguredFlueRoles } from "../src/flue-roles.js";
import { loadProject, trackForEval } from "../src/project.js";
import { resolveModel } from "../src/model.js";
import { resolveDeterminizerModel } from "../src/determinization/run.js";
import {
  securityConfig,
  securityEvals,
  syntheticConfig,
  syntheticEvals,
  tempProject,
  writeFixture
} from "./helpers.js";

test("loads security and synthetic project fixtures without domain branches", async () => {
  const securityRoot = await tempProject();
  const syntheticRoot = await tempProject();
  await writeFixture(securityRoot, securityConfig, securityEvals);
  await writeFixture(syntheticRoot, syntheticConfig, syntheticEvals);

  const security = await loadProject(securityRoot);
  const synthetic = await loadProject(syntheticRoot);

  expect(trackForEval(security.config, "secure-author").target_skill).toBe("secure-authoring");
  expect(trackForEval(synthetic.config, "summarise-changelog").role).toBe("task-producer");
});

test("resolves default model and rejects unsupported providers", async () => {
  const root = await tempProject();
  await writeFixture(root, syntheticConfig, syntheticEvals);
  const project = await loadProject(root);

  expect(resolveModel(project.config)).toEqual({
    provider: "anthropic",
    name: "claude-sonnet-4-6"
  });
  expect(resolveModel(project.config, { name: "claude-opus-4-6" }).name).toBe("claude-opus-4-6");
  expect(() => resolveModel(project.config, { provider: "openai" })).toThrow(/Unsupported model provider/);
});

test("resolves the determinizer model before researcher and default fallbacks", () => {
  expect(
    resolveDeterminizerModel({
      ...syntheticConfig,
      models: {
        researcher: { provider: "anthropic", name: "researcher-model" },
        determinizer: { provider: "anthropic", name: "determinizer-model" }
      }
    })
  ).toEqual({ provider: "anthropic", name: "determinizer-model" });
  expect(
    resolveDeterminizerModel({
      ...syntheticConfig,
      models: { researcher: { provider: "anthropic", name: "researcher-model" } }
    })
  ).toEqual({ provider: "anthropic", name: "researcher-model" });
});

test("requires judge and skill builder role keys", async () => {
  const root = await tempProject();
  await writeFixture(
    root,
    {
      ...syntheticConfig,
      roles: {}
    },
    syntheticEvals
  );

  await expect(loadProject(root)).rejects.toThrow(/roles\.judge/);

  expect(() =>
    validateConfiguredFlueRoles(
      {
        ...syntheticConfig,
        roles: {} as typeof syntheticConfig.roles
      },
      ["eval-judge", "skill-builder", "task-producer"]
    )
  ).toThrow(/missing required fields: roles\.judge, roles\.skill_builder/);
});
