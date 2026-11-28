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
const shapeKinds = {
  text: ['rect', 'Text Box'], rect: ['rect', 'Rectangle'], roundRect: ['roundRect', 'Rounded Rectangle'],
  circle: ['ellipse', 'Circle'], ellipse: ['ellipse', 'Oval'], triangle: ['triangle', 'Triangle'],
  diamond: ['diamond', 'Diamond'], rightArrow: ['rightArrow', 'Right Arrow']
};
const paragraphStyles = ['alignment', 'list', 'indent', 'spacing'];
const headingSizes = [36, 32, 28, 26, 24, 22];

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

function isHidden(meta) {
  const value = meta?.getAttribute('hidden');
  return value === '1' || value === 'true';
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
  const baseline = Number(attr('baseline'));
  const bullet = [props, inheritedProps].map(node => elements(node).find(item =>
    ['buNone', 'buAutoNum', 'buChar', 'buBlip'].some(name => is(item, 'a', name)))).find(Boolean);
  const spacing = child(child(props, 'a', 'lnSpc'), 'a', 'spcPct') || child(child(inheritedProps, 'a', 'lnSpc'), 'a', 'spcPct');
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
    baseline: baseline > 0 ? 'super' : baseline < 0 ? 'sub' : 'normal',
    color: first(solidFill),
    highlight: first(node => rgb(child(node, 'a', 'highlight'))),
    alignment: props?.getAttribute('algn') || inheritedProps?.getAttribute('algn') || 'l',
    list: bullet?.localName === 'buAutoNum' ? 'number' : ['buChar', 'buBlip'].includes(bullet?.localName) ? 'bullet' : 'none',
    indent: Number(props?.getAttribute('lvl') || inheritedProps?.getAttribute('lvl')) || 0,
    spacing: measure(spacing, 'val') / 100000 || 1
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
    this.insertions = new Set();
    this.deletions = new Set();
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
      objects: objects.filter(object => object.node.parentNode && !(thumbnail && object.hidden))
        .map(({ node, drawingId, paragraphs, cells, imagePart, mime, ...object }) => ({
        ...object,
        emptyText: object.textBox && paragraphs.every(line => line.every(field => !(this.value(field.key) ?? field.fixed)?.trim())),
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
    let nextObject = 0;

    const readTextBody = (source, body, inheritedBody, defaultFont) => {
      const inherited = children(inheritedBody, 'a', 'p');
      return children(body, 'a', 'p').map((paragraph, index) => {
        const paragraphKey = part + '#' + nextField;
        return paragraphFields(paragraph).map(group => {
          if (!group.runs) return group;
          const key = part + '#' + nextField++;
          const initial = group.runs.map(run => run.textContent).join('');
          const style = textStyle(paragraph, group.runs, inherited[index] || inherited[0], defaultFont);
          const field = { ...group, key, initial, part, paragraphKey, style, source };
          this.fields.set(key, field);
          return field;
        });
      });
    };

    const visit = (nodes, mapping, hiddenGroup = false) => {
      for (const node of nodes) {
        if (is(node, 'p', 'grpSp')) {
          const meta = properties(node, 'nvGrpSpPr');
          visit(elements(node), groupPosition(node, mapping), hiddenGroup || isHidden(meta));
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
        const base = { id: nextObject++, label, box: visibleBox, node, drawingId: meta?.getAttribute('id'), hidden: hiddenGroup || isHidden(meta) };
        if (picture) {
          const fill = child(node, 'p', 'blipFill');
          const imagePart = rels.get(relation(child(fill, 'a', 'blip'), 'embed'))?.target;
          const mime = imagePart && imageTypes[path.extname(imagePart).slice(1).toLowerCase()];
          objects.push({ ...base, type: 'image', imagePart, mime, paragraphs: [] });
        } else if (shape) {
          const body = child(node, 'p', 'txBody');
          const inheritedBody = child(inherited, 'p', 'txBody') || child(inheritedMaster, 'p', 'txBody');
          const font = hint && /title/i.test(hint.type) ? 30 : 18;
          const props = child(node, 'p', 'spPr');
          const textBox = child(child(node, 'p', 'nvSpPr'), 'p', 'cNvSpPr')?.getAttribute('txBox');
          if (body || visibleBox || textBox === '1' || textBox === 'true') {
            objects.push({
              ...base, type: 'shape', paragraphs: readTextBody(node, body, inheritedBody, font), font,
              textBox: textBox === '1' || textBox === 'true',
              fill: solidFill(props), stroke: solidFill(child(props, 'a', 'ln')),
              geometry: child(props, 'a', 'prstGeom')?.getAttribute('prst')
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
                paragraphs: readTextBody(node, body, undefined, 14)
              });
            });
          });
          const cols = children(child(table, 'a', 'tblGrid'), 'a', 'gridCol').length;
          objects.push({ ...base, type: 'table', rows: rows.length, cols, cells, paragraphs: cells.flatMap(cell => cell.paragraphs) });
        }
      }
    };
    const mapping = { x: 0, y: 0, sx: 1, sy: 1 };
    const tree = slideTree(document);
    visit(elements(tree), mapping);
    return { document, tree, objects, color: background(document) || background(layout) || background(master),
      readShape: node => {
        visit([node], mapping);
        const object = objects.pop();
        for (const field of object.paragraphs.flat()) if (field.key) this.fields.delete(field.key);
        return object;
      }
    };
  }

  prepareInsertion(index, kind, area) {
    if (!Object.hasOwn(shapeKinds, kind) || !area ||
        !['x', 'y', 'w', 'h'].every(name => Number.isFinite(area[name]) && area[name] >= 0 && area[name] <= 1)) return undefined;
    const part = this.slides[index];
    if (!part) return undefined;
    if (!this.documents.has(part)) this.documents.set(part, this.readSlide(part));
    const slide = this.documents.get(part);
    if (!slide.tree) return undefined;
    let w = Math.max(0.025, area.w || Math.min(kind === 'text' ? 0.38 : 0.2, 1 - area.x)) * this.width;
    let h = Math.max(0.035, area.h || Math.min(kind === 'text' ? 0.08 : 0.2, 1 - area.y)) * this.height;
    if (kind === 'circle') w = h = Math.min(w, h);
    const x = Math.min(area.x * this.width, this.width - w);
    const y = Math.min(area.y * this.height, this.height - h);
    const node = makeShape(slide.tree, kind, { x, y, w, h });
    const object = slide.readShape(node);
    return { part, slide, node, object };
  }

  applyInsertion(action, added) {
    if (this.insertions.has(action) === added) return;
    const { slide, node, object } = action;
    if (added) {
      slide.tree.insertBefore(node, child(slide.tree, 'p', 'extLst') || null);
      slide.objects.push(object);
      for (const field of object.paragraphs.flat()) if (field.key) this.fields.set(field.key, field);
      this.insertions.add(action);
    } else {
      slide.tree.removeChild(node);
      slide.objects.splice(slide.objects.indexOf(object), 1);
      for (const field of object.paragraphs.flat()) {
        this.fields.delete(field.key);
        this.edits.delete(field.key);
        this.styles.delete(field.key);
      }
      this.insertions.delete(action);
    }
  }

  prepareDeletion(index, ids) {
    const part = this.slides[index];
    const slide = this.documents.get(part);
    if (!slide || !Array.isArray(ids) || ids.length > 10000 || !ids.every(Number.isInteger)) return undefined;
    const selected = new Set(ids);
    const objects = slide.objects.filter(object => selected.has(object.id) && object.node.parentNode);
    if (!objects.length) return undefined;
    const nodes = new Set(objects.map(object => object.node));
    const drawingIds = new Set(objects.map(object => object.drawingId).filter(Boolean));
    for (const node of Array.from(slide.document.getElementsByTagName('*'))) {
      const target = NS.p.includes(node.namespaceURI) ? node.getAttribute('spid') :
        is(node, 'a', 'stCxn') || is(node, 'a', 'endCxn') ? node.getAttribute('id') : undefined;
      if (!drawingIds.has(target)) continue;
      let ancestor = node;
      while (ancestor && !nodes.has(ancestor)) ancestor = ancestor.parentNode;
      if (!ancestor) throw new Error('A selected object is referenced by an animation or connector. Deselect that object before deleting.');
    }
    return { part, objects, positions: objects.map(({ node }) => ({ node, parent: node.parentNode, next: node.nextSibling })) };
  }

  applyDeletion(action, removed) {
    if (this.deletions.has(action) === removed) return;
    if (removed) {
      for (const { node, parent } of action.positions) parent.removeChild(node);
      this.deletions.add(action);
    } else {
      // Restore the original stacking order, including adjacent selected objects.
      for (const { node, parent, next } of [...action.positions].reverse()) {
        parent.insertBefore(node, next?.parentNode === parent ? next : null);
      }
      this.deletions.delete(action);
    }
  }

  value(key) {
    return this.edits.get(key) ?? this.fields.get(key)?.initial;
  }

  style(field) {
    const style = { ...field.style, ...this.styles.get(field.key) };
    for (const property of paragraphStyles) style[property] = this.styles.get(field.paragraphKey)?.[property] ?? field.style[property];
    return style;
  }

  format(index, keys, property, value) {
    const heading = property === 'heading';
    const valid = heading ? Number.isInteger(value) && value >= 1 && value <= headingSizes.length : validStyle(property, value);
    if (!Array.isArray(keys) || keys.length > 10000 || !valid) return [];
    const targets = new Set();
    for (const key of keys) {
      const field = this.fields.get(key);
      if (!field?.source.parentNode || field.part !== this.slides[index]) return [];
      targets.add(heading || paragraphStyles.includes(property) ? field.paragraphKey : key);
    }
    if (heading) return this.formatHeading(targets, headingSizes[value - 1]);
    return [...targets].flatMap(key => this.styleChange(key, property, value));
  }

  formatHeading(paragraphs, size) {
    const fields = [...this.fields.values()].filter(field => paragraphs.has(field.paragraphKey) && field.source.parentNode);
    const reset = fields.every(field => {
      const style = this.style(field);
      return style.font === size && style.bold;
    });
    return fields.flatMap(({ key, source }) => {
      const normalSize = is(source, 'p', 'graphicFrame') ? 14 : 18;
      return [...this.styleChange(key, 'font', reset ? normalSize : size), ...this.styleChange(key, 'bold', !reset)];
    });
  }

  styleChange(key, property, value) {
    const previous = this.styles.get(key)?.[property];
    return previous === value ? [] : [{ key, property, previous, value }];
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
    const paragraphs = new Set(changes.filter(change => paragraphStyles.includes(change.property)).map(change => change.key));
    if (paragraphs.size) {
      for (const field of this.fields.values()) {
        if (paragraphs.has(field.paragraphKey)) keys.add(field.key);
      }
    }
    return [...keys].map(key => ({ key, style: this.style(this.fields.get(key)) }));
  }

  set(key, value) {
    const field = this.fields.get(key);
    if (!field?.source.parentNode || !validText(value)) return false;
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
      if (!field?.source.parentNode || field.part !== this.slides[index] || keys.has(key) || !validText(value)) return undefined;
      keys.add(key);
      const previous = this.value(key);
      if (previous !== value) changes.push({ key, value, previous });
    }
    return changes;
  }

  serialize() {
    if (!this.edits.size && !this.styles.size && !this.insertions.size && !this.deletions.size) return this.bytes;
    const updated = { ...this.entries };
    const byPart = new Map();
    for (const action of this.insertions) byPart.set(action.part, []);
    for (const action of this.deletions) byPart.set(action.part, []);
    for (const key of new Set([...this.edits.keys(), ...this.styles.keys()])) {
      const field = this.fields.get(key);
      if (!field?.source.parentNode) continue;
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
    case 'baseline': return ['normal', 'super', 'sub'].includes(value);
    case 'list': return ['none', 'bullet', 'number'].includes(value);
    case 'indent': return Number.isInteger(value) && value >= 0 && value <= 8;
    case 'spacing': return [1, 1.15, 1.5, 2].includes(value);
    case 'color':
    case 'highlight': return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value);
    default: return false;
  }
}

function makeShape(tree, kind, { x, y, w, h }) {
  const document = tree.ownerDocument;
  const p = tree.namespaceURI;
  const a = NS.a[NS.p.indexOf(p)];
  const element = (parent, name, attrs = {}) => {
    const node = document.createElementNS(name.startsWith('p:') ? p : a, name);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    if (parent) parent.appendChild(node);
    return node;
  };
  const [preset, label] = shapeKinds[kind];
  const ids = new Set(Array.from(tree.getElementsByTagNameNS(p, 'cNvPr'), node => Number(node.getAttribute('id'))));
  let id = 1;
  while (ids.has(id)) id++;
  const shape = element(null, 'p:sp');
  const nonVisual = element(shape, 'p:nvSpPr');
  element(nonVisual, 'p:cNvPr', { id, name: label + ' ' + id });
  element(nonVisual, 'p:cNvSpPr', kind === 'text' ? { txBox: 1 } : {});
  element(nonVisual, 'p:nvPr');
  const spec = element(shape, 'p:spPr');
  const transform = element(spec, 'a:xfrm');
  element(transform, 'a:off', { x: Math.round(x), y: Math.round(y) });
  element(transform, 'a:ext', { cx: Math.max(1, Math.round(w)), cy: Math.max(1, Math.round(h)) });
  element(element(spec, 'a:prstGeom', { prst: preset }), 'a:avLst');
  if (kind === 'text') {
    element(spec, 'a:noFill');
    element(element(spec, 'a:ln'), 'a:noFill');
    const body = element(shape, 'p:txBody');
    element(body, 'a:bodyPr', { wrap: 'square', lIns: 0, tIns: 0, rIns: 0, bIns: 0 });
    element(body, 'a:lstStyle');
    const paragraph = element(body, 'a:p');
    element(element(paragraph, 'a:pPr'), 'a:defRPr', { sz: 1800 });
    element(paragraph, 'a:endParaRPr', { sz: 1800 });
  } else {
    element(element(spec, 'a:solidFill'), 'a:srgbClr', { val: 'DBEAFE' });
    const line = element(spec, 'a:ln', { w: 12700 });
    element(element(line, 'a:solidFill'), 'a:srgbClr', { val: '4F78C5' });
  }
  return shape;
}

function drawingElement(context, name) {
  const prefix = context.prefix ? context.prefix + ':' : '';
  return context.ownerDocument.createElementNS(context.namespaceURI, prefix + name);
}

function applyFormat({ paragraph, runs, style }, format, restore) {
  const { alignment, list, indent, spacing, ...character } = format;
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
  if ([alignment, list, indent, spacing].some(value => value !== undefined)) {
    replace(paragraph, 'pPr', paragraph.firstChild, node => formatParagraph(node, { alignment, list, indent, spacing }, style.list));
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

function formatParagraph(node, { alignment, list, indent, spacing }, originalList) {
  if (alignment !== undefined) node.setAttribute('algn', alignment);
  if (spacing !== undefined) {
    const previous = child(node, 'a', 'lnSpc');
    if (previous) node.removeChild(previous);
    const setting = drawingElement(node, 'lnSpc');
    const percent = drawingElement(node, 'spcPct');
    percent.setAttribute('val', String(Math.round(spacing * 100000)));
    setting.appendChild(percent);
    node.insertBefore(setting, node.firstChild);
  }
  if (list !== undefined) {
    for (const item of elements(node)) {
      if (['buNone', 'buAutoNum', 'buChar', 'buBlip'].some(name => is(item, 'a', name))) node.removeChild(item);
    }
    const bullet = drawingElement(node, { none: 'buNone', bullet: 'buChar', number: 'buAutoNum' }[list]);
    if (list === 'bullet') bullet.setAttribute('char', '•');
    if (list === 'number') bullet.setAttribute('type', 'arabicPeriod');
    const following = elements(node).find(item => ['tabLst', 'defRPr', 'extLst'].some(name => is(item, 'a', name)));
    node.insertBefore(bullet, following || null);
    if (list === 'none') {
      node.setAttribute('indent', '0');
      node.setAttribute('marL', String((Number(node.getAttribute('lvl')) || 0) * 342900));
    }
  }
  if (indent !== undefined) node.setAttribute('lvl', String(indent));
  const hasBullet = (list ?? originalList) !== 'none';
  if (indent !== undefined || (list !== undefined && hasBullet)) {
    const level = Number(node.getAttribute('lvl')) || 0;
    node.setAttribute('marL', String(level * 342900 + (hasBullet ? 285750 : 0)));
    node.setAttribute('indent', hasBullet ? '-214312' : '0');
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
  attr('baseline', 'baseline', value => ({ normal: '0', super: '30000', sub: '-25000' })[value]);
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
