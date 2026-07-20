'use server';

import { RESPONDENT_SESSION_COOKIE } from '@assessify/domain';
import { getRespondentAccessService } from '@assessify/services';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { accessStateFromError, extractAccessToken, type AccessFormState } from './_lib/form';

/**
 * Respondent access server actions (spec 05, patterns 1/2). Thin controllers:
 * map FormData → service input, translate errors, set the signed HttpOnly
 * session cookie. No business logic, no PII in redirects or state — the
 * token is the only URL secret and it is opaque.
 */

const GENERIC_LINK_MESSAGE =
  'This link is not valid. Please use the link from your invitation email.';

/** Manual entry page: accept a pasted link or token, then go to /a/{token}. */
export async function enterTokenAction(
  _prev: AccessFormState,
  formData: FormData
): Promise<AccessFormState> {
  const raw = String(formData.get('token') ?? '');
  const token = extractAccessToken(raw);
  if (!token) return { status: 'error', message: GENERIC_LINK_MESSAGE };

  const result = await getRespondentAccessService().resolveToken(token);
  if (!result.ok) return accessStateFromError(result.error);
  redirect(`/a/${token}`);
}

/** PIN form: verify, set the signed session cookie, continue to the questionnaire. */
export async function verifyPinAction(
  token: string,
  _prev: AccessFormState,
  formData: FormData
): Promise<AccessFormState> {
  const pin = String(formData.get('pin') ?? '');
  const result = await getRespondentAccessService().verifyPin(token, pin);
  if (!result.ok) return accessStateFromError(result.error);

  const cookieStore = await cookies();
  cookieStore.set(RESPONDENT_SESSION_COOKIE, result.value.sessionToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: result.value.expiresAt,
  });
  redirect(`/a/${token}/q`);
}
