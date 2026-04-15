import os, json, subprocess, argparse, sys
from datetime import datetime, timedelta
from pathlib import Path

try:
    from dotenv import load_dotenv
    HAS_DOTENV = True
except ImportError:
    HAS_DOTENV = False

SLS_PROJECT = "aliyun-product-data-5095561301844999-ap-southeast-1"
SLS_AUDIT_LOGSTORE = "bailian-model-audit-log"
SLS_INFERENCE_LOGSTORE = "bailian-model-inference-log"
SLS_REGION = "ap-southeast-1"
SLS_PROFILE = "main-account"

BASE_DIR = Path(__file__).parent.parent.parent
ENV_PATH = BASE_DIR / ".env"

def load_env():
    if HAS_DOTENV:
        load_dotenv(ENV_PATH)
    else:
        if ENV_PATH.exists():
            with open(ENV_PATH, "r") as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        k, v = line.split("=", 1)
                        if k not in os.environ:
                            os.environ[k] = v.strip(""" '" """)

def fetch_dashscope(hours, model_filter=None):
    api_key = os.environ.get("DASHSCOPE_API_KEY", "")
    if not api_key:
        try:
            with open(BASE_DIR / "user-config.json", "r") as f:
                api_key = json.load(f).get("screeningApiKey", "")
        except:
            pass
    if not api_key:
        print("Warning: DASHSCOPE_API_KEY not found in .env or user-config.json, skipping dashscope", file=sys.stderr)
        return []
    # Simplified placeholder for actual DashScope usage API call
    return []

def fetch_openrouter(hours, model_filter=None):
    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    if not api_key:
        print("Warning: OPENROUTER_API_KEY not found in .env, skipping openrouter", file=sys.stderr)
        return []
        
    start_time = datetime.utcnow() - timedelta(hours=hours)
    try:
        import requests
        headers = {"Authorization": f"Bearer {api_key}"}
        resp = requests.get("https://openrouter.ai/api/v1/credits", headers=headers, timeout=5) # openrouter/api/v1/activity or credits
        # Mocking an empty return since OpenRouter activity returns require specific parameterization or pagination.
        return []
    except Exception as e:
        print(f"OpenRouter query failed: {e}", file=sys.stderr)
    return []

def create_sls_index(logstore):
    print(f"SLS index missing for {logstore}. Attempting to create...", file=sys.stderr)
    cmd = [
        "aliyun", "--profile", SLS_PROFILE, "sls", "CreateIndex",
        "--project", SLS_PROJECT,
        "--logstore", logstore,
        "--body", '{"line":{"token":[",", " ", "\\"", "\\n", "\\t"],"caseSensitive":false}}'
    ]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True)
        if res.returncode == 0:
            print(f"Index created for {logstore}. Waiting 5 seconds for propagation...", file=sys.stderr)
            import time
            time.sleep(5)
            return True
        else:
            print(f"Failed to create index for {logstore}: {res.stderr}", file=sys.stderr)
    except Exception as e:
        print(f"Index creation subprocess failed: {e}", file=sys.stderr)
    return False

def fetch_sls_logstore(logstore, hours, model_filter=None, retry=True):
    now = int(datetime.now().timestamp())
    past = int((datetime.now() - timedelta(hours=hours)).timestamp())
    cmd = [
        "aliyun", "--profile", SLS_PROFILE, "sls", "GetLogs",
        "--project", SLS_PROJECT,
        "--logstore", logstore,
        "--from", str(past),
        "--to", str(now),
        "--query", "*",
        "--line", "1000"
    ]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True)
        if res.returncode == 0:
            try:
                data = json.loads(res.stdout)
                ret = []
                if isinstance(data, list):
                    for row in data:
                        # Map schema fields based on identified audit/inference logs
                        r_model = row.get("model", "unknown")
                        if model_filter and model_filter not in r_model:
                            continue
                            
                        # Extract usage
                        usage_str = row.get("usage", "{}")
                        try:
                            usage_data = json.loads(usage_str)
                        except:
                            usage_data = {}
                            
                        ret.append({
                           "timestamp": row.get("start_time", row.get("__time__", str(now))),
                           "source": "sls",
                           "model": r_model,
                           "input_tokens": int(usage_data.get("input_tokens", 0)),
                           "output_tokens": int(usage_data.get("output_tokens", 0)),
                           "cost_estimate": 0.0, # requires pricing logic
                           "status": row.get("status_code", "unknown"),
                           "request_id": row.get("request_id", ""),
                           "error_message": row.get("error_message", "")
                        })
                return ret
            except Exception as e:
                print(f"Parse failed for {logstore}: {e}", file=sys.stderr)
        else:
            if "IndexConfigNotExist" in res.stderr and retry:
                if create_sls_index(logstore):
                    return fetch_sls_logstore(logstore, hours, model_filter, retry=False)
            print(f"SLS query failed for {logstore}: {res.stderr}", file=sys.stderr)
    except Exception as e:
        print(f"SLS subprocess failed for {logstore}: {e}", file=sys.stderr)
    return []

def fetch_sls(hours, model_filter=None):
    audit_logs = fetch_sls_logstore(SLS_AUDIT_LOGSTORE, hours, model_filter)
    inference_logs = fetch_sls_logstore(SLS_INFERENCE_LOGSTORE, hours, model_filter)
    
    # Merge and deduplicate by request_id
    merged = {}
    for l in audit_logs + inference_logs:
        rid = l.get("request_id")
        if not rid:
            merged[f"no_id_{len(merged)}"] = l
            continue
            
        if rid in merged:
            # Prefer entry with more info (like usage or status)
            if not merged[rid].get("input_tokens") and l.get("input_tokens"):
                merged[rid].update(l)
        else:
            merged[rid] = l
            
    return list(merged.values())

def main():
    parser = argparse.ArgumentParser(description="DLMM Log Reader")
    parser.add_argument("--source", choices=["dashscope", "openrouter", "sls", "all"], required=True)
    parser.add_argument("--last", type=int, default=24)
    parser.add_argument("--model", type=str, default=None)
    parser.add_argument("--api-key", type=str, default=None, help="Specific API key for the chosen source")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--summary", action="store_true")
    args = parser.parse_args()

    load_env()
    
    # Overwrite environment variable if explicit key is passed via CLI
    if args.api_key:
        if args.source == "dashscope" or args.source == "sls":
            os.environ["DASHSCOPE_API_KEY"] = args.api_key
        elif args.source == "openrouter":
            os.environ["OPENROUTER_API_KEY"] = args.api_key
    
    logs = []
    if args.source in ["dashscope", "all"]:
        logs.extend(fetch_dashscope(args.last, args.model))
    if args.source in ["openrouter", "all"]:
        logs.extend(fetch_openrouter(args.last, args.model))
    if args.source in ["sls", "all"]:
        logs.extend(fetch_sls(args.last, args.model))
        
    logs.sort(key=lambda x: x.get("timestamp", ""), reverse=True)
    
    if args.summary:
        total_calls = len(logs)
        total_in_tk = sum(int(lx.get("input_tokens", 0)) for lx in logs)
        total_out_tk = sum(int(lx.get("output_tokens", 0)) for lx in logs)
        total_cost = sum(float(lx.get("cost_estimate", 0.0)) for lx in logs)
        if args.json:
            print(json.dumps({
                "total_calls": total_calls,
                "total_input_tokens": total_in_tk,
                "total_output_tokens": total_out_tk,
                "total_cost_estimate": total_cost
            }, indent=2))
        else:
            print(f"--- SUMMARY ({args.last}h) ---")
            print(f"Total Calls:   {total_calls}")
            print(f"Input Tokens:  {total_in_tk}")
            print(f"Output Tokens: {total_out_tk}")
            print(f"Est. Cost:     ${total_cost:.4f}")
        return

    if args.json:
        print(json.dumps(logs, indent=2))
    else:
        print(f"{'TIMESTAMP':<22} | {'SOURCE':<10} | {'MODEL':<20} | {'IN_TK':<8} | {'OUT_TK':<8} | {'COST':<8} | {'STATUS'}")
        print("-" * 100)
        for log in logs:
            ts = str(log.get("timestamp", ""))[:20]
            src = str(log.get("source", ""))[:10]
            mod = str(log.get("model", ""))[:20]
            itk = str(log.get("input_tokens", 0))
            otk = str(log.get("output_tokens", 0))
            cst = f"{float(log.get('cost_estimate', 0.0)):.4f}"
            st = str(log.get("status", "unknown"))
            print(f"{ts:<22} | {src:<10} | {mod:<20} | {itk:<8} | {otk:<8} | {cst:<8} | {st}")

if __name__ == "__main__":
    main()
