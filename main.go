//go:build windows

package main

import (
	"bytes"
	"context"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/BurntSushi/toml"
	"github.com/getlantern/systray"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/tarm/serial"
	webview "github.com/webview/webview_go"
	"golang.org/x/sys/windows/registry"
)

//go:embed static
var staticEmbed embed.FS

//go:embed index.html
var indexHTML string

//go:embed app.ico
var iconData []byte

// Config structure
type Config struct {
	Serial struct {
		Port     string `toml:"port"`
		Baud     int    `toml:"baud"`
		Databits int    `toml:"databits"`
		Stopbits int    `toml:"stopbits"`
		Parity   string `toml:"parity"`
	} `toml:"serial"`
	Log struct {
		Path string `toml:"path"`
	} `toml:"log"`
	UI struct {
		Font      string `toml:"font"`
		FontSize  int    `toml:"fontsize"`
		Timestamp bool   `toml:"timestamp"`
		Shell     bool   `toml:"shell"`
	} `toml:"ui"`
	Highlight struct {
		Groups []string `toml:"groups"`
	} `toml:"highlight"`
}

// App main struct
type App struct {
	config      Config
	port        *serial.Port
	history     []string
	isConnected bool
	clients     map[string]*Client
	clientsMu   sync.RWMutex
	sendHistory []string
	dataMode    string
	writeChan   chan []byte
	receiveChan chan []byte
	mu          sync.Mutex
	httpServer  *http.Server
	ctx         context.Context
	cancel      context.CancelFunc
}

// Client wraps websocket connection
type Client struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

var ansiRegex = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]`)

var (
	modkernel32     = syscall.NewLazyDLL("kernel32.dll")
	procFreeConsole  = modkernel32.NewProc("FreeConsole")
	procAllocConsole = modkernel32.NewProc("AllocConsole")
)

func hideConsole() { procFreeConsole.Call() }

func showConsole() {
	procAllocConsole.Call()
	outFile, err := os.OpenFile("CONOUT$", os.O_WRONLY, 0)
	if err == nil {
		os.Stdout = outFile
		os.Stderr = outFile
		log.SetOutput(outFile)
	}
	fmt.Println("Console opened. SerialZero is running.")
	fmt.Println("Web UI: http://localhost:8080")
}

func redirectStdoutToNull() {
	nullFile, err := os.OpenFile("NUL", os.O_WRONLY, 0)
	if err == nil {
		os.Stdout = nullFile
		os.Stderr = nullFile
		log.SetOutput(nullFile)
	}
}

func main() {
	hideConsole()
	redirectStdoutToNull()

	ctx, cancel := context.WithCancel(context.Background())
	app := &App{
		clients:     make(map[string]*Client),
		sendHistory: []string{},
		dataMode:    "ascii",
		writeChan:   make(chan []byte, 1024),
		receiveChan: make(chan []byte, 32768),
		ctx:         ctx,
		cancel:      cancel,
	}

	app.loadConfig()

	// 1. 启动后台 HTTP 服务器
	go app.runWebServer()

	// 2. 启动系统托盘 (后台运行，保留退出入口)
	go func() {
		systray.Run(func() {
			systray.SetIcon(iconData)
			systray.SetTooltip("SerialZero - Running")
			mShowConsole := systray.AddMenuItem("Show Console", "Show the console window")
			systray.AddSeparator()
			mQuit := systray.AddMenuItem("Quit", "Exit the application")
			go func() {
				for {
					select {
					case <-mShowConsole.ClickedCh:
						showConsole()
					case <-mQuit.ClickedCh:
						systray.Quit()
						cancel()
						os.Exit(0) // 强制退出包括 Webview
					}
				}
			}()
		}, nil)
	}()

	// 等待 HTTP 服务器启动完成
	time.Sleep(500 * time.Millisecond)

	// 3. 【核心改造】启动原生 Webview 窗口 (主线程阻塞)
	w := webview.New(true)
	defer w.Destroy()
	w.SetTitle("SerialZero")
	w.SetSize(1024, 768, webview.HintNone) // 宽 1024, 高 768, 可调整大小
	w.Navigate("http://localhost:8080")
	w.Run()

	// 如果 Webview 窗口被用户关闭，退出整个程序
	cancel()
	os.Exit(0)
}

// ---------- 以下为原有代码，无需改动 ----------

func (a *App) runWebServer() {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())
	staticFS, err := fs.Sub(staticEmbed, "static")
	if err != nil { log.Printf("Failed to get static sub-fs: %v", err); return }
	r.StaticFS("/static", http.FS(staticFS))
	r.GET("/", func(c *gin.Context) { c.Data(http.StatusOK, "text/html; charset=utf-8", []byte(indexHTML)) })
	r.GET("/ws", a.handleWebSocket)
	r.POST("/connect", a.handleConnect)
	r.POST("/disconnect", a.handleDisconnect)
	r.POST("/scan", a.handleScan)
	r.POST("/setbaud", a.handleSetBaud)
	r.POST("/send", a.handleSend)
	r.POST("/setport", a.handleSetPort)
	r.POST("/setmode", a.handleSetMode)
	r.POST("/clear", a.handleClear)
	r.POST("/getconfig", a.handleGetConfig)
	r.POST("/saveconfig", a.handleSaveConfig)
	a.httpServer = &http.Server{Addr: ":8080", Handler: r}
	go func() {
		if err := a.httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed { log.Printf("HTTP server error: %v", err) }
	}()
	<-a.ctx.Done()
}

func (a *App) handleWebSocket(c *gin.Context) {
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil { return }
	clientID := uuid.New().String()
	a.clientsMu.Lock()
	a.clients[clientID] = &Client{conn: conn}
	a.clientsMu.Unlock()
	defer func() {
		a.clientsMu.Lock()
		delete(a.clients, clientID)
		a.clientsMu.Unlock()
		conn.Close()
	}()
	a.sendToClient(clientID, map[string]interface{}{"type": "config", "config": a.config, "connected": a.isConnected, "mode": a.dataMode})
	for {
		_, message, err := conn.ReadMessage()
		if err != nil { break }
		var data map[string]interface{}
		if err := json.Unmarshal(message, &data); err == nil {
			if data["type"] == "input" {
				if inputData, ok := data["data"].(string); ok {
					if a.isConnected {
						select {
						case a.writeChan <- []byte(inputData):
						default:
						}
					}
				}
			}
		}
	}
}

func (a *App) broadcast(message interface{}) {
	data, _ := json.Marshal(message)
	a.clientsMu.RLock()
	clientsCopy := make(map[string]*Client, len(a.clients))
	for id, c := range a.clients { clientsCopy[id] = c }
	a.clientsMu.RUnlock()
	for id, client := range clientsCopy {
		if client == nil { continue }
		client.mu.Lock()
		client.conn.SetWriteDeadline(time.Now().Add(3 * time.Second))
		err := client.conn.WriteMessage(websocket.TextMessage, data)
		client.mu.Unlock()
		if err != nil {
			a.clientsMu.Lock()
			if cur, ok := a.clients[id]; ok && cur == client { delete(a.clients, id) }
			a.clientsMu.Unlock()
			client.conn.Close()
		}
	}
}

func (a *App) sendToClient(clientID string, message interface{}) {
	data, _ := json.Marshal(message)
	a.clientsMu.RLock()
	client, ok := a.clients[clientID]
	a.clientsMu.RUnlock()
	if !ok || client == nil { return }
	client.mu.Lock()
	client.conn.SetWriteDeadline(time.Now().Add(3 * time.Second))
	err := client.conn.WriteMessage(websocket.TextMessage, data)
	client.mu.Unlock()
	if err != nil {
		a.clientsMu.Lock()
		if cur, ok := a.clients[clientID]; ok && cur == client { delete(a.clients, clientID) }
		a.clientsMu.Unlock()
		client.conn.Close()
	}
}

func (a *App) handleConnect(c *gin.Context) {
	if a.isConnected { c.JSON(200, gin.H{"status": "already connected"}); return }
	cfg := &serial.Config{Name: a.config.Serial.Port, Baud: a.config.Serial.Baud, Size: byte(a.config.Serial.Databits), StopBits: serial.StopBits(a.config.Serial.Stopbits), Parity: serial.Parity(a.config.Serial.Parity[0]), ReadTimeout: time.Millisecond * 100}
	port, err := serial.OpenPort(cfg)
	if err != nil { c.JSON(200, gin.H{"status": "error", "message": err.Error()}); return }
	a.port = port; a.isConnected = true; a.writeChan = make(chan []byte, 1024); a.receiveChan = make(chan []byte, 32768)
	go a.readData(); go a.processReceiver(); go a.writeLoop()
	a.broadcast(map[string]interface{}{"type": "status", "message": fmt.Sprintf("Serial port %s connected", a.config.Serial.Port)})
	c.JSON(200, gin.H{"status": "connected"})
}

func (a *App) handleDisconnect(c *gin.Context) {
	if !a.isConnected { c.JSON(200, gin.H{"status": "not connected"}); return }
	if a.port != nil { a.port.Close(); a.port = nil }
	a.isConnected = false
	if a.writeChan != nil { close(a.writeChan); a.writeChan = nil }
	if a.receiveChan != nil { close(a.receiveChan); a.receiveChan = nil }
	a.broadcast(map[string]interface{}{"type": "status", "message": "Serial port disconnected"})
	c.JSON(200, gin.H{"status": "disconnected"})
}

func (a *App) handleScan(c *gin.Context) {
	var ports []string
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, `HARDWARE\DEVICEMAP\SERIALCOMM`, registry.QUERY_VALUE)
	if err == nil {
		defer k.Close(); names, _ := k.ReadValueNames(0)
		for _, name := range names { val, _, err := k.GetStringValue(name); if err == nil { ports = append(ports, val) } }
		sort.Strings(ports)
	}
	c.JSON(200, gin.H{"status": "ok", "ports": ports})
}

func (a *App) handleSetBaud(c *gin.Context) {
	baudStr := c.PostForm("baud"); baud, err := strconv.Atoi(baudStr)
	if err != nil { c.JSON(200, gin.H{"status": "error", "message": "Invalid baud rate"}); return }
	a.config.Serial.Baud = baud; c.JSON(200, gin.H{"status": "ok"})
}

func (a *App) handleSetPort(c *gin.Context) {
	port := c.PostForm("port"); if port != "" { a.config.Serial.Port = port }; c.JSON(200, gin.H{"status": "ok"})
}

func (a *App) handleSetMode(c *gin.Context) {
	mode := c.PostForm("mode")
	if mode == "ascii" || mode == "hex" { a.dataMode = mode; a.broadcast(map[string]interface{}{"type": "mode", "mode": a.dataMode}) }
	c.JSON(200, gin.H{"status": "ok"})
}

func (a *App) handleClear(c *gin.Context) {
	a.history = []string{}; a.broadcast(map[string]interface{}{"type": "clear"}); c.JSON(200, gin.H{"status": "ok"})
}

func (a *App) handleGetConfig(c *gin.Context) {
	c.JSON(200, gin.H{"config": a.config, "connected": a.isConnected, "mode": a.dataMode, "sendHistory": a.sendHistory})
}

func (a *App) handleSaveConfig(c *gin.Context) {
	var newConfig Config
	if err := c.ShouldBindJSON(&newConfig); err != nil { c.JSON(200, gin.H{"status": "error", "message": "Failed to parse configuration: " + err.Error()}); return }
	if newConfig.Serial.Port == "" { newConfig.Serial.Port = "COM1" }
	if newConfig.Serial.Baud == 0 { newConfig.Serial.Baud = 9600 }
	if newConfig.Serial.Databits == 0 { newConfig.Serial.Databits = 8 }
	if newConfig.Serial.Stopbits == 0 { newConfig.Serial.Stopbits = 1 }
	if newConfig.Serial.Parity == "" { newConfig.Serial.Parity = "N" }
	if newConfig.UI.Font == "" { newConfig.UI.Font = "Nerd Font Mono" }
	if newConfig.UI.FontSize == 0 { newConfig.UI.FontSize = 14 }
	if newConfig.Log.Path == "" { newConfig.Log.Path = "./logs" }
	if newConfig.Highlight.Groups == nil { newConfig.Highlight.Groups = []string{"ok:#ff0000", "error:#ff0000", "warn:#ffa500", "debug:#00ffff"} }
	a.config = newConfig
	file, err := os.Create("config.toml")
	if err != nil { c.JSON(200, gin.H{"status": "error", "message": "Failed to create config file: " + err.Error()}); return }
	defer file.Close()
	if err := toml.NewEncoder(file).Encode(a.config); err != nil { c.JSON(200, gin.H{"status": "error", "message": "Failed to write config: " + err.Error()}); return }
	a.broadcast(map[string]interface{}{"type": "config", "config": a.config, "connected": a.isConnected, "mode": a.dataMode})
	c.JSON(200, gin.H{"status": "ok"})
}

func (a *App) handleSend(c *gin.Context) {
	data := c.PostForm("data")
	if !a.isConnected || a.port == nil { c.JSON(200, gin.H{"status": "error", "message": "Serial port not connected"}); return }
	var sendData []byte
	if a.dataMode == "hex" {
		clean := strings.ReplaceAll(data, " ", ""); var err error
		sendData, err = hex.DecodeString(clean)
		if err != nil { c.JSON(200, gin.H{"status": "error", "message": "Invalid HEX data"}); return }
	} else { sendData = []byte(data) }
	if len(sendData) == 0 { c.JSON(200, gin.H{"status": "error", "message": "Empty payload"}); return }
	select {
	case a.writeChan <- sendData:
	default: c.JSON(200, gin.H{"status": "error", "message": "Write queue full"}); return
	}
	if data != "" && (len(a.sendHistory) == 0 || a.sendHistory[len(a.sendHistory)-1] != data) {
		a.sendHistory = append(a.sendHistory, data)
		if len(a.sendHistory) > 100 { a.sendHistory = a.sendHistory[1:] }
	}
	c.JSON(200, gin.H{"status": "ok"})
}

func (a *App) readData() {
	buf := make([]byte, 4096)
	for {
		if a.port == nil { return }
		n, err := a.port.Read(buf)
		if err != nil {
			if a.port == nil { return }
			if err == io.EOF { return }
			if strings.Contains(err.Error(), "timeout") { if n == 0 { time.Sleep(10 * time.Millisecond); continue } } else { time.Sleep(10 * time.Millisecond); continue }
		}
		if n > 0 { data := make([]byte, n); copy(data, buf[:n]); if a.receiveChan != nil { a.receiveChan <- data } }
	}
}

func (a *App) writeLoop() {
	for data := range a.writeChan {
		if a.port == nil { continue }; remaining := data
		for len(remaining) > 0 { n, err := a.port.Write(remaining); if err != nil { break }; if n == 0 { time.Sleep(5 * time.Millisecond) }; remaining = remaining[n:] }
	}
}

func (a *App) processReceiver() {
	const flushInterval = 50 * time.Millisecond; var pending []byte; timer := time.NewTimer(flushInterval); timer.Stop(); defer timer.Stop()
	for {
		select {
		case b, ok := <-a.receiveChan:
			if !ok { if len(pending) > 0 { a.processAndBroadcast(pending) }; return }
			pending = append(pending, b...)
			if !timer.Stop() { select { case <-timer.C: default: } }; timer.Reset(flushInterval)
			for { idx := bytes.IndexByte(pending, '\n'); if idx < 0 { break }; line := pending[:idx+1]; a.processAndBroadcast(line); pending = pending[idx+1:] }
		case <-timer.C: if len(pending) > 0 { a.processAndBroadcast(pending); pending = nil } }
	}
}

func (a *App) processAndBroadcast(data []byte) {
	if len(data) == 0 { return }
	var msg string
	if a.config.UI.Shell { msg = string(data) } else {
		if a.dataMode == "hex" { hexStr := hex.EncodeToString(data); var sb strings.Builder; for i, r := range hexStr { if i > 0 && i%2 == 0 { sb.WriteByte(' ') }; sb.WriteRune(r) }; msg = sb.String() } else { msg = strings.ToValidUTF8(string(data), "") }
		if a.config.UI.Timestamp { timestamp := time.Now().Format("15:04:05.000"); msg = fmt.Sprintf("[%s] %s", timestamp, msg) }
	}
	a.broadcast(map[string]interface{}{"type": "message", "message": msg})
}

func (a *App) loadConfig() {
	if _, err := toml.DecodeFile("config.toml", &a.config); err != nil {
		a.config.Serial.Port = "COM1"; a.config.Serial.Baud = 9600; a.config.Serial.Databits = 8; a.config.Serial.Stopbits = 1; a.config.Serial.Parity = "N"
		a.config.Log.Path = "./logs"; a.config.UI.Font = "Nerd Font Mono"; a.config.UI.FontSize = 14; a.config.UI.Timestamp = true; a.config.UI.Shell = true
		a.config.Highlight.Groups = []string{"ok:#ff0000", "error:#ff0000", "warn:#ffa500", "debug:#00ffff"}
	}
	if a.config.UI.Font == "" { a.config.UI.Font = "Nerd Font Mono" }; if a.config.UI.FontSize == 0 { a.config.UI.FontSize = 14 }; os.MkdirAll(a.config.Log.Path, 0755)
}

func openBrowser(url string) {
	var err error
	switch runtime.GOOS { case "windows": err = exec.Command("cmd", "/c", "start", url).Start(); case "darwin": err = exec.Command("open", url).Start(); case "linux": err = exec.Command("xdg-open", url).Start(); default: err = fmt.Errorf("unsupported platform") }
	if err != nil { log.Printf("Failed to open browser: %v", err) }
}

