import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { BrickOutbox, writeRecordAtomic, type DiskRecord } from "../../src/brick-outbox.js";
import { parseSessionRecord } from "../../src/session/persistence/parse.js";

assert.ok(os.homedir().startsWith("/workspace/bricksdb-b14-selftest/"));
const outbox = new BrickOutbox();
fs.writeFileSync(
  `${os.homedir()}/.acpx/instance.json`,
  JSON.stringify({ instance_id: "i-111111111111", home: os.homedir() }),
);
process.env.ACPX_UI_BASE_URL = "https://example.invalid";
const id = "11111111-1111-4111-8111-111111111111";
const brick = "22222222-2222-4222-8222-222222222222";
const record: DiskRecord = {
  schema: "acpx.session.v1",
  kind: "session",
  acpx_record_id: id,
  acp_session_id: "adapter-independent-id",
  agent_command: "node /opt/codex-acp/dist/index.js",
  agent_name: "codex",
  cwd: os.homedir(),
  created_at: new Date().toISOString(),
  last_used_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  last_seq: 0,
  messages: [],
  metadata: { brick },
  closed: false,
};
const identity = {
  instance_id: "i-111111111111",
  box: "fixture",
  session_url: `https://example.invalid/?session=${id}`,
  agent_type: "codex",
};
let acted = 0;
const scenario = process.argv[2];
try {
  assert.ok(parseSessionRecord(record), "positive real parser control");
  assert.equal(
    parseSessionRecord({ ...record, schema: "invalid" }),
    null,
    "negative parser control",
  );
  acted++;
  if (["projection", "drain", "rename-cut", "superseded"].includes(scenario ?? "")) {
    const first = outbox.prepareProjection(id, record, identity)!;
    assert.equal(first.state, "prepared");
    assert.equal(fs.existsSync(outbox.recordPath(id)), false);
    if (scenario === "drain") {
      outbox.setDrain("cut-1");
      assert.throws(() => outbox.applyProjection(first.id), /maintenance/);
      assert.equal(outbox.getIntent(first.id)?.state, "abandoned");
      assert.equal(outbox.inventory().outbox_depth, 0);
      assert.equal(outbox.inventory().admission_frontier[0]?.revision, 1);
      assert.throws(() => outbox.prepareProjection(id, record, identity), /maintenance/);
      outbox.setDrain(null);
      const next = outbox.prepareProjection(id, record, identity)!;
      assert.equal(next.revision, 2);
      outbox.applyProjection(next.id);
    } else if (scenario === "rename-cut") {
      writeRecordAtomic(outbox.recordPath(id), {
        ...record,
        metadata: { brick, brick_projection_revision: "0:1" },
      });
      outbox.setDrain("cut-after-rename");
      outbox.applyProjection(first.id);
      assert.equal(outbox.getIntent(first.id)?.state, "applied");
      assert.equal(outbox.inventory().outbox_depth, 1);
    } else if (scenario === "superseded") {
      const second = outbox.prepareProjection(id, record, identity)!;
      outbox.applyProjection(second.id);
      outbox.applyProjection(first.id);
      assert.equal(outbox.getIntent(first.id)?.state, "superseded");
      assert.equal(outbox.readRecord(id)?.metadata?.brick_projection_revision, "0:2");
    } else {
      outbox.applyProjection(first.id);
      assert.ok(parseSessionRecord(outbox.readRecord(id)));
      outbox.acknowledge(first.id);
      outbox.acknowledge(first.id);
      assert.equal(outbox.inventory().outbox_depth, 0);
      assert.equal(outbox.inventory().projection_heads, 1);
      assert.equal(outbox.inventory().high_water[0]?.revision, 1);
    }
    acted++;
  } else {
    const reservation = outbox.reserveSpawn({
      run_id: "run-1",
      fence: 1,
      trigger_id: "trigger-1",
      parent_brick_id: brick,
      child_brick_id: brick,
      target_record_id: id,
    });
    outbox.recordSpawnChild("run-1", 1, process.pid);
    assert.equal(outbox.spawnChildLiveness("run-1", 1), "alive");
    const pending: DiskRecord = {
      ...record,
      metadata: { brick, spawn_key: reservation.idempotency_key, spawn_state: "pending" },
    };
    outbox.writeOwnedRecord(id, pending, () => pending);
    assert.equal(outbox.prepareProjection(id, pending, identity), undefined);
    if (scenario === "ownership") {
      outbox.transitionSpawn("run-1", 1, "revoked");
      assert.throws(() => outbox.writeOwnedRecord(id, pending, () => pending), /refused/);
      assert.throws(() => outbox.transitionSpawn("run-1", 1, "published"), {
        code: "invalid-spawn-transition",
      });
      assert.throws(() => outbox.transitionSpawn("run-1", 1, "cancelled"), /forbidden/);
      outbox.transitionSpawn("run-1", 1, "cancelled", { child_gone: true });
      assert.throws(() => outbox.transitionSpawn("run-1", 1, "published"), {
        code: "invalid-spawn-transition",
      });
    } else {
      outbox.transitionSpawn("run-1", 1, "published");
      outbox.transitionSpawn("run-1", 1, "adopted");
      assert.equal(outbox.getSpawnRun("run-1")?.ack_confirmed_at, null);
      assert.equal(outbox.inventory().runs.adopted_without_ack_confirmation, 1);
      assert.throws(
        () => outbox.transitionSpawn("run-1", 1, "revoked", { higher_fence: 2 }),
        /forbidden/,
      );
      if (scenario === "receipt-conflict") {
        outbox.confirmSpawnReceipt("run-1", { status: "spawned", session_id: brick });
        assert.equal(outbox.getSpawnAttempt("run-1", 1)?.state, "adopted");
        assert.equal(outbox.readRecord(id)?.metadata?.spawn_state, "orphaned");
        assert.ok(outbox.getSpawnRun("run-1")?.receipt_conflict);
      } else if (scenario === "initial-prompt") {
        outbox.queueInitialPrompt("run-1", { text: "real queued content", sessionId: id });
        const prompts = outbox.pendingInitialPrompts();
        assert.equal(prompts.length, 1);
        let submitted = 0;
        await outbox.releaseInitialPrompt("run-1", async (_payload, deliveryId) => {
          assert.equal(deliveryId, prompts[0]?.delivery_id);
          submitted++;
        });
        await outbox.releaseInitialPrompt("run-1", async () => {
          submitted++;
        });
        assert.equal(submitted, 1);
        assert.equal(outbox.pendingInitialPrompts().length, 0);
      } else {
        outbox.confirmSpawnReceipt("run-1", { status: "spawned", session_id: id });
        assert.equal(outbox.inventory().runs.adopted_without_ack_confirmation, 0);
      }
    }
    acted++;
  }
} finally {
  outbox.close();
}
if (acted === 0) {
  console.error("EXAMINED NOTHING");
  process.exit(2);
}
console.log(`ACTED=${acted} scenario=${scenario}`);
