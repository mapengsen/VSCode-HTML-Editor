const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSource } = require('../src/html');

test('document closing tags and trailing CRLF stay outside the editable source', () => {
  const source = "<!DOCTYPE html>\r\n<html><head><title>T</title></head><body id='page'>\r\n<p>A &amp; B</p>\r\n</body>\r\n</html>\r\n";
  const snapshot = parseSource(source);
  assert.equal(snapshot.bodySource, '\r\n<p>A &amp; B</p>\r\n');
  assert.equal(source.slice(snapshot.end), '</body>\r\n</html>\r\n');
  assert.equal(snapshot.tree.children.at(-1).raw, '\r\n');
  assert.equal(snapshot.bodyHtml, '\n<p>A &amp; B</p>\n');
});

test('an implicit body has a writable region before the closing HTML tag', () => {
  const source = '<!doctype html><html><title>T</title><p>Text</p></html>\n';
  const snapshot = parseSource(source);
  assert.equal(snapshot.bodySource, '<p>Text</p>');
  assert.equal(source.slice(snapshot.end), '</html>\n');
});

test('a fragment preserves source-only formatting and implied table elements', () => {
  const source = "<table class='data'><tr><td>1</td></tr></table>";
  const snapshot = parseSource(source);
  const [table] = snapshot.tree.children;
  assert.equal(snapshot.bodySource, source);
  assert.equal(table.open, "<table class='data'>");
  assert.equal(table.children[0].tag, 'tbody');
  assert.equal(table.children[0].open, '');
  assert.equal(table.children[0].raw, '<tr><td>1</td></tr>');
});

