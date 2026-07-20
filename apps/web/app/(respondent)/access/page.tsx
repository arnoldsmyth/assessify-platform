import type { Metadata } from 'next';

import { AccessShell } from './_components/access-shell';
import { TokenForm } from './_components/token-form';
import { enterTokenAction } from './actions';

export const metadata: Metadata = { title: 'Assessment access' };

/**
 * Manual token entry (spec 05, patterns 1/2). Respondents normally arrive on
 * `/a/{token}` straight from the invitation email; this page covers the
 * "typed it in / mangled link" case and simply forwards to that route.
 */
export default function AccessEntryPage() {
  return (
    <AccessShell
      title="Start your assessment"
      description="Use the personal link from your invitation email, or paste it below."
    >
      <TokenForm action={enterTokenAction} />
    </AccessShell>
  );
}
