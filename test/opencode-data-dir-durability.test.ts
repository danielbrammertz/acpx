import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyHarnessConfigDir } from "../src/acp/harness-config-dir.js";
import {
  HARNESS_DATA_DIR_ROOT_ENV,
  resolveHarnessDataDirRoot,
} from "../src/acp/harness-config-dir-root.js";
import { AGENT_REGISTRY } from "../src/agent-registry.js";

// brick 6c94af4a — Daniel's OpenCode session `ses_f84bb7041ffeOayX6OGKPn4Elu`
// answered `-32603 "Internal error: OpenCode service failure"` on every
// `session/resume`, forever, because OpenCode's store had 0 session rows: the
// conversation had been kept under `$HOME/.local/share/opencode`, on storage the
// platform does not guarantee, and the path was gone.
//
// ## 🛑 WHY THIS FILE EXISTS SEPARATELY FROM THE `envNames` ROW
//
// `harness-config-dir.test.ts` pins that `XDG_DATA_HOME` is APPLIED. That row
// would NOT have caught this defect and would not catch its return, because the
// defect is not "the variable is missing" — it is "the state does not survive".
// A variable pointing at a doomed directory satisfies every presence assertion.
//
// **So this file asserts the property directly: write where the harness would
// write, destroy the fallback path the way a restart does, and require the bytes
// to still be there.** It fails on the pre-fix code for the right reason — the
// marker is inside the path being destroyed — and passes on the fix.
//
// ## ⚠️ THE VENDOR RULE THIS ENCODES IS MEASURED, NOT ASSUMED
//
// `openCodeStoreDir` below is OpenCode's own data-dir resolution. It was measured
// against opencode-ai@1.18.28 on a rig with an isolated HOME, three arms:
//
//   A  store intact,                    no XDG_DATA_HOME -> resume OK
//   B  store deleted,                   no XDG_DATA_HOME -> resume -32603, rows 1 -> 0
//   C  XDG_DATA_HOME -> durable storage  -> `$HOME/.local/share/opencode` was
//      "ABSENT (never created)", and resume still OK after that path was destroyed
//
// Arm A is what makes B causal rather than correlated, and arm C is what proves
// the variable is the one OpenCode actually honours. If a future OpenCode changes
// this rule, THIS constant is what goes stale — and it is deliberately one
// expression, in one place, so that staleness is repairable rather than diffuse.
//
// ⚠️ It is a MODEL of the harness, so it cannot fail the way the harness would.
// That is the honest boundary of a unit test here: it pins acpx's side of the
// contract (where we point the harness) against a rule we measured. The end-to-end
// proof is the rig, and it lives in the brick, not in this file.

/** Where OpenCode keeps `opencode.db`, given a spawn environment. */
function openCodeStoreDir(env: NodeJS.ProcessEnv): string {
  const xdgData = env.XDG_DATA_HOME?.trim();
  const base =
    xdgData !== undefined && xdgData.length > 0
      ? xdgData
      : join(env.HOME ?? "/nonexistent-home", ".local", "share");
  return join(base, "opencode");
}

type Rig = {
  /** Stands in for the container's writable layer: `$HOME` and the config root. */
  overlay: string;
  /** Stands in for the PVC. */
  durable: string;
  home: string;
  configRoot: string;
};

function withRig<T>(run: (rig: Rig) => T): T {
  const base = mkdtempSync(join(tmpdir(), "oc-datadir-"));
  const overlay = join(base, "overlay");
  const durable = join(base, "durable");
  const home = join(overlay, "home");
  const configRoot = join(overlay, "tmp");
  mkdirSync(home, { recursive: true });
  mkdirSync(configRoot, { recursive: true });
  mkdirSync(durable, { recursive: true });

  // 🛑 HERMETIC, AND THE ISOLATION IS THE POINT. `resolveHarnessDataDirRoot`
  // reads `process.env`, so without this the row would create a directory in the
  // REAL `~/.acpx` on whatever box ran it — the exact class of leak that put a
  // foreign `models-store.json` in `/home/node/.pi` and reddened every acpx gate
  // on this box for an hour.
  const priorRoot = process.env[HARNESS_DATA_DIR_ROOT_ENV];
  process.env[HARNESS_DATA_DIR_ROOT_ENV] = durable;
  try {
    return run({ overlay, durable, home, configRoot });
  } finally {
    if (priorRoot === undefined) {
      delete process.env[HARNESS_DATA_DIR_ROOT_ENV];
    } else {
      process.env[HARNESS_DATA_DIR_ROOT_ENV] = priorRoot;
    }
    rmSync(base, { recursive: true, force: true });
  }
}

/** What a container restart does to the overlay: the fallback path stops existing. */
function simulateRestart(rig: Rig): void {
  rmSync(join(rig.home, ".local"), { recursive: true, force: true });
  rmSync(rig.configRoot, { recursive: true, force: true });
}

test("an OpenCode session's store survives losing the overlay-backed path", () => {
  withRig((rig) => {
    const env: NodeJS.ProcessEnv = { HOME: rig.home };
    const plan = applyHarnessConfigDir({
      env,
      agentCommand: AGENT_REGISTRY.opencode,
      sessionId: "ses_durability",
      rootDir: rig.configRoot,
    });
    assert.ok(plan, "no config-dir plan — this arm is NOT RUN, not passing");

    // Where OpenCode would put the conversation, given the env acpx just built.
    const storeDir = openCodeStoreDir(env);
    mkdirSync(storeDir, { recursive: true });
    const store = join(storeDir, "opencode.db");
    writeFileSync(store, "SESSION-ROWS-STAND-IN");

    // 🛑 THE POSITIVE CONTROL, AND IT IS NOT OPTIONAL. Without it, "the store
    // survived" also passes when `simulateRestart` destroyed nothing at all —
    // a red that cannot fire manufactures a pass. This marker sits in the path
    // the restart is supposed to take, so the run must show it GONE.
    const doomedDir = join(rig.home, ".local", "share", "opencode");
    mkdirSync(doomedDir, { recursive: true });
    const doomed = join(doomedDir, "control-marker");
    writeFileSync(doomed, "MUST NOT SURVIVE");

    assert.ok(existsSync(store), "the store was not written — nothing is under test");
    assert.ok(existsSync(doomed), "the control marker was not written");

    simulateRestart(rig);

    assert.equal(
      existsSync(doomed),
      false,
      "the simulated restart destroyed NOTHING — the instrument cannot fail, so a pass here means nothing",
    );
    assert.ok(
      existsSync(store),
      "the OpenCode store did not survive a restart — `session/resume` will answer -32603 forever, which is brick 6c94af4a",
    );
  });
});

test("the data dir is on durable storage — NOT the config root, which is the same filesystem as the fallback", () => {
  // ⚠️ THE NEAR-MISS FIX. Pointing `XDG_DATA_HOME` at the per-session CONFIG dir
  // looks like isolation and fixes nothing: the config root is `tmpdir()`, and on
  // the dev boxes `/tmp` and `$HOME/.local/share` are the SAME filesystem
  // (`st_dev` 1048684 measured, against 2080 for the PVC). This row is what stops
  // a later "simplification" from collapsing the two roots.
  withRig((rig) => {
    const env: NodeJS.ProcessEnv = { HOME: rig.home };
    const plan = applyHarnessConfigDir({
      env,
      agentCommand: AGENT_REGISTRY.opencode,
      sessionId: "ses_roots",
      rootDir: rig.configRoot,
    });
    assert.ok(plan);
    const dataHome = env.XDG_DATA_HOME;
    assert.ok(dataHome, "XDG_DATA_HOME unset");

    assert.equal(
      dataHome.startsWith(rig.configRoot),
      false,
      `data dir ${dataHome} is under the CONFIG root — same filesystem as the fallback, so this fixes nothing`,
    );
    assert.equal(
      dataHome.startsWith(rig.home),
      false,
      `data dir ${dataHome} is under HOME — that is the path the defect was about`,
    );
    assert.equal(dataHome.startsWith(rig.durable), true, `data dir ${dataHome} is not durable`);
    assert.notEqual(dataHome, plan.dir, "the data dir and the config dir must not be the same path");
  });
});

test("the durable root is hermetic — it follows its env, not the box", () => {
  // ⚠️ HERMETICITY IS PROVEN, NOT DECLARED. A fixture variable that is set but
  // never READ by the code under test is inert, and the row above would then be
  // passing on the real `~/.acpx` while its header claimed isolation. This varies
  // the environment and requires the answer to move with it.
  const a = resolveHarnessDataDirRoot(undefined, { [HARNESS_DATA_DIR_ROOT_ENV]: "/rig-a" });
  const b = resolveHarnessDataDirRoot(undefined, { [HARNESS_DATA_DIR_ROOT_ENV]: "/rig-b" });
  assert.equal(a, "/rig-a");
  assert.equal(b, "/rig-b");
  assert.notEqual(a, b, "the resolver ignored its env — every isolation claim in this file is void");

  // Blank is ABSENT, not the empty string: an empty value in an env file would
  // otherwise `join()` into a RELATIVE path under the process cwd.
  const blank = resolveHarnessDataDirRoot("   ", {
    [HARNESS_DATA_DIR_ROOT_ENV]: "  ",
    ACPX_STATE_HOME: "  ",
  });
  assert.equal(blank.startsWith("/"), true, `blank inputs produced a relative root: ${blank}`);

  // `ACPX_STATE_HOME` is the existing seam that moves the whole `.acpx` tree.
  assert.equal(
    resolveHarnessDataDirRoot(undefined, { ACPX_STATE_HOME: "/pvc/state" }),
    join("/pvc/state", ".acpx", "harness-data"),
  );
});
