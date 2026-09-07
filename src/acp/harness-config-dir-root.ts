import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * WHERE per-session harness config dirs live — resolved in ONE place, by the
 * writer ({@link import("./harness-config-dir.js").applyHarnessConfigDir}), by the
 * shared OpenCode plugin cache, and by the orphan sweep
 * ({@link import("./harness-config-dir.js").pruneOrphanHarnessConfigDirs}).
 *
 * ## ⚠️ WHY THIS IS ITS OWN MODULE
 *
 * The three consumers must agree about the root or the sweep looks somewhere the
 * writer never wrote — a sweep reporting a truthful, cheap, entirely clean census
 * over an empty directory while the real population sits elsewhere. `harness-config-dir.ts`
 * imports `opencode-plugin-cache.ts`, so the resolver cannot live in either without
 * a cycle. One module, imported by both, is what makes "they cannot disagree" a
 * property rather than a habit.
 *
 * ## ⚠️ THE DEFAULT STAYS THE REAL ROOT, DELIBERATELY (CONCEPTION §4)
 *
 * An explicit root is for callers who need SCOPING — the test suite, a rig, an
 * operator on a shared box. It is **not** a way to make the default harmless: if
 * the default moved, the safe invocation would become the one nobody uses, and the
 * directories that actually leak today (`/tmp/acpx-<harness>-<id>`) would be
 * orphaned from their own reaper.
 *
 * ## Precedence, stated rather than inferred
 *
 *   1. an **explicit argument** — `--config-dir-root <path>` on `sessions prune`,
 *      or `rootDir` on a direct call. Wins over everything, so a test that pins a
 *      fixture root is never overridden by an ambient variable.
 *   2. **`ACPX_HARNESS_CONFIG_DIR_ROOT`** in the environment. This is the only form
 *      that can scope a CHILD process nobody edited — which is what the test suite
 *      needs: every `runCli` helper spreads `process.env` into the spawned CLI, so
 *      one assignment in the temp-home fixture scopes every prune invocation the
 *      suite makes, including ones added later. A per-invocation flag cannot do
 *      that without a hand-maintained list of call sites, and a hand-maintained
 *      list survives its own violation.
 *   3. **`tmpdir()`** — the real root, honouring `TMPDIR` exactly as before.
 *
 * A blank or whitespace-only value is treated as ABSENT rather than as the empty
 * string: `ACPX_HARNESS_CONFIG_DIR_ROOT=` in an env file would otherwise resolve the
 * root to `""`, which `join()` turns into a RELATIVE path under the process cwd —
 * a sweep rooted wherever the CLI happened to be invoked from.
 */
export const HARNESS_CONFIG_DIR_ROOT_ENV = "ACPX_HARNESS_CONFIG_DIR_ROOT";

export function resolveHarnessConfigDirRoot(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromArgument = explicit?.trim();
  if (fromArgument !== undefined && fromArgument.length > 0) {
    return fromArgument;
  }
  const fromEnv = env[HARNESS_CONFIG_DIR_ROOT_ENV]?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  return tmpdir();
}

/**
 * WHERE a harness's own STATE lives — a different question from the config root
 * above, with a different answer, and the reason they must not share one
 * (brick 6c94af4a).
 *
 * ## ⚠️ CONFIG IS DISPOSABLE; STATE IS NOT. THAT IS THE WHOLE DISTINCTION.
 *
 * The config root is `tmpdir()` and that is CORRECT: acpx rewrites the per-session
 * config from the session record at every spawn, so losing it costs nothing. A
 * harness's DATA dir holds the conversation itself — for OpenCode, the `session`
 * and `message` tables of `opencode.db`. **Losing that is unrecoverable, and the
 * failure it produces is permanent rather than transient:** `session/resume`
 * answers `-32603 "Internal error: OpenCode service failure"` and acpx retries it
 * forever, because `SESSION_RESUME_REQUIRED` is marked retryable and nothing on
 * the acpx side can tell "the harness is briefly unwell" from "the session this id
 * names no longer exists anywhere".
 *
 * ## ⚠️ THE DEFAULT MUST BE DURABLE STORAGE, AND `tmpdir()` IS NOT IT
 *
 * Without `XDG_DATA_HOME`, OpenCode falls back to `$HOME/.local/share/opencode`.
 * On the dev boxes that path is on the **container's writable layer**, which the
 * platform's durability contract does not cover — the PVC is mounted at `.acpx`,
 * `.claude`, `.codex`, `.vscode`, `.ssh-host-keys`, `.vibe-kanban`,
 * `.local/share/vibe-kanban` and `/workspace`, and nothing else. **A subPath
 * mounted INSIDE `.local/share` for one tool is the platform stating that
 * `.local/share` is not itself durable.**
 *
 * ⚠️ **AND `tmpdir()` WOULD NOT FIX IT — IT IS THE SAME FILESYSTEM.** Measured on
 * devbox: `/tmp` and `$HOME/.local/share` both report `st_dev` 1048684 (the
 * container overlay), while `$HOME/.acpx` and `/workspace` report 2080 (the PVC).
 * So "give it an isolated directory" is not on its own a fix; the directory has to
 * be isolated **and on durable storage**. Reusing the config root here would have
 * looked like a fix and changed nothing.
 *
 * **The reason stated so it cannot go stale:** state that must outlive a process
 * restart belongs on storage the platform guarantees, and `.acpx` is the tree acpx
 * already owns there. This does not depend on how often a box actually restarts,
 * on any current wipe behaviour, or on any other component's present-day layout —
 * all of which change without warning anyone here.
 *
 * ## Why ONE root for the box rather than one per session
 *
 * Sharing is deliberate and matches what acpx already does two layers up:
 *
 *   - **Disk.** The PVC is the fullest filesystem on these boxes. OpenCode installs
 *     `@opencode-ai/plugin` per session at 63 MB, which is exactly why
 *     `seedOpenCodePluginInstall` hardlink-seeds ONE shared install instead of
 *     paying it per session. Per-session state dirs would re-introduce the cost
 *     this codebase already decided against.
 *   - **It is not a security boundary.** `~/.acpx/sessions/` holds every session's
 *     record and transcript in one directory, as one unix user. Per-session config
 *     dirs exist to stop a *config* key bleeding between sessions (brick 13f73472),
 *     not to isolate data, and the data store does not need a boundary the rest of
 *     acpx does not keep.
 *   - **Resume wants a stable path.** OpenCode namespaces sessions by its own
 *     `ses_…` ids inside the store, which is the single-user layout it is built
 *     for. One root means a resume finds its session without acpx having to
 *     reconstruct which directory a given id was written under.
 *
 * Precedence mirrors {@link resolveHarnessConfigDirRoot} exactly — explicit
 * argument, then `ACPX_HARNESS_DATA_DIR_ROOT`, then the default — including the
 * blank-is-absent rule, for the same reason: an empty value in an env file would
 * otherwise resolve to a RELATIVE path under the process cwd.
 * `ACPX_STATE_HOME` is honoured because it is the existing seam that moves the
 * whole `.acpx` tree (see `defaultUiPrefsDbPath`).
 */
export const HARNESS_DATA_DIR_ROOT_ENV = "ACPX_HARNESS_DATA_DIR_ROOT";

export function resolveHarnessDataDirRoot(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromArgument = explicit?.trim();
  if (fromArgument !== undefined && fromArgument.length > 0) {
    return fromArgument;
  }
  const fromEnv = env[HARNESS_DATA_DIR_ROOT_ENV]?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  const stateHome = env.ACPX_STATE_HOME?.trim();
  const base = stateHome !== undefined && stateHome.length > 0 ? stateHome : homedir();
  return join(base, ".acpx", "harness-data");
}
