// brick://4271b338 — install the owner reaper FROM THIS FILE, not only from the
// launcher. This file reaches the real CLI, which spawns `__queue-owner` daemons;
// `scripts/run-tests.mjs` reaps them via `--import`, but a bare `node --test
// <file>` — the targeted run our own briefs sanction — passes no preload, so every
// owner is orphaned to ppid 1 and lives out the PRODUCTION 30-minute idle release
// while the run reports green. Idempotent beside the preload; enforced by
// `owner-reaper-coverage.test.ts`.
import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import test from "node:test";

test("importing the CLI module does not install entrypoint-only process state", async () => {
  const stdoutErrorListeners = process.stdout.listeners("error");
  const stderrErrorListeners = process.stderr.listeners("error");
  const previousQueueOwnerArgs = process.env.ACPX_QUEUE_OWNER_ARGS;
  const previousExecArgv = [...process.execArgv];

  process.execArgv.splice(0, process.execArgv.length, "--import", "acpx-test-loader");
  delete process.env.ACPX_QUEUE_OWNER_ARGS;

  try {
    await import(`../src/cli.js?entrypoint-side-effects=${Date.now()}`);

    assert.deepEqual(process.stdout.listeners("error"), stdoutErrorListeners);
    assert.deepEqual(process.stderr.listeners("error"), stderrErrorListeners);
    assert.equal(process.env.ACPX_QUEUE_OWNER_ARGS, undefined);
  } finally {
    process.execArgv.splice(0, process.execArgv.length, ...previousExecArgv);
    if (previousQueueOwnerArgs == null) {
      delete process.env.ACPX_QUEUE_OWNER_ARGS;
    } else {
      process.env.ACPX_QUEUE_OWNER_ARGS = previousQueueOwnerArgs;
    }
  }
});
