const vscode = require('vscode');
const { createHash, randomBytes } = require('node:crypto');
const fs = require('node:fs/promises');
const { Presentation } = require('./pptx');

const viewType = 'fileEditor.powerpoint';
const backupPrefix = 'PPTX EDITOR BACKUP 1\n';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function openDeck(bytes) {
  try {
    return new Presentation(bytes);
  } catch (error) {
    throw new Error('Unable to open this .pptx file. ' + error.message);
  }
}

function registerPowerPoint(context) {
  const provider = new PowerPointProvider(context.extensionUri);
  context.subscriptions.push(provider, vscode.window.registerCustomEditorProvider(viewType, provider));
  context.subscriptions.push(vscode.commands.registerCommand('fileEditor.openPowerPoint', async resource => {
    const active = resource || vscode.window.tabGroups.activeTabGroup.activeTab?.input?.uri;
    const [uri] = active && /\.pptx$/i.test(active.path) ? [active] : await vscode.window.showOpenDialog({
      canSelectMany: false, filters: { 'PowerPoint presentations': ['pptx'] }
    }) || [];
    if (uri) await vscode.commands.executeCommand('vscode.openWith', uri, viewType);
  }));
}

class PowerPointProvider {
  constructor(extensionUri) {
    this.media = vscode.Uri.joinPath(extensionUri, 'media');
    this.events = new vscode.EventEmitter();
    this.onDidChangeCustomDocument = this.events.event;
    this.views = new Map();
  }

  dispose() {
    this.events.dispose();
  }

  async openCustomDocument(uri, context) {
    let bytes;
    let diskHash;
    if (context.backupId) {
      const backup = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.parse(context.backupId)));
      const headerLength = backupPrefix.length + 65;
      const header = backup.subarray(0, headerLength).toString('ascii');
      if (!header.startsWith(backupPrefix) || !/^[a-f0-9]{64}\n$/.test(header.slice(backupPrefix.length))) {
        throw new Error('The PowerPoint recovery copy is invalid.');
      }
      diskHash = header.slice(backupPrefix.length, -1);
      bytes = backup.subarray(headerLength);
    } else {
      bytes = await vscode.workspace.fs.readFile(uri);
      diskHash = hash(bytes);
    }
    const presentation = openDeck(bytes);
    return { uri, presentation, diskHash, saving: Promise.resolve(), dispose() {} };
  }

  resolveCustomEditor(document, panel) {
    const view = { panel, slide: 0, thumbnails: new Set() };
    this.views.set(document, view);
    panel.webview.options = { enableScripts: true, localResourceRoots: [this.media] };
    const listener = panel.webview.onDidReceiveMessage(async message => {
      try {
        if (message.type === 'ready') this.sendSlide(document, view, true);
        else if (message.type === 'slide' && Number.isInteger(message.index) &&
                 message.index >= 0 && message.index < document.presentation.slides.length) {
          view.slide = message.index;
          this.sendSlide(document, view);
        } else if (message.type === 'edit') {
          this.edit(document, view, message.edits);
        } else if (message.type === 'format') {
          this.format(document, view, message);
        } else if (message.type === 'insert') {
          this.insert(document, view, message);
        } else if (message.type === 'deleteObjects') {
          this.deleteObjects(document, view, message);
        } else if (message.type === 'thumbnails' && Array.isArray(message.indices)) {
          for (const index of message.indices.slice(0, 40)) this.sendThumbnail(document, view, index);
        } else if (message.type === 'save') {
          await vscode.commands.executeCommand('workbench.action.files.save');
        } else if (message.type === 'undo' || message.type === 'redo') {
          await vscode.commands.executeCommand(message.type);
        }
      } catch (error) {
        void panel.webview.postMessage({ type: 'error', message: error.message });
      }
    });
    panel.onDidDispose(() => {
      listener.dispose();
      this.views.delete(document);
    });
    panel.webview.html = webviewHtml(panel.webview, this.media);
  }

  sendSlide(document, view, resetThumbnails = false, selection) {
    const deck = document.presentation;
    view.slide = Math.min(view.slide, Math.max(0, deck.slides.length - 1));
    if (resetThumbnails) view.thumbnails.clear();
    void view.panel.webview.postMessage({ type: 'render', slide: deck.slide(view.slide) || null, resetThumbnails, selection });
  }

  insert(document, view, { index, kind, area }) {
    if (index !== view.slide) return;
    const deck = document.presentation;
    const insertion = deck.prepareInsertion(index, kind, area);
    if (!insertion) return;
    const apply = (added, focus = false) => {
      deck.applyInsertion(insertion, added);
      const current = this.views.get(document);
      if (!current) return;
      if (current.slide === index) {
        this.sendSlide(document, current, false, added ? { id: insertion.object.id, focus } : undefined);
      } else if (current.thumbnails.has(index)) this.sendThumbnail(document, current, index);
    };
    apply(true, kind === 'text');
    this.events.fire({
      document, label: kind === 'text' ? 'Insert text box' : 'Insert shape',
      undo: () => apply(false), redo: () => apply(true)
    });
  }

  deleteObjects(document, view, { index, ids }) {
    if (index !== view.slide) return;
    const deck = document.presentation;
    const deletion = deck.prepareDeletion(index, ids);
    if (!deletion) return;
    const apply = removed => {
      deck.applyDeletion(deletion, removed);
      const current = this.views.get(document);
      if (!current) return;
      if (current.slide === index) {
        this.sendSlide(document, current, false, { objectIds: removed ? [] : deletion.objects.map(object => object.id) });
      } else if (current.thumbnails.has(index)) this.sendThumbnail(document, current, index);
    };
    apply(true);
    this.events.fire({
      document, label: 'Delete PowerPoint objects', undo: () => apply(false), redo: () => apply(true)
    });
  }

  sendThumbnail(document, view, index) {
    let slide;
    try {
      slide = document.presentation.slide(index, true);
    } catch {
      // Leave the numbered placeholder visible for slides that cannot be previewed.
    }
    if (!slide) return;
    view.thumbnails.add(index);
    void view.panel.webview.postMessage({ type: 'thumbnail', slide });
  }

  format(document, view, { keys, property, value }) {
    const deck = document.presentation;
    const index = view.slide;
    const changes = deck.format(index, keys, property, value);
    if (!changes.length) return;
    const apply = undo => {
      deck.applyStyles(changes, undo);
      const current = this.views.get(document);
      if (!current) return;
      if (current.slide === index) {
        void current.panel.webview.postMessage({ type: 'styles', fields: deck.styleUpdates(changes) });
      }
      else if (current.thumbnails.has(index)) this.sendThumbnail(document, current, index);
    };
    apply(false);
    this.events.fire({
      document, label: 'Format PowerPoint text', undo: () => apply(true), redo: () => apply(false)
    });
  }

  edit(document, view, edits) {
    const deck = document.presentation;
    const index = view.slide;
    const changes = deck.textChanges(index, edits);
    if (!changes) {
      this.sendSlide(document, view);
      throw new Error('This text field contains unsupported characters or is too long.');
    }
    if (!changes.length) return;
    for (const { key, value } of changes) deck.set(key, value);
    const apply = undo => {
      const values = changes.map(({ key, value, previous }) => ({ key, value: undo ? previous : value }));
      for (const { key, value } of values) deck.set(key, value);
      const current = this.views.get(document);
      if (!current) return;
      if (current.slide === index) void current.panel.webview.postMessage({ type: 'values', values });
      else if (current.thumbnails.has(index)) this.sendThumbnail(document, current, index);
    };
    this.events.fire({
      document, label: 'Edit PowerPoint text',
      undo: () => apply(true), redo: () => apply(false)
    });
  }

  saveCustomDocument(document, token) {
    return this.write(document, document.uri, token, true);
  }

  saveCustomDocumentAs(document, target, token) {
    return this.write(document, target, token, document.uri.toString() === target.toString());
  }

  write(document, target, token, sameFile) {
    const bytes = document.presentation.serialize();
    const save = document.saving.then(async () => {
      const verify = async () => {
        if (token.isCancellationRequested) throw new vscode.CancellationError();
        if (sameFile && hash(await vscode.workspace.fs.readFile(target)) !== document.diskHash) {
          throw new Error('The PowerPoint file changed on disk. Use Save As to keep your edits in a separate file.');
        }
      };
      if (target.scheme === 'file') await replaceFile(target.fsPath, bytes, verify);
      else {
        await verify();
        await vscode.workspace.fs.writeFile(target, bytes);
      }
      if (sameFile) document.diskHash = hash(bytes);
    });
    document.saving = save.catch(() => {});
    return save;
  }

  async revertCustomDocument(document) {
    await document.saving;
    const bytes = await vscode.workspace.fs.readFile(document.uri);
    document.presentation = openDeck(bytes);
    document.diskHash = hash(bytes);
    const view = this.views.get(document);
    if (view) this.sendSlide(document, view, true);
  }

  async backupCustomDocument(document, context, token) {
    const destination = context.destination;
    await document.saving;
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    const header = Buffer.from(backupPrefix + document.diskHash + '\n', 'ascii');
    await vscode.workspace.fs.writeFile(destination, Buffer.concat([header, document.presentation.serialize()]));
    return {
      id: destination.toString(),
      delete: () => { void vscode.workspace.fs.delete(destination).catch(() => {}); }
    };
  }
}

async function replaceFile(filename, bytes, verify) {
  let target = filename;
  let mode;
  try {
    target = await fs.realpath(filename);
    mode = (await fs.stat(target)).mode & 0o777;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = target + '.file-editor-' + randomBytes(8).toString('hex') + '.tmp';
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode });
    if (mode !== undefined && process.platform !== 'win32') await fs.chmod(temporary, mode);
    await verify();
    await fs.rename(temporary, target);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

function webviewHtml(webview, media) {
  const nonce = randomBytes(18).toString('base64');
  const asset = name => webview.asWebviewUri(vscode.Uri.joinPath(media, name)).toString();
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'nonce-' + nonce +
      '\'; style-src ' + webview.cspSource + ' \'unsafe-inline\'; img-src data:;">',
    '<link rel="stylesheet" href="' + asset('powerpoint.css') + '"><title>PowerPoint Editor</title></head>',
    '<body><header><div class="tool-group"><button id="undo" title="Undo" aria-label="Undo" type="button">↶</button>',
    '<button id="redo" title="Redo" aria-label="Redo" type="button">↷</button>',
    '<select id="insert" aria-label="Insert shape or text box" disabled><option value="">Insert</option>',
    '<option value="text">Text box</option><option value="rect">Rectangle</option><option value="roundRect">Rounded rectangle</option>',
    '<option value="circle">Circle</option><option value="ellipse">Oval</option><option value="triangle">Triangle</option>',
    '<option value="diamond">Diamond</option><option value="rightArrow">Right arrow</option></select>',
    '<button id="select-objects" title="Select slide objects" aria-pressed="false" type="button" disabled>Select</button>',
    '<button id="delete-objects" title="Delete selected objects" type="button" hidden>Delete</button>',
    '</div><nav id="formatting" aria-label="Text formatting">',
    '<div class="tool-group"><select id="family" aria-label="Font family"></select>',
    '<input id="font" type="number" inputmode="decimal" min="1" max="400" step="any" placeholder="Size" title="Font size in points" aria-label="Font size in points">',
    '<button id="font-grow" aria-label="Increase font size" title="Increase font size" type="button">A+</button>',
    '<button id="font-shrink" aria-label="Decrease font size" title="Decrease font size" type="button">A−</button></div>',
    '<div class="tool-group"><button data-mark="bold" aria-label="Bold" title="Bold" type="button"><b>B</b></button>',
    '<button data-mark="italic" aria-label="Italic" title="Italic" type="button"><i>I</i></button>',
    '<button data-mark="underline" aria-label="Underline" title="Underline" type="button"><u>U</u></button>',
    '<button data-mark="strike" aria-label="Strikethrough" title="Strikethrough" type="button"><s>S</s></button>',
    '<select id="baseline" aria-label="Superscript and subscript"><option value="normal">Baseline</option>',
    '<option value="super">Superscript</option><option value="sub">Subscript</option></select></div>',
    '<div class="tool-group"><label for="color" class="color"><span>Text color</span><input id="color" type="color"></label>',
    '<label for="highlight" class="color"><span>Highlight</span><input id="highlight" type="color"></label>',
    '<select id="alignment" aria-label="Paragraph alignment"><option value="">Align</option><option value="l">Left</option>',
    '<option value="ctr">Center</option><option value="r">Right</option><option value="just">Justify</option></select></div>',
    '<div class="tool-group"><select id="list" aria-label="List style"><option value="">List</option>',
    '<option value="none">No list</option><option value="bullet">Bullets</option><option value="number">Numbering</option></select>',
    '<button id="indent-out" aria-label="Decrease indent" title="Decrease indent" type="button">⇤</button>',
    '<button id="indent-in" aria-label="Increase indent" title="Increase indent" type="button">⇥</button>',
    '<select id="spacing" aria-label="Line spacing"><option value="">Spacing</option><option value="1">1.0</option>',
    '<option value="1.15">1.15</option><option value="1.5">1.5</option><option value="2">2.0</option></select></div></nav>',
    '<div class="actions"><button id="show-text" type="button" aria-expanded="false" aria-controls="inspector">Edit text</button>',
    '<button id="save" class="primary" type="button">Save</button></div></header>',
    '<p id="message" role="status">Loading presentation…</p>',
    '<main id="editor" hidden><nav id="navigator" aria-label="Slides">',
    '<div class="slide-controls"><button id="previous" type="button" aria-label="Previous slide">‹</button>',
    '<span id="slide-count" aria-live="polite"></span><button id="next" type="button" aria-label="Next slide">›</button></div>',
    '<ol id="thumbnails"></ol></nav><div id="stage"><div id="stage-surface"><div id="slide" tabindex="-1" aria-label="Slide preview"></div></div></div>',
    '<aside id="inspector" hidden><label for="objects">Text object</label><select id="objects"></select><div id="fields"></div></aside>',
    '<aside id="object-panel" aria-label="Slide objects" hidden><div class="object-panel-heading"><h2>Objects</h2>',
    '<span id="selection-count" aria-live="polite"></span></div><div id="object-options"></div></aside></main>',
    '<footer id="zoom-controls" aria-label="Slide zoom" hidden>',
    '<button id="zoom-fit" title="Fit slide to window" type="button">Fit</button>',
    '<button id="zoom-actual" title="Reset to 100%" type="button">100%</button>',
    '<button id="zoom-out" aria-label="Zoom out" title="Zoom out" type="button">−</button>',
    '<input id="zoom-slider" aria-label="Zoom percentage" type="range" min="10" max="400" value="100">',
    '<button id="zoom-in" aria-label="Zoom in" title="Zoom in" type="button">+</button></footer>',
    '<script nonce="' + nonce + '" src="' + asset('powerpoint-inline.js') + '"></script>',
    '<script nonce="' + nonce + '" src="' + asset('heading-shortcuts.js') + '"></script>',
    '<script nonce="' + nonce + '" src="' + asset('powerpoint.js') + '"></script></body></html>'
  ].join('\n');
}

module.exports = { registerPowerPoint };
