'use strict';

function createRegistry() {
  /** @type {any[]} */
  const providers = [];
  /** @type {Map<string, any>} name → provider, rebuilt on collectTools */
  let route = new Map();

  function register(provider) {
    if (!provider || !provider.id) throw new Error('provider.id required');
    providers.push(provider);
  }

  function routeMapFor(ctx) {
    const fromCtx = ctx?.extensions?.toolRoute;
    if (fromCtx && typeof fromCtx.get === 'function') return fromCtx;
    return route;
  }

  async function collectTools(ctx) {
    route = new Map();
    const out = [];
    for (const p of providers) {
      if (typeof p.isEnabled === 'function' && !p.isEnabled(ctx)) continue;
      const tools = await Promise.resolve(p.getTools(ctx));
      for (const t of tools || []) {
        const name = t?.function?.name;
        if (!name) continue;
        route.set(name, p);
        out.push(t);
      }
    }
    // Per-run route on ctx so parent/child (or concurrent explores) do not clobber each other
    // when they share one registry instance. execute prefers this over the module-level route.
    if (ctx && ctx.extensions && typeof ctx.extensions === 'object') {
      ctx.extensions.toolRoute = route;
    }
    return out;
  }

  async function execute(name, args, ctx) {
    let provider = routeMapFor(ctx).get(name);
    if (!provider) {
      // rebuild route if collectTools not called (tests)
      await collectTools(ctx);
      provider = routeMapFor(ctx).get(name);
    }
    if (!provider) {
      return JSON.stringify({ ok: false, error: '未知工具: ' + name });
    }
    return provider.execute(name, args || {}, ctx);
  }

  async function systemFragments(ctx) {
    const parts = [];
    for (const p of providers) {
      if (typeof p.isEnabled === 'function' && !p.isEnabled(ctx)) continue;
      if (typeof p.getSystemFragment !== 'function') continue;
      const frag = await Promise.resolve(p.getSystemFragment(ctx));
      if (frag && String(frag).trim()) parts.push(String(frag).trim());
    }
    return parts.join('\n\n');
  }

  async function onRunStart(ctx) {
    for (const p of providers) {
      if (typeof p.isEnabled === 'function' && !p.isEnabled(ctx)) continue;
      if (typeof p.onRunStart === 'function') await p.onRunStart(ctx);
    }
  }

  async function onRunEnd(ctx) {
    for (const p of providers) {
      // always try onRunEnd for providers that started resources; call if function exists
      // Spec: MCP disconnect must run — call when hook exists even if isEnabled flipped
      if (typeof p.onRunEnd === 'function') {
        try {
          await p.onRunEnd(ctx);
        } catch {
          // never throw from finally path
        }
      }
    }
  }

  function listProviders() {
    return providers.slice();
  }

  return {
    register,
    collectTools,
    execute,
    systemFragments,
    onRunStart,
    onRunEnd,
    listProviders,
  };
}

module.exports = { createRegistry };
