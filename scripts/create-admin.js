#!/usr/bin/env node
// Create or reset a Card2Leads admin user.
//
//   node scripts/create-admin.js <email> <password> ["Full Name"]
//
// Reads DATABASE_URL from the environment / .env. Safe to re-run: if the email
// already exists, its password (and name, if given) are updated.

require("dotenv").config();
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const digest = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${digest}`;
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(9).toString("hex")}`;
}

async function main() {
  const [, , emailArg, passwordArg, ...nameParts] = process.argv;
  const email = String(emailArg || process.env.ADMIN_BOOTSTRAP_EMAIL || "").trim().toLowerCase();
  const password = String(passwordArg || process.env.ADMIN_BOOTSTRAP_PASSWORD || "");
  const name = nameParts.join(" ").trim() || process.env.ADMIN_BOOTSTRAP_NAME || "Super Admin";

  if (!email || !password) {
    console.error('Usage: node scripts/create-admin.js <email> <password> ["Full Name"]');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set — cannot reach the database.");
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false
  });

  try {
    // Ensure the schema (incl. admin tables) exists — same idempotent DDL the
    // server runs on boot. Safe to run repeatedly (create table if not exists).
    const schemaPath = path.join(__dirname, "..", "db", "schema.sql");
    await pool.query(fs.readFileSync(schemaPath, "utf8"));

    const now = new Date().toISOString();
    const existing = await pool.query("select id from admin_users where email = $1", [email]);
    if (existing.rowCount) {
      await pool.query(
        "update admin_users set password_hash = $2, name = $3, status = 'active', updated_at = $4 where email = $1",
        [email, hashPassword(password), name, now]
      );
      console.log(`Updated existing admin: ${email}`);
    } else {
      await pool.query(
        `insert into admin_users (id, name, email, password_hash, role, status, created_at, updated_at)
         values ($1,$2,$3,$4,'super_admin','active',$5,$5)`,
        [id("adm"), name, email, hashPassword(password), now]
      );
      console.log(`Created admin: ${email}`);
    }
  } catch (err) {
    console.error("Failed:", err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
