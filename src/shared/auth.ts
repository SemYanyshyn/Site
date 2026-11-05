// Тут узгоджую між браузером і сервером дані користувача, входу та помилок API
// Спільна функція перевіряє логін і пароль, але не виконує вхід і не звертається до бази

// Віддаю клієнту лише публічні дані користувача, без пароля та його хешу
// Роль user або admin описує дані відповіді, а права сервер перевіряє сам
export interface PublicUser {
  id: string;
  username: string;
  role: 'user' | 'admin';
  createdAt: string;
}

// Описую введені дані входу чи реєстрації, їх передаю захищеним HTTPS-з’єднанням
// Пароль у цьому об’єкті ще не є хешем, хешування робить backend
export interface AuthCredentials {
  username: string;
  password: string;
}

// Домовляюся, що успішна відповідь із користувачем має поле user
export interface AuthResponse {
  user: PublicUser;
}

// Для помилки передаю стабільний код і зрозуміле користувачу повідомлення
export interface ApiErrorResponse {
  code: string;
  message: string;
}

// Задаю однакові межі логіна й пароля для клієнта та сервера
// Регулярний вираз дозволяє 3–32 латинські літери, цифри, підкреслення або дефіс
export const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,32}$/;
export const PASSWORD_MIN_LENGTH = 15;
export const PASSWORD_MAX_LENGTH = 128;

// На вході беру unknown, бо JSON ще не можна вважати перевіреним AuthCredentials
// Повертаю ok=true з нормалізованими даними або ok=false з повідомленням без винятку
export function validateCredentials(
  input: unknown,
): { ok: true; value: AuthCredentials } | { ok: false; message: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, message: 'Передайте логін і пароль.' };
  }
  const values = input as Record<string, unknown>;
  // Дозволяю тільки username і password, роль admin через цю форму передати не можна
  if (Object.keys(values).some((key) => key !== 'username' && key !== 'password')) {
    return { ok: false, message: 'Дозволені лише поля логіна та пароля.' };
  }
  if (typeof values.username !== 'string' || typeof values.password !== 'string') {
    return { ok: false, message: 'Логін і пароль мають бути текстом.' };
  }
  // Прибираю пробіли лише з країв логіна, сам пароль не обрізаю
  const enteredUsername = values.username.trim();
  if (!USERNAME_PATTERN.test(enteredUsername)) {
    return { ok: false, message: 'Логін: 3–32 латинські літери, цифри, «_» або «-».' };
  }
  // Рахую Unicode-кодові точки через spread, а не UTF-16 одиниці звичайного length
  // Окремо відхиляю непарні сурогати, пробіли в паролі враховую як символи
  const passwordSymbols = [...values.password];
  const passwordLength = passwordSymbols.length;
  if (passwordSymbols.some((symbol) => {
    const code = symbol.codePointAt(0)!;
    return code >= 0xd800 && code <= 0xdfff;
  })) {
    return { ok: false, message: 'Пароль має містити коректні символи Unicode.' };
  }
  if (passwordLength < PASSWORD_MIN_LENGTH || passwordLength > PASSWORD_MAX_LENGTH) {
    return { ok: false, message: 'Пароль має містити від 15 до 128 символів; пробіли враховуються.' };
  }
  // Нормалізую логін до нижнього регістру, щоб регістр не створював різні імена
  return { ok: true, value: { username: enteredUsername.toLowerCase(), password: values.password } };
}
