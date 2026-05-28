# MySQL Database

The backend now runs on MySQL. Supabase is only referenced by the optional one-time importer so old hosted data can be copied into MySQL.

## Local Workbench Setup

Use the MySQL server that Workbench is connected to:

```bash
cd backend
npm install
npm run db:setup
npm run dev
```

Default local credentials are:

```env
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=root
MYSQL_DATABASE=indiantrademart
```

`npm run db:setup` creates the database if missing and applies `backend/database/mysql/schema.sql`.

## One-Time Old Data Import

If you still need to copy the old hosted data, keep `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` only for these commands:

```bash
cd backend
MIGRATION_TRUNCATE=1 npm run db:migrate:supabase
STORAGE_REFERENCED_ONLY=1 npm run storage:migrate:supabase
```

`db:migrate:supabase` syncs missing MySQL tables/columns from Supabase REST metadata before copying rows. Use
`db:migrate:postgres` only when a direct Postgres/pooler connection is available.

`storage:migrate:supabase` downloads referenced Supabase Storage files into `MYSQL_STORAGE_DIR` / `uploads`
and rewrites database URLs to `PUBLIC_STORAGE_URL`.

After import and storage rewrite, the app runtime does not need Supabase env vars.

## VPS Env

On VPS, install MySQL, create a database/user, then set:

```env
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=your_mysql_user
MYSQL_PASSWORD=your_mysql_password
MYSQL_DATABASE=indiantrademart
MYSQL_STORAGE_DIR=./uploads
PUBLIC_STORAGE_URL=/uploads
JWT_SECRET=change_this
MYSQL_JWT_SECRET=change_this
```

Run `npm run db:setup` before starting the backend process.
