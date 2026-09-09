import { registerHooks } from 'node:module';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';

const TARGET = new URL('./index.js', import.meta.url).href;
const SECURITY = new URL('./security.js', import.meta.url).href;
const HONEYPOT_BYTECODE = readFileSync(new URL('./honeypot-bytecode.txt', import.meta.url), 'utf8').trim();

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url !== TARGET && url !== SECURITY) return result;
    const sourceText = typeof result.source === 'string' ? result.source : Buffer.from(result.source || '').toString('utf8');
    let source = sourceText;
    if (url === TARGET) {
      if (!source.includes("from './security.js'")) {
        source = source.replace("import { applyRisk } from './risk.js';", "import { applyRisk } from './risk.js';\nimport { inspectSecurity } from './security.js';");
      }
      source = source.replace(
        'return { marketCap: p.marketCap || p.fdv || 0,',
        'return { address: getAddress(p.token), marketCap: p.marketCap || p.fdv || 0,'
      );
    }
    if (url === SECURITY) {
      source = source.replace(/const SIM_INIT = '0x[0-9a-fA-F]+';/, `const SIM_INIT = ${JSON.stringify(HONEYPOT_BYTECODE)};`);
    }
    return { ...result, source };
  }
});

console.log('[secure-entry] security source hook active: token addresses + audited honeypot simulator');
await import('./index.js');
