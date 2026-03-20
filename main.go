package main

import (
	"bufio"
	"bytes"
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
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/BurntSushi/toml"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/tarm/serial"
)

//go:embed static
var staticEmbed embed.FS

//go:embed index.html
var indexHTML string

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
	logFile     *os.File
	logWriter   *bufio.Writer
	history     []string
	isConnected bool
	clients     map[string]*Client
	clientsMu   sync.RWMutex
	sendHistory []string
	dataMode    string // "ascii" or "hex"
	writeChan   chan []byte
	receiveChan chan []byte
	mu          sync.Mutex
}

// Client wraps websocket connection
type Client struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

// ANSI regex for stripping (only used for logging)
var ansiRegex = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]`)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "-h" {
		printHelp()
		return
	}

	app := &App{
		clients:     make(map[string]*Client),
		sendHistory: []string{},
		dataMode:    "ascii",
		writeChan:   make(chan []byte, 1024),
		receiveChan: make(chan []byte, 32768),
	}
	app.loadConfig()

	r := gin.Default()

	// Extract the static subdirectory from embedded filesystem
	staticFS, err := fs.Sub(staticEmbed, "static")
	if err != nil {
		panic(err)
	}

	// Serve embedded static files
	r.StaticFS("/static", http.FS(staticFS))

	// Serve embedded index.html
	r.GET("/", func(c *gin.Context) {
		c.Data(http.StatusOK, "text/html; charset=utf-8", []byte(indexHTML))
	})

	r.GET("/ws", app.handleWebSocket)

	r.POST("/connect", app.handleConnect)
	r.POST("/disconnect", app.handleDisconnect)
	r.POST("/scan", app.handleScan)
	r.POST("/setbaud", app.handleSetBaud)
	r.POST("/send", app.handleSend)
	r.POST("/setport", app.handleSetPort)
	r.POST("/setmode", app.handleSetMode)
	r.POST("/clear", app.handleClear)
	r.POST("/getconfig", app.handleGetConfig)
	r.POST("/saveconfig", app.handleSaveConfig)

	r.Run(":8080")
}

func printHelp() {
	fmt.Println("SerialZero - Serial Port Assistant Tool")
	fmt.Println("Usage: SerialZero [options]")
	fmt.Println("Options:")
	fmt.Println("  -h  Show help information")
	fmt.Println("After starting, visit http://localhost:8080")
}

func (a *App) loadConfig() {
	if _, err := toml.DecodeFile("config.toml", &a.config); err != nil {
		log.Printf("Failed to load configuration: %v, using default", err)
		a.config.Serial.Port = "COM1"
		a.config.Serial.Baud = 9600
		a.config.Serial.Databits = 8
		a.config.Serial.Stopbits = 1
		a.config.Serial.Parity = "N"
		a.config.Log.Path = "./logs"
		a.config.UI.Font = "Nerd Font Mono"
		a.config.UI.FontSize = 14
		a.config.UI.Timestamp = true
		a.config.UI.Shell = true
		a.config.Highlight.Groups = []string{"ok:#ff0000", "error:#ff0000", "warn:#ffa500", "debug:#00ffff"}
	}
	if a.config.UI.Font == "" {
		a.config.UI.Font = "Nerd Font Mono"
	}
	if a.config.UI.FontSize == 0 {
		a.config.UI.FontSize = 14
	}
	os.MkdirAll(a.config.Log.Path, 0755)
}

func (a *App) handleWebSocket(c *gin.Context) {
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Println("WebSocket upgrade failed:", err)
		return
	}
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

	a.sendToClient(clientID, map[string]interface{}{
		"type":      "config",
		"config":    a.config,
		"connected": a.isConnected,
		"mode":      a.dataMode,
	})

	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			break
		}
	}
}

func (a *App) broadcast(message interface{}) {
	data, _ := json.Marshal(message)
	a.clientsMu.RLock()
	clientsCopy := make(map[string]*Client, len(a.clients))
	for id, c := range a.clients {
		clientsCopy[id] = c
	}
	a.clientsMu.RUnlock()

	for id, client := range clientsCopy {
		if client == nil {
			continue
		}
		client.mu.Lock()
		client.conn.SetWriteDeadline(time.Now().Add(3 * time.Second))
		err := client.conn.WriteMessage(websocket.TextMessage, data)
		client.mu.Unlock()
		if err != nil {
			log.Printf("WebSocket write error for %s: %v", id, err)
			a.clientsMu.Lock()
			if cur, ok := a.clients[id]; ok && cur == client {
				delete(a.clients, id)
			}
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
	if !ok || client == nil {
		return
	}
	client.mu.Lock()
	client.conn.SetWriteDeadline(time.Now().Add(3 * time.Second))
	err := client.conn.WriteMessage(websocket.TextMessage, data)
	client.mu.Unlock()
	if err != nil {
		log.Printf("sendToClient error for %s: %v", clientID, err)
		a.clientsMu.Lock()
		if cur, ok := a.clients[clientID]; ok && cur == client {
			delete(a.clients, clientID)
		}
		a.clientsMu.Unlock()
		client.conn.Close()
	}
}

// ---------- Serial Port Operations ----------
func (a *App) handleConnect(c *gin.Context) {
	if a.isConnected {
		c.JSON(200, gin.H{"status": "already connected"})
		return
	}
	cfg := &serial.Config{
		Name:        a.config.Serial.Port,
		Baud:        a.config.Serial.Baud,
		Size:        byte(a.config.Serial.Databits),
		StopBits:    serial.StopBits(a.config.Serial.Stopbits),
		Parity:      serial.Parity(a.config.Serial.Parity[0]),
		ReadTimeout: time.Millisecond * 100,
	}
	port, err := serial.OpenPort(cfg)
	if err != nil {
		c.JSON(200, gin.H{"status": "error", "message": err.Error()})
		return
	}
	a.port = port
	a.isConnected = true
	a.openLogFile()
	a.writeChan = make(chan []byte, 1024)
	a.receiveChan = make(chan []byte, 32768)
	go a.readData()
	go a.processReceiver()
	go a.writeLoop()
	a.broadcast(map[string]interface{}{
		"type":    "status",
		"message": fmt.Sprintf("Serial port %s connected", a.config.Serial.Port),
	})
	c.JSON(200, gin.H{"status": "connected"})
}

func (a *App) handleDisconnect(c *gin.Context) {
	if !a.isConnected {
		c.JSON(200, gin.H{"status": "not connected"})
		return
	}
	if a.port != nil {
		a.port.Close()
		a.port = nil
	}
	a.isConnected = false
	if a.logFile != nil {
		a.logWriter.Flush()
		a.logFile.Close()
		a.logFile = nil
	}
	if a.writeChan != nil {
		close(a.writeChan)
		a.writeChan = nil
	}
	if a.receiveChan != nil {
		close(a.receiveChan)
		a.receiveChan = nil
	}
	a.broadcast(map[string]interface{}{
		"type":    "status",
		"message": "Serial port disconnected",
	})
	c.JSON(200, gin.H{"status": "disconnected"})
}

func (a *App) handleScan(c *gin.Context) {
	cmd := exec.Command("powershell", "-Command", "Get-CimInstance Win32_SerialPort | Select-Object -ExpandProperty DeviceID")
	out, err := cmd.Output()
	if err != nil {
		cmd = exec.Command("powershell", "-Command", "Get-WmiObject Win32_SerialPort | Select-Object -ExpandProperty DeviceID")
		out, err = cmd.Output()
		if err != nil {
			c.JSON(200, gin.H{"status": "error", "message": err.Error()})
			return
		}
	}
	portsStr := strings.TrimSpace(string(out))
	var ports []string
	if portsStr != "" {
		ports = strings.Split(portsStr, "\r\n")
		for i, p := range ports {
			ports[i] = strings.TrimSpace(p)
		}
	}
	c.JSON(200, gin.H{"status": "ok", "ports": ports})
}

func (a *App) handleSetBaud(c *gin.Context) {
	baudStr := c.PostForm("baud")
	baud, err := strconv.Atoi(baudStr)
	if err != nil {
		c.JSON(200, gin.H{"status": "error", "message": "Invalid baud rate"})
		return
	}
	a.config.Serial.Baud = baud
	c.JSON(200, gin.H{"status": "ok"})
}

func (a *App) handleSetPort(c *gin.Context) {
	port := c.PostForm("port")
	if port != "" {
		a.config.Serial.Port = port
	}
	c.JSON(200, gin.H{"status": "ok"})
}

func (a *App) handleSetMode(c *gin.Context) {
	mode := c.PostForm("mode")
	if mode == "ascii" || mode == "hex" {
		a.dataMode = mode
		a.broadcast(map[string]interface{}{
			"type": "mode",
			"mode": a.dataMode,
		})
	}
	c.JSON(200, gin.H{"status": "ok"})
}

func (a *App) handleClear(c *gin.Context) {
	a.history = []string{}
	a.broadcast(map[string]interface{}{"type": "clear"})
	c.JSON(200, gin.H{"status": "ok"})
}

func (a *App) handleGetConfig(c *gin.Context) {
	c.JSON(200, gin.H{
		"config":      a.config,
		"connected":   a.isConnected,
		"mode":        a.dataMode,
		"sendHistory": a.sendHistory,
	})
}

func (a *App) handleSaveConfig(c *gin.Context) {
	var newConfig Config
	if err := c.ShouldBindJSON(&newConfig); err != nil {
		c.JSON(200, gin.H{"status": "error", "message": "Failed to parse configuration: " + err.Error()})
		return
	}
	// Apply defaults if missing
	if newConfig.Serial.Port == "" {
		newConfig.Serial.Port = "COM1"
	}
	if newConfig.Serial.Baud == 0 {
		newConfig.Serial.Baud = 9600
	}
	if newConfig.Serial.Databits == 0 {
		newConfig.Serial.Databits = 8
	}
	if newConfig.Serial.Stopbits == 0 {
		newConfig.Serial.Stopbits = 1
	}
	if newConfig.Serial.Parity == "" {
		newConfig.Serial.Parity = "N"
	}
	if newConfig.UI.Font == "" {
		newConfig.UI.Font = "Nerd Font Mono"
	}
	if newConfig.UI.FontSize == 0 {
		newConfig.UI.FontSize = 14
	}
	if newConfig.Log.Path == "" {
		newConfig.Log.Path = "./logs"
	}
	if newConfig.Highlight.Groups == nil {
		newConfig.Highlight.Groups = []string{"ok:#ff0000", "error:#ff0000", "warn:#ffa500", "debug:#00ffff"}
	}
	a.config = newConfig

	file, err := os.Create("config.toml")
	if err != nil {
		c.JSON(200, gin.H{"status": "error", "message": "Failed to create config file: " + err.Error()})
		return
	}
	defer file.Close()
	if err := toml.NewEncoder(file).Encode(a.config); err != nil {
		c.JSON(200, gin.H{"status": "error", "message": "Failed to write config: " + err.Error()})
		return
	}

	a.broadcast(map[string]interface{}{
		"type":      "config",
		"config":    a.config,
		"connected": a.isConnected,
		"mode":      a.dataMode,
	})
	c.JSON(200, gin.H{"status": "ok"})
}

func (a *App) handleSend(c *gin.Context) {
	data := c.PostForm("data")
	if !a.isConnected || a.port == nil {
		c.JSON(200, gin.H{"status": "error", "message": "Serial port not connected"})
		return
	}
	var sendData []byte
	if a.dataMode == "hex" {
		clean := strings.ReplaceAll(data, " ", "")
		var err error
		sendData, err = hex.DecodeString(clean)
		if err != nil {
			c.JSON(200, gin.H{"status": "error", "message": "Invalid HEX data"})
			return
		}
	} else {
		sendData = []byte(data)
	}
	if len(sendData) == 0 {
		c.JSON(200, gin.H{"status": "error", "message": "Empty payload"})
		return
	}
	select {
	case a.writeChan <- sendData:
	default:
		c.JSON(200, gin.H{"status": "error", "message": "Write queue full"})
		return
	}
	if data != "" && (len(a.sendHistory) == 0 || a.sendHistory[len(a.sendHistory)-1] != data) {
		a.sendHistory = append(a.sendHistory, data)
		if len(a.sendHistory) > 100 {
			a.sendHistory = a.sendHistory[1:]
		}
	}
	c.JSON(200, gin.H{"status": "ok"})
}

// ---------- Serial Read/Write Loops ----------
func (a *App) readData() {
	buf := make([]byte, 4096)
	for {
		if a.port == nil {
			return
		}
		n, err := a.port.Read(buf)
		if err != nil {
			if a.port == nil {
				return
			}
			if err == io.EOF {
				return
			}
			if strings.Contains(err.Error(), "timeout") {
				if n == 0 {
					time.Sleep(10 * time.Millisecond)
					continue
				}
			} else {
				log.Println("Read error:", err)
				time.Sleep(10 * time.Millisecond)
				continue
			}
		}
		if n > 0 {
			data := make([]byte, n)
			copy(data, buf[:n])
			if a.receiveChan != nil {
				a.receiveChan <- data
			}
		}
	}
}

func (a *App) writeLoop() {
	for data := range a.writeChan {
		if a.port == nil {
			continue
		}
		remaining := data
		for len(remaining) > 0 {
			n, err := a.port.Write(remaining)
			if err != nil {
				log.Println("Write error:", err)
				break
			}
			if n == 0 {
				time.Sleep(5 * time.Millisecond)
			}
			remaining = remaining[n:]
		}
	}
}

// processReceiver handles incoming data and broadcasts to clients
func (a *App) processReceiver() {
	const (
		flushInterval = 50 * time.Millisecond
		maxBufferSize = 8192
	)
	var pending []byte
	timer := time.NewTimer(flushInterval)
	timer.Stop()
	defer timer.Stop()

	for {
		select {
		case b, ok := <-a.receiveChan:
			if !ok {
				if len(pending) > 0 {
					a.processAndBroadcast(pending)
				}
				return
			}
			pending = append(pending, b...)
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(flushInterval)

			// Split by newline for natural line break
			for {
				idx := bytes.IndexByte(pending, '\n')
				if idx < 0 {
					break
				}
				line := pending[:idx+1]
				a.processAndBroadcast(line)
				pending = pending[idx+1:]
			}

			if len(pending) > maxBufferSize {
				log.Println("Buffer overflow, flushing")
				a.processAndBroadcast(pending)
				pending = nil
				timer.Stop()
			}

		case <-timer.C:
			if len(pending) > 0 {
				a.processAndBroadcast(pending)
				pending = nil
			}
		}
	}
}

// processAndBroadcast formats a chunk of data according to current mode and broadcasts
func (a *App) processAndBroadcast(data []byte) {
	if len(data) == 0 {
		return
	}

	var msg string
	if a.config.UI.Shell {
		// SHELL ON: send raw data as is (xterm will handle ANSI)
		msg = string(data)
		// No timestamp added in shell mode
	} else {
		// SHELL OFF: format according to dataMode
		if a.dataMode == "hex" {
			hexStr := hex.EncodeToString(data)
			var sb strings.Builder
			for i, r := range hexStr {
				if i > 0 && i%2 == 0 {
					sb.WriteByte(' ')
				}
				sb.WriteRune(r)
			}
			msg = sb.String()
		} else {
			msg = strings.ToValidUTF8(string(data), "")
		}
		// Add timestamp if enabled
		if a.config.UI.Timestamp {
			timestamp := time.Now().Format("15:04:05.000")
			msg = fmt.Sprintf("[%s] %s", timestamp, msg)
		}
	}

	a.broadcast(map[string]interface{}{
		"type":    "message",
		"message": msg,
	})

	// Log to file (strip ANSI)
	clean := ansiRegex.ReplaceAllString(string(data), "")
	if a.logWriter != nil {
		a.logWriter.WriteString(clean)
		a.logWriter.Flush()
	}
}

func (a *App) openLogFile() {
	now := time.Now()
	filename := fmt.Sprintf("%s_%s.log", a.config.Serial.Port, now.Format("20060102_150405"))
	path := filepath.Join(a.config.Log.Path, filename)
	f, err := os.Create(path)
	if err != nil {
		log.Printf("Failed to create log file: %v", err)
		return
	}
	a.logFile = f
	a.logWriter = bufio.NewWriter(f)
}
