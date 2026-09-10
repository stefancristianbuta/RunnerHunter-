import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { JsonRpcProvider, Interface, getAddress } from 'ethers';
import { applyRisk, classifyStage } from './risk.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8080);
const RPC_URLS = [...new Set([
  ...(process.env.RH_RPC_URLS || '').split(',').map(x => x.trim()).filter(Boolean),
  process.env.RH_RPC_URL,
  'https://rpc.mainnet.chain.robinhood.com',
  'https://robinhood-rpc.publicnode.com'
].filter(Boolean))];
const BLOCKSCOUT = process.env.BLOCKSCOUT_URL || 'https://robinhoodchain.blockscout.com/api/v2';
const GECKO = 'https://api.geckoterminal.com/api/v2';
const providers = RPC_URLS.map(url => new JsonRpcProvider(url, 4663, { staticNetwork: true }));

const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'.toLowerCase();
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'.toLowerCase();
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const STABLE = new Set(['WETH', 'USDG', 'USDC', 'USDT', 'DAI', 'USDE']);
const EARLY_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const erc20 = new Interface([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)'
]);
const multicall3 = new Interface([
  'function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns (tuple(bool success,bytes returnData)[] returnData)'
]);

const metaCache = new Map();
const scoutCache = new Map();
const contractCache = new Map();
const history = new Map();
let radar = [];
let geckoCache = { at: 0, pools: [] };
const geckoSources = new Map();
let geckoRefreshInFlight = false;
let scanning = false;
let enriching = false;
const started = Date.now();
let state = {
  status: 'STARTING', lastUpdate: null, scanCycle: 0, discovered: 0,
  analyzed: 0, active: 0, errors: 0, flagged: 0, warnings: [], latestBlock: null,
  uptime: 0, timeframeCoverage: 0, source: 'GeckoTerminal + multi-RPC + Blockscout'
};

async function withRpc(task) {
  let lastError;
  for (let i = 0; i < providers.length; i++) {
    try { return await task(providers[i], RPC_URLS[i]); }
    catch (e) {
      lastError = e;
      if (i < providers.length - 1) state.warnings = [...state.warnings, `RPC failover ${i + 1}->${i + 2}: ${e.message}`].slice(-10);
    }
  }
  throw lastError || new Error('No RPC providers configured');
}

async function multicall(calls) {
  const data = multicall3.encodeFunctionData('aggregate3', [calls]);
  const raw = await withRpc((p) => p.call({ to: MULTICALL3, data }));
  return multicall3.decodeFunctionResult('aggregate3', raw)[0];
}

async function tokenMeta(address) {
  const key = address.toLowerCase();
  if (metaCache.has(key)) return metaCache.get(key);
  let name = 'Unknown', symbol = '?', decimals = 18, totalSupply = 0n;
  try {
    const methods = ['name', 'symbol', 'decimals', 'totalSupply'];
    const calls = methods.map(method => ({ target: address, allowFailure: true, callData: erc20.encodeFunctionData(method) }));
    const results = await multicall(calls);
    const decode = (index, method, fallback) => {
      try {
        const result = results[index];
        if (!result?.success) return fallback;
        return erc20.decodeFunctionResult(method, result.returnData)[0];
      } catch { return fallback; }
    };
    name = decode(0, 'name', name);
    symbol = decode(1, 'symbol', symbol);
    decimals = Number(decode(2, 'decimals', decimals));
    totalSupply = decode(3, 'totalSupply', totalSupply);
  } catch {}
  const meta = { name: String(name), symbol: String(symbol), decimals, totalSupply };
  metaCache.set(key, meta);
  return meta;
}

