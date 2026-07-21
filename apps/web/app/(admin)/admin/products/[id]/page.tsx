import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Archive, ArrowLeft, FileChartColumn, FileJson, KeyRound, Languages, Tags } from 'lucide-react';

import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@assessify/ui';
import { getOrganizationService, getProductService } from '@assessify/services';

import { archiveProductAction, reassignProductOrganizationAction, updateProductAction } from '../actions';
import { OrgAssignment } from '../_components/org-assignment';
import { ProductForm } from '../_components/product-form';
import { toFormValues } from '../_lib/form';

import { requireCallerContext } from '@/lib/caller-context';

export const dynamic = 'force-dynamic';

export default async function EditProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const caller = await requireCallerContext();
  const result = await getProductService().get(caller, id);
  if (!result.ok) {
    if (result.error.code === 'product/not_found') notFound();
    throw new Error(result.error.message);
  }
  const product = result.value;

  // This page is super_admin-gated (productService.get above), so the full
  // org list applies — for the owning-org display and the move control.
  const orgsResult = await getOrganizationService().list(caller);
  const organizations = orgsResult.ok ? orgsResult.value : [];
  const owningOrg = organizations.find(
    (organization) => organization.id === product.organizationId
  );

  const updateAction = updateProductAction.bind(null, product.id);
  const archiveAction = archiveProductAction.bind(null, product.id);
  const reassignAction = reassignProductOrganizationAction.bind(null, product.id);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <Link
            href="/admin/products"
            className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
          >
            <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
            Products
          </Link>
          <h1 className="text-xl font-semibold text-ink">{product.name}</h1>
          <p className="font-mono text-xs text-muted">
            {product.slug}.assessify.ie
            {product.status === 'retired' ? ' · retired' : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline">
            <Link href={`/admin/products/${product.id}/questionnaires`}>
              <FileJson size={16} strokeWidth={1.75} aria-hidden="true" />
              Questionnaire versions
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={`/admin/products/${product.id}/report-templates`}>
              <FileChartColumn size={16} strokeWidth={1.75} aria-hidden="true" />
              Report templates
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={`/admin/products/${product.id}/translations`}>
              <Languages size={16} strokeWidth={1.75} aria-hidden="true" />
              Translations
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={`/admin/products/${product.id}/pricing`}>
              <Tags size={16} strokeWidth={1.75} aria-hidden="true" />
              Pricing
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={`/admin/products/${product.id}/access`}>
              <KeyRound size={16} strokeWidth={1.75} aria-hidden="true" />
              Client access
            </Link>
          </Button>
          {product.status === 'active' ? (
            <form action={archiveAction}>
              <Button type="submit" variant="outline">
                <Archive size={16} strokeWidth={1.75} aria-hidden="true" />
                Archive product
              </Button>
            </form>
          ) : null}
        </div>
      </div>

      <Card className="max-w-5xl">
        <CardHeader>
          <CardTitle className="text-base">Organization</CardTitle>
          <CardDescription>
            The product owner company. Moving a product is an explicit platform operation, kept
            out of the ordinary edit form.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-4">
          <p className="text-sm text-body">
            Owned by{' '}
            {owningOrg ? (
              <Link
                href={`/admin/organizations/${owningOrg.id}`}
                className="font-medium text-primary hover:underline"
              >
                {owningOrg.name}
              </Link>
            ) : (
              <span className="font-mono text-xs">{product.organizationId}</span>
            )}
          </p>
          <OrgAssignment
            productName={product.name}
            currentOrgId={product.organizationId}
            organizations={organizations.map((organization) => ({
              id: organization.id,
              name: organization.name,
            }))}
            action={reassignAction}
          />
        </CardContent>
      </Card>

      <ProductForm
        action={updateAction}
        defaults={toFormValues(product)}
        submitLabel="Save changes"
      />
    </div>
  );
}
