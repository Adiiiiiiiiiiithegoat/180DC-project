import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { auth } from "@/lib/auth";

export default async function Page() {
  if (await auth.api.getSession({ headers: await headers() })) redirect("/sale");
  return <AuthForm mode="sign-in" />;
}
