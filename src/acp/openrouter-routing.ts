/**
 * The PICKER → SHIM route for a `via-shim` harness (today: claude only).
 *
 * Brick 007eaac8 — Daniel's founding item 6: *"the Claude harness can already run
 * on other LLM backends (an OpenRouter profile exists in the CLI), but I cannot
 * find it in the frontend."* The capability was never missing and never broken:
 * the CLI reaches OpenRouter for claude through a **profile**, and the shim took
 * its model from that profile, so the picker had no way in. This module is the
 * missing half. Full argument, the two designs considered, and the credential
 * ruling: brick 007eaac8 `conception/CONCEPTION-L7-via-shim-routing.md`.
 *
 * ## The route is chosen by the MODEL, not by whether a profile is attached
 *
 *   openrouter model, no profile  → PICKER route (here): the picked slug, on the
 *                                   BOX key from `~/.acpx/providers.json`.
 *   openrouter PROFILE, no model  → LEGACY route (`applyOpenRouterProfileAuth`):
 *                                   the profile's model on the profile's own
 *                                   account. Untouched by this module.
 *   a claude-native alias         → no shim at all.
 *   BOTH                          → refused loudly ({@link assertNoOpenRouterProfileConflict}).
 *
 * ⚠️ THE ROUTE ASKS `deriveAcceptsArbitraryModelIds`, NOT A LITERAL. That is what
 * makes the DECLARATION (the band the picker offers) and the ROUTING (what a spawn
 * actually does) one predicate rather than two lists to keep in step — the exact
 * failure `ARBITRARY_MODEL_SUPPORT_ROUTED_BY_ACPX`'s own comment warns about for
 * `provisioned`. Drop `via-shim` from that array and this module routes nothing,
 * in the same edit, with no window where acpx offers a band it does not serve.
 */

import {
  loadBoxProviders,
  resolveBoxProviderKey,
  type BoxProviderLookupOptions,
} from "../config/providers.js";
import { AcpxOperationalError } from "../errors.js";
import { findModelsById, loadCatalogue } from "../models/catalogue.js";
import { nativeAgentTypesForSource } from "../models/harness-models.js";
import { parseModelRef } from "../models/model-slug-validation.js";
import type { ModelCatalogue } from "../models/types.js";
import type { ArbitraryModelSupport, HarnessId } from "./harness-capabilities.js";
import {
  ARBITRARY_MODEL_SUPPORT_ROUTED_BY_ACPX,
  deriveAcceptsArbitraryModelIds,
  HARNESS_FACTS,
  harnessIdForAgentCommand,
} from "./harness-capabilities.js";

/**
 * The catalogue source this route serves, and the `providers.json` entry NAME
 * that pays for it. One constant, deliberately: the join is *"the model's source
 * names the provider that pays for it"*, which is the rule that generalises to a
 * second source rather than a claude-shaped special case.
 */
export const OPENROUTER_SOURCE = "openrouter" as const;

/** Thrown when a spawn names two OpenRouter accounts at once. USAGE, not RUNTIME. */
export class OpenRouterRouteConflictError extends AcpxOperationalError {
  constructor(message: string) {
    super(message, {
      outputCode: "USAGE",
      detailCode: "OPENROUTER_ROUTE_CONFLICT",
      origin: "cli",
    });
    this.name = "OpenRouterRouteConflictError";
  }
}

/** Thrown when the route is taken on a box that holds no OpenRouter credential. */
export class OpenRouterBoxCredentialMissingError extends AcpxOperationalError {
  constructor(message: string) {
    super(message, {
      outputCode: "USAGE",
      detailCode: "OPENROUTER_BOX_CREDENTIAL_MISSING",
      origin: "cli",
    });
    this.name = "OpenRouterBoxCredentialMissingError";
  }
}

export type OpenRouterRouteOptions = {
  /** Inject the routed-support list so a test can watch the answer flip. */
  routedSupport?: readonly ArbitraryModelSupport[];
  /** Root `providers.json` resolution somewhere else (tests, an isolated HOME). */
  homeDir?: string;
  /** Bypass `homeDir` and read this exact `providers.json`. */
  providersPath?: string;
  /** Environment consulted for the `apiKeyEnv` indirection and the last-resort fallback. */
  env?: NodeJS.ProcessEnv;
  /**
   * Inject the catalogue instead of reading the box's cache. Tests use it so the
   * answer does not depend on whether anyone has run `acpx models` on this box —
   * an environment-dependent test here would read as a routing bug.
   */
  catalogue?: ModelCatalogue;
};

/**
 * Whether this harness reaches arbitrary model ids through the shim AND acpx
 * routes that kind today. Both terms are required, and the second one is the
 * array — see the header.
 */
export function harnessRoutesModelViaShim(
  harness: HarnessId | undefined,
  routedSupport: readonly ArbitraryModelSupport[] = ARBITRARY_MODEL_SUPPORT_ROUTED_BY_ACPX,
): boolean {
  if (harness === undefined) {
    return false;
  }
  const support = HARNESS_FACTS[harness].arbitraryModelSupport;
  return support === "via-shim" && deriveAcceptsArbitraryModelIds(support, harness, routedSupport);
}

/**
 * The OpenRouter slug this spawn must serve out of band, or `undefined` for
 * *"not this route"*.
 *
 * ⚠️ `undefined` IS THE STAND-ASIDE ANSWER AND IT COVERS A COLD CACHE. With no
 * OpenRouter rows cached, acpx cannot tell a slug it has not fetched from an
 * alias, so it does not route — the same rule `validateModelSelection` already
 * follows on the `--model` gate (C4 §7.1 option 3). A session creation must never
 * fail because a third-party catalogue fetch was slow or down, and this path
 * never touches the network.
 *
 * ⚠️ A HARNESS-NATIVE ROW WINS. If the id also answers to a source this agent can
 * spawn natively (`sonnet` under `claude-subscription`), the native reading is the
 * one the caller meant and no shim is started. Only rows that are exclusively
 * OpenRouter take the route.
 */
export async function resolveOpenRouterRouteModel(params: {
  agentCommand: string | undefined;
  model: string | undefined;
  options?: OpenRouterRouteOptions;
}): Promise<string | undefined> {
  const raw = params.model?.trim();
  const harness = harnessIdForAgentCommand(params.agentCommand);
  if (!raw || !harnessRoutesModelViaShim(harness, params.options?.routedSupport)) {
    return undefined;
  }

  const ref = parseModelRef(raw);
  // An explicit source prefix settles it without a catalogue read, either way.
  // A bracket is a context-window hint on claude (`sonnet[1m]`), never part of an
  // OpenRouter slug — and OpenRouter's own `:free` / `:batch` suffixes survive
  // `parseModelRef` intact, so `ref.id` is exactly what OpenRouter expects.
  if (ref.source !== null) {
    return ref.source === OPENROUTER_SOURCE ? ref.id : undefined;
  }

  const catalogue = await loadRouteCatalogue(params.options);
  return catalogue === undefined ? undefined : routeIdFromCatalogue(catalogue, ref.id, harness);
}

/**
 * ⚠️ NEVER THROWS INTO SESSION CREATION. `loadBoxProviders` degrades on a missing
 * or malformed file for exactly this reason, and the catalogue read is on the
 * same path: an unreadable cache must mean "acpx cannot say", which is the
 * stand-aside answer, not a failed spawn.
 */
async function loadRouteCatalogue(
  options: OpenRouterRouteOptions | undefined,
): Promise<ModelCatalogue | undefined> {
  if (options?.catalogue) {
    return options.catalogue;
  }
  try {
    return await loadCatalogue({ offline: true });
  } catch {
    return undefined;
  }
}

/**
 * ⚠️ A HARNESS-NATIVE ROW WINS. If the id also answers to a source this agent can
 * spawn natively (`sonnet` under `claude-subscription`), the native reading is the
 * one the caller meant and no shim is started — a resolver that merely asked *"is
 * this id in the catalogue?"* would take a claude session off its subscription
 * silently. Only rows that are exclusively OpenRouter take the route.
 */
function routeIdFromCatalogue(
  catalogue: ModelCatalogue,
  id: string,
  harness: HarnessId | undefined,
): string | undefined {
  const rows = findModelsById(catalogue, id);
  const nativeToThisAgent = rows.some((row) => {
    const owners = nativeAgentTypesForSource(row.source);
    return harness !== undefined && owners !== null && owners.includes(harness);
  });
  if (nativeToThisAgent) {
    return undefined;
  }
  // An empty `rows` is an unknown slug OR a cold cache — stand aside on both.
  return rows.some((row) => row.source === OPENROUTER_SOURCE) ? id : undefined;
}

/**
 * Refuse a spawn that names TWO OpenRouter accounts — a profile (its own account,
 * its own budget) and a picker-chosen model (the box key).
 *
 * ⚠️ REFUSING IS THE POINT, AND IT COSTS NOTHING TODAY. There is no defensible
 * silent winner: taking the profile's account bills a picker-chosen model to an
 * account Daniel's per-box design says it must not, with nothing on any surface
 * saying so; taking the box key silently ignores the credential the caller
 * explicitly selected. Either way it is a billing decision made by omission.
 * The combination is UNREACHABLE before this brick — an OpenRouter row on a
 * claude session is rejected at the `--model` gate with
 * `MODEL_NOT_AVAILABLE_FOR_AGENT` — so this refusal breaks nothing that works;
 * it fences off a case this brick creates.
 */
export function assertNoOpenRouterProfileConflict(params: {
  profileId: string;
  routeModel: string;
}): void {
  throw new OpenRouterRouteConflictError(
    `[acpx] this session names two OpenRouter accounts: profile "${params.profileId}" (its own ` +
      `account and budget) and --model "${params.routeModel}" (the box key in ` +
      `~/.acpx/providers.json). acpx will not choose which one pays.\n` +
      `  either drop --profile ${params.profileId} to run "${params.routeModel}" on the box key,\n` +
      `  or drop --model to run the profile's own model on the profile's account.`,
  );
}

export type OpenRouterBoxCredential = {
  /** ⚠️ SECRET. Put it in a child environment and nowhere else. */
  key: string;
  /** Where it came from — for a log line that must never carry the value. */
  origin: "providers.json" | "environment";
  /** The declared variable NAME (never a value). */
  envName: string;
};

/**
 * The box's OpenRouter credential for the picker route.
 *
 * ⚠️ FILE FIRST, AND THAT IS THE OPPOSITE OF `applyBoxProviderEnv` ON PURPOSE.
 * `applyBoxProviderEnv` is a strict fallback because it must not stomp a caller's
 * deliberate export into the AGENT env. The shim's key is a different question:
 * it is a credential the BOX owns, and **a rotated key never reaches an
 * already-running process** — an inherited `OPENROUTER_API_KEY` in a long-lived
 * queue owner is exactly the stale value that cost this programme a day on
 * 2026-09-06. Reading `providers.json` at spawn means the shim gets the key the
 * box actually holds now. The ambient variable is a last resort for a box that
 * declares no provider entry at all, and it is named in the returned `origin` so
 * a diagnostic can say WHICH — without ever holding the value.
 */
export function resolveOpenRouterBoxCredential(
  options?: OpenRouterRouteOptions,
): OpenRouterBoxCredential | undefined {
  const sourceEnv = options?.env ?? process.env;
  const fromFile = credentialFromProvidersFile(options, sourceEnv);
  if (fromFile) {
    return fromFile;
  }
  const ambient = sourceEnv.OPENROUTER_API_KEY;
  if (typeof ambient === "string" && ambient.trim().length > 0) {
    return { key: ambient, origin: "environment", envName: "OPENROUTER_API_KEY" };
  }
  return undefined;
}

/** The route's options, narrowed to what `loadBoxProviders` takes. Split out
 *  only to keep the resolver under the complexity budget. */
function providerLookup(options: OpenRouterRouteOptions | undefined): BoxProviderLookupOptions {
  return {
    ...(options?.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    ...(options?.providersPath !== undefined ? { providersPath: options.providersPath } : {}),
    ...(options?.env !== undefined ? { env: options.env } : {}),
  };
}

function credentialFromProvidersFile(
  options: OpenRouterRouteOptions | undefined,
  sourceEnv: NodeJS.ProcessEnv,
): OpenRouterBoxCredential | undefined {
  const entry = loadBoxProviders(providerLookup(options)).providers.find(
    (provider) => provider.name === OPENROUTER_SOURCE,
  );
  if (!entry) {
    return undefined;
  }
  const key = resolveBoxProviderKey(entry, sourceEnv);
  return key ? { key, origin: "providers.json", envName: entry.env } : undefined;
}

/** The refusal for a box that holds no OpenRouter credential at all. */
export function openRouterBoxCredentialMissing(
  routeModel: string,
): OpenRouterBoxCredentialMissingError {
  return new OpenRouterBoxCredentialMissingError(
    `[acpx] --model "${routeModel}" is an OpenRouter model, but this box holds no OpenRouter ` +
      `credential: ~/.acpx/providers.json declares no "${OPENROUTER_SOURCE}" entry and ` +
      `OPENROUTER_API_KEY is unset.\n` +
      `  run: acpx providers   (a box key is minted per box, never copied between boxes)`,
  );
}
