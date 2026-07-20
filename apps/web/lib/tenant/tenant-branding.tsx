import { brandingCssVariables } from './branding-css';
import { getProductTenant } from './context';

/**
 * Server component that injects the resolved product's branding as CSS
 * variables (spec 11 "Branding application"). Rendered by the respondent and
 * public layouts; renders nothing on admin/platform hosts or for products
 * without branding, leaving the Ember defaults from packages/ui in force.
 *
 * The CSS string is built by brandingCssVariables from Zod-validated values
 * passed through a CSS-safety whitelist, so it is safe to inline here.
 */
export async function TenantBrandingStyle() {
  const tenant = await getProductTenant();
  if (!tenant) return null;
  const css = brandingCssVariables(tenant.branding);
  if (!css) return null;
  return <style dangerouslySetInnerHTML={{ __html: css }} />;
}
