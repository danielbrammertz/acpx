/**
 * WHO ACTUALLY SERVED THE TURN — the Claude/OpenRouter shim's attribution log
 * and its reader (brick 4c272cab §8).
 *
 * ## Why this exists at all
 *
 * The founding incident (brick 2e264d8a) was invisible for days: OpenRouter
 * served `z-ai/glm-5.3-flash` from Wafer at 15 tok/s while the same model runs
 * at 132 tok/s elsewhere, and **nothing anywhere recorded which provider had
 * served a turn**, so the only detector was a human noticing a session crawl.
 * A provider preference that cannot be checked afterwards is a preference
 * nobody can evaluate — which is why this ships in the same brick as the policy.
 *
 * ## 🛑 THE PREFERRED PROVIDER IS NOT AN ANSWER. `null` MEANS "NOT RECORDED".
 *
 * The single rule this module exists to enforce. A preference is a preference:
 * the named provider is routinely unavailable (measured — BaseTen and Crusoe
 * were both hard-429 for an afternoon while a correct policy was in force), so
 * substituting the policy's first choice for the provider that actually served
 * would make the whole feature **un-falsifiable** — the record would agree with
 * the preference by construction, including on every turn where the preference
 * did not hold. Absence is recorded as absence.
 *
 * ## ⚠️ THE pi PATH ANSWERS THROUGH A LOOKUP, NOT THROUGH pi (brick 77054e85)
 *
 * CONCEPTION §8 says the provider is on pi's own assistant-message record. It is
 * not, on the shipped build: `AssistantMessage.provider` is pi's **provider id**
 * (`"openrouter"` — the openai-completions chunk sets `provider: model.provider`,
 * `pi-ai/dist/types.d.ts:307-327`) and `rawStopReason` is the **normalised**
 * `choice.finish_reason` rather than `native_finish_reason`. pi talks to
 * OpenRouter directly, so acpx owns no seam on that path and cannot read the
 * answer off the turn. Recording pi's `"openrouter"` would be exactly the
 * substitution the rule above forbids, one level cruder.
 *
 * What pi's message DOES carry is `responseId` — OpenRouter's generation id. The
 * nativai `pi-acp` fork forwards it on `_meta.piAcp.message`, and
 * {@link ./openrouter-generation.ts} resolves it to a real `provider_name` with
 * a lookup made off the turn path. **Until that lookup lands the record says
 * `provider_name: null` with a `response_id`, and that is still "not recorded"** —
 * an id is a handle, never an answer.
 */

import fs from "node:fs";

/** The shim's NDJSON log, inside the session's own OpenRouter config dir. */
export const ATTRIBUTION_LOG_FILENAME = "or-attribution.ndjson";

/** One turn's attribution, as it is persisted beside the cost unit. */
export type TurnAttribution = {
  /** The provider that SERVED it, verbatim from the response (`"Modal"`). */
  provider_name: string | null;
  /** The provider's own finish reason, un-normalised. */
  native_finish_reason: string | null;
  /**
   * OpenRouter's generation id for the response (`"gen-1789154639-…"`), or
   * `null` when this path saw none (brick 77054e85).
   *
   * ⚠️ **THIS IS A HANDLE, NOT AN ANSWER.** It says only *which* generation
   * served the message; `provider_name` is what a reader wants, and the two are
   * independent — a record can carry an id with `provider_name: null` (the
   * lookup has not resolved yet, or never will), and it can carry a
   * `provider_name` with no id (the Claude shim read the provider straight off
   * the response). Do not display it as attribution and do not infer one from
   * the other.
   */
  response_id: string | null;
};

/**
 * The persisted form: the observation plus when the record learned it. ONE
 * declaration, referenced by `types.ts` and the client snapshot alike.
 */
export type LastTurnProviderBreadcrumb = TurnAttribution & { at: string };

/**
 * A cursor over one session's attribution log.
 *
 * ⚠️ **IT CONSUMES, RATHER THAN RE-READING THE TAIL.** Reading "the last line"
 * on every usage event would re-attribute a stale response to a turn that
 * produced none — a wrong answer that looks exactly like a right one. Tracking
 * the consumed offset makes "no new response since the last read" observable,
 * and that case is `undefined` ⇒ `null` on the record.
 */
export class OpenRouterAttributionLog {
  private offset = 0;

  constructor(private readonly path: string) {}

  /**
   * The most recent response recorded since the previous call, or `undefined`.
   *
   * A turn can produce several upstream responses (tool loops); the ingest folds
   * one unit per assistant message, so the LAST unconsumed line is the one that
   * produced this message. Never throws: attribution is enrichment and must not
   * be able to cost a turn its usage update.
   */
  takeLatest(): TurnAttribution | undefined {
    const lines = this.readNewLines();
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const parsed = parseLine(lines[index]);
      if (parsed) {
        return parsed;
      }
    }
    return undefined;
  }

  private readNewLines(): string[] {
    try {
      const size = fs.statSync(this.path).size;
      // ⚠️ A SHRUNKEN FILE REWINDS TO ZERO, NOT TO ITS NEW SIZE. A fresh shim
      // restarts the log on the same path; clamping the cursor to the new size
      // would leave it AT the end, so every later response would be missed and
      // attribution would go permanently blind with no error anywhere.
      if (size < this.offset) {
        this.offset = 0;
      }
      if (size <= this.offset) {
        return [];
      }
      const handle = fs.openSync(this.path, "r");
      try {
        const buffer = Buffer.alloc(size - this.offset);
        const read = fs.readSync(handle, buffer, 0, buffer.length, this.offset);
        this.offset += read;
        return buffer
          .subarray(0, read)
          .toString("utf8")
          .split("\n")
          .filter((line) => line.trim().length > 0);
      } finally {
        fs.closeSync(handle);
      }
    } catch (error) {
      // ⚠️ ENOENT IS NOT AN ERROR AND EVERYTHING ELSE IS (TE finding F-3). The
      // log does not exist until the first upstream response, so "no file yet"
      // is the ordinary state of a session that has not talked to OpenRouter —
      // silence there is correct. A permission problem, a bad handle or an I/O
      // failure is NOT ordinary, and swallowing it identically is what made an
      // unreadable log indistinguishable from an empty one.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        reportAttributionReadFailure(this.path, error);
      }
      return [];
    }
  }
}

let attributionReadFailureReported = false;

/** Say it ONCE per process: enough to be discovered, not enough to flood a turn. */
function reportAttributionReadFailure(path: string, error: unknown): void {
  if (attributionReadFailureReported) {
    return;
  }
  attributionReadFailureReported = true;
  process.stderr.write(
    `[acpx] warning: could not read the OpenRouter attribution log at ${path} ` +
      `(${error instanceof Error ? error.message : String(error)}); ` +
      `turns will record no provider until this is fixed.\n`,
  );
}

/**
 * Attach an attribution to a `usage_update` notification, on the exact path the
 * session record's ingest reads it back from.
 *
 * ⚠️ **THE WRITER AND THE READER ARE ONE PAIR AND THEY LIVE APART** — this is
 * called by the ACP client (which owns the shim's log) and read by
 * `conversation-model`'s cost ingest (which owns the record). A `_meta` path
 * typo would be silent in both directions: no error, no type failure, just a
 * record that never carries a provider. It is exported so the round trip can be
 * asserted end-to-end rather than by two independent literals agreeing by luck
 * (`test/openrouter-attribution.test.ts`).
 */
export function attachAttribution(update: object, attribution: TurnAttribution): void {
  const meta = ((update as { _meta?: Record<string, unknown> })._meta ??= {});
  const acpx = ((meta as { acpx?: Record<string, unknown> }).acpx ??= {});
  (acpx as { orAttribution?: TurnAttribution }).orAttribution = attribution;
}

/**
 * OpenRouter's generation id off a **pi** usage update, or `undefined`
 * (brick 77054e85).
 *
 * The nativai `pi-acp` fork puts `responseId` on the same
 * `_meta.piAcp.message` block as the per-message counts. Read here rather than
 * inline in the client so the wire path lives beside {@link attachAttribution} —
 * the pair of `_meta` literals this file exists to keep in one place, since a
 * typo in either is silent in both directions.
 *
 * ⚠️ **`message.provider` IS NOT AN ALTERNATIVE TO THIS.** pi-acp forwards it
 * too, and on OpenRouter it is the constant `"openrouter"` — pi's provider ID,
 * never the serving provider. It is carried for diagnosis; a reader that
 * substituted it for `provider_name` would publish a value that agrees with
 * itself on every turn, which is the un-falsifiability this module's header
 * forbids.
 */
export function piGenerationId(update: object): string | undefined {
  const meta = (update as { _meta?: { piAcp?: { message?: unknown } } })._meta;
  const message = meta?.piAcp?.message;
  if (typeof message !== "object" || message === null) {
    return undefined;
  }
  const responseId = (message as { responseId?: unknown }).responseId;
  return typeof responseId === "string" && responseId.trim().length > 0
    ? responseId.trim()
    : undefined;
}

/** A non-empty string, or `null` — the shape every field on this type takes. */
export function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseLine(line: string): TurnAttribution | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    const provider = nullableString(record.provider);
    if (!provider) {
      return undefined;
    }
    return {
      provider_name: provider,
      native_finish_reason: nullableString(record.native_finish_reason),
      // The shim has recorded `gen_id` since it was written (its own comment
      // points at `/api/v1/generation?id=` as the deeper source); carrying it
      // here makes `response_id` mean ONE thing on both harness paths, so the
      // lazy resolver needs no per-path branch.
      response_id: nullableString(record.gen_id),
    };
  } catch {
    return undefined;
  }
}
