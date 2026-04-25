#!/usr/bin/env node
/**
 * Synthetic proof for upstream envrypt + relay signing hardening.
 *
 * This verifier is local-only. It creates temporary env files and synthetic
 * Solana transactions, and never calls trading APIs or submits transactions.
 */

import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  assertNoUnsafeSystemTransfer,
  signAndSimulateRelayTransactions,
} from "../tools/relay-security.js";

process.env.MERIDIAN_ENVCRYPT_AUTOLOAD = "false";
const {
  envryptDecrypt,
  envryptEncrypt,
  encryptEnvRaw,
  loadEnv,
} = await import("../envcrypt.js");

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function readSource(relativePath) {
  return fs.readFileSync(join(ROOT, relativePath), "utf8");
}

function makeTransferTx(owner, destination, lamports) {
  const tx = new Transaction();
  tx.feePayer = owner.publicKey;
  tx.recentBlockhash = Keypair.generate().publicKey.toString();
  tx.add(SystemProgram.transfer({
    fromPubkey: owner.publicKey,
    toPubkey: destination,
    lamports,
  }));
  return tx;
}

function txToBase64(tx) {
  return tx.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  }).toString("base64");
}

function restoreEnv(saved) {
  for (const [key, value] of Object.entries(saved)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

function runSourceProof() {
  const gitignore = readSource(".gitignore");
  const envcrypt = readSource("envcrypt.js");
  const envryptScript = readSource("scripts/envrypt.js");
  const index = readSource("index.js");
  const setup = readSource("setup.js");
  const cli = readSource("cli.js");
  const packageJson = JSON.parse(readSource("package.json"));
  const dlmm = readSource("tools/dlmm.js");
  const relaySecurity = readSource("tools/relay-security.js");

  assert.ok(gitignore.includes(".envrypt"), ".envrypt is gitignored");
  assert.ok(gitignore.includes(".env.*"), ".env.raw remains covered by .env.* ignore");
  for (const exportName of ["loadEnv", "envryptEncrypt", "envryptDecrypt", "encryptEnvRaw"]) {
    assert.ok(envcrypt.includes(`export function ${exportName}`), `envcrypt exports ${exportName}`);
  }
  assert.ok(envryptScript.includes("encryptEnvRaw"), "scripts/envrypt.js encrypt helper present");
  assert.ok(index.includes('import "./envcrypt.js"'), "index.js loads envcrypt");
  assert.ok(setup.includes('import "./envcrypt.js"'), "setup.js loads envcrypt");
  assert.ok(!index.includes('dotenv/config'), "index.js does not use bare dotenv/config");
  assert.ok(!setup.includes('dotenv/config'), "setup.js does not use bare dotenv/config");
  assert.ok(cli.includes('import { loadEnv } from "./envcrypt.js"'), "cli.js imports loadEnv");
  assert.ok(cli.includes('keyPath: path.join(meridianDir, ".envrypt")'), "cli.js supports ~/.meridian/.envrypt");
  assert.ok(!cli.includes('dotenv/config'), "cli.js does not use bare dotenv/config");
  assert.strictEqual(packageJson.scripts?.["env:encrypt"], "node scripts/envrypt.js encrypt");
  assert.ok(relaySecurity.includes("SystemInstruction"), "relay-security imports SystemInstruction");
  assert.ok(relaySecurity.includes("SystemProgram"), "relay-security imports SystemProgram");
  assert.ok(relaySecurity.includes("TransactionInstruction"), "relay-security imports TransactionInstruction");
  assert.ok(relaySecurity.includes("ix.accountKeyIndexes || ix.accounts || []"), "versioned instruction extraction handles both index fields");
  assert.ok(relaySecurity.includes("assertNoUnsafeSystemTransfer"), "unsafe system transfer guard present");
  assert.ok(relaySecurity.includes("simulateTransaction"), "simulation before submit guard present");
  assert.ok(dlmm.includes('import { signAndSimulateRelayTransactions } from "./relay-security.js"'), "dlmm imports relay signing guard");
  assert.ok(dlmm.includes('label: "zap-out close"'), "zap-out close guarded");
  assert.ok(dlmm.includes('label: "zap-out swap"'), "zap-out swap guarded");
  assert.ok(dlmm.includes('requiredStaticAccounts: [wallet.publicKey.toString(), position_address]'), "zap-out close requires wallet and position");
  assert.ok(dlmm.includes('label: "zap-in addLiquidity"'), "zap-in addLiquidity guarded");
  assert.ok(dlmm.includes('label: "zap-in swap"'), "zap-in swap guarded");
  assert.ok(dlmm.includes("const maxDeploySolLoss = Math.max(0.05, Number(finalAmountY || 0) + 0.15)"), "zap-in SOL debit bound present");
  assert.ok(dlmm.includes("relaySubmitted = true"), "relay submit marker present");
  assert.ok(dlmm.includes("if (relaySubmitted) throw relayError"), "post-submit fallback is blocked");
  assert.ok(!dlmm.includes("close: signSerializedTransactions(closeUnsigned, wallet)"), "zap-out close no longer raw-signs at submit");
  assert.ok(!dlmm.includes("swap: signSerializedTransactions(swapUnsigned, wallet)"), "zap-out swap no longer raw-signs at submit");
  assert.ok(!dlmm.includes("const addLiquidity = signSerializedTransactions(addLiquidityUnsigned, wallet)"), "zap-in addLiquidity no longer raw-signs");
  assert.ok(!dlmm.includes("const swap = signSerializedTransactions(swapUnsigned, wallet)"), "zap-in swap no longer raw-signs");

  return {
    envryptIgnored: true,
    envcryptEntrypoints: true,
    cliHomeEnvrypt: true,
    relayGuardWiredForZapOut: true,
    relayGuardWiredForZapIn: true,
    postSubmitFallbackBlocked: true,
  };
}

function runEnvcryptProof() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-envcrypt-"));
  const keys = ["PLAIN_VALUE", "SECRET_TOKEN", "UNMARKED_TOKEN", "ENVRYPT_KEY", "ENVCRYPT_KEY"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];

    const key = "local-test-key-123";
    const envPath = path.join(tempDir, ".env");
    const keyPath = path.join(tempDir, ".envrypt");
    const encryptedSecret = envryptEncrypt("clear-secret", key);
    const encryptedUnmarked = envryptEncrypt("leave-encrypted", key);
    fs.writeFileSync(keyPath, `${key}\n`);
    fs.writeFileSync(envPath, [
      "PLAIN_VALUE=visible",
      "# encrypted",
      `SECRET_TOKEN=${encryptedSecret}`,
      `UNMARKED_TOKEN=${encryptedUnmarked}`,
      "",
    ].join("\n"));

    const loaded = loadEnv({ envPath, keyPath, override: true });
    assert.deepStrictEqual(loaded.encryptedKeys, ["SECRET_TOKEN"]);
    assert.strictEqual(process.env.PLAIN_VALUE, "visible");
    assert.strictEqual(process.env.SECRET_TOKEN, "clear-secret");
    assert.strictEqual(process.env.UNMARKED_TOKEN, encryptedUnmarked);
    assert.strictEqual(envryptDecrypt(encryptedSecret, key), "clear-secret");

    const rawPath = path.join(tempDir, ".env.raw");
    const outPath = path.join(tempDir, ".env.out");
    fs.writeFileSync(rawPath, "WALLET_PRIVATE_KEY=wallet-secret\nPUBLIC_FLAG=yes\n");
    const encryptedOutput = encryptEnvRaw({ rawPath, outPath, keyPath });
    const output = fs.readFileSync(encryptedOutput.outPath, "utf8");
    assert.ok(output.includes("# encrypted"));
    assert.ok(output.includes("PUBLIC_FLAG=yes"));
    assert.ok(!output.includes("wallet-secret"));

    const noKeyEnvPath = path.join(tempDir, ".env.no-key");
    fs.writeFileSync(noKeyEnvPath, `# encrypted\nSECRET_TOKEN=${encryptedSecret}\n`);
    assert.throws(
      () => loadEnv({ envPath: noKeyEnvPath, keyPath: path.join(tempDir, ".missing"), override: true }),
      /no envrypt key was provided/,
    );

    return {
      roundTrip: true,
      markerOnlyDecrypt: true,
      missingKeyFails: true,
      encryptEnvRawWritesEncryptedSecrets: true,
    };
  } finally {
    restoreEnv(saved);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runRelayProof() {
  const owner = Keypair.generate();
  const attacker = Keypair.generate().publicKey;
  const allowedDestination = Keypair.generate().publicKey;
  const allowedMint = Keypair.generate().publicKey.toString();
  const unrelatedMint = Keypair.generate().publicKey.toString();
  const safeTx = makeTransferTx(owner, allowedDestination, 1_000_000);
  const unsafeTx = makeTransferTx(owner, attacker, 1_000_000);

  assert.throws(
    () => assertNoUnsafeSystemTransfer(unsafeTx, owner, [allowedDestination.toString()]),
    /direct SOL transfer from owner/,
  );
  assert.doesNotThrow(() =>
    assertNoUnsafeSystemTransfer(safeTx, owner, [allowedDestination.toString()])
  );

  let simulateCalls = 0;
  const safeConnection = {
    async simulateTransaction() {
      simulateCalls += 1;
      return {
        value: {
          err: null,
          preBalances: [LAMPORTS_PER_SOL],
          postBalances: [LAMPORTS_PER_SOL - 1_000_000],
          preTokenBalances: [],
          postTokenBalances: [],
        },
      };
    },
  };

  const signed = await signAndSimulateRelayTransactions([txToBase64(safeTx)], owner, {
    connection: safeConnection,
    label: "verifier safe",
    allowedSystemTransferDestinations: [allowedDestination.toString()],
    allowedDebitMints: [allowedMint],
    maxSolLoss: 0.01,
    requiredStaticAccounts: [owner.publicKey.toString()],
  });
  assert.strictEqual(signed.length, 1);
  assert.strictEqual(simulateCalls, 1);

  await assert.rejects(
    signAndSimulateRelayTransactions([txToBase64(safeTx)], owner, {
      connection: safeConnection,
      label: "verifier missing",
      allowedSystemTransferDestinations: [allowedDestination.toString()],
      requiredStaticAccounts: [Keypair.generate().publicKey.toString()],
    }),
    /missing required account/,
  );

  await assert.rejects(
    signAndSimulateRelayTransactions([txToBase64(unsafeTx)], owner, {
      connection: safeConnection,
      label: "verifier unsafe",
      allowedSystemTransferDestinations: [allowedDestination.toString()],
      requiredStaticAccounts: [owner.publicKey.toString()],
    }),
    /direct SOL transfer from owner/,
  );

  const highSolLossConnection = {
    async simulateTransaction() {
      return {
        value: {
          err: null,
          preBalances: [LAMPORTS_PER_SOL],
          postBalances: [LAMPORTS_PER_SOL - 100_000_000],
          preTokenBalances: [],
          postTokenBalances: [],
        },
      };
    },
  };
  await assert.rejects(
    signAndSimulateRelayTransactions([txToBase64(safeTx)], owner, {
      connection: highSolLossConnection,
      label: "verifier high-sol-loss",
      allowedSystemTransferDestinations: [allowedDestination.toString()],
      maxSolLoss: 0.01,
      requiredStaticAccounts: [owner.publicKey.toString()],
    }),
    /would debit .* SOL from owner/,
  );

  const simulationErrorConnection = {
    async simulateTransaction() {
      return { value: { err: { InstructionError: [0, "Custom"] } } };
    },
  };
  await assert.rejects(
    signAndSimulateRelayTransactions([txToBase64(safeTx)], owner, {
      connection: simulationErrorConnection,
      label: "verifier sim-error",
      allowedSystemTransferDestinations: [allowedDestination.toString()],
      requiredStaticAccounts: [owner.publicKey.toString()],
    }),
    /simulation failed/,
  );

  const tokenDebitConnection = {
    async simulateTransaction() {
      return {
        value: {
          err: null,
          preBalances: [LAMPORTS_PER_SOL],
          postBalances: [LAMPORTS_PER_SOL],
          preTokenBalances: [
            { owner: owner.publicKey.toString(), mint: unrelatedMint, uiTokenAmount: { amount: "100" } },
          ],
          postTokenBalances: [
            { owner: owner.publicKey.toString(), mint: unrelatedMint, uiTokenAmount: { amount: "50" } },
          ],
        },
      };
    },
  };
  await assert.rejects(
    signAndSimulateRelayTransactions([txToBase64(safeTx)], owner, {
      connection: tokenDebitConnection,
      label: "verifier token-debit",
      allowedSystemTransferDestinations: [allowedDestination.toString()],
      allowedDebitMints: [allowedMint],
      requiredStaticAccounts: [owner.publicKey.toString()],
    }),
    /unrelated token mint/,
  );

  return {
    unsafeSystemTransferRejected: true,
    safeSimulationSigns: true,
    requiredStaticAccountEnforced: true,
    simulationErrorRejected: true,
    maxSolLossEnforced: true,
    unrelatedTokenDebitRejected: true,
  };
}

const proof = {
  success: true,
  sourceProof: runSourceProof(),
  envcryptProof: runEnvcryptProof(),
  relayProof: await runRelayProof(),
  localOnly: true,
};

console.log(JSON.stringify(proof, null, 2));
