// brick://4271b338 — the owner reap must be a property of THIS REPO, not of the
// command someone types.
//
// WHAT WENT WRONG. `owner-reaper.ts` (brick://113073b8) works. It is reached by
// exactly two install sites, and BOTH are supplied by the launcher:
//
//   1. `runtime-test-helpers.ts` calls `installOwnerReaper()` at module load —
//      but the dominant owner spawners (`cli.test.ts`, `integration.test.ts`) do
//      not import it, which is precisely why (2) exists;
//   2. `install-owner-reaper.ts` is passed as `node --test --import <preload>` by
//      `scripts/run-tests.mjs` — and by nothing else.
//
// So a bare `node --test dist-test/test/cli.test.js` — the targeted single-file
// run our own briefs sanction — gets NEITHER. No preload ⇒ no ACPX_TEST_OWNER_TAG
// ⇒ no `after()` hook ⇒ nothing reaps; and `ACPX_OWNER_IDLE_RELEASE_MS` (also set
// only by that script, to 60 s) falls back to the PRODUCTION 30-minute default, so
// not one owner self-releases during the run either. Both legs absent, together,
// silently: measured on origin/main 11cadc6e, one such run left the owner orphaned
// to ppid 1 while the test reported `ok 1 … # pass 1`.
//
// WHY A TEST AND NOT JUST THE FIVE IMPORTS. `install-owner-reaper.ts`'s own header
// warns that a hook registered file-by-file is "a hand-maintained list wearing a
// disguise, and its failure is silent: a reaper that matches nothing looks exactly
// like one that worked." Adding the imports without this guard reproduces that
// warning one level up — the next test file to spawn the CLI silently reopens the
// leak. This test is what makes the list machine-checked instead of remembered.
//
// WHY THE QUERY IS DELIBERATELY BROAD. It demands the import of every test file
// that so much as REFERENCES `src/cli.js`, which is wider than "spawns an owner"
// (`cli-entrypoint.test.ts` only imports the module in-process). That asymmetry is
// chosen, not sloppy: a false positive costs one inert import line, a false
// negative costs a fleet-visible leak that no test output mentions. Keep it dumb.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Resolved from this module, not from `process.cwd()`: the compiled copy runs from
// `dist-test/test/`, and the sources it must read are the `.ts` originals.
const TEST_DIR = fileURLToPath(new URL("../../test/", import.meta.url));

/** The only in-repo path that reaches `spawnQueueOwnerProcess` is the real CLI. */
const CLI_REFERENCE = "src/cli.js";

/** Either install site satisfies the requirement — they register the same hook. */
const INSTALL_SITES = ["./runtime-test-helpers.js", "./install-owner-reaper.js"];

function testFileSources(): { file: string; source: string }[] {
  return readdirSync(TEST_DIR)
    .filter((entry) => entry.endsWith(".test.ts"))
    .map((file) => ({ file, source: readFileSync(path.join(TEST_DIR, file), "utf8") }));
}

test("every test file that references the CLI installs the owner reaper itself (brick://4271b338)", () => {
  const sources = testFileSources();

  // Controls, asserted before the finding. A sweep that examined nothing reports
  // exactly the same green as a sweep that found nothing wrong — and "the count
  // went to zero" is indistinguishable from luck without them.
  assert.ok(
    sources.length > 50,
    `expected to have read the test dir, got ${String(sources.length)} files`,
  );
  const referencing = sources.filter((entry) => entry.source.includes(CLI_REFERENCE));
  assert.ok(
    referencing.length > 0,
    `no test file references ${CLI_REFERENCE} — the query is broken, not the repo`,
  );

  const uncovered = referencing
    .filter((entry) => !INSTALL_SITES.some((site) => entry.source.includes(site)))
    .map((entry) => entry.file);

  assert.deepEqual(
    uncovered,
    [],
    `these test files reference ${CLI_REFERENCE} but install no owner reaper, so the ` +
      `\`__queue-owner\` daemons they spawn are reaped only when the run happens to go ` +
      `through scripts/run-tests.mjs — and are orphaned to ppid 1 for 30 minutes otherwise. ` +
      `Add \`import "./install-owner-reaper.js";\` at the top of each: ${uncovered.join(", ")}`,
  );
});

test("the reaper install sites this guard accepts still exist (brick://4271b338)", () => {
  // The guard is a string match, so a rename would make it pass by never matching
  // anything — the silent-success shape it exists to prevent. Pin the filenames.
  const present = readdirSync(TEST_DIR);
  assert.ok(
    present.includes("owner-reaper.ts"),
    "test/owner-reaper.ts is gone — this guard is now vacuous",
  );
  assert.ok(
    present.includes("install-owner-reaper.ts"),
    "test/install-owner-reaper.ts is gone — the import this guard demands cannot resolve",
  );
  assert.ok(
    present.includes("runtime-test-helpers.ts"),
    "test/runtime-test-helpers.ts is gone — the other accepted install site",
  );
});
