import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  ADMIN_NAME
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Supabase keys missing");
  process.exit(1);
}

if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error("❌ ADMIN_EMAIL or ADMIN_PASSWORD missing");
  process.exit(1);
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
);

async function createAdmin() {
  const { data, error } = await supabase.auth.admin.createUser({
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    email_confirm: true,
    user_metadata: {
      role: "ADMIN",
      name: ADMIN_NAME || "System Admin"
    }
  });

  if (error) {
    console.error("❌ Failed:", error.message);
    return;
  }

  console.log("✅ Admin created with auth id:", data.user.id);

  await supabase.from("public.users").upsert({
    id: data.user.id,
    email: ADMIN_EMAIL,
    full_name: ADMIN_NAME || "System Admin",
    role: "admin"
  });

  console.log("✅ Synced admin into public.users");
}

createAdmin();