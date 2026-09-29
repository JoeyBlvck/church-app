import test from 'node:test';
import assert from 'node:assert/strict';

// ui.js pulls in config.js, which reads location.hostname / localStorage at module load time (to
// pick the right API server) — neither exists in Node, so they're stubbed just enough for the
// module to import cleanly. Nothing under test here touches the DOM.
globalThis.location = { hostname: 'test', protocol: 'http:' };
globalThis.localStorage = { getItem: () => null };
const { isNetworkError } = await import('../js/ui.js');

test('isNetworkError recognizes a fetch()-level network failure regardless of the browser engine’s wording', () => {
  assert.equal(isNetworkError(new TypeError('Failed to fetch')), true);                               // Chrome/Edge/WebView2 — the Windows desktop build
  assert.equal(isNetworkError(new TypeError('Load failed')), true);                                    // Safari/WKWebView — the Mac desktop build
  assert.equal(isNetworkError(new TypeError('NetworkError when attempting to fetch resource.')), true); // Firefox
});

test('isNetworkError does not mistake a real server response (even an error one) for a network failure', () => {
  assert.equal(isNetworkError(Object.assign(new Error('Wrong password'), { status: 401 })), false); // sync.js's http() throws exactly this shape for any real HTTP response
  assert.equal(isNetworkError(new Error('Server error')), false);
});

test('regression: matching on ex.message === "Failed to fetch" missed Safari’s wording entirely — why offline sign-in never worked on the Mac desktop app', () => {
  const oldBuggyCheck = (ex) => ex.message === 'Failed to fetch';
  const safariNetworkFailure = new TypeError('Load failed');
  assert.equal(oldBuggyCheck(safariNetworkFailure), false); // the bug: a real, genuine network failure went undetected on Safari/WKWebView
  assert.equal(isNetworkError(safariNetworkFailure), true); // the fix: detected by error type, not by browser-specific wording
});
