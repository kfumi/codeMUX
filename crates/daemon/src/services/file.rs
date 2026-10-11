use base64::{engine::general_purpose::STANDARD, Engine as _};
use log::{debug, info};
use serde::Serialize;

const MAX_IMAGE_PREVIEW_BYTES: u64 = 8 * 1024 * 1024;

/// 读取并编码可安全内嵌到界面的常见栅格图片。
/// 路径必须绝对；调用方还必须经过 Companion 鉴权。
pub fn read_image_preview(path: String) -> Result<String, String> {
    let requested_path = std::path::PathBuf::from(path);
    if !requested_path.is_absolute() {
        return Err("图片预览只接受绝对路径".to_string());
    }

    let canonical = requested_path
        .canonicalize()
        .map_err(|error| format!("无法打开图片文件: {error}"))?;
    if !canonical.is_file() {
        return Err("图片预览目标不是文件".to_string());
    }

    let metadata =
        std::fs::metadata(&canonical).map_err(|error| format!("无法读取图片文件信息: {error}"))?;
    if metadata.len() > MAX_IMAGE_PREVIEW_BYTES {
        return Err("图片超过 8 MiB 预览上限".to_string());
    }

    let bytes = std::fs::read(&canonical).map_err(|error| format!("读取图片文件失败: {error}"))?;
    if bytes.len() as u64 > MAX_IMAGE_PREVIEW_BYTES {
        return Err("图片超过 8 MiB 预览上限".to_string());
    }
    let mime_type = sniff_preview_image_mime(&bytes)
        .ok_or_else(|| "文件内容不是受支持的图片格式".to_string())?;

    Ok(format!(
        "data:{mime_type};base64,{}",
        STANDARD.encode(bytes)
    ))
}

fn sniff_preview_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp")
    } else if bytes.len() >= 12
        && &bytes[4..8] == b"ftyp"
        && matches!(&bytes[8..12], b"avif" | b"avis")
    {
        Some("image/avif")
    } else {
        None
    }
}

/// Resolve a file path against an optional base path, with security validation.
/// Returns the canonical path if it passes the security check.
fn resolve_secure_path(
    path: &str,
    base_path: Option<String>,
) -> Result<std::path::PathBuf, String> {
    let base = if let Some(bp) = base_path {
        std::path::PathBuf::from(bp)
    } else {
        std::env::current_dir().map_err(|e| e.to_string())?
    };

    let full_path = if std::path::Path::new(path).is_absolute() {
        std::path::PathBuf::from(path)
    } else {
        base.join(path)
    };

    // Security: ensure the resolved path is under the base directory
    let canonical = full_path
        .canonicalize()
        .map_err(|e| format!("File not found: {} (path: {})", e, full_path.display()))?;
    let canonical_base = base.canonicalize().map_err(|e| e.to_string())?;
    if !canonical.starts_with(&canonical_base) {
        return Err("Access denied: path outside project directory".to_string());
    }

    Ok(canonical)
}

/// Resolve a file path for write/delete operations.
/// For new files, the parent directory must exist and be within the base path.
fn resolve_secure_path_for_write(
    path: &str,
    base_path: Option<String>,
) -> Result<std::path::PathBuf, String> {
    let base = if let Some(bp) = base_path {
        std::path::PathBuf::from(bp)
    } else {
        std::env::current_dir().map_err(|e| e.to_string())?
    };

    let full_path = if std::path::Path::new(path).is_absolute() {
        std::path::PathBuf::from(path)
    } else {
        base.join(path)
    };

    // For write operations, check the parent directory exists and is within base
    let parent = full_path
        .parent()
        .ok_or("Invalid path: no parent directory")?;
    let canonical_parent = parent.canonicalize().map_err(|e| {
        format!(
            "Parent directory not found: {} (path: {})",
            e,
            parent.display()
        )
    })?;
    let canonical_base = base.canonicalize().map_err(|e| e.to_string())?;
    if !canonical_parent.starts_with(&canonical_base) {
        return Err("Access denied: path outside project directory".to_string());
    }

    Ok(full_path)
}

pub fn read_file(path: String, base_path: Option<String>) -> Result<String, String> {
    let canonical = resolve_secure_path(&path, base_path)?;
    debug!(target: "file", "Reading file path={}", canonical.display());
    std::fs::read_to_string(&canonical).map_err(|e| format!("Failed to read file: {}", e))
}

/// Write content to a file. Creates the file if it doesn't exist.
pub fn write_file(path: String, content: String, base_path: Option<String>) -> Result<(), String> {
    let full_path = resolve_secure_path_for_write(&path, base_path)?;
    info!(target: "file", "Writing file path={} bytes={}", full_path.display(), content.len());
    // Create parent directories if they don't exist
    if let Some(parent) = full_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }
    std::fs::write(&full_path, content).map_err(|e| format!("Failed to write file: {}", e))
}

/// Delete a file from disk.
pub fn delete_file(path: String, base_path: Option<String>) -> Result<(), String> {
    let canonical = resolve_secure_path(&path, base_path)?;
    if !canonical.is_file() {
        return Err(format!("Not a file: {}", canonical.display()));
    }
    info!(target: "file", "Deleting file path={}", canonical.display());
    std::fs::remove_file(&canonical).map_err(|e| format!("Failed to delete file: {}", e))
}

#[derive(Serialize, Clone)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<FileNode>>,
}

/// List directory contents as a tree structure.
/// Excludes common large directories. Hidden entries can be included by the caller.
pub fn list_directory(
    path: String,
    base_path: Option<String>,
    depth: Option<u32>,
    include_hidden: Option<bool>,
) -> Result<Vec<FileNode>, String> {
    debug!(target: "file", "Listing directory path={} depth={}", path, depth.unwrap_or(2));
    // Use provided base_path as security base, or fall back to current_dir
    let base = if let Some(bp) = base_path {
        std::path::PathBuf::from(bp)
    } else {
        std::env::current_dir().map_err(|e| e.to_string())?
    };
    let canonical_base = base
        .canonicalize()
        .map_err(|e| format!("Base path not found: {}", e))?;

    let dir = std::path::PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }
    let canonical = dir
        .canonicalize()
        .map_err(|e| format!("Path not found: {}", e))?;
    if !canonical.starts_with(&canonical_base) {
        return Err("Access denied: path outside project directory".to_string());
    }

    // Cap depth at 5 to prevent huge responses
    let max_depth = depth.unwrap_or(2).min(5);
    list_dir_recursive(
        &canonical,
        max_depth,
        &canonical_base,
        include_hidden.unwrap_or(false),
    )
}

fn list_dir_recursive(
    dir: &std::path::Path,
    remaining_depth: u32,
    canonical_base: &std::path::Path,
    include_hidden: bool,
) -> Result<Vec<FileNode>, String> {
    let excluded = [
        ".git",
        "node_modules",
        "target",
        ".next",
        "dist",
        ".venv",
        "__pycache__",
        ".turbo",
        ".cache",
        "build",
    ];

    let mut entries: Vec<FileNode> = Vec::new();
    let read_dir = std::fs::read_dir(dir).map_err(|e| format!("Failed to read dir: {}", e))?;

    for entry in read_dir {
        // Skip entries that can't be read (permission denied, etc.)
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let file_name = entry.file_name().to_string_lossy().to_string();

        let is_excluded = excluded.contains(&file_name.as_str());
        if is_excluded && !(include_hidden && file_name == ".git") {
            continue;
        }
        // Skip hidden files/dirs unless the project explorer explicitly asks for them.
        if !include_hidden && file_name.starts_with('.') {
            continue;
        }

        let path = entry.path();

        // Use symlink_metadata to detect symlinks and skip them (prevents symlink traversal)
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if metadata.file_type().is_symlink() {
            continue;
        }

        let is_dir = metadata.is_dir();

        // Security: canonicalize and verify each child stays within the base directory
        if is_dir {
            if let Ok(canonical_child) = path.canonicalize() {
                if !canonical_child.starts_with(canonical_base) {
                    continue;
                }
            }
        }

        // Normalize path to forward slashes, stripping Windows extended-length prefix
        let path_str = path.to_string_lossy().replace('\\', "/");
        let path_str = match path_str.strip_prefix("//?/") {
            Some(s) => s.to_string(),
            None => path_str,
        };

        let children = if is_dir && remaining_depth > 0 && !is_excluded {
            Some(list_dir_recursive(
                &path,
                remaining_depth - 1,
                canonical_base,
                include_hidden,
            )?)
        } else {
            None
        };

        entries.push(FileNode {
            name: file_name,
            path: path_str,
            is_dir,
            children,
        });
    }

    // Sort: directories first, then files, each alphabetically
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

#[cfg(test)]
mod image_preview_tests {
    use super::{read_image_preview, MAX_IMAGE_PREVIEW_BYTES};
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    #[test]
    fn returns_a_data_url_for_an_absolute_png_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("screenshot.bin");
        let bytes = b"\x89PNG\r\n\x1a\nminimal-png";
        std::fs::write(&path, bytes).unwrap();

        let preview = read_image_preview(path.to_string_lossy().into_owned()).unwrap();

        assert_eq!(
            preview,
            format!("data:image/png;base64,{}", STANDARD.encode(bytes))
        );
    }

    #[test]
    fn rejects_non_image_files() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("not-an-image.txt");
        std::fs::write(&path, b"plain text").unwrap();

        let error = read_image_preview(path.to_string_lossy().into_owned()).unwrap_err();

        assert!(error.contains("不是受支持的图片格式"));
    }

    #[test]
    fn rejects_images_over_the_preview_size_limit_before_reading_them() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("large.png");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_IMAGE_PREVIEW_BYTES + 1).unwrap();

        let error = read_image_preview(path.to_string_lossy().into_owned()).unwrap_err();

        assert!(error.contains("8 MiB"));
    }
}
