import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
// Follow the chain. A run indexes for up to four minutes; overlapping runs are harmless because
// appendBlocks only accepts a batch that starts exactly at the stored tip.
crons.interval("follow mainnet", { minutes: 2 }, internal.chain.indexStep, { network: "main" });
crons.interval("follow testnet", { minutes: 2 }, internal.chain.indexStep, { network: "test" });
export default crons;
