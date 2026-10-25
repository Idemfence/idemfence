import type { ResolvedConfig } from "./config.js";

const LOOKUP_TAG = "idemfence/lookup/v1";
const FINGERPRINT_TAG = "idemfence/fingerprint/v1";
const DERIVE_TAG = "idemfence/derive/v1";

type FingerprintConfig = Pick<
  ResolvedConfig,
  "headerAllowlist" | "requestBodyCap"
>;

export interface LookupKeyInput {
  namespace: string;
  principal: string;
  method: string;
  routeTemplate: string;
  clientKey: string;
}

export type FingerprintResult =
  | { readonly fingerprint: Uint8Array }
  | { readonly error: "body-too-large" };

const encoder = new TextEncoder();

/** The lookup key (docs/contract.md section 2): SHA-256 over the length-prefixed fields. */
export async function lookupKey(input: LookupKeyInput): Promise<Uint8Array> {
  return sha256(
    encode([
      LOOKUP_TAG,
      input.namespace,
      input.principal,
      input.method,
      input.routeTemplate,
      input.clientKey,
    ]),
  );
}

/**
 * The non-extractable HMAC-SHA256 key for derived downstream keys (docs/contract.md
 * section 5), imported from the oldest configured secret. Import it once and reuse it.
 */
export function deriveHmacKey(secret: Uint8Array): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    "raw",
    new Uint8Array(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/**
 * A derived downstream key (docs/contract.md section 5): lowercase hex of HMAC-SHA256 over
 * the length-prefixed domain tag, lookup key and label.
 */
export async function derivedKey(
  hmacKey: CryptoKey,
  lookup: Uint8Array,
  label: string,
): Promise<string> {
  const mac = new Uint8Array(
    await globalThis.crypto.subtle.sign(
      "HMAC",
      hmacKey,
      encode([DERIVE_TAG, lookup, label]),
    ),
  );
  return Array.from(mac, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The request fingerprint (docs/contract.md section 3). Reads a clone of the body, so the
 * original request body stays readable by the handler.
 */
export async function fingerprint(
  request: Request,
  config: FingerprintConfig,
): Promise<FingerprintResult> {
  const body = await readBody(request, config.requestBodyCap);
  if (body === undefined) {
    return { error: "body-too-large" };
  }

  const url = new URL(request.url);
  const query = new URLSearchParams(url.search);
  query.sort();
  const headerBlock = encode(
    [...config.headerAllowlist]
      .sort()
      .flatMap((name) => [name, presence(request.headers.get(name))]),
  );

  return {
    fingerprint: await sha256(
      encode([
        FINGERPRINT_TAG,
        request.method,
        url.pathname,
        query.toString(),
        presence(request.headers.get("content-type")),
        headerBlock,
        body,
      ]),
    ),
  };
}

/** Concatenates enc(field) for each field: a 64-bit big-endian byte length, then the bytes. */
function encode(
  fields: readonly (string | Uint8Array)[],
): Uint8Array<ArrayBuffer> {
  const parts = fields.map((field) =>
    typeof field === "string" ? encoder.encode(field) : field,
  );
  const output = new Uint8Array(
    parts.reduce((total, part) => total + 8 + part.byteLength, 0),
  );
  const view = new DataView(output.buffer);
  let offset = 0;
  for (const part of parts) {
    view.setBigUint64(offset, BigInt(part.byteLength));
    offset += 8;
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

/** One byte 0x00 when the header is absent, else 0x01 followed by the field value. */
function presence(value: string | null): Uint8Array {
  if (value === null) {
    return Uint8Array.of(0x00);
  }
  const encoded = encoder.encode(value);
  const output = new Uint8Array(1 + encoded.byteLength);
  output[0] = 0x01;
  output.set(encoded, 1);
  return output;
}

async function sha256(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", data));
}

/**
 * Buffers the body up to `cap` bytes, or returns undefined when it is larger. A declared
 * Content-Length over the cap is rejected before anything is read (the check comes before
 * clone(), which itself pulls a chunk); the running total is checked as well, because
 * Content-Length can be absent or wrong.
 */
async function readBody(
  request: Request,
  cap: number,
): Promise<Uint8Array | undefined> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > cap) {
    return undefined;
  }

  const stream = request.body === null ? null : request.clone().body;
  if (stream === null) {
    return new Uint8Array(0);
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > cap) {
      // Not awaited: cancelling one branch of a tee settles only when both are cancelled.
      reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
