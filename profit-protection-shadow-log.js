import fs from "fs";
import path from "path";

const DEFAULT_LOG_DIR = "./logs";

export function getProfitProtectionShadowLogPath(ts = new Date().toISOString(), logDir = DEFAULT_LOG_DIR) {
  const dateStr = String(ts || new Date().toISOString()).slice(0, 10);
  return path.join(logDir, `profit-protection-shadow-${dateStr}.jsonl`);
}

export function appendProfitProtectionShadowRows(rows = [], { wallet = null, logDir = DEFAULT_LOG_DIR } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  fs.mkdirSync(logDir, { recursive: true });
  const written = [];
  for (const row of rows) {
    const ts = row?.ts ?? new Date().toISOString();
    const entry = { ...row, ts, wallet: wallet ?? row?.wallet ?? null, shadowOnly: true };
    const file = getProfitProtectionShadowLogPath(ts, logDir);
    fs.appendFileSync(file, JSON.stringify(entry) + "\n");
    written.push({ file, entry });
  }
  return written;
}
