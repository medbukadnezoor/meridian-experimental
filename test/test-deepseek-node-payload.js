/**
 * Proves OpenAI Node serializes DeepSeek's thinking toggle as a top-level field.
 * Run: node test/test-deepseek-node-payload.js
 */

import assert from "assert";
import OpenAI from "openai";

let capturedBody = null;

const client = new OpenAI({
  apiKey: "unit-test-key",
  baseURL: "https://api.deepseek.com",
  fetch: async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return new Response(JSON.stringify({
      id: "chatcmpl-unit-test",
      object: "chat.completion",
      created: 0,
      model: "deepseek-v4-flash",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
});

await client.chat.completions.create({
  model: "deepseek-v4-pro",
  messages: [{ role: "user", content: "ping" }],
  tools: [],
  thinking: { type: "enabled" },
  reasoning_effort: "high",
});

assert.deepStrictEqual(
  capturedBody.thinking,
  { type: "enabled" },
  "thinking toggle should be serialized as a top-level DeepSeek parameter"
);
assert.strictEqual(
  capturedBody.reasoning_effort,
  "high",
  "screening reasoning effort should be serialized as a top-level DeepSeek parameter"
);
assert.strictEqual(
  Object.hasOwn(capturedBody, "extra_body"),
  false,
  "OpenAI Node should not send DeepSeek thinking under extra_body"
);

console.log("DeepSeek Node payload checks passed.");
