# Сторонние компоненты Zapret Electron 7.2

Компоненты запускаются только после ручного включения обхода или DNS. Одновременно работает один движок обхода. Перед запуском приложение сверяет SHA-256 исполняемых файлов, а системный прокси и DNS восстанавливаются при штатном и аварийном завершении.

| Компонент | Версия | Назначение | Лицензия | SHA-256 исполняемого файла |
| --- | --- | --- | --- | --- |
| ByeDPI (`ciadpi.exe`) | 0.17.3 | Локальный SOCKS-прокси без WinDivert | MIT | `EB53CEEEB981CC6735AC24BB1E51E725280B86630E80FDF19DDC4EE4A5B54EF4` |
| DPIBreak (`dpibreak.exe`) | 0.6.2 | Системная фрагментация TLS/HTTPS | GPL-3.0-or-later | `AF825BC9A30B3455501D4B115DCB2662370F692BBF6B753FB65A653F9653CA5B` |
| GoodbyeDPI (`goodbyedpi.exe`) | 0.2.2 | Совместимый системный DPI-движок | Apache-2.0 | `331AC6C1D22BA5A0A217F3F27D0D823051869CAFC8B8EF7F2002FA2ACCEBC74E` |
| AdGuard dnsproxy (`dnsproxy.exe`) | 0.84.2 | Локальный защищённый DNS, кэш и резервы | Apache-2.0 | `284DC4B1220015F827EB1FBAA91587CA7D631DCBDBF67B361E49377522FC3236` |
| GreenTunnel | 3.0.5 | Локальный HTTP(S)-прокси и TLS-фрагментация | MIT | CLI: `1E6F77E82BC906E86B918FD672133A8B5B5B611AD834159C4F83A1205F5215EC` |
| Node.js runtime | 24.21.0 | Изолированный официальный runtime для GreenTunnel | MIT и лицензии зависимостей | `BA4E6D110E8C1592A1ECD390F6B05F3DA124B13871A5BE62B341A07A853C6C32` |

Исходники и лицензии:

- https://github.com/hufrea/byedpi
- https://github.com/dilluti0n/DPIBreak
- https://github.com/ValdikSS/GoodbyeDPI
- https://github.com/AdguardTeam/dnsproxy
- https://github.com/SadeghHayeri/GreenTunnel
- https://nodejs.org/

Копии лицензий и README лежат рядом с соответствующими файлами в `vendor/`. GreenTunnel и его npm-зависимости поставляются в исходном виде вместе с метаданными пакетов; полный текст лицензии Node.js находится в `vendor/green-tunnel/runtime/LICENSE`.
