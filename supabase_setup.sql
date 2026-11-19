-- 来点刺激的 · 数据库（第一版：房间系统 + 摇骰子，2026-11-19）
-- 放在口袋全宇宙 / 圣诞盲盒树同一个 Supabase 项目里，所有表和函数都以 ldc_ 开头，不碰其他数据。
-- 用法：Supabase → SQL Editor → 整段粘贴运行。可以重复运行（不会删数据）。
--
-- 设计：
--   * 没有房主，所有玩家权限相同。房间只能由网站管理员（带管理员钥匙）创建，创建只是生成房间号。
--   * 表都开 RLS 且不给策略：网页的匿名 key 不能直接读写表，只能调用下面的 ldc_ 函数。
--   * 规则全部在服务器执行：骰子点数由服务器随机；揭晓前每个人只能看到自己的点数；
--     共同确认（换游戏、继续、跳过某人、重开本轮）由服务器统计：
--       在线的人全部同意就执行；任何一人点「不了」就取消；20 秒内没人反对也执行。
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

-- 执行一个已通过的提议
create or replace function public._ldc_apply(st jsonb, p jsonb, online jsonb) returns jsonb
language plpgsql immutable as $$
declare k text := p->>'kind'; d jsonb := st->'dice'; t text;
begin
  if k = 'switch_game' then
    st := st || jsonb_build_object('game', p->'payload'->'game', 'paused', false);
    st := st - 'paused_by';
    if p->'payload'->>'game' = 'dice' then st := jsonb_set(st, '{dice}', public._ldc_dice_init()); end if;
  elsif k = 'resume' then
    st := (st || '{"paused":false}'::jsonb) - 'paused_by';
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

-- 结算：处理到期 / 全员同意的提议，以及游戏的自动推进
create or replace function public._ldc_settle(st jsonb, online jsonb, p_room uuid) returns jsonb
language plpgsql volatile as $$
declare p jsonb := st->'proposal'; d jsonb; all_yes boolean; now_ms bigint := public._ldc_now_ms();
begin
  if p is not null and jsonb_typeof(p) = 'object' then
    select not exists (select 1 from jsonb_array_elements_text(online) o
                       where coalesce((p->'votes'->>o)::boolean, false) = false) into all_yes;
    if all_yes or now_ms >= (p->>'deadline')::bigint then
      st := public._ldc_apply(st - 'proposal', p, online);
      st := st || jsonb_build_object('notice', jsonb_build_object('kind', p->>'kind', 'ok', true, 'by', p->>'by', 'payload', p->'payload', 'at', now_ms));
      insert into public.ldc_events (room_id, kind, payload) values (p_room, 'proposal_passed', p);
    end if;
  end if;

  if coalesce((st->>'paused')::boolean, false) then return st; end if;

  if st->>'game' = 'dice' and st->'dice' is not null then
    d := st->'dice';
    if d->>'phase' = 'ready' and jsonb_array_length(online) >= 2 and public._ldc_subset(online, d->'ready') then
      d := public._ldc_dice_new_round(d, online);
    elsif d->>'phase' = 'rolling' then
      if jsonb_array_length(d->'participants') = 0 then
        d := d || '{"phase":"ready","ready":[]}'::jsonb;
      elsif public._ldc_subset(d->'participants', d->'done') then
        d := public._ldc_dice_reveal(d);
        insert into public.ldc_events (room_id, kind, payload)
          values (p_room, 'dice_reveal', jsonb_build_object('round', d->'round', 'results', d->'results'));
      end if;
    end if;
    st := jsonb_set(st, '{dice}', d);
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
  if st->>'game' = 'dice' and st->'dice' is not null and st->'dice'->>'phase' <> 'reveal' then
    mine := st->'dice'->'results'->(p_me::text);
    st := jsonb_set(st, '{dice,results}', case when mine is null then '{}'::jsonb else jsonb_build_object(p_me::text, mine) end);
  end if;
  return jsonb_build_object(
    'ok', true, 'code', r.code, 'me', p_me::text, 'version', r.version, 'now', public._ldc_now_ms(),
    'players', (select coalesce(jsonb_agg(jsonb_build_object('id', id::text, 'name', nickname, 'seat', seat,
                  'online', last_seen > now() - interval '20 seconds') order by seat), '[]'::jsonb)
                from public.ldc_players where room_id = p_room and left_at is null),
    'state', st);
end $$;

-- ---------- 网页调用的函数 ----------
drop function if exists public.ldc_create_room(text);

-- 创建房间：只有网站管理员（带管理员钥匙）能创建，而且只生成房间号，创建的人不会自动进房间、也没有任何特权
create or replace function public._ldc_is_admin(p_key text) returns boolean
language sql stable as $$
  select coalesce(p_key,'') <> '' and exists (select 1 from public.ldc_settings where key = 'admin_hash' and value = public._ldc_hash(p_key)) $$;

create or replace function public.ldc_create_room(p_admin_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_code text; tries int := 0;
begin
  if not _ldc_is_admin(p_admin_key) then return '{"ok":false,"error":"forbidden"}'; end if;
  loop
    v_code := lpad((floor(random() * 1000000))::int::text, 6, '0');
    exit when not exists (select 1 from ldc_rooms where code = v_code);
    tries := tries + 1;
    if tries > 30 then return '{"ok":false,"error":"busy"}'; end if;
  end loop;
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
declare r ldc_rooms; n text := btrim(coalesce(p_name,'')); v_pid uuid; v_tok text;
begin
  select * into r from ldc_rooms where code = p_code for update;
  if not found then return '{"ok":false,"error":"not_found"}'; end if;
  if coalesce(p_token,'') <> '' then
    update ldc_players set left_at = null, last_seen = now()
      where room_id = r.id and token_hash = _ldc_hash(p_token) returning id into v_pid;
    if v_pid is not null then return _ldc_view(r.id, v_pid) || jsonb_build_object('token', p_token, 'resumed', true); end if;
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
  a jsonb := coalesce(p_args, '{}'::jsonb);
begin
  select * into r from ldc_rooms where code = p_code for update;
  if not found then return '{"ok":false,"error":"not_found"}'; end if;
  update ldc_players set last_seen = now()
    where room_id = r.id and token_hash = _ldc_hash(p_token) and left_at is null returning id into v_pid;
  if v_pid is null then return '{"ok":false,"error":"not_member"}'; end if;
  me := v_pid::text;
  online := _ldc_online(r.id);
  st0 := r.state;
  st := _ldc_settle(r.state, online, r.id);
  d := st->'dice';

  if p_action = 'state' then
    null;

  elsif p_action = 'propose' then
    k := a->>'kind';
    if st->'proposal' is not null and jsonb_typeof(st->'proposal') = 'object' then err := 'busy';
    elsif k = 'switch_game' then
      g := a->'payload'->>'game';
      if g is not null and g not in ('dice') then err := 'not_ready';
      elsif g is not distinct from st->>'game' then err := 'same'; end if;
    elsif k = 'resume' then
      if not coalesce((st->>'paused')::boolean, false) then err := 'not_paused'; end if;
    elsif k = 'skip_player' then
      t := a->'payload'->>'player';
      if st->>'game' <> 'dice' or d->>'phase' <> 'rolling' or not (d->'participants' ? t) or (d->'done' ? t) or t = me then err := 'bad_target'; end if;
    elsif k = 'restart_round' then
      if st->>'game' <> 'dice' then err := 'no_game'; end if;
    else err := 'bad_kind';
    end if;
    if err is null then
      p := jsonb_build_object('id', substr(md5(random()::text), 1, 8), 'kind', k, 'payload', coalesce(a->'payload', '{}'::jsonb),
                              'by', me, 'votes', jsonb_build_object(me, true), 'deadline', now_ms + 20000, 'at', now_ms);
      st := st || jsonb_build_object('proposal', p);
      insert into ldc_events (room_id, player_id, kind, payload) values (r.id, v_pid, 'propose', p);
    end if;

  elsif p_action = 'vote' then
    p := st->'proposal';
    if p is null or jsonb_typeof(p) <> 'object' or p->>'id' <> a->>'id' then err := 'stale';
    elsif coalesce((a->>'yes')::boolean, false) then
      st := jsonb_set(st, '{proposal,votes}', (p->'votes') || jsonb_build_object(me, true));
    else
      st := (st - 'proposal') || jsonb_build_object('notice', jsonb_build_object('kind', p->>'kind', 'ok', false, 'by', me, 'payload', p->'payload', 'at', now_ms));
      insert into ldc_events (room_id, player_id, kind, payload) values (r.id, v_pid, 'proposal_rejected', p);
    end if;

  elsif p_action = 'pause' then
    if st->>'game' is null then err := 'no_game';
    elsif not coalesce((st->>'paused')::boolean, false) then
      st := st || jsonb_build_object('paused', true, 'paused_by', me, 'notice', jsonb_build_object('kind','pause','ok',true,'by',me,'at',now_ms));
    end if;

  elsif p_action in ('ready', 'unready', 'roll', 'next_round') then
    if st->>'game' <> 'dice' or d is null then err := 'no_game';
    elsif coalesce((st->>'paused')::boolean, false) then err := 'paused';
    elsif p_action = 'ready' then
      if d->>'phase' <> 'ready' then err := 'phase'; else d := jsonb_set(d, '{ready}', _ldc_add(d->'ready', me)); end if;
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

  else
    err := 'bad_action';
  end if;

  st := _ldc_settle(st, online, r.id);
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
  if st->>'game' = 'dice' and d is not null then
    d := jsonb_set(d, '{ready}', _ldc_del(d->'ready', v_pid::text));
    if d->>'phase' = 'rolling' and not (d->'done' ? v_pid::text) then
      d := jsonb_set(d, '{participants}', _ldc_del(d->'participants', v_pid::text));
    end if;
    st := _ldc_settle(jsonb_set(st, '{dice}', d), _ldc_online(r.id), r.id);
  end if;
  update ldc_rooms set state = st, version = version + 1, updated_at = now() where id = r.id;
  insert into ldc_events (room_id, player_id, kind) values (r.id, v_pid, 'leave');
  return '{"ok":true}';
end $$;

-- ---------- 权限：网页只能调用 ldc_ 开头的 6 个函数 ----------
revoke all on function public._ldc_hash(text), public._ldc_now_ms(), public._ldc_add(jsonb,text), public._ldc_del(jsonb,text),
  public._ldc_subset(jsonb,jsonb), public._ldc_online(uuid), public._ldc_dice_init(), public._ldc_dice_new_round(jsonb,jsonb),
  public._ldc_dice_reveal(jsonb), public._ldc_apply(jsonb,jsonb,jsonb), public._ldc_settle(jsonb,jsonb,uuid), public._ldc_view(uuid,uuid),
  public._ldc_is_admin(text)
  from public, anon, authenticated;
revoke all on function public.ldc_create_room(text), public.ldc_admin_rooms(text), public.ldc_join(text,text,text), public.ldc_act(text,text,text,jsonb),
  public.ldc_rename(text,text,text), public.ldc_leave(text,text) from public;
grant execute on function public.ldc_create_room(text), public.ldc_admin_rooms(text), public.ldc_join(text,text,text), public.ldc_act(text,text,text,jsonb),
  public.ldc_rename(text,text,text), public.ldc_leave(text,text) to anon, authenticated;

-- 运行成功的话，下面会列出 6 个 ldc_ 函数
select routine_name from information_schema.routines
where routine_schema = 'public' and routine_name like 'ldc\_%' order by 1;
