//! Phase 4: agents (Claude) talk to the relay through the `lild-mcp` MCP server.
//!
//! Each test starts a real relay (HTTP on a random port, in-memory store, optional
//! worker) and talks to it through the MCP layer, the same way Claude would.

use std::{sync::Arc, time::Duration};

use lild_backend::{
    AppState,
    auth::{ApiKeyRecord, Scope, generate_api_key},
    build_app,
    mcp::{McpServer, RelayClient, SUPPORTED_PROTOCOL_VERSIONS, read_key_from_env_file},
    pipeline::StubPipeline,
    store::{MemoryStore, Store},
    worker::{WorkerConfig, run_worker},
};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::watch,
};

const Q: &str = "Which in-stock shirts have a body length under 30 inches?";

struct Relay {
    base: String,
    key: String,
    _shutdown: watch::Sender<bool>,
}

async fn start_relay(with_worker: bool) -> Relay {
    let store = Arc::new(MemoryStore::new());
    let k = generate_api_key();
    store
        .provision_api_key(ApiKeyRecord {
            client_id: "claude-agent".into(),
            key_hash: k.hash,
            scopes: Scope::ALL.to_vec(),
            expires_at: None,
            revoked: false,
        })
        .await
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = build_app(AppState { store: store.clone() });
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let (tx, rx) = watch::channel(false);
    if with_worker {
        let mut cfg = WorkerConfig::new("w-test");
        cfg.poll_interval = Duration::from_millis(20);
        let store: Arc<dyn Store> = store;
        tokio::spawn(run_worker(store, Arc::new(StubPipeline), cfg, rx));
    }
    Relay { base: format!("http://{addr}"), key: k.plaintext, _shutdown: tx }
}

fn mcp(base: &str, key: &str) -> McpServer {
    McpServer::new(RelayClient::new(base, key).unwrap()).with_poll_interval(Duration::from_millis(50))
}

async fn rpc(s: &McpServer, method: &str, params: Value) -> Value {
    s.handle(json!({ "jsonrpc": "2.0", "id": 7, "method": method, "params": params }))
        .await
        .expect("requests get a response")
}

/// Call a tool; returns the `result` object (content / structuredContent / isError).
async fn call(s: &McpServer, name: &str, args: Value) -> Value {
    let resp = rpc(s, "tools/call", json!({ "name": name, "arguments": args })).await;
    assert_eq!(resp["id"], 7);
    resp["result"].clone()
}

fn text(result: &Value) -> String {
    result["content"][0]["text"].as_str().unwrap_or_default().to_string()
}

// ---------- protocol ----------

#[tokio::test]
async fn initialize_negotiates_protocol_version() {
    let r = start_relay(false).await;
    let s = mcp(&r.base, &r.key);

    let resp = rpc(&s, "initialize", json!({ "protocolVersion": "2025-06-18", "capabilities": {},
        "clientInfo": { "name": "claude-code", "version": "x" } })).await;
    assert_eq!(resp["result"]["protocolVersion"], "2025-06-18", "echo a supported version");
    assert!(resp["result"]["capabilities"]["tools"].is_object());
    assert_eq!(resp["result"]["serverInfo"]["name"], "lild-relay");

    let resp = rpc(&s, "initialize", json!({ "protocolVersion": "1999-01-01" })).await;
    assert_eq!(resp["result"]["protocolVersion"], SUPPORTED_PROTOCOL_VERSIONS[0], "else offer our newest");
}

#[tokio::test]
async fn tools_list_describes_three_tools_with_strict_schemas() {
    let r = start_relay(false).await;
    let resp = rpc(&mcp(&r.base, &r.key), "tools/list", json!({})).await;
    let tools = resp["result"]["tools"].as_array().unwrap();
    let names: Vec<_> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["ask_merchant", "get_request_status", "check_relay_connection"]);
    for t in tools {
        assert_eq!(t["inputSchema"]["type"], "object");
        assert_eq!(t["inputSchema"]["additionalProperties"], false);
        assert!(t["description"].as_str().unwrap().len() > 20);
    }
}

#[tokio::test]
async fn jsonrpc_edge_cases() {
    let r = start_relay(false).await;
    let s = mcp(&r.base, &r.key);

    assert_eq!(rpc(&s, "ping", json!({})).await["result"], json!({}));
    assert_eq!(rpc(&s, "resources/list", json!({})).await["error"]["code"], -32601);
    assert_eq!(rpc(&s, "tools/call", json!({ "name": "rm_rf" })).await["error"]["code"], -32602);

    // Notifications get no reply.
    assert!(s.handle(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await.is_none());
    // Responses from the client are never answered.
    assert!(s.handle(json!({ "jsonrpc": "2.0", "id": 1, "result": {} })).await.is_none());

    let parse = s.handle_line("{not json").await.unwrap();
    assert_eq!((parse["error"]["code"].clone(), parse["id"].clone()), (json!(-32700), Value::Null));
    assert_eq!(s.handle_line("[1,2]").await.unwrap()["error"]["code"], -32600);
    assert_eq!(s.handle_line(&"x".repeat(2 * 1024 * 1024)).await.unwrap()["error"]["code"], -32600);
}

// ---------- tools against a live relay ----------

#[tokio::test]
async fn ask_merchant_end_to_end_returns_active_simulated_result() {
    let r = start_relay(true).await;
    let res = call(&mcp(&r.base, &r.key), "ask_merchant", json!({ "question": Q })).await;
    assert_eq!(res["isError"], false, "{res}");
    let out = &res["structuredContent"];
    assert_eq!(out["status"], "active");
    assert_eq!(out["result"]["simulated"], true);
    assert!(out["note"].as_str().unwrap().contains("SIMULATED"), "simulated data is flagged to the agent");
    assert!(text(&res).contains("\"status\": \"active\""), "text content mirrors structured content");
}

#[tokio::test]
async fn ask_merchant_returns_pending_with_next_step_when_not_done() {
    let r = start_relay(false).await; // no worker: stays pending
    let s = mcp(&r.base, &r.key);
    let started = std::time::Instant::now();
    let res = call(&s, "ask_merchant", json!({ "question": Q, "wait_seconds": 1 })).await;
    assert!(started.elapsed() < Duration::from_secs(3), "wait is bounded");
    let out = &res["structuredContent"];
    assert_eq!(out["status"], "pending");
    assert!(out["next_step"].as_str().unwrap().contains("get_request_status"));

    let id = out["request_id"].as_str().unwrap();
    let res = call(&s, "get_request_status", json!({ "request_id": id })).await;
    assert_eq!(res["isError"], false);
    assert_eq!(res["structuredContent"]["request_id"], id);
}

#[tokio::test]
async fn check_relay_connection_reports_healthy_setup() {
    let r = start_relay(false).await;
    let res = call(&mcp(&r.base, &r.key), "check_relay_connection", json!({})).await;
    assert_eq!(res["isError"], false, "{res}");
    assert_eq!(res["structuredContent"]["api_key"], "accepted");
}

// ---------- input validation ----------

#[tokio::test]
async fn bad_tool_arguments_are_tool_errors() {
    let r = start_relay(false).await;
    let s = mcp(&r.base, &r.key);
    let cases = [
        ("ask_merchant", json!({})),
        ("ask_merchant", json!({ "question": "   " })),
        ("ask_merchant", json!({ "question": "x".repeat(2001) })),
        ("ask_merchant", json!({ "question": Q, "wait_seconds": 999 })),
        ("ask_merchant", json!({ "question": Q, "customer_id": "someone-else" })),
        ("get_request_status", json!({ "request_id": "../../v1/health" })),
        ("get_request_status", json!({ "request_id": "1 OR 1=1" })),
        ("check_relay_connection", json!({ "extra": 1 })),
    ];
    for (tool, args) in cases {
        let res = call(&s, tool, args.clone()).await;
        assert_eq!(res["isError"], true, "{tool} {args} should be rejected");
    }
}

// ---------- security ----------

#[tokio::test]
async fn wrong_key_is_reported_without_leaking_any_key() {
    let r = start_relay(true).await;
    let wrong = generate_api_key().plaintext;
    let s = mcp(&r.base, &wrong);
    for (tool, args) in [
        ("ask_merchant", json!({ "question": Q })),
        ("check_relay_connection", json!({})),
        ("get_request_status", json!({ "request_id": uuid::Uuid::new_v4().to_string() })),
    ] {
        let res = call(&s, tool, args).await;
        assert_eq!(res["isError"], true);
        let all = res.to_string();
        assert!(!all.contains(&wrong) && !all.contains("lild_live_"), "no key in output: {all}");
    }
    let res = call(&s, "check_relay_connection", json!({})).await;
    assert!(text(&res).contains("authentication failed"));
}

#[tokio::test]
async fn successful_outputs_never_contain_the_key() {
    let r = start_relay(true).await;
    let s = mcp(&r.base, &r.key);
    let mut transcript = String::new();
    transcript += &rpc(&s, "initialize", json!({})).await.to_string();
    transcript += &rpc(&s, "tools/list", json!({})).await.to_string();
    let res = call(&s, "ask_merchant", json!({ "question": Q })).await;
    let id = res["structuredContent"]["request_id"].as_str().unwrap().to_string();
    transcript += &res.to_string();
    transcript += &call(&s, "get_request_status", json!({ "request_id": id })).await.to_string();
    transcript += &call(&s, "check_relay_connection", json!({})).await.to_string();
    assert!(!transcript.contains(&r.key));
    assert!(!transcript.contains("lild_live_"));
}

#[tokio::test]
async fn relay_down_is_a_fast_clear_tool_error() {
    // Grab a free port, then close it so nothing listens there.
    let port = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().port();
    let s = mcp(&format!("http://127.0.0.1:{port}"), &generate_api_key().plaintext);
    let started = std::time::Instant::now();
    let res = call(&s, "ask_merchant", json!({ "question": Q })).await;
    assert_eq!(res["isError"], true);
    assert!(text(&res).contains("unreachable"));
    assert!(started.elapsed() < Duration::from_secs(5), "bounded retries");
}

#[test]
fn client_config_is_validated() {
    let k = generate_api_key().plaintext;
    assert!(RelayClient::new("http://127.0.0.1:8080", &k).is_ok());
    assert!(RelayClient::new("http://localhost:8080/", &k).is_ok());
    assert!(RelayClient::new("https://relay.example.com", &k).is_ok());
    let plain_remote = RelayClient::new("http://relay.example.com", &k).err().unwrap();
    assert!(plain_remote.contains("https"), "API key must not travel unencrypted");
    assert!(RelayClient::new("ftp://127.0.0.1", &k).is_err());
    assert!(RelayClient::new("not a url", &k).is_err());
    assert!(RelayClient::new("http://127.0.0.1:8080", "sk-something-else").is_err());
}

#[test]
fn key_is_read_from_env_file() {
    let dir = std::env::temp_dir().join(format!("lild-mcp-test-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    let f = dir.join(".env");

    std::fs::write(&f, "# demo\nLILD_API_KEYS=a:b\nCUSTOMER_KEY=lild_live_cust\n").unwrap();
    assert_eq!(read_key_from_env_file(&f).unwrap(), "lild_live_cust");

    std::fs::write(&f, "CUSTOMER_KEY=lild_live_cust\nexport LILD_API_KEY=\"lild_live_primary\"\n").unwrap();
    assert_eq!(read_key_from_env_file(&f).unwrap(), "lild_live_primary", "LILD_API_KEY wins");

    std::fs::write(&f, "OTHER=1\n").unwrap();
    assert!(read_key_from_env_file(&f).is_err());
    assert!(read_key_from_env_file(&dir.join("missing")).is_err());
    std::fs::remove_dir_all(dir).unwrap();
}

// ---------- the real binary, over stdio, as Claude launches it ----------

struct Proc {
    child: tokio::process::Child,
    stdin: tokio::process::ChildStdin,
    lines: tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
}

fn spawn_mcp(base: &str, key: &str) -> Proc {
    let mut child = Command::new(env!("CARGO_BIN_EXE_lild-mcp"))
        .env("LILD_BASE_URL", base)
        .env("LILD_API_KEY", key)
        .env_remove("LILD_ENV_FILE")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let stdin = child.stdin.take().unwrap();
    let lines = BufReader::new(child.stdout.take().unwrap()).lines();
    Proc { child, stdin, lines }
}

impl Proc {
    async fn send(&mut self, msg: Value) {
        self.stdin.write_all(format!("{msg}\n").as_bytes()).await.unwrap();
        self.stdin.flush().await.unwrap();
    }
    async fn recv(&mut self) -> Value {
        let line = tokio::time::timeout(Duration::from_secs(15), self.lines.next_line())
            .await
            .expect("response in time")
            .unwrap()
            .expect("stdout open");
        serde_json::from_str(&line).unwrap_or_else(|_| panic!("stdout must be pure JSON-RPC, got: {line}"))
    }
}

#[tokio::test]
async fn real_binary_full_session_over_stdio() {
    let r = start_relay(true).await;
    let mut p = spawn_mcp(&r.base, &r.key);

    p.send(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "test", "version": "1" } } })).await;
    let init = p.recv().await;
    assert_eq!((init["id"].clone(), init["result"]["protocolVersion"].clone()), (json!(1), json!("2025-06-18")));

    p.send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await;
    p.send(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).await;
    assert_eq!(p.recv().await["result"]["tools"].as_array().unwrap().len(), 3, "notification got no reply");

    p.send(json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call",
        "params": { "name": "ask_merchant", "arguments": { "question": Q } } })).await;
    let ans = p.recv().await;
    assert_eq!(ans["id"], 3);
    assert_eq!(ans["result"]["structuredContent"]["status"], "active");

    drop(p.stdin); // Claude closes the session
    let status = tokio::time::timeout(Duration::from_secs(5), p.child.wait()).await.unwrap().unwrap();
    assert!(status.success(), "clean exit when stdin closes");
}

#[tokio::test]
async fn real_binary_handles_calls_concurrently() {
    let r = start_relay(false).await; // no worker: ask_merchant waits the full 2s
    let mut p = spawn_mcp(&r.base, &r.key);
    p.send(json!({ "jsonrpc": "2.0", "id": "slow", "method": "tools/call",
        "params": { "name": "ask_merchant", "arguments": { "question": Q, "wait_seconds": 2 } } })).await;
    p.send(json!({ "jsonrpc": "2.0", "id": "fast", "method": "ping" })).await;
    assert_eq!(p.recv().await["id"], "fast", "ping isn't stuck behind the slow call");
    let slow = p.recv().await;
    assert_eq!((slow["id"].clone(), slow["result"]["structuredContent"]["status"].clone()), (json!("slow"), json!("pending")));
}

#[tokio::test]
async fn real_binary_refuses_to_start_without_a_key() {
    let out = Command::new(env!("CARGO_BIN_EXE_lild-mcp"))
        .env_remove("LILD_API_KEY")
        .env_remove("LILD_ENV_FILE")
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .unwrap();
    assert!(!out.status.success());
    assert!(out.stdout.is_empty(), "nothing on the protocol channel");
    assert!(String::from_utf8_lossy(&out.stderr).contains("LILD_API_KEY"));
}
