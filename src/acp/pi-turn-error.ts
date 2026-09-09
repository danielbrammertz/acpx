/**
 * Turning a pi turn failure into something a human can act on (brick 0095b715).
 *
 * ## The failure this exists for
 *
 * A pi turn that dies on a provider's token limit reaches the user as the raw
 * provider payload, JSON-inside-JSON, with the newlines escaped:
 *
 *     pi could not complete the turn: 400: {"message":"Provider returned error",
 *     "code":400,"metadata":{"raw":"[{\n  \"error\": {\n    \"code\": 400,\n
 *     \"message\": \"Requested maximum tokens of 227043 exceeds the maximum
 *     output tokens limit: 102400.\",\n ...
 *
 * It never names the model. It reads like acpx broke — the first person to hit
 * it concluded pi itself was unusable, when one model out of 363 was at fault.
 * `{@link PI_MAX_OUTPUT_TOKENS}` removes the common case by asking for less;
 * this removes the *illegibility* of whatever is left, and the residue cannot be
 * closed by data: a provider's enforced ceiling is only knowable by being
 * refused, so there will always be a first turn that discovers a new one.
 *
 * ## Why the raw text is kept
 *
 * The explanation is acpx's own words, not a reformatting of the provider's —
 * reformatting is what made this illegible in the first place. But the original
 * is appended verbatim, because it is the only record of what the provider
 * actually said and the only thing worth quoting in a bug report.
 *
 * ## The patterns are transcribed, not invented
 *
 * Every regex below matches a string measured on the wire on 2026-09-08, across
 * 1 109 live (model, provider-endpoint) probes. They are deliberately anchored
 * on the distinctive noun phrases rather than on JSON structure, because each
 * provider wraps its own error differently and several double-encode it.
 */

/** The provider refused the OUTPUT-token request itself. */
const OUTPUT_CEILING_PATTERNS: RegExp[] = [
  // Google (Vertex): "Requested maximum tokens of 227044 exceeds the maximum
  // output tokens limit: 102400."
  /requested maximum tokens of\s+(\d+)\s+exceeds the maximum output tokens limit:\s*(\d+)/i,
  // Novita: "max_tokens: 100352 exceeds maximum 98304"
  /max_tokens:\s*(\d+)\s+exceeds maximum\s+(\d+)/i,
  // BaseTen: "Invalid request: ['max_tokens (943710): Input should be less than
  // or equal to 384000']"
  /max_tokens\s*\((\d+)\):\s*input should be less than or equal to\s+(\d+)/i,
  // Phala: "max_tokens (current value: 95972) must be between 0 and 32768"
  /max_tokens\s*\(current value:\s*(\d+)\)\s*must be between\s*\d+\s*and\s*(\d+)/i,
  // Google (Gemini surface): "Unable to submit request because it has a
  // maxOutputTokens value of 16384 but the supported range is from 1
  // (inclusive) to 8193 (exclusive)"
  /maxoutputtokens value of\s+(\d+)\s+but the supported range is from\s*\d+\s*\(inclusive\) to\s*(\d+)/i,
];

/**
 * OpenRouter's OWN rejection, when prompt + output exceeds the serving
 * endpoint's context window. A different cause with a different remedy, so it
 * must not be folded into the ceiling case: here a shorter conversation
 * genuinely can help, and there it cannot.
 */
const ENDPOINT_CONTEXT_PATTERN =
  /this endpoint's maximum context length is\s+(\d+)\s+tokens.*?you requested about\s+(\d+)\s+tokens/is;

/** Best-effort; OpenRouter states it as `"provider_name":"Google"`. */
function providerNameFrom(raw: string): string | undefined {
  const match = /"provider_name"\s*:\s*"([^"]+)"/.exec(raw);
  return match?.[1];
}

function modelPhrase(modelId: string | undefined): string {
  return modelId ? `The model "${modelId}"` : "The pinned model";
}

function byProvider(raw: string): string {
  const provider = providerNameFrom(raw);
  return provider ? ` (served by ${provider})` : "";
}

/**
 * An acpx-authored explanation of `turnError`, or `undefined` when acpx has
 * nothing better to say than the adapter already did.
 *
 * ⚠️ **`undefined` MUST mean "pass the original through unchanged".** Returning
 * a generic wrapper for every unrecognised failure would bury the adapter's own
 * text under acpx boilerplate — the exact harm this module exists to undo, in
 * the opposite direction. Only a matched, understood cause earns a rewrite.
 */
export function explainPiTurnError(
  turnError: string,
  modelId: string | undefined,
): string | undefined {
  if (typeof turnError !== "string" || turnError.length === 0) {
    return undefined;
  }

  for (const pattern of OUTPUT_CEILING_PATTERNS) {
    const match = pattern.exec(turnError);
    if (!match) {
      continue;
    }
    const requested = match[1];
    const limit = match[2];
    return [
      `${modelPhrase(modelId)} cannot complete a turn: its provider${byProvider(turnError)} ` +
        `refused the request's output-token ceiling — ${requested} was asked for, ${limit} is enforced.`,
      `This is that model's provider rejecting the request before generating anything. It is not a ` +
        `fault in acpx and not a problem with your prompt: the provider publishes a higher ceiling ` +
        `than it honours, so no prompt of any length avoids it.`,
      `What to do: use a different model. The model list is unaffected — this is one model, not pi.`,
      ``,
      `Provider's own error, verbatim:`,
      turnError,
    ].join("\n");
  }

  const contextMatch = ENDPOINT_CONTEXT_PATTERN.exec(turnError);
  if (contextMatch) {
    const endpointContext = contextMatch[1];
    const requested = contextMatch[2];
    return [
      `${modelPhrase(modelId)} cannot complete a turn on the provider it was routed to` +
        `${byProvider(turnError)}: that provider serves a ${endpointContext}-token context window, ` +
        `and this turn needs about ${requested}.`,
      `The model advertises a larger context than the provider serving it actually offers, so which ` +
        `provider the request lands on decides whether it succeeds. It is not a fault in acpx.`,
      `What to do: retry (routing may pick a larger provider), shorten the conversation, or use a ` +
        `different model.`,
      ``,
      `Provider's own error, verbatim:`,
      turnError,
    ].join("\n");
  }

  return undefined;
}
