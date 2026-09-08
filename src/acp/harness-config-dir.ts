import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { deriveBilling } from "../models/catalogue.js";
import {
  defaultCatalogueCachePath,
  readOpenRouterCacheSync,
} from "../models/openrouter-catalogue.js";
import type { ModelBilling } from "../models/types.js";
import {
  type LivePidScan,
  type LiveProcessScan,
  pidObservedLive,
  pidScanIsMeasured,
  scanIsMeasured,
  scanLivePids,
} from "../process-population.js";
import {
  harnessIdForAgentCommand,
  HARNESS_FACTS,
  HARNESS_IDS,
  type HarnessId,
} from "./harness-capabilities.js";
import { resolveHarnessConfigDirRoot } from "./harness-config-dir-root.js";
import { readPiAdvertisedModelIds } from "./pi-model-knowledge.js";

/**
 * ONE per-session harness config dir, serving THREE purposes (CONCEPTION §5.3).
 *
 * ## Why one mechanism and not three
 *
 * Both new harnesses resolve a model against **their own model catalogue** and
 * reject an unknown slug **locally, without ever putting the request on the wire
 * to the provider** (I1 R6, I2 R5).
 *
 * ⚠️ **PI'S CATALOGUE IS BUNDLED — do not generalise that to the next harness.**
 * pi's ships with the package (`@earendil-works/pi-agent-core`), so it is on
 * disk before the first request. A harness that instead fetches its catalogue
 * live at runtime carries a network dependency, a cache, and a row count that
 * moves between runs; nothing here may assume otherwise on its behalf.
 *
 * So "any
 * OpenRouter model" is not free: it requires generating a catalogue fragment
 * into the harness's own config — and that is the same directory the primer
 * already needs, and the same one the model pin goes in. Three requirements,
 * one directory. That is the strongest argument for the config dir being a
 * single mechanism rather than three bolted together.
 *
 *   1. the **primer** — `agents.md` + the brick block
 *   2. the **model pin**
 *   3. a generated **catalogue fragment** for an arbitrary slug
 *
 * ## The precedent this reuses
 *
 * acpx already creates a per-session config dir and points the child at it by
 * env: the OpenRouter shim does exactly this (`src/acp/auth-env.ts` —
 * `join(tmpdir(), \`or-${sessionId}\`)` + `CLAUDE_CONFIG_DIR`). This is that
 * pattern, for the two harnesses whose only working primer path it is.
 *
 * ## ⚠️ IT IS GATED PER HARNESS, OFF THE DESCRIPTOR — never applied unconditionally
 *
 * This writes environment variables into the ADAPTER spawn. Applied to every
 * agent, claude / claude-pty / codex would each silently gain env entries they
 * have no use for — a real behaviour change to three harnesses the program
 * requires to be untouched. The gate is `primerChannel === "config-file"`, which
 * only pi declares, so a harness that carries its primer on an ACP `_meta`
 * channel is never given a config dir it would ignore.
 *
 * ⚠️ **RS-01 CANNOT SEE THIS, IN EITHER DIRECTION**, so it is not the evidence
 * that the gate works. There are two spawn boundaries one level apart:
 *
 * ```
 * acpx-ui ──spawn('acpx')──▶ acpx CLI ──spawn(adapter)──▶ the harness adapter
 *              ▲                              ▲
 *              └── the rig shim captures HERE  └── THIS module writes HERE
 *                  (that is RS-01)
 * ```
 *
 * RS-01 would report an empty delta for a working gate and an equally empty
 * delta for one that never ran. The evidence is RS-13: the adapter-boundary
 * differential, population printed in both arms.
 */

/** The prefix every per-session harness config dir carries. One definition, used
 *  by the writer, the remover and the orphan sweep, so they cannot disagree. */
const CONFIG_DIR_PREFIX = "acpx-";

/** `acpx-<harness>-<id>` — the only place this name is composed. */
function configDirName(harness: HarnessId, sessionId: string): string {
  return `${CONFIG_DIR_PREFIX}${harness}-${sessionId}`;
}

/**
 * Where a config dir records WHO is currently using it (brick 4a6fdda0).
 *
 * ⚠️ INSIDE the config dir, not beside it — deliberately. A sibling directory
 * would need its own cleanup and would either collide with the sweep's `acpx-`
 * prefix or escape the sweep entirely, and a holders root no reaper can see is a
 * leak with no reaper. Inside, it disappears with the directory it describes.
 *
 * ## ⚠️ THE RISK THAT BUYS, AND THE FROZEN MEASUREMENT THAT BOUNDS IT
 *
 * Putting acpx's bookkeeping inside a directory a HARNESS reads is only safe if
 * the harness does not enumerate it. That was checked at source rather than
 * assumed:
 *
 *   **pi-acp 0.0.33** — its ONLY recursive enumeration is `loadCommandsFromDir`,
 *   over `~/.pi/agent/prompts` and `<cwd>/.pi/prompts`, reading `.md` files. It
 *   never enumerates `PI_CODING_AGENT_DIR` itself.
 *
 * ⚠️ **THAT IS A VERSION-PINNED MEASUREMENT, NOT A PROPERTY.** It is the same
 * shape of fact as the `pi-acp` `session/set_model` capability cell, which was
 * TRUE and WENT STALE between 0.0.26 and 0.0.33 with nothing failing to announce
 * it — and as `piWireDepthValue`'s ladder, which carries the same warning. **A
 * future pi-acp that enumerates its own agent dir turns this safe placement into
 * a harness-visible artifact, silently.**
 *
 * **RE-MEASURE TRIGGER: when the pinned `pi-acp` version in `agent-registry.ts`
 * moves.** Re-run the check — grep the adapter's dist for `readdirSync` and
 * confirm no enumeration roots at `PI_CODING_AGENT_DIR` — and update the version
 * named above. The `pi does NOT get a generated models-store.json` row pins pi's
 * exact directory listing, acpx bookkeeping and harness-visible entries as two
 * separate lists, so it fails on any NEW entry; it cannot, however, notice the
 * harness starting to read an entry that was already there.
 */
const HOLDERS_DIR = ".acpx-holders";

/** What a release decided, so "nothing happened" is never silent. */
export interface HarnessConfigDirReleaseResult {
  /** True when this was the TERMINAL close and the directory was removed. */
  removed: boolean;
  /** Holders still registered after this one let go. */
  remainingHolders: number;
  /** True when the holder set could not be read, so no removal was attempted. */
  notMeasured: boolean;
  /** Holders dropped because their owning process is gone (brick c9b2520f). */
  droppedStaleHolders: number;
  /**
   * Whether the STALE check ran at all. ⚠️ `false` means `/proc` was not
   * enumerable, so no holder was judged — distinct from "every holder was live",
   * which produces the same `droppedStaleHolders: 0`.
   */
  staleCheckMeasured?: boolean;
}

/**
 * Claim a config dir for one client, returning the holder id it must release.
 *
 * The id carries the PID so a stale holder is diagnosable rather than anonymous,
 * plus a random suffix because ONE process can hold the same directory twice —
 * which is exactly the two-client case this brick is about.
 */
function registerConfigDirHolder(dir: string): string {
  const holderId = `${process.pid}-${randomUUID().slice(0, 8)}`;
  try {
    mkdirSync(join(dir, HOLDERS_DIR), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, HOLDERS_DIR, holderId), `${new Date().toISOString()}\n`, {
      mode: 0o600,
    });
  } catch {
    // A directory we cannot mark is one we must never remove on close; the
    // release below reports `notMeasured` and leaves it to the orphan sweep.
  }
  return holderId;
}

/**
 * Release ONE client's claim, and remove the directory only if it was the LAST.
 *
 * ## ⚠️ THE DEFECT THIS FIXES: CLOSE WAS NOT THE OWNER'S TO PERFORM
 *
 * Two `AcpClient`s of one session compute the SAME directory —
 * `resolveConfigDirId()` returns the record id when it is present, by design, so
 * repeated spawns reuse one directory instead of accumulating one per resume.
 * But `close()` on EITHER client did an unconditional recursive `rmSync`. A
 * transient client closing therefore deleted the primer and model pin out from
 * under the client still serving a turn. **Removal belongs to the session's
 * TERMINAL close, not to whichever client happens to finish first.**
 *
 * ## Why a filesystem refcount and not an in-process one
 *
 * The two clients are not necessarily in one process — a queue owner and a CLI
 * invocation are separate processes reaching the same session. An in-memory
 * counter would be blind to exactly the case that matters.
 *
 * ⚠️ AND IT IS HONEST ABOUT ITS RACE. Between the last holder's removal and the
 * `rmSync`, a new client could claim the directory and lose it. The window is
 * two syscalls wide and the loser re-creates on its next spawn; the alternative
 * — a lock — buys less than it costs here. What is NOT left to chance is the
 * unreadable case: a holder set that cannot be read removes NOTHING and says so.
 */
export function releaseHarnessConfigDir(
  dir: string | undefined,
  holderId: string | undefined,
  /** The pid census. Injectable so a test can supply an UNMEASURABLE one; the
   *  default is a real `/proc` enumeration, with no environ reads. */
  pidScan: LivePidScan | undefined = scanLivePids(),
): HarnessConfigDirReleaseResult {
  if (!dir || !basename(dir).startsWith(CONFIG_DIR_PREFIX)) {
    return { removed: false, remainingHolders: 0, notMeasured: true, droppedStaleHolders: 0 };
  }
  const holders = join(dir, HOLDERS_DIR);
  if (holderId) {
    try {
      rmSync(join(holders, holderId), { force: true });
    } catch {
      // Already gone; the count below is what decides, not this.
    }
  }
  let remaining: string[];
  try {
    remaining = readdirSync(holders);
  } catch {
    // ⚠️ NOT "zero holders". An unreadable holder set is a NON-MEASUREMENT, and
    // treating it as empty would restore precisely the unconditional delete this
    // function exists to end. The orphan sweep collects it later.
    return { removed: false, remainingHolders: 0, notMeasured: true, droppedStaleHolders: 0 };
  }

  const stale = dropStaleHolders(holders, remaining, pidScan);
  if (stale.remaining.length > 0) {
    return {
      removed: false,
      remainingHolders: stale.remaining.length,
      notMeasured: false,
      droppedStaleHolders: stale.dropped,
      staleCheckMeasured: stale.measured,
    };
  }
  removeHarnessConfigDir(dir);
  return {
    removed: true,
    remainingHolders: 0,
    notMeasured: false,
    droppedStaleHolders: stale.dropped,
    staleCheckMeasured: stale.measured,
  };
}

/**
 * Drop holders whose OWNING PROCESS IS GONE, so one abandoned claim cannot pin a
 * directory forever (brick c9b2520f).
 *
 * ## The defect
 *
 * A clean drained close left holder `346359-953c2e22` behind with `/proc/346359`
 * gone. `releaseHarnessConfigDir` only ever removed the CALLER's own marker and
 * then counted, so the set could never empty and the close path could never
 * remove that directory. Nothing else collects it either: the orphan sweep is
 * **holder-blind by design** and, measured, nothing on staging invokes it — so
 * the leak is monotonic in sessions.
 *
 * ## ⚠️ WHY PID REUSE CANNOT HURT HERE — THE ARGUMENT, NOT THE CONCLUSION
 *
 * A pid can be recycled by an unrelated process, so this check can be wrong. It
 * can only be wrong in ONE direction, and it is the safe one:
 *
 *   - a recycled pid makes a DEAD holder look ALIVE ⇒ the directory is
 *     **RETAINED**. That is a leak — today's failure, made rarer.
 *   - the reverse would require a LIVE holder's pid to be absent from `/proc`,
 *     which cannot happen, **because each client registers its OWN holder**
 *     (`registerConfigDirHolder` writes `${process.pid}-${uuid8}`). A holder's
 *     pid being gone therefore means the client that made that claim is gone,
 *     and a gone client holds nothing.
 *
 * **So do not "fix" the race.** Tightening it can only trade a rare leak for a
 * deletion, which is the wrong direction on this path.
 *
 * ## ⚠️ AND IT IS GATED ON THE PID POPULATION, NOT THE FULL ONE
 *
 * `pidScanIsMeasured` — not `scanIsMeasured`. The question here is "is pid N
 * alive?", which `/proc` enumeration answers; `scanIsMeasured` additionally
 * requires readable ENVIRONMENTS, which govern a different question. Gating on
 * the wider control would make this inert on any box where environments are
 * unreadable: the fix would ship, drop nothing, and say nothing.
 *
 * An unmeasurable scan drops NOTHING and the directory is RETAINED — never the
 * other way round, because "this pid does not exist" and "I cannot tell" are the
 * same observation, and acting on the second is how an unconditional delete
 * returns.
 */
function dropStaleHolders(
  holdersDir: string,
  holderIds: readonly string[],
  pidScan: LivePidScan | undefined,
): { remaining: string[]; dropped: number; measured: boolean } {
  if (!pidScanIsMeasured(pidScan)) {
    return { remaining: [...holderIds], dropped: 0, measured: false };
  }
  const remaining: string[] = [];
  let dropped = 0;
  for (const holderId of holderIds) {
    const pid = holderPid(holderId);
    // An id whose pid cannot be parsed is NOT ours to judge — retained, for the
    // same reason the sweep retains an id it does not recognise.
    if (pid === undefined || pidObservedLive(pidScan, pid)) {
      remaining.push(holderId);
      continue;
    }
    try {
      rmSync(join(holdersDir, holderId), { force: true });
      dropped += 1;
    } catch {
      remaining.push(holderId); // could not drop it, so it still counts
    }
  }
  return { remaining, dropped, measured: true };
}

/** The pid a holder id carries. `${pid}-${uuid8}`, written by
 *  {@link registerConfigDirHolder} — the reason that id shape is not cosmetic. */
function holderPid(holderId: string): number | undefined {
  const match = /^(\d+)-/.exec(holderId);
  if (!match) {
    return undefined;
  }
  const pid = Number(match[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Remove a config dir UNCONDITIONALLY, ignoring holders.
 *
 * ⚠️ NOT THE CLOSE PATH. `releaseHarnessConfigDir` is what a client calls; this
 * is for the orphan sweep, which has already established through record state and
 * a `/proc` census that nothing owns the directory.
 */
export function removeHarnessConfigDir(dir: string | undefined): void {
  if (!dir) {
    return;
  }
  // Only ever remove a directory this module could have created. A caller that
  // passed something else would otherwise get an arbitrary recursive delete.
  if (!basename(dir).startsWith(CONFIG_DIR_PREFIX)) {
    return;
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Swept later by pruneOrphanHarnessConfigDirs.
  }
}

/** One candidate and what the rule decided about it. */
export interface ConfigDirCandidateReport {
  dir: string;
  retain: boolean;
  /** `unmeasured` appears only on the REFUSAL path, where no per-directory
   *  decision was reached at all — it is the absence of a verdict, not one. */
  reason: ConfigDirRetainReason | ConfigDirRemoveReason | "unmeasured";
  /** Present only for an unclaimed directory whose age could be read. */
  unclaimedAgeMs?: number;
}

/** What an orphan sweep did — every population printed, so 0 reads NOT RUN. */
export interface HarnessConfigDirPruneResult {
  /**
   * The directory this sweep actually walked.
   *
   * ⚠️ REPORTED, NOT ASSUMED. The root is resolved from three sources
   * (`harness-config-dir-root.ts`) and the two that are not the default are
   * invisible at the call site — an ambient `ACPX_HARNESS_CONFIG_DIR_ROOT` most of
   * all. A census that omits its root is unfalsifiable: `scanned=0 removed=0` reads
   * identically for "the box is clean" and "I was pointed at an empty directory
   * while the population sat somewhere else". Naming the root is what makes the
   * rest of the line checkable.
   */
  root: string;
  /** True when this run CLASSIFIED and removed nothing on purpose (CONCEPTION §5). */
  dryRun: boolean;
  /** Candidate directories examined. **0 means the sweep found nothing to look
   *  at — NOT RUN — not that everything was already clean.** */
  scanned: number;
  /** Directories this run actually deleted. **Empty on a dry run, always** — see
   *  {@link wouldRemove}. */
  removed: string[];
  /**
   * What a dry run WOULD have removed. Separate from {@link removed} deliberately:
   * `removed` is the field an operator greps to answer *"what did this delete?"*,
   * and one field that means "deleted" or "would have deleted" depending on a flag
   * the reader may not have seen is how a preview gets read as an incident.
   * Always empty on a real run.
   */
  wouldRemove: string[];
  /**
   * Every candidate with its verdict and reason — what makes a dry run an actual
   * PREVIEW rather than a count. Populated on real runs too, so the same renderer
   * explains a live sweep.
   */
  candidates: ConfigDirCandidateReport[];
  /** Kept for any reason. Reported so caution is visible rather than silent. */
  retained: number;
  /** Why each retention happened, so "retained 40" is diagnosable. */
  retainedBy: {
    /** A live process names this directory in its environment. */
    liveProcess: number;
    /** A record exists and is still OPEN. */
    openRecord: number;
    /** No record claims this id — never removed on a guess. */
    unrecognised: number;
    /** Unclaimed, but younger than `orphanMinAgeMs`. */
    tooYoung: number;
    /** The removal itself failed. */
    removeFailed: number;
    /**
     * ⚠️ ITS OWN VALUE, AND THAT IS THE POINT (CONCEPTION §6). The refusal path
     * used to report `liveProcess: candidates.length` — `liveProcess: 6` was
     * measured with NO live processes at all — so a structured reader could not
     * tell *"six directories are genuinely held"* from *"I could not measure and
     * refused"*. The `notMeasured` boolean beside it carried the truth while the
     * attribution actively contradicted it, and **the attribution is what a
     * dashboard renders.** A refusal that reports itself as six live holds is
     * worse than one that reports nothing, because it is confident.
     *
     * ⚠️ This is a property of THE RUN, not a verdict about a directory, which is
     * why it is deliberately NOT in {@link ConfigDirVerdict}'s reason union: a
     * verdict slot would invite a future branch to return it per candidate and
     * quietly re-create the ambiguity in the other direction.
     */
    unmeasured: number;
  };
  /** The oldest unclaimed directory retained, in ms — printed so a stuck orphan
   *  is visible instead of accumulating silently. */
  oldestUnclaimedAgeMs?: number;
  /**
   * True when the sweep REFUSED to remove anything because it could not measure
   * live processes. ⚠️ A refusal and a clean sweep both remove nothing; this is
   * what tells them apart.
   */
  notMeasured: boolean;
}

/** What the invoking HOME's store knows about one session id. */
export interface KnownSessionRecord {
  closed: boolean;
}

/**
 * Sweep config dirs whose session is gone (brick 433f6bf8), on POSITIVE
 * OWNERSHIP ONLY (brick cc9a5f25).
 *
 * ⚠️ WHY THIS EXISTS ALONGSIDE remove-on-close: **close is not guaranteed to
 * run.** An owner death, a pod eviction or a `kill -9` skips it entirely — this
 * programme saw two owner deaths in one afternoon — so remove-on-close is the
 * fast path and this is the guarantee.
 *
 * ## ⚠️ THE COMMENT THAT USED TO STAND HERE DESCRIBED A SAFETY PROPERTY THE CODE
 * ## DID NOT HAVE, AND THAT IS THE DEFECT THIS FIXES
 *
 * It claimed a directory is removed only when its id appears in "neither
 * `liveSessionIds` **nor as a live spawn**", and that "an id it does not
 * recognise is **RETAINED**". Both were false. There was **no live-spawn check at
 * all**, and the single branch was `if (liveSessionIds.has(id)) retain; else
 * rm` — so an unrecognised id was **REMOVED**. A comment asserting a protection
 * its code lacks is worse than no comment: it is what a reviewer reads instead of
 * the branch. The comment was right about the design; the code never implemented
 * it. **This implements the comment.**
 *
 * ## Removal now requires EVERY clause
 *
 *   1. the id **resolves to a record in the invoking HOME's store**, AND
 *   2. **that record is CLOSED**, AND
 *   3. **no live process references the directory** — `/proc`, with a
 *      population control ({@link scanIsMeasured}); an unmeasurable scan removes
 *      NOTHING rather than guessing.
 *
 * Anything else is RETAINED:
 *
 *   - an id **no record claims** — including the `randomUUID()` fallback dir a
 *     session gets when `acpxRecordId` is absent, which is in no session list,
 *     ever — unless it is **older than `orphanMinAgeMs` AND unreferenced**. Its
 *     age and count are printed, so the caution is visible.
 *
 * ⚠️ THE ORDERING THIS DEPENDS ON. Clause 2 makes the sweep's correctness a
 * function of RECORD state, so a store full of abandoned-open records makes a
 * *correct* sweep retain forever. The record sweep that closes ownerless records
 * must therefore run BEFORE this one (`sweepAbandonedSessionRecords`). That is a
 * fix one layer up, deliberately NOT a relaxation of the rule here.
 */
export function pruneOrphanHarnessConfigDirs(params: {
  /** Records the invoking HOME's store knows about, id → state. Both the acpx
   *  record id and the ACP session id should be keyed, since either can name a
   *  directory. */
  records: ReadonlyMap<string, KnownSessionRecord>;
  /** The `/proc` census. Absent or unmeasured ⇒ nothing is removed. */
  liveScan?: LiveProcessScan;
  rootDir?: string;
  /** How old an UNCLAIMED directory must be before it may be removed. Stated,
   *  never inferred. */
  orphanMinAgeMs?: number;
  /** Injectable clock, so the age rule is testable without waiting. */
  now?: number;
  /**
   * CLASSIFY AND REPORT, REMOVE NOTHING (CONCEPTION §5).
   *
   * ⚠️ THIS IS NOT THE OLD `--dry-run`, WHICH RETURNED BEFORE THE SWEEP EVEN RAN.
   * The mode that needs no scope was the mode that never swept, so the safest way
   * to ask "what would this remove?" was the one way that could not answer — and a
   * preview that shows nothing reads as a clean preview. A dry run now walks the
   * same candidates, applies the same rule, and calls `removeDir` for none.
   */
  dryRun?: boolean;
}): HarnessConfigDirPruneResult {
  const { root, now, orphanMinAgeMs } = resolvePruneDefaults(params);
  const dryRun = params.dryRun === true;
  const retainedBy = {
    liveProcess: 0,
    openRecord: 0,
    unrecognised: 0,
    tooYoung: 0,
    removeFailed: 0,
    unmeasured: 0,
  };
  const gated = HARNESS_IDS.filter((id) => HARNESS_FACTS[id].primerChannel === "config-file");

  const candidates = findConfigDirCandidates(root, gated);
  if (candidates === undefined) {
    // The root itself could not be read, so nothing was examined and nothing can
    // be concluded — a non-measurement, reported as one.
    return {
      root,
      dryRun,
      scanned: 0,
      removed: [],
      wouldRemove: [],
      candidates: [],
      retained: 0,
      retainedBy,
      notMeasured: true,
    };
  }

  // ⚠️ THE REFUSAL, BEFORE ANY WORK. Without a measured process census, clause 3
  // cannot be evaluated, and a sweep that skips it is exactly the blind `rm` this
  // function is not allowed to be. Note it still reports the CANDIDATE population:
  // a refusal that also printed `scanned=0` would be indistinguishable from a
  // sweep that found nothing to look at.
  if (!scanIsMeasured(params.liveScan)) {
    return {
      root,
      dryRun,
      scanned: candidates.length,
      removed: [],
      wouldRemove: [],
      // The candidate PATHS are still reported: a refusal that named none would be
      // indistinguishable from a root with nothing in it.
      candidates: candidates.map(({ dir }) => ({ dir, retain: true, reason: "unmeasured" })),
      retained: candidates.length,
      // ⚠️ `unmeasured`, NOT `liveProcess` (CONCEPTION §6). Clause 3 could not be
      // evaluated at all; claiming every candidate is held by a live process is a
      // confident answer to a question this run did not ask.
      retainedBy: { ...retainedBy, unmeasured: candidates.length },
      notMeasured: true,
    };
  }
  const liveScan = params.liveScan;

  const pass = sweepCandidatePass(candidates, retainedBy, {
    records: params.records,
    liveScan,
    now,
    orphanMinAgeMs,
    dryRun,
  });
  return { root, dryRun, ...pass, retainedBy, notMeasured: false };
}

/**
 * The per-candidate pass — every candidate classified once, and the ONLY place a
 * removal is performed. Split out of {@link pruneOrphanHarnessConfigDirs} so the
 * function above reads as *root, refusal, rule* rather than as a loop, and so the
 * decision to delete lives in one small body a reviewer can hold entirely.
 */
function sweepCandidatePass(
  candidates: readonly { dir: string; sessionId: string }[],
  retainedBy: HarnessConfigDirPruneResult["retainedBy"],
  ctx: {
    records: ReadonlyMap<string, KnownSessionRecord>;
    liveScan: LiveProcessScan;
    now: number;
    orphanMinAgeMs: number;
    dryRun: boolean;
  },
): Omit<HarnessConfigDirPruneResult, "root" | "dryRun" | "retainedBy" | "notMeasured"> {
  const removed: string[] = [];
  const wouldRemove: string[] = [];
  const details: ConfigDirCandidateReport[] = [];
  let retained = 0;
  let oldestUnclaimedAgeMs: number | undefined;
  for (const { dir, sessionId } of candidates) {
    const verdict = classifyConfigDir(dir, sessionId, ctx);
    if (verdict.unclaimedAgeMs !== undefined) {
      oldestUnclaimedAgeMs = Math.max(oldestUnclaimedAgeMs ?? 0, verdict.unclaimedAgeMs);
    }
    details.push(toCandidateReport(dir, verdict));
    if (verdict.retain) {
      retained += 1;
      retainedBy[verdict.reason] += 1;
    } else if (ctx.dryRun) {
      // ⚠️ NOT pushed into `removed`. That field is what an operator greps to answer
      // "what did this delete?", and a preview writing into it would make one field
      // mean two different things depending on a flag the reader may not have seen.
      wouldRemove.push(dir);
    } else if (!removeDir(dir, removed)) {
      retained += 1;
      retainedBy.removeFailed += 1;
    }
  }
  return {
    scanned: candidates.length,
    removed,
    wouldRemove,
    candidates: details,
    retained,
    oldestUnclaimedAgeMs,
  };
}

/** Optional `unclaimedAgeMs` spread once, so the loop above stays a rule. */
function toCandidateReport(dir: string, verdict: ConfigDirVerdict): ConfigDirCandidateReport {
  return verdict.unclaimedAgeMs === undefined
    ? { dir, retain: verdict.retain, reason: verdict.reason }
    : {
        dir,
        retain: verdict.retain,
        reason: verdict.reason,
        unclaimedAgeMs: verdict.unclaimedAgeMs,
      };
}

/**
 * The directories this module could have created, with the session id each one
 * carries. Anything else — a queue socket dir, a stray `acpx-*` — is never even a
 * candidate, so it cannot be removed by any later branch.
 */
function findConfigDirCandidates(
  root: string,
  gated: readonly HarnessId[],
): { dir: string; sessionId: string }[] | undefined {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    // ⚠️ undefined, NOT an empty list. "I could not read the root" and "the root
    // holds no config dirs" are different facts, and only the second is a clean
    // sweep. Returning [] for both is the same silent-null this module keeps
    // finding elsewhere.
    return undefined;
  }
  const candidates: { dir: string; sessionId: string }[] = [];
  for (const entry of entries) {
    const harness = gated.find((id) => entry.startsWith(`${CONFIG_DIR_PREFIX}${id}-`));
    if (harness !== undefined) {
      candidates.push({
        dir: join(root, entry),
        sessionId: entry.slice(`${CONFIG_DIR_PREFIX}${harness}-`.length),
      });
    }
  }
  return candidates;
}

/** Defaults in one place, so the main function reads as the RULE rather than as
 *  a list of fallbacks. */
function resolvePruneDefaults(params: {
  rootDir?: string;
  now?: number;
  orphanMinAgeMs?: number;
}): { root: string; now: number; orphanMinAgeMs: number } {
  return {
    // Shared with the WRITER (`harness-config-dir-root.ts`).
    // A sweep resolving its root independently of the writer is a sweep that can
    // report a clean census over a directory nothing was ever written to.
    root: resolveHarnessConfigDirRoot(params.rootDir),
    now: params.now ?? Date.now(),
    orphanMinAgeMs: params.orphanMinAgeMs ?? DEFAULT_ORPHAN_MIN_AGE_MS,
  };
}

/** Why a directory was KEPT. The only values `retainedBy` can count. */
type ConfigDirRetainReason = "liveProcess" | "openRecord" | "unrecognised" | "tooYoung";

/**
 * Why a directory was REMOVED — a SEPARATE vocabulary, and the separation is the fix.
 *
 * ## ⚠️ `openRecord` USED TO MEAN BOTH, AND ON THE REMOVE BRANCH IT SAID THE OPPOSITE
 * ## OF WHAT HAPPENED
 *
 * `classifyConfigDir` returned `reason: "openRecord"` for **both** *"kept, because the
 * record is still OPEN"* and *"removed, because the record is CLOSED"*. The preview line
 * therefore read **"WOULD REMOVE …(openRecord)"** — *"I am deleting this, and the reason is
 * that its record is open."* Measured on staging 2026-09-05 against four real leaked dirs.
 *
 * That is precisely the defect CONCEPTION §6 removes from `retainedBy` — an attribution
 * that contradicts the state it describes — arriving on the *other* branch. §6's
 * `unmeasured` fixed the refusal path; this fixes the removal path.
 *
 * ⚠️ **WHY IT SURVIVED EVERY TEST AND EVERY REHEARSAL:** on devbox every candidate was
 * `tooYoung`, so the remove-because-closed branch never executed. **A label validated only
 * on data that never exercised its other branch.** Only real staging data ran it.
 *
 * Two separate types are what stop it recurring: `retainedBy` is keyed by
 * {@link ConfigDirRetainReason} alone, so a removal cannot be attributed to a retention
 * reason and a retention cannot be counted under a removal reason.
 */
type ConfigDirRemoveReason = "closedRecord";

type ConfigDirVerdict =
  | {
      retain: true;
      reason: ConfigDirRetainReason;
      /** Set only for an unclaimed dir whose age could be read, so the caller can
       *  report the oldest one it is sitting on. */
      unclaimedAgeMs?: number;
    }
  | { retain: false; reason: ConfigDirRemoveReason; unclaimedAgeMs?: number };

/**
 * Whether one directory may be removed. **Every clause of the removal rule lives
 * here**, so the rule can be read in one place rather than reconstructed from a
 * loop — which is how the previous version's comment and code drifted apart.
 */
function classifyConfigDir(
  dir: string,
  sessionId: string,
  ctx: {
    records: ReadonlyMap<string, KnownSessionRecord>;
    liveScan: LiveProcessScan;
    now: number;
    orphanMinAgeMs: number;
  },
): ConfigDirVerdict {
  // Clause 3 first: it is the only one that can be true of a directory whose
  // record was already deleted, and it is the one whose failure mode is worst.
  if (ctx.liveScan.referencedDirs.has(dir)) {
    return { retain: true, reason: "liveProcess" };
  }
  const record = ctx.records.get(sessionId);
  if (record === undefined) {
    // Clause 1 fails. NOT ours to guess about — the fallback `randomUUID()` dir
    // lands here and is in no session list, ever.
    //
    // ## 🛑 UNRECOGNISED IS RETAIN-AND-REPORT. IT IS NEVER REMOVED.
    //
    // This branch used to remove an unclaimed directory once it aged past
    // `orphanMinAgeMs`. **That inverted the posture the whole sweep rests on: it
    // REMOVED WHAT IT COULD NOT NAME.** An unrecognised directory is the category
    // the sweep understands LEAST, so it must get the MOST conservative treatment,
    // not the most permissive one. Kept, reported with its age and reason, counted
    // separately — and left for a human who can find out what it is.
    //
    // ⚠️ THE INCONSISTENCY THIS RESOLVES, measured on staging 2026-09-05: the census
    // summary printed `unrecognised=0` as a RETAIN tally in the very same run that
    // removed a `/tmp/acpx-<harness>-session` dir with reason `unrecognised`. **One
    // token named both a retain bucket and a remove path**, so the counter could read
    // zero while that exact reason was deleting things. Now `unrecognised` means one
    // thing, and the counter means what it says.
    //
    // ⚠️ AND THE AGE GATE NO LONGER AUTHORISES ANY DELETION. It now only separates
    // two RETAIN reasons — `tooYoung` (recently written, may still be in use) from
    // `unrecognised` (old enough to be worth a human's attention). Both are kept.
    // The distinction is preserved because losing it would flatten "just created"
    // into "sitting here for a week", and the second is the one worth looking at.
    const age = directoryAgeMs(dir, ctx.now);
    if (age === undefined) {
      return { retain: true, reason: "unrecognised" };
    }
    if (age < ctx.orphanMinAgeMs) {
      return { retain: true, reason: "tooYoung", unclaimedAgeMs: age };
    }
    return { retain: true, reason: "unrecognised", unclaimedAgeMs: age };
  }
  if (!record.closed) {
    return { retain: true, reason: "openRecord" }; // Clause 2 fails.
  }
  // Every clause satisfied: a record exists AND it is CLOSED. Reported as
  // `closedRecord`, never as `openRecord` — see ConfigDirRemoveReason.
  return { retain: false, reason: "closedRecord" };
}

/**
 * How long an UNCLAIMED directory must sit before it is reported as
 * `unrecognised` rather than `tooYoung`.
 *
 * ⚠️ **IT NO LONGER AUTHORISES ANY REMOVAL, AND THIS COMMENT IS CORRECTED RATHER
 * THAN LEFT TO ROT.** It used to read "before the sweep may remove it", which was
 * true until unrecognised became retain-and-report. A comment describing a
 * behaviour the code has stopped having is what the next reader trusts INSTEAD of
 * reading the branch — this file has already been corrected twice for that class.
 *
 * ⚠️ STATED, NOT INFERRED. Six hours is longer than any turn this programme has
 * observed and shorter than a working day, so a directory older than this is worth
 * a human's attention rather than a shrug. Both sides of the line are RETAINED;
 * the line only decides which of two retain reasons is reported.
 */
const DEFAULT_ORPHAN_MIN_AGE_MS = 6 * 60 * 60 * 1000;

function removeDir(dir: string, removed: string[]): boolean {
  try {
    rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
    return true;
  } catch {
    return false;
  }
}

/** Age from mtime, or undefined when it cannot be read — which is NOT zero. */
function directoryAgeMs(dir: string, now: number): number | undefined {
  try {
    return Math.max(0, now - statSync(dir).mtimeMs);
  } catch {
    return undefined;
  }
}

/** One line carrying every population and every retention reason, so "retained
 *  40" is diagnosable rather than merely reassuring. */
export function describeHarnessConfigDirSweep(result: HarnessConfigDirPruneResult): string {
  const by = result.retainedBy;
  return (
    `[acpx] harness config dirs: root=${result.root} ` +
    (result.dryRun ? "DRY RUN (nothing removed) " : "") +
    `scanned=${result.scanned} removed=${result.removed.length} ` +
    (result.dryRun ? `wouldRemove=${result.wouldRemove.length} ` : "") +
    `retained=${result.retained} (liveProcess=${by.liveProcess} openRecord=${by.openRecord} ` +
    `unrecognised=${by.unrecognised} tooYoung=${by.tooYoung} removeFailed=${by.removeFailed} ` +
    `unmeasured=${by.unmeasured}` +
    (result.oldestUnclaimedAgeMs === undefined
      ? ""
      : ` oldestUnclaimedAgeMs=${result.oldestUnclaimedAgeMs}`) +
    ")" +
    (result.notMeasured ? " — REFUSED: /proc not measurable, nothing was removed" : "") +
    " (scanned=0 means NOT RUN, not clean)\n"
  );
}

/**
 * THE PREVIEW: one line per candidate, with the verdict and the reason.
 *
 * ⚠️ WHY THIS EXISTS SEPARATELY FROM THE ONE-LINE CENSUS. The census answers
 * *"how many, and why in aggregate"*; this answers *"which ones, and would you
 * have deleted THIS"*. On a shared box the second is the question an operator
 * actually has before they let a sweep run, and until now the mode that promised to
 * answer it (`--dry-run`) returned before the sweep started.
 *
 * Sorted by directory name so two consecutive previews are diffable — an unsorted
 * listing over a `readdir` has no defined order, and a preview you cannot diff is a
 * preview you cannot check a change against.
 */
export function describeHarnessConfigDirSweepPlan(result: HarnessConfigDirPruneResult): string {
  if (result.candidates.length === 0) {
    return (
      `[acpx] harness config dirs: no candidates under ${result.root}` +
      (result.notMeasured ? " — REFUSED, so this is NOT a statement that it is clean" : "") +
      "\n"
    );
  }
  const verb = result.dryRun ? "would remove" : "removed";
  const lines = result.candidates
    .toSorted((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))
    .map((candidate) => {
      const decision = candidate.retain ? "RETAIN" : verb.toUpperCase();
      const age =
        candidate.unclaimedAgeMs === undefined ? "" : ` ageMs=${candidate.unclaimedAgeMs}`;
      return `[acpx]   ${decision} ${candidate.dir} (${candidate.reason})${age}`;
    });
  return `${lines.join("\n")}\n`;
}

/** Verbose breadcrumb for a written config dir. Never prints a file's CONTENT —
 *  the primer can be long and the dir path is the useful handle for evidence. */
export function reportHarnessConfigDir(
  plan: HarnessConfigDirPlan | undefined,
  verbose: boolean | undefined,
): void {
  if (!plan || !verbose) {
    return;
  }
  process.stderr.write(
    `[acpx] ${plan.harness} config dir ${plan.dir} (${plan.envNames.join(", ")}); ` +
      `wrote ${plan.files.length} file(s)\n`,
  );
}

/** What was written, so a caller can log or evidence it without re-deriving. */
export interface HarnessConfigDirPlan {
  harness: HarnessId;
  dir: string;
  /** Env var names set on the adapter spawn — the RS-13 subject. */
  envNames: string[];
  /** Absolute paths written, for evidence. Never contains a credential. */
  files: string[];
  /** This client's claim on the directory — hand it back to
   *  {@link releaseHarnessConfigDir} at close. */
  holderId?: string;
}

export interface HarnessConfigDirInput {
  /** The adapter spawn env, mutated in place — same contract as `applyBoxProviderEnv`. */
  env: NodeJS.ProcessEnv;
  agentCommand: string | undefined;
  /** Namespaces the directory. Any stable per-session string. */
  sessionId: string;
  /** The rendered OS primer (`agents.md` + the brick block). */
  primer?: string;
  /** The model to pin at creation. */
  model?: string;
  /**
   * An arbitrary OpenRouter slug to PROVISION into the harness's catalogue so it
   * becomes selectable. Without this the harness rejects it locally, before any
   * network call (I1 R6, I2 R5).
   */
  provisionModelId?: string;
  /** Overrides the resolved root (`ACPX_HARNESS_CONFIG_DIR_ROOT`, else `tmpdir()`);
   *  tests use it to keep the directory inside a fixture. */
  rootDir?: string;
  /** The session's working directory — pi namespaces its session store by it
   *  (brick ac86eb34). Absent ⇒ pi's session dir is left alone. */
  cwd?: string;
}

/**
 * Create the per-session config dir for a `config-file`-primer harness and point
 * the adapter at it. Returns `undefined` — writing nothing and setting nothing —
 * for every other harness, and for an agent command the descriptor cannot
 * classify.
 *
 * Fail-open, like `resolveSessionPrimer`: a filesystem error warns on stderr and
 * returns `undefined` rather than blocking session creation. A session with no
 * primer is degraded; a session that cannot be created is broken.
 */
export function applyHarnessConfigDir(
  input: HarnessConfigDirInput,
): HarnessConfigDirPlan | undefined {
  const harness = harnessIdForAgentCommand(input.agentCommand);
  if (harness === undefined) {
    return undefined;
  }
  // THE GATE. Only a harness whose primer channel IS a config file gets one.
  if (HARNESS_FACTS[harness].primerChannel !== "config-file") {
    return undefined;
  }
  // ⚠️ REFUSE A BLANK ID — NEVER SUBSTITUTE A CONSTANT FOR IT (F-8, brick 161294ce).
  //
  // This shipped as `sessionId: record?.trim() || "session"` at the call site, and
  // on the real `sessions new` path the record id is EMPTY at adapter-spawn time
  // (`creationSessionContext` sets `acpxRecordId: ""` because the CLI record id IS
  // the adapter's own session/new id, so it cannot exist before the spawn that
  // produces it). The literal therefore fired on EVERY create: two distinct
  // sessions were handed the SAME `/tmp/acpx-<harness>-session`, and the directory
  // written at CREATE was not the one a RESUMED adapter read.
  //
  // A fallback that silently de-isolates is worse than an error, so there is no
  // fallback here at all. The caller mints a unique id; if a future one ever
  // passes blank again, this refuses loudly instead of quietly sharing a dir.
  if (!input.sessionId.trim()) {
    process.stderr.write(
      `[acpx] refusing to create a ${harness} config dir with a blank session id — ` +
        `a shared directory would de-isolate concurrent sessions. No primer/model pin applied.\n`,
    );
    return undefined;
  }
  try {
    // Same resolver the SWEEP uses, so the writer and its reaper cannot disagree
    // about where the directory is (`harness-config-dir-root.ts`).
    const root = resolveHarnessConfigDirRoot(input.rootDir);
    const dir = join(root, configDirName(harness, input.sessionId.trim()));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // ⚠️ REGISTER THIS HOLDER BEFORE WRITING ANYTHING. Between mkdir and the
    // marker there is a window in which another client's close would see no
    // holders and remove the directory underneath this one. Narrowing it to two
    // syscalls is what makes the refcount worth having.
    const holderId = registerConfigDirHolder(dir);
    const plan = writePiConfigDir(dir, input);
    return { ...plan, holderId };
  } catch (error) {
    process.stderr.write(
      `[acpx] could not create the ${harness} config dir; continuing without primer/model pin: ` +
        `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return undefined;
  }
}

/**
 * Pi (I2 R9).
 *
 * Through acpx/pi-acp only the `PI_CODING_AGENT_DIR` paths survive: pi-acp
 * passes no system-prompt flag and offers no ACP channel for one, so
 * `--append-system-prompt` is unreachable from here however well it works
 * natively.
 *
 * ⚠️ **KNOWN UN-ISOLATABLE LEAK, RECORDED RATHER THAN FOUGHT.** `pi-acp` writes
 * its session map to a **hardcoded** `~/.pi/pi-acp/session-map.json`, ignoring
 * `PI_CODING_AGENT_DIR` entirely. It follows `HOME`, so a per-session config dir
 * does not contain it. Nothing here can fix that — it is the adapter's path, not
 * ours — and pretending otherwise would be worse than saying so.
 */
function writePiConfigDir(dir: string, input: HarnessConfigDirInput): HarnessConfigDirPlan {
  const files: string[] = [];
  if (input.primer) {
    // I2 R9 measured this end-to-end: the marker was in turn 1's request body
    // AND survived a SIGKILL of both pi and pi-acp followed by a resume.
    const appendSystemPath = join(dir, "APPEND_SYSTEM.md");
    writeFileSync(appendSystemPath, input.primer, { mode: 0o600 });
    files.push(appendSystemPath);
  }
  // ⚠️ WRITING `models-store.json` HERE IS SAFE, AND THE COMMENT THAT STOOD HERE
  // SAYING OTHERWISE WAS WRONG. It read: *"What is NOT established is whether a
  // file in `PI_CODING_AGENT_DIR` merges with or REPLACES the bundled catalogue…
  // if the semantics are REPLACE, writing one entry here silently removes the
  // other ~370 models from every Pi session."* Measured 2026-09-04 against pi
  // 0.84.4 (brick ef5999ca, B5): **it MERGES, by id.**
  //
  //   `mergeModels(baseline, dynamic)` — `dist/core/remote-catalog-provider.js:7-16`
  //   — walks the stored entry and REPLACES a same-id model or APPENDS a new one.
  //   Planting a one-entry file took the offered catalogue from 333 models to
  //   **334**, with the planted slug offered, a pre-existing slug still offered,
  //   and 333 again after restore.
  //
  // ⚠️ THE REAL HAZARD IS THE OPPOSITE ONE, AND IT IS SILENT: an entry is IGNORED
  // unless the provider block carries a `lastModified` GREATER than the bundled
  // catalogue's generation stamp — `remoteModels()` returns `[]` when it is
  // absent (`remote-catalog-provider.js:31-38`). A well-formed entry without it
  // changes nothing at all, with no error anywhere; measured 333 → 333, slug not
  // offered. That is why the stamp below is `Date.now()` and not optional.
  //
  // ⚠️ THE SECOND TRAP, ALSO MEASURED: pi's own catalogue ships
  // `https://openrouter.ai/api` (NO `/v1`) for all 15 `anthropic-messages`
  // entries, so an Anthropic model's request goes out on the openai-completions
  // route, which appends `/chat/completions` → `POST /api/chat/completions` →
  // 404 (I2 R6, root-caused at the wire). Every entry generated here therefore
  // carries `https://openrouter.ai/api/v1`, and because the merge is BY ID this
  // also repairs a bundled entry rather than merely adding new ones.
  //
  // ⚠️ BUT `models-store.json` IS PI'S OWN CACHE, AND PI OVERWRITES IT — which is
  // why the durable copy of both facts goes in `models.json`. See
  // {@link writePiModelProvisioning}.
  //
  // ⚠️ AND THIS IS NO LONGER GATED ON `provisionModelId`. The Anthropic repair was
  // never *about* provisioning — it rode along inside the provisioning write
  // because that is where the file happened to be produced. Gating it there left
  // it missing in the default case: a session created without `--model` can still
  // `session/set_model` onto any of pi's 15 broken `anthropic-messages` rows.
  // Measured 2026-09-08 on such a dir (`APPEND_SYSTEM.md` + `settings.json` only):
  // the refresh landed 15 broken rows, `set_model` reported success, and the turn
  // came back with `content: []` — no answer, no usable error.
  writePiModelProvisioning(
    dir,
    input.env,
    input.provisionModelId ? stripProviderPrefix(input.provisionModelId) : undefined,
    files,
  );
  writePiStallPolicy(dir, files);
  // ⚠️ KEEP pi's SESSION STORE WHERE IT WAS — read BEFORE the re-point below,
  // which is the last moment the box's own agent dir is still reachable through
  // the variable we are about to overwrite (brick ac86eb34; same ordering as the
  // F-13 discard warning).
  const sessionDir = resolvePiSessionDir(input.env, input.cwd);
  input.env.PI_CODING_AGENT_DIR = dir;
  const envNames = ["PI_CODING_AGENT_DIR"];
  if (sessionDir) {
    input.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
    envNames.push("PI_CODING_AGENT_SESSION_DIR");
  }
  return { harness: "pi", dir, envNames, files };
}

/**
 * pi's HTTP idle bound for acpx-PROVISIONED sessions, in ms. See
 * {@link writePiStallPolicy}.
 *
 * 🛑 **INTERIM (brick 5aacdba2) — 120 000 WAS CUTTING DANIEL'S HEALTHY TURNS.**
 * Measured from his session `01a0827e`'s own `timestamps.ndjson`
 * (`openrouter/qwen/qwen3.8-flash`, 2026-09-08): four stream gaps of
 * **119.98 / 119.90 / 120.07 / 120.07 s** — all within 0.1 s of 120.000, with
 * ~85 KB of real streaming in between, one burst of 48 KB in 7.66 s. **A flaky
 * provider gives 8 s, 47 s, 200 s; it does not give 120.0 s four times.** The
 * timer was ours, and two of us told him it was the model before anyone measured
 * the gaps.
 *
 * 300 000 is pi's own default, so a first token up to 300 s is no longer cut.
 */
const PI_HTTP_IDLE_TIMEOUT_MS = 300_000;

/**
 * pi retries a failed turn `maxRetries` times, so ATTEMPTS = 1 + this.
 *
 * 🛑 **`0` IS AN INTERIM STOPGAP WITH AN EXPIRY, NOT A DECISION — AND IT SPENDS
 * THE LAST RETRY (brick 5aacdba2).** `maxRetries` governs **every** transient
 * failure (rate limits, 5xx, network blips), not just idle stalls. Brick
 * `3437c6b5` already cut pi's default of 3 to 1, and warned in this very comment
 * that doing so **spends resilience against a different failure class**. Going to
 * `0` spends the rest. It is acceptable **only** because it is temporary and
 * because a retry against a *stall* mostly bought another full window of silence
 * rather than a different outcome — it never helped the case it was paying for.
 *
 * ⚠️ **`0` IS VALID AND MEANS EXACTLY ONE ATTEMPT — MEASURED, NOT ASSUMED.**
 * pi reads it as `this.settings.retry?.maxRetries ?? 3`
 * (`core/settings-manager.js:595`), and `??` preserves `0` where `||` would have
 * silently restored `3`. Both attempt guards agree (`agent-session.js:431`
 * `_retryAttempt >= maxRetries`, `:2285` `> maxRetries`). Confirmed on the wire
 * against a black-hole server that accepts and sends nothing, `idle` 5 000:
 *
 * ```
 *   maxRetries 0 -> 1 attempt      maxRetries 1 -> 2      maxRetries 3 -> 4
 *   inter-attempt gaps for 3: 7 015 / 9 006 / 13 011 ms = idle + 2 000·2^n
 * ```
 *
 * ⇒ **THE WORST-CASE FORMULA BELOW IS CONFIRMED AGAINST THAT MEASUREMENT**, not
 * merely restated: at `idle` 5 000 × 4 attempts it predicts 34 000 ms and the
 * final attempt failed at ~34 032 ms.
 *
 * 🛑 **WHAT THIS INTERIM DOES *NOT* FIX, so nobody reads it as the fix:** it does
 * not bound a stall that keeps emitting SSE keepalives (those are bytes, so this
 * bound is inert at ANY value — see {@link writePiStallPolicy}), and it does not
 * bound the **mid-stream** cut Daniel also hit. Both need the no-progress
 * deadline in acpx's own code — 5aacdba2. **When that lands, restore pi's own
 * 300 000 × 4 here and delete this note.**
 *
 * ⇒ **When a turn deadline lands in acpx's own code, this should go back up.**
 */
const PI_TURN_MAX_RETRIES = 0;

/**
 * Bound how long an acpx-provisioned pi session sits in dead air when the
 * provider stalls (brick 3437c6b5, from Daniel's *"the second message was not
 * answered"*).
 *
 * ## What actually happened, and why this is a policy choice and not a fix
 *
 * The request was ACCEPTED and delivered **zero bytes**. Nothing here makes it
 * return. What we choose is how long the user waits for the error: pi's defaults
 * are `httpIdleTimeoutMs` 300 000 × 4 attempts with 2/4/8 s backoff —
 * **20 m 14 s**, against the **20 m 15 s** actually observed.
 *
 * ## The arithmetic, so a future change to either number stays honest
 *
 * `agent-session.js:2279-2291` (`_prepareRetry`): `_retryAttempt++`, stop once it
 * exceeds `retry.maxRetries`, `delayMs = baseDelayMs · 2^(n-1)`. So:
 *
 * ```
 * worst case ≈ idleMs × (1 + maxRetries) + baseDelayMs × (2^maxRetries − 1)
 * ```
 *
 * **Confirmed on the wire, not just restated** (brick 5aacdba2): against a
 * black-hole server at `idle` 5 000, attempts were 1 / 2 / 4 for `maxRetries`
 * 0 / 1 / 3, inter-attempt gaps `idle + 2 000·2^n` (7 015 / 9 006 / 13 011 ms),
 * and the 4-attempt arm's final failure landed at ~34 032 ms against the
 * formula's 34 000.
 *
 * **The three configurations this brick weighed, all from the formula above:**
 *
 * ```
 *   idle × attempts (retries)   covers a first token to   worst case
 *   120 000 × 2   (1)                    120 s             4 m 02 s   ← cut Daniel's healthy turns
 *   300 000 × 1   (0)                    300 s             5 m 00 s   ← CURRENT (interim)
 *   300 000 × 4   (3)                    300 s            20 m 14 s   ← pi's default; the original 20-min hang
 * ```
 *
 * The interim takes the middle row: it covers a first token to 300 s instead of
 * 120 s **and still lands inside the ≤ ~5 min target**, which the 120 000 row only
 * met by cutting healthy requests. It buys that with the last retry — see
 * {@link PI_TURN_MAX_RETRIES}.
 *
 * ⚠️ **The ruling's own wording — "idle ~120 s × 2 retries" — is 3 attempts and
 * 6 m 06 s, i.e. OVER the target it sets.** Kept on the page because it is the
 * ruling's text, not because it was ever implemented.
 *
 * 🛑 **AND THIS FORMULA STOPS GOVERNING THE USER'S WAIT once the no-progress
 * deadline lands in acpx (5aacdba2): acpx will cut first, so `idle × attempts`
 * will bound pi's retry budget and NOT the wall clock.** Retire this block then
 * rather than leaving two competing formulas on the page.
 *
 * ## 🛑 WHAT THIS DOES NOT BUY — and it is half the failure space
 *
 * **`httpIdleTimeoutMs` is undici's `bodyTimeout`/`headersTimeout`, a per-byte
 * INACTIVITY timer — and an SSE comment keepalive is bytes.** Measured twice
 * against pi 0.84.4's own `configureHttpDispatcher` at a 10 s bound
 * (evidence: brick 3437c6b5 `verification/evidence/keepalive-idle-bound-run2.log`):
 *
 *   - headers then **zero bytes** → fires at **10 506 ms**. ← the incident's shape
 *   - `: OPENROUTER PROCESSING` every 5 s → **NEVER FIRES** (45 s cap, 8 chunks)
 *   - keepalives for 20 s **then silence** → fires at **25 537 ms** = last byte + the bound
 *
 * ⇒ against a stall that keeps emitting keepalives **this bound is inert, at any
 * value**: above the keepalive interval it never fires, and below it the bound
 * also cuts genuinely slow-first-token requests, which is exactly what those
 * keepalives exist to prevent. **A shape mismatch, not a wrong number.**
 *
 * ⚠️ **And there is no second line of defence to fall back on.** pi's other
 * timeout (`sdk.js:187-196` → `openai-completions.js:210` → the OpenAI SDK's
 * `requestOptions.timeout`) is cleared in a `finally` the moment `fetch()`
 * resolves — **which for a stream is when HEADERS arrive, before one body byte is
 * read** (`openai` 6.40.0 `client.js:489-513`). It bounds response
 * ESTABLISHMENT only. **pi 0.84.4 has no total-turn deadline of any kind.**
 *
 * ⇒ **Bounding the keepalive-emitting mode needs a turn deadline in OUR code, and
 * is deliberately NOT attempted here.** Anyone reading this as "pi stalls now
 * surface in five minutes" is wrong for the half of the space that keeps talking.
 *
 * ## Why a partial settings object is the correct shape
 *
 * This dir IS the session's agent dir (`PI_CODING_AGENT_DIR` is re-pointed
 * below), so `<dir>/settings.json` is the only global settings file the session
 * ever reads — the box's own `~/.pi/agent/settings.json` is already out of scope
 * for the same reason, with or without this file. Every key pi does not find here
 * falls back to its own default (`retry.enabled ?? true`,
 * `retry.baseDelayMs ?? 2000`), so naming only what we are changing is right.
 * **pi's defaults for direct users are untouched: this file exists only inside a
 * per-session dir acpx creates and removes.**
 *
 * ⚠️ `parseTimeoutSetting` THROWS on a value it cannot parse rather than falling
 * back — a malformed number here is a hard startup error, not a silent default.
 * Keep these plain integers.
 */
function writePiStallPolicy(dir: string, files: string[]): void {
  const settingsPath = join(dir, "settings.json");
  writeFileSync(
    settingsPath,
    `${JSON.stringify(
      {
        httpIdleTimeoutMs: PI_HTTP_IDLE_TIMEOUT_MS,
        retry: { maxRetries: PI_TURN_MAX_RETRIES },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  files.push(settingsPath);
}

/**
 * Make an arbitrary OpenRouter slug resolve under pi, and repair pi's broken
 * Anthropic base URLs — in a way a catalogue refresh cannot undo.
 *
 * ## 🛑 TWO FILES, AND THE SECOND ONE IS WHAT MAKES EITHER GUARANTEE HOLD (brick 626f56f5)
 *
 * `models-store.json` is **pi's own cache of its remote catalogue, and pi
 * OVERWRITES IT.** `FileModelsStore.write` (`dist/core/models-store.js:92-102`)
 * assigns `current["openrouter"] = entry`, so a refresh REPLACES the whole
 * provider block — provisioned slug and Anthropic repair with it. The `checkedAt`
 * stamp below suppresses that refresh for 4 h
 * (`REMOTE_CATALOG_REFRESH_INTERVAL_MS`, `remote-catalog-provider.js:6,58-63`)
 * and no longer than 4 h.
 *
 * **Measured live on pi 0.84.4, one process, paired arms, `checkedAt` aged 5 h**
 * (brick 626f56f5 `verification/`). Both arms took a real refresh — the store
 * went 1 → 363 models and gained pi.dev's own etag — and then:
 *
 * ```
 *                             store-only (before)      + models.json (after)
 *   broken anthropic entries          15                        0
 *   provisioned entry            REVERTED to pi.dev's      preserved
 *                                (baseUrl lost /v1,
 *                                 ctx 200k → 1M)
 * ```
 *
 * `models.json` is pi's **user config**, which pi only ever READS
 * (`ModelConfig.load`, `model-config.js:212`) — nothing in pi writes it. And
 * `composeModelProvider().getModels()` re-runs
 * `applyModelsJson(providerId, base.getModels(), config)` **on every call**
 * (`provider-composer.js`), while a refresh only mutates `dynamicModels` inside
 * `withRemoteCatalog`. So this layer is re-applied on top of whatever the refresh
 * produced. **That is why the guarantee is structural and not a race we won.**
 *
 * ⚠️ **THE BRICK'S OWN FRAMING — "mid-session, at the 4 h mark" — IS WRONG, AND
 * THE CORRECTION IS WHERE THE NEXT READER SHOULD LOOK.** In pi's RPC mode (the
 * only mode pi-acp uses) the catalogue refresh is a **one-shot fired at pi
 * PROCESS STARTUP** — `main.js:739-746`, comment *"RPC refreshes catalogs here in
 * the background"*; grepped, there is no periodic timer and no RPC verb that
 * refreshes. So nothing fires 4 h into a running process. What the expiry
 * actually decides is whether the **next pi process** clobbers the block: a stamp
 * older than 4 h at startup, and it does — in seconds, which is how the arms
 * above reproduced it without waiting.
 *
 * ⇒ **NEVER move either fact back into `models-store.json` alone.** It reads like
 * a simplification (one file, one merge) and it is the defect: pi owns that file.
 *
 * ## The measurements the store side is built on (pi 0.84.4, brick ef5999ca)
 *
 * **It MERGES, by id.** `mergeModels(baseline, dynamic)`
 * (`dist/core/remote-catalog-provider.js:7-16`) replaces a same-id model and
 * appends a new one. Measured: a one-entry file took the offered catalogue from
 * 333 models to 334, the planted slug was offered, a pre-existing slug still
 * resolved, and 333 came back after restore. The standing comment that said this
 * might REPLACE the catalogue — and kept the capability switched off — was wrong.
 *
 * **But an entry is IGNORED without a fresh `lastModified`.** `remoteModels()`
 * (`:31-38`) returns `[]` when the provider block's `lastModified` is absent or
 * not newer than the bundled stamp. A well-formed entry without it changes
 * nothing, with no error anywhere: measured 333 → 333, slug not offered.
 *
 * ## ⚠️ WHY THE BOX'S OWN CATALOGUE IS COPIED FORWARD RATHER THAN REPLACED
 *
 * Writing ONLY the requested slug is what a naive "generate a fragment" does, and
 * it costs the session every model pi had cached: measured 374 offered → 334,
 * because the per-session file REPLACES the box's remote-overlay block (the
 * bundled 333 survive; the ~41 overlay-only models do not). Worse, if the slug is
 * one the catalogue ALREADY has, the generated entry replaces a real one with
 * guessed metadata — no `thinkingLevelMap` (so the depth ladder silently becomes
 * wrong), a made-up context window, zero costs.
 *
 * So the box's overlay is read first and the slug is UPSERTED into it. A slug the
 * catalogue already carries keeps its real metadata; only a genuinely new one gets
 * a generic entry.
 *
 * ## The Anthropic repair rides along
 *
 * All 15 `anthropic-messages` entries ship `https://openrouter.ai/api` — no `/v1`
 * — so the request goes out on the openai-completions route, which appends
 * `/chat/completions` → `POST /api/chat/completions` → 404 (I2 R6, at the wire).
 * Re-measured at the source: `GET https://pi.dev/api/models/providers/openrouter`
 * still serves 15 such entries. Because the merge is by id, patching them in the
 * copied overlay repairs them for the session rather than merely adding new ones.
 *
 * ⚠️ **AND ON THIS FLEET THAT COPY REPAIRS NOTHING, WHICH IS THE SECOND REASON
 * THE `models.json` LAYER EXISTS.** The 15 broken entries are **not bundled** —
 * measured 2026-09-08, pi's bundled 333 openrouter models are *all*
 * `openai-completions` on the correct `…/api/v1`, and the broken
 * `anthropic-messages` rows arrive only with the remote refresh. So a repair
 * applied to the box's overlay copy can only fix entries the box already cached,
 * and every dev box's overlay is empty (`~/.pi/agent/models-store.json` is `{}`).
 * The provider-level `baseUrl` in `models.json` repairs rows acpx has never seen,
 * including any future broken one, without touching their other metadata.
 */
/**
 * pi's own catalogue ships `https://openrouter.ai/api` — no `/v1` — for all 15
 * `anthropic-messages` entries, so the request goes out on the openai-completions
 * route and 404s. The merge is BY ID, so patching the copied entry REPAIRS the
 * bundled one rather than adding a second.
 */
function repairAnthropicBaseUrls(models: PiCatalogueModel[]): void {
  for (const model of models) {
    if (model.api === "anthropic-messages" && model.baseUrl === OPENROUTER_API_BASE_NO_V1) {
      model.baseUrl = OPENROUTER_API_BASE;
    }
  }
}

/**
 * ⚠️ `piKnown === null` means **"could not establish"**, and it must fall through
 * to `false` — "we do not know that pi knows it" — never to `true`. Reading a
 * failure to ask as "pi knows it" would suppress the entry and leave an arbitrary
 * slug unresolvable; reading it as "pi knows nothing" is the safe direction and
 * the one taken here.
 */
function piAlreadyKnows(
  models: PiCatalogueModel[],
  modelId: string,
  piKnown: Set<string> | null,
): boolean {
  if (models.some((model) => model.id === modelId)) {
    return true;
  }
  return piKnown?.has(modelId) ?? false;
}

function writePiModelProvisioning(
  dir: string,
  env: NodeJS.ProcessEnv,
  /** `undefined` ⇒ the session named no model. There is nothing to provision, but
   *  the repair is still written; see the call site. */
  modelId: string | undefined,
  files: string[],
): void {
  if (modelId === undefined) {
    // Return BEFORE `readPiAdvertisedModelIds`, which is a ~539 ms `spawnSync` on
    // a cold cache. A session that named no model must not pay it to learn that
    // it has nothing to look up.
    writePiModelsConfig(dir, undefined, files);
    return;
  }
  // The box's catalogue is parsed fresh from disk on every call, so mutating the
  // entries here cannot reach anything else.
  const boxModels = readBoxPiOpenRouterModels(env);
  repairAnthropicBaseUrls(boxModels);

  // ⚠️ THE GUARD ASKS ABOUT **PI'S** KNOWLEDGE, NOT THE OVERLAY'S (brick 6253611b).
  // The overlay alone was the wrong question: 333 of the 374 models pi advertises
  // are BUNDLED, and on every dev box the overlay file does not exist at all — so
  // the "a slug the catalogue already carries needs nothing" protection below was
  // unreachable for EVERY model, and each session replaced pi's real entry with a
  // fabricated one. `readPiAdvertisedModelIds` returns `null` when pi could not be
  // asked, which must NOT be read as "pi knows nothing".
  const alreadyKnown = piAlreadyKnows(boxModels, modelId, readPiAdvertisedModelIds(env));

  // ⚠️ ONE QUESTION, ASKED ONCE, ANSWERED FOR BOTH FILES — the two writers must
  // not be able to disagree. A slug pi already knows gets NO fabricated entry in
  // EITHER file, and the reason is the same on both sides: pi rebuilds a
  // `models.json` model from the definition alone (`modelFromJson` inherits only
  // `api` and `baseUrl` from the existing row, so `thinkingLevelMap` becomes
  // `undefined`, `cost` becomes zeros and `contextWindow` becomes 128 000), just
  // as a same-id store entry replaces pi's real row. `undefined` here therefore
  // means "pi has a better entry than anything acpx could write".
  const provisioned = alreadyKnown ? undefined : buildPiCatalogueEntry(modelId, env);

  writePiModelsConfig(dir, provisioned, files);
  writePiModelsStore(dir, boxModels, provisioned, files);
}

/**
 * pi's `models.json` — the layer a catalogue refresh cannot reach. See
 * {@link writePiModelProvisioning} for the measurement and for why it exists.
 *
 * ## Why the Anthropic repair is PROVIDER-level and not per model
 *
 * `models.json` has exactly one lever that can change a `baseUrl`:
 * `providers.<id>.baseUrl`, which `applyModelsJson` maps over **every** model of
 * that provider (`provider-composer.js`: `baseUrl: config.baseUrl ?? model.baseUrl`).
 * The per-model alternative, `modelOverrides`, **cannot express `baseUrl` at all**
 * — `applyModelOverride` copies `name`, `reasoning`, `thinkingLevelMap`, `input`,
 * `cost`, `contextWindow`, `maxTokens`, `samplingParams` and `compat`, and no
 * more. The only other route is a full `models[]` definition per broken id, which
 * would replace those 15 real rows with fabricated ones — trading the routing bug
 * for the metadata bug brick 6253611b just removed.
 *
 * A blanket provider `baseUrl` is therefore both the only metadata-preserving
 * option and the strictly more useful one: it repairs ids acpx has never heard of.
 *
 * ⚠️ **AND IT IS SAFE ONLY BECAUSE EVERY OTHER OPENROUTER ROW ALREADY CARRIES
 * THIS EXACT VALUE. RE-MEASURE WHEN THE PINNED pi VERSION MOVES.** Measured
 * 2026-09-08 against pi 0.84.4's live catalogue: of 379 openrouter models, 364
 * carry `https://openrouter.ai/api/v1` and the 15 `anthropic-messages` rows carry
 * `https://openrouter.ai/api`. There is no third value, so the override is a
 * no-op everywhere it is not a repair. Should pi ever serve an openrouter model
 * on some other base URL, this line would rewrite it — the one axis on which this
 * fix can regress, and the reason `PI_OPENROUTER_BASE_URL_HISTOGRAM` in
 * `test/pi-models-store.test.ts` pins the measured shape rather than a comment.
 *
 * ⚠️ **A SCHEMA MISTAKE HERE FAILS SILENTLY-ISH: `ModelConfig.load` returns an
 * ERROR OBJECT and pi composes with an EMPTY config** — no repair, no slug, and
 * the only surface is pi's `getError()`. So keep this file minimal and keep the
 * shape pinned by tests; do not grow it speculatively.
 */
function writePiModelsConfig(
  dir: string,
  provisioned: PiCatalogueModel | undefined,
  files: string[],
): void {
  const openrouter: { baseUrl: string; models?: PiCatalogueModel[] } = {
    baseUrl: OPENROUTER_API_BASE,
  };
  if (provisioned) {
    openrouter.models = [piModelDefinition(provisioned)];
  }
  const configPath = join(dir, "models.json");
  writeFileSync(configPath, `${JSON.stringify({ providers: { openrouter } }, null, 2)}\n`, {
    mode: 0o600,
  });
  files.push(configPath);
}

/**
 * The same entry, as a `models.json` model DEFINITION.
 *
 * `provider` is not a field of pi's `ModelDefinitionSchema` — pi sets it from the
 * provider block's key — so it is dropped rather than passed through. The shape
 * that was measured working live is the one without it; whether pi's typebox
 * object would also tolerate the extra key was not established, and guessing is
 * how a well-formed file becomes an empty config (above).
 */
function piModelDefinition(entry: PiCatalogueModel): PiCatalogueModel {
  const definition = { ...entry };
  delete definition.provider;
  return definition;
}

function writePiModelsStore(
  dir: string,
  boxModels: PiCatalogueModel[],
  provisioned: PiCatalogueModel | undefined,
  files: string[],
): void {
  // Nothing to add AND nothing to repair ⇒ write no file at all. A store we do
  // not write cannot displace pi's block, so the model keeps its real price, its
  // real context window and its `thinkingLevelMap`, and the session keeps the
  // models the overlay would have displaced.
  if (!provisioned && boxModels.length === 0) {
    return;
  }

  const models = provisioned ? [...boxModels, provisioned] : boxModels;
  const now = Date.now();
  const storePath = join(dir, "models-store.json");
  writeFileSync(
    storePath,
    `${JSON.stringify({ openrouter: { lastModified: now, checkedAt: now, models } }, null, 2)}\n`,
    { mode: 0o600 },
  );
  files.push(storePath);
}

const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";
const OPENROUTER_API_BASE_NO_V1 = "https://openrouter.ai/api";

/** pi's fallbacks for a model whose real values acpx does not know. Named so the
 *  two "we are guessing" sites are visible instead of buried in a literal. */
const PI_FALLBACK_CONTEXT_WINDOW = 128_000;
const PI_FALLBACK_MAX_TOKENS = 16_384;

/** pi's per-1M rate block. Required by pi even when unknown — see the note on
 *  {@link buildPiCatalogueEntry}. */
type PiEntryCost = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** pi's rates are USD per 1M tokens — the same unit `ModelBilling` states. A rate
 *  acpx does not know becomes 0 ONLY because pi cannot represent "unknown"; see
 *  the note on {@link buildPiCatalogueEntry}. */
const piRate = (value: number | null | undefined): number => value ?? 0;

function piCostFrom(billing: ModelBilling | undefined): PiEntryCost {
  return {
    input: piRate(billing?.inPerM),
    output: piRate(billing?.outPerM),
    cacheRead: piRate(billing?.cacheReadPerM),
    cacheWrite: piRate(billing?.cacheWritePerM),
  };
}

/**
 * The catalogue entry for a model pi genuinely does not know — built from
 * **acpx's own OpenRouter cache**, keyed by the determining id, never composed
 * (brick 6253611b).
 *
 * ## 🛑 WHY A ZERO `cost` BLOCK IS WRITTEN FOR AN UNPRICEABLE MODEL
 *
 * The honest-looking move — omit `cost` when no price is known — **crashes pi on
 * the first turn.** Measured 2026-09-07 by calling pi's own exported
 * `calculateCost` (pi 0.84.4): with a priced model it returns `0.00123861`; with
 * `cost` absent it throws **`TypeError: Cannot read properties of undefined
 * (reading 'tiers')`**, because the `?? []` there guards a missing `tiers`, not a
 * missing `cost`. pi's schema marks `cost` OPTIONAL, so such an entry **validates
 * in and is then dereferenced** — it would pass every schema-shaped check and
 * fail at runtime, on the rarest path.
 *
 * **pi has no representation for "unknown", so the zero is an internal necessity
 * of pi's data model — NOT a claim.** The fact that the price is unknown is
 * carried in acpx's own provenance field (`src/models/cost-provenance.ts`) and is
 * what any human-facing surface renders. **A zero must never be PRESENTED as a
 * cost; that is the defect this brick removes, and re-introducing it one level up
 * by suppressing the block would trade a wrong number for a broken session.**
 *
 * ## `reasoning` IS READ FROM THE ROW; `thinkingLevelMap` IS DELIBERATELY ABSENT
 *
 * These two look like one decision and are not (brick 98ed1041). pi derives the
 * whole thinking ladder from this entry, so both fields set a user-visible depth
 * control, but they are known to VERY different confidence:
 *
 *  - **`reasoning` was hard-coded `true`, which is not a measurement at all** —
 *    it is the same class of frozen constant as the deleted `PI_WIRE_DEPTH_LADDER`,
 *    one field over. pi's rule is `reasoning === false ⇒ the ladder is `["off"]``,
 *    so a hard `true` advertises five thinking rungs on a model that cannot think.
 *    Measured 2026-09-08: of the **66** acpx slugs pi does not know (426 vs 363),
 *    **44** have no `reasoning` block in acpx's own OpenRouter cache. Checked
 *    against the 360 models BOTH catalogues carry, "acpx has a `reasoning` block"
 *    agrees with pi's own flag **352/360**.
 *    ⚠️ Downgraded ONLY on a row acpx actually has. All four disagreements in the
 *    strip-direction are router pseudo-models (`openrouter/auto`, `auto-beta`,
 *    `free`, `fusion`) — no fixed underlying model, so acpx legitimately carries
 *    no `reasoning` while pi says `true`. Reading a MISSING ROW as "does not
 *    reason" would strip every rung from exactly those.
 *
 *  - **`thinkingLevelMap` is NOT derived, and that is a decision, not an
 *    omission.** It could be: acpx's cache carries `reasoning.supported_efforts`,
 *    and the derivation reproduces pi's own map for `~google/gemini-flash-latest`
 *    exactly. But measured across every model both catalogues carry, it agrees on
 *    only **142 of 151** — and the population it would actually serve is **6
 *    models**, the only slugs among those 66 that carry `supported_efforts` at
 *    all. ⇒ a table that is wrong ~6% of the time where it CAN be checked, applied
 *    to six models where it CANNOT, carrying acpx's confidence. That is the trade
 *    5000f0bb exists to refuse: *a gap is a gap; an invented value is a lie that
 *    reads like a measurement.* Without a map pi applies its own no-map default
 *    (every level but `xhigh`), which is pi's behaviour rather than acpx's guess.
 *
 * ⚠️ **DO NOT "FINISH THE JOB" BY DERIVING THE MAP HERE.** It looks like the
 * obvious completion of the line above it and it is the bug. If it is ever worth
 * doing, the honest form is to carry the derivation's PROVENANCE to the surface
 * that renders the control, not to write a guess into pi's catalogue where it is
 * indistinguishable from the model's own declaration.
 */
function buildPiCatalogueEntry(modelId: string, env: NodeJS.ProcessEnv): PiCatalogueModel {
  const priced = lookupOpenRouterPricing(modelId, env);
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    baseUrl: OPENROUTER_API_BASE,
    provider: "openrouter",
    // `priced === null` ⇒ acpx has no row and therefore no opinion; keep pi's
    // optimistic default rather than reading absence as a negative.
    reasoning: priced ? priced.reasons : true,
    input: ["text"],
    cost: piCostFrom(priced?.billing),
    contextWindow: priced?.contextLength ?? PI_FALLBACK_CONTEXT_WINDOW,
    maxTokens: priced?.maxTokens ?? PI_FALLBACK_MAX_TOKENS,
  };
}

/**
 * The model's row in acpx's OpenRouter cache. Synchronous and network-free by
 * construction: this runs on the session-spawn path, where a fetch would put a
 * network hop in front of every session create.
 */
function lookupOpenRouterPricing(
  modelId: string,
  env: NodeJS.ProcessEnv,
): {
  billing: ModelBilling;
  contextLength: number | null;
  maxTokens: number | null;
  reasons: boolean;
} | null {
  // The SCOPED env, not the process's: see defaultCatalogueCachePath (brick ff298f02).
  const snapshot = readOpenRouterCacheSync(defaultCatalogueCachePath(env));
  const row = snapshot?.models.find((model) => model.id === modelId);
  if (!row) {
    return null;
  }
  const billing = deriveBilling(row);
  return {
    billing,
    contextLength: typeof row.context_length === "number" ? row.context_length : null,
    // The OUTPUT cap, which is a different number from the context window — for
    // `qwen/qwen3.8-flash` they are 131,072 and 1,000,000, and pi's own bundled
    // entry agrees exactly. Using `context_length` for both would hand pi a
    // nonsensical completion bound.
    maxTokens:
      typeof row.top_provider?.max_completion_tokens === "number"
        ? row.top_provider.max_completion_tokens
        : null,
    // ⚠️ ONLY MEANINGFUL BECAUSE THE ROW EXISTS. A `null` return above means acpx
    // has no row at all and therefore no opinion — the caller must keep pi's
    // optimistic default, not read absence as "does not reason". See the note on
    // {@link buildPiCatalogueEntry}.
    reasons: (row as { reasoning?: unknown }).reasoning != null,
  };
}

type PiCatalogueModel = {
  id?: string;
  api?: string;
  baseUrl?: string;
  [key: string]: unknown;
};

/**
 * pi's cached OpenRouter catalogue from the BOX agent dir — read before the
 * re-point, like the session store and the F-13 discard warning.
 *
 * An empty result is a legitimate state (pi has never run on this box), not an
 * error: the bundled catalogue still resolves, so the session simply gets the
 * provisioned slug on top of it.
 */
function readBoxPiOpenRouterModels(env: NodeJS.ProcessEnv): PiCatalogueModel[] {
  const boxAgentDir = env.PI_CODING_AGENT_DIR?.trim()
    ? env.PI_CODING_AGENT_DIR.trim()
    : join(env.HOME?.trim() || homedir(), ".pi", "agent");
  try {
    const parsed = JSON.parse(readFileSync(join(boxAgentDir, "models-store.json"), "utf8")) as {
      openrouter?: { models?: unknown };
    };
    const models = parsed.openrouter?.models;
    return Array.isArray(models) ? (models as PiCatalogueModel[]) : [];
  } catch {
    return [];
  }
}

/**
 * Where pi's session JSONL should go once acpx has moved pi's agent dir
 * (brick ac86eb34).
 *
 * ## The defect
 *
 * `PI_CODING_AGENT_DIR` is pi's **data** dir as well as its config dir, so
 * re-pointing it for the primer took the session store with it. The JSONL was
 * still written — measured, so do NOT record this as "pi stopped writing" — but
 * into the throwaway per-session directory, which is removed at close. **pi's
 * per-message JSONL is IR-3's SECOND authority for pi**, so every pi served-model
 * claim was left resting on one leg.
 *
 * ## ⚠️ WHY THE OBVIOUS FIX IS WRONG, AND IT WOULD HAVE PASSED A PATH CHECK
 *
 * pi honours `PI_CODING_AGENT_SESSION_DIR` (`main.js:530`; precedence
 * `--session-dir` > env > `settings.json.sessionDir`) — but it treats it as the
 * **FINAL directory**, not as a root under which it appends `--<cwd>--`.
 * Measured with real turns: pointed at a store ROOT, pi writes the JSONL **FLAT**
 * into it. IR-3 reads at `<store>/sessions/--<cwd-with-slashes-as-dashes>--/`, so
 * the root form leaves the authority just as dead while making the directory look
 * correct.
 *
 * So the variable is pointed at the **cwd-mangled subdirectory** — the exact path
 * an un-overridden pi would have used.
 *
 * ⚠️ **THE MANGLING IS A VERSION-PINNED MEASUREMENT, NOT A PROPERTY.** It is read
 * from `@earendil-works/pi-agent-core` (bundled with pi-coding-agent **0.84.4**),
 * `dist/harness/session/jsonl/repo.js:13-15`. Same class of fact as the
 * `session/set_model` capability cell that was TRUE and WENT STALE, and as
 * `piWireDepthValue`'s ladder. **RE-MEASURE TRIGGER: when the pinned pi version
 * moves** — re-read `jsonlSessionDirectoryName` and confirm this still matches.
 *
 * ⚠️ **AND THE DIRECTORY MUST EXIST BEFORE pi STARTS.** Measured: with the
 * variable naming a missing directory, pi **HANGS** — rc=124 on a 150 s timeout,
 * **empty stdout AND empty stderr**, no error of any kind. A missing `mkdir` here
 * does not degrade, it wedges the session, and it looks exactly like a slow model.
 */
function resolvePiSessionDir(env: NodeJS.ProcessEnv, cwd: string | undefined): string | undefined {
  if (!cwd?.trim()) {
    // No cwd, no mangled name. Better to leave pi's default alone than to invent
    // a path: the session still runs, and the JSONL is merely where it is today.
    return undefined;
  }
  const boxAgentDir = env.PI_CODING_AGENT_DIR?.trim()
    ? env.PI_CODING_AGENT_DIR.trim()
    : join(env.HOME?.trim() || homedir(), ".pi", "agent");
  const target = join(boxAgentDir, "sessions", jsonlSessionDirectoryName(cwd.trim()));
  try {
    mkdirSync(target, { recursive: true });
  } catch {
    // Could not create it — so do NOT point pi at it. Pointing pi at a directory
    // that does not exist is the hang described above; leaving the variable unset
    // keeps today's behaviour, which is degraded but alive.
    return undefined;
  }
  return target;
}

/**
 * pi's own session-directory name for a cwd, transcribed from
 * `pi-agent-core` `dist/harness/session/jsonl/repo.js:13-15` (pi 0.84.4):
 *
 * ```js
 * `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
 * ```
 *
 * Transcribed rather than approximated, because a near-miss produces a directory
 * that exists, is written to, and is not the one IR-3 reads.
 */
function jsonlSessionDirectoryName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * `openrouter/z-ai/glm-5.3-flash` → `z-ai/glm-5.3-flash`.
 *
 * Both harnesses namespace the catalogue by provider, so the ENTRY key is the
 * bare vendor/model while the SELECTOR carries the provider prefix. Writing the
 * prefixed form as the key produces `provider.openrouter.models.openrouter/…`,
 * which the harness never looks up — and the failure is a local "model not
 * found" that reads exactly like the un-provisioned case it was meant to fix.
 *
 * ⚠️ EXPORTED SO THE CREATE-TIME `--model` PRE-FLIGHT CAN ASK THE SAME QUESTION
 * (brick a5eddb8d). `validateSessionModelFlags` must resolve `openrouter/<id>`
 * to the catalogue row `<id>` before looking it up, and that resolution has to be
 * THE SAME RULE the provisioning write applies to the same string a few
 * milliseconds later — otherwise the gate refuses ids the spawn would have
 * provisioned fine, or admits ones it would not. Re-implementing it there is what
 * would let the two drift; importing it is what makes them one fact.
 */
export function stripProviderPrefix(modelId: string): string {
  const trimmed = modelId.trim();
  return trimmed.startsWith("openrouter/") ? trimmed.slice("openrouter/".length) : trimmed;
}
