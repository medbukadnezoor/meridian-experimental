# CLIProxyAPI Nanocap Screener Runbook

This runbook is for the nanocap screener-only `gpt-5.4` trial. CLIProxyAPI runs on VPS `ohox`; the Mac is used only for the browser OAuth callback tunnel.

## Safety Rules

- Keep CLIProxy bound to `127.0.0.1`.
- Do not paste OAuth tokens, auth JSON, API keys, wallet material, or shell history into repo files, tickets, or chat.
- Do not restart the main `meridian` PM2 process.
- Do not switch management or general chat to GPT; only the nanocap screener may use `gpt-5.4`.
- If CLIProxy is down, nanocap must fall back to Qwen/DashScope or fail clearly.

## Install On `ohox`

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

## Verify CLIProxy Before Bot Switch

On `ohox`:

```bash
curl -s http://127.0.0.1:8317/v1/models | jq -r '.data[].id' | grep -E 'gpt-5.4|gpt-5.5|gpt-5.4-mini'
cd ~/meridian-nanocap
node scripts/verify-llm-endpoint.js --base-url http://127.0.0.1:8317/v1 --model gpt-5.4 --api-key NO_API_KEY --chat-smoke --tool-call-smoke --json
```

Do not switch live config if chat completions or tool calls fail. If CLIProxy only supports a Responses-style API for the model, create a separate implementation ticket instead.

## Nanocap Live Config Shape

Back up `user-config.json` first:

```bash
cd ~/meridian-nanocap
cp user-config.json user-config.json.bak.$(date +%Y%m%d_%H%M%S)
```

Set only screener primary to CLIProxy and keep Qwen/DashScope for fallback, management, and general:

```json
{
  "screeningModel": "gpt-5.4",
  "screeningBaseUrl": "http://127.0.0.1:8317/v1",
  "screeningApiKey": "NO_API_KEY",
  "screeningFallbackModel": "qwen3.6-plus",
  "screeningFallbackBaseUrl": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  "screeningFallbackApiKey": "YOUR_DASHSCOPE_API_KEY",
  "managementModel": "qwen3.6-plus",
  "managementBaseUrl": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  "managementApiKey": "YOUR_DASHSCOPE_API_KEY",
  "generalModel": "qwen3.6-plus",
  "generalBaseUrl": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  "generalApiKey": "YOUR_DASHSCOPE_API_KEY"
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
tail -n 20 logs/api-activity-$(date -u +%F).jsonl
```

Expected:

- SCREENER primary calls show `model=gpt-5.4`, `route_kind=primary`, and `base_url_host=127.0.0.1:8317`.
- SCREENER fallback calls show `model=qwen3.6-plus`, `route_kind=fallback`, and DashScope host.
- MANAGER and GENERAL stay on `qwen3.6-plus`.
- No OAuth files, API keys, or wallet material appear in logs.

## Rollback

Set screener back to DashScope/Qwen:

```json
{
  "screeningModel": "qwen3.6-plus",
  "screeningBaseUrl": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  "screeningApiKey": "YOUR_DASHSCOPE_API_KEY"
}
```

Then inspect logs and restart only `meridian-nanocap`.
