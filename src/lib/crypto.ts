import crypto from "node:crypto";

function getAesKey() {
  const secret = process.env.PHONE_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error("PHONE_ENCRYPTION_KEY is required for encrypted phone overrides.");
  }

  return crypto.createHash("sha256").update(secret).digest();
}

export function hashValue(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function encryptText(plainText: string) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", getAesKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("hex"), tag.toString("hex"), encrypted.toString("hex")].join(".");
}

export function decryptText(payload: string) {
  const [ivHex, tagHex, encryptedHex] = payload.split(".");
  if (!ivHex || !tagHex || !encryptedHex) {
    throw new Error("Invalid encrypted payload.");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getAesKey(),
    Buffer.from(ivHex, "hex")
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, "hex")),
    decipher.final()
  ]);
  return decrypted.toString("utf8");
}
