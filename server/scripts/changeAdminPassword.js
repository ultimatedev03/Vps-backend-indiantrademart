import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function changePassword() {
  const email = process.env.ADMIN_EMAIL;
  const newPassword = process.env.ADMIN_PASSWORD;

  if (!email || !newPassword) {
    console.error("❌ ADMIN_EMAIL or ADMIN_PASSWORD missing in .env");
    process.exit(1);
  }

  // 1️⃣ Find auth user by email
  const { data, error } = await supabase.auth.admin.listUsers();

  if (error) {
    console.error("❌ Failed to fetch users:", error.message);
    process.exit(1);
  }

  const user = data.users.find(u => u.email === email);

  if (!user) {
    console.error("❌ Admin user not found in auth.users");
    process.exit(1);
  }

  // 2️⃣ Update password in auth.users
  const { error: updErr } = await supabase.auth.admin.updateUserById(
    user.id,
    { password: newPassword }
  );

  if (updErr) {
    console.error("❌ Password update failed:", updErr.message);
    process.exit(1);
  }

  console.log("✅ Admin password updated successfully");
}

changePassword();