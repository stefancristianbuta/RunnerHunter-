import { registerHooks } from 'node:module';

const TARGET = new URL('./index.js', import.meta.url).href;
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url !== TARGET || typeof result.source !== 'string') return result;
    let source = result.source;
    if (!source.includes("from './security.js'")) {
      source = source.replace("import { applyRisk } from './risk.js';", "import { applyRisk } from './risk.js';\nimport { inspectSecurity } from './security.js';");
    }
    source = source.replace(
      'return { marketCap: p.marketCap || p.fdv || 0,',
      'return { address: getAddress(p.token), marketCap: p.marketCap || p.fdv || 0,'
    );
    return { ...result, source };
  }
});

console.log('[secure-entry] source hook active: radar metrics carry token address for security gating');
await import('./index.js');
