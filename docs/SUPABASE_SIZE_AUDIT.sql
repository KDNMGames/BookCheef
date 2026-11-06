-- Read-only BookCheef Supabase size audit.
-- Run in Supabase SQL Editor. These queries do not modify data.

-- 1) Table, TOAST and index size for public schema.
select
    schemaname,
    relname as table_name,
    pg_size_pretty(pg_table_size(relid)) as table_and_toast_size,
    pg_size_pretty(pg_indexes_size(relid)) as indexes_size,
    pg_size_pretty(pg_total_relation_size(relid)) as total_size,
    n_live_tup as estimated_rows
from pg_stat_user_tables
where schemaname = 'public'
order by pg_total_relation_size(relid) desc;

-- 2) Indexes and their sizes (useful for finding large indexes).
select
    schemaname,
    tablename,
    indexname,
    indexdef,
    pg_size_pretty(pg_relation_size(indexrelid)) as index_size
from pg_stat_user_indexes
where schemaname = 'public'
order by pg_relation_size(indexrelid) desc;

-- 3) Supabase Storage objects: approximate bytes from object metadata.
-- Some older objects may not expose a size field in metadata.
select
    bucket_id,
    count(*) as object_count,
    pg_size_pretty(coalesce(sum(nullif(metadata->>'size','')::bigint),0)) as approximate_object_size
from storage.objects
group by bucket_id
order by coalesce(sum(nullif(metadata->>'size','')::bigint),0) desc;

-- 4) Auth user count (no personal data is returned).
select count(*) as auth_user_count
from auth.users;

-- 5) Public row counts (approximate planner statistics, no row contents).
select
    relname as table_name,
    n_live_tup as estimated_rows
from pg_stat_user_tables
where schemaname = 'public'
order by n_live_tup desc;
