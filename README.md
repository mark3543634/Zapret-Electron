# Zapret Pro

Минималистичный GUI для обхода интернет-блокировок на Windows.  
Обёртка над [winws](https://github.com/bol-van/zapret) с пиксельным интерфейсом.

## Возможности

- **11 стратегий обхода** — Комбо (TG + YouTube + Discord + Roblox) и Универсалы 1–10
- **Автоподбор** — тестирует все стратегии и выбирает лучшую
- **Watchdog** — автоматически перезапускает движок при падении
- **Пинг-монитор** — показывает задержку до YouTube и Discord в реальном времени
- **Таймер работы** — время с момента запуска движка
- **Автозапуск** — запись в реестр HKCU Run
- **Тихий старт** — при автозагрузке окно не появляется, только иконка в трее
- **Глобальный хоткей** — `Ctrl+Shift+Z` для старт/стоп без открытия окна
- **История автоподбора** — запоминает лучшую стратегию с последнего теста

## Установка

Скачайте последний `ZapretPro-Setup-vX.X.exe` из [Releases](../../releases) и запустите.  
Требуются права администратора (запрашиваются автоматически).

## Запуск из исходников

```bash
git clone https://github.com/YOUR_USERNAME/ZapretPro.git
cd ZapretPro
npm install
npm start
```

## Сборка установщика

1. Установите [Inno Setup 6](https://jrsoftware.org/isdl.php)
2. Установите [electron-packager](https://github.com/electron/packager): `npm install -g electron-packager`
3. Соберите пакет: `electron-packager . ZapretPro --platform=win32 --arch=x64 --out=out`
4. Скомпилируйте `setup.iss` через Inno Setup

## Благодарности

- [bol-van/zapret](https://github.com/bol-van/zapret) — движок обхода DPI (winws.exe)
- [basil00/WinDivert](https://github.com/basil00/WinDivert) — перехват сетевого трафика

## Лицензия

MIT
