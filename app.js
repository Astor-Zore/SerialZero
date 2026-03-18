// app.js
let ws;
let history = [];
let historyIndex = 0;
let isConnected = false;
let currentMode = 'ascii';
let ansiEnabled = true;
let timestampEnabled = true;

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
                    addToOutput(data.message);
                    history.push(data.message);
                    historyIndex = history.length;
                    break;
                case 'config':
                    if (data.config) {
                        updateConfig(data.config);
                    }
                    if (data.connected !== undefined) {
                        updateConnectionStatus(data.connected);
                    }
                    if (data.mode) {
                        updateMode(data.mode);
                    }
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

    // Mode toggle listeners
    document.getElementById('ascii-mode').addEventListener('change', function() {
        if (this.checked) setMode(this.value);
    });
    
    document.getElementById('hex-mode').addEventListener('change', function() {
        if (this.checked) setMode(this.value);
    });
    
    // Timestamp toggle listeners
    document.getElementById('timestamp-on').addEventListener('change', function() {
        if (this.checked) setTimestamp(true);
    });
    
    document.getElementById('timestamp-off').addEventListener('change', function() {
        if (this.checked) setTimestamp(false);
    });
    
    // ANSI toggle listeners
    document.getElementById('ansi-on').addEventListener('change', function() {
        if (this.checked) setAnsiEnabled(true);
    });
    
    document.getElementById('ansi-off').addEventListener('change', function() {
        if (this.checked) setAnsiEnabled(false);
    });

    document.querySelector('.close').addEventListener('click', closeModal);
    window.addEventListener('click', function(event) {
        if (event.target == document.getElementById('modal')) {
            closeModal();
        }
    });
}

function addConfigChangeListeners() {
    // Serial configuration change listeners
    document.getElementById('port-input').addEventListener('change', function() {
        updatePortInfo(this.value, document.getElementById('baud-input').value);
    });
    
    document.getElementById('baud-input').addEventListener('change', function() {
        updatePortInfo(document.getElementById('port-input').value, this.value);
    });
    
    document.getElementById('databits-select').addEventListener('change', function() {
        saveConfigSilently();
    });
    
    document.getElementById('stopbits-select').addEventListener('change', function() {
        saveConfigSilently();
    });
    
    document.getElementById('parity-select').addEventListener('change', function() {
        saveConfigSilently();
    });
    
    // Font settings change listeners
    document.getElementById('font-input').addEventListener('change', function() {
        applyFontSettings(this.value, document.getElementById('fontsize-input').value);
    });
    
    document.getElementById('fontsize-input').addEventListener('change', function() {
        applyFontSettings(document.getElementById('font-input').value, this.value);
    });
}

function setupKeyboardShortcuts() {
    document.addEventListener('keydown', function(event) {
        if (event.target.tagName === 'INPUT') return;

        switch(event.key) {
            case 'F1':
                event.preventDefault();
                showHelp();
                break;
            case 'F2':
                event.preventDefault();
                toggleConnection();
                break;
            case 'F3':
                event.preventDefault();
                scanPorts();
                break;
            case 'Escape':
                event.preventDefault();
                closeModal();
                break;
            case 'PageUp':
                event.preventDefault();
                scrollOutput(-1);
                break;
            case 'PageDown':
                event.preventDefault();
                scrollOutput(1);
                break;
            case 'ArrowUp':
                event.preventDefault();
                scrollOutput(-1);
                break;
            case 'ArrowDown':
                event.preventDefault();
                scrollOutput(1);
                break;
        }
    });
}

function toggleConnection() {
    if (isConnected) {
        disconnect();
    } else {
        connect();
    }
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
            if (data.status === 'ok') {
                showPortSelection(data.ports);
            } else {
                showPortSelectionError(data.message);
            }
        })
        .catch(error => {
            showPortSelectionError(error.message);
        });
}

function setMode(mode) {
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
    console.log('Setting timestamp to:', enabled);
    timestampEnabled = enabled;
    
    updateTimestampStatus(enabled);
    
    const config = {
        Serial: {
            Port: document.getElementById('port-input').value,
            Baud: parseInt(document.getElementById('baud-input').value),
            Databits: parseInt(document.getElementById('databits-select').value),
            Stopbits: parseInt(document.getElementById('stopbits-select').value),
            Parity: document.getElementById('parity-select').value
        },
        UI: {
            Font: document.getElementById('font-input').value || "Nerd Font Mono",
            FontSize: parseInt(document.getElementById('fontsize-input').value) || 14,
            Timestamp: enabled,
            Ansi: ansiEnabled
        },
        Highlight: {
            Groups: document.getElementById('highlight-input').value
                .split('\n')
                .map(line => line.trim())
                .filter(line => line !== '')
        },
        Log: {
            Path: "./logs"
        }
    };
    
    fetch('/saveconfig', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
    })
    .then(response => response.json())
    .then(data => {
        if (data.status === 'ok') {
            console.log('Timestamp setting saved:', enabled);
        }
    });
}

function setAnsiEnabled(enabled) {
    console.log('Setting ANSI to:', enabled);
    ansiEnabled = enabled;
    
    updateAnsiStatus(enabled);
    
    const config = {
        Serial: {
            Port: document.getElementById('port-input').value,
            Baud: parseInt(document.getElementById('baud-input').value),
            Databits: parseInt(document.getElementById('databits-select').value),
            Stopbits: parseInt(document.getElementById('stopbits-select').value),
            Parity: document.getElementById('parity-select').value
        },
        UI: {
            Font: document.getElementById('font-input').value || "Nerd Font Mono",
            FontSize: parseInt(document.getElementById('fontsize-input').value) || 14,
            Timestamp: timestampEnabled,
            Ansi: enabled
        },
        Highlight: {
            Groups: document.getElementById('highlight-input').value
                .split('\n')
                .map(line => line.trim())
                .filter(line => line !== '')
        },
        Log: {
            Path: "./logs"
        }
    };
    
    fetch('/saveconfig', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
    })
    .then(response => response.json())
    .then(data => {
        if (data.status === 'ok') {
            console.log('ANSI setting saved:', enabled);
            refreshOutput();
        }
    });
}

function refreshOutput() {
    const output = document.getElementById('output');
    const messages = Array.from(output.children).map(child => child.textContent);
    output.innerHTML = '';
    
    messages.forEach(message => {
        addToOutput(message);
    });
}

function clearOutput(sendClear = true) {
    if (sendClear) {
        fetch('/clear', { method: 'POST' });
    }

    history = [];
    historyIndex = 0;
    document.getElementById('output').innerHTML = '';
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
            Font: document.getElementById('font-input').value || "Nerd Font Mono",
            FontSize: parseInt(document.getElementById('fontsize-input').value) || 14,
            Timestamp: timestampEnabled,
            Ansi: ansiEnabled
        },
        Highlight: {
            Groups: document.getElementById('highlight-input').value
                .split('\n')
                .map(line => line.trim())
                .filter(line => line !== '')
        },
        Log: {
            Path: "./logs"
        }
    };

    console.log('Saving configuration:', config);

    fetch('/saveconfig', { 
        method: 'POST', 
        headers: { 
            'Content-Type': 'application/json' 
        },
        body: JSON.stringify(config)
    })
    .then(response => response.json())
    .then(data => {
        if (data.status === 'ok') {
            alert('Configuration saved');
            applyFontSettings(config.UI.Font, config.UI.FontSize);
            updateHighlightRules(config.Highlight.Groups);
            updatePortInfo(config.Serial.Port, config.Serial.Baud);
        } else {
            alert('Save failed: ' + (data.message || 'Unknown error'));
        }
    })
    .catch(error => {
        console.error('Error saving configuration:', error);
        alert('Error saving configuration: ' + error.message);
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
            Font: document.getElementById('font-input').value || "Nerd Font Mono",
            FontSize: parseInt(document.getElementById('fontsize-input').value) || 14,
            Timestamp: timestampEnabled,
            Ansi: ansiEnabled
        },
        Highlight: {
            Groups: document.getElementById('highlight-input').value
                .split('\n')
                .map(line => line.trim())
                .filter(line => line !== '')
        },
        Log: {
            Path: "./logs"
        }
    };
    
    fetch('/saveconfig', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
    })
    .then(response => response.json())
    .then(data => {
        if (data.status === 'ok') {
            console.log('Configuration automatically saved');
        }
    });
}

function showHelp() {
    const modalBody = document.getElementById('modal-body');
    modalBody.innerHTML = `
        <h3>Help</h3>
        <p><strong>F1:</strong> Show help menu</p>
        <p><strong>F2:</strong> Connect/Disconnect serial port</p>
        <p><strong>F3:</strong> Scan serial ports</p>
        <p><strong>Esc:</strong> Close modal</p>
        <p><strong>PageUp/PageDown or ↑↓:</strong> Scroll through history</p>
        <p><strong>Tab:</strong> Send Tab character</p>
        <p><strong>Enter:</strong> Send input content</p>
        <p><strong>ASCII/HEX:</strong> Switch data mode</p>
        <p><strong>Timestamp toggle:</strong> Control whether to show timestamp before messages</p>
        <p><strong>ANSI toggle:</strong> Control whether to parse ANSI escape sequences for colored output</p>
    `;
    document.getElementById('modal').style.display = 'block';
}

function sendData() {
    const input = document.getElementById('input');
    const data = input.value.trim();
    if (data === '') return;

    const formData = new FormData();
    formData.append('data', data);

    fetch('/send', { method: 'POST', body: formData })
        .then(response => response.json())
        .then(data => {
            if (data.status !== 'ok') {
                alert('Send failed: ' + data.message);
            } else {
                input.value = '';
            }
        });
}

function handleInputKeydown(event) {
    if (event.key === 'Enter') {
        event.preventDefault();
        sendData();
    } else if (event.key === 'Tab') {
        event.preventDefault();
        const formData = new FormData();
        formData.append('data', '\t');

        fetch('/send', { method: 'POST', body: formData });
    }
}

let pendingMessages = [];
let updateTimer = null;
let isScrolling = false;

function addToOutput(message) {
    pendingMessages.push(message);
    if (!updateTimer) {
        updateTimer = setTimeout(updateOutputBatch, 16);
    }
}

function updateOutputBatch() {
    if (pendingMessages.length === 0) {
        updateTimer = null;
        return;
    }

    const output = document.getElementById('output');
    const fragment = document.createDocumentFragment();
    const shouldScroll = true;

    const messagesToProcess = pendingMessages.splice(0, Math.min(50, pendingMessages.length));
    
    messagesToProcess.forEach(message => {
        const html = applyHighlight(message);
        const div = document.createElement('div');
        div.innerHTML = html;
        fragment.appendChild(div);
    });

    output.appendChild(fragment);

    const maxMessages = 2000;
    const children = output.children;
    if (children.length > maxMessages) {
        const toRemove = children.length - maxMessages;
        for (let i = 0; i < toRemove; i++) {
            if (children[0]) {
                output.removeChild(children[0]);
            }
        }
    }

    if (shouldScroll) {
        scrollToBottom();
    }

    if (pendingMessages.length > 0) {
        updateTimer = setTimeout(updateOutputBatch, 0);
    } else {
        updateTimer = null;
    }
}

function scrollToBottom() {
    const output = document.getElementById('output');
    output.scrollTop = output.scrollHeight;
}

function scrollOutput(direction) {
    const output = document.getElementById('output');
    const amount = output.clientHeight * 0.8;
    output.scrollTop += amount * direction;
}

document.getElementById('output').addEventListener('scroll', function() {
    isScrolling = true;
    clearTimeout(this.scrollTimer);
    this.scrollTimer = setTimeout(() => {
        isScrolling = false;
    }, 100);
});

function updateConnectionStatus(connected) {
    isConnected = connected;
    const status = document.getElementById('connection-status');
    status.textContent = connected ? 'Connected' : 'Disconnected';
    status.className = connected ? 'connected' : '';
}

function updateMode(mode) {
    currentMode = mode;
    document.getElementById('data-mode').textContent = 'Mode: ' + mode.toUpperCase();
    
    if (mode === 'ascii') {
        document.getElementById('ascii-mode').checked = true;
    } else {
        document.getElementById('hex-mode').checked = true;
    }
}

function updateTimestampStatus(enabled) {
    console.log('Updating timestamp status to:', enabled);
    timestampEnabled = enabled;
    const statusElement = document.getElementById('timestamp-status');
    if (statusElement) {
        statusElement.textContent = `Timestamp: ${enabled ? 'ON' : 'OFF'}`;
        if (enabled)
            statusElement.classList.toggle('off', !enabled);
    }
    
    if (enabled) {
        document.getElementById('timestamp-on').checked = true;
    } else {
        document.getElementById('timestamp-off').checked = true;
    }
}

function updateAnsiStatus(enabled) {
    console.log('Updating ANSI status to:', enabled);
    ansiEnabled = enabled;
    const statusElement = document.getElementById('ansi-status');
    if (statusElement) {
        statusElement.textContent = `ANSI: ${enabled ? 'ON' : 'OFF'}`;
        statusElement.classList.toggle('off', !enabled);
    }
    
    if (enabled) {
        document.getElementById('ansi-on').checked = true;
    } else {
        document.getElementById('ansi-off').checked = true;
    }
}

function updateConfig(config) {
    console.log('Updating configuration:', config);
    
    if (config.Serial) {
        document.getElementById('port-input').value = config.Serial.Port || "COM1";
        document.getElementById('baud-input').value = config.Serial.Baud || 9600;
        document.getElementById('databits-select').value = config.Serial.Databits || 8;
        document.getElementById('stopbits-select').value = config.Serial.Stopbits || 1;
        document.getElementById('parity-select').value = config.Serial.Parity || "N";
        updatePortInfo(config.Serial.Port || "COM1", config.Serial.Baud || 9600);
    }
    
    if (config.UI) {
        document.getElementById('font-input').value = config.UI.Font || "Nerd Font Mono";
        document.getElementById('fontsize-input').value = config.UI.FontSize || 14;
        
        updateTimestampStatus(config.UI.Timestamp !== undefined ? config.UI.Timestamp : true);
        updateAnsiStatus(config.UI.Ansi !== undefined ? config.UI.Ansi : true);
        
        applyFontSettings(config.UI.Font || "Nerd Font Mono", config.UI.FontSize || 14);
    }
    
    if (config.Highlight && config.Highlight.Groups) {
        document.getElementById('highlight-input').value = Array.isArray(config.Highlight.Groups) 
            ? config.Highlight.Groups.join('\n') 
            : '';
        updateHighlightRules(config.Highlight.Groups);
    }
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

let highlightRules = [];

function updateHighlightRules(groups) {
    highlightRules = groups.map(item => {
        const parts = item.split(":");
        const pattern = parts[0];
        const color = parts[1] || "yellow";
        try {
            return { regex: new RegExp(pattern, 'gi'), color };
        } catch (err) {
            console.warn('Invalid regex:', pattern);
            return null;
        }
    }).filter(rule => rule !== null);
}

function stripAnsiBasic(str) {
    return str.replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, "");
}

function applyHighlight(text) {
    if (!ansiEnabled) {
        let result = escapeHtml(stripAnsiBasic(text));
        highlightRules.forEach(rule => {
            result = result.replace(rule.regex, match => `<span style="color:${rule.color}; font-weight:600;">${match}</span>`);
        });
        return result;
    } else {
        return ansiToHtml(text);
    }
}

function ansiToHtml(text) {
    const escaped = escapeHtml(text);
    
    const colorMap = {
        '0': '#000000',
        '1': '#800000',
        '2': '#008000',
        '3': '#808000',
        '4': '#000080',
        '5': '#800080',
        '6': '#008080',
        '7': '#c0c0c0',
        '8': '#808080',
        '9': '#ff0000',
        '10': '#00ff00',
        '11': '#ffff00',
        '12': '#0000ff',
        '13': '#ff00ff',
        '14': '#00ffff',
        '15': '#ffffff'
    };

    const ansiRegex = /\x1b\[([0-9;]*)m/g;
    const tokens = [];
    let lastIndex = 0;
    let match;
    let currentStyle = {};

    while ((match = ansiRegex.exec(escaped)) !== null) {
        if (match.index > lastIndex) {
            tokens.push({
                text: escaped.substring(lastIndex, match.index),
                style: {...currentStyle}
            });
        }

        const codes = match[1].split(';').filter(c => c !== '');
        
        for (let code of codes) {
            const num = parseInt(code, 10);
            
            if (num === 0) {
                currentStyle = {};
            } else if (num === 1) {
                currentStyle.fontWeight = 'bold';
            } else if (num === 2) {
                currentStyle.opacity = '0.6';
            } else if (num === 3) {
                currentStyle.fontStyle = 'italic';
            } else if (num === 4) {
                currentStyle.textDecoration = (currentStyle.textDecoration ? currentStyle.textDecoration + ' ' : '') + 'underline';
            } else if (num === 5) {
                currentStyle.animation = 'blink 1s step-end infinite';
            } else if (num === 7) {
                currentStyle.filter = 'invert(1)';
            } else if (num === 8) {
                currentStyle.visibility = 'hidden';
            } else if (num === 9) {
                currentStyle.textDecoration = (currentStyle.textDecoration ? currentStyle.textDecoration + ' ' : '') + 'line-through';
            } else if (num === 22) {
                delete currentStyle.fontWeight;
                delete currentStyle.opacity;
            } else if (num === 23) {
                delete currentStyle.fontStyle;
            } else if (num === 24) {
                if (currentStyle.textDecoration) {
                    currentStyle.textDecoration = currentStyle.textDecoration.replace(/\bunderline\b/, '').trim();
                    if (!currentStyle.textDecoration) delete currentStyle.textDecoration;
                }
            } else if (num === 25) {
                delete currentStyle.animation;
            } else if (num === 27) {
                delete currentStyle.filter;
            } else if (num === 28) {
                delete currentStyle.visibility;
            } else if (num === 29) {
                if (currentStyle.textDecoration) {
                    currentStyle.textDecoration = currentStyle.textDecoration.replace(/\bline-through\b/, '').trim();
                    if (!currentStyle.textDecoration) delete currentStyle.textDecoration;
                }
            } else if (num >= 30 && num <= 37) {
                currentStyle.color = colorMap[(num - 30).toString()] || '#000000';
            } else if (num === 38) {
                // Skip complex color codes
            } else if (num === 39) {
                delete currentStyle.color;
            } else if (num >= 40 && num <= 47) {
                currentStyle.backgroundColor = colorMap[(num - 40).toString()] || '#ffffff';
            } else if (num === 48) {
                // Skip complex color codes
            } else if (num === 49) {
                delete currentStyle.backgroundColor;
            } else if (num >= 90 && num <= 97) {
                currentStyle.color = colorMap[(num - 82).toString()] || '#ffffff';
            } else if (num >= 100 && num <= 107) {
                currentStyle.backgroundColor = colorMap[(num - 92).toString()] || '#ffffff';
            }
        }

        lastIndex = match.index + match[0].length;
    }

    if (lastIndex < escaped.length) {
        tokens.push({
            text: escaped.substring(lastIndex),
            style: {...currentStyle}
        });
    }

    let html = '';
    for (let token of tokens) {
        if (!token.text) continue;
        
        const styles = [];
        if (token.style.color) {
            styles.push(`color: ${token.style.color}`);
        }
        if (token.style.backgroundColor) {
            styles.push(`background-color: ${token.style.backgroundColor}`);
        }
        if (token.style.fontWeight) {
            styles.push(`font-weight: ${token.style.fontWeight}`);
        }
        if (token.style.fontStyle) {
            styles.push(`font-style: ${token.style.fontStyle}`);
        }
        if (token.style.textDecoration) {
            styles.push(`text-decoration: ${token.style.textDecoration}`);
        }
        if (token.style.opacity) {
            styles.push(`opacity: ${token.style.opacity}`);
        }
        if (token.style.animation) {
            styles.push(`animation: ${token.style.animation}`);
        }
        if (token.style.filter) {
            styles.push(`filter: ${token.style.filter}`);
        }
        if (token.style.visibility) {
            styles.push(`visibility: ${token.style.visibility}`);
        }
        
        if (styles.length > 0) {
            html += `<span style="${styles.join('; ')}">${token.text}</span>`;
        } else {
            html += token.text;
        }
    }
    
    return html;
}

function escapeHtml(str) {
    return str.replace(/[&<>"]+/g, tag => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;'
    }[tag]));
}

function applyFontSettings(font, size) {
    const output = document.getElementById('output');
    if (font) {
        output.style.fontFamily = font;
    }
    if (size) {
        output.style.fontSize = `${size}px`;
    }
    document.documentElement.style.setProperty('--output-font', font || 'Courier New, monospace');
    document.documentElement.style.setProperty('--output-font-size', `${size}px`);
}

function updatePortInfo(port, baud) {
    document.getElementById('port-info').textContent = `Port: ${port} | Baudrate: ${baud}`;
    console.log('Port info updated:', port, baud);
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
            <p style="color: var(--text-muted); font-size: 0.9em; margin: 10px 0 20px 0;">Click button to select serial port, selected port will be automatically applied to configuration</p>
            <div class="port-buttons-container" id="port-buttons-container"></div>
        `;
        
        const container = document.getElementById('port-buttons-container');
        let currentPort = document.getElementById('port-input').value;
        
        ports.forEach(port => {
            const button = document.createElement('button');
            button.className = 'port-button';
            button.textContent = port;
            
            if (port === currentPort) {
                button.classList.add('selected');
            }
            
            button.addEventListener('click', function() {
                document.querySelectorAll('.port-button').forEach(btn => {
                    btn.classList.remove('selected');
                });
                
                this.classList.add('selected');
                selectPort(port);
                setTimeout(closeModal, 2000);
            });
            
            container.appendChild(button);
        });
    }
}

function showPortSelectionError(errorMessage) {
    const modalBody = document.getElementById('modal-body');
    modalBody.innerHTML = `
        <h3>Serial Port Scan Failed</h3>
        <p style="color: var(--error-color); text-align: center; margin: 20px 0;">
            ${errorMessage || 'Unknown error'}
        </p>
        <div class="port-buttons-container">
            <button class="port-button empty">Scan failed, please try again</button>
        </div>
    `;
}

function selectPort(port) {
    document.getElementById('port-input').value = port;
    const formData = new FormData();
    formData.append('port', port);
    
    fetch('/setport', { 
        method: 'POST', 
        body: formData 
    })
    .then(response => response.json())
    .then(data => {
        if (data.status === 'ok') {
            updatePortInfo(port, document.getElementById('baud-input').value);
        }
    });
}

function closeModal() {
    document.getElementById('modal').style.display = 'none';
}