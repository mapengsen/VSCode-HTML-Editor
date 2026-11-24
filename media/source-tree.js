/* global module */
'use strict';

function sourceTree(body, snapshot, originalValue = (_, attr) => attr.value) {
  const records = new WeakMap();
  bind(body, snapshot.tree);

  function bind(node, record) {
    if (!record || node.nodeName.toLowerCase() !== record.tag.toLowerCase()) return;
    const children = [...node.childNodes];
    const initial = {
      record,
      children,
      value: node.nodeValue,
      attrs: node.nodeType === 1 ? attributes(node) : ''
    };
    if (node.localName === 'template') initial.template = node.innerHTML;
    records.set(node, initial);
    if (children.length === record.children.length) {
      children.forEach((child, index) => bind(child, record.children[index]));
    }
  }

  function attributes(node) {
    return JSON.stringify([...node.attributes].map(attr => [attr.name, originalValue(node, attr), attr.namespaceURI]));
  }

  function serialize(node) {
    const wrapper = node.ownerDocument.createElement('div');
    wrapper.append(node.cloneNode(true));
    return wrapper.innerHTML;
  }

  function render(node, parent, isBody = false) {
    const initial = records.get(node);
    if (node.nodeType !== 1) {
      if (initial && initial.value === node.nodeValue && initial.record.raw != null) {
        return { text: initial.record.raw, unchanged: true };
      }
      const text = node.nodeType === 3 && ['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext', 'noscript'].includes(parent?.localName)
        ? node.data
        : serialize(node);
      return { text, unchanged: false };
    }
    if (node.localName === 'template') {
      const unchanged = initial?.template === node.innerHTML && initial?.attrs === attributes(node);
      return { text: unchanged ? initial.record.raw ?? node.outerHTML : node.outerHTML, unchanged };
    }
    const children = [...node.childNodes];
    const output = children.map(child => render(child, node));
    const sameAttributes = isBody || (initial && attributes(node) === initial.attrs);
    const sameChildren = initial && children.length === initial.children.length &&
      children.every((child, index) => child === initial.children[index] && output[index].unchanged);
    if (sameAttributes && sameChildren && initial.record.raw != null) {
      return { text: initial.record.raw, unchanged: true };
    }

    let content = '';
    const gaps = initial?.record.gaps;
    const positions = gaps && new Map(initial.children.map((child, index) => [child, index]));
    for (const [index, child] of children.entries()) {
      const slot = positions?.get(child);
      if (slot !== undefined) content += gaps[slot];
      content += output[index].text;
    }
    if (gaps) {
      // Source tokens between DOM nodes can be parser-ignored markup.
      const retained = new Set(children);
      for (const [index, child] of initial.children.entries()) {
        if (!retained.has(child)) content += gaps[index];
      }
      content += gaps.at(-1);
    }
    if (isBody) return { text: content, unchanged: false };
    if (sameAttributes && initial.record.open != null) {
      return { text: initial.record.open + content + initial.record.close, unchanged: false };
    }
    const clone = node.cloneNode(false);
    for (const attr of node.attributes) {
      const value = originalValue(node, attr);
      if (value !== attr.value) clone.setAttributeNS(attr.namespaceURI, attr.name, value);
    }
    const empty = clone.outerHTML;
    const close = empty.lastIndexOf('</');
    return {
      text: close < 0 ? empty : empty.slice(0, close) + content + empty.slice(close),
      unchanged: false
    };
  }

  return () => render(body, null, true).text;
}

if (typeof module !== 'undefined') module.exports = { sourceTree };

