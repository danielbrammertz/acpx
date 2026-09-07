import { TimeoutError, withTimeout } from "../../async-control.js";
import { hasAgentReplyAfterPrompt } from "../../session/conversation-model.js";
import type { PromptInput, RunPromptResult, SessionConversation } from "../../types.js";

const SESSION_REPLY_IDLE_MS = 1_000;
const SESSION_REPLY_DRAIN_TIMEOUT_MS = 5_000;

type PromptTurnClient = {
  prompt: (
    sessionId: string,
    prompt: PromptInput | string,
    options?: { messageId?: string },
  ) => Promise<{ stopReason: RunPromptResult["stopReason"]; _meta?: unknown }>;
  waitForSessionUpdatesIdle?: (options?: { idleMs?: number; timeoutMs?: number }) => Promise<void>;
};

/**
 * brick 4ec33f59 — the failure a HARD-FAILED turn reports OUT OF BAND.
 *
 * The ACP wire `StopReason` union has no `"error"` member — it is
 * `end_turn | max_tokens | max_turn_requests | refusal | cancelled`. So an
 * adapter whose turn failed hard CANNOT say so in the stop reason: it must stop
 * `end_turn` and state the failure elsewhere. The nativai `pi-acp` fork states
 * it on `_meta.piAcp.turnError` (18 occurrences in the deployed bundle).
 *
 * Without this read the failure reaches nobody: the turn settles `completed`,
 * the delivery terminal carries `EMPTY_DELIVERY_ERROR`, and acpx-ui renders a
 * CLEAN SUCCESS for a turn that failed. acpx-ui's receiving half is already
 * deployed (`32a8f11b`) and carries a NON-EMPTY message to the sender's
 * transcript bubble — it is inert until this value arrives.
 *
 * Same shape and discipline as `advertisedServedEffort`'s read of the sibling
 * `_meta.piAcp.servedEffort`: absent, empty or ill-typed ⇒ `undefined`, never a
 * substituted value. **The emptiness check is load-bearing, not defensive
 * tidiness — see the caller in `cli/session/runtime.ts`.**
 */
function turnErrorFromMeta(meta: unknown): string | undefined {
  if (!meta || typeof meta !== "object") {
    return undefined;
  }
  const value = (meta as { piAcp?: { turnError?: unknown } }).piAcp?.turnError;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function runPromptTurn(params: {
  client: PromptTurnClient;
  sessionId: string;
  prompt: PromptInput | string;
  timeoutMs?: number;
  conversation: SessionConversation;
  promptMessageId?: string;
  messageId?: string;
  onPromptStarted?: () => Promise<void> | void;
}): Promise<{
  stopReason: RunPromptResult["stopReason"];
  source: "rpc" | "session";
  turnError?: string;
}> {
  try {
    const promptPromise = params.client.prompt(params.sessionId, params.prompt, {
      messageId: params.messageId,
    });
    await params.onPromptStarted?.();
    const response = await withTimeout(promptPromise, params.timeoutMs);
    await params.client
      .waitForSessionUpdatesIdle?.({
        idleMs: SESSION_REPLY_IDLE_MS,
        timeoutMs: SESSION_REPLY_DRAIN_TIMEOUT_MS,
      })
      .catch(() => {
        // Best effort. The prompt already completed successfully, so keep the
        // original stop reason if late update draining itself times out.
      });
    const turnError = turnErrorFromMeta(response._meta);
    return {
      stopReason: response.stopReason,
      source: "rpc",
      ...(turnError !== undefined ? { turnError } : {}),
    };
  } catch (error) {
    if (!(error instanceof TimeoutError) || !params.promptMessageId) {
      throw error;
    }

    await params.client
      .waitForSessionUpdatesIdle?.({
        idleMs: SESSION_REPLY_IDLE_MS,
        timeoutMs: SESSION_REPLY_DRAIN_TIMEOUT_MS,
      })
      .catch(() => {
        // Best effort. If the update drain itself times out, fall back to the prompt error.
      });

    if (hasAgentReplyAfterPrompt(params.conversation, params.promptMessageId)) {
      return {
        stopReason: "end_turn",
        source: "session",
      };
    }

    throw error;
  }
}
