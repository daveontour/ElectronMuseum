// SQLite DDL generation from the PostgreSQL schemaDDL() definitions.
package database

import (
	"regexp"
	"strings"
)

var (
	reSkipTable = regexp.MustCompile(`(?i)CREATE TABLE IF NOT EXISTS\s+(\w+)`)
	// Match PostgreSQL TIMESTAMPTZ/TIMESTAMP with flexible whitespace (schema uses 1–2 spaces).
	reTSNotNullDefCur = regexp.MustCompile(`(?i)TIMESTAMPTZ\s+NOT NULL\s+DEFAULT\s+CURRENT_TIMESTAMP`)
	reTSNotNullDefNow = regexp.MustCompile(`(?i)TIMESTAMPTZ\s+NOT NULL\s+DEFAULT\s+NOW\s*\(\s*\)`)
	reTNotNullDefCur  = regexp.MustCompile(`(?i)TIMESTAMP\s+NOT NULL\s+DEFAULT\s+CURRENT_TIMESTAMP`)
	reTDefCur         = regexp.MustCompile(`(?i)TIMESTAMP\s+DEFAULT\s+CURRENT_TIMESTAMP`)
	reTSNotNull       = regexp.MustCompile(`(?i)TIMESTAMPTZ\s+NOT NULL\b`)
	reTSPlain         = regexp.MustCompile(`(?i)\bTIMESTAMPTZ\b`)
	// Case-sensitive: (?i) would match the column name `timestamp` in DDL (e.g. facebook_posts)
	// and corrupt it to `TEXT`. Schema DDL uses uppercase TIMESTAMP for the type.
	reTPlain = regexp.MustCompile(`\bTIMESTAMP\b`)
)

// sqliteStatements returns DDL strings suitable for SQLite, derived from the
// PostgreSQL schemaDDL() slice.
func sqliteStatements() []string {
	var out []string
	for _, s := range schemaDDL() {
		if skipSQLiteTable(s) || skipSQLiteIndexOnOmittedTable(s) {
			continue
		}
		out = append(out, pgDDLToSQLite(s))
	}
	// Email plain_text index (btree; no pg_trgm).
	out = append(out,
		`CREATE INDEX IF NOT EXISTS idx_plain_text_btree ON emails (plain_text)`,
	)
	return out
}

// encryptionSQLiteSkipTables can exclude schemaDDL tables from the SQLite build.
// Keyring, visitor hints, and private_store are required for the Electron / SQLite app.
var encryptionSQLiteSkipTables = []string{}

func skipSQLiteTable(s string) bool {
	m := reSkipTable.FindStringSubmatch(s)
	if len(m) < 2 {
		return false
	}
	t := strings.ToLower(m[1])
	for _, skip := range encryptionSQLiteSkipTables {
		if t == skip {
			return true
		}
	}
	return false
}

// skipSQLiteIndexOnOmittedTable drops CREATE INDEX statements for tables we do not create in SQLite.
func skipSQLiteIndexOnOmittedTable(s string) bool {
	u := strings.ToLower(strings.TrimSpace(s))
	if len(u) < 12 || !strings.HasPrefix(u, "create index") {
		return false
	}
	for _, tbl := range encryptionSQLiteSkipTables {
		// e.g. " ON sensitive_keyring " or " ON sensitive_keyring("
		if i := strings.Index(u, " on "+tbl); i >= 0 {
			rest := u[i+len(" on "+tbl):]
			if len(rest) == 0 || rest[0] == ' ' || rest[0] == '(' {
				return true
			}
		}
	}
	return false
}

func pgDDLToSQLite(s string) string {
	// Keep column for app queries; omit FK (visitor_key_hints table may not exist in SQLite).
	s = strings.ReplaceAll(s, "visitor_key_hint_id   BIGINT REFERENCES visitor_key_hints(id) ON DELETE SET NULL", "visitor_key_hint_id BIGINT")
	s = strings.ReplaceAll(s, "visitor_llm_overrides JSONB", "visitor_llm_overrides TEXT")
	s = strings.ReplaceAll(s, "tool_access_policy JSONB", "tool_access_policy TEXT")
	s = strings.ReplaceAll(s, "details     JSONB", "details     TEXT")
	s = strings.ReplaceAll(s, "visitor_llm_overrides JSONB", "visitor_llm_overrides TEXT")

	// Types
	s = strings.ReplaceAll(s, "BIGSERIAL", "INTEGER")
	// schemaDDL uses two spaces between SERIAL and PRIMARY on some tables; handle both.
	s = strings.ReplaceAll(s, "SERIAL  PRIMARY KEY", "INTEGER PRIMARY KEY AUTOINCREMENT")
	s = strings.ReplaceAll(s, "SERIAL PRIMARY KEY", "INTEGER PRIMARY KEY AUTOINCREMENT")
	s = strings.ReplaceAll(s, "BOOLEAN NOT NULL", "INTEGER NOT NULL")
	s = strings.ReplaceAll(s, "BOOLEAN DEFAULT", "INTEGER DEFAULT")
	s = strings.ReplaceAll(s, "BOOLEAN", "INTEGER")
	// SQLite requires DEFAULT expressions that are accepted as constant; datetime('now') is portable.
	// Regexes handle variable spacing in schemaDDL() (e.g. TIMESTAMPTZ  NOT NULL).
	s = reTSNotNullDefCur.ReplaceAllString(s, "TEXT NOT NULL DEFAULT (datetime('now'))")
	s = reTSNotNullDefNow.ReplaceAllString(s, "TEXT NOT NULL DEFAULT (datetime('now'))")
	s = reTNotNullDefCur.ReplaceAllString(s, "TEXT NOT NULL DEFAULT (datetime('now'))")
	s = reTDefCur.ReplaceAllString(s, "TEXT DEFAULT (datetime('now'))")
	s = reTSNotNull.ReplaceAllString(s, "TEXT NOT NULL")
	s = reTSPlain.ReplaceAllString(s, "TEXT")
	// reTPlain matches \bTIMESTAMP\b, which also matches the "TIMESTAMP" suffix inside
	// CURRENT_TIMESTAMP, corrupting it to CURRENT_TEXT. Shield the keyword first.
	s = strings.ReplaceAll(s, "CURRENT_TIMESTAMP", "__DM_SQLITE_CURRENT_TS__")
	s = reTPlain.ReplaceAllString(s, "TEXT")
	s = strings.ReplaceAll(s, "__DM_SQLITE_CURRENT_TS__", "CURRENT_TIMESTAMP")
	s = strings.ReplaceAll(s, "JSONB", "TEXT")
	s = strings.ReplaceAll(s, "BYTEA", "BLOB")
	s = strings.ReplaceAll(s, "DOUBLE PRECISION", "REAL")

	// Fix INTEGER PRIMARY KEY for users-style BIGSERIAL lines already replaced
	s = strings.ReplaceAll(s, "INTEGER    PRIMARY KEY", "INTEGER PRIMARY KEY AUTOINCREMENT")

	return s
}
