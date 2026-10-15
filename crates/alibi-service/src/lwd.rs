//! A thin, retrying client for the lightwalletd `CompactTxStreamer` gRPC service.

use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use tokio_stream::StreamExt;
use tonic::transport::{Channel, ClientTlsConfig, Endpoint};

pub mod rpc {
    tonic::include_proto!("cash.z.wallet.sdk.rpc");
}

use rpc::compact_tx_streamer_client::CompactTxStreamerClient;
pub use rpc::{CompactBlock, TreeState};

const MAX_MESSAGE: usize = 64 * 1024 * 1024;

#[derive(Clone)]
pub struct Lightwalletd {
    pub url: String,
    client: CompactTxStreamerClient<Channel>,
}

/// Where a fetched transaction sits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mined {
    /// Mined in the best chain at this height.
    At(u32),
    /// Known to the server but not mined (mempool).
    Unmined,
    /// Known to the server but in a block that is not on the best chain.
    NotInBestChain,
}

#[derive(Debug, thiserror::Error)]
pub enum FetchTxError {
    #[error("transaction not found")]
    NotFound,
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

impl Lightwalletd {
    pub async fn connect(url: &str) -> Result<Self> {
        let mut ep = Endpoint::from_shared(url.to_string())
            .with_context(|| format!("bad lightwalletd url {url}"))?
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(120))
            .tcp_keepalive(Some(Duration::from_secs(30)))
            .user_agent("alibi-verifier/0.1")?;
        if url.starts_with("https://") {
            ep = ep.tls_config(ClientTlsConfig::new().with_webpki_roots())?;
        }
        let channel = ep.connect_lazy();
        let client = CompactTxStreamerClient::new(channel)
            .max_decoding_message_size(MAX_MESSAGE)
            .max_encoding_message_size(MAX_MESSAGE);
        Ok(Self { url: url.to_string(), client })
    }

    async fn retry<T, F, Fut>(&self, what: &str, mut f: F) -> Result<T>
    where
        F: FnMut(CompactTxStreamerClient<Channel>) -> Fut,
        Fut: std::future::Future<Output = Result<T, tonic::Status>>,
    {
        let mut delay = Duration::from_millis(500);
        let mut last = None;
        for _ in 0..5 {
            match f(self.client.clone()).await {
                Ok(v) => return Ok(v),
                Err(s) if matches!(s.code(), tonic::Code::NotFound | tonic::Code::InvalidArgument) => {
                    return Err(anyhow!("{what}: {}", s.message()));
                }
                Err(s) => {
                    tracing::warn!(%what, code = ?s.code(), msg = %s.message(), "lightwalletd call failed, retrying");
                    last = Some(s);
                    tokio::time::sleep(delay).await;
                    delay = (delay * 2).min(Duration::from_secs(8));
                }
            }
        }
        Err(anyhow!("{what}: {}", last.map(|s| s.message().to_string()).unwrap_or_default()))
    }

    pub async fn latest_height(&self) -> Result<u32> {
        let id = self
            .retry("GetLatestBlock", |mut c| async move { c.get_latest_block(rpc::ChainSpec {}).await })
            .await?
            .into_inner();
        Ok(id.height as u32)
    }

    pub async fn tree_state(&self, height: u32) -> Result<TreeState> {
        Ok(self
            .retry("GetTreeState", |mut c| async move {
                c.get_tree_state(rpc::BlockId { height: height as u64, hash: vec![] }).await
            })
            .await?
            .into_inner())
    }

    pub async fn block(&self, height: u32) -> Result<CompactBlock> {
        Ok(self
            .retry("GetBlock", |mut c| async move {
                c.get_block(rpc::BlockId { height: height as u64, hash: vec![] }).await
            })
            .await?
            .into_inner())
    }

    /// Streams compact blocks `start..=end` in order.
    pub async fn block_range(&self, start: u32, end: u32) -> Result<Vec<CompactBlock>> {
        let range = rpc::BlockRange {
            start: Some(rpc::BlockId { height: start as u64, hash: vec![] }),
            end: Some(rpc::BlockId { height: end as u64, hash: vec![] }),
            pool_types: vec![],
        };
        let mut stream = self
            .retry("GetBlockRange", |mut c| {
                let r = range.clone();
                async move { c.get_block_range(r).await }
            })
            .await?
            .into_inner();
        let mut out = Vec::with_capacity((end - start + 1) as usize);
        while let Some(item) = stream.next().await {
            out.push(item.map_err(|s| anyhow!("GetBlockRange stream: {}", s.message()))?);
        }
        if out.len() != (end - start + 1) as usize {
            return Err(anyhow!("GetBlockRange {start}..={end} returned {} blocks", out.len()));
        }
        Ok(out)
    }

    /// Fetches a transaction by txid (display order hex).
    pub async fn transaction(&self, txid_display: &[u8; 32]) -> Result<(Vec<u8>, Mined), FetchTxError> {
        let mut wire = *txid_display;
        wire.reverse();
        let mut client = self.client.clone();
        let filter = rpc::TxFilter { block: None, index: 0, hash: wire.to_vec() };
        let mut attempt = 0;
        let raw = loop {
            match client.get_transaction(filter.clone()).await {
                Ok(r) => break r.into_inner(),
                Err(s) => {
                    let msg = s.message().to_ascii_lowercase();
                    if s.code() == tonic::Code::NotFound
                        || msg.contains("no such mempool or")
                        || msg.contains("not found")
                        || msg.contains("no such")
                        || msg.contains("invalid")
                    {
                        return Err(FetchTxError::NotFound);
                    }
                    attempt += 1;
                    if attempt >= 4 {
                        return Err(FetchTxError::Other(anyhow!("GetTransaction: {}", s.message())));
                    }
                    tokio::time::sleep(Duration::from_millis(600 * attempt)).await;
                }
            }
        };
        if raw.data.is_empty() {
            return Err(FetchTxError::NotFound);
        }
        let mined = match raw.height {
            0 => Mined::Unmined,
            h if h >= u32::MAX as u64 => Mined::NotInBestChain,
            h => Mined::At(h as u32),
        };
        Ok((raw.data, mined))
    }

    #[allow(dead_code)]
    pub async fn info(&self) -> Result<rpc::LightdInfo> {
        Ok(self
            .retry("GetLightdInfo", |mut c| async move { c.get_lightd_info(rpc::Empty {}).await })
            .await?
            .into_inner())
    }
}
