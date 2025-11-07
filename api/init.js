import { sql } from '@vercel/postgres';
import bcrypt from 'bcryptjs';

export default async function handler(req, res) {
  try {
    // users: 관리자 계정 테이블
    await sql`create table if not exists users(
      id serial primary key,
      name text not null unique,
      password_hash text not null,
      role text not null default 'admin',
      created_at timestamptz not null default now()
    );`;

    // characters: 캐릭터 테이블 (기본 스키마 생성)
    await sql`create table if not exists characters(
      id serial primary key,
      name text not null unique,
      description text not null,
      password_hash text not null,
      elo int not null default 1000,
      wins int not null default 0,
      losses int not null default 0,
      created_at timestamptz not null default now()
    );`;

    // battles: 전투 기록
    await sql`create table if not exists battles(
      id serial primary key,
      a_id int not null references characters(id) on delete cascade,
      b_id int not null references characters(id) on delete cascade,
      winner_id int null references characters(id) on delete set null,
      reason text not null,
      log_json text not null,
      created_at timestamptz not null default now()
    );`;

    // 인덱스
    await sql`create index if not exists idx_battles_created_at on battles(created_at desc)`;
    await sql`create unique index if not exists idx_battles_pair_unique
      on battles (least(a_id,b_id), greatest(a_id,b_id))`;

    // 🔧 (신규) 연락처 컬럼 추가
    await sql`alter table characters add column if not exists email text`;
    await sql`alter table characters add column if not exists phone text`;

    // 관리자 기본 계정(admin/neuron)
    const adminHash = await bcrypt.hash('neuron', 10);
    await sql`
      insert into users(name, password_hash, role)
      values ('admin', ${adminHash}, 'admin')
      on conflict (name) do nothing;
    `;

    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
}
