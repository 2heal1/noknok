import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, lstatSync } from "node:fs";

// Only date/allowlisted metric/numeric count cross this worker boundary.
const path: string = workerData.path;
let db: DatabaseSync;
try {
  if (
    existsSync(path) &&
    (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
  )
    throw new Error();
  db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec(`PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; PRAGMA busy_timeout=100;
    CREATE TABLE IF NOT EXISTS daily(day TEXT NOT NULL, metric TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(day,metric));
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  db.prepare("INSERT OR IGNORE INTO meta VALUES (?,?)").run(
    "startedAt",
    new Date().toISOString()
  );
  parentPort!.on("message", ({ batch }) => {
    try {
      db.exec("BEGIN");
      const insert = db.prepare(
        "INSERT INTO daily VALUES (?,?,?) ON CONFLICT(day,metric) DO UPDATE SET count=count+excluded.count"
      );
      for (const [day, metric, count] of batch) insert.run(day, metric, count);
      const cutoff = new Date(Date.now() - 179 * 86400000)
        .toISOString()
        .slice(0, 10);
      db.prepare("DELETE FROM daily WHERE day<?").run(cutoff);
      db.exec("COMMIT");
      parentPort!.postMessage({
        rows: db
          .prepare("SELECT day,metric,count FROM daily ORDER BY day")
          .all(),
        startedAt: db
          .prepare("SELECT value FROM meta WHERE key=?")
          .get("startedAt")!.value,
      });
    } catch {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* May have failed before BEGIN. */
      }
      parentPort!.postMessage({ error: true });
    }
  });
  parentPort!.postMessage({ ready: true });
} catch {
  parentPort!.postMessage({ error: true });
}
