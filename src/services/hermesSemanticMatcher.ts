import axios from 'axios';
import { env } from '../config/env';
import { CandidateProduct } from '../suppliers/candidateRetriever';
import { logger } from '../lib/logger';

export interface SemanticMatchResult {
  matched: boolean;
  confidence: number;
  candidate?: CandidateProduct;
  reason: string;
}

const USD_TO_IDR_RATE = 16000;

export function normalizePriceToIdr(price?: number | null, currency?: string): number {
  const p = price ?? 0;
  if (currency?.toUpperCase() === 'USD') {
    return Math.round(p * USD_TO_IDR_RATE);
  }
  return p;
}

/**
 * Tokenizes and stems basic words for local fallback matching.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .map((w) => (w.endsWith('s') && w.length > 3 ? w.slice(0, -1) : w)); // basic singularization
}

/**
 * Local deterministic similarity scorer (Jaccard + Substring).
 */
export function calculateLocalSimilarity(query: string, candidateName: string): number {
  const qTokens = tokenize(query);
  const cTokens = tokenize(candidateName);

  if (qTokens.length === 0 || cTokens.length === 0) return 0;

  let matches = 0;
  for (const q of qTokens) {
    if (cTokens.some((c) => c === q || c.includes(q) || q.includes(c))) {
      matches++;
    }
  }

  const tokenScore = (matches / qTokens.length) * 100;
  return Math.min(100, Math.round(tokenScore));
}

/**
 * Deterministic local matcher used as primary fast-path and resilient fallback.
 */
function fallbackLocalMatch(
  query: string,
  candidates: CandidateProduct[],
  maxBudget?: number | null
): SemanticMatchResult {
  const eligible = candidates.filter((c) => {
    const priceIdr = normalizePriceToIdr(c.product.price, c.product.currency);
    return maxBudget === undefined || maxBudget === null || priceIdr <= maxBudget;
  });

  if (eligible.length === 0) {
    return {
      matched: false,
      confidence: 0,
      reason: 'No candidate products found within the specified maxBudget limit.',
    };
  }

  const scored = eligible.map((c) => ({
    candidate: c,
    score: calculateLocalSimilarity(query, c.product.name),
    priceIdr: normalizePriceToIdr(c.product.price, c.product.currency),
  }));

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.priceIdr - b.priceIdr; // cheapest first on equal score
  });

  const best = scored[0];
  if (best && best.score >= 50) {
    return {
      matched: true,
      confidence: best.score,
      candidate: best.candidate,
      reason: `Semantic match: "${best.candidate.product.name}" (${best.candidate.supplierCode}) matched "${query}" with score ${best.score}% at Rp ${best.priceIdr.toLocaleString('id-ID')}`,
    };
  }

  return {
    matched: false,
    confidence: best ? best.score : 0,
    reason: `Best candidate "${best?.candidate.product.name}" did not meet the minimum similarity threshold.`,
  };
}

/**
 * Evaluates supplier candidates against user request using Hermes LLM (Anthropic)
 * with deterministic fallback.
 */
export async function matchBestOffer(
  query: string,
  candidates: CandidateProduct[],
  maxBudget?: number | null
): Promise<SemanticMatchResult> {
  if (candidates.length === 0) {
    return {
      matched: false,
      confidence: 0,
      reason: 'Candidate pool is empty.',
    };
  }

  // Pre-filter candidates strictly by budget
  const budgetFiltered = candidates.filter((c) => {
    const priceIdr = normalizePriceToIdr(c.product.price, c.product.currency);
    return maxBudget === undefined || maxBudget === null || priceIdr <= maxBudget;
  });

  if (budgetFiltered.length === 0) {
    return {
      matched: false,
      confidence: 0,
      reason: `All available candidates exceed the customer max budget (${maxBudget}).`,
    };
  }

  // If Anthropic API key is available, run LLM semantic reasoning
  if (env.ANTHROPIC_API_KEY) {
    try {
      const candidateList = budgetFiltered.slice(0, 25).map((c, idx) => ({
        index: idx,
        supplierCode: c.supplierCode,
        id: c.product.id,
        name: c.product.name,
        priceIdr: normalizePriceToIdr(c.product.price, c.product.currency),
        description: c.product.description?.slice(0, 80),
      }));

      const systemPrompt = `You are Hermes, the autonomous agentic purchasing AI for VendingLink.
Your job is to match a customer query to the best corresponding supplier product candidate.

Rules:
1. Evaluate semantic intent, aliases, and abbreviations (e.g. "FW" = full warranty, "1M" = 1 month, "Edu" = education, "IndPlan" = individual plan, "Admin" = admin panel).
2. Example: "test products" matches "Test Api product". "duolingo" matches "Duolingo Super 12M". "canva" matches "Canva Pro 2 yrs FW".
3. If multiple candidates match, choose the lowest price candidate.
4. Output strict JSON with format:
{"matched": true, "selectedIndex": <number>, "confidence": <0-100>, "reason": "<brief justification>"}`;

      const userMessage = `Customer Query: "${query}"
Max Budget: ${maxBudget ? `Rp ${maxBudget}` : 'None'}

Candidates within budget:
${JSON.stringify(candidateList, null, 2)}`;

      const response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-3-5-haiku-20241022',
          max_tokens: 300,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        },
        {
          headers: {
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          timeout: 7000,
        }
      );

      const content = response.data?.content?.[0]?.text;
      if (content) {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.matched && typeof parsed.selectedIndex === 'number' && budgetFiltered[parsed.selectedIndex]) {
            const selected = budgetFiltered[parsed.selectedIndex];
            logger.info(
              {
                query,
                matchedProduct: selected.product.name,
                supplier: selected.supplierCode,
                confidence: parsed.confidence,
                reason: parsed.reason,
              },
              'Hermes LLM semantic match successful'
            );
            return {
              matched: true,
              confidence: parsed.confidence ?? 95,
              candidate: selected,
              reason: parsed.reason || `Hermes matched to ${selected.product.name}`,
            };
          }
        }
      }
    } catch (llmErr: any) {
      logger.warn(
        { err: llmErr.message },
        'Hermes LLM call failed or timed out, falling back to local semantic matcher'
      );
    }
  }

  // Fallback to deterministic local semantic matcher
  return fallbackLocalMatch(query, budgetFiltered, maxBudget);
}
