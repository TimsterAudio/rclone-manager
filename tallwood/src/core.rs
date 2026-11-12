//! File-system RPC surface shared by the desktop window and browser mode.

use crate::jobs;
use base64::Engine;
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::UNIX_EPOCH;

static START: OnceLock<String> = OnceLock::new();

pub fn set_start_path(p: &str) {
    let abs = fs::canonicalize(p).unwrap_or_else(|_| PathBuf::from(p));
    let _ = START.set(clean(&abs.to_string_lossy()));
}

/// Windows canonical paths come back as `\\?\C:\…`; show the plain form.
fn clean(p: &str) -> String {
    p.strip_prefix(r"\\?\").unwrap_or(p).to_string()
}

fn err<T: std::fmt::Display>(e: T) -> String {
    e.to_string()
}

pub fn s(p: &Value, k: &str) -> Result<String, String> {
    p.get(k)
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| format!("missing parameter '{k}'"))
}

pub fn dispatch(method: &str, p: &Value) -> Result<Value, String> {
    match method {
        "init" => Ok(init()),
        "roots" => Ok(roots()),
        "list" => list(&s(p, "path")?),
        "walk" => {
            let max = p.get("max").and_then(|v| v.as_u64()).unwrap_or(300_000) as usize;
            let hidden = p.get("hidden").and_then(|v| v.as_bool()).unwrap_or(false);
            Ok(walk(&s(p, "path")?, max, hidden))
        }
        "disk" => Ok(disk(&s(p, "path")?)),
        "stat" => stat(&s(p, "path")?),
        "exists" => {
            let paths = p
                .get("paths")
                .and_then(|v| v.as_array())
                .ok_or("missing parameter 'paths'")?;
            Ok(Value::Array(
                paths
                    .iter()
                    .map(|x| {
                        Value::Bool(x.as_str().is_some_and(|x| fs::symlink_metadata(x).is_ok()))
                    })
                    .collect(),
            ))
        }
        "read" => {
            let offset = p.get("offset").and_then(|v| v.as_u64()).unwrap_or(0);
            let len = p
                .get("len")
                .and_then(|v| v.as_u64())
                .unwrap_or(65536)
                .min(32 << 20);
            read(&s(p, "path")?, offset, len as usize)
        }
        "mkdir" => fs::create_dir_all(s(p, "path")?)
            .map(|_| Value::Null)
            .map_err(err),
        "touch" => fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(s(p, "path")?)
            .map(|_| Value::Null)
            .map_err(err),
        "open" => open::that_detached(s(p, "path")?)
            .map(|_| Value::Null)
            .map_err(err),
        "terminal" => terminal(&s(p, "path")?),
        "config_get" => Ok(fs::read_to_string(config_path())
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or(Value::Null)),
        "config_set" => {
            let path = config_path();
            if let Some(dir) = path.parent() {
                fs::create_dir_all(dir).map_err(err)?;
            }
            let data = p.get("data").cloned().unwrap_or(Value::Null);
            fs::write(path, serde_json::to_string_pretty(&data).map_err(err)?).map_err(err)?;
            Ok(Value::Null)
        }
        "job_start" => jobs::start(p),
        "job_status" => jobs::status(p),
        "job_cancel" => jobs::cancel(p),
        other => Err(format!("unknown method '{other}'")),
    }
}

fn config_path() -> PathBuf {
    if let Ok(p) = std::env::var("TALLWOOD_CONFIG") {
        return PathBuf::from(p);
    }
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("tallwood")
        .join("config.json")
}

fn init() -> Value {
    let home = dirs::home_dir()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|| "/".into());
    json!({
        "home": home,
        "start": START.get(),
        "sep": std::path::MAIN_SEPARATOR.to_string(),
        "os": std::env::consts::OS,
        "roots": roots(),
    })
}

fn mtime_ms(md: &fs::Metadata) -> i64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(unix)]
fn mode_of(md: &fs::Metadata) -> u32 {
    use std::os::unix::fs::MetadataExt;
    md.mode()
}
#[cfg(not(unix))]
fn mode_of(_md: &fs::Metadata) -> u32 {
    0
}

#[cfg(windows)]
fn is_hidden(_name: &str, md: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    md.file_attributes() & 0x2 != 0
}
#[cfg(not(windows))]
fn is_hidden(name: &str, _md: &fs::Metadata) -> bool {
    name.starts_with('.')
}

fn list(path: &str) -> Result<Value, String> {
    let dir = Path::new(path);
    let mut entries = Vec::new();
    for ent in fs::read_dir(dir).map_err(err)? {
        let Ok(ent) = ent else { continue };
        let Ok(md) = ent.metadata() else { continue };
        let name = ent.file_name().to_string_lossy().to_string();
        let link = md.file_type().is_symlink();
        // A link to a directory behaves like a directory in the tree.
        let target = if link {
            fs::metadata(ent.path()).ok()
        } else {
            None
        };
        let is_dir = target.as_ref().map(|t| t.is_dir()).unwrap_or(md.is_dir());
        let shown = target.as_ref().unwrap_or(&md);
        entries.push(json!({
            "n": name,
            "d": is_dir,
            "s": if is_dir { 0 } else { shown.len() },
            "m": mtime_ms(shown),
            "l": link,
            "h": is_hidden(&name, &md),
            "r": shown.permissions().readonly(),
            "x": mode_of(shown),
        }));
    }
    Ok(json!({ "path": path, "entries": entries }))
}

const PSEUDO_FS: [&str; 4] = ["/proc", "/sys", "/dev", "/run"];

/// Flat listing of every file below `path`.
/// Files are `[dir_index, name, size, mtime, flags]`; flags: 1 hidden, 2 read-only, 4 link.
fn walk(path: &str, max: usize, hidden: bool) -> Value {
    let mut dirs: Vec<String> = vec![path.to_string()];
    let mut files: Vec<Value> = Vec::new();
    let mut truncated = false;
    let mut i = 0;
    'outer: while i < dirs.len() {
        let dir = PathBuf::from(&dirs[i]);
        if let Ok(rd) = fs::read_dir(&dir) {
            for ent in rd.flatten() {
                let Ok(md) = ent.metadata() else { continue };
                let name = ent.file_name().to_string_lossy().to_string();
                let hid = is_hidden(&name, &md);
                if hid && !hidden {
                    continue;
                }
                if md.is_dir() {
                    let p = ent.path().to_string_lossy().to_string();
                    if !PSEUDO_FS.contains(&p.as_str()) {
                        dirs.push(p);
                    }
                } else {
                    if files.len() >= max {
                        truncated = true;
                        break 'outer;
                    }
                    let link = md.file_type().is_symlink();
                    let flags = (hid as u8)
                        | ((md.permissions().readonly() as u8) << 1)
                        | ((link as u8) << 2);
                    files.push(json!([i, name, md.len(), mtime_ms(&md), flags]));
                }
            }
        }
        i += 1;
    }
    json!({ "dirs": dirs, "files": files, "truncated": truncated })
}

fn disks() -> Vec<(String, String, u64, u64)> {
    let list = sysinfo::Disks::new_with_refreshed_list();
    let mut out: Vec<(String, String, u64, u64)> = Vec::new();
    for d in list.list() {
        let mount = d.mount_point().to_string_lossy().to_string();
        if out.iter().any(|o| o.0 == mount) {
            continue;
        }
        out.push((
            mount,
            d.name().to_string_lossy().to_string(),
            d.total_space(),
            d.available_space(),
        ));
    }
    out
}

fn roots() -> Value {
    let skip = [
        "/proc", "/sys", "/dev", "/run", "/snap", "/boot", "/etc", "/var/lib", "/usr",
    ];
    let mut out: Vec<Value> = Vec::new();
    let mut all = disks();
    all.sort_by(|a, b| a.0.cmp(&b.0));
    if cfg!(unix) && !all.iter().any(|d| d.0 == "/") {
        out.push(json!({ "path": "/", "name": "", "total": 0, "free": 0 }));
    }
    for (mount, name, total, free) in all {
        if cfg!(unix)
            && skip
                .iter()
                .any(|s| mount == *s || mount.starts_with(&format!("{s}/")))
        {
            continue;
        }
        out.push(json!({ "path": mount, "name": name, "total": total, "free": free }));
    }
    Value::Array(out)
}

fn disk(path: &str) -> Value {
    let best = disks()
        .into_iter()
        .filter(|d| Path::new(path).starts_with(&d.0))
        .max_by_key(|d| d.0.len());
    match best {
        Some((mount, name, total, free)) => {
            json!({ "path": mount, "name": name, "total": total, "free": free })
        }
        None => Value::Null,
    }
}

fn stat(path: &str) -> Result<Value, String> {
    let lmd = fs::symlink_metadata(path).map_err(err)?;
    let md = fs::metadata(path).unwrap_or_else(|_| lmd.clone());
    let ms = |t: std::io::Result<std::time::SystemTime>| {
        t.ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
    };
    Ok(json!({
        "size": md.len(),
        "dir": md.is_dir(),
        "modified": ms(md.modified()),
        "created": ms(md.created()),
        "accessed": ms(md.accessed()),
        "readonly": md.permissions().readonly(),
        "mode": mode_of(&md),
        "link": if lmd.file_type().is_symlink() {
            fs::read_link(path).ok().map(|t| t.to_string_lossy().to_string())
        } else { None },
    }))
}

fn read(path: &str, offset: u64, len: usize) -> Result<Value, String> {
    let mut f = fs::File::open(path).map_err(err)?;
    let size = f.metadata().map_err(err)?.len();
    f.seek(SeekFrom::Start(offset)).map_err(err)?;
    let mut buf = Vec::with_capacity(len.min(size as usize));
    f.take(len as u64).read_to_end(&mut buf).map_err(err)?;
    Ok(json!({ "size": size, "b64": base64::engine::general_purpose::STANDARD.encode(&buf) }))
}

fn terminal(path: &str) -> Result<Value, String> {
    use std::process::Command;
    if cfg!(windows) {
        return Command::new("cmd")
            .args(["/c", "start", "cmd"])
            .current_dir(path)
            .spawn()
            .map(|_| Value::Null)
            .map_err(err);
    }
    if cfg!(target_os = "macos") {
        return Command::new("open")
            .args(["-a", "Terminal", path])
            .spawn()
            .map(|_| Value::Null)
            .map_err(err);
    }
    let candidates = [
        "x-terminal-emulator",
        "gnome-terminal",
        "konsole",
        "xfce4-terminal",
        "kitty",
        "alacritty",
        "foot",
        "xterm",
    ];
    for c in candidates {
        if Command::new(c).current_dir(path).spawn().is_ok() {
            return Ok(Value::Null);
        }
    }
    Err("no terminal emulator found".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_reports_files_and_dirs() {
        let t = tempfile::tempdir().unwrap();
        fs::create_dir(t.path().join("sub")).unwrap();
        fs::write(t.path().join("a.txt"), b"hello").unwrap();
        let v = dispatch("list", &json!({ "path": t.path() })).unwrap();
        let e = v["entries"].as_array().unwrap();
        assert_eq!(e.len(), 2);
        let a = e.iter().find(|x| x["n"] == "a.txt").unwrap();
        assert_eq!(a["s"], 5);
        assert_eq!(a["d"], false);
        assert_eq!(e.iter().find(|x| x["n"] == "sub").unwrap()["d"], true);
    }

    #[test]
    fn list_missing_dir_is_an_error() {
        assert!(dispatch("list", &json!({ "path": "/definitely/not/here" })).is_err());
    }

    #[test]
    fn walk_flattens_and_honours_hidden_and_limit() {
        let t = tempfile::tempdir().unwrap();
        fs::create_dir_all(t.path().join("x/y")).unwrap();
        fs::write(t.path().join("x/y/deep.txt"), b"1").unwrap();
        fs::write(t.path().join("top.txt"), b"22").unwrap();
        fs::write(t.path().join(".secret"), b"333").unwrap();
        let root = t.path().to_string_lossy().to_string();

        let v = walk(&root, 100, false);
        let hidden_seen = cfg!(windows) as usize; // dot-files are not hidden on Windows
        assert_eq!(v["files"].as_array().unwrap().len(), 2 + hidden_seen);
        assert_eq!(v["dirs"].as_array().unwrap().len(), 3);
        assert_eq!(v["truncated"], false);

        assert_eq!(walk(&root, 100, true)["files"].as_array().unwrap().len(), 3);
        assert_eq!(walk(&root, 1, true)["truncated"], true);
    }

    #[test]
    fn read_returns_requested_slice() {
        let t = tempfile::tempdir().unwrap();
        let p = t.path().join("f.bin");
        fs::write(&p, b"0123456789").unwrap();
        let v = read(&p.to_string_lossy(), 2, 3).unwrap();
        assert_eq!(v["size"], 10);
        assert_eq!(v["b64"], "MjM0");
    }

    #[test]
    fn touch_refuses_to_clobber() {
        let t = tempfile::tempdir().unwrap();
        let p = t.path().join("new.txt");
        dispatch("touch", &json!({ "path": p })).unwrap();
        assert!(dispatch("touch", &json!({ "path": p })).is_err());
    }

    #[test]
    fn unknown_method_and_missing_params_are_errors() {
        assert!(dispatch("nope", &Value::Null).is_err());
        assert!(dispatch("list", &json!({})).is_err());
    }
}
