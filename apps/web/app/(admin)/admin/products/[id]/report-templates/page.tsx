import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { Card } from '@assessify/ui';
import { getProductService, type ReportTemplateVersionView } from '@assessify/services';

import { getWebReportTemplateService } from '@/lib/reports';
import { requireCallerContext } from '@/lib/caller-context';

import {
  activateReportTemplateAction,
  retireReportTemplateAction,
  uploadReportTemplateAction,
} from './actions';
import { TemplateActions } from './_components/template-actions';
import { UploadForm } from './_components/upload-form';

// Reads live data on every request — never prerendered at build time.
export const dynamic = 'force-dynamic';

/**
 * "Report templates" tab (E3 — spec 09 re-scoped 2026-07-21): uploaded,
 * versioned HTML templates per product, mirroring the questionnaire
 * versions tab. One version can be active; orders pin the version via
 * `report_template_version_id` and are never migrated.
 */
export default async function ReportTemplatesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const caller = await requireCallerContext();

  const templatesResult = await getWebReportTemplateService().listByProduct(caller, id);
  if (!templatesResult.ok) {
    if (templatesResult.error.code === 'report_template/product_not_found') notFound();
    throw new Error(templatesResult.error.message);
  }
  const templates = templatesResult.value;

  // Product name is decoration here; product management itself is
  // super_admin-only, so fall back to the id for product-scoped admins.
  const productResult = await getProductService().get(caller, id);
  const productName = productResult.ok ? productResult.value.name : id;

  const uploadAction = uploadReportTemplateAction.bind(null, id);

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
        <h1 className="text-xl font-semibold text-ink">Report templates</h1>
        <p className="text-sm text-muted">
          Versioned, uploaded HTML report templates for {productName}. One version can be active;
          orders pin the version at creation and are never migrated.
        </p>
      </div>

      <TemplateTable productId={id} templates={templates} />

      <UploadForm action={uploadAction} />
    </div>
  );
}

function TemplateTable({
  productId,
  templates,
}: {
  productId: string;
  templates: ReportTemplateVersionView[];
}) {
  if (templates.length === 0) {
    return (
      <Card className="flex flex-col items-start gap-2 p-6">
        <p className="text-sm font-medium text-ink">No report templates yet</p>
        <p className="text-sm text-muted">
          Upload an HTML template below to create version 1 as a draft. Report assembly fails
          until a version is activated.
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
            <th className="px-4 py-3">Availability</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Uploaded at</th>
            <th className="px-4 py-3 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {templates.map((template) => (
            <tr
              key={template.id}
              className="border-b border-border transition-colors last:border-0 hover:bg-primary-tint/40"
            >
              <td className="px-4 py-3 font-medium text-ink">v{template.version}</td>
              <td className="px-4 py-3 font-mono text-xs text-body">
                {[template.capabilities.web ? 'web' : null, template.capabilities.pdf ? 'pdf' : null]
                  .filter((cap) => cap !== null)
                  .join(' + ')}
              </td>
              <td className="px-4 py-3">
                <StatusBadge status={template.status} />
              </td>
              <td className="px-4 py-3 text-muted">
                {template.createdAt.toISOString().slice(0, 16).replace('T', ' ')}
              </td>
              <td className="px-4 py-3">
                <TemplateActions
                  status={template.status}
                  version={template.version}
                  activateAction={activateReportTemplateAction.bind(null, productId, template.id)}
                  retireAction={retireReportTemplateAction.bind(null, productId, template.id)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function StatusBadge({ status }: { status: ReportTemplateVersionView['status'] }) {
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
