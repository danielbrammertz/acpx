import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { attachAttribution, OpenRouterAttributionLog } from "../src/acp/openrouter-attribution.js";
import { applyLifecycleSnapshotToRecord } from "../src/runtime/engine/lifecycle.js";
import {
  cloneSessionAcpxState,
  createSessionConversation,
  recordSessionUpdate,
} from "../src/session/conversation-model.js";
import { rememberSessionCost } from "../src/session/cost-ingest.js";
import {
  readSessionIndex,
  toSessionIndexEntry,
  writeSessionIndex,
} from "../src/session/persistence/index.js";
import type { SessionAcpxState } from "../src/types.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

// T9 — brick 4c272cab §8 / acceptance A9: the record says WHO SERVED the turn.
//
// 🛑 THE PROPERTY UNDER TEST IS FALSIFIABILITY. The rows below all exist to stop
// one specific substitution: recording the provider the box PREFERRED instead of
// the one that served. That substitution cannot be caught by a green build — it
// makes the record agree with the policy by construction, including on the turns
// where the policy did not hold, which is precisely when the record matters.
// Measured: BaseTen and Crusoe were both hard-429 for an afternoon while a
// correct policy was in force.

const RATES = {
  in_per_m: 1,
  out_per_m: 1,
  cache_read_per_m: 0,
  cache_write_per_m: 0,
  measured_free: false,
};

function logFile(): string {
  return path.join(mkdtempSync(path.join(os.tmpdir(), "acpx-attr-test-")), "or.ndjson");
}

function line(provider: string, native: string | null = "stop"): string {
  return `${JSON.stringify({
    ts: new Date().toISOString(),
    provider,
    model: "z-ai/glm-5.3-flash",
    native_finish_reason: native,
    gen_id: "gen-1",
  })}\n`;
}

test("the cursor CONSUMES: a second read with no new response returns undefined", () => {
  // Re-reading the tail would attribute a stale response to a turn that produced
  // none — a wrong answer that looks exactly like a right one.
  const file = logFile();
  writeFileSync(file, line("Modal"), "utf8");
  const log = new OpenRouterAttributionLog(file);
  assert.deepEqual(log.takeLatest(), {
    provider_name: "Modal",
    native_finish_reason: "stop",
  });
  assert.equal(log.takeLatest(), undefined, "nothing new ⇒ nothing to attribute");

  appendFileSync(file, line("BaseTen", "eos_token"));
  assert.deepEqual(log.takeLatest(), {
    provider_name: "BaseTen",
    native_finish_reason: "eos_token",
  });
});

test("several responses in one turn ⇒ the LAST unconsumed one", () => {
  // A tool loop produces several upstream responses per turn; the ingest folds
  // one unit per assistant message, so the newest line is the one that produced it.
  const file = logFile();
  writeFileSync(file, line("Crusoe") + line("Modal") + line("Parasail"), "utf8");
  assert.equal(new OpenRouterAttributionLog(file).takeLatest()?.provider_name, "Parasail");
});

test("an absent, empty or mangled log is undefined — never a throw, never a guess", () => {
  assert.equal(new OpenRouterAttributionLog("/nonexistent/or.ndjson").takeLatest(), undefined);

  const empty = logFile();
  writeFileSync(empty, "", "utf8");
  assert.equal(new OpenRouterAttributionLog(empty).takeLatest(), undefined);

  const mangled = logFile();
  writeFileSync(mangled, "{ truncated\n", "utf8");
  assert.equal(new OpenRouterAttributionLog(mangled).takeLatest(), undefined);

  // A line with no provider is not an attribution: absence stays absence.
  const noProvider = logFile();
  writeFileSync(noProvider, `${JSON.stringify({ ts: "x", gen_id: "g" })}\n`, "utf8");
  assert.equal(new OpenRouterAttributionLog(noProvider).takeLatest(), undefined);
});

test("a truncated log rewinds the cursor instead of going blind forever", () => {
  // A fresh shim on the same path restarts the file. Without the rewind the
  // cursor would sit past the new end and every later response would be missed.
  const file = logFile();
  writeFileSync(file, line("Modal") + line("BaseTen"), "utf8");
  const log = new OpenRouterAttributionLog(file);
  assert.equal(log.takeLatest()?.provider_name, "BaseTen");
  writeFileSync(file, line("Crusoe"), "utf8");
  assert.equal(log.takeLatest()?.provider_name, "Crusoe");
});

test("T9 · a recorded turn carries the SERVED provider on its cost unit", () => {
  const acpx: SessionAcpxState = { current_model_id: "z-ai/glm-5.3-flash" };
  rememberSessionCost(
    acpx,
    {
      input: 100,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      attribution: { provider_name: "Modal", native_finish_reason: "eos_token" },
    },
    () => RATES,
  );
  const unit = acpx.cost_units?.[0];
  assert.equal(unit?.provider_name, "Modal");
  assert.equal(unit?.native_finish_reason, "eos_token");
});

test("T9 · the client's WRITER and the record's READER are one pair, end to end", () => {
  // 🛑 THE FAILURE THIS ROW EXISTS FOR IS SILENT IN BOTH DIRECTIONS. The client
  // writes `_meta.acpx.orAttribution`; the cost ingest reads it back. A typo in
  // either path produces no error and no type failure — just a record that never
  // carries a provider, on a build where every other test is green. Asserting the
  // two literals separately would let them agree by luck, so the round trip goes
  // through BOTH real functions and lands on the real record.
  const update: Record<string, unknown> = {
    sessionUpdate: "usage_update",
    used: 1000,
    size: 200_000,
    _meta: { piAcp: { message: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } } },
  };
  attachAttribution(update, { provider_name: "Modal", native_finish_reason: "eos_token" });

  const conversation = createSessionConversation();
  const acpx = recordSessionUpdate(conversation, { current_model_id: "z-ai/glm-5.3-flash" }, {
    sessionId: "s-1",
    update,
  } as unknown as Parameters<typeof recordSessionUpdate>[2]);
  const unit = acpx.cost_units?.at(-1);
  assert.equal(unit?.provider_name, "Modal", "the provider must survive writer → reader → record");
  assert.equal(unit?.native_finish_reason, "eos_token");
});

test("T9 · attribution lands on the record even with NO cost unit — the shim-path case", () => {
  // 🛑 THE DEFECT THIS ROW WAS WRITTEN FOR, FOUND ON A LIVE RIG TURN. The first
  // implementation stamped the provider onto the cost UNIT only. The cost ingest
  // fires solely for a `_meta.piAcp.message` block, so a Claude/OpenRouter
  // session produces ZERO units — measured: the shim's log held two responses
  // (Modal, Z.AI) and the saved record had `cost_units: []`. The ONE path that
  // can observe a provider was the one path with nowhere to put it, and every
  // unit test was green because they all fed a pi-shaped update.
  const update: Record<string, unknown> = {
    sessionUpdate: "usage_update",
    used: 26_052,
    size: 1_000_000,
  };
  attachAttribution(update, { provider_name: "Z.AI", native_finish_reason: "stop" });

  const acpx = recordSessionUpdate(createSessionConversation(), {}, {
    sessionId: "s-2",
    update,
  } as unknown as Parameters<typeof recordSessionUpdate>[2]);
  assert.equal(acpx.cost_units, undefined, "a Claude-shaped update produces no cost unit");
  assert.equal(acpx.last_turn_provider?.provider_name, "Z.AI");
  assert.equal(acpx.last_turn_provider?.native_finish_reason, "stop");
  assert.equal(typeof acpx.last_turn_provider?.at, "string", "stamped, so a reader can age it");
});

test("T9 · a later usage update with NO attribution does not blank the recorded one", () => {
  // A turn emits several usage updates and only the ones following an upstream
  // response carry a block. Clearing on absence would erase a truthful value
  // moments after writing it.
  const conversation = createSessionConversation();
  const first: Record<string, unknown> = { sessionUpdate: "usage_update", used: 10, size: 1000 };
  attachAttribution(first, { provider_name: "BaseTen", native_finish_reason: null });
  let acpx = recordSessionUpdate(conversation, {}, {
    sessionId: "s-3",
    update: first,
  } as unknown as Parameters<typeof recordSessionUpdate>[2]);
  acpx = recordSessionUpdate(conversation, acpx, {
    sessionId: "s-3",
    update: { sessionUpdate: "usage_update", used: 20, size: 1000 },
  } as unknown as Parameters<typeof recordSessionUpdate>[2]);
  assert.equal(acpx.last_turn_provider?.provider_name, "BaseTen");
});

test("T9 · the field survives cloneSessionAcpxState — the allowlist that ate three fields", () => {
  // ⚠️ Missing from that allowlist, this field is present at `sessions new` and
  // GONE after one prompt, with the whole suite green, because the turn path
  // re-bases `record.acpx` off the clone.
  const cloned = cloneSessionAcpxState({
    last_turn_provider: {
      provider_name: "BaseTen",
      native_finish_reason: "stop",
      at: "2026-09-10T09:00:00.000Z",
    },
  });
  assert.deepEqual(cloned?.last_turn_provider, {
    provider_name: "BaseTen",
    native_finish_reason: "stop",
    at: "2026-09-10T09:00:00.000Z",
  });
});

test("T9 · both index legs carry it — projection AND reconcile-preservation", () => {
  // The chat header reads its view from the index entry on the enriched hot
  // path, so a field that stopped at the record would fail only at RUNTIME. And
  // a field missing from the PARSER is stripped on the next daemon rewrite even
  // when the projection is right — the brick://874fee67 both-legs rule.
  const record = makeSessionRecord({
    acpxRecordId: "attr-1",
    acpSessionId: "acp-attr-1",
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    cwd: "/workspace/x",
    acpx: {
      last_turn_provider: {
        provider_name: "Z.AI",
        native_finish_reason: "stop",
        at: "2026-09-10T09:00:00.000Z",
      },
    },
  });
  const entry = toSessionIndexEntry(record, "attr-1.json");
  assert.equal(entry.lastTurnProvider, "Z.AI");
  assert.equal(entry.lastTurnNativeFinishReason, "stop");
  assert.equal(entry.lastTurnProviderAt, "2026-09-10T09:00:00.000Z");
});

test("T9 · the index entry survives the read-back — else a daemon rewrite strips it", async () => {
  const record = makeSessionRecord({
    acpxRecordId: "attr-2",
    acpSessionId: "acp-attr-2",
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    cwd: "/workspace/x",
    acpx: {
      last_turn_provider: {
        provider_name: "BaseTen",
        native_finish_reason: "stop",
        at: "2026-09-10T09:00:00.000Z",
      },
    },
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-attr-index-"));
  try {
    const entry = toSessionIndexEntry(record, "attr-2.json");
    await writeSessionIndex(dir, { files: ["attr-2.json"], entries: [entry] });
    const reloaded = await readSessionIndex(dir);
    assert.equal(reloaded?.entries[0].lastTurnProvider, "BaseTen");
    assert.equal(reloaded?.entries[0].lastTurnNativeFinishReason, "stop");
    assert.equal(reloaded?.entries[0].lastTurnProviderAt, "2026-09-10T09:00:00.000Z");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("F-3 · a line written AFTER the usage update still reaches the record", () => {
  // 🛑 THE BELT FOR THE RACE. The shim now writes the moment the provider is
  // readable, so the usage_update path normally has it — but "normally" is what
  // this brick's first cut relied on, and a first turn recorded `null` 3/3
  // against real OpenRouter with the provider sitting correctly in the log.
  //
  // This row deliberately reproduces the LOSING order: the usage update happens
  // with an EMPTY log, and the line lands only afterwards. The record must still
  // end up with the provider, via the turn-end read the lifecycle snapshot does.
  const file = logFile();
  writeFileSync(file, "", "utf8");
  const log = new OpenRouterAttributionLog(file);

  // 1. usage update arrives first — nothing to attach, so the record says null.
  assert.equal(log.takeLatest(), undefined, "the losing order: nothing on disk yet");

  // 2. the shim's line lands late.
  appendFileSync(file, line("Together", null));

  // 3. the next read — the one the snapshot performs when the record is written.
  const late = log.takeLatest();
  assert.equal(late?.provider_name, "Together");
});

test("F-3 · the turn-END leg writes the record even when no usage update carried it", () => {
  // The other half of the belt: the lifecycle snapshot is built when the record
  // is WRITTEN — after the turn — so this leg is what turns a late line into a
  // recorded provider. Truthy-gated like every other breadcrumb, so a snapshot
  // with nothing new leaves a value already on the record alone.
  const record = makeSessionRecord({
    acpxRecordId: "attr-late-1",
    acpSessionId: "acp-attr-late-1",
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    cwd: "/workspace/x",
  });
  applyLifecycleSnapshotToRecord(record, {
    running: true,
    lastTurnProvider: {
      provider_name: "Together",
      native_finish_reason: null,
      at: "2026-09-10T10:45:00.000Z",
    },
  });
  assert.equal(record.acpx?.last_turn_provider?.provider_name, "Together");

  applyLifecycleSnapshotToRecord(record, { running: false });
  assert.equal(
    record.acpx?.last_turn_provider?.provider_name,
    "Together",
    "a later empty snapshot must not blank it",
  );
});

test("F-3 · a MISSING log is silent; an unreadable one is not", () => {
  // ENOENT is the ordinary state of a session that has not talked to OpenRouter,
  // and warning on it would train every reader to ignore the line. Anything else
  // is a real fault that used to be indistinguishable from "no new response".
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    written.push(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    assert.equal(new OpenRouterAttributionLog("/nonexistent/or.ndjson").takeLatest(), undefined);
    assert.deepEqual(written, [], "a missing log says nothing");

    // A DIRECTORY where a file belongs: statSync succeeds, the read fails EISDIR.
    const dir = mkdtempSync(path.join(os.tmpdir(), "acpx-attr-unreadable-"));
    assert.equal(new OpenRouterAttributionLog(dir).takeLatest(), undefined, "still no throw");
    assert.equal(written.length, 1, `expected one warning, got ${JSON.stringify(written)}`);
    assert.match(written[0], /could not read the OpenRouter attribution log/);
  } finally {
    process.stderr.write = original;
  }
});

test("T9 · a turn with no attribution carries null — not the preferred provider", () => {
  // Every non-shim path (pi, Codex, a native Claude subscription) lands here.
  const acpx: SessionAcpxState = { current_model_id: "z-ai/glm-5.3-flash" };
  rememberSessionCost(acpx, { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, () => RATES);
  const unit = acpx.cost_units?.[0];
  assert.ok(unit, "a priceable observation must still produce a unit");
  assert.equal(unit.provider_name, null);
  assert.equal(unit.native_finish_reason, null);
  // Present-and-null, not absent: a consumer must be able to tell "this build
  // records attribution and had none" from "this record predates the field".
  assert.equal("provider_name" in unit, true);
});
