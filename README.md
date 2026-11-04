# Context Pilot

[Сайт и установка](https://yevgenevic.github.io/context-pilot/)

Context Pilot помогает продолжить работу в новой сессии ИИ. В локальном дашборде видно, что сделал предыдущий агент, какие файлы изменились и какие проверки прошли.

## Установка

Понадобятся Git и Node.js 22.18 или новее с npm.

```sh
npm install -g https://github.com/yevgenevic/context-pilot/releases/download/v0.1.3/context-pilot-0.1.3.tgz
```

В папке своего Git-проекта выполните

```sh
pilot init
pilot dashboard
```

Откройте адрес из терминала. Команда `pilot doctor` покажет, какие CLI доступны и выполнен ли вход. Для автоматического запуска задач нужен авторизованный Codex CLI. Для продолжения работы вручную в Claude Code скачайте задание во вкладке «Передача».

[Выпуски Context Pilot](https://github.com/yevgenevic/context-pilot/releases)

## Запуск из исходников

Из корня клона установите зависимости дашборда, соберите его и запустите тесты.

```sh
npm --prefix ui ci
npm --prefix ui run build
npm test
```

Команда `npm link` в корне клона добавляет локальную версию `pilot` в терминал. Затем в своём Git-проекте выполните `pilot init` и `pilot dashboard`.

Исходники CLI находятся в [src/](src/), интерфейса — в [ui/](ui/), тесты — в [test/](test/). Чтобы собрать установочный пакет, выполните `npm run release:tgz`. Готовый файл появится в `site/download/`.
