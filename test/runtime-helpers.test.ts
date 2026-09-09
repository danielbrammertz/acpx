import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  AcpRuntimeError,
  decodeAcpxRuntimeHandleState,
  isAcpRuntimeError,
} from "../src/runtime.js";
import {
  applyConversation,
  applyLifecycleSnapshotToRecord,
  reconcileAgentSessionId,
  sessionHasAgentMessages,
} from "../src/runtime/engine/lifecycle.js";
import { shouldReuseExistingRecord } from "../src/runtime/engine/reuse-policy.js";
import { encodeAcpxRuntimeHandleState } from "../src/runtime/public/handle-state.js";
import {
  asOptionalBoolean,
  asOptionalString,
  asString,
  asTrimmedString,
  deriveAgentFromSessionKey,
  isRecord,
} from "../src/runtime/public/shared.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

test("runtime handle state codecs preserve valid payloads and reject invalid ones", () => {
  const encoded = encodeAcpxRuntimeHandleState({
    name: "agent:codex:acp:test",
    agent: "codex",
    cwd: "/tmp/acpx",
    mode: "persistent",
    acpxRecordId: "agent:codex:acp:test",
    backendSessionId: "sid-1",
    agentSessionId: "inner-1",
  });

  assert.deepEqual(decodeAcpxRuntimeHandleState(encoded), {
    name: "agent:codex:acp:test",
    agent: "codex",
    cwd: "/tmp/acpx",
    mode: "persistent",
    acpxRecordId: "agent:codex:acp:test",
    backendSessionId: "sid-1",
    agentSessionId: "inner-1",
  });
  assert.equal(decodeAcpxRuntimeHandleState("acpx:v2:bad-json"), null);
  assert.equal(
    decodeAcpxRuntimeHandleState(
      "acpx:v2:" +
        Buffer.from(
          JSON.stringify({
            name: "agent:codex:acp:test",
            agent: "codex",
            cwd: "/tmp/acpx",
            mode: "invalid",
          }),
          "utf8",
        ).toString("base64url"),
    ),
    null,
  );
});

test("runtime shared helpers normalize structured values", () => {
  assert.equal(isRecord({ ok: true }), true);
  assert.equal(isRecord(["nope"]), false);
  assert.equal(asTrimmedString("  hi  "), "hi");
  assert.equal(asTrimmedString(17), "");
  assert.equal(asString("raw"), "raw");
  assert.equal(asString(17), undefined);
  assert.equal(asOptionalString("  value  "), "value");
  assert.equal(asOptionalString("   "), undefined);
  assert.equal(asOptionalBoolean(true), true);
  assert.equal(asOptionalBoolean("true"), undefined);
  assert.equal(deriveAgentFromSessionKey("agent:claude:acp:test", "codex"), "claude");
  assert.equal(deriveAgentFromSessionKey("plain-session", "codex"), "codex");
});

test("runtime errors preserve codes and can be identified safely", () => {
  const cause = new Error("boom");
  const error = new AcpRuntimeError("ACP_TURN_FAILED", "turn failed", { cause });
  assert.equal(error.name, "AcpRuntimeError");
  assert.equal(error.code, "ACP_TURN_FAILED");
  assert.equal(error.cause, cause);
  assert.equal(isAcpRuntimeError(error), true);
  assert.equal(isAcpRuntimeError(new Error("plain")), false);
});

test("runtime lifecycle helpers update records from runtime snapshots and conversations", () => {
  const record = makeSessionRecord({
    acpxRecordId: "lifecycle-record",
    acpSessionId: "sid-1",
    agentCommand: "codex --acp",
    cwd: "/workspace",
    lastAgentExitCode: 7,
    lastAgentExitSignal: "SIGTERM",
    lastAgentExitAt: "2026-01-01T00:05:00.000Z",
    lastAgentDisconnectReason: "terminated",
  });

  applyLifecycleSnapshotToRecord(record, {
    pid: 321,
    startedAt: "2026-01-01T00:01:00.000Z",
    running: false,
    lastExit: {
      exitCode: 9,
      signal: "SIGKILL",
      exitedAt: "2026-01-01T00:10:00.000Z",
      reason: "process_exit",
      unexpectedDuringPrompt: true,
    },
  });
  assert.equal(record.pid, undefined);
  assert.equal(record.agentStartedAt, "2026-01-01T00:01:00.000Z");
  assert.equal(record.lastAgentExitCode, 9);
  assert.equal(record.lastAgentExitSignal, "SIGKILL");
  assert.equal(record.lastAgentExitAt, "2026-01-01T00:10:00.000Z");
  assert.equal(record.lastAgentDisconnectReason, "process_exit");
  // The mid-turn-vs-reap signal is carried onto the record (and cleared on a fresh
  // running snapshot below).
  assert.equal(record.lastAgentUnexpectedDuringPrompt, true);

  applyLifecycleSnapshotToRecord(record, {
    pid: 654,
    startedAt: "2026-01-01T00:12:00.000Z",
    running: true,
  });
  assert.equal(record.pid, 654);
  assert.equal(record.lastAgentExitCode, undefined);
  assert.equal(record.lastAgentExitSignal, undefined);
  assert.equal(record.lastAgentExitAt, undefined);
  assert.equal(record.lastAgentDisconnectReason, undefined);
  assert.equal(record.lastAgentUnexpectedDuringPrompt, undefined);

  reconcileAgentSessionId(record, "  runtime-123  ");
  assert.equal(record.agentSessionId, "runtime-123");
  reconcileAgentSessionId(record, "   ");
  assert.equal(record.agentSessionId, "runtime-123");

  const conversation = {
    title: "Session title",
    updated_at: "2026-01-01T00:20:00.000Z",
    messages: [
      {
        Agent: {
          content: [{ Text: "hello" }],
          tool_results: {},
        },
      },
    ],
    cumulative_token_usage: { input_tokens: 11 },
    request_token_usage: {
      req_1: {
        output_tokens: 22,
      },
    },
  };
  applyConversation(record, conversation);
  assert.equal(record.title, "Session title");
  assert.equal(record.updated_at, "2026-01-01T00:20:00.000Z");
  assert.equal(sessionHasAgentMessages(conversation), true);
  assert.equal(
    sessionHasAgentMessages({
      ...conversation,
      messages: [{ User: { id: "u1", content: [{ Text: "hi" }] } }],
    }),
    false,
  );
});

test("runtime reuse policy only keeps compatible records", () => {
  const base = {
    cwd: path.resolve("/workspace"),
    agentCommand: "codex --acp",
    acpSessionId: "sid-1",
    acpx: {},
  };
  assert.equal(
    shouldReuseExistingRecord(base, {
      cwd: "/workspace",
      agentCommand: "codex --acp",
      resumeSessionId: "sid-1",
    }),
    true,
  );
  assert.equal(
    shouldReuseExistingRecord(base, {
      cwd: "/workspace/other",
      agentCommand: "codex --acp",
    }),
    false,
  );
  assert.equal(
    shouldReuseExistingRecord(base, {
      cwd: "/workspace",
      agentCommand: "claude --acp",
    }),
    false,
  );
  assert.equal(
    shouldReuseExistingRecord(base, {
      cwd: "/workspace",
      agentCommand: "codex --acp",
      resumeSessionId: "sid-2",
    }),
    false,
  );
  assert.equal(
    shouldReuseExistingRecord(
      {
        ...base,
        acpx: {
          reset_on_next_ensure: true,
        },
      },
      {
        cwd: "/workspace",
        agentCommand: "codex --acp",
      },
    ),
    false,
  );
});

// --- served_via_shim stickiness (brick://a89c3cd4) --------------------------
// The consumer is the cold-resume transcript gate, which runs AFTER teardown —
// and teardown produces a snapshot with servedViaShim unset. If the write leg
// cleared the stored value on a falsy snapshot, the record would read "not
// shim-served" at exactly the moment the truth is needed, reproducing the defect
// the field exists to fix. Every assertion below is about that one property.

test("applyLifecycleSnapshotToRecord records served_via_shim when a shim served the session", () => {
  const record = makeSessionRecord({
    acpxRecordId: "shim-record",
    acpSessionId: "sid-shim",
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    cwd: "/workspace",
  });

  applyLifecycleSnapshotToRecord(record, { running: true, servedViaShim: true });

  assert.equal(record.acpx?.session_options?.served_via_shim, true);
});

test("applyLifecycleSnapshotToRecord does NOT clear served_via_shim on a teardown snapshot", () => {
  const record = makeSessionRecord({
    acpxRecordId: "shim-record",
    acpSessionId: "sid-shim",
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    cwd: "/workspace",
  });

  // 1. a shim serves the session
  applyLifecycleSnapshotToRecord(record, { running: true, servedViaShim: true });
  assert.equal(record.acpx?.session_options?.served_via_shim, true);

  // 2. teardown: the client stops the shim, so the snapshot no longer carries it.
  //    This is the exact snapshot shape `resetAgentState` produces, and the exact
  //    moment a naive `else` branch would write `false`.
  applyLifecycleSnapshotToRecord(record, {
    running: false,
    lastExit: {
      exitCode: 0,
      signal: null,
      exitedAt: "2026-01-01T00:10:00.000Z",
      reason: "connection_close",
      unexpectedDuringPrompt: false,
    },
  });

  assert.equal(
    record.acpx?.session_options?.served_via_shim,
    true,
    "the turns a stopped shim already served stay served — the cold-resume gate reads this AFTER teardown",
  );
});

test("applyLifecycleSnapshotToRecord leaves served_via_shim ABSENT for a session no shim served", () => {
  const record = makeSessionRecord({
    acpxRecordId: "plain-record",
    acpSessionId: "sid-plain",
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    cwd: "/workspace",
  });

  applyLifecycleSnapshotToRecord(record, { running: true });

  // ABSENT, not `false`: absent means "acpx cannot say" and is what every record
  // written before this field looks like. Writing `false` here would assert a
  // fact acpx never observed, and would be indistinguishable from those.
  assert.equal(
    Object.prototype.hasOwnProperty.call(record.acpx?.session_options ?? {}, "served_via_shim"),
    false,
  );
});
