// Під час npm run build копіюю SQL-файли з migrations у dist/migrations
// Зібраний runner шукає міграції біля готового JavaScript, тому самих файлів .js для запуску недостатньо
// Цей скрипт лише копіює файли, він не підключається до PostgreSQL і не застосовує SQL

import { cpSync } from 'node:fs';

// Визначаю обидві папки відносно файлу скрипта й рекурсивно переношу їхній вміст
// Копіюю повні SQL-файли разом із коментарями, не змінюючи їхні контрольні суми
cpSync(new URL('../migrations/', import.meta.url), new URL('../dist/migrations/', import.meta.url), { recursive: true });
