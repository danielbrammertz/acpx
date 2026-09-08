import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_REGISTRY } from "../src/agent-registry.js";
import {
  assertPersistedKeyPolicy,
  findPersistedKeyPolicyViolations,
} from "../src/persisted-key-policy.js";
import { serializeSessionRecordForDisk } from "../src/session/persistence.js";
import type { SessionRecord } from "../src/types.js";

function makeRecord(): SessionRecord {
  return {
    schema: "acpx.session.v1",
    acpxRecordId: "record-1",
    acpSessionId: "session-1",
    agentSessionId: "agent-1",
    agentCommand: AGENT_REGISTRY.codex,
    cwd: "/tmp/project",
    createdAt: "2026-02-27T00:00:00.000Z",
    lastUsedAt: "2026-02-27T00:00:00.000Z",
    lastSeq: 4,
    lastRequestId: "req-1",
    eventLog: {
      active_path: "/tmp/record-1.stream.ndjson",
      segment_count: 2,
      max_segment_bytes: 1024,
      max_segments: 2,
      last_write_at: "2026-02-27T00:00:00.000Z",
      last_write_error: null,
    },
    closed: false,
    title: null,
    messages: [
      {
        User: {
          id: "user-1",
          content: [{ Text: "hello" }, { Audio: { source: "UklGRg==", mime_type: "audio/wav" } }],
        },
      },
      {
        Agent: {
          content: [
            { Text: "world" },
            {
              ToolUse: {
                id: "call_1",
                name: "run_command",
                raw_input: '{"command":"ls"}',
                input: {
                  command: "ls",
                },
                is_input_complete: true,
                thought_signature: null,
              },
            },
          ],
          tool_results: {
            call_1: {
              tool_use_id: "call_1",
              tool_name: "run_command",
              is_error: false,
              content: {
                Text: "ok",
              },
              output: {
                exitCode: 0,
              },
            },
          },
        },
      },
    ],
    updated_at: "2026-02-27T00:00:00.000Z",
    cumulative_token_usage: {},
    request_token_usage: {
      "5cf39f6d-9c4f-4d20-9e4b-739abc4b2554": {
        input_tokens: 1,
      },
    },
    acpx: {
      current_mode_id: "code",
      available_commands: ["run"],
    },
  };
}

test("serialized session record satisfies persisted key policy", () => {
  const persisted = serializeSessionRecordForDisk(makeRecord());
  assert.deepEqual(findPersistedKeyPolicyViolations(persisted), []);
  assertPersistedKeyPolicy(persisted);
});

test("persisted key policy rejects camelCase acpx-owned keys", () => {
  const persisted = serializeSessionRecordForDisk(makeRecord());
  persisted.requestId = "bad";

  const violations = findPersistedKeyPolicyViolations(persisted);
  assert.equal(violations.includes("requestId"), true);
  assert.throws(() => {
    assertPersistedKeyPolicy(persisted);
  }, /snake_case/);
});

test("persisted key policy allows pinned account_switch seam keys", () => {
  const record = makeRecord();
  record.acpx = {
    ...record.acpx,
    session_options: {
      profile: "subB",
      account_switch: {
        fromProfile: "subA",
        toProfile: "subB",
        fromAccount: "acct-a",
        toAccount: "acct-b",
        effectiveAccount: "acct-a",
        effectiveProfile: "subA",
        effectiveAuthMode: "subscription",
        effectiveAnchor: "/tmp/subA",
        effectiveResolutionMethod: "path",
        reason: "failover",
        at: "2026-06-13T00:00:00.000Z",
      },
    },
  };

  const persisted = serializeSessionRecordForDisk(record);
  assert.deepEqual(findPersistedKeyPolicyViolations(persisted), []);
  assertPersistedKeyPolicy(persisted);
});

/**
 * brick://48aca560 — the assert lives INSIDE serializeSessionRecordForDisk, not
 * in its callers, so no writer can bypass it. The tests' own record writers
 * (`test/cli.test.ts`, `test/runtime-test-helpers.ts`) call serialize and
 * `fs.writeFile` directly; while the assert sat in `repository.ts` they wrote
 * shapes production could never persist, and the suite stayed green.
 */
/**
 * ⚠️ THE SYNTHETIC FIELD NAME IS LOAD-BEARING — DO NOT SWAP IT FOR A REAL ONE.
 *
 * These two rows simulate "a field some future author adds", so they must not be
 * anchored to a field that actually exists: the moment another branch gives that
 * field a real element type, the row stops COMPILING and takes the whole suite
 * with it. That is not hypothetical — this pair originally used `cost_units`, and
 * brick://5026423b (which types it as `CostUnit[]`) broke it. Neither branch fails
 * alone; only the merge does, and `pnpm run typecheck` cannot see it because
 * `tsconfig.json` excludes `test/` while `tsconfig.test.json` includes it.
 */
test("serializeSessionRecordForDisk itself throws on a camelCase acpx key", () => {
  const record = makeRecord();
  record.acpx = {
    ...record.acpx,
    future_block: { camelKey: 1 },
  } as unknown as SessionRecord["acpx"];

  assert.throws(() => {
    serializeSessionRecordForDisk(record);
  }, /acpx\.future_block\.camelKey/);
});

test("serializeSessionRecordForDisk accepts the same record once the key is snake_case", () => {
  const record = makeRecord();
  record.acpx = {
    ...record.acpx,
    future_block: { camel_key: 1 },
  } as unknown as SessionRecord["acpx"];

  // CONTROL for the test above: the rejection must be about the KEY NAME, not
  // about `future_block` being unknown to the policy.
  assert.deepEqual(findPersistedKeyPolicyViolations(serializeSessionRecordForDisk(record)), []);
});

test("serializeSessionRecordForDisk rejects the provisioning_warning breadcrumb's old key names", () => {
  const record = makeRecord();
  record.acpx = {
    ...record.acpx,
    session_options: {
      provisioning_warning: {
        at: "2026-06-13T12:00:00.000Z",
        profileId: "home1",
        authMode: "claude-home",
        message: "hook install failed",
      },
    },
  } as SessionRecord["acpx"];

  // This shape shipped from 2026-06-13 and could never be written. It is pinned
  // so the rename cannot be quietly reverted by a future edit to the emitter.
  assert.throws(() => {
    serializeSessionRecordForDisk(record);
  }, /provisioning_warning\.profileId/);
});
