import { describe, it, expect, vi, beforeAll } from "vitest";

// The MITM bypass resolves kiro's host through Google DNS before every request.
// On a network that blocks 8.8.8.8, Node's default resolver retries took ~50 s
// per request before falling back to system DNS. The lookup must fail fast, and
// the failure must be cached without displacing a fresh successful lookup.
const ETIMEOUT = () => Object.assign(new Error("queryA ETIMEOUT"), { code: "ETIMEOUT" });
const resolver = { options: [], lookups: 0, hold: false, pending: [] };

vi.mock("dns", () => {
  class Resolver {
    constructor(options) {
      resolver.options.push(options);
    }
    setServers() {}
    resolve4(_host, cb) {
      resolver.lookups++;
      if (resolver.hold) resolver.pending.push(cb);
      else cb(ETIMEOUT());
    }
  }
  return { default: { Resolver }, Resolver };
});

// The bypass connects to the resolved IP itself; refuse every connection so a
// request that used a cached address falls back to the direct fetch too.
const connects = [];
vi.mock("net", () => {
  class Socket {
    connect(_port, ip) {
      connects.push(ip);
      setImmediate(() => this.onError?.(new Error("connection refused")));
      return this;
    }
    on(event, fn) {
      if (event === "error") this.onError = fn;
      return this;
    }
  }
  return { default: { Socket }, Socket };
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
    expect(resolver.options).toEqual([{ timeout: 1000, tries: 1 }]);
    expect(resolver.lookups).toBe(1);
    expect(connects).toEqual([]);
  });

  it("keeps an address a concurrent lookup resolved when an older lookup fails after it", async () => {
    const url = "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse";
    resolver.hold = true;
    const lookupsPending = async (n) => {
      while (resolver.pending.length < n) await new Promise((r) => setTimeout(r, 1));
    };
    const older = proxyAwareFetch(url, { method: "POST", body: "{}" });
    await lookupsPending(1);
    const newer = proxyAwareFetch(url, { method: "POST", body: "{}" });
    await lookupsPending(2);
    const [olderLookup, newerLookup] = resolver.pending;
    newerLookup(null, ["203.0.113.10"]);
    olderLookup(ETIMEOUT());
    await Promise.all([older, newer]);
    const lookups = resolver.lookups;

    await proxyAwareFetch(url, { method: "POST", body: "{}" });

    expect(resolver.lookups).toBe(lookups);
    expect(connects).toEqual(["203.0.113.10", "203.0.113.10"]);
  });
});
