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
