import { NextResponse } from 'next/server';
import { getHealth } from '@assessify/services';

export function GET() {
  const result = getHealth();
  if (!result.ok) {
    return NextResponse.json({ error: result.error.code }, { status: 500 });
  }
  return NextResponse.json(result.value);
}
