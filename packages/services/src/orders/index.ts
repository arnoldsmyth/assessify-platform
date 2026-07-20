export {
  createOrderService,
  type OrderList,
  type OrderService,
  type OrderServiceDeps,
  type OrderWithItems,
} from './order-service';
export { getOrderService } from './default';
// Re-exported for controllers typing `orderService.history` results — apps
// never import repositories directly (.dependency-cruiser.cjs).
export type { AuditLogPage, AuditLogQuery } from '@assessify/repositories';
