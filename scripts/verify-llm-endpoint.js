#!/usr/bin/env node
/**
 * Read-only OpenAI-compatible endpoint smoke test.
 *
 * This script never imports wallet/config/trading modules. It only calls the
 * supplied chat completions endpoint with tiny prompts.
 */

import OpenAI from "openai";

function usage() {
  console.log(`Usage:
node scripts/verify-llm-endpoint.js --base-url <url> --model <model> --api-key <key> [--chat-smoke] [--tool-call-smoke] [--json]

Examples:
node scripts/verify-llm-endpoint.js --base-url http://127.0.0.1:8317/v1 --model gpt-5.4 --api-key NO_API_KEY --chat-smoke --tool-call-smoke
`);
}

function parseArgs(argv) {
  const options = {
    baseUrl: null,
    model: null,
    apiKey: "NO_API_KEY",
    chatSmoke: false,
    toolCallSmoke: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--base-url") {
      options.baseUrl = argv[++i];
      continue;
    }
    if (arg === "--model") {
      options.model = argv[++i];
      continue;
    }
    if (arg === "--api-key") {
      options.apiKey = argv[++i] || "NO_API_KEY";
      continue;
    }
    if (arg === "--chat-smoke") {
      options.chatSmoke = true;
      continue;
    }
    if (arg === "--tool-call-smoke") {
      options.toolCallSmoke = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.baseUrl || !options.model) {
    usage();
    throw new Error("--base-url and --model are required");
  }
  if (!options.chatSmoke && !options.toolCallSmoke) {
    options.chatSmoke = true;
    options.toolCallSmoke = true;
  }

  return options;
}

function sanitizeHost(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "invalid";
  }
}

function sanitizeError(error) {
  return String(error?.message || error?.error?.message || error || "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-[redacted]")
    .slice(0, 500);
}

async function runTimed(label, fn) {
  const started = Date.now();
  try {
    const data = await fn();
    return {
      label,
      ok: true,
      duration_ms: Date.now() - started,
      ...data,
    };
  } catch (error) {
    return {
      label,
      ok: false,
      duration_ms: Date.now() - started,
      error: sanitizeError(error),
    };
  }
}

async function runChatSmoke(client, model) {
  return runTimed("chat_smoke", async () => {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: "Reply with exactly: endpoint ok" },
        { role: "user", content: "Say endpoint ok." },
      ],
      temperature: 0,
      max_tokens: 32,
    });
    const content = response?.choices?.[0]?.message?.content || "";
    if (!content.trim()) throw new Error("chat smoke returned empty content");
    return {
      content_sample: content.slice(0, 80),
      total_tokens: response?.usage?.total_tokens ?? null,
    };
  });
}

async function runToolCallSmoke(client, model) {
  return runTimed("tool_call_smoke", async () => {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: "Use the supplied tool when the user asks for a health check." },
        { role: "user", content: "Run the health check for relay_guard." },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "record_health_check",
            description: "Record a harmless endpoint smoke test result.",
            parameters: {
              type: "object",
              additionalProperties: false,
              properties: {
                target: { type: "string" },
                status: { type: "string", enum: ["ok"] },
              },
              required: ["target", "status"],
            },
          },
        },
      ],
      tool_choice: {
        type: "function",
        function: { name: "record_health_check" },
      },
      temperature: 0,
      max_tokens: 96,
    });
    const toolCalls = response?.choices?.[0]?.message?.tool_calls || [];
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      throw new Error("tool-call smoke returned no tool_calls");
    }
    const first = toolCalls[0];
    if (first?.function?.name !== "record_health_check") {
      throw new Error(`unexpected tool call: ${first?.function?.name || "missing"}`);
    }
    JSON.parse(first.function.arguments || "{}");
    return {
      tool_call_count: toolCalls.length,
      first_tool_name: first.function.name,
      total_tokens: response?.usage?.total_tokens ?? null,
    };
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const client = new OpenAI({
    baseURL: options.baseUrl,
    apiKey: options.apiKey || "NO_API_KEY",
    timeout: 120_000,
  });

  const checks = [];
  if (options.chatSmoke) checks.push(await runChatSmoke(client, options.model));
  if (options.toolCallSmoke) checks.push(await runToolCallSmoke(client, options.model));

  const proof = {
    success: checks.every((check) => check.ok),
    generated_at: new Date().toISOString(),
    read_only: true,
    loads_wallet_or_trading_modules: false,
    base_url_host: sanitizeHost(options.baseUrl),
    model: options.model,
    api_key_set: options.apiKey ? "set" : "not_set",
    checks,
  };

  if (options.json) {
    console.log(JSON.stringify(proof, null, 2));
  } else {
    console.log(JSON.stringify(proof, null, 2));
  }

  if (!proof.success) process.exit(1);
}

main().catch((error) => {
  console.error(JSON.stringify({
    success: false,
    generated_at: new Date().toISOString(),
    error: sanitizeError(error),
  }, null, 2));
  process.exit(1);
});
