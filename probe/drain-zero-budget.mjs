// b1f672ff probe — is the "after 0ms" red a ZERO-PASS race?
//
// waitForSessionUpdateDrain computes `deadline = Date.now() + timeout` and then
// tests `while (Date.now() <= deadline)`. With a 0ms budget the loop body runs
// only if the clock has NOT ticked between those two reads. A clock that
// advances on every read makes the tick certain, so this is the load condition
// made deterministic.
//
// It COUNTS loop passes by instrumenting `processedSessionUpdates`, which is
// read ONLY inside the loop body (client.ts:2888, :2892) and never before it --
// unlike `observedSessionUpdates`, which is also read at :2877 to seed
// `lastObserved`. (First cut of this probe instrumented that one and read its
// pre-loop read as a body pass; corrected here.)
import { AcpClient } from "../dist-test/src/acp/client.js";

const makeClient = () =>
  new AcpClient({
    agentCommand: "node ./test/mock-agent.js",
    cwd: process.cwd(),
    permissionMode: "approve-reads",
  });

function instrument(client) {
  let reads = 0;
  const value = client.processedSessionUpdates;
  Object.defineProperty(client, "processedSessionUpdates", {
    get() {
      reads += 1;
      return value;
    },
    configurable: true,
  });
  return () => reads;
}

async function run(label, stubClock) {
  const client = makeClient();
  const readsOf = instrument(client);
  const realNow = Date.now;
  if (stubClock) {
    let tick = 0;
    Date.now = () => realNow.call(Date) + tick++;
  }
  let outcome;
  const startedAt = realNow.call(Date);
  try {
    await client.waitForSessionUpdateDrain(0, 0);
    outcome = "RESOLVED";
  } catch (error) {
    outcome = `THREW: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    Date.now = realNow;
  }
  const elapsed = realNow.call(Date) - startedAt;
  console.log(
    `${label}: outcome=${outcome} | body reads of processedSessionUpdates=${readsOf()} | elapsed=${elapsed}ms`,
  );
  return { outcome, reads: readsOf() };
}

// CONTROL (real clock, no stub): must RESOLVE and must have entered the body at
// least once -- otherwise the probe proves nothing about the stubbed run.
const control = await run("control  (real clock)  ", false);
const probe = await run("probe    (ticking clock)", true);

let rc = 0;
if (control.outcome !== "RESOLVED" || control.reads < 1) {
  console.log("CONTROL DID NOT FIRE -- the probe is not interpretable");
  rc = 2;
}
if (probe.reads === 0 && probe.outcome.startsWith("THREW")) {
  console.log("MECHANISM CONFIRMED: zero loop passes, immediate throw");
} else if (probe.outcome === "RESOLVED" && probe.reads >= 1) {
  console.log("FIXED: the completeness check ran despite the exhausted budget");
} else {
  console.log("UNEXPECTED SHAPE -- do not interpret");
  rc = 3;
}
process.exit(rc);
