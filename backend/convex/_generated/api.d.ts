/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as chain from "../chain.js";
import type * as crons from "../crons.js";
import type * as http from "../http.js";
import type * as ledger from "../ledger.js";
import type * as lib_constants from "../lib/constants.js";
import type * as lib_core from "../lib/core.js";
import type * as lib_lwd from "../lib/lwd.js";
import type * as lib_wasmBytes from "../lib/wasmBytes.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  chain: typeof chain;
  crons: typeof crons;
  http: typeof http;
  ledger: typeof ledger;
  "lib/constants": typeof lib_constants;
  "lib/core": typeof lib_core;
  "lib/lwd": typeof lib_lwd;
  "lib/wasmBytes": typeof lib_wasmBytes;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
