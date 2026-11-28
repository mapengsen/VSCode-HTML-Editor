/* global acquireVsCodeApi, sourceTree, createResources, headingLevelForShortcut, createHeadingOutline, createParagraphInsert, matchingPaste */
'use strict';

const vscode = acquireVsCodeApi();
const byId = id => document.getElementById(id);
const canvas = byId('canvas');
const toolbar = byId('tools');
const status = byId('status');
const dialog = byId('dialog');
const zoomSlider = byId('zoom-slider');
const zoomInput = byId('zoom-actual');
const defaultZoom = Number(zoomSlider.defaultValue);
const minZoom = Number(zoomSlider.min);
const maxZoom = Number(zoomSlider.max);
const outline = createHeadingOutline(byId('outline'), byId('outline-toggle'), byId('outline-divider'),
  byId('outline-depth'), depth => vscode.postMessage({ type: 'outlineDepth', depth }));
const paragraphInsert = createParagraphInsert(byId('paragraph-add'), canvas, paragraphAt, insertParagraphAfter);
const blockSelector = 'p, h1, h2, h3, h4, h5, h6, blockquote, pre';
const paragraphSizes = { p: 1, h1: 2, h2: 1.55, h3: 1.35, h4: 1.2, h5: 1.1, h6: 1.05 };

let page;
let frame;
let resources;
let version = -1;
let delay = 300;
let readBody;
let acknowledgedBody;
let timer;
let inFlight;
let conflict = false;
let queuedPrint = false;
let queuedSource = false;
let queuedSave = false;
let selection;
let outlinePointer;
let loadingVersion = -1;
let zoom = defaultZoom;
let zoomStyle;

function escapeHtml(value) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function attributes(source) {
  return source
    .filter(attr => /^[a-z_][a-z0-9_.:-]*$/i.test(attr.name) && !attr.name.startsWith('on') && attr.name !== 'contenteditable')
    .map(attr => ' ' + (attr.prefix ? attr.prefix + ':' : '') + attr.name + '="' + escapeHtml(attr.value) + '"')
    .join('');
}

function displayDocument(message) {
  version = message.version;
  loadingVersion = version;
  delay = message.delay;
  closeColorPicker();
  selection = undefined;
  outlinePointer = undefined;
  readBody = undefined;
  zoomStyle = undefined;
  outline.attach(undefined);
  paragraphInsert.attach(undefined);
  resources?.dispose();
  resources = createResources(message.baseUrl);
  acknowledgedBody = message.html.bodySource;
  toolbar.inert = true;
  updateParagraphMenu('');
  status.textContent = 'Loading…';
  byId('filename').textContent = message.filename;
  byId('breadcrumb').textContent = 'body';

  const next = document.createElement('iframe');
  next.title = 'Editable HTML document';
  next.setAttribute('sandbox', 'allow-same-origin');
  const documentUrl = message.documentUrl && new URL(message.documentUrl).href;
  let base = message.baseUrl;
  try {
    if (message.html.baseHref) {
      const candidate = new URL(message.html.baseHref, base);
      if (['http:', 'https:', 'vscode-webview:'].includes(candidate.protocol)) base = candidate.href;
    }
  } catch {
    // An invalid author base leaves the document directory in use.
  }
  const origin = document.body.dataset.resourceOrigin;
  const policy = "default-src 'none'; style-src 'unsafe-inline' " + origin + " https: http: blob:; img-src " + origin +
    " data: blob: https: http:; font-src " + origin + " data: blob: https: http:; media-src " + origin + " https: http: data: blob:";
  next.srcdoc = [
    '<!doctype html><html' + attributes(message.html.htmlAttrs) + '><head><meta charset="utf-8">',
    '<meta http-equiv="Content-Security-Policy" content="' + escapeHtml(policy) + '">',
    base ? '<base href="' + escapeHtml(base) + '">' : '',
    '<style>body:empty{min-height:calc(100vh - 16px)}</style>', message.html.styles, '</head><body' + attributes(message.html.bodyAttrs) + '>',
    message.html.bodyHtml, '</body></html>'
  ].join('');
  next.addEventListener('load', () => {
    if (next !== frame) return;
    page = next.contentDocument;
    if (!page?.body) {
      status.textContent = 'Design view could not load';
      return;
    }
    readBody = sourceTree(page.body, message.html, resources.originalValue);
    resources.attach(page, base);
    zoomStyle = page.createElement('style');
    page.head.append(zoomStyle);
    setZoom(zoom);
    page.body.contentEditable = 'true';
    page.body.spellcheck = false;
    outline.attach(page.body);
    paragraphInsert.attach(next);

    page.addEventListener('input', event => {
      if (!event.isComposing) schedule();
    });
    page.addEventListener('compositionend', schedule);
    page.addEventListener('selectionchange', rememberSelection);
    page.addEventListener('pointermove', followOutlinePointer);
    page.addEventListener('pointerout', event => {
      if (!event.relatedTarget) outlinePointer = undefined;
    });
    page.addEventListener('scroll', () => {
      if (outlinePointer) updateOutlineAtPointer(page.elementFromPoint(outlinePointer.x, outlinePointer.y));
    }, true);
    page.addEventListener('paste', pasteStyledText);
    page.addEventListener('pointerdown', closeColorPicker);
    page.addEventListener('click', event => followDocumentLink(event, documentUrl));
    page.addEventListener('wheel', event => {
      followOutlinePointer(event);
      zoomWithWheel(event);
    }, { passive: false });
    page.addEventListener('submit', event => event.preventDefault());
    page.addEventListener('keydown', useHeadingShortcut, true);
    page.addEventListener('keydown', requestSave);
    toolbar.inert = false;
    status.textContent = 'Synced';
    if (queuedSave) flush();
  }, { once: true });
  frame = next;
  canvas.replaceChildren(next);
}

function setZoom(value) {
  zoom = Math.max(minZoom, Math.min(maxZoom, value));
  const label = zoom + '%';
  if (zoomStyle) zoomStyle.textContent = zoom === 100 ? '' : ':root { zoom: ' + label + ' !important; }';
  zoomSlider.value = String(zoom);
  zoomSlider.setAttribute('aria-valuetext', label);
  zoomInput.value = label;
  byId('zoom-out').disabled = zoom === minZoom;
  byId('zoom-in').disabled = zoom === maxZoom;
  paragraphInsert.refresh();
}

function zoomWithWheel(event) {
  const delta = event.deltaY || event.deltaX;
  if (!event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || !delta) return;
  event.preventDefault();
  setZoom(zoom + (delta < 0 ? 10 : -10));
}

byId('zoom-out').addEventListener('click', () => setZoom(zoom - 10));
byId('zoom-in').addEventListener('click', () => setZoom(zoom + 10));
byId('zoom-reset').addEventListener('click', () => setZoom(defaultZoom));
zoomSlider.addEventListener('input', () => setZoom(zoomSlider.valueAsNumber));

function commitZoom() {
  const entry = /^(\d+)\s*%?$/.exec(zoomInput.value.trim());
  if (entry) setZoom(Number(entry[1]));
  else zoomInput.value = zoom + '%';
}

zoomInput.addEventListener('focus', () => zoomInput.select());
zoomInput.addEventListener('change', commitZoom);
zoomInput.addEventListener('keydown', event => {
  if (event.key !== 'Enter' && event.key !== 'Escape') return;
  event.preventDefault();
  if (event.key === 'Enter') commitZoom();
  else zoomInput.value = zoom + '%';
  zoomInput.select();
});

function followDocumentLink(event, documentUrl) {
  const link = event.target.closest?.('a[href], area[href]');
  if (!link) return;
  event.preventDefault();
  if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

  const href = link.getAttribute('href').trim();
  let fragment = href.slice(href.indexOf('#') + 1);
  if (!href.startsWith('#')) {
    if (!documentUrl || !href.includes('#')) return;
    try {
      const url = new URL(href, link.baseURI);
      fragment = url.hash.slice(1);
      url.hash = '';
      if (url.href !== documentUrl) return;
    } catch {
      return;
    }
  }

  let name = fragment;
  try {
    name = decodeURIComponent(fragment);
  } catch {
    // A literal percent sign can still be part of an anchor ID.
  }
  const owner = link.ownerDocument;
  const target = owner.getElementById(name) ||
    [...owner.getElementsByName(name)].find(element => element.localName === 'a');
  if (target) target.scrollIntoView({ block: 'start', inline: 'nearest' });
  else if (!name || name.toLowerCase() === 'top') owner.defaultView.scrollTo(0, 0);
}

function pasteStyledText(event) {
  if (!readBody || conflict || !event.target.isContentEditable || event.target.closest('input, textarea, select')) return;
  const html = event.clipboardData?.getData('text/html');
  const current = page.getSelection();
  if (!html || !current.rangeCount) return;
  const node = current.getRangeAt(0).startContainer;
  if (!page.body.contains(node)) return;
  const block = paragraphAt(node);
  let destination = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  if (block && !block.textContent.trim()) {
    destination = [block.previousElementSibling, block.nextElementSibling]
      .find(sibling => sibling?.matches('p, div') && sibling.textContent.trim()) || block;
  }
  const content = matchingPaste(page, html, page.defaultView.getComputedStyle(destination));
  if (!content) return;
  event.preventDefault();
  if (page.execCommand('insertHTML', false, content)) {
    rememberSelection();
    schedule();
  }
}

function rememberSelection() {
  if (!page) return;
  const current = page.getSelection();
  let node = current.anchorNode;
  paragraphInsert.setCaret(current.isCollapsed ? paragraphAt(node) : undefined);
  if (!node || !page.body.contains(node)) return;
  outlinePointer = undefined;
  outline.setLocation(current.focusNode);
  if (current.rangeCount) selection = current.getRangeAt(0).cloneRange();
  const startStyle = paragraphAt(node)?.localName || 'p';
  const endStyle = paragraphAt(current.focusNode)?.localName || 'p';
  updateParagraphMenu(startStyle === endStyle ? startStyle : '');
  const chain = [];
  if (node.nodeType !== Node.ELEMENT_NODE) node = node.parentElement;
  while (node && node !== page.body) {
    chain.unshift(node.localName + (node.id ? '#' + node.id : ''));
    node = node.parentElement;
  }
  byId('breadcrumb').textContent = ['body', ...chain].join(' › ');
}

function followOutlinePointer(event) {
  outlinePointer = { x: event.clientX, y: event.clientY };
  updateOutlineAtPointer(event.target);
}

function updateOutlineAtPointer(node) {
  if (!node) return;
  const { x, y } = outlinePointer;
  const text = page.caretRangeFromPoint?.(x, y)?.startContainer;
  if (text && node.contains(text)) outline.setLocation(text);
  else if (node !== page.body && node !== page.documentElement) outline.setLocation(node);
}

function paragraphAt(node) {
  return (node?.nodeType === 1 ? node : node?.parentElement)?.closest(blockSelector);
}

function insertParagraphAfter(block) {
  if (!readBody || conflict || canvas.inert || !page.body.contains(block) || !block.isContentEditable) return;
  const paragraph = page.createElement('p');
  paragraph.append(page.createElement('br'));
  block.after(paragraph);
  page.body.focus({ preventScroll: true });
  page.getSelection().collapse(paragraph, 0);
  paragraph.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  rememberSelection();
  schedule();
}

function updateParagraphMenu(value) {
  paragraphMenu.value = value;
  const label = paragraphMenu.selectedOptions[0].textContent;
  paragraphMenu.previousElementSibling.textContent = /^h[1-6]$/.test(value) ? label : 'H';
  paragraphMenu.title = paragraphMenu.parentElement.title = value ? 'Paragraph (' + label + ')' : 'Paragraph';
}

function focusSelection() {
  if (!page?.body || !readBody) return false;
  page.body.focus();
  if (selection && page.body.contains(selection.startContainer) && page.body.contains(selection.endContainer)) {
    const current = page.getSelection();
    current.removeAllRanges();
    current.addRange(selection);
  }
  return true;
}

function command(name, value = null) {
  if (!focusSelection()) return;
  page.execCommand('styleWithCSS', false, name !== 'fontSize');
  page.execCommand(name, false, value);
  rememberSelection();
  schedule();
}

function setBlockFontSize(block, size) {
  block.style.setProperty('font-size', size, 'important');
  for (const span of block.querySelectorAll('span[style], font[size]')) {
    if (span.hasAttribute('size') || span.style.fontSize) {
      span.style.setProperty('font-size', 'inherit', 'important');
    }
  }
}

function applyParagraphTypography(block) {
  const tag = block.localName;
  const size = paragraphSizes[tag];
  if (!size) return;
  setBlockFontSize(block, size + 'em');
  block.style.setProperty('font-weight', tag === 'p' ? 'normal' : 'bold', 'important');
}

function setCustomFontSize(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size <= 0 || conflict || !focusSelection()) return;
  const current = page.getSelection();
  if (!current.rangeCount) return;
  const range = current.getRangeAt(0);
  const pixels = size + 'px';
  if (range.collapsed) {
    const element = current.anchorNode.nodeType === Node.ELEMENT_NODE ? current.anchorNode : current.anchorNode.parentElement;
    let block = paragraphAt(element) || element.closest('div, li, td, th');
    if (!block) {
      page.execCommand('formatBlock', false, 'p');
      block = paragraphAt(current.anchorNode);
    }
    if (block) setBlockFontSize(block, pixels);
  } else {
    resizeSelectedText(current, range, pixels);
  }
  rememberSelection();
  schedule();
}

function resizeSelectedText(current, range, size) {
  const root = range.commonAncestorContainer;
  const walker = page.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const parts = [];
  for (let node = root.nodeType === Node.TEXT_NODE ? root : walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!range.intersectsNode(node) || !(parent instanceof page.defaultView.HTMLElement) ||
        parent.closest('script, style, textarea, select, [contenteditable="false"]')) continue;
    const start = range.startContainer === node ? range.startOffset : 0;
    const end = range.endContainer === node ? range.endOffset : node.length;
    if (start < end) parts.push({ node, start, end });
  }
  if (!parts.length) return;
  const backwards = current.anchorNode === range.endContainer && current.anchorOffset === range.endOffset;
  const spans = parts.map(({ node, start, end }) => {
    let span = node.parentElement;
    if (span.localName !== 'span' || span.childNodes.length !== 1 || start !== 0 || end !== node.length) {
      span = page.createElement('span');
      const piece = page.createRange();
      piece.setStart(node, start);
      piece.setEnd(node, end);
      piece.surroundContents(span);
    }
    span.style.setProperty('font-size', size, 'important');
    return span;
  });
  const first = spans[0].firstChild;
  const last = spans.at(-1).lastChild;
  if (backwards) current.setBaseAndExtent(last, last.length, first, 0);
  else current.setBaseAndExtent(first, 0, last, last.length);
}

function normalizeHeadings() {
  if (!readBody || conflict) return;
  const headings = page.body.querySelectorAll('h1, h2, h3, h4, h5');
  if (!headings.length) {
    status.textContent = 'No H1–H5 headings';
    return;
  }
  headings.forEach(applyParagraphTypography);
  schedule();
}

function formatParagraph(tag) {
  if (conflict || !focusSelection()) return;
  const current = page.getSelection();
  if (!current.rangeCount) return;
  const first = paragraphAt(current.anchorNode);
  const source = first === paragraphAt(current.focusNode) ? first : null;
  const existing = new Set(page.body.querySelectorAll(tag));
  page.execCommand('formatBlock', false, tag);
  if (current.rangeCount) {
    const range = current.getRangeAt(0);
    for (const block of page.body.querySelectorAll(tag)) {
      if (existing.has(block) || !range.intersectsNode(block)) continue;
      if (source && !source.isConnected && block === paragraphAt(current.anchorNode)) {
        for (const attr of source.attributes) {
          if (!block.hasAttributeNS(attr.namespaceURI, attr.localName)) {
            block.setAttributeNS(attr.namespaceURI, attr.name, attr.value);
          }
        }
      }
      applyParagraphTypography(block);
    }
  }
  rememberSelection();
  schedule();
}

function schedule() {
  clearTimeout(timer);
  if (conflict) return;
  status.textContent = 'Editing…';
  timer = setTimeout(flush, delay);
}

function flush() {
  clearTimeout(timer);
  if (!readBody || inFlight || conflict) return;
  const body = readBody();
  if (body === acknowledgedBody) {
    status.textContent = 'Synced';
    if (queuedSave) {
      queuedSave = false;
      vscode.postMessage({ type: 'save' });
    }
    if (queuedSource) {
      queuedSource = false;
      openSourceDialog();
    }
    if (queuedPrint) {
      queuedPrint = false;
      vscode.postMessage({ type: 'print' });
    }
    return;
  }
  sendEdit(body);
}

function requestSave(event) {
  if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 's') return;
  event.preventDefault();
  if (conflict) return;
  queuedSave = true;
  flush();
}

function useHeadingShortcut(event) {
  const level = headingLevelForShortcut(event);
  if (!level || !page?.body || !readBody || conflict) return;
  const heading = 'h' + level;
  const current = page.getSelection();
  if (!current.rangeCount || !page.body.contains(current.anchorNode) || !page.body.contains(current.focusNode)) return;
  const first = paragraphAt(current.anchorNode);
  const block = first === paragraphAt(current.focusNode) ? first : null;
  event.preventDefault();
  event.stopPropagation();
  if (event.repeat) return;
  rememberSelection();
  formatParagraph(block?.localName === heading ? 'p' : heading);
}

document.addEventListener('keydown', requestSave);

function sendEdit(body, raw = false) {
  inFlight = { body, raw };
  if (raw) canvas.inert = toolbar.inert = true;
  status.textContent = 'Syncing…';
  vscode.postMessage({ type: 'edit', version, body, raw });
}

function showConflict() {
  clearTimeout(timer);
  queuedPrint = false;
  queuedSource = false;
  queuedSave = false;
  byId('conflict').hidden = false;
  canvas.inert = false;
  toolbar.inert = false;
  conflict = true;
  status.textContent = 'Source changed';
}

window.addEventListener('message', ({ data: message }) => {
  if (message.type === 'snapshot') {
    if (message.version < loadingVersion) return;
    if (conflict || inFlight || (readBody && readBody() !== acknowledgedBody)) showConflict();
    else displayDocument(message);
  } else if (message.type === 'reload') {
    inFlight = undefined;
    conflict = false;
    canvas.inert = false;
    byId('conflict').hidden = true;
    displayDocument(message);
  } else if (message.type === 'ack' && inFlight) {
    version = message.version;
    acknowledgedBody = inFlight.body;
    inFlight = undefined;
    if (message.html && !conflict) {
      canvas.inert = false;
      displayDocument(message);
    } else {
      flush();
    }
  } else if (message.type === 'conflict') {
    showConflict();
  } else if (message.type === 'retry') {
    if (inFlight?.raw) showConflict();
    else {
      inFlight = undefined;
      queuedPrint = false;
      queuedSave = false;
      status.textContent = 'Sync failed';
    }
  } else if (message.type === 'config') {
    delay = message.delay;
  }
});

function button(group, label, title, action) {
  const item = document.createElement('button');
  item.type = 'button';
  item.textContent = label;
  item.title = title;
  item.setAttribute('aria-label', title);
  item.addEventListener('mousedown', event => event.preventDefault());
  item.addEventListener('click', action);
  group.append(item);
  return item;
}

function select(group, title, options, action, { showCurrent = false, icon } = {}) {
  const item = document.createElement('select');
  item.setAttribute('aria-label', title);
  item.title = title;
  item.add(new Option(title, ''));
  for (const [label, value] of options) item.add(new Option(label, value));
  item.addEventListener('change', () => {
    if (item.value) action(item.value);
    if (!showCurrent) item.value = '';
  });
  if (icon) {
    const control = document.createElement('label');
    control.className = 'compact-tool compact-select';
    control.title = title;
    const symbol = document.createElement('span');
    symbol.textContent = icon;
    symbol.setAttribute('aria-hidden', 'true');
    control.append(symbol, item);
    group.append(control);
  } else {
    group.append(item);
  }
  return item;
}

function group() {
  const element = document.createElement('div');
  element.className = 'tool-group';
  toolbar.append(element);
  return element;
}

function dialogForm(title, fields, apply) {
  byId('dialog-title').textContent = title;
  const container = byId('fields');
  container.replaceChildren();
  const inputs = fields.map(field => {
    const label = document.createElement('label');
    label.textContent = field.label;
    const input = field.multiline ? document.createElement('textarea') : document.createElement('input');
    if (field.type) input.type = field.type;
    if (field.min != null) input.min = field.min;
    if (field.max != null) input.max = field.max;
    if (field.step != null) input.step = field.step;
    input.value = field.value ?? '';
    input.required = Boolean(field.required);
    label.append(input);
    container.append(label);
    return input;
  });
  dialog.returnValue = 'cancel';
  dialog.showModal();
  dialog.addEventListener('close', () => {
    if (dialog.returnValue === 'apply') apply(...inputs.map(input => input.value));
    else focusSelection();
  }, { once: true });
}

function insertMarkup(tag, attrs, content = '') {
  if (!page) return;
  const element = page.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  element.textContent = content;
  command('insertHTML', element.outerHTML);
}

function allowedUrl(value, image = false) {
  const text = value.trim();
  if (!text) return '';
  const scheme = text.match(/^([a-z][a-z\d+.-]*):/i)?.[1].toLowerCase();
  if (!scheme || ['http', 'https'].includes(scheme) ||
      (!image && ['mailto', 'tel'].includes(scheme)) || (image && /^data:image\/[\w.+-]+[;,]/i.test(text))) return text;
  status.textContent = 'Unsupported URL scheme';
  return '';
}

const history = group();
button(history, '↶', 'Undo', () => command('undo'));
button(history, '↷', 'Redo', () => command('redo'));

const format = group();
const paragraphMenu = select(format, 'Paragraph', [['Normal', 'p'], ['H1', 'h1'], ['H2', 'h2'], ['H3', 'h3'],
  ['H4', 'h4'], ['H5', 'h5'], ['H6', 'h6'], ['Quote', 'blockquote'], ['Code block', 'pre']], formatParagraph,
  { showCurrent: true, icon: 'H' });
select(format, 'Font', [['Arial', 'Arial'], ['Georgia', 'Georgia'], ['Times New Roman', 'Times New Roman'],
  ['Verdana', 'Verdana'], ['Courier New', 'Courier New'], ['System', 'system-ui']], value => command('fontName', value), { icon: 'Aa' });
select(format, 'Size', [['10 px', '1'], ['13 px', '2'], ['16 px', '3'], ['18 px', '4'], ['24 px', '5'],
  ['32 px', '6'], ['48 px', '7'], ['Custom…', 'custom']], value => {
  if (value === 'custom') {
    dialogForm('Font size', [{ label: 'Size in pixels', type: 'number', min: 1, step: 'any', required: true }], setCustomFontSize);
  } else {
    command('fontSize', value);
  }
}, { icon: 'A↕' });

const marks = group();
for (const [label, title, action] of [['B', 'Bold', 'bold'], ['I', 'Italic', 'italic'],
  ['U', 'Underline', 'underline'], ['S', 'Strikethrough', 'strikeThrough']]) {
  button(marks, label, title, () => command(action)).classList.add('compact-tool', 'toolbar-glyph', action);
}
const colorPicker = document.createElement('div');
colorPicker.id = 'color-picker';
colorPicker.className = 'color-picker';
colorPicker.setAttribute('role', 'group');
colorPicker.hidden = true;
document.body.append(colorPicker);
let activeColorButton;

const swatches = document.createElement('div');
swatches.className = 'color-swatches';
colorPicker.append(swatches);
for (const color of [
  '#000000', '#404040', '#666666', '#999999', '#b3b3b3', '#cccccc', '#ffffff',
  '#a00000', '#ff0000', '#ff9900', '#ffff00', '#00cc00', '#00cccc', '#3877d6',
  '#0000ff', '#8b00ff', '#ff00ff', '#e7b5a6', '#f4c7c3', '#fce5cd', '#fff2cc',
  '#d9ead3', '#d0e0e3', '#c9daf8', '#cfe2f3', '#d9d2e9', '#ead1dc', '#dd7e6b',
  '#ea9999', '#f9cb9c', '#ffe599', '#b6d7a8', '#a2c4c9', '#a4c2f4', '#9fc5e8'
]) {
  const item = button(swatches, '', color.toUpperCase(), () => applyColor(color));
  item.style.setProperty('--swatch', color);
}
const customColor = document.createElement('label');
customColor.className = 'custom-color';
customColor.textContent = 'Hex';
const hexColor = document.createElement('input');
hexColor.type = 'text';
hexColor.placeholder = '#RRGGBB';
hexColor.maxLength = 7;
hexColor.spellcheck = false;
hexColor.addEventListener('input', () => {
  if (/^#?[0-9a-f]{6}$/i.test(hexColor.value)) applyColor('#' + hexColor.value.replace(/^#/, ''));
});
customColor.append(hexColor);
colorPicker.append(customColor);

function applyColor(color) {
  const trigger = activeColorButton;
  if (!trigger) return;
  closeColorPicker();
  trigger.style.setProperty('--mark-color', color);
  command(trigger.dataset.command, color);
}

function closeColorPicker() {
  if (!activeColorButton) return;
  activeColorButton.setAttribute('aria-expanded', 'false');
  activeColorButton = undefined;
  colorPicker.hidden = true;
}

for (const [icon, title, action, color] of [
  ['A', 'Text color', 'foreColor', '#3877d6'],
  ['◆', 'Text background color', 'hiliteColor', '#ffe599']
]) {
  const trigger = button(marks, icon, title, () => {
    const wasOpen = activeColorButton === trigger;
    closeColorPicker();
    if (wasOpen) return;
    activeColorButton = trigger;
    trigger.setAttribute('aria-expanded', 'true');
    colorPicker.setAttribute('aria-label', title);
    hexColor.value = '';
    colorPicker.hidden = false;
    const box = trigger.getBoundingClientRect();
    colorPicker.style.left = Math.max(6, Math.min(box.left, window.innerWidth - colorPicker.offsetWidth - 6)) + 'px';
    colorPicker.style.top = Math.max(6, box.bottom + colorPicker.offsetHeight + 6 <= window.innerHeight
      ? box.bottom + 4 : box.top - colorPicker.offsetHeight - 4) + 'px';
    swatches.firstElementChild.focus({ preventScroll: true });
  });
  trigger.classList.add('color-trigger');
  trigger.dataset.command = action;
  trigger.style.setProperty('--mark-color', color);
  trigger.setAttribute('aria-controls', colorPicker.id);
  trigger.setAttribute('aria-expanded', 'false');
}
document.addEventListener('pointerdown', event => {
  if (!colorPicker.contains(event.target) && !event.target.closest?.('.color-trigger')) closeColorPicker();
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !activeColorButton) return;
  event.preventDefault();
  const trigger = activeColorButton;
  closeColorPicker();
  trigger.focus();
});
window.addEventListener('resize', closeColorPicker);
button(marks, 'Clear', 'Clear formatting', () => command('removeFormat'));

const layout = group();
select(layout, 'Align', [['Left', 'justifyLeft'], ['Center', 'justifyCenter'],
  ['Right', 'justifyRight'], ['Justify', 'justifyFull']], value => command(value));
button(layout, '• List', 'Bulleted list', () => command('insertUnorderedList'));
button(layout, '1. List', 'Numbered list', () => command('insertOrderedList'));
button(layout, '⇤', 'Decrease indent', () => command('outdent'));
button(layout, '⇥', 'Increase indent', () => command('indent'));

const insert = group();
const linkButton = button(insert, '', 'Insert link', () => {
  const selected = selection?.toString() || '';
  dialogForm('Insert link', [{ label: 'URL', required: true }, { label: 'Text', value: selected }], (url, label) => {
    const href = allowedUrl(url);
    if (href) insertMarkup('a', { href }, label || href);
  });
});
linkButton.classList.add('compact-tool', 'toolbar-glyph', 'link-icon');
button(insert, 'Image', 'Insert image', () => {
  dialogForm('Insert image', [{ label: 'URL or relative path', required: true }, { label: 'Alternative text' }], (url, alt) => {
    const src = allowedUrl(url, true);
    if (src) insertMarkup('img', { src, alt });
  });
});
button(insert, 'Media', 'Insert video or audio', () => {
  dialogForm('Insert video or audio', [{ label: 'URL or relative path', required: true }], url => {
    const src = allowedUrl(url, true);
    if (src) insertMarkup(/\.(mp3|ogg|wav|m4a|aac|flac)(?:[?#]|$)/i.test(src) ? 'audio' : 'video', { src, controls: '' });
  });
});
button(insert, 'Table', 'Insert table', () => {
  dialogForm('Insert table', [{ label: 'Rows', type: 'number', value: '2', min: 1, max: 30, required: true },
    { label: 'Columns', type: 'number', value: '2', min: 1, max: 20, required: true }], (rows, columns) => {
    const cell = '<td><br></td>';
    command('insertHTML', '<table><tbody>' + ('<tr>' + cell.repeat(Number(columns)) + '</tr>').repeat(Number(rows)) + '</tbody></table>');
  });
});
select(insert, 'Symbols', [...'©®™€£¥¢§¶°±×÷→←✓…—'].map(character => [character, character]),
  value => command('insertText', value));
button(insert, '', 'Normalize all H1–H5 headings', normalizeHeadings).classList.add('compact-tool', 'normalize-headings');

function openSourceDialog() {
  if (dialog.open) return;
  const original = acknowledgedBody;
  const originalVersion = version;
  dialogForm('Edit body HTML', [{ label: 'HTML', value: original, multiline: true }], body => {
    if (body === original) return;
    if (version !== originalVersion || conflict) {
      inFlight = { body, raw: true };
      showConflict();
      return;
    }
    sendEdit(body, true);
  });
}
byId('source').addEventListener('click', () => {
  if (conflict) return;
  queuedSource = true;
  flush();
});
byId('fullscreen').addEventListener('click', () => vscode.postMessage({ type: 'fullscreen' }));
byId('print').addEventListener('click', () => {
  if (conflict) return;
  queuedPrint = true;
  flush();
});
byId('copy').addEventListener('click', async () => {
  const body = inFlight?.raw ? inFlight.body : readBody?.();
  if (body == null) return;
  try {
    await navigator.clipboard.writeText(body);
    status.textContent = 'Draft copied';
  } catch {
    dialogForm('Copy draft HTML', [{ label: 'HTML', value: body, multiline: true }], () => {});
  }
});
byId('reload').addEventListener('click', () => vscode.postMessage({ type: 'reload' }));
vscode.postMessage({ type: 'ready' });


