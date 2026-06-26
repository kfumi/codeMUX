use chrono::Utc;
use rusqlite::{params, Connection, Result};
use uuid::Uuid;

use super::types::Skill;

fn row_to_skill(row: &rusqlite::Row) -> rusqlite::Result<Skill> {
    let enabled: i32 = row.get(4)?;
    let is_builtin: i32 = row.get(5)?;
    Ok(Skill {
        id: row.get(0)?,
        name: row.get(1)?,
        display_name: row.get(2)?,
        description: row.get(3)?,
        installed_at: row.get(6)?,
        enabled: enabled != 0,
        is_builtin: is_builtin != 0,
        disk_path: row.get(7)?,
    })
}

pub fn list_skills(conn: &Connection) -> Result<Vec<Skill>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, display_name, description, enabled, is_builtin, installed_at, disk_path
         FROM skills ORDER BY is_builtin DESC, name ASC",
    )?;
    let skills = stmt
        .query_map([], |row| row_to_skill(row))?
        .collect::<Result<Vec<_>>>()?;
    Ok(skills)
}

pub fn get_skill(conn: &Connection, id: &str) -> Result<Option<Skill>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, display_name, description, enabled, is_builtin, installed_at, disk_path
         FROM skills WHERE id = ?1",
    )?;
    let mut rows = stmt.query_map(params![id], |row| row_to_skill(row))?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

pub fn get_skill_by_name(conn: &Connection, name: &str) -> Result<Option<Skill>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, display_name, description, enabled, is_builtin, installed_at, disk_path
         FROM skills WHERE name = ?1",
    )?;
    let mut rows = stmt.query_map(params![name], |row| row_to_skill(row))?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

pub fn upsert_skill(conn: &Connection, skill: &Skill) -> Result<()> {
    conn.execute(
        "INSERT INTO skills (id, name, display_name, description, installed_at, enabled, is_builtin, disk_path)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(name) DO UPDATE SET
             display_name = excluded.display_name,
             description = excluded.description,
             installed_at = excluded.installed_at,
             disk_path = excluded.disk_path,
             enabled = CASE WHEN excluded.is_builtin = 1 THEN skills.enabled ELSE excluded.enabled END,
             is_builtin = excluded.is_builtin",
        params![
            skill.id, skill.name, skill.display_name, skill.description,
            skill.installed_at, skill.enabled as i32, skill.is_builtin as i32,
            skill.disk_path,
        ],
    )?;
    Ok(())
}

pub fn update_skill_enabled(conn: &Connection, id: &str, enabled: bool) -> Result<()> {
    conn.execute(
        "UPDATE skills SET enabled = ?1 WHERE id = ?2",
        params![enabled as i32, id],
    )?;
    Ok(())
}

pub fn delete_skill(conn: &Connection, id: &str) -> Result<bool> {
    let rows = conn.execute(
        "DELETE FROM skills WHERE id = ?1 AND is_builtin = 0",
        params![id],
    )?;
    Ok(rows > 0)
}

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
        enabled: true,
        is_builtin: false,
        disk_path: Some(skill_dir.to_string_lossy().to_string()),
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
