import { Request, Response, NextFunction } from 'express';

// API key for authentication - in production, use environment variables
const API_KEY = process.env.HIGHFIVE_API_KEY || 'hf_dev_key_2026';

export interface AuthenticatedRequest extends Request {
  apiKeyValid?: boolean;
}

/**
 * Middleware to validate API key
 * Accepts key via:
 * - Header: X-API-Key: <key>
 * - Header: Authorization: Bearer <key>
 * - Query param: ?api_key=<key> (not recommended for production)
 */
export function apiKeyAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const apiKey = 
    req.header('X-API-Key') || 
    req.header('Authorization')?.replace('Bearer ', '') ||
    req.query.api_key as string;

  if (!apiKey) {
    res.status(401).json({ 
      error: 'Unauthorized', 
      message: 'API key is required. Provide it via X-API-Key header or Authorization: Bearer <key>' 
    });
    return;
  }

  if (apiKey !== API_KEY) {
    res.status(403).json({ 
      error: 'Forbidden', 
      message: 'Invalid API key' 
    });
    return;
  }

  req.apiKeyValid = true;
  next();
}

/**
 * Get the current API key (for development/testing display)
 */
export function getApiKey(): string {
  return API_KEY;
}
