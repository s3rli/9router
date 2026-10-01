import { describe, expect, it } from "vitest";
import { getModelsByProviderId, isValidModel } from "../../open-sse/config/providerModels.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { openaiToKiroRequest } from "../../open-sse/translator/request/openai-to-kiro.js";
import { claudeToKiroRequest } from "../../open-sse/translator/request/claude-to-kiro.js";

const VARIANTS = [
  "claude-opus-5.5",
  "claude-opus-5.5-thinking",
  "claude-opus-5.5-agentic",
  "claude-opus-5.5-thinking-agentic",
];

describe("Kiro Claude Opus 5.5", () => {
  it("lists the base model and its synthetic variants", () => {
    const ids = getModelsByProviderId("kiro").map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(VARIANTS));
  });

  it("accepts the dash-version id clients send (claude-opus-5-5)", () => {
    expect(isValidModel("kr", "claude-opus-5-5-thinking")).toBe(true);
  });

  it.each(VARIANTS)("%s has 1M context and adaptive thinking", (model) => {
    expect(getCapabilitiesForModel("kiro", model)).toMatchObject({
      vision: true,
      reasoning: true,
      thinkingFormat: "claude-adaptive",
      contextWindow: 1000000,
      maxOutput: 128000,
    });
  });

  it.each([
    ["OpenAI", openaiToKiroRequest],
    ["Claude", claudeToKiroRequest],
  ])("%s translator sends the bare upstream id to Kiro", (_name, translate) => {
    const payload = translate("claude-opus-5.5-thinking-agentic", {
      messages: [{ role: "user", content: "hello" }],
    }, true, {});
    expect(payload.conversationState.currentMessage.userInputMessage.modelId).toBe("claude-opus-5.5");
  });
});
