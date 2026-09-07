import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AcpClient } from "../src/acp/client.js";
import { applyPromptModelIfAdvertised } from "../src/cli/session/runtime.js";
import { createSessionConversation } from "../src/session/conversation-model.js";
import { defaultSessionEventLog } from "../src/session/event-log.js";
import { SESSION_RECORD_SCHEMA, type SessionRecord } from "../src/types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Brick 007eaac8 — THE TURN PATH.
//
// 🛑 WHY THIS FILE EXISTS, IN ONE SENTENCE: a picker-route session CREATED
// cleanly, took the user's first prompt, and then FAILED the turn with "the ACP
// agent did not advertise that model", while the picker advertised claude's
// OpenRouter rows as selectable — an honest refusal at create had been converted
// into an invitation that broke on use.
//
// ⚠️ AND WHY THE EXISTING TESTS DID NOT CATCH IT. The create path goes through
// `applyRequestedModelIfAdvertised`, where the out-of-band suppression lived; the
// PROMPT path does not go through that dispatcher — it calls
// `assertRequestedModelSupported` itself. So a four-route accept/refuse table was
// 4/4 correct and a create-time suite was green while the first turn was broken.
// A decision test is not an engagement test, and neither is a turn test.
// Measured on session cd93c99f (2026-09-07): the shim WAS engaged — its isolated
// `or-<id>` config dir existed and `current_model_id` carried the slug — and the
// turn threw anyway.
//
// ⚠️ THIS FILE IS DELIBERATELY SEPARATE from `openrouter-picker-route.test.ts`
// (the decision/unit half) so the two cannot be confused for each other, and it
// is named so it cannot collide with another lane's `pi-models-store.test.ts`.
// ─────────────────────────────────────────────────────────────────────────────

const SLUG = "moonshotai/kimi-k3";

/** The adapter's REAL advertisement — deliberately WITHOUT the slug. That is the
 *  whole point: claude-agent-acp advertises only its own aliases, so an
 *  unsuppressed apply throws exactly here. */
const CLAUDE_ADVERTISED = ["default", "opus[1m]", "sonnet", "haiku", "opus", "fable"];

function recordFor(model: string, currentModelId: string = model): SessionRecord {
  const now = "2026-09-07T00:00:00.000Z";
  return {
    schema: SESSION_RECORD_SCHEMA,
    acpxRecordId: "turn-record-007eaac8",
    acpSessionId: "acp-session-007eaac8",
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    cwd: "/tmp/workspace",
    createdAt: now,
    lastUsedAt: now,
    lastSeq: 0,
    lastRequestId: undefined,
    eventLog: defaultSessionEventLog("turn-record-007eaac8"),
    closed: false,
    closedAt: undefined,
    pid: undefined,
    agentStartedAt: undefined,
    protocolVersion: undefined,
    agentCapabilities: undefined,
    ...createSessionConversation(now),
    acpx: {
      available_models: CLAUDE_ADVERTISED,
      current_model_id: currentModelId,
      session_options: { model, model_source: "explicit" },
    },
  };
}

/** A stub standing in for `AcpClient`, recording every ACP model call it is asked
 *  to make. `outOfBandModelId` is the ONE field the suppression turns on. */
function clientStub(outOfBandModelId: string | undefined) {
  const wireCalls: string[] = [];
  const client = {
    outOfBandModelId,
    setSessionModel: async (_sessionId: string, modelId: string) => {
      wireCalls.push(modelId);
    },
    setSessionConfigOption: async () => ({}),
    modelSetMethodIsUnsupported: false,
  } as unknown as AcpClient;
  return { client, wireCalls };
}

/**
 * ⚠️ ISOLATE THE STORE BEFORE THE PIN IS PERSISTED. `persistChangedModelPin`
 * writes a real session record, and `ACPX_STATE_HOME` is the seam that decides
 * where (`repository.ts:94`). Without this the test would write into devbox's
 * PRODUCTION session store — creating a record is a write even when nothing is
 * ever prompted.
 */
function isolatedStore(t: { after: (fn: () => void) => void }): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-l7-turn-"));
  const previous = process.env.ACPX_STATE_HOME;
  process.env.ACPX_STATE_HOME = home;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.ACPX_STATE_HOME;
    } else {
      process.env.ACPX_STATE_HOME = previous;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
  return home;
}

test("THE REGRESSION — a turn on a picker-route session does not throw and sends nothing on the wire", async (t) => {
  const home = isolatedStore(t);
  const { client, wireCalls } = clientStub(SLUG);
  // `current_model_id` deliberately starts on something ELSE, so the pin actually
  // CHANGES and `persistChangedModelPin` really writes. Starting it already on the
  // slug makes that helper return early, and the store assertion below would then
  // be asserting a write that never had to happen.
  const record = recordFor(SLUG, "sonnet");

  // Before the fix this call threw:
  //   Cannot apply --model "moonshotai/kimi-k3": the ACP agent did not advertise
  //   that model. Available models: default, opus[1m], sonnet, …
  await applyPromptModelIfAdvertised({
    client,
    sessionId: record.acpSessionId,
    requestedModel: SLUG,
    requestedModelSource: "explicit",
    record,
    verbose: false,
  });

  assert.deepEqual(wireCalls, [], "the slug must never reach session/set_model");
  assert.equal(record.acpx?.current_model_id, SLUG);
  // `setDesiredModelId` writes `session_options.model` (mode-preference.ts:247-256),
  // not a `desired_model_id` key — the first draft asserted the latter and the
  // typechecker refused it.
  assert.equal(record.acpx?.session_options?.model, SLUG, "the pin is persisted, not skipped");
  // The store this wrote to is the temp one, which is also the proof the
  // production store was never touched.
  assert.ok(fs.existsSync(path.join(home, ".acpx", "sessions")), "the isolated store was used");
});

test("THE NEGATIVE CONTROL — with nothing served out of band the SAME call still throws", async (t) => {
  // ⚠️ WITHOUT THIS ROW THE TEST ABOVE PROVES NOTHING. "Did not throw" is equally
  // consistent with "the suppression fired" and with "this path never checks the
  // advertisement at all" — and the second reading would mean the guard that
  // catches a genuinely bogus model on claude had been deleted. This row is what
  // separates them: identical inputs, `outOfBandModelId` undefined, must throw.
  isolatedStore(t);
  const { client, wireCalls } = clientStub(undefined);
  await assert.rejects(
    applyPromptModelIfAdvertised({
      client,
      sessionId: "acp-session-007eaac8",
      requestedModel: SLUG,
      requestedModelSource: "explicit",
      record: recordFor(SLUG),
      verbose: false,
    }),
    /did not advertise that model/,
  );
  assert.deepEqual(wireCalls, []);
});

test("THE SUPPRESSION IS EXACT — a claude alias on the same session still goes on the wire", async (t) => {
  // The other way the fix could be wrong: a client that is serving ONE model out
  // of band must not become a blanket no-op for every other model on that
  // session, or the suppression would hide real failures instead of one
  // known-good case.
  isolatedStore(t);
  const { client, wireCalls } = clientStub(SLUG);
  const record = recordFor(SLUG);
  record.acpx = { ...record.acpx, current_model_id: "sonnet" };

  await applyPromptModelIfAdvertised({
    client,
    sessionId: record.acpSessionId,
    requestedModel: "haiku",
    requestedModelSource: "explicit",
    record,
    verbose: false,
  });

  assert.deepEqual(wireCalls, ["haiku"], "an ordinary claude alias must still be applied");
});
