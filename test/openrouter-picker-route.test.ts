import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ARBITRARY_MODEL_SUPPORT_ROUTED_BY_ACPX } from "../src/acp/harness-capabilities.js";
import {
  assertNoOpenRouterProfileConflict,
  harnessRoutesModelViaShim,
  openRouterBoxCredentialMissing,
  resolveOpenRouterBoxCredential,
  resolveOpenRouterRouteModel,
} from "../src/acp/openrouter-routing.js";
import { buildCatalogue } from "../src/models/catalogue.js";
import type { OpenRouterSnapshot } from "../src/models/openrouter-catalogue.js";
import { applyRequestedModelIfAdvertised } from "../src/session/model-application.js";

// Brick 007eaac8 — Daniel's founding item 6: claude's OpenRouter shim now takes a
// PICKER-chosen slug on the BOX key, not only the profile's model.
// Conception: brick 007eaac8 `conception/CONCEPTION-L7-via-shim-routing.md`.

// Same fixture + cwd resolution rule as models-catalogue.test.ts: the suite runs
// the COMPILED tests out of dist-test/, where the fixture folder does not exist.
const FIXTURE_PATH = path.resolve(process.cwd(), "test/fixtures/openrouter-models-2026-09-04.json");
const META = { fetchedAt: "2026-09-04T00:10:56.992Z", stale: false, error: null };

function catalogue() {
  const snapshot = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as OpenRouterSnapshot;
  return buildCatalogue(snapshot.models, META);
}

/**
 * An OpenRouter id that is in the fixture and is NOT a harness-native alias.
 * Read off the fixture rather than hardcoded, so the test cannot quietly become
 * vacuous if the roster moves.
 */
function anOpenRouterId(): string {
  const row = catalogue().models.find((model) => model.source === "openrouter");
  assert.ok(row, "the fixture must contain at least one OpenRouter row");
  return row.id;
}

const CLAUDE = "claude";

// ── The declaration and the route are ONE predicate ──────────────────────────

test("via-shim is routed today, and the route asks the SHIPPED array", () => {
  // The declaration half. Pinned here as well as in harness-capabilities.test.ts
  // because this file is where the ROUTE's behaviour is asserted, and the two
  // halves shipping together is the property under test.
  assert.deepEqual([...ARBITRARY_MODEL_SUPPORT_ROUTED_BY_ACPX], ["via-shim"]);
  assert.equal(harnessRoutesModelViaShim(CLAUDE), true);
  // Harnesses whose backend is genuinely fixed must never route, whatever the
  // array says — the support field is the first term of the AND.
  assert.equal(harnessRoutesModelViaShim("codex"), false);
  assert.equal(harnessRoutesModelViaShim("claude-pty"), false);
  assert.equal(harnessRoutesModelViaShim(undefined), false);
});

test("emptying the routed list turns the ROUTE off, not just the declaration", async () => {
  // A2. This is the property that makes "declaration and routing land together"
  // structural rather than a promise: the resolver consults
  // `deriveAcceptsArbitraryModelIds`, so removing the kind stops the spawn from
  // starting a shim in the same edit that stops the picker offering the band.
  //
  // The paired POSITIVE CONTROL is the next assertion, on the same call with the
  // same model — without it, an `undefined` here would be indistinguishable from
  // a resolver that can never route anything.
  const model = anOpenRouterId();
  assert.equal(harnessRoutesModelViaShim(CLAUDE, []), false);
  assert.equal(
    await resolveOpenRouterRouteModel({
      agentCommand: "claude-agent-acp",
      model,
      options: { routedSupport: [], catalogue: catalogue() },
    }),
    undefined,
  );
  assert.equal(
    await resolveOpenRouterRouteModel({
      agentCommand: "claude-agent-acp",
      model,
      options: { routedSupport: ["via-shim"], catalogue: catalogue() },
    }),
    model,
    "positive control: the SAME call routes once the kind is listed",
  );
});

// ── Which models take the route ──────────────────────────────────────────────

test("an OpenRouter slug routes; a claude-native alias does not", async () => {
  // A3/A4. `sonnet` is the negative that matters: it is a real catalogue row
  // under `claude-subscription`, so a resolver that merely asked "is this id in
  // the catalogue?" would route it into the shim and take a claude session off
  // its subscription silently.
  const options = { catalogue: catalogue() };
  assert.equal(
    await resolveOpenRouterRouteModel({
      agentCommand: "claude-agent-acp",
      model: anOpenRouterId(),
      options,
    }),
    anOpenRouterId(),
  );
  for (const native of ["sonnet", "opus", "haiku", "default", "opus[1m]"]) {
    assert.equal(
      await resolveOpenRouterRouteModel({
        agentCommand: "claude-agent-acp",
        model: native,
        options,
      }),
      undefined,
      `${native} must stay on the claude backend`,
    );
  }
});

test("when ONE id exists under both sources, the harness-native row wins", async () => {
  // ⚠️ THIS ROW EXISTS BECAUSE THE ROW ABOVE COULD NOT CATCH THE BUG IT NAMES.
  // A mutation probe deleted the native-wins check in `routeIdFromCatalogue` and
  // the whole file still passed: no id in the real fixture is BOTH a claude alias
  // and an OpenRouter slug (OpenRouter ids are `vendor/model`), so the guard was
  // never the thing making `sonnet` stand aside — the absence of an OpenRouter
  // `sonnet` was. The assertion above was true and vacuous, which is the pair
  // that survives review.
  //
  // So the collision is CONSTRUCTED here: an OpenRouter row whose id collides with
  // a real claude-native alias. The guard is the only thing that can answer it,
  // and the failure it prevents is severe — silently taking a claude session off
  // its subscription and onto a metered OpenRouter model of the same name.
  const collider = buildCatalogue([{ id: "sonnet", name: "Not the real Sonnet" }], META);
  // SUBJECT WITNESS — assert what the collision IS, not how many rows it has.
  // A count was the first form of this line and it was wrong (`sonnet` is a row
  // under claude-subscription, claude-home AND claude-pty, so the real answer was
  // 4, not 2): a count pins an unrelated fact and goes red for the wrong reason.
  const sonnetRows = collider.models.filter((model) => model.id === "sonnet");
  assert.equal(
    sonnetRows.filter((model) => model.source === "openrouter").length,
    1,
    "subject witness: an OpenRouter `sonnet` must exist, or this test proves nothing",
  );
  assert.ok(
    sonnetRows.some((model) => model.source === "claude-subscription"),
    "subject witness: a claude-native `sonnet` must exist, or there is no collision",
  );
  assert.equal(
    await resolveOpenRouterRouteModel({
      agentCommand: "claude-agent-acp",
      model: "sonnet",
      options: { catalogue: collider },
    }),
    undefined,
    "the claude-native reading is the one the caller meant",
  );
  // …and the caller can still reach the OpenRouter one deliberately, by prefix.
  assert.equal(
    await resolveOpenRouterRouteModel({
      agentCommand: "claude-agent-acp",
      model: "openrouter:sonnet",
      options: { catalogue: collider },
    }),
    "sonnet",
  );
});

test("an explicit source prefix settles the route without consulting the catalogue", async () => {
  const model = anOpenRouterId();
  assert.equal(
    await resolveOpenRouterRouteModel({
      agentCommand: "claude-agent-acp",
      model: `openrouter:${model}`,
      options: { catalogue: catalogue() },
    }),
    model,
    "the prefix is resolved away — OpenRouter is handed the bare slug",
  );
  assert.equal(
    await resolveOpenRouterRouteModel({
      agentCommand: "claude-agent-acp",
      model: "claude-subscription:sonnet",
      options: { catalogue: catalogue() },
    }),
    undefined,
  );
});

test("a cold catalogue STANDS ASIDE — it does not route and it does not throw", async () => {
  // A7. Same rule the `--model` gate already follows: with no OpenRouter rows,
  // acpx cannot tell an unknown slug from one it has not fetched. A session
  // creation must never fail because a third-party fetch was slow or down.
  const cold = buildCatalogue([], { fetchedAt: null, stale: true, error: null });
  assert.equal(
    await resolveOpenRouterRouteModel({
      agentCommand: "claude-agent-acp",
      model: "some-vendor/some-model",
      options: { catalogue: cold },
    }),
    undefined,
  );
  // …and the native rows are still present in a cold catalogue, so the claude
  // aliases keep answering correctly rather than falling into the OR route.
  assert.equal(
    await resolveOpenRouterRouteModel({
      agentCommand: "claude-agent-acp",
      model: "sonnet",
      options: { catalogue: cold },
    }),
    undefined,
  );
});

test("no model, and a non-via-shim harness, never route", async () => {
  const options = { catalogue: catalogue() };
  const model = anOpenRouterId();
  assert.equal(
    await resolveOpenRouterRouteModel({ agentCommand: "claude-agent-acp", model: "", options }),
    undefined,
  );
  assert.equal(
    await resolveOpenRouterRouteModel({ agentCommand: undefined, model, options }),
    undefined,
  );
});

// ── The credential ───────────────────────────────────────────────────────────

test("the box credential is FILE-FIRST, and names its origin without its value", (t) => {
  // A3. The literal below is a SYNTHETIC fixture value written into a temp dir —
  // no real credential is read, written or asserted anywhere in this file.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-l7-providers-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".acpx"), { recursive: true });
  const providersPath = path.join(home, ".acpx", "providers.json");
  fs.writeFileSync(
    providersPath,
    JSON.stringify({
      version: 1,
      box: "test-box",
      providers: { openrouter: { env: "OPENROUTER_API_KEY", apiKey: "fixture-file-key" } },
    }),
    { mode: 0o600 },
  );

  // A STALE ambient value is present on purpose: it is exactly the shape this
  // route must NOT prefer — a rotated key never reaches an already-running
  // process, so an inherited variable can be older than the file.
  const resolved = resolveOpenRouterBoxCredential({
    providersPath,
    env: { OPENROUTER_API_KEY: "fixture-stale-ambient-key" },
  });
  assert.equal(resolved?.origin, "providers.json");
  assert.equal(resolved?.envName, "OPENROUTER_API_KEY");
  assert.equal(resolved?.key, "fixture-file-key", "the FILE wins over the ambient variable");
});

test("with no provider entry the ambient variable is the last resort, then it refuses", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-l7-providers-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const absent = path.join(home, ".acpx", "providers.json");

  const ambient = resolveOpenRouterBoxCredential({
    providersPath: absent,
    env: { OPENROUTER_API_KEY: "fixture-ambient-key" },
  });
  assert.equal(ambient?.origin, "environment");
  assert.equal(ambient?.key, "fixture-ambient-key");

  assert.equal(resolveOpenRouterBoxCredential({ providersPath: absent, env: {} }), undefined);
  const refusal = openRouterBoxCredentialMissing("some-vendor/some-model");
  assert.match(refusal.message, /providers\.json/);
  assert.equal(refusal.detailCode, "OPENROUTER_BOX_CREDENTIAL_MISSING");
});

// ── The conflict ─────────────────────────────────────────────────────────────

test("a profile AND a picker-chosen OpenRouter model is refused, naming both accounts", () => {
  // A5. Two accounts, two budgets, no defensible silent winner. USAGE, not
  // RUNTIME: it is a caller input error, so acpx-ui renders an actionable notice
  // rather than an internal-error card.
  assert.throws(
    () =>
      assertNoOpenRouterProfileConflict({
        profileId: "openrouter-deepseek",
        routeModel: "some-vendor/some-model",
      }),
    (error: Error & { outputCode?: string; detailCode?: string }) => {
      assert.equal(error.outputCode, "USAGE");
      assert.equal(error.detailCode, "OPENROUTER_ROUTE_CONFLICT");
      assert.match(error.message, /openrouter-deepseek/);
      assert.match(error.message, /some-vendor\/some-model/);
      assert.match(error.message, /providers\.json/, "the box key must be named, not implied");
      return true;
    },
  );
});

// ── The other half of the routing: the ACP apply is suppressed ───────────────

function applyStub() {
  const calls: string[] = [];
  return {
    calls,
    client: {
      setSessionModel: async (_sessionId: string, modelId: string) => {
        calls.push(modelId);
      },
      setSessionConfigOption: async () => ({}),
    },
  };
}

test("an out-of-band model is NOT sent on the ACP wire, and reports applied:true", async () => {
  // A6. Without this, wiring the shim alone would break every picker-route
  // create: claude-agent-acp advertises only its own aliases, so the slug would
  // reach `assertRequestedModelSupported` and throw.
  const stub = applyStub();
  const outcome = await applyRequestedModelIfAdvertised({
    client: { ...stub.client, outOfBandModelId: "some-vendor/some-model" },
    sessionId: "s1",
    requestedModel: "some-vendor/some-model",
    // The adapter's real advertisement — deliberately WITHOUT the slug, which is
    // the whole point: this is the shape that used to throw.
    models: {
      availableModels: [{ modelId: "sonnet", name: "Sonnet" }],
      currentModelId: "sonnet",
    },
    agentCommand: "claude-agent-acp",
  });
  assert.equal(outcome.applied, true, "the model IS applied — through the shim");
  assert.deepEqual(stub.calls, [], "nothing may go to session/set_model");
});

test("the suppression is EXACT — a different model still takes the normal path", async () => {
  // The negative control for the assertion above: a client that is serving one
  // model out of band must not become a blanket no-op for every other model, or
  // the suppression would hide real failures instead of one known-good case.
  const stub = applyStub();
  const outcome = await applyRequestedModelIfAdvertised({
    client: { ...stub.client, outOfBandModelId: "some-vendor/some-model" },
    sessionId: "s1",
    requestedModel: "haiku",
    models: {
      availableModels: [
        { modelId: "sonnet", name: "Sonnet" },
        { modelId: "haiku", name: "Haiku" },
      ],
      currentModelId: "sonnet",
    },
    agentCommand: "claude-agent-acp",
  });
  assert.equal(outcome.applied, true);
  assert.deepEqual(stub.calls, ["haiku"]);
});

test("with nothing served out of band the apply path is byte-identical to before", async () => {
  const stub = applyStub();
  await assert.rejects(
    applyRequestedModelIfAdvertised({
      client: stub.client,
      sessionId: "s1",
      requestedModel: "some-vendor/some-model",
      models: {
        availableModels: [{ modelId: "sonnet", name: "Sonnet" }],
        currentModelId: "sonnet",
      },
      agentCommand: "claude-agent-acp",
    }),
    /did not advertise that model/,
    "the pre-brick refusal must still fire when acpx is NOT serving the model itself",
  );
  assert.deepEqual(stub.calls, []);
});
