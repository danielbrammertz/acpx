import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  expandQuantizationFloor,
  loadBoxRoutingPolicy,
  loadBoxRoutingPolicyRead,
  reportRoutingPolicyWarning,
  resetRoutingPolicyWarningMemo,
  type OpenRouterRoutingPolicy,
  resolveProviderObject,
  uiSettingsPath,
  validateRoutingPolicy,
} from "../src/acp/openrouter-provider-policy.js";

// Brick 4c272cab — the box-wide OpenRouter provider policy.
//
// Every assertion here is anchored to a LIVE PROBE recorded in
// `conception/MEASUREMENTS.md`; the probe id is named on the row that depends on
// it, so a future reader can re-run the one measurement rather than re-deriving
// the whole contract. The three that are load-bearing:
//
//   T3/A8  an ABSENT policy emits NOTHING — not `{}` (pi's guard is truthiness),
//          so an unconfigured box is byte-identical to before this brick.
//   T3     `allowUnknownQuantization` defaults TRUE. Flipping it 404s every
//          first-party model on the box, on every turn (MEASUREMENTS §2).
//   T7     an unknown key or an illegal quantization token is refused HERE,
//          because on the wire it is a 400 on every turn (probes P and R).

const HOME_PREFIX = "acpx-or-policy-test-";

function makeHome(settings?: unknown): { home: string; env: NodeJS.ProcessEnv; file: string } {
  const home = mkdtempSync(path.join(os.tmpdir(), HOME_PREFIX));
  mkdirSync(path.join(home, ".acpx"), { recursive: true });
  const file = path.join(home, ".acpx", "ui-settings.json");
  if (settings !== undefined) {
    writeFileSync(file, JSON.stringify(settings), "utf8");
  }
  return { home, env: { HOME: home }, file };
}

// ── T3 · the precision ladder ────────────────────────────────────────────────

test("T3 · each floor expands to its own rung and every rung above it", () => {
  assert.deepEqual(expandQuantizationFloor("fp32", false), ["fp32"]);
  assert.deepEqual(expandQuantizationFloor("bf16", false), ["fp16", "bf16", "fp32"]);
  assert.deepEqual(expandQuantizationFloor("fp8", false), [
    "int8",
    "fp8",
    "mxfp8",
    "fp16",
    "bf16",
    "fp32",
  ]);
  assert.deepEqual(expandQuantizationFloor("fp6", false), [
    "fp6",
    "int8",
    "fp8",
    "mxfp8",
    "fp16",
    "bf16",
    "fp32",
  ]);
  // 4-bit collects the whole 4-bit family — tiers are by BIT-WIDTH.
  assert.deepEqual(expandQuantizationFloor("fp4", false), [
    "int4",
    "fp4",
    "mxfp4",
    "nvfp4",
    "fp6",
    "int8",
    "fp8",
    "mxfp8",
    "fp16",
    "bf16",
    "fp32",
  ]);
});

test("T3 · every emitted token is in OpenRouter's own enum", () => {
  // Transcribed from the 400 probe R returns for an illegal token. A token
  // outside this list is a 400 on EVERY turn, so the expansion may not invent one.
  const legal = new Set([
    "int4",
    "int8",
    "fp4",
    "mxfp4",
    "nvfp4",
    "fp6",
    "fp8",
    "mxfp8",
    "fp16",
    "bf16",
    "fp32",
    "unknown",
  ]);
  for (const floor of ["fp4", "fp6", "fp8", "bf16", "fp32"]) {
    for (const token of expandQuantizationFloor(floor, true)) {
      assert.ok(legal.has(token), `"${token}" is not an OpenRouter quantization`);
    }
  }
});

test("T3 · the unknown rung is included BY DEFAULT — the fleet-outage guard", () => {
  // MEASUREMENTS §2: every endpoint of claude-sonnet-4.5, gpt-5 and
  // gemini-2.5-flash reports `quantization: "unknown"`. A floor that excludes it
  // returns `404 No endpoints found for the request with quantization: …` on
  // every turn of those models — the whole box, immediately.
  //
  // 🛑 IF YOU ARE HERE TO FLIP THE DEFAULT BACK TO false: that is the outage,
  // not a tidy-up. The "never Wafer" case is `ignore: ["wafer"]`, which cannot
  // empty an unrelated model's eligible set.
  const withDefault = resolveProviderObject({ minQuantization: "fp8" }, "z-ai/glm-5.3-flash");
  assert.ok(withDefault?.quantizations?.includes("unknown"));

  const optedOut = resolveProviderObject(
    { minQuantization: "fp8", allowUnknownQuantization: false },
    "z-ai/glm-5.3-flash",
  );
  assert.equal(optedOut?.quantizations?.includes("unknown"), false);
});

// ── T5 / A8 · absence, and the `{}` trap ─────────────────────────────────────

test("T5 · no policy resolves to undefined, never {}", () => {
  // pi's guard is `model.compat?.openRouterRouting && (params.provider = …)` and
  // `{}` is TRUTHY, so an empty object would put `"provider": {}` on every
  // request — a shape nobody intended and nobody measured.
  assert.equal(resolveProviderObject(undefined, "z-ai/glm-5.3-flash"), undefined);
  assert.equal(resolveProviderObject({}, "z-ai/glm-5.3-flash"), undefined);
  assert.equal(resolveProviderObject({ perModel: {} }, "z-ai/glm-5.3-flash"), undefined);
  assert.equal(resolveProviderObject({ ignore: [] }, "z-ai/glm-5.3-flash"), undefined);
  assert.equal(
    resolveProviderObject(
      { perModel: { "z-ai/glm-5.3-flash": { order: [] } } },
      "z-ai/glm-5.3-flash",
    ),
    undefined,
  );
  // A policy that is neutral for THIS model but not for others still emits
  // nothing here — the emptiness test is on the resolved object, not the file.
  assert.equal(
    resolveProviderObject(
      { perModel: { "other/model": { order: ["modal"] } } },
      "z-ai/glm-5.3-flash",
    ),
    undefined,
  );
});

test("T5 · allowUnknownQuantization alone is not a policy", () => {
  // Without a floor it filters nothing; emitting an object for it would create a
  // second representation of "auto".
  assert.equal(resolveProviderObject({ allowUnknownQuantization: false }, "any/model"), undefined);
});

// ── T5 · the per-key merge ───────────────────────────────────────────────────

test("T5 · perModel merges OVER the box-wide block, key by key", () => {
  const policy: OpenRouterRoutingPolicy = {
    minQuantization: "fp8",
    ignore: ["wafer"],
    minThroughput: { p50: 60 },
    perModel: { "z-ai/glm-5.3-flash": { order: ["baseten", "modal", "crusoe"] } },
  };
  const resolved = resolveProviderObject(policy, "z-ai/glm-5.3-flash");
  assert.deepEqual(resolved, {
    order: ["baseten", "modal", "crusoe"],
    ignore: ["wafer"],
    quantizations: ["int8", "fp8", "mxfp8", "fp16", "bf16", "fp32", "unknown"],
    preferred_min_throughput: { p50: 60 },
    allow_fallbacks: true,
  });

  // The SAME box block, a model with no override: the order drops out and the
  // box-wide bounds stay. Probe D is why they must: an exhausted `order` falls
  // through to the ACCOUNT DEFAULT POOL, and only `quantizations`/`ignore` bound it.
  const other = resolveProviderObject(policy, "anthropic/claude-sonnet-4.5");
  assert.equal(other?.order, undefined);
  assert.deepEqual(other?.ignore, ["wafer"]);
});

test("T5 · a picked slug carrying the openrouter/ selector prefix finds its entry", () => {
  const policy: OpenRouterRoutingPolicy = {
    perModel: { "z-ai/glm-5.3-flash": { order: ["modal"] } },
  };
  assert.deepEqual(resolveProviderObject(policy, "openrouter/z-ai/glm-5.3-flash")?.order, [
    "modal",
  ]);
});

test("T5 · allow_fallbacks is true unless the model opted out", () => {
  const on = resolveProviderObject({ perModel: { "m/x": { order: ["modal"] } } }, "m/x");
  assert.equal(on?.allow_fallbacks, true);
  // The measured 429 hazard (probes E/F/I): an explicit, per-model opt-in only.
  const off = resolveProviderObject(
    { perModel: { "m/x": { order: ["modal"], allowFallbacks: false } } },
    "m/x",
  );
  assert.equal(off?.allow_fallbacks, false);
});

test("T5 · `only` is unrepresentable — the box-bricking shape cannot be emitted", () => {
  // Not "discouraged": the contract has no field for it, so no settings file can
  // produce it. Probes E and I both 429 with `only` + fallbacks off.
  const resolved = resolveProviderObject(
    { ignore: ["wafer"], perModel: { "m/x": { order: ["baseten"] } } },
    "m/x",
  );
  assert.ok(resolved);
  assert.equal("only" in resolved, false);
});

test("T5 · the session tier merges over perModel (designed for, not built)", () => {
  const resolved = resolveProviderObject({ perModel: { "m/x": { order: ["modal"] } } }, "m/x", {
    sessionRouting: { order: ["crusoe"] },
  });
  assert.deepEqual(resolved?.order, ["crusoe"]);
});

// ── T7 · validation ──────────────────────────────────────────────────────────

test("T7 · the validator refuses what OpenRouter would 400 on", () => {
  const rows: { name: string; candidate: unknown; field: string }[] = [
    { name: "unknown key", candidate: { sort: "throughput" }, field: "sort" },
    {
      name: "illegal quantization",
      candidate: { minQuantization: "int2ish" },
      field: "minQuantization",
    },
    { name: "display name, not slug", candidate: { ignore: ["BaseTen"] }, field: "ignore[0]" },
    {
      name: "qualified tag, not bare slug",
      candidate: { ignore: ["baseten/fp8"] },
      field: "ignore[0]",
    },
    {
      name: "malformed percentile",
      candidate: { minThroughput: { p42: 10 } },
      field: "minThroughput.p42",
    },
    {
      name: "non-numeric percentile",
      candidate: { minThroughput: { p50: "fast" } },
      field: "minThroughput.p50",
    },
    {
      name: "non-boolean flag",
      candidate: { allowUnknownQuantization: "yes" },
      field: "allowUnknownQuantization",
    },
    {
      name: "unknown per-model key",
      candidate: { perModel: { "m/x": { only: ["baseten"] } } },
      field: "perModel.m/x.only",
    },
    {
      name: "non-slug in a per-model order",
      candidate: { perModel: { "m/x": { order: ["Modal"] } } },
      field: "perModel.m/x.order[0]",
    },
  ];
  for (const row of rows) {
    const errors = validateRoutingPolicy(row.candidate);
    assert.ok(errors.length > 0, `${row.name}: expected a rejection`);
    assert.ok(
      errors.some((error) => error.field === row.field),
      `${row.name}: expected an error on "${row.field}", got ${JSON.stringify(errors)}`,
    );
  }
});

test("T7 · the validator accepts the contract's own example", () => {
  assert.deepEqual(
    validateRoutingPolicy({
      minQuantization: "fp8",
      allowUnknownQuantization: true,
      minThroughput: { p50: 60 },
      ignore: ["wafer"],
      perModel: {
        "z-ai/glm-5.3-flash": { order: ["baseten", "modal", "crusoe"], allowFallbacks: true },
      },
    }),
    [],
  );
  assert.deepEqual(validateRoutingPolicy({}), []);
});

// ── T11 · path resolution, and reading the file ──────────────────────────────

test("T11 · the settings path honours ACPX_UI_SETTINGS_FILE, then ACPX_STATE_HOME", () => {
  // The failure this pins is SILENT: acpx-ui writes one path, acpx reads
  // another, and the policy simply does nothing. Worst on an isolated-HOME rig —
  // i.e. exactly where the tests run.
  assert.equal(
    uiSettingsPath({ ACPX_UI_SETTINGS_FILE: "/tmp/explicit.json", ACPX_STATE_HOME: "/tmp/state" }),
    "/tmp/explicit.json",
  );
  assert.equal(
    uiSettingsPath({ ACPX_STATE_HOME: "/tmp/state", HOME: "/home/someone" }),
    "/tmp/state/.acpx/ui-settings.json",
  );
  assert.equal(uiSettingsPath({ HOME: "/home/someone" }), "/home/someone/.acpx/ui-settings.json");
});

test("A11 · the policy is read from the env it is ASKED about, not the process's", () => {
  // brick ff298f02: a resolver that reads `process.env` passes only because of
  // what happens to be in the real $HOME. Planted positive control first.
  const fixture = makeHome({
    version: 1,
    openrouterRouting: { ignore: ["wafer"] },
  });
  assert.deepEqual(loadBoxRoutingPolicy(fixture.env)?.ignore, ["wafer"]);
  // ACPX_STATE_HOME beats HOME, and an empty HOME leg cannot fall back to the box.
  const stateHome = makeHome({ version: 1, openrouterRouting: { ignore: ["venice"] } });
  assert.deepEqual(
    loadBoxRoutingPolicy({ HOME: fixture.home, ACPX_STATE_HOME: stateHome.home })?.ignore,
    ["venice"],
  );
  assert.equal(
    loadBoxRoutingPolicy({ ACPX_UI_SETTINGS_FILE: stateHome.file })?.ignore?.[0],
    "venice",
  );
});

test("T1/T2 · absent, empty and unparseable all read as no policy — and never throw", () => {
  assert.equal(loadBoxRoutingPolicy(makeHome().env), undefined, "no file at all");
  assert.equal(loadBoxRoutingPolicy(makeHome({ version: 1 }).env), undefined, "no key");
  assert.equal(
    loadBoxRoutingPolicy(makeHome({ version: 1, openrouterRouting: null }).env),
    undefined,
    "null key",
  );
  assert.equal(
    loadBoxRoutingPolicy(makeHome({ version: 1, openrouterRouting: {} }).env),
    undefined,
    "{} is treated as absent — one representation of auto",
  );
  assert.equal(
    loadBoxRoutingPolicy(makeHome({ version: 1, openrouterRouting: { perModel: {} } }).env),
    undefined,
    "an empty perModel is absent",
  );

  const corrupt = makeHome();
  writeFileSync(corrupt.file, "{ this is not json", "utf8");
  assert.equal(loadBoxRoutingPolicy(corrupt.env), undefined, "a truncated file is not a crash");
});

// ── F-1 · the drop is LOUD ───────────────────────────────────────────────────

test("F-1 · a REJECTED file yields no policy AND a warning naming file + reason", () => {
  // 🛑 THE DEFECT THE TEST ENGINEER MEASURED. The two repos' validators agreed on
  // 37 of 40 candidates and disagreed on a family of 8: an empty value of the
  // WRONG TYPE (`perModel: []`, `ignore: ""`) is "neutral" to acpx-ui and a type
  // error here. End-to-end, the settings gear read
  // `Minimum precision 8-bit · Never: Wafer` while the box applied NOTHING AT
  // ALL, with no error on either side. Dropping the whole policy stays correct —
  // a partial policy is a shape nobody authored — but it may not be silent.
  //
  // The row uses the TE's own two files, verbatim.
  const rows: { name: string; settings: unknown; field: string }[] = [
    {
      name: "perModel: [] (TE case 1)",
      settings: { minQuantization: "fp8", ignore: ["wafer"], perModel: [] },
      field: "perModel",
    },
    {
      name: 'ignore: "" (TE case 2)',
      settings: {
        minQuantization: "fp8",
        ignore: "",
        perModel: { "z-ai/glm-5.3-flash": { order: ["baseten", "modal"] } },
      },
      field: "ignore",
    },
  ];
  for (const row of rows) {
    const fixture = makeHome({ version: 1, openrouterRouting: row.settings });
    const read = loadBoxRoutingPolicyRead(fixture.env);
    assert.equal(read.policy, undefined, `${row.name}: the policy must still be dropped WHOLE`);
    assert.ok(read.warning, `${row.name}: …but not silently`);
    assert.equal(read.warning.file, fixture.file, "the warning names the file acpx actually read");
    assert.match(
      read.warning.reason,
      new RegExp(row.field),
      `${row.name}: the reason must name the offending field, not just say "invalid"`,
    );
  }
});

test("F-1 · a CLEAN file yields a policy and NO warning — the control", () => {
  // Without this pair the row above would pass on a build that warns about
  // everything, which is the same silence in a louder costume.
  const fixture = makeHome({
    version: 1,
    openrouterRouting: { minQuantization: "fp8", ignore: ["wafer"] },
  });
  const read = loadBoxRoutingPolicyRead(fixture.env);
  assert.deepEqual(read.policy?.ignore, ["wafer"]);
  assert.equal(read.warning, undefined);
});

test("F-1 · the ordinary no-policy states are SILENT — absent, no key, and {}", () => {
  // A box with no settings file is the normal state of most boxes. Warning on it
  // would train every reader to ignore the line, which is how a loud warning
  // becomes a silent one again.
  assert.equal(loadBoxRoutingPolicyRead(makeHome().env).warning, undefined, "no file at all");
  assert.equal(loadBoxRoutingPolicyRead(makeHome({ version: 1 }).env).warning, undefined, "no key");
  assert.equal(
    loadBoxRoutingPolicyRead(makeHome({ version: 1, openrouterRouting: {} }).env).warning,
    undefined,
    "{} is auto, not an error",
  );
});

test("F-1 · a file that EXISTS but is unparseable warns; a missing one does not", () => {
  // The two mean opposite things to an operator, and `readFileSync` cannot tell
  // them apart — hence the explicit existence check behind the warning.
  const corrupt = makeHome();
  writeFileSync(corrupt.file, "{ this is not json", "utf8");
  const read = loadBoxRoutingPolicyRead(corrupt.env);
  assert.equal(read.policy, undefined);
  assert.match(read.warning?.reason ?? "", /not readable JSON/);
});

test("F-1 · the stderr line is said ONCE per process per distinct warning", () => {
  // A queue owner spawns many sessions; a broken settings file would otherwise
  // print on every one of them, and noise that gets filtered is silence again.
  resetRoutingPolicyWarningMemo();
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const warning = { file: "/tmp/x/ui-settings.json", reason: "perModel: must be an object" };
    reportRoutingPolicyWarning(warning);
    reportRoutingPolicyWarning({ ...warning });
    reportRoutingPolicyWarning(undefined);
    // A DIFFERENT breakage still speaks up — the dedupe is per warning, not a
    // global "already said something".
    reportRoutingPolicyWarning({ ...warning, reason: "ignore: must be an array" });
  } finally {
    process.stderr.write = original;
  }
  assert.equal(written.length, 2, `expected 2 lines, got ${JSON.stringify(written)}`);
  assert.match(written[0], /NOT in force/);
  assert.match(written[0], /ui-settings\.json/);
  assert.match(written[0], /perModel/);
});

test("T7 · an INVALID policy on disk is dropped whole, not partially applied", () => {
  // A hand-edited file that would 400 every turn must not reach the wire. Half a
  // policy is a shape nobody authored and nobody measured.
  const fixture = makeHome({
    version: 1,
    openrouterRouting: { ignore: ["wafer"], minQuantization: "int2ish" },
  });
  assert.equal(loadBoxRoutingPolicy(fixture.env), undefined);
});
