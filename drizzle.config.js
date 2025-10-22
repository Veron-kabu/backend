import 'dotenv/config'

export default {
  schema: "./src/db/schema.js",
  // Use existing migrations directory that already has meta/_journal.json
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    // Read directly from env to avoid importing app env scaffolding
    url: process.env.DATABASE_URL,
  },
  verbose: true,
  //strict: true,
}
