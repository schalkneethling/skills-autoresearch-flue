import { ModelConfig, ProjectConfig } from "./schemas.js";

export const DEFAULT_MODEL: ModelConfig = {
  provider: "anthropic",
  name: "claude-sonnet-4-6"
};

export interface ModelOverride {
  provider?: string;
  name?: string;
}

export function resolveModel(config: ProjectConfig, override?: ModelOverride): ModelConfig {
  const provider = override?.provider ?? config.model?.provider ?? DEFAULT_MODEL.provider;
  const name = override?.name ?? config.model?.name ?? DEFAULT_MODEL.name;

  if (provider !== "anthropic") {
    throw new Error(`Unsupported model provider "${provider}"`);
  }
  if (!name) {
    throw new Error("Model name is required");
  }

  const model: ModelConfig = {
    provider,
    name
  };

  return model;
}
