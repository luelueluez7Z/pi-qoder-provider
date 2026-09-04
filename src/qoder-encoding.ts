// WAF-bypass body encoder.
//
// Qoder's gateway expects chat request bodies to be obfuscated through a
// non-standard transform of standard base64:
//   1. base64-encode the plaintext.
//   2. Rotate the string in three segments (tail / middle / head).
//   3. Remap every base64 alphabet character onto a custom alphabet.
//   4. Replace `=` padding with `$`.
// The custom alphabet and the rotation are part of the wire protocol.

const CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function qoderEncodeBody(plaintext: string | Buffer): string {
  const std = Buffer.isBuffer(plaintext) ? plaintext.toString("base64") : Buffer.from(plaintext).toString("base64");
  const n = std.length;
  if (n === 0) return "";
  const a = Math.floor(n / 3);
  const out = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i++) {
    const sourceIndex = i < a ? n - a + i : i < n - a ? i : i - (n - a);
    const c = std[sourceIndex];
    if (c === "=") {
      out[i] = 36;
    } else {
      const idx = STD_ALPHABET.indexOf(c);
      out[i] = idx >= 0 ? CUSTOM_ALPHABET.charCodeAt(idx) : c.charCodeAt(0);
    }
  }
  return out.toString("ascii");
}
