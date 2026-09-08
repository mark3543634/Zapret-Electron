const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, globalShortcut, shell, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const https = require('https')
const dgram = require('dgram')
const crypto = require('crypto')
const { execSync, spawn, spawnSync } = require('child_process')

let mainWindow;
let tray = null;
let trayClickTimer = null;
let pendingShowRequest = false;
let trayState = {
  running: false,
  strategy: 'Движок не активен',
  ping: '---',
  uptime: '00:00:00',
  autostart: false,
  quietMode: true
};
let availableUpdate = null;
let dohSocket = null;
let dohEnabled = false;
let dohProfile = null;
let dohExitBlocked = false;
let dnsWatchdogStarted = false;
let dohStats = { queries: 0, replies: 0, lastError: '', lastEndpoint: '' };

const DOH_ENDPOINTS = [
  { host: '1.1.1.1', servername: 'cloudflare-dns.com', label: 'Cloudflare 1' },
  { host: '1.0.0.1', servername: 'cloudflare-dns.com', label: 'Cloudflare 2' },
  { host: '8.8.8.8', servername: 'dns.google', label: 'Google' }
];
const DNS_PROFILES = {
  secure: { addresses: ['127.0.0.1'], localProxy: true },
  smartAi: { addresses: ['83.220.169.155', '212.109.195.93'], localProxy: false }
};

const UPDATE_REPOSITORY = 'mark3543634/Zapret-Electron';
const UPDATE_API = `https://api.github.com/repos/${UPDATE_REPOSITORY}`;
const updaterStatePath = () => path.join(app.getPath('userData'), 'updater-state.json');
const dohStatePath = () => path.join(app.getPath('userData'), 'doh-state.json');
const dnsWatchdogPath = () => path.join(app.getPath('userData'), 'dns-recovery-watchdog.ps1');
const dnsRecoveryLogPath = () => path.join(app.getPath('userData'), 'dns-recovery.log');
function runPowerShell(command) {
  const result = spawnSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; ${command}`
  ], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'ошибка PowerShell').trim());
  return (result.stdout || '').replace(/^\uFEFF/, '').trim();
}

function readDohState() {
  try { return JSON.parse(fs.readFileSync(dohStatePath(), 'utf8')); }
  catch (_) { return null; }
}

function writeDohState(state) {
  fs.mkdirSync(path.dirname(dohStatePath()), { recursive: true });
  fs.writeFileSync(dohStatePath(), JSON.stringify(state, null, 2), 'utf8');
}

function captureActiveDns() {
  const output = runPowerShell("Get-NetAdapter -Physical | Where-Object Status -eq 'Up' | ForEach-Object { $dns=Get-DnsClientServerAddress -InterfaceIndex $_.ifIndex -AddressFamily IPv4; $guid='{' + $_.InterfaceGuid.ToString() + '}'; $reg=Get-ItemProperty -LiteralPath ('HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\' + $guid) -ErrorAction SilentlyContinue; [pscustomobject]@{ InterfaceIndex=[int]$_.ifIndex; InterfaceAlias=[string]$_.Name; ServerAddresses=@($dns.ServerAddresses); Automatic=[string]::IsNullOrWhiteSpace([string]$reg.NameServer) } } | ConvertTo-Json -Compress");
  if (!output) return [];
  const parsed = JSON.parse(output);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((item) => ({
    interfaceIndex: Number(item.InterfaceIndex),
    interfaceAlias: String(item.InterfaceAlias || ''),
    automatic: item.Automatic === true,
    serverAddresses: (Array.isArray(item.ServerAddresses) ? item.ServerAddresses : (item.ServerAddresses ? [item.ServerAddresses] : []))
      .map(String).filter((value) => /^\d{1,3}(\.\d{1,3}){3}$/.test(value))
  })).filter((item) => Number.isInteger(item.interfaceIndex) && item.interfaceIndex > 0);
}

function setAdapterDns(adapters, addresses) {
  const quoted = addresses.map((value) => `'${value}'`).join(',');
  for (const adapter of adapters) {
    runPowerShell(`Set-DnsClientServerAddress -InterfaceIndex ${adapter.interfaceIndex} -ServerAddresses @(${quoted}) -ErrorAction Stop`);
  }
  runPowerShell('Clear-DnsClientCache');
}

function restoreDnsFromState(state) {
  if (!state || !Array.isArray(state.adapters)) return true;
  const errors = [];
  for (const adapter of state.adapters) {
    try {
      let index = Number(adapter.interfaceIndex);
      if (!Number.isInteger(index) || index <= 0) continue;
      const alias = String(adapter.interfaceAlias || '').replace(/'/g, "''");
      const resolved = runPowerShell(`$candidate=Get-NetAdapter -InterfaceIndex ${index} -ErrorAction SilentlyContinue; if(-not $candidate -and '${alias}'){$candidate=Get-NetAdapter -Name '${alias}' -ErrorAction SilentlyContinue}; if($candidate){[int]$candidate.ifIndex}`);
      if (resolved) index = Number(resolved);
      if (!Number.isInteger(index) || index <= 0) throw new Error(`сетевой адаптер ${adapter.interfaceAlias || adapter.interfaceIndex} не найден`);
      const addresses = (Array.isArray(adapter.serverAddresses) ? adapter.serverAddresses : [])
        .map(String).filter((value) => /^\d{1,3}(\.\d{1,3}){3}$/.test(value));
      if (adapter.automatic === true) {
        runPowerShell(`Set-DnsClientServerAddress -InterfaceIndex ${index} -ResetServerAddresses -ErrorAction Stop`);
      } else if (addresses.length) {
        const quoted = addresses.map((value) => `'${value}'`).join(',');
        runPowerShell(`Set-DnsClientServerAddress -InterfaceIndex ${index} -ServerAddresses @(${quoted}) -ErrorAction Stop`);
      } else {
        runPowerShell(`Set-DnsClientServerAddress -InterfaceIndex ${index} -ResetServerAddresses -ErrorAction Stop`);
      }
    } catch (error) { errors.push(error.message); }
  }
  if (errors.length) throw new Error(errors.join('; '));
  try { runPowerShell('Clear-DnsClientCache'); } catch (_) {}
  return true;
}

function writeDnsWatchdogScript() {
  const script = [
    "param([int]$ParentPid, [string]$StatePath, [string]$LogPath)",
    "$ErrorActionPreference = 'Stop'",
    "Wait-Process -Id $ParentPid -ErrorAction SilentlyContinue",
    "if (-not (Test-Path -LiteralPath $StatePath)) { exit 0 }",
    "$ok = $true",
    "try {",
    "  $state = Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json",
    "  foreach ($adapter in @($state.adapters)) {",
    "    try {",
    "      $index = [int]$adapter.interfaceIndex",
    "      $candidate = Get-NetAdapter -InterfaceIndex $index -ErrorAction SilentlyContinue",
    "      if (-not $candidate -and $adapter.interfaceAlias) { $candidate = Get-NetAdapter -Name ([string]$adapter.interfaceAlias) -ErrorAction SilentlyContinue }",
    "      if (-not $candidate) { throw 'Network adapter not found.' }",
    "      $index = [int]$candidate.ifIndex",
    "      $addresses = @($adapter.serverAddresses | Where-Object { $_ -match '^\\d{1,3}(\\.\\d{1,3}){3}$' })",
    "      if ($adapter.automatic -eq $true) {",
    "        Set-DnsClientServerAddress -InterfaceIndex $index -ResetServerAddresses -ErrorAction Stop",
    "      } elseif ($addresses.Count -gt 0) {",
    "        Set-DnsClientServerAddress -InterfaceIndex $index -ServerAddresses $addresses -ErrorAction Stop",
    "      } else {",
    "        Set-DnsClientServerAddress -InterfaceIndex $index -ResetServerAddresses -ErrorAction Stop",
    "      }",
    "    } catch { $ok = $false; Add-Content -LiteralPath $LogPath -Value ((Get-Date -Format o) + ' ' + $_.Exception.Message) -Encoding UTF8 }",
    "  }",
    "  if ($ok) { Clear-DnsClientCache; Remove-Item -LiteralPath $StatePath -Force }",
    "} catch { Add-Content -LiteralPath $LogPath -Value ((Get-Date -Format o) + ' ' + $_.Exception.Message) -Encoding UTF8; exit 1 }"
  ].join('\r\n');
  fs.writeFileSync(dnsWatchdogPath(), script, 'utf8');
}

function startDnsRecoveryWatchdog() {
  if (dnsWatchdogStarted) return;
  writeDnsWatchdogScript();
  const child = spawn('powershell', [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
    '-File', dnsWatchdogPath(), '-ParentPid', String(process.pid),
    '-StatePath', dohStatePath(), '-LogPath', dnsRecoveryLogPath()
  ], { detached: true, windowsHide: true, stdio: 'ignore' });
  child.unref();
  dnsWatchdogStarted = true;
}

function makeServfail(query) {
  if (!Buffer.isBuffer(query) || query.length < 12) return null;
  const response = Buffer.from(query);
  const flags = response.readUInt16BE(2);
  response.writeUInt16BE((flags | 0x8000) & 0xfff0 | 0x0002, 2);
  response.writeUInt16BE(0, 6);
  response.writeUInt16BE(0, 8);
  response.writeUInt16BE(0, 10);
  return response;
}

function requestDoh(message, endpoint) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: endpoint.host,
      servername: endpoint.servername,
      port: 443,
      path: '/dns-query',
      method: 'POST',
      timeout: 4000,
      headers: {
        'Accept': 'application/dns-message',
        'Content-Type': 'application/dns-message',
        'Content-Length': message.length,
        'Host': endpoint.servername
      }
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 65535) req.destroy(new Error('слишком большой DNS-ответ'));
        else chunks.push(chunk);
      });
      res.on('end', () => {
        const contentType = String(res.headers['content-type'] || '').toLowerCase();
        if (res.statusCode !== 200 || !contentType.includes('application/dns-message')) {
          return reject(new Error(`${endpoint.label}: HTTP ${res.statusCode || 0}`));
        }
        resolve(Buffer.concat(chunks));
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${endpoint.label}: таймаут`)));
    req.on('error', reject);
    req.end(message);
  });
}

async function proxyDnsMessage(socket, message, rinfo) {
  dohStats.queries++;
  let lastError = null;
  for (const endpoint of DOH_ENDPOINTS) {
    try {
      const answer = await requestDoh(message, endpoint);
      if (!socket || socket !== dohSocket) return;
      socket.send(answer, rinfo.port, rinfo.address);
      dohStats.replies++;
      dohStats.lastEndpoint = endpoint.label;
      dohStats.lastError = '';
      return;
    } catch (error) {
      lastError = error;
    }
  }
  dohStats.lastError = lastError ? lastError.message : 'DoH-серверы не ответили';
  const servfail = makeServfail(message);
  if (servfail && socket === dohSocket) socket.send(servfail, rinfo.port, rinfo.address);
}

function startDohProxy() {
  if (dohSocket) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;
    socket.on('message', (message, rinfo) => proxyDnsMessage(socket, message, rinfo));
    socket.on('error', (error) => {
      dohStats.lastError = error.message;
      if (!settled) { settled = true; socket.close(); reject(error); }
    });
    socket.bind(53, '127.0.0.1', () => {
      settled = true;
      dohSocket = socket;
      resolve();
    });
  });
}

function buildDohProbe() {
  const id = crypto.randomBytes(2).readUInt16BE(0);
  const labels = ['example', 'com'].map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)]));
  const packet = Buffer.concat([
    Buffer.from([id >> 8, id & 0xff, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
    ...labels,
    Buffer.from([0, 0, 1, 0, 1])
  ]);
  return { id, packet };
}

function testDohProxy() {
  return new Promise((resolve, reject) => {
    const client = dgram.createSocket('udp4');
    const { id, packet } = buildDohProbe();
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { client.close(); } catch (_) {}
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => finish(new Error('локальный DNS-порт перехватывается VPN, антивирусом или системным фильтром')), 6500);
    client.on('message', (answer) => {
      if (answer.length >= 12 && answer.readUInt16BE(0) === id && (answer[2] & 0x80)) finish();
    });
    client.on('error', finish);
    client.send(packet, 53, '127.0.0.1', (error) => { if (error) finish(error); });
  });
}

function testUdpDnsServer(address, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const client = dgram.createSocket('udp4');
    const { id, packet } = buildDohProbe();
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { client.close(); } catch (_) {}
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => finish(new Error(`${address} не отвечает`)), timeoutMs);
    client.on('message', (answer) => {
      if (answer.length >= 12 && answer.readUInt16BE(0) === id && (answer[2] & 0x80)) finish();
    });
    client.on('error', finish);
    client.send(packet, 53, address, (error) => { if (error) finish(error); });
  });
}

async function testSmartDns(addresses) {
  const errors = [];
  for (const address of addresses) {
    try { await testUdpDnsServer(address); return; }
    catch (error) { errors.push(error.message); }
  }
  throw new Error(`Smart DNS недоступен: ${errors.join('; ')}`);
}

function stopDohProxy() {
  const socket = dohSocket;
  dohSocket = null;
  if (socket) { try { socket.close(); } catch (_) {} }
}

async function enableDoh(profileName = 'secure') {
  const profile = DNS_PROFILES[profileName];
  if (!profile) throw new Error('неизвестный DNS-профиль');
  if (dohEnabled && dohProfile === profileName && (!profile.localProxy || dohSocket)) return getDohStatus();
  if (dohEnabled || readDohState()) disableDoh();

  if (profile.localProxy) {
    await startDohProxy();
    try { await testDohProxy(); }
    catch (error) { stopDohProxy(); throw error; }
  } else {
    await testSmartDns(profile.addresses);
  }
  const adapters = captureActiveDns();
  if (!adapters.length) {
    stopDohProxy();
    throw new Error('не найден активный физический сетевой адаптер');
  }
  const state = { active: true, profile: profileName, createdAt: new Date().toISOString(), ownerPid: process.pid, adapters };
  writeDohState(state);
  startDnsRecoveryWatchdog();
  try {
    setAdapterDns(adapters, profile.addresses);
    dohEnabled = true;
    dohProfile = profileName;
    return getDohStatus();
  } catch (error) {
    try { restoreDnsFromState(state); } catch (_) {}
    try { fs.unlinkSync(dohStatePath()); } catch (_) {}
    stopDohProxy();
    throw error;
  }
}

function disableDoh() {
  const state = readDohState();
  restoreDnsFromState(state);
  try { if (fs.existsSync(dohStatePath())) fs.unlinkSync(dohStatePath()); } catch (_) {}
  dohEnabled = false;
  dohProfile = null;
  stopDohProxy();
  return getDohStatus();
}

function getDohStatus() {
  return { enabled: dohEnabled, profile: dohProfile, proxyRunning: !!dohSocket, ...dohStats };
}

async function recoverDohState() {
  const state = readDohState();
  if (!state || !state.active) return;
  try {
    restoreDnsFromState(state);
    fs.unlinkSync(dohStatePath());
  } catch (error) {
    // Если восстановление не удалось, сохраняем DNS рабочим до ручного исправления.
    if (!state.profile || state.profile === 'secure') await startDohProxy();
    dohEnabled = true;
    dohProfile = state.profile || 'secure';
    startDnsRecoveryWatchdog();
    dohStats.lastError = `Не удалось восстановить DNS: ${error.message}`;
  }
}

function emergencyRestoreDns() {
  const state = readDohState();
  if (!state || !state.active) return true;
  try {
    restoreDnsFromState(state);
    if (fs.existsSync(dohStatePath())) fs.unlinkSync(dohStatePath());
    dohEnabled = false;
    dohProfile = null;
    stopDohProxy();
    return true;
  } catch (error) {
    dohStats.lastError = `Аварийное восстановление DNS: ${error.message}`;
    return false;
  }
}

function isAdmin() {
  try { execSync('net session', { stdio: 'ignore', windowsHide: true }); return true; }
  catch (e) { return false; }
}

if (!isAdmin()) {
  const exePath = process.execPath.replace(/'/g, "''");
  const workDir = path.dirname(process.execPath).replace(/'/g, "''");
  const rawArgs = process.argv.slice(1);
  const argList = rawArgs.length
    ? `-ArgumentList @(${rawArgs.map(a => `'${a.replace(/'/g, "''")}'`).join(',')}) `
    : '';
  const elevationResult = spawnSync('powershell', [
    '-NoProfile', '-WindowStyle', 'Hidden', '-Command',
    `Start-Process -FilePath '${exePath}' ${argList}-WorkingDirectory '${workDir}' -Verb RunAs`
  ], { windowsHide: true });
  process.exit(elevationResult.status === 0 ? 0 : 1);
}

// Один основной экземпляр: повторный запуск ярлыка показывает уже работающее окно.
const ownsSingleInstanceLock = app.requestSingleInstanceLock();

if (!ownsSingleInstanceLock) {
  app.quit();
}

const emptyIcon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=');

// === ФУНКЦИЯ ЗАЧИСТКИ ЗОМБИ-ПРОЦЕССОВ ===
function cleanupEngine() {
    try { execSync("taskkill /F /IM winws.exe /T", { stdio: 'ignore', windowsHide: true }); } catch(e){}
    try { execSync("sc stop WinDivert", { stdio: 'ignore', windowsHide: true }); } catch(e){}
    try { execSync("sc delete WinDivert", { stdio: 'ignore', windowsHide: true }); } catch(e){}
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    pendingShowRequest = true;
    return;
  }

  pendingShowRequest = false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function toggleMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isVisible()) mainWindow.hide();
  else showMainWindow();
}

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
}

function sendTrayAction(action, data) {
  sendToRenderer('tray-action', { action, data });
}

function buildTrayMenu() {
  if (!tray) return;
  const status = trayState.running ? '● ОБХОД АКТИВЕН' : '○ ОБХОД ОСТАНОВЛЕН';
  const menu = Menu.buildFromTemplate([
    { label: status, enabled: false },
    { label: `Стратегия: ${trayState.strategy || '—'}`, enabled: false },
    { label: `Пинг: ${trayState.ping || '---'}   Время: ${trayState.uptime || '00:00:00'}`, enabled: false },
    { type: 'separator' },
    { label: trayState.running ? 'Остановить обход' : 'Запустить обход', click: () => sendTrayAction('toggle-engine') },
    { label: 'Автоподбор стратегии', click: () => sendTrayAction('auto-detect') },
    { label: 'Telegram-прокси', click: () => { showMainWindow(); sendTrayAction('show-telegram'); } },
    { type: 'separator' },
    { label: 'Обновить списки', click: () => sendTrayAction('update-lists') },
    { label: 'Проверить обновление приложения', click: () => { showMainWindow(); sendTrayAction('check-update'); } },
    { type: 'separator' },
    {
      label: 'Запускать вместе с Windows', type: 'checkbox', checked: !!trayState.autostart,
      click: (item) => sendTrayAction('set-autostart', item.checked)
    },
    {
      label: 'Тихий режим', type: 'checkbox', checked: !!trayState.quietMode,
      click: (item) => sendTrayAction('set-quiet-mode', item.checked)
    },
    { type: 'separator' },
    { label: 'Открыть Zapret Electron', click: showMainWindow },
    { label: 'Полный выход', click: () => {
        app.isQuiting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(menu);
}

function requestJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('слишком много перенаправлений'));
    const req = https.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': `Zapret-Electron/${app.getVersion()}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).href;
        res.resume();
        return requestJson(next, redirects + 1).then(resolve, reject);
      }
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 2 * 1024 * 1024) req.destroy(new Error('ответ слишком большой'));
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`GitHub API: HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); }
        catch (_) { reject(new Error('GitHub вернул некорректный ответ')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('таймаут проверки обновления')));
    req.on('error', reject);
  });
}

function normalizeVersion(value) {
  return String(value || '').replace(/^v/i, '').split('.').map((part) => parseInt(part, 10) || 0);
}

function compareVersions(a, b) {
  const left = normalizeVersion(a);
  const right = normalizeVersion(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

function findInstallerAsset(release) {
  return (release.assets || []).find((asset) => /^ZapretElectron-Setup-v[\d.]+\.exe$/i.test(asset.name));
}

async function checkForUpdates(manual = false) {
  sendToRenderer('update-status', { state: 'checking', manual });
  try {
    const release = await requestJson(`${UPDATE_API}/releases/latest`);
    const asset = findInstallerAsset(release);
    if (!asset) throw new Error('в последнем релизе нет установщика');
    if (!asset.digest || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest)) {
      throw new Error('установщик опубликован без контрольной суммы SHA-256');
    }
    const currentVersion = app.getVersion();
    const latestVersion = String(release.tag_name || '').replace(/^v/i, '');
    if (compareVersions(latestVersion, currentVersion) <= 0) {
      availableUpdate = null;
      sendToRenderer('update-status', { state: 'latest', currentVersion, latestVersion, manual });
      return;
    }
    availableUpdate = {
      version: latestVersion,
      tag: release.tag_name,
      name: release.name,
      notes: release.body || '',
      pageUrl: release.html_url,
      asset: {
        name: asset.name,
        url: asset.browser_download_url,
        size: asset.size,
        digest: asset.digest
      }
    };
    sendToRenderer('update-status', { state: 'available', update: availableUpdate, manual });
  } catch (error) {
    sendToRenderer('update-status', { state: 'error', message: error.message, manual });
  }
}

function downloadVerifiedInstaller(update, purpose = 'update') {
  return new Promise((resolve, reject) => {
    const updatesDir = path.join(app.getPath('userData'), 'updates');
    fs.mkdirSync(updatesDir, { recursive: true });
    const finalPath = path.join(updatesDir, update.asset.name);
    const tempPath = `${finalPath}.download`;
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}

    const download = (url, redirects = 0) => {
      if (redirects > 5) return reject(new Error('слишком много перенаправлений при загрузке'));
      const req = https.get(url, {
        timeout: 30000,
        headers: { 'User-Agent': `Zapret-Electron/${app.getVersion()}`, 'Accept': 'application/octet-stream' }
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const next = new URL(res.headers.location, url).href;
          res.resume();
          return download(next, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`ошибка загрузки: HTTP ${res.statusCode}`));
        }
        const total = Number(res.headers['content-length']) || update.asset.size || 0;
        let received = 0;
        const hash = crypto.createHash('sha256');
        const output = fs.createWriteStream(tempPath);
        res.on('data', (chunk) => {
          received += chunk.length;
          hash.update(chunk);
          const percent = total ? Math.min(100, Math.round(received * 100 / total)) : null;
          sendToRenderer('update-status', { state: 'downloading', purpose, received, total, percent });
        });
        res.pipe(output);
        output.on('finish', () => {
          output.close(() => {
            const actual = hash.digest('hex').toLowerCase();
            const expected = update.asset.digest.replace(/^sha256:/i, '').toLowerCase();
            if (actual !== expected) {
              try { fs.unlinkSync(tempPath); } catch (_) {}
              return reject(new Error('SHA-256 не совпал — файл удалён'));
            }
            fs.copyFileSync(tempPath, finalPath);
            fs.unlinkSync(tempPath);
            resolve({ filePath: finalPath, sha256: actual });
          });
        });
        output.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('таймаут загрузки обновления')));
      req.on('error', reject);
    };
    download(update.asset.url);
  });
}

function getAuthenticodeStatus(filePath) {
  try {
    return execSync(`powershell -NoProfile -Command "(Get-AuthenticodeSignature -LiteralPath '${filePath.replace(/'/g, "''")}').Status"`, {
      encoding: 'utf8', windowsHide: true
    }).trim();
  } catch (_) { return 'UnknownError'; }
}

function readUpdaterState() {
  try { return JSON.parse(fs.readFileSync(updaterStatePath(), 'utf8')); }
  catch (_) { return {}; }
}

function writeUpdaterState(state) {
  fs.writeFileSync(updaterStatePath(), JSON.stringify(state, null, 2), 'utf8');
}

async function getCurrentReleaseForRollback() {
  const shortVersion = normalizeVersion(app.getVersion()).slice(0, 2).join('.');
  const release = await requestJson(`${UPDATE_API}/releases/tags/v${shortVersion}`);
  const asset = findInstallerAsset(release);
  if (!asset || !asset.digest) return null;
  return {
    version: shortVersion,
    tag: release.tag_name,
    asset: { name: asset.name, url: asset.browser_download_url, size: asset.size, digest: asset.digest }
  };
}

async function installUpdate(update, purpose = 'update') {
  sendToRenderer('update-status', { state: 'preparing', purpose });
  try {
    const downloaded = await downloadVerifiedInstaller(update, purpose);
    const signatureStatus = getAuthenticodeStatus(downloaded.filePath);
    if (!['Valid', 'NotSigned'].includes(signatureStatus)) {
      throw new Error(`недопустимая цифровая подпись: ${signatureStatus}`);
    }

    if (purpose === 'update') {
      let previousRelease = null;
      try { previousRelease = await getCurrentReleaseForRollback(); } catch (_) {}
      writeUpdaterState({
        previousRelease,
        installedVersion: update.version,
        verifiedSha256: downloaded.sha256,
        signatureStatus,
        installedAt: new Date().toISOString()
      });
    } else {
      writeUpdaterState({
        rolledBackTo: update.version,
        verifiedSha256: downloaded.sha256,
        signatureStatus,
        rolledBackAt: new Date().toISOString()
      });
    }

    if (readDohState() || dohEnabled) disableDoh();
    sendToRenderer('update-status', { state: 'verified', purpose, signatureStatus });
    app.isQuiting = true;
    cleanupEngine();
    const child = spawn(downloaded.filePath, ['/VERYSILENT', '/NORESTART', '/CLOSEAPPLICATIONS'], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore'
    });
    child.unref();
    setTimeout(() => app.quit(), 500);
  } catch (error) {
    sendToRenderer('update-status', { state: 'error', message: error.message, purpose, manual: true });
  }
}

app.on('second-instance', () => {
  showMainWindow();
});

function createWindow () {
  const startMinimized = process.argv.includes('--autostart');

  let windowIcon;
  if (fs.existsSync(path.join(__dirname, 'icon.ico'))) {
      windowIcon = path.join(__dirname, 'icon.ico');
  } else if (fs.existsSync(path.join(__dirname, 'icon.png'))) {
      windowIcon = path.join(__dirname, 'icon.png');
  }

  mainWindow = new BrowserWindow({
    width: 550,
    height: 850,
    autoHideMenuBar: true,
    show: !startMinimized,
    icon: windowIcon, 
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false 
    }
  })
  
  mainWindow.loadFile('index.html')

  mainWindow.once('ready-to-show', () => {
    if (pendingShowRequest) showMainWindow();
  });

  mainWindow.webContents.on('did-finish-load', () => {
    sendToRenderer('app-version', {
      version: app.getVersion(),
      rollback: readUpdaterState().previousRelease || null
    });
  });

  // Прячем в трей при нажатии на крестик
  mainWindow.on('close', function (event) {
    if (!app.isQuiting) {
      event.preventDefault(); 
      mainWindow.hide();      
    }
  });

  mainWindow.on('session-end', () => {
    emergencyRestoreDns();
  });
}

app.whenReady().then(async () => {
  if (!ownsSingleInstanceLock) return;

  try { await recoverDohState(); }
  catch (error) { dohStats.lastError = `Ошибка восстановления DNS: ${error.message}`; }

  const shouldAutostart = process.argv.includes('--autostart');
  createWindow()

  if (shouldAutostart) {
    mainWindow.webContents.on('did-finish-load', () => {
      mainWindow.webContents.send('do-autostart');
    });
  }

  tray = new Tray(emptyIcon);
  
  tray.setToolTip('Zapret Electron: Загрузка...')
  buildTrayMenu()

  globalShortcut.register('Ctrl+Shift+Z', () => {
    mainWindow.webContents.send('hotkey-toggle');
  });

  tray.on('click', () => {
    // Windows также генерирует click во время double-click. Ждём немного,
    // чтобы одиночный обработчик не спрятал окно сразу после двойного клика.
    if (trayClickTimer) clearTimeout(trayClickTimer);
    trayClickTimer = setTimeout(() => {
      trayClickTimer = null;
      toggleMainWindow();
    }, 300);
  })

  tray.on('double-click', () => {
    if (trayClickTimer) {
      clearTimeout(trayClickTimer);
      trayClickTimer = null;
    }
    showMainWindow();
  })
})

app.on('activate', showMainWindow);

ipcMain.on('update-tray', (event, data) => {
  if (!tray) return;
  if (data.imgBase64) {
    const img = nativeImage.createFromDataURL(data.imgBase64);
    tray.setImage(img);
  }
  if (data.tooltip) tray.setToolTip(data.tooltip);
  trayState = { ...trayState, ...data.state };
  buildTrayMenu();
});

ipcMain.on('check-for-updates', (_event, data) => checkForUpdates(!!(data && data.manual)));
ipcMain.on('install-update', () => { if (availableUpdate) installUpdate(availableUpdate, 'update'); });
ipcMain.on('open-release-page', () => { if (availableUpdate && availableUpdate.pageUrl) shell.openExternal(availableUpdate.pageUrl); });
ipcMain.on('rollback-update', async () => {
  const previousRelease = readUpdaterState().previousRelease;
  if (!previousRelease) {
    sendToRenderer('update-status', { state: 'error', message: 'данные предыдущей версии не найдены', manual: true });
    return;
  }
  await installUpdate(previousRelease, 'rollback');
});

ipcMain.handle('doh:get-status', () => getDohStatus());
ipcMain.handle('doh:set-enabled', async (_event, request) => {
  try {
    const enabled = typeof request === 'object' ? !!request.enabled : !!request;
    const profile = typeof request === 'object' ? request.profile : 'secure';
    const status = enabled ? await enableDoh(profile) : disableDoh();
    return { ok: true, status };
  } catch (error) {
    return { ok: false, error: error.message, status: getDohStatus() };
  }
});

// Глобальный перехватчик: перед тем как программа умрет, делаем контрольный выстрел
app.on('before-quit', (event) => {
  if (!ownsSingleInstanceLock) return;
  if ((readDohState() || dohEnabled) && !dohExitBlocked) {
    try { disableDoh(); }
    catch (error) {
      event.preventDefault();
      dohExitBlocked = true;
      app.isQuiting = false;
      dialog.showErrorBox('Не удалось восстановить DNS', `Приложение не будет закрыто, чтобы интернет не пропал.\n\n${error.message}`);
      setTimeout(() => { dohExitBlocked = false; }, 1000);
      return;
    }
  }
  if (trayClickTimer) {
    clearTimeout(trayClickTimer);
    trayClickTimer = null;
  }
  globalShortcut.unregisterAll();
  cleanupEngine(); // <-- УБИВАЕМ ПРОЦЕССЫ, ЕСЛИ ПРОГРАММА ЗАКРЫЛАСЬ ИНАЧЕ (например, перезагрузка ПК)
  if (tray) {
      tray.destroy();
  }
});

app.on('will-quit', () => {
  emergencyRestoreDns();
});

process.on('exit', () => {
  emergencyRestoreDns();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
