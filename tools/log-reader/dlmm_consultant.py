import os, json, subprocess, sys
from datetime import datetime
from pathlib import Path

try:
    from dotenv import load_dotenv
    HAS_DOTENV = True
except ImportError:
    HAS_DOTENV = False

BASE_DIR = Path(__file__).parent.parent.parent
ENV_PATH = BASE_DIR / ".env"
SESSION_DIR = Path(__file__).parent / "sessions"

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

def get_recent_logs():
    logs_dir = BASE_DIR / "logs"
    lines = []
    if logs_dir.exists():
        log_files = sorted(logs_dir.glob("*.log")) + sorted(logs_dir.glob("*.jsonl"))
        for lf in log_files[-3:]: # check latest few
            try:
                with open(lf, "r") as f:
                    content = f.readlines()
                    lines.extend(content[-50:]) # last 50 lines
            except: pass
    return "".join(lines[-50:]) if lines else "No logs found."

def get_log_reader_data():
    reader_path = Path(__file__).parent / "dlmm_log_reader.py"
    try:
        res = subprocess.run([sys.executable, str(reader_path), "--source", "all", "--last", "24", "--json"], capture_output=True, text=True)
        return res.stdout
    except Exception as e:
        return f"Error running log reader: {e}"

def get_agents_md():
    agents_path = BASE_DIR / "AGENTS.md"
    if agents_path.exists():
        with open(agents_path, "r") as f:
            return f.read()
    return "AGENTS.md not found."

def get_state_files():
    state_dir = BASE_DIR / ".ai" / "context"
    out = []
    if state_dir.exists():
        state_files = list(state_dir.glob("*STATE*")) + list(state_dir.glob("*PROJECT_STATE*"))
        for sf in state_files:
            try:
                with open(sf, "r") as f:
                    out.append(f"--- {sf.name} ---\n{f.read()}")
            except: pass
    return "\n".join(out) if out else "No state files found."

def get_codebase_map():
    src_dir = BASE_DIR / "src"
    target = src_dir if src_dir.exists() else BASE_DIR
    files = []
    for root, _, fnames in os.walk(target):
        if "node_modules" in root or ".git" in root: continue
        for fname in fnames:
            if fname.endswith(".js") or fname.endswith(".ts"):
                files.append(str(Path(root) / fname))
    return "\n".join(files)

def load_context():
    print("Loading context...")
    context = []
    context.append("=== RECENT LOGS ===")
    context.append(get_recent_logs())
    context.append("=== LLM CALL LOGS (24h) ===")
    context.append(get_log_reader_data())
    context.append("=== AGENTS.MD ===")
    context.append(get_agents_md())
    context.append("=== STATE FILES ===")
    context.append(get_state_files())
    context.append("=== CODEBASE MAP ===")
    context.append(get_codebase_map()[:2000]) # truncated map
    print("Context loaded.")
    return "\n".join(context)

def call_dashscope(messages):
    import requests
    api_key = os.environ.get("DASHSCOPE_API_KEY", "")
    if not api_key:
        try:
            with open(BASE_DIR / "user-config.json", "r") as f:
                api_key = json.load(f).get("screeningApiKey", "")
        except:
            pass
    if not api_key:
        return "Error: DASHSCOPE_API_KEY not found in .env or user-config.json"
    
    url = "https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": "qwen-plus",
        "input": {"messages": messages},
        "parameters": {
            "result_format": "message",
            "max_tokens": 2048
        }
    }
    try:
        resp = requests.post(url, headers=headers, json=payload)
        data = resp.json()
        if "output" in data and "choices" in data["output"]:
            return data["output"]["choices"][0]["message"]["content"]
        return f"Error from API: {data}"
    except Exception as e:
        return f"Request failed: {e}"

def main():
    SESSION_DIR.mkdir(parents=True, exist_ok=True)
    session_file = SESSION_DIR / f"session_{datetime.now().strftime('%Y%m%d_%H%M%S')}.jsonl"
    
    load_env()
    context_str = load_context()
    
    system_prompt = f"""You are a technical advisor for a DLMM (Dynamic Liquidity Market Making) bot
running on Solana via Meteora pools. You have full access to the meridian fork codebase.

Your job is to:
- Answer questions about the codebase, strategy, and live bot behavior
- Interpret LLM call logs and explain what the bot was doing
- Flag anomalies in token usage, cost, or model behavior
- Help the operator make decisions about position management

Current context loaded at session start:
{context_str}

Be direct. No filler. If you don't know something, say so and suggest where to look."""

    messages = [{"role": "system", "content": system_prompt}]
    
    while True:
        try:
            user_input = input("DLMM Consultant > ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
            
        if not user_input:
            continue
            
        if user_input.lower() in ["exit", "quit"]:
            break
        elif user_input.lower() == "reload":
            context_str = load_context()
            messages[0]["content"] = system_prompt.replace(messages[0]["content"].split("Current context loaded at session start:\n")[1].split("\n\nBe direct.")[0], context_str)
            continue
        elif user_input.lower() == "logs":
            print(get_log_reader_data()[:1500] + "\n... (truncated)")
            continue
        elif user_input.lower() == "files":
            print(get_codebase_map())
            continue
            
        messages.append({"role": "user", "content": user_input})
        print("Thinking...")
        response = call_dashscope(messages)
        print(f"\n{response}\n")
        messages.append({"role": "assistant", "content": response})
        
        with open(session_file, "a") as f:
            f.write(json.dumps({"user": user_input, "assistant": response}) + "\n")

if __name__ == "__main__":
    main()
