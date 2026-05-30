-- ============================================================================
-- Phloton — one-shot cleanup of out-of-bounds sensor readings.
-- Run ONCE in the Supabase SQL Editor after deploying the sync-side bounds
-- filter (src/lib/sync.ts + src/lib/sensor-bounds.ts).
--
-- Why: the 5min/hourly aggregation views (sensor_readings_5min,
-- sensor_readings_hourly) compute MIN and MAX across raw rows. A single
-- 50V spike in a 5-minute bucket stretches the chart envelope band to 50V
-- forever, even after the chart-side filter drops the average. Deleting
-- the bad raw rows lets the views recompute clean on the next read.
--
-- Bounds MUST match src/lib/sensor-bounds.ts. Update both together.
-- ============================================================================

-- Step 1 (optional but recommended): preview how many rows will be deleted.
-- Run this SELECT first, eyeball the counts, then run the DELETE below.
SELECT
  variable_name,
  COUNT(*) AS bad_rows,
  MIN(value) AS worst_min,
  MAX(value) AS worst_max
FROM sensor_readings
WHERE
  (LOWER(variable_name) LIKE '%voltage%' AND (value < 7.0 OR value > 13.0))
  OR (LOWER(variable_name) LIKE '%soc%' AND (value < 0 OR value > 100))
  OR (LOWER(variable_name) LIKE '%current%' AND (value < -15 OR value > 15))
  OR (
    (LOWER(variable_name) LIKE '%heat sink%' OR LOWER(variable_name) LIKE '%heatsink%')
    AND (value < -30 OR value > 100)
  )
  OR (
    (LOWER(variable_name) LIKE '%temp%'
     OR LOWER(variable_name) LIKE '%cold%'
     OR LOWER(variable_name) LIKE '%pcb%')
    AND LOWER(variable_name) NOT LIKE '%heat sink%'
    AND LOWER(variable_name) NOT LIKE '%heatsink%'
    AND (value < -30 OR value > 80)
  )
  OR (LOWER(variable_name) LIKE '%duty%' AND (value < 0 OR value > 4095))
  OR (
    LOWER(variable_name) LIKE '%status%'
    AND LOWER(variable_name) NOT LIKE '%fault%'
    AND (value < 0 OR value > 1)
  )
GROUP BY variable_name
ORDER BY bad_rows DESC;

-- Step 2: actually delete. Same WHERE clause as the preview.
-- Wrap in BEGIN / ROLLBACK first if you want a dry run, then re-run with COMMIT.
DELETE FROM sensor_readings
WHERE
  (LOWER(variable_name) LIKE '%voltage%' AND (value < 7.0 OR value > 13.0))
  OR (LOWER(variable_name) LIKE '%soc%' AND (value < 0 OR value > 100))
  OR (LOWER(variable_name) LIKE '%current%' AND (value < -15 OR value > 15))
  OR (
    (LOWER(variable_name) LIKE '%heat sink%' OR LOWER(variable_name) LIKE '%heatsink%')
    AND (value < -30 OR value > 100)
  )
  OR (
    (LOWER(variable_name) LIKE '%temp%'
     OR LOWER(variable_name) LIKE '%cold%'
     OR LOWER(variable_name) LIKE '%pcb%')
    AND LOWER(variable_name) NOT LIKE '%heat sink%'
    AND LOWER(variable_name) NOT LIKE '%heatsink%'
    AND (value < -30 OR value > 80)
  )
  OR (LOWER(variable_name) LIKE '%duty%' AND (value < 0 OR value > 4095))
  OR (
    LOWER(variable_name) LIKE '%status%'
    AND LOWER(variable_name) NOT LIKE '%fault%'
    AND (value < 0 OR value > 1)
  );

-- Step 3: snapshot rows in unit_snapshots will self-correct on the next sync
-- (every 1 min for snapshot-only, every 5 min for full). No manual fix needed.
