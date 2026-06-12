import { pricingForModel } from "../src/pricing.js";

test("pricingForModel matches only intended full Anthropic model names", () => {
  expect(pricingForModel({ provider: "anthropic", name: "claude-haiku-4-5" })).toBeDefined();
  expect(pricingForModel({ provider: "anthropic", name: "claude-haiku-4-5-20260201" })).toBeDefined();
  expect(pricingForModel({ provider: "anthropic", name: "x-claude-haiku-4-5" })).toBeUndefined();
  expect(pricingForModel({ provider: "anthropic", name: "claude-haiku-4-5-beta" })).toBeUndefined();

  expect(pricingForModel({ provider: "anthropic", name: "claude-sonnet-4" })).toBeDefined();
  expect(pricingForModel({ provider: "anthropic", name: "claude-sonnet-4-20260201" })).toBeDefined();
  expect(pricingForModel({ provider: "anthropic", name: "x-claude-sonnet-4" })).toBeUndefined();
  expect(pricingForModel({ provider: "anthropic", name: "claude-sonnet-4-beta" })).toBeUndefined();
});
