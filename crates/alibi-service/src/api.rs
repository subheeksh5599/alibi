//! HTTP API.

use std::str::FromStr;

use alibi_core::Pool;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use tower_http::cors::{Any, CorsLayer};

use crate::verify::{ApiError, Verifier};

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = match &self {
            ApiError::BadRequest(_) => StatusCode::BAD_REQUEST,
            ApiError::NotFound(_) => StatusCode::NOT_FOUND,
            ApiError::Unprocessable(_) => StatusCode::UNPROCESSABLE_ENTITY,
            ApiError::Unavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
            ApiError::Upstream(_) => StatusCode::BAD_GATEWAY,
        };
        if status.is_server_error() {
            tracing::warn!(code = self.code(), msg = %self, "request failed");
        }
        (status, Json(json!({ "error": self.code(), "message": self.to_string() }))).into_response()
    }
}

#[derive(Deserialize)]
pub struct NetQuery {
    network: Option<String>,
    before: Option<String>,
}

impl NetQuery {
    fn network(&self) -> String {
        self.network.clone().unwrap_or_else(|| "main".into())
    }
}

#[derive(Deserialize)]
pub struct VerifyBody {
    network: Option<String>,
    txid: Option<String>,
    hex: Option<String>,
    before: Option<String>,
}

async fn index() -> Json<serde_json::Value> {
    Json(json!({
        "service": "alibi verifier",
        "claim": "For a Zcash transaction, report the latest block at the end of which every shielded note it spends was already in its pool, and whether that block is before a cut-off.",
        "endpoints": {
            "GET /v1/health": "chain tip, index progress, root audits per network",
            "GET /v1/tx/{txid}?network=main&before={height|YYYY-MM-DD[THH:MM[:SS]]Z}": "verify a transaction by id",
            "POST /v1/verify": "body {network, txid | hex, before}: verify by id or raw bytes (e.g. before broadcast)",
            "GET /v1/anchor/{pool}/{anchor}?network=main": "the first block whose pool root is this anchor",
            "GET /v1/checkpoint?network=main&before=...": "the shared anchor-grid boundary to spend against for a cut-off",
            "GET /v1/cutoff?network=main&before=...": "resolve a date to the first block at or after it"
        }
    }))
}

async fn health(State(v): State<Verifier>) -> Json<serde_json::Value> {
    let nets = v.health().await;
    let ready = nets.iter().all(|n| n.index.is_some());
    Json(json!({ "ok": ready, "networks": nets }))
}

async fn tx(State(v): State<Verifier>, Path(txid): Path<String>, Query(q): Query<NetQuery>) -> Result<Response, ApiError> {
    let r = v.verify_txid(&q.network(), &txid, q.before.as_deref()).await?;
    Ok(Json(r).into_response())
}

async fn verify(State(v): State<Verifier>, Json(b): Json<VerifyBody>) -> Result<Response, ApiError> {
    let net = b.network.clone().unwrap_or_else(|| "main".into());
    let r = match (b.txid.as_deref(), b.hex.as_deref()) {
        (Some(id), None) => v.verify_txid(&net, id, b.before.as_deref()).await?,
        (None, Some(h)) => v.verify_raw(&net, h, b.before.as_deref()).await?,
        _ => return Err(ApiError::BadRequest("send exactly one of `txid` or `hex`".into())),
    };
    Ok(Json(r).into_response())
}

async fn anchor(
    State(v): State<Verifier>,
    Path((pool, anchor)): Path<(String, String)>,
    Query(q): Query<NetQuery>,
) -> Result<Response, ApiError> {
    let pool = Pool::from_str(&pool).map_err(ApiError::BadRequest)?;
    Ok(Json(v.anchor(&q.network(), pool, &anchor).await?).into_response())
}

async fn checkpoint(State(v): State<Verifier>, Query(q): Query<NetQuery>) -> Result<Response, ApiError> {
    let before = q.before.clone().ok_or_else(|| ApiError::BadRequest("`before` is required".into()))?;
    Ok(Json(v.checkpoint(&q.network(), &before)?).into_response())
}

async fn cutoff(State(v): State<Verifier>, Query(q): Query<NetQuery>) -> Result<Response, ApiError> {
    let net = q.network();
    v.net(&net)?;
    let before = q.before.clone().ok_or_else(|| ApiError::BadRequest("`before` is required".into()))?;
    Ok(Json(v.resolve_cutoff(&net, &before)?).into_response())
}

pub fn router(v: Verifier) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers(Any);
    Router::new()
        .route("/", get(index))
        .route("/v1/health", get(health))
        .route("/v1/tx/:txid", get(tx))
        .route("/v1/verify", post(verify))
        .route("/v1/anchor/:pool/:anchor", get(anchor))
        .route("/v1/checkpoint", get(checkpoint))
        .route("/v1/cutoff", get(cutoff))
        .layer(DefaultBodyLimit::max(5 * 1024 * 1024))
        .layer(cors)
        .with_state(v)
}
