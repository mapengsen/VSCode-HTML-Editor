/* global acquireVsCodeApi, createInlineEditor */
'use strict';

const vscode = acquireVsCodeApi();
const get = id => document.getElementById(id);
const editor = get('editor');
const stage = get('stage');
const preview = get('slide');
const thumbnails = get('thumbnails');
const objects = get('objects');
const fields = get('fields');
const message = get('message');
const inspector = get('inspector');
const formatting = get('formatting');
const marks = [...formatting.querySelectorAll('[data-mark]')];
const families = ['Arial', 'Aptos', 'Calibri', 'Georgia', 'Microsoft YaHei', 'Noto Sans CJK SC', 'SimSun', 'Times New Roman', 'Verdana'];
const canvasObjects = new Map();
const textInputs = new Map();
const modelFields = new Map();
const requestedPreviews = new Set();
const pendingPreviews = new Set();
let previewRequest;
let thumbnailRender;
let slide;
let selected;
let selectedCell;
let selectedField;
let inlineKeys = [];

const inline = createInlineEditor(preview, {
  select(host, keys) {
    const id = Number(host.dataset.inlineEditor);
    const cell = host.hasAttribute('data-cell') ? Number(host.dataset.cell) : undefined;
    if (id !== selected || cell !== selectedCell) selectObject(id, cell);
    if (selectedField === undefined && inlineKeys.length === keys.length && inlineKeys.every((key, index) => key === keys[index])) return;
    selectedField = undefined;
    inlineKeys = keys;
    refreshToolbar();
  },
  deselect() {
    inline.clear();
    selectObject(undefined);
  },
  value: key => modelFields.get(key)?.part.value || '',
  edit: (_host, edits, caret) => editFields(edits, caret),
  repaint: (host, caret) => repaint(Number(host.dataset.inlineEditor), caret),
  mark: toggleMark,
  history: type => vscode.postMessage({ type }),
  error: status
});

function status(text) {
  message.hidden = !text;
  message.textContent = text || '';
}

function resize() {
  if (!slide) return;
  const width = Math.min(stage.clientWidth - 24, (stage.clientHeight - 24) * slide.width / slide.height);
  preview.style.width = Math.max(1, width) + 'px';
}

new ResizeObserver(resize).observe(stage);

function switchSlide(index) {
  if (!slide || index < 0 || index >= slide.count || index === slide.index) return;
  renderThumbnail(slide);
  vscode.postMessage({ type: 'slide', index });
}

get('previous').addEventListener('click', () => switchSlide(slide.index - 1));
get('next').addEventListener('click', () => switchSlide(slide.index + 1));

const thumbnailObserver = new IntersectionObserver(entries => {
  for (const entry of entries) {
    const index = Number(entry.target.dataset.index);
    if (!entry.isIntersecting || requestedPreviews.has(index)) continue;
    requestedPreviews.add(index);
    pendingPreviews.add(index);
  }
  if (pendingPreviews.size && !previewRequest) {
    previewRequest = requestAnimationFrame(requestThumbnails);
  }
}, { root: thumbnails, rootMargin: '160px 0px' });

function requestThumbnails() {
  previewRequest = undefined;
  const indices = [...pendingPreviews].slice(0, 12);
  if (!indices.length) return;
  for (const index of indices) pendingPreviews.delete(index);
  vscode.postMessage({ type: 'thumbnails', indices });
  if (pendingPreviews.size) previewRequest = requestAnimationFrame(requestThumbnails);
}

function createThumbnails(count) {
  thumbnailObserver.disconnect();
  requestedPreviews.clear();
  pendingPreviews.clear();
  const list = document.createDocumentFragment();
  for (let index = 0; index < count; index++) {
    const row = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.index = index;
    button.tabIndex = -1;
    button.setAttribute('aria-label', 'Slide ' + (index + 1));
    const label = document.createElement('span');
    label.className = 'slide-number';
    label.textContent = index + 1;
    const card = document.createElement('span');
    card.className = 'thumbnail';
    card.style.aspectRatio = slide.width + ' / ' + slide.height;
    card.setAttribute('aria-hidden', 'true');
    button.append(label, card);
    row.append(button);
    list.append(row);
    thumbnailObserver.observe(button);
  }
  thumbnails.replaceChildren(list);
}

function renderThumbnail(model) {
  const card = thumbnails.children[model.index]?.querySelector('.thumbnail');
  if (!card) return;
  card.style.backgroundColor = model.background || '#fff';
  card.replaceChildren(...model.objects.map(object => drawObject(object, model, true)).filter(Boolean));
}

function activeThumbnail() {
  return thumbnails.children[slide.index]?.firstElementChild;
}

thumbnails.addEventListener('click', event => {
  const button = event.target.closest('[data-index]');
  if (button) switchSlide(Number(button.dataset.index));
});
thumbnails.addEventListener('keydown', event => {
  if (!slide) return;
  const target = {
    ArrowUp: slide.index - 1, ArrowDown: slide.index + 1,
    PageUp: slide.index - 1, PageDown: slide.index + 1,
    Home: 0, End: slide.count - 1
  }[event.key];
  if (target === undefined) return;
  event.preventDefault();
  switchSlide(target);
});

for (const type of ['save', 'undo', 'redo']) {
  get(type).addEventListener('mousedown', event => { if (inline.current()) event.preventDefault(); });
  get(type).addEventListener('click', () => vscode.postMessage({ type }));
}

document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    vscode.postMessage({ type: 'save' });
  }
});

function getParts(paragraphs) {
  return paragraphs.flat().filter(part => part.key !== undefined);
}

function selectedObject() {
  return slide?.objects.find(item => item.id === selected);
}

function formatTargets() {
  const object = selectedObject();
  if (!object) return [];
  const parts = getParts(object.cells?.[selectedCell]?.paragraphs || object.paragraphs);
  if (selectedField) return parts.filter(part => part.key === selectedField);
  return inlineKeys.length ? parts.filter(part => inlineKeys.includes(part.key)) : parts;
}

function commonStyle(targets, property) {
  const value = targets[0]?.style[property];
  return targets.every(part => part.style[property] === value) ? value : undefined;
}

function refreshToolbar() {
  const targets = formatTargets();
  for (const element of formatting.querySelectorAll('button, select, input')) element.disabled = !targets.length;
  get('show-text').disabled = !selectedObject();
  const family = get('family');
  const typeface = commonStyle(targets, 'family');
  if (typeface && ![...family.options].some(option => option.value === typeface)) {
    family.add(new Option(typeface, typeface));
  }
  family.value = typeface || '';
  get('font').value = commonStyle(targets, 'font') ?? '';
  get('alignment').value = commonStyle(targets, 'alignment') || '';
  get('color').value = commonStyle(targets, 'color') || '#17202b';
  get('highlight').value = commonStyle(targets, 'highlight') || '#fff19a';
  for (const mark of marks) {
    const active = commonStyle(targets, mark.dataset.mark);
    const mixed = active === undefined && targets.some(part => part.style[mark.dataset.mark]);
    mark.setAttribute('aria-pressed', mixed ? 'mixed' : String(active === true));
  }
}

function format(property, value) {
  const keys = formatTargets().map(part => part.key);
  if (keys.length) vscode.postMessage({ type: 'format', keys, property, value });
}

function toggleMark(property) {
  const enabled = commonStyle(formatTargets(), property) === true;
  format(property, !enabled);
}

get('family').add(new Option('Font', ''));
for (const name of families) get('family').add(new Option(name, name));
for (const property of ['family', 'alignment', 'color', 'highlight']) {
  const input = get(property);
  input.addEventListener('change', () => { if (input.value) format(property, input.value); });
}
get('font').addEventListener('change', event => {
  if (event.target.value && event.target.validity.valid) format('font', event.target.valueAsNumber);
  else refreshToolbar();
});
for (const mark of marks) {
  mark.addEventListener('mousedown', event => event.preventDefault());
  mark.addEventListener('click', () => toggleMark(mark.dataset.mark));
}

function setInspector(open, focus = false) {
  inspector.hidden = !open;
  editor.classList.toggle('with-inspector', open);
  get('show-text').setAttribute('aria-expanded', String(open));
  if (open && focus) fields.querySelector('textarea')?.focus();
  if (!open && selectedField) {
    selectedField = undefined;
    refreshToolbar();
  }
}

get('show-text').addEventListener('click', () => setInspector(inspector.hidden, true));

function writeParagraphs(container, paragraphs, model) {
  const editing = container.hasAttribute('data-inline-editor');
  const elements = paragraphs.map(line => {
    const paragraph = document.createElement('span');
    paragraph.className = 'paragraph';
    const alignment = line.find(part => part.style)?.style.alignment;
    paragraph.style.textAlign = { ctr: 'center', r: 'right', just: 'justify' }[alignment] || '';
    for (const part of line) {
      const span = document.createElement('span');
      const style = part.style;
      if (style) {
        if (style.family) span.style.fontFamily = JSON.stringify(style.family) + ', sans-serif';
        if (style.font) span.style.fontSize = style.font * 12700 / model.width * 100 + 'cqw';
        if (style.bold) span.style.fontWeight = '700';
        if (style.italic) span.style.fontStyle = 'italic';
        span.style.textDecorationLine = [style.underline && 'underline', style.strike && 'line-through'].filter(Boolean).join(' ');
        if (style.color) span.style.color = style.color;
        if (style.highlight) span.style.backgroundColor = style.highlight;
      }
      if (editing && part.key != null) {
        span.dataset.textKey = part.key;
        span.append(document.createTextNode(part.value));
        if (!part.value || part.value.endsWith('\n')) span.append(document.createElement('br'));
      } else {
        span.textContent = part.value;
        if (editing) span.contentEditable = 'false';
      }
      paragraph.append(span);
    }
    if (!paragraph.textContent && !paragraph.querySelector('br')) paragraph.append(document.createElement('br'));
    return paragraph;
  });
  container.replaceChildren(...elements);
}

function makeEditable(element, id, label) {
  element.dataset.inlineEditor = id;
  element.contentEditable = 'plaintext-only';
  element.tabIndex = 0;
  element.spellcheck = false;
  element.setAttribute('role', 'textbox');
  element.setAttribute('aria-label', label);
  element.setAttribute('aria-multiline', 'true');
}

function updateObject(item, object, model) {
  if (!item || object.type === 'image') return;
  if (object.type === 'table') {
    [...item.children].forEach((cell, index) => writeParagraphs(cell, object.cells[index].paragraphs, model));
  } else {
    writeParagraphs(item, object.paragraphs, model);
  }
}

function drawObject(object, model, thumbnail = false) {
  const { box } = object;
  if (!box) return;
  const image = object.type === 'image' && object.image && (!thumbnail || object.image.length <= 66 * 1024);
  const item = document.createElement(image ? 'img' : 'span');
  item.className = 'object ' + object.type;
  item.style.left = box.x / model.width * 100 + '%';
  item.style.top = box.y / model.height * 100 + '%';
  item.style.width = box.w / model.width * 100 + '%';
  item.style.height = box.h / model.height * 100 + '%';
  item.style.transform = 'rotate(' + box.angle + 'deg)';
  if (image) {
    item.src = object.image;
    item.alt = '';
  } else if (object.type === 'image') {
    item.classList.add('image-placeholder');
  } else if (object.type === 'table') {
    item.style.gridTemplateColumns = 'repeat(' + Math.max(1, object.cols) + ', minmax(0, 1fr))';
    item.style.gridTemplateRows = 'repeat(' + object.rows + ', minmax(0, 1fr))';
    for (const [index, cell] of object.cells.entries()) {
      const element = document.createElement('span');
      element.dataset.cell = index;
      if (!thumbnail && getParts(cell.paragraphs).length) {
        makeEditable(element, object.id, object.label + ', row ' + (cell.row + 1) + ', column ' + (cell.col + 1));
      }
      element.style.gridColumn = (cell.col + 1) + ' / span ' + cell.colSpan;
      element.style.gridRow = (cell.row + 1) + ' / span ' + cell.rowSpan;
      item.append(element);
    }
  } else {
    if (object.fill) item.style.backgroundColor = object.fill;
    if (object.font) item.style.fontSize = object.font * 12700 / model.width * 100 + 'cqw';
    if (!thumbnail && getParts(object.paragraphs).length) makeEditable(item, object.id, object.label);
  }
  if (!thumbnail && getParts(object.paragraphs).length) {
    item.classList.add('editable');
    item.title = object.label;
  }
  updateObject(item, object, model);
  return item;
}

function refreshSlidePreview() {
  if (thumbnailRender) return;
  thumbnailRender = requestAnimationFrame(() => {
    thumbnailRender = undefined;
    if (slide) renderThumbnail(slide);
  });
}

function repaint(id, caret, focus = false) {
  const item = canvasObjects.get(id);
  const object = slide?.objects.find(entry => entry.id === id);
  const composing = inline.composing();
  if (!item || !object || (composing && item.contains(composing))) return;
  updateObject(item, object, slide);
  if (caret && item.contains(caret.host)) inline.restore(caret, focus);
}

function editFields(edits, caret) {
  const changed = setValues(edits);
  if (caret && !changed.size) repaint(Number(caret.host.dataset.inlineEditor), caret);
  for (const id of changed) repaint(id, caret);
  refreshSlidePreview();
  status('');
  if (changed.size) vscode.postMessage({ type: 'edit', edits });
}

function setValues(edits) {
  const changed = new Set();
  for (const { key, value } of edits) {
    const field = modelFields.get(key);
    if (!field || field.part.value === value) continue;
    field.part.value = value;
    const input = textInputs.get(key);
    if (input && input.value !== value) input.value = value;
    changed.add(field.id);
  }
  return changed;
}

function addTextFields(paragraphs) {
  for (const [index, paragraph] of paragraphs.entries()) {
    let segment = 0;
    for (const part of paragraph) {
      if (part.key === undefined) continue;
      segment++;
      const label = document.createElement('label');
      const caption = document.createElement('span');
      caption.textContent = 'Paragraph ' + (index + 1) + (segment === 1 ? '' : ', part ' + segment);
      const input = document.createElement('textarea');
      input.value = part.value;
      input.rows = 2;
      input.maxLength = 100000;
      input.addEventListener('focus', () => {
        selectedField = part.key;
        refreshToolbar();
      });
      input.addEventListener('input', event => {
        if (!event.isComposing) editFields([{ key: part.key, value: input.value }]);
      });
      input.addEventListener('compositionend', () => editFields([{ key: part.key, value: input.value }]));
      label.append(caption, input);
      fields.append(label);
      textInputs.set(part.key, input);
    }
  }
}

function selectObject(id, cellIndex) {
  selected = id;
  selectedCell = cellIndex;
  selectedField = undefined;
  inlineKeys = [];
  objects.value = String(id);
  fields.replaceChildren();
  textInputs.clear();
  for (const [key, node] of canvasObjects) {
    node.classList.toggle('selected', id === key);
    for (const cell of node.querySelectorAll('[data-cell]')) {
      cell.classList.toggle('selected-cell', id === key && Number(cell.dataset.cell) === cellIndex);
    }
  }
  const object = selectedObject();
  if (!object) {
    const note = document.createElement('p');
    note.textContent = objects.options.length ? 'Click text on the slide to edit.' : 'This slide has no editable text.';
    fields.append(note);
  } else if (object.type === 'table') {
    const cells = object.cells[cellIndex] ? [object.cells[cellIndex]] : object.cells;
    for (const cell of cells) {
      if (!getParts(cell.paragraphs).length) continue;
      const title = document.createElement('h2');
      title.textContent = 'Row ' + (cell.row + 1) + ', column ' + (cell.col + 1);
      fields.append(title);
      addTextFields(cell.paragraphs);
    }
  } else {
    addTextFields(object.paragraphs);
  }
  refreshToolbar();
}

objects.addEventListener('change', () => selectObject(Number(objects.value)));

function display(next, resetThumbnails) {
  const sameSlide = next && slide && next.index === slide.index;
  const navigatorFocused = thumbnails.contains(document.activeElement);
  slide = next;
  editor.hidden = !slide;
  get('previous').disabled = !slide || slide.index === 0;
  get('next').disabled = !slide || slide.index === slide.count - 1;
  if (!slide) {
    status('This presentation contains no slides.');
    refreshToolbar();
    return;
  }
  status('');
  if (resetThumbnails || thumbnails.children.length !== slide.count) createThumbnails(slide.count);
  get('slide-count').textContent = (slide.index + 1) + ' / ' + slide.count;
  const button = activeThumbnail();
  for (const row of thumbnails.children) {
    const current = row.firstElementChild === button;
    row.firstElementChild.tabIndex = current ? 0 : -1;
    if (current) row.firstElementChild.setAttribute('aria-current', 'page');
    else row.firstElementChild.removeAttribute('aria-current');
  }
  button.scrollIntoView({ block: 'nearest' });
  if (navigatorFocused) button.focus({ preventScroll: true });
  renderThumbnail(slide);
  inline.clear();
  preview.replaceChildren();
  preview.style.aspectRatio = slide.width + ' / ' + slide.height;
  preview.style.backgroundColor = slide.background || '#fff';
  canvasObjects.clear();
  modelFields.clear();
  for (const object of slide.objects) {
    if (object.type === 'table') object.paragraphs = object.cells.flatMap(cell => cell.paragraphs);
    for (const part of getParts(object.paragraphs)) modelFields.set(part.key, { part, id: object.id });
    const element = drawObject(object, slide);
    if (!element) continue;
    canvasObjects.set(object.id, element);
    preview.append(element);
  }
  const choices = slide.objects.filter(object => getParts(object.paragraphs).length);
  objects.replaceChildren();
  for (const object of choices) objects.add(new Option(object.label, object.id));
  objects.disabled = choices.length === 0;
  const previous = sameSlide && choices.some(object => object.id === selected);
  selectObject(previous ? selected : choices[0]?.id, previous ? selectedCell : undefined);
  resize();
}

window.addEventListener('message', ({ data }) => {
  if (data.type === 'render') display(data.slide, data.resetThumbnails);
  else if (data.type === 'thumbnail') {
    if (data.slide.index !== slide?.index) renderThumbnail(data.slide);
  } else if (data.type === 'error') status(data.message);
  else if (data.type === 'values' && slide) {
    const caret = inline.current();
    for (const id of setValues(data.values)) repaint(id, caret);
    refreshSlidePreview();
  } else if (data.type === 'styles' && slide) {
    const focus = formatting.contains(document.activeElement);
    const caret = inline.current() || (focus ? inline.remembered() : undefined);
    const touched = new Set();
    for (const { key, style } of data.fields) {
      const field = modelFields.get(key);
      if (!field) continue;
      field.part.style = style;
      touched.add(field.id);
    }
    for (const id of touched) repaint(id, caret, focus);
    refreshToolbar();
    refreshSlidePreview();
  }
});

refreshToolbar();
vscode.postMessage({ type: 'ready' });
