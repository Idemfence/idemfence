import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fingerprint, type LookupKeyInput, lookupKey } from "../src/hash.js";

// Fixed seed in CI (or FC_SEED when given), random locally.
const seed =
  process.env.FC_SEED !== undefined
    ? Number(process.env.FC_SEED)
    : process.env.CI
      ? 20261024
      : undefined;
const runs = seed === undefined ? { numRuns: 200 } : { seed, numRuns: 200 };

const config = { headerAllowlist: [] as string[], requestBodyCap: 1_048_576 };
const BODY = new TextEncoder().encode('{"amount":100}');

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

async function fp(
  request: Request,
  overrides: Partial<typeof config> = {},
): Promise<string> {
  const result = await fingerprint(request, { ...config, ...overrides });
  if (!("fingerprint" in result)) {
    throw new Error(`unexpected ${result.error}`);
  }
  expect(result.fingerprint).toHaveLength(32);
  return hex(result.fingerprint);
}

function post(
  url: string,
  init: {
    method?: string;
    contentType?: string;
    body?: Uint8Array<ArrayBuffer>;
    headers?: Record<string, string>;
  } = {},
): Request {
  const headers = new Headers(init.headers);
  if (init.contentType !== undefined) {
    headers.set("content-type", init.contentType);
  }
  return new Request(url, {
    method: init.method ?? "POST",
    headers,
    ...(init.body === undefined ? {} : { body: init.body }),
  });
}

const lookup = (input: Partial<LookupKeyInput>): LookupKeyInput => ({
  namespace: "idemfence",
  principal: "user-1",
  method: "POST",
  routeTemplate: "/orders",
  clientKey: "k",
  ...input,
});

describe("contract Appendix A test vectors", () => {
  it("L1-L3 lookup keys", async () => {
    expect(
      hex(
        await lookupKey(
          lookup({ clientKey: "8e03978e-40d5-43e8-bc93-6894a57f9324" }),
        ),
      ),
    ).toBe("20a9b317bd9314b4fe75ed1ca5b16184ee9ef404bd0ba1e92530fcfd6f3a9b61");
    expect(
      hex(await lookupKey(lookup({ principal: "ab", routeTemplate: "c" }))),
    ).toBe("9cf6d67825a4d64a64c4d609427cfed8482e4adb8be186740cbda0d6e3122848");
    expect(
      hex(await lookupKey(lookup({ principal: "a", routeTemplate: "bc" }))),
    ).toBe("cc56d56d0a9c41025aea2e0a6797ae9f6deeb96284a33725c53b5040a95dae9c");
  });

  it("F1 empty body, no Content-Type", async () => {
    expect(await fp(post("https://api.example.com/orders"))).toBe(
      "7045f9603f3fb5cf7d8ce97d45b3c3e7ca1e3e8cb9623e156f86d94813e932dc",
    );
  });

  it("F2 JSON body", async () => {
    expect(
      await fp(
        post("https://api.example.com/orders", {
          contentType: "application/json",
          body: BODY,
        }),
      ),
    ).toBe("05ded99e6efe8a94840e845b018f6ebe152ad66a8d145e7fd5eaad295107bd82");
  });

  it("F3 and F3' query reordering give the same digest", async () => {
    const expected =
      "70e9344b7b6d5933a76b74814e0bce5ff5def8644208cf90478d925fe43aa078";
    for (const query of ["b=2&a=1&a=0", "a=1&b=2&a=0"]) {
      expect(
        await fp(
          post(`https://api.example.com/orders?${query}`, {
            contentType: "application/json",
            body: BODY,
          }),
        ),
      ).toBe(expected);
    }
  });

  it("F4a and F4b absent versus empty Content-Type differ", async () => {
    const x = new TextEncoder().encode("x");
    expect(await fp(post("https://api.example.com/orders", { body: x }))).toBe(
      "41e855383497f6c43817e7a16cafe2df3ff6f8d3022993053c11beacf8bbf0f0",
    );
    expect(
      await fp(
        post("https://api.example.com/orders", { contentType: "", body: x }),
      ),
    ).toBe("2b9ce6afb919ab31dcba4268cff7737e50d752d2f92ef23f92d720f306213516");
  });

  it("F5 allowlisted headers, one present and one absent", async () => {
    expect(
      await fp(
        post("https://api.example.com/orders", {
          contentType: "application/json",
          body: BODY,
          headers: { "X-Tenant-ID": "t-42" },
        }),
        { headerAllowlist: ["x-tenant-id", "accept-language"] },
      ),
    ).toBe("709bce267e32c52c842bf96abd3c6e4f01aa3a789c9ce2fef3f852f0028b4ceb");
  });

  it("F6 WHATWG pathname normalisation", async () => {
    expect(
      await fp(
        post("https://api.example.com/orders/../orders/%7e42", {
          method: "PUT",
          contentType: "application/json",
          body: BODY,
        }),
      ),
    ).toBe("8cb4f171b055b24098db98c22e5e797c5f61700f630f847353624bbc9ee0b8e4");
  });
});

const segment = fc.stringMatching(/^[a-z0-9]{1,8}$/);
const text = fc.string({ unit: "grapheme", maxLength: 24 });
const method = fc.constantFrom("POST", "PUT", "PATCH", "DELETE");
const body = fc.uint8Array({ maxLength: 512 });

describe("properties", () => {
  it("identical inputs give identical digests", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          namespace: text,
          principal: text,
          method,
          routeTemplate: text,
          clientKey: text,
        }),
        fc.array(segment, { maxLength: 3 }),
        fc.option(fc.stringMatching(/^[a-z]{1,10}\/[a-z0-9.+-]{1,16}$/), {
          nil: undefined,
        }),
        body,
        async (input, path, contentType, bytes) => {
          expect(hex(await lookupKey(input))).toBe(
            hex(await lookupKey({ ...input })),
          );
          const url = `https://api.example.com/${path.join("/")}?q=${path.length}`;
          const make = () =>
            post(url, {
              method: input.method,
              ...(contentType === undefined ? {} : { contentType }),
              body: bytes.slice(),
            });
          expect(await fp(make())).toBe(await fp(make()));
        },
      ),
      runs,
    );
  });

  it("any single-byte body change gives a different fingerprint", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 1, maxLength: 512 }),
        fc.nat(),
        fc.integer({ min: 1, max: 255 }),
        async (bytes, index, delta) => {
          const changed = bytes.slice();
          const at = index % bytes.length;
          changed[at] = ((changed[at] ?? 0) + delta) % 256;
          const url = "https://api.example.com/orders";
          expect(await fp(post(url, { body: bytes.slice() }))).not.toBe(
            await fp(post(url, { body: changed })),
          );
        },
      ),
      runs,
    );
  });

  it("shifting the boundary between path and query changes the fingerprint", async () => {
    await fc.assert(
      fc.asyncProperty(segment, segment, segment, async (x, y, z) => {
        // e.g. path "/ab" + query "c" versus path "/a" + query "bc".
        const a = await fp(post(`https://api.example.com/${x}${y}?${z}`));
        const b = await fp(post(`https://api.example.com/${x}?${y}${z}`));
        expect(a).not.toBe(b);
      }),
      runs,
    );
  });

  it("shifting the boundary between principal and route template changes the lookup key", async () => {
    await fc.assert(
      fc.asyncProperty(text, text, text, async (x, y, z) => {
        fc.pre(y.length > 0);
        // e.g. principal "ab" + route "c" versus principal "a" + route "bc".
        const a = await lookupKey(
          lookup({ principal: x + y, routeTemplate: z }),
        );
        const b = await lookupKey(
          lookup({ principal: x, routeTemplate: y + z }),
        );
        expect(hex(a)).not.toBe(hex(b));
      }),
      runs,
    );
  });

  it("lookup keys and fingerprints of the same field values never collide", async () => {
    await fc.assert(
      fc.asyncProperty(
        method,
        segment,
        segment,
        body,
        async (m, path, query, bytes) => {
          const contentType = "application/json";
          const request = post(`https://api.example.com/${path}?${query}`, {
            method: m,
            contentType,
            body: bytes.slice(),
          });
          const key = await lookupKey({
            namespace: m,
            principal: `/${path}`,
            method: `${query}=`,
            routeTemplate: contentType,
            clientKey: new TextDecoder().decode(bytes),
          });
          expect(hex(key)).not.toBe(await fp(request));
        },
      ),
      runs,
    );
  });
});
