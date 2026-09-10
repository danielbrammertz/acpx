import assert from "node:assert/strict";
import test from "node:test";
import type { RoutingPolicyWarningBreadcrumb } from "../src/acp/openrouter-provider-policy.js";
import { applyLifecycleSnapshotToRecord } from "../src/runtime/engine/lifecycle.js";
import { persistSessionOptions } from "../src/runtime/engine/session-options.js";
import { cloneSessionAcpxState } from "../src/session/conversation-model.js";
import { parseSessionRecord, serializeSessionRecordForDisk } from "../src/session/persistence.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

// TE finding F-1, the RECORD half — brick 4c272cab.
//
// 🛑 THE DEFECT: acpx drops a settings file its validator rejects, WHOLE and
// SILENTLY. Measured by the test engineer end-to-end — the settings gear read
// `Minimum precision 8-bit · Never: Wafer` while the box applied nothing at all,
// with no error on either side, because the file was hand-written and never
// PATCHed (so the UI's save-time validation could not see it). Dropping it whole
// stays right; being quiet about it does not.
//
// ⚠️ EVERY LEG IS TESTED, NOT THE OBVIOUS ONE. A persisted field in this repo
// dies in a transform it was never added to: `provisioning_warning` — this
// field's own model — was DEAD ON ARRIVAL for months, and three other fields
// have been eaten by `cloneSessionAcpxState` alone. The legs were generated from
// the code (`grep -rn provisioning_warning src/`), not from a checklist:
//
//   1. types.ts               — the declaration
//   2. lifecycle.ts           — snapshot → record
//   3. parse.ts               — record → memory   (missing ⇒ silently stripped)
//   4. serialize.ts           — memory → disk     (key-policy: snake_case only)
//   5. conversation-model.ts  — the session_options clone the TURN path re-bases off
//   6. session-options.ts     — the breadcrumb carried across respawns

const WARNING: RoutingPolicyWarningBreadcrumb = {
  file: "/home/node/.acpx/ui-settings.json",
  reason: "perModel: must be an object keyed by model slug",
  at: "2026-09-10T10:30:00.000Z",
};

function bareRecord(): SessionRecord {
  return makeSessionRecord({
    acpxRecordId: "routing-warning-1",
    acpSessionId: "acp-routing-warning-1",
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    cwd: "/workspace/x",
  });
}

test("F-1 leg 2 · a spawn that saw a rejected file writes the breadcrumb", () => {
  const record = bareRecord();
  applyLifecycleSnapshotToRecord(record, { running: true, routingPolicyWarning: WARNING });
  assert.deepEqual(record.acpx?.session_options?.routing_policy_warning, WARNING);
});

test("F-1 leg 2 · a later CLEAN spawn does not erase it, and does not invent one", () => {
  // Truthy-gated like its two neighbours. A session can be respawned by a path
  // that never reads the settings file, and clearing on absence would blank
  // "this box's routing policy is invalid" at the moment it is still true.
  const record = bareRecord();
  applyLifecycleSnapshotToRecord(record, { running: true, routingPolicyWarning: WARNING });
  applyLifecycleSnapshotToRecord(record, { running: true });
  assert.deepEqual(record.acpx?.session_options?.routing_policy_warning, WARNING);

  // …and a box that never had a bad file gets nothing at all.
  const clean = bareRecord();
  applyLifecycleSnapshotToRecord(clean, { running: true });
  assert.equal(clean.acpx?.session_options?.routing_policy_warning, undefined);
});

test("F-1 leg 2 · the neighbouring breadcrumbs still land — no leg was displaced", () => {
  // The three writes were folded into one helper to stay under the complexity
  // ceiling; this row is the control that the fold kept all three.
  const record = bareRecord();
  applyLifecycleSnapshotToRecord(record, {
    running: true,
    routingPolicyWarning: WARNING,
    servedViaShim: true,
    provisioningWarning: { at: "2026-09-10T10:00:00.000Z", message: "degraded" },
  });
  const options = record.acpx?.session_options;
  assert.equal(options?.served_via_shim, true);
  assert.equal(options?.provisioning_warning?.message, "degraded");
  assert.deepEqual(options?.routing_policy_warning, WARNING);
});

test("F-1 legs 3+4 · it survives serialize → parse (the leg that killed its own model)", () => {
  const record = bareRecord();
  record.acpx = { session_options: { routing_policy_warning: WARNING } };
  // ⚠️ `serializeSessionRecordForDisk` runs `assertPersistedKeyPolicy` BEFORE
  // `fs.writeFile`, and `LiveSessionCheckpoint` swallows the throw — a camelCase
  // key here would freeze the WHOLE record silently. That is not hypothetical:
  // it is what `provisioning_warning` did with `profileId`/`authMode`.
  const onDisk = serializeSessionRecordForDisk(record);
  const parsed = parseSessionRecord(JSON.parse(JSON.stringify(onDisk)));
  assert.deepEqual(parsed?.acpx?.session_options?.routing_policy_warning, WARNING);
});

test("F-1 leg 3 · a malformed breadcrumb on disk is dropped, not half-parsed", () => {
  const record = bareRecord();
  const onDisk = serializeSessionRecordForDisk(record);
  onDisk.acpx = { session_options: { routing_policy_warning: { file: "/x", reason: "" } } };
  const parsed = parseSessionRecord(JSON.parse(JSON.stringify(onDisk)));
  assert.equal(parsed?.acpx?.session_options?.routing_policy_warning, undefined);
});

test("F-1 leg 6 · it survives a persistSessionOptions rewrite (the respawn leg)", () => {
  // `persistSessionOptions` REBUILDS `session_options` from the agent options,
  // carrying only the fields listed as breadcrumbs. A leg missing there is
  // rewritten away by the next spawn — the field would be correct until the
  // moment anything touched the session again.
  const record = bareRecord();
  record.acpx = { session_options: { routing_policy_warning: WARNING } };
  persistSessionOptions(record, { model: "z-ai/glm-5.3-flash" });
  assert.deepEqual(record.acpx?.session_options?.routing_policy_warning, WARNING);
  assert.equal(
    record.acpx?.session_options?.model,
    "z-ai/glm-5.3-flash",
    "…without eating the rewrite",
  );
});

test("F-1 leg 5 · it rides the session_options clone the turn path re-bases off", () => {
  // Missing here, the breadcrumb is present at spawn and GONE after one prompt,
  // with the whole suite green — the failure class this allowlist is famous for.
  const cloned = cloneSessionAcpxState({
    session_options: { routing_policy_warning: WARNING },
  });
  assert.deepEqual(cloned?.session_options?.routing_policy_warning, WARNING);
});
