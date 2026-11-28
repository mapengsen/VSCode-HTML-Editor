'use strict';

const pastedTags = new Set(('a b blockquote br caption cite code dd del div dl dt em h1 h2 h3 h4 h5 h6 hr i img ins kbd ' +
  'li mark ol p pre q s samp small span strike strong sub sup table tbody td th thead tfoot tr u ul').split(' '));
const skipPasted = 'head, title, script, noscript, style, link, meta, base, iframe, object, embed, template, svg, math, input, select, textarea';
const pastedBlockText = 'blockquote, dd, div, dt, h1, h2, h3, h4, h5, h6, li, p, pre, table, td, th';
const pastedAttributes = {
  a: ['href', 'title'],
  img: ['src', 'alt', 'title', 'width', 'height'],
  ol: ['start', 'reversed', 'type'],
  li: ['value'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan', 'scope']
};
const pastedEmphasis = ['font-weight', 'font-style', 'text-decoration-line', 'vertical-align'];

function matchingPaste(page, html, destination) {
  const source = page.createElement('template');
  source.innerHTML = html;
  const output = page.createElement('div');
  copyChildren(source.content, output);
  if (!output.textContent.trim()) return '';

  function copyChildren(from, into) {
    for (const node of from.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        into.append(page.createTextNode(node.data));
      } else if (node.nodeType === Node.ELEMENT_NODE && !node.matches(skipPasted)) {
        const tag = node.localName;
        if (!pastedTags.has(tag)) {
          copyChildren(node, into);
          continue;
        }
        const element = page.createElement(tag);
        for (const attribute of pastedAttributes[tag] || []) {
          const value = node.getAttribute(attribute);
          if (value !== null && (!(attribute === 'href' || attribute === 'src') || canPasteUrl(value, attribute))) {
            element.setAttribute(attribute, value);
          }
        }
        if (tag === 'img' && !element.hasAttribute('src')) continue;
        for (const property of pastedEmphasis) {
          const value = node.style.getPropertyValue(property);
          if (value) element.style.setProperty(property, value);
        }
        copyChildren(node, element);
        if (tag === 'span' && !element.hasAttributes()) into.append(...element.childNodes);
        else into.append(element);
      }
    }
  }

  // Give top-level inline text the same baseline as pasted block text.
  for (const node of [...output.childNodes]) {
    if (node.nodeType !== Node.TEXT_NODE || !node.data.trim()) continue;
    const span = page.createElement('span');
    node.replaceWith(span);
    span.append(node);
  }
  const styled = new Set([...output.children, ...output.querySelectorAll(pastedBlockText)]);
  for (const element of styled) {
    if (!element.textContent.trim()) continue;
    for (const property of ['font-family', 'font-size', 'color']) {
      element.style.setProperty(property, destination.getPropertyValue(property), 'important');
    }
  }
  return output.innerHTML;
}

function canPasteUrl(value, attribute) {
  try {
    const protocol = new URL(value, 'https://example.invalid/').protocol;
    if (protocol === 'http:' || protocol === 'https:') return true;
    if (attribute === 'href') return protocol === 'mailto:' || protocol === 'tel:';
    return /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,/i.test(value);
  } catch {
    return false;
  }
}
