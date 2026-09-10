import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyHarnessConfigDir } from "../src/acp/harness-config-dir.js";
import {
  type OpenRouterProviderObject,
  type OpenRouterRoutingPolicy,
  resolveProviderObject,
} from "../src/acp/openrouter-provider-policy.js";
import { resetPiKnowledgeMemo } from "../src/acp/pi-model-knowledge.js";

// T4 — brick 4c272cab §6.2: the box's provider policy in pi's generated
// `models.json`, at both levels pi merges (provider-wide → per model).
//
// A SEPARATE FILE FROM `pi-models-store.test.ts` on purpose: that file's fixture
// builds its own env and has no seam for a settings file, and widening it would
// touch every row in a 655-line file two other lanes are also editing. The
// fixture here is the same shape, plus `ui-settings.json`.
//
// 🛑 **PI'S OWN LOADER CANNOT CATCH A MISTAKE IN THIS BLOCK — MEASURED, AND IT
// OVERTURNS THE BRIEF'S R3.** CONCEPTION §6.2 warns that a malformed `compat`
// makes `ModelConfig.load` return an error object and pi compose an EMPTY config.
// Probed 2026-09-10 against the deployed pi 0.84.4
// (`dist/core/model-config.js`, `ModelConfig.load` is async and reports on
// `.error`): `{openRouterRouting:{totally_bogus_field:123}}` → **accepted**,
// `{openRouterRouting:{order:"baseten"}}` (a string where an array belongs) →
// **accepted**, and a wrong-typed `allow_fallbacks` inside `modelOverrides` →
// **accepted**. The reason is structural: `compat` is a UNION of several
// all-optional TypeBox objects, and TypeBox objects admit additional properties,
// so a wrong shape simply matches a permissive branch.
//
// ⇒ The failure mode is NOT "pi has no models". It is that pi forwards the block
// VERBATIM and **OpenRouter 400s every turn** (measured probes P and R). So the
// only guard is acpx's own side: `resolveProviderObject` is the sole producer,
// and the schema conformance row below is what pins its output. Do not relax it
// on the grounds that "pi validates it" — pi does not.

const PI_COMMAND = "node /opt/pi-acp/dist/index.js";

/**
 * pi 0.84.4's `openRouterRouting` members, transcribed from
 * `dist/core/model-config.d.ts:57-88` (`ProviderCompatSchema`) on 2026-09-10.
 *
 * Transcribed rather than imported: importing the deployed pi would pin this
 * suite to a box path, and a test that measures the box is the failure
 * `adapter-version-pins.test.ts` exists to warn about. The live check against the
 * real schema (and against a real pi turn, which is the behavioural form) belongs
 * to the implementation self-test, not here — it is recorded in
 * `verification/IMPL-SELFTEST-acpx.md`.
 *
 * ⚠️ RE-TRANSCRIBE WHEN THE PINNED pi VERSION MOVES.
 */
const PI_OPENROUTER_ROUTING_SCHEMA: Record<string, "boolean" | "string[]" | "percentiles"> = {
  allow_fallbacks: "boolean",
  require_parameters: "boolean",
  enforce_distillable_text: "boolean",
  zdr: "boolean",
  order: "string[]",
  only: "string[]",
  ignore: "string[]",
  quantizations: "string[]",
  preferred_min_throughput: "percentiles",
  preferred_max_latency: "percentiles",
};

type Fixture = { root: string; env: NodeJS.ProcessEnv };

function fixture(policy?: OpenRouterRoutingPolicy): Fixture {
  const root = mkdtempSync(join(tmpdir(), "acpx-pi-routing-test-"));
  const home = join(root, "home");
  mkdirSync(join(home, ".acpx"), { recursive: true });
  if (policy) {
    writeFileSync(
      join(home, ".acpx", "ui-settings.json"),
      JSON.stringify({ version: 1, defaultNewSessionCwd: null, openrouterRouting: policy }),
      "utf8",
    );
  }
  writeFileSync(
    join(root, "pi-knowledge.json"),
    JSON.stringify({ fetchedAt: new Date().toISOString(), ids: [] }),
  );
  writeFileSync(
    join(root, "models-cache.json"),
    JSON.stringify({ fetchedAt: new Date().toISOString(), models: [] }),
  );
  resetPiKnowledgeMemo();
  return {
    root,
    env: {
      HOME: home,
      ACPX_PI_KNOWLEDGE_CACHE: join(root, "pi-knowledge.json"),
      ACPX_MODELS_CACHE: join(root, "models-cache.json"),
      // Not a real command: a code path that tried to SPAWN pi fails loudly
      // rather than quietly measuring the box's real pi.
      PATH: "/nonexistent-so-a-spawn-cannot-silently-succeed",
    },
  };
}

function modelsJsonFor(fx: Fixture, provisionModelId?: string): Record<string, unknown> {
  const plan = applyHarnessConfigDir({
    env: fx.env,
    agentCommand: PI_COMMAND,
    sessionId: `s-${Math.random().toString(36).slice(2)}`,
    provisionModelId,
    rootDir: join(fx.root, "cfg"),
  });
  assert.ok(plan, "applyHarnessConfigDir must produce a plan for the pi harness");
  const path = join(plan.dir, "models.json");
  assert.ok(existsSync(path), "models.json must be written");
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function openrouterBlock(json: Record<string, unknown>): Record<string, unknown> {
  const providers = json.providers as Record<string, unknown>;
  return providers.openrouter as Record<string, unknown>;
}

test("A8 · no policy ⇒ models.json is byte-identical to a box that never had one", () => {
  const without = fixture();
  const withEmpty = fixture({});
  try {
    const baseline = modelsJsonFor(without, "openrouter/z-ai/glm-5.3-flash");
    const empty = modelsJsonFor(withEmpty, "openrouter/z-ai/glm-5.3-flash");
    assert.equal("compat" in openrouterBlock(baseline), false, "no compat block at all");
    // `{}` on disk must reach the same file as no key at all — the one
    // representation of "auto" (CONCEPTION K4), enforced on the READ side too.
    assert.deepEqual(empty, baseline);
  } finally {
    rmSync(without.root, { recursive: true, force: true });
    rmSync(withEmpty.root, { recursive: true, force: true });
  }
});

test("T4 · a box-wide policy lands at PROVIDER level, where pi maps it over every model", () => {
  const fx = fixture({ minQuantization: "fp8", ignore: ["wafer"], minThroughput: { p50: 60 } });
  try {
    const block = openrouterBlock(modelsJsonFor(fx, "openrouter/z-ai/glm-5.3-flash"));
    const compat = block.compat as { openRouterRouting: OpenRouterProviderObject };
    assert.deepEqual(compat.openRouterRouting, {
      ignore: ["wafer"],
      quantizations: ["int8", "fp8", "mxfp8", "fp16", "bf16", "fp32", "unknown"],
      preferred_min_throughput: { p50: 60 },
      allow_fallbacks: true,
    });
    // Provider level, not per model: pi merges `providerConfig.compat` into every
    // openrouter model it knows, so the box floor covers models acpx has never
    // heard of — which is the whole point of putting it there.
    //
    // ⚠️ ASSERTED ON THE `compat` KEY, NOT ON THE ENTRY. The provisioned model
    // already HAS a `modelOverrides` entry — its `maxTokens` cap (brick
    // 0095b715) — so "no entry" would be the wrong question and would go red on
    // correct code.
    const overrides = (block.modelOverrides ?? {}) as Record<string, Record<string, unknown>>;
    for (const [id, entry] of Object.entries(overrides)) {
      assert.equal(
        "compat" in entry,
        false,
        `a box-wide-only policy writes no per-model routing override (found one on ${id})`,
      );
    }
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("T4 · a perModel order lands in modelOverrides, complete, without erasing the maxTokens cap", () => {
  const fx = fixture({
    minQuantization: "fp8",
    ignore: ["wafer"],
    perModel: { "z-ai/glm-5.3-flash": { order: ["baseten", "modal"] } },
  });
  try {
    const block = openrouterBlock(modelsJsonFor(fx, "openrouter/z-ai/glm-5.3-flash"));
    const overrides = block.modelOverrides as Record<
      string,
      { maxTokens?: number; compat?: { openRouterRouting: OpenRouterProviderObject } }
    >;
    const entry = overrides["z-ai/glm-5.3-flash"];
    assert.ok(entry, "the model named by the policy must get an override");
    // COMPLETE, not a delta: the model-level object carries the box-wide bounds
    // too, so the file says what acpx means without depending on pi's merge.
    assert.deepEqual(entry.compat?.openRouterRouting, {
      order: ["baseten", "modal"],
      ignore: ["wafer"],
      quantizations: ["int8", "fp8", "mxfp8", "fp16", "bf16", "fp32", "unknown"],
      allow_fallbacks: true,
    });
    // The two override builders are independent contributors to one id — a
    // routing override that dropped the output cap would re-open brick 0095b715.
    assert.equal(typeof entry.maxTokens, "number", "the maxTokens cap must survive the merge");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("T4 · a session that named NO model still gets the box policy", () => {
  // Same necessity as the Anthropic baseUrl repair: a session created without
  // `--model` can still `session/set_model` onto any model pi offers, and would
  // otherwise be the one case the policy did not cover.
  const fx = fixture({ ignore: ["wafer"] });
  try {
    const block = openrouterBlock(modelsJsonFor(fx, undefined));
    const compat = block.compat as { openRouterRouting: OpenRouterProviderObject };
    assert.deepEqual(compat.openRouterRouting.ignore, ["wafer"]);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("T4 · every key the emitter can produce is in pi's openRouterRouting schema", () => {
  // BY CONSTRUCTION, not by inspection of one example: the maximal policy below
  // drives every branch of `resolveProviderObject`, so any key a future change
  // adds to the emitter appears here and must be justified against the schema.
  const maximal: OpenRouterRoutingPolicy = {
    minQuantization: "fp4",
    allowUnknownQuantization: false,
    minThroughput: { p50: 60, p75: 70, p90: 80, p99: 90 },
    ignore: ["wafer", "venice"],
    perModel: { "m/x": { order: ["baseten", "modal"], allowFallbacks: false } },
  };
  const emitted = resolveProviderObject(maximal, "m/x");
  assert.ok(emitted);
  const keys = Object.keys(emitted);
  assert.deepEqual(
    keys.toSorted(),
    ["allow_fallbacks", "ignore", "order", "preferred_min_throughput", "quantizations"],
    "the emitter's full key surface — extend the schema check below if this grows",
  );
  for (const [key, value] of Object.entries(emitted)) {
    const expected = PI_OPENROUTER_ROUTING_SCHEMA[key];
    assert.ok(expected, `"${key}" is not a member of pi's openRouterRouting schema`);
    if (expected === "boolean") {
      assert.equal(typeof value, "boolean", `${key} must be a boolean`);
    } else if (expected === "string[]") {
      assert.ok(
        Array.isArray(value) && value.every((entry) => typeof entry === "string"),
        `${key} must be an array of strings`,
      );
    } else {
      assert.ok(
        Object.entries(value as Record<string, unknown>).every(
          ([percentile, amount]) => /^p\d+$/.test(percentile) && typeof amount === "number",
        ),
        `${key} must be percentile-keyed numbers`,
      );
    }
  }
});
