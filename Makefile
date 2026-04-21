.PHONY: check-go build build-exe build-exe-electron build-linux build-launcher test generate lint run clean tidy

MODULE := github.com/daveontour/aimuseum
BINARY := digitalmuseum
CMD     := ./cmd/server

# go.mod is 1.25+; grpc and stdlib (log/slog, slices, …) need a current toolchain.
check-go:
	@go version >/dev/null 2>&1 || { echo >&2 "go: not found in PATH"; exit 1; }
	@if go version | grep -qE ' go1\.([0-9]\.|1[0-9]\.|2[0-4]\.)'; then \
		echo >&2 "This project requires Go 1.25 or newer."; \
		echo >&2 "Current: $$(go version)"; \
		echo >&2 "Install: winget upgrade GoLang.Go   or   https://go.dev/dl/"; \
		exit 1; \
	fi

build: check-go
	go build -o bin/$(BINARY) $(CMD)

build-exe: check-go
	go build -o bin/$(BINARY).exe $(CMD)

# Windowsgui subsystem build — no console window when launched by Electron.
build-exe-electron: check-go
	go build -ldflags="-H windowsgui" -o bin/$(BINARY).exe $(CMD)

build-linux: check-go
	GOOS=linux GOARCH=amd64 go build -o bin/$(BINARY)-linux-amd64 $(CMD)

build-launcher: check-go
	go build -buildvcs=false -ldflags="-H windowsgui" -o launcher.exe ./cmd/launcher

run: check-go
	go run $(CMD)

test: check-go
	go test ./...

test-verbose: check-go
	go test -v ./...

generate:
	sqlc generate

lint:
	golangci-lint run ./...

tidy: check-go
	go mod tidy

clean:
	rm -f bin/$(BINARY)

# Run with race detector
race: check-go
	go run -race $(CMD)

# Build and run (convenience)
dev: build
	./bin/$(BINARY)

# ── Electron targets ──────────────────────────────────────────────────────────

# Run Electron in dev mode against the local source tree (no packaging).
# Requires Go binary at bin/digitalmuseum.exe.
electron-dev: build-exe-electron
	cd electron && npm install --prefer-offline && npx electron .

# Package the Electron app into a distributable installer.
# Produces dist/electron/Digital Museum Setup *.exe
electron-dist: build-exe-electron
	cd electron && npm install --prefer-offline && npx electron-builder
