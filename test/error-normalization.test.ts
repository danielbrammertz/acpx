import assert from "node:assert/strict";
import test from "node:test";
import {
  exitCodeForOutputErrorCode,
  isPostDeliveryAcpError,
  isRetryablePromptError,
  normalizeOutputError,
  isAcpQueryClosedBeforeResponseError,
  isAcpResourceNotFoundError,
  formatAcpErrorMessage,
} from "../src/acp/error-normalization.js";
import {
  PermissionPromptUnavailableError,
  QueueConnectionError,
  AuthPolicyError,
} from "../src/errors.js";

test("normalizeOutputError maps permission prompt unavailable errors", () => {
  const normalized = normalizeOutputError(new PermissionPromptUnavailableError(), {
    origin: "runtime",
  });

  assert.equal(normalized.code, "PERMISSION_PROMPT_UNAVAILABLE");
  assert.equal(normalized.origin, "runtime");
  assert.match(normalized.message, /Permission prompt unavailable/i);
});

test("normalizeOutputError maps ACP resource not found errors to NO_SESSION", () => {
  const error = {
    code: -32002,
    message: "Resource not found: session",
    data: {
      sessionId: "abc",
    },
  };

  const normalized = normalizeOutputError(error, {
    origin: "acp",
  });

  assert.equal(normalized.code, "NO_SESSION");
  assert.equal(normalized.origin, "acp");
  assert.deepEqual(normalized.acp, {
    code: -32002,
    message: "Resource not found: session",
    data: {
      sessionId: "abc",
    },
  });
  assert.equal(isAcpResourceNotFoundError(error), true);
});

test("isAcpResourceNotFoundError recognizes session-not-found hints in nested errors", () => {
  assert.equal(
    isAcpResourceNotFoundError({
      cause: {
        message: "session not found while reconnecting",
      },
    }),
    true,
  );
});

test("isAcpResourceNotFoundError recognizes Cursor session-not-found format", () => {
  // Cursor returns: {"code":-32602,"message":"Invalid params","data":{"message":"Session \"xxx\" not found"}}
  const cursorError = {
    code: -32602,
    message: "Invalid params",
    data: {
      message: 'Session "nonexistent-session-id" not found',
    },
  };

  assert.equal(isAcpResourceNotFoundError(cursorError), true);
});
test("isAcpQueryClosedBeforeResponseError matches typed ACP payload", () => {
  const error = {
    code: -32603,
    message: "Internal error",
    data: {
      details: "Query closed before response received",
    },
  };

  assert.equal(isAcpQueryClosedBeforeResponseError(error), true);
});

test("isAcpQueryClosedBeforeResponseError ignores unrelated ACP errors", () => {
  const error = {
    code: -32603,
    message: "Internal error",
    data: {
      details: "other detail",
    },
  };

  assert.equal(isAcpQueryClosedBeforeResponseError(error), false);
});

test("normalizeOutputError preserves queue metadata from typed queue errors", () => {
  const error = new QueueConnectionError("Queue denied control request", {
    outputCode: "PERMISSION_DENIED",
    detailCode: "QUEUE_CONTROL_REQUEST_FAILED",
    origin: "queue",
    retryable: false,
  });

  const normalized = normalizeOutputError(error);
  assert.equal(normalized.code, "PERMISSION_DENIED");
  assert.equal(normalized.detailCode, "QUEUE_CONTROL_REQUEST_FAILED");
  assert.equal(normalized.origin, "queue");
  assert.equal(normalized.retryable, false);
});

test("normalizeOutputError maps AuthPolicyError to AUTH_REQUIRED detail", () => {
  const normalized = normalizeOutputError(
    new AuthPolicyError("missing credentials for auth method token"),
  );

  assert.equal(normalized.code, "RUNTIME");
  assert.equal(normalized.detailCode, "AUTH_REQUIRED");
  assert.equal(normalized.origin, "acp");
});

test("normalizeOutputError infers AUTH_REQUIRED detail from ACP payload", () => {
  const normalized = normalizeOutputError({
    error: {
      code: -32000,
      message: "Authentication required",
      data: {
        methodId: "token",
      },
    },
  });

  assert.equal(normalized.code, "RUNTIME");
  assert.equal(normalized.detailCode, "AUTH_REQUIRED");
  assert.equal(normalized.acp?.code, -32000);
});

test("normalizeOutputError extracts ACP payload from wrapped errors", () => {
  const wrapped = new Error("Agent rejected session/set_mode");
  (
    wrapped as Error & {
      acp?: { code: number; message: string; data?: unknown };
    }
  ).acp = {
    code: -32602,
    message: "Invalid params",
    data: {
      method: "session/set_mode",
      modeId: "plan",
    },
  };

  const normalized = normalizeOutputError(wrapped);

  assert.equal(normalized.code, "RUNTIME");
  assert.equal(normalized.acp?.code, -32602);
  assert.deepEqual(normalized.acp?.data, {
    method: "session/set_mode",
    modeId: "plan",
  });
});

test("exitCodeForOutputErrorCode maps machine codes to stable exits", () => {
  assert.equal(exitCodeForOutputErrorCode("USAGE"), 2);
  assert.equal(exitCodeForOutputErrorCode("TIMEOUT"), 3);
  assert.equal(exitCodeForOutputErrorCode("NO_SESSION"), 4);
  assert.equal(exitCodeForOutputErrorCode("PERMISSION_DENIED"), 5);
  assert.equal(exitCodeForOutputErrorCode("PERMISSION_PROMPT_UNAVAILABLE"), 5);
  assert.equal(exitCodeForOutputErrorCode("RUNTIME"), 1);
});

// ---------------------------------------------------------------------------
// isPostDeliveryAcpError
// ---------------------------------------------------------------------------

test("isPostDeliveryAcpError detects rate_limit errorKind", () => {
  assert.equal(
    isPostDeliveryAcpError({
      code: -32603,
      message: "turn failed",
      data: { errorKind: "rate_limit" },
    }),
    true,
  );
});

test("isPostDeliveryAcpError detects authentication_failed errorKind", () => {
  assert.equal(
    isPostDeliveryAcpError({
      code: -32603,
      message: "turn failed",
      data: { errorKind: "authentication_failed" },
    }),
    true,
  );
});

test("isPostDeliveryAcpError detects billing_error errorKind", () => {
  assert.equal(
    isPostDeliveryAcpError({
      code: -32603,
      message: "turn failed",
      data: { errorKind: "billing_error" },
    }),
    true,
  );
});

test("isPostDeliveryAcpError detects weekly limit message text (C2 bug scenario)", () => {
  assert.equal(
    isPostDeliveryAcpError({
      code: -32603,
      message: "You've hit your weekly limit · resets Jun 8, 3am (UTC)",
    }),
    true,
  );
});

test("isPostDeliveryAcpError detects 429 in message", () => {
  assert.equal(isPostDeliveryAcpError({ code: -32603, message: "HTTP 429 rate limited" }), true);
});

test("isPostDeliveryAcpError detects 'quota exceeded' in message", () => {
  assert.equal(
    isPostDeliveryAcpError({ code: -32603, message: "Quota exceeded for this account" }),
    true,
  );
});

test("isPostDeliveryAcpError detects 'usage limit' in message", () => {
  assert.equal(
    isPostDeliveryAcpError({ code: -32603, message: "You have hit your usage limit" }),
    true,
  );
});

test("isPostDeliveryAcpError detects raw Claude session limit message text", () => {
  assert.equal(
    isPostDeliveryAcpError({
      code: -32603,
      message: "Internal error: You've hit your session limit · resets 11:20am (UTC)",
    }),
    true,
  );
});

test("isPostDeliveryAcpError returns false for generic transient message", () => {
  assert.equal(
    isPostDeliveryAcpError({ code: -32603, message: "Internal adapter error — model API timeout" }),
    false,
  );
});

test("isPostDeliveryAcpError returns false for unknown errorKind", () => {
  assert.equal(
    isPostDeliveryAcpError({
      code: -32603,
      message: "turn failed",
      data: { errorKind: "max_output_tokens" },
    }),
    false,
  );
});

// ---------------------------------------------------------------------------
// isRetryablePromptError — rate-limit / post-delivery cases (Bug: C2 fix)
// ---------------------------------------------------------------------------

function acpWrapped(code: number, message: string, data?: Record<string, unknown>): unknown {
  return { acp: { code, message, data } };
}

test("isRetryablePromptError returns false for -32603 with rate_limit errorKind", () => {
  assert.equal(
    isRetryablePromptError(acpWrapped(-32603, "turn failed", { errorKind: "rate_limit" })),
    false,
  );
});

test("isRetryablePromptError returns false for -32603 with weekly limit message (C2 bug scenario)", () => {
  assert.equal(
    isRetryablePromptError(
      acpWrapped(-32603, "You've hit your weekly limit · resets Jun 8, 3am (UTC)"),
    ),
    false,
  );
});

test("isRetryablePromptError returns false for -32603 with session limit message", () => {
  assert.equal(
    isRetryablePromptError(
      acpWrapped(-32603, "Internal error: You've hit your session limit · resets 11:20am (UTC)"),
    ),
    false,
  );
});

test("isRetryablePromptError returns false for -32603 with authentication_failed errorKind", () => {
  assert.equal(
    isRetryablePromptError(
      acpWrapped(-32603, "turn failed", { errorKind: "authentication_failed" }),
    ),
    false,
  );
});

test("isRetryablePromptError returns false for -32603 with billing_error errorKind", () => {
  assert.equal(
    isRetryablePromptError(acpWrapped(-32603, "turn failed", { errorKind: "billing_error" })),
    false,
  );
});

test("isRetryablePromptError returns true for generic transient -32603 (pre-delivery crash)", () => {
  assert.equal(
    isRetryablePromptError(acpWrapped(-32603, "Internal adapter error — model API timeout")),
    true,
  );
});

test("isRetryablePromptError returns true for -32700 with no post-delivery signal", () => {
  assert.equal(isRetryablePromptError(acpWrapped(-32700, "Parse error")), true);
});

test("isRetryablePromptError returns false for -32700 with rate_limit errorKind", () => {
  assert.equal(
    isRetryablePromptError(acpWrapped(-32700, "Parse error", { errorKind: "rate_limit" })),
    false,
  );
});

test("isRetryablePromptError returns false for permanent -32601 (method not found)", () => {
  assert.equal(isRetryablePromptError(acpWrapped(-32601, "Method not found")), false);
});

test("isRetryablePromptError returns false for non-ACP error", () => {
  assert.equal(isRetryablePromptError(new Error("process crash")), false);
});

// ============================================================================
// brick://cb214e48 — pi-acp's `Unknown sessionId` rejection must keep classifying
// as resource-not-found.
//
// ⚠️ TODAY THAT CLASSIFICATION RESTS ON A SINGLE LEG. pi-acp calls
// `RequestError.invalidParams(\`Unknown sessionId: ${id}\`)`, and in the pinned SDK
// the signature is `invalidParams(data?, additionalMessage?)` — so the human string
// lands in `data` and `message` is the bare "Invalid params". The code -32602 is
// NOT in RESOURCE_NOT_FOUND_ACP_CODES, so `hasSessionNotFoundHint(data)` is the
// only thing holding the whole downstream branch up.
//
// The sibling pi-acp change adds `data.details` and repeats the wording in
// `additionalMessage`, which puts it in `message` as well — so BOTH legs then hold.
// These rows assert each leg ALONE, so dropping either one is caught, and pin the
// WORDING: rewording it to e.g. "session not present" would silently reclassify the
// error out of `isAcpResourceNotFoundError` and change the whole downstream branch.
// ============================================================================

test("cb214e48: Unknown-sessionId classifies as resource-not-found via the DATA leg alone", () => {
  // The OLD pi-acp shape, measured verbatim on 73f2e39.
  assert.equal(
    isAcpResourceNotFoundError({
      error: {
        code: -32602,
        message: "Invalid params",
        data: "Unknown sessionId: 01a0875c-c60c-7e06-84de-6873ea4d3176",
      },
    }),
    true,
  );
});

test("cb214e48: Unknown-sessionId classifies via the MESSAGE leg alone", () => {
  // The NEW shape's `additionalMessage` half, with a `data.details` that carries
  // NO session-not-found wording of its own — so only `message` can classify it.
  assert.equal(
    isAcpResourceNotFoundError({
      error: {
        code: -32602,
        message: "Invalid params: Unknown sessionId: 01a0875c-c60c-7e06-84de-6873ea4d3176",
        data: { details: "no pi JSONL: searched /home/node/.pi/agent/sessions/--workspace--" },
      },
    }),
    true,
  );
});

test("cb214e48: the full NEW pi-acp shape classifies, and its details reach the message", () => {
  const error = {
    error: {
      code: -32602,
      message: "Invalid params: Unknown sessionId: pi-1",
      data: {
        details:
          "no pi session JSONL for pi-1: searched /home/node/.pi/agent/sessions/--workspace--; session map /tmp/acpx-pi-x/pi-acp/session-map.json",
      },
    },
  };
  assert.equal(isAcpResourceNotFoundError(error), true);
  // `formatAcpErrorMessage` is the composition the resume path needs: `message`
  // alone would show the user "Invalid params" and DROP the diagnosis.
  const formatted = formatAcpErrorMessage(error);
  assert.match(formatted, /Unknown sessionId: pi-1/);
  assert.match(formatted, /session map \/tmp\/acpx-pi-x\/pi-acp\/session-map\.json/);
});

test("cb214e48 ⚠️ CARRIER: rewording 'Unknown sessionId' DE-classifies the error", () => {
  // ⚠️ DO NOT "IMPROVE" pi-acp's wording to e.g. "session not present". It reads
  // like a clearer sentence and it silently changes acpx's control flow: the error
  // stops being resource-not-found, so the resume path stops recovering and stops
  // falling back. This row is the executable half of that warning — it goes red on
  // any wording that no longer matches `isSessionNotFoundText`.
  assert.equal(
    isAcpResourceNotFoundError({
      error: { code: -32602, message: "Invalid params: session not present: pi-1" },
    }),
    false,
    "a reworded rejection now classifies — this row's whole purpose is that it does not",
  );
});
