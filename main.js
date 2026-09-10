const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, globalShortcut, shell, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const https = require('https')
const dgram = require('dgram')
const net = require('net')
const tls = require('tls')
const dns = require('dns')
const crypto = require('crypto')
const { execSync, spawn, spawnSync } = require('child_process')

const previewMode = process.argv.includes('--ui-preview');
const testInstanceMode = process.argv.includes('--test-instance');
if (previewMode || testInstanceMode) {
  const isolatedProfile = previewMode ? 'zapret-pro-ui-preview' : 'zapret-pro-test-instance';
  app.setPath('userData', path.join(app.getPath('appData'), isolatedProfile));
}

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
let dnsHealthTimer = null;
let dnsHealthFailures = 0;
let dnsHealthState = 'idle';
let tgWsProcess = null;
let tgWsStartedAt = 0;
let tgWsLastError = '';
let tgWsRecentLog = [];
let tgWsStopping = false;
let tgWsConnectRequestedAt = 0;
let tgWsRouteState = { route: null, seenAt: 0 };

const TG_WS_VERSION = '1.10.2';
const TG_WS_PORT = 1443;
const TG_WS_HOST = '127.0.0.1';

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
const tgWsStatePath = () => path.join(app.getPath('userData'), 'tg-ws-proxy-state.json');
const tgWsLogPath = () => path.join(app.getPath('userData'), 'tg-ws-proxy.log');
const tgWsBinaryPath = () => path.join(__dirname, 'bin', 'TgWsProxy-headless.exe');

function readTgWsState() {
  try {
    const state = JSON.parse(fs.readFileSync(tgWsStatePath(), 'utf8'));
    if (!/^[a-f0-9]{32}$/i.test(String(state.secret || ''))) state.secret = crypto.randomBytes(16).toString('hex');
    return state;
  } catch (_) {
    return { secret: crypto.randomBytes(16).toString('hex'), lastPid: null };
  }
}

function writeTgWsState(state) {
  fs.mkdirSync(path.dirname(tgWsStatePath()), { recursive: true });
  fs.writeFileSync(tgWsStatePath(), JSON.stringify(state, null, 2), 'utf8');
}

function ensureTgWsState() {
  const state = readTgWsState();
  writeTgWsState(state);
  return state;
}

function rememberTgWsPid(pid) {
  const state = ensureTgWsState();
  state.lastPid = Number.isInteger(pid) && pid > 0 ? pid : null;
  writeTgWsState(state);
}

function cleanupStaleTgWsProxy() {
  const state = ensureTgWsState();
  const pid = Number(state.lastPid);
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    const expected = tgWsBinaryPath();
    const executable = runPowerShell(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction SilentlyContinue; if($p){[string]$p.ExecutablePath}`);
    if (executable && path.resolve(executable).toLowerCase() === path.resolve(expected).toLowerCase()) {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    }
  } catch (_) {}
  state.lastPid = null;
  writeTgWsState(state);
}

function isTgWsProcessAlive() {
  return !!(tgWsProcess && tgWsProcess.exitCode === null && !tgWsProcess.killed);
}

function canConnectTcp(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function redactTgWsLog(value) {
  const secret = String(readTgWsState().secret || '');
  return String(value || '')
    .replace(secret, '[secret]')
    .replace(/([a-z0-9-]+\.)+[a-z]{2,}/gi, '[domain]')
    .trim();
}

function pushTgWsLog(chunk) {
  for (const rawLine of String(chunk || '').split(/\r?\n/)) {
    const line = redactTgWsLog(rawLine);
    if (!line) continue;
    tgWsRecentLog.push(line);
    if (/stats:.*tcp_fb=[1-9]/i.test(line)) tgWsRouteState = { route: 'tcp', seenAt: Date.now() };
    else if (/Switched active CF domain|CF worker pool hit|stats:.*cf=[1-9]/i.test(line)) tgWsRouteState = { route: 'cloudflare', seenAt: Date.now() };
    else if (/DC\d+.*(?:pool hit|WS session)/i.test(line)) tgWsRouteState = { route: 'websocket', seenAt: Date.now() };
  }
  tgWsRecentLog = tgWsRecentLog.slice(-40);
}

async function getTgWsStatus() {
  const processAlive = isTgWsProcessAlive();
  // Не открываем TCP-соединение каждые 10 секунд: для MTProto это выглядит
  // как оборванное рукопожатие и засоряет статистику локального прокси.
  const listening = processAlive ? true : await canConnectTcp(TG_WS_HOST, TG_WS_PORT);
  const telegramConnected = !!(
    tgWsConnectRequestedAt &&
    tgWsRouteState.seenAt >= tgWsConnectRequestedAt
  );
  return {
    available: fs.existsSync(tgWsBinaryPath()),
    running: processAlive && listening,
    starting: processAlive && !listening,
    portConflict: !processAlive && listening,
    host: TG_WS_HOST,
    port: TG_WS_PORT,
    version: TG_WS_VERSION,
    startedAt: tgWsStartedAt || null,
    connectRequestedAt: tgWsConnectRequestedAt || null,
    telegramConnected,
    route: telegramConnected ? tgWsRouteState.route : null,
    error: tgWsLastError,
    log: tgWsRecentLog.slice(-12)
  };
}

async function publishTgWsStatus() {
  sendToRenderer('tg-ws:status', await getTgWsStatus());
}

async function waitForTgWsListener(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isTgWsProcessAlive()) {
    if (await canConnectTcp(TG_WS_HOST, TG_WS_PORT, 500)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function startTgWsProxy() {
  if (previewMode) throw new Error('В режиме предпросмотра локальный прокси не запускается');
  if (!fs.existsSync(tgWsBinaryPath())) throw new Error('Модуль TG WS Proxy отсутствует в сборке');
  if (isTgWsProcessAlive()) return getTgWsStatus();
  if (await canConnectTcp(TG_WS_HOST, TG_WS_PORT)) {
    throw new Error(`Порт ${TG_WS_PORT} уже занят другой программой`);
  }

  const state = ensureTgWsState();
  tgWsLastError = '';
  tgWsRecentLog = [];
  tgWsStopping = false;
  tgWsConnectRequestedAt = 0;
  tgWsRouteState = { route: null, seenAt: 0 };
  tgWsStartedAt = Date.now();
  tgWsProcess = spawn(tgWsBinaryPath(), [
    '--host', TG_WS_HOST,
    '--port', String(TG_WS_PORT),
    '--secret', state.secret,
    '--dc-ip', '2:149.154.167.220',
    '--dc-ip', '4:149.154.167.220',
    '--dc-ip', '203:91.105.192.100',
    '--pool-size', '4',
    '--log-file', tgWsLogPath(),
    '--log-max-mb', '2',
    '--log-backups', '1'
  ], {
    cwd: path.dirname(tgWsBinaryPath()),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  rememberTgWsPid(tgWsProcess.pid);
  tgWsProcess.stdout.on('data', pushTgWsLog);
  tgWsProcess.stderr.on('data', pushTgWsLog);
  tgWsProcess.once('error', (error) => {
    tgWsLastError = error.message;
    publishTgWsStatus();
  });
  tgWsProcess.once('exit', (code) => {
    const wasStopping = tgWsStopping;
    tgWsProcess = null;
    tgWsStartedAt = 0;
    rememberTgWsPid(null);
    if (!wasStopping && code !== 0) tgWsLastError = `Локальный прокси завершился с кодом ${code}`;
    publishTgWsStatus();
  });

  if (!await waitForTgWsListener()) {
    const detail = tgWsRecentLog.slice(-1)[0];
    await stopTgWsProxy();
    throw new Error(detail || 'Локальный прокси не успел запуститься');
  }
  await publishTgWsStatus();
  return getTgWsStatus();
}

async function stopTgWsProxy() {
  const child = tgWsProcess;
  if (!child) return getTgWsStatus();
  tgWsStopping = true;
  const pid = child.pid;
  if (process.platform === 'win32' && Number.isInteger(pid)) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try { child.kill(); } catch (_) {}
  }
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timeout = setTimeout(resolve, 1500);
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
  });
  if (child.exitCode === null && Number.isInteger(pid)) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  }
  tgWsProcess = null;
  tgWsStartedAt = 0;
  tgWsLastError = '';
  tgWsConnectRequestedAt = 0;
  tgWsRouteState = { route: null, seenAt: 0 };
  rememberTgWsPid(null);
  await publishTgWsStatus();
  return getTgWsStatus();
}

function stopTgWsProxySync() {
  const pid = tgWsProcess && tgWsProcess.pid;
  tgWsStopping = true;
  if (Number.isInteger(pid) && pid > 0) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  }
  tgWsProcess = null;
  tgWsStartedAt = 0;
  tgWsConnectRequestedAt = 0;
  tgWsRouteState = { route: null, seenAt: 0 };
  try { rememberTgWsPid(null); } catch (_) {}
}

function findTelegramExecutable() {
  const candidates = [
    path.join(app.getPath('appData'), 'Telegram Desktop', 'Telegram.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Telegram Desktop', 'Telegram.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Telegram Desktop', 'Telegram.exe')
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

async function openTelegramProxyLink(url) {
  const telegramExe = findTelegramExecutable();
  if (telegramExe) {
    const child = spawn(telegramExe, ['--', url], {
      cwd: path.dirname(telegramExe),
      detached: true,
      windowsHide: false,
      stdio: 'ignore'
    });
    child.unref();
    return 'direct';
  }
  await shell.openExternal(url);
  return 'protocol';
}
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

function stopDnsHealthMonitor() {
  if (dnsHealthTimer) clearInterval(dnsHealthTimer);
  dnsHealthTimer = null;
  dnsHealthFailures = 0;
  dnsHealthState = 'idle';
}

async function checkDnsProfileHealth() {
  if (!dohEnabled || !dohProfile) return;
  const profile = DNS_PROFILES[dohProfile];
  if (!profile) return;
  try {
    let detail = '';
    if (profile.localProxy) {
      await testDohProxy();
      detail = dohStats.lastEndpoint || 'Cloudflare / Google';
    } else {
      const checks = await Promise.allSettled(profile.addresses.map((address) => testUdpDnsServer(address, 2200)));
      const healthy = profile.addresses.filter((_address, index) => checks[index].status === 'fulfilled');
      if (!healthy.length) throw new Error('резервные Smart DNS не отвечают');
      const failed = profile.addresses.filter((address) => !healthy.includes(address));
      const ordered = [...healthy, ...failed];
      const state = readDohState();
      if (state && Array.isArray(state.adapters) && ordered.join(',') !== profile.addresses.join(',')) {
        setAdapterDns(state.adapters, ordered);
      }
      detail = healthy.join(', ');
    }
    dnsHealthFailures = 0;
    dnsHealthState = 'healthy';
    sendToRenderer('dns:health-event', { state: 'healthy', profile: dohProfile, detail });
  } catch (error) {
    dnsHealthFailures++;
    dnsHealthState = dnsHealthFailures >= 3 ? 'restoring' : 'degraded';
    sendToRenderer('dns:health-event', {
      state: dnsHealthState,
      profile: dohProfile,
      failures: dnsHealthFailures,
      detail: error.message
    });
    if (dnsHealthFailures >= 3) {
      try {
        disableDoh();
        sendToRenderer('dns:health-event', {
          state: 'restored',
          detail: 'DNS-профиль не ответил три раза. Исходные настройки восстановлены.'
        });
      } catch (restoreError) {
        dohStats.lastError = `Не удалось автоматически восстановить DNS: ${restoreError.message}`;
        sendToRenderer('dns:health-event', { state: 'error', detail: dohStats.lastError });
      }
    }
  }
}

function startDnsHealthMonitor() {
  if (dnsHealthTimer) clearInterval(dnsHealthTimer);
  dnsHealthFailures = 0;
  dnsHealthState = 'checking';
  dnsHealthTimer = setInterval(() => { checkDnsProfileHealth().catch(() => {}); }, 60 * 1000);
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
    startDnsHealthMonitor();
    return getDohStatus();
  } catch (error) {
    try { restoreDnsFromState(state); } catch (_) {}
    try { fs.unlinkSync(dohStatePath()); } catch (_) {}
    stopDohProxy();
    throw error;
  }
}

function disableDoh() {
  stopDnsHealthMonitor();
  const state = readDohState();
  restoreDnsFromState(state);
  try { if (fs.existsSync(dohStatePath())) fs.unlinkSync(dohStatePath()); } catch (_) {}
  dohEnabled = false;
  dohProfile = null;
  stopDohProxy();
  return getDohStatus();
}

function getDohStatus() {
  return {
    enabled: dohEnabled,
    profile: dohProfile,
    proxyRunning: !!dohSocket,
    healthState: dnsHealthState,
    healthFailures: dnsHealthFailures,
    ...dohStats
  };
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
    startDnsHealthMonitor();
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

const DIAGNOSTIC_TARGETS = {
  youtube: { label: 'YouTube', host: 'www.youtube.com', path: '/generate_204' },
  discord: { label: 'Discord', host: 'discord.com', path: '/' },
  telegram: { label: 'Telegram', host: 't.me', path: '/' },
  chatgpt: { label: 'ChatGPT', host: 'chatgpt.com', path: '/' },
  gemini: { label: 'Gemini', host: 'gemini.google.com', path: '/' }
};

function measured(startedAt, value) {
  return { ...value, ms: Date.now() - startedAt };
}

function probeTcp(host, port = 443, timeoutMs = 4500) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve(measured(startedAt, result));
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ ok: true }));
    socket.once('timeout', () => finish({ ok: false, error: 'таймаут TCP' }));
    socket.once('error', (error) => finish({ ok: false, error: error.message, code: error.code || '' }));
  });
}

function probeTls(address, servername, timeoutMs = 5500) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const socket = tls.connect({ host: address, port: 443, servername, rejectUnauthorized: true });
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve(measured(startedAt, result));
    };
    socket.setTimeout(timeoutMs);
    socket.once('secureConnect', () => finish({ ok: true, protocol: socket.getProtocol() || '' }));
    socket.once('timeout', () => finish({ ok: false, error: 'таймаут TLS' }));
    socket.once('error', (error) => finish({ ok: false, error: error.message, code: error.code || '' }));
  });
}

function probeHttps(host, requestPath = '/', timeoutMs = 7000) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      resolve(measured(startedAt, result));
    };
    const req = https.request({
      hostname: host,
      port: 443,
      path: requestPath,
      method: 'GET',
      timeout: timeoutMs,
      headers: { 'User-Agent': `Zapret-Electron/${app.getVersion()}`, 'Accept': '*/*' }
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        if (size < 8192) chunks.push(chunk.slice(0, 8192 - size));
        size += chunk.length;
      });
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8').toLowerCase();
        const blockPage = /доступ[^<]{0,80}(ограничен|заблокирован)|единый реестр|access denied|unavailable for legal reasons/.test(body);
        finish({ ok: true, status: Number(res.statusCode || 0), blockPage });
      });
    });
    req.once('timeout', () => req.destroy(new Error('таймаут HTTPS')));
    req.once('error', (error) => finish({ ok: false, error: error.message, code: error.code || '' }));
    req.end();
  });
}

function resolveWithSystem(host) {
  const startedAt = Date.now();
  return dns.promises.lookup(host, { all: true, family: 4 })
    .then((records) => {
      const addresses = records.map((record) => record.address).filter(Boolean);
      return measured(startedAt, { ok: addresses.length > 0, addresses });
    })
    .catch((error) => measured(startedAt, { ok: false, addresses: [], error: error.message, code: error.code || '' }));
}

function resolveWithPublicDoh(host, timeoutMs = 6000) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      resolve(measured(startedAt, result));
    };
    const req = https.request({
      host: '1.1.1.1',
      servername: 'cloudflare-dns.com',
      port: 443,
      path: `/dns-query?name=${encodeURIComponent(host)}&type=A`,
      method: 'GET',
      timeout: timeoutMs,
      headers: { Host: 'cloudflare-dns.com', Accept: 'application/dns-json' }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const addresses = (payload.Answer || []).filter((item) => item.type === 1).map((item) => String(item.data));
          finish({ ok: res.statusCode === 200 && addresses.length > 0, addresses, status: res.statusCode });
        } catch (error) { finish({ ok: false, addresses: [], error: error.message }); }
      });
    });
    req.once('timeout', () => req.destroy(new Error('таймаут публичного DoH')));
    req.once('error', (error) => finish({ ok: false, addresses: [], error: error.message, code: error.code || '' }));
    req.end();
  });
}

function collectSystemSignals() {
  try {
    const command = [
      "$adapters=@(Get-NetAdapter | Where-Object Status -eq 'Up' | ForEach-Object {[pscustomobject]@{Name=[string]$_.Name; Description=[string]$_.InterfaceDescription; Index=[int]$_.ifIndex; Hardware=[bool]$_.HardwareInterface}})",
      "$dns=@(Get-DnsClientServerAddress -AddressFamily IPv4 | Where-Object {$_.ServerAddresses.Count -gt 0} | ForEach-Object {[pscustomobject]@{Name=[string]$_.InterfaceAlias; Index=[int]$_.InterfaceIndex; Servers=@($_.ServerAddresses)}})",
      "$ports=@(Get-NetUDPEndpoint -LocalPort 53 -ErrorAction SilentlyContinue | ForEach-Object {$p=Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; [pscustomobject]@{Address=[string]$_.LocalAddress; Pid=[int]$_.OwningProcess; Process=[string]$p.ProcessName}})",
      "$reg=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction SilentlyContinue",
      "$proxy=[pscustomobject]@{Enabled=([int]$reg.ProxyEnable -eq 1); Server=[string]$reg.ProxyServer; AutoConfig=[string]$reg.AutoConfigURL}",
      "$winws=@(Get-CimInstance Win32_Process -Filter \"Name='winws.exe'\" -ErrorAction SilentlyContinue | ForEach-Object {[pscustomobject]@{Pid=[int]$_.ProcessId; Path=[string]$_.ExecutablePath}})",
      "$services=@(Get-Service -Name 'WinDivert*' -ErrorAction SilentlyContinue | ForEach-Object {[pscustomobject]@{Name=[string]$_.Name; Status=[string]$_.Status}})",
      "$computer=Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue",
      "$os=Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue",
      "$nativeArch=[string](Get-ItemProperty -LiteralPath 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment' -ErrorAction SilentlyContinue).PROCESSOR_ARCHITECTURE",
      "$computerInfo=[pscustomobject]@{Manufacturer=[string]$computer.Manufacturer; Model=[string]$computer.Model; SystemType=[string]$computer.SystemType; OsArchitecture=[string]$os.OSArchitecture; NativeArchitecture=$nativeArch}",
      "$deviceGuard=Get-CimInstance -Namespace 'root\\Microsoft\\Windows\\DeviceGuard' -ClassName Win32_DeviceGuard -ErrorAction SilentlyContinue",
      "$guardInfo=if($deviceGuard){[pscustomobject]@{VbsStatus=[int]$deviceGuard.VirtualizationBasedSecurityStatus; Configured=@($deviceGuard.SecurityServicesConfigured); Running=@($deviceGuard.SecurityServicesRunning)}}else{$null}",
      "$uninstallPaths=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')",
      "$hpPattern='(?i)HP\\s*(Wolf|Sure|Velocity|Security|Connection Optimizer|Client Security)|Bromium'",
      "$hpSoftware=@(Get-ItemProperty -Path $uninstallPaths -ErrorAction SilentlyContinue | Where-Object {[string]$_.DisplayName -match $hpPattern} | ForEach-Object {[pscustomobject]@{Name=[string]$_.DisplayName; Version=[string]$_.DisplayVersion}})",
      "$hpServices=@(Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | Where-Object {(($_.Name + ' ' + $_.DisplayName) -match $hpPattern)} | ForEach-Object {[pscustomobject]@{Name=[string]$_.Name; DisplayName=[string]$_.DisplayName; State=[string]$_.State}})",
      "$hpProcesses=@(Get-Process -ErrorAction SilentlyContinue | Where-Object {$_.ProcessName -match '(?i)HPWolf|Bromium|SureClick|SureSense|HPVelocity|HPSecurity'} | ForEach-Object {[pscustomobject]@{Name=[string]$_.ProcessName; Pid=[int]$_.Id}})",
      "$hpBindings=@(Get-NetAdapterBinding -AllBindings -ErrorAction SilentlyContinue | Where-Object {$_.Enabled -and (($_.DisplayName + ' ' + $_.ComponentID) -match $hpPattern)} | ForEach-Object {[pscustomobject]@{Adapter=[string]$_.Name; Name=[string]$_.DisplayName; ComponentId=[string]$_.ComponentID}})",
      "$ciEvents=@(Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-CodeIntegrity/Operational'; StartTime=(Get-Date).AddDays(-14)} -MaxEvents 100 -ErrorAction SilentlyContinue | Where-Object {$_.Message -match '(?i)WinDivert'} | Select-Object -First 10 | ForEach-Object {[pscustomobject]@{Time=[string]$_.TimeCreated.ToString('o'); Id=[int]$_.Id; Level=[string]$_.LevelDisplayName; Message=[string]$_.Message}})",
      "[pscustomobject]@{Adapters=$adapters; Dns=$dns; Port53=$ports; Proxy=$proxy; Winws=$winws; WinDivert=$services; Computer=$computerInfo; DeviceGuard=$guardInfo; HpSoftware=$hpSoftware; HpServices=$hpServices; HpProcesses=$hpProcesses; HpBindings=$hpBindings; CodeIntegrity=$ciEvents} | ConvertTo-Json -Compress -Depth 6"
    ].join('; ');
    const output = runPowerShell(command);
    return output ? JSON.parse(output) : {};
  } catch (error) {
    return { error: error.message };
  }
}

function buildConflictList(system, engineRunning) {
  const conflicts = [];
  const adapters = Array.isArray(system.Adapters) ? system.Adapters : (system.Adapters ? [system.Adapters] : []);
  const tunnels = adapters.filter((adapter) => /vpn|wireguard|wintun|tap|tun|tailscale|zerotier|radmin|hamachi|adguard|happ/i.test(`${adapter.Name} ${adapter.Description}`));
  if (tunnels.length) conflicts.push({ level: 'warning', title: 'Обнаружен туннель или сетевой фильтр', detail: tunnels.map((item) => item.Name).join(', ') });

  if (system.Proxy && (system.Proxy.Enabled || system.Proxy.AutoConfig)) {
    conflicts.push({ level: 'warning', title: 'Системный прокси Windows активен', detail: system.Proxy.Server || system.Proxy.AutoConfig });
  }

  const port53 = Array.isArray(system.Port53) ? system.Port53 : (system.Port53 ? [system.Port53] : []);
  const foreignDns = port53.filter((item) => Number(item.Pid) !== process.pid);
  if (foreignDns.length) conflicts.push({ level: 'warning', title: 'DNS-порт 53 занят другой программой', detail: foreignDns.map((item) => `${item.Process || 'PID'} ${item.Pid}`).join(', ') });

  const dnsRows = Array.isArray(system.Dns) ? system.Dns : (system.Dns ? [system.Dns] : []);
  const staleLoopback = dnsRows.some((row) => (Array.isArray(row.Servers) ? row.Servers : [row.Servers]).includes('127.0.0.1')) && !dohEnabled;
  if (staleLoopback) conflicts.push({ level: 'error', title: 'Остался локальный DNS 127.0.0.1', detail: 'Защищённый DNS приложения выключен, но Windows всё ещё направляет запросы на локальный адрес.' });

  const winws = Array.isArray(system.Winws) ? system.Winws : (system.Winws ? [system.Winws] : []);
  if (winws.length > (engineRunning ? 1 : 0)) conflicts.push({ level: 'warning', title: 'Запущено несколько процессов обхода', detail: `Найдено процессов winws.exe: ${winws.length}` });

  const computer = system.Computer || {};
  const computerName = `${computer.Manufacturer || ''} ${computer.Model || ''}`.trim();
  const isHp = /\bHP\b|Hewlett[- ]Packard/i.test(computer.Manufacturer || '');
  const isArm64 = /arm64/i.test(`${computer.SystemType || ''} ${computer.NativeArchitecture || ''}`);
  if (isArm64) {
    conflicts.push({ level: 'error', title: 'Windows ARM64 не поддерживается этой сборкой', detail: `${computerName || 'Устройство'} · ${computer.SystemType || computer.NativeArchitecture}. Для WinDivert нужен отдельный ARM64-драйвер.` });
  }

  const hpSoftware = Array.isArray(system.HpSoftware) ? system.HpSoftware : (system.HpSoftware ? [system.HpSoftware] : []);
  const hpServices = Array.isArray(system.HpServices) ? system.HpServices : (system.HpServices ? [system.HpServices] : []);
  const hpProcesses = Array.isArray(system.HpProcesses) ? system.HpProcesses : (system.HpProcesses ? [system.HpProcesses] : []);
  const hpBindings = Array.isArray(system.HpBindings) ? system.HpBindings : (system.HpBindings ? [system.HpBindings] : []);
  const hpNames = [...hpSoftware.map((item) => item.Name), ...hpServices.map((item) => item.DisplayName || item.Name), ...hpBindings.map((item) => item.Name)]
    .filter(Boolean).filter((value, index, values) => values.indexOf(value) === index);
  if (hpNames.length || hpProcesses.length) {
    conflicts.push({
      level: 'warning',
      title: 'Обнаружен сетевой фильтр HP',
      detail: `${hpNames.slice(0, 5).join(', ') || hpProcesses.map((item) => item.Name).slice(0, 5).join(', ')}. Он может мешать перехвату пакетов WinDivert; приложение не отключает защиту автоматически.`
    });
  } else if (isHp) {
    conflicts.push({ level: 'warning', title: 'Обнаружен ноутбук HP', detail: `${computerName}. Рекомендуется профиль «HP / совместимость» без TCP timestamps.` });
  }

  const guard = system.DeviceGuard || {};
  const runningGuardServices = Array.isArray(guard.Running) ? guard.Running.map(Number) : (guard.Running === undefined ? [] : [Number(guard.Running)]);
  if (isHp && (Number(guard.VbsStatus) === 2 || runningGuardServices.includes(2))) {
    conflicts.push({ level: 'warning', title: 'Активна изоляция ядра Windows', detail: 'HVCI/VBS работает одновременно с защитой HP. Это не доказывает блокировку, но при ошибке драйвера нужно проверить журнал целостности кода.' });
  }

  const codeIntegrity = Array.isArray(system.CodeIntegrity) ? system.CodeIntegrity : (system.CodeIntegrity ? [system.CodeIntegrity] : []);
  if (codeIntegrity.length) {
    conflicts.push({ level: 'error', title: 'Windows блокировал WinDivert', detail: `В журнале целостности кода найдено событий: ${codeIntegrity.length}. Последнее: ${codeIntegrity[0].Message || `событие ${codeIntegrity[0].Id}`}` });
  }
  return conflicts;
}

function classifyDiagnostics(target, evidence, system, engineRunning) {
  const controlsOk = evidence.controls.some((item) => item.ok && item.status > 0 && item.status < 500);
  const adapters = Array.isArray(system.Adapters) ? system.Adapters : (system.Adapters ? [system.Adapters] : []);
  if (!controlsOk) {
    return adapters.length
      ? { code: 'provider', level: 'error', title: 'Нет стабильного доступа в интернет', confidence: 'высокая', detail: 'Сетевой адаптер подключён, но контрольные сайты не отвечают. Возможен сбой маршрута, подключения у провайдера или работа VPN/фильтра.', advice: 'Проверьте другие сайты, перезапустите роутер и временно отключите сторонний VPN или сетевой фильтр.' }
      : { code: 'local-network', level: 'error', title: 'Нет активного сетевого подключения', confidence: 'высокая', detail: 'Windows не показывает активный сетевой адаптер с доступом.', advice: 'Подключитесь к Wi‑Fi или кабелю и повторите диагностику.' };
  }
  if (!evidence.systemDns.ok && evidence.publicDns.ok) {
    return { code: 'dns', level: 'error', title: 'Проблема DNS', confidence: 'высокая', detail: 'Публичный защищённый DNS видит домен, а системный DNS Windows — нет. Возможны подмена DNS провайдером или некорректные локальные настройки.', advice: 'Включите профиль «Защищённый DNS» и повторите проверку.' };
  }
  if (!evidence.systemDns.ok && !evidence.publicDns.ok) {
    return { code: 'dns-or-domain', level: 'error', title: 'Домен не разрешается', confidence: 'средняя', detail: 'Домен не найден ни системным DNS, ни контрольным публичным DoH.', advice: 'Повторите тест позже: возможен сбой DNS или самого домена.' };
  }
  if (!evidence.tcp.ok) {
    return { code: 'ip-filter', level: 'warning', title: 'Не устанавливается соединение с адресом сервиса', confidence: 'средняя', detail: 'DNS работает, общий интернет доступен, но TCP-подключение к сервису не создаётся. Возможны фильтрация IP/ТСПУ, проблема маршрута у провайдера или сбой самого сервиса.', advice: 'Запустите обход и повторите тест. Если результат не изменится, проблема может быть на маршруте или у сервиса.' };
  }
  if (!evidence.tls.ok) {
    return { code: 'dpi', level: 'warning', title: 'Вероятна фильтрация TLS/SNI через DPI или ТСПУ', confidence: 'средняя', detail: `TCP-соединение установлено, но защищённое TLS-соединение оборвалось: ${evidence.tls.error || 'ошибка handshake'}. Это характерный, но не абсолютный признак DPI.`, advice: 'Включите Zapret или запустите автоподбор стратегии и повторите диагностику.' };
  }
  if (evidence.https.blockPage || [451].includes(evidence.https.status)) {
    return { code: 'block-page', level: 'warning', title: 'Получена страница ограничения доступа', confidence: 'высокая', detail: `Сервис или промежуточный фильтр вернул HTTP ${evidence.https.status}.`, advice: 'Попробуйте другую стратегию обхода. Код 451 также может возвращать сам сервис по юридическим причинам.' };
  }
  if ([401, 403].includes(evidence.https.status)) {
    return { code: 'service-policy', level: 'warning', title: 'Сервис доступен, но отклонил запрос', confidence: 'средняя', detail: `TLS работает, сервер ответил HTTP ${evidence.https.status}. Вероятнее ограничение региона, аккаунта, антибот-защита или правила самого сервиса, а не поломка DNS.`, advice: 'Проверьте сервис в браузере. Обычный DNS не всегда может изменить регион, а Zapret не скрывает внешний IP.' };
  }
  if (!evidence.https.ok) {
    return { code: 'https-filter', level: 'warning', title: 'HTTPS обрывается после подключения', confidence: 'средняя', detail: `DNS, TCP и TLS прошли, но запрос завершился ошибкой: ${evidence.https.error || 'нет ответа'}. Возможны фильтрация ответа, нестабильная сеть или сбой сервиса.`, advice: 'Повторите тест с обходом и без него и сравните результат.' };
  }
  return {
    code: 'available', level: 'good', title: `${target.label} доступен`, confidence: 'высокая',
    detail: engineRunning ? 'Сервис отвечает при активной стратегии Zapret.' : 'DNS, TCP, TLS и HTTPS работают без активного обхода.',
    advice: engineRunning ? 'Чтобы понять, нужен ли обход, остановите его вручную и повторите диагностику.' : 'Дополнительные действия не требуются.'
  };
}

async function runNetworkDiagnostics(targetId, engineRunning) {
  const target = DIAGNOSTIC_TARGETS[targetId];
  if (!target) throw new Error('неизвестный сервис для диагностики');
  const system = collectSystemSignals();
  const [systemDns, publicDns, ...controls] = await Promise.all([
    resolveWithSystem(target.host),
    resolveWithPublicDoh(target.host),
    probeHttps('www.gstatic.com', '/generate_204', 5500),
    probeHttps('www.microsoft.com', '/', 5500)
  ]);
  const address = systemDns.addresses && systemDns.addresses[0];
  const tcp = address ? await probeTcp(address) : { ok: false, error: 'нет IP-адреса', ms: 0 };
  const tlsResult = tcp.ok ? await probeTls(address, target.host) : { ok: false, error: 'TCP недоступен', ms: 0 };
  const httpsResult = tlsResult.ok ? await probeHttps(target.host, target.path) : { ok: false, error: 'TLS недоступен', ms: 0 };
  const evidence = { systemDns, publicDns, controls, tcp, tls: tlsResult, https: httpsResult };
  return {
    target: { id: targetId, label: target.label, host: target.host },
    diagnosis: classifyDiagnostics(target, evidence, system, !!engineRunning),
    evidence,
    system,
    conflicts: buildConflictList(system, !!engineRunning),
    dns: getDohStatus(),
    checkedAt: new Date().toISOString()
  };
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
    { label: 'Настройки DNS', click: () => { showMainWindow(); sendTrayAction('show-dns'); } },
    { label: 'Telegram-прокси', click: () => { showMainWindow(); sendTrayAction('show-telegram'); } },
    { label: 'Диагностика и обновления', click: () => { showMainWindow(); sendTrayAction('show-system'); } },
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
    if (previewMode) throw new Error('Установка обновлений недоступна в режиме предпросмотра');
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
      rollback: readUpdaterState().previousRelease || null,
      preview: previewMode
    });
    publishTgWsStatus();
  });

  // Прячем в трей при нажатии на крестик
  mainWindow.on('close', function (event) {
    if (!app.isQuiting && !previewMode && !testInstanceMode) {
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

  if (!previewMode && !testInstanceMode) cleanupStaleTgWsProxy();

  if (!previewMode) {
    try { await recoverDohState(); }
    catch (error) { dohStats.lastError = `Ошибка восстановления DNS: ${error.message}`; }
  }

  const shouldAutostart = process.argv.includes('--autostart');
  createWindow()

  if (shouldAutostart) {
    mainWindow.webContents.on('did-finish-load', () => {
      mainWindow.webContents.send('do-autostart');
    });
  }

  if (!previewMode) {
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
  }
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
ipcMain.handle('tg-ws:get-status', () => getTgWsStatus());
ipcMain.handle('tg-ws:start', async () => {
  try { return { ok: true, status: await startTgWsProxy() }; }
  catch (error) { tgWsLastError = error.message; return { ok: false, error: error.message, status: await getTgWsStatus() }; }
});
ipcMain.handle('tg-ws:stop', async () => {
  try { return { ok: true, status: await stopTgWsProxy() }; }
  catch (error) { return { ok: false, error: error.message, status: await getTgWsStatus() }; }
});
ipcMain.handle('tg-ws:connect', async () => {
  try {
    const status = await getTgWsStatus();
    if (!status.running) throw new Error('Сначала запустите локальный прокси');
    const secret = ensureTgWsState().secret;
    const url = `tg://proxy?server=${encodeURIComponent(status.host)}&port=${status.port}&secret=${encodeURIComponent(`dd${secret}`)}`;
    const launchMethod = await openTelegramProxyLink(url);
    tgWsConnectRequestedAt = Date.now();
    setTimeout(publishTgWsStatus, 12000);
    return { ok: true, launchMethod, status: await getTgWsStatus() };
  } catch (error) {
    return { ok: false, error: error.message, status: await getTgWsStatus() };
  }
});
ipcMain.handle('diagnostics:run', async (_event, request) => {
  try {
    const target = request && request.target ? String(request.target) : 'youtube';
    const engineRunning = !!(request && request.engineRunning);
    return { ok: true, result: await runNetworkDiagnostics(target, engineRunning) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('diagnostics:compatibility', () => {
  try {
    const system = collectSystemSignals();
    return { ok: true, system, conflicts: buildConflictList(system, false) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('doh:set-enabled', async (_event, request) => {
  try {
    if (previewMode) throw new Error('В режиме предпросмотра DNS не изменяется');
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
  stopTgWsProxySync();
  globalShortcut.unregisterAll();
  if (!previewMode) cleanupEngine(); // Не трогаем рабочий экземпляр из окна предпросмотра.
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
