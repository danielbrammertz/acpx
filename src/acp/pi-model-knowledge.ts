/**
 * PI'S OWN MODEL KNOWLEDGE — read through a SUPPORTED interface, cached under a
 * path ACPX owns.
 *
 * ## Why this module exists (brick 6253611b)
 *
 * `writePiModelsStore()` used to decide "does pi already know this slug?" by
 * looking at **the box's remote-overlay cache alone**
 * (`readBoxPiOpenRouterModels`). That asks the wrong question. pi's knowledge is
 * its **BUNDLED** catalogue PLUS that overlay, and **measured 2026-09-07: 333 of
 * the 374 models pi advertises are BUNDLED.** So the guard was unreachable for
 * 89% of the catalogue even with a populated overlay — and on a box where the
 * overlay file does not exist at all (the actual state of every dev box, because
 * acpx re-points `PI_CODING_AGENT_DIR` at a per-session dir it later deletes) it
 * was unreachable for **all** of it. Every session therefore fabricated an entry
 * that **replaced** pi's real one, costing the session its true price, its true
 * context window and its `thinkingLevelMap`.
 *
 * ## Why an RPC read and NOT parsing pi's bundle
 *
 * pi's catalogue is embedded in its **minified** `dist/bundle/chunks/*.js`.
 * Parsing that would couple acpx to pi's internal bundle layout, so **a pi
 * upgrade would break us SILENTLY** — landing straight back at fabrication with
 * no signal at all. `ModelRegistry` *is* a public export of pi's package entry,
 * but it is **not constructible standalone** (measured: `new ModelRegistry()`
 * succeeds, then `getAll()` throws `TypeError: Cannot read properties of
 * undefined (reading 'getModels')`), so the in-process route is closed.
 *
 * What is left is pi's own **documented RPC surface**, which is the interface
 * pi-acp itself drives: `pi --mode rpc` + `{"type":"get_available_models"}`.
 * Measured cost: **539 ms** via `spawnSync` (exit 0 — pi terminates on stdin
 * EOF), so this is affordable once and then cached.
 *
 * ## ⚠️ THE REFRESH RACE, MEASURED — and why this reader is a FLOOR, not a total
 *
 * pi refreshes its remote catalogue in the background at startup, so the answer
 * depends on WHEN you ask. Measured, varying only the wait:
 *
 * ```
 *   ask after    0 ms -> 333 models      ask after 1200 ms -> 374 models
 *   ask after  300 ms -> 333 models      ask after 3000 ms -> 374 models
 * ```
 *
 * A synchronous read therefore returns the **bundled floor (333)**, not the full
 * 374. **This is deliberate and it degrades in the SAFE direction:** a model in
 * the ~41 remote-only rows is classified "pi does not know it", so we write an
 * entry for it — but now with **real** rates, context window and max-tokens from
 * acpx's own catalogue, which is strictly better than the zeros this brick
 * removes. The residual (such a model still loses its `thinkingLevelMap`) is
 * filed under 6253611b rather than papered over: closing it means waiting on
 * pi's refresh, which would put >1.2 s on every session create.
 *
 * **Never widen this to "the total pi will eventually advertise" without
 * re-measuring the race — a reader that is sometimes complete is worse than one
 * that is reliably a floor, because only the second one is safe to reason about.**
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Long enough that the spawn is amortised to nothing; short enough that a pi
 *  upgrade is picked up the same day. A slug added by an upgrade inside the TTL
 *  is merely treated as unknown, which is the safe direction (see the header). */
export const PI_KNOWLEDGE_TTL_MS = 24 * 60 * 60 * 1000;

/** pi answers in ~539 ms; this is a stall bound, not an expected duration. */
const PI_RPC_TIMEOUT_MS = 15_000;

/** pi's catalogue reply is ~140 KB today; leave generous headroom. */
const PI_RPC_MAX_BUFFER = 64 * 1024 * 1024;

export type PiModelKnowledge = {
  /** ISO-8601 of the read these ids came from. */
  fetchedAt: string;
  /** Every model id pi advertised, WITHOUT a provider prefix — the same
   *  namespace `writePiModelsStore` keys its entries on. */
  ids: string[];
};

export type PiKnowledgeDeps = {
  /** Overrides the cache file outright (tests). */
  cachePath?: string;
  /** The `pi` executable; the registry's resolved command in production. */
  piCommand?: string;
  now?: number;
  /** Injected in tests so no real process is spawned. */
  readAdvertised?: (piCommand: string, env: NodeJS.ProcessEnv) => string[] | null;
};

/**
 * `ACPX_STATE_HOME` moves the whole `.acpx` tree, which is the override every
 * other acpx path resolver already honours. **Deliberately NOT under pi's own
 * agent dir:** acpx re-points that at a per-session directory it deletes at
 * close, so a cache written there could never survive (the very mechanism that
 * keeps pi's overlay permanently empty).
 */
export function piKnowledgeCachePath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ACPX_PI_KNOWLEDGE_CACHE?.trim();
  if (explicit) {
    return explicit;
  }
  return join(env.ACPX_STATE_HOME || homedir(), ".acpx", "pi-model-knowledge.json");
}

function readCache(cachePath: string): PiModelKnowledge | null {
  let raw: string;
  try {
    raw = readFileSync(cachePath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const ids = (parsed as PiModelKnowledge).ids;
    if (!Array.isArray(ids)) {
      return null;
    }
    return {
      fetchedAt: (parsed as PiModelKnowledge).fetchedAt ?? new Date(0).toISOString(),
      ids: ids.filter((id): id is string => typeof id === "string"),
    };
  } catch {
    // A truncated or hand-mangled cache is a cold cache, never a crash: a
    // session create must not fail because this file is unreadable.
    return null;
  }
}

/** Atomic tmp + rename — a reader never sees a half-written cache. */
function writeCache(cachePath: string, knowledge: PiModelKnowledge): void {
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    const tmpPath = `${cachePath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(knowledge)}\n`, "utf8");
    renameSync(tmpPath, cachePath);
  } catch {
    // Caching is an optimisation. A read-only or full disk must not fail a
    // session create; the next spawn simply pays the ~539 ms again.
  }
}

/**
 * One `pi --mode rpc` round-trip. Returns `null` — never throws — when pi is not
 * installed, does not answer, or answers something unparseable: the caller must
 * be able to tell "pi advertises nothing" (impossible) from "I could not ask"
 * (routine on a box without pi).
 */
function readAdvertisedViaRpc(piCommand: string, env: NodeJS.ProcessEnv): string[] | null {
  const result = spawnSync(piCommand, ["--mode", "rpc", "--no-themes"], {
    encoding: "utf8",
    timeout: PI_RPC_TIMEOUT_MS,
    maxBuffer: PI_RPC_MAX_BUFFER,
    env,
    input: `${JSON.stringify({ type: "get_available_models", id: "acpx-knowledge" })}\n`,
  });
  if (result.error || typeof result.stdout !== "string") {
    return null;
  }
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const frame = parsed as { type?: unknown; id?: unknown; data?: { models?: unknown } };
    if (frame.type !== "response" || frame.id !== "acpx-knowledge") {
      continue;
    }
    const models = frame.data?.models;
    if (!Array.isArray(models)) {
      return null;
    }
    return models
      .map((model) => (model as { id?: unknown }).id)
      .filter((id): id is string => typeof id === "string");
  }
  return null;
}

/**
 * The model ids pi already knows — cache-first, one RPC read on a miss.
 *
 * `null` means **"could not be established"** (pi absent, or it did not answer)
 * and is deliberately distinct from an empty set: the caller must not read a
 * failure to ask as "pi knows nothing", because those two lead to opposite
 * decisions.
 */
export function readPiAdvertisedModelIds(
  env: NodeJS.ProcessEnv = process.env,
  deps: PiKnowledgeDeps = {},
): Set<string> | null {
  const cachePath = deps.cachePath ?? piKnowledgeCachePath(env);
  const now = deps.now ?? Date.now();

  const cached = readCache(cachePath);
  if (cached) {
    const fetchedAt = Date.parse(cached.fetchedAt);
    if (Number.isFinite(fetchedAt) && now - fetchedAt < PI_KNOWLEDGE_TTL_MS) {
      return new Set(cached.ids);
    }
  }

  const read = deps.readAdvertised ?? readAdvertisedViaRpc;
  const ids = read(deps.piCommand ?? "pi", env);
  if (!ids) {
    // Could not ask. A STALE cache is still far better than nothing — it is a
    // list of ids pi advertised recently, and pi's catalogue moves slowly.
    return cached ? new Set(cached.ids) : null;
  }
  writeCache(cachePath, { fetchedAt: new Date(now).toISOString(), ids });
  return new Set(ids);
}
