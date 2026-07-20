export {
  classifyHostname,
  hostnameSchema,
  normalizeHostname,
  tenantHostConfigSchema,
  type HostClassification,
  type TenantHostConfig,
} from './hostname';
export {
  createTenantResolutionService,
  type TenantResolution,
  type TenantResolutionService,
  type TenantResolutionServiceDeps,
} from './tenant-resolution-service';
export { getTenantResolutionService } from './default';
