#!/usr/bin/env node
/**
 * Focused audit for Whale Escape / LPTELE production provider wiring.
 *
 * This is intentionally read-only. It proves whether production code wires
 * provider hooks into ActiveBinOracleRecorder and whether disabled/null states
 * are explicit enough to avoid another all-null silent scaffold.
 */

import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function source(relativePath) {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runActiveBinOracleProof() {
  const result = spawnSync(process.execPath, [join(ROOT, "scripts/verify-active-bin-oracle.js")], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`verify-active-bin-oracle failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

const activeBinSource = source("active-bin-oracle.js");
const indexSource = source("index.js");
const configBuilderSource = source("config-builder.js");
const userConfigExampleSource = source("user-config.example.json");
const executionConsumerFiles = [
  "index.js",
  "pool-memory.js",
  "tools/dlmm.js",
  "tools/executor.js",
  "tools/screening.js",
  "oor-reposition.js",
];

const activeBinConstructorCount = countMatches(activeBinSource, /new\s+ActiveBinOracleRecorder\s*\(/g);
const indexConstructorMatch = indexSource.match(
  /const\s+activeBinOracleRecorder\s*=\s*new\s+ActiveBinOracleRecorder\s*\(\s*\{(?<args>[\s\S]*?)\}\s*\)\s*;/,
);
const indexArgs = indexConstructorMatch?.groups?.args ?? "";
const productionProviders = {
  getPoolLiquidityFlowFn: /getPoolLiquidityFlowFn\s*:\s*poolLiquidityFlowProvider\b/.test(indexArgs),
  getLptele2LiquidityShapeFn: /getLptele2LiquidityShapeFn\s*:\s*lptele2LiquidityShapeProvider\b/.test(indexArgs),
  getLptele4SwapPressureFn: /getLptele4SwapPressureFn\s*:\s*lptele4SwapPressureProvider\b/.test(indexArgs),
};
const whaleEscapeProviderModuleWired = /createPoolLiquidityFlowProvider/.test(indexSource)
  && /from\s+"\.\/lp-withdrawal-shadow-provider\.js"/.test(indexSource);
const lptele2ProviderModuleWired = /createLiquidityShapeProvider/.test(indexSource)
  && /from\s+"\.\/lptele2-shape-provider\.js"/.test(indexSource);
const lptele4ProviderModuleWired = /createSwapPressureProvider/.test(indexSource)
  && /from\s+"\.\/lptele4-swap-pressure-provider\.js"/.test(indexSource);
const productionUsesConfig = /lpteleProviderConfig\s*:\s*config\.oracle\?\.providers/.test(indexArgs);
const activeBinExportsSingleton = /export\s+const\s+activeBinOracleRecorder\s*=/.test(activeBinSource);
const providerDataSources = {
  providerDisabledSource: activeBinSource.includes('"provider_disabled"'),
  providerUnwiredSource: activeBinSource.includes('"provider_unwired"'),
  providerErrorSource: activeBinSource.includes('"provider_error"'),
  whaleEscapeDataSourceAnnotated: activeBinSource.includes("whale_escape_data_source") && activeBinSource.includes("PROVIDER_DISABLED_SOURCE"),
  lptele2DataSourceAnnotated: activeBinSource.includes("lptele2_liquidity_shape_data_source") && activeBinSource.includes("PROVIDER_DISABLED_SOURCE"),
  lptele4DataSourceAnnotated: activeBinSource.includes("lptele4_swap_pressure_data_source") && activeBinSource.includes("PROVIDER_DISABLED_SOURCE"),
};
const providerHealth = {
  hasHealthLogFile: /lptele-provider-health-\$\{todayIso\(now\)\}\.jsonl/.test(activeBinSource),
  appendsHealthRows: activeBinSource.includes("source: \"lptele_provider_health\""),
  reportsProviderStatuses: activeBinSource.includes("status: \"disabled\"")
    && activeBinSource.includes("status: \"unwired\"")
    && activeBinSource.includes("status: \"wired\""),
};
const configDefaults = {
  configBuilderDefaultsDisabled: /oracle:\s*\{[\s\S]*providers:\s*\{[\s\S]*whaleEscape[\s\S]*enabled:\s*u\.oracle\?\.providers\?\.whaleEscape\?\.enabled\s*===\s*true[\s\S]*liquidityShape[\s\S]*enabled:\s*u\.oracle\?\.providers\?\.liquidityShape\?\.enabled\s*===\s*true[\s\S]*swapPressure[\s\S]*enabled:\s*u\.oracle\?\.providers\?\.swapPressure\?\.enabled\s*===\s*true/.test(configBuilderSource),
  exampleDefaultsDisabled: (() => {
    try {
      const example = JSON.parse(userConfigExampleSource);
      return example.oracle?.providers?.whaleEscape?.enabled === false
        && example.oracle?.providers?.liquidityShape?.enabled === false
        && example.oracle?.providers?.swapPressure?.enabled === false;
    } catch {
      return false;
    }
  })(),
};
const activeBinProof = runActiveBinOracleProof();

assert(activeBinConstructorCount === 0, `active-bin-oracle.js should not construct the production singleton, got ${activeBinConstructorCount}`);
assert(indexConstructorMatch, "index.js should construct activeBinOracleRecorder explicitly");
assert(productionUsesConfig, "index.js should pass config.oracle?.providers into ActiveBinOracleRecorder");
assert(productionProviders.getPoolLiquidityFlowFn, "index.js should pass the Whale Escape pool liquidity provider");
assert(productionProviders.getLptele2LiquidityShapeFn, "index.js should pass the LPTELE-2 liquidity shape provider");
assert(productionProviders.getLptele4SwapPressureFn, "index.js should pass the LPTELE-4 swap pressure provider");
assert(whaleEscapeProviderModuleWired, "index.js should import/create the Whale Escape LP withdrawal provider");
assert(lptele2ProviderModuleWired, "index.js should import/create the LPTELE-2 liquidity shape provider");
assert(lptele4ProviderModuleWired, "index.js should import/create the LPTELE-4 swap pressure provider");
assert(!activeBinExportsSingleton, "active-bin-oracle.js should not export a production singleton");
assert(configDefaults.configBuilderDefaultsDisabled, "config-builder.js should default all LPTELE providers to disabled");
assert(configDefaults.exampleDefaultsDisabled, "user-config.example.json should show all LPTELE providers disabled");
assert(Object.values(providerDataSources).every(Boolean), "provider data-source annotations should cover disabled/unwired/error states");
assert(Object.values(providerHealth).every(Boolean), "provider health JSONL should report per-provider status");
assert(activeBinProof?.success === true, "verify-active-bin-oracle synthetic proof should pass");
assert(activeBinProof?.checks?.whaleEscapeFieldsPreservedInRows === true, "synthetic Whale Escape provider row proof missing");
assert(activeBinProof?.checks?.lptele2FieldsPreservedInRows === true, "synthetic LPTELE-2 provider row proof missing");
assert(activeBinProof?.checks?.lptele4FieldsPreservedInRows === true, "synthetic LPTELE-4 provider row proof missing");
assert(activeBinProof?.checks?.lpteleProviderDisabledHealthRows === true, "disabled provider health row proof missing");
assert(activeBinProof?.checks?.noWhaleEscapeExecutionConsumers === true, "Whale Escape fields should not be consumed by execution paths");
assert(activeBinProof?.checks?.noLptele2ExecutionConsumers === true, "LPTELE-2 fields should not be consumed by execution paths");
assert(activeBinProof?.checks?.noLptele4ExecutionConsumers === true, "LPTELE-4 fields should not be consumed by execution paths");

const executionConsumers = [];
for (const file of executionConsumerFiles) {
  const text = source(file);
  const consumed = [
    "whale_escape_",
    "pool_lp_net_dep_usd",
    "quote_reserves_in_active_bin_usd",
    "adjacent_bin_liquidity_cliff_pct",
    "swap_sell_usd_5m",
    "sell_buy_ratio_5m",
  ].filter((needle) => text.includes(needle));
  if (consumed.length) executionConsumers.push({ file, consumed });
}

const provider_statuses = {
  whale_escape: "disabled",
  lptele2_liquidity_shape: "disabled",
  lptele4_swap_pressure: "disabled",
};

const proof = {
  success: true,
  classification: "disabled_provider_scaffold",
  warning: "Provider hooks are now explicit and disabled by config; live rows should carry provider_disabled data-source values until a real provider ticket enables one provider.",
  production_wiring: {
    production_instance: "index.js: activeBinOracleRecorder",
    active_bin_oracle_constructor_count: activeBinConstructorCount,
    production_constructor_has_explicit_args: true,
    production_uses_provider_config: productionUsesConfig,
    production_providers: productionProviders,
    whale_escape_provider_module_wired: whaleEscapeProviderModuleWired,
    lptele2_provider_module_wired: lptele2ProviderModuleWired,
    lptele4_provider_module_wired: lptele4ProviderModuleWired,
    provider_statuses,
    active_bin_oracle_exports_singleton: activeBinExportsSingleton,
  },
  health_guard: {
    config_defaults: configDefaults,
    provider_data_sources: providerDataSources,
    provider_health: providerHealth,
  },
  synthetic_provider_injection: {
    verify_active_bin_oracle_success: true,
    whale_escape_fields_preserved: true,
    lptele2_fields_preserved: true,
    lptele4_fields_preserved: true,
    disabled_health_rows_written: true,
  },
  execution_consumers: {
    has_whale_escape_or_lptele_execution_consumers: executionConsumers.length > 0,
    files: executionConsumers,
  },
  report_expected_path_exists: existsSync(join(ROOT, "../meridian-intelligence/reports/latest_whale_escape_provider_wiring_audit.md")),
};

console.log(JSON.stringify(proof, null, 2));
