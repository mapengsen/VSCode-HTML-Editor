const vscode = require('vscode');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { diffChars } = require('diff');
const { parseSource, escapeAttribute } = require('./html');
const { printDocument } = require('./print');
const { registerPowerPoint } = require('./powerpoint');
const defaultHtmlZoom = 85;
const defaultOutlineDepth = 3;
const outlineDepths = [6, 1, 2, 3, 4];
const outlineDepthKey = 'htmlDesign.outlineDepth';

function activate(context) {
  registerPowerPoint(context);
  context.subscriptions.push(vscode.window.registerCustomEditorProvider('fileEditor.html', {
    resolveCustomTextEditor(document, panel) {
      openDesign(context, document, panel);
    }
  }, { webviewOptions: { retainContextWhenHidden: true } }));
  const panels = new Map();
  context.subscriptions.push(vscode.commands.registerCommand('htmlDesign.open', async () => {
    const document = vscode.window.activeTextEditor?.document;
    if (document?.languageId !== 'html') {
      vscode.window.showInformationMessage('Open an HTML file to use Design View.');
      return;
    }
    const key = document.uri.toString();
    if (panels.has(key)) {
      panels.get(key).reveal();
      return;
    }
    const panel = openDesign(context, document);
    panels.set(key, panel);
    panel.onDidDispose(() => panels.delete(key));
    await vscode.commands.executeCommand('workbench.action.toggleMaximizeEditorGroup');
  }));
  context.subscriptions.push({ dispose: () => panels.forEach(panel => panel.dispose()) });
}

function openDesign(context, initialDocument, panel) {
  const uri = initialDocument.uri;
  const uriKey = uri.toString();
  const filename = path.posix.basename(uri.path) || initialDocument.fileName;
  const directory = initialDocument.isUntitled ? undefined : vscode.Uri.joinPath(uri, '..');
  const workspace = vscode.workspace.getWorkspaceFolder(uri)?.uri;
  const media = vscode.Uri.joinPath(context.extensionUri, 'media');
  const webviewOptions = { enableScripts: true, localResourceRoots: [media, directory, workspace].filter(Boolean) };
  if (panel) panel.webview.options = webviewOptions;
  else panel = vscode.window.createWebviewPanel('htmlDesign', 'Design · ' + filename, vscode.ViewColumn.Beside,
    { ...webviewOptions, retainContextWhenHidden: true });
  const webview = panel.webview;
  const baseUrl = directory ? webview.asWebviewUri(directory).toString().replace(/\/$/, '') + '/' : undefined;
  const documentUrl = directory ? webview.asWebviewUri(uri).toString() : undefined;
  const config = () => vscode.workspace.getConfiguration('htmlDesign', uri).get('syncDelay', 300);
  const post = message => webview.postMessage(message);
  let active = true;
  let expectedWrite = false;

  async function documentNow() {
    return vscode.workspace.textDocuments.find(item => item.uri.toString() === uriKey) ||
      vscode.workspace.openTextDocument(uri);
  }

  function sendDocument(document, type = 'snapshot', unchanged) {
    return post({
      type, version: document.version, html: parseSource(document.getText()),
      baseUrl, documentUrl, filename, unchanged, delay: config()
    });
  }

  const subscriptions = [
    vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.uri.toString() !== uriKey || !event.contentChanges.length) return;
      // A single workspace edit may emit intermediate document changes.
      if (expectedWrite) return;
      void sendDocument(event.document);
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('htmlDesign.syncDelay', uri)) void post({ type: 'config', delay: config() });
    }),
    webview.onDidReceiveMessage(async message => {
      try {
        if (message.type === 'ready' || message.type === 'reload') {
          await sendDocument(await documentNow(), message.type === 'reload' ? 'reload' : 'snapshot');
        } else if (message.type === 'edit') {
          await applyDesign(message);
        } else if (message.type === 'save') {
          const document = await documentNow();
          if (!document.isUntitled) await document.save();
          else await vscode.commands.executeCommand('workbench.action.files.save');
        } else if (message.type === 'print') {
          const document = await documentNow();
          await printDocument(document, workspace);
        } else if (message.type === 'fullscreen') {
          await vscode.commands.executeCommand('workbench.action.toggleMaximizeEditorGroup');
        } else if (message.type === 'outlineDepth' && outlineDepths.includes(message.depth)) {
          await context.globalState.update(outlineDepthKey, message.depth);
        }
      } catch (error) {
        if (!active) return;
        if (message.type === 'edit') void post({ type: 'retry' });
        void vscode.window.showErrorMessage('HTML Editor: ' + error.message);
      }
    })
  ];
  panel.onDidDispose(() => {
    active = false;
    subscriptions.forEach(item => item.dispose());
  });
  webview.html = shell(webview, media, context.globalState.get(outlineDepthKey, defaultOutlineDepth));
  return panel;

  function acknowledge(document, raw) {
    return raw ? sendDocument(document, 'ack') : post({ type: 'ack', version: document.version });
  }

  async function applyDesign(message) {
    if (expectedWrite || typeof message.body !== 'string') return;
    const document = await documentNow();
    if (message.version !== document.version) {
      await sendDocument(document, 'conflict');
      return;
    }
    const source = document.getText();
    const { start, end, bodySource } = parseSource(source);
    // VS Code stores text in the document's configured line ending.
    const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const body = message.body.replace(/\r\n|\r|\n/g, eol);
    if (body === bodySource) {
      await acknowledge(document, message.raw);
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    const changes = diffChars(bodySource, body, { timeout: 80 });
    let position = start;
    const cutsLineEnding = changes && changes.some(change => {
      if (!change.added) position += change.value.length;
      return source[position - 1] === '\r' && source[position] === '\n';
    });
    if (!changes || cutsLineEnding) {
      edit.replace(uri, new vscode.Range(document.positionAt(start), document.positionAt(end)), body);
    } else {
      let offset = start;
      let index = 0;
      // Group additions and deletions between unchanged spans into one edit.
      while (index < changes.length) {
        const change = changes[index];
        if (!change.added && !change.removed) {
          offset += change.value.length;
          index++;
          continue;
        }
        const from = offset;
        let replacement = '';
        while (index < changes.length && (changes[index].added || changes[index].removed)) {
          const part = changes[index++];
          if (part.removed) offset += part.value.length;
          else replacement += part.value;
        }
        edit.replace(uri, new vscode.Range(document.positionAt(from), document.positionAt(offset)), replacement);
      }
    }
    const expectedText = source.slice(0, start) + body + source.slice(end);
    expectedWrite = true;
    let applied;
    try {
      applied = await vscode.workspace.applyEdit(edit);
    } finally {
      expectedWrite = false;
    }
    if (!active) return;
    if (applied && document.getText() === expectedText) {
      await acknowledge(document, message.raw);
      return;
    }
    await sendDocument(document, 'conflict');
  }
}

function shell(webview, media, outlineDepth) {
  const nonce = randomBytes(18).toString('base64');
  const asset = filename => escapeAttribute(webview.asWebviewUri(vscode.Uri.joinPath(media, filename)).toString());
  const source = webview.cspSource;
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'nonce-' + nonce +
      '\'; style-src ' + source + ' \'unsafe-inline\' https: http: blob:; img-src ' + source +
      ' data: https: http: blob:; connect-src ' + source + '; font-src ' + source + ' data: blob: https: http:; media-src ' + source +
      ' https: http: data: blob:; frame-src about:; base-uri ' + source + ' https: http:;">',
    '<link rel="stylesheet" href="' + asset('design.css') + '"><title>HTML Design View</title></head>',
    '<body data-resource-origin="' + escapeAttribute(source) + '">',
    '<nav id="tools" aria-label="Formatting"><div class="tool-group">',
    '<button id="outline-toggle" type="button" aria-controls="outline" aria-expanded="true" aria-label="Hide document outline" title="Hide document outline">',
    '<span class="outline-icon" aria-hidden="true"></span></button>',
    '<label class="outline-depth-control" title="Filter outline by heading level">',
    '<span class="outline-depth-icon" aria-hidden="true"></span><span class="outline-depth-caption" aria-hidden="true"></span>',
    '<select id="outline-depth" aria-label="Highest heading level shown in the outline" aria-controls="outline">',
    ...outlineDepths.map((level, index) => '<option value="' + level + '"' + (level === outlineDepth ? ' selected' : '') + '>' +
      (index === 0 ? 'All headings' : 'H' + level) + '</option>'),
    '</select></label></div></nav>',
    '<aside id="conflict" hidden><span>The HTML source changed while you were editing. Copy your draft before reloading if you want to keep it.</span>',
    '<button id="copy" type="button">Copy draft</button><button id="reload" type="button">Reload source</button></aside>',
    '<div class="design-workspace">',
    '<nav id="outline" aria-label="Document outline">',
    '<div class="outline-scroll"><p id="outline-empty">No headings to show</p><ul id="outline-entries" class="outline-list"></ul></div></nav>',
    '<div id="outline-divider" role="separator" tabindex="0" aria-label="Outline width" aria-orientation="vertical" aria-controls="outline" title="Drag to resize the outline"></div>',
    '<main id="canvas" aria-label="Design canvas"></main></div>',
    '<footer><span id="filename"></span>',
    '<div class="document-status"><span id="breadcrumb" aria-label="Element path">body</span><span id="status" role="status">Loading…</span></div>',
    '<div class="zoom-controls" role="group" aria-label="Page zoom">',
    '<button id="zoom-out" type="button" aria-label="Zoom out">−</button>',
    '<input id="zoom-slider" type="range" min="50" max="300" value="' + defaultHtmlZoom + '" aria-label="Page zoom" aria-valuetext="' + defaultHtmlZoom + '%">',
    '<button id="zoom-in" type="button" aria-label="Zoom in">+</button>',
    '<input id="zoom-actual" type="text" inputmode="numeric" aria-label="Page zoom percentage" title="Enter a zoom percentage" value="' + defaultHtmlZoom + '%">',
    '<button id="zoom-reset" class="compact-tool" type="button" aria-label="Reset zoom to ' + defaultHtmlZoom + '%" title="Reset zoom to ' + defaultHtmlZoom + '%">↺</button></div>',
    '<div class="actions"><button id="source" type="button">HTML</button>',
    '<button id="fullscreen" type="button" title="Toggle between full screen and split view">Full screen</button><button id="print" type="button">Print / PDF</button></div></footer>',
    '<dialog id="dialog"><form method="dialog"><h2 id="dialog-title"></h2><div id="fields"></div>',
    '<div class="dialog-actions"><button value="cancel" formnovalidate>Cancel</button><button class="primary" value="apply">Apply</button></div>',
    '</form></dialog>',
    '<script nonce="' + nonce + '" src="' + asset('source-tree.js') + '"></script>',
    '<script nonce="' + nonce + '" src="' + asset('resources.js') + '"></script>',
    '<script nonce="' + nonce + '" src="' + asset('heading-shortcuts.js') + '"></script>',
    '<script nonce="' + nonce + '" src="' + asset('html-outline.js') + '"></script>',
    '<script nonce="' + nonce + '" src="' + asset('design.js') + '"></script></body></html>'
  ].join('\n');
}

exports.activate = activate;


