//! Generate an API key for a customer agent.
//! Usage: cargo run --bin keygen -- <client_id> [--raw]
//!
//! The plaintext key is printed once. Give it to the agent. The server stores only the hash.
//! `--raw` prints `<key> <hash>` on one line, for scripts.

use lild_backend::auth::{generate_api_key, is_valid_client_id};

fn main() {
    let mut args = std::env::args().skip(1);
    let client_id = args.next().expect("usage: keygen <client_id> [--raw]");
    let raw = args.next().as_deref() == Some("--raw");
    assert!(
        is_valid_client_id(&client_id),
        "client_id must be 1-64 chars of A-Z a-z 0-9 . _ -"
    );
    let key = generate_api_key();
    if raw {
        println!("{} {}", key.plaintext, key.hash);
        return;
    }
    println!("API key (give to the agent, shown once):\n  {}\n", key.plaintext);
    println!("Server config:\n  LILD_API_KEYS='{client_id}:{}'", key.hash);
}
