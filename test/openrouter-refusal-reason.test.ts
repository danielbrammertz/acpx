import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  explainTurnError,
  formatRefusalMessage,
  looksLikeSilentStall,
  probeOpenRouterRefusal,
  refusalFromBody,
} from "../src/acp/openrouter-refusal-reason.js";

// bricks bb23a7fa / 5aacdba2 — pi reports a throttled stream as "Request timed out.",
// a statement about US for a refusal by THEM. These rows pin the recovery of the
// provider's own words, and the boundaries that keep an unreliable signal out of any
// decision.
//
// 🛑 THE PARSE IS PINNED AGAINST A REAL CAPTURED 429 BODY, not a shape invented here.
// The live endpoint cannot be asked to rate-limit on demand, so a hand-written fixture
// would only prove the parser agrees with my guess about the wire. The specimen was
// captured from OpenRouter during the measurement run.
const SPECIMEN_PATH =
  "/wisdom/Bricks/5aacdba2-20a6-4718-9cf5-5c874741abf3/agents/" +
  "2aa60a39-9c70-42d5-b865-394d204fe77a/evidence/429-body-specimen.json";

/** The specimen lives on an NFS mount that a test host may not have. Skipping loudly
 *  is right: a silently-skipped row is indistinguishable from a passing one. */
function specimen(): unknown {
  try {
    return JSON.parse(readFileSync(SPECIMEN_PATH, "utf8"));
  } catch {
    return undefined;
  }
}

test("a REAL captured 429 body yields every field worth quoting", (t) => {
  const body = specimen();
  if (body === undefined) {
    t.skip(`specimen unavailable at ${SPECIMEN_PATH} — parse NOT verified against the wire`);
    return;
  }
  const refusal = refusalFromBody(body);
  assert.ok(refusal, "a real 429 body must parse");
  assert.equal(refusal.provider, "Alibaba");
  assert.equal(refusal.limitSource, "upstream_provider_shared_pool");
  assert.equal(refusal.isByok, false, "is_byok false is the actionable case — BYOK is the remedy");
  assert.match(refusal.raw, /rate-limited upstream/);
  assert.ok(refusal.remedyHint, "the provider's own remedy must survive into the message");
});

test("a body with no provider sentence yields NOTHING — never an invented reason", () => {
  // The defect this brick fixes is a message that blames the wrong layer. Substituting
  // our own wording for a missing `raw` would be that defect, inverted.
  assert.equal(refusalFromBody({ error: { code: 429, metadata: {} } }), undefined);
  assert.equal(refusalFromBody({ error: { code: 429 } }), undefined);
  assert.equal(refusalFromBody({}), undefined);
  assert.equal(refusalFromBody(undefined), undefined);
  assert.equal(refusalFromBody({ error: { metadata: { raw: "" } } }), undefined, "empty raw");
  assert.equal(refusalFromBody({ error: { metadata: { raw: 7 } } }), undefined, "non-string raw");
});

test("the formatted message keeps pi's original wording, attributed", () => {
  const msg = formatRefusalMessage("Request timed out.", {
    raw: "qwen/qwen3.8-flash is temporarily rate-limited upstream.",
    provider: "Alibaba",
    limitSource: "upstream_provider_shared_pool",
    isByok: false,
    remedyHint: "Retry shortly, add your own provider key",
  });
  assert.match(msg, /rate-limited upstream/, "the provider's sentence leads");
  assert.match(msg, /provider: Alibaba/);
  assert.match(msg, /shared pool \(no own key\)/);
  assert.match(msg, /Remedy: Retry shortly/);
  // ⚠️ Load-bearing: deleting pi's own wording would hide WHICH LAYER said what, and
  // when the probe finds nothing that wording is the only thing we have.
  assert.match(msg, /\[pi reported: Request timed out\.\]/);
});

test("no refusal ⇒ the message is returned UNCHANGED, byte for byte", () => {
  // This is the ~50%-of-the-time path (the pool freed up between the stream and the
  // probe). It must be inert, not a vaguer restatement.
  assert.equal(formatRefusalMessage("Request timed out.", undefined), "Request timed out.");
});

test("the stall classifier asks the NARROW question, so unrelated failures never probe", () => {
  assert.equal(looksLikeSilentStall("Request timed out."), true);
  assert.equal(
    looksLikeSilentStall("REQUEST TIMEOUT"),
    true,
    "pi's wording, not ours — match loosely",
  );
  // A tool failure or a refusal must not trigger a network probe on the failure path.
  assert.equal(looksLikeSilentStall("Tool call failed: ENOENT"), false);
  assert.equal(looksLikeSilentStall("The model refused to answer."), false);
  assert.equal(looksLikeSilentStall(""), false);
});

test("explainTurnError is INERT without a model id, and never probes then", async () => {
  let called = 0;
  const out = await explainTurnError(
    "Request timed out.",
    undefined,
    {},
    {
      resolveKey: () => "test-key",
      fetchImpl: (async () => {
        called += 1;
        return new Response("{}", { status: 429 });
      }) as unknown as typeof fetch,
    },
  );
  assert.equal(out, "Request timed out.");
  assert.equal(called, 0, "no model id ⇒ no request may be sent");
});

test("explainTurnError does not probe a failure that is not a stall", async () => {
  let called = 0;
  const out = await explainTurnError(
    "Tool call failed",
    "qwen/qwen3.8-flash",
    {},
    {
      resolveKey: () => "test-key",
      fetchImpl: (async () => {
        called += 1;
        return new Response("{}", { status: 429 });
      }) as unknown as typeof fetch,
    },
  );
  assert.equal(out, "Tool call failed");
  assert.equal(called, 0, "a non-stall failure must not spend pool budget on a probe");
});

test("the probe enriches on 429 and is inert on 200 — the 50/50 outcome", async () => {
  const body = JSON.stringify({
    error: {
      code: 429,
      metadata: { raw: "throttled upstream", provider_name: "Alibaba", is_byok: false },
    },
  });
  const enriched = await explainTurnError(
    "Request timed out.",
    "qwen/qwen3.8-flash",
    {},
    {
      resolveKey: () => "test-key",
      fetchImpl: (async () => new Response(body, { status: 429 })) as unknown as typeof fetch,
    },
  );
  assert.match(enriched, /throttled upstream/);
  assert.match(enriched, /\[pi reported: Request timed out\.\]/);

  const inert = await explainTurnError(
    "Request timed out.",
    "qwen/qwen3.8-flash",
    {},
    {
      resolveKey: () => "test-key",
      fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    },
  );
  assert.equal(inert, "Request timed out.", "a 200 means we learned nothing — say nothing extra");
});

test("🛑 the probe NEVER throws on the failure path, whatever the network does", async () => {
  // It runs while an error is already being reported. An explain step that breaks the
  // error path is strictly worse than a vague message, so every outcome must degrade
  // to `undefined` rather than propagate.
  const arms: Array<[string, typeof fetch]> = [
    [
      "fetch rejects",
      (async () => {
        throw new Error("ECONNRESET");
      }) as unknown as typeof fetch,
    ],
    [
      "429 with unparseable body",
      (async () => new Response("not json", { status: 429 })) as unknown as typeof fetch,
    ],
    ["500", (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch],
  ];
  for (const [label, fetchImpl] of arms) {
    const out = await probeOpenRouterRefusal(
      "qwen/qwen3.8-flash",
      {},
      { resolveKey: () => "test-key", fetchImpl },
    );
    assert.equal(out, undefined, `${label} must yield undefined, not throw`);
  }
});

test("🛑 an ABSENT is_byok must not become the claim 'no own key'", () => {
  // SECOND GAP FOUND BY MUTATION PROBE: coercing `is_byok` to `value === true`
  // produced zero reds, yet `isByok === false` is what prints "using OpenRouter's
  // shared pool (no own key)" — a factual claim about OUR configuration. Asserting it
  // from a missing field is the same mis-attribution this module exists to end, aimed
  // at ourselves instead of at pi.
  const absent = refusalFromBody({ error: { metadata: { raw: "throttled" } } });
  assert.ok(absent);
  assert.equal(absent.isByok, undefined, "absent on the wire ⇒ absent here, never false");
  assert.doesNotMatch(
    formatRefusalMessage("Request timed out.", absent),
    /no own key/,
    "a missing is_byok must not produce a claim about our credentials",
  );

  // …and the real thing still does, because that is the actionable case.
  const present = refusalFromBody({ error: { metadata: { raw: "throttled", is_byok: false } } });
  assert.equal(present?.isByok, false);
  assert.match(formatRefusalMessage("Request timed out.", present), /no own key/);

  // A genuine `true` must not print it either — we DO have our own key then.
  const byok = refusalFromBody({ error: { metadata: { raw: "throttled", is_byok: true } } });
  assert.equal(byok?.isByok, true);
  assert.doesNotMatch(formatRefusalMessage("Request timed out.", byok), /no own key/);
});

test("🛑 ONLY a 429 is a refusal — a 500 carrying the same body is NOT", async () => {
  // GAP FOUND BY A MUTATION PROBE: deleting the `status !== 429` check produced ZERO
  // reds, because every other row's non-429 arm used a body with no `raw` and so
  // passed for the wrong reason. A 5xx or a 400 that happens to carry provider
  // metadata would have been reported to the user as an upstream rate-limit — the
  // exact mis-attribution this module exists to end, pointed the other way.
  const refusalShapedBody = JSON.stringify({
    error: { code: 500, metadata: { raw: "internal error", provider_name: "Alibaba" } },
  });
  for (const status of [200, 400, 500, 503]) {
    const out = await probeOpenRouterRefusal(
      "qwen/qwen3.8-flash",
      {},
      {
        resolveKey: () => "test-key",
        fetchImpl: (async () =>
          new Response(refusalShapedBody, { status })) as unknown as typeof fetch,
      },
    );
    assert.equal(out, undefined, `status ${status} must not be read as a rate-limit refusal`);
  }
});

test("no credential ⇒ no request at all", async () => {
  // 🛑 THE ROW THAT CAUGHT MY OWN FIXTURE BUG. It first failed with called=1, because
  // scoping `env` does NOT isolate the credential — `boxProvidersPath` resolves its
  // home from `process.env`/`os.homedir()`, so every other row here was quietly
  // authenticating with the BOX's real key while appearing to use an injected one.
  // Hence `resolveKey` in the deps, and hence this row returning it absent.
  let called = 0;
  const out = await probeOpenRouterRefusal(
    "qwen/qwen3.8-flash",
    {},
    {
      resolveKey: () => undefined,
      fetchImpl: (async () => {
        called += 1;
        return new Response("{}", { status: 429 });
      }) as unknown as typeof fetch,
    },
  );
  assert.equal(out, undefined);
  assert.equal(called, 0, "an unauthenticated probe would 401 and teach us nothing");
});

test("the probe sends the CHEAP shape — measured better on both axes than same-shape", async () => {
  // 5aacdba2: cheap probe 50%/14% vs same-shape 33%/21%. It is also the one that
  // spends least of the budget that is throttling us. Pinned so a later "make the
  // probe representative" change has to argue with the measurement.
  let seen: { model?: string; max_tokens?: number; stream?: boolean } = {};
  await probeOpenRouterRefusal(
    "qwen/qwen3.8-flash",
    {},
    {
      resolveKey: () => "test-key",
      fetchImpl: (async (_url: unknown, init: { body?: string }) => {
        seen = JSON.parse(init.body ?? "{}");
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    },
  );
  assert.equal(seen.model, "qwen/qwen3.8-flash");
  assert.equal(seen.max_tokens, 1, "one token — the cheapest request that can still be refused");
  assert.equal(seen.stream, false, "NON-streaming is the whole point: streaming hides the 429");
});
