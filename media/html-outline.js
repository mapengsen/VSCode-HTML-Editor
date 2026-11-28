'use strict';

function createHeadingOutline(panel, toggle, divider, depth, saveDepth) {
  const workspace = panel.parentElement;
  const list = panel.querySelector('#outline-entries');
  const empty = panel.querySelector('#outline-empty');
  const depthCaption = depth.parentElement.querySelector('.outline-depth-caption');
  const headingSelector = 'h1, h2, h3, h4, h5, h6';
  const collapsed = new WeakSet();
  let body;
  let entries = [];
  let activeHeading;
  let activeButton;
  let pendingFrame;
  let drag;

  function widthLimits() {
    const max = Math.floor(workspace.clientWidth * 0.65);
    return { min: Math.min(116, max), max };
  }

  function outlineWidth() {
    return Math.round(panel.getBoundingClientRect().width);
  }

  function updateDivider() {
    if (panel.hidden) return;
    const { min, max } = widthLimits();
    divider.setAttribute('aria-valuemin', String(min));
    divider.setAttribute('aria-valuemax', String(max));
    divider.setAttribute('aria-valuenow', String(outlineWidth()));
  }

  function resizeOutline(width) {
    const { min, max } = widthLimits();
    panel.style.setProperty('--outline-width', Math.max(min, Math.min(max, width)) + 'px');
    updateDivider();
  }

  function stopResize() {
    if (!drag) return;
    const { pointer } = drag;
    drag = undefined;
    workspace.classList.remove('resizing-outline');
    if (divider.hasPointerCapture(pointer)) divider.releasePointerCapture(pointer);
  }

  divider.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    divider.focus({ preventScroll: true });
    divider.setPointerCapture(event.pointerId);
    drag = { pointer: event.pointerId, start: event.clientX, width: outlineWidth() };
    workspace.classList.add('resizing-outline');
  });
  divider.addEventListener('pointermove', event => {
    if (drag?.pointer === event.pointerId) resizeOutline(drag.width + event.clientX - drag.start);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    divider.addEventListener(type, event => {
      if (drag?.pointer === event.pointerId) stopResize();
    });
  }
  divider.addEventListener('keydown', event => {
    const { min, max } = widthLimits();
    const width = outlineWidth();
    const targets = { ArrowLeft: width - 16, ArrowRight: width + 16, Home: min, End: max };
    if (!Object.hasOwn(targets, event.key)) return;
    event.preventDefault();
    resizeOutline(targets[event.key]);
  });
  new ResizeObserver(updateDivider).observe(workspace);

  function updateDepthCaption() {
    depthCaption.textContent = depth.selectedIndex === 0 ? 'All' : depth.selectedOptions[0].textContent;
  }
  updateDepthCaption();
  depth.addEventListener('change', () => {
    updateDepthCaption();
    refresh();
    saveDepth(Number(depth.value));
  });

  toggle.addEventListener('click', () => {
    stopResize();
    panel.hidden = !panel.hidden;
    divider.hidden = panel.hidden;
    const label = (panel.hidden ? 'Show' : 'Hide') + ' document outline';
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
    updateDivider();
  });

  function refresh() {
    const maxLevel = Number(depth.value);
    const headings = [...(body?.querySelectorAll(headingSelector) || [])].flatMap(element => {
      const level = Number(element.localName[1]);
      const label = element.textContent.replace(/\s+/g, ' ').trim();
      return level <= maxLevel && label && !element.closest('[hidden], [aria-hidden="true"]')
        ? [{ element, label, level, children: [] }]
        : [];
    });
    if (headings.length === entries.length && headings.every(({ element, label }, index) =>
      element === entries[index].element && label === entries[index].label)) return;

    entries = headings;
    if (!headings.some(({ element }) => element === activeHeading)) activeHeading = undefined;
    activeButton = undefined;
    const roots = [];
    const parents = [];
    for (const heading of headings) {
      while (parents.length && parents.at(-1).level >= heading.level) parents.pop();
      (parents.at(-1)?.children || roots).push(heading);
      parents.push(heading);
    }
    list.replaceChildren(...roots.map(renderHeading));
    empty.hidden = Boolean(headings.length);
  }

  function renderHeading({ element, label, children }) {
    const item = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'outline-row';
    item.append(row);

    if (children.length) {
      const sublist = document.createElement('ul');
      sublist.className = 'outline-list';
      sublist.append(...children.map(renderHeading));
      item.append(sublist);
      const expand = document.createElement('button');
      expand.type = 'button';
      expand.className = 'outline-expander';
      row.append(expand);
      function setExpanded(expanded) {
        if (expanded) collapsed.delete(element);
        else collapsed.add(element);
        sublist.hidden = !expanded;
        expand.setAttribute('aria-expanded', String(expanded));
        expand.setAttribute('aria-label', (expanded ? 'Collapse ' : 'Expand ') + label);
      }
      setExpanded(!collapsed.has(element));
      expand.addEventListener('click', () => setExpanded(sublist.hidden));
    }

    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'outline-link';
    link.textContent = link.title = label;
    if (activeHeading === element) {
      activeButton = link;
      link.setAttribute('aria-current', 'location');
    }
    link.addEventListener('click', () => {
      element.scrollIntoView({ block: 'start', inline: 'nearest' });
      activeHeading = element;
      activeButton?.removeAttribute('aria-current');
      activeButton = link;
      link.setAttribute('aria-current', 'location');
    });
    row.append(link);
    return item;
  }

  const observer = new MutationObserver(() => {
    if (pendingFrame !== undefined) return;
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = undefined;
      refresh();
    });
  });

  function attach(nextBody) {
    observer.disconnect();
    body = nextBody;
    if (body) observer.observe(body, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['hidden', 'aria-hidden']
    });
    refresh();
  }

  return { attach };
}
