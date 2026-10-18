// router.js - the routes of the editor: the address names what is open, like the routers of
// React or Angular. A route is a path pattern with parameters:
//
//   '/screen/:place?'      :name one segment, ':name?' it may be missing
//   '/bitmap/*file?'       *name the rest of the path, slashes included (a file of the project)
//   '**'                   any other path (a redirect)
//
// Paths are relative to the page (document.baseURI): the server gives a deep address the page
// with a <base> back to its folder (server.js), so it runs under any path behind a proxy.
//
//   const router = createRouter([{ name: 'screen', path: '/screen/:place?' }, ...]);
//   router.beforeEach((to, from) => true | false | { name, params, query });   // a guard
//   router.onChange((to, from) => ...);        // after every change: navigate, back, forward
//   router.navigate({ name: 'screen', params: { place: 'hall' } }, { replace });
//   router.href({ name, params, query })       // for <a href data-link>: the router follows them

const segs = path => path.split('/').filter(Boolean);

function compile(route) {
  const parts = segs(route.path).map(s => {
    if (s === '**') return { any: true };
    const m = /^([:*])(\w+)(\?)?$/.exec(s);
    return m ? { name: m[2], rest: m[1] === '*', optional: !!m[3] } : { text: s };
  });
  return { ...route, parts };
}

function matchRoute(route, path) {
  const got = segs(path), params = {};
  let k = 0;
  for (const p of route.parts) {
    if (p.any) return { params: {}, rest: got.join('/') };
    if (p.rest) {
      if (k < got.length) params[p.name] = got.slice(k).map(decodeURIComponent).join('/');
      else if (!p.optional) return null;
      k = got.length;
      continue;
    }
    if (k >= got.length) {
      if (p.optional) continue;
      return null;
    }
    if (p.text != null) { if (got[k] !== p.text) return null; }
    else params[p.name] = decodeURIComponent(got[k]);
    k++;
  }
  return k === got.length ? { params } : null;
}

export function createRouter(routes, { keep = [] } = {}) {
  const table = routes.map(compile);
  const guards = [], listeners = [];
  let current = null;

  // the folder of the page: the root of the routes
  const root = () => new URL('.', document.baseURI);
  const pathOf = url => '/' + decodeURI(url.pathname).slice(decodeURI(root().pathname).length);

  function resolve(target) {
    if (typeof target === 'string') target = parse(new URL(target, root()));
    const route = table.find(r => r.name === target.name);
    if (!route) throw new Error(`no route ${target.name}`);
    return { name: route.name, params: { ...target.params }, query: { ...target.query } };
  }

  // an address: its route, or null when none matches
  function parse(url) {
    const path = pathOf(url);
    for (const r of table) {
      const m = matchRoute(r, path);
      if (!m) continue;
      const query = Object.fromEntries(url.searchParams);
      if (r.redirect) {                           // with the query of the address
        const to = resolve(typeof r.redirect === 'function' ? r.redirect(m) : r.redirect);
        return { ...to, query: { ...query, ...to.query } };
      }
      return { name: r.name, params: m.params, query };
    }
    return null;
  }

  // the address of a route: relative to the page, the query in its order, empty values left out
  function href(target) {
    const to = resolve(target);
    const route = table.find(r => r.name === to.name);
    const out = [];
    for (const p of route.parts) {
      if (p.text != null) out.push(p.text);
      else if (p.name) {
        const v = to.params[p.name];
        if (v == null || v === '') { if (p.optional) continue; throw new Error(`route ${to.name} needs ${p.name}`); }
        out.push(p.rest ? String(v).split('/').map(encodeURIComponent).join('/') : encodeURIComponent(v));
      }
    }
    const kept = Object.fromEntries(keep.map(k => [k, new URL(location.href).searchParams.get(k)]).filter(([, v]) => v != null));
    const query = new URLSearchParams(Object.entries({ ...kept, ...to.query }).filter(([, v]) => v != null && v !== ''));
    return './' + out.join('/') + (query.size ? '?' + query : '');
  }

  const same = (a, b) => !!a && !!b && new URL(href(a), root()).href === new URL(href(b), root()).href;

  // the guards in their order: false stops the change, a route goes there instead
  async function guard(to, from) {
    for (const g of guards) {
      const r = await g(to, from);
      if (r === false) return false;
      if (r && r !== true) return resolve(r);
    }
    return to;
  }

  async function change(to, { replace = false, fromHistory = false } = {}) {
    const from = current;
    const next = await guard(to, from);
    if (!next) {                                  // blocked: the address stays that of the current route
      if (fromHistory && from) history.replaceState(null, '', href(from));
      return false;
    }
    const url = href(next);
    if (!fromHistory || next !== to) {
      if (replace || fromHistory || same(next, from)) history.replaceState(null, '', url);
      else history.pushState(null, '', url);
    }
    current = next;
    for (const fn of listeners) await fn(next, from);
    return true;
  }

  addEventListener('popstate', () => {
    const to = parse(new URL(location.href));
    if (to) change(to, { fromHistory: true });
  });
  // <a href="…" data-link>: a change of the route, not a load of the page (a click with a modifier
  // key opens the address in a new tab as usual)
  addEventListener('click', e => {
    const a = e.target.closest?.('a[data-link]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const to = parse(new URL(a.href));
    if (!to) return;
    e.preventDefault();
    change(to);
  });

  return {
    beforeEach: fn => { guards.push(fn); },
    onChange: fn => { listeners.push(fn); },
    // the route of the address now; start: follow it (the listeners run, the guards decide)
    parse: (url = location.href) => parse(new URL(url, root())),
    start: (fallback) => change(parse(new URL(location.href)) ?? resolve(fallback), { replace: true }),
    navigate: (target, opts) => change(resolve(target), opts),
    // the address follows the state without the listeners: what is open changed in an editor
    sync(target, { replace = false } = {}) {
      const to = resolve(target);
      if (same(to, current)) { current = to; return; }
      if (replace) history.replaceState(null, '', href(to)); else history.pushState(null, '', href(to));
      current = to;
    },
    href,
    get current() { return current; },
  };
}
