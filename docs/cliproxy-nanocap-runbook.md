# Nanocap LLM Routing Runbook

This runbook is for nanocap LLM routing checks. Current owner routing is DeepSeek for SCREENER, MANAGER, and GENERAL via config, not a hardcoded model in scripts.

## Safety Rules

- Keep CLIProxy bound to `127.0.0.1`.
- Do not paste OAuth tokens, auth JSON, API keys, wallet material, or shell history into repo files, tickets, or chat.
- Do not restart the main `meridian` PM2 process.
- Keep SCREENER, MANAGER, and GENERAL model choices in `user-config.json` / `user-config.example.json`.
- If the provider is down, nanocap must fail clearly or use an explicitly configured fallback.

## Legacy CLIProxy Notes

CLIProxyAPI was used for an older screener experiment. Keep these notes only for rollback archaeology; current live routing should not depend on CLIProxy.

From the Mac:

```bash
ssh ohox
```

On `ohox`, install one of the documented Linux paths:

```bash
curl -fsSL https://raw.githubusercontent.com/brokechubb/cliproxyapi-installer/refs/heads/master/cliproxyapi-installer | bash
```

If using Docker instead, follow the official server deployment flow:

```bash
git clone https://github.com/router-for-me/CLIProxyAPI.git ~/CLIProxyAPI
cd ~/CLIProxyAPI
cp config.example.yaml config.yaml
```

Minimal config shape:

```yaml
host: "127.0.0.1"
port: 8317
auth-dir: "~/.cli-proxy-api"
request-retry: 3
api-keys:
  - "NO_API_KEY"
```

Find the installed binary:

```bash
CLIPROXY_BIN="$(command -v cliproxyapi || command -v cli-proxy-api)"
echo "$CLIPROXY_BIN"
```

## OAuth From Mac Browser To VPS Process

Start an iTerm2 tab on the Mac and forward the browser callback to `ohox`:

```bash
ssh -N -o ExitOnForwardFailure=yes -L 1455:127.0.0.1:1455 ohox
```

Keep that tab open until OAuth completes.

On `ohox`, run non-browser Codex/OpenAI OAuth:

```bash
CLIPROXY_BIN="$(command -v cliproxyapi || command -v cli-proxy-api)"
"$CLIPROXY_BIN" --codex-login --no-browser
```

If `--no-browser` is rejected:

```bash
"$CLIPROXY_BIN" -no-browser --codex-login
```

Open the printed URL in the Mac browser. The callback uses `http://localhost:1455`; because of the SSH `-L` tunnel, the browser callback reaches the CLIProxy process on `ohox`.

If callback port `1455` is busy on the Mac:

```bash
lsof -i :1455
```

Free the port or use the callback/tunnel option shown by the CLIProxy login command.

## Start CLIProxy On `ohox`

Foreground test:

```bash
CLIPROXY_BIN="$(command -v cliproxyapi || command -v cli-proxy-api)"
"$CLIPROXY_BIN" --config ~/.cli-proxy-api/config.yaml
```

Keep it alive with tmux:

```bash
tmux new -s cliproxy
CLIPROXY_BIN="$(command -v cliproxyapi || command -v cli-proxy-api)"
"$CLIPROXY_BIN" --config ~/.cli-proxy-api/config.yaml
# detach: Ctrl-b d
tmux attach -t cliproxy
```

If running Docker from `~/CLIProxyAPI`:

```bash
docker compose up -d
tail -f ./logs/main.log
```

## Verify Current Provider Before Bot Switch

On `ohox`:

```bash
cd ~/meridian-nanocap
node scripts/verify-llm-endpoint.js --base-url https://api.deepseek.com --model deepseek-v4-flash --api-key "$DEEPSEEK_API_KEY" --chat-smoke --tool-call-smoke --json
```

Do not switch live config if chat completions or tool calls fail.

## Nanocap Live Config Shape

Back up `user-config.json` first:

```bash
cd ~/meridian-nanocap
cp user-config.json user-config.json.bak.$(date +%Y%m%d_%H%M%S)
```

Set role models through config:

```json
{
  "llmBaseUrl": "https://api.deepseek.com",
  "llmModel": "deepseek-v4-flash",
  "screeningModel": "deepseek-v4-flash",
  "managementModel": "deepseek-v4-flash",
  "generalModel": "deepseek-v4-flash",
  "screeningReasoningEffort": null,
  "screeningFallbackModel": null
}
```

Restart only nanocap after inspecting logs:

```bash
export PATH=/home/ubuntu/.nvm/versions/node/v20.20.2/bin:$PATH
pm2 logs meridian-nanocap --lines 150 --nostream
pm2 restart meridian-nanocap --update-env
pm2 logs meridian-nanocap --lines 200 --nostream
pm2 status
```

## Owner Checks

```bash
cd ~/meridian-nanocap
node scripts/verify-runtime-config.js --json
node scripts/analyze-llm-usage.js --logs logs --json
node scripts/analyze-screener-trial.js --logs logs --hours 48 --json
tail -n 20 logs/api-activity-$(date -u +%F).jsonl
```

Expected:

- SCREENER primary calls show `model=deepseek-v4-flash`.
- SCREENER primary calls do not require GPT-only reasoning-effort fields.
- MANAGER and GENERAL use `deepseek-v4-flash`.
- No OAuth files, API keys, or wallet material appear in logs.

## Rollback

Set models back through config:

```json
{
  "screeningModel": "deepseek-v4-flash",
  "managementModel": "deepseek-v4-flash",
  "generalModel": "deepseek-v4-flash"
}
```

Then inspect logs and restart only `meridian-nanocap`.
