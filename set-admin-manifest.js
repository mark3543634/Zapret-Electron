const rcedit = require('rcedit');
const path = require('path');

const exePath = path.join(__dirname, 'out', 'ZapretPro-win32-x64', 'ZapretPro.exe');

rcedit(exePath, { 'requested-execution-level': 'requireAdministrator' }, function(err) {
  if (err) { console.error('Ошибка вшивания манифеста:', err); process.exit(1); }
  console.log('OK: requireAdministrator вшит в ' + exePath);
});
