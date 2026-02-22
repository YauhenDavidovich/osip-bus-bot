# Osip Bus Bot

Телеграм-бот для навигации по расписанию автобусов Осиповичей (будние дни) с выбором остановки.

## Что умеет
- Показывает список остановок кнопками
- Выводит расписание по выбранной остановке
- Ищет остановки через `/find`
- Принимает голосовые сообщения (распознаёт речь в текст)
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
# optional: для голосового ввода
OPENAI_API_KEY=YOUR_OPENAI_API_KEY
STT_MODEL=gpt-4o-mini-transcribe
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
