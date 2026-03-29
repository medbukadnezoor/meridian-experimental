/**
 * OKX DEX API helpers — auth signing + cluster overview + price info (ATH)
 * Docs: https://web3.okx.com/build/dev-docs/
 */

import crypto from "crypto";

const BASE = "https://www.okx.com";
const CHAIN_SOLANA = "501";

function sign(timestamp, method, path, body = "") {
  const pre = timestamp + method.toUpperCase() + path + body;
  return crypto.createHmac("sha256", process.env.OKX_SECRET_KEY).update(pre).digest("base64");
}

function headers(method, path, body = "") {
  const ts = new Date().toISOString();
  return {
    "Content-Type": "application/json",
    "OK-ACCESS-KEY": process.env.OKX_API_KEY,
    "OK-ACCESS-SIGN": sign(ts, method, path, body),
    "OK-ACCESS-TIMESTAMP": ts,
    "OK-ACCESS-PASSPHRASE": process.env.OKX_PASSPHRASE,
  };
}

async function okxGet(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: headers("GET", path),
  });
  if (!res.ok) throw new Error(`OKX API ${res.status}: ${path}`);
  const json = await res.json();
  if (json.code !== "0" && json.code !== 0) throw new Error(`OKX error ${json.code}: ${json.msg}`);
  return json.data;
}

async function okxPost(path, body) {
  const bodyStr = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: headers("POST", path, bodyStr),
    body: bodyStr,
  });
  if (!res.ok) throw new Error(`OKX API ${res.status}: ${path}`);
  const json = await res.json();
  if (json.code !== "0" && json.code !== 0) throw new Error(`OKX error ${json.code}: ${json.msg}`);
  return json.data;
}

/**
 * Cluster overview for a token — bundle %, rug pull %, new wallet %, same-fund-source %.
 * chainIndex: "501" for Solana (default)
 */
export async function getClusterOverview(tokenAddress, chainIndex = CHAIN_SOLANA) {
  const path = `/api/v6/dex/token/cluster-overview?chainIndex=${chainIndex}&tokenContractAddress=${tokenAddress}`;
  const data = await okxGet(path);
  const d = Array.isArray(data) ? data[0] : data;
  if (!d) return null;
  return {
    rug_pull_pct:        parseFloat(d.rugPullPercent      ?? d.rug_pull_percent      ?? 0),
    same_fund_source_pct: parseFloat(d.sameFundSourcePercent ?? d.same_fund_source_percent ?? 0),
    new_wallet_pct:      parseFloat(d.holderNewAddressPercent ?? d.holder_new_address_percent ?? 0),
    cluster_concentration: parseFloat(d.clusterConcentration ?? d.cluster_concentration ?? 0),
  };
}

/**
 * Price info for a token — current price, ATH (maxPrice), ATL (minPrice), volumes.
 */
export async function getPriceInfo(tokenAddress, chainIndex = CHAIN_SOLANA) {
  const data = await okxPost("/api/v6/dex/market/price-info", [
    { chainIndex, tokenContractAddress: tokenAddress },
  ]);
  const d = Array.isArray(data) ? data[0] : data;
  if (!d) return null;
  const price    = parseFloat(d.price    || 0);
  const maxPrice = parseFloat(d.maxPrice || 0);
  return {
    price,
    ath:            maxPrice,
    atl:            parseFloat(d.minPrice || 0),
    price_vs_ath_pct: maxPrice > 0 ? parseFloat(((price / maxPrice) * 100).toFixed(1)) : null,
    volume_24h:     parseFloat(d.volume24H || 0),
    price_change_24h: parseFloat(d.priceChange24H || 0),
  };
}
