# Osip Bus Bot

Телеграм-бот для навигации по расписанию автобусов Осиповичей (будние дни) с выбором остановки.

## Что умеет
- Показывает список остановок кнопками
- Выводит расписание по выбранной остановке
- Ищет остановки через `/find`
- Показывает источник и дату обновления

## Источник данных
- https://www.news-osip.by/raspisanie-transporta/avtobusy-budnie-dni

## Установка
```bash
npm install
npm run scrape
```

Создай `.env`:
```env
BOT_TOKEN=YOUR_TELEGRAM_BOT_TOKEN
```

Запуск:
```bash
npm start
```

## Команды
- `/start`
- `/stops`
- `/find <остановка>`

## Обновление данных
```bash
npm run scrape
```
После этого в чате нажми `🔄 Обновить данные`.
