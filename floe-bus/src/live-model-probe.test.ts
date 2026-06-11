/**
 * Unit tests for live-model-probe.ts
 * All HTTP calls are mocked — no real network calls occur.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { fetchLiveModelIds, intersectWithLive, clearLiveModelCache } from "./live-model-probe.js";
import type { FetchFn, ResolvedCredential } from "./live-model-probe.js";

// ---------------------------------------------------------------------------
// Helpers to build mock Response objects
// ---------------------------------------------------------------------------

function mockResponse(status: number, body: unknown): Response {
  const json = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => JSON.parse(json) as unknown,
    text: async () => json,
  } as unknown as Response;
}

function makeFetch(responses: Array<{ url: string | RegExp; response: Response }>): FetchFn {
  return async (url: string) => {
    for (const { url: pattern, response } of responses) {
      if (typeof pattern === "string" ? url.startsWith(pattern) : pattern.test(url)) {
        return response;
      }
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
}

const API_KEY_CRED: ResolvedCredential = { token: "sk-ant-api03-test-key", isOAuth: false };
const OAUTH_CRED: ResolvedCredential = { token: "sk-ant-ocp-test-oauth", isOAuth: true };
const GOOGLE_KEY_CRED: ResolvedCredential = { token: "AIza-test-google-key", isOAuth: false };
const OPENAI_KEY_CRED: ResolvedCredential = { token: "sk-openai-test", isOAuth: false };
const COPILOT_OAUTH_CRED: ResolvedCredential = { token: "ghu_copilot_token", isOAuth: true };

// ---------------------------------------------------------------------------
// fetchLiveModelIds — Anthropic
// ---------------------------------------------------------------------------

describe("fetchLiveModelIds — anthropic", () => {
  beforeEach(() => clearLiveModelCache());

  it("returns live model IDs on successful fetch", async () => {
    const fetch = makeFetch([{
      url: "https://api.anthropic.com/v1/models",
      response: mockResponse(200, {
        data: [{ id: "claude-opus-4-5" }, { id: "claude-sonnet-4-5" }],
        has_more: false,
        last_id: "claude-sonnet-4-5",
      }),
    }]);

    const ids = await fetchLiveModelIds("anthropic", API_KEY_CRED, fetch);
    expect(ids).toBeInstanceOf(Set);
    expect(ids!.has("claude-opus-4-5")).toBe(true);
    expect(ids!.has("claude-sonnet-4-5")).toBe(true);
  });

  it("paginates when has_more is true", async () => {
    let page = 0;
    const fetch: FetchFn = async (url) => {
      expect(url).toMatch(/api\.anthropic\.com\/v1\/models/);
      page++;
      if (page === 1) {
        return mockResponse(200, { data: [{ id: "model-a" }], has_more: true, last_id: "model-a" });
      }
      expect(url).toContain("after_id=model-a");
      return mockResponse(200, { data: [{ id: "model-b" }], has_more: false, last_id: "model-b" });
    };

    const ids = await fetchLiveModelIds("anthropic", API_KEY_CRED, fetch);
    expect(ids!.has("model-a")).toBe(true);
    expect(ids!.has("model-b")).toBe(true);
    expect(page).toBe(2);
  });

  it("sends Authorization: Bearer + anthropic-beta for OAuth credential", async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetch: FetchFn = async (_url, init) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return mockResponse(200, { data: [{ id: "claude-opus-4-5" }], has_more: false });
    };

    await fetchLiveModelIds("anthropic", OAUTH_CRED, fetch);
    // OAuth uses Bearer auth — pi-ai providers/anthropic.js createClient OAuth branch
    expect(capturedHeaders["Authorization"]).toBe(`Bearer ${OAUTH_CRED.token}`);
    expect(capturedHeaders["anthropic-beta"]).toContain("oauth-2025-04-20");
    expect(capturedHeaders["anthropic-beta"]).toContain("claude-code-20250219");
    expect(capturedHeaders["x-api-key"]).toBeUndefined();
  });

  it("does NOT send anthropic-beta for plain API key", async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetch: FetchFn = async (_url, init) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return mockResponse(200, { data: [{ id: "claude-opus-4-5" }], has_more: false });
    };

    await fetchLiveModelIds("anthropic", API_KEY_CRED, fetch);
    expect(capturedHeaders["anthropic-beta"]).toBeUndefined();
    expect(capturedHeaders["x-api-key"]).toBe(API_KEY_CRED.token);
    expect(capturedHeaders["Authorization"]).toBeUndefined();
  });

  it("fails open on non-200 response", async () => {
    const fetch = makeFetch([{ url: "https://api.anthropic.com", response: mockResponse(401, { error: "unauthorized" }) }]);
    const ids = await fetchLiveModelIds("anthropic", API_KEY_CRED, fetch);
    expect(ids).toBeUndefined();
  });

  it("fails open on unexpected response shape", async () => {
    const fetch = makeFetch([{ url: "https://api.anthropic.com", response: mockResponse(200, { unexpected: "shape" }) }]);
    const ids = await fetchLiveModelIds("anthropic", API_KEY_CRED, fetch);
    expect(ids).toBeUndefined();
  });

  it("fails open on fetch error (network failure)", async () => {
    const fetch: FetchFn = async () => { throw new Error("ECONNREFUSED"); };
    const ids = await fetchLiveModelIds("anthropic", API_KEY_CRED, fetch);
    expect(ids).toBeUndefined();
  });

  it("fails open when no credential provided", async () => {
    const fetch: FetchFn = async () => { throw new Error("should not be called"); };
    const ids = await fetchLiveModelIds("anthropic", undefined, fetch);
    expect(ids).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// fetchLiveModelIds — Google
// ---------------------------------------------------------------------------

describe("fetchLiveModelIds — google", () => {
  beforeEach(() => clearLiveModelCache());

  it("returns live model IDs stripping models/ prefix", async () => {
    const fetch = makeFetch([{
      url: "https://generativelanguage.googleapis.com",
      response: mockResponse(200, {
        models: [{ name: "models/gemini-2.0-flash" }, { name: "models/gemini-1.5-pro" }],
      }),
    }]);

    const ids = await fetchLiveModelIds("google", GOOGLE_KEY_CRED, fetch);
    expect(ids!.has("gemini-2.0-flash")).toBe(true);
    expect(ids!.has("gemini-1.5-pro")).toBe(true);
    expect(ids!.has("models/gemini-2.0-flash")).toBe(false);
  });

  it("sends key as query param for api_key credential", async () => {
    let capturedUrl = "";
    const fetch: FetchFn = async (url) => {
      capturedUrl = url;
      return mockResponse(200, { models: [{ name: "models/gemini-2.0-flash" }] });
    };

    await fetchLiveModelIds("google", GOOGLE_KEY_CRED, fetch);
    expect(capturedUrl).toContain(`key=${GOOGLE_KEY_CRED.token}`);
    expect(capturedUrl).not.toContain("Authorization");
  });

  it("sends Authorization: Bearer for oauth credential", async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetch: FetchFn = async (_url, init) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return mockResponse(200, { models: [{ name: "models/gemini-2.0-flash" }] });
    };
    const oauthCred: ResolvedCredential = { token: "ya29-google-token", isOAuth: true };

    await fetchLiveModelIds("google", oauthCred, fetch);
    expect(capturedHeaders["Authorization"]).toBe("Bearer ya29-google-token");
  });

  it("fails open on non-200", async () => {
    const fetch = makeFetch([{ url: "https://generativelanguage.googleapis.com", response: mockResponse(403, {}) }]);
    expect(await fetchLiveModelIds("google", GOOGLE_KEY_CRED, fetch)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// fetchLiveModelIds — OpenAI
// ---------------------------------------------------------------------------

describe("fetchLiveModelIds — openai", () => {
  beforeEach(() => clearLiveModelCache());

  it("returns live model IDs", async () => {
    const fetch = makeFetch([{
      url: "https://api.openai.com/v1/models",
      response: mockResponse(200, { data: [{ id: "gpt-4o" }, { id: "o3" }] }),
    }]);

    const ids = await fetchLiveModelIds("openai", OPENAI_KEY_CRED, fetch);
    expect(ids!.has("gpt-4o")).toBe(true);
    expect(ids!.has("o3")).toBe(true);
  });

  it("sends Authorization: Bearer header", async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetch: FetchFn = async (_url, init) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return mockResponse(200, { data: [{ id: "gpt-4o" }] });
    };

    await fetchLiveModelIds("openai", OPENAI_KEY_CRED, fetch);
    expect(capturedHeaders["Authorization"]).toBe(`Bearer ${OPENAI_KEY_CRED.token}`);
  });

  it("fails open on unexpected shape", async () => {
    const fetch = makeFetch([{ url: "https://api.openai.com", response: mockResponse(200, { models: [] }) }]);
    expect(await fetchLiveModelIds("openai", OPENAI_KEY_CRED, fetch)).toBeUndefined();
  });

  it("fails open on network error for openai-codex", async () => {
    const fetch: FetchFn = async () => { throw new Error("timeout"); };
    expect(await fetchLiveModelIds("openai-codex", OPENAI_KEY_CRED, fetch)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// fetchLiveModelIds — GitHub Copilot
// ---------------------------------------------------------------------------

describe("fetchLiveModelIds — github-copilot", () => {
  beforeEach(() => clearLiveModelCache());

  it("probes baseUrl/models and returns IDs", async () => {
    const fetch = makeFetch([{
      url: "https://api.individual.githubcopilot.com/models",
      response: mockResponse(200, { data: [{ id: "claude-haiku-4.5" }, { id: "gpt-4o" }] }),
    }]);
    const getBaseUrl = (_token: string) => "https://api.individual.githubcopilot.com";

    const ids = await fetchLiveModelIds("github-copilot", COPILOT_OAUTH_CRED, fetch, getBaseUrl);
    expect(ids!.has("claude-haiku-4.5")).toBe(true);
    expect(ids!.has("gpt-4o")).toBe(true);
  });

  it("sends Copilot-Integration-Id and Authorization headers", async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetch: FetchFn = async (_url, init) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return mockResponse(200, { data: [{ id: "gpt-4o" }] });
    };
    const getBaseUrl = (_t: string) => "https://api.individual.githubcopilot.com";

    await fetchLiveModelIds("github-copilot", COPILOT_OAUTH_CRED, fetch, getBaseUrl);
    expect(capturedHeaders["Copilot-Integration-Id"]).toBe("vscode-chat");
    expect(capturedHeaders["Authorization"]).toBe(`Bearer ${COPILOT_OAUTH_CRED.token}`);
  });

  it("fails open when Copilot returns unexpected shape", async () => {
    const fetch = makeFetch([{
      url: "https://api.individual.githubcopilot.com/models",
      response: mockResponse(200, { something: "unexpected" }),
    }]);
    const getBaseUrl = (_t: string) => "https://api.individual.githubcopilot.com";

    expect(await fetchLiveModelIds("github-copilot", COPILOT_OAUTH_CRED, fetch, getBaseUrl)).toBeUndefined();
  });

  it("fails open on non-200 from Copilot", async () => {
    const fetch = makeFetch([{
      url: "https://api.individual.githubcopilot.com/models",
      response: mockResponse(404, {}),
    }]);
    const getBaseUrl = (_t: string) => "https://api.individual.githubcopilot.com";

    expect(await fetchLiveModelIds("github-copilot", COPILOT_OAUTH_CRED, fetch, getBaseUrl)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// fetchLiveModelIds — unknown provider
// ---------------------------------------------------------------------------

describe("fetchLiveModelIds — unknown provider", () => {
  beforeEach(() => clearLiveModelCache());

  it("returns undefined (fail-open) for unknown providers", async () => {
    const fetch: FetchFn = async () => { throw new Error("should not be called"); };
    expect(await fetchLiveModelIds("amazon-bedrock", API_KEY_CRED, fetch)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cache behaviour
// ---------------------------------------------------------------------------

describe("fetchLiveModelIds — cache", () => {
  beforeEach(() => clearLiveModelCache());

  it("returns cached result without re-fetching", async () => {
    let fetchCount = 0;
    const fetch: FetchFn = async () => {
      fetchCount++;
      return mockResponse(200, { data: [{ id: "model-x" }], has_more: false });
    };

    await fetchLiveModelIds("anthropic", API_KEY_CRED, fetch);
    await fetchLiveModelIds("anthropic", API_KEY_CRED, fetch);
    expect(fetchCount).toBe(1);
  });

  it("re-fetches when cache is cleared", async () => {
    let fetchCount = 0;
    const fetch: FetchFn = async () => {
      fetchCount++;
      return mockResponse(200, { data: [{ id: "model-x" }], has_more: false });
    };

    await fetchLiveModelIds("anthropic", API_KEY_CRED, fetch);
    clearLiveModelCache();
    await fetchLiveModelIds("anthropic", API_KEY_CRED, fetch);
    expect(fetchCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// intersectWithLive
// ---------------------------------------------------------------------------

describe("intersectWithLive", () => {
  const catalog = [
    { id: "claude-opus-4-5", provider: "anthropic" },
    { id: "claude-3-sonnet-20240229", provider: "anthropic" }, // retired
    { id: "custom-model", provider: "anthropic" },             // custom models.json entry
  ];
  const customKeys = new Set(["anthropic/custom-model"]);

  it("filters retired models when liveIds provided", () => {
    const liveIds = new Set(["claude-opus-4-5"]);
    const result = intersectWithLive(catalog, customKeys, liveIds);
    expect(result.map((m) => m.id)).toEqual(expect.arrayContaining(["claude-opus-4-5", "custom-model"]));
    expect(result.map((m) => m.id)).not.toContain("claude-3-sonnet-20240229");
  });

  it("always keeps custom models.json entries even when absent from liveIds", () => {
    const liveIds = new Set(["claude-opus-4-5"]);
    const result = intersectWithLive(catalog, customKeys, liveIds);
    expect(result.map((m) => m.id)).toContain("custom-model");
  });

  it("passes full catalog through when liveIds is undefined (fail-open)", () => {
    const result = intersectWithLive(catalog, customKeys, undefined);
    expect(result).toHaveLength(catalog.length);
  });

  it("passes full catalog through when liveIds is an empty set (unexpected — treated same as full pass-through? No — empty set filters everything)", () => {
    // An empty live set is a valid (if unusual) result — only custom entries survive.
    const liveIds = new Set<string>();
    const result = intersectWithLive(catalog, customKeys, liveIds);
    // Only custom-model survives (it's in customKeys)
    expect(result.map((m) => m.id)).toEqual(["custom-model"]);
  });
});
