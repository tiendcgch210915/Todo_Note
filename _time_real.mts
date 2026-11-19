process.env.TURSO_DATABASE_URL = "file::memory:";
process.env.TURSO_AUTH_TOKEN = "";
const { turso } = await import("./src/config/db.ts");
const { getChangesSince, getSyncCursorTime } = await import("./src/repositories/sync.repo.ts");
const { applyAllMigrations } = await import("./tests/helpers/migrations.ts");
await applyAllMigrations(turso);
const OLD = "2026-01-01T00:00:00.000Z";
for (const u of ["u", "v"]) await turso.execute({ sql: "INSERT INTO users(id,email,password_hash,created_at,updated_at) VALUES(?,?,?,?,?)", args: [u, `${u}@t`, "x", OLD, OLD] });
const bulk = async (sqlFor: (user: string, i: number) => { sql: string; args: any[] }, n: number) => {
  for (const user of ["u", "v"]) for (let off = 0; off < n; off += 1000) {
    const stmts = []; for (let i = off; i < off + 1000; i++) stmts.push(sqlFor(user, i));
    await turso.batch(stmts, "write");
  }
};
await bulk((u, i) => ({ sql: "INSERT INTO todos(id,user_id,title,created_at,updated_at) VALUES(?,?,?,?,?)", args: [`${u}-${i}`, u, "t", OLD, OLD] }), 30000);
for (const u of ["u", "v"]) {
  await turso.execute({ sql: "INSERT INTO habits(id,user_id,title,frequency_type,target_per_period,start_date,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)", args: [`h-${u}`, u, "H", "daily", 1, "2026-01-01", OLD, OLD] });
  await turso.execute({ sql: "INSERT INTO checklist_templates(id,user_id,title,is_system,times_used,sort_order,created_at,updated_at) VALUES(?,?,?,0,0,0,?,?)", args: [`tpl-${u}`, u, "T", OLD, OLD] });
}
await bulk((u, i) => ({ sql: "INSERT INTO habit_logs(id,habit_id,log_date,completed,created_at,updated_at) VALUES(?,?,?,?,?,?)", args: [`${u}-log-${i}`, `h-${u}`, `d${i}`, 1, OLD, OLD] }), 30000);
await bulk((u, i) => ({ sql: "INSERT INTO checklist_template_items(id,template_id,position,title,is_required,created_at,updated_at) VALUES(?,?,?,?,0,?,?)", args: [`${u}-item-${i}`, `tpl-${u}`, i, "s", OLD, OLD] }), 5000);
await turso.execute("UPDATE sync_stamps SET synced_at = '2026-01-01T00:00:00.000Z'");
for (let i = 0; i < 5; i++) await turso.execute({ sql: "UPDATE todos SET title = 'x' WHERE id = ?", args: [`u-${i}`] });
for (let i = 0; i < 5; i++) await turso.execute({ sql: "UPDATE habit_logs SET completed = 0 WHERE id = ?", args: [`u-log-${i}`] });
for (let i = 0; i < 5; i++) await turso.execute({ sql: "UPDATE checklist_template_items SET title = 'y' WHERE id = ?", args: [`u-item-${i}`] });

const since = new Date(Date.now() - 60_000).toISOString();
const time = async (label: string, since: string | null, reps = 10) => {
  let res: any; const t0 = performance.now();
  for (let i = 0; i < reps; i++) res = await getChangesSince("u", since);
  console.log(label.padEnd(34), ((performance.now() - t0) / reps).toFixed(1).padStart(7), "ms | todos", res.todos.length, "logs", res.habit_logs.length, "items", res.checklist_template_items.length);
};
await time("delta (5+5+5 changed of 60k+60k+10k)", since);
await time("delta, nothing changed", new Date(Date.now() + 60_000).toISOString());
await time("initial pull (everything alive)", null, 3);
console.log("cursor", await getSyncCursorTime());
