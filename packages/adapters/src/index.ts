// Adapter interfaces only. Concrete providers live in src/<adapter>/providers/
// and are wired at each app's composition root — services never import them
// (enforced by .dependency-cruiser.cjs).
export * from './mailer/types';
export * from './pdf/types';
