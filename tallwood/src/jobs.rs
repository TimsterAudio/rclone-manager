//! Long-running copy / move / delete jobs with progress and cancellation.
//! The UI starts a job, then polls `job_status` until it reports `finished`.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

#[derive(Default, Clone)]
struct Status {
    total_bytes: u64,
    done_bytes: u64,
    total_files: u64,
    done_files: u64,
    skipped: u64,
    current: String,
    errors: Vec<String>,
    finished: bool,
}

#[derive(Default)]
struct Job {
    cancel: AtomicBool,
    st: Mutex<Status>,
}

impl Job {
    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }
    fn with<R>(&self, f: impl FnOnce(&mut Status) -> R) -> R {
        f(&mut self.st.lock().unwrap_or_else(|e| e.into_inner()))
    }
    fn fail(&self, path: &Path, e: impl std::fmt::Display) {
        self.with(|s| s.errors.push(format!("{}: {e}", path.display())));
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Policy {
    Overwrite,
    Skip,
    Rename,
}

static NEXT: AtomicU64 = AtomicU64::new(1);

fn jobs() -> &'static Mutex<HashMap<u64, Arc<Job>>> {
    static JOBS: OnceLock<Mutex<HashMap<u64, Arc<Job>>>> = OnceLock::new();
    JOBS.get_or_init(Default::default)
}

fn job_of(p: &Value) -> Result<(u64, Arc<Job>), String> {
    let id = p
        .get("id")
        .and_then(|v| v.as_u64())
        .ok_or("missing parameter 'id'")?;
    let job = jobs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&id)
        .cloned()
        .ok_or("unknown job")?;
    Ok((id, job))
}

pub fn start(p: &Value) -> Result<Value, String> {
    let kind = crate::core::s(p, "kind")?;
    if !["copy", "move", "delete"].contains(&kind.as_str()) {
        return Err(format!("unknown job kind '{kind}'"));
    }
    let policy = match p.get("policy").and_then(|v| v.as_str()).unwrap_or("skip") {
        "overwrite" => Policy::Overwrite,
        "rename" => Policy::Rename,
        _ => Policy::Skip,
    };
    let use_trash = p.get("trash").and_then(|v| v.as_bool()).unwrap_or(true);
    let mut items: Vec<(PathBuf, PathBuf)> = Vec::new();
    for it in p
        .get("items")
        .and_then(|v| v.as_array())
        .ok_or("missing parameter 'items'")?
    {
        let src = it
            .get("src")
            .and_then(|v| v.as_str())
            .ok_or("item without 'src'")?;
        let dst = it.get("dst").and_then(|v| v.as_str()).unwrap_or("");
        if kind != "delete" && dst.is_empty() {
            return Err("item without 'dst'".into());
        }
        items.push((PathBuf::from(src), PathBuf::from(dst)));
    }

    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let job = Arc::new(Job::default());
    jobs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id, job.clone());
    std::thread::spawn(move || {
        match kind.as_str() {
            "delete" => run_delete(&job, &items, use_trash),
            _ => run_transfer(&job, &items, policy, kind == "move"),
        }
        job.with(|s| s.finished = true);
    });
    Ok(json!(id))
}

pub fn status(p: &Value) -> Result<Value, String> {
    let (id, job) = job_of(p)?;
    let s = job.with(|s| s.clone());
    if s.finished {
        jobs().lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    }
    Ok(json!({
        "total_bytes": s.total_bytes,
        "done_bytes": s.done_bytes,
        "total_files": s.total_files,
        "done_files": s.done_files,
        "skipped": s.skipped,
        "current": s.current,
        "errors": s.errors,
        "finished": s.finished,
        "cancelled": job.cancelled(),
    }))
}

pub fn cancel(p: &Value) -> Result<Value, String> {
    job_of(p)?.1.cancel.store(true, Ordering::Relaxed);
    Ok(Value::Null)
}

/// (bytes, files) below a path, without following links.
fn measure(p: &Path) -> (u64, u64) {
    let Ok(md) = fs::symlink_metadata(p) else {
        return (0, 0);
    };
    if !md.is_dir() {
        return (md.len(), 1);
    }
    let mut total = (0, 0);
    if let Ok(rd) = fs::read_dir(p) {
        for e in rd.flatten() {
            let (b, f) = measure(&e.path());
            total.0 += b;
            total.1 += f;
        }
    }
    total
}

/// `report.txt` -> `report (2).txt`, counting up until the name is free.
fn unique(dst: &Path) -> PathBuf {
    let stem = dst
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = dst
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let dir = dst.parent().unwrap_or(Path::new(""));
    (2..)
        .map(|i| dir.join(format!("{stem} ({i}){ext}")))
        .find(|c| fs::symlink_metadata(c).is_err())
        .expect("unbounded search")
}

fn exists(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok()
}

/// Returns Ok(false) when cancelled part-way (the partial file is removed).
fn copy_file(job: &Job, src: &Path, dst: &Path) -> io::Result<bool> {
    let mut r = fs::File::open(src)?;
    let md = r.metadata()?;
    let mut w = fs::File::create(dst)?;
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        if job.cancelled() {
            drop(w);
            let _ = fs::remove_file(dst);
            return Ok(false);
        }
        let n = r.read(&mut buf)?;
        if n == 0 {
            break;
        }
        w.write_all(&buf[..n])?;
        job.with(|s| s.done_bytes += n as u64);
    }
    if let Ok(t) = md.modified() {
        let _ = w.set_modified(t);
    }
    drop(w);
    let _ = fs::set_permissions(dst, md.permissions());
    Ok(true)
}

/// Copies `src` to `dst` recursively. With `mv`, each source is removed once it
/// has safely arrived. Returns true only if everything below `src` was transferred.
fn copy_tree(job: &Job, src: &Path, dst: &Path, policy: Policy, top: bool, mv: bool) -> bool {
    if job.cancelled() {
        return false;
    }
    let md = match fs::symlink_metadata(src) {
        Ok(m) => m,
        Err(e) => {
            job.fail(src, e);
            return false;
        }
    };

    if md.is_dir() {
        let mut dst = dst.to_path_buf();
        if top && policy == Policy::Rename && exists(&dst) {
            dst = unique(&dst);
        }
        if let Err(e) = fs::create_dir_all(&dst) {
            job.fail(&dst, e);
            return false;
        }
        let rd = match fs::read_dir(src) {
            Ok(rd) => rd,
            Err(e) => {
                job.fail(src, e);
                return false;
            }
        };
        let mut complete = true;
        for ent in rd.flatten() {
            complete &= copy_tree(
                job,
                &ent.path(),
                &dst.join(ent.file_name()),
                policy,
                false,
                mv,
            );
        }
        if complete && mv {
            if let Err(e) = fs::remove_dir(src) {
                job.fail(src, e);
            }
        }
        return complete;
    }

    let mut dst = dst.to_path_buf();
    if exists(&dst) {
        match policy {
            Policy::Skip => {
                job.with(|s| {
                    s.skipped += 1;
                    s.done_files += 1;
                    s.done_bytes += md.len();
                });
                return false;
            }
            Policy::Rename => dst = unique(&dst),
            Policy::Overwrite => {}
        }
    }
    job.with(|s| s.current = src.to_string_lossy().to_string());

    let copied = if md.file_type().is_symlink() {
        copy_link(src, &dst).map(|_| true)
    } else {
        copy_file(job, src, &dst)
    };
    match copied {
        Ok(true) => {
            job.with(|s| s.done_files += 1);
            if mv {
                if let Err(e) = fs::remove_file(src) {
                    job.fail(src, e);
                }
            }
            true
        }
        Ok(false) => false,
        Err(e) => {
            job.fail(src, e);
            false
        }
    }
}

#[cfg(unix)]
fn copy_link(src: &Path, dst: &Path) -> io::Result<()> {
    if exists(dst) {
        fs::remove_file(dst)?;
    }
    std::os::unix::fs::symlink(fs::read_link(src)?, dst)
}
#[cfg(not(unix))]
fn copy_link(src: &Path, dst: &Path) -> io::Result<()> {
    // Creating links needs elevation on Windows; copy what the link points at.
    fs::copy(src, dst).map(|_| ())
}

fn run_transfer(job: &Job, items: &[(PathBuf, PathBuf)], policy: Policy, mv: bool) {
    let sizes: Vec<(u64, u64)> = items.iter().map(|(src, _)| measure(src)).collect();
    job.with(|s| {
        s.total_bytes = sizes.iter().map(|x| x.0).sum();
        s.total_files = sizes.iter().map(|x| x.1).sum();
    });

    for ((src, dst), (bytes, files)) in items.iter().zip(sizes) {
        if job.cancelled() {
            return;
        }
        job.with(|s| s.current = src.to_string_lossy().to_string());

        if src == dst && policy != Policy::Rename {
            job.fail(src, "source and destination are the same");
            continue;
        }
        if dst.starts_with(src) && src != dst {
            job.fail(src, "cannot copy a folder into itself");
            continue;
        }
        if let Some(parent) = dst.parent() {
            if let Err(e) = fs::create_dir_all(parent) {
                job.fail(parent, e);
                continue;
            }
        }

        if mv {
            // A rename is instant when it stays on one volume; otherwise fall
            // through to copy-then-remove.
            let mut target = dst.clone();
            let taken = exists(&target);
            if taken && policy == Policy::Rename {
                target = unique(&target);
            }
            let src_is_dir = fs::symlink_metadata(src)
                .map(|m| m.is_dir())
                .unwrap_or(false);
            let may_rename = !exists(&target)
                || (policy == Policy::Overwrite && !src_is_dir && !target.is_dir());
            if may_rename && fs::rename(src, &target).is_ok() {
                job.with(|s| {
                    s.done_bytes += bytes;
                    s.done_files += files;
                });
                continue;
            }
            copy_tree(job, src, &target, policy, true, true);
        } else {
            copy_tree(job, src, dst, policy, true, false);
        }
    }
}

fn run_delete(job: &Job, items: &[(PathBuf, PathBuf)], use_trash: bool) {
    job.with(|s| s.total_files = items.len() as u64);
    for (path, _) in items {
        if job.cancelled() {
            return;
        }
        job.with(|s| s.current = path.to_string_lossy().to_string());
        let result: Result<(), String> = if use_trash {
            trash::delete(path).map_err(|e| e.to_string())
        } else {
            match fs::symlink_metadata(path) {
                Ok(md) if md.is_dir() => fs::remove_dir_all(path),
                Ok(_) => fs::remove_file(path),
                Err(e) => Err(e),
            }
            .map_err(|e| e.to_string())
        };
        if let Err(e) = result {
            job.fail(path, e);
        }
        job.with(|s| s.done_files += 1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(kind: &str, policy: &str, items: Value) -> Value {
        let id = start(&json!({ "kind": kind, "policy": policy, "trash": false, "items": items }))
            .unwrap();
        loop {
            let s = status(&json!({ "id": id })).unwrap();
            if s["finished"] == true {
                return s;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }

    fn tree() -> tempfile::TempDir {
        let t = tempfile::tempdir().unwrap();
        fs::create_dir_all(t.path().join("src/inner")).unwrap();
        fs::write(t.path().join("src/a.txt"), b"alpha").unwrap();
        fs::write(t.path().join("src/inner/b.txt"), b"beta!").unwrap();
        fs::create_dir(t.path().join("dst")).unwrap();
        t
    }

    #[test]
    fn copies_a_tree_and_reports_progress() {
        let t = tree();
        let s = run(
            "copy",
            "skip",
            json!([{ "src": t.path().join("src"), "dst": t.path().join("dst/src") }]),
        );
        assert_eq!(s["errors"].as_array().unwrap().len(), 0);
        assert_eq!(s["done_files"], 2);
        assert_eq!(s["done_bytes"], 10);
        assert_eq!(
            fs::read(t.path().join("dst/src/inner/b.txt")).unwrap(),
            b"beta!"
        );
        assert!(t.path().join("src/a.txt").exists());
    }

    #[test]
    fn conflict_policies() {
        let t = tree();
        let src = t.path().join("src/a.txt");
        let dst = t.path().join("dst/a.txt");
        fs::write(&dst, b"old").unwrap();
        let item = json!([{ "src": src, "dst": dst }]);

        let s = run("copy", "skip", item.clone());
        assert_eq!(s["skipped"], 1);
        assert_eq!(fs::read(&dst).unwrap(), b"old");

        run("copy", "rename", item.clone());
        assert_eq!(fs::read(t.path().join("dst/a (2).txt")).unwrap(), b"alpha");
        assert_eq!(fs::read(&dst).unwrap(), b"old");

        run("copy", "overwrite", item);
        assert_eq!(fs::read(&dst).unwrap(), b"alpha");
    }

    #[test]
    fn move_renames_and_merges() {
        let t = tree();
        // Plain move.
        run(
            "move",
            "skip",
            json!([{ "src": t.path().join("src/a.txt"), "dst": t.path().join("dst/a.txt") }]),
        );
        assert!(!t.path().join("src/a.txt").exists());
        assert!(t.path().join("dst/a.txt").exists());

        // Moving a folder onto an existing folder merges it and keeps skipped files at the source.
        fs::create_dir_all(t.path().join("dst/src/inner")).unwrap();
        fs::write(t.path().join("dst/src/inner/b.txt"), b"keep").unwrap();
        fs::write(t.path().join("src/c.txt"), b"c").unwrap();
        let s = run(
            "move",
            "skip",
            json!([{ "src": t.path().join("src"), "dst": t.path().join("dst/src") }]),
        );
        assert_eq!(s["skipped"], 1);
        assert_eq!(
            fs::read(t.path().join("dst/src/inner/b.txt")).unwrap(),
            b"keep"
        );
        assert!(t.path().join("dst/src/c.txt").exists());
        assert!(!t.path().join("src/c.txt").exists());
        assert!(t.path().join("src/inner/b.txt").exists());
    }

    #[test]
    fn refuses_same_path_and_copy_into_self() {
        let t = tree();
        let a = t.path().join("src/a.txt");
        let s = run("copy", "overwrite", json!([{ "src": a, "dst": a }]));
        assert_eq!(s["errors"].as_array().unwrap().len(), 1);
        assert_eq!(fs::read(&a).unwrap(), b"alpha");

        let s = run(
            "copy",
            "skip",
            json!([{ "src": t.path().join("src"), "dst": t.path().join("src/inner/src") }]),
        );
        assert_eq!(s["errors"].as_array().unwrap().len(), 1);

        // Duplicating in place is allowed with the rename policy.
        run("copy", "rename", json!([{ "src": a, "dst": a }]));
        assert!(t.path().join("src/a (2).txt").exists());
    }

    #[test]
    fn deletes_files_and_folders_and_reports_missing() {
        let t = tree();
        let s = run(
            "delete",
            "skip",
            json!([{ "src": t.path().join("src") }, { "src": t.path().join("nope") }]),
        );
        assert!(!t.path().join("src").exists());
        assert_eq!(s["errors"].as_array().unwrap().len(), 1);
        assert_eq!(s["done_files"], 2);
    }

    #[test]
    fn rejects_bad_requests() {
        assert!(start(&json!({ "kind": "format", "items": [] })).is_err());
        assert!(start(&json!({ "kind": "copy", "items": [{ "src": "/a" }] })).is_err());
        assert!(status(&json!({ "id": 999_999 })).is_err());
    }

    #[test]
    fn unique_counts_up() {
        let t = tempfile::tempdir().unwrap();
        fs::write(t.path().join("x.tar"), b"").unwrap();
        fs::write(t.path().join("x (2).tar"), b"").unwrap();
        assert_eq!(unique(&t.path().join("x.tar")), t.path().join("x (3).tar"));
    }
}
