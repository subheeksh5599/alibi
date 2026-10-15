mod api;
mod index;
mod lwd;
mod network;
mod store;
mod verify;

use std::collections::HashMap;
use std::path::PathBuf;
use std::str::FromStr;

use alibi_core::{root_from_tree_state, Pool};
use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};

use crate::index::Indexer;
use crate::lwd::Lightwalletd;
use crate::network::NetworkConfig;
use crate::store::Store;
use crate::verify::{Net, Verifier};

#[derive(Parser)]
#[command(name = "alibi", about = "Prove when shielded Zcash notes entered their pool, from the anchors their spends commit to.")]
struct Cli {
    /// SQLite file holding the anchor index.
    #[arg(long, env = "ALIBI_DB", default_value = "alibi.db", global = true)]
    db: PathBuf,
    /// Networks to serve or index (comma separated: main, test).
    #[arg(long, env = "ALIBI_NETWORKS", default_value = "main", global = true, value_delimiter = ',')]
    networks: Vec<String>,
    #[arg(long, env = "ALIBI_LWD_MAIN", global = true)]
    lwd_main: Option<String>,
    #[arg(long, env = "ALIBI_LWD_TEST", global = true)]
    lwd_test: Option<String>,
    /// Override the first indexed block on mainnet.
    #[arg(long, env = "ALIBI_START_MAIN", global = true)]
    start_main: Option<u32>,
    /// Override the first indexed block on testnet.
    #[arg(long, env = "ALIBI_START_TEST", global = true)]
    start_test: Option<u32>,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run the HTTP API and keep every configured network's index up to date.
    Serve {
        #[arg(long, env = "ALIBI_BIND", default_value = "127.0.0.1:8790")]
        bind: String,
        /// Serve from the existing index without following the chain.
        #[arg(long)]
        no_index: bool,
    },
    /// Index until caught up with the chain (minus confirmations), then exit.
    Index {
        /// Stop after this height even if the chain is further ahead.
        #[arg(long)]
        until: Option<u32>,
    },
    /// Verify one transaction and print the report as JSON.
    Verify {
        txid: String,
        #[arg(long, default_value = "main")]
        network: String,
        /// Cut-off: a block height, or a UTC date (2026-09-24 or 2026-09-24T18:30Z).
        #[arg(long)]
        before: Option<String>,
    },
    /// Recompute one pool's root at one block straight from the server's tree state, with no index
    /// involved. With --anchor, say whether it matches.
    CheckRoot {
        #[arg(long, default_value = "main")]
        network: String,
        #[arg(long)]
        pool: String,
        #[arg(long)]
        height: u32,
        #[arg(long)]
        anchor: Option<String>,
    },
}

fn configs(cli: &Cli) -> Result<Vec<NetworkConfig>> {
    let mut out = Vec::new();
    for n in &cli.networks {
        match n.trim() {
            "main" | "mainnet" => out.push(NetworkConfig::mainnet(cli.lwd_main.clone(), cli.start_main)),
            "test" | "testnet" => out.push(NetworkConfig::testnet(cli.lwd_test.clone(), cli.start_test)),
            "" => {}
            other => bail!("unknown network `{other}` (expected main or test)"),
        }
    }
    if out.is_empty() {
        bail!("no networks configured");
    }
    Ok(out)
}

async fn build(cli: &Cli) -> Result<(Store, Vec<(NetworkConfig, Lightwalletd)>)> {
    let store = Store::open(&cli.db)?;
    let mut nets = Vec::new();
    for cfg in configs(cli)? {
        let lwd = Lightwalletd::connect(&cfg.lightwalletd).await?;
        nets.push((cfg, lwd));
    }
    Ok((store, nets))
}

fn verifier(store: &Store, nets: &[(NetworkConfig, Lightwalletd)]) -> Verifier {
    let map: HashMap<String, Net> = nets
        .iter()
        .map(|(cfg, lwd)| (cfg.name.clone(), Net { cfg: cfg.clone(), lwd: lwd.clone() }))
        .collect();
    Verifier::new(store.clone(), map)
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with_target(false)
        .init();
    let cli = Cli::parse();

    match &cli.cmd {
        Cmd::Serve { bind, no_index } => {
            let (store, nets) = build(&cli).await?;
            let v = verifier(&store, &nets);
            if !no_index {
                for (cfg, lwd) in &nets {
                    let ix = Indexer::new(store.clone(), cfg.clone(), lwd.clone());
                    tokio::spawn(ix.run());
                }
            }
            let listener = tokio::net::TcpListener::bind(bind).await.with_context(|| format!("binding {bind}"))?;
            tracing::info!(%bind, "serving");
            axum::serve(listener, api::router(v))
                .with_graceful_shutdown(async {
                    let _ = tokio::signal::ctrl_c().await;
                })
                .await?;
        }
        Cmd::Index { until } => {
            let (store, nets) = build(&cli).await?;
            for (cfg, lwd) in nets {
                let name = cfg.name.clone();
                let mut ix = Indexer::new(store.clone(), cfg, lwd);
                loop {
                    let n = ix.step().await?;
                    let p = store.progress(&name)?.expect("started");
                    if n > 0 {
                        tracing::info!(network = %name, height = p.indexed_height, "indexed");
                    }
                    if n == 0 || until.is_some_and(|u| p.indexed_height >= u) {
                        break;
                    }
                }
                let a = store.audit_summary(&name)?;
                println!(
                    "{name}: indexed to {} ({} root audits, {} mismatches)",
                    store.progress(&name)?.map(|p| p.indexed_height).unwrap_or(0),
                    a.checks,
                    a.mismatches
                );
            }
        }
        Cmd::Verify { txid, network, before } => {
            let (store, nets) = build(&cli).await?;
            let v = verifier(&store, &nets);
            match v.verify_txid(network, txid, before.as_deref()).await {
                Ok(r) => println!("{}", serde_json::to_string_pretty(&r)?),
                Err(e) => bail!("{}: {e}", e.code()),
            }
        }
        Cmd::CheckRoot { network, pool, height, anchor } => {
            let cfg = match network.as_str() {
                "main" | "mainnet" => NetworkConfig::mainnet(cli.lwd_main.clone(), None),
                "test" | "testnet" => NetworkConfig::testnet(cli.lwd_test.clone(), None),
                other => bail!("unknown network `{other}`"),
            };
            let lwd = Lightwalletd::connect(&cfg.lightwalletd).await?;
            let pool = Pool::from_str(pool).map_err(anyhow::Error::msg)?;
            let ts = lwd.tree_state(*height).await?;
            let tree = match pool {
                Pool::Sapling => &ts.sapling_tree,
                Pool::Orchard => &ts.orchard_tree,
                Pool::Ironwood => &ts.ironwood_tree,
            };
            let root = root_from_tree_state(pool, tree)?;
            println!("network   {}", cfg.name);
            println!("block     {} {}", ts.height, ts.hash);
            println!("{pool:<9} root {}", hex::encode(root));
            if let Some(a) = anchor {
                let ok = a.trim().eq_ignore_ascii_case(&hex::encode(root));
                println!("anchor    {}", if ok { "MATCHES" } else { "does not match" });
                if !ok {
                    std::process::exit(1);
                }
            }
        }
    }
    Ok(())
}
