package main

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	sqlite_vec "github.com/asg017/sqlite-vec-go-bindings/cgo"
	"github.com/daveontour/aimuseum/internal/ai"
	_ "github.com/mattn/go-sqlite3"
)

type matchRow struct {
	rowID    int64
	distance float64
	intIDs   []int64
}

type messageRow struct {
	id          int64
	chatSession string
	text        string
}

func main() {
	var (
		dbPath   string
		query    string
		topN     int
		model    string
		baseURL  string
		apiKey   string
		timeoutS int
	)

	flag.StringVar(&dbPath, "db", "sqlitevec_demo.db", "SQLite database path")
	flag.StringVar(&query, "q", "", "query text (if empty, prompt on stdin)")
	flag.IntVar(&topN, "n", 5, "number of nearest matches")
	flag.StringVar(&model, "model", "embeddinggemma:latest", "Ollama embedding model")
	flag.StringVar(&baseURL, "base-url", strings.TrimSpace(os.Getenv("LOCALAI_BASE_URL")), "Ollama base URL (default from LOCALAI_BASE_URL, then http://localhost:11434)")
	flag.StringVar(&apiKey, "api-key", strings.TrimSpace(os.Getenv("LOCALAI_API_KEY")), "Ollama API key (optional)")
	flag.IntVar(&timeoutS, "timeout", 60, "per-request timeout in seconds")
	flag.Parse()

	if topN <= 0 {
		die("-n must be > 0")
	}
	if timeoutS <= 0 {
		die("-timeout must be > 0")
	}
	if strings.TrimSpace(baseURL) == "" {
		baseURL = "http://localhost:11434"
	}
	if strings.TrimSpace(query) == "" {
		fmt.Print("Enter query text: ")
		line, err := bufio.NewReader(os.Stdin).ReadString('\n')
		if err != nil && !strings.Contains(strings.ToLower(err.Error()), "eof") {
			die("read query text: %v", err)
		}
		query = strings.TrimSpace(line)
	}
	if strings.TrimSpace(query) == "" {
		die("query text must not be empty")
	}

	sqlite_vec.Auto()
	db, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		die("open sqlite db: %v", err)
	}
	defer db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutS)*time.Second)
	defer cancel()

	var vecVersion string
	if err := db.QueryRowContext(ctx, `SELECT vec_version()`).Scan(&vecVersion); err != nil {
		die("sqlite-vec not available: %v", err)
	}
	var total int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM message_embeddings`).Scan(&total); err != nil {
		die("count message_embeddings: %v", err)
	}
	if total == 0 {
		die("message_embeddings is empty; run context embedding backfill first")
	}

	provider := ai.NewLocalAIProvider(baseURL, apiKey, model, 0)
	if provider == nil || !provider.IsAvailable() {
		die("ollama provider unavailable; set -base-url or LOCALAI_BASE_URL")
	}
	vec, err := provider.Embed(ctx, query, model)
	if err != nil {
		die("embed query text: %v", err)
	}
	vecBlob, err := sqlite_vec.SerializeFloat32(vec)
	if err != nil {
		die("serialize query embedding: %v", err)
	}

	matches, err := searchMatches(ctx, db, vecBlob, topN)
	if err != nil {
		die("search message_embeddings: %v", err)
	}
	if len(matches) == 0 {
		fmt.Println("No matches returned.")
		return
	}

	fmt.Printf("sqlite-vec version: %s\n", vecVersion)
	fmt.Printf("query=%q model=%q n=%d matches=%d\n\n", query, model, topN, len(matches))
	for i, m := range matches {
		fmt.Printf("Match %d: rowid=%d distance=%.6f ids=%v\n", i+1, m.rowID, m.distance, m.intIDs)
		msgs, err := loadMessagesByIDs(ctx, db, m.intIDs)
		if err != nil {
			fmt.Printf("  ! failed to load messages: %v\n\n", err)
			continue
		}
		if len(msgs) == 0 {
			fmt.Printf("  (no messages found for ids)\n\n")
			continue
		}
		for _, msg := range msgs {
			fmt.Printf("  - id=%d chat=%q text=%q\n", msg.id, msg.chatSession, msg.text)
		}
		fmt.Println()
	}
}

func searchMatches(ctx context.Context, db *sql.DB, queryEmbedding []byte, topN int) ([]matchRow, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT rowid, int_ids, distance
		FROM message_embeddings
		WHERE embedding MATCH ? AND k = ?
		ORDER BY distance ASC
	`, queryEmbedding, topN)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]matchRow, 0, topN)
	for rows.Next() {
		var (
			m       matchRow
			intIDsJ string
		)
		if err := rows.Scan(&m.rowID, &intIDsJ, &m.distance); err != nil {
			return nil, err
		}
		ids, err := parseIntIDsJSON(intIDsJ)
		if err != nil {
			return nil, fmt.Errorf("rowid %d int_ids parse: %w", m.rowID, err)
		}
		m.intIDs = ids
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func parseIntIDsJSON(raw string) ([]int64, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	var ids []int64
	if err := json.Unmarshal([]byte(raw), &ids); err != nil {
		return nil, err
	}
	return ids, nil
}

func loadMessagesByIDs(ctx context.Context, db *sql.DB, ids []int64) ([]messageRow, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	placeholders := make([]string, len(ids))
	args := make([]any, len(ids))
	for i, id := range ids {
		placeholders[i] = "?"
		args[i] = id
	}

	q := fmt.Sprintf(`
		SELECT id, COALESCE(chat_session, ''), COALESCE(text, '')
		FROM messages
		WHERE id IN (%s)
	`, strings.Join(placeholders, ","))
	rows, err := db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	byID := make(map[int64]messageRow, len(ids))
	for rows.Next() {
		var m messageRow
		if err := rows.Scan(&m.id, &m.chatSession, &m.text); err != nil {
			return nil, err
		}
		byID[m.id] = m
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	ordered := make([]messageRow, 0, len(ids))
	for _, id := range ids {
		if m, ok := byID[id]; ok {
			ordered = append(ordered, m)
		}
	}
	return ordered, nil
}

func die(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}
