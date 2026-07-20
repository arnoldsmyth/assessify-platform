import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { Card } from '@assessify/ui';
import {
  getProductService,
  getQuestionnaireVersionService,
  getTranslationService,
  type TranslationCoverage,
} from '@assessify/services';

import { requireCallerContext } from '@/lib/caller-context';

import { importTranslationsAction } from './actions';
import { ImportForm } from './_components/import-form';

// Reads live data on every request — never prerendered at build time.
export const dynamic = 'force-dynamic';

export default async function TranslationsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const caller = await requireCallerContext();

  // Also serves as the product-existence + authz gate for this page.
  const versionsResult = await getQuestionnaireVersionService().listByProduct(caller, id);
  if (!versionsResult.ok) {
    if (versionsResult.error.code === 'questionnaire_version/product_not_found') notFound();
    throw new Error(versionsResult.error.message);
  }
  // Coverage is reported against the active self-variant version (the key set
  // respondents actually see); rater variants get their own coverage in L1.
  const activeVersion = versionsResult.value.find(
    (version) => version.status === 'active' && version.variant === 'self'
  );

  let coverage: TranslationCoverage | null = null;
  if (activeVersion) {
    const coverageResult = await getTranslationService().coverageForVersion(
      caller,
      activeVersion.id
    );
    if (!coverageResult.ok) throw new Error(coverageResult.error.message);
    coverage = coverageResult.value;
  }

  // Product name is decoration here; product management itself is
  // super_admin-only, so fall back to the id for product-scoped admins.
  const productResult = await getProductService().get(caller, id);
  const productName = productResult.ok ? productResult.value.name : id;

  const importAction = importTranslationsAction.bind(null, id);

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
        <h1 className="text-xl font-semibold text-ink">Translations</h1>
        <p className="text-sm text-muted">
          Copy for {productName} per language. Questionnaire definitions reference translation keys
          only; keys missing in a language fall back to the product&rsquo;s default language.
        </p>
      </div>

      {coverage ? (
        <CoverageTable coverage={coverage} />
      ) : (
        <Card className="flex flex-col items-start gap-2 p-6">
          <p className="text-sm font-medium text-ink">No active questionnaire version</p>
          <p className="text-sm text-muted">
            Coverage is computed against the active questionnaire version&rsquo;s key set. You can
            import translations now; coverage appears once a version is{' '}
            <Link href={`/admin/products/${id}/questionnaires`} className="text-primary underline">
              activated
            </Link>
            .
          </p>
        </Card>
      )}

      <ImportForm action={importAction} />
    </div>
  );
}

function CoverageTable({ coverage }: { coverage: TranslationCoverage }) {
  return (
    <Card className="overflow-x-auto p-0">
      <div className="border-b border-border px-4 py-3">
        <p className="text-sm font-medium text-ink">
          Coverage against v{coverage.version} ({coverage.variant})
        </p>
        <p className="text-xs text-muted">
          {coverage.totalKeys} translation key{coverage.totalKeys === 1 ? '' : 's'} in the active
          definition.
        </p>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wide text-muted">
            <th className="px-4 py-3">Language</th>
            <th className="px-4 py-3">Translated</th>
            <th className="px-4 py-3">Missing</th>
            <th className="px-4 py-3">Coverage</th>
          </tr>
        </thead>
        <tbody>
          {coverage.languages.map((language) => {
            const pct =
              coverage.totalKeys === 0
                ? 100
                : Math.round((language.translatedCount / coverage.totalKeys) * 100);
            return (
              <tr
                key={language.language}
                className="border-b border-border transition-colors last:border-0 hover:bg-primary-tint/40"
              >
                <td className="px-4 py-3">
                  <span className="font-mono text-xs text-body">{language.language}</span>
                  {language.isDefault ? (
                    <span className="ml-2 inline-flex items-center rounded-full bg-primary-tint px-2.5 py-0.5 text-xs font-medium text-primary-tint-ink">
                      Default
                    </span>
                  ) : null}
                </td>
                <td className="px-4 py-3 text-body">
                  {language.translatedCount} / {coverage.totalKeys}
                </td>
                <td className="px-4 py-3">
                  {language.missingCount === 0 ? (
                    <span className="inline-flex items-center rounded-full bg-teal-tint px-2.5 py-0.5 text-xs font-medium text-teal">
                      Complete
                    </span>
                  ) : (
                    <span
                      className="inline-flex items-center rounded-full bg-red-tint px-2.5 py-0.5 text-xs font-medium text-red"
                      title={language.missingKeys.slice(0, 20).join(', ')}
                    >
                      {language.missingCount} missing
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-muted">{pct}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}
