import { describe, expect, it } from "vitest";
import { fingerprint } from "../src/hash.js";

const CAP = 16;
const config = { headerAllowlist: [] as string[], requestBodyCap: CAP };
const URL_ = "https://api.example.com/orders";

const bytes = (length: number, fill = 0x61): Uint8Array<ArrayBuffer> =>
  new Uint8Array(length).fill(fill);

/** A real ReadableStream that serves `chunks` on demand and counts pulls. */
function source(chunks: Uint8Array[]) {
  const state = { pulls: 0 };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[state.pulls];
        state.pulls += 1;
        if (chunk === undefined) {
          controller.close();
        } else {
          controller.enqueue(chunk.slice());
        }
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, state };
}

function streamed(
  stream: ReadableStream<Uint8Array>,
  headers: HeadersInit = {},
): Request {
  // duplex is required for stream bodies but missing from the RequestInit type in @types/node 22.
  const init = { method: "POST", body: stream, headers, duplex: "half" };
  return new Request(URL_, init);
}

const concat = (chunks: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

describe("request body cap", () => {
  it("accepts exactly cap bytes", async () => {
    const result = await fingerprint(
      new Request(URL_, { method: "POST", body: bytes(CAP) }),
      config,
    );
    expect(result).toHaveProperty("fingerprint");
  });

  it("rejects cap + 1 bytes", async () => {
    const result = await fingerprint(
      new Request(URL_, { method: "POST", body: bytes(CAP + 1) }),
      config,
    );
    expect(result).toStrictEqual({ error: "body-too-large" });
  });

  it("rejects a Content-Length over the cap without reading the body", async () => {
    const chunks = [bytes(8, 1), bytes(8, 2), bytes(8, 3)];
    const { stream, state } = source(chunks);
    const request = streamed(stream, { "content-length": String(CAP + 1) });

    expect(await fingerprint(request, config)).toStrictEqual({
      error: "body-too-large",
    });
    expect(state.pulls).toBe(0);
    expect(request.bodyUsed).toBe(false);
  });

  it("catches a body longer than its Content-Length while reading", async () => {
    const chunks = Array.from({ length: 8 }, (_, index) => bytes(8, index + 1));
    const { stream, state } = source(chunks);
    const request = streamed(stream, { "content-length": "4" });

    expect(await fingerprint(request, config)).toStrictEqual({
      error: "body-too-large",
    });
    // The third 8-byte chunk crosses the 16-byte cap; the clone's tee reads at most one
    // chunk ahead. The other chunks (and the end of the stream) are never pulled.
    expect(state.pulls).toBeLessThanOrEqual(4);
  });

  it("catches an over-cap body with no Content-Length while reading", async () => {
    const { stream } = source([bytes(10), bytes(10)]);
    expect(await fingerprint(streamed(stream), config)).toStrictEqual({
      error: "body-too-large",
    });
  });

  it("fingerprints a chunked stream the same as the same bytes sent at once", async () => {
    const chunks = [bytes(3, 1), bytes(5, 2), bytes(1, 3), bytes(7, 4)];
    const { stream } = source(chunks);
    const fromStream = await fingerprint(streamed(stream), config);
    const whole = await fingerprint(
      new Request(URL_, { method: "POST", body: concat(chunks) }),
      config,
    );
    expect(fromStream).toHaveProperty("fingerprint");
    expect(fromStream).toStrictEqual(whole);
  });

  it("treats a request without a body as an empty body", async () => {
    const none = await fingerprint(
      new Request(URL_, { method: "POST" }),
      config,
    );
    const empty = await fingerprint(
      new Request(URL_, { method: "POST", body: new Uint8Array(0) }),
      config,
    );
    expect(none).toStrictEqual(empty);
  });
});

describe("the original body stays readable by the handler", () => {
  it("for a buffered body", async () => {
    const sent = new TextEncoder().encode('{"amount":100}');
    const request = new Request(URL_, { method: "POST", body: sent.slice() });
    expect(await fingerprint(request, config)).toHaveProperty("fingerprint");
    expect(request.bodyUsed).toBe(false);
    expect(new Uint8Array(await request.arrayBuffer())).toStrictEqual(sent);
  });

  it("for a chunked stream body", async () => {
    const chunks = [bytes(4, 1), bytes(4, 2), bytes(4, 3)];
    const { stream } = source(chunks);
    const request = streamed(stream);
    expect(await fingerprint(request, config)).toHaveProperty("fingerprint");
    expect(new Uint8Array(await request.arrayBuffer())).toStrictEqual(
      concat(chunks),
    );
  });

  it("after the cap was exceeded while reading", async () => {
    const chunks = [bytes(10, 1), bytes(10, 2), bytes(10, 3)];
    const { stream } = source(chunks);
    const request = streamed(stream);
    expect(await fingerprint(request, config)).toStrictEqual({
      error: "body-too-large",
    });
    expect(new Uint8Array(await request.arrayBuffer())).toStrictEqual(
      concat(chunks),
    );
  });

  it("after a Content-Length rejection", async () => {
    const chunks = [bytes(8, 1), bytes(8, 2), bytes(8, 3)];
    const { stream } = source(chunks);
    const request = streamed(stream, { "content-length": "24" });
    expect(await fingerprint(request, config)).toStrictEqual({
      error: "body-too-large",
    });
    expect(new Uint8Array(await request.arrayBuffer())).toStrictEqual(
      concat(chunks),
    );
  });
});
