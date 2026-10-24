import type { ResolvedConfig } from "./config.js";

type KeyConfig = Pick<
  ResolvedConfig,
  "keyMaxLength" | "keySyntax" | "required"
>;

/**
 * `{ key }` holds the decoded client key, or `undefined` when the header is absent on a
 * route where the key is optional (handled as contract row 1).
 */
export type KeyParseResult =
  | { readonly key: string | undefined }
  | { readonly error: "key-missing" | "key-malformed" };

// Raw keys (keySyntax "sf-string-or-raw"): 0x21 to 0x7E except DQUOTE and backslash.
const RAW_KEY = /^[\x21\x23-\x5b\x5d-\x7e]+$/;

/** Reads and validates the Idempotency-Key header (docs/contract.md section 2, rows 2 and 3). */
export function parseIdempotencyKey(
  headers: Headers,
  config: KeyConfig,
): KeyParseResult {
  // Headers joins repeated field lines with ", ", which is never a single valid Item.
  const value = headers.get("idempotency-key");
  if (value === null) {
    return config.required ? { error: "key-missing" } : { key: undefined };
  }

  const key =
    config.keySyntax === "sf-string-or-raw" && !value.startsWith('"')
      ? RAW_KEY.test(value)
        ? value
        : undefined
      : parseStringItem(value);
  if (key === undefined || key.length < 1 || key.length > config.keyMaxLength) {
    return { error: "key-malformed" };
  }
  return { key };
}

class ParseError extends Error {}

class Input {
  private pos = 0;

  constructor(private readonly text: string) {}

  get empty(): boolean {
    return this.pos >= this.text.length;
  }

  peek(offset = 0): string | undefined {
    return this.text[this.pos + offset];
  }

  consume(): string {
    const char = this.text[this.pos];
    if (char === undefined) {
      throw new ParseError();
    }
    this.pos += 1;
    return char;
  }

  unconsume(): void {
    this.pos -= 1;
  }

  /** Consumes everything up to (not including) the next `char`, or returns undefined. */
  consumeUntil(char: string): string | undefined {
    const end = this.text.indexOf(char, this.pos);
    if (end === -1) {
      return undefined;
    }
    const content = this.text.slice(this.pos, end);
    this.pos = end;
    return content;
  }

  discardSp(): void {
    while (this.text[this.pos] === " ") {
      this.pos += 1;
    }
  }
}

const DIGIT = /^[0-9]$/;
const ALPHA = /^[A-Za-z]$/;
const LCALPHA = /^[a-z]$/;
const KEY_CHAR = /^[a-z0-9_\-.*]$/;
const TOKEN_CHAR = /^[!#$%&'*+\-.^_`|~0-9A-Za-z:/]$/;
const BASE64 = /^[A-Za-z0-9+/=]*$/;
const LOWER_HEX = /^[0-9a-f]{2}$/;

const is = (pattern: RegExp, char: string | undefined): boolean =>
  char !== undefined && pattern.test(char);

function fail(): never {
  throw new ParseError();
}

/**
 * RFC 9651 section 4.2 with field_type "item", accepting only a String bare item
 * (section 3.3.3). Parameters are parsed and ignored. Returns undefined on any failure.
 */
function parseStringItem(value: string): string | undefined {
  // Step 1: the field value must be ASCII.
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) {
      return undefined;
    }
  }
  const input = new Input(value);
  try {
    input.discardSp();
    if (input.peek() !== '"') {
      return undefined;
    }
    const key = parseString(input);
    parseParameters(input);
    input.discardSp();
    return input.empty ? key : undefined;
  } catch (error) {
    if (error instanceof ParseError) {
      return undefined;
    }
    throw error;
  }
}

// Section 4.2.3.1.
function parseBareItem(input: Input): void {
  const first = input.peek();
  if (first === "-" || is(DIGIT, first)) {
    parseIntegerOrDecimal(input);
  } else if (first === '"') {
    parseString(input);
  } else if (first === "*" || is(ALPHA, first)) {
    parseToken(input);
  } else if (first === ":") {
    parseByteSequence(input);
  } else if (first === "?") {
    parseBoolean(input);
  } else if (first === "@") {
    parseDate(input);
  } else if (first === "%") {
    parseDisplayString(input);
  } else {
    fail();
  }
}

// Section 4.2.3.2.
function parseParameters(input: Input): void {
  while (!input.empty) {
    if (input.peek() !== ";") {
      return;
    }
    input.consume();
    input.discardSp();
    parseKey(input);
    if (input.peek() === "=") {
      input.consume();
      parseBareItem(input);
    }
  }
}

// Section 4.2.3.3.
function parseKey(input: Input): void {
  const first = input.peek();
  if (first !== "*" && !is(LCALPHA, first)) {
    fail();
  }
  while (!input.empty && is(KEY_CHAR, input.peek())) {
    input.consume();
  }
}

// Section 4.2.4.
function parseIntegerOrDecimal(input: Input): "integer" | "decimal" {
  let type: "integer" | "decimal" = "integer";
  let number = "";
  if (input.peek() === "-") {
    input.consume();
  }
  if (input.empty || !is(DIGIT, input.peek())) {
    fail();
  }
  while (!input.empty) {
    const char = input.consume();
    if (is(DIGIT, char)) {
      number += char;
    } else if (type === "integer" && char === ".") {
      if (number.length > 12) {
        fail();
      }
      number += char;
      type = "decimal";
    } else {
      input.unconsume();
      break;
    }
    if (type === "integer" && number.length > 15) {
      fail();
    }
    if (type === "decimal" && number.length > 16) {
      fail();
    }
  }
  if (type === "decimal") {
    const fraction = number.slice(number.indexOf(".") + 1);
    if (fraction.length === 0 || fraction.length > 3) {
      fail();
    }
  }
  return type;
}

// Section 4.2.5.
function parseString(input: Input): string {
  let output = "";
  if (input.consume() !== '"') {
    fail();
  }
  while (!input.empty) {
    const char = input.consume();
    if (char === "\\") {
      const next = input.consume();
      if (next !== '"' && next !== "\\") {
        fail();
      }
      output += next;
    } else if (char === '"') {
      return output;
    } else if (char < "\x20" || char > "\x7e") {
      fail();
    } else {
      output += char;
    }
  }
  return fail();
}

// Section 4.2.6.
function parseToken(input: Input): void {
  const first = input.peek();
  if (first !== "*" && !is(ALPHA, first)) {
    fail();
  }
  while (!input.empty && is(TOKEN_CHAR, input.peek())) {
    input.consume();
  }
}

// Section 4.2.7. Missing "=" padding and non-zero pad bits are tolerated, as the RFC asks.
function parseByteSequence(input: Input): void {
  input.consume();
  const content = input.consumeUntil(":");
  if (content === undefined) {
    fail();
  }
  input.consume();
  if (!BASE64.test(content)) {
    fail();
  }
  const data = content.replace(/=+$/, "");
  if (
    data.includes("=") ||
    content.length - data.length > 2 ||
    data.length % 4 === 1
  ) {
    fail();
  }
}

// Section 4.2.8.
function parseBoolean(input: Input): void {
  input.consume();
  const char = input.peek();
  if (char !== "0" && char !== "1") {
    fail();
  }
  input.consume();
}

// Section 4.2.9.
function parseDate(input: Input): void {
  input.consume();
  if (parseIntegerOrDecimal(input) === "decimal") {
    fail();
  }
}

// Section 4.2.10.
function parseDisplayString(input: Input): void {
  if (input.peek() !== "%" || input.peek(1) !== '"') {
    fail();
  }
  input.consume();
  input.consume();
  const bytes: number[] = [];
  while (!input.empty) {
    const char = input.consume();
    if (char < "\x20" || char > "\x7e") {
      fail();
    }
    if (char === "%") {
      const hex = input.consume() + input.consume();
      if (!LOWER_HEX.test(hex)) {
        fail();
      }
      bytes.push(Number.parseInt(hex, 16));
    } else if (char === '"') {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
      } catch {
        fail();
      }
      return;
    } else {
      bytes.push(char.charCodeAt(0));
    }
  }
  fail();
}
