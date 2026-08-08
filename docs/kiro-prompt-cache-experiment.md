# Experiment: explicit prompt-cache control for Kiro (CodeWhisperer/Bedrock)

**Date:** 2026-08-08
**Branch:** `feature/kiro-day-granular-timestamp` (experiment; **not for merge**)
**Verdict:** Explicit `cachePoint` control offers **no achievable token saving** for Kiro through 9router. Do not merge v1/v2.

## Question

Kiro routes Claude on Amazon Bedrock via CodeWhisperer's `generateAssistantResponse`.
Turn-2 requests are ~45% cheaper per token (Bedrock **implicit** prompt caching). Can we
do better — make caching deterministic or cache more of the prompt — by injecting explicit
Bedrock `cachePoint` markers in the request 9router builds?

Two ideas were tested:

- **v1** — a `cachePoint` appended to the **tools** array (`currentMessage.userInputMessageContext.tools`).
- **v2** — a `cachePoint` appended to the **history** array, to explicitly cache the large
  accumulated conversation prefix (env-gated: `KIRO_CACHE_HISTORY=1`).

## Method

- Forked 9router; built three images: **fork** (v1 tools cachePoint), **control** (stock, no
  cachePoint, built from the commit before v1), **v2** (history cachePoint behind an env flag).
- Ran each image as a container against an **isolated copy** of the account DB (Kiro *Account 2*
  only; the other account deactivated) on a spare port. **Production 9router was never stopped or
  modified.**
- Token safety: the account access token was refreshed by a single container and then **frozen**
  (`expiresAt` set far-future) so no container re-refreshed during a burst — avoiding refresh-token
  rotation / reuse-detection (`refresh_token_reused` is a *permanent* error upstream).
- Each A/B "run" = a **cold** call then a **warm** call on the same session/prefix, with a **unique
  nonce** in the system prompt so Bedrock's content-hash cache can't cross-contaminate runs within
  the 5-min TTL. Metric: warm-turn credit/token discount vs cold. "Hit" = >8% discount.

## Results

### Short conversation (2-turn, ~9k-token prefix), N=6 per arm, interleaved

| arm | hit-rate | mean discount |
|-----|----------|---------------|
| fork (tools cachePoint) | 6/6 | **−45.8%** |
| control (no cachePoint) | 6/6 | **−47.7%** |

Fully overlapping; fork if anything slightly lower. **v1 adds no measurable benefit** — implicit
caching already covers the (stable) prefix. Also note: caching here is **reliable (12/12 hit)**, not
intermittent. The earlier "intermittent ~45%" was an artifact of an *unstable* prefix (no
`x-session-id` → ephemeral `conversationId` → prefix changed each turn). The real lever is the
**`x-session-id` fix** (stable `conversationId` → `applyKiroSessionReplay` → byte-stable prefix).

### Long conversation (24-turn, ~12k-token prefix), N=3 per arm

| arm | hit-rate | mean discount |
|-----|----------|---------------|
| fork (tools cachePoint) | 3/3 | **−15.3%** |
| control (no cachePoint) | 3/3 | **−15.6%** |

**Caching collapses from ~47% → ~15% as the conversation grows** — for both arms. Bedrock's implicit
cache stops covering the oldest history, so the bulk of a long prompt goes uncached every turn. v1's
tools cachePoint doesn't help (it only marks tools). This matters: real coding/review agents run
*long* conversations, so they sit in the 15% zone, not the 47% zone.

### v2 — explicit history cachePoint

| request | result |
|---------|--------|
| v2 image, `KIRO_CACHE_HISTORY=1` (history cachePoint present) | **HTTP 500** every call — CodeWhisperer: *"Encountered an unexpected error"* |
| same image, flag off (history cachePoint absent) | **HTTP 200** every call |

Deterministic. The history cachePoint is the **sole** cause of the 500.

## Root cause

CodeWhisperer's `generateAssistantResponse` history is a **strict alternating user/assistant array
of objects with string `content`**. There is **no legal slot for a `cachePoint` content-block** in
that schema — only the **tools** array (a list of objects) tolerates a `cachePoint` peer entry
(which is why v1 is accepted, just useless). This differs from Bedrock's native Converse API, where
`cachePoint` is a first-class message *content block* and history caching is expressible.

So through the `generateAssistantResponse` path, explicit prefix-caching of the conversation history
is **not achievable**. (A proxy that *does* cache history, e.g. KiroProxy, must be talking to the
native Bedrock Converse endpoint, not Kiro's `generateAssistantResponse`.)

## Conclusion

- **v1 (tools cachePoint):** accepted by the API, but **no benefit** — implicit already caches tools.
- **v2 (history cachePoint):** would help, but **rejected by the API (500)**.
- **→ No achievable explicit-`cachePoint` win for Kiro via 9router.** The ~15% long-conversation
  floor is CodeWhisperer's implicit-cache ceiling; `cachePoint` can't push past it.
- The token saving originally sought was **already delivered by the `x-session-id` fix** (stable
  prefix → reliable ~47% on short/medium conversations).
- The real lever for **long** agent conversations is **application-level history trimming /
  summarization** (keep more of the prompt inside the implicit-cache window) — not `cachePoint`.

**Cost:** ~1.8 Kiro credits (Account 2), each step explicitly authorized. Production never disrupted.

## Files in this experiment

- `open-sse/translator/request/openai-to-kiro.js` — v1 tools cachePoint (committed) + v2 history
  cachePoint behind `KIRO_CACHE_HISTORY` (env flag, **default off / inert**; kept as a documented
  dead-end).
- Timestamp commit (`97955043`) makes the current-time prefix day-granular so it doesn't bust the
  cache every second — a real (if small) robustness fix, independent of the cachePoint question.
