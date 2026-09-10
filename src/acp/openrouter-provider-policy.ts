/**
 * The box-wide OpenRouter PROVIDER policy: read it, validate it, expand it into
 * the `provider` object OpenRouter's API takes (brick 4c272cab).
 *
 * ## What this is for
 *
 * OpenRouter serves one model id from many providers, and they are not
 * interchangeable: `z-ai/glm-5.3-flash` measured **15 tok/s p50 on Wafer** and
 * **132 tok/s on BaseTen at the same list price** (brick 2e264d8a → 4c272cab
 * `conception/MEASUREMENTS.md` §3). Nothing in acpx could express a preference,
 * so a box that drew a bad provider could only abandon the model. This module is
 * the one place that turns a box's stored preference into the wire object, for
 * BOTH OpenRouter paths — the Claude shim and pi's generated `models.json` — so
 * the two harnesses cannot disagree about what the same settings file means.
 *
 * ## The four rules that came out of 16 live probes (MEASUREMENTS.md §1)
 *
 * 1. **`order` is an ordered walk and it is honoured.** Probe J
 *    (`["crusoe","baseten","modal"]`) → Crusoe 429, BaseTen 429, **Modal served**.
 * 2. **🛑 `allow_fallbacks:false` BRICKS THE TURN when the named provider is down,
 *    and a provider being down is NORMAL.** Probes E/F/I are all hard `429` —
 *    BaseTen and Crusoe were both rate-limited on the shared pool during one
 *    afternoon's measurements. So fallbacks default ON and `only` is not
 *    representable in the contract at all: the box-bricking combination is
 *    *unreachable*, not merely discouraged.
 * 3. **An ordered list bounds only its PREFIX.** With `order:["crusoe"]` and
 *    Crusoe down, the request was served by **Z.AI — not in the list** (probe D):
 *    an exhausted `order` falls through to the ACCOUNT DEFAULT POOL. Bounding the
 *    tail is what `quantizations` and `ignore` are for, and why a `perModel`
 *    `order` still inherits the box-wide floor and blocklist.
 * 4. **The `provider` object is STRICTLY validated — a bad one is a 400 on EVERY
 *    TURN.** Probe P (a stray key) and probe R (`quantizations:["int2ish"]`) both
 *    `400`. That is why {@link validateRoutingPolicy} exists and why it runs
 *    before anything is written, not when a session fails.
 *
 * ## ⚠️ `allowUnknownQuantization` DEFAULTS TO `true`. DO NOT "TIDY" IT TO false.
 *
 * It looks backwards — a precision floor that still admits endpoints which
 * declare no precision — and flipping it is a **fleet-wide outage**. Measured
 * 2026-09-10: every endpoint of `anthropic/claude-sonnet-4.5` (7), `openai/gpt-5`
 * (3) and `google/gemini-2.5-flash` (7) reports `quantization: "unknown"`. **No
 * first-party model has a declared-precision endpoint at all**, so an 8-bit floor
 * that excludes `unknown` returns, on every turn of those models:
 *
 *     404  No endpoints found for the request with quantization:
 *          int8,fp8,mxfp8,fp16,bf16,fp32
 *
 * i.e. a user who sets a floor because one model crawled silently kills Claude,
 * GPT and Gemini across the whole box. The "never Wafer" case belongs in
 * `ignore`, which cannot empty an unrelated model's eligible set.
 * `test/openrouter-provider-policy.test.ts` pins the default and the expansion.
 *
 * ## Where the setting lives, and why acpx only READS it
 *
 * `~/.acpx/ui-settings.json` — acpx-ui's existing box-wide store, which acpx-ui
 * writes and validates on `PATCH /api/user-settings`. acpx is a consumer: it
 * tolerates the key being absent (the common case ⇒ nothing is emitted and the
 * request is byte-identical to today), missing, or corrupt, and never throws on
 * the session-spawn path.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The stored, normalised box policy. Every field is optional; `{}` ≡ absent. */
export type OpenRouterRoutingPolicy = {
  /** ONE ladder token; expanded to a `quantizations[]` SET here, never stored expanded. */
  minQuantization?: string;
  /** Defaults `true` — see the header before you change this. */
  allowUnknownQuantization?: boolean;
  /** Advisory (measured: it does not bind — probes O/Q). Percentile-keyed. */
  minThroughput?: OpenRouterThroughputFloor;
  /** Box-wide blocklist, BARE provider slugs. */
  ignore?: string[];
  /** Per-model provider order, merged OVER the box-wide block key by key. */
  perModel?: Record<string, OpenRouterModelRouting>;
};

export type OpenRouterThroughputFloor = {
  p50?: number;
  p75?: number;
  p90?: number;
  p99?: number;
};

export type OpenRouterModelRouting = {
  /** BARE provider slugs, ordered, first = most preferred. */
  order?: string[];
  /** Defaults `true`. `false` is the measured 429 hazard — an explicit opt-in. */
  allowFallbacks?: boolean;
};

/**
 * The wire object, exactly as OpenRouter takes it and exactly as pi forwards it
 * (`model.compat?.openRouterRouting && (params.provider = …)`).
 *
 * ⚠️ `only` IS ABSENT BY DESIGN, not by omission — see rule 2 in the header.
 */
export type OpenRouterProviderObject = {
  order?: string[];
  ignore?: string[];
  quantizations?: string[];
  preferred_min_throughput?: OpenRouterThroughputFloor;
  allow_fallbacks: boolean;
};

/**
 * OpenRouter's own enum, transcribed from the 400 it returns for an illegal
 * token (probe R): *`Invalid option: expected one of "int4"|"int8"|"fp4"|…`*.
 * A token outside this list is a 400 on every turn, so it is refused here.
 */
export const OPENROUTER_QUANTIZATIONS = [
  "int4",
  "int8",
  "fp4",
  "mxfp4",
  "nvfp4",
  "fp6",
  "fp8",
  "mxfp8",
  "fp16",
  "bf16",
  "fp32",
  "unknown",
] as const;

/**
 * The UI's five floor rungs → the `quantizations[]` SET each expands to
 * (DESIGN.md §5.3). OpenRouter's field is a FILTER SET, so a floor is "this tier
 * and every tier above it"; tiers are by BIT-WIDTH, so `int8`/`fp8` share a rung
 * and the 4-bit rung collects `int4/fp4/mxfp4/nvfp4`.
 *
 * ⚠️ **THE FLOOR IS STORED, THE SET IS DERIVED.** Storing the expansion would
 * freeze today's enum into every box's settings file and silently exclude any
 * precision OpenRouter adds later (CONCEPTION K3).
 *
 * `unknown` is OFF-ladder and is appended by {@link expandQuantizationFloor}
 * unless the box explicitly opted out — see the header's outage warning.
 */
const QUANTIZATION_LADDER: Record<string, readonly string[]> = {
  fp4: ["int4", "fp4", "mxfp4", "nvfp4", "fp6", "int8", "fp8", "mxfp8", "fp16", "bf16", "fp32"],
  fp6: ["fp6", "int8", "fp8", "mxfp8", "fp16", "bf16", "fp32"],
  fp8: ["int8", "fp8", "mxfp8", "fp16", "bf16", "fp32"],
  bf16: ["fp16", "bf16", "fp32"],
  fp32: ["fp32"],
};

/** The rungs a box may store as `minQuantization`. */
export const QUANTIZATION_FLOORS = Object.keys(QUANTIZATION_LADDER);

const THROUGHPUT_PERCENTILES = ["p50", "p75", "p90", "p99"] as const;

/**
 * A BARE provider slug: lowercase alphanumerics and hyphens, as
 * `GET /api/v1/providers` publishes them (`Z.AI` → `z-ai`, `BaseTen` →
 * `baseten`, `Io Net` → `io-net`).
 *
 * ⚠️ IT MUST REJECT THE QUALIFIED TAG (`modal/fp8`). Both forms work on the wire
 * (probe N), but the tag couples a stored preference to a *quantization* the
 * floor already expresses — two representations of one intent (CONCEPTION K1).
 * And a wrong slug is INVISIBLE: probe C sent `order:["definitely-not-a-provider"]`
 * and OpenRouter ignored it silently — no error, no warning, no served-by change.
 */
const PROVIDER_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const POLICY_KEYS = new Set([
  "minQuantization",
  "allowUnknownQuantization",
  "minThroughput",
  "ignore",
  "perModel",
]);

const PER_MODEL_KEYS = new Set(["order", "allowFallbacks"]);

/** One rejection, addressed to the field that caused it. */
export type RoutingPolicyError = {
  /** Dotted path into the policy, e.g. `perModel.z-ai/glm-5.3-flash.order[0]`. */
  field: string;
  message: string;
};

// ── Reading the setting ──────────────────────────────────────────────────────

/**
 * Where `ui-settings.json` lives — the SAME order acpx-ui resolves (HoD ruling
 * R-3): an explicit `ACPX_UI_SETTINGS_FILE` wins outright, else
 * `<ACPX_STATE_HOME || $HOME>/.acpx/ui-settings.json`.
 *
 * ⚠️ **TAKES THE `env` IT IS ASKED ABOUT, NOT THE PROCESS'S** (brick ff298f02,
 * stated at length above `defaultCatalogueCachePath`). A caller threading a
 * scoped env — `applyHarnessConfigDir` does, and so does every test built on it
 * — would otherwise silently read the MACHINE's settings file instead of its
 * own, and the test would pass on whatever happens to be in the real `$HOME`.
 * The `env.HOME` leg keeps a no-argument caller byte-identical: on POSIX
 * `os.homedir()` is `$HOME` whenever it is set.
 */
export function uiSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ACPX_UI_SETTINGS_FILE?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  return path.join(
    env.ACPX_STATE_HOME?.trim() || env.HOME?.trim() || os.homedir(),
    ".acpx",
    "ui-settings.json",
  );
}

/**
 * The box's policy, or `undefined` for "no policy" — SYNCHRONOUS, NETWORK-FREE,
 * and it NEVER THROWS.
 *
 * It runs on the session-spawn path, where the same rule already binds
 * `lookupOpenRouterPricing`: a missing file, a truncated file, a hand-mangled
 * one, or a policy that fails validation must all degrade to "no policy" —
 * today's behaviour — rather than making session creation fail. A box cannot be
 * bricked by its own settings file.
 *
 * ⚠️ AN INVALID POLICY IS DROPPED WHOLE, not partially applied. Half a policy is
 * a shape nobody authored and nobody measured; acpx-ui validates on save
 * (`validateRoutingPolicy`, shared), so reaching here invalid means the file was
 * hand-edited.
 */
export function loadBoxRoutingPolicy(
  env: NodeJS.ProcessEnv = process.env,
  settingsPath: string = uiSettingsPath(env),
): OpenRouterRoutingPolicy | undefined {
  const candidate = readSettingsFile(settingsPath)?.openrouterRouting;
  if (candidate === undefined || candidate === null) {
    return undefined;
  }
  if (validateRoutingPolicy(candidate).length > 0) {
    return undefined;
  }
  const policy = candidate as OpenRouterRoutingPolicy;
  // `{}` on disk is treated as absent — the one representation of "auto"
  // (CONCEPTION K4). A hand-edited file cannot introduce a second one.
  return isEmptyPolicy(policy) ? undefined : policy;
}

/** The parsed settings object, or `undefined` for absent / unreadable / mangled. */
function readSettingsFile(settingsPath: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(fs.readFileSync(settingsPath, "utf8")));
  } catch {
    return undefined;
  }
}

function isEmptyPolicy(policy: OpenRouterRoutingPolicy): boolean {
  const scalars = [policy.minQuantization, policy.minThroughput].filter(
    (value) => value !== undefined,
  );
  const entries = (policy.ignore ?? []).length + Object.keys(policy.perModel ?? {}).length;
  return scalars.length === 0 && entries === 0;
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Every reason this candidate could not be a policy. Empty ⇒ legal.
 *
 * Shared with acpx-ui's `PATCH /api/user-settings` so the CLI and the UI cannot
 * disagree about what is legal — and it is what stands between a typo and a box
 * where **every turn 400s** (rule 4 in the header).
 */
export function validateRoutingPolicy(candidate: unknown): RoutingPolicyError[] {
  const record = asRecord(candidate);
  if (!record) {
    return [{ field: "openrouterRouting", message: "must be an object" }];
  }
  const errors: RoutingPolicyError[] = [];
  for (const key of Object.keys(record)) {
    if (!POLICY_KEYS.has(key)) {
      errors.push({ field: key, message: `unknown key "${key}"` });
    }
  }
  checkFloor(record.minQuantization, errors);
  checkBoolean(record.allowUnknownQuantization, "allowUnknownQuantization", errors);
  checkThroughput(record.minThroughput, errors);
  checkSlugList(record.ignore, "ignore", errors);
  checkPerModel(record.perModel, errors);
  return errors;
}

function checkFloor(value: unknown, errors: RoutingPolicyError[]): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string" || !(value in QUANTIZATION_LADDER)) {
    errors.push({
      field: "minQuantization",
      message: `must be one of: ${QUANTIZATION_FLOORS.join(", ")}`,
    });
  }
}

function checkBoolean(value: unknown, field: string, errors: RoutingPolicyError[]): void {
  if (value !== undefined && typeof value !== "boolean") {
    errors.push({ field, message: "must be a boolean" });
  }
}

function checkThroughput(value: unknown, errors: RoutingPolicyError[]): void {
  if (value === undefined) {
    return;
  }
  const record = asRecord(value);
  if (!record) {
    errors.push({ field: "minThroughput", message: "must be an object keyed by percentile" });
    return;
  }
  for (const [key, entry] of Object.entries(record)) {
    if (!(THROUGHPUT_PERCENTILES as readonly string[]).includes(key)) {
      errors.push({
        field: `minThroughput.${key}`,
        message: `must be one of: ${THROUGHPUT_PERCENTILES.join(", ")}`,
      });
      continue;
    }
    if (typeof entry !== "number" || !Number.isFinite(entry) || entry <= 0) {
      errors.push({ field: `minThroughput.${key}`, message: "must be a positive number" });
    }
  }
}

function checkSlugList(value: unknown, field: string, errors: RoutingPolicyError[]): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    errors.push({ field, message: "must be an array of bare provider slugs" });
    return;
  }
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || !PROVIDER_SLUG.test(entry)) {
      errors.push({
        field: `${field}[${index}]`,
        message: 'must be a bare provider slug, e.g. "baseten" (not "BaseTen", not "baseten/fp8")',
      });
    }
  }
}

function checkPerModel(value: unknown, errors: RoutingPolicyError[]): void {
  if (value === undefined) {
    return;
  }
  const record = asRecord(value);
  if (!record) {
    errors.push({ field: "perModel", message: "must be an object keyed by model slug" });
    return;
  }
  for (const [slug, entry] of Object.entries(record)) {
    checkPerModelEntry(slug, entry, errors);
  }
}

function checkPerModelEntry(slug: string, entry: unknown, errors: RoutingPolicyError[]): void {
  if (slug.trim().length === 0 || /\s/.test(slug)) {
    errors.push({ field: `perModel.${slug}`, message: "model slug must not be blank" });
  }
  const record = asRecord(entry);
  if (!record) {
    errors.push({ field: `perModel.${slug}`, message: "must be an object" });
    return;
  }
  for (const key of Object.keys(record)) {
    if (!PER_MODEL_KEYS.has(key)) {
      errors.push({ field: `perModel.${slug}.${key}`, message: `unknown key "${key}"` });
    }
  }
  checkSlugList(record.order, `perModel.${slug}.order`, errors);
  checkBoolean(record.allowFallbacks, `perModel.${slug}.allowFallbacks`, errors);
}

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * The floor, as the `quantizations[]` set OpenRouter filters on.
 *
 * ⚠️ THE `unknown` LEG IS THE OUTAGE GUARD. See the module header: without it,
 * an 8-bit floor 404s every first-party model on the box, on every turn.
 */
export function expandQuantizationFloor(floor: string, allowUnknown: boolean): string[] {
  const rungs = QUANTIZATION_LADDER[floor];
  if (!rungs) {
    return [];
  }
  return allowUnknown ? [...rungs, "unknown"] : [...rungs];
}

export type ResolveOptions = {
  /**
   * The per-session tier. DESIGNED FOR, NOT BUILT (CONCEPTION §5.1): no
   * `--provider-policy` flag and no `set provider-policy` verb ship in v1. It is
   * a parameter rather than a TODO so that adding the tier is a caller change,
   * not a change to the merge — the merge is already per-key, so nothing here
   * needs a migration when it arrives.
   */
  sessionRouting?: OpenRouterModelRouting;
};

/**
 * The `provider` object for this model, or `undefined` for "no policy".
 *
 * Precedence, per key: **session pin → `perModel[slug]` → box-wide**. The
 * per-model entry MERGES OVER the box-wide block rather than replacing it — so a
 * `perModel` `order` still inherits the box's floor and blocklist, which is what
 * bounds the fallback tail (rule 3 in the header). That is not a free choice: it
 * is exactly what pi's own `mergeCompat` does with `compat.openRouterRouting`
 * (provider level → model level, key by key), and making acpx disagree would
 * mean the two harnesses applied one settings file differently.
 *
 * 🛑 **IT RETURNS `undefined`, NEVER `{}`.** pi's guard is truthiness —
 * `model.compat?.openRouterRouting && (params.provider = …)` — and `{}` is
 * truthy, so an empty object would put `"provider": {}` on every request: a
 * shape nobody intended and nobody measured. `allow_fallbacks` is added only
 * AFTER the object is known to be non-empty, for the same reason.
 */
export function resolveProviderObject(
  policy: OpenRouterRoutingPolicy | undefined,
  modelSlug: string | undefined,
  options: ResolveOptions = {},
): OpenRouterProviderObject | undefined {
  if (!policy) {
    return undefined;
  }
  const merged: OpenRouterModelRouting = {
    ...lookupPerModel(policy, modelSlug),
    ...options.sessionRouting,
  };
  const object: Omit<OpenRouterProviderObject, "allow_fallbacks"> = {
    ...orderKey(merged),
    ...boundsKeys(policy),
  };
  if (Object.keys(object).length === 0) {
    return undefined;
  }
  // Emitted explicitly rather than left to OpenRouter's default: `false` is the
  // measured 429 hazard, so the value in force should be visible in the body a
  // capture server (or a support ticket) sees, not inferred from an absence.
  return { ...object, allow_fallbacks: merged.allowFallbacks !== false };
}

/** The one key a `perModel` entry (or a future session pin) contributes. */
function orderKey(merged: OpenRouterModelRouting): { order?: string[] } {
  return merged.order && merged.order.length > 0 ? { order: [...merged.order] } : {};
}

/**
 * The box-wide bounds. They are emitted ALONGSIDE `order`, never instead of it:
 * an exhausted `order` falls through to the account default pool (probe D), and
 * these are the only keys that constrain that tail.
 */
function boundsKeys(
  policy: OpenRouterRoutingPolicy,
): Omit<OpenRouterProviderObject, "allow_fallbacks" | "order"> {
  const bounds: Omit<OpenRouterProviderObject, "allow_fallbacks" | "order"> = {};
  if (policy.ignore && policy.ignore.length > 0) {
    bounds.ignore = [...policy.ignore];
  }
  const quantizations = quantizationsFor(policy);
  if (quantizations) {
    bounds.quantizations = quantizations;
  }
  if (policy.minThroughput && Object.keys(policy.minThroughput).length > 0) {
    bounds.preferred_min_throughput = { ...policy.minThroughput };
  }
  return bounds;
}

function quantizationsFor(policy: OpenRouterRoutingPolicy): string[] | undefined {
  if (!policy.minQuantization) {
    return undefined;
  }
  const expanded = expandQuantizationFloor(
    policy.minQuantization,
    policy.allowUnknownQuantization !== false,
  );
  return expanded.length > 0 ? expanded : undefined;
}

/**
 * The `perModel` entry for this model.
 *
 * The `openrouter/` strip mirrors `lookupUnitRates`: a picked slug may carry the
 * source as a SELECTOR prefix (`openrouter/z-ai/glm-5.3-flash` → the settings
 * key `z-ai/glm-5.3-flash`), and pi is handed ids with that prefix already
 * stripped. Exact match wins, so a model whose id genuinely begins `openrouter/`
 * (the real vendor, e.g. `openrouter/auto-beta`) still finds its own entry.
 */
function lookupPerModel(
  policy: OpenRouterRoutingPolicy,
  modelSlug: string | undefined,
): OpenRouterModelRouting {
  if (!modelSlug || !policy.perModel) {
    return {};
  }
  const exact = policy.perModel[modelSlug];
  if (exact) {
    return exact;
  }
  const prefix = "openrouter/";
  if (modelSlug.startsWith(prefix)) {
    return policy.perModel[modelSlug.slice(prefix.length)] ?? {};
  }
  return {};
}

/**
 * The one call a spawn path makes: read the box's settings and resolve this
 * model's `provider` object, or `undefined`. Never throws, never touches the
 * network.
 */
export function resolveBoxProviderObject(
  env: NodeJS.ProcessEnv,
  modelSlug: string | undefined,
  options: ResolveOptions = {},
): OpenRouterProviderObject | undefined {
  return resolveProviderObject(loadBoxRoutingPolicy(env), modelSlug, options);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
