'use strict';

function createParagraphInsert(button, canvas, paragraphAt, insertAfter) {
  let frame;
  let hover;
  let caret;
  let target;
  let hideTimer;
  let queued = false;

  function refresh() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      target = hover?.isConnected ? hover : caret;
      if (!frame || canvas.inert || !target?.isConnected || !target.isContentEditable) {
        button.hidden = true;
        return;
      }
      const outer = frame.getBoundingClientRect();
      const inner = target.getBoundingClientRect();
      const view = frame.contentWindow;
      const scale = Number(view.getComputedStyle(target.ownerDocument.documentElement).zoom) || 1;
      const x = inner.left * scale;
      const y = inner.top * scale;
      button.hidden = !inner.height || y < -1 || y >= frame.clientHeight || x >= frame.clientWidth || inner.right * scale <= 0;
      if (button.hidden) return;
      button.style.left = outer.left + frame.clientLeft + Math.max(0, x) - button.offsetWidth - 4 + 'px';
      button.style.top = outer.top + frame.clientTop + Math.max(0, y) + 'px';
    });
  }

  function leaveParagraph() {
    if (hideTimer !== undefined) return;
    hideTimer = setTimeout(() => {
      hideTimer = undefined;
      hover = undefined;
      refresh();
    }, 260);
  }

  function keepParagraph() {
    clearTimeout(hideTimer);
    hideTimer = undefined;
  }

  function attach(next) {
    keepParagraph();
    frame = next;
    hover = caret = target = undefined;
    button.hidden = true;
    if (!next) return;
    const page = next.contentDocument;
    const trackParagraph = event => {
      if (next !== frame) return;
      const paragraph = paragraphAt(event.target);
      if (!paragraph?.isContentEditable) {
        if (hover) leaveParagraph();
        return;
      }
      keepParagraph();
      if (hover === paragraph) return;
      hover = paragraph;
      refresh();
    };
    page.addEventListener('pointerover', trackParagraph);
    page.addEventListener('pointermove', trackParagraph);
    page.addEventListener('pointerout', event => {
      if (next === frame && !event.relatedTarget && hover) leaveParagraph();
    });
    page.addEventListener('scroll', refresh, true);
  }

  button.addEventListener('pointerenter', keepParagraph);
  button.addEventListener('pointerleave', leaveParagraph);
  button.addEventListener('mousedown', event => event.preventDefault());
  button.addEventListener('click', () => {
    if (!target?.isConnected || button.hidden) return;
    keepParagraph();
    hover = undefined;
    insertAfter(target);
    refresh();
  });
  new ResizeObserver(refresh).observe(canvas);

  return {
    attach,
    refresh,
    setCaret(block) {
      caret = block;
      refresh();
    }
  };
}
