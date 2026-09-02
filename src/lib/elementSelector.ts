export const ELEMENT_SELECTOR_START_SCRIPT = `(() => {
  const KEY = '__codeMUXSelector';
  const existing = window[KEY];
  if (existing && typeof existing.stop === 'function') {
    existing.stop();
  }

  const overlay = document.createElement('div');
  overlay.setAttribute('data-codemux-selector', 'overlay');
  overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #3b82f6;background:rgba(59,130,246,0.08);display:none;';
  const tooltip = document.createElement('div');
  tooltip.setAttribute('data-codemux-selector', 'tooltip');
  tooltip.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;display:none;max-width:360px;padding:6px 8px;border-radius:6px;background:#18181b;color:#fafafa;font:12px/1.4 ui-sans-serif,system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,0.28);';
  document.documentElement.appendChild(overlay);
  document.documentElement.appendChild(tooltip);

  const state = {
    captured: null,
    cancelled: false,
    take() {
      const next = { captured: this.captured, cancelled: this.cancelled };
      this.captured = null;
      this.cancelled = false;
      return next;
    },
    stop() {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      tooltip.remove();
      window[KEY] = undefined;
    },
  };

  function cssPath(element) {
    if (element.id) return '#' + CSS.escape(element.id);
    const parts = [];
    let current = element;
    while (current && current.nodeType === 1 && parts.length < 5) {
      let part = current.tagName.toLowerCase();
      if (current.classList && current.classList.length > 0) {
        part += '.' + Array.from(current.classList).slice(0, 2).map((name) => CSS.escape(name)).join('.');
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
        if (siblings.length > 1) {
          part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
        }
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(' > ');
  }

  function describe(element) {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      tag: element.tagName.toLowerCase(),
      text: (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim(),
      selector: cssPath(element),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      color: style.color,
      font: (style.fontSize || '') + ' ' + (style.fontFamily || ''),
    };
  }

  function onMove(event) {
    const element = event.target;
    if (!(element instanceof Element) || element === overlay || element === tooltip) return;
    const rect = element.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.left = rect.left + 'px';
    overlay.style.top = rect.top + 'px';
    overlay.style.width = Math.max(rect.width, 0) + 'px';
    overlay.style.height = Math.max(rect.height, 0) + 'px';
    const info = describe(element);
    tooltip.style.display = 'block';
    tooltip.textContent = info.tag + '  ' + info.width + 'x' + info.height + '  ' + info.color + '  ' + info.font;
    const top = Math.max(8, rect.top - tooltip.offsetHeight - 8);
    tooltip.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - tooltip.offsetWidth - 8)) + 'px';
    tooltip.style.top = top + 'px';
  }

  function onClick(event) {
    event.preventDefault();
    event.stopPropagation();
    const element = event.target;
    if (!(element instanceof Element)) return;
    const info = describe(element);
    state.captured = {
      tag: info.tag,
      text: info.text,
      selector: info.selector,
      url: location.href,
      width: info.width,
      height: info.height,
      color: info.color,
      font: info.font,
    };
  }

  function onKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      state.cancelled = true;
    }
  }

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  window[KEY] = state;
  return true;
})()`;

export const ELEMENT_SELECTOR_STOP_SCRIPT = `(() => {
  if (window.__codeMUXSelector && typeof window.__codeMUXSelector.stop === 'function') {
    window.__codeMUXSelector.stop();
  }
  return true;
})()`;

export const ELEMENT_SELECTOR_POLL_SCRIPT = `(() => {
  if (!window.__codeMUXSelector || typeof window.__codeMUXSelector.take !== 'function') {
    return { captured: null, cancelled: false };
  }
  return window.__codeMUXSelector.take();
})()`;
