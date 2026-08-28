const rcedit = require('rcedit');
const path = require('path');

const exePath = path.join(__dirname, 'out', 'ZapretPro-win32-x64', 'Zapret Electron.exe');

rcedit(exePath, {
  'requested-execution-level': 'requireAdministrator',
  'file-version': '6.7.0',
  'product-version': '6.7.0',
  'version-string': {
    ProductName: 'Zapret Electron',
    FileDescription: 'GUI для обхода DPI-блокировок и подключения Telegram через актуальные прокси',
    CompanyName: 'ZapretPro'
  }
})
  .then(() => console.log('OK: версия и requireAdministrator вшиты в ' + exePath))
  .catch((error) => {
    console.error('Ошибка вшивания ресурсов:', error);
    process.exit(1);
  });
