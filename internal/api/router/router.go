// Package router wires all HTTP routes onto a chi.Mux.
package router

import (
	"database/sql"
	"encoding/json"
	"net/http"

	appai "github.com/daveontour/aimuseum/internal/ai"
	"github.com/daveontour/aimuseum/internal/config"
	"github.com/daveontour/aimuseum/internal/handler"
	"github.com/daveontour/aimuseum/internal/keystore"
	"github.com/daveontour/aimuseum/internal/middleware"
	"github.com/daveontour/aimuseum/internal/repository"
	"github.com/daveontour/aimuseum/internal/service"
	"github.com/go-chi/chi/v5"
	chimiddleware "github.com/go-chi/chi/v5/middleware"
)

// New returns the fully-wired application router.
func New(pool *sql.DB, billingPool *sql.DB, cfg *config.Config) (http.Handler, error) {
	r := chi.NewRouter()

	billingRepo := repository.NewBillingRepo(billingPool)

	// ── Global middleware ───────────────────────────────────────────────────────
	r.Use(middleware.Recoverer)
	r.Use(middleware.Logger)
	r.Use(chimiddleware.RequestID)
	r.Use(chimiddleware.RealIP)

	// ── Authentication service (shared by handler + middleware) ───────────────
	userRepo := repository.NewUserRepo(pool)
	authSvc := service.NewAuthService(userRepo, cfg.Server.SessionCookieSecure)

	// ── Auth middleware — runs on every request after RealIP ───────────────────
	// Auth endpoints and static assets are exempt (see middleware.isExempt).
	// Unauthenticated requests to non-exempt paths get 401 JSON or a redirect to /login.
	r.Use(middleware.NewAuthMiddleware(authSvc))

	// ── Health check ───────────────────────────────────────────────────────────
	r.Get("/health", healthHandler)

	sessionMasterStore := keystore.NewSessionMasterStore(cfg.Server.SessionCookieSecure)

	// ── Emails ─────────────────────────────────────────────────────────────────
	emailRepo := repository.NewEmailRepo(pool)
	emailSvc := service.NewEmailService(emailRepo)
	emailSvc.WithBilling(billingRepo, userRepo)
	emailHandler := handler.NewEmailHandler(emailSvc, sessionMasterStore)
	emailHandler.RegisterRoutes(r)

	// ── Shared: documents / sensitive / private store / RAM master key ───────
	documentRepo := repository.NewDocumentRepo(pool)
	documentSvc := service.NewDocumentService(documentRepo, pool, cfg.Crypto.KeyringPepper)
	sensitiveSvc := service.NewSensitiveService(documentRepo, pool, cfg.Crypto.KeyringPepper)

	privateStoreRepo := repository.NewPrivateStoreRepo(pool)
	privateStoreSvc := service.NewPrivateStoreService(privateStoreRepo, pool, cfg.Crypto.KeyringPepper)

	// ── Import dialog saved settings (private_store, RAM master key) ────────────
	importDialogSettingsHandler := handler.NewImportDialogSettingsHandler(privateStoreSvc, sessionMasterStore, authSvc)
	importDialogSettingsHandler.RegisterRoutes(r)

	// ── IMAP ──────────────────────────────────────────────────────────────────
	imapHandler := handler.NewIMAPHandler(pool, sessionMasterStore, sensitiveSvc, authSvc)
	imapHandler.RegisterRoutes(r)

	// ── Gmail ─────────────────────────────────────────────────────────────────
	gmailHandler := handler.NewGmailHandler(pool,
		cfg.Gmail.ClientID, cfg.Gmail.ClientSecret, cfg.Gmail.RedirectURL, sessionMasterStore, sensitiveSvc, authSvc)
	gmailHandler.RegisterRoutes(r)

	// ── Images & media ─────────────────────────────────────────────────────────
	imageRepo := repository.NewImageRepo(pool)
	imageSvc := service.NewImageService(imageRepo)
	imageHandler := handler.NewImageHandler(imageSvc, sessionMasterStore, pool)
	imageHandler.RegisterRoutes(r)

	// ── Messages ────────────────────────────────────────────────────────────────
	messageRepo := repository.NewMessageRepo(pool)
	messageSvc := service.NewMessageService(messageRepo)
	messageSvc.WithBilling(billingRepo, userRepo)
	messageHandler := handler.NewMessageHandler(messageSvc, sessionMasterStore)
	messageHandler.RegisterRoutes(r)

	// ── Dashboard & subject configuration ────────────────────────────────────
	dashboardRepo := repository.NewDashboardRepo(pool)
	subjectConfigRepo := repository.NewSubjectConfigRepo(pool)
	appInstrRepo := repository.NewAppSystemInstructionsRepo(pool)
	dashboardSvc := service.NewDashboardService(dashboardRepo, subjectConfigRepo)
	subjectConfigSvc := service.NewSubjectConfigService(subjectConfigRepo, appInstrRepo)

	// ── Auth HTTP endpoints ────────────────────────────────────────────────────
	authHandler := handler.NewAuthHandler(authSvc, sensitiveSvc, subjectConfigSvc, sessionMasterStore, cfg.Server.SessionCookieSecure)
	authHandler.RegisterRoutes(r)

	dashboardHandler := handler.NewDashboardHandler(dashboardSvc, subjectConfigSvc, sessionMasterStore)
	dashboardHandler.RegisterRoutes(r)

	// ── Templated endpoints (GET /, suggestions, JS files) ───────────────────
	templateHandler := handler.NewTemplateHandler(subjectConfigRepo, userRepo, cfg)
	templateHandler.RegisterRoutes(r)

	// ── Static files (must be after template routes so /static/js/museum/foundation.js
	// and modals-people.js are served via TemplateHandler with {{ }} substitution)
	staticFS := http.FileServer(http.Dir(cfg.App.AssetStaticDir))
	r.Handle("/static/*", http.StripPrefix("/static/", staticFS))

	// ── Reference documents & sensitive data (shared keyring) ────────────────
	sensitiveHandler := handler.NewSensitiveHandler(sensitiveSvc, cfg.App.AssetStaticDir, sessionMasterStore)
	sensitiveHandler.RegisterRoutes(r)
	documentHandler := handler.NewDocumentHandler(documentSvc, sensitiveSvc, authSvc, sessionMasterStore)
	documentHandler.RegisterRoutes(r)

	sessionHandler := handler.NewSessionHandler(sensitiveSvc, sessionMasterStore, authSvc)
	sessionHandler.RegisterRoutes(r)

	// ── Private key-value store (master-only DEK) ─────────────────────────────
	privateStoreHandler := handler.NewPrivateStoreHandler(privateStoreSvc, sessionMasterStore)
	privateStoreHandler.RegisterRoutes(r)

	// ── Artefacts ─────────────────────────────────────────────────────────────
	artefactRepo := repository.NewArtefactRepo(pool)
	artefactSvc := service.NewArtefactService(artefactRepo)
	artefactHandler := handler.NewArtefactHandler(artefactSvc, sensitiveSvc, authSvc, sessionMasterStore)
	artefactHandler.RegisterRoutes(r)

	// ── Voices ────────────────────────────────────────────────────────────────
	voiceRepo := repository.NewVoiceRepo(pool)
	voiceSvc := service.NewVoiceService(voiceRepo, subjectConfigRepo, cfg.App.AssetStaticDir)
	voiceHandler := handler.NewVoiceHandler(voiceSvc, sessionMasterStore)
	voiceHandler.RegisterRoutes(r)

	// ── Interests ─────────────────────────────────────────────────────────────
	interestRepo := repository.NewInterestRepo(pool)
	interestSvc := service.NewInterestService(interestRepo)
	interestHandler := handler.NewInterestHandler(interestSvc, sessionMasterStore)
	interestHandler.RegisterRoutes(r)

	// ── Saved responses ───────────────────────────────────────────────────────
	savedResponseRepo := repository.NewSavedResponseRepo(pool)
	savedResponseSvc := service.NewSavedResponseService(savedResponseRepo)
	savedResponseHandler := handler.NewSavedResponseHandler(savedResponseSvc, sessionMasterStore)
	savedResponseHandler.RegisterRoutes(r)

	// ── Configuration ─────────────────────────────────────────────────────────
	configRepo := repository.NewConfigRepo(pool)
	configSvc := service.NewConfigService(configRepo)
	configHandler := handler.NewConfigHandler(configSvc, sessionMasterStore)
	configHandler.RegisterRoutes(r)

	// ── Contacts, email-matches, exclusions, classifications ──────────────────
	contactRepo := repository.NewContactRepo(pool)
	contactSvc := service.NewContactService(contactRepo, subjectConfigRepo)
	contactHandler := handler.NewContactHandler(contactSvc, sessionMasterStore)
	contactHandler.RegisterRoutes(r)

	// ── Attachments ───────────────────────────────────────────────────────────
	attachmentRepo := repository.NewAttachmentRepo(pool)
	attachmentSvc := service.NewAttachmentService(attachmentRepo)
	attachmentHandler := handler.NewAttachmentHandler(attachmentSvc, cfg.App.AssetStaticDir, sessionMasterStore, sensitiveSvc, authSvc)
	attachmentHandler.RegisterRoutes(r)

	// ── Embeddings (local AI) ─────────────────────────────────────────────────
	localAIProvider := appai.NewLocalAIProvider(cfg.AI.LocalAIBaseURL, cfg.AI.LocalAIAPIKey, cfg.AI.LocalAIModelName)
	embeddingSvc := service.NewEmbeddingService(localAIProvider, cfg.AI.LocalAIEmbeddingModel)

	// ── Import jobs ───────────────────────────────────────────────────────────
	importerHandler := handler.NewImporterHandler(handler.ImporterHandlerDeps{
		ExcludePatterns:   cfg.Filesystem.ExcludePatterns,
		ImageRepo:         imageRepo,
		Pool:              pool,
		SubjectConfigRepo: subjectConfigRepo,
		SessionStore:      sessionMasterStore,
		SensitiveSvc:      sensitiveSvc,
		AuthSvc:           authSvc,
		EmbeddingSvc:      embeddingSvc,
	})
	importerHandler.RegisterRoutes(r)

	// ── Upload-based imports (Tier B ZIP upload, Tier C1 photo batch) ─────────
	uploadImportHandler := handler.NewUploadImportHandler(pool, subjectConfigRepo, sessionMasterStore, sensitiveSvc, authSvc, cfg.Upload)
	if err := uploadImportHandler.RegisterRoutes(r); err != nil {
		return nil, err
	}

	embeddingHandler := handler.NewEmbeddingHandler(embeddingSvc)
	embeddingHandler.RegisterRoutes(r)
	messageSimilarityHandler := handler.NewMessageSimilarityHandler(pool, embeddingSvc)
	messageSimilarityHandler.RegisterRoutes(r)

	// ── Chat & AI ────────────────────────────────────────────────────────────
	geminiProvider := appai.NewGeminiProvider(cfg.AI.GeminiAPIKey, cfg.AI.GeminiModelName)
	emailSvc.WithGemini(geminiProvider)
	messageSvc.WithGemini(geminiProvider)

	// ── Admin & AI summarization ───────────────────────────────────────────────
	adminHandler := handler.NewAdminHandler(pool, subjectConfigRepo, sessionMasterStore)
	adminHandler.WithGemini(geminiProvider)
	adminHandler.WithBilling(billingRepo, userRepo)
	adminHandler.RegisterRoutes(r)

	importDataPurgeHandler := handler.NewImportDataPurgeHandler(pool, sessionMasterStore, sensitiveSvc, authSvc)
	importDataPurgeHandler.RegisterRoutes(r)

	// ── Admin user management ──────────────────────────────────────────────────
	adminUsersHandler := handler.NewAdminUsersHandler(userRepo, authSvc, sensitiveSvc, subjectConfigSvc, dashboardSvc, billingRepo, appInstrRepo, cfg.Server.SessionCookieSecure)
	adminUsersHandler.RegisterRoutes(r)

	billingExportHandler := handler.NewBillingExportHandler(userRepo, billingRepo)
	billingExportHandler.RegisterRoutes(r)
	chatRepo := repository.NewChatRepo(pool)
	completeProfileRepo := repository.NewCompleteProfileRepo(pool)
	chatSvc := service.NewChatService(
		chatRepo,
		subjectConfigRepo,
		appInstrRepo,
		completeProfileRepo,
		documentRepo,
		pool,
		userRepo,
		cfg.AI.GeminiAPIKey,
		cfg.AI.GeminiModelName,
		cfg.AI.AnthropicAPIKey,
		cfg.AI.ClaudeModelName,
		cfg.AI.DeepSeekAPIKey,
		cfg.AI.DeepSeekModelName,
		cfg.AI.TavilyAPIKey,
		cfg.AI.LocalAIBaseURL,
		cfg.AI.LocalAIAPIKey,
		cfg.AI.LocalAIModelName,
		cfg.App.AssetStaticDir,
		cfg.Crypto.KeyringPepper,
		sessionMasterStore,
		privateStoreSvc,
		billingRepo,
	)
	chatHandler := handler.NewChatHandler(chatSvc, completeProfileRepo, sessionMasterStore)
	chatHandler.RegisterRoutes(r)

	haveAChatHandler := handler.NewHaveAChatHandler(chatSvc, sessionMasterStore)
	haveAChatHandler.RegisterRoutes(r)

	interviewRepo := repository.NewInterviewRepo(pool)
	interviewHandler := handler.NewInterviewHandler(chatSvc, interviewRepo, sessionMasterStore)
	interviewHandler.RegisterRoutes(r)

	llmToolsAccessHandler := handler.NewLLMToolsAccessHandler(privateStoreSvc, sessionMasterStore, authSvc)
	llmToolsAccessHandler.RegisterRoutes(r)

	// ── Pam Bot (dementia companion) ─────────────────────────────────────────
	pamBotRepo := repository.NewPamBotRepo(pool)
	pamBotSvc := service.NewPamBotService(
		pamBotRepo, subjectConfigRepo, appInstrRepo, pool, userRepo,
		cfg.AI.GeminiAPIKey, cfg.AI.GeminiModelName,
		cfg.AI.AnthropicAPIKey, cfg.AI.ClaudeModelName,
		cfg.AI.TavilyAPIKey, cfg.Crypto.KeyringPepper,
		sessionMasterStore, billingRepo,
	)
	pamBotHandler := handler.NewPamBotHandler(pamBotSvc)
	pamBotHandler.RegisterRoutes(r)

	// ── Share tokens ──────────────────────────────────────────────────────────
	shareRepo := repository.NewArchiveShareRepo(pool)
	shareSvc := service.NewArchiveShareService(shareRepo, authSvc)
	shareHandler := handler.NewShareHandler(shareSvc, cfg.Server.SessionCookieSecure, sessionMasterStore)
	shareHandler.RegisterRoutes(r)

	// ── Visitor access (unauthenticated discovery + key login) ────────────────
	visitorSvc := service.NewVisitorService(userRepo, subjectConfigRepo, sensitiveSvc, pool, cfg.Crypto.KeyringPepper)
	visitorHandler := handler.NewVisitorHandler(visitorSvc, authSvc, sessionMasterStore, cfg.Server.SessionCookieSecure)
	visitorHandler.RegisterRoutes(r)

	return r, nil
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}
