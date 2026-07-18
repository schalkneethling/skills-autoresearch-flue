import { ModelConfig } from "./schemas.js";

export interface TokenPricing {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cacheCreationUsdPerMillion: number;
  cacheReadUsdPerMillion: number;
}

export interface ModelPricingRule {
  provider: ModelConfig["provider"];
  modelPattern: RegExp;
  pricing: TokenPricing;
}

export const MODEL_PRICING_RULES: readonly ModelPricingRule[] = [
  {
    provider: "anthropic",
    modelPattern: /^claude-haiku-4-5(?:-\d+)?$/,
    pricing: {
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 5,
      cacheCreationUsdPerMillion: 1.25,
      cacheReadUsdPerMillion: 0.1
    }
  },
  {
    provider: "anthropic",
    modelPattern: /^claude-sonnet-4(?:-\d+)?$/,
    pricing: {
      inputUsdPerMillion: 3,
      outputUsdPerMillion: 15,
      cacheCreationUsdPerMillion: 3.75,
      cacheReadUsdPerMillion: 0.3
    }
  }
];

export function pricingForModel(model: ModelConfig): TokenPricing | undefined {
  return MODEL_PRICING_RULES.find((rule) => rule.provider === model.provider && rule.modelPattern.test(model.name))
    ?.pricing;
}
