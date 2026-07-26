import { Converter } from "opencc-js";

// Converter instances are immutable and expensive to build, so share them
// across all searches and danmu conversions.
const toSimplified = Converter({ from: "t", to: "cn" });
const toTraditional = Converter({ from: "cn", to: "tw" });

export function traditionalized(value) {
  return toTraditional(value);
}

export function simplized(value) {
  return toSimplified(value);
}

export function isNonChinese(value) {
  return !/[\u4e00-\u9fff]/.test(value);
}
