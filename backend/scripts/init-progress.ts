// Builds the progress row for an imported index: fetches the server's tree state at the indexed
// height, refuses unless its roots equal the roots the local index computed there, and prints the
// initProgress arguments.
import { readFileSync } from "node:fs";
import { Lightwalletd } from "../convex/lib/lwd";

const meta = JSON.parse(readFileSync(process.argv[2], "utf8"));
const lwd = new Lightwalletd(process.argv[3] ?? "https://zec.rocks:443");
const ts = await lwd.treeState(meta.indexed);
lwd.close();
for (const p of ["sapling", "orchard", "ironwood"]) {
  if (ts.roots[p as "sapling"] !== meta.roots_at_tip[p]) {
    console.error(`${p} root mismatch at ${meta.indexed}: server ${ts.roots[p as "sapling"]} local ${meta.roots_at_tip[p]}`);
    process.exit(1);
  }
}
if (ts.hash !== meta.hash) {
  console.error(`block hash mismatch at ${meta.indexed}`);
  process.exit(1);
}
console.error(`tree state at ${meta.indexed} matches the local index for all three pools`);
console.log(
  JSON.stringify({
    network: "main",
    startHeight: meta.start,
    indexedHeight: meta.indexed,
    indexedHash: meta.hash,
    trees: ts.trees,
    rootCounts: meta.counts,
    auditChecks: meta.audits[0],
    auditMismatches: meta.audits[1],
    lastAuditHeight: meta.audits[2],
  }),
);
