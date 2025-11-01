import { sql } from '@vercel/postgres';

export default async function handler(req, res) {
  try {
    await sql`create table if not exists characters(
      id serial primary key,
      name text not null unique,
      description text not null,
      password_hash text,   -- bcrypt 해시
      elo int not null default 1000,
      wins int not null default 0,
      losses int not null default 0,
      created_at timestamptz not null default now()
    );`;

    await sql`create table if not exists battles(
      id serial primary key,
      a_id int not null references characters(id) on delete cascade,
      b_id int not null references characters(id) on delete cascade,
      winner_id int null references characters(id) on delete set null,
      reason text not null,
      log_json text not null,
      created_at timestamptz not null default now()
    );`;

    /* 동일 쌍 재대결 금지 (무순서 쌍 유니크) */
    await sql`create index if not exists idx_battles_created_at on battles(created_at desc)`;
    await sql`create unique index if not exists idx_battles_pair_unique
      on battles (least(a_id,b_id), greatest(a_id,b_id))`;

    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
}
