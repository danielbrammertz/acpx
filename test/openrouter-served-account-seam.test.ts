import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OPENROUTER_SOURCE, recordIsOpenRouterServed } from "../src/acp/openrouter-routing.js";
import { AGENT_REGISTRY } from "../src/agent-registry.js";
import { buildCatalogue } from "../src/models/catalogue.js";
import type { OpenRouterSnapshot } from "../src/models/openrouter-catalogue.js";
import { switchSessionAccount } from "../src/runtime/engine/account-seam.js";
import { failoverEnabledForRecord } from "../src/runtime/engine/failover.js";
import { repairAccountSeamRecords } from "../src/session/account-seam-repair.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

// Daniel's three findings on the claude + OpenRouter picker, devbox-staging
// 2026-09-08: brick https://acpx.devbox.nativai.de/?brick=b29215b7.
//
// 🔑 THE AXIS UNDER TEST, AND WHY THE EXISTING SEAM TESTS CANNOT REACH IT.
// `test/claude-family-seam.test.ts` pins the seam on the HARNESS axis: a codex or
// pi record is refused because its adapter is not Claude-family. Every assertion
// there passes unchanged on the session that actually broke, because that session
// IS the claude harness — only its MODEL is served by OpenRouter, on the box key,
// through the picker route. Harness-family and credential-provider are two
// different questions and this file is the second one.

// ── fixtures ─────────────────────────────────────────────────────────────────

// Same fixture + cwd rule as openrouter-picker-route.test.ts: the suite runs the
// COMPILED tests out of dist-test/, where the fixture folder does not exist.
const FIXTURE_PATH = path.resolve(process.cwd(), "test/fixtures/openrouter-models-2026-09-04.json");
const META = { fetchedAt: "2026-09-04T00:10:56.992Z", stale: false, error: null };

function catalogue() {
  const snapshot = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as OpenRouterSnapshot;
  return buildCatalogue(snapshot.models, META);
}

/** A bare OpenRouter slug that is in the fixture and is not a harness-native alias. */
function anOpenRouterId(): string {
  const row = catalogue().models.find((model) => model.source === OPENROUTER_SOURCE);
  assert.ok(row, "the fixture must contain at least one OpenRouter row");
  return row.id;
}

/**
 * ⚠️ THE REAL COMMAND STRING, NOT A SYNTHETIC ONE — and that is a correctness
 * requirement here, not tidiness. `Projects/acpx/PROJECT.md` records that acpx's
 * fixtures use synthetic agent commands (`"claude"`, `"agent"`) that NO record in
 * the real store carries, so an adapter-keyed predicate can pass its whole suite
 * against shapes that never occur in production. This file asserts across TWO
 * such predicates at once — `isClaudeFamilyAgent` (the gates) and
 * `harnessIdForAgentCommand` (the route) — which disagree about a bare `"claude"`:
 * the seam tests pin `isClaudeFamilyAgent("claude") === false`. A synthetic
 * command would therefore make every test below vacuously green by failing the
 * gate rather than by passing the fix. This is the exact string measured on
 * Daniel's wedged record `9bbccf9a` on devbox-staging.
 */
const CLAUDE = AGENT_REGISTRY.claude;
const CODEX = AGENT_REGISTRY.codex;

/** The model Daniel actually picked, as an explicit source ref. */
const PICKED = `${OPENROUTER_SOURCE}:qwen/qwen3.8-flash`;

function recordFor(
  id: string,
  agentCommand: string,
  sessionOptions?: Record<string, unknown>,
): SessionRecord {
  return makeSessionRecord({
    acpxRecordId: id,
    acpSessionId: `${id}-acp`,
    agentCommand,
    cwd: "/workspace/projects/temp",
    ...(sessionOptions ? { acpx: { session_options: sessionOptions } } : {}),
  });
}

/** Exactly the shape read off Daniel's record: an OR model + a Claude subscription. */
const WEDGED_OPTIONS = {
  model: PICKED,
  profile: "sub7",
  model_source: "explicit",
  account_switch: {
    fromProfile: "sub5",
    toProfile: "sub7",
    fromAccount: "sub5",
    toAccount: "sub7",
    reason: "selection",
    at: "2026-09-08T22:05:27.034Z",
  },
};

// ── the predicate ────────────────────────────────────────────────────────────

test("recordIsOpenRouterServed separates the MODEL's provider from the HARNESS's family", async () => {
  // The positive case is the whole point: a claude record — Claude-family by
  // every existing predicate — whose model is served by OpenRouter.
  assert.equal(await recordIsOpenRouterServed(recordFor("a", CLAUDE, { model: PICKED })), true);

  // A claude-native model on the same harness is NOT OpenRouter-served, so the
  // seam must keep working exactly as before for it. Without this arm the
  // predicate could return `true` unconditionally and every gate below would
  // still look green while silently disabling failover for the whole fleet.
  assert.equal(await recordIsOpenRouterServed(recordFor("b", CLAUDE, { model: "sonnet" })), false);
  assert.equal(
    await recordIsOpenRouterServed(recordFor("c", CLAUDE, { model: "opus[1m]" })),
    false,
  );

  // No model recorded at all — the common case for a session on its default.
  assert.equal(await recordIsOpenRouterServed(recordFor("d", CLAUDE)), false);
  assert.equal(await recordIsOpenRouterServed(recordFor("e", CLAUDE, {})), false);

  // A harness that does not route arbitrary ids via the shim never takes the
  // route, whatever its model string says.
  assert.equal(await recordIsOpenRouterServed(recordFor("f", CODEX, { model: PICKED })), false);
});

test("a BARE slug resolves through the catalogue — and a cold cache stands aside", async () => {
  // Daniel's record carries a bare `qwen/qwen3.8-flash`, NOT the `openrouter:`
  // form, so the prefix-only path above would not have covered the case that
  // actually broke. Measured on devbox-staging 2026-09-08: his models-cache.json
  // does contain that row, so the gate fires on his record.
  const bare = anOpenRouterId();
  const record = recordFor("g", CLAUDE, { model: bare });
  assert.equal(await recordIsOpenRouterServed(record, { catalogue: catalogue() }), true);

  // ⚠️ THE STAND-ASIDE DIRECTION, ASSERTED DELIBERATELY. With no catalogue acpx
  // cannot tell a slug it has not fetched from an alias, so it does not route —
  // and this predicate must answer the SAME `false`, because the gates it feeds
  // have to agree with what the spawn actually did. A gate that fired here while
  // the spawn ran on the subscription would disable failover for a session a
  // Claude account really is paying for.
  assert.equal(
    await recordIsOpenRouterServed(record, { catalogue: buildCatalogue([], META) }),
    false,
  );
});

// ── the writer end ───────────────────────────────────────────────────────────

/**
 * A target that exists in no registry, so the call fails on the LOOKUP rather
 * than performing a real account switch against whatever profiles this box
 * happens to have. That keeps the paired control below honest on any box, and
 * keeps a unit test from porting transcripts around a live `~/.acpx`.
 */
const ABSENT_TARGET = "no-such-profile-for-this-test";

test("the seam discriminates on the MODEL's provider — one call, two records, two errors", async () => {
  // 🔑 A PAIRED CONTROL, NOT TWO SEPARATE ASSERTIONS. The identical call is made
  // twice, differing ONLY in the recorded model. Without the second arm the first
  // would pass just as well against a seam that refused every claude record —
  // i.e. against a fix that had silently disabled subscription switching for the
  // whole fleet.

  // (a) OpenRouter-served → refused BY THE SEAM, before the registry is consulted.
  const served = recordFor("rec-picker-writer", CLAUDE, { model: PICKED });
  await assert.rejects(
    () => switchSessionAccount(served, ABSENT_TARGET, "manual"),
    (error: Error) => {
      assert.equal(error.name, "AccountSwitchError");
      assert.match(error.message, /served by OpenRouter/);
      // The message must name the model, so a user who hits this knows WHICH
      // choice put the session outside the subscription world.
      assert.match(error.message, /qwen\/qwen3\.8-flash/);
      // It must NOT be the lookup error — proving the refusal came first.
      assert.doesNotMatch(error.message, new RegExp(ABSENT_TARGET));
      return true;
    },
  );

  // The refusal happens before any write. A partial write here IS the corruption
  // the gate exists to prevent — it is what a later resume then dies demanding.
  assert.equal(served.acpx?.session_options?.profile, undefined);
  assert.equal(served.acpx?.session_options?.account_switch, undefined);

  // (b) claude-native → gets PAST the seam and fails later, naming the absent
  // target. That the error is the LOOKUP's is what proves the seam let it by.
  const native = recordFor("rec-native-writer", CLAUDE, { model: "sonnet" });
  await assert.rejects(
    () => switchSessionAccount(native, ABSENT_TARGET, "manual"),
    (error: Error) => {
      assert.doesNotMatch(
        error.message,
        /served by OpenRouter/,
        "a claude-native session must not be refused by the OpenRouter seam",
      );
      assert.match(error.message, new RegExp(ABSENT_TARGET));
      return true;
    },
  );
});

test("the pre-turn selector WITHHOLDS the profile for an OpenRouter-served session", async () => {
  // 🔑 THE PREVENTION HALF, AND THE ONE WITH NO OTHER WITNESS. The refusal above
  // covers the MANUAL path. What actually wedged Daniel was the AUTOMATIC one:
  // auto-failover rotated sub5 -> sub7 with reason "selection" on his second
  // message. That path must not throw — it must find no profile at all, which is
  // what makes `selectSubscriptionBeforeTurn` / `enforceSubscriptionLockBeforeTurn`
  // no-op. `failoverEnabledForRecord` is the exported window onto that decision.
  //
  // ⚠️ Reads this box's real profile registry, like the seam tests beside it. The
  // native arm is therefore also the guard against a vacuous pass: if the registry
  // were missing, BOTH arms would be false and the OpenRouter arm would prove
  // nothing.
  const native = recordFor("rec-native-failover", CLAUDE, { model: "sonnet" });
  assert.equal(
    await failoverEnabledForRecord(native),
    true,
    "control: a claude-native session must keep auto-failover (needs a registry default with a transcript anchor)",
  );

  const served = recordFor("rec-picker-failover", CLAUDE, { model: PICKED });
  assert.equal(
    await failoverEnabledForRecord(served),
    false,
    "an OpenRouter-served session has no Claude account to fail over BETWEEN",
  );
});

// ── the sweep ────────────────────────────────────────────────────────────────

async function seedRecordFile(storeDir: string, record: SessionRecord): Promise<void> {
  const file = path.join(storeDir, `${encodeURIComponent(record.acpxRecordId)}.json`);
  await fsp.writeFile(file, JSON.stringify({ acpx_record_id: record.acpxRecordId }, null, 2));
}

test("the sweep FREES an already-wedged picker-route claude record, and still spares a healthy one", async () => {
  const storeDir = await fsp.mkdtemp(path.join(os.tmpdir(), "acpx-or-seam-sweep-"));
  try {
    // The record that actually broke: claude harness, OpenRouter model, a Claude
    // subscription and a pending switch it can never satisfy.
    const wedged = recordFor("rec-9bbccf9a", CLAUDE, { ...WEDGED_OPTIONS });
    // ⚠️ THE SPARED CONTROL. Same harness, same fields, claude-native model — a
    // real subscription session mid-failover. Sweeping this would strip a live
    // Claude session's account state, which is strictly worse than the bug.
    const healthy = recordFor("rec-healthy-claude", CLAUDE, {
      model: "sonnet",
      profile: "sub7",
      account_switch: { ...WEDGED_OPTIONS.account_switch },
    });
    const records = [wedged, healthy];
    for (const record of records) {
      await seedRecordFile(storeDir, record);
    }

    const saved: string[] = [];
    const options = {
      backupDir: path.join(storeDir, "backups"),
      loadRecords: async () => records,
      saveRecord: async (record: SessionRecord) => {
        saved.push(record.acpxRecordId);
      },
      storeDir: () => storeDir,
      isRecordBusy: async () => false,
    };

    // (a) DRY RUN — finds the population, writes nothing.
    const preview = await repairAccountSeamRecords({ ...options, dryRun: true });
    assert.deepEqual(
      preview.repaired.map((entry) => entry.acpxRecordId),
      ["rec-9bbccf9a"],
    );
    assert.equal(saved.length, 0, "a dry run must not write");
    assert.equal(wedged.acpx?.session_options?.profile, "sub7", "a dry run must not mutate");

    // (b) THE REAL RUN.
    const result = await repairAccountSeamRecords(options);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(saved, ["rec-9bbccf9a"]);
    assert.equal(result.skippedClaudeFamily, 1, "the claude-native record is still spared");

    // The wedged record is free: nothing left for the resume gate to demand.
    assert.equal(wedged.acpx?.session_options?.account_switch, undefined);
    assert.equal(wedged.acpx?.session_options?.profile, undefined);
    // ⚠️ Its MODEL must survive — the repair clears the credential fields it
    // should never have had, and must not silently take the user's model choice
    // away with them.
    assert.equal(wedged.acpx?.session_options?.model, PICKED);

    // The healthy record is untouched in every field.
    assert.equal(healthy.acpx?.session_options?.profile, "sub7");
    assert.ok(healthy.acpx?.session_options?.account_switch);

    // (c) IDEMPOTENT — a second run finds nothing, because the first removed the
    // only thing it looks for.
    const again = await repairAccountSeamRecords({ ...options, dryRun: true });
    assert.deepEqual(again.repaired, []);
  } finally {
    await fsp.rm(storeDir, { recursive: true, force: true });
  }
});
