// Lumio's emails: the 6-digit codes for email + password sign-in
// (email-auth.ts), sent through Resend (RESEND_API_KEY, from EMAIL_FROM). The
// only thing in them that changes is the code (digits), so nothing needs
// escaping, and no name, address or link is ever put in one.
import type { Env } from './util.ts';

const FROM = 'Lumio <no-reply@lumio-co.online>';
// Replies to a code email reach a person instead of the no-reply address.
const REPLY_TO = 'support@lumio-co.online';

export type Mail = { subject: string; text: string; html: string };

const WORDS = {
  // Also the code a sign-in sends when the email isn't confirmed yet.
  signup: {
    subject: 'is your Lumio code',
    heading: 'Your Lumio code is',
    body: 'Enter it to confirm your email and finish signing in. It works for 15 minutes.',
    footnote: 'If you didn’t try to sign up for Lumio, you can ignore this email. Don’t share this code: anyone who has it can sign in to Lumio with your email address.',
  },
  reset: {
    subject: 'is your Lumio password reset code',
    heading: 'Your Lumio password reset code is',
    body: 'Enter it in Lumio to choose a new password. It works for 15 minutes. Saving the new password signs you out of Lumio everywhere else.',
    footnote: 'If you didn’t ask to reset your password, you can ignore this email. Your password stays the same.',
  },
};

export function codeEmail(purpose: 'signup' | 'reset', code: string): Mail {
  const w = WORDS[purpose];
  return {
    subject: `${code} ${w.subject}`,
    text: `${w.heading} ${code}\n\n${w.body}\n\n${w.footnote}\n\nLumio`,
    html: `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#18181b">
<div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:16px;padding:32px">
<p style="margin:0 0 12px;font-size:16px;font-weight:600">${w.heading}</p>
<p style="margin:0 0 24px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:32px;letter-spacing:6px;font-weight:600">${code}</p>
<p style="margin:0 0 16px;font-size:15px;line-height:1.5">${w.body}</p>
<p style="margin:0;font-size:13px;line-height:1.5;color:#71717a">${w.footnote}</p>
</div>
<p style="max-width:480px;margin:16px auto 0;font-size:12px;color:#a1a1aa;text-align:center">Lumio</p>
</body></html>`,
  };
}

// Throws when Resend can't be reached or doesn't take the email.
export async function sendEmail(env: Env, to: string, mail: Mail) {
  const res = await fetch(env.RESEND_API_URL || 'https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM || FROM, to: [to], reply_to: REPLY_TO, subject: mail.subject, text: mail.text, html: mail.html }),
  });
  if (!res.ok) throw new Error(`Resend answered ${res.status}`);
}
