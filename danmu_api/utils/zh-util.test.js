import assert from "node:assert/strict";
import test from "node:test";

const OPTIONAL_GLOBALS = ["Buffer", "TextEncoder", "TextDecoder", "crypto"];

test("OpenCC conversion preserves 案 while converting traditional text", async () => {
  const { simplized, traditionalized } = await import("./zh-util.js");

  assert.equal(simplized("案件與檔案"), "案件与档案");
  assert.equal(simplized("乾燥的頭髮"), "干燥的头发");
  assert.equal(traditionalized("案件与档案"), "案件與檔案");
});

test("OpenCC conversion works without optional Node and Web globals", async () => {
  const descriptors = new Map(
    OPTIONAL_GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );

  try {
    for (const name of OPTIONAL_GLOBALS) {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        writable: true,
        value: undefined,
      });
    }

    const { simplized, traditionalized } = await import("./zh-util.js?ios-sandbox");
    assert.equal(simplized("案件與檔案"), "案件与档案");
    assert.equal(traditionalized("简体中文"), "簡體中文");
  } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        delete globalThis[name];
      }
    }
  }
});
