import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from './database.types.js';
import { createLogger } from './logger.js';
import type { TradeRecord } from '../latency-sniper/types.js';

const log = createLogger('supabase-client');

// ---------------------------------------------------------------------------
// Singleton — one client per process, initialised on first call.
// ---------------------------------------------------------------------------
let _client: SupabaseClient<Database> | null = null;

/**
 * Returns the shared Supabase client, initialised with the service role key.
 *
 * Requires env vars:
 *   SUPABASE_URL              — project URL (https://<ref>.supabase.co)
 *   SUPABASE_SERVICE_ROLE_KEY — server-side secret (bypasses RLS)
 *   SUPABASE_ANON_KEY         — fallback if service role key is absent
 */
export function getSupabaseClient(): SupabaseClient<Database> {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY;

  if (!url) {
    throw new Error('[Supabase] SUPABASE_URL is not set.');
  }
  if (!key) {
    throw new Error(
      '[Supabase] SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY) is not set.',
    );
  }

  _client = createClient<Database>(url, key, {
    auth: {
      // Bot runs server-side only — disable session persistence.
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return _client;
}

/**
 * Verifies the Supabase connection by running a lightweight query against
 * the trades table. Throws if the connection or credentials are invalid.
 */
export async function verifySupabaseConnection(): Promise<void> {
  const client = getSupabaseClient();

  const { error } = await client
    .from('trades')
    .select('id')
    .limit(1);

  if (error) {
    throw new Error(`[Supabase] Connection verification failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Trade helpers
// ---------------------------------------------------------------------------

/**
 * Inserts a new trade row with status 'pending'.
 * Returns the generated UUID, or null on error (never throws).
 */
export async function recordTrade(trade: TradeRecord): Promise<string | null> {
  try {
    const client = getSupabaseClient();

    const { data, error } = await client
      .from('trades')
      .insert({
        module:           trade.module,
        market_id:        trade.marketId,
        market_slug:      trade.marketSlug,
        side:             trade.side,
        price:            trade.price,
        size:             trade.size,
        amount_usdc:      trade.amountUsdc,
        order_id:         trade.orderId,
        status:           trade.status,
        expected_profit:  trade.expectedProfit,
        metadata:         trade.metadata as Json,
        executed_at:      new Date().toISOString(),
      })
      .select('id')
      .single();

    if (error) {
      log.error('recordTrade: insert failed', { error: error.message, trade });
      return null;
    }

    log.debug('recordTrade: inserted', { id: data.id, orderId: trade.orderId });
    return data.id;

  } catch (err) {
    log.error('recordTrade: unexpected error', { error: String(err) });
    return null;
  }
}

/**
 * Updates the status (and optionally realized_profit) of a trade row
 * identified by its CLOB orderId. Never throws.
 */
export async function updateTradeStatus(
  orderId: string,
  status: 'pending' | 'filled' | 'cancelled' | 'failed',
  realizedProfit?: number,
): Promise<void> {
  try {
    const client = getSupabaseClient();

    const patch: Database['public']['Tables']['trades']['Update'] = { status };
    if (realizedProfit !== undefined) {
      patch.realized_profit = realizedProfit;
    }

    const { error } = await client
      .from('trades')
      .update(patch)
      .eq('order_id', orderId);

    if (error) {
      log.error('updateTradeStatus: update failed', {
        error: error.message, orderId, status,
      });
      return;
    }

    log.debug('updateTradeStatus: updated', { orderId, status, realizedProfit });

  } catch (err) {
    log.error('updateTradeStatus: unexpected error', { error: String(err), orderId });
  }
}

// ---------------------------------------------------------------------------
// Opportunity helpers
// ---------------------------------------------------------------------------

/**
 * Records a detected opportunity regardless of whether we traded on it.
 * Returns generated UUID or null on error.
 */
export async function recordOpportunity(opp: {
  module: string;
  marketId: string;
  marketSlug: string;
  opportunityType: string;
  currentPrice: number;
  expectedPrice: number;
  edge: number;
  confidence: number;
  status: 'detected' | 'traded' | 'expired' | 'missed';
  metadata: Record<string, unknown>;
  expiresAt?: string;
}): Promise<string | null> {
  try {
    const client = getSupabaseClient();

    const { data, error } = await client
      .from('opportunities')
      .insert({
        module:           opp.module,
        market_id:        opp.marketId,
        market_slug:      opp.marketSlug,
        opportunity_type: opp.opportunityType,
        current_price:    opp.currentPrice,
        expected_price:   opp.expectedPrice,
        edge:             opp.edge,
        confidence:       opp.confidence,
        status:           opp.status,
        metadata:         opp.metadata as Json,
        ...(opp.expiresAt ? { expires_at: opp.expiresAt } : {}),
      })
      .select('id')
      .single();

    if (error) {
      log.error('recordOpportunity: insert failed', { error: error.message });
      return null;
    }

    return data.id;

  } catch (err) {
    log.error('recordOpportunity: unexpected error', { error: String(err) });
    return null;
  }
}

/**
 * Marks an opportunity as traded (sets traded_at + status).
 */
export async function markOpportunityTraded(opportunityId: string): Promise<void> {
  try {
    const client = getSupabaseClient();
    const { error } = await client
      .from('opportunities')
      .update({ status: 'traded', traded_at: new Date().toISOString() })
      .eq('id', opportunityId);

    if (error) {
      log.error('markOpportunityTraded: update failed', {
        error: error.message, opportunityId,
      });
    }
  } catch (err) {
    log.error('markOpportunityTraded: unexpected error', { error: String(err) });
  }
}
