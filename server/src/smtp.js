// A minimal SMTP client — just enough to send one plain-text+HTML email over an implicit-TLS
// connection (port 465, e.g. Gmail's smtp.gmail.com) with AUTH LOGIN. Deliberately narrow, the
// same way app/js/vendor/qrcode.js only covers what a check-in link needs rather than the full QR
// spec, rather than pulling in a package like nodemailer: no STARTTLS, no multiple recipients, no
// attachments — nothing server/src/email.js's one use case (a password-reset email) needs. See
// server/test/smtp.test.js, which runs this against a small fake SMTP server over a real TCP/TLS
// socket (not a real mail provider) to check the exact protocol exchange, not just that it compiles.
import { connect } from 'node:tls';

export class SmtpError extends Error {}

// Header values (a display name, a subject) must never carry a literal CR/LF through to the raw
// message — nodemailer and every other real mail library strips this too, since a value with a
// newline in it could inject extra headers (a classic "header injection" attack) into a message
// that's otherwise built from a single template. `to`/`from` addresses go through this as well,
// even though callers only ever pass our own server's own stored values, not arbitrary input.
const sanitizeHeader = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ');

// SMTP's end-of-message marker is a line containing just ".", so RFC 5321 §4.5.2 requires any
// line that begins with "." in the actual body to be escaped by doubling it — otherwise a
// password-reset email whose text happened to start a line with a period would truncate silently.
const dotStuff = (s) => s.replace(/\r\n\./g, '\r\n..').replace(/^\./, '..');

function buildMessage({ from, to, subject, text, html }) {
  const boundary = `----churchflow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const headers = [
    `From: ${sanitizeHeader(from)}`,
    `To: ${sanitizeHeader(to)}`,
    `Subject: ${sanitizeHeader(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].join('\r\n');
  const body = [
    `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', text, '',
    `--${boundary}`, 'Content-Type: text/html; charset=utf-8', '', html, '',
    `--${boundary}--`, '',
  ].join('\r\n');
  return dotStuff(`${headers}\r\n\r\n${body}`);
}

// Reads one complete SMTP response off `socket` — possibly several lines (e.g. EHLO's own
// capability list), which the protocol marks by using "-" instead of " " after the status code on
// every line but the last. Rejects if the connection closes or errors before a full response
// arrives, so a caller awaiting this never hangs forever on a dropped connection.
function readResponse(socket) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk;
      const lines = buf.split('\r\n');
      buf = lines.pop(); // whatever's left is either empty or an incomplete final line
      for (const line of lines) {
        if (/^\d{3} /.test(line)) { cleanup(); resolve({ code: Number(line.slice(0, 3)), text: line.slice(4) }); return; }
        // a "###-..." continuation line: keep reading, this response isn't finished yet
      }
    };
    const onClose = () => { cleanup(); reject(new SmtpError('Connection closed before the mail server finished responding.')); };
    const onError = (e) => { cleanup(); reject(new SmtpError(e.message)); };
    const cleanup = () => { socket.off('data', onData); socket.off('close', onClose); socket.off('error', onError); };
    socket.on('data', onData); socket.on('close', onClose); socket.on('error', onError);
  });
}

async function command(socket, line, expectCode) {
  socket.write(`${line}\r\n`);
  const res = await readResponse(socket);
  if (expectCode && Math.floor(res.code / 100) !== Math.floor(expectCode / 100))
    throw new SmtpError(`Mail server rejected "${line.split(' ')[0]}": ${res.code} ${res.text}`);
  return res;
}

// `connectImpl` is injectable (same DI pattern as sms.js's fetchImpl/paystack.js's fetchImpl) so
// server/test/smtp.test.js can point this at a local fake server instead of a real one.
export async function sendMail({ host, port = 465, user, pass, from, to, subject, text, html }, { connectImpl = connect } = {}) {
  const socket = connectImpl({ host, port, servername: host });
  try {
    await new Promise((resolve, reject) => {
      socket.once('secureConnect', resolve);
      socket.once('error', (e) => reject(new SmtpError(e.message)));
    });
    await readResponse(socket); // server's own 220 greeting
    await command(socket, `EHLO ${sanitizeHeader(host)}`, 250);
    await command(socket, 'AUTH LOGIN', 334);
    await command(socket, Buffer.from(user, 'utf8').toString('base64'), 334);
    await command(socket, Buffer.from(pass, 'utf8').toString('base64'), 235);
    await command(socket, `MAIL FROM:<${extractAddress(from)}>`, 250);
    await command(socket, `RCPT TO:<${extractAddress(to)}>`, 250);
    await command(socket, 'DATA', 354);
    // buildMessage() already ends with a trailing CRLF, so appending just "." here — without
    // another CRLF first — lands it on its own line: the correct end-of-DATA marker, with no
    // stray blank line in front of it.
    await command(socket, buildMessage({ from, to, subject, text, html }) + '.', 250);
    await command(socket, 'QUIT', 221).catch(() => {}); // best-effort — the message is already sent by this point
  } finally {
    socket.destroy();
  }
}

// Pulls the bare address out of `"Display Name" <addr@x.org>` (or returns the input unchanged if
// it's already bare) — MAIL FROM/RCPT TO take just the address, never the display name.
function extractAddress(s) {
  return s.match(/<(.+)>/)?.[1] ?? s;
}
