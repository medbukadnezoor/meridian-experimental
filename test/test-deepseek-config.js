/**
 * Focused behavioral checks for DeepSeek role credential resolution.
 * Run: node test/test-deepseek-config.js
 */

import assert from "assert";
import {
  DEEPSEEK_OPENAI_BASE_URL,
  isDeepSeekBaseUrl,
  resolveEnvReference,
  resolveRoleApiKey,
} from "../config.js";

assert.strictEqual(isDeepSeekBaseUrl(DEEPSEEK_OPENAI_BASE_URL), true, "official DeepSeek OpenAI base URL is detected");
assert.strictEqual(isDeepSeekBaseUrl(`${DEEPSEEK_OPENAI_BASE_URL}/v1`), true, "DeepSeek base URL with path is detected");
assert.strictEqual(isDeepSeekBaseUrl("https://openrouter.ai/api/v1"), false, "OpenRouter is not treated as DeepSeek");

assert.strictEqual(
  resolveRoleApiKey(null, DEEPSEEK_OPENAI_BASE_URL, "deepseek-v4-flash", { DEEPSEEK_API_KEY: "ds-env-key" }, undefined),
  "ds-env-key",
  "DeepSeek role key falls back to DEEPSEEK_API_KEY"
);

assert.strictEqual(
  resolveEnvReference("env:DEEPSEEK_API_KEY", { DEEPSEEK_API_KEY: "ds-env-key" }),
  "ds-env-key",
  "env placeholder resolves from supplied env"
);

assert.notStrictEqual(
  resolveEnvReference("env:DEEPSEEK_API_KEY", { DEEPSEEK_API_KEY: "ds-env-key" }),
  "env:DEEPSEEK_API_KEY",
  "env placeholder does not pass through as a literal API key"
);

assert.strictEqual(
  resolveRoleApiKey("configured-role-key", DEEPSEEK_OPENAI_BASE_URL, "deepseek-v4-flash", { DEEPSEEK_API_KEY: "ds-env-key" }, "global-key"),
  "configured-role-key",
  "explicit role key wins over env fallback"
);

assert.strictEqual(
  resolveRoleApiKey(null, "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "qwen3.6-plus", { DEEPSEEK_API_KEY: "ds-env-key" }, "global-key"),
  "global-key",
  "non-DeepSeek routes keep the global key fallback"
);

console.log("DeepSeek config resolution checks passed.");
