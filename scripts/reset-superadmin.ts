// scripts/reset-superadmin.ts
//
// Set a new password for a platform super_admin, for the case that actually
// happens: the one-time password printed at first seed is long gone from the
// logs and nobody can sign in to the console that issues licences.
//
// Deliberately NOT an HTTP route. A "reset the super admin" endpoint is a
// permanent way in for anyone who reaches the box; requiring shell access means
// the person resetting it already has the database and the service, so the
// reset grants nothing they did not already hold.
//
//   npx tsx scripts/reset-superadmin.ts <email> [password]
//
// With no password one is generated and printed once.

import "dotenv/config";
import crypto from "crypto";
import { storage } from "../server/storage";
import { hashPassword, validatePasswordStrength } from "../server/auth";

function generate(): string {
  // 24 chars from an unambiguous alphabet — no O/0/l/1 to misread aloud.
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  return Array.from(crypto.randomFillSync(new Uint32Array(24)))
    .map((n) => alphabet[n % alphabet.length])
    .join("");
}

async function main() {
  const [email, supplied] = process.argv.slice(2);
  if (!email) {
    console.error("usage: npx tsx scripts/reset-superadmin.ts <email> [password]");
    process.exit(1);
  }

  const user = await storage.getUserByLogin(email);
  if (!user) {
    console.error(`❌ No account found for "${email}".`);
    process.exit(1);
  }
  if (user.role !== "super_admin") {
    // A client_admin's password is resettable by their own org admin in the UI;
    // sending people to a shell script for that would be worse, not better.
    console.error(
      `❌ "${email}" is a ${user.role}, not a super_admin. ` +
        `Reset a client user from Team Members in the app instead.`
    );
    process.exit(1);
  }

  const password = supplied || generate();
  const weak = validatePasswordStrength(password, user.username);
  if (weak) {
    console.error(`❌ ${weak}`);
    process.exit(1);
  }

  await storage.updateUserPasswordHash(user.id, await hashPassword(password));

  console.log(`\n✅ Password reset for ${user.email} (${user.role})`);
  if (!supplied) {
    console.log(`\n   ${password}\n`);
    console.log("   Save it now — it is not stored anywhere in plaintext.");
  }
  console.log("   Any existing sessions for this account keep working until they expire.\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ reset failed:", err);
  process.exit(1);
});
