//! Generate an API key for a customer agent.
//! Usage: cargo run --bin keygen -- <client_id> [--raw]
//!
//! The plaintext key is printed once. Give it to the agent. The server stores only the hash.
//! `--raw` prints `<key> <hash>` on one line, for scripts.

use lild_backend::auth::generate_api_key;

fn main() {
    let mut args = std::env::args().skip(1);
    let client_id = args.next().expect("usage: keygen <client_id> [--raw]");
    let raw = args.next().as_deref() == Some("--raw");
    assert!(
        !client_id.is_empty() && !client_id.contains([':', ',']),
        "client_id must be non-empty and contain no ':' or ','"
    );
    let key = generate_api_key();
    if raw {
        println!("{} {}", key.plaintext, key.hash);
        return;
    }
    println!("API key (give to the agent, shown once):\n  {}\n", key.plaintext);
    println!("Server config:\n  LILD_API_KEYS='{client_id}:{}'", key.hash);
}
