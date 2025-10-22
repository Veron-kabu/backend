import { readFile } from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import dotenv from "dotenv"
import { neon } from "@neondatabase/serverless"

// Load env
dotenv.config({ path: path.resolve(process.cwd(), ".env") })

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

async function main() {
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) {
    console.error("DATABASE_URL is not set in .env")
    process.exit(1)
  }
  const sql = neon(dbUrl)

  const migrationPath = path.resolve(__dirname, "../src/db/migrations/0001_add_geocell.sql")
  const text = await readFile(migrationPath, "utf8")

  const statements = splitSqlStatements(text)
  for (const stmt of statements) {
    const trimmed = stmt.trim()
    if (!trimmed) continue
    // console.log("Executing statement:\n", trimmed.substring(0, 120), "...")
    await sql.query(trimmed)
  }
  console.log("✅ Geocell migration applied successfully.")
}

// Split SQL into statements by semicolons, respecting dollar-quoted blocks ($$) and single quotes
function splitSqlStatements(sqlText) {
  const stmts = []
  let current = ""
  let inSingle = false
  let inDollar = false
  for (let i = 0; i < sqlText.length; i++) {
    const ch = sqlText[i]
    const next2 = sqlText.slice(i, i + 2)

    // Toggle dollar-quoted block: $$
    if (!inSingle && next2 === "$$") {
      inDollar = !inDollar
      current += next2
      i++
      continue
    }
    // Toggle single quote blocks (ignore escaped '')
    if (!inDollar && ch === "'") {
      const prev = sqlText[i - 1]
      if (prev !== "\\") inSingle = !inSingle
      current += ch
      continue
    }
    // Statement terminator
    if (!inSingle && !inDollar && ch === ";") {
      stmts.push(current + ";")
      current = ""
      continue
    }
    current += ch
  }
  if (current.trim()) stmts.push(current)
  return stmts
}

main().catch((err) => {
  console.error("❌ Migration failed:", err)
  process.exit(1)
})
