const { test } = require('node:test');
const assert = require('node:assert/strict');
const { unzipSync, zipSync, strFromU8, strToU8 } = require('fflate');
const { Presentation } = require('../src/pptx');

const namespaces = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const relType = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const xmlRels = entries => '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  entries.map(([id, type, target]) => '<Relationship Id="' + id + '" Type="' + relType + type + '" Target="' + target + '"/>').join('') +
  '</Relationships>';
const slide = content => '<p:sld ' + namespaces + '><p:cSld><p:spTree>' + content + '</p:spTree></p:cSld></p:sld>';
const shape = content => '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Sample title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
  '<p:spPr><a:xfrm><a:off x="100" y="100"/><a:ext cx="2000" cy="1000"/></a:xfrm></p:spPr>' +
  '<p:txBody><a:bodyPr/><a:lstStyle/>' + content + '</p:txBody></p:sp>';

function fixture() {
  const entries = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    '_rels/.rels': xmlRels([['presentation', 'officeDocument', 'ppt/presentation.xml']]),
    'ppt/presentation.xml': '<p:presentation ' + namespaces + '><p:sldIdLst>' +
      '<p:sldId id="256" r:id="second"/><p:sldId id="257" r:id="first"/></p:sldIdLst>' +
      '<p:sldSz cx="9144000" cy="6858000"/></p:presentation>',
    'ppt/_rels/presentation.xml.rels': xmlRels([['first', 'slide', 'slides/slide1.xml'], ['second', 'slide', 'slides/slide2.xml']]),
    'ppt/slides/slide1.xml': slide(shape('<a:p><a:r><a:t>Unchanged slide</a:t></a:r></a:p>')),
    'ppt/slides/slide2.xml': slide(shape([
      '<a:p><a:r><a:rPr b="1"/><a:t>Title</a:t></a:r><a:r><a:rPr i="1"/><a:t> original</a:t></a:r>',
      '<a:br/><a:r><a:t>line 2</a:t></a:r><a:fld id="{123}" type="slidenum"><a:t>1</a:t></a:fld></a:p>',
      '<a:p><a:endParaRPr lang="en-US"/></a:p>'
    ].join(''))),
    'ppt/notesSlides/notesSlide2.xml': '<p:notes ' + namespaces + '/>',
    'ppt/media/image1.png': new Uint8Array([137, 80, 78, 71])
  };
  return zipSync(Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, typeof value === 'string' ? strToU8(value) : value])));
}

test('PPTX editing follows slide relationships and preserves runs, fields and untouched parts', () => {
  const bytes = fixture();
  const deck = new Presentation(bytes);
  const [lines] = deck.slide(0).objects.map(object => object.paragraphs);
  assert.equal(lines[0][0].value, 'Title original');
  assert.equal(lines[0][1].value, '\n');
  assert.equal(lines[0][2].value, 'line 2');
  assert.equal(lines[0][3].key, undefined);
  assert.deepEqual(deck.serialize(), bytes);
  assert(deck.set(lines[0][0].key, 'Title revised & <ok>'));
  assert(deck.set(lines[1][0].key, '新增文本'));
  assert.equal(deck.set(lines[0][0].key, 'invalid\u0000'), false);
  const actual = unzipSync(deck.serialize());
  const original = unzipSync(bytes);
  for (const key of Object.keys(original)) {
    if (key !== 'ppt/slides/slide2.xml') assert.deepEqual(actual[key], original[key], key);
  }
  const updated = strFromU8(actual['ppt/slides/slide2.xml']);
  assert.match(updated, /<a:rPr b="1"\/><a:t>Title<\/a:t>/);
  assert.match(updated, /<a:rPr i="1"\/><a:t> revised &amp; &lt;ok&gt;<\/a:t>/);
  assert.match(updated, /<a:fld id="\{123\}" type="slidenum"><a:t>1<\/a:t><\/a:fld>/);
  assert.match(updated, /<a:r><a:t>新增文本<\/a:t><\/a:r><a:endParaRPr lang="en-US"\/>/);
  const reopened = new Presentation(deck.serialize());
  assert.equal(reopened.slide(0).objects[0].paragraphs[0][0].value, 'Title revised & <ok>');
  assert.equal(reopened.slide(1).objects[0].paragraphs[0][0].value, 'Unchanged slide');
  assert(deck.set(lines[0][0].key, 'Title original'));
  assert(deck.set(lines[1][0].key, ''));
  assert.deepEqual(deck.serialize(), bytes);
});

test('insertions create native shapes and editable text boxes and are reversible', () => {
  const bytes = fixture();
  const deck = new Presentation(bytes);
  const location = { x: 0.15, y: 0.18, w: 0.3, h: 0.15 };
  assert.equal(deck.prepareInsertion(0, 'unknown', location), undefined);
  const rectangle = deck.prepareInsertion(0, 'rect', location);
  deck.applyInsertion(rectangle, true);
  const circle = deck.prepareInsertion(0, 'circle', { ...location, x: 0.5 });
  deck.applyInsertion(circle, true);
  const text = deck.prepareInsertion(0, 'text', { ...location, y: 0.5, w: 0, h: 0 });
  assert.equal(deck.fields.has(text.object.paragraphs[0][0].key), false);
  deck.applyInsertion(text, true);
  const inserted = deck.slide(0).objects.slice(1);
  assert.equal(inserted.length, 3);
  assert.equal(inserted[0].geometry, 'rect');
  assert.equal(inserted[1].geometry, 'ellipse');
  assert.equal(inserted[1].box.w, inserted[1].box.h);
  assert(deck.set(inserted[2].paragraphs[0][0].key, '新增文本框'));
  const saved = unzipSync(deck.serialize());
  const original = unzipSync(bytes);
  assert.deepEqual(saved['ppt/slides/slide1.xml'], original['ppt/slides/slide1.xml']);
  const output = strFromU8(saved['ppt/slides/slide2.xml']);
  assert.match(output, /<p:cNvSpPr txBox="1"\/>/);
  assert.match(output, /<a:prstGeom prst="ellipse">/);
  const ids = [...output.matchAll(/<p:cNvPr id="(\d+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, 4);
  const reopened = new Presentation(deck.serialize());
  assert.equal(reopened.slide(0).objects[3].paragraphs[0][0].value, '新增文本框');
  deck.applyInsertion(text, false);
  deck.applyInsertion(circle, false);
  deck.applyInsertion(rectangle, false);
  assert.deepEqual(deck.serialize(), bytes);
  deck.applyInsertion(rectangle, true);
  assert.equal(deck.slide(0).objects[1].id, rectangle.object.id);
});

test('batch deletion removes empty and hidden text boxes and restores the original stacking order', () => {
  const seed = new Presentation(fixture());
  const area = { x: 0.1, y: 0.14, w: 0.2, h: 0.12 };
  const empty = seed.prepareInsertion(0, 'text', area);
  const hidden = seed.prepareInsertion(0, 'text', { ...area, y: 0.3 });
  hidden.node.getElementsByTagName('p:cNvPr').item(0).setAttribute('hidden', '1');
  seed.applyInsertion(empty, true);
  seed.applyInsertion(hidden, true);
  const before = seed.serialize();
  const deck = new Presentation(before);
  const [original, first, second] = deck.slide(0).objects;
  assert.equal(first.emptyText, true);
  assert.equal(second.hidden, true);
  assert.equal(deck.slide(0, true).objects.length, 2);
  const key = first.paragraphs[0][0].key;
  assert(deck.set(key, 'Unsaved text'));
  const deletion = deck.prepareDeletion(0, [second.id, first.id]);
  deck.applyDeletion(deletion, true);
  assert.deepEqual(deck.slide(0).objects.map(object => object.id), [original.id]);
  assert.equal(deck.textChanges(0, [{ key, value: 'Ignored' }]), undefined);
  const remaining = new Presentation(deck.serialize());
  assert.equal(remaining.slide(0).objects.length, 1);
  assert.deepEqual(unzipSync(deck.serialize())['ppt/slides/slide1.xml'], unzipSync(before)['ppt/slides/slide1.xml']);
  deck.applyDeletion(deletion, false);
  assert.deepEqual(deck.slide(0).objects.map(object => object.id), [original.id, first.id, second.id]);
  assert.equal(deck.slide(0).objects[1].paragraphs[0][0].value, 'Unsaved text');
  assert(deck.set(key, ''));
  assert.deepEqual(deck.serialize(), before);
});

test('deleting an object referenced by remaining slide timing is rejected without changing the slide', () => {
  const container = unzipSync(fixture());
  const part = 'ppt/slides/slide2.xml';
  container[part] = strToU8(strFromU8(container[part]).replace('</p:sld>', '<p:timing><p:spTgt spid="2"/></p:timing></p:sld>'));
  const bytes = zipSync(container);
  const deck = new Presentation(bytes);
  const [shape] = deck.slide(0).objects;
  assert.throws(() => deck.prepareDeletion(0, [shape.id]), /animation or connector/);
  assert.deepEqual(deck.serialize(), bytes);
});

test('lists, indentation, spacing and superscript are native formatting', () => {
  const deck = new Presentation(fixture());
  const [paragraph] = deck.slide(0).objects[0].paragraphs;
  const [first, , later] = paragraph;
  for (const [property, value] of [['list', 'number'], ['indent', 2], ['spacing', 1.5], ['baseline', 'super']]) {
    const changes = deck.format(0, [first.key], property, value);
    assert.equal(changes.length, 1);
    deck.applyStyles(changes);
  }
  const actual = deck.slide(0).objects[0].paragraphs[0];
  assert.equal(actual.find(item => item.key === later.key).style.list, 'number');
  const output = strFromU8(unzipSync(deck.serialize())['ppt/slides/slide2.xml']);
  assert.match(output, /<a:pPr lvl="2" marL="971550" indent="-214312"><a:lnSpc><a:spcPct val="150000"\/><\/a:lnSpc><a:buAutoNum type="arabicPeriod"\/>/);
  assert.match(output, /<a:rPr b="1" baseline="30000"\/>/);
  const reopened = new Presentation(deck.serialize()).slide(0).objects[0].paragraphs[0][0];
  assert.equal(reopened.style.baseline, 'super');
  assert.equal(reopened.style.spacing, 1.5);
});

test('PPTX formatting saves proper DrawingML, follows paragraph scope and can be undone', () => {
  const bytes = fixture();
  const deck = new Presentation(bytes);
  const [first, second] = deck.slide(0).objects[0].paragraphs;
  const keys = [first[0].key, second[0].key];
  assert.deepEqual(deck.format(1, keys, 'bold', true), []);
  assert.deepEqual(deck.format(0, keys, 'font', 0), []);
  const changes = [
    ...deck.format(0, keys, 'font', 26),
    ...deck.format(0, [keys[0]], 'family', 'Microsoft YaHei'),
    ...deck.format(0, [keys[0]], 'color', '#12abcd'),
    ...deck.format(0, [keys[0]], 'highlight', '#fff19a'),
    ...deck.format(0, [keys[0]], 'underline', true),
    ...deck.format(0, [first[2].key], 'alignment', 'ctr')
  ];
  deck.applyStyles(changes);
  const styles = deck.styleUpdates(changes);
  assert.equal(styles.find(item => item.key === first[0].key).style.alignment, 'ctr');
  assert.equal(styles.find(item => item.key === first[2].key).style.alignment, 'ctr');
  assert(deck.set(keys[1], 'New text in styled paragraph'));
  const actual = unzipSync(deck.serialize());
  const original = unzipSync(bytes);
  assert.deepEqual(actual['ppt/slides/slide1.xml'], original['ppt/slides/slide1.xml']);
  const slideXml = strFromU8(actual['ppt/slides/slide2.xml']);
  assert.match(slideXml, /<a:p><a:pPr algn="ctr"\/>/);
  assert.match(slideXml, /<a:rPr i="1" sz="2600" u="sng">/);
  assert.match(slideXml, /<a:solidFill><a:srgbClr val="12ABCD"\/><\/a:solidFill><a:highlight><a:srgbClr val="FFF19A"\/><\/a:highlight><a:latin typeface="Microsoft YaHei"\/><a:ea typeface="Microsoft YaHei"\/>/);
  assert.match(slideXml, /<a:rPr sz="2600"\/><a:t>New text in styled paragraph<\/a:t>/);
  const reopened = new Presentation(deck.serialize());
  assert.equal(reopened.slide(0).objects[0].paragraphs[0][0].style.color, '#12ABCD');
  assert.equal(reopened.slide(0).objects[0].paragraphs[0][2].style.alignment, 'ctr');
  deck.applyStyles([...changes].reverse(), true);
  assert(deck.set(keys[1], ''));
  assert.deepEqual(deck.serialize(), bytes);
});

test('heading shortcuts apply to the whole paragraph and toggle after reopening', () => {
  const bytes = fixture();
  const deck = new Presentation(bytes);
  const [paragraph] = deck.slide(0).objects[0].paragraphs;
  const key = paragraph[2].key;
  const styles = presentation => presentation.slide(0).objects[0].paragraphs
    .map(parts => parts.filter(part => part.key).map(({ style }) => [style.font, style.bold]));
  const initial = styles(deck);
  const levelOne = deck.format(0, [key], 'heading', 1);
  deck.applyStyles(levelOne);
  assert.deepEqual(styles(deck), [[[36, true], [36, true]], initial[1]]);
  deck.applyStyles(levelOne, true);
  assert.deepEqual(deck.serialize(), bytes);
  deck.applyStyles(levelOne);
  deck.applyStyles(deck.format(0, [key], 'heading', 2));
  const reopened = new Presentation(deck.serialize());
  assert.deepEqual(styles(reopened), [[[32, true], [32, true]], initial[1]]);
  reopened.applyStyles(reopened.format(0, [key], 'heading', 2));
  assert.deepEqual(styles(reopened), [[[18, false], [18, false]], initial[1]]);
  assert.deepEqual(reopened.format(0, [key], 'heading', 7), []);
});

test('inline edits preserve styled runs, save real line breaks and validate every field before applying', () => {
  const bytes = fixture();
  const deck = new Presentation(bytes);
  const [first, second] = deck.slide(0).objects[0].paragraphs;
  const edits = [
    { key: first[0].key, value: 'Title original\nSecond line' },
    { key: second[0].key, value: '下一行\n继续' }
  ];
  assert.equal(deck.textChanges(0, [...edits, { key: first[0].key, value: 'Duplicated' }]), undefined);
  assert.equal(deck.textChanges(1, edits), undefined);
  assert.equal(deck.textChanges(0, [edits[0], { ...edits[1], value: '\r' }]), undefined);
  assert.deepEqual(deck.serialize(), bytes);
  for (const { key, value } of deck.textChanges(0, edits)) assert(deck.set(key, value));
  const format = deck.format(0, [first[0].key], 'underline', true);
  deck.applyStyles(format);
  const updated = strFromU8(unzipSync(deck.serialize())['ppt/slides/slide2.xml']);
  assert.match(updated, /<a:rPr i="1" u="sng"\/><a:t> original<\/a:t><\/a:r><a:br><a:rPr i="1" u="sng"\/><\/a:br><a:r><a:rPr i="1" u="sng"\/><a:t>Second line<\/a:t>/);
  assert.match(updated, /<a:t>下一行<\/a:t><\/a:r><a:br\/><a:r><a:t>继续<\/a:t>/);
  const reopened = new Presentation(deck.serialize());
  assert.equal(reopened.slide(0).objects[0].paragraphs[0].map(part => part.value).join(''), 'Title original\nSecond line\nline 21');
  deck.applyStyles(format, true);
  const resets = deck.textChanges(0, [
    { key: first[0].key, value: 'Title original' }, { key: second[0].key, value: '' }
  ]);
  assert.equal(resets.length, 2);
  for (const { key, value } of resets) assert(deck.set(key, value));
  assert.deepEqual(deck.serialize(), bytes);
});
