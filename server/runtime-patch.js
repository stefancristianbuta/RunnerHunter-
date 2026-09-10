import { JsonRpcProvider } from 'ethers';

const nativeSetInterval = globalThis.setInterval.bind(globalThis);
const nativeGetBlockNumber = JsonRpcProvider.prototype.getBlockNumber;

// Keep the non-critical latest-block telemetry from blocking a scan when an RPC is unhealthy.
JsonRpcProvider.prototype.getBlockNumber = function (...args) {
  return Promise.race([
    nativeGetBlockNumber.apply(this, args),
    new Promise((_, reject) => setTimeout(() => reject(new Error('RPC getBlockNumber timeout')), 3000))
  ]);
};

// The market scanner was designed around a 30s loop. Run it at 10s so fresh momentum
// is not stale while leaving unrelated timers untouched.
globalThis.setInterval = (fn, delay, ...args) =>
  nativeSetInterval(fn, delay === 30000 ? 10000 : delay, ...args);

console.log('[runtime-patch] lightweight mode: RPC block timeout + 30s->10s scan interval');
