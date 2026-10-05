import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { getModelsByProviderId } from "../../open-sse/config/providerModels.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import * as proxyFetchModule from "../../open-sse/utils/proxyFetch.js";

const credentials = { connectionId: "fixture", accessToken: "fixture-token" };
afterEach(() => vi.restoreAllMocks());

describe("Codex GPT-6 Sol/Luna transport", () => {
  it.each([
    ["gpt-6.1-sol", false],
    ["gpt-6-sol", true],
    ["gpt-6-luna", true],
  ])("lists %s with Codex capabilities", (model, lite) => {
    const entry = getModelsByProviderId("codex").find((item) => item.id === model);
    expect(entry?.responsesLite === true).toBe(lite);
    expect(entry?.thinkingLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(getCapabilitiesForModel("codex", model)).toMatchObject({
      vision: true,
      reasoning: true,
      thinkingFormat: "openai",
    });
    expect(getThinkingLevels("codex", model)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(getThinkingLevels("codex", `${model}(high)`)).toEqual(entry.thinkingLevels);
  });

  it("keeps a native Responses Lite request intact", () => {
    const executor = new CodexExecutor();
    const input = [
      { type: "additional_tools", role: "developer", tools: [{ type: "function", name: "run", parameters: { type: "object", properties: {} } }] },
      { type: "message", id: "msg_native", role: "developer", content: [{ type: "input_text", text: "Native instructions" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
    ];
    const body = executor.transformRequest("gpt-6-luna", {
      model: "gpt-6-luna", input: structuredClone(input), instructions: "", tools: null, parallel_tool_calls: false,
      reasoning: { effort: "high", context: "all_turns" },
    }, true, credentials);
    const headers = executor.buildHeaders(credentials, true, null, "gpt-6-luna");

    expect(headers["x-openai-internal-codex-responses-lite"]).toBe("true");
    expect(body.instructions).toBe("");
    expect(body.tools).toBeNull();
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.input).toEqual(input);
    expect(body.reasoning).toEqual({ effort: "high", context: "all_turns" });
  });

  it("converts an ordinary Responses request to the Lite shape", () => {
    const executor = new CodexExecutor();
    const tool = { type: "function", name: "run", parameters: { type: "object", properties: {} } };
    const body = executor.transformRequest("gpt-6-sol", {
      model: "gpt-6-sol", input: "hello", instructions: "Do the task", tools: [tool],
    }, true, credentials);

    expect(body.instructions).toBe("");
    expect(body.tools).toBeNull();
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.reasoning).toEqual({ effort: "medium", context: "all_turns" });
    expect(body.input[0]).toEqual({ type: "additional_tools", role: "developer", tools: [tool] });
    expect(body.input[1]).toEqual({ type: "message", role: "developer", content: [{ type: "input_text", text: "Do the task" }] });
    expect(executor.buildHeaders(credentials, true, null, "gpt-6-sol")["x-openai-internal-codex-responses-lite"]).toBe("true");
  });

  it.each([
    ["gpt-6-luna", "none"],
    ["gpt-6.1-sol", "none"],
    ["gpt-6.1-sol", "minimal"],
  ])("clamps %s reasoning effort %s to Codex's lowest supported level", (model, effort) => {
    const body = new CodexExecutor().transformRequest(model, {
      model, input: "hello", reasoning: { effort },
    }, true, credentials);

    expect(body.reasoning.effort).toBe("low");
  });

  it("maps GPT-6.1 Sol's Codex-only ultra effort to max", () => {
    const body = new CodexExecutor().transformRequest("gpt-6.1-sol", {
      model: "gpt-6.1-sol", input: "hello", reasoning: { effort: "ultra" },
    }, true, credentials);

    expect(body.reasoning.effort).toBe("max");
  });

  it("sends GPT-6.1 Sol on the full transport so tool calls can run in parallel", () => {
    const executor = new CodexExecutor();
    const tool = { type: "function", name: "run", parameters: { type: "object", properties: {} } };
    const body = executor.transformRequest("gpt-6.1-sol", {
      model: "gpt-6.1-sol", input: "hello", instructions: "Do the task", tools: [tool], parallel_tool_calls: false,
    }, true, credentials);

    expect(executor.buildHeaders(credentials, true, null, "gpt-6.1-sol")["x-openai-internal-codex-responses-lite"]).toBeUndefined();
    expect(body.parallel_tool_calls).toBeUndefined();
    expect(body.tools).toEqual([expect.objectContaining({ name: "run" })]);
    expect(body.input[0].type).not.toBe("additional_tools");
    expect(body.reasoning.context).toBeUndefined();
  });

  it("sends the Lite shape and header in the actual outbound request", async () => {
    const fetchMock = vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockResolvedValue({
      ok: true, status: 200, headers: new Map(),
    });
    await new CodexExecutor().execute({
      model: "gpt-6-luna",
      body: { model: "gpt-6-luna", input: "hello", instructions: "Do the task" },
      stream: true,
      credentials,
    });

    const [url, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(options.headers["x-openai-internal-codex-responses-lite"]).toBe("true");
    expect(options.headers.version).toBe("0.159.0");
    expect(options.headers["User-Agent"]).toBe("codex_cli_rs/0.159.0");
    expect(body.model).toBe("gpt-6-luna");
    expect(body.instructions).toBe("");
    expect(body.input[0].type).toBe("additional_tools");
    expect(body.reasoning.context).toBe("all_turns");
  });

  it("falls back to the full transport when hosted web_search is requested", async () => {
    const fetchMock = vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockResolvedValue({
      ok: true, status: 200, headers: new Map(),
    });
    // One shared executor: the web_search decision must not leak into the next request.
    const executor = new CodexExecutor();
    await executor.execute({
      model: "gpt-6-sol",
      body: { model: "gpt-6-sol", input: "news today?", tools: [{ type: "web_search" }] },
      stream: true,
      credentials,
    });
    await executor.execute({
      model: "gpt-6-sol",
      body: { model: "gpt-6-sol", input: "hello" },
      stream: true,
      credentials,
    });

    const [[, searchReq], [, plainReq]] = fetchMock.mock.calls;
    const searchBody = JSON.parse(searchReq.body);
    expect(searchReq.headers["x-openai-internal-codex-responses-lite"]).toBeUndefined();
    expect(searchBody.tools).toEqual(expect.arrayContaining([expect.objectContaining({ type: "web_search" })]));
    expect(searchBody.input[0].type).not.toBe("additional_tools");
    expect(plainReq.headers["x-openai-internal-codex-responses-lite"]).toBe("true");
  });

  it("keeps the legacy transport for other models", () => {
    const executor = new CodexExecutor();
    const body = executor.transformRequest("gpt-5.5", { model: "gpt-5.5", input: "hello" }, true, credentials);

    expect(body.instructions).toBeTruthy();
    expect(body.input[0].type).not.toBe("additional_tools");
    expect(body.reasoning.context).toBeUndefined();
    expect(executor.buildHeaders(credentials, true, null, "gpt-5.5")["x-openai-internal-codex-responses-lite"]).toBeUndefined();
    expect(getThinkingLevels("codex", "gpt-6-astra")).toContain("none");
    expect(executor.buildHeaders(credentials, true, null, "gpt-6-astra")["x-openai-internal-codex-responses-lite"]).toBeUndefined();
  });
});
