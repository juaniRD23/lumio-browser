// Approval policy. Risk levels:
//   read    — look only (read a page, list tabs, tab screenshot). Never asks.
//   browser — act inside a tab (click, type, navigate). Asks in Ask mode.
//   mac     — control the Mac (mouse, keyboard, apps, screen). Asks in Ask + Auto.
//   shell   — shell commands and AppleScript. Asks unless Bypass.
const MODES = ['ask', 'auto', 'bypass'];
const RISKS = ['read', 'browser', 'mac', 'shell'];

function needsApproval(risk, mode) {
  if (risk === 'read') return false;
  if (mode === 'bypass') return false;
  if (mode === 'auto') return risk === 'mac' || risk === 'shell';
  return true;
}

module.exports = { MODES, RISKS, needsApproval };
