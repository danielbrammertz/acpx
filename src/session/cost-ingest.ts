import {
  type CostUnit,
  deriveCostFigure,
  reportedCost,
  type SessionCostFigure,
  type UnitRates,
} from "../models/cost-provenance.js";
import {
  defaultCatalogueCachePath,
  type OpenRouterRawModel,
  readOpenRouterCacheSync,
} from "../models/openrouter-catalogue.js";
import type { SessionAcpxState } from "../types.js";

/**
 * THE INGEST CALLER `cost-provenance.ts` SHIPPED WITHOUT (brick 5026423b).
 *
 * `deriveCostFigure` and `reportedCost` were merged as a pure module with **zero
 * callers**, and `measuredFree` was declared and consumed but never assigned
 * anywhere in `src`. So nothing ever produced a cost figure and nothing persisted
 * one — "inert until read" was meant to mean *stored but not rendered*; what
 * shipped was *not stored at all*.
 *
 * ## ⚠️ RATES ARE RESOLVED AT INGEST AND PERSISTED WITH THE UNIT, DELIBERATELY
 *
 * The alternative — persist token counts, price them at read time — looks tidier
 * and is wrong here. **A cold catalogue cache makes every model look price-less**
 * (`cost-provenance.ts`'s own warning), so a session that was correctly `computed`
 * would silently re-read as `unpriced` the first time the cache was cold, and back
 * again later. A cost figure that flaps with cache weather is worse than one that
 * is merely stale. Resolving once, at the moment the tokens are observed, makes
 * the figure reproducible.
 *
 * ⇒ The stored unit therefore carries its own rates, and `deriveCostFigure`
 * remains the ONLY place the provenance rules live — this module resolves inputs
 * and never re-implements the derivation.
 *
 * ## ⚠️ ONE UNIT PER ASSISTANT MESSAGE, NOT PER TURN AND NOT PER MODEL
 *
 * pi emits one `usage_update` per assistant `message_end`. A turn holds several,
 * and a session can switch models mid-flight, so the model in force is captured
 * PER UNIT. Summing a cumulative counter across a model switch would attribute one
 * model's tokens to another — the reason `CostCoverage.unit` is `message`.
 */

/** What one usage event contributes, as observed. `null` rates ⇔ unpriceable. */
export type UsageObservation = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** The adapter's OWN figure for the session so far, when it reports one. */
  reportedAmount?: number | null;
};

type RateLookup = (modelId: string) => UnitRates | null;

/**
 * Per-1M rates for a model id, or `null` when the catalogue has no row for it.
 *
 * ⚠️ **ABSENCE IS NEVER ZERO.** `null` here means "no row", which
 * `deriveCostFigure` turns into `unpriced`; a row that genuinely quotes zero
 * returns rates with `measuredFree: true`, which is the only path to `free`. That
 * asymmetry is the whole discrimination and it must not be collapsed — a missing
 * row priced as 0 is how a confident `$0.00` reaches a user who was in fact
 * charged.
 */
export function lookupUnitRates(
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
): UnitRates | null {
  const snapshot = readOpenRouterCacheSync(defaultCatalogueCachePath(env));
  // ⚠️ TRY THE ID AS GIVEN BEFORE STRIPPING, AND THE ORDER IS THE FIX.
  // `openrouter/` is usually a SELECTOR prefix (`openrouter/z-ai/glm-5.3-flash` →
  // the row `z-ai/glm-5.3-flash`), but it is also a real VENDOR: the row
  // `openrouter/auto-beta` IS its own id. Stripping unconditionally makes every
  // openrouter-vendor model unfindable, which prices a real session as `unpriced`
  // — caught by the drift pin against the live catalogue, not reasoned about.
  const row =
    snapshot?.models.find((model) => model.id === modelId) ??
    (modelId.startsWith("openrouter/")
      ? snapshot?.models.find((model) => model.id === modelId.slice("openrouter/".length))
      : undefined);
  if (!row) {
    return null;
  }
  return ratesFromPricing(row.pricing);
}

/**
 * Fold one observation into the session's persisted cost state.
 *
 * ## 🛑 THE `reported` RULE — this function DEFINES it, it does not inherit it
 *
 * `deriveCostFigure` emits only `unpriced`, `free` and `computed`; `reported` had
 * no producer anywhere in the tree, so the ingest is where its contract is set:
 *
 *   - **A zero adapter figure beside NON-ZERO tokens is NEVER `reported`.** It
 *     goes to the unit path, which answers `computed` when a catalogue price
 *     exists and `unpriced` when none does.
 *   - `reported` requires a non-zero adapter figure, or a zero with zero tokens.
 *
 * **Why this is the load-bearing rule and not a nicety:** a harness handed a
 * fabricated catalogue entry with zeroed rates computes `cost.total = 0` and
 * reports it TRUTHFULLY — measured on pi, 2026-09-08: `cost.amount 0` beside
 * 7,906 real tokens. If ingest trusted that as `reported`, Daniel's original bug
 * would return through the one provenance whose contract is "trust the adapter":
 * a confident `$0.00` on a session that was never priced.
 */
export function rememberSessionCost(
  acpx: SessionAcpxState,
  observation: UsageObservation,
  lookupRates: RateLookup = (modelId) => lookupUnitRates(modelId),
): void {
  const tokens = observation.input + observation.output;
  const reported = observation.reportedAmount;

  const hasUnits = tokens > 0 || observation.cacheRead > 0 || observation.cacheWrite > 0;
  if (!hasUnits) {
    // No units to price. An adapter figure is all there is — and a ZERO with zero
    // tokens is a legitimate `reported` zero (nothing happened), which is the one
    // zero the rule above admits.
    if (typeof reported === "number") {
      acpx.cost = reportedCost(reported);
    }
    return;
  }

  const modelId = acpx.current_model_id;
  const unit: CostUnit = {
    input: observation.input,
    output: observation.output,
    cacheRead: observation.cacheRead,
    cacheWrite: observation.cacheWrite,
    rates: modelId ? lookupRates(modelId) : null,
  };

  const units = [...(acpx.cost_units ?? []), unit];
  acpx.cost_units = units;
  acpx.cost = deriveCostFigure(units);
}

/** Re-derive from the persisted units — used after a cold resume, where the
 *  figure must not restart from zero. The units carry their own rates, so this
 *  cannot disagree with what ingest computed. */
export function costFigureFromUnits(acpx: SessionAcpxState): SessionCostFigure | undefined {
  const units = acpx.cost_units;
  return units && units.length > 0 ? deriveCostFigure(units) : undefined;
}

/**
 * ⚠️ DERIVED HERE RATHER THAN VIA `deriveBilling`, AND THE REASON IS THE BUNDLE.
 *
 * `models/catalogue.ts` pulls in `acp/harness-capabilities.ts` and the capability
 * chain. Importing it from THIS module — which the `usage_update` handler calls on
 * every assistant message — put a heavy subgraph on a hot path and, in the BUNDLED
 * `dist/` build, produced a circular initialisation that silently killed the whole
 * update: measured 2026-09-08 in a paired real-turn control, same cwd, same model,
 * same prompt, only the binary varied —
 *
 *     deployed build : context_window_size 262144   ✓
 *     with that import: context_window_size null    ✗   (a PRE-EXISTING field, killed)
 *
 * The unit suite was green in both. `dist-test/` preserves modules and the bundle
 * does not, so the failure was invisible to every test and visible only on a real
 * turn — which is precisely the trap this brick is about.
 *
 * ⇒ This module depends ONLY on leaves: `cost-provenance.ts` (no imports) and
 * `openrouter-catalogue.ts` (node built-ins only).
 *
 * 🛑 THE DUPLICATION IS PINNED, NOT TRUSTED. `cost-ingest.test.ts` asserts this
 * agrees with `deriveBilling` on the real catalogue rows, so the two cannot drift
 * apart silently — do not "simplify" it back into an import.
 */
function ratesFromPricing(pricing: OpenRouterRawModel["pricing"]): UnitRates {
  const prompt = pricing?.prompt;
  // `-1` is OpenRouter's VARIABLE marker — a price that exists but is not quoted.
  // It is not zero and it is not free; it is unpriceable, which `deriveCostFigure`
  // turns into `unpriced`.
  if (prompt === "-1") {
    return {
      inPerM: null,
      outPerM: null,
      cacheReadPerM: null,
      cacheWritePerM: null,
      measuredFree: false,
    };
  }
  const inPerM = perMillion(prompt);
  const outPerM = perMillion(pricing?.completion);
  const cacheReadPerM = perMillion(pricing?.input_cache_read);
  const cacheWritePerM = perMillion(pricing?.input_cache_write);
  // A MEASURED zero: the row QUOTES zero on both billed axes. An unquoted rate is
  // `null`, never 0, so absence of a ROW can never reach `free`.
  const measuredFree = inPerM === 0 && (outPerM ?? 0) === 0;
  if (measuredFree) {
    // ⚠️ ON THE FREE BRANCH, UNQUOTED CACHE RATES ARE ZERO — mirroring
    // `deriveBilling`. Leaving them `null` here is not conservative, it is WRONG:
    // `priceUnit` refuses a unit whose cacheRead is non-zero with a null cache
    // rate, so a genuinely free model that used cached tokens would come back
    // `unpriced` instead of `free` — the exact conflation this brick removes,
    // inverted. (Caught by the drift pin against a real row,
    // `inclusionai/ling-3.0-flash-sante:free`, which quotes 0/0 and no cache rates.)
    return {
      inPerM: 0,
      outPerM: 0,
      cacheReadPerM: cacheReadPerM ?? 0,
      cacheWritePerM: cacheWritePerM ?? 0,
      measuredFree: true,
    };
  }
  return { inPerM, outPerM, cacheReadPerM, cacheWritePerM, measuredFree };
}

/** USD-per-token (OpenRouter's unit) → USD per 1M, which is what `UnitRates` states. */
function perMillion(rate: string | number | null | undefined): number | null {
  const value = typeof rate === "string" ? Number.parseFloat(rate) : rate;
  return typeof value === "number" && Number.isFinite(value) ? value * 1_000_000 : null;
}
