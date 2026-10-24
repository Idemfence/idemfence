import { describe, expect, it } from "vitest";
import type { KeySyntax } from "../src/config.js";
import { parseIdempotencyKey } from "../src/key.js";

interface Options {
  keyMaxLength?: number;
  keySyntax?: KeySyntax;
  required?: boolean;
}

function parse(fieldLines: string[] | null, options: Options = {}) {
  const headers = new Headers();
  for (const line of fieldLines ?? []) {
    headers.append("Idempotency-Key", line);
  }
  return parseIdempotencyKey(headers, {
    keyMaxLength: options.keyMaxLength ?? 255,
    keySyntax: options.keySyntax ?? "sf-string",
    required: options.required ?? true,
  });
}

const malformed = { error: "key-malformed" };

describe("draft examples", () => {
  it("parses the UUID example", () => {
    expect(parse(['"8e03978e-40d5-43e8-bc93-6894a57f9324"'])).toStrictEqual({
      key: "8e03978e-40d5-43e8-bc93-6894a57f9324",
    });
  });

  it("parses the random-string example", () => {
    expect(parse(['"clkyoesmbgybucifusbbtdsbohtyuuwz"'])).toStrictEqual({
      key: "clkyoesmbgybucifusbbtdsbohtyuuwz",
    });
  });
});

describe("missing header", () => {
  it("is key-missing when the key is required", () => {
    expect(parse(null)).toStrictEqual({ error: "key-missing" });
  });

  it("yields no key when the key is optional", () => {
    expect(parse(null, { required: false })).toStrictEqual({ key: undefined });
  });
});

describe("sf-string syntax", () => {
  it('unescapes \\" and \\\\', () => {
    expect(parse(['"a\\"b\\\\c"'])).toStrictEqual({ key: 'a"b\\c' });
  });

  it("allows spaces inside the string and SP around the item", () => {
    expect(parse(['"a b"   '])).toStrictEqual({ key: "a b" });
  });

  it.each([
    ["unquoted (strict mode)", "8e03978e-40d5-43e8-bc93-6894a57f9324"],
    ["unterminated quote", '"abc'],
    ["invalid escape \\n", '"ab\\nc"'],
    ["escape at end of input", '"abc\\'],
    ["control character (tab)", '"ab\tc"'],
    ["DEL character", '"ab\x7fc"'],
    ["non-ASCII", '"café"'],
    ["integer item", "42"],
    ["decimal item", "4.2"],
    ["token item", "abc"],
    ["byte sequence item", ":YWJj:"],
    ["boolean item", "?1"],
    ["date item", "@1700000000"],
    ["display string item", '%"abc"'],
    ["inner list", '("abc")'],
    ["trailing garbage", '"abc" x'],
    ["trailing comma", '"abc",'],
    ["empty string", '""'],
    ["empty field value", ""],
  ])("rejects %s", (_name, value) => {
    expect(parse([value])).toStrictEqual(malformed);
  });

  it("rejects two keys sent as separate field lines (comma-joined)", () => {
    expect(parse(['"abc"', '"def"'])).toStrictEqual(malformed);
    expect(parse(['"abc"', '"abc"'])).toStrictEqual(malformed);
  });

  it("measures length after unescaping", () => {
    // '"a\\b\"c"' is 9 characters on the wire and 5 after unescaping.
    const value = '"a\\\\b\\"c"';
    expect(parse([value], { keyMaxLength: 5 })).toStrictEqual({
      key: 'a\\b"c',
    });
    expect(parse([value], { keyMaxLength: 4 })).toStrictEqual(malformed);
  });

  it("accepts exactly keyMaxLength characters and rejects one more", () => {
    expect(parse([`"${"x".repeat(255)}"`])).toStrictEqual({
      key: "x".repeat(255),
    });
    expect(parse([`"${"x".repeat(256)}"`])).toStrictEqual(malformed);
    expect(parse([`"${"x".repeat(16)}"`], { keyMaxLength: 16 })).toStrictEqual({
      key: "x".repeat(16),
    });
    expect(parse([`"${"x".repeat(17)}"`], { keyMaxLength: 16 })).toStrictEqual(
      malformed,
    );
  });
});

describe("parameters", () => {
  it('parses "abc";p=1 to abc', () => {
    expect(parse(['"abc";p=1'])).toStrictEqual({ key: "abc" });
  });

  it("parses and ignores parameters of every bare item type", () => {
    const params = [
      "a",
      "b=?0",
      "c=-12.5",
      'd="x\\"y"',
      "e=tok/en:1",
      "f=:YWJj:",
      "g=:YWI:",
      "h=@1700000000",
      'i=%"caf%c3%a9"',
      "*j=*",
    ].join("; ");
    expect(parse([`"abc";${params}`])).toStrictEqual({ key: "abc" });
  });

  it.each([
    ["uppercase key", '"abc";P=1'],
    ["missing value after =", '"abc";p='],
    ["key starting with a digit", '"abc";1p=1'],
    ["decimal with four fraction digits", '"abc";p=1.2345'],
    ["decimal ending in a dot", '"abc";p=1.'],
    ["integer over 15 digits", '"abc";p=1234567890123456'],
    ["date with a decimal", '"abc";p=@1.5'],
    ["invalid boolean", '"abc";p=?2'],
    ["byte sequence outside base64", '"abc";p=:a-b:'],
    ["unterminated byte sequence", '"abc";p=:YWJj'],
    ["display string with uppercase hex", '"abc";p=%"%C3%A9"'],
    ["display string with invalid UTF-8", '"abc";p=%"%ff"'],
    ["unterminated string value", '"abc";p="x'],
    ["space before =", '"abc";p =1'],
  ])("rejects %s", (_name, value) => {
    expect(parse([value])).toStrictEqual(malformed);
  });
});

describe("raw mode (keySyntax sf-string-or-raw)", () => {
  const raw = { keySyntax: "sf-string-or-raw" } as const;

  it("accepts an unquoted key", () => {
    expect(parse(["abc"], raw)).toStrictEqual({ key: "abc" });
    expect(parse(["8e03978e-40d5-43e8-bc93-6894a57f9324"], raw)).toStrictEqual({
      key: "8e03978e-40d5-43e8-bc93-6894a57f9324",
    });
  });

  it('gives "abc" and abc the same key', () => {
    expect(parse(['"abc"'], raw)).toStrictEqual(parse(["abc"], raw));
  });

  it("still parses quoted keys as sf-strings", () => {
    expect(parse(['"abc";p=1'], raw)).toStrictEqual({ key: "abc" });
    expect(parse(['"abc'], raw)).toStrictEqual(malformed);
  });

  it.each([
    ["space", "ab c"],
    ["quote", 'ab"c'],
    ["backslash", "ab\\c"],
    ["non-ASCII", "café"],
    ["control character", "ab\tc"],
    ["two comma-joined field lines", null],
  ])("rejects a raw value with a %s", (_name, value) => {
    const lines = value === null ? ["abc", "def"] : [value];
    expect(parse(lines, raw)).toStrictEqual(malformed);
  });

  it("applies keyMaxLength to raw keys", () => {
    expect(parse(["x".repeat(16)], { ...raw, keyMaxLength: 16 })).toStrictEqual(
      {
        key: "x".repeat(16),
      },
    );
    expect(parse(["x".repeat(17)], { ...raw, keyMaxLength: 16 })).toStrictEqual(
      malformed,
    );
  });
});
