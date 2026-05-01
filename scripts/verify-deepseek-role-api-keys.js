#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  DEEPSEEK_OPENAI_BASE_URL,
  isDeepSeekModel,
  resolveRoleApiKey,
} from "../config.js";

const env = {
  DEEPSEEK_API_KEY: "unit-test-deepseek-key",
  ROLE_KEY: "unit-test-role-key",
};

assert.equal(isDeepSeekModel("deepseek-v4-flash"), true);
assert.equal(isDeepSeekModel("openrouter/healer-alpha"), false);

assert.equal(
  resolveRoleApiKey("explicit-role-key", DEEPSEEK_OPENAI_BASE_URL, "deepseek-v4-flash", env, "global-key"),
  "explicit-role-key",
  "explicit role API key should win"
);

assert.equal(
  resolveRoleApiKey("env:ROLE_KEY", DEEPSEEK_OPENAI_BASE_URL, "deepseek-v4-flash", env, "global-key"),
  env.ROLE_KEY,
  "env: role API key reference should resolve before DeepSeek fallback"
);

assert.equal(
  resolveRoleApiKey(null, DEEPSEEK_OPENAI_BASE_URL, "openrouter/hunter-alpha", env, "global-key"),
  env.DEEPSEEK_API_KEY,
  "DeepSeek base URL should resolve from DEEPSEEK_API_KEY"
);

assert.equal(
  resolveRoleApiKey(null, "https://openrouter.ai/api/v1", "deepseek-v4-flash", env, "global-key"),
  env.DEEPSEEK_API_KEY,
  "DeepSeek model should resolve from DEEPSEEK_API_KEY"
);

assert.equal(
  resolveRoleApiKey(null, "https://openrouter.ai/api/v1", "openrouter/hunter-alpha", env, "global-key"),
  "global-key",
  "non-DeepSeek role should keep existing global fallback behavior"
);

assert.equal(
  resolveRoleApiKey(null, "https://openrouter.ai/api/v1", "openrouter/hunter-alpha", {}, undefined),
  undefined,
  "missing role/global keys should stay unset"
);

console.log(JSON.stringify({
  success: true,
  explicitRoleKeyWins: true,
  envReferenceResolves: true,
  deepseekBaseUrlUsesEnv: true,
  deepseekModelUsesEnv: true,
  globalFallbackPreserved: true,
  secretPrinted: false,
}));
