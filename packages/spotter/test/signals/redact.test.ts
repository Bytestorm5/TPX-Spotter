import { describe, expect, it } from "vitest";
import { createRedactor, isSensitiveKey, luhn, scrub } from "../../src/core/redact.ts";

const r = createRedactor({});

describe("built-in scrubbers", () => {
  it("emails", () => {
    expect(scrub("contact jane.doe+x@example.co.uk now")).toBe("contact [redacted:email] now");
  });

  it("card numbers only when Luhn-valid with a real brand prefix", () => {
    expect(luhn("4242424242424242")).toBe(true);
    expect(luhn("4242424242424241")).toBe(false);
    expect(scrub("card 4242 4242 4242 4242 ok")).toBe("card [redacted:card] ok");
    expect(scrub("card 4242-4242-4242-4242")).toBe("card [redacted:card]");
    expect(scrub("amex 378282246310005")).toBe("amex [redacted:card]");
    expect(scrub("mc 5555555555554444")).toBe("mc [redacted:card]");
    // Luhn fails
    expect(scrub("4242424242424241")).toBe("4242424242424241");
    // Epoch-ms timestamps and order ids aren't cards even when Luhn happens to pass.
    expect(scrub("at 1727190000000")).toBe("at 1727190000000");
    expect(scrub("order 1234567812345670")).toBe("order 1234567812345670");
  });

  it("US SSNs (dashed)", () => {
    expect(scrub("ssn 123-45-6789")).toBe("ssn [redacted:ssn]");
    expect(scrub("not 000-12-3456")).toBe("not 000-12-3456");
    expect(scrub("phone 555-1234")).toBe("phone 555-1234");
  });

  it("bearer tokens keep the scheme", () => {
    expect(scrub("Authorization: Bearer abcdefghijklmnop")).toBe("Authorization: Bearer [redacted:token]");
    expect(scrub("basic Zm9vOmJhcmJhcmJhcg==")).toBe("basic [redacted:token]");
  });

  it("JWTs", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(scrub(`token ${jwt} end`)).toBe("token [redacted:jwt] end");
  });

  it("API keys by prefix; publishable keys kept", () => {
    expect(scrub("sk_live_abcdefghijklmnop1234")).toBe("[redacted:api_key]");
    expect(scrub("sk_test_abcdefghijkl")).toBe("[redacted:api_key]");
    expect(scrub("pk_live_abcdefghijklmnop1234")).toBe("pk_live_abcdefghijklmnop1234");
    expect(scrub(`gh token ghp_${"a".repeat(36)}`)).toBe("gh token [redacted:api_key]");
    expect(scrub(`gho_${"B".repeat(36)}`)).toBe("[redacted:api_key]");
    expect(scrub("xoxb-1234567890-abcdefghij")).toBe("[redacted:api_key]");
    expect(scrub("aws AKIAIOSFODNN7EXAMPLE")).toBe("aws [redacted:api_key]");
    expect(scrub(`AIza${"x".repeat(35)}`)).toBe("[redacted:api_key]");
    expect(scrub(`sk-proj-${"a".repeat(40)}`)).toBe("[redacted:api_key]");
  });

  it("private key blocks", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----";
    expect(scrub(`key: ${pem} done`)).toBe("key: [redacted:private_key] done");
  });

  it("generic secret pairs keep the name", () => {
    expect(scrub("password=hunter2&user=bob")).toBe("password=[redacted:secret]&user=bob");
    expect(scrub('{"password":"hunter 2","ok":1}')).toBe('{"password":"[redacted:secret]","ok":1}');
    expect(scrub("secret: s3cr3t")).toBe("secret: [redacted:secret]");
    expect(scrub("api_key='abc'")).toBe("api_key='[redacted:secret]'");
  });

  it("leaves ordinary text alone", () => {
    const s = "User clicked Pay on /checkout at 12:03, total 42.50 EUR";
    expect(scrub(s)).toBe(s);
  });
});

describe("createRedactor", () => {
  it("applies the custom redactor after built-ins, and survives it throwing", () => {
    const custom = createRedactor({}, () => (v, where) => (where === "console" ? v.replace(/ACME-\d+/g, "[acct]") : v));
    expect(custom.redact("a@b.co ACME-42", "console")).toBe("[redacted:email] [acct]");
    expect(custom.redact("ACME-42", "network")).toBe("ACME-42");
    const throwing = createRedactor({}, () => () => {
      throw new Error("bad");
    });
    expect(throwing.redact("a@b.co", "text")).toBe("[redacted:email]");
    const none = createRedactor({}, () => null);
    expect(none.redact("plain", "text")).toBe("plain");
  });

  it("strips sensitive query params (exact and by name part)", () => {
    expect(r.redactUrl("https://x.com/p?token=abc&page=2")).toBe("https://x.com/p?token=[redacted]&page=2");
    expect(r.redactUrl("/cb?code=xyz&state=1")).toBe("/cb?code=[redacted]&state=1");
    expect(r.redactUrl("https://s3/x?X-Amz-Signature=deadbeef&X-Amz-Date=1")).toBe("https://s3/x?X-Amz-Signature=[redacted]&X-Amz-Date=1");
    expect(r.redactUrl("/a?authToken=1&keyword=shoes")).toBe("/a?authToken=[redacted]&keyword=shoes");
    expect(r.redactUrl("/a?access_token=1&refresh_token=2&api_key=3&sig=4&session=5&pwd=6")).toBe(
      "/a?access_token=[redacted]&refresh_token=[redacted]&api_key=[redacted]&sig=[redacted]&session=[redacted]&pwd=[redacted]",
    );
  });

  it("honours privacy.stripQueryParams", () => {
    const rr = createRedactor({ stripQueryParams: ["orderId"] });
    expect(rr.redactUrl("/o?orderId=9&x=1")).toBe("/o?orderId=[redacted]&x=1");
  });

  it("strips OAuth fragments, hash-router queries and userinfo passwords", () => {
    expect(r.redactUrl("https://app/cb#access_token=abc&expires_in=3600")).toBe("https://app/cb#access_token=[redacted]&expires_in=3600");
    expect(r.redactUrl("https://app/#/reset?token=abc")).toBe("https://app/#/reset?token=[redacted]");
    expect(r.redactUrl("https://bob:pw@host/x")).toBe("https://bob:[redacted]@host/x");
    expect(r.redactUrl("https://app/#section-2")).toBe("https://app/#section-2");
  });

  it("scrubs PII inside URLs", () => {
    expect(r.redactUrl("https://x.com/users/jane@example.com/profile")).toBe("https://x.com/users/[redacted:email]/profile");
    expect(r.redactUrl("/s?q=jane@example.com")).toBe("/s?q=[redacted:email]");
  });

  it("redactJson redacts strings and sensitive keys", () => {
    expect(r.redactJson({ email: "a@b.co", password: "x", nested: { apiKey: "k", n: 1 }, list: ["ssn 123-45-6789"] }, "context")).toEqual({
      email: "[redacted:email]",
      password: "[redacted:secret]",
      nested: { apiKey: "[redacted:secret]", n: 1 },
      list: ["ssn [redacted:ssn]"],
    });
    expect(isSensitiveKey("className")).toBe(false);
    expect(isSensitiveKey("x-auth-token")).toBe(true);
    expect(isSensitiveKey("cvv")).toBe(true);
    expect(isSensitiveKey("author")).toBe(false);
  });

  it("strips sensitive query parameters inside free text (breadcrumb messages)", () => {
    expect(r.redactMessage("GET /api/items?secret=s&page=2 500", "breadcrumb")).toBe("GET /api/items?secret=[redacted]&page=2 500");
    expect(r.redactMessage("/a?code=xyz → /b?session=1", "breadcrumb")).toBe("/a?code=[redacted] → /b?session=[redacted]");
    expect(r.redactMessage("Why? mail a@b.co", "breadcrumb")).toBe("Why? mail [redacted:email]");
  });
});
