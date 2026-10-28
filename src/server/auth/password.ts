import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const PARAMETERS = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 } as const;
const KEY_LENGTH = 64;

// Promise представляє майбутній результат scrypt а resolve або reject завершують його з ключем або помилкою
function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, PARAMETERS, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

// async повертає Promise а await чекає ключ тут не блокуючи обробку інших запитів сервером
// випадкова salt дає різні хеші для однакових паролів а сам пароль у БД не записую
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt);
  return `scrypt$v1$32768$8$3$67108864$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (
    parts.length !== 8 || parts.slice(0, 6).join('$') !== 'scrypt$v1$32768$8$3$67108864' ||
    !/^[a-f0-9]{32}$/.test(parts[6] ?? '') || !/^[a-f0-9]{128}$/.test(parts[7] ?? '')
  ) return false;
  const salt = Buffer.from(parts[6]!, 'hex');
  const expected = Buffer.from(parts[7]!, 'hex');
  const actual = await deriveKey(password, salt);
  // порівнюю ключі без раннього виходу на першому відмінному байті
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
