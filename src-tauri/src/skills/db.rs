use chrono::Utc;
use rusqlite::{params, Connection, Result};
use uuid::Uuid;

use super::types::{Skill, SkillApps};

const SELECT_COLUMNS: &str = "id, name, display_name, description, enabled_claude, enabled_codex, enabled_gemini, enabled_opencode, installed_at, disk_path, directory";

/// 从数据库行构建 Skill（新 schema）
fn row_to_skill(row: &rusqlite::Row) -> rusqlite::Result<Skill> {
    let enabled_claude: i64 = row.get(4)?;
    let enabled_codex: i64 = row.get(5)?;
    let enabled_gemini: i64 = row.get(6)?;
    let enabled_opencode: i64 = row.get(7)?;
    Ok(Skill {
        id: row.get(0)?,
        name: row.get(1)?,
        display_name: row.get(2)?,
        description: row.get(3)?,
        apps: SkillApps {
            claude: enabled_claude != 0,
            codex: enabled_codex != 0,
            gemini: enabled_gemini != 0,
            opencode: enabled_opencode != 0,
        },
        installed_at: row.get(8)?,
        disk_path: row.get(9)?,
        directory: row.get(10)?,
    })
}

pub fn list_skills(conn: &Connection) -> Result<Vec<Skill>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SELECT_COLUMNS} FROM skills ORDER BY name ASC"
    ))?;
    let skills = stmt
        .query_map([], row_to_skill)?
        .collect::<Result<Vec<_>>>()?;
    Ok(skills)
}

pub fn get_skill(conn: &Connection, id: &str) -> Result<Option<Skill>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SELECT_COLUMNS} FROM skills WHERE id = ?1"
    ))?;
    let mut rows = stmt.query_map(params![id], row_to_skill)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

pub fn get_skill_by_name(conn: &Connection, name: &str) -> Result<Option<Skill>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SELECT_COLUMNS} FROM skills WHERE name = ?1"
    ))?;
    let mut rows = stmt.query_map(params![name], row_to_skill)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

pub fn upsert_skill(conn: &Connection, skill: &Skill) -> Result<()> {
    conn.execute(
        "INSERT INTO skills (id, name, display_name, description, installed_at, enabled_claude, enabled_codex, enabled_gemini, enabled_opencode, disk_path, directory)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(name) DO UPDATE SET
             display_name = excluded.display_name,
             description = excluded.description,
             installed_at = excluded.installed_at,
             disk_path = excluded.disk_path,
             directory = excluded.directory,
             enabled_claude = excluded.enabled_claude,
             enabled_codex = excluded.enabled_codex,
             enabled_gemini = excluded.enabled_gemini,
             enabled_opencode = excluded.enabled_opencode",
        params![
            skill.id,
            skill.name,
            skill.display_name,
            skill.description,
            skill.installed_at,
            skill.apps.claude as i32,
            skill.apps.codex as i32,
            skill.apps.gemini as i32,
            skill.apps.opencode as i32,
            skill.disk_path,
            skill.directory,
        ],
    )?;
    Ok(())
}

#[allow(dead_code)]
pub fn update_skill_enabled(conn: &Connection, id: &str, enabled: bool) -> Result<()> {
    conn.execute(
        "UPDATE skills SET enabled = ?1 WHERE id = ?2",
        params![enabled as i32, id],
    )?;
    Ok(())
}

pub fn set_skill_app_enabled(conn: &Connection, id: &str, app: &str, enabled: bool) -> Result<()> {
    let column = match app {
        "claude" => "enabled_claude",
        "codex" => "enabled_codex",
        "gemini" => "enabled_gemini",
        "opencode" => "enabled_opencode",
        _ => return Err(rusqlite::Error::InvalidParameterName(app.to_string())),
    };
    let sql = format!("UPDATE skills SET {column} = ?1 WHERE id = ?2");
    conn.execute(&sql, params![if enabled { 1i32 } else { 0i32 }, id])?;
    Ok(())
}

pub fn get_enabled_skill_names_for_app(conn: &Connection, app: &str) -> Result<Vec<String>> {
    let column = match app {
        "claude" => "enabled_claude",
        "codex" => "enabled_codex",
        "gemini" => "enabled_gemini",
        "opencode" => "enabled_opencode",
        _ => return Ok(Vec::new()),
    };
    let sql = format!("SELECT name FROM skills WHERE {column} = 1 ORDER BY name");
    let mut stmt = conn.prepare(&sql)?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>>>()?;
    Ok(names)
}

pub fn delete_skill(conn: &Connection, id: &str) -> Result<bool> {
    let rows = conn.execute("DELETE FROM skills WHERE id = ?1", params![id])?;
    Ok(rows > 0)
}

#[allow(dead_code)]
pub fn get_enabled_skill_names(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT name FROM skills WHERE enabled = 1 ORDER BY name")?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>>>()?;
    Ok(names)
}

pub fn register_skill_from_disk(
    conn: &Connection,
    skills_dir: &std::path::Path,
    name: &str,
) -> Result<Skill> {
    let skill_dir = skills_dir.join(name);
    let skill_md = skill_dir.join("SKILL.md");

    let (description, display_name) = if skill_md.exists() {
        let content = std::fs::read_to_string(&skill_md).unwrap_or_default();
        parse_frontmatter(&content)
    } else {
        (None, None)
    };

    let now = Utc::now().to_rfc3339();
    let skill = Skill {
        id: Uuid::new_v4().to_string(),
        name: name.to_string(),
        display_name,
        description,
        installed_at: now,
        apps: SkillApps {
            claude: true,
            ..Default::default()
        },
        disk_path: Some(skill_dir.to_string_lossy().to_string()),
        directory: name.to_string(),
    };
    upsert_skill(conn, &skill)?;
    Ok(skill)
}

pub fn parse_frontmatter(content: &str) -> (Option<String>, Option<String>) {
    let content = content.trim();
    if !content.starts_with("---") {
        return (None, None);
    }
    let after_first = &content[3..];
    let end = match after_first.find("---") {
        Some(pos) => pos,
        None => return (None, None),
    };
    let frontmatter = &after_first[..end];
    let mut description = None;
    let mut display_name = None;
    for line in frontmatter.lines() {
        let line = line.trim();
        if let Some(val) = line.strip_prefix("description:") {
            let val = val.trim().trim_matches('"').trim_matches('\'');
            if !val.is_empty() {
                description = Some(val.to_string());
            }
        }
        if let Some(val) = line.strip_prefix("name:") {
            let val = val.trim().trim_matches('"').trim_matches('\'');
            if !val.is_empty() {
                display_name = Some(val.to_string());
            }
        }
    }
    (description, display_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_skill(id: &str, name: &str, apps: SkillApps) -> Skill {
        Skill {
            id: id.to_string(),
            name: name.to_string(),
            display_name: None,
            description: None,
            installed_at: "2026-01-01T00:00:00Z".to_string(),
            apps,
            disk_path: None,
            directory: name.to_string(),
        }
    }

    #[test]
    fn set_skill_app_enabled_updates_only_the_target_app() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::initialize_database(&conn).unwrap();

        let skill = make_skill(
            "s1",
            "my-skill",
            SkillApps {
                claude: true,
                codex: false,
                gemini: false,
                opencode: false,
            },
        );
        upsert_skill(&conn, &skill).unwrap();

        set_skill_app_enabled(&conn, "s1", "codex", true).unwrap();

        let updated = get_skill(&conn, "s1").unwrap().unwrap();
        assert!(updated.apps.claude);
        assert!(updated.apps.codex);
        assert!(!updated.apps.gemini);
        assert!(!updated.apps.opencode);
    }

    #[test]
    fn get_enabled_skill_names_for_app_filters_by_app() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::initialize_database(&conn).unwrap();

        upsert_skill(
            &conn,
            &make_skill(
                "s1",
                "alpha",
                SkillApps {
                    claude: true,
                    codex: false,
                    gemini: true,
                    opencode: false,
                },
            ),
        )
        .unwrap();
        upsert_skill(
            &conn,
            &make_skill(
                "s2",
                "beta",
                SkillApps {
                    claude: false,
                    codex: true,
                    gemini: false,
                    opencode: true,
                },
            ),
        )
        .unwrap();

        let claude_names = get_enabled_skill_names_for_app(&conn, "claude").unwrap();
        assert_eq!(claude_names, vec!["alpha"]);

        let codex_names = get_enabled_skill_names_for_app(&conn, "codex").unwrap();
        assert_eq!(codex_names, vec!["beta"]);

        let gemini_names = get_enabled_skill_names_for_app(&conn, "gemini").unwrap();
        assert_eq!(gemini_names, vec!["alpha"]);

        let opencode_names = get_enabled_skill_names_for_app(&conn, "opencode").unwrap();
        assert_eq!(opencode_names, vec!["beta"]);
    }
}
