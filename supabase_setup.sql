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
--       → speak 大聪明点人发言（可发警告牌） → guess 指认（1 次） → reveal 揭晓 → final 最终排名
-- 题库 bank：idiom 冷门成语 / word 生僻词汇 / allusion 历史典故 / mix 综合随机（以上三类） / story 故事
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

-- 分身份：大聪明以外随机一个老实人，其余都是捣蛋鬼；按人数定警告牌
create or replace function public._ldc_bluff_assign(b jsonb) returns jsonb
language plpgsql volatile as $$
declare others jsonb := public._ldc_minus(b->'players', jsonb_build_array(b->>'smart')); h text := public._ldc_pick(others);
        n int := jsonb_array_length(b->'players');
begin
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
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'cat', category, 'text', content)), '[]'::jsonb) from (
    select id, category, content from public.ldc_questions, (select coalesce(st->'bluff'->>'bank', 'mix') as bk) k
    where enabled and game_type = 'bluff'
      and ((k.bk = 'story' and qtype = 'story')
        or (k.bk <> 'story' and qtype = 'knowledge' and (k.bk = 'mix' or category =
              case k.bk when 'idiom' then '冷门成语' when 'word' then '冷门词汇' when 'allusion' then '历史典故' end)))
      and not (coalesce(st->'used_q', '[]'::jsonb) ? id)
    order by coalesce(p_not, '[]'::jsonb) ? id, random() limit 2) z $$;

-- 每人发言秒数：1/2/3 分钟或 0 = 不限时（默认 3 分钟）
create or replace function public._ldc_bluff_secs(b jsonb) returns int
language sql immutable as $$
  select case when (b->>'timer') in ('0', '60', '120', '180') then (b->>'timer')::int else 180 end $$;

-- 准备秒数（30 秒 / 1 分钟 / 2 分钟，默认 30 秒）
create or replace function public._ldc_bluff_think(b jsonb) returns int
language sql immutable as $$
  select case when (b->>'think') in ('30', '60', '120') then (b->>'think')::int else 30 end $$;

-- 当前发言的人说完了：记进已发言，等大聪明点下一位；全部说完进入指认
create or replace function public._ldc_bluff_step(b jsonb, now_ms bigint) returns jsonb
language plpgsql volatile as $$
declare sp jsonb := public._ldc_add(coalesce(b->'spoken', '[]'::jsonb), b->>'cur');
begin
  b := b || jsonb_build_object('spoken', sp, 'cur', null, 'timer_end', null, 'timer_left', null);
  if public._ldc_subset(b->'order', sp) then b := b || '{"phase":"guess"}'::jsonb; end if;
  return b;
end $$;

-- 大聪明选好的题：进入准备时间，记进已出过的题
create or replace function public._ldc_bluff_begin(st jsonb, p_id text) returns jsonb
language plpgsql volatile as $$
declare q public.ldc_questions; b jsonb := st->'bluff'; now_ms bigint := public._ldc_now_ms();
begin
  select * into q from public.ldc_questions where id = p_id and game_type = 'bluff';
  if not found then return st; end if;
  b := b || jsonb_build_object('q', jsonb_build_object('id', q.id, 'cat', q.category, 'text', q.content, 'answer', q.answer, 'explain', q.explanation),
         'choices', '[]'::jsonb, 'phase', 'think', 'ready', '[]'::jsonb, 'spoken', '[]'::jsonb, 'cur', null, 'skipped', '[]'::jsonb,
         'timer_left', null, 'timer_end', now_ms + public._ldc_bluff_think(b) * 1000);
  st := st || jsonb_build_object('used_q', (select coalesce(jsonb_agg(x order by i), '[]'::jsonb) from
          jsonb_array_elements(jsonb_build_array(q.id) || coalesce(st->'used_q', '[]'::jsonb)) with ordinality z(x, i) where i <= 400));
  return jsonb_set(st, '{bluff}', b);
end $$;

create or replace function public._ldc_inc(m jsonb, k text, v int) returns jsonb
language sql immutable as $$ select coalesce(m, '{}'::jsonb) || jsonb_build_object(k, coalesce((m->>k)::int, 0) + v) $$;

-- 加一项统计：stats = {玩家: {smart, found, honest, bluffer, picked, warn, warn_hit}}
create or replace function public._ldc_stat(s jsonb, p text, k text, v int) returns jsonb
language sql immutable as $$ select coalesce(s, '{}'::jsonb) || jsonb_build_object(p, public._ldc_inc(coalesce(s->p, '{}'::jsonb), k, v)) $$;

-- 结束一轮：p_pick = 指认的人（作废时为 null）
-- 计分：猜中时 3–6 人 大聪明 +1 / 7–12 人 +2，老实人 +1；
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
-- 准备时间到（或都点了准备好）就开始发言；发言时间到就算说完
create or replace function public._ldc_bluff_settle(st jsonb, online jsonb) returns jsonb
language plpgsql volatile as $$
declare b jsonb := st->'bluff'; pon jsonb; vol jsonb; everyone boolean; now_ms bigint := public._ldc_now_ms();
        away jsonb; clock_key text; clock jsonb; present jsonb;
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
  -- 整轮保留原名单。离开页面或断线时冻结进度，原玩家回来后接着计时。
  if b->>'phase' in ('recruit', 'roles', 'choose', 'think', 'speak', 'guess') then
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
        vol := (select coalesce(jsonb_agg(e), '[]'::jsonb) from jsonb_array_elements_text(pon) e where coalesce((b->'want'->>e)::boolean, false));
        b := b || jsonb_build_object('players', pon, 'volunteered', jsonb_array_length(vol) > 0,
               'smart', public._ldc_pick(case when jsonb_array_length(vol) > 0 then vol else pon end));
        b := public._ldc_bluff_assign(b);
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
  elsif b->>'phase' = 'speak' then
    if b->>'cur' is not null and jsonb_typeof(b->'timer_end') = 'number' and now_ms >= (b->>'timer_end')::bigint then
      b := public._ldc_bluff_step(b, now_ms);
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
                 where jsonb_typeof(n) <> 'number' or n::text !~ '^([1-9]|1[0-5])$')
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
create or replace function public._ldc_view(p_room uuid, p_me uuid) returns jsonb
language plpgsql stable as $$
declare r public.ldc_rooms; st jsonb; mine jsonb;
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
  st := st - 'used_q' - 'game' - 'proposal';
  return jsonb_build_object(
    'ok', true, 'code', r.code, 'me', p_me::text, 'version', r.version, 'now', public._ldc_now_ms(),
    'players', (select coalesce(jsonb_agg(jsonb_build_object('id', id::text, 'name', nickname, 'seat', seat,
                  'online', last_seen > now() - interval '20 seconds') order by seat), '[]'::jsonb)
                from public.ldc_players where room_id = p_room and left_at is null),
    'state', st);
end $$;

-- ---------- 网页调用的函数 ----------
drop function if exists public.ldc_create_room(text);
drop function if exists public.ldc_create_room(text, text);

-- 创建房间：只有网站管理员（带管理员钥匙）能创建，而且只生成房间号，创建的人不会自动进房间、也没有任何特权
create or replace function public._ldc_is_admin(p_key text) returns boolean
language sql stable as $$
  select coalesce(p_key,'') <> '' and exists (select 1 from public.ldc_settings where key = 'admin_hash' and value = public._ldc_hash(p_key)) $$;

create or replace function public.ldc_create_room(p_admin_key text, p_code text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_code text := nullif(btrim(coalesce(p_code,'')), ''); tries int := 0;
begin
  if not _ldc_is_admin(p_admin_key) then return '{"ok":false,"error":"forbidden"}'; end if;
  -- 指定房间号（6 位数字）；不指定就随机
  if v_code is not null then
    if v_code !~ '^[0-9]{6}$' then return '{"ok":false,"error":"bad_code"}'; end if;
    if exists (select 1 from ldc_rooms where code = v_code) then return '{"ok":false,"error":"code_taken"}'; end if;
  else
    loop
      v_code := lpad((floor(random() * 1000000))::int::text, 6, '0');
      exit when not exists (select 1 from ldc_rooms where code = v_code);
      tries := tries + 1;
      if tries > 30 then return '{"ok":false,"error":"busy"}'; end if;
    end loop;
  end if;
  insert into ldc_rooms (code, state) values (v_code, '{"game":null,"paused":false}');
  return jsonb_build_object('ok', true, 'code', v_code);
end $$;

-- 管理员查看自己建过的房间
create or replace function public.ldc_admin_rooms(p_admin_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not _ldc_is_admin(p_admin_key) then return '{"ok":false,"error":"forbidden"}'; end if;
  return jsonb_build_object('ok', true, 'rooms', coalesce((
    select jsonb_agg(jsonb_build_object('code', r.code, 'created_at', r.created_at, 'updated_at', r.updated_at, 'game', r.state->>'game',
             'players', (select count(*) from ldc_players p where p.room_id = r.id and p.left_at is null),
             'online',  (select count(*) from ldc_players p where p.room_id = r.id and p.left_at is null and p.last_seen > now() - interval '20 seconds'))
           order by r.created_at desc)
    from (select * from ldc_rooms order by created_at desc limit 50) r), '[]'::jsonb));
end $$;

-- 加入房间：带凭据 = 恢复原来的身份；不带 = 新玩家（昵称可以重复）
create or replace function public.ldc_join(p_code text, p_name text, p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r ldc_rooms; n text := btrim(coalesce(p_name,'')); v_pid uuid; v_tok text; st jsonb; online jsonb;
begin
  select * into r from ldc_rooms where code = p_code for update;
  if not found then return '{"ok":false,"error":"not_found"}'; end if;
  if coalesce(p_token,'') <> '' then
    online := _ldc_online(r.id);
    update ldc_players set left_at = null, last_seen = now()
      where room_id = r.id and token_hash = _ldc_hash(p_token) returning id into v_pid;
    if v_pid is not null then
      if r.state->'where'->>v_pid::text = 'bluff' and
          (not coalesce((r.state->>'paused')::boolean, false) or r.state->>'paused_game' is distinct from 'bluff') then
        st := r.state;
        if not (online ? v_pid::text) then st := _ldc_bluff_settle(st, _ldc_here(st, online, 'bluff')); end if;
        st := _ldc_bluff_settle(st, _ldc_here(st, _ldc_online(r.id), 'bluff'));
        if st is distinct from r.state then
          update ldc_rooms set state = st, version = version + 1, updated_at = now() where id = r.id;
        end if;
      end if;
      return _ldc_view(r.id, v_pid) || jsonb_build_object('token', p_token, 'resumed', true);
    end if;
  end if;
  if char_length(n) not between 1 and 12 then return '{"ok":false,"error":"bad_name"}'; end if;
  if (select count(*) from ldc_players where room_id = r.id and left_at is null) >= 16 then
    return '{"ok":false,"error":"full"}';
  end if;
  v_tok := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into ldc_players (room_id, nickname, token_hash, seat)
    values (r.id, n, _ldc_hash(v_tok), coalesce((select max(seat) from ldc_players where room_id = r.id), 0) + 1)
    returning id into v_pid;
  insert into ldc_events (room_id, player_id, kind) values (r.id, v_pid, 'join');
  update ldc_rooms set updated_at = now(), version = version + 1 where id = r.id;
  return _ldc_view(r.id, v_pid) || jsonb_build_object('token', v_tok);
end $$;

-- 所有操作（同时也是心跳）：p_action 为 'state' 时只刷新
create or replace function public.ldc_act(p_code text, p_token text, p_action text, p_args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r ldc_rooms; v_pid uuid; me text; online jsonb; st jsonb; st0 jsonb; d jsonb;
  err text; res jsonb := '{}'::jsonb; p jsonb; k text; g text; t text; v int; now_ms bigint := _ldc_now_ms();
  a jsonb := coalesce(p_args, '{}'::jsonb); tr jsonb; paused boolean; king_result jsonb; bl jsonb; cur text;
  all_online jsonb; ag text;
begin
  select * into r from ldc_rooms where code = p_code for update;
  if not found then return '{"ok":false,"error":"not_found"}'; end if;
  online := _ldc_online(r.id);
  update ldc_players set last_seen = now()
    where room_id = r.id and token_hash = _ldc_hash(p_token) and left_at is null returning id into v_pid;
  if v_pid is null then return '{"ok":false,"error":"not_member"}'; end if;
  me := v_pid::text;
  all_online := _ldc_online(r.id);
  st0 := r.state;
  st := r.state;
  if st->'where'->>me = 'bluff' and not (online ? me) and
      (not coalesce((st->>'paused')::boolean, false) or st->>'paused_game' is distinct from 'bluff') then
    st := _ldc_bluff_settle(st, _ldc_here(st, online, 'bluff'));
  end if;
  st := _ldc_settle((st - 'game' - 'proposal') || jsonb_build_object('where', coalesce(st->'where', '{}'::jsonb)), all_online, r.id);
  d := st->'dice';
  -- 这次操作属于哪个游戏；参与者 = 在线、而且在这个游戏页面的人
  ag := case when p_action in ('ready', 'unready', 'roll', 'next_round', 'to_truth') then 'dice'
             when left(p_action, 2) = 't_' then 'truth' when left(p_action, 2) = 'k_' then 'king' when left(p_action, 2) = 'b_' then 'bluff'
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
    if g is not null and g not in ('dice', 'truth', 'king', 'bluff') then err := 'not_ready';
    else
      st := jsonb_set(st, '{where}', (st->'where') || jsonb_build_object(me, g));
      if g = 'dice' and st->'dice' is null then st := jsonb_set(st, '{dice}', _ldc_dice_init()); end if;
      if g = 'truth' and st->'truth' is null then st := jsonb_set(st, '{truth}', _ldc_truth_init('setup')); end if;
      if g = 'king' and st->'king' is null then st := jsonb_set(st, '{king}', _ldc_king_setup('secret', 0)); end if;
      if g = 'bluff' and st->'bluff' is null then st := jsonb_set(st, '{bluff}', _ldc_bluff_init()); end if;
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
         or (k = 'bluff_redraw' and st->'bluff'->>'phase' = 'guess') then err := 'phase'; end if;
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
      elsif jsonb_array_length(online) > 12 then err := 'too_many';
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

    -- 大聪明点下一位发言的人
    elsif p_action = 'b_call' then
      t := a->>'player';
      if bl->>'phase' <> 'speak' or bl->>'cur' is not null then err := 'phase';
      elsif bl->>'smart' <> me then err := 'not_yours';
      elsif t is null or not (bl->'order' ? t) or coalesce(bl->'spoken', '[]'::jsonb) ? t then err := 'bad_target';
      else
        v := _ldc_bluff_secs(bl);
        bl := bl || jsonb_build_object('cur', t, 'timer_left', null, 'timer_end', case when v > 0 then to_jsonb(now_ms + v * 1000) else 'null'::jsonb end);
      end if;

    elsif p_action in ('b_next', 'b_skip_speak') then
      cur := bl->>'cur';
      if bl->>'phase' <> 'speak' or cur is null then err := 'phase';
      elsif p_action = 'b_skip_speak' and cur is distinct from me then err := 'not_yours';
      -- 「发言完成」由正在说的人或大聪明点
      elsif p_action = 'b_next' and not (cur = me or bl->>'smart' = me) then err := 'not_yours';
      else
        if p_action = 'b_skip_speak' then bl := jsonb_set(bl, '{skipped}', _ldc_add(bl->'skipped', me)); end if;
        bl := _ldc_bluff_step(bl, now_ms);
      end if;

    -- 警告牌：只有大聪明能发，必须在指认之前；每人每轮最多一张，不能撤回
    elsif p_action = 'b_warn' then
      t := a->>'player';
      if bl->>'phase' not in ('speak', 'guess') then err := 'phase';
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
  update ldc_players set nickname = n, last_seen = now()
    where room_id = r.id and token_hash = _ldc_hash(p_token) and left_at is null returning id into v_pid;
  if v_pid is null then return '{"ok":false,"error":"not_member"}'; end if;
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
  update ldc_players set left_at = now() where room_id = r.id and token_hash = _ldc_hash(p_token) and left_at is null returning id into v_pid;
  if v_pid is null then return '{"ok":true}'; end if;
  -- 摇骰时离开且还没摇：从本轮移除，避免卡住其他人
  st := r.state; d := st->'dice';
  if st->'where'->>v_pid::text is distinct from 'bluff' then
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

-- ---------- 权限：网页只能调用 ldc_ 开头的 6 个函数 ----------
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

-- 运行成功的话，下面会列出 6 个 ldc_ 函数
select routine_name from information_schema.routines
where routine_schema = 'public' and routine_name like 'ldc\_%' order by 1;
