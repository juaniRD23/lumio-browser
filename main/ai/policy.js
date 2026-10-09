// Approval policy. Lumio AI works only in the browser's tabs. Risk levels:
//   read    — look only (read a page, list tabs, tab screenshot). Never asks.
//   browser — act inside a tab (click, type, navigate). Asks in Ask mode.
// Auto and Bypass both act in tabs without asking; Bypass stays so a setting
// saved (or synced) with it keeps working.
const MODES = ['ask', 'auto', 'bypass'];
const RISKS = ['read', 'browser'];

function needsApproval(risk, mode) {
  if (risk === 'read') return false;
  return mode !== 'auto' && mode !== 'bypass';
}

module.exports = { MODES, RISKS, needsApproval };
