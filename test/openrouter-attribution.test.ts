import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { attachAttribution, OpenRouterAttributionLog } from "../src/acp/openrouter-attribution.js";
import {
  createSessionConversation,
  recordSessionUpdate,
} from "../src/session/conversation-model.js";
import { rememberSessionCost } from "../src/session/cost-ingest.js";
import type { SessionAcpxState } from "../src/types.js";

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
