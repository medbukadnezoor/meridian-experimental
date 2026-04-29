#!/usr/bin/env node

import assert from "assert";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const source = readFileSync(join(root, "tools/dlmm.js"), "utf8");

assert.ok(source.includes("ComputeBudgetProgram"), "urgent close path should import ComputeBudgetProgram");
assert.ok(source.includes("URGENT_CLOSE_PRIORITY_MICRO_LAMPORTS"), "urgent close priority constant should exist");
assert.ok(source.includes("sendCloseTransactionWithRetry"), "close send retry helper should exist");
assert.ok(source.includes("getLatestBlockhash(\"confirmed\")"), "close send helper should refresh blockhash before send");
assert.ok(source.includes("already-closed-after-send"), "send helper should tolerate successful close after send/confirm error");
assert.ok(
  source.includes("Urgent close: skipping relay zap-out and using local close-liquidity-first path"),
  "urgent closes should skip relay zap-out and go local close-first",
);
assert.ok(
  source.includes("if (!urgent && shouldUseLpAgentRelay())"),
  "relay zap-out should remain available only for non-urgent closes",
);
assert.ok(
  /sendCloseTransactionWithRetry\(tx, wallet, \{\s*urgent: !!urgent,\s*positionPubKey,\s*label: "remove-liquidity close"/s.test(source),
  "remove-liquidity close should use retry helper",
);
assert.ok(
  /sendCloseTransactionWithRetry\(closeTx, wallet, \{\s*urgent: !!urgent,\s*positionPubKey,\s*label: "close-position"/s.test(source),
  "empty-position close should use retry helper",
);

console.log(JSON.stringify({
  success: true,
  checks: {
    urgentSkipsRelay: true,
    closeFirstLocalPath: true,
    priorityFeeForUrgentLegacyTx: true,
    freshBlockhashBeforeSend: true,
    closeSendRetry: true,
    alreadyClosedAfterSendAccepted: true,
  },
}, null, 2));
