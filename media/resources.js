'use strict';

function createResources(base) {
  const urls = new Set();
  const cache = new Map();
  const substitutions = new WeakMap();
  const requests = new WeakMap();
  const host = base && new URL(base).host;
  let disposed = false;
  let observer;

  function resolve(value, from) {
    try {
      const url = new URL(value, from);
      if (url.host === host && url.hostname.endsWith('.vscode-cdn.net') && url.protocol === 'https:') return url;
    } catch {
      // An asset can have a relative URL in an untitled document.
    }
  }

  async function replace(text, pattern, getReplacement) {
    const parts = [...text.matchAll(pattern)];
    const values = await Promise.all(parts.map(getReplacement));
    let result = '';
    let offset = 0;
    parts.forEach((part, index) => {
      result += text.slice(offset, part.index) + values[index];
      offset = part.index + part[0].length;
    });
    return result + text.slice(offset);
  }

  async function rewriteCss(text, from, parents) {
    const imports = await replace(text, /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)/gi, async match => {
      const url = resolve(match[2] || match[4], from);
      const href = url && await load(url, true, parents);
      return href ? '@import url("' + href + '")' : match[0];
    });
    return replace(imports, /url\(\s*(?:"([^"]+)"|'([^']+)'|([^)]*?))\s*\)/gi, async match => {
      const value = (match[1] || match[2] || match[3]).trim();
      const url = !value.startsWith('#') && resolve(value, from);
      const href = url && await load(url, false, parents);
      return href ? 'url("' + href + '")' : match[0];
    });
  }

  async function load(url, stylesheet, parents = new Set()) {
    const fragment = url.hash;
    url.hash = '';
    const key = (stylesheet ? 'css:' : '') + url.href;
    if (parents.has(key)) return undefined;
    const nested = stylesheet && parents.size > 0;
    if (!nested && cache.has(key)) {
      const href = await cache.get(key);
      return href && href + fragment;
    }
    const request = (async () => {
      try {
        const response = await fetch(url.href);
        if (!response.ok) return undefined;
        const blob = stylesheet
          ? new Blob([await rewriteCss(await response.text(), url.href, new Set([...parents, key]))], { type: 'text/css' })
          : await response.blob();
        if (disposed) return undefined;
        const href = URL.createObjectURL(blob);
        urls.add(href);
        return href;
      } catch {
        return undefined;
      }
    })();
    if (!nested) cache.set(key, request);
    const href = await request;
    return href && href + fragment;
  }

  function originalValue(node, attr) {
    const entry = substitutions.get(node)?.get(attr.name);
    return entry?.shown === attr.value ? entry.original : attr.value;
  }

  function queue(node, name, getReplacement) {
    const value = node.getAttribute(name);
    if (!value || substitutions.get(node)?.get(name)?.shown === value) return;
    if (!requests.has(node)) requests.set(node, new Map());
    const jobs = requests.get(node);
    if (jobs.get(name) === value) return;
    jobs.set(name, value);
    void getReplacement(value).then(replacement => {
      if (!replacement || replacement === value || node.getAttribute(name) !== value || disposed) return;
      if (!substitutions.has(node)) substitutions.set(node, new Map());
      substitutions.get(node).set(name, { shown: replacement, original: value });
      node.setAttribute(name, replacement);
    }).finally(() => {
      if (jobs.get(name) === value) jobs.delete(name);
    });
  }

  function hydrate(root, from) {
    const selector = 'link[rel~="stylesheet" i], img, source, video, audio, track, input[type="image"], [style], image';
    const nodes = [...root.querySelectorAll(selector)];
    if (root.matches?.(selector)) nodes.unshift(root);
    for (const node of nodes) {
      const stylesheet = node.localName === 'link';
      const direct = stylesheet || node.localName === 'image' ? ['href', 'xlink:href'] : ['src', 'poster'];
      for (const name of direct) {
        queue(node, name, async value => {
          const url = resolve(value, from);
          return url && load(url, stylesheet);
        });
      }
      queue(node, 'style', value => rewriteCss(value, from, new Set()));
      queue(node, 'srcset', value => replace(value, /(?:^|,\s*)(data:[^\s]+|[^\s,]+)/gi, async match => {
        const url = resolve(match[1], from);
        const href = url && await load(url, false);
        return href ? match[0].slice(0, -match[1].length) + href : match[0];
      }));
    }
  }

  function attach(page, from) {
    if (!host) return;
    hydrate(page, from);
    for (const style of page.head.querySelectorAll('style')) {
      const value = style.textContent;
      void rewriteCss(value, from, new Set()).then(replacement => {
        if (!disposed && style.textContent === value && replacement !== value) style.textContent = replacement;
      });
    }
    observer = new MutationObserver(changes => {
      for (const change of changes) {
        if (change.type === 'attributes' && change.target.getAttribute(change.attributeName) !==
            substitutions.get(change.target)?.get(change.attributeName)?.shown) hydrate(change.target, from);
        for (const node of change.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) hydrate(node, from);
        }
      }
    });
    observer.observe(page.body, {
      subtree: true, childList: true, attributes: true,
      attributeFilter: ['src', 'href', 'xlink:href', 'srcset', 'poster', 'style']
    });
  }

  function dispose() {
    disposed = true;
    observer?.disconnect();
    for (const href of urls) URL.revokeObjectURL(href);
    urls.clear();
  }

  return { attach, dispose, originalValue };
}

