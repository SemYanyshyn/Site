-- Створюю таблицю користувачів: один рядок — один обліковий запис.
CREATE TABLE users (
  -- Використовую UUID як унікальний ідентифікатор користувача.
  id uuid PRIMARY KEY,
  username text NOT NULL,
  -- Зберігаю логін у нижньому регістрі й забороняю дублікати через UNIQUE.
  normalized_username text NOT NULL UNIQUE,
  -- Зберігаю хеш пароля; самого пароля в цій таблиці немає.
  password_hash text NOT NULL,
  -- Новому користувачу призначаю роль user; дозволені тільки user та admin.
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- На рівні БД перевіряю формат логіна та відповідність його нормалізованому значенню.
  CONSTRAINT users_username_format CHECK (username ~ '^[A-Za-z0-9_-]{3,32}$'),
  CONSTRAINT users_normalized_username CHECK (normalized_username = lower(username))
);

-- Створюю таблицю сесій, щоб вхід працював через будь-який сервер застосунку.
CREATE TABLE sessions (
  -- Ключем сесії роблю хеш токена з cookie, а не відкритий токен.
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  -- Пов’язую сесію з користувачем; ON DELETE CASCADE прибирає його сесії після видалення облікового запису.
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Задаю строк дії сесії; обмеження нижче вимагає, щоб він був пізніше часу створення.
  expires_at timestamptz NOT NULL,
  CONSTRAINT sessions_expiry CHECK (expires_at > created_at)
);

-- Додаю індекси для пошуку сесій користувача та прострочених сесій.
CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);
