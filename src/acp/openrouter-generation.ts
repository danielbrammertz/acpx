/**
 * RESOLVING A GENERATION ID TO THE PROVIDER THAT SERVED IT — the pi path's
 * answer to per-turn attribution (brick 77054e85, follow-up to 4c272cab §8).
 *
 * ## Why a lookup rather than a field
 *
 * On the Claude path acpx owns the OpenRouter shim, so it reads `provider` off
 * the response and is done. On the **pi** path pi talks to OpenRouter directly
 * and acpx owns no seam: pi's `AssistantMessage.provider` is its own provider ID
 * (`"openrouter"` on every turn, whoever served it), and its `rawStopReason` is
 * the NORMALISED finish reason. The only thing on that message with the answer
 * behind it is `responseId` — OpenRouter's generation id — which the nativai
 * `pi-acp` fork now forwards on `_meta.piAcp.message`. That id resolves through
 * `GET /api/v1/generation?id=`, and this module is that resolution.
 *
 * ## 🛑 THE ENDPOINT 404s FOR ~10 SECONDS AFTER THE TURN. A SINGLE LOOKUP ALWAYS
 * ##    MISSES, AND 404 IS **NOT** A TERMINAL ANSWER HERE.
 *
 * This is the fact the whole design turns on, and it is the opposite of what the
 * brief assumed ("on 429/5xx leave null and retry on the next turn" — measured,
 * it is never a 429 and never a 5xx). Measured 2026-09-11 against the live API
 * with this box's key, three runs, polling from the instant the completion
 * returned:
 *
 *     run 1:  404 at t+0.3s … 404 at t+9.9s,  200 at t+10.6s
 *     run 2:  404 at t+0.3s … 404 at t+6.4s,  200 at t+8.4s
 *     run 3:  404 for ~6s, then 200
 *
 * So the generation record is minted ASYNCHRONOUSLY, several seconds after the
 * completion the caller already has. A resolver that fires once at turn end, or
 * that treats 404 as "no such generation", records `null` on every single turn
 * while looking like it works — the failure mode is a feature that is inert and
 * silent, which is exactly what brick 5026423b cost. Hence {@link RETRY_DELAYS_MS}.
 *
 * ## What is deliberately NOT done here
 *
 * - **No blocking of the turn.** The schedule below runs entirely after the
 *   `usage_update` that triggered it; nothing awaits it. A turn never pays for
 *   attribution, which is the rule the 10-second window makes non-negotiable.
 * - **No guessing.** A give-up leaves `provider_name: null`, which means "not
 *   recorded" — never the box's preferred provider. See
 *   `openrouter-attribution.ts` for why that substitution would make provider
 *   routing un-falsifiable.
 */

import {
  loadBoxProviders,
  resolveBoxProviderKey,
  type BoxProviderLookupOptions,
} from "../config/providers.js";
import { resolveSessionRecord, writeSessionRecord } from "../session/persistence.js";
import type { LastTurnProviderBreadcrumb } from "./openrouter-attribution.js";

/** The `providers.json` entry that pays for this lookup. */
const OPENROUTER_SOURCE = "openrouter";

const FETCH_TIMEOUT_MS = 10_000;

/**
 * How long a resolved generation stays answerable without a second fetch.
 *
 * Five minutes, matching `OPENROUTER_ENDPOINTS_TTL_MS`. A generation record is
 * immutable once minted, so the TTL is about bounding the map rather than about
 * freshness — the entries exist so a retry on the NEXT turn for an id already
 * resolved costs no request at all.
 */
export const GENERATION_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * The back-off, in milliseconds before each attempt after the first.
 *
 * 🛑 **SIZED FROM THE MEASURED 404 WINDOW, NOT PICKED FOR TIDINESS.** Attempts
 * land at roughly t+0, 1, 3, 6, 10, 15, 21 s; the measured mint took 8.4–10.6 s,
 * so three attempts fall after the worst observed case and the schedule still
 * ends inside the 30 s the acceptance criterion allows. **Shortening this to
 * "one quick retry" restores the original defect** — every turn records `null`
 * and nothing anywhere says why.
 */
export const RETRY_DELAYS_MS = [1_000, 2_000, 3_000, 4_000, 5_000, 6_000] as const;

/** What a generation says about who served it. */
export type GenerationAttribution = {
  provider_name: string | null;
  native_finish_reason: string | null;
};

/**
 * One attempt's outcome.
 *
 * `retry` vs `giveUp` is the whole discrimination this type exists for: a 404 is
 * "not minted yet" (retry) and a 401 is "this key cannot ask" (give up). Reading
 * them the same way in either direction is a bug — one burns requests forever,
 * the other records `null` on every turn.
 */
export type GenerationLookupOutcome =
  | { kind: "resolved"; attribution: GenerationAttribution }
  | { kind: "retry"; detail: string }
  | { kind: "giveUp"; detail: string };

export function generationUrl(responseId: string): string {
  return `https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(responseId)}`;
}

/**
 * One `GET /api/v1/generation?id=` attempt, classified.
 *
 * ⚠️ THE BODY IS WRAPPED IN `data` AND THE CONCEPTION'S MEASUREMENT IS NOT.
 * `MEASUREMENTS.md` §5 of brick 4c272cab prints the fields unwrapped
 * (`{"provider_name": "Modal", …}`); the wire is `{"data":{"provider_name":…}}`,
 * measured 2026-09-11. A reader following that document literally gets
 * `undefined` for every field and records a permanent `null` — which is
 * indistinguishable from the "not recorded" this feature legitimately produces.
 */
export async function fetchGeneration(
  responseId: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GenerationLookupOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(generationUrl(responseId), {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      // ⚠️ The URL may be logged. The Authorization header may not, ever.
      headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
    });
  } catch (error) {
    // A timeout or a DNS blip is transient by nature — the same class as a 404
    // here, and treating it as terminal would lose a turn's attribution to a
    // hiccup that the next attempt sails through.
    return { kind: "retry", detail: errorMessage(error) };
  }
  if (!response.ok) {
    return classifyStatus(response.status);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return { kind: "retry", detail: `unreadable body: ${errorMessage(error)}` };
  }
  const attribution = parseGenerationBody(body);
  if (!attribution) {
    // A 200 whose body names no provider is an ANSWER, not an outage: retrying
    // it would spin against a record that will never say more.
    return { kind: "giveUp", detail: "the generation record names no provider" };
  }
  return { kind: "resolved", attribution };
}

/**
 * `{data:{provider_name, native_finish_reason}}` → the attribution, or
 * `undefined` when the body names no provider.
 *
 * Values are passed through VERBATIM — `"Z.AI"`, `"BaseTen"` — because they are
 * display names and the routing policy stores bare slugs; normalising here would
 * put a guess (`"Z.AI"` → `"z.ai"`, and the real slug is `z-ai`) into the one
 * field that exists to be ground truth.
 */
export function parseGenerationBody(body: unknown): GenerationAttribution | undefined {
  const data = asRecord(asRecord(body)?.data);
  if (!data) {
    return undefined;
  }
  const providerName = typeof data.provider_name === "string" ? data.provider_name.trim() : "";
  if (!providerName) {
    return undefined;
  }
  const native = data.native_finish_reason;
  return {
    provider_name: providerName,
    native_finish_reason: typeof native === "string" && native.length > 0 ? native : null,
  };
}

/**
 * Which HTTP statuses are worth asking again about.
 *
 * 🛑 **404 IS THE RETRYABLE ONE AND THAT IS THE COUNTER-INTUITIVE PART.** It is
 * this API's "not minted yet" for the first ~10 seconds of a generation's life
 * (measured, see the header), so the status that normally means "this will never
 * exist" is here the status that means "ask again shortly".
 */
function classifyStatus(status: number): GenerationLookupOutcome {
  if (status === 404 || status === 408 || status === 429 || status >= 500) {
    return { kind: "retry", detail: `responded ${status}` };
  }
  return { kind: "giveUp", detail: `responded ${status}` };
}

type CacheEntry = { at: number; attribution: GenerationAttribution };

/**
 * Resolved generations, and the sessions with a lookup already running.
 *
 * Process-wide rather than per-client on purpose: a queue owner re-creates its
 * `AcpClient` across turns (and may pool one), so per-client state would drop
 * the "one in flight" guarantee at exactly the boundary the retry schedule
 * crosses.
 */
const cache = new Map<string, CacheEntry>();
const inFlight = new Set<string>();

/** Test seam — drop all memo state so one row cannot condition the next. */
export function resetGenerationResolverState(): void {
  cache.clear();
  inFlight.clear();
  keylessNoteWritten = false;
}

export type ResolveTurnProviderOptions = {
  /** The acpx record whose `last_turn_provider` is being filled in. */
  sessionId: string;
  /** OpenRouter's generation id, off the turn's `usage_update`. */
  responseId: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  providersPath?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Injected in tests so a schedule spanning ~21 s does not cost 21 s. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests; the real one is a read-modify-write of the record. */
  persist?: (
    sessionId: string,
    attribution: GenerationAttribution & { response_id: string },
  ) => Promise<void>;
  /** Injected in tests; the real one writes one line to stderr, once. */
  warn?: (message: string) => void;
};

/**
 * Resolve one turn's provider and write it onto the session record.
 *
 * ⚠️ **NOTHING AWAITS THIS IN PRODUCTION AND THAT IS THE POINT** — it runs for up
 * to ~21 s, entirely after the `usage_update` that triggered it. It is exported
 * as a promise only so a test can await it; the caller
 * ({@link ./client.ts} `scheduleAttributionResolve`) deliberately drops it.
 *
 * Returns the attribution it recorded, or `undefined` when it gave up — which
 * leaves the record's honest `provider_name: null` in place. The next turn
 * re-stamps a fresh `response_id` and this runs again, so a give-up costs one
 * turn's attribution, never the session's.
 */
export async function resolveTurnProvider(
  options: ResolveTurnProviderOptions,
): Promise<GenerationAttribution | undefined> {
  const { sessionId, responseId } = options;
  const now = options.now ?? Date.now;
  const cached = readCache(responseId, now());
  if (cached) {
    await persistAttribution(options, cached);
    return cached;
  }
  // ⚠️ ONE IN FLIGHT PER SESSION, NOT PER ID. A turn that produces several
  // assistant messages produces several ids, and running a ~21 s schedule for
  // each would have a session holding half a dozen overlapping retry loops whose
  // writes race each other onto one field. The last message's id is the one a
  // reader wants anyway, and it arrives last — so the guard drops the EARLIER
  // ones while a lookup is running, and the final one is picked up by the next
  // turn if it loses the race.
  if (inFlight.has(sessionId)) {
    return undefined;
  }
  inFlight.add(sessionId);
  try {
    const attribution = await lookupWithRetries(options, responseId);
    if (!attribution) {
      return undefined;
    }
    cache.set(responseId, { at: now(), attribution });
    await persistAttribution(options, attribution);
    return attribution;
  } finally {
    inFlight.delete(sessionId);
  }
}

async function lookupWithRetries(
  options: ResolveTurnProviderOptions,
  responseId: string,
): Promise<GenerationAttribution | undefined> {
  const apiKey = resolveLookupKey(options);
  if (!apiKey) {
    noteKeylessBoxOnce(options);
    return undefined;
  }
  const sleep = options.sleep ?? defaultSleep;
  const fetchImpl = options.fetchImpl ?? fetch;
  for (let attempt = 0; ; attempt += 1) {
    const outcome = await fetchGeneration(responseId, apiKey, fetchImpl);
    if (outcome.kind === "resolved") {
      return outcome.attribution;
    }
    if (outcome.kind === "giveUp" || attempt >= RETRY_DELAYS_MS.length) {
      return undefined;
    }
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
}

/**
 * The box's OpenRouter key, or `undefined` on a box that holds none.
 *
 * A keyless box is a SUPPORTED state, not an error: attribution is enrichment,
 * so the session keeps its honest `provider_name: null` and nothing fails. It is
 * still worth saying once — silence there is indistinguishable from a resolver
 * that is running and finding nothing.
 */
function resolveLookupKey(options: ResolveTurnProviderOptions): string | undefined {
  const env = options.env ?? process.env;
  return nonEmpty(keyFromProvidersFile(options, env)) ?? nonEmpty(env.OPENROUTER_API_KEY);
}

/** Split out to keep {@link resolveLookupKey} under the repo's complexity ceiling. */
function keyFromProvidersFile(
  options: ResolveTurnProviderOptions,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const lookup: BoxProviderLookupOptions = {
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    ...(options.providersPath !== undefined ? { providersPath: options.providersPath } : {}),
    env,
  };
  const entry = loadBoxProviders(lookup).providers.find(
    (provider) => provider.name === OPENROUTER_SOURCE,
  );
  return entry ? resolveBoxProviderKey(entry, env) : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

let keylessNoteWritten = false;

/** Say it ONCE per process — enough to be discovered, not enough to flood. */
function noteKeylessBoxOnce(options: ResolveTurnProviderOptions): void {
  if (keylessNoteWritten) {
    return;
  }
  keylessNoteWritten = true;
  const warn = options.warn ?? ((message: string) => process.stderr.write(message));
  warn(
    `[acpx] note: this box holds no OpenRouter credential, so per-turn provider ` +
      `attribution stays "not recorded" (run: acpx providers).\n`,
  );
}

function readCache(responseId: string, now: number): GenerationAttribution | undefined {
  const entry = cache.get(responseId);
  if (!entry) {
    return undefined;
  }
  if (now - entry.at > GENERATION_CACHE_TTL_MS) {
    cache.delete(responseId);
    return undefined;
  }
  return entry.attribution;
}

/**
 * Fill `acpx.last_turn_provider` in, on disk.
 *
 * ⚠️ **THE RECORD IS RE-READ HERE RATHER THAN CARRIED IN** — a fresh
 * read-modify-write. The lookup runs for up to ~21 s after its turn ended, and by
 * then no ACP event handler is attached to write through (both runtimes call
 * `client.clearEventHandlers()` at teardown), so there is no live in-memory
 * record to update: this writer IS the write path. Re-reading is what keeps it
 * from resurrecting a 21-second-old copy of everything else on the record.
 *
 * ⚠️ **IT PRESERVES `response_id` AND REFUSES TO OVERWRITE A DIFFERENT TURN'S
 * BREADCRUMB.** If a new turn has already stamped a new id, this answer is about
 * the previous one and writing it would report a stale provider as the current
 * turn's. That case is left alone — the new turn's own lookup is what answers it.
 *
 * `writeSessionRecord` refreshes the index entry too, so the acpx-ui projection
 * (`lastTurnProvider` / `lastTurnNativeFinishReason` / `lastTurnProviderAt`)
 * follows without a second leg to forget.
 */
async function persistAttribution(
  options: ResolveTurnProviderOptions,
  attribution: GenerationAttribution,
): Promise<void> {
  const persist = options.persist ?? writeResolvedAttribution;
  try {
    await persist(options.sessionId, { ...attribution, response_id: options.responseId });
  } catch {
    // Attribution is enrichment. A record that could not be re-read or re-written
    // is a real problem, but it is not THIS feature's to report — and the turn it
    // belongs to is long over, so there is no caller left to fail.
  }
}

async function writeResolvedAttribution(
  sessionId: string,
  attribution: GenerationAttribution & { response_id: string },
): Promise<void> {
  const record = await resolveSessionRecord(sessionId);
  const existing = record.acpx?.last_turn_provider;
  if (existing?.response_id && existing.response_id !== attribution.response_id) {
    return;
  }
  const breadcrumb: LastTurnProviderBreadcrumb = {
    provider_name: attribution.provider_name,
    native_finish_reason: attribution.native_finish_reason,
    response_id: attribution.response_id,
    // The instant the RECORD learned it, which is what `at` has always meant
    // here — not the instant the generation was served.
    at: new Date().toISOString(),
  };
  record.acpx = { ...record.acpx, last_turn_provider: breadcrumb };
  await writeSessionRecord(record);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // The schedule must never be the reason a CLI process stays alive: a
    // one-shot `acpx … -p` that finishes before the generation is minted should
    // exit, not hang for 21 s waiting to enrich a record.
    timer.unref?.();
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
