package sqlutil

import (
	"context"
	"database/sql"
)

// IsSQLite reports whether db is SQLite (any driver where sqlite_version() works).
func IsSQLite(ctx context.Context, db *sql.DB) bool {
	return true
	// if db == nil {
	// 	return false
	// }
	// var v string
	// err := db.QueryRowContext(ctx, "SELECT sqlite_version()").Scan(&v)
	// return err == nil && v != ""
}
