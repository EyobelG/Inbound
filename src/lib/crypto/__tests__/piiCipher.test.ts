import { beforeEach, describe, expect, it } from "vitest";
import { encryptPII, decryptPII } from "@/lib/crypto/piiCipher";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

beforeEach(() => {
  process.env.PII_ENCRYPTION_KEY = TEST_KEY;
});

describe("encryptPII / decryptPII", () => {
  it("round-trips a plaintext value", () => {
    const ciphertext = encryptPII("person@example.com");
    expect(decryptPII(ciphertext)).toBe("person@example.com");
  });

  it("produces different ciphertext for the same plaintext each time", () => {
    const a = encryptPII("person@example.com");
    const b = encryptPII("person@example.com");
    expect(a).not.toBe(b);
  });

  it("rejects a ciphertext tampered after encryption", () => {
    const ciphertext = encryptPII("person@example.com");
    const raw = Buffer.from(ciphertext, "base64");
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 0xff; // flip the last ciphertext byte
    const tampered = raw.toString("base64");
    expect(() => decryptPII(tampered)).toThrow();
  });

  it("rejects decryption with the wrong key", () => {
    const ciphertext = encryptPII("person@example.com");
    process.env.PII_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    expect(() => decryptPII(ciphertext)).toThrow();
  });

  it("throws when PII_ENCRYPTION_KEY is unset", () => {
    delete process.env.PII_ENCRYPTION_KEY;
    expect(() => encryptPII("person@example.com")).toThrow(/PII_ENCRYPTION_KEY/);
  });

  it("throws when PII_ENCRYPTION_KEY is the wrong length", () => {
    process.env.PII_ENCRYPTION_KEY = Buffer.alloc(16).toString("base64");
    expect(() => encryptPII("person@example.com")).toThrow(/32 bytes/);
  });
});
