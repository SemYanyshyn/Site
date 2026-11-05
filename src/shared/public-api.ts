// Тут перевіряю публічну базову адресу API з налаштувань збірки frontend
// Це спільна утиліта без прив’язки до DOM браузера чи підключення до бази

// Пам’ятаю, що цей URL потрапляє в публічну збірку, тому паролі й токени тут не зберігаю
// Порожнє значення залишаю порожнім, тоді клієнт використовує адресу свого сайту
// Для заданої адреси вимагаю HTTPS origin без шляху, параметрів, fragment і облікових даних
export function normalizeApiBase(value: string | undefined): string {
  if (value === undefined || value === '') return '';
  try {
    const url = new URL(value);
    // Відхиляю перелічені локальні імена й loopback-адреси, непридатні для віддаленого користувача
    // Ця перевірка формату не виконує DNS-запит і не доводить доступність зовнішнього сервера
    const host = url.hostname.toLowerCase();
    if (value !== value.trim() || url.protocol !== 'https:' || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash || host === 'localhost' || host.endsWith('.localhost')
      || host.endsWith('.local') || host === '[::1]' || host === '0.0.0.0' || /^127\./u.test(host)) throw new Error();
    // Повертаю нормалізований origin, до якого клієнт додасть шлях /api
    return url.origin;
  } catch {
    // Не повторюю введений URL у помилці, бо до нього могли випадково вставити секрет
    throw new Error('VITE_API_BASE_URL має бути публічним HTTPS origin без шляху, параметрів або облікових даних.');
  }
}
