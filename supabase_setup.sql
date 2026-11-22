-- 来点刺激的 · 数据库（房间、摇骰子、真心话大冒险、国王游戏）
-- 放在口袋全宇宙 / 圣诞盲盒树同一个 Supabase 项目里，所有表和函数都以 ldc_ 开头，不碰其他数据。
-- 用法：Supabase → SQL Editor → 整段粘贴运行。可以重复运行（不会删数据）。
--
-- 设计：
--   * 没有房主，所有玩家权限相同。房间只能由网站管理员（带管理员钥匙）创建，创建只是生成房间号。
--   * 表都开 RLS 且不给策略：网页的匿名 key 不能直接读写表，只能调用下面的 ldc_ 函数。
--   * 规则全部在服务器执行：骰子点数由服务器随机；揭晓前每个人只能看到自己的点数。
--   * 2026-11-20 起不再投票：每个人自己决定在大厅还是在哪个游戏页面（state.where），
--     只有「在线、而且在这个游戏页面」的人参与这个游戏；所有操作点了就直接执行，并通知其他人。
--     有人在某个游戏里准备好 / 开局时写入 state.invite，其他页面的人会看到「去看看」。
--   * 玩家凭据只存 sha256。
--   * 一个房间的全部进度存在 ldc_rooms.state（jsonb），改动时整行加锁，避免同时点按钮冲突。

-- ---------- 表 ----------
create table if not exists public.ldc_rooms (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code ~ '^[0-9]{6}$'),
  created_by  uuid,
  state       jsonb not null default '{}'::jsonb,
  version     integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.ldc_players (
  id          uuid primary key default gen_random_uuid(),
  room_id     uuid not null references public.ldc_rooms(id) on delete cascade,
  nickname    text not null check (char_length(nickname) between 1 and 12),
  token_hash  text not null,
  seat        integer not null,
  joined_at   timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  left_at     timestamptz
);
create index if not exists ldc_players_room_idx on public.ldc_players (room_id);
create unique index if not exists ldc_players_token_idx on public.ldc_players (room_id, token_hash);

alter table public.ldc_players add column if not exists alias_of uuid references public.ldc_players(id) on delete cascade;

create table if not exists public.ldc_events (
  id          bigserial primary key,
  room_id     uuid not null references public.ldc_rooms(id) on delete cascade,
  player_id   uuid,
  kind        text not null,
  payload     jsonb not null default '{}'::jsonb,
  at          timestamptz not null default now()
);
create index if not exists ldc_events_room_idx on public.ldc_events (room_id, at);

-- 题库（内容在 题库.sql，由 题库/*.csv 生成）
create table if not exists public.ldc_questions (
  id          text primary key,
  game_type   text not null,                 -- truth = 真心话大冒险；以后瞎掰王用 bluff_knowledge / bluff_story
  qtype       text not null,                 -- truth 真心话 / dare 大冒险 / quiz 智力问答
  category    text not null,
  difficulty  integer not null default 1,
  content     text not null,
  answer      text,
  explanation text,
  enabled     boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.ldc_questions add column if not exists hints jsonb;
create index if not exists ldc_questions_pick_idx on public.ldc_questions (game_type, qtype, category) where enabled;
alter table public.ldc_questions enable row level security;
revoke all on public.ldc_questions from anon, authenticated;

-- 网站设置：管理员钥匙只存 sha256（钥匙本身只在你自己手里）
create table if not exists public.ldc_settings (
  key   text primary key,
  value text not null
);
insert into public.ldc_settings (key, value) values ('admin_hash', 'd785779fe7f3f32f48743182bd6b5601b72435053fd3b9a482e6d5061e58e000')
  on conflict (key) do update set value = excluded.value;

alter table public.ldc_settings enable row level security;
alter table public.ldc_rooms   enable row level security;
alter table public.ldc_players enable row level security;
alter table public.ldc_events  enable row level security;
revoke all on public.ldc_rooms, public.ldc_players, public.ldc_events, public.ldc_settings from anon, authenticated;

-- ---------- 内部工具函数 ----------
create or replace function public._ldc_hash(t text) returns text
language sql immutable as $$ select encode(sha256(convert_to(coalesce(t,''), 'UTF8')), 'hex') $$;

create or replace function public._ldc_now_ms() returns bigint
language sql volatile as $$ select (extract(epoch from clock_timestamp()) * 1000)::bigint $$;

create or replace function public._ldc_add(arr jsonb, v text) returns jsonb
language sql immutable as $$
  select case when coalesce(arr,'[]'::jsonb) ? v then coalesce(arr,'[]'::jsonb)
              else coalesce(arr,'[]'::jsonb) || to_jsonb(v) end $$;

create or replace function public._ldc_del(arr jsonb, v text) returns jsonb
language sql immutable as $$
  select coalesce((select jsonb_agg(e) from jsonb_array_elements_text(coalesce(arr,'[]'::jsonb)) e where e <> v), '[]'::jsonb) $$;

-- a 里的每一项都在 b 里
create or replace function public._ldc_subset(a jsonb, b jsonb) returns boolean
language sql immutable as $$
  select not exists (select 1 from jsonb_array_elements_text(coalesce(a,'[]'::jsonb)) e
                     where not (coalesce(b,'[]'::jsonb) ? e)) $$;

-- 在线玩家（20 秒内有心跳、没有离开），按座位顺序
create or replace function public._ldc_online(p_room uuid) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(id::text order by seat), '[]'::jsonb)
  from public.ldc_players
  where room_id = p_room and left_at is null and last_seen > now() - interval '20 seconds' $$;

-- 在线、而且当前在某个游戏页面的人
create or replace function public._ldc_here(st jsonb, online jsonb, g text) returns jsonb
language sql immutable as $$
  select coalesce((select jsonb_agg(e) from jsonb_array_elements_text(coalesce(online, '[]'::jsonb)) e
                   where g is not null and st->'where'->>e = g), '[]'::jsonb) $$;

-- 把在 p_from 页面的人都带到 p_to 页面（摇骰子 ↔ 真心话大冒险 的正常流程）
create or replace function public._ldc_move(st jsonb, p_from text, p_to text) returns jsonb
language sql immutable as $$
  select jsonb_set(st, '{where}', coalesce((select jsonb_object_agg(key, case when value #>> '{}' = p_from then to_jsonb(p_to) else value end)
                                            from jsonb_each(coalesce(st->'where', '{}'::jsonb))), '{}'::jsonb)) $$;

create or replace function public._ldc_dice_init() returns jsonb
language sql immutable as $$
  select '{"phase":"ready","round":0,"ready":[],"participants":[],"done":[],"results":{},"askers":[],"takers":[],"all_same":false,"history":[]}'::jsonb $$;

-- 开新一轮：在线不足 2 人就回到准备阶段
create or replace function public._ldc_dice_new_round(d jsonb, online jsonb) returns jsonb
language sql immutable as $$
  select case when jsonb_array_length(online) < 2
    then d || '{"phase":"ready","ready":[],"participants":[],"done":[],"results":{},"askers":[],"takers":[],"all_same":false}'::jsonb
    else d || jsonb_build_object('phase','rolling','round',coalesce((d->>'round')::int,0)+1,'ready','[]'::jsonb,
                                 'participants',online,'done','[]'::jsonb,'results','{}'::jsonb,
                                 'askers','[]'::jsonb,'takers','[]'::jsonb,'all_same',false)
  end $$;

-- 揭晓：最大点数的人出题，最小点数的人挑战；全员相同就提示重摇
create or replace function public._ldc_dice_reveal(d jsonb) returns jsonb
language plpgsql immutable as $$
declare mx int; mn int; askers jsonb; takers jsonb; same boolean; h jsonb;
begin
  select max((d->'results'->>p)::int), min((d->'results'->>p)::int)
    into mx, mn from jsonb_array_elements_text(d->'participants') p;
  same := (mx = mn);
  if same then askers := '[]'::jsonb; takers := '[]'::jsonb;
  else
    select coalesce(jsonb_agg(p),'[]'::jsonb) into askers from jsonb_array_elements_text(d->'participants') p where (d->'results'->>p)::int = mx;
    select coalesce(jsonb_agg(p),'[]'::jsonb) into takers from jsonb_array_elements_text(d->'participants') p where (d->'results'->>p)::int = mn;
  end if;
  h := jsonb_build_object('round', d->'round', 'results', d->'results', 'askers', askers, 'takers', takers, 'all_same', same);
  return d || jsonb_build_object('phase','reveal','askers',askers,'takers',takers,'all_same',same,
    'history', (select coalesce(jsonb_agg(x),'[]'::jsonb) from (
        select x from jsonb_array_elements(jsonb_build_array(h) || coalesce(d->'history','[]'::jsonb)) with ordinality t(x,i) where i <= 10 order by i) s));
end $$;

-- ---------- 真心话大冒险 ----------
create or replace function public._ldc_truth_init(p_mode text) returns jsonb
language sql immutable as $$
  select jsonb_build_object('mode', p_mode, 'phase', case when p_mode = 'dice' then 'choose' else 'setup' end,
    'order_kind', 'seat', 'order', '[]'::jsonb, 'turn', 0, 'lap', 1, 'askers', '[]'::jsonb, 'takers', '[]'::jsonb,
    'q', null, 'show_answer', false, 'verdict', null, 'timer', 0, 'timer_end', null, 'timer_left', null,
    'last', null, 'count', 0) $$;

create or replace function public._ldc_pick(arr jsonb) returns text
language sql volatile as $$
  select e from jsonb_array_elements_text(coalesce(arr,'[]'::jsonb)) e order by random() limit 1 $$;

create or replace function public._ldc_shuffle(arr jsonb) returns jsonb
language sql volatile as $$
  select coalesce(jsonb_agg(e order by random()), '[]'::jsonb) from jsonb_array_elements_text(coalesce(arr,'[]'::jsonb)) e $$;

create or replace function public._ldc_minus(a jsonb, b jsonb) returns jsonb
language sql immutable as $$
  select coalesce((select jsonb_agg(e) from jsonb_array_elements_text(coalesce(a,'[]'::jsonb)) e
                   where not (coalesce(b,'[]'::jsonb) ? e)), '[]'::jsonb) $$;

-- 本轮挑战的人（轮流 = 当前轮到的人；骰子 = 点数最小的人；自由 = 不指定）
create or replace function public._ldc_t_doers(t jsonb) returns jsonb
language sql immutable as $$
  select case when t->>'mode' = 'turns' and jsonb_array_length(coalesce(t->'order','[]'::jsonb)) > 0
              then jsonb_build_array(t->'order'->((t->>'turn')::int))
              when t->>'mode' = 'dice' then coalesce(t->'takers','[]'::jsonb)
              else '[]'::jsonb end $$;

-- 谁能操作：chooser = 选题 / 换题；doer = 完成 / 跳过。只算在线的人；都不在线（或自由模式）谁都可以
create or replace function public._ldc_t_can(t jsonb, online jsonb, kind text, me text) returns boolean
language sql immutable as $$
  with a as (
    select coalesce((select jsonb_agg(e) from jsonb_array_elements_text(
      case when kind = 'chooser' and t->>'mode' = 'dice' then coalesce(t->'askers','[]'::jsonb) else public._ldc_t_doers(t) end) e
      where online ? e), '[]'::jsonb) as x)
  select jsonb_array_length(x) = 0 or x ? me from a $$;

-- 抽一题：优先抽这个房间没出现过的；{某人} 换成在场另一位玩家，{TA} 是朋友默契里被考的人
create or replace function public._ldc_draw(st jsonb, p_type text, p_cat text, online jsonb) returns jsonb
language plpgsql volatile as $$
declare q public.ldc_questions; t jsonb := st->'truth'; cur text := st->'truth'->'q'->>'id';
        others jsonb; txt text; target text; someone text;
begin
  select * into q from public.ldc_questions
    where enabled and game_type = 'truth' and qtype = p_type and (p_cat is null or category = p_cat)
      and not (coalesce(st->'used_q','[]'::jsonb) ? id) and id is distinct from cur
    order by random() limit 1;
  if not found then
    select * into q from public.ldc_questions
      where enabled and game_type = 'truth' and qtype = p_type and (p_cat is null or category = p_cat) and id is distinct from cur
      order by random() limit 1;
  end if;
  if not found then return null; end if;
  others := public._ldc_minus(online, public._ldc_t_doers(t));
  if jsonb_array_length(others) = 0 then others := online; end if;
  txt := q.content;
  if position('{TA}' in txt) > 0 then
    target := public._ldc_pick(others);
    txt := replace(txt, '{TA}', coalesce((select nickname from public.ldc_players where id::text = target), 'TA'));
  end if;
  if position('{某人}' in txt) > 0 then
    someone := public._ldc_pick(others);
    txt := replace(txt, '{某人}', coalesce((select nickname from public.ldc_players where id::text = someone), '旁边的人'));
  end if;
  return jsonb_build_object('id', q.id, 'type', q.qtype, 'cat', q.category, 'text', txt,
                            'answer', q.answer, 'explain', q.explanation, 'target', target);
end $$;

-- ---------- 瞎掰王 ----------
-- 阶段：setup 设置 → recruit 招募大聪明 → roles 看身份 → choose 大聪明二选一 → think 准备（老实人记答案）
--       → speak 线下讨论（可发警告牌） → guess 指认（1 次） → reveal 揭晓 → final 最终排名
-- 题库 bank：mix 知识题 / story 故事
create or replace function public._ldc_bluff_init() returns jsonb
language sql immutable as $$
  select jsonb_build_object('phase', 'setup', 'bank', 'mix', 'mode', 'knowledge', 'think', 30, 'timer', 180,
    'warn_on', true, 'rounds', 5, 'round', 0, 'settings_order', '[]'::jsonb,
    'players', '[]'::jsonb, 'want', '{}'::jsonb, 'deadline', null, 'smart', null, 'volunteered', false,
    'roles', '{}'::jsonb, 'seen', '[]'::jsonb, 'choices', '[]'::jsonb, 'q', null, 'ready', '[]'::jsonb,
    'order', '[]'::jsonb, 'spoken', '[]'::jsonb, 'cur', null, 'skipped', '[]'::jsonb,
    'warned', '[]'::jsonb, 'warns_left', 0, 'wrong', '[]'::jsonb,
    'pick', null, 'correct', null, 'void', false, 'honest', null, 'delta', '{}'::jsonb,
    'scores', '{}'::jsonb, 'stats', '{}'::jsonb, 'timer_end', null, 'timer_left', null, 'history', '[]'::jsonb,
    'away', '[]'::jsonb, 'away_clock', null) $$;

-- 一轮里要清空的字段
create or replace function public._ldc_bluff_fresh() returns jsonb
language sql immutable as $$
  select jsonb_build_object('roles', '{}'::jsonb, 'seen', '[]'::jsonb, 'choices', '[]'::jsonb, 'q', null, 'ready', '[]'::jsonb,
    'order', '[]'::jsonb, 'spoken', '[]'::jsonb, 'cur', null, 'skipped', '[]'::jsonb, 'warned', '[]'::jsonb, 'wrong', '[]'::jsonb,
    'pick', null, 'correct', null, 'void', false, 'honest', null, 'delta', '{}'::jsonb,
    'timer_end', null, 'timer_left', null, 'away', '[]'::jsonb, 'away_clock', null) $$;

-- 新一轮：从招募大聪明开始（分数、设置、历史保留）
create or replace function public._ldc_bluff_recruit(b jsonb, online jsonb) returns jsonb
language sql volatile as $$
  select b || public._ldc_bluff_fresh() || jsonb_build_object('phase', 'recruit', 'round', coalesce((b->>'round')::int, 0) + 1,
    'players', online, 'want', '{}'::jsonb, 'deadline', public._ldc_now_ms() + 20000, 'smart', null, 'volunteered', false) $$;

-- 分身份：大聪明以外随机一个老实人，其余都是捣蛋鬼；降低上轮老实人再次抽中的权重
create or replace function public._ldc_bluff_assign(b jsonb) returns jsonb
language plpgsql volatile as $$
declare
  others jsonb := public._ldc_minus(b->'players', jsonb_build_array(b->>'smart'));
  previous_honest text := b #>> '{history,0,honest}';
  alternatives jsonb;
  h text;
  n int := jsonb_array_length(b->'players');
begin
  if previous_honest is not null and others ? previous_honest then
    alternatives := public._ldc_minus(others, jsonb_build_array(previous_honest));
    -- 上轮老实人占一份，其他候选人各占四份。
    h := public._ldc_pick(others || alternatives || alternatives || alternatives);
  else
    h := public._ldc_pick(others);
  end if;
  return b || public._ldc_bluff_fresh() || jsonb_build_object('phase', 'roles',
    'roles', (select coalesce(jsonb_object_agg(p, case when p = h then 'honest' else 'bluffer' end), '{}'::jsonb) from jsonb_array_elements_text(others) p),
    'order', public._ldc_shuffle(others),
    'warns_left', case when coalesce((b->>'warn_on')::boolean, true) then (case when n <= 4 then 0 when n <= 8 then 1 else 2 end) else 0 end);
end $$;

create or replace function public._ldc_bluff_draw(st jsonb) returns jsonb
language sql volatile as $$ select null::jsonb $$;   -- 旧函数，已不用

-- 给大聪明的两道候选题（只有题目，不带答案）。这个房间玩过的题（used_q）不再出；p_not 里的（上一批）排最后
create or replace function public._ldc_bluff_two(st jsonb, p_not jsonb) returns jsonb
language sql volatile as $$
  with available as (
    select id, content from public.ldc_questions
    where enabled and game_type = 'bluff'
      and qtype = case when st->'bluff'->>'bank' = 'story' then 'story' else 'knowledge' end
      and not (coalesce(st->'used_q', '[]'::jsonb) ? id)
  ), fixed as (
    select id from available where id = st->>'bluff_next_q'
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'text', content)), '[]'::jsonb) from (
    select id, content from available
    where not exists (select 1 from fixed) or id = (select id from fixed)
    order by coalesce(p_not, '[]'::jsonb) ? id, random() limit 2
  ) z $$;

-- 每人发言秒数：1/2/3 分钟或 0 = 不限时（默认 3 分钟）
create or replace function public._ldc_bluff_secs(b jsonb) returns int
language sql immutable as $$
  select case when (b->>'timer') in ('0', '60', '120', '180') then (b->>'timer')::int else 180 end $$;

-- 准备秒数（30 秒 / 1 分钟 / 2 分钟，默认 30 秒）
create or replace function public._ldc_bluff_think(b jsonb) returns int
language sql immutable as $$
  select case when (b->>'think') in ('30', '60', '120') then (b->>'think')::int else 30 end $$;

-- 旧版本按人结束发言的函数，保留定义供旧迁移使用。
create or replace function public._ldc_bluff_step(b jsonb, now_ms bigint) returns jsonb
language plpgsql volatile as $$
declare sp jsonb := public._ldc_add(coalesce(b->'spoken', '[]'::jsonb), b->>'cur');
begin
  b := b || jsonb_build_object('spoken', sp, 'cur', null, 'timer_end', null, 'timer_left', null);
  return b;
end $$;

-- 大聪明选好的题：进入准备时间，记进已出过的题
create or replace function public._ldc_bluff_begin(st jsonb, p_id text) returns jsonb
language plpgsql volatile as $$
declare q public.ldc_questions; b jsonb := st->'bluff'; now_ms bigint := public._ldc_now_ms();
begin
  select * into q from public.ldc_questions where id = p_id and game_type = 'bluff';
  if not found then return st; end if;
  b := b || jsonb_build_object('q', jsonb_build_object('id', q.id, 'text', q.content, 'answer', q.answer, 'explain', q.explanation,
           'hints', public._ldc_shuffle(q.hints)),
         'choices', '[]'::jsonb, 'phase', 'think', 'ready', '[]'::jsonb, 'spoken', '[]'::jsonb, 'cur', null, 'skipped', '[]'::jsonb,
         'timer_left', null, 'timer_end', now_ms + public._ldc_bluff_think(b) * 1000);
  st := st || jsonb_build_object('used_q', (select coalesce(jsonb_agg(x order by i), '[]'::jsonb) from
          jsonb_array_elements(jsonb_build_array(q.id) || coalesce(st->'used_q', '[]'::jsonb)) with ordinality z(x, i) where i <= 400));
  if st->>'bluff_next_q' = q.id then st := st - 'bluff_next_q'; end if;
  return jsonb_set(st, '{bluff}', b);
end $$;

create or replace function public._ldc_inc(m jsonb, k text, v int) returns jsonb
language sql immutable as $$ select coalesce(m, '{}'::jsonb) || jsonb_build_object(k, coalesce((m->>k)::int, 0) + v) $$;

-- 加一项统计：stats = {玩家: {smart, found, honest, bluffer, picked, warn, warn_hit}}
create or replace function public._ldc_stat(s jsonb, p text, k text, v int) returns jsonb
language sql immutable as $$ select coalesce(s, '{}'::jsonb) || jsonb_build_object(p, public._ldc_inc(coalesce(s->p, '{}'::jsonb), k, v)) $$;

-- 结束一轮：p_pick = 指认的人（作废时为 null）
-- 计分：猜中时 3–6 人 大聪明 +1 / 7 人及以上 +2，老实人 +1；
--       每次指错，被指的捣蛋鬼 +1；警告捣蛋鬼 大聪明 +1、被警告 −1；警告老实人 大聪明 −3、被警告 −1
create or replace function public._ldc_bluff_finish(b jsonb, p_pick text, p_void boolean) returns jsonb
language plpgsql immutable as $$
declare honest text; ok boolean; d jsonb := '{}'::jsonb; sc jsonb := coalesce(b->'scores', '{}'::jsonb); st jsonb := coalesce(b->'stats', '{}'::jsonb);
        wrong jsonb := '[]'::jsonb; sm text := b->>'smart'; n int := jsonb_array_length(b->'players'); w text;
begin
  select key into honest from jsonb_each_text(coalesce(b->'roles', '{}'::jsonb)) where value = 'honest' limit 1;
  ok := (not p_void) and p_pick is not null and p_pick = honest;
  if not p_void then
    if p_pick is not null and not ok then
      wrong := jsonb_build_array(p_pick);
      d := public._ldc_inc(d, p_pick, 1);
      st := public._ldc_stat(st, p_pick, 'picked', 1);
    end if;
    if ok then
      d := public._ldc_inc(d, sm, case when n >= 7 then 2 else 1 end);
      d := public._ldc_inc(d, honest, 1);
      st := public._ldc_stat(st, sm, 'found', 1);
    end if;
    for w in select jsonb_array_elements_text(coalesce(b->'warned', '[]'::jsonb)) loop
      d := public._ldc_inc(d, w, -1);
      d := public._ldc_inc(d, sm, case when w = honest then -3 else 1 end);
      st := public._ldc_stat(st, sm, 'warn', 1);
      if w <> honest then st := public._ldc_stat(st, sm, 'warn_hit', 1); end if;
    end loop;
    st := public._ldc_stat(st, sm, 'smart', 1);
    if honest is not null then st := public._ldc_stat(st, honest, 'honest', 1); end if;
    for w in select key from jsonb_each_text(coalesce(b->'roles', '{}'::jsonb)) where value = 'bluffer' loop
      st := public._ldc_stat(st, w, 'bluffer', 1);
    end loop;
    sc := sc || coalesce((select jsonb_object_agg(k, coalesce((sc->>k)::int, 0) + (d->>k)::int) from jsonb_object_keys(d) k), '{}'::jsonb);
  end if;
  return b || jsonb_build_object('phase', 'reveal', 'away', '[]'::jsonb, 'away_clock', null, 'pick', p_pick, 'correct', ok, 'void', p_void, 'honest', honest, 'wrong', wrong,
    'delta', d, 'scores', sc, 'stats', st, 'cur', null, 'timer_end', null, 'timer_left', null,
    'history', (select coalesce(jsonb_agg(x order by i), '[]'::jsonb) from jsonb_array_elements(
        jsonb_build_array(jsonb_build_object('round', b->'round', 'smart', sm, 'honest', honest, 'pick', p_pick, 'correct', ok,
                                             'void', p_void, 'q', b->'q'->'text', 'delta', d))
        || coalesce(b->'history', '[]'::jsonb)) with ordinality z(x, i) where i <= 20));
end $$;

-- 自动推进：大家都选完（或 20 秒到）就定大聪明；大家都看过身份就给大聪明两道题选；
-- 准备时间到（或都点了准备好）就进入线下讨论。
create or replace function public._ldc_bluff_settle(st jsonb, online jsonb) returns jsonb
language plpgsql volatile as $$
declare b jsonb := st->'bluff'; pon jsonb; vol jsonb; everyone boolean; now_ms bigint := public._ldc_now_ms();
        away jsonb; clock_key text; clock jsonb; present jsonb;
        fixed_honest text; drawn_honest text; smart_pool jsonb; newcomers jsonb; new_roles jsonb;
begin
  if b is null then return st; end if;
  -- 旧版本的房间：换成新规则（保留总分）
  if not (b ? 'bank') then
    b := public._ldc_bluff_init() || jsonb_build_object('scores', coalesce(b->'scores', '{}'::jsonb));
  end if;
  -- 保留当前在场者的进入顺序，新进入者排在末尾。
  select coalesce(jsonb_agg(id order by slot), '[]'::jsonb) into present
    from jsonb_array_elements_text(coalesce(b->'settings_order', '[]'::jsonb)) with ordinality as p(id, slot)
    where online ? id;
  b := b || jsonb_build_object('settings_order', present || public._ldc_minus(online, present));
  -- 升级时已提交过一次指认的旧回合，直接按那次指认结算。
  if b->>'phase' = 'guess' and b->'wrong'->>0 is not null then
    return jsonb_set(st, '{bluff}', public._ldc_bluff_finish(b, b->'wrong'->>0, false));
  end if;
  -- 旧版尚未指认且仍有警告牌的回合，继续等待最后的发牌。
  if b->>'phase' = 'guess' and coalesce((b->>'warns_left')::int, 0) > 0 then
    b := b || '{"phase":"speak"}'::jsonb;
  end if;
  if b->>'phase' = 'speak' then
    b := b || '{"cur":null,"timer_end":null,"timer_left":null,"away_clock":null}'::jsonb;
  end if;
  -- 整轮保留原名单。离开页面或断线时冻结进度，原玩家回来后接着计时。
  if b->>'phase' in ('recruit', 'roles', 'choose', 'think', 'speak', 'guess') then
    newcomers := public._ldc_minus(online, b->'players');
    if jsonb_array_length(newcomers) > 0 then
      b := jsonb_set(b, '{players}', (b->'players') || newcomers);
      if b->>'phase' <> 'recruit' then
        select jsonb_object_agg(id, 'bluffer'::text) into new_roles
          from jsonb_array_elements_text(newcomers) as p(id);
        b := b || jsonb_build_object('roles', (b->'roles') || new_roles, 'order', (b->'order') || newcomers);
        if b->>'phase' = 'guess' then b := b || '{"phase":"speak"}'::jsonb; end if;
      end if;
    end if;
    away := public._ldc_minus(b->'players', online);
    if jsonb_array_length(away) > 0 then
      if jsonb_array_length(coalesce(b->'away', '[]'::jsonb)) = 0 then
        clock_key := case when b->>'phase' = 'recruit' then 'deadline' else 'timer_end' end;
        if jsonb_typeof(b->clock_key) = 'number' then
          b := b || jsonb_build_object(clock_key, null, 'away_clock',
            jsonb_build_object('key', clock_key, 'left', greatest((b->>clock_key)::bigint - now_ms, 1000)));
        end if;
      end if;
      return jsonb_set(st, '{bluff}', b || jsonb_build_object('away', away));
    end if;
    if jsonb_array_length(coalesce(b->'away', '[]'::jsonb)) > 0 then
      clock := b->'away_clock';
      if jsonb_typeof(clock) = 'object' then
        b := b || jsonb_build_object(clock->>'key', now_ms + (clock->>'left')::bigint);
      end if;
      return jsonb_set(st, '{bluff}', b || jsonb_build_object('away', '[]'::jsonb, 'away_clock', null));
    end if;
  end if;
  pon := (select coalesce(jsonb_agg(e), '[]'::jsonb) from jsonb_array_elements_text(coalesce(b->'players', '[]'::jsonb)) e where online ? e);
  if b->>'phase' = 'recruit' then
    select not exists (select 1 from jsonb_array_elements_text(pon) e where not (b->'want' ? e)) into everyone;
    if everyone or now_ms >= (b->>'deadline')::bigint then
      if jsonb_array_length(pon) < 3 then
        b := b || '{"phase":"setup"}'::jsonb;
      else
        fixed_honest := st->>'bluff_next_honest';
        smart_pool := pon;
        if fixed_honest is not null and pon ? fixed_honest then
          smart_pool := public._ldc_minus(pon, jsonb_build_array(fixed_honest));
        else
          fixed_honest := null;
        end if;
        vol := (select coalesce(jsonb_agg(e), '[]'::jsonb) from jsonb_array_elements_text(smart_pool) e where coalesce((b->'want'->>e)::boolean, false));
        b := b || jsonb_build_object('players', pon, 'volunteered', jsonb_array_length(vol) > 0,
               'smart', public._ldc_pick(case when jsonb_array_length(vol) > 0 then vol else smart_pool end));
        b := public._ldc_bluff_assign(b);
        if fixed_honest is not null then
          select key into drawn_honest from jsonb_each_text(b->'roles') where value = 'honest';
          if drawn_honest <> fixed_honest then
            b := jsonb_set(b, '{roles}', (b->'roles') || jsonb_build_object(drawn_honest, 'bluffer', fixed_honest, 'honest'));
          end if;
        end if;
        st := st - 'bluff_next_honest';
      end if;
    end if;
  elsif b->>'phase' = 'roles' then
    if jsonb_array_length(pon) > 0 and public._ldc_subset(pon, b->'seen') then
      b := b || jsonb_build_object('phase', 'choose', 'choices', public._ldc_bluff_two(st, '[]'::jsonb));   -- 空数组 = 这个房间的题玩完了
    end if;
  elsif b->>'phase' = 'think' then
    if (jsonb_array_length(pon) > 0 and public._ldc_subset(pon, b->'ready'))
       or (jsonb_typeof(b->'timer_end') = 'number' and now_ms >= (b->>'timer_end')::bigint) then
      b := b || jsonb_build_object('phase', 'speak', 'cur', null, 'timer_left', null, 'timer_end', null);
    end if;
  end if;
  return jsonb_set(st, '{bluff}', b);
end $$;

-- ---------- 国王游戏 ----------
create or replace function public._ldc_king_setup(p_mode text, p_round int) returns jsonb
language sql immutable as $$
  select jsonb_build_object('phase', 'setup', 'mode', p_mode, 'round', p_round) $$;

create or replace function public._ldc_king_round(k jsonb, p_king text, p_online jsonb, p_advance boolean) returns jsonb
language plpgsql volatile as $$
declare numbers jsonb; numbered jsonb; round_no int := (k->>'round')::int;
begin
  if p_king is null or not (p_online ? p_king) or jsonb_array_length(p_online) < 2 then
    return public._ldc_king_setup(k->>'mode', round_no);
  end if;
  numbered := public._ldc_shuffle(public._ldc_del(p_online, p_king));
  select jsonb_object_agg(id, n) into numbers
    from jsonb_array_elements_text(numbered) with ordinality as t(id, n);
  return jsonb_build_object('phase', 'command', 'mode', k->>'mode',
    'round', round_no + case when p_advance then 1 else 0 end,
    'king', p_king, 'key', gen_random_uuid(), 'numbers', numbers, 'size', jsonb_array_length(numbered));
end $$;

create or replace function public._ldc_king_clear(k jsonb) returns jsonb
language sql volatile as $$
  select (k - 'targets' - 'q' - 'results' - 'show_answer')
    || jsonb_build_object('phase', 'command', 'key', gen_random_uuid()) $$;

create or replace function public._ldc_king_action(st jsonb, online jsonb, me text, action text, a jsonb) returns jsonb
language plpgsql volatile as $$
declare
  k jsonb := st->'king'; selected jsonb := a->'numbers'; targets jsonb;
  q jsonb; txt text; next_king text; eligible jsonb; choice text;
begin
  if st->>'game' is distinct from 'king' or k is null then return '{"error":"no_game"}'; end if;
  if k->>'key' is null or k->>'key' is distinct from a->>'key' then return '{"error":"phase"}'; end if;

  if action = 'k_publish' then
    if k->>'phase' <> 'command' then return '{"error":"phase"}'; end if;
    if k->>'king' <> me then return '{"error":"not_yours"}'; end if;
    if jsonb_typeof(selected) is distinct from 'array' then return '{"error":"king_numbers"}'; end if;
    if jsonb_array_length(selected) = 0 or jsonb_array_length(selected) > (k->>'size')::int
      or exists (select 1 from jsonb_array_elements(selected) n
                 where jsonb_typeof(n) <> 'number' or n::text !~ '^[1-9][0-9]*$')
      or (select count(distinct n) from jsonb_array_elements(selected) n) <> jsonb_array_length(selected)
      then return '{"error":"king_numbers"}';
    end if;
    select coalesce(jsonb_agg(id order by id), '[]'::jsonb) into targets
      from jsonb_each(k->'numbers') as t(id, n) where selected @> jsonb_build_array(n);
    if jsonb_array_length(targets) <> jsonb_array_length(selected) then return '{"error":"king_numbers"}'; end if;
    if not public._ldc_subset(targets, online) then return '{"error":"king_offline"}'; end if;
    choice := a->>'type';
    if choice = 'custom' then
      txt := regexp_replace(a->>'text', '^\s+|\s+$', '', 'g');
      if jsonb_typeof(a->'text') is distinct from 'string' or char_length(txt) not between 1 and 200
        then return '{"error":"king_text"}'; end if;
      q := jsonb_build_object('text', txt);
    elsif choice in ('truth', 'dare', 'quiz') then
      q := public._ldc_draw(st || jsonb_build_object('truth',
        public._ldc_truth_init('dice') || jsonb_build_object('takers', targets)), choice, null, online);
      if q is null then return '{"error":"empty"}'; end if;
      st := jsonb_set(st, '{used_q}', (select coalesce(jsonb_agg(x order by i), '[]'::jsonb) from
              jsonb_array_elements(jsonb_build_array(q->'id') || coalesce(st->'used_q', '[]'::jsonb)) with ordinality z(x, i) where i <= 400));
    else return '{"error":"bad_kind"}';
    end if;
    k := k || jsonb_build_object('phase', 'challenge', 'targets', targets, 'q', q, 'results', '{}'::jsonb, 'show_answer', false);

  elsif action = 'k_answer' then
    if k->>'phase' <> 'challenge' or coalesce(k->'q'->>'answer', '') = '' or (k->>'show_answer')::boolean
      then return '{"error":"phase"}'; end if;
    if k->>'king' <> me and not (k->'targets' ? me) then return '{"error":"not_yours"}'; end if;
    k := k || '{"show_answer":true}'::jsonb;

  elsif action = 'k_result' then
    if k->>'phase' <> 'challenge' or k->'results' ? me then return '{"error":"phase"}'; end if;
    if not (k->'targets' ? me) then return '{"error":"not_yours"}'; end if;
    choice := a->>'result';
    if choice is null or choice not in ('done', 'skip') then return '{"error":"bad_kind"}'; end if;
    k := jsonb_set(k, '{results}', (k->'results') || jsonb_build_object(me, choice));
    if not exists (select 1 from jsonb_array_elements_text(k->'targets') id where not (k->'results' ? id)) then
      if exists (select 1 from jsonb_each_text(k->'results') where value = 'done') then
        k := k || '{"phase":"handover"}'::jsonb;
      else k := public._ldc_king_clear(k);
      end if;
    end if;

  elsif action = 'k_next' then
    if k->>'phase' <> 'handover' then return '{"error":"phase"}'; end if;
    if k->>'king' <> me and ((online ? (k->>'king')) or not (k->'numbers' ? me))
      then return '{"error":"not_yours"}'; end if;
    select coalesce(jsonb_agg(id), '[]'::jsonb) into eligible
      from jsonb_array_elements_text(k->'targets') id where k->'results'->>id = 'done' and online ? id;
    if jsonb_array_length(eligible) = 0 or jsonb_array_length(online) < 2 then return '{"error":"king_offline"}'; end if;
    next_king := case when a->>'player' = 'random' then public._ldc_pick(eligible) else a->>'player' end;
    if next_king is null or not (eligible ? next_king) then return '{"error":"bad_target"}'; end if;
    k := public._ldc_king_round(k, next_king, online, true);
  else return '{"error":"bad_action"}';
  end if;
  return jsonb_build_object('state', jsonb_set(st, '{king}', k));
end $$;

-- 执行一个操作（以前要投票，现在点了就执行）。st->>'game' 是这次操作所属的游戏，online 是在这个游戏页面的在线玩家
create or replace function public._ldc_apply(st jsonb, p jsonb, online jsonb) returns jsonb
language plpgsql volatile as $$
declare k text := p->>'kind'; d jsonb := st->'dice'; t text; tr jsonb := st->'truth'; now_ms bigint := public._ldc_now_ms();
begin
  if k = 'switch_game' then
    st := st || jsonb_build_object('game', p->'payload'->'game', 'paused', false);
    st := st - 'paused_by' - 'king';
    if p->'payload'->>'game' = 'king' then
      st := jsonb_set(st, '{king}', public._ldc_king_setup('secret', 0));
    end if;
    if p->'payload'->>'game' = 'dice' then st := jsonb_set(st, '{dice}', public._ldc_dice_init()); end if;
    if p->'payload'->>'game' = 'truth' then
      st := jsonb_set(st, '{truth}', public._ldc_truth_init('setup') || jsonb_build_object('timer', coalesce((tr->>'timer')::int, 0)));
    end if;
    if p->'payload'->>'game' = 'bluff' then
      -- 换回瞎掰王时保留分数和设置
      st := jsonb_set(st, '{bluff}', public._ldc_bluff_init() || coalesce((select jsonb_object_agg(key, value) from jsonb_each(coalesce(st->'bluff', '{}'::jsonb))
              where key in ('bank', 'mode', 'think', 'timer', 'warn_on', 'rounds', 'settings_order', 'scores', 'stats', 'round', 'history')), '{}'::jsonb));
    end if;
  elsif k = 'resume' then
    st := (st || '{"paused":false}'::jsonb) - 'paused_by' - 'paused_game';
    -- 暂停期间计时器停住，继续时接着倒数
    if tr is not null and jsonb_typeof(tr->'timer_left') = 'number' then
      st := jsonb_set(st, '{truth}', tr || jsonb_build_object('timer_end', now_ms + (tr->>'timer_left')::bigint, 'timer_left', null));
    end if;
    if st->'bluff' is not null and jsonb_typeof(st->'bluff'->'timer_left') = 'number' then
      st := jsonb_set(st, '{bluff}', (st->'bluff') || jsonb_build_object('timer_end', now_ms + (st->'bluff'->>'timer_left')::bigint, 'timer_left', null));
    end if;
  elsif k = 'restart_round' and st->>'game' = 'bluff' then
    st := jsonb_set(st, '{bluff}', (st->'bluff') || public._ldc_bluff_fresh() || jsonb_build_object('phase', 'setup', 'smart', null,
      'round', greatest(0, (st->'bluff'->>'round')::int - case when st->'bluff'->>'phase' = 'recruit' then 1 else 0 end)));
  elsif k = 'bluff_redraw' and st->'bluff' is not null then
    -- 换题：已经有人看过答案，所以身份也重新分（大聪明不变）
    st := jsonb_set(st, '{bluff}', public._ldc_bluff_assign(st->'bluff'));
  elsif k = 'bluff_void' and st->'bluff' is not null then
    st := jsonb_set(st, '{bluff}', public._ldc_bluff_finish(st->'bluff', null, true));
  elsif st->>'game' = 'king' and k = 'king_start' then
    t := p->'payload'->>'player';
    if t = 'random' then t := public._ldc_pick(online); end if;
    st := jsonb_set(st, '{king}', public._ldc_king_round(
      public._ldc_king_setup(p->'payload'->>'mode', (st->'king'->>'round')::int), t, online, true));
  elsif st->>'game' = 'king' and k = 'king_redeal' and st->'king'->>'phase' = 'command'
      and st->'king'->>'key' = p->'payload'->>'key' then
    st := jsonb_set(st, '{king}', public._ldc_king_round(st->'king', st->'king'->>'king', online, false));
  elsif st->>'game' = 'king' and k = 'king_skip' and st->'king'->>'phase' = 'challenge'
      and st->'king'->>'key' = p->'payload'->>'key' then
    st := jsonb_set(st, '{king}', public._ldc_king_clear(st->'king'));
  elsif st->>'game' = 'king' and k = 'restart_round' then
    st := jsonb_set(st, '{king}', public._ldc_king_setup(st->'king'->>'mode', greatest((st->'king'->>'round')::int - 1, 0)));
  elsif k = 'restart_round' and st->>'game' = 'truth' then
    st := jsonb_set(st, '{truth}', public._ldc_truth_init('setup') || jsonb_build_object('timer', coalesce((tr->>'timer')::int, 0)));
  elsif k = 'skip_player' and d is not null then
    t := p->'payload'->>'player';
    d := jsonb_set(d, '{participants}', public._ldc_del(d->'participants', t));
    d := jsonb_set(d, '{results}', (d->'results') - t);
    st := jsonb_set(st, '{dice}', d);
  elsif k = 'restart_round' and d is not null then
    st := jsonb_set(st, '{dice}', public._ldc_dice_new_round(d || jsonb_build_object('round', greatest(coalesce((d->>'round')::int,1)-1,0)), online));
  end if;
  return st;
end $$;

-- 结算：各个游戏的自动推进（只看在这个游戏页面的在线玩家；暂停的游戏不推进）
create or replace function public._ldc_settle(st jsonb, online jsonb, p_room uuid) returns jsonb
language plpgsql volatile as $$
declare d jsonb; here jsonb; need jsonb; pg text := case when coalesce((st->>'paused')::boolean, false) then st->>'paused_game' end;
begin
  if st->'dice' is not null and pg is distinct from 'dice' then
    d := st->'dice'; here := public._ldc_here(st, online, 'dice');
    if d->>'phase' = 'ready' and jsonb_array_length(here) >= 2 and public._ldc_subset(here, d->'ready') then
      d := public._ldc_dice_new_round(d, here);
    elsif d->>'phase' = 'rolling' then
      -- 还要等的人：本轮参与者里，除了「在线但已经去了别的页面」的人
      need := (select coalesce(jsonb_agg(e), '[]'::jsonb) from jsonb_array_elements_text(d->'participants') e
               where not (online ? e) or here ? e);
      if jsonb_array_length(d->'done') = 0 and jsonb_array_length(need) = 0 then
        d := d || '{"phase":"ready","ready":[]}'::jsonb;
      elsif jsonb_array_length(d->'done') > 0 and public._ldc_subset(need, d->'done') then
        d := jsonb_set(d, '{participants}', (select coalesce(jsonb_agg(e), '[]'::jsonb) from jsonb_array_elements_text(d->'participants') e where d->'done' ? e));
        d := public._ldc_dice_reveal(d);
        insert into public.ldc_events (room_id, kind, payload)
          values (p_room, 'dice_reveal', jsonb_build_object('round', d->'round', 'results', d->'results'));
      end if;
    end if;
    st := jsonb_set(st, '{dice}', d);
  end if;
  if st->'bluff' is not null and pg is distinct from 'bluff' then
    st := public._ldc_bluff_settle(st, public._ldc_here(st, online, 'bluff'));
  end if;
  return st;
end $$;

-- 给某个玩家看的房间状态（揭晓前隐藏别人的点数）
-- 谁是卧底：词组按房间轮换，平民词与卧底词沿用原题标注。
create or replace function public._ldc_undercover_pair(used jsonb) returns jsonb
language sql volatile as $$
  select jsonb_build_array(id, civil_word, spy_word) from (values
    (1,'极光','彩虹'), (2,'自信','自恋'), (3,'霓裳羽衣曲','惊鸿舞'), (4,'网课','网恋'),
    (5,'滚滚长江东逝水','大江东去浪淘尽'), (6,'凤求凰','白头吟'),
    (7,'辣椒','芥末'), (8,'御姐','甜妹'), (9,'鲸鱼','海豚'), (10,'婚礼','葬礼'),
    (11,'床','棺材'), (12,'奶粉','骨灰'), (13,'红酒','白酒'), (14,'坐牢','上学'),
    (15,'葱花','腋毛'), (16,'扣篮','猝死'), (17,'痔疮','口腔溃疡'),
    (18,'玩偶','尸体'), (19,'初吻','妈妈'), (20,'口罩','内裤'),
    (21,'蛋挞','痔疮'), (22,'骨科','男科'), (23,'黑丝','秋裤')
  ) as pairs(id, civil_word, spy_word)
  order by (coalesce(used, '[]'::jsonb) ? id::text), random() limit 1
$$;

create or replace function public._ldc_undercover_action(u jsonb, online jsonb, me text, action text, args jsonb) returns jsonb
language plpgsql volatile as $$
declare
  pair jsonb; used jsonb; spies jsonb; alive jsonb;
  candidates jsonb; alternatives jsonb; spy text;
  votes jsonb; leaders jsonb; picked text; spy_count int; civil_count int; winner text;
  whiteboard text; whiteboard_on boolean := coalesce((u->>'whiteboard_on')::boolean,false);
  ballot int := coalesce((u->>'ballot')::int, 0);
begin
  if action = 'u_setup' then
    if u->>'phase' not in ('setup','result') then return '{"error":"phase"}'; end if;
    if jsonb_typeof(args->'whiteboard') is distinct from 'boolean' then return '{"error":"bad_action"}'; end if;
    return jsonb_build_object('state',u || jsonb_build_object('whiteboard_on',args->'whiteboard'));
  end if;

  if action = 'u_start' then
    if u->>'phase' not in ('setup','result') then return '{"error":"phase"}'; end if;
    if jsonb_array_length(online) < 4 then return '{"error":"undercover_people"}'; end if;
    used := coalesce(u->'used', '[]'::jsonb);
    pair := public._ldc_undercover_pair(used);
    if used ? (pair->>0) then used := '[]'::jsonb; end if;
    candidates := online;
    spies := '[]'::jsonb;
    -- 上局卧底占一份签，其余候选人各占四份，已抽中的玩家不再参与本局抽签。
    for i in 1..(case when jsonb_array_length(online) >= 8 then 2 else 1 end) loop
      alternatives := public._ldc_minus(candidates,u->'spies');
      spy := public._ldc_pick(candidates || alternatives || alternatives || alternatives);
      spies := spies || jsonb_build_array(spy);
      candidates := public._ldc_del(candidates,spy);
    end loop;
    if whiteboard_on then whiteboard := public._ldc_pick(candidates); end if;
    return jsonb_build_object('state', jsonb_build_object('phase','discuss','players',online,'alive',online,
      'spies',spies,'spy_count',jsonb_array_length(spies),'round',coalesce((u->>'round')::int,0)+1,
      'whiteboard_on',whiteboard_on,'whiteboard',whiteboard,
      'civil_word',pair->>1,'spy_word',pair->>2,'used',used || jsonb_build_array(pair->>0)));
  end if;

  if action = 'u_reset' then
    if u->>'phase' not in ('discuss','vote') then return '{"error":"phase"}'; end if;
    if me is distinct from online->>0 then return '{"error":"not_yours"}'; end if;
    return jsonb_build_object('state', jsonb_build_object('phase','setup','round',u->'round','used',u->'used',
      'whiteboard_on',whiteboard_on,'spies',u->'spies'));
  end if;

  alive := u->'alive';
  if not coalesce(alive ? me, false) then return '{"error":"not_in_round"}'; end if;
  if action = 'u_open_vote' then
    if u->>'phase' <> 'discuss' then return '{"error":"phase"}'; end if;
    return jsonb_build_object('state', u || jsonb_build_object('phase','vote','ballot',ballot+1,
      'votes','{}'::jsonb,'targets',alive,'runoff',false));
  end if;
  if action <> 'u_vote' then return '{"error":"bad_action"}'; end if;
  if u->>'phase' <> 'vote' or args->>'round' is distinct from u->>'round'
     or args->>'ballot' is distinct from u->>'ballot' then return '{"error":"phase"}'; end if;

  picked := args->>'player';
  if picked is null or picked = me or not (u->'targets' ? picked) then return '{"error":"bad_target"}'; end if;
  votes := u->'votes';
  if votes ? me then return '{"error":"already_voted"}'; end if;
  votes := votes || jsonb_build_object(me,picked);
  u := jsonb_set(u, '{votes}', votes);
  if not (select count(*) = jsonb_array_length(alive) from jsonb_object_keys(votes)) then
    return jsonb_build_object('state', u);
  end if;
  with totals as (
    select target, count(*) as tally from jsonb_each_text(votes) as v(voter,target) group by target
  )
  select jsonb_agg(target order by target) into leaders from totals where tally = (select max(tally) from totals);
  if jsonb_array_length(leaders) > 1 then
    if (u->>'runoff')::boolean then
      u := (u - 'votes' - 'targets' - 'runoff') || '{"phase":"discuss","last_tied":true,"last_out":null}'::jsonb;
    else
      u := u || jsonb_build_object('ballot',ballot+1,'targets',leaders,'votes','{}'::jsonb,'runoff',true);
    end if;
    return jsonb_build_object('state',u);
  end if;

  picked := leaders->>0;
  alive := public._ldc_del(alive,picked);
  select count(*) into spy_count from jsonb_array_elements_text(u->'spies') p(id) where alive ? id;
  civil_count := jsonb_array_length(alive) - spy_count - case when alive ? (u->>'whiteboard') then 1 else 0 end;
  winner := case when spy_count=0 then 'civil' when spy_count >= civil_count then 'spy' end;
  u := (u - 'votes' - 'targets' - 'runoff') || jsonb_build_object('alive',alive,
    'last_out',picked,'last_tied',false,'winner',winner,'phase',case when winner is null then 'discuss' else 'result' end);
  return jsonb_build_object('state',u);
end $$;
revoke all on function public._ldc_undercover_pair(jsonb), public._ldc_undercover_action(jsonb,jsonb,text,text,jsonb) from public, anon, authenticated;

-- 狼人杀：固定七人局。夜间只向有权行动的人公开目标与查验结果。
create or replace function public._ldc_werewolf_finish(w jsonb, next_phase text, shooter text default null) returns jsonb
language plpgsql immutable as $$
declare wolves int; villagers int; gods int; winner text;
begin
  if shooter is not null and jsonb_array_length(w->'alive') > 0 then
    return w || jsonb_build_object('phase','shot','shooter',shooter,'after_shot',next_phase);
  end if;
  select count(*) filter (where value in ('wolf','king')),
         count(*) filter (where value='villager'),
         count(*) filter (where value in ('seer','witch','hunter','guard'))
    into wolves,villagers,gods from jsonb_each_text(w->'roles') where w->'alive' ? key;
  winner := case when wolves=0 then 'good' when villagers=0 or gods=0 then 'wolves' end;
  w := w - 'shooter' - 'after_shot';
  if winner is not null then return w || jsonb_build_object('phase','result','winner',winner); end if;
  if next_phase='guard' then
    return w || jsonb_build_object('phase',case when exists(
      select 1 from jsonb_each_text(w->'roles') where value='guard' and w->'alive' ? key
    ) then 'guard' else 'wolves' end,'night_no',(w->>'night_no')::int+1,'night','{}'::jsonb,'wolf_votes','{}'::jsonb);
  end if;
  return w || jsonb_build_object('phase',next_phase);
end $$;

create or replace function public._ldc_werewolf_action(w jsonb, online jsonb, me text, action text, a jsonb) returns jsonb
language plpgsql volatile as $$
declare
  ph text := w->>'phase'; role text := w->'roles'->>me; pick text := a->>'player';
  alive jsonb := w->'alive'; roles jsonb := w->'roles'; night jsonb := w->'night';
  votes jsonb; leaders jsonb; wolf_ids jsonb; dead jsonb := '[]'::jsonb;
  next_step text; bite text; poison text; shooter text; mode text := a->>'mode';
  ballot int := coalesce((w->>'ballot')::int,0);
begin
  if action='w_start' then
    if ph not in ('setup','result') then return '{"error":"phase"}'; end if;
    if jsonb_array_length(online) <> 7 then return '{"error":"werewolf_people"}'; end if;
    select jsonb_object_agg(id, (array['villager','wolf','king','seer','witch','hunter','guard'])[slot::int])
      into roles from jsonb_array_elements_text(public._ldc_shuffle(online)) with ordinality as p(id,slot);
    return jsonb_build_object('state',jsonb_build_object('phase','guard','game_no',coalesce((w->>'game_no')::int,0)+1,
      'night_no',1,'players',online,'alive',online,'roles',roles,'night','{}'::jsonb,'wolf_votes','{}'::jsonb,
      'antidote',true,'poison_available',true,'checks','[]'::jsonb,'last_dead','[]'::jsonb));
  end if;
  if action='w_reset' then
    if ph in ('setup','result') then return '{"error":"phase"}'; end if;
    if me is distinct from online->>0 then return '{"error":"not_yours"}'; end if;
    return jsonb_build_object('state',jsonb_build_object('phase','setup','game_no',w->'game_no'));
  end if;
  if a->>'game' is distinct from w->>'game_no' then return '{"error":"phase"}'; end if;
  if action='w_shoot' then
    if ph <> 'shot' or a->>'night' is distinct from w->>'night_no' then return '{"error":"phase"}'; end if;
    if me is distinct from w->>'shooter' then return '{"error":"not_yours"}'; end if;
    if pick is not null and not (alive ? pick) then return '{"error":"bad_target"}'; end if;
    if pick is not null then
      w := w || jsonb_build_object('alive',public._ldc_del(alive,pick),'last_dead',(w->'last_dead') || jsonb_build_array(pick));
    end if;
    return jsonb_build_object('state',public._ldc_werewolf_finish(w,w->>'after_shot'));
  end if;
  if not coalesce(alive ? me,false) then return '{"error":"not_in_round"}'; end if;
  if action='w_open_vote' then
    if ph <> 'day' or a->>'night' is distinct from w->>'night_no' then return '{"error":"phase"}'; end if;
    return jsonb_build_object('state',w || jsonb_build_object('phase','vote','votes','{}'::jsonb,
      'targets',alive,'ballot',ballot+1,'runoff',false));
  end if;
  if action='w_vote' then
    if ph <> 'vote' or a->>'ballot' is distinct from w->>'ballot' then return '{"error":"phase"}'; end if;
    if pick is null or pick=me or not (w->'targets' ? pick) then return '{"error":"bad_target"}'; end if;
    votes := w->'votes';
    if votes ? me then return '{"error":"already_voted"}'; end if;
    votes := votes || jsonb_build_object(me,pick);
    w := jsonb_set(w,'{votes}',votes);
    if (select count(*) from jsonb_object_keys(votes)) < jsonb_array_length(alive) then return jsonb_build_object('state',w); end if;
    with totals as (select value, count(*) as tally from jsonb_each_text(votes) group by value)
    select jsonb_agg(value order by value) into leaders from totals where tally=(select max(tally) from totals);
    if jsonb_array_length(leaders)>1 and not (w->>'runoff')::boolean then
      return jsonb_build_object('state',w || jsonb_build_object('ballot',ballot+1,'targets',leaders,'votes','{}'::jsonb,'runoff',true));
    end if;
    w := w - 'votes' - 'targets' - 'runoff';
    if jsonb_array_length(leaders)>1 then
      return jsonb_build_object('state',public._ldc_werewolf_finish(w || '{"last_dead":[],"last_event":"tie"}'::jsonb,'guard'));
    end if;
    pick := leaders->>0;
    shooter := case when roles->>pick in ('hunter','king') then pick end;
    w := w || jsonb_build_object('alive',public._ldc_del(alive,pick),'last_dead',leaders,'last_event','exile');
    return jsonb_build_object('state',public._ldc_werewolf_finish(w,'guard',shooter));
  end if;
  if action <> 'w_night' then return '{"error":"bad_action"}'; end if;
  if a->>'night' is distinct from w->>'night_no' or a->>'step' is distinct from ph
     or ph not in ('guard','wolves','seer','witch') then return '{"error":"phase"}'; end if;
  if (ph='wolves' and role not in ('wolf','king')) or (ph<>'wolves' and role is distinct from ph) then
    return '{"error":"not_yours"}';
  end if;
  if pick is not null and not (alive ? pick) then return '{"error":"bad_target"}'; end if;

  if ph='guard' then
    if pick is not null and pick=w->>'last_guard' then return '{"error":"werewolf_guard_repeat"}'; end if;
    night := night || jsonb_build_object('guarded',pick);
    w := w || jsonb_build_object('last_guard',pick);
  elsif ph='wolves' then
    if pick is not null and roles->>pick in ('wolf','king') then return '{"error":"bad_target"}'; end if;
    votes := (w->'wolf_votes') || jsonb_build_object(me,coalesce(pick,''));
    w := jsonb_set(w,'{wolf_votes}',votes);
    select coalesce(jsonb_agg(key),'[]'::jsonb) into wolf_ids from jsonb_each_text(roles)
      where value in ('wolf','king') and alive ? key;
    if not public._ldc_subset(wolf_ids,(select coalesce(jsonb_agg(key),'[]'::jsonb) from jsonb_object_keys(votes) p(key)))
      or (select count(distinct value) from jsonb_each_text(votes)) <> 1 then
      return jsonb_build_object('state',w);
    end if;
    night := night || jsonb_build_object('bite',pick);
  elsif ph='seer' then
    if pick=me then return '{"error":"bad_target"}'; end if;
    if pick is not null then
      w := jsonb_set(w,'{checks}',(w->'checks') || jsonb_build_array(jsonb_build_object('player',pick,'wolf',roles->>pick in ('wolf','king'))));
    end if;
  else
    bite := night->>'bite';
    if mode='save' then
      if not (w->>'antidote')::boolean or bite is null
        or (bite=me and (w->>'night_no')::int>1) then return '{"error":"werewolf_potion"}'; end if;
      w := w || '{"antidote":false}'::jsonb;
      night := night || '{"saved":true}'::jsonb;
    elsif mode='poison' then
      if not (w->>'poison_available')::boolean or pick is null or pick=me then return '{"error":"werewolf_potion"}'; end if;
      w := w || '{"poison_available":false}'::jsonb;
      night := night || jsonb_build_object('poisoned',pick);
    elsif mode is distinct from 'pass' then return '{"error":"bad_action"}'; end if;
  end if;
  w := jsonb_set(w,'{night}',night);
  for next_step in select step from unnest(array['wolves','seer','witch']) with ordinality as p(step,n)
    where n > case ph when 'guard' then 0 when 'wolves' then 1 when 'seer' then 2 else 3 end order by n
  loop
    if next_step='wolves' or exists(select 1 from jsonb_each_text(roles) where value=next_step and alive ? key) then
      return jsonb_build_object('state',w || jsonb_build_object('phase',next_step));
    end if;
  end loop;

  bite := night->>'bite';
  poison := night->>'poisoned';
  if bite is not null then
    if (bite is not distinct from night->>'guarded') = coalesce((night->>'saved')::boolean,false) then
      dead := public._ldc_add(dead,bite);
      if roles->>bite='hunter' and bite is distinct from poison then shooter := bite; end if;
    end if;
  end if;
  if poison is not null then dead := public._ldc_add(dead,poison); end if;
  w := w || jsonb_build_object('alive',public._ldc_minus(alive,dead),'last_dead',dead,'last_event','dawn');
  return jsonb_build_object('state',public._ldc_werewolf_finish(w,'day',shooter));
end $$;

revoke all on function public._ldc_werewolf_finish(jsonb,text,text), public._ldc_werewolf_action(jsonb,jsonb,text,text,jsonb)
  from public, anon, authenticated;

create or replace function public._ldc_view(p_room uuid, p_me uuid) returns jsonb
language plpgsql stable as $$
declare r public.ldc_rooms; st jsonb; mine jsonb; u jsonb; word text; blank boolean; w jsonb; role text; game_view jsonb;
begin
  select * into r from public.ldc_rooms where id = p_room;
  st := r.state;
  if st->'dice' is not null and st->'dice'->>'phase' <> 'reveal' then
    mine := st->'dice'->'results'->(p_me::text);
    st := jsonb_set(st, '{dice,results}', case when mine is null then '{}'::jsonb else jsonb_build_object(p_me::text, mine) end);
  end if;
  -- 智力问答的答案：有人点「看答案」之前不发给网页
  if jsonb_typeof(st->'truth'->'q') = 'object' and not coalesce((st->'truth'->>'show_answer')::boolean, false) then
    st := jsonb_set(st, '{truth,q}', ((st->'truth'->'q') - 'answer' - 'explain')
            || jsonb_build_object('has_answer', (st->'truth'->'q'->>'answer') is not null));
  end if;
  -- 瞎掰王：揭晓前每个人只看到自己的身份；知识题答案只给老实人
  if st->'bluff' is not null and st->'bluff'->>'phase' not in ('reveal', 'final') then
    mine := st->'bluff'->'roles'->(p_me::text);
    st := jsonb_set(st, '{bluff,roles}', case when mine is null then '{}'::jsonb else jsonb_build_object(p_me::text, mine) end);
    -- 老实人只在思考时间看得到答案（发言时不能看着手机念）
    if jsonb_typeof(st->'bluff'->'q') = 'object' and (mine is null or mine #>> '{}' <> 'honest' or st->'bluff'->>'phase' <> 'think') then
      st := jsonb_set(st, '{bluff,q}', (st->'bluff'->'q') - 'answer' - 'explain');
    end if;
  end if;
  if st->'king'->>'mode' = 'secret' and jsonb_typeof(st->'king'->'numbers') = 'object' then
    mine := st->'king'->'numbers'->(p_me::text);
    st := jsonb_set(st, '{king,numbers}', case when mine is null then '{}'::jsonb else jsonb_build_object(p_me::text, mine) end);
  end if;
  if jsonb_typeof(st->'king'->'q') = 'object' and not coalesce((st->'king'->>'show_answer')::boolean, false) then
    st := jsonb_set(st, '{king,q}', ((st->'king'->'q') - 'answer' - 'explain')
      || jsonb_build_object('has_answer', coalesce(st->'king'->'q'->>'answer', '') <> ''));
  end if;
  u := st->'undercover';
  if u is not null then
    blank := coalesce(u->>'whiteboard' = p_me::text, false);
    if u->'players' ? p_me::text and not blank then
      word := case when u->'spies' ? p_me::text then u->>'spy_word' else u->>'civil_word' end;
    end if;
    u := (u - 'votes' - 'used') || jsonb_build_object('word',word,'blank',blank,
      'voted', coalesce((select jsonb_agg(id) from jsonb_object_keys(u->'votes') p(id)), '[]'::jsonb));
    if u->>'phase' <> 'result' then u := u - 'civil_word' - 'spy_word' - 'spies' - 'whiteboard'; end if;
    st := jsonb_set(st,'{undercover}',u);
  end if;
  w := st->'werewolf';
  if w is not null then
    role := w->'roles'->>p_me::text;
    game_view := w - 'roles' - 'night' - 'wolf_votes' - 'votes' - 'checks' - 'last_guard'
      - 'antidote' - 'poison_available' - 'after_shot';
    game_view := game_view || jsonb_build_object('role',role,'voted',
      coalesce((select jsonb_agg(id) from jsonb_object_keys(w->'votes') p(id)),'[]'::jsonb));
    if w->>'phase'='result' then game_view := game_view || jsonb_build_object('roles',w->'roles'); end if;
    if w->>'phase' in ('guard','wolves','seer','witch') then
      game_view := game_view || '{"phase":"night"}'::jsonb;
      if (w->'alive') ? p_me::text and (role=w->>'phase' or (w->>'phase'='wolves' and role in ('wolf','king'))) then
        game_view := game_view || jsonb_build_object('step',w->>'phase');
      end if;
    end if;
    if role in ('wolf','king') then
      game_view := game_view || jsonb_build_object('team',
        (select jsonb_agg(key) from jsonb_each_text(w->'roles') where value in ('wolf','king')));
      if w->>'phase'='wolves' then game_view := game_view || jsonb_build_object('wolf_votes',w->'wolf_votes'); end if;
    elsif role='seer' then
      game_view := game_view || jsonb_build_object('checks',w->'checks');
    elsif role='guard' then
      game_view := game_view || jsonb_build_object('last_guard',w->'last_guard');
    elsif role='witch' and w->>'phase'='witch' and (w->'alive') ? p_me::text then
      game_view := game_view || jsonb_build_object('antidote',w->'antidote','poison_available',w->'poison_available',
        'bite',case when (w->>'antidote')::boolean then w->'night'->>'bite' end);
    end if;
    st := jsonb_set(st,'{werewolf}',game_view);
  end if;
  st := st - 'used_q' - 'game' - 'proposal' - 'bluff_next_q' - 'bluff_next_honest';
  return jsonb_build_object(
    'ok', true, 'code', r.code, 'me', p_me::text, 'version', r.version, 'now', public._ldc_now_ms(),
    'players', (select coalesce(jsonb_agg(jsonb_build_object('id', id::text, 'name', nickname, 'seat', seat,
                  'online', last_seen > now() - interval '20 seconds') order by seat), '[]'::jsonb)
                from public.ldc_players where room_id = p_room and left_at is null and alias_of is null),
    'alias_names', (select coalesce(jsonb_object_agg(a.id, p.nickname), '{}'::jsonb)
      from public.ldc_players a join public.ldc_players p on p.id = a.alias_of
      where a.room_id = p_room and a.seat <> p.seat),
    'state', st);
end $$;

-- 只有没有占用进行中席位的重名座位才能归并。旧凭据继续指向同一位玩家。
create or replace function public._ldc_merge_names(p_room uuid, st jsonb) returns jsonb
language plpgsql volatile as $$
declare
  reserved jsonb := '[]'::jsonb;
  b jsonb := st->'bluff'; k jsonb := st->'king'; t jsonb := st->'truth'; d jsonb := st->'dice'; u jsonb := st->'undercover'; w jsonb := st->'werewolf';
  duplicate record; item record; stats jsonb; scores jsonb;
begin
  if not exists (select 1 from public.ldc_players where room_id = p_room and alias_of is null
                 group by nickname having count(*) > 1) then return st; end if;
  if b->>'phase' in ('recruit','roles','choose','think','speak','guess') then reserved := reserved || b->'players'; end if;
  if d->>'phase' = 'rolling' then reserved := reserved || d->'participants'; end if;
  if u->>'phase' in ('discuss','vote') then reserved := reserved || u->'players'; end if;
  if w->>'phase' not in ('setup','result') then reserved := reserved || w->'players'; end if;
  if k->>'phase' in ('command','challenge','handover') then
    reserved := reserved || jsonb_build_array(k->>'king') ||
      (select coalesce(jsonb_agg(id), '[]'::jsonb) from jsonb_object_keys(k->'numbers') as p(id));
  end if;
  if t->>'phase' in ('choose','question') then
    reserved := reserved || coalesce(t->'takers', '[]'::jsonb) || coalesce(t->'askers', '[]'::jsonb) ||
      public._ldc_t_doers(t) || jsonb_build_array(t->'q'->>'target');
  end if;
  for duplicate in
    select id, canonical, id::text as source, canonical::text as target, last_seen, left_at
      from (
        select id, left_at, last_seen, first_value(id) over (
          partition by nickname order by (reserved ? id::text) desc, (left_at is null) desc, seat, id
        ) as canonical
        from public.ldc_players where room_id = p_room and alias_of is null
      ) ranked
      where id <> canonical and not (reserved ? id::text)
  loop
    update public.ldc_players set alias_of = duplicate.canonical where alias_of = duplicate.id;
    update public.ldc_players set alias_of = duplicate.canonical, left_at = coalesce(left_at, now()) where id = duplicate.id;
    update public.ldc_players set last_seen = greatest(last_seen, duplicate.last_seen),
      left_at = case when duplicate.left_at is null then null else left_at end where id = duplicate.canonical;
    if st->>'bluff_next_honest' = duplicate.source then
      st := jsonb_set(st, '{bluff_next_honest}', to_jsonb(duplicate.target));
    end if;
    if b->'scores' ? duplicate.source then
      scores := public._ldc_inc(b->'scores', duplicate.target, (b->'scores'->>duplicate.source)::int) - duplicate.source;
      b := jsonb_set(b, '{scores}', scores);
    end if;
    if b->'stats' ? duplicate.source then
      stats := coalesce(b->'stats'->duplicate.target, '{}'::jsonb);
      for item in select key, value from jsonb_each_text(b->'stats'->duplicate.source) loop
        stats := public._ldc_inc(stats, item.key, item.value::int);
      end loop;
      b := jsonb_set(b, '{stats}', ((b->'stats') - duplicate.source) || jsonb_build_object(duplicate.target, stats));
    end if;
    if t->>'mode' = 'turns' and t->'order' ? duplicate.source then
      t := t || jsonb_build_object('order', public._ldc_del(t->'order', duplicate.source),
        'turn', (t->>'turn')::int - case when exists (
          select 1 from jsonb_array_elements_text(t->'order') with ordinality as p(id,n)
          where id = duplicate.source and n <= (t->>'turn')::int
        ) then 1 else 0 end);
    end if;
    if st->'where'->>duplicate.target is null and st->'where'->>duplicate.source is not null then
      st := jsonb_set(st, array['where', duplicate.target], st->'where'->duplicate.source);
    end if;
    st := jsonb_set(st, '{where}', coalesce(st->'where', '{}'::jsonb) - duplicate.source);
  end loop;
  if b is not null then st := jsonb_set(st, '{bluff}', b); end if;
  if t is not null then st := jsonb_set(st, '{truth}', t); end if;
  return st;
end $$;
revoke all on function public._ldc_merge_names(uuid,jsonb) from public, anon, authenticated;

-- ---------- 网页调用的函数 ----------
drop function if exists public.ldc_create_room(text);
drop function if exists public.ldc_create_room(text, text);

-- 创建房间：只有网站管理员（带管理员钥匙）能创建，而且只生成房间号，创建的人不会自动进房间、也没有任何特权
create or replace function public._ldc_is_admin(p_key text) returns boolean
language sql stable as $$
  select coalesce(p_key,'') <> '' and exists (select 1 from public.ldc_settings where key = 'admin_hash' and value = public._ldc_hash(p_key)) $$;

-- 站点管理员和独立主持面板共用房间创建、房间列表。
create or replace function public._ldc_new_room(p_code text) returns jsonb
language plpgsql set search_path = public as $$
declare requested text := nullif(btrim(coalesce(p_code,'')), ''); v_code text;
begin
  if requested is not null and requested !~ '^[0-9]{6}$' then return '{"ok":false,"error":"bad_code"}'; end if;
  for attempt in 1..30 loop
    v_code := coalesce(requested, lpad(floor(random() * 1000000)::int::text, 6, '0'));
    insert into ldc_rooms (code, state) values (v_code, '{"game":null,"paused":false}')
      on conflict (code) do nothing;
    if found then return jsonb_build_object('ok', true, 'code', v_code); end if;
    if requested is not null then return '{"ok":false,"error":"code_taken"}'; end if;
  end loop;
  return '{"ok":false,"error":"busy"}';
end $$;

create or replace function public._ldc_room_list() returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object('ok', true, 'rooms', coalesce((
    select jsonb_agg(jsonb_build_object('code', r.code, 'created_at', r.created_at, 'updated_at', r.updated_at, 'game', r.state->>'game',
             'players', (select count(*) from ldc_players p where p.room_id = r.id and p.left_at is null),
             'online',  (select count(*) from ldc_players p where p.room_id = r.id and p.left_at is null and p.last_seen > now() - interval '20 seconds'))
           order by r.created_at desc)
    from (select * from ldc_rooms order by created_at desc limit 50) r), '[]'::jsonb)) $$;

create or replace function public.ldc_create_room(p_admin_key text, p_code text default null) returns jsonb
language sql security definer set search_path = public as $$
  select case when _ldc_is_admin(p_admin_key) then _ldc_new_room(p_code) else '{"ok":false,"error":"forbidden"}'::jsonb end $$;

create or replace function public.ldc_admin_rooms(p_admin_key text) returns jsonb
language sql security definer set search_path = public as $$
  select case when _ldc_is_admin(p_admin_key) then _ldc_room_list() else '{"ok":false,"error":"forbidden"}'::jsonb end $$;

-- 加入房间：有效凭据或同房间同昵称均恢复原座位，同名换设备时保留旧设备凭据。
create or replace function public.ldc_join(p_code text, p_name text, p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r ldc_rooms; n text := btrim(coalesce(p_name,'')); v_pid uuid; v_tok text; st jsonb; online jsonb;
begin
  select * into r from ldc_rooms where code = p_code for update;
  if not found then return '{"ok":false,"error":"not_found"}'; end if;
  if char_length(n) not between 1 and 12 and not exists (
    select 1 from ldc_players where room_id = r.id and token_hash = _ldc_hash(p_token)
  ) then return '{"ok":false,"error":"bad_name"}'; end if;
  st := _ldc_merge_names(r.id, r.state);
  if st is distinct from r.state then
    update ldc_rooms set state = st, version = version + 1, updated_at = now() where id = r.id;
    r.state := st;
  end if;
  if coalesce(p_token,'') <> '' then
    select coalesce(alias_of, id) into v_pid from ldc_players where room_id = r.id and token_hash = _ldc_hash(p_token);
    if v_pid is not null then v_tok := p_token; end if;
  end if;
  if v_pid is null then
    select id into v_pid from ldc_players where room_id = r.id and nickname = n and alias_of is null
      order by (left_at is null) desc, seat, id limit 1;
    v_tok := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
    if v_pid is not null then
      insert into ldc_players (room_id, nickname, token_hash, seat, left_at, alias_of)
        select r.id, nickname, _ldc_hash(v_tok), seat, now(), id from ldc_players where id = v_pid;
    end if;
  end if;
  if v_pid is not null then
    online := _ldc_online(r.id);
    update ldc_players set left_at = null, last_seen = now() where id = v_pid;
    if st->'where'->>v_pid::text = 'bluff' and
        (not coalesce((st->>'paused')::boolean, false) or st->>'paused_game' is distinct from 'bluff') then
      if not (online ? v_pid::text) then st := _ldc_bluff_settle(st, _ldc_here(st, online, 'bluff')); end if;
      st := _ldc_bluff_settle(st, _ldc_here(st, _ldc_online(r.id), 'bluff'));
    end if;
    if st is distinct from r.state then
      update ldc_rooms set state = st, version = version + 1, updated_at = now() where id = r.id;
    end if;
    return _ldc_view(r.id, v_pid) || jsonb_build_object('token', v_tok, 'resumed', true);
  end if;
  if (select count(*) from ldc_players where room_id = r.id and left_at is null) >= 16 then
    return '{"ok":false,"error":"full"}';
  end if;
  insert into ldc_players (room_id, nickname, token_hash, seat)
    values (r.id, n, _ldc_hash(v_tok), coalesce((select max(seat) from ldc_players where room_id = r.id), 0) + 1)
    returning id into v_pid;
  insert into ldc_events (room_id, player_id, kind) values (r.id, v_pid, 'join');
  update ldc_rooms set state = st, updated_at = now(), version = version + 1 where id = r.id;
  return _ldc_view(r.id, v_pid) || jsonb_build_object('token', v_tok);
end $$;

-- 所有操作（同时也是心跳）：p_action 为 'state' 时只刷新
create or replace function public.ldc_act(p_code text, p_token text, p_action text, p_args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r ldc_rooms; v_pid uuid; me text; online jsonb; st jsonb; st0 jsonb; d jsonb;
  err text; res jsonb := '{}'::jsonb; p jsonb; k text; g text; t text; v int; now_ms bigint := _ldc_now_ms();
  a jsonb := coalesce(p_args, '{}'::jsonb); tr jsonb; paused boolean; king_result jsonb; bl jsonb;
  all_online jsonb; ag text; kg jsonb; u jsonb; undercover_result jsonb; w jsonb; werewolf_result jsonb;
begin
  select * into r from ldc_rooms where code = p_code for update;
  if not found then return '{"ok":false,"error":"not_found"}'; end if;
  if not exists (
    select 1 from ldc_players p join ldc_players cp on cp.id = coalesce(p.alias_of, p.id)
    where p.room_id = r.id and p.token_hash = _ldc_hash(p_token) and cp.left_at is null
  ) then return '{"ok":false,"error":"not_member"}'; end if;
  st0 := r.state;
  st := _ldc_merge_names(r.id, st0);
  online := _ldc_online(r.id);
  update ldc_players set last_seen = now()
    where room_id = r.id and left_at is null and id = (
      select coalesce(p.alias_of, p.id) from ldc_players p
      where p.room_id = r.id and p.token_hash = _ldc_hash(p_token)
    ) returning id into v_pid;
  if v_pid is null then return '{"ok":false,"error":"not_member"}'; end if;
  me := v_pid::text;
  all_online := _ldc_online(r.id);
  if st->'where'->>me = 'bluff' and not (online ? me) and
      (not coalesce((st->>'paused')::boolean, false) or st->>'paused_game' is distinct from 'bluff') then
    st := _ldc_bluff_settle(st, _ldc_here(st, online, 'bluff'));
  end if;
  st := _ldc_settle((st - 'game' - 'proposal') || jsonb_build_object('where', coalesce(st->'where', '{}'::jsonb)), all_online, r.id);
  d := st->'dice';
  -- 这次操作属于哪个游戏；参与者 = 在线、而且在这个游戏页面的人
  ag := case when p_action in ('ready', 'unready', 'roll', 'next_round', 'to_truth') then 'dice'
             when left(p_action, 2) = 't_' then 'truth' when left(p_action, 2) = 'k_' then 'king' when left(p_action, 2) = 'b_' then 'bluff'
             when left(p_action, 2) = 'u_' then 'undercover'
             when left(p_action, 2) = 'w_' then 'werewolf'
             when p_action = 'propose' then coalesce(a->'payload'->>'game', st->'where'->>me)
             when p_action = 'pause' then st->'where'->>me end;
  online := _ldc_here(st, all_online, ag);
  st := st || jsonb_build_object('game', ag);
  paused := coalesce((st->>'paused')::boolean, false) and st->>'paused_game' is not distinct from ag;

  if p_action = 'state' then
    null;

  -- 进入某个游戏页面（g = null 回大厅）。不用别人同意
  elsif p_action = 'goto' then
    g := a->>'game';
    w := st->'werewolf';
    if g is not null and g not in ('dice', 'truth', 'king', 'bluff', 'undercover','werewolf') then err := 'not_ready';
    elsif g='werewolf' and w->>'phase' not in ('setup','result') and not (w->'players' ? me) then err := 'werewolf_in_progress';
    else
      st := jsonb_set(st, '{where}', (st->'where') || jsonb_build_object(me, g));
      if g = 'dice' then
        if d is null then st := jsonb_set(st, '{dice}', _ldc_dice_init());
        elsif d->>'phase' = 'rolling' then
          st := jsonb_set(st, '{dice,participants}', _ldc_add(d->'participants', me));
        end if;
      end if;
      if g = 'truth' and st->'truth' is null then st := jsonb_set(st, '{truth}', _ldc_truth_init('setup')); end if;
      if g = 'truth' and st->'truth'->>'mode' = 'turns' then
        st := jsonb_set(st, '{truth,order}', _ldc_add(st->'truth'->'order', me));
      end if;
      if g = 'king' then
        kg := st->'king';
        if kg is null then st := jsonb_set(st, '{king}', _ldc_king_setup('secret', 0));
        elsif kg->>'phase' <> 'setup' and kg->>'king' <> me and not (kg->'numbers' ? me) then
          v := (kg->>'size')::int + 1;
          kg := jsonb_set(kg, '{numbers}', (kg->'numbers') || jsonb_build_object(me, v));
          st := jsonb_set(st, '{king}', kg || jsonb_build_object('size', v));
        end if;
      end if;
      if g = 'bluff' and st->'bluff' is null then st := jsonb_set(st, '{bluff}', _ldc_bluff_init()); end if;
      if g='werewolf' and w is null then st := jsonb_set(st,'{werewolf}','{"phase":"setup"}'::jsonb); end if;
      if g = 'undercover' then
        u := coalesce(st->'undercover','{"phase":"setup"}'::jsonb);
        if u->>'phase' in ('discuss','vote') and not (u->'players' ? me) then
          u := u || jsonb_build_object('players',_ldc_add(u->'players',me),'alive',_ldc_add(u->'alive',me));
          if u->>'phase' = 'vote' and not (u->>'runoff')::boolean then
            u := jsonb_set(u,'{targets}',_ldc_add(u->'targets',me));
          end if;
        end if;
        st := jsonb_set(st,'{undercover}',u);
      end if;
    end if;

  -- 以前要大家同意的操作，现在点了就执行
  elsif p_action = 'propose' then
    k := a->>'kind';
    if ag is null then err := 'no_game';
    elsif k = 'resume' then
      if not paused then err := 'not_paused'; end if;
    elsif k = 'skip_player' then
      t := a->'payload'->>'player';
      if st->>'game' <> 'dice' or d->>'phase' <> 'rolling' or not (d->'participants' ? t) or (d->'done' ? t) or t = me then err := 'bad_target'; end if;
    elsif k = 'king_start' then
      t := a->'payload'->>'player';
      if st->>'game' is distinct from 'king' or st->'king'->>'phase' is distinct from 'setup' then err := 'phase';
      elsif paused then err := 'paused';
      elsif jsonb_array_length(online) < 2 then err := 'king_people';
      elsif coalesce(a->'payload'->>'mode', '') not in ('secret', 'public')
          or t is null or (t <> 'random' and not (online ? t)) then err := 'bad_target'; end if;
    elsif k in ('king_redeal', 'king_skip') then
      if st->>'game' is distinct from 'king' or st->'king'->>'key' is distinct from a->'payload'->>'key'
          or st->'king'->>'phase' is distinct from (case when k = 'king_redeal' then 'command' else 'challenge' end)
        then err := 'phase';
      elsif paused then err := 'paused';
      elsif k = 'king_redeal' and (not (online ? (st->'king'->>'king')) or jsonb_array_length(online) < 2)
        then err := 'king_offline'; end if;
    elsif k = 'restart_round' then
      if st->(st->>'game') is null then err := 'no_game'; end if;
    elsif k in ('bluff_redraw', 'bluff_void') then
      if st->>'game' <> 'bluff' or st->'bluff'->>'phase' not in ('roles', 'choose', 'think', 'speak', 'guess')
         or (k = 'bluff_redraw' and st->'bluff'->>'phase' = 'guess') then err := 'phase';
      elsif st->'bluff'->>'phase' = 'speak' and st->'bluff'->>'smart' is distinct from me then err := 'not_yours'; end if;
    else err := 'bad_kind';
    end if;
    if err is null then
      p := jsonb_build_object('kind', k, 'payload', coalesce(a->'payload', '{}'::jsonb) || jsonb_build_object('game', ag), 'by', me);
      st := _ldc_apply(st, p, online);
      st := st || jsonb_build_object('notice', jsonb_build_object('kind', k, 'ok', true, 'by', me, 'payload', p->'payload', 'at', now_ms));
      if k = 'king_start' then
        st := st || jsonb_build_object('invite', jsonb_build_object('game', 'king', 'by', me, 'what', 'start', 'at', now_ms));
      end if;
      insert into ldc_events (room_id, player_id, kind, payload) values (r.id, v_pid, 'act', p);
    end if;

  elsif p_action = 'pause' then
    if ag is null then err := 'no_game';
    elsif ag = 'bluff' and st->'bluff'->>'phase' = 'setup' then err := 'phase';
    elsif not coalesce((st->>'paused')::boolean, false) then
      st := st || jsonb_build_object('paused', true, 'paused_by', me, 'paused_game', ag, 'notice', jsonb_build_object('kind','pause','ok',true,'by',me,'at',now_ms,'payload',jsonb_build_object('game',ag)));
      tr := st->'truth';
      if tr is not null and jsonb_typeof(tr->'timer_end') = 'number' then
        st := jsonb_set(st, '{truth}', tr || jsonb_build_object('timer_left', greatest((tr->>'timer_end')::bigint - now_ms, 0), 'timer_end', null));
      end if;
      bl := st->'bluff';
      if bl is not null and jsonb_typeof(bl->'timer_end') = 'number' then
        st := jsonb_set(st, '{bluff}', bl || jsonb_build_object('timer_left', greatest((bl->>'timer_end')::bigint - now_ms, 0), 'timer_end', null));
      end if;
    end if;

  elsif left(p_action, 2) = 'k_' then
    king_result := _ldc_king_action(st, online, me, p_action, a);
    err := king_result->>'error';
    if err is null then st := king_result->'state'; end if;

  elsif p_action in ('ready', 'unready', 'roll', 'next_round') then
    if d is null then err := 'no_game';
    elsif paused then err := 'paused';
    elsif p_action = 'ready' then
      if d->>'phase' <> 'ready' then err := 'phase';
      else
        d := jsonb_set(d, '{ready}', _ldc_add(d->'ready', me));
        st := st || jsonb_build_object('invite', jsonb_build_object('game', 'dice', 'by', me, 'what', 'ready', 'at', now_ms));
      end if;
    elsif p_action = 'unready' then
      if d->>'phase' <> 'ready' then err := 'phase'; else d := jsonb_set(d, '{ready}', _ldc_del(d->'ready', me)); end if;
    elsif p_action = 'roll' then
      if d->>'phase' <> 'rolling' then err := 'phase';
      elsif not (d->'participants' ? me) then err := 'not_in_round';
      elsif d->'done' ? me then err := 'already'; res := jsonb_build_object('value', d->'results'->me);
      else
        v := 1 + floor(random() * 6)::int;
        d := jsonb_set(d, '{results}', (d->'results') || jsonb_build_object(me, v));
        d := jsonb_set(d, '{done}', _ldc_add(d->'done', me));
        res := jsonb_build_object('value', v);
      end if;
    elsif p_action = 'next_round' then
      if d->>'phase' <> 'reveal' then err := 'phase'; else d := _ldc_dice_new_round(d, online); end if;
    end if;
    if err is null then st := jsonb_set(st, '{dice}', d); end if;

  -- 摇骰子揭晓后直接去出题：在摇骰子页面的人一起去真心话大冒险
  elsif p_action = 'to_truth' then
    if st->>'game' <> 'dice' or d is null or d->>'phase' <> 'reveal' or coalesce((d->>'all_same')::boolean, false) then err := 'phase';
    elsif paused then err := 'paused';
    else
      st := st || jsonb_build_object('game', 'truth', 'truth', _ldc_truth_init('dice') || jsonb_build_object(
        'askers', d->'askers', 'takers', d->'takers', 'round', d->'round', 'timer', coalesce((st->'truth'->>'timer')::int, 0)));
      st := _ldc_move(st, 'dice', 'truth');
    end if;

  elsif left(p_action, 2) = 't_' then
    tr := st->'truth';
    if st->>'game' <> 'truth' or tr is null then err := 'no_game';
    elsif paused then err := 'paused';

    elsif p_action = 't_start' then
      if tr->>'phase' <> 'setup' then err := 'phase';
      elsif coalesce(a->>'mode','') not in ('free', 'turns') then err := 'bad_action';
      else
        tr := tr || jsonb_build_object('mode', a->>'mode', 'order_kind', coalesce(a->>'order', 'seat'), 'turn', 0, 'lap', 1, 'phase', 'choose',
              'order', case when a->>'order' = 'random' then _ldc_shuffle(online) else online end);
        st := st || jsonb_build_object('invite', jsonb_build_object('game', 'truth', 'by', me, 'what', 'start', 'at', now_ms));
      end if;

    elsif p_action = 't_draw' then
      if tr->>'phase' not in ('choose', 'question') then err := 'phase';
      elsif coalesce(a->>'type','') not in ('truth', 'dare', 'quiz') then err := 'bad_action';
      elsif not _ldc_t_can(tr, online, 'chooser', me) then err := 'not_yours';
      else
        p := _ldc_draw(st, a->>'type', nullif(a->>'cat', ''), online);
        if p is null then err := 'empty';
        else
          tr := tr || jsonb_build_object('q', p, 'phase', 'question', 'show_answer', false, 'verdict', null, 'timer_left', null,
                'timer_end', case when coalesce((tr->>'timer')::int, 0) > 0 then to_jsonb(now_ms + (tr->>'timer')::int * 1000) else 'null'::jsonb end);
          st := st || jsonb_build_object('used_q', (select coalesce(jsonb_agg(x order by i), '[]'::jsonb) from
                  jsonb_array_elements(jsonb_build_array(p->'id') || coalesce(st->'used_q', '[]'::jsonb)) with ordinality z(x, i) where i <= 400));
        end if;
      end if;

    elsif p_action = 't_timer' then
      v := coalesce((a->>'secs')::int, 0);
      if v not in (0, 15, 30, 60, 120) then err := 'bad_action';
      else
        tr := tr || jsonb_build_object('timer', v, 'timer_left', null,
              'timer_end', case when v > 0 and tr->>'phase' = 'question' then to_jsonb(now_ms + v * 1000) else 'null'::jsonb end);
      end if;

    elsif p_action = 't_answer' then
      if tr->>'phase' <> 'question' then err := 'phase'; else tr := tr || '{"show_answer":true}'::jsonb; end if;

    elsif p_action = 't_verdict' then
      if tr->>'phase' <> 'question' or (tr->'q'->>'target') is null then err := 'phase';
      elsif tr->'q'->>'target' <> me and online ? (tr->'q'->>'target') then err := 'not_yours';
      else tr := tr || jsonb_build_object('verdict', case when coalesce((a->>'right')::boolean, false) then 'right' else 'wrong' end);
      end if;

    elsif p_action = 't_done' then
      if tr->>'phase' <> 'question' then err := 'phase';
      elsif not _ldc_t_can(tr, online, 'doer', me) then err := 'not_yours';
      else
        insert into ldc_events (room_id, player_id, kind, payload) values (r.id, v_pid, 'truth_done',
          jsonb_build_object('q', tr->'q'->>'id', 'skipped', coalesce((a->>'skipped')::boolean, false), 'verdict', tr->'verdict', 'mode', tr->>'mode'));
        tr := tr || jsonb_build_object(
          'last', jsonb_build_object('text', tr->'q'->>'text', 'skipped', coalesce((a->>'skipped')::boolean, false), 'verdict', tr->'verdict', 'who', _ldc_t_doers(tr)),
          'count', coalesce((tr->>'count')::int, 0) + 1, 'q', null, 'show_answer', false, 'verdict', null, 'timer_end', null, 'timer_left', null);
        if tr->>'mode' = 'free' then tr := tr || '{"phase":"choose"}'::jsonb;
        elsif tr->>'mode' = 'dice' then tr := tr || '{"phase":"done"}'::jsonb;
        else
          -- 轮流：下一位；一圈结束后按当时在线的人重新排（随机顺序会重新打乱）
          if (tr->>'turn')::int + 1 >= jsonb_array_length(tr->'order') then
            tr := tr || jsonb_build_object('turn', 0, 'lap', coalesce((tr->>'lap')::int, 1) + 1,
                  'order', case when tr->>'order_kind' = 'random' then _ldc_shuffle(online) else online end);
          else
            tr := tr || jsonb_build_object('turn', (tr->>'turn')::int + 1);
          end if;
          tr := tr || '{"phase":"choose"}'::jsonb;
        end if;
      end if;

    elsif p_action = 't_back_dice' then
      if tr->>'mode' <> 'dice' then err := 'phase';
      else
        st := st || jsonb_build_object('game', 'dice', 'dice', _ldc_dice_new_round(coalesce(st->'dice', _ldc_dice_init()), online));
        st := _ldc_move(st, 'truth', 'dice');
      end if;

    else err := 'bad_action';
    end if;
    if err is null and st->>'game' = 'truth' then st := jsonb_set(st, '{truth}', tr); end if;

  elsif left(p_action, 2) = 'w_' then
    if st->'werewolf' is null or not (online ? me) then err := 'no_game';
    elsif paused then err := 'paused';
    else
      werewolf_result := _ldc_werewolf_action(st->'werewolf',online,me,p_action,a);
      err := werewolf_result->>'error';
      if err is null then st := jsonb_set(st,'{werewolf}',werewolf_result->'state'); end if;
    end if;
  elsif left(p_action, 2) = 'u_' then
    if st->'undercover' is null or not (online ? me) then err := 'no_game';
    elsif paused then err := 'paused';
    else
      undercover_result := _ldc_undercover_action(st->'undercover',online,me,p_action,a);
      err := undercover_result->>'error';
      if err is null then st := jsonb_set(st,'{undercover}',undercover_result->'state'); end if;
    end if;
  elsif left(p_action, 2) = 'b_' then
    bl := st->'bluff';
    if bl is null or not (online ? me) then err := 'no_game';
    elsif paused then err := 'paused';
    elsif jsonb_array_length(coalesce(bl->'away', '[]'::jsonb)) > 0 then err := 'bluff_waiting';
    elsif p_action in ('b_setup', 'b_timer', 'b_think', 'b_start') and bl->>'phase' <> 'setup' then err := 'phase';
    elsif p_action in ('b_setup', 'b_timer', 'b_think', 'b_start') and bl->'settings_order'->>0 is distinct from me then err := 'bluff_settings_owner';

    elsif p_action = 'b_setup' then
      if a ? 'bank' then
        if a->>'bank' in ('idiom', 'word', 'allusion', 'mix', 'story') then
          if (coalesce(bl->>'bank', 'mix') = 'story') <> (a->>'bank' = 'story') then
            st := st - 'bluff_next_q';
          end if;
          bl := bl || jsonb_build_object('bank', a->>'bank', 'mode', case when a->>'bank' = 'story' then 'story' else 'knowledge' end);
        else err := 'bad_action'; end if;
      end if;
      if a ? 'warn_on' then bl := bl || jsonb_build_object('warn_on', coalesce((a->>'warn_on')::boolean, true)); end if;
      if a ? 'rounds' then
        if a->>'rounds' in ('0', '1', '3', '5', '8') then bl := bl || jsonb_build_object('rounds', (a->>'rounds')::int); else err := 'bad_action'; end if;
      end if;

    elsif p_action = 'b_timer' then
      v := coalesce((a->>'secs')::int, -1);
      if v not in (0, 60, 120, 180) then err := 'bad_action';
      else bl := bl || jsonb_build_object('timer', v);
      end if;

    elsif p_action = 'b_think' then
      v := coalesce((a->>'secs')::int, 0);
      if v not in (30, 60, 120) then err := 'bad_action';
      else bl := bl || jsonb_build_object('think', v);
      end if;

    elsif p_action = 'b_ready' then
      if bl->>'phase' <> 'think' then err := 'phase';
      elsif not (bl->'players' ? me) then err := 'not_in_round';
      else bl := jsonb_set(bl, '{ready}', _ldc_add(coalesce(bl->'ready', '[]'::jsonb), me));
      end if;

    elsif p_action in ('b_start', 'b_next_round') then
      if p_action = 'b_next_round' and bl->>'phase' <> 'reveal' then err := 'phase';
      elsif p_action = 'b_next_round' and coalesce((bl->>'rounds')::int, 0) > 0 and (bl->>'round')::int >= (bl->>'rounds')::int then err := 'finished';
      elsif jsonb_array_length(online) < 3 then err := 'need3';
      else
        bl := _ldc_bluff_recruit(bl, online);
        st := st || jsonb_build_object('invite', jsonb_build_object('game', 'bluff', 'by', me, 'what', 'start', 'at', now_ms));
      end if;

    elsif p_action = 'b_final' then
      if bl->>'phase' <> 'reveal' then err := 'phase';
      else bl := bl || '{"phase":"final"}'::jsonb;
      end if;

    -- 再来一局：总分和统计清零
    elsif p_action = 'b_again' then
      if bl->>'phase' <> 'final' then err := 'phase';
      else bl := bl || _ldc_bluff_fresh() || jsonb_build_object('phase', 'setup', 'round', 0, 'scores', '{}'::jsonb, 'stats', '{}'::jsonb,
                 'history', '[]'::jsonb, 'players', '[]'::jsonb, 'smart', null);
      end if;

    elsif p_action = 'b_want' then
      if bl->>'phase' <> 'recruit' then err := 'phase';
      elsif not (bl->'players' ? me) then err := 'not_in_round';
      else bl := jsonb_set(bl, '{want}', (bl->'want') || jsonb_build_object(me, coalesce((a->>'yes')::boolean, false)));
      end if;

    elsif p_action = 'b_seen' then
      if bl->>'phase' <> 'roles' then err := 'phase';
      elsif not (bl->'players' ? me) then err := 'not_in_round';
      else bl := jsonb_set(bl, '{seen}', _ldc_add(bl->'seen', me));
      end if;

    elsif p_action = 'b_discuss_done' then
      if bl->>'phase' <> 'speak' then err := 'phase';
      elsif bl->>'smart' is distinct from me then err := 'not_yours';
      elsif coalesce((bl->>'warns_left')::int, 0) > 0 then err := 'warnings_pending';
      else bl := bl || '{"phase":"guess"}'::jsonb;
      end if;

    -- 警告牌：大聪明可在发言环节给任意候选人发牌。
    elsif p_action = 'b_warn' then
      t := a->>'player';
      if bl->>'phase' <> 'speak' then err := 'phase';
      elsif bl->>'smart' <> me then err := 'not_yours';
      elsif coalesce((bl->>'warns_left')::int, 0) <= 0 then err := 'no_warns';
      elsif t is null or not (bl->'order' ? t) or coalesce(bl->'warned', '[]'::jsonb) ? t then err := 'bad_target';
      else bl := bl || jsonb_build_object('warned', _ldc_add(coalesce(bl->'warned', '[]'::jsonb), t), 'warns_left', (bl->>'warns_left')::int - 1);
      end if;

    -- 大聪明从两道题里选一道；「换两道」换一批
    elsif p_action in ('b_choose', 'b_more') then
      if bl->>'phase' <> 'choose' then err := 'phase';
      elsif bl->>'smart' <> me then err := 'not_yours';
      elsif p_action = 'b_more' then
        bl := bl || jsonb_build_object('choices', _ldc_bluff_two(st, (select coalesce(jsonb_agg(c->'id'), '[]'::jsonb) from jsonb_array_elements(bl->'choices') c)));
      elsif not exists (select 1 from jsonb_array_elements(bl->'choices') c where c->>'id' = a->>'id') then err := 'bad_target';
      else
        st := _ldc_bluff_begin(st, a->>'id');
        bl := st->'bluff';
      end if;

    -- 指认一次，确认后立即揭晓并计分。
    elsif p_action = 'b_pick' then
      t := a->>'player';
      if bl->>'phase' <> 'guess' then err := 'phase';
      elsif bl->>'smart' <> me then err := 'not_yours';
      elsif t is null or not (bl->'order' ? t) then err := 'bad_target';
      else
        bl := _ldc_bluff_finish(bl, t, false);
        insert into ldc_events (room_id, player_id, kind, payload) values (r.id, v_pid, 'bluff_reveal',
          jsonb_build_object('round', bl->'round', 'q', bl->'q'->>'id', 'smart', bl->'smart', 'honest', bl->'honest', 'pick', t, 'correct', bl->'correct'));
      end if;

    else err := 'bad_action';
    end if;
    if err is null then st := jsonb_set(st, '{bluff}', bl); end if;

  else
    err := 'bad_action';
  end if;

  st := _ldc_settle(st - 'game', all_online, r.id);
  if st is distinct from st0 then
    update ldc_rooms set state = st, version = version + 1, updated_at = now() where id = r.id;
  end if;
  if err is not null then
    return _ldc_view(r.id, v_pid) || jsonb_build_object('ok', false, 'error', err) || res;
  end if;
  return _ldc_view(r.id, v_pid) || res;
end $$;

-- 改昵称
create or replace function public.ldc_rename(p_code text, p_token text, p_name text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r ldc_rooms; n text := btrim(coalesce(p_name,'')); v_pid uuid;
begin
  if char_length(n) not between 1 and 12 then return '{"ok":false,"error":"bad_name"}'; end if;
  select * into r from ldc_rooms where code = p_code for update;
  if not found then return '{"ok":false,"error":"not_found"}'; end if;
  select id into v_pid from ldc_players
    where room_id = r.id and left_at is null and id = (
      select coalesce(p.alias_of, p.id) from ldc_players p where p.room_id = r.id and p.token_hash = _ldc_hash(p_token)
    );
  if v_pid is null then return '{"ok":false,"error":"not_member"}'; end if;
  if exists (select 1 from ldc_players where room_id = r.id and nickname = n and alias_of is null and id <> v_pid) then
    return '{"ok":false,"error":"name_taken"}';
  end if;
  update ldc_players set nickname = n, last_seen = now()
    where id = v_pid;
  update ldc_rooms set version = version + 1 where id = r.id;
  return _ldc_view(r.id, v_pid);
end $$;

-- 离开房间（凭据保留，之后用同一个浏览器回来会恢复身份）
create or replace function public.ldc_leave(p_code text, p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r ldc_rooms; v_pid uuid; st jsonb; d jsonb;
begin
  select * into r from ldc_rooms where code = p_code for update;
  if not found then return '{"ok":false,"error":"not_found"}'; end if;
  update ldc_players set left_at = now() where room_id = r.id and left_at is null and id = (
    select coalesce(p.alias_of, p.id) from ldc_players p where p.room_id = r.id and p.token_hash = _ldc_hash(p_token)
  ) returning id into v_pid;
  if v_pid is null then return '{"ok":true}'; end if;
  -- 摇骰时离开且还没摇：从本轮移除，避免卡住其他人
  st := r.state; d := st->'dice';
  if coalesce(st->'where'->>v_pid::text,'') not in ('bluff','undercover','werewolf') then
    st := jsonb_set(st, '{where}', coalesce(st->'where', '{}'::jsonb) - v_pid::text);
  end if;
  if d is not null then
    d := jsonb_set(d, '{ready}', _ldc_del(d->'ready', v_pid::text));
    if d->>'phase' = 'rolling' and not (d->'done' ? v_pid::text) then
      d := jsonb_set(d, '{participants}', _ldc_del(d->'participants', v_pid::text));
    end if;
    st := jsonb_set(st, '{dice}', d);
  end if;
  st := _ldc_settle(st, _ldc_online(r.id), r.id);
  update ldc_rooms set state = st, version = version + 1, updated_at = now() where id = r.id;
  insert into ldc_events (room_id, player_id, kind) values (r.id, v_pid, 'leave');
  return '{"ok":true}';
end $$;

-- 独立主持页：钥匙验证与进房凭据分开，不创建玩家，也不把身份写入公共响应。
create or replace function public.ldc_bluff_control(p_code text, p_access_key text, p_action text, p_question_id text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r ldc_rooms; s jsonb; b jsonb; bank_type text; eligible_honest jsonb;
begin
  if coalesce(p_access_key, '') = '' or not exists (
    select 1 from ldc_settings where key = 'bluff_control_hash' and value = _ldc_hash(p_access_key)
  ) then return '{"ok":false,"error":"forbidden"}'; end if;
  if p_action = 'rooms' then return _ldc_room_list(); end if;
  if p_action = 'create' then return _ldc_new_room(p_code); end if;
  if coalesce(p_code, '') !~ '^[0-9]{6}$' then return '{"ok":false,"error":"bad_code"}'; end if;
  if p_action is null or p_action not in ('view', 'select', 'clear', 'set_honest', 'clear_honest') then return '{"ok":false,"error":"bad_action"}'; end if;
  if p_action = 'view' then
    select * into r from ldc_rooms where code = p_code;
  else
    select * into r from ldc_rooms where code = p_code for update;
  end if;
  if not found then return '{"ok":false,"error":"not_found"}'; end if;
  s := r.state;
  b := coalesce(s->'bluff', _ldc_bluff_init());
  bank_type := case when b->>'bank' = 'story' then 'story' else 'knowledge' end;
  eligible_honest := _ldc_here(s, _ldc_online(r.id), 'bluff');
  if b->>'phase' = 'recruit' then
    select coalesce(jsonb_agg(id), '[]'::jsonb) into eligible_honest
      from jsonb_array_elements_text(eligible_honest) as p(id) where b->'players' ? id;
  end if;

  if p_action = 'select' then
    if not exists (
      select 1 from ldc_questions q where q.id = p_question_id and q.enabled and q.game_type = 'bluff'
        and q.qtype = bank_type and not (coalesce(s->'used_q', '[]'::jsonb) ? q.id)
    ) then return '{"ok":false,"error":"bad_question"}'; end if;
    s := s || jsonb_build_object('bluff_next_q', p_question_id);
  elsif p_action = 'clear' then
    s := s - 'bluff_next_q';
  elsif p_action = 'set_honest' then
    -- RPC 保持原签名，此操作的最后一个参数是玩家 ID。
    if p_question_id is null or not (eligible_honest ? p_question_id) then
      return '{"ok":false,"error":"bad_honest"}';
    end if;
    s := s || jsonb_build_object('bluff_next_honest', p_question_id);
  elsif p_action = 'clear_honest' then
    s := s - 'bluff_next_honest';
  end if;

  if s is distinct from r.state then
    if p_action in ('set_honest', 'clear_honest') then
      update ldc_rooms set state = s where id = r.id;
    else
      if b->>'phase' = 'choose' then
        b := b || jsonb_build_object('choices', _ldc_bluff_two(s, '[]'::jsonb));
        s := jsonb_set(s, '{bluff}', b);
      end if;
      update ldc_rooms set state = s, version = version + 1, updated_at = now() where id = r.id;
    end if;
  end if;

  return jsonb_build_object(
    'ok', true, 'code', r.code, 'phase', b->>'phase', 'round', b->'round',
    'bank', bank_type, 'queued', s->>'bluff_next_q',
    'queued_honest', s->>'bluff_next_honest',
    'current_question', b->'q',
    'players', (select coalesce(jsonb_agg(jsonb_build_object(
                       'id', p.id, 'name', p.nickname, 'online', p.left_at is null and p.last_seen > now() - interval '20 seconds',
                       'can_pin_honest', eligible_honest ? p.id::text,
                       'role', case when p.id::text = b->>'smart' then 'smart' else b->'roles'->>p.id::text end
                     ) order by p.seat), '[]'::jsonb)
                from ldc_players p where p.room_id = r.id and p.alias_of is null and (p.left_at is null or b->'players' ? p.id::text)),
    'questions', (select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'text', split_part(q.content, '｜', 1)) order by q.content, q.id), '[]'::jsonb)
                  from ldc_questions q where q.enabled and q.game_type = 'bluff' and q.qtype = bank_type
                    and not (coalesce(s->'used_q','[]'::jsonb) ? q.id)));
end $$;

-- ---------- 权限：网页只能调用 ldc_ 开头的函数 ----------
revoke all on function public._ldc_hash(text), public._ldc_now_ms(), public._ldc_add(jsonb,text), public._ldc_del(jsonb,text),
  public._ldc_subset(jsonb,jsonb), public._ldc_online(uuid), public._ldc_dice_init(), public._ldc_dice_new_round(jsonb,jsonb),
  public._ldc_dice_reveal(jsonb), public._ldc_apply(jsonb,jsonb,jsonb), public._ldc_settle(jsonb,jsonb,uuid), public._ldc_view(uuid,uuid),
  public._ldc_is_admin(text), public._ldc_truth_init(text), public._ldc_pick(jsonb), public._ldc_shuffle(jsonb), public._ldc_minus(jsonb,jsonb),
  public._ldc_t_doers(jsonb), public._ldc_t_can(jsonb,jsonb,text,text), public._ldc_draw(jsonb,text,text,jsonb),
  public._ldc_bluff_init(), public._ldc_bluff_recruit(jsonb,jsonb), public._ldc_bluff_assign(jsonb), public._ldc_bluff_draw(jsonb),
  public._ldc_bluff_two(jsonb,jsonb), public._ldc_bluff_begin(jsonb,text),
  public._ldc_bluff_secs(jsonb), public._ldc_bluff_think(jsonb), public._ldc_bluff_step(jsonb,bigint),
  public._ldc_bluff_fresh(), public._ldc_inc(jsonb,text,int), public._ldc_stat(jsonb,text,text,int),
  public._ldc_bluff_finish(jsonb,text,boolean), public._ldc_bluff_settle(jsonb,jsonb), public._ldc_here(jsonb,jsonb,text), public._ldc_move(jsonb,text,text)
  from public, anon, authenticated;
revoke all on function public._ldc_king_setup(text,int), public._ldc_king_round(jsonb,text,jsonb,boolean),
  public._ldc_king_clear(jsonb), public._ldc_king_action(jsonb,jsonb,text,text,jsonb) from public, anon, authenticated;
revoke all on function public.ldc_create_room(text,text), public.ldc_admin_rooms(text), public.ldc_join(text,text,text), public.ldc_act(text,text,text,jsonb),
  public.ldc_rename(text,text,text), public.ldc_leave(text,text) from public;
grant execute on function public.ldc_create_room(text,text), public.ldc_admin_rooms(text), public.ldc_join(text,text,text), public.ldc_act(text,text,text,jsonb),
  public.ldc_rename(text,text,text), public.ldc_leave(text,text) to anon, authenticated;

revoke all on function public._ldc_new_room(text), public._ldc_room_list() from public, anon, authenticated;
revoke all on function public.ldc_bluff_control(text,text,text,text) from public;
grant execute on function public.ldc_bluff_control(text,text,text,text) to anon, authenticated;

-- 查看公开 RPC（主持接口会独立验证主持密钥）
select routine_name from information_schema.routines
where routine_schema = 'public' and routine_name like 'ldc\_%' order by 1;
