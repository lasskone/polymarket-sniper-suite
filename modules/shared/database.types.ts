/**
 * Hand-written TypeScript types matching supabase/schema.sql.
 * Regenerate automatically once schema stabilises:
 *   npx supabase gen types typescript --project-id <ref> > modules/shared/database.types.ts
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
      trades: {
        Row: {
          id: string;
          module: string;
          market_id: string;
          market_slug: string | null;
          side: 'BUY' | 'SELL';
          price: number;
          size: number;
          amount_usdc: number;
          order_id: string | null;
          status: 'pending' | 'filled' | 'cancelled' | 'failed';
          expected_profit: number | null;
          realized_profit: number | null;
          metadata: Json | null;
          created_at: string;
          updated_at: string;
          executed_at: string | null;
        };
        Insert: {
          id?: string;
          module: string;
          market_id: string;
          market_slug?: string | null;
          side: 'BUY' | 'SELL';
          price: number;
          size: number;
          amount_usdc: number;
          order_id?: string | null;
          status?: 'pending' | 'filled' | 'cancelled' | 'failed';
          expected_profit?: number | null;
          realized_profit?: number | null;
          metadata?: Json | null;
          created_at?: string;
          updated_at?: string;
          executed_at?: string | null;
        };
        Update: Partial<Database['public']['Tables']['trades']['Insert']>;
      };

      opportunities: {
        Row: {
          id: string;
          module: string;
          market_id: string;
          market_slug: string | null;
          opportunity_type: string;
          current_price: number;
          expected_price: number;
          edge: number;
          confidence: number | null;
          status: 'detected' | 'traded' | 'expired' | 'missed';
          metadata: Json | null;
          detected_at: string;
          traded_at: string | null;
          expires_at: string | null;
        };
        Insert: {
          id?: string;
          module: string;
          market_id: string;
          market_slug?: string | null;
          opportunity_type: string;
          current_price: number;
          expected_price: number;
          edge: number;
          confidence?: number | null;
          status?: 'detected' | 'traded' | 'expired' | 'missed';
          metadata?: Json | null;
          detected_at?: string;
          traded_at?: string | null;
          expires_at?: string | null;
        };
        Update: Partial<Database['public']['Tables']['opportunities']['Insert']>;
      };

      performance: {
        Row: {
          id: string;
          date: string;
          module: string;
          total_trades: number;
          winning_trades: number;
          losing_trades: number;
          total_profit_usdc: number;
          total_volume_usdc: number;
          avg_profit_per_trade: number;
          win_rate: number;
          max_drawdown_usdc: number;
          sharpe_ratio: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          date: string;
          module: string;
          total_trades?: number;
          winning_trades?: number;
          losing_trades?: number;
          total_profit_usdc?: number;
          total_volume_usdc?: number;
          avg_profit_per_trade?: number;
          win_rate?: number;
          max_drawdown_usdc?: number;
          sharpe_ratio?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['performance']['Insert']>;
      };

      risk_management: {
        Row: {
          id: string;
          date: string;
          daily_pnl_usdc: number;
          daily_trades: number;
          daily_volume_usdc: number;
          current_exposure_usdc: number;
          circuit_breaker_triggered: boolean;
          circuit_breaker_reason: string | null;
          last_trade_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          date: string;
          daily_pnl_usdc?: number;
          daily_trades?: number;
          daily_volume_usdc?: number;
          current_exposure_usdc?: number;
          circuit_breaker_triggered?: boolean;
          circuit_breaker_reason?: string | null;
          last_trade_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['risk_management']['Insert']>;
      };

      market_snapshots: {
        Row: {
          id: string;
          market_id: string;
          market_slug: string | null;
          yes_price: number | null;
          no_price: number | null;
          volume_24h: number | null;
          liquidity: number | null;
          spread: number | null;
          captured_at: string;
        };
        Insert: {
          id?: string;
          market_id: string;
          market_slug?: string | null;
          yes_price?: number | null;
          no_price?: number | null;
          volume_24h?: number | null;
          liquidity?: number | null;
          spread?: number | null;
          captured_at?: string;
        };
        Update: Partial<Database['public']['Tables']['market_snapshots']['Insert']>;
      };
    };
  };
}
