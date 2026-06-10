use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    prepare_node_runtime();
    tauri_build::build()
}

fn prepare_node_runtime() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=sidecar/dist/index.js");
    println!("cargo:rerun-if-changed=sidecar/package.json");
    println!("cargo:rerun-if-env-changed=CODEMUX_NODE_BINARY");
    println!("cargo:rerun-if-env-changed=PATH");

    let node_source = find_node_binary().expect(
        "Failed to locate Node.js for bundling. Install Node.js or set CODEMUX_NODE_BINARY.",
    );

    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is not set"));
    let runtime_dir = manifest_dir.join("target").join("node-runtime");
    fs::create_dir_all(&runtime_dir).expect("Failed to create bundled node runtime directory");

    let node_target = runtime_dir.join(node_binary_name());
    copy_if_needed(&node_source, &node_target)
        .expect("Failed to copy the bundled Node.js runtime into target/node-runtime");
}

fn node_binary_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "node.exe"
    } else {
        "node"
    }
}

fn find_node_binary() -> Option<PathBuf> {
    if let Some(explicit) = env::var_os("CODEMUX_NODE_BINARY") {
        let path = PathBuf::from(explicit);
        if path.exists() {
            return Some(path);
        }
    }

    let mut cmd = if cfg!(target_os = "windows") {
        let mut cmd = Command::new("where");
        cmd.arg("node.exe");
        cmd
    } else {
        let mut cmd = Command::new("which");
        cmd.arg("node");
        cmd
    };

    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.exists())
}

fn copy_if_needed(source: &Path, target: &Path) -> std::io::Result<()> {
    let should_copy = match (fs::metadata(source), fs::metadata(target)) {
        (Ok(source_meta), Ok(target_meta)) => {
            source_meta.len() != target_meta.len()
                || source_meta.modified().ok() != target_meta.modified().ok()
        }
        (Ok(_), Err(_)) => true,
        (Err(err), _) => return Err(err),
    };

    if should_copy {
        fs::copy(source, target)?;
    }

    Ok(())
}
