/* global acquireVsCodeApi, sourceTree, createResources */
'use strict';

const vscode = acquireVsCodeApi();
const byId = id => document.getElementById(id);
const canvas = byId('canvas');
const toolbar = byId('tools');
const status = byId('status');
const dialog = byId('dialog');

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
let selection;
let loadingVersion = -1;

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
  selection = undefined;
  readBody = undefined;
  resources?.dispose();
  resources = createResources(message.baseUrl);
  acknowledgedBody = message.html.bodySource;
  toolbar.inert = true;
  status.textContent = 'Loading…';
  byId('filename').textContent = message.filename;
  byId('breadcrumb').textContent = 'body';

  const next = document.createElement('iframe');
  next.title = 'Editable HTML document';
  next.setAttribute('sandbox', 'allow-same-origin');
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
    page.body.contentEditable = 'true';
    page.body.spellcheck = false;

    page.addEventListener('input', event => {
      if (!event.isComposing) schedule();
    });
    page.addEventListener('compositionend', schedule);
    page.addEventListener('selectionchange', rememberSelection);
    page.addEventListener('click', event => {
      if (event.target.closest?.('a[href], area[href]')) event.preventDefault();
    });
    page.addEventListener('submit', event => event.preventDefault());
    page.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') flush();
    });
    toolbar.inert = false;
    status.textContent = 'Synced';
  }, { once: true });
  frame = next;
  canvas.replaceChildren(next);
}

function rememberSelection() {
  if (!page) return;
  const current = page.getSelection();
  let node = current.anchorNode;
  if (!node || !page.body.contains(node)) return;
  if (current.rangeCount) selection = current.getRangeAt(0).cloneRange();
  const chain = [];
  if (node.nodeType !== Node.ELEMENT_NODE) node = node.parentElement;
  while (node && node !== page.body) {
    chain.unshift(node.localName + (node.id ? '#' + node.id : ''));
    node = node.parentElement;
  }
  byId('breadcrumb').textContent = ['body', ...chain].join(' › ');
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

function select(group, title, options, action) {
  const item = document.createElement('select');
  item.setAttribute('aria-label', title);
  item.title = title;
  item.add(new Option(title, ''));
  for (const [label, value] of options) item.add(new Option(label, value));
  item.addEventListener('change', () => {
    if (item.value) action(item.value);
    item.value = '';
  });
  group.append(item);
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
select(format, 'Paragraph', [['Normal', 'p'], ['Heading 1', 'h1'], ['Heading 2', 'h2'], ['Heading 3', 'h3'],
  ['Heading 4', 'h4'], ['Heading 5', 'h5'], ['Heading 6', 'h6'], ['Quote', 'blockquote'], ['Code block', 'pre']], value => command('formatBlock', value));
select(format, 'Font', [['Arial', 'Arial'], ['Georgia', 'Georgia'], ['Times New Roman', 'Times New Roman'],
  ['Verdana', 'Verdana'], ['Courier New', 'Courier New'], ['System', 'system-ui']], value => command('fontName', value));
select(format, 'Size', [['10 px', '1'], ['13 px', '2'], ['16 px', '3'], ['18 px', '4'], ['24 px', '5'],
  ['32 px', '6'], ['48 px', '7']], value => command('fontSize', value));

const marks = group();
for (const [label, title, action] of [['B', 'Bold', 'bold'], ['I', 'Italic', 'italic'],
  ['U', 'Underline', 'underline'], ['S', 'Strikethrough', 'strikeThrough']]) {
  button(marks, label, title, () => command(action));
}
button(marks, 'Text color', 'Text color', () =>
  dialogForm('Text color', [{ label: 'Color', type: 'color', value: '#223657' }], color => command('foreColor', color)));
button(marks, 'Highlight', 'Highlight color', () =>
  dialogForm('Highlight color', [{ label: 'Color', type: 'color', value: '#fff19a' }], color => command('hiliteColor', color)));
button(marks, 'Clear', 'Clear formatting', () => command('removeFormat'));

const layout = group();
select(layout, 'Align', [['Left', 'justifyLeft'], ['Center', 'justifyCenter'],
  ['Right', 'justifyRight'], ['Justify', 'justifyFull']], value => command(value));
button(layout, '• List', 'Bulleted list', () => command('insertUnorderedList'));
button(layout, '1. List', 'Numbered list', () => command('insertOrderedList'));
button(layout, '⇤', 'Decrease indent', () => command('outdent'));
button(layout, '⇥', 'Increase indent', () => command('indent'));

const insert = group();
button(insert, 'Link', 'Insert link', () => {
  const selected = selection?.toString() || '';
  dialogForm('Insert link', [{ label: 'URL', required: true }, { label: 'Text', value: selected }], (url, label) => {
    const href = allowedUrl(url);
    if (href) insertMarkup('a', { href }, label || href);
  });
});
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


