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
 *   openrouter model                → PICKER route (here): the picked slug, on the
 *                                     BOX key from `~/.acpx/providers.json`.
 *   openrouter PROFILE, no model    → LEGACY route (`applyOpenRouterProfileAuth`):
 *                                     the profile's model on the profile's own
 *                                     account. Untouched by this module.
 *   a claude-native alias           → no shim at all.
 *   openrouter model + an
 *     OPENROUTER-KIND profile       → refused loudly ({@link assertNoOpenRouterProfileConflict}).
 *
 * ⚠️ THE REFUSAL TURNS ON THE PROFILE'S KIND, NOT ON A PROFILE BEING PRESENT. A
 * `[claude/subscription]` profile plus an OpenRouter model is NOT two accounts —
 * a Claude subscription cannot serve an OpenRouter model at all — and it takes
 * the picker route. Refusing it made the feature unreachable from the UI; the
 * argument is on {@link resolveOpenRouterRoute}.
 *
 * ⚠️ THE ROUTE ASKS `deriveAcceptsArbitraryModelIds`, NOT A LITERAL. That is what
 * makes the DECLARATION (the band the picker offers) and the ROUTING (what a spawn
 * actually does) one predicate rather than two lists to keep in step — the exact
 * failure `ARBITRARY_MODEL_SUPPORT_ROUTED_BY_ACPX`'s own comment warns about for
 * `provisioned`. Drop `via-shim` from that array and this module routes nothing,
 * in the same edit, with no window where acpx offers a band it does not serve.
 */

import { findProfile, loadProfileRegistry, type ProfileRegistry } from "../config/profiles.js";
import {
  loadBoxProviders,
  resolveBoxProviderKey,
  type BoxProviderLookupOptions,
} from "../config/providers.js";
import type { SubscriptionLookupOptions } from "../config/subscriptions.js";
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
  /**
   * Inject the profile registry instead of reading `~/.acpx/subscriptions/`. The
   * profile's KIND is what the two-accounts guard turns on, so a test that could
   * not supply one would have to be name-shaped — the exact mistake this option
   * exists to keep out of the tests as well as out of the code.
   */
  profileRegistry?: ProfileRegistry;
  /** Root the profile-registry read somewhere else (an isolated HOME). */
  profileLookup?: SubscriptionLookupOptions;
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
 * WHY a picker-route spawn did not use the profile it was handed — the answers
 * the old boolean folded into a single `false` (brick 069fdebe).
 *
 * ⚠️ THE SPLIT THAT MATTERS IS *MEASURED* vs *UNEVALUABLE*, NOT WHICH PROFILE.
 * `not-an-openrouter-account` means the registry was read, names profiles, and
 * this one is not an OpenRouter account — the second-account guard EVALUATED and
 * passed. The other two mean the guard evaluated nothing, so a spawn that really
 * did name two OpenRouter accounts would NOT have been refused on this box. Both
 * take the picker route regardless; the difference survives nowhere but the log
 * line, which is the whole point of naming it.
 */
export type ProfileBypassReason =
  | "not-an-openrouter-account"
  | "registry-holds-no-profiles"
  | "registry-unreadable";

/** A profile that was supplied and NOT used, with the reason it was not. */
export type ProfileBypass = {
  profileId: string;
  reason: ProfileBypassReason;
};

/** Which of the three routes a spawn takes, decided in ONE place. */
export type OpenRouterRoute =
  | { kind: "none" }
  | { kind: "profile"; profileId: string }
  | { kind: "picker"; model: string; profileBypass?: ProfileBypass };

/**
 * THE ROUTE DECISION, as a pure function.
 *
 * ⚠️ IT EXISTS SEPARATELY FROM `AcpClient.applyProfileEnv` BECAUSE THE COMPOSITION
 * IS THE LOAD-BEARING PART, and testing the pieces is not testing it. Each half —
 * "is this an OpenRouter slug", "is there a profile", "refuse both" — is trivially
 * testable and individually correct; what decides whether a picker-chosen model
 * quietly bills the wrong account is the ORDER they are asked in. Left inside the
 * client, that order could only be exercised by spawning an adapter.
 *
 * ⚠️ THE MODEL IS RESOLVED EVEN WHEN A PROFILE IS SET, and that is not wasted
 * work — it is what makes the conflict DETECTABLE. Returning `profile` on the
 * strength of `profileId` alone would take the legacy route and silently bill a
 * picker-chosen model to the profile's account: the billing-decision-by-omission
 * this brick exists to prevent, and the case the rejected one-route design could
 * not even see.
 *
 * ⚠️ ONLY AN OPENROUTER-KIND PROFILE IS A SECOND ACCOUNT — AND THE FIRST CUT OF
 * THIS FUNCTION GOT THAT WRONG, WHICH CLOSED THE FEATURE OFF ENTIRELY. It refused
 * on `profileId` alone, without asking the profile's KIND, so a
 * `[claude/subscription]` profile plus an OpenRouter model was refused as "two
 * OpenRouter accounts" when a Claude subscription is not an OpenRouter account at
 * all and cannot serve the model. That was not an inconvenience but a DEAD END:
 * acpx-ui sends no `--profile` and normalises `profileId "" → undefined`
 * (`CreateSessionPanel:1110`), so there is no way to express *"no profile"* from
 * the UI; acpx applies the box default (a subscription profile), the guard
 * refused, and the refusal's own advice — *"drop --profile sub5"* — was not
 * executable from the UI. **A user following the error message exactly could not
 * comply**, and Daniel's founding item 6 was unreachable from the frontend.
 * Measured by te-live in three probes on the deployed build.
 *
 * ⚠️ THE KIND COMES FROM THE PROFILE RECORD, NEVER FROM THE PROFILE'S NAME. On
 * this box `sub3`/`sub5` happen to look like subscriptions and
 * `openrouter-deepseek` happens to look like OpenRouter — a name-shaped test
 * would pass all three of te-live's probes tonight and break on the first profile
 * someone names differently.
 *
 * ⚠️ ON THE PICKER ROUTE THE NON-OPENROUTER PROFILE'S AUTH IS NOT APPLIED, and
 * that is deliberate rather than an omission. Its credential cannot serve an
 * OpenRouter model, and the shim's own isolated `CLAUDE_CONFIG_DIR` (no OAuth
 * inheritance) is what the adapter must run under; applying the subscription
 * first would also run `verifyProfileEffectiveAccount` against a config dir the
 * shim then discards — able to FAIL a create for a credential the session never
 * uses. `startPickerShim` says so on the log line rather than leaving it silent.
 */
export async function resolveOpenRouterRoute(params: {
  agentCommand: string | undefined;
  model: string | undefined;
  profileId: string | undefined | null;
  options?: OpenRouterRouteOptions;
}): Promise<OpenRouterRoute> {
  const profileId = params.profileId?.trim();
  const routeModel = await resolveOpenRouterRouteModel({
    agentCommand: params.agentCommand,
    model: params.model,
    ...(params.options ? { options: params.options } : {}),
  });
  if (!profileId) {
    return routeModel === undefined ? { kind: "none" } : { kind: "picker", model: routeModel };
  }
  if (routeModel === undefined) {
    return { kind: "profile", profileId }; // the legacy path, untouched
  }
  const profileBypass = classifyProfileBypass(profileId, params.options);
  if (!profileBypass) {
    assertNoOpenRouterProfileConflict({ profileId, routeModel });
  }
  // The key is OMITTED rather than set to `undefined`: a no-profile picker route
  // must stay deep-equal to what it was before this field existed.
  return { kind: "picker", model: routeModel, ...(profileBypass ? { profileBypass } : {}) };
}

/**
 * Why this profile is NOT used on the picker route — or `undefined` when it IS an
 * OpenRouter account, i.e. the second payer {@link assertNoOpenRouterProfileConflict}
 * then refuses.
 *
 * ⚠️ NO BEHAVIOUR CHANGES HERE, DELIBERATELY (brick 069fdebe). Every answer below
 * still takes the picker route. Refusing on anything short of a real second
 * account would reinstate the dead end this module exists to remove, on every box
 * whose registry cannot be read — and the UI always sends a profile, so that dead
 * end would be total. This function only records WHICH question got answered.
 *
 * ⚠️ AN UNRESOLVABLE PROFILE STILL ANSWERS "not an account", WHICH SENDS THE SPAWN
 * DOWN THE PICKER ROUTE. That is the conservative answer for THIS question — it
 * refuses nothing on a guess — but it does move where a bad profile id is
 * reported: with an OpenRouter model picked, `applyProfileAuth`'s *"profile not
 * found in registry"* no longer fires, because the profile is genuinely not used.
 * A missing profile stops being an error and becomes a profile that does not apply.
 *
 * ⚠️ `registry-holds-no-profiles` IS THE REASON A BROKEN REGISTRY ACTUALLY
 * PRODUCES — NOT `registry-unreadable`, WHICH IS THE OBVIOUS-LOOKING BRANCH AND
 * IS VIRTUALLY UNREACHABLE. Measured 2026-09-07: `loadProfileRegistry` never
 * throws and never returns nothing — an ABSENT, a CORRUPT and a mode-000
 * UNREADABLE registry file all come back as an EMPTY registry (`profiles = 0`),
 * against a control registry that returned 1. So the box the brick is about —
 * the one whose second-account guard is not really being applied — arrives HERE,
 * not below, and until this split it was reported in exactly the same words as a
 * profile that was read and found to be a Claude subscription.
 *
 * ⚠️ AN EMPTY REGISTRY IS ALSO WHAT A BOX WITH NO PROFILES CONFIGURED LOOKS LIKE,
 * and this reason does not pretend to tell those apart. It states what was
 * established — there was nothing to evaluate against — and not a cause nobody
 * measured. Naming an unmeasured cause is the defect this brick is about, one
 * level up.
 */
function classifyProfileBypass(
  profileId: string,
  options: OpenRouterRouteOptions | undefined,
): ProfileBypass | undefined {
  const registry = options?.profileRegistry ?? loadProfileRegistrySafely(options);
  if (!registry) {
    // Reachable only if `loadProfileRegistry` breaks its own never-throw
    // contract. Named anyway: the cost is one word, and an unevaluable state
    // that is silent is exactly what this brick exists to remove.
    return { profileId, reason: "registry-unreadable" };
  }
  if (registry.profiles.length === 0) {
    return { profileId, reason: "registry-holds-no-profiles" };
  }
  if (findProfile(profileId, registry)?.authMode === "openrouter") {
    return undefined;
  }
  return { profileId, reason: "not-an-openrouter-account" };
}

/** Same never-throw-into-session-creation rule the catalogue read follows. */
function loadProfileRegistrySafely(
  options: OpenRouterRouteOptions | undefined,
): ProfileRegistry | undefined {
  try {
    return loadProfileRegistry(options?.profileLookup);
  } catch {
    return undefined;
  }
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
