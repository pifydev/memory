import { test } from "node:test";
import assert from "node:assert/strict";
import { replyText, runModelCall, type ModelReply } from "../src/model-call.ts";

/**
 * The observer and consolidation used to run a tool-less question as a full
 * in-memory AgentSession behind a timer that called session.abort(), because
 * pi's PromptOptions ignored a signal. pi 0.87's streamSimple takes a real
 * AbortSignal.timeout and encodes a failure IN the resolved message. These
 * tests pin the four outcome shapes the callers depend on — a normal answer,
 * an "error" stopReason (setup/auth failure encoded in the stream), an
 * "aborted" stopReason (the timeout signal firing), and a synchronous throw
 * (auth missing surfacing as a rejection) — so each classifies exactly as the
 * old timer-and-abort path did for its equivalent.
 */

const textReply = (text: string): ModelReply => ({
  content: [{ type: "text", text }],
  stopReason: "stop",
});

test("replyText joins text blocks and ignores thinking and tool calls", () => {
  assert.equal(
    replyText([
      { type: "thinking" },
      { type: "text", text: "the answer" },
      { type: "toolCall" as never },
      { type: "text", text: " continues" },
    ] as ModelReply["content"]),
    "the answer continues",
  );
  // A thinking-only message has no text block at all.
  assert.equal(replyText([{ type: "thinking" }] as ModelReply["content"]), "");
  assert.equal(replyText(undefined), "");
});

test("a normal answer yields text, no timeout, no error", async () => {
  const outcome = await runModelCall(async () => textReply("[insight] the retry loop masks the real error"));
  assert.equal(outcome.text, "[insight] the retry loop masks the real error");
  assert.equal(outcome.timedOut, false);
  assert.equal(outcome.error, null);
});

test('stopReason "error" is a failure carrying the provider message', async () => {
  const outcome = await runModelCall(async () => ({
    content: [],
    stopReason: "error",
    errorMessage: "No API key found for \"anthropic\"",
  }));
  assert.equal(outcome.timedOut, false);
  assert.equal(outcome.error, 'No API key found for "anthropic"');
  assert.equal(outcome.text, "");
});

test('stopReason "error" without a message still reports an error', async () => {
  const outcome = await runModelCall(async () => ({ content: [], stopReason: "error" }));
  assert.equal(outcome.error, "the model returned an error");
  assert.equal(outcome.timedOut, false);
});

test('stopReason "aborted" from the timeout signal is a timeout, not an error', async () => {
  const outcome = await runModelCall(async () => ({
    content: [],
    stopReason: "aborted",
    errorMessage: "aborted",
  }));
  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.error, null);
  assert.equal(outcome.text, "");
});

test("a synchronous throw (auth missing) is folded into error", async () => {
  const outcome = await runModelCall(async () => {
    throw new Error("No API key found for \"openai\"");
  });
  assert.equal(outcome.timedOut, false);
  assert.equal(outcome.error, 'No API key found for "openai"');
  assert.equal(outcome.text, "");
});

test("a successful call with no text block yields empty text and no error", async () => {
  // The empty-answer case the observer treats as a considered failure: a real
  // stopReason, but nothing to parse. Classification stays clean; the caller
  // decides that "" is not a valid note.
  const outcome = await runModelCall(async () => ({ content: [{ type: "thinking" }], stopReason: "stop" }));
  assert.equal(outcome.text, "");
  assert.equal(outcome.timedOut, false);
  assert.equal(outcome.error, null);
});
