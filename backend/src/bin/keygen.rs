//! Generate an API key for a customer agent.
//! Usage: cargo run --bin keygen -- <client_id>
//!
//! The plaintext key is printed once. Give it to the agent. The server stores only the hash.

use lild_backend::auth::generate_api_key;

fn main() {
    let client_id = std::env::args()
        .nth(1)
        .expect("usage: keygen <client_id>");
    assert!(
        !client_id.is_empty() && !client_id.contains([':', ',']),
        "client_id must be non-empty and contain no ':' or ','"
    );
    let key = generate_api_key();
    println!("API key (give to the agent, shown once):\n  {}\n", key.plaintext);
    println!("Server config:\n  LILD_API_KEYS='{client_id}:{}'", key.hash);
}
