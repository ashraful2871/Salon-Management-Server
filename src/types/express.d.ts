import { JwtPayload } from 'jsonwebtoken';
import type { AdminContext } from '../app/modules/Admin/admin.middleware';
import type { AuditCtx } from '../app/utils/audit';

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
      /** Set by adminAuth() / assertAdminPermission() for ADMIN and AGENT callers. */
      admin?: AdminContext;
      /** Who to record on audit rows for this request. Set alongside req.admin. */
      auditCtx?: AuditCtx;
    }
  }
}
