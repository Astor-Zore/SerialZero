# AGENTS.md

## Build & Run

```bash
go mod tidy
go build -ldflags="-H windowsgui" -o SerialZero.exe
```

- **Windows-only**: `//go:build windows` in `main.go`. Won't compile on Linux/macOS.
- `-ldflags="-H windowsgui"` hides the console window at startup.
- Pre-built `.syso` resource files (`rsrc_windows_amd64.syso`, `rsrc_windows_386.syso`) are checked in — do not delete them. They embed the app icon.
- `winres/` directory is for the `go-winres` tool; update `winres/app.png` and regenerate `.syso` files if the icon changes.

## Architecture

- **Single-file Go backend**: all logic in `main.go` (~980 lines). No package split.
- **Embedded static frontend**: `static/` and `index.html` are embedded at compile time via `//go:embed`. The web UI is served from inside the binary.
- **Web server**: Gin on `:8080`. The native webview window navigates to `http://localhost:8080`.
- **WebSocket**: gorilla/websocket at `/ws` for real-time serial data streaming.
- **Lua scripting**: `gopher-lua` engine. Scripts live in `./scripts/`. Exposed API: `send()`, `delay()`, `log()`, `wait()`.
- **Config**: `config.toml` in working directory, auto-generated with defaults on first run. Read/written at runtime via the web UI.

## No Tests

There are no test files in this repository. No test runner, no CI.

## Key Gotchas

- `.gitignore` only excludes `logs/`. The pre-built `.syso` files and `SerialZero.exe` are tracked.
- Serial port scanning reads Windows registry (`HARDWARE\DEVICEMAP\SERIALCOMM`) — only works on Windows.
- ANSI escape codes are stripped via regex before being forwarded to the Lua script engine.
- The send history is capped at 100 entries and deduplicates consecutive identical entries.
- The console is hidden by default; use the systray menu `Show Console` to reveal it.