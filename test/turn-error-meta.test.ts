// brick 4ec33f59 — A HARD-FAILED TURN MUST NOT BE RECORDED AS A CLEAN SUCCESS.
//
// The ACP wire `StopReason` union has NO `"error"` member — it is
// `end_turn | max_tokens | max_turn_requests | refusal | cancelled`. So an
// adapter whose turn failed hard cannot say so in the stop reason: it stops
// `end_turn` and reports the failure out of band. The nativai `pi-acp` fork
// reports it on `_meta.piAcp.turnError`.
//
// acpx used to drop that value on the floor — `runPromptTurn`'s client type did
// not even mention `_meta` — so the delivery terminal fell back to
// `EMPTY_DELIVERY_ERROR` and acpx-ui rendered a clean success for a failed turn.
//
// ⚠️ READ BOTH DIRECTIONS BEFORE CHANGING EITHER. The restraint cases are not
// padding: `buildDeliveryEvent` substitutes `EMPTY_DELIVERY_ERROR`
// (`{code:0, message:""}`) whenever `error` is absent, so acpx sends an error
// object on EVERY `done`, successful or not. acpx-ui treats a NON-EMPTY message
// as the failure note. ⇒ a "simplification" that let an empty or whitespace
// value through here would stamp "the turn reported an error" onto EVERY
// SUCCESSFUL TURN IN THE APP. That is the bug this file exists to prevent, and
// it is invisible from inside acpx — the consequence lives in the other repo.

import assert from "node:assert/strict";
import test from "node:test";
import { runPromptTurn } from "../src/runtime/engine/prompt-turn.js";
import {
  createSessionConversation,
  recordPromptSubmission,
} from "../src/session/conversation-model.js";

// The nativai pi-acp fork's own wording, so the fixture is the real string a
// human would be shown rather than a stand-in.
const PI_TURN_ERROR = "pi could not complete the turn: upstream provider returned no completion";

// No hand-written return annotation: the inferred type IS runPromptTurn's, so a
// change to its contract shows up here as a type error rather than being masked
// by a shape this test asserted independently.
async function turnWith(meta: unknown) {
  const client = {
    prompt: async () => ({
      stopReason: "end_turn" as const,
      ...(meta !== undefined ? { _meta: meta } : {}),
    }),
    waitForSessionUpdatesIdle: async () => {},
  };
  const conversation = createSessionConversation();
  const promptMessageId = recordPromptSubmission(conversation, "hello");
  return await runPromptTurn({
    client,
    sessionId: "session-under-test",
    prompt: "hello",
    conversation,
    promptMessageId,
  });
}

test("4ec33f59: a turn that failed hard but stopped `end_turn` surfaces its error", async () => {
  const result = await turnWith({ piAcp: { turnError: PI_TURN_ERROR } });

  // THE ASSERTION THE OLD CODE FAILS: the value was dropped, so this was undefined.
  assert.equal(result.turnError, PI_TURN_ERROR, "the out-of-band turn error is read off _meta");
  // And it is still a completed turn on the wire — the message WAS delivered and
  // the model DID take the turn. Nothing here may become a failure or a resend.
  assert.equal(result.stopReason, "end_turn", "the wire stop reason is unchanged");
  assert.equal(result.source, "rpc");
});

test("4ec33f59 CONTROL: a clean turn reports NO error — this is the one that must not regress", async () => {
  // GREEN BEFORE AND AFTER, AND IT IS LOAD-BEARING. If this ever goes red because
  // `turnError` became a string, every successful turn in the app acquires a
  // failure note in acpx-ui. Its mirror there is
  // `4ec33f59 CONTROL: a clean 'done' invents no note`.
  const noMeta = await turnWith(undefined);
  assert.equal(noMeta.turnError, undefined, "no _meta at all invents nothing");

  const emptyMeta = await turnWith({});
  assert.equal(emptyMeta.turnError, undefined, "an empty _meta invents nothing");

  const otherHarness = await turnWith({ claudeAcp: { turnError: "not ours" } });
  assert.equal(otherHarness.turnError, undefined, "another harness's namespace is not read");

  const siblingOnly = await turnWith({ piAcp: { servedEffort: "high" } });
  assert.equal(siblingOnly.turnError, undefined, "the sibling field is not mistaken for this one");
});

test("4ec33f59 CONTROL: an EMPTY or ill-typed turnError is not an error", async () => {
  // The specific shapes that would reach acpx-ui as a non-empty message if the
  // guard were dropped. `""` is the one a caller is most likely to think is
  // harmless — it is not: it is how the adapter says "nothing went wrong".
  for (const value of ["", null, 0, false, {}, []] as const) {
    const result = await turnWith({ piAcp: { turnError: value } });
    assert.equal(
      result.turnError,
      undefined,
      `a turnError of ${JSON.stringify(value)} must not become a failure note`,
    );
  }
});

test("4ec33f59: the field is carried without disturbing the existing contract", async () => {
  // Positive control on the same path, same run: the projection actually ran and
  // returned a real turn result, so the `undefined`s above cannot be a stub that
  // silently returned nothing.
  const result = await turnWith({ piAcp: { turnError: PI_TURN_ERROR } });
  assert.equal(typeof result.stopReason, "string", "the turn really completed");
  assert.equal(result.source, "rpc", "and it came back through the rpc path");
});
