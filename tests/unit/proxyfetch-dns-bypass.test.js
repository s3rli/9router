import { describe, it, expect, vi, beforeAll } from "vitest";

// The MITM bypass resolves kiro's host through Google DNS before every request.
// On a network that blocks 8.8.8.8, Node's default resolver retries took ~50 s
// per request before falling back to system DNS. The lookup must fail fast and
// the failure must be cached, so later requests go straight to the fallback.
const resolver = { options: [], lookups: 0 };

vi.mock("dns", () => {
  class Resolver {
    constructor(options) {
      resolver.options.push(options);
    }
    setServers() {}
    resolve4(_host, cb) {
      resolver.lookups++;
      cb(Object.assign(new Error("queryA ETIMEOUT q.us-east-1.amazonaws.com"), { code: "ETIMEOUT" }));
    }
  }
  return { default: { Resolver }, Resolver };
});

const fallbackFetch = vi.fn(async () => new Response("ok"));
let proxyAwareFetch;

beforeAll(async () => {
  for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) delete process.env[k];
  // proxyFetch keeps the fetch it finds at import time as its direct path.
  vi.stubGlobal("fetch", fallbackFetch);
  ({ proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js"));
});

describe("proxyAwareFetch DNS bypass on a network that blocks Google DNS", () => {
  it("bounds the lookup, caches the failure and serves every request through system DNS", async () => {
    const url = "https://q.us-east-1.amazonaws.com/generateAssistantResponse";

    const first = await proxyAwareFetch(url, { method: "POST", body: "{}" });
    const second = await proxyAwareFetch(url, { method: "POST", body: "{}" });

    expect(await first.text()).toBe("ok");
    expect(await second.text()).toBe("ok");
    expect(fallbackFetch).toHaveBeenCalledTimes(2);
    expect(resolver.options).toEqual([{ timeout: 1000, tries: 1 }]);
    expect(resolver.lookups).toBe(1);
  });
});
