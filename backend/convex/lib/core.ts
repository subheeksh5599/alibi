"use node";
// Host side of the alibi-core WebAssembly module: JSON in, JSON out.
import { WASM_BASE64 } from "./wasmBytes";

type Exports = {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  [fn: string]: unknown;
};

let instance: Exports | null = null;

function wasm(): Exports {
  if (!instance) {
    const bytes = Uint8Array.from(atob(WASM_BASE64), (c) => c.charCodeAt(0));
    const mod = new WebAssembly.Module(bytes);
    instance = new WebAssembly.Instance(mod, {}).exports as unknown as Exports;
  }
  return instance;
}

export class CoreError extends Error {}

/** Calls an exported function with a JSON request; returns `ok` or throws CoreError(`error`). */
export function core<T = any>(fn: string, req: unknown): T {
  const w = wasm();
  const input = new TextEncoder().encode(JSON.stringify(req));
  const ptr = w.alloc(input.length);
  new Uint8Array(w.memory.buffer, ptr, input.length).set(input);
  const header = (w[fn] as (p: number, l: number) => number)(ptr, input.length);
  w.dealloc(ptr, input.length);
  const view = new DataView(w.memory.buffer);
  const outPtr = view.getUint32(header, true);
  const outLen = view.getUint32(header + 4, true);
  const text = new TextDecoder().decode(new Uint8Array(w.memory.buffer, outPtr, outLen).slice());
  w.dealloc(outPtr, outLen);
  w.dealloc(header, 8);
  const res = JSON.parse(text);
  if ("error" in res) throw new CoreError(res.error);
  return res.ok as T;
}

export const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
