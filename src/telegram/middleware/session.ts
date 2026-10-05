import { Context, Middleware } from 'telegraf';

// Extend context to include session
export interface SessionData {
  state?: 'AWAITING_EMAIL' | 'AWAITING_CONFIRM';
  pendingBuy?: {
    supplierCode: string;
    productId: string;
    qty: number;
    emails?: string[];
  };
}

export interface MyContext extends Context {
  session: SessionData;
}

// In-memory session store (sufficient for a single admin bot)
// If bot restarts during AWAITING_EMAIL, state is lost, admin just re-runs the command.
const sessions = new Map<number, SessionData>();

export const sessionMiddleware = (): Middleware<MyContext> => {
  return async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return next();

    if (!sessions.has(userId)) {
      sessions.set(userId, {});
    }

    ctx.session = sessions.get(userId)!;

    await next();

    // In a real DB-backed session, we would save ctx.session back here.
  };
};
