import assert from "node:assert/strict";
import test from "node:test";
import type { UnitRates } from "../src/models/cost-provenance.js";
import { rememberSessionCost } from "../src/session/cost-ingest.js";
import { cloneSessionAcpxState } from "../src/session/conversation-model.js";
import type { SessionAcpxState } from "../src/types.js";

// brick://5026423b — the ingest caller `cost-provenance.ts` shipped without.
//
// The module was merged as a pure function with ZERO callers and `measuredFree`
// declared, consumed, and never assigned. These rows drive the caller that now
// exists; the derivation itself is pinned in `pi-models-store.test.ts` and is NOT
// re-tested here.

const PRICED: UnitRates = {
  inPerM: 0.95,
  outPerM: 4,
  cacheReadPerM: 0.16,
  cacheWritePerM: 0,
  measuredFree: false,
};
const FREE: UnitRates = {
  inPerM: 0,
  outPerM: 0,
  cacheReadPerM: 0,
  cacheWritePerM: 0,
  measuredFree: true,
};

function state(modelId = "openrouter/moonshotai/kimi-k2.6"): SessionAcpxState {
  return { current_model_id: modelId } as SessionAcpxState;
}

test("5026423b THE RULE: a ZERO adapter figure beside NON-ZERO tokens is never `reported`", () => {
  // ⚠️ THE ROW THE WHOLE BRICK EXISTS FOR, and the exact shape measured on pi
  // 2026-09-08: `cost.amount 0` alongside 7,838 in / 68 out. A harness handed a
  // catalogue entry with zeroed rates computes 0 and reports it TRUTHFULLY. If
  // ingest trusted that as `reported`, a confident $0.00 would ship on a session
  // that was never priced — Daniel's original bug, returning through the one
  // provenance whose contract is "trust the adapter".
  const acpx = state();
  rememberSessionCost(
    acpx,
    { input: 7838, output: 68, cacheRead: 0, cacheWrite: 0, reportedAmount: 0 },
    () => PRICED,
  );
  assert.notEqual(acpx.cost?.provenance, "reported", "a zero adapter figure was trusted");
  assert.equal(acpx.cost?.provenance, "computed");
  assert.ok((acpx.cost?.amount ?? 0) > 0, "real tokens at real rates must not price to zero");
});

test("5026423b: an unpriceable model is `unpriced` with a NULL amount — never $0.00", () => {
  // The other half of the same rule: no catalogue row ⇒ no price. `amount: null`
  // is what stops a consumer rendering it as free.
  const acpx = state();
  rememberSessionCost(
    acpx,
    { input: 7838, output: 68, cacheRead: 0, cacheWrite: 0, reportedAmount: 0 },
    () => null,
  );
  assert.equal(acpx.cost?.provenance, "unpriced");
  assert.equal(acpx.cost?.amount, null, "an unpriced figure must carry null, never 0");
  assert.deepEqual(acpx.cost?.coverage, { unit: "message", priced: 0, total: 1 });
});

test("5026423b: `measuredFree` is ASSIGNED — a row quoting zero yields `free`, absence never does", () => {
  // The field the brick reports as never written anywhere in src. Two-sided: the
  // discrimination is one-directional and only a POSITIVE zero row may reach
  // `free`.
  const free = state();
  rememberSessionCost(free, { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, () => FREE);
  assert.equal(free.cost?.provenance, "free");
  assert.equal(free.cost?.amount, 0, "a measured-free figure is a real zero");

  const absent = state();
  rememberSessionCost(absent, { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, () => null);
  assert.equal(absent.cost?.provenance, "unpriced", "absence of a row must never read as free");
});

test("5026423b: `reported` is admitted for a NON-ZERO adapter figure with no units", () => {
  // The positive arm — a harness that gives a total and no token breakdown
  // (claude / claude-pty). Without this the rule above would read as "never
  // trust the adapter", which is not what it says.
  const acpx = state();
  rememberSessionCost(acpx, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reportedAmount: 6.44 });
  assert.equal(acpx.cost?.provenance, "reported");
  assert.equal(acpx.cost?.amount, 6.44);
  assert.equal(acpx.cost?.coverage, null, "no units ⇒ not decomposable by construction");
});

test("5026423b: units accumulate PER MESSAGE and coverage counts them", () => {
  // One unit per assistant message_end, not per turn — a turn holds several.
  const acpx = state();
  for (const input of [100, 200, 300]) {
    rememberSessionCost(acpx, { input, output: 10, cacheRead: 0, cacheWrite: 0 }, () => PRICED);
  }
  assert.equal(acpx.cost_units?.length, 3);
  assert.deepEqual(acpx.cost?.coverage, { unit: "message", priced: 3, total: 3 });
});

test("5026423b: a mid-session model switch prices each unit at ITS OWN rates", () => {
  // Why the unit is `message` and not `model`: a cumulative counter summed across
  // a switch attributes one model's tokens to the other.
  const acpx = state();
  rememberSessionCost(acpx, { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, () => PRICED);
  const afterFirst = acpx.cost?.amount ?? 0;
  rememberSessionCost(acpx, { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, () => FREE);
  assert.equal(afterFirst, 0.95, "first unit priced at the priced model's rate");
  assert.equal(acpx.cost?.amount, 0.95, "the free unit added nothing — it was not re-priced at 0.95");
  assert.equal(acpx.cost?.provenance, "computed", "a partial free must NOT collapse to `free`");
});

test("5026423b ⚠️ THE ALLOWLIST LEG: cost and cost_units survive cloneSessionAcpxState", () => {
  // 🛑 THE ROW THAT CATCHES THE FAILURE THIS CODEBASE HAS ALREADY HAD THREE TIMES.
  // `cloneSessionAcpxState` is a field-by-field allowlist the turn path re-bases
  // `record.acpx` off. A field missing from it is present at `sessions new` and
  // NULL AFTER ONE PROMPT, with typecheck, lint and the entire unit suite green —
  // `applied_output_style` (874fee67), `served` (07dd62c9) and `depth_projection`
  // were all lost exactly that way. Asserted as a PROPERTY of the clone, not as a
  // source-text check.
  const acpx = state();
  rememberSessionCost(acpx, { input: 500, output: 20, cacheRead: 0, cacheWrite: 0 }, () => PRICED);
  assert.ok(acpx.cost, "control: the fixture must have a cost before the clone");

  const cloned = cloneSessionAcpxState(acpx);
  assert.deepEqual(cloned?.cost, acpx.cost, "the cost figure did not survive the per-turn clone");
  assert.deepEqual(cloned?.cost_units, acpx.cost_units, "the units did not survive the per-turn clone");

  // And it is a COPY, not a shared reference — a later mutation of the clone must
  // not reach back into the record the turn path is still holding.
  cloned!.cost!.amount = 999;
  assert.notEqual(acpx.cost?.amount, 999, "the clone aliased the original instead of copying it");
});
