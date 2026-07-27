import test from "node:test";
import assert from "node:assert/strict";
import { decideExternalOpen, isLoopbackHost } from "../src/shared/externalNav";

test("isLoopbackHost: the obvious spellings, case-insensitive", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("LOCALHOST"), true);
  assert.equal(isLoopbackHost("[::1]"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("example.com"), false);
  assert.equal(isLoopbackHost("192.168.1.10"), false);
});

// U3g (review, major): comparing against a LIST OF SPELLINGS was the bug. Two
// hostnames the WHATWG parser hands over verbatim walked straight past it, and
// both name the machine Flow's local API listens on.
test("isLoopbackHost: the trailing DNS root dot is the same host", () => {
  // Verified under Node: new URL("http://localhost.:8176/x").hostname === "localhost."
  assert.equal(new URL("http://localhost.:8176/x").hostname, "localhost.", "the parser really does keep it");
  assert.equal(isLoopbackHost("localhost."), true);
  assert.equal(isLoopbackHost("LocalHost."), true);
  assert.equal(isLoopbackHost("localhost.."), true);
  assert.equal(isLoopbackHost("127.0.0.1."), true);
  assert.equal(isLoopbackHost("example.com."), false); // still a remote host
});

test("isLoopbackHost: IPv4-mapped IPv6, in the form the URL parser actually produces", () => {
  // Verified under Node: new URL("http://[::ffff:127.0.0.1]:8176/x").hostname === "[::ffff:7f00:1]"
  assert.equal(new URL("http://[::ffff:127.0.0.1]:8176/x").hostname, "[::ffff:7f00:1]");
  assert.equal(isLoopbackHost("[::ffff:7f00:1]"), true); // what we are handed
  assert.equal(isLoopbackHost("::ffff:127.0.0.1"), true); // what a human writes
  assert.equal(isLoopbackHost("[::7f00:1]"), true); // IPv4-compatible, ::127.0.0.1
  assert.equal(isLoopbackHost("::127.0.0.1"), true);
  assert.equal(isLoopbackHost("[::ffff:0:7f00:1]"), true); // IPv4-translated
  // A mapped PUBLIC address is not loopback: the embedding is not the point,
  // the embedded address is.
  assert.equal(isLoopbackHost("::ffff:93.184.216.34"), false);
  assert.equal(isLoopbackHost("[::ffff:5db8:d822]"), false);
});

test("isLoopbackHost: the whole 127.0.0.0/8 block, not just .0.0.1", () => {
  assert.equal(isLoopbackHost("127.0.0.2"), true);
  assert.equal(isLoopbackHost("127.1.2.3"), true);
  assert.equal(isLoopbackHost("127.255.255.254"), true);
  assert.equal(isLoopbackHost("128.0.0.1"), false);
  assert.equal(isLoopbackHost("126.255.255.255"), false);
  // The numeric shorthands are canonicalized by the parser BEFORE we see them,
  // which is why this function does not have to decode them itself.
  assert.equal(new URL("http://2130706433/").hostname, "127.0.0.1");
  assert.equal(new URL("http://127.1/").hostname, "127.0.0.1");
  assert.equal(new URL("http://0x7f000001/").hostname, "127.0.0.1");
});

test("isLoopbackHost: the unspecified addresses reach this machine too", () => {
  assert.equal(isLoopbackHost("0.0.0.0"), true);
  assert.equal(isLoopbackHost("[::]"), true);
  assert.equal(isLoopbackHost("::"), true);
});

test("isLoopbackHost: localhost's RFC 6761 subdomains", () => {
  assert.equal(isLoopbackHost("api.localhost"), true);
  assert.equal(isLoopbackHost("Flow.LocalHost."), true);
  assert.equal(isLoopbackHost("notlocalhost"), false);
  assert.equal(isLoopbackHost("localhost.example.com"), false); // a REMOTE host that merely starts with it
});

test("isLoopbackHost: expanded and malformed IPv6 forms", () => {
  assert.equal(isLoopbackHost("0:0:0:0:0:0:0:1"), true);
  assert.equal(isLoopbackHost("[0000:0000:0000:0000:0000:0000:0000:0001]"), true);
  assert.equal(isLoopbackHost("::2"), false);
  assert.equal(isLoopbackHost("2001:db8::1"), false);
  assert.equal(isLoopbackHost("::1::1"), false); // two "::" is not an address
  assert.equal(isLoopbackHost("::zz1"), false);
  assert.equal(isLoopbackHost("0:0:0:0:0:0:1"), false); // seven groups, no "::"
  assert.equal(isLoopbackHost(""), false);
});

test("decideExternalOpen: the bypasses the review found are refused end to end", () => {
  for (const url of [
    "http://localhost.:8176/settings",
    "http://[::ffff:127.0.0.1]:8176/settings",
    "http://127.0.0.2:8176/quit",
    "http://2130706433:8176/quit",
    "https://api.localhost/x",
    "http://0.0.0.0:8176/quit",
  ]) {
    const d = decideExternalOpen(url);
    assert.equal(d.allow, false, `${url} must be refused`);
    if (!d.allow) assert.match(d.reason, /loopback/);
  }
});

test("decideExternalOpen: an ordinary https link is allowed", () => {
  const d = decideExternalOpen("https://github.com/rochduboisgagnon/Flow");
  assert.equal(d.allow, true);
});

test("decideExternalOpen: mailto is allowed (no host to check)", () => {
  const d = decideExternalOpen("mailto:someone@example.com");
  assert.equal(d.allow, true);
});

test("decideExternalOpen: a malformed URL is refused, not thrown", () => {
  const d = decideExternalOpen("not a url");
  assert.equal(d.allow, false);
});

test("decideExternalOpen: disallowed schemes are refused (javascript:, file:, chrome:)", () => {
  for (const url of ["javascript:alert(1)", "file:///C:/Windows/System32", "chrome://settings"]) {
    const d = decideExternalOpen(url);
    assert.equal(d.allow, false, `${url} must be refused`);
  }
});

test("decideExternalOpen: http/https to Flow's own local API (loopback) is refused - the CSRF-shaped link", () => {
  for (const url of ["http://127.0.0.1:8176/settings", "https://localhost:8176/quit", "http://[::1]:8176/x"]) {
    const d = decideExternalOpen(url);
    assert.equal(d.allow, false, `${url} must be refused`);
    if (!d.allow) assert.match(d.reason, /loopback/);
  }
});

test("decideExternalOpen: a non-loopback host on http/https is still allowed", () => {
  const d = decideExternalOpen("http://example.com/page");
  assert.equal(d.allow, true);
});
