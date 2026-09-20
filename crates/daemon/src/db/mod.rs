pub mod operations;
pub mod schema;

use crate::paths::PathRoots;
use rusqlite::Connection;
use std::path::PathBuf;

pub fn get_database_path(roots: &PathRoots) -> Result<PathBuf, String> {
    roots
        .ensure_app_data_dir()
        .map_err(|e| format!("Failed to create app dir: {}", e))?;
    Ok(roots.database_path())
}

pub fn initialize(roots: &PathRoots) -> Result<Connection, String> {
    let db_path = get_database_path(roots)?;
    let conn = Connection::open(db_path).map_err(|e| format!("Failed to open database: {}", e))?;
    schema::initialize_database(&conn)
        .map_err(|e| format!("Failed to initialize database: {}", e))?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::initialize;
    use crate::paths::PathRoots;

    #[test]
    fn initialize_creates_schema_without_shell_process() {
        let temp = tempfile::tempdir().expect("tempdir");
        let roots = PathRoots {
            app_data_dir: temp.path().to_path_buf(),
            resource_dir: None,
        };
        let conn = initialize(&roots).expect("initialize");
        let table_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'",
                [],
                |row| row.get(0),
            )
            .expect("query sqlite_master");
        assert!(table_count > 0, "schema tables should be created");
    }
}
