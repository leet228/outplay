import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

let supabase: ReturnType<typeof createClient>

function getSupabase() {
  if (!supabase) supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  return supabase
}

async function logToAdmin(level: string, message: string, details: Record<string, unknown> = {}) {
  try {
    await getSupabase().rpc('admin_log', {
      p_level: level,
      p_source: 'edge:manage-guild-seasons',
      p_message: message,
      p_details: details,
    })
  } catch (e) {
    console.error('Failed to write admin log:', e)
  }
}

serve(async (_req) => {
  try {
    const sb = getSupabase()
    const actions: string[] = []

    // 1. Check if there's an active season
    const { data: activeSeason, error: activeErr } = await sb
      .from('guild_seasons')
      .select('*')
      .eq('is_active', true)
      .limit(1)
      .single()

    if (activeErr && activeErr.code !== 'PGRST116') {
      // PGRST116 = no rows found, anything else is a real error
      console.error('Error fetching active season:', activeErr)
      await logToAdmin('error', 'Failed to fetch active season', { error: activeErr.message })
      return new Response(JSON.stringify({ error: activeErr.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const now = new Date()

    // 2. If active season exists and hasn't ended yet — nothing to do
    if (activeSeason && new Date(activeSeason.end_date) > now) {
      console.log(`Active season still running, ends ${activeSeason.end_date}, prize_pool=${activeSeason.prize_pool}`)
      actions.push(`active_season_ok: ends ${activeSeason.end_date}`)

      return new Response(JSON.stringify({
        status: 'ok',
        actions,
        active_season: {
          id: activeSeason.id,
          end_date: activeSeason.end_date,
          prize_pool: activeSeason.prize_pool,
        },
      }), { headers: { 'Content-Type': 'application/json' } })
    }

    // 3. If active season has ended — close it
    if (activeSeason && new Date(activeSeason.end_date) <= now) {
      const { error: closeErr } = await sb
        .from('guild_seasons')
        .update({ is_active: false })
        .eq('id', activeSeason.id)

      if (closeErr) {
        console.error('Error closing season:', closeErr)
        await logToAdmin('error', 'Failed to close expired season', { season_id: activeSeason.id, error: closeErr.message })
      } else {
        console.log(`✅ Closed expired season ${activeSeason.id}, prize_pool=${activeSeason.prize_pool}`)
        actions.push(`closed_season: ${activeSeason.id}, prize_pool=${activeSeason.prize_pool}`)
        await logToAdmin('info', 'Closed expired guild season', {
          season_id: activeSeason.id,
          prize_pool: activeSeason.prize_pool,
          end_date: activeSeason.end_date,
        })
      }
    }

    // 4. Create new season: 1st of current month → 1st of next month (UTC)
    const startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))

    const { data: newSeason, error: createErr } = await sb
      .from('guild_seasons')
      .insert({
        start_date: startDate.toISOString(),
        end_date: endDate.toISOString(),
        prize_pool: 0,
        is_active: true,
      })
      .select()
      .single()

    if (createErr) {
      console.error('Error creating new season:', createErr)
      await logToAdmin('error', 'Failed to create new season', { error: createErr.message })
      return new Response(JSON.stringify({ error: createErr.message, actions }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    console.log(`✅ Created new season ${newSeason.id}: ${startDate.toISOString()} → ${endDate.toISOString()}`)
    actions.push(`created_season: ${newSeason.id}, ${startDate.toISOString()} → ${endDate.toISOString()}`)
    await logToAdmin('info', 'Created new guild season', {
      season_id: newSeason.id,
      start_date: startDate.toISOString(),
      end_date: endDate.toISOString(),
    })

    return new Response(JSON.stringify({
      status: 'ok',
      actions,
      new_season: {
        id: newSeason.id,
        start_date: startDate.toISOString(),
        end_date: endDate.toISOString(),
        prize_pool: 0,
      },
    }), { headers: { 'Content-Type': 'application/json' } })

  } catch (err) {
    console.error('Worker error:', err)
    await logToAdmin('error', 'Unhandled exception: ' + (err as Error).message, { stack: (err as Error).stack })
    return new Response(JSON.stringify({ error: 'internal_error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
