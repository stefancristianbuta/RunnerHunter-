import { JsonRpcProvider, Interface, AbiCoder, getAddress, ZeroAddress } from 'ethers';

const CHAIN_ID = 4663;
const BLOCKSCOUT = process.env.BLOCKSCOUT_URL || 'https://robinhoodchain.blockscout.com/api/v2';
const RPC_URLS = [...new Set([
  ...(process.env.RH_RPC_URLS || '').split(',').map(x => x.trim()).filter(Boolean),
  process.env.RH_RPC_URL,
  'https://rpc.mainnet.chain.robinhood.com',
  'https://robinhood-rpc.publicnode.com'
].filter(Boolean))];
const providers = RPC_URLS.map(url => new JsonRpcProvider(url, CHAIN_ID, { staticNetwork: true }));
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const V2_ROUTER = '0x89e5db8b5aa49aa85ac63f691524311aeb649eba';
const V2_FACTORY = '0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f';
const V3_ROUTER = '0xcaf681a66d020601342297493863e78c959e5cb2';
const V3_FACTORY = '0x1f7d7550b1b028f7571e69a784071f0205fd2efa';
const SIM_FROM = '0x0000000000000000000000000000000000000a11';
const TEST_ETH = 10_000_000_000_000_000n;
const CACHE_MS = 15 * 60 * 1000;
const simulationCache = new Map();
const securityCache = new Map();
const pending = new Map();

const V2_FACTORY_IFACE = new Interface(['function getPair(address,address) view returns (address)']);
const V3_FACTORY_IFACE = new Interface(['function getPool(address,address,uint24) view returns (address)']);
const V3_POOL_IFACE = new Interface(['function liquidity() view returns (uint128)']);
const OWNER_IFACE = new Interface([
  'function owner() view returns (address)',
  'function getOwner() view returns (address)',
  'function admin() view returns (address)',
  'function proxyAdmin() view returns (address)'
]);
const ABI_CODER = AbiCoder.defaultAbiCoder();

// ScanHood's read-only constructor simulator. It never deploys or spends funds.
const SIM_INIT = '0x60806040526040516109a03803806109a083398101604081905261002291610829565b5f349050866001600160a01b031663d0e30db0826040518263ffffffff1660e01b81526004015f604051808303818588803b15801561005f575f5ffd5b505af1158015610071573d5f5f3e3d5ffd5b50505050505f83156101da5760405163095ea7b360e01b81526001600160a01b0386811660048301525f19602483015289169063095ea7b3906044016020604051808303815f875af11580156100c9573d5f5f3e3d5ffd5b505050506040513d601f19601f820116820180604052508101906100ed91906108a4565b506040805160e0810182526001600160a01b038a811682528981166020830190815262ffffff8781168486019081523060608601908152608086018981525f60a0880181815260c0890191825298516304e45aaf60e01b815297518716600489015294518616602488015291519092166044860152905183166064850152516084840152925160a48301529151821660c4820152908616906304e45aaf9060e4016020604051808303815f875af19250505080156101c8575060408051601f3d908101601f191682019092526101c5918101906108c4565b60015b6101d357505f610414565b9050610414565b60405163095ea7b360e01b81526001600160a01b0387811660048301525f19602483015289169063095ea7b3906044016020604051808303815f875af1158015610226573d5f5f3e3d5ffd5b505050506040513d601f19601f8201168201806040525081019061024a91906108a4565b506040805160028082526060820183525f9260208301908036833701905050905088815f8151811061027e5761027e6108db565b60200260200101906001600160a01b031690816001600160a01b03168152505087816001815181106102b2576102b26108db565b6001600160a01b0392831660209182029290920101526040516370a0823160e01b81523060048201525f918a16906370a0823190602401602060405180830381865afa158015610304573d5f5f3e3d5ffd5b505050506040513d601f19601f8201168201806040525081019061032891906108c4565b90506001600160a01b038816635c11d795855f853061034842603c610903565b6040518663ffffffff1660e01b815260040161036895949392919061091c565b5f604051808303815f87803b15801561037f575f5ffd5b505af1925050508015610390575060015b61039c575f9250610411565b6040516370a0823160e01b815230600482015281906001600160a01b038b16906370a0823190602401602060405180830381865afa1580156103e0573d5f5f3e3d5ffd5b505050506040513d601f19601f8201168201806040525081019061040491906108c4565b61040e919061098c565b92505b50505b5f8082156107c2576040516370a0823160e01b81523060048201525f906001600160a01b038c16906370a0823190602401602060405180830381865afa158015610460573d5f5f3e3d5ffd5b505050506040513d601f19601f8201168201806040525081019061048491906108c4565b905086156105ed5760405163095ea7b360e01b81526001600160a01b0389811660048301525f1960248301528b169063095ea7b3906044016020604051808303815f875af11580156104d8573d5f5f3e3d5ffd5b505050506040513d601f19601f820116820180604052508101906104fc91906108a4565b506040805160e0810182526001600160a01b038c811682528d81166020830190815262ffffff8a81168486019081523060608601908152608086018b81525f60a0880181815260c0890191825298516304e45aaf60e01b815297518716600489015294518616602488015291519092166044860152905183166064850152516084840152925160a48301529151821660c4820152908916906304e45aaf9060e4016020604051808303815f875af19250505080156105d7575060408051601f3d908101601f191682019092526105d4918101906108c4565b60015b6105e3575f925061074c565b600193505061074c565b60405163095ea7b360e01b81526001600160a01b038a811660048301525f1960248301528b169063095ea7b3906044016020604051808303815f875af1158015610639573d5f5f3e3d5ffd5b505050506040513d601f19601f8201168201806040525081019061065d91906108a4565b506040805160028082526060820183525f926020830190803683370190505090508a815f81518110610691576106916108db565b60200260200101906001600160a01b031690816001600160a01b0316815250508b816001815181106106c5576106c56108db565b6001600160a01b0392831660209182029290920101528a16635c11d795865f84306106f142603c610903565b6040518663ffffffff1660e01b815260040161071195949392919061091c565b5f604051808303815f87803b158015610728575f5ffd5b505af1925050508015610739575060015b610745575f935061074a565b600193505b505b6040516370a0823160e01b815230600482015281906001600160a01b038d16906370a0823190602401602060405180830381865afa158015610790573d5f5f3e3d5ffd5b505050506040513d601f19601f820116820180604052508101906107b491906108c4565b6107be91910608c4565b9150505b60408051602080820186905260ff8516828401526060820184905260808083018890528351808403909101815260a0909201909252805190918201fd5b80516001600160a01b0381168114610815575f5ffd5b919050565b80518015158114610815575f5ffd5b5f5f5f5f5f5f60c0878903121561083e575f5ffd5b610847876107ff565b9550610855602088016107ff565b9450610863604088016107ff565b9350610871606088016107ff565b925061087f6080880161081a565b915060a087015162ffffff81168114610896575f5ffd5b809150509295509295509295565b5f602082840312156108b4575f5ffd5b6108bd8261081a565b9392505050565b5f602082840312156108d4575f5ffd5b5051919050565b634e487b7160e01b5f52603260045260245ffd5b634e487b7160e01b5f52601160045260245ffd5b80820180821115610916576109166108ef565b92915050565b5f60a0820187835286602084015260a0604084015280865180835260c0850191506020880192505f5b8181101561096c5783516001600160a01b0316835260209384019390920191600101610945565b50506001600160a01b039590951660608401525050608001529392505050565b81810381811115610916576109166108ef56fe';

async function withRpc(fn) {
  let last;
  for (const provider of providers) {
    try { return await fn(provider); } catch (e) { last = e; }
  }
  throw last || new Error('No RPC');
}

function unique(values) { return [...new Set(values.filter(Boolean))]; }
function cleanAddress(value) {
  try { return getAddress(value); } catch { return null; }
}
function finiteAddress(value) { return cleanAddress(value) || null; }
function zeroAddress(value) { return !value || value.toLowerCase() === ZeroAddress.toLowerCase(); }

async function rawCall(to, data, overrides) {
  return withRpc(p => p.send('eth_call', [{ to, data, ...(overrides?.tx || {}) }, 'latest', ...(overrides?.state ? [overrides.state] : [])]));
}

async function findVenue(token) {
  try {
    const pairRaw = await rawCall(V2_FACTORY, V2_FACTORY_IFACE.encodeFunctionData('getPair', [token, WETH]));
    const [pair] = V2_FACTORY_IFACE.decodeFunctionResult('getPair', pairRaw);
    if (pair && !zeroAddress(pair)) return { kind: 'V2', fee: 0 };
  } catch {}
  for (const fee of [10000, 3000, 500, 100]) {
    try {
      const raw = await rawCall(V3_FACTORY, V3_FACTORY_IFACE.encodeFunctionData('getPool', [token, WETH, fee]));
      const [pool] = V3_FACTORY_IFACE.decodeFunctionResult('getPool', raw);
      if (!pool || zeroAddress(pool)) continue;
      const liqRaw = await rawCall(pool, V3_POOL_IFACE.encodeFunctionData('liquidity'));
      const [liq] = V3_POOL_IFACE.decodeFunctionResult('liquidity', liqRaw);
      if (liq > 0n) return { kind: 'V3', fee };
    } catch {}
  }
  return null;
}

function revertData(error) {
  const candidates = [error?.data, error?.error?.data, error?.info?.error?.data];
  for (const candidate of candidates) {
    const d = typeof candidate === 'string' ? candidate : candidate?.data;
    if (typeof d === 'string' && d.startsWith('0x') && d.length > 66) return d;
  }
  const body = String(error?.body || '');
  const m = body.match(/0x[0-9a-fA-F]{100,}/);
  return m?.[0] || null;
}

async function simulateHoneypot(token) {
  const key = token.toLowerCase();
  const cached = simulationCache.get(key);
  if (cached && Date.now() - cached.checkedAt < CACHE_MS) return cached;
  const venue = await findVenue(token);
  if (!venue) {
    const result = { status: 'UNKNOWN', verdict: 'NO_POOL', canBuy: null, canSell: null, venue: null, roundTripLossPct: null, reason: 'No WETH liquidity venue detected', checkedAt: Date.now() };
    simulationCache.set(key, result);
    return result;
  }
  const args = ABI_CODER.encode(['address','address','address','address','bool','uint24'], [WETH, token, V2_ROUTER, V3_ROUTER, venue.kind === 'V3', venue.fee]);
  const data = SIM_INIT + args.slice(2);
  const tx = { from: SIM_FROM, value: `0x${TEST_ETH.toString(16)}`, data };
  try {
    const raw = await withRpc(p => p.send('eth_call', [tx, 'latest', { [SIM_FROM]: { balance: `0x${(TEST_ETH * 2n).toString(16)}` } }]));
    return { status: 'UNKNOWN', verdict: 'SIM_DID_NOT_REVERT', canBuy: null, canSell: null, venue: venue.kind, roundTripLossPct: null, reason: `Unexpected simulator success (${String(raw).slice(0, 18)})`, checkedAt: Date.now() };
  } catch (e) {
    const hex = revertData(e);
    if (!hex) {
      const result = { status: 'UNKNOWN', verdict: 'SIMULATION_UNAVAILABLE', canBuy: null, canSell: null, venue: venue.kind, roundTripLossPct: null, reason: String(e?.message || 'RPC simulation failed').slice(0, 140), checkedAt: Date.now() };
      simulationCache.set(key, result);
      return result;
    }
    try {
      const [tokenGot, canSell, wethBack, wethIn] = ABI_CODER.decode(['uint256','uint8','uint256','uint256'], hex);
      const buy = tokenGot > 0n;
      const sell = canSell === 1n && wethBack > 0n;
      const loss = wethIn > 0n ? Number((wethIn - (wethBack > wethIn ? wethIn : wethBack)) * 10000n / wethIn) / 100 : 100;
      const verdict = !buy ? 'CANT_BUY' : !sell ? 'HONEYPOT' : loss > 50 ? 'HIGH_TAX' : loss > 25 ? 'TAXED' : 'PASS';
      const result = { status: verdict === 'PASS' || verdict === 'TAXED' ? 'PASS' : 'FAIL', verdict, canBuy: buy, canSell: sell, venue: venue.kind, roundTripLossPct: Math.max(0, Math.round(loss * 10) / 10), reason: verdict === 'HONEYPOT' ? 'Buy simulated but sell path failed' : verdict === 'CANT_BUY' ? 'Buy simulation returned no tokens' : '', checkedAt: Date.now() };
      simulationCache.set(key, result);
      return result;
    } catch (decodeError) {
      const result = { status: 'UNKNOWN', verdict: 'SIMULATION_DECODE_ERROR', canBuy: null, canSell: null, venue: venue.kind, roundTripLossPct: null, reason: String(decodeError?.message || 'Decode failed').slice(0, 140), checkedAt: Date.now() };
      simulationCache.set(key, result);
      return result;
    }
  }
}

async function fetchContract(address) {
  const r = await fetch(`${BLOCKSCOUT}/smart-contracts/${address}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Blockscout ${r.status}`);
  return await r.json();
}

function abiNames(raw) {
  const abi = Array.isArray(raw?.abi) ? raw.abi : [];
  return unique(abi.filter(x => x?.type === 'function').map(x => String(x.name || '').toLowerCase()));
}

function capability(names, source, patterns) {
  const found = names.some(n => patterns.some(p => n.includes(p))) || patterns.some(p => p.test ? p.test(source) : false);
  return found;
}

async function readOwner(address, names) {
  const methods = [];
  if (names.includes('owner')) methods.push('owner');
  if (names.includes('getowner')) methods.push('getOwner');
  if (names.includes('admin')) methods.push('admin');
  if (names.includes('proxyadmin')) methods.push('proxyAdmin');
  for (const method of methods) {
    try {
      const raw = await withRpc(p => p.call({ to: address, data: OWNER_IFACE.encodeFunctionData(method) }));
      const [value] = OWNER_IFACE.decodeFunctionResult(method, raw);
      const owner = finiteAddress(value);
      return { address: owner, status: owner ? 'ACTIVE' : 'RENOUNCED', method };
    } catch {}
  }
  return { address: null, status: 'UNKNOWN', method: null };
}

function analyzePermissions(raw, owner) {
  const names = abiNames(raw);
  const source = [raw?.source_code, raw?.sourceCode, ...(raw?.additional_sources || []).map(x => x?.source_code || '')].filter(Boolean).join('\n').toLowerCase();
  const has = (...pats) => names.some(n => pats.some(p => n.includes(p))) || pats.some(p => source.includes(p));
  const mint = has('mint', 'mintto', 'minttokens');
  const blacklist = has('blacklist', 'black_list', 'blocklist', 'denylist', 'setblacklisted', 'addblacklist');
  const pause = has('pause', 'unpause', 'setpaused');
  const tax = has('settax', 'setfee', 'setfees', 'buytax', 'selltax', 'buyfee', 'sellfee', 'taxfee');
  const limits = has('maxtx', 'maxwallet', 'maxtransaction', 'maxholding', 'setlimits', 'tradingenabled', 'opentrading');
  const upgrade = has('upgradeto', 'upgrade', 'authorizeupgrade', 'upgradetoandcall');
  const renounce = has('renounceownership');
  const activeOwner = owner.status === 'ACTIVE';
  return {
    owner,
    mint: { detected: mint, controlled: mint && activeOwner },
    blacklist: { detected: blacklist, controlled: blacklist && activeOwner },
    pause: { detected: pause, controlled: pause && activeOwner },
    tax: { detected: tax, controlled: tax && activeOwner },
    limits: { detected: limits, controlled: limits && activeOwner },
    upgradeable: { detected: upgrade || Boolean(raw?.minimal_proxy_address_hash || raw?.implementation_address_hash), controlled: (upgrade || Boolean(raw?.minimal_proxy_address_hash || raw?.implementation_address_hash)) && activeOwner },
    renounceOwnership: renounce
  };
}

function scoreSecurity(contract, permissions, honeypot) {
  let score = 0;
  const flags = [];
  const add = (n, text) => { score += n; flags.push(text); };
  if (contract?.verified === false) add(10, 'Unverified contract');
  if (permissions.upgradeable.detected && permissions.upgradeable.controlled) add(12, 'Upgradeable contract with active control');
  if (permissions.mint.controlled) add(18, 'Owner-controlled mint capability');
  if (permissions.blacklist.controlled) add(16, 'Owner-controlled blacklist capability');
  if (permissions.pause.controlled) add(10, 'Owner-controlled pause capability');
  if (permissions.tax.controlled) add(12, 'Owner-controlled tax/fee controls');
  if (permissions.limits.controlled) add(7, 'Owner-controlled trading limits');
  if (honeypot?.verdict === 'HONEYPOT') add(70, 'Sell simulation failed');
  else if (honeypot?.verdict === 'CANT_BUY') add(45, 'Buy simulation failed');
  else if (honeypot?.verdict === 'HIGH_TAX') add(45, `Extreme simulated sell loss ${honeypot.roundTripLossPct}%`);
  else if (honeypot?.verdict === 'TAXED') add(18, `High simulated round-trip loss ${honeypot.roundTripLossPct}%`);
  const level = score >= 55 ? 'FLAGGED' : score >= 30 ? 'REVIEW' : 'CLEAR';
  return { score: Math.min(100, score), level, flags: unique(flags).slice(0, 8) };
}

async function inspectToken(address) {
  const key = address.toLowerCase();
  if (pending.has(key)) return pending.get(key);
  const work = (async () => {
    let raw = null;
    try { raw = await fetchContract(address); } catch {}
    const contract = {
      verified: raw == null ? null : raw?.is_verified === true,
      exists: raw == null ? null : true,
      proxy: raw == null ? null : Boolean(raw?.minimal_proxy_address_hash || raw?.implementation_address_hash),
      implementation: raw?.implementation_address_hash || raw?.minimal_proxy_address_hash || null,
      name: raw?.name || null
    };
    const names = abiNames(raw);
    const owner = raw ? await readOwner(address, names) : { address: null, status: 'UNKNOWN', method: null };
    const permissions = analyzePermissions(raw || {}, owner);
    let honeypot;
    try { honeypot = await simulateHoneypot(address); } catch (e) { honeypot = { status: 'UNKNOWN', verdict: 'SIMULATION_ERROR', canBuy: null, canSell: null, venue: null, roundTripLossPct: null, reason: String(e?.message || '').slice(0, 140), checkedAt: Date.now() }; }
    const verdict = scoreSecurity(contract, permissions, honeypot);
    const result = { contract, permissions, honeypot, securityScore: verdict.score, securityLevel: verdict.level, securityFlags: verdict.flags, checkedAt: Date.now() };
    securityCache.set(key, result);
    return result;
  })().finally(() => pending.delete(key));
  pending.set(key, work);
  return work;
}

export function securitySnapshot(address) {
  return securityCache.get(String(address || '').toLowerCase()) || null;
}

export function queueSecurity(address) {
  if (!address) return;
  const key = String(address).toLowerCase();
  const cached = securityCache.get(key);
  if (cached && Date.now() - cached.checkedAt < CACHE_MS) return;
  void inspectToken(address).catch(() => undefined);
}

export async function inspectSecurity(address) {
  const cached = securityCache.get(String(address).toLowerCase());
  if (cached && Date.now() - cached.checkedAt < CACHE_MS) return cached;
  return inspectToken(getAddress(address));
}

console.log('[security] on-chain contract permissions + read-only honeypot simulation enabled');
