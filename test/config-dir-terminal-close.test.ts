import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp/client.js";
import { applyHarnessConfigDir, releaseHarnessConfigDir } from "../src/acp/harness-config-dir.js";
import { AGENT_REGISTRY } from "../src/agent-registry.js";
import { withTempHome } from "./queue-test-helpers.js";
import { makeSessionRecord, writeSessionRecordFile } from "./runtime-test-helpers.js";

/** A pid that is provably not running, so `dropStaleHolders` must drop its holder.
 *  Chosen by probing rather than assumed: a hardcoded "dead" pid can be recycled. */
const DEAD_PID = (() => {
  for (let candidate = 4_194_300; candidate > 4_000_000; candidate -= 7) {
    try {
      process.kill(candidate, 0);
    } catch {
      return candidate;
    }
  }
  throw new Error("could not find a dead pid to build the fixture with");
})();

// 4a6fdda0 — removal on close belongs to the session's TERMINAL close.
//
// ⚠️ THE PROPERTY, FROM AN IN-PROCESS REPRODUCTION. Two `AcpClient`s of one
// session compute the SAME config dir: `resolveConfigDirId()` returns the record
// id when present, BY DESIGN, so repeated spawns of one session reuse a single
// directory instead of accumulating one per resume. But `close()` on EITHER did
// an unconditional recursive `rmSync`. A transient client closing therefore
// deleted the primer and the model pin out from under the client still serving a
// turn.
//
// ⚠️ THE SECOND HALF OF THE BAR IS THE HALF THAT IS EASY TO MISS: the directory
// SURVIVING the first close is not sufficient. A directory that survives while
// the adapter's turn dies is not a fix, so the real-spawn row below completes a
// turn AFTER the first client has closed.
//
// ⚠️ THIS IS FIXED ON ITS OWN TERMS, NOT AS AN EXPLANATION FOR THE RETRACTED
// F-11 ANOMALY (brick 8d754d94). That report was re-measured and withdrawn; it
// stays honestly open rather than being handed a tidy cause it has not earned.
//
// 📌 It is one half of a pair. `78cc444` made the THIRD-PARTY sweep safe
// (positive ownership + a /proc live-process leg); this is the OWNER-OF-CLOSE
// half. Neither alone is the whole custody story for a config dir.

const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

function sharedDir(root: string, sessionId: string, holders: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < holders; i += 1) {
    const plan = applyHarnessConfigDir({
      env: {},
      agentCommand: AGENT_REGISTRY.pi,
      sessionId,
      primer: "P",
      rootDir: root,
    });
    assert.ok(plan?.holderId, `holder ${i} did not receive a claim`);
    ids.push(plan.holderId);
  }
  return ids;
}

test("4a6fdda0: the FIRST of two clients closing does NOT remove the shared dir", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "4a6fdda0-"));
  try {
    const [first, second] = sharedDir(root, "shared-1", 2);
    const dir = path.join(root, "acpx-pi-shared-1");

    // CONTROL: both clients really did land on ONE directory. Without this the
    // row would pass just as well on a build that gave each its own.
    assert.equal(existsSync(dir), true, "control: the shared dir was never created");
    assert.notEqual(first, second, "control: the two holders must be distinguishable");

    const firstClose = releaseHarnessConfigDir(dir, first);
    assert.equal(firstClose.removed, false, "the first close REMOVED the shared dir");
    assert.equal(firstClose.remainingHolders, 1);
    assert.equal(existsSync(dir), true, "the dir is gone after a non-terminal close");

    const terminal = releaseHarnessConfigDir(dir, second);
    assert.equal(terminal.removed, true, "the TERMINAL close failed to remove the dir");
    assert.equal(existsSync(dir), false, "the dir survived its terminal close — a leak");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("4a6fdda0: a single client still removes its dir — the fast path is intact", async () => {
  // The two-sided control. A fix that simply stopped removing would pass the row
  // above and reintroduce the leak `433f6bf8` exists to prevent.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "4a6fdda0-solo-"));
  try {
    const [only] = sharedDir(root, "solo-1", 1);
    const dir = path.join(root, "acpx-pi-solo-1");
    assert.equal(existsSync(dir), true, "control: the dir was never created");
    const result = releaseHarnessConfigDir(dir, only);
    assert.equal(result.removed, true, "a sole holder's close no longer removes the dir");
    assert.equal(existsSync(dir), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("4a6fdda0: an UNREADABLE holder set removes NOTHING and says so", async () => {
  // A holder set that cannot be read is a NON-MEASUREMENT. Treating it as "zero
  // holders" would restore the unconditional delete this whole change removes.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "4a6fdda0-unread-"));
  try {
    const dir = path.join(root, "acpx-pi-no-holders");
    await fs.mkdir(dir, { recursive: true });
    const result = releaseHarnessConfigDir(dir, "some-holder");
    assert.equal(result.notMeasured, true, "an unreadable holder set was treated as measured");
    assert.equal(result.removed, false, "removed a dir whose holders could not be read");
    assert.equal(existsSync(dir), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("4a6fdda0: a path this module could not have created is never removed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "4a6fdda0-foreign-"));
  try {
    const foreign = path.join(root, "not-ours");
    await fs.mkdir(foreign, { recursive: true });
    const result = releaseHarnessConfigDir(foreign, "h1");
    assert.equal(result.removed, false);
    assert.equal(existsSync(foreign), true, "a foreign directory was deleted");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("4a6fdda0 REAL SPAWN: the dir survives client A's close AND client B's TURN COMPLETES", async () => {
  // ⚠️ THE ROW THE BAR IS ACTUALLY ABOUT. Everything above is about a directory
  // existing; this is about the session still WORKING after the other client let
  // go. A dir that survives while the turn dies is not a fix.
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "4a6fdda0-spawn-"));
  const clients: AcpClient[] = [];
  try {
    const linkDir = path.join(scratch, "pi-acp");
    await fs.mkdir(linkDir, { recursive: true });
    const mockLink = path.join(linkDir, "mock-agent.js");
    await fs.symlink(MOCK_AGENT_PATH, mockLink);

    const recordId = `rec-4a6fdda0-${path.basename(scratch)}`;
    const spawn = async () => {
      const client = new AcpClient({
        agentCommand: `node ${JSON.stringify(mockLink)}`,
        cwd: scratch,
        permissionMode: "approve-reads",
        sessionContext: { acpxRecordId: recordId },
      });
      clients.push(client);
      await client.start();
      const session = await client.createSession();
      return { client, sessionId: session.sessionId };
    };

    const a = await spawn();
    const b = await spawn();

    // CONTROL: they really are two clients of ONE session's directory. If
    // `resolveConfigDirId()` ever stopped reusing the record id, this row would
    // silently stop testing anything.
    assert.ok(a.client.harnessConfigDirPath, "client A got no config dir");
    assert.equal(
      a.client.harnessConfigDirPath,
      b.client.harnessConfigDirPath,
      "the two clients did not share a directory — this row is vacuous",
    );
    const dir = a.client.harnessConfigDirPath;
    const configPath = path.join(dir, "settings.json");
    assert.equal(existsSync(configPath), true, "control: the config was never written");

    await a.client.close();

    // Half one: the directory, and its CONTENTS, survive.
    assert.equal(existsSync(dir), true, "client A's close deleted the shared dir");
    assert.equal(existsSync(configPath), true, "client A's close deleted the shared config file");

    // Half two, and the one that matters: B's turn still completes.
    await b.client.setSessionConfigOption(b.sessionId, "mode", "build").catch(() => {
      // The mock may not advertise `mode`; the round-trip is the subject.
    });
    const turn = await b.client.prompt(b.sessionId, [{ type: "text", text: "ping" }]);
    assert.ok(turn, "client B's turn did not complete after A closed");

    // And the terminal close still cleans up.
    await b.client.close();
    assert.equal(existsSync(dir), false, "the dir survived the TERMINAL close — a leak");
  } finally {
    for (const client of clients) {
      await client.close().catch(() => {});
    }
    await fs.rm(scratch, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 433f6bf8 — `closeSession` IS A CLOSE PATH, AND IT DID NOT RELEASE ANYTHING.
//
// ⚠️ WHY THE ROWS ABOVE COULD ALL PASS WHILE THE LEAK RAN. Every one of them
// closes an `AcpClient`, and `AcpClient.close()` has released since 4a6fdda0.
// The sessions that actually leak have NO CLIENT LEFT TO CLOSE: an owner
// released for idleness, a `kill -9`, a pod eviction. `acpx sessions close`
// then terminalises a record whose client is already gone, and nothing on that
// path ever looked at `harness_config_dir`.
//
// MEASURED on the deployed build 2026-09-08, before this fix: eight
// `/tmp/acpx-pi-<id>` directories, ~320 KB each, EVERY record `closed:true`
// carrying the correct `harness_config_dir`, and EVERY holder pid dead. They had
// survived ~16 h and more than two six-hour sweep intervals.
//
// 🛑 THE SUBJECT HERE IS `closeSession`, NOT `releaseHarnessConfigDir`. The
// release primitive was already correct and already tested — the defect was that
// the close path never CALLED it. A row that exercised the primitive again would
// pass on the unfixed build and prove nothing.
// ---------------------------------------------------------------------------

test("433f6bf8: a TERMINAL closeSession releases the dir when no LIVE holder remains", async () => {
  await withTempHome(async (homeDir) => {
    const { closeSession } = await import("../src/cli/session/session-control.js");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-433f6bf8-dead-"));
    try {
      // A dir shaped exactly like a real one, held by a pid that is GONE — the
      // measured state of all eight leaked directories.
      const dir = path.join(root, "acpx-pi-rec-433-dead");
      await fs.mkdir(path.join(dir, ".acpx-holders"), { recursive: true });
      await fs.writeFile(path.join(dir, "settings.json"), "{}");
      await fs.writeFile(path.join(dir, ".acpx-holders", `${DEAD_PID}-deadbeef`), "");

      const record = makeSessionRecord({
        acpxRecordId: "rec-433-dead",
        acpSessionId: "ses-433-dead",
        agentCommand: AGENT_REGISTRY.pi,
        cwd: homeDir,
      });
      record.acpx = { ...record.acpx, harness_config_dir: dir };
      await writeSessionRecordFile(homeDir, record);

      assert.equal(existsSync(dir), true, "control: the dir must exist before the close");

      await closeSession("rec-433-dead");

      assert.equal(
        existsSync(dir),
        false,
        "THE DEFECT: the terminal close left the config dir behind. Every leaked directory " +
          "measured on the box was in exactly this state — closed record, dead holder, dir on disk.",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

test("433f6bf8 CONTROL: a LIVE holder keeps the dir — a close never deletes under a live client", async () => {
  // The two-sidedness that stops the row above from being satisfied by an
  // unconditional delete, which is the regression 4a6fdda0 exists to prevent.
  // Same close, same shape, ONE difference: the holder's pid is this very
  // process, so it is provably alive.
  await withTempHome(async (homeDir) => {
    const { closeSession } = await import("../src/cli/session/session-control.js");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-433f6bf8-live-"));
    try {
      const dir = path.join(root, "acpx-pi-rec-433-live");
      await fs.mkdir(path.join(dir, ".acpx-holders"), { recursive: true });
      await fs.writeFile(path.join(dir, "settings.json"), "{}");
      await fs.writeFile(path.join(dir, ".acpx-holders", `${process.pid}-liveheld`), "");

      const record = makeSessionRecord({
        acpxRecordId: "rec-433-live",
        acpSessionId: "ses-433-live",
        agentCommand: AGENT_REGISTRY.pi,
        cwd: homeDir,
      });
      record.acpx = { ...record.acpx, harness_config_dir: dir };
      await writeSessionRecordFile(homeDir, record);

      await closeSession("rec-433-live");

      assert.equal(
        existsSync(dir),
        true,
        "a live holder's directory was deleted by a close — this is the 4a6fdda0 regression, " +
          "and it is worse than the leak it would be fixing",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

test("433f6bf8: a record with NO recorded config dir closes cleanly and touches nothing", async () => {
  // The population's third case. Most sessions are claude/codex and never get a
  // config dir at all; the release must be a no-op for them rather than an error
  // on a close path that must not fail.
  await withTempHome(async (homeDir) => {
    const { closeSession } = await import("../src/cli/session/session-control.js");
    const record = makeSessionRecord({
      acpxRecordId: "rec-433-none",
      acpSessionId: "ses-433-none",
      agentCommand: AGENT_REGISTRY.claude,
      cwd: homeDir,
    });
    await writeSessionRecordFile(homeDir, record);

    const result = await closeSession("rec-433-none");
    assert.equal(result.record.closed, true, "the close itself must still succeed");
  });
});
