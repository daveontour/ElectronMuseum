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

	if err := addReferenceDocumentsIncludeInSystemPromptColumn(ctx, db); err != nil {
		return err
	}

	if err := ensureSQLiteVecEmbeddingTables(ctx, db); err != nil {
		return err
	}
	if err := ensureMessageEmbeddingMetaTable(ctx, db); err != nil {
		return err
	}

	slog.Info("sqlite database migration complete")
	return nil
}

func ensureMessageEmbeddingMetaTable(ctx context.Context, db *sql.DB) error {
	if _, err := db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS message_embedding_meta (
			message_id INTEGER PRIMARY KEY,
			model TEXT NOT NULL,
			window_back INTEGER NOT NULL,
			window_forward INTEGER NOT NULL,
			content_hash TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`); err != nil {
		return fmt.Errorf("create message_embedding_meta: %w", err)
	}
	return nil
}

func ensureSQLiteVecEmbeddingTables(ctx context.Context, db *sql.DB) error {
	var vecVersion string
	if err := db.QueryRowContext(ctx, `SELECT vec_version()`).Scan(&vecVersion); err != nil {
		return fmt.Errorf("sqlite-vec not available (vec_version): %w", err)
	}

	tables := []string{"email_embeddings", "message_embeddings"}
	for _, table := range tables {
		var exists int
		if err := db.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, table,
		).Scan(&exists); err != nil {
			return fmt.Errorf("sqlite_master %s: %w", table, err)
		}
		if exists > 0 {
			continue
		}
		stmt := fmt.Sprintf(
			`CREATE VIRTUAL TABLE %s USING vec0(embedding float[768], int_ids text)`,
			table,
		)
		if _, err := db.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("create vec0 table %s: %w", table, err)
		}
		slog.Info("sqlite migration: created sqlite-vec table", "table", table, "vec_version", vecVersion)
	}
	return nil
}

func addReferenceDocumentsIncludeInSystemPromptColumn(ctx context.Context, db *sql.DB) error {
	var n int
	if err := db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'reference_documents'`,
	).Scan(&n); err != nil {
		return fmt.Errorf("sqlite_master reference_documents: %w", err)
	}
	if n == 0 {
		return nil
	}
	var has int
	if err := db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM pragma_table_info('reference_documents') WHERE name = 'include_in_system_prompt'`,
	).Scan(&has); err != nil {
		return fmt.Errorf("pragma_table_info reference_documents.include_in_system_prompt: %w", err)
	}
	if has > 0 {
		return nil
	}
	if _, err := db.ExecContext(ctx, `ALTER TABLE reference_documents ADD COLUMN include_in_system_prompt INTEGER NOT NULL DEFAULT 0`); err != nil {
		msg := strings.ToLower(err.Error())
		if !strings.Contains(msg, "duplicate column") && !strings.Contains(msg, "already exists") {
			return fmt.Errorf("add reference_documents.include_in_system_prompt: %w", err)
		}
	}
	slog.Info("sqlite migration: added reference_documents.include_in_system_prompt")
	return nil
}
