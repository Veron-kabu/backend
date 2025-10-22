// db/schema.js
import {
  pgTable,
  serial,
  text,
  varchar,
  integer,
  boolean,
  timestamp,
  decimal,
  jsonb,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// =======================
// USERS
// =======================
export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  clerkUserId: varchar("clerk_user_id", { length: 255 }).notNull().unique(),
  username: varchar("username", { length: 100 }).notNull().unique(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  role: varchar("role", { length: 20 }).notNull(), // buyer, farmer, admin
  fullName: varchar("full_name", { length: 255 }),
  phone: varchar("phone", { length: 20 }),
  location: jsonb("location"),
  geoCell: varchar("geo_cell", { length: 32 }),
  profileImageUrl: text("profile_image_url"),
  bannerImageUrl: text("banner_image_url"),
  profileImageBlurhash: text("profile_image_blurhash"),
  bannerImageBlurhash: text("banner_image_blurhash"),
  emailVerified: boolean("email_verified").default(false),
  farmVerified: boolean("farm_verified").default(false),
  isTrusted: boolean("is_trusted").default(false),
  strikesCount: integer("strikes_count").default(0),
  ratingAvg: decimal("rating_avg", { precision: 3, scale: 2 }).default('0'),
  ratingCount: integer("rating_count").default(0),
  status: varchar("status", { length: 20 }).default("active"), // active, inactive, suspended
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// =======================
// PRODUCTS (Farmer Listings)
// =======================
export const productsTable = pgTable("products", {
  id: serial("id").primaryKey(),
  farmerId: integer("farmer_id").references(() => usersTable.id).notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  category: varchar("category", { length: 100 }).notNull(),
  price: decimal("price", { precision: 10, scale: 2 }).notNull(),
  unit: varchar("unit", { length: 50 }).notNull(),
  quantityAvailable: integer("quantity_available").default(0).notNull(),
  minimumOrder: integer("minimum_order").default(1),
  harvestDate: timestamp("harvest_date"),
  expiryDate: timestamp("expiry_date"),
  location: jsonb("location").notNull(),
  geoCell: varchar("geo_cell", { length: 32 }),
  images: jsonb("images").default([]),
  thumbnails: jsonb("thumbnails").default([]),
  imageBlurhashes: jsonb("image_blurhashes").default([]),
  isOrganic: boolean("is_organic").default(false),
  discountPercent: integer("discount_percent").default(0),
  status: varchar("status", { length: 20 }).default("active"), // active, sold, expired, inactive
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// =======================
// ORDERS
// =======================
export const ordersTable = pgTable("orders", {
  id: serial("id").primaryKey(),
  buyerId: integer("buyer_id").references(() => usersTable.id).notNull(),
  farmerId: integer("farmer_id").references(() => usersTable.id).notNull(),
  productId: integer("product_id").references(() => productsTable.id).notNull(),
  quantity: integer("quantity").notNull(),
  unitPrice: decimal("unit_price", { precision: 10, scale: 2 }).notNull(),
  totalAmount: decimal("total_amount", { precision: 10, scale: 2 }).notNull(),
  status: varchar("status", { length: 20 }).default("pending"), // pending, accepted, rejected, shipped, delivered, cancelled
  deliveryAddress: jsonb("delivery_address"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// =======================
// ORDER STATUS HISTORY
// =======================
export const orderStatusHistoryTable = pgTable("order_status_history", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").references(() => ordersTable.id, { onDelete: 'cascade' }).notNull(),
  fromStatus: varchar("from_status", { length: 20 }),
  toStatus: varchar("to_status", { length: 20 }).notNull(),
  changedByUserId: integer("changed_by_user_id").references(() => usersTable.id).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

// =======================
// FAVORITES
// =======================
export const favoritesTable = pgTable("favorites", {
  id: serial("id").primaryKey(),
  buyerId: integer("buyer_id").references(() => usersTable.id).notNull(),
  productId: integer("product_id").references(() => productsTable.id).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

// =======================
// REVIEWS
// =======================
export const reviewsTable = pgTable("reviews", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").references(() => ordersTable.id, { onDelete: 'cascade' }),
  productId: integer("product_id").references(() => productsTable.id),
  reviewerId: integer("reviewer_id").references(() => usersTable.id).notNull(),
  reviewedId: integer("reviewed_id").references(() => usersTable.id).notNull(),
  rating: integer("rating"), // 1 to 5
  comment: text("comment"),
  createdAt: timestamp("created_at").defaultNow(),
});

// =======================
// CLERK SYNC RUNS (Operational Observability)
// =======================
export const clerkSyncRunsTable = pgTable('clerk_sync_runs', {
  id: serial('id').primaryKey(),
  source: varchar('source', { length: 40 }), // startup, periodic, manual
  dryRun: boolean('dry_run').default(false),
  startedAt: timestamp('started_at').defaultNow(),
  finishedAt: timestamp('finished_at'),
  durationMs: integer('duration_ms'),
  processed: integer('processed').default(0),
  inserted: integer('inserted').default(0),
  updated: integer('updated').default(0),
  status: varchar('status', { length: 20 }).default('success'), // success | fail
  errorMessage: text('error_message'),
});

// =======================
// MARKET DATA
// =======================
export const marketDataTable = pgTable("market_data", {
  id: serial("id").primaryKey(),
  category: varchar("category", { length: 100 }).notNull(),
  averagePrice: decimal("average_price", { precision: 10, scale: 2 }),
  demandLevel: varchar("demand_level", { length: 20 }), // low, medium, high
  season: varchar("season", { length: 20 }),
  location: varchar("location", { length: 255 }),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// =======================
// RELATIONS
// =======================
export const usersRelations = relations(usersTable, ({ many }) => ({
  products: many(productsTable),
  ordersAsBuyer: many(ordersTable, { relationName: "buyer" }),
  ordersAsFarmer: many(ordersTable, { relationName: "farmer" }),
  favorites: many(favoritesTable),
  reviewsWritten: many(reviewsTable, { relationName: "reviewer" }),
  reviewsReceived: many(reviewsTable, { relationName: "reviewed" }),
}));

export const productsRelations = relations(productsTable, ({ many, one }) => ({
  farmer: one(usersTable, {
    fields: [productsTable.farmerId],
    references: [usersTable.id],
  }),
  orders: many(ordersTable),
  favorites: many(favoritesTable),
}));

export const ordersRelations = relations(ordersTable, ({ one }) => ({
  buyer: one(usersTable, {
    fields: [ordersTable.buyerId],
    references: [usersTable.id],
  }),
  farmer: one(usersTable, {
    fields: [ordersTable.farmerId],
    references: [usersTable.id],
  }),
  product: one(productsTable, {
    fields: [ordersTable.productId],
    references: [productsTable.id],
  }),
}));

export const orderStatusHistoryRelations = relations(orderStatusHistoryTable, ({ one }) => ({
  order: one(ordersTable, {
    fields: [orderStatusHistoryTable.orderId],
    references: [ordersTable.id],
  }),
  changedBy: one(usersTable, {
    fields: [orderStatusHistoryTable.changedByUserId],
    references: [usersTable.id],
  })
}));

export const favoritesRelations = relations(favoritesTable, ({ one }) => ({
  buyer: one(usersTable, {
    fields: [favoritesTable.buyerId],
    references: [usersTable.id],
  }),
  product: one(productsTable, {
    fields: [favoritesTable.productId],
    references: [productsTable.id],
  }),
}));

export const reviewsRelations = relations(reviewsTable, ({ one }) => ({
  order: one(ordersTable, {
    fields: [reviewsTable.orderId],
    references: [ordersTable.id],
  }),
  product: one(productsTable, {
    fields: [reviewsTable.productId],
    references: [productsTable.id],
  }),
  reviewer: one(usersTable, {
    fields: [reviewsTable.reviewerId],
    references: [usersTable.id],
  }),
  reviewed: one(usersTable, {
    fields: [reviewsTable.reviewedId],
    references: [usersTable.id],
  }),
}));

// =======================
// REVIEW COMMENTS (Replies)
// =======================
export const reviewCommentsTable = pgTable("review_comments", {
  id: serial("id").primaryKey(),
  reviewId: integer("review_id").references(() => reviewsTable.id, { onDelete: 'cascade' }).notNull(),
  authorUserId: integer("author_user_id").references(() => usersTable.id, { onDelete: 'cascade' }).notNull(),
  comment: text("comment").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

// =======================
// MODERATION: REPORTS & APPEALS
// =======================
export const userReportsTable = pgTable("user_reports", {
  id: serial("id").primaryKey(),
  reportedUserId: integer("reported_user_id").references(() => usersTable.id, { onDelete: 'cascade' }).notNull(),
  reporterId: integer("reporter_id").references(() => usersTable.id, { onDelete: 'cascade' }).notNull(),
  reasonCode: varchar("reason_code", { length: 32 }).notNull(),
  description: text("description"),
  evidenceMediaLinks: jsonb("evidence_media_links").default([]),
  status: varchar("status", { length: 20 }).default('pending'), // pending | validated | rejected
  createdAt: timestamp("created_at").defaultNow(),
  validatedByUserId: integer("validated_by_user_id").references(() => usersTable.id),
  validatedAt: timestamp("validated_at"),
  resolutionNote: text("resolution_note"),
});

export const reportAppealsTable = pgTable("report_appeals", {
  id: serial("id").primaryKey(),
  reportId: integer("report_id").references(() => userReportsTable.id, { onDelete: 'cascade' }).notNull(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: 'cascade' }).notNull(),
  reason: text("reason"),
  status: varchar("status", { length: 20 }).default('open'), // open | resolved
  createdAt: timestamp("created_at").defaultNow(),
  resolvedAt: timestamp("resolved_at"),
  resolverUserId: integer("resolver_user_id").references(() => usersTable.id),
  resolutionNote: text("resolution_note"),
});

// =======================
// VERIFICATION
// =======================
export const userVerificationTable = pgTable("user_verification", {
  userId: integer("user_id").references(() => usersTable.id, { onDelete: 'cascade' }).notNull().unique(),
  status: varchar("status", { length: 20 }).notNull().default('unverified'), // unverified | pending | verified | rejected
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const verificationSubmissionsTable = pgTable("verification_submissions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: 'cascade' }).notNull(),
  images: jsonb("images").default([]),
  deviceInfo: jsonb("device_info"),
  status: varchar("status", { length: 20 }).default('pending'), // pending | approved | rejected
  reviewerId: integer("reviewer_id").references(() => usersTable.id),
  reviewerId2: integer("reviewer_id2").references(() => usersTable.id),
  reviewComment: text("review_comment"),
  // autoChecks, twoAdminRequired removed — no automated analysis or 2-admin flow
  retentionExtendedUntil: timestamp("retention_extended_until"),
  adminComments: jsonb("admin_comments").default([]), // [{ text, visibleToUser, reviewerUserId, createdAt }]
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// =======================
// AUDIT LOGS
// =======================
export const auditLogsTable = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  actorUserId: integer("actor_user_id").references(() => usersTable.id),
  action: varchar("action", { length: 64 }).notNull(),
  subjectType: varchar("subject_type", { length: 64 }).notNull(),
  subjectId: varchar("subject_id", { length: 64 }),
  details: jsonb("details"),
  createdAt: timestamp("created_at").defaultNow(),
});

// image_hashes table removed

// =======================
// APP SETTINGS (key-value)
// =======================
export const appSettingsTable = pgTable("app_settings", {
  id: serial("id").primaryKey(),
  key: varchar("key", { length: 128 }).notNull().unique(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// verification_codes table removed

// =======================
// UPLOAD TOKENS (Expected upload keys)
// =======================
export const uploadTokensTable = pgTable("upload_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: 'cascade' }).notNull(),
  uploadKey: text("upload_key").notNull(),
  contentType: varchar("content_type", { length: 128 }),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
})

// =======================
// USER NOTIFICATIONS
// =======================
export const userNotificationsTable = pgTable("user_notifications", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: 'cascade' }).notNull(),
  type: varchar("type", { length: 64 }).notNull(), // e.g., verification_status
  title: varchar("title", { length: 255 }).notNull(),
  body: text("body"),
  data: jsonb("data").default({}),
  readAt: timestamp("read_at"),
  createdAt: timestamp("created_at").defaultNow(),
})

// =======================
// VERIFICATION STATUS HISTORY
// =======================
export const verificationStatusHistoryTable = pgTable("verification_status_history", {
  id: serial("id").primaryKey(),
  submissionId: integer("submission_id").references(() => verificationSubmissionsTable.id, { onDelete: 'cascade' }).notNull(),
  fromStatus: varchar("from_status", { length: 32 }),
  toStatus: varchar("to_status", { length: 32 }).notNull(),
  actorUserId: integer("actor_user_id").references(() => usersTable.id),
  note: text("note"),
  createdAt: timestamp("created_at").defaultNow(),
})

// =======================
// VERIFICATION APPEALS
// =======================
export const verificationAppealsTable = pgTable("verification_appeals", {
  id: serial("id").primaryKey(),
  submissionId: integer("submission_id").references(() => verificationSubmissionsTable.id, { onDelete: 'cascade' }).notNull(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: 'cascade' }).notNull(),
  reason: text("reason"),
  status: varchar("status", { length: 20 }).default('open'), // open | resolved
  priority: integer("priority").default(1),
  createdAt: timestamp("created_at").defaultNow(),
  resolvedAt: timestamp("resolved_at"),
  resolverUserId: integer("resolver_user_id").references(() => usersTable.id),
  resolutionNote: text("resolution_note"),
  retentionExtendedUntil: timestamp("retention_extended_until"),
})
