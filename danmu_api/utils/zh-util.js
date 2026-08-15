import { ConverterFactory } from "opencc-js/core";
import simplifiedToTraditionalCharacters from "opencc-js/dict/STCharacters";
import toSimplifiedChinese from "opencc-js/to/cn";
import toTraditionalChinese from "opencc-js/to/tw";

// Converter instances are immutable and expensive to build, so share them
// across all searches and danmu conversions.
const toSimplified = ConverterFactory(toSimplifiedChinese);
const toTraditional = ConverterFactory(
  [simplifiedToTraditionalCharacters],
  toTraditionalChinese,
);

export function traditionalized(value) {
  return toTraditional(value);
}

export function simplized(value) {
  return toSimplified(value);
}

export function isNonChinese(value) {
  return !/[\u4e00-\u9fff]/.test(value);
}
