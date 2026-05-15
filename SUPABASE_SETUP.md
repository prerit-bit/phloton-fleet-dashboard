# Phloton Fleet Dashboard — Supabase Cloud Data Pipeline Setup

This guide walks you through setting up the Supabase-backed data pipeline so your dashboard loads instantly with complete historical data.

## Architecture

```
Anedya IoT Cloud  →  Vercel Cron (every 5 min)  →  Supabase PostgreSQL
                                                          ↓
                                                   Dashboard (reads)
```

- **Vercel Cron** runs `/api/sync` every 5 minutes
- **Sync service** fetches new data from Anedya since last sync, stores in Supabase
- **Dashboard** reads from Supabase (instant) instead of hitting Anedya directly
- **Fallback**: If Supabase isn't configured, the dashboard still works with direct Anedya API calls

---

## Step 1: Create a Supabase Project

1. Go to [supabase.com](https://supabase.com) and sign up / log in
2. Click **New Project**
3. Choose a name (e.g., `phloton-fleet`) and a strong database password
4. Select a region close to your users (e.g., Mumbai for India)
5. Wait for the project to be created (~2 minutes)

## Step 2: Run the Database Schema

1. In your Supabase dashboard, go to **SQL Editor**
2. Open the file `supabase-schema.sql` from this project
3. Paste the entire contents into the SQL Editor
4. Click **Run** — this creates all tables, indexes, and views

## Step 3: Get Your API Keys

1. Go to **Settings → API** in your Supabase dashboard
2. Copy these values:
   - **Project URL** (e.g., `https://abcdefgh.supabase.co`)
   - **Service Role Key** (the `service_role` key — NOT the `anon` key)

## Step 4: Add Environment Variables

Add these to your `.env.local` file:

```env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...your-service-role-key

# For Vercel Cron security (generate any random string)
CRON_SECRET=your-random-secret-string-here
```

## Step 5: Run the Initial Backfill

The first sync will backfill up to 1 year of historical data. This takes a few minutes due to Anedya's 10k-point-per-call limit.

**Option A — Via browser (development):**
```bash
# Start your dev server
npm run dev

# In another terminal, trigger the sync
curl -X POST http://localhost:3000/api/sync
```

**Option B — Via Supabase Edge Function or CLI:**
```bash
# Or just visit in your browser:
# http://localhost:3000/api/sync
```

The response will show progress:
```json
{
  "success": true,
  "unitsProcessed": 29,
  "totalPointsSynced": 145230,
  "errors": [],
  "duration": 180
}
```

## Step 6: Deploy Sync to Vercel

Even though your dashboard runs on a self-hosted VPS, you need a small Vercel deployment just for the cron job:

1. Push to GitHub
2. Import the repo on [vercel.com](https://vercel.com)
3. Add the same environment variables in Vercel → Settings → Environment Variables:
   - `NEXT_PUBLIC_ANEDYA_API_KEY`
   - `NEXT_PUBLIC_NODES_ID`
   - `NEXT_PUBLIC_VARIABLES_IDENTIFIER`
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `CRON_SECRET`
4. Deploy — Vercel will automatically run `/api/sync` every 5 minutes based on `vercel.json`

## Step 7: Deploy Dashboard to Your VPS

On your VPS (e.g., DigitalOcean, AWS EC2):

```bash
# Clone the repo
git clone <your-repo-url>
cd phloton-fleet-dashboard

# Install dependencies
npm install

# Create .env.local with all environment variables
nano .env.local

# Build and start
npm run build
npm start
```

For production, use PM2 to keep it running:
```bash
npm install -g pm2
pm2 start npm --name "phloton-dashboard" -- start
pm2 save
pm2 startup
```

---

## How It Works

### Incremental Sync
After the initial backfill, each sync only fetches data since the last sync point (tracked in the `sync_state` table). A typical incremental sync takes 5-10 seconds.

### Data Deduplication
The `sensor_readings` table has a unique constraint on `(node_id, variable_key, recorded_at)`. If the same data point is fetched twice, it's automatically deduplicated.

### Monitoring
Check the `sync_log` table in Supabase to monitor sync health:
```sql
SELECT * FROM sync_log ORDER BY started_at DESC LIMIT 10;
```

### Hourly Aggregation
The `sensor_readings_hourly` view provides pre-computed hourly averages. The dashboard uses this for lifetime/30-day views, making chart loads near-instant even with millions of data points.

### Graceful Fallback
If Supabase isn't configured (no env vars), the dashboard automatically falls back to direct Anedya API calls — exactly how it worked before. This means you can deploy the code now and add Supabase later.
