import crypto from "node:crypto";
import postgres from "postgres";

let client;
let schemaPromise;

export class AppError extends Error {
  status: number;
  code: string;

  constructor(status, message, code = "request_error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function db() {
  if (!process.env.DATABASE_URL) {
    throw new AppError(503, "服务器尚未配置DATABASE_URL", "database_not_configured");
  }
  if (!client) {
    client = postgres(process.env.DATABASE_URL, {
      max: 3,
      idle_timeout: 20,
      connect_timeout: 15,
      prepare: false,
      ssl: process.env.DATABASE_URL.includes("sslmode=disable") ? false : "require"
    });
  }
  return client;
}

export async function ensureSchema() {
  if (!schemaPromise) schemaPromise = initialize().catch((error) => { schemaPromise = undefined; throw error; });
  return schemaPromise;
}

async function initialize() {
  const sql = db();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS activities (
      id SERIAL PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','paused','ended')),
      starts_at TIMESTAMPTZ,
      ends_at TIMESTAMPTZ,
      reward_mode TEXT NOT NULL DEFAULT 'numeric' CHECK(reward_mode IN ('numeric','options','single')),
      reward_unit TEXT NOT NULL DEFAULT '活动代币',
      code_capacity INTEGER NOT NULL DEFAULT 10 CHECK(code_capacity BETWEEN 1 AND 100),
      daily_claim_browser INTEGER NOT NULL DEFAULT 2 CHECK(daily_claim_browser BETWEEN 1 AND 100),
      daily_submit_browser INTEGER NOT NULL DEFAULT 3 CHECK(daily_submit_browser BETWEEN 1 AND 100),
      daily_submit_ip INTEGER NOT NULL DEFAULT 30 CHECK(daily_submit_ip BETWEEN 1 AND 1000),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tiers (
      id SERIAL PRIMARY KEY,
      activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      min_value DOUBLE PRECISION,
      max_value DOUBLE PRECISION,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS reward_options (
      id SERIAL PRIMARY KEY,
      activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
      tier_id INTEGER REFERENCES tiers(id) ON DELETE SET NULL,
      label TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS scopes (
      id SERIAL PRIMARY KEY,
      activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS codes (
      id SERIAL PRIMARY KEY,
      activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
      code_value TEXT,
      code_hash TEXT NOT NULL,
      reward_value DOUBLE PRECISION,
      reward_option_id INTEGER REFERENCES reward_options(id) ON DELETE SET NULL,
      tier_id INTEGER REFERENCES tiers(id) ON DELETE SET NULL,
      scope_id INTEGER REFERENCES scopes(id) ON DELETE SET NULL,
      remaining INTEGER NOT NULL,
      capacity INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','verified','paused','withdrawn','exhausted','expired')),
      owner_token_hash TEXT NOT NULL,
      submitter_visitor_hash TEXT NOT NULL,
      submitter_ip_hash TEXT NOT NULL,
      success_reports INTEGER NOT NULL DEFAULT 0,
      failure_reports INTEGER NOT NULL DEFAULT 0,
      mismatch_reports INTEGER NOT NULL DEFAULT 0,
      last_success_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(activity_id, code_hash)
    );

    CREATE TABLE IF NOT EXISTS claims (
      id SERIAL PRIMARY KEY,
      code_id INTEGER NOT NULL REFERENCES codes(id) ON DELETE CASCADE,
      visitor_hash TEXT NOT NULL,
      ip_hash TEXT NOT NULL,
      claim_token_hash TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','confirmed','cancelled','released')),
      feedback TEXT CHECK(feedback IN ('success','invalid','mismatch')),
      reserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      confirmed_at TIMESTAMPTZ,
      feedback_at TIMESTAMPTZ,
      UNIQUE(code_id, visitor_hash)
    );

    CREATE TABLE IF NOT EXISTS admin_sessions (
      token_hash TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_codes_pool ON codes(activity_id,tier_id,scope_id,status,remaining);
    CREATE INDEX IF NOT EXISTS idx_codes_submitter_day ON codes(activity_id,submitter_visitor_hash,created_at);
    CREATE INDEX IF NOT EXISTS idx_claims_visitor_day ON claims(visitor_hash,confirmed_at);
  `);

  const defaults = {
    site_name: "峡谷口令互助",
    site_notice: "非官方玩家互助工具，与腾讯及《王者荣耀》官方无关联；口令有效性以游戏内结果为准。",
    terms: "我确认口令来源合法、填写信息真实，并同意平台的匿名互助规则。",
    claim_notice: "口令可能因站外领取而提前失效，实际结果以游戏内为准。",
    sponsor_enabled: false,
    sponsor_title: "赞助作者",
    sponsor_text: "如果这个小工具帮到了你，可以自愿赞助它继续维护。",
    sponsor_qr: "",
    secret: crypto.randomBytes(32).toString("hex")
  };
  for (const [key, value] of Object.entries(defaults)) {
    await sql`INSERT INTO settings ${sql({ key, value: sql.json(value) }, "key", "value")} ON CONFLICT (key) DO NOTHING`;
  }

  const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM activities`;
  if (!count) {
    await sql.begin(async (tx) => {
      const [activity] = await tx`
        INSERT INTO activities (slug,title,summary,description,status,starts_at,ends_at,reward_mode,reward_unit)
        VALUES ('farm-demo','农活口令互助（演示）','一个尚未发布的演示活动，可在后台修改配置。',
                '选择奖励档位后，系统会自动分配仍有次数的口令。','draft',
                '2026-08-17T00:00:00+08:00','2026-08-19T23:59:59+08:00','numeric','活动代币')
        RETURNING id`;
      await tx`INSERT INTO tiers (activity_id,name,min_value,max_value,sort_order) VALUES
        (${activity.id},'普通',0,299,0),(${activity.id},'较高',300,599,1),(${activity.id},'稀有',600,NULL,2)`;
      await tx`INSERT INTO scopes (activity_id,label,sort_order) VALUES
        (${activity.id},'微信区',0),(${activity.id},'QQ区',1)`;
    });
  }
}

export async function cleanup(sql = db()) {
  await sql.begin(async (tx) => {
    await tx`
      WITH released AS (
        UPDATE claims SET state='released'
        WHERE state='reserved' AND expires_at < NOW()
        RETURNING code_id
      ), counts AS (
        SELECT code_id,COUNT(*)::int AS amount FROM released GROUP BY code_id
      )
      UPDATE codes c SET
        remaining=LEAST(c.capacity,c.remaining+counts.amount),
        status=CASE WHEN c.status='exhausted' THEN 'pending' ELSE c.status END,
        updated_at=NOW()
      FROM counts
      WHERE c.id=counts.code_id AND c.status IN ('pending','verified','exhausted')`;
    const ended = await tx`
      UPDATE activities SET status='ended',updated_at=NOW()
      WHERE status='published' AND ends_at IS NOT NULL AND ends_at<NOW()
      RETURNING id`;
    if (ended.length) {
      const ids = ended.map((item) => item.id);
      await tx`UPDATE codes SET status='expired',updated_at=NOW()
        WHERE activity_id IN ${tx(ids)} AND status IN ('pending','verified','paused','exhausted')`;
    }
    await tx`UPDATE codes SET code_value=NULL,updated_at=NOW()
      WHERE code_value IS NOT NULL AND activity_id IN (
        SELECT id FROM activities WHERE status='ended' AND ends_at IS NOT NULL AND ends_at<NOW()-INTERVAL '30 days'
      )`;
    await tx`DELETE FROM admin_sessions WHERE expires_at<NOW()`;
  });
}

export async function setting(key, fallback = null, sql = db()) {
  const rows = await sql`SELECT value FROM settings WHERE key=${key}`;
  return rows.length ? rows[0].value : fallback;
}

export async function publicSettings(sql = db()) {
  const keys = ["site_name","site_notice","terms","claim_notice","sponsor_enabled","sponsor_title","sponsor_text","sponsor_qr"];
  const rows = await sql`SELECT key,value FROM settings WHERE key IN ${sql(keys)}`;
  const values = Object.fromEntries(rows.map((row) => [row.key,row.value]));
  return Object.fromEntries(keys.map((key) => [key,values[key] ?? null]));
}

export async function hashValue(value, sql = db()) {
  const secret = await setting("secret", "local-secret", sql);
  return crypto.createHmac("sha256", String(secret)).update(value).digest("hex");
}

export function token(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function normalizeCode(value) {
  return String(value || "").replace(/\s+/g, "").toUpperCase();
}

export function dayStartShanghai() {
  const day = 24 * 60 * 60 * 1000;
  const offset = 8 * 60 * 60 * 1000;
  return new Date(Math.floor((Date.now() + offset) / day) * day - offset);
}
