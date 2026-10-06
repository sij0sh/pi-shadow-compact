import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CHARS_PER_TOKEN,
  redactSecretValue,
  sanitizeForContext,
  tokensToChars,
} from "../src/normalize.js";

// NOTE: every secret below is assembled at runtime (concatenation/repeat),
// never written as a literal. This proves the redactor catches values it
// has never seen, not just known fixtures.

function skAnt(): string {
  return "sk-ant-" + "api03-" + "k".repeat(64);
}

function skOr(): string {
  return "sk-or-v1-" + "a".repeat(64);
}

function jwt(): string {
  return "eyJ" + "A".repeat(12) + "." + "B".repeat(30) + "." + "C".repeat(30);
}

function bearerLine(): string {
  return "Authorization: Bearer " + "z".repeat(40);
}

function upperAssign(name: string, value: string): string {
  return name + "=" + value;
}

function pemBlock(): string {
  const begin = "-----BEGIN " + "RSA PRIVATE KEY-----";
  const end = "-----END " + "RSA PRIVATE KEY-----";
  return [begin, "X".repeat(64), "Y".repeat(64), end].join("\n");
}

describe("sanitizeForContext secrets", () => {
  it("redacts provider API keys", () => {
    const text = sanitizeForContext(`key: ${skAnt()}\nother: ${skOr()}`, "");
    assert.ok(!text.includes("sk-ant"), text);
    assert.ok(!text.includes("sk-or-v1"), text);
    assert.match(text, /\[REDACTED\]/);
  });

  it("redacts JWTs with a distinct marker", () => {
    const token = jwt();
    assert.equal(token.split(".").length, 3);
    const text = sanitizeForContext(`jwt: ${token}\ndone`, "");
    assert.ok(!text.includes(token), text);
    assert.match(text, /\[REDACTED JWT\]/);
  });

  it("leaves two-segment JWT lookalikes alone", () => {
    const almost = "eyJ" + "A".repeat(12) + "." + "B".repeat(30);
    const text = sanitizeForContext(`value: ${almost}`, "");
    assert.ok(text.includes(almost), text);
  });

  it("redacts bearer tokens but keeps the scheme", () => {
    const text = sanitizeForContext(bearerLine(), "");
    assert.ok(!text.includes("z".repeat(40)), text);
    assert.match(text, /Bearer \[REDACTED\]/);
  });

  it("redacts UPPER secret assignments even when the name ends in KEY", () => {
    for (const name of ["SECRET_KEY", "MY_API_KEY", "AWS_SECRET_ACCESS_KEY", "SECRET_TOKEN", "DB_PASSWORD"]) {
      const value = "hunter2-" + "v".repeat(16);
      const text = sanitizeForContext(upperAssign(name, value), "");
      assert.ok(!text.includes("hunter2"), `${name}: ${text}`);
      assert.ok(text.startsWith(name), text);
    }
  });

  it("redacts lowercase secret assignments with affixes", () => {
    const text = sanitizeForContext("secret_key: " + "s".repeat(20) + "\nretries: 3", "");
    assert.ok(!text.includes("s".repeat(20)), text);
    assert.ok(text.includes("retries: 3"), text);
  });

  it("fails closed on names that merely contain a secret word", () => {
    const text = sanitizeForContext("TOKEN_COUNT=5", "");
    assert.ok(!text.includes("5"), text);
  });

  it("redacts private key blocks", () => {
    const text = sanitizeForContext(`cert:\n${pemBlock()}\nend`, "");
    assert.ok(!text.includes("X".repeat(64)), text);
    assert.match(text, /\[REDACTED PRIVATE KEY\]/);
  });

  it("redacts URL userinfo", () => {
    const url = "https://" + "user:" + "p".repeat(12) + "@example.com/repo";
    const text = sanitizeForContext(`clone ${url} now`, "");
    assert.ok(!text.includes("p".repeat(12)), text);
    assert.match(text, /https:\/\/\[REDACTED\]@example\.com/, text);
  });

  it("redacts secrets nested in tool-result blobs", () => {
    const blob = JSON.stringify({ args: { api_key: skAnt() }, ok: true });
    const text = sanitizeForContext(`tool result: ${blob}`, "");
    assert.ok(!text.includes("sk-ant"), text);
  });

  it("redacts unfamiliar credentials in quoted JSON keys", () => {
    const secret = "provider-" + "m".repeat(20);
    for (const key of ["api_key", "credentials", "authorization", "access_token"]) {
      const text = sanitizeForContext(JSON.stringify({ [key]: secret, error: "quota exceeded" }), "");
      assert.ok(!text.includes(secret), text);
      assert.match(text, /quota exceeded/);
    }
  });

  it("is idempotent", () => {
    const input = `${bearerLine()}\n${upperAssign("SECRET_KEY", "hunter2-" + "w".repeat(8))}\njwt: ${jwt()}`;
    const once = sanitizeForContext(input, "");
    assert.equal(sanitizeForContext(once, ""), once);
  });
});

describe("sanitizeForContext text shaping", () => {
  it("normalizes CRLF and cwd prefixes", () => {
    const text = sanitizeForContext("open /home/u/proj/src/a.ts\r\nnext", "/home/u/proj");
    assert.equal(text, "open ./src/a.ts\nnext");
  });

  it("leaves ordinary prose untouched", () => {
    const prose = "decided to use Postgres for the session store (3 tables).";
    assert.equal(sanitizeForContext(prose, ""), prose);
  });
});

describe("redactSecretValue", () => {
  it("redacts any value under a secret-named key", () => {
    assert.equal(redactSecretValue("v", "SECRET_KEY"), "[REDACTED]");
    assert.equal(redactSecretValue(42, "token"), "[REDACTED]");
    assert.deepEqual(redactSecretValue({ a: 1 }, "credentials"), "[REDACTED]");
  });

  it("passes non-secret keys through while sanitizing strings", () => {
    assert.equal(redactSecretValue("v", "count"), "v");
    assert.equal(redactSecretValue(7, "count"), 7);
    const nested = redactSecretValue({ z: 1, api_key: skOr(), a: ["x", { token: "t" }] }, "args");
    assert.deepEqual(nested, { a: ["x", { token: "[REDACTED]" }], api_key: "[REDACTED]", z: 1 });
  });

  it("sanitizes bare strings without a key", () => {
    const text = redactSecretValue(`key ${skAnt()}`, "") as string;
    assert.ok(!text.includes("sk-ant"), text);
  });
});

describe("tokensToChars", () => {
  it("converts with the documented ratio", () => {
    assert.equal(CHARS_PER_TOKEN, 4);
    assert.equal(tokensToChars(1000), 4000);
    assert.equal(tokensToChars(10.9), 40);
  });

  it("returns zero for non-positive or non-finite input", () => {
    assert.equal(tokensToChars(0), 0);
    assert.equal(tokensToChars(-5), 0);
    assert.equal(tokensToChars(Number.NaN), 0);
    assert.equal(tokensToChars(Number.POSITIVE_INFINITY), 0);
  });
});
