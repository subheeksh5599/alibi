import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

const send = (status: number, body: unknown) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json", ...CORS } });

const reply = (r: { status: number; body: unknown }) => send(r.status, r.body);

const params = (req: Request) => new URL(req.url).searchParams;
const network = (req: Request) => params(req).get("network") ?? "main";

http.route({
  path: "/",
  method: "GET",
  handler: httpAction(async () =>
    send(200, {
      service: "alibi verifier",
      claim:
        "For a Zcash transaction, report the latest block at the end of which every shielded note it spends was already in its pool, and whether that block is before a cut-off.",
      endpoints: {
        "GET /v1/health": "chain tip, index progress, root audits",
        "GET /v1/tx/{txid}?network=main&before={height|YYYY-MM-DD[THH:MM[:SS]]Z}": "verify a transaction by id",
        "POST /v1/verify": "body {network, txid | hex, before}",
        "GET /v1/anchor/{pool}/{anchor}": "the first block whose pool root is this anchor",
        "GET /v1/checkpoint?before=...": "the shared anchor-grid boundary to spend against for a cut-off",
        "GET /v1/cutoff?before=...": "resolve a date to the first block at or after it",
      },
    }),
  ),
});

http.route({ path: "/v1/health", method: "GET", handler: httpAction(async (ctx) => reply(await ctx.runAction(internal.chain.health, {}))) });

http.route({
  pathPrefix: "/v1/tx/",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const txid = decodeURIComponent(new URL(req.url).pathname.slice("/v1/tx/".length));
    return reply(await ctx.runAction(internal.chain.verifyTx, { network: network(req), txid, before: params(req).get("before") ?? undefined }));
  }),
});

http.route({
  path: "/v1/verify",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    let b: any;
    try {
      b = await req.json();
    } catch {
      return send(400, { error: "bad_request", message: "body must be JSON" });
    }
    const net = typeof b?.network === "string" ? b.network : "main";
    const before = typeof b?.before === "string" ? b.before : b?.before != null ? String(b.before) : undefined;
    const hasTxid = typeof b?.txid === "string";
    const hasHex = typeof b?.hex === "string";
    if (hasTxid === hasHex) return send(400, { error: "bad_request", message: "send exactly one of `txid` or `hex`" });
    if (hasHex && b.hex.length > 4_000_000) return send(400, { error: "bad_request", message: "transaction too large" });
    return reply(
      hasTxid
        ? await ctx.runAction(internal.chain.verifyTx, { network: net, txid: b.txid, before })
        : await ctx.runAction(internal.chain.verifyRaw, { network: net, hex: b.hex, before }),
    );
  }),
});

http.route({
  pathPrefix: "/v1/anchor/",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const [pool, anchor, ...rest] = new URL(req.url).pathname.slice("/v1/anchor/".length).split("/");
    if (!pool || !anchor || rest.length) return send(400, { error: "bad_request", message: "use /v1/anchor/{pool}/{anchor}" });
    return reply(await ctx.runAction(internal.chain.anchor, { network: network(req), pool: pool.toLowerCase(), anchor }));
  }),
});

for (const name of ["checkpoint", "cutoff"] as const) {
  http.route({
    path: `/v1/${name}`,
    method: "GET",
    handler: httpAction(async (ctx, req) => {
      const before = params(req).get("before");
      if (!before) return send(400, { error: "bad_request", message: "`before` is required" });
      return reply(await ctx.runAction(internal.chain[name], { network: network(req), before }));
    }),
  });
}

// ------------------------------------------------------------------ chain relay for the browser wallet

const int = (s: string | null) => (s !== null && /^\d+$/.test(s) ? Number(s) : NaN);

http.route({
  path: "/v1/chain/tip",
  method: "GET",
  handler: httpAction(async (ctx, req) => reply(await ctx.runAction(internal.relay.tip, { network: network(req) }))),
});

http.route({
  path: "/v1/chain/treestate",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const height = int(params(req).get("height"));
    if (Number.isNaN(height)) return send(400, { error: "bad_request", message: "`height` is required" });
    return reply(await ctx.runAction(internal.relay.treeState, { network: network(req), height }));
  }),
});

http.route({
  path: "/v1/chain/blocks",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const from = int(params(req).get("from"));
    const to = int(params(req).get("to"));
    if (Number.isNaN(from) || Number.isNaN(to)) return send(400, { error: "bad_request", message: "`from` and `to` are required" });
    return reply(await ctx.runAction(internal.relay.blocks, { network: network(req), from, to }));
  }),
});

http.route({
  path: "/v1/chain/broadcast",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    let b: any;
    try {
      b = await req.json();
    } catch {
      return send(400, { error: "bad_request", message: "body must be JSON" });
    }
    if (typeof b?.hex !== "string") return send(400, { error: "bad_request", message: "`hex` is required" });
    return reply(await ctx.runAction(internal.relay.broadcast, { network: typeof b.network === "string" ? b.network : "main", hex: b.hex }));
  }),
});

for (const path of ["/v1/verify", "/v1/chain/broadcast"]) {
  http.route({ path, method: "OPTIONS", handler: httpAction(async () => new Response(null, { status: 204, headers: CORS })) });
}

export default http;
