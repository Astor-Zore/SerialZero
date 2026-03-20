// app.js
let ws;
let historyList = [];
let historyIndex = 0;
let isConnected = false;
let currentMode = 'ascii';
let shellEnabled = true;
let timestampEnabled = true;

let highlightRules = [];
let pendingMessages = [];
let updateTimer = null;
let outputMessages = []; // Store raw message text for re-highlighting

let term = null;
let fitAddon = null;
let termContainer = document.getElementById('terminal-container');
let outputContainer = document.getElementById('output-container');
let inputArea = document.getElementById('input-area');
let resizeObserver = null;

// Default highlight rules (shown when config is empty)
const DEFAULT_HIGHLIGHT_GROUPS = [
    "error:#ff0000",
    "warn:#ffa500",
    "info:#00ff00",
    "debug:#00ffff"
];

document.addEventListener('DOMContentLoaded', function() {
    initWebSocket();
    setupEventListeners();
    setupKeyboardShortcuts();
    loadConfig();
    addConfigChangeListeners();
});

function initWebSocket() {
    ws = new WebSocket('ws://localhost:8080/ws');

    ws.onopen = function(event) {
        console.log('WebSocket connected');
    };

    ws.onmessage = function(event) {
        try {
            const data = JSON.parse(event.data);
            console.log('Received message:', data);
            
            switch(data.type) {
                case 'message':
                    if (shellEnabled) {
                        if (term) term.write(data.message);
                    } else {
                        addToOutput(data.message);
                    }
                    break;
                case 'config':
                    if (data.config) updateConfig(data.config);
                    if (data.connected !== undefined) updateConnectionStatus(data.connected);
                    if (data.mode) updateMode(data.mode);
                    break;
                case 'status':
                    console.log('Status update:', data.message);
                    break;
                case 'mode':
                    updateMode(data.mode);
                    break;
                case 'clear':
                    clearOutput(false);
                    break;
            }
        } catch (error) {
            console.error('Error parsing message:', error, event.data);
        }
    };

    ws.onclose = function(event) {
        console.log('WebSocket closed');
        setTimeout(initWebSocket, 1000);
    };

    ws.onerror = function(error) {
        console.error('WebSocket error:', error);
    };
}

function setupEventListeners() {
    document.getElementById('connect-btn').addEventListener('click', toggleConnection);
    document.getElementById('scan-btn').addEventListener('click', scanPorts);
    document.getElementById('clear-btn').addEventListener('click', clearOutput);
    document.getElementById('help-btn').addEventListener('click', showHelp);
    document.getElementById('send-btn').addEventListener('click', sendData);
    document.getElementById('save-config-btn').addEventListener('click', saveConfig);
    document.getElementById('input').addEventListener('keydown', handleInputKeydown);

    document.getElementById('ascii-mode').addEventListener('change', function() {
        if (this.checked) setMode(this.value);
    });
    document.getElementById('hex-mode').addEventListener('change', function() {
        if (this.checked) setMode(this.value);
    });
    document.getElementById('timestamp-on').addEventListener('change', function() {
        if (this.checked) setTimestamp(true);
    });
    document.getElementById('timestamp-off').addEventListener('change', function() {
        if (this.checked) setTimestamp(false);
    });
    document.getElementById('shell-on').addEventListener('change', function() {
        if (this.checked) setShellEnabled(true);
    });
    document.getElementById('shell-off').addEventListener('change', function() {
        if (this.checked) setShellEnabled(false);
    });

    document.querySelector('.close').addEventListener('click', closeModal);
    window.addEventListener('click', function(event) {
        if (event.target == document.getElementById('modal')) closeModal();
    });
}

function addConfigChangeListeners() {
    document.getElementById('port-input').addEventListener('change', function() {
        updatePortInfo(this.value, document.getElementById('baud-input').value);
        saveConfigSilently();
    });
    document.getElementById('baud-input').addEventListener('change', function() {
        updatePortInfo(document.getElementById('port-input').value, this.value);
        saveConfigSilently();
    });
    document.getElementById('databits-select').addEventListener('change', saveConfigSilently);
    document.getElementById('stopbits-select').addEventListener('change', saveConfigSilently);
    document.getElementById('parity-select').addEventListener('change', saveConfigSilently);
    document.getElementById('font-input').addEventListener('change', function() {
        applyFontSettings(this.value, document.getElementById('fontsize-input').value);
        saveConfigSilently();
    });
    document.getElementById('fontsize-input').addEventListener('change', function() {
        applyFontSettings(document.getElementById('font-input').value, this.value);
        saveConfigSilently();
    });
    document.getElementById('highlight-input').addEventListener('change', function() {
        updateHighlightRules(this.value.split('\n').map(l => l.trim()).filter(l => l));
        rerenderAllOutput();
        saveConfigSilently();
    });
}

function setupKeyboardShortcuts() {
    document.addEventListener('keydown', function(event) {
        if (event.target.tagName === 'INPUT' && event.target.id !== 'input') return;
        switch(event.key) {
            case 'F1': event.preventDefault(); showHelp(); break;
            case 'F2': event.preventDefault(); toggleConnection(); break;
            case 'F3': event.preventDefault(); scanPorts(); break;
            case 'Escape': event.preventDefault(); closeModal(); break;
        }
    });
}

function toggleConnection() {
    if (isConnected) disconnect(); else connect();
}

function connect() {
    fetch('/connect', { method: 'POST' })
        .then(response => response.json())
        .then(data => {
            if (data.status === 'connected') {
                isConnected = true;
                updateConnectionStatus(true);
            } else {
                alert('Connection failed: ' + data.message);
            }
        });
}

function disconnect() {
    fetch('/disconnect', { method: 'POST' })
        .then(response => response.json())
        .then(data => {
            if (data.status === 'disconnected') {
                isConnected = false;
                updateConnectionStatus(false);
            }
        });
}

function scanPorts() {
    const modalBody = document.getElementById('modal-body');
    modalBody.innerHTML = `
        <h3>Scanning serial ports...</h3>
        <div class="loader">
            <div class="spinner"></div>
            <div class="loader-text">Please wait, detecting available serial ports...</div>
        </div>
    `;
    document.getElementById('modal').style.display = 'block';

    fetch('/scan', { method: 'POST' })
        .then(response => response.json())
        .then(data => {
            if (data.status === 'ok') showPortSelection(data.ports);
            else showPortSelectionError(data.message);
        })
        .catch(error => showPortSelectionError(error.message));
}

function setMode(mode) {
    if (shellEnabled) return;
    const formData = new FormData();
    formData.append('mode', mode);
    fetch('/setmode', { method: 'POST', body: formData })
        .then(response => response.json())
        .then(data => {
            if (data.status === 'ok') {
                currentMode = mode;
                updateMode(mode);
            }
        });
}

function setTimestamp(enabled) {
    timestampEnabled = enabled;
    updateTimestampStatus(enabled);
    saveConfigSilently();
}

function setShellEnabled(enabled) {
    shellEnabled = enabled;
    updateShellStatus(enabled);
    
    if (enabled) {
        outputContainer.style.display = 'none';
        termContainer.style.display = 'flex';
        inputArea.style.display = 'none';
        if (!term) {
            initTerminal();
        } else {
            fitTerminal();
        }
    } else {
        outputContainer.style.display = 'flex';
        termContainer.style.display = 'none';
        inputArea.style.display = 'flex';
        if (term) {
            term.dispose();
            term = null;
            fitAddon = null;
            if (resizeObserver) {
                resizeObserver.disconnect();
                resizeObserver = null;
            }
        }
        clearOutput(false);
    }
    saveConfigSilently();
}

function initTerminal() {
    // Robustly get FitAddon constructor from global object (handles both UMD and direct exports)
    let FitAddonConstructor = window.FitAddon || (typeof FitAddon !== 'undefined' ? FitAddon : null);
    // If it's an object with a FitAddon property (UMD wrapper), extract the actual constructor
    if (FitAddonConstructor && typeof FitAddonConstructor === 'object' && FitAddonConstructor.FitAddon) {
        FitAddonConstructor = FitAddonConstructor.FitAddon;
    }
    if (!FitAddonConstructor) {
        console.error('FitAddon is not available. Make sure xterm-addon-fit.js is loaded.');
        return;
    }
    if (typeof FitAddonConstructor !== 'function') {
        console.error('FitAddon is not a constructor. Available:', FitAddonConstructor);
        return;
    }

    term = new Terminal({
        cursorBlink: true,
        theme: {
            background: '#1a1a2e',
            foreground: '#e6e6e6',
            cursor: '#6c63ff'
        },
        fontSize: parseInt(document.getElementById('fontsize-input').value) || 14,
        fontFamily: document.getElementById('font-input').value || 'CaskaydiaMono NF, monospace',
        scrollback: 10000
    });
    
    fitAddon = new FitAddonConstructor();
    term.loadAddon(fitAddon);
    
    term.open(termContainer);
    
    term.onData(data => {
        const formData = new FormData();
        formData.append('data', data);
        fetch('/send', { method: 'POST', body: formData })
            .catch(err => console.error('Send error:', err));
    });
    
    const fitTerminalOnce = () => {
        if (term && fitAddon && shellEnabled && termContainer.offsetWidth > 0 && termContainer.offsetHeight > 0) {
            fitAddon.fit();
            return true;
        }
        return false;
    };
    
    if (window.ResizeObserver) {
        resizeObserver = new ResizeObserver(() => {
            if (term && fitAddon && shellEnabled) {
                fitTerminalOnce();
            }
        });
        resizeObserver.observe(termContainer);
    }
    
    const attemptFit = (attempts = 10) => {
        if (attempts <= 0) return;
        if (fitTerminalOnce()) return;
        setTimeout(() => attemptFit(attempts - 1), 50);
    };
    
    requestAnimationFrame(() => {
        fitTerminalOnce();
        setTimeout(() => fitTerminalOnce(), 100);
        setTimeout(() => fitTerminalOnce(), 200);
        attemptFit(8);
    });
    
    window.addEventListener('resize', () => {
        if (term && fitAddon && shellEnabled) {
            fitTerminalOnce();
        }
    });
}

function fitTerminal() {
    if (term && fitAddon && shellEnabled && termContainer.offsetWidth > 0 && termContainer.offsetHeight > 0) {
        fitAddon.fit();
    }
}

function addToHistory(command) {
    if (!command || command.trim() === '' || shellEnabled) return;
    command = command.trim();
    if (historyList.length > 0 && historyList[historyList.length - 1] === command) return;
    historyList.push(command);
    if (historyList.length > 100) historyList.shift();
    historyIndex = historyList.length;
}

function navigateHistory(direction) {
    if (historyList.length === 0 || shellEnabled) return;
    let newIndex = historyIndex + direction;
    if (newIndex < 0) newIndex = 0;
    if (newIndex >= historyList.length) newIndex = historyList.length - 1;
    historyIndex = newIndex;
    document.getElementById('input').value = historyList[historyIndex];
}

function sendData() {
    if (shellEnabled) return;
    const input = document.getElementById('input');
    const data = input.value;
    if (data === '') return;

    const formData = new FormData();
    formData.append('data', data);
    fetch('/send', { method: 'POST', body: formData })
        .then(response => response.json())
        .then(res => {
            if (res.status === 'ok') {
                addToHistory(data);
                input.value = '';
                historyIndex = historyList.length;
            } else {
                alert('Send failed: ' + res.message);
            }
        });
}

function handleInputKeydown(event) {
    if (shellEnabled) return;
    if (event.key === 'Enter') {
        event.preventDefault();
        sendData();
    } else if (event.key === 'Tab') {
        event.preventDefault();
        const formData = new FormData();
        formData.append('data', '\t');
        fetch('/send', { method: 'POST', body: formData });
    } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        navigateHistory(-1);
    } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        navigateHistory(1);
    }
}

function addToOutput(text) {
    outputMessages.push(text);
    pendingMessages.push(text);
    scheduleOutputUpdate();
}

function scheduleOutputUpdate() {
    if (!updateTimer) updateTimer = setTimeout(flushOutput, 16);
}

function flushOutput() {
    updateTimer = null;
    if (pendingMessages.length === 0) return;

    const output = document.getElementById('output');
    const fragment = document.createDocumentFragment();
    const batch = pendingMessages.splice(0, Math.min(50, pendingMessages.length));
    
    batch.forEach(msg => {
        const html = applyHighlight(msg);
        const div = document.createElement('div');
        div.innerHTML = html;
        fragment.appendChild(div);
    });

    output.appendChild(fragment);
    const children = output.children;
    if (children.length > 2000) {
        const toRemove = children.length - 2000;
        for (let i = 0; i < toRemove; i++) if (children[0]) output.removeChild(children[0]);
    }
    scrollToBottom();
    if (pendingMessages.length > 0) scheduleOutputUpdate();
}

function rerenderAllOutput() {
    const outputDiv = document.getElementById('output');
    outputDiv.innerHTML = '';
    const fragment = document.createDocumentFragment();
    outputMessages.forEach(msg => {
        const html = applyHighlight(msg);
        const div = document.createElement('div');
        div.innerHTML = html;
        fragment.appendChild(div);
    });
    outputDiv.appendChild(fragment);
    scrollToBottom();
}

function scrollToBottom() {
    const output = document.getElementById('output');
    output.scrollTop = output.scrollHeight;
}

function clearOutput(sendClear = true) {
    if (sendClear) fetch('/clear', { method: 'POST' });
    if (shellEnabled && term) term.clear();
    else {
        document.getElementById('output').innerHTML = '';
        pendingMessages = [];
        outputMessages = [];
        if (updateTimer) { clearTimeout(updateTimer); updateTimer = null; }
    }
}

function updateHighlightRules(lines) {
    highlightRules = lines.map(line => {
        const parts = line.split(':');
        if (parts.length < 2) return null;
        const pattern = parts[0];
        const color = parts.slice(1).join(':');
        try { return { regex: new RegExp(pattern, 'gi'), color }; }
        catch (e) { console.warn('Invalid regex:', pattern); return null; }
    }).filter(r => r !== null);
}

function stripAnsi(str) {
    return str.replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, "");
}

function escapeHtml(str) {
    return str.replace(/[&<>"]/g, tag => {
        const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
        return map[tag] || tag;
    });
}

function applyHighlight(text) {
    let cleaned = stripAnsi(text);
    let result = escapeHtml(cleaned);
    highlightRules.forEach(rule => {
        result = result.replace(rule.regex, match => `<span style="color:${rule.color}; font-weight:600;">${match}</span>`);
    });
    return result;
}

function updateConnectionStatus(connected) {
    isConnected = connected;
    const status = document.getElementById('connection-status');
    status.textContent = connected ? 'Connected' : 'Disconnected';
    status.className = connected ? 'connected' : '';
}

function updateMode(mode) {
    currentMode = mode;
    document.getElementById('data-mode').textContent = 'Mode: ' + mode.toUpperCase();
    document.getElementById('ascii-mode').checked = (mode === 'ascii');
    document.getElementById('hex-mode').checked = (mode === 'hex');
}

function updateTimestampStatus(enabled) {
    timestampEnabled = enabled;
    document.getElementById('timestamp-status').textContent = `Timestamp: ${enabled ? 'ON' : 'OFF'}`;
    document.getElementById('timestamp-on').checked = enabled;
    document.getElementById('timestamp-off').checked = !enabled;
}

function updateShellStatus(enabled) {
    shellEnabled = enabled;
    document.getElementById('shell-status').textContent = `SHELL: ${enabled ? 'ON' : 'OFF'}`;
    document.getElementById('shell-on').checked = enabled;
    document.getElementById('shell-off').checked = !enabled;
}

function updatePortInfo(port, baud) {
    document.getElementById('port-info').textContent = `Port: ${port} | Baudrate: ${baud}`;
}

function applyFontSettings(font, size) {
    const output = document.getElementById('output');
    if (font) {
        output.style.fontFamily = font;
        if (term) term.setOption('fontFamily', font);
    }
    if (size) {
        output.style.fontSize = size + 'px';
        if (term) term.setOption('fontSize', size);
        if (term && fitAddon && shellEnabled) {
            setTimeout(() => fitTerminal(), 50);
        }
    }
    document.documentElement.style.setProperty('--output-font', font || 'monospace');
    document.documentElement.style.setProperty('--output-font-size', (size || 14) + 'px');
}

function loadConfig() {
    fetch('/getconfig', { method: 'POST' })
        .then(response => response.json())
        .then(data => {
            updateConfig(data.config);
            updateConnectionStatus(data.connected);
            updateMode(data.mode);
        });
}

function updateConfig(config) {
    if (!config) return;
    if (config.Serial) {
        document.getElementById('port-input').value = config.Serial.Port || 'COM1';
        document.getElementById('baud-input').value = config.Serial.Baud || 9600;
        document.getElementById('databits-select').value = config.Serial.Databits || 8;
        document.getElementById('stopbits-select').value = config.Serial.Stopbits || 1;
        document.getElementById('parity-select').value = config.Serial.Parity || 'N';
        updatePortInfo(config.Serial.Port, config.Serial.Baud);
    }
    if (config.UI) {
        document.getElementById('font-input').value = config.UI.Font || 'Nerd Font Mono';
        document.getElementById('fontsize-input').value = config.UI.FontSize || 14;
        applyFontSettings(config.UI.Font, config.UI.FontSize);
        updateTimestampStatus(config.UI.Timestamp !== undefined ? config.UI.Timestamp : true);
        updateShellStatus(config.UI.Shell !== undefined ? config.UI.Shell : true);
        
        if (config.UI.Shell && !term) {
            outputContainer.style.display = 'none';
            termContainer.style.display = 'flex';
            inputArea.style.display = 'none';
            initTerminal();
        } else if (config.UI.Shell && term && fitAddon) {
            setTimeout(() => fitTerminal(), 100);
        }
    }
    if (config.Highlight && config.Highlight.Groups) {
        const groups = Array.isArray(config.Highlight.Groups) ? config.Highlight.Groups : [];
        if (groups.length === 0) {
            document.getElementById('highlight-input').value = DEFAULT_HIGHLIGHT_GROUPS.join('\n');
            updateHighlightRules(DEFAULT_HIGHLIGHT_GROUPS);
        } else {
            document.getElementById('highlight-input').value = groups.join('\n');
            updateHighlightRules(groups);
        }
        if (!shellEnabled && outputMessages.length > 0) {
            rerenderAllOutput();
        }
    } else {
        document.getElementById('highlight-input').value = DEFAULT_HIGHLIGHT_GROUPS.join('\n');
        updateHighlightRules(DEFAULT_HIGHLIGHT_GROUPS);
        if (!shellEnabled && outputMessages.length > 0) {
            rerenderAllOutput();
        }
    }
}

function saveConfig() {
    const config = {
        Serial: {
            Port: document.getElementById('port-input').value,
            Baud: parseInt(document.getElementById('baud-input').value),
            Databits: parseInt(document.getElementById('databits-select').value),
            Stopbits: parseInt(document.getElementById('stopbits-select').value),
            Parity: document.getElementById('parity-select').value
        },
        UI: {
            Font: document.getElementById('font-input').value || 'Nerd Font Mono',
            FontSize: parseInt(document.getElementById('fontsize-input').value) || 14,
            Timestamp: timestampEnabled,
            Shell: shellEnabled
        },
        Highlight: {
            Groups: document.getElementById('highlight-input').value
                .split('\n')
                .map(l => l.trim())
                .filter(l => l !== '')
        },
        Log: { Path: './logs' }
    };

    fetch('/saveconfig', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
    })
    .then(response => response.json())
    .then(data => {
        if (data.status === 'ok') alert('Configuration saved');
        else alert('Save failed: ' + (data.message || 'Unknown error'));
    })
    .catch(err => {
        console.error('Save error:', err);
        alert('Error saving configuration');
    });
}

function saveConfigSilently() {
    const config = {
        Serial: {
            Port: document.getElementById('port-input').value,
            Baud: parseInt(document.getElementById('baud-input').value),
            Databits: parseInt(document.getElementById('databits-select').value),
            Stopbits: parseInt(document.getElementById('stopbits-select').value),
            Parity: document.getElementById('parity-select').value
        },
        UI: {
            Font: document.getElementById('font-input').value || 'Nerd Font Mono',
            FontSize: parseInt(document.getElementById('fontsize-input').value) || 14,
            Timestamp: timestampEnabled,
            Shell: shellEnabled
        },
        Highlight: {
            Groups: document.getElementById('highlight-input').value
                .split('\n')
                .map(l => l.trim())
                .filter(l => l !== '')
        },
        Log: { Path: './logs' }
    };

    fetch('/saveconfig', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
    })
    .then(response => response.json())
    .then(data => {
        if (data.status !== 'ok') console.warn('Silent save failed:', data.message);
    })
    .catch(err => console.warn('Silent save error:', err));
}

function showHelp() {
    const modalBody = document.getElementById('modal-body');
    modalBody.innerHTML = `
        <h3>Help</h3>
        <p><strong>F1:</strong> Show help menu</p>
        <p><strong>F2:</strong> Connect/Disconnect serial port</p>
        <p><strong>F3:</strong> Scan serial ports</p>
        <p><strong>Esc:</strong> Close modal</p>
        <p><strong>↑/↓ in input box:</strong> Navigate command history (SHELL OFF only)</p>
        <p><strong>Tab:</strong> Send Tab character (SHELL OFF)</p>
        <p><strong>Enter:</strong> Send input content (SHELL OFF)</p>
        <p><strong>ASCII/HEX:</strong> Switch display format (SHELL OFF only)</p>
        <p><strong>Timestamp toggle:</strong> Show/Hide timestamp before messages</p>
        <p><strong>SHELL toggle:</strong> Enable full terminal emulation (xterm.js) for control characters</p>
    `;
    document.getElementById('modal').style.display = 'block';
}

function closeModal() {
    document.getElementById('modal').style.display = 'none';
}

function showPortSelection(ports) {
    const modalBody = document.getElementById('modal-body');
    if (ports.length === 0) {
        modalBody.innerHTML = `
            <h3>Select Serial Port</h3>
            <p style="color: var(--text-muted); text-align: center; margin: 20px 0;">No available serial ports detected</p>
            <div class="port-buttons-container">
                <button class="port-button empty">No serial port devices found</button>
            </div>
        `;
    } else {
        modalBody.innerHTML = `
            <h3>Select Serial Port</h3>
            <p style="color: var(--text-muted); font-size: 0.9em; margin: 10px 0 20px 0;">Click button to select serial port</p>
            <div class="port-buttons-container" id="port-buttons-container"></div>
        `;
        const container = document.getElementById('port-buttons-container');
        const currentPort = document.getElementById('port-input').value;
        ports.forEach(port => {
            const btn = document.createElement('button');
            btn.className = 'port-button';
            btn.textContent = port;
            if (port === currentPort) btn.classList.add('selected');
            btn.addEventListener('click', () => {
                selectPort(port);
                setTimeout(closeModal, 1000);
            });
            container.appendChild(btn);
        });
    }
}

function showPortSelectionError(msg) {
    const modalBody = document.getElementById('modal-body');
    modalBody.innerHTML = `
        <h3>Serial Port Scan Failed</h3>
        <p style="color: var(--error-color); text-align: center; margin: 20px 0;">${msg || 'Unknown error'}</p>
        <div class="port-buttons-container">
            <button class="port-button empty">Scan failed, try again</button>
        </div>
    `;
}

function selectPort(port) {
    document.getElementById('port-input').value = port;
    const formData = new FormData();
    formData.append('port', port);
    fetch('/setport', { method: 'POST', body: formData })
        .then(response => response.json())
        .then(data => {
            if (data.status === 'ok') updatePortInfo(port, document.getElementById('baud-input').value);
        });
}