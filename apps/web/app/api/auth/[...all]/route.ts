import { getAuth } from '@/lib/auth';

/**
 * Better Auth handler (sign-in/out, magic-link verification, session).
 * Lazy getAuth() keeps env access out of module scope for `next build`.
 */
export async function GET(request: Request): Promise<Response> {
  return getAuth().handler(request);
}

export async function POST(request: Request): Promise<Response> {
  return getAuth().handler(request);
}
