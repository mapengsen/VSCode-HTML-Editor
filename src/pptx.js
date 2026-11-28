const path = require('node:path').posix;
const { unzipSync, zipSync } = require('fflate');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const { diffChars } = require('diff');

const NS = {
  p: ['http://schemas.openxmlformats.org/presentationml/2006/main', 'http://purl.oclc.org/ooxml/presentationml/main'],
  a: ['http://schemas.openxmlformats.org/drawingml/2006/main', 'http://purl.oclc.org/ooxml/drawingml/main'],
  r: ['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships'],
  package: ['http://schemas.openxmlformats.org/package/2006/relationships']
};
const imageTypes = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const MiB = 1024 * 1024;

function is(node, namespace, name) {
  return node.localName === name && NS[namespace].includes(node.namespaceURI);
}

function elements(node) {
  return Array.from(node?.childNodes || []).filter(child => child.nodeType === 1);
}

function children(node, namespace, name) {
  return elements(node).filter(child => is(child, namespace, name));
}

function child(node, namespace, name) {
  return children(node, namespace, name)[0];
}

function relation(node, name) {
  return NS.r.map(namespace => node?.getAttributeNS(namespace, name)).find(Boolean);
}

function xml(bytes) {
  if (!bytes) throw new Error('The presentation is missing a required XML part.');
  const bom = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  const text = new TextDecoder(bom, { fatal: true }).decode(bytes);
  if (/<!DOCTYPE/i.test(text)) throw new Error('PowerPoint XML with a document type is unsupported.');
  return new DOMParser({
    onError(level, message) {
      if (level !== 'warning') throw new Error(message);
    }
  }).parseFromString(text, 'application/xml');
}

function safePart(target, current) {
  try {
    const name = decodeURIComponent(target);
    if (/[\\:#?]/.test(name)) return undefined;
    const result = path.normalize(name.startsWith('/') ? name.slice(1) : path.join(path.dirname(current), name));
    if (result && result !== '.' && result !== '..' && !result.startsWith('../')) return result;
  } catch {
    // Ignore malformed relationship targets.
  }
}

function relationships(entries, part) {
  const name = part ? path.join(path.dirname(part), '_rels', path.basename(part) + '.rels') : '_rels/.rels';
  if (!entries[name]) return new Map();
  const nodes = children(xml(entries[name]).documentElement, 'package', 'Relationship');
  const result = new Map();
  for (const node of nodes) {
    if (node.getAttribute('TargetMode') === 'External') continue;
    const target = safePart(node.getAttribute('Target') || '', part || '');
    if (target && Object.hasOwn(entries, target)) {
      result.set(node.getAttribute('Id'), { target, type: node.getAttribute('Type').split('/').at(-1) });
    }
  }
  return result;
}

function related(map, type) {
  return [...map.values()].find(item => item.type === type)?.target;
}

function measure(node, name) {
  const value = node?.getAttribute(name);
  return value !== null && value !== undefined && value !== '' ? Number(value) : NaN;
}

function bounds(transform) {
  const offset = child(transform, 'a', 'off');
  const extent = child(transform, 'a', 'ext');
  const box = {
    x: measure(offset, 'x'), y: measure(offset, 'y'),
    w: measure(extent, 'cx'), h: measure(extent, 'cy'),
    angle: (measure(transform, 'rot') || 0) / 60000
  };
  return Object.values(box).every(Number.isFinite) && box.w > 0 && box.h > 0 ? box : undefined;
}

function groupPosition(node, parent) {
  const transform = child(child(node, 'p', 'grpSpPr'), 'a', 'xfrm');
  const box = bounds(transform);
  const offset = child(transform, 'a', 'chOff');
  const size = child(transform, 'a', 'chExt');
  const coordinates = [measure(offset, 'x'), measure(offset, 'y'), measure(size, 'cx'), measure(size, 'cy')];
  if (!box || !coordinates.every(Number.isFinite) || coordinates[2] <= 0 || coordinates[3] <= 0) return parent;
  const [x, y, w, h] = coordinates;
  const sx = parent.sx * box.w / w;
  const sy = parent.sy * box.h / h;
  return { sx, sy, x: parent.x + box.x * parent.sx - x * sx, y: parent.y + box.y * parent.sy - y * sy };
}

function properties(shape, type) {
  return child(child(shape, 'p', type), 'p', 'cNvPr');
}

function placeholder(shape) {
  const meta = child(child(shape, 'p', 'nvSpPr'), 'p', 'nvPr');
  const node = child(meta, 'p', 'ph');
  return node && { type: node.getAttribute('type') || 'body', index: node.getAttribute('idx') };
}

function slideTree(document) {
  return child(child(document?.documentElement, 'p', 'cSld'), 'p', 'spTree');
}

function findPlaceholder(document, info) {
  const shapes = children(slideTree(document), 'p', 'sp');
  return (info.index && shapes.find(shape => placeholder(shape)?.index === info.index)) ||
    shapes.find(shape => placeholder(shape)?.type === info.type);
}

function transform(shape) {
  return child(child(shape, 'p', 'spPr'), 'a', 'xfrm') || child(shape, 'p', 'xfrm');
}

function rgb(node) {
  const value = child(node, 'a', 'srgbClr')?.getAttribute('val');
  return value && /^[\da-f]{6}$/i.test(value) ? '#' + value : undefined;
}

function solidFill(node) {
  return rgb(child(node, 'a', 'solidFill'));
}

function background(document) {
  const slide = child(document?.documentElement, 'p', 'cSld');
  return solidFill(child(child(slide, 'p', 'bg'), 'p', 'bgPr'));
}

function textStyle(paragraph, runs, inheritedParagraph, defaultFont) {
  const props = child(paragraph, 'a', 'pPr');
  const inheritedProps = child(inheritedParagraph, 'a', 'pPr');
  const cascade = [runs.length ? child(runs[0].parentNode, 'a', 'rPr') : child(paragraph, 'a', 'endParaRPr'),
    child(props, 'a', 'defRPr'), child(inheritedProps, 'a', 'defRPr')];
  const attr = name => cascade.map(node => node?.getAttribute(name)).find(Boolean);
  const first = read => cascade.map(read).find(Boolean);
  const size = Number(attr('sz'));
  return {
    font: size >= 100 ? size / 100 : defaultFont,
    family: first(node => {
      const face = child(node, 'a', 'latin')?.getAttribute('typeface');
      return face && !face.startsWith('+') ? face : undefined;
    }),
    bold: ['1', 'true'].includes(attr('b')),
    italic: ['1', 'true'].includes(attr('i')),
    underline: Boolean(attr('u') && attr('u') !== 'none'),
    strike: Boolean(attr('strike') && attr('strike') !== 'noStrike'),
    color: first(solidFill),
    highlight: first(node => rgb(child(node, 'a', 'highlight'))),
    alignment: props?.getAttribute('algn') || inheritedProps?.getAttribute('algn') || 'l'
  };
}

// Split editable runs at fixed fields and soft line breaks so those objects keep their identity.
function paragraphFields(paragraph) {
  const groups = [];
  let runs = [];
  for (const node of elements(paragraph)) {
    if (is(node, 'a', 'r')) {
      const text = child(node, 'a', 't');
      if (text) runs.push(text);
      continue;
    }
    if (is(node, 'a', 'fld') || is(node, 'a', 'br')) {
      if (runs.length) groups.push({ paragraph, runs });
      runs = [];
      groups.push({ fixed: is(node, 'a', 'br') ? '\n' : child(node, 'a', 't')?.textContent || '' });
    }
  }
  if (runs.length || !groups.length) groups.push({ paragraph, runs });
  return groups;
}

function unpack(bytes) {
  if (bytes.length > 100 * MiB) throw new Error('This PowerPoint file exceeds 100 MB.');
  const names = new Set();
  let total = 0;
  return unzipSync(bytes, {
    filter({ name, originalSize }) {
      if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..') ||
          ['__proto__', 'constructor', 'prototype'].includes(name) || names.has(name)) {
        throw new Error('The PowerPoint package contains an invalid part name.');
      }
      names.add(name);
      total += originalSize;
      if (names.size > 20000 || total > 384 * MiB || (/\.(xml|rels)$/i.test(name) && originalSize > 24 * MiB)) {
        throw new Error('This PowerPoint package is too large to edit safely.');
      }
      return true;
    }
  });
}

class Presentation {
  constructor(bytes) {
    this.bytes = bytes;
    this.entries = unpack(bytes);
    const root = relationships(this.entries, '');
    const part = related(root, 'officeDocument');
    const deck = xml(part && this.entries[part]).documentElement;
    if (!is(deck, 'p', 'presentation')) throw new Error('This file is not a PowerPoint presentation.');
    const typeManifest = xml(this.entries['[Content_Types].xml']);
    if (elements(typeManifest.documentElement).some(node =>
      /digital-signature/i.test(node.getAttribute('ContentType') || ''))) {
      throw new Error('This presentation has a digital signature. Edit an unsigned copy.');
    }
    const rels = relationships(this.entries, part);
    const size = child(deck, 'p', 'sldSz');
    this.width = measure(size, 'cx') || 9144000;
    this.height = measure(size, 'cy') || 6858000;
    if (!(this.width > 0 && this.height > 0)) throw new Error('Invalid slide dimensions.');
    this.slides = children(child(deck, 'p', 'sldIdLst'), 'p', 'sldId').map(node => {
      const slide = rels.get(relation(node, 'id'));
      if (slide?.type !== 'slide') throw new Error('A slide relationship is missing.');
      return slide.target;
    });
    this.documents = new Map();
    this.sharedParts = new Map();
    this.fields = new Map();
    this.edits = new Map();
    this.styles = new Map();
  }

  slide(index, thumbnail = false) {
    if (!Number.isInteger(index) || index < 0 || index >= this.slides.length) return undefined;
    const part = this.slides[index];
    if (!this.documents.has(part)) this.documents.set(part, this.readSlide(part));
    const { objects, color } = this.documents.get(part);
    const toView = field => field.key != null
      ? { key: field.key, value: thumbnail ? this.value(field.key).slice(0, 240) : this.value(field.key), style: this.style(field) }
      : { value: field.fixed };
    let imageBytes = 0;
    const image = (imagePart, mime) => {
      const data = this.entries[imagePart];
      if (!data || !mime || data.length > (thumbnail ? 48 * 1024 : 5 * MiB) ||
          imageBytes + data.length > (thumbnail ? 96 * 1024 : 12 * MiB)) return undefined;
      imageBytes += data.length;
      return 'data:' + mime + ';base64,' + Buffer.from(data).toString('base64');
    };
    return {
      index, count: this.slides.length, width: this.width, height: this.height, background: color,
      objects: objects.map(({ paragraphs, cells, imagePart, mime, ...object }) => ({
        ...object,
        image: imagePart ? image(imagePart, mime) : undefined,
        paragraphs: paragraphs.map(line => line.map(toView)),
        cells: cells?.map(cell => ({
          ...cell, paragraphs: cell.paragraphs.map(line => line.map(toView))
        }))
      }))
    };
  }

  sharedPart(part) {
    if (!part) return undefined;
    if (!this.sharedParts.has(part)) this.sharedParts.set(part, xml(this.entries[part]));
    return this.sharedParts.get(part);
  }

  readSlide(part) {
    const document = xml(this.entries[part]);
    const rels = relationships(this.entries, part);
    const layoutPart = related(rels, 'slideLayout');
    const layout = this.sharedPart(layoutPart);
    const masterPart = layoutPart && related(relationships(this.entries, layoutPart), 'slideMaster');
    const master = this.sharedPart(masterPart);
    const objects = [];
    let nextField = 0;

    const readTextBody = (body, inheritedBody, defaultFont) => {
      const inherited = children(inheritedBody, 'a', 'p');
      return children(body, 'a', 'p').map((paragraph, index) => {
        const paragraphKey = part + '#' + nextField;
        return paragraphFields(paragraph).map(group => {
          if (!group.runs) return group;
          const key = part + '#' + nextField++;
          const initial = group.runs.map(run => run.textContent).join('');
          const style = textStyle(paragraph, group.runs, inherited[index] || inherited[0], defaultFont);
          const field = { ...group, key, initial, part, paragraphKey, style };
          this.fields.set(key, field);
          return field;
        });
      });
    };

    const visit = (tree, mapping) => {
      for (const node of elements(tree)) {
        if (is(node, 'p', 'grpSp')) {
          visit(node, groupPosition(node, mapping));
          continue;
        }
        const shape = is(node, 'p', 'sp');
        const picture = is(node, 'p', 'pic');
        const frame = is(node, 'p', 'graphicFrame');
        if (!shape && !picture && !frame) continue;
        const meta = properties(node, shape ? 'nvSpPr' : picture ? 'nvPicPr' : 'nvGraphicFramePr');
        const label = meta?.getAttribute('name') || (picture ? 'Picture' : frame ? 'Table' : 'Text box');
        const hint = shape && placeholder(node);
        const inherited = hint && findPlaceholder(layout, hint);
        const inheritedMaster = hint && findPlaceholder(master, placeholder(inherited) || hint);
        const box = bounds(transform(node)) || bounds(transform(inherited)) || bounds(transform(inheritedMaster));
        const visibleBox = box && {
          x: box.x * mapping.sx + mapping.x, y: box.y * mapping.sy + mapping.y,
          w: box.w * mapping.sx, h: box.h * mapping.sy, angle: box.angle
        };
        const base = { id: objects.length, label, box: visibleBox };
        if (picture) {
          const fill = child(node, 'p', 'blipFill');
          const imagePart = rels.get(relation(child(fill, 'a', 'blip'), 'embed'))?.target;
          const mime = imagePart && imageTypes[path.extname(imagePart).slice(1).toLowerCase()];
          objects.push({ ...base, type: 'image', imagePart, mime, paragraphs: [] });
        } else if (shape) {
          const body = child(node, 'p', 'txBody');
          const inheritedBody = child(inherited, 'p', 'txBody') || child(inheritedMaster, 'p', 'txBody');
          const font = hint && /title/i.test(hint.type) ? 30 : 18;
          if (body || visibleBox) {
            objects.push({
              ...base, type: 'shape', paragraphs: readTextBody(body, inheritedBody, font), font,
              fill: solidFill(child(node, 'p', 'spPr'))
            });
          }
        } else {
          const graphic = child(child(node, 'a', 'graphic'), 'a', 'graphicData');
          const table = child(graphic, 'a', 'tbl');
          const rows = children(table, 'a', 'tr');
          if (!rows.length) continue;
          const cells = [];
          rows.forEach((row, rowIndex) => {
            children(row, 'a', 'tc').forEach((cell, colIndex) => {
              if (cell.getAttribute('hMerge') === '1' || cell.getAttribute('vMerge') === '1') return;
              const body = child(cell, 'a', 'txBody');
              cells.push({
                row: rowIndex, col: colIndex,
                rowSpan: Number(cell.getAttribute('rowSpan')) || 1,
                colSpan: Number(cell.getAttribute('gridSpan')) || 1,
                paragraphs: readTextBody(body, undefined, 14)
              });
            });
          });
          const cols = children(child(table, 'a', 'tblGrid'), 'a', 'gridCol').length;
          objects.push({ ...base, type: 'table', rows: rows.length, cols, cells, paragraphs: cells.flatMap(cell => cell.paragraphs) });
        }
      }
    };
    visit(slideTree(document), { x: 0, y: 0, sx: 1, sy: 1 });
    return { document, objects, color: background(document) || background(layout) || background(master) };
  }

  value(key) {
    return this.edits.get(key) ?? this.fields.get(key)?.initial;
  }

  style(field) {
    return {
      ...field.style, ...this.styles.get(field.key),
      alignment: this.styles.get(field.paragraphKey)?.alignment ?? field.style.alignment
    };
  }

  format(index, keys, property, value) {
    if (!Array.isArray(keys) || keys.length > 10000 || !validStyle(property, value)) return [];
    const targets = new Set();
    for (const key of keys) {
      const field = this.fields.get(key);
      if (!field || field.part !== this.slides[index]) return [];
      targets.add(property === 'alignment' ? field.paragraphKey : key);
    }
    return [...targets].flatMap(key => {
      const previous = this.styles.get(key)?.[property];
      return previous === value ? [] : [{ key, property, previous, value }];
    });
  }

  applyStyles(changes, undo = false) {
    for (const change of changes) {
      const { key, property, previous, value } = change;
      const style = { ...this.styles.get(key) };
      const next = undo ? previous : value;
      if (next === undefined) delete style[property];
      else style[property] = next;
      if (Object.keys(style).length) this.styles.set(key, style);
      else this.styles.delete(key);
    }
  }

  styleUpdates(changes) {
    const keys = new Set(changes.map(change => change.key));
    const paragraphs = new Set(changes.filter(change => change.property === 'alignment').map(change => change.key));
    if (paragraphs.size) {
      for (const field of this.fields.values()) {
        if (paragraphs.has(field.paragraphKey)) keys.add(field.key);
      }
    }
    return [...keys].map(key => ({ key, style: this.style(this.fields.get(key)) }));
  }

  set(key, value) {
    const field = this.fields.get(key);
    if (!field || !validText(value)) return false;
    if (value === field.initial) this.edits.delete(key);
    else this.edits.set(key, value);
    return true;
  }

  textChanges(index, edits) {
    if (!Array.isArray(edits) || edits.length > 10000) return undefined;
    const changes = [];
    const keys = new Set();
    for (const entry of edits) {
      const { key, value } = entry || {};
      const field = this.fields.get(key);
      if (!field || field.part !== this.slides[index] || keys.has(key) || !validText(value)) return undefined;
      keys.add(key);
      const previous = this.value(key);
      if (previous !== value) changes.push({ key, value, previous });
    }
    return changes;
  }

  serialize() {
    if (!this.edits.size && !this.styles.size) return this.bytes;
    const updated = { ...this.entries };
    const byPart = new Map();
    for (const key of new Set([...this.edits.keys(), ...this.styles.keys()])) {
      const field = this.fields.get(key);
      if (!byPart.has(field.part)) byPart.set(field.part, []);
      byPart.get(field.part).push(field);
    }
    const serializer = new XMLSerializer();
    for (const [part, fields] of byPart) {
      const { document } = this.documents.get(part);
      const restore = [];
      try {
        for (const field of fields) {
          if (this.edits.has(field.key)) restore.push(applyText(field, this.edits.get(field.key)));
          if (this.styles.has(field.key)) applyFormat(field, this.styles.get(field.key), restore);
          if (this.edits.get(field.key)?.includes('\n')) splitRunLines(field.runs, restore);
        }
        const serialized = serializer.serializeToString(document).replace(
          /^(<\?xml\b[^?]*?\bencoding\s*=\s*)(['"])[^'"]+\2/i, '$1"UTF-8"'
        );
        updated[part] = Buffer.from(serialized, 'utf8');
      } finally {
        for (const undo of restore.reverse()) undo();
      }
    }
    return zipSync(updated, { level: 5 });
  }
}

function validText(value) {
  return typeof value === 'string' && value.length <= 100000 &&
    !/[\u0000-\u0008\u000b-\u001f\ud800-\udfff\ufffe\uffff]/u.test(value);
}

function validStyle(property, value) {
  switch (property) {
    case 'font': return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 400;
    case 'family': return typeof value === 'string' && /^[\p{L}\p{N} ._()\-]{1,80}$/u.test(value) && value.trim().length > 0;
    case 'bold':
    case 'italic':
    case 'underline':
    case 'strike': return typeof value === 'boolean';
    case 'alignment': return ['l', 'ctr', 'r', 'just'].includes(value);
    case 'color':
    case 'highlight': return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value);
    default: return false;
  }
}

function drawingElement(context, name) {
  const prefix = context.prefix ? context.prefix + ':' : '';
  return context.ownerDocument.createElementNS(context.namespaceURI, prefix + name);
}

function applyFormat({ paragraph, runs }, format, restore) {
  const { alignment, ...character } = format;
  const replace = (parent, name, insertBefore, mutate) => {
    const previous = child(parent, 'a', name);
    const node = previous ? previous.cloneNode(true) : drawingElement(paragraph, name);
    mutate(node);
    if (previous) parent.replaceChild(node, previous);
    else parent.insertBefore(node, insertBefore);
    restore.push(() => {
      if (previous) parent.replaceChild(previous, node);
      else parent.removeChild(node);
    });
  };
  if (alignment !== undefined) {
    replace(paragraph, 'pPr', paragraph.firstChild, node => node.setAttribute('algn', alignment));
  }
  if (!Object.keys(character).length) return;
  if (runs.length) {
    for (const text of runs) {
      replace(text.parentNode, 'rPr', text, node => formatRun(node, character));
    }
  } else {
    replace(paragraph, 'endParaRPr', null, node => formatRun(node, character));
  }
}

const fills = ['noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill'];
const runOrder = [
  'ln', ...fills, 'effectLst', 'effectDag', 'highlight', 'uLnTx', 'uLn', 'uFillTx', 'uFill',
  'latin', 'ea', 'cs', 'sym', 'hlinkClick', 'hlinkMouseOver', 'rtl', 'extLst'
];

function formatRun(node, style) {
  const attr = (field, name, toValue) => {
    if (style[field] !== undefined) node.setAttribute(name, toValue(style[field]));
  };
  attr('font', 'sz', value => String(Math.round(value * 100)));
  attr('bold', 'b', value => value ? '1' : '0');
  attr('italic', 'i', value => value ? '1' : '0');
  attr('underline', 'u', value => value ? 'sng' : 'none');
  attr('strike', 'strike', value => value ? 'sngStrike' : 'noStrike');
  const insert = (name, remove = [name]) => {
    for (const old of elements(node)) {
      if (NS.a.includes(old.namespaceURI) && remove.includes(old.localName)) node.removeChild(old);
    }
    const order = runOrder.indexOf(name);
    const following = elements(node).find(item => NS.a.includes(item.namespaceURI) && runOrder.indexOf(item.localName) > order);
    const fresh = drawingElement(node, name);
    node.insertBefore(fresh, following || null);
    return fresh;
  };
  if (style.family) {
    for (const name of ['latin', 'ea', 'cs']) {
      const font = child(node, 'a', name) || insert(name);
      font.setAttribute('typeface', style.family);
    }
  }
  const setColor = (value, name, remove) => {
    if (!value) return;
    const color = drawingElement(node, 'srgbClr');
    color.setAttribute('val', value.slice(1).toUpperCase());
    insert(name, remove).appendChild(color);
  };
  setColor(style.color, 'solidFill', fills);
  setColor(style.highlight, 'highlight');
}

function applyText(field, next) {
  const { runs, paragraph } = field;
  const document = paragraph.ownerDocument;
  if (!runs.length) {
    const prefix = paragraph.prefix ? paragraph.prefix + ':' : '';
    const run = document.createElementNS(paragraph.namespaceURI, prefix + 'r');
    const text = document.createElementNS(paragraph.namespaceURI, prefix + 't');
    text.textContent = next;
    run.appendChild(text);
    paragraph.insertBefore(run, child(paragraph, 'a', 'endParaRPr') || null);
    runs.push(text);
    return () => {
      runs.pop();
      paragraph.removeChild(run);
    };
  }

  const original = runs.map(run => run.textContent);
  const changes = diffChars(original.join(''), next, { timeout: 60 });
  const result = runs.map(() => '');
  let index = 0;
  let offset = 0;
  let previous = 0;
  for (const change of changes || [{ value: next, added: true }]) {
    if (change.added) {
      result[previous] += change.value;
      continue;
    }
    let consumed = 0;
    while (consumed < change.value.length) {
      while (index < runs.length - 1 && offset >= original[index].length) {
        index++;
        offset = 0;
      }
      const length = Math.min(change.value.length - consumed, original[index].length - offset);
      if (length <= 0) break;
      if (!change.removed) result[index] += change.value.slice(consumed, consumed + length);
      if (!change.removed || consumed === 0) previous = index;
      offset += length;
      consumed += length;
    }
  }
  runs.forEach((run, index) => {
    if (result[index] !== original[index]) run.textContent = result[index];
  });
  return () => runs.forEach((run, index) => {
    if (result[index] !== original[index]) run.textContent = original[index];
  });
}

function splitRunLines(runs, restore) {
  for (const text of runs) {
    const value = text.textContent;
    if (!value.includes('\n')) continue;
    const [first, ...lines] = value.split('\n');
    const run = text.parentNode;
    const paragraph = run.parentNode;
    const next = run.nextSibling;
    const props = child(run, 'a', 'rPr');
    const inserted = [];
    text.textContent = first;
    for (const line of lines) {
      const lineBreak = drawingElement(run, 'br');
      if (props) lineBreak.appendChild(props.cloneNode(true));
      const continuation = run.cloneNode(true);
      child(continuation, 'a', 't').textContent = line;
      paragraph.insertBefore(lineBreak, next);
      paragraph.insertBefore(continuation, next);
      inserted.push(lineBreak, continuation);
    }
    restore.push(() => {
      text.textContent = value;
      for (const node of inserted) paragraph.removeChild(node);
    });
  }
}

module.exports = { Presentation };
