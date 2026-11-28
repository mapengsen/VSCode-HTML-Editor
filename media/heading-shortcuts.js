'use strict';

function headingLevelForShortcut(event) {
  if (!event.ctrlKey || !event.altKey || event.shiftKey || event.metaKey ||
      event.isComposing || event.getModifierState('AltGraph')) return 0;
  const digit = /^(?:Digit|Numpad)([1-6])$/.exec(event.code)?.[1] ?? event.key;
  return /^[1-6]$/.test(digit) ? Number(digit) : 0;
}
