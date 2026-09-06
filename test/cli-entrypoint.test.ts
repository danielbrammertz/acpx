// brick://4271b338 — ⚠️ DELIBERATELY INERT HERE. DO NOT DELETE AS DEAD CODE.
//
// Every other file carrying this import spawns `__queue-owner` daemons and needs
// the reaper (a bare `node --test <file>` passes no `--import` preload, so nothing
// reaps and nothing self-releases). THIS file does not spawn: it only imports the
// CLI module in-process. The reap here identifies nothing and kills nothing —
// `identified=0 killed=0` — which is the whole cost of the line.
//
// It is here because `owner-reaper-coverage.test.ts` demands the import of every
// test file that so much as REFERENCES `src/cli.js`, a query deliberately broader
// than "spawns an owner". The asymmetry is the point: a false positive costs this
// one inert import, a false negative costs a fleet-visible daemon leak that no test
// output mentions. Narrowing the guard to "actually spawns" would mean teaching it
// to recognise spawning — a cleverer guard with a silent failure mode, which is
// exactly what `install-owner-reaper.ts`'s header warns about.
//
// So: if you are here because this line looks pointless, it is. That is recorded,
// not overlooked. Removing it reds the guard.
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
