// Digital Museum — Go server entry point.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	_ "net/http/pprof" // registers /debug/pprof handlers on DefaultServeMux
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/daveontour/aimuseum/internal/api/router"
	"github.com/daveontour/aimuseum/internal/config"
	"github.com/daveontour/aimuseum/internal/database"
	"github.com/daveontour/aimuseum/internal/repository"
)

func main() {
	if err := run(); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run() error {
	// ── Structured logging ─────────────────────────────────────────────────────
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	})))

	// ── Configuration ──────────────────────────────────────────────────────────
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	// ── Database ───────────────────────────────────────────────────────────────
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	billingCfg := cfg.DB.BillingConfig()

	db, err := database.New(ctx, cfg.DB)
	if err != nil {
		return fmt.Errorf("connect to database: %w", err)
	}
	defer db.Close()

	billingDB, err := database.NewBilling(ctx, billingCfg)
	if err != nil {
		return fmt.Errorf("connect to billing database: %w", err)
	}
	defer billingDB.Close()

	migrateCtx, migrateCancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer migrateCancel()

	if err := database.MigrateSQLite(migrateCtx, db.Std); err != nil {
		return fmt.Errorf("run migrations: %w", err)
	}
	if err := database.MigratePamBot(migrateCtx, db.Std); err != nil {
		return fmt.Errorf("run pam bot migrations: %w", err)
	}
	if err := database.MigrateBilling(migrateCtx, billingDB.Std); err != nil {
		return fmt.Errorf("run billing migrations: %w", err)
	}

	userRepo := repository.NewUserRepo(db.Std)
	if n, err := userRepo.DeleteAllSessions(migrateCtx); err != nil {
		return fmt.Errorf("clear sessions on startup: %w", err)
	} else if n > 0 {
		slog.Info("cleared auth sessions after restart", "deleted", n)
	}

	if err := database.SeedEmailExclusionsFromJSON(migrateCtx, db.Std, "static/data/exclusions.json"); err != nil {
		return fmt.Errorf("seed email exclusions: %w", err)
	}
	if err := database.SeedEmailMatchesFromJSON(migrateCtx, db.Std, "static/data/email_matches.json"); err != nil {
		return fmt.Errorf("seed email matches: %w", err)
	}
	if err := database.SeedEmailClassificationsFromJSON(migrateCtx, db.Std, "static/data/email_classifications.json"); err != nil {
		return fmt.Errorf("seed email classifications: %w", err)
	}
	if err := database.SeedAppSystemInstructionsFromFiles(migrateCtx, db.Std, "static"); err != nil {
		return fmt.Errorf("seed app system instructions: %w", err)
	}

	// ── HTTP server ────────────────────────────────────────────────────────────
	handler, err := router.New(db.Std, billingDB.Std, cfg)
	if err != nil {
		return fmt.Errorf("router: %w", err)
	}

	srv := &http.Server{
		Addr:         fmt.Sprintf(":%d", cfg.Server.Port),
		Handler:      handler,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 120 * time.Second, // longer for SSE / streaming endpoints
		IdleTimeout:  120 * time.Second,
	}

	// ── Optional pprof debug server ───────────────────────────────────────────
	// Set ENABLE_PPROF=true to expose Go profiling endpoints on :6060/debug/pprof
	if os.Getenv("ENABLE_PPROF") == "true" {
		go func() {
			pprofAddr := ":6060"
			slog.Info("pprof server starting", "addr", pprofAddr)
			if err := http.ListenAndServe(pprofAddr, nil); err != nil {
				slog.Warn("pprof server stopped", "err", err)
			}
		}()
	}

	// ── Graceful shutdown ──────────────────────────────────────────────────────
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		tlsOn := cfg.Server.TLSCertFile != "" && cfg.Server.TLSKeyFile != ""
		slog.Info("server starting", "addr", srv.Addr, "tls", tlsOn)
		var err error
		if tlsOn {
			err = srv.ListenAndServeTLS(cfg.Server.TLSCertFile, cfg.Server.TLSKeyFile)
		} else {
			err = srv.ListenAndServe()
		}
		if err != nil && err != http.ErrServerClosed {
			slog.Error("server error", "err", err)
			os.Exit(1)
		}
	}()

	<-quit
	slog.Info("shutdown signal received")

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer shutdownCancel()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("graceful shutdown: %w", err)
	}

	slog.Info("server stopped cleanly")
	return nil
}
