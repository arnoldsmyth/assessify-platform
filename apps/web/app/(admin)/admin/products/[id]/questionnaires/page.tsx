import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { Card } from '@assessify/ui';
import {
  getProductService,
  getQuestionnaireVersionService,
  type QuestionnaireVersion,
} from '@assessify/services';

import { requireCallerContext } from '@/lib/caller-context';

import {
  activateQuestionnaireVersionAction,
  importQuestionnaireVersionAction,
  retireQuestionnaireVersionAction,
} from './actions';
import { ImportForm } from './_components/import-form';
import { VersionActions } from './_components/version-actions';

// Reads live data on every request — never prerendered at build time.
export const dynamic = 'force-dynamic';

export default async function QuestionnaireVersionsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const caller = await requireCallerContext();

  const versionsResult = await getQuestionnaireVersionService().listByProduct(caller, id);
  if (!versionsResult.ok) {
    if (versionsResult.error.code === 'questionnaire_version/product_not_found') notFound();
    throw new Error(versionsResult.error.message);
  }
  const versions = versionsResult.value;

  // Product name is decoration here; product management itself is
  // super_admin-only, so fall back to the id for product-scoped admins.
  const productResult = await getProductService().get(caller, id);
  const productName = productResult.ok ? productResult.value.name : id;

  const importAction = importQuestionnaireVersionAction.bind(null, id);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link
          href={`/admin/products/${id}`}
          className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
        >
          <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
          {productName}
        </Link>
        <h1 className="text-xl font-semibold text-ink">Questionnaire versions</h1>
        <p className="text-sm text-muted">
          Versioned JSON definitions for {productName}. One version can be active per variant;
          orders pin the version at creation and are never migrated.
        </p>
      </div>

      <VersionTable productId={id} versions={versions} />

      <ImportForm action={importAction} />
    </div>
  );
}

function VersionTable({
  productId,
  versions,
}: {
  productId: string;
  versions: QuestionnaireVersion[];
}) {
  if (versions.length === 0) {
    return (
      <Card className="flex flex-col items-start gap-2 p-6">
        <p className="text-sm font-medium text-ink">No questionnaire versions yet</p>
        <p className="text-sm text-muted">
          Import a JSON definition below to create version 1 as a draft.
        </p>
      </Card>
    );
  }

  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wide text-muted">
            <th className="px-4 py-3">Version</th>
            <th className="px-4 py-3">Variant</th>
            <th className="px-4 py-3">Definition key</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Imported by</th>
            <th className="px-4 py-3">Imported at</th>
            <th className="px-4 py-3 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {versions.map((version) => (
            <tr
              key={version.id}
              className="border-b border-border transition-colors last:border-0 hover:bg-primary-tint/40"
            >
              <td className="px-4 py-3 font-medium text-ink">v{version.version}</td>
              <td className="px-4 py-3 font-mono text-xs text-body">{version.variant}</td>
              <td className="px-4 py-3 font-mono text-xs text-body">{version.definition.key}</td>
              <td className="px-4 py-3">
                <StatusBadge status={version.status} />
              </td>
              <td className="px-4 py-3 font-mono text-xs text-muted" title={version.createdBy ?? undefined}>
                {version.createdBy ? `${version.createdBy.slice(0, 8)}…` : 'system'}
              </td>
              <td className="px-4 py-3 text-muted">
                {version.createdAt.toISOString().slice(0, 16).replace('T', ' ')}
              </td>
              <td className="px-4 py-3">
                <VersionActions
                  status={version.status}
                  version={version.version}
                  variant={version.variant}
                  activateAction={activateQuestionnaireVersionAction.bind(
                    null,
                    productId,
                    version.id
                  )}
                  retireAction={retireQuestionnaireVersionAction.bind(null, productId, version.id)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function StatusBadge({ status }: { status: QuestionnaireVersion['status'] }) {
  if (status === 'active') {
    return (
      <span className="inline-flex items-center rounded-full bg-teal-tint px-2.5 py-0.5 text-xs font-medium text-teal">
        Active
      </span>
    );
  }
  if (status === 'draft') {
    return (
      <span className="inline-flex items-center rounded-full bg-primary-tint px-2.5 py-0.5 text-xs font-medium text-primary-tint-ink">
        Draft
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full border border-border bg-surface px-2.5 py-0.5 text-xs font-medium text-muted">
      Retired
    </span>
  );
}
