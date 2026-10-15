#!/bin/sh
# Builds the browser wallet (crates/alibi-wallet) to WebAssembly and places it in the app.
set -e
cd "$(dirname "$0")/.."
cargo build --release -p alibi-wallet --target wasm32-unknown-unknown
mkdir -p app/assets/wasm
cp target/wasm32-unknown-unknown/release/alibi_wallet.wasm app/assets/wasm/alibi_wallet.wasm
node -e '
const m = new WebAssembly.Module(require("fs").readFileSync("app/assets/wasm/alibi_wallet.wasm"));
const imports = WebAssembly.Module.imports(m);
if (imports.length) { console.error("the wallet module must have no imports, found", imports); process.exit(1); }
console.log("app/assets/wasm/alibi_wallet.wasm:", require("fs").statSync("app/assets/wasm/alibi_wallet.wasm").size, "bytes, no imports");
'
