#![cfg_attr(
    all(not(debug_assertions), feature = "gui"),
    windows_subsystem = "windows"
)]

mod core;
mod jobs;
mod serve;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut serve_port: Option<u16> = None;
    let mut it = args.iter().peekable();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--serve" => {
                let port = it.peek().and_then(|p| p.parse().ok());
                if port.is_some() {
                    it.next();
                }
                serve_port = Some(port.unwrap_or(7717));
            }
            "--help" | "-h" => {
                println!("tallwood [PATH]            open the file manager at PATH");
                println!(
                    "tallwood --serve [PORT]    serve the UI to a local browser (127.0.0.1 only)"
                );
                return;
            }
            p if !p.starts_with('-') => core::set_start_path(p),
            _ => {}
        }
    }

    if let Some(port) = serve_port {
        serve::run(port);
        return;
    }

    #[cfg(feature = "gui")]
    gui();
    #[cfg(not(feature = "gui"))]
    serve::run(7717);
}

#[cfg(feature = "gui")]
#[tauri::command(async)]
fn rpc(method: String, params: serde_json::Value) -> Result<serde_json::Value, String> {
    core::dispatch(&method, &params)
}

#[cfg(feature = "gui")]
fn gui() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![rpc])
        .run(tauri::generate_context!())
        .expect("failed to start Tallwood");
}
