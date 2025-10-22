import { clerkClient } from "./auth.js";
import { db } from "../config/db.js";
import { usersTable } from "../db/schema.js";
import { eq } from "drizzle-orm";

const roleMiddleware = (allowedRoles) => {
  return async (req, res, next) => {
    try {
      const userId = req.auth.userId;

      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      // Get user role from Clerk unsafeMetadata; fallback to DB if missing
      const user = await clerkClient.users.getUser(userId);
      let userRole = user.unsafeMetadata?.role;
      if (!userRole) {
        try {
          const rows = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, userId));
          userRole = rows?.[0]?.role;
        } catch {}
      }

      if (!userRole || !allowedRoles.includes(userRole)) {
        return res.status(403).json({ error: "Forbidden: Insufficient permissions" });
      }

      req.userRole = userRole;
      next();
    } catch (error) {
      console.error("Role middleware error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  };
};

export const requireRole = roleMiddleware;
export default roleMiddleware;
