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
 * ## ⚠️ THE pi PATH RECORDS `null`, AND THAT IS MEASURED, NOT LAZINESS
 *
 * CONCEPTION §8 says the provider is on pi's own assistant-message record. It is
 * not, on the shipped build: `AssistantMessage.provider` is pi's **provider id**
 * (`"openrouter"` — the openai-completions chunk sets `provider: model.provider`,
 * `pi-ai/dist/types.d.ts:307-327`), `rawStopReason` is the **normalised**
 * `choice.finish_reason` rather than `native_finish_reason`, and pi-acp forwards
 * only `usage` in `_meta.piAcp.message`. pi talks to OpenRouter directly, so acpx
 * owns no seam on that path and cannot observe the answer. Recording pi's
 * `"openrouter"` here would be exactly the substitution the rule above forbids,
 * one level cruder. (Correction filed under CONCEPTION §0; the follow-up is
 * pi-acp forwarding `responseId` so acpx can resolve `/api/v1/generation` lazily.)
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
};

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
    } catch {
      return [];
    }
  }
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

function parseLine(line: string): TurnAttribution | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    const provider = typeof record.provider === "string" ? record.provider : null;
    if (!provider) {
      return undefined;
    }
    return {
      provider_name: provider,
      native_finish_reason:
        typeof record.native_finish_reason === "string" ? record.native_finish_reason : null,
    };
  } catch {
    return undefined;
  }
}
