import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';

const hours = n => n * 3600_000;
const sessionLifetime = hours(24 * 7);
export const identifier = () => randomBytes(12).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');

export async function createStore(connectionString, schema = 'public') {
  if (!connectionString && !process.env.PGHOST) throw new Error('请设置 DATABASE_URL 或 PostgreSQL 的 PGHOST 等连接变量');
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error('数据库 schema 名称无效');
  const pool = new pg.Pool({ connectionString, options: '-c search_path=' + schema, max: 8, connectionTimeoutMillis: 5000 });
  pool.on('error', error => console.error('Database connection error:', error.code ?? error.name));
  const first = async (sql, params) => (await pool.query(sql, params)).rows[0];
  try {
    if (schema !== 'public') await pool.query('CREATE SCHEMA IF NOT EXISTS ' + schema);
    await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE, username TEXT NOT NULL, salt TEXT NOT NULL,
      password_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), expires_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS challenges (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      shapes TEXT NOT NULL, position INTEGER NOT NULL, expires_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
      prompt TEXT NOT NULL, html TEXT NOT NULL, checks TEXT NOT NULL, source TEXT NOT NULL, created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS projects_owner_date ON projects(owner, created_at DESC);
    `);
    await pool.query('DELETE FROM sessions WHERE expires_at <= $1', [Date.now()]);
    await pool.query('DELETE FROM challenges WHERE expires_at <= $1', [Date.now()]);
  } catch (error) {
    await pool.end();
    throw error;
  }

  async function session(token) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token ?? '')) return undefined;
    return first(`SELECT sessions.id, sessions.user_id, users.username
      FROM sessions LEFT JOIN users ON users.id = sessions.user_id
      WHERE sessions.id = $1 AND sessions.expires_at > $2`, [hash(token), Date.now()]);
  }
  async function newSession(userId, previous) {
    const token = randomBytes(32).toString('base64url');
    const id = hash(token);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO sessions VALUES ($1, $2, $3)', [id, userId ?? null, Date.now() + sessionLifetime]);
      if (previous && userId) {
        if (!previous.user_id) {
          await client.query('UPDATE projects SET owner = $1 WHERE owner = $2', ['account:' + userId, 'guest:' + previous.id]);
        }
        await client.query('DELETE FROM sessions WHERE id = $1', [previous.id]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return { token, session: await session(token) };
  }
  const findProject = id => first('SELECT * FROM projects WHERE id = $1', [id]);
  async function saveProject(project, owner, prompt, id = identifier()) {
    const row = await first(`INSERT INTO projects VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT(id) DO NOTHING RETURNING *`, [
      id, owner, project.kind, project.title, project.description, prompt,
      project.html, JSON.stringify(project.checks), project.source, Date.now()
    ]);
    return row ?? await findProject(id);
  }
  async function challenge(current, shapes, position) {
    const id = identifier();
    await pool.query('DELETE FROM challenges WHERE expires_at <= $1', [Date.now()]);
    await pool.query('INSERT INTO challenges VALUES ($1, $2, $3, $4, $5)',
      [id, current.id, JSON.stringify(shapes), position, Date.now() + 180_000]);
    return id;
  }
  return {
    session, newSession, saveProject, challenge,
    close: () => pool.end(),
    logout: current => current && pool.query('DELETE FROM sessions WHERE id = $1', [current.id]),
    user: handle => first('SELECT * FROM users WHERE handle = $1', [handle]),
    addUser: async (handle, username, salt, passwordHash) => {
      const id = identifier();
      await pool.query('INSERT INTO users VALUES ($1, $2, $3, $4, $5)', [id, handle, username, salt, passwordHash]);
      return id;
    },
    project: findProject,
    projects: async owner => (await pool.query(
      'SELECT * FROM projects WHERE owner = $1 ORDER BY created_at DESC, id DESC LIMIT 30', [owner])).rows,
    getChallenge: (id, current) => first(
      'SELECT * FROM challenges WHERE id = $1 AND session_id = $2 AND expires_at > $3', [id, current.id, Date.now()]),
    consumeChallenge: async (id, current, index) => {
      const found = await first('DELETE FROM challenges WHERE id = $1 AND session_id = $2 RETURNING *', [id, current.id]);
      return found && found.expires_at > Date.now() && found.position === index;
    }
  };
}
