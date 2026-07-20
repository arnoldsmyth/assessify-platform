import type { Metadata } from 'next';
import Link from 'next/link';

import { getRespondentAccessService } from '@assessify/services';

import { AccessShell } from '../../access/_components/access-shell';
import { PinForm } from '../../access/_components/pin-form';
import { verifyPinAction } from '../../access/actions';

export const metadata: Metadata = { title: 'Assessment access' };

/**
 * Named-invitation entry URL `/a/{token}` (spec 05, patterns 1/2). The token
 * is the opaque URL secret; unknown/void tokens get one generic "link not
 * valid" state — no detail leakage, and never any PII in the URL or page.
 */
export default async function TokenEntryPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const resolved = await getRespondentAccessService().resolveToken(token);

  if (!resolved.ok || !resolved.value.pinRequired) {
    return (
      <AccessShell title="This link is not valid">
        <p className="text-sm text-body">
          Please use the link from your invitation email. If you keep seeing this message, contact
          the person who invited you to request a new invitation.
        </p>
        <p className="mt-4 text-sm">
          <Link href="/access" className="font-medium text-primary underline-offset-4 hover:underline">
            Enter your link manually
          </Link>
        </p>
      </AccessShell>
    );
  }

  const lockedUntil = resolved.value.lockedUntil;
  return (
    <AccessShell
      title="Enter your PIN"
      description="To keep your assessment private, enter the 6-digit PIN from your invitation email."
    >
      <PinForm
        action={verifyPinAction.bind(null, token)}
        initialLockedUntil={lockedUntil ? lockedUntil.toISOString() : null}
      />
    </AccessShell>
  );
}
