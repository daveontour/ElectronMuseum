package handler

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/daveontour/aimuseum/internal/appctx"
	"github.com/daveontour/aimuseum/internal/importer"
	"github.com/daveontour/aimuseum/internal/keystore"
	"github.com/daveontour/aimuseum/internal/model"
	"github.com/daveontour/aimuseum/internal/repository"
	"github.com/daveontour/aimuseum/internal/service"
	"github.com/go-chi/chi/v5"
	_ "golang.org/x/image/bmp"
	_ "golang.org/x/image/webp"
)

var imageAIClassificationJob = importer.NewImportJob("Image AI classification", map[string]any{
	"status": "idle", "status_line": nil, "error_message": nil,
	"total": 0, "processed": 0,
})

// ImageHandler handles all /images/*, /getLocations, and /facebook/albums/* read endpoints.
type ImageHandler struct {
	svc          *service.ImageService
	sessionStore *keystore.SessionMasterStore
	pool         *sql.DB
}

// NewImageHandler creates an ImageHandler.
func NewImageHandler(svc *service.ImageService, sessionStore *keystore.SessionMasterStore, pool *sql.DB) *ImageHandler {
	return &ImageHandler{svc: svc, sessionStore: sessionStore, pool: pool}
}

// RegisterRoutes mounts all image routes onto r.
func (h *ImageHandler) RegisterRoutes(r chi.Router) {
	// Specific sub-paths must be registered before parameterised {image_id} routes.
	r.Post("/image/ai-classification", h.ImageAIClassificationStart)
	r.Post("/image/ai-classification/missing-gemma-classified", h.ImageAIClassificationGemmaUnclassifiedStart)
	r.Get("/image/ai-classification/stream", h.ImageAIClassificationStream)
	r.Post("/image/ai-classification/cancel", h.ImageAIClassificationCancel)
	r.Get("/image/ai-classification/status", h.ImageAIClassificationStatus)

	r.Get("/images/search", h.Search)
	r.Get("/images/years", h.GetYears)
	r.Get("/images/tags", h.GetTags)
	r.Put("/images/bulk-update", h.BulkUpdate)
	r.Delete("/images/bulk-delete", h.BulkDelete)
	r.Delete("/images", h.DeleteByRange)

	r.Get("/images/{image_id}/metadata", h.GetMetadata)
	r.Get("/images/{image_id}/thumbnail", h.GetThumbnail)
	r.Get("/images/{image_id}", h.GetContent)
	r.Put("/images/{image_id}", h.UpdateMetadata)
	r.Delete("/images/{image_id}", h.Delete)

	// Location map endpoint
	r.Get("/getLocations", h.GetLocations)

	// Facebook album and posts read endpoints
	r.Get("/facebook/albums", h.GetFacebookAlbums)
	r.Get("/facebook/posts", h.GetFacebookPosts)
	// /facebook/posts/media/{media_id} must come before /facebook/posts/{post_id}/media
	r.Get("/facebook/posts/media/{media_id}", h.GetFacebookPostMediaContent)
	r.Get("/facebook/posts/{post_id}/media", h.GetFacebookPostMedia)
	// Note: /facebook/albums/images/{id} must come before /facebook/albums/{album_id}/images
	// to avoid chi treating "images" as an album_id value.
	r.Get("/facebook/albums/images/{image_id}", h.GetAlbumImageContent)
	r.Get("/facebook/albums/{album_id}/images", h.GetAlbumImages)
	r.Get("/facebook/places", h.GetFacebookPlaces)
}

// ── /images/search ────────────────────────────────────────────────────────────

func (h *ImageHandler) Search(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	p := model.ImageSearchParams{}

	if v := q.Get("title"); v != "" {
		p.Title = &v
	}
	if v := q.Get("description"); v != "" {
		p.Description = &v
	}
	if v := q.Get("author"); v != "" {
		p.Author = &v
	}
	if v := q.Get("tags"); v != "" {
		p.Tags = &v
	}
	if v := q.Get("categories"); v != "" {
		p.Categories = &v
	}
	if v := q.Get("source"); v != "" {
		p.Source = &v
	}
	if v := q.Get("source_reference"); v != "" {
		p.SourceReference = &v
	}
	if v := q.Get("media_type"); v != "" {
		p.MediaType = &v
	}
	if v := q.Get("region"); v != "" {
		p.Region = &v
	}
	if v := q.Get("year"); v != "" {
		yr, err := strconv.Atoi(v)
		if err != nil {
			writeError(w, http.StatusBadRequest, "year must be an integer")
			return
		}
		p.Year = &yr
	}
	if v := q.Get("month"); v != "" {
		m, err := strconv.Atoi(v)
		if err != nil || m < 1 || m > 12 {
			writeError(w, http.StatusBadRequest, "month must be an integer between 1 and 12")
			return
		}
		p.Month = &m
	}
	if v := q.Get("rating"); v != "" {
		rt, err := strconv.Atoi(v)
		if err != nil || rt < 1 || rt > 5 {
			writeError(w, http.StatusBadRequest, "rating must be an integer between 1 and 5")
			return
		}
		p.Rating = &rt
	}
	if v := q.Get("rating_min"); v != "" {
		rt, err := strconv.Atoi(v)
		if err != nil || rt < 1 || rt > 5 {
			writeError(w, http.StatusBadRequest, "rating_min must be an integer between 1 and 5")
			return
		}
		p.RatingMin = &rt
	}
	if v := q.Get("rating_max"); v != "" {
		rt, err := strconv.Atoi(v)
		if err != nil || rt < 1 || rt > 5 {
			writeError(w, http.StatusBadRequest, "rating_max must be an integer between 1 and 5")
			return
		}
		p.RatingMax = &rt
	}
	if v := q.Get("has_gps"); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			writeError(w, http.StatusBadRequest, "has_gps must be true or false")
			return
		}
		p.HasGPS = &b
	}
	if v := q.Get("available_for_task"); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			writeError(w, http.StatusBadRequest, "available_for_task must be true or false")
			return
		}
		p.AvailableForTask = &b
	}
	if v := q.Get("processed"); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			writeError(w, http.StatusBadRequest, "processed must be true or false")
			return
		}
		p.Processed = &b
	}

	result, err := h.svc.Search(r.Context(), p)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("error searching images: %s", err))
		return
	}
	writeJSON(w, result)
}

// ── /images/years ─────────────────────────────────────────────────────────────

func (h *ImageHandler) GetYears(w http.ResponseWriter, r *http.Request) {
	years, err := h.svc.GetDistinctYears(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("error retrieving distinct years: %s", err))
		return
	}
	if years == nil {
		years = []int{}
	}
	writeJSON(w, map[string]any{"years": years})
}

// ── /images/tags ──────────────────────────────────────────────────────────────

func (h *ImageHandler) GetTags(w http.ResponseWriter, r *http.Request) {
	tags, err := h.svc.GetDistinctTags(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("error retrieving distinct tags: %s", err))
		return
	}
	if tags == nil {
		tags = []string{}
	}
	writeJSON(w, map[string]any{"tags": tags})
}

// ── /facebook/places ──────────────────────────────────────────────────────────

func (h *ImageHandler) GetFacebookPlaces(w http.ResponseWriter, r *http.Request) {
	places, err := h.svc.GetFacebookPlaces(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("error retrieving Facebook places: %s", err))
		return
	}
	if places == nil {
		places = []model.FacebookPlaceItem{}
	}
	writeJSON(w, map[string]any{"places": places})
}

// ── /getLocations ─────────────────────────────────────────────────────────────

func (h *ImageHandler) GetLocations(w http.ResponseWriter, r *http.Request) {
	locations, err := h.svc.GetLocations(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("error retrieving locations: %s", err))
		return
	}
	if locations == nil {
		locations = []model.LocationItem{}
	}
	writeJSON(w, map[string]any{"locations": locations})
}

// ── /images/{image_id} ────────────────────────────────────────────────────────

// GetContent handles GET /images/{image_id}
// Query params:
//   - type: "blob" (default) | "metadata"
//   - preview: bool (default false) — returns thumbnail if true
//   - convert_heic_to_jpg: bool (default true) — accepted but HEIC conversion is not
//     implemented in Go; the image is returned as-is with its original content type.
func (h *ImageHandler) GetContent(w http.ResponseWriter, r *http.Request) {
	id, ok := parseImageID(w, r, "image_id")
	if !ok {
		return
	}

	idType := r.URL.Query().Get("type")
	if idType == "" {
		idType = "blob"
	}
	if idType != "blob" && idType != "metadata" {
		writeError(w, http.StatusBadRequest, `type must be "blob" or "metadata"`)
		return
	}

	preview := false
	if v := r.URL.Query().Get("preview"); v != "" {
		var err error
		preview, err = strconv.ParseBool(v)
		if err != nil {
			writeError(w, http.StatusBadRequest, "preview must be true or false")
			return
		}
	}

	h.serveImageContent(w, r, id, idType, preview)
}

// GetThumbnail handles GET /images/{image_id}/thumbnail — convenience alias for ?preview=true.
func (h *ImageHandler) GetThumbnail(w http.ResponseWriter, r *http.Request) {
	id, ok := parseImageID(w, r, "image_id")
	if !ok {
		return
	}
	h.serveImageContent(w, r, id, "metadata", true)
}

// GetMetadata handles GET /images/{image_id}/metadata
func (h *ImageHandler) GetMetadata(w http.ResponseWriter, r *http.Request) {
	id, ok := parseImageID(w, r, "image_id")
	if !ok {
		return
	}

	resp, err := h.svc.GetMetadata(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("error retrieving image metadata: %s", err))
		return
	}
	if resp == nil {
		writeError(w, http.StatusNotFound, fmt.Sprintf("image with ID %d not found", id))
		return
	}
	writeJSON(w, resp)
}

// ── /facebook/albums/* and /facebook/posts ─────────────────────────────────────

func (h *ImageHandler) GetFacebookPosts(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	p := repository.GetFacebookPostsParams{
		Page:     1,
		PageSize: 50,
	}
	if v := q.Get("search"); v != "" {
		p.Search = v
	}
	if v := q.Get("page"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 1 {
			p.Page = n
		}
	}
	if v := q.Get("page_size"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 1 {
			if n > 200 {
				n = 200
			}
			p.PageSize = n
		}
	}
	if v := q.Get("post_ids"); v != "" {
		for _, s := range strings.Split(v, ",") {
			s = strings.TrimSpace(s)
			if s == "" {
				continue
			}
			if n, err := strconv.ParseInt(s, 10, 64); err == nil {
				p.PostIDs = append(p.PostIDs, n)
			}
		}
	}

	resp, err := h.svc.GetFacebookPosts(r.Context(), p)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("error retrieving Facebook posts: %s", err))
		return
	}
	writeJSON(w, resp)
}

func (h *ImageHandler) GetFacebookPostMediaContent(w http.ResponseWriter, r *http.Request) {
	mediaID, ok := parseImageID(w, r, "media_id")
	if !ok {
		return
	}

	content, err := h.svc.GetPostMediaContent(r.Context(), mediaID)
	if err != nil {
		if strings.Contains(err.Error(), "no image data") {
			writeError(w, http.StatusNotFound, fmt.Sprintf("media item %d has no image data", mediaID))
			return
		}
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("error retrieving media: %s", err))
		return
	}
	if content == nil {
		writeError(w, http.StatusNotFound, fmt.Sprintf("media item %d not found or not linked to a post", mediaID))
		return
	}

	serveBinaryContent(w, content)
}

func (h *ImageHandler) GetFacebookPostMedia(w http.ResponseWriter, r *http.Request) {
	postID, ok := parseImageID(w, r, "post_id")
	if !ok {
		return
	}

	items, err := h.svc.GetPostMedia(r.Context(), postID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("error retrieving post media: %s", err))
		return
	}
	if items == nil {
		items = []model.FacebookPostMediaItem{}
	}
	writeJSON(w, items)
}

func (h *ImageHandler) GetFacebookAlbums(w http.ResponseWriter, r *http.Request) {
	albums, err := h.svc.GetFacebookAlbums(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("error retrieving albums: %s", err))
		return
	}
	writeJSON(w, albums)
}

func (h *ImageHandler) GetAlbumImages(w http.ResponseWriter, r *http.Request) {
	albumID, ok := parseImageID(w, r, "album_id")
	if !ok {
		return
	}

	images, err := h.svc.GetAlbumImages(r.Context(), albumID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("error retrieving album images: %s", err))
		return
	}
	writeJSON(w, images)
}

func (h *ImageHandler) GetAlbumImageContent(w http.ResponseWriter, r *http.Request) {
	id, ok := parseImageID(w, r, "image_id")
	if !ok {
		return
	}

	content, err := h.svc.GetAlbumImageContent(r.Context(), id)
	if err != nil {
		if strings.Contains(err.Error(), "no image data") {
			writeError(w, http.StatusNotFound, fmt.Sprintf("image with ID %d has no image data", id))
			return
		}
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("error retrieving image: %s", err))
		return
	}
	if content == nil {
		writeError(w, http.StatusNotFound, fmt.Sprintf("image with ID %d not found or not linked to an album", id))
		return
	}

	serveBinaryContent(w, content)
}

// ── Write / delete ────────────────────────────────────────────────────────────

func (h *ImageHandler) BulkUpdate(w http.ResponseWriter, r *http.Request) {
	if !RequireOwnerMasterUnlock(w, r, h.sessionStore) {
		return
	}
	var req struct {
		ImageIDs []int64 `json:"image_ids"`
		Tags     string  `json:"tags"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	updated, errs := h.svc.BulkUpdateTags(r.Context(), req.ImageIDs, req.Tags)
	resp := map[string]any{
		"message":       fmt.Sprintf("Updated %d image(s)", updated),
		"updated_count": updated,
	}
	if len(errs) > 0 {
		resp["errors"] = errs
	}
	writeJSON(w, resp)
}

// ImageAIClassificationStart starts a background stub job that processes the given image IDs.
// POST /image/ai-classification  body: { "ids": [1,2,3] }
func (h *ImageHandler) ImageAIClassificationStart(w http.ResponseWriter, r *http.Request) {
	if !RequireOwnerMasterUnlock(w, r, h.sessionStore) {
		return
	}
	if h.pool == nil {
		writeError(w, http.StatusServiceUnavailable, "database not configured")
		return
	}
	var req struct {
		IDs []int64 `json:"ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if len(req.IDs) == 0 {
		writeError(w, http.StatusBadRequest, "ids is required")
		return
	}
	if err := imageAIClassificationJob.AssertNotRunning(); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	uid := appctx.UserIDFromCtx(r.Context())
	idsCopy := append([]int64(nil), req.IDs...)

	imageAIClassificationJob.Start()
	imageAIClassificationJob.UpdateState(map[string]any{
		"status":        "in_progress",
		"status_line":   fmt.Sprintf("Starting AI classification for %d image(s)...", len(idsCopy)),
		"total":         len(idsCopy),
		"processed":     0,
		"classified":    0,
		"errors":        0,
		"error_message": nil,
	})
	imageAIClassificationJob.Broadcast("status", map[string]any{"status_line": fmt.Sprintf("Starting AI classification for %d image(s)...", len(idsCopy))})

	go runImageAIClassificationStub(h.svc, imageAIClassificationJob, uid, idsCopy)

	writeJSON(w, map[string]any{"message": "Image AI classification started", "status": "started", "count": len(idsCopy)})
}

// ImageAIClassificationGemmaUnclassifiedStart starts classification for image rows missing the GemmaClassified tag.
func (h *ImageHandler) ImageAIClassificationGemmaUnclassifiedStart(w http.ResponseWriter, r *http.Request) {
	if !RequireOwnerMasterUnlock(w, r, h.sessionStore) {
		return
	}
	if h.pool == nil {
		writeError(w, http.StatusServiceUnavailable, "database not configured")
		return
	}
	if err := imageAIClassificationJob.AssertNotRunning(); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ids, err := h.svc.ListImageIDsMissingTag(r.Context(), "GemmaClassified")
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("failed to build classification list: %v", err))
		return
	}
	uid := appctx.UserIDFromCtx(r.Context())

	imageAIClassificationJob.Start()
	imageAIClassificationJob.UpdateState(map[string]any{
		"status":        "in_progress",
		"status_line":   fmt.Sprintf("Starting AI classification for %d unclassified image(s)...", len(ids)),
		"total":         len(ids),
		"processed":     0,
		"classified":    0,
		"errors":        0,
		"error_message": nil,
	})
	imageAIClassificationJob.Broadcast("status", map[string]any{
		"status_line": fmt.Sprintf("Starting AI classification for %d unclassified image(s)...", len(ids)),
	})

	go runImageAIClassificationStub(h.svc, imageAIClassificationJob, uid, append([]int64(nil), ids...))

	writeJSON(w, map[string]any{
		"message": "Image AI classification job started for unclassified images",
		"status":  "started",
		"count":   len(ids),
	})
}

func (h *ImageHandler) ImageAIClassificationStream(w http.ResponseWriter, r *http.Request) {
	imageAIClassificationJob.ServeSSE(w, r)
}

func (h *ImageHandler) ImageAIClassificationCancel(w http.ResponseWriter, r *http.Request) {
	if !RequireOwnerMasterUnlock(w, r, h.sessionStore) {
		return
	}
	writeJSON(w, imageAIClassificationJob.Cancel())
}

func (h *ImageHandler) ImageAIClassificationStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, imageAIClassificationJob.Status())
}

// normalizePutImageTags maps JSON "tags" (string or array of strings per API spec) to a single comma-separated value.
func normalizePutImageTags(v any) (*string, error) {
	if v == nil {
		return nil, nil
	}
	switch t := v.(type) {
	case string:
		return &t, nil
	case []any:
		parts := make([]string, 0, len(t))
		for i, item := range t {
			s, ok := item.(string)
			if !ok {
				return nil, fmt.Errorf("tags: element %d must be a string", i)
			}
			parts = append(parts, s)
		}
		out := strings.Join(parts, ", ")
		return &out, nil
	default:
		return nil, fmt.Errorf("tags: expected string or array of strings, got %T", v)
	}
}

// normalizePutImageRating maps JSON "rating" (number or numeric string) to int for media_items.rating.
func normalizePutImageRating(v any) (*int, error) {
	if v == nil {
		return nil, nil
	}
	var n int
	switch t := v.(type) {
	case float64:
		if t != math.Trunc(t) {
			return nil, fmt.Errorf("rating must be a whole number between 1 and 5")
		}
		n = int(t)
	case json.Number:
		i64, err := t.Int64()
		if err != nil {
			f, ferr := t.Float64()
			if ferr != nil {
				return nil, fmt.Errorf("rating: invalid number")
			}
			if f != math.Trunc(f) {
				return nil, fmt.Errorf("rating must be a whole number between 1 and 5")
			}
			n = int(f)
		} else {
			n = int(i64)
		}
	case string:
		i, err := strconv.Atoi(strings.TrimSpace(t))
		if err != nil {
			return nil, fmt.Errorf("rating must be an integer between 1 and 5")
		}
		n = i
	case int:
		n = t
	case int64:
		n = int(t)
	default:
		return nil, fmt.Errorf("rating: unsupported type %T", v)
	}
	if n < 1 || n > 5 {
		return nil, fmt.Errorf("rating must be between 1 and 5")
	}
	return &n, nil
}

func normalizeImageMIME(contentType string) string {
	ct := strings.TrimSpace(contentType)
	if i := strings.Index(ct, ";"); i >= 0 {
		ct = strings.TrimSpace(ct[:i])
	}
	return strings.ToLower(ct)
}

// convertImageBytesToJPEGIfNeeded returns JPEG bytes. If the input is already a valid JPEG, returns data unchanged.
func convertImageBytesToJPEGIfNeeded(data []byte, contentType string) ([]byte, error) {
	ct := normalizeImageMIME(contentType)
	if ct == "image/jpeg" || ct == "image/jpg" {
		if _, err := jpeg.Decode(bytes.NewReader(data)); err == nil {
			return data, nil
		}
	}
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("decode image: %w", err)
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 88}); err != nil {
		return nil, fmt.Errorf("encode jpeg: %w", err)
	}
	return buf.Bytes(), nil
}

func runImageAIClassificationStub(svc *service.ImageService, job *importer.ImportJob, uid int64, imageIDs []int64) {
	ctx := context.WithValue(context.Background(), appctx.ContextKeyUserID, uid)
	defer job.Finish()

	total := len(imageIDs)
	classified, errorsCount := 0, 0
	job.UpdateState(map[string]any{
		"total":       total,
		"processed":   0,
		"classified":  classified,
		"errors":      errorsCount,
		"status":      "in_progress",
		"status_line": fmt.Sprintf("AI classification: %d image(s) queued", total),
	})
	job.Broadcast("progress", job.GetState())

	for i, id := range imageIDs {
		if job.IsCancelled() {
			job.UpdateState(map[string]any{
				"status":      "cancelled",
				"status_line": "Image AI classification cancelled.",
				"processed":   i,
				"classified":  classified,
				"errors":      errorsCount,
			})
			job.Broadcast("cancelled", job.GetState())
			return
		}

		content, err := svc.GetImageContent(ctx, id, "metadata", false)
		if err != nil || content == nil || len(content.Data) == 0 {
			errorsCount++
			msg := fmt.Sprintf("load image %d: %v", id, err)
			if content == nil && err == nil {
				msg = fmt.Sprintf("load image %d: not found", id)
			}
			job.UpdateState(map[string]any{
				"processed":     i + 1,
				"classified":    classified,
				"errors":        errorsCount,
				"status_line":   fmt.Sprintf("Processed %d/%d — %s", i+1, total, msg),
				"error_message": msg,
			})
			job.Broadcast("progress", job.GetState())
			continue
		}

		jpegBytes, err := convertImageBytesToJPEGIfNeeded(content.Data, content.ContentType)
		if err != nil {
			errorsCount++
			msg := fmt.Sprintf("jpeg convert image %d: %v", id, err)
			job.UpdateState(map[string]any{
				"processed":     i + 1,
				"classified":    classified,
				"errors":        errorsCount,
				"status_line":   fmt.Sprintf("Processed %d/%d — %s", i+1, total, msg),
				"error_message": msg,
			})
			job.Broadcast("progress", job.GetState())
			continue
		}

		encodedB64 := base64.StdEncoding.EncodeToString(jpegBytes)
		keywordTags, llmErr := classifyImageKeywordsWithOllama(ctx, encodedB64)
		if llmErr != nil {
			errorsCount++
			msg := fmt.Sprintf("classify image %d: %v", id, llmErr)
			job.UpdateState(map[string]any{
				"processed":     i + 1,
				"classified":    classified,
				"errors":        errorsCount,
				"status_line":   fmt.Sprintf("Processed %d/%d - %s", i+1, total, msg),
				"error_message": msg,
			})
			job.Broadcast("progress", job.GetState())
			continue
		}
		if strings.TrimSpace(keywordTags) == "" {
			errorsCount++
			msg := fmt.Sprintf("classify image %d: model returned no keywords", id)
			job.UpdateState(map[string]any{
				"processed":     i + 1,
				"classified":    classified,
				"errors":        errorsCount,
				"status_line":   fmt.Sprintf("Processed %d/%d - %s", i+1, total, msg),
				"error_message": msg,
			})
			job.Broadcast("progress", job.GetState())
			continue
		}

		tagsForUpdate := keywordTags + ", GemmaClassified"
		n, tagErrs := svc.BulkUpdateTags(ctx, []int64{id}, tagsForUpdate)
		if n == 0 || len(tagErrs) > 0 {
			errorsCount++
			msg := fmt.Sprintf("tag update image %d failed", id)
			if len(tagErrs) > 0 {
				msg = fmt.Sprintf("tag update image %d: %s", id, strings.Join(tagErrs, "; "))
			}
			job.UpdateState(map[string]any{
				"processed":     i + 1,
				"classified":    classified,
				"errors":        errorsCount,
				"status_line":   fmt.Sprintf("Processed %d/%d — %s", i+1, total, msg),
				"error_message": msg,
			})
			job.Broadcast("progress", job.GetState())
			continue
		}

		classified++
		job.UpdateState(map[string]any{
			"processed":   i + 1,
			"classified":  classified,
			"errors":      errorsCount,
			"status_line": fmt.Sprintf("Processed %d/%d (image id %d, %d AI keywords)", i+1, total, id, countNonEmptyCSV(keywordTags)),
		})
		job.Broadcast("progress", job.GetState())
	}

	job.UpdateState(map[string]any{
		"status":      "completed",
		"status_line": fmt.Sprintf("Image AI classification complete: %d classified, %d errors (of %d)", classified, errorsCount, total),
		"processed":   total,
		"classified":  classified,
		"errors":      errorsCount,
	})
	job.Broadcast("completed", job.GetState())
}

func (h *ImageHandler) BulkDelete(w http.ResponseWriter, r *http.Request) {
	if !RequireOwnerMasterUnlock(w, r, h.sessionStore) {
		return
	}
	var req struct {
		ImageIDs []int64 `json:"image_ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	deleted, errs := h.svc.BulkDeleteImages(r.Context(), req.ImageIDs)
	resp := map[string]any{
		"message":       fmt.Sprintf("Deleted %d image(s)", deleted),
		"deleted_count": deleted,
	}
	if len(errs) > 0 {
		resp["errors"] = errs
	}
	writeJSON(w, resp)
}

func (h *ImageHandler) DeleteByRange(w http.ResponseWriter, r *http.Request) {
	if !RequireOwnerMasterUnlock(w, r, h.sessionStore) {
		return
	}
	q := r.URL.Query()
	all := strings.ToLower(q.Get("all")) == "true" || q.Get("all") == "1"
	var startID, endID *int64
	if s := q.Get("start_id"); s != "" {
		id, err := strconv.ParseInt(s, 10, 64)
		if err != nil {
			writeError(w, http.StatusBadRequest, "start_id must be an integer")
			return
		}
		startID = &id
	}
	if s := q.Get("end_id"); s != "" {
		id, err := strconv.ParseInt(s, 10, 64)
		if err != nil {
			writeError(w, http.StatusBadRequest, "end_id must be an integer")
			return
		}
		endID = &id
	}
	deleted, err := h.svc.DeleteByIDRange(r.Context(), all, startID, endID)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if deleted == 0 && all {
		writeError(w, http.StatusNotFound, "No images found to delete")
		return
	}
	writeJSON(w, map[string]any{
		"message":       fmt.Sprintf("Successfully deleted %d image(s)", deleted),
		"deleted_count": deleted,
	})
}

func (h *ImageHandler) UpdateMetadata(w http.ResponseWriter, r *http.Request) {
	if !RequireOwnerMasterUnlock(w, r, h.sessionStore) {
		return
	}
	id, ok := parseImageID(w, r, "image_id")
	if !ok {
		return
	}
	var payload struct {
		Description *string `json:"description"`
		Tags        any     `json:"tags"`
		Rating      any     `json:"rating"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	description := payload.Description
	tags, err := normalizePutImageTags(payload.Tags)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	rating, err := normalizePutImageRating(payload.Rating)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ok2, err := h.svc.UpdateMetadata(r.Context(), id, description, tags, rating)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if !ok2 {
		writeError(w, http.StatusNotFound, fmt.Sprintf("Image with ID %d not found", id))
		return
	}
	writeJSON(w, map[string]any{
		"message":  fmt.Sprintf("Image %d updated successfully", id),
		"image_id": id,
		"updated_fields": map[string]bool{
			"description": description != nil,
			"tags":        tags != nil,
			"rating":      rating != nil,
		},
	})
}

func (h *ImageHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if !RequireOwnerMasterUnlock(w, r, h.sessionStore) {
		return
	}
	id, ok := parseImageID(w, r, "image_id")
	if !ok {
		return
	}
	deleted, err := h.svc.DeleteByMetadataID(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !deleted {
		writeError(w, http.StatusNotFound, fmt.Sprintf("Image with metadata ID %d not found", id))
		return
	}
	writeJSON(w, map[string]any{
		"message":  fmt.Sprintf("Image %d deleted successfully", id),
		"image_id": id,
	})
}

// ── helpers ───────────────────────────────────────────────────────────────────

type ollamaImageMessage struct {
	Role    string   `json:"role"`
	Content string   `json:"content"`
	Images  []string `json:"images,omitempty"`
}

type ollamaImageChatRequest struct {
	Model    string               `json:"model"`
	Messages []ollamaImageMessage `json:"messages"`
	Stream   bool                 `json:"stream"`
	Options  map[string]any       `json:"options,omitempty"`
}

type ollamaImageChatResponse struct {
	Message struct {
		Content string `json:"content"`
	} `json:"message"`
}

func classifyImageKeywordsWithOllama(ctx context.Context, encodedImageB64 string) (string, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(os.Getenv("LOCALAI_BASE_URL")), "/")
	if baseURL == "" {
		baseURL = "http://localhost:11434"
	}
	reqBody := ollamaImageChatRequest{
		Model:  "gemma4:latest",
		Stream: false,
		Messages: []ollamaImageMessage{
			{
				Role: "user",
				Content: "Analyze this image and return only a JSON array of short keyword strings. " +
					"Capture content, atmosphere, vibe, and location. " +
					"Use 8 to 16 concise keywords. Do not include any text outside the JSON array.",
				Images: []string{encodedImageB64},
			},
		},
		Options: map[string]any{"temperature": 0.2},
	}
	payload, err := json.Marshal(reqBody)
	if err != nil {
		return "", fmt.Errorf("marshal ollama image request: %w", err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/api/chat", bytes.NewReader(payload))
	if err != nil {
		return "", fmt.Errorf("build ollama image request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		return "", fmt.Errorf("call ollama: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("ollama API status %d", resp.StatusCode)
	}
	var body ollamaImageChatResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", fmt.Errorf("decode ollama response: %w", err)
	}
	keywords, err := parseKeywordJSONArray(body.Message.Content)
	if err != nil {
		return "", fmt.Errorf("parse keyword array: %w", err)
	}
	return strings.Join(keywords, ", "), nil
}

func parseKeywordJSONArray(raw string) ([]string, error) {
	s := strings.TrimSpace(raw)
	if i := strings.Index(s, "["); i >= 0 {
		if j := strings.LastIndex(s, "]"); j > i {
			s = s[i : j+1]
		}
	}
	var arr []string
	if err := json.Unmarshal([]byte(s), &arr); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(arr))
	seen := make(map[string]struct{}, len(arr))
	for _, kw := range arr {
		k := strings.TrimSpace(kw)
		if k == "" {
			continue
		}
		key := strings.ToLower(k)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, k)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("empty keyword array")
	}
	return out, nil
}

func countNonEmptyCSV(csv string) int {
	parts := strings.Split(csv, ",")
	n := 0
	for _, p := range parts {
		if strings.TrimSpace(p) != "" {
			n++
		}
	}
	return n
}

func (h *ImageHandler) serveImageContent(w http.ResponseWriter, r *http.Request, id int64, idType string, preview bool) {
	content, err := h.svc.GetImageContent(r.Context(), id, idType, preview)
	if err != nil {
		msg := err.Error()
		if strings.Contains(msg, "no thumbnail") {
			writeError(w, http.StatusNotFound, fmt.Sprintf("image with ID %d has no thumbnail available", id))
			return
		}
		if strings.Contains(msg, "no image data") || strings.Contains(msg, "not found") {
			writeError(w, http.StatusNotFound, fmt.Sprintf("image with ID %d not found or has no data", id))
			return
		}
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("error retrieving image: %s", err))
		return
	}
	if content == nil {
		writeError(w, http.StatusNotFound, fmt.Sprintf("image with ID %d not found", id))
		return
	}
	serveBinaryContent(w, content)
}

func serveBinaryContent(w http.ResponseWriter, c *model.ImageContent) {
	w.Header().Set("Content-Type", c.ContentType)
	if c.Filename != "" {
		safe := strings.ReplaceAll(c.Filename, `"`, `\"`)
		w.Header().Set("Content-Disposition", fmt.Sprintf(`inline; filename="%s"`, safe))
	}
	_, _ = w.Write(c.Data)
}

func parseImageID(w http.ResponseWriter, r *http.Request, param string) (int64, bool) {
	raw := chi.URLParam(r, param)
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, param+" must be an integer")
		return 0, false
	}
	return id, true
}
