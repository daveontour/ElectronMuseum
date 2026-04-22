package service

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"github.com/daveontour/aimuseum/internal/appctx"
	appcrypto "github.com/daveontour/aimuseum/internal/crypto"
	"github.com/daveontour/aimuseum/internal/repository"
)

// notFound is a sentinel returned by ResolveUserID when no matching archive exists.
const notFound int64 = -1

// VisitorService supports unauthenticated visitor discovery: looking up an archive
// by subject name or email, fetching key hints, and verifying visitor keys.
type VisitorService struct {
	users      *repository.UserRepo
	subjectCfg *repository.SubjectConfigRepo
	sensitive  *SensitiveService
	pool       *sql.DB
	pepper     string
}

// NewVisitorService creates a VisitorService.
func NewVisitorService(
	users *repository.UserRepo,
	subjectCfg *repository.SubjectConfigRepo,
	sensitive *SensitiveService,
	pool *sql.DB,
	pepper string,
) *VisitorService {
	return &VisitorService{
		users:      users,
		subjectCfg: subjectCfg,
		sensitive:  sensitive,
		pool:       pool,
		pepper:     pepper,
	}
}

// ResolveUserID finds the archive owner's user_id from a username/email or subject name.
// Returns notFound (-1) when no matching archive exists.
// Returns 0 for a legacy single-tenant row (user_id IS NULL in the DB).
func (s *VisitorService) ResolveUserID(ctx context.Context, identifier string) (int64, error) {
	identifier = strings.TrimSpace(identifier)
	if identifier == "" {
		return notFound, nil
	}

	// Try username/email first so visitor login works with either identifier.
	u, err := s.users.FindByEmail(ctx, strings.ToLower(identifier))
	if err != nil {
		return notFound, err
	}
	if u != nil {
		return u.ID, nil
	}

	uid, found, err := s.subjectCfg.FindUserIDBySubjectName(ctx, identifier)
	if err != nil {
		return notFound, err
	}
	if !found {
		return notFound, nil
	}
	return uid, nil
}

// GetHintsByEmail returns the plain-text hint strings for the archive owner
// identified by email (case-insensitive) or, if no user matches that email,
// by full name as parsed by UserRepo.FindByFullName (first token = first name,
// rest = family name). Returns an empty slice (never nil) when unknown —
// deliberately avoids confirming or denying existence except on ambiguous name match.
func (s *VisitorService) GetHintsByEmail(ctx context.Context, email string) ([]string, error) {
	trimmed := strings.TrimSpace(email)
	normEmail := strings.ToLower(trimmed)
	u, err := s.users.FindByEmail(ctx, normEmail)
	if err != nil {
		return []string{}, err
	}
	if u == nil {
		u, err = s.users.FindByFullName(ctx, trimmed)
		if err != nil {
			// Ambiguous name or DB error — treat as not found to avoid leaking
			// whether the name exists or is shared across multiple accounts.
			return []string{}, nil
		}
		if u == nil {
			return []string{}, nil
		}
	}

	dCtx := context.WithValue(ctx, appctx.ContextKeyUserID, u.ID)
	hints, err := s.sensitive.ListVisitorKeyHints(dCtx)
	if err != nil {
		return []string{}, err
	}
	texts := make([]string, 0, len(hints))
	for _, h := range hints {
		texts = append(texts, h.Hint)
	}
	return texts, nil
}

// VerifyVisitorKey checks that key unlocks a non-master keyring seat belonging to
// the archive identified by userID. Returns false (not an error) when the key is
// wrong or when the key happens to be a master key.
func (s *VisitorService) VerifyVisitorKey(ctx context.Context, userID int64, key string) (bool, error) {
	dCtx := context.WithValue(ctx, appctx.ContextKeyUserID, userID)

	isMaster, err := appcrypto.CheckSensitiveMasterPassword(dCtx, s.pool, key, s.pepper)
	if err != nil {
		return false, err
	}
	if isMaster {
		return false, nil // reject master keys in the visitor path
	}

	return appcrypto.CheckSensitiveVisitorSeatPassword(dCtx, s.pool, key, s.pepper)
}

// ResolveVisitorKeyHintID maps a visitor key string to visitor_key_hints.id for the archive owner.
// ok is false when the key does not match a visitor seat or the seat has no hint row (orphan seat).
func (s *VisitorService) ResolveVisitorKeyHintID(ctx context.Context, userID int64, key string) (hintID int64, ok bool, err error) {
	dCtx := context.WithValue(ctx, appctx.ContextKeyUserID, userID)
	krID, okSeat, err := appcrypto.FindVisitorKeyringIDForPassword(dCtx, s.pool, key, s.pepper)
	if err != nil || !okSeat {
		return 0, false, err
	}
	var hid int64
	err = s.pool.QueryRowContext(dCtx, `SELECT id FROM visitor_key_hints WHERE keyring_id = ?`, krID).Scan(&hid)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return hid, true, nil
}
