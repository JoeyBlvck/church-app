import test from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import { sendMail, SmtpError } from '../src/smtp.js';

// A throwaway, decade-valid self-signed cert (CN=localhost), generated once with:
//   openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 3650 -nodes -subj "/CN=localhost"
// Committed as plain text rather than regenerated at test time, so this suite needs no external
// tools (no openssl) to run — in keeping with the rest of this project's dependency-free tests.
// It secures nothing but this test's own local, ephemeral TLS socket.
const KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC+MQ46T+18Yj5D
T3ZJ93prsPr2KO1qTSewJ/snnKAaDQyAWnp/2aewDrLn8q7EhYhxcusMsfFAklVF
ZOynpHmww0w3Vayv1Xu5vKNCOqQOpZp1k9ieO3hJdcwp/lCGAhdwN5exevIhLUof
bu21gEgrTg1pVOs+HiaFFLBAPSaVTNh3iaQMcZoGBao6QELEjE4AZJMzuf2QO7J6
rjHY+xAN89N5IwNtLirsrylHG75WL+F8jzlwEQK1D8k7NjkC421tSELTU8a1wzx/
wyP+szFJrDPMMt2CLnSSW6zVqSNuVlFq0JN8sVe1icFPZsCBj9x3UkI4AamJinn4
kV+4ChdLAgMBAAECggEAR5lwIcO1Q/44Ml7XyUDBdYlK8SC3QC2Lo2Vpx5/PJf+D
lU56j2cBGeZus6NI5/LdSthYZI8Yo5ZzQ4ybCwGATms3Zh16xTc5PNMnIuewm1L8
swbVpbv9rKoMEkMLTWe8KyLCmK4QOS0zmmHIW2vPv33CzsSJSvlOxwriz0w2Gj4N
g/cfh+6DcciQJ/IdJxxxwMVWDjMLsKGlucGgmHISEnKlW9d+hqAzn2O3CZe8jyrx
Czi6vwCwsF1MNnqPJsmdIEWXakhVLcke1nApye6tnaOphxfutm3u/WLL+t08vyCv
kq8pa8OYjQercJxopclHpuDg2j9a4d802DPWbeT/AQKBgQDkR/GujA1y65sNUf/7
waIAOpae0dwl+Do2KdKynHlYgRvhu5DGTIw6KOVVA/dj4/77wzJPLMaS5WOeWV74
K+iRlXOsBTShii9wTfRP807nN0JLHH7UPHQrE/nKxDRkFPlPBh4x3HvURqcEIuHc
GsIn3RbxyhMlJCq6i6TrJaaihwKBgQDVSRy8u64ULI3J5JM7yt4Xrf2H7404gp35
io4w7/HWDPXpnw56kt3ERrNZmlBzRvLN62Ymcny+U62H+qxct4Lz+qqBuN+7Wml/
f65JUIiRqfmbNdSuejlmmG29PIZus7Qur2sIsVcBGjbSgRtf5XSUjy+c2S1ig/uR
sZCpWP5iHQKBgQDPuC9QdpweQAj8m+rkOJOixa0cozVBT5gYhQH2CK/aOtEWHEhm
SG0o1uGm9E7+FA6HJFz48nNWY2i8Q/JIvBuJrYZttubnPwhflm+C+JCJkBzAoBNA
KCpEsI6RVOufTf51S8nZ8Ri0Vf3Po7YFREv7XhBsv0WgfEJtMHhGiCISrQKBgQCj
zHl4bH59WdYulg+I3P0BnIrYCd4f5xghnAolhTDqHZwCJjg9ZGtSIKX+i2d7kKJK
CJ2zqzsoBCWCB761me3FJ94or+2K+h2JYGpePa4UiEB8tbO3p4BLzYaBzWjEvdgD
/o4p5+AUpagytBps5FBLA0giohubzBa4xnB9zi3W9QKBgGMkWq5KDuEECJYG3cl+
oqJRqYqJg5OX8COXg1d3rCHccQANu4D29jVsi5c6/NqW32esePGHuHaUspH6+uX2
ORPGqCCbt2YE0qBhVmhutk1S7TVDPjUJhaFa2KKUEs9HjN3Ww5Csf4tHEbxcW3Ly
VNiroC9TAAirFTUsXTIkHFJV
-----END PRIVATE KEY-----`;
const CERT = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUb671zhVlx3YRBnNrBMMY+h61NIMwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDkyODE5NTU1NFoXDTM2MDky
NTE5NTU1NFowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAvjEOOk/tfGI+Q092Sfd6a7D69ijtak0nsCf7J5ygGg0M
gFp6f9mnsA6y5/KuxIWIcXLrDLHxQJJVRWTsp6R5sMNMN1Wsr9V7ubyjQjqkDqWa
dZPYnjt4SXXMKf5QhgIXcDeXsXryIS1KH27ttYBIK04NaVTrPh4mhRSwQD0mlUzY
d4mkDHGaBgWqOkBCxIxOAGSTM7n9kDuyeq4x2PsQDfPTeSMDbS4q7K8pRxu+Vi/h
fI85cBECtQ/JOzY5AuNtbUhC01PGtcM8f8Mj/rMxSawzzDLdgi50klus1akjblZR
atCTfLFXtYnBT2bAgY/cd1JCOAGpiYp5+JFfuAoXSwIDAQABo1MwUTAdBgNVHQ4E
FgQUQTAytvj/TfYQAFkb7MixlXwKP0kwHwYDVR0jBBgwFoAUQTAytvj/TfYQAFkb
7MixlXwKP0kwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAelZM
42uiJEAIIdY9EcKisxa2Qop1mcEgB0K/weiO5r/kA1NI9RGTuAhKRgdKAxXdxQel
NEGZvadyppPqnNj6MJ0hfUP8Ul0gtOV4sQ80Cy/94ocqDnr9GoylwU078/1hjbzG
6fTtdY8dYgmCjA9EscEWKt3Mr25vPyK+CIw2yEBOMd29XODmepz0XQL59Hm5Xt3q
SAGWpVOwfqH3SsYrwj2rZKek50Olr4Q+u5QsiewdpMiaGm3vWv/wvwwPKjQNrc1h
wkFioBraEWaJ501WiHzFUQFCQUcmvwGgaAVlpA1ohcKGN6YiQNgNHk/uiHublaT5
mpf5JZfqO7u3idgy4A==
-----END CERTIFICATE-----`;

// A tiny fake SMTP server: just enough of the real protocol (greeting, EHLO, AUTH LOGIN, MAIL
// FROM/RCPT TO, DATA with dot-stuffing, QUIT) to check that sendMail() speaks it correctly, and
// records what it was sent so a test can assert on it — never a real mail provider.
function startFakeSmtpServer() {
  const calls = { user: null, pass: null, mailFrom: null, rcptTo: null, data: null };
  const server = tls.createServer({ key: KEY, cert: CERT }, (socket) => {
    let buf = '';
    let stage = 'command';
    let awaitingAuth = 0; // 0 = not mid-AUTH-LOGIN, 1 = expecting username line, 2 = expecting password line
    let dataLines = [];
    socket.write('220 fake.smtp ESMTP\r\n');
    socket.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 2);
        if (stage === 'data') {
          if (line === '.') { calls.data = dataLines.join('\r\n'); socket.write('250 2.0.0 Queued\r\n'); stage = 'command'; }
          else dataLines.push(line.startsWith('..') ? line.slice(1) : line); // undo dot-stuffing
          continue;
        }
        if (awaitingAuth === 1) { calls.user = Buffer.from(line, 'base64').toString('utf8'); awaitingAuth = 2; socket.write('334 UGFzc3dvcmQ6\r\n'); continue; }
        if (awaitingAuth === 2) { calls.pass = Buffer.from(line, 'base64').toString('utf8'); awaitingAuth = 0; socket.write('235 2.7.0 Authentication successful\r\n'); continue; }
        if (line.startsWith('EHLO')) socket.write('250-fake.smtp\r\n250 AUTH LOGIN\r\n');
        else if (line === 'AUTH LOGIN') { awaitingAuth = 1; socket.write('334 VXNlcm5hbWU6\r\n'); }
        else if (line.startsWith('MAIL FROM:')) { calls.mailFrom = line.slice('MAIL FROM:'.length); socket.write('250 OK\r\n'); }
        else if (line.startsWith('RCPT TO:')) { calls.rcptTo = line.slice('RCPT TO:'.length); socket.write('250 OK\r\n'); }
        else if (line === 'DATA') { stage = 'data'; dataLines = []; socket.write('354 Start mail input\r\n'); }
        else if (line === 'QUIT') { socket.write('221 Bye\r\n'); socket.end(); }
      }
    });
  });
  return { server, calls };
}

async function withServer(run) {
  const { server, calls } = startFakeSmtpServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  // rejectUnauthorized: false only because this is our own throwaway self-signed test cert —
  // sendMail's real caller (server/src/email.js) never passes a connectImpl, so production
  // traffic to a real host (e.g. smtp.gmail.com) always goes through normal certificate checks.
  const connectImpl = (opts) => tls.connect({ ...opts, rejectUnauthorized: false });
  try {
    await run({ port, calls, connectImpl });
  } finally {
    server.close();
  }
}

test('sendMail: full protocol round trip — auth, envelope, and message body all reach the server correctly', async () => {
  await withServer(async ({ port, calls, connectImpl }) => {
    await sendMail({
      host: '127.0.0.1', port, user: 'me@gmail.com', pass: 'app-password',
      from: '"The ChurchFlow" <me@gmail.com>', to: 'ama@x.org',
      subject: 'Reset your ChurchFlow password', text: 'plain body', html: '<p>html body</p>',
    }, { connectImpl });
    assert.equal(calls.user, 'me@gmail.com');
    assert.equal(calls.pass, 'app-password');
    assert.equal(calls.mailFrom, '<me@gmail.com>');
    assert.equal(calls.rcptTo, '<ama@x.org>');
    assert.match(calls.data, /Subject: Reset your ChurchFlow password/);
    assert.match(calls.data, /To: ama@x\.org/);
    assert.match(calls.data, /From: "The ChurchFlow" <me@gmail\.com>/);
    assert.match(calls.data, /plain body/);
    assert.match(calls.data, /<p>html body<\/p>/);
  });
});

test('sendMail: a body line starting with "." survives round-trip (dot-stuffing)', async () => {
  await withServer(async ({ port, calls, connectImpl }) => {
    await sendMail({
      host: '127.0.0.1', port, user: 'me@gmail.com', pass: 'x',
      from: 'me@gmail.com', to: 'ama@x.org', subject: 'Subject',
      text: '.a line that starts with a period', html: '<p>ok</p>',
    }, { connectImpl });
    assert.match(calls.data, /^\.a line that starts with a period$/m);
  });
});

test('sendMail: a display name or subject can never inject extra headers via a newline', async () => {
  await withServer(async ({ port, calls, connectImpl }) => {
    await sendMail({
      host: '127.0.0.1', port, user: 'me@gmail.com', pass: 'x',
      from: '"Evil\r\nBcc: attacker@evil.org" <me@gmail.com>', to: 'ama@x.org',
      subject: 'Hi\r\nBcc: attacker@evil.org', text: 't', html: 'h',
    }, { connectImpl });
    // The injected text must survive only as harmless content folded into the Subject/From
    // line's own value — never as a genuine extra header line (which would start right after a
    // CRLF, at the very beginning of a line).
    assert.ok(!/^Bcc:/m.test(calls.data), `"Bcc:" must never start its own header line:\n${calls.data}`);
    assert.match(calls.data, /Subject: Hi Bcc: attacker@evil\.org/); // the neutered text is still there, just inert
  });
});

test('sendMail: rejects with SmtpError when the server refuses authentication', async () => {
  const server = tls.createServer({ key: KEY, cert: CERT }, (socket) => {
    socket.write('220 fake.smtp ESMTP\r\n');
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 2);
        if (line.startsWith('EHLO')) socket.write('250 fake.smtp\r\n');
        else if (line === 'AUTH LOGIN') socket.write('334 VXNlcm5hbWU6\r\n');
        else socket.write('535 5.7.8 Authentication failed\r\n');
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const connectImpl = (opts) => tls.connect({ ...opts, rejectUnauthorized: false });
  try {
    await assert.rejects(
      () => sendMail({ host: '127.0.0.1', port, user: 'u', pass: 'p', from: 'a@x.org', to: 'b@x.org', subject: 's', text: 't', html: 'h' }, { connectImpl }),
      SmtpError,
    );
  } finally {
    server.close();
  }
});

test('sendMail: rejects with SmtpError when the connection closes before responding', async () => {
  const server = tls.createServer({ key: KEY, cert: CERT }, (socket) => { socket.destroy(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const connectImpl = (opts) => tls.connect({ ...opts, rejectUnauthorized: false });
  try {
    await assert.rejects(
      () => sendMail({ host: '127.0.0.1', port, user: 'u', pass: 'p', from: 'a@x.org', to: 'b@x.org', subject: 's', text: 't', html: 'h' }, { connectImpl }),
      SmtpError,
    );
  } finally {
    server.close();
  }
});
