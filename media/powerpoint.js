/* global acquireVsCodeApi, createInlineEditor, headingLevelForShortcut */
'use strict';

const vscode = acquireVsCodeApi();
const get = id => document.getElementById(id);
const editor = get('editor');
const stage = get('stage');
const preview = get('slide');
const zoomSlider = get('zoom-slider');
const minZoom = Number(zoomSlider.min);
const maxZoom = Number(zoomSlider.max);
const emuPerPixel = 9525;
const thumbnails = get('thumbnails');
const objects = get('objects');
const fields = get('fields');
const message = get('message');
const inspector = get('inspector');
const formatting = get('formatting');
const insertPicker = get('insert');
const objectPanel = get('object-panel');
const objectOptions = get('object-options');
const selectButton = get('select-objects');
const deleteButton = get('delete-objects');
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
let manualZoom;
let displayedZoom = 100;
let placement;
let lastInsert = 0;
let objectMode = false;
const selectedObjects = new Set();

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
    if (objectMode) return;
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
  const actualWidth = slide.width / emuPerPixel;
  const fitWidth = Math.min(stage.clientWidth - 24, (stage.clientHeight - 24) * slide.width / slide.height);
  const width = manualZoom === undefined ? fitWidth : actualWidth * manualZoom / 100;
  preview.style.width = Math.max(1, width) + 'px';
  displayedZoom = manualZoom ?? Math.max(1, Math.round(width / actualWidth * 100));
  zoomSlider.value = String(displayedZoom);
  zoomSlider.setAttribute('aria-valuetext', displayedZoom + '%');
  get('zoom-actual').textContent = displayedZoom + '%';
  get('zoom-actual').setAttribute('aria-label', 'Current zoom ' + displayedZoom + '%, reset to 100%');
  get('zoom-fit').setAttribute('aria-pressed', String(manualZoom === undefined));
  get('zoom-out').disabled = displayedZoom <= minZoom;
  get('zoom-in').disabled = displayedZoom >= maxZoom;
}

new ResizeObserver(resize).observe(stage);

function setZoom(value, anchor) {
  if (!slide) return;
  const viewport = stage.getBoundingClientRect();
  const point = anchor || { x: viewport.left + stage.clientWidth / 2, y: viewport.top + stage.clientHeight / 2 };
  const before = preview.getBoundingClientRect();
  const x = Math.max(0, Math.min(1, (point.x - before.left) / before.width));
  const y = Math.max(0, Math.min(1, (point.y - before.top) / before.height));
  manualZoom = Math.max(minZoom, Math.min(maxZoom, value));
  resize();
  const after = preview.getBoundingClientRect();
  stage.scrollLeft += after.left + after.width * x - point.x;
  stage.scrollTop += after.top + after.height * y - point.y;
}

get('zoom-fit').addEventListener('click', () => {
  manualZoom = undefined;
  resize();
  stage.scrollTo(0, 0);
});
get('zoom-actual').addEventListener('click', () => setZoom(100));
get('zoom-out').addEventListener('click', () => setZoom(displayedZoom - 10));
get('zoom-in').addEventListener('click', () => setZoom(displayedZoom + 10));
zoomSlider.addEventListener('input', () => setZoom(zoomSlider.valueAsNumber));
stage.addEventListener('wheel', event => {
  if (!(event.ctrlKey || event.metaKey) || !event.deltaY) return;
  event.preventDefault();
  setZoom(displayedZoom + (event.deltaY < 0 ? 10 : -10), { x: event.clientX, y: event.clientY });
}, { passive: false });

function switchSlide(index) {
  if (!slide || index < 0 || index >= slide.count || index === slide.index) return;
  cancelInsertion();
  renderThumbnail(slide);
  vscode.postMessage({ type: 'slide', index });
}

function stopPlacement() {
  if (placement && preview.hasPointerCapture(placement.pointer)) preview.releasePointerCapture(placement.pointer);
  placement?.guide.remove();
  placement = undefined;
}

function cancelInsertion() {
  stopPlacement();
  insertPicker.value = '';
  delete preview.dataset.drawing;
}

function refreshObjectSelection() {
  for (const [id, element] of canvasObjects) {
    element.inert = objectMode;
    element.classList.toggle('object-selected', objectMode && selectedObjects.has(id));
  }
  for (const checkbox of objectOptions.querySelectorAll('input')) {
    checkbox.checked = selectedObjects.has(Number(checkbox.value));
  }
  deleteButton.disabled = !selectedObjects.size;
  get('selection-count').textContent = selectedObjects.size + ' selected';
}

function showObjects() {
  objectOptions.replaceChildren();
  if (!objectMode || !slide) return;
  for (const object of slide.objects) {
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = String(object.id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedObjects.add(object.id);
      else selectedObjects.delete(object.id);
      refreshObjectSelection();
    });
    const name = document.createElement('span');
    name.textContent = object.label;
    name.title = object.label;
    const details = [object.hidden && 'Hidden', object.emptyText && 'Empty text box', !object.box && 'No outline'].filter(Boolean);
    if (details.length) {
      const note = document.createElement('small');
      note.textContent = details.join(' · ');
      name.append(note);
    }
    label.append(checkbox, name);
    objectOptions.append(label);
  }
}

function setObjectMode(enabled) {
  if (objectMode === enabled) return;
  stopPlacement();
  objectMode = enabled;
  selectedObjects.clear();
  preview.toggleAttribute('data-selecting', enabled);
  objectPanel.hidden = !enabled;
  deleteButton.hidden = !enabled;
  selectButton.setAttribute('aria-pressed', String(enabled));
  if (enabled) {
    cancelInsertion();
    setInspector(false);
    inline.clear();
    selectObject(undefined);
    preview.focus({ preventScroll: true });
  }
  editor.classList.toggle('with-inspector', enabled || !inspector.hidden);
  showObjects();
  refreshObjectSelection();
  resize();
}

function selectArea(area, additive) {
  const slideBox = preview.getBoundingClientRect();
  const left = slideBox.left + area.x * slideBox.width;
  const top = slideBox.top + area.y * slideBox.height;
  const right = left + area.w * slideBox.width;
  const bottom = top + area.h * slideBox.height;
  const items = [...canvasObjects.entries()].map(([id, node]) => ({ id, box: node.getBoundingClientRect() }));
  if (!additive) selectedObjects.clear();
  if (!area.w && !area.h) {
    const item = items.reverse().find(({ box }) => left >= box.left && left <= box.right && top >= box.top && top <= box.bottom);
    if (item) {
      if (additive && selectedObjects.has(item.id)) selectedObjects.delete(item.id);
      else selectedObjects.add(item.id);
    }
  } else {
    for (const { id, box } of items) {
      if (box.left >= left - 1 && box.top >= top - 1 && box.right <= right + 1 && box.bottom <= bottom + 1) selectedObjects.add(id);
    }
  }
  refreshObjectSelection();
}

function deleteObjects() {
  if (!objectMode || !slide || !selectedObjects.size) return;
  vscode.postMessage({ type: 'deleteObjects', index: slide.index, ids: [...selectedObjects] });
}

selectButton.addEventListener('click', () => setObjectMode(!objectMode));
deleteButton.addEventListener('click', deleteObjects);

function slidePoint(event) {
  const box = preview.getBoundingClientRect();
  const clamp = value => Math.min(1, Math.max(0, value));
  return { x: clamp((event.clientX - box.left) / box.width), y: clamp((event.clientY - box.top) / box.height) };
}

function placementArea(from, to) {
  const w = Math.abs(to.x - from.x);
  const h = Math.abs(to.y - from.y);
  if (w * preview.clientWidth < 4 && h * preview.clientHeight < 4) return { ...from, w: 0, h: 0 };
  return { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), w, h };
}

function insertAt(kind, area) {
  if (!slide) return;
  lastInsert = Date.now();
  vscode.postMessage({ type: 'insert', index: slide.index, kind, area });
}

insertPicker.addEventListener('change', () => {
  if (insertPicker.value) {
    setObjectMode(false);
    preview.dataset.drawing = insertPicker.value;
  } else cancelInsertion();
});
preview.addEventListener('pointerdown', event => {
  if ((!insertPicker.value && !objectMode) || event.button !== 0 || placement) return;
  event.preventDefault();
  if (objectMode) preview.focus({ preventScroll: true });
  preview.setPointerCapture(event.pointerId);
  const guide = document.createElement('span');
  guide.className = objectMode ? 'placement-guide marquee' : 'placement-guide';
  guide.dataset.geometry = insertPicker.value === 'circle' ? 'ellipse' : insertPicker.value;
  preview.append(guide);
  placement = { from: slidePoint(event), guide, pointer: event.pointerId };
});
preview.addEventListener('pointermove', event => {
  if (placement?.pointer !== event.pointerId) return;
  const box = placementArea(placement.from, slidePoint(event));
  if (insertPicker.value === 'circle' && slide) {
    const length = Math.min(box.w * slide.width, box.h * slide.height);
    box.w = length / slide.width;
    box.h = length / slide.height;
  }
  Object.assign(placement.guide.style, {
    left: box.x * 100 + '%', top: box.y * 100 + '%', width: box.w * 100 + '%', height: box.h * 100 + '%'
  });
});
preview.addEventListener('pointerup', event => {
  if (placement?.pointer !== event.pointerId) return;
  const kind = insertPicker.value;
  const area = placementArea(placement.from, slidePoint(event));
  if (objectMode) {
    stopPlacement();
    selectArea(area, event.shiftKey);
    return;
  }
  cancelInsertion();
  insertAt(kind, area);
});
preview.addEventListener('pointercancel', cancelInsertion);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && insertPicker.value) cancelInsertion();
  if (!objectMode) return;
  if (event.key === 'Escape') {
    setObjectMode(false);
    selectButton.focus();
  } else if (event.key === 'Delete' &&
      (document.activeElement === preview || document.activeElement === deleteButton || objectPanel.contains(document.activeElement))) {
    event.preventDefault();
    deleteObjects();
  }
});
preview.addEventListener('dblclick', event => {
  if (objectMode || event.button !== 0 || insertPicker.value || Date.now() - lastInsert < 350 || event.target.closest('[data-inline-editor]')) return;
  event.preventDefault();
  insertAt('text', { ...slidePoint(event), w: 0, h: 0 });
});

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
  get('show-text').disabled = !getParts(selectedObject()?.paragraphs || []).length;
  const family = get('family');
  const typeface = commonStyle(targets, 'family');
  if (typeface && ![...family.options].some(option => option.value === typeface)) {
    family.add(new Option(typeface, typeface));
  }
  family.value = typeface || '';
  get('font').value = commonStyle(targets, 'font') ?? '';
  get('alignment').value = commonStyle(targets, 'alignment') || '';
  get('baseline').value = commonStyle(targets, 'baseline') || 'normal';
  get('list').value = commonStyle(targets, 'list') || '';
  get('spacing').value = commonStyle(targets, 'spacing') ?? '';
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

document.addEventListener('keydown', event => {
  const level = headingLevelForShortcut(event);
  if (!level || objectMode) return;
  const keys = inline.current()?.keys || (event.target.matches?.('#fields textarea') && selectedField ? [selectedField] : []);
  if (!keys.length) return;
  event.preventDefault();
  event.stopPropagation();
  if (!event.repeat) vscode.postMessage({ type: 'format', keys, property: 'heading', value: level });
}, true);

function toggleMark(property) {
  const enabled = commonStyle(formatTargets(), property) === true;
  format(property, !enabled);
}

get('family').add(new Option('Font', ''));
for (const name of families) get('family').add(new Option(name, name));
for (const property of ['family', 'alignment', 'color', 'highlight', 'baseline', 'list', 'spacing']) {
  const input = get(property);
  input.addEventListener('change', () => {
    if (input.value) format(property, property === 'spacing' ? Number(input.value) : input.value);
  });
}
get('font').addEventListener('change', event => {
  if (event.target.value && event.target.validity.valid) format('font', event.target.valueAsNumber);
  else refreshToolbar();
});
for (const mark of marks) {
  mark.addEventListener('mousedown', event => event.preventDefault());
  mark.addEventListener('click', () => toggleMark(mark.dataset.mark));
}
for (const [id, property, change, min, max] of [
  ['font-grow', 'font', 2, 1, 400], ['font-shrink', 'font', -2, 1, 400],
  ['indent-in', 'indent', 1, 0, 8], ['indent-out', 'indent', -1, 0, 8]
]) {
  const button = get(id);
  button.addEventListener('mousedown', event => event.preventDefault());
  button.addEventListener('click', () => {
    const base = formatTargets()[0]?.style[property];
    if (base !== undefined) format(property, Math.max(min, Math.min(max, base + change)));
  });
}

function setInspector(open, focus = false) {
  inspector.hidden = !open;
  editor.classList.toggle('with-inspector', open || objectMode);
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
  let numbering = 0;
  const elements = paragraphs.map(line => {
    const paragraph = document.createElement('span');
    paragraph.className = 'paragraph';
    const layout = line.find(part => part.style)?.style;
    if (layout) {
      paragraph.style.textAlign = { ctr: 'center', r: 'right', just: 'justify' }[layout.alignment] || '';
      paragraph.style.lineHeight = String(layout.spacing * 1.2);
      const listed = layout.list !== 'none';
      const indent = layout.indent * 342900 + (listed ? 285750 : 0);
      if (indent) paragraph.style.paddingInlineStart = indent / model.width * 100 + 'cqw';
      numbering = layout.list === 'number' ? numbering + 1 : 0;
      if (listed) {
        const marker = document.createElement('span');
        marker.className = 'paragraph-marker';
        marker.textContent = numbering ? numbering + '.' : '•';
        marker.style.insetInlineStart = layout.indent * 342900 / model.width * 100 + 'cqw';
        marker.contentEditable = 'false';
        marker.setAttribute('aria-hidden', 'true');
        paragraph.append(marker);
      }
    } else numbering = 0;
    for (const part of line) {
      const span = document.createElement('span');
      const style = part.style;
      if (style) {
        if (style.family) span.style.fontFamily = JSON.stringify(style.family) + ', sans-serif';
        if (style.font) span.style.fontSize = style.font * 12700 / model.width * (style.baseline === 'normal' ? 100 : 70) + 'cqw';
        if (style.baseline !== 'normal') span.style.verticalAlign = style.baseline;
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
  if (!box || (thumbnail && object.hidden)) return;
  const image = object.type === 'image' && !object.hidden && object.image && (!thumbnail || object.image.length <= 66 * 1024);
  const item = document.createElement(image ? 'img' : 'span');
  item.className = 'object ' + object.type;
  if (object.hidden) item.classList.add('hidden-object');
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
    if (object.geometry) item.dataset.geometry = object.geometry;
    if (object.fill) item.style.setProperty('--shape-fill', object.fill);
    if (object.stroke) item.style.setProperty('--shape-stroke', object.stroke);
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

function display(next, resetThumbnails, selection) {
  const sameSlide = next && slide && next.index === slide.index;
  const navigatorFocused = thumbnails.contains(document.activeElement);
  slide = next;
  insertPicker.disabled = !slide;
  selectButton.disabled = !slide;
  editor.hidden = !slide;
  get('zoom-controls').hidden = !slide;
  get('previous').disabled = !slide || slide.index === 0;
  get('next').disabled = !slide || slide.index === slide.count - 1;
  if (!slide) {
    setObjectMode(false);
    status('This presentation contains no slides.');
    refreshToolbar();
    return;
  }
  if (!sameSlide || resetThumbnails) selectedObjects.clear();
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
  cancelInsertion();
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
  const choices = slide.objects.filter(object => !object.hidden && getParts(object.paragraphs).length);
  objects.replaceChildren();
  for (const object of choices) objects.add(new Option(object.label, object.id));
  objects.disabled = choices.length === 0;
  const previous = sameSlide && choices.some(object => object.id === selected);
  selectObject(objectMode ? undefined : previous ? selected : choices[0]?.id, previous ? selectedCell : undefined);
  resize();
  if (objectMode) {
    const available = new Set(slide.objects.map(object => object.id));
    for (const id of selectedObjects) if (!available.has(id)) selectedObjects.delete(id);
    if (selection?.objectIds) {
      selectedObjects.clear();
      for (const id of selection.objectIds) if (available.has(id)) selectedObjects.add(id);
    }
    showObjects();
    refreshObjectSelection();
  }
  if (selection?.id !== undefined) {
    selectObject(selection.id);
    if (selection.focus) {
      const host = canvasObjects.get(selection.id);
      const first = host?.querySelector('[data-text-key]')?.firstChild;
      if (first) {
        host.focus({ preventScroll: true });
        document.getSelection().setPosition(first, 0);
      }
    }
  }
}

window.addEventListener('message', ({ data }) => {
  if (data.type === 'render') display(data.slide, data.resetThumbnails, data.selection);
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
