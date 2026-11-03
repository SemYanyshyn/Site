// Пояснення _comment у шаблоні потрібні лише для читання людиною.
// Перед створенням кластера повертаю звичайні налаштування kind без цих полів.
export function kindConfigWithoutNotes(value) {
  if (Array.isArray(value)) return value.map(kindConfigWithoutNotes);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/^_comment(?:_|$)/u.test(key))
      .map(([key, item]) => [key, kindConfigWithoutNotes(item)]));
  }
  return value;
}
