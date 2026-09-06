import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The acpx-shipped `pre-commit` chaining hook (brick e1d6ee4c).
 *
 * ## What these rows are actually protecting
 *
 * acpx env-scopes `core.hooksPath` to `git-hooks/` so its `prepare-commit-msg`
 * runs. The redirect is wholesale, so before this hook existed a repo's OWN
 * `pre-commit` was silently skipped for every agent commit on the box while still
 * firing for every human commit. ⚠️ **Nothing reported that**: the hook was
 * configured, present, and passing. That indistinguishability — an inert hook and
 * an absent one produce identical silence — is the defect, so no row here asserts
 * on "no output". Every arm asserts on an ARTIFACT: a witness file the repo hook
 * writes, or the exact exit code it returned.
 *
 * ## The two properties, and the failure mode of each
 *
 *   1. **Silent, exit 0, when the repo has no hook** — the common case (measured
 *      2026-09-06: 37 of 39 repos on this box). Breaking it blocks every commit.
 *   2. **NEVER swallow the repo hook's exit code** — a chaining hook that always
 *      exits 0 recreates the exact defect it removes, *while looking fixed*. That
 *      is why the codes below are asserted EXACTLY (3, 42, 124) and not merely as
 *      "non-zero": `git commit` itself collapses any hook failure to 1, so
 *      fidelity is observable only by invoking the hook directly, as these do.
 */

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOKS_DIR = join(REPO_ROOT, "git-hooks");
const HOOK = join(HOOKS_DIR, "pre-commit");

/**
 * The suite may itself be running under an acpx agent, whose `GIT_CONFIG_*`
 * override would point every `git config` read in the child at acpx's hooks dir.
 * Strip it so each row measures the scratch repo it built, not the box.
 */
function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("GIT_CONFIG")) {
      env[key] = value;
    }
  }
  return { ...env, ...extra };
}

type RepoOptions = {
  /** Where the repo keeps its own hook — mirrors the two shapes on this box. */
  placement: "hooksPath" | "gitHooks" | "none";
  /** Body of the repo hook, after the shebang. */
  body?: string;
  /** Omit the mode bit — husky v9 does not set one, and the hook must still run. */
  executable?: boolean;
};

/** A scratch repo plus the path its hook writes a witness to when it runs. */
function makeRepo(options: RepoOptions): { dir: string; witness: string } {
  const dir = mkdtempSync(join(tmpdir(), "acpx-precommit-"));
  execFileSync("git", ["init", "-q"], { cwd: dir, env: cleanEnv() });
  const witness = join(dir, "WITNESS");

  let hookPath: string | undefined;
  if (options.placement === "hooksPath") {
    mkdirSync(join(dir, "myhooks"), { recursive: true });
    execFileSync("git", ["config", "core.hooksPath", "myhooks"], { cwd: dir, env: cleanEnv() });
    hookPath = join(dir, "myhooks", "pre-commit");
  } else if (options.placement === "gitHooks") {
    mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
    hookPath = join(dir, ".git", "hooks", "pre-commit");
  }

  if (hookPath) {
    writeFileSync(hookPath, `#!/bin/sh\necho RAN > "${witness}"\n${options.body ?? "exit 0"}\n`);
    chmodSync(hookPath, options.executable === false ? 0o644 : 0o755);
  }
  return { dir, witness };
}

/** Run the shipped hook exactly as git would: from the worktree root, no stdin. */
function runHook(dir: string, extraEnv: Record<string, string> = {}) {
  const result = spawnSync(HOOK, [], {
    cwd: dir,
    env: cleanEnv(extraEnv),
    encoding: "utf8",
    input: "",
  });
  return { status: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

test("a repo with NO pre-commit is silent and exits 0 — the common case", () => {
  const { dir } = makeRepo({ placement: "none" });
  const run = runHook(dir);
  assert.equal(run.status, 0, `expected a clean pass, got ${run.status}: ${run.out}`);
  assert.equal(run.out.trim(), "", `the hook must print nothing here, got: ${run.out}`);
});

test("a repo hook reached through core.hooksPath RUNS — asserted on its artifact", () => {
  const { dir, witness } = makeRepo({ placement: "hooksPath" });
  const run = runHook(dir);
  assert.equal(run.status, 0, `unexpected failure: ${run.out}`);
  // THE row that separates "chained" from "silently skipped": the previous test
  // and this one differ ONLY in whether a repo hook exists, so a witness that is
  // never written would make both pass vacuously.
  assert.ok(existsSync(witness), "the repo hook never ran — the chain is inert");
});

test("a FAILING repo hook fails the commit, with its exit code EXACT (no swallow)", () => {
  for (const code of [3, 42]) {
    const { dir, witness } = makeRepo({ placement: "hooksPath", body: `exit ${code}` });
    const run = runHook(dir);
    assert.ok(existsSync(witness), `the repo hook never ran for exit ${code}`);
    assert.equal(
      run.status,
      code,
      `exit ${code} was not propagated (got ${run.status}) — a swallowed code is the ` +
        `original defect wearing a fix's clothes`,
    );
  }
});

test("a hook at .git/hooks/pre-commit with no core.hooksPath also chains", () => {
  // The other live shape on this box: a lefthook shim installed into the git
  // common dir rather than a tracked `.husky/`.
  const pass = makeRepo({ placement: "gitHooks" });
  assert.equal(runHook(pass.dir).status, 0);
  assert.ok(existsSync(pass.witness), "the git-common-dir fallback did not fire");

  // And the same shape failing, so the row above is not a vacuous pass.
  const fail = makeRepo({ placement: "gitHooks", body: "exit 4" });
  assert.equal(runHook(fail.dir).status, 4);
  assert.ok(existsSync(fail.witness));
});

test("a non-executable repo hook still runs — husky v9 sets no mode bit", () => {
  const { dir, witness } = makeRepo({ placement: "hooksPath", body: "exit 5", executable: false });
  const run = runHook(dir);
  assert.ok(existsSync(witness), "a hook without the mode bit was skipped");
  assert.equal(run.status, 5, "the code must survive the `sh` fallback path too");
});

test("a repo whose core.hooksPath IS our dir exits 0 rather than recursing", () => {
  // ⚠️ Measured 2026-09-06: `git rev-parse --git-path hooks` HONOURS
  // core.hooksPath, so the naive resolution returns this very directory. Without
  // the self-exec guard this hangs forever instead of failing.
  const { dir } = makeRepo({ placement: "none" });
  execFileSync("git", ["config", "core.hooksPath", HOOKS_DIR], { cwd: dir, env: cleanEnv() });
  const run = runHook(dir);
  assert.equal(run.status, 0, `expected the self-exec guard to bail cleanly: ${run.out}`);
});

test("a hanging repo hook is killed and the commit is REFUSED, never passed", () => {
  const { dir } = makeRepo({ placement: "hooksPath", body: "sleep 30" });
  const run = runHook(dir, { ACPX_HOOK_TIMEOUT: "1" });
  assert.equal(run.status, 124, `expected a timeout refusal, got ${run.status}: ${run.out}`);
  assert.match(run.out, /the commit is REFUSED/, "a timeout must say why, not fail mutely");
});

test("ACPX_HOOK_TIMEOUT=0 removes the bound and still reports the exact code", () => {
  const { dir } = makeRepo({ placement: "hooksPath", body: "exit 7" });
  assert.equal(runHook(dir, { ACPX_HOOK_TIMEOUT: "0" }).status, 7);
});

test("a repo hook that reads stdin gets EOF instead of hanging on a dead terminal", () => {
  // An agent has no terminal to answer a prompt on, so stdin is closed
  // deliberately: an interactive hook must FAIL here, not wedge every commit.
  const { dir } = makeRepo({ placement: "hooksPath", body: "read answer || exit 9\nexit 0" });
  const run = runHook(dir, { ACPX_HOOK_TIMEOUT: "20" });
  assert.equal(run.status, 9, `expected EOF on stdin, got ${run.status} (124 would mean it hung)`);
});
