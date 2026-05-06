package service

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"log/slog"
	"sort"
	"strings"

	sqlite_vec "github.com/asg017/sqlite-vec-go-bindings/cgo"
	"github.com/daveontour/aimuseum/internal/repository"
)

const mediaTagEmbeddingsVecTable = "media_tag_embeddings"

// NormalizeTagsForEmbedding splits comma-separated tags, trims, lowercases, dedupes,
// sorts alphabetically, and rejoins with ", " for stable embedding input.
func NormalizeTagsForEmbedding(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	parts := strings.Split(raw, ",")
	seen := make(map[string]struct{})
	for _, p := range parts {
		t := strings.ToLower(strings.TrimSpace(p))
		if t != "" {
			seen[t] = struct{}{}
		}
	}
	if len(seen) == 0 {
		return ""
	}
	out := make([]string, 0, len(seen))
	for t := range seen {
		out = append(out, t)
	}
	sort.Strings(out)
	return strings.Join(out, ", ")
}

// TagEmbeddingSignature is a stable short fingerprint of normalized tag text stored in vec int_ids for skip-on-backfill.
func TagEmbeddingSignature(norm string) string {
	sum := sha256.Sum256([]byte(norm))
	return hex.EncodeToString(sum[:])
}

// MediaTagEmbeddingHelper upserts or deletes sqlite-vec rows for media_items.tags (local AI embeddings only).
type MediaTagEmbeddingHelper struct {
	pool *sql.DB
	repo *repository.ImageRepo
	svc  *EmbeddingService
}

// NewMediaTagEmbeddingHelper creates a helper; svc may be nil to disable sync.
func NewMediaTagEmbeddingHelper(pool *sql.DB, repo *repository.ImageRepo, svc *EmbeddingService) *MediaTagEmbeddingHelper {
	if pool == nil || repo == nil {
		return nil
	}
	return &MediaTagEmbeddingHelper{pool: pool, repo: repo, svc: svc}
}

// Sync refreshes or removes the vec row for one media item from current DB tags.
func (h *MediaTagEmbeddingHelper) Sync(ctx context.Context, mediaItemID int64) {
	if h == nil || h.pool == nil || h.repo == nil {
		return
	}
	if h.svc == nil || !h.svc.IsAvailable() {
		return
	}
	item, err := h.repo.GetMediaItemByID(ctx, mediaItemID)
	if err != nil || item == nil {
		return
	}
	var tagStr string
	if item.Tags != nil {
		tagStr = *item.Tags
	}
	norm := NormalizeTagsForEmbedding(tagStr)
	if norm == "" {
		if _, delErr := h.pool.ExecContext(ctx, `DELETE FROM `+mediaTagEmbeddingsVecTable+` WHERE rowid = ?`, mediaItemID); delErr != nil {
			slog.Warn("media tag embedding delete", "media_item_id", mediaItemID, "err", delErr)
		}
		return
	}
	vec, err := h.svc.EmbedText(ctx, norm)
	if err != nil {
		slog.Warn("media tag embedding embed", "media_item_id", mediaItemID, "err", err)
		return
	}
	blob, err := sqlite_vec.SerializeFloat32(vec)
	if err != nil {
		slog.Warn("media tag embedding serialize", "media_item_id", mediaItemID, "err", err)
		return
	}
	sig := TagEmbeddingSignature(norm)
	if _, err := h.pool.ExecContext(ctx,
		`INSERT OR REPLACE INTO `+mediaTagEmbeddingsVecTable+` (rowid, embedding, int_ids) VALUES (?, ?, ?)`,
		mediaItemID, blob, sig,
	); err != nil {
		slog.Warn("media tag embedding upsert", "media_item_id", mediaItemID, "err", err)
	}
}

// MediaTagEmbeddingSignatureMatches reports whether the vec row for mediaItemID was built for the same normalized tags.
func MediaTagEmbeddingSignatureMatches(ctx context.Context, pool *sql.DB, mediaItemID int64, norm string) (bool, error) {
	if pool == nil || norm == "" {
		return false, nil
	}
	want := TagEmbeddingSignature(norm)
	var got string
	err := pool.QueryRowContext(ctx,
		`SELECT int_ids FROM `+mediaTagEmbeddingsVecTable+` WHERE rowid = ?`, mediaItemID,
	).Scan(&got)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return got != "" && got == want, nil
}
