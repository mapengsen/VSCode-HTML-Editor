const parse5 = require('parse5');

function htmlParts(source) {
  const document = parse5.parse(source, { sourceCodeLocationInfo: true, scriptingEnabled: false });
  const html = document.childNodes.find(node => node.tagName === 'html');
  const head = html.childNodes.find(node => node.tagName === 'head');
  const body = html.childNodes.find(node => node.tagName === 'body');
  return { html, head, body };
}

function extent(node) {
  if (node.sourceCodeLocation) {
    const { startOffset, endOffset } = node.sourceCodeLocation;
    return [startOffset, endOffset];
  }
  const children = (node.childNodes || []).map(extent).filter(Boolean);
  if (!children.length) return null;
  return [Math.min(...children.map(range => range[0])), Math.max(...children.map(range => range[1]))];
}

function record(node, source, range, innerStart, innerEnd) {
  const bounds = range || extent(node);
  const location = node.sourceCodeLocation;
  const element = Boolean(node.tagName);
  const start = innerStart ?? location?.startTag?.endOffset ?? bounds?.[0];
  const end = innerEnd ?? location?.endTag?.startOffset ?? bounds?.[1];
  const children = (node.childNodes || []).map(child => record(child, source));
  let cursor = start;
  const gaps = [];
  for (const child of children) {
    if (!child.bounds || child.bounds[0] < cursor || child.bounds[1] > end) break;
    gaps.push(source.slice(cursor, child.bounds[0]));
    cursor = child.bounds[1];
  }
  return {
    tag: node.tagName || node.nodeName,
    bounds,
    raw: bounds ? source.slice(...bounds) : null,
    open: bounds && element ? source.slice(bounds[0], start) : null,
    close: bounds && element ? source.slice(end, bounds[1]) : null,
    children,
    gaps: cursor != null && gaps.length === children.length ? [...gaps, source.slice(cursor, end)] : null
  };
}

function parseSource(source) {
  const { html, head, body } = htmlParts(source);
  const location = body.sourceCodeLocation;
  const children = extent({ childNodes: body.childNodes });
  const start = location?.startTag?.endOffset ?? children?.[0] ??
    head.sourceCodeLocation?.endOffset ?? html.sourceCodeLocation?.startTag?.endOffset ??
    html.sourceCodeLocation?.endTag?.startOffset ?? source.length;
  const closing = location?.endTag?.startOffset ?? html.sourceCodeLocation?.endTag?.startOffset;
  const end = Math.max(start, closing ?? location?.endOffset ?? children?.[1] ?? start);
  // The HTML parser can merge whitespace after </html> into the final body text node.
  // Parse the editable prefix separately so its text locations never include closing tags.
  const content = closing === undefined ? body : htmlParts(source.slice(0, end)).body;
  const styles = head.childNodes.filter(node =>
    node.tagName === 'style' ||
    (node.tagName === 'link' && node.attrs.some(attr =>
      attr.name === 'rel' && attr.value.toLowerCase().split(/\s+/).includes('stylesheet')))
  ).map(node => parse5.serializeOuter(node)).join('');
  const base = head.childNodes.find(node => node.tagName === 'base' && node.attrs.some(attr => attr.name === 'href'));
  return {
    start, end,
    bodySource: source.slice(start, end),
    bodyHtml: parse5.serialize(content),
    tree: record(content, source, [start, end], start, end),
    htmlAttrs: html.attrs,
    bodyAttrs: body.attrs,
    styles,
    baseHref: base?.attrs.find(attr => attr.name === 'href')?.value
  };
}

function escapeAttribute(value) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

module.exports = { parseSource, escapeAttribute };

