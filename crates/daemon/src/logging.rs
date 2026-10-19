//! daemon 日志:按天滚动的文件写入 + stderr 兜底。
//!
//! 结构:supervisor 过去把 daemon 的 stdout/stderr 重定向成单个 `daemon.log`,
//! daemon 自己不认识文件 —— 只能在 spawn 时封顶,跨天无法切档,单文件长跑可涨到
//! 数 MB。这里让 daemon 自己持有文件:`<logs>/daemon-YYYY-MM-DD.log`(本地时区),
//! 跨天自动切到新文件(无需重启);同一天超阈值轮转为 `.1`;只保留最近
//! `LOG_KEEP_DAYS` 天。supervisor 仍把 raw stderr(panic / 启动早期输出)落到
//! `daemon-stderr.log`。
//!
//! 写盘失败逐行回退 stderr:日志绝不拖垮 daemon。

use std::borrow::Cow;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 日志文件名 base:实际文件 `<base>-YYYY-MM-DD.log`。
pub const LOG_FILE_BASE: &str = "daemon";
/// 单日文件大小上限(超过轮转为 `.1`)。
pub const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
/// 保留的天数。
pub const LOG_KEEP_DAYS: usize = 7;
/// 单条记录最大字符数;超出截断并标注(避免整份文件/巨型 payload 进日志)。
pub const MAX_LOG_LINE_CHARS: usize = 8 * 1024;
/// 每个 base 的日志总量上限(保留日期 + `.1` 备份合计);超出从最旧删起。
pub const MAX_LOG_TOTAL_BYTES: u64 = 20 * 1024 * 1024;
/// 后台清理延迟:不跟启动/跨天路径抢 IO。
pub const PRUNE_DELAY: Duration = Duration::from_secs(3);

type Clock = Box<dyn Fn() -> String + Send + Sync>;

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

fn log_path(dir: &Path, stamp: &str) -> PathBuf {
    dir.join(format!("{LOG_FILE_BASE}-{stamp}.log"))
}

/// 打开(必要时创建)当日文件,返回句柄与既有字节数;失败返回 None。
fn open_daily(dir: &Path, stamp: &str) -> Option<(File, u64)> {
    if let Err(error) = fs::create_dir_all(dir) {
        eprintln!("codemux-daemon: 创建日志目录失败: {error}");
        return None;
    }
    let path = log_path(dir, stamp);
    match OpenOptions::new().create(true).append(true).open(&path) {
        Ok(file) => {
            let size = file.metadata().map(|meta| meta.len()).unwrap_or(0);
            Some((file, size))
        }
        Err(error) => {
            eprintln!(
                "codemux-daemon: 打开日志文件 {} 失败: {error}",
                path.display()
            );
            None
        }
    }
}

/// 从文件名解析日期戳(`daemon-YYYY-MM-DD.log[.N]` → `YYYY-MM-DD`),否则 None。
fn date_of(name: &str) -> Option<String> {
    let rest = name.strip_prefix(LOG_FILE_BASE)?.strip_prefix('-')?;
    if rest.len() < 14 {
        return None;
    }
    let (stamp, tail) = rest.split_at(10);
    if !tail.starts_with(".log") {
        return None;
    }
    let bytes = stamp.as_bytes();
    for (i, b) in bytes.iter().enumerate() {
        let ok = if i == 4 || i == 7 {
            *b == b'-'
        } else {
            b.is_ascii_digit()
        };
        if !ok {
            return None;
        }
    }
    Some(stamp.to_string())
}

/// 只保留最近 keep_days 个日期,更旧的删除(含 `.1` 轮转备份);失败静默。
fn clamp_chars(text: &str, max_chars: usize) -> Cow<'_, str> {
    match text.char_indices().nth(max_chars) {
        Some((cut, _)) => {
            let omitted = text.chars().count().saturating_sub(max_chars);
            Cow::Owned(format!("{}...[truncated {omitted} chars]", &text[..cut]))
        }
        None => Cow::Borrowed(text),
    }
}

fn prune(dir: &Path, keep_days: usize, max_total_bytes: u64, protected: Option<&Path>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(String, u32, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(stamp) = date_of(name) else {
            continue;
        };
        let index = name
            .split_once(".log")
            .and_then(|(_, rest)| rest.strip_prefix('.'))
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or(0);
        files.push((stamp, index, entry.path()));
    }

    let mut dates: Vec<String> = files.iter().map(|(stamp, _, _)| stamp.clone()).collect();
    dates.sort();
    dates.dedup();
    let expired: std::collections::HashSet<String> = if dates.len() > keep_days {
        dates[..dates.len() - keep_days].iter().cloned().collect()
    } else {
        std::collections::HashSet::new()
    };
    files.retain(|(stamp, _, path)| {
        if expired.contains(stamp) {
            let _ = fs::remove_file(path);
            false
        } else {
            true
        }
    });

    files.sort_by(|left, right| left.0.cmp(&right.0).then(left.1.cmp(&right.1)));
    let total: u64 = files
        .iter()
        .map(|(_, _, path)| fs::metadata(path).map(|meta| meta.len()).unwrap_or(0))
        .sum();
    if total <= max_total_bytes {
        return;
    }
    let newest = files.last().map(|(stamp, _, _)| stamp.clone());
    let mut remaining = total;
    for (stamp, _, path) in files {
        if remaining <= max_total_bytes {
            break;
        }
        // 当天(最新日期)文件永不按总量删除,单文件上限由 rotate_size 兜底。
        if Some(&stamp) == newest.as_ref() || protected == Some(path.as_path()) {
            continue;
        }
        let size = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
        if fs::remove_file(&path).is_ok() {
            remaining = remaining.saturating_sub(size);
        }
    }
}

struct Inner {
    dir: PathBuf,
    keep_days: usize,
    max_total_bytes: u64,
    prune_delay: Duration,
    prune_pending: Arc<AtomicBool>,
    clock: Clock,
    stamp: String,
    file: Option<File>,
    bytes: u64,
}

impl Inner {
    /// 后台清理按天保留与总量上限(同一时刻只挂一个任务)。
    fn schedule_prune(&self) {
        if self.prune_pending.swap(true, Ordering::AcqRel) {
            return;
        }
        let dir = self.dir.clone();
        let keep_days = self.keep_days;
        let max_total_bytes = self.max_total_bytes;
        let delay = self.prune_delay;
        let pending = Arc::clone(&self.prune_pending);
        let protected = log_path(&self.dir, &self.stamp);
        std::thread::spawn(move || {
            if !delay.is_zero() {
                std::thread::sleep(delay);
            }
            prune(&dir, keep_days, max_total_bytes, Some(protected.as_path()));
            pending.store(false, Ordering::Release);
        });
    }

    /// 跨天则换到新日期的文件并清理过期归档。
    fn roll_if_date_changed(&mut self) {
        let stamp = (self.clock)();
        if stamp == self.stamp {
            return;
        }
        self.stamp = stamp;
        match open_daily(&self.dir, &self.stamp) {
            Some((file, size)) => {
                self.file = Some(file);
                self.bytes = size;
            }
            None => {
                self.file = None;
                self.bytes = 0;
            }
        }
        self.schedule_prune();
    }

    /// 当日文件超阈值:关闭 → 改名 `.1`(失败则原地清空)→ 重新打开。
    fn rotate_size(&mut self) {
        self.file = None; // Windows 上必须先关闭才能改名
        let path = log_path(&self.dir, &self.stamp);
        let backup = path.with_extension("log.1");
        let _ = fs::remove_file(&backup);
        if fs::rename(&path, &backup).is_err() {
            let _ = OpenOptions::new().write(true).truncate(true).open(&path);
        }
        match open_daily(&self.dir, &self.stamp) {
            Some((file, size)) => {
                self.file = Some(file);
                self.bytes = size;
            }
            None => {
                self.file = None;
                self.bytes = 0;
            }
        }
    }
}

/// 按天滚动的文件 logger。
pub struct DailyFileLogger {
    inner: Mutex<Inner>,
}

impl DailyFileLogger {
    /// 生产构造:使用本地时区的当前日期。
    pub fn new(dir: PathBuf, keep_days: usize) -> Self {
        Self::with_clock(dir, keep_days, Box::new(today))
    }

    fn with_clock(dir: PathBuf, keep_days: usize, clock: Clock) -> Self {
        Self::with_clock_and_prune(dir, keep_days, clock, MAX_LOG_TOTAL_BYTES, PRUNE_DELAY)
    }

    fn with_clock_and_prune(
        dir: PathBuf,
        keep_days: usize,
        clock: Clock,
        max_total_bytes: u64,
        prune_delay: Duration,
    ) -> Self {
        let stamp = clock();
        let (file, bytes) = match open_daily(&dir, &stamp) {
            Some((file, size)) => (Some(file), size),
            None => (None, 0),
        };
        let logger = Self {
            inner: Mutex::new(Inner {
                dir,
                keep_days,
                max_total_bytes,
                prune_delay,
                prune_pending: Arc::new(AtomicBool::new(false)),
                clock,
                stamp,
                file,
                bytes,
            }),
        };
        if let Ok(inner) = logger.inner.lock() {
            inner.schedule_prune();
        }
        logger
    }
}

impl log::Log for DailyFileLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::Level::Info
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let rendered = record.args().to_string();
        let message = clamp_chars(&rendered, MAX_LOG_LINE_CHARS);
        let context = crate::log_ctx::prefix();
        let line = if context.is_empty() {
            format!(
                "[{} {} {}] {}\n",
                chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
                record.level(),
                record.target(),
                message
            )
        } else {
            format!(
                "[{} {} {}]{} {}\n",
                chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
                record.level(),
                record.target(),
                context,
                message
            )
        };
        let mut inner = match self.inner.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        inner.roll_if_date_changed();
        if inner.bytes >= MAX_LOG_BYTES {
            inner.rotate_size();
        }
        match inner.file.as_mut() {
            Some(file) => {
                if file
                    .write_all(line.as_bytes())
                    .and_then(|_| file.flush())
                    .is_err()
                {
                    inner.file = None;
                    eprint!("{line}");
                } else {
                    inner.bytes += line.len() as u64;
                }
            }
            None => eprint!("{line}"),
        }
    }

    fn flush(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(file) = inner.file.as_mut() {
                let _ = file.flush();
            }
        }
    }
}

/// 安装按天文件日志(daemon 主路径);文件不可用时逐行回退 stderr。
pub fn init_file(log_dir: &Path) {
    let logger = DailyFileLogger::new(log_dir.to_path_buf(), LOG_KEEP_DAYS);
    let _ = log::set_boxed_logger(Box::new(logger));
    log::set_max_level(log::LevelFilter::Info);
}

/// 安装 stderr 日志(mcp-control 子命令等短生命周期路径)。
pub fn init_stderr() {
    struct StderrLogger;

    impl log::Log for StderrLogger {
        fn enabled(&self, metadata: &log::Metadata) -> bool {
            metadata.level() <= log::Level::Info
        }

        fn log(&self, record: &log::Record) {
            if self.enabled(record.metadata()) {
                let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
                eprintln!(
                    "[{timestamp} {} {}] {}",
                    record.level(),
                    record.target(),
                    record.args()
                );
            }
        }

        fn flush(&self) {}
    }

    let _ = log::set_boxed_logger(Box::new(StderrLogger));
    log::set_max_level(log::LevelFilter::Info);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn write_record(logger: &DailyFileLogger, level: log::Level, message: &str) {
        log::Log::log(
            logger,
            &log::Record::builder()
                .args(format_args!("{message}"))
                .level(level)
                .target("test")
                .build(),
        );
    }

    #[test]
    fn writes_to_daily_file_named_by_local_date() {
        let dir = tempfile::tempdir().unwrap();
        let logger = DailyFileLogger::with_clock(
            dir.path().to_path_buf(),
            LOG_KEEP_DAYS,
            Box::new(|| "2026-01-02".to_string()),
        );
        write_record(&logger, log::Level::Info, "hello");
        write_record(&logger, log::Level::Warn, "careful");

        let content = fs::read_to_string(dir.path().join("daemon-2026-01-02.log")).unwrap();
        assert!(content.contains(" INFO test] hello"), "content={content}");
        assert!(content.contains(" WARN test] careful"), "content={content}");
    }

    #[test]
    fn rolls_to_new_file_when_date_changes() {
        let dir = tempfile::tempdir().unwrap();
        let date = Arc::new(Mutex::new("2026-01-01".to_string()));
        let handle = date.clone();
        let logger = DailyFileLogger::with_clock(
            dir.path().to_path_buf(),
            LOG_KEEP_DAYS,
            Box::new(move || handle.lock().unwrap().clone()),
        );

        write_record(&logger, log::Level::Info, "day1");
        *date.lock().unwrap() = "2026-01-02".to_string();
        write_record(&logger, log::Level::Info, "day2");

        assert!(fs::read_to_string(dir.path().join("daemon-2026-01-01.log"))
            .unwrap()
            .contains("day1"));
        assert!(fs::read_to_string(dir.path().join("daemon-2026-01-02.log"))
            .unwrap()
            .contains("day2"));
    }

    #[test]
    fn prunes_dates_beyond_retention() {
        let dir = tempfile::tempdir().unwrap();
        for day in ["2026-01-01", "2026-01-02", "2026-01-03"] {
            fs::write(dir.path().join(format!("daemon-{day}.log")), "x").unwrap();
        }
        // 打开时清理:只留最近 2 天。
        prune(dir.path(), 2, MAX_LOG_TOTAL_BYTES, None);
        assert!(!dir.path().join("daemon-2026-01-01.log").exists());
        assert!(dir.path().join("daemon-2026-01-02.log").exists());
        assert!(dir.path().join("daemon-2026-01-03.log").exists());
    }

    #[test]
    fn rotates_when_day_file_exceeds_cap() {
        let dir = tempfile::tempdir().unwrap();
        let stamp = "2026-01-05";
        let path = dir.path().join(format!("daemon-{stamp}.log"));
        fs::write(&path, vec![b'a'; MAX_LOG_BYTES as usize + 1]).unwrap();

        let logger = DailyFileLogger::with_clock(
            dir.path().to_path_buf(),
            LOG_KEEP_DAYS,
            Box::new(move || stamp.to_string()),
        );
        write_record(&logger, log::Level::Info, "after");

        assert!(dir.path().join(format!("daemon-{stamp}.log.1")).exists());
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("after"), "content={content}");
    }

    #[test]
    fn truncates_records_longer_than_limit() {
        let dir = tempfile::tempdir().unwrap();
        let logger = DailyFileLogger::with_clock_and_prune(
            dir.path().to_path_buf(),
            LOG_KEEP_DAYS,
            Box::new(|| "2026-01-02".to_string()),
            MAX_LOG_TOTAL_BYTES,
            Duration::ZERO,
        );
        let long = "x".repeat(MAX_LOG_LINE_CHARS + 100);
        write_record(&logger, log::Level::Info, &long);
        write_record(&logger, log::Level::Info, "kept");

        let content = fs::read_to_string(dir.path().join("daemon-2026-01-02.log")).unwrap();
        assert!(
            content.contains("...[truncated 100 chars]"),
            "len={}",
            content.len()
        );
        assert!(content.contains("kept"));
    }

    #[test]
    fn prune_enforces_total_bytes_from_oldest() {
        let dir = tempfile::tempdir().unwrap();
        for day in ["2026-01-01", "2026-01-02", "2026-01-03"] {
            fs::write(
                dir.path().join(format!("daemon-{day}.log")),
                vec![b'a'; 1024],
            )
            .unwrap();
        }
        prune(dir.path(), 7, 2048, None);
        assert!(!dir.path().join("daemon-2026-01-01.log").exists());
        assert!(dir.path().join("daemon-2026-01-02.log").exists());
        assert!(dir.path().join("daemon-2026-01-03.log").exists());
    }

    #[test]
    fn logger_prunes_in_background_without_blocking_startup() {
        let dir = tempfile::tempdir().unwrap();
        for day in ["2026-01-01", "2026-01-02", "2026-01-03"] {
            fs::write(dir.path().join(format!("daemon-{day}.log")), "x").unwrap();
        }
        let _logger = DailyFileLogger::with_clock_and_prune(
            dir.path().to_path_buf(),
            2,
            Box::new(|| "2026-01-03".to_string()),
            MAX_LOG_TOTAL_BYTES,
            Duration::ZERO,
        );
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while dir.path().join("daemon-2026-01-01.log").exists()
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!dir.path().join("daemon-2026-01-01.log").exists());
    }

    #[test]
    fn date_of_parses_daily_names_only() {
        assert_eq!(
            date_of("daemon-2026-01-05.log"),
            Some("2026-01-05".to_string())
        );
        assert_eq!(
            date_of("daemon-2026-01-05.log.1"),
            Some("2026-01-05".to_string())
        );
        assert_eq!(date_of("daemon-stderr.log"), None);
        assert_eq!(date_of("daemon.log"), None);
        assert_eq!(date_of("renderer-2026-01-05.log"), None);
    }
}
