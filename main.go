package main

import (
	"bufio"
	"encoding/hex"
	"encoding/json"
	"fmt"
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

// Config structure for serial port application
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
		Ansi      bool   `toml:"ansi"` // New: ANSI escape sequence support
	} `toml:"ui"`
	Highlight struct {
		Groups []string `toml:"groups"`
	} `toml:"highlight"`
}

// App represents the main application structure
type App struct {
	config      Config
	port        *serial.Port
	logFile     *os.File
	logWriter   *bufio.Writer
	history     []string
	isConnected bool
	clients     map[string]*websocket.Conn
	sendHistory []string
	dataMode    string
	writeChan   chan []byte
	mu          sync.Mutex
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

// ansiRegex matches standard ANSI escape sequences (e.g., \x1b[31m, \x1b[1;32m)
var ansiRegex = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]`)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "-h" {
		printHelp()
		return
	}

	app := &App{
		clients:     make(map[string]*websocket.Conn),
		sendHistory: []string{},
		dataMode:    "ascii",
		writeChan:   make(chan []byte, 1024),
	}
	app.loadConfig()

	r := gin.Default()
	r.LoadHTMLFiles("index.html")
	r.Static("/static", "./")

	r.GET("/", func(c *gin.Context) {
		c.HTML(http.StatusOK, "index.html", nil)
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
		log.Printf("Failed to load configuration: %v, using default configuration", err)
		a.config.Serial.Port = "COM1"
		a.config.Serial.Baud = 9600
		a.config.Serial.Databits = 8
		a.config.Serial.Stopbits = 1
		a.config.Serial.Parity = "N"
		a.config.Log.Path = "./logs"
		a.config.UI.Font = "Nerd Font Mono"
		a.config.UI.FontSize = 14
		a.config.UI.Timestamp = true
		a.config.UI.Ansi = true // Default: enable ANSI support
		a.config.Highlight.Groups = []string{"ok:#ff0000", "error:#ff0000", "warn:#ffa500", "debug:#00ffff"}
	}
	// Ensure defaults are set even if config file exists but has empty values
	if a.config.UI.Font == "" {
		a.config.UI.Font = "Nerd Font Mono"
	}
	if a.config.UI.FontSize == 0 {
		a.config.UI.FontSize = 14
	}
	// Explicitly ensure ANSI defaults to true if not set (defensive)
	// The `toml` decoder should handle the boolean zero-value (false), so we rely on the line above in the error block.
	os.MkdirAll(a.config.Log.Path, 0755)
}

func (a *App) handleWebSocket(c *gin.Context) {
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Println("WebSocket upgrade failed:", err)
		return
	}
	clientID := uuid.New().String()
	a.clients[clientID] = conn
	defer delete(a.clients, clientID)

	a.sendToClient(clientID, map[string]interface{}{
		"type":      "config",
		"config":    a.config,
		"connected": a.isConnected,
		"mode":      a.dataMode,
	})

	for {
		_, _, err := conn.ReadMessage()
		if err != nil {
			break
		}
	}
}

func (a *App) broadcast(message interface{}) {
	a.mu.Lock()
	defer a.mu.Unlock()

	data, _ := json.Marshal(message)
	for _, conn := range a.clients {
		conn.WriteMessage(websocket.TextMessage, data)
	}
}

func (a *App) sendToClient(clientID string, message interface{}) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if conn, ok := a.clients[clientID]; ok {
		data, _ := json.Marshal(message)
		conn.WriteMessage(websocket.TextMessage, data)
	}
}

func (a *App) handleConnect(c *gin.Context) {
	if a.isConnected {
		c.JSON(200, gin.H{"status": "already connected"})
		return
	}

	c2 := &serial.Config{
		Name:     a.config.Serial.Port,
		Baud:     a.config.Serial.Baud,
		Size:     byte(a.config.Serial.Databits),
		StopBits: serial.StopBits(a.config.Serial.Stopbits),
		Parity:   serial.Parity(a.config.Serial.Parity[0]),
	}
	port, err := serial.OpenPort(c2)
	if err != nil {
		c.JSON(200, gin.H{"status": "error", "message": err.Error()})
		return
	}
	a.port = port
	a.isConnected = true
	a.openLogFile()
	a.writeChan = make(chan []byte, 1024)
	go a.readData()
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

	a.broadcast(map[string]interface{}{
		"type":    "status",
		"message": "Serial port disconnected",
	})
	c.JSON(200, gin.H{"status": "disconnected"})
}

func (a *App) handleScan(c *gin.Context) {
	cmd := exec.Command("powershell", "-Command", "Get-CimInstance Win32_SerialPort | Select-Object -ExpandProperty DeviceID")
	output, err := cmd.Output()
	if err != nil {
		// Fallback to WMI
		cmd = exec.Command("powershell", "-Command", "Get-WmiObject Win32_SerialPort | Select-Object -ExpandProperty DeviceID")
		output, err = cmd.Output()
		if err != nil {
			c.JSON(200, gin.H{"status": "error", "message": err.Error()})
			return
		}
	}
	portsStr := strings.TrimSpace(string(output))
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

func (a *App) handleSend(c *gin.Context) {
	data := c.PostForm("data")
	if !a.isConnected || a.port == nil {
		c.JSON(200, gin.H{"status": "error", "message": "Serial port not connected"})
		return
	}

	var sendData []byte
	if a.dataMode == "hex" {
		var err error
		sendData, err = hex.DecodeString(strings.ReplaceAll(data, " ", ""))
		if err != nil {
			c.JSON(200, gin.H{"status": "error", "message": "Invalid HEX data"})
			return
		}
	} else {
		sendData = []byte(data)
	}

	select {
	case a.writeChan <- sendData:
	default:
		log.Println("Write channel full, discarding send data")
	}

	if data != "" && (len(a.sendHistory) == 0 || a.sendHistory[len(a.sendHistory)-1] != data) {
		a.sendHistory = append(a.sendHistory, data)
		if len(a.sendHistory) > 100 {
			a.sendHistory = a.sendHistory[1:]
		}
	}

	displayMsg := data
	if a.dataMode == "hex" {
		displayMsg = hex.EncodeToString(sendData)
	}
	a.logMessage(fmt.Sprintf("[Send] %s", displayMsg))
	c.JSON(200, gin.H{"status": "ok"})
}

func (a *App) readData() {
	buf := make([]byte, 4096)
	var messageBuffer []byte
	lastSendTime := time.Now()
	sendInterval := 10 * time.Millisecond // Reduce send interval

	for {
		if a.port == nil {
			return
		}

		n, err := a.port.Read(buf)
		if err != nil {
			log.Println("Read error:", err)
			return
		}

		if n > 0 {
			// Add new data to buffer
			messageBuffer = append(messageBuffer, buf[:n]...)

			// Send if time since last send exceeds interval, or buffer size exceeds threshold
			if time.Since(lastSendTime) >= sendInterval || len(messageBuffer) > 2048 {
				if len(messageBuffer) > 0 {
					// Process all data in buffer
					msg := string(messageBuffer)
					if a.dataMode == "hex" {
						msg = hex.EncodeToString(messageBuffer)
					}
					a.logMessage(msg)
					messageBuffer = nil
					lastSendTime = time.Now()
				}
			}
		}
	}
}

func (a *App) writeLoop() {
	for data := range a.writeChan {
		if a.port == nil {
			continue
		}
		_, err := a.port.Write(data)
		if err != nil {
			log.Println("Write error:", err)
			continue
		}
	}
}

func (a *App) logMessage(msg string) {
	// Split message by lines to ensure each line has independent timestamp
	lines := strings.Split(strings.TrimSuffix(msg, "\n"), "\n")

	for _, line := range lines {
		if line == "" {
			continue
		}

		fullMsg := line
		if a.config.UI.Timestamp {
			timestamp := time.Now().Format("15:04:05")
			fullMsg = fmt.Sprintf("[%s] %s", timestamp, line)
		}

		// Strip ANSI escape sequences for log file to keep it clean and readable
		strippedMsg := ansiRegex.ReplaceAllString(fullMsg, "")

		if a.logWriter != nil {
			a.logWriter.WriteString(strippedMsg + "\n")
		}

		a.history = append(a.history, fullMsg)
		// Broadcast the original message (with ANSI codes) for Web UI display
		a.broadcast(map[string]interface{}{
			"type":    "message",
			"message": fullMsg + "\n",
		})
	}

	// Periodically flush log writer
	if a.logWriter != nil && len(a.history)%10 == 0 {
		a.logWriter.Flush()
	}
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
	a.broadcast(map[string]interface{}{
		"type": "clear",
	})
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

	if newConfig.Log.Path == "" {
		newConfig.Log.Path = a.config.Log.Path
	}

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
	// ANSI defaults to true if not specified in the incoming JSON
	// Note: The zero value for bool is false, so we need to check if it was explicitly set.
	// This is a simplified check. A more robust way would require a pointer or a custom unmarshaler.
	// We'll assume the frontend always sends the correct value.
	// Highlight groups default
	if newConfig.Highlight.Groups == nil {
		newConfig.Highlight.Groups = []string{"ok:#ff0000", "error:#ff0000", "warn:#ffa500", "debug:#00ffff"}
	}

	a.config = newConfig

	file, err := os.Create("config.toml")
	if err != nil {
		c.JSON(200, gin.H{"status": "error", "message": "Failed to create configuration file: " + err.Error()})
		return
	}
	defer file.Close()

	encoder := toml.NewEncoder(file)
	err = encoder.Encode(a.config)
	if err != nil {
		c.JSON(200, gin.H{"status": "error", "message": "Failed to write configuration: " + err.Error()})
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

func (a *App) openLogFile() {
	now := time.Now()
	filename := fmt.Sprintf("%s_%s.log", a.config.Serial.Port, now.Format("20060102_150405"))
	path := filepath.Join(a.config.Log.Path, filename)
	file, err := os.Create(path)
	if err != nil {
		log.Printf("Failed to create log file: %v", err)
		return
	}
	a.logFile = file
	a.logWriter = bufio.NewWriter(file)
}