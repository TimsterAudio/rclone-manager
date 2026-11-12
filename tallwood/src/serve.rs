//! Browser mode: serves the same UI over HTTP on the loopback interface.
//! Every RPC call must carry the per-launch token, so other local web pages
//! cannot drive the file system through this port.

use crate::core;
use include_dir::{include_dir, Dir};
use serde_json::{json, Value};
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use tiny_http::{Header, Method, Response, Server};

static UI: Dir = include_dir!("$CARGO_MANIFEST_DIR/ui");

fn token() -> String {
    let a = RandomState::new().build_hasher().finish();
    let b = RandomState::new().build_hasher().finish();
    format!("{a:016x}{b:016x}")
}

fn mime(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        _ => "application/octet-stream",
    }
}

fn header(k: &str, v: &str) -> Header {
    Header::from_bytes(k.as_bytes(), v.as_bytes()).expect("static header")
}

pub fn run(port: u16) {
    let server = match Server::http(("127.0.0.1", port)) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("tallwood: cannot listen on 127.0.0.1:{port}: {e}");
            std::process::exit(1);
        }
    };
    let token = std::env::var("TALLWOOD_TOKEN").unwrap_or_else(|_| token());
    println!("Tallwood is running at http://127.0.0.1:{port}/?t={token}");

    for mut req in server.incoming_requests() {
        let token = token.clone();
        std::thread::spawn(move || {
            let url = req.url().split('?').next().unwrap_or("/").to_string();
            if req.method() == &Method::Post && url == "/rpc" {
                let authorised = req
                    .headers()
                    .iter()
                    .any(|h| h.field.equiv("x-tallwood-token") && h.value.as_str() == token);
                if !authorised {
                    let _ = req.respond(Response::from_string("forbidden").with_status_code(403));
                    return;
                }
                let mut body = String::new();
                let _ = req.as_reader().read_to_string(&mut body);
                let out = match serde_json::from_str::<Value>(&body) {
                    Ok(v) => {
                        let method = v.get("method").and_then(|m| m.as_str()).unwrap_or("");
                        let params = v.get("params").cloned().unwrap_or(Value::Null);
                        match core::dispatch(method, &params) {
                            Ok(ok) => json!({ "ok": ok }),
                            Err(err) => json!({ "err": err }),
                        }
                    }
                    Err(e) => json!({ "err": e.to_string() }),
                };
                let _ = req.respond(
                    Response::from_string(out.to_string())
                        .with_header(header("Content-Type", "application/json")),
                );
                return;
            }
            let rel = if url == "/" {
                "index.html"
            } else {
                url.trim_start_matches('/')
            };
            match UI.get_file(rel) {
                Some(f) => {
                    let _ = req.respond(
                        Response::from_data(f.contents())
                            .with_header(header("Content-Type", mime(rel)))
                            .with_header(header("Cache-Control", "no-store")),
                    );
                }
                None => {
                    let _ = req.respond(Response::from_string("not found").with_status_code(404));
                }
            }
        });
    }
}
