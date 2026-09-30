// The scripted replies used to take the website's screenshots: the real Lumio
// agent drives the real browser against the stand-in Lumio server
// (tests/mock-lumio.mjs); only the model's words are scripted. Scenarios:
// booking a table (osteria.html) and a summary (article.html).
const textOf = (m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n') : m.content || '');
const ref = (snap, re) => { const l = snap.split('\n').find((x) => re.test(x)); return l ? Number(l.match(/^\[(\d+)\]/)?.[1]) : null; };

// Same turn shape as tests/mock-scripts.mjs: { text } or { lead, calls }.
export function demoTurn(msgs) {
  let last = -1;
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user' && !/^Screenshot\(s\)/.test(textOf(msgs[i]))) { last = i; break; }
  const ask = textOf(msgs[last] || {}).toLowerCase();
  const after = msgs.slice(last + 1);
  const step = after.filter((m) => m.role === 'assistant').length;
  const snap = [...after].reverse().find((m) => m.role === 'tool' && /^Tab \d+:/.test(m.content))?.content || '';
  if (ask.includes('book')) {
    const plan = (a, b, c) => ({ name: 'update_plan', args: { steps: [{ title: 'Read the reservation form', status: a }, { title: 'Fill in your details', status: b }, { title: 'Reserve the table', status: c }] } });
    if (step === 0) return { lead: 'On it. I’ll fill in the reservation form for you.', calls: [plan('in_progress', 'pending', 'pending'), { name: 'read_page' }] };
    if (step === 1) {
      return { calls: [
        plan('done', 'in_progress', 'pending'),
        { name: 'type', args: { ref: ref(snap, /textbox "Your name"/), text: 'Sam Rivera' } },
        { name: 'type', args: { ref: ref(snap, /textbox "Email"/), text: 'sam@example.com' } },
        { name: 'select_option', args: { ref: ref(snap, /select "Party size"/), value: '2 guests' } },
        { name: 'select_option', args: { ref: ref(snap, /select "Time"/), value: '8:00 PM' } },
      ] };
    }
    if (step === 2) return { calls: [plan('done', 'done', 'in_progress'), { name: 'click', args: { ref: ref(snap, /button "Reserve table"/) } }] };
    if (step === 3) return { calls: [plan('done', 'done', 'done'), { name: 'read_page', args: { include_text: true } }] };
    return { text: 'Done! Your **table for 2 at 8:00 PM** tonight at Osteria Luna is booked under Sam Rivera.\n\n- Confirmation: **LUNA-2841**\n- They hold tables for **15 minutes**, so aim to arrive on time.' };
  }
  if (ask.includes('summar')) {
    return { text: '**Night skies are brightening about 10% a year**, much faster than satellites showed.\n\n- **Why:** blue-rich LED street lights scatter more and are hard for satellites to see.\n- **Effects:** lost migrating birds, fewer pollinating insects, worse human sleep.\n- **Fixes:** shielded, warmer, dimmer lights. Towns that did it saved money and got their stars back.' };
  }
  return { text: 'Happy to help. What would you like me to do?' };
}
