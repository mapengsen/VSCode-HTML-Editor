'use strict';

// Keep browser selection and IME behavior while mapping edits back to DrawingML text.
function createInlineEditor(canvas, actions) {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const selector = '[data-inline-editor]';
  let remembered;
  let composition;
  let nativeEdit;

  function hostOf(node) {
    const host = (node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement)?.closest(selector);
    return host && canvas.contains(host) ? host : undefined;
  }

  function spans(host) {
    return [...host.querySelectorAll('[data-text-key]')];
  }

  function point(host, elements, node, offset, forward) {
    if (!host.contains(node)) return undefined;
    const containing = elements.findIndex(span => span.contains(node));
    if (containing !== -1) {
      const prefix = document.createRange();
      prefix.selectNodeContents(elements[containing]);
      prefix.setEnd(node, offset);
      return { index: containing, offset: prefix.toString().length };
    }
    for (const [index, span] of elements.entries()) {
      const bounds = document.createRange();
      bounds.selectNodeContents(span);
      if (bounds.comparePoint(node, offset) <= 0) {
        return forward || index === 0
          ? { index, offset: 0 }
          : { index: index - 1, offset: elements[index - 1].textContent.length };
      }
    }
    const index = elements.length - 1;
    return { index, offset: elements[index].textContent.length };
  }

  function read(host, range) {
    if (!host || !range) return undefined;
    const elements = spans(host);
    if (!elements.length) return undefined;
    const collapsed = range.startContainer === range.endContainer && range.startOffset === range.endOffset;
    const start = point(host, elements, range.startContainer, range.startOffset, true);
    const end = collapsed ? start : point(host, elements, range.endContainer, range.endOffset, false);
    if (!start || !end) return undefined;
    const keys = elements.map(span => span.dataset.textKey);
    return {
      host,
      start: { key: keys[start.index], offset: start.offset },
      end: { key: keys[end.index], offset: end.offset },
      keys: keys.slice(start.index, end.index + 1)
    };
  }

  function live(host = hostOf(document.activeElement), range) {
    const selection = document.getSelection();
    return read(host, range || (selection.rangeCount ? selection.getRangeAt(0) : undefined));
  }

  function restore(saved, focus = false) {
    if (!saved?.host.isConnected) return;
    const { host } = saved;
    if (focus) host.focus({ preventScroll: true });
    if (document.activeElement !== host) return;
    const elements = spans(host);
    const endpoint = ({ key, offset }) => {
      const span = elements.find(item => item.dataset.textKey === key);
      if (!span) return undefined;
      const text = span.firstChild;
      return text?.nodeType === Node.TEXT_NODE ? [text, Math.min(offset, text.length)] : [span, 0];
    };
    const start = endpoint(saved.start);
    const end = endpoint(saved.end);
    if (!start || !end) return;
    const range = document.createRange();
    range.setStart(...start);
    range.setEnd(...end);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    remembered = live(host);
  }

  function notify(host = hostOf(document.activeElement)) {
    if (!host || composition) return;
    const selection = live(host);
    if (selection) remembered = selection;
    actions.select(host, selection?.keys || []);
  }

  function replace(range, raw) {
    if (!range || !range.keys.length) return false;
    const { host, start, end } = range;
    const text = raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\ud800-\udfff\ufffe\uffff]/gu, '');
    const edits = range.keys.map(key => {
      const value = actions.value(key);
      if (key === start.key) {
        const suffix = start.key === end.key ? value.slice(end.offset) : '';
        return { key, value: value.slice(0, start.offset) + text + suffix };
      }
      return { key, value: key === end.key ? value.slice(end.offset) : '' };
    });
    const caret = { key: start.key, offset: start.offset + text.length };
    const next = { host, start: caret, end: caret };
    if (edits.some(edit => edit.value.length > 100000)) {
      actions.error('This text field is limited to 100,000 characters.');
      actions.repaint(host, range);
      return false;
    }
    actions.edit(host, edits, next);
    notify(host);
    return true;
  }

  function expandDelete(range, backward) {
    if (range.start.key !== range.end.key || range.start.offset !== range.end.offset) return range;
    const value = actions.value(range.start.key);
    const offset = range.start.offset;
    if (!value || (backward ? offset === 0 : offset >= value.length)) return range;
    const segment = segmenter.segment(value).containing(backward ? offset - 1 : offset);
    return {
      ...range,
      start: { ...range.start, offset: segment.index },
      end: { ...range.end, offset: segment.index + segment.segment.length }
    };
  }

  const formatTypes = { formatBold: 'bold', formatItalic: 'italic', formatUnderline: 'underline', formatStrikeThrough: 'strike' };
  document.addEventListener('selectionchange', () => notify());
  canvas.addEventListener('focusin', event => notify(hostOf(event.target)));
  canvas.addEventListener('click', event => {
    const host = hostOf(event.target);
    if (host) notify(host);
    else actions.deselect();
  });

  canvas.addEventListener('beforeinput', event => {
    const host = hostOf(event.target);
    if (!host || composition || event.isComposing) return;
    const type = event.inputType;
    if (type === 'historyUndo' || type === 'historyRedo') {
      event.preventDefault();
      actions.history(type === 'historyUndo' ? 'undo' : 'redo');
      return;
    }
    if (formatTypes[type]) {
      event.preventDefault();
      actions.mark(formatTypes[type]);
      return;
    }
    let range = live(host, event.getTargetRanges()[0]) || live(host);
    if (range && ['deleteContentBackward', 'deleteContentForward'].includes(type)) {
      range = expandDelete(range, type === 'deleteContentBackward');
    }
    const text = type === 'insertParagraph' || type === 'insertLineBreak' ? '\n' :
      type.startsWith('delete') ? '' : event.data ?? event.dataTransfer?.getData('text/plain');
    if (event.cancelable) {
      event.preventDefault();
      if (typeof text === 'string') replace(range, text);
    } else {
      nativeEdit = { host, range, text };
    }
  });

  canvas.addEventListener('input', event => {
    const host = hostOf(event.target);
    if (!host || composition || event.isComposing) return;
    const pending = nativeEdit;
    nativeEdit = undefined;
    if (pending?.host === host && typeof pending.text === 'string') replace(pending.range, pending.text);
    else actions.repaint(host, remembered);
  });

  canvas.addEventListener('paste', event => {
    const host = hostOf(event.target);
    if (!host || !event.clipboardData) return;
    event.preventDefault();
    const text = event.clipboardData.getData('text/plain');
    if (text) replace(live(host), text);
  });
  canvas.addEventListener('drop', event => {
    if (hostOf(event.target)) event.preventDefault();
  });

  canvas.addEventListener('compositionstart', event => {
    const host = hostOf(event.target);
    if (host) composition = { host, range: live(host) };
  });
  canvas.addEventListener('compositionend', event => {
    const session = composition;
    composition = undefined;
    if (!session) return;
    if (!event.data || !replace(session.range, event.data)) actions.repaint(session.host, session.range);
  });

  canvas.addEventListener('keydown', event => {
    const host = hostOf(event.target);
    if (!host || event.isComposing || composition || event.altKey) return;
    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      replace(live(host), '\n');
      return;
    }
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    const mark = { b: 'bold', i: 'italic', u: 'underline' }[key];
    if (mark || key === 'z' || key === 'y') {
      event.preventDefault();
      event.stopPropagation();
      if (mark) actions.mark(mark);
      else actions.history(key === 'y' || event.shiftKey ? 'redo' : 'undo');
    }
  });

  return {
    current: () => live(),
    remembered: () => remembered,
    composing: () => composition?.host,
    restore,
    clear() { remembered = composition = nativeEdit = undefined; }
  };
}
