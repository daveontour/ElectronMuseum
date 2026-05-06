package handler

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strings"

	appai "github.com/daveontour/aimuseum/internal/ai"
	"github.com/daveontour/aimuseum/internal/appctx"
	"github.com/daveontour/aimuseum/internal/keystore"
	"github.com/daveontour/aimuseum/internal/repository"
	"github.com/daveontour/aimuseum/internal/service"
	"github.com/daveontour/aimuseum/internal/sqlutil"
	"github.com/go-chi/chi/v5"
)

// AdminHandler handles admin, control-panel, and AI summarization endpoints.
type AdminHandler struct {
	pool              *sql.DB
	subjectConfigRepo *repository.SubjectConfigRepo
	gemini            *appai.GeminiProvider
	sessionStore      *keystore.SessionMasterStore
	billing           *repository.BillingRepo
	users             *repository.UserRepo
}

// NewAdminHandler creates an AdminHandler.
func NewAdminHandler(pool *sql.DB, subjectConfigRepo *repository.SubjectConfigRepo, sessionStore *keystore.SessionMasterStore) *AdminHandler {
	return &AdminHandler{pool: pool, subjectConfigRepo: subjectConfigRepo, sessionStore: sessionStore}
}

// WithGemini injects a GeminiProvider for AI summarization.
func (h *AdminHandler) WithGemini(g *appai.GeminiProvider) { h.gemini = g }

// WithBilling attaches the billing repo and user repo for LLM usage rows (identity snapshot).
func (h *AdminHandler) WithBilling(b *repository.BillingRepo, users *repository.UserRepo) {
	h.billing = b
	h.users = users
}

// RegisterRoutes mounts all admin and AI routes.
func (h *AdminHandler) RegisterRoutes(r chi.Router) {
	r.Get("/api/import-control-last-run", h.GetImportControlLastRun)
	r.Get("/api/control-defaults", h.GetControlDefaults)
	r.Post("/writing-style/summarize", h.SummarizeWritingStyle)
	r.Post("/psychological-profile/summarize", h.SummarizePsychologicalProfile)
}

// GetImportControlLastRun handles GET /api/import-control-last-run.
// Returns last_run_at / result / result_message per import_type for the current user's archive.
func (h *AdminHandler) GetImportControlLastRun(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := appctx.UserIDFromCtx(ctx)
	if uid == 0 {
		writeJSON(w, map[string]any{})
		return
	}

	type runInfo struct {
		LastRunAt     *string `json:"last_run_at"`
		Result        string  `json:"result,omitempty"`
		ResultMessage string  `json:"result_message,omitempty"`
	}

	run := func(key, sql string, args ...any) (string, runInfo) {
		var ts *string
		_ = h.pool.QueryRowContext(ctx, sql, args...).Scan(&ts)
		if ts == nil || *ts == "" {
			return key, runInfo{}
		}
		s := *ts
		return key, runInfo{LastRunAt: &s, Result: "success", ResultMessage: ""}
	}

	result := make(map[string]runInfo)
	uidArg := []any{uid}
	// Email / IMAP — same table, split by import source
	for k, v := range map[string]string{
		"email_processing": `SELECT CAST(MAX(created_at) AS TEXT) FROM emails WHERE user_id = ?1 AND source = 'gmail'`,
		"imap_processing":  `SELECT CAST(MAX(created_at) AS TEXT) FROM emails WHERE user_id = ?1 AND (source IS NULL OR source <> 'gmail')`,
	} {
		key, info := run(k, v, uidArg...)
		result[key] = info
	}
	// Message services
	for k, v := range map[string]string{
		"whatsapp":      `SELECT CAST(MAX(created_at) AS TEXT) FROM messages WHERE user_id = ?1 AND service = 'WhatsApp'`,
		"instagram":     `SELECT CAST(MAX(created_at) AS TEXT) FROM messages WHERE user_id = ?1 AND service = 'Instagram'`,
		"imessage":      `SELECT CAST(MAX(created_at) AS TEXT) FROM messages WHERE user_id = ?1 AND service IN ('iMessage', 'SMS', 'MMS')`,
		"facebook":      `SELECT CAST(MAX(created_at) AS TEXT) FROM messages WHERE user_id = ?1 AND service = 'Facebook Messenger'`,
		"zip_whatsapp":  `SELECT CAST(MAX(created_at) AS TEXT) FROM messages WHERE user_id = ?1 AND service = 'WhatsApp'`,
		"zip_instagram": `SELECT CAST(MAX(created_at) AS TEXT) FROM messages WHERE user_id = ?1 AND service = 'Instagram'`,
		"zip_imessage":  `SELECT CAST(MAX(created_at) AS TEXT) FROM messages WHERE user_id = ?1 AND service IN ('iMessage', 'SMS', 'MMS')`,
		"upload_zip":    `SELECT CAST(MAX(created_at) AS TEXT) FROM messages WHERE user_id = ?1`,
	} {
		key, info := run(k, v, uidArg...)
		result[key] = info
	}
	// Facebook ZIP / full — aggregate activity across Messenger + albums + posts + FB locations
	fbAllSQL := `
SELECT CAST(MAX(ts) AS TEXT) FROM (
  SELECT MAX(m.created_at) AS ts FROM messages m WHERE m.user_id = ?1 AND m.service = 'Facebook Messenger'
  UNION ALL
  SELECT MAX(fa.updated_at) FROM facebook_albums fa WHERE fa.user_id = ?1
  UNION ALL
  SELECT MAX(fp.updated_at) FROM facebook_posts fp WHERE fp.user_id = ?1
  UNION ALL
  SELECT MAX(l.created_at) FROM locations l WHERE l.user_id = ?1 AND l.source = 'facebook'
) t`
	for _, key := range []string{"zip_facebook", "facebook_all"} {
		k, info := run(key, fbAllSQL, uidArg...)
		result[k] = info
	}
	// Other path imports
	for k, v := range map[string]string{
		"facebook_albums":      `SELECT CAST(MAX(updated_at) AS TEXT) FROM facebook_albums WHERE user_id = ?1`,
		"facebook_posts":       `SELECT CAST(MAX(updated_at) AS TEXT) FROM facebook_posts WHERE user_id = ?1`,
		"facebook_places":      `SELECT CAST(MAX(created_at) AS TEXT) FROM locations WHERE user_id = ?1 AND source = 'facebook'`,
		"filesystem":           `SELECT CAST(MAX(created_at) AS TEXT) FROM media_items WHERE user_id = ?1 AND source = 'filesystem'`,
		"filesystem_reference": `SELECT CAST(MAX(created_at) AS TEXT) FROM media_items WHERE user_id = ?1 AND source = 'filesystem'`,
		"upload_photos":        `SELECT CAST(MAX(created_at) AS TEXT) FROM media_items WHERE user_id = ?1 AND source = 'filesystem'`,
		"reference_import":     `SELECT CAST(MAX(updated_at) AS TEXT) FROM reference_documents WHERE user_id = ?1`,
	} {
		key, info := run(k, v, uidArg...)
		result[key] = info
	}
	// Thumbnails processing (best-effort: last media row update)
	key, info := run("thumbnails", `SELECT CAST(MAX(updated_at) AS TEXT) FROM media_items WHERE user_id = ?1`, uidArg...)
	result[key] = info
	key, info = run("contacts", `SELECT CAST(MAX(updated_at) AS TEXT) FROM contacts WHERE user_id = ?1 AND id <> 0`, uidArg...)
	result[key] = info
	key, info = run("image_export", `SELECT CAST(MAX(updated_at) AS TEXT) FROM media_items WHERE user_id = ?1`, uidArg...)
	result[key] = info

	var (
		embTS     *string
		embResult string
		embMsg    string
	)
	if err := h.pool.QueryRowContext(ctx,
		`SELECT CAST(last_run_at AS TEXT), result, COALESCE(result_message, '') FROM import_control_last_run WHERE import_type = 'image_tag_embeddings' AND user_id = ?1`,
		uid,
	).Scan(&embTS, &embResult, &embMsg); err == nil {
		if embTS != nil && *embTS != "" {
			result["image_tag_embeddings"] = runInfo{LastRunAt: embTS, Result: embResult, ResultMessage: embMsg}
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		// best-effort: ignore missing row; log only unexpected errors
	}

	writeJSON(w, result)
}

// GetControlDefaults handles GET /api/control-defaults.
// Returns app_configuration values useful for pre-filling import control forms.
func (h *AdminHandler) GetControlDefaults(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	rows, err := h.pool.QueryContext(ctx,
		`SELECT key, value FROM app_configuration
		 WHERE key LIKE '%PATH%' OR key LIKE '%DIRECTORY%' OR key LIKE '%IMPORT%'`)
	if err != nil {
		writeJSON(w, map[string]any{})
		return
	}
	defer rows.Close()

	result := map[string]any{}
	for rows.Next() {
		var key string
		var value *string
		if err := rows.Scan(&key, &value); err != nil {
			continue
		}
		result[strings.ToLower(key)] = value
	}
	writeJSON(w, result)
}

// DeleteEmptyMediaTables handles DELETE /admin/empty-media-tables.
// Removes media_blobs with no data and media_items with no blob reference.
func (h *AdminHandler) DeleteEmptyMediaTables(w http.ResponseWriter, r *http.Request) {
	if !RequireOwnerMasterUnlock(w, r, h.sessionStore) {
		return
	}
	ctx := r.Context()

	blobTag, err := h.pool.ExecContext(ctx,
		`DELETE FROM media_blobs WHERE image_data IS NULL AND thumbnail_data IS NULL`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("error deleting empty blobs: %s", err))
		return
	}

	itemTag, err := h.pool.ExecContext(ctx,
		`DELETE FROM media_items WHERE media_blob_id IS NULL`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("error deleting orphan items: %s", err))
		return
	}

	writeJSON(w, map[string]any{
		"message":       "Empty media tables cleaned",
		"blobs_deleted": sqlutil.RowsAffected(blobTag),
		"items_deleted": sqlutil.RowsAffected(itemTag),
	})
}

// SummarizeWritingStyle handles POST /writing-style/summarize.
// Samples emails, asks Gemini to describe the subject's writing style,
// and stores the result in subject_configuration.writing_style_ai.
func (h *AdminHandler) SummarizeWritingStyle(w http.ResponseWriter, r *http.Request) {
	if !RequireOwnerMasterUnlock(w, r, h.sessionStore) {
		return
	}
	ctx := r.Context()
	if h.gemini == nil {
		writeError(w, http.StatusServiceUnavailable, "AI summarization is not configured")
		return
	}

	sample, err := h.sampleEmailsForAI(ctx, 50)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("error loading email samples: %s", err))
		return
	}
	if sample == "" {
		writeError(w, http.StatusUnprocessableEntity, "no emails available for analysis")
		return
	}

	prompt := fmt.Sprintf(`Analyse the writing style of the person who sent these emails. Describe their:
- Vocabulary and language complexity
- Sentence structure and length preferences
- Tone (formal/informal, warm/professional)
- Common phrases or patterns
- How they open and close emails
- Overall communication style

Email samples:
%s`, sample)

	result, err := h.gemini.GenerateResponse(ctx, appai.GenerateRequest{UserInput: prompt}, "", nil, nil, nil)
	if err != nil {
		stub := result.Usage
		if stub == nil {
			stub = service.StubLLMUsage("gemini", "")
		}
		service.MarkUsageServerKey(stub, true)
		service.RecordLLMUsage(ctx, h.billing, h.users, stub, err)
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("AI error: %s", err))
		return
	}
	service.MarkUsageServerKey(result.Usage, true)
	service.RecordLLMUsage(ctx, h.billing, h.users, result.Usage, nil)

	if err := h.subjectConfigRepo.UpdateWritingStyleAI(ctx, result.PlainText); err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("error saving writing style: %s", err))
		return
	}

	writeJSON(w, map[string]any{
		"summary": result.PlainText,
		"message": "Writing style updated",
	})
}

// SummarizePsychologicalProfile handles POST /psychological-profile/summarize.
// Samples emails, asks Gemini to generate a psychological profile,
// and stores the result in subject_configuration.psychological_profile_ai.
func (h *AdminHandler) SummarizePsychologicalProfile(w http.ResponseWriter, r *http.Request) {
	if !RequireOwnerMasterUnlock(w, r, h.sessionStore) {
		return
	}
	ctx := r.Context()
	if h.gemini == nil {
		writeError(w, http.StatusServiceUnavailable, "AI summarization is not configured")
		return
	}

	sample, err := h.sampleEmailsForAI(ctx, 100)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("error loading email samples: %s", err))
		return
	}
	if sample == "" {
		writeError(w, http.StatusUnprocessableEntity, "no emails available for analysis")
		return
	}

	prompt := fmt.Sprintf(`Based on the emails below, provide a psychological profile of the sender. Include:
- Personality traits (Big Five: openness, conscientiousness, extraversion, agreeableness, neuroticism)
- Values and priorities
- Emotional patterns
- Social style and relationships
- Decision-making approach
- Potential strengths and challenges

Email samples:
%s`, sample)

	result, err := h.gemini.GenerateResponse(ctx, appai.GenerateRequest{UserInput: prompt}, "", nil, nil, nil)
	if err != nil {
		stub := result.Usage
		if stub == nil {
			stub = service.StubLLMUsage("gemini", "")
		}
		service.MarkUsageServerKey(stub, true)
		service.RecordLLMUsage(ctx, h.billing, h.users, stub, err)
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("AI error: %s", err))
		return
	}
	service.MarkUsageServerKey(result.Usage, true)
	service.RecordLLMUsage(ctx, h.billing, h.users, result.Usage, nil)

	if err := h.subjectConfigRepo.UpdatePsychologicalProfileAI(ctx, result.PlainText); err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("error saving profile: %s", err))
		return
	}

	writeJSON(w, map[string]any{
		"profile": result.PlainText,
		"message": "Psychological profile updated",
	})
}

// sampleEmailsForAI returns a formatted block of recent email subjects + plain text
// suitable for AI analysis. Each email body is capped at 500 characters.
func (h *AdminHandler) sampleEmailsForAI(ctx context.Context, limit int) (string, error) {
	rows, err := h.pool.QueryContext(ctx, `
		SELECT subject, plain_text
		FROM emails
		WHERE plain_text IS NOT NULL AND user_deleted = FALSE
		ORDER BY date DESC
		LIMIT ?1`, limit)
	if err != nil {
		return "", err
	}
	defer rows.Close()

	var sb strings.Builder
	i := 0
	for rows.Next() {
		var subject, text *string
		if err := rows.Scan(&subject, &text); err != nil {
			continue
		}
		i++
		sb.WriteString(fmt.Sprintf("--- Email %d ---\n", i))
		if subject != nil {
			sb.WriteString(fmt.Sprintf("Subject: %s\n", *subject))
		}
		if text != nil {
			body := *text
			if len(body) > 500 {
				body = body[:500] + "..."
			}
			sb.WriteString(body)
		}
		sb.WriteString("\n\n")
	}
	if i == 0 {
		return "", rows.Err()
	}
	return sb.String(), rows.Err()
}
