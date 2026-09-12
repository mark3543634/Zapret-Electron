const rcedit = require('rcedit');
const path = require('path');
const packageJson = require('./package.json');

const buildDir = process.env.ZAPRET_BUILD_DIR || 'out';
const exePath = path.join(__dirname, buildDir, 'ZapretPro-win32-x64', 'Zapret Electron.exe');
const appVersion = packageJson.version;

rcedit(exePath, {
  'requested-execution-level': 'requireAdministrator',
  'file-version': appVersion,
  'product-version': appVersion,
  'version-string': {
    ProductName: 'Zapret Electron',
    FileDescription: 'Обход DPI-блокировок, отдельный DNS, диагностика сети и безопасные обновления',
    CompanyName: 'ZapretPro'
  }
})
  .then(() => console.log('OK: версия и requireAdministrator вшиты в ' + exePath))
  .catch((error) => {
    console.error('Ошибка вшивания ресурсов:', error);
    process.exit(1);
  });
