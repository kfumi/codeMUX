#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::process::Command;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[tauri::command]
pub fn get_system_fonts() -> Result<Vec<String>, String> {
    let fonts = enumerate_system_fonts().map_err(|error| error.to_string())?;
    Ok(standardize_fonts(fonts))
}

fn enumerate_system_fonts() -> Result<Vec<String>, Box<dyn std::error::Error>> {
    #[cfg(target_os = "windows")]
    {
        return enumerate_windows_fonts();
    }
    #[cfg(target_os = "macos")]
    {
        return enumerate_macos_fonts();
    }
    #[cfg(target_os = "linux")]
    {
        return enumerate_linux_fonts();
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Ok(Vec::new())
    }
}

#[cfg(target_os = "windows")]
fn enumerate_windows_fonts() -> Result<Vec<String>, Box<dyn std::error::Error>> {
    const SCRIPT: &str = r#"
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::UTF8
Add-Type -AssemblyName PresentationCore
$names = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($family in [Windows.Media.Fonts]::SystemFontFamilies) {
  $name = $null
  $zh = [Windows.Markup.XmlLanguage]::GetLanguage('zh-cn')
  $en = [Windows.Markup.XmlLanguage]::GetLanguage('en-us')
  if ($family.FamilyNames.ContainsKey($zh)) {
    $name = $family.FamilyNames.GetValue($zh)
  }
  if (-not $name -and $family.FamilyNames.ContainsKey($en)) {
    $name = $family.FamilyNames.GetValue($en)
  }
  if (-not $name) { $name = $family.Source }
  if ($name) { [void]$names.Add([string]$name) }
}
$names | Sort-Object
"#;

    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;

    if !output.status.success() {
        return enumerate_windows_fonts_fallback();
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let fonts: Vec<String> = stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect();

    if fonts.is_empty() {
        return enumerate_windows_fonts_fallback();
    }

    Ok(fonts)
}

#[cfg(target_os = "windows")]
fn enumerate_windows_fonts_fallback() -> Result<Vec<String>, Box<dyn std::error::Error>> {
    const SCRIPT: &str = r#"
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::UTF8
$shell = New-Object -ComObject Shell.Application
$fontsFolder = $shell.Namespace(0x14)
$names = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($item in $fontsFolder.Items()) {
  if ($item.Name) { [void]$names.Add([string]$item.Name) }
}
$names | Sort-Object
"#;

    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;

    if !output.status.success() {
        return Ok(Vec::new());
    }

    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect())
}

#[cfg(target_os = "macos")]
fn enumerate_macos_fonts() -> Result<Vec<String>, Box<dyn std::error::Error>> {
    if let Ok(fonts) = run_lines_command("fc-list", &["-f", "%{family[0]}\n"]) {
        if !fonts.is_empty() {
            return Ok(fonts);
        }
    }

    let output = Command::new("system_profiler")
        .args(["SPFontsDataType"])
        .output()?;

    if !output.status.success() {
        return Ok(Vec::new());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            trimmed
                .strip_prefix("Family:")
                .or_else(|| trimmed.strip_prefix("Full Name:"))
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .collect())
}

#[cfg(target_os = "linux")]
fn enumerate_linux_fonts() -> Result<Vec<String>, Box<dyn std::error::Error>> {
    if let Ok(fonts) = run_lines_command("fc-list", &["-f", "%{family[0]}\n"]) {
        if !fonts.is_empty() {
            return Ok(fonts);
        }
    }

    run_lines_command("fc-list2", &[])
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn run_lines_command(
    program: &str,
    args: &[&str],
) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let output = Command::new(program).args(args).output()?;
    if !output.status.success() {
        return Ok(Vec::new());
    }

    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect())
}

fn standardize_fonts(fonts: Vec<String>) -> Vec<String> {
    let mut normalized: Vec<String> = fonts
        .into_iter()
        .map(|font| normalize_font_name(&font))
        .filter(|font| !font.is_empty())
        .collect();

    normalized.sort_by(|left, right| left.to_lowercase().cmp(&right.to_lowercase()));

    let mut deduped = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for font in normalized {
        let key = font.to_lowercase();
        if seen.insert(key) {
            deduped.push(font);
        }
    }
    deduped
}

fn normalize_font_name(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"') {
        return trimmed[1..trimmed.len() - 1].trim().to_string();
    }
    trimmed.to_string()
}

#[cfg(test)]
mod tests {
    use super::{normalize_font_name, standardize_fonts};

    #[test]
    fn standardize_strips_quotes_sorts_and_dedupes() {
        let fonts = standardize_fonts(vec![
            "\"Segoe UI\"".to_string(),
            "  Microsoft YaHei UI ".to_string(),
            "segoe ui".to_string(),
            "".to_string(),
        ]);

        assert_eq!(fonts, vec!["Microsoft YaHei UI", "Segoe UI"]);
    }

    #[test]
    fn normalize_font_name_handles_plain_and_quoted_names() {
        assert_eq!(normalize_font_name(" Inter "), "Inter");
        assert_eq!(normalize_font_name("\"IBM Plex Sans\""), "IBM Plex Sans");
    }
}
