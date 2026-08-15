import { aesEcbDecrypt, base64ToBytes, utf8BytesToString } from "./codec-util.js";

const DEFAULT_GATEWAY_KEY = "vwwLu7e6ug4HAQMAug8CsA8HD7oHDwuxAg4HAQG6DLA=";
const KEY_NIBBLE_SUBSTITUTION = [3, 5, 7, 0, 15, 10, 13, 1, 11, 14, 4, 6, 9, 12, 8, 2];
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decodeBase64(value, errorMessage) {
  if (typeof value !== "string" || value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) {
    throw new Error(errorMessage);
  }

  try {
    return base64ToBytes(value);
  } catch {
    throw new Error(errorMessage);
  }
}

function deriveGatewayKey(encodedKey) {
  const sourceKey = decodeBase64(encodedKey, "Error Key");
  if (sourceKey.length !== 32) {
    throw new Error("Error Key");
  }

  const key = new Uint8Array(sourceKey.length);
  for (let i = 0; i < sourceKey.length; i++) {
    const value = sourceKey[i];
    key[i] = (KEY_NIBBLE_SUBSTITUTION[value >>> 4] << 4)
      | KEY_NIBBLE_SUBSTITUTION[value & 0x0f];
  }
  return key;
}

function removePkcs7Padding(data) {
  if (data.length === 0) {
    throw new Error("Invalid padding");
  }

  const paddingLength = data[data.length - 1];
  if (paddingLength < 1 || paddingLength > 16 || paddingLength > data.length) {
    throw new Error("Invalid padding");
  }

  for (let i = data.length - paddingLength; i < data.length; i++) {
    if (data[i] !== paddingLength) {
      throw new Error("Invalid padding");
    }
  }
  return data.slice(0, data.length - paddingLength);
}

function isValidUtf8(bytes) {
  for (let i = 0; i < bytes.length;) {
    const first = bytes[i++];
    if (first <= 0x7f) continue;

    let continuationCount;
    let codePoint;
    if (first >= 0xc2 && first <= 0xdf) {
      continuationCount = 1;
      codePoint = first & 0x1f;
    } else if (first >= 0xe0 && first <= 0xef) {
      continuationCount = 2;
      codePoint = first & 0x0f;
    } else if (first >= 0xf0 && first <= 0xf4) {
      continuationCount = 3;
      codePoint = first & 0x07;
    } else {
      return false;
    }

    if (i + continuationCount > bytes.length) return false;
    for (let j = 0; j < continuationCount; j++) {
      const next = bytes[i++];
      if ((next & 0xc0) !== 0x80) return false;
      codePoint = (codePoint << 6) | (next & 0x3f);
    }

    if ((continuationCount === 1 && codePoint < 0x80)
      || (continuationCount === 2 && codePoint < 0x800)
      || (continuationCount === 3 && codePoint < 0x10000)
      || (codePoint >= 0xd800 && codePoint <= 0xdfff)
      || codePoint > 0x10ffff) {
      return false;
    }
  }
  return true;
}

export async function decrypt(encryptedData, key) {
  const compactCipherText = typeof encryptedData === "string"
    ? encryptedData.replace(/\s+/g, "")
    : encryptedData;
  const cipherBytes = decodeBase64(compactCipherText, "Error decoding cipher text 1");
  const gatewayKey = deriveGatewayKey(key == null ? DEFAULT_GATEWAY_KEY : key);

  if (cipherBytes.length === 0 || cipherBytes.length % 16 !== 0) {
    throw new Error("Error decrypting cipher text 2");
  }

  try {
    const decryptedBytes = aesEcbDecrypt(cipherBytes, gatewayKey);
    const unpaddedBytes = removePkcs7Padding(decryptedBytes);
    if (!isValidUtf8(unpaddedBytes)) {
      throw new Error("Invalid UTF-8");
    }
    return utf8BytesToString(unpaddedBytes);
  } catch {
    throw new Error("Error decrypting cipher text 2");
  }
}
