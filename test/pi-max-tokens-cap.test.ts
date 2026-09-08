// brick 0095b715 — A PINNED pi MODEL COULD BE UNUSABLE: EVERY TURN 400'd.
//
// `moonshotai/kimi-k2-thinking`, pinned and prompted, died on every turn with
//
//     400 — "Requested maximum tokens of 227044 exceeds the maximum output
//            tokens limit: 102400."
//
// pi asks for `min(maxTokens, contextWindow − prompt − 4096)` on EVERY turn —
// the whole remaining context, as output. The catalogue said 235 929 because
// that is what the provider ADVERTISES; the provider enforces 102 400.
//
// ⚠️ THE FIX CANNOT BE "WRITE A CORRECT maxTokens", AND THAT IS THE FINDING.
// Measured 2026-09-08 across 1 109 live (model, provider-endpoint) probes:
// OpenRouter CLAMPS the request down to the endpoint's advertised ceiling before
// forwarding (`llama-3.3-70b` asked for 16 384 pinned to Together, which
// advertises 2 048 → HTTP 200), so asking for too much is normally harmless. The
// failures are providers that advertise MORE than they enforce, and a structural
// pass over OpenRouter's own per-provider data called 3 of the 5 observed live
// failures "safe". No catalogue field predicts it. ⇒ ask for less (the cap), and
// make the residue legible (the explainer). Both halves are tested here.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyHarnessConfigDir } from "../src/acp/harness-config-dir.js";
import { resetPiKnowledgeMemo } from "../src/acp/pi-model-knowledge.js";
import { explainPiTurnError } from "../src/acp/pi-turn-error.js";
import { turnErrorForDeliveryTerminal } from "../src/cli/session/runtime.js";

const PI_COMMAND = "node /opt/pi-acp/dist/index.js";

// The real row, transcribed from pi's own box catalogue on 2026-09-08. Using the
// model that actually failed — with its actual numbers — is what makes the
// assertions below a regression anchor rather than a shape check.
const KIMI_ID = "moonshotai/kimi-k2-thinking";
const KIMI_ADVERTISED_MAX_TOKENS = 235_929;
const KIMI_ENFORCED_BY_GOOGLE = 102_400; // measured, from the provider's own 400
const CAP = 32_768;

type Fixture = { root: string; env: NodeJS.ProcessEnv };

function fixture(boxModels: unknown[]): Fixture {
  const root = mkdtempSync(join(tmpdir(), "acpx-pi-cap-test-"));
  const home = join(root, "home");
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "models-store.json"),
    JSON.stringify({ openrouter: { lastModified: 1, checkedAt: 1, models: boxModels } }),
  );
  const knowledgePath = join(root, "pi-knowledge.json");
  // pi "knows" every id in the box store, so nothing is fabricated unless a test
  // asks for it — the cap must work on pi's OWN entries, which is the case the
  // brick is actually about.
  writeFileSync(
    knowledgePath,
    JSON.stringify({
      fetchedAt: new Date().toISOString(),
      ids: (boxModels as { id?: string }[]).map((m) => m.id).filter(Boolean),
    }),
  );
  const cataloguePath = join(root, "models-cache.json");
  writeFileSync(cataloguePath, JSON.stringify({ fetchedAt: new Date().toISOString(), models: [] }));
  resetPiKnowledgeMemo();
  return {
    root,
    env: {
      HOME: home,
      ACPX_PI_KNOWLEDGE_CACHE: knowledgePath,
      ACPX_MODELS_CACHE: cataloguePath,
      // Not a real command: a code path that tried to SPAWN pi fails loudly
      // rather than quietly measuring the box's real pi.
      PATH: "/nonexistent-so-a-spawn-cannot-silently-succeed",
    },
  };
}

function configFor(fx: Fixture, provisionModelId?: string): any {
  const plan = applyHarnessConfigDir({
    env: fx.env,
    agentCommand: PI_COMMAND,
    sessionId: `s-${Math.random().toString(36).slice(2)}`,
    ...(provisionModelId ? { provisionModelId } : {}),
    rootDir: join(fx.root, `cfg-${Math.random().toString(36).slice(2)}`),
  });
  assert.ok(plan, "applyHarnessConfigDir must produce a plan for the pi harness");
  const path = join(plan.dir, "models.json");
  assert.ok(existsSync(path), "models.json is the durable layer and must always be written");
  return JSON.parse(readFileSync(path, "utf8"));
}

const row = (id: string, maxTokens: unknown) => ({
  id,
  name: id,
  api: "openai-completions",
  baseUrl: "https://openrouter.ai/api/v1",
  contextWindow: 262_144,
  ...(maxTokens === undefined ? {} : { maxTokens }),
});

test("0095b715: the model that was unusable now asks for a value its provider serves", () => {
  const fx = fixture([row(KIMI_ID, KIMI_ADVERTISED_MAX_TOKENS)]);
  const config = configFor(fx, `openrouter/${KIMI_ID}`);

  const override = config.providers.openrouter.modelOverrides?.[KIMI_ID];
  assert.ok(override, "the failing model must carry a maxTokens override");
  assert.equal(override.maxTokens, CAP, "capped to the per-turn output budget");

  // The assertion that ties the number to the measured world rather than to
  // itself: what pi will now request is below what the provider actually
  // enforced when it refused us.
  assert.ok(
    override.maxTokens < KIMI_ENFORCED_BY_GOOGLE,
    `${override.maxTokens} must be under the ${KIMI_ENFORCED_BY_GOOGLE} Google enforced`,
  );
});

test("0095b715 CONTROL: THE CAP NEVER RAISES — this is the one that must not regress", () => {
  // `applyModelOverride` REPLACES (`maxTokens: override.maxTokens ?? model.maxTokens`);
  // it does not take a minimum. So an override written blindly as the budget
  // would make pi ask a 4 096-token model for 32 768 — re-creating this very bug
  // in a new place, on models that work today. Both directions in one test,
  // because only the pair proves the `Math.min` and not a constant.
  const fx = fixture([row("tiny/model", 4_096), row("huge/model", 1_000_000)]);
  const overrides = configFor(fx, "openrouter/tiny/model").providers.openrouter.modelOverrides;

  assert.equal(overrides["tiny/model"].maxTokens, 4_096, "a below-budget ceiling is left alone");
  assert.equal(overrides["huge/model"].maxTokens, CAP, "an above-budget ceiling is lowered");
});

test("0095b715 CONTROL: an entry with no usable maxTokens gets NO override", () => {
  // pi's own value must stand rather than acquiring an invented one — the same
  // "a gap is a gap" discipline the fabricated-entry work landed. A 0 or
  // negative is pi's invalid-value territory (`modelFromJson` throws on it).
  const fx = fixture([
    row("no/maxtokens", undefined),
    row("zero/maxtokens", 0),
    row("negative/maxtokens", -1),
    row("string/maxtokens", "235929"),
    row("real/model", 200_000),
  ]);
  const overrides = configFor(fx, "openrouter/real/model").providers.openrouter.modelOverrides;

  for (const id of ["no/maxtokens", "zero/maxtokens", "negative/maxtokens", "string/maxtokens"]) {
    assert.equal(overrides[id], undefined, `${id} must not acquire an invented ceiling`);
  }
  // Positive control in the same run: the builder DID run and DID write, so the
  // four `undefined`s above cannot be an empty object that passed by accident.
  assert.equal(overrides["real/model"].maxTokens, CAP, "the valid entry is still capped");
});

test("0095b715: the cap is NOT gated on --model, because set_model can move anywhere", () => {
  // The gap the Anthropic baseUrl repair already learned about the hard way: a
  // session created without `--model` can still `session/set_model` onto any
  // model pi offers. A cap written only for the provisioned slug would miss
  // exactly that session.
  const fx = fixture([row(KIMI_ID, KIMI_ADVERTISED_MAX_TOKENS)]);
  const overrides = configFor(fx).providers.openrouter.modelOverrides;

  assert.ok(overrides, "a session that named no model still gets the cap");
  assert.equal(overrides[KIMI_ID].maxTokens, CAP);
});

test("0095b715: a FABRICATED entry is capped too, not just pi's own", () => {
  // A slug pi does not know is built by `buildPiCatalogueEntry` from acpx's
  // cache, and inherits the same advertised-ceiling problem.
  const fx = fixture([]);
  writeFileSync(
    join(fx.root, "models-cache.json"),
    JSON.stringify({
      fetchedAt: new Date().toISOString(),
      models: [
        {
          id: "brand/new",
          context_length: 262_144,
          top_provider: { max_completion_tokens: 235_929 },
          pricing: { prompt: "0.0000006", completion: "0.0000025" },
        },
      ],
    }),
  );
  resetPiKnowledgeMemo();
  const config = configFor(fx, "openrouter/brand/new");

  assert.equal(
    config.providers.openrouter.models[0].maxTokens,
    235_929,
    "the definition still carries the real advertised figure",
  );
  assert.equal(
    config.providers.openrouter.modelOverrides["brand/new"].maxTokens,
    CAP,
    "and the override — which pi applies LAST — caps what is actually requested",
  );
});

// ---------------------------------------------------------------------------
// The explainer. Every fixture below is a string measured on the wire on
// 2026-09-08; none is invented, because a regex written against an imagined
// error message is a test that passes and a feature that never fires.
// ---------------------------------------------------------------------------

const MEASURED_OUTPUT_CEILING: [label: string, raw: string, req: string, limit: string][] = [
  [
    "Google (Vertex)",
    '400: {"message":"Provider returned error","code":400,"metadata":{"raw":"[{\\n  \\"error\\": {\\n    \\"code\\": 400,\\n    \\"message\\": \\"Requested maximum tokens of 227043 exceeds the maximum output tokens limit: 102400.\\",\\n    \\"status\\": \\"INVALID_ARGUMENT\\"\\n  }\\n}\\n]","provider_name":"Google","is_byok":false}}',
    "227043",
    "102400",
  ],
  [
    "Novita",
    '{"message":"max_tokens: 100352 exceeds maximum 98304 trace_id: df50a381","type":"invalid_request_error"}',
    "100352",
    "98304",
  ],
  [
    "BaseTen",
    '{ "error": { "code": 400, "message": "Invalid request: [\'max_tokens (943710): Input should be less than or equal to 384000\']", "type": "Bad Request" } }',
    "943710",
    "384000",
  ],
  [
    "Phala",
    '{"error":{"message":"max_tokens (current value: 95972) must be between 0 and 32768","type":"invalid_request_error"}}',
    "95972",
    "32768",
  ],
  [
    "Google (Gemini surface)",
    '{ "error": { "code": 400, "message": "Unable to submit request because it has a maxOutputTokens value of 16384 but the supported range is from 1 (inclusive) to 8193 (exclusive)" } }',
    "16384",
    "8193",
  ],
];

test("0095b715: every measured output-ceiling refusal becomes an explanation naming the model", () => {
  for (const [label, raw, requested, limit] of MEASURED_OUTPUT_CEILING) {
    const explained = explainPiTurnError(raw, KIMI_ID);
    assert.ok(explained, `${label}: must be recognised`);
    assert.ok(
      explained.includes(KIMI_ID),
      `${label}: names the model — the thing the raw text omits`,
    );
    assert.ok(explained.includes(requested), `${label}: states what was requested (${requested})`);
    assert.ok(explained.includes(limit), `${label}: states what is enforced (${limit})`);
    assert.ok(
      /not a fault in acpx/i.test(explained),
      `${label}: says whose fault it is — the whole point`,
    );
    assert.ok(/different model/i.test(explained), `${label}: states the remedy`);
    assert.ok(explained.includes(raw), `${label}: keeps the provider's own text verbatim`);
  }
});

test("0095b715: the endpoint-context refusal is explained as its own cause, not folded in", () => {
  // A DIFFERENT cause with a DIFFERENT remedy: here a shorter conversation
  // genuinely can help, and in the ceiling case it cannot. Collapsing the two
  // would hand the user advice that does not work.
  const raw =
    "This endpoint's maximum context length is 32768 tokens. However, you requested about 65544 tokens (8 of text input, 65536 in the output). Please reduce the length of either one.";
  const explained = explainPiTurnError(raw, "deepseek/deepseek-v3.2");

  assert.ok(explained, "must be recognised");
  assert.ok(explained.includes("deepseek/deepseek-v3.2"), "names the model");
  assert.ok(explained.includes("32768") && explained.includes("65544"), "states both numbers");
  assert.ok(/shorten the conversation/i.test(explained), "offers the remedy that applies HERE");
  assert.ok(
    !/publishes a higher ceiling/i.test(explained),
    "and NOT the output-ceiling explanation, which would be the wrong diagnosis",
  );
});

test("0095b715 CONTROL: an unrecognised failure passes through UNCHANGED", () => {
  // The restraint half, and it is load-bearing in the same way 4ec33f59's is:
  // returning a generic acpx wrapper for every failure would bury the adapter's
  // own text under boilerplate — this module's harm, in the other direction.
  for (const raw of [
    "pi could not complete the turn: upstream provider returned no completion",
    '429: {"message":"temporarily rate-limited upstream"}',
    "ECONNRESET",
    "max_tokens is a fine phrase to mention with no numbers attached",
  ]) {
    assert.equal(
      explainPiTurnError(raw, KIMI_ID),
      undefined,
      `must not rewrite an error it does not understand: ${raw.slice(0, 40)}`,
    );
  }
  assert.equal(explainPiTurnError("", KIMI_ID), undefined, "an empty error is not an error");
});

test("0095b715: the explanation still works when the session has no model id", () => {
  // `current_model_id` can be absent; the explanation must degrade to a phrase
  // rather than to the string "undefined" in front of a user.
  const explained = explainPiTurnError(MEASURED_OUTPUT_CEILING[0][1], undefined);
  assert.ok(explained, "still recognised");
  assert.ok(!explained.includes("undefined"), "never renders the literal word `undefined`");
  assert.ok(/pinned model/i.test(explained), "falls back to a readable phrase");
});

// ---------------------------------------------------------------------------
// The WIRING. The explainer being correct is not the same claim as acpx
// actually calling it, and the seam it sits on is the one 4ec33f59 warns is
// invisible from inside this repo: `buildDeliveryEvent` substitutes
// EMPTY_DELIVERY_ERROR whenever `error` is absent, and acpx-ui treats a
// non-empty message as the failure note. So both directions are pinned here.
// ---------------------------------------------------------------------------

test("0095b715: the delivery terminal carries acpx's explanation, not the raw payload", () => {
  const raw = MEASURED_OUTPUT_CEILING[0][1];
  const note = turnErrorForDeliveryTerminal("end_turn", raw, KIMI_ID);

  assert.ok(note, "a failed turn still reports");
  assert.notEqual(note, raw, "the raw provider payload is not what reaches the user");
  assert.ok(note.includes(KIMI_ID), "the note names the model");
  assert.ok(note.includes(raw), "and still carries the provider's own text verbatim");
});

test("0095b715 CONTROL: the terminal invents no note for a turn that did not fail", () => {
  // The 4ec33f59 property, re-pinned at the seam this brick touched: widening it
  // stamps a failure note onto every successful turn in acpx-ui.
  assert.equal(turnErrorForDeliveryTerminal("end_turn", undefined, KIMI_ID), undefined);
  assert.equal(
    turnErrorForDeliveryTerminal("cancelled", MEASURED_OUTPUT_CEILING[0][1], KIMI_ID),
    undefined,
    "a cancelled turn reports nothing, even when the adapter supplied an error",
  );
});

test("0095b715 CONTROL: an unexplained failure still reaches the terminal unchanged", () => {
  // The adapter's own wording must survive when acpx has nothing better to say —
  // it is the only account of the failure anyone gets.
  const raw = "pi could not complete the turn: upstream provider returned no completion";
  assert.equal(turnErrorForDeliveryTerminal("end_turn", raw, KIMI_ID), raw);
});
