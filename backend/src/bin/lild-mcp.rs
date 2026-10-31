//! `lild-mcp`: MCP server that lets Claude (Code or Desktop) talk to the relay.
//!
//! Config (environment):
//!   LILD_BASE_URL   relay URL (default http://127.0.0.1:8080; non-local hosts need https)
//!   LILD_API_KEY    the agent's lild_live_ key, or:
//!   LILD_ENV_FILE   path to a .env file containing LILD_API_KEY= or CUSTOMER_KEY=
//!                   (keeps the key out of Claude's own config files)
//!   LILD_MCP_LOG    log level for stderr (default warn)
//!
//! stdout is reserved for MCP messages; all logs go to stderr.

use std::{path::PathBuf, sync::Arc};

use lild_backend::mcp::{McpServer, RelayClient, read_key_from_env_file, serve_stdio};
use tracing_subscriber::EnvFilter;

fn fail(msg: &str) -> ! {
    eprintln!("lild-mcp: {msg}");
    std::process::exit(2);
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .with_env_filter(EnvFilter::try_from_env("LILD_MCP_LOG").unwrap_or_else(|_| "warn".into()))
        .init();

    let base = std::env::var("LILD_BASE_URL").unwrap_or_else(|_| "http://127.0.0.1:8080".into());
    let key = match std::env::var("LILD_API_KEY") {
        Ok(k) if !k.trim().is_empty() => k,
        _ => match std::env::var("LILD_ENV_FILE") {
            Ok(path) if !path.is_empty() => {
                read_key_from_env_file(&PathBuf::from(path)).unwrap_or_else(|e| fail(&e))
            }
            _ => fail("set LILD_API_KEY or LILD_ENV_FILE"),
        },
    };
    let client = RelayClient::new(&base, &key).unwrap_or_else(|e| fail(&e));

    if let Err(e) = serve_stdio(Arc::new(McpServer::new(client))).await {
        fail(&format!("stdio error: {e}"));
    }
}
