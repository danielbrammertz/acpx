import type { AgentLifecycleSnapshot } from "../../acp/client.js";
import { copyLoggedMessageCount } from "../../session/messages-log-bookkeeping.js";
import { setHarnessConfigDir } from "../../session/mode-preference.js";
import { normalizeRuntimeSessionId } from "../../session/runtime-session-id.js";
import { messagesHaveRealAgentTurn } from "../../session/synthetic-messages.js";
import type { SessionConversation, SessionRecord } from "../../types.js";

export function applyLifecycleSnapshotToRecord(
  record: SessionRecord,
  snapshot: AgentLifecycleSnapshot | undefined,
): void {
  if (!snapshot) {
    return;
  }

  record.pid = snapshot.running ? snapshot.pid : undefined;
  record.agentStartedAt = snapshot.startedAt;
  // The config-dir CHANNEL, refreshed at every spawn/reconnect (brick fa2e54ec).
  // See AgentLifecycleSnapshot.harnessConfigDir for why it must not be written
  // once at create.
  // brick://cb214e48 — `piSessionDir` rides the SAME snapshot for the same reason,
  // so a new spawn site cannot record one and forget the other.
  setHarnessConfigDir(record, snapshot.harnessConfigDir, snapshot.piSessionDir);
  if (snapshot.provisioningWarning) {
    const acpx = record.acpx ?? {};
    const sessionOptions = { ...acpx.session_options };
    sessionOptions.provisioning_warning = { ...snapshot.provisioningWarning };
    record.acpx = { ...acpx, session_options: sessionOptions };
  }
  // brick://a89c3cd4 — STICKY BY CONSTRUCTION, exactly like the block above: the
  // truthy gate means a falsy snapshot leaves any stored `true` alone, and that
  // is load-bearing rather than incidental. The consumer is the cold-resume
  // transcript gate, which runs AFTER teardown — and teardown produces a snapshot
  // with this unset. An `else` clearing it here would report "not shim-served" at
  // exactly the moment the truth is needed, reproducing the defect it fixes.
  if (snapshot.servedViaShim) {
    const acpx = record.acpx ?? {};
    const sessionOptions = { ...acpx.session_options };
    sessionOptions.served_via_shim = true;
    record.acpx = { ...acpx, session_options: sessionOptions };
  }

  if (snapshot.lastExit) {
    record.lastAgentExitCode = snapshot.lastExit.exitCode;
    record.lastAgentExitSignal = snapshot.lastExit.signal;
    record.lastAgentExitAt = snapshot.lastExit.exitedAt;
    record.lastAgentDisconnectReason = snapshot.lastExit.reason;
    // Persist whether the disconnect happened MID-TURN (a prompt was active) vs at
    // rest — the one signal that distinguishes a mid-turn death from a routine idle
    // TTL-reap, both of which otherwise serialize as connection_close/null/null.
    record.lastAgentUnexpectedDuringPrompt = snapshot.lastExit.unexpectedDuringPrompt;
    return;
  }

  record.lastAgentExitCode = undefined;
  record.lastAgentExitSignal = undefined;
  record.lastAgentExitAt = undefined;
  record.lastAgentDisconnectReason = undefined;
  record.lastAgentUnexpectedDuringPrompt = undefined;
}

export function reconcileAgentSessionId(
  record: SessionRecord,
  agentSessionId: string | undefined,
): void {
  const normalized = normalizeRuntimeSessionId(agentSessionId);
  if (!normalized) {
    return;
  }

  record.agentSessionId = normalized;
}

export function sessionHasAgentMessages(
  recordOrConversation: Pick<SessionRecord, "messages"> | SessionConversation,
): boolean {
  return recordOrConversation.messages.some(
    (message) => typeof message === "object" && message !== null && "Agent" in message,
  );
}

// True only when a REAL model turn was ever produced — synthetic system
// breadcrumbs mirrored by acpx (the implicit-Fable→opus guard notice among
// them) are excluded, whether tagged `Agent.synthetic:true` or recognized as a
// legacy pre-tag breadcrumb by content (brick://de3645c6, legacy recognition
// brick://509b4ee1 — see synthetic-messages.ts). This is the correct signal for
// the "nothing to lose" fallback-safety gate: a never-run session carrying only
// a cosmetic breadcrumb has no conversation to preserve, so a
// resume→resource-not-found on a genuinely-missing transcript is safe to heal
// via session/new — exactly as a freshly created session would. A session with
// any real Agent turn still fails loudly (silent continuity loss is forbidden).
export function sessionHasRealAgentTurn(
  recordOrConversation: Pick<SessionRecord, "messages"> | SessionConversation,
): boolean {
  return messagesHaveRealAgentTurn(recordOrConversation.messages);
}

export function applyConversation(record: SessionRecord, conversation: SessionConversation): void {
  record.title = conversation.title;
  record.updated_at = conversation.updated_at;
  record.messages = conversation.messages;
  copyLoggedMessageCount(conversation, record);
  record.cumulative_token_usage = conversation.cumulative_token_usage;
  record.request_token_usage = conversation.request_token_usage;
}
