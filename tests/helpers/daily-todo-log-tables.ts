type TestDb = {
  execute: (statement: string | { sql: string; args?: unknown[] }) => Promise<unknown>;
};

export const createDailyTodoLogTables = async (db: TestDb): Promise<void> => {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS habits (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      icon TEXT,
      color TEXT NOT NULL DEFAULT '#4CAF50',
      frequency_type TEXT NOT NULL DEFAULT 'daily',
      target_per_period INTEGER NOT NULL DEFAULT 1,
      active_weekdays TEXT,
      start_date TEXT NOT NULL,
      end_date TEXT,
      current_streak INTEGER NOT NULL DEFAULT 0,
      longest_streak INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
      updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
      deleted_at TEXT
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS habit_logs (
      id TEXT PRIMARY KEY,
      habit_id TEXT NOT NULL,
      log_date TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
      updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
      deleted_at TEXT
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS daily_todo_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      log_date TEXT NOT NULL,
      todo_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT,
      scheduled_date TEXT,
      time TEXT,
      due_at TEXT,
      is_important INTEGER,
      is_urgent INTEGER,
      is_frog INTEGER NOT NULL DEFAULT 0,
      frog_date TEXT,
      estimated_minutes INTEGER,
      actual_minutes INTEGER,
      position INTEGER NOT NULL DEFAULT 0,
      todo_created_at TEXT NOT NULL,
      todo_updated_at TEXT NOT NULL,
      logged_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await db.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_todo_logs_user_date_todo
      ON daily_todo_logs(user_id, log_date, todo_id)
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS daily_todo_summaries (
      user_id TEXT NOT NULL,
      log_date TEXT NOT NULL,
      total_todos INTEGER NOT NULL DEFAULT 0,
      done_todos INTEGER NOT NULL DEFAULT 0,
      score INTEGER NOT NULL DEFAULT 0,
      closed_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, log_date)
    )
  `);
};

export const clearDailyTodoLogTables = async (db: TestDb): Promise<void> => {
  await db.execute("DELETE FROM daily_todo_logs");
  await db.execute("DELETE FROM daily_todo_summaries");
};
