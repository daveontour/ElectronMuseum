// SQLite migrations (single-user build; no Postgres).
package database

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"strings"
)

// repairSQLiteCorruptTimestampDefaults fixes rows where an older pgDDLToSQLite bug
// turned CURRENT_TIMESTAMP into the literal string "CURRENT_TEXT" (or related) in TEXT columns.
// repairSQLiteFacebookPostsTimestampColumn adds facebook_posts.timestamp when missing.
// Older pgDDLToSQLite used (?i)\bTIMESTAMP\b, which rewrote the column identifier `timestamp`
// so CREATE TABLE could leave the table without a usable timestamp column for app queries.
func repairSQLiteFacebookPostsTimestampColumn(ctx context.Context, db *sql.DB) error {
	var n int
	if err := db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'facebook_posts'`,
	).Scan(&n); err != nil {
		return fmt.Errorf("sqlite_master facebook_posts: %w", err)
	}
	if n == 0 {
		return nil
	}
	var has int
	if err := db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM pragma_table_info('facebook_posts') WHERE name = 'timestamp'`,
	).Scan(&has); err != nil {
		return fmt.Errorf("pragma_table_info facebook_posts: %w", err)
	}
	if has > 0 {
		return nil
	}
	if _, err := db.ExecContext(ctx, `ALTER TABLE facebook_posts ADD COLUMN timestamp TEXT`); err != nil {
		msg := strings.ToLower(err.Error())
		if strings.Contains(msg, "duplicate column") {
			return nil
		}
		return fmt.Errorf("add facebook_posts.timestamp: %w", err)
	}
	slog.Info("repaired facebook_posts: added missing timestamp column (SQLite)")
	return nil
}

func repairSQLiteCorruptTimestampDefaults(ctx context.Context, db *sql.DB) error {
	// users.created_at is NOT NULL — must be a valid instant for scanning.
	if _, err := db.ExecContext(ctx, `
		UPDATE users SET created_at = (datetime('now'))
		WHERE typeof(created_at) = 'text' AND created_at IN ('CURRENT_TEXT', 'TEXTTZ')`); err != nil {
		return fmt.Errorf("repair users.created_at: %w", err)
	}
	if _, err := db.ExecContext(ctx, `
		UPDATE users SET last_login_at = NULL
		WHERE typeof(last_login_at) = 'text' AND last_login_at IN ('CURRENT_TEXT', 'TEXTTZ')`); err != nil {
		return fmt.Errorf("repair users.last_login_at: %w", err)
	}
	// Drop sessions whose expiry could not be scanned (same DDL bug); user must sign in again.
	if _, err := db.ExecContext(ctx, `
		DELETE FROM sessions
		WHERE typeof(expires_at) = 'text' AND expires_at IN ('CURRENT_TEXT', 'TEXTTZ')`); err != nil {
		return fmt.Errorf("repair sessions: %w", err)
	}
	return nil
}

// MigrateSQLite applies schema for the main application database.
func MigrateSQLite(ctx context.Context, db *sql.DB) error {
	if _, err := db.ExecContext(ctx, `PRAGMA foreign_keys = ON`); err != nil {
		return fmt.Errorf("pragma foreign_keys: %w", err)
	}
	if _, err := db.ExecContext(ctx, `PRAGMA busy_timeout = 5000`); err != nil {
		return fmt.Errorf("pragma busy_timeout: %w", err)
	}

	for _, stmt := range sqliteStatements() {
		if _, err := db.ExecContext(ctx, stmt); err != nil {
			preview := stmt
			if len(preview) > 120 {
				preview = preview[:120] + "..."
			}
			return fmt.Errorf("sqlite migration failed (%s): %w", preview, err)
		}
	}

	if _, err := db.ExecContext(ctx, `
		INSERT INTO app_system_instructions (id, chat_instructions, core_instructions, question_instructions, user_id)
		VALUES (1, '', '', '', NULL)
		ON CONFLICT(id) DO NOTHING`); err != nil {
		return fmt.Errorf("ensure app_system_instructions: %w", err)
	}

	if err := repairSQLiteCorruptTimestampDefaults(ctx, db); err != nil {
		return err
	}

	if err := repairSQLiteFacebookPostsTimestampColumn(ctx, db); err != nil {
		return err
	}

	// Older SQLite builds dropped visitor_key_hint_id entirely; repository code still selects it.
	if _, err := db.ExecContext(ctx, `ALTER TABLE sessions ADD COLUMN visitor_key_hint_id INTEGER`); err != nil {
		msg := strings.ToLower(err.Error())
		if !strings.Contains(msg, "duplicate column") && !strings.Contains(msg, "already exists") {
			return fmt.Errorf("add sessions.visitor_key_hint_id: %w", err)
		}
	}

	slog.Info("sqlite database migration complete")
	return nil
}
