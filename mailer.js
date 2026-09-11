const nodemailer = require('nodemailer');

const SMTP_CONFIGURED = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

const transporter = SMTP_CONFIGURED
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      // Render's free tier blocks outbound SMTP ports entirely, so this
      // connection can never succeed there -- without an explicit timeout,
      // nodemailer/Node fall back to a long OS-level default (often 60s+)
      // before giving up, which is why signup felt slow. Since the
      // connection is guaranteed to fail on a blocked port either way,
      // failing fast costs nothing and just gets EXPOSE_DEV_CODE's
      // on-screen fallback showing sooner. If you move off Render's free
      // tier (or switch to a working SMTP host), raise this back up --
      // e.g. 10000 (10s) -- so real, slightly-slow connections aren't cut
      // off prematurely.
      connectionTimeout: 100,
      greetingTimeout: 100,
      socketTimeout: 100,
    })
  : null;

async function sendVerificationEmail({ to, name, code, purpose }) {
  const subject = purpose === 'reset'
    ? 'Your Kanjirowa Mart password reset code'
    : 'Your Kanjirowa Mart verification code';
  const text = `Hi ${name || ''},\n\nYour code is: ${code}\nIt expires in 10 minutes.\n\nIf you didn't request this, you can safely ignore this email.\n\n- Kanjirowa Mart`;

  if (!transporter) {
    // No SMTP configured -- log it so the store owner can still see it
    // happened, and the /auth endpoints fall back to returning the code
    // directly in dev mode (see EXPOSE_DEV_CODE in .env).
    console.log(`[mailer] SMTP not configured. Would have sent to ${to}: "${subject}" -- code ${code}`);
    return { delivered: false };
  }

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    text,
  });
  return { delivered: true };
}

module.exports = { sendVerificationEmail, SMTP_CONFIGURED };
