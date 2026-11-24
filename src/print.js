const vscode = require('vscode');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const parse5 = require('parse5');

const assetTypes = new Map(Object.entries({
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.avif': 'image/avif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.wav': 'audio/wav'
}));

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function appendMarkup(node, markup, index) {
  const children = parse5.parseFragment(node, markup).childNodes;
  for (const child of children) child.parentNode = node;
  node.childNodes.splice(index, 0, ...children);
  return children[0];
}

function preparePrint(source, base, nonce) {
  const document = parse5.parse(source);
  const html = document.childNodes.find(node => node.tagName === 'html');
  const head = html.childNodes.find(node => node.tagName === 'head');
  const body = html.childNodes.find(node => node.tagName === 'body');
  const authorBase = head.childNodes.find(node => node.tagName === 'base' && node.attrs.some(attr => attr.name === 'href'));
  const originalHref = authorBase?.attrs.find(attr => attr.name === 'href').value;
  head.childNodes = head.childNodes.filter(node =>
    node.tagName !== 'base' && !(node.tagName === 'meta' && node.attrs.some(attr => attr.name === 'http-equiv'))
  );
  const baseTag = appendMarkup(head, '<base>', 0);
  baseTag.attrs.push({ name: 'href', value: base });
  if (originalHref) {
    try {
      const placeholder = 'http://html-editor.invalid/';
      const resolved = new URL(originalHref, new URL(base, placeholder));
      if (resolved.origin === new URL(placeholder).origin) {
        baseTag.attrs[0].value = resolved.pathname + resolved.search;
      } else if (['http:', 'https:'].includes(resolved.protocol)) {
        baseTag.attrs[0].value = resolved.href;
      }
    } catch {
      // Keep the document directory when the source has an invalid base URL.
    }
  }
  const script = '<script nonce="' + nonce + '">' +
    'window.addEventListener("load", async () => { await document.fonts.ready; window.print(); });' +
    '</script>';
  appendMarkup(body, script, body.childNodes.length);
  return parse5.serialize(document);
}

async function printDocument(document, workspace) {
  const filename = document.isUntitled ? undefined : document.uri.fsPath;
  const directory = filename && path.dirname(filename);
  const folder = workspace?.fsPath;
  const assetRoot = directory && folder && isInside(folder, directory) ? folder : directory;
  const root = assetRoot && await fs.realpath(assetRoot);
  const relative = filename ? path.relative(assetRoot, filename) : 'untitled.html';
  const documentPath = relative.split(path.sep).map(encodeURIComponent).join('/');
  const token = randomBytes(24).toString('hex');
  const nonce = randomBytes(18).toString('base64');
  const prefix = '/' + token;
  const base = prefix + '/assets/' + documentPath;
  const printable = preparePrint(document.getText(), base, nonce);
  const policy = [
    "default-src 'none'", "script-src 'nonce-" + nonce + "'", "style-src 'self' 'unsafe-inline' https: http:",
    "img-src 'self' https: http: data:", "font-src 'self' https: http: data:",
    "media-src 'self' https: http: data:", "form-action 'none'", "frame-ancestors 'none'"
  ].join('; ');

  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method !== 'GET') {
        response.writeHead(405).end();
      } else if (url.pathname === prefix + '/print') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': policy });
        response.end(printable);
      } else if (root && url.pathname.startsWith(prefix + '/assets/')) {
        const name = decodeURIComponent(url.pathname.slice((prefix + '/assets/').length));
        const target = path.resolve(root, name);
        const type = assetTypes.get(path.extname(target).toLowerCase());
        if (!type || !isInside(root, target)) {
          response.writeHead(404).end();
          return;
        }
        const realTarget = await fs.realpath(target);
        if (!isInside(root, realTarget) || !(await fs.stat(realTarget)).isFile()) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, { 'Content-Type': type });
        response.end(await fs.readFile(realTarget));
      } else {
        response.writeHead(404).end();
      }
    } catch {
      if (!response.headersSent) response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  server.unref();
  const expiry = setTimeout(() => server.close(), 30 * 60 * 1000);
  expiry.unref();
  try {
    const local = vscode.Uri.parse('http://127.0.0.1:' + server.address().port + prefix + '/print');
    const external = await vscode.env.asExternalUri(local);
    if (!(await vscode.env.openExternal(external))) throw new Error('Could not open the print page in your browser.');
  } catch (error) {
    clearTimeout(expiry);
    server.close();
    throw error;
  }
}

module.exports = { printDocument };

