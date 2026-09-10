import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  endpointsCachePath,
  endpointsUrl,
  fetchEndpointsLive,
  loadOpenRouterEndpoints,
  OPENROUTER_ENDPOINTS_TTL_MS,
  parseEndpointsBody,
  type OpenRouterEndpointsSnapshot,
} from "../src/models/openrouter-endpoints.js";

// Brick 4c272cab §7.1 — the agent-facing endpoint-metrics read path.
//
// No network is touched: every row injects `fetchEndpoints`. A test that fell
// back to a real fetch would be measuring OpenRouter's uptime, not this module —
// and would spend the box's key doing it.

const SYNTHETIC_KEY = "sk-or-v1-TESTONLY-0000000000000000000000000000000000000000";
const SLUG = "z-ai/glm-5.3-flash";

/** Two rows, shaped exactly as the live API returns them (MEASUREMENTS §3). */
const LIVE_SHAPED_BODY = {
  data: {
    endpoints: [
      {
        provider_name: "BaseTen",
        tag: "baseten/fp8",
        quantization: "fp8",
        context_length: 1_048_576,
        pricing: { prompt: "0.00000015", completion: "0.0000005" },
        status: 0,
        uptime_last_1d: 99.9,
        throughput_last_30m: { p50: 132, p75: 150, p90: 160, p99: 180 },
      },
      // The incident provider: no `/` in its tag, so `tag.split("/")[0]` must
      // still produce a usable slug.
      {
        provider_name: "Wafer",
        tag: "wafer",
        quantization: "unknown",
        context_length: 1_048_576,
        pricing: { prompt: "0.0000001" },
        status: 0,
        uptime_last_1d: 99.1,
        throughput_last_30m: { p50: 15 },
      },
    ],
  },
};

function tempCache(): string {
  return path.join(mkdtempSync(path.join(os.tmpdir(), "acpx-endpoints-test-")), "cache.json");
}

function snapshot(fetchedAt: string, providerSlug = "baseten"): OpenRouterEndpointsSnapshot {
  return { slug: SLUG, fetchedAt, endpoints: [{ providerSlug }] };
}

test("T6 · the URL keeps the slug's slash — encoding it 404s on every real model", () => {
  // `z-ai/glm-5.3-flash` is TWO path segments in this API. A consumer reaching
  // for encodeURIComponent gets a 404 on every model that has a vendor, i.e. on
  // all of them.
  assert.equal(
    endpointsUrl(SLUG),
    "https://openrouter.ai/api/v1/models/z-ai/glm-5.3-flash/endpoints",
  );
  assert.equal(endpointsUrl(SLUG).includes("%2F"), false);
});

test("T6 · the cache path flattens the slug and honours the env it is asked about", () => {
  // One file per model, and no vendor directory: `z-ai/…` must not create a
  // `z-ai` folder that another slug could collide with.
  const withHome = endpointsCachePath(SLUG, { HOME: "/home/someone" });
  assert.equal(withHome, "/home/someone/.acpx/endpoints/z-ai__glm-5.3-flash.json");
  assert.equal(
    endpointsCachePath(SLUG, { HOME: "/home/someone", ACPX_STATE_HOME: "/tmp/state" }),
    "/tmp/state/.acpx/endpoints/z-ai__glm-5.3-flash.json",
  );
});

test("providerSlug is derived from the TAG, and rows are passed through verbatim", () => {
  // The REAL parser against the REAL body shape. Re-deriving `providerSlug` in
  // the test instead would pass on a parser that no longer matches the wire.
  const rows = parseEndpointsBody(LIVE_SHAPED_BODY);
  assert.deepEqual(
    rows.map((row) => row.providerSlug),
    // `baseten/fp8` → `baseten`; `wafer` has no `/` and must still yield a slug.
    ["baseten", "wafer"],
  );
  // Verbatim: the metrics an agent decides on are not reshaped on the way through.
  assert.equal(rows[0].throughput_last_30m?.p50, 132);
  assert.equal(rows[0].quantization, "fp8");
  assert.equal(rows[0].provider_name, "BaseTen", "the DISPLAY name survives beside the slug");
  assert.equal(rows[1].uptime_last_1d, 99.1);
});

test("a body that is not the expected shape yields no rows rather than throwing", () => {
  assert.deepEqual(parseEndpointsBody({ data: {} }), []);
  assert.deepEqual(parseEndpointsBody("nonsense"), []);
});

test("R7 · a cache older than 5 minutes is refetched; a fresh one is served without a fetch", async () => {
  const cachePath = tempCache();
  const now = Date.parse("2026-09-10T12:00:00.000Z");
  const fresh = new Date(now - 60_000).toISOString();
  const old = new Date(now - OPENROUTER_ENDPOINTS_TTL_MS - 1000).toISOString();

  writeFileSync(cachePath, JSON.stringify(snapshot(fresh, "cached")), "utf8");
  let fetches = 0;
  const served = await loadOpenRouterEndpoints(SLUG, SYNTHETIC_KEY, {
    cachePath,
    now,
    fetchEndpoints: async () => {
      fetches += 1;
      return snapshot(new Date(now).toISOString(), "fetched");
    },
  });
  assert.equal(fetches, 0, "a fresh cache must not hit the network");
  assert.equal(served.snapshot?.endpoints[0].providerSlug, "cached");
  assert.equal(served.stale, false);

  // ⚠️ 5 minutes, not the catalogue's hour: these are LIVE health figures, and
  // an hour-old uptime reads as current at exactly the moment someone decides
  // whether a provider is safe to prefer.
  writeFileSync(cachePath, JSON.stringify(snapshot(old, "cached")), "utf8");
  const refreshed = await loadOpenRouterEndpoints(SLUG, SYNTHETIC_KEY, {
    cachePath,
    now,
    fetchEndpoints: async () => {
      fetches += 1;
      return snapshot(new Date(now).toISOString(), "fetched");
    },
  });
  assert.equal(fetches, 1);
  assert.equal(refreshed.snapshot?.endpoints[0].providerSlug, "fetched");
  assert.equal(
    JSON.parse(readFileSync(cachePath, "utf8")).endpoints[0].providerSlug,
    "fetched",
    "a successful fetch rewrites the cache",
  );
});

test("--refresh fetches even when the cache is fresh", async () => {
  const cachePath = tempCache();
  const now = Date.now();
  writeFileSync(cachePath, JSON.stringify(snapshot(new Date(now).toISOString(), "cached")), "utf8");
  const result = await loadOpenRouterEndpoints(SLUG, SYNTHETIC_KEY, {
    cachePath,
    now,
    refresh: true,
    fetchEndpoints: async () => snapshot(new Date(now).toISOString(), "fetched"),
  });
  assert.equal(result.snapshot?.endpoints[0].providerSlug, "fetched");
});

test("stale-on-error: a failed refresh serves the CACHE, flagged, with the error", async () => {
  const cachePath = tempCache();
  const now = Date.parse("2026-09-10T12:00:00.000Z");
  writeFileSync(
    cachePath,
    JSON.stringify(snapshot(new Date(now - 10 * 60_000).toISOString(), "cached")),
    "utf8",
  );
  const result = await loadOpenRouterEndpoints(SLUG, SYNTHETIC_KEY, {
    cachePath,
    now,
    fetchEndpoints: async () => {
      throw new Error("upstream exploded");
    },
  });
  assert.equal(result.snapshot?.endpoints[0].providerSlug, "cached");
  assert.equal(result.stale, true);
  assert.equal(result.error, "upstream exploded");
});

test("A4 · a failure with no cache is snapshot:null — never an empty endpoints list", async () => {
  // 🛑 `[]` IS A REAL ANSWER HERE — a box-wide precision floor can genuinely
  // empty a model's eligible set — so returning it for a failed fetch would tell
  // an agent "this model has no providers" when the truth is "the read failed".
  const result = await loadOpenRouterEndpoints(SLUG, SYNTHETIC_KEY, {
    cachePath: tempCache(),
    fetchEndpoints: async () => {
      throw new Error("no network");
    },
  });
  assert.equal(result.snapshot, null);
  assert.equal(result.stale, false, "nothing was served, so nothing is stale");
  assert.equal(result.error, "no network");
});

test("O-1 · the fetch works with NO key, and sends one when present", async () => {
  // 🛑 THE BRIEF SAID THIS ENDPOINT NEEDS THE BOX KEY. IT DOES NOT — measured by
  // the test engineer against OpenRouter: no `Authorization` header at all → 200
  // with 26 rows; a deliberately invalid key → 200 as well. Refusing to show
  // freely-reachable data because this box holds no credential is a
  // self-inflicted degradation (HoD ruling O-1, revising acceptance A4).
  //
  // Asserted on the REQUEST HEADERS the fetcher would send, not on a reply: the
  // property is "we do not require a credential", and a live call would test
  // OpenRouter's uptime instead.
  const seen: (string | undefined)[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: { headers?: Record<string, string> }) => {
    seen.push(init?.headers?.authorization);
    return {
      ok: true,
      json: async () => LIVE_SHAPED_BODY,
    } as unknown as Response;
  }) as typeof globalThis.fetch;
  try {
    const withoutKey = await fetchEndpointsLive(SLUG);
    assert.equal(withoutKey.endpoints.length, 2, "rows come back with no credential at all");
    await fetchEndpointsLive(SLUG, SYNTHETIC_KEY);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(seen, [undefined, `Bearer ${SYNTHETIC_KEY}`]);
});

test("O-1 · loadOpenRouterEndpoints takes an undefined key without erroring", async () => {
  const result = await loadOpenRouterEndpoints(SLUG, undefined, {
    cachePath: tempCache(),
    fetchEndpoints: async (slug) => ({
      slug,
      fetchedAt: new Date().toISOString(),
      endpoints: parseEndpointsBody(LIVE_SHAPED_BODY),
    }),
  });
  assert.equal(result.error, null);
  assert.equal(result.snapshot?.endpoints.length, 2);
});

test("a mangled cache file is a COLD cache, not a crash", async () => {
  const cachePath = tempCache();
  writeFileSync(cachePath, "{ truncated", "utf8");
  const result = await loadOpenRouterEndpoints(SLUG, SYNTHETIC_KEY, {
    cachePath,
    fetchEndpoints: async () => snapshot(new Date().toISOString(), "fetched"),
  });
  assert.equal(result.snapshot?.endpoints[0].providerSlug, "fetched");
  assert.equal(result.error, null);
});
