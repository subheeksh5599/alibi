// Puts an unreachable server first and checks that every call still succeeds via the next one.
import { Upstream } from "../convex/lib/lwd";
const up = new Upstream(["https://127.0.0.1:1", "https://zec.rocks:443"]);
const t0 = Date.now();
const tip = await up.latestHeight();
const ts = await up.treeState(3516994);
const tx = await up.transaction("14960f89420328fa92739217e5e05d6c9bd0e7c1c4640f0c6dc264dc9d3a252f");
console.log(JSON.stringify({ tip, servedBy: up.url, root: ts.roots.ironwood, txHeight: tx.height, ms: Date.now() - t0 }));
const dead = new Upstream(["https://127.0.0.1:1"]);
try { await dead.latestHeight(); console.log("UNEXPECTED: dead upstream answered"); process.exit(1); }
catch (e: any) { console.log("all-dead error:", e.message.slice(0, 90)); }
up.close(); dead.close();
