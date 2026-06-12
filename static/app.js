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
let outputMessages = [];
let term = null;
let fitAddon = null;

let termContainer = document.getElementById('terminal-container');
let outputContainer = document.getElementById('output-container');
let inputArea = document.getElementById('input-area');

document.addEventListener('DOMContentLoaded', function() {
    initWebSocket();
    setupEventListeners();
    setupKeyboardShortcuts();
    loadConfig();
    addConfigChangeListeners();
    setupSmartCopy();
});

function initWebSocket() {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${wsProtocol}//${window.location.host}/ws`);
    
    ws.onopen = () => console.log('WebSocket connected');
    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            switch(data.type) {
                case 'message':
                    if (shellEnabled) { if (term) term.write(data.message); }
                    else { addToOutput(data.message); }
                    break;
                case 'config':
                    if (data.config) updateConfig(data.config);
                    if (data.connected !== undefined) updateConnectionStatus(data.connected);
                    if (data.mode) updateMode(data.mode);
                    break;
                case 'status': console.log('Status:', data.message); break;
                case 'mode': updateMode(data.mode); break;
                case 'clear': clearOutput(false); break;
            }
        } catch (error) { console.error('Parse error:', error); }
    };
    ws.onclose = () => setTimeout(initWebSocket, 1000);
    ws.onerror = (error) => console.error('WS error:', error);
}

function setupEventListeners() {
    document.getElementById('connect-btn').addEventListener('click', toggleConnection);
    document.getElementById('scan-btn').addEventListener('click', scanPorts);
    document.getElementById('clear-btn').addEventListener('click', () => clearOutput(true));
    document.getElementById('export-btn').addEventListener('click', exportLog);
    document.getElementById('send-btn').addEventListener('click', sendData);
    document.getElementById('save-config-btn').addEventListener('click', saveConfig);
    document.getElementById('input').addEventListener('keydown', handleInputKeydown);

    // 折叠面板交互
    document.getElementById('toggle-sidebar-btn').addEventListener('click', () => {
        document.getElementById('sidebar').classList.toggle('collapsed');
        setTimeout(() => { if(term && fitAddon) fitAddon.fit(); }, 250);
    });

    document.getElementById('toggle-input-btn').addEventListener('click', () => {
        inputArea.classList.toggle('collapsed');
        setTimeout(() => { if(term && fitAddon) fitAddon.fit(); }, 250);
    });

    // 模式切换
    document.getElementById('ascii-mode').addEventListener('change', function() { if (this.checked) setMode(this.value); });
    document.getElementById('hex-mode').addEventListener('change', function() { if (this.checked) setMode(this.value); });
    document.getElementById('timestamp-on').addEventListener('change', function() { if (this.checked) setTimestamp(true); });
    document.getElementById('timestamp-off').addEventListener('change', function() { if (this.checked) setTimestamp(false); });
    document.getElementById('shell-on').addEventListener('change', function() { if (this.checked) setShellEnabled(true); });
    document.getElementById('shell-off').addEventListener('change', function() { if (this.checked) setShellEnabled(false); });

    document.querySelector('.close').addEventListener('click', closeModal);
    window.addEventListener('click', (event) => { if (event.target == document.getElementById('modal')) closeModal(); });
}

// 【智能复制功能】
function setupSmartCopy() {
    const output = document.getElementById('output');
    // 非 Shell 模式：选中后按回车复制
    output.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            const selection = window.getSelection().toString();
            if (selection) {
                e.preventDefault();
                navigator.clipboard.writeText(selection).catch(err => console.error(err));
            }
        }
    });
}

function addConfigChangeListeners() {
    ['port-input', 'baud-input', 'databits-select', 'stopbits-select', 'parity-select', 'font-input', 'fontsize-input', 'highlight-input'].forEach(id => {
        document.getElementById(id).addEventListener('change', saveConfigSilently);
    });
    document.getElementById('port-input').addEventListener('change', function() { updatePortInfo(this.value, document.getElementById('baud-input').value); });
    document.getElementById('baud-input').addEventListener('change', function() { updatePortInfo(document.getElementById('port-input').value, this.value); });
    document.getElementById('font-input').addEventListener('change', function() { applyFontSettings(this.value, document.getElementById('fontsize-input').value); });
    document.getElementById('fontsize-input').addEventListener('change', function() { applyFontSettings(document.getElementById('font-input').value, this.value); });
    document.getElementById('highlight-input').addEventListener('change', function() {
        updateHighlightRules(this.value.split('\n').map(l => l.trim()).filter(l => l));
        rerenderAllOutput();
    });
}

function setupKeyboardShortcuts() {
    document.addEventListener('keydown', function(event) {
        if (event.target.tagName === 'INPUT' && event.target.id !== 'input') return;
        if (event.key === 'F2') { event.preventDefault(); toggleConnection(); }
        else if (event.key === 'F3') { event.preventDefault(); scanPorts(); }
        else if (event.key === 'Escape') { event.preventDefault(); closeModal(); }
    });
}

function toggleConnection() { isConnected ? disconnect() : connect(); }

function connect() {
    fetch('/connect', { method: 'POST' }).then(r => r.json()).then(data => {
        if (data.status === 'connected') { isConnected = true; updateConnectionStatus(true); }
        else { alert('Connection failed: ' + data.message); }
    });
}

function disconnect() {
    fetch('/disconnect', { method: 'POST' }).then(r => r.json()).then(data => {
        if (data.status === 'disconnected') { isConnected = false; updateConnectionStatus(false); }
    });
}

function scanPorts() {
    const modalBody = document.getElementById('modal-body');
    modalBody.innerHTML = `<h3>Scanning...</h3>`;
    document.getElementById('modal').style.display = 'block';
    
    fetch('/scan', { method: 'POST' }).then(r => r.json()).then(data => {
        if (data.status === 'ok') showPortSelection(data.ports);
        else showPortSelectionError(data.message);
    }).catch(error => showPortSelectionError(error.message));
}

function setMode(mode) {
    if (shellEnabled) return;
    const formData = new FormData();
    formData.append('mode', mode);
    fetch('/setmode', { method: 'POST', body: formData }).then(r => r.json()).then(data => {
        if (data.status === 'ok') { currentMode = mode; updateMode(mode); }
    });
}

function setTimestamp(enabled) { timestampEnabled = enabled; updateTimestampStatus(enabled); saveConfigSilently(); }

function setShellEnabled(enabled) {
    shellEnabled = enabled;
    updateShellStatus(enabled);
    if (enabled) {
        outputContainer.style.display = 'none';
        termContainer.style.display = 'flex';
        inputArea.style.display = 'none'; // Shell模式下隐藏底部输入栏
        if (!term) initTerminal(); else fitTerminal();
    } else {
        outputContainer.style.display = 'flex';
        termContainer.style.display = 'none';
        inputArea.style.display = 'flex'; // 非Shell模式显示底部输入栏
        if (term) { term.dispose(); term = null; fitAddon = null; }
        clearOutput(false);
    }
    saveConfigSilently();
}

function initTerminal() {
    term = new Terminal({ 
        cursorBlink: true, 
        theme: { background: '#1e1e1e', foreground: '#cccccc' }, 
        fontSize: parseInt(document.getElementById('fontsize-input').value) || 14, 
        fontFamily: document.getElementById('font-input').value || 'monospace', 
        scrollback: 10000 
    });
    
    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(termContainer);
    
    // xterm 选中自动复制
    term.onSelectionChange(() => {
        if (term.hasSelection()) {
            navigator.clipboard.writeText(term.getSelection()).catch(err => {});
        }
    });

    term.onData(data => {
        const formData = new FormData();
        formData.append('data', data);
        fetch('/send', { method: 'POST', body: formData });
    });
    
    new ResizeObserver(() => fitTerminal()).observe(termContainer);
    setTimeout(fitTerminal, 100);
}

function fitTerminal() { 
    if (term && fitAddon && shellEnabled && termContainer.offsetWidth > 0) {
        try { fitAddon.fit(); } catch(e) {}
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
    historyIndex = Math.max(0, Math.min(historyList.length - 1, historyIndex + direction));
    document.getElementById('input').value = historyList[historyIndex];
}

function sendData() {
    if (shellEnabled) return;
    const input = document.getElementById('input');
    const data = input.value;
    if (data === '') return;
    
    const formData = new FormData();
    formData.append('data', data);
    
    fetch('/send', { method: 'POST', body: formData }).then(r => r.json()).then(res => {
        if (res.status === 'ok') { addToHistory(data); input.value = ''; historyIndex = historyList.length; }
        else { alert('Send failed: ' + res.message); }
    });
}

function handleInputKeydown(event) {
    if (shellEnabled) return;
    if (event.key === 'Enter') { event.preventDefault(); sendData(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); navigateHistory(-1); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); navigateHistory(1); }
}

// 【日志导出功能】
function exportLog() {
    const content = document.getElementById('output').innerText;
    if (!content.trim()) return alert("No data to export.");
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `serial_log_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
}

// 输出渲染逻辑
function addToOutput(text) {
    outputMessages.push(text);
    pendingMessages.push(text);
    scheduleOutputUpdate();
}

function scheduleOutputUpdate() { if (!updateTimer) updateTimer = setTimeout(flushOutput, 16); }

function flushOutput() {
    updateTimer = null;
    if (pendingMessages.length === 0) return;
    const output = document.getElementById('output');
    const fragment = document.createDocumentFragment();
    const batch = pendingMessages.splice(0, 50);
    batch.forEach(msg => {
        const div = document.createElement('div');
        div.innerHTML = applyHighlight(msg);
        fragment.appendChild(div);
    });
    output.appendChild(fragment);
    output.scrollTop = output.scrollHeight;
    if (pendingMessages.length > 0) scheduleOutputUpdate();
}

function rerenderAllOutput() {
    const output = document.getElementById('output');
    output.innerHTML = '';
    outputMessages.forEach(msg => {
        const div = document.createElement('div');
        div.innerHTML = applyHighlight(msg);
        output.appendChild(div);
    });
}

function clearOutput(sendClear = true) {
    if (sendClear) fetch('/clear', { method: 'POST' });
    if (shellEnabled && term) term.clear();
    else {
        document.getElementById('output').innerHTML = '';
        pendingMessages = []; outputMessages = [];
    }
}

function updateHighlightRules(lines) {
    highlightRules = lines.map(line => {
        const parts = line.split(':');
        if (parts.length < 2) return null;
        try { return { regex: new RegExp(parts[0], 'gi'), color: parts.slice(1).join(':') }; } 
        catch (e) { return null; }
    }).filter(r => r !== null);
}

function applyHighlight(text) {
    let result = text.replace(/[&<>"]/g, tag => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[tag] || tag);
    highlightRules.forEach(rule => { result = result.replace(rule.regex, match => `<span style="color:${rule.color}">${match}</span>`); });
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
    document.getElementById('ascii-mode').checked = (mode === 'ascii');
    document.getElementById('hex-mode').checked = (mode === 'hex');
}

function updateTimestampStatus(enabled) {
    timestampEnabled = enabled;
    document.getElementById('timestamp-on').checked = enabled;
    document.getElementById('timestamp-off').checked = !enabled;
}

function updateShellStatus(enabled) {
    shellEnabled = enabled;
    document.getElementById('shell-on').checked = enabled;
    document.getElementById('shell-off').checked = !enabled;
}

function updatePortInfo(port, baud) { document.getElementById('port-info').textContent = `${port} | ${baud}`; }

function applyFontSettings(font, size) {
    const output = document.getElementById('output');
    if (font) { output.style.fontFamily = font; if (term) term.setOption('fontFamily', font); }
    if (size) { output.style.fontSize = size + 'px'; if (term) term.setOption('fontSize', parseInt(size)); if (term) setTimeout(fitTerminal, 50); }
}

function loadConfig() {
    fetch('/getconfig', { method: 'POST' }).then(r => r.json()).then(data => {
        updateConfig(data.config); updateConnectionStatus(data.connected); updateMode(data.mode);
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
        document.getElementById('font-input').value = config.UI.Font || 'monospace';
        document.getElementById('fontsize-input').value = config.UI.FontSize || 14;
        applyFontSettings(config.UI.Font, config.UI.FontSize);
        updateTimestampStatus(config.UI.Timestamp !== undefined ? config.UI.Timestamp : true);
        updateShellStatus(config.UI.Shell !== undefined ? config.UI.Shell : true);
        if (config.UI.Shell) {
            setShellEnabled(true); // 触发初始化终端
        }
    }
    if (config.Highlight && config.Highlight.Groups) {
        const groups = Array.isArray(config.Highlight.Groups) ? config.Highlight.Groups : ["error:#ff0000", "warn:#ffa500"];
        document.getElementById('highlight-input').value = groups.join('\n');
        updateHighlightRules(groups);
    }
}

function saveConfig() {
    const config = getFormData();
    fetch('/saveconfig', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(config) }).then(r => r.json()).then(data => {
        if (data.status === 'ok') alert('Configuration saved');
        else alert('Save failed: ' + data.message);
    });
}

function saveConfigSilently() {
    fetch('/saveconfig', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(getFormData()) });
}

function getFormData() {
    return {
        Serial: { Port: document.getElementById('port-input').value, Baud: parseInt(document.getElementById('baud-input').value), Databits: parseInt(document.getElementById('databits-select').value), Stopbits: parseInt(document.getElementById('stopbits-select').value), Parity: document.getElementById('parity-select').value },
        UI: { Font: document.getElementById('font-input').value, FontSize: parseInt(document.getElementById('fontsize-input').value), Timestamp: timestampEnabled, Shell: shellEnabled },
        Highlight: { Groups: document.getElementById('highlight-input').value.split('\n').map(l=>l.trim()).filter(l=>l) },
        Log: { Path: './logs' }
    };
}

function showPortSelection(ports) {
    const modalBody = document.getElementById('modal-body');
    if (ports.length === 0) { modalBody.innerHTML = `<p>No available ports.</p>`; return; }
    modalBody.innerHTML = `<h3>Select Port</h3><div class="port-list"></div>`;
    const list = modalBody.querySelector('.port-list');
    ports.forEach(port => {
        const btn = document.createElement('button');
        btn.className = 'tool-btn';
        btn.style.margin = '5px';
        btn.textContent = port;
        btn.onclick = () => { 
            document.getElementById('port-input').value = port; 
            updatePortInfo(port, document.getElementById('baud-input').value); 
            closeModal(); 
        };
        list.appendChild(btn);
    });
}

function showPortSelectionError(msg) { document.getElementById('modal-body').innerHTML = `<p style="color:red;">Error: ${msg}</p>`; }
function closeModal() { document.getElementById('modal').style.display = 'none'; }
