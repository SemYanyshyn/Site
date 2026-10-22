export interface PublicUser {
  id: string;
  username: string;
  role: 'user' | 'admin';
  createdAt: string;
}

export interface AuthCredentials {
  username: string;
  password: string;
}

export interface AuthResponse {
  user: PublicUser;
}

export interface ApiErrorResponse {
  code: string;
  message: string;
}

export const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,32}$/;
export const PASSWORD_MIN_LENGTH = 15;
export const PASSWORD_MAX_LENGTH = 128;

export function validateCredentials(
  input: unknown,
): { ok: true; value: AuthCredentials } | { ok: false; message: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, message: 'Передайте логін і пароль.' };
  }
  const values = input as Record<string, unknown>;
  if (Object.keys(values).some((key) => key !== 'username' && key !== 'password')) {
    return { ok: false, message: 'Дозволені лише поля логіна та пароля.' };
  }
  if (typeof values.username !== 'string' || typeof values.password !== 'string') {
    return { ok: false, message: 'Логін і пароль мають бути текстом.' };
  }
  const enteredUsername = values.username.trim();
  if (!USERNAME_PATTERN.test(enteredUsername)) {
    return { ok: false, message: 'Логін: 3–32 латинські літери, цифри, «_» або «-».' };
  }
  const passwordLength = [...values.password].length;
  if ([...values.password].some((symbol) => {
    const code = symbol.codePointAt(0)!;
    return code >= 0xd800 && code <= 0xdfff;
  })) {
    return { ok: false, message: 'Пароль має містити коректні символи Unicode.' };
  }
  if (passwordLength < PASSWORD_MIN_LENGTH || passwordLength > PASSWORD_MAX_LENGTH) {
    return { ok: false, message: 'Пароль має містити від 15 до 128 символів; пробіли враховуються.' };
  }
  return { ok: true, value: { username: enteredUsername.toLowerCase(), password: values.password } };
}
