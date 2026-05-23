const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, globalShortcut } = require('electron')
const path = require('path')
const fs = require('fs')
const { execSync, spawnSync } = require('child_process')

let mainWindow;
let tray = null;

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
  spawnSync('powershell', [
    '-NoProfile', '-WindowStyle', 'Hidden', '-Command',
    `Start-Process -FilePath '${exePath}' ${argList}-WorkingDirectory '${workDir}' -Verb RunAs`
  ], { windowsHide: true });
  process.exit(0);
}

const emptyIcon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=');

// === ФУНКЦИЯ ЗАЧИСТКИ ЗОМБИ-ПРОЦЕССОВ ===
function cleanupEngine() {
    try { execSync("taskkill /F /IM winws.exe /T", { stdio: 'ignore', windowsHide: true }); } catch(e){}
    try { execSync("sc stop WinDivert", { stdio: 'ignore', windowsHide: true }); } catch(e){}
    try { execSync("sc delete WinDivert", { stdio: 'ignore', windowsHide: true }); } catch(e){}
}

function createWindow () {
  const startMinimized = process.argv.includes('--autostart');

  let windowIcon;
  if (fs.existsSync(path.join(__dirname, 'icon.png'))) {
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

  // Прячем в трей при нажатии на крестик
  mainWindow.on('close', function (event) {
    if (!app.isQuiting) {
      event.preventDefault(); 
      mainWindow.hide();      
    }
  });
}

app.whenReady().then(() => {
  createWindow()

  tray = new Tray(emptyIcon);
  
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Развернуть Zapret Pro', click: () => { mainWindow.show(); } },
    { type: 'separator' },
    { label: 'Полный выход', click: () => {
        app.isQuiting = true;
        cleanupEngine(); // <-- УБИВАЕМ ПРОЦЕССЫ ПРИ НАЖАТИИ КНОПКИ ВЫХОДА
        if (tray) tray.destroy(); 
        app.quit();
      }
    }
  ])

  tray.setToolTip('Zapret Pro: Загрузка...')
  tray.setContextMenu(contextMenu)

  globalShortcut.register('Ctrl+Shift+Z', () => {
    mainWindow.webContents.send('hotkey-toggle');
  });

  tray.on('click', () => {
    if (mainWindow.isVisible()) { mainWindow.hide(); }
    else { mainWindow.show(); mainWindow.focus(); }
  })

  tray.on('double-click', () => {
    mainWindow.show();
    mainWindow.focus();
  })
})

ipcMain.on('update-tray', (event, data) => {
  if (!tray) return;
  const img = nativeImage.createFromDataURL(data.imgBase64);
  tray.setImage(img);
  tray.setToolTip(data.tooltip);
});

// Глобальный перехватчик: перед тем как программа умрет, делаем контрольный выстрел
app.on('before-quit', () => {
  globalShortcut.unregisterAll();
  cleanupEngine(); // <-- УБИВАЕМ ПРОЦЕССЫ, ЕСЛИ ПРОГРАММА ЗАКРЫЛАСЬ ИНАЧЕ (например, перезагрузка ПК)
  if (tray) {
      tray.destroy();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})