/**
 * Layer-boundary rules from docs/spec/03-architecture.md and
 * docs/spec/appendix-architecture-layers.md. CI fails on any violation.
 */
module.exports = {
  forbidden: [
    {
      name: 'controllers-not-to-repositories',
      comment:
        'Controllers (server actions, API routes, workers) must go through the service layer, never straight to repositories.',
      severity: 'error',
      from: { path: '^apps/' },
      to: { path: '^packages/repositories/' },
    },
    {
      name: 'controllers-not-to-db',
      comment: 'Only repositories touch the drizzle schema / db client.',
      severity: 'error',
      from: { path: '^apps/' },
      to: { path: '^packages/db/' },
    },
    {
      name: 'services-not-to-apps',
      comment: 'The service layer must not know about any caller surface.',
      severity: 'error',
      from: { path: '^packages/services/' },
      to: { path: '^apps/' },
    },
    {
      name: 'services-not-to-adapter-providers',
      comment:
        'Services depend on adapter interfaces only; concrete providers are injected at the composition root.',
      severity: 'error',
      from: { path: '^packages/services/' },
      to: { path: '^packages/adapters/src/[^/]+/providers/' },
    },
    {
      name: 'services-not-to-frameworks',
      comment: 'No framework dependencies (Next.js, React) inside business logic.',
      severity: 'error',
      from: { path: '^packages/services/' },
      to: { path: 'node_modules/(next|react|react-dom)/' },
    },
    {
      name: 'repositories-not-to-services',
      comment: 'Data access must not depend on business logic.',
      severity: 'error',
      from: { path: '^packages/repositories/' },
      to: { path: '^packages/services/' },
    },
    {
      name: 'domain-stays-pure',
      comment:
        'Domain entities/schemas are the innermost layer: no imports from services, repositories, adapters, db, ui, or apps.',
      severity: 'error',
      from: { path: '^packages/domain/' },
      to: {
        path: '^(packages/(services|repositories|adapters|db|ui)|apps)/',
      },
    },
    {
      name: 'packages-not-to-apps',
      comment: 'Shared packages never import application code.',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '\\.(test|spec)\\.[jt]sx?$|\\.next/|dist/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'types'],
      mainFields: ['module', 'main', 'types'],
    },
  },
};
