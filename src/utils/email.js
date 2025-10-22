import nodemailer from 'nodemailer'
import { ENV } from '../config/env.js'

let transporter = null
function getTransporter() {
  if (transporter) return transporter
  if (!ENV.SMTP_HOST || !ENV.SMTP_USER || !ENV.SMTP_PASS) return null
  transporter = nodemailer.createTransport({
    host: ENV.SMTP_HOST,
    port: ENV.SMTP_PORT,
    secure: ENV.SMTP_SECURE,
    auth: { user: ENV.SMTP_USER, pass: ENV.SMTP_PASS },
  })
  return transporter
}

export async function sendEmail({ to, subject, text, html }) {
  const t = getTransporter()
  if (!t) return false
  try {
    await t.sendMail({ from: ENV.EMAIL_FROM, to, subject, text, html })
    return true
  } catch {
    return false
  }
}

export function renderStatusEmail({ status, reason, submissionId }) {
  const title = status === 'approved' ? 'Your verification was approved'
    : status === 'rejected' ? 'Your verification was rejected'
    : status === 'flagged' ? 'Action required: More info needed'
    : 'Verification update'
  const body = [
    `Status: ${status}`,
    reason ? `Reason: ${reason}` : null,
    submissionId ? `Submission #${submissionId}` : null,
  ].filter(Boolean).join('\n')
  return { subject: title, text: body, html: `<p>${body.replace(/\n/g,'<br/>')}</p>` }
}

export function renderDigestEmail({ items }) {
  const subject = `Daily digest: ${items.length} flagged pending reviews`
  const lines = items.map(it => `#${it.id} · user:${it.userId} · created:${it.createdAt}`)
  const text = `Flagged items (${items.length}):\n` + lines.join('\n')
  const html = `<h3>Flagged items (${items.length})</h3><ul>` + items.map(it => `<li>#${it.id} · user:${it.userId} · created:${it.createdAt}</li>`).join('') + `</ul>`
  return { subject, text, html }
}
