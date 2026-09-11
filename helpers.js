const crypto = require('crypto');

// Collapses Gmail address variants down to the same identity, so
// "jane.doe@gmail.com", "janedoe@gmail.com", and "janedoe+shopping@gmail.com"
// are all treated as ONE account -- this is what actually enforces "only one
// account per Gmail address" (Gmail itself ignores dots and anything after a
// "+" in the local part, so without this, someone could sign up many times
// with what is really the same inbox).
function normalizeEmail(rawEmail) {
  const email = String(rawEmail || '').trim().toLowerCase();
  const [local, domain] = email.split('@');
  if (!domain) return email;

  const isGmail = domain === 'gmail.com' || domain === 'googlemail.com';
  if (!isGmail) return email;

  const withoutPlus = local.split('+')[0];
  const withoutDots = withoutPlus.replace(/\./g, '');
  return `${withoutDots}@gmail.com`;
}

function generateSixDigitCode() {
  // crypto.randomInt is uniformly distributed and cryptographically sound,
  // unlike Math.random() -- codes gate password resets, so this matters.
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function generateOrderId() {
  const n = crypto.randomInt(100000, 1000000);
  return `KM-${n}`;
}

module.exports = { normalizeEmail, generateSixDigitCode, generateOrderId };
