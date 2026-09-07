import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyHarnessConfigDir } from "../src/acp/harness-config-dir.js";
import { readPiAdvertisedModelIds } from "../src/acp/pi-model-knowledge.js";
import { deriveBilling } from "../src/models/catalogue.js";
import { deriveCostFigure, reportedCost, type CostUnit } from "../src/models/cost-provenance.js";

// Brick 6253611b — Pi session cost renders as $0.
//
// ROOT CAUSE, proven: `writePiModelsStore` fabricated a catalogue entry with
// `cost {0,0,0,0}` and `contextWindow 128000`; pi merges that store over its
// BUNDLED catalogue BY ID, so the fabricated entry REPLACED pi's real, priced
// one. pi then priced the session at zero, faithfully, from rates we supplied.
//
// ⚠️ THE GUARD THAT WAS MEANT TO PREVENT THIS ASKED THE WRONG QUESTION: it
// consulted only the box's remote-OVERLAY cache. 333 of the 374 models pi
// advertises are BUNDLED, and on every dev box the overlay file does not exist
// at all — so the protection was unreachable for every model. These tests pin
// the corrected question, and the fourth one pins the state the box is ACTUALLY
// in, which is the case that would otherwise rot invisibly.
//
// Hermetic by construction: `ACPX_PI_KNOWLEDGE_CACHE` and `ACPX_MODELS_CACHE`
// are pointed at fixtures, so no `pi` process is spawned and no network is
// touched. A test that silently fell back to a real spawn would be measuring the
// box, not the change.

const PI_COMMAND = "node /opt/pi-acp/dist/index.js";

// Real values, transcribed from OpenRouter's own row for this model
// (`~/.acpx/models-cache.json`, 2026-09-07) and independently confirmed against
// pi's own bundled entry: 0.15 / 0.47 / 0.016 / 0.2 per 1M, ctx 1,000,000,
// max_completion_tokens 131,072. Using a model whose real numbers are KNOWN is
// what lets the assertions below be exact rather than merely "non-zero".
const KNOWN_ID = "qwen/qwen3.8-flash";
const KNOWN_ROW = {
  id: KNOWN_ID,
  name: "Qwen3.8 Flash",
  context_length: 1_000_000,
  top_provider: { context_length: 1_000_000, max_completion_tokens: 131_072 },
  pricing: {
    prompt: "0.00000015",
    completion: "0.00000047",
    input_cache_read: "0.000000016",
    input_cache_write: "0.0000002",
  },
};

type Fixture = { root: string; env: NodeJS.ProcessEnv; home: string };

function fixture(options: {
  piKnows?: string[];
  catalogue?: unknown[];
  boxOverlay?: unknown[];
}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "acpx-pi-store-test-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });

  const knowledgePath = join(root, "pi-knowledge.json");
  if (options.piKnows) {
    writeFileSync(
      knowledgePath,
      JSON.stringify({ fetchedAt: new Date().toISOString(), ids: options.piKnows }),
    );
  }

  const cataloguePath = join(root, "models-cache.json");
  if (options.catalogue) {
    writeFileSync(
      cataloguePath,
      JSON.stringify({ fetchedAt: new Date().toISOString(), models: options.catalogue }),
    );
  }

  if (options.boxOverlay) {
    const agentDir = join(home, ".pi", "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "models-store.json"),
      JSON.stringify({ openrouter: { lastModified: 1, checkedAt: 1, models: options.boxOverlay } }),
    );
  }

  return {
    root,
    home,
    env: {
      HOME: home,
      ACPX_PI_KNOWLEDGE_CACHE: knowledgePath,
      ACPX_MODELS_CACHE: cataloguePath,
      // Not a real command: if any code path tried to SPAWN pi, this would fail
      // loudly rather than quietly measuring the box's real pi.
      PATH: "/nonexistent-so-a-spawn-cannot-silently-succeed",
    },
  };
}

function storeFor(fx: Fixture, provisionModelId: string): { path: string; json: any } | null {
  const plan = applyHarnessConfigDir({
    env: fx.env,
    agentCommand: PI_COMMAND,
    sessionId: `s-${Math.random().toString(36).slice(2)}`,
    provisionModelId,
    rootDir: join(fx.root, "cfg"),
  });
  assert.ok(plan, "applyHarnessConfigDir must produce a plan for the pi harness");
  const path = join(plan.dir, "models-store.json");
  if (!existsSync(path)) {
    return null;
  }
  return { path, json: JSON.parse(readFileSync(path, "utf8")) };
}

test("CASE 1 — a model acpx CAN price gets pi's REAL rates, window and output cap, never zeros", () => {
  const fx = fixture({ piKnows: [], catalogue: [KNOWN_ROW] });
  try {
    const store = storeFor(fx, `openrouter/${KNOWN_ID}`);
    assert.ok(store, "an entry is required for a model pi does not know");
    const entry = store.json.openrouter.models.find((m: any) => m.id === KNOWN_ID);
    assert.ok(entry, "the provisioned slug must be present");

    // The defect, pinned by its real values rather than by "not zero": a
    // regression that reintroduced ANY of these three literals would be caught.
    //
    // ⚠️ Compared with a tolerance, NOT `deepEqual`. `0.0000002 * 1e6` is
    // `0.19999999999999998` in IEEE-754, and an exact assertion here would be a
    // test that fails on arithmetic rather than on behaviour — the classic way a
    // correct change gets reverted.
    assert.equal(entry.cost.input, 0.15);
    assert.equal(entry.cost.output, 0.47);
    assert.equal(entry.cost.cacheRead, 0.016);
    assert.ok(
      Math.abs(entry.cost.cacheWrite - 0.2) < 1e-12,
      `cacheWrite should be ~0.2, got ${entry.cost.cacheWrite}`,
    );
    assert.equal(
      entry.contextWindow,
      1_000_000,
      "the real window — 128000 caused ~8x early compaction",
    );
    assert.equal(entry.maxTokens, 131_072, "the real output cap — 16384 was an 8x cap for nothing");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("CASE 2 — a model acpx CANNOT price gets a ZERO cost block (pi crashes without one), not a missing one", () => {
  const fx = fixture({ piKnows: [], catalogue: [] });
  try {
    const store = storeFor(fx, "openrouter/vendor/never-heard-of-it");
    assert.ok(store, "an unknown model still needs an entry to be selectable at all");
    const entry = store.json.openrouter.models.find(
      (m: any) => m.id === "vendor/never-heard-of-it",
    );
    assert.ok(entry, "the provisioned slug must be present");

    // MEASURED against pi 0.84.4's own exported `calculateCost`: with `cost`
    // absent it throws `TypeError: Cannot read properties of undefined (reading
    // 'tiers')`, because pi's `?? []` guards a missing `tiers`, not a missing
    // `cost` — and pi's schema marks `cost` OPTIONAL, so the entry validates IN
    // and is then dereferenced. Omitting the block is the intuitive "honest"
    // move and it breaks the first turn of exactly the models nobody tests.
    //
    // The zero is an internal necessity of pi's data model, NOT a claim. That
    // the price is unknown is carried by acpx's own provenance field.
    assert.ok(entry.cost, "cost block MUST exist — pi dereferences it unconditionally");
    assert.deepEqual(entry.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.equal(entry.contextWindow, 128_000, "pi's fallback window, since acpx knows no better");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("CASE 3 — a model PI ALREADY KNOWS produces NO fabricated entry at all", () => {
  // The new behaviour, and nothing else tests it. Writing a "better" entry would
  // still clobber pi's own row and lose its `thinkingLevelMap`; the only correct
  // move is to write nothing.
  const fx = fixture({ piKnows: [KNOWN_ID], catalogue: [KNOWN_ROW] });
  try {
    const store = storeFor(fx, `openrouter/${KNOWN_ID}`);
    assert.equal(
      store,
      null,
      "no models-store.json may be written at all: the file itself is what displaces pi's block",
    );
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("CASE 4 — with the box overlay file ABSENT (the box's ACTUAL state) both rules still hold", () => {
  // ⚠️ THE CASE THAT WOULD ROT SILENTLY. Every real session runs under it: acpx
  // re-points PI_CODING_AGENT_DIR at a per-session dir it deletes at close, so
  // the box's overlay can never become populated. A fixture that accidentally
  // created one would make the other three tests pass for the wrong reason.
  const fx = fixture({ piKnows: [KNOWN_ID], catalogue: [KNOWN_ROW] });
  try {
    assert.equal(
      existsSync(join(fx.home, ".pi", "agent", "models-store.json")),
      false,
      "the fixture must NOT have an overlay — that is the condition under test",
    );
    assert.equal(storeFor(fx, `openrouter/${KNOWN_ID}`), null, "known ⇒ still no file");

    const unknown = storeFor(fx, "openrouter/vendor/never-heard-of-it");
    assert.ok(unknown, "unknown ⇒ still provisioned");
    assert.equal(unknown.json.openrouter.models.length, 1, "and the overlay contributes nothing");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("pi knowledge: a failure to ASK is null, and is not the same as an empty set", () => {
  // These two lead to opposite decisions — "pi knows nothing, provision
  // everything" vs "I could not establish it" — so they must not collapse.
  const root = mkdtempSync(join(tmpdir(), "acpx-pi-know-"));
  try {
    const cachePath = join(root, "k.json");
    assert.equal(
      readPiAdvertisedModelIds({}, { cachePath, readAdvertised: () => null }),
      null,
      "could not ask ⇒ null",
    );
    const empty = readPiAdvertisedModelIds({}, { cachePath, readAdvertised: () => [] });
    assert.ok(empty instanceof Set, "asked and got nothing ⇒ an empty Set, not null");
    assert.equal(empty.size, 0);

    // A stale cache beats nothing when pi cannot be asked.
    writeFileSync(
      cachePath,
      JSON.stringify({ fetchedAt: new Date(0).toISOString(), ids: ["a/b"] }),
    );
    const stale = readPiAdvertisedModelIds({}, { cachePath, readAdvertised: () => null });
    assert.deepEqual([...(stale ?? [])], ["a/b"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("billing carries the CACHE rates, and an unquoted rate is null — not zero", () => {
  const priced = deriveBilling(KNOWN_ROW as never);
  assert.equal(priced.kind, "metered");
  assert.equal(priced.cacheReadPerM, 0.016);
  assert.ok(
    Math.abs((priced.cacheWritePerM ?? 0) - 0.2) < 1e-12,
    "IEEE-754: 0.0000002*1e6 ≠ 0.2 exactly",
  );

  const noCacheRates = deriveBilling({
    id: "x/y",
    pricing: { prompt: "0.000001", completion: "0.000002" },
  } as never);
  assert.equal(noCacheRates.cacheReadPerM, null, "unquoted ⇒ null; a null rate is not a free rate");
  assert.equal(noCacheRates.cacheWritePerM, null);
});

// ── Layer 2 (inert): the stored cost shape ───────────────────────────────────

test("cost figure: coverage is COUNTS, and a partial total is kept, never nulled", () => {
  const rates = { inPerM: 1, outPerM: 2, cacheReadPerM: 0, cacheWritePerM: 0, measuredFree: false };
  const units: CostUnit[] = [
    { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, rates },
    { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, rates: null },
  ];
  const figure = deriveCostFigure(units);
  assert.equal(figure.provenance, "computed");
  assert.equal(figure.amount, 1, "the priced half is REAL and must survive as a lower bound");
  assert.deepEqual(figure.coverage, { unit: "message", priced: 1, total: 2 });
  assert.notEqual(figure.amount, null, "nulling a partially real number destroys information");
});

test("cost figure: `free` requires EVERY unit measured-free, and can never be partial", () => {
  const free = { inPerM: 0, outPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0, measuredFree: true };
  const paid = { inPerM: 1, outPerM: 1, cacheReadPerM: 0, cacheWritePerM: 0, measuredFree: false };
  const allFree = deriveCostFigure([
    { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, rates: free },
    { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, rates: free },
  ]);
  assert.equal(allFree.provenance, "free");
  assert.equal(allFree.amount, 0, "a MEASURED zero — $0.00 is correct for it");

  const mixed = deriveCostFigure([
    { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, rates: free },
    { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, rates: paid },
  ]);
  assert.equal(mixed.provenance, "computed", "a partial `free` would absorb the missing entries");
});

test("cost figure: nothing priceable ⇒ `unpriced` with amount null, and it still ships the counts", () => {
  const figure = deriveCostFigure([
    { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, rates: null },
    { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, rates: null },
  ]);
  assert.equal(figure.provenance, "unpriced");
  assert.equal(figure.amount, null, "unpriced must NEVER be rendered as $0.00");
  assert.deepEqual(figure.coverage, { unit: "message", priced: 0, total: 2 });
});

test("cost figure: `coverage: null` arises ONLY from a source with no units", () => {
  // The one meaning of null: "not decomposable by construction". A unit-bearing
  // derivation always emits counts, so a null from one would be a bug.
  assert.deepEqual(reportedCost(6.44), {
    amount: 6.44,
    currency: "USD",
    provenance: "reported",
    coverage: null,
  });
  assert.deepEqual(deriveCostFigure([]), {
    amount: null,
    currency: "USD",
    provenance: "unpriced",
    coverage: null,
  });
});
