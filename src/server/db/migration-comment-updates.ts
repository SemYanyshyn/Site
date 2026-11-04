// Тут зберігаю точні пари старого й нового SHA-256 для погоджених правок лише коментарів міграцій
// Це вузький виняток для конкретних файлів, а не дозвіл довільно міняти вже застосований SQL

// Сумісність лише для чотирьох перевірених змін коментарів від 04.11.2026
// Тут фіксую точні SHA256 до і після; довільні зміни SQL або коментарів не ігноруються
export const MIGRATION_COMMENT_UPDATES: Readonly<Record<string, { before: string; after: string }>> = {
  "001_auth": {
    "before": "d624523d1c1f777145deda434061be9595bf01fd66d01c50a24063e080e4cf59",
    "after": "39c5e3ed5cda9569eb81cb03358d4efe892fa8502eb61ebabbd7dc068b80835a"
  },
  "002_jobs": {
    "before": "68a7ca14ad727d456cfe1d866f7a6b2e1d187d168e8d28c3b2e19aa360bf5bf7",
    "after": "0eca8dd9247a228799b6ddeb40ce86e3c8b30d097d05c2f68a3cefb23ad6ec65"
  },
  "003_executor_registry": {
    "before": "b840c3e93c00c7cc8298ab7f1bbf58d22952a1e1f6a7abb0d63fe4abd5720ced",
    "after": "7848212e59754cf014cd7a510617cd087bcefec2959e9f6d774bacab2def67f0"
  },
  "004_executor_metadata": {
    "before": "636477fc39d9030e78b44ff685fd5bd037db39b2b78ee390b929a83a6379ee01",
    "after": "7f9b9e46598f1905252e8fc744a5c477baec8d1b1bff1c6127868e10873a335c"
  }
};

// Дозволяю розбіжність лише коли збіглися версія та обидва зафіксовані хеші
// Невідому зміну міграції цей механізм не пропускає
export function isDocumentedMigrationCommentUpdate(version: string, previous: string, current: string): boolean {
  const update = MIGRATION_COMMENT_UPDATES[version];
  return Boolean(update && previous === update.before && current === update.after);
}
